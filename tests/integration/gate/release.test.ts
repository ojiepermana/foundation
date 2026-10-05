import { afterEach, expect, test } from 'bun:test';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundlePath,
  CAPACITY_TIER,
  DEPLOYMENT_CHECKS,
  deploymentEvidenceValid,
  deploymentResult,
  performanceProfile,
  REASON_CODES,
  runTier,
  sha256,
  sourceTree,
  TIER_NAMES,
  TIERS,
  type CiIdentity,
  type EvidenceRecord,
  type StepRecord,
  type Tier,
  type TierManifest,
} from '../../../scripts/lib/gate.ts';
import {
  buildCapacityReport,
  buildReleaseReport,
  buildReport,
  bundleCi,
  DEPLOYMENT_IMAGE_NAMES,
  DEPLOYMENT_LOCAL_ONLY,
  OUT_OF_SCOPE,
  RELEASE_BLOCKED_CODES,
  RELEASE_IDENTITY_UNVERIFIED,
  RELEASE_JSON,
  RELEASE_MD,
  RELEASE_NOT_PERMISSION,
  RELEASE_READINESS_DIR,
  releaseReadiness,
  renderMarkdown,
  renderReleaseMarkdown,
  runReleaseReport,
  runReport,
  type DeploymentReport,
  type GateReport,
  type ReleaseReport,
} from '../../../scripts/lib/gate-report.ts';
import { lines, removeWorkspaces, workspace, writeFiles } from './workspace.ts';

// DEP-004 (spec 0012, AC-11 and AC-12). Build plan step 4: the evidence kind `deployment` with
// `deploymentEvidenceValid` (checks missing, extra, out of order, or with another status, and exit 0 with a failed
// result), the deployment step of the real tier on a fixture workspace, the field `deployment` of the per push report
// with its `null` cases, the new `outOfScope`, and the *Deployment* section of report.md with the criteria column.
// Build plan step 5: the release status of `test:report:release` on fixture repositories whose HEAD is the `sha` of
// the bundles, with per push bundles of one `push` run and a capacity bundle of another `workflow_dispatch` run, every
// reason code and its order, `grantsDeployment`, the two fixed sentences of release.md, the exit codes, and the
// unchanged `test:report` and `test:report:capacity`. Every fixture is written at runtime in a `mkdtemp` folder.

afterEach(removeWorkspaces);

const RESULT = '.local/feature-13/result.json';
const IMAGES = '.local/feature-13/images.json';
const JUNIT = '.local/feature-13/playwright-deployment.xml';
const SCAN = '.local/feature-13/artifact-scan.json';
const BOUNDARY = 'Topologi rujukan fixture; bukan bukti platform deployment.';
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(64);

type CheckStatus = 'passed' | 'failed' | 'not_run';

/** A `result.json` of *Isi result.json*: every check of DEPLOYMENT_CHECKS in order, with `change` applied last. */
function deploymentFile(statuses: Partial<Record<string, CheckStatus>> = {}, change: (result: Record<string, any>) => void = () => undefined): Record<string, any> {
  const checks = DEPLOYMENT_CHECKS.map(({ name }) => ({ name, status: statuses[name] ?? 'passed', detail: `${name} fixture` }));
  const result: Record<string, any> = {
    schema: 1,
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    startedAt: '2026-10-05T00:00:00.000Z',
    finishedAt: '2026-10-05T00:01:30.000Z',
    candidate: { commit: COMMIT, sourceTree: TREE },
    checks,
    reasons: [],
    boundary: BOUNDARY,
  };
  change(result);
  return result;
}

function imagesFile(change: (images: Record<string, any>) => void = () => undefined): Record<string, any> {
  const images: Record<string, any> = {
    schema: 1,
    images: DEPLOYMENT_IMAGE_NAMES.map((name, index) => ({
      name,
      dockerfile: name === 'migrate' ? 'database/Dockerfile' : `apps/${name}/Dockerfile`,
      tag: `foundation-${name}:deploy-0123456789ab`,
      imageId: `sha256:${String(index + 1).repeat(64)}`,
      sizeBytes: 1_000 * (index + 1),
      user: name === 'frontend' ? '101:101' : '1000:1000',
      exposedPorts: [],
      stopSignal: name === 'frontend' ? 'SIGQUIT' : 'SIGTERM',
      healthcheck: name === 'backend',
      bases: [`oven/bun:1.4.2-slim@sha256:${'c'.repeat(64)}`],
      labels: { revision: COMMIT, sourceTree: TREE },
      files: { count: 10, sha256: 'd'.repeat(64) },
    })),
    postgres: { image: 'foundation-postgres:18-pinned', imageId: `sha256:${'e'.repeat(64)}` },
  };
  change(images);
  return images;
}

// ---------------------------------------------------------------------------------------------------------------
// The evidence kind `deployment`.

test('DEP-004 deploymentEvidenceValid needs schema 1, every DEPLOYMENT_CHECKS name in order with a known status, and passed after exit 0', () => {
  const valid = deploymentFile();
  expect(deploymentEvidenceValid(valid, 0)).toBe(true);
  expect(deploymentResult(valid)?.checks.map((check) => check.name)).toEqual(DEPLOYMENT_CHECKS.map((check) => check.name));
  const failedRun = deploymentFile({ tls_versions: 'failed', browser_flow: 'not_run' });
  expect(deploymentEvidenceValid(failedRun, 1)).toBe(true);
  expect(deploymentEvidenceValid(failedRun, null)).toBe(true);
  // A step that exited 0 with a failed result is invalid evidence.
  expect(deploymentEvidenceValid(failedRun, 0)).toBe(false);

  const checks = () => valid['checks'].map((check: object) => ({ ...check }));
  const invalid: [string, Record<string, unknown>][] = [
    ['a missing check', { ...valid, checks: checks().filter((check: { name: string }) => check.name !== 'cors_absent') }],
    ['an extra check', { ...valid, checks: [...checks(), { name: 'extra_check', status: 'passed', detail: null }] }],
    ['a repeated check in place of another', { ...valid, checks: checks().map((check: { name: string }, index: number) => (index === 1 ? { ...check, name: 'image_pins' } : check)) }],
    ['two checks swapped', { ...valid, checks: (() => { const list = checks(); [list[0], list[1]] = [list[1], list[0]]; return list; })() }],
    ['a check status outside the list', { ...valid, checks: checks().map((check: object, index: number) => (index === 3 ? { ...check, status: 'skipped' } : check)) }],
    ['a check without a name', { ...valid, checks: checks().map((check: object, index: number) => (index === 0 ? { status: 'passed' } : check)) }],
    ['a check that is not an object', { ...valid, checks: checks().map((check: object, index: number) => (index === 0 ? 'image_pins' : check)) }],
    ['passed with a check not_run', deploymentFile({ cleanup: 'not_run' }, (result) => void (result['status'] = 'passed'))],
    ['schema 2', { ...valid, schema: 2 }],
    ['schema as text', { ...valid, schema: '1' }],
    ['a status outside passed and failed', { ...valid, status: 'not_run' }],
    ['checks as an object', { ...valid, checks: {} }],
    ['no checks', { schema: 1, status: 'passed' }],
  ];
  for (const [label, object] of invalid) {
    expect(deploymentResult(object), label).toBeNull();
    expect(deploymentEvidenceValid(object, 0), label).toBe(false);
    expect(deploymentEvidenceValid(object, 1), label).toBe(false);
  }
});

test('DEP-004 the real tier runs test:deployment:real after test:readiness:real and before the smoke, with the evidence of Bukti langkah deployment', () => {
  const scripts = TIERS.real!.steps.map((step) => step.script);
  expect(scripts.indexOf('test:deployment:real')).toBe(scripts.indexOf('test:readiness:real') + 1);
  expect(scripts.at(-1)).toBe('test:performance:smoke');
  const step = TIERS.real!.steps.find((item) => item.script === 'test:deployment:real')!;
  expect(step.evidence).toEqual([
    { path: RESULT, kind: 'deployment', runner: null, required: true },
    { path: IMAGES, kind: 'data', runner: null, required: true },
    { path: JUNIT, kind: 'junit', runner: 'playwright', required: true },
    { path: SCAN, kind: 'scan', runner: null, required: true },
    { path: '.local/feature-13/test-results/', kind: 'screenshots', runner: null, required: false },
  ]);
  const fast = TIERS.fast!.steps.map((item) => item.script);
  expect(fast.indexOf('test:deployment:plan')).toBe(fast.indexOf('test:performance:plan') + 1);
  expect(TIERS.fast!.steps.find((item) => item.script === 'test:deployment:plan')!.evidence).toEqual([
    { path: '.local/feature-13/plan.xml', kind: 'junit', runner: 'bun:test', required: true },
  ]);
  // The limit and the grace of both tiers stay as they were.
  expect([TIERS.real!.stepTimeoutMs, TIERS.real!.stopGraceMs, TIERS.fast!.stepTimeoutMs, TIERS.fast!.stopGraceMs]).toEqual([1_500_000, 180_000, 600_000, 10_000]);
});

/** A workspace whose `package.json` runs `sh ./steps/<name>.sh` for every entry of `steps`. */
async function tierWorkspace(steps: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
  const scripts = Object.fromEntries(Object.keys(steps).map((name) => [name, `sh ./steps/${name}.sh`]));
  const stepFiles = Object.fromEntries(Object.entries(steps).map(([name, body]) => [`steps/${name}.sh`, `${body}\n`]));
  return workspace({ 'package.json': JSON.stringify({ name: 'fixture', private: true, scripts }), ...stepFiles, ...files });
}

const gateEnv = () => {
  const values: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
  for (const name of ['HOME', 'TMPDIR']) if (process.env[name] !== undefined) values[name] = process.env[name]!;
  return values;
};

test('DEP-004 a deployment step that exits 0 with a failed or invalid result.json fails with evidence_invalid, and exit 1 keeps only exit_code', async () => {
  const deployment = TIERS.real!.steps.find((step) => step.script === 'test:deployment:real')!;
  const fixture: Tier = { name: 'real', script: 'test:ci:real', steps: [{ script: 'test:deployment:real', evidence: deployment.evidence.filter((item) => item.path === RESULT) }], stepTimeoutMs: 30_000, stopGraceMs: 5_000 };
  const cases: [string, Record<string, unknown> | string, number, string[]][] = [
    ['passed after exit 0', deploymentFile(), 0, []],
    ['failed after exit 0', deploymentFile({ edge_errors: 'failed' }), 0, [`evidence_invalid ${RESULT}`]],
    ['failed after exit 1', deploymentFile({ edge_errors: 'failed' }), 1, ['exit_code']],
    ['a check missing after exit 0', deploymentFile({}, (result) => void result['checks'].pop()), 0, [`evidence_invalid ${RESULT}`]],
    ['a check missing after exit 1', deploymentFile({}, (result) => void result['checks'].pop()), 1, ['exit_code', `evidence_invalid ${RESULT}`]],
    ['not JSON', '{', 0, [`evidence_invalid ${RESULT}`]],
  ];
  for (const [label, content, exitCode, reasons] of cases) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const dir = await tierWorkspace({ 'test:deployment:real': `mkdir -p .local/feature-13 && cp result.fixture .local/feature-13/result.json\nexit ${exitCode}` }, { 'result.fixture': text });
    const output = lines();
    const code = await runTier({ root: dir, tier: fixture, log: output.log, env: gateEnv() });
    const manifest = JSON.parse(await readFile(join(dir, bundlePath('real'), 'manifest.json'), 'utf8')) as TierManifest;
    const step = manifest.steps[0]!;
    expect(step.reasons.map((reason) => `${reason.code}${reason.path === null ? '' : ` ${reason.path}`}`), label).toEqual(reasons);
    expect([code, step.status], label).toEqual(reasons.length === 0 ? [0, 'passed'] : [1, 'failed']);
    // The file is still bound to the manifest, so the report can show what the run wrote.
    expect(step.evidence[0], label).toMatchObject({ path: RESULT, kind: 'deployment', present: true, sha256: sha256(text) });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The field `deployment` of the per push report and the *Deployment* section.

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

const reportEnv = () => ({ PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? tmpdir() });

type Fixture = { dir: string; commit: string; tree: string };

/** A git repository with an empty registry, so only the bundles decide what the report reads. */
async function repository(): Promise<Fixture> {
  const dir = await workspace(
    {
      '.gitignore': '.local/\n',
      'package.json': JSON.stringify({ name: 'fixture', private: true }),
      'docs/specs/0012-fixture/index.md': '# Fixture\n\n- **AC-11**: sebelas.\n',
      'tests/scenarios/fixture.json': `${JSON.stringify({ source: 'docs/specs/0012-fixture/index.md', scenarios: [] }, null, 2)}\n`,
    },
    'foundation-deploy-report-',
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD'), tree: (await sourceTree(dir))! };
}

/** Writes the real bundle with the deployment step only: `files` are the evidence texts; `change` edits the manifest last. */
async function realBundle(fixture: Fixture, files: Record<string, string>, change: (manifest: TierManifest) => void = () => undefined): Promise<void> {
  const step = TIERS.real!.steps.find((item) => item.script === 'test:deployment:real')!;
  const evidence: EvidenceRecord[] = step.evidence.map((item) => {
    if (item.kind === 'screenshots') return { path: item.path, kind: item.kind, required: item.required, present: false, files: [] };
    const text = files[item.path];
    return { path: item.path, kind: item.kind, required: item.required, present: text !== undefined, sha256: text === undefined ? null : sha256(text) };
  });
  const manifest: TierManifest = {
    schema: 1,
    tier: 'real',
    candidate: { commit: fixture.commit, clean: true, sourceTree: fixture.tree, sourceTreeAfter: fixture.tree, ci: null },
    environment: { os: 'linux', arch: 'x64', bun: '1.4.2', node: '24.21.0' },
    inputs: {},
    outputs: {},
    steps: [{ script: 'test:deployment:real', status: 'passed', reasons: [], exitCode: 0, durationMs: 90_000, timedOut: false, signal: null, leftoverPorts: [], evidence }],
    status: 'passed',
    startedAt: '2026-10-05T00:00:00.000Z',
    finishedAt: '2026-10-05T00:01:30.000Z',
  };
  change(manifest);
  const bundle = join(fixture.dir, bundlePath('real'));
  await writeFiles(bundle, files);
  await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const deploymentFiles = (result: Record<string, unknown> | string = deploymentFile(), images: Record<string, unknown> | string = imagesFile()): Record<string, string> => ({
  [RESULT]: typeof result === 'string' ? result : JSON.stringify(result),
  [IMAGES]: typeof images === 'string' ? images : JSON.stringify(images),
  // No file level testsuite: the fixture repository owns no Playwright deployment file, so discovery stays clean.
  [JUNIT]: '<testsuites name="fixture"></testsuites>',
  [SCAN]: '{ "findings": [] }',
});

test('DEP-004 report.json holds deployment after performance with the images and checks of a bound result.json and images.json, and outOfScope keeps only the capacity profiles', async () => {
  const fixture = await repository();
  await realBundle(fixture, deploymentFiles(deploymentFile({ egress_blocked: 'not_run', browser_flow: 'failed' })));
  const output = lines();
  // Without the fast and security bundles the gate is incomplete; the report is still written.
  expect(await runReport(fixture.dir, output.log, reportEnv())).toBe(1);
  const found = JSON.parse(await readFile(join(fixture.dir, '.local/feature-11/report.json'), 'utf8')) as GateReport;
  expect(Object.keys(found).slice(-3)).toEqual(['outOfScope', 'performance', 'deployment']);
  expect(found.outOfScope).toEqual([{ area: 'capacity_profiles', feature: 12 }]);
  expect(OUT_OF_SCOPE).toEqual(found.outOfScope);
  expect(found.binding.problems.filter((problem) => problem.tier === 'real')).toEqual([]);
  const images = imagesFile()['images'] as Record<string, any>[];
  expect(found.deployment).toEqual({
    status: 'failed',
    evidence: `${bundlePath('real')}/${RESULT}`,
    images: images.map((image) => ({
      name: image['name'], tag: image['tag'], imageId: image['imageId'], sizeBytes: image['sizeBytes'], user: image['user'], bases: image['bases'],
      revision: COMMIT, sourceTree: TREE,
    })),
    checks: DEPLOYMENT_CHECKS.map(({ name }) => ({ name, status: name === 'egress_blocked' ? 'not_run' : name === 'browser_flow' ? 'failed' : 'passed' })),
    boundary: BOUNDARY,
  });
  // The detail texts of result.json stay in the bundle only.
  expect(JSON.stringify(found.deployment)).not.toContain('fixture"');
  expect(output.out).toContain(`  deployment: failed (${DEPLOYMENT_CHECKS.length - 2} dari ${DEPLOYMENT_CHECKS.length} check passed)`);
  // The deployment field does not decide the gate: the incomplete gate comes from the missing bundles.
  expect(found.gate).toBe('incomplete');
});

test('DEP-004 deployment is null when a file is missing, changed after the run, or not of its shape, and the step status does not matter', async () => {
  const cases: [string, Record<string, string>, (manifest: TierManifest) => void][] = [
    ['no result.json', (() => { const files = deploymentFiles(); delete files[RESULT]; return files; })(), () => undefined],
    ['no images.json', (() => { const files = deploymentFiles(); delete files[IMAGES]; return files; })(), () => undefined],
    ['result.json that is not JSON', deploymentFiles('{'), () => undefined],
    ['result.json without a check', deploymentFiles(deploymentFile({}, (result) => void result['checks'].pop())), () => undefined],
    ['images.json of schema 2', deploymentFiles(undefined, imagesFile((images) => void (images['schema'] = 2))), () => undefined],
    ['images.json with two images', deploymentFiles(undefined, imagesFile((images) => void images['images'].pop())), () => undefined],
    ['images.json in another order', deploymentFiles(undefined, imagesFile((images) => void images['images'].reverse())), () => undefined],
    ['an image without labels', deploymentFiles(undefined, imagesFile((images) => void delete images['images'][1].labels)), () => undefined],
    ['an image with a size as text', deploymentFiles(undefined, imagesFile((images) => void (images['images'][0].sizeBytes = '1000'))), () => undefined],
    ['a base that is not text', deploymentFiles(undefined, imagesFile((images) => void (images['images'][2].bases = [1]))), () => undefined],
    ['result.json not recorded by the step', deploymentFiles(), (manifest) => void (manifest.steps[0]!.evidence[0]!.sha256 = null)],
  ];
  for (const [label, files, change] of cases) {
    const fixture = await repository();
    await realBundle(fixture, files, change);
    const found = await buildReport(fixture.dir, reportEnv());
    expect(found.deployment, label).toBeNull();
  }

  // A bundle copy changed after the run breaks the binding and leaves deployment null.
  const changed = await repository();
  await realBundle(changed, deploymentFiles());
  await writeFile(join(changed.dir, bundlePath('real'), RESULT), JSON.stringify(deploymentFile({ cleanup: 'failed' })));
  const differs = await buildReport(changed.dir, reportEnv());
  expect(differs.deployment).toBeNull();
  expect(differs.binding.problems).toContainEqual({ code: 'evidence_hash_differs', tier: 'real', path: RESULT });

  // A failed step with valid files still fills the field; null revision labels stay null.
  const failedStep = await repository();
  const nullLabels = imagesFile((images) => void (images['images'][0].labels = { revision: null, sourceTree: null }));
  await realBundle(failedStep, deploymentFiles(undefined, nullLabels), (manifest) => {
    Object.assign(manifest.steps[0]!, { status: 'failed', exitCode: 1, reasons: [{ code: 'exit_code', path: null }] });
    manifest.status = 'failed';
  });
  const found = await buildReport(failedStep.dir, reportEnv());
  expect(found.deployment?.status).toBe('passed');
  expect(found.deployment?.images[0]).toMatchObject({ name: 'frontend', revision: null, sourceTree: null });
  expect(found.gate).toBe('failed');
});

test('DEP-004 report.md renders the Deployment section with the image table, the check table with its criteria, the boundary text, and the local only sentence', async () => {
  const fixture = await repository();
  await realBundle(fixture, deploymentFiles(deploymentFile({ api_headers: 'failed' }, (result) => void (result['boundary'] = 'Batas | pipa\nbaris'))));
  const report = await buildReport(fixture.dir, reportEnv());
  const markdown = renderMarkdown(report);
  const all = markdown.split('\n');
  const start = all.indexOf('## Deployment');
  const end = all.findIndex((line, index) => index > start && line.startsWith('## '));
  expect(start).toBeGreaterThan(all.indexOf('## Performance k6'));
  expect(all[end]).toBe('## Kandidat release');
  const section = all.slice(start, end);
  expect(section).toContain('| Status | failed |');
  expect(section).toContain(`| Check passed | ${DEPLOYMENT_CHECKS.length - 1} dari ${DEPLOYMENT_CHECKS.length} |`);
  expect(section).toContain(DEPLOYMENT_LOCAL_ONLY);
  expect(DEPLOYMENT_LOCAL_ONLY).toContain('tidak didorong ke registry');
  expect(DEPLOYMENT_LOCAL_ONLY).toContain('bukan izin deploy');
  expect(section).toContain('| Image | Tag | Image ID | Ukuran (byte) | User | Image dasar | Revision | Pohon sumber |');
  expect(section.find((line) => line.startsWith('| frontend |'))).toBe(
    `| frontend | foundation-frontend:deploy-0123456789ab | sha256:${'1'.repeat(64)} | 1000 | 101:101 | oven/bun:1.4.2-slim@sha256:${'c'.repeat(64)} | ${COMMIT} | ${TREE} |`,
  );
  expect(section).toContain('| Check | Kriteria | Status |');
  // The criteria column comes from DEPLOYMENT_CHECKS, so a reader sees which check proves which criterion.
  // Table cells escape `_`, so the check names read image\_pins and so on.
  expect(section).toContain('| image\\_context\\_sentinels | AC-1, AC-2 | passed |');
  expect(section).toContain('| api\\_headers | AC-7 | failed |');
  expect(section).toContain('| artifact\\_scan | AC-2, AC-11 | passed |');
  const checkRows = section.filter((line) => /^\| [a-z\\_]+ \| AC-/.test(line));
  expect(checkRows.map((line) => line.split(' | ')[0]!.slice(2).replaceAll('\\_', '_'))).toEqual(DEPLOYMENT_CHECKS.map((check) => check.name));
  // The boundary text is printed as is without its control characters, on one line.
  expect(section).toContain('Batas | pipabaris');
  expect(all.slice(all.indexOf('## Di luar cakupan'))).toEqual([
    '## Di luar cakupan',
    '',
    '- Profil kapasitas load, stress, spike, outage, dan soak, dibuktikan `test:report:capacity` dari tier kapasitas (fitur 12).',
    '',
  ]);

  const empty = await repository();
  const missing = renderMarkdown(await buildReport(empty.dir, reportEnv())).split('\n');
  const emptySection = missing.slice(missing.indexOf('## Deployment'), missing.indexOf('## Kandidat release'));
  expect(emptySection).toEqual([
    '## Deployment',
    '',
    'Bukti deployment tidak tersedia karena `result.json` atau `images.json` tidak ada di bundle tier nyata, tidak cocok dengan manifest, atau bentuknya tidak sah. Penyebabnya terlihat pada alasan langkah dan pengikatan.',
    '',
    DEPLOYMENT_LOCAL_ONLY,
    '',
  ]);
});

// ---------------------------------------------------------------------------------------------------------------
// The release status of `test:report:release` (build plan step 5, AC-12).

/** The CI identity of the per push run and of the capacity run; `sha` is set to the fixture commit per test. */
const PUSH_RUN: Omit<CiIdentity, 'job'> = { runId: '1000', runAttempt: '1', sha: '', ref: 'refs/heads/main', event: 'push' };
const DISPATCH_RUN: Omit<CiIdentity, 'job'> = { runId: '2000', runAttempt: '1', sha: '', ref: 'refs/heads/main', event: 'workflow_dispatch' };
/** The job each tier runs in, as the manifests of `.github/workflows/application.yml` and `capacity.yml` record it. */
const JOBS: Record<string, string> = { fast: 'application', real: 'real', security: 'security', capacity: 'capacity' };

const scannersFile = () => ({
  schema: 1,
  scannedAt: '2026-10-05T00:00:00.000Z',
  workingTreeClean: true,
  status: 'passed',
  scanners: [
    { name: 'gitleaks', coverage: { head: 'x', commitsReachable: 1, shallow: false } },
    { name: 'bun audit', coverage: { packages: 1 } },
    { name: 'actionlint', coverage: { files: ['.github/workflows/application.yml', '.github/workflows/capacity.yml'] } },
  ].map((item) => ({ ...item, version: '1.0.0', image: null, status: 'passed', reason: null, counts: { failed: 0, excepted: 0, reported: 0 } })),
});

type BundleOptions = {
  /** The CI identity of the manifest without `job`, or `null` for a local run. */
  ci?: Omit<CiIdentity, 'job'> | null;
  /** The commit and the source tree the manifest records, by default those of the fixture checkout. */
  commit?: string;
  tree?: string;
  /** Texts that replace the default text of an evidence path. */
  files?: Record<string, string>;
  /** Edits the manifest last, before it is written. */
  change?: (manifest: TierManifest) => void;
};

/** The default text of one declared evidence file of `script`, bound to the fixture checkout. */
function bundleText(fixture: Fixture, path: string, kind: EvidenceRecord['kind'], script: string): string {
  if (kind === 'junit') return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="fixture"></testsuites>\n';
  if (kind === 'performance') return JSON.stringify({ schema: 1, profile: performanceProfile(script), status: 'passed', reasons: [], limits: ['Batas bukti fixture.'] });
  if (kind === 'scan') return '{ "findings": [] }';
  if (kind === 'scanner') return JSON.stringify(scannersFile());
  if (kind === 'deployment') return JSON.stringify(deploymentFile({}, (result) => void (result['candidate'] = { commit: fixture.commit, sourceTree: fixture.tree })));
  if (path === IMAGES) {
    return JSON.stringify(imagesFile((images) => {
      for (const image of images['images']) image.labels = { revision: fixture.commit, sourceTree: fixture.tree };
    }));
  }
  return '{ "metrics": {} }';
}

/** Writes the bundle of `tier` as the tier runner would: every step passed, every declared file present and bound. */
async function tierBundle(fixture: Fixture, tier: Tier, options: BundleOptions = {}): Promise<void> {
  const contents: Record<string, string> = {};
  const steps: StepRecord[] = tier.steps.map((step) => {
    const evidence: EvidenceRecord[] = step.evidence.map((item) => {
      if (item.kind === 'screenshots') return { path: item.path, kind: item.kind, required: item.required, present: false, files: [] };
      const text = options.files?.[item.path] ?? bundleText(fixture, item.path, item.kind, step.script);
      contents[item.path] = text;
      const record: EvidenceRecord = { path: item.path, kind: item.kind, required: item.required, present: true, sha256: sha256(text) };
      if (item.runner !== null) Object.assign(record, { runner: item.runner, tests: 0, failures: 0, errors: 0, skipped: 0 });
      return record;
    });
    return { script: step.script, status: 'passed', reasons: [], exitCode: 0, durationMs: 1_000, timedOut: false, signal: null, leftoverPorts: [], evidence };
  });
  const ci = options.ci === undefined || options.ci === null ? null : { ...options.ci, job: JOBS[tier.name] ?? null };
  const tree = options.tree ?? fixture.tree;
  const manifest: TierManifest = {
    schema: 1,
    tier: tier.name,
    candidate: { commit: options.commit ?? fixture.commit, clean: true, sourceTree: tree, sourceTreeAfter: tree, ci },
    environment: { os: 'linux', arch: 'x64', bun: '1.4.2', node: '24.21.0' },
    inputs: { 'bun.lock': sha256('lock') },
    outputs: { 'dist/backend/index.js': 'absent' },
    steps,
    status: 'passed',
    startedAt: '2026-10-05T00:00:00.000Z',
    finishedAt: '2026-10-05T00:10:00.000Z',
  };
  options.change?.(manifest);
  const bundle = join(fixture.dir, bundlePath(tier.name));
  await writeFiles(bundle, contents);
  await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

type ReleaseOptions = { perPush?: BundleOptions; capacity?: BundleOptions; tiers?: Partial<Record<'fast' | 'real' | 'security', BundleOptions>> };

/**
 * The four bundles a release owner downloads for one commit: `fast`, `real`, and `security` from one `push` run on
 * `refs/heads/main`, and `capacity` from another `workflow_dispatch` run on `refs/heads/main`, all for HEAD.
 */
async function releaseBundles(fixture: Fixture, options: ReleaseOptions = {}): Promise<void> {
  for (const name of TIER_NAMES) {
    await tierBundle(fixture, TIERS[name]!, { ci: { ...PUSH_RUN, sha: fixture.commit }, ...options.perPush, ...options.tiers?.[name] });
  }
  await tierBundle(fixture, CAPACITY_TIER, { ci: { ...DISPATCH_RUN, sha: fixture.commit }, ...options.capacity });
}

/** Every file below `dir`, as paths relative to it, sorted. */
async function filesOf(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1)).sort();
}

const codes = (report: Pick<ReleaseReport, 'reasons'>) => report.reasons.map((reason) => reason.code);

test('DEP-004 test:report:release is ready for per push bundles of one push run and a capacity bundle of another workflow_dispatch run, and writes only release.json and release.md', async () => {
  const fixture = await repository();
  await releaseBundles(fixture);
  const before = await filesOf(join(fixture.dir, '.local'));
  // The job summary lives outside the checkout, as GITHUB_STEP_SUMMARY does on a runner; the command never touches it.
  const summary = join(await workspace({ 'summary.md': '# Ringkasan lain\n' }), 'summary.md');
  const output = lines();
  expect(await runReleaseReport(fixture.dir, output.log, { ...reportEnv(), GITHUB_STEP_SUMMARY: summary })).toBe(0);

  const found = JSON.parse(await readFile(join(fixture.dir, RELEASE_JSON), 'utf8')) as ReleaseReport;
  expect(Object.keys(found)).toEqual(['schema', 'generatedAt', 'candidate', 'perPush', 'capacity', 'deployment', 'status', 'reasons', 'grantsDeployment']);
  expect(found.schema).toBe(1);
  expect(Number.isNaN(Date.parse(found.generatedAt))).toBe(false);
  expect(found.candidate).toEqual({ commit: fixture.commit, sourceTree: fixture.tree });
  // Each report is bound to the identity of its own bundles, with job left out: two different runs judged together.
  expect(found.perPush).toEqual({ gate: 'passed', releaseCandidate: { value: true, reasons: [] }, ci: { ...PUSH_RUN, sha: fixture.commit, job: null } });
  expect(found.capacity).toEqual({ status: 'passed', releaseCandidate: { value: true, reasons: [] }, ci: { ...DISPATCH_RUN, sha: fixture.commit, job: null } });
  expect(found.deployment?.images.map((image) => [image.name, image.revision, image.sourceTree])).toEqual(
    DEPLOYMENT_IMAGE_NAMES.map((name) => [name, fixture.commit, fixture.tree]),
  );
  expect(found.deployment?.status).toBe('passed');
  expect([found.status, found.reasons, found.grantsDeployment]).toEqual(['ready', [], false]);

  // Only the two release files are new; the per push and capacity reports are not written, and the summary is unread.
  expect(await filesOf(join(fixture.dir, '.local'))).toEqual([...before, RELEASE_JSON.slice('.local/'.length), RELEASE_MD.slice('.local/'.length)].sort());
  expect(RELEASE_READINESS_DIR).toBe('.local/feature-13');
  expect(await readFile(summary, 'utf8')).toBe('# Ringkasan lain\n');

  expect(output.out).toEqual([
    'Status release ready',
    `  gate per push: passed, Kandidat release: ya, run 1000 attempt 1, event push, ref refs/heads/main, sha ${fixture.commit}`,
    `  laporan kapasitas: passed, Kandidat release: ya, run 2000 attempt 1, event workflow_dispatch, ref refs/heads/main, sha ${fixture.commit}`,
    '  alasan: tidak ada',
    '  grantsDeployment: false (status ini bukan izin deploy)',
    'Laporan: .local/feature-13/release.json dan .local/feature-13/release.md',
  ]);

  const markdown = await readFile(join(fixture.dir, RELEASE_MD), 'utf8');
  expect(markdown).toBe(renderReleaseMarkdown(found));
  expect(markdown.split('\n').filter((line) => /^##? /.test(line))).toEqual([
    '# Status kesiapan release',
    '## Status',
    '## Alasan',
    '## Kandidat',
    '## Run per push',
    '## Run kapasitas',
    '## Image',
  ]);
  expect(markdown).toContain('Status release: `ready`.');
  expect(markdown).toContain('\nTidak ada alasan.\n');
  expect(markdown).toContain(`| Commit checkout | ${fixture.commit} |`);
  expect(markdown).toContain('| Memberi izin deploy (grantsDeployment) | false |');
  expect(markdown).toContain(`| Identitas run dari manifest | run 1000 attempt 1, event push, ref refs/heads/main, sha ${fixture.commit} |`);
  expect(markdown).toContain(`| Identitas run dari manifest | run 2000 attempt 1, event workflow\\_dispatch, ref refs/heads/main, sha ${fixture.commit} |`);
  expect(markdown).toContain(`| frontend | foundation-frontend:deploy-0123456789ab | sha256:${'1'.repeat(64)} | ${fixture.commit} | ${fixture.tree} | ya |`);
  expect(markdown).toContain(DEPLOYMENT_LOCAL_ONLY);
}, 90_000);

test('DEP-004 release.md always carries the two fixed sentences, and grantsDeployment is false for every status', async () => {
  expect(RELEASE_NOT_PERMISSION).toBe(
    'Status `ready` berarti bukti wajib lengkap dan lulus untuk kandidat ini, dan tidak memberi izin deploy; keputusan deploy dicatat terpisah oleh pemilik release.',
  );
  expect(RELEASE_IDENTITY_UNVERIFIED).toBe(
    'Identitas run dibaca dari manifest bundle yang ditulis run itu sendiri dan tidak diverifikasi ke GitHub, dan paket OS image tidak dipindai pemindai kerentanan.',
  );
  const ready = await repository();
  await releaseBundles(ready);
  const local = await repository();
  await releaseBundles(local, { perPush: { ci: null }, capacity: { ci: null } });
  const blocked = await repository();
  await releaseBundles(blocked, { capacity: { change: (manifest) => Object.assign(manifest, { status: 'failed', steps: manifest.steps.map((step, index) => (index === 0 ? { ...step, status: 'failed', exitCode: 1, reasons: [{ code: 'exit_code', path: null }] } : step)) }) } });
  const statuses: string[] = [];
  for (const fixture of [ready, local, blocked]) {
    const report = await buildReleaseReport(fixture.dir, reportEnv());
    statuses.push(report.status);
    expect(report.grantsDeployment).toBe(false);
    const markdown = renderReleaseMarkdown(report).split('\n');
    expect(markdown).toContain(RELEASE_NOT_PERMISSION);
    expect(markdown).toContain(RELEASE_IDENTITY_UNVERIFIED);
  }
  expect(statuses).toEqual(['ready', 'incomplete', 'blocked']);
}, 90_000);

test('DEP-004 the release status ignores the GITHUB_* variables of the report process, while test:report and test:report:capacity still read them', async () => {
  const fixture = await repository();
  await releaseBundles(fixture);
  const other = { GITHUB_RUN_ID: '9999', GITHUB_RUN_ATTEMPT: '3', GITHUB_JOB: 'report', GITHUB_SHA: 'f'.repeat(40), GITHUB_REF: 'refs/pull/7/merge', GITHUB_EVENT_NAME: 'pull_request' };
  const plain = await buildReleaseReport(fixture.dir, reportEnv());
  const foreign = await buildReleaseReport(fixture.dir, { ...reportEnv(), ...other });
  const stable = (report: ReleaseReport) => ({ ...report, generatedAt: null });
  expect(stable(foreign)).toEqual(stable(plain));
  expect([foreign.status, foreign.perPush.ci?.runId, foreign.capacity.ci?.runId]).toEqual(['ready', '1000', '2000']);

  // Without the new parameter both reports keep reading the identity of their own process (spec 0010 and 0011).
  const perPush = await buildReport(fixture.dir, { ...reportEnv(), ...other });
  expect(perPush.candidate.ci).toEqual({ runId: '9999', runAttempt: '3', job: 'report', sha: 'f'.repeat(40), ref: 'refs/pull/7/merge', event: 'pull_request' });
  expect(perPush.binding.problems.map((problem) => `${problem.code} ${problem.tier ?? 'laporan'}`)).toEqual([
    'ci_identity_differs fast',
    'ci_identity_differs real',
    'ci_identity_differs security',
    'ci_identity_differs laporan',
  ]);
  const local = await buildReport(fixture.dir, reportEnv());
  expect(local.candidate.ci).toBeNull();
  expect(local.binding.problems.map((problem) => problem.code)).toEqual(['ci_mixed', 'ci_mixed', 'ci_mixed']);
  const sameRun = { GITHUB_RUN_ID: '1000', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'report', GITHUB_SHA: fixture.commit, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push' };
  const job = await buildReport(fixture.dir, { ...reportEnv(), ...sameRun });
  expect([job.gate, job.releaseCandidate.value, job.candidate.ci?.job]).toEqual(['passed', true, 'report']);
  const capacity = await buildCapacityReport(fixture.dir, { ...reportEnv(), ...other });
  expect(capacity.candidate.ci?.runId).toBe('9999');
  expect(capacity.binding.problems.map((problem) => problem.code)).toEqual(['ci_identity_differs', 'ci_identity_differs']);
  expect((await buildCapacityReport(fixture.dir, reportEnv())).binding.problems.map((problem) => problem.code)).toEqual(['ci_mixed']);
}, 90_000);

test('DEP-004 local bundles without a CI identity are incomplete with gate_not_candidate and capacity_not_candidate, and the command exits 1', async () => {
  const fixture = await repository();
  await releaseBundles(fixture, { perPush: { ci: null }, capacity: { ci: null } });
  const output = lines();
  expect(await runReleaseReport(fixture.dir, output.log, reportEnv())).toBe(1);
  const found = JSON.parse(await readFile(join(fixture.dir, RELEASE_JSON), 'utf8')) as ReleaseReport;
  expect([found.perPush.gate, found.capacity.status, found.perPush.ci, found.capacity.ci]).toEqual(['passed', 'passed', null, null]);
  expect(found.perPush.releaseCandidate.reasons).toEqual([
    { code: 'not_ci', tier: 'fast' },
    { code: 'not_ci', tier: 'real' },
    { code: 'not_ci', tier: 'security' },
    { code: 'not_ci', tier: null },
  ]);
  expect(found.capacity.releaseCandidate.reasons).toEqual([{ code: 'not_ci', tier: null }]);
  expect([found.status, codes(found), found.grantsDeployment]).toEqual(['incomplete', ['gate_not_candidate', 'capacity_not_candidate'], false]);
  expect(output.out[0]).toBe('Status release incomplete');
  expect(output.out).toContain('  alasan: gate_not_candidate, capacity_not_candidate');
  const markdown = await readFile(join(fixture.dir, RELEASE_MD), 'utf8');
  expect(markdown).toContain('- `gate_not_candidate` (incomplete): laporan per push bukan kandidat release.');
  expect(markdown).toContain('- `capacity_not_candidate` (incomplete): laporan kapasitas bukan kandidat release.');
  expect(markdown).toContain('| Identitas run dari manifest | run lokal tanpa identitas CI |');
}, 90_000);

test('DEP-004 bundles of another commit, CI identities that differ between per push tiers, a capacity run of event push, and an image of another revision', async () => {
  // Per push bundles of another commit: the binding and the candidate both see it.
  const otherCommit = 'f'.repeat(40);
  const moved = await repository();
  await releaseBundles(moved, { perPush: { commit: otherCommit, ci: { ...PUSH_RUN, sha: otherCommit } } });
  const movedReport = await buildReleaseReport(moved.dir, reportEnv());
  expect([movedReport.status, codes(movedReport)]).toEqual(['incomplete', ['gate_incomplete', 'gate_not_candidate', 'candidate_differs']]);
  expect(movedReport.capacity.status).toBe('passed');

  // Another source tree in one capacity manifest only: candidate_differs counts every one of the four manifests.
  const tree = await repository();
  await releaseBundles(tree, { capacity: { tree: sha256('other tree') } });
  const treeReport = await buildReleaseReport(tree.dir, reportEnv());
  expect(codes(treeReport)).toEqual(['capacity_incomplete', 'capacity_not_candidate', 'candidate_differs']);

  // The real tier of another run: bundleCi takes the fast manifest, so real is ci_identity_differs.
  const mixed = await repository();
  await releaseBundles(mixed, { tiers: { real: { ci: { ...PUSH_RUN, runId: '1001', sha: mixed.commit } } } });
  const mixedReport = await buildReleaseReport(mixed.dir, reportEnv());
  expect([mixedReport.perPush.gate, mixedReport.perPush.ci?.runId, codes(mixedReport)]).toEqual(['incomplete', '1000', ['gate_incomplete', 'gate_not_candidate']]);
  // A second attempt of the same run on one tier is ci_attempt_differs, also incomplete.
  const attempt = await repository();
  await releaseBundles(attempt, { tiers: { security: { ci: { ...PUSH_RUN, runAttempt: '2', sha: attempt.commit } } } });
  expect(codes(await buildReleaseReport(attempt.dir, reportEnv()))).toEqual(['gate_incomplete', 'gate_not_candidate']);

  // A capacity bundle of event push is no capacity release candidate.
  const pushed = await repository();
  await releaseBundles(pushed, { capacity: { ci: { ...DISPATCH_RUN, event: 'push', sha: pushed.commit } } });
  const pushedReport = await buildReleaseReport(pushed.dir, reportEnv());
  expect([pushedReport.capacity.status, pushedReport.capacity.releaseCandidate.reasons, codes(pushedReport)]).toEqual([
    'passed',
    [{ code: 'event_not_dispatch', tier: null }],
    ['capacity_not_candidate'],
  ]);

  // An image labelled with another revision, or with a null label, is image_differs while the gate still passes.
  for (const [label, labels] of [
    ['another revision', (fixture: Fixture) => ({ revision: 'c'.repeat(40), sourceTree: fixture.tree })],
    ['another source tree', (fixture: Fixture) => ({ revision: fixture.commit, sourceTree: sha256('other') })],
    ['a null label', () => ({ revision: null, sourceTree: null })],
  ] as const) {
    const fixture = await repository();
    const images = imagesFile((value) => {
      for (const image of value['images']) image.labels = { revision: fixture.commit, sourceTree: fixture.tree };
      value['images'][1].labels = labels(fixture);
    });
    await releaseBundles(fixture, { tiers: { real: { files: { [IMAGES]: JSON.stringify(images) } } } });
    const report = await buildReleaseReport(fixture.dir, reportEnv());
    expect([report.perPush.gate, report.status, codes(report)], label).toEqual(['passed', 'incomplete', ['image_differs']]);
    expect(renderReleaseMarkdown(report).split('\n').find((line) => line.startsWith('| backend |'))?.endsWith('| tidak |'), label).toBe(true);
  }

  // Without a valid images.json the field deployment is null, so the labels cannot be compared: image_differs.
  const shapeless = await repository();
  await releaseBundles(shapeless, { tiers: { real: { files: { [IMAGES]: JSON.stringify({ schema: 2, images: [] }) } } } });
  const shapelessReport = await buildReleaseReport(shapeless.dir, reportEnv());
  expect([shapelessReport.deployment, codes(shapelessReport)]).toEqual([null, ['image_differs']]);
  expect(renderReleaseMarkdown(shapelessReport)).toContain('Bukti deployment tidak tersedia di laporan per push, sehingga label image tidak dapat dibandingkan dengan checkout.');
}, 180_000);

test('DEP-004 a failed per push gate or capacity report blocks the release, every code keeps its order and class, and only ready exits 0', async () => {
  const failStep = (manifest: TierManifest) => {
    manifest.status = 'failed';
    manifest.steps[0] = { ...manifest.steps[0]!, status: 'failed', exitCode: 1, reasons: [{ code: 'exit_code', path: null }] };
  };
  const gate = await repository();
  await releaseBundles(gate, { tiers: { fast: { change: failStep } } });
  const gateOutput = lines();
  expect(await runReleaseReport(gate.dir, gateOutput.log, reportEnv())).toBe(1);
  const gateReport = JSON.parse(await readFile(join(gate.dir, RELEASE_JSON), 'utf8')) as ReleaseReport;
  expect([gateReport.perPush.gate, gateReport.status, codes(gateReport), gateReport.grantsDeployment]).toEqual(['failed', 'blocked', ['gate_failed', 'gate_not_candidate'], false]);
  expect(gateOutput.out[0]).toBe('Status release blocked');
  expect(await readFile(join(gate.dir, RELEASE_MD), 'utf8')).toContain('- `gate_failed` (blocked): gate per push berstatus failed.');

  const capacity = await repository();
  await releaseBundles(capacity, { capacity: { change: failStep } });
  const capacityReport = await buildReleaseReport(capacity.dir, reportEnv());
  expect([capacityReport.capacity.status, capacityReport.status, codes(capacityReport)]).toEqual(['failed', 'blocked', ['capacity_failed', 'capacity_not_candidate']]);

  // The vocabulary and the classes of *Status kesiapan release*, written here from the table.
  expect([...REASON_CODES.releaseReadiness]).toEqual([
    'gate_failed', 'capacity_failed', 'gate_incomplete', 'capacity_incomplete', 'gate_not_candidate', 'capacity_not_candidate', 'candidate_differs', 'image_differs',
  ]);
  expect([...RELEASE_BLOCKED_CODES]).toEqual(['gate_failed', 'capacity_failed']);

  // The pure rules: every code that applies, in the table order, whatever order the conditions arise in.
  const commit = 'a'.repeat(40);
  const tree = 'b'.repeat(64);
  const manifest = (manifestCommit: string | null, manifestTree: string | null) =>
    ({ candidate: { commit: manifestCommit, clean: true, sourceTree: manifestTree, sourceTreeAfter: manifestTree, ci: null } }) as TierManifest;
  const image = (revision: string | null, sourceTree: string | null) => ({ name: 'backend', tag: 't', imageId: null, sizeBytes: null, user: null, bases: [], revision, sourceTree }) as DeploymentReport['images'][number];
  const deployment = (images: DeploymentReport['images']): DeploymentReport => ({ status: 'passed', evidence: 'x', images, checks: [], boundary: null });
  type ReadinessInput = Parameters<typeof releaseReadiness>[0];
  const good: ReadinessInput = {
    gate: 'passed',
    gateCandidate: true,
    capacity: 'passed',
    capacityCandidate: true,
    checkout: { commit, sourceTree: tree },
    manifests: [manifest(commit, tree), null, manifest(commit, tree), manifest(commit, tree)],
    deployment: deployment([image(commit, tree), image(commit, tree), image(commit, tree)]),
  };
  const codesOf = (input: ReadinessInput): string[] => releaseReadiness(input).reasons.map((reason) => reason.code);
  expect(releaseReadiness(good)).toEqual({ status: 'ready', reasons: [] });
  const worst: ReadinessInput = { ...good, gate: 'failed', gateCandidate: false, capacity: 'incomplete', capacityCandidate: false, manifests: [manifest('f'.repeat(40), tree)], deployment: null };
  expect(releaseReadiness(worst).status).toBe('blocked');
  expect(codesOf(worst)).toEqual(['gate_failed', 'capacity_incomplete', 'gate_not_candidate', 'capacity_not_candidate', 'candidate_differs', 'image_differs']);
  expect(codesOf({ ...worst, gate: 'incomplete', capacity: 'failed' }).slice(0, 2)).toEqual(['capacity_failed', 'gate_incomplete']);
  const cases: Array<[string, Partial<ReadinessInput>, string, string[]]> = [
    ['gate failed', { gate: 'failed' }, 'blocked', ['gate_failed']],
    ['capacity failed', { capacity: 'failed' }, 'blocked', ['capacity_failed']],
    ['gate incomplete', { gate: 'incomplete' }, 'incomplete', ['gate_incomplete']],
    ['capacity incomplete', { capacity: 'incomplete' }, 'incomplete', ['capacity_incomplete']],
    ['no per push candidate', { gateCandidate: false }, 'incomplete', ['gate_not_candidate']],
    ['no capacity candidate', { capacityCandidate: false }, 'incomplete', ['capacity_not_candidate']],
    ['no checkout commit', { checkout: { commit: null, sourceTree: tree } }, 'incomplete', ['candidate_differs', 'image_differs']],
    ['no checkout source tree', { checkout: { commit, sourceTree: null } }, 'incomplete', ['candidate_differs', 'image_differs']],
    ['a manifest of another tree', { manifests: [manifest(commit, 'c'.repeat(64))] }, 'incomplete', ['candidate_differs']],
    ['a manifest without commit', { manifests: [manifest(null, tree)] }, 'incomplete', ['candidate_differs']],
    ['no deployment field', { deployment: null }, 'incomplete', ['image_differs']],
    ['an image without revision', { deployment: deployment([image(commit, tree), image(null, tree)]) }, 'incomplete', ['image_differs']],
    ['an image of another tree', { deployment: deployment([image(commit, 'c'.repeat(64))]) }, 'incomplete', ['image_differs']],
  ];
  for (const [label, change, status, expected] of cases) {
    const input = { ...good, ...change };
    expect([releaseReadiness(input).status as string, codesOf(input)], label).toEqual([status, expected]);
  }
}, 120_000);

test('DEP-004 bundleCi takes candidate.ci of the first valid manifest that has one, in the given order, with job set to null', () => {
  const manifest = (ci: CiIdentity | null) => ({ candidate: { commit: null, clean: true, sourceTree: null, sourceTreeAfter: null, ci } }) as TierManifest;
  const fast: CiIdentity = { runId: '1', runAttempt: '1', job: 'application', sha: 'a', ref: 'refs/heads/main', event: 'push' };
  const real: CiIdentity = { ...fast, runId: '2', job: 'real' };
  expect(bundleCi([manifest(fast), manifest(real)])).toEqual({ ...fast, job: null });
  expect(bundleCi([null, manifest(null), manifest(real)])).toEqual({ ...real, job: null });
  expect(bundleCi([null, manifest(null)])).toBeNull();
  expect(bundleCi([])).toBeNull();
  // A copy with the six fields only, never the manifest object itself.
  const extra = { ...fast, extra: 'x' } as CiIdentity;
  const copied = bundleCi([manifest(extra)])!;
  expect(Object.keys(copied)).toEqual(['runId', 'runAttempt', 'job', 'sha', 'ref', 'event']);
  expect(extra.job).toBe('application');
});

test('DEP-004 scripts/gate-report.ts release writes only the release files in a workspace and exits 1 without bundles, and another argument prints the usage', async () => {
  const dir = await workspace({ 'package.json': JSON.stringify({ name: 'fixture', private: true }) }, 'foundation-release-cli-');
  const scripts = join(import.meta.dir, '../../../scripts');
  await cp(join(scripts, 'gate-report.ts'), join(dir, 'scripts/gate-report.ts'));
  await cp(join(scripts, 'lib'), join(dir, 'scripts/lib'), { recursive: true });
  const runCli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/gate-report.ts', ...args], { cwd: dir, env: reportEnv(), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  for (const args of [['release', 'extra'], ['Release'], ['releases']]) {
    expect(await runCli(args), args.join(' ')).toEqual({ stdout: '', stderr: 'Pemakaian: bun --no-env-file scripts/gate-report.ts [capacity|release]\n', code: 1 });
  }
  expect(await Bun.file(join(dir, RELEASE_JSON)).exists()).toBe(false);

  const release = await runCli(['release']);
  expect([release.code, release.stderr]).toEqual([1, '']);
  expect(release.stdout.split('\n')[0]).toBe('Status release incomplete');
  const written = JSON.parse(await readFile(join(dir, RELEASE_JSON), 'utf8')) as ReleaseReport;
  // Without a repository and without bundles every incomplete code applies, and nothing is blocked.
  expect([written.status, codes(written), written.grantsDeployment]).toEqual([
    'incomplete',
    ['gate_incomplete', 'capacity_incomplete', 'gate_not_candidate', 'capacity_not_candidate', 'candidate_differs', 'image_differs'],
    false,
  ]);
  expect(await filesOf(join(dir, '.local'))).toEqual(['feature-13/release.json', 'feature-13/release.md']);
}, 60_000);

test('DEP-004 scripts/gate-report.ts release that cannot write the release files prints one fixed line, no status, and exits 1', async () => {
  // `.local/feature-13` is a regular file here, so the release folder cannot be created.
  const dir = await workspace({ 'package.json': JSON.stringify({ name: 'fixture', private: true }), [RELEASE_READINESS_DIR]: 'not a folder\n' }, 'foundation-release-cli-');
  const scripts = join(import.meta.dir, '../../../scripts');
  await cp(join(scripts, 'gate-report.ts'), join(dir, 'scripts/gate-report.ts'));
  await cp(join(scripts, 'lib'), join(dir, 'scripts/lib'), { recursive: true });
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/gate-report.ts', 'release'], { cwd: dir, env: reportEnv(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  // No status line reaches stdout, and stderr holds the fixed line only, without an error message or a stack.
  expect({ stdout, stderr, code }).toEqual({ stdout: '', stderr: 'Status release tidak dapat disusun\n', code: 1 });
  expect(await readFile(join(dir, RELEASE_READINESS_DIR), 'utf8')).toBe('not a folder\n');
  expect(await filesOf(join(dir, '.local'))).toEqual(['feature-13']);
}, 60_000);
