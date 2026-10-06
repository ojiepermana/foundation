import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmod, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEPLOYMENT_CHECKS } from '../../../scripts/lib/gate.ts';
import type { ProcessGroupOptions, ProcessGroupResult } from '../../../scripts/lib/process-group.ts';
import { groupAlive } from '../../../scripts/lib/process-identity.ts';
import {
  COMPOSE_FILE,
  COMPOSE_TEST_FILE,
  deploymentNames,
  projectAccepted,
  runDeployment,
  SIGNAL_EXIT_CODES,
  TIMEOUTS,
  type CommandRunner,
  type DeploymentResult,
  type HandledSignal,
  type Reason,
} from '../../orchestration/deployment-real.ts';
import { emptyWorkspace, removeWorkspaces, workspace } from '../gate/workspace.ts';

// DEP-008 (spec 0012, AC-11), following PERF-009, without a real container engine: (a) `runDeployment` with a stand in
// command runner, stopped by SIGTERM, SIGINT, or SIGHUP while the upstream stub starts, and stopped by the total
// deadline while `compose up --wait` runs; (b) `main` as its own process group with a fake `docker` and a fake `openssl`
// first on PATH, receiving each signal while `compose up --wait` holds. Cleanup must remove the named containers of the
// run with one `rm -f`, then the project with `compose down --volumes --remove-orphans --timeout 30`, then the three
// tags with one `image rm` (decision 47 of the rationale), never aborted and within the tier grace of 180000 ms, then
// remove the `mkdtemp` folder and write `result.json` with the reason. Every fixture is written at runtime in a
// `mkdtemp` folder; the checkout `.local/feature-13/` is never touched.

afterEach(removeWorkspaces);

const root = resolve(import.meta.dir, '../../..');
const moduleUrl = join(root, 'tests/orchestration/deployment-real.ts');
const TIER_GRACE_MS = 180_000;
/** AC-11: the exit code of each signal, written here from the criterion. */
const EXIT_CODES: Readonly<Record<HandledSignal, number>> = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };

test('DEP-008 the orchestration exits 143 after SIGTERM, 130 after SIGINT, and 129 after SIGHUP', () => {
  expect(SIGNAL_EXIT_CODES).toEqual(EXIT_CODES);
});

/** The files the pre-run checks and the copy read: package.json, both pin files, the Dockerfiles, and one migration. */
async function runWorkspace(extra: Record<string, string> = {}): Promise<string> {
  const copied = [
    'package.json',
    'tests/performance/images.json',
    'infrastructure/postgres/pins.json',
    'apps/frontend/Dockerfile',
    'apps/frontend/Dockerfile.dockerignore',
    'apps/backend/Dockerfile',
    'apps/backend/Dockerfile.dockerignore',
    'database/Dockerfile',
    'database/Dockerfile.dockerignore',
  ];
  const files: Record<string, string> = { 'database/migrations/0001-fixture.sql': 'SELECT 1;\n', '.local/feature-13/keep.txt': 'kept\n', ...extra };
  for (const path of copied) files[path] = await readFile(join(root, path), 'utf8');
  return workspace(files, 'foundation-deploy-test-');
}

async function baseImage(): Promise<string> {
  return (JSON.parse(await readFile(join(root, 'infrastructure/postgres/pins.json'), 'utf8')) as { baseImage: string }).baseImage;
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const ok = (stdout = '', stderr = ''): ProcessGroupResult => ({ code: 0, timedOut: false, aborted: false, stdout, stderr });
const failed = (stdout = '', stderr = ''): ProcessGroupResult => ({ code: 1, timedOut: false, aborted: false, stdout, stderr });
const untilAborted = (signal: AbortSignal | undefined) =>
  new Promise<ProcessGroupResult>((done) => {
    const finish = () => done({ code: null, timedOut: false, aborted: true, stdout: '', stderr: '' });
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
  });

type Recorded = { argv: string[]; options: ProcessGroupOptions };

/** The service of a `compose ... up -d --wait <service>` argv, or `null` for any other command. */
function upService(argv: readonly string[]): string | null {
  const at = argv.indexOf('up');
  return argv[1] === 'compose' && at > 0 && argv[at + 1] === '-d' && argv[at + 2] === '--wait' ? (argv[at + 3] ?? null) : null;
}

/**
 * A command runner that answers every step up to the upstream stub the way a healthy topology would: the tools, both
 * certificates (written where `-keyout` and `-out` point), the pins, the builds, readiness 503 before and 200 after the
 * migration, the default runner command with `Use --apply`, the migration counts, and the account job of spec 0014
 * (`Account created` once per email, then `Account exists`). `hold` decides which call waits
 * until it is aborted; `onHold` runs when that call arrives.
 */
async function fakeRunner(
  hold: (argv: readonly string[]) => boolean,
  onHold: () => void,
  override: (argv: readonly string[]) => ProcessGroupResult | undefined = () => undefined,
): Promise<{ calls: Recorded[]; run: CommandRunner; heldAt: () => number; envText: () => string }> {
  const base = await baseImage();
  const calls: Recorded[] = [];
  let envText = '';
  let hex = '';
  let migrated = false;
  const accounts = new Set<string>();
  let held = -1;
  const answer = async (argv: readonly string[], options: ProcessGroupOptions): Promise<ProcessGroupResult> => {
    const args = argv.join(' ');
    const label = argv.find((item) => item.startsWith('foundation.run='));
    if (label !== undefined) hex = label.slice('foundation.run='.length);
    if (hold(argv)) {
      held = calls.length - 1;
      onHold();
      return untilAborted(options.signal);
    }
    const chosen = override(argv);
    if (chosen !== undefined) return chosen;
    if (argv[0] === 'openssl') {
      if (argv[1] === 'version') return ok('OpenSSL 3.5.0 1 Jul 2025\n');
      for (const flag of ['-keyout', '-out']) {
        const at = argv.indexOf(flag);
        if (at > 0) await writeFile(argv[at + 1]!, `${flag} fixture\n`);
      }
      return ok();
    }
    if (argv[0] === 'tar') return failed('', 'tar: no archive\n');
    if (args === `docker image inspect --format {{json .Config.Labels}} foundation-postgres:18-pinned`) return ok(`${JSON.stringify({ 'org.opencontainers.image.base.name': base })}\n`);
    if (args.startsWith('docker image inspect --format {{.Id}}')) return ok(`sha256:${'0'.repeat(64)}\n`);
    if (args.startsWith('docker image inspect ')) return ok('[{}]\n');
    if (args.endsWith(' ps -a -q backend')) return ok('abcdef012345\n');
    if (args.startsWith('docker inspect --format {{json .State.StartedAt}}')) return ok(`"2026-10-05T00:00:00Z"|0|{"foundation.run":"${hex}"}\n`);
    if (args.includes(' exec -T backend bun --no-env-file -e ')) {
      return ok(`${JSON.stringify(migrated ? { status: 200, body: '{"status":"ready"}', cacheControl: 'no-store' } : { status: 503, body: '{"status":"unavailable"}', cacheControl: 'no-store' })}\n`);
    }
    if (args.endsWith(` run -T --name foundation-deploy-migrate-${hex} migrate`)) return failed('', 'Use --apply\n');
    if (args.endsWith(' database/migrate.ts --apply')) {
      const text = migrated ? 'Migrations: 0 applied, 1 skipped\n' : 'Migrations: 1 applied, 0 skipped\n';
      migrated = true;
      return ok(text);
    }
    if (args.endsWith(' database/seed.ts --apply')) return ok('Seeds: 0 executed\n');
    if (args.includes(' database/accounts.ts create --email ')) {
      const email = argv[argv.indexOf('--email') + 1]!;
      if (accounts.has(email)) return failed('', 'Account exists\n');
      accounts.add(email);
      return ok(`Account created: 00000000-0000-4000-8000-00000000000${accounts.size}\n`);
    }
    return ok();
  };
  const run: CommandRunner = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    // The env file as the engine would read it, for the leak check after the run removed it.
    const at = argv.indexOf('--env-file');
    if (at > 0 && envText === '') envText = await readFile(argv[at + 1]!, 'utf8');
    return answer(argv, options);
  };
  return { calls, run, heldAt: () => held, envText: () => envText };
}

/** The deps of a run against the stand in runner: no network, no wait, and output kept for the leak check. */
function deps(dir: string, run: CommandRunner, signal: AbortSignal, output: string[], extra: Partial<Parameters<typeof runDeployment>[0]> = {}) {
  return {
    root: dir,
    run,
    signal,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    sleep: async () => undefined,
    freePort: (() => {
      let port = 40_000;
      return async () => (port += 1);
    })(),
    edgeFetch: async () => 200,
    edgeHttp: async () => null,
    edgeRaw: async () => null,
    edgeH2: async () => null,
    log: (line: string) => output.push(line),
    error: (line: string) => output.push(line),
    ...extra,
  };
}

/** The `--env-file` of the first compose call: the mkdtemp folder of the run holds it. */
function envFileOf(calls: readonly Recorded[]): string {
  const call = calls.find((item) => item.argv[1] === 'compose' && item.argv.includes('--env-file'))!;
  return call.argv[call.argv.indexOf('--env-file') + 1]!;
}

const composeArgs = (project: string, envFile: string, ...rest: string[]) => ['docker', 'compose', '-p', project, '--env-file', envFile, '-f', COMPOSE_FILE, '-f', COMPOSE_TEST_FILE, ...rest];

async function resultOf(dir: string): Promise<DeploymentResult> {
  return JSON.parse(await readFile(join(dir, '.local/feature-13/result.json'), 'utf8')) as DeploymentResult;
}

for (const [signal, code] of Object.entries(EXIT_CODES) as [HandledSignal, number][]) {
  test(`DEP-008 ${signal} while the upstream stub starts removes the stub and runner containers, then the project, then the three tags, and exits ${code}`, async () => {
    const dir = await runWorkspace();
    const controller = new AbortController();
    const { calls, run, heldAt, envText } = await fakeRunner((argv) => argv[1] === 'run' && argv[2] === '-d' && argv[4]?.startsWith('foundation-deploy-stub-') === true, () => controller.abort(signal));
    const output: string[] = [];
    expect(await runDeployment(deps(dir, run, controller.signal, output))).toBe(code);

    const held = heldAt();
    expect(held).toBeGreaterThan(0);
    const names = deploymentNames(calls[held]!.argv[4]!.slice('foundation-deploy-stub-'.length));
    const envFile = envFileOf(calls);
    const cleanup = calls.slice(held + 1);
    expect(cleanup.map((call) => call.argv)).toEqual([
      ['docker', 'rm', '-f', names.migrate, names.stub],
      composeArgs(names.project, envFile, 'down', '--volumes', '--remove-orphans', '--timeout', '30'),
      ['docker', 'image', 'rm', names.tags.frontend, names.tags.backend, names.tags.migrate],
    ]);
    // Cleanup is never aborted and keeps the limits of Batas waktu perintah, together well inside the tier grace.
    expect(cleanup.map((call) => [call.options.signal, call.options.timeoutMs])).toEqual([
      [undefined, TIMEOUTS.removeContainers],
      [undefined, TIMEOUTS.down],
      [undefined, TIMEOUTS.removeImages],
    ]);
    expect(TIMEOUTS.removeContainers + TIMEOUTS.down + TIMEOUTS.removeImages).toBe(135_000);
    expect(TIMEOUTS.removeContainers + TIMEOUTS.down + TIMEOUTS.removeImages).toBeLessThan(TIER_GRACE_MS);
    // The edge stub never started, and no call names another project.
    expect(calls.some((call) => call.argv.includes(names.edgeStub))).toBe(false);
    for (const call of calls) {
      const at = call.argv.indexOf('-p');
      if (at > 0) expect(projectAccepted(call.argv[at + 1]!, names.hex), call.argv.join(' ')).toBe(true);
    }
    // The mkdtemp folder is gone; the evidence folder keeps what the run did not write.
    expect(await exists(dirname(envFile))).toBe(false);
    expect(await readFile(join(dir, '.local/feature-13/keep.txt'), 'utf8')).toBe('kept\n');

    const result = await resultOf(dir);
    expect(result.status).toBe('failed');
    expect(result.reasons.filter((reason) => reason.code === 'signal')).toEqual([{ code: 'signal', detail: signal }]);
    expect(result.checks.map((check) => check.name)).toEqual(DEPLOYMENT_CHECKS.map((check) => check.name));
    const status = Object.fromEntries(result.checks.map((check) => [check.name, check.status]));
    expect([status['migration_step'], status['readiness_after_migration'], status['api_stub_forwarding'], status['browser_flow'], status['cleanup']]).toEqual([
      'passed', 'passed', 'not_run', 'not_run', 'passed',
    ]);
    // The passwords and DSNs of the env file never reach the console or result.json.
    const secrets = [...envText().matchAll(/^FOUNDATION_(?:POSTGRES_PASSWORD|BACKEND_DATABASE_URL|MIGRATOR_DATABASE_URL)=(\S+)$/gm)].map((match) => match[1]!);
    expect(secrets).toHaveLength(3);
    const written = `${output.join('\n')}\n${await readFile(join(dir, '.local/feature-13/result.json'), 'utf8')}`;
    for (const value of secrets) expect(written).not.toContain(value);
    expect(output.join('\n')).toContain(`deployment: run ${names.hex} dimulai (project ${names.project})`);
  }, 30_000);
}

test('DEP-008 the total deadline during compose up --wait leaves the later checks not_run, records timeout, and still cleans up through the guard', async () => {
  const dir = await runWorkspace();
  const { calls, run, heldAt } = await fakeRunner((argv) => upService(argv) === 'backend', () => undefined);
  const output: string[] = [];
  const started = Date.now();
  const code = await runDeployment(deps(dir, run, new AbortController().signal, output, { deadlineMs: 3_000 }));
  expect(code).toBe(1);
  expect(Date.now() - started).toBeLessThan(15_000);

  const held = heldAt();
  expect(held).toBeGreaterThan(0);
  const project = calls[held]!.argv[calls[held]!.argv.indexOf('-p') + 1]!;
  const names = deploymentNames(project.slice('foundation-deploy-'.length));
  // The deadline aborted the held call through its own signal; nothing but cleanup ran after it.
  expect(calls[held]!.options.signal?.aborted).toBe(true);
  expect(calls.slice(held + 1).map((call) => call.argv)).toEqual([
    composeArgs(names.project, envFileOf(calls), 'down', '--volumes', '--remove-orphans', '--timeout', '30'),
    ['docker', 'image', 'rm', names.tags.frontend, names.tags.backend, names.tags.migrate],
  ]);
  expect(await exists(dirname(envFileOf(calls)))).toBe(false);
  const result = await resultOf(dir);
  expect(result.reasons).toContainEqual({ code: 'timeout', detail: 'backend' });
  expect(result.reasons.some((reason) => reason.code === 'signal')).toBe(false);
  const status = Object.fromEntries(result.checks.map((check) => [check.name, check.status]));
  expect(status['provisioning_step']).toBe('passed');
  const later = DEPLOYMENT_CHECKS.map((check) => check.name).slice(DEPLOYMENT_CHECKS.findIndex((check) => check.name === 'readiness_before_migration'), -2);
  for (const name of later) expect(status[name], name).toBe('not_run');
  expect(status['cleanup']).toBe('passed');
}, 30_000);

/** The `compose ... up -d --wait edge` call, held until the total deadline: the runner container of AC-3 exists by then. */
const holdEdge = (argv: readonly string[]) => upService(argv) === 'edge';
const isRemoveContainers = (argv: readonly string[]) => argv[1] === 'rm' && argv[2] === '-f';
const isDown = (argv: readonly string[]) => argv[1] === 'compose' && argv.includes('down');
const isImageRemove = (argv: readonly string[]) => argv[1] === 'image' && argv[2] === 'rm';

/** Runs to the total deadline at `compose up -d --wait edge`, with `override` answering chosen commands. */
async function deadlineRun(override: (argv: readonly string[]) => ProcessGroupResult | undefined) {
  const dir = await runWorkspace();
  const { calls, run, heldAt } = await fakeRunner(holdEdge, () => undefined, override);
  const output: string[] = [];
  const code = await runDeployment(deps(dir, run, new AbortController().signal, output, { deadlineMs: 3_000 }));
  const held = heldAt();
  expect(held).toBeGreaterThan(0);
  const project = calls[held]!.argv[calls[held]!.argv.indexOf('-p') + 1]!;
  const names = deploymentNames(project.slice('foundation-deploy-'.length));
  return { dir, calls, code, held, names, envFile: envFileOf(calls), output, result: await resultOf(dir) };
}

test('DEP-008 a failed rm -f still runs compose down and image rm, removes the folder, records cleanup_failed, and exits 1', async () => {
  const run = await deadlineRun((argv) => (isRemoveContainers(argv) ? failed('', 'Error response from daemon: fixture\n') : undefined));
  expect(run.code).toBe(1);
  expect(run.calls.slice(run.held + 1).map((call) => call.argv)).toEqual([
    ['docker', 'rm', '-f', run.names.migrate],
    composeArgs(run.names.project, run.envFile, 'down', '--volumes', '--remove-orphans', '--timeout', '30'),
    ['docker', 'image', 'rm', run.names.tags.frontend, run.names.tags.backend, run.names.tags.migrate],
  ]);
  expect(await exists(dirname(run.envFile))).toBe(false);
  const cleanup = run.result.checks.find((check) => check.name === 'cleanup');
  expect(cleanup?.status).toBe('failed');
  expect(cleanup?.detail).toBe(run.names.migrate);
  expect(run.result.reasons).toContainEqual({ code: 'cleanup_failed', detail: run.names.migrate });
  expect(run.result.status).toBe('failed');
  expect(run.output.join('\n')).toContain(`hapus resource berlabel foundation.run=${run.names.hex} dengan tangan`);
}, 30_000);

test('DEP-008 a failed compose down still runs image rm and removes the folder, then records cleanup_failed with the project', async () => {
  const run = await deadlineRun((argv) => (isDown(argv) ? failed('', 'fixture down failure\n') : undefined));
  expect(run.code).toBe(1);
  expect(run.calls.slice(run.held + 1).map((call) => call.argv)).toEqual([
    ['docker', 'rm', '-f', run.names.migrate],
    composeArgs(run.names.project, run.envFile, 'down', '--volumes', '--remove-orphans', '--timeout', '30'),
    ['docker', 'image', 'rm', run.names.tags.frontend, run.names.tags.backend, run.names.tags.migrate],
  ]);
  expect(await exists(dirname(run.envFile))).toBe(false);
  expect(run.result.reasons).toContainEqual({ code: 'cleanup_failed', detail: run.names.project });
  expect(run.result.checks.find((check) => check.name === 'cleanup')?.status).toBe('failed');
}, 30_000);

test('DEP-008 a failed image rm other than a missing tag still removes the folder and records cleanup_failed with the tags, while missing tags alone pass', async () => {
  const tags = (names: ReturnType<typeof deploymentNames>) => `${names.tags.frontend} ${names.tags.backend} ${names.tags.migrate}`;
  const broken = await deadlineRun((argv) => (isImageRemove(argv) ? failed('', 'Error response from daemon: conflict: unable to remove repository reference (fixture)\n') : undefined));
  expect(broken.code).toBe(1);
  expect(await exists(dirname(broken.envFile))).toBe(false);
  expect(broken.result.reasons).toContainEqual({ code: 'cleanup_failed', detail: tags(broken.names) });

  const missing = await deadlineRun((argv) => {
    if (!isImageRemove(argv)) return undefined;
    return failed('', `${argv.slice(3).map((tag) => `Error response from daemon: No such image: ${tag}`).join('\n')}\n`);
  });
  expect(missing.result.checks.find((check) => check.name === 'cleanup')?.status).toBe('passed');
  expect(missing.result.reasons.some((reason) => reason.code === 'cleanup_failed')).toBe(false);
}, 60_000);

const preRunFailures: [string, (argv: readonly string[]) => ProcessGroupResult | undefined, Reason, (argv: readonly string[]) => boolean][] = [
  ['the container engine is missing', (argv) => (argv.join(' ') === 'docker version' ? failed('', 'command not found\n') : undefined), { code: 'tool_missing', detail: 'docker' }, () => false],
  ['a base image pull fails', (argv) => (argv[1] === 'pull' && argv[2]!.startsWith('nginx:') ? failed('', 'pull fixture failure\n') : undefined), { code: 'image_pull_failed', detail: 'nginx' }, () => false],
  ['the backend image build fails', (argv) => (argv[1] === 'build' && argv[3]!.endsWith('apps/backend/Dockerfile') ? failed('', 'build fixture failure\n') : undefined), { code: 'image_build_failed', detail: 'backend' }, isImageRemove],
  ['compose up postgres fails', (argv) => (upService(argv) === 'postgres' ? failed('', 'up fixture failure\n') : undefined), { code: 'compose_failed', detail: 'postgres' }, (argv) => isDown(argv) || isImageRemove(argv)],
];
for (const [label, override, reason, cleanupCall] of preRunFailures) {
  test(`DEP-008 when ${label} the run records ${reason.code}, still cleans up what it created, and exits 1`, async () => {
    const dir = await runWorkspace();
    const { calls, run } = await fakeRunner(() => false, () => undefined, override);
    const output: string[] = [];
    expect(await runDeployment(deps(dir, run, new AbortController().signal, output))).toBe(1);
    const result = await resultOf(dir);
    expect(result.status).toBe('failed');
    expect(result.reasons).toContainEqual(reason);
    expect(result.checks.find((check) => check.name === 'cleanup')?.status).toBe('passed');
    // Cleanup ran the removal of what existed by then, and the run folder (when one was made) is gone.
    const failedAt = calls.findIndex((call) => override(call.argv) !== undefined);
    expect(failedAt).toBeGreaterThanOrEqual(0);
    const after = calls.slice(failedAt + 1).map((call) => call.argv);
    expect(after.every(cleanupCall), after.map((argv) => argv.join(' ')).join('\n')).toBe(true);
    const folders = calls.flatMap((call) => call.argv.filter((item) => item.includes(`${tmpdir()}`) && item.includes('foundation-deploy-')));
    for (const path of folders) expect(await exists(path), path).toBe(false);
  }, 30_000);
}

/** A fake clock: `sleep` moves time on at once, so the waiting loops of the orchestration end without real waiting. */
function fakeClock() {
  let at = Date.now();
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

/** The network and whether the probe asks 1.1.1.1:443, for a `docker run --rm --name foundation-deploy-probe-...` argv. */
function egressProbe(argv: readonly string[]): 'public' | 'app' | 'data' | null {
  if (argv[1] !== 'run' || argv[2] !== '--rm' || !argv[4]?.startsWith('foundation-deploy-probe-')) return null;
  if (!argv.at(-1)!.includes('"host":"1.1.1.1"')) return null;
  return argv[argv.indexOf('--network') + 1]!.split('_').pop() as 'public' | 'app' | 'data';
}

const probeLine = (result: 'ok' | 'fail') => ok(`${JSON.stringify({ result, code: result === 'ok' ? null : 'timeout', status: null, body: null, ms: result === 'ok' ? 5 : 3000 })}\n`);

/** Runs up to the browser flow, which holds until SIGTERM, with the egress probes answered as `answers` says. */
async function egressRun(answers: Readonly<Record<'public' | 'app' | 'data', 'ok' | 'fail'>>) {
  const dir = await runWorkspace();
  const controller = new AbortController();
  const holdBrowser = (argv: readonly string[]) => argv[0] === 'node' && argv.includes('playwright.deployment.config.ts');
  const { calls, run, heldAt } = await fakeRunner(holdBrowser, () => controller.abort('SIGTERM'), (argv) => {
    const network = egressProbe(argv);
    return network === null ? undefined : probeLine(answers[network]);
  });
  const output: string[] = [];
  const code = await runDeployment(deps(dir, run, controller.signal, output, fakeClock()));
  expect(heldAt()).toBeGreaterThan(0);
  const result = await resultOf(dir);
  return { code, result, asked: calls.map((call) => egressProbe(call.argv)).filter((network) => network !== null), output };
}

test('DEP-008 AC-8: a failed public control probe leaves egress_blocked not_run with reason egress_control_failed, and the internal networks are not probed', async () => {
  const run = await egressRun({ public: 'fail', app: 'fail', data: 'fail' });
  expect(run.asked).toEqual(['public']);
  const egress = run.result.checks.find((check) => check.name === 'egress_blocked');
  expect(egress?.status).toBe('not_run');
  expect(egress?.detail).toBe('kontrol public ke 1.1.1.1:443 gagal timeout');
  expect(run.result.reasons).toContainEqual({ code: 'egress_control_failed', detail: 'kontrol public ke 1.1.1.1:443 gagal timeout' });
  expect(run.result.status).toBe('failed');
  expect(run.code).not.toBe(0);
  expect(run.output.join('\n')).toContain('deployment: check egress_blocked not_run: kontrol public ke 1.1.1.1:443 gagal timeout');
}, 60_000);

test('DEP-008 AC-8: after a working public control, egress_blocked passes only when app and data both fail to reach 1.1.1.1:443', async () => {
  const blocked = await egressRun({ public: 'ok', app: 'fail', data: 'fail' });
  expect(blocked.asked).toEqual(['public', 'app', 'data']);
  expect(blocked.result.checks.find((check) => check.name === 'egress_blocked')?.status).toBe('passed');
  expect(blocked.result.reasons.some((reason) => reason.code === 'egress_control_failed')).toBe(false);

  const leaking = await egressRun({ public: 'ok', app: 'ok', data: 'fail' });
  const egress = leaking.result.checks.find((check) => check.name === 'egress_blocked');
  expect(egress?.status).toBe('failed');
  expect(egress?.detail).toContain('app ke 1.1.1.1:443 ok');
  expect(leaking.result.reasons.some((reason) => reason.code === 'egress_control_failed')).toBe(false);
}, 60_000);

test('DEP-008 a signal during cleanup is recorded in result.json and decides the exit code', async () => {
  const dir = await runWorkspace();
  const controller = new AbortController();
  const { run } = await fakeRunner(holdEdge, () => undefined, (argv) => {
    if (isImageRemove(argv)) controller.abort('SIGINT');
    return undefined;
  });
  expect(await runDeployment(deps(dir, run, controller.signal, [], { deadlineMs: 3_000 }))).toBe(130);
  const result = await resultOf(dir);
  expect(result.reasons).toContainEqual({ code: 'signal', detail: 'SIGINT' });
  expect(result.checks.find((check) => check.name === 'cleanup')?.status).toBe('passed');
}, 30_000);

test('DEP-008 a signal that arrives after cleanup, while the evidence is scanned and result.json is written, still decides the exit code', async () => {
  const dir = await runWorkspace();
  const controller = new AbortController();
  const { run } = await fakeRunner(holdEdge, () => undefined);
  const output: string[] = [];
  // The summary line comes after result.json; a SIGTERM there must not be swallowed by the still installed handlers.
  const log = (line: string) => {
    output.push(line);
    if (/^deployment: \d+ check passed, /.test(line)) controller.abort('SIGTERM');
  };
  expect(await runDeployment(deps(dir, run, controller.signal, output, { deadlineMs: 3_000, log }))).toBe(143);
}, 30_000);

test('DEP-008 the project guard refuses a foreign project or one that does not match the pattern, so cleanup never runs compose down for it', () => {
  const names = deploymentNames('00112233aabb');
  expect(projectAccepted(names.project, names.hex)).toBe(true);
  for (const project of ['foundation', 'foundation-deploy', 'foundation-deploy-ffffffffffff', 'foundation-deploy-00112233AABB', `${names.project}-x`, 'foundation-perf-net-00112233aabb']) {
    expect(projectAccepted(project, names.hex), project).toBe(false);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// `main` as its own process group with a fake `docker` and `openssl` at the front of PATH.

/**
 * Fake `docker`: logs every call next to itself, records the `foundation.run` label and the content of every
 * `--env-file`, answers the steps up to the edge as a healthy topology would (the account job of spec 0014 included),
 * and holds `compose ... up -d --wait <hold>` in a `sleep` until the orchestration stops it.
 */
const fakeDocker = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
printf '%s\\n' "$*" >> "$here/../docker.log"
previous=''
for argument in "$@"; do
  case "$argument" in
    foundation.run=*) printf '%s' "\${argument#foundation.run=}" > "$here/../run-label" ;;
  esac
  if [ "$previous" = "--env-file" ]; then cat "$argument" >> "$here/../env-files"; fi
  previous="$argument"
done
all="$*"
hold=$(cat "$here/hold")
case "$all" in
  *" up -d --wait $hold") exec sleep 600 ;;
  "image inspect --format {{json .Config.Labels}} foundation-postgres:18-pinned") cat "$here/postgres-labels.json" ;;
  "image inspect --format {{.Id}} "*) echo 'sha256:0000' ;;
  "image inspect "*) echo '[{}]' ;;
  *" ps -a -q backend") echo 'abcdef012345' ;;
  "inspect --format {{json .State.StartedAt}}"*) printf '"2026-10-05T00:00:00Z"|0|{"foundation.run":"%s"}\\n' "$(cat "$here/../run-label")" ;;
  *" exec -T backend bun --no-env-file -e "*)
    if [ -f "$here/../migrated" ]; then echo '{"status":200,"body":"{\\"status\\":\\"ready\\"}","cacheControl":"no-store"}'
    else echo '{"status":503,"body":"{\\"status\\":\\"unavailable\\"}","cacheControl":"no-store"}'; fi ;;
  *" run -T --name foundation-deploy-migrate-"*" migrate") echo 'Use --apply' >&2; exit 1 ;;
  *" database/migrate.ts --apply")
    if [ -f "$here/../migrated" ]; then echo 'Migrations: 0 applied, 1 skipped'; else : > "$here/../migrated"; echo 'Migrations: 1 applied, 0 skipped'; fi ;;
  *" database/seed.ts --apply") echo 'Seeds: 0 executed' ;;
  *" database/accounts.ts create --email "*)
    email=''
    previous=''
    for argument in "$@"; do
      if [ "$previous" = "--email" ]; then email="$argument"; fi
      previous="$argument"
    done
    mkdir -p "$here/../accounts"
    if [ -f "$here/../accounts/$email" ]; then echo 'Account exists' >&2; exit 1; fi
    : > "$here/../accounts/$email"
    echo 'Account created: 00000000-0000-4000-8000-000000000001' ;;
esac
exit 0
`;

/** Fake `openssl`: `OpenSSL 3` for the tool check, and a file at every `-keyout` and `-out` of `req`. */
const fakeOpenssl = `#!/bin/sh
case "$1" in
  version) echo 'OpenSSL 3.5.0 1 Jul 2025 (fixture)' ;;
  req)
    previous=''
    for argument in "$@"; do
      if [ "$previous" = "-keyout" ] || [ "$previous" = "-out" ]; then printf 'fixture\\n' > "$argument"; fi
      previous="$argument"
    done
    ;;
esac
exit 0
`;

async function processWorkspace(hold: string): Promise<string> {
  const dir = await runWorkspace({
    'run.ts': `import { main } from ${JSON.stringify(moduleUrl)};\nprocess.exitCode = await main({ root: process.cwd() });\n`,
    'bin/docker': fakeDocker,
    'bin/openssl': fakeOpenssl,
    'bin/hold': `${hold}\n`,
    'bin/postgres-labels.json': `${JSON.stringify({ 'org.opencontainers.image.base.name': await baseImage() })}\n`,
  });
  await chmod(join(dir, 'bin/docker'), 0o755);
  await chmod(join(dir, 'bin/openssl'), 0o755);
  return dir;
}

async function dockerLog(dir: string): Promise<string[]> {
  try {
    return (await readFile(join(dir, 'docker.log'), 'utf8')).split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

async function waitUntil(check: () => Promise<boolean>, limitMs: number): Promise<boolean> {
  for (const deadline = Date.now() + limitMs; Date.now() < deadline; await Bun.sleep(50)) {
    if (await check()) return true;
  }
  return false;
}

function start(dir: string, home: string) {
  const child = spawn(process.execPath, ['--no-env-file', 'run.ts'], {
    cwd: dir,
    env: { PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`, HOME: home, TMPDIR: home },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  const text = () => ({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  return { pgid: child.pid!, exited, text };
}

const cases: [HandledSignal, string][] = [['SIGTERM', 'edge'], ['SIGINT', 'edge'], ['SIGHUP', 'edge'], ['SIGTERM', 'postgres']];
for (const [signal, hold] of cases) {
  const expected = EXIT_CODES[signal];
  test(`DEP-008 ${signal} to main while compose up --wait ${hold} holds runs rm -f, compose down, and image rm by explicit name, removes the folder, and exits ${expected}`, async () => {
    const dir = await processWorkspace(hold);
    const home = await emptyWorkspace('foundation-deploy-home-');
    const child = start(dir, home);
    let stoppedAt = 0;
    try {
      const held = (line: string) => line.startsWith('compose -p foundation-deploy-') && line.endsWith(` up -d --wait ${hold}`);
      expect(await waitUntil(async () => (await dockerLog(dir)).some(held), 30_000)).toBe(true);
      await Bun.sleep(300);
      stoppedAt = Date.now();
      process.kill(-child.pgid, signal);
      expect(await child.exited).toBe(expected);
      expect(Date.now() - stoppedAt).toBeLessThan(TIER_GRACE_MS);
      expect(await waitUntil(async () => !(await groupAlive(child.pgid)), 10_000)).toBe(true);
    } finally {
      try {
        process.kill(-child.pgid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    }

    const log = await dockerLog(dir);
    const heldLine = log.findIndex((line) => line.endsWith(` up -d --wait ${hold}`));
    const project = /^compose -p (foundation-deploy-[0-9a-f]{12}) /.exec(log[heldLine]!)![1]!;
    const names = deploymentNames(project.slice('foundation-deploy-'.length));
    expect(await readFile(join(dir, 'run-label'), 'utf8')).toBe(names.hex);
    const envFile = /--env-file (\S+)/.exec(log[heldLine]!)![1]!;
    const down = `compose -p ${names.project} --env-file ${envFile} -f ${COMPOSE_FILE} -f ${COMPOSE_TEST_FILE} down --volumes --remove-orphans --timeout 30`;
    const images = `image rm ${names.tags.frontend} ${names.tags.backend} ${names.tags.migrate}`;
    // The stopped runner container of AC-3 exists once the default command ran, so only the edge hold has a named container.
    expect(log.slice(heldLine + 1)).toEqual(hold === 'edge' ? [`rm -f ${names.migrate}`, down, images] : [down, images]);
    // The mkdtemp folder under TMPDIR is gone, and the admin password never reached the output or result.json.
    expect((await readdir(home)).filter((name) => name.startsWith('foundation-deploy-'))).toEqual([]);
    const password = /FOUNDATION_POSTGRES_PASSWORD=([0-9a-f]{48})/.exec(await readFile(join(dir, 'env-files'), 'utf8'))![1]!;
    const { stdout, stderr } = child.text();
    expect(stdout + stderr).not.toContain(password);
    expect(stderr).toContain(`deployment: failed (`);
    expect(stderr).toContain(`signal ${signal}`);
    const text = await readFile(join(dir, '.local/feature-13/result.json'), 'utf8');
    expect(text).not.toContain(password);
    const result = JSON.parse(text) as DeploymentResult;
    expect(result.reasons.filter((reason) => reason.code === 'signal')).toEqual([{ code: 'signal', detail: signal }]);
    expect(result.checks.find((check) => check.name === 'cleanup')?.status).toBe('passed');
    expect(result.checks.find((check) => check.name === 'image_pins')?.status).toBe('passed');
    expect(await readFile(join(dir, '.local/feature-13/keep.txt'), 'utf8')).toBe('kept\n');
  }, 60_000);
}

test('DEP-008 main exits 1 at once, without waiting for the total deadline, when the evidence folder cannot be prepared', async () => {
  // The total deadline timer of DEPLOYMENT_DEADLINE_MS must not keep the process alive after the run gave up: here
  // `.local` is a file, so creating `.local/feature-13/` fails before any command runs.
  const dir = await processWorkspace('edge');
  await rm(join(dir, '.local'), { recursive: true, force: true });
  await writeFile(join(dir, '.local'), 'not a folder\n');
  const home = await emptyWorkspace('foundation-deploy-home-');
  const child = start(dir, home);
  try {
    expect(await Promise.race([child.exited, Bun.sleep(15_000).then(() => 'still running' as const)])).toBe(1);
  } finally {
    try {
      process.kill(-child.pgid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }
  expect(child.text().stderr).toContain('deployment: run tidak dapat diselesaikan');
  expect(await dockerLog(dir)).toEqual([]);
}, 30_000);
