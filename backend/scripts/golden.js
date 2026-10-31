#!/usr/bin/env node
/**
 * Day 22: the golden corpus.
 *
 * 18 submissions x 3 rule sets x N repeats. For each cell the report hash and
 * the grade must be identical on every repeat; anything else is drift and the
 * script exits non-zero.
 *
 *   node scripts/golden.js                     # 5 repeats, all cells
 *   node scripts/golden.js --repeat=1 --limit=4
 *   node scripts/golden.js --rules=default,strict --csv=../docs/samples/golden-corpus.csv
 *
 * The advisory LLM metric is disabled by default (`--llm` turns it back on).
 * It has weight 0, so it cannot move a grade - but it costs a network call per
 * cell and its prose is not something a determinism suite can pin.
 *
 * This script talks to the configured execution provider for the first repeat
 * of each cell and reads the execution cache after that. Quota is therefore
 * spent once per distinct program/input, not once per repeat. Budget:
 *   EXEC_DAILY_BUDGET must be high enough for the first pass (about 250 calls
 *   for the full grid), and the provider must be reachable.
 */
import 'dotenv/config';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

const repeats = Math.max(1, Number(argv.repeat ?? 5));
const limit = Number(argv.limit ?? 0);
const cellsInFlight = Math.max(1, Number(argv.cells ?? 2));
const llmEnabled = Boolean(argv.llm);
const csvPath = resolve(REPO, String(argv.csv ?? 'docs/samples/golden-corpus.csv'));
const ruleSelection = String(argv.rules ?? 'default,strict,complexity')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

// Must happen before `config.js` is imported: the analyzer reads the key once.
if (!llmEnabled) process.env.GROQ_API_KEY = '';
// The grid is provider-bound, not CPU-bound: analyzers run with the normal
// grading concurrency and the provider limiter (2 in flight on onlinecompiler)
// decides the real width.
process.env.GRADING_CONCURRENCY ??= '3';

const { prisma } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { prepareEvaluationKey, runEvaluation, reportForEvaluation } = await import('../src/grading/coordinator.js');
const { sourceHash } = await import('../src/lib/hash.js');
const { resolveRules } = await import('../src/grading/rules.js');
const { rulesHash } = await import('../src/grading/canonical.js');
const { submissionScopedKey } = await import('../src/services/submission-service.js');
const { executionStats, resetExecutionStats } = await import('../src/execution/compile.js');
const { GRADER_VERSION } = await import('../src/grading/versions.js');

const manifest = JSON.parse(readFileSync(join(GOLDEN, 'manifest.json'), 'utf8'));
const corpus = readdirSync(join(GOLDEN, 'corpus'))
  .filter((file) => file.endsWith('.c'))
  .sort();

const offset = Math.max(0, Number(argv.offset ?? 0));
const files = limit > 0 ? corpus.slice(offset, offset + limit) : corpus.slice(offset);

const sources = files.map((file) => ({
  file,
  source: readFileSync(join(GOLDEN, 'corpus', file), 'utf8'),
}));

/**
 * `--list` describes the grid without touching the database or the provider, so
 * CI can assert the fixtures are complete on a machine with no key.
 */
if (argv.list) {
  const ruleFiles = readdirSync(join(GOLDEN, 'rules'))
    .filter((file) => file.endsWith('.json'))
    .sort();
  const selected = ruleFiles.filter((file) => ruleSelection.includes(basename(file, '.json')));
  console.log(`corpus:    ${corpus.length} submissions in tests/golden/corpus`);
  console.log(`rule sets: ${ruleFiles.join(', ')}`);
  console.log(`grid:      ${corpus.length} x ${selected.length} = ${corpus.length * selected.length} cells, ${repeats} repeats each`);
  console.log(`runs:      ${corpus.length * selected.length * repeats}`);
  for (const file of corpus) console.log(`  - ${file}`);
  process.exit(0);
}

async function upsertUser(email, fullName, role) {
  return prisma.user.upsert({
    where: { email },
    create: { email, fullName, role, passwordHash: '$2a$12$goldenCorpusHarnessNotARealPasswordHashxxxxxxxxxxxxxxxxxxxx' },
    update: {},
  });
}

async function ensureCourse(instructor) {
  const joinCode = 'GOLD2026';
  return prisma.course.upsert({
    where: { joinCode },
    create: { name: 'Golden corpus (harness)', joinCode, instructorId: instructor.id },
    update: {},
  });
}

async function ensureEnrollment(course, student) {
  const existing = await prisma.enrollment.findFirst({ where: { courseId: course.id, studentId: student.id } });
  if (existing) return existing;
  return prisma.enrollment.create({ data: { courseId: course.id, studentId: student.id } });
}

async function ensureAssignment(course, instructor, rulesetName, rawRules) {
  const title = `${manifest.assignment.title} [${rulesetName}]`;
  let assignment = await prisma.assignment.findFirst({ where: { courseId: course.id, title } });
  if (!assignment) {
    assignment = await prisma.assignment.create({
      data: {
        courseId: course.id,
        title,
        statement: manifest.assignment.statement,
        referenceSolution: manifest.assignment.referenceSolution,
        allowLate: Boolean(manifest.assignment.allowLate),
        allowNoOracle: Boolean(manifest.assignment.allowNoOracle),
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

  // A new version per run keeps the frozen rule set honest: an old report still
  // points at the rules it was graded with.
  const latest = await prisma.ruleSet.findFirst({
    where: { assignmentId: assignment.id },
    orderBy: { version: 'desc' },
    select: { version: true, rulesHash: true },
  });
  const hash = rulesHash(rawRules);

  let ruleset;
  if (latest && latest.rulesHash === hash) {
    ruleset = await prisma.ruleSet.findFirst({ where: { assignmentId: assignment.id, version: latest.version } });
  } else {
    const version = (latest?.version ?? 0) + 1;
    ruleset = await prisma.ruleSet.create({
      data: {
        assignmentId: assignment.id,
        version,
        rules: rawRules,
        rulesHash: hash,
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

  return { assignment, ruleset };
}

/** Bounded concurrency that preserves input order in the result array. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function nextAttempt(assignmentId, studentId) {
  const last = await prisma.submission.findFirst({
    where: { assignmentId, studentId },
    orderBy: { attempt: 'desc' },
    select: { attempt: true },
  });
  return (last?.attempt ?? 0) + 1;
}

/** One submission, one evaluation, one report. */
async function runCell({ assignment, ruleset, rules, tests, student, file, source }) {
  // Cells run concurrently for the same student, so two can pick the same next
  // attempt number. The unique index is the arbiter; retry with the new max.
  let submission = null;
  for (let tries = 0; tries < 5 && !submission; tries += 1) {
    try {
      submission = await prisma.submission.create({
        data: {
          assignmentId: assignment.id,
          studentId: student.id,
          attempt: await nextAttempt(assignment.id, student.id),
          source,
          sourceHash: sourceHash(source),
          filename: file,
          sizeBytes: Buffer.byteLength(source, 'utf8'),
        },
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
  }
  if (!submission) throw new Error(`Could not allocate an attempt for ${file}`);

  const prep = await prepareEvaluationKey({
    assignment,
    sourceHash: submission.sourceHash,
    rules,
    tests,
    provider: config.EXECUTION_PROVIDER,
  });

  const evaluation = await prisma.evaluation.create({
    data: {
      submissionId: submission.id,
      rulesetId: ruleset.id,
      // Salted per submission: identical content is already cached at the
      // execution layer, but each row still owns its own report.
      evaluationKey: submissionScopedKey(prep.key, submission.id),
      status: 'QUEUED',
      stage: 'queued',
      provider: prep.provider,
      toolchainFingerprint: prep.toolchain_hash,
      graderVersion: GRADER_VERSION,
    },
  });

  try {
    await runEvaluation(evaluation.id);
  } catch (error) {
    return {
      status: 'FAILED',
      grade: null,
      hash: null,
      error: String(error?.code ?? error?.message ?? error).slice(0, 160),
      evaluationId: evaluation.id,
    };
  }

  const report = await reportForEvaluation(evaluation.id);
  return {
    status: report.json.evaluation.status,
    grade: report.json.grade.hundredths,
    hash: report.hash,
    verified: report.verified,
    evaluationId: evaluation.id,
  };
}

/**
 * A rate limit is not a determinism result. When a cell fails for a provider
 * reason, wait and try once more; a cell that fails twice is reported as a
 * failure and makes the run fail, which is the honest outcome.
 */
async function runCellWithRetry(args) {
  let result = await runCell(args);
  if (result.status === 'FAILED' && /PROVIDER_RATE_LIMITED|PROVIDER_UNAVAILABLE|PROVIDER_ERROR/.test(String(result.error ?? ''))) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    result = await runCell(args);
  }
  return result;
}

async function main() {
  const provider = config.EXECUTION_PROVIDER;
  console.log(`Golden corpus: ${files.length} submissions x ${ruleSelection.length} rule sets x ${repeats} repeats`);
  console.log(`Provider ${provider}, grader ${GRADER_VERSION}, LLM ${llmEnabled ? 'enabled' : 'disabled (advisory, weight 0)'}`);

  const instructor = await upsertUser('golden.instructor@example.edu', 'Golden Harness Instructor', 'INSTRUCTOR');
  const student = await upsertUser('golden.student@example.edu', 'Golden Harness Student', 'STUDENT');
  const course = await ensureCourse(instructor);
  await ensureEnrollment(course, student);

  const rows = [];
  const cells = [];
  resetExecutionStats();

  for (const name of ruleSelection) {
    const rawRules = JSON.parse(readFileSync(join(GOLDEN, 'rules', `${name}.json`), 'utf8'));
    const { rules, errors } = resolveRules(rawRules);
    if (errors.length) {
      throw new Error(`Rule set ${name} is invalid: ${errors.map((error) => `${error.path} ${error.message}`).join('; ')}`);
    }

    const { assignment, ruleset } = await ensureAssignment(course, instructor, name, rawRules);
    const tests = await prisma.testCase.findMany({
      where: { assignmentId: assignment.id },
      orderBy: [{ ordinal: 'asc' }, { name: 'asc' }],
    });

    const baseline = new Map();

    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      // Cells are independent; the provider limiter (2 in flight on
      // onlinecompiler) decides the real width, so a small pool here is honest
      // parallelism rather than a way around a rate limit.
      const outcomes = await mapLimit(sources, cellsInFlight, async ({ file, source }) => ({
        file,
        result: await runCellWithRetry({ assignment, ruleset, rules, tests, student, file, source }),
      }));

      for (const { file, result } of outcomes) {
        const key = `${name}:${file}`;
        const first = baseline.get(key);

        if (!first) baseline.set(key, result);
        const matches = first ? first.grade === result.grade && first.hash === result.hash && first.status === result.status : true;

        rows.push({
          cell: key,
          rule_set: name,
          file,
          repeat,
          status: result.status,
          grade_hundredths: result.grade ?? '',
          report_hash: result.hash ?? '',
          matches_baseline: matches,
          error: result.error ?? '',
        });

        if (!matches) {
          console.log(`  DRIFT ${key} repeat ${repeat}: ${first.grade}/${String(first.hash).slice(0, 12)} -> ${result.grade}/${String(result.hash).slice(0, 12)}`);
        }
      }
      process.stdout.write(`  ${name.padEnd(10)} repeat ${repeat}/${repeats} complete (${outcomes.length} cells)\n`);
    }

    cells.push({ name, baseline, rulesetVersion: ruleset.version });
    process.stdout.write('\n');
  }

  const header = ['cell', 'rule_set', 'file', 'repeat', 'status', 'grade_hundredths', 'report_hash', 'matches_baseline', 'error'];
  const csv = [header.join(','), ...rows.map((row) => header.map((column) => {
    const value = row[column];
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(','))].join('\n');

  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, `${csv}\n`);

  const drifted = rows.filter((row) => row.matches_baseline === false);
  const stats = executionStats();

  console.log('\nGrade per cell (first repeat):');
  for (const cell of cells) {
    console.log(`  ${cell.name} (rule set v${cell.rulesetVersion})`);
    for (const [key, result] of cell.baseline) {
      console.log(`    ${key.split(':')[1].padEnd(26)} ${String(result.grade ?? '-').padStart(5)}  ${String(result.status).padEnd(10)} ${String(result.hash ?? '').slice(0, 12)}`);
    }
  }

  console.log(`\nCells: ${cells.reduce((sum, cell) => sum + cell.baseline.size, 0)}  runs: ${rows.length}`);
  console.log(`Provider calls: ${stats.runs}  cache hits: ${stats.cacheHits}  retries: ${stats.retries}  failures: ${stats.failures}`);
  console.log(`CSV: ${csvPath}`);

  if (drifted.length) {
    console.error(`\nFAIL: ${drifted.length} run(s) did not match their baseline.`);
    return 1;
  }
  console.log('\nPASS: every repeat produced an identical report hash and grade.');
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exitCode = code;
  })
  .catch(async (error) => {
    console.error('\nGolden run failed:', error?.message ?? error);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
  });
