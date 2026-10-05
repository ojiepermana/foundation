import { setupRun, writeSummary } from '../helpers/lifecycle.ts';
import { optionsFor, type RunData } from '../helpers/plan.ts';
import { readinessJourney } from '../journeys/readiness.ts';
import { statusJourney } from '../journeys/status.ts';

// Soak profile of spec 0011: a ramp to load N in 60 seconds, then load N for 3600 seconds, to show stability over a long
// run.

export const options = optionsFor('soak');

export function setup(): RunData {
  return setupRun();
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(data);
}

export function status(data: RunData): void {
  statusJourney('soak', data);
}

export function readiness(data: RunData): void {
  readinessJourney('soak', data);
}
