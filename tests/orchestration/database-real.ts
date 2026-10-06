import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcessGroup } from '../../scripts/lib/process-group.ts';
import { databaseAccountPasswordLabels } from './auth-accounts.ts';
import { readinessContainerLabelsAccepted, readinessContainerMissing, readinessNameAccepted } from './readiness-container.ts';
import { restoreEvidenceFailure } from './restore-evidence.ts';
import {
  createTokenFingerprintStore,
  readFingerprints,
  removeTokenFingerprintStore,
  tokenMatches,
  tokenScanControl,
  type TokenFingerprintStore,
} from './token-fingerprints.ts';

// `bun run test:database:real`: builds the frontend, runs the database suite against isolated PostgreSQL 18 containers,
// and scans its JUnit report, the restore evidence of spec 0013, and the bundle for the random credentials and, through
// the token fingerprints of spec 0014 (*Sidik token uji*), for every session token and CSRF token the suites obtained.
// This file
// lives in tests/, not scripts/, because it removes the READY-008 container itself and INFRA-001 of spec 0002 keeps
// scripts/ free of Docker (spec 0006, rationale decision 58).
const root = resolve(import.meta.dir, '../..');
const evidence = resolve(root, '.local/feature-5');
const junit = resolve(evidence, 'database.xml');
// Spec 0013 (*Isi restore.json*, *Perubahan database-real.ts*): written by tests/integration/database/backup.test.ts and
// declared as required evidence of kind `data` of this step in scripts/lib/gate.ts (RESTORE_EVIDENCE).
const restoreEvidence = resolve(root, '.local/feature-14/restore.json');
const bundle = resolve(root, 'apps/frontend/dist/frontend');
const seed = randomBytes(32).toString('hex');
const password = (label: string) => createHmac('sha256', seed).update(label).digest('hex');
const [adminPassword, migratorPassword, backendPassword] = ['admin', 'migrator', 'backend'].map(password) as [string, string, string];
// *Label secret* of spec 0013: the backup role of the source, and the four roles of the restore target.
const backupPassword = password('backup');
const [restoreAdminPassword, restoreMigratorPassword, restoreBackendPassword, restoreBackupPassword] = ['restore-admin', 'restore-migrator', 'restore-backend', 'restore-backup'].map(password) as [string, string, string, string];
const adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:1/foundation`;
const migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:1/foundation`;
const backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:1/foundation`;
const backupUrl = `postgres://foundation_backup:${backupPassword}@127.0.0.1:1/foundation`;
const restoreUrls = [
  `postgres://foundation_admin:${restoreAdminPassword}@127.0.0.1:1/foundation`,
  `postgres://foundation_migrator:${restoreMigratorPassword}@127.0.0.1:1/foundation`,
  `postgres://foundation_backend:${restoreBackendPassword}@127.0.0.1:1/foundation`,
  `postgres://foundation_backup:${restoreBackupPassword}@127.0.0.1:1/foundation`,
];
// Spec 0014 (AC-10): the account passwords of the database suites, from the labels the suites use with the same seed.
const accountPasswords = databaseAccountPasswordLabels().map(password);
const secrets = [
  seed, adminPassword, migratorPassword, backendPassword, backupPassword,
  restoreAdminPassword, restoreMigratorPassword, restoreBackendPassword, restoreBackupPassword,
  adminUrl, migratorUrl, backendUrl, backupUrl, ...restoreUrls, ...accountPasswords,
];
const safeOutput = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
// READY-008 container of this run (spec 0006, *Nama dan penjaga container*). It is named here and passed to bun test,
// so every exit path below can remove it through the guard even when bun test was stopped before its afterAll ran.
const readinessContainer = `foundation-readiness-db-${randomBytes(4).toString('hex')}`;

// SIGINT and SIGTERM stop the bun test process group (with the backend it started) instead of ending this script at
// once, so the cleanup below still runs; the script then exits 130 or 143.
const signalCodes = { SIGINT: 130, SIGTERM: 143 } as const;
type HandledSignal = keyof typeof signalCodes;
const interrupt = new AbortController();
let received: HandledSignal | undefined;
const handlers = (Object.keys(signalCodes) as HandledSignal[]).map((signal) => {
  const handler = () => {
    received ??= signal;
    interrupt.abort();
  };
  process.on(signal, handler);
  return [signal, handler] as const;
});

/**
 * Runs one step as the leader of its own process group, so a timeout or an interrupt stops every process it started.
 * `timeoutMs` is the limit of the step, 300000 ms when absent (the frontend build); `bun test` passes 900000 ms
 * (spec 0013, *Perubahan database-real.ts*, raised by spec 0014 for the auth suite and BKP-009). `graceMs` is the wait after SIGTERM before SIGKILL; the default of
 * `runProcessGroup` (5000 ms) when absent.
 */
async function run(command: string[], env: Record<string, string>, options: { graceMs?: number; timeoutMs?: number } = {}) {
  if (interrupt.signal.aborted) throw new Error('Interrupted');
  const result = await runProcessGroup(command, {
    cwd: root, env, timeoutMs: options.timeoutMs ?? 300_000, output: 'pipe', signal: interrupt.signal, graceMs: options.graceMs,
  });
  if (interrupt.signal.aborted) throw new Error('Interrupted');
  return { code: result.code, timedOut: result.timedOut, output: safeOutput(result.stdout + result.stderr) };
}

/** The bytes of `path` when it is a regular file, `undefined` when it is missing or anything else. */
async function regularFile(path: string): Promise<Buffer | undefined> {
  try {
    return (await lstat(path)).isFile() ? await readFile(path) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filesUnder(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

/**
 * Removes the READY-008 container of this run through the guard of tests/orchestration/readiness-container.ts with owner
 * 'database': (1) the name pattern before Docker is called, (2) `docker container inspect`, where only Docker's
 * missing answer counts as already removed (the afterAll of READY-008 removes it on a normal run), and (3) the labels.
 * Only then `docker rm -f` runs. Docker is called with an argument array, never through a shell.
 */
async function removeReadinessContainer(env: Record<string, string>): Promise<void> {
  if (!readinessNameAccepted('database', readinessContainer)) throw new Error('Readiness container guard rejected the container name');
  const inspected = await runProcessGroup(['docker', 'container', 'inspect', '--format', '{{json .Config.Labels}}', readinessContainer], {
    cwd: root, env, timeoutMs: 30_000, output: 'pipe',
  });
  if (inspected.code !== 0) {
    if (readinessContainerMissing(inspected.code, inspected.stderr)) return;
    throw new Error('Readiness container guard could not inspect the container');
  }
  let labels: unknown;
  try {
    labels = JSON.parse(inspected.stdout) as unknown;
  } catch {
    labels = undefined;
  }
  if (!readinessContainerLabelsAccepted(labels)) throw new Error('Readiness container guard rejected the container labels');
  const removed = await runProcessGroup(['docker', 'rm', '-f', readinessContainer], { cwd: root, env, timeoutMs: 60_000, output: 'pipe' });
  if (removed.code !== 0) throw new Error('Readiness container removal failed');
}

const baseEnv: Record<string, string> = {};
for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
  const value = process.env[key];
  if (value) baseEnv[key] = value;
}
let scratch = '';
let failure: string | undefined;
// The fingerprint folder of *Sidik token uji*: outside .local/ and the scratch folder, removed on every exit path after
// the scan. tests/orchestration/signal-cleanup.ts is not imported here (see below), so this script removes it itself.
let tokens: TokenFingerprintStore | null = null;

try {
  await mkdir(evidence, { recursive: true });
  // A restore.json of an earlier run never counts for this one (spec 0013, *Perubahan database-real.ts*).
  await rm(restoreEvidence, { force: true });
  const built = await run([process.execPath, 'run', 'build:frontend'], {
    ...baseEnv,
    DATABASE_URL: backendUrl,
    FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
    FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
    FOUNDATION_MIGRATOR_PASSWORD: migratorPassword,
    FOUNDATION_BACKEND_PASSWORD: backendPassword,
    FOUNDATION_BACKUP_PASSWORD: backupPassword,
    FOUNDATION_BACKUP_DATABASE_URL: backupUrl,
  });
  if (built.code !== 0) throw new Error('Frontend build failed before database artifact scan');
  console.log('Frontend build for database artifact scan passed.');
  await rm(junit, { force: true });
  // Temporary files of the database tests (for example the PostgreSQL env file with a random password) go to a folder
  // this script owns and removes on every exit path, even when bun test never reached its own cleanup.
  scratch = await mkdtemp(join(tmpdir(), 'foundation-database-real-'));
  // The bun test group gets 75000 ms after SIGTERM (spec 0010, row *Pembersihan sinyal suite nyata*): the 60000 ms limit
  // of tests/orchestration/signal-cleanup.ts plus 15000 ms, so bun test, the Docker clients the signal stopped, and the
  // READY-008 backend can exit before SIGKILL. That module is not imported here, because importing it installs its
  // signal handlers in this process.
  // The backup suite of spec 0013 (BKP-003 to BKP-007), the auth suite, and BKP-009 of spec 0014 need up to 900000 ms
  // together, so bun test gets that limit; the 75000 ms grace stays.
  tokens = await createTokenFingerprintStore('foundation-database-tokens-');
  const tests = await run([process.execPath, '--no-env-file', 'test', './tests/integration/database', '--reporter=junit', `--reporter-outfile=${junit}`], {
    ...baseEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch, FOUNDATION_TEST_SECRET_SEED: seed, FOUNDATION_READINESS_DB_CONTAINER: readinessContainer,
    ...tokens.env,
  }, { graceMs: 75_000, timeoutMs: 900_000 });
  console.log(tests.output.trim());
  if (tests.timedOut) throw new Error('Database integration tests exceeded 900 seconds');
  // JUnit, restore.json when bun test wrote it, and every file of the frontend bundle are scanned for every value above
  // and, by fingerprint, for every token the suites obtained; the output of bun test and the report itself too.
  const fingerprints = await readFingerprints(tokens);
  const controlPassed = await tokenScanControl(tokens);
  const store = tokens;
  const tokenFound = (data: Uint8Array | string) => tokenMatches(data, store.key, fingerprints) > 0;
  const restore = await regularFile(restoreEvidence);
  const bundleFiles = await filesUnder(bundle);
  const paths = [junit, ...(restore === undefined ? [] : [restoreEvidence]), ...bundleFiles];
  const findings: string[] = [];
  if (tokenFound(tests.output)) findings.push('bun test output token');
  for (const path of paths) {
    const data = path === restoreEvidence && restore !== undefined ? restore : await readFile(path);
    if (secrets.some((secret) => data.includes(Buffer.from(secret)))) findings.push(path.slice(root.length + 1));
    else if (tokenFound(data)) findings.push(`${path.slice(root.length + 1)} token`);
  }
  const report = {
    filesScanned: paths.length,
    secretsChecked: secrets.length,
    tokenFingerprints: fingerprints.size,
    tokenScanControl: controlPassed,
    junitSha256: createHash('sha256').update(await readFile(junit)).digest('hex'),
    frontendBundleFiles: bundleFiles.length,
    findings,
  };
  const reportPath = resolve(evidence, 'artifact-scan.json');
  if (tokenFound(`${JSON.stringify(report, null, 2)}\n`)) findings.push(`${reportPath.slice(root.length + 1)} token`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (findings.length) throw new Error('Database test credential or token found in output, JUnit, restore evidence, or frontend bundle');
  if (tests.code !== 0) throw new Error('Database integration tests failed');
  // The suites signed in, so the mechanism ran: an empty set means a token was never fingerprinted.
  if (fingerprints.size === 0) throw new Error('Token fingerprints missing after the database suites');
  if (!controlPassed) throw new Error('Token scan control failed');
  // `Restore evidence missing` or `Restore evidence not passed` (tests/orchestration/restore-evidence.ts).
  const restoreFailure = restoreEvidenceFailure(restore);
  if (restoreFailure !== undefined) throw new Error(restoreFailure);
  console.log(`Database artifact scan passed: ${report.secretsChecked} random values and ${report.tokenFingerprints} token fingerprints absent from ${report.filesScanned} files.`);
  console.log('Restore evidence passed.');
} catch (error) {
  failure = (error as Error).message;
} finally {
  // Every exit path: the bun test group is already gone (runProcessGroup settles only then), so remove the READY-008
  // container through the guard and the temporary folder.
  try {
    await removeReadinessContainer(baseEnv);
  } catch (error) {
    failure ??= (error as Error).message;
  }
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  // The fingerprint folder goes on every exit path, after the scan.
  await removeTokenFingerprintStore(tokens).catch(() => {
    failure ??= 'Token fingerprint folder removal failed';
  });
}

for (const [signal, handler] of handlers) process.off(signal, handler);
if (failure !== undefined) console.error(failure);
if (received !== undefined) process.exitCode = signalCodes[received];
else if (failure !== undefined) process.exitCode = 1;
