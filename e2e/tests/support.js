import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Accounts come from the seed and can be overridden for a preview deployment.
 * The defaults are the demo accounts printed by `npm run db:seed`; they are not
 * secrets and they exist only in a seeded database.
 */
export const DEMO = {
  instructor: {
    email: process.env.E2E_INSTRUCTOR_EMAIL || 'prof@example.edu',
    password: process.env.E2E_INSTRUCTOR_PASSWORD || 'Passw0rd-Demo-2026',
  },
  student: {
    email: process.env.E2E_STUDENT_EMAIL || 'student1@example.edu',
    password: process.env.E2E_STUDENT_PASSWORD || 'Passw0rd-Demo-2026',
  },
};

/** Sign in through the form, exactly the way a person would. */
export async function signIn(page, account) {
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The guard redirects to the role's own area; asserting it is the fastest way
  // to catch an auth regression before a journey produces a misleading failure.
  await page.waitForURL(/\/(student|instructor)(\/|$)/, { timeout: 30_000 });
}

/** First enrolled course (student) or owned course (instructor), via the API. */
export async function firstCourse(page, role) {
  const response = await page.request.get('/api/courses');
  expect(response.ok(), `GET /api/courses answered ${response.status()}`).toBeTruthy();
  const body = await response.json();
  const courses = body.data?.courses ?? body.data ?? [];
  expect(Array.isArray(courses) && courses.length > 0, 'the seeded database has no course').toBeTruthy();
  const course = courses.find((item) => item.name?.includes('CS 101')) ?? courses[0];
  return course;
}

/** Assignments of a course; `role` decides whether we read the instructor view. */
export async function assignmentsOf(page, courseId) {
  const response = await page.request.get(`/api/courses/${courseId}/assignments`);
  expect(response.ok(), `GET /courses/${courseId}/assignments answered ${response.status()}`).toBeTruthy();
  const body = await response.json();
  return body.data?.assignments ?? [];
}

/**
 * A correct submission used by the student journey. `fileURLToPath` is required:
 * `.pathname` keeps the leading slash and hands Playwright `E:\E:\...` on Windows.
 */
export const CORRECT_SOURCE_PATH = fileURLToPath(
  new URL('../../backend/tests/golden/corpus/01-correct.c', import.meta.url),
);
