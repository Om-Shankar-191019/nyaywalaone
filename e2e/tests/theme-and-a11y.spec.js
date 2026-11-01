import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { DEMO, signIn } from './support.js';

/**
 * Day 25: theme QA and accessibility.
 *
 * The theme test is the one the plan asks for: the choice survives a hard
 * reload because the inline script in index.html sets the class before the
 * first paint. It is checked by reading `documentElement`, not by looking at a
 * screenshot - a colour that is wrong in one page is a visual review, an `html`
 * class that survives a reload is a behaviour.
 */
test.describe('theme', () => {
  for (const theme of ['light', 'dark']) {
    test(`the ${theme} theme survives a hard reload`, async ({ page }) => {
      await page.goto('/login');
      await page.evaluate((value) => window.localStorage.setItem('nyaywala-theme', value), theme);
      await page.reload();

      const classList = await page.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        colorScheme: document.documentElement.style.colorScheme,
      }));

      expect(classList.dark).toBe(theme === 'dark');
      expect(classList.colorScheme).toBe(theme);
    });
  }
});

test.describe('accessibility', () => {
  test('the public sign-in page has no critical violations', async ({ page }) => {
    await page.goto('/login');
    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((violation) => violation.impact === 'critical');
    expect(critical.map((violation) => violation.id)).toEqual([]);
  });

  test('the student dashboard has no critical violations', async ({ page }) => {
    await signIn(page, DEMO.student);
    await page.goto('/student');
    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((violation) => violation.impact === 'critical');
    expect(critical.map((violation) => violation.id)).toEqual([]);
  });

  test('the page is usable at 360 px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await signIn(page, DEMO.student);
    // Nothing may push the document wider than the viewport except a labelled
    // scroll region, which is why `overflow-x-auto` panels are allowed.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    await expect(page.getByRole('main').or(page.getByRole('navigation')).first()).toBeVisible();
  });
});
