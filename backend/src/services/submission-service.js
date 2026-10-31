import { config } from '../config.js';
import { prisma } from '../db.js';
import { looksBinary } from '../lib/guards.js';
import { AppError, badRequest, conflict, notFound } from '../lib/http.js';
import { normalizeSource, sha256Hex, sourceHash } from '../lib/hash.js';
import { prepareEvaluationKey, runEvaluation } from '../grading/coordinator.js';
import { resolveRules } from '../grading/rules.js';

const MAX_FILENAME = 120;

/** Stages the UI polls. A grade is not predictable, so progress is named. */
export const STAGES = Object.freeze(['queued', 'compiling', 'testing', 'analyzing', 'done', 'failed']);

export const canSeeReport = (assignment, submission, user) => {
  if (user.role === 'INSTRUCTOR') return true;
  if (submission.studentId !== user.id) return false;
  if (submission.releasedAt) return true;
  return Boolean(assignment.gradeReleaseAt && assignment.gradeReleaseAt <= new Date());
};

export function serialiseSubmission(submission, evaluation, { includeGrade }) {
  return {
    id: submission.id,
    assignmentId: submission.assignmentId,
    attempt: submission.attempt,
    filename: submission.filename,
    sizeBytes: submission.sizeBytes,
    sourceHash: submission.sourceHash,
    submittedAt: submission.createdAt,
    releasedAt: submission.releasedAt,
    gradeReleased: includeGrade,
    evaluation: evaluation
      ? {
          id: evaluation.id,
          status: evaluation.status,
          // Day 15: what the polling UI shows while a grade is being produced.
          stage: evaluation.stage ?? (evaluation.status === 'SUCCEEDED' ? 'done' : 'queued'),
          gradeHundredths: includeGrade ? evaluation.gradeHundredths : null,
          reportHash: includeGrade ? evaluation.reportHash : null,
          failedReason: includeGrade ? evaluation.failedReason : null,
          startedAt: evaluation.startedAt,
          finishedAt: evaluation.finishedAt,
        }
      : null,
  };
}

export async function latestEvaluation(submissionId) {
  return prisma.evaluation.findFirst({
    where: { submissionId },
    orderBy: { startedAt: 'desc' },
    include: { metrics: { orderBy: { ordinal: 'asc' } } },
  });
}

/**
 * Duplicate work is impossible to avoid entirely - two students can submit the
 * same correct solution, and a student can re-upload the same file. The
 * evaluation key is content-addressed, so the second identical submission would
 * otherwise attach to the *first* student's evaluation row, and its own report
 * lookup would return nothing.
 *
 * The fix is a per-submission salt: identical content still hits the execution
 * cache (so no extra provider spend) but each submission owns a report, and the
 * new row points at the original through `lineageOfId`.
 */
export function submissionScopedKey(baseKey, submissionId) {
  return sha256Hex(`${baseKey}:${submissionId}`);
}

/**
 * Validate and persist one attempt. Nothing here talks to the sandbox, so the
 * request finishes in milliseconds and the UI gets an id to poll immediately.
 */
export async function createSubmissionRecord({ assignment, student, filename, source }) {
  if (!assignment.activeRuleSetId) {
    throw conflict('ASSIGNMENT_NOT_PUBLISHED', 'This assignment has no published rule set yet, so it cannot be graded.');
  }

  const trimmedSource = String(source ?? '');
  if (!trimmedSource.trim()) throw badRequest('The source file is empty');
  // Day 21 input hardening: a NUL byte means the upload was not text, whatever
  // the extension said. Rejecting here keeps binary out of the cache and the DB.
  if (trimmedSource.includes('\u0000')) throw badRequest('The file contains a null byte, so it is not a text source file.');
  if (looksBinary(trimmedSource)) {
    throw badRequest('The file is not text: it contains too many control characters to be C source.');
  }
  if (Buffer.byteLength(trimmedSource, 'utf8') > config.maxSourceBytes) {
    throw badRequest(`Source exceeds the ${Math.round(config.maxSourceBytes / 1024)} KB limit`);
  }

  const safeName = String(filename ?? 'main.c').trim().slice(0, MAX_FILENAME) || 'main.c';
  if (!/\.c$/i.test(safeName)) throw badRequest('Upload a C source file ending in .c');

  const now = new Date();
  if (assignment.dueAt && assignment.dueAt < now && !assignment.allowLate) {
    throw conflict('LATE_NOT_ALLOWED', `This assignment closed on ${assignment.dueAt.toISOString()}. Late submissions are not accepted.`);
  }

  // Day 23: a per-student daily ceiling, independent of the global provider
  // budget. The burst limiter above is per hour and per process; this one
  // survives a restart and stops one account from consuming a whole day's quota.
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const todayCount = await prisma.submission.count({
    where: { studentId: student.id, createdAt: { gte: dayStart } },
  });
  if (todayCount >= config.EXEC_USER_DAILY_SUBMISSIONS) {
    throw conflict(
      'DAILY_SUBMISSION_LIMIT',
      `You have submitted ${todayCount} times today. The daily limit is ${config.EXEC_USER_DAILY_SUBMISSIONS}; it resets at 00:00 UTC.`,
    );
  }

  const ruleset = await prisma.ruleSet.findUnique({ where: { id: assignment.activeRuleSetId } });
  if (!ruleset) throw conflict('ASSIGNMENT_NOT_PUBLISHED', 'The active rule set is missing; re-publish the assignment.');
  const { rules, errors } = resolveRules(ruleset.rules);
  if (errors.length) {
    throw conflict('RULE_SET_INVALID', `The published rule set cannot be evaluated: ${errors[0].path} ${errors[0].message}`);
  }

  const normalized = normalizeSource(trimmedSource);
  const hash = sourceHash(trimmedSource);

  const last = await prisma.submission.findFirst({
    where: { assignmentId: assignment.id, studentId: student.id },
    orderBy: { attempt: 'desc' },
    select: { attempt: true },
  });

  let submission;
  for (let attempt = (last?.attempt ?? 0) + 1, tries = 0; tries < 3; attempt += 1, tries += 1) {
    try {
      submission = await prisma.submission.create({
        data: {
          assignmentId: assignment.id,
          studentId: student.id,
          attempt,
          source: normalized,
          sourceHash: hash,
          filename: safeName,
          sizeBytes: Buffer.byteLength(normalized, 'utf8'),
        },
      });
      break;
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
  }
  if (!submission) throw conflict('ATTEMPT_CONFLICT', 'Could not allocate an attempt number; please retry');

  const tests = await prisma.testCase.findMany({
    where: { assignmentId: assignment.id },
    orderBy: [{ ordinal: 'asc' }, { name: 'asc' }],
  });

  const prep = await prepareEvaluationKey({
    assignment,
    sourceHash: submission.sourceHash,
    rules,
    tests,
    provider: config.EXECUTION_PROVIDER,
  });

  const collision = await prisma.evaluation.findUnique({
    where: { evaluationKey: prep.key },
    select: { id: true, submissionId: true },
  });

  const evaluation = await prisma.evaluation.create({
    data: {
      submissionId: submission.id,
      rulesetId: ruleset.id,
      evaluationKey: collision && collision.submissionId !== submission.id ? submissionScopedKey(prep.key, submission.id) : prep.key,
      status: 'QUEUED',
      stage: 'queued',
      provider: prep.provider,
      toolchainFingerprint: prep.toolchain_hash,
      graderVersion: '2.0.0',
      lineageOfId: collision && collision.submissionId !== submission.id ? collision.id : null,
    },
  });

  return { submission, evaluation, rules, ruleset, tests };
}

/**
 * Grading runs after the response, because a submission must not hold a request
 * open for a compiler and ten analyzers. If the process dies mid-flight the row
 * stays `QUEUED` and `/api/internal/drain` picks it up, so the work is never
 * lost - only delayed.
 */
const inFlight = new Map();

export function scheduleGrading(evaluationId) {
  if (inFlight.has(evaluationId)) return inFlight.get(evaluationId);

  const task = Promise.resolve()
    .then(() => runEvaluation(evaluationId))
    .catch(async (error) => {
      // `runEvaluation` records known failures itself; this catches the rest so a
      // crashed grade never leaves a row stuck on RUNNING for the UI to poll.
      const reason = String(error?.code ?? 'grading_failed').slice(0, 120);
      await prisma.evaluation
        .updateMany({
          where: { id: evaluationId, status: { in: ['QUEUED', 'RUNNING'] } },
          data: { status: 'FAILED', stage: 'failed', failedReason: reason, finishedAt: new Date() },
        })
        .catch(() => {});
      return null;
    })
    .finally(() => inFlight.delete(evaluationId));

  inFlight.set(evaluationId, task);
  return task;
}

/** Wait for the in-process task, if there is one. Used by scripts and tests. */
export const gradingDone = (evaluationId) => inFlight.get(evaluationId) ?? Promise.resolve(null);

/**
 * Upload, persist and grade in one call. The HTTP route uses the split version
 * (respond, then schedule); this stays for scripts and for the regression tests
 * that want a finished report in a single await.
 */
export async function submitAndGrade({ assignment, student, filename, source }) {
  const created = await createSubmissionRecord({ assignment, student, filename, source });
  await scheduleGrading(created.evaluation.id);
  const fresh = await prisma.evaluation.findUnique({
    where: { id: created.evaluation.id },
    include: { metrics: { orderBy: { ordinal: 'asc' } } },
  });
  return { submission: created.submission, evaluation: fresh, rules: created.rules };
}

export async function loadSubmissionForViewer(submissionId, user) {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      student: { select: { id: true, fullName: true, email: true } },
      assignment: {
        include: { course: { select: { id: true, name: true, instructorId: true } } },
      },
    },
  });

  if (!submission) throw notFound('Submission not found');

  const isOwner = submission.studentId === user.id;
  const isInstructor = submission.assignment.course.instructorId === user.id;
  // A student asking for someone else's submission gets 404, not 403.
  if (!isOwner && !isInstructor) throw notFound('Submission not found');

  return { submission, assignment: submission.assignment, viewer: isInstructor ? 'instructor' : 'student' };
}

