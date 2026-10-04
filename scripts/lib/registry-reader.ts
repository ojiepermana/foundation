import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The shape reader for the scenario registries of spec 0010 (`tests/scenarios/*.json`), kept apart from the validator in
// `scenario-registry.ts`. It imports only `node:` modules, so `test:report` runs in the workflow job `report`, which
// checks out the repository and sets up Bun without installing dependencies; the validator needs the installed
// TypeScript parser and runs in the fast tier, where they are installed.

export const REGISTRY_DIR = 'tests/scenarios';

export type RegistryCheck = { runner: string; script: string; file: string; testTag?: string };
export type RegistryScenario = { id: string; criteria: string[]; critical: boolean; checks: RegistryCheck[] };
export type Registry = { path: string; source: string; scenarios: RegistryScenario[] };

export class RegistryError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** The registry files, sorted by name, as repository paths. */
export async function registryFiles(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, REGISTRY_DIR));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${REGISTRY_DIR}/${name}`);
}

/**
 * Reads every registry for the gate report. The report runs after `test:scenarios` checked the same files, so this
 * reader only takes the shape apart; a registry it cannot read throws `RegistryError`, so the report fails closed.
 */
export async function readRegistries(root: string): Promise<Registry[]> {
  const registries: Registry[] = [];
  for (const path of await registryFiles(root)) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(root, path), 'utf8'));
    } catch {
      throw new RegistryError(`${path} cannot be read`);
    }
    if (!isRecord(raw) || typeof raw['source'] !== 'string' || !Array.isArray(raw['scenarios'])) {
      throw new RegistryError(`${path} has no source or scenarios`);
    }
    const scenarios: RegistryScenario[] = [];
    for (const scenario of raw['scenarios']) {
      if (!isRecord(scenario) || typeof scenario['id'] !== 'string') throw new RegistryError(`${path} has a scenario without ID`);
      const criteria = Array.isArray(scenario['criteria']) ? scenario['criteria'].filter((item) => typeof item === 'string') : [];
      const checks: RegistryCheck[] = [];
      for (const check of Array.isArray(scenario['checks']) ? scenario['checks'] : []) {
        if (!isRecord(check)) continue;
        const item: RegistryCheck = { runner: String(check['runner'] ?? ''), script: String(check['script'] ?? ''), file: String(check['file'] ?? '') };
        if (typeof check['testTag'] === 'string') item.testTag = check['testTag'];
        checks.push(item);
      }
      scenarios.push({ id: scenario['id'], criteria, critical: scenario['critical'] === true, checks });
    }
    registries.push({ path, source: raw['source'], scenarios });
  }
  return registries;
}
