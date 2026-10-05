import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { checkName, classify, metricUpdates } from '../helpers/expectations.ts';
import { applyUpdates } from '../helpers/metrics.ts';
import { BASE_URL, REQUEST_TIMEOUT, requestPhase, type ProfileName, type RunData } from '../helpers/plan.ts';

// `status` journey of spec 0011: one `GET /api/status` per iteration, judged by `classify` in the phase the request
// started in.

export function statusJourney(profile: ProfileName, data: RunData): void {
  const phase = requestPhase(profile, exec.scenario.name, Date.now(), data.t0);
  const tags = { endpoint: 'status', phase };
  const response = http.get(`${BASE_URL}/api/status`, { timeout: REQUEST_TIMEOUT, tags });
  const body = typeof response.body === 'string' ? response.body : null;
  const outcome = classify('status', phase, profile, response.status, response.headers, body, data.expectedMigrations);
  check(outcome, { [checkName('status')]: (value) => value !== 'rejected' }, tags);
  applyUpdates(metricUpdates('status', phase, outcome, response.timings.duration));
}
