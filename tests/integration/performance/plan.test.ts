import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import {
  allowedReadinessStatuses,
  checkName,
  classify,
  k6ExitReason,
  metricUpdates,
  RECOVERY_FROM_MS,
  recoveryValue,
} from '../../performance/helpers/expectations.ts';
import {
  BASE_URL,
  iterationFloor,
  LOADS,
  optionsFor,
  OUTAGE_START_MS,
  OUTAGE_STOP_MS,
  parseRunEnv,
  phaseAt,
  phaseWindows,
  plannedScenarios,
  PROFILE_NAMES,
  profileSeconds,
  REQUEST_TIMEOUT,
  requestPhase,
  scenarioVUs,
  T0_DELAY_MS,
  VU_HEADROOM_MS,
  type ProfileName,
  type RunData,
} from '../../performance/helpers/plan.ts';
import {
  BACKEND_POOL,
  backendReady,
  backendRunArgs,
  backendStateArgs,
  buildObservationFile,
  buildResult,
  CONTAINER_LIMITS,
  containerUser,
  containsSecret,
  coverageFailures,
  durationMs,
  environmentTooSmall,
  evidenceLimits,
  EXPECTED_BACKEND_STDOUT,
  findEnvFile,
  guardInspectArgs,
  guardLabelsAccepted,
  guardNameAccepted,
  hostEnvironment,
  inspectMatches,
  inspectRunArgs,
  k6CreateArgs,
  memoryGrowthMiB,
  networkCreateArgs,
  normalizeInspect,
  OBSERVATION_LIMITS,
  OUTAGE_GUARD_LEAD_MS,
  observationChecks,
  observationReasons,
  observationSummary,
  observedPhases,
  otherTestContainers,
  outageControlArgs,
  outageControlFailures,
  parseBackendState,
  parseEngineSize,
  parseMemoryMiB,
  parsePercent,
  parsePoolRow,
  PERFORMANCE_REASON_CODES,
  plannedOutage,
  POOL_QUERY,
  postgresRunArgs,
  profilePhaseNames,
  readSummary,
  reason,
  redactor,
  resourceMissing,
  resourceNames,
  runHex,
  runLabelArgs,
  runnableProfile,
  runOutageControl,
  SETUP_STEPS,
  statsArgs,
  statsCollector,
  stripControl,
  summaryReasons,
  TIMEOUTS,
  validateImagePins,
  worstCaseCleanupMs,
  type ContainerContext,
  type ContainerSample,
  type ObservationInput,
  type ObservedPhase,
  type OutageTiming,
  type PoolSample,
} from '../../orchestration/performance-real.ts';
import { removeWorkspaces, workspace } from '../gate/workspace.ts';

// PERF-001 (spec 0011, AC-1 to AC-8 and AC-10), without Docker: the profile plan of the six profiles, classification,
// metrics, recovery, the k6 exit, the k6 script import rule, the inspect comparison against real `k6 inspect` output,
// the image pins, the container arguments, the `.env` walk, the container engine size, the guard, the outage control,
// the `result.json` shape, and redaction. The real k6 fixtures in `fixtures/` were captured from k6 2.3.0: the smoke
// inspect output and the summaries in step 1 of the Build plan, the inspect output of the five other profiles in step 4,
// and the inspect output of all six profiles again after the Ambang beban aktual decision of 2026-10-04 (smoke, stress,
// and spike changed only in their actual load floors). Every other fixture is written at runtime in a `mkdtemp` folder.

afterEach(removeWorkspaces);

const root = resolve(import.meta.dir, '../../..');
const fixtures = join(import.meta.dir, 'fixtures');
const readFixture = async (name: string) => JSON.parse(await readFile(join(fixtures, name), 'utf8')) as Record<string, unknown>;
const k6Image = 'grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34';
const bunImage = 'oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61';
const hex = '0123456789ab';

// ---------------------------------------------------------------------------------------------------------------
// Profile plan (`plan.ts`).

test('PERF-001 the load model and constants follow Model beban and Value sourcing', () => {
  // covers: AC-1 (Model beban), AC-7 (jadwal outage)
  expect(LOADS).toEqual({ S0: { status: 100, readiness: 10 }, N: { status: 1000, readiness: 50 }, O: { status: 4000, readiness: 1000 } });
  expect(PROFILE_NAMES).toEqual(['smoke', 'load', 'stress', 'spike', 'outage', 'soak']);
  expect(BASE_URL).toBe('http://127.0.0.1:8888');
  expect(T0_DELAY_MS).toBe(15_000);
  expect([OUTAGE_STOP_MS, OUTAGE_START_MS]).toEqual([90_000, 150_000]);
  expect(RECOVERY_FROM_MS).toBe(OUTAGE_START_MS);
  expect(PROFILE_NAMES.map((profile) => [profile, profileSeconds(profile)])).toEqual([
    ['smoke', 40], ['load', 660], ['stress', 730], ['spike', 440], ['outage', 220], ['soak', 3_660],
  ]);
});

test('PERF-001 optionsFor(smoke) is exactly Rencana fase and Thresholds for the smoke profile', () => {
  // covers: AC-1 (scenario, exec, executor, laju, VUs), AC-4 (setiap key dan ekspresi threshold)
  const common = { timeUnit: '1s', preAllocatedVUs: 10, maxVUs: 10, gracefulStop: '6s' };
  const abort = { threshold: 'count==0', abortOnFail: true, delayAbortEval: '5s' };
  expect(optionsFor('smoke')).toEqual({
    scenarios: {
      status_warmup: { executor: 'constant-arrival-rate', exec: 'status', rate: 100, duration: '10s', ...common },
      readiness_warmup: { executor: 'constant-arrival-rate', exec: 'readiness', rate: 10, duration: '10s', ...common },
      status_steady: { executor: 'constant-arrival-rate', exec: 'status', rate: 100, duration: '30s', startTime: '10s', ...common },
      readiness_steady: { executor: 'constant-arrival-rate', exec: 'readiness', rate: 10, duration: '30s', startTime: '10s', ...common },
    },
    thresholds: {
      unexpected_responses: [abort],
      dropped_iterations: [abort],
      checks: ['rate==1'],
      // Ambang beban aktual: planned iterations minus the 10 VUs of each S0 scenario, below 99.9 percent of the plan.
      'iterations{scenario:status_warmup}': ['count>=990'],
      'iterations{scenario:readiness_warmup}': ['count>=90'],
      'iterations{scenario:status_steady}': ['count>=2990'],
      'iterations{scenario:readiness_steady}': ['count>=290'],
      'http_req_duration{endpoint:status,phase:warmup}': ['max>=0'],
      'readiness_available_duration{phase:warmup}': ['max>=0'],
      'readiness_busy_duration{phase:warmup}': ['max>=0'],
      'readiness_unavailable_duration{phase:warmup}': ['max>=0'],
      'http_req_duration{endpoint:status,phase:steady}': ['p(95)<10', 'p(99)<25'],
      'readiness_available_duration{phase:steady}': ['p(95)<25', 'p(99)<50'],
      'readiness_busy_duration{phase:steady}': ['max>=0'],
      'readiness_unavailable_duration{phase:steady}': ['max>=0'],
      'readiness_available{phase:steady}': ['rate>=0.98'],
    },
    setupTimeout: '60s',
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)', 'count'],
    discardResponseBodies: false,
  });
  // Every status_* scenario runs `status`, every readiness_* scenario runs `readiness`, on every profile.
  for (const profile of PROFILE_NAMES) {
    for (const [name, scenario] of Object.entries(optionsFor(profile).scenarios)) expect(scenario.exec, `${profile} ${name}`).toBe(name.split('_')[0] as 'status');
  }
  // The allow list of the orchestration argument is exactly the six names.
  for (const profile of PROFILE_NAMES) expect(runnableProfile(profile), profile).toBe(true);
  for (const value of ['..', '../x', 'nope', '', undefined, 'toString', 'Load', 'breakpoint', 'smoke ']) expect(runnableProfile(value), String(value)).toBe(false);
});

// Expected scenarios and thresholds written out from the tables of spec 0011, independent of `optionsFor`.
const fixed = { timeUnit: '1s', gracefulStop: '6s' };
const at = (start: number) => (start > 0 ? { startTime: `${start}s` } : {});
const constant = (exec: 'status' | 'readiness', rate: number, seconds: number, start: number, vus: readonly [number, number]) => ({
  executor: 'constant-arrival-rate' as const, exec, rate, duration: `${seconds}s`, ...at(start), ...fixed, preAllocatedVUs: vus[0], maxVUs: vus[1],
});
const ramp = (exec: 'status' | 'readiness', from: number, to: number, seconds: number, start: number, vus: readonly [number, number]) => ({
  executor: 'ramping-arrival-rate' as const, exec, startRate: from, stages: [{ target: to, duration: `${seconds}s` }], ...at(start), ...fixed, preAllocatedVUs: vus[0], maxVUs: vus[1],
});
/** VUs of the table in *Alokasi VU* (`preAllocatedVUs`, `maxVUs`): N status 1000, N readiness 50, O status 4000, O readiness 1000. */
const VU = { nStatus: [100, 100], nReadiness: [10, 10], oStatus: [400, 400], oReadiness: [100, 100] } as const satisfies Record<string, readonly [number, number]>;
const umum = {
  unexpected_responses: [{ threshold: 'count==0', abortOnFail: true, delayAbortEval: '5s' }],
  dropped_iterations: [{ threshold: 'count==0', abortOnFail: true, delayAbortEval: '5s' }],
  checks: ['rate==1'],
};
const iterations = (scenario: string, expression: string) => ({ [`iterations{scenario:${scenario}}`]: [expression] });
const keys = (phase: string) => ({
  status: `http_req_duration{endpoint:status,phase:${phase}}`,
  available: `readiness_available_duration{phase:${phase}}`,
  busy: `readiness_busy_duration{phase:${phase}}`,
  unavailable: `readiness_unavailable_duration{phase:${phase}}`,
});
/** Pencatatan only: the four keys with `max>=0`. */
const recorded = (phase: string) => {
  const key = keys(phase);
  return { [key.status]: ['max>=0'], [key.available]: ['max>=0'], [key.busy]: ['max>=0'], [key.unavailable]: ['max>=0'] };
};
/** Target normal N(P), with Pencatatan on the keys without a target. */
const normal = (phase: string) => {
  const key = keys(phase);
  return {
    [key.status]: ['p(95)<10', 'p(99)<25'], [key.available]: ['p(95)<25', 'p(99)<50'], [key.busy]: ['max>=0'], [key.unavailable]: ['max>=0'],
    [`readiness_available{phase:${phase}}`]: ['rate>=0.98'],
  };
};
/** Target beban lebih O(P). */
const overload = (phase: string) => {
  const key = keys(phase);
  return {
    [key.status]: ['p(95)<10', 'p(99)<25'], [key.available]: ['p(95)<25', 'p(99)<50'], [key.busy]: ['p(95)<10'], [key.unavailable]: ['max>=0'],
    [`readiness_available{phase:${phase}}`]: ['rate>=0.20'],
  };
};
/** Target outage. */
const outageTarget = (phase: string) => {
  const key = keys(phase);
  return { [key.status]: ['p(95)<10', 'p(99)<25'], [key.available]: ['max>=0'], [key.busy]: ['max>=0'], [key.unavailable]: ['max<5500'] };
};
const summaryOptions = { setupTimeout: '60s', summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)', 'count'], discardResponseBodies: false };

test('PERF-001 optionsFor of load, stress, spike, outage, and soak is exactly Rencana fase and Thresholds', () => {
  // covers: AC-1 (fase, bentuk, laju, durasi, startTime, VUs, exec), AC-4 (Umum, Beban aktual, target N, O, outage, dan Pencatatan), AC-7 (outage), AC-8 (stress dan spike)
  expect(optionsFor('load')).toEqual({
    scenarios: {
      status_warmup: ramp('status', 0, 1_000, 60, 0, VU.nStatus),
      readiness_warmup: ramp('readiness', 0, 50, 60, 0, VU.nReadiness),
      status_steady: constant('status', 1_000, 600, 60, VU.nStatus),
      readiness_steady: constant('readiness', 50, 600, 60, VU.nReadiness),
    },
    thresholds: {
      ...umum,
      ...iterations('status_warmup', 'count>=0'), ...iterations('readiness_warmup', 'count>=0'),
      ...iterations('status_steady', 'count>=599400'), ...iterations('readiness_steady', 'count>=29970'),
      ...recorded('warmup'), ...normal('steady'),
    },
    ...summaryOptions,
  });
  expect(optionsFor('stress')).toEqual({
    scenarios: {
      status_warmup: ramp('status', 0, 1_000, 60, 0, VU.nStatus),
      readiness_warmup: ramp('readiness', 0, 50, 60, 0, VU.nReadiness),
      status_ramp: ramp('status', 1_000, 4_000, 120, 60, VU.oStatus),
      readiness_ramp: ramp('readiness', 50, 1_000, 120, 60, VU.oReadiness),
      status_hold: constant('status', 4_000, 300, 180, VU.oStatus),
      readiness_hold: constant('readiness', 1_000, 300, 180, VU.oReadiness),
      status_rampdown: ramp('status', 4_000, 1_000, 60, 480, VU.oStatus),
      readiness_rampdown: ramp('readiness', 1_000, 50, 60, 480, VU.oReadiness),
      status_settle: constant('status', 1_000, 10, 540, VU.nStatus),
      readiness_settle: constant('readiness', 50, 10, 540, VU.nReadiness),
      status_recover: constant('status', 1_000, 180, 550, VU.nStatus),
      readiness_recover: constant('readiness', 50, 180, 550, VU.nReadiness),
    },
    thresholds: {
      ...umum,
      ...iterations('status_warmup', 'count>=0'), ...iterations('readiness_warmup', 'count>=0'),
      ...iterations('status_ramp', 'count>=0'), ...iterations('readiness_ramp', 'count>=0'),
      ...iterations('status_hold', 'count>=1198800'), ...iterations('readiness_hold', 'count>=299700'),
      ...iterations('status_rampdown', 'count>=0'), ...iterations('readiness_rampdown', 'count>=0'),
      ...iterations('status_settle', 'count>=9900'), ...iterations('readiness_settle', 'count>=490'),
      ...iterations('status_recover', 'count>=179820'), ...iterations('readiness_recover', 'count>=8990'),
      ...recorded('warmup'), ...recorded('ramp'), ...overload('hold'), ...recorded('rampdown'), ...recorded('settle'), ...normal('recover'),
    },
    ...summaryOptions,
  });
  expect(optionsFor('spike')).toEqual({
    scenarios: {
      status_warmup: ramp('status', 0, 1_000, 60, 0, VU.nStatus),
      readiness_warmup: ramp('readiness', 0, 50, 60, 0, VU.nReadiness),
      status_before: constant('status', 1_000, 120, 60, VU.nStatus),
      readiness_before: constant('readiness', 50, 120, 60, VU.nReadiness),
      status_rise: ramp('status', 1_000, 4_000, 5, 180, VU.oStatus),
      readiness_rise: ramp('readiness', 50, 1_000, 5, 180, VU.oReadiness),
      status_spike: constant('status', 4_000, 60, 185, VU.oStatus),
      readiness_spike: constant('readiness', 1_000, 60, 185, VU.oReadiness),
      status_fall: ramp('status', 4_000, 1_000, 5, 245, VU.oStatus),
      readiness_fall: ramp('readiness', 1_000, 50, 5, 245, VU.oReadiness),
      status_settle: constant('status', 1_000, 10, 250, VU.nStatus),
      readiness_settle: constant('readiness', 50, 10, 250, VU.nReadiness),
      status_after: constant('status', 1_000, 180, 260, VU.nStatus),
      readiness_after: constant('readiness', 50, 180, 260, VU.nReadiness),
    },
    thresholds: {
      ...umum,
      ...iterations('status_warmup', 'count>=0'), ...iterations('readiness_warmup', 'count>=0'),
      ...iterations('status_before', 'count>=119880'), ...iterations('readiness_before', 'count>=5990'),
      ...iterations('status_rise', 'count>=0'), ...iterations('readiness_rise', 'count>=0'),
      ...iterations('status_spike', 'count>=239600'), ...iterations('readiness_spike', 'count>=59900'),
      ...iterations('status_fall', 'count>=0'), ...iterations('readiness_fall', 'count>=0'),
      ...iterations('status_settle', 'count>=9900'), ...iterations('readiness_settle', 'count>=490'),
      ...iterations('status_after', 'count>=179820'), ...iterations('readiness_after', 'count>=8990'),
      ...recorded('warmup'), ...normal('before'), ...recorded('rise'), ...overload('spike'), ...recorded('fall'), ...recorded('settle'), ...normal('after'),
    },
    ...summaryOptions,
  });
  expect(optionsFor('outage')).toEqual({
    scenarios: {
      status_timeline: constant('status', 1_000, 220, 0, VU.nStatus),
      readiness_timeline: constant('readiness', 50, 220, 0, VU.nReadiness),
    },
    thresholds: {
      ...umum,
      ...iterations('status_timeline', 'count>=219780'), ...iterations('readiness_timeline', 'count>=10989'),
      ...recorded('warmup'), ...normal('before'), ...outageTarget('stopping'), ...outageTarget('outage'), ...outageTarget('recovering'), ...normal('after'),
      'readiness_unavailable{phase:outage}': ['count>=1'],
      readiness_recovery_ms: ['min>=0'],
    },
    ...summaryOptions,
  });
  expect(optionsFor('soak')).toEqual({
    scenarios: {
      status_warmup: ramp('status', 0, 1_000, 60, 0, VU.nStatus),
      readiness_warmup: ramp('readiness', 0, 50, 60, 0, VU.nReadiness),
      status_steady: constant('status', 1_000, 3_600, 60, VU.nStatus),
      readiness_steady: constant('readiness', 50, 3_600, 60, VU.nReadiness),
    },
    thresholds: {
      ...umum,
      ...iterations('status_warmup', 'count>=0'), ...iterations('readiness_warmup', 'count>=0'),
      ...iterations('status_steady', 'count>=3596400'), ...iterations('readiness_steady', 'count>=179820'),
      ...recorded('warmup'), ...normal('steady'),
    },
    ...summaryOptions,
  });
  // The smoke thresholds stay as they were: the outage keys exist only on outage.
  for (const profile of PROFILE_NAMES.filter((name) => name !== 'outage')) {
    expect(Object.keys(optionsFor(profile).thresholds).filter((key) => key.startsWith('readiness_recovery_ms') || key.startsWith('readiness_unavailable{')), profile).toEqual([]);
  }
});

test('PERF-001 the planned scenarios carry the rates, seconds, and planned iterations of plan.ts', () => {
  // covers: AC-1, AC-5 (laju dan iterasi rencana dari plan.ts; naik atau turun memakai rata rata laju awal dan akhir)
  expect(plannedScenarios('stress').map((item) => [item.name, item.executor, item.startRate, item.endRate, item.seconds, item.startSeconds, item.plannedIterations])).toEqual([
    ['status_warmup', 'ramping-arrival-rate', 0, 1_000, 60, 0, 30_000],
    ['readiness_warmup', 'ramping-arrival-rate', 0, 50, 60, 0, 1_500],
    ['status_ramp', 'ramping-arrival-rate', 1_000, 4_000, 120, 60, 300_000],
    ['readiness_ramp', 'ramping-arrival-rate', 50, 1_000, 120, 60, 63_000],
    ['status_hold', 'constant-arrival-rate', 4_000, 4_000, 300, 180, 1_200_000],
    ['readiness_hold', 'constant-arrival-rate', 1_000, 1_000, 300, 180, 300_000],
    ['status_rampdown', 'ramping-arrival-rate', 4_000, 1_000, 60, 480, 150_000],
    ['readiness_rampdown', 'ramping-arrival-rate', 1_000, 50, 60, 480, 31_500],
    ['status_settle', 'constant-arrival-rate', 1_000, 1_000, 10, 540, 10_000],
    ['readiness_settle', 'constant-arrival-rate', 50, 50, 10, 540, 500],
    ['status_recover', 'constant-arrival-rate', 1_000, 1_000, 180, 550, 180_000],
    ['readiness_recover', 'constant-arrival-rate', 50, 50, 180, 550, 9_000],
  ]);
  expect(plannedScenarios('outage').map((item) => [item.name, item.phase, item.startRate, item.endRate, item.seconds, item.plannedIterations])).toEqual([
    ['status_timeline', 'timeline', 1_000, 1_000, 220, 220_000],
    ['readiness_timeline', 'timeline', 50, 50, 220, 11_000],
  ]);
  expect(plannedScenarios('smoke').map((item) => [item.name, item.endpoint, item.phase, item.startRate, item.endRate, item.seconds, item.startSeconds, item.plannedIterations])).toEqual([
    ['status_warmup', 'status', 'warmup', 100, 100, 10, 0, 1000],
    ['readiness_warmup', 'readiness', 'warmup', 10, 10, 10, 0, 100],
    ['status_steady', 'status', 'steady', 100, 100, 30, 10, 3000],
    ['readiness_steady', 'readiness', 'steady', 10, 10, 30, 10, 300],
  ]);
});

test('PERF-001 VUs follow Alokasi VU and the actual load floor follows Thresholds', () => {
  // covers: AC-1 (preAllocatedVUs sama dengan maxVUs menurut Alokasi VU), AC-4 (iterations minimal 99,9 persen)
  expect(VU_HEADROOM_MS).toBe(100);
  expect([10, 50, 100, 1_000, 4_000, 1_001, 1_009, 1_010, 0].map((rate) => [rate, scenarioVUs(rate)])).toEqual([
    [10, 10], [50, 10], [100, 10], [1_000, 100], [4_000, 400], [1_001, 101], [1_009, 101], [1_010, 101], [0, 10],
  ]);
  // Every scenario of the six profiles creates all of its VUs before T0, with the VUs of the larger rate of its phase.
  for (const profile of PROFILE_NAMES) {
    const planned = new Map(plannedScenarios(profile).map((item) => [item.name, item]));
    for (const [name, scenario] of Object.entries(optionsFor(profile).scenarios)) {
      const item = planned.get(name)!;
      expect([scenario.preAllocatedVUs, scenario.maxVUs], `${profile} ${name}`).toEqual([
        scenarioVUs(Math.max(item.startRate, item.endRate)),
        scenarioVUs(Math.max(item.startRate, item.endRate)),
      ]);
    }
  }
  // Ambang beban aktual: 99.9 percent of the plan, but never more than the plan minus the VUs of the scenario.
  expect(iterationFloor(100, 10)).toBe(990);
  expect(iterationFloor(10, 10)).toBe(90);
  expect(iterationFloor(10, 30)).toBe(290);
  expect(iterationFloor(1000, 10)).toBe(9_900);
  expect(iterationFloor(50, 10)).toBe(490);
  expect(iterationFloor(50, 180)).toBe(8_990);
  expect(iterationFloor(4000, 60)).toBe(239_600);
  expect(iterationFloor(1000, 600)).toBe(599_400);
  expect(iterationFloor(50, 3600)).toBe(179_820);
  expect(iterationFloor(4000, 300)).toBe(1_198_800);
  expect(iterationFloor(10, 0.5)).toBe(0);
  for (const profile of PROFILE_NAMES) {
    for (const item of plannedScenarios(profile).filter((scenario) => scenario.executor === 'constant-arrival-rate')) {
      const floor = iterationFloor(item.endRate, item.seconds);
      // Never tighter than 99.9 percent, and the allowance is never less than the VUs: the stall a scenario absorbs in
      // its middle without a dropped iteration is absorbed at its end too.
      expect(floor, `${profile} ${item.name}`).toBeLessThanOrEqual(Math.floor((999 * item.plannedIterations) / 1000));
      expect(item.plannedIterations - floor, `${profile} ${item.name}`).toBeGreaterThanOrEqual(scenarioVUs(item.endRate));
      expect(optionsFor(profile).thresholds[`iterations{scenario:${item.name}}`], `${profile} ${item.name}`).toEqual([`count>=${floor}`]);
    }
  }
  // The first full capacity run failed on 9986 iterations of spike status_settle with no dropped iteration (14 ms of
  // arrivals at 1000 per second, a stall at the end of the scenario); that count passes now, a stall above 100 ms not.
  expect(9_986 >= iterationFloor(1000, 10)).toBe(true);
  expect(9_899 >= iterationFloor(1000, 10)).toBe(false);
});

test('PERF-001 requestPhase takes the scenario suffix, and on outage the phase at the request start time', () => {
  // covers: AC-7 (batas fase dan fase saat request dimulai)
  expect(requestPhase('smoke', 'status_steady', 0, 0)).toBe('steady');
  expect(requestPhase('stress', 'readiness_recover', 0, 0)).toBe('recover');
  // Every scenario of the profiles other than outage tags its requests with the phase of its own name.
  for (const profile of PROFILE_NAMES.filter((name) => name !== 'outage')) {
    for (const planned of plannedScenarios(profile)) expect(requestPhase(profile, planned.name, 0, 0), planned.name).toBe(planned.phase);
  }
  const t0 = 1_791_000_000_000;
  const at = (seconds: number) => requestPhase('outage', 'readiness_timeline', t0 + Math.round(seconds * 1000), t0);
  expect([at(0), at(29.999), at(30), at(87.999), at(88), at(100.999), at(101), at(144.999), at(145), at(159.999), at(160), at(219.999)]).toEqual([
    'warmup', 'warmup', 'before', 'before', 'stopping', 'stopping', 'outage', 'outage', 'recovering', 'recovering', 'after', 'after',
  ]);
  // A request is judged in the phase it started in, whenever its answer arrives.
  const started = { stopping: at(100.5), outage: at(144.5), recovering: at(149.9) };
  expect(started).toEqual({ stopping: 'stopping', outage: 'outage', recovering: 'recovering' });
  expect(classify('readiness', started.stopping, 'outage', 503, { 'Cache-Control': 'no-store' }, unavailable, 1)).toBe('unavailable');
  expect(classify('readiness', started.outage, 'outage', 503, { 'Cache-Control': 'no-store' }, unavailable, 1)).toBe('unavailable');
  expect(classify('readiness', started.recovering, 'outage', 200, { 'Cache-Control': 'no-store' }, available(1), 1)).toBe('available');
  expect(phaseAt(-5)).toBe('warmup');
  expect(phaseAt(500_000)).toBe('after');
});

test('PERF-001 parseRunEnv accepts valid run variables and refuses empty, negative, fractional, or non numeric ones', () => {
  // covers: AC-1 (variable run hanya divalidasi di setup)
  expect(parseRunEnv({ FOUNDATION_PERF_T0: '1791126764895', FOUNDATION_PERF_EXPECTED_MIGRATIONS: '1' })).toEqual({ ok: true, t0: 1_791_126_764_895, expectedMigrations: 1 });
  expect(parseRunEnv({ FOUNDATION_PERF_T0: '1', FOUNDATION_PERF_EXPECTED_MIGRATIONS: '0' })).toEqual({ ok: true, t0: 1, expectedMigrations: 0 });
  for (const t0 of [undefined, '', '0', '-1', '1.5', '1e12', 'abc', ' 1', '01', '99999999999999999999']) {
    expect(parseRunEnv({ FOUNDATION_PERF_T0: t0, FOUNDATION_PERF_EXPECTED_MIGRATIONS: '1' }), String(t0)).toEqual({ ok: false, invalid: 'FOUNDATION_PERF_T0' });
  }
  for (const migrations of [undefined, '', '-1', '1.5', 'one', '1 ', '01']) {
    expect(parseRunEnv({ FOUNDATION_PERF_T0: '1791126764895', FOUNDATION_PERF_EXPECTED_MIGRATIONS: migrations }), String(migrations)).toEqual({
      ok: false,
      invalid: 'FOUNDATION_PERF_EXPECTED_MIGRATIONS',
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Classification (`expectations.ts`).

const noStore = { 'Cache-Control': 'no-store' };
const checkedAt = '2026-10-04T15:12:44.895Z';
const available = (applied: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ status: 'available', checkedAt, appliedMigrations: applied, ...extra });
const busy = JSON.stringify({ status: 'busy' });
const unavailable = JSON.stringify({ status: 'unavailable', checkedAt });

test('PERF-001 classify follows every row of Klasifikasi respons', () => {
  // covers: AC-3
  expect(classify('status', 'steady', 'smoke', 200, {}, '{"status":"ok"}', 1)).toBe('ok');
  for (const phase of ['warmup', 'stopping', 'outage', 'recovering']) expect(classify('status', phase, 'outage', 200, {}, '{"status":"ok"}', 1), phase).toBe('ok');
  expect(classify('readiness', 'steady', 'smoke', 200, noStore, available(1), 1)).toBe('available');
  expect(classify('readiness', 'steady', 'smoke', 429, noStore, busy, 1)).toBe('busy');
  expect(classify('readiness', 'before', 'outage', 200, noStore, available(1), 1)).toBe('available');
  for (const phase of ['stopping', 'recovering']) {
    expect(classify('readiness', phase, 'outage', 200, noStore, available(1), 1), phase).toBe('available');
    expect(classify('readiness', phase, 'outage', 429, noStore, busy, 1), phase).toBe('busy');
    expect(classify('readiness', phase, 'outage', 503, noStore, unavailable, 1), phase).toBe('unavailable');
  }
  expect(classify('readiness', 'outage', 'outage', 429, noStore, busy, 1)).toBe('busy');
  expect(classify('readiness', 'outage', 'outage', 503, noStore, unavailable, 1)).toBe('unavailable');
  expect(allowedReadinessStatuses('outage', 'outage')).toEqual([429, 503]);
  expect(allowedReadinessStatuses('outage', 'stopping')).toEqual([200, 429, 503]);
  expect(allowedReadinessStatuses('smoke', 'stopping')).toEqual([200, 429]);
  // Header names are matched without case, as k6 and Bun spell them differently; the value is exact.
  expect(classify('readiness', 'steady', 'smoke', 200, { 'cache-control': 'no-store' }, available(0), 0)).toBe('available');
  expect(checkName('status')).toBe('status response matches the expected outcome');
  expect(checkName('readiness')).toBe('readiness response matches the expected outcome');
});

test('PERF-001 classify rejects extra keys, wrong migrations, bad checkedAt, missing no-store, 200 in outage, 503 outside outage, 500, and status 0', () => {
  // covers: AC-3 (kasus negatif)
  const rejected: [string, ReturnType<typeof classify>][] = [
    ['status extra key', classify('status', 'steady', 'smoke', 200, {}, '{"status":"ok","x":1}', 1)],
    ['status wrong value', classify('status', 'steady', 'smoke', 200, {}, '{"status":"busy"}', 1)],
    ['status 503', classify('status', 'steady', 'smoke', 503, {}, '{"status":"ok"}', 1)],
    ['status not JSON', classify('status', 'steady', 'smoke', 200, {}, 'ok', 1)],
    ['status array', classify('status', 'steady', 'smoke', 200, {}, '[]', 1)],
    ['readiness extra key', classify('readiness', 'steady', 'smoke', 200, noStore, available(1, { extra: true }), 1)],
    ['readiness other migrations', classify('readiness', 'steady', 'smoke', 200, noStore, available(2), 1)],
    ['readiness fractional migrations', classify('readiness', 'steady', 'smoke', 200, noStore, available(1.5), 1.5)],
    ['readiness migrations as text', classify('readiness', 'steady', 'smoke', 200, noStore, available('1'), 1)],
    ['checkedAt without Z', classify('readiness', 'steady', 'smoke', 200, noStore, JSON.stringify({ status: 'available', checkedAt: '2026-10-04T15:12:44.895+00:00', appliedMigrations: 1 }), 1)],
    ['checkedAt invalid', classify('readiness', 'steady', 'smoke', 200, noStore, JSON.stringify({ status: 'available', checkedAt: 'notZ', appliedMigrations: 1 }), 1)],
    ['without no-store', classify('readiness', 'steady', 'smoke', 200, {}, available(1), 1)],
    ['other cache value', classify('readiness', 'steady', 'smoke', 200, { 'Cache-Control': 'no-store, private' }, available(1), 1)],
    ['busy extra key', classify('readiness', 'steady', 'smoke', 429, noStore, '{"status":"busy","x":1}', 1)],
    ['busy without no-store', classify('readiness', 'steady', 'smoke', 429, {}, busy, 1)],
    // Each status needs its own status value: a valid shape with the value of another answer is still rejected.
    ['200 with status busy', classify('readiness', 'steady', 'smoke', 200, noStore, JSON.stringify({ status: 'busy', checkedAt, appliedMigrations: 1 }), 1)],
    ['429 with status available', classify('readiness', 'steady', 'smoke', 429, noStore, '{"status":"available"}', 1)],
    ['429 with status unavailable', classify('readiness', 'outage', 'outage', 429, noStore, '{"status":"unavailable"}', 1)],
    ['503 with status available', classify('readiness', 'outage', 'outage', 503, noStore, JSON.stringify({ status: 'available', checkedAt }), 1)],
    ['503 with status busy', classify('readiness', 'stopping', 'outage', 503, noStore, JSON.stringify({ status: 'busy', checkedAt }), 1)],
    ['200 in outage', classify('readiness', 'outage', 'outage', 200, noStore, available(1), 1)],
    ['503 outside outage', classify('readiness', 'steady', 'smoke', 503, noStore, unavailable, 1)],
    ['503 in outage before', classify('readiness', 'before', 'outage', 503, noStore, unavailable, 1)],
    ['503 named outage on another profile', classify('readiness', 'outage', 'load', 503, noStore, unavailable, 1)],
    ['503 extra key', classify('readiness', 'outage', 'outage', 503, noStore, JSON.stringify({ status: 'unavailable', checkedAt, x: 1 }), 1)],
    ['503 bad checkedAt', classify('readiness', 'outage', 'outage', 503, noStore, JSON.stringify({ status: 'unavailable', checkedAt: 'x' }), 1)],
    ['500', classify('readiness', 'steady', 'smoke', 500, noStore, '{"error":"Internal server error"}', 1)],
    ['status 0 readiness', classify('readiness', 'steady', 'smoke', 0, {}, null, 1)],
    ['status 0 status', classify('status', 'steady', 'smoke', 0, {}, null, 1)],
  ];
  for (const [label, outcome] of rejected) expect(outcome, label).toBe('rejected');
});

test('PERF-001 metricUpdates maps every outcome to the metric, value, and tags of the paragraph after Klasifikasi respons', () => {
  // covers: AC-3 (unexpected_responses), AC-4, AC-5 (metrik khusus)
  expect(metricUpdates('status', 'steady', 'rejected', 3)).toEqual([{ metric: 'unexpected_responses', value: 1, tags: { endpoint: 'status', phase: 'steady' } }]);
  expect(metricUpdates('readiness', 'outage', 'rejected', 3)).toEqual([{ metric: 'unexpected_responses', value: 1, tags: { endpoint: 'readiness', phase: 'outage' } }]);
  expect(metricUpdates('status', 'steady', 'ok', 3)).toEqual([]);
  expect(metricUpdates('readiness', 'steady', 'available', 4.5)).toEqual([
    { metric: 'readiness_available', value: true, tags: { phase: 'steady' } },
    { metric: 'readiness_available_duration', value: 4.5, tags: { phase: 'steady' } },
  ]);
  expect(metricUpdates('readiness', 'hold', 'busy', 1.25)).toEqual([
    { metric: 'readiness_available', value: false, tags: { phase: 'hold' } },
    { metric: 'readiness_busy_duration', value: 1.25, tags: { phase: 'hold' } },
  ]);
  expect(metricUpdates('readiness', 'outage', 'unavailable', 5001)).toEqual([
    { metric: 'readiness_available', value: false, tags: { phase: 'outage' } },
    { metric: 'readiness_unavailable', value: 1, tags: { phase: 'outage' } },
    { metric: 'readiness_unavailable_duration', value: 5001, tags: { phase: 'outage' } },
  ]);
});

test('PERF-001 recoveryValue records once per VU, only for a 200 received at or after T0 + 150000, and is never negative', () => {
  // covers: AC-7 (readiness_recovery_ms)
  const t0 = 1_791_000_000_000;
  expect(recoveryValue(false, 'available', t0 + 150_000, t0)).toBe(0);
  expect(recoveryValue(false, 'available', t0 + 152_345, t0)).toBe(2_345);
  expect(recoveryValue(false, 'available', t0 + 149_999, t0)).toBeNull();
  expect(recoveryValue(true, 'available', t0 + 152_345, t0)).toBeNull();
  for (const outcome of ['busy', 'unavailable', 'rejected', 'ok'] as const) expect(recoveryValue(false, outcome, t0 + 160_000, t0), outcome).toBeNull();
});

test('PERF-001 k6ExitReason maps 0, 99, 107, other codes, and the timeout, with the real failed run as the 99 case', async () => {
  // covers: AC-4 (k6_thresholds_failed), AC-1 (setup yang gagal)
  const exits = await readFixture('k6-exit.json');
  const failed = exits['thresholdsFailed'] as { exitCode: number; summary: string };
  const setupError = exits['setupError'] as { exitCode: number };
  expect([failed.exitCode, setupError.exitCode]).toEqual([99, 107]);
  expect(k6ExitReason(0, false)).toBeNull();
  expect(k6ExitReason(failed.exitCode, false)).toBe('k6_thresholds_failed');
  expect(k6ExitReason(setupError.exitCode, false)).toBe('k6_failed');
  expect(k6ExitReason(1, false)).toBe('k6_failed');
  expect(k6ExitReason(null, false)).toBe('k6_failed');
  expect(k6ExitReason(0, true)).toBe('k6_timeout');
  expect(k6ExitReason(99, true)).toBe('k6_timeout');
  // The summary of the real failed run still exists and holds the failing latency threshold.
  const summary = await readFixture(failed.summary);
  const metrics = summary['metrics'] as Record<string, { thresholds?: Record<string, { ok: boolean }> }>;
  expect(metrics['http_req_duration{endpoint:status,phase:steady}']?.thresholds?.['p(95)<0']).toEqual({ ok: false });
  const failing = Object.values(metrics).flatMap((metric) => Object.values(metric.thresholds ?? {})).filter((item) => !item.ok);
  expect(failing).toHaveLength(1);
});

test('PERF-001 the real smoke summary holds every field result.json reads', async () => {
  // covers: AC-1 (fixture k6 nyata), AC-5 (metrics[nama].values, submetrik, setup_data, hasil threshold)
  const summary = await readFixture('summary-smoke.json');
  expect(Object.keys(summary)).toEqual(expect.arrayContaining(['metrics', 'options', 'setup_data', 'state']));
  const setup = summary['setup_data'] as Record<string, unknown>;
  expect(Object.keys(setup).sort()).toEqual(['expectedMigrations', 'startedAt', 't0']);
  const metrics = summary['metrics'] as Record<string, { values: Record<string, number>; thresholds?: Record<string, { ok: boolean }> }>;
  for (const key of Object.keys(optionsFor('smoke').thresholds)) {
    expect(metrics[key]?.thresholds, key).toBeDefined();
    for (const [expression, outcome] of Object.entries(metrics[key]!.thresholds!)) expect(outcome.ok, `${key} ${expression}`).toBe(true);
  }
  expect(metrics['iterations']?.values['count']).toBe(metrics['http_reqs']?.values['count']);
  expect(metrics['dropped_iterations']?.values['count']).toBe(0);
  expect(metrics['vus_max']?.values['value']).toBeGreaterThan(0);
  expect(metrics['readiness_unavailable_duration{phase:steady}']?.values['count']).toBe(0);
  expect(metrics['http_req_duration{endpoint:status,phase:steady}']?.values['count']).toBeGreaterThanOrEqual(2997);
});

// ---------------------------------------------------------------------------------------------------------------
// Import rule of the k6 scripts (TypeScript parser).

async function performanceFiles(): Promise<string[]> {
  const base = join(root, 'tests/performance');
  const found: string[] = [];
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.ts')) found.push(path);
    }
  };
  await visit(base);
  return found.sort();
}

type SourceFacts = {
  specifiers: string[];
  reexports: number;
  dynamicImports: number;
  identifiers: Map<string, ts.Node[]>;
  exported: string[];
  source: ts.SourceFile;
};

function sourceFacts(path: string, text: string): SourceFacts {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const facts: SourceFacts = { specifiers: [], reexports: 0, dynamicImports: 0, identifiers: new Map(), exported: [], source };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) facts.specifiers.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      facts.reexports += 1;
      if (ts.isStringLiteral(node.moduleSpecifier)) facts.specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) facts.dynamicImports += 1;
    if (ts.isImportEqualsDeclaration(node)) facts.dynamicImports += 1;
    if (ts.isIdentifier(node)) facts.identifiers.set(node.text, [...(facts.identifiers.get(node.text) ?? []), node]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) facts.exported.push(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) facts.exported.push(declaration.name.text);
    }
  }
  return facts;
}

const K6_MODULES = ['k6', 'k6/http', 'k6/metrics', 'k6/execution'];

test('PERF-001 k6 scripts import only k6 modules and relative .ts files inside tests/performance/', async () => {
  // covers: AC-1 (aturan impor, tanpa modul remote)
  const base = join(root, 'tests/performance');
  const files = await performanceFiles();
  expect(files.map((path) => relative(base, path).split(sep).join('/'))).toEqual(
    expect.arrayContaining([
      'helpers/plan.ts', 'helpers/expectations.ts', 'helpers/metrics.ts', 'helpers/lifecycle.ts', 'journeys/status.ts', 'journeys/readiness.ts',
      ...PROFILE_NAMES.map((profile) => `profiles/${profile}.ts`),
    ]),
  );
  for (const path of files) {
    const facts = sourceFacts(path, await readFile(path, 'utf8'));
    const name = relative(base, path);
    expect(facts.dynamicImports, name).toBe(0);
    expect(facts.identifiers.has('require'), name).toBe(false);
    for (const specifier of facts.specifiers) {
      if (K6_MODULES.includes(specifier)) continue;
      expect(specifier.startsWith('./') || specifier.startsWith('../'), `${name} ${specifier}`).toBe(true);
      expect(specifier.endsWith('.ts'), `${name} ${specifier}`).toBe(true);
      const target = resolve(join(path, '..'), specifier);
      expect(target.startsWith(`${base}${sep}`), `${name} ${specifier}`).toBe(true);
    }
  }
});

test('PERF-001 plan.ts and expectations.ts import nothing and never touch __ENV, process, or Bun; __ENV lives only in setupRun', async () => {
  // covers: AC-1 (modul murni, __ENV hanya di setupRun)
  for (const name of ['plan.ts', 'expectations.ts']) {
    const facts = sourceFacts(name, await readFile(join(root, 'tests/performance/helpers', name), 'utf8'));
    expect(facts.specifiers, name).toEqual([]);
    expect(facts.reexports, name).toBe(0);
    expect(facts.dynamicImports, name).toBe(0);
    for (const forbidden of ['__ENV', 'process', 'Bun', 'require']) expect(facts.identifiers.has(forbidden), `${name} ${forbidden}`).toBe(false);
  }
  for (const path of await performanceFiles()) {
    const facts = sourceFacts(path, await readFile(path, 'utf8'));
    const uses = facts.identifiers.get('__ENV') ?? [];
    if (!path.endsWith(`${sep}helpers${sep}lifecycle.ts`)) {
      expect(uses, path).toEqual([]);
      continue;
    }
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      let node: ts.Node | undefined = use.parent;
      while (node !== undefined && !(ts.isFunctionDeclaration(node) && node.name?.text === 'setupRun')) node = node.parent;
      expect(node, 'every __ENV is inside the body of setupRun').toBeDefined();
    }
  }
});

test('PERF-001 every profile exports exactly options, setup, handleSummary, status, and readiness', async () => {
  // covers: AC-1 (bentuk profil)
  const profiles = (await performanceFiles()).filter((path) => path.includes(`${sep}profiles${sep}`));
  // Exactly one file per profile name.
  expect(profiles.map((path) => path.slice(path.lastIndexOf(sep) + 1, -3)).sort()).toEqual([...PROFILE_NAMES].sort());
  for (const path of profiles) {
    const source = await readFile(path, 'utf8');
    const facts = sourceFacts(path, source);
    expect(facts.exported.sort(), path).toEqual(['handleSummary', 'options', 'readiness', 'setup', 'status']);
    expect(facts.reexports, path).toBe(0);
    const name = path.slice(path.lastIndexOf(sep) + 1, -3);
    expect(PROFILE_NAMES as readonly string[], path).toContain(name);
    // `options` is `optionsFor('<own name>')`, and both journeys run with the own profile name.
    expect(source, path).toContain(`export const options = optionsFor('${name}');`);
    expect(source, path).toContain(`statusJourney('${name}', data);`);
    expect(source, path).toContain(`readinessJourney('${name}', data);`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Inspect comparison.

test('PERF-001 durations normalize Go and short forms to whole milliseconds', () => {
  // covers: AC-1 (Pemeriksaan inspect, normalisasi)
  expect(durationMs('10s')).toBe(10_000);
  expect(durationMs('1m0s')).toBe(60_000);
  expect(durationMs('1.5s')).toBe(1_500);
  expect(durationMs('1h1m1s')).toBe(3_661_000);
  expect(durationMs('500ms')).toBe(500);
  expect(durationMs('1500us')).toBe(2);
  expect(durationMs('1500µs')).toBe(2);
  expect(durationMs('2000000ns')).toBe(2);
  for (const value of ['', '10', 's', '1d', '-1s', ' 10s', 10, null, undefined]) expect(durationMs(value), String(value)).toBeNull();
});

test('PERF-001 the real k6 inspect output of smoke matches optionsFor(smoke)', async () => {
  // covers: AC-1 (Pemeriksaan inspect terhadap keluaran nyata)
  const inspected = await readFixture('inspect-smoke.json');
  expect(inspectMatches(inspected, optionsFor('smoke'))).toBe(true);
  // The real output of each profile matches only its own options.
  for (const profile of PROFILE_NAMES) {
    const output = await readFixture(`inspect-${profile}.json`);
    for (const other of PROFILE_NAMES) expect(inspectMatches(output, optionsFor(other)), `${profile} against ${other}`).toBe(profile === other);
  }
  const normalized = normalizeInspect(inspected, { status_steady: ['executor', 'exec', 'rate', 'duration', 'startTime', 'timeUnit', 'preAllocatedVUs', 'maxVUs', 'gracefulStop'] });
  expect(normalized.scenarios['status_steady']).toEqual({
    executor: 'constant-arrival-rate', exec: 'status', rate: 100, duration: 30_000, startTime: 10_000, timeUnit: 1_000, preAllocatedVUs: 10, maxVUs: 10, gracefulStop: 6_000,
  });
  expect(normalized.thresholds['unexpected_responses']).toEqual([{ expression: 'count==0', abortOnFail: true, delayAbortEvalMs: 5_000 }]);
  expect(normalized.thresholds['checks']).toEqual([{ expression: 'rate==1', abortOnFail: false, delayAbortEvalMs: 0 }]);
});

test('PERF-001 the top level maxVUs of every real k6 inspect output is the peak VU of Alokasi VU', async () => {
  // covers: AC-1 (puncak VU per profil dihitung k6 dari optionsFor, tabel puncak Alokasi VU)
  const peaks: [string, unknown][] = [];
  for (const profile of PROFILE_NAMES) peaks.push([profile, (await readFixture(`inspect-${profile}.json`))['maxVUs']]);
  expect(peaks).toEqual([['smoke', 40], ['load', 220], ['stress', 1_000], ['spike', 1_110], ['outage', 110], ['soak', 220]]);
  // Every scenario in the real output has preAllocatedVUs equal to maxVUs.
  for (const profile of PROFILE_NAMES) {
    const scenarios = (await readFixture(`inspect-${profile}.json`))['scenarios'] as Record<string, Record<string, unknown>>;
    for (const [name, scenario] of Object.entries(scenarios)) expect(scenario['preAllocatedVUs'], `${profile} ${name}`).toBe(scenario['maxVUs']);
  }
});

test('PERF-001 a copy of the real inspect output changed in one field fails the comparison', async () => {
  // covers: AC-1 (inspect_mismatch)
  const original = await readFixture('inspect-smoke.json');
  const changed = (edit: (copy: { scenarios: Record<string, Record<string, unknown>>; thresholds: Record<string, unknown[]> }) => void) => {
    const copy = structuredClone(original) as { scenarios: Record<string, Record<string, unknown>>; thresholds: Record<string, unknown[]> };
    edit(copy);
    return inspectMatches(copy, optionsFor('smoke'));
  };
  expect(changed(() => undefined)).toBe(true);
  // Equivalent spellings of the same duration still match.
  expect(changed((copy) => (copy.scenarios['status_steady']!['duration'] = '0h0m30s'))).toBe(true);
  expect(changed((copy) => (copy.scenarios['status_warmup']!['startTime'] = '0s'))).toBe(true);
  const cases: [string, Parameters<typeof changed>[0]][] = [
    ['exec', (copy) => (copy.scenarios['status_steady']!['exec'] = 'readiness')],
    ['executor', (copy) => (copy.scenarios['status_steady']!['executor'] = 'ramping-arrival-rate')],
    ['rate', (copy) => (copy.scenarios['readiness_steady']!['rate'] = 11)],
    ['duration', (copy) => (copy.scenarios['readiness_steady']!['duration'] = '31s')],
    ['startTime', (copy) => (copy.scenarios['readiness_steady']!['startTime'] = '11s')],
    ['startTime renamed', (copy) => {
      copy.scenarios['readiness_steady']!['start_time'] = copy.scenarios['readiness_steady']!['startTime'];
      delete copy.scenarios['readiness_steady']!['startTime'];
    }],
    ['timeUnit', (copy) => (copy.scenarios['readiness_steady']!['timeUnit'] = '2s')],
    ['preAllocatedVUs', (copy) => (copy.scenarios['readiness_steady']!['preAllocatedVUs'] = 9)],
    ['maxVUs', (copy) => (copy.scenarios['readiness_steady']!['maxVUs'] = 99)],
    ['gracefulStop', (copy) => (copy.scenarios['readiness_steady']!['gracefulStop'] = '5s')],
    ['gracefulStop missing', (copy) => delete copy.scenarios['readiness_steady']!['gracefulStop']],
    ['extra scenario', (copy) => (copy.scenarios['extra_steady'] = { ...copy.scenarios['status_steady'] })],
    ['missing scenario', (copy) => delete copy.scenarios['readiness_warmup']],
    ['delayAbortEval', (copy) => (copy.thresholds['dropped_iterations'] = [{ threshold: 'count==0', abortOnFail: true, delayAbortEval: '6s' }])],
    ['abortOnFail', (copy) => (copy.thresholds['dropped_iterations'] = [{ threshold: 'count==0', abortOnFail: false, delayAbortEval: '5s' }])],
    ['threshold key renamed', (copy) => (copy.thresholds['dropped_iterations'] = [{ expression: 'count==0', abortOnFail: true, delayAbortEval: '5s' }])],
    ['expression', (copy) => (copy.thresholds['checks'] = ['rate>=0.99'])],
    ['expression order', (copy) => (copy.thresholds['http_req_duration{endpoint:status,phase:steady}'] = ['p(99)<25', 'p(95)<10'])],
    ['extra threshold', (copy) => (copy.thresholds['http_req_failed'] = ['rate<0.01'])],
    ['missing threshold', (copy) => delete copy.thresholds['readiness_available{phase:steady}']],
    ['no scenarios', (copy) => delete (copy as Partial<typeof copy>).scenarios],
  ];
  for (const [label, edit] of cases) expect(changed(edit), label).toBe(false);
  expect(inspectMatches(null, optionsFor('smoke'))).toBe(false);
  expect(inspectMatches('not json', optionsFor('smoke'))).toBe(false);
});

test('PERF-001 a copy of the real inspect output of a ramp profile changed in one ramp field fails the comparison', async () => {
  // covers: AC-1 (inspect_mismatch pada scenario naik atau turun, `exec`, dan `delayAbortEval`)
  type Inspected = { scenarios: Record<string, Record<string, unknown>>; thresholds: Record<string, unknown[]> };
  const original = (await readFixture('inspect-stress.json')) as unknown as Inspected;
  const changed = (edit: (copy: Inspected) => void) => {
    const copy = structuredClone(original);
    edit(copy);
    return inspectMatches(copy, optionsFor('stress'));
  };
  expect(changed(() => undefined)).toBe(true);
  // The real output writes the ramp stage in the Go duration form.
  const stage = (original.scenarios['status_ramp']!['stages'] as { duration: string; target: number }[])[0]!;
  expect(durationMs(stage.duration)).toBe(120_000);
  expect(changed((copy) => ((copy.scenarios['status_ramp']!['stages'] as { duration: string }[])[0]!.duration = '120s'))).toBe(true);
  const cases: [string, (copy: Inspected) => void][] = [
    ['startRate', (copy) => (copy.scenarios['status_ramp']!['startRate'] = 999)],
    ['stage target', (copy) => ((copy.scenarios['readiness_rampdown']!['stages'] as { target: number }[])[0]!.target = 51)],
    ['stage duration', (copy) => ((copy.scenarios['status_rampdown']!['stages'] as { duration: string }[])[0]!.duration = '1m1s')],
    ['extra stage', (copy) => (copy.scenarios['status_ramp']!['stages'] as unknown[]).push({ target: 4_000, duration: '1s' })],
    ['stage extra key', (copy) => ((copy.scenarios['status_ramp']!['stages'] as Record<string, unknown>[])[0]!['extra'] = 1)],
    ['ramp startTime', (copy) => (copy.scenarios['readiness_ramp']!['startTime'] = '61s')],
    ['exec', (copy) => (copy.scenarios['status_hold']!['exec'] = 'readiness')],
    ['hold rate', (copy) => (copy.scenarios['status_hold']!['rate'] = 3_999)],
    ['delayAbortEval', (copy) => (copy.thresholds['unexpected_responses'] = [{ threshold: 'count==0', abortOnFail: true, delayAbortEval: '10s' }])],
    ['overload target', (copy) => (copy.thresholds['readiness_available{phase:hold}'] = ['rate>=0.98'])],
    ['actual load floor', (copy) => (copy.thresholds['iterations{scenario:status_hold}'] = ['count>=1198799'])],
  ];
  for (const [label, edit] of cases) expect(changed(edit), label).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// Image pins, container arguments, `.env`, and the container engine size.

test('PERF-001 the image pins are valid, and wrong repositories, tags, or digests fail pin_invalid with the right detail', async () => {
  // covers: AC-2 (image dipin tag dan digest indeks; tag Bun = engines.bun)
  const text = await readFile(join(root, 'tests/performance/images.json'), 'utf8');
  const { engines } = (await Bun.file(join(root, 'package.json')).json()) as { engines: { bun: string } };
  expect(validateImagePins(text, engines.bun)).toEqual({ ok: true, pins: { k6: k6Image, bun: bunImage } });
  const pins = (k6: string, bun: string) => JSON.stringify({ k6: { image: k6 }, bun: { image: bun } });
  const digest = 'a'.repeat(64);
  expect(validateImagePins(pins(`grafana/k6:2.3.0@sha256:${digest}`, `oven/bun:1.4.2-slim@sha256:${digest}`), '1.4.2').ok).toBe(true);
  const failing: [string, string | null, unknown, 'k6' | 'bun'][] = [
    ['bun tag differs from engines.bun', pins(k6Image, bunImage), '1.4.3', 'bun'],
    ['bun without slim', pins(k6Image, `oven/bun:1.4.2@sha256:${digest}`), '1.4.2', 'bun'],
    ['bun other repository', pins(k6Image, `example/bun:1.4.2-slim@sha256:${digest}`), '1.4.2', 'bun'],
    ['bun short digest', pins(k6Image, `oven/bun:1.4.2-slim@sha256:${'a'.repeat(63)}`), '1.4.2', 'bun'],
    ['engines.bun missing', pins(k6Image, bunImage), undefined, 'bun'],
    ['k6 other tag', pins(`grafana/k6:2.2.0@sha256:${digest}`, bunImage), '1.4.2', 'k6'],
    ['k6 other repository', pins(`example/k6:2.3.0@sha256:${digest}`, bunImage), '1.4.2', 'k6'],
    ['k6 upper case digest', pins(`grafana/k6:2.3.0@sha256:${'A'.repeat(64)}`, bunImage), '1.4.2', 'k6'],
    ['k6 without digest', pins('grafana/k6:2.3.0', bunImage), '1.4.2', 'k6'],
    ['extra key', JSON.stringify({ k6: { image: k6Image }, bun: { image: bunImage }, extra: {} }), '1.4.2', 'k6'],
    ['extra field', JSON.stringify({ k6: { image: k6Image, tag: '2.3.0' }, bun: { image: bunImage } }), '1.4.2', 'k6'],
    ['not JSON', '{', '1.4.2', 'k6'],
    ['missing file', null, '1.4.2', 'k6'],
  ];
  for (const [label, input, bun, detail] of failing) expect(validateImagePins(input, bun), label).toEqual({ ok: false, detail });
});

const context = (uid = 501, gid = 20): ContainerContext => ({ root: '/work/repo', hex, uid, gid, pins: { k6: k6Image, bun: bunImage } });
const labels = ['--label', 'foundation.test=performance', '--label', `foundation.run=${hex}`, '--label', 'com.docker.compose.project=', '--label', 'com.docker.compose.service='];
const hardening = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
const tmpfs = ['--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m'];

test('PERF-001 resource names, labels, and the network follow Topologi environment test', () => {
  // covers: AC-2 (nama dan label run)
  expect(runHex(new Uint8Array([1, 35, 69, 103, 137, 171]))).toBe(hex);
  expect(runHex()).toMatch(/^[0-9a-f]{12}$/);
  expect(resourceNames(hex)).toEqual({
    network: `foundation-perf-net-${hex}`,
    db: `foundation-perf-db-${hex}`,
    backend: `foundation-perf-backend-${hex}`,
    k6: `foundation-perf-k6-${hex}`,
    inspect: `foundation-perf-inspect-${hex}`,
  });
  expect(runLabelArgs(hex)).toEqual(labels);
  expect(networkCreateArgs(context())).toEqual(['docker', 'network', 'create', ...labels, `foundation-perf-net-${hex}`]);
});

test('PERF-001 the PostgreSQL, backend, k6, and inspect arguments are exactly the topology table', () => {
  // covers: AC-2 (batas resource, flag keamanan, mount, network)
  expect(CONTAINER_LIMITS).toEqual({
    postgres: { cpus: '2', memory: '1g', shmSize: '128m', pids: '256' },
    backend: { cpus: '1', memory: '512m', pids: '256' },
    k6: { cpus: '3', memory: '2g', pids: '512' },
    inspect: { cpus: '1', memory: '512m', pids: '512' },
  });
  expect(postgresRunArgs(context(), 54321, '/tmp/x/postgres.env')).toEqual([
    'docker', 'run', '-d', '--name', `foundation-perf-db-${hex}`, ...labels,
    '--network', `foundation-perf-net-${hex}`, '--network-alias', 'postgres', '-p', '127.0.0.1:54321:5432',
    '--cpus', '2', '--memory', '1g', '--shm-size', '128m', '--pids-limit', '256', ...hardening,
    '--env-file', '/tmp/x/postgres.env', 'foundation-postgres:18-pinned',
  ]);
  expect(backendRunArgs(context(), '/tmp/x/backend.env')).toEqual([
    'docker', 'run', '-d', '--name', `foundation-perf-backend-${hex}`, ...labels, '--network', `foundation-perf-net-${hex}`,
    '--cpus', '1', '--memory', '512m', '--pids-limit', '256', '--pull', 'never', ...tmpfs, '--user', '501:20', ...hardening,
    '-v', '/work/repo/apps/backend:/repo/apps/backend:ro', '-v', '/work/repo/libs:/repo/libs:ro',
    '-v', '/work/repo/node_modules:/repo/node_modules:ro', '-v', '/work/repo/package.json:/repo/package.json:ro',
    '-w', '/repo', '--env-file', '/tmp/x/backend.env', bunImage, 'bun', '--no-env-file', 'apps/backend/src/index.ts',
  ]);
  expect(k6CreateArgs(context(), 'smoke', 1, 1_791_126_764_895)).toEqual([
    'docker', 'create', '--name', `foundation-perf-k6-${hex}`, ...labels, '--network', `container:foundation-perf-backend-${hex}`,
    '--cpus', '3', '--memory', '2g', '--pids-limit', '512', '--pull', 'never', ...tmpfs, '--user', '501:20', ...hardening,
    '-e', 'K6_NO_USAGE_REPORT=true', '-v', '/work/repo/tests/performance:/scripts:ro', '-v', '/work/repo/.local/feature-12/smoke/k6:/out',
    k6Image, 'run', '--no-usage-report', '--quiet', '--env', 'FOUNDATION_PERF_EXPECTED_MIGRATIONS=1', '--env', 'FOUNDATION_PERF_T0=1791126764895',
    '/scripts/profiles/smoke.ts',
  ]);
  const inspect = inspectRunArgs(context(), 'smoke');
  expect(inspect).toEqual([
    'docker', 'run', '--rm', '--name', `foundation-perf-inspect-${hex}`, ...labels, '--network', 'none',
    '--cpus', '1', '--memory', '512m', '--pids-limit', '512', '--pull', 'never', ...tmpfs, '--user', '501:20', ...hardening,
    '-v', '/work/repo/tests/performance:/scripts:ro', k6Image, 'inspect', '--execution-requirements', '/scripts/profiles/smoke.ts',
  ]);
  // The inspect container gets no --env, no /out mount, and no -e.
  expect(inspect).not.toContain('--env');
  expect(inspect).not.toContain('-e');
  expect(inspect.some((value) => value.endsWith(':/out'))).toBe(false);
  // No mount ever covers the repository root or a .env file; the backend sees four paths only.
  for (const argv of [backendRunArgs(context(), '/tmp/x/backend.env'), k6CreateArgs(context(), 'smoke', 1, 1), inspect]) {
    const mounts = argv.filter((_value, index) => argv[index - 1] === '-v');
    for (const mount of mounts) {
      expect(mount.startsWith('/work/repo:'), mount).toBe(false);
      expect(mount.includes('.env'), mount).toBe(false);
    }
  }
  // Root on the host: every container runs as 65534:65534.
  expect(containerUser(0, 0)).toBe('65534:65534');
  expect(containerUser(501, 20)).toBe('501:20');
  for (const argv of [backendRunArgs(context(0, 0), 'e'), k6CreateArgs(context(0, 0), 'smoke', 1, 1), inspectRunArgs(context(0, 0), 'smoke')]) {
    expect(argv[argv.indexOf('--user') + 1]).toBe('65534:65534');
  }
});

test('PERF-001 the backend state inspect always uses --format with three fields only', () => {
  // covers: AC-10 (Config.Env yang memuat DATABASE_URL tidak pernah dibaca)
  const argv = backendStateArgs(`foundation-perf-backend-${hex}`);
  expect(argv).toEqual(['docker', 'container', 'inspect', '--format', '{{json .State.Running}} {{json .RestartCount}} {{json .State.OOMKilled}}', `foundation-perf-backend-${hex}`]);
  expect(argv.join(' ')).not.toContain('Env');
  expect(guardInspectArgs('container', 'n')).toEqual(['docker', 'container', 'inspect', '--format', '{{json .Config.Labels}}', 'n']);
  expect(guardInspectArgs('network', 'n')).toEqual(['docker', 'network', 'inspect', '--format', '{{json .Labels}}', 'n']);
});

test('PERF-001 the .env walk fails env_file_present on a .env.local and passes without it, without following symlinks', async () => {
  // covers: AC-2 (env_file_present)
  const clean = await workspace({ 'apps/backend/src/index.ts': '', 'libs/server/x.ts': '', 'node_modules/pkg/index.js': '', '.env': 'ROOT=1\n' });
  expect(await findEnvFile(clean)).toBeNull();
  const dirty = await workspace({ 'apps/backend/src/index.ts': '', 'node_modules/pkg/.env.local': 'X=1\n', 'libs/server/.envrc': 'X=1\n' });
  expect(await findEnvFile(dirty)).toBe('libs/server/.envrc');
  const backend = await workspace({ 'apps/backend/.env.local': 'X=1\n' });
  expect(await findEnvFile(backend)).toBe('apps/backend/.env.local');
  // A symlinked folder outside the scanned roots is not followed.
  const outside = await workspace({ 'secret/.env': 'X=1\n', 'apps/backend/src/index.ts': '' });
  await mkdir(join(outside, 'node_modules'), { recursive: true });
  await symlink(join(outside, 'secret'), join(outside, 'node_modules/linked'));
  expect(await findEnvFile(outside)).toBeNull();
  // Missing folders are skipped.
  expect(await findEnvFile(await workspace({ 'README.md': '' }))).toBeNull();
  await writeFile(join(outside, 'node_modules/.env'), 'X=1\n');
  expect(await findEnvFile(outside)).toBe('node_modules/.env');
});

test('PERF-001 the container engine size check needs 4 CPU and exactly 4 GiB or more', () => {
  // covers: AC-2 (environment_too_small)
  const gib4 = 4 * 1024 * 1024 * 1024;
  expect(environmentTooSmall(4, gib4)).toBeNull();
  expect(environmentTooSmall(10, 8_319_504_384)).toBeNull();
  expect(environmentTooSmall(3, gib4)).toBe(`ncpu=3 memTotal=${gib4}`);
  expect(environmentTooSmall(4, gib4 - 1)).toBe(`ncpu=4 memTotal=${gib4 - 1}`);
  expect(parseEngineSize('10 8319504384\n')).toEqual({ ncpu: 10, memTotal: 8_319_504_384 });
  for (const text of ['', 'x y', '10', '10 8.5', '-1 5']) expect(parseEngineSize(text), text).toBeNull();
});

test('PERF-001 the container guard accepts only this run names and labels, and recognizes a missing resource', () => {
  // covers: AC-2 (penjaga container)
  const names = resourceNames(hex);
  for (const name of Object.values(names)) expect(guardNameAccepted(name, names), name).toBe(true);
  for (const name of [
    'foundation-perf-db-ba9876543210', // another run
    'foundation-readiness-01234567', // another pattern
    `foundation-perf-db-${hex}x`,
    `foundation-perf-web-${hex}`,
    `foundation-perf-db-${hex.toUpperCase()}`,
  ]) {
    expect(guardNameAccepted(name, names), name).toBe(false);
  }
  const own = { 'foundation.test': 'performance', 'foundation.run': hex, 'com.docker.compose.project': '', 'com.docker.compose.service': '' };
  expect(guardLabelsAccepted(own, hex)).toBe(true);
  expect(guardLabelsAccepted({ ...own, 'foundation.test': 'readiness' }, hex)).toBe(false);
  expect(guardLabelsAccepted({ ...own, 'foundation.run': 'ba9876543210' }, hex)).toBe(false);
  expect(guardLabelsAccepted({ 'foundation.test': 'performance' }, hex)).toBe(false);
  for (const key of ['com.docker.compose.oneoff', 'com.docker.compose.config-hash', 'com.docker.compose.container-number']) {
    expect(guardLabelsAccepted({ ...own, [key]: 'False' }, hex), key).toBe(false);
  }
  for (const value of [null, undefined, [], 'labels']) expect(guardLabelsAccepted(value, hex)).toBe(false);
  const db = names.db;
  expect(resourceMissing('container', db, 1, `Error response from daemon: No such container: ${db}\n`)).toBe(true);
  expect(resourceMissing('container', db, 1, `Error: No such container: ${db}\n`)).toBe(true);
  expect(resourceMissing('network', names.network, 1, `Error response from daemon: network ${names.network} not found\n`)).toBe(true);
  expect(resourceMissing('network', names.network, 1, `Error: No such network: ${names.network}\n`)).toBe(true);
  expect(resourceMissing('container', db, 1, 'Cannot connect to the Docker daemon\n')).toBe(false);
  expect(resourceMissing('container', db, null, `Error response from daemon: No such container: ${db}\n`)).toBe(false);
  expect(resourceMissing('container', db, 125, `Error response from daemon: No such container: ${db}\n`)).toBe(false);
  expect(resourceMissing('network', names.network, 1, `Error response from daemon: No such container: ${names.network}\n`)).toBe(false);
});

test('PERF-001 the backend poll reads both endpoints and the expected migration count', () => {
  // covers: AC-2 (backend_not_ready)
  expect(backendReady('{"status":200,"readiness":200,"appliedMigrations":1}\n', 1)).toBe(true);
  expect(backendReady('{"status":200,"readiness":200,"appliedMigrations":0}', 1)).toBe(false);
  expect(backendReady('{"status":200,"readiness":429,"appliedMigrations":null}', 1)).toBe(false);
  expect(backendReady('{"status":0,"readiness":200,"appliedMigrations":1}', 1)).toBe(false);
  expect(backendReady('', 1)).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// `result.json`, reason codes, redaction, and the cleanup limit.

test('PERF-001 the reason codes and setup steps are exactly the Kode alasan table, and details are cut to 200 characters', () => {
  // covers: AC-10 (bentuk result.json)
  expect(PERFORMANCE_REASON_CODES).toEqual([
    'pin_invalid', 'env_file_present', 'environment_too_small', 'environment_busy', 'image_build_failed', 'image_pull_failed',
    'inspect_mismatch', 'setup_failed', 'backend_not_ready', 'k6_thresholds_failed', 'k6_failed', 'k6_timeout', 'summary_missing',
    'phase_start_late', 'iteration_request_mismatch', 'generator_saturated', 'observation_failed', 'outage_control_late',
    'secret_in_output', 'cleanup_failed', 'signal',
  ]);
  expect(SETUP_STEPS).toEqual([
    'network', 'postgres_start', 'postgres_ready', 'provision', 'migrate', 'migration_count', 'backend_start', 'clock_offset_read',
    'k6_create', 'stats_start', 'environment_read',
  ]);
  expect(reason('k6_failed', '107')).toEqual({ code: 'k6_failed', detail: '107' });
  expect(reason('summary_missing')).toEqual({ code: 'summary_missing', detail: null });
  expect(reason('env_file_present', 'x'.repeat(250)).detail).toHaveLength(200);
});

test('PERF-001 result.json holds the named fields in order, passes only without reasons, and records the load model', () => {
  // covers: AC-4, AC-5, AC-10 (bentuk result.json)
  const passed = buildResult({ profile: 'smoke', reasons: [], startedAt: '2026-10-04T15:12:21.812Z', finishedAt: '2026-10-04T15:13:26.040Z', t0: 1 });
  expect(Object.keys(passed)).toEqual([
    'schema', 'profile', 'status', 'reasons', 'startedAt', 'finishedAt', 't0', 'model',
    'actual', 'latency', 'readiness', 'thresholds', 'observation', 'outage', 'environment', 'limits',
  ]);
  // Without a summary, an observation, or a migration count, those fields are null.
  expect([passed.actual, passed.latency, passed.readiness, passed.thresholds, passed.observation, passed.outage, passed.limits]).toEqual([null, null, null, null, null, null, null]);
  expect([passed.schema, passed.profile, passed.status, passed.reasons, passed.t0]).toEqual([1, 'smoke', 'passed', [], 1]);
  expect(passed.model).toEqual({
    iterationIsOneRequest: true,
    phases: [
      { phase: 'warmup', shape: 'constant', seconds: 10, load: 'S0', rates: { status: { startRate: 100, endRate: 100 }, readiness: { startRate: 10, endRate: 10 } } },
      { phase: 'steady', shape: 'constant', seconds: 30, load: 'S0', rates: { status: { startRate: 100, endRate: 100 }, readiness: { startRate: 10, endRate: 10 } } },
    ],
  });
  const failed = buildResult({ profile: 'smoke', reasons: [reason('k6_thresholds_failed'), reason('cleanup_failed', 'folder')], startedAt: 'a', finishedAt: 'b', t0: null });
  expect([failed.status, failed.reasons, failed.t0]).toEqual(['failed', [{ code: 'k6_thresholds_failed', detail: null }, { code: 'cleanup_failed', detail: 'folder' }], null]);
});

test('PERF-001 redacted() replaces every run credential, and the scan finds credentials in text and bytes', () => {
  // covers: AC-10 (redaksi dan pemindaian credential)
  // Built at runtime in the shape of a run credential (48 hexadecimal characters), so no credential like literal is committed.
  const password = randomBytes(24).toString('hex');
  const url = `postgres://foundation_admin:${password}@127.0.0.1:5432/foundation`;
  const redact = redactor([password, url]);
  const message = `performance smoke: gagal menyambung ke ${url} dengan password ${password}`;
  expect(redact(message)).toBe('performance smoke: gagal menyambung ke [redacted] dengan password [redacted]');
  expect(redact(message)).not.toContain(password);
  expect(redactor([])('tetap')).toBe('tetap');
  expect(containsSecret(message, [password])).toBe(true);
  expect(containsSecret(Buffer.from(`x${password}y`), [password])).toBe(true);
  expect(containsSecret('[redacted]', [password])).toBe(false);
  expect(containsSecret('anything', [''])).toBe(false);
});

test('PERF-001 the worst case cleanup from the command limits stays 165 seconds', () => {
  // covers: AC-2 (pembersihan di bawah masa tenggang 180 detik)
  expect(worstCaseCleanupMs()).toBe(165_000);
  expect([TIMEOUTS.guardInspect, TIMEOUTS.k6Stop, TIMEOUTS.remove, TIMEOUTS.cancelMax, TIMEOUTS.streamsStop]).toEqual([10_000, 15_000, 15_000, 10_000, 5_000]);
  expect(worstCaseCleanupMs()).toBeLessThan(180_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Observation (*Pengamatan resource*), the summary reader, the environment, and the remaining `result.json` fields
// (step 2 of the Build plan).

const T0 = 1_791_000_000_000;
/** Times from `from` up to and including `to`, every `step` ms. */
const times = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_value, index) => from + index * step);
const series = (from: number, to: number, cpu: number | null, memoryMiB: number | null, step = 1_000): ContainerSample[] =>
  times(from, to, step).map((t) => ({ t, cpu, memoryMiB }));
const poolSeries = (from: number, to: number, counts = { sessions: 2, nonIdle: 1, total: 4 }, step = 1_000): PoolSample[] => times(from, to, step).map((t) => ({ t, ...counts }));

/** A complete smoke observation: samples every second from 5 s before T0 to 1 s after the last phase. */
function smokeInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    profile: 'smoke',
    t0: T0,
    phases: observedPhases('smoke', T0),
    containers: { postgres: series(T0 - 5_000, T0 + 41_000, 1, 40), backend: series(T0 - 5_000, T0 + 41_000, 5, 60), k6: series(T0 - 5_000, T0 + 41_000, 18, 39) },
    pool: poolSeries(T0 - 2_000, T0 + 41_000),
    backendState: { running: true, restarts: 0, oomKilled: false },
    backendLogs: { stdout: EXPECTED_BACKEND_STDOUT, stderrBytes: 0 },
    clockOffsetMs: { before: 7, after: -12 },
    outage: null,
    ...overrides,
  };
}
const checkOf = (input: ObservationInput, name: string, limits = OBSERVATION_LIMITS) => observationChecks(input, limits).find((check) => check.name === name)!;
const withSample = (input: ObservationInput, role: 'postgres' | 'backend' | 'k6', sample: ContainerSample): ObservationInput => ({
  ...input,
  containers: { ...input.containers, [role]: [...input.containers[role], sample] },
});

test('PERF-001 phaseWindows gives the smoke phases from the plan and the outage timeline with its targets', () => {
  // covers: AC-6 (jendela fase dari T0 dan durasi PROFILES; fase terukur adalah fase bertarget), AC-7 (fase outage), AC-8 (fase stress dan spike)
  expect(phaseWindows('smoke')).toEqual([
    { name: 'warmup', fromMs: 0, toMs: 10_000, target: null },
    { name: 'steady', fromMs: 10_000, toMs: 40_000, target: 'normal' },
  ]);
  const windows = (profile: (typeof PROFILE_NAMES)[number]) => phaseWindows(profile).map((phase) => [phase.name, phase.fromMs / 1_000, phase.toMs / 1_000, phase.target]);
  expect(windows('load')).toEqual([['warmup', 0, 60, null], ['steady', 60, 660, 'normal']]);
  expect(windows('stress')).toEqual([
    ['warmup', 0, 60, null], ['ramp', 60, 180, null], ['hold', 180, 480, 'overload'], ['rampdown', 480, 540, null], ['settle', 540, 550, null], ['recover', 550, 730, 'normal'],
  ]);
  expect(windows('spike')).toEqual([
    ['warmup', 0, 60, null], ['before', 60, 180, 'normal'], ['rise', 180, 185, null], ['spike', 185, 245, 'overload'], ['fall', 245, 250, null], ['settle', 250, 260, null],
    ['after', 260, 440, 'normal'],
  ]);
  expect(windows('soak')).toEqual([['warmup', 0, 60, null], ['steady', 60, 3_660, 'normal']]);
  // Recover (stress) and after (spike) start 10 seconds after the load is back at N (AC-8).
  expect(phaseWindows('stress').find((phase) => phase.name === 'recover')!.fromMs - phaseWindows('stress').find((phase) => phase.name === 'rampdown')!.toMs).toBe(10_000);
  expect(phaseWindows('spike').find((phase) => phase.name === 'after')!.fromMs - phaseWindows('spike').find((phase) => phase.name === 'fall')!.toMs).toBe(10_000);
  expect(phaseWindows('outage').map((phase) => [phase.name, phase.fromMs, phase.toMs, phase.target])).toEqual([
    ['warmup', 0, 30_000, null],
    ['before', 30_000, 88_000, 'normal'],
    ['stopping', 88_000, 101_000, 'outage'],
    ['outage', 101_000, 145_000, 'outage'],
    ['recovering', 145_000, 160_000, 'outage'],
    ['after', 160_000, 220_000, 'normal'],
  ]);
  expect(observedPhases('smoke', T0)).toEqual([
    { name: 'warmup', start: T0, end: T0 + 10_000, target: null },
    { name: 'steady', start: T0 + 10_000, end: T0 + 40_000, target: 'normal' },
  ]);
  expect(profilePhaseNames('smoke')).toEqual(['warmup', 'steady']);
  expect(profilePhaseNames('outage')).toEqual(['warmup', 'before', 'stopping', 'outage', 'recovering', 'after']);
});

test('PERF-001 CPU and memory read as percent of one CPU and MiB from B, KiB, MiB, and GiB; control characters go; anything else is null', () => {
  // covers: AC-6 (pemecah baris aliran docker stats: persen, B, KiB, MiB, GiB, --, karakter kontrol)
  expect(parsePercent('0.00%')).toBe(0);
  expect(parsePercent('245.31%')).toBe(245.31);
  for (const value of ['--', '', '12', '%', '-1%', '1,5%', null, 5]) expect(parsePercent(value), String(value)).toBeNull();
  expect(parseMemoryMiB('0B / 0B')).toBe(0);
  expect(parseMemoryMiB('1048576B / 1GiB')).toBe(1);
  expect(parseMemoryMiB('512KiB / 1GiB')).toBe(0.5);
  expect(parseMemoryMiB('4.227MiB / 7.748GiB')).toBe(4.227);
  expect(parseMemoryMiB('1.5GiB / 2GiB')).toBe(1536);
  for (const value of ['--', '-- / --', '5kB / 1GiB', '5TiB / 1GiB', '', 'MiB', null]) expect(parseMemoryMiB(value), String(value)).toBeNull();
  expect(stripControl('\u001b[J\u001b[H{"a":1}\u001b[K\r')).toBe('{"a":1}');
  expect(stripControl('\u001b[2J\u0007x\u0000\u007f')).toBe('x');
  expect(statsArgs(resourceNames(hex))).toEqual([
    'docker', 'stats', '--format', '{{json .}}', `foundation-perf-db-${hex}`, `foundation-perf-backend-${hex}`, `foundation-perf-k6-${hex}`,
  ]);
});

test('PERF-001 the docker stats splitter keeps partial lines, uses the time of the chunk a line ends in, and keeps at most 4 samples per container per second', () => {
  // covers: AC-6 (potongan yang memotong baris, beberapa baris dalam satu potongan, waktu potongan, batas 4 sampel per detik)
  const names = { postgres: `foundation-perf-db-${hex}`, backend: `foundation-perf-backend-${hex}`, k6: `foundation-perf-k6-${hex}` };
  const line = (name: string, cpu: string, memory: string) =>
    JSON.stringify({ BlockIO: '0B / 0B', CPUPerc: cpu, Container: name, ID: '28d8f3aa24c7', MemPerc: '0.00%', MemUsage: memory, Name: name, NetIO: '0B / 0B', PIDs: '2' });
  const seen: string[] = [];
  const collector = statsCollector(names, { onLine: (text) => seen.push(text) });
  // A real refresh: control sequences around each line, and the second line cut by the chunk boundary.
  collector.push(Buffer.from(`\u001b[J\u001b[H${line(names.backend, '12.50%', '64MiB / 512MiB')}\u001b[K\n${line(names.postgres, '0.10%', '1.5GiB / 1GiB')}`), T0 + 100);
  expect(collector.samples.backend).toEqual([{ t: T0 + 100, cpu: 12.5, memoryMiB: 64 }]);
  expect(collector.samples.postgres).toEqual([]);
  collector.push(Buffer.from(`\u001b[K\n\u001b[K\n${line(names.k6, '--', '--')}\n`), T0 + 900);
  // The cut line takes the time of the chunk it ends in.
  expect(collector.samples.postgres).toEqual([{ t: T0 + 900, cpu: 0.1, memoryMiB: 1536 }]);
  expect(collector.samples.k6).toEqual([{ t: T0 + 900, cpu: null, memoryMiB: null }]);
  // Several lines in one chunk: at most 4 per container and host second.
  const six = `${Array.from({ length: 6 }, () => line(names.backend, '1.00%', '512KiB / 1GiB')).join('\n')}\n`;
  collector.push(six, T0 + 950);
  expect(collector.samples.backend).toHaveLength(4);
  collector.push(six, T0 + 1_000);
  expect(collector.samples.backend).toHaveLength(8);
  expect(collector.samples.backend.at(-1)).toEqual({ t: T0 + 1_000, cpu: 1, memoryMiB: 0.5 });
  // Another container, a line that is not JSON, and empty lines are skipped; begin() drops the partial line of the
  // previous stream process.
  collector.push(`${line('foundation-perf-db-ba9876543210', '1.00%', '1MiB / 1GiB')}\nnot json\n\n${line(names.k6, '9.00%', '9MiB / 1GiB').slice(0, 40)}`, T0 + 2_000);
  collector.begin();
  collector.push(`${line(names.k6, '5.00%', '2048B / 1GiB')}\n`, T0 + 2_500);
  expect(collector.samples.k6).toEqual([{ t: T0 + 900, cpu: null, memoryMiB: null }, { t: T0 + 2_500, cpu: 5, memoryMiB: 0.002 }]);
  expect(collector.samples.postgres).toHaveLength(1);
  expect(seen).toContain('not json');
});

test('PERF-001 the pg_stat_activity sample uses the fixed query of the spec, and its row must hold three counts', () => {
  // covers: AC-6 (query tetap pg_stat_activity lewat koneksi admin)
  expect(POOL_QUERY).toBe(
    "SELECT count(*) FILTER (WHERE usename = 'foundation_backend')::int AS sessions, count(*) FILTER (WHERE usename = 'foundation_backend' AND state <> 'idle')::int AS non_idle, count(*)::int AS total FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend'",
  );
  expect(parsePoolRow({ sessions: 5, non_idle: 1, total: 7 })).toEqual({ sessions: 5, nonIdle: 1, total: 7 });
  for (const row of [null, {}, { sessions: '5', non_idle: 1, total: 7 }, { sessions: 1.5, non_idle: 1, total: 7 }, { sessions: -1, non_idle: 0, total: 0 }, { sessions: 1, total: 1 }]) {
    expect(() => parsePoolRow(row), JSON.stringify(row)).toThrow('Unexpected pool row');
  }
  expect([TIMEOUTS.poolInterval, TIMEOUTS.poolSample, TIMEOUTS.poolConnectionTimeoutSeconds]).toEqual([1_000, 2_000, 1]);
  expect([TIMEOUTS.statsExtra, TIMEOUTS.statsRestarts, TIMEOUTS.statsRestartPause]).toEqual([195_000, 10, 1_000]);
});

test('PERF-001 the summary reader takes actual load, latency, readiness, and thresholds from the real smoke summary', async () => {
  // covers: AC-5 (beban aktual, laju aktual = iterasi dibagi detik rencana, latency dan jumlah per fase, Pencatatan)
  const summary = await readFixture('summary-smoke.json');
  const setup = summary['setup_data'] as { t0: number; startedAt: number };
  const reading = readSummary(summary, 'smoke', setup.t0)!;
  const constant = { executor: 'constant-arrival-rate' };
  expect(reading.actual.scenarios).toEqual([
    { name: 'status_warmup', endpoint: 'status', phase: 'warmup', ...constant, startRate: 100, endRate: 100, seconds: 10, plannedIterations: 1000, iterations: 1001, rate: 1001 / 10 },
    { name: 'readiness_warmup', endpoint: 'readiness', phase: 'warmup', ...constant, startRate: 10, endRate: 10, seconds: 10, plannedIterations: 100, iterations: 101, rate: 101 / 10 },
    { name: 'status_steady', endpoint: 'status', phase: 'steady', ...constant, startRate: 100, endRate: 100, seconds: 30, plannedIterations: 3000, iterations: 3000, rate: 100 },
    { name: 'readiness_steady', endpoint: 'readiness', phase: 'steady', ...constant, startRate: 10, endRate: 10, seconds: 30, plannedIterations: 300, iterations: 301, rate: 301 / 30 },
  ]);
  // Not the k6 Counter rate (iterations over the whole test duration, 80.35 here).
  expect(reading.actual.scenarios[0]!.rate).not.toBeCloseTo(18.27, 1);
  expect(reading.actual).toMatchObject({ iterations: 4403, httpReqs: 4403, droppedIterations: 0, vusMax: 40, scenarioStartLateMs: setup.startedAt - setup.t0 });
  expect(reading.latency).toHaveLength(8);
  expect(reading.latency[0]).toEqual({ endpoint: 'status', phase: 'warmup', outcome: 'all', count: 1001, p50: 0.612833, p95: 1.871125, p99: 3.333, max: 9.172917 });
  // A trend with count 0 is recorded with count 0 and null statistics, not k6's zeros.
  expect(reading.latency.find((row) => row.phase === 'steady' && row.outcome === 'unavailable')).toEqual({
    endpoint: 'readiness', phase: 'steady', outcome: 'unavailable', count: 0, p50: null, p95: null, p99: null, max: null,
  });
  expect(reading.latency.find((row) => row.phase === 'steady' && row.outcome === 'busy')).toEqual({
    endpoint: 'readiness', phase: 'steady', outcome: 'busy', count: 1, p50: 2.546, p95: 2.546, p99: 2.546, max: 2.546,
  });
  expect(reading.readiness).toEqual({
    phases: [
      { phase: 'warmup', available: 101, busy: 0, unavailable: 0, availableRatio: 1 },
      { phase: 'steady', available: 300, busy: 1, unavailable: 0, availableRatio: 300 / 301 },
    ],
    recoveryMs: null,
  });
  // Every threshold of optionsFor(smoke), Pencatatan included, in plan order and all passed. k6 writes the expression it
  // evaluated: this real summary was captured before the Ambang beban aktual decision of 2026-10-04, so its four
  // actual load floors are the 99.9 percent floors of that plan; every other key and expression is the plan of today.
  const captured: Record<string, string> = {
    'iterations{scenario:status_warmup}': 'count>=999',
    'iterations{scenario:readiness_warmup}': 'count>=99',
    'iterations{scenario:status_steady}': 'count>=2997',
    'iterations{scenario:readiness_steady}': 'count>=299',
  };
  const expected = Object.entries(optionsFor('smoke').thresholds).flatMap(([metric, items]) =>
    items.map((item) => ({ metric, expression: captured[metric] ?? (typeof item === 'string' ? item : item.threshold), ok: true })),
  );
  expect(reading.thresholds).toEqual(expected);
  expect(reading.thresholds.map((item) => item.expression)).toContain('max>=0');
});

test('PERF-001 a missing submetric reads as count 0 with null statistics, a missing Counter as 0, and a missing summary as null', async () => {
  // covers: AC-5 (submetrik tidak ada, Counter tidak ada, summary_missing)
  const summary = await readFixture('summary-smoke.json');
  const setup = summary['setup_data'] as { t0: number };
  const trimmed = structuredClone(summary) as { metrics: Record<string, unknown>; setup_data?: unknown };
  delete trimmed.metrics['readiness_busy_duration{phase:steady}'];
  delete trimmed.metrics['dropped_iterations'];
  delete trimmed.metrics['iterations{scenario:status_steady}'];
  delete trimmed.metrics['vus_max'];
  delete trimmed.setup_data;
  const reading = readSummary(trimmed, 'smoke', setup.t0)!;
  expect(reading.latency.find((row) => row.phase === 'steady' && row.outcome === 'busy')).toMatchObject({ count: 0, p50: null, p95: null, p99: null, max: null });
  expect(reading.actual).toMatchObject({ droppedIterations: 0, vusMax: 0, scenarioStartLateMs: null });
  expect(reading.actual.scenarios.find((item) => item.name === 'status_steady')).toMatchObject({ plannedIterations: 3000, iterations: 0, rate: 0 });
  expect(reading.readiness.phases[1]).toEqual({ phase: 'steady', available: 300, busy: 0, unavailable: 0, availableRatio: 1 });
  for (const value of [undefined, null, {}, { metrics: [] }, 'text']) expect(readSummary(value, 'smoke', setup.t0), String(value)).toBeNull();
  expect(readSummary(summary, 'smoke', null)!.actual.scenarioStartLateMs).toBeNull();
});

test('PERF-001 phase_start_late passes at 2000 ms and fails above it; iteration_request_mismatch compares http_reqs with iterations', async () => {
  // covers: AC-5 (phase_start_late, iteration_request_mismatch)
  const summary = await readFixture('summary-smoke.json');
  const base = readSummary(summary, 'smoke', (summary['setup_data'] as { t0: number }).t0)!;
  const at = (late: number | null, httpReqs = base.actual.iterations) => summaryReasons({ ...base, actual: { ...base.actual, scenarioStartLateMs: late, httpReqs } });
  expect(at(base.actual.scenarioStartLateMs)).toEqual([]);
  expect(at(2_000)).toEqual([]);
  expect(at(2_001)).toEqual([{ code: 'phase_start_late', detail: '2001' }]);
  expect(at(null)).toEqual([]);
  expect(at(0, 4_402)).toEqual([{ code: 'iteration_request_mismatch', detail: '4402/4403' }]);
  expect(at(2_500, 1)).toEqual([{ code: 'phase_start_late', detail: '2500' }, { code: 'iteration_request_mismatch', detail: '1/4403' }]);
});

test('PERF-001 every observation check of smoke passes on a complete observation, in table order', () => {
  // covers: AC-6 (check yang berlaku untuk smoke)
  const checks = observationChecks(smokeInput());
  expect(checks.map((check) => check.name)).toEqual([
    'backend_running', 'backend_output', 'backend_memory_peak', 'pool_sessions', 'pool_non_idle', 'generator_cpu', 'generator_memory', 'observation_coverage', 'clock_offset',
  ]);
  for (const check of checks) expect(check.ok, `${check.name} ${JSON.stringify(check.actual)}`).toBe(true);
  expect(observationReasons(checks, null)).toEqual([]);
  expect(checkOf(smokeInput(), 'generator_cpu').actual).toBe(18);
  expect(checkOf(smokeInput(), 'clock_offset').actual).toEqual({ before: 7, after: -12 });
});

test('PERF-001 the backend checks pass and fail at their limits: state, output, 128 MiB peak, 50 percent CPU, and 16 MiB growth', () => {
  // covers: AC-6 (backend_running, backend_output, backend_memory_peak, backend_cpu_mean, backend_memory_growth)
  const ok = (input: ObservationInput, name: string) => checkOf(input, name).ok;
  for (const state of [{ running: false, restarts: 0, oomKilled: false }, { running: true, restarts: 1, oomKilled: false }, { running: true, restarts: 0, oomKilled: true }, null]) {
    expect(ok(smokeInput({ backendState: state }), 'backend_running'), JSON.stringify(state)).toBe(false);
  }
  for (const logs of [
    { stdout: EXPECTED_BACKEND_STDOUT, stderrBytes: 1 },
    { stdout: 'Backend listening at http://127.0.0.1:8888\n', stderrBytes: 0 },
    { stdout: `${EXPECTED_BACKEND_STDOUT}extra\n`, stderrBytes: 0 },
    null,
  ]) {
    expect(ok(smokeInput({ backendLogs: logs }), 'backend_output'), JSON.stringify(logs)).toBe(false);
  }
  expect(EXPECTED_BACKEND_STDOUT).toBe('Backend listening at http://127.0.0.1:8888\nBackend stopped\n');
  expect(ok(withSample(smokeInput(), 'backend', { t: T0 + 20_500, cpu: 5, memoryMiB: 128 }), 'backend_memory_peak')).toBe(true);
  expect(ok(withSample(smokeInput(), 'backend', { t: T0 + 20_500, cpu: 5, memoryMiB: 128.01 }), 'backend_memory_peak')).toBe(false);
  // A peak before T0 counts: the maximum is over every sample of the run.
  expect(ok(withSample(smokeInput(), 'backend', { t: T0 - 4_500, cpu: 5, memoryMiB: 200 }), 'backend_memory_peak')).toBe(false);
  // Smoke has no CPU or growth check.
  expect(checkOf(smokeInput(), 'backend_cpu_mean')).toBeUndefined();

  // Load: the mean backend CPU over steady.
  const loadPhases: ObservedPhase[] = [
    { name: 'warmup', start: T0, end: T0 + 60_000, target: null },
    { name: 'steady', start: T0 + 60_000, end: T0 + 660_000, target: 'normal' },
  ];
  const load = (cpu: number): ObservationInput =>
    smokeInput({
      profile: 'load',
      phases: loadPhases,
      containers: { postgres: series(T0, T0 + 660_000, 1, 40), backend: [...series(T0, T0 + 59_000, 95, 60), ...series(T0 + 60_000, T0 + 660_000, cpu, 60)], k6: series(T0, T0 + 660_000, 50, 100) },
      pool: poolSeries(T0, T0 + 660_000),
    });
  expect(checkOf(load(50), 'backend_cpu_mean')).toMatchObject({ ok: true, actual: 50 });
  expect(checkOf(load(50.01), 'backend_cpu_mean').ok).toBe(false);
  expect(observationChecks(load(50)).map((check) => check.name)).toContain('backend_cpu_mean');
  expect(observationChecks(load(50)).map((check) => check.name)).not.toContain('backend_memory_growth');

  // Soak: the mean of the last 600 s of steady minus the mean of seconds 300 to 900 of steady.
  const steadyStart = T0 + 60_000;
  const steadyEnd = steadyStart + 3_600_000;
  const soak = (late: number): ObservationInput =>
    smokeInput({
      profile: 'soak',
      phases: [{ name: 'warmup', start: T0, end: steadyStart, target: null }, { name: 'steady', start: steadyStart, end: steadyEnd, target: 'normal' }],
      containers: {
        postgres: series(T0, steadyEnd, 1, 40, 5_000),
        backend: times(T0, steadyEnd, 5_000).map((t) => ({ t, cpu: 10, memoryMiB: t >= steadyEnd - 600_000 ? late : 60 })),
        k6: series(T0, steadyEnd, 50, 100, 5_000),
      },
      pool: poolSeries(T0, steadyEnd, undefined, 5_000),
    });
  expect(memoryGrowthMiB(soak(76))).toBe(16);
  expect(checkOf(soak(76), 'backend_memory_growth').ok).toBe(true);
  expect(checkOf(soak(76.01), 'backend_memory_growth').ok).toBe(false);
  expect(observationSummary(soak(76), observationChecks(soak(76))).containers.backend.memoryGrowthMiB).toBe(16);
  expect(observationChecks(soak(76)).map((check) => check.name)).toEqual(expect.arrayContaining(['backend_cpu_mean', 'backend_memory_growth']));

  // Only the two windows count: 200 MiB before second 300 and 70 MiB between second 900 and the last 600 s are outside
  // both, and the last 600 s hold 300 s at 100 MiB then 300 s back at 60 MiB, so a shorter late window would miss them.
  const windowed = smokeInput({
    ...soak(60),
    containers: {
      ...soak(60).containers,
      backend: times(T0, steadyEnd, 5_000).map((t) => {
        const since = t - steadyStart;
        const memoryMiB = since < 300_000 ? 200 : since <= 900_000 ? 60 : t < steadyEnd - 600_000 ? 70 : t < steadyEnd - 300_000 ? 100 : 60;
        return { t, cpu: 10, memoryMiB };
      }),
    },
  });
  const lateMean = (60 * 100 + 61 * 60) / 121;
  expect(memoryGrowthMiB(windowed)).toBeCloseTo(lateMean - 60, 9);
  expect(checkOf(windowed, 'backend_memory_growth')).toMatchObject({ ok: false, actual: Math.round((lateMean - 60) * 100) / 100 });
});

test('PERF-001 the pool checks pass at 5 sessions and 1 active session and fail at 6 and 2; outage needs a reconnect in after', () => {
  // covers: AC-6 (pool_sessions, pool_non_idle, pool_reconnect), AC-7 (pool tersambung lagi)
  const withPool = (sample: PoolSample) => smokeInput({ pool: [...smokeInput().pool, sample] });
  expect(checkOf(withPool({ t: T0 + 20_500, sessions: 5, nonIdle: 1, total: 9 }), 'pool_sessions')).toMatchObject({ ok: true, actual: 5 });
  expect(checkOf(withPool({ t: T0 + 20_500, sessions: 6, nonIdle: 1, total: 9 }), 'pool_sessions')).toMatchObject({ ok: false, actual: 6 });
  expect(checkOf(withPool({ t: T0 + 20_500, sessions: 5, nonIdle: 1, total: 9 }), 'pool_non_idle').ok).toBe(true);
  expect(checkOf(withPool({ t: T0 + 20_500, sessions: 5, nonIdle: 2, total: 9 }), 'pool_non_idle')).toMatchObject({ ok: false, actual: 2 });
  // A failed sample counts for neither check.
  expect(checkOf(withPool({ t: T0 + 20_500, unavailable: true }), 'pool_sessions').ok).toBe(true);
  // No successful sample at all is no proof.
  expect(checkOf(smokeInput({ pool: [{ t: T0, unavailable: true }] }), 'pool_sessions').ok).toBe(false);

  const outagePhases = observedPhases('outage', T0);
  const outage = (pool: PoolSample[]) =>
    smokeInput({
      profile: 'outage',
      phases: outagePhases,
      containers: { postgres: series(T0, T0 + 220_000, 1, 40), backend: series(T0, T0 + 220_000, 5, 60), k6: series(T0, T0 + 220_000, 50, 100) },
      pool,
    });
  const before = poolSeries(T0, T0 + 89_000);
  expect(checkOf(outage([...before, ...poolSeries(T0 + 152_000, T0 + 220_000)]), 'pool_reconnect')).toMatchObject({ ok: true });
  expect(checkOf(outage([...before, ...poolSeries(T0 + 152_000, T0 + 220_000, { sessions: 0, nonIdle: 0, total: 1 })]), 'pool_reconnect')).toMatchObject({ ok: false, actual: 0 });
});

test('PERF-001 the generator checks pass at 240 percent and 1638 MiB and fail above, with the reason generator_saturated', () => {
  // covers: AC-5 (generator diamati; generator_saturated)
  expect<number[]>([OBSERVATION_LIMITS.generatorCpu, OBSERVATION_LIMITS.generatorMemoryMiB]).toEqual([(80 * Number(CONTAINER_LIMITS.k6.cpus) * 100) / 100, Math.floor((80 * 2048) / 100)]);
  const k6 = (cpu: number, memoryMiB: number) => smokeInput({ containers: { ...smokeInput().containers, k6: series(T0 - 5_000, T0 + 41_000, cpu, memoryMiB) } });
  expect(checkOf(k6(240, 1_638), 'generator_cpu').ok).toBe(true);
  expect(checkOf(k6(240, 1_638), 'generator_memory').ok).toBe(true);
  expect(observationReasons(observationChecks(k6(240.01, 1_638)), null)).toEqual([{ code: 'generator_saturated', detail: 'generator_cpu' }]);
  expect(observationReasons(observationChecks(k6(240, 1_638.5)), null)).toEqual([{ code: 'generator_saturated', detail: 'generator_memory' }]);
  // Only measured phases count for CPU: a warmup spike does not, a steady mean above the limit does.
  const spike = withSample(k6(100, 100), 'k6', { t: T0 + 5_000, cpu: 2_000, memoryMiB: 100 });
  expect(checkOf(spike, 'generator_cpu')).toMatchObject({ ok: true, actual: 100 });
  // A measured phase without k6 samples is no proof: the check fails.
  const silent = smokeInput({ containers: { ...smokeInput().containers, k6: series(T0 - 5_000, T0 + 9_000, 18, 39) } });
  expect(checkOf(silent, 'generator_cpu')).toMatchObject({ ok: false, actual: null });
});

test('PERF-001 observation_coverage judges sample counts, the 15 second gaps with edge gaps, and the 10 second pg_stat_activity gaps', () => {
  // covers: AC-6 (cakupan sampel, celah tepi awal dan akhir fase, celah 15 detik, celah pg_stat_activity)
  const backend = (samples: ContainerSample[]) => smokeInput({ containers: { ...smokeInput().containers, backend: samples } });
  const steadyStart = T0 + 10_000;
  const steadyEnd = T0 + 40_000;
  expect(coverageFailures(smokeInput())).toEqual([]);
  // Exactly floor(30 / 5) = 6 samples with gaps of 5 s passes; 5 samples fail on the count.
  expect(coverageFailures(backend(series(steadyStart + 2_500, steadyEnd, 5, 60, 5_000)))).toEqual([]);
  expect(coverageFailures(backend(series(steadyStart + 2_500, steadyEnd - 5_000, 5, 60, 5_000)))).toEqual(['backend steady: 5 sampel, minimal 6']);
  // Start edge gap: 15000 ms passes, 15001 ms fails.
  expect(coverageFailures(backend(series(steadyStart + 15_000, steadyEnd, 5, 60)))).toEqual([]);
  expect(coverageFailures(backend(series(steadyStart + 15_001, steadyEnd + 999, 5, 60)))).toEqual(['backend steady: celah 15001 ms']);
  // End edge gap.
  expect(coverageFailures(backend(series(steadyStart + 999, steadyEnd - 15_001, 5, 60)))).toEqual(['backend steady: celah 15001 ms']);
  expect(coverageFailures(backend(series(steadyStart + 1_000, steadyEnd - 15_000, 5, 60)))).toEqual([]);
  // A gap inside the phase.
  const holed = smokeInput().containers.backend.filter((sample) => sample.t < steadyStart + 5_000 || sample.t > steadyStart + 21_000);
  expect(coverageFailures(backend(holed))).toEqual(['backend steady: celah 18000 ms']);
  // A sample whose value is not a number does not count.
  expect(coverageFailures(backend(series(T0 - 5_000, T0 + 41_000, null, null)))).toEqual(['backend steady: 0 sampel, minimal 6', 'backend steady: celah 30000 ms']);
  // pg_stat_activity: T0, the successful samples, and the end of the last phase; 10000 ms passes, 10001 ms fails.
  const pool = (samples: PoolSample[]) => smokeInput({ pool: samples });
  expect(coverageFailures(pool([...poolSeries(T0 + 10_000, T0 + 30_000, undefined, 10_000)]))).toEqual([]);
  expect(coverageFailures(pool([...poolSeries(T0 + 10_001, T0 + 40_000, undefined, 1_000)]))).toEqual(['pg_stat_activity: celah 10001 ms']);
  expect(coverageFailures(pool([...poolSeries(T0, T0 + 20_000), { t: T0 + 25_000, unavailable: true }]))).toEqual(['pg_stat_activity: celah 20000 ms']);
  expect(checkOf(pool([]), 'observation_coverage')).toMatchObject({ ok: false, actual: ['pg_stat_activity: celah 40000 ms'] });

  // Outage: PostgreSQL is not judged on stopping, outage, and recovering, and a pg_stat_activity gap that touches the
  // joined window [start of stopping, end of recovering] is excluded; a gap elsewhere still fails.
  const outage = (postgres: ContainerSample[], samples: PoolSample[]) =>
    smokeInput({
      profile: 'outage',
      phases: observedPhases('outage', T0),
      containers: { postgres, backend: series(T0, T0 + 220_000, 5, 60), k6: series(T0, T0 + 220_000, 50, 100) },
      pool: samples,
    });
  const postgres = [...series(T0, T0 + 87_000, 1, 40), ...series(T0 + 161_000, T0 + 220_000, 1, 40)];
  const away = [...poolSeries(T0, T0 + 85_000), ...poolSeries(T0 + 165_000, T0 + 220_000)];
  expect(coverageFailures(outage(postgres, away))).toEqual([]);
  const quiet = [...poolSeries(T0, T0 + 40_000), ...poolSeries(T0 + 55_000, T0 + 85_000), ...poolSeries(T0 + 165_000, T0 + 220_000)];
  expect(coverageFailures(outage(postgres, quiet))).toEqual(['pg_stat_activity: celah 15000 ms']);
  // The same PostgreSQL gap on before is judged.
  expect(coverageFailures(outage([...series(T0, T0 + 40_000, 1, 40), ...series(T0 + 161_000, T0 + 220_000, 1, 40)], away))).toEqual([
    'postgres before: celah 48000 ms',
  ]);
});

test('PERF-001 clock_offset passes at 1000 ms on both measurements and fails above or without a measurement', () => {
  // covers: AC-6 (clock_offset sebelum T0 dan sesudah k6 keluar)
  const clock = (before: number | null, after: number | null) => checkOf(smokeInput({ clockOffsetMs: { before, after } }), 'clock_offset').ok;
  expect(clock(1_000, -1_000)).toBe(true);
  expect(clock(1_001, 0)).toBe(false);
  expect(clock(0, -1_001)).toBe(false);
  expect(clock(0, null)).toBe(false);
  expect(clock(null, 0)).toBe(false);
});

test('PERF-001 outage_control fails a command sent early, sent more than 1000 ms late, or done too slowly, with outage_control_late per command', () => {
  // covers: AC-7 (outage_control_late)
  const timing: OutageTiming = { stopPlannedMs: 90_000, stopIssuedMs: 90_000, stopCompletedMs: 98_000, startPlannedMs: 150_000, startIssuedMs: 151_000, startCompletedMs: 156_000 };
  expect(outageControlFailures(timing)).toEqual([]);
  const cases: [Partial<OutageTiming>, ('stop' | 'start')[]][] = [
    // Sent 1 ms early and done in 8000 ms, so only the early send can fail it.
    [{ stopIssuedMs: 89_999, stopCompletedMs: 97_999 }, ['stop']],
    [{ stopIssuedMs: 91_001, stopCompletedMs: 92_000 }, ['stop']],
    [{ stopCompletedMs: 98_001 }, ['stop']],
    [{ stopIssuedMs: null }, ['stop']],
    // Sent 1 ms early and done in 5000 ms, so only the early send can fail it.
    [{ startIssuedMs: 149_999, startCompletedMs: 154_999 }, ['start']],
    [{ startIssuedMs: 151_001, startCompletedMs: 152_000 }, ['start']],
    [{ startCompletedMs: 156_001 }, ['start']],
    [{ startCompletedMs: null, stopCompletedMs: null }, ['stop', 'start']],
  ];
  for (const [change, expected] of cases) expect(outageControlFailures({ ...timing, ...change }), JSON.stringify(change)).toEqual(expected);
  expect(outageControlFailures(null)).toEqual(['stop', 'start']);
  const outage = (value: OutageTiming | null) =>
    smokeInput({
      profile: 'outage',
      phases: observedPhases('outage', T0),
      containers: { postgres: series(T0, T0 + 220_000, 1, 40), backend: series(T0, T0 + 220_000, 5, 60), k6: series(T0, T0 + 220_000, 50, 100) },
      pool: poolSeries(T0, T0 + 220_000),
      outage: value,
    });
  expect(checkOf(outage(timing), 'outage_control').ok).toBe(true);
  const late = { ...timing, stopIssuedMs: 89_000, startCompletedMs: 157_000 };
  expect(observationReasons(observationChecks(outage(late)), late)).toEqual([
    { code: 'outage_control_late', detail: 'stop' },
    { code: 'outage_control_late', detail: 'start' },
  ]);
  expect(observationChecks(outage(timing)).map((check) => check.name)).toEqual([
    'backend_running', 'backend_output', 'backend_memory_peak', 'pool_sessions', 'pool_non_idle', 'pool_reconnect', 'generator_cpu', 'generator_memory',
    'observation_coverage', 'clock_offset', 'outage_control',
  ]);
});

test('PERF-001 the outage control sends stop at T0 + 90 s and start at T0 + 150 s by the host clock, each after its guard and never early', async () => {
  // covers: AC-7 (stop dan start terjadwal, masing masing hanya sesudah penjaga lulus, tidak pernah lebih awal dari jadwal)
  expect(outageControlArgs('stop', `foundation-perf-db-${hex}`)).toEqual(['docker', 'stop', '--time', '10', `foundation-perf-db-${hex}`]);
  expect(outageControlArgs('start', `foundation-perf-db-${hex}`)).toEqual(['docker', 'start', `foundation-perf-db-${hex}`]);
  expect(TIMEOUTS.outageControl).toBe(20_000);
  expect(OUTAGE_GUARD_LEAD_MS).toBe(TIMEOUTS.guardInspect);
  expect(plannedOutage()).toEqual({ stopPlannedMs: 90_000, stopIssuedMs: null, stopCompletedMs: null, startPlannedMs: 150_000, startIssuedMs: null, startCompletedMs: null });

  type Script = { guardMs?: number; guard?: (command: 'stop' | 'start') => boolean; send?: (command: 'stop' | 'start') => boolean; endAfter?: 'stop' };
  const control = async (script: Script = {}) => {
    let clock = T0 - 15_000;
    const events: string[] = [];
    const ended = new AbortController();
    const timing = plannedOutage();
    await runOutageControl(T0, timing, {
      now: () => clock,
      // A timer may wake a few milliseconds early; the control then waits again instead of sending early.
      sleep: async (ms) => {
        clock += Math.max(1, ms - 3);
      },
      guard: async (command) => {
        events.push(`guard ${command} ${clock - T0}`);
        clock += script.guardMs ?? 40;
        return script.guard?.(command) ?? true;
      },
      send: async (command) => {
        events.push(`send ${command} ${clock - T0}`);
        clock += command === 'stop' ? 1_500 : 600;
        const sent = script.send?.(command) ?? true;
        if (script.endAfter === command) ended.abort();
        return sent;
      },
      ended: ended.signal,
    });
    return { events, timing };
  };

  const normal = await control();
  expect(normal.events).toEqual(['guard stop 80000', 'send stop 90000', 'guard start 140000', 'send start 150000']);
  expect(normal.timing).toEqual({ stopPlannedMs: 90_000, stopIssuedMs: 90_000, stopCompletedMs: 91_500, startPlannedMs: 150_000, startIssuedMs: 150_000, startCompletedMs: 150_600 });
  expect(outageControlFailures(normal.timing)).toEqual([]);

  // A guard that takes up to its own limit still ends before the schedule; a slower one makes the send late, and the check fails.
  expect((await control({ guardMs: 10_000 })).timing.stopIssuedMs).toBe(90_000);
  const slow = await control({ guardMs: 12_000 });
  expect(slow.timing.stopIssuedMs).toBe(92_000);
  expect(outageControlFailures(slow.timing)).toEqual(['stop', 'start']);

  // A guard refusal sends nothing; a refused start leaves the stop as it was.
  const refused = await control({ guard: () => false });
  expect(refused.events).toEqual(['guard stop 80000']);
  expect(outageControlFailures(refused.timing)).toEqual(['stop', 'start']);
  const refusedStart = await control({ guard: (command) => command === 'stop' });
  expect(refusedStart.events).toEqual(['guard stop 80000', 'send stop 90000', 'guard start 140000']);
  expect(outageControlFailures(refusedStart.timing)).toEqual(['start']);

  // A failed stop keeps no end time, and start is not sent after it.
  const failed = await control({ send: (command) => command !== 'stop' });
  expect(failed.events).toEqual(['guard stop 80000', 'send stop 90000']);
  expect(failed.timing).toMatchObject({ stopIssuedMs: 90_000, stopCompletedMs: null, startIssuedMs: null });
  expect(outageControlFailures(failed.timing)).toEqual(['stop', 'start']);

  // Once k6 has exited, nothing more is sent.
  const early = await control({ endAfter: 'stop' });
  expect(early.events).toEqual(['guard stop 80000', 'send stop 90000']);
  expect(outageControlFailures(early.timing)).toEqual(['start']);

  // An end while waiting releases the control at once, with real timers of at most 1000 ms each.
  const ended = new AbortController();
  const started = Date.now();
  const waiting = runOutageControl(Date.now(), plannedOutage(), {
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    guard: async () => true,
    send: async () => true,
    ended: ended.signal,
  });
  setTimeout(() => ended.abort(), 50);
  await waiting;
  expect(Date.now() - started).toBeLessThan(1_000);
});

test('PERF-001 a failure forced through a small limit records observation_failed or generator_saturated with the check name', () => {
  // covers: AC-6 (kegagalan yang disengaja lewat parameter fungsi murni tercatat dengan kode yang benar)
  const limits = { ...OBSERVATION_LIMITS, backendMemoryPeakMiB: 1, generatorCpu: 1, poolNonIdle: 0, clockOffsetMs: 5 };
  const checks = observationChecks(smokeInput(), limits);
  expect(observationReasons(checks, null)).toEqual([
    { code: 'observation_failed', detail: 'backend_memory_peak' },
    { code: 'observation_failed', detail: 'pool_non_idle' },
    { code: 'generator_saturated', detail: 'generator_cpu' },
    { code: 'observation_failed', detail: 'clock_offset' },
  ]);
  expect(checks.find((check) => check.name === 'backend_memory_peak')).toEqual({ name: 'backend_memory_peak', rule: 'memory backend maksimum <= 1 MiB', actual: 60, ok: false });
  // An observation without any sample fails every sample check.
  const none = smokeInput({ containers: { postgres: [], backend: [], k6: [] }, pool: [] });
  expect(observationReasons(observationChecks(none), null).map((item) => `${item.code} ${item.detail}`)).toEqual([
    'observation_failed backend_memory_peak',
    'observation_failed pool_sessions',
    'observation_failed pool_non_idle',
    'generator_saturated generator_cpu',
    'generator_saturated generator_memory',
    'observation_failed observation_coverage',
  ]);
});

test('PERF-001 the observation summary holds per container means and maxima, the backend state, the pool maxima, and the checks', () => {
  // covers: AC-6 (observation di result.json)
  const input = smokeInput({
    pool: [...smokeInput().pool, { t: T0 + 20_500, unavailable: true }, { t: T0 + 21_500, sessions: 3, nonIdle: 0, total: 6 }],
    backendLogs: { stdout: EXPECTED_BACKEND_STDOUT, stderrBytes: 0 },
  });
  const checks = observationChecks(input);
  const summary = observationSummary(input, checks);
  expect(summary.containers.backend).toEqual({ cpuMean: 5, cpuMax: 5, memoryMeanMiB: 60, memoryMaxMiB: 60, memoryGrowthMiB: null, restarts: 0, oomKilled: false, stderrBytes: 0 });
  expect(summary.containers.k6).toEqual({ cpuMean: 18, cpuMax: 18, memoryMeanMiB: 39, memoryMaxMiB: 39, memoryGrowthMiB: null, restarts: null, oomKilled: null, stderrBytes: null });
  expect(summary.pool).toEqual({ sessions: 3, nonIdle: 1, total: 6, samples: input.pool.length - 1, failedSamples: 1 });
  expect(summary.checks).toBe(checks);
  // The mean covers T0 to the end of the last phase; the maximum every sample.
  const early = withSample(input, 'k6', { t: T0 - 4_500, cpu: 90, memoryMiB: 39 });
  expect(observationSummary(early, checks).containers.k6).toMatchObject({ cpuMean: 18, cpuMax: 90 });
});

test('PERF-001 the backend state, the other foundation.test containers, and the environment block read only what the spec names', () => {
  // covers: AC-2 (environment_busy sesudah k6 mengabaikan container run ini), AC-10 (environment dengan key containerEngine)
  expect(parseBackendState('true 0 false\n')).toEqual({ running: true, restarts: 0, oomKilled: false });
  expect(parseBackendState('false 2 true')).toEqual({ running: false, restarts: 2, oomKilled: true });
  for (const text of ['', 'true', 'yes 0 no', 'true -1 false', 'true 0 false extra']) expect(parseBackendState(text), text).toBeNull();
  const listed = [`foundation-perf-db-${hex} performance ${hex}`, 'foundation-readiness-0123abcd readiness ', 'foundation-perf-db-ba9876543210 performance ba9876543210', ''].join('\n');
  expect(otherTestContainers(listed, hex)).toEqual(['foundation-readiness-0123abcd readiness', 'foundation-perf-db-ba9876543210 performance']);
  expect(otherTestContainers(`foundation-perf-k6-${hex} performance ${hex}\n`, hex)).toEqual([]);

  const environment = hostEnvironment({ CI: 'true' });
  expect(Object.keys(environment)).toEqual(['os', 'arch', 'cpuModel', 'cpuCount', 'memoryBytes', 'containerEngine', 'otherContainersRunning', 'ci', 'images', 'limits', 'pool', 'data', 'clockOffsetMs']);
  expect(Object.keys(environment.containerEngine)).toEqual(['serverVersion', 'os', 'ncpu', 'memTotal']);
  expect(environment.ci).toBe(true);
  expect(hostEnvironment({}).ci).toBe(false);
  expect(hostEnvironment({ CI: '' }).ci).toBe(true);
  expect(environment.cpuCount).toBeGreaterThan(0);
  expect(environment.memoryBytes).toBeGreaterThan(0);
  expect(environment.limits).toEqual(CONTAINER_LIMITS);
  expect(environment.pool).toEqual({ max: 5, connectionTimeoutSeconds: 3 });
  expect(BACKEND_POOL).toEqual(environment.pool);
  expect(environment.images).toEqual({ k6: null, bun: null, postgres: { image: 'foundation-postgres:18-pinned', imageId: null, baseImage: null, serverVersion: null } });
  expect(environment.clockOffsetMs).toEqual({ before: null, after: null });
  // The neutral key only: no key of the block names the container engine product.
  const keys = JSON.stringify(environment, (_key, value) => value).match(/"[A-Za-z]+":/g) ?? [];
  for (const key of keys) expect(key.toLowerCase(), key).not.toContain('docker');
});

test('PERF-001 Batas bukti is written as is with the migration count, and a full result.json holds every reading', async () => {
  // covers: AC-5, AC-6, AC-10 (limits dan isi result.json)
  expect(evidenceLimits(1)).toEqual([
    'Alur yang diukur adalah diagnostik komposisi development, `GET /api/status` dan `GET /api/readiness`; komposisi production tidak memasang route apa pun dan belum ada endpoint bisnis.',
    'Backend berjalan sebagai satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount, bukan image deployment fitur 13.',
    'k6 dan backend berbagi network namespace loopback; tidak ada reverse proxy, TLS, atau latency jaringan nyata.',
    'Data hanya riwayat migration (1 baris); tidak ada tabel bisnis.',
    'Mesin dipakai bersama (Docker Desktop di macOS bersama container lain, atau runner GitHub hosted); hasil hanya sebanding dengan run pada kelas environment yang sama.',
    'Batas kapasitas (breakpoint) tidak dicari; hasil membuktikan beban yang disepakati, bukan titik jenuh.',
  ]);
  const summary = await readFixture('summary-smoke.json');
  const t0 = (summary['setup_data'] as { t0: number }).t0;
  const reading = readSummary(summary, 'smoke', t0)!;
  const input = smokeInput();
  const observation = observationSummary(input, observationChecks(input));
  const environment = hostEnvironment({});
  const result = buildResult({ profile: 'smoke', reasons: [], startedAt: 'a', finishedAt: 'b', t0, reading, observation, environment, appliedMigrations: 1 });
  expect(result.status).toBe('passed');
  expect(result.actual).toBe(reading.actual);
  expect([result.latency, result.readiness, result.thresholds]).toEqual([reading.latency, reading.readiness, reading.thresholds]);
  expect(result.observation).toBe(observation);
  expect(result.outage).toBeNull();
  expect(result.environment).toBe(environment);
  expect(result.limits).toEqual(evidenceLimits(1));
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test('PERF-001 observation.json holds the phase windows in host epoch ms and every kept sample', () => {
  // covers: AC-6 (observation.json)
  const input = smokeInput();
  const file = buildObservationFile('smoke', T0, { postgres: [...input.containers.postgres], backend: [...input.containers.backend], k6: [...input.containers.k6] }, [...input.pool]);
  expect(Object.keys(file)).toEqual(['schema', 'profile', 't0', 'phases', 'samples']);
  expect(file.phases).toEqual([
    { name: 'warmup', start: T0, end: T0 + 10_000, target: null, measured: false },
    { name: 'steady', start: T0 + 10_000, end: T0 + 40_000, target: 'normal', measured: true },
  ]);
  expect(Object.keys(file.samples)).toEqual(['containers', 'postgres']);
  expect(file.samples.containers.backend).toHaveLength(input.containers.backend.length);
  expect(file.samples.postgres).toHaveLength(input.pool.length);
  expect(buildObservationFile('smoke', null, { postgres: [], backend: [], k6: [] }, []).phases).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// The k6 scripts themselves (`journeys/`, `metrics.ts`, `lifecycle.ts`), added by /test. The real smoke summary shows
// how k6 2.3.0 recorded the checks and custom metrics; the stand ins of the k6 modules below let Bun run the journeys
// and the lifecycle as k6 would, so the request timeout, the phase at the request start, the recovery per VU, and the
// setup validation are checked without a container. Only the k6 modules are replaced; plan.ts, expectations.ts, and the
// journeys run as they are.

type SummaryMetric = { type: string; contains: string; values: Record<string, number> };

test('PERF-001 the real smoke summary holds one check and one metric sample per request, with the metric kinds of Metrik khusus', async () => {
  // covers: AC-3 (setiap respons diperiksa satu check), AC-5 (metrik khusus per fase dan hasil)
  const summary = await readFixture('summary-smoke.json');
  const metrics = summary['metrics'] as Record<string, SummaryMetric>;
  const count = (key: string) => metrics[key]?.values['count'] ?? 0;
  const planned = plannedScenarios('smoke');

  // Every request ran the check of its endpoint once, and every check passed.
  const checks = (summary['root_group'] as { checks: Array<{ name: string; passes: number; fails: number }> }).checks;
  const iterationsOf = (endpoint: string) => planned.filter((item) => item.endpoint === endpoint).reduce((sum, item) => sum + count(`iterations{scenario:${item.name}}`), 0);
  expect(checks.map((item) => [item.name, item.passes, item.fails])).toEqual([
    [checkName('status'), iterationsOf('status'), 0],
    [checkName('readiness'), iterationsOf('readiness'), 0],
  ]);
  expect(metrics['checks']?.values['passes']).toBe(count('iterations'));

  // Each request carries the phase of its scenario: one status latency sample and one readiness outcome per iteration.
  for (const item of planned) {
    const iterations = count(`iterations{scenario:${item.name}}`);
    expect(iterations, item.name).toBeGreaterThan(0);
    if (item.endpoint === 'status') {
      expect(count(`http_req_duration{endpoint:status,phase:${item.phase}}`), item.name).toBe(iterations);
      continue;
    }
    const outcomes = ['available', 'busy', 'unavailable'].map((outcome) => count(`readiness_${outcome}_duration{phase:${item.phase}}`));
    expect(outcomes.reduce((sum, value) => sum + value, 0), item.name).toBe(iterations);
  }
  // The readiness rate counts a 200 as available, and a 429 or 503 as not available.
  const steady = metrics['readiness_available{phase:steady}']!.values;
  expect(steady['passes']).toBe(count('readiness_available_duration{phase:steady}'));
  expect(steady['fails']).toBe(count('readiness_busy_duration{phase:steady}') + count('readiness_unavailable_duration{phase:steady}'));

  // The kinds k6 recorded for the custom metrics: a counter, a rate, and trends that hold time.
  const kinds = (keys: string[]) => keys.map((key) => [key, metrics[key]?.type, metrics[key]?.contains]);
  expect(kinds(['unexpected_responses', 'readiness_available', 'readiness_available_duration', 'readiness_busy_duration', 'readiness_unavailable_duration'])).toEqual([
    ['unexpected_responses', 'counter', 'default'],
    ['readiness_available', 'rate', 'default'],
    ['readiness_available_duration', 'trend', 'time'],
    ['readiness_busy_duration', 'trend', 'time'],
    ['readiness_unavailable_duration', 'trend', 'time'],
  ]);
  expect(count('unexpected_responses')).toBe(0);
});

type K6Response = { status: number; headers: Record<string, string>; body: string | null; timings: { duration: number } };
type K6Call =
  | { kind: 'get'; url: string; params: unknown }
  | { kind: 'check'; value: unknown; names: string[]; passed: boolean; tags: unknown }
  | { kind: 'add'; metric: string; value: unknown; tags: unknown }
  | { kind: 'sleep'; seconds: number };
type K6State = {
  calls: K6Call[];
  created: Array<{ kind: string; name: string; isTime: boolean }>;
  scenario: string;
  respond: (url: string) => K6Response;
};
type Journeys = {
  statusJourney?: (profile: ProfileName, data: RunData) => void;
  readinessJourney?: (profile: ProfileName, data: RunData) => void;
};
type Lifecycle = { setupRun: () => RunData; writeSummary: (data: unknown) => Record<string, string> };

const k6State: K6State = { calls: [], created: [], scenario: '', respond: () => ({ status: 0, headers: {}, body: null, timings: { duration: 0 } }) };
let k6Registered = false;

/** Replaces the four k6 modules once with stand ins that record every call into `k6State`. */
function standInK6(): K6State {
  if (k6Registered) return k6State;
  k6Registered = true;
  mock.module('k6', () => ({
    check: (value: unknown, sets: Record<string, (value: unknown) => boolean>, tags?: unknown) => {
      const passed = Object.values(sets).every((predicate) => predicate(value));
      k6State.calls.push({ kind: 'check', value, names: Object.keys(sets), passed, tags });
      return passed;
    },
    sleep: (seconds: number) => {
      k6State.calls.push({ kind: 'sleep', seconds });
      Bun.sleepSync(seconds * 1_000);
    },
  }));
  mock.module('k6/http', () => ({
    default: {
      get: (url: string, params: unknown) => {
        k6State.calls.push({ kind: 'get', url, params });
        return k6State.respond(url);
      },
    },
  }));
  mock.module('k6/execution', () => ({
    default: {
      get scenario() {
        return { name: k6State.scenario };
      },
    },
  }));
  const metric = (kind: string) =>
    class {
      readonly name: string;
      constructor(name: string, isTime?: boolean) {
        this.name = name;
        k6State.created.push({ kind, name, isTime: isTime === true });
      }
      add(value: unknown, tags?: unknown) {
        k6State.calls.push({ kind: 'add', metric: this.name, value, tags });
      }
    };
  mock.module('k6/metrics', () => ({ Counter: metric('Counter'), Rate: metric('Rate'), Trend: metric('Trend') }));
  return k6State;
}

/** One journey module as one k6 VU: every VU has its own JavaScript runtime, so `vu` gives a fresh module instance. */
async function journeyModule(name: 'status' | 'readiness', vu: string): Promise<Journeys> {
  standInK6();
  // The path is computed, so tsc does not follow it into the k6 scripts, which have no k6 types installed.
  return (await import(`${join(root, 'tests/performance/journeys', `${name}.ts`)}?vu=${vu}`)) as Journeys;
}

function reset(scenario: string, respond: K6State['respond']): void {
  k6State.calls = [];
  k6State.scenario = scenario;
  k6State.respond = respond;
}

const k6Response = (status: number, headers: Record<string, string>, body: string | null, duration: number): K6Response => ({ status, headers, body, timings: { duration } });

test('PERF-001 metrics.ts creates the custom metrics of Metrik khusus, and every trend holds time', async () => {
  // covers: AC-5 (metrik khusus), AC-7 (readiness_recovery_ms sebagai trend waktu)
  const state = standInK6();
  await journeyModule('readiness', 'metrics');
  expect(state.created).toEqual([
    { kind: 'Counter', name: 'unexpected_responses', isTime: false },
    { kind: 'Rate', name: 'readiness_available', isTime: false },
    { kind: 'Counter', name: 'readiness_unavailable', isTime: false },
    { kind: 'Trend', name: 'readiness_available_duration', isTime: true },
    { kind: 'Trend', name: 'readiness_busy_duration', isTime: true },
    { kind: 'Trend', name: 'readiness_unavailable_duration', isTime: true },
    { kind: 'Trend', name: 'readiness_recovery_ms', isTime: true },
  ]);
});

test('PERF-001 the status journey sends one GET with the 10 second timeout and the endpoint and phase tags, and counts a transport failure as unexpected', async () => {
  // covers: AC-3 (status selalu 200; status 0 atau timeout request 10 detik menggagalkan check dan menambah unexpected_responses)
  expect(REQUEST_TIMEOUT).toBe('10s');
  const { statusJourney } = await journeyModule('status', 'status');
  const data: RunData = { startedAt: 1, t0: 1, expectedMigrations: 1 };
  const tags = { endpoint: 'status', phase: 'steady' };

  reset('status_steady', () => k6Response(200, {}, '{"status":"ok"}', 1.5));
  statusJourney!('smoke', data);
  expect(k6State.calls).toEqual([
    { kind: 'get', url: `${BASE_URL}/api/status`, params: { timeout: '10s', tags } },
    { kind: 'check', value: 'ok', names: [checkName('status')], passed: true, tags },
  ]);

  // A transport failure (status 0, a refused connection or the request timeout) and a wrong body both fail the check.
  for (const [label, response] of [
    ['status 0', k6Response(0, {}, null, 10_000)],
    ['wrong body', k6Response(200, {}, '{"status":"busy"}', 1)],
    ['503', k6Response(503, {}, '{"status":"ok"}', 1)],
  ] as const) {
    reset('status_warmup', () => response);
    statusJourney!('load', data);
    const warmup = { endpoint: 'status', phase: 'warmup' };
    expect(k6State.calls.slice(1), label).toEqual([
      { kind: 'check', value: 'rejected', names: [checkName('status')], passed: false, tags: warmup },
      { kind: 'add', metric: 'unexpected_responses', value: 1, tags: warmup },
    ]);
  }
});

test('PERF-001 the readiness journey judges each response in the phase its request started in, and records the recovery once per VU on outage only', async () => {
  // covers: AC-3 (klasifikasi readiness), AC-7 (fase saat request dimulai, readiness_recovery_ms)
  const t0 = 1_791_000_000_000;
  const data: RunData = { startedAt: t0, t0, expectedMigrations: 1 };
  let clock = t0;
  const now = spyOn(Date, 'now').mockImplementation(() => clock);
  /** A request that starts at `fromMs` after T0 and is answered at `toMs` after T0. */
  const request = (fromMs: number, toMs: number, status: number, body: string | null) => {
    clock = t0 + fromMs;
    reset('readiness_timeline', () => {
      clock = t0 + toMs;
      return k6Response(status, noStore, body, toMs - fromMs);
    });
  };
  const adds = () => k6State.calls.filter((call) => call.kind === 'add');
  const phaseOf = () => (k6State.calls[0] as { params: { tags: { phase: string } } }).params.tags.phase;
  try {
    const vu1 = (await journeyModule('readiness', 'outage-1')).readinessJourney!;

    // Started in stopping, answered 503 after the outage began: judged in stopping, where 503 is allowed.
    request(100_500, 101_200, 503, unavailable);
    vu1('outage', data);
    // The check passes for every outcome but rejected: an expected 503 is not a failed check.
    const readinessCheck = () => k6State.calls.find((call) => call.kind === 'check');
    expect(readinessCheck()).toEqual({ kind: 'check', value: 'unavailable', names: [checkName('readiness')], passed: true, tags: { endpoint: 'readiness', phase: 'stopping' } });
    expect(k6State.calls[0]).toEqual({ kind: 'get', url: `${BASE_URL}/api/readiness`, params: { timeout: '10s', tags: { endpoint: 'readiness', phase: 'stopping' } } });
    expect(adds()).toEqual([
      { kind: 'add', metric: 'readiness_available', value: false, tags: { phase: 'stopping' } },
      { kind: 'add', metric: 'readiness_unavailable', value: 1, tags: { phase: 'stopping' } },
      { kind: 'add', metric: 'readiness_unavailable_duration', value: 700, tags: { phase: 'stopping' } },
    ]);

    // Started in outage, answered 200 after recovering began: judged in outage, where 200 is rejected.
    request(144_900, 145_100, 200, available(1));
    vu1('outage', data);
    expect(phaseOf()).toBe('outage');
    expect(k6State.calls.find((call) => call.kind === 'check')).toMatchObject({ value: 'rejected', passed: false });
    expect(adds()).toEqual([{ kind: 'add', metric: 'unexpected_responses', value: 1, tags: { endpoint: 'readiness', phase: 'outage' } }]);

    // Started in recovering before the start, answered 200 at T0 + 150200: available, and the recovery is 200 ms.
    request(149_900, 150_200, 200, available(1));
    vu1('outage', data);
    expect(phaseOf()).toBe('recovering');
    expect(readinessCheck()).toMatchObject({ value: 'available', passed: true });
    expect(adds()).toEqual([
      { kind: 'add', metric: 'readiness_available', value: true, tags: { phase: 'recovering' } },
      { kind: 'add', metric: 'readiness_available_duration', value: 300, tags: { phase: 'recovering' } },
      { kind: 'add', metric: 'readiness_recovery_ms', value: 200, tags: undefined },
    ]);

    // The same VU never records a second recovery.
    request(151_000, 151_004, 200, available(1));
    vu1('outage', data);
    expect(adds().map((call) => (call as { metric: string }).metric)).toEqual(['readiness_available', 'readiness_available_duration']);

    // Another VU records its own first 200, whenever it arrives.
    const vu2 = (await journeyModule('readiness', 'outage-2')).readinessJourney!;
    request(160_000, 160_004, 200, available(1));
    vu2('outage', data);
    expect(phaseOf()).toBe('after');
    expect(adds().at(-1)).toEqual({ kind: 'add', metric: 'readiness_recovery_ms', value: 10_004, tags: undefined });

    // A 429 after the start is busy, never a recovery.
    const vu3 = (await journeyModule('readiness', 'outage-3')).readinessJourney!;
    request(152_000, 152_001, 429, busy);
    vu3('outage', data);
    expect(readinessCheck()).toMatchObject({ value: 'busy', passed: true });
    expect(adds().map((call) => (call as { metric: string }).metric)).toEqual(['readiness_available', 'readiness_busy_duration']);

    // On every other profile the phase is the scenario suffix and no recovery is recorded.
    const load = (await journeyModule('readiness', 'load')).readinessJourney!;
    request(160_000, 160_002, 200, available(1));
    k6State.scenario = 'readiness_steady';
    load('load', data);
    expect(phaseOf()).toBe('steady');
    expect(adds().map((call) => (call as { metric: string }).metric)).toEqual(['readiness_available', 'readiness_available_duration']);

    // A 200 whose migration count differs from the setup data is rejected, so a stale database never counts as ready.
    request(160_000, 160_002, 200, available(2));
    k6State.scenario = 'readiness_steady';
    load('load', data);
    expect(adds()).toEqual([{ kind: 'add', metric: 'unexpected_responses', value: 1, tags: { endpoint: 'readiness', phase: 'steady' } }]);
  } finally {
    now.mockRestore();
  }
});

test('PERF-001 setupRun reads the run variables only when called, waits until T0, and refuses an invalid value; writeSummary writes the summary and one fixed line', async () => {
  // covers: AC-1 (variable run hanya dibaca dan divalidasi di setup; setup yang gagal membuat k6 keluar dengan galat script)
  standInK6();
  const global = globalThis as Record<string, unknown>;
  delete global['__ENV'];
  // Loading the module reads no variable: there is no __ENV yet.
  const lifecycle = (await import(join(root, 'tests/performance/helpers/lifecycle.ts'))) as Lifecycle;
  try {
    const t0 = Date.now() + 150;
    global['__ENV'] = { FOUNDATION_PERF_T0: String(t0), FOUNDATION_PERF_EXPECTED_MIGRATIONS: '2' };
    k6State.calls = [];
    const data = lifecycle.setupRun();
    expect([data.t0, data.expectedMigrations]).toEqual([t0, 2]);
    expect(data.startedAt).toBeGreaterThanOrEqual(t0);
    expect(data.startedAt - t0).toBeLessThan(2_000);
    const sleeps = k6State.calls.filter((call) => call.kind === 'sleep') as Array<{ seconds: number }>;
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[0]!.seconds).toBeGreaterThan(0);
    expect(sleeps[0]!.seconds).toBeLessThanOrEqual(0.15);

    // A T0 already in the past starts at once, and startedAt is the clock when setup ends, not T0: this is what
    // phase_start_late judges, so a late start must stay visible.
    const past = Date.now() - 5_000;
    global['__ENV'] = { FOUNDATION_PERF_T0: String(past), FOUNDATION_PERF_EXPECTED_MIGRATIONS: '0' };
    k6State.calls = [];
    const before = Date.now();
    const late = lifecycle.setupRun();
    const after = Date.now();
    expect([late.t0, late.expectedMigrations]).toEqual([past, 0]);
    expect(late.startedAt).toBeGreaterThanOrEqual(before);
    expect(late.startedAt).toBeLessThanOrEqual(after);
    expect(late.startedAt - late.t0).toBeGreaterThanOrEqual(5_000);
    expect(k6State.calls).toEqual([]);

    // An invalid value throws, so setup() fails and k6 exits with a script error, never with 0 or 99.
    for (const [variables, invalid] of [
      [{ FOUNDATION_PERF_EXPECTED_MIGRATIONS: '1' }, 'FOUNDATION_PERF_T0'],
      [{ FOUNDATION_PERF_T0: 'abc', FOUNDATION_PERF_EXPECTED_MIGRATIONS: '1' }, 'FOUNDATION_PERF_T0'],
      [{ FOUNDATION_PERF_T0: String(t0), FOUNDATION_PERF_EXPECTED_MIGRATIONS: 'abc' }, 'FOUNDATION_PERF_EXPECTED_MIGRATIONS'],
      [{ FOUNDATION_PERF_T0: String(t0), FOUNDATION_PERF_EXPECTED_MIGRATIONS: '-1' }, 'FOUNDATION_PERF_EXPECTED_MIGRATIONS'],
    ] as const) {
      global['__ENV'] = variables;
      expect(() => lifecycle.setupRun(), invalid).toThrow(`Invalid run variable ${invalid}`);
    }
  } finally {
    delete global['__ENV'];
  }

  // handleSummary writes the k6 data as it is to /out/summary.json and prints one fixed line.
  const data = { metrics: { checks: { values: { rate: 1 } } }, setup_data: { t0: 1 } };
  expect(lifecycle.writeSummary(data)).toEqual({ '/out/summary.json': JSON.stringify(data), stdout: 'k6 summary written to /out/summary.json\n' });
});
