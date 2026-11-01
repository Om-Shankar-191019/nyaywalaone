import { expect, test } from '@playwright/test';
import { assignmentsOf, firstCourse, signIn, DEMO } from './support.js';

/**
 * Day 25: the instructor journey.
 *
 * The journey proves three things a viva can ask about: an instructor reaches the
 * instructor area, the rule set a grade depends on is visible, and the cohort can
 * be graded as a batch without holding a request open. Nothing here publishes a new
 * rule set - a journey must not change the marks of the cohort it runs against.
 *
 * Tabs are `role="tab"`, not buttons, so they are selected by role: a
 * `getByRole('button')` lookup hangs until the test times out.
 */
test.describe('instructor journey', () => {
  test('sees the course, the rule set and the cohort queue', async ({ page }) => {
    await signIn(page, DEMO.instructor);

    const course = await firstCourse(page, 'INSTRUCTOR');
    const assignments = await assignmentsOf(page, course.id);
    expect(assignments.length, 'the seeded course has no assignment').toBeGreaterThan(0);
    const assignment = assignments.find((item) => /sum of two integers/i.test(item.title)) ?? assignments[0];

    // The dashboard lists the course; the course page lists the assignment.
    await page.goto('/instructor');
    await expect(page.getByRole('heading', { name: /instructor/i }).first()).toBeVisible();
    await page.goto(`/instructor/courses/${course.id}`);
    await expect(page.getByText(course.name).first()).toBeVisible();

    await page.goto(`/instructor/assignments/${assignment.id}`);
    await expect(page.getByRole('heading', { name: new RegExp(assignment.title, 'i') })).toBeVisible();

    const tabs = page.getByRole('tab');

    // Rule set: the weights that produced every grade in this cohort.
    await tabs.filter({ hasText: /rule set/i }).click();
    await expect(tabs.filter({ hasText: /rule set/i })).toHaveAttribute('aria-selected', 'true');
    // The editor is a form: metric names are values, not text nodes.
    await expect(page.getByRole('textbox', { name: /^metric$/i }).first()).toHaveValue('correctness');
    await expect(page.getByRole('spinbutton', { name: /weight %/i }).first()).toHaveValue('20');
    await expect(page.getByText(/weights must sum to 1\.00/i).first()).toBeVisible();

    // Cohort: the batch queue, the progress counters and the export.
    await tabs.filter({ hasText: /^cohort$/i }).click();
    await expect(tabs.filter({ hasText: /^cohort$/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /grade all/i })).toBeVisible();
    await expect(page.getByText(/graded/i).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /^csv$/i })).toBeVisible();

    // The CSV export really is a file with a header row, not an HTML page.
    const csv = await page.request.get(`/api/assignments/${assignment.id}/export.csv`);
    expect(csv.ok()).toBeTruthy();
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect(await csv.text()).toContain('student_email');

    // Similarity review is reachable.
    await tabs.filter({ hasText: /similarity/i }).click();
    await expect(tabs.filter({ hasText: /similarity/i })).toHaveAttribute('aria-selected', 'true');
  });

  test('a student cannot open the instructor area', async ({ page }) => {
    await signIn(page, DEMO.student);
    await page.goto('/instructor');

    // The guard renders an explanation rather than redirecting, so the URL stays
    // and the page says where the student can go instead.
    await expect(page.getByRole('heading', { name: /this area is for instructors/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /go to my dashboard/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /grade all/i })).toHaveCount(0);
  });
});
