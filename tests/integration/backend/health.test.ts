import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { connect } from 'node:net';
import { createApp } from '../../../apps/backend/src/app';
import { migrationApplied, REQUIRED_MIGRATION } from '../../../apps/backend/src/features/health/health.queries';
import { createHealthReadiness, type HealthReadiness } from '../../../apps/backend/src/features/health/health.service';
import { READINESS_DEADLINE_MS } from '../../../apps/backend/src/features/development/readiness.service';
import { requestTarget, strictGet } from '../../../apps/backend/src/plugins/request-guard';

// DEP-002 (spec 0012, AC-4): GET /health/live and GET /health/ready on both compositions. `live` never touches the pool;
// `ready` runs at most one probe per application instance, shares its result before the deadline, answers
// unavailable at once after the deadline while the probe is still pending, and starts a new probe only once the old
// one settled. Both routes keep the guard order of spec 0006 and `Cache-Control: no-store`, and production still
// answers 404 for the development routes and OpenAPI. The probe and the deadline are injected; DEP-009 runs the real
// query on PostgreSQL 18.
const LIVE = '{"status":"live"}';
const READY = '{"status":"ready"}';
const UNAVAILABLE = '{"status":"unavailable"}';
const NOT_FOUND = '{"error":"Not found"}';
const INVALID_REQUEST = '{"error":"Invalid request"}';
const MODES = ['production', 'development'] as const;
const PATHS = ['/health/live', '/health/ready'] as const;

const handle = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));

// Every console call and unhandled rejection is recorded: the health routes and the readiness factory stay silent.
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

/** Lets late settlements, their handlers, and unhandled rejection detection run. */
const settle = () => Bun.sleep(30);

function expectQuiet(): void {
  expect(rejections).toEqual([]);
  expect(consoleCalls).toEqual([]);
}

/** A pool stand in that records every property it is asked for; `live` must never ask for one. */
function untouchedPool(): { pool: SQL; touched: string[] } {
  const touched: string[] = [];
  const pool = new Proxy(function pool() {}, {
    get: (_target, key) => { touched.push(String(key)); throw new Error('pool touched'); },
    apply: () => { touched.push('call'); throw new Error('pool touched'); },
  }) as unknown as SQL;
  return { pool, touched };
}

type Statement = { text: string; values: unknown[] };

/**
 * A pool stand in whose `begin` runs the callback with a tagged template transaction: it records each statement and
 * answers the EXISTS query with `applied`, or rejects with `failure`.
 */
function fakePool(outcome: { applied?: unknown; failure?: Error }): { pool: SQL; statements: Statement[]; begins: () => number } {
  const statements: Statement[] = [];
  let begins = 0;
  const transaction = (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join('$'), values });
    if (strings.join('').includes('EXISTS')) {
      return outcome.failure ? Promise.reject(outcome.failure) : Promise.resolve([{ applied: outcome.applied }]);
    }
    return Promise.resolve([]);
  };
  const pool = { begin: (callback: (sql: typeof transaction) => Promise<unknown>) => { begins += 1; return callback(transaction); } } as unknown as SQL;
  return { pool, statements, begins: () => begins };
}

/** A probe whose every call stays pending until the test settles it. */
function controlledProbe() {
  const calls: { resolve: (value: boolean) => void; reject: (reason: unknown) => void }[] = [];
  const probe = () => new Promise<boolean>((resolve, reject) => { calls.push({ resolve, reject }); });
  return { probe, calls };
}

test('DEP-002 GET /health/live answers 200 {"status":"live"} with no-store on both compositions without touching the pool', async () => {
  for (const mode of MODES) {
    const { pool, touched } = untouchedPool();
    const app = createApp(mode, { database: pool });
    for (let index = 0; index < 3; index += 1) {
      const response = await handle(app, '/health/live');
      expect(response.status, mode).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.text()).toBe(LIVE);
    }
    expect(touched, mode).toEqual([]);
  }
  expectQuiet();
});

test('DEP-002 GET /health/ready without a pool answers 503 {"status":"unavailable"} with no-store on both compositions', async () => {
  for (const mode of MODES) {
    const app = createApp(mode);
    const responses = await Promise.all([handle(app, '/health/ready'), handle(app, '/health/ready')]);
    for (const response of responses) {
      expect(response.status, mode).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(UNAVAILABLE);
    }
  }
  expectQuiet();
});

test('DEP-002 /health/ready answers 200 only for applied true, and 503 for false, a value that is not a boolean, and a failed query', async () => {
  const cases: [string, { applied?: unknown; failure?: Error }, number, string][] = [
    ['true', { applied: true }, 200, READY],
    ['false', { applied: false }, 503, UNAVAILABLE],
    ['string true', { applied: 'true' }, 503, UNAVAILABLE],
    ['null', { applied: null }, 503, UNAVAILABLE],
    ['failed query', { failure: new Error('connection refused postgres://secret') }, 503, UNAVAILABLE],
  ];
  for (const mode of MODES) {
    for (const [label, outcome, status, body] of cases) {
      const { pool } = fakePool(outcome);
      const response = await handle(createApp(mode, { database: pool }), '/health/ready');
      expect(response.status, `${mode} ${label}`).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).toBe(body);
      expect(text).not.toContain('secret');
    }
  }
  await settle();
  expectQuiet();
});

test('DEP-002 the readiness query runs in one transaction: SET LOCAL statement_timeout first, then EXISTS with the migration name as a parameter', async () => {
  const { pool, statements, begins } = fakePool({ applied: true });
  expect(await migrationApplied(pool, REQUIRED_MIGRATION)).toBe(true);
  expect(begins()).toBe(1);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toEqual({ text: "SET LOCAL statement_timeout = '2s'", values: [] });
  expect(statements[1]!.text).toBe('SELECT EXISTS (SELECT 1 FROM common.schema_migrations WHERE name = $) AS applied');
  expect(statements[1]!.values).toEqual([REQUIRED_MIGRATION]);
  expect(REQUIRED_MIGRATION).toMatch(/^[0-9]{4}-[a-z0-9-]+\.sql$/);
});

test('DEP-002 the factory maps true to ready and false, a rejection, a synchronous throw, and the deadline to unavailable', async () => {
  expect(READINESS_DEADLINE_MS).toBe(5000);
  const outcome = (probe: () => Promise<boolean>) => createHealthReadiness(probe, { deadlineMs: 40 })();
  expect(await outcome(() => Promise.resolve(true))).toBe('ready');
  expect(await outcome(() => Promise.resolve(false))).toBe('unavailable');
  expect(await outcome(() => Promise.reject(new Error('failed')))).toBe('unavailable');
  expect(await outcome(() => { throw new Error('thrown'); })).toBe('unavailable');
  const started = performance.now();
  expect(await outcome(() => new Promise<boolean>(() => {}))).toBe('unavailable');
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(35);
  expect(elapsed).toBeLessThan(1000);
  expect(await createHealthReadiness(undefined, { deadlineMs: 40 })()).toBe('unavailable');
  await settle();
  expectQuiet();
});

test('DEP-002 two callers during one check share one probe and its result', async () => {
  const { probe, calls } = controlledProbe();
  const readiness = createHealthReadiness(probe, { deadlineMs: 1000 });
  const first = readiness();
  const second = readiness();
  expect(calls).toHaveLength(1);
  calls[0]!.resolve(true);
  expect(await Promise.all([first, second])).toEqual(['ready', 'ready']);
  // The marker was released when the probe settled, so the next caller starts a new probe.
  const third = readiness();
  expect(calls).toHaveLength(2);
  calls[1]!.resolve(false);
  expect(await third).toBe('unavailable');
  await settle();
  expectQuiet();
});

test('DEP-002 a probe that never settles is called once: callers before the deadline share unavailable at the deadline, a caller after it gets unavailable at once', async () => {
  const { probe, calls } = controlledProbe();
  const readiness = createHealthReadiness(probe, { deadlineMs: 60 });
  const started = performance.now();
  const before = [readiness(), readiness()];
  await Bun.sleep(20);
  before.push(readiness());
  const early: HealthReadiness[] = await Promise.all(before);
  expect(early).toEqual(['unavailable', 'unavailable', 'unavailable']);
  expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  for (let index = 0; index < 5; index += 1) {
    const asked = performance.now();
    expect(await readiness()).toBe('unavailable');
    expect(performance.now() - asked).toBeLessThan(20);
    await Bun.sleep(30);
  }
  expect(calls).toHaveLength(1);
  // The late result is consumed without a log; only then does a new probe start.
  calls[0]!.resolve(true);
  await settle();
  const next = readiness();
  expect(calls).toHaveLength(2);
  calls[1]!.resolve(true);
  expect(await next).toBe('ready');
  await settle();
  expectQuiet();
});

test('DEP-002 a probe that rejects after the deadline releases the marker without an unhandled rejection or a log', async () => {
  const { probe, calls } = controlledProbe();
  const readiness = createHealthReadiness(probe, { deadlineMs: 30 });
  expect(await readiness()).toBe('unavailable');
  expect(await readiness()).toBe('unavailable');
  expect(calls).toHaveLength(1);
  calls[0]!.reject(new Error('late failure'));
  await settle();
  const next = readiness();
  expect(calls).toHaveLength(2);
  calls[1]!.resolve(true);
  expect(await next).toBe('ready');
  await settle();
  expectQuiet();
});

test('DEP-002 the routes share one probe per application instance and a second instance has its own', async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  let begins = 0;
  const pool = {
    begin: () => {
      begins += 1;
      return new Promise((resolve) => { if (begins === 1) resolveFirst = resolve; else resolve(true); });
    },
  } as unknown as SQL;
  const app = createApp('production', { database: pool });
  const pending = [handle(app, '/health/ready'), handle(app, '/health/ready')];
  await Bun.sleep(10);
  expect(begins).toBe(1);
  const other = await handle(createApp('production', { database: pool }), '/health/ready');
  expect(other.status).toBe(200);
  expect(begins).toBe(2);
  resolveFirst(true);
  for (const response of await Promise.all(pending)) {
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(READY);
  }
  await settle();
  expectQuiet();
});

test('DEP-002 HEAD, a trailing slash, and POST get 404 and a query string gets 400, with no-store from the handler, on both compositions', async () => {
  for (const mode of MODES) {
    for (const path of PATHS) {
      const { pool, touched } = untouchedPool();
      const app = createApp(mode, { database: pool });
      const head = await handle(app, path, { method: 'HEAD' });
      expect(head.status, `${mode} HEAD ${path}`).toBe(404);
      expect(head.headers.get('cache-control')).toBe('no-store');
      expect(await head.text()).toBe('');
      const slash = await handle(app, `${path}/`);
      expect(slash.status, `${mode} ${path}/`).toBe(404);
      expect(slash.headers.get('cache-control')).toBe('no-store');
      expect(await slash.text()).toBe(NOT_FOUND);
      const post = await handle(app, path, { method: 'POST' });
      expect(post.status, `${mode} POST ${path}`).toBe(404);
      expect(await post.text()).toBe(NOT_FOUND);
      for (const query of ['?x=1', '?a']) {
        const response = await handle(app, `${path}${query}`);
        expect(response.status, `${mode} ${path}${query}`).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(INVALID_REQUEST);
      }
      expect(touched, `${mode} ${path}`).toEqual([]);
    }
  }
  expectQuiet();
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

/** Sends only the request head over a raw socket, then closes it after the response or after 2 seconds at most. */
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

test('DEP-002 a real listener answers 400 to body headers on GET and accepts Content-Length 0 and an empty ?, on both compositions', async () => {
  for (const mode of MODES) {
    // The same listen options as apps/backend/src/index.ts.
    const app = createApp(mode).listen({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024, idleTimeout: 10 });
    try {
      const port = app.server!.port!;
      const request = (target: string, header = '') => rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${header}\r\n`);
      for (const path of PATHS) {
        for (const header of ['Content-Length: 2\r\n', 'Transfer-Encoding: chunked\r\n']) {
          const response = await request(path, header);
          expect(response.status, `${mode} ${path} ${header.trim()}`).toBe(400);
          expect(response.headers['cache-control']).toBe('no-store');
          expect(response.body).toBe(INVALID_REQUEST);
        }
        const expected = path === '/health/live' ? [200, LIVE] : [503, UNAVAILABLE];
        for (const [target, header] of [[path, 'Content-Length: 0\r\n'], [`${path}?`, '']] as const) {
          const response = await request(target, header);
          expect(response.status, `${mode} ${target}`).toBe(expected[0] as number);
          expect(response.headers['cache-control']).toBe('no-store');
          expect(response.body).toBe(expected[1] as string);
        }
      }
    } finally {
      await app.stop(true);
    }
  }
}, 15_000);

test('DEP-002 a Host that Bun keeps in a request URL that new URL refuses gets the same 200, 400, and 503 instead of a 500, on both compositions', async () => {
  // Bun 1.4.2 writes request.url as `http://<Host><target>`, and `new URL` refuses these authorities; the guard reads
  // the request target only (plugins/request-guard.ts, requestTarget).
  const hosts = ['h%5e.example', 'h%zz', '%', '[::1h', 'h:99999', 'a:b:c'];
  for (const mode of MODES) {
    const app = createApp(mode).listen({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024, idleTimeout: 10 });
    try {
      const port = app.server!.port!;
      for (const host of hosts) {
        const request = (target: string) => rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
        for (const [target, status, body] of [['/health/live', 200, LIVE], ['/health/ready', 503, UNAVAILABLE], ['/health/live?x=1', 400, INVALID_REQUEST], ['/health/ready?x=1', 400, INVALID_REQUEST]] as const) {
          const response = await request(target);
          expect(response.status, `${mode} ${target} Host ${host}`).toBe(status);
          expect(response.headers['cache-control']).toBe('no-store');
          expect(response.body).toBe(body);
        }
      }
    } finally {
      await app.stop(true);
    }
  }
  expectQuiet();
}, 15_000);

test('DEP-002 requestTarget reads only the request target of every request.url form Bun 1.4.2 writes, never throws, and always has the authority localhost', () => {
  // Rows: [request.url as Bun writes it, pathname, search]. Bun writes `http://<Host><target>` for a Host it keeps
  // (also one `new URL` refuses), and the bare target for a Host with a space, `/`, `@`, `?`, `#`, or `\`, and for
  // CONNECT (probe of Bun 1.4.2 during /test, 2026-10-06).
  const rows: [string, string, string][] = [
    ['http://127.0.0.1:8888/health/live', '/health/live', ''],
    ['http://h%5e.example/health/ready?x=1', '/health/ready', '?x=1'],
    ['http://h%zz/health/live', '/health/live', ''],
    ['http://[::1h/health/live', '/health/live', ''],
    ['http://h:99999/health/live', '/health/live', ''],
    ['http://a:b:c/health/ready', '/health/ready', ''],
    ['HTTP://H/health/ready', '/health/ready', ''],
    ['http://h/health/live#fragment', '/health/live', ''],
    ['http://h', '/', ''],
    ['/health/live?q=1', '/health/live', '?q=1'],
    ['/health/ready?', '/health/ready', ''],
    ['//evil.example/health/live', '//evil.example/health/live', ''],
    ['http://h//evil.example/health/live', '//evil.example/health/live', ''],
    ['?x=1', '/', '?x=1'],
    ['a:1', '/a:1', ''],
    ['', '/', ''],
  ];
  for (const [url, pathname, search] of rows) {
    const target = requestTarget(url);
    expect(target.host, url).toBe('localhost');
    expect(target.pathname, url).toBe(pathname);
    expect(target.search, url).toBe(search);
  }
});

test('DEP-002 strictGet gives not_found before invalid, and null only for a GET of the exact path without query or body headers, whatever the Host', () => {
  // A plain object stands in for Request, so request.url can take the bare and the refused forms Bun writes.
  const request = (method: string, url: string, headers: Record<string, string> = {}) => ({ method, url, headers: new Headers(headers) }) as unknown as Request;
  for (const url of ['http://localhost/health/ready', 'http://h%5e.example/health/ready', '/health/ready']) {
    expect(strictGet(request('GET', url), '/health/ready'), url).toBeNull();
    expect(strictGet(request('GET', url, { 'content-length': '0' }), '/health/ready'), url).toBeNull();
    expect(strictGet(request('HEAD', url), '/health/ready'), url).toBe('not_found');
    expect(strictGet(request('POST', url, { 'content-length': '2' }), '/health/ready'), url).toBe('not_found');
    expect(strictGet(request('GET', `${url}/`), '/health/ready'), url).toBe('not_found');
    expect(strictGet(request('GET', `${url}?x=1`), '/health/ready'), url).toBe('invalid');
    expect(strictGet(request('GET', url, { 'content-length': '2' }), '/health/ready'), url).toBe('invalid');
    expect(strictGet(request('GET', url, { 'transfer-encoding': 'chunked' }), '/health/ready'), url).toBe('invalid');
    // The path step comes first: a wrong path with a query is 404, not 400.
    expect(strictGet(request('GET', `${url}/x?x=1`), '/health/ready'), url).toBe('not_found');
  }
  for (const url of ['//evil.example/health/ready', 'http://h//evil.example/health/ready', '/x/health/ready', 'a:1']) {
    expect(strictGet(request('GET', url), '/health/ready'), url).toBe('not_found');
  }
});

test('DEP-002 a target that starts with // is never read as an authority, so it gets 404 instead of a health answer, on both compositions', async () => {
  // Host `a b` makes Bun write the bare target, and Host `h` the absolute form; in both the whole target is the path.
  for (const mode of MODES) {
    const app = createApp(mode).listen({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024, idleTimeout: 10 });
    try {
      const port = app.server!.port!;
      for (const host of ['a b', 'h']) {
        const request = (target: string) => rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
        for (const target of ['//evil.example/health/live', '//evil.example/health/ready', '//health/live', '//health/ready']) {
          const response = await request(target);
          expect(response.status, `${mode} ${target} Host ${host}`).toBe(404);
          expect(response.body).toBe(NOT_FOUND);
        }
        const live = await request('/health/live');
        expect(live.status, `${mode} /health/live Host ${host}`).toBe(200);
        expect(live.body).toBe(LIVE);
      }
    } finally {
      await app.stop(true);
    }
  }
  expectQuiet();
}, 15_000);

test('DEP-002 production keeps answering 404 for the development routes, OpenAPI, and every other path', async () => {
  const app = createApp('production', { database: fakePool({ applied: true }).pool });
  for (const path of ['/api/status', '/api/readiness', '/openapi', '/openapi/json', '/x', '/health', '/api/health/live']) {
    const response = await handle(app, path);
    expect(response.status, path).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND);
  }
  // The development composition keeps its diagnostic routes beside the health routes.
  const development = createApp('development');
  expect((await handle(development, '/api/status')).status).toBe(200);
  expect((await handle(development, '/openapi/json')).status).toBe(200);
  expectQuiet();
});
