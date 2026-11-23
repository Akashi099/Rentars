import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // Visual regression snapshots are stored adjacent to each spec file so that
  // baselines are versioned in Git alongside the tests that reference them.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  // Tolerances for snapshot comparisons — overridden per-test where needed.
  // Material layout regressions (clipped controls, shifted breakpoints) must
  // fail the run, so the pixel-diff budget is intentionally tight.
  expect: {
    toHaveScreenshot: {
      // Ignore anti-aliasing differences between platforms
      threshold: 0.2,
      // Fail on any material layout change rather than only large ones
      maxDiffPixelRatio: 0.01,
      // Stabilise animations before capturing
      animations: 'disabled',
      caret: 'hide',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    // Mobile viewports for responsive testing
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    // Documented responsive breakpoints used by the visual regression suite.
    // Each project pins a viewport so snapshots are captured at the exact
    // widths documented for property detail, search, booking and host
    // listing pages.
    {
      name: 'responsive-narrow',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'responsive-medium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 1024 },
        hasTouch: true,
      },
    },
    {
      name: 'responsive-wide',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: process.env.CI ? 'yarn start' : 'yarn dev',
    url: 'http://localhost:3001',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: '3001',
    },
  },
});
