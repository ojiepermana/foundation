import { afterEach, expect, test } from 'bun:test';
import { cp, lstat, readdir, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  actionPins,
  checkCapacityWorkflow,
  runWorkflowCheck,
  type CapacityWorkflowContext,
} from '../../../scripts/check-workflow.ts';
import {
  bundlePath,
  CAPACITY_TIER,
  CAPACITY_TIER_NAME,
  LEFTOVER_PORTS,
  PERFORMANCE_PROFILES,
  performanceEvidenceValid,
  performanceProfile,
  REASON_CODES,
  runTier,
  sha256,
  sourceTree,
  TIER_NAMES,
  TIER_SCRIPTS,
  tierByName,
  TIERS,
  tierSteps,
  type CiIdentity,
  type EvidenceRecord,
  type EvidenceSpec,
  type StepRecord,
  type Tier,
  type TierManifest,
} from '../../../scripts/lib/gate.ts';
import {
  buildCapacityReport,
  buildReport,
  CAPACITY_OUT_OF_SCOPE,
  CAPACITY_RELEASE_EVENT,
  CAPACITY_REPORT_JSON,
  CAPACITY_REPORT_MD,
  capacityReleaseCandidate,
  capacityScenario,
  capacityStatus,
  OUT_OF_SCOPE,
  profileSuffix,
  RELEASE_EVENT,
  renderCapacityMarkdown,
  renderMarkdown,
  runCapacityReport,
  runReport,
  type CapacityReport,
  type GateReport,
  type ScenarioResult,
} from '../../../scripts/lib/gate-report.ts';
import { EVIDENCE_TEXT_LIMIT } from '../../../scripts/lib/junit.ts';
import { runProcessGroup, type ProcessGroupOptions } from '../../../scripts/lib/process-group.ts';
import { groupAlive } from '../../../scripts/lib/process-identity.ts';
import { validateRegistries } from '../../../scripts/lib/scenario-registry.ts';
import { PROFILE_NAMES } from '../../performance/helpers/plan.ts';
import { lines, removeWorkspaces, workspace, writeFiles } from './workspace.ts';

// PERF-008 (spec 0011, AC-9, AC-10, and AC-6), built in steps 2, 3, and 5 of the Build plan. Step 2: the `onOutput`
// option of `runProcessGroup` (*Perubahan gate yang dinamai*). Every chunk reaches the callback in arrival order with a
// time that never goes down, nothing is collected, the option refuses `outputLimitBytes` and `output: 'inherit'` before
// the process starts, and timeout and abort still stop the whole group. Step 3: the k6 smoke as the last step of the
// real tier, the evidence kinds `performance` and `data`, the `performance` field and section of the per push report,
// the new `outOfScope`, the column *Test dan profil*, and no `scripts/` file with the word the INFRA-001 pattern refuses.
// Step 5: the capacity tier outside `TIERS`, the registry rule against mixed tiers, the per push gate without the
// capacity scenarios, `test:report:capacity` with its binding and release candidate, `capacity.yml` with its allow list
// and the folder rule, and the strings of *Dokumen yang diperbarui*. Every fixture is written at runtime in a `mkdtemp`
// folder.

afterEach(removeWorkspaces);

type Chunk = { stream: 'stdout' | 'stderr'; text: string; at: number };

const env = () => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin' });
const options = (dir: string, chunks: Chunk[], extra: Partial<ProcessGroupOptions> = {}): ProcessGroupOptions => ({
  cwd: dir,
  env: env(),
  timeoutMs: 30_000,
  output: 'pipe',
  onOutput: (stream, chunk, at) => chunks.push({ stream, text: chunk.toString('utf8'), at }),
  ...extra,
});
const exists = (path: string) => stat(path).then(() => true, () => false);

test('PERF-008 onOutput hands every chunk over in arrival order with a time that never goes down, and collects nothing', async () => {
  // covers: AC-9 (opsi onOutput runProcessGroup), AC-6 (setiap potongan diterima saat tiba dengan waktu host)
  const dir = await workspace({ 'order.sh': "printf a\nsleep 0.2\nprintf b >&2\nsleep 0.2\nprintf c\nsleep 0.2\nprintf d >&2\n" });
  const chunks: Chunk[] = [];
  const started = Date.now();
  const result = await runProcessGroup(['sh', 'order.sh'], options(dir, chunks));
  const finished = Date.now();
  expect(result).toEqual({ code: 0, timedOut: false, aborted: false, stdout: '', stderr: '' });
  expect(chunks.map((chunk) => [chunk.stream, chunk.text])).toEqual([['stdout', 'a'], ['stderr', 'b'], ['stdout', 'c'], ['stderr', 'd']]);
  for (let index = 1; index < chunks.length; index += 1) expect(chunks[index]!.at).toBeGreaterThanOrEqual(chunks[index - 1]!.at);
  expect(chunks[0]!.at).toBeGreaterThanOrEqual(started);
  expect(chunks.at(-1)!.at).toBeLessThanOrEqual(finished);
  // The waits between the writes show in the arrival times.
  expect(chunks.at(-1)!.at - chunks[0]!.at).toBeGreaterThanOrEqual(400);

  // A large output arrives whole, in order, over many chunks; the result still holds nothing.
  const big = await workspace({ 'big.sh': "head -c 300000 /dev/zero | tr '\\0' x\n" });
  const parts: Chunk[] = [];
  const flooded = await runProcessGroup(['sh', 'big.sh'], options(big, parts));
  expect([flooded.code, flooded.stdout, flooded.stderr]).toEqual([0, '', '']);
  expect(flooded).not.toHaveProperty('outputExceeded');
  expect(parts.every((chunk) => chunk.stream === 'stdout')).toBe(true);
  expect(parts.map((chunk) => chunk.text).join('')).toBe('x'.repeat(300_000));
});

test('PERF-008 onOutput combined with outputLimitBytes, or without output pipe, throws before the process starts', async () => {
  // covers: AC-9 (galat bila digabung dengan outputLimitBytes)
  const dir = await workspace({ 'touch.sh': 'touch started\n' });
  const chunks: Chunk[] = [];
  await expect(runProcessGroup(['sh', 'touch.sh'], options(dir, chunks, { outputLimitBytes: 4_096 }))).rejects.toThrow('onOutput cannot be combined with outputLimitBytes');
  await expect(runProcessGroup(['sh', 'touch.sh'], options(dir, chunks, { output: 'inherit' }))).rejects.toThrow('onOutput needs output: pipe');
  expect(await exists(join(dir, 'started'))).toBe(false);
  expect(chunks).toEqual([]);
  // Without onOutput the same call collects the output as before.
  const collected = await runProcessGroup(['sh', '-c', 'printf abc; printf err >&2'], { cwd: dir, env: env(), timeoutMs: 30_000, output: 'pipe' });
  expect(collected).toEqual({ code: 0, timedOut: false, aborted: false, stdout: 'abc', stderr: 'err' });
});

test('PERF-008 with onOutput a timeout and an abort still stop the whole group, after the chunks that came before', async () => {
  // covers: AC-9 (penghentian grup saat batas waktu atau abort tetap sama)
  const script = "echo $$ > leader.pid\n(while :; do sleep 1; done) &\nwhile :; do printf 'tick\\n'; sleep 0.1; done\n";
  const dir = await workspace({ 'ticks.sh': script });
  const chunks: Chunk[] = [];
  const timed = await runProcessGroup(['sh', 'ticks.sh'], options(dir, chunks, { timeoutMs: 700, graceMs: 1_000 }));
  const timedAt = Date.now();
  expect(timed).toMatchObject({ code: null, timedOut: true, aborted: false, stdout: '', stderr: '' });
  expect(chunks.filter((chunk) => chunk.text.includes('tick')).length).toBeGreaterThanOrEqual(2);
  expect(chunks.every((chunk) => chunk.at <= timedAt)).toBe(true);
  const timedLeader = Number((await readFile(join(dir, 'leader.pid'), 'utf8')).trim());
  expect(await groupAlive(timedLeader)).toBe(false);

  const abortDir = await workspace({ 'ticks.sh': script });
  const controller = new AbortController();
  const seen: Chunk[] = [];
  const aborted = await runProcessGroup(
    ['sh', 'ticks.sh'],
    options(abortDir, seen, {
      signal: controller.signal,
      graceMs: 1_000,
      onOutput: (stream, chunk, at) => {
        seen.push({ stream, text: chunk.toString('utf8'), at });
        if (seen.length === 3) controller.abort();
      },
    }),
  );
  expect(aborted).toMatchObject({ code: null, timedOut: false, aborted: true, stdout: '', stderr: '' });
  expect(seen.length).toBeGreaterThanOrEqual(3);
  const abortedLeader = Number((await readFile(join(abortDir, 'leader.pid'), 'utf8')).trim());
  expect(await groupAlive(abortedLeader)).toBe(false);
}, 30_000);

// ---------------------------------------------------------------------------------------------------------------
// Step 3 of the Build plan: the per push gate.

const SMOKE = 'test:performance:smoke';
const RESULT = '.local/feature-12/smoke/result.json';
const SUMMARY = '.local/feature-12/smoke/k6/summary.json';
const OBSERVATION = '.local/feature-12/smoke/observation.json';
const SCAN = '.local/feature-12/smoke/artifact-scan.json';

const spec = (path: string, kind: EvidenceSpec['kind']): EvidenceSpec => ({ path, kind, runner: null, required: true });

/** The gate process environment of a fixture run: enough to start Bun and the shell, plus `extra`. */
function gateEnv(extra: Record<string, string> = {}): Record<string, string> {
  const values: Record<string, string> = { PATH: process.env['PATH'] ?? '', ...extra };
  for (const name of ['HOME', 'TMPDIR']) if (process.env[name] !== undefined) values[name] = process.env[name]!;
  return values;
}

/** A workspace whose `package.json` runs `sh ./steps/<name>.sh` for every entry of `steps`. */
async function tierWorkspace(steps: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
  const scripts = Object.fromEntries(Object.keys(steps).map((name) => [name, `sh ./steps/${name}.sh`]));
  const stepFiles = Object.fromEntries(Object.entries(steps).map(([name, body]) => [`steps/${name}.sh`, `${body}\n`]));
  return workspace({ 'package.json': JSON.stringify({ name: 'fixture', private: true, scripts }), ...stepFiles, ...files });
}

function realTier(script: string, evidence: EvidenceSpec[]): Tier {
  return { name: 'real', script: 'test:ci:real', steps: [{ script, evidence }], stepTimeoutMs: 30_000, stopGraceMs: 5_000 };
}

async function runReal(dir: string, fixture: Tier, extra: Record<string, string> = {}) {
  const output = lines();
  const code = await runTier({ root: dir, tier: fixture, log: output.log, env: gateEnv(extra) });
  const text = await readFile(join(dir, bundlePath('real'), 'manifest.json'), 'utf8');
  return { code, output, text, manifest: JSON.parse(text) as TierManifest };
}

const reasonsOf = (manifest: TierManifest) => manifest.steps[0]!.reasons.map((reason) => `${reason.code}${reason.path === null ? '' : ` ${reason.path}`}`);

test('PERF-008 the fast tier runs test:performance:plan after test:gate, the real tier ends with the smoke and its four files, and TIER_NAMES stays three', () => {
  // covers: AC-9 (Tier kapasitas dan gate, baris fast dan real; TIER_NAMES tetap)
  expect(TIER_NAMES).toEqual(['fast', 'real', 'security']);
  const fast = TIERS.fast!.steps.map((step) => step.script);
  expect(fast.indexOf('test:performance:plan')).toBe(fast.indexOf('test:gate') + 1);
  // Spec 0012 puts test:deployment:plan between the k6 plan units and test:e2e.
  expect(fast.indexOf('test:deployment:plan')).toBe(fast.indexOf('test:performance:plan') + 1);
  expect(fast.indexOf('test:e2e')).toBe(fast.indexOf('test:performance:plan') + 2);
  expect(TIERS.fast!.steps.find((step) => step.script === 'test:performance:plan')?.evidence).toEqual([
    { path: '.local/feature-12/plan.xml', kind: 'junit', runner: 'bun:test', required: true },
  ]);
  const real = TIERS.real!;
  expect([real.stepTimeoutMs, real.stopGraceMs]).toEqual([1_500_000, 180_000]);
  // Spec 0012 puts test:deployment:real between test:readiness:real and the smoke, which stays last.
  expect(real.steps.at(-3)?.script).toBe('test:readiness:real');
  expect(real.steps.at(-2)?.script).toBe('test:deployment:real');
  expect(real.steps.at(-1)).toEqual({
    script: SMOKE,
    evidence: [spec(RESULT, 'performance'), spec(SUMMARY, 'data'), spec(OBSERVATION, 'data'), spec(SCAN, 'scan')],
  });
  // The smoke is a step of the real tier only.
  expect(TIER_NAMES.filter((name) => TIERS[name]!.steps.some((step) => step.script === SMOKE))).toEqual(['real']);

  // The six profile names of the gate are the six of plan.ts, and only test:performance:<one of them> is a profile.
  expect(PERFORMANCE_PROFILES).toEqual(PROFILE_NAMES);
  for (const name of PROFILE_NAMES) expect(performanceProfile(`test:performance:${name}`)).toBe(name);
  for (const script of ['test:performance:plan', 'test:performance:', 'test:performance:smoke:x', 'x:test:performance:smoke', 'test:performance:Smoke', 'test:ci:real']) {
    expect(performanceProfile(script), script).toBeNull();
  }
});

test('PERF-008 performance evidence needs schema 1, the step profile, and passed or failed; failed after exit 0 is evidence_invalid', async () => {
  // covers: AC-9 (Jenis bukti performance: status bukan passed pada exit 0 gagal evidence_invalid)
  const result = (fields: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, profile: 'smoke', status: 'passed', ...fields });
  const cases: Array<[string, string | null, number, string[]]> = [
    ['passed on exit 0', result(), 0, []],
    ['failed on exit 0', result({ status: 'failed' }), 0, [`evidence_invalid ${RESULT}`]],
    ['failed on exit 1', result({ status: 'failed' }), 1, ['exit_code']],
    ['passed on exit 1', result(), 1, ['exit_code']],
    ['schema 2', result({ schema: 2 }), 0, [`evidence_invalid ${RESULT}`]],
    ['schema as text', result({ schema: '1' }), 0, [`evidence_invalid ${RESULT}`]],
    ['another profile', result({ profile: 'load' }), 0, [`evidence_invalid ${RESULT}`]],
    ['unknown status', result({ status: 'incomplete' }), 0, [`evidence_invalid ${RESULT}`]],
    ['not an object', '[]', 0, [`evidence_invalid ${RESULT}`]],
    ['broken', '{', 0, [`evidence_invalid ${RESULT}`]],
    ['missing', null, 0, [`evidence_missing ${RESULT}`]],
  ];
  for (const [label, text, exit, expected] of cases) {
    const body = [`mkdir -p ${dirname(RESULT)}`, text === null ? 'true' : `cp result.json ${RESULT}`, `exit ${exit}`].join(' && ');
    const dir = await tierWorkspace({ [SMOKE]: body }, text === null ? {} : { 'result.json': text });
    const { code, manifest } = await runReal(dir, realTier(SMOKE, [spec(RESULT, 'performance')]));
    expect(reasonsOf(manifest), label).toEqual(expected);
    expect(manifest.steps[0]!.status, label).toBe(expected.length === 0 ? 'passed' : 'failed');
    expect(code, label).toBe(expected.length === 0 ? 0 : 1);
    // The file is copied and hashed whenever it is a readable regular file, as for every JSON evidence.
    expect(manifest.steps[0]!.evidence[0]).toMatchObject({ path: RESULT, kind: 'performance', present: text !== null, sha256: text === null ? null : sha256(text) });
  }

  // A step script that is not a profile can never carry valid performance evidence.
  const plan = await tierWorkspace({ 'test:performance:plan': `mkdir -p .local/x && cp result.json .local/x/result.json` }, {
    'result.json': JSON.stringify({ schema: 1, profile: 'plan', status: 'passed' }),
  });
  const { manifest } = await runReal(plan, realTier('test:performance:plan', [spec('.local/x/result.json', 'performance')]));
  expect(reasonsOf(manifest)).toEqual(['evidence_invalid .local/x/result.json']);

  // A step stopped by a signal or a timeout has no exit code; failed is then the expected status.
  const valid = { schema: 1, profile: 'smoke', status: 'failed' };
  expect(performanceEvidenceValid(valid, SMOKE, null)).toBe(true);
  expect(performanceEvidenceValid(valid, SMOKE, 0)).toBe(false);
  expect(performanceEvidenceValid({ ...valid, status: 'passed' }, 'test:performance:load', 0)).toBe(false);
}, 60_000);

test('PERF-008 data evidence must be a readable JSON object up to 50 MB, and every new kind with a sensitive value fails and stays out of the bundle', async () => {
  // covers: AC-9 (Jenis bukti data), AC-10 (nilai sensitif seperti bukti teks lain)
  const passed = JSON.stringify({ schema: 1, profile: 'smoke', status: 'passed' });
  const files = (summary: string, observation: string) => ({ 'result.json': passed, 'summary.json': summary, 'observation.json': observation, 'scan.json': '{ "findings": [] }' });
  const body = [
    `mkdir -p ${dirname(SUMMARY)}`,
    `cp result.json ${RESULT}`,
    `cp summary.json ${SUMMARY}`,
    `cp observation.json ${OBSERVATION}`,
    `cp scan.json ${SCAN}`,
  ].join(' && ');
  const smoke = realTier(SMOKE, TIERS.real!.steps.at(-1)!.evidence as EvidenceSpec[]);
  const cases: Array<[string, string, string, string[]]> = [
    ['both objects', '{ "metrics": {} }', '{ "samples": {} }', []],
    ['summary not an object', '[1, 2]', '{}', [`evidence_invalid ${SUMMARY}`]],
    ['observation broken', '{}', '{ "samples": ', [`evidence_invalid ${OBSERVATION}`]],
    ['summary as text', '"summary"', '{}', [`evidence_invalid ${SUMMARY}`]],
  ];
  for (const [label, summary, observation, expected] of cases) {
    const dir = await tierWorkspace({ [SMOKE]: body }, files(summary, observation));
    const { manifest } = await runReal(dir, smoke);
    expect(reasonsOf(manifest), label).toEqual(expected);
    expect(manifest.steps[0]!.evidence.map((item) => [item.path, item.kind, item.present, item.sha256 !== null]), label).toEqual([
      [RESULT, 'performance', true, true],
      [SUMMARY, 'data', true, true],
      [OBSERVATION, 'data', true, true],
      [SCAN, 'scan', true, true],
    ]);
  }

  // A sparse file one byte above 50 MB: the size alone rejects it, and nothing of it is copied.
  const big = await tierWorkspace({ [SMOKE]: body.replace(`cp observation.json ${OBSERVATION}`, `mv big.json ${OBSERVATION}`) }, { ...files('{}', '{}'), 'big.json': '' });
  await truncate(join(big, 'big.json'), EVIDENCE_TEXT_LIMIT + 1);
  const large = await runReal(big, smoke);
  expect(reasonsOf(large.manifest)).toEqual([`evidence_invalid ${OBSERVATION}`]);
  expect(large.manifest.steps[0]!.evidence[2]).toMatchObject({ present: true, sha256: null });
  expect(await stat(join(big, bundlePath('real'), OBSERVATION)).then(() => true, () => false)).toBe(false);

  // A sensitive value of the gate process, as is or JSON escaped, fails the file and keeps it out of the bundle.
  const secret = `perf"${'s'.repeat(4)}${Date.now().toString(16)}`;
  const leaking = await tierWorkspace({ [SMOKE]: body }, {
    ...files(JSON.stringify({ setup_data: { note: secret } }), '{}'),
    'result.json': JSON.stringify({ schema: 1, profile: 'smoke', status: 'passed', detail: secret }),
  });
  const { manifest, text, output } = await runReal(leaking, smoke, { FOUNDATION_PERF_PROBE: secret });
  expect(reasonsOf(manifest)).toEqual([`sensitive_value ${RESULT}`, `sensitive_value ${SUMMARY}`]);
  const copied = (await readdir(join(leaking, bundlePath('real')), { recursive: true })).map(String).sort();
  expect(copied).not.toContain(RESULT);
  expect(copied).not.toContain(SUMMARY);
  expect(copied).toContain(OBSERVATION);
  expect(text).not.toContain(secret.slice(5));
  expect(output.out.join('\n')).toContain(`${RESULT} memuat nilai variable sensitif FOUNDATION_PERF_PROBE`);
}, 60_000);

// The report fixture: a git repository with one registry and the real bundle with the smoke step, as the tier runner
// writes it. The fast and security bundles are left out; only the parts this suite reads matter.

const gitEnv = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...gitEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
}

const reportEnv = () => ({ PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? tmpdir() });

/** A full `result.json` in the shape of *Isi result.json*, from a real smoke run cut to what the report reads. */
function smokeResult(change: (result: Record<string, any>) => void = () => undefined): Record<string, any> {
  const latency = (endpoint: string, phase: string, outcome: string, count: number, p95: number | null) => ({
    endpoint,
    phase,
    outcome,
    count,
    p50: p95 === null ? null : 0.63,
    p95,
    p99: p95 === null ? null : 3.6,
    max: p95 === null ? null : 9.93,
  });
  const result: Record<string, any> = {
    schema: 1,
    profile: 'smoke',
    status: 'passed',
    reasons: [],
    startedAt: '2026-10-04T16:06:39.719Z',
    finishedAt: '2026-10-04T16:07:44.944Z',
    t0: 1791130023585,
    model: {
      iterationIsOneRequest: true,
      phases: [
        { phase: 'warmup', shape: 'constant', seconds: 10, load: 'S0', rates: { status: { startRate: 100, endRate: 100 }, readiness: { startRate: 10, endRate: 10 } } },
        { phase: 'steady', shape: 'constant', seconds: 30, load: 'S0', rates: { status: { startRate: 100, endRate: 100 }, readiness: { startRate: 10, endRate: 10 } } },
      ],
    },
    actual: {
      scenarios: [
        { name: 'status_warmup', endpoint: 'status', phase: 'warmup', executor: 'constant-arrival-rate', startRate: 100, endRate: 100, seconds: 10, plannedIterations: 1000, iterations: 1001, rate: 100.1 },
        { name: 'status_steady', endpoint: 'status', phase: 'steady', executor: 'constant-arrival-rate', startRate: 100, endRate: 100, seconds: 30, plannedIterations: 3000, iterations: 3001, rate: 100.03333333333333 },
        { name: 'readiness_steady', endpoint: 'readiness', phase: 'steady', executor: 'constant-arrival-rate', startRate: 10, endRate: 10, seconds: 30, plannedIterations: 300, iterations: 300, rate: 10 },
      ],
      iterations: 4302,
      httpReqs: 4302,
      droppedIterations: 0,
      vusMax: 40,
      scenarioStartLateMs: 3,
    },
    latency: [
      latency('status', 'warmup', 'all', 1001, 1.88),
      latency('status', 'steady', 'all', 3001, 1.96),
      latency('readiness', 'steady', 'available', 299, 5.91),
      latency('readiness', 'steady', 'busy', 1, 2.73),
      latency('readiness', 'steady', 'unavailable', 0, null),
    ],
    readiness: { phases: [{ phase: 'steady', available: 299, busy: 1, unavailable: 0, availableRatio: 0.9966666666666667 }], recoveryMs: null },
    thresholds: [
      { metric: 'unexpected_responses', expression: 'count==0', ok: true },
      { metric: 'dropped_iterations', expression: 'count==0', ok: true },
      { metric: 'checks', expression: 'rate==1', ok: true },
      { metric: 'iterations{scenario:status_warmup}', expression: 'count>=999', ok: true },
      { metric: 'iterations{scenario:status_steady}', expression: 'count>=2997', ok: true },
      { metric: 'iterations{scenario:readiness_steady}', expression: 'count>=299', ok: true },
      { metric: 'http_req_duration{endpoint:status,phase:warmup}', expression: 'max>=0', ok: true },
      { metric: 'http_req_duration{endpoint:status,phase:steady}', expression: 'p(95)<10', ok: true },
      { metric: 'http_req_duration{endpoint:status,phase:steady}', expression: 'p(99)<25', ok: true },
      { metric: 'readiness_available_duration{phase:steady}', expression: 'p(95)<25', ok: true },
      { metric: 'readiness_busy_duration{phase:steady}', expression: 'max>=0', ok: true },
      { metric: 'readiness_available{phase:steady}', expression: 'rate>=0.98', ok: true },
    ],
    observation: {
      containers: {
        postgres: { cpuMean: 1.22, cpuMax: 5.12, memoryMeanMiB: 42.99, memoryMaxMiB: 44.36, memoryGrowthMiB: null, restarts: null, oomKilled: null, stderrBytes: null },
        backend: { cpuMean: 4.98, cpuMax: 7.59, memoryMeanMiB: 21.86, memoryMaxMiB: 22.84, memoryGrowthMiB: null, restarts: 0, oomKilled: false, stderrBytes: 0 },
        k6: { cpuMean: 16.22, cpuMax: 21.53, memoryMeanMiB: 36.42, memoryMaxMiB: 39.04, memoryGrowthMiB: null, restarts: null, oomKilled: null, stderrBytes: null },
      },
      pool: { sessions: 5, nonIdle: 1, total: 6, samples: 55, failedSamples: 0 },
      checks: [
        { name: 'backend_memory_peak', rule: 'memory backend maksimum <= 128 MiB', actual: 22.84, ok: true },
        { name: 'generator_cpu', rule: 'rata rata CPU k6 pada setiap fase terukur <= 240 persen satu CPU', actual: 16.56, ok: true },
        { name: 'clock_offset', rule: 'selisih jam container dengan host <= 1000 ms', actual: { before: 6, after: 6 }, ok: true },
      ],
    },
    outage: null,
    environment: {
      os: 'Darwin 27.0.0',
      arch: 'arm64',
      cpuModel: 'Fixture CPU',
      cpuCount: 10,
      memoryBytes: 34359738368,
      containerEngine: { serverVersion: '29.8.0', os: 'Mesin fixture', ncpu: 10, memTotal: 8319504384 },
      otherContainersRunning: 7,
      ci: false,
      images: {
        k6: `grafana/k6:2.3.0@sha256:${'9'.repeat(64)}`,
        bun: `oven/bun:1.4.2-slim@sha256:${'c'.repeat(64)}`,
        postgres: { image: 'foundation-postgres:18-pinned', imageId: `sha256:${'d'.repeat(64)}`, baseImage: `oraclelinux:10-slim@sha256:${'0'.repeat(64)}`, serverVersion: '18.6' },
      },
      limits: {
        postgres: { cpus: '2', memory: '1g', shmSize: '128m', pids: '256' },
        backend: { cpus: '1', memory: '512m', pids: '256' },
        k6: { cpus: '3', memory: '2g', pids: '512' },
      },
      pool: { max: 5, connectionTimeoutSeconds: 3 },
      data: { appliedMigrations: 1 },
      clockOffsetMs: { before: 6, after: 6 },
    },
    limits: ['Alur yang diukur adalah diagnostik komposisi development.', 'Data hanya riwayat migration (1 baris); tidak ada tabel bisnis.'],
  };
  change(result);
  return result;
}

type ReportFixture = { dir: string; commit: string; tree: string };

/** A git repository whose registry holds PERF-001 and PERF-002 of the repository, plus one scenario with two profiles. */
async function reportRepository(): Promise<ReportFixture> {
  const registry = JSON.parse(await readFile(join(import.meta.dir, '../../scenarios/performance.json'), 'utf8')) as { scenarios: Array<{ id: string }> };
  const scenarios = [
    ...registry.scenarios.filter((scenario) => scenario.id === 'PERF-001' || scenario.id === 'PERF-002'),
    {
      id: 'FIX-103',
      criteria: ['AC-9'],
      checks: [
        { runner: 'command', script: SMOKE, file: 'tests/performance/profiles/smoke.ts' },
        { runner: 'command', script: 'test:performance:load', file: 'tests/performance/profiles/load.ts' },
        { runner: 'command', script: SMOKE, file: 'tests/performance/profiles/smoke.ts' },
      ],
    },
  ];
  const dir = await workspace(
    {
      '.gitignore': '.local/\n',
      'package.json': JSON.stringify({ name: 'fixture', private: true }),
      'tests/scenarios/performance.json': `${JSON.stringify({ source: 'docs/specs/0011-fixture/index.md', scenarios }, null, 2)}\n`,
    },
    'foundation-perf-report-',
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' } }).stdout.toString().trim();
  return { dir, commit, tree: (await sourceTree(dir))! };
}

/** Writes the real bundle with the smoke step: `files` are the four evidence texts; `change` edits the manifest last. */
async function realBundle(fixture: ReportFixture, files: Record<string, string>, change: (manifest: TierManifest) => void = () => undefined): Promise<void> {
  const evidence: EvidenceRecord[] = TIERS.real!.steps.at(-1)!.evidence.map((item) => ({
    path: item.path,
    kind: item.kind,
    required: true,
    present: files[item.path] !== undefined,
    sha256: files[item.path] === undefined ? null : sha256(files[item.path]!),
  }));
  const manifest: TierManifest = {
    schema: 1,
    tier: 'real',
    candidate: { commit: fixture.commit, clean: true, sourceTree: fixture.tree, sourceTreeAfter: fixture.tree, ci: null },
    environment: { os: 'linux', arch: 'x64', bun: '1.4.2', node: '24.21.0' },
    inputs: {},
    outputs: {},
    steps: [{ script: SMOKE, status: 'passed', reasons: [], exitCode: 0, durationMs: 65_000, timedOut: false, signal: null, leftoverPorts: [], evidence }],
    status: 'passed',
    startedAt: '2026-10-04T00:00:00.000Z',
    finishedAt: '2026-10-04T00:01:05.000Z',
  };
  change(manifest);
  const bundle = join(fixture.dir, bundlePath('real'));
  await writeFiles(bundle, files);
  await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const smokeFiles = (result: Record<string, unknown> | string) => ({
  [RESULT]: typeof result === 'string' ? result : JSON.stringify(result),
  [SUMMARY]: '{ "metrics": {} }',
  [OBSERVATION]: '{ "samples": {} }',
  [SCAN]: '{ "findings": [] }',
});

const realProblems = (found: GateReport) => found.binding.problems.filter((problem) => problem.tier === 'real').map((problem) => `${problem.code}${problem.path === null ? '' : ` ${problem.path}`}`);

test('PERF-008 the manifest validator accepts performance and data evidence, and report.json copies a bound result.json into performance', async () => {
  // covers: AC-9 (Jenis bukti diterima validator manifest; report.json per push dengan key performance sesudah outOfScope)
  const fixture = await reportRepository();
  const result = smokeResult();
  await realBundle(fixture, smokeFiles(result));
  const output = lines();
  // Without the fast and security bundles the gate is incomplete; the report is still written.
  expect(await runReport(fixture.dir, output.log, reportEnv())).toBe(1);
  const found = JSON.parse(await readFile(join(fixture.dir, '.local/feature-11/report.json'), 'utf8')) as GateReport;
  // Spec 0012 adds deployment after performance.
  expect(Object.keys(found).slice(-3)).toEqual(['outOfScope', 'performance', 'deployment']);
  expect(realProblems(found)).toEqual([]);
  expect(found.tiers.real.status).toBe('passed');
  // Spec 0012 binds the deployment image to the report, so only the capacity profiles stay out of scope.
  expect(found.outOfScope).toEqual([{ area: 'capacity_profiles', feature: 12 }]);
  expect(OUT_OF_SCOPE).toEqual(found.outOfScope);
  expect(found.performance).toEqual([
    {
      tier: 'real',
      script: SMOKE,
      profile: 'smoke',
      status: 'passed',
      evidence: `${bundlePath('real')}/${RESULT}`,
      model: result['model'],
      actual: result['actual'],
      latency: result['latency'],
      readiness: result['readiness'],
      thresholds: result['thresholds'],
      observation: result['observation'],
      outage: null,
      environment: result['environment'],
      limits: result['limits'],
    },
  ]);
  // Fields outside the named list (reasons, t0, startedAt) stay in the bundle only.
  expect(Object.keys(found.performance[0]!)).toEqual(['tier', 'script', 'profile', 'status', 'evidence', 'model', 'actual', 'latency', 'readiness', 'thresholds', 'observation', 'outage', 'environment', 'limits']);
  expect(output.out).toContain('  performance k6: smoke passed');
  // PERF-002 is a command check on the smoke step: exit 0 passes it.
  expect(found.scenarios.find((scenario) => scenario.id === 'PERF-002')?.status).toBe('passed');
});

test('PERF-008 performance is empty when result.json does not match its manifest or is not a smoke result, and an unknown kind is manifest_invalid', async () => {
  // covers: AC-9 (performance kosong bila tidak ada bukti performance yang cocok manifest)
  const changed = await reportRepository();
  await realBundle(changed, smokeFiles(smokeResult()));
  await writeFile(join(changed.dir, bundlePath('real'), RESULT), JSON.stringify(smokeResult((result) => void (result['status'] = 'failed'))));
  const differs = await buildReport(changed.dir, reportEnv());
  expect(differs.performance).toEqual([]);
  expect(realProblems(differs)).toEqual([`evidence_hash_differs ${RESULT}`]);

  for (const [label, text] of [
    ['another profile', JSON.stringify(smokeResult((result) => void (result['profile'] = 'load')))],
    ['schema 2', JSON.stringify(smokeResult((result) => void (result['schema'] = 2)))],
    ['not JSON', '{'],
  ] as const) {
    const fixture = await reportRepository();
    await realBundle(fixture, smokeFiles(text));
    const found = await buildReport(fixture.dir, reportEnv());
    expect(realProblems(found), label).toEqual([]);
    expect(found.performance, label).toEqual([]);
  }

  const missing = await reportRepository();
  const files = smokeFiles(smokeResult());
  delete (files as Record<string, string>)[RESULT];
  await realBundle(missing, files);
  expect((await buildReport(missing.dir, reportEnv())).performance).toEqual([]);

  const unknown = await reportRepository();
  await realBundle(unknown, smokeFiles(smokeResult()), (manifest) => void (manifest.steps[0]!.evidence[0]!.kind = 'perf' as EvidenceRecord['kind']));
  const invalid = await buildReport(unknown.dir, reportEnv());
  expect(realProblems(invalid)).toEqual(['manifest_invalid']);
  expect(invalid.performance).toEqual([]);
});

/** Unescaped `|` in one Markdown line. */
const pipes = (line: string) => (line.match(/(?<!\\)\|/g) ?? []).length;

function section(markdown: string, heading: string): string[] {
  const all = markdown.split('\n');
  const start = all.indexOf(heading);
  if (start < 0) throw new Error(`no ${heading}`);
  const end = all.findIndex((line, index) => index > start && line.startsWith('## '));
  return all.slice(start, end < 0 ? undefined : end);
}

test('PERF-008 report.md renders Performance k6 from a fixture result.json, the new outOfScope, and the k6 profile column', async () => {
  // covers: AC-9 (bagian Performance k6, outOfScope, kolom Test dan profil), AC-10 (label mesin container dan batas bukti)
  const fixture = await reportRepository();
  const result = smokeResult((value) => {
    value['status'] = 'failed';
    value['thresholds'][8].ok = false;
    value['environment'].cpuModel = 'Chip | pipa\nbaris';
  });
  await realBundle(fixture, smokeFiles(result), (manifest) => {
    manifest.steps[0]!.exitCode = 1;
    manifest.steps[0]!.status = 'failed';
    manifest.steps[0]!.reasons = [{ code: 'exit_code', path: null }];
    manifest.status = 'failed';
  });
  const found = await buildReport(fixture.dir, reportEnv());
  const markdown = renderMarkdown(found);
  const performance = section(markdown, '## Performance k6');
  const text = performance.join('\n');
  expect(markdown.indexOf('## Hasil per skenario')).toBeLessThan(markdown.indexOf('## Performance k6'));
  expect(markdown.indexOf('## Performance k6')).toBeLessThan(markdown.indexOf('## Kandidat release'));
  expect(performance).toContain('### Profil smoke');
  expect(performance).toContain('| Status | failed |');
  expect(performance).toContain(`| Bukti | ${bundlePath('real')}/.local/feature-12/smoke/result.json |`);
  expect(performance).toContain('| Model beban | warmup constant 10 detik S0, steady constant 30 detik S0; satu iterasi satu request |');
  // Beban target dan aktual, with dropped iterations.
  expect(performance).toContain('| status\\_steady | status | steady | 100 | 30 | 3000 | 3001 | 100.03 | count\\>=2997 | lulus |');
  expect(performance).toContain('| Dropped iterations | 0 |');
  expect(performance).toContain('| Iterasi | 4302 |');
  expect(performance).toContain('| Request HTTP | 4302 |');
  // Latency against the target: a recording expression is never shown as a target. Cells escape < and >.
  expect(performance).toContain('| status | warmup | all | 1001 | 0.63 | 1.88 | 3.60 | 9.93 | tanpa target | - |');
  expect(performance).toContain('| status | steady | all | 3001 | 0.63 | 1.96 | 3.60 | 9.93 | p(95)\\<10, p(99)\\<25 | gagal |');
  expect(performance).toContain('| readiness | steady | available | 299 | 0.63 | 5.91 | 3.60 | 9.93 | p(95)\\<25 | lulus |');
  expect(performance).toContain('| readiness | steady | unavailable | 0 | - | - | - | - | tanpa target | - |');
  expect(performance).toContain('| steady | 299 | 1 | 0 | 0.997 | rate\\>=0.98 | lulus |');
  expect(performance).toContain('11 dari 12 threshold lulus.');
  expect(performance).toContain('| http\\_req\\_duration{endpoint:status,phase:steady} | p(99)\\<25 |');
  // Resource, pool, and observation checks.
  expect(performance).toContain('| backend | 4.98 | 7.59 | 21.86 | 22.84 | - | 0 | tidak | 0 |');
  expect(performance).toContain('| Sesi foundation\\_backend maksimum | 5 |');
  expect(performance).toContain('| clock\\_offset | selisih jam container dengan host \\<= 1000 ms | {"before":6,"after":6} | ya |');
  // Environment with the neutral label, and the evidence limits as written.
  expect(performance).toContain('| Mesin container | versi server 29.8.0, Mesin fixture, 10 CPU, memory 8319504384 byte |');
  expect(performance).toContain('| Batas resource k6 | cpus 3, memory 2g, pids 512 |');
  expect(performance).toContain('| Pool | max 5, connectionTimeout 3 detik |');
  const cpu = performance.find((line) => line.startsWith('| CPU host |'))!;
  expect(cpu).toBe('| CPU host | Chip \\| pipabaris, 10 CPU |');
  expect(pipes(cpu)).toBe(3);
  expect(performance).toContain('| 2 | Data hanya riwayat migration (1 baris); tidak ada tabel bisnis. |');
  expect(text).not.toMatch(/containerEngine/);
  for (const line of performance.filter((item) => item.startsWith('|'))) expect(line.includes('\n')).toBe(false);

  // outOfScope names the capacity profiles only; k6 performance and, since spec 0012, the deployment image are bound.
  const outside = section(markdown, '## Di luar cakupan');
  expect(outside).toEqual(['## Di luar cakupan', '', '- Profil kapasitas load, stress, spike, outage, dan soak, dibuktikan `test:report:capacity` dari tier kapasitas (fitur 12).', '']);
  expect(markdown).not.toContain('Performance k6 belum masuk gate');

  // The column Test dan profil, with the examples of the spec and a scenario with two profiles.
  const rows = section(markdown, '## Hasil per skenario').filter((line) => /^\| (PERF|FIX)-/.test(line));
  expect(rows.find((line) => line.startsWith('| PERF-001 |'))).toContain('| bun:test test:performance:plan tests/integration/performance/plan.test.ts PERF-001; profil k6 tidak ada |');
  expect(rows.find((line) => line.startsWith('| PERF-002 |'))).toContain('| command test:performance:smoke tests/performance/profiles/smoke.ts; profil k6 smoke |');
  expect(rows.find((line) => line.startsWith('| FIX-103 |'))).toContain('; profil k6 smoke, load |');
  expect(profileSuffix([{ script: 'test:performance:plan' }, { script: 'test:ci:real' }])).toBe('profil k6 tidak ada');
  expect(profileSuffix([{ script: 'test:performance:soak' }, { script: SMOKE }, { script: 'test:performance:soak' }])).toBe('profil k6 soak, smoke');

  // Without a bound result.json, or without a k6 summary, the section says so.
  const empty = renderMarkdown({ ...found, performance: [] });
  expect(section(empty, '## Performance k6')).toContain('Tidak ada bukti `performance` dari tier per push yang cocok dengan manifest nya.');
  const noSummary = renderMarkdown({ ...found, performance: [{ ...found.performance[0]!, actual: null, latency: null, readiness: null, thresholds: null, observation: null }] });
  const lean = section(noSummary, '## Performance k6');
  expect(lean).toContain('Ringkasan k6 tidak tersedia, sehingga beban aktual, latency, readiness, dan thresholds tidak tercatat.');
  expect(lean).toContain('Pengamatan tidak dinilai pada run ini.');
  expect(lean).not.toContain('#### Latency terhadap target');
});

test('PERF-008 no file under scripts/ matches the INFRA-001 word pattern, comments included', async () => {
  // covers: AC-10 (Kata terlarang: label mesin container dan key containerEngine)
  const root = join(import.meta.dir, '../../../scripts');
  const files = (await readdir(root, { recursive: true })).map(String).filter((path) => path.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(20);
  const matches: string[] = [];
  for (const path of files) {
    if (!(await lstat(join(root, path))).isFile()) continue;
    if (/\bdocker\b/i.test(await readFile(join(root, path), 'utf8'))) matches.push(path);
  }
  expect(matches).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// Step 5 of the Build plan: the capacity tier, the registry rule, the capacity report, and the capacity workflow.

const CAPACITY_PROFILES = ['load', 'stress', 'spike', 'outage', 'soak'] as const;
const profileFiles = (profile: string) => [
  spec(`.local/feature-12/${profile}/result.json`, 'performance'),
  spec(`.local/feature-12/${profile}/k6/summary.json`, 'data'),
  spec(`.local/feature-12/${profile}/observation.json`, 'data'),
  spec(`.local/feature-12/${profile}/artifact-scan.json`, 'scan'),
];

test('PERF-008 the capacity tier runs load, stress, spike, outage, and soak with four files each, outside TIERS and the per push names', () => {
  // covers: AC-9 (Tier kapasitas dan gate, baris capacity; Perubahan gate yang dinamai, Tipe tier dan Kandidat release kapasitas)
  expect(CAPACITY_TIER_NAME).toBe('capacity');
  expect(CAPACITY_TIER).toEqual({
    name: 'capacity',
    script: 'test:ci:capacity',
    stepTimeoutMs: 5_400_000,
    stopGraceMs: 180_000,
    steps: CAPACITY_PROFILES.map((profile) => ({ script: `test:performance:${profile}`, evidence: profileFiles(profile) })),
  });
  // The smoke of the real tier declares the same four files in its own profile folder.
  expect(TIERS.real!.steps.at(-1)).toEqual({ script: SMOKE, evidence: profileFiles('smoke') });

  // The per push names stay as they were: three tiers, three root scripts, and no capacity tier in TIERS.
  expect(TIER_NAMES).toEqual(['fast', 'real', 'security']);
  expect(TIER_SCRIPTS).toEqual({ fast: 'test:ci', real: 'test:ci:real', security: 'test:ci:security' });
  expect(Object.keys(TIERS)).toEqual(['fast', 'real', 'security']);
  expect(Object.values(TIERS)).not.toContain(CAPACITY_TIER);
  expect(tierByName('capacity')).toBe(CAPACITY_TIER);
  for (const name of ['Capacity', 'capacity ', 'kapasitas', 'test:ci:capacity']) expect(tierByName(name), name).toBeUndefined();
  expect(bundlePath('capacity')).toBe('.local/feature-11/evidence/capacity');
  expect(LEFTOVER_PORTS).not.toHaveProperty('capacity');

  // tierSteps() covers both, and only the capacity tier owns the five profile steps.
  const steps = tierSteps();
  for (const profile of CAPACITY_PROFILES) expect(steps.get(`test:performance:${profile}`), profile).toBe('capacity');
  expect(steps.get(SMOKE)).toBe('real');
  expect(steps.get('test:performance:plan')).toBe('fast');
  expect([...tierSteps(TIERS).values()]).not.toContain('capacity');

  expect(REASON_CODES.capacityRelease).toEqual(['gate_not_passed', 'not_clean', 'not_ci', 'event_not_dispatch', 'ref_not_main']);
  expect(REASON_CODES.release).toEqual(['gate_not_passed', 'not_clean', 'not_ci', 'event_not_push', 'ref_not_main']);
  expect(CAPACITY_RELEASE_EVENT).toBe('workflow_dispatch');
  expect(RELEASE_EVENT).toBe('push');
  expect(CAPACITY_OUT_OF_SCOPE).toEqual([{ area: 'deployment_image', feature: 13 }]);
  expect([CAPACITY_REPORT_JSON, CAPACITY_REPORT_MD]).toEqual(['.local/feature-12/report.json', '.local/feature-12/report.md']);
});

/** A step script that writes the four files of `profile`, then exits `exit`. */
function profileStep(profile: string, exit = 0): string {
  const dir = `.local/feature-12/${profile}`;
  const result = JSON.stringify({ schema: 1, profile, status: exit === 0 ? 'passed' : 'failed' }).replace(/"/g, '\\"');
  return [
    `mkdir -p ${dir}/k6`,
    `printf '%s' "${result}" > ${dir}/result.json`,
    `printf '{}' > ${dir}/k6/summary.json`,
    `printf '{}' > ${dir}/observation.json`,
    `printf '{ "findings": [] }' > ${dir}/artifact-scan.json`,
    `exit ${exit}`,
  ].join(' && ');
}

async function runGateCli(dir: string, args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/gate.ts', ...args], { cwd: dir, env: gateEnv(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

async function withGateScripts(dir: string): Promise<string> {
  const scripts = join(import.meta.dir, '../../../scripts');
  await cp(join(scripts, 'gate.ts'), join(dir, 'scripts/gate.ts'));
  await cp(join(scripts, 'lib'), join(dir, 'scripts/lib'), { recursive: true });
  return dir;
}

test('PERF-008 scripts/gate.ts capacity runs the five profiles in order into the capacity bundle and stops after a failing profile', async () => {
  // covers: AC-9 (test:ci:capacity = scripts/gate.ts capacity; urutan langkah, bukti, dan tanpa leftoverPorts)
  const passing = await withGateScripts(await tierWorkspace(Object.fromEntries(CAPACITY_PROFILES.map((profile) => [`test:performance:${profile}`, profileStep(profile)]))));
  const run = await runGateCli(passing, ['capacity']);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain('gate capacity: tier passed (5 dari 5 langkah passed)');
  expect(run.stdout).toContain('gate capacity: bundle bukti di .local/feature-11/evidence/capacity/');
  const manifest = JSON.parse(await readFile(join(passing, bundlePath('capacity'), 'manifest.json'), 'utf8')) as TierManifest;
  expect(manifest.tier).toBe('capacity');
  expect(manifest.status).toBe('passed');
  expect(manifest.steps.map((step) => [step.script, step.status, step.leftoverPorts])).toEqual(CAPACITY_PROFILES.map((profile) => [`test:performance:${profile}`, 'passed', []]));
  for (const step of manifest.steps) {
    expect(step.evidence.map((item) => [item.path, item.kind, item.present, typeof item.sha256])).toEqual(
      profileFiles(performanceProfile(step.script)!).map((item) => [item.path, item.kind, true, 'string']),
    );
  }
  // The per push bundles are never written by the capacity tier.
  for (const name of TIER_NAMES) expect(await exists(join(passing, bundlePath(name))), name).toBe(false);

  const steps = Object.fromEntries(CAPACITY_PROFILES.map((profile) => [`test:performance:${profile}`, profileStep(profile, profile === 'stress' ? 1 : 0)]));
  const failing = await withGateScripts(await tierWorkspace(steps));
  const failed = await runGateCli(failing, ['capacity']);
  expect(failed.code).toBe(1);
  const record = JSON.parse(await readFile(join(failing, bundlePath('capacity'), 'manifest.json'), 'utf8')) as TierManifest;
  expect(record.steps.map((step) => [step.script, step.status, step.reasons.map((reason) => reason.code)])).toEqual([
    ['test:performance:load', 'passed', []],
    ['test:performance:stress', 'failed', ['exit_code']],
    ['test:performance:spike', 'not_run', ['previous_step']],
    ['test:performance:outage', 'not_run', ['previous_step']],
    ['test:performance:soak', 'not_run', ['previous_step']],
  ]);

  // An extra argument or another word is still only the usage line.
  for (const args of [['capacity', 'extra'], ['kapasitas']]) {
    const usage = await runGateCli(failing, args);
    expect(usage, args.join(' ')).toEqual({ stdout: '', stderr: 'Pemakaian: bun --no-env-file scripts/gate.ts <fast|real|security|capacity>\n', code: 1 });
  }
}, 90_000);

test('PERF-008 test:scenarios rejects a scenario that mixes a capacity script with a script of another tier, and keeps capacity only scenarios', async () => {
  // covers: AC-9 (registry yang mencampur tier ditolak test:scenarios)
  const scripts = Object.fromEntries(
    ['test:performance:load', 'test:performance:outage', SMOKE, 'check:workflow', 'test:ci:capacity', 'test:ci:real'].map((name) => [name, 'x']),
  );
  const command = (script: string, file = 'package.json') => ({ runner: 'command', script, file });
  const scenarios = [
    { id: 'FIX-201', criteria: ['AC-1'], checks: [command('test:performance:load'), command('test:ci:capacity')] },
    { id: 'FIX-202', criteria: ['AC-1'], checks: [command('test:performance:load'), command(SMOKE)] },
    { id: 'FIX-203', criteria: ['AC-1'], checks: [command('check:workflow'), command('test:performance:outage'), command('test:ci:real')] },
    { id: 'FIX-204', criteria: ['AC-1'], checks: [command('test:ci:capacity'), command('check:workflow')] },
    { id: 'FIX-205', criteria: ['AC-1'], checks: [command(SMOKE), command('test:ci:real')] },
  ];
  const dir = await workspace({
    'package.json': JSON.stringify({ scripts }),
    'docs/specs/0001-fixture/index.md': '# Fixture\n\n- **AC-1**: satu.\n',
    'tests/scenarios/mix.json': JSON.stringify({ source: 'docs/specs/0001-fixture/index.md', scenarios }),
  });
  const result = await validateRegistries({ root: dir });
  expect(result.violations).toEqual([
    { registry: 'tests/scenarios/mix.json', id: 'FIX-202', message: 'skenario mencampur script tier capacity dengan script tier real' },
    { registry: 'tests/scenarios/mix.json', id: 'FIX-203', message: 'skenario mencampur script tier capacity dengan script tier fast, real' },
    { registry: 'tests/scenarios/mix.json', id: 'FIX-204', message: 'skenario mencampur script tier capacity dengan script tier fast' },
  ]);

  // The repository registry passes, and only PERF-003 to PERF-007 belong to the capacity report.
  const repository = join(import.meta.dir, '../../..');
  expect((await validateRegistries({ root: repository })).violations).toEqual([]);
  const registry = JSON.parse(await readFile(join(repository, 'tests/scenarios/performance.json'), 'utf8')) as {
    scenarios: Array<{ id: string; criteria: string[]; checks: Array<{ runner: string; script: string; file: string; testTag?: string }> }>;
  };
  expect(registry.scenarios.map((scenario) => [scenario.id, capacityScenario(scenario.checks)])).toEqual([
    ['PERF-001', false],
    ['PERF-002', false],
    ['PERF-003', true],
    ['PERF-004', true],
    ['PERF-005', true],
    ['PERF-006', true],
    ['PERF-007', true],
    ['PERF-008', false],
    ['PERF-009', false],
  ]);
  // *Critical test scenarios*: PERF-003 to PERF-007 are command checks on their profile, PERF-008 runs test:gate and check:workflow.
  for (const [index, profile] of CAPACITY_PROFILES.entries()) {
    expect(registry.scenarios[index + 2]!.checks, profile).toEqual([{ runner: 'command', file: `tests/performance/profiles/${profile}.ts`, script: `test:performance:${profile}` }]);
  }
  expect(registry.scenarios.map((scenario) => scenario.criteria.join(' '))).toEqual([
    'AC-1 AC-2 AC-3 AC-4 AC-5 AC-6 AC-7 AC-10',
    'AC-1 AC-2 AC-3 AC-4 AC-5 AC-6 AC-10',
    'AC-4 AC-5 AC-6',
    'AC-4 AC-5 AC-6 AC-8',
    'AC-4 AC-5 AC-6 AC-8',
    'AC-4 AC-5 AC-6 AC-7',
    'AC-4 AC-5 AC-6',
    'AC-9 AC-10',
    // PERF-009 (d), added after the review of 2026-10-04, proves the k6 exit, summary, and observation wiring as well.
    'AC-2 AC-4 AC-5 AC-6 AC-10',
  ]);
  expect(registry.scenarios[7]!.checks).toEqual([
    { runner: 'bun:test', file: 'tests/integration/gate/capacity.test.ts', testTag: 'PERF-008', script: 'test:gate' },
    { runner: 'command', file: 'scripts/check-workflow.ts', script: 'check:workflow' },
  ]);
  expect(capacityScenario([])).toBe(false);
});

// The full fixture: a git repository with a registry, and bundles written from a tier table as the tier runner would,
// every step passed with each declared file present and bound by SHA 256.

type Registered = { id: string; criteria: string[]; checks: Array<{ runner: string; script: string; file: string; testTag?: string }> };

async function scenarioRepository(scenarios: readonly Registered[]): Promise<ReportFixture> {
  const dir = await workspace(
    {
      '.gitignore': '.local/\n',
      'package.json': JSON.stringify({ name: 'fixture', private: true }),
      'tests/scenarios/fixture.json': `${JSON.stringify({ source: 'docs/specs/0011-fixture/index.md', scenarios }, null, 2)}\n`,
    },
    'foundation-perf-capacity-',
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' } }).stdout.toString().trim();
  return { dir, commit, tree: (await sourceTree(dir))! };
}

const scanners = () => ({
  schema: 1,
  scannedAt: '2026-10-04T00:00:00.000Z',
  workingTreeClean: true,
  status: 'passed',
  scanners: [
    { name: 'gitleaks', coverage: { head: 'x', commitsReachable: 1, shallow: false } },
    { name: 'bun audit', coverage: { packages: 1 } },
    { name: 'actionlint', coverage: { files: ['.github/workflows/application.yml', '.github/workflows/capacity.yml'] } },
  ].map((item) => ({ ...item, version: '1.0.0', image: null, status: 'passed', reason: null, counts: { failed: 0, excepted: 0, reported: 0 } })),
});

/** The default text of one declared evidence file: empty JUnit, a passed result of the step profile, or a JSON object. */
function evidenceText(item: EvidenceSpec, script: string): string {
  if (item.kind === 'junit') return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="fixture"></testsuites>\n';
  if (item.kind === 'performance') return JSON.stringify(smokeResult((result) => void (result['profile'] = performanceProfile(script))));
  if (item.kind === 'scan') return '{ "findings": [] }';
  if (item.kind === 'scanner') return JSON.stringify(scanners());
  return '{ "metrics": {} }';
}

type BundleOptions = {
  ci?: CiIdentity | null;
  clean?: boolean;
  /** Texts that replace the default text of an evidence path; `null` leaves the file out. */
  files?: Record<string, string | null>;
  /** Edits the manifest last, before it is written. */
  change?: (manifest: TierManifest) => void;
};

async function tierBundle(fixture: ReportFixture, tier: Tier, options: BundleOptions = {}): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const steps: StepRecord[] = tier.steps.map((step) => {
    const evidence: EvidenceRecord[] = step.evidence.map((item) => {
      if (item.kind === 'screenshots') return { path: item.path, kind: item.kind, required: item.required, present: false, files: [] };
      const text = options.files !== undefined && Object.hasOwn(options.files, item.path) ? options.files[item.path]! : evidenceText(item, step.script);
      const record: EvidenceRecord = { path: item.path, kind: item.kind, required: item.required, present: text !== null, sha256: text === null ? null : sha256(text) };
      if (item.runner !== null) Object.assign(record, { runner: item.runner, tests: 0, failures: 0, errors: 0, skipped: 0 });
      if (text !== null) contents.set(item.path, text);
      return record;
    });
    return { script: step.script, status: 'passed', reasons: [], exitCode: 0, durationMs: 1_000, timedOut: false, signal: null, leftoverPorts: [], evidence };
  });
  const manifest: TierManifest = {
    schema: 1,
    tier: tier.name,
    candidate: { commit: fixture.commit, clean: options.clean ?? true, sourceTree: fixture.tree, sourceTreeAfter: fixture.tree, ci: options.ci ?? null },
    environment: { os: 'linux', arch: 'x64', bun: '1.4.2', node: '24.21.0' },
    inputs: { 'bun.lock': sha256('lock') },
    outputs: { 'dist/backend/index.js': 'absent' },
    steps,
    status: 'passed',
    startedAt: '2026-10-04T00:00:00.000Z',
    finishedAt: '2026-10-04T01:50:00.000Z',
  };
  options.change?.(manifest);
  const bundle = join(fixture.dir, bundlePath(tier.name));
  await writeFiles(bundle, Object.fromEntries(contents));
  await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return contents;
}

const command = (script: string, file: string) => ({ runner: 'command', script, file });

test('PERF-008 the per push gate passes on a fixture without a capacity bundle, and the capacity scenarios are not among its scenarios', async () => {
  // covers: AC-9 (gate per push tanpa bundle kapasitas tetap passed; skenario kapasitas tidak muncul pada gate per push)
  const fixture = await scenarioRepository([
    { id: 'FIX-301', criteria: ['AC-9'], checks: [command('check:workflow', 'scripts/check-workflow.ts')] },
    { id: 'FIX-302', criteria: ['AC-9'], checks: [command(SMOKE, 'tests/performance/profiles/smoke.ts')] },
    { id: 'FIX-303', criteria: ['AC-9'], checks: [command('test:performance:load', 'tests/performance/profiles/load.ts')] },
    { id: 'FIX-304', criteria: ['AC-9'], checks: [command('test:ci:capacity', 'scripts/gate.ts'), command('test:performance:soak', 'tests/performance/profiles/soak.ts')] },
  ]);
  for (const name of TIER_NAMES) await tierBundle(fixture, TIERS[name]!);
  const output = lines();
  expect(await runReport(fixture.dir, output.log, reportEnv())).toBe(0);
  expect(output.out[0]).toBe('Gate passed');
  const found = JSON.parse(await readFile(join(fixture.dir, '.local/feature-11/report.json'), 'utf8')) as GateReport;
  expect(found.binding).toEqual({ valid: true, problems: [] });
  expect(found.scenarios.map((scenario) => [scenario.id, scenario.status])).toEqual([
    ['FIX-301', 'passed'],
    ['FIX-302', 'passed'],
  ]);
  expect(found.performance.map((item) => item.profile)).toEqual(['smoke']);
  expect(renderMarkdown(found)).not.toContain('FIX-303');

  // The capacity report of the same checkout has no bundle: incomplete, with only the capacity scenarios, not run.
  const capacity = await buildCapacityReport(fixture.dir, reportEnv());
  expect(capacity.status).toBe('incomplete');
  expect(capacity.binding.problems).toEqual([{ code: 'manifest_missing', tier: 'capacity', path: null }]);
  expect(capacity.scenarios.map((scenario) => [scenario.id, scenario.status, scenario.checks.map((check) => check.reasons.map((reason) => reason.code).join(' '))])).toEqual([
    ['FIX-303', 'not_run', ['tier_not_run']],
    ['FIX-304', 'not_run', ['tier_not_run', 'tier_not_run']],
  ]);
  expect(capacity.tier).toEqual({ status: 'not_run', runAttempt: null, environment: null, inputs: null, outputs: null, steps: [] });
  expect(capacity.performance).toEqual([]);
}, 60_000);

/** A registry with every PERF scenario of the repository: PERF-003 to PERF-007 are the capacity ones. */
async function perfRepository(): Promise<ReportFixture> {
  const registry = JSON.parse(await readFile(join(import.meta.dir, '../../scenarios/performance.json'), 'utf8')) as { scenarios: Registered[] };
  return scenarioRepository(registry.scenarios);
}

const capacityProblems = (found: CapacityReport) => found.binding.problems.map((problem) => [problem.code, problem.tier ?? 'laporan', problem.path].filter((part) => part !== null).join(' '));
const capacityResult = (profile: string) => `.local/feature-12/${profile}/result.json`;

test('PERF-008 test:report:capacity writes report.json with its keys in order, five performance entries, and report.md with the job summary', async () => {
  // covers: AC-9 (Laporan kapasitas: field, status passed, pengikatan sah, GITHUB_STEP_SUMMARY), AC-10 (batas bukti dan mesin container)
  const fixture = await perfRepository();
  await tierBundle(fixture, CAPACITY_TIER);
  // The job summary lives outside the checkout, as GITHUB_STEP_SUMMARY does on the runner.
  const summaryFile = join(await workspace({ 'summary.md': '# Ringkasan lain\n' }), 'summary.md');
  const output = lines();
  expect(await runCapacityReport(fixture.dir, output.log, { ...reportEnv(), GITHUB_STEP_SUMMARY: summaryFile })).toBe(0);
  const found = JSON.parse(await readFile(join(fixture.dir, CAPACITY_REPORT_JSON), 'utf8')) as CapacityReport;
  expect(Object.keys(found)).toEqual(['schema', 'generatedAt', 'candidate', 'binding', 'tier', 'scenarios', 'status', 'releaseCandidate', 'performance', 'outOfScope']);
  expect(found.schema).toBe(1);
  expect(found.candidate).toEqual({ commit: fixture.commit, sourceTree: fixture.tree, ci: null });
  expect(found.binding).toEqual({ valid: true, problems: [] });
  expect(found.status).toBe('passed');
  expect(found.tier.status).toBe('passed');
  expect(found.tier.steps.map((step) => step.script)).toEqual(CAPACITY_PROFILES.map((profile) => `test:performance:${profile}`));
  expect(Object.keys(found.tier)).toEqual(['status', 'runAttempt', 'environment', 'inputs', 'outputs', 'steps']);
  expect(found.scenarios.map((scenario) => [scenario.id, scenario.status, scenario.checks[0]!.exitCode])).toEqual([
    ['PERF-003', 'passed', 0],
    ['PERF-004', 'passed', 0],
    ['PERF-005', 'passed', 0],
    ['PERF-006', 'passed', 0],
    ['PERF-007', 'passed', 0],
  ]);
  // A local run without CI identity is never a release candidate; the flag does not change the exit code.
  expect(found.releaseCandidate).toEqual({ value: false, reasons: [{ code: 'not_ci', tier: null }] });
  expect(found.performance.map((item) => [item.tier, item.script, item.profile, item.status, item.evidence])).toEqual(
    CAPACITY_PROFILES.map((profile) => ['capacity', `test:performance:${profile}`, profile, 'passed', `.local/feature-11/evidence/capacity/${capacityResult(profile)}`]),
  );
  expect(Object.keys(found.performance[0]!)).toEqual(['tier', 'script', 'profile', 'status', 'evidence', 'model', 'actual', 'latency', 'readiness', 'thresholds', 'observation', 'outage', 'environment', 'limits']);
  expect(found.performance[0]!.limits).toEqual(smokeResult()['limits']);
  expect(found.outOfScope).toEqual([{ area: 'deployment_image', feature: 13 }]);

  expect(output.out).toEqual([
    'Laporan kapasitas passed',
    '  tier capacity: passed (5 dari 5 langkah passed)',
    '  skenario: 5 (0 failed, 0 missing_test, 0 not_run, 0 skipped, 5 passed)',
    '  pengikatan sah',
    '  performance k6: load passed, stress passed, spike passed, outage passed, soak passed',
    '  Kandidat release: bukan (not_ci)',
    'Laporan: .local/feature-12/report.json dan .local/feature-12/report.md',
  ]);

  const markdown = await readFile(join(fixture.dir, CAPACITY_REPORT_MD), 'utf8');
  expect(markdown).toBe(renderCapacityMarkdown(found));
  expect(await readFile(summaryFile, 'utf8')).toBe(`# Ringkasan lain\n${markdown}\n`);
  const headings = markdown.split('\n').filter((line) => /^##? /.test(line));
  expect(headings).toEqual([
    '# Laporan kapasitas',
    '## Kandidat',
    '## Pengikatan',
    '## Tier kapasitas',
    '## Hasil per skenario',
    '## Performance k6',
    '## Kandidat release',
    '## Di luar cakupan',
  ]);
  for (const profile of CAPACITY_PROFILES) expect(markdown).toContain(`### Profil ${profile}\n`);
  expect(markdown).toContain('| Status laporan kapasitas | passed |');
  expect(markdown).toContain('| capacity | passed | 5 dari 5 | - | linux x64, Bun 1.4.2, Node 24.21.0 |');
  expect(markdown).toContain('| test:performance:soak | passed | 1.0 detik | - |');
  const rows = section(markdown, '## Hasil per skenario').filter((line) => line.startsWith('| PERF-'));
  expect(rows).toHaveLength(5);
  expect(rows[3]).toContain('| command test:performance:outage tests/performance/profiles/outage.ts; profil k6 outage |');
  const performance = section(markdown, '## Performance k6');
  expect(performance).toContain('Disalin dari `result.json` setiap profil k6 di bundle tier kapasitas yang SHA 256 nya cocok dengan manifest. Angka ini berlaku untuk environment dan batas bukti yang tercatat, bukan perkiraan kapasitas produk. Latency dalam milidetik.');
  expect(performance).toContain('| Mesin container | versi server 29.8.0, Mesin fixture, 10 CPU, memory 8319504384 byte |');
  expect(performance).toContain('| 2 | Data hanya riwayat migration (1 baris); tidak ada tabel bisnis. |');
  expect(markdown).not.toMatch(/containerEngine/);
  expect(section(markdown, '## Kandidat release')).toContain('- `not_ci`: tidak berasal dari run CI.');
  // Spec 0012 (*Perubahan gate yang dinamai*, outOfScope): the capacity profiles still measure the development composition.
  expect(section(markdown, '## Di luar cakupan')).toEqual(['## Di luar cakupan', '', '- Profil kapasitas masih mengukur komposisi development, bukan image deployment (fitur 13).', '']);
  expect(markdown).not.toContain('Profil kapasitas load, stress');

  // The per push report of the same checkout leaves the five capacity scenarios out and never reads this bundle.
  const perPush = await buildReport(fixture.dir, reportEnv());
  expect(perPush.scenarios.map((scenario) => scenario.id)).toEqual(['PERF-001', 'PERF-002', 'PERF-008', 'PERF-009']);
  expect(perPush.performance).toEqual([]);
}, 60_000);

test('PERF-008 test:report:capacity: another hash, another commit, a changed tree, a missing bundle, and a failed profile', async () => {
  // covers: AC-9 (pengikatan kapasitas dengan kosakata spec 0010; status failed dan incomplete; exit 1)
  const differs = await perfRepository();
  await tierBundle(differs, CAPACITY_TIER);
  await writeFile(join(differs.dir, bundlePath('capacity'), capacityResult('spike')), JSON.stringify(smokeResult((result) => void (result['profile'] = 'spike'))).replace('"passed"', '"failed"'));
  const hash = await buildCapacityReport(differs.dir, reportEnv());
  expect(capacityProblems(hash)).toEqual([`evidence_hash_differs capacity ${capacityResult('spike')}`]);
  expect(hash.status).toBe('incomplete');
  expect(hash.performance.map((item) => item.profile)).toEqual(['load', 'stress', 'outage', 'soak']);
  expect(hash.releaseCandidate.reasons.map((reason) => reason.code)).toEqual(['gate_not_passed', 'not_ci']);
  const output = lines();
  expect(await runCapacityReport(differs.dir, output.log, reportEnv())).toBe(1);
  expect(output.out[0]).toBe('Laporan kapasitas incomplete');
  expect(output.out).toContain(`  pengikatan tidak sah: evidence_hash_differs capacity ${capacityResult('spike')}`);

  const other = await perfRepository();
  await tierBundle(other, CAPACITY_TIER, { change: (manifest) => void (manifest.candidate.commit = 'f'.repeat(40)) });
  expect(capacityProblems(await buildCapacityReport(other.dir, reportEnv()))).toEqual(['commit_differs capacity']);

  const changed = await perfRepository();
  await tierBundle(changed, CAPACITY_TIER, { change: (manifest) => void (manifest.candidate.sourceTreeAfter = sha256('later')) });
  expect(capacityProblems(await buildCapacityReport(changed.dir, reportEnv()))).toEqual(['source_tree_changed capacity']);

  const tree = await perfRepository();
  await tierBundle(tree, CAPACITY_TIER, { change: (manifest) => void (manifest.candidate.sourceTree = sha256('other tree')) });
  expect(capacityProblems(await buildCapacityReport(tree.dir, reportEnv()))).toEqual(['source_tree_differs capacity', 'source_tree_changed capacity']);

  const missing = await perfRepository();
  const none = await buildCapacityReport(missing.dir, reportEnv());
  expect([none.status, capacityProblems(none), none.tier.status]).toEqual(['incomplete', ['manifest_missing capacity'], 'not_run']);
  expect(none.scenarios.every((scenario) => scenario.status === 'not_run')).toBe(true);
  expect(none.releaseCandidate.reasons.map((reason) => reason.code)).toEqual(['gate_not_passed', 'not_ci']);
  await writeFiles(join(missing.dir, bundlePath('capacity')), { 'manifest.json': JSON.stringify({ schema: 1, tier: 'real' }) });
  expect(capacityProblems(await buildCapacityReport(missing.dir, reportEnv()))).toEqual(['manifest_invalid capacity']);

  // A failed profile fails the report; the profiles after it were not run.
  const failed = await perfRepository();
  await tierBundle(failed, CAPACITY_TIER, {
    files: { [capacityResult('stress')]: JSON.stringify(smokeResult((result) => Object.assign(result, { profile: 'stress', status: 'failed' }))) },
    change: (manifest) => {
      manifest.status = 'failed';
      manifest.steps[1] = { ...manifest.steps[1]!, status: 'failed', exitCode: 1, reasons: [{ code: 'exit_code', path: null }] };
      for (const step of manifest.steps.slice(2)) Object.assign(step, { status: 'not_run', exitCode: null, durationMs: 0, reasons: [{ code: 'previous_step', path: null }], evidence: [] });
    },
  });
  const result = await buildCapacityReport(failed.dir, reportEnv());
  expect(capacityProblems(result)).toEqual([]);
  expect(result.status).toBe('failed');
  expect(result.scenarios.map((scenario) => [scenario.id, scenario.status])).toEqual([
    ['PERF-003', 'passed'],
    ['PERF-004', 'failed'],
    ['PERF-005', 'not_run'],
    ['PERF-006', 'not_run'],
    ['PERF-007', 'not_run'],
  ]);
  expect(result.performance.map((item) => [item.profile, item.status])).toEqual([['load', 'passed'], ['stress', 'failed']]);
  const markdown = renderCapacityMarkdown(result);
  expect(markdown).toContain('| test:performance:stress | failed | 1.0 detik | exit\\_code |');
  expect(markdown).toContain('| test:performance:spike | not\\_run | 0.0 detik | previous\\_step |');
  expect(markdown).toContain('Kandidat release: bukan (`gate_not_passed`, `not_ci`)');
}, 90_000);

const DISPATCH: CiIdentity = { runId: '2000', runAttempt: '1', job: 'capacity', sha: '', ref: 'refs/heads/main', event: 'workflow_dispatch' };

function ciEnv(ci: CiIdentity): Record<string, string> {
  return {
    ...reportEnv(),
    GITHUB_RUN_ID: ci.runId!,
    GITHUB_RUN_ATTEMPT: ci.runAttempt!,
    GITHUB_JOB: 'capacity',
    GITHUB_SHA: ci.sha!,
    GITHUB_REF: ci.ref!,
    GITHUB_EVENT_NAME: ci.event!,
  };
}

test('PERF-008 the capacity release candidate: a clean workflow_dispatch run on main, and every code of REASON_CODES.capacityRelease', async () => {
  // covers: AC-9 (Kandidat release kapasitas dan event_not_dispatch)
  const cases: Array<[string, Partial<CiIdentity>, boolean, string[]]> = [
    ['workflow_dispatch pada main', {}, true, []],
    ['push', { event: 'push' }, true, ['event_not_dispatch']],
    ['ref lain', { ref: 'refs/heads/fitur' }, true, ['ref_not_main']],
    ['tidak bersih', {}, false, ['not_clean']],
  ];
  for (const [label, change, clean, expected] of cases) {
    const fixture = await perfRepository();
    const ci = { ...DISPATCH, sha: fixture.commit, ...change };
    await tierBundle(fixture, CAPACITY_TIER, { ci, clean });
    const found = await buildCapacityReport(fixture.dir, ciEnv(ci));
    expect(capacityProblems(found), label).toEqual([]);
    expect(found.status, label).toBe('passed');
    expect(found.releaseCandidate.value, label).toBe(expected.length === 0);
    expect(found.releaseCandidate.reasons, label).toEqual(expected.map((code) => ({ code: code as CapacityReport['releaseCandidate']['reasons'][number]['code'], tier: null })));
    if (expected.length === 0) expect(renderCapacityMarkdown(found), label).toContain('\nKandidat release: ya\n');
  }

  // A CI identity that differs from the report job is a binding problem, and the manifest without one is ci_mixed.
  const mixed = await perfRepository();
  await tierBundle(mixed, CAPACITY_TIER);
  const ciReport = await buildCapacityReport(mixed.dir, ciEnv({ ...DISPATCH, sha: mixed.commit }));
  expect(capacityProblems(ciReport)).toEqual(['ci_mixed capacity']);
  expect(ciReport.releaseCandidate.reasons.map((reason) => reason.code)).toEqual(['gate_not_passed', 'not_ci']);
  const attempt = await perfRepository();
  await tierBundle(attempt, CAPACITY_TIER, { ci: { ...DISPATCH, sha: attempt.commit, runAttempt: '2' } });
  expect(capacityProblems(await buildCapacityReport(attempt.dir, ciEnv({ ...DISPATCH, sha: attempt.commit })))).toEqual(['ci_attempt_differs capacity']);

  // The pure rules: every unmet condition once, in the order of REASON_CODES.capacityRelease, with tier null.
  const manifest = (clean: boolean, ci: CiIdentity | null) =>
    ({ candidate: { commit: 'a'.repeat(40), clean, sourceTree: 't', sourceTreeAfter: 't', ci } }) as TierManifest;
  const codes = (...args: Parameters<typeof capacityReleaseCandidate>) => capacityReleaseCandidate(...args).reasons.map((reason) => reason.code);
  expect(codes('failed', manifest(false, null), { ...DISPATCH, event: 'push', ref: 'refs/heads/x' })).toEqual([...REASON_CODES.capacityRelease]);
  expect(codes('passed', manifest(true, DISPATCH), null)).toEqual(['not_ci']);
  expect(codes('incomplete', null, null)).toEqual(['gate_not_passed', 'not_ci']);
  expect(capacityReleaseCandidate('passed', manifest(true, DISPATCH), DISPATCH)).toEqual({ value: true, reasons: [] });
  expect(capacityReleaseCandidate('passed', manifest(true, DISPATCH), { ...DISPATCH, event: 'schedule' }).reasons).toEqual([{ code: 'event_not_dispatch', tier: null }]);

  // capacityStatus: passed needs a passed tier, every capacity scenario passed, and a valid binding.
  const scenario = (status: ScenarioResult['status'], check = status) => ({ status, checks: [{ status: check }] }) as ScenarioResult;
  const passedTier = { status: 'passed', steps: [{ status: 'passed' }] } as TierManifest;
  expect(capacityStatus({ scenarios: [scenario('passed')], manifest: passedTier, bindingValid: true })).toBe('passed');
  expect(capacityStatus({ scenarios: [scenario('passed')], manifest: passedTier, bindingValid: false })).toBe('incomplete');
  expect(capacityStatus({ scenarios: [scenario('not_run')], manifest: passedTier, bindingValid: true })).toBe('incomplete');
  expect(capacityStatus({ scenarios: [scenario('failed')], manifest: passedTier, bindingValid: false })).toBe('failed');
  expect(capacityStatus({ scenarios: [], manifest: { status: 'failed', steps: [{ status: 'failed' }] } as TierManifest, bindingValid: true })).toBe('failed');
  expect(capacityStatus({ scenarios: [scenario('passed')], manifest: null, bindingValid: false })).toBe('incomplete');
}, 90_000);

test('PERF-008 scripts/gate-report.ts capacity writes the capacity report in a workspace, and another argument prints the usage', async () => {
  // covers: AC-9 (test:report:capacity = scripts/gate-report.ts capacity; exit 1 untuk incomplete)
  const dir = await workspace({ 'package.json': JSON.stringify({ name: 'fixture', private: true }) }, 'foundation-perf-report-cli-');
  const scripts = join(import.meta.dir, '../../../scripts');
  await cp(join(scripts, 'gate-report.ts'), join(dir, 'scripts/gate-report.ts'));
  await cp(join(scripts, 'lib'), join(dir, 'scripts/lib'), { recursive: true });
  const runCli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/gate-report.ts', ...args], { cwd: dir, env: reportEnv(), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  for (const args of [['capacity', 'extra'], ['fast'], ['Capacity']]) {
    expect(await runCli(args), args.join(' ')).toEqual({ stdout: '', stderr: 'Pemakaian: bun --no-env-file scripts/gate-report.ts [capacity|release]\n', code: 1 });
  }
  expect(await exists(join(dir, '.local'))).toBe(false);

  const capacity = await runCli(['capacity']);
  expect(capacity.code).toBe(1);
  expect(capacity.stderr).toBe('');
  expect(capacity.stdout.split('\n')[0]).toBe('Laporan kapasitas incomplete');
  expect(capacity.stdout).toContain('  pengikatan tidak sah: manifest_missing capacity, no_commit');
  const written = JSON.parse(await readFile(join(dir, CAPACITY_REPORT_JSON), 'utf8')) as CapacityReport;
  expect([written.status, written.tier.status, written.scenarios]).toEqual(['incomplete', 'not_run', []]);
  expect(await exists(join(dir, CAPACITY_REPORT_MD))).toBe(true);
  // The per push report files are not written by the capacity report.
  expect(await exists(join(dir, '.local/feature-11/report.json'))).toBe(false);
}, 30_000);

// *Workflow kapasitas*: the fixture is the capacity workflow of the row, written as YAML at runtime, changed one rule at a time.

const pin = (digit: string) => digit.repeat(40);

function capacityWorkflow(): Record<string, any> {
  return {
    name: 'Capacity foundation',
    on: { workflow_dispatch: null },
    permissions: { contents: 'read' },
    jobs: {
      capacity: {
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 150,
        steps: [
          { uses: `actions/checkout@${pin('1')}`, with: { 'persist-credentials': false } },
          { uses: `actions/setup-node@${pin('2')}`, with: { 'node-version': '24.21.0' } },
          { uses: `oven-sh/setup-bun@${pin('3')}`, with: { 'bun-version': '1.4.2' } },
          { run: 'bun install --frozen-lockfile' },
          { run: 'bun run test:ci:capacity' },
          { run: 'bun run test:report:capacity', if: '${{ !cancelled() }}' },
          {
            uses: `actions/upload-artifact@${pin('4')}`,
            if: 'always()',
            with: {
              name: 'capacity-evidence',
              path: '.local/feature-11/evidence/capacity/\n.local/feature-12/report.json\n.local/feature-12/report.md\n',
              'include-hidden-files': true,
              'retention-days': 90,
              'if-no-files-found': 'warn',
              overwrite: true,
            },
          },
        ],
      },
    },
  };
}

const capacityContext: CapacityWorkflowContext = {
  scripts: { 'test:ci:capacity': 'x', 'test:report:capacity': 'x' },
  engines: { node: '24.21.0', bun: '1.4.2' },
  pins: new Map([
    ['actions/checkout', new Set([pin('1')])],
    ['actions/setup-node', new Set([pin('2')])],
    ['oven-sh/setup-bun', new Set([pin('3')])],
    ['actions/upload-artifact', new Set([pin('4')])],
    ['actions/download-artifact', new Set([pin('5')])],
  ]),
};

const capacityProblemsOf = (workflow: Record<string, any> | string) =>
  checkCapacityWorkflow(typeof workflow === 'string' ? workflow : Bun.YAML.stringify(workflow, null, 2), capacityContext).problems;

test('PERF-008 check:workflow accepts the capacity.yml of the Workflow kapasitas row, and the repository file with the pins of application.yml', async () => {
  // covers: AC-9 (Workflow kapasitas: hanya workflow_dispatch, satu job, langkah berurutan, pin SHA application.yml)
  expect(capacityProblemsOf(capacityWorkflow())).toEqual([]);
  const text = `# Kapasitas\n${Bun.YAML.stringify(capacityWorkflow(), null, 2)}`.replace(`actions/checkout@${pin('1')}`, `actions/checkout@${pin('1')} # v4.4.0`);
  expect(checkCapacityWorkflow(text, capacityContext)).toEqual({ problems: [], jobs: [{ name: 'capacity', steps: 7 }] });

  const root = join(import.meta.dir, '../../..');
  const application = await readFile(join(root, '.github/workflows/application.yml'), 'utf8');
  const pins = actionPins(application);
  expect([...pins.keys()].sort()).toEqual(['actions/checkout', 'actions/download-artifact', 'actions/setup-node', 'actions/upload-artifact', 'oven-sh/setup-bun']);
  for (const [action, shas] of pins) expect(shas.size, action).toBe(1);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string>; engines: Record<string, string> };
  const repository = checkCapacityWorkflow(await readFile(join(root, '.github/workflows/capacity.yml'), 'utf8'), { scripts: manifest.scripts, engines: manifest.engines, pins });
  expect(repository).toEqual({ problems: [], jobs: [{ name: 'capacity', steps: 7 }] });
  expect(actionPins('jobs: [unclosed\n').size).toBe(0);
});

const capacityCases: Array<[string, (workflow: Record<string, any>) => void, string]> = [
  ['trigger push', (w) => (w.on.push = null), 'trigger push tidak diizinkan'],
  ['trigger schedule', (w) => (w.on.schedule = [{ cron: '0 3 * * 1' }]), 'trigger schedule tidak diizinkan'],
  ['inputs', (w) => (w.on.workflow_dispatch = { inputs: { profil: { type: 'string' } } }), 'trigger workflow_dispatch wajib tanpa inputs atau kunci lain'],
  ['tanpa workflow_dispatch', (w) => (w.on = { pull_request: null }), 'trigger workflow_dispatch wajib ada'],
  ['permission write', (w) => (w.permissions = { contents: 'write' }), 'permissions wajib tepat contents: read'],
  ['kunci workflow env', (w) => (w.env = { CI: 'true' }), 'kunci workflow env tidak diizinkan'],
  ['job tambahan', (w) => (w.jobs.report = { 'runs-on': 'ubuntu-24.04', steps: [{ run: 'bun run test:report' }] }), 'job report tidak diizinkan'],
  ['job hilang', (w) => (w.jobs = { other: w.jobs.capacity }), 'job capacity wajib ada'],
  ['timeout lain', (w) => (w.jobs.capacity['timeout-minutes'] = 120), 'job capacity: timeout-minutes wajib 150'],
  ['runs-on lain', (w) => (w.jobs.capacity['runs-on'] = 'ubuntu-latest'), 'job capacity: runs-on wajib ubuntu-24.04'],
  ['needs', (w) => (w.jobs.capacity.needs = ['application']), 'job capacity: kunci needs tidak diizinkan'],
  ['env tingkat job', (w) => (w.jobs.capacity.env = { CI: 'true' }), 'job capacity: kunci env tidak diizinkan'],
  ['action tanpa pin SHA', (w) => (w.jobs.capacity.steps[0].uses = 'actions/checkout@v4'), 'job capacity, langkah 1: action actions/checkout wajib dipin SHA 40 heksadesimal'],
  ['SHA lain dari application.yml', (w) => (w.jobs.capacity.steps[6].uses = `actions/upload-artifact@${pin('9')}`), 'job capacity, langkah 7: action actions/upload-artifact wajib dipin SHA yang sama dengan application.yml'],
  ['action lain', (w) => (w.jobs.capacity.steps[1].uses = `actions/cache@${pin('2')}`), 'job capacity, langkah 2: wajib uses actions/setup-node'],
  ['checkout tanpa persist-credentials: false', (w) => delete w.jobs.capacity.steps[0].with['persist-credentials'], 'job capacity, langkah 1: input persist-credentials wajib false'],
  ['input checkout tambahan', (w) => (w.jobs.capacity.steps[0].with['fetch-depth'] = 0), 'job capacity, langkah 1: input fetch-depth tidak diizinkan untuk actions/checkout'],
  ['teks secrets.', (w) => (w.jobs.capacity.steps[2].with['bun-version'] = '${{ secrets.BUN }}'), 'workflow tidak boleh memuat teks secrets.'],
  ['versi Bun lain', (w) => (w.jobs.capacity.steps[2].with['bun-version'] = '1.4.1'), 'job capacity, langkah 3: input bun-version wajib sama dengan engines.bun'],
  ['versi Node lain', (w) => (w.jobs.capacity.steps[1].with['node-version'] = '24'), 'job capacity, langkah 2: input node-version wajib sama dengan engines.node'],
  ['path unggah lain', (w) => (w.jobs.capacity.steps[6].with.path = '.local/'), 'job capacity, langkah 7: input path wajib .local/feature-11/evidence/capacity/ dan .local/feature-12/report.json dan .local/feature-12/report.md'],
  ['unggah tanpa report.md', (w) => (w.jobs.capacity.steps[6].with.path = '.local/feature-11/evidence/capacity/\n.local/feature-12/report.json\n'), 'job capacity, langkah 7: input path wajib'],
  ['artifact lain', (w) => (w.jobs.capacity.steps[6].with.name = 'everything'), 'job capacity, langkah 7: input name wajib capacity-evidence'],
  ['retensi lain', (w) => (w.jobs.capacity.steps[6].with['retention-days'] = 30), 'job capacity, langkah 7: input retention-days wajib 90'],
  ['if-no-files-found lain', (w) => (w.jobs.capacity.steps[6].with['if-no-files-found'] = 'error'), 'job capacity, langkah 7: input if-no-files-found wajib warn'],
  ['unggah tanpa if', (w) => delete w.jobs.capacity.steps[6].if, 'job capacity, langkah 7: if wajib always()'],
  ['laporan tanpa if', (w) => delete w.jobs.capacity.steps[5].if, 'job capacity, langkah 6: if wajib ${{ !cancelled() }}'],
  ['if pada tier', (w) => (w.jobs.capacity.steps[4].if = 'always()'), 'job capacity, langkah 5: if tidak diizinkan pada langkah ini'],
  ['run lain', (w) => (w.jobs.capacity.steps[4].run = 'bun run test:ci:real'), 'job capacity, langkah 5: wajib run: bun run test:ci:capacity'],
  ['run dengan argumen', (w) => (w.jobs.capacity.steps[4].run = 'bun run test:ci:capacity --bail'), 'job capacity, langkah 5: wajib run: bun run test:ci:capacity'],
  ['continue-on-error', (w) => (w.jobs.capacity.steps[4]['continue-on-error'] = true), 'job capacity, langkah 5: kunci continue-on-error tidak diizinkan'],
  ['env langkah', (w) => (w.jobs.capacity.steps[5].env = { GITHUB_STEP_SUMMARY: '/tmp/x' }), 'job capacity, langkah 6: kunci env tidak diizinkan'],
  ['laporan hilang', (w) => w.jobs.capacity.steps.splice(5, 1), 'job capacity, langkah 6: wajib run: bun run test:report:capacity'],
  ['langkah tambahan', (w) => w.jobs.capacity.steps.push({ run: 'bun run test:report' }), 'job capacity, langkah 8: langkah tambahan tidak diizinkan'],
  ['urutan tertukar', (w) => w.jobs.capacity.steps.splice(4, 2, w.jobs.capacity.steps[5], w.jobs.capacity.steps[4]), 'job capacity, langkah 5: wajib run: bun run test:ci:capacity'],
];

for (const [label, change, expected] of capacityCases) {
  test(`PERF-008 check:workflow rejects capacity.yml with ${label}`, () => {
    // covers: AC-9 (Workflow kapasitas: kunci, nilai, atau langkah lain ditolak)
    const workflow = capacityWorkflow();
    change(workflow);
    const found = capacityProblemsOf(workflow);
    expect(found.some((problem) => problem.startsWith(expected)), `${expected}\n${found.join('\n')}`).toBe(true);
  });
}

test('PERF-008 check:workflow needs capacity.yml and rejects a third workflow file in the folder', async () => {
  // covers: AC-9 (folder .github/workflows hanya berisi application.yml dan capacity.yml)
  const root = join(import.meta.dir, '../../..');
  const copy = async (path: string) => [path, await readFile(join(root, path), 'utf8')] as const;
  const files = Object.fromEntries(await Promise.all(['package.json', '.github/workflows/application.yml', '.github/workflows/capacity.yml'].map(copy)));
  const both = lines();
  expect(await runWorkflowCheck(await workspace(files), both.log, both.error)).toBe(0);

  const { ['.github/workflows/capacity.yml']: _capacity, ...withoutCapacity } = files;
  const missing = lines();
  expect(await runWorkflowCheck(await workspace(withoutCapacity), missing.log, missing.error)).toBe(1);
  expect(missing.err).toEqual(['Pemeriksaan workflow gagal dengan 1 masalah:', '  .github/workflows/capacity.yml wajib ada']);

  const third = lines();
  const dir = await workspace({ ...files, '.github/workflows/capacity-nightly.yml': 'on:\n  schedule:\n    - cron: "0 3 * * 1"\n', '.github/workflows/README.md': '# catatan\n' });
  expect(await runWorkflowCheck(dir, third.log, third.error)).toBe(1);
  expect(third.err).toEqual([
    'Pemeriksaan workflow gagal dengan 1 masalah:',
    '  file workflow .github/workflows/capacity-nightly.yml tidak diizinkan; hanya .github/workflows/application.yml dan .github/workflows/capacity.yml',
  ]);

  // A problem of capacity.yml is printed with the path of its file.
  const broken = lines();
  const changed = { ...files, '.github/workflows/capacity.yml': files['.github/workflows/capacity.yml']!.replace('timeout-minutes: 150', 'timeout-minutes: 90') };
  expect(await runWorkflowCheck(await workspace(changed), broken.log, broken.error)).toBe(1);
  expect(broken.err).toEqual(['Pemeriksaan workflow gagal dengan 1 masalah:', '  .github/workflows/capacity.yml: job capacity: timeout-minutes wajib 150']);
});

/** *Dokumen yang diperbarui* (spec 0011): the strings each document must hold. */
const capacityDocuments: Readonly<Record<string, readonly string[]>> = {
  'docs/rules/testing.md': [
    'test:ci:capacity',
    'test:report:capacity',
    'test:performance:outage',
    'test:performance:plan',
    'tests/performance/images.json',
    '.local/feature-12/',
    'foundation.test=performance',
  ],
  'README.md': ['test:ci:capacity', 'test:report:capacity'],
  'docs/testing/release-report-template.md': ['.local/feature-12/report.md'],
};

test('PERF-008 the documents name the capacity profiles, scripts, tier, pins, and evidence locations', async () => {
  // covers: AC-10 (Dokumen yang diperbarui)
  const root = join(import.meta.dir, '../../..');
  for (const [path, strings] of Object.entries(capacityDocuments)) {
    const text = await readFile(join(root, path), 'utf8');
    for (const value of strings) expect(text.includes(value), `${path} wajib memuat ${value}`).toBe(true);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Added by /test: the per push gate beside a capacity bundle, and the workflow folder rule for every YAML spelling.

test('PERF-008 a failed capacity bundle beside the per push bundles changes nothing in the per push gate', async () => {
  // covers: AC-9 (TIER_NAMES tetap tiga; test:report tidak menuntut atau membaca bundle kapasitas)
  const fixture = await scenarioRepository([
    { id: 'FIX-311', criteria: ['AC-9'], checks: [command('check:workflow', 'scripts/check-workflow.ts')] },
    { id: 'FIX-312', criteria: ['AC-9'], checks: [command(SMOKE, 'tests/performance/profiles/smoke.ts')] },
    { id: 'FIX-313', criteria: ['AC-9'], checks: [command('test:performance:outage', 'tests/performance/profiles/outage.ts')] },
  ]);
  for (const name of TIER_NAMES) await tierBundle(fixture, TIERS[name]!);
  // The capacity bundle failed on another commit and with a changed result.json: every problem the per push gate would see.
  await tierBundle(fixture, CAPACITY_TIER, {
    change: (manifest) => {
      manifest.status = 'failed';
      manifest.candidate.commit = 'f'.repeat(40);
      manifest.steps[0] = { ...manifest.steps[0]!, status: 'failed', exitCode: 1, reasons: [{ code: 'exit_code', path: null }] };
    },
  });
  await writeFile(join(fixture.dir, bundlePath('capacity'), capacityResult('load')), '{ "changed": true }');

  const output = lines();
  expect(await runReport(fixture.dir, output.log, reportEnv())).toBe(0);
  expect(output.out[0]).toBe('Gate passed');
  const found = JSON.parse(await readFile(join(fixture.dir, '.local/feature-11/report.json'), 'utf8')) as GateReport;
  expect(found.gate).toBe('passed');
  expect(found.binding).toEqual({ valid: true, problems: [] });
  expect(Object.keys(found.tiers)).toEqual(['fast', 'real', 'security']);
  expect(found.scenarios.map((scenario) => [scenario.id, scenario.status])).toEqual([['FIX-311', 'passed'], ['FIX-312', 'passed']]);
  expect(found.performance.map((item) => [item.tier, item.profile])).toEqual([['real', 'smoke']]);
  const markdown = await readFile(join(fixture.dir, '.local/feature-11/report.md'), 'utf8');
  expect(markdown).not.toContain('FIX-313');
  expect(markdown).not.toContain(bundlePath('capacity'));

  // The capacity report of the same checkout does read that bundle, and refuses it.
  const capacity = await buildCapacityReport(fixture.dir, reportEnv());
  expect(capacity.status).toBe('failed');
  expect(capacityProblems(capacity).sort()).toEqual(['commit_differs capacity', `evidence_hash_differs capacity ${capacityResult('load')}`]);
  expect(capacity.scenarios.map((scenario) => scenario.id)).toEqual(['FIX-313']);
}, 60_000);

test('PERF-008 check:workflow rejects a third workflow file whatever its YAML extension or case, and leaves other files alone', async () => {
  // covers: AC-9 (menolak file workflow selain application.yml dan capacity.yml)
  const root = join(import.meta.dir, '../../..');
  const copy = async (path: string) => [path, await readFile(join(root, path), 'utf8')] as const;
  const files = Object.fromEntries(await Promise.all(['package.json', '.github/workflows/application.yml', '.github/workflows/capacity.yml'].map(copy)));
  const workflow = 'on:\n  workflow_dispatch:\njobs: {}\n';
  const dir = await workspace({
    ...files,
    '.github/workflows/release.yaml': workflow,
    '.github/workflows/Nightly.YML': workflow,
    '.github/workflows/backup.Yaml': workflow,
    '.github/workflows/notes.txt': 'catatan\n',
    '.github/workflows/application.yml.bak': workflow,
  });
  const found = lines();
  expect(await runWorkflowCheck(dir, found.log, found.error)).toBe(1);
  const only = 'hanya .github/workflows/application.yml dan .github/workflows/capacity.yml';
  expect(found.err).toEqual([
    'Pemeriksaan workflow gagal dengan 3 masalah:',
    `  file workflow .github/workflows/Nightly.YML tidak diizinkan; ${only}`,
    `  file workflow .github/workflows/backup.Yaml tidak diizinkan; ${only}`,
    `  file workflow .github/workflows/release.yaml tidak diizinkan; ${only}`,
  ]);
  expect(found.out).toEqual([]);
});
