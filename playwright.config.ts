import { defineConfig } from '@playwright/test'

/**
 * Each test gets its own server process and its own SQLite file — see e2e/fixtures.ts.
 * There is no `webServer` block here on purpose: a shared server would mean tests
 * share a database, and this app's data is append-only with no delete API, so one
 * test's completions would leak into the next one's grid.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    // Drives the locally installed Google Chrome. Playwright's own browser builds
    // are not downloaded, so this needs no network.
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Mobile first — this is ticked throughout the day on a phone.
    // Plain viewports rather than device presets: the presets carry a
    // defaultBrowserType (iPhone => webkit) that collides with channel 'chrome'.
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
  ],
})
