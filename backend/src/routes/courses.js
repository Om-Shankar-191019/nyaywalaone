import { Prisma } from '../generated/prisma/client.js';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { assertUuid, requireCourseOwner, requireEnrolled } from '../auth/rbac.js';
import { asyncHandler, conflict, notFound, send } from '../lib/http.js';

export const coursesRouter = Router();

// No I, O, 0 or 1: a join code gets read out loud and typed on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateJoinCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

const createCourseSchema = z.object({
  name: z.string().trim().min(3, 'Use at least 3 characters').max(120),
});

coursesRouter.use(requireAuth);

coursesRouter.post(
  '/',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const { name } = createCourseSchema.parse(req.body);

    // Collisions are vanishingly rare (32^8) but a retry is cheaper than a 500.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const course = await prisma.course.create({
          data: { name, instructorId: req.user.id, joinCode: generateJoinCode() },
        });
        return send(res, { course }, 201);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }

    throw conflict('JOIN_CODE_EXHAUSTED', 'Could not allocate a join code, please retry');
  }),
);

coursesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    if (req.user.role === 'INSTRUCTOR') {
      const courses = await prisma.course.findMany({
        where: { instructorId: req.user.id },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { enrollments: true, assignments: true } } },
      });
      return send(res, { courses });
    }

    const rows = await prisma.enrollment.findMany({
      where: { studentId: req.user.id },
      orderBy: { enrolledAt: 'asc' },
      include: {
        course: {
          select: {
            id: true,
            name: true,
            createdAt: true,
            instructor: { select: { fullName: true } },
            _count: { select: { assignments: true } },
          },
        },
      },
    });

    // Students never receive another course's join code.
    return send(res, { courses: rows.map((row) => row.course) });
  }),
);

coursesRouter.post(
  '/join',
  requireRole('STUDENT'),
  asyncHandler(async (req, res) => {
    const { code } = z
      .object({ code: z.string().trim().min(4, 'Enter the 8-character join code').max(12) })
      .parse(req.body);

    const course = await prisma.course.findUnique({ where: { joinCode: code.toUpperCase() } });
    if (!course) throw notFound('No course matches that join code');

    // Joining twice is not an error: the student may have two tabs open.
    await prisma.enrollment.upsert({
      where: { courseId_studentId: { courseId: course.id, studentId: req.user.id } },
      create: { courseId: course.id, studentId: req.user.id },
      update: {},
    });

    return send(res, { course: { id: course.id, name: course.name } });
  }),
);

coursesRouter.get(
  '/:id/roster',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const course = await requireCourseOwner(assertUuid(req.params.id), req.user.id);

    const students = await prisma.enrollment.findMany({
      where: { courseId: course.id },
      orderBy: { student: { fullName: 'asc' } },
      include: { student: { select: { id: true, fullName: true, email: true } } },
    });

    // Day 18: a roster without activity is a list of names. One grouped query
    // gives the counts and the last submission, which is what "has this person
    // done anything?" actually needs.
    const activity = await prisma.submission.groupBy({
      by: ['studentId'],
      where: { assignment: { courseId: course.id } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const byStudent = new Map(activity.map((row) => [row.studentId, row]));

    return send(res, {
      course: { id: course.id, name: course.name, joinCode: course.joinCode },
      students: students.map((row) => ({
        ...row.student,
        enrolledAt: row.enrolledAt,
        submissionCount: byStudent.get(row.studentId)?._count?._all ?? 0,
        lastSubmissionAt: byStudent.get(row.studentId)?._max?.createdAt ?? null,
      })),
    });
  }),
);

/**
 * Remove a student from the course.
 *
 * Deliberately not a delete of their work: unenrolling must not destroy a
 * submission someone may have already been graded on. The cascade is on
 * `enrollments` only, so submissions stay attached to the assignment and the
 * instructor can still explain a mark if the student asks.
 */
coursesRouter.delete(
  '/:id/roster/:studentId',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    const course = await requireCourseOwner(assertUuid(req.params.id), req.user.id);
    const studentId = assertUuid(req.params.studentId);

    const deleted = await prisma.enrollment.deleteMany({ where: { courseId: course.id, studentId } });
    if (!deleted.count) throw notFound('That student is not enrolled in this course');

    await prisma.auditLog.create({
      data: { actorId: req.user.id, action: 'roster.remove', entity: 'course', entityId: course.id, metadata: { studentId } },
    });

    return send(res, { removed: studentId });
  }),
);

coursesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const courseId = assertUuid(req.params.id);

    if (req.user.role === 'INSTRUCTOR') {
      const course = await requireCourseOwner(courseId, req.user.id);
      return send(res, { course });
    }

    const enrollment = await requireEnrolled(courseId, req.user.id);
    return send(res, { course: { id: enrollment.course.id, name: enrollment.course.name } });
  }),
);
