import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHmac, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runDatabaseCommand } from '../../../database/runner';
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
  return { code, output: out + err, stdout: out, stderr: err };
}

/** `backup` sets FOUNDATION_BACKUP_PASSWORD, also to an empty or short value; absent means the variable is not set. */
async function runProvision(options: { passwords?: boolean; url?: string; flag?: boolean; backup?: string } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', FOUNDATION_ADMIN_DATABASE_URL: options.url ?? adminUrl };
  if (options.passwords) {
    env.FOUNDATION_MIGRATOR_PASSWORD = migratorPassword;
    env.FOUNDATION_BACKEND_PASSWORD = backendPassword;
  }
  if (options.backup !== undefined) env.FOUNDATION_BACKUP_PASSWORD = options.backup;
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

// BKP-002 of spec 0013 (tabel *Kasus provisioning role backup* and the privilege boundaries of AC-2), after every DATA
// test of this file and in the order of that table. The first test is the case without the backup role and without
// FOUNDATION_BACKUP_PASSWORD, every drift case puts the state back in `finally`, and the last test removes the role
// (REVOKE ALL ON DATABASE foundation FROM foundation_backup, then DROP ROLE foundation_backup), so the cluster of this
// file ends as it was before BKP-002.
const backupPassword = token('backup');
/** A second valid password, random per run, to prove provisioning never replaces the password of an existing role. */
const otherBackupPassword = randomBytes(24).toString('hex');
const backupUrl = (password: string) => `postgres://foundation_backup:${password}@127.0.0.1:${port}/foundation`;

/** The report of an already provisioned cluster before spec 0013: no foundation_backup line at all. */
const REPORT_BEFORE = [
  'foundation_owner: verified', 'foundation_migrator: verified', 'foundation_backend: verified', 'foundation_migrator membership: verified',
  'common: verified', 'users: verified', 'auth: verified', 'common.schema_migrations: verified', 'database privileges: verified',
];

/** The report once the backup role exists: `backup`, `membership`, and `privileges` replace the three changing states. */
function backupReport(backup: string, membership: string, privileges: string): string[] {
  return [
    'foundation_owner: verified', 'foundation_migrator: verified', 'foundation_backend: verified', `foundation_backup: ${backup}`,
    'foundation_migrator membership: verified', `foundation_backup membership: ${membership}`,
    'common: verified', 'users: verified', 'auth: verified', 'common.schema_migrations: verified', `database privileges: ${privileges}`,
  ];
}

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

/**
 * Everything provisioning can change: the foundation_* roles with their attributes and a hash of their password
 * verifier (never the verifier itself), every membership that involves one of them, the ACL of the database, of the
 * four schemas, and of the metadata table, and the role settings of the database. Equal before and after a failed
 * case proves the case changed nothing.
 */
async function catalogState(admin: SQL): Promise<string> {
  const [row] = await admin`SELECT pg_catalog.json_build_object(
    'roles', (SELECT coalesce(pg_catalog.json_agg(pg_catalog.json_build_array(rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
      rolreplication, rolbypassrls, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(rolpassword, ''), 'UTF8')), 'hex')) ORDER BY rolname), '[]')
      FROM pg_catalog.pg_authid WHERE rolname LIKE 'foundation\\_%'),
    'memberships', (SELECT coalesce(pg_catalog.json_agg(pg_catalog.json_build_array(member.rolname, granted.rolname, m.admin_option, m.inherit_option, m.set_option)
      ORDER BY member.rolname, granted.rolname), '[]')
      FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles member ON member.oid = m.member JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
      WHERE member.rolname LIKE 'foundation\\_%' OR granted.rolname LIKE 'foundation\\_%'),
    'database', (SELECT datacl::text FROM pg_catalog.pg_database WHERE datname = 'foundation'),
    'schemas', (SELECT pg_catalog.json_agg(pg_catalog.json_build_array(nspname, nspacl::text) ORDER BY nspname)
      FROM pg_catalog.pg_namespace WHERE nspname IN ('public', 'common', 'users', 'auth')),
    'metadata', (SELECT relacl::text FROM pg_catalog.pg_class WHERE oid = 'common.schema_migrations'::regclass),
    'settings', (SELECT coalesce(pg_catalog.json_agg(pg_catalog.json_build_array(r.rolname, s.setconfig) ORDER BY r.rolname), '[]')
      FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
      WHERE s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = 'foundation'))
  )::text AS state`;
  return String(row?.state);
}

/** A failed case: exit 1, exactly `message` on stderr, nothing on stdout, and no change to `catalogState`. */
async function expectFailedCase(admin: SQL, message: string, options: { backup?: string } = {}): Promise<void> {
  const before = await catalogState(admin);
  const result = await runProvision(options);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe(`${message}\n`);
  expect(result.stdout).toBe('');
  expect(await catalogState(admin)).toBe(before);
  for (const secret of [adminPassword, backupPassword, otherBackupPassword]) expect(result.output).not.toContain(secret);
}

async function expectReport(options: { backup?: string }, report: string[]): Promise<void> {
  const result = await runProvision(options);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(lines(result.stdout)).toEqual(report);
  for (const secret of [adminPassword, backupPassword, otherBackupPassword]) expect(result.output).not.toContain(secret);
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

/** Privilege types the database ACL gives foundation_backup, with `*` for a grant option. */
async function backupDatabaseAcl(admin: SQL): Promise<string[]> {
  const rows = await admin`SELECT x.privilege_type || CASE WHEN x.is_grantable THEN '*' ELSE '' END AS privilege
    FROM pg_catalog.pg_database d, LATERAL pg_catalog.aclexplode(d.datacl) x
    WHERE d.datname = 'foundation' AND x.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'foundation_backup')
    ORDER BY 1`;
  return rows.map((row: { privilege: string }) => row.privilege);
}

async function backupSearchPath(admin: SQL): Promise<string[] | null> {
  const [row] = await admin`SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s
    WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'foundation_backup')
      AND s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = 'foundation')`;
  return (row?.setconfig as string[] | undefined) ?? null;
}

test('BKP-002 without the backup role and without FOUNDATION_BACKUP_PASSWORD provisioning prints exactly the report from before spec 0013', async () => {
  const admin = new SQL(adminUrl);
  try {
    expect((await admin`SELECT count(*)::integer AS count FROM pg_catalog.pg_roles WHERE rolname = 'foundation_backup'`)[0]?.count).toBe(0);
    await expectReport({}, REPORT_BEFORE);
    expect((await admin`SELECT count(*)::integer AS count FROM pg_catalog.pg_roles WHERE rolname = 'foundation_backup'`)[0]?.count).toBe(0);
  } finally { await admin.close(); }
}, 20000);

test('BKP-002 a valid FOUNDATION_BACKUP_PASSWORD creates foundation_backup with its pg_read_all_data membership, CONNECT only, and search_path', async () => {
  const admin = new SQL(adminUrl);
  try {
    await expectReport({ backup: backupPassword }, backupReport('created', 'created', 'repaired'));
    const [role] = await admin`SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_catalog.pg_roles WHERE rolname = 'foundation_backup'`;
    expect(role).toEqual({ rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    const memberships = await admin`SELECT member.rolname AS member, granted.rolname AS granted, m.admin_option, m.inherit_option, m.set_option
      FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles member ON member.oid = m.member JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
      WHERE member.rolname = 'foundation_backup' OR granted.rolname = 'foundation_backup'`;
    expect([...memberships]).toEqual([{ member: 'foundation_backup', granted: 'pg_read_all_data', admin_option: false, inherit_option: false, set_option: true }]);
    expect(await backupDatabaseAcl(admin)).toEqual(['CONNECT']);
    expect(await backupSearchPath(admin)).toEqual(['search_path=pg_catalog']);
  } finally { await admin.close(); }
}, 20000);

test('BKP-002 an existing foundation_backup is verified without the variable or with a valid password, and its password is never replaced', async () => {
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
  await expectReport({ backup: backupPassword }, backupReport('verified', 'verified', 'verified'));
  await expectReport({ backup: otherBackupPassword }, backupReport('verified', 'verified', 'verified'));
  const original = new SQL({ url: backupUrl(backupPassword), max: 1, connectionTimeout: 3 });
  try { expect((await original`SELECT current_user AS name`)[0]?.name).toBe('foundation_backup'); }
  finally { await original.close(); }
  const other = new SQL({ url: backupUrl(otherBackupPassword), max: 1, connectionTimeout: 3 });
  try { expect(await rejects(() => other`SELECT 1`)).toBe(true); }
  finally { await other.close(); }
}, 30000);

test('BKP-002 foundation_backup reads only through SET ROLE pg_read_all_data, cannot write, create, or take another role, and the runner still passes verifyIdentity', async () => {
  const backup = new SQL({ url: backupUrl(backupPassword), max: 1 });
  try {
    expect(await rejects(() => backup`SELECT count(*) FROM common.schema_migrations`)).toBe(true);
    await backup`SET ROLE pg_read_all_data`;
    expect((await backup`SELECT count(*)::integer AS count FROM common.schema_migrations`)[0]?.count).toBe(0);
    for (const statement of [
      `INSERT INTO common.schema_migrations(name, checksum) VALUES ('x.sql', '${'a'.repeat(64)}')`,
      `UPDATE common.schema_migrations SET checksum = '${'a'.repeat(64)}'`,
      'DELETE FROM common.schema_migrations',
      'TRUNCATE common.schema_migrations',
      'CREATE TABLE users.x (id int)',
      'CREATE TEMP TABLE backup_probe (id int)',
    ]) expect(await rejects(() => backup.unsafe(statement)), statement).toBe(true);
    expect(await rejects(() => backup`SET ROLE foundation_owner`)).toBe(true);
    // The documented boundary: after SET ROLE pg_read_all_data the role reads the password verifiers in pg_authid. Only
    // the count is read here, never a verifier.
    expect((await backup`SELECT count(*)::integer AS count FROM pg_catalog.pg_authid WHERE rolname = 'foundation_admin'`)[0]?.count).toBe(1);
    expect((await backup`SELECT current_user AS name`)[0]?.name).toBe('pg_read_all_data');
  } finally { await backup.close(); }
  const backend = new SQL({ url: backendUrl, max: 1 });
  try { expect(await rejects(() => backend`SET ROLE pg_read_all_data`)).toBe(true); }
  finally { await backend.close(); }
  // The seed command of the runner checks identity and metadata first, then stops at the pending repository migration
  // without a change: `Migrations pending` proves verifyIdentity passed with the backup role present.
  const migrator = createDatabasePool(migratorUrl, { max: 1 });
  let message = '';
  try {
    await runDatabaseCommand('seed', migrator, root);
  } catch (error) {
    message = (error as Error).message;
  } finally { await migrator.close(); }
  expect(message).toBe('Migrations pending');
}, 20000);

test('BKP-002 an empty or short FOUNDATION_BACKUP_PASSWORD fails while the role exists, without a change', async () => {
  const admin = new SQL(adminUrl);
  try {
    await expectFailedCase(admin, 'Missing or invalid FOUNDATION_BACKUP_PASSWORD', { backup: '' });
    await expectFailedCase(admin, 'Missing or invalid FOUNDATION_BACKUP_PASSWORD', { backup: 'a'.repeat(15) });
  } finally { await admin.close(); }
}, 20000);

test('BKP-002 INHERIT, BYPASSRLS, CREATEDB, or NOLOGIN on foundation_backup fails Role drift: foundation_backup without a change', async () => {
  const admin = new SQL(adminUrl);
  try {
    for (const attribute of ['INHERIT', 'BYPASSRLS', 'CREATEDB', 'NOLOGIN']) {
      await admin.unsafe(`ALTER ROLE foundation_backup ${attribute}`);
      try {
        await expectFailedCase(admin, 'Role drift: foundation_backup');
      } finally {
        await admin`ALTER ROLE foundation_backup LOGIN NOINHERIT NOBYPASSRLS NOCREATEDB`;
      }
    }
  } finally { await admin.close(); }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 30000);

test('BKP-002 SUPERUSER, CREATEROLE, or REPLICATION on foundation_backup fails Role drift: foundation_backup without a change', async () => {
  // covers: AC-2 (tabel Matriks role backup, baris Atribut: rolsuper, rolcreaterole, dan rolreplication false)
  const admin = new SQL(adminUrl);
  try {
    for (const attribute of ['SUPERUSER', 'CREATEROLE', 'REPLICATION']) {
      await admin.unsafe(`ALTER ROLE foundation_backup ${attribute}`);
      try {
        await expectFailedCase(admin, 'Role drift: foundation_backup');
      } finally {
        await admin`ALTER ROLE foundation_backup NOSUPERUSER NOCREATEROLE NOREPLICATION`;
      }
    }
  } finally { await admin.close(); }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 30000);

test('BKP-002 an extra membership or a changed pg_read_all_data option fails Role membership drift without a change', async () => {
  const admin = new SQL(adminUrl);
  const cases: Array<[string, string]> = [
    ['GRANT pg_write_all_data TO foundation_backup', 'REVOKE pg_write_all_data FROM foundation_backup'],
    ['GRANT foundation_owner TO foundation_backup', 'REVOKE foundation_owner FROM foundation_backup'],
    ['GRANT pg_read_all_data TO foundation_backup WITH INHERIT TRUE', 'GRANT pg_read_all_data TO foundation_backup WITH INHERIT FALSE'],
    ['GRANT pg_read_all_data TO foundation_backup WITH ADMIN TRUE', 'REVOKE ADMIN OPTION FOR pg_read_all_data FROM foundation_backup'],
    ['GRANT pg_read_all_data TO foundation_backup WITH SET FALSE', 'GRANT pg_read_all_data TO foundation_backup WITH SET TRUE'],
  ];
  try {
    const expected = await catalogState(admin);
    for (const [drift, restore] of cases) {
      await admin.unsafe(drift);
      try {
        expect(await catalogState(admin), drift).not.toBe(expected);
        await expectFailedCase(admin, 'Role membership drift');
      } finally {
        await admin.unsafe(restore);
      }
      expect(await catalogState(admin), restore).toBe(expected);
    }
  } finally { await admin.close(); }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 40000);

test('BKP-002 a role holding membership in foundation_backup, a runtime role or one outside the matrix, fails Role membership drift without a change', async () => {
  // covers: AC-2 (tabel Matriks role backup, baris Membership: tidak ada baris lain yang anggota atau role nya
  // foundation_backup; jalur SET ROLE foundation_backup lalu pg_read_all_data tidak boleh terbuka bagi role lain)
  const admin = new SQL(adminUrl);
  try {
    await admin`CREATE ROLE foundation_test_member NOLOGIN`;
    try {
      for (const member of ['foundation_backend', 'foundation_test_member']) {
        await admin.unsafe(`GRANT foundation_backup TO ${member}`);
        try {
          await expectFailedCase(admin, 'Role membership drift');
        } finally {
          await admin.unsafe(`REVOKE foundation_backup FROM ${member}`);
        }
      }
    } finally {
      await admin`DROP ROLE foundation_test_member`;
    }
  } finally { await admin.close(); }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 30000);

test('BKP-002 a missing pg_read_all_data membership is created again', async () => {
  const admin = new SQL(adminUrl);
  try {
    await admin`REVOKE pg_read_all_data FROM foundation_backup`;
    await expectReport({}, backupReport('verified', 'created', 'verified'));
    expect((await admin`SELECT pg_catalog.pg_has_role('foundation_backup', 'pg_read_all_data', 'SET') AS allowed`)[0]?.allowed).toBe(true);
  } finally { await admin.close(); }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 20000);

test('BKP-002 CREATE or TEMPORARY on the database for foundation_backup is repaired to CONNECT only', async () => {
  const admin = new SQL(adminUrl);
  try {
    for (const privilege of ['CREATE', 'TEMPORARY']) {
      await admin.unsafe(`GRANT ${privilege} ON DATABASE foundation TO foundation_backup`);
      expect(await backupDatabaseAcl(admin)).toContain(privilege);
      await expectReport({}, backupReport('verified', 'verified', 'repaired'));
      expect(await backupDatabaseAcl(admin)).toEqual(['CONNECT']);
    }
  } finally {
    await admin`REVOKE CREATE, TEMPORARY ON DATABASE foundation FROM foundation_backup`;
    await admin.close();
  }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 30000);

test('BKP-002 CONNECT with grant option for foundation_backup fails Grant option drift without a change', async () => {
  const admin = new SQL(adminUrl);
  try {
    await admin`GRANT CONNECT ON DATABASE foundation TO foundation_backup WITH GRANT OPTION`;
    expect(await backupDatabaseAcl(admin)).toEqual(['CONNECT*']);
    await expectFailedCase(admin, 'Grant option drift');
  } finally {
    await admin`REVOKE GRANT OPTION FOR CONNECT ON DATABASE foundation FROM foundation_backup`;
    await admin.close();
  }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 20000);

test('BKP-002 a direct grant to foundation_backup on public, common, users, auth, or common.schema_migrations fails Unknown privilege drift without a change', async () => {
  const admin = new SQL(adminUrl);
  try {
    for (const object of ['SCHEMA public', 'SCHEMA common', 'SCHEMA users', 'SCHEMA auth', 'TABLE common.schema_migrations']) {
      const privilege = object.startsWith('SCHEMA') ? 'USAGE' : 'SELECT';
      await admin.unsafe(`GRANT ${privilege} ON ${object} TO foundation_backup`);
      try {
        await expectFailedCase(admin, 'Unknown privilege drift');
      } finally {
        await admin.unsafe(`REVOKE ${privilege} ON ${object} FROM foundation_backup`);
      }
    }
  } finally { await admin.close(); }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 40000);

test('BKP-002 a changed or removed search_path of foundation_backup is repaired', async () => {
  const admin = new SQL(adminUrl);
  try {
    for (const change of ['ALTER ROLE foundation_backup IN DATABASE foundation SET search_path = public', 'ALTER ROLE foundation_backup IN DATABASE foundation RESET search_path']) {
      await admin.unsafe(change);
      expect(await backupSearchPath(admin), change).not.toEqual(['search_path=pg_catalog']);
      await expectReport({}, backupReport('verified', 'verified', 'repaired'));
      expect(await backupSearchPath(admin)).toEqual(['search_path=pg_catalog']);
    }
  } finally { await admin.close(); }
  await expectReport({}, backupReport('verified', 'verified', 'verified'));
}, 30000);

test('BKP-002 the last test removes foundation_backup; without it the report is the one from before, a bad password still fails, and an unknown database grantee still fails', async () => {
  const admin = new SQL(adminUrl);
  try {
    await admin`REVOKE ALL ON DATABASE foundation FROM foundation_backup`;
    await admin`DROP ROLE foundation_backup`;
    expect((await admin`SELECT count(*)::integer AS count FROM pg_catalog.pg_roles WHERE rolname = 'foundation_backup'`)[0]?.count).toBe(0);
    await expectReport({}, REPORT_BEFORE);
    // Row 4 without the role: an empty or short password fails whether the role exists or not.
    await expectFailedCase(admin, 'Missing or invalid FOUNDATION_BACKUP_PASSWORD', { backup: '' });
    await expectFailedCase(admin, 'Missing or invalid FOUNDATION_BACKUP_PASSWORD', { backup: 'a'.repeat(15) });
    // Last row: the unknown grantee check stays active without the backup role (no scalar subquery that turns NULL).
    await admin`CREATE ROLE foundation_test_stranger NOLOGIN`;
    try {
      await admin`GRANT CONNECT ON DATABASE foundation TO foundation_test_stranger`;
      await expectFailedCase(admin, 'Unknown privilege drift');
    } finally {
      await admin`REVOKE ALL ON DATABASE foundation FROM foundation_test_stranger`;
      await admin`DROP ROLE foundation_test_stranger`;
    }
    await expectReport({}, REPORT_BEFORE);
  } finally { await admin.close(); }
}, 30000);
