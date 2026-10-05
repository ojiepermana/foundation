// k6 profile plan of spec 0011 (AC-1 and AC-4): the load model, ordered phases, scenarios, thresholds, the phase of
// every request, and the run variable check. This module is pure: no import, no `__ENV`, `process`, or `Bun`, so k6, Bun,
// the orchestration, and the PERF-001 units share one copy of the plan. Targets change only through spec 0011 and this
// file, never through the environment, an argument, or another file.

/** A measured endpoint; every iteration is exactly one request to the endpoint of its scenario. */
export type Endpoint = 'status' | 'readiness';
export const ENDPOINTS: readonly Endpoint[] = ['status', 'readiness'];

/** The six profile names of spec 0011 (*Rencana fase*), the allow list of the orchestration argument. */
export const PROFILE_NAMES = ['smoke', 'load', 'stress', 'spike', 'outage', 'soak'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/** *Model beban*: iterations per second per endpoint. One iteration is one request. */
export type LoadName = 'S0' | 'N' | 'O';
export const LOADS: Readonly<Record<LoadName, Readonly<Record<Endpoint, number>>>> = {
  S0: { status: 100, readiness: 10 },
  N: { status: 1000, readiness: 50 },
  O: { status: 4000, readiness: 1000 },
};

/** Phase target of *Thresholds*: normal N(P), overload O(P), or outage; `null` has no latency target. */
export type PhaseTarget = 'normal' | 'overload' | 'outage' | null;

/**
 * One ordered phase. `constant` uses `constant-arrival-rate` at the rate of `load`; `ramp` uses `ramping-arrival-rate`
 * from the rate of the previous phase (0 for the first phase) to the rate of `load` in one stage.
 */
export type PhasePlan = {
  name: string;
  shape: 'constant' | 'ramp';
  seconds: number;
  load: LoadName;
  target: PhaseTarget;
};

export type ProfilePlan = { phases: readonly PhasePlan[] };

/**
 * *Rencana fase*: the ordered phases of every profile, with the phase targets of *Thresholds*. Outage has one constant
 * phase `timeline` per endpoint; its phases come from the request start time through `phaseAt` (`OUTAGE_PHASES`).
 */
export const PROFILES: Readonly<Record<ProfileName, ProfilePlan>> = {
  smoke: {
    phases: [
      { name: 'warmup', shape: 'constant', seconds: 10, load: 'S0', target: null },
      { name: 'steady', shape: 'constant', seconds: 30, load: 'S0', target: 'normal' },
    ],
  },
  load: {
    phases: [
      { name: 'warmup', shape: 'ramp', seconds: 60, load: 'N', target: null },
      { name: 'steady', shape: 'constant', seconds: 600, load: 'N', target: 'normal' },
    ],
  },
  stress: {
    phases: [
      { name: 'warmup', shape: 'ramp', seconds: 60, load: 'N', target: null },
      { name: 'ramp', shape: 'ramp', seconds: 120, load: 'O', target: null },
      { name: 'hold', shape: 'constant', seconds: 300, load: 'O', target: 'overload' },
      { name: 'rampdown', shape: 'ramp', seconds: 60, load: 'N', target: null },
      { name: 'settle', shape: 'constant', seconds: 10, load: 'N', target: null },
      { name: 'recover', shape: 'constant', seconds: 180, load: 'N', target: 'normal' },
    ],
  },
  spike: {
    phases: [
      { name: 'warmup', shape: 'ramp', seconds: 60, load: 'N', target: null },
      { name: 'before', shape: 'constant', seconds: 120, load: 'N', target: 'normal' },
      { name: 'rise', shape: 'ramp', seconds: 5, load: 'O', target: null },
      { name: 'spike', shape: 'constant', seconds: 60, load: 'O', target: 'overload' },
      { name: 'fall', shape: 'ramp', seconds: 5, load: 'N', target: null },
      { name: 'settle', shape: 'constant', seconds: 10, load: 'N', target: null },
      { name: 'after', shape: 'constant', seconds: 180, load: 'N', target: 'normal' },
    ],
  },
  outage: {
    phases: [{ name: 'timeline', shape: 'constant', seconds: 220, load: 'N', target: null }],
  },
  soak: {
    phases: [
      { name: 'warmup', shape: 'ramp', seconds: 60, load: 'N', target: null },
      { name: 'steady', shape: 'constant', seconds: 3600, load: 'N', target: 'normal' },
    ],
  },
};

/** Base URL of the journeys: the backend of the run in the network namespace it shares with k6; never configurable. */
export const BASE_URL = 'http://127.0.0.1:8888';
/** Delay from setting T0 on the host to T0, which absorbs `docker create`, the stream start, and the k6 start. */
export const T0_DELAY_MS = 15_000;
/** Outage schedule relative to T0: `docker stop` of PostgreSQL, then `docker start` again. */
export const OUTAGE_STOP_MS = 90_000;
export const OUTAGE_START_MS = 150_000;
/** Limit of every k6 request. */
export const REQUEST_TIMEOUT = '10s';

/**
 * Outage phase timeline by request start time since T0 (*Rencana fase*, outage row), with the target of each phase from
 * *Thresholds*: normal on `before` and `after`, outage on `stopping`, `outage`, and `recovering`, none on `warmup`.
 */
export const OUTAGE_PHASES: readonly { name: string; fromMs: number; toMs: number; target: PhaseTarget }[] = [
  { name: 'warmup', fromMs: 0, toMs: 30_000, target: null },
  { name: 'before', fromMs: 30_000, toMs: 88_000, target: 'normal' },
  { name: 'stopping', fromMs: 88_000, toMs: 101_000, target: 'outage' },
  { name: 'outage', fromMs: 101_000, toMs: 145_000, target: 'outage' },
  { name: 'recovering', fromMs: 145_000, toMs: 160_000, target: 'outage' },
  { name: 'after', fromMs: 160_000, toMs: 220_000, target: 'normal' },
];

/** Outage phase for `elapsedMs` since T0; before T0 counts as `warmup`, after the timeline as `after`. */
export function phaseAt(elapsedMs: number): string {
  for (const phase of OUTAGE_PHASES) {
    if (elapsedMs < phase.toMs) return phase.name;
  }
  return OUTAGE_PHASES[OUTAGE_PHASES.length - 1]!.name;
}

/**
 * Phase of a request, computed once before it is sent: on outage from the request start time since T0, on other
 * profiles the part of the scenario name after the first underscore.
 */
export function requestPhase(profile: ProfileName, scenarioName: string, startedAtMs: number, t0: number): string {
  if (profile === 'outage') return phaseAt(startedAtMs - t0);
  const cut = scenarioName.indexOf('_');
  return cut < 0 ? scenarioName : scenarioName.slice(cut + 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios and thresholds (`optionsFor`).

export type PlannedScenario = {
  name: string;
  endpoint: Endpoint;
  phase: string;
  executor: 'constant-arrival-rate' | 'ramping-arrival-rate';
  startRate: number;
  endRate: number;
  seconds: number;
  /** Start second of the scenario since the test start: the sum of the earlier phase durations. */
  startSeconds: number;
  /** Rate × seconds for a constant scenario, (start rate + end rate) / 2 × seconds for a ramp. */
  plannedIterations: number;
};

export type ConstantScenario = {
  executor: 'constant-arrival-rate';
  exec: Endpoint;
  rate: number;
  timeUnit: string;
  duration: string;
  startTime?: string;
  preAllocatedVUs: number;
  maxVUs: number;
  gracefulStop: string;
};

export type RampScenario = {
  executor: 'ramping-arrival-rate';
  exec: Endpoint;
  startRate: number;
  timeUnit: string;
  stages: { target: number; duration: string }[];
  startTime?: string;
  preAllocatedVUs: number;
  maxVUs: number;
  gracefulStop: string;
};

export type Scenario = ConstantScenario | RampScenario;
export type ThresholdItem = string | { threshold: string; abortOnFail: boolean; delayAbortEval: string };

export type K6Options = {
  scenarios: Record<string, Scenario>;
  thresholds: Record<string, ThresholdItem[]>;
  setupTimeout: string;
  summaryTrendStats: string[];
  discardResponseBodies: boolean;
};

/** The plan of a profile. */
export function profilePlan(profile: ProfileName): ProfilePlan {
  return PROFILES[profile];
}

/** Planned seconds of a profile (the sum of its phase durations). */
export function profileSeconds(profile: ProfileName): number {
  return profilePlan(profile).phases.reduce((total, phase) => total + phase.seconds, 0);
}

/** A phase as a window since T0, with its target; a phase with a target is a measured phase (*Pengamatan resource*). */
export type PhaseWindow = { name: string; fromMs: number; toMs: number; target: PhaseTarget };

/**
 * Ordered phase windows since T0: the outage timeline on outage, otherwise the sum of the earlier phase durations of the
 * plan. The windows of the resource observation and the phase list of `result.json` come from here.
 */
export function phaseWindows(profile: ProfileName): PhaseWindow[] {
  if (profile === 'outage') return OUTAGE_PHASES.map((phase) => ({ ...phase }));
  let fromMs = 0;
  return profilePlan(profile).phases.map((phase) => {
    const window = { name: phase.name, fromMs, toMs: fromMs + phase.seconds * 1000, target: phase.target };
    fromMs = window.toMs;
    return window;
  });
}

/** Every scenario of a profile, per phase then per endpoint (`status`, then `readiness`), with planned rates and iterations. */
export function plannedScenarios(profile: ProfileName): PlannedScenario[] {
  const scenarios: PlannedScenario[] = [];
  let startSeconds = 0;
  let previous: LoadName | null = null;
  for (const phase of profilePlan(profile).phases) {
    for (const endpoint of ENDPOINTS) {
      const endRate = LOADS[phase.load][endpoint];
      const startRate = phase.shape === 'constant' ? endRate : previous === null ? 0 : LOADS[previous][endpoint];
      scenarios.push({
        name: `${endpoint}_${phase.name}`,
        endpoint,
        phase: phase.name,
        executor: phase.shape === 'constant' ? 'constant-arrival-rate' : 'ramping-arrival-rate',
        startRate,
        endRate,
        seconds: phase.seconds,
        startSeconds,
        plannedIterations: phase.shape === 'constant' ? endRate * phase.seconds : ((startRate + endRate) / 2) * phase.seconds,
      });
    }
    startSeconds += phase.seconds;
    previous = phase.load;
  }
  return scenarios;
}

/**
 * *Alokasi VU*: every scenario gets VUs for this many milliseconds of arrivals at once. k6 2.3.0 drops an iteration as
 * soon as no VU that already exists is free, so only VUs created before T0 prevent the first dropped iteration.
 */
export const VU_HEADROOM_MS = 100;

/**
 * `preAllocatedVUs` = `maxVUs` = max(10, ceil(rate × `VU_HEADROOM_MS` / 1000)), computed with integers, where rate is
 * the larger of the start and target rate of the phase. Both fields are always equal, so k6 creates every VU before T0.
 */
export function scenarioVUs(rate: number): number {
  return Math.max(10, Math.floor((rate * VU_HEADROOM_MS + 999) / 1000));
}

/**
 * Actual load floor of a constant scenario (*Ambang beban aktual*): 99.9 percent of the planned iterations,
 * floor(0.999 × rate × seconds), but never more than the planned iterations minus the VUs of the scenario. k6 2.3.0
 * neither starts nor counts as dropped an iteration still due when a scenario ends, so a stall of the generator at the
 * end lowers the count by the arrivals of that stall. The VUs of a scenario absorb the same stall in its middle without
 * a dropped iteration (*Alokasi VU*), so the end of a scenario gets the same allowance. Computed with integers.
 */
export function iterationFloor(rate: number, seconds: number): number {
  const planned = rate * seconds;
  return Math.max(0, Math.min(Math.floor((999 * planned) / 1000), planned - scenarioVUs(rate)));
}

const STATUS_LATENCY = ['p(95)<10', 'p(99)<25'];
const AVAILABLE_LATENCY = ['p(95)<25', 'p(99)<50'];
const RECORD_ONLY = ['max>=0'];
/** Group Umum: the count must stay 0, with an early abort after 5 seconds of evaluation. */
const abortAtZero = (): ThresholdItem => ({ threshold: 'count==0', abortOnFail: true, delayAbortEval: '5s' });

/** Phase submetric keys of *Thresholds*. */
export function statusLatencyKey(phase: string): string {
  return `http_req_duration{endpoint:status,phase:${phase}}`;
}
export function readinessKey(metric: 'readiness_available' | 'readiness_unavailable' | 'readiness_available_duration' | 'readiness_busy_duration' | 'readiness_unavailable_duration', phase: string): string {
  return `${metric}{phase:${phase}}`;
}

/** Target expressions of a phase (rows Target normal, Target beban lebih, or Target outage), per key. */
function phaseTargets(phase: string, target: PhaseTarget): Record<string, string[]> {
  if (target === 'normal') {
    return {
      [statusLatencyKey(phase)]: STATUS_LATENCY,
      [readinessKey('readiness_available_duration', phase)]: AVAILABLE_LATENCY,
      [readinessKey('readiness_available', phase)]: ['rate>=0.98'],
    };
  }
  if (target === 'overload') {
    return {
      [statusLatencyKey(phase)]: STATUS_LATENCY,
      [readinessKey('readiness_available_duration', phase)]: AVAILABLE_LATENCY,
      [readinessKey('readiness_busy_duration', phase)]: ['p(95)<10'],
      [readinessKey('readiness_available', phase)]: ['rate>=0.20'],
    };
  }
  if (target === 'outage') {
    return {
      [statusLatencyKey(phase)]: STATUS_LATENCY,
      [readinessKey('readiness_unavailable_duration', phase)]: ['max<5500'],
    };
  }
  return {};
}

/**
 * k6 `options` of a profile: one scenario per plan phase and endpoint, the thresholds of the groups Umum, Beban aktual,
 * the phase targets, and Pencatatan, and the fixed summary options. The phase targets and the Pencatatan keys follow
 * `phaseWindows`, so on outage they cover the six timeline phases, not the single `timeline` scenario phase.
 */
export function optionsFor(profile: ProfileName): K6Options {
  const scenarios: Record<string, Scenario> = {};
  const thresholds: Record<string, ThresholdItem[]> = {
    unexpected_responses: [abortAtZero()],
    dropped_iterations: [abortAtZero()],
    checks: ['rate==1'],
  };
  for (const planned of plannedScenarios(profile)) {
    const vus = scenarioVUs(Math.max(planned.startRate, planned.endRate));
    const common = {
      exec: planned.endpoint,
      timeUnit: '1s',
      preAllocatedVUs: vus,
      maxVUs: vus,
      gracefulStop: '6s',
    };
    const startTime = planned.startSeconds > 0 ? { startTime: `${planned.startSeconds}s` } : {};
    if (planned.executor === 'constant-arrival-rate') {
      scenarios[planned.name] = { executor: 'constant-arrival-rate', rate: planned.endRate, duration: `${planned.seconds}s`, ...startTime, ...common };
      thresholds[`iterations{scenario:${planned.name}}`] = [`count>=${iterationFloor(planned.endRate, planned.seconds)}`];
    } else {
      scenarios[planned.name] = {
        executor: 'ramping-arrival-rate',
        startRate: planned.startRate,
        stages: [{ target: planned.endRate, duration: `${planned.seconds}s` }],
        ...startTime,
        ...common,
      };
      thresholds[`iterations{scenario:${planned.name}}`] = ['count>=0'];
    }
  }
  for (const phase of phaseWindows(profile)) {
    const targets = phaseTargets(phase.name, phase.target);
    const recorded = [
      statusLatencyKey(phase.name),
      readinessKey('readiness_available_duration', phase.name),
      readinessKey('readiness_busy_duration', phase.name),
      readinessKey('readiness_unavailable_duration', phase.name),
    ];
    for (const key of recorded) thresholds[key] = [...(targets[key] ?? RECORD_ONLY)];
    for (const key of Object.keys(targets)) {
      if (thresholds[key] === undefined) thresholds[key] = [...targets[key]!];
    }
  }
  if (profile === 'outage') {
    thresholds[readinessKey('readiness_unavailable', 'outage')] = ['count>=1'];
    thresholds['readiness_recovery_ms'] = ['min>=0'];
  }
  return {
    scenarios,
    thresholds,
    setupTimeout: '60s',
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)', 'count'],
    discardResponseBodies: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// k6 run variables (`FOUNDATION_PERF_T0` and `FOUNDATION_PERF_EXPECTED_MIGRATIONS`), read only by `setupRun()`.

export type RunData = { startedAt: number; t0: number; expectedMigrations: number };
export type RunEnvResult =
  | { ok: true; t0: number; expectedMigrations: number }
  | { ok: false; invalid: 'FOUNDATION_PERF_T0' | 'FOUNDATION_PERF_EXPECTED_MIGRATIONS' };

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

/** T0 as a positive integer epoch in ms and the migration count as an integer of 0 or more, from the variable text. */
export function parseRunEnv(raw: Readonly<Record<string, string | undefined>>): RunEnvResult {
  const t0Text = raw['FOUNDATION_PERF_T0'];
  if (typeof t0Text !== 'string' || !POSITIVE_INTEGER.test(t0Text) || !Number.isSafeInteger(Number(t0Text))) {
    return { ok: false, invalid: 'FOUNDATION_PERF_T0' };
  }
  const migrationsText = raw['FOUNDATION_PERF_EXPECTED_MIGRATIONS'];
  if (typeof migrationsText !== 'string' || !NON_NEGATIVE_INTEGER.test(migrationsText) || !Number.isSafeInteger(Number(migrationsText))) {
    return { ok: false, invalid: 'FOUNDATION_PERF_EXPECTED_MIGRATIONS' };
  }
  return { ok: true, t0: Number(t0Text), expectedMigrations: Number(migrationsText) };
}
