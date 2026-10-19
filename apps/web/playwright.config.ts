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
  expect: {
    toHaveScreenshot: {
      // Ignore anti-aliasing differences between platforms
      threshold: 0.2,
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
