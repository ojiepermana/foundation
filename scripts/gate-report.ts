import { resolve } from 'node:path';
import { runCapacityReport, runReleaseReport, runReport } from './lib/gate-report.ts';

// `bun run test:report` (spec 0010, AC-6): `bun --no-env-file scripts/gate-report.ts` reads the tier bundles under
// `.local/feature-11/evidence/`, writes `.local/feature-11/report.json` and `report.md`, and exits 0 only for gate
// `passed`; `failed` and `incomplete` exit 1. `bun run test:report:capacity` (spec 0011) is the same script with the
// argument `capacity`: it reads only the capacity bundle and writes `.local/feature-12/report.json` and `report.md`.
// `bun run test:report:release` (spec 0012, AC-12) passes `release`: it reads the four bundles, writes only
// `.local/feature-13/release.json` and `release.md`, and exits 0 only for status `ready`.

const args = process.argv.slice(2);
const mode = args.length === 0 ? 'gate' : args.length === 1 && (args[0] === 'capacity' || args[0] === 'release') ? args[0] : null;
const failure = { gate: 'Laporan gate tidak dapat disusun', capacity: 'Laporan kapasitas tidak dapat disusun', release: 'Status release tidak dapat disusun' };
if (mode === null) {
  process.stderr.write('Pemakaian: bun --no-env-file scripts/gate-report.ts [capacity|release]\n');
  process.exitCode = 1;
} else {
  try {
    const root = resolve(import.meta.dir, '..');
    process.exitCode = mode === 'capacity' ? await runCapacityReport(root) : mode === 'release' ? await runReleaseReport(root) : await runReport(root);
  } catch {
    process.stderr.write(`${failure[mode]}\n`);
    process.exitCode = 1;
  }
}
