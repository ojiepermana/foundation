import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHmac, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from '../../../apps/backend/src/app';
import { migrationApplied, REQUIRED_MIGRATION } from '../../../apps/backend/src/features/health/health.queries';
import { createDatabasePool } from '../../../libs/server/database/client';
import {
  READINESS_RUN_LABEL_ARGS,
  readinessContainerLabelsAccepted,
  readinessContainerMissing,
  readinessImageLabelsAccepted,
  readinessNameAccepted,
} from '../../orchestration/readiness-container';
import { onSignalCleanup, type SignalCleanupCallback } from '../../orchestration/signal-cleanup';

// DEP-009 (spec 0012, AC-4): health.queries.ts and the health routes of createApp('production') with a real pool of
// role foundation_backend on an isolated PostgreSQL 18. It uses the harness of READY-008 (spec 0006): the same container
// guard and labels, the same container name variable of `test:database:real` (the database files run one after
// another, and READY-008 removes its container in afterAll, so the orchestration's guarded removal at the end covers
// this container too), provisioning and migration through the real runners, `docker pause`, and the signal cleanup of
// spec 0010. In order: 503 before migration, a name with quotes as a parameter, `statement_timeout` that never leaks
// into the pool connection, 200 after migration, 503 while common.schema_migrations is missing and while SELECT is
// revoked with 200 after each repair, and a frozen container that answers 503 within 5,500 ms with one real query
// call for more than 5,000 ms, then 200 within 15 seconds after unpause. No answer carries data.
const root = resolve(import.meta.dir, '../../..');
const testSeed = Bun.env.FOUNDATION_TEST_SECRET_SEED;
const token = (role: string) => (testSeed ? createHmac('sha256', testSeed).update(role).digest('hex') : randomBytes(24).toString('hex'));
const adminPassword = token('admin');
const migratorPassword = token('migrator');
const backendPassword = token('backend');
const passwords = [adminPassword, migratorPassword, backendPassword];
const READY = '{"status":"ready"}';
const UNAVAILABLE = '{"status":"unavailable"}';

const image = 'foundation-postgres:18-pinned';
const containerName = Bun.env.FOUNDATION_READINESS_DB_CONTAINER || `foundation-readiness-db-${randomBytes(4).toString('hex')}`;

const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI'];
const pick = (keys: string[]) => Object.fromEntries(keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
const dockerEnv = pick([...BASE_ENV_KEYS, 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']);

let directory = '';
let containerCreated = false;
let hostPort = 0;
let adminUrl = '';
let migratorUrl = '';
let backendUrl = '';
let pool: SQL | undefined;
/** Calls of `begin` on the backend pool, one per readiness query (health.queries.ts opens one transaction per check). */
let queryCalls = 0;
let app: ReturnType<typeof createApp> | undefined;
const answers: string[] = [];
// Signal cleanup of spec 0010 (row *Pembersihan sinyal suite nyata*): bun test runs no afterAll on SIGINT or SIGTERM, so
// the folder and the container are registered before they are created and released once the normal path removed them.
let releaseFolder = () => {};
let releaseContainer = () => {};

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

function parsedLabels(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

/** Synchronous `docker <args>` of the signal cleanup with `dockerEnv`; output captured, never printed. */
function dockerSync(args: string[], timeout: number): { code: number; stdout: string; stderr: string } | undefined {
  if (timeout <= 0) return undefined;
  try {
    const result = Bun.spawnSync(['docker', ...args], { cwd: root, env: dockerEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout });
    return result.exitedDueToTimeout ? undefined : { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch {
    return undefined;
  }
}

/** The container on every pass: the guard of spec 0006 with owner `'database'`, run synchronously, then `rm -f`. */
const containerCleanup: SignalCleanupCallback = ({ timeout }) => {
  if (!readinessNameAccepted('database', containerName)) return [containerName];
  const inspected = dockerSync(['container', 'inspect', '--format', '{{json .Config.Labels}}', containerName], timeout(30_000));
  if (inspected === undefined) return [containerName];
  if (inspected.code !== 0) return readinessContainerMissing(inspected.code, inspected.stderr) ? [] : [containerName];
  if (!readinessContainerLabelsAccepted(parsedLabels(inspected.stdout))) return [containerName];
  return dockerSync(['rm', '-f', containerName], timeout(30_000))?.code === 0 ? [] : [containerName];
};

/** The temporary folder with the env file: removed on pass 2, after the container. */
function folderCleanup(path: string): SignalCleanupCallback {
  return ({ pass }) => {
    if (pass !== 2) return [];
    try {
      rmSync(path, { recursive: true, force: true });
      return [];
    } catch {
      return [path];
    }
  };
}

/**
 * `docker <action>` on the container only after the three guard steps of spec 0006 pass: the name pattern, a successful
 * `docker container inspect`, and the labels. With `ifPresent`, a container Docker reports as missing is left alone.
 */
async function guardedDocker(action: 'pause' | 'unpause' | 'rm', { ifPresent = false } = {}): Promise<void> {
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

/** GET /health/ready through the production app on the real pool; the answer is kept for the final data check. */
async function ready() {
  const started = performance.now();
  const response = await app!.handle(new Request('http://localhost/health/ready'));
  const text = await response.text();
  answers.push(`${response.status}\n${[...response.headers].map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n${text}`);
  return { status: response.status, cacheControl: response.headers.get('cache-control'), text, elapsed: performance.now() - started };
}

function expectReady(answer: Awaited<ReturnType<typeof ready>>): void {
  expect(answer.status).toBe(200);
  expect(answer.cacheControl).toBe('no-store');
  expect(answer.text).toBe(READY);
}

function expectUnavailable(answer: Awaited<ReturnType<typeof ready>>): void {
  expect(answer.status).toBe(503);
  expect(answer.cacheControl).toBe('no-store');
  expect(answer.text).toBe(UNAVAILABLE);
}

/** A fresh production app on the real pool, so every test starts without an active check marker. */
function freshApp(): void {
  app = createApp('production', { database: countedPool() });
}

/** The backend pool behind a proxy that counts `begin`, the call that starts each real readiness query. */
function countedPool(): SQL {
  const target = pool!;
  return new Proxy(target, {
    get(object, key) {
      if (key === 'begin') {
        return (...args: unknown[]) => {
          queryCalls += 1;
          return (object.begin as (...values: unknown[]) => unknown).apply(object, args);
        };
      }
      return Reflect.get(object, key, object);
    },
  });
}

async function admin<T>(run: (sql: SQL) => Promise<T>): Promise<T> {
  const connection = new SQL({ url: adminUrl, max: 1 });
  try {
    return await run(connection);
  } finally {
    await connection.close();
  }
}

async function cleanup(): Promise<void> {
  try {
    if (pool) await pool.close({ timeout: 1 }).catch(() => undefined);
    pool = undefined;
    if (containerCreated) {
      await guardedDocker('rm', { ifPresent: true });
      containerCreated = false;
    }
    releaseContainer();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
    releaseFolder();
  }
}

beforeAll(async () => {
  try {
    directory = await mkdtemp(resolve(tmpdir(), 'foundation-health-test-'));
    releaseFolder = onSignalCleanup(folderCleanup(directory));
    const envFile = resolve(directory, 'postgres.env');
    await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
    // Image check of spec 0006: an image that passes guarantees the guard accepts the new container.
    const inspectedImage = await command(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', image], dockerEnv);
    if (inspectedImage.code !== 0) throw new Error('Isolated PostgreSQL 18 image unavailable');
    if (!readinessImageLabelsAccepted(parsedLabels(inspectedImage.stdout))) {
      throw new Error('Readiness container guard would reject containers from foundation-postgres:18-pinned');
    }
    if (!readinessNameAccepted('database', containerName)) throw new Error('Readiness container guard rejected the container name');
    hostPort = await freePort();
    // From here a failed docker run may still have created the container, so cleanup removes it if it exists.
    releaseContainer = onSignalCleanup(containerCleanup);
    containerCreated = true;
    const started = await command(['docker', 'run', '-d', '--name', containerName, ...READINESS_RUN_LABEL_ARGS, '--env-file', envFile,
      '-p', `127.0.0.1:${hostPort}:5432`, image], dockerEnv);
    if (started.code !== 0) throw new Error('Isolated PostgreSQL 18 did not start');
    adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${hostPort}/foundation`;
    migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${hostPort}/foundation`;
    backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:${hostPort}/foundation`;
    const reachable = await waitFor(async () => {
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
    if (!reachable) throw new Error('Isolated PostgreSQL did not become ready');
    const provisioned = await command([process.execPath, '--no-env-file', 'database/provision.ts', '--apply'], {
      PATH: process.env['PATH'] ?? '', FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
      FOUNDATION_MIGRATOR_PASSWORD: migratorPassword, FOUNDATION_BACKEND_PASSWORD: backendPassword,
    });
    if (provisioned.code !== 0) throw new Error('Isolated provisioning failed');
    pool = createDatabasePool(backendUrl);
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}, 120_000);

afterAll(async () => {
  await cleanup();
}, 30_000);

test('DEP-009 a provisioned database without migrations answers 503 and migrationApplied gives false', async () => {
  freshApp();
  expectUnavailable(await ready());
  expect(await migrationApplied(pool!, REQUIRED_MIGRATION)).toBe(false);
}, 15_000);

test('DEP-009 the migration name goes in as a parameter: a name with quotes gives false, not an error', async () => {
  for (const name of [`${REQUIRED_MIGRATION}' OR '1'='1`, "x'); DROP TABLE common.schema_migrations; --", '"quoted"', '']) {
    expect(await migrationApplied(pool!, name)).toBe(false);
  }
  const [row] = await admin((sql) => sql`SELECT to_regclass('common.schema_migrations') IS NOT NULL AS present`);
  expect((row as { present: boolean }).present).toBe(true);
}, 15_000);

test('DEP-009 SET LOCAL keeps the 2 s statement limit inside the transaction, so SHOW statement_timeout on the pool connection stays the same', async () => {
  const single = createDatabasePool(backendUrl, { max: 1 });
  try {
    const session = async () => {
      const [row] = await single`SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.current_setting('statement_timeout') AS timeout`;
      return row as { pid: number; timeout: string };
    };
    const before = await session();
    expect(before.timeout).not.toBe('2s');
    expect(await migrationApplied(single, REQUIRED_MIGRATION)).toBe(false);
    const after = await session();
    expect(after.pid).toBe(before.pid);
    expect(after.timeout).toBe(before.timeout);
    const [shown] = await single`SHOW statement_timeout`;
    expect((shown as { statement_timeout: string }).statement_timeout).toBe(before.timeout);
  } finally {
    await single.close();
  }
}, 15_000);

test('DEP-009 after migrate.ts the same app answers 200 {"status":"ready"} without a restart', async () => {
  freshApp();
  expectUnavailable(await ready());
  const migrated = await command([process.execPath, '--no-env-file', 'database/migrate.ts', '--apply'], {
    PATH: process.env['PATH'] ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
  });
  expect(migrated.code).toBe(0);
  expectReady(await ready());
  expect(await migrationApplied(pool!, REQUIRED_MIGRATION)).toBe(true);
}, 30_000);

test('DEP-009 while common.schema_migrations is missing the answer is 503, and 200 once it is back', async () => {
  freshApp();
  await admin((sql) => sql`ALTER TABLE common.schema_migrations RENAME TO schema_migrations_hidden`);
  try {
    expectUnavailable(await ready());
  } finally {
    await admin((sql) => sql`ALTER TABLE common.schema_migrations_hidden RENAME TO schema_migrations`);
  }
  expectReady(await ready());
}, 20_000);

test('DEP-009 a revoked SELECT gives 503 and GRANT restores 200', async () => {
  freshApp();
  await admin((sql) => sql`REVOKE SELECT ON TABLE common.schema_migrations FROM foundation_backend`);
  try {
    expectUnavailable(await ready());
  } finally {
    await admin((sql) => sql`GRANT SELECT ON TABLE common.schema_migrations TO foundation_backend`);
  }
  expectReady(await ready());
}, 20_000);

test('DEP-009 a frozen container answers 503 within 5,500 ms, stays 503 for more than 5,000 ms with one real query call, then 200 within 15 s after unpause', async () => {
  freshApp();
  // A successful check first, so the pool holds open connections that the paused server never answers.
  expectReady(await ready());
  await guardedDocker('pause');
  let paused = true;
  try {
    queryCalls = 0;
    const first = await ready();
    expectUnavailable(first);
    expect(first.elapsed).toBeGreaterThanOrEqual(4900);
    expect(first.elapsed).toBeLessThanOrEqual(5500);
    // More than 5,000 ms of further requests: every one is 503 at once, and no new query starts.
    const until = performance.now() + 5500;
    let later = 0;
    while (performance.now() < until) {
      const answer = await ready();
      expectUnavailable(answer);
      expect(answer.elapsed).toBeLessThan(250);
      later += 1;
      await Bun.sleep(250);
    }
    expect(later).toBeGreaterThan(10);
    expect(queryCalls).toBe(1);
    await guardedDocker('unpause');
    paused = false;
    const unpausedAt = performance.now();
    let recovered: Awaited<ReturnType<typeof ready>> | undefined;
    while (performance.now() - unpausedAt < 15_000) {
      const answer = await ready();
      if (answer.status === 200) {
        recovered = answer;
        break;
      }
      expectUnavailable(answer);
      await Bun.sleep(250);
    }
    expect(recovered).toBeDefined();
    expectReady(recovered!);
    expect(performance.now() - unpausedAt).toBeLessThanOrEqual(15_000);
  } finally {
    if (paused) await guardedDocker('unpause').catch(() => undefined);
  }
}, 60_000);

test('DEP-009 no answer carries a credential, a time, a count, a name, or database detail', () => {
  const forbidden = [...passwords, adminUrl, migratorUrl, backendUrl, 'postgres', 'SELECT', 'schema_migrations', 'foundation_backend', REQUIRED_MIGRATION, '42P01', '42501', '57014'];
  expect(answers.length).toBeGreaterThan(20);
  for (const text of answers) {
    for (const value of forbidden) expect(text).not.toContain(value);
    const body = text.slice(text.indexOf('\n\n') + 2);
    expect([READY, UNAVAILABLE]).toContain(body);
  }
});
