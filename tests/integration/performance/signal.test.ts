import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ProcessGroupOptions, ProcessGroupResult } from '../../../scripts/lib/process-group.ts';
import { groupAlive } from '../../../scripts/lib/process-identity.ts';
import {
  BACKEND_POLL_SCRIPT,
  CLOCK_SCRIPT,
  EXPECTED_BACKEND_STDOUT,
  runProfile,
  TIMEOUTS,
  USAGE,
  worstCaseCleanupMs,
  type CommandRunner,
  type PoolCounts,
  type RunDeps,
} from '../../orchestration/performance-real.ts';
import { PROFILE_NAMES, profileSeconds, T0_DELAY_MS, type ProfileName } from '../../performance/helpers/plan.ts';
import { emptyWorkspace, removeWorkspaces, workspace } from '../gate/workspace.ts';

// PERF-009 (spec 0011, AC-2 and AC-10), without real Docker: (a) `runProfile` with a stand in command runner, aborted
// while preparing, running, and evaluating, and on the outage profile the stop and start of PostgreSQL through the guard
// with a fast clock, also when a signal arrives between them; (b) `main` as its own process group with a fake `docker`
// at the front of PATH, receiving SIGTERM, SIGINT, and SIGHUP while it waits for `SELECT 1`; (c) an invalid profile
// argument exits 2 without a `docker` call and without touching `.local/feature-12/`. Every fixture is written at
// runtime in a `mkdtemp` folder; the real `k6 inspect` output of each profile comes from `fixtures/`.

afterEach(removeWorkspaces);

const root = resolve(import.meta.dir, '../../..');
const moduleUrl = join(root, 'tests/orchestration/performance-real.ts');
const inspectFixture = (profile: ProfileName) => join(import.meta.dir, `fixtures/inspect-${profile}.json`);

/** A workspace with the files the pre-run checks read: package.json, the pins, and one migration. */
async function runWorkspace(extra: Record<string, string> = {}): Promise<string> {
  return workspace(
    {
      'package.json': await readFile(join(root, 'package.json'), 'utf8'),
      'tests/performance/images.json': await readFile(join(root, 'tests/performance/images.json'), 'utf8'),
      'infrastructure/postgres/pins.json': await readFile(join(root, 'infrastructure/postgres/pins.json'), 'utf8'),
      'database/migrations/0001-fixture.sql': 'SELECT 1;\n',
      ...extra,
    },
    'foundation-perf-test-',
  );
}

async function baseImage(): Promise<string> {
  return (JSON.parse(await readFile(join(root, 'infrastructure/postgres/pins.json'), 'utf8')) as { baseImage: string }).baseImage;
}

type Recorded = { argv: string[]; options: ProcessGroupOptions };
type BlockAt = 'preparing' | 'running' | 'evaluating' | 'none';

const ok = (stdout = ''): ProcessGroupResult => ({ code: 0, timedOut: false, aborted: false, stdout, stderr: '' });
const untilAborted = (signal: AbortSignal | undefined) =>
  new Promise<ProcessGroupResult>((done) => {
    const finish = () => done({ code: null, timedOut: false, aborted: true, stdout: '', stderr: '' });
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
  });

/**
 * A command runner that answers every pre-run check (the real `k6 inspect` output of the profile in the last argument)
 * and the environment read, gives one `docker stats` line per container through `onOutput` and then runs like a real
 * stream until it is stopped, and blocks at `docker start -a` or `docker logs` until aborted. `k6` replaces the answer
 * of `docker start -a`, and `after` sees every call once it was answered.
 */
async function fakeRunner(
  block: BlockAt,
  abort: () => void,
  hooks: { k6?: (options: ProcessGroupOptions) => Promise<ProcessGroupResult>; after?: (argv: string[]) => void } = {},
): Promise<{ calls: Recorded[]; run: CommandRunner }> {
  const base = await baseImage();
  const inspected = Object.fromEntries(await Promise.all(PROFILE_NAMES.map(async (profile) => [profile, await readFile(inspectFixture(profile), 'utf8')] as const)));
  const calls: Recorded[] = [];
  const answer: CommandRunner = async (argv, options) => {
    const args = [...argv];
    const [, first, second] = args;
    if (first === 'version') return ok('"29.8.0"\n');
    if (first === 'info') return args.includes('{{json .OperatingSystem}}') ? ok('"Docker Desktop"\n') : ok('10 8319504384\n');
    if (first === 'ps') return args[2] === '-q' ? ok(args.includes('--filter') ? 'a1\nb2\n' : 'a1\nb2\nc3\n') : ok('');
    if (first === 'image') {
      if (args.includes('{{json .Id}}')) return ok('"sha256:0123"\n');
      return ok(`${JSON.stringify({ 'org.opencontainers.image.base.name': base })}\n`);
    }
    if (first === 'stats') {
      const lines = args.slice(4).map((name) => `\u001b[H${JSON.stringify({ Name: name, CPUPerc: '1.00%', MemUsage: '10MiB / 1GiB' })}\u001b[K\n`);
      options.onOutput?.('stdout', Buffer.from(lines.join('')), Date.now());
      return untilAborted(options.signal);
    }
    if (first === 'run' && second === '--rm') return ok(inspected[/\/scripts\/profiles\/([a-z]+)\.ts$/.exec(args.at(-1)!)![1]!]!);
    if (first === 'exec') return args.includes(CLOCK_SCRIPT) ? ok(`${Date.now()}\n`) : ok('{"status":200,"readiness":200,"appliedMigrations":1}\n');
    if (first === 'start' && second === '-a' && hooks.k6 !== undefined) return hooks.k6(options);
    if ((first === 'start' && block === 'running') || (first === 'logs' && block === 'evaluating')) {
      abort();
      return untilAborted(options.signal);
    }
    if ((first === 'container' || first === 'network') && second === 'inspect') {
      if (args[4]?.startsWith('{{json .State')) return ok('true 0 false\n');
      return ok(`${JSON.stringify({ 'foundation.test': 'performance', 'foundation.run': args.at(-1)!.slice(-12) })}\n`);
    }
    return ok();
  };
  const run: CommandRunner = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    const result = await answer(argv, options);
    hooks.after?.([...argv]);
    return result;
  };
  return { calls, run };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

for (const block of ['preparing', 'running', 'evaluating'] as const) {
  test(`PERF-009 runProfile aborted while ${block} cleans up through the guard in order, touches nothing it did not create, and records signal`, async () => {
    // covers: AC-2 (pembersihan pada setiap jalur keluar), AC-10 (credential tidak tercetak)
    const dir = await runWorkspace();
    const controller = new AbortController();
    const abort = () => controller.abort('SIGTERM');
    const { calls, run } = await fakeRunner(block, abort);
    const output: string[] = [];
    const code = await runProfile('smoke', {
      root: dir,
      run,
      provision: async () => ok('provisioned\n'),
      migrate: async () => ok('migrated\n'),
      now: Date.now,
      sleep: async () => {
        if (block === 'preparing') abort();
      },
      signal: controller.signal,
      selectOne: async () => block !== 'preparing',
      // A sample takes a few real milliseconds, so the sampler never spins without giving way to timers and I/O.
      poolClient: () => ({ sample: () => Bun.sleep(2).then(() => ({ sessions: 1, nonIdle: 0, total: 2 })), close: async () => undefined }),
      serverVersion: async () => '18.6',
      freePort: async () => 54321,
      env: { PATH: process.env['PATH'] ?? '' },
      uid: 501,
      gid: 20,
      log: (line) => output.push(line),
      error: (line) => output.push(line),
    });
    expect(code).toBe(143);

    const argvs = calls.map((call) => call.argv);
    const created = argvs.find((argv) => argv[1] === 'network' && argv[2] === 'create')!;
    const hex = created.at(-1)!.slice(-12);
    const names = {
      db: `foundation-perf-db-${hex}`,
      backend: `foundation-perf-backend-${hex}`,
      k6: `foundation-perf-k6-${hex}`,
      inspect: `foundation-perf-inspect-${hex}`,
      network: `foundation-perf-net-${hex}`,
    };
    const guard = (name: string) => ['docker', 'container', 'inspect', '--format', '{{json .Config.Labels}}', name];
    const remove = (name: string) => [guard(name), ['docker', 'rm', '-f', name]];
    const network = [['docker', 'network', 'inspect', '--format', '{{json .Labels}}', names.network], ['docker', 'network', 'rm', names.network]];
    const postgresRun = argvs.findIndex((argv) => argv[1] === 'run' && argv[2] === '-d' && argv[4] === names.db);
    const blocked = block === 'running' ? argvs.findIndex((argv) => argv[1] === 'start') : block === 'evaluating' ? argvs.findIndex((argv) => argv[1] === 'logs') : postgresRun;
    const cleanup = argvs.slice(blocked + 1);
    if (block === 'preparing') {
      expect(cleanup).toEqual([...remove(names.db), ...remove(names.inspect), ...network]);
      // Resources that were never created are never touched.
      expect(argvs.some((argv) => argv.includes(names.k6) || argv.includes(names.backend))).toBe(false);
    } else {
      expect(cleanup).toEqual([
        guard(names.k6), ['docker', 'stop', '--time', '10', names.k6],
        ...remove(names.k6), ...remove(names.backend), ...remove(names.db), ...remove(names.inspect), ...network,
      ]);
    }
    // Cleanup runs without the abort signal and within the limits of Batas waktu perintah.
    const cleanupCalls = calls.slice(blocked + 1);
    for (const call of cleanupCalls) expect(call.options.signal, call.argv.join(' ')).toBeUndefined();
    if (block !== 'preparing') {
      const total = cleanupCalls.reduce((sum, call) => sum + call.options.timeoutMs, 0) + TIMEOUTS.cancelMax + TIMEOUTS.streamsStop;
      expect(total).toBe(165_000);
    }
    expect(worstCaseCleanupMs()).toBe(165_000);

    // The mkdtemp folder that held the env files is gone.
    const envFile = argvs[postgresRun]![argvs[postgresRun]!.indexOf('--env-file') + 1]!;
    expect(await exists(dirname(envFile))).toBe(false);

    // One docker stats stream between `docker create` and `docker start -a` of k6, stopped before the run ended.
    const stats = calls.filter((call) => call.argv[1] === 'stats');
    if (block === 'preparing') {
      expect(stats).toEqual([]);
    } else {
      expect(stats.map((call) => call.argv)).toEqual([['docker', 'stats', '--format', '{{json .}}', names.db, names.backend, names.k6]]);
      expect(stats[0]!.options.output).toBe('pipe');
      expect(stats[0]!.options.onOutput).toBeDefined();
      expect(stats[0]!.options.outputLimitBytes).toBeUndefined();
      expect(stats[0]!.options.signal?.aborted).toBe(true);
      const statsAt = argvs.findIndex((argv) => argv[1] === 'stats');
      expect(argvs[statsAt - 1]?.[1]).toBe('create');
      expect(argvs[statsAt + 1]?.slice(0, 3)).toEqual(['docker', 'start', '-a']);
    }

    const result = JSON.parse(await readFile(join(dir, '.local/feature-12/smoke/result.json'), 'utf8'));
    expect(result.status).toBe('failed');
    expect(result.reasons).toEqual([{ code: 'signal', detail: 'SIGTERM' }]);
    // A signal ends the run before the judgement, so no observation checks; the samples are still written.
    expect(result.observation).toBeNull();
    const observation = JSON.parse(await readFile(join(dir, '.local/feature-12/smoke/observation.json'), 'utf8'));
    expect(observation.samples.containers.backend).toHaveLength(block === 'preparing' ? 0 : 1);
    const scan = JSON.parse(await readFile(join(dir, '.local/feature-12/smoke/artifact-scan.json'), 'utf8'));
    expect(scan.findings).toEqual([]);
    expect(scan.secretsChecked).toBe(6);
    expect(scan.filesScanned).toContain('.local/feature-12/smoke/observation.json');
    expect(output.at(-1)).toBe('performance smoke: failed (signal SIGTERM)');
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The outage profile: stop and start of PostgreSQL through the guard, with a clock that runs 100 times faster.

const SPEED = 100;

/** Deps of an outage run whose host clock runs `SPEED` times faster than real time, so T0 + 150 s comes in 1.5 s. */
function fastDeps(dir: string, run: CommandRunner, signal: AbortSignal, output: string[]): RunDeps {
  const origin = Date.now();
  return {
    root: dir,
    run,
    provision: async () => ok('provisioned\n'),
    migrate: async () => ok('migrated\n'),
    now: () => origin + (Date.now() - origin) * SPEED,
    sleep: (ms) => Bun.sleep(Math.max(1, ms / SPEED)),
    signal,
    selectOne: async () => true,
    poolClient: () => ({ sample: () => Bun.sleep(2).then(() => ({ sessions: 1, nonIdle: 0, total: 2 })), close: async () => undefined }),
    serverVersion: async () => '18.6',
    freePort: async () => 54321,
    env: { PATH: process.env['PATH'] ?? '' },
    uid: 501,
    gid: 20,
    log: (line) => output.push(line),
    error: (line) => output.push(line),
  };
}

const dbName = (calls: Recorded[]) => calls.find((call) => call.argv[1] === 'run' && call.argv[2] === '-d' && call.argv[4]!.startsWith('foundation-perf-db-'))!.argv[4]!;
const labelInspect = (name: string) => ['docker', 'container', 'inspect', '--format', '{{json .Config.Labels}}', name];

test('PERF-009 the outage run stops and starts only its own PostgreSQL through the guard, never before the schedule, then cleans up in order', async () => {
  // covers: AC-7 (stop pada T0 + 90 s dan start pada T0 + 150 s lewat penjaga), AC-2 (pembersihan sesudahnya)
  const dir = await runWorkspace();
  const controller = new AbortController();
  let started: () => void = () => undefined;
  const postgresStarted = new Promise<void>((done) => (started = done));
  const { calls, run } = await fakeRunner('none', () => controller.abort('SIGTERM'), {
    // k6 exits 0 once PostgreSQL was started again.
    k6: async () => {
      await postgresStarted;
      return ok();
    },
    after: (argv) => {
      if (argv[1] === 'start' && argv[2] !== '-a') started();
    },
  });
  const output: string[] = [];
  const code = await runProfile('outage', fastDeps(dir, run, controller.signal, output));
  // Without a k6 summary the run fails, but it is not a signal exit.
  expect(code).toBe(1);

  const db = dbName(calls);
  const argvs = calls.map((call) => call.argv);
  const k6Start = argvs.findIndex((argv) => argv[1] === 'start' && argv[2] === '-a');
  const afterK6 = argvs.findIndex((argv, index) => index > k6Start && argv[1] === 'ps');
  // Between the k6 start and the check after k6: exactly guard, stop, guard, start, all on the PostgreSQL of the run.
  expect(argvs.slice(k6Start + 1, afterK6)).toEqual([labelInspect(db), ['docker', 'stop', '--time', '10', db], labelInspect(db), ['docker', 'start', db]]);
  for (const call of calls.slice(k6Start + 1, afterK6)) {
    expect(call.options.timeoutMs, call.argv.join(' ')).toBe(call.argv[2] === 'inspect' ? TIMEOUTS.guardInspect : TIMEOUTS.outageControl);
    expect(call.options.signal, call.argv.join(' ')).toBe(controller.signal);
  }
  // Cleanup still runs in order after the outage.
  const hex = db.slice(-12);
  const remove = (name: string) => [labelInspect(name), ['docker', 'rm', '-f', name]];
  expect(argvs.slice(argvs.findIndex((argv) => argv[1] === 'logs') + 1)).toEqual([
    labelInspect(`foundation-perf-k6-${hex}`), ['docker', 'stop', '--time', '10', `foundation-perf-k6-${hex}`],
    // Only smoke runs k6 inspect, so the outage run never touches an inspect container.
    ...remove(`foundation-perf-k6-${hex}`), ...remove(`foundation-perf-backend-${hex}`), ...remove(db),
    ['docker', 'network', 'inspect', '--format', '{{json .Labels}}', `foundation-perf-net-${hex}`], ['docker', 'network', 'rm', `foundation-perf-net-${hex}`],
  ]);

  const result = JSON.parse(await readFile(join(dir, '.local/feature-12/outage/result.json'), 'utf8'));
  expect(result.outage.stopPlannedMs).toBe(90_000);
  expect(result.outage.startPlannedMs).toBe(150_000);
  expect(result.outage.stopIssuedMs).toBeGreaterThanOrEqual(90_000);
  expect(result.outage.stopCompletedMs).toBeGreaterThanOrEqual(result.outage.stopIssuedMs);
  expect(result.outage.startIssuedMs).toBeGreaterThanOrEqual(150_000);
  expect(result.outage.startCompletedMs).toBeGreaterThanOrEqual(result.outage.startIssuedMs);
  expect(result.reasons).toContainEqual({ code: 'summary_missing', detail: null });
  expect(result.reasons.some((item: { code: string }) => item.code === 'signal')).toBe(false);
  expect(output.some((line) => line.startsWith(`performance outage: stop ${db} dikirim pada T0 + `))).toBe(true);
  expect(output.some((line) => line.startsWith(`performance outage: start ${db} dikirim pada T0 + `))).toBe(true);
}, 30_000);

test('PERF-009 a signal while PostgreSQL is stopped on outage sends no start, cleans up in order, and records signal', async () => {
  // covers: AC-2 (pembersihan pada sinyal saat outage), AC-7 (tidak ada perintah sesudah run berhenti)
  const dir = await runWorkspace();
  const controller = new AbortController();
  const { calls, run } = await fakeRunner('none', () => undefined, {
    k6: async (options) => untilAborted(options.signal),
    after: (argv) => {
      if (argv[1] === 'stop' && argv[3] === '10' && argv[4]!.startsWith('foundation-perf-db-')) controller.abort('SIGTERM');
    },
  });
  const output: string[] = [];
  const code = await runProfile('outage', fastDeps(dir, run, controller.signal, output));
  expect(code).toBe(143);

  const db = dbName(calls);
  const hex = db.slice(-12);
  const argvs = calls.map((call) => call.argv);
  expect(argvs.some((argv) => argv[1] === 'start' && argv[2] === db)).toBe(false);
  const stop = argvs.findIndex((argv) => argv[1] === 'stop' && argv[4] === db);
  const remove = (name: string) => [labelInspect(name), ['docker', 'rm', '-f', name]];
  expect(argvs.slice(stop + 1)).toEqual([
    labelInspect(`foundation-perf-k6-${hex}`), ['docker', 'stop', '--time', '10', `foundation-perf-k6-${hex}`],
    // Only smoke runs k6 inspect, so the outage run never touches an inspect container.
    ...remove(`foundation-perf-k6-${hex}`), ...remove(`foundation-perf-backend-${hex}`), ...remove(db),
    ['docker', 'network', 'inspect', '--format', '{{json .Labels}}', `foundation-perf-net-${hex}`], ['docker', 'network', 'rm', `foundation-perf-net-${hex}`],
  ]);
  for (const call of calls.slice(stop + 1)) expect(call.options.signal, call.argv.join(' ')).toBeUndefined();
  const result = JSON.parse(await readFile(join(dir, '.local/feature-12/outage/result.json'), 'utf8'));
  expect(result.reasons).toEqual([{ code: 'signal', detail: 'SIGTERM' }]);
  expect(result.outage).toMatchObject({ stopPlannedMs: 90_000, startPlannedMs: 150_000, startIssuedMs: null, startCompletedMs: null });
  expect(result.outage.stopIssuedMs).toBeGreaterThanOrEqual(90_000);
  expect(output.at(-1)).toBe('performance outage: failed (signal SIGTERM)');
}, 30_000);

// ---------------------------------------------------------------------------------------------------------------
// `main` as its own process group with a fake `docker` at the front of PATH.

/**
 * Fake `docker`: logs every call next to itself, records the `foundation.run` label it was given and the content of
 * every `--env-file` (as a daemon would read it), answers the pre-run checks from fixture files, prints the real
 * `k6 inspect` output of the profile in the last argument for `run --rm`, and answers every label inspect with the
 * recorded run label.
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
case "$1" in
  info) echo '10 8319504384' ;;
  image) cat "$here/image-labels.json" ;;
  run)
    if [ "$2" = "--rm" ]; then
      for last in "$@"; do :; done
      profile=$(basename "$last" .ts)
      cat "$here/inspect-$profile.json"
    fi
    ;;
  container|network)
    if [ "$2" = "inspect" ]; then printf '{"foundation.test":"performance","foundation.run":"%s"}\\n' "$(cat "$here/../run-label")"; fi
    ;;
esac
exit 0
`;

async function processWorkspace(): Promise<string> {
  const dir = await runWorkspace({
    'run.ts': `import { main } from ${JSON.stringify(moduleUrl)};\nprocess.exitCode = await main({ root: process.cwd(), argv: process.argv.slice(2) });\n`,
    'bin/docker': fakeDocker,
    'bin/image-labels.json': `${JSON.stringify({ 'org.opencontainers.image.base.name': await baseImage() })}\n`,
    ...Object.fromEntries(await Promise.all(PROFILE_NAMES.map(async (profile) => [`bin/inspect-${profile}.json`, await readFile(inspectFixture(profile), 'utf8')] as const))),
    '.local/feature-12/keep.txt': 'kept\n',
  });
  await chmod(join(dir, 'bin/docker'), 0o755);
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

function start(dir: string, home: string, args: string[]) {
  const child = spawn(process.execPath, ['--no-env-file', 'run.ts', ...args], {
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

for (const [signal, expected] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
  test(`PERF-009 ${signal} while main waits for SELECT 1 removes PostgreSQL, the inspect container, and the network through the guard and exits ${expected}`, async () => {
    // covers: AC-2 (pembersihan pada sinyal), AC-10 (password env file tidak tercetak)
    const dir = await processWorkspace();
    const home = await emptyWorkspace('foundation-perf-home-');
    const child = start(dir, home, ['smoke']);
    try {
      expect(await waitUntil(async () => (await dockerLog(dir)).some((line) => line.startsWith('run -d --name foundation-perf-db-')), 30_000)).toBe(true);
      // The next step is the SELECT 1 wait on a loopback port nobody listens on.
      await Bun.sleep(300);
      process.kill(-child.pgid, signal);
      expect(await child.exited).toBe(expected);
      expect(await waitUntil(async () => !(await groupAlive(child.pgid)), 10_000)).toBe(true);
    } finally {
      try {
        process.kill(-child.pgid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    }

    const log = await dockerLog(dir);
    const runLine = log.findIndex((line) => line.startsWith('run -d --name foundation-perf-db-'));
    const hex = /foundation-perf-db-([0-9a-f]{12})/.exec(log[runLine]!)![1]!;
    expect(await readFile(join(dir, 'run-label'), 'utf8')).toBe(hex);
    expect(log.slice(runLine + 1)).toEqual([
      `container inspect --format {{json .Config.Labels}} foundation-perf-db-${hex}`,
      `rm -f foundation-perf-db-${hex}`,
      `container inspect --format {{json .Config.Labels}} foundation-perf-inspect-${hex}`,
      `rm -f foundation-perf-inspect-${hex}`,
      `network inspect --format {{json .Labels}} foundation-perf-net-${hex}`,
      `network rm foundation-perf-net-${hex}`,
    ]);
    // The mkdtemp folder under TMPDIR is gone, and the admin password never reached the output.
    expect((await readdir(home)).filter((name) => name.startsWith('foundation-perf-'))).toEqual([]);
    const password = /POSTGRES_PASSWORD=([0-9a-f]{48})/.exec(await readFile(join(dir, 'env-files'), 'utf8'))![1]!;
    const { stdout, stderr } = child.text();
    expect(stdout + stderr).not.toContain(password);
    expect(stderr).toContain(`performance smoke: failed (signal ${signal})`);
    const result = JSON.parse(await readFile(join(dir, '.local/feature-12/smoke/result.json'), 'utf8'));
    expect(result.reasons).toEqual([{ code: 'signal', detail: signal }]);
    expect(await readFile(join(dir, '.local/feature-12/smoke/result.json'), 'utf8')).not.toContain(password);
  }, 60_000);
}

test('PERF-009 an unknown or path like profile exits 2 with the fixed message, without a docker call or a change under .local/feature-12', async () => {
  // covers: AC-2 (pemeriksaan sebelum run (1))
  const dir = await processWorkspace();
  const home = await emptyWorkspace('foundation-perf-home-');
  for (const args of [['..'], ['../x'], ['nope'], [], ['smoke', 'extra'], ['Load'], ['breakpoint']]) {
    const child = start(dir, home, args);
    expect(await child.exited, args.join(' ')).toBe(2);
    expect(child.text().stderr, args.join(' ')).toBe(`${USAGE}\n`);
    expect(child.text().stdout, args.join(' ')).toBe('');
  }
  expect(await dockerLog(dir)).toEqual([]);
  expect(await readdir(join(dir, '.local/feature-12'))).toEqual(['keep.txt']);
  expect(await readFile(join(dir, '.local/feature-12/keep.txt'), 'utf8')).toBe('kept\n');
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------
// Added by /test: the other exit paths of `runProfile` with the same stand in command runner. A pre-run check that fails
// stops before any network or container exists; a setup failure still cleans up through the guard, which never removes
// what it refuses; and a run credential in captured output is found, never printed, and fails the run.

const failedRun = (code: number | null = 1, stderr = ''): ProcessGroupResult => ({ code, timedOut: false, aborted: false, stdout: '', stderr });

/** `fakeRunner` with some answers replaced: `override` answers a call (recorded like every other) or returns undefined. */
async function overriddenRunner(override: (argv: string[]) => ProcessGroupResult | undefined): Promise<{ calls: Recorded[]; run: CommandRunner }> {
  const base = await fakeRunner('none', () => undefined);
  const run: CommandRunner = async (argv, options) => {
    const answer = override([...argv]);
    if (answer === undefined) return base.run(argv, options);
    base.calls.push({ argv: [...argv], options });
    return answer;
  };
  return { calls: base.calls, run };
}

/** Deps of a run that is never aborted, on the real clock, with a provisioning step that `provision` answers. */
function plainDeps(dir: string, run: CommandRunner, output: string[], provision: RunDeps['provision'] = async () => ok('provisioned\n')): RunDeps {
  return {
    root: dir,
    run,
    provision,
    migrate: async () => ok('migrated\n'),
    now: Date.now,
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    signal: new AbortController().signal,
    selectOne: async () => true,
    poolClient: () => ({ sample: () => Bun.sleep(2).then(() => ({ sessions: 1, nonIdle: 0, total: 2 })), close: async () => undefined }),
    serverVersion: async () => '18.6',
    freePort: async () => 54321,
    env: { PATH: process.env['PATH'] ?? '' },
    uid: 501,
    gid: 20,
    log: (line) => output.push(line),
    error: (line) => output.push(line),
  };
}

async function readEvidence(dir: string, profile: ProfileName) {
  const folder = join(dir, '.local/feature-12', profile);
  return {
    resultText: await readFile(join(folder, 'result.json'), 'utf8'),
    result: JSON.parse(await readFile(join(folder, 'result.json'), 'utf8')) as { status: string; reasons: Array<{ code: string; detail: string | null }> },
    scan: JSON.parse(await readFile(join(folder, 'artifact-scan.json'), 'utf8')) as { findings: string[]; secretsChecked: number; outputsScanned: string[] },
  };
}

const INFO = ['docker', 'info', '--format', '{{json .NCPU}} {{json .MemTotal}}'];
const BUSY = ['docker', 'ps', '--filter', 'label=foundation.test', '--format', '{{.Names}} {{.Label "foundation.test"}}'];
const IMAGE = ['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', 'foundation-postgres:18-pinned'];
const creates = (argv: string[]) => (argv[1] === 'network' && argv[2] === 'create') || (argv[1] === 'run' && argv[2] === '-d') || argv[1] === 'create';

type PreRun = {
  label: string;
  files?: Record<string, string>;
  override?: (argv: string[]) => ProcessGroupResult | undefined;
  reason: { code: string; detail: string };
  calls: (pins: { k6: string; bun: string }) => string[][];
  lines?: string[];
};

test('PERF-009 each pre-run check that fails stops before any network or container exists, records its reason, and exits 1', async () => {
  // covers: AC-2 (pemeriksaan sebelum run (2) sampai (7) gagal sebelum membuat apa pun; environment_busy tanpa menghapus apa pun)
  const pinsText = await readFile(join(root, 'tests/performance/images.json'), 'utf8');
  const pinned = JSON.parse(pinsText) as { k6: { image: string }; bun: { image: string } };
  const images = { k6: pinned.k6.image, bun: pinned.bun.image };
  const pulls = (pins: { k6: string; bun: string }) => [['docker', 'pull', pins.k6], ['docker', 'pull', pins.bun]];
  const cases: PreRun[] = [
    {
      label: 'pin_invalid',
      files: { 'tests/performance/images.json': pinsText.replace('grafana/k6:2.3.0@', 'grafana/k6:2.2.0@') },
      reason: { code: 'pin_invalid', detail: 'k6' },
      calls: () => [],
    },
    {
      label: 'env_file_present',
      files: { 'apps/backend/src/index.ts': '', 'apps/backend/.env.verify': 'X=1\n' },
      reason: { code: 'env_file_present', detail: 'apps/backend/.env.verify' },
      calls: () => [],
    },
    {
      label: 'docker info fails',
      override: (argv) => (argv[1] === 'info' ? failedRun(1, 'Cannot connect\n') : undefined),
      reason: { code: 'setup_failed', detail: 'environment_read' },
      calls: () => [INFO],
    },
    {
      label: 'environment_too_small',
      override: (argv) => (argv[1] === 'info' ? ok('3 8319504384\n') : undefined),
      reason: { code: 'environment_too_small', detail: 'ncpu=3 memTotal=8319504384' },
      calls: () => [INFO],
      lines: ['performance smoke: mesin container melihat 3 CPU dan 8319504384 byte; minimal 4 CPU dan 4294967296 byte (4 GiB)'],
    },
    {
      label: 'environment_busy',
      override: (argv) => (argv[1] === 'ps' && argv[3] === 'label=foundation.test' ? ok('foundation-verify-busy verify\n') : undefined),
      reason: { code: 'environment_busy', detail: 'before:1' },
      calls: () => [INFO, BUSY],
      lines: [
        'performance smoke: 1 container foundation.test lain sedang berjalan:',
        '  foundation-verify-busy verify',
        'Hentikan run itu, atau ikuti langkah pembersihan manual k6 di docs/rules/testing.md sesudah ditinjau.',
      ],
    },
    {
      label: 'image_pull_failed',
      override: (argv) => (argv[1] === 'pull' && argv[2]!.startsWith('oven/bun:') ? failedRun(1) : undefined),
      reason: { code: 'image_pull_failed', detail: 'bun' },
      calls: (pins) => [INFO, BUSY, IMAGE, ...pulls(pins)],
    },
    {
      label: 'inspect_mismatch',
      override: (argv) => (argv[1] === 'run' && argv[2] === '--rm' && argv.at(-1) === '/scripts/profiles/stress.ts' ? ok('{"scenarios":{},"thresholds":{}}\n') : undefined),
      reason: { code: 'inspect_mismatch', detail: 'stress' },
      calls: (pins) => [INFO, BUSY, IMAGE, ...pulls(pins)],
    },
  ];
  for (const item of cases) {
    const dir = await runWorkspace(item.files ?? {});
    const { calls, run } = await overriddenRunner(item.override ?? (() => undefined));
    const output: string[] = [];
    expect(await runProfile('smoke', plainDeps(dir, run, output)), item.label).toBe(1);
    const argvs = calls.map((call) => call.argv);
    const expected = item.calls(images);
    expect(argvs.slice(0, expected.length), item.label).toEqual(expected);
    // Nothing was created, and nothing was stopped or removed but the run's own inspect containers.
    expect(argvs.filter(creates), item.label).toEqual([]);
    expect(argvs.filter((argv) => argv[1] === 'stop' || argv[1] === 'start'), item.label).toEqual([]);
    const removed = argvs.filter((argv) => argv[1] === 'rm' || argv[2] === 'rm').map((argv) => argv.at(-1)!);
    expect(removed.every((name) => /^foundation-perf-inspect-[0-9a-f]{12}$/.test(name)), item.label).toBe(true);
    if (item.label === 'inspect_mismatch') {
      // The inspect containers ran one profile at a time, up to the one that did not match; then the guard cleans up.
      const inspected = argvs.filter((argv) => argv[1] === 'run' && argv[2] === '--rm').map((argv) => argv.at(-1));
      expect(inspected).toEqual(['/scripts/profiles/smoke.ts', '/scripts/profiles/load.ts', '/scripts/profiles/stress.ts']);
      const name = argvs.find((argv) => argv[1] === 'run' && argv[2] === '--rm')![4]!;
      expect(argvs.slice(expected.length + 3)).toEqual([labelInspect(name), ['docker', 'rm', '-f', name]]);
    } else {
      expect(argvs, item.label).toEqual(expected);
    }

    const { result, scan } = await readEvidence(dir, 'smoke');
    expect([result.status, result.reasons], item.label).toEqual(['failed', [item.reason]]);
    expect(scan.findings, item.label).toEqual([]);
    for (const line of item.lines ?? []) expect(output, item.label).toContain(line);
    expect(output.at(-1), item.label).toBe(`performance smoke: failed (${item.reason.code} ${item.reason.detail})`);
  }
}, 60_000);

test('PERF-009 a PostgreSQL image without the pinned base is built through Compose with a temporary env file, and a failed build stops before any container', async () => {
  // covers: AC-2 (pemeriksaan sebelum run (6): build Compose seperti INFRA-002, image_build_failed), AC-10 (password build tidak tercetak)
  const pins = JSON.parse(await readFile(join(root, 'infrastructure/postgres/pins.json'), 'utf8')) as { baseImage: string; postgresPackageVersion: string };
  for (const buildFails of [true, false]) {
    const label = buildFails ? 'build fails' : 'built image still has another base';
    let envText = '';
    let envPath = '';
    const { calls, run } = await overriddenRunner((argv) => {
      if (argv[1] === 'image' && argv[2] === 'inspect') return ok('{"org.opencontainers.image.base.name":"oraclelinux:9-slim"}\n');
      if (argv[1] !== 'compose') return undefined;
      envPath = argv[argv.indexOf('--env-file') + 1]!;
      envText = readFileSync(envPath, 'utf8');
      return buildFails ? failedRun(1) : ok();
    });
    const dir = await runWorkspace();
    const output: string[] = [];
    expect(await runProfile('smoke', plainDeps(dir, run, output)), label).toBe(1);
    const argvs = calls.map((call) => call.argv);
    const compose = argvs.find((argv) => argv[1] === 'compose')!;
    const hex = /^foundation-perf-build-([0-9a-f]{12})$/.exec(compose[3]!)![1];
    expect(compose, label).toEqual([
      'docker', 'compose', '-p', `foundation-perf-build-${hex}`, '--env-file', envPath,
      '-f', 'docker-compose.yml', '-f', 'tests/integration/infrastructure/compose.test.yml', 'build', 'postgres',
    ]);
    const lines = envText.trim().split('\n');
    expect(lines.slice(1), label).toEqual([
      'FOUNDATION_POSTGRES_IMAGE=foundation-postgres:18-pinned',
      `FOUNDATION_POSTGRES_BASE_IMAGE=${pins.baseImage}`,
      `FOUNDATION_POSTGRES_PACKAGE_VERSION=${pins.postgresPackageVersion}`,
    ]);
    const password = /^FOUNDATION_POSTGRES_PASSWORD=([0-9a-f]{48})$/.exec(lines[0]!)![1]!;
    // A failed build is never followed by a second label read; a finished build is read again.
    expect(argvs, label).toEqual([INFO, BUSY, IMAGE, compose, ...(buildFails ? [] : [IMAGE])]);
    // The temporary env file and its folder are gone, and the build password never reached the console or the evidence.
    expect(await exists(dirname(envPath)), label).toBe(false);
    const { result, resultText, scan } = await readEvidence(dir, 'smoke');
    expect(result.reasons, label).toEqual([{ code: 'image_build_failed', detail: 'postgres' }]);
    expect([scan.findings, scan.secretsChecked], label).toEqual([[], 1]);
    expect(resultText, label).not.toContain(password);
    expect(output.join('\n'), label).not.toContain(password);
    expect(output, label).toContain('performance smoke: membangun foundation-postgres:18-pinned dari infrastructure/postgres/pins.json');
  }
}, 30_000);

test('PERF-009 a run credential in a captured output fails secret_in_output, is never printed, and the run still cleans up through the guard', async () => {
  // covers: AC-10 (pemindaian credential atas output provision; output mentah tidak pernah dicetak), AC-2 (pembersihan sesudah setup_failed)
  const { calls, run } = await overriddenRunner(() => undefined);
  let leaked = '';
  const provision: RunDeps['provision'] = async (env) => {
    leaked = env['FOUNDATION_MIGRATOR_PASSWORD']!;
    return { code: 1, timedOut: false, aborted: false, stdout: `role foundation_migrator dengan password ${leaked} ditolak\n`, stderr: '' };
  };
  const dir = await runWorkspace();
  const output: string[] = [];
  expect(await runProfile('load', plainDeps(dir, run, output, provision))).toBe(1);
  expect(leaked).toMatch(/^[0-9a-f]{48}$/);

  const argvs = calls.map((call) => call.argv);
  const db = dbName(calls);
  const hex = db.slice(-12);
  // After the PostgreSQL container: only the guarded removal of PostgreSQL and the network; no backend, no k6.
  const postgresRun = argvs.findIndex((argv) => argv[1] === 'run' && argv[2] === '-d');
  expect(argvs.slice(postgresRun + 1)).toEqual([
    labelInspect(db), ['docker', 'rm', '-f', db],
    ['docker', 'network', 'inspect', '--format', '{{json .Labels}}', `foundation-perf-net-${hex}`], ['docker', 'network', 'rm', `foundation-perf-net-${hex}`],
  ]);
  const { result, resultText, scan } = await readEvidence(dir, 'load');
  expect(result.reasons).toEqual([{ code: 'setup_failed', detail: 'provision' }, { code: 'secret_in_output', detail: '1' }]);
  expect(scan.findings).toEqual(['provision output']);
  expect(scan.secretsChecked).toBe(6);
  expect(scan.outputsScanned).toContain('provision');
  expect(resultText).not.toContain(leaked);
  expect(output.join('\n')).not.toContain(leaked);
  expect(output.join('\n')).not.toContain('ditolak');
  expect(output.at(-1)).toBe('performance load: failed (setup_failed provision, secret_in_output 1)');
}, 30_000);

test('PERF-009 cleanup never removes what the guard refuses, records cleanup_failed with the name, and skips a resource that is already gone', async () => {
  // covers: AC-2 (penjaga container sebelum rm -f dan network rm; container inspect yang sudah dihapus --rm dilewati)
  const { calls, run } = await overriddenRunner((argv) => {
    if (argv[1] !== 'container' || argv[2] !== 'inspect' || argv[4] !== '{{json .Config.Labels}}') return undefined;
    const name = argv.at(-1)!;
    // PostgreSQL now carries the label of another run; the inspect container already removed itself with --rm.
    if (name.startsWith('foundation-perf-db-')) return ok('{"foundation.test":"performance","foundation.run":"ba9876543210"}\n');
    if (name.startsWith('foundation-perf-inspect-')) return failedRun(1, `Error response from daemon: No such container: ${name}\n`);
    return undefined;
  });
  const dir = await runWorkspace();
  const output: string[] = [];
  expect(await runProfile('smoke', plainDeps(dir, run, output, async () => failedRun(1)))).toBe(1);

  const argvs = calls.map((call) => call.argv);
  const db = dbName(calls);
  const hex = db.slice(-12);
  const postgresRun = argvs.findIndex((argv) => argv[1] === 'run' && argv[2] === '-d');
  expect(argvs.slice(postgresRun + 1)).toEqual([
    labelInspect(db),
    labelInspect(`foundation-perf-inspect-${hex}`),
    ['docker', 'network', 'inspect', '--format', '{{json .Labels}}', `foundation-perf-net-${hex}`], ['docker', 'network', 'rm', `foundation-perf-net-${hex}`],
  ]);
  expect(argvs.some((argv) => argv[1] === 'rm')).toBe(false);
  const { result } = await readEvidence(dir, 'smoke');
  expect(result.reasons).toEqual([{ code: 'setup_failed', detail: 'provision' }, { code: 'cleanup_failed', detail: db }]);
  expect(output).toContain(`performance smoke: ${db} tidak dapat dihapus; hapus dengan tangan sesudah ditinjau`);
  expect(output.at(-1)).toBe(`performance smoke: failed (setup_failed provision, cleanup_failed ${db})`);
}, 30_000);

// ---------------------------------------------------------------------------------------------------------------
// Added after the review of 2026-10-04: the wiring that turns the k6 exit, the k6 summary, the check after k6, and the
// observation into the verdict of `runProfile`. Each run reaches the judgement on a host clock that runs `FULL_SPEED`
// times faster than real time: the stand in `docker start -a` writes a real k6 summary from `fixtures/` with the T0 of
// the run and returns at the end of the profile, the `docker stats` stream and the `pg_stat_activity` sampler cover
// every phase, and the backend answers like a healthy run. One changed answer then shows exactly its own reason.

const FULL_SPEED = 25;

type Role = 'postgres' | 'backend' | 'k6';
type K6Summary = { setup_data: Record<string, unknown>; metrics: Record<string, { values: Record<string, number> }> };

type FullRun = {
  /** Exit of `docker start -a` k6: a code (0 by default) or the k6 timeout. */
  k6Code?: number | null;
  k6TimedOut?: boolean;
  /** The real summary written to `/out/summary.json`. */
  summary?: 'summary-smoke.json' | 'summary-thresholds-failed.json';
  /** Changes the summary after it holds the T0 of the run; `secrets` holds the admin password of the run. */
  changeSummary?: (summary: K6Summary, secrets: string[]) => void;
  /** `CPUPerc` and `MemUsage` of every `docker stats` line per container. */
  stats?: Partial<Record<Role, { cpu: string; memory: string }>>;
  /** Output the stream gives once, after its first sample lines. */
  statsExtra?: (secrets: string[]) => { stdout?: string; stderr?: string };
  pool?: PoolCounts;
  /** Lines of `docker ps` after k6 besides the line of the run's own k6 container. */
  busyAfter?: string;
  state?: string;
  logs?: { stdout: string; stderr: string };
  /** Offset of the backend clock on the measurement after k6, in ms. */
  clockAfterMs?: number;
  serverVersion?: (adminUrl: string) => string;
};

type FullRunResult = {
  code: number;
  calls: Recorded[];
  output: string[];
  hex: string;
  /** Run clock at `docker create` of k6, and the T0 that call carried. */
  createdAt: number;
  createdT0: number;
  backendEnv: string;
  secrets: string[];
  result: {
    status: string;
    reasons: Array<{ code: string; detail: string | null }>;
    t0: number;
    actual: { scenarioStartLateMs: number | null; iterations: number; httpReqs: number };
    thresholds: Array<{ metric: string; expression: string; ok: boolean }>;
    observation: {
      containers: Record<Role, { memoryMaxMiB: number | null; restarts: number | null; oomKilled: boolean | null; stderrBytes: number | null }>;
      pool: { sessions: number | null; nonIdle: number | null; samples: number; failedSamples: number };
      checks: Array<{ name: string; ok: boolean }>;
    } | null;
    environment: { otherContainersRunning: number | null; clockOffsetMs: { before: number | null; after: number | null }; images: { postgres: { serverVersion: string | null } } };
  };
  resultText: string;
  scan: { outputsScanned: string[]; filesScanned: string[]; secretsChecked: number; findings: string[] };
};

const SMOKE_CHECKS = ['backend_running', 'backend_output', 'backend_memory_peak', 'pool_sessions', 'pool_non_idle', 'generator_cpu', 'generator_memory', 'observation_coverage', 'clock_offset'];

async function fullRun(options: FullRun = {}): Promise<FullRunResult> {
  const dir = await runWorkspace();
  const origin = Date.now();
  const now = () => origin + (Date.now() - origin) * FULL_SPEED;
  const secrets: string[] = [];
  let hex = '';
  let createdAt = 0;
  let createdT0 = 0;
  let backendEnv = '';
  let k6Done = false;
  const roleOf = (name: string): Role => (name.startsWith('foundation-perf-db-') ? 'postgres' : name.startsWith('foundation-perf-backend-') ? 'backend' : 'k6');
  const base = await fakeRunner('none', () => undefined);

  const stream = async (names: string[], processOptions: ProcessGroupOptions): Promise<ProcessGroupResult> => {
    const aborted = untilAborted(processOptions.signal);
    let extraSent = false;
    while (processOptions.signal?.aborted !== true) {
      const lines = names.map((name) => {
        const values = options.stats?.[roleOf(name)] ?? { cpu: '1.00%', memory: '10MiB / 1GiB' };
        return `${JSON.stringify({ Name: name, CPUPerc: values.cpu, MemUsage: values.memory })}\n`;
      });
      processOptions.onOutput?.('stdout', Buffer.from(lines.join('')), now());
      if (!extraSent && options.statsExtra !== undefined) {
        extraSent = true;
        const extra = options.statsExtra(secrets);
        if (extra.stdout !== undefined) processOptions.onOutput?.('stdout', Buffer.from(extra.stdout), now());
        if (extra.stderr !== undefined) processOptions.onOutput?.('stderr', Buffer.from(extra.stderr), now());
      }
      await Promise.race([Bun.sleep(20), aborted]);
    }
    return { code: null, timedOut: false, aborted: true, stdout: '', stderr: '' };
  };

  const k6 = async (): Promise<ProcessGroupResult> => {
    const summary = JSON.parse(await readFile(join(import.meta.dir, 'fixtures', options.summary ?? 'summary-smoke.json'), 'utf8')) as K6Summary;
    summary.setup_data = { ...summary.setup_data, t0: createdT0, startedAt: createdT0 + 3 };
    options.changeSummary?.(summary, secrets);
    await writeFile(join(dir, '.local/feature-12/smoke/k6/summary.json'), JSON.stringify(summary));
    // k6 runs until the end of the profile by the run clock, so the observation covers every phase.
    for (const end = createdT0 + profileSeconds('smoke') * 1_000 + 500; now() < end; ) await Bun.sleep(5);
    k6Done = true;
    const timedOut = options.k6TimedOut === true;
    return { code: timedOut ? null : (options.k6Code ?? 0), timedOut, aborted: false, stdout: 'k6 summary written to /out/summary.json\n', stderr: '' };
  };

  const run: CommandRunner = async (argv, processOptions) => {
    const args = [...argv];
    const [, first, second] = args;
    const answer = (result: ProcessGroupResult) => {
      base.calls.push({ argv: args, options: processOptions });
      return result;
    };
    if (first === 'network' && second === 'create') hex = args.at(-1)!.slice(-12);
    if (first === 'run' && second === '-d') {
      // The env files exist only while the run holds them; read them as the container engine would.
      const text = readFileSync(args[args.indexOf('--env-file') + 1]!, 'utf8');
      if (roleOf(args[4]!) === 'postgres') secrets.push(/^POSTGRES_PASSWORD=([0-9a-f]{48})$/m.exec(text)![1]!);
      else backendEnv = text;
    }
    if (first === 'create') {
      createdAt = now();
      createdT0 = Number(args.find((arg) => arg.startsWith('FOUNDATION_PERF_T0='))!.slice('FOUNDATION_PERF_T0='.length));
    }
    if (first === 'stats') {
      base.calls.push({ argv: args, options: processOptions });
      return stream(args.slice(4), processOptions);
    }
    if (first === 'start' && second === '-a') {
      base.calls.push({ argv: args, options: processOptions });
      return k6();
    }
    if (first === 'exec' && args.includes(CLOCK_SCRIPT)) return answer(ok(`${now() + (k6Done ? (options.clockAfterMs ?? 0) : 0)}\n`));
    if (first === 'ps' && args.includes('{{.Names}} {{.Label "foundation.test"}} {{.Label "foundation.run"}}')) {
      return answer(ok(`foundation-perf-k6-${hex} performance ${hex}\n${options.busyAfter ?? ''}`));
    }
    if (first === 'container' && second === 'inspect' && args[4]!.startsWith('{{json .State')) return answer(ok(options.state ?? 'true 0 false\n'));
    if (first === 'logs') return answer({ code: 0, timedOut: false, aborted: false, ...(options.logs ?? { stdout: EXPECTED_BACKEND_STDOUT, stderr: '' }) });
    return base.run(argv, processOptions);
  };

  const output: string[] = [];
  const code = await runProfile('smoke', {
    root: dir,
    run,
    provision: async () => ok('provisioned\n'),
    migrate: async () => ok('migrated\n'),
    now,
    sleep: (ms) => Bun.sleep(Math.max(1, ms / FULL_SPEED)),
    signal: new AbortController().signal,
    selectOne: async () => true,
    poolClient: () => ({ sample: () => Bun.sleep(2).then(() => options.pool ?? { sessions: 1, nonIdle: 0, total: 2 }), close: async () => undefined }),
    serverVersion: async (url) => options.serverVersion?.(url) ?? '18.6',
    freePort: async () => 54321,
    env: { PATH: process.env['PATH'] ?? '' },
    uid: 501,
    gid: 20,
    log: (line) => output.push(line),
    error: (line) => output.push(line),
  });
  const folder = join(dir, '.local/feature-12/smoke');
  const resultText = await readFile(join(folder, 'result.json'), 'utf8');
  return {
    code,
    calls: base.calls,
    output,
    hex,
    createdAt,
    createdT0,
    backendEnv,
    secrets,
    result: JSON.parse(resultText) as FullRunResult['result'],
    resultText,
    scan: JSON.parse(await readFile(join(folder, 'artifact-scan.json'), 'utf8')) as FullRunResult['scan'],
  };
}

const allChecksPassed = (run: FullRunResult) => run.result.observation?.checks.map((check) => [check.name, check.ok]);

test('PERF-009 a complete smoke run with a clean k6 summary passes, exits 0, and carries every measurement into result.json', async () => {
  // covers: AC-4 (exit 0 hanya tanpa alasan), AC-5 (ringkasan dan T0), AC-6 (keadaan, output, pool, dan sampel sampai ke check), AC-2 (pemeriksaan sesudah k6), AC-10 (environment dan pemindaian)
  const run = await fullRun();
  expect([run.code, run.result.status, run.result.reasons]).toEqual([0, 'passed', []]);
  expect(allChecksPassed(run)).toEqual(SMOKE_CHECKS.map((name) => [name, true]));

  // T0 is set 15 s ahead before `docker create` of k6, and the summary is read against it.
  expect(run.result.t0).toBe(run.createdT0);
  expect(run.createdT0 - run.createdAt).toBeGreaterThan(T0_DELAY_MS - 1_000);
  expect(run.createdT0 - run.createdAt).toBeLessThanOrEqual(T0_DELAY_MS);
  expect(run.result.actual.scenarioStartLateMs).toBe(3);
  expect([run.result.actual.iterations, run.result.actual.httpReqs]).toEqual([4_403, 4_403]);
  expect(run.result.thresholds.length).toBeGreaterThan(0);
  expect(run.result.thresholds.every((item) => item.ok)).toBe(true);

  // After k6: the busy check, the second clock offset, the backend state, the guarded stop, then the logs.
  const names = { k6: `foundation-perf-k6-${run.hex}`, backend: `foundation-perf-backend-${run.hex}` };
  const argvs = run.calls.map((call) => call.argv);
  const k6Start = argvs.findIndex((argv) => argv[1] === 'start' && argv[2] === '-a');
  expect(argvs.slice(k6Start, k6Start + 7)).toEqual([
    ['docker', 'start', '-a', names.k6],
    ['docker', 'ps', '--filter', 'label=foundation.test', '--format', '{{.Names}} {{.Label "foundation.test"}} {{.Label "foundation.run"}}'],
    ['docker', 'exec', names.backend, 'bun', '--no-env-file', '-e', CLOCK_SCRIPT],
    ['docker', 'container', 'inspect', '--format', '{{json .State.Running}} {{json .RestartCount}} {{json .State.OOMKilled}}', names.backend],
    labelInspect(names.backend),
    ['docker', 'stop', '--time', '5', names.backend],
    ['docker', 'logs', names.backend],
  ]);
  expect(run.calls[k6Start]!.options.timeoutMs).toBe(profileSeconds('smoke') * 1_000 + TIMEOUTS.k6Extra);

  // The backend state, output, pool, and samples reached the observation.
  const observation = run.result.observation!;
  expect(observation.containers.backend).toMatchObject({ memoryMaxMiB: 10, restarts: 0, oomKilled: false, stderrBytes: 0 });
  expect(observation.pool).toMatchObject({ sessions: 1, nonIdle: 0, failedSamples: 0 });
  expect(observation.pool.samples).toBeGreaterThan(0);
  expect(run.result.environment.clockOffsetMs.after).not.toBeNull();

  // The environment counts the other running containers without the run's own, and the backend env file holds
  // exactly the development composition values.
  expect(run.result.environment.otherContainersRunning).toBe(1);
  expect(run.backendEnv).toMatch(/^NODE_ENV=development\nHOST=127\.0\.0\.1\nPORT=8888\nHOME=\/tmp\nDATABASE_URL=postgres:\/\/foundation_backend:[0-9a-f]{48}@postgres:5432\/foundation\n$/);

  expect(run.scan.findings).toEqual([]);
  expect(run.scan.filesScanned).toEqual(['.local/feature-12/smoke/k6/summary.json', '.local/feature-12/smoke/observation.json', '.local/feature-12/smoke/result.json']);
  expect(run.output.at(-1)).toStartWith('performance smoke: passed; pemindaian credential tanpa temuan atas ');
}, 30_000);

test('PERF-009 each k6 exit gives exactly its own reason when the summary and the observation are clean', async () => {
  // covers: AC-4 (k6 keluar 99 menjadi k6_thresholds_failed dan exit 1), AC-1 (exit lain menjadi k6_failed dengan kode nya), batas waktu k6 menjadi k6_timeout
  const cases: Array<[string, FullRun, { code: string; detail: string | null }]> = [
    ['exit 99 with the real failed summary', { k6Code: 99, summary: 'summary-thresholds-failed.json' }, { code: 'k6_thresholds_failed', detail: null }],
    ['exit 107', { k6Code: 107 }, { code: 'k6_failed', detail: '107' }],
    ['timeout', { k6TimedOut: true }, { code: 'k6_timeout', detail: null }],
  ];
  for (const [label, options, expected] of cases) {
    const run = await fullRun(options);
    expect([run.code, run.result.status, run.result.reasons], label).toEqual([1, 'failed', [expected]]);
    expect(allChecksPassed(run), label).toEqual(SMOKE_CHECKS.map((name) => [name, true]));
    expect(run.output.at(-1), label).toBe(`performance smoke: failed (${expected.detail === null ? expected.code : `${expected.code} ${expected.detail}`})`);
    if (options.summary === 'summary-thresholds-failed.json') {
      expect(run.result.thresholds.filter((item) => !item.ok), label).toEqual([{ metric: 'http_req_duration{endpoint:status,phase:steady}', expression: 'p(95)<0', ok: false }]);
    }
  }
}, 60_000);

test('PERF-009 another foundation.test container after k6 fails environment_busy after:N, while the run own containers are ignored and nothing foreign is touched', async () => {
  // covers: AC-2 (pemeriksaan environment_busy diulang sesudah k6 keluar)
  const run = await fullRun({ busyAfter: 'foundation-verify-busy verify 0a0a0a0a0a0a\nfoundation-perf-k6-ba9876543210 performance ba9876543210\n' });
  expect([run.code, run.result.reasons]).toEqual([1, [{ code: 'environment_busy', detail: 'after:2' }]]);
  expect(run.output).toContain('performance smoke: 2 container foundation.test lain berjalan sesudah k6:');
  expect(run.output).toContain('  foundation-verify-busy verify');
  expect(run.output).toContain('  foundation-perf-k6-ba9876543210 performance');
  expect(run.output.some((line) => line.includes(`foundation-perf-k6-${run.hex} performance`))).toBe(false);
  const touched = run.calls.map((call) => call.argv).filter((argv) => ['stop', 'start', 'rm'].includes(argv[1]!) || argv[2] === 'rm');
  expect(touched.every((argv) => argv.at(-1)!.endsWith(run.hex))).toBe(true);
}, 30_000);

test('PERF-009 every judged measurement reaches the reasons in order: summary timing and counts, backend state and output, samples, pool, generator, clock, and the stream stderr scan', async () => {
  // covers: AC-5 (phase_start_late, iteration_request_mismatch, generator_saturated), AC-6 (observation_failed dengan nama check), AC-10 (stderr aliran docker stats dipindai)
  const run = await fullRun({
    changeSummary: (summary) => {
      summary.setup_data['startedAt'] = (summary.setup_data['t0'] as number) + 2_500;
      summary.metrics['http_reqs']!.values['count'] = 4_404;
    },
    state: 'true 1 false\n',
    logs: { stdout: EXPECTED_BACKEND_STDOUT, stderr: 'boom\n' },
    stats: { backend: { cpu: '1.00%', memory: '200MiB / 512MiB' }, k6: { cpu: '300.00%', memory: '40MiB / 2GiB' } },
    pool: { sessions: 6, nonIdle: 2, total: 8 },
    clockAfterMs: 5_000,
    statsExtra: (secrets) => ({ stderr: `warning ${secrets[0]}\n` }),
  });
  expect(run.code).toBe(1);
  expect(run.result.reasons).toEqual([
    { code: 'phase_start_late', detail: '2500' },
    { code: 'iteration_request_mismatch', detail: '4404/4403' },
    { code: 'observation_failed', detail: 'backend_running' },
    { code: 'observation_failed', detail: 'backend_output' },
    { code: 'observation_failed', detail: 'backend_memory_peak' },
    { code: 'observation_failed', detail: 'pool_sessions' },
    { code: 'observation_failed', detail: 'pool_non_idle' },
    { code: 'generator_saturated', detail: 'generator_cpu' },
    { code: 'observation_failed', detail: 'clock_offset' },
    { code: 'secret_in_output', detail: '1' },
  ]);
  expect(run.scan.findings).toEqual(['stats output']);
  const observation = run.result.observation!;
  expect(observation.containers.backend).toMatchObject({ memoryMaxMiB: 200, restarts: 1, oomKilled: false, stderrBytes: 5 });
  expect(observation.pool).toMatchObject({ sessions: 6, nonIdle: 2 });
  expect(run.result.environment.clockOffsetMs.after).toBeGreaterThan(1_000);
}, 30_000);

test('PERF-009 a run credential in a stats stream line, in k6/summary.json, or in the structured result is found before redaction, fails secret_in_output, and is never written or printed', async () => {
  // covers: AC-10 (pemindaian output, summary.json, dan result.json; redaksi sesudah pemindaian)
  const run = await fullRun({
    changeSummary: (summary, secrets) => {
      summary.setup_data['note'] = `password ${secrets[0]}`;
    },
    // A stdout line that is no sample still joins the scanned output when it holds a credential.
    statsExtra: (secrets) => ({ stdout: `not json ${secrets[0]}\n` }),
    serverVersion: (url) => `18.6 ${new URL(url).password}`,
  });
  const [password] = run.secrets;
  expect(password).toMatch(/^[0-9a-f]{48}$/);
  expect(run.code).toBe(1);
  expect(run.scan.findings).toEqual(['stats output', '.local/feature-12/smoke/k6/summary.json', '.local/feature-12/smoke/result.json']);
  expect(run.result.reasons).toEqual([{ code: 'secret_in_output', detail: '3' }]);
  // The written result holds the redacted value, and no line of the console holds the credential.
  expect(run.result.environment.images.postgres.serverVersion).toBe('18.6 [redacted]');
  expect(run.resultText).not.toContain(password!);
  expect(run.output.join('\n')).not.toContain(password!);
  expect(run.output.at(-1)).toBe('performance smoke: failed (secret_in_output 3)');
}, 30_000);

test('PERF-009 on host UID 0 the k6 output folder goes to 65534:65534 before any docker call, and the containers run as 65534:65534', async () => {
  // covers: AC-2 (UID host 0: folder keluaran k6 diserahkan ke 65534:65534 sebelum container k6 dibuat)
  const events: string[] = [];
  const { calls, run } = await overriddenRunner(() => undefined);
  const dir = await runWorkspace();
  const output: string[] = [];
  const code = await runProfile('smoke', {
    ...plainDeps(dir, async (argv, options) => {
      events.push(`docker ${argv[1]}`);
      return run(argv, options);
    }, output, async () => failedRun(1)),
    uid: 0,
    gid: 0,
    chown: async (path, uid, gid) => {
      events.push(`chown ${path.slice(dir.length + 1)} ${uid}:${gid}`);
    },
  });
  expect(code).toBe(1);
  expect(events[0]).toBe('chown .local/feature-12/smoke/k6 65534:65534');
  expect(events.filter((event) => event.startsWith('chown'))).toHaveLength(1);
  const inspect = calls.find((call) => call.argv[1] === 'run' && call.argv[2] === '--rm')!.argv;
  expect(inspect.slice(inspect.indexOf('--user'), inspect.indexOf('--user') + 2)).toEqual(['--user', '65534:65534']);
  const { result } = await readEvidence(dir, 'smoke');
  expect(result.reasons).toEqual([{ code: 'setup_failed', detail: 'provision' }]);
}, 30_000);

test('PERF-009 every setup step after PostgreSQL that fails records its own setup_failed detail or backend_not_ready, never starts k6, and cleans up what it created', async () => {
  // covers: AC-2 (setup_failed dengan detail langkah; pembersihan sesudahnya), backend_not_ready sesudah 60 detik poll
  type SetupCase = { label: string; override?: (argv: string[]) => ProcessGroupResult | undefined; migrateFails?: boolean; fastClock?: boolean; reason: { code: string; detail: string | null } };
  const cases: SetupCase[] = [
    { label: 'migrate', migrateFails: true, reason: { code: 'setup_failed', detail: 'migrate' } },
    { label: 'backend_start', override: (argv) => (argv[1] === 'run' && argv[2] === '-d' && argv[4]!.startsWith('foundation-perf-backend-') ? failedRun(125) : undefined), reason: { code: 'setup_failed', detail: 'backend_start' } },
    {
      label: 'backend_not_ready',
      override: (argv) => (argv[1] === 'exec' && argv.includes(BACKEND_POLL_SCRIPT) ? ok('{"status":200,"readiness":503,"appliedMigrations":null}\n') : undefined),
      fastClock: true,
      reason: { code: 'backend_not_ready', detail: null },
    },
    { label: 'clock_offset_read', override: (argv) => (argv[1] === 'exec' && argv.includes(CLOCK_SCRIPT) ? ok('not a number\n') : undefined), reason: { code: 'setup_failed', detail: 'clock_offset_read' } },
    { label: 'environment_read', override: (argv) => (argv[1] === 'version' ? failedRun(1) : undefined), reason: { code: 'setup_failed', detail: 'environment_read' } },
    { label: 'k6_create', override: (argv) => (argv[1] === 'create' ? failedRun(125) : undefined), reason: { code: 'setup_failed', detail: 'k6_create' } },
    { label: 'stats_start', override: (argv) => (argv[1] === 'stats' ? ok('') : undefined), reason: { code: 'setup_failed', detail: 'stats_start' } },
  ];
  for (const item of cases) {
    const { calls, run } = await overriddenRunner(item.override ?? (() => undefined));
    const dir = await runWorkspace();
    const output: string[] = [];
    const deps = plainDeps(dir, run, output);
    if (item.migrateFails === true) deps.migrate = async () => failedRun(1);
    if (item.fastClock === true) {
      const origin = Date.now();
      deps.now = () => origin + (Date.now() - origin) * 1_000;
    }
    expect(await runProfile('load', deps), item.label).toBe(1);
    const { result } = await readEvidence(dir, 'load');
    expect(result.reasons, item.label).toEqual([item.reason]);
    const argvs = calls.map((call) => call.argv);
    expect(argvs.some((argv) => argv[1] === 'start' && argv[2] === '-a'), item.label).toBe(false);
    // Whatever the run created is removed through the guard; what it never created is never touched.
    const hex = argvs.find((argv) => argv[1] === 'network' && argv[2] === 'create')!.at(-1)!.slice(-12);
    const removed = argvs.filter((argv) => argv[1] === 'rm').map((argv) => argv.at(-1));
    const backendCreated = argvs.some((argv) => argv[1] === 'run' && argv[2] === '-d' && argv[4] === `foundation-perf-backend-${hex}`);
    const k6Created = argvs.some((argv) => argv[1] === 'create');
    expect(removed, item.label).toEqual([
      ...(k6Created ? [`foundation-perf-k6-${hex}`] : []),
      ...(backendCreated ? [`foundation-perf-backend-${hex}`] : []),
      `foundation-perf-db-${hex}`,
    ]);
    expect(argvs.at(-1), item.label).toEqual(['docker', 'network', 'rm', `foundation-perf-net-${hex}`]);
    expect(output.at(-1), item.label).toBe(`performance load: failed (${item.reason.detail === null ? item.reason.code : `${item.reason.code} ${item.reason.detail}`})`);
  }
}, 60_000);
