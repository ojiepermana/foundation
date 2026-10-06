import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHmac, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../../apps/backend/src/app';
import { runDatabaseCommand } from '../../../database/runner';
import { createDatabasePool } from '../../../libs/server/database/client';
import { onSignalCleanup, type SignalCleanupCallback } from '../../orchestration/signal-cleanup';

// BKP-003 to BKP-007 of spec 0013 (backup dan pemulihan data): backups through the Compose service `backup` of
// deploy/backup.yaml on an isolated PostgreSQL 18 source, and restores through the service `restore` into a new,
// isolated PostgreSQL 18 target, in the order of *Urutan uji target*: the backups and the secret scan, the target before
// provisioning, the failed restore on the provisioned empty target, the restore proven by provisioning, the migration
// runner, the fingerprint, and readiness, then every guard on the restored target, the failures of restore and backup
// with broken credentials and folders, and last retention and `check` in folders of their own with backups whose age
// comes from names computed from the current time. Both clusters run in containers of this run, each only on its own plain
// bridge network with the alias `postgres` and a random loopback port for the Bun processes on the host. Every network,
// container, Compose run, and the temporary folder is registered on tests/orchestration/signal-cleanup.ts right before
// it is created, removed by explicit name, and released only after its normal removal (spec 0013, *Resource uji* and
// *Perubahan GATE-009*). `afterAll` writes .local/feature-14/restore.json (*Isi restore.json*) even when a test fails.

const root = resolve(import.meta.dir, '../../..');
const image = 'foundation-postgres:18-pinned';
const hex = randomBytes(4).toString('hex');
const testSeed = Bun.env.FOUNDATION_TEST_SECRET_SEED;
/** Passwords from the labels of *Label secret*, so test:database:real can scan for them; random when run alone. */
const token = (label: string) => (testSeed ? createHmac('sha256', testSeed).update(label).digest('hex') : randomBytes(24).toString('hex'));
const source = {
  admin: token('admin'), migrator: token('migrator'), backend: token('backend'), backup: token('backup'),
};
const target = {
  admin: token('restore-admin'), migrator: token('restore-migrator'), backend: token('restore-backend'), backup: token('restore-backup'),
};
/** Data sentinel of the fixture seed, random per run: the positive control of the dump scan. */
const sentinel = `restore-sentinel-${randomBytes(8).toString('hex')}`;
/** Sentinel of `ALTER DATABASE foundation SET foundation.backup_probe`, which the dump must never hold. */
const settingSentinel = `backup-probe-${randomBytes(8).toString('hex')}`;
/** Sentinel passwords of BKP-006: wrong passwords and the two broken connection strings libpq echoes, random per run. */
const broken = {
  backupWrong: randomBytes(12).toString('hex'), backupSpace: randomBytes(12).toString('hex'), backupPercent: randomBytes(12).toString('hex'),
  restoreWrong: randomBytes(12).toString('hex'), restoreSpace: randomBytes(12).toString('hex'), restorePercent: randomBytes(12).toString('hex'),
};
/**
 * A password with every character a URI userinfo reserves, a space, and a multi byte character, random per run: the DSN
 * carries it percent encoded, and the script must decode it exactly as libpq does (spec 0013, *Perintah pg_dump*).
 */
const reserved = `${randomBytes(6).toString('hex')} @:/?#[]%&=+$,;ü${randomBytes(6).toString('hex')}`;
/** DSNs the containers of this run receive, all reached through the alias `postgres` of the network they join. */
const dsn = {
  sourceBackup: `postgres://foundation_backup:${source.backup}@postgres:5432/foundation`,
  sourceBackend: `postgres://foundation_backend:${source.backend}@postgres:5432/foundation`,
  sourceAdmin: `postgres://foundation_admin:${source.admin}@postgres:5432/foundation`,
  sourceMigrator: `postgres://foundation_migrator:${source.migrator}@postgres:5432/foundation`,
  sourcePostgres: `postgres://foundation_backup:${source.backup}@postgres:5432/postgres`,
  backupReserved: `postgres://foundation_backup:${encodeURIComponent(reserved)}@postgres:5432/foundation`,
  backupWrong: `postgres://foundation_backup:${broken.backupWrong}@postgres:5432/foundation`,
  backupSpace: `postgres://foundation_backup:${broken.backupSpace} x@postgres:5432/foundation`,
  backupPercent: `postgres://foundation_backup:${broken.backupPercent}%zz@postgres:5432/foundation`,
  targetAdmin: `postgres://foundation_admin:${target.admin}@postgres:5432/foundation`,
  targetPostgres: `postgres://foundation_admin:${target.admin}@postgres:5432/postgres`,
  targetBackend: `postgres://foundation_backend:${target.backend}@postgres:5432/foundation`,
  restoreWrong: `postgres://foundation_admin:${broken.restoreWrong}@postgres:5432/foundation`,
  restoreSpace: `postgres://foundation_admin:${broken.restoreSpace} x@postgres:5432/foundation`,
  restorePercent: `postgres://foundation_admin:${broken.restorePercent}%zz@postgres:5432/foundation`,
};

const sourceName = `foundation-backup-src-${hex}`;
const targetName = `foundation-backup-dst-${hex}`;
const project = `foundation-backup-test-${hex}`;
const RESOURCE_NAME = /^foundation-backup-(src|dst|run|tool)-[0-9a-f]{8}(-[0-9]+)?$/;
const BACKUP_NAME = /^foundation-[0-9]{8}T[0-9]{6}Z-(scheduled|pre-migration|manual)$/;
const MANIFEST_KEYS = ['schema', 'name', 'dump', 'createdAt', 'reason', 'database', 'format', 'compression', 'globals', 'serverVersion', 'pgDumpVersion', 'sizeBytes', 'sha256', 'tocEntries', 'durationMs'];
const GUARDS = ['invalid_name', 'incomplete_backup', 'checksum_mismatch', 'checksum_wrong_file', 'archive_invalid', 'missing_admin_url', 'invalid_target', 'target_not_provisioned', 'target_not_empty', 'major_mismatch', 'restore_failed', 'history_drift'] as const;
type Guard = typeof GUARDS[number];
const BOUNDARY = 'Backup dan restore pada dua cluster PostgreSQL 18 terisolasi milik run dengan data fixture; bukan bukti RTO environment, ukuran data nyata, jadwal backup, salinan di luar host, atau enkripsi penyimpanan.';
const RESTORE_LIMIT_MS = 300_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Step 9 of *Urutan restore*: the target holds no migration row, no relation but the metadata table, no extra schema. */
const TARGET_EMPTY = `SELECT (SELECT count(*) FROM common.schema_migrations) = 0
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_%' AND NOT (n.nspname = 'common' AND c.relname = 'schema_migrations'))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
    WHERE n.nspname NOT IN ('public', 'common', 'users', 'auth', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%') AS empty`;

const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI'];
const pick = (keys: string[]) => Object.fromEntries(keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
const dockerEnv = pick([...BASE_ENV_KEYS, 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']);
const uid = process.getuid?.() ?? 26;
const gid = process.getgid?.() ?? 26;

/** `leaked` counts the secret values found in the output of a Compose run (0 for other commands); never the values. */
type Result = { code: number; stdout: string; stderr: string; timedOut: boolean; leaked: number };
type Cluster = { name: string; network: string; port: number; adminUrl: string; migratorUrl: string; backendUrl: string; backupUrl: string };
type Status = 'passed' | 'failed' | 'not_run';

let folder = '';
let backupDir = '';
let fixtureRoot = '';
let composeEnv = '';
let runs = 0;
let copies = 0;
let sourceCluster: Cluster | undefined;
let targetCluster: Cluster | undefined;
/** Release functions of the networks and containers still registered, by resource name. */
const registered = new Map<string, () => void>();
let releaseFolder = () => {};

// Evidence of *Isi restore.json*, filled as the tests go.
const checks: Record<'backup' | 'restore' | 'fingerprint' | 'retention' | 'secretScan', Status> = {
  backup: 'not_run', restore: 'not_run', fingerprint: 'not_run', retention: 'not_run', secretScan: 'not_run',
};
const guards = new Map<Guard, Status>(GUARDS.map((name) => [name, 'not_run']));
let serverVersion: string | null = null;
let backupEvidence: Record<string, unknown> | null = null;
let restoreEvidence: Record<string, unknown> | null = null;
let fingerprintEvidence: Record<string, unknown> | null = null;
let retentionEvidence: { kept: string[]; removed: string[]; leftovers: string[]; untouched: string[] } | null = null;
let mainBackup = '';
let secondBackup = '';
let sourceFingerprint = '';
/** Sources scanned for secret values and the names of those that held one (*Isi restore.json*, field `secretScan`). */
const scanned = { files: 0, findings: new Set<string>() };

/** Every secret value of this run: passwords, DSNs, and sentinels. Never printed; only their count is reported. */
function secretValues(): string[] {
  const values = [...Object.values(source), ...Object.values(target), ...Object.values(broken), reserved, settingSentinel, ...Object.values(dsn)];
  for (const cluster of [sourceCluster, targetCluster]) {
    if (cluster) values.push(cluster.adminUrl, cluster.migratorUrl, cluster.backendUrl, cluster.backupUrl);
  }
  return [...new Set(values)];
}

/** Scans `text` of the source `name` for every secret value; returns how many it holds and records a finding by name. */
function scan(name: string, text: string): number {
  scanned.files += 1;
  const found = secretValues().filter((value) => text.includes(value)).length;
  if (found > 0) scanned.findings.add(name);
  return found;
}

async function command(args: string[], env: Record<string, string>, timeout = 60_000): Promise<Result> {
  const child = Bun.spawn(args, { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr, timedOut: child.signalCode !== null, leaked: 0 };
}

/** Synchronous `docker <args>` of the signal cleanup with `dockerEnv`; output captured, never printed. */
function dockerSync(args: string[], timeout: number): { code: number; stderr: string } | undefined {
  if (timeout <= 0) return undefined;
  try {
    const result = Bun.spawnSync(['docker', ...args], { cwd: root, env: dockerEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout });
    return result.exitedDueToTimeout ? undefined : { code: result.exitCode, stderr: result.stderr.toString() };
  } catch {
    return undefined;
  }
}

/** A container of this run (cluster, Compose run, or tool): `docker rm -f <name>` on every pass. */
function containerCleanup(name: string): SignalCleanupCallback {
  return ({ timeout }) => {
    if (!RESOURCE_NAME.test(name)) return [name];
    return dockerSync(['rm', '-f', name], timeout(30_000))?.code === 0 ? [] : [name];
  };
}

/** A network of this run: `docker network rm <name>` on every pass; Docker's `not found` counts as removed. */
function networkCleanup(name: string): SignalCleanupCallback {
  return ({ timeout }) => {
    if (!RESOURCE_NAME.test(name)) return [name];
    const result = dockerSync(['network', 'rm', name], timeout(30_000));
    return result !== undefined && (result.code === 0 || result.stderr.includes('not found')) ? [] : [name];
  };
}

/** The temporary folder with the env files, the fixture root, and the backup folders: removed on pass 2. */
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

function take(key: string): () => void {
  const release = registered.get(key) ?? (() => {});
  registered.delete(key);
  return release;
}

async function createNetwork(name: string): Promise<void> {
  registered.set(`${name}#network`, onSignalCleanup(networkCleanup(name)));
  const created = await command(['docker', 'network', 'create', name], dockerEnv);
  if (created.code !== 0) throw new Error(`Network ${name} could not be created`);
}

/**
 * The normal path: every network and cluster container still registered, in reverse order of registration, each by
 * its explicit name. A resource Docker did not remove stays registered, so a later signal still removes it.
 */
async function removeResources(): Promise<void> {
  const failed: string[] = [];
  for (const key of [...registered.keys()].reverse()) {
    const [name = '', kind] = key.split('#');
    const removed = kind === 'network'
      ? await command(['docker', 'network', 'rm', name], dockerEnv)
      : await command(['docker', 'rm', '-f', name], dockerEnv);
    if (removed.code !== 0 && !(kind === 'network' && removed.stderr.includes('not found'))) {
      failed.push(name);
      continue;
    }
    const releaseResource = take(key);
    releaseResource();
  }
  if (failed.length > 0) throw new Error(`Docker did not remove ${failed.join(', ')}`);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await Bun.sleep(intervalMs)) {
    if (await check()) return true;
  }
  return false;
}

async function reachable(url: string): Promise<boolean> {
  const probe = new SQL({ url, max: 1, connectionTimeout: 1 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

/** A PostgreSQL 18 cluster of this run on its own network `name`, with the alias `postgres` and a loopback port. */
async function startCluster(name: string, passwords: typeof source): Promise<Cluster> {
  await createNetwork(name);
  const envFile = join(folder, `${name}.env`);
  await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${passwords.admin}\n`, { mode: 0o600 });
  registered.set(`${name}#container`, onSignalCleanup(containerCleanup(name)));
  const started = await command(['docker', 'run', '-d', '--name', name, '--network', name, '--network-alias', 'postgres', '--env-file', envFile, '-p', '127.0.0.1::5432', image], dockerEnv);
  if (started.code !== 0) throw new Error(`PostgreSQL 18 ${name} did not start`);
  const mapped = await command(['docker', 'port', name, '5432/tcp'], dockerEnv);
  const port = Number(mapped.stdout.trim().split('\n')[0]?.split(':').at(-1));
  if (mapped.code !== 0 || !Number.isInteger(port) || port <= 0) throw new Error(`PostgreSQL 18 ${name} has no loopback port`);
  const url = (role: string, password: string) => `postgres://${role}:${password}@127.0.0.1:${port}/foundation`;
  const cluster: Cluster = {
    name, network: name, port,
    adminUrl: url('foundation_admin', passwords.admin), migratorUrl: url('foundation_migrator', passwords.migrator),
    backendUrl: url('foundation_backend', passwords.backend), backupUrl: url('foundation_backup', passwords.backup),
  };
  if (!await waitFor(() => reachable(cluster.adminUrl), 30_000, 200)) throw new Error(`PostgreSQL 18 ${name} did not become ready`);
  return cluster;
}

/** database/provision.ts --apply on `cluster` with the role passwords of `passwords`, including the backup role. */
async function provision(cluster: Cluster, passwords: typeof source): Promise<Result> {
  return command([process.execPath, '--no-env-file', 'database/provision.ts', '--apply'], {
    PATH: process.env['PATH'] ?? '', FOUNDATION_ADMIN_DATABASE_URL: cluster.adminUrl,
    FOUNDATION_MIGRATOR_PASSWORD: passwords.migrator, FOUNDATION_BACKEND_PASSWORD: passwords.backend, FOUNDATION_BACKUP_PASSWORD: passwords.backup,
  });
}

/** database/fingerprint.ts with the backup role of `cluster`; the one JSON line on stdout. */
async function fingerprint(cluster: Cluster, digest: boolean): Promise<Result> {
  return command([process.execPath, '--no-env-file', 'database/fingerprint.ts', ...(digest ? ['--digest'] : [])], {
    PATH: process.env['PATH'] ?? '', FOUNDATION_BACKUP_DATABASE_URL: cluster.backupUrl,
  });
}

/**
 * database/fingerprint.ts with `args` and FOUNDATION_BACKUP_DATABASE_URL `url` (left unset for `undefined`), for the
 * argument, identity, and connection cases of *Fingerprint*. Both outputs are scanned for every secret value of the run.
 */
async function fingerprintRun(args: string[], url: string | undefined): Promise<Result> {
  const result = await command([process.execPath, '--no-env-file', 'database/fingerprint.ts', ...args], {
    PATH: process.env['PATH'] ?? '', ...(url === undefined ? {} : { FOUNDATION_BACKUP_DATABASE_URL: url }),
  });
  result.leaked = scan('fingerprint stdout', result.stdout) + scan('fingerprint stderr', result.stderr);
  return result;
}

type FingerprintOutput = {
  schema: number;
  tables: Array<{ schema: string; name: string; rows: string; digest?: string }>;
  sequences: Array<{ schema: string; name: string; lastValue: string; isCalled: boolean }>;
  migrations: { count: number; last: string | null };
};

/** Order of *Fingerprint*: schema, then name, both byte wise (COLLATE "C"). */
const catalogOrder = (a: { schema: string; name: string }, b: { schema: string; name: string }) =>
  a.schema === b.schema ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : (a.schema < b.schema ? -1 : 1);

async function withPool<T>(url: string, run: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = createDatabasePool(url, { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.close();
  }
}

/** The explicit container name of Compose run number `n` of this run (`runs` counts runs and tool containers). */
const runName = (n: number) => `foundation-backup-run-${hex}-${n}`;

/**
 * One `docker compose run --rm` of deploy/backup.yaml in the foreground, as project `foundation-backup-test-<hex>` with
 * the env file of this run. `env` overrides the shell values Compose reads (FOUNDATION_RESTORE_DATA_NETWORK of the
 * target, FOUNDATION_BACKUP_DIR or FOUNDATION_BACKUP_DATABASE_URL of a BKP-006 case, and FOUNDATION_ADMIN_DATABASE_URL
 * only for the restore). `passAdmin` adds `-e FOUNDATION_ADMIN_DATABASE_URL`, also while the variable is unset. Both
 * outputs are scanned for every secret value of the run. The container is named `runName(runs)` before the first await,
 * so a caller that does not await at once can address it while it runs.
 */
async function composeRun(profile: 'backup' | 'restore', args: string[], env: Record<string, string> = {}, passAdmin = env['FOUNDATION_ADMIN_DATABASE_URL'] !== undefined): Promise<Result> {
  runs += 1;
  const name = runName(runs);
  const admin = passAdmin ? ['-e', 'FOUNDATION_ADMIN_DATABASE_URL'] : [];
  const releaseRun = onSignalCleanup(containerCleanup(name));
  // `--progress quiet` keeps the Creating and Created lines of Compose off stderr, so stderr holds only the script's line.
  const result = await command(['docker', 'compose', '--progress', 'quiet', '-p', project, '--env-file', composeEnv, '-f', 'deploy/backup.yaml', '--profile', profile, 'run', '--rm', '-T', '--name', name, ...admin, profile, ...args], { ...dockerEnv, ...env }, 180_000);
  // `run --rm` in the foreground removed the container once it returned; a client stopped by the time limit may not have.
  if (result.timedOut) await command(['docker', 'rm', '-f', name], dockerEnv);
  releaseRun();
  result.leaked = scan(`${profile} stdout`, result.stdout) + scan(`${profile} stderr`, result.stderr);
  return result;
}

/** A tool container of the PostgreSQL image without network, with the backup folder read only, in the foreground. */
async function tool(entrypoint: 'pg_restore' | 'sha256sum' | 'date', args: string[], workdir = '/'): Promise<Result> {
  runs += 1;
  const name = `foundation-backup-tool-${hex}-${runs}`;
  const releaseTool = onSignalCleanup(containerCleanup(name));
  const result = await command(['docker', 'run', '--rm', '--name', name, '--network', 'none', '--user', `${uid}:${gid}`, '-v', `${backupDir}:/backup:ro`, '-w', workdir, '--entrypoint', entrypoint, image, ...args], dockerEnv);
  if (result.timedOut) await command(['docker', 'rm', '-f', name], dockerEnv);
  releaseTool();
  return result;
}

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

/**
 * Milliseconds since the epoch, whole seconds, on the clock of the container engine: the clock `date -u` reads when a
 * run names its backup. On Docker Desktop the virtual machine clock can drift from the host clock, so a window of names
 * is computed from this clock, never from the host (*Value sourcing*, Nama dan `createdAt`).
 */
async function containerNow(): Promise<number> {
  const printed = await tool('date', ['-u', '+%s']);
  const seconds = Number(printed.stdout.trim());
  if (printed.code !== 0 || !Number.isInteger(seconds)) throw new Error('The container clock could not be read');
  return seconds * 1_000;
}

/** The command lines of the processes in container `name` (`docker top`), or [] while it does not run. */
async function processArguments(name: string): Promise<string[]> {
  const listed = await command(['docker', 'top', name, '-o', 'pid,args'], dockerEnv);
  return listed.code === 0 ? lines(listed.stdout).slice(1).map((line) => line.trim().replace(/^[0-9]+\s+/, '')) : [];
}

/**
 * Waits until a process of container `name` runs `program` (a command line holds `<program> ` and `--dbname=`), and
 * returns every command line of the container at that moment, or [] when none did within 30 seconds.
 */
async function waitForTool(name: string, program: 'pg_dump' | 'psql'): Promise<string[]> {
  let seen: string[] = [];
  const found = await waitFor(async () => {
    seen = await processArguments(name);
    return seen.some((line) => line.includes(`${program} `) && line.includes('--dbname='));
  }, 30_000, 200);
  return found ? seen : [];
}

/**
 * ACCESS EXCLUSIVE on `table` through a pool of `url`, held until `unlock` runs, so a backup, restore, or fingerprint
 * of this run waits on it. Named unlock: GATE-009 reads any function named release as the release of a signal cleanup
 * registration.
 */
async function lockTable(url: string, table: string): Promise<() => Promise<void>> {
  const admin = new SQL({ url, max: 1 });
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let locked = () => {};
  const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
  const holding = admin.begin(async (tx) => {
    await tx.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    locked();
    await opened;
  });
  const unlock = async () => {
    open();
    await holding.catch(() => undefined);
    await admin.close();
  };
  try {
    await Promise.race([lockHeld, holding]);
  } catch (error) {
    await unlock();
    throw error;
  }
  return unlock;
}

/** A run the script rejected: no secret in its output, exactly `message` on stderr, nothing on stdout, and exit 1. */
function expectRejected(result: Result, message: string): void {
  expect(result.leaked).toBe(0);
  expect(lines(result.stdout)).toEqual([]);
  expect(lines(result.stderr)).toEqual([message]);
  expect(result.code).toBe(1);
}

/**
 * A restore into the target of this run, with `admin` as FOUNDATION_ADMIN_DATABASE_URL, or unset for `null`. The target
 * network comes only from FOUNDATION_RESTORE_DATA_NETWORK in the shell, never from the env file, which names the source.
 */
async function restoreRun(args: string[], admin: string | null = dsn.targetAdmin): Promise<Result> {
  return composeRun('restore', args, { FOUNDATION_RESTORE_DATA_NETWORK: targetCluster!.network, ...(admin === null ? {} : { FOUNDATION_ADMIN_DATABASE_URL: admin }) }, true);
}

/** The restored target still gives the source fingerprint (*Urutan uji target*, rows 5 and 6). */
async function expectTargetUnchanged(): Promise<void> {
  const printed = await fingerprint(targetCluster!, true);
  expect(printed.stderr).toBe('');
  expect(printed.code).toBe(0);
  expect(printed.stdout.trim()).toBe(sourceFingerprint);
}

/**
 * Admin view of a cluster that is not provisioned (*Urutan uji target*, row 2): role names other than pg_*, the schema
 * list, the relation count per relkind outside the system schemas, and the database list.
 */
async function adminCatalog(cluster: Cluster): Promise<string> {
  return withPool(cluster.adminUrl, async (sql) => {
    const [row] = await sql`SELECT pg_catalog.json_build_object(
      'roles', (SELECT pg_catalog.json_agg(rolname ORDER BY rolname) FROM pg_catalog.pg_roles WHERE rolname NOT LIKE 'pg\\_%'),
      'schemas', (SELECT pg_catalog.json_agg(nspname ORDER BY nspname) FROM pg_catalog.pg_namespace),
      'relations', (SELECT coalesce(pg_catalog.json_object_agg(kind, total ORDER BY kind), '{}') FROM (
        SELECT c.relkind::text AS kind, count(*) AS total FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' GROUP BY c.relkind) kinds),
      'databases', (SELECT pg_catalog.json_agg(datname ORDER BY datname) FROM pg_catalog.pg_database)
    )::text AS state`;
    return String((row as { state: string }).state);
  });
}

/** Name, type, size, mode, and mtime of every entry of `path` (or of `path` itself when it is a file), sorted by name. */
async function folderState(path: string): Promise<string> {
  const describe = async (name: string, full: string) => {
    const info = await lstat(full);
    return [name, info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : 'file', info.size, info.mode & 0o7777, Math.floor(info.mtimeMs)];
  };
  if (!(await lstat(path)).isDirectory()) return JSON.stringify([await describe('.', path)]);
  const names = (await readdir(path)).sort();
  return JSON.stringify(await Promise.all(names.map((name) => describe(name, join(path, name)))));
}

/** Type, size, mode, and mtime of every entry right in `path` by name, in name order; lstat, so a link is not followed. */
async function entries(path: string): Promise<Array<[string, string]>> {
  const names = (await readdir(path)).sort();
  return Promise.all(names.map(async (name): Promise<[string, string]> => {
    const info = await lstat(join(path, name));
    return [name, JSON.stringify([info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : 'file', info.size, info.mode & 0o7777, Math.floor(info.mtimeMs)])];
  }));
}

/** `YYYYMMDDTHHMMSSZ` of `date` in UTC, the stamp of *Nama dan isi backup*. */
const stampOf = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z');
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/** A backup name whose stamp is `ms` before `now` (after it when negative), the age *Umur dari nama* reads. */
const agedName = (now: number, ms: number, reason: 'scheduled' | 'pre-migration' | 'manual' = 'scheduled') => `foundation-${stampOf(new Date(now - ms))}-${reason}`;

/**
 * Fixture files of the backup `name` in `dir`, each 0600: fixture bytes as the dump, the sha256sum line naming that
 * dump, and a one line manifest; `parts` leaves files out for an incomplete set. Retention and `check` never read a dump
 * as an archive, so the bytes need not be one.
 */
async function writeSet(dir: string, name: string, parts: Array<'dump' | 'checksum' | 'manifest'> = ['dump', 'checksum', 'manifest']): Promise<void> {
  const bytes = Buffer.from(`fixture ${name}\n`);
  if (parts.includes('dump')) await writeFile(join(dir, `${name}.dump`), bytes, { mode: 0o600 });
  if (parts.includes('checksum')) await writeFile(join(dir, `${name}.dump.sha256`), `${sha256(bytes)}  ${name}.dump\n`, { mode: 0o600 });
  if (parts.includes('manifest')) await writeFile(join(dir, `${name}.json`), `${JSON.stringify({ schema: 1, name, dump: `${name}.dump` })}\n`, { mode: 0o600 });
}

/** A folder of its own under the run folder for BKP-007, with `mode` (0700 unless a case needs another). */
async function caseFolder(label: string, mode = 0o700): Promise<string> {
  const path = join(folder, label);
  await mkdir(path);
  await chmod(path, mode);
  return path;
}

/** Names of the complete backups among `listing` (three regular files), newest first, the order of *Retensi*. */
function completeBackups(listing: Array<[string, string]>): string[] {
  const files = new Set(listing.filter(([, info]) => JSON.parse(info)[0] === 'file').map(([name]) => name));
  return [...files].filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length))
    .filter((name) => BACKUP_NAME.test(name) && files.has(`${name}.dump`) && files.has(`${name}.dump.sha256`))
    .sort().reverse();
}

/**
 * A copy of the main backup under a new valid name in the main folder, so the main backup never changes (*Urutan uji
 * target*, guard cases). `dump` replaces the bytes, `checksum` the line of the checksum file, and `manifest` is copied,
 * left out, or made a relative symlink to the main manifest. Returns the new name.
 */
async function copyBackup(options: { dump?: Uint8Array; checksum?: string; manifest?: 'copy' | 'missing' | 'symlink' } = {}): Promise<string> {
  copies += 1;
  const name = `foundation-20200101T0000${String(copies).padStart(2, '0')}Z-manual`;
  const bytes = options.dump ?? await readFile(join(backupDir, `${mainBackup}.dump`));
  await writeFile(join(backupDir, `${name}.dump`), bytes, { mode: 0o600 });
  await writeFile(join(backupDir, `${name}.dump.sha256`), options.checksum ?? `${sha256(bytes)}  ${name}.dump\n`, { mode: 0o600 });
  const manifest = options.manifest ?? 'copy';
  if (manifest === 'copy') {
    const text = (await readFile(join(backupDir, `${mainBackup}.json`), 'utf8')).replaceAll(mainBackup, name);
    await writeFile(join(backupDir, `${name}.json`), text, { mode: 0o600 });
  } else if (manifest === 'symlink') {
    await symlink(`${mainBackup}.json`, join(backupDir, `${name}.json`));
  }
  return name;
}

async function removeCopies(names: string[]): Promise<void> {
  for (const name of names) {
    for (const file of [`${name}.dump`, `${name}.dump.sha256`, `${name}.json`]) await rm(join(backupDir, file), { force: true });
  }
}

/** Copy of database/migrations/ plus the restore fixture migration, and one seed with the sentinel row. */
async function writeFixtureRoot(): Promise<void> {
  const migrations = join(fixtureRoot, 'database/migrations');
  const seeds = join(fixtureRoot, 'database/seeds');
  await mkdir(migrations, { recursive: true });
  await mkdir(seeds, { recursive: true });
  const names = (await readdir(join(root, 'database/migrations'))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of names) await copyFile(join(root, 'database/migrations', name), join(migrations, name));
  const next = String(names.length + 1).padStart(4, '0');
  await writeFile(join(migrations, `${next}-users-restore-fixture.sql`), `CREATE TABLE users.restore_fixture (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label text NOT NULL,
  payload bytea,
  note text,
  recorded_at timestamptz NOT NULL,
  amount numeric(20, 6) NOT NULL,
  details jsonb NOT NULL,
  active boolean NOT NULL
);
`);
  await writeFile(join(seeds, '0001-users-restore-fixture.sql'), `INSERT INTO users.restore_fixture (label, payload, note, recorded_at, amount, details, active) VALUES
  ('${sentinel}', '\\x00ff10'::bytea, NULL, '2026-10-06 02:00:00.123456+00', 12345678901234.123456, '{"nested": [1, 2, {"teks": "ünïcødé"}]}', true),
  (E'Unicode ünïcødé ✓ dengan\\ttab dan\\nbaris baru', NULL, 'catatan', '1999-12-31 23:59:59+07', -0.5, '{}', false),
  ('baris tanpa bytea', '\\x'::bytea, NULL, '2026-01-01 00:00:00+00', 0, '[]', true);
`);
}

async function writeRestoreEvidence(): Promise<void> {
  // Names of the fixed set in its order; a check that did not run is not a failure, but it keeps the status failed.
  const statuses = (): Array<[string, Status]> => [
    ['backup', checks.backup], ['restore', checks.restore], ['fingerprint', checks.fingerprint],
    ...GUARDS.map((name): [string, Status] => [name, guards.get(name) ?? 'not_run']),
    ['retention', checks.retention], ['secretScan', checks.secretScan],
  ];
  const evidence = () => {
    const current = statuses();
    return {
      schema: 1,
      status: current.every(([, status]) => status === 'passed') ? 'passed' : 'failed',
      failures: current.filter(([, status]) => status === 'failed').map(([name]) => name),
      recordedAt: new Date().toISOString(),
      serverVersion,
      backup: backupEvidence,
      restore: restoreEvidence,
      fingerprint: fingerprintEvidence,
      guards: GUARDS.map((name) => ({ name, status: guards.get(name) })),
      retention: retentionEvidence,
      secretScan: { filesScanned: scanned.files, valuesChecked: secretValues().length, findings: [...scanned.findings] },
      boundary: BOUNDARY,
    };
  };
  // The file itself is a scanned source too: scan what would be written, then write it with that scan counted. Only
  // counts and source names change between the two, never a value.
  if (scan('restore.json', JSON.stringify(evidence(), null, 2)) > 0 || scanned.findings.size > 0) checks.secretScan = 'failed';
  await mkdir(join(root, '.local/feature-14'), { recursive: true });
  await writeFile(join(root, '.local/feature-14/restore.json'), `${JSON.stringify(evidence(), null, 2)}\n`);
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'foundation-backup-test-'));
  releaseFolder = onSignalCleanup(folderCleanup(folder));
  // Compose reads a relative bind path as a volume name, so every path it gets is the absolute, resolved path.
  folder = await realpath(folder);
  backupDir = join(folder, 'backups');
  fixtureRoot = join(folder, 'repository');
  composeEnv = join(folder, 'compose.env');
  await mkdir(backupDir);
  await chmod(backupDir, 0o700);
  await writeFixtureRoot();
  sourceCluster = await startCluster(sourceName, source);
  const provisioned = await provision(sourceCluster, source);
  if (provisioned.code !== 0) throw new Error('Source provisioning failed');
  await writeFile(composeEnv, [
    `FOUNDATION_BACKUP_DATABASE_URL=${dsn.sourceBackup}`,
    `FOUNDATION_BACKUP_DIR=${backupDir}`,
    `FOUNDATION_DATA_NETWORK=${sourceCluster.network}`,
    `FOUNDATION_BACKUP_UID=${uid}`,
    `FOUNDATION_BACKUP_GID=${gid}`,
    `FOUNDATION_POSTGRES_IMAGE=${image}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await withPool(sourceCluster.migratorUrl, async (sql) => {
    await runDatabaseCommand('migration', sql, fixtureRoot);
    await runDatabaseCommand('seed', sql, fixtureRoot);
  });
  await withPool(sourceCluster.adminUrl, async (sql) => {
    const [row] = await sql`SELECT current_setting('server_version') AS version`;
    serverVersion = String((row as { version: string }).version);
  });
}, 180_000);

afterAll(async () => {
  try {
    await writeRestoreEvidence();
  } finally {
    try {
      await removeResources();
    } finally {
      if (folder) await rm(folder, { recursive: true, force: true });
      releaseFolder();
    }
  }
}, 120_000);

// Row 1 of *Urutan uji target*.
test('BKP-003 create manual through the Compose service backup leaves exactly three 0600 files with a valid checksum, a one line manifest, the source tables in the archive, and no secret in the dump', async () => {
  checks.backup = 'failed';
  // A database level setting that a backup must never carry (AC-4): pg_dump without --create leaves it out.
  await withPool(sourceCluster!.adminUrl, (sql) => sql.unsafe(`ALTER DATABASE foundation SET foundation.backup_probe = '${settingSentinel}'`));
  const before = await readdir(backupDir);
  expect(before).toEqual([]);
  const created = await composeRun('backup', ['create', 'manual']);
  expect(created.leaked).toBe(0);
  expect(lines(created.stderr)).toEqual([]);
  expect(created.code).toBe(0);
  const output = lines(created.stdout);
  expect(output).toHaveLength(1);
  const match = /^Backup created: (foundation-[0-9]{8}T[0-9]{6}Z-manual)\.dump \(([0-9]+) bytes, sha256 ([0-9a-f]{64})\)$/.exec(output[0] ?? '');
  expect(match).not.toBeNull();
  const [, name, size, hash] = match!;
  expect(name).toMatch(BACKUP_NAME);
  mainBackup = name!;

  // Exactly the three files of *Nama dan isi backup*, each 0600.
  const files = (await readdir(backupDir)).sort();
  expect(files).toEqual([`${name}.dump`, `${name}.dump.sha256`, `${name}.json`]);
  for (const file of files) expect((await stat(join(backupDir, file))).mode & 0o777).toBe(0o600);
  const dump = await readFile(join(backupDir, `${name}.dump`));
  expect(dump.length).toBe(Number(size));

  // The checksum file is one sha256sum line naming its own dump, the hash Bun computes again, and sha256sum agrees.
  const checksum = await readFile(join(backupDir, `${name}.dump.sha256`), 'utf8');
  expect(checksum).toBe(`${hash}  ${name}.dump\n`);
  const recomputed = sha256(dump);
  expect(recomputed).toBe(hash!);
  const verified = await tool('sha256sum', ['--check', '--strict', `${name}.dump.sha256`], '/backup');
  expect(verified.code).toBe(0);

  // One compact JSON line with the keys in their order.
  const manifestText = await readFile(join(backupDir, `${name}.json`), 'utf8');
  expect(manifestText.endsWith('\n')).toBe(true);
  expect(manifestText.slice(0, -1)).not.toContain('\n');
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  expect(Object.keys(manifest)).toEqual(MANIFEST_KEYS);
  expect(manifestText.slice(0, -1)).toBe(JSON.stringify(manifest));
  const stamp = /^foundation-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z-manual$/.exec(name!)!;
  expect(manifest).toMatchObject({
    schema: 1, name, dump: `${name}.dump`, createdAt: `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`, reason: 'manual',
    database: 'foundation', format: 'custom', compression: 'zstd', globals: false, sizeBytes: Number(size), sha256: hash,
  });
  expect(manifest.serverVersion).toBe(serverVersion!);
  expect(String(manifest.pgDumpVersion)).toMatch(/^[0-9]+(\.[0-9]+)?$/);
  expect(Number.isInteger(manifest.durationMs) && (manifest.durationMs as number) >= 0).toBe(true);

  // Header and table of contents, read by the tool container: database foundation and data for every source table.
  const listed = await tool('pg_restore', ['--list', `/backup/${name}.dump`]);
  expect(listed.code).toBe(0);
  const list = listed.stdout.split('\n');
  expect(list).toContain(';     dbname: foundation');
  expect(list).toContain(`;     Dumped from database version: ${serverVersion}`);
  const sourceTables = await withPool(sourceCluster!.adminUrl, (sql) => sql`SELECT n.nspname AS schema, c.relname AS name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    ORDER BY 1, 2`);
  expect(sourceTables.map((row: { schema: string; name: string }) => `${row.schema}.${row.name}`)).toEqual(['common.schema_migrations', 'users.restore_fixture']);
  for (const row of sourceTables as Array<{ schema: string; name: string }>) {
    expect(list.some((line) => new RegExp(`^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ${row.schema} ${row.name} `).test(line)), `${row.schema}.${row.name}`).toBe(true);
  }
  const tocEntries = list.filter((line) => line !== '' && !line.startsWith(';')).length;
  expect(manifest.tocEntries).toBe(tocEntries);
  backupEvidence = {
    name, reason: 'manual', sizeBytes: Number(size), tocEntries, durationMs: manifest.durationMs, checksumVerified: verified.code === 0 && recomputed === hash,
  };
  checks.backup = 'passed';

  // AC-4: the dump text parsed by pg_restore --file=- holds the data sentinel (positive control) but no password, DSN,
  // or database setting sentinel of this run, and no role or password statement; nor do the manifest and checksum file.
  checks.secretScan = 'failed';
  const text = await tool('pg_restore', ['--file=-', `/backup/${name}.dump`]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(sentinel);
  for (const forbidden of ['CREATE ROLE', 'PASSWORD', 'SCRAM-SHA-256']) expect(text.stdout.includes(forbidden), forbidden).toBe(false);
  expect(scan('dump', text.stdout)).toBe(0);
  expect(scan('manifest', manifestText)).toBe(0);
  expect(scan('checksum', checksum)).toBe(0);
  checks.secretScan = 'passed';

  // Fingerprint of the source right after the backup, with nothing written in between.
  checks.fingerprint = 'failed';
  const printed = await fingerprint(sourceCluster!, true);
  expect(printed.stderr).toBe('');
  expect(printed.code).toBe(0);
  sourceFingerprint = printed.stdout.trim();
  const parsed = JSON.parse(sourceFingerprint) as { tables: Array<{ schema: string; name: string; rows: string }>; migrations: { count: number; last: string } };
  expect(parsed.tables.map((table) => `${table.schema}.${table.name}:${table.rows}`)).toEqual(['common.schema_migrations:2', 'users.restore_fixture:3']);
  expect(parsed.migrations.count).toBe(2);
  expect(parsed.migrations.last).toMatch(/-users-restore-fixture\.sql$/);

  // A second backup for `restore_failed`: a grant to a role that only the source has, so pg_restore fails on the target
  // after every check passed. The role and its grant exist only for this backup.
  const probe = `foundation_restore_probe_${hex}`;
  await withPool(sourceCluster!.adminUrl, async (sql) => {
    await sql.unsafe(`CREATE ROLE ${probe} NOLOGIN`);
    await sql.unsafe(`GRANT SELECT ON TABLE users.restore_fixture TO ${probe}`);
  });
  try {
    await Bun.sleep(1_000);
    const second = await composeRun('backup', ['create', 'manual']);
    expect(second.leaked).toBe(0);
    expect(lines(second.stderr)).toEqual([]);
    expect(second.code).toBe(0);
    const secondMatch = /^Backup created: (foundation-[0-9]{8}T[0-9]{6}Z-manual)\.dump \([0-9]+ bytes, sha256 [0-9a-f]{64}\)$/.exec(lines(second.stdout)[0] ?? '');
    expect(secondMatch).not.toBeNull();
    secondBackup = secondMatch![1]!;
    expect(secondBackup).not.toBe(mainBackup);
    expect(scan('manifest', await readFile(join(backupDir, `${secondBackup}.json`), 'utf8'))).toBe(0);
    expect(scan('checksum', await readFile(join(backupDir, `${secondBackup}.dump.sha256`), 'utf8'))).toBe(0);
  } finally {
    await withPool(sourceCluster!.adminUrl, async (sql) => {
      await sql.unsafe(`REVOKE ALL ON TABLE users.restore_fixture FROM ${probe}`);
      await sql.unsafe(`DROP ROLE ${probe}`);
    });
  }
}, 240_000);

test('BKP-003 create scheduled and create pre-migration each leave one complete backup whose name, createdAt, and reason carry the reason and the UTC start time, in 0600 files of the container user', async () => {
  // covers: AC-3 (alasan `scheduled` dan `pre-migration`; Value sourcing nama dan `createdAt`, alasan, user container)
  const previous = checks.backup;
  checks.backup = 'failed';
  const dir = await caseFolder('reasons');
  const files: string[] = [];
  for (const reason of ['scheduled', 'pre-migration'] as const) {
    const started = await containerNow();
    const created = await composeRun('backup', ['create', reason], { FOUNDATION_BACKUP_DIR: dir });
    const ended = await containerNow();
    expect(created.leaked).toBe(0);
    expect(lines(created.stderr)).toEqual([]);
    expect(created.code).toBe(0);
    const output = lines(created.stdout);
    expect(output).toHaveLength(1);
    const match = new RegExp(`^Backup created: (foundation-([0-9]{8}T[0-9]{6}Z)-${reason})\\.dump \\([0-9]+ bytes, sha256 [0-9a-f]{64}\\)$`).exec(output[0] ?? '');
    expect(match, reason).not.toBeNull();
    const name = match![1]!;
    const stamp = match![2]!;
    // The stamp is the UTC time the run started (`date -u` in the container), never a local time: it lies between the
    // container clock read before and after the run, while a local stamp would be off by the zone offset. The host
    // clock is not used, because the clock of the container engine can drift from it.
    const createdAt = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
    expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(createdAt)).toBeLessThanOrEqual(ended);
    const manifest = JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name, dump: `${name}.dump`, createdAt, reason });
    for (const file of [`${name}.dump`, `${name}.dump.sha256`, `${name}.json`]) {
      const info = await stat(join(dir, file));
      expect(info.mode & 0o777, file).toBe(0o600);
      expect(info.uid, file).toBe(uid);
      files.push(file);
    }
  }
  // Exactly the six files of the two runs: each run made its three files and retention found nothing to remove.
  expect((await readdir(dir)).sort()).toEqual(files.sort());
  checks.backup = previous;
}, 120_000);

test('BKP-003 a backup role password with every reserved URI character, percent encoded in the DSN, authenticates, because the script decodes it as libpq does before it leaves the arguments', async () => {
  // covers: AC-3 (Perintah pg_dump: password lewat PGPASSWORD dengan decode persen seperti libpq), AC-4
  const previous = checks.backup;
  checks.backup = 'failed';
  const dir = await caseFolder('reserved-password');
  await withPool(sourceCluster!.adminUrl, async (sql) => {
    const [row] = await sql`SELECT pg_catalog.format('ALTER ROLE foundation_backup PASSWORD %L', ${reserved}::text) AS statement`;
    await sql.unsafe(String((row as { statement: string }).statement));
  });
  try {
    const created = await composeRun('backup', ['create', 'manual'], { FOUNDATION_BACKUP_DIR: dir, FOUNDATION_BACKUP_DATABASE_URL: dsn.backupReserved });
    expect(created.leaked).toBe(0);
    expect(lines(created.stderr)).toEqual([]);
    expect(created.code).toBe(0);
    expect(lines(created.stdout)).toHaveLength(1);
    expect(lines(created.stdout)[0]).toMatch(/^Backup created: foundation-[0-9]{8}T[0-9]{6}Z-manual\.dump \([0-9]+ bytes, sha256 [0-9a-f]{64}\)$/);
  } finally {
    await withPool(sourceCluster!.adminUrl, (sql) => sql.unsafe(`ALTER ROLE foundation_backup PASSWORD '${source.backup}'`));
  }
  checks.backup = previous;
}, 120_000);

test('BKP-003 docker compose config resolves the example env file to the default image and user, mounts the backup folder read only for restore, starts no service without a profile, and fails naming FOUNDATION_BACKUP_DIR or FOUNDATION_DATA_NETWORK when either is missing', async () => {
  // covers: AC-3 (tabel Topologi backup lewat Compose, Configuration required, .env.backup.example)
  const example = await readFile(join(root, '.env.backup.example'), 'utf8');
  const configDir = await caseFolder('config');
  const values: Record<string, string> = {
    FOUNDATION_BACKUP_DATABASE_URL: 'postgres://foundation_backup:example-only@postgres:5432/foundation',
    FOUNDATION_BACKUP_DIR: configDir,
    FOUNDATION_DATA_NETWORK: 'foundation-deploy_data',
  };
  // The example with the three required values filled in, or with the line of `omit` left out; optional lines stay empty.
  const envFile = async (omit?: string): Promise<string> => {
    const text = example.split('\n').flatMap((line) => {
      const key = /^([A-Z][A-Z0-9_]*)=$/.exec(line)?.[1];
      if (key === undefined) return [line];
      return key === omit ? [] : [`${key}=${values[key] ?? ''}`];
    }).join('\n');
    const file = join(folder, `config-${omit ?? 'all'}.env`);
    await writeFile(file, text, { mode: 0o600 });
    return file;
  };
  const full = await envFile();
  // The restore network comes only from the shell, as in step 4 of *Runbook restore*; the example has no such line.
  expect(example).not.toContain('FOUNDATION_RESTORE_DATA_NETWORK=');
  const shell = { ...dockerEnv, FOUNDATION_RESTORE_DATA_NETWORK: 'foundation-drill-20261006_data' };
  const resolved = await command(['docker', 'compose', '--env-file', full, '-f', 'deploy/backup.yaml', '--profile', 'backup', '--profile', 'restore', 'config', '--format', 'json'], shell);
  expect(resolved.code).toBe(0);
  const config = JSON.parse(resolved.stdout) as { name: string; services: Record<string, Record<string, any>>; networks: Record<string, Record<string, unknown>> };
  expect(config.name).toBe('foundation-backup');
  expect(Object.keys(config.services).sort()).toEqual(['backup', 'restore']);
  for (const service of ['backup', 'restore']) {
    const definition = config.services[service]!;
    // Empty optional lines of the example fall back to the defaults of *Topologi backup*.
    expect(definition['image'], service).toBe('foundation-postgres:18-pinned');
    expect(definition['user'], service).toBe('26:26');
    expect(Object.keys(definition['networks'] as object), service).toEqual([service === 'backup' ? 'data' : 'restore_data']);
    expect(definition['ports'], service).toBeUndefined();
    const volumes = definition['volumes'] as Array<Record<string, unknown>>;
    expect(volumes.map((volume) => [volume['type'], volume['source'], volume['target'], volume['read_only'] === true]), service).toEqual([
      ['bind', configDir, '/backup', service === 'restore'],
      ['bind', join(root, `deploy/backup/foundation-${service}.sh`), `/opt/foundation/foundation-${service}.sh`, true],
    ]);
  }
  // Only the backup job holds a DSN, and only its own; the restore gets the admin DSN through `run -e` alone.
  expect(config.services['backup']!['environment']).toEqual({ FOUNDATION_BACKUP_DATABASE_URL: values['FOUNDATION_BACKUP_DATABASE_URL'] });
  expect(config.services['restore']!['environment']).toBeUndefined();
  expect(config.networks['data']).toMatchObject({ name: 'foundation-deploy_data', external: true });
  // The backup job joins the source network of the env file; the restore joins only the network the shell names.
  expect(config.networks['restore_data']).toMatchObject({ name: 'foundation-drill-20261006_data', external: true });

  // Without a profile neither one shot job is part of the project, so `up` never starts one.
  const plain = await command(['docker', 'compose', '--env-file', full, '-f', 'deploy/backup.yaml', 'config', '--format', 'json'], dockerEnv);
  expect(plain.code).toBe(0);
  expect((JSON.parse(plain.stdout) as { services?: Record<string, unknown> }).services ?? {}).toEqual({});

  // The two required values without a default stop Compose before any container, naming the variable.
  for (const missing of ['FOUNDATION_BACKUP_DIR', 'FOUNDATION_DATA_NETWORK']) {
    const file = await envFile(missing);
    const failed = await command(['docker', 'compose', '--env-file', file, '-f', 'deploy/backup.yaml', '--profile', 'backup', '--profile', 'restore', 'config', '--quiet'], dockerEnv);
    expect(failed.code, missing).not.toBe(0);
    expect(failed.stderr, missing).toContain(`required variable ${missing} is missing a value`);
  }
  // A missing DSN line is not a Compose error: the job starts and the script fails `Missing FOUNDATION_BACKUP_DATABASE_URL`.
  const withoutDsn = await command(['docker', 'compose', '--env-file', await envFile('FOUNDATION_BACKUP_DATABASE_URL'), '-f', 'deploy/backup.yaml', '--profile', 'backup', 'config', '--format', 'json'], dockerEnv);
  expect(withoutDsn.code).toBe(0);
  expect((JSON.parse(withoutDsn.stdout) as { services: Record<string, Record<string, unknown>> }).services['backup']!['environment']).toEqual({ FOUNDATION_BACKUP_DATABASE_URL: '' });
}, 60_000);

// Row 2 of *Urutan uji target*: a new cluster that is not provisioned yet.
test('BKP-005 target_not_provisioned: restore into a new cluster without provisioning fails Restore target not provisioned and changes nothing', async () => {
  guards.set('target_not_provisioned', 'failed');
  expect(mainBackup).toMatch(BACKUP_NAME);
  targetCluster = await startCluster(targetName, target);
  const before = await adminCatalog(targetCluster);
  expectRejected(await restoreRun([`${mainBackup}.dump`]), 'Restore target not provisioned');
  expect(await adminCatalog(targetCluster)).toBe(before);
  guards.set('target_not_provisioned', 'passed');
}, 120_000);

// Row 3 of *Urutan uji target*: provisioned with four new passwords and empty.
test('BKP-005 restore_failed: pg_restore failing after every check passed rolls back the single transaction and leaves the target empty', async () => {
  guards.set('restore_failed', 'failed');
  expect(secondBackup).toMatch(BACKUP_NAME);
  const provisioned = await provision(targetCluster!, target);
  expect(provisioned.code).toBe(0);
  expect(provisioned.stdout).toContain('foundation_backup: created');
  const before = await fingerprint(targetCluster!, true);
  expect(before.code).toBe(0);
  expectRejected(await restoreRun([`${secondBackup}.dump`]), 'Restore failed: pg_restore');
  const after = await fingerprint(targetCluster!, true);
  expect(after.code).toBe(0);
  expect(after.stdout).toBe(before.stdout);
  const [row] = await withPool(targetCluster!.adminUrl, (sql) => sql.unsafe(TARGET_EMPTY));
  expect((row as { empty: boolean }).empty).toBe(true);
  guards.set('restore_failed', 'passed');
}, 120_000);

// Row 4 of *Urutan uji target*: the only restore that succeeds, and the only one measured.
test('BKP-004 restore through the Compose service restore into the provisioned empty target gives the same data, history, and readiness 200, and the source passwords fail there', async () => {
  checks.restore = 'failed';
  expect(mainBackup).toMatch(BACKUP_NAME);
  const started = performance.now();
  const restored = await restoreRun([`${mainBackup}.dump`]);
  expect(restored.leaked).toBe(0);
  expect(lines(restored.stderr)).toEqual([]);
  expect(restored.code).toBe(0);
  expect(lines(restored.stdout)).toEqual([`Restore completed: ${mainBackup}.dump`]);

  // Provisioning again prints only verified, database privileges included.
  const again = await provision(targetCluster!, target);
  expect(again.code).toBe(0);
  const report = lines(again.stdout);
  expect(report).toContain('database privileges: verified');
  expect(report).toContain('foundation_backup: verified');
  expect(report.filter((line) => !line.endsWith(': verified'))).toEqual([]);

  // The runner with the same migration set as the source applies nothing.
  const run = await withPool(targetCluster!.migratorUrl, (sql) => runDatabaseCommand('migration', sql, fixtureRoot));
  const migrations = `Migrations: ${run.applied.length} applied, ${run.skipped.length} skipped`;
  expect(migrations).toBe(`Migrations: 0 applied, ${JSON.parse(sourceFingerprint).migrations.count} skipped`);

  // The fingerprint with the backup role of the target equals the source fingerprint taken right after the backup.
  const printed = await fingerprint(targetCluster!, true);
  expect(printed.code).toBe(0);
  const equal = printed.stdout.trim() === sourceFingerprint;
  expect(printed.stdout.trim()).toBe(sourceFingerprint);
  const parsed = JSON.parse(sourceFingerprint) as Record<string, unknown> & { tables: Array<Record<string, unknown>> };
  fingerprintEvidence = {
    equal,
    tables: parsed.tables.map(({ schema, name, rows }) => ({ schema, name, rows })),
    sequences: parsed.sequences,
    migrations: parsed.migrations,
  };
  checks.fingerprint = equal ? 'passed' : 'failed';

  // GET /health/ready of the production app on a foundation_backend pool with the new password.
  let readinessStatus = 0;
  const pool = createDatabasePool(targetCluster!.backendUrl);
  try {
    const app = createApp('production', { database: pool });
    const ready = await waitFor(async () => {
      const response = await app.handle(new Request('http://localhost/health/ready'));
      readinessStatus = response.status;
      await response.text();
      return response.status === 200;
    }, 30_000, 250);
    expect(ready).toBe(true);
  } finally {
    await pool.close();
  }
  const durationMs = Math.round(performance.now() - started);
  expect(readinessStatus).toBe(200);
  expect(durationMs).toBeLessThanOrEqual(RESTORE_LIMIT_MS);

  // Invariant 1: the database level setting of the source is not in the backup, so the target does not have it.
  const [setting] = await withPool(targetCluster!.adminUrl, (sql) => sql`SELECT count(*)::integer AS count FROM pg_catalog.pg_db_role_setting
    WHERE pg_catalog.array_to_string(setconfig, ',') LIKE '%backup_probe%'`);
  expect((setting as { count: number }).count).toBe(0);

  // The migrator, backend, and backup passwords of the source fail authentication on the target.
  const oldPasswordsRejected: string[] = [];
  for (const [role, password] of [['foundation_migrator', source.migrator], ['foundation_backend', source.backend], ['foundation_backup', source.backup]] as const) {
    const attempt = new SQL({ url: `postgres://${role}:${password}@127.0.0.1:${targetCluster!.port}/foundation`, max: 1, connectionTimeout: 3 });
    let rejected = false;
    try {
      await attempt`SELECT 1`;
    } catch (error) {
      rejected = String((error as { errno?: unknown }).errno ?? '') === '28P01' || /password authentication failed/.test(String((error as Error).message));
    } finally {
      await attempt.close();
    }
    if (rejected) oldPasswordsRejected.push(role);
  }
  expect(oldPasswordsRejected).toEqual(['foundation_migrator', 'foundation_backend', 'foundation_backup']);
  restoreEvidence = { durationMs, provisioning: 'verified', migrations, readinessStatus, oldPasswordsRejected };
  checks.restore = 'passed';
}, 300_000);

test('BKP-004 database/fingerprint.ts takes no argument or --digest, needs FOUNDATION_BACKUP_DATABASE_URL, reads only as foundation_backup on database foundation, and prints a fixed line without a DSN on any failure', async () => {
  // covers: AC-5 (Value sourcing Fingerprint: argumen, identitas, dan kegagalan tanpa DSN; mode tanpa --digest)
  const previous = checks.fingerprint;
  checks.fingerprint = 'failed';
  const port = targetCluster!.port;
  const url = (role: string, password: string, database = 'foundation') => `postgres://${role}:${password}@127.0.0.1:${port}/${database}`;
  const expectFailed = (result: Result, message: string, label: string) => {
    expect(result.leaked, label).toBe(0);
    expect(result.stdout, label).toBe('');
    expect(result.stderr, label).toBe(`${message}\n`);
    expect(result.code, label).toBe(1);
  };
  for (const args of [['--x'], ['digest'], ['--digest', '--digest'], ['--digest', '--x']]) {
    expectFailed(await fingerprintRun(args, targetCluster!.backupUrl), 'Use no argument or --digest', args.join(' '));
  }
  expectFailed(await fingerprintRun(['--digest'], undefined), 'Missing FOUNDATION_BACKUP_DATABASE_URL', 'unset');
  expectFailed(await fingerprintRun(['--digest'], ''), 'Missing FOUNDATION_BACKUP_DATABASE_URL', 'empty');
  // Another login role, the bootstrap superuser included, or the backup role on another database is not a target.
  for (const [label, other] of [['backend', targetCluster!.backendUrl], ['admin', targetCluster!.adminUrl], ['database postgres', url('foundation_backup', target.backup, 'postgres')]] as const) {
    expectFailed(await fingerprintRun(['--digest'], other), 'Invalid fingerprint target', label);
  }
  // A wrong password and the two broken connection strings: only the fixed line, never a part of the DSN.
  for (const [label, password] of [['wrong', broken.backupWrong], ['space', `${broken.backupSpace} x`], ['percent', `${broken.backupPercent}%zz`]] as const) {
    expectFailed(await fingerprintRun(['--digest'], url('foundation_backup', password)), 'Fingerprint failed', label);
  }

  // Without --digest (the mode of the drill record): the tables, rows, sequences, and history of the source, no digest.
  const plain = await fingerprintRun([], targetCluster!.backupUrl);
  expect(plain.leaked).toBe(0);
  expect(plain.stderr).toBe('');
  expect(plain.code).toBe(0);
  expect(lines(plain.stdout)).toHaveLength(1);
  const expected = JSON.parse(sourceFingerprint) as FingerprintOutput;
  expected.tables = expected.tables.map(({ schema, name, rows }) => ({ schema, name, rows }));
  expect(plain.stdout.trim()).toBe(JSON.stringify(expected));
  // Types of *Fingerprint*: rows, lastValue, and digest as text so bigint and numeric never lose digits.
  const digested = JSON.parse(sourceFingerprint) as FingerprintOutput;
  expect(Object.keys(digested)).toEqual(['schema', 'tables', 'sequences', 'migrations']);
  for (const table of digested.tables) expect([typeof table.rows, typeof table.digest]).toEqual(['string', 'string']);
  expect(digested.sequences.length).toBeGreaterThan(0);
  for (const sequence of digested.sequences) expect([typeof sequence.lastValue, typeof sequence.isCalled]).toEqual(['string', 'boolean']);
  expect([typeof digested.migrations.count, typeof digested.migrations.last]).toEqual(['number', 'string']);
  checks.fingerprint = previous;
}, 120_000);

// Row 5 of *Urutan uji target*: every other guard on the restored target, each proven not to change it.
test('BKP-005 invalid_name: a path, `..`, or a name outside the pattern fails Invalid backup name', async () => {
  guards.set('invalid_name', 'failed');
  for (const argument of [`/backup/${mainBackup}.dump`, '..', `../${mainBackup}.dump`, `${mainBackup}.json`, 'foundation-20261006T020000Z-weekly.dump']) {
    expectRejected(await restoreRun([argument]), 'Invalid backup name');
  }
  await expectTargetUnchanged();
  guards.set('invalid_name', 'passed');
}, 120_000);

test('BKP-005 invalid_name: a restore without an argument or with two arguments fails with the usage line', async () => {
  // covers: AC-6 (langkah 1 Urutan restore: tepat satu argumen; pesan pemakaian tabel Pesan script)
  const previous = guards.get('invalid_name') ?? 'not_run';
  guards.set('invalid_name', 'failed');
  expectRejected(await restoreRun([]), 'Usage: foundation-restore.sh <name>.dump');
  expectRejected(await restoreRun([`${mainBackup}.dump`, `${mainBackup}.dump`]), 'Usage: foundation-restore.sh <name>.dump');
  await expectTargetUnchanged();
  guards.set('invalid_name', previous);
}, 120_000);

test('BKP-005 incomplete_backup: a backup without its manifest, or with a symlink in its place, fails Backup incomplete', async () => {
  guards.set('incomplete_backup', 'failed');
  const missing = await copyBackup({ manifest: 'missing' });
  const linked = await copyBackup({ manifest: 'symlink' });
  try {
    expectRejected(await restoreRun([`${missing}.dump`]), `Backup incomplete: ${missing}`);
    expectRejected(await restoreRun([`${linked}.dump`]), `Backup incomplete: ${linked}`);
  } finally {
    await removeCopies([missing, linked]);
  }
  await expectTargetUnchanged();
  guards.set('incomplete_backup', 'passed');
}, 120_000);

test('BKP-005 checksum_mismatch: a dump that no longer matches its checksum fails Backup checksum mismatch', async () => {
  guards.set('checksum_mismatch', 'failed');
  const original = await readFile(join(backupDir, `${mainBackup}.dump`));
  const changed = Buffer.from(original);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
  const name = await copyBackup({ dump: changed });
  try {
    // The checksum line keeps the hash of the original bytes under the new name.
    await writeFile(join(backupDir, `${name}.dump.sha256`), `${sha256(original)}  ${name}.dump\n`, { mode: 0o600 });
    expectRejected(await restoreRun([`${name}.dump`]), `Backup checksum mismatch: ${name}`);
  } finally {
    await removeCopies([name]);
  }
  await expectTargetUnchanged();
  guards.set('checksum_mismatch', 'passed');
}, 120_000);

test('BKP-005 checksum_wrong_file: a checksum file naming another copy with the right hash for that copy fails Backup checksum mismatch', async () => {
  guards.set('checksum_wrong_file', 'failed');
  const valid = await copyBackup();
  const changed = Buffer.from(await readFile(join(backupDir, `${mainBackup}.dump`)));
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
  const validChecksum = await readFile(join(backupDir, `${valid}.dump.sha256`), 'utf8');
  const name = await copyBackup({ dump: changed, checksum: validChecksum });
  try {
    // sha256sum --check alone passes, because it checks the file the line names; only the line check catches it.
    const alone = await tool('sha256sum', ['--check', '--strict', `${name}.dump.sha256`], '/backup');
    expect(alone.code).toBe(0);
    expectRejected(await restoreRun([`${name}.dump`]), `Backup checksum mismatch: ${name}`);
  } finally {
    await removeCopies([valid, name]);
  }
  await expectTargetUnchanged();
  guards.set('checksum_wrong_file', 'passed');
}, 120_000);

test('BKP-005 archive_invalid: bytes that are not an archive, with a matching checksum, fail Backup archive invalid', async () => {
  guards.set('archive_invalid', 'failed');
  const name = await copyBackup({ dump: randomBytes(4096) });
  try {
    expectRejected(await restoreRun([`${name}.dump`]), `Backup archive invalid: ${name}`);
  } finally {
    await removeCopies([name]);
  }
  await expectTargetUnchanged();
  guards.set('archive_invalid', 'passed');
}, 120_000);

test('BKP-005 missing_admin_url: `-e FOUNDATION_ADMIN_DATABASE_URL` while the shell has no value fails Missing FOUNDATION_ADMIN_DATABASE_URL', async () => {
  guards.set('missing_admin_url', 'failed');
  expectRejected(await restoreRun([`${mainBackup}.dump`], null), 'Missing FOUNDATION_ADMIN_DATABASE_URL');
  await expectTargetUnchanged();
  guards.set('missing_admin_url', 'passed');
}, 120_000);

test('BKP-005 invalid_target: an admin DSN to database postgres, or a DSN of foundation_backend, fails Invalid restore target', async () => {
  guards.set('invalid_target', 'failed');
  expectRejected(await restoreRun([`${mainBackup}.dump`], dsn.targetPostgres), 'Invalid restore target');
  expectRejected(await restoreRun([`${mainBackup}.dump`], dsn.targetBackend), 'Invalid restore target');
  await expectTargetUnchanged();
  guards.set('invalid_target', 'passed');
}, 120_000);

test('BKP-005 major_mismatch: a dump whose header names another major version fails Backup major version mismatch', async () => {
  guards.set('major_mismatch', 'failed');
  const original = await readFile(join(backupDir, `${mainBackup}.dump`));
  const [major = '', minor = ''] = serverVersion!.split('.');
  const other = String(Number(major) - 1);
  expect(other).toHaveLength(major.length);
  // The first occurrence of the server version is the `Dumped from` string of the archive header, before any data.
  const at = original.indexOf(Buffer.from(serverVersion!, 'latin1'));
  expect(at).toBeGreaterThan(0);
  const changed = Buffer.from(original);
  changed.write(other, at, 'latin1');
  const name = await copyBackup({ dump: changed });
  try {
    const listed = await tool('pg_restore', ['--list', `/backup/${name}.dump`]);
    expect(listed.code).toBe(0);
    expect(listed.stdout.split('\n')).toContain(`;     Dumped from database version: ${other}.${minor}`);
    expect(listed.stdout.split('\n')).toContain(`;     Dumped by pg_dump version: ${serverVersion}`);
    expectRejected(await restoreRun([`${name}.dump`]), 'Backup major version mismatch');
  } finally {
    await removeCopies([name]);
  }
  await expectTargetUnchanged();
  guards.set('major_mismatch', 'passed');
}, 120_000);

test('BKP-005 target_not_empty: restoring again into the restored target fails Restore target not empty', async () => {
  guards.set('target_not_empty', 'failed');
  expectRejected(await restoreRun([`${mainBackup}.dump`]), 'Restore target not empty');
  await expectTargetUnchanged();
  guards.set('target_not_empty', 'passed');
}, 120_000);

test('BKP-005 major_mismatch: the restore reads the major version from the archive header, never the manifest, so a manifest naming another version or holding no JSON passes every check up to Restore target not empty', async () => {
  // covers: AC-6, AC-5 (Value sourcing Major backup: header dump lewat pg_restore --list, bukan manifest)
  const previous = guards.get('major_mismatch') ?? 'not_run';
  guards.set('major_mismatch', 'failed');
  const otherVersion = await copyBackup();
  const noJson = await copyBackup();
  try {
    const manifest = join(backupDir, `${otherVersion}.json`);
    const text = await readFile(manifest, 'utf8');
    const changed = text.replace(`"serverVersion":"${serverVersion}"`, '"serverVersion":"17.6"').replace(/"pgDumpVersion":"[^"]*"/, '"pgDumpVersion":"17.6"');
    expect(changed).not.toBe(text);
    await writeFile(manifest, changed, { mode: 0o600 });
    await writeFile(join(backupDir, `${noJson}.json`), 'not a manifest\n', { mode: 0o600 });
    // Step 9 runs after the major check of step 7, so `not empty` proves steps 1 to 8 passed with this manifest.
    for (const name of [otherVersion, noJson]) expectRejected(await restoreRun([`${name}.dump`]), 'Restore target not empty');
  } finally {
    await removeCopies([otherVersion, noJson]);
  }
  await expectTargetUnchanged();
  guards.set('major_mismatch', previous);
}, 120_000);

test('BKP-005 checksum_mismatch: a checksum file with a second line, upper case hex, or the binary mode marker fails Backup checksum mismatch although sha256sum --check alone accepts it', async () => {
  // covers: AC-6 (langkah 4 Urutan restore: tepat satu baris `^[0-9a-f]{64}  <nama>\.dump$` sebelum sha256sum)
  const previous = guards.get('checksum_mismatch') ?? 'not_run';
  guards.set('checksum_mismatch', 'failed');
  const hash = sha256(await readFile(join(backupDir, `${mainBackup}.dump`)));
  const variants: Array<[string, (name: string) => string]> = [
    ['second line', (name) => `${hash}  ${name}.dump\n${hash}  ${name}.dump\n`],
    ['upper case', (name) => `${hash.toUpperCase()}  ${name}.dump\n`],
    ['binary marker', (name) => `${hash} *${name}.dump\n`],
  ];
  const names: string[] = [];
  try {
    for (const [label, line] of variants) {
      const name = await copyBackup();
      names.push(name);
      await writeFile(join(backupDir, `${name}.dump.sha256`), line(name), { mode: 0o600 });
      // The dump is intact and sha256sum accepts each form, so only the line check of the script rejects it.
      const alone = await tool('sha256sum', ['--check', '--strict', `${name}.dump.sha256`], '/backup');
      expect(alone.code, label).toBe(0);
      expectRejected(await restoreRun([`${name}.dump`]), `Backup checksum mismatch: ${name}`);
    }
  } finally {
    await removeCopies(names);
  }
  await expectTargetUnchanged();
  guards.set('checksum_mismatch', previous);
}, 120_000);

test('BKP-005 history_drift: the migration runner with the repository migrations fails Migration history drift on the restored target without a change', async () => {
  guards.set('history_drift', 'failed');
  const drift = await command([process.execPath, '--no-env-file', 'database/migrate.ts', '--apply'], {
    PATH: process.env['PATH'] ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: targetCluster!.migratorUrl,
  });
  expect(drift.stdout).toBe('');
  expect(drift.stderr).toBe('Migration history drift\n');
  expect(drift.code).toBe(1);
  await expectTargetUnchanged();
  guards.set('history_drift', 'passed');
}, 120_000);

// Row 6 of *Urutan uji target*: failures of restore on the admin DSN of the target, then failures of backup on the source.
test('BKP-006 restore with a wrong password or a broken admin connection string fails with one category line, no secret, and the target unchanged', async () => {
  expectRejected(await restoreRun([`${mainBackup}.dump`], dsn.restoreWrong), 'Restore target unavailable');
  expectRejected(await restoreRun([`${mainBackup}.dump`], dsn.restoreSpace), 'Restore failed: invalid connection string');
  expectRejected(await restoreRun([`${mainBackup}.dump`], dsn.restorePercent), 'Restore failed: invalid connection string');
  await expectTargetUnchanged();
}, 120_000);

test('BKP-006 a restore without FOUNDATION_RESTORE_DATA_NETWORK in the shell stops in Compose before any container, so it never joins the source network the env file names', async () => {
  // covers: AC-3 (Topologi backup: network restore hanya dari shell), invariant 3 (container restore hanya di network
  // data target). The env file of this run names the source network, as .env.backup does in production.
  const result = await composeRun('restore', [`${mainBackup}.dump`], { FOUNDATION_ADMIN_DATABASE_URL: dsn.targetAdmin }, true);
  expect(result.leaked).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('declared as external, but could not be found');
  expect(result.stderr).not.toContain('Restore');
  expect(result.code).not.toBe(0);
  await expectTargetUnchanged();
}, 120_000);

test('BKP-006 TERM and INT during a restore that waits on a lock of the target end with Restore failed: interrupted and exit 143 or 130 without a password in any process argument, and a fingerprint on the same lock fails after 30 seconds', async () => {
  // covers: AC-6 (kategori `interrupted` restore dengan komponen nyata, target tidak berubah), AC-4 (password admin
  // tidak ada di argumen proses), AC-5 (Fingerprint: `lock_timeout` 30 detik berakhir `Fingerprint failed`)
  const unlock = await lockTable(targetCluster!.adminUrl, 'common.schema_migrations');
  let current: { name: string; pending: Promise<Result> } | undefined;
  try {
    // The fingerprint reads common.schema_migrations first, so it waits on the lock until its lock_timeout ends it.
    const fingerprintStarted = performance.now();
    const blocked = fingerprintRun(['--digest'], targetCluster!.backupUrl);
    for (const [signal, code] of [['TERM', 143], ['INT', 130]] as const) {
      // Step 9 of *Urutan restore* counts common.schema_migrations, so psql waits there (at most 60 seconds).
      const pending = restoreRun([`${mainBackup}.dump`]);
      current = { name: runName(runs), pending };
      const seen = await waitForTool(current.name, 'psql');
      expect(seen.length, `${signal}: psql runs`).toBeGreaterThan(0);
      // The admin DSN reaches psql without its password; the user, host, and database stay in the argument.
      expect(seen.some((line) => line.includes(target.admin)), `${signal}: password in a process argument`).toBe(false);
      expect(seen.some((line) => line.includes('psql ') && line.includes('--dbname=postgres://foundation_admin@postgres:5432/foundation ')), signal).toBe(true);
      expect((await command(['docker', 'kill', '--signal', signal, current.name], dockerEnv)).code, signal).toBe(0);
      const result = await pending;
      current = undefined;
      expect(result.leaked).toBe(0);
      expect(lines(result.stdout)).toEqual([]);
      expect(lines(result.stderr)).toEqual(['Restore failed: interrupted']);
      expect(result.code, signal).toBe(code);
    }
    const fingerprinted = await blocked;
    expect(performance.now() - fingerprintStarted).toBeGreaterThan(25_000);
    expect(fingerprinted.leaked).toBe(0);
    expect(fingerprinted.stdout).toBe('');
    expect(fingerprinted.stderr).toBe('Fingerprint failed\n');
    expect(fingerprinted.code).toBe(1);
  } finally {
    // A run an assertion left behind is removed by name before the lock goes, so it never restores afterwards.
    if (current !== undefined) {
      await command(['docker', 'rm', '-f', current.name], dockerEnv);
      await current.pending.catch(() => undefined);
    }
    await unlock();
  }
  await expectTargetUnchanged();
}, 180_000);

/**
 * A backup that must fail with `message`: the folder (or the file given as folder) holds exactly what it held before,
 * including the 2 day leftover that retention would remove, so no file of the run stays and no retention ran.
 */
async function expectBackupRejected(message: string, env: Record<string, string> = {}, folderPath = backupDir): Promise<void> {
  const before = await folderState(folderPath);
  expectRejected(await composeRun('backup', ['create', 'manual'], env), message);
  expect(await folderState(folderPath)).toBe(before);
}

test('BKP-006 backup with a wrong password, a broken connection string, or a login role other than foundation_backup fails with one category line and leaves the folder as it was', async () => {
  // One leftover 2 days old: retention would remove it, so it staying proves no failed run reached retention.
  const old = new Date(Date.now() - 2 * 86_400_000);
  const leftover = join(backupDir, `.foundation-${stampOf(old)}-manual.dump.partial`);
  await writeFile(leftover, 'leftover', { mode: 0o600 });
  await utimes(leftover, old, old);
  await expectBackupRejected('Backup failed: connection', { FOUNDATION_BACKUP_DATABASE_URL: dsn.backupWrong });
  await expectBackupRejected('Backup failed: invalid connection string', { FOUNDATION_BACKUP_DATABASE_URL: dsn.backupSpace });
  await expectBackupRejected('Backup failed: invalid connection string', { FOUNDATION_BACKUP_DATABASE_URL: dsn.backupPercent });
  await expectBackupRejected('Backup failed: permission denied', { FOUNDATION_BACKUP_DATABASE_URL: dsn.sourceBackend });
  // Invariant 3: the job holds only the backup role. The superuser could SET ROLE pg_read_all_data, so only the login
  // role check before pg_dump refuses it; the migrator is refused the same way.
  await expectBackupRejected('Backup failed: permission denied', { FOUNDATION_BACKUP_DATABASE_URL: dsn.sourceAdmin });
  await expectBackupRejected('Backup failed: permission denied', { FOUNDATION_BACKUP_DATABASE_URL: dsn.sourceMigrator });
  await expectTargetUnchanged();
}, 180_000);

test('BKP-006 backup of a source table with row level security fails Backup failed: row level security, and the source fingerprint fails too', async () => {
  await withPool(sourceCluster!.adminUrl, async (sql) => {
    await sql`CREATE TABLE users.backup_rls_probe (id integer)`;
    await sql`ALTER TABLE users.backup_rls_probe OWNER TO foundation_owner`;
    await sql`ALTER TABLE users.backup_rls_probe ENABLE ROW LEVEL SECURITY`;
  });
  try {
    await expectBackupRejected('Backup failed: row level security');
    const printed = await fingerprint(sourceCluster!, true);
    expect(printed.stdout).toBe('');
    expect(printed.stderr).toBe('Fingerprint failed\n');
    expect(printed.code).toBe(1);
  } finally {
    await withPool(sourceCluster!.adminUrl, (sql) => sql`DROP TABLE users.backup_rls_probe`);
  }
  await expectTargetUnchanged();
}, 180_000);

test('BKP-006 backup while the admin holds ACCESS EXCLUSIVE on a source table fails Backup failed: lock timeout after about 30 seconds', async () => {
  const unlock = await lockTable(sourceCluster!.adminUrl, 'users.restore_fixture');
  try {
    const started = performance.now();
    await expectBackupRejected('Backup failed: lock timeout');
    expect(performance.now() - started).toBeGreaterThan(25_000);
  } finally {
    await unlock();
  }
  await expectTargetUnchanged();
}, 180_000);

test('BKP-006 TERM, INT, and docker stop during a backup that waits on a lock end with Backup failed: interrupted and exit 143 or 130, leave the folder as it was, and no process argument holds the password', async () => {
  // covers: AC-3 (kategori `interrupted` dengan komponen nyata: TERM 143, INT dan `docker stop` 130 karena image memakai
  // STOPSIGNAL SIGINT), AC-4 (password tidak ada di argumen proses selama pg_dump berjalan)
  const unlock = await lockTable(sourceCluster!.adminUrl, 'users.restore_fixture');
  let current: { name: string; pending: Promise<Result> } | undefined;
  try {
    for (const [signal, code] of [['TERM', 143], ['INT', 130], ['stop', 130]] as const) {
      const before = await folderState(backupDir);
      const pending = composeRun('backup', ['create', 'manual']);
      current = { name: runName(runs), pending };
      // pg_dump waits on the lock for up to 30 seconds, long enough to read every command line and send the signal.
      const seen = await waitForTool(current.name, 'pg_dump');
      expect(seen.length, `${signal}: pg_dump runs`).toBeGreaterThan(0);
      expect(seen.some((line) => line.includes(source.backup)), `${signal}: password in a process argument`).toBe(false);
      expect(seen.some((line) => line.includes('pg_dump --dbname=postgres://foundation_backup@postgres:5432/foundation ')), signal).toBe(true);
      const sent = signal === 'stop'
        ? await command(['docker', 'stop', current.name], dockerEnv)
        : await command(['docker', 'kill', '--signal', signal, current.name], dockerEnv);
      expect(sent.code, signal).toBe(0);
      const result = await pending;
      current = undefined;
      expect(result.leaked).toBe(0);
      expect(lines(result.stdout)).toEqual([]);
      expect(lines(result.stderr)).toEqual(['Backup failed: interrupted']);
      expect(result.code, signal).toBe(code);
      // The .partial of the run is gone, and the 2 day leftover stays, so no retention ran.
      expect(await folderState(backupDir), signal).toBe(before);
    }
  } finally {
    // A run an assertion left behind is removed by name before the lock goes, so it never finishes a backup afterwards.
    if (current !== undefined) {
      await command(['docker', 'rm', '-f', current.name], dockerEnv);
      await current.pending.catch(() => undefined);
    }
    await unlock();
  }
  await expectTargetUnchanged();
}, 180_000);

test('BKP-006 backup with a DSN to database postgres fails Backup failed: wrong database', async () => {
  await expectBackupRejected('Backup failed: wrong database', { FOUNDATION_BACKUP_DATABASE_URL: dsn.sourcePostgres });
  await expectTargetUnchanged();
}, 120_000);

test('BKP-006 backup into a folder with mode 0755, into a file, or onto an existing name fails without touching any file', async () => {
  const open = join(folder, 'backups-0755');
  await mkdir(open);
  await chmod(open, 0o755);
  await expectBackupRejected('Backup directory must be mode 0700', { FOUNDATION_BACKUP_DIR: open }, open);
  const file = join(folder, 'backups-file');
  await writeFile(file, 'not a folder', { mode: 0o600 });
  await expectBackupRejected('Backup directory unavailable', { FOUNDATION_BACKUP_DIR: file }, file);

  // A manifest for every second from a few seconds ago to 60 seconds ahead on the clock of the container engine, which
  // names the run, so whatever second the run starts in, its name already exists. The run fails before it creates a
  // file and leaves every manifest in place.
  const now = await containerNow();
  const taken: string[] = [];
  for (let offset = -5; offset <= 60; offset += 1) {
    const name = `foundation-${stampOf(new Date(now + offset * 1_000))}-manual`;
    taken.push(name);
    await writeFile(join(backupDir, `${name}.json`), '{}\n', { mode: 0o600 });
  }
  try {
    const before = await folderState(backupDir);
    const result = await composeRun('backup', ['create', 'manual']);
    expect(result.leaked).toBe(0);
    expect(lines(result.stdout)).toEqual([]);
    const message = lines(result.stderr);
    expect(message).toHaveLength(1);
    const match = /^Backup already exists: (foundation-[0-9]{8}T[0-9]{6}Z-manual)$/.exec(message[0] ?? '');
    expect(match).not.toBeNull();
    expect(taken).toContain(match![1]!);
    expect(result.code).toBe(1);
    expect(await folderState(backupDir)).toBe(before);
  } finally {
    for (const name of taken) await rm(join(backupDir, `${name}.json`), { force: true });
  }
  await expectTargetUnchanged();
}, 180_000);

test('BKP-006 backup with a wrong argument fails with the usage line, and without FOUNDATION_BACKUP_DATABASE_URL fails Missing FOUNDATION_BACKUP_DATABASE_URL, each leaving the folder as it was', async () => {
  // covers: AC-3 (tabel Pesan script: argumen salah dan variable kosong, exit 1, tanpa file dan tanpa retensi)
  const usage = 'Usage: foundation-backup.sh create <scheduled|pre-migration|manual> | check';
  for (const args of [['create', 'weekly'], ['create', 'Manual'], ['create'], ['create', 'manual', 'extra'], ['backup'], ['check', 'extra']]) {
    const before = await folderState(backupDir);
    expectRejected(await composeRun('backup', args), usage);
    expect(await folderState(backupDir), args.join(' ')).toBe(before);
  }
  await expectBackupRejected('Missing FOUNDATION_BACKUP_DATABASE_URL', { FOUNDATION_BACKUP_DATABASE_URL: '' });
  await expectTargetUnchanged();
}, 120_000);

// Row 7 of *Urutan uji target*: retention and `check` in folders of their own, with ages from names computed from the
// current time; the target is not used. `retention` of restore.json holds the values of the first test.
test('BKP-007 create manual in a folder of aged backups keeps the 7 newest, removes complete backups older than 35 days and leftovers older than 24 hours in the order of *Retensi*, touches nothing else, and check then reports the new backup 0 h old', async () => {
  checks.retention = 'failed';
  const dir = await caseFolder('retention');
  const now = Date.now();
  // Ten complete scheduled backups 36 to 45 days old (one per day), two complete backups 1 and 34 days old, one set of 2
  // days without its manifest, one .partial with a 2 day stamp and mtime, notes.txt, the subfolder archive (holding an
  // old complete backup that retention never enters), and the symlink latest to one of the dumps.
  const old = Array.from({ length: 10 }, (_, index) => agedName(now, (36 + index) * DAY_MS));
  const recent = [agedName(now, DAY_MS, 'pre-migration'), agedName(now, 34 * DAY_MS, 'manual')];
  for (const name of [...old, ...recent]) await writeSet(dir, name);
  const incomplete = agedName(now, 2 * DAY_MS);
  await writeSet(dir, incomplete, ['dump', 'checksum']);
  const partial = `.${agedName(now, 2 * DAY_MS, 'manual')}.dump.partial`;
  await writeFile(join(dir, partial), 'partial', { mode: 0o600 });
  const twoDaysAgo = new Date(now - 2 * DAY_MS);
  await utimes(join(dir, partial), twoDaysAgo, twoDaysAgo);
  await writeFile(join(dir, 'notes.txt'), 'catatan operator\n', { mode: 0o600 });
  const archive = join(dir, 'archive');
  await mkdir(archive, { mode: 0o700 });
  await writeSet(archive, agedName(now, 45 * DAY_MS));
  await symlink(`${recent[0]}.dump`, join(dir, 'latest'));
  const before = await entries(dir);
  const archiveBefore = await folderState(archive);

  const created = await composeRun('backup', ['create', 'manual'], { FOUNDATION_BACKUP_DIR: dir });
  expect(created.leaked).toBe(0);
  expect(lines(created.stderr)).toEqual([]);
  expect(created.code).toBe(0);
  const output = lines(created.stdout);
  const match = /^Backup created: (foundation-[0-9]{8}T[0-9]{6}Z-manual)\.dump \([0-9]+ bytes, sha256 [0-9a-f]{64}\)$/.exec(output[0] ?? '');
  expect(match).not.toBeNull();
  const fresh = match![1]!;
  const after = await entries(dir);
  const kept = completeBackups(after);
  const keptFiles = new Set(kept.flatMap((name) => [`${name}.dump`, `${name}.dump.sha256`, `${name}.json`]));
  const reported = (prefix: string) => output.flatMap((line) => (line.startsWith(prefix) ? [line.slice(prefix.length)] : []));
  retentionEvidence = {
    kept,
    removed: reported('Backup removed: '),
    leftovers: reported('Leftover removed: '),
    untouched: after.map(([name]) => name).filter((name) => !keptFiles.has(name)),
  };

  // The exact values of BKP-007: six backups of 40 to 45 days removed in descending name order, then the .partial and
  // the two files of the incomplete set in name order; seven kept (the new one, 1, 34, 36, 37, 38, and 39 days).
  const removed = old.slice(4);
  const leftovers = [partial, `${incomplete}.dump`, `${incomplete}.dump.sha256`];
  expect(output).toEqual([output[0]!, ...removed.map((name) => `Backup removed: ${name}`), ...leftovers.map((file) => `Leftover removed: ${file}`)]);
  expect(retentionEvidence).toEqual({ kept: [fresh, ...recent, ...old.slice(0, 4)], removed, leftovers, untouched: ['archive', 'latest', 'notes.txt'] });

  // Every entry that stays is exactly as it was (type, size, mode, and mtime), the subfolder too, and the new files are 0600.
  const gone = new Set([...removed.flatMap((name) => [`${name}.dump`, `${name}.dump.sha256`, `${name}.json`]), ...leftovers]);
  const freshFiles = [`${fresh}.dump`, `${fresh}.dump.sha256`, `${fresh}.json`];
  expect(after.filter(([name]) => !freshFiles.includes(name))).toEqual(before.filter(([name]) => !gone.has(name)));
  for (const file of freshFiles) expect((await lstat(join(dir, file))).mode & 0o777).toBe(0o600);
  expect(await folderState(archive)).toBe(archiveBefore);

  // check on the same folder: the new backup is the newest complete one, its checksum matches, and it is 0 h old.
  const checked = await composeRun('backup', ['check'], { FOUNDATION_BACKUP_DIR: dir });
  expect(checked.leaked).toBe(0);
  expect(lines(checked.stderr)).toEqual([]);
  expect(lines(checked.stdout)).toEqual([`Latest backup: ${fresh} (0 h old)`]);
  expect(checked.code).toBe(0);
  checks.retention = 'passed';
}, 180_000);

test('BKP-007 retention reads the mtime of a .partial, keeps leftovers up to 24 hours and backups past 35 days within the newest 7, and never removes or prints a symlink, a subfolder, a .partial whose name create never writes, or another file', async () => {
  const previous = checks.retention;
  checks.retention = 'failed';
  const dir = await caseFolder('retention-edges');
  const now = Date.now();
  const fortyDaysAgo = new Date(now - 40 * DAY_MS);
  // Two complete backups 50 and 60 days old: with the new one there are three complete backups, so all of them stay.
  const aged = [agedName(now, 50 * DAY_MS), agedName(now, 60 * DAY_MS)];
  for (const name of aged) await writeSet(dir, name);
  // A .partial is aged by its mtime, not its name: an old stamp with a fresh mtime stays, a fresh stamp with a 2 day
  // mtime goes.
  const freshMtime = `.${agedName(now, 3 * DAY_MS, 'manual')}.dump.partial`;
  const oldMtime = `.${agedName(now, HOUR_MS, 'manual')}.json.partial`;
  for (const file of [freshMtime, oldMtime]) await writeFile(join(dir, file), 'partial', { mode: 0o600 });
  await utimes(join(dir, oldMtime), new Date(now - 2 * DAY_MS), new Date(now - 2 * DAY_MS));
  // Incomplete sets 1 hour old, and 1 day ahead of the clock (a negative age counts as 0), stay.
  const young = agedName(now, HOUR_MS);
  await writeSet(dir, young, ['manifest']);
  const ahead = agedName(now, -DAY_MS);
  await writeSet(dir, ahead, ['dump']);
  // A 40 day set whose dump is a symlink is not complete: its two regular files go, the symlink stays.
  const linked = agedName(now, 40 * DAY_MS);
  await writeSet(dir, linked, ['checksum', 'manifest']);
  await symlink(`${aged[0]}.dump`, join(dir, `${linked}.dump`));
  // Old entries outside the patterns stay: another reason, a hidden .partial not named .foundation-*, and a folder
  // named like a manifest.
  // A hidden .partial is removed only when its whole name is one that create writes. A name with line breaks, which
  // would print a forged `Backup created:` line into the scheduler log, and any other .foundation-*.partial stay.
  const forged = `.foundation-x\nBackup created: ${agedName(now, 2 * DAY_MS, 'manual')}.dump (1 bytes, sha256 ${'0'.repeat(64)})\n.partial`;
  const outside = ['.foundation-notes.partial', `.${agedName(now, 2 * DAY_MS, 'manual')}.tar.partial`, `.foundation-${stampOf(new Date(now - 2 * DAY_MS))}-weekly.dump.partial`];
  for (const file of [`foundation-${stampOf(fortyDaysAgo)}-weekly.dump`, '.other.partial', forged, ...outside]) {
    await writeFile(join(dir, file), 'other', { mode: 0o600 });
    await utimes(join(dir, file), fortyDaysAgo, fortyDaysAgo);
  }
  await mkdir(join(dir, `${agedName(now, 41 * DAY_MS)}.json`), { mode: 0o700 });
  const before = await entries(dir);

  const created = await composeRun('backup', ['create', 'manual'], { FOUNDATION_BACKUP_DIR: dir });
  expect(created.leaked).toBe(0);
  expect(lines(created.stderr)).toEqual([]);
  expect(created.code).toBe(0);
  const output = lines(created.stdout);
  const fresh = /^Backup created: (foundation-[0-9]{8}T[0-9]{6}Z-manual)\.dump \([0-9]+ bytes, sha256 [0-9a-f]{64}\)$/.exec(output[0] ?? '')?.[1];
  expect(fresh).toMatch(BACKUP_NAME);
  const leftovers = [oldMtime, `${linked}.dump.sha256`, `${linked}.json`];
  expect(output.slice(1)).toEqual(leftovers.map((file) => `Leftover removed: ${file}`));
  expect(output.filter((line) => line.startsWith('Backup created: '))).toHaveLength(1);
  const after = await entries(dir);
  expect(completeBackups(after)).toEqual([fresh!, ...aged]);
  const freshFiles = [`${fresh}.dump`, `${fresh}.dump.sha256`, `${fresh}.json`];
  expect(after.filter(([name]) => !freshFiles.includes(name))).toEqual(before.filter(([name]) => !leftovers.includes(name)));
  checks.retention = previous;
}, 180_000);

test('BKP-007 check reports the newest complete backup: the folder rules first, then the checksum before the age, and at most 26 hours', async () => {
  const previous = checks.retention;
  checks.retention = 'failed';
  const now = Date.now();
  /** One check of `path`, which must leave it exactly as it was: check never writes. */
  const check = async (path: string): Promise<Result> => {
    const before = await folderState(path);
    const result = await composeRun('backup', ['check'], { FOUNDATION_BACKUP_DIR: path });
    expect(await folderState(path)).toBe(before);
    return result;
  };

  // The folder: empty, mode 0755 (with a valid backup inside), and a file in place of a folder.
  expectRejected(await check(await caseFolder('check-empty')), 'No backup found');
  const open = await caseFolder('check-0755', 0o755);
  await writeSet(open, agedName(now, HOUR_MS));
  expectRejected(await check(open), 'Backup directory must be mode 0700');
  const file = join(folder, 'check-file');
  await writeFile(file, 'not a folder', { mode: 0o600 });
  expectRejected(await check(file), 'Backup directory unavailable');

  // The newest complete backup is 27 hours old, so too old; a newer incomplete set and a .partial do not count.
  const stale = await caseFolder('check-27h');
  const staleName = agedName(now, 27 * HOUR_MS);
  await writeSet(stale, agedName(now, 30 * HOUR_MS));
  await writeSet(stale, staleName);
  await writeSet(stale, agedName(now, HOUR_MS), ['dump', 'checksum']);
  await writeFile(join(stale, `.${agedName(now, 0, 'manual')}.dump.partial`), 'partial', { mode: 0o600 });
  expectRejected(await check(stale), `Latest backup too old: ${staleName} (27 h old)`);

  // 25.5 hours is within the 26 hour limit, and the hours are rounded down.
  const recent = await caseFolder('check-25h');
  const recentName = agedName(now, 25.5 * HOUR_MS);
  await writeSet(recent, recentName);
  const passed = await check(recent);
  expect(passed.leaked).toBe(0);
  expect(lines(passed.stderr)).toEqual([]);
  expect(lines(passed.stdout)).toEqual([`Latest backup: ${recentName} (25 h old)`]);
  expect(passed.code).toBe(0);

  // The checksum comes before the age: a changed dump, a checksum file naming another dump with the right hash for
  // that dump (which sha256sum --check alone accepts), and a changed dump that is also 27 hours old.
  const corrupt = await caseFolder('check-corrupt');
  const corruptName = agedName(now, HOUR_MS);
  await writeSet(corrupt, corruptName);
  await writeFile(join(corrupt, `${corruptName}.dump`), 'changed bytes\n');
  expectRejected(await check(corrupt), `Backup checksum mismatch: ${corruptName}`);
  const wrong = await caseFolder('check-wrong-file');
  const otherName = agedName(now, 2 * HOUR_MS);
  const wrongName = agedName(now, HOUR_MS);
  await writeSet(wrong, otherName);
  await writeSet(wrong, wrongName, ['dump', 'manifest']);
  await copyFile(join(wrong, `${otherName}.dump.sha256`), join(wrong, `${wrongName}.dump.sha256`));
  expectRejected(await check(wrong), `Backup checksum mismatch: ${wrongName}`);
  const staleCorrupt = await caseFolder('check-27h-corrupt');
  const staleCorruptName = agedName(now, 27 * HOUR_MS);
  await writeSet(staleCorrupt, staleCorruptName);
  await writeFile(join(staleCorrupt, `${staleCorruptName}.dump`), 'changed bytes\n');
  expectRejected(await check(staleCorrupt), `Backup checksum mismatch: ${staleCorruptName}`);
  checks.retention = previous;
}, 180_000);

/** One `check` of `path` through the Compose service, which must leave the folder exactly as it was: check never writes. */
async function checkFolder(path: string): Promise<Result> {
  const before = await folderState(path);
  const result = await composeRun('backup', ['check'], { FOUNDATION_BACKUP_DIR: path });
  expect(await folderState(path)).toBe(before);
  return result;
}

test('BKP-007 check counts only complete backups of three regular files with a name of the pattern: incomplete sets, a .partial, a set with a symlinked manifest, and another reason give No backup found', async () => {
  // covers: AC-7 (tabel Check langkah 2: backup terbaru di antara backup lengkap; tanpa backup lengkap `No backup found`)
  const previous = checks.retention;
  checks.retention = 'failed';
  const now = Date.now();
  const dir = await caseFolder('check-incomplete');
  await writeSet(dir, agedName(now, HOUR_MS), ['dump', 'checksum']);
  await writeSet(dir, agedName(now, 2 * HOUR_MS), ['checksum', 'manifest']);
  await writeFile(join(dir, `.${agedName(now, 0, 'manual')}.dump.partial`), 'partial', { mode: 0o600 });
  await writeFile(join(dir, 'notes.txt'), 'catatan operator\n', { mode: 0o600 });
  const linked = agedName(now, 3 * HOUR_MS);
  await writeSet(dir, linked, ['dump', 'checksum']);
  await symlink('notes.txt', join(dir, `${linked}.json`));
  await writeSet(dir, `foundation-${stampOf(new Date(now - HOUR_MS))}-weekly`);
  expectRejected(await checkFolder(dir), 'No backup found');
  checks.retention = previous;
}, 120_000);

test('BKP-007 a backup name whose stamp is not a valid date stops retention with Retention failed after Backup created, keeps the new backup complete, removes nothing, and fails check with Backup failed: internal', async () => {
  // covers: AC-7 (Retensi langkah 7: kegagalan menghentikan retensi dengan `Retention failed` dan exit 1, backup baru
  // tetap lengkap), AC-3 (`Retention failed` dan `internal` dengan komponen nyata, seperti dicatat docs/rules/backup.md)
  const previous = checks.retention;
  checks.retention = 'failed';
  // Month 13, day 99, year 9999: it matches the name pattern, sorts after every real stamp, and is no date.
  const invalid = 'foundation-99991399T000000Z-manual';
  const dir = await caseFolder('retention-invalid-stamp');
  await writeSet(dir, invalid, ['dump']);
  const before = await entries(dir);
  const created = await composeRun('backup', ['create', 'manual'], { FOUNDATION_BACKUP_DIR: dir });
  expect(created.leaked).toBe(0);
  const output = lines(created.stdout);
  expect(output).toHaveLength(1);
  const fresh = /^Backup created: (foundation-[0-9]{8}T[0-9]{6}Z-manual)\.dump \([0-9]+ bytes, sha256 [0-9a-f]{64}\)$/.exec(output[0] ?? '')?.[1];
  expect(fresh).toMatch(BACKUP_NAME);
  expect(lines(created.stderr)).toEqual(['Retention failed']);
  expect(created.code).toBe(1);
  // The new backup stays complete and 0600; every other entry, the leftover with the invalid stamp included, is unchanged.
  const after = await entries(dir);
  expect(completeBackups(after)).toEqual([fresh!]);
  const freshFiles = [`${fresh}.dump`, `${fresh}.dump.sha256`, `${fresh}.json`];
  for (const file of freshFiles) expect((await lstat(join(dir, file))).mode & 0o777, file).toBe(0o600);
  expect(after.filter(([name]) => !freshFiles.includes(name))).toEqual(before);

  // check: the newest complete backup has that name and a matching checksum, but its age cannot be computed.
  const checkDir = await caseFolder('check-invalid-stamp');
  await writeSet(checkDir, agedName(Date.now(), HOUR_MS));
  await writeSet(checkDir, invalid);
  expectRejected(await checkFolder(checkDir), 'Backup failed: internal');
  checks.retention = previous;
}, 120_000);

// After every row of *Urutan uji target*: the target is no longer compared with the source, so this last test may write
// to it, and it removes what it wrote, proven by the source fingerprint at its end.
test('BKP-004 the fingerprint lists tables and sequences from the catalog, a new schema and quoted names included and partitions left out, and keeps every digest under other session settings of the backup role', async () => {
  // covers: AC-5 (Value sourcing Fingerprint: daftar tabel dan sequence dari katalog, identifier di quote server,
  // pengaturan sesi tetap lewat SET LOCAL)
  const previous = checks.fingerprint;
  checks.fingerprint = 'failed';
  const source = JSON.parse(sourceFingerprint) as FingerprintOutput;
  const fixtureDigest = source.tables.find((table) => table.schema === 'users' && table.name === 'restore_fixture')?.digest;
  expect(fixtureDigest).toMatch(/^-?[0-9]+$/);
  const odd = 'Odd "name"; x';
  const settings = ["TimeZone = 'Asia/Jakarta'", "DateStyle = 'SQL, DMY'", "IntervalStyle = 'sql_standard'", 'extra_float_digits = 0', "bytea_output = 'escape'"];
  try {
    await withPool(targetCluster!.adminUrl, async (sql) => {
      for (const statement of [
        'CREATE SCHEMA fingerprint_probe',
        'CREATE TABLE fingerprint_probe.items (id integer)',
        'INSERT INTO fingerprint_probe.items VALUES (1), (2), (3)',
        'CREATE TABLE fingerprint_probe.parts (k integer) PARTITION BY RANGE (k)',
        'CREATE TABLE fingerprint_probe.parts_low PARTITION OF fingerprint_probe.parts FOR VALUES FROM (0) TO (10)',
        'INSERT INTO fingerprint_probe.parts VALUES (1), (2)',
        'CREATE TABLE fingerprint_probe."Odd ""name""; x" (id integer)',
        'INSERT INTO fingerprint_probe."Odd ""name""; x" VALUES (1)',
        'CREATE SEQUENCE fingerprint_probe.counter',
        "SELECT pg_catalog.nextval('fingerprint_probe.counter'), pg_catalog.nextval('fingerprint_probe.counter')",
      ]) await sql.unsafe(statement);
    });
    const probed = await fingerprintRun(['--digest'], targetCluster!.backupUrl);
    expect(probed.stderr).toBe('');
    expect(probed.code).toBe(0);
    const listed = JSON.parse(probed.stdout) as FingerprintOutput;
    // The new schema joins without a code change: the partitioned table with the rows of its partition, the partition
    // itself left out, and the quoted name read as it is. The tables of the source keep their rows and digests.
    expect(listed.tables.map(({ schema, name, rows }) => ({ schema, name, rows }))).toEqual([
      ...source.tables.map(({ schema, name, rows }) => ({ schema, name, rows })),
      { schema: 'fingerprint_probe', name: odd, rows: '1' },
      { schema: 'fingerprint_probe', name: 'items', rows: '3' },
      { schema: 'fingerprint_probe', name: 'parts', rows: '2' },
    ].sort(catalogOrder));
    for (const table of source.tables) {
      expect(listed.tables.find((entry) => entry.schema === table.schema && entry.name === table.name)?.digest, `${table.schema}.${table.name}`).toBe(table.digest);
    }
    expect(listed.sequences).toEqual([...source.sequences, { schema: 'fingerprint_probe', name: 'counter', lastValue: '2', isCalled: true }].sort(catalogOrder));
    expect(listed.migrations).toEqual(source.migrations);

    // Other session settings of the backup role change how rows print as text, so they would change the digest without
    // the SET LOCAL of the fingerprint; with it the whole output stays the same.
    await withPool(targetCluster!.adminUrl, async (sql) => {
      for (const setting of settings) await sql.unsafe(`ALTER ROLE foundation_backup IN DATABASE foundation SET ${setting}`);
    });
    const zone = await withPool(targetCluster!.backupUrl, async (sql) => (await sql`SELECT current_setting('TimeZone') AS zone`)[0] as { zone: string });
    expect(zone.zone).toBe('Asia/Jakarta');
    const settled = await fingerprintRun(['--digest'], targetCluster!.backupUrl);
    expect(settled.stderr).toBe('');
    expect(settled.code).toBe(0);
    expect(settled.stdout).toBe(probed.stdout);
    // Control: the digest query itself under those settings gives another value, so the equality above is not vacuous.
    const control = await withPool(targetCluster!.adminUrl, (sql) => sql.begin(async (tx) => {
      for (const setting of settings) await tx.unsafe(`SET LOCAL ${setting}`);
      const [row] = await tx.unsafe('SELECT coalesce(sum(hashtextextended(t::text, 0)::numeric), 0)::text AS digest FROM users.restore_fixture AS t');
      return String((row as { digest: string }).digest);
    }));
    expect(control).not.toBe(fixtureDigest);
  } finally {
    await withPool(targetCluster!.adminUrl, async (sql) => {
      for (const setting of settings) await sql.unsafe(`ALTER ROLE foundation_backup IN DATABASE foundation RESET ${setting.split(' ')[0]}`);
      await sql.unsafe('DROP SCHEMA IF EXISTS fingerprint_probe CASCADE');
    });
  }
  // Everything written above is gone again: the target gives the source fingerprint once more.
  await expectTargetUnchanged();
  checks.fingerprint = previous;
}, 120_000);
