import { config } from '../config.js';
import { prisma } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/http.js';
import { normalizeSource, sourceHash } from '../lib/hash.js';
import { prepareEvaluationKey, runEvaluation } from '../grading/coordinator.js';
import { resolveRules } from '../grading/rules.js';

const MAX_FILENAME = 120;

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
 * Upload and grade. The submission row is written first so a provider failure
 * never loses a student's work; the evaluation is keyed by content, so a
 * double-click cannot spend budget twice.
 */
export async function submitAndGrade({ assignment, student, filename, source }) {
  if (!assignment.activeRuleSetId) {
    throw conflict('ASSIGNMENT_NOT_PUBLISHED', 'This assignment has no published rule set yet, so it cannot be graded.');
  }

  const trimmedSource = String(source ?? '');
  if (!trimmedSource.trim()) throw badRequest('The source file is empty');
  if (Buffer.byteLength(trimmedSource, 'utf8') > config.maxSourceBytes) {
    throw badRequest(`Source exceeds the ${Math.round(config.maxSourceBytes / 1024)} KB limit`);
  }

  const safeName = String(filename ?? 'main.c').trim().slice(0, MAX_FILENAME) || 'main.c';
  if (!/\.c$/i.test(safeName)) throw badRequest('Upload a C source file ending in .c');

  const now = new Date();
  if (assignment.dueAt && assignment.dueAt < now && !assignment.allowLate) {
    throw conflict('LATE_NOT_ALLOWED', `This assignment closed on ${assignment.dueAt.toISOString()}. Late submissions are not accepted.`);
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

  let evaluation = await prisma.evaluation.findUnique({ where: { evaluationKey: prep.key } });
  if (!evaluation) {
    evaluation = await prisma.evaluation.create({
      data: {
        submissionId: submission.id,
        rulesetId: ruleset.id,
        evaluationKey: prep.key,
        status: 'QUEUED',
        provider: prep.provider,
        toolchainFingerprint: prep.toolchain_hash,
        graderVersion: '2.0.0',
      },
    });
  }

  if (evaluation.status === 'QUEUED' || evaluation.status === 'FAILED') {
    try {
      await runEvaluation(evaluation.id);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'GRADING_FAILED', 'Grading could not complete. The submission is saved and can be re-graded.', {
        reason: String(error.message ?? error).slice(0, 300),
      });
    }
  }

  const fresh = await prisma.evaluation.findUnique({ where: { id: evaluation.id }, include: { metrics: { orderBy: { ordinal: 'asc' } } } });
  return { submission, evaluation: fresh, rules };
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
