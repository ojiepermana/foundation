import { checkFrontendBundle } from './lib/frontend-bundle';

await checkFrontendBundle({
  applicationSource: 'apps/frontend/src/app',
  outputDirectory: 'apps/frontend/dist',
  environment: Bun.env,
});

console.log('Frontend imports and production browser assets passed the security scan.');
