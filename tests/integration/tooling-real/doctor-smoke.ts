import { randomBytes } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQL } from 'bun';
import { runDoctor } from '../../../scripts/doctor';
import { loadConfig } from '../../../scripts/lib/development';
import { listeners } from '../../../scripts/lib/ports';
import { groupAlive, processIdentity, sameProcess, signalVerifiedGroup, type ProcessIdentity } from '../../../scripts/lib/process-identity';
import { runProcessGroup } from '../../../scripts/lib/process-group';
import { createTestAccounts, e2eAccountEnv, newTestAccounts } from '../../orchestration/auth-accounts';
import {
  createTokenFingerprintStore,
  readFingerprints,
  removeTokenFingerprintStore,
  tokenMatches,
  tokenScanControl,
  type TokenFingerprintStore,
} from '../../orchestration/token-fingerprints';
import {
  READINESS_RUN_LABEL_ARGS,
  readinessContainerLabelsAccepted,
  readinessContainerMissing,
  readinessImageLabelsAccepted,
  readinessNameAccepted,
} from '../../orchestration/readiness-container';

// `bun run test:tooling:real` (spec 0003, TOOL-001 and TOOL-007, AC-1 to AC-4 and AC-9). One isolated PostgreSQL 18
// is provisioned and migrated with random credentials; doctor must accept the minimum backend role and reject the
// wrong targets; `serve` then starts the real frontend 8889 and backend 8888, and the READY-009 browser flow of
// spec 0006 runs against it with playwright.real.config.ts (browser, SDK, proxy /api, backend, database, a stopped
// database, and recovery). A SIGTERM must then stop serve cleanly. Last, with the database gone, serve must stop at
// preflight while listeners on 8888 and 8889 keep answering.
//
// Added by /test on 2026-10-04 (verify.md steps that were checked by hand): more AC-1 and AC-2 rejections with proof
// that doctor writes and applies nothing (TOOL-001); a foreign listener on 8889 that serve refuses without a signal
// (TOOL-002, AC-6); the announced URLs in order (AC-4); the owner record of the running serve and a second serve from
// this checkout that fails while the first keeps answering (TOOL-005, AC-6 and AC-7); the recorded process groups gone
// after SIGTERM; and a second real serve stopped with Ctrl+C (SIGINT, exit 130) (TOOL-004, AC-8).
//
// Added after the review of 2026-10-04: every in process doctor run is checked for credentials, raw errors, and SQL
// and joins the scan; no USAGE on auth, CREATEROLE, and UPDATE, DELETE, or TRUNCATE on the metadata are rejected (AC-1);
// the listeners bind 127.0.0.1 only (AC-4); after SIGTERM and Ctrl+C the backend reports `Backend stopped` and no
// foundation_backend session is left (AC-8); every HTTP request has a limit; and a serve that cannot finish its own
// shutdown has its recorded groups killed through signalVerifiedGroup so no dev server outlives a failed run.
//
// The container follows the READY-009 guard of tests/orchestration/readiness-container.ts with owner 'browser'
// (spec 0006, Follow-up): name `foundation-readiness-<8 hex>`, READINESS_RUN_LABEL_ARGS, a fixed loopback host port,
// and no --rm, so the browser spec can stop and start it, and every removal passes the same guard. Playwright writes
// to .local/feature-2/, never to the feature 10 evidence folder. Every output and artifact is scanned for the random
// credential values, and by fingerprint for every session and CSRF token the browser specs obtained (spec 0014,
// *Sidik token uji*), before the run counts as passed. The fingerprint folder is removed here after the scan, on every
// exit path, signals included, like the rest of this smoke's cleanup.

const projectRoot = resolve(import.meta.dir, '../../..');
const evidence = resolve(projectRoot, '.local/feature-2');
const junit = resolve(evidence, 'playwright-real.xml');
const outputDir = resolve(evidence, 'test-results');
const scanReport = resolve(evidence, 'artifact-scan.json');
const image = 'foundation-postgres:18-pinned';
const ports = [8888, 8889] as const;
const name = `foundation-readiness-${randomBytes(4).toString('hex')}`;
const [adminPassword, migratorPassword, backendPassword] = Array.from({ length: 3 }, () => randomBytes(24).toString('hex')) as [string, string, string];
// Two test accounts of spec 0014 for the browser flow under serve; their passwords join the scan list at once.
const accounts = newTestAccounts();
const secrets: string[] = [adminPassword, migratorPassword, backendPassword, ...accounts.map((account) => account.password)];
const outputs: [string, string][] = [];
// The fingerprint folder of spec 0014 (*Sidik token uji*): outside .local/feature-2, removed on every exit path after
// the scan; `browserFlowPassed` says the browser specs that obtain tokens ran to the end.
let tokens: TokenFingerprintStore | null = null;
let browserFlowPassed = false;
let admin: SQL | undefined;
let adminUrl = '';
let backendUrl = '';
/** Every process this smoke spawned, so the last resort cleanup only touches a serve record that one of them wrote. */
const spawnedPids = new Set<number>();
let containerCreated = false;
let fixtures: ReturnType<typeof Bun.serve>[] = [];
const originalDatabaseUrl = process.env.DATABASE_URL;

// Docker and Playwright receive an allow list environment (spec 0006, *Environment proses anak*), never DATABASE_URL.
const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot', 'CI'];
const dockerEnv: Record<string, string> = Object.fromEntries(
  [...BASE_ENV_KEYS, 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
);

const signalCodes = { SIGINT: 130, SIGTERM: 143 } as const;
type HandledSignal = keyof typeof signalCodes;
const interrupt = new AbortController();
let received: HandledSignal | undefined;
const handlers = (Object.keys(signalCodes) as HandledSignal[]).map((signal) => {
  const handler = () => { received ??= signal; interrupt.abort(); };
  process.on(signal, handler);
  return [signal, handler] as const;
});
const interrupted = new Promise<never>((_, reject) => {
  interrupt.signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true });
});
interrupted.catch(() => undefined);
const checkpoint = () => { if (interrupt.signal.aborted) throw new Error('Interrupted'); };

const redacted = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);

async function command(args: string[], env: Record<string, string | undefined> = process.env, timeout = 30000) {
  const child = Bun.spawn(args, { cwd: projectRoot, env, stdout: 'pipe', stderr: 'pipe', timeout });
  spawnedPids.add(child.pid);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const raw = stdout + stderr;
  return { code, stdout, stderr, raw, output: redacted(raw), leaked: secrets.some((secret) => raw.includes(secret)) };
}

const docker = (args: string[], timeout = 30000) => command(['docker', ...args], dockerEnv, timeout);

/** JSON.parse of a `{{json .Config.Labels}}` inspect output; text that is not JSON counts as refused labels. */
function parsedLabels(stdout: string): unknown {
  try { return JSON.parse(stdout) as unknown; } catch { return undefined; }
}

/** The READY-009 guard with owner 'browser', in order: name, `docker container inspect`, labels; only then `docker rm -f`. */
async function removeContainer() {
  if (!readinessNameAccepted('browser', name)) throw new Error('Readiness container guard rejected the container name');
  const inspected = await docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', name]);
  if (inspected.code !== 0) {
    if (readinessContainerMissing(inspected.code, inspected.stderr)) return;
    throw new Error('Readiness container guard could not inspect the container');
  }
  if (!readinessContainerLabelsAccepted(parsedLabels(inspected.stdout))) throw new Error('Readiness container guard rejected the container labels');
  if ((await docker(['rm', '-f', name], 60000)).code !== 0) throw new Error('Readiness container removal failed');
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

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await filesUnder(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

/** Text a doctor message must never hold (AC-1): a DSN, a raw PostgreSQL or file system error, or raw SQL. */
const rawDatabaseError = /postgres(ql)?:\/\/|permission denied|ECONNREFUSED|role "|relation "|ENOENT|schema_migrations/i;
const rawSql = /\b(SELECT|FROM|WHERE|INSERT|UPDATE)\b/;
let doctorRuns = 0;

/**
 * The database checks of one in process doctor run. Every message of every run is checked for the random credentials
 * and for raw errors or SQL, and the run is added to `outputs`, so the final scan also covers it.
 */
async function databaseChecks(config: Awaited<ReturnType<typeof loadConfig>>, root = projectRoot) {
  const checks = (await runDoctor(config, [], root)).filter((check) => check.name.startsWith('Database backend'));
  outputs.push([`doctor checks ${++doctorRuns}`, JSON.stringify(checks)]);
  for (const check of checks) {
    assert(!secrets.some((secret) => check.message.includes(secret) || check.name.includes(secret)), `Doctor printed a credential in ${check.name}`);
    assert(!rawDatabaseError.test(check.message) && !rawSql.test(check.message), `Doctor printed a raw database error or SQL in ${check.name}`);
  }
  return checks;
}

async function waitForDatabase(url: string) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    checkpoint();
    const probe = new SQL({ url, max: 1, connectionTimeout: 1 });
    try { await probe`SELECT 1`; await probe.close(); return; }
    catch { await probe.close().catch(() => {}); await Bun.sleep(200); }
  }
  throw new Error('Isolated PostgreSQL 18 did not become ready');
}

/** AC-8: the invocation record of serve (spec 0003, invariant 1) is gone after shutdown. */
async function assertLockReleased() {
  const lock = resolve(await realpath(projectRoot), '.local/serve.lock');
  assert.equal(await stat(lock).then(() => true, () => false), false, 'Serve lock remains after shutdown');
}

const serveEnv = () => ({ ...process.env, NODE_ENV: 'development', DATABASE_URL: backendUrl });

/** Every HTTP request to the running application has its own 5 second limit and stops on an interrupt. */
function get(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(5000), interrupt.signal]) });
}

/**
 * Last resort when serve itself could not finish its shutdown: SIGKILL each service group in the serve record of this
 * checkout, but only when a serve that this smoke started wrote that record, and only through signalVerifiedGroup, so
 * the PID reuse rule of scripts/lib/process-identity still holds. Once that serve and every recorded group are gone,
 * the record is removed, so the next run does not start from a stale lock. Then waits until 8888 and 8889 are free.
 */
async function killRecordedGroups(): Promise<void> {
  const checkout = await realpath(projectRoot);
  const lock = resolve(checkout, '.local/serve.lock');
  const raw = await readFile(resolve(lock, 'owner.json'), 'utf8').catch(() => null);
  let record: { checkout?: unknown; uid?: unknown; supervisor?: ProcessIdentity; groups?: unknown } | undefined;
  try { record = raw === null ? undefined : JSON.parse(raw); } catch { record = undefined; }
  if (record && record.checkout === checkout && record.uid === process.getuid?.() && Array.isArray(record.groups) &&
      typeof record.supervisor?.pid === 'number' && spawnedPids.has(record.supervisor.pid)) {
    const groups = record.groups as ProcessIdentity[];
    for (const group of groups) {
      try { await signalVerifiedGroup(group, 'SIGKILL'); } catch { /* reported below through the ports that stay taken */ }
    }
    const groupsDeadline = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < groupsDeadline) {
      alive = (await Promise.all(groups.map((group) => groupAlive(group.pgid)))).some(Boolean) ||
        sameProcess(await processIdentity(record.supervisor.pid), record.supervisor);
      if (alive) await Bun.sleep(100);
    }
    if (!alive && await readFile(resolve(lock, 'owner.json'), 'utf8').catch(() => null) === raw) {
      await rm(lock, { recursive: true, force: true });
    }
  }
  const deadline = Date.now() + 5000;
  while ((await Promise.all(ports.map(listeners))).some((found) => found.length > 0)) {
    if (Date.now() >= deadline) throw new Error('Ports 8888 or 8889 stay taken after the last resort cleanup; stop those processes by hand');
    await Bun.sleep(100);
  }
}

/**
 * AC-4 (spec 0003): frontend and backend listen on 127.0.0.1 only, never on another address of the machine, which would
 * expose the development only routes, such as /api/readiness, to the network.
 */
async function assertLoopbackOnly() {
  const child = Bun.spawn(['lsof', '-nP', '-iTCP:8888', '-iTCP:8889', '-sTCP:LISTEN', '-Fn'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  assert.equal(code, 0, 'lsof could not list the listeners on 8888 and 8889');
  const names = [...new Set(stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1)))].sort();
  assert.deepEqual(names, ['127.0.0.1:8888', '127.0.0.1:8889'], `Serve listeners are bound to ${names.join(', ')}`);
  return names;
}

/** Number of PostgreSQL sessions of the backend role, through a new admin connection that is closed again. */
async function backendSessions(): Promise<number> {
  const sql = new SQL({ url: adminUrl, max: 1 });
  try {
    const [row] = await sql`SELECT count(*)::int AS sessions FROM pg_catalog.pg_stat_activity WHERE usename = 'foundation_backend'`;
    return row.sessions;
  } finally { await sql.close(); }
}

/**
 * AC-8: the backend lifecycle closed its pool. The backend prints `Backend stopped` only after app.stop and
 * pool.close succeeded, and no foundation_backend session is left in PostgreSQL.
 */
async function assertBackendPoolClosed(output: string, how: string) {
  assert(output.includes('Backend stopped'), `The backend did not report a closed pool after ${how}`);
  const deadline = Date.now() + 5000;
  let sessions = await backendSessions();
  while (sessions > 0 && Date.now() < deadline) {
    await Bun.sleep(200);
    sessions = await backendSessions();
  }
  assert.equal(sessions, 0, `${sessions} foundation_backend sessions remain after ${how}`);
}

interface ServeRun { child: ReturnType<typeof Bun.spawn>; ready: Promise<void>; drains: Promise<unknown>; output: () => string }

/** Starts the real `scripts/serve.ts` with the backend role on free ports 8888 and 8889 and collects its output. */
async function launchServe(): Promise<ServeRun> {
  for (const port of ports) assert.equal((await listeners(port)).length, 0, `Port ${port} must be free for real application smoke`);
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/serve.ts'], { cwd: projectRoot, env: serveEnv(), stdout: 'pipe', stderr: 'pipe' });
  spawnedPids.add(child.pid);
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
  const drains = Promise.all([consume(child.stdout as ReadableStream<Uint8Array>), consume(child.stderr as ReadableStream<Uint8Array>)]);
  return { child, ready, drains, output: () => output };
}

/** Resolves once serve announced readiness; rejects when serve exits first, after 65 seconds, or on an interrupt. */
async function waitForServe(run: ServeRun) {
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run.ready,
      interrupted,
      run.child.exited.then((code) => { throw new Error(`Serve exited before readiness (${code})`); }),
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('Serve readiness exceeded 65 seconds')), 65000);
      }),
    ]);
  } finally {
    if (readyTimer) clearTimeout(readyTimer);
  }
}

/**
 * Shutdown on every path: the given signal and at most 10 seconds. As a last resort serve gets SIGKILL, and so do the
 * service groups it recorded, which run in their own process groups (resolves to null).
 */
async function stopServe(run: ServeRun, signal: 'SIGTERM' | 'SIGINT'): Promise<number | null> {
  if (run.child.exitCode === null) run.child.kill(signal);
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    run.child.exited,
    new Promise<null>((done) => { shutdownTimer = setTimeout(() => { run.child.kill('SIGKILL'); done(null); }, 10000); }),
  ]);
  clearTimeout(shutdownTimer);
  if (code === null) {
    await run.child.exited;
    await killRecordedGroups();
  }
  await Promise.race([run.drains, Bun.sleep(5000)]);
  return code;
}

/** AC-4: the URLs appear once, after the frontend was started, in order, and right before the ready line. */
function assertAnnouncement(output: string) {
  const started = output.lastIndexOf('Menjalankan frontend.');
  const frontendAt = output.indexOf('Frontend: http://127.0.0.1:8889');
  const backendAt = output.indexOf('Backend: http://127.0.0.1:8888');
  const readyAt = output.indexOf('Layanan development siap.');
  assert(started >= 0 && started < frontendAt && frontendAt < backendAt && backendAt < readyAt, 'Serve announced the URLs out of order');
  assert.equal(output.split('Frontend: http://').length, 2, 'Serve announced the frontend URL more than once');
  assert.equal(output.split('Backend: http://').length, 2, 'Serve announced the backend URL more than once');
}

/**
 * AC-6 and AC-7 (spec 0003, invariants 1 and 3): the record of the running serve names this checkout, this user,
 * serve itself as supervisor, and the backend and frontend groups, each leading its own process group. The lock
 * directory and record are private to the user and hold no DSN or environment. Returns the recorded groups.
 */
async function assertOwnerRecord(run: ServeRun, label: string): Promise<ProcessIdentity[]> {
  const checkout = await realpath(projectRoot);
  const lock = resolve(checkout, '.local/serve.lock');
  const path = resolve(lock, 'owner.json');
  const raw = await readFile(path, 'utf8');
  outputs.push([label, raw]);
  const record = JSON.parse(raw);
  assert.equal((await stat(lock)).mode & 0o777, 0o700, 'Serve lock directory is not private to the user');
  assert.equal((await stat(path)).mode & 0o777, 0o600, 'Serve owner record is not private to the user');
  assert.deepEqual(Object.keys(record).sort(), ['checkout', 'groups', 'supervisor', 'token', 'uid']);
  assert.equal(record.checkout, checkout);
  assert.equal(record.uid, process.getuid?.());
  assert.equal(record.supervisor.pid, run.child.pid, 'Serve owner record does not name serve as supervisor');
  assert.equal(record.groups.length, 2, 'Serve did not record the backend and frontend groups');
  for (const group of record.groups as ProcessIdentity[]) {
    assert.equal(group.pgid, group.pid, 'A recorded service does not lead its own process group');
    assert.equal(group.uid, process.getuid?.());
    assert(group.cwd === checkout || group.cwd.startsWith(`${checkout}/`), 'A recorded service runs outside this checkout');
    assert(typeof group.started === 'string' && group.started.length > 0, 'A recorded service has no start time');
  }
  assert(!raw.includes('postgres://') && !raw.includes('DATABASE_URL') && !secrets.some((secret) => raw.includes(secret)),
    'Serve owner record holds a DSN, credential, or environment');
  return record.groups;
}

/** AC-7 on the real application: a second serve from this checkout fails clearly and leaves the first one running. */
async function assertSecondInvocationRejected(run: ServeRun) {
  const ownerPath = resolve(await realpath(projectRoot), '.local/serve.lock/owner.json');
  const before = await readFile(ownerPath, 'utf8');
  const second = await command([process.execPath, '--no-env-file', 'scripts/serve.ts'], serveEnv(), 60000);
  outputs.push(['serve second invocation', second.raw]);
  assert.equal(second.code, 1, 'A second serve from this checkout did not fail');
  assert.equal(second.leaked, false, 'The second serve printed a credential');
  assert(second.output.includes('Serve lain dari checkout ini masih aktif.'), 'The second serve did not name the active invocation');
  assert(!second.output.includes('Menjalankan '), 'The second serve started a service');
  assert.equal(await readFile(ownerPath, 'utf8'), before, 'The second serve changed the active owner record');
  assert.equal(run.child.exitCode, null, 'The first serve stopped after the second invocation');
  const backend = await get('http://127.0.0.1:8888/api/status');
  const frontend = await get('http://127.0.0.1:8889/');
  await Promise.all([backend.text(), frontend.text()]);
  assert.equal(backend.status, 200, 'The first serve backend stopped answering after the second invocation');
  assert.equal(frontend.status, 200, 'The first serve frontend stopped answering after the second invocation');
  console.log('TOOL-005: a second serve from this checkout exited 1 with "Serve lain dari checkout ini masih aktif.", left the owner record unchanged, and the first serve kept answering on 8888 and 8889');
}

async function assertGroupsStopped(groups: ProcessIdentity[], how: string) {
  for (const group of groups) assert.equal(await groupAlive(group.pgid), false, `Process group ${group.pgid} remains after ${how}`);
}

async function serveRealApplication() {
  const run = await launchServe();
  let failure: unknown;
  let groups: ProcessIdentity[] = [];
  try {
    await waitForServe(run);
    const backend = await get('http://127.0.0.1:8888/api/status');
    const frontend = await get('http://127.0.0.1:8889/');
    const backendBody = await backend.json();
    const frontendType = frontend.headers.get('content-type') ?? '';
    const frontendBody = await frontend.text();
    assert.equal(backend.status, 200);
    assert.deepEqual(backendBody, { status: 'ok' });
    assert.equal(frontend.status, 200);
    assert.match(frontendType, /text\/html/);
    assert.match(frontendBody, /<html(?:\s|>)/i);
    assertAnnouncement(run.output());
    console.log(`TOOL-007: GET http://127.0.0.1:8888/api/status -> ${backend.status} ${JSON.stringify(backendBody)}; GET http://127.0.0.1:8889/ -> ${frontend.status} ${frontendType}; serve announced Frontend and Backend URLs once, in order, right before it reported ready`);
    console.log(`TOOL-007: the only listeners on 8888 and 8889 are ${(await assertLoopbackOnly()).join(' and ')}`);
    groups = await assertOwnerRecord(run, 'serve owner record');
    console.log('TOOL-005: the owner record of the running serve names this checkout, this user, serve, and two groups that lead their own process groups; lock 0700 and record 0600, without DSN or environment');
    await assertSecondInvocationRejected(run);

    // READY-009 against this serve: /kesiapan through the Angular proxy and SDK, the available state with the
    // migration count, recheck, the stopped database without the old count, and recovery after docker start.
    tokens = await createTokenFingerprintStore('foundation-tooling-tokens-');
    const playwright = await runProcessGroup(
      ['node', resolve(projectRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.real.config.ts', '--output', outputDir],
      { cwd: projectRoot, env: { ...dockerEnv, FOUNDATION_READINESS_CONTAINER: name, PLAYWRIGHT_JUNIT_OUTPUT_FILE: junit, ...e2eAccountEnv(accounts), ...tokens.env },
        timeoutMs: 300000, output: 'pipe', signal: interrupt.signal },
    );
    outputs.push(['playwright', playwright.stdout + playwright.stderr]);
    console.log(redacted(playwright.stdout + playwright.stderr).trimEnd());
    checkpoint();
    assert.equal(playwright.timedOut, false, 'Playwright exceeded 300 seconds');
    assert.equal(playwright.code, 0, 'READY-009 or AUTH-012 browser flow under serve failed');
    browserFlowPassed = true;
    assert.equal(run.child.exitCode, null, 'Serve stopped during the browser flow');
    console.log('TOOL-007: READY-009 passed through browser, SDK, proxy, backend, and database under serve; the same serve stayed up from the first check through recovery');
    // A readiness check right before SIGTERM keeps a pool connection open, so the session check after it proves something.
    const readiness = await get('http://127.0.0.1:8888/api/readiness');
    await readiness.text();
    assert.equal(readiness.status, 200, 'The backend readiness check did not reach the database after the browser flow');
    const sessions = await backendSessions();
    assert(sessions > 0, 'The backend holds no database session before SIGTERM, so the pool check would prove nothing');
    console.log(`TOOL-004: the backend held ${sessions} foundation_backend session(s) in PostgreSQL before SIGTERM`);
  } catch (error) {
    failure = error;
  }

  const code = await stopServe(run, 'SIGTERM');
  outputs.push(['serve', run.output()]);
  if (failure) throw new Error(`${(failure as Error).message}; ${redacted(run.output()).slice(-800)}`);
  assert.equal(code, 143, 'Serve did not finish a clean SIGTERM shutdown within 10 seconds');
  for (const port of ports) assert.equal((await listeners(port)).length, 0, `Listener on port ${port} remains after shutdown`);
  await assertGroupsStopped(groups, 'SIGTERM');
  await assertLockReleased();
  await assertBackendPoolClosed(run.output(), 'SIGTERM');
  console.log('TOOL-007: SIGTERM shutdown exited 143, stopped both recorded process groups, removed listeners on ports 8888 and 8889, and released the serve lock');
  console.log('TOOL-004: after SIGTERM the backend printed "Backend stopped" (app.stop and pool.close done) and no foundation_backend session remained');
}

/** AC-8 on the real application: Ctrl+C (SIGINT to serve) stops both groups, frees 8888 and 8889, and releases the lock. */
async function interruptRealApplication() {
  const run = await launchServe();
  let failure: unknown;
  let groups: ProcessIdentity[] = [];
  try {
    await waitForServe(run);
    groups = await assertOwnerRecord(run, 'serve interrupt owner record');
    const backend = await get('http://127.0.0.1:8888/api/status');
    assert.deepEqual(await backend.json(), { status: 'ok' });
    // A readiness check opens a pool connection, so the session check after Ctrl+C proves the pool was closed.
    const readiness = await get('http://127.0.0.1:8888/api/readiness');
    await readiness.text();
    assert.equal(readiness.status, 200, 'The backend readiness check did not reach the database');
    assert((await backendSessions()) > 0, 'The backend holds no database session before Ctrl+C');
  } catch (error) {
    failure = error;
  }
  const code = await stopServe(run, 'SIGINT');
  outputs.push(['serve interrupt', run.output()]);
  if (failure) throw new Error(`${(failure as Error).message}; ${redacted(run.output()).slice(-800)}`);
  assert.equal(code, 130, 'Serve did not finish a clean SIGINT shutdown within 10 seconds');
  for (const port of ports) assert.equal((await listeners(port)).length, 0, `Listener on port ${port} remains after Ctrl+C`);
  await assertGroupsStopped(groups, 'SIGINT');
  await assertLockReleased();
  await assertBackendPoolClosed(run.output(), 'Ctrl+C');
  console.log('TOOL-004: Ctrl+C (SIGINT) on the real serve exited 130, stopped both recorded process groups, removed listeners on ports 8888 and 8889, released the serve lock, and the backend printed "Backend stopped" with no foundation_backend session left');
}

/**
 * AC-6 on the real application: with the database ready, a listener of another process on 8889 makes serve fail at
 * cleanup, after a passed preflight, without a signal to that process and without starting a service.
 */
async function foreignListenerKeepsRunning() {
  for (const port of ports) assert.equal((await listeners(port)).length, 0, `Port ${port} must be free for real application smoke`);
  const foreign = Bun.spawn([process.execPath, '--no-env-file', '-e',
    "Bun.serve({ hostname: '127.0.0.1', port: 8889, fetch: () => new Response('asing') }); console.log('ready');"],
  { cwd: directory, env: { PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'ignore' });
  spawnedPids.add(foreign.pid);
  try {
    const reader = (foreign.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    reader.releaseLock();
    assert(new TextDecoder().decode(first.value).includes('ready'), 'Foreign fixture listener did not start');
    const result = await command([process.execPath, '--no-env-file', 'scripts/serve.ts'], serveEnv(), 60000);
    outputs.push(['serve foreign listener', result.raw]);
    assert.equal(result.code, 1, 'Serve did not fail next to a foreign listener');
    assert.equal(result.leaked, false, 'Serve printed a credential next to a foreign listener');
    assert(result.output.includes('Doctor lulus.'), 'Serve did not pass preflight before the listener check');
    assert(result.output.includes('Listener port bukan proses Foundation lama dari checkout ini.'), 'Serve did not refuse the foreign listener');
    assert(!result.output.includes('Menjalankan '), 'Serve started a service next to a foreign listener');
    assert.equal(foreign.exitCode, null, 'The foreign listener stopped');
    assert.equal(await (await get('http://127.0.0.1:8889/')).text(), 'asing', 'The foreign listener stopped answering');
    assert((await listeners(8889)).some((item) => item.pid === foreign.pid), 'The foreign listener lost port 8889');
    assert.equal((await listeners(8888)).length, 0, 'Serve left a listener on 8888');
    await assertLockReleased();
  } finally {
    foreign.kill('SIGKILL');
    await foreign.exited;
  }
  const deadline = Date.now() + 5000;
  while ((await listeners(8889)).length > 0) {
    if (Date.now() >= deadline) throw new Error('Foreign fixture listener did not stop');
    await Bun.sleep(100);
  }
  console.log('TOOL-002: with the database ready, serve passed preflight, refused the foreign listener on 8889 without a signal, started no service, and released the lock; the listener kept answering "asing"');
}

/** AC-3 on the real application: a failed preflight starts nothing and leaves processes on 8888 and 8889 alive. */
async function preflightFailureKeepsListeners() {
  // One at a time, so a server that did open is always stopped by the cleanup when the next one fails to listen.
  for (const port of ports) fixtures.push(Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response(`probe-${port}`) }));
  const result = await command([process.execPath, '--no-env-file', 'scripts/serve.ts'], serveEnv(), 60000);
  outputs.push(['serve preflight', result.raw]);
  assert.equal(result.code, 1, 'Serve did not fail on the unavailable database');
  assert.equal(result.leaked, false, 'Serve printed a credential at preflight');
  assert(result.output.includes('Doctor belum lulus'), 'Serve did not stop at preflight');
  assert(!result.output.includes('Menjalankan '), 'Serve started a service after a failed preflight');
  for (const port of ports) {
    const response = await get(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), `probe-${port}`, `Listener on port ${port} did not survive the failed preflight`);
  }
  await assertLockReleased();
  await Promise.all(fixtures.map((server) => server.stop(true)));
  fixtures = [];
  console.log('TOOL-007: serve stopped at preflight on the unavailable database, started no service, and left the listeners on 8888 and 8889 answering');
}

let directory = '';
let failure: string | undefined;

try {
  await mkdir(evidence, { recursive: true });
  // A report or artifact of an earlier run must never be scanned or read as this run's result.
  await rm(junit, { force: true });
  await rm(outputDir, { recursive: true, force: true });
  await rm(scanReport, { force: true });
  for (const port of ports) assert.equal((await listeners(port)).length, 0, `Port ${port} must be free for real application smoke`);
  // Every serve step expects to take a fresh lock and to leave none behind; an old record would be recovered instead.
  assert.equal(await stat(resolve(await realpath(projectRoot), '.local/serve.lock')).then(() => true, () => false), false,
    'A serve lock of this checkout already exists; stop that serve, or check that its processes are gone and remove .local/serve.lock by hand');

  const inspectedImage = await docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', image]);
  assert.equal(inspectedImage.code, 0, 'Isolated PostgreSQL 18 image unavailable');
  assert(readinessImageLabelsAccepted(parsedLabels(inspectedImage.stdout)), 'Readiness container guard would reject containers from this image');
  directory = await mkdtemp(resolve(tmpdir(), 'foundation-tooling-db-'));
  const envFile = resolve(directory, 'postgres.env');
  await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
  const port = await freePort();
  assert(readinessNameAccepted('browser', name), 'Readiness container guard rejected the container name');
  // From here a failed docker run may still have created the container, so cleanup removes it if it exists.
  containerCreated = true;
  const started = await docker(['run', '-d', '--name', name, ...READINESS_RUN_LABEL_ARGS, '--env-file', envFile,
    '-p', `127.0.0.1:${port}:5432`, image], 60000);
  assert.equal(started.code, 0, 'Isolated PostgreSQL 18 did not start');
  adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${port}/foundation`;
  const migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${port}/foundation`;
  backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:${port}/foundation`;
  secrets.push(adminUrl, migratorUrl, backendUrl);
  await waitForDatabase(adminUrl);
  const provision = await command([process.execPath, '--no-env-file', 'database/provision.ts', '--apply'], {
    PATH: process.env.PATH ?? '', FOUNDATION_ADMIN_DATABASE_URL: adminUrl,
    FOUNDATION_MIGRATOR_PASSWORD: migratorPassword, FOUNDATION_BACKEND_PASSWORD: backendPassword,
  });
  outputs.push(['provision', provision.raw]);
  assert.equal(provision.code, 0, 'Isolated provisioning failed');
  assert.equal(provision.leaked, false, 'Provisioning printed a credential');
  const migration = await command([process.execPath, '--no-env-file', 'database/migrate.ts', '--apply'], {
    PATH: process.env.PATH ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
  });
  outputs.push(['migrate', migration.raw]);
  assert.equal(migration.code, 0, 'Baseline migration failed');
  assert.equal(migration.leaked, false, 'Migration printed a credential');
  // Spec 0014: two test accounts through the operator command, before any privilege probe below changes the database.
  await createTestAccounts(async (argv, env) => {
    const result = await command(argv, env);
    outputs.push(['accounts', result.raw]);
    assert.equal(result.leaked, false, 'The account command printed a credential');
    return result;
  }, migratorUrl, accounts);
  checkpoint();
  admin = new SQL({ url: adminUrl, max: 1 });
  const config = await loadConfig();
  process.env.DATABASE_URL = backendUrl;
  const positive = await databaseChecks(config);
  assert(positive.length > 0 && positive.every((check) => check.status === 'ok'), 'Doctor rejected provisioned backend role');
  assert(positive.every((check) => !secrets.some((secret) => check.message.includes(secret))));
  const cli = await command([process.execPath, '--no-env-file', 'scripts/doctor.ts'], {
    ...process.env, NODE_ENV: 'development', DATABASE_URL: backendUrl,
  });
  outputs.push(['doctor', cli.raw]);
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

  // AC-1: a configured schema that does not exist, CREATE on an application schema and on public, a role that can
  // create databases, ownership of the metadata table, and metadata the role cannot read are each rejected, with no
  // raw database error in any message. Every change is undone and the doctor must accept the database again.
  const extraSchema = structuredClone(config);
  extraSchema.database.schemas = [...config.database.schemas, 'reporting'];
  assert((await databaseChecks(extraSchema)).some((check) => check.name === 'Database backend: Schema reporting' && check.status === 'error'),
    'Doctor accepted a configured schema that does not exist');
  await admin`GRANT CREATE ON SCHEMA users TO foundation_backend`;
  assert((await databaseChecks(config)).some((check) => check.name === 'Database backend: Privilege schema users' && check.status === 'error'),
    'Doctor accepted CREATE on an application schema');
  await admin`REVOKE CREATE ON SCHEMA users FROM foundation_backend`;
  await admin`GRANT CREATE ON SCHEMA public TO foundation_backend`;
  assert((await databaseChecks(config)).some((check) => check.name === 'Database backend: Privilege schema public' && check.status === 'error'),
    'Doctor accepted CREATE on public');
  await admin`REVOKE CREATE ON SCHEMA public FROM foundation_backend`;
  await admin`ALTER ROLE foundation_backend CREATEDB`;
  assert((await databaseChecks(config)).some((check) => check.name === 'Database backend: Role database' && check.status === 'error'),
    'Doctor accepted a role that can create databases');
  await admin`ALTER ROLE foundation_backend NOCREATEDB`;
  const [metadataTable] = await admin`SELECT pg_catalog.pg_get_userbyid(relowner) AS owner FROM pg_catalog.pg_class WHERE oid = 'common.schema_migrations'::regclass`;
  assert.equal(metadataTable.owner, 'foundation_owner', 'Metadata table is not owned by foundation_owner after provisioning');
  await admin`ALTER TABLE common.schema_migrations OWNER TO foundation_backend`;
  assert((await databaseChecks(config)).some((check) => check.name === 'Database backend: Privilege metadata migration' && check.status === 'error'),
    'Doctor accepted the backend role as owner of the metadata table');
  // Changing the owner back folds the backend SELECT entry into the owner entry, so the grant of feature 5 is restored.
  await admin`ALTER TABLE common.schema_migrations OWNER TO foundation_owner`;
  await admin`GRANT SELECT ON TABLE common.schema_migrations TO foundation_backend`;
  await admin`REVOKE SELECT ON TABLE common.schema_migrations FROM foundation_backend`;
  const unreadable = await databaseChecks(config);
  assert(unreadable.some((check) => check.status === 'error'), 'Doctor accepted metadata it cannot read');
  assert(unreadable.every((check) => !/permission denied|schema_migrations|SELECT/i.test(check.message)), 'Doctor printed a raw database error');
  await admin`GRANT SELECT ON TABLE common.schema_migrations TO foundation_backend`;

  // AC-1, the rest of the role rules: no USAGE on a configured schema that exists, a role that can create roles, and
  // UPDATE, DELETE, or TRUNCATE on the metadata table are each rejected, then undone the same way.
  await admin`REVOKE USAGE ON SCHEMA auth FROM foundation_backend`;
  assert((await databaseChecks(config)).some((check) => check.name === 'Database backend: Schema auth' && check.status === 'error'),
    'Doctor accepted a configured schema without USAGE');
  await admin`GRANT USAGE ON SCHEMA auth TO foundation_backend`;
  await admin`ALTER ROLE foundation_backend CREATEROLE`;
  assert((await databaseChecks(config)).some((check) => check.name === 'Database backend: Role database' && check.status === 'error'),
    'Doctor accepted a role that can create roles');
  await admin`ALTER ROLE foundation_backend NOCREATEROLE`;
  for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
    await admin.unsafe(`GRANT ${privilege} ON TABLE common.schema_migrations TO foundation_backend`);
    assert((await databaseChecks(config)).some((check) => check.name === 'Database backend: Privilege metadata migration' && check.status === 'error'),
      `Doctor accepted ${privilege} on the metadata table`);
    await admin.unsafe(`REVOKE ${privilege} ON TABLE common.schema_migrations FROM foundation_backend`);
  }
  const roleRulesRestored = await databaseChecks(config);
  assert(roleRulesRestored.length === positive.length && roleRulesRestored.every((check) => check.status === 'ok'),
    'Doctor did not accept the database after the role changes were undone');
  console.log('TOOL-001: no USAGE on auth, CREATEROLE, and UPDATE, DELETE, and TRUNCATE on the metadata table rejected; the restored role passed again');

  // AC-2: a repository without database/migrations is not ready, and an unapplied local file fails while doctor
  // writes no metadata and applies nothing (the copy without that file passes first, so the file is the cause).
  const withoutMigrations = resolve(directory, 'repository-without-migrations');
  await mkdir(withoutMigrations, { recursive: true });
  const missingDirectory = await databaseChecks(config, withoutMigrations);
  assert(missingDirectory.some((check) => check.status === 'error'), 'Doctor accepted a repository without a migration directory');
  assert(missingDirectory.every((check) => !check.message.includes('ENOENT')), 'Doctor printed a raw file system error');
  const pendingRoot = resolve(directory, 'repository-with-pending-migration');
  await mkdir(resolve(pendingRoot, 'database/migrations'), { recursive: true });
  for (const file of (await readdir(resolve(projectRoot, 'database/migrations'))).filter((file) => file.endsWith('.sql'))) {
    await writeFile(resolve(pendingRoot, 'database/migrations', file), await readFile(resolve(projectRoot, 'database/migrations', file)));
  }
  assert((await databaseChecks(config, pendingRoot)).every((check) => check.status === 'ok'), 'Doctor rejected an exact copy of the migrations');
  await writeFile(resolve(pendingRoot, 'database/migrations/9998-pending-comment.sql'), "COMMENT ON SCHEMA users IS 'pending';\n");
  const metadataSnapshot = async () => JSON.stringify([...(await admin!`SELECT * FROM common.schema_migrations ORDER BY name`)]);
  const commentSnapshot = async () => (await admin!`SELECT pg_catalog.obj_description('users'::regnamespace, 'pg_namespace') AS comment`)[0].comment;
  const [metadataBefore, commentBefore] = [await metadataSnapshot(), await commentSnapshot()];
  assert((await databaseChecks(config, pendingRoot)).some((check) => check.name === 'Database backend: Migration' && check.status === 'error'),
    'Doctor accepted an unapplied migration file');
  assert.equal(await metadataSnapshot(), metadataBefore, 'Doctor changed migration metadata');
  assert.equal(await commentSnapshot(), commentBefore, 'Doctor applied a pending migration');
  const restored = await databaseChecks(config);
  assert(restored.length === positive.length && restored.every((check) => check.status === 'ok'), 'Doctor did not accept the restored database');
  console.log('TOOL-001: missing configured schema, CREATE on users and on public, CREATEDB, metadata owner, unreadable metadata, missing migration directory, and an unapplied file rejected; doctor wrote no metadata and applied nothing; the restored database passed again');
  // The browser flow stops and starts the database, so the admin connection is closed first.
  await admin.close();
  admin = undefined;
  checkpoint();

  await foreignListenerKeepsRunning();
  checkpoint();
  await serveRealApplication();
  checkpoint();
  await interruptRealApplication();
  checkpoint();
  await removeContainer();
  containerCreated = false;
  const unavailable = await databaseChecks(config);
  assert(unavailable.some((check) => check.status === 'error'), 'Doctor accepted an unavailable database');
  assert(unavailable.every((check) => !secrets.some((secret) => check.message.includes(secret))));
  console.log('TOOL-001: unavailable database rejected without credential output');
  await preflightFailureKeepsListeners();
} catch (error) {
  failure = redacted((error as Error).message);
} finally {
  if (admin) await admin.close().catch(() => {});
  await Promise.all(fixtures.map((server) => server.stop(true))).catch(() => {});
  // A serve that this run started and that never finished its shutdown must not leave services on 8888 and 8889.
  try { await killRecordedGroups(); } catch (error) { failure ??= (error as Error).message; }
  if (containerCreated) {
    try { await removeContainer(); } catch (error) { failure ??= (error as Error).message; }
  }
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (directory) await rm(directory, { recursive: true, force: true });
}

// Credential scan (TOOL-007, "kegagalan database tidak membocorkan credential"): every step and service output, the
// JUnit report, and every Playwright artifact, byte for byte, for the credential values and, by fingerprint, for every
// token the browser specs obtained (spec 0014, *Sidik token uji*), with the positive control of AUTH-010.
try {
  const fingerprints = tokens === null ? new Set<string>() : await readFingerprints(tokens);
  const controlPassed = tokens === null ? null : await tokenScanControl(tokens);
  const tokenFound = (data: Uint8Array | string) => tokens !== null && tokenMatches(data, tokens.key, fingerprints) > 0;
  const findings: string[] = [];
  for (const [label, text] of outputs) {
    if (secrets.some((secret) => text.includes(secret))) findings.push(`${label} output`);
    else if (tokenFound(text)) findings.push(`${label} output token`);
  }
  const files = [...((await Bun.file(junit).exists()) ? [junit] : []), ...(await filesUnder(outputDir))];
  for (const path of files) {
    const data = await readFile(path);
    if (secrets.some((secret) => data.includes(Buffer.from(secret)))) findings.push(path.slice(projectRoot.length + 1));
    else if (tokenFound(data)) findings.push(`${path.slice(projectRoot.length + 1)} token`);
  }
  const report = {
    outputsScanned: outputs.map(([label]) => label),
    filesScanned: files.map((path) => path.slice(projectRoot.length + 1)),
    secretsChecked: secrets.length,
    tokenFingerprints: fingerprints.size,
    tokenScanControl: controlPassed,
    findings,
  };
  if (tokenFound(`${JSON.stringify(report, null, 2)}\n`)) findings.push(`${scanReport.slice(projectRoot.length + 1)} token`);
  await writeFile(scanReport, `${JSON.stringify(report, null, 2)}\n`);
  if (findings.length > 0) failure = 'Tooling smoke credential or token found in output or Playwright artifacts';
  else if (failure === undefined && !(await Bun.file(junit).exists())) failure = 'Playwright JUnit report is missing';
  else if (browserFlowPassed && fingerprints.size === 0) failure ??= 'Token fingerprints missing after the browser flow';
  else if (controlPassed === false) failure ??= 'Token scan control failed';
  else console.log(`TOOL-007: artifact scan passed: ${report.secretsChecked} random values and ${fingerprints.size} token fingerprints absent from ${report.outputsScanned.length} outputs and ${files.length} files`);
} catch {
  failure ??= 'Tooling smoke artifact scan failed';
} finally {
  // The fingerprint folder goes on every exit path, after the scan.
  await removeTokenFingerprintStore(tokens).catch(() => {
    failure ??= 'Token fingerprint folder removal failed';
  });
}

for (const [signal, handler] of handlers) process.off(signal, handler);
if (received !== undefined) process.exitCode = signalCodes[received];
else if (failure !== undefined) {
  console.error(failure);
  process.exitCode = 1;
} else console.log('TOOL-007 passed against the real database, backend, frontend, and browser under serve.');
