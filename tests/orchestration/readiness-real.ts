import { SQL } from 'bun';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listeners } from '../../scripts/lib/ports.ts';
import { runProcessGroup, type ProcessGroupResult } from '../../scripts/lib/process-group.ts';
import {
  READINESS_RUN_LABEL_ARGS,
  readinessContainerLabelsAccepted,
  readinessContainerMissing,
  readinessImageLabelsAccepted,
  readinessNameAccepted,
} from './readiness-container.ts';

// `bun run test:readiness:real` (spec 0006, READY-009, AC-2, AC-7, AC-8, and AC-10): starts an isolated PostgreSQL 18
// from foundation-postgres:18-pinned, provisions and migrates it with random credentials, starts the real backend and
// the development frontend on ports 8888 and 8889, runs playwright.real.config.ts, then stops everything and scans
// every output and artifact for the credential values. Every child process runs through runProcessGroup as the leader
// of its own group, with an explicit allow list environment and no .env file, and every exit path stops the groups
// and removes the container through the guard of tests/orchestration/readiness-container.ts with owner 'browser'.
// Output is fixed text, plus Playwright output and service output tails with every credential value redacted. This file
// lives in tests/, not scripts/, because INFRA-001 of spec 0002 keeps scripts/ free of Docker (rationale, decision 58).

const root = resolve(import.meta.dir, '../..');
const evidence = resolve(root, '.local/feature-10');
const junit = resolve(evidence, 'playwright-real.xml');
const outputDir = resolve(evidence, 'test-results');
const scanReport = resolve(evidence, 'artifact-scan.json');
const image = 'foundation-postgres:18-pinned';
const backendPort = 8888;
const frontendPort = 8889;
const containerName = `foundation-readiness-${randomBytes(4).toString('hex')}`;
const [adminPassword, migratorPassword, backendPassword] = Array.from({ length: 3 }, () => randomBytes(24).toString('hex')) as [string, string, string];
const secrets: string[] = [adminPassword, migratorPassword, backendPassword];
const redacted = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);

// Environments of spec 0006 (*Environment proses anak*).
const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI'];
const pick = (keys: string[]): Record<string, string> =>
  Object.fromEntries(keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
const baseEnv = pick(BASE_ENV_KEYS);
const dockerEnv = pick([...BASE_ENV_KEYS, 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']);
const pathEnv = { PATH: process.env['PATH'] ?? '' };

class Failure extends Error {}

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
const services = new AbortController();
interrupt.signal.addEventListener('abort', () => services.abort(), { once: true });

/** Runs one short command as its own process group, with output collected, and stops it on interrupt. */
async function run(argv: string[], env: Record<string, string>, timeoutMs: number): Promise<ProcessGroupResult> {
  if (interrupt.signal.aborted) throw new Failure('Interrupted');
  return runProcessGroup(argv, { cwd: root, env, timeoutMs, output: 'pipe', signal: interrupt.signal });
}

/** A loopback port that was free a moment ago, from a temporary server on port 0 that is closed at once. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Failure('No free loopback port');
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
 * The guard of spec 0006 (*Nama dan penjaga container*), in order: (1) the name matches the 'browser' pattern before
 * Docker is called, (2) `docker container inspect` succeeds, and (3) its labels pass readinessContainerLabelsAccepted.
 * Only then `docker rm -f` runs. A container Docker reports as missing (one `docker run` never created) is left alone;
 * any other inspect failure, such as an unreachable daemon or a timeout, fails with a fixed message. Cleanup runs even
 * after an interrupt, so it does not use the interrupt signal.
 */
async function removeContainer(): Promise<void> {
  if (!readinessNameAccepted('browser', containerName)) throw new Failure('Readiness container guard rejected the container name');
  const inspected = await runProcessGroup(['docker', 'container', 'inspect', '--format', '{{json .Config.Labels}}', containerName], {
    cwd: root, env: dockerEnv, timeoutMs: 30_000, output: 'pipe',
  });
  if (inspected.code !== 0) {
    if (readinessContainerMissing(inspected.code, inspected.stderr)) return;
    throw new Failure('Readiness container guard could not inspect the container');
  }
  if (!readinessContainerLabelsAccepted(parsedLabels(inspected.stdout))) throw new Failure('Readiness container guard rejected the container labels');
  const removed = await runProcessGroup(['docker', 'rm', '-f', containerName], { cwd: root, env: dockerEnv, timeoutMs: 60_000, output: 'pipe' });
  if (removed.code !== 0) throw new Failure('Readiness container removal failed');
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await Bun.sleep(intervalMs)) {
    if (interrupt.signal.aborted) throw new Failure('Interrupted');
    if (await check()) return true;
  }
  return false;
}

async function answers200(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await filesUnder(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

const tail = (text: string) => redacted(text).trimEnd().split('\n').slice(-40).join('\n');

let directory = '';
let containerCreated = false;
let failure: string | undefined;
let playwright: ProcessGroupResult | undefined;
const outputs: [string, string][] = [];
const runningServices: Promise<ProcessGroupResult>[] = [];
const serviceResults = new Map<string, ProcessGroupResult>();

try {
  await mkdir(evidence, { recursive: true });
  // A report or artifact of an earlier run must never be scanned or read as this run's result.
  await rm(junit, { force: true });
  await rm(outputDir, { recursive: true, force: true });
  await rm(scanReport, { force: true });

  // Ports 8888 and 8889 must be free; nothing that already listens there is stopped.
  for (const port of [backendPort, frontendPort]) {
    if ((await listeners(port)).length > 0) throw new Failure(`Port ${port} is in use; stop that process before test:readiness:real`);
  }

  // Image check of spec 0006 (*Pemeriksaan image sebelum `docker run`*), before any container exists.
  const inspectedImage = await run(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', image], dockerEnv, 30_000);
  if (inspectedImage.code !== 0) throw new Failure('Isolated PostgreSQL 18 image unavailable');
  if (!readinessImageLabelsAccepted(parsedLabels(inspectedImage.stdout))) {
    throw new Failure('Readiness container guard would reject containers from foundation-postgres:18-pinned');
  }

  // A fixed loopback host port and no --rm, so docker start in the browser flow reuses the same address.
  directory = await mkdtemp(resolve(tmpdir(), 'foundation-readiness-real-'));
  const envFile = resolve(directory, 'postgres.env');
  await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
  const hostPort = await freePort();
  const adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${hostPort}/foundation`;
  const migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${hostPort}/foundation`;
  const backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:${hostPort}/foundation`;
  secrets.push(adminUrl, migratorUrl, backendUrl);
  if (!readinessNameAccepted('browser', containerName)) throw new Failure('Readiness container guard rejected the container name');
  // From here a failed docker run may still have created the container, so cleanup removes it if it exists.
  containerCreated = true;
  const started = await run(['docker', 'run', '-d', '--name', containerName, ...READINESS_RUN_LABEL_ARGS, '--env-file', envFile,
    '-p', `127.0.0.1:${hostPort}:5432`, image], dockerEnv, 60_000);
  if (started.code !== 0) throw new Failure('Isolated PostgreSQL 18 did not start');
  console.log(`Isolated PostgreSQL 18 container ${containerName} started.`);

  const databaseReady = await waitFor(async () => {
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
  if (!databaseReady) throw new Failure('Isolated PostgreSQL did not become ready within 30 seconds');

  const provisioned = await run([process.execPath, '--no-env-file', 'database/provision.ts', '--apply'], {
    ...pathEnv, FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
    FOUNDATION_MIGRATOR_PASSWORD: migratorPassword, FOUNDATION_BACKEND_PASSWORD: backendPassword,
  }, 60_000);
  outputs.push(['provision', provisioned.stdout + provisioned.stderr]);
  if (provisioned.code !== 0) throw new Failure('Isolated provisioning failed');
  const migrated = await run([process.execPath, '--no-env-file', 'database/migrate.ts', '--apply'], {
    ...pathEnv, FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
  }, 60_000);
  outputs.push(['migrate', migrated.stdout + migrated.stderr]);
  if (migrated.code !== 0) throw new Failure('Isolated migration failed');
  console.log('Isolated database provisioned and migrated.');

  // The real backend and the development frontend, each as its own process group until every exit path aborts them.
  const startService = (name: string, argv: string[], env: Record<string, string>) => {
    const service = runProcessGroup(argv, { cwd: root, env, timeoutMs: 600_000, output: 'pipe', signal: services.signal });
    runningServices.push(service.then((result) => {
      serviceResults.set(name, result);
      return result;
    }));
  };
  startService('backend', [process.execPath, '--no-env-file', 'apps/backend/src/index.ts'], {
    PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '',
    NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(backendPort), DATABASE_URL: backendUrl,
  });
  startService('frontend', [process.execPath, '--no-env-file', 'run', 'dev:frontend'], baseEnv);
  const ready = await waitFor(async () => {
    if (serviceResults.size > 0) throw new Failure('Backend or frontend stopped before readiness');
    return (await answers200(`http://127.0.0.1:${backendPort}/api/status`)) && (await answers200(`http://127.0.0.1:${frontendPort}/`));
  }, 60_000, 250);
  if (!ready) throw new Failure('Backend /api/status and frontend / did not answer 200 within 60 seconds');
  console.log('Backend and frontend answered 200.');

  playwright = await run(['node', resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.real.config.ts'], {
    ...dockerEnv, FOUNDATION_READINESS_CONTAINER: containerName,
  }, 300_000);
  outputs.push(['playwright', playwright.stdout + playwright.stderr]);
  console.log(redacted(playwright.stdout + playwright.stderr).trimEnd());
  if (playwright.timedOut) throw new Failure('Playwright exceeded 300 seconds');
  if (playwright.code !== 0) throw new Failure('READY-009 browser flow failed');
  // Recovery without a restart: the backend and frontend that served the whole flow are the groups started above.
  if (serviceResults.size > 0) throw new Failure('Backend or frontend stopped during the browser flow');
} catch (error) {
  failure = error instanceof Failure ? error.message : 'Readiness real test failed';
} finally {
  // Every exit path: stop both service groups, then remove the container through the guard.
  services.abort();
  for (const result of await Promise.allSettled(runningServices)) {
    if (result.status === 'rejected') failure ??= 'A service process group did not stop';
  }
  for (const [name, result] of serviceResults) outputs.push([name, result.stdout + result.stderr]);
  if (containerCreated) {
    try {
      await removeContainer();
      containerCreated = false;
    } catch (error) {
      failure ??= error instanceof Failure ? error.message : 'Readiness container removal failed';
    }
  }
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

// Credential scan of spec 0006 (READY-009): service and step output, the JUnit report, and every file in outputDir.
try {
  const findings: string[] = [];
  for (const [name, text] of outputs) {
    if (secrets.some((secret) => text.includes(secret))) findings.push(`${name} output`);
  }
  const files = [...((await Bun.file(junit).exists()) ? [junit] : []), ...(await filesUnder(outputDir))];
  for (const path of files) {
    const data = await readFile(path);
    if (secrets.some((secret) => data.includes(Buffer.from(secret)))) findings.push(path.slice(root.length + 1));
  }
  const junitExists = await Bun.file(junit).exists();
  const report = {
    outputsScanned: outputs.map(([name]) => name),
    filesScanned: files.map((path) => path.slice(root.length + 1)),
    secretsChecked: secrets.length,
    junitSha256: junitExists ? createHash('sha256').update(await readFile(junit)).digest('hex') : null,
    findings,
  };
  await writeFile(scanReport, `${JSON.stringify(report, null, 2)}\n`);
  if (findings.length > 0) failure = 'Readiness test credential found in output or Playwright artifacts';
  else if (playwright && !junitExists) failure ??= 'Playwright JUnit report is missing';
  else console.log(`Readiness artifact scan passed: ${report.secretsChecked} random values absent from ${report.outputsScanned.length} outputs and ${files.length} files.`);
} catch {
  failure ??= 'Readiness artifact scan failed';
}

// Both ports are free again once the groups are gone.
try {
  for (const port of [backendPort, frontendPort]) {
    if ((await listeners(port)).length > 0) failure ??= `Port ${port} is still in use after test:readiness:real`;
  }
} catch {
  failure ??= 'Port check after test:readiness:real failed';
}

for (const [signal, handler] of handlers) process.off(signal, handler);
if (received !== undefined) {
  process.exitCode = signalCodes[received];
} else if (failure !== undefined) {
  for (const [name, text] of outputs) {
    if ((name === 'backend' || name === 'frontend') && text.trim()) console.error(`--- ${name} output (last 40 lines, credentials redacted) ---\n${tail(text)}`);
  }
  console.error(failure);
  process.exitCode = 1;
} else {
  console.log('READY-009 passed against the real database, backend, and frontend.');
}
