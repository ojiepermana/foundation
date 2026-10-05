import { setupRun, writeSummary } from '../helpers/lifecycle.ts';
import { optionsFor, type RunData } from '../helpers/plan.ts';
import { readinessJourney } from '../journeys/readiness.ts';
import { statusJourney } from '../journeys/status.ts';

// Smoke profile of spec 0011: load S0 for 40 seconds on every push, to validate the scripts and the basic behavior.

export const options = optionsFor('smoke');

export function setup(): RunData {
  return setupRun();
}

export function handleSummary(data: unknown): Record<string, string> {
  return writeSummary(data);
}

export function status(data: RunData): void {
  statusJourney('smoke', data);
}

export function readiness(data: RunData): void {
  readinessJourney('smoke', data);
}
