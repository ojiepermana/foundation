import { defineConfig, devices } from '@playwright/test';

// DEP-006 (spec 0012, *Config Playwright*): the production browser flow through the edge of the deployment topology
// that `test:deployment:real` starts beforehand, so there is no webServer. The orchestration passes the edge URL in
// FOUNDATION_DEPLOY_EDGE_URL; the spec fails with a fixed message without it. The certificate comes from a temporary CA
// of the run, so the browser ignores certificate errors; the HTTP checks of the orchestration verify it with that CA.
// Trace and video stay off, so every artifact in outputDir can be scanned byte for byte.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.deployment.e2e.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['junit', { outputFile: '.local/feature-13/playwright-deployment.xml' }]],
  outputDir: '.local/feature-13/test-results',
  use: {
    baseURL: process.env['FOUNDATION_DEPLOY_EDGE_URL'] ?? 'https://localhost:8443',
    ignoreHTTPSErrors: true,
    trace: 'off',
    video: 'off',
    screenshot: 'on',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
