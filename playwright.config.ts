import { defineConfig, devices } from '@playwright/test';

process.env['E2E_BASE_URL'] = 'http://localhost:8090';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8090',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'bun scripts/test-stack.ts',
      url: 'http://127.0.0.1:8890/api/health/ready',
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'bun run ng serve web --port 8090 --host localhost --proxy-config apps/web/proxy.e2e.json',
      url: 'http://localhost:8090',
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
