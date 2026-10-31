import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { assertUuid, requireCourseMember, requireCourseOwner } from '../auth/rbac.js';
import { asyncHandler, badRequest, conflict, notFound, send } from '../lib/http.js';
import { rulesHash } from '../grading/canonical.js';
import { defaultRules, resolveRules } from '../grading/rules.js';

/**
 * Week 1 skeleton: an assignment exists and is reachable by the right people.
 * Rule sets, test cases and submissions attach to it from Day 8.
 */
export const assignmentsRouter = Router();

assignmentsRouter.use(requireAuth);

const createAssignmentSchema = z.object({
  title: z.string().trim().min(3, 'Use at least 3 characters').max(160),
  statement: z.string().trim().min(1, 'A short statement is required').max(20_000),
  dueAt: z.coerce.date().optional().nullable(),
});

export const courseAssignmentsRouter = Router({ mergeParams: true });
courseAssignmentsRouter.use(requireAuth);

courseAssignmentsRouter.post(
  '/',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const course = await requireCourseOwner(assertUuid(req.params.courseId), req.user.id);
    const body = createAssignmentSchema.parse(req.body);

    const assignment = await prisma.assignment.create({
      data: {
        courseId: course.id,
        title: body.title,
        statement: body.statement,
        dueAt: body.dueAt ?? null,
      },
    });

    return send(res, { assignment }, 201);
  }),
);

courseAssignmentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { course } = await requireCourseMember(assertUuid(req.params.courseId), req.user);

    const assignments = await prisma.assignment.findMany({
      where: { courseId: course.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        dueAt: true,
        gradeReleaseAt: true,
        publishedAt: true,
        activeRuleSetId: true,
        createdAt: true,
        _count: { select: { testCases: true, submissions: true } },
      },
    });

    return send(res, { assignments, course: { id: course.id, name: course.name } });
  }),
);

assignmentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const assignment = await prisma.assignment.findUnique({
      where: { id: assertUuid(req.params.id) },
      include: {
        course: { select: { id: true, name: true, instructorId: true } },
        activeRuleSet: true,
        testCases: { orderBy: [{ ordinal: 'asc' }, { name: 'asc' }] },
      },
    });
    if (!assignment) throw notFound('Assignment not found');

    // Membership is the authorisation boundary, and it is checked on the
    // parent course, not on the assignment id alone.
    await requireCourseMember(assignment.courseId, req.user);
    const isInstructor = assignment.course.instructorId === req.user.id;

    // Hidden tests and the reference solution never reach a student's browser.
    const tests = assignment.testCases
      .filter((test) => isInstructor || !test.isHidden)
      .map((test) => ({
        id: test.id,
        name: test.name,
        stdin: test.stdin,
        expectedStdout: test.expectedStdout,
        isHidden: test.isHidden,
        ordinal: test.ordinal,
      }));

    const activeRules = assignment.activeRuleSet?.rules ?? null;
    const ruleSet = assignment.activeRuleSet
      ? {
          id: assignment.activeRuleSet.id,
          version: assignment.activeRuleSet.version,
          rulesHash: assignment.activeRuleSet.rulesHash,
          problem: activeRules?.problem ?? 'untitled',
          metrics: (activeRules?.metrics ?? []).map((metric) => ({ name: metric.name, analyzer: metric.analyzer, weight: metric.weight })),
        }
      : null;

    let mySubmissions = [];
    if (!isInstructor) {
      const rows = await prisma.submission.findMany({
        where: { assignmentId: assignment.id, studentId: req.user.id },
        orderBy: { attempt: 'desc' },
        include: { evaluations: { orderBy: { startedAt: 'desc' }, take: 1 } },
      });
      const released = Boolean(assignment.gradeReleaseAt && assignment.gradeReleaseAt <= new Date());
      mySubmissions = rows.map((row) => {
        const evaluation = row.evaluations[0] ?? null;
        const visible = released || Boolean(row.releasedAt);
        return {
          id: row.id,
          attempt: row.attempt,
          filename: row.filename,
          submittedAt: row.createdAt,
          released: visible,
          evaluation: evaluation
            ? { id: evaluation.id, status: evaluation.status, gradeHundredths: visible ? evaluation.gradeHundredths : null }
            : null,
        };
      });
    }

    return send(res, {
      assignment: {
        id: assignment.id,
        courseId: assignment.courseId,
        title: assignment.title,
        statement: assignment.statement,
        dueAt: assignment.dueAt,
        gradeReleaseAt: assignment.gradeReleaseAt,
        allowLate: assignment.allowLate,
        allowNoOracle: assignment.allowNoOracle,
        publishedAt: assignment.publishedAt,
        hasReference: Boolean(assignment.referenceSolution),
        course: assignment.course,
        ...(isInstructor ? { referenceSolution: assignment.referenceSolution } : {}),
        tests,
        ruleSet,
        mySubmissions,
      },
      viewer: isInstructor ? 'instructor' : 'student',
    });
  }),
);

assignmentsRouter.patch(
  '/:id',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const id = assertUuid(req.params.id);
    const existing = await prisma.assignment.findUnique({ where: { id }, select: { courseId: true } });
    if (!existing) throw notFound('Assignment not found');
    await requireCourseOwner(existing.courseId, req.user.id);

    const body = z
      .object({
        title: z.string().trim().min(3).max(160).optional(),
        statement: z.string().trim().min(1).max(20_000).optional(),
        dueAt: z.coerce.date().nullable().optional(),
        gradeReleaseAt: z.coerce.date().nullable().optional(),
        allowLate: z.boolean().optional(),
        allowNoOracle: z.boolean().optional(),
        referenceSolution: z.string().max(64 * 1024).nullable().optional(),
      })
      .parse(req.body);

    const assignment = await prisma.assignment.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.statement !== undefined ? { statement: body.statement } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
        ...(body.gradeReleaseAt !== undefined ? { gradeReleaseAt: body.gradeReleaseAt } : {}),
        ...(body.allowLate !== undefined ? { allowLate: body.allowLate } : {}),
        ...(body.allowNoOracle !== undefined ? { allowNoOracle: body.allowNoOracle } : {}),
        ...(body.referenceSolution !== undefined ? { referenceSolution: body.referenceSolution } : {}),
      },
    });

    return send(res, { assignment });
  }),
);

/* ------------------------------------------------------------- rule sets */

async function ownedAssignment(id, userId) {
  const assignment = await prisma.assignment.findUnique({ where: { id: assertUuid(id) } });
  if (!assignment) throw notFound('Assignment not found');
  await requireCourseOwner(assignment.courseId, userId);
  return assignment;
}

/** The editor shows the latest draft and the frozen active version side by side. */
assignmentsRouter.get(
  '/:id/rules',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await ownedAssignment(req.params.id, req.user.id);
    const versions = await prisma.ruleSet.findMany({
      where: { assignmentId: assignment.id },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, isPublished: true, rulesHash: true, createdAt: true, publishedAt: true },
    });
    const latest = await prisma.ruleSet.findFirst({ where: { assignmentId: assignment.id }, orderBy: { version: 'desc' } });
    const active = assignment.activeRuleSetId
      ? await prisma.ruleSet.findUnique({ where: { id: assignment.activeRuleSetId } })
      : null;

    return send(res, {
      versions,
      draft: latest ?? null,
      active,
      defaults: defaultRules(assignment.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60) || 'assignment'),
    });
  }),
);

/**
 * Writing a rule set always creates a NEW version. A published version is
 * never edited, so a report from last month still explains itself.
 */
assignmentsRouter.put(
  '/:id/rules',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await ownedAssignment(req.params.id, req.user.id);
    const body = z.object({ rules: z.record(z.unknown()) }).parse(req.body);

    const { rules, errors } = resolveRules(body.rules);
    if (!rules) throw badRequest('The rule set is not valid', errors);

    const latest = await prisma.ruleSet.findFirst({
      where: { assignmentId: assignment.id },
      orderBy: { version: 'desc' },
      select: { version: true, isPublished: true },
    });

    // A published version is frozen: saving again starts the next version.
    const ruleSet = latest && !latest.isPublished
      ? await prisma.ruleSet.update({
          where: { assignmentId_version: { assignmentId: assignment.id, version: latest.version } },
          data: { rules, rulesHash: rulesHash(rules) },
        })
      : await prisma.ruleSet.create({
          data: {
            assignmentId: assignment.id,
            version: (latest?.version ?? 0) + 1,
            rules,
            rulesHash: rulesHash(rules),
            createdById: req.user.id,
          },
        });

    return send(res, { ruleSet, errors, version: ruleSet.version, nextVersion: ruleSet.version + 1 });
  }),
);

assignmentsRouter.post(
  '/:id/rules/publish',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await ownedAssignment(req.params.id, req.user.id);
    const latest = await prisma.ruleSet.findFirst({ where: { assignmentId: assignment.id }, orderBy: { version: 'desc' } });
    if (!latest) throw badRequest('Save a rule set before publishing');

    const { rules, errors } = resolveRules(latest.rules);
    if (errors.length) throw badRequest('Fix these rule set errors before publishing', errors);

    const published = await prisma.$transaction(async (tx) => {
      const row = await tx.ruleSet.update({
        where: { id: latest.id },
        data: { rules, rulesHash: rulesHash(rules), isPublished: true, publishedAt: new Date() },
      });
      await tx.assignment.update({ where: { id: assignment.id }, data: { activeRuleSetId: row.id } });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: 'ruleset.publish',
          entity: 'rule_set',
          entityId: row.id,
          metadata: { assignmentId: assignment.id, version: row.version, rulesHash: row.rulesHash },
        },
      });
      return row;
    });

    return send(res, { ruleSet: published, active: true });
  }),
);

assignmentsRouter.post(
  '/:id/publish',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await ownedAssignment(req.params.id, req.user.id);
    if (!assignment.activeRuleSetId) {
      throw conflict('NO_ACTIVE_RULE_SET', 'Publish a rule set before publishing the assignment.');
    }
    const ruleset = await prisma.ruleSet.findUnique({ where: { id: assignment.activeRuleSetId } });
    const { errors } = resolveRules(ruleset?.rules ?? {});
    if (errors.length) throw badRequest('The active rule set is invalid; fix it before publishing', errors);

    const published = await prisma.assignment.update({ where: { id: assignment.id }, data: { publishedAt: new Date() } });
    await prisma.auditLog.create({
      data: { actorId: req.user.id, action: 'assignment.publish', entity: 'assignment', entityId: assignment.id, metadata: { rulesetId: assignment.activeRuleSetId } },
    });
    return send(res, { assignment: published });
  }),
);

/* ------------------------------------------------------------ test cases */

const testCaseSchema = z.object({
  name: z.string().trim().min(1, 'Name the test').max(60),
  stdin: z.string().max(8192).default(''),
  expectedStdout: z.string().max(8192).default(''),
  isHidden: z.boolean().default(false),
  ordinal: z.number().int().min(0).max(999).default(0),
});

assignmentsRouter.get(
  '/:id/tests',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await ownedAssignment(req.params.id, req.user.id);
    const tests = await prisma.testCase.findMany({
      where: { assignmentId: assignment.id },
      orderBy: [{ ordinal: 'asc' }, { name: 'asc' }],
    });
    return send(res, { tests });
  }),
);

assignmentsRouter.post(
  '/:id/tests',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await ownedAssignment(req.params.id, req.user.id);
    const body = testCaseSchema.parse(req.body);

    const test = await prisma.testCase
      .create({ data: { ...body, assignmentId: assignment.id } })
      .catch((error) => {
        if (error?.code === 'P2002') throw conflict('TEST_NAME_TAKEN', `A test named "${body.name}" already exists.`);
        throw error;
      });

    return send(res, { test }, 201);
  }),
);

assignmentsRouter.patch(
  '/:id/tests/:testId',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await ownedAssignment(req.params.id, req.user.id);
    const testId = assertUuid(req.params.testId);
    const existing = await prisma.testCase.findFirst({ where: { id: testId, assignmentId: assignment.id } });
    if (!existing) throw notFound('Test not found');

    const body = testCaseSchema.partial().parse(req.body);
    const test = await prisma.testCase.update({ where: { id: testId }, data: body }).catch((error) => {
      if (error?.code === 'P2002') throw conflict('TEST_NAME_TAKEN', 'Another test already uses that name.');
      throw error;
    });
    return send(res, { test });
  }),
);

assignmentsRouter.delete(
  '/:id/tests/:testId',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const assignment = await ownedAssignment(req.params.id, req.user.id);
    const testId = assertUuid(req.params.testId);
    const existing = await prisma.testCase.findFirst({ where: { id: testId, assignmentId: assignment.id } });
    if (!existing) throw notFound('Test not found');
    await prisma.testCase.delete({ where: { id: testId } });
    return res.status(204).end();
  }),
);
