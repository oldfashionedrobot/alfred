import { defineConfig } from '@playwright/test'

/**
 * Each test gets its own server process and its own SQLite file — see e2e/fixtures.ts.
 * There is no `webServer` block here on purpose: a shared server would mean tests
 * share a database, and this app's data is append-only with no delete API, so one
 * test's completions would leak into the next one's grid.
 */
const MOBILE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 900 }

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry in CI only. A retried pass is reported as *flaky* rather than as
  // passed, so a real race still surfaces — but a single blip does not block a
  // deploy. Locally 0, where a flake is worth stopping for.
  retries: process.env.CI ? 1 : 0,
  workers: 4,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  /*
   * Four projects: two engines, two viewports.
   *
   * `channel` lives on the Chrome projects rather than in `use`, because WebKit
   * inherits anything there and cannot take it. That single line was the only
   * thing that had made a second config file look necessary.
   *
   * Plain viewports rather than device presets: the presets carry a
   * `defaultBrowserType` (iPhone => webkit) that would fight the channel.
   *
   * WEBKIT IS NOT iOS SAFARI. It is the same engine at a mobile viewport, which
   * catches engine differences — anchor positioning, popover support, layout —
   * and cannot catch what iOS draws itself. The date picker bug this project
   * shipped lived in exactly that gap. See `.plan/changes-v11.md`.
   */
  projects: [
    // Mobile first — this is ticked throughout the day on a phone.
    {
      name: 'mobile',
      // The locally installed Google Chrome, so Chrome needs no browser download.
      use: { channel: 'chrome', viewport: MOBILE, isMobile: true, hasTouch: true },
    },
    { name: 'desktop', use: { channel: 'chrome', viewport: DESKTOP } },
    {
      name: 'mobile-webkit',
      use: { browserName: 'webkit', viewport: MOBILE, isMobile: true, hasTouch: true },
    },
    { name: 'desktop-webkit', use: { browserName: 'webkit', viewport: DESKTOP } },
  ],
})
