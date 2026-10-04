import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { countAppliedMigrations } from '../../../apps/backend/src/features/development/readiness.queries';
import { createReadinessCheck, type ReadinessOutcome } from '../../../apps/backend/src/features/development/readiness.service';
import { createDatabasePool } from '../../../libs/server/database/client';
import {
  READINESS_RUN_LABEL_ARGS,
  readinessContainerLabelsAccepted,
  readinessContainerMissing,
  readinessImageLabelsAccepted,
  readinessNameAccepted,
} from '../../orchestration/readiness-container';

// READY-008 (spec 0006): a real backend process on an isolated PostgreSQL 18 answers 200 with 0 applied migrations
// after provisioning, then with the number of database/migrations/*.sql files after migrate.ts (build plan step 1).
// Build plan step 2 adds the 400 then 200 order on an idle backend, an ACCESS EXCLUSIVE lock with a surge of 50
// concurrent requests, a revoked SELECT, a paused container, and a stopped then started container, with the backend
// process still alive, stderr empty, and every response and output free of credentials and database detail.
const root = resolve(import.meta.dir, '../../..');
const migrationCount = (await readdir(resolve(root, 'database/migrations'))).filter((name) => name.endsWith('.sql')).length;
const testSeed = Bun.env.FOUNDATION_TEST_SECRET_SEED;
const token = (role: string) => (testSeed ? createHmac('sha256', testSeed).update(role).digest('hex') : randomBytes(24).toString('hex'));
const adminPassword = token('admin');
const migratorPassword = token('migrator');
const backendPassword = token('backend');
const passwords = [adminPassword, migratorPassword, backendPassword];

// Container name and guard decided by spec 0006 (*Nama dan penjaga container*); the rule itself lives only in
// tests/orchestration/readiness-container.ts, and this file never spells out a Compose label. `test:database:real` names the
// container and passes it as FOUNDATION_READINESS_DB_CONTAINER, so it can remove the container through the same guard
// when bun test is stopped before afterAll runs; a direct `bun test` run names its own.
const image = 'foundation-postgres:18-pinned';
const containerName = Bun.env.FOUNDATION_READINESS_DB_CONTAINER || `foundation-readiness-db-${randomBytes(4).toString('hex')}`;

const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI'];
const pick = (keys: string[]) => Object.fromEntries(keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
const dockerEnv = pick([...BASE_ENV_KEYS, 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']);

let directory = '';
let containerCreated = false;
let hostPort = 0;
let backendPort = 0;
let adminUrl = '';
let migratorUrl = '';
let backendUrl = '';
let backend: ReturnType<typeof Bun.spawn> | undefined;
let backendOutput: Promise<[string, string]> | undefined;
const responseTexts: string[] = [];

async function command(args: string[], env: Record<string, string>, timeout = 30_000) {
  const child = Bun.spawn(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

/** A loopback port that was free a moment ago, from a temporary server on port 0 that is closed at once. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('No free loopback port');
  return address.port;
}

/** JSON.parse of a `{{json .Config.Labels}}` inspect output; text that is not JSON counts as refused labels. */
function parsedLabels(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Runs `docker <action>` on the readiness container only after the three guard steps of spec 0006 pass, in order:
 * (1) the name matches the `'database'` pattern before Docker is called, (2) `docker container inspect` succeeds, so
 * only a container object is examined, and (3) its labels pass `readinessContainerLabelsAccepted`. Any failure stops
 * with a fixed message and no Docker action. Arguments go as an array, never through a shell. With `ifPresent`, a
 * container Docker reports as missing (for example one `docker run` never created) is left alone; any other inspect
 * failure, such as an unreachable daemon or a timeout, still fails with the fixed message.
 */
async function guardedDocker(action: 'pause' | 'unpause' | 'stop' | 'start' | 'rm', { ifPresent = false } = {}): Promise<void> {
  if (!readinessNameAccepted('database', containerName)) throw new Error('Readiness container guard rejected the container name');
  const inspected = await command(['docker', 'container', 'inspect', '--format', '{{json .Config.Labels}}', containerName], dockerEnv);
  if (inspected.code !== 0) {
    if (ifPresent && readinessContainerMissing(inspected.code, inspected.stderr)) return;
    throw new Error('Readiness container guard could not inspect the container');
  }
  if (!readinessContainerLabelsAccepted(parsedLabels(inspected.stdout))) throw new Error('Readiness container guard rejected the container labels');
  const result = await command(['docker', ...(action === 'rm' ? ['rm', '-f'] : [action]), containerName], dockerEnv);
  if (result.code !== 0) throw new Error(`Readiness container ${action} failed`);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await Bun.sleep(intervalMs)) {
    if (await check()) return true;
  }
  return false;
}

/** Fetches a backend path and records the status line, headers, and body for the final credential scan. */
async function request(path: string) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${backendPort}${path}`);
  const text = await response.text();
  const elapsed = performance.now() - started;
  responseTexts.push(`${response.status}\n${[...response.headers].map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n${text}`);
  return { status: response.status, cacheControl: response.headers.get('cache-control'), text, body: JSON.parse(text) as Record<string, unknown>, elapsed };
}

const readiness = () => request('/api/readiness');
type Answer = Awaited<ReturnType<typeof readiness>>;

function expectCheckedAt(result: Answer): void {
  const checkedAt = result.body['checkedAt'];
  expect(typeof checkedAt).toBe('string');
  expect(Number.isNaN(Date.parse(checkedAt as string))).toBe(false);
  expect((checkedAt as string).endsWith('Z')).toBe(true);
}

function expectAvailable(result: Answer, appliedMigrations: number): void {
  expect(result.status).toBe(200);
  expect(result.cacheControl).toBe('no-store');
  expect(Object.keys(result.body).sort()).toEqual(['appliedMigrations', 'checkedAt', 'status']);
  expect(result.body['status']).toBe('available');
  expect(result.body['appliedMigrations']).toBe(appliedMigrations);
  expectCheckedAt(result);
}

function expectUnavailable(result: Answer): void {
  expect(result.status).toBe(503);
  expect(result.cacheControl).toBe('no-store');
  expect(Object.keys(result.body).sort()).toEqual(['checkedAt', 'status']);
  expect(result.body['status']).toBe('unavailable');
  expectCheckedAt(result);
}

function expectBusy(result: Answer): void {
  expect(result.status).toBe(429);
  expect(result.cacheControl).toBe('no-store');
  expect(result.text).toBe('{"status":"busy"}');
}

function expectInvalid(result: Answer): void {
  expect(result.status).toBe(400);
  expect(result.cacheControl).toBe('no-store');
  expect(result.text).toBe('{"error":"Invalid request"}');
}

async function expectStatusOk(): Promise<Answer> {
  const result = await request('/api/status');
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ status: 'ok' });
  return result;
}

/**
 * Asks again every 250 ms until the backend answers 200 or the limit passes. Every answer on the way must be a
 * well formed 429 or 503, so a recovery never hides a malformed response.
 */
async function waitForAvailable(timeoutMs: number): Promise<Answer> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await readiness();
    if (result.status === 200) return result;
    if (result.status === 429) expectBusy(result);
    else expectUnavailable(result);
    if (Date.now() >= deadline) throw new Error(`Readiness did not recover within ${timeoutMs} ms`);
    await Bun.sleep(250);
  }
}

async function stopBackend(): Promise<void> {
  if (!backend) return;
  if (backend.exitCode === null) backend.kill('SIGTERM');
  const exited = await Promise.race([backend.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) backend.kill('SIGKILL');
  await backend.exited;
}

async function cleanup(): Promise<void> {
  try {
    await stopBackend();
    if (containerCreated) {
      await guardedDocker('rm', { ifPresent: true });
      containerCreated = false;
    }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
  }
}

beforeAll(async () => {
  try {
    directory = await mkdtemp(resolve(tmpdir(), 'foundation-readiness-test-'));
    const envFile = resolve(directory, 'postgres.env');
    await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
    // Image check of spec 0006 (*Pemeriksaan image sebelum `docker run`*): a container inherits the labels of its image,
    // so an image that passes guarantees the guard accepts the new container and cleanup is never refused. A missing
    // image, or one that carries a Compose container key, fails here before any container exists.
    const inspectedImage = await command(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', image], dockerEnv);
    if (inspectedImage.code !== 0) throw new Error('Isolated PostgreSQL 18 image unavailable');
    if (!readinessImageLabelsAccepted(parsedLabels(inspectedImage.stdout))) {
      throw new Error('Readiness container guard would reject containers from foundation-postgres:18-pinned');
    }
    // Step (1) of the guard before Docker creates anything under a name that came from the environment.
    if (!readinessNameAccepted('database', containerName)) throw new Error('Readiness container guard rejected the container name');
    // A fixed host port and no --rm, so a later docker start in build plan step 2 reuses the same address.
    hostPort = await freePort();
    // From here a failed docker run may still have created the container, so cleanup removes it if it exists.
    containerCreated = true;
    const started = await command(['docker', 'run', '-d', '--name', containerName, ...READINESS_RUN_LABEL_ARGS, '--env-file', envFile,
      '-p', `127.0.0.1:${hostPort}:5432`, image], dockerEnv);
    if (started.code !== 0) throw new Error('Isolated PostgreSQL 18 did not start');
    adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${hostPort}/foundation`;
    migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${hostPort}/foundation`;
    backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:${hostPort}/foundation`;
    const ready = await waitFor(async () => {
      const probe = new SQL({ url: adminUrl, max: 1, connectionTimeout: 1 });
      try {
        await probe`SELECT 1`;
        return true;
      } catch {
        return false;
      } finally {
        await probe.close();
      }
    }, 30_000, 200);
    if (!ready) throw new Error('Isolated PostgreSQL did not become ready');

    const provisioned = await command([process.execPath, '--no-env-file', 'database/provision.ts', '--apply'], {
      PATH: process.env['PATH'] ?? '', FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
      FOUNDATION_MIGRATOR_PASSWORD: migratorPassword, FOUNDATION_BACKEND_PASSWORD: backendPassword,
    });
    if (provisioned.code !== 0) throw new Error('Isolated provisioning failed');

    // Backend environment of spec 0006 (*Environment proses anak*): nothing else, and no .env file.
    backendPort = await freePort();
    backend = Bun.spawn([process.execPath, '--no-env-file', 'apps/backend/src/index.ts'], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(backendPort), DATABASE_URL: backendUrl },
      stdout: 'pipe', stderr: 'pipe',
    });
    backendOutput = Promise.all([new Response(backend.stdout as ReadableStream).text(), new Response(backend.stderr as ReadableStream).text()]);
    const listening = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${backendPort}/api/status`)).status === 200;
      } catch {
        return false;
      }
    }, 60_000, 250);
    if (!listening) throw new Error('Backend did not answer /api/status');
  } catch (error) {
    // The first failure is the one reported; a cleanup failure after it must not hide it.
    await cleanup().catch(() => undefined);
    throw error;
  }
}, 120_000);

afterAll(async () => {
  await cleanup();
}, 30_000);

test('READY-008 a provisioned database without migrations answers 200 with 0 applied migrations', async () => {
  expectAvailable(await readiness(), 0);
}, 15_000);

test('READY-008 after migrate.ts the count equals the number of database/migrations/*.sql files', async () => {
  expect(migrationCount).toBeGreaterThan(0);
  const migrated = await command([process.execPath, '--no-env-file', 'database/migrate.ts', '--apply'], {
    PATH: process.env['PATH'] ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
  });
  expect(migrated.code).toBe(0);
  expectAvailable(await readiness(), migrationCount);
  // A second request reads the same count again from the database, without a restart.
  expectAvailable(await readiness(), migrationCount);
}, 30_000);

test('READY-008 a 400 for ?x=1 on an idle backend does not make the next valid request 429', async () => {
  expectInvalid(await request('/api/readiness?x=1'));
  expectAvailable(await readiness(), migrationCount);
}, 15_000);

test('READY-008 countAppliedMigrations keeps the statement limit inside its transaction, so the pool session default stays as it was', async () => {
  // In process, on the one connection of a backend role pool: a session SET instead of SET LOCAL would leave 2s behind.
  const pool = createDatabasePool(backendUrl, { max: 1 });
  try {
    const session = async () => {
      const [row] = await pool`SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.current_setting('statement_timeout') AS timeout`;
      return row as { pid: number; timeout: string };
    };
    const before = await session();
    expect(before.timeout).not.toBe('2s');
    expect(await countAppliedMigrations(pool)).toBe(migrationCount);
    const after = await session();
    expect(after.pid).toBe(before.pid);
    expect(after.timeout).toBe(before.timeout);
  } finally {
    await pool.close();
  }
}, 15_000);

test('READY-008 under an ACCESS EXCLUSIVE lock, 50 concurrent requests give one 503 under 5,000 ms and 49 busy answers', async () => {
  const lock = new SQL({ url: adminUrl, max: 1 });
  const monitor = new SQL({ url: adminUrl, max: 1 });
  let locked = false;
  try {
    await lock`BEGIN`;
    locked = true;
    await lock`LOCK TABLE common.schema_migrations IN ACCESS EXCLUSIVE MODE`;
    let checkFinished = false;
    const surge = Array.from({ length: 50 }, () => readiness().then((result) => {
      if (result.status !== 429) checkFinished = true;
      return result;
    }));
    // While the one active check waits for the lock, at most one foundation_backend session waits on it.
    const lockWaiters = async () => {
      const [row] = await monitor`SELECT count(*)::integer AS waiting FROM pg_catalog.pg_stat_activity
        WHERE usename = 'foundation_backend' AND wait_event_type = 'Lock'`;
      return (row as { waiting: number }).waiting;
    };
    const samples: number[] = [];
    for (const limit = Date.now() + 1500; Date.now() < limit && !samples.includes(1); await Bun.sleep(50)) samples.push(await lockWaiters());
    // The surge does not slow other answers: /api/status gives 200 and ?x=1 gives 400, each within 1 second.
    const status = await expectStatusOk();
    expect(status.elapsed).toBeLessThan(1000);
    const invalid = await request('/api/readiness?x=1');
    expectInvalid(invalid);
    expect(invalid.elapsed).toBeLessThan(1000);
    samples.push(await lockWaiters());
    const sampledDuringSurge = !checkFinished;
    const results = await Promise.all(surge);
    expect(sampledDuringSurge).toBe(true);
    expect(Math.max(...samples)).toBe(1);
    const answered = results.filter((result) => result.status !== 429);
    expect(answered).toHaveLength(1);
    expectUnavailable(answered[0]!);
    // The 2 s statement limit answers, not the 5,000 ms deadline: about 2,000 ms after the request.
    expect(answered[0]!.elapsed).toBeGreaterThanOrEqual(1800);
    expect(answered[0]!.elapsed).toBeLessThanOrEqual(3000);
    const busy = results.filter((result) => result.status === 429);
    expect(busy).toHaveLength(49);
    for (const result of busy) expectBusy(result);
  } finally {
    if (locked) await lock`ROLLBACK`;
    await lock.close();
    await monitor.close();
  }
  expectAvailable(await readiness(), migrationCount);
  expect(backend?.exitCode).toBeNull();
}, 30_000);

test('READY-008 a real 57014 error that arrives after a short deadline gives one unavailable, stays busy until it arrives, and stays silent', async () => {
  // In process, with the real count on a real backend role pool: the deadline is 500 ms, and the 2 s statement limit
  // makes PostgreSQL cancel the count behind an ACCESS EXCLUSIVE lock about 1.5 s after the answer was given.
  const pool = createDatabasePool(backendUrl);
  const lock = new SQL({ url: adminUrl, max: 1 });
  const events: string[] = [];
  const onRejection = () => { events.push('unhandledRejection'); };
  const onException = () => { events.push('uncaughtException'); };
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  console.log = () => { events.push('console.log'); };
  console.warn = () => { events.push('console.warn'); };
  console.error = () => { events.push('console.error'); };
  let locked = false;
  try {
    let calls = 0;
    const ends: { at: number; error: unknown }[] = [];
    const check = createReadinessCheck(() => {
      calls += 1;
      const query = countAppliedMigrations(pool);
      // Observes when and how the real count ends. This branch handles both results itself, so it never hides a
      // rejection the factory leaves unhandled.
      query.then(() => { ends.push({ at: performance.now(), error: undefined }); }, (error: unknown) => { ends.push({ at: performance.now(), error }); });
      return query;
    }, { deadlineMs: 500 });
    await lock`BEGIN`;
    locked = true;
    await lock`LOCK TABLE common.schema_migrations IN ACCESS EXCLUSIVE MODE`;
    const begun = performance.now();
    const received: ReadinessOutcome[] = [];
    await check().then((outcome) => { received.push(outcome); });
    const answeredAfter = performance.now() - begun;
    expect(received).toHaveLength(1);
    expect(received[0]?.status).toBe('unavailable');
    expect(Object.keys(received[0] ?? {}).sort()).toEqual(['checkedAt', 'status']);
    expect(answeredAfter).toBeGreaterThanOrEqual(450);
    expect(answeredAfter).toBeLessThan(1500);
    expect(ends).toHaveLength(0);
    expect(await check()).toEqual({ status: 'busy' });
    expect(calls).toBe(1);
    for (const limit = performance.now() + 5000; ends.length === 0 && performance.now() < limit;) await Bun.sleep(20);
    expect(ends).toHaveLength(1);
    expect(String((ends[0]?.error as { errno?: unknown } | undefined)?.errno)).toBe('57014');
    expect((ends[0]?.at ?? 0) - begun).toBeGreaterThanOrEqual(1800);
    await Bun.sleep(50);
    // The late failure changed nothing for the caller and released the marker.
    expect(received).toHaveLength(1);
    await lock`ROLLBACK`;
    locked = false;
    const next = await check();
    expect(calls).toBe(2);
    expect(next).toMatchObject({ status: 'available', appliedMigrations: migrationCount });
    await Bun.sleep(50);
    expect(events).toEqual([]);
  } finally {
    Object.assign(console, originalConsole);
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
    if (locked) await lock`ROLLBACK`;
    await lock.close();
    await pool.close();
  }
  expect(backend?.exitCode).toBeNull();
}, 20_000);

test('READY-008 a revoked SELECT gives 503 and GRANT restores 200', async () => {
  const admin = new SQL({ url: adminUrl, max: 1 });
  try {
    await admin`REVOKE SELECT ON TABLE common.schema_migrations FROM foundation_backend`;
    try {
      expectUnavailable(await readiness());
    } finally {
      await admin`GRANT SELECT ON TABLE common.schema_migrations TO foundation_backend`;
    }
    expectAvailable(await readiness(), migrationCount);
  } finally {
    await admin.close();
  }
  expect(backend?.exitCode).toBeNull();
}, 20_000);

test('READY-008 a paused container gives 503 at the 5,000 ms deadline, 429 until the late query ends, and 200 within 15 s after unpause', async () => {
  // A successful request first, so the pool holds an open connection that the paused server never answers.
  expectAvailable(await readiness(), migrationCount);
  await guardedDocker('pause');
  let paused = true;
  try {
    const timedOut = await readiness();
    expectUnavailable(timedOut);
    expect(timedOut.elapsed).toBeGreaterThanOrEqual(4900);
    expect(timedOut.elapsed).toBeLessThanOrEqual(5600);
    expectBusy(await readiness());
    await guardedDocker('unpause');
    paused = false;
    expectAvailable(await waitForAvailable(15_000), migrationCount);
  } finally {
    if (paused) await guardedDocker('unpause').catch(() => undefined);
  }
  expect(backend?.exitCode).toBeNull();
}, 60_000);

test('READY-008 a stopped container gives 503 while /api/status stays 200, and after docker start a request succeeds within 30 s', async () => {
  await guardedDocker('stop');
  let stopped = true;
  try {
    expectUnavailable(await readiness());
    await expectStatusOk();
    await guardedDocker('start');
    stopped = false;
    // The same backend process, without a restart, reads the count again from the started container.
    expectAvailable(await waitForAvailable(30_000), migrationCount);
  } finally {
    if (stopped) await guardedDocker('start').catch(() => undefined);
  }
  expect(backend?.exitCode).toBeNull();
}, 90_000);

test('READY-008 SIGTERM while a check waits on a paused database stops a backend within 3 s with exit code 0, Backend stopped, and empty stderr', async () => {
  // A second backend process with the same environment, so the output of the main backend stays as checked below.
  const port = await freePort();
  const child = Bun.spawn([process.execPath, '--no-env-file', 'apps/backend/src/index.ts'], {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: backendUrl },
    stdout: 'pipe', stderr: 'pipe',
  });
  const output = Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]);
  let paused = false;
  try {
    const listening = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/status`)).status === 200;
      } catch {
        return false;
      }
    }, 60_000, 100);
    expect(listening).toBe(true);
    // One successful check first, so this pool holds an open connection the paused server never answers.
    const first = await fetch(`http://127.0.0.1:${port}/api/readiness`);
    expect(first.status).toBe(200);
    await first.text();
    await guardedDocker('pause');
    paused = true;
    const waiting = fetch(`http://127.0.0.1:${port}/api/readiness`).then(async (response) => {
      await response.text();
      return response.status;
    }, () => 'closed' as const);
    await Bun.sleep(500);
    const signalled = performance.now();
    child.kill('SIGTERM');
    const exitCode = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'still running' as const)]);
    const elapsed = performance.now() - signalled;
    expect(exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3000);
    // The listener closed the waiting request on shutdown; it never got an answer.
    expect(await waiting).toBe('closed');
    const [stdout, stderr] = await output;
    expect(stderr).toBe('');
    expect(stdout).toBe(`Backend listening at http://127.0.0.1:${port}\nBackend stopped\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    if (paused) await guardedDocker('unpause');
  }
  // The main backend, idle during the pause, reads the count again without a restart.
  expectAvailable(await waitForAvailable(15_000), migrationCount);
  expect(backend?.exitCode).toBeNull();
}, 60_000);

test('READY-008 the route only reads: the migration history stays the same, and the backend role holds no write privilege on it', async () => {
  const admin = new SQL({ url: adminUrl, max: 1 });
  try {
    const snapshot = async () => admin`SELECT name, checksum, applied_at::text AS applied_at FROM common.schema_migrations ORDER BY name`;
    const before = await snapshot();
    expect(before).toHaveLength(migrationCount);
    for (let index = 0; index < 3; index += 1) expectAvailable(await readiness(), migrationCount);
    expect(await snapshot()).toEqual(before);
    const [privileges] = await admin`SELECT
      has_table_privilege('foundation_backend', 'common.schema_migrations', 'SELECT') AS can_select,
      has_table_privilege('foundation_backend', 'common.schema_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE') AS can_write`;
    expect(privileges).toEqual({ can_select: true, can_write: false });
  } finally {
    await admin.close();
  }
  expect(backend?.exitCode).toBeNull();
}, 20_000);

test('READY-008 responses and backend output carry no credential or database detail, and stderr stays empty', async () => {
  const forbidden = [...passwords, adminUrl, migratorUrl, backendUrl, 'postgres', 'SELECT', 'schema_migrations', 'foundation_backend', '57014', '42501'];
  const stackLine = /^\s*at\s/m;
  expect(responseTexts.length).toBeGreaterThan(50);
  for (const text of responseTexts) {
    for (const value of forbidden) expect(text).not.toContain(value);
    expect(text).not.toMatch(stackLine);
  }
  expect(backend?.exitCode).toBeNull();
  await stopBackend();
  const [stdout, stderr] = await backendOutput!;
  expect(stderr).toBe('');
  expect(stdout).toBe(`Backend listening at http://127.0.0.1:${backendPort}\nBackend stopped\n`);
  for (const value of forbidden) expect(stdout).not.toContain(value);
  expect(stdout).not.toMatch(stackLine);
}, 20_000);
