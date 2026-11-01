import { expect, test } from '@playwright/test';
import { CORRECT_SOURCE_PATH, DEMO, assignmentsOf, firstCourse, signIn } from './support.js';

/**
 * Day 25: the student journey, end to end.
 *
 * Sign in -> open the assignment -> upload a real .c file -> submit -> wait for
 * grading -> open the report. The report assertions are the ones that matter: a
 * grade, the metric table, and the hash a reproducibility claim depends on.
 */
test.describe('student journey', () => {
  test('submits a C file and reads the report', async ({ page }) => {
    await signIn(page, DEMO.student);

    const course = await firstCourse(page, 'STUDENT');
    const assignments = await assignmentsOf(page, course.id);
    const assignment = assignments.find((item) => /sum of two integers/i.test(item.title)) ?? assignments[0];
    expect(assignment, 'the seeded course has no assignment').toBeTruthy();

    await page.goto(`/student/assignments/${assignment.id}`);
    await expect(page.getByRole('heading', { name: new RegExp(assignment.title, 'i') })).toBeVisible();

    // The file input is hidden behind a styled button; feeding it directly is what
    // the upload path sees, and it keeps the test independent of CodeMirror.
    await page.setInputFiles('input[type="file"]', CORRECT_SOURCE_PATH);
    await expect(page.getByRole('textbox', { name: /file name/i })).toHaveValue(/01-correct\.c/i);

    const submit = page.getByRole('button', { name: /submit and grade/i });
    await expect(submit).toBeEnabled();
    await submit.click();

    // Either grading runs now and the report link appears, or the instructor holds
    // reports back - both are successful submissions, and how fast they differ is
    // the point of the queue.
    const ready = page.getByText(/report ready/i).first();
    // One locator for both outcomes: `.or()` on two `.first()` locators resolves
    // to both elements and trips strict mode.
    await expect(page.getByText(/report ready|once your instructor releases it/i).first()).toBeVisible({
      timeout: 180_000,
    });

    const openReport = page.getByRole('link', { name: /open the report/i }).first();
    if (await openReport.count()) {
      await openReport.click();
      await expect(page).toHaveURL(/\/student\/submissions\//);
      await expect(page.getByRole('heading', { name: /\/ 100/ }).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('table').first()).toBeVisible();
      await expect(page.getByText(/report_hash/i).first()).toBeVisible();

      // The text report downloads as plain text, not as a rendered page.
      const id = new URL(page.url()).pathname.split('/').pop();
      const text = await page.request.get(`/api/submissions/${id}/report.txt`);
      expect(text.ok()).toBeTruthy();
      expect(text.headers()['content-type']).toContain('text/plain');
      const body = await text.text();
      expect(body.length).toBeGreaterThan(80);
      expect(body).toMatch(/grade|\/ 100/i);
    } else {
      // A released-later cohort is still a correct journey; say so instead of
      // pretending the report was checked.
      test.info().annotations.push({ type: 'withheld', description: 'this cohort releases reports manually' });
    }
  });
});
