import { Counter, Rate, Trend } from 'k6/metrics';
import type { MetricName, MetricUpdate } from './expectations.ts';

// Custom metrics of spec 0011 (*Metrik khusus*), created in the k6 init context when a profile imports this module.
// Journeys only apply the items of `metricUpdates` as they are, through `applyUpdates`.

const metrics: Record<MetricName, Counter | Rate | Trend> = {
  unexpected_responses: new Counter('unexpected_responses'),
  readiness_available: new Rate('readiness_available'),
  readiness_unavailable: new Counter('readiness_unavailable'),
  readiness_available_duration: new Trend('readiness_available_duration', true),
  readiness_busy_duration: new Trend('readiness_busy_duration', true),
  readiness_unavailable_duration: new Trend('readiness_unavailable_duration', true),
};

/** Only the outage profile adds samples; other profiles leave it empty. */
export const readinessRecoveryMs = new Trend('readiness_recovery_ms', true);

export function applyUpdates(updates: MetricUpdate[]): void {
  for (const update of updates) metrics[update.metric].add(update.value as number, update.tags);
}
