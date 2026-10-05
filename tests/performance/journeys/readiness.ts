import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { checkName, classify, metricUpdates, recoveryValue } from '../helpers/expectations.ts';
import { applyUpdates, readinessRecoveryMs } from '../helpers/metrics.ts';
import { BASE_URL, REQUEST_TIMEOUT, requestPhase, type ProfileName, type RunData } from '../helpers/plan.ts';

// `readiness` journey of spec 0011: one `GET /api/readiness` per iteration, judged by `classify` in the phase the
// request started in. On the outage profile every VU records the recovery time at most once.

/** Per VU: every k6 VU has its own JavaScript runtime. */
let recoveryRecorded = false;

export function readinessJourney(profile: ProfileName, data: RunData): void {
  const phase = requestPhase(profile, exec.scenario.name, Date.now(), data.t0);
  const tags = { endpoint: 'readiness', phase };
  const response = http.get(`${BASE_URL}/api/readiness`, { timeout: REQUEST_TIMEOUT, tags });
  const receivedAt = Date.now();
  const body = typeof response.body === 'string' ? response.body : null;
  const outcome = classify('readiness', phase, profile, response.status, response.headers, body, data.expectedMigrations);
  check(outcome, { [checkName('readiness')]: (value) => value !== 'rejected' }, tags);
  applyUpdates(metricUpdates('readiness', phase, outcome, response.timings.duration));
  if (profile === 'outage') {
    const recovery = recoveryValue(recoveryRecorded, outcome, receivedAt, data.t0);
    if (recovery !== null) {
      recoveryRecorded = true;
      readinessRecoveryMs.add(recovery);
    }
  }
}
