import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Loaded by `ng test` through `runnerConfig` in angular.json. The Angular CLI owns test discovery, so this file
// only adds the real backend harness for SDK contract tests (spec 0009, AC-4).
export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(new URL('./vitest-backend.setup.ts', import.meta.url))],
  },
});
