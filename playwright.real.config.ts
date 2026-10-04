import { defineConfig, devices } from '@playwright/test';

// READY-009 (spec 0006, *Konfigurasi `playwright.real.config.ts`*): the real browser flow against a frontend, backend,
// and isolated PostgreSQL 18 that `test:readiness:real` (or feature 2 with `serve`) starts beforehand, so there is no
// webServer. Trace and video stay off, so every artifact in outputDir can be scanned byte for byte for credentials.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.real.e2e.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120000,
  reporter: [['list'], ['junit', { outputFile: '.local/feature-10/playwright-real.xml' }]],
  outputDir: '.local/feature-10/test-results',
  use: { baseURL: 'http://127.0.0.1:8889', trace: 'off', video: 'off', screenshot: 'on' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
