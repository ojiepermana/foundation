import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { Socket } from 'bun';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { connect } from 'node:net';
import { Elysia } from 'elysia';
import { createApp } from '../../../apps/backend/src/app';
import { LOG_PATH_LIMIT, writeLifecycle, type RequestLogSink } from '../../../apps/backend/src/plugins/request-log';

// DEP-007 (spec 0012, AC-10): the JSON request and lifecycle lines of the production backend, first through a sink
// injected into createApp, then through real index.ts processes (source and bundle) whose stdout and stderr are read
// apart. Request lines carry exactly time, level, event, requestId, method, path, status, and durationMs; lifecycle
// lines exactly time, level, and event. `info` goes only to stdout and `error` only to stderr. The request id is the
// edge `X-Request-Id` only when it is 32 lower case hex digits; health answers below 500 and requests Bun refuses
// before Elysia write no line; and the development composition stays silent with its fixed lifecycle text.
const root = new URL('../../../', import.meta.url).pathname;
const REQUEST_KEYS = ['durationMs', 'event', 'level', 'method', 'path', 'requestId', 'status', 'time'];
const LIFECYCLE_KEYS = ['event', 'level', 'time'];
const ID = /^[0-9a-f]{32}$/;

type Captured = { info: string[]; error: string[]; sink: RequestLogSink };

function capture(): Captured {
  const info: string[] = [];
  const error: string[] = [];
  return { info, error, sink: { info: (line) => info.push(line), error: (line) => error.push(line) } };
}

const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;

/** onAfterResponse runs after the answer, so the line arrives a moment later. */
const afterResponse = () => Bun.sleep(20);

function expectRequestLine(line: string, expected: { level: 'info' | 'error'; method: string; path: string; status: number }): Record<string, unknown> {
  const value = parse(line);
  expect(Object.keys(value).sort()).toEqual(REQUEST_KEYS);
  expect(value['level']).toBe(expected.level);
  expect(value['event']).toBe('request');
  expect(value['method']).toBe(expected.method);
  expect(value['path']).toBe(expected.path);
  expect(value['status']).toBe(expected.status);
  expect(typeof value['requestId']).toBe('string');
  expect(value['requestId']).toMatch(ID);
  expect(Number.isInteger(value['durationMs'])).toBe(true);
  expect(value['durationMs'] as number).toBeGreaterThanOrEqual(0);
  expect(new Date(value['time'] as string).toISOString()).toBe(value['time'] as string);
  return value;
}

const consoleCalls: string[] = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  consoleCalls.length = 0;
  console.log = (...args: unknown[]) => { consoleCalls.push(`log ${args.length}`); };
  console.warn = (...args: unknown[]) => { consoleCalls.push(`warn ${args.length}`); };
  console.error = (...args: unknown[]) => { consoleCalls.push(`error ${args.length}`); };
});

afterEach(() => {
  Object.assign(console, originalConsole);
});

const handle = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));

test('DEP-007 one request line with the exact keys, the path without its query, and no query, header, cookie, or body value', async () => {
  const log = capture();
  const app = createApp('production', { log: log.sink });
  const secret = randomBytes(16).toString('hex');
  const id = randomBytes(16).toString('hex');
  const response = await handle(app, `/api/x.json?token=${secret}&returnUrl=%2Fhome`, {
    method: 'POST',
    headers: { 'X-Request-Id': id, Authorization: `Bearer ${secret}`, Cookie: `session=${secret}`, 'X-Note': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: secret }),
  });
  expect(response.status).toBe(404);
  await afterResponse();
  expect(log.error).toEqual([]);
  expect(log.info).toHaveLength(1);
  const line = expectRequestLine(log.info[0]!, { level: 'info', method: 'POST', path: '/api/x.json', status: 404 });
  expect(line['requestId']).toBe(id);
  expect(log.info[0]).not.toContain(secret);
  expect(log.info[0]).not.toContain('returnUrl');
  expect(consoleCalls).toEqual([]);
});

test('DEP-007 the request id is the header only for 32 lower case hex digits, otherwise a new 32 hex id per request', async () => {
  const log = capture();
  const app = createApp('production', { log: log.sink });
  const valid = randomBytes(16).toString('hex');
  const refused = [valid.toUpperCase(), valid.slice(1), `${valid}0`, `${valid.slice(0, 31)}g`, ` ${valid.slice(1)}`, 'x'.repeat(32)];
  const sent: (string | undefined)[] = [valid, ...refused, undefined];
  for (const value of sent) await handle(app, '/api/x', value === undefined ? {} : { headers: { 'X-Request-Id': value } });
  // Two headers arrive joined with ", ", so even two valid values are refused.
  await handle(app, '/api/x', { headers: [['X-Request-Id', valid], ['X-Request-Id', valid]] });
  await afterResponse();
  const ids = log.info.map((line) => parse(line)['requestId'] as string);
  expect(ids).toHaveLength(sent.length + 1);
  expect(ids[0]).toBe(valid);
  for (const id of ids.slice(1)) {
    expect(id).toMatch(ID);
    expect(id).not.toBe(valid);
  }
  expect(new Set(ids).size).toBe(ids.length);
});

test('DEP-007 durationMs is the time between onRequest and onAfterResponse of the same request, not a fallback 0', async () => {
  // A request whose start entry is lost (onRequest and onAfterResponse seeing different Request objects) would log 0;
  // a handler that waits about 60 ms must log at least 40 ms.
  const log = capture();
  const app = (createApp('production', { log: log.sink }) as unknown as Elysia).get('/slow-fixture', async () => {
    await Bun.sleep(60);
    return { ok: true };
  });
  const response = await app.handle(new Request('http://localhost/slow-fixture'));
  expect(response.status).toBe(200);
  await afterResponse();
  expect(log.info).toHaveLength(1);
  const line = expectRequestLine(log.info[0]!, { level: 'info', method: 'GET', path: '/slow-fixture', status: 200 });
  expect(line['durationMs'] as number).toBeGreaterThanOrEqual(40);
});

test('DEP-007 a request without a usable X-Request-Id logs the one id generated for it in onRequest, never a second one', async () => {
  // AC-10: the generated id is made once per request. A lost start entry would make onAfterResponse generate another id,
  // which still looks like 32 hex digits, so the test counts the generated ids and compares them with the lines.
  const log = capture();
  const app = createApp('production', { log: log.sink });
  const generated: string[] = [];
  const original = crypto.randomUUID.bind(crypto);
  const spy = spyOn(crypto, 'randomUUID').mockImplementation(() => {
    const value = original();
    generated.push(value.replaceAll('-', ''));
    return value;
  });
  try {
    await handle(app, '/api/a');
    await handle(app, '/api/b', { headers: { 'X-Request-Id': 'not-a-request-id' } });
    await afterResponse();
  } finally {
    spy.mockRestore();
  }
  expect(generated).toHaveLength(2);
  expect(log.info.map((line) => parse(line)['requestId'])).toEqual(generated);
});

test('DEP-007 the method is one of the fixed names or OTHER, and the path keeps at most 200 characters without the query', async () => {
  const log = capture();
  const app = createApp('production', { log: log.sink });
  // Bun 1.4.2 upper cases method names and turns a name it does not know into GET, so two WebDAV names it knows stand
  // for every other method.
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND', 'MKCOL']) await handle(app, '/api/m', { method });
  const long = `/api/${'a'.repeat(300)}`;
  await handle(app, `${long}?q=${'b'.repeat(50)}`);
  await afterResponse();
  const methods = log.info.slice(0, 9).map((line) => parse(line)['method']);
  expect(methods).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER', 'OTHER']);
  const path = parse(log.info[9]!)['path'] as string;
  expect(LOG_PATH_LIMIT).toBe(200);
  expect(path).toBe(long.slice(0, 200));
});

test('DEP-007 health answers below 500 write no line, while /health/ready 503 and other paths do', async () => {
  const log = capture();
  const app = createApp('production', { log: log.sink });
  for (const [path, init] of [['/health/live', {}], ['/health/live', { method: 'HEAD' }], ['/health/live?x=1', {}], ['/health/ready?x=1', {}], ['/health/live', { method: 'POST' }]] as const) {
    await handle(app, path, init);
  }
  await afterResponse();
  expect(log.info).toEqual([]);
  expect(log.error).toEqual([]);
  // Without a pool readiness answers 503, which is not below 500, so it is written, at level error.
  await handle(app, '/health/ready');
  await handle(app, '/health/live/');
  await afterResponse();
  expect(log.error).toHaveLength(1);
  expectRequestLine(log.error[0]!, { level: 'error', method: 'GET', path: '/health/ready', status: 503 });
  expect(log.info).toHaveLength(1);
  expectRequestLine(log.info[0]!, { level: 'info', method: 'GET', path: '/health/live/', status: 404 });
});

test('DEP-007 a 500 answer writes an error line only through sink.error, without the error message', async () => {
  const log = capture();
  const secret = randomBytes(16).toString('hex');
  // createApp returns a union of the two compositions, so the fixture route is added through the plain Elysia type;
  // Elysia registers it on the same instance, after the log plugin.
  const app = (createApp('production', { log: log.sink }) as unknown as Elysia).get('/failure-fixture', () => { throw new Error(`failure ${secret}`); });
  const response = await app.handle(new Request('http://localhost/failure-fixture'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Internal server error' });
  await afterResponse();
  expect(log.info).toEqual([]);
  expect(log.error).toHaveLength(1);
  expectRequestLine(log.error[0]!, { level: 'error', method: 'GET', path: '/failure-fixture', status: 500 });
  expect(log.error[0]).not.toContain(secret);
});

test('DEP-007 lifecycle lines carry exactly time, level, and event, info for listening and stopped and error for the failures', () => {
  const log = capture();
  const at = new Date('2026-10-05T01:02:03.004Z');
  for (const event of ['listening', 'stopped', 'listener_shutdown_failed', 'database_shutdown_failed', 'startup_failed'] as const) writeLifecycle(log.sink, event, () => at);
  expect(log.info.map(parse)).toEqual([
    { time: '2026-10-05T01:02:03.004Z', level: 'info', event: 'listening' },
    { time: '2026-10-05T01:02:03.004Z', level: 'info', event: 'stopped' },
  ]);
  expect(log.error.map(parse)).toEqual([
    { time: '2026-10-05T01:02:03.004Z', level: 'error', event: 'listener_shutdown_failed' },
    { time: '2026-10-05T01:02:03.004Z', level: 'error', event: 'database_shutdown_failed' },
    { time: '2026-10-05T01:02:03.004Z', level: 'error', event: 'startup_failed' },
  ]);
  for (const line of [...log.info, ...log.error]) expect(Object.keys(parse(line)).sort()).toEqual(LIFECYCLE_KEYS);
  // A sink that throws never breaks the caller.
  expect(() => writeLifecycle({ info: () => { throw new Error('closed'); }, error: () => { throw new Error('closed'); } }, 'stopped')).not.toThrow();
});

test('DEP-007 without a sink both compositions stay silent', async () => {
  for (const mode of ['production', 'development'] as const) {
    const app = createApp(mode);
    for (const path of ['/api/x', '/health/ready', '/health/live', '/api/status']) await handle(app, path);
  }
  await afterResponse();
  expect(consoleCalls).toEqual([]);
});

test('DEP-007 a sink that throws on every line changes no answer and leaves no unhandled error or console output', async () => {
  const failures: unknown[] = [];
  const onFailure = (reason: unknown) => { failures.push(reason); };
  process.on('unhandledRejection', onFailure);
  process.on('uncaughtException', onFailure);
  try {
    const closed: RequestLogSink = { info: () => { throw new Error('stdout closed'); }, error: () => { throw new Error('stderr closed'); } };
    const app = createApp('production', { log: closed });
    const answers: [string, number, string][] = [['/api/x', 404, '{"error":"Not found"}'], ['/health/ready', 503, '{"status":"unavailable"}'], ['/health/live', 200, '{"status":"live"}']];
    for (let round = 0; round < 2; round += 1) {
      for (const [path, status, body] of answers) {
        const response = await handle(app, path);
        expect(response.status, path).toBe(status);
        expect(await response.text(), path).toBe(body);
      }
    }
    await afterResponse();
  } finally {
    process.off('unhandledRejection', onFailure);
    process.off('uncaughtException', onFailure);
  }
  expect(failures).toEqual([]);
  expect(consoleCalls).toEqual([]);
});

/** One GET over a raw socket with the given Host header; resolves with the status line once the server answered. */
function rawGet(port: number, target: string, host: string): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const socket = connect({ host: '127.0.0.1', port });
    const finish = () => { clearTimeout(timer); socket.destroy(); resolve(data.split('\r\n')[0] ?? ''); };
    const timer = setTimeout(finish, 2000);
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk: Buffer) => { data += chunk.toString('latin1'); });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

test('DEP-007 the logged path is the pathname of the request target even when the Host header makes the request URL unparseable, so no Host value reaches the log', async () => {
  // *Log backend production*: `path` is the pathname without the query. Bun 1.4.2 builds `request.url` from the Host
  // header, and an authority it cannot parse (a `%` that is no escape, an open IPv6 bracket) leaves an absolute URL that
  // `new URL` refuses. nginx 1.30.5 forwards a Host such as `<value>%5e.example` unchanged as `$host` (probe of the
  // pinned image during /test, 2026-10-05), so the edge passes it to the backend; a sentinel in it must not reach the log.
  const log = capture();
  const app = createApp('production', { log: log.sink }).listen({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024, idleTimeout: 10 });
  const sentinel = randomBytes(12).toString('hex');
  const hosts = [`${sentinel}%5e.example`, `${sentinel}%zz`, `[::1${sentinel}`];
  try {
    const port = app.server!.port!;
    for (const host of hosts) expect(await rawGet(port, `/api/x?token=${sentinel}`, host), host).toMatch(/^HTTP\/1\.1 404 /);
    await afterResponse();
  } finally {
    await app.stop(true);
  }
  expect(log.error).toEqual([]);
  expect(log.info).toHaveLength(hosts.length);
  for (const [index, line] of log.info.entries()) {
    expectRequestLine(line, { level: 'info', method: 'GET', path: '/api/x', status: 404 });
    expect(line, hosts[index]).not.toContain(sentinel);
  }
});

test('DEP-007 every Host form gives the same logged path and the same health rule: the bare target, a refused authority, and a target that starts with //', async () => {
  // Bun 1.4.2 writes the bare target for a Host with a space, `/`, `@`, `?`, or `#`, and `http://<Host><target>` for the
  // others, also ones `new URL` refuses (probe during /test, 2026-10-06). The logged path is always the pathname of the
  // target, a `//` target stays the whole path, health answers below 500 stay unlogged, and no Host text is written.
  const log = capture();
  const app = createApp('production', { log: log.sink }).listen({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 1024, idleTimeout: 10 });
  const sentinel = randomBytes(12).toString('hex');
  const hosts = [`a ${sentinel}`, `a/${sentinel}`, `a@${sentinel}`, `a?${sentinel}`, `a#${sentinel}`, `${sentinel}%5e.example`, `[::1${sentinel}`];
  const requests: [string, RegExp][] = [
    [`/api/x?token=${sentinel}`, /^HTTP\/1\.1 404 /],
    [`//${sentinel}/api/x`, /^HTTP\/1\.1 404 /],
    ['/health/live', /^HTTP\/1\.1 200 /],
    ['/health/live?x=1', /^HTTP\/1\.1 400 /],
    ['/health/ready', /^HTTP\/1\.1 503 /],
  ];
  try {
    const port = app.server!.port!;
    for (const host of hosts) {
      for (const [target, status] of requests) expect(await rawGet(port, target, host), `${target} Host ${host}`).toMatch(status);
    }
    await afterResponse();
  } finally {
    await app.stop(true);
  }
  // Per Host: two info lines (/api/x and the // target) and one error line (/health/ready 503); no line for the health
  // answers below 500.
  expect(log.info).toHaveLength(hosts.length * 2);
  expect(log.error).toHaveLength(hosts.length);
  const infoPaths = log.info.map((line) => parse(line)['path'] as string);
  expect(infoPaths.filter((path) => path === '/api/x')).toHaveLength(hosts.length);
  expect(infoPaths.filter((path) => path === `//${sentinel}/api/x`)).toHaveLength(hosts.length);
  for (const line of log.info) expectRequestLine(line, { level: 'info', method: 'GET', path: parse(line)['path'] as string, status: 404 });
  for (const line of log.error) expectRequestLine(line, { level: 'error', method: 'GET', path: '/health/ready', status: 503 });
  // The sentinel is only in the path of the // target, never from a Host header or a query string.
  for (const line of [...log.info, ...log.error]) {
    const { path, ...rest } = parse(line);
    expect(JSON.stringify(rest)).not.toContain(sentinel);
    if (path !== `//${sentinel}/api/x`) expect(path as string).not.toContain(sentinel);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Real processes: stdout and stderr read apart.

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = server.port!;
  await server.stop(true);
  return port;
}

function spawnBackend(entry: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, '--no-env-file', entry], { cwd: root, env: { PATH: process.env['PATH'] ?? '', ...env }, stdout: 'pipe', stderr: 'pipe' });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { child, output };
}

async function waitListening(port: number): Promise<void> {
  for (const limit = Date.now() + 5000; Date.now() < limit; await Bun.sleep(20)) {
    try {
      await (await fetch(`http://127.0.0.1:${port}/health/live`)).arrayBuffer();
      return;
    } catch {
      // Not listening yet.
    }
  }
  throw new Error('Backend never became ready');
}

/** A request head and body over a raw socket; resolves with the status line once the server answered or closed. */
function rawPost(port: number, path: string, bytes: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const socket = connect({ host: '127.0.0.1', port });
    const finish = () => { clearTimeout(timer); socket.destroy(); resolve(data.split('\r\n')[0] ?? ''); };
    const timer = setTimeout(finish, 2000);
    socket.on('connect', () => socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: text/plain\r\nContent-Length: ${bytes}\r\nConnection: close\r\n\r\n${'a'.repeat(bytes)}`));
    socket.on('data', (chunk: Buffer) => { data += chunk.toString('latin1'); });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

for (const entry of ['apps/backend/src/index.ts', 'dist/backend/index.js']) {
  test(`DEP-007 production process from ${entry} writes JSON lines, info only to stdout and error only to stderr, and no request data`, async () => {
    // A missing bundle fails with a fixed message instead of being skipped; `bun run build:backend` creates it.
    if (entry.startsWith('dist/') && !(await access(`${root}${entry}`).then(() => true, () => false))) {
      throw new Error('dist/backend/index.js is missing; run bun run build:backend first');
    }
    const port = await unusedPort();
    const { child, output } = spawnBackend(entry, { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) });
    const secret = randomBytes(16).toString('hex');
    const edgeId = randomBytes(16).toString('hex');
    try {
      await waitListening(port);
      const forwarded = await fetch(`http://127.0.0.1:${port}/api/x.json?token=${secret}`, {
        method: 'POST',
        headers: { 'X-Request-Id': edgeId, Authorization: `Bearer ${secret}`, Cookie: `session=${secret}`, 'X-Note': secret, 'Content-Type': 'text/plain' },
        body: secret,
      });
      expect(forwarded.status).toBe(404);
      await forwarded.arrayBuffer();
      const own = await fetch(`http://127.0.0.1:${port}/api/own`, { headers: { 'X-Request-Id': 'not-a-request-id' } });
      await own.arrayBuffer();
      for (const path of ['/health/live', '/health/live', '/health/ready']) await (await fetch(`http://127.0.0.1:${port}${path}`)).arrayBuffer();
      // Bun refuses a body above maxRequestBodySize before Elysia: 413 and no line.
      expect(await rawPost(port, '/api/too-large', 2048)).toMatch(/^HTTP\/1\.1 413 /);
      await Bun.sleep(100);
      child.kill('SIGTERM');
      expect(await Promise.race([child.exited, Bun.sleep(6000).then(() => 'still running' as const)])).toBe(0);
      const [stdout, stderr] = await output;
      const out = lines(stdout).map(parse);
      const err = lines(stderr).map(parse);
      expect(out.map((line) => line['event'])).toEqual(['listening', 'request', 'request', 'stopped']);
      for (const line of [out[0]!, out[3]!]) {
        expect(Object.keys(line).sort()).toEqual(LIFECYCLE_KEYS);
        expect(line['level']).toBe('info');
      }
      const [first, second] = [lines(stdout)[1]!, lines(stdout)[2]!];
      expect(expectRequestLine(first, { level: 'info', method: 'POST', path: '/api/x.json', status: 404 })['requestId']).toBe(edgeId);
      expect(expectRequestLine(second, { level: 'info', method: 'GET', path: '/api/own', status: 404 })['requestId']).not.toBe('not-a-request-id');
      // /health/ready without a pool answers 503: an error line, on stderr only. /health/live 200 writes nothing.
      expect(err).toHaveLength(1);
      expectRequestLine(lines(stderr)[0]!, { level: 'error', method: 'GET', path: '/health/ready', status: 503 });
      for (const text of [stdout, stderr]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain('too-large');
        expect(text).not.toContain('/health/live');
      }
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    }
  }, 15_000);
}

type PendingTarget = { host: string; port: number; release: () => Promise<void> };

/** The first line a child writes to stdout. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split('\n', 1)[0]!.trim();
}

/**
 * A TCP address whose connect attempt stays pending, so a Bun.SQL connection to it ends in its 3 s connectionTimeout
 * while the TCP connect is still open: the path of a stopped or unreachable database host (spec 0012 AC-9). macOS drops
 * a SYN to 127.0.0.2, which lo0 does not carry by default. Linux treats all of 127.0.0.0/8 as local, so there a
 * listener in a stopped child process never accepts, and once its accept queue is full the kernel drops every new SYN.
 */
async function pendingConnectTarget(): Promise<PendingTarget> {
  if (process.platform === 'darwin') return { host: '127.0.0.2', port: 5432, release: async () => {} };
  if (process.platform !== 'linux') throw new Error(`No pending TCP connect fixture for ${process.platform}`);
  const listener = Bun.spawn([process.execPath, '--no-env-file', '-e', "const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); console.log(s.port);"], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const fillers: Socket[] = [];
  const release = async () => {
    listener.kill('SIGKILL');
    await listener.exited;
    for (const socket of fillers) socket.end();
  };
  try {
    const port = Number(await firstLine(listener.stdout));
    if (!Number.isInteger(port) || port <= 0) throw new Error('The fixture listener wrote no port');
    listener.kill('SIGSTOP');
    for (let attempt = 0; attempt < 8192; attempt++) {
      const connecting = Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {}, error() {} } });
      const state = await Promise.race([
        connecting.then((socket) => { fillers.push(socket); return 'open' as const; }, () => 'failed' as const),
        Bun.sleep(250).then(() => 'pending' as const),
      ]);
      if (state === 'pending') {
        connecting.then((socket) => socket.end(), () => {});
        return { host: '127.0.0.1', port, release };
      }
      if (state === 'failed') break;
    }
  } catch (error) {
    await release();
    throw error;
  }
  await release();
  throw new Error('The accept queue of the stopped fixture listener never filled');
}

test('DEP-007 a production process whose readiness check ran into the database connection timeout still writes stopped and exits 0 on SIGTERM', async () => {
  // Regression of /check verify (spec 0012 AC-9): with Bun 1.4.2 a connection attempt that ended in connectionTimeout
  // kept the process alive after `stopped`, until the SIGKILL of the stop grace (exit 137).
  const target = await pendingConnectTarget();
  const port = await unusedPort();
  const password = randomBytes(12).toString('hex');
  const { child, output } = spawnBackend('apps/backend/src/index.ts', {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: `postgresql://foundation_backend:${password}@${target.host}:${target.port}/foundation`,
  });
  try {
    await waitListening(port);
    const started = performance.now();
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    const elapsed = performance.now() - started;
    expect(ready.status).toBe(503);
    expect(await ready.text()).toBe('{"status":"unavailable"}');
    // A refused or failed connect answers at once; only the 3 s connectionTimeout path answers this late.
    expect(elapsed, 'the readiness check did not reach the 3 s connection timeout').toBeGreaterThanOrEqual(2900);
    child.kill('SIGTERM');
    expect(await Promise.race([child.exited, Bun.sleep(6000).then(() => 'still running' as const)])).toBe(0);
    const [stdout, stderr] = await output;
    expect(lines(stdout).map((line) => parse(line)['event'])).toEqual(['listening', 'stopped']);
    expect(lines(stderr)).toHaveLength(1);
    expectRequestLine(lines(stderr)[0]!, { level: 'error', method: 'GET', path: '/health/ready', status: 503 });
    for (const text of [stdout, stderr]) {
      expect(text).not.toContain(password);
      expect(text).not.toContain(target.host);
    }
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    await target.release();
  }
}, 20_000);

test('DEP-007 a production startup failure writes one startup_failed JSON line on stderr, and nothing on stdout', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  try {
    const failing: Record<string, string>[] = [{ PORT: String(server.port) }, { PORT: '65536' }, { HOST: '10.0.0.1' }];
    for (const env of failing) {
      const { child, output } = spawnBackend('apps/backend/src/index.ts', { NODE_ENV: 'production', HOST: '127.0.0.1', ...env });
      expect(await child.exited, JSON.stringify(env)).toBe(1);
      const [stdout, stderr] = await output;
      expect(stdout).toBe('');
      const err = lines(stderr).map(parse);
      expect(err).toHaveLength(1);
      expect(Object.keys(err[0]!).sort()).toEqual(LIFECYCLE_KEYS);
      expect(err[0]).toMatchObject({ level: 'error', event: 'startup_failed' });
    }
  } finally {
    await server.stop(true);
  }
}, 15_000);

test('DEP-007 the development process keeps its fixed lifecycle text and writes no request line', async () => {
  const port = await unusedPort();
  const { child, output } = spawnBackend('apps/backend/src/index.ts', { NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port) });
  try {
    await waitListening(port);
    for (const path of ['/api/status', '/api/x', '/health/ready']) await (await fetch(`http://127.0.0.1:${port}${path}`)).arrayBuffer();
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    const [stdout, stderr] = await output;
    expect(stdout).toBe(`Backend listening at http://127.0.0.1:${port}\nBackend stopped\n`);
    expect(stderr).toBe('');
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
  }
}, 15_000);
