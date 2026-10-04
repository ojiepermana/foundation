import { realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stepEnvironment } from './lib/gate.ts';
import { runProcessGroup } from './lib/process-group.ts';
import { readRegistries } from './lib/scenario-registry.ts';
import { compareList, inventory, ownedBy, RUNNER_OWNERS, type DiscoveryProblem, type RunnerOwner } from './lib/test-inventory.ts';

// `bun run check:test-discovery` (spec 0010, AC-1): `bun --no-env-file scripts/check-test-discovery.ts` walks the
// repository against the runner owner table, then asks Vitest (through the Angular CLI) and Playwright (once per config)
// which files they discover, and compares both ways. A Playwright check of a registry also needs one listed test whose
// full title starts with its tag. `bun:test` has no list command; its files are proven from JUnit in the gate report.
// The list commands run as process groups with the step environment and a limit of 120000 ms each.

export const LIST_TIMEOUT_MS = 120_000;
const LIST_HEADER = 'Discovered test files:';
const ANGULAR_CLI = 'node_modules/@angular/cli/bin/ng.js';
const PLAYWRIGHT_CLI = 'node_modules/@playwright/test/cli.js';

/** One listed file with the full titles of its tests (*Judul lengkap*); Angular lists files without titles. */
export type ListedFile = { path: string; titles: string[] };

/**
 * `ng test --list-tests`, run from the frontend workspace: every non empty line that starts with two spaces after the
 * line `Discovered test files:` is a path relative to the workspace, returned with `prefix`. `null` without that line.
 */
export function parseAngularList(output: string, prefix: string): ListedFile[] | null {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === LIST_HEADER);
  if (start < 0) return null;
  const paths = lines
    .slice(start + 1)
    .filter((line) => line.startsWith('  ') && line.trim() !== '')
    .map((line) => `${prefix}${line.trim()}`);
  return [...new Set(paths)].sort().map((path) => ({ path, titles: [] }));
}

type PlaywrightSuite = { title?: unknown; file?: unknown; specs?: unknown; suites?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Titles of the specs in `suite` and its nested suites, each prefixed with the suite titles, joined with ` › `. */
function suiteTitles(suite: PlaywrightSuite, outer: readonly string[]): string[] | null {
  const titles: string[] = [];
  const specs = suite.specs ?? [];
  const suites = suite.suites ?? [];
  if (!Array.isArray(specs) || !Array.isArray(suites)) return null;
  for (const spec of specs) {
    if (!isRecord(spec) || typeof spec['title'] !== 'string') return null;
    titles.push([...outer, spec['title']].join(' › '));
  }
  for (const child of suites) {
    if (!isRecord(child) || typeof child['title'] !== 'string') return null;
    const inner = suiteTitles(child, [...outer, child['title']]);
    if (inner === null) return null;
    titles.push(...inner);
  }
  return titles;
}

/**
 * `playwright test --list --reporter=json --config <config>`: every top level suite gives the file
 * `join(config.rootDir, suite.file)`, made relative to `root` (a real path), with the full titles of its tests. `null`
 * for invalid JSON, an unexpected shape, or a non empty `errors`.
 */
export function parsePlaywrightList(output: string, root: string): ListedFile[] | null {
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(report) || !isRecord(report['config']) || !Array.isArray(report['suites']) || !Array.isArray(report['errors'])) return null;
  if (report['errors'].length > 0) return null;
  const rootDir = report['config']['rootDir'];
  if (typeof rootDir !== 'string' || rootDir === '') return null;
  const files = new Map<string, string[]>();
  for (const suite of report['suites']) {
    if (!isRecord(suite) || typeof suite['file'] !== 'string') return null;
    const titles = suiteTitles(suite, []);
    if (titles === null) return null;
    const path = relative(root, resolve(rootDir, suite['file'])).split(sep).join('/');
    files.set(path, [...(files.get(path) ?? []), ...titles]);
  }
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, titles]) => ({ path, titles }));
}

/** One finding of this command: a discovery problem with a plain explanation for the console. */
export type DiscoveryFinding = DiscoveryProblem & { detail: string };

/** One list command per runner config: the Angular CLI for Vitest, and each Playwright config. */
type ListGroup = { runner: 'vitest' | 'playwright'; config: string; owners: RunnerOwner[] };

function listGroups(owners: readonly RunnerOwner[]): ListGroup[] {
  const groups: ListGroup[] = [];
  for (const owner of owners) {
    if (owner.runner === 'bun:test' || owner.config === null) continue;
    const group = groups.find((item) => item.config === owner.config && item.runner === owner.runner);
    if (group === undefined) groups.push({ runner: owner.runner, config: owner.config, owners: [owner] });
    else group.owners.push(owner);
  }
  return groups;
}

type Environment = Readonly<Record<string, string | undefined>>;

async function listCommand(argv: string[], cwd: string, env: Record<string, string>, error: (line: string) => void): Promise<string | null> {
  try {
    const result = await runProcessGroup(argv, { cwd, env, timeoutMs: LIST_TIMEOUT_MS, output: 'pipe' });
    if (result.timedOut) {
      error(`  perintah daftar melewati batas ${LIST_TIMEOUT_MS} ms`);
      return null;
    }
    if (result.code !== 0) {
      if (result.stderr.trim() !== '') error(result.stderr.trimEnd());
      return null;
    }
    return result.stdout;
  } catch {
    return null;
  }
}

async function listFiles(root: string, realRoot: string, group: ListGroup, env: Record<string, string>, error: (line: string) => void): Promise<ListedFile[] | null> {
  if (group.runner === 'vitest') {
    const workspace = dirname(group.config);
    const output = await listCommand(['node', join(root, ANGULAR_CLI), 'test', '--list-tests'], join(root, workspace), env, error);
    return output === null ? null : parseAngularList(output, `${workspace}/`);
  }
  const output = await listCommand(
    ['node', join(root, PLAYWRIGHT_CLI), 'test', '--list', '--reporter=json', '--config', group.config],
    root,
    env,
    error,
  );
  return output === null ? null : parsePlaywrightList(output, realRoot);
}

export type DiscoveryOptions = {
  root: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** The process environment the step environment is taken from; `process.env` by default. */
  env?: Environment;
  owners?: readonly RunnerOwner[];
};

/** Runs every discovery rule of AC-1 on `root`; resolves to 0 when nothing differs and 1 otherwise. */
export async function runTestDiscovery(options: DiscoveryOptions): Promise<number> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const error = options.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  const owners = options.owners ?? RUNNER_OWNERS;
  const env = stepEnvironment(options.env ?? process.env);
  const root = options.root;
  const realRoot = await realpath(root);

  const findings: DiscoveryFinding[] = [];
  const found = await inventory(root, owners);
  for (const problem of found.problems) {
    findings.push({
      ...problem,
      detail: problem.code === 'unowned_file' ? 'tidak dimiliki runner mana pun' : `dimiliki lebih dari satu runner (${problem.script})`,
    });
  }

  const playwrightChecks = (await readRegistries(root))
    .flatMap((registry) => registry.scenarios.flatMap((scenario) => scenario.checks))
    .filter((check) => check.runner === 'playwright' && typeof check.testTag === 'string');

  const summary: string[] = [];
  for (const group of listGroups(owners)) {
    const scripts = group.owners.map((owner) => owner.script);
    const owned = ownedBy(found, scripts);
    const listed = await listFiles(root, realRoot, group, env, error);
    if (listed === null) {
      for (const script of scripts) findings.push({ code: 'list_failed', script, path: group.config, detail: 'daftar runner tidak dapat dibaca' });
      continue;
    }
    const { missing, extra } = compareList(owned, listed.map((file) => file.path));
    for (const script of scripts) {
      for (const path of missing) findings.push({ code: 'list_differs', script, path, detail: 'dimiliki script tetapi tidak ditemukan runner' });
      for (const path of extra) findings.push({ code: 'list_differs', script, path, detail: 'ditemukan runner tetapi tidak dimiliki script' });
    }
    if (group.runner === 'playwright') {
      for (const check of playwrightChecks.filter((item) => scripts.includes(item.script))) {
        const titles = listed.find((file) => file.path === check.file)?.titles ?? [];
        if (!titles.some((title) => title.startsWith(`${check.testTag} `))) {
          findings.push({
            code: 'list_differs',
            script: check.script,
            path: check.file,
            detail: `tidak ada test dengan judul lengkap yang diawali "${check.testTag} "`,
          });
        }
      }
    }
    summary.push(`${group.runner} ${group.config} ${listed.length} file (${scripts.join(', ')})`);
  }
  const bunFiles = found.files.filter((file) => file.owners.some((owner) => owner.runner === 'bun:test')).length;
  summary.push(`bun:test ${bunFiles} file (dibuktikan dari JUnit pada laporan)`);

  if (findings.length > 0) {
    error(`Discovery test gagal dengan ${findings.length} masalah:`);
    for (const finding of findings) error(`  ${finding.code} ${finding.script ?? '-'} ${finding.path}: ${finding.detail}`);
    return 1;
  }
  log(`Discovery test lulus: ${found.files.length} file test, ${summary.join('; ')}.`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runTestDiscovery({ root: resolve(import.meta.dir, '..') });
  } catch {
    process.stderr.write('Discovery test tidak dapat dijalankan\n');
    process.exitCode = 1;
  }
}
