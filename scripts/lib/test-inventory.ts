import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DiscoveryReasonCode } from './gate.ts';
import type { JUnitDocument, JUnitRunner } from './junit.ts';

// *Tabel pemilik runner* of spec 0010: which script owns which test files, through which runner and config, where its
// JUnit lands, and how a JUnit testsuite path is normalized to a repository path. The gate report reads this table to
// match testcases to registry checks (AC-6); `check:test-discovery` walks the repository against it, and
// `test:scenarios` asks it who owns the file of a check (AC-1, AC-2). A new test location needs one row here and a tier
// step for its script in the same commit.

/** How the file of a JUnit testsuite becomes a repository path. */
export type JUnitPathRule =
  /** The `name` of the file level testsuite plus a fixed prefix (Vitest and Playwright). */
  | { from: 'suite-name'; prefix: string }
  /** The `file` attribute of the file level testsuite as it is (`bun:test`). */
  | { from: 'file-attribute' };

export type RunnerOwner = {
  script: string;
  runner: JUnitRunner;
  /** Root of the owned files, relative to the repository root. */
  root: string;
  /** Owned file patterns, relative to the repository root. */
  include: readonly string[];
  exclude: readonly string[];
  /** Runner config the script uses, or `null` for `bun:test`. */
  config: string | null;
  junit: string;
  junitPath: JUnitPathRule;
};

const vitestPath: JUnitPathRule = { from: 'suite-name', prefix: 'apps/frontend/' };
const playwrightPath: JUnitPathRule = { from: 'suite-name', prefix: 'tests/e2e/' };
const bunPath: JUnitPathRule = { from: 'file-attribute' };
const realE2e = ['tests/e2e/**/*.real.e2e.spec.ts'];

function bunOwner(script: string, root: string, include: readonly string[], junit: string): RunnerOwner {
  return { script, runner: 'bun:test', root, include, exclude: [], config: null, junit, junitPath: bunPath };
}

export const RUNNER_OWNERS: readonly RunnerOwner[] = [
  {
    script: 'test:frontend',
    runner: 'vitest',
    root: 'apps/frontend/src',
    include: ['apps/frontend/src/**/*.spec.ts', 'apps/frontend/src/**/*.test.ts'],
    exclude: [],
    config: 'apps/frontend/angular.json',
    junit: '.local/feature-4/frontend.xml',
    junitPath: vitestPath,
  },
  {
    script: 'test:e2e',
    runner: 'playwright',
    root: 'tests/e2e',
    include: ['tests/e2e/**/*.e2e.spec.ts'],
    exclude: realE2e,
    config: 'playwright.config.ts',
    junit: '.local/feature-4/playwright.xml',
    junitPath: playwrightPath,
  },
  {
    script: 'test:readiness:real',
    runner: 'playwright',
    root: 'tests/e2e',
    include: realE2e,
    exclude: [],
    config: 'playwright.real.config.ts',
    junit: '.local/feature-10/playwright-real.xml',
    junitPath: playwrightPath,
  },
  {
    script: 'test:tooling:real',
    runner: 'playwright',
    root: 'tests/e2e',
    include: realE2e,
    exclude: [],
    config: 'playwright.real.config.ts',
    junit: '.local/feature-2/playwright-real.xml',
    junitPath: playwrightPath,
  },
  bunOwner(
    'test:integration',
    'tests/integration',
    ['tests/integration/backend/**/*.test.ts', 'tests/integration/contract/**/*.test.ts'],
    '.local/feature-4/server.xml',
  ),
  bunOwner('test:tooling', 'tests/integration/tooling', ['tests/integration/tooling/**/*.test.ts'], '.local/feature-4/tooling.xml'),
  bunOwner('test:gate', 'tests/integration/gate', ['tests/integration/gate/**/*.test.ts'], '.local/feature-11/gate.xml'),
  bunOwner(
    'test:database:real',
    'tests/integration/database',
    ['tests/integration/database/**/*.test.ts'],
    '.local/feature-5/database.xml',
  ),
  bunOwner(
    'test:database:migration',
    'tests/integration/database',
    ['tests/integration/database/migration.test.ts'],
    '.local/feature-6/migration.xml',
  ),
  bunOwner(
    'test:infrastructure',
    'tests/integration/infrastructure',
    ['tests/integration/infrastructure/**/*.test.ts'],
    '.local/feature-3/infrastructure.xml',
  ),
];

export function runnerOwner(script: string): RunnerOwner | undefined {
  return RUNNER_OWNERS.find((owner) => owner.script === script);
}

/** The repository path of a file level JUnit testsuite under `owner`, or `null` when the suite does not name one. */
export function junitSuitePath(owner: RunnerOwner, fileSuite: Readonly<Record<string, string>>): string | null {
  const raw = owner.junitPath.from === 'file-attribute' ? fileSuite['file'] : fileSuite['name'];
  if (raw === undefined || raw === '') return null;
  return owner.junitPath.from === 'file-attribute' ? raw : `${owner.junitPath.prefix}${raw}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery (AC-1): the inventory of test files, who owns them, and how a runner list or a JUnit file is compared with
// the owned set. Pure apart from the directory walk, so GATE-001 can run every rule on a `mkdtemp` workspace.

/** File names a runner of this repository can discover: the union of the Bun, Vitest, and Playwright defaults. */
export const DISCOVERY_PATTERN = /^.+[._](test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

/** Folders the inventory never enters, at any depth. */
export const INVENTORY_SKIP: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.angular',
  '.local',
  '.cache',
  'test-results',
  'graphify-out',
]);

export function isTestFile(path: string): boolean {
  return DISCOVERY_PATTERN.test(basename(path));
}

const globs = new Map<string, Bun.Glob>();

function matches(pattern: string, path: string): boolean {
  let glob = globs.get(pattern);
  if (glob === undefined) {
    glob = new Bun.Glob(pattern);
    globs.set(pattern, glob);
  }
  return glob.match(path);
}

/** The owners whose patterns take `path` (a repository path), in table order. */
export function ownersOf(path: string, owners: readonly RunnerOwner[] = RUNNER_OWNERS): RunnerOwner[] {
  return owners.filter(
    (owner) => owner.include.some((pattern) => matches(pattern, path)) && !owner.exclude.some((pattern) => matches(pattern, path)),
  );
}

/** One discovery problem with a code of *Kode alasan*; `script` is `null` when no script owns the file. */
export type DiscoveryProblem = { code: DiscoveryReasonCode; script: string | null; path: string };

/**
 * Every file under `root` whose name matches the discovery pattern, as sorted repository paths. The walk skips the
 * folders of `INVENTORY_SKIP` and never follows a symlink; a symlink whose name matches is listed like a file.
 */
export async function testFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string) => {
    const entries = await readdir(relative === '' ? root : join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!INVENTORY_SKIP.has(entry.name)) await visit(path);
      } else if (isTestFile(entry.name)) found.push(path);
    }
  };
  await visit('');
  return found.sort();
}

export type InventoryFile = { path: string; owners: RunnerOwner[] };
export type Inventory = { files: InventoryFile[]; problems: DiscoveryProblem[] };

/**
 * Walks `root` and assigns every test file its owners. A file without an owner is `unowned_file`; a file whose owners
 * use more than one runner is `two_runners`. Several scripts of one runner may share a file (`migration.test.ts`).
 */
export async function inventory(root: string, owners: readonly RunnerOwner[] = RUNNER_OWNERS): Promise<Inventory> {
  const files: InventoryFile[] = [];
  const problems: DiscoveryProblem[] = [];
  for (const path of await testFiles(root)) {
    const found = ownersOf(path, owners);
    files.push({ path, owners: found });
    if (found.length === 0) problems.push({ code: 'unowned_file', script: null, path });
    else if (new Set(found.map((owner) => owner.runner)).size > 1) {
      problems.push({ code: 'two_runners', script: found.map((owner) => owner.script).join(', '), path });
    }
  }
  return { files, problems };
}

/** The files of an inventory that one of `scripts` owns. */
export function ownedBy(found: Inventory, scripts: readonly string[]): Set<string> {
  return new Set(found.files.filter((file) => file.owners.some((owner) => scripts.includes(owner.script))).map((file) => file.path));
}

export type ListDifference = {
  /** Owned files the runner did not list. */
  missing: string[];
  /** Listed files the scripts do not own. */
  extra: string[];
};

/** Compares an owned set with what a runner listed, in both directions; both lists are sorted. */
export function compareList(owned: ReadonlySet<string>, listed: Iterable<string>): ListDifference {
  const actual = new Set(listed);
  return {
    missing: [...owned].filter((path) => !actual.has(path)).sort(),
    extra: [...actual].filter((path) => !owned.has(path)).sort(),
  };
}

/**
 * The JUnit rule of AC-1: every file level testsuite of the JUnit a script writes names a file that script owns
 * (`junit_foreign_file` otherwise), and every file the script owns has a testsuite (`junit_missing_file` otherwise).
 */
export function junitDiscovery(owner: RunnerOwner, document: JUnitDocument, owned: ReadonlySet<string>): DiscoveryProblem[] {
  const seen = new Set<string>();
  for (const suite of document.suites) {
    const path = junitSuitePath(owner, suite.attributes);
    if (path !== null) seen.add(path);
  }
  const { missing, extra } = compareList(owned, seen);
  return [
    ...extra.map((path): DiscoveryProblem => ({ code: 'junit_foreign_file', script: owner.script, path })),
    ...missing.map((path): DiscoveryProblem => ({ code: 'junit_missing_file', script: owner.script, path })),
  ];
}
