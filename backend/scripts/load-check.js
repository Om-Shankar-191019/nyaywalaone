#!/usr/bin/env node
/**
 * Day 23: the load check.
 *
 *   node scripts/load-check.js --count=60
 *
 * Creates `count` submissions for one assignment, then drains them through the
 * real queue and reports wall time, provider calls, cache hits and the ratio
 * against the predicted call count in docs/cost.md. The numbers go to
 * docs/samples/load-check.json so the report quotes measurements, not an
 * impression.
 *
 * Every submission differs by one trailing comment, so the execution cache
 * cannot turn the check into a database benchmark by accident.
 */
import 'dotenv/config';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const REPO = resolve(BACKEND, '..');
const GOLDEN = join(BACKEND, 'tests', 'golden');

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

const count = Math.max(1, Number(argv.count ?? 60));
const concurrency = Math.max(1, Number(argv.concurrency ?? 4));
const outPath = resolve(REPO, String(argv.out ?? 'docs/samples/load-check.json'));

const { prisma } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { createSubmissionRecord } = await import('../src/services/submission-service.js');
const { drain, queueDepth } = await import('../src/services/queue.js');
const { executionStats, resetExecutionStats } = await import('../src/execution/compile.js');
const { usageToday } = await import('../src/execution/budget.js');
const { resolveRules } = await import('../src/grading/rules.js');

const manifest = JSON.parse(readFileSync(join(GOLDEN, 'manifest.json'), 'utf8'));
const rawRules = JSON.parse(readFileSync(join(GOLDEN, 'rules', 'default.json'), 'utf8'));
const { rules, errors } = resolveRules(rawRules);
if (errors.length) {
  throw new Error(`default rule set is invalid: ${errors.map((error) => `${error.path} ${error.message}`).join('; ')}`);
}

const corpusFiles = readdirSync(join(GOLDEN, 'corpus')).filter((file) => file.endsWith('.c')).sort();

async function ensureSetup() {
  const instructor = await prisma.user.upsert({
    where: { email: 'load.instructor@example.edu' },
    create: {
      email: 'load.instructor@example.edu',
      fullName: 'Load Check Instructor',
      role: 'INSTRUCTOR',
      passwordHash: '$2a$12$loadCheckHarnessNotARealPasswordHashxxxxxxxxxxxxxxxxxxxxxxxxx',
    },
    update: {},
  });

  const course = await prisma.course.upsert({
    where: { joinCode: 'LOAD2026' },
    create: { name: 'Load check (harness)', joinCode: 'LOAD2026', instructorId: instructor.id },
    update: {},
  });

  let assignment = await prisma.assignment.findFirst({ where: { courseId: course.id, title: 'Load check cohort' } });
  if (!assignment) {
    assignment = await prisma.assignment.create({
      data: {
        courseId: course.id,
        title: 'Load check cohort',
        statement: manifest.assignment.statement,
        referenceSolution: manifest.assignment.referenceSolution,
        allowLate: true,
      },
    });
  }

  for (const test of manifest.testCases) {
    await prisma.testCase.upsert({
      where: { assignmentId_name: { assignmentId: assignment.id, name: test.name } },
      create: { assignmentId: assignment.id, ...test },
      update: { stdin: test.stdin, expectedStdout: test.expectedStdout, ordinal: test.ordinal },
    });
  }

  const latest = await prisma.ruleSet.findFirst({
    where: { assignmentId: assignment.id },
    orderBy: { version: 'desc' },
  });

  let ruleset = latest;
  if (!ruleset) {
    ruleset = await prisma.ruleSet.create({
      data: {
        assignmentId: assignment.id,
        version: 1,
        rules: rawRules,
        rulesHash: 'load-check',
        isPublished: true,
        publishedAt: new Date(),
        createdById: instructor.id,
      },
    });
  }

  if (assignment.activeRuleSetId !== ruleset.id) {
    assignment = await prisma.assignment.update({
      where: { id: assignment.id },
      data: { activeRuleSetId: ruleset.id, publishedAt: new Date() },
    });
  }

  return { instructor, course, assignment };
}

async function main() {
  const { course, assignment } = await ensureSetup();
  const usage = await usageToday(config.EXECUTION_PROVIDER);
  const remaining = config.EXEC_DAILY_BUDGET - usage.calls;

  // 8 calls per cold submission is the documented figure; refuse rather than
  // spend the budget and report a wall time for work that never happened.
  const predicted = 8 * count;
  console.log(`Load check: ${count} submissions, concurrency ${concurrency}`);
  console.log(`Provider ${config.EXECUTION_PROVIDER}; budget ${config.EXEC_DAILY_BUDGET}/day, ${usage.calls} used, ${remaining} left; predicted ${predicted} calls`);

  if (predicted > remaining) {
    console.error(`Refusing: this run predicts ${predicted} calls but only ${remaining} remain in today's budget. Raise EXEC_DAILY_BUDGET or use --count=${Math.floor(remaining / 8)}.`);
    return 1;
  }

  const submissions = [];
  const prepStart = Date.now();

  // A crashed worker leaves RUNNING rows that the queue only reclaims after
  // STALE_CLAIM_MINUTES. Those rows are older than anything this run creates, so
  // the drain would measure them instead of this cohort. Clear them first, and
  // deliberately outside the timed window.
  let backlogClaimed = 0;
  let backlogResolved = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const batch = await drain({ limit: 500, concurrency });
    if (batch.claimed === 0) break;
    backlogClaimed += batch.claimed;
    // A requeue is a legitimate outcome (a transient provider error), so it is
    // retried in the next pass rather than treated as a failed clean-up.
    backlogResolved += batch.succeeded + batch.partial + batch.failed;
  }
  if (backlogClaimed > 0) {
    console.log(`Cleared ${backlogClaimed} backlogged evaluations first (${backlogResolved} resolved)`);
  }

  // The queue is drained oldest-first, so any row older than this cohort would be
  // claimed instead of it. Measure nothing rather than measure the wrong thing.
  const before = await queueDepth();
  if (before.queued > 0) {
    console.error(`Refusing: ${before.queued} older evaluations are still queued and would be claimed first.`);
    console.error('Run `node scripts/requeue-stuck.js`, find why they keep returning to QUEUED, then re-run.');
    return 1;
  }
  for (let index = 0; index < count; index += 1) {
    const file = corpusFiles[index % corpusFiles.length];
    const base = readFileSync(join(GOLDEN, 'corpus', file), 'utf8');
    const variant = `\n/* load-check variant ${index + 1} */\n`;
    const email = `load.student.${index + 1}@example.edu`;

    const student = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        fullName: `Load Student ${index + 1}`,
        role: 'STUDENT',
        passwordHash: '$2a$12$loadCheckHarnessNotARealPasswordHashxxxxxxxxxxxxxxxxxxxxxxxxx',
      },
      update: {},
    });

    const enrolled = await prisma.enrollment.findFirst({ where: { courseId: course.id, studentId: student.id } });
    if (!enrolled) await prisma.enrollment.create({ data: { courseId: course.id, studentId: student.id } });

    const { submission } = await createSubmissionRecord({
      assignment,
      student,
      filename: file,
      source: `${base}${variant}`,
    });
    submissions.push(submission.id);
  }
  const prepMs = Date.now() - prepStart;

  resetExecutionStats();
  const startedAt = Date.now();
  const summary = await drain({ limit: count, concurrency });
  const wallMs = Date.now() - startedAt;
  const stats = executionStats();

  // A drain that grades nothing is not a fast drain. This happened for real: a
  // killed harness left 38 RUNNING rows, the queue only reclaims those after
  // STALE_CLAIM_MINUTES, so every claim in this run hit a stale row and the
  // measurement recorded 0 calls, 0 outcomes and a flattering 6 s wall time.
  const graded = summary.succeeded + summary.partial + summary.failed;
  if (graded === 0) {
    console.error('Refusing to record a measurement: the drain graded nothing.');
    console.error('Check for stale RUNNING claims (claimed_at older than the reclaim window) and re-run.');
    return 1;
  }

  const result = {
    generated_at: new Date().toISOString(),
    provider: config.EXECUTION_PROVIDER,
    concurrency,
    submissions: count,
    enqueued_ms: prepMs,
    drain_wall_ms: wallMs,
    per_submission_ms: Math.round(wallMs / count),
    provider_calls: stats.runs,
    cache_hits: stats.cacheHits,
    retries: stats.retries,
    failures: stats.failures,
    cache_hit_rate: stats.runs + stats.cacheHits ? Math.round((stats.cacheHits / (stats.runs + stats.cacheHits)) * 1000) / 10 : 0,
    predicted_calls: predicted,
    call_ratio: predicted ? Math.round((stats.runs / predicted) * 1000) / 1000 : null,
    queue_after: await queueDepth(),
    outcome: { succeeded: summary.succeeded, partial: summary.partial, failed: summary.failed, requeued: summary.requeued },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log(`\nEnqueued ${count} in ${prepMs} ms`);
  console.log(`Drained in ${wallMs} ms (${result.per_submission_ms} ms/submission)`);
  console.log(`Provider calls ${stats.runs}, cache hits ${stats.cacheHits} (${result.cache_hit_rate}%), retries ${stats.retries}, failures ${stats.failures}`);
  console.log(`Outcome: ${summary.succeeded} succeeded, ${summary.partial} partial, ${summary.failed} failed, ${summary.requeued} requeued`);
  console.log(`Calls vs predicted: ${stats.runs}/${predicted} (${result.call_ratio})`);
  console.log(`JSON: ${outPath}`);

  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exitCode = code;
  })
  .catch(async (error) => {
    console.error('Load check failed:', error?.message ?? error);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
  });
