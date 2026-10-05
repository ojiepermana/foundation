import { resolve } from 'node:path';
import { CAPACITY_TIER_NAME, runTier, tierByName, TIERS } from './lib/gate.ts';

// `bun run test:ci` (spec 0010, AC-4): `bun --no-env-file scripts/gate.ts <tier>` runs the steps of one tier from the
// tier table, writes its evidence bundle with the manifest, and exits 0 only when the tier passed. Spec 0011 adds the
// manual capacity tier: `bun run test:ci:capacity` is `scripts/gate.ts capacity`, outside the per push gate.

const name = process.argv[2] ?? '';
const tier = tierByName(name);
if (tier === undefined || process.argv.length !== 3) {
  process.stderr.write(`Pemakaian: bun --no-env-file scripts/gate.ts <${[...Object.keys(TIERS), CAPACITY_TIER_NAME].join('|')}>\n`);
  process.exitCode = 1;
} else {
  process.exitCode = await runTier({ root: resolve(import.meta.dir, '..'), tier });
}
