// Response classification of spec 0011 (AC-3) and how outcomes map to the custom metrics, readiness recovery, and the
// k6 exit. The only source of check decisions: the k6 journeys apply what these functions return, and the orchestration
// and the PERF-001 units use the same copy. This module is pure: no import, no `__ENV`, `process`, or `Bun`, so types
// that `plan.ts` also has are written again here.

export type Endpoint = 'status' | 'readiness';
export type Outcome = 'ok' | 'available' | 'busy' | 'unavailable' | 'rejected';

/** Fixed k6 check name; the check passes when the `classify` outcome is not `rejected`. */
export function checkName(endpoint: Endpoint): string {
  return `${endpoint} response matches the expected outcome`;
}

/** Start of the recovery window since T0, equal to `OUTAGE_START_MS` of `plan.ts` (PERF-001 checks this). */
export const RECOVERY_FROM_MS = 150_000;

const OUTAGE_EDGE_PHASES = ['stopping', 'recovering'];

type Body = Record<string, unknown>;

function parseObject(body: string | null): Body | null {
  if (body === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Body) : null;
}

function exactKeys(body: Body, keys: readonly string[]): boolean {
  const own = Object.keys(body);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(body, key));
}

/** `checkedAt` passes `Date.parse` and ends with `Z`. */
function validCheckedAt(value: unknown): boolean {
  return typeof value === 'string' && value.endsWith('Z') && !Number.isNaN(Date.parse(value));
}

/** A header value, matching the header name without case; `undefined` when absent. */
function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/** Readiness statuses allowed in the phase the request started in (*Klasifikasi respons*). */
export function allowedReadinessStatuses(profile: string, phase: string): number[] {
  if (profile === 'outage' && phase === 'outage') return [429, 503];
  if (profile === 'outage' && OUTAGE_EDGE_PHASES.indexOf(phase) >= 0) return [200, 429, 503];
  return [200, 429];
}

/**
 * Outcome of one response by *Klasifikasi respons*: `ok` for a valid 200 of `status`, `available`, `busy`, or
 * `unavailable` for a valid readiness 200, 429, or 503 allowed in that phase, and `rejected` for anything else,
 * including status 0 (a failed connection or a request timeout). `phase` is the phase the request started in.
 */
export function classify(
  endpoint: Endpoint,
  phase: string,
  profile: string,
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  body: string | null,
  expectedMigrations: number,
): Outcome {
  const parsed = parseObject(body);
  if (endpoint === 'status') {
    return status === 200 && parsed !== null && exactKeys(parsed, ['status']) && parsed['status'] === 'ok' ? 'ok' : 'rejected';
  }
  if (allowedReadinessStatuses(profile, phase).indexOf(status) < 0) return 'rejected';
  if (parsed === null || header(headers, 'Cache-Control') !== 'no-store') return 'rejected';
  if (status === 200) {
    const valid =
      exactKeys(parsed, ['status', 'appliedMigrations', 'checkedAt']) &&
      parsed['status'] === 'available' &&
      Number.isInteger(parsed['appliedMigrations']) &&
      parsed['appliedMigrations'] === expectedMigrations &&
      validCheckedAt(parsed['checkedAt']);
    return valid ? 'available' : 'rejected';
  }
  if (status === 429) return exactKeys(parsed, ['status']) && parsed['status'] === 'busy' ? 'busy' : 'rejected';
  const valid = exactKeys(parsed, ['status', 'checkedAt']) && parsed['status'] === 'unavailable' && validCheckedAt(parsed['checkedAt']);
  return valid ? 'unavailable' : 'rejected';
}

export type MetricName =
  | 'unexpected_responses'
  | 'readiness_available'
  | 'readiness_unavailable'
  | 'readiness_available_duration'
  | 'readiness_busy_duration'
  | 'readiness_unavailable_duration';

export type MetricUpdate = { metric: MetricName; value: number | boolean; tags: Record<string, string> };

/**
 * Custom metric updates for one outcome (the paragraph after *Klasifikasi respons*). Journeys apply every item as it
 * is and never decide a metric themselves.
 */
export function metricUpdates(endpoint: Endpoint, phase: string, outcome: Outcome, durationMs: number): MetricUpdate[] {
  const tags = { phase };
  if (outcome === 'rejected') return [{ metric: 'unexpected_responses', value: 1, tags: { endpoint, phase } }];
  if (outcome === 'available') {
    return [
      { metric: 'readiness_available', value: true, tags },
      { metric: 'readiness_available_duration', value: durationMs, tags },
    ];
  }
  if (outcome === 'busy') {
    return [
      { metric: 'readiness_available', value: false, tags },
      { metric: 'readiness_busy_duration', value: durationMs, tags },
    ];
  }
  if (outcome === 'unavailable') {
    return [
      { metric: 'readiness_available', value: false, tags },
      { metric: 'readiness_unavailable', value: 1, tags },
      { metric: 'readiness_unavailable_duration', value: durationMs, tags },
    ];
  }
  return [];
}

/**
 * The `readiness_recovery_ms` value of one readiness answer on the outage profile: once per VU, only for a 200 received
 * at or after T0 + 150000 ms by the k6 clock, whenever it was sent, and never negative. `null` when nothing is recorded.
 */
export function recoveryValue(alreadyRecorded: boolean, outcome: Outcome, receivedAtMs: number, t0: number): number | null {
  if (alreadyRecorded || outcome !== 'available') return null;
  const from = t0 + RECOVERY_FROM_MS;
  return receivedAtMs >= from ? receivedAtMs - from : null;
}

export type K6ExitReason = 'k6_timeout' | 'k6_thresholds_failed' | 'k6_failed';

/**
 * Reason code of a k6 exit: a timeout gives `k6_timeout`, 0 gives no reason, 99 gives `k6_thresholds_failed`, and any
 * other code (including `null`) gives `k6_failed`. An exit after the orchestration stopped k6 for a signal is not mapped
 * here; the caller records `signal`.
 */
export function k6ExitReason(code: number | null, timedOut: boolean): K6ExitReason | null {
  if (timedOut) return 'k6_timeout';
  if (code === 0) return null;
  if (code === 99) return 'k6_thresholds_failed';
  return 'k6_failed';
}
