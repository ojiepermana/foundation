import { sleep } from 'k6';
import { parseRunEnv, type RunData } from './plan.ts';

// k6 run lifecycle of spec 0011 (*Bentuk profil dan variable run*): `setupRun()` is the only place that reads `__ENV`,
// so module level code and `k6 inspect` need no variable; `writeSummary()` writes the `handleSummary` data as it is to
// the output folder the orchestration mounts.

/** Reads and checks T0 and the migration count, waits until T0, then returns the setup data. */
export function setupRun(): RunData {
  const parsed = parseRunEnv({
    FOUNDATION_PERF_T0: __ENV.FOUNDATION_PERF_T0,
    FOUNDATION_PERF_EXPECTED_MIGRATIONS: __ENV.FOUNDATION_PERF_EXPECTED_MIGRATIONS,
  });
  if (!parsed.ok) throw new Error(`Invalid run variable ${parsed.invalid}`);
  for (let remaining = parsed.t0 - Date.now(); remaining > 0; remaining = parsed.t0 - Date.now()) sleep(remaining / 1000);
  return { startedAt: Date.now(), t0: parsed.t0, expectedMigrations: parsed.expectedMigrations };
}

export function writeSummary(data: unknown): Record<string, string> {
  return { '/out/summary.json': JSON.stringify(data), stdout: 'k6 summary written to /out/summary.json\n' };
}
