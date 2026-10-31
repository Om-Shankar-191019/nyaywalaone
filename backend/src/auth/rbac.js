import { prisma } from '../db.js';
import { notFound } from '../lib/http.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Malformed ids are treated exactly like missing ones. The client learns
 * nothing about whether an id exists, which keeps ids non-enumerable.
 */
export function assertUuid(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound('Not found');
  return id;
}

/** Instructor path: the caller must own the course. */
export async function requireCourseOwner(courseId, userId) {
  assertUuid(courseId);
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.instructorId !== userId) throw notFound('Course not found');
  return course;
}

/** Student path: the caller must be enrolled. */
export async function requireEnrolled(courseId, userId) {
  assertUuid(courseId);
  const enrollment = await prisma.enrollment.findUnique({
    where: { courseId_studentId: { courseId, studentId: userId } },
    include: { course: true },
  });
  if (!enrollment) throw notFound('Course not found');
  return enrollment;
}

/** Either the owning instructor or an enrolled student may read the course. */
export async function requireCourseMember(courseId, user) {
  assertUuid(courseId);
  if (user.role === 'INSTRUCTOR') {
    return { course: await requireCourseOwner(courseId, user.id), viewer: 'instructor' };
  }
  const enrollment = await requireEnrolled(courseId, user.id);
  return { course: enrollment.course, viewer: 'student' };
}
