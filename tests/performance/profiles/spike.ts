import { setupRun, writeSummary } from '../helpers/lifecycle.ts';
import { optionsFor, type RunData } from '../helpers/plan.ts';
import { readinessJourney } from '../journeys/readiness.ts';
import { statusJourney } from '../journeys/status.ts';

// Spike profile of spec 0011: load N, a 5 second rise to load O, load O for 60 seconds, a 5 second fall to N, then 10
// seconds to settle before `after` must meet the normal targets again.

export const options = optionsFor('spike');

export function setup(): RunData {
  return setupRun();
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(data);
}

export function status(data: RunData): void {
  statusJourney('spike', data);
}

export function readiness(data: RunData): void {
  readinessJourney('spike', data);
}
