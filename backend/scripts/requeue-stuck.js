#!/usr/bin/env node
/**
 * Requeue evaluations stranded in RUNNING.
 *
 * A worker that dies mid-grade leaves `status = 'RUNNING'` behind. The queue
 * reclaims those after `STALE_CLAIM_MINUTES` (15), which is right for a live
 * system and useless when throughput is being measured now: the stranded rows are
 * the oldest, so they are claimed before the cohort under test and the drain
 * appears to grade nothing. This resets the attempt budget too, because a
 * stranded row did not spend an attempt on a real failure.
 *
 *   node scripts/requeue-stuck.js
 */
import 'dotenv/config';

const { prisma } = await import('../src/db.js');

const stranded = await prisma.evaluation.findMany({
  where: { status: 'RUNNING' },
  select: { id: true },
});

const updated = await prisma.evaluation.updateMany({
  where: { id: { in: stranded.map((row) => row.id) } },
  data: { status: 'QUEUED', stage: 'queued', claimedAt: null, attemptCount: 0, failedReason: null },
});

console.log(`requeued ${updated.count} stranded evaluations`);
await prisma.$disconnect();
