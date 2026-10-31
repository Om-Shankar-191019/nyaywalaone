import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { assertUuid, requireCourseOwner, requireEnrolled } from '../auth/rbac.js';
import { asyncHandler, conflict, notFound, send } from '../lib/http.js';
import { sha256Hex } from '../lib/hash.js';
import { prepareEvaluationKey, reportForEvaluation, runEvaluation } from '../grading/coordinator.js';
import { resolveRules } from '../grading/rules.js';
import {
  canSeeReport,
  latestEvaluation,
  loadSubmissionForViewer,
  serialiseSubmission,
  submitAndGrade,
} from '../services/submission-service.js';

export const submissionsRouter = Router();

// Auth is per-route: this router is mounted at `/api`, so a blanket middleware
// would also intercept unauthenticated routes such as `/api/health`.

async function loadOwnedAssignment(assignmentId, userId) {
  const assignment = await prisma.assignment.findUnique({
    where: { id: assertUuid(assignmentId) },
    include: { course: { select: { id: true, name: true, instructorId: true } } },
  });
  if (!assignment) throw notFound('Assignment not found');
  await requireCourseOwner(assignment.courseId, userId);
  return assignment;
}

/* ------------------------------------------------------------------ upload */

submissionsRouter.post(
  '/assignments/:id/submissions',
  requireAuth,
  requireRole('STUDENT'),
  asyncHandler(async (req, res) => {
    const assignmentId = assertUuid(req.params.id);
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { course: true },
    });
    if (!assignment) throw notFound('Assignment not found');
    await requireEnrolled(assignment.courseId, req.user.id);

    const body = z
      .object({
        filename: z.string().trim().max(120).optional(),
        source: z.string().min(1).max(config.maxSourceBytes),
      })
      .parse(req.body);

    const { submission, evaluation } = await submitAndGrade({
      assignment,
      student: req.user,
      filename: body.filename,
      source: body.source,
    });

    const visible = canSeeReport(assignment, submission, req.user);
    return send(
      res,
      {
        submission: serialiseSubmission(submission, evaluation, { includeGrade: visible }),
        reportAvailable: visible && Boolean(evaluation?.reportHash),
      },
      201,
    );
  }),
);

/* ------------------------------------------------------------- read a run */

submissionsRouter.get(
  '/submissions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { submission, assignment, viewer } = await loadSubmissionForViewer(assertUuid(req.params.id), req.user);
    const evaluation = await latestEvaluation(submission.id);
    const includeGrade = canSeeReport(assignment, submission, req.user);
    return send(res, {
      viewer,
      assignment: { id: assignment.id, title: assignment.title, dueAt: assignment.dueAt, gradeReleaseAt: assignment.gradeReleaseAt },
      submission: serialiseSubmission(submission, evaluation, { includeGrade }),
      canRelease: viewer === 'instructor',
    });
  }),
);

submissionsRouter.get(
  '/submissions/:id/report',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { submission, assignment } = await loadSubmissionForViewer(assertUuid(req.params.id), req.user);
    if (!canSeeReport(assignment, submission, req.user)) {
      throw conflict('REPORT_NOT_RELEASED', 'Your instructor has not released this grade yet.');
    }
    const evaluation = await latestEvaluation(submission.id);
    if (!evaluation) throw notFound('No evaluation exists for this submission yet');
    if (!evaluation.reportHash) throw conflict('REPORT_NOT_READY', `Grading is ${evaluation.status.toLowerCase()}; the report is not ready yet.`);

    const report = await reportForEvaluation(evaluation.id);
    return send(res, report);
  }),
);

submissionsRouter.get(
  '/submissions/:id/report.txt',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { submission, assignment } = await loadSubmissionForViewer(assertUuid(req.params.id), req.user);
    if (!canSeeReport(assignment, submission, req.user)) {
      throw conflict('REPORT_NOT_RELEASED', 'Your instructor has not released this grade yet.');
    }
    const evaluation = await latestEvaluation(submission.id);
    if (!evaluation?.reportHash) throw conflict('REPORT_NOT_READY', 'The report is not ready yet.');

    const report = await reportForEvaluation(evaluation.id);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="nyaywala-${submission.id.slice(0, 8)}-attempt-${submission.attempt}.txt"`,
    );
    return res.send(report.text);
  }),
);

/* ---------------------------------------------------------------- regrade */

submissionsRouter.post(
  '/submissions/:id/regrade',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const { submission, assignment } = await loadSubmissionForViewer(assertUuid(req.params.id), req.user);
    const body = z.object({ reason: z.string().trim().min(3, 'Say why this is being re-graded').max(500) }).parse(req.body);

    const previous = await latestEvaluation(submission.id);
    if (!previous) throw conflict('NOT_GRADED', 'This submission has never been graded.');
    if (['QUEUED', 'RUNNING'].includes(previous.status)) {
      throw conflict('GRADING_IN_PROGRESS', 'This submission is already being graded.');
    }

    const ruleset = await prisma.ruleSet.findUnique({ where: { id: previous.rulesetId } });
    const tests = await prisma.testCase.findMany({
      where: { assignmentId: assignment.id },
      orderBy: [{ ordinal: 'asc' }, { name: 'asc' }],
    });
    const { rules, errors } = resolveRules(ruleset.rules);
    if (errors.length) throw conflict('RULE_SET_INVALID', 'The stored rule set is no longer valid.');

    const prep = await prepareEvaluationKey({
      assignment,
      sourceHash: submission.sourceHash,
      rules,
      tests,
      provider: previous.provider,
    });
    const runCount = await prisma.evaluation.count({ where: { submissionId: submission.id } });

    const created = await prisma.evaluation.create({
      data: {
        submissionId: submission.id,
        rulesetId: previous.rulesetId,
        evaluationKey: sha256Hex(`${prep.key}:regrade:${runCount}`),
        status: 'QUEUED',
        provider: previous.provider,
        toolchainFingerprint: prep.toolchain_hash,
        graderVersion: '2.0.0',
        lineageOfId: previous.id,
      },
    });

    await prisma.auditLog.create({
      data: { actorId: req.user.id, action: 'evaluation.regrade', entity: 'submission', entityId: submission.id, metadata: { reason: body.reason, evaluationId: created.id, previousId: previous.id } },
    });

    await runEvaluation(created.id);
    const fresh = await prisma.evaluation.findUnique({ where: { id: created.id }, include: { metrics: { orderBy: { ordinal: 'asc' } } } });
    return send(res, { submission: serialiseSubmission(submission, fresh, { includeGrade: true }), previousEvaluationId: previous.id }, 201);
  }),
);

/* ---------------------------------------------------------------- release */

submissionsRouter.patch(
  '/submissions/:id/release',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const { submission, assignment } = await loadSubmissionForViewer(assertUuid(req.params.id), req.user);
    const body = z.object({ released: z.boolean() }).parse(req.body);

    const updated = await prisma.submission.update({
      where: { id: submission.id },
      data: { releasedAt: body.released ? new Date() : null },
    });

    await prisma.auditLog.create({
      data: { actorId: req.user.id, action: body.released ? 'grade.release' : 'grade.unrelease', entity: 'submission', entityId: submission.id, metadata: { assignmentId: assignment.id } },
    });

    return send(res, { submission: serialiseSubmission(updated, await latestEvaluation(updated.id), { includeGrade: true }) });
  }),
);

/* ---------------------------------------------------------------- cohort */

const cohortFilters = z.object({
  q: z.string().trim().max(120).optional().default(''),
  status: z.enum(['ANY', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED']).optional().default('ANY'),
  minGrade: z.coerce.number().min(0).max(100).optional(),
  maxGrade: z.coerce.number().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'grade', 'submitted']).default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  unreleasedOnly: z.enum(['true', 'false']).optional().default('false'),
});

async function cohortRows(assignmentId, filters) {
  const rows = await prisma.submission.findMany({
    where: {
      assignmentId,
      ...(filters.q
        ? {
            student: {
              OR: [
                { fullName: { contains: filters.q, mode: 'insensitive' } },
                { email: { contains: filters.q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    include: {
      student: { select: { id: true, fullName: true, email: true } },
      evaluations: { orderBy: { startedAt: 'desc' }, take: 1 },
    },
  });

  // Latest attempt per student; two attempts from the same person are one row.
  const byStudent = new Map();
  for (const row of rows) {
    const current = byStudent.get(row.studentId);
    if (!current || row.attempt > current.attempt) byStudent.set(row.studentId, row);
  }

  const latest = (student) => student.evaluations[0] ?? null;

  let items = [...byStudent.values()].map((submission) => {
    const evaluation = latest(submission);
    return {
      submissionId: submission.id,
      student: submission.student,
      attempt: submission.attempt,
      filename: submission.filename,
      submittedAt: submission.createdAt,
      releasedAt: submission.releasedAt,
      gradeHundredths: evaluation?.gradeHundredths ?? null,
      percent: evaluation?.gradeHundredths != null ? evaluation.gradeHundredths / 100 : null,
      status: evaluation?.status ?? 'NOT_GRADED',
      evaluationId: evaluation?.id ?? null,
      failedReason: evaluation?.failedReason ?? null,
      noAttempt: false,
    };
  });

  const enrolled = await prisma.enrollment.findMany({
    where: { courseId: (await prisma.assignment.findUnique({ where: { id: assignmentId }, select: { courseId: true } })).courseId },
    include: { student: { select: { id: true, fullName: true, email: true } } },
  });
  for (const row of enrolled) {
    if (!byStudent.has(row.studentId)) {
      items.push({
        submissionId: null,
        student: row.student,
        attempt: null,
        filename: null,
        submittedAt: null,
        releasedAt: null,
        gradeHundredths: null,
        percent: null,
        status: 'NO_SUBMISSION',
        evaluationId: null,
        failedReason: null,
        noAttempt: true,
      });
    }
  }

  if (filters.status !== 'ANY') items = items.filter((item) => item.status === filters.status);
  if (filters.minGrade !== undefined) items = items.filter((item) => item.percent != null && item.percent >= filters.minGrade);
  if (filters.maxGrade !== undefined) items = items.filter((item) => item.percent != null && item.percent <= filters.maxGrade);
  if (filters.unreleasedOnly === 'true') items = items.filter((item) => item.submissionId && !item.releasedAt);

  const dir = filters.direction === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    if (filters.sort === 'grade') return ((a.percent ?? -1) - (b.percent ?? -1)) * dir;
    if (filters.sort === 'submitted') return ((a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0)) * dir;
    return a.student.fullName.localeCompare(b.student.fullName) * dir;
  });

  return items;
}

submissionsRouter.get(
  '/assignments/:id/submissions',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await loadOwnedAssignment(req.params.id, req.user.id);
    const filters = cohortFilters.parse(req.query);
    const all = await cohortRows(assignment.id, filters);
    const start = (filters.page - 1) * filters.pageSize;

    return send(res, {
      assignment: { id: assignment.id, title: assignment.title },
      total: all.length,
      page: filters.page,
      pageSize: filters.pageSize,
      submissions: all.slice(start, start + filters.pageSize),
      counts: {
        graded: all.filter((item) => item.percent != null).length,
        failed: all.filter((item) => item.status === 'FAILED' || item.status === 'PARTIAL').length,
        missing: all.filter((item) => item.noAttempt).length,
        unreleased: all.filter((item) => item.submissionId && !item.releasedAt).length,
      },
    });
  }),
);

/* ---------------------------------------------------------------- export */

// Excel treats a leading =, +, - or @ as a formula. Prefixing with an
// apostrophe keeps a student name like "=SUM(A1)" out of the cell's syntax.
const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

submissionsRouter.get(
  '/assignments/:id/export.csv',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await loadOwnedAssignment(req.params.id, req.user.id);
    const filters = cohortFilters.parse({ ...req.query, page: 1, pageSize: 100 });
    const all = await cohortRows(assignment.id, filters);

    const header = ['student_name', 'student_email', 'attempt', 'submitted_at', 'grade_percent', 'status', 'released', 'evaluation_id'];
    const lines = [
      header.join(','),
      ...all.map((item) =>
        [
          csvCell(item.student.fullName),
          csvCell(item.student.email),
          csvCell(item.attempt ?? ''),
          csvCell(item.submittedAt ? item.submittedAt.toISOString() : ''),
          csvCell(item.percent != null ? item.percent.toFixed(2) : ''),
          csvCell(item.status),
          csvCell(item.releasedAt ? item.releasedAt.toISOString() : ''),
          csvCell(item.evaluationId ?? ''),
        ].join(','),
      ),
    ];

    await prisma.auditLog.create({
      data: { actorId: req.user.id, action: 'cohort.export', entity: 'assignment', entityId: assignment.id, metadata: { rows: all.length } },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nyaywala-${assignment.id.slice(0, 8)}-grades.csv"`);
    return res.send(`${lines.join('\n')}\n`);
  }),
);

/* ------------------------------------------------------------ similarity */

submissionsRouter.get(
  '/assignments/:id/similarity',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await loadOwnedAssignment(req.params.id, req.user.id);
    const threshold = z.coerce.number().min(0).max(1).default(0.6).parse(req.query.threshold ?? 0.6);

    const matches = await prisma.similarityMatch.findMany({
      where: { assignmentId: assignment.id, similarity: { gte: threshold } },
      orderBy: { similarity: 'desc' },
      take: 100,
    });

    const ids = [...new Set(matches.flatMap((match) => [match.submissionA, match.submissionB]))];
    const submissions = await prisma.submission.findMany({
      where: { id: { in: ids } },
      include: { student: { select: { fullName: true, email: true } } },
    });
    const byId = new Map(submissions.map((submission) => [submission.id, submission]));

    return send(res, {
      threshold,
      matches: matches.map((match) => ({
        id: match.id,
        similarity: match.similarity,
        method: match.method,
        createdAt: match.createdAt,
        a: byId.get(match.submissionA)
          ? { submissionId: match.submissionA, student: byId.get(match.submissionA).student, attempt: byId.get(match.submissionA).attempt }
          : null,
        b: byId.get(match.submissionB)
          ? { submissionId: match.submissionB, student: byId.get(match.submissionB).student, attempt: byId.get(match.submissionB).attempt }
          : null,
      })),
    });
  }),
);
