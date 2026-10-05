import { setupRun, writeSummary } from '../helpers/lifecycle.ts';
import { optionsFor, type RunData } from '../helpers/plan.ts';
import { readinessJourney } from '../journeys/readiness.ts';
import { statusJourney } from '../journeys/status.ts';

// Outage profile of spec 0011: load N for 220 seconds while the orchestration stops PostgreSQL at T0 + 90 s and starts it
// again at T0 + 150 s; the phase of each request comes from its start time.

export const options = optionsFor('outage');

export function setup(): RunData {
  return setupRun();
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(data);
}

export function status(data: RunData): void {
  statusJourney('outage', data);
}

export function readiness(data: RunData): void {
  readinessJourney('outage', data);
}
