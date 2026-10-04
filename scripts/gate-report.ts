import { resolve } from 'node:path';
import { runReport } from './lib/gate-report.ts';

// `bun run test:report` (spec 0010, AC-6): `bun --no-env-file scripts/gate-report.ts` reads the tier bundles under
// `.local/feature-11/evidence/`, writes `.local/feature-11/report.json` and `report.md`, and exits 0 only for gate
// `passed`; `failed` and `incomplete` exit 1.

try {
  process.exitCode = await runReport(resolve(import.meta.dir, '..'));
} catch {
  process.stderr.write('Laporan gate tidak dapat disusun\n');
  process.exitCode = 1;
}
