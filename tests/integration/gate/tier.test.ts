import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, lstat, readdir, readFile, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bundlePath,
  LEFTOVER_PORTS,
  runTier,
  sensitiveForms,
  sensitiveValues,
  sha256,
  STEP_ENV_KEYS,
  stepEnvironment,
  TIER_NAMES,
  TIER_SCRIPTS,
  tierByName,
  TIERS,
  type EvidenceSpec,
  type StepReasonCode,
  type Tier,
  type TierManifest,
  type TierStep,
} from '../../../scripts/lib/gate.ts';
import { EVIDENCE_TEXT_LIMIT, JUnitError, junitCounts, junitResults, parseJUnit } from '../../../scripts/lib/junit.ts';
import { runProcessGroup } from '../../../scripts/lib/process-group.ts';
import { groupAlive } from '../../../scripts/lib/process-identity.ts';
import { restoreEvidenceFailure, restorePassed } from '../../orchestration/restore-evidence.ts';
import { lines, removeWorkspaces, workspace } from './workspace.ts';

// GATE-004 (spec 0010, AC-4 and AC-8) and the skip rule of GATE-008 (AC-4): the tier runner on fixture workspaces with
// a made up `package.json`. Each step script is a small `sh` file, so the fixture needs no runner of the repository.
// Everything is written at runtime in `mkdtemp` folders outside the repository (key invariant 12).

afterEach(removeWorkspaces);

const gateModule = join(import.meta.dir, '../../../scripts/lib/gate.ts');
const JUNIT = '.local/x/j.xml';

const junit = (path = JUNIT): EvidenceSpec => ({ path, kind: 'junit', runner: 'bun:test', required: true });
const json = (path: string, kind: 'image' | 'scan'): EvidenceSpec => ({ path, kind, runner: null, required: true });
const step = (script: string, evidence: EvidenceSpec[] = []): TierStep => ({ script, evidence });

function tier(steps: TierStep[], limits: Partial<Pick<Tier, 'stepTimeoutMs' | 'stopGraceMs'>> = {}): Tier {
  return { name: 'fast', script: 'test:ci', steps, stepTimeoutMs: 30_000, stopGraceMs: TIERS.fast!.stopGraceMs, ...limits };
}

/** A `bun:test` style JUnit with one file suite around `cases`. */
function junitXml(cases: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test"><testsuite name="a.test.ts" file="a.test.ts">${cases}</testsuite></testsuites>\n`;
}

const passing = junitXml('<testcase name="FIX-001 lulus" classname="x"></testcase>');

/** A workspace whose `package.json` runs `sh ./steps/<name>.sh` for every entry of `steps`. */
async function tierWorkspace(steps: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
  const scripts = Object.fromEntries(Object.keys(steps).map((name) => [name, `sh ./steps/${name}.sh`]));
  const stepFiles = Object.fromEntries(Object.entries(steps).map(([name, body]) => [`steps/${name}.sh`, `${body}\n`]));
  return workspace({ 'package.json': JSON.stringify({ name: 'fixture', private: true, scripts }), ...stepFiles, ...files });
}

/** The gate process environment of a fixture run: enough to start Bun and the shell, plus `extra`. */
function gateEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', ...extra };
  for (const name of ['HOME', 'TMPDIR']) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  return env;
}

async function run(root: string, fixture: Tier, extra: Record<string, string> = {}) {
  const output = lines();
  const code = await runTier({ root, tier: fixture, log: output.log, env: gateEnv(extra) });
  const text = await readFile(join(root, bundlePath(fixture.name), 'manifest.json'), 'utf8');
  return { code, output, text, manifest: JSON.parse(text) as TierManifest };
}

async function bundleFiles(root: string, name = 'fast'): Promise<string[]> {
  const dir = join(root, bundlePath(name as 'fast'));
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const copy = (from: string, to = JUNIT) => `mkdir -p "$(dirname ${to})" && cp ${from} ${to}`;

test('GATE-004 the runner stops at the first step that does not pass and records the rest not_run', async () => {
  const dir = await tierWorkspace({ pass: 'exit 0', fail: 'exit 3', never: 'echo ran > never.txt' });
  const { code, manifest, output } = await run(dir, tier([step('pass'), step('fail'), step('never')]));
  expect(code).toBe(1);
  expect(manifest.status).toBe('failed');
  expect(manifest.steps.map((item) => [item.script, item.status, item.exitCode, item.reasons])).toEqual([
    ['pass', 'passed', 0, []],
    ['fail', 'failed', 3, [{ code: 'exit_code', path: null }]],
    ['never', 'not_run', null, [{ code: 'previous_step', path: null }]],
  ]);
  expect(await exists(join(dir, 'never.txt'))).toBe(false);
  expect(output.out).toContain('gate fast: never not_run (previous_step)');
  expect(output.out.at(-2)).toBe('gate fast: tier failed (1 dari 3 langkah passed)');
});

test('GATE-004 stale JUnit is removed before the step, so a step that writes none fails with evidence_missing', async () => {
  const dir = await tierWorkspace({ quiet: 'exit 0' }, { [JUNIT]: passing });
  const { code, manifest } = await run(dir, tier([step('quiet', [junit()])]));
  expect(code).toBe(1);
  expect(await exists(join(dir, JUNIT))).toBe(false);
  const [record] = manifest.steps;
  expect(record?.status).toBe('failed');
  expect(record?.reasons).toEqual([{ code: 'evidence_missing', path: JUNIT }]);
  expect(record?.evidence).toEqual([
    { path: JUNIT, kind: 'junit', required: true, present: false, sha256: null, runner: 'bun:test', tests: null, failures: null, errors: null, skipped: null },
  ]);
  expect(await bundleFiles(dir)).toEqual(['manifest.json']);
});

test('GATE-004 the SHA 256 of every evidence file and folder file is recorded and the bundle copy is byte for byte', async () => {
  const pngA = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);
  const pngB = new Uint8Array([137, 80, 78, 71, 9, 8, 7]);
  const dir = await tierWorkspace({
    write: [copy('fixture.xml'), 'mkdir -p .local/x/shots/inner', 'cp b.png .local/x/shots/b.png', 'cp a.png .local/x/shots/inner/a.png'].join(' && '),
  }, { 'fixture.xml': passing });
  await writeFile(join(dir, 'a.png'), pngA);
  await writeFile(join(dir, 'b.png'), pngB);
  const shots: EvidenceSpec = { path: '.local/x/shots/', kind: 'screenshots', runner: null, required: false };
  const { code, manifest } = await run(dir, tier([step('write', [junit(), shots])]));
  expect(code).toBe(0);
  const [record] = manifest.steps;
  expect(record?.status).toBe('passed');
  expect(record?.evidence[0]).toMatchObject({ path: JUNIT, present: true, sha256: sha256(passing), tests: 1, failures: 0, errors: 0, skipped: 0 });
  expect(record?.evidence[1]).toEqual({
    path: '.local/x/shots/',
    kind: 'screenshots',
    required: false,
    present: true,
    files: [
      { path: '.local/x/shots/b.png', sha256: sha256(pngB) },
      { path: '.local/x/shots/inner/a.png', sha256: sha256(pngA) },
    ],
  });
  const bundle = join(dir, bundlePath('fast'));
  expect(sha256(await readFile(join(bundle, JUNIT)))).toBe(sha256(passing));
  expect(sha256(await readFile(join(bundle, '.local/x/shots/inner/a.png')))).toBe(sha256(pngA));
  expect(await bundleFiles(dir)).toEqual(['.local/x/j.xml', '.local/x/shots/b.png', '.local/x/shots/inner/a.png', 'manifest.json']);
});

test('GATE-004 a JUnit that is broken, outside the reader, or above the size limit fails as evidence_invalid, and a failure as junit_failures', async () => {
  const cases: Array<[string, string, StepReasonCode]> = [
    ['doctype', `<?xml version="1.0"?><!DOCTYPE x><testsuites></testsuites>`, 'evidence_invalid'],
    ['unknown element', junitXml('<testcase name="a"><attachment/></testcase>'), 'evidence_invalid'],
    ['testcase outside testsuite', '<testsuites><testcase name="a"/></testsuites>', 'evidence_invalid'],
    ['unknown entity', junitXml('<testcase name="a&nbsp;b"/>'), 'evidence_invalid'],
    ['not closed', '<testsuites><testsuite name="a">', 'evidence_invalid'],
    ['failure', junitXml('<testcase name="a"><failure message="x"/></testcase>'), 'junit_failures'],
    ['error', junitXml('<testcase name="a"><error message="x"/></testcase>'), 'junit_failures'],
  ];
  for (const [label, xml, reason] of cases) {
    const dir = await tierWorkspace({ write: copy('fixture.xml') }, { 'fixture.xml': xml });
    const { code, manifest } = await run(dir, tier([step('write', [junit()])]));
    expect(code, label).toBe(1);
    expect(manifest.steps[0]?.status, label).toBe('failed');
    expect(manifest.steps[0]?.reasons, label).toEqual([{ code: reason, path: JUNIT }]);
  }

  // A sparse file one byte above 50 MB: the size alone rejects it, without reading it.
  const dir = await tierWorkspace({ write: `mkdir -p .local/x && mv big.xml ${JUNIT}` }, { 'big.xml': '' });
  await truncate(join(dir, 'big.xml'), EVIDENCE_TEXT_LIMIT + 1);
  const { manifest } = await run(dir, tier([step('write', [junit()])]));
  expect(manifest.steps[0]?.reasons).toEqual([{ code: 'evidence_invalid', path: JUNIT }]);
  expect(manifest.steps[0]?.evidence[0]).toMatchObject({ present: true, sha256: null });
}, 60_000);

test('GATE-004 image.json and artifact-scan.json must be JSON objects, and a scan with findings fails the step', async () => {
  const image = '.local/x/image.json';
  const scan = '.local/x/artifact-scan.json';
  const cases: Array<[string, string | null, string, string[]]> = [
    ['image missing', null, '{ "findings": [] }', [`evidence_missing ${image}`]],
    ['image broken', '{', '{ "findings": [] }', [`evidence_invalid ${image}`]],
    ['scan not an object', '{}', '[]', [`evidence_invalid ${scan}`]],
    ['scan broken', '{}', 'not json', [`evidence_invalid ${scan}`]],
    ['scan with findings', '{}', '{ "findings": [{ "path": "x" }] }', [`artifact_scan_findings ${scan}`]],
    ['scan without findings array', '{}', '{}', [`artifact_scan_findings ${scan}`]],
    ['both valid', '{ "image": "x" }', '{ "findings": [] }', []],
  ];
  for (const [label, imageText, scanText, reasons] of cases) {
    const files: Record<string, string> = { 'scan.json': scanText };
    if (imageText !== null) files['image.json'] = imageText;
    const body = ['mkdir -p .local/x', imageText === null ? 'true' : `cp image.json ${image}`, `cp scan.json ${scan}`].join(' && ');
    const dir = await tierWorkspace({ write: body }, files);
    const { manifest } = await run(dir, tier([step('write', [json(image, 'image'), json(scan, 'scan')])]));
    const [record] = manifest.steps;
    expect(record?.reasons.map((reason) => `${reason.code} ${reason.path}`), label).toEqual(reasons);
    expect(record?.status, label).toBe(reasons.length === 0 ? 'passed' : 'failed');
  }
}, 60_000);

test('GATE-004 JUnit with a CDATA that holds </testsuite> and <testcase, a testsuites root, and numeric references has no fake testcase', async () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="playwright" tests="9">',
    '<testsuite name="a.e2e.spec.ts" tests="9">',
    '<testcase name="FIX-001 satu&#10;dua &#x41;&amp;B" classname="a">',
    '<system-out><![CDATA[<testcase name="fake"></testcase></testsuite><testsuite name="fake">]]></system-out>',
    '</testcase>',
    '</testsuite>',
    '</testsuites>',
  ].join('\n');
  const dir = await tierWorkspace({ write: copy('fixture.xml') }, { 'fixture.xml': xml });
  const { code, manifest } = await run(dir, tier([step('write', [{ ...junit(), runner: 'playwright' }])]));
  expect(code).toBe(0);
  expect(manifest.steps[0]?.status).toBe('passed');
  expect(manifest.steps[0]?.evidence[0]).toMatchObject({ tests: 1, failures: 0, errors: 0, skipped: 0 });
});

test('GATE-004 a skipped testcase marks the step skipped, stops the tier, and fails it', async () => {
  const xml = junitXml('<testcase name="FIX-001 a"></testcase><testcase name="FIX-002 b"><skipped message="butuh layanan"/></testcase>');
  const dir = await tierWorkspace({ write: copy('fixture.xml'), next: 'echo ran > next.txt' }, { 'fixture.xml': xml });
  const { code, manifest } = await run(dir, tier([step('write', [junit()]), step('next')]));
  expect(code).toBe(1);
  expect(manifest.status).toBe('failed');
  expect(manifest.steps[0]).toMatchObject({ status: 'skipped', exitCode: 0, reasons: [{ code: 'testcase_skipped', path: JUNIT }] });
  expect(manifest.steps[0]?.evidence[0]).toMatchObject({ tests: 2, skipped: 1 });
  expect(manifest.steps[1]).toMatchObject({ status: 'not_run', reasons: [{ code: 'previous_step', path: null }] });
  expect(await exists(join(dir, 'next.txt'))).toBe(false);
});

test('GATE-004 on timeout the group gets the tier grace, so a step that needs more than 5 seconds to clean up finishes before SIGKILL', async () => {
  // `sleep 60 &` plus `wait` lets the trap run as soon as SIGTERM arrives; the trap then needs six seconds. The shell
  // gets SIGTERM twice: from the gate, which signals the whole group, and from `bun run`, which forwards it to its
  // child. A second SIGTERM that comes after the trap started makes dash and bash 5 (Linux) run the trap again once
  // `sleep 6` ends (12 seconds, past the grace), so the trap first ignores TERM, as the cleanup of a real step ignores a
  // later signal. The test sends that late SIGTERM itself one second into the trap, so the worst case runs every time.
  const dir = await tierWorkspace({ slow: "echo $$ > shell.pid\ntrap 'trap \"\" TERM; sleep 6; echo cleaned > cleaned.txt; exit 0' TERM\nsleep 60 &\nwait" });
  const late = Bun.sleep(2_500).then(async () => process.kill(Number(await readFile(join(dir, 'shell.pid'), 'utf8')), 'SIGTERM'));
  const { code, manifest } = await run(dir, tier([step('slow')], { stepTimeoutMs: 1_500, stopGraceMs: TIERS.fast!.stopGraceMs }));
  await late;
  expect(code).toBe(1);
  const [record] = manifest.steps;
  expect(record).toMatchObject({ status: 'failed', timedOut: true, signal: null, reasons: [{ code: 'timeout', path: null }] });
  expect(await readFile(join(dir, 'cleaned.txt'), 'utf8')).toBe('cleaned\n');
  expect(record!.durationMs).toBeGreaterThanOrEqual(6_000);
  expect(record!.durationMs).toBeLessThan(1_500 + TIERS.fast!.stopGraceMs);
}, 30_000);

for (const [signal, expected] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
  test(`GATE-004 ${signal} to the gate stops the step group, writes the manifest, exits ${expected}, and leaves no process`, async () => {
    const runner = [
      `import { runTier } from ${JSON.stringify(gateModule)};`,
      "const step = (script: string) => ({ script, evidence: [] });",
      "const tier = { name: 'fast' as const, script: 'test:ci', steps: [step('wait'), step('after')], stepTimeoutMs: 60_000, stopGraceMs: 10_000 };",
      'process.exitCode = await runTier({ root: process.cwd(), tier });',
    ].join('\n');
    const dir = await tierWorkspace({ wait: 'echo $$ > pid.txt\nexec sleep 60', after: 'echo ran > after.txt' }, { 'run.ts': runner });
    const child = spawn(process.execPath, ['--no-env-file', 'run.ts'], { cwd: dir, env: gateEnv(), detached: true, stdio: 'ignore' });
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
    const gatePid = child.pid!;
    let stepPid = 0;
    try {
      for (const deadline = Date.now() + 20_000; stepPid === 0 && Date.now() < deadline; await Bun.sleep(50)) {
        const text = await readFile(join(dir, 'pid.txt'), 'utf8').catch(() => '');
        stepPid = Number.parseInt(text.trim(), 10) || 0;
      }
      expect(stepPid).toBeGreaterThan(0);
      // Only the gate process gets the signal; the gate must stop the step group itself.
      process.kill(gatePid, signal);
      expect(await exited).toBe(expected);
    } finally {
      try {
        process.kill(-gatePid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    }
    expect(await groupAlive(gatePid)).toBe(false);
    expect(() => process.kill(stepPid, 0)).toThrow();
    const manifest = JSON.parse(await readFile(join(dir, bundlePath('fast'), 'manifest.json'), 'utf8')) as TierManifest;
    expect(manifest.status).toBe('failed');
    expect(manifest.steps[0]).toMatchObject({ script: 'wait', status: 'failed', signal, reasons: [{ code: 'signal', path: null }] });
    expect(manifest.steps[1]).toMatchObject({ script: 'after', status: 'not_run', reasons: [{ code: 'signal', path: null }] });
    expect(await exists(join(dir, 'after.txt'))).toBe(false);
  }, 30_000);
}

test('GATE-004 steps get only the allow listed environment, never DATABASE_URL, other variables, or .env, and the manifest holds no value', async () => {
  const dotenv = `dotenv${randomBytes(8).toString('hex')}`;
  const database = `postgres://sentinel:${randomBytes(8).toString('hex')}@127.0.0.1/db`;
  const outside = `outside${randomBytes(8).toString('hex')}`;
  const dir = await tierWorkspace(
    { env: 'env | sort > env.txt' },
    { '.env': `FOUNDATION_DOTENV_SENTINEL=${dotenv}\nDATABASE_URL=${dotenv}\n` },
  );
  const { code, text, output } = await run(dir, tier([step('env')]), { DATABASE_URL: database, GATE_OUTSIDE_SENTINEL: outside, LANG: 'C' });
  expect(code).toBe(0);
  const seen = await readFile(join(dir, 'env.txt'), 'utf8');
  const names = seen.split('\n').filter((line) => line.includes('=')).map((line) => line.slice(0, line.indexOf('=')));
  expect(names).toContain('PATH');
  expect(names).toContain('LANG');
  for (const name of ['DATABASE_URL', 'GATE_OUTSIDE_SENTINEL', 'FOUNDATION_DOTENV_SENTINEL']) expect(names).not.toContain(name);
  for (const value of [dotenv, database, outside]) {
    expect(seen).not.toContain(value);
    expect(text).not.toContain(value);
    expect(output.out.join('\n')).not.toContain(value);
  }
});

test('GATE-004 a JUnit that holds a sensitive value of the gate process fails as sensitive_value, names the variable only, and is not copied', async () => {
  const secret = `secret${randomBytes(12).toString('hex')}`;
  const xml = junitXml(`<testcase name="FIX-001 a"><system-out>token ${secret}</system-out></testcase>`);
  const dir = await tierWorkspace({ write: copy('fixture.xml') }, { 'fixture.xml': xml });
  const { code, manifest, text, output } = await run(dir, tier([step('write', [junit()])]), { GATE_PROBE_SECRET: secret });
  expect(code).toBe(1);
  expect(manifest.steps[0]).toMatchObject({ status: 'failed', reasons: [{ code: 'sensitive_value', path: JUNIT }] });
  expect(manifest.steps[0]?.evidence[0]).toMatchObject({ present: true, sha256: null });
  const printed = output.out.join('\n');
  expect(printed).toContain(`${JUNIT} memuat nilai variable sensitif GATE_PROBE_SECRET`);
  expect(printed).not.toContain(secret);
  expect(text).not.toContain(secret);
  expect(await bundleFiles(dir)).toEqual(['manifest.json']);
});

test('GATE-008 the real tier runs the five real suites, the deployment step, and then the k6 smoke in order with their evidence, limit, and grace', () => {
  const real = TIERS.real!;
  expect(real.script).toBe('test:ci:real');
  expect(real.stepTimeoutMs).toBe(1_500_000);
  expect(real.stopGraceMs).toBe(180_000);
  expect(real.steps.map((item) => [item.script, item.evidence.map((evidence) => `${evidence.kind} ${evidence.path}${evidence.required ? '' : ' opsional'}`)])).toEqual([
    ['test:infrastructure', ['junit .local/feature-3/infrastructure.xml', 'image .local/feature-3/image.json']],
    // Spec 0013 (AC-8): restore.json of the backup suite is required evidence of kind data on the same step.
    ['test:database:real', ['junit .local/feature-5/database.xml', 'scan .local/feature-5/artifact-scan.json', 'data .local/feature-14/restore.json']],
    ['test:database:migration', ['junit .local/feature-6/migration.xml']],
    ['test:tooling:real', ['junit .local/feature-2/playwright-real.xml', 'scan .local/feature-2/artifact-scan.json', 'screenshots .local/feature-2/test-results/ opsional']],
    ['test:readiness:real', ['junit .local/feature-10/playwright-real.xml', 'scan .local/feature-10/artifact-scan.json', 'screenshots .local/feature-10/test-results/ opsional']],
    // Spec 0012 (*Bukti langkah deployment*): the deployment topology before the smoke, seven steps in all.
    [
      'test:deployment:real',
      [
        'deployment .local/feature-13/result.json',
        'data .local/feature-13/images.json',
        'junit .local/feature-13/playwright-deployment.xml',
        'scan .local/feature-13/artifact-scan.json',
        'screenshots .local/feature-13/test-results/ opsional',
      ],
    ],
    // Spec 0011 (*Tier kapasitas dan gate*): the k6 smoke is the last step, with four required files.
    [
      'test:performance:smoke',
      [
        'performance .local/feature-12/smoke/result.json',
        'data .local/feature-12/smoke/k6/summary.json',
        'data .local/feature-12/smoke/observation.json',
        'scan .local/feature-12/smoke/artifact-scan.json',
      ],
    ],
  ]);
});

test('GATE-008 test:database:real accepts restore.json only as a JSON object with status passed and an empty secretScan.findings, and fails Restore evidence missing without the file', () => {
  // covers: AC-4, spec 0013 AC-8 (*Perubahan database-real.ts*: `Restore evidence missing` atau `Restore evidence not
  // passed` bila `status` bukan `passed` atau `secretScan.findings` tidak kosong)
  const evidence = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const passed = { schema: 1, status: 'passed', failures: [], secretScan: { filesScanned: 9, valuesChecked: 30, findings: [] } };
  expect(restoreEvidenceFailure(evidence(passed))).toBeUndefined();
  expect(restorePassed(evidence(`${JSON.stringify(passed, null, 2)}\n`))).toBe(true);
  expect(restoreEvidenceFailure(undefined)).toBe('Restore evidence missing');
  const refused: Array<[string, unknown]> = [
    ['status failed', { ...passed, status: 'failed', failures: ['restore'] }],
    ['status missing', { ...passed, status: undefined }],
    ['status Passed', { ...passed, status: 'Passed' }],
    ['a finding', { ...passed, secretScan: { ...passed.secretScan, findings: ['restore stdout'] } }],
    ['findings missing', { ...passed, secretScan: { filesScanned: 9 } }],
    ['findings not an array', { ...passed, secretScan: { findings: 'none' } }],
    ['secretScan missing', { ...passed, secretScan: undefined }],
    ['secretScan null', { ...passed, secretScan: null }],
    ['an array', [passed]],
    ['null', null],
    ['a string', '"passed"'],
    ['malformed JSON', '{"status":"passed",'],
    ['empty file', ''],
  ];
  for (const [label, value] of refused) {
    expect(restorePassed(evidence(value)), label).toBe(false);
    expect(restoreEvidenceFailure(evidence(value)), label).toBe('Restore evidence not passed');
  }
});

test('GATE-008 the real tier fails, never passes, when its suites skip testcases because the container engine is missing', async () => {
  const skipped = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="bun test"><testsuite name="tests/integration/infrastructure/postgres.test.ts" file="tests/integration/infrastructure/postgres.test.ts">',
    '<testcase name="INFRA-001 statis lulus"></testcase>',
    '<testcase name="INFRA-002 image terkunci"><skipped message="Docker tidak tersedia"/></testcase>',
    '</testsuite></testsuites>',
  ].join('\n');
  const real = TIERS.real!;
  const steps = Object.fromEntries(real.steps.map((item) => [item.script, `echo ran > ran-${item.script.replace(/:/g, '-')}.txt`]));
  steps['test:infrastructure'] = 'mkdir -p .local/feature-3 && cp skipped.xml .local/feature-3/infrastructure.xml && cp image.json .local/feature-3/image.json';
  const dir = await tierWorkspace(steps, { 'skipped.xml': skipped, 'image.json': '{ "image": "foundation-postgres:18-pinned" }' });
  const output = lines();
  const code = await runTier({ root: dir, tier: real, log: output.log, env: gateEnv() });
  expect(code).toBe(1);
  const manifest = JSON.parse(await readFile(join(dir, bundlePath('real'), 'manifest.json'), 'utf8')) as TierManifest;
  expect(manifest.tier).toBe('real');
  expect(manifest.status).toBe('failed');
  expect(manifest.steps.map((item) => [item.script, item.status])).toEqual([
    ['test:infrastructure', 'skipped'],
    ['test:database:real', 'not_run'],
    ['test:database:migration', 'not_run'],
    ['test:tooling:real', 'not_run'],
    ['test:readiness:real', 'not_run'],
    ['test:deployment:real', 'not_run'],
    ['test:performance:smoke', 'not_run'],
  ]);
  expect(manifest.steps[0]?.reasons).toEqual([{ code: 'testcase_skipped', path: '.local/feature-3/infrastructure.xml' }]);
  expect(manifest.steps[0]?.leftoverPorts).toEqual([]);
  for (const item of real.steps.slice(1)) expect(await exists(join(dir, `ran-${item.script.replace(/:/g, '-')}.txt`))).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// Added by /test (spec 0010): the tier table, the command line, evidence edges, the stale bundle rule, the sensitive
// value rule, the process group grace, and the JUnit reader on its own.

const evidenceLine = (evidence: EvidenceSpec) =>
  `${evidence.kind} ${evidence.path}${evidence.runner === null ? '' : ` ${evidence.runner}`}${evidence.required ? '' : ' opsional'}`;

test('GATE-004 the fast and security tiers hold the steps, evidence, limit, and grace of Tabel tier and Bukti per langkah', () => {
  // covers: AC-4 (Tabel tier, Bukti per langkah)
  const fast = TIERS.fast!;
  expect([fast.name, fast.script, fast.stepTimeoutMs, fast.stopGraceMs]).toEqual(['fast', 'test:ci', 600_000, 10_000]);
  expect(fast.steps.map((item) => [item.script, item.evidence.map(evidenceLine)])).toEqual([
    ['check:dependencies', []],
    ['test:scenarios', []],
    ['check:test-discovery', []],
    ['check:workflow', []],
    ['api:check', []],
    ['build:frontend', []],
    ['check:frontend:bundle', []],
    ['typecheck:backend', []],
    ['typecheck:contract', []],
    ['typecheck:e2e', []],
    ['typecheck:tooling', []],
    ['build:backend', []],
    ['test:frontend', ['junit .local/feature-4/frontend.xml vitest']],
    ['test:integration', ['junit .local/feature-4/server.xml bun:test']],
    ['test:tooling', ['junit .local/feature-4/tooling.xml bun:test']],
    ['test:gate', ['junit .local/feature-11/gate.xml bun:test']],
    ['test:performance:plan', ['junit .local/feature-12/plan.xml bun:test']],
    // Spec 0012 (*Perubahan gate yang dinamai*, Langkah tier): DEP-001 and DEP-008 after the k6 plan units.
    ['test:deployment:plan', ['junit .local/feature-13/plan.xml bun:test']],
    ['test:e2e', ['junit .local/feature-4/playwright.xml playwright', 'screenshots test-results/ opsional']],
  ]);
  const security = TIERS.security!;
  expect([security.name, security.script, security.stepTimeoutMs, security.stopGraceMs]).toEqual(['security', 'test:ci:security', 600_000, 90_000]);
  expect(security.steps.map((item) => [item.script, item.evidence.map(evidenceLine)])).toEqual([
    ['check:security', ['scanner .local/feature-11/security.json']],
  ]);

  expect(TIER_SCRIPTS).toEqual({ fast: 'test:ci', real: 'test:ci:real', security: 'test:ci:security' });
  for (const name of TIER_NAMES) {
    expect(TIERS[name]?.name, name).toBe(name);
    expect(TIERS[name]?.script, name).toBe(TIER_SCRIPTS[name]);
    expect(tierByName(name), name).toBe(TIERS[name]);
  }
  // Only the three tier names resolve, never another word or an inherited property name.
  for (const name of ['slow', '', 'FAST', 'toString', 'constructor', '__proto__']) expect(tierByName(name), name).toBeUndefined();
  // The fast tier (the Playwright webServer of test:e2e) and the real tier record listeners left on the backend and
  // frontend ports; the security tier starts no server.
  expect(LEFTOVER_PORTS).toEqual({ fast: [8888, 8889], real: [8888, 8889] });
});

test('GATE-004 scripts/gate.ts without a tier, with an unknown tier, or with an extra argument prints the usage, exits 1, and writes no bundle', async () => {
  // covers: AC-4 (Interface surface: bun --no-env-file scripts/gate.ts <tier>)
  // A copy of the scripts runs in a workspace, so even a broken argument check could never run a tier of the repository.
  const dir = await workspace({ 'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: {} }) });
  const scripts = join(import.meta.dir, '../../../scripts');
  await cp(join(scripts, 'gate.ts'), join(dir, 'scripts/gate.ts'));
  await cp(join(scripts, 'lib'), join(dir, 'scripts/lib'), { recursive: true });
  for (const args of [[], ['slow'], ['fast', 'extra'], ['toString']]) {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/gate.ts', ...args], {
      cwd: dir,
      env: gateEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const label = args.join(' ') || '(tanpa argumen)';
    expect(code, label).toBe(1);
    expect(stdout, label).toBe('');
    // Spec 0011 (*Tier kapasitas dan gate*): scripts/gate.ts also accepts the manual capacity tier.
    expect(stderr, label).toBe('Pemakaian: bun --no-env-file scripts/gate.ts <fast|real|security|capacity>\n');
  }
  expect(await exists(join(dir, '.local'))).toBe(false);
}, 30_000);

test('GATE-004 evidence is copied even when the step fails, and an optional folder that is absent adds no reason', async () => {
  // covers: AC-4 (Bukti per langkah: disalin ke bundle sesudahnya, juga ketika langkah gagal)
  const shots: EvidenceSpec = { path: '.local/x/shots/', kind: 'screenshots', runner: null, required: false };
  const dir = await tierWorkspace({ write: `${copy('fixture.xml')} && exit 3` }, { 'fixture.xml': passing });
  const { code, manifest } = await run(dir, tier([step('write', [junit(), shots])]));
  expect(code).toBe(1);
  const [record] = manifest.steps;
  expect(record).toMatchObject({ status: 'failed', exitCode: 3, reasons: [{ code: 'exit_code', path: null }] });
  expect(record?.evidence[0]).toMatchObject({ path: JUNIT, present: true, sha256: sha256(passing), tests: 1, failures: 0 });
  expect(record?.evidence[1]).toEqual({ path: '.local/x/shots/', kind: 'screenshots', required: false, present: false, files: [] });
  expect(await bundleFiles(dir)).toEqual([JUNIT, 'manifest.json']);
  expect(sha256(await readFile(join(dir, bundlePath('fast'), JUNIT)))).toBe(sha256(passing));
});

test('GATE-004 a screenshots path that is a file is evidence_invalid, and a text file inside the folder with a sensitive value stays out', async () => {
  // covers: AC-4, AC-8 (Bukti per langkah, Value sourcing Nilai sensitif)
  const shots: EvidenceSpec = { path: '.local/x/shots/', kind: 'screenshots', runner: null, required: false };
  const notFolder = await tierWorkspace({ write: 'mkdir -p .local/x && echo x > .local/x/shots' });
  const first = await run(notFolder, tier([step('write', [shots])]));
  expect(first.manifest.steps[0]).toMatchObject({ status: 'failed', reasons: [{ code: 'evidence_invalid', path: '.local/x/shots/' }] });

  const secret = `shot${randomBytes(12).toString('hex')}`;
  const png = new Uint8Array([137, 80, 78, 71, 1, 2]);
  const dir = await tierWorkspace(
    { write: 'mkdir -p .local/x/shots && cp a.png .local/x/shots/a.png && cp data.json .local/x/shots/data.json' },
    { 'data.json': JSON.stringify({ attachment: secret }) },
  );
  await writeFile(join(dir, 'a.png'), png);
  const { code, manifest, text, output } = await run(dir, tier([step('write', [shots])]), { FOUNDATION_SHOT_PROBE: secret });
  expect(code).toBe(1);
  const [record] = manifest.steps;
  expect(record?.reasons).toEqual([{ code: 'sensitive_value', path: '.local/x/shots/data.json' }]);
  expect(record?.evidence[0]?.files).toEqual([{ path: '.local/x/shots/a.png', sha256: sha256(png) }]);
  expect(await bundleFiles(dir)).toEqual(['.local/x/shots/a.png', 'manifest.json']);
  expect(output.out.join('\n')).toContain('.local/x/shots/data.json memuat nilai variable sensitif FOUNDATION_SHOT_PROBE');
  expect(output.out.join('\n')).not.toContain(secret);
  expect(text).not.toContain(secret);
});

test('GATE-004 the old bundle and a stale temporary bundle of the tier are removed before it runs, and other tiers stay', async () => {
  // covers: AC-4 (key invariant 2: bukti lama tidak dapat terbaca sebagai bukti baru)
  const evidence = '.local/feature-11/evidence';
  const dir = await tierWorkspace({ ok: 'exit 0' }, {
    [`${evidence}/fast/.local/x/j.xml`]: passing,
    [`${evidence}/fast/manifest.json`]: '{ "old": true }',
    [`${evidence}/.fast-0123456789ab/manifest.json`]: '{}',
    [`${evidence}/real/manifest.json`]: '{ "keep": true }',
    [`${evidence}/.real-0123456789ab/manifest.json`]: '{}',
  });
  const { code, manifest } = await run(dir, tier([step('ok')]));
  expect(code).toBe(0);
  expect(manifest.steps.map((item) => item.status)).toEqual(['passed']);
  expect(await bundleFiles(dir)).toEqual(['manifest.json']);
  const left = (await readdir(join(dir, evidence))).sort();
  expect(left).toEqual(['.real-0123456789ab', 'fast', 'real']);
  expect(await readFile(join(dir, evidence, 'real/manifest.json'), 'utf8')).toBe('{ "keep": true }');
});

test('GATE-004 the step environment is the allow list only, and sensitive values are sensitive names of at least 8 characters', () => {
  // covers: AC-4, AC-8 (Environment langkah, Value sourcing Nilai sensitif)
  expect([...STEP_ENV_KEYS]).toEqual([
    'PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI',
    'PLAYWRIGHT_BROWSERS_PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
  ]);
  const source: Record<string, string | undefined> = {
    PATH: '/usr/bin', HOME: '/home/x', CI: 'true', DOCKER_HOST: 'unix:///x.sock', LANG: undefined,
    DATABASE_URL: 'postgres://u:p@h/d', GITHUB_TOKEN: 'ghs_xxxxxxxx', FOUNDATION_X: 'value-long', NODE_OPTIONS: '--inspect', path: '/lower',
  };
  expect(stepEnvironment(source)).toEqual({ PATH: '/usr/bin', HOME: '/home/x', CI: 'true', DOCKER_HOST: 'unix:///x.sock' });

  const sensitive = {
    GH_TOKEN: 'aaaaaaaa', DB_PASSWORD: 'bbbbbbbb', CLIENT_SECRET: 'cccccccc', PGPASSFILE: 'dddddddd', API_KEY: 'eeeeeeee',
    SENTRY_DSN: 'ffffffff', AWS_CREDENTIALS: 'gggggggg', DATABASE_URL: 'postgres://h', FOUNDATION_ANY: 'iiiiiiii', db_token: 'jjjjjjjj',
  };
  const ignored = {
    SHORT_TOKEN: '1234567', FOUNDATION_SHORT: 'abc', PLAIN_NAME: 'a long plain value', HOME: '/Users/someone/far/away', EMPTY_SECRET: '',
    NOT_SET_SECRET: undefined,
  };
  const found = sensitiveValues({ ...sensitive, ...ignored });
  expect(found.map((item) => item.name).sort()).toEqual(Object.keys(sensitive).sort());
  for (const item of found) expect(item.value).toBe(sensitive[item.name as keyof typeof sensitive]);
});

test('GATE-004 runProcessGroup waits graceMs after SIGTERM before SIGKILL, and 5000 ms when the option is absent', async () => {
  // covers: AC-4 (runProcessGroup mendapat opsi masa tenggang dengan nilai bawaan 5.000 ms)
  // The script and its children ignore SIGTERM, so only SIGKILL after the grace ends the group.
  const dir = await workspace({ 'stubborn.sh': "trap '' TERM\nwhile :; do sleep 1; done\n" });
  const options = { cwd: dir, env: gateEnv(), timeoutMs: 300, output: 'pipe' as const };

  let started = performance.now();
  const short = await runProcessGroup(['sh', 'stubborn.sh'], { ...options, graceMs: 700 });
  const shortMs = performance.now() - started;
  expect(short).toMatchObject({ code: null, timedOut: true, aborted: false });
  expect(short).not.toHaveProperty('outputExceeded');
  expect(shortMs).toBeGreaterThanOrEqual(1_000);
  expect(shortMs).toBeLessThan(4_500);

  started = performance.now();
  const standard = await runProcessGroup(['sh', 'stubborn.sh'], options);
  const standardMs = performance.now() - started;
  expect(standard).toMatchObject({ code: null, timedOut: true, aborted: false });
  expect(standardMs).toBeGreaterThanOrEqual(5_000);
  expect(standardMs).toBeLessThan(15_000);
}, 40_000);

// ---------------------------------------------------------------------------------------------------------------
// *Pembaca JUnit* and *Judul lengkap* on their own: the reader the tier runner and the report share.

const nested = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuites name="run" tests="99" failures="0" errors="0" skipped="0">',
  '<testsuite name="a.test.ts" file="tests/a.test.ts" tests="99">',
  '<testcase name="AAA-001 top"/>',
  '<testsuite name="AAA-002 outer">',
  '<testcase name="direct"><error message="boom"/></testcase>',
  '<testsuite name="inner"><testcase name="leaf"><failure message="x"/></testcase></testsuite>',
  '</testsuite>',
  '<testcase name="skip"><skipped message="  "/></testcase>',
  '<testcase name="both"><failure/><skipped message="ignored"/></testcase>',
  '</testsuite>',
  '<testsuite name="b.test.ts" file="tests/b.test.ts"><testcase name="BBB-001 alone"><skipped message="first"/><skipped message="second"/></testcase></testsuite>',
  '</testsuites>',
].join('\n');

test('GATE-004 the JUnit reader builds the full title per runner and counts by element, never by summary attributes', () => {
  // covers: AC-4 (Pembaca JUnit), AC-6 (Judul lengkap)
  const document = parseJUnit(nested);
  expect(document.suites.map((suite) => suite.attributes['file'])).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  const bun = junitResults(document, 'bun:test');
  expect(bun.map((item) => [item.title, item.outcome, item.skipMessage, item.fileSuite['file']])).toEqual([
    ['AAA-001 top', 'passed', null, 'tests/a.test.ts'],
    ['skip', 'skipped', null, 'tests/a.test.ts'],
    ['both', 'failed', 'ignored', 'tests/a.test.ts'],
    ['AAA-002 outer > direct', 'error', null, 'tests/a.test.ts'],
    ['AAA-002 outer > inner > leaf', 'failed', null, 'tests/a.test.ts'],
    ['BBB-001 alone', 'skipped', 'first', 'tests/b.test.ts'],
  ]);
  // Vitest and Playwright already write the whole title in the testcase name, so nested suites add nothing.
  for (const runner of ['vitest', 'playwright'] as const) {
    expect(junitResults(document, runner).map((item) => item.title)).toEqual(['AAA-001 top', 'skip', 'both', 'direct', 'leaf', 'BBB-001 alone']);
  }
  // A failure wins over a skip on the same testcase; the summary attributes (tests="99") are never read.
  expect(junitCounts(document)).toEqual({ tests: 6, failures: 2, errors: 1, skipped: 2 });
});

test('GATE-004 the JUnit reader accepts a BOM, a testsuite root, comments, instructions, quoted >, single quotes, and references', () => {
  // covers: AC-4 (Pembaca JUnit: deklarasi, komentar, CDATA, atribut berkutip yang memuat >, entity standar, referensi numerik)
  const xml = [
    '﻿<?xml version="1.0"?><!-- before the root -->',
    "<testsuite name='a&gt;b.spec.ts' file=\"x > y\">",
    '<properties><property name="k" value="&quot;v&apos;"/></properties>',
    '<!-- <testcase name="commented"/> -->',
    '<?pi inside?>',
    '<testcase name="&#65;&#x42;C &amp; &lt;D&gt;"><![CDATA[<failure/>]]></testcase>',
    '<system-err>text &lt; &#x3C; <![CDATA[</testsuite><testcase name="fake">]]></system-err>',
    '</testsuite>',
    '<!-- after the root -->',
  ].join('\n');
  const document = parseJUnit(xml);
  expect(document.suites).toHaveLength(1);
  expect(document.suites[0]?.attributes).toEqual({ name: 'a>b.spec.ts', file: 'x > y' });
  expect(junitResults(document, 'playwright').map((item) => [item.title, item.outcome])).toEqual([['ABC & <D>', 'passed']]);
  expect(junitCounts(document)).toEqual({ tests: 1, failures: 0, errors: 0, skipped: 0 });
});

test('GATE-004 the JUnit reader rejects anything outside Pembaca JUnit with JUnitError, never a passing result', () => {
  // covers: AC-4 (Pembaca JUnit: file tidak well formed, elemen di luar daftar, ukuran di atas 50 MB)
  const suite = (body: string) => `<testsuites><testsuite name="a" file="a">${body}</testsuite></testsuites>`;
  const rejected: Array<[string, string]> = [
    ['empty', ''],
    ['whitespace only', ' \n '],
    ['text outside the root', `text${suite('')}`],
    ['second root', `${suite('')}${suite('')}`],
    ['CDATA outside the root', `<![CDATA[x]]>${suite('')}`],
    ['mismatched end tag', '<testsuites><testsuite name="a"></testsuites>'],
    ['end tag without a start', '</testsuites>'],
    ['element inside text only content', suite('<testcase name="t"><failure><skipped/></failure></testcase>')],
    ['property outside properties', '<testsuites><property name="x" value="y"/></testsuites>'],
    ['testsuites inside testsuite', '<testsuite name="a"><testsuites/></testsuite>'],
    ['testcase at the root', '<testcase name="t"/>'],
    ['unknown element', suite('<testcase name="t"><attachment/></testcase>')],
    ['attribute value with <', suite('<testcase name="a<b"/>')],
    ['unquoted attribute', suite('<testcase name=t/>')],
    ['attribute without value', suite('<testcase name/>')],
    ['duplicate attribute', suite('<testcase name="a" name="b"/>')],
    ['no space between attributes', suite('<testcase name="a"classname="b"/>')],
    ['bare ampersand', suite('<testcase name="a & b"/>')],
    ['unknown entity', suite('<testcase name="&nbsp;"/>')],
    ['unknown entity in text', '<testsuites>&bogus;</testsuites>'],
    ['character reference zero', suite('<testcase name="&#0;"/>')],
    ['character reference above Unicode', suite('<testcase name="&#x110000;"/>')],
    ['DOCTYPE', `<!DOCTYPE testsuites>${suite('')}`],
    ['unterminated comment', '<testsuites><!-- x </testsuites>'],
    ['unterminated CDATA', suite('<testcase name="t"><system-out><![CDATA[x</system-out></testcase>')],
    ['unterminated text element', '<testsuites><testsuite name="a"><system-out>x'],
    ['unterminated processing instruction', '<?xml version="1.0"'],
    ['unterminated tag', '<testsuites name="a"'],
    ['unclosed root', '<testsuites><testsuite name="a"/>'],
  ];
  for (const [label, xml] of rejected) expect(() => parseJUnit(xml), label).toThrow(JUnitError);
  // The size limit applies to the text itself, before any parsing.
  expect(() => parseJUnit(`<testsuites>${' '.repeat(EVIDENCE_TEXT_LIMIT)}</testsuites>`)).toThrow(JUnitError);
});

// ---------------------------------------------------------------------------------------------------------------
// Added by the review fixes (spec 0010): listeners left after a stopped step, escaped sensitive values, and the sensitive
// value check on every file of a folder.

test('GATE-004 after a stopped step the gate records the PIDs still listening on the tier ports, and nothing for a step that ended itself', async () => {
  // covers: AC-4 (pada batas waktu atau sinyal gate mencatat listener yang masih tersisa pada port tier)
  // A listener of this test process stands in for a server the stopped step left behind, outside the step group.
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  try {
    const dir = await tierWorkspace({ hang: 'exec sleep 60', ok: 'exit 0', fail: 'exit 3' });
    const output = lines();
    const stopped = tier([step('hang')], { stepTimeoutMs: 1_000, stopGraceMs: 2_000 });
    // Port 0 is not a valid port, so the reader fails for it: the gate prints that and goes on.
    expect(await runTier({ root: dir, tier: stopped, log: output.log, env: gateEnv(), leftoverPorts: [server.port, 0] })).toBe(1);
    const manifest = JSON.parse(await readFile(join(dir, bundlePath('fast'), 'manifest.json'), 'utf8')) as TierManifest;
    expect(manifest.steps[0]).toMatchObject({ status: 'failed', timedOut: true, leftoverPorts: [process.pid] });
    expect(output.out).toContain(`gate fast:   listener tersisa pada port ${server.port}: PID ${process.pid}`);
    expect(output.out).toContain('gate fast:   listener pada port 0 tidak dapat diperiksa');

    // A step that ended on its own, passed or failed, was not stopped, so the same listener is not recorded.
    for (const script of ['ok', 'fail']) {
      const quiet = lines();
      await runTier({ root: dir, tier: tier([step(script)]), log: quiet.log, env: gateEnv(), leftoverPorts: [server.port] });
      const own = JSON.parse(await readFile(join(dir, bundlePath('fast'), 'manifest.json'), 'utf8')) as TierManifest;
      expect(own.steps[0]?.leftoverPorts, script).toEqual([]);
      expect(quiet.out.some((line) => line.includes('listener')), script).toBe(false);
    }
  } finally {
    server.stop(true);
  }
}, 30_000);

test('GATE-004 a sensitive value is found as is, escaped for XML or JSON, and percent encoded', async () => {
  // covers: AC-8 (file bukti teks diperiksa terhadap nilai variable environment sensitif milik proses gate)
  const secret = `a&b<c>d"e'f\\g h${randomBytes(6).toString('hex')}`;
  const forms = sensitiveForms(secret);
  expect(forms).toContain(secret);
  expect(forms).toContain(secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'));
  expect(forms).toContain(JSON.stringify(secret).slice(1, -1));
  expect(forms).toContain(encodeURIComponent(secret));
  expect(sensitiveForms('line\nbreak')).toContain('line&#10;break');

  const escapedXml = junitXml(`<testcase name="FIX-001 a"><failure message="${forms[2]}"/></testcase>`);
  const escapedJson = JSON.stringify({ findings: [], note: secret });
  for (const [label, file, kind] of [['xml', escapedXml, 'junit'], ['json', escapedJson, 'scan']] as const) {
    const evidence = kind === 'junit' ? junit() : json(JUNIT.replace('.xml', '.json'), 'scan');
    const dir = await tierWorkspace({ write: copy('fixture', evidence.path) }, { fixture: file });
    const { manifest, text, output } = await run(dir, tier([step('write', [evidence])]), { GATE_ESCAPED_SECRET: secret });
    expect(manifest.steps[0]?.reasons, label).toContainEqual({ code: 'sensitive_value', path: evidence.path });
    expect(output.out.join('\n'), label).toContain(`${evidence.path} memuat nilai variable sensitif GATE_ESCAPED_SECRET`);
    expect(text, label).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(await bundleFiles(dir), label).toEqual(['manifest.json']);
  }
});

test('GATE-004 every file of a screenshots folder is checked for sensitive values, not only .xml and .json', async () => {
  // covers: AC-8 (file bukti runner diperiksa sebelum disalin ke bundle)
  const secret = `context${randomBytes(12).toString('hex')}`;
  const shots: EvidenceSpec = { path: '.local/x/shots/', kind: 'screenshots', runner: null, required: false };
  const dir = await tierWorkspace(
    { write: 'mkdir -p .local/x/shots && cp context.md .local/x/shots/error-context.md && cp note.txt .local/x/shots/note.txt' },
    { 'context.md': `# Page\n\n- text: ${secret}\n`, 'note.txt': 'tanpa nilai sensitif\n' },
  );
  const { manifest, text } = await run(dir, tier([step('write', [shots])]), { FOUNDATION_CONTEXT_PROBE: secret });
  expect(manifest.steps[0]?.reasons).toEqual([{ code: 'sensitive_value', path: '.local/x/shots/error-context.md' }]);
  expect(manifest.steps[0]?.evidence[0]?.files).toEqual([{ path: '.local/x/shots/note.txt', sha256: sha256('tanpa nilai sensitif\n') }]);
  expect(await bundleFiles(dir)).toEqual(['.local/x/shots/note.txt', 'manifest.json']);
  expect(text).not.toContain(secret);
});
