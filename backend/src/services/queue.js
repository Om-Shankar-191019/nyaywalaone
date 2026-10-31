import { prisma } from '../db.js';
import { runEvaluation } from '../grading/coordinator.js';
import { config } from '../config.js';

/**
 * Day 23: the queue.
 *
 * A submission is graded after the HTTP response, which is right for the
 * student and wrong for reliability: if the process dies, the row must be
 * picked up by something else. That something is this drain.
 *
 * Three properties matter, and each one is a separate mechanism:
 *
 *   1. Two drains cannot grade the same row. The claim is a single
 *      `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`, so Postgres
 *      arbitrates, not application code.
 *   2. A crashed worker does not strand a row. A claim stamps `claimed_at`; a
 *      RUNNING row whose claim is older than `STALE_CLAIM_MINUTES` is eligible
 *      again.
 *   3. A row that keeps failing stops being retried. After `MAX_ATTEMPTS` the
 *      evaluation is FAILED with the reason recorded, so the cohort view shows
 *      a real failure instead of a spinner forever.
 */

/** One attempt plus two retries. */
export const MAX_ATTEMPTS = 3;

/** How long a claim is trusted before another worker may take the row. */
export const STALE_CLAIM_MINUTES = 15;

/** Claim at most one row, atomically. Returns its id, or null if the queue is empty. */
export async function claimNextEvaluation() {
  const interval = `${STALE_CLAIM_MINUTES} minutes`;
  const rows = await prisma.$queryRaw`
    UPDATE "evaluations" AS e
    SET status = 'RUNNING'::"EvaluationStatus",
        stage = 'queued',
        claimed_at = now(),
        attempt_count = e.attempt_count + 1
    FROM (
      SELECT id
      FROM "evaluations"
      WHERE status = 'QUEUED'
         OR (status = 'RUNNING' AND claimed_at IS NOT NULL AND claimed_at < now() - ${interval}::interval)
      ORDER BY COALESCE(claimed_at, started_at) ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ) AS candidate
    WHERE e.id = candidate.id
    RETURNING e.id
  `;
  return rows[0]?.id ?? null;
}

const shortReason = (error) => String(error?.code ?? error?.message ?? error ?? 'grading_failed').slice(0, 200);

/**
 * Grade one claimed row. A failure is either final (the attempt budget is
 * spent) or a requeue, and the decision lives here so the HTTP drain, the cron
 * drain and the load check all behave the same way.
 */
export async function processClaimedEvaluation(evaluationId) {
  try {
    const outcome = await runEvaluation(evaluationId);
    return {
      id: evaluationId,
      status: outcome.evaluation.status,
      gradeHundredths: outcome.gradeHundredths ?? null,
      skipped: Boolean(outcome.skipped),
    };
  } catch (error) {
    const row = await prisma.evaluation.findUnique({
      where: { id: evaluationId },
      select: { status: true, attemptCount: true },
    });

    // `runEvaluation` records its own terminal failures (invalid rule set,
    // budget exhausted). Those are decisions, not crashes - do not retry them.
    if (!row || row.status === 'FAILED') {
      return { id: evaluationId, status: 'FAILED', reason: shortReason(error) };
    }

    const attempts = row.attemptCount;
    const final = attempts >= MAX_ATTEMPTS;
    await prisma.evaluation.update({
      where: { id: evaluationId },
      data: {
        status: final ? 'FAILED' : 'QUEUED',
        stage: final ? 'failed' : 'queued',
        failedReason: final ? `retries_exhausted: ${shortReason(error)}` : shortReason(error),
        finishedAt: final ? new Date() : null,
        claimedAt: null,
      },
    });

    return { id: evaluationId, status: final ? 'FAILED' : 'QUEUED', reason: shortReason(error), attempt: attempts };
  }
}

/** Claim and process up to `limit` rows, at most `concurrency` at a time. */
export async function drain({ limit = 1, concurrency = 2 } = {}) {
  const claimed = [];
  for (let index = 0; index < limit; index += 1) {
    const id = await claimNextEvaluation();
    if (!id) break;
    claimed.push(id);
  }

  const results = [];
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, claimed.length))).fill(null).map(async () => {
    while (cursor < claimed.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await processClaimedEvaluation(claimed[index]);
    }
  });
  await Promise.all(workers);

  const count = (status) => results.filter((result) => result.status === status).length;
  return {
    claimed: claimed.length,
    succeeded: count('SUCCEEDED'),
    partial: count('PARTIAL'),
    failed: count('FAILED'),
    requeued: count('QUEUED'),
    processed: results,
  };
}

/** Depth and age of the queue, for the cohort progress view and monitoring. */
export async function queueDepth() {
  const [queued, running, failed, oldest] = await Promise.all([
    prisma.evaluation.count({ where: { status: 'QUEUED' } }),
    prisma.evaluation.count({ where: { status: 'RUNNING' } }),
    prisma.evaluation.count({ where: { status: 'FAILED' } }),
    prisma.evaluation.findFirst({ where: { status: 'QUEUED' }, orderBy: { startedAt: 'asc' }, select: { startedAt: true } }),
  ]);

  return {
    queued,
    running,
    failed,
    oldestQueuedAt: oldest?.startedAt ?? null,
    oldestQueuedSeconds: oldest ? Math.round((Date.now() - oldest.startedAt.getTime()) / 1000) : 0,
    maxAttempts: MAX_ATTEMPTS,
    perRunLimit: config.EXEC_MAX_INFLIGHT,
  };
}
