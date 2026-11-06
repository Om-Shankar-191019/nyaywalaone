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
import { createRateLimiter } from '../lib/rateLimit.js';
import { reviewMatch, scanAssignment } from '../grading/similarity-scan.js';
import { claimEvaluationById, drain, processClaimedEvaluation, queueDepth } from '../services/queue.js';
import {
  canSeeReport,
  createSubmissionRecord,
  latestEvaluation,
  loadSubmissionForViewer,
  resumeStalledGrading,
  scheduleGrading,
  serialiseSubmission,
} from '../services/submission-service.js';

export const submissionsRouter = Router();

/**
 * Day 21: ten uploads per hour per account. A submission is the only route that
 * spends sandbox quota, so it is the only one that needs a ceiling tighter than
 * "whatever the browser allows".
 */
export const submissionLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: (req) => `submit:${req.user?.id ?? req.ip}`,
  code: 'SUBMISSION_RATE_LIMITED',
  message: 'You have submitted 10 times this hour. Wait a little before uploading again.',
});

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
  submissionLimiter,
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

    const { submission, evaluation } = await createSubmissionRecord({
      assignment,
      student: req.user,
      filename: body.filename,
      source: body.source,
    });

    // Day 15: the request answers as soon as the work is queued. Grading starts
    // on the next tick, so the student sees `queued -> compiling -> testing ->
    // analyzing` instead of a spinner with no information for ten seconds.
    setImmediate(() => scheduleGrading(evaluation.id));

    const visible = canSeeReport(assignment, submission, req.user);
    return send(
      res,
      {
        submission: serialiseSubmission(submission, evaluation, { includeGrade: visible }),
        pollUrl: `/api/submissions/${submission.id}`,
        reportAvailable: visible && Boolean(evaluation?.reportHash),
      },
      202,
    );
  }),
);

/* ------------------------------------------------------- grade a queued row */

/**
 * Drive the queue from a request that already has permission to see the row.
 *
 * A submission answers 202 and grades off the request path, which is right for
 * the student. On Vercel that response also ends the invocation, so the
 * in-process kick that starts the grade is a best effort, and the per-minute
 * cron that used to cover the rest is a Pro-only plan feature. This endpoint is
 * the replacement: the poll that watches a grade also claims it.
 *
 * The claim is one atomic UPDATE, so a poll that loses to the kick, to another
 * invocation or to the daily drain answers `claimed: false` after a single
 * query instead of grading the same file twice. Only the status is echoed back:
 * a grade stays invisible until it is released, exactly as on the read routes.
 */
submissionsRouter.post(
  '/submissions/:id/grade',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { submission } = await loadSubmissionForViewer(assertUuid(req.params.id), req.user);
    const evaluation = await latestEvaluation(submission.id);
    if (!evaluation) throw notFound('No evaluation exists for this submission yet');

    const claimedId = await claimEvaluationById(evaluation.id);
    if (!claimedId) {
      return send(res, { claimed: false, status: evaluation.status, stage: evaluation.stage ?? 'queued' }, 202);
    }

    const result = await processClaimedEvaluation(claimedId);
    return send(res, { claimed: true, status: result.status });
  }),
);

/* ------------------------------------------------------------- read a run */

submissionsRouter.get(
  '/submissions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { submission, assignment, viewer } = await loadSubmissionForViewer(assertUuid(req.params.id), req.user);
    let evaluation = await latestEvaluation(submission.id);
    // A poll is also the moment to notice a run that died before writing its
    // report: restart it here rather than showing "grading" forever.
    if (await resumeStalledGrading(evaluation)) evaluation = await latestEvaluation(submission.id);
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
      data: {
        actorId: req.user.id,
        action: 'evaluation.regrade',
        entity: 'submission',
        entityId: submission.id,
        // `assignmentId` is what the activity feed filters on, so every action
        // that can change a grade records it.
        metadata: {
          assignmentId: submission.assignmentId,
          reason: body.reason,
          evaluationId: created.id,
          previousId: previous.id,
        },
      },
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
  // `NO_SUBMISSION` and `NOT_GRADED` are synthesised by the cohort query for
  // enrolled students who have not uploaded, so the filter has to accept them.
  status: z
    .enum(['ANY', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'NOT_GRADED', 'NO_SUBMISSION'])
    .optional()
    .default('ANY'),
  minGrade: z.coerce.number().min(0).max(100).optional(),
  maxGrade: z.coerce.number().min(0).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'grade', 'submitted']).default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  unreleasedOnly: z.enum(['true', 'false']).optional().default('false'),
  // Day 18: "flagged only" means "has a similarity match at or above the rule
  // set's threshold", not "score is odd" - it comes from the same table the
  // originality metric writes to.
  flaggedOnly: z.enum(['true', 'false']).optional().default('false'),
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

  if (filters.flaggedOnly === 'true') {
    const matches = await prisma.similarityMatch.findMany({
      where: { assignmentId },
      select: { submissionA: true, submissionB: true },
    });
    const flagged = new Set(matches.flatMap((match) => [match.submissionA, match.submissionB]));
    items = items.filter((item) => item.submissionId && flagged.has(item.submissionId));
  }

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

/* ------------------------------------------------------- batch grading */

/**
 * Day 23: grade the whole cohort. The endpoint only *enqueues*; grading happens
 * on the queue, so a 200-student assignment does not hold the request open and
 * a partial run is resumable by calling it again.
 */
submissionsRouter.post(
  '/assignments/:id/grade-all',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await loadOwnedAssignment(req.params.id, req.user.id);
    const body = z
      .object({ includeFailed: z.boolean().default(true), start: z.boolean().default(true) })
      .parse(req.body ?? {});

    const statuses = body.includeFailed ? ['QUEUED', 'FAILED'] : ['QUEUED'];
    const pending = await prisma.evaluation.findMany({
      where: { submission: { assignmentId: assignment.id }, status: { in: statuses } },
      select: { id: true, status: true },
    });

    // A manual regrade is a fresh decision: a row that burned its retries is
    // given its budget back rather than failing again on the next cron tick.
    const requeued = await prisma.evaluation.updateMany({
      where: { id: { in: pending.map((row) => row.id) } },
      data: { status: 'QUEUED', stage: 'queued', attemptCount: 0, claimedAt: null, failedReason: null, finishedAt: null },
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.id,
        action: 'assignment.grade_all',
        entity: 'assignment',
        entityId: assignment.id,
        metadata: { queued: requeued.count, includeFailed: body.includeFailed },
      },
    });

    // Kick the queue once so the first rows move without waiting for cron.
    if (body.start && !config.isTest && requeued.count > 0) {
      setImmediate(() => drain({ limit: Math.min(3, requeued.count) }).catch(() => {}));
    }

    return send(res, {
      assignmentId: assignment.id,
      queued: requeued.count,
      total: await prisma.evaluation.count({ where: { submission: { assignmentId: assignment.id } } }),
      queue: await queueDepth(),
    });
  }),
);

/**
 * Progress counters for the cohort view. `unreleased` is separate from `graded`
 * on purpose: a grade can exist and still be invisible to the student.
 */
submissionsRouter.get(
  '/assignments/:id/grading-progress',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await loadOwnedAssignment(req.params.id, req.user.id);
    const grouped = await prisma.evaluation.groupBy({
      by: ['status'],
      where: { submission: { assignmentId: assignment.id } },
      _count: { _all: true },
    });

    const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const done = (counts.SUCCEEDED ?? 0) + (counts.PARTIAL ?? 0);

    return send(res, {
      assignmentId: assignment.id,
      counts: {
        queued: counts.QUEUED ?? 0,
        running: counts.RUNNING ?? 0,
        succeeded: counts.SUCCEEDED ?? 0,
        partial: counts.PARTIAL ?? 0,
        failed: counts.FAILED ?? 0,
        total,
        done,
      },
      percent: total ? Math.round((done / total) * 1000) / 10 : 0,
      queue: await queueDepth(),
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

/* -------------------------------------------------------------- activity */

/**
 * Day 18: a small activity feed. When a grade changes under a student's feet,
 * "who did that and when" has to be answerable without reading the database.
 */
submissionsRouter.get(
  '/assignments/:id/activity',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await loadOwnedAssignment(req.params.id, req.user.id);
    const take = z.coerce.number().int().min(1).max(50).default(20).parse(req.query.limit ?? 20);

    const entries = await prisma.auditLog.findMany({
      where: {
        OR: [
          { entity: 'assignment', entityId: assignment.id },
          { metadata: { path: ['assignmentId'], equals: assignment.id } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: { actor: { select: { fullName: true, email: true } } },
    });

    return send(res, {
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
        actor: entry.actor ? { fullName: entry.actor.fullName, email: entry.actor.email } : null,
      })),
    });
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
        reviewedAt: match.reviewedAt,
        reviewNote: match.reviewNote,
        matchedSpan: match.matchedSpan,
      })),
    });
  }),
);

/**
 * Day 19: the whole-assignment scan.
 *
 * The per-submission analyzer only ever sees the corpus at the moment one
 * student uploads, so a pair can be missed if the second upload happened before
 * the first was graded. This endpoint compares everything on demand.
 */
submissionsRouter.post(
  '/assignments/:id/similarity/scan',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await loadOwnedAssignment(req.params.id, req.user.id);
    const body = z
      .object({
        shingle_size: z.coerce.number().int().min(3).max(20).optional(),
        num_perm: z.coerce.number().int().min(32).max(512).optional(),
        seed: z.coerce.number().int().min(0).max(1_000_000).optional(),
        flag_threshold: z.coerce.number().min(0.5).max(1).optional(),
      })
      .parse(req.body ?? {});

    const summary = await scanAssignment(assignment.id, body);

    await prisma.auditLog.create({
      data: {
        actorId: req.user.id,
        action: 'similarity.scan',
        entity: 'assignment',
        entityId: assignment.id,
        metadata: { ...summary, assignmentId: assignment.id },
      },
    });

    return send(res, summary);
  }),
);

/** Record that a human looked at a pair. It never changes a grade. */
submissionsRouter.patch(
  '/similarity/:matchId/review',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const matchId = assertUuid(req.params.matchId);
    const body = z
      .object({ reviewed: z.boolean().default(true), note: z.string().max(500).optional() })
      .parse(req.body ?? {});

    const match = await prisma.similarityMatch.findUnique({ where: { id: matchId } });
    if (!match) throw notFound('Similarity match not found');
    await loadOwnedAssignment(match.assignmentId, req.user.id);

    const updated = await reviewMatch(matchId, { reviewed: body.reviewed, note: body.note, reviewerId: req.user.id });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.id,
        action: body.reviewed ? 'similarity.reviewed' : 'similarity.reopened',
        entity: 'similarity_match',
        entityId: match.id,
        metadata: { assignmentId: match.assignmentId, similarity: match.similarity, note: body.note ?? null },
      },
    });

    return send(res, {
      match: { id: updated.id, reviewedAt: updated.reviewedAt, reviewNote: updated.reviewNote },
    });
  }),
);
