import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bundlePath,
  INPUT_FILES,
  INPUT_TREES,
  OUTPUT_FILES,
  OUTPUT_TREES,
  runTier,
  sha256,
  sourceTree,
  stepEnvironment,
  TIER_NAMES,
  TIERS,
  type CiIdentity,
  type EvidenceRecord,
  type StepRecord,
  type Tier,
  type TierManifest,
  type TierName,
} from '../../../scripts/lib/gate.ts';
import {
  buildReport,
  consoleLine,
  escapeCell,
  POSTGRES_FIELDS,
  renderMarkdown,
  REPORT_JSON,
  REPORT_MD,
  runReport,
  runnerText,
  worstStatus,
  type GateReport,
  type GateStatus,
} from '../../../scripts/lib/gate-report.ts';
import { ownersOf, RUNNER_OWNERS, runnerOwner, type RunnerOwner } from '../../../scripts/lib/test-inventory.ts';
import { lines, removeWorkspaces, workspace } from './workspace.ts';

// GATE-005 (spec 0010, AC-6) and GATE-006 (AC-7): `test:report` on fixture repositories. Each fixture is a git
// repository in a `mkdtemp` folder with one test file per runner owner, a registry, and the three tier bundles that
// the tier runner would write: manifests with every step, JUnit for every runner, `image.json`, `artifact-scan.json`,
// and `security.json`, each bound to its manifest by SHA 256. A test changes one thing and reads the report.

afterEach(removeWorkspaces);

type Outcome = 'passed' | 'failed' | 'skipped' | 'error';
type Case = { name: string; suites?: string[]; outcome?: Outcome; message?: string };
type Check = { runner: string; script: string; file: string; testTag?: string };
type Scenario = { id: string; criteria: string[]; critical?: boolean; checks: Check[] };

const SPEC = 'docs/specs/0001-fixture/index.md';

/** One test file per runner owner; the file content does not matter to the report. */
const TEST_FILES = [
  'apps/frontend/src/app/a.spec.ts',
  'tests/e2e/a.e2e.spec.ts',
  'tests/e2e/b.real.e2e.spec.ts',
  'tests/integration/backend/a.test.ts',
  'tests/integration/tooling/a.test.ts',
  'tests/integration/gate/a.test.ts',
  'tests/integration/database/a.test.ts',
  'tests/integration/database/migration.test.ts',
  'tests/integration/infrastructure/a.test.ts',
];

const bunCheck = (script: string, file: string, testTag: string): Check => ({ runner: 'bun:test', script, file, testTag });

const SCENARIOS: Scenario[] = [
  { id: 'FIX-001', criteria: ['AC-1'], checks: [bunCheck('test:gate', 'tests/integration/gate/a.test.ts', 'FIX-001')] },
  { id: 'FIX-002', criteria: ['AC-1'], checks: [{ runner: 'vitest', script: 'test:frontend', file: 'apps/frontend/src/app/a.spec.ts', testTag: 'FIX-002' }] },
  {
    id: 'FIX-003',
    criteria: ['AC-2'],
    critical: true,
    checks: [{ runner: 'playwright', script: 'test:e2e', file: 'tests/e2e/a.e2e.spec.ts', testTag: 'FIX-003' }],
  },
  { id: 'FIX-004', criteria: ['AC-2'], checks: [{ runner: 'command', script: 'check:workflow', file: 'scripts/check-workflow.ts' }] },
  { id: 'FIX-005', criteria: ['AC-3'], checks: [{ runner: 'command', script: 'test:ci:real', file: 'scripts/gate.ts' }] },
  {
    id: 'FIX-006',
    criteria: ['AC-3'],
    checks: [{ runner: 'playwright', script: 'test:readiness:real', file: 'tests/e2e/b.real.e2e.spec.ts', testTag: 'FIX-006' }],
  },
  { id: 'FIX-007', criteria: ['AC-3'], checks: [bunCheck('test:infrastructure', 'tests/integration/infrastructure/a.test.ts', 'FIX-007')] },
  { id: 'FIX-008', criteria: ['AC-1'], checks: [bunCheck('test:gate', 'tests/integration/gate/a.test.ts', 'FIX-008')] },
  { id: 'FIX-009', criteria: ['AC-1'], checks: [bunCheck('test:gate', 'tests/integration/gate/a.test.ts', 'FIX-009')] },
  { id: 'FIX-010', criteria: ['AC-1'], checks: [bunCheck('test:tooling', 'tests/integration/tooling/a.test.ts', 'FIX-010')] },
];

const IMAGE = {
  recordedAt: '2026-10-04T00:00:00.000Z',
  pins: { baseImage: 'oraclelinux:10-slim@sha256:aa', packageVersion: '18.6-4PGDG.rhel10.2' },
  image: 'foundation-postgres:18-pinned',
  imageId: `sha256:${'1'.repeat(64)}`,
  os: 'linux',
  architecture: 'amd64',
  baseImage: `oraclelinux:10-slim@sha256:${'2'.repeat(64)}`,
  baseIndexDigest: `sha256:${'2'.repeat(64)}`,
  basePlatformLayers: ['sha256:3'],
  serverVersion: '18.6',
  serverVersionNum: 180006,
  packageVersion: '18.6-4PGDG.rhel10.2',
  processUid: 26,
  packages: [{ name: 'postgresql18-server', version: '18.6' }],
};

/** A short `result.json` of the k6 smoke step (spec 0011, *Isi result.json*), enough for the report. */
const SMOKE_RESULT = {
  schema: 1,
  profile: 'smoke',
  status: 'passed',
  reasons: [],
  model: { iterationIsOneRequest: true, phases: [] },
  actual: null,
  latency: null,
  readiness: null,
  thresholds: null,
  observation: null,
  outage: null,
  environment: null,
  limits: ['Batas bukti fixture.'],
};

function scanner(name: string, coverage: object, status = 'passed') {
  return {
    name,
    version: name === 'bun audit' ? '1.4.2' : '1.0.0',
    image: name === 'bun audit' ? null : `example/${name}:1.0.0@sha256:${'4'.repeat(64)}`,
    status,
    reason: status === 'passed' ? null : 'invalid_output',
    coverage,
    counts: { failed: status === 'failed' ? 1 : 0, excepted: 0, reported: 1 },
    findings: [],
    unusedExceptions: [],
  };
}

function security(status: { gitleaks?: string; audit?: string; actionlint?: string } = {}) {
  const scanners = [
    scanner('gitleaks', { head: 'x', commitsReachable: 3, shallow: false }, status.gitleaks),
    scanner('bun audit', { packages: 12 }, status.audit),
    scanner('actionlint', { files: ['.github/workflows/application.yml'] }, status.actionlint),
  ];
  return {
    schema: 1,
    scannedAt: '2026-10-04T00:00:00.000Z',
    workingTreeClean: true,
    status: scanners.every((item) => item.status === 'passed') ? 'passed' : 'failed',
    scanners,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JUnit of the fixture, in the shape each runner writes.

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}

function caseXml(owner: RunnerOwner, item: Case): string {
  const inner =
    item.outcome === 'failed'
      ? '<failure message="assertion gagal"/>'
      : item.outcome === 'error'
        ? '<error message="kesalahan di luar assertion"/>'
      : item.outcome === 'skipped'
        ? item.message === undefined
          ? '<skipped/>'
          : `<skipped message="${attr(item.message)}"/>`
        : '';
  const suites = item.suites ?? [];
  if (owner.runner !== 'bun:test') {
    const name = [...suites, item.name].join(owner.runner === 'vitest' ? ' > ' : ' › ');
    return `<testcase name="${attr(name)}" classname="fixture">${inner}</testcase>`;
  }
  let xml = `<testcase name="${attr(item.name)}" classname="fixture">${inner}</testcase>`;
  for (const suite of [...suites].reverse()) xml = `<testsuite name="${attr(suite)}">${xml}</testsuite>`;
  return xml;
}

function suiteXml(owner: RunnerOwner, file: string, cases: readonly Case[]): string {
  const body = cases.map((item) => caseXml(owner, item)).join('');
  if (owner.junitPath.from === 'file-attribute') return `<testsuite name="${attr(file)}" file="${attr(file)}">${body}</testsuite>`;
  return `<testsuite name="${attr(file.slice(owner.junitPath.prefix.length))}">${body}</testsuite>`;
}

function defaultCases(script: string, file: string): Case[] {
  const tags = SCENARIOS.flatMap((scenario) => scenario.checks)
    .filter((check) => check.script === script && check.file === file && check.testTag !== undefined)
    .map((check) => check.testTag!);
  const cases: Case[] = tags.map((tag) => (tag === 'FIX-010' ? { suites: ['FIX-010 kelompok'], name: 'isi' } : { name: `${tag} lulus` }));
  cases.push({ name: 'test lain' });
  return cases;
}

/** File cases per script; `null` leaves the file out of that JUnit, an extra key adds a foreign file. */
type CaseOverrides = Record<string, Record<string, Case[] | null>>;

function junitOf(owner: RunnerOwner, overrides: CaseOverrides) {
  const files = new Map<string, Case[] | null>();
  for (const file of TEST_FILES) if (ownersOf(file).some((item) => item.script === owner.script)) files.set(file, defaultCases(owner.script, file));
  for (const [file, cases] of Object.entries(overrides[owner.script] ?? {})) files.set(file, cases);
  const suites: string[] = [];
  const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const [file, cases] of files) {
    if (cases === null) continue;
    suites.push(suiteXml(owner, file, cases));
    for (const item of cases) {
      counts.tests += 1;
      if (item.outcome === 'failed') counts.failures += 1;
      else if (item.outcome === 'error') counts.errors += 1;
      else if (item.outcome === 'skipped') counts.skipped += 1;
    }
  }
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="fixture">${suites.join('')}</testsuites>\n`, counts };
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture repository and bundles.

const gitEnv = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...gitEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

type Options = {
  /** Tiers whose bundle is not written at all. */
  omit?: TierName[];
  cases?: CaseOverrides;
  /** Content of `image.json`; `null` leaves it out of the bundle and records it as not present. */
  image?: object | null;
  security?: object;
  /** CI identity of every manifest, or a function of the tier; `null` (the default) for a local run. */
  ci?: Omit<CiIdentity, 'job'> | null;
  /** Last changes to the manifests before they are written. */
  change?: (manifests: Record<TierName, TierManifest>) => void;
};

type Fixture = { dir: string; commit: string; tree: string };

function registryJson(scenarios: readonly Scenario[]): string {
  return `${JSON.stringify({ source: SPEC, scenarios }, null, 2)}\n`;
}

async function repository(scenarios: readonly Scenario[] = SCENARIOS): Promise<Fixture> {
  const files: Record<string, string> = {
    '.gitignore': '.local/\n',
    'package.json': JSON.stringify({ name: 'fixture', private: true }),
    [SPEC]: '# Fixture\n\n- **AC-1**: satu.\n- **AC-2**: dua.\n- **AC-3**: tiga.\n',
    'tests/scenarios/fixture.json': registryJson(scenarios),
  };
  for (const file of TEST_FILES) files[file] = `// ${file}\n`;
  const dir = await workspace(files, 'foundation-gate-report-');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  const tree = await sourceTree(dir);
  return { dir, commit: git(dir, 'rev-parse', 'HEAD'), tree: tree! };
}

function stepRecord(script: string, evidence: EvidenceRecord[]): StepRecord {
  const failing = (item: EvidenceRecord) => (item.failures ?? 0) + (item.errors ?? 0) > 0;
  const failures = evidence.some(failing);
  const skipped = evidence.some((item) => (item.skipped ?? 0) > 0);
  const missing = evidence.filter((item) => item.required && !item.present);
  const reasons: StepRecord['reasons'] = [
    ...missing.map((item) => ({ code: 'evidence_missing' as const, path: item.path })),
    ...evidence.filter(failing).map((item) => ({ code: 'junit_failures' as const, path: item.path })),
  ];
  const status = reasons.length > 0 || failures ? 'failed' : skipped ? 'skipped' : 'passed';
  if (status === 'skipped') reasons.push(...evidence.filter((item) => (item.skipped ?? 0) > 0).map((item) => ({ code: 'testcase_skipped' as const, path: item.path })));
  return { script, status, reasons, exitCode: 0, durationMs: 10, timedOut: false, signal: null, leftoverPorts: [], evidence };
}

/** Writes the three bundles (minus `omit`) for `fixture`, as the tier runner would. */
async function bundles(fixture: Fixture, options: Options = {}): Promise<void> {
  const manifests = {} as Record<TierName, TierManifest>;
  const contents = {} as Record<TierName, Map<string, string>>;
  for (const name of TIER_NAMES) {
    const tier = TIERS[name]!;
    const files = new Map<string, string>();
    const steps = tier.steps.map((step) => {
      const evidence: EvidenceRecord[] = step.evidence.map((spec) => {
        if (spec.kind === 'screenshots') return { path: spec.path, kind: spec.kind, required: spec.required, present: false, files: [] };
        let text: string | null;
        let counts = {};
        if (spec.kind === 'junit') {
          const junit = junitOf(runnerOwner(step.script)!, options.cases ?? {});
          text = junit.xml;
          counts = junit.counts;
        } else if (spec.kind === 'image') text = options.image === null ? null : JSON.stringify(options.image ?? IMAGE);
        else if (spec.kind === 'scan') text = '{ "findings": [] }';
        // Spec 0011: the result.json of the k6 smoke step and its other JSON files.
        else if (spec.kind === 'performance') text = JSON.stringify(SMOKE_RESULT);
        else if (spec.kind === 'data') text = '{ "metrics": {} }';
        else text = JSON.stringify(options.security ?? security());
        const record: EvidenceRecord = { path: spec.path, kind: spec.kind, required: spec.required, present: text !== null, sha256: text === null ? null : sha256(text) };
        if (spec.runner !== null) Object.assign(record, { runner: spec.runner, ...counts });
        if (text !== null) files.set(spec.path, text);
        return record;
      });
      return stepRecord(step.script, evidence);
    });
    const ci = options.ci === undefined || options.ci === null ? null : { ...options.ci, job: tier.name === 'fast' ? 'application' : tier.name };
    manifests[name] = {
      schema: 1,
      tier: name,
      candidate: { commit: fixture.commit, clean: true, sourceTree: fixture.tree, sourceTreeAfter: fixture.tree, ci },
      environment: { os: 'linux', arch: 'x64', bun: '1.4.2', node: name === 'security' ? null : '24.21.0' },
      inputs: { 'bun.lock': sha256('lock'), 'apps/frontend/sdk/': sha256('sdk') },
      outputs: { 'dist/backend/index.js': 'absent' },
      steps,
      status: steps.every((step) => step.status === 'passed') ? 'passed' : 'failed',
      startedAt: '2026-10-04T00:00:00.000Z',
      finishedAt: '2026-10-04T00:01:00.000Z',
    };
    contents[name] = files;
  }
  options.change?.(manifests);
  for (const name of TIER_NAMES) {
    if (options.omit?.includes(name)) continue;
    const bundle = join(fixture.dir, bundlePath(name));
    for (const [path, text] of contents[name]) {
      await mkdir(dirname(join(bundle, path)), { recursive: true });
      await writeFile(join(bundle, path), text);
    }
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(manifests[name], null, 2)}\n`);
  }
}

const CI_RUN: Omit<CiIdentity, 'job'> = { runId: '1000', runAttempt: '1', sha: '', ref: 'refs/heads/main', event: 'push' };

/** The report process environment: enough for git, plus the CI identity of the report job when given. */
function reportEnv(ci?: Omit<CiIdentity, 'job'>): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? tmpdir() };
  if (ci === undefined) return env;
  const values: Record<string, string | null> = {
    GITHUB_RUN_ID: ci.runId,
    GITHUB_RUN_ATTEMPT: ci.runAttempt,
    GITHUB_JOB: 'report',
    GITHUB_SHA: ci.sha,
    GITHUB_REF: ci.ref,
    GITHUB_EVENT_NAME: ci.event,
  };
  for (const [name, value] of Object.entries(values)) if (value !== null) env[name] = value;
  return env;
}

async function report(options: Options = {}, env?: (fixture: Fixture) => Record<string, string>): Promise<{ fixture: Fixture; report: GateReport }> {
  const fixture = await repository();
  await bundles(fixture, options);
  return { fixture, report: await buildReport(fixture.dir, env?.(fixture) ?? reportEnv()) };
}

function scenario(found: GateReport, id: string) {
  const item = found.scenarios.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no scenario ${id}`);
  return item;
}

function problems(found: GateReport): string[] {
  return found.binding.problems.map((problem) => [problem.code, problem.tier ?? 'laporan', problem.path].filter((part) => part !== null).join(' '));
}

function reasons(found: GateReport): string[] {
  return found.releaseCandidate.reasons.map((reason) => (reason.tier === null ? reason.code : `${reason.code} ${reason.tier}`));
}

/** Unescaped `|` in one Markdown line. */
function pipes(line: string): number {
  return (line.match(/(?<!\\)\|/g) ?? []).length;
}

// ---------------------------------------------------------------------------------------------------------------
// GATE-005: check status, scenario status, critical flows, gate, and Markdown (AC-6).

test('GATE-005 a complete fixture run passes every check, discovery, and the scanners, and test:report exits 0', async () => {
  const fixture = await repository();
  await bundles(fixture);
  const output = lines();
  expect(await runReport(fixture.dir, output.log, reportEnv())).toBe(0);
  const found = JSON.parse(await readFile(join(fixture.dir, REPORT_JSON), 'utf8')) as GateReport;
  expect(Object.keys(found)).toEqual([
    'schema', 'generatedAt', 'candidate', 'binding', 'tiers', 'postgres', 'discovery', 'scenarios', 'critical', 'scanners', 'gate', 'releaseCandidate', 'outOfScope',
    'performance',
  ]);
  expect(found.gate).toBe('passed');
  expect(found.binding).toEqual({ valid: true, problems: [] });
  expect(found.discovery).toEqual({ status: 'passed', problems: [] });
  expect(found.scenarios.map((item) => item.status)).toEqual(SCENARIOS.map(() => 'passed'));
  expect(scenario(found, 'FIX-001').checks[0]).toMatchObject({
    status: 'passed',
    counts: { passed: 1, failed: 0, skipped: 0 },
    evidence: '.local/feature-11/evidence/fast/.local/feature-11/gate.xml',
  });
  expect(scenario(found, 'FIX-004').checks[0]).toMatchObject({ status: 'passed', exitCode: 0, counts: null });
  expect(found.scanners?.scanners.map((item) => [item.name, item.status])).toEqual([
    ['gitleaks', 'passed'],
    ['bun audit', 'passed'],
    ['actionlint', 'passed'],
  ]);
  expect(found.scanners?.scanners[0]).not.toHaveProperty('findings');
  expect(found.outOfScope).toEqual([{ area: 'capacity_profiles', feature: 12 }, { area: 'deployment_image', feature: 13 }]);
  // Spec 0011 (*Laporan per push*): the bound result.json of the k6 smoke step.
  expect(found.performance.map((item) => [item.tier, item.script, item.profile, item.status, item.evidence])).toEqual([
    ['real', 'test:performance:smoke', 'smoke', 'passed', '.local/feature-11/evidence/real/.local/feature-12/smoke/result.json'],
  ]);
  expect(output.out[0]).toBe('Gate passed');
  expect(await readFile(join(fixture.dir, REPORT_MD), 'utf8')).toContain('## Di luar cakupan');
});

test('GATE-005 failed, skipped with the runner reason, and missing_test come only from matching testcases', async () => {
  const { report: found } = await report({
    cases: {
      'test:gate': { 'tests/integration/gate/a.test.ts': [{ name: 'FIX-001 gagal', outcome: 'failed' }, { name: 'FIX-008 lulus' }, { name: 'FIX-009 lulus' }] },
      'test:frontend': {
        'apps/frontend/src/app/a.spec.ts': [
          { name: 'FIX-002 butuh browser', outcome: 'skipped', message: 'browser tidak tersedia' },
          { name: 'FIX-002 dari judul (dilewati: tanpa jaringan)', outcome: 'skipped' },
          { name: 'FIX-002 tanpa alasan', outcome: 'skipped' },
          { name: 'FIX-002 lulus' },
        ],
      },
      'test:infrastructure': { 'tests/integration/infrastructure/a.test.ts': [{ name: 'tanpa tag FIX-007' }, { name: 'FIX-0070 bukan tag ini' }] },
    },
  });
  expect(scenario(found, 'FIX-001').checks[0]).toMatchObject({ status: 'failed', counts: { passed: 0, failed: 1, skipped: 0 } });
  expect(scenario(found, 'FIX-002').checks[0]).toMatchObject({
    status: 'skipped',
    counts: { passed: 1, failed: 0, skipped: 3 },
    reasons: [
      { code: 'runner_skip', path: '.local/feature-4/frontend.xml', text: 'browser tidak tersedia' },
      { code: 'runner_skip', path: '.local/feature-4/frontend.xml', text: 'tanpa jaringan' },
      { code: 'runner_skip', path: '.local/feature-4/frontend.xml', text: 'runner tidak memberi alasan' },
    ],
  });
  expect(scenario(found, 'FIX-007').checks[0]).toMatchObject({
    status: 'missing_test',
    reasons: [{ code: 'no_matching_testcase', path: '.local/feature-3/infrastructure.xml' }],
  });
  expect(found.gate).toBe('failed');
});

test('GATE-005 one file with two tags gives each check its own status, and a tag on the outermost describe matches', async () => {
  const { report: found } = await report({
    cases: {
      'test:gate': {
        'tests/integration/gate/a.test.ts': [
          { name: 'FIX-001 lulus' },
          { name: 'FIX-008 gagal', outcome: 'failed' },
          { name: 'FIX-009 lulus' },
          { name: 'gagal tanpa tag', outcome: 'failed' },
        ],
      },
      'test:tooling': { 'tests/integration/tooling/a.test.ts': [{ suites: ['FIX-010 kelompok', 'dalam'], name: 'isi' }, { suites: ['kelompok FIX-010'], name: 'bukan awalan' }] },
    },
  });
  expect(scenario(found, 'FIX-001').status).toBe('passed');
  expect(scenario(found, 'FIX-008').status).toBe('failed');
  expect(scenario(found, 'FIX-009').status).toBe('passed');
  expect(scenario(found, 'FIX-010').checks[0]).toMatchObject({ status: 'passed', counts: { passed: 1, failed: 0, skipped: 0 } });
});

test('GATE-005 not_run carries its reason: previous_step for a step that did not run, tier_not_run without a manifest', async () => {
  const { report: found } = await report({
    omit: ['real'],
    change: (manifests) => {
      const steps = manifests.fast.steps;
      const index = steps.findIndex((step) => step.script === 'test:e2e');
      steps[index] = { ...steps[index]!, status: 'not_run', reasons: [{ code: 'previous_step', path: null }], exitCode: null, evidence: [] };
      manifests.fast.status = 'failed';
    },
  });
  expect(scenario(found, 'FIX-003').checks[0]).toMatchObject({ status: 'not_run', reasons: [{ code: 'previous_step', path: null }] });
  expect(scenario(found, 'FIX-006').checks[0]).toMatchObject({ status: 'not_run', reasons: [{ code: 'tier_not_run', path: null }] });
  expect(scenario(found, 'FIX-005').checks[0]).toMatchObject({ status: 'not_run', reasons: [{ code: 'tier_not_run', path: null }] });
  expect(found.tiers.real).toEqual({ status: 'not_run', runAttempt: null, environment: null, inputs: null, outputs: null, steps: [] });
  expect(found.gate).toBe('incomplete');
});

test('GATE-005 a scenario takes its worst check in the order failed, missing_test, not_run, skipped, passed', async () => {
  expect(worstStatus(['passed', 'skipped'])).toBe('skipped');
  expect(worstStatus(['skipped', 'not_run', 'passed'])).toBe('not_run');
  expect(worstStatus(['not_run', 'missing_test'])).toBe('missing_test');
  expect(worstStatus(['missing_test', 'failed', 'passed'])).toBe('failed');
  expect(worstStatus(['passed', 'passed'])).toBe('passed');

  const scenarios: Scenario[] = [
    {
      id: 'FIX-020',
      criteria: ['AC-1'],
      checks: [
        bunCheck('test:gate', 'tests/integration/gate/a.test.ts', 'FIX-001'),
        bunCheck('test:gate', 'tests/integration/gate/a.test.ts', 'FIX-099'),
        { runner: 'command', script: 'check:workflow', file: 'scripts/check-workflow.ts' },
      ],
    },
  ];
  const fixture = await repository(scenarios);
  await bundles(fixture);
  const found = await buildReport(fixture.dir, reportEnv());
  expect(found.scenarios.map((item) => [item.id, item.status, item.checks.map((check) => check.status)])).toEqual([
    ['FIX-020', 'missing_test', ['passed', 'missing_test', 'passed']],
  ]);
  expect(found.gate).toBe('incomplete');
});

test('GATE-005 a check that names the root script of a tier takes the tier status', async () => {
  const failed = await report({
    change: (manifests) => {
      const step = manifests.real.steps.find((item) => item.script === 'test:tooling:real')!;
      Object.assign(step, { status: 'failed', exitCode: 1, reasons: [{ code: 'exit_code', path: null }] });
      manifests.real.status = 'failed';
    },
  });
  expect(scenario(failed.report, 'FIX-005').checks[0]).toMatchObject({ status: 'failed', script: 'test:ci:real' });
  expect(failed.report.gate).toBe('failed');
  const passed = await report();
  expect(scenario(passed.report, 'FIX-005').checks[0]).toMatchObject({ status: 'passed', reasons: [] });
});

test('GATE-005 the critical flow section lists every critical scenario with its status', async () => {
  const { report: found } = await report({ cases: { 'test:e2e': { 'tests/e2e/a.e2e.spec.ts': [{ name: 'FIX-003 alur', outcome: 'failed' }] } } });
  expect(found.critical).toEqual([{ id: 'FIX-003', status: 'failed' }]);
  const markdown = renderMarkdown(found);
  const section = markdown.slice(markdown.indexOf('## Alur kritis'), markdown.indexOf('## Hasil per skenario'));
  expect(section).toContain('| FIX-003 | failed |');
});

test('GATE-005 the gate is passed, failed, or incomplete, and test:report exits 0 only for passed', async () => {
  const cases: Array<[string, Options, GateStatus, number]> = [
    ['lengkap', {}, 'passed', 0],
    ['check gagal', { cases: { 'test:gate': { 'tests/integration/gate/a.test.ts': [{ name: 'FIX-001 x', outcome: 'failed' }, { name: 'FIX-008 y' }, { name: 'FIX-009 z' }] } } }, 'failed', 1],
    ['pemindai gagal', { security: security({ audit: 'failed' }) }, 'failed', 1],
    ['pemindai tidak berjalan', { security: security({ gitleaks: 'not_run' }) }, 'incomplete', 1],
    ['tier keamanan tidak ada', { omit: ['security'] }, 'incomplete', 1],
    ['testcase dilewati', { cases: { 'test:gate': { 'tests/integration/gate/a.test.ts': [{ name: 'FIX-001 x', outcome: 'skipped' }, { name: 'FIX-008 y' }, { name: 'FIX-009 z' }] } } }, 'incomplete', 1],
  ];
  for (const [label, options, gate, code] of cases) {
    const fixture = await repository();
    await bundles(fixture, options);
    const output = lines();
    expect(await runReport(fixture.dir, output.log, reportEnv()), label).toBe(code);
    const found = JSON.parse(await readFile(join(fixture.dir, REPORT_JSON), 'utf8')) as GateReport;
    expect(found.gate, label).toBe(gate);
    expect(output.out[0], label).toBe(`Gate ${gate}`);
  }
}, 60_000);

test('GATE-005 discovery from JUnit fails the gate for a foreign file or an owned file missing from the JUnit of its script', async () => {
  const { report: found } = await report({
    cases: {
      'test:tooling': { 'tests/integration/gate/a.test.ts': [{ name: 'salah tempat' }] },
      'test:database:real': { 'tests/integration/database/migration.test.ts': null },
    },
  });
  expect(found.discovery).toEqual({
    status: 'failed',
    problems: [
      { code: 'junit_foreign_file', script: 'test:tooling', path: 'tests/integration/gate/a.test.ts' },
      { code: 'junit_missing_file', script: 'test:database:real', path: 'tests/integration/database/migration.test.ts' },
    ],
  });
  expect(found.gate).toBe('failed');
  // Without the JUnit of one runner, discovery cannot be proven: not_run, so the gate is incomplete.
  const missing = await report({ omit: ['real'] });
  expect(missing.report.discovery.status).toBe('not_run');
  expect(RUNNER_OWNERS.some((owner) => owner.script === 'test:infrastructure')).toBe(true);
});

test('GATE-005 report.md holds the release template columns, and a runner title with | and a newline stays one table row', async () => {
  const { report: found } = await report({
    cases: {
      'test:frontend': { 'apps/frontend/src/app/a.spec.ts': [{ name: 'FIX-002 judul | pipa\nbaris (dilewati: alasan | dengan\nbaris baru)', outcome: 'skipped' }] },
    },
  });
  const markdown = renderMarkdown(found);
  const header = '| ID | Kriteria dan rujukan specs | Test dan profil | Wajib untuk release | Status | Hasil aktual dan tautan bukti |';
  expect(markdown).toContain(header);
  const rows = markdown.split('\n').filter((line) => line.startsWith('| FIX-0') && line.includes('; profil k6 tidak ada |'));
  expect(rows).toHaveLength(SCENARIOS.length);
  for (const line of rows) expect(pipes(line)).toBe(7);
  const skipped = rows.find((line) => line.startsWith('| FIX-002 | AC-1;'))!;
  expect(skipped).toContain('runner\\_skip: alasan \\| denganbaris baru');
  expect(pipes(skipped)).toBe(7);
  const critical = rows.find((line) => line.startsWith('| FIX-003 | AC-2;'))!;
  expect(critical).toContain('| ya, alur kritis | passed |');
  expect(critical).toContain('playwright test:e2e tests/e2e/a.e2e.spec.ts FIX-003; profil k6 tidak ada');
  const command = rows.find((line) => line.startsWith('| FIX-004 |'))!;
  expect(command).toContain('exit code 0, passed');
  for (const heading of ['## Kandidat', '## Pengikatan', '## Tier', '### Checksum input per tier', '### Checksum output per tier', '## Identitas PostgreSQL', '## Pemindai', '## Discovery', '## Alur kritis', '## Hasil per skenario', '## Performance k6', '## Kandidat release', '## Di luar cakupan']) {
    expect(markdown).toContain(`\n${heading}\n`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// GATE-006: binding, release candidate, PostgreSQL identity, and the job summary (AC-7).

test('GATE-006 binding rejects each problem with its own code', async () => {
  const cases: Array<[string, (fixture: Fixture) => Options, string[]]> = [
    ['commit berbeda', () => ({ change: (m) => void (m.fast.candidate.commit = 'a'.repeat(40)) }), ['commit_differs fast']],
    ['pohon sumber berbeda', () => ({ change: (m) => void Object.assign(m.real.candidate, { sourceTree: 'b'.repeat(64), sourceTreeAfter: 'b'.repeat(64) }) }), ['source_tree_differs real']],
    ['pohon sumber berubah selama tier', () => ({ change: (m) => void (m.security.candidate.sourceTreeAfter = 'c'.repeat(64)) }), ['source_tree_changed security']],
    ['tanpa commit', () => ({ change: (m) => void (m.real.candidate.commit = null) }), ['no_commit real']],
    ['manifest hilang', () => ({ omit: ['security'] }), ['manifest_missing security']],
  ];
  for (const [label, options, expected] of cases) {
    const fixture = await repository();
    await bundles(fixture, options(fixture));
    const found = await buildReport(fixture.dir, reportEnv());
    expect(problems(found), label).toEqual(expected);
    expect(found.binding.valid, label).toBe(false);
    expect(found.gate, label).toBe('incomplete');
  }

  // An evidence file changed after the tier wrote its manifest, and a manifest that is not valid.
  const fixture = await repository();
  await bundles(fixture);
  await writeFile(join(fixture.dir, bundlePath('fast'), '.local/feature-11/gate.xml'), '<testsuites/>');
  await writeFile(join(fixture.dir, bundlePath('real'), 'manifest.json'), '{ "schema": 1, "tier": "real" }');
  const found = await buildReport(fixture.dir, reportEnv());
  expect(problems(found)).toEqual(['evidence_hash_differs fast .local/feature-11/gate.xml', 'manifest_invalid real']);
  expect(scenario(found, 'FIX-001').status).toBe('missing_test');
  expect(found.gate).toBe('incomplete');
}, 60_000);

test('GATE-006 binding rejects another CI run, another attempt between tiers or with the report job, and mixed CI and local manifests', async () => {
  const run = (fixture: Fixture) => ({ ...CI_RUN, sha: fixture.commit });
  const cases: Array<[string, (fixture: Fixture) => Options, (fixture: Fixture) => Omit<CiIdentity, 'job'> | undefined, string[]]> = [
    ['satu run', (f) => ({ ci: run(f) }), run, []],
    ['run lain', (f) => ({ ci: run(f), change: (m) => void (m.real.candidate.ci!.runId = '999') }), run, ['ci_identity_differs real']],
    ['ref lain', (f) => ({ ci: run(f), change: (m) => void (m.fast.candidate.ci!.ref = 'refs/heads/x') }), run, ['ci_identity_differs fast']],
    ['attempt antar tier', (f) => ({ ci: run(f), change: (m) => void (m.security.candidate.ci!.runAttempt = '2') }), run, ['ci_attempt_differs security']],
    ['attempt job laporan', (f) => ({ ci: run(f) }), (f) => ({ ...run(f), runAttempt: '2' }), ['ci_attempt_differs fast', 'ci_attempt_differs real', 'ci_attempt_differs security']],
    ['campuran manifest', (f) => ({ ci: run(f), change: (m) => void (m.fast.candidate.ci = null) }), run, ['ci_mixed fast']],
    ['laporan lokal', (f) => ({ ci: run(f) }), () => undefined, ['ci_mixed fast', 'ci_mixed real', 'ci_mixed security']],
    ['sha job laporan lain', (f) => ({ ci: { ...run(f), sha: 'd'.repeat(40) } }), (f) => ({ ...run(f), sha: 'd'.repeat(40) }), ['ci_identity_differs laporan']],
  ];
  for (const [label, options, ci, expected] of cases) {
    const fixture = await repository();
    await bundles(fixture, options(fixture));
    const found = await buildReport(fixture.dir, reportEnv(ci(fixture)));
    expect(problems(found), label).toEqual(expected);
    expect(found.gate, label).toBe(expected.length === 0 ? 'passed' : 'incomplete');
  }
}, 60_000);

test('GATE-006 a tracked file deleted from the working tree is counted with the deleted marker, and node null does not touch the binding', async () => {
  const dir = await workspace({ 'a.txt': 'satu\n', 'b.txt': 'dua\n' }, 'foundation-gate-tree-');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'tree');
  const before = await sourceTree(dir);
  await rm(join(dir, 'b.txt'));
  const after = await sourceTree(dir);
  const treeLines = [`${sha256('satu\n')}  a.txt`, 'deleted  b.txt'].sort();
  expect(after).toBe(sha256(treeLines.map((line) => `${line}\n`).join('')));
  expect(after).not.toBe(before);

  const { report: found } = await report({ change: (m) => void TIER_NAMES.forEach((name) => (m[name].environment.node = null)) });
  expect(found.binding.valid).toBe(true);
  expect(found.gate).toBe('passed');
  expect(found.tiers.fast.environment?.node).toBeNull();
});

test('GATE-006 the release candidate lists every unmet condition as { code, tier } in the order of the Kandidat release row', async () => {
  const run = (fixture: Fixture) => ({ ...CI_RUN, sha: fixture.commit });
  const pr = (fixture: Fixture) => ({ ...run(fixture), ref: 'refs/pull/7/merge', event: 'pull_request' });
  const failing: CaseOverrides = { 'test:gate': { 'tests/integration/gate/a.test.ts': [{ name: 'FIX-001 x', outcome: 'failed' }, { name: 'FIX-008 y' }, { name: 'FIX-009 z' }] } };
  const cases: Array<[string, (fixture: Fixture) => Options, (fixture: Fixture) => Omit<CiIdentity, 'job'> | undefined, GateStatus, string[]]> = [
    ['push ke main yang lulus dan bersih', (f) => ({ ci: run(f) }), run, 'passed', []],
    ['gate gagal', (f) => ({ ci: run(f), cases: failing }), run, 'failed', ['gate_not_passed']],
    ['tier nyata tidak bersih', (f) => ({ ci: run(f), change: (m) => void (m.real.candidate.clean = false) }), run, 'passed', ['not_clean real']],
    ['run lokal yang lulus', () => ({}), () => undefined, 'passed', ['not_ci fast', 'not_ci real', 'not_ci security', 'not_ci']],
    ['push ke branch lain', (f) => ({ ci: { ...run(f), ref: 'refs/heads/feature' } }), (f) => ({ ...run(f), ref: 'refs/heads/feature' }), 'passed', ['ref_not_main']],
    ['pull request', (f) => ({ ci: pr(f) }), pr, 'passed', ['event_not_push', 'ref_not_main']],
    ['attempt berbeda', (f) => ({ ci: run(f), change: (m) => void (m.real.candidate.ci!.runAttempt = '2') }), run, 'incomplete', ['gate_not_passed']],
    ['manifest keamanan hilang', () => ({ omit: ['security'] }), () => undefined, 'incomplete', ['gate_not_passed', 'not_ci fast', 'not_ci real', 'not_ci']],
    [
      'beberapa syarat sekaligus',
      (f) => ({ ci: pr(f), cases: failing, change: (m) => void ((m.fast.candidate.clean = false), (m.security.candidate.clean = false)) }),
      pr,
      'failed',
      ['gate_not_passed', 'not_clean fast', 'not_clean security', 'event_not_push', 'ref_not_main'],
    ],
  ];
  for (const [label, options, ci, gate, expected] of cases) {
    const fixture = await repository();
    await bundles(fixture, options(fixture));
    const found = await buildReport(fixture.dir, reportEnv(ci(fixture)));
    expect(found.gate, label).toBe(gate);
    expect(reasons(found), label).toEqual(expected);
    expect(found.releaseCandidate.value, label).toBe(expected.length === 0);
  }
}, 90_000);

test('GATE-006 the exit code follows the gate only, and report.md writes the release candidate line', async () => {
  const fixture = await repository();
  await bundles(fixture);
  const output = lines();
  expect(await runReport(fixture.dir, output.log, reportEnv())).toBe(0);
  const markdown = await readFile(join(fixture.dir, REPORT_MD), 'utf8');
  const line = 'Kandidat release: bukan (`not_ci` fast, `not_ci` real, `not_ci` security, `not_ci`)';
  expect(markdown.split('\n').filter((item) => item === line)).toHaveLength(2);
  expect(output.out).toContain('  Kandidat release: bukan (not_ci fast, not_ci real, not_ci security, not_ci)');

  const released = await repository();
  await bundles(released, { ci: { ...CI_RUN, sha: released.commit } });
  expect(await runReport(released.dir, () => undefined, reportEnv({ ...CI_RUN, sha: released.commit }))).toBe(0);
  expect(await readFile(join(released.dir, REPORT_MD), 'utf8')).toContain('\nKandidat release: ya\n');
});

test('GATE-006 test:report appends report.md to GITHUB_STEP_SUMMARY when that variable exists', async () => {
  const fixture = await repository();
  await bundles(fixture);
  // The summary file sits in the ignored `.local/`, so it does not change the source tree of the checkout.
  const summary = join(fixture.dir, '.local/summary.md');
  await writeFile(summary, 'langkah sebelumnya\n');
  expect(await runReport(fixture.dir, () => undefined, { ...reportEnv(), GITHUB_STEP_SUMMARY: summary })).toBe(0);
  const markdown = await readFile(join(fixture.dir, REPORT_MD), 'utf8');
  expect(await readFile(summary, 'utf8')).toBe(`langkah sebelumnya\n${markdown}\n`);
});

test('GATE-006 postgres holds the eight identity fields of a bound image.json, and null when it is missing, changed, or incomplete', async () => {
  const { report: found } = await report();
  expect(found.postgres).toEqual({
    image: IMAGE.image,
    imageId: IMAGE.imageId,
    os: IMAGE.os,
    architecture: IMAGE.architecture,
    baseImage: IMAGE.baseImage,
    baseIndexDigest: IMAGE.baseIndexDigest,
    serverVersion: IMAGE.serverVersion,
    packageVersion: IMAGE.packageVersion,
    evidence: '.local/feature-11/evidence/real/.local/feature-3/image.json',
  });
  expect(Object.keys(found.postgres!)).toEqual([...POSTGRES_FIELDS, 'evidence']);
  const markdown = renderMarkdown(found);
  expect(markdown).toContain('Ini image yang diuji tier nyata, bukan image deployment (fitur 13).');
  expect(markdown).toContain(`| serverVersion | ${IMAGE.serverVersion} |`);

  const { serverVersion: _omitted, ...incomplete } = IMAGE;
  const missing = await report({ image: null });
  const partial = await report({ image: incomplete });
  const changed = await repository();
  await bundles(changed);
  await writeFile(join(changed.dir, bundlePath('real'), '.local/feature-3/image.json'), JSON.stringify({ ...IMAGE, image: 'lain' }));
  const changedReport = await buildReport(changed.dir, reportEnv());
  for (const [label, item] of [['tidak ada', missing.report], ['field hilang', partial.report], ['hash berbeda', changedReport]] as const) {
    expect(item.postgres, label).toBeNull();
    expect(renderMarkdown(item), label).toContain('Identitas PostgreSQL tidak tersedia karena `image.json` tidak ada di bundle tier nyata');
  }
  expect(problems(changedReport)).toEqual(['evidence_hash_differs real .local/feature-3/image.json']);
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------
// Added by /test (spec 0010): runner text and table cells, scenario aggregation through the report, the gate status from
// steps, discovery, and scanners, the command line, and the manifest identity that the real tier runner writes.

test('GATE-005 runner text loses its control characters and is cut to 200 characters, and escapeCell keeps a cell on one line', () => {
  // covers: AC-6 (Kode alasan: teks bebas dipotong 200 karakter dan di-escape)
  expect(runnerText('a\u0000b\u0007c\u001fd\u007fe\u0085f\u009fg\nh\ti\r')).toBe('abcdefghi');
  expect(runnerText('x'.repeat(300))).toBe('x'.repeat(200));
  // Characters, not UTF-16 units: a cut never splits a surrogate pair.
  expect(Array.from(runnerText('😀'.repeat(250)))).toHaveLength(200);
  expect(runnerText('😀'.repeat(250))).toBe('😀'.repeat(200));
  expect(escapeCell('a|b`c<d>e*f_g[h]i\nj\\k\r\nl\rm')).toBe('a\\|b\\`c\\<d\\>e\\*f\\_g\\[h\\]i\\nj\\\\k\\nl\\nm');
  // A literal backslash n stays apart from an escaped newline.
  expect(escapeCell('a\\nb')).toBe('a\\\\nb');
  expect(escapeCell('a\nb')).toBe('a\\nb');
});

test('GATE-005 a skip reason from the runner reaches the report without control characters and cut to 200 characters', async () => {
  // covers: AC-6 (Alasan skipped)
  const { report: found } = await report({
    cases: { 'test:frontend': { 'apps/frontend/src/app/a.spec.ts': [{ name: 'FIX-002 panjang', outcome: 'skipped', message: `\u0007${'y'.repeat(300)}` }] } },
  });
  expect(scenario(found, 'FIX-002').checks[0]?.reasons).toEqual([{ code: 'runner_skip', path: '.local/feature-4/frontend.xml', text: 'y'.repeat(200) }]);
});

test('GATE-005 the report gives each scenario the worst status of its checks', async () => {
  // covers: AC-6 (Status skenario adalah status check terburuk)
  const gateFile = 'tests/integration/gate/a.test.ts';
  const toolingFile = 'tests/integration/tooling/a.test.ts';
  const scenarios: Scenario[] = [
    { id: 'FIX-030', criteria: ['AC-1'], checks: [bunCheck('test:gate', gateFile, 'FIX-001'), bunCheck('test:gate', gateFile, 'FIX-009')] },
    { id: 'FIX-031', criteria: ['AC-1'], checks: [bunCheck('test:gate', gateFile, 'FIX-009'), bunCheck('test:tooling', toolingFile, 'FIX-010')] },
    { id: 'FIX-032', criteria: ['AC-1'], checks: [bunCheck('test:tooling', toolingFile, 'FIX-010'), bunCheck('test:gate', gateFile, 'FIX-099')] },
    { id: 'FIX-033', criteria: ['AC-1'], checks: [bunCheck('test:gate', gateFile, 'FIX-099'), bunCheck('test:gate', gateFile, 'FIX-008')] },
    { id: 'FIX-034', criteria: ['AC-1'], checks: [bunCheck('test:gate', gateFile, 'FIX-001'), { runner: 'command', script: 'check:workflow', file: 'scripts/check-workflow.ts' }] },
  ];
  const fixture = await repository(scenarios);
  await bundles(fixture, {
    cases: {
      'test:gate': { [gateFile]: [{ name: 'FIX-001 lulus' }, { name: 'FIX-008 gagal', outcome: 'failed' }, { name: 'FIX-009 dilewati', outcome: 'skipped', message: 'butuh layanan' }] },
    },
    change: (manifests) => {
      const steps = manifests.fast.steps;
      const index = steps.findIndex((step) => step.script === 'test:tooling');
      steps[index] = { ...steps[index]!, status: 'not_run', reasons: [{ code: 'previous_step', path: null }], exitCode: null, evidence: [] };
      manifests.fast.status = 'failed';
    },
  });
  const found = await buildReport(fixture.dir, reportEnv());
  expect(found.scenarios.map((item) => [item.id, item.checks.map((check) => check.status), item.status])).toEqual([
    ['FIX-030', ['passed', 'skipped'], 'skipped'],
    ['FIX-031', ['skipped', 'not_run'], 'not_run'],
    ['FIX-032', ['not_run', 'missing_test'], 'missing_test'],
    ['FIX-033', ['missing_test', 'failed'], 'failed'],
    ['FIX-034', ['passed', 'passed'], 'passed'],
  ]);
  expect(found.gate).toBe('failed');
});

test('GATE-005 a failed step without a check, the discovery step, and an unusable or incomplete security.json decide the gate', async () => {
  // covers: AC-6 (gate failed bila langkah tier, discovery, atau kebijakan pemindai gagal; selain itu incomplete)
  const setStep = (script: string, status: 'failed' | 'not_run') => (manifests: Record<TierName, TierManifest>) => {
    const steps = manifests.fast.steps;
    const index = steps.findIndex((step) => step.script === script);
    const reasons = status === 'failed' ? [{ code: 'exit_code' as const, path: null }] : [{ code: 'previous_step' as const, path: null }];
    steps[index] = { ...steps[index]!, status, reasons, exitCode: status === 'failed' ? 1 : null };
    manifests.fast.status = 'failed';
  };
  const full = security();
  const cases: Array<[string, Options, GateStatus, GateReport['discovery']['status'], boolean]> = [
    ['build gagal tanpa check', { change: setStep('build:frontend', 'failed') }, 'failed', 'passed', true],
    ['discovery gagal', { change: setStep('check:test-discovery', 'failed') }, 'failed', 'failed', true],
    ['discovery tidak berjalan', { change: setStep('check:test-discovery', 'not_run') }, 'incomplete', 'not_run', true],
    ['security.json schema lain', { security: { ...full, schema: 2 } }, 'incomplete', 'passed', false],
    ['pemindai tanpa counts', { security: { ...full, scanners: [{ ...full.scanners[0], counts: undefined }, ...full.scanners.slice(1)] } }, 'incomplete', 'passed', false],
    ['pemindai tidak dikenal', { security: { ...full, scanners: [...full.scanners, { ...full.scanners[0], name: 'trivy' }] } }, 'incomplete', 'passed', false],
    ['actionlint tidak ada', { security: { ...full, scanners: full.scanners.slice(0, 2) } }, 'incomplete', 'passed', true],
  ];
  for (const [label, options, gate, discovery, scanners] of cases) {
    const { report: found } = await report(options);
    expect(found.gate, label).toBe(gate);
    expect(found.discovery.status, label).toBe(discovery);
    expect(found.scanners !== null, label).toBe(scanners);
    if (!scanners) expect(renderMarkdown(found), label).toContain('Hasil pemindai tidak tersedia karena `security.json`');
  }
}, 90_000);

test('GATE-005 scripts/gate-report.ts exits 1 for an incomplete gate and when the registries cannot be read, with one short line', async () => {
  // covers: AC-6 (test:report keluar 0 hanya untuk gate passed)
  // A copy of the scripts runs in a workspace without bundles, so the report of the repository is never touched.
  const dir = await workspace({ 'tests/scenarios/broken.json': '{ "source": ' }, 'foundation-gate-report-cli-');
  const scripts = join(import.meta.dir, '../../../scripts');
  await cp(join(scripts, 'gate-report.ts'), join(dir, 'scripts/gate-report.ts'));
  await cp(join(scripts, 'lib'), join(dir, 'scripts/lib'), { recursive: true });
  const runCli = async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/gate-report.ts'], { cwd: dir, env: reportEnv(), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };

  const broken = await runCli();
  expect(broken).toEqual({ stdout: '', stderr: 'Laporan gate tidak dapat disusun\n', code: 1 });
  expect(await Bun.file(join(dir, REPORT_JSON)).exists()).toBe(false);

  await rm(join(dir, 'tests/scenarios/broken.json'));
  const incomplete = await runCli();
  expect(incomplete.code).toBe(1);
  expect(incomplete.stdout.split('\n')[0]).toBe('Gate incomplete');
  expect(incomplete.stdout).toContain('  tier: fast not_run, real not_run, security not_run');
  expect(incomplete.stdout).toContain('pengikatan tidak sah: manifest_missing fast, manifest_missing real, manifest_missing security, no_commit');
  const written = JSON.parse(await readFile(join(dir, REPORT_JSON), 'utf8')) as GateReport;
  expect(written.gate).toBe('incomplete');
  expect(await Bun.file(join(dir, REPORT_MD)).exists()).toBe(true);
}, 30_000);

// The manifest identity (AC-7) as the tier runner writes it on a fixture git repository.

const tierFiles: Record<string, string> = {
  '.gitignore': '.local/\ndist/\napps/frontend/dist/\n',
  'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: { ok: 'true', touch: 'echo dua >> tracked.txt', restore: 'git checkout -- tracked.txt' } }),
  'tracked.txt': 'satu\n',
  'tests/scenarios/x.json': `${JSON.stringify({ source: SPEC, scenarios: [] })}\n`,
  'apps/frontend/sdk/index.ts': 'export {};\n',
  [SPEC]: '# Fixture\n\n- **AC-1**: satu.\n',
};

/** The *Pohon sumber* rule written out by hand: sorted `<sha256>  <path>` lines, each ending in a newline. */
function manualTree(files: Record<string, string>, prefix = ''): string {
  const treeLines = Object.entries(files)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, content]) => `${sha256(content)}  ${path}`)
    .sort();
  return sha256(treeLines.map((line) => `${line}\n`).join(''));
}

async function tierRepository(git_ = true): Promise<string> {
  const dir = await workspace(tierFiles, 'foundation-gate-tier-');
  if (git_) {
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'fixture');
  }
  return dir;
}

const fixtureTier = (name: TierName, script: string): Tier => ({
  name,
  script: TIERS[name]!.script,
  steps: [{ script, evidence: [] }],
  stepTimeoutMs: 30_000,
  stopGraceMs: 5_000,
});

async function runFixtureTier(dir: string, tier: Tier, env: Record<string, string>): Promise<{ code: number; manifest: TierManifest }> {
  const code = await runTier({ root: dir, tier, log: () => undefined, env });
  const manifest = JSON.parse(await readFile(join(dir, bundlePath(tier.name), 'manifest.json'), 'utf8')) as TierManifest;
  return { code, manifest };
}

function nodeVersion(env: Record<string, string>): string | null {
  try {
    const result = Bun.spawnSync(['node', '-p', 'process.versions.node'], { env: stepEnvironment(env), stdout: 'pipe', stderr: 'ignore' });
    const text = result.stdout.toString().trim();
    return result.exitCode === 0 && text !== '' ? text : null;
  } catch {
    return null;
  }
}

test('GATE-006 a tier manifest records the commit, a clean tree, the source tree, the CI identity, the platform, and the checksums', async () => {
  // covers: AC-7 (identitas kandidat, versi, checksum input dan output; Value sourcing Commit, Bersih, Pohon sumber, Identitas run CI)
  const dir = await tierRepository();
  const commit = git(dir, 'rev-parse', 'HEAD');
  // Build outputs are ignored by git, so they never make the tree unclean.
  const outputs = { 'apps/frontend/dist/frontend/main.js': 'console.log(1);\n', 'apps/frontend/dist/frontend/assets/a.css': 'a{}\n', 'dist/backend/index.js': 'export {};\n' };
  for (const [path, content] of Object.entries(outputs)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  const env: Record<string, string> = { ...reportEnv(), GITHUB_RUN_ID: '77', GITHUB_REF: 'refs/heads/main' };
  const { code, manifest } = await runFixtureTier(dir, fixtureTier('fast', 'ok'), env);
  expect(code).toBe(0);
  const tree = manualTree(tierFiles);
  expect(manifest.candidate).toEqual({
    commit,
    clean: true,
    sourceTree: tree,
    sourceTreeAfter: tree,
    ci: { runId: '77', runAttempt: null, job: null, sha: null, ref: 'refs/heads/main', event: null },
  });
  expect(manifest.environment).toEqual({ os: process.platform, arch: process.arch, bun: Bun.version, node: nodeVersion(env) });
  expect(Object.keys(manifest.inputs)).toEqual([...INPUT_FILES, ...INPUT_TREES]);
  expect(manifest.inputs['package.json']).toBe(sha256(tierFiles['package.json']!));
  for (const path of INPUT_FILES.filter((item) => item !== 'package.json')) expect(manifest.inputs[path], path).toBe('absent');
  expect(manifest.inputs['tests/scenarios/']).toBe(manualTree(tierFiles, 'tests/scenarios/'));
  expect(manifest.inputs['apps/frontend/sdk/']).toBe(manualTree(tierFiles, 'apps/frontend/sdk/'));
  expect(Object.keys(manifest.outputs)).toEqual([...OUTPUT_TREES, ...OUTPUT_FILES]);
  expect(manifest.outputs).toEqual({
    'apps/frontend/dist/frontend/': manualTree(outputs, 'apps/frontend/dist/frontend/'),
    'dist/backend/index.js': sha256(outputs['dist/backend/index.js']),
  });
  // Only the named fields are written: no environment value reaches the manifest.
  const text = await readFile(join(dir, bundlePath('fast'), 'manifest.json'), 'utf8');
  for (const value of [env['PATH']!, env['HOME']!]) expect(text).not.toContain(value);
}, 60_000);

test('GATE-006 a step that changes a tracked file makes the tier unclean and changes sourceTreeAfter; without git there is no candidate', async () => {
  // covers: AC-7 (clean benar hanya bila git status kosong di awal dan di akhir; tanpa .git commit null)
  const dir = await tierRepository();
  const { manifest } = await runFixtureTier(dir, fixtureTier('real', 'touch'), reportEnv());
  expect(manifest.status).toBe('passed');
  expect(manifest.candidate.clean).toBe(false);
  expect(manifest.candidate.sourceTree).toBe(manualTree(tierFiles));
  expect(manifest.candidate.sourceTreeAfter).toBe(manualTree({ ...tierFiles, 'tracked.txt': 'satu\ndua\n' }));
  expect(manifest.candidate.ci).toBeNull();

  const plain = await tierRepository(false);
  const local = await runFixtureTier(plain, fixtureTier('security', 'ok'), { ...reportEnv(), GITHUB_REF: 'refs/heads/main' });
  expect(local.manifest.candidate).toEqual({ commit: null, clean: false, sourceTree: null, sourceTreeAfter: null, ci: null });
  expect(local.manifest.inputs['tests/scenarios/']).toBeNull();
  expect(local.manifest.inputs['apps/frontend/sdk/']).toBeNull();
  expect(local.manifest.inputs['package.json']).toBe(sha256(tierFiles['package.json']!));
}, 60_000);

test('GATE-006 the node version is null when the gate process has no node on its PATH', async () => {
  // covers: AC-7 (Versi dan platform: node null bila perintah node tidak ada)
  const dir = await tierRepository();
  // A PATH that only holds git, sh, and ps (the process group check), so neither the gate process nor its children
  // can find node.
  const bin = join(dir, '.local/bin');
  await mkdir(bin, { recursive: true });
  for (const name of ['git', 'sh', 'ps']) await symlink(Bun.which(name)!, join(bin, name));
  const gate = join(import.meta.dir, '../../../scripts/lib/gate.ts');
  await writeFile(
    join(dir, '.local/run.ts'),
    [
      `import { runTier } from ${JSON.stringify(gate)};`,
      "const tier = { name: 'fast' as const, script: 'test:ci', steps: [{ script: 'ok', evidence: [] }], stepTimeoutMs: 30_000, stopGraceMs: 5_000 };",
      'process.exitCode = await runTier({ root: process.cwd(), tier, log: () => undefined });',
    ].join('\n'),
  );
  const child = Bun.spawn([process.execPath, '--no-env-file', '.local/run.ts'], {
    cwd: dir,
    env: { PATH: bin, HOME: process.env['HOME'] ?? tmpdir(), TMPDIR: tmpdir() },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  expect(await child.exited).toBe(0);
  const manifest = JSON.parse(await readFile(join(dir, bundlePath('fast'), 'manifest.json'), 'utf8')) as TierManifest;
  expect(manifest.environment.node).toBeNull();
  expect(manifest.environment.bun).toBe(Bun.version);
  // git still ran, so the candidate is complete.
  expect(manifest.candidate.commit).toBe(git(dir, 'rev-parse', 'HEAD'));
  expect(manifest.candidate.clean).toBe(true);
}, 60_000);

test('GATE-006 manifests the tier runner writes bind in the report, and a tracked file changed afterwards breaks the binding', async () => {
  // covers: AC-7 (pengikatan sah hanya bila ketiga manifest dan checkout laporan mempunyai commit serta pohon sumber yang sama)
  const dir = await tierRepository();
  for (const name of TIER_NAMES) expect((await runFixtureTier(dir, fixtureTier(name, 'ok'), reportEnv())).code).toBe(0);
  const bound = await buildReport(dir, reportEnv());
  expect(bound.candidate).toEqual({ commit: git(dir, 'rev-parse', 'HEAD'), sourceTree: manualTree(tierFiles), ci: null });
  expect(bound.binding).toEqual({ valid: true, problems: [] });

  await writeFile(join(dir, 'tracked.txt'), 'diubah\n');
  const changed = await buildReport(dir, reportEnv());
  expect(problems(changed)).toEqual(['source_tree_differs fast', 'source_tree_differs real', 'source_tree_differs security']);
  expect(changed.gate).toBe('incomplete');
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------
// Added by the review fixes (spec 0010): an erroring testcase, the shape of a manifest, an identity field that is empty,
// and text from a bundle that reaches report.md, the job summary, or the console.

test('GATE-005 a matching testcase that errors fails its check like a failure, for bun:test, Vitest, and Playwright', async () => {
  // covers: AC-6 (failed: ada testcase cocok yang gagal atau error)
  const { report: found } = await report({
    cases: {
      'test:gate': { 'tests/integration/gate/a.test.ts': [{ name: 'FIX-001 error', outcome: 'error' }, { name: 'FIX-008 lulus' }, { name: 'FIX-009 lulus' }] },
      'test:frontend': { 'apps/frontend/src/app/a.spec.ts': [{ name: 'FIX-002 error', outcome: 'error' }] },
      'test:e2e': { 'tests/e2e/a.e2e.spec.ts': [{ name: 'FIX-003 error', outcome: 'error' }] },
    },
  });
  for (const id of ['FIX-001', 'FIX-002', 'FIX-003']) {
    expect(scenario(found, id).checks[0], id).toMatchObject({ status: 'failed', counts: { passed: 0, failed: 1, skipped: 0 } });
    expect(scenario(found, id).status, id).toBe('failed');
  }
  expect(found.critical).toContainEqual({ id: 'FIX-003', status: 'failed' });
  expect(found.gate).toBe('failed');
  expect(renderMarkdown(found)).toContain('0 lulus, 1 gagal, 0 dilewati, failed');
});

test('GATE-006 a manifest without inputs, with outputs that are not text, or with an incomplete environment is manifest_invalid, and the report is still written', async () => {
  // covers: AC-7 (manifest tier mencatat environment serta checksum input dan output; manifest_invalid)
  const fixture = await repository();
  await bundles(fixture, {
    change: (manifests) => {
      delete (manifests.fast as Partial<TierManifest>).inputs;
      (manifests.real as { outputs: unknown }).outputs = { 'dist/backend/index.js': 1 };
      (manifests.security as { environment: unknown }).environment = {};
    },
  });
  const output = lines();
  expect(await runReport(fixture.dir, output.log, reportEnv())).toBe(1);
  const written = JSON.parse(await readFile(join(fixture.dir, REPORT_JSON), 'utf8')) as GateReport;
  expect(problems(written)).toEqual(['manifest_invalid fast', 'manifest_invalid real', 'manifest_invalid security']);
  expect(written.gate).toBe('incomplete');
  const markdown = await readFile(join(fixture.dir, REPORT_MD), 'utf8');
  expect(markdown).not.toContain('undefined');

  // Each rule alone: a node version that is not text or null, and an input checksum that is not text or null.
  for (const [label, change] of [
    ['node angka', (m: Record<TierName, TierManifest>) => void ((m.fast.environment as { node: unknown }).node = 24)],
    ['input angka', (m: Record<TierName, TierManifest>) => void ((m.fast.inputs as Record<string, unknown>)['bun.lock'] = 1)],
    ['bun hilang', (m: Record<TierName, TierManifest>) => void delete (m.fast.environment as Partial<TierManifest['environment']>).bun],
  ] as const) {
    const { report: found } = await report({ change });
    expect(problems(found), label).toEqual(['manifest_invalid fast']);
  }
  // An input tree without git is null, and that is still a valid manifest.
  const { report: nullable } = await report({ change: (m) => void (m.fast.inputs['apps/frontend/sdk/'] = null) });
  expect(nullable.binding.valid).toBe(true);
}, 90_000);

test('GATE-006 postgres is null when one identity field of image.json is an empty string', async () => {
  // covers: AC-7 (Identitas PostgreSQL: kedelapan field berupa string tidak kosong, selain itu null seluruhnya)
  for (const field of POSTGRES_FIELDS) {
    const { report: found } = await report({ image: { ...IMAGE, [field]: '' } });
    expect(found.postgres, field).toBeNull();
  }
}, 120_000);

test('GATE-005 a scannedAt that is not a UTC time makes the scanner summary unusable, and bundle text never starts a console line', async () => {
  // covers: AC-8 (laporan dan ringkasan job hanya memuat field terstruktur; teks di-escape)
  for (const scannedAt of ['2026-10-04 [palsu](https://example.test)', '2026-10-04T00:00:00.000Z\n**Status passed**', '2026-10-04']) {
    const { report: found } = await report({ security: { ...security(), scannedAt } });
    expect(found.scanners, scannedAt).toBeNull();
    expect(found.gate, scannedAt).toBe('incomplete');
    expect(renderMarkdown(found), scannedAt).not.toContain('example.test');
    expect(renderMarkdown(found), scannedAt).not.toContain('**Status passed**');
  }
  const { report: plain } = await report({ security: { ...security(), scannedAt: '2026-10-04T08:00:00Z' } });
  expect(plain.scanners?.scannedAt).toBe('2026-10-04T08:00:00Z');

  expect(consoleLine('a\nb\r::error::c\u0007d\u0085e')).toBe('a b ::error::c d e');
  // A file path in a JUnit that carries a line break and a workflow command stays inside one console line.
  const foreign = 'tests/integration/gate/x\n::error title=palsu::gate passed.test.ts';
  const fixture = await repository();
  await bundles(fixture, { cases: { 'test:gate': { [foreign]: [{ name: 'x' }] } } });
  const output = lines();
  expect(await runReport(fixture.dir, output.log, reportEnv())).toBe(1);
  expect(output.out.some((line) => line.includes('\n') || line.trimStart().startsWith('::'))).toBe(false);
  expect(output.out).toContain(`    junit_foreign_file test:gate ${foreign.replace('\n', ' ')}`);
  const markdown = await readFile(join(fixture.dir, REPORT_MD), 'utf8');
  expect(markdown.split('\n').some((line) => line.startsWith('::'))).toBe(false);
}, 120_000);

test('GATE-006 a tier that starts on an unclean tree is unclean even when a step restores every file before the end', async () => {
  // covers: AC-7 (clean benar hanya bila git status --porcelain kosong di awal dan di akhir tier)
  const dir = await tierRepository();
  await writeFile(join(dir, 'tracked.txt'), 'diubah\n');
  const { manifest } = await runFixtureTier(dir, fixtureTier('real', 'restore'), reportEnv());
  expect(manifest.status).toBe('passed');
  // The step left nothing to commit, so only the start of the tier was unclean.
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(manifest.candidate.clean).toBe(false);
  expect(manifest.candidate.sourceTree).toBe(manualTree({ ...tierFiles, 'tracked.txt': 'diubah\n' }));
  expect(manifest.candidate.sourceTreeAfter).toBe(manualTree(tierFiles));
}, 60_000);
