import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcessGroup } from '../../scripts/lib/process-group.ts';
import { readinessContainerLabelsAccepted, readinessContainerMissing, readinessNameAccepted } from './readiness-container.ts';

// `bun run test:database:real`: builds the frontend, runs the database suite against isolated PostgreSQL 18 containers,
// and scans its JUnit report and the bundle for the random credentials. This file lives in tests/, not scripts/,
// because it removes the READY-008 container itself and INFRA-001 of spec 0002 keeps scripts/ free of Docker
// (spec 0006, rationale decision 58).
const root = resolve(import.meta.dir, '../..');
const evidence = resolve(root, '.local/feature-5');
const junit = resolve(evidence, 'database.xml');
const bundle = resolve(root, 'apps/frontend/dist/frontend');
const seed = randomBytes(32).toString('hex');
const [adminPassword, migratorPassword, backendPassword] = ['admin', 'migrator', 'backend'].map((role) => createHmac('sha256', seed).update(role).digest('hex')) as [string, string, string];
const adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:1/foundation`;
const migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:1/foundation`;
const backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:1/foundation`;
const secrets = [seed, adminPassword, migratorPassword, backendPassword, adminUrl, migratorUrl, backendUrl];
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
 * `graceMs` is the wait after SIGTERM before SIGKILL; the default of `runProcessGroup` (5000 ms) when absent.
 */
async function run(command: string[], env: Record<string, string>, options: { graceMs?: number } = {}) {
  if (interrupt.signal.aborted) throw new Error('Interrupted');
  const result = await runProcessGroup(command, {
    cwd: root, env, timeoutMs: 300000, output: 'pipe', signal: interrupt.signal, graceMs: options.graceMs,
  });
  if (interrupt.signal.aborted) throw new Error('Interrupted');
  return { code: result.code, timedOut: result.timedOut, output: safeOutput(result.stdout + result.stderr) };
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

try {
  await mkdir(evidence, { recursive: true });
  const built = await run([process.execPath, 'run', 'build:frontend'], {
    ...baseEnv,
    DATABASE_URL: backendUrl,
    FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
    FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
    FOUNDATION_MIGRATOR_PASSWORD: migratorPassword,
    FOUNDATION_BACKEND_PASSWORD: backendPassword,
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
  const tests = await run([process.execPath, '--no-env-file', 'test', './tests/integration/database', '--reporter=junit', `--reporter-outfile=${junit}`], {
    ...baseEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch, FOUNDATION_TEST_SECRET_SEED: seed, FOUNDATION_READINESS_DB_CONTAINER: readinessContainer,
  }, { graceMs: 75_000 });
  console.log(tests.output.trim());
  if (tests.timedOut) throw new Error('Database integration tests exceeded 300 seconds');
  const paths = [junit, ...await filesUnder(bundle)];
  const findings: string[] = [];
  for (const path of paths) {
    const data = await readFile(path);
    if (secrets.some((secret) => data.includes(Buffer.from(secret)))) findings.push(path.slice(root.length + 1));
  }
  const report = {
    filesScanned: paths.length,
    secretsChecked: secrets.length,
    junitSha256: createHash('sha256').update(await readFile(junit)).digest('hex'),
    frontendBundleFiles: paths.length - 1,
    findings,
  };
  await writeFile(resolve(evidence, 'artifact-scan.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (findings.length) throw new Error('Database test credential found in JUnit or frontend bundle');
  if (tests.code !== 0) throw new Error('Database integration tests failed');
  console.log(`Database artifact scan passed: ${report.secretsChecked} random values absent from ${report.filesScanned} files.`);
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
}

for (const [signal, handler] of handlers) process.off(signal, handler);
if (failure !== undefined) console.error(failure);
if (received !== undefined) process.exitCode = signalCodes[received];
else if (failure !== undefined) process.exitCode = 1;
