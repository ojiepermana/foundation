import { randomBytes } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SQL } from 'bun';
import { runDoctor } from '../../../scripts/doctor';
import { loadConfig } from '../../../scripts/lib/development';
import { listeners } from '../../../scripts/lib/ports';

const projectRoot = resolve(import.meta.dir, '../../..');
const name = `foundation-tooling-probe-${randomBytes(4).toString('hex')}`;
const directory = await mkdtemp(resolve(tmpdir(), 'foundation-tooling-db-'));
const [adminPassword, migratorPassword, backendPassword] = Array.from({ length: 3 }, () => randomBytes(24).toString('hex'));
const secrets: string[] = [adminPassword, migratorPassword, backendPassword];
let admin: SQL | undefined;
let backendUrl = '';
let containerStarted = false;
const originalDatabaseUrl = process.env.DATABASE_URL;

const redacted = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);

async function command(args: string[], env = process.env, timeout = 30000) {
  const child = Bun.spawn(args, { cwd: projectRoot, env, stdout: 'pipe', stderr: 'pipe', timeout });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const output = stdout + stderr;
  return { code, output: redacted(output), leaked: secrets.some((secret) => output.includes(secret)) };
}

async function docker(args: string[]) {
  const result = await command(['docker', ...args]);
  if (result.code !== 0) throw new Error(`Docker ${args[0]} failed`);
  return result.output.trim();
}

async function databaseChecks(config: Awaited<ReturnType<typeof loadConfig>>, root = projectRoot) {
  return (await runDoctor(config, [], root)).filter((check) => check.name.startsWith('Database backend'));
}

async function waitForDatabase(url: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const probe = new SQL({ url, max: 1, connectionTimeout: 1 });
    try { await probe`SELECT 1`; await probe.close(); return; }
    catch { await probe.close().catch(() => {}); await Bun.sleep(200); }
  }
  throw new Error('Isolated PostgreSQL 18 did not become ready');
}

async function serveRealApplication() {
  assert.equal((await listeners(8888)).length, 0, 'Backend port must be free for real application smoke');
  assert.equal((await listeners(8889)).length, 0, 'Frontend port must be free for real application smoke');
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/serve.ts'], {
    cwd: projectRoot, env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: backendUrl },
    stdout: 'pipe', stderr: 'pipe',
  });
  let output = '';
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => { signalReady = resolve; });
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        output += decoder.decode(part.value, { stream: true });
        if (output.includes('Layanan development siap.')) signalReady();
      }
    } finally { reader.releaseLock(); }
  };
  const drains = Promise.all([consume(child.stdout), consume(child.stderr)]);
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      child.exited.then((code) => { throw new Error(`Serve exited before readiness (${code})`); }),
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('Serve readiness exceeded 65 seconds')), 65000);
      }),
    ]);
    const backend = await fetch('http://127.0.0.1:8888/api/status');
    const frontend = await fetch('http://127.0.0.1:8889/');
    const backendBody = await backend.json();
    const frontendType = frontend.headers.get('content-type') ?? '';
    const frontendBody = await frontend.text();
    assert.equal(backend.status, 200);
    assert.deepEqual(backendBody, { status: 'ok' });
    assert.equal(frontend.status, 200);
    assert.match(frontendType, /text\/html/);
    assert.match(frontendBody, /<html(?:\s|>)/i);
    console.log(`TOOL-007 partial: GET http://127.0.0.1:8888/api/status -> ${backend.status} ${JSON.stringify(backendBody)}; GET http://127.0.0.1:8889/ -> ${frontend.status} ${frontendType}; serve reported ready`);
  } catch (error) {
    throw new Error(`${(error as Error).message}; ${redacted(output).slice(-800)}`);
  } finally {
    if (readyTimer) clearTimeout(readyTimer);
    if (child.exitCode === null) child.kill('SIGTERM');
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          shutdownTimer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Serve shutdown exceeded 10 seconds')); }, 10000);
        }),
      ]);
    } finally { if (shutdownTimer) clearTimeout(shutdownTimer); }
    await drains;
    assert.equal((await listeners(8888)).length, 0, 'Backend listener remains after shutdown');
    assert.equal((await listeners(8889)).length, 0, 'Frontend listener remains after shutdown');
    console.log('TOOL-007 partial: SIGTERM shutdown removed listeners on ports 8888 and 8889');
  }
}

try {
  const envFile = resolve(directory, 'postgres.env');
  await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
  await docker(['run', '--rm', '-d', '--name', name, '--env-file', envFile, '-p', '127.0.0.1::5432', 'foundation-postgres:18-pinned']);
  containerStarted = true;
  const mapped = await docker(['port', name, '5432/tcp']);
  const port = Number(mapped.split('\n')[0]?.split(':').at(-1));
  assert(Number.isInteger(port) && port > 0, 'Isolated PostgreSQL port unavailable');
  const adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${port}/foundation`;
  const migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${port}/foundation`;
  backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:${port}/foundation`;
  secrets.push(adminUrl, migratorUrl, backendUrl);
  await waitForDatabase(adminUrl);
  const provision = await command([process.execPath, '--no-env-file', 'database/provision.ts', '--apply'], {
    PATH: process.env.PATH ?? '', FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
    FOUNDATION_MIGRATOR_PASSWORD: migratorPassword, FOUNDATION_BACKEND_PASSWORD: backendPassword,
  });
  assert.equal(provision.code, 0, 'Isolated provisioning failed');
  assert.equal(provision.leaked, false, 'Provisioning printed a credential');
  const migration = await command([process.execPath, '--no-env-file', 'database/migrate.ts', '--apply'], {
    PATH: process.env.PATH ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
  });
  assert.equal(migration.code, 0, 'Baseline migration failed');
  assert.equal(migration.leaked, false, 'Migration printed a credential');
  admin = new SQL({ url: adminUrl, max: 1 });
  const config = await loadConfig();
  process.env.DATABASE_URL = backendUrl;
  const positive = await databaseChecks(config);
  assert(positive.length > 0 && positive.every((check) => check.status === 'ok'), 'Doctor rejected provisioned backend role');
  assert(positive.every((check) => !secrets.some((secret) => check.message.includes(secret))));
  const cli = await command([process.execPath, '--no-env-file', 'scripts/doctor.ts'], {
    ...process.env, NODE_ENV: 'development', DATABASE_URL: backendUrl,
  });
  assert.equal(cli.code, 0, 'Doctor CLI rejected provisioned database');
  assert.equal(cli.leaked, false, 'Doctor printed a credential');
  assert(cli.output.includes('[OK] Database backend: Migration:'));
  console.log(`TOOL-001: ${positive.length} database checks passed with the real provisioned role`);

  const wrongTarget = structuredClone(config);
  wrongTarget.database.expectedName = 'other_database';
  assert((await databaseChecks(wrongTarget)).some((check) => check.name.includes('Target database') && check.status === 'error'));
  await admin`GRANT INSERT ON common.schema_migrations TO foundation_backend`;
  assert((await databaseChecks(config)).some((check) => check.name.includes('Privilege metadata') && check.status === 'error'));
  await admin`REVOKE INSERT ON common.schema_migrations FROM foundation_backend`;
  await admin`CREATE ROLE metadata_writer NOLOGIN`;
  await admin`GRANT INSERT ON common.schema_migrations TO metadata_writer`;
  await admin`GRANT metadata_writer TO foundation_backend`;
  assert((await databaseChecks(config)).some((check) => check.name.includes('Privilege metadata') && check.status === 'error'));
  await admin`REVOKE metadata_writer FROM foundation_backend`;
  const [baseline] = await admin`SELECT checksum FROM common.schema_migrations WHERE name = '0001-common-metadata-comment.sql'`;
  await admin`UPDATE common.schema_migrations SET checksum = ${'a'.repeat(64)} WHERE name = '0001-common-metadata-comment.sql'`;
  assert((await databaseChecks(config)).some((check) => check.name.includes('Migration') && check.status === 'error'));
  await admin`UPDATE common.schema_migrations SET checksum = ${baseline.checksum} WHERE name = '0001-common-metadata-comment.sql'`;
  const missingMigration = '9999-migration-file-missing.sql';
  await admin`INSERT INTO common.schema_migrations (name, checksum) VALUES (${missingMigration}, ${'b'.repeat(64)})`;
  assert((await databaseChecks(config)).some((check) => check.name.includes('Migration') && check.status === 'error'));
  await admin`DELETE FROM common.schema_migrations WHERE name = ${missingMigration}`;
  const emptyRoot = resolve(directory, 'empty-repository');
  await mkdir(resolve(emptyRoot, 'database/migrations'), { recursive: true });
  assert((await databaseChecks(config, emptyRoot)).some((check) => check.name.includes('Migration') && check.status === 'error'));
  process.env.DATABASE_URL = adminUrl;
  assert((await databaseChecks(config)).some((check) => check.name.includes('Role database') && check.status === 'error'));
  process.env.DATABASE_URL = backendUrl;
  console.log('TOOL-001: wrong target, metadata write, writer membership, checksum, orphan metadata, empty migrations, and admin role rejected');

  await serveRealApplication();
  await admin.close();
  admin = undefined;
  await docker(['rm', '-f', name]);
  containerStarted = false;
  const unavailable = await databaseChecks(config);
  assert(unavailable.some((check) => check.status === 'error'), 'Doctor accepted an unavailable database');
  assert(unavailable.every((check) => !secrets.some((secret) => check.message.includes(secret))));
  console.log('TOOL-001: unavailable database rejected without credential output');
} catch (error) {
  console.error(redacted((error as Error).message));
  process.exitCode = 1;
} finally {
  if (admin) await admin.close().catch(() => {});
  if (containerStarted) await docker(['rm', '-f', name]).catch(() => {});
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await rm(directory, { recursive: true, force: true });
}
