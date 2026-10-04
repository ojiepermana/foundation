import { resolve } from 'node:path';
import { runScenarioValidation } from './lib/scenario-registry.ts';

// `bun run test:scenarios` (spec 0010, AC-2): `bun --no-env-file scripts/validate-scenarios.ts` validates every
// `tests/scenarios/*.json` before the suites run and prints every violation at once, one per line, with the registry
// path and the scenario ID. Registries never hold results; status comes only from runner evidence in the gate report.

if (import.meta.main) {
  try {
    process.exitCode = await runScenarioValidation(resolve(import.meta.dir, '..'));
  } catch {
    process.stderr.write('Registry skenario tidak dapat divalidasi\n');
    process.exitCode = 1;
  }
}
