import { defineConfig, devices } from '@playwright/test';

/**
 * Day 25: two role journeys, run against a live stack.
 *
 * The suite is deliberately not started by Playwright's `webServer` option: the
 * database, the API and the sandbox key all have to be up before the browser is
 * useful, and a config that silently starts half the app produces a confusing
 * failure. Start the two servers yourself (see e2e/README.md), then:
 *
 *   E2E_BASE_URL=http://127.0.0.1:5173 npm test
 *
 * A deployed preview works the same way - point E2E_BASE_URL at it.
 */
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 25_000 },
  // Grading spends a shared provider budget, so the journeys run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
});
