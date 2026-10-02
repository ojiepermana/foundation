import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runDatabaseCommand } from '../../../database/runner';

const root = resolve(import.meta.dir, '../../..');
const baseline = '0001-common-metadata-comment.sql';
const token = () => randomBytes(24).toString('hex');

async function command(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn(args, { cwd: root, env: env ?? process.env, stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
}

interface Fixture {
  admin: SQL;
  migrator: SQL;
  backend: SQL;
  adminUrl: string;
  migratorUrl: string;
  backendUrl: string;
  passwords: string[];
  folder: string;
  migrations: string;
  seeds: string;
  cli: (script: 'migrate' | 'seed', url?: string, flag?: boolean) => Promise<{ code: number; output: string }>;
}

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const name = `foundation-mig-test-${randomBytes(4).toString('hex')}`;
  const folder = await mkdtemp(resolve(tmpdir(), 'foundation-migration-'));
  const adminPassword = token();
  const migratorPassword = token();
  const backendPassword = token();
  const envFile = resolve(folder, 'postgres.env');
  const fixtureRoot = resolve(folder, 'repository');
  const migrations = resolve(fixtureRoot, 'database/migrations');
  const seeds = resolve(fixtureRoot, 'database/seeds');
  let started = false;
  const pools: SQL[] = [];
  try {
    await mkdir(migrations, { recursive: true });
    await copyFile(resolve(root, 'database/migrations', baseline), resolve(migrations, baseline));
    await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
    const boot = await command(['docker', 'run', '--rm', '-d', '--name', name, '--env-file', envFile, '-p', '127.0.0.1::5432', 'foundation-postgres:18-pinned']);
    if (boot.code !== 0) throw new Error('Isolated PostgreSQL 18 did not start');
    started = true;
    const mapped = await command(['docker', 'port', name, '5432/tcp']);
    if (mapped.code !== 0) throw new Error('Isolated PostgreSQL port unavailable');
    const port = Number(mapped.output.trim().split(':').at(-1));
    const adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${port}/foundation`;
    const migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${port}/foundation`;
    const backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:${port}/foundation`;
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = new SQL({ url: adminUrl, max: 1, connectionTimeout: 1 });
      try { await probe`SELECT 1`; ready = true; } catch {} finally { await probe.close(); }
      if (ready) break;
      await Bun.sleep(200);
    }
    if (!ready) throw new Error('Isolated PostgreSQL did not become ready');
    const provision = await command([process.execPath, '--no-env-file', 'database/provision.ts', '--apply'], {
      PATH: process.env.PATH ?? '', FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
      FOUNDATION_MIGRATOR_PASSWORD: migratorPassword, FOUNDATION_BACKEND_PASSWORD: backendPassword,
    });
    if (provision.code !== 0) throw new Error('Isolated provisioning failed');
    const admin = new SQL({ url: adminUrl, max: 1 });
    const migrator = new SQL({ url: migratorUrl, max: 1 });
    const backend = new SQL({ url: backendUrl, max: 1 });
    pools.push(admin, migrator, backend);
    await run({ admin, migrator, backend, adminUrl, migratorUrl, backendUrl,
      passwords: [adminPassword, migratorPassword, backendPassword], folder: fixtureRoot, migrations, seeds,
      cli: (script, url = migratorUrl, flag = true) => command([process.execPath, '--no-env-file', `database/${script}.ts`, ...(flag ? ['--apply'] : [])], {
        PATH: process.env.PATH ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: url,
      }),
    });
  } finally {
    await Promise.all(pools.map((pool) => pool.close()));
    if (started) await command(['docker', 'rm', '-f', name]);
    await rm(folder, { recursive: true, force: true });
  }
}

test('MIG-001 baseline applies once, records bytes, and doctor accepts it', async () => withDatabase(async (fixture) => {
  const first = await fixture.cli('migrate');
  expect(first.code).toBe(0);
  expect(first.output).toContain(`Applied: ${baseline}`);
  const rows = await fixture.admin`SELECT name, checksum, applied_at FROM common.schema_migrations`;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.name).toBe(baseline);
  const expected = new Bun.CryptoHasher('sha256').update(await Bun.file(resolve(root, 'database/migrations', baseline)).arrayBuffer()).digest('hex');
  expect(rows[0]?.checksum).toBe(expected);
  expect(rows[0]?.applied_at).toBeTruthy();
  expect((await fixture.admin`SELECT pg_catalog.obj_description('common.schema_migrations'::regclass) AS description`)[0]?.description).toBe('Foundation migration history');
  const again = await fixture.cli('migrate');
  expect(again.code).toBe(0);
  expect(again.output).toContain('Migrations: 0 applied, 1 skipped');
  expect((await fixture.admin`SELECT count(*)::int AS count FROM common.schema_migrations`)[0]?.count).toBe(1);
  const doctor = await command([process.execPath, '--no-env-file', 'scripts/doctor.ts'], {
    ...process.env, NODE_ENV: 'development', DATABASE_URL: fixture.backendUrl,
  });
  expect(doctor.code).toBe(0);
  expect(doctor.output).toContain('[OK] Database backend: Migration:');
}), 50000);

test('MIG-002 rejects changed, missing, malformed, and linked SQL files before mutation', async () => withDatabase(async (fixture) => {
  await runDatabaseCommand('migration', fixture.migrator, fixture.folder);
  const baselinePath = resolve(fixture.migrations, baseline);
  const original = await Bun.file(baselinePath).text();
  await writeFile(baselinePath, `${original}\n-- changed\n`);
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Migration history drift');
  await writeFile(baselinePath, original);
  await rm(baselinePath);
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Migration baseline missing');
  await writeFile(baselinePath, original);
  await writeFile(resolve(fixture.migrations, '0003-users-gap.sql'), 'SELECT 1;');
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('SQL file sequence invalid');
  await rm(resolve(fixture.migrations, '0003-users-gap.sql'));
  await writeFile(resolve(fixture.migrations, '0002-users-multiple.sql'), 'SELECT 1; SELECT 2;');
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Invalid SQL statement');
  await rm(resolve(fixture.migrations, '0002-users-multiple.sql'));
  await symlink(baselinePath, resolve(fixture.migrations, '0002-users-linked.sql'));
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Invalid SQL file');
  await rm(resolve(fixture.migrations, '0002-users-linked.sql'));
  await writeFile(resolve(fixture.migrations, '0002-users-invalid.sql'), Uint8Array.of(0xff));
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Invalid SQL file');
  await rm(resolve(fixture.migrations, '0002-users-invalid.sql'));
  await writeFile(resolve(fixture.migrations, '0002-users-bom.sql'), '\ufeffSELECT 1;');
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('SQL file has BOM');
  await rm(resolve(fixture.migrations, '0002-users-bom.sql'));
  await writeFile(resolve(fixture.migrations, 'bad-name.sql'), 'SELECT 1;');
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Invalid SQL file name');
  await rm(resolve(fixture.migrations, 'bad-name.sql'));
  const moved = resolve(fixture.folder, 'database/migrations-real');
  await rename(fixture.migrations, moved);
  await symlink(moved, fixture.migrations);
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Invalid SQL directory');
  await rm(fixture.migrations);
  await rename(moved, fixture.migrations);
  await fixture.admin`INSERT INTO common.schema_migrations(name,checksum) VALUES ('9999-foreign.sql', ${'a'.repeat(64)})`;
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Migration history drift');
  await fixture.admin`DELETE FROM common.schema_migrations WHERE name='9999-foreign.sql'`;
  await fixture.admin`ALTER DEFAULT PRIVILEGES FOR ROLE foundation_owner IN SCHEMA common GRANT SELECT ON TABLES TO PUBLIC`;
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Database default privilege drift');
  await fixture.admin`ALTER DEFAULT PRIVILEGES FOR ROLE foundation_owner IN SCHEMA common REVOKE SELECT ON TABLES FROM PUBLIC`;
  await writeFile(resolve(fixture.migrations, '0002-users-semicolon-string.sql'), "SELECT ';'::text; -- trailing comment\n");
  await writeFile(resolve(fixture.migrations, '0003-users-dollar-block.sql'), 'DO $tag$ BEGIN PERFORM 1; END $tag$;');
  const accepted = await runDatabaseCommand('migration', fixture.migrator, fixture.folder);
  expect(accepted.applied).toHaveLength(2);
  expect((await fixture.admin`SELECT count(*)::int AS count FROM common.schema_migrations`)[0]?.count).toBe(3);
}), 30000);

test('MIG-003 rolls back a pending batch and rejects transaction controls', async () => withDatabase(async (fixture) => {
  await runDatabaseCommand('migration', fixture.migrator, fixture.folder);
  await writeFile(resolve(fixture.migrations, '0002-users-create-probe.sql'), 'CREATE TABLE users.mig_probe (id integer);');
  const failing = resolve(fixture.migrations, '0003-users-failing-query.sql');
  await writeFile(failing, 'SELECT 1 / 0;');
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Migration SQL failed');
  expect((await fixture.admin`SELECT pg_catalog.to_regclass('users.mig_probe') AS relation`)[0]?.relation).toBeNull();
  expect((await fixture.admin`SELECT count(*)::int AS count FROM common.schema_migrations`)[0]?.count).toBe(1);
  for (const statement of [
    'COMMIT;',
    'SET ROLE foundation_owner;',
    'SET LOCAL ROLE foundation_owner;',
    'RESET ROLE;',
    'SET SESSION AUTHORIZATION DEFAULT;',
    'SET LOCAL SESSION AUTHORIZATION foundation_owner;',
    'RESET SESSION AUTHORIZATION;',
    'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;',
  ]) {
    await writeFile(failing, statement);
    await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Transaction or role control is not allowed');
  }
  await writeFile(failing, 'VACUUM common.schema_migrations;');
  await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow('Migration SQL failed');
}), 30000);

test('MIG-004 serializes runners, restores role, times out on lock, and rejects wrong identity', async () => withDatabase(async (fixture) => {
  const other = new SQL({ url: fixture.migratorUrl, max: 1 });
  try {
    const [one, two] = await Promise.all([
      runDatabaseCommand('migration', fixture.migrator, fixture.folder),
      runDatabaseCommand('migration', other, fixture.folder),
    ]);
    expect([one.applied.length, two.applied.length].sort()).toEqual([0, 1]);
    expect([one.skipped.length, two.skipped.length].sort()).toEqual([0, 1]);
    expect((await fixture.migrator`SELECT current_user AS role`)[0]?.role).toBe('foundation_migrator');
    expect((await other`SELECT current_user AS role`)[0]?.role).toBe('foundation_migrator');
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = fixture.admin.begin(async (tx) => {
      await tx`SELECT pg_catalog.pg_advisory_xact_lock(638727, 5)`;
      acquired();
      await Bun.sleep(6200);
    });
    await locked;
    const started = performance.now();
    await expect(runDatabaseCommand('migration', fixture.migrator, fixture.folder)).rejects.toThrow();
    expect(performance.now() - started).toBeGreaterThan(4500);
    await holder;
    await expect(runDatabaseCommand('migration', fixture.admin, fixture.folder)).rejects.toThrow('Invalid database target or migrator');
    await expect(runDatabaseCommand('migration', fixture.backend, fixture.folder)).rejects.toThrow('Invalid database target or migrator');
    const wrong = await fixture.cli('migrate', fixture.adminUrl);
    expect(wrong.code).toBe(1);
    for (const secret of fixture.passwords) expect(wrong.output).not.toContain(secret);
  } finally { await other.close(); }
}), 35000);

test('MIG-005 requires current migrations, repeats an idempotent seed, and rolls back a batch', async () => withDatabase(async (fixture) => {
  await runDatabaseCommand('migration', fixture.migrator, fixture.folder);
  const empty = await fixture.cli('seed');
  expect(empty.code).toBe(0);
  expect(empty.output).toContain('Seeds: 0 executed');
  await writeFile(resolve(fixture.migrations, '0002-users-pending.sql'), 'SELECT 1;');
  await expect(runDatabaseCommand('seed', fixture.migrator, fixture.folder)).rejects.toThrow('Migrations pending');
  await rm(resolve(fixture.migrations, '0002-users-pending.sql'));
  await fixture.admin`CREATE TABLE users.seed_probe (id integer PRIMARY KEY)`;
  await fixture.admin.unsafe('ALTER TABLE users.seed_probe OWNER TO foundation_owner');
  await mkdir(fixture.seeds);
  await writeFile(resolve(fixture.seeds, '0001-users-idempotent.sql'), 'INSERT INTO users.seed_probe(id) VALUES (1) ON CONFLICT DO NOTHING;');
  const first = await runDatabaseCommand('seed', fixture.migrator, fixture.folder);
  const second = await runDatabaseCommand('seed', fixture.migrator, fixture.folder);
  expect(first.applied).toHaveLength(1);
  expect(second.applied).toHaveLength(1);
  expect((await fixture.admin`SELECT count(*)::int AS count FROM users.seed_probe`)[0]?.count).toBe(1);
  await fixture.admin`DELETE FROM users.seed_probe`;
  await writeFile(resolve(fixture.seeds, '0002-users-failing.sql'), 'SELECT 1 / 0;');
  await expect(runDatabaseCommand('seed', fixture.migrator, fixture.folder)).rejects.toThrow('Seed SQL failed');
  expect((await fixture.admin`SELECT count(*)::int AS count FROM users.seed_probe`)[0]?.count).toBe(0);
  expect((await fixture.admin`SELECT count(*)::int AS count FROM common.schema_migrations`)[0]?.count).toBe(1);
}), 30000);
