import { setupRun, writeSummary } from '../helpers/lifecycle.ts';
import { optionsFor, type RunData } from '../helpers/plan.ts';
import { readinessJourney } from '../journeys/readiness.ts';
import { statusJourney } from '../journeys/status.ts';

// Stress profile of spec 0011: load N, a ramp to load O, load O for 300 seconds, a ramp back to N, then 10 seconds to
// settle before `recover` must meet the normal targets again.

export const options = optionsFor('stress');

export function setup(): RunData {
  return setupRun();
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(data);
}

export function status(data: RunData): void {
  statusJourney('stress', data);
}

export function readiness(data: RunData): void {
  readinessJourney('stress', data);
}
