import { resolve } from 'node:path';
import { runCapacityReport, runReport } from './lib/gate-report.ts';

// `bun run test:report` (spec 0010, AC-6): `bun --no-env-file scripts/gate-report.ts` reads the tier bundles under
// `.local/feature-11/evidence/`, writes `.local/feature-11/report.json` and `report.md`, and exits 0 only for gate
// `passed`; `failed` and `incomplete` exit 1. `bun run test:report:capacity` (spec 0011) is the same script with the
// argument `capacity`: it reads only the capacity bundle and writes `.local/feature-12/report.json` and `report.md`.

const args = process.argv.slice(2);
const capacity = args.length === 1 && args[0] === 'capacity';
if (args.length > 0 && !capacity) {
  process.stderr.write('Pemakaian: bun --no-env-file scripts/gate-report.ts [capacity]\n');
  process.exitCode = 1;
} else {
  try {
    const root = resolve(import.meta.dir, '..');
    process.exitCode = capacity ? await runCapacityReport(root) : await runReport(root);
  } catch {
    process.stderr.write(capacity ? 'Laporan kapasitas tidak dapat disusun\n' : 'Laporan gate tidak dapat disusun\n');
    process.exitCode = 1;
  }
}
