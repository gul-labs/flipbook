import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  expect: {
    toHaveScreenshot: {
      // Per-project baselines already absorb Chromium vs WebKit. This budget
      // is for subpixel / antialias / shadow-gradient drift across OS and GPU;
      // a slide-in or translucent fold moves far more than 5% of the book pixels.
      maxDiffPixelRatio: 0.05,
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    // Do not globally disable animations: golden mid-flip frames need the
    // engine's rAF turn. Individual toHaveScreenshot calls freeze the loop.
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    // The example typechecks against the core package's built `dist`, so the
    // packages must be built here: the CI e2e job runs on a fresh runner and
    // does not inherit the `verify` job's build output. Vanilla is :4173;
    // the live-HTML fixture is :4174 (`scripts/serve-e2e.mjs`).
    command:
      'pnpm build && pnpm --filter example-vanilla build && pnpm --filter example-mobile-reader build && node ./scripts/serve-e2e.mjs',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
