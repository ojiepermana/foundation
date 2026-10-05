import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/*.e2e.spec.ts', testIgnore: ['**/*.real.e2e.spec.ts', '**/*.deployment.e2e.spec.ts'], fullyParallel: false, retries: 0,
  reporter: [['list'], ['junit', { outputFile: '.local/feature-4/playwright.xml' }]],
  use: { baseURL: 'http://127.0.0.1:8889', trace: 'retain-on-failure', screenshot: 'on' },
  projects: [{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer: [
    {command:'bun --no-env-file apps/backend/src/index.ts',url:'http://127.0.0.1:8888/api/status',reuseExistingServer:false,env:{NODE_ENV:'development',HOST:'127.0.0.1',PORT:'8888',DATABASE_URL:''},timeout:30000},
    {command:'bun run dev:frontend',url:'http://127.0.0.1:8889',reuseExistingServer:false,timeout:60000},
  ],
});
