import { checkFrontendBundle, FrontendBundleError } from './lib/frontend-bundle';

// Failures print one fixed line to stderr and exit 1, never a stack, source excerpt, or runtime version (spec 0009, AC-3).
let failure: string | undefined;

try {
  await checkFrontendBundle({
    applicationSource: 'apps/frontend/src',
    outputDirectory: 'apps/frontend/dist',
    environment: Bun.env,
  });
} catch (error) {
  failure = error instanceof FrontendBundleError ? error.message : 'Frontend bundle check failed.';
}

if (failure === undefined) {
  console.log('Frontend imports and production browser assets passed the security scan.');
} else {
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
}
