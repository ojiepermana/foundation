import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHmac, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createDatabasePool } from '../../../libs/server/database/client';
import { onSignalCleanup, type SignalCleanupCallback } from '../../orchestration/signal-cleanup';

const root = resolve(import.meta.dir, '../../..');
const testSeed = Bun.env.FOUNDATION_TEST_SECRET_SEED;
const token = (role: string) => testSeed ? createHmac('sha256', testSeed).update(role).digest('hex') : randomBytes(24).toString('hex');
const name = `foundation-db-test-${randomBytes(4).toString('hex')}`;
const adminPassword = token('admin');
const migratorPassword = token('migrator');
const backendPassword = token('backend');
let directory = '';
let port = 0;
let adminUrl = '';
let backendUrl = '';
let migratorUrl = '';
// Signal cleanup of spec 0010 (row *Pembersihan sinyal suite nyata*): bun test runs no afterAll on SIGINT or SIGTERM, so
// the folder and the container are registered before they are created and released once afterAll removed them.
let releaseFolder = () => {};
let releaseContainer = () => {};
const containerPattern = /^foundation-db-test-[0-9a-f]{8}$/;

/** Synchronous `docker <args>` of the signal cleanup, with the environment of the other Docker calls; output never printed. */
function dockerSync(args: string[], timeout: number): number | undefined {
  if (timeout <= 0) return undefined;
  try {
    const result = Bun.spawnSync(['docker', ...args], { cwd: root, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout });
    return result.exitedDueToTimeout ? undefined : result.exitCode;
  } catch {
    return undefined;
  }
}

/** The container: `docker rm -f` on every pass, only for the name this process made. */
const containerCleanup: SignalCleanupCallback = ({ timeout }) => {
  if (!containerPattern.test(name)) return [name];
  return dockerSync(['rm', '-f', name], timeout(30000)) === 0 ? [] : [name];
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

async function command(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn(args, { cwd: root, env: env ?? process.env, stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: out + err };
}

async function runProvision(options: { passwords?: boolean; url?: string; flag?: boolean } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', FOUNDATION_ADMIN_DATABASE_URL: options.url ?? adminUrl };
  if (options.passwords) {
    env.FOUNDATION_MIGRATOR_PASSWORD = migratorPassword;
    env.FOUNDATION_BACKEND_PASSWORD = backendPassword;
  }
  return command([process.execPath, '--no-env-file', 'database/provision.ts', ...(options.flag === false ? [] : ['--apply'])], env);
}

beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'foundation-db-test-'));
  releaseFolder = onSignalCleanup(folderCleanup(directory));
  const envFile = resolve(directory, 'postgres.env');
  await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
  releaseContainer = onSignalCleanup(containerCleanup);
  const started = await command(['docker', 'run', '--rm', '-d', '--name', name, '--env-file', envFile, '-p', '127.0.0.1::5432', 'foundation-postgres:18-pinned']);
  if (started.code !== 0) throw new Error('Isolated PostgreSQL 18 did not start');
  const mapped = await command(['docker', 'port', name, '5432/tcp']);
  if (mapped.code !== 0) throw new Error('Isolated PostgreSQL port unavailable');
  port = Number(mapped.output.trim().split(':').at(-1));
  adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${port}/foundation`;
  backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:${port}/foundation`;
  migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${port}/foundation`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const sql = new SQL({ url: adminUrl, max: 1, connectionTimeout: 1 });
    try { await sql`SELECT 1`; await sql.close(); return; } catch { await sql.close(); await Bun.sleep(200); }
  }
  throw new Error('Isolated PostgreSQL did not become ready');
}, 40000);

afterAll(async () => {
  // A container the normal path could not remove stays registered, so a later signal still removes it.
  if (/^foundation-db-test-[0-9a-f]{8}$/.test(name) && (await command(['docker', 'rm', '-f', name])).code === 0) releaseContainer();
  if (directory) await rm(directory, { recursive: true, force: true });
  releaseFolder();
});

test('DATA-001 rejects absent flag without mutation, provisions roles, and repeats without passwords', async () => {
  const absent = await runProvision({ passwords: true, flag: false });
  expect(absent.code).toBe(1);
  const missingPassword = await runProvision();
  expect(missingPassword.code).toBe(1);
  expect(missingPassword.output).toContain('Missing or invalid FOUNDATION_MIGRATOR_PASSWORD');
  const admin = new SQL(adminUrl);
  expect((await admin`SELECT count(*)::integer AS count FROM pg_catalog.pg_roles WHERE rolname = 'foundation_owner'`)[0]?.count).toBe(0);
  await admin.close();
  const [first, concurrent] = await Promise.all([runProvision({ passwords: true }), runProvision({ passwords: true })]);
  expect(first.code).toBe(0);
  expect(concurrent.code).toBe(0);
  expect(first.output + concurrent.output).toContain('common.schema_migrations: created');
  expect(first.output + concurrent.output).toContain('common.schema_migrations: verified');
  const second = await runProvision();
  expect(second.code).toBe(0);
  expect(second.output).toContain('database privileges: verified');
  const backend = createDatabasePool(backendUrl);
  try {
    expect((await backend`SELECT count(*)::integer AS count FROM common.schema_migrations`)[0]?.count).toBe(0);
    expect((await backend`SELECT current_setting('search_path') AS path`)[0]?.path).toBe('pg_catalog');
  } finally { await backend.close(); }
  for (const result of [first, concurrent, second]) for (const secret of [adminPassword, migratorPassword, backendPassword]) expect(result.output).not.toContain(secret);
}, 40000);

test('DATA-003 backend is denied mutations, temporary tables, owner role, and unqualified metadata', async () => {
  const backend = new SQL(backendUrl);
  const denied = [
    () => backend`INSERT INTO common.schema_migrations(name, checksum) VALUES ('x.sql', ${'a'.repeat(64)})`,
    () => backend`UPDATE common.schema_migrations SET checksum = ${'a'.repeat(64)}`,
    () => backend`DELETE FROM common.schema_migrations`,
    () => backend`TRUNCATE common.schema_migrations`,
    () => backend`CREATE TEMP TABLE unsafe_probe (id integer)`,
    () => backend`CREATE TABLE common.unsafe_probe (id integer)`,
    () => backend`SET ROLE foundation_owner`,
    () => backend`SELECT * FROM schema_migrations`,
  ];
  try {
    for (const query of denied) {
      let rejected = false;
      try { await query(); } catch { rejected = true; }
      expect(rejected).toBe(true);
    }
  } finally { await backend.close(); }
  const migrator = new SQL(migratorUrl);
  try {
    let rejected = false;
    try { await migrator`SELECT * FROM common.schema_migrations`; } catch { rejected = true; }
    expect(rejected).toBe(true);
    await migrator`SET ROLE foundation_owner`;
    expect((await migrator`SELECT count(*)::integer AS count FROM common.schema_migrations`)[0]?.count).toBe(0);
    await migrator`INSERT INTO common.schema_migrations(name, checksum) VALUES ('fixture.sql', ${'a'.repeat(64)})`;
    expect((await migrator`SELECT count(*)::integer AS count FROM common.schema_migrations`)[0]?.count).toBe(1);
    await migrator`DELETE FROM common.schema_migrations WHERE name = 'fixture.sql'`;
  } finally { await migrator.close(); }
}, 20000);

test('DATA-002 wrong target and structural drift fail without exposing credentials', async () => {
  const wrong = await runProvision({ url: adminUrl.replace('/foundation', '/postgres') });
  expect(wrong.code).toBe(1);
  expect(wrong.output).not.toContain(adminPassword);
  const admin = new SQL(adminUrl);
  try {
    await admin`ALTER TABLE common.schema_migrations ALTER COLUMN applied_at DROP DEFAULT`;
    const drift = await runProvision();
    expect(drift.code).toBe(1);
    expect(drift.output).toContain('Metadata column drift');
    expect(drift.output).not.toContain(adminPassword);
  } finally {
    await admin`ALTER TABLE common.schema_migrations ALTER COLUMN applied_at SET DEFAULT transaction_timestamp()`;
    await admin.close();
  }
}, 20000);

test('DATA-002 checksum constraint drift fails even when the expected pattern remains in the definition', async () => {
  const admin = new SQL(adminUrl);
  try {
    await admin`ALTER TABLE common.schema_migrations DROP CONSTRAINT schema_migrations_checksum_hex`;
    await admin.unsafe("ALTER TABLE common.schema_migrations ADD CONSTRAINT schema_migrations_checksum_hex CHECK (checksum ~ '^[0-9a-f]{64}$' OR true)");
    const drift = await runProvision();
    expect(drift.code).toBe(1);
    expect(drift.output).toContain('Metadata constraint drift');
    expect(drift.output).not.toContain(adminPassword);
    const [constraint] = await admin`SELECT pg_catalog.pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint WHERE conrelid = 'common.schema_migrations'::regclass AND conname = 'schema_migrations_checksum_hex'`;
    expect(String(constraint?.definition)).toContain('OR true');
    await admin`ALTER TABLE common.schema_migrations DROP CONSTRAINT schema_migrations_checksum_hex`;
    await admin.unsafe("ALTER TABLE common.schema_migrations ADD CONSTRAINT schema_migrations_checksum_hex CHECK (checksum ~ '^[0-9a-f]{64}$') NOT VALID");
    const unvalidated = await runProvision();
    expect(unvalidated.code).toBe(1);
    expect(unvalidated.output).toContain('Metadata constraint drift');
  } finally {
    await admin`ALTER TABLE common.schema_migrations DROP CONSTRAINT schema_migrations_checksum_hex`;
    await admin.unsafe("ALTER TABLE common.schema_migrations ADD CONSTRAINT schema_migrations_checksum_hex CHECK (checksum ~ '^[0-9a-f]{64}$')");
    await admin.close();
  }
}, 20000);

test('DATA-002 role drift fails and known PUBLIC grant is repaired', async () => {
  const admin = new SQL(adminUrl);
  try {
    await admin`ALTER ROLE foundation_backend CREATEROLE`;
    const drift = await runProvision();
    expect(drift.code).toBe(1);
    expect(drift.output).toContain('Role drift');
    await admin`ALTER ROLE foundation_backend NOCREATEROLE`;
    await admin`GRANT TEMPORARY ON DATABASE foundation TO PUBLIC`;
    const repaired = await runProvision();
    expect(repaired.code).toBe(0);
    expect(repaired.output).toContain('database privileges: repaired');
    expect((await admin`SELECT pg_catalog.has_database_privilege('foundation_backend', 'foundation', 'TEMPORARY') AS allowed`)[0]?.allowed).toBe(false);
  } finally {
    await admin`ALTER ROLE foundation_backend NOCREATEROLE`;
    await admin`REVOKE TEMPORARY ON DATABASE foundation FROM PUBLIC`;
    await admin.close();
  }
}, 20000);

test('DATA-002 default ACL and grant option drift fail without changing privileges', async () => {
  const admin = new SQL(adminUrl);
  try {
    await admin`ALTER DEFAULT PRIVILEGES FOR ROLE foundation_owner IN SCHEMA common GRANT SELECT ON TABLES TO PUBLIC`;
    const defaults = await runProvision();
    expect(defaults.code).toBe(1);
    expect(defaults.output).toContain('Default privilege drift');
    await admin`ALTER DEFAULT PRIVILEGES FOR ROLE foundation_owner IN SCHEMA common REVOKE SELECT ON TABLES FROM PUBLIC`;
    await admin`GRANT SELECT ON TABLE common.schema_migrations TO foundation_backend WITH GRANT OPTION`;
    const grant = await runProvision();
    expect(grant.code).toBe(1);
    expect(grant.output).toContain('Grant option drift');
  } finally {
    await admin`ALTER DEFAULT PRIVILEGES FOR ROLE foundation_owner IN SCHEMA common REVOKE SELECT ON TABLES FROM PUBLIC`;
    await admin`REVOKE GRANT OPTION FOR SELECT ON TABLE common.schema_migrations FROM foundation_backend`;
    await admin.close();
  }
}, 20000);

test('DATA-002 unexpected owner membership is rejected', async () => {
  const admin = new SQL(adminUrl);
  try {
    await admin`CREATE ROLE foundation_test_intruder NOLOGIN`;
    await admin`GRANT foundation_owner TO foundation_test_intruder`;
    const result = await runProvision();
    expect(result.code).toBe(1);
    expect(result.output).toContain('Role membership drift');
  } finally {
    await admin`REVOKE foundation_owner FROM foundation_test_intruder`;
    await admin`DROP ROLE foundation_test_intruder`;
    await admin.close();
  }
}, 20000);

test('DATA-004 concurrent provisioning serializes and leaves one valid state', async () => {
  const [a, b] = await Promise.all([runProvision(), runProvision()]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  const admin = new SQL(adminUrl);
  try { expect((await admin`SELECT count(*)::integer AS count FROM pg_catalog.pg_class WHERE oid = 'common.schema_migrations'::regclass`)[0]?.count).toBe(1); }
  finally { await admin.close(); }
}, 30000);

test('DATA-004 lock timeout leaves existing state intact', async () => {
  const admin = new SQL({ url: adminUrl, max: 1 });
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const held = admin.begin(async (tx) => {
    await tx`SELECT pg_catalog.pg_advisory_xact_lock(638727, 5)`;
    acquired();
    await Bun.sleep(6500);
  });
  try {
    await ready;
    const started = performance.now();
    const result = await runProvision();
    expect(result.code).toBe(1);
    expect(result.output).toContain('Database provisioning failed');
    expect(performance.now() - started).toBeGreaterThan(4500);
    await held;
    expect((await admin`SELECT count(*)::integer AS count FROM common.schema_migrations`)[0]?.count).toBe(0);
  } finally { await held; await admin.close(); }
}, 15000);

test('DATA-005 pool validates URL, reuses a connection, and closes', async () => {
  expect(() => createDatabasePool('not-a-url')).toThrow('Invalid database URL');
  expect(() => createDatabasePool(backendUrl, { max: 6 })).toThrow('Invalid database pool size');
  const pool = createDatabasePool(backendUrl, { max: 1 });
  const first = (await pool`SELECT pg_catalog.pg_backend_pid() AS pid`)[0]?.pid;
  const second = (await pool`SELECT pg_catalog.pg_backend_pid() AS pid`)[0]?.pid;
  expect(first).toBe(second);
  await pool.close();
  let rejected = false;
  try { await pool`SELECT 1`; } catch { rejected = true; }
  expect(rejected).toBe(true);
}, 10000);

test('DATA-005 backend keeps base route alive with a lazy pool and stops on SIGTERM', async () => {
  const temporary = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const backendPort = temporary.port!;
  await temporary.stop(true);
  const child = Bun.spawn([process.execPath, '--no-env-file', 'apps/backend/src/index.ts'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(backendPort), DATABASE_URL: backendUrl },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const deadline = Date.now() + 5000;
    let response: Response | undefined;
    while (Date.now() < deadline) {
      try { response = await fetch(`http://127.0.0.1:${backendPort}/api/status`); break; }
      catch { await Bun.sleep(30); }
    }
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ status: 'ok' });
    const admin = new SQL(adminUrl);
    try {
      expect((await admin`SELECT count(*)::integer AS count FROM pg_catalog.pg_stat_activity WHERE usename = 'foundation_backend' AND datname = 'foundation'`)[0]?.count).toBe(0);
    } finally { await admin.close(); }
    child.kill('SIGTERM');
    expect(await Promise.race([child.exited, Bun.sleep(6000).then(() => { throw new Error('Backend shutdown timeout'); })])).toBe(0);
    expect(await new Response(child.stdout).text()).toContain('Backend stopped');
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
}, 12000);

test('DATA-005 backend serves the base route without a database URL and stops on SIGINT', async () => {
  const temporary = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const backendPort = temporary.port!;
  await temporary.stop(true);
  const child = Bun.spawn([process.execPath, '--no-env-file', 'apps/backend/src/index.ts'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(backendPort) },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const deadline = Date.now() + 5000;
    let response: Response | undefined;
    while (Date.now() < deadline) {
      try { response = await fetch(`http://127.0.0.1:${backendPort}/api/status`); break; }
      catch { await Bun.sleep(30); }
    }
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ status: 'ok' });
    child.kill('SIGINT');
    expect(await Promise.race([child.exited, Bun.sleep(6000).then(() => { throw new Error('Backend shutdown timeout'); })])).toBe(0);
    expect(await new Response(child.stdout).text()).toContain('Backend stopped');
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
}, 12000);
