import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { access } from 'node:fs/promises';
import { connect } from 'node:net';
import { createApp } from '../../../apps/backend/src/app';
import {
  createReadinessCheck,
  READINESS_DEADLINE_MS,
  type ReadinessOutcome,
} from '../../../apps/backend/src/features/development/readiness.service';

// READY-001 and READY-002 (spec 0006, build plan step 2): the fixed handler order of GET /api/readiness, the single
// active check per application instance, the 5,000 ms deadline, and the release of the marker without a log.
const root = new URL('../../../', import.meta.url).pathname;
const INVALID_REQUEST = '{"error":"Invalid request"}';
const NOT_FOUND = '{"error":"Not found"}';

function expectIsoTime(value: unknown): void {
  expect(typeof value).toBe('string');
  expect(Number.isNaN(Date.parse(value as string))).toBe(false);
  expect((value as string).endsWith('Z')).toBe(true);
  expect(new Date(value as string).toISOString()).toBe(value as string);
}

function expectUnavailable(outcome: unknown): void {
  expect(Object.keys(outcome as object).sort()).toEqual(['checkedAt', 'status']);
  expect((outcome as Record<string, unknown>)['status']).toBe('unavailable');
  expectIsoTime((outcome as Record<string, unknown>)['checkedAt']);
}

function expectAvailable(outcome: unknown, appliedMigrations: number): void {
  expect(Object.keys(outcome as object).sort()).toEqual(['appliedMigrations', 'checkedAt', 'status']);
  expect((outcome as Record<string, unknown>)['status']).toBe('available');
  expect((outcome as Record<string, unknown>)['appliedMigrations']).toBe(appliedMigrations);
  expectIsoTime((outcome as Record<string, unknown>)['checkedAt']);
}

const handle = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));

test('READY-001 createApp development without options answers 503 with the exact body and no-store', async () => {
  const response = await handle(createApp('development'), '/api/readiness');
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toContain('application/json');
  expectUnavailable(await response.json());
});

test('READY-001 a query string gets 400 with the exact body and no-store before any check', async () => {
  const app = createApp('development');
  for (const path of ['/api/readiness?x=1', '/api/readiness?a']) {
    const response = await handle(app, path);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(INVALID_REQUEST);
  }
});

test('READY-001 HEAD and a trailing slash get 404 from the handler with no-store, POST gets 404 through onError', async () => {
  const app = createApp('development');
  const head = await handle(app, '/api/readiness', { method: 'HEAD' });
  expect(head.status).toBe(404);
  expect(head.headers.get('cache-control')).toBe('no-store');
  expect(await head.text()).toBe('');
  const slash = await handle(app, '/api/readiness/');
  expect(slash.status).toBe(404);
  expect(slash.headers.get('cache-control')).toBe('no-store');
  expect(await slash.text()).toBe(NOT_FOUND);
  const post = await handle(app, '/api/readiness', { method: 'POST' });
  expect(post.status).toBe(404);
  expect(await post.json()).toEqual({ error: 'Not found' });
});

test('READY-001 GET /api/status stays 200 beside the readiness route', async () => {
  const response = await handle(createApp('development'), '/api/status');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('READY-001 createApp production answers 404 for /api/readiness through app.handle', async () => {
  const response = await handle(createApp('production'), '/api/readiness');
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Not found' });
});

interface RawResponse { status: number; headers: Record<string, string>; body: string }

/** Parses one complete HTTP/1.1 response with a Content-Length body, or returns undefined while it is incomplete. */
function parseRaw(data: Buffer): RawResponse | undefined {
  const end = data.indexOf('\r\n\r\n');
  if (end < 0) return undefined;
  const [statusLine = '', ...lines] = data.subarray(0, end).toString('latin1').split('\r\n');
  const headers = Object.fromEntries(lines.map((line) => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  }));
  const length = Number(headers['content-length'] ?? 0);
  const body = data.subarray(end + 4);
  if (body.length < length) return undefined;
  return { status: Number(statusLine.split(' ')[1]), headers, body: body.subarray(0, length).toString('utf8') };
}

/**
 * Sends only the request head over a raw socket, with no body byte and no chunk terminator, then closes the socket
 * after the response or after 2 seconds at most.
 */
function rawRequest(port: number, head: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let done = false;
    const socket = connect({ host: '127.0.0.1', port });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const parsed = parseRaw(data);
      if (parsed) resolve(parsed);
      else reject(new Error('No complete HTTP response within 2 seconds'));
    };
    const timer = setTimeout(finish, 2000);
    socket.on('connect', () => socket.write(head));
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (parseRaw(data)) finish();
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

test('READY-001 a real listener answers 400 to body headers on GET and accepts Content-Length 0 and an empty ?', async () => {
  // The same listen options as apps/backend/src/index.ts.
  const app = createApp('development').listen({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024, idleTimeout: 10 });
  try {
    const port = app.server!.port!;
    const request = (target: string, header = '') => rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${header}\r\n`);
    for (const header of ['Content-Length: 2\r\n', 'Transfer-Encoding: chunked\r\n']) {
      const response = await request('/api/readiness', header);
      expect(response.status).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toBe(INVALID_REQUEST);
    }
    for (const [target, header] of [['/api/readiness', 'Content-Length: 0\r\n'], ['/api/readiness?', '']] as const) {
      const response = await request(target, header);
      expect(response.status).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expectUnavailable(JSON.parse(response.body));
    }
  } finally {
    await app.stop(true);
  }
}, 15_000);

test('READY-001 a Host header that forms no absolute URL keeps the fixed order 404, 400, 503 instead of a 500', async () => {
  // Bun gives the handler a relative request.url (for example `/api/readiness`) for these Host values.
  const app = createApp('development').listen({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024, idleTimeout: 10 });
  try {
    const port = app.server!.port!;
    for (const host of ['x?', '', 'a b']) {
      const request = (target: string) => rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
      const valid = await request('/api/readiness');
      expect(valid.status, `Host ${JSON.stringify(host)}`).toBe(503);
      expect(valid.headers['cache-control']).toBe('no-store');
      expectUnavailable(JSON.parse(valid.body));
      const query = await request('/api/readiness?x=1');
      expect(query.status, `Host ${JSON.stringify(host)} with a query`).toBe(400);
      expect(query.headers['cache-control']).toBe('no-store');
      expect(query.body).toBe(INVALID_REQUEST);
      // With a relative URL Elysia answers the trailing slash itself through onError, like POST, so only the 404 and
      // its body are fixed here.
      const slash = await request('/api/readiness/');
      expect(slash.status, `Host ${JSON.stringify(host)} with a trailing slash`).toBe(404);
      expect(JSON.parse(slash.body)).toEqual({ error: 'Not found' });
    }
  } finally {
    await app.stop(true);
  }
}, 15_000);

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = server.port!;
  await server.stop(true);
  return port;
}

for (const entry of ['apps/backend/src/index.ts', 'dist/backend/index.js']) {
  test(`READY-001 production backend process from ${entry} answers 404 for /api/readiness`, async () => {
    // A missing bundle fails with a fixed message instead of being skipped; `bun run build:backend` creates it.
    if (entry.startsWith('dist/') && !(await access(`${root}${entry}`).then(() => true, () => false))) {
      throw new Error('dist/backend/index.js is missing; run bun run build:backend first');
    }
    const port = await unusedPort();
    const child = Bun.spawn([process.execPath, '--no-env-file', entry], {
      cwd: root, env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) },
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      let response: Response | undefined;
      for (const limit = Date.now() + 5000; !response && Date.now() < limit;) {
        try { response = await fetch(`http://127.0.0.1:${port}/api/readiness`); } catch { await Bun.sleep(20); }
      }
      if (!response) throw new Error('Production backend never became ready');
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found' });
      child.kill('SIGTERM');
      expect(await child.exited).toBe(0);
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    }
  }, 15_000);
}

// READY-002: the check factory with a count function the test controls, a small deadline, an unhandledRejection
// listener, and console.log, console.warn, and console.error replaced by recorders.
const consoleCalls: string[] = [];
const rejections: unknown[] = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
const onRejection = (reason: unknown) => { rejections.push(reason); };

beforeEach(() => {
  consoleCalls.length = 0;
  rejections.length = 0;
  console.log = (...args: unknown[]) => { consoleCalls.push(`log ${args.length}`); };
  console.warn = (...args: unknown[]) => { consoleCalls.push(`warn ${args.length}`); };
  console.error = (...args: unknown[]) => { consoleCalls.push(`error ${args.length}`); };
  process.on('unhandledRejection', onRejection);
});

afterEach(() => {
  Object.assign(console, originalConsole);
  process.off('unhandledRejection', onRejection);
});

/** A count function whose every call stays pending until the test settles it. */
function controlledCount() {
  const calls: { resolve: (value: number) => void; reject: (reason: unknown) => void }[] = [];
  const count = () => new Promise<number>((resolve, reject) => { calls.push({ resolve, reject }); });
  return { count, calls };
}

/** Lets late settlements, their handlers, and unhandled rejection detection run. */
const settle = () => Bun.sleep(30);

function expectQuiet(): void {
  expect(rejections).toEqual([]);
  expect(consoleCalls).toEqual([]);
}

test('READY-002 the backend deadline constant is 5,000 ms', () => {
  expect(READINESS_DEADLINE_MS).toBe(5000);
});

test('READY-002 without a count function every call answers unavailable and never busy', async () => {
  const check = createReadinessCheck(undefined, { deadlineMs: 50 });
  const outcomes = await Promise.all([check(), check(), check()]);
  for (const outcome of outcomes) expectUnavailable(outcome);
  expectQuiet();
});

test('READY-002 two concurrent calls run one count and give one busy', async () => {
  const { count, calls } = controlledCount();
  const check = createReadinessCheck(count, { deadlineMs: 1000 });
  const first = check();
  const second = check();
  expect(calls).toHaveLength(1);
  expect(await second).toEqual({ status: 'busy' });
  calls[0]!.resolve(3);
  expectAvailable(await first, 3);
  await settle();
  expect(calls).toHaveLength(1);
  expectQuiet();
});

test('READY-002 each check instance owns its own marker, so a busy instance never blocks another', async () => {
  const first = controlledCount();
  const second = controlledCount();
  const checkOne = createReadinessCheck(first.count, { deadlineMs: 1000 });
  const checkTwo = createReadinessCheck(second.count, { deadlineMs: 1000 });
  const pendingOne = checkOne();
  expect(await checkOne()).toEqual({ status: 'busy' });
  const pendingTwo = checkTwo();
  expect(second.calls).toHaveLength(1);
  first.calls[0]!.resolve(1);
  second.calls[0]!.resolve(2);
  expectAvailable(await pendingOne, 1);
  expectAvailable(await pendingTwo, 2);
  expectQuiet();
});

test('READY-002 a count that rejects before the deadline gives unavailable after exactly one call, without retry', async () => {
  let calls = 0;
  const check = createReadinessCheck(() => {
    calls += 1;
    return Promise.reject(new Error('secret-marker 57014 permission denied'));
  }, { deadlineMs: 200 });
  expectUnavailable(await check());
  await settle();
  expect(calls).toBe(1);
  // The marker was released, so the next call runs the count again.
  expectUnavailable(await check());
  expect(calls).toBe(2);
  expectQuiet();
});

test('READY-002 a count that throws synchronously maps to unavailable and releases the marker', async () => {
  let calls = 0;
  const check = createReadinessCheck(() => {
    calls += 1;
    throw new Error('secret-marker synchronous failure');
  }, { deadlineMs: 200 });
  expectUnavailable(await check());
  await settle();
  expectUnavailable(await check());
  expect(calls).toBe(2);
  expectQuiet();
});

test('READY-002 a hanging count gives unavailable at the deadline, stays busy until it ends, then runs a new query', async () => {
  const { count, calls } = controlledCount();
  const deadlineMs = 100;
  const check = createReadinessCheck(count, { deadlineMs });
  const started = performance.now();
  const outcome = await check();
  const elapsed = performance.now() - started;
  expectUnavailable(outcome);
  expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 1);
  expect(elapsed).toBeLessThan(deadlineMs + 100);
  expect(await check()).toEqual({ status: 'busy' });
  expect(calls).toHaveLength(1);
  calls[0]!.resolve(1);
  await settle();
  const next = check();
  expect(calls).toHaveLength(2);
  calls[1]!.resolve(2);
  expectAvailable(await next, 2);
  expectQuiet();
});

/**
 * A stand in for the backend pool that only records which properties anything reads from it. It is a tripwire, not a
 * database double: it answers nothing, so a request that reaches it fails like an unusable pool would.
 */
function tripwirePool(): { pool: SQL; touched: string[] } {
  const touched: string[] = [];
  const pool = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); return undefined; } }) as unknown as SQL;
  return { pool, touched };
}

test('READY-001 createApp production with a pool answers 404 for /api/readiness and never touches the pool', async () => {
  const { pool, touched } = tripwirePool();
  const app = createApp('production', { database: pool });
  for (const [path, method] of [['/api/readiness', 'GET'], ['/api/readiness?x=1', 'GET'], ['/api/readiness', 'POST']] as const) {
    const response = await handle(app, path, { method });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  }
  const head = await handle(app, '/api/readiness', { method: 'HEAD' });
  expect(head.status).toBe(404);
  expect(touched).toEqual([]);
  expectQuiet();
});

test('READY-001 in development the 404 and 400 answers come before the pool, and only a valid GET reaches it', async () => {
  const { pool, touched } = tripwirePool();
  const app = createApp('development', { database: pool });
  const head = await handle(app, '/api/readiness', { method: 'HEAD' });
  expect(head.status).toBe(404);
  expect(head.headers.get('cache-control')).toBe('no-store');
  const slash = await handle(app, '/api/readiness/');
  expect(slash.status).toBe(404);
  expect(await slash.text()).toBe(NOT_FOUND);
  expect((await handle(app, '/api/readiness', { method: 'POST' })).status).toBe(404);
  for (const path of ['/api/readiness?x=1', '/api/readiness?a', '/api/readiness?__proto__=1']) {
    const response = await handle(app, path);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(INVALID_REQUEST);
  }
  expect(touched).toEqual([]);
  // Positive control: the valid GET is the only request that reaches the pool. The tripwire cannot run a transaction,
  // so the failure maps to the same safe 503 body, without a log and without detail.
  const valid = await handle(app, '/api/readiness');
  expect(touched.length).toBeGreaterThan(0);
  expect(valid.status).toBe(503);
  expect(valid.headers.get('cache-control')).toBe('no-store');
  expectUnavailable(await valid.json());
  await settle();
  expectQuiet();
});

const SET_LIMIT_SQL = "SET LOCAL statement_timeout = '2s'";
const COUNT_SQL = 'SELECT count(*)::integer AS applied FROM common.schema_migrations';

/**
 * A stub pool for route tests only: `begin(callback)` runs the callback with a tagged template transaction that records
 * each statement. The count statement answers through `answer`, which the test replaces per check. It proves the HTTP
 * mapping of the route without Docker; it is not database proof, which stays with READY-008.
 */
function stubPool() {
  const statements: string[] = [];
  let begins = 0;
  let answer: () => Promise<unknown[]> = () => Promise.resolve([{ applied: 0 }]);
  const transaction = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push(values.length === 0 ? text : `${text} with values`);
    return text === COUNT_SQL ? answer() : Promise.resolve([]);
  };
  const pool = { begin: (callback: (sql: typeof transaction) => Promise<unknown>) => { begins += 1; return callback(transaction); } } as unknown as SQL;
  return { pool, statements, begins: () => begins, setAnswer: (next: () => Promise<unknown[]>) => { answer = next; } };
}

test('READY-001 route test with a stub pool (not database proof): 200 with exactly three keys, 429 while held, 503 after a rejection, all no-store', async () => {
  const stub = stubPool();
  const app = createApp('development', { database: stub.pool });
  let release: (rows: unknown[]) => void = () => undefined;
  stub.setAnswer(() => new Promise((resolve) => { release = resolve; }));
  const held = handle(app, '/api/readiness');
  for (let waited = 0; !stub.statements.includes(COUNT_SQL) && waited < 1000; waited += 5) await Bun.sleep(5);
  expect(stub.statements).toEqual([SET_LIMIT_SQL, COUNT_SQL]);

  const busy = await handle(app, '/api/readiness');
  expect(busy.status).toBe(429);
  expect(busy.headers.get('cache-control')).toBe('no-store');
  expect(busy.headers.get('content-type')).toContain('application/json');
  expect(await busy.text()).toBe('{"status":"busy"}');
  expect(stub.begins()).toBe(1);

  release([{ applied: 3 }]);
  const available = await held;
  expect(available.status).toBe(200);
  expect(available.headers.get('cache-control')).toBe('no-store');
  expect(available.headers.get('content-type')).toContain('application/json');
  expectAvailable(await available.json(), 3);

  stub.setAnswer(() => Promise.reject(new Error('secret-marker 57014 canceling statement due to statement timeout')));
  const unavailable = await handle(app, '/api/readiness');
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get('cache-control')).toBe('no-store');
  const unavailableText = await unavailable.text();
  expect(unavailableText).not.toContain('secret-marker');
  expectUnavailable(JSON.parse(unavailableText));

  stub.setAnswer(() => Promise.resolve([{ applied: 0 }]));
  const empty = await handle(app, '/api/readiness');
  expect(empty.status).toBe(200);
  expectAvailable(await empty.json(), 0);
  // One transaction per check, each with the fixed statements in order, and no retry after the rejection.
  expect(stub.begins()).toBe(3);
  expect(stub.statements).toEqual([SET_LIMIT_SQL, COUNT_SQL, SET_LIMIT_SQL, COUNT_SQL, SET_LIMIT_SQL, COUNT_SQL]);
  await settle();
  expectQuiet();
});

test('READY-002 checkedAt of available comes from the server clock when the count is known', async () => {
  const { count, calls } = controlledCount();
  const check = createReadinessCheck(count, { deadlineMs: 1000 });
  const pending = check();
  await Bun.sleep(20);
  const resolvedAfter = Date.now();
  calls[0]!.resolve(5);
  const outcome = await pending;
  const doneBy = Date.now();
  expectAvailable(outcome, 5);
  const at = Date.parse((outcome as { checkedAt: string }).checkedAt);
  expect(at).toBeGreaterThanOrEqual(resolvedAfter);
  expect(at).toBeLessThanOrEqual(doneBy);
  expectQuiet();
});

test('READY-002 checkedAt of unavailable comes from the moment the failure or the deadline is known', async () => {
  const failing = controlledCount();
  const failCheck = createReadinessCheck(failing.count, { deadlineMs: 1000 });
  const failed = failCheck();
  await Bun.sleep(20);
  const rejectedAfter = Date.now();
  failing.calls[0]!.reject(new Error('secret-marker connection refused'));
  const failure = await failed;
  expectUnavailable(failure);
  expect(Date.parse((failure as { checkedAt: string }).checkedAt)).toBeGreaterThanOrEqual(rejectedAfter);

  const hanging = controlledCount();
  const deadlineMs = 60;
  const hangCheck = createReadinessCheck(hanging.count, { deadlineMs });
  const startedAt = Date.now();
  const timedOut = await hangCheck();
  const doneBy = Date.now();
  expectUnavailable(timedOut);
  const at = Date.parse((timedOut as { checkedAt: string }).checkedAt);
  // Timers may fire up to a millisecond early when Date.now() rounds; the time is never the start of the check.
  expect(at).toBeGreaterThanOrEqual(startedAt + deadlineMs - 2);
  expect(at).toBeLessThanOrEqual(doneBy);
  hanging.calls[0]!.resolve(0);
  await settle();
  expectQuiet();
});

test('READY-002 a count of 0 is a valid available result, not a failure', async () => {
  const check = createReadinessCheck(() => Promise.resolve(0), { deadlineMs: 200 });
  expectAvailable(await check(), 0);
  expectQuiet();
});

test('READY-002 many calls while one check is active all answer busy at once and never start a second count', async () => {
  const { count, calls } = controlledCount();
  const check = createReadinessCheck(count, { deadlineMs: 1000 });
  const first = check();
  const started = performance.now();
  const others = await Promise.all(Array.from({ length: 49 }, () => check()));
  expect(performance.now() - started).toBeLessThan(100);
  for (const outcome of others) expect(outcome).toStrictEqual({ status: 'busy' });
  expect(calls).toHaveLength(1);
  calls[0]!.resolve(2);
  expectAvailable(await first, 2);
  expectQuiet();
});

test('READY-002 the deadline timer is cleared on success, rejection, and a synchronous throw, and only fires on the deadline path', async () => {
  // setTimeout and clearTimeout are replaced by recorders for timers with the deadline values of this test only.
  const deadlines = new Set([4321, 25]);
  const timers: { ms: number; handle: unknown; fired: boolean }[] = [];
  const cleared = new Set<unknown>();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (!deadlines.has(ms ?? 0)) return originalSetTimeout(handler, ms, ...args);
    const entry = { ms: ms ?? 0, handle: undefined as unknown, fired: false };
    entry.handle = originalSetTimeout((...inner: unknown[]) => { entry.fired = true; handler(...inner); }, ms, ...args);
    timers.push(entry);
    return entry.handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(handle);
    originalClearTimeout(handle);
  }) as typeof clearTimeout;
  try {
    const paths: [string, () => Promise<number>][] = [
      ['success', () => Promise.resolve(4)],
      ['rejection', () => Promise.reject(new Error('secret-marker rejection'))],
      ['synchronous throw', () => { throw new Error('secret-marker throw'); }],
    ];
    for (const [name, count] of paths) {
      await createReadinessCheck(count, { deadlineMs: 4321 })();
      const timer = timers.at(-1);
      expect(timers, name).toHaveLength(paths.findIndex(([path]) => path === name) + 1);
      expect(timer?.ms, name).toBe(4321);
      expect(cleared.has(timer?.handle), `${name} clears its deadline timer`).toBe(true);
      expect(timer?.fired, name).toBe(false);
    }
    const { count, calls } = controlledCount();
    expectUnavailable(await createReadinessCheck(count, { deadlineMs: 25 })());
    const deadline = timers.at(-1);
    expect(deadline?.ms).toBe(25);
    expect(deadline?.fired).toBe(true);
    calls[0]!.resolve(1);
    await settle();
    // No other timer of these deadlines was started, so nothing is left pending.
    expect(timers).toHaveLength(4);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  expectQuiet();
});

for (const late of ['rejects', 'resolves'] as const) {
  test(`READY-002 a count that ${late} after the deadline gives one unavailable, releases the marker, and stays silent`, async () => {
    const { count, calls } = controlledCount();
    const check = createReadinessCheck(count, { deadlineMs: 50 });
    const received: ReadinessOutcome[] = [];
    await check().then((outcome) => { received.push(outcome); });
    expect(received).toHaveLength(1);
    expectUnavailable(received[0]);
    // The deadline answered, but the marker stays until the count settles.
    expect(await check()).toEqual({ status: 'busy' });
    if (late === 'rejects') calls[0]!.reject(new Error('secret-marker late failure 57014'));
    else calls[0]!.resolve(7);
    await settle();
    expect(received).toHaveLength(1);
    const next = check();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(1);
    expectAvailable(await next, 1);
    expectQuiet();
  });
}
