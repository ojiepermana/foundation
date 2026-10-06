import { expect, test } from 'bun:test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppOptions } from '../../../apps/backend/src/app';
import { allowedOrigins, DEVELOPMENT_ORIGINS, jsonMediaType } from '../../../apps/backend/src/features/auth/auth.guard';
import { VERIFY_SLOTS } from '../../../apps/backend/src/features/auth/auth.policy';
import { createVerifySlots, type ReleaseSlot } from '../../../apps/backend/src/features/auth/auth.slots';
import {
  attemptKey,
  csrfMatches,
  csrfToken,
  newSessionToken,
  presentedToken,
  sessionCookie,
  TOKEN_PATTERN,
  tokenHash,
} from '../../../apps/backend/src/features/auth/auth.tokens';
import type { RequestLogSink } from '../../../apps/backend/src/plugins/request-log';
import {
  hashPassword,
  normalizeEmail,
  normalizePassword,
  PASSWORD_HASH_OPTIONS,
  PASSWORD_HASH_PREFIX,
  validDisplayName,
} from '../../../libs/server/auth/credentials';
import {
  createTestAccounts,
  DATABASE_ACCOUNT_PASSWORDS,
  databaseAccountPasswordLabels,
  e2eAccountEnv,
  newTestAccounts,
  type CommandOutput,
} from '../../orchestration/auth-accounts';
import {
  newTokenKey,
  parseFingerprints,
  recordTokenFingerprintsWhenConfigured,
  TOKEN_FINGERPRINTS_VARIABLE,
  TOKEN_KEY_VARIABLE,
  tokenFingerprint,
  tokenMatches,
} from '../../orchestration/token-fingerprints';

// Backend suite of spec 0014 without a database (AUTH-005, AUTH-006, and AUTH-009 parts that need no pool): the
// `onRequest` guard of the auth plugin (steps 1 to 4 of *Urutan pemeriksaan per request*), the origin rule, the
// Content-Type rule, the answers of the root onError under `/api/auth/`, the guard's own log lines, the verification
// slots, and the start of index.ts in production without PUBLIC_ORIGIN. Every request goes through app.handle(), so no
// listener opens, except for the index.ts processes at the end and one listener on 127.0.0.1 for raw requests with a
// Host and a request target that `fetch` cannot send. The parts that need PostgreSQL are in
// tests/integration/database/auth.test.ts.
// The last sections are unit tests without a database: the credential rules of libs/server/auth/credentials.ts (table
// *Kebijakan*), the tokens and the session cookie of auth.tokens.ts (tables *Token* and *Cookie sesi*), and the test
// accounts and token fingerprints the real orchestrations use (*Sidik token uji*). Expected values are computed again
// here with node:crypto or copied from the spec, never taken from the module under test.

const root = new URL('../../../', import.meta.url).pathname;
const DEV_ORIGIN = 'http://127.0.0.1:8889';
const PUBLIC = 'https://foundation.test';
const TOKEN = 'a'.repeat(43);
const SESSION_ID = '00000000-0000-4000-8000-000000000000';
const VALID_BODY = JSON.stringify({ email: 'ana@foundation.test', password: 'Pw-correct-horse-battery' });

type App = ReturnType<typeof createApp>;
type Call = { headers?: Record<string, string>; body?: string };

function handle(app: App, method: string, path: string, call: Call = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { method, headers: call.headers, body: call.body }));
}

/** A verifier that counts its calls and never accepts, so a test can prove the guard ran before Argon2id. */
function countingVerifier(): { calls: () => number; auth: NonNullable<AppOptions['auth']> } {
  let calls = 0;
  return { calls: () => calls, auth: { verify: async () => { calls += 1; return false; } } };
}

/** The three routes that change data, each with a request that passes every check up to the origin rule. */
const MUTATING: readonly [string, string, (origin: Record<string, string>) => Call][] = [
  ['POST', '/api/auth/session', (origin) => ({ headers: { ...origin, 'content-type': 'application/json' }, body: VALID_BODY })],
  ['DELETE', '/api/auth/session', (origin) => ({ headers: { ...origin, 'x-csrf-token': TOKEN, cookie: `foundation_session=${TOKEN}` } })],
  ['DELETE', `/api/auth/sessions/${SESSION_ID}`, (origin) => ({ headers: { ...origin, 'x-csrf-token': TOKEN, cookie: `foundation_session=${TOKEN}` } })],
];

async function expectAuthError(response: Response, status: number, error: string, label: string): Promise<void> {
  expect(response.status, label).toBe(status);
  expect(response.headers.get('content-type'), label).toStartWith('application/json');
  expect(response.headers.get('cache-control'), label).toBe('no-store');
  expect(response.headers.getSetCookie(), label).toEqual([]);
  expect(await response.text(), label).toBe(JSON.stringify({ error }));
}

// ---------------------------------------------------------------------------------------------------------------
// AUTH-009 (AC-9): origin and Sec-Fetch-Site

test('AUTH-009 a request that changes data without Origin, with another or a null origin, or with Sec-Fetch-Site other than same-origin is 403 in the guard, for all three routes, without the verifier', async () => {
  const verifier = countingVerifier();
  const app = createApp('development', { auth: verifier.auth });
  const refused: [string, Record<string, string>][] = [
    ['no Origin', {}],
    ['another origin', { origin: 'http://evil.test' }],
    ['the origin null', { origin: 'null' }],
    ['the allowed origin with a trailing slash', { origin: `${DEV_ORIGIN}/` }],
    ['the allowed origin in upper case', { origin: 'HTTP://127.0.0.1:8889' }],
    ['the allowed origin on another port', { origin: 'http://127.0.0.1:8888' }],
    ['the allowed origin twice', { origin: `${DEV_ORIGIN}, ${DEV_ORIGIN}` }],
    ['Sec-Fetch-Site cross-site', { origin: DEV_ORIGIN, 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site same-site', { origin: DEV_ORIGIN, 'sec-fetch-site': 'same-site' }],
    ['Sec-Fetch-Site none', { origin: DEV_ORIGIN, 'sec-fetch-site': 'none' }],
    ['Sec-Fetch-Site in upper case', { origin: DEV_ORIGIN, 'sec-fetch-site': 'Same-Origin' }],
    ['an empty Sec-Fetch-Site', { origin: DEV_ORIGIN, 'sec-fetch-site': '' }],
  ];
  for (const [method, path, call] of MUTATING) {
    for (const [name, origin] of refused) {
      await expectAuthError(await handle(app, method, path, call(origin)), 403, 'Forbidden', `${method} ${path} ${name}`);
    }
    // Controls: the two fixed development origins, with Sec-Fetch-Site same-origin or without it, pass the guard and
    // reach step 6, which answers 503 without a pool.
    const allowed: Record<string, string>[] = [{ origin: DEV_ORIGIN }, { origin: 'http://localhost:8889', 'sec-fetch-site': 'same-origin' }];
    for (const origin of allowed) {
      const passed = await handle(app, method, path, call(origin));
      expect(passed.status, `${method} ${path} ${JSON.stringify(origin)}`).toBe(503);
      expect(await passed.json()).toEqual({ error: 'Service unavailable' });
    }
  }
  expect(verifier.calls()).toBe(0);
});

test('AUTH-009 the allowed origins follow publicOrigin: production without it refuses every origin, with it exactly that one, and development without it its two fixed origins', async () => {
  expect(DEVELOPMENT_ORIGINS).toEqual(['http://127.0.0.1:8889', 'http://localhost:8889']);
  expect(allowedOrigins('production', undefined)).toEqual([]);
  expect(allowedOrigins('production', PUBLIC)).toEqual([PUBLIC]);
  expect(allowedOrigins('development', undefined)).toEqual(DEVELOPMENT_ORIGINS);
  expect(allowedOrigins('development', 'http://127.0.0.1:4200')).toEqual(['http://127.0.0.1:4200']);
  const cases: [string, App, string, number][] = [
    ['production without publicOrigin, its would be origin', createApp('production'), PUBLIC, 403],
    ['production without publicOrigin, a development origin', createApp('production'), DEV_ORIGIN, 403],
    ['production with publicOrigin, that origin', createApp('production', { publicOrigin: PUBLIC }), PUBLIC, 503],
    ['production with publicOrigin, a development origin', createApp('production', { publicOrigin: PUBLIC }), DEV_ORIGIN, 403],
    ['production with publicOrigin, the origin over http', createApp('production', { publicOrigin: PUBLIC }), 'http://foundation.test', 403],
    ['development with publicOrigin, that origin', createApp('development', { publicOrigin: 'http://127.0.0.1:4200' }), 'http://127.0.0.1:4200', 503],
    ['development with publicOrigin, a fixed development origin', createApp('development', { publicOrigin: 'http://127.0.0.1:4200' }), DEV_ORIGIN, 403],
  ];
  for (const [name, app, origin, status] of cases) {
    for (const [method, path, call] of MUTATING) {
      const response = await handle(app, method, path, call({ origin, 'sec-fetch-site': 'same-origin' }));
      expect(response.status, `${name}: ${method} ${path}`).toBe(status);
      expect(response.headers.get('cache-control'), name).toBe('no-store');
    }
  }
  // GET routes never check the origin: without a pool they answer 503 whatever the Origin.
  for (const path of ['/api/auth/session', '/api/auth/sessions']) {
    expect((await handle(createApp('production'), 'GET', path, { headers: { origin: 'http://evil.test' } })).status, path).toBe(503);
  }
});

test('AUTH-009 a cross site HTML form with application/x-www-form-urlencoded is 403, and the same form from the allowed origin is 415', async () => {
  const app = createApp('development');
  const form = 'email=ana%40foundation.test&password=secret';
  const crossSite = await handle(app, 'POST', '/api/auth/session', {
    headers: { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' }, body: form,
  });
  await expectAuthError(crossSite, 403, 'Forbidden', 'cross site form');
  const sameSite = await handle(app, 'POST', '/api/auth/session', {
    headers: { origin: DEV_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, body: form,
  });
  await expectAuthError(sameSite, 415, 'Unsupported media type', 'same origin form');
});

test('AUTH-009 the guard decides before any parse: a refused origin with malformed JSON is 403, and a refused media type with a malformed body is 415', async () => {
  const verifier = countingVerifier();
  const app = createApp('development', { auth: verifier.auth });
  const forged = await handle(app, 'POST', '/api/auth/session', { headers: { origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{"email":' });
  await expectAuthError(forged, 403, 'Forbidden', 'forged origin with malformed JSON');
  const media: [string, string][] = [
    ['multipart/form-data', '--x\r\nbroken'],
    ['multipart/form-data; boundary=x', '--x\r\nbroken'],
    ['text/plain', '{"email":'],
    ['Application/JSON', '{"email":'],
  ];
  for (const [type, body] of media) {
    await expectAuthError(await handle(app, 'POST', '/api/auth/session', { headers: { origin: DEV_ORIGIN, 'content-type': type }, body }), 415, 'Unsupported media type', type);
  }
  expect(verifier.calls()).toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------
// AUTH-005 (AC-5): Content-Type, schema, and the answer without a pool

test('AUTH-005 the Content-Type rule accepts only application/json in lower case with at most charset=utf-8, and anything else is 415', async () => {
  const accepted = [
    'application/json', 'application/json; charset=utf-8', 'application/json;charset=utf-8', 'application/json; charset=UTF-8',
    'application/json ;  CharSet=Utf-8', ' application/json ',
  ];
  const refused = [
    'Application/JSON', 'application/JSON', 'APPLICATION/JSON; charset=utf-8', 'text/plain', 'text/json', 'application/jsonp',
    'application/json-patch+json', 'application/problem+json', 'application/json; charset=latin1', 'application/json; charset="utf-8"',
    'application/json; charset = utf-8', 'application/json; charset=utf-8; boundary=x', 'application/json;', 'application/json; foo=bar',
    'application/json, text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded', '',
  ];
  for (const value of accepted) expect(jsonMediaType(value), value).toBe(true);
  for (const value of [...refused, 'application/json;\tcharset=utf-8', 'application/json; charſet=utf-8']) expect(jsonMediaType(value), value).toBe(false);
  expect(jsonMediaType(null)).toBe(false);

  const app = createApp('development');
  for (const value of accepted) {
    const response = await handle(app, 'POST', '/api/auth/session', { headers: { origin: DEV_ORIGIN, 'content-type': value }, body: VALID_BODY });
    expect(response.status, value).toBe(503);
  }
  for (const value of refused) {
    const headers: Record<string, string> = { origin: DEV_ORIGIN };
    if (value !== '') headers['content-type'] = value;
    await expectAuthError(await handle(app, 'POST', '/api/auth/session', { headers, body: VALID_BODY }), 415, 'Unsupported media type', value || 'no Content-Type');
  }
});

test('AUTH-005 the Content-Type rule takes linear time on a long run of spaces, so one header cannot hold the event loop', () => {
  // The guard runs synchronously in onRequest for every POST. A trim by regex (`/ +$/`) took about 120 ms for 16,000
  // spaces before a last character and grows with the square of the run; 64,000 spaces would take about 2 seconds.
  const spaces = ' '.repeat(64000);
  const values = [`application/json${spaces}x`, `application/json;${spaces}x`, `application/json${spaces};x`, `x${spaces}application/json`];
  const started = performance.now();
  for (const value of values) expect(jsonMediaType(value)).toBe(false);
  expect(jsonMediaType(`${spaces}application/json${spaces};${spaces}charset=utf-8${spaces}`)).toBe(true);
  expect(performance.now() - started).toBeLessThan(100);
});

test('AUTH-005 malformed JSON and a body outside the schema are 400 Invalid request with no-store and no echo, while an unknown property is dropped', async () => {
  const app = createApp('development');
  const post = (body: string) => handle(app, 'POST', '/api/auth/session', { headers: { origin: DEV_ORIGIN, 'content-type': 'application/json' }, body });
  const secret = `Pw-${randomBytes(12).toString('hex')}`;
  const invalid: [string, string][] = [
    ['malformed JSON', `{"email":"ana@foundation.test","password":"${secret}"`],
    ['an empty body', ''],
    ['a JSON array', `["ana@foundation.test","${secret}"]`],
    ['a password of the wrong type', JSON.stringify({ email: 'ana@foundation.test', password: 12345678 })],
    ['an email of the wrong type', JSON.stringify({ email: ['ana@foundation.test'], password: secret })],
    ['no password', JSON.stringify({ email: 'ana@foundation.test' })],
    ['an empty password', JSON.stringify({ email: 'ana@foundation.test', password: '' })],
    ['a password above 256 UTF-16 units', JSON.stringify({ email: 'ana@foundation.test', password: `${secret}${'x'.repeat(256)}` })],
    ['an email of two characters', JSON.stringify({ email: 'a@', password: secret })],
    ['an email above 254 characters', JSON.stringify({ email: `${'a'.repeat(250)}@foundation.test`, password: secret })],
  ];
  for (const [name, body] of invalid) {
    const response = await post(body);
    const text = await response.text();
    expect(response.status, name).toBe(400);
    expect(response.headers.get('cache-control'), name).toBe('no-store');
    expect(text, name).toBe('{"error":"Invalid request"}');
    expect(text, name).not.toContain(secret);
  }
  // Elysia's normalization drops a property outside SignInRequest before the handler, so the request is not refused
  // for it and goes on to step 6 (503 without a pool).
  const extra = await post(JSON.stringify({ email: 'ana@foundation.test', password: secret, role: 'admin', userId: SESSION_ID }));
  expect(extra.status).toBe(503);
  expect(await extra.json()).toEqual({ error: 'Service unavailable' });
});

test('AUTH-005 without a pool every auth route answers 503 Service unavailable after the guard and the schema, and the verifier never runs', async () => {
  const verifier = countingVerifier();
  for (const mode of ['development', 'production'] as const) {
    const app = createApp(mode, { publicOrigin: mode === 'production' ? PUBLIC : undefined, auth: verifier.auth });
    const origin = mode === 'production' ? PUBLIC : DEV_ORIGIN;
    const calls: [string, string, Call][] = [
      ['POST', '/api/auth/session', { headers: { origin, 'content-type': 'application/json' }, body: VALID_BODY }],
      ['GET', '/api/auth/session', {}],
      ['GET', '/api/auth/sessions', {}],
      ['DELETE', '/api/auth/session', { headers: { origin, 'x-csrf-token': TOKEN } }],
      ['DELETE', `/api/auth/sessions/${SESSION_ID}`, { headers: { origin, 'x-csrf-token': TOKEN } }],
    ];
    for (const [method, path, call] of calls) {
      await expectAuthError(await handle(app, method, path, call), 503, 'Service unavailable', `${mode} ${method} ${path}`);
    }
  }
  expect(verifier.calls()).toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------
// AUTH-009 (AC-9): every guard answer, its request line, and the request_rejected event

const REQUEST_KEYS = ['durationMs', 'event', 'level', 'method', 'path', 'requestId', 'status', 'time'];
const AUTH_KEYS = ['time', 'level', 'event', 'requestId', 'action', 'outcome', 'userId', 'sessionId', 'accountKey'];

function capture(): { info: string[]; error: string[]; sink: RequestLogSink } {
  const info: string[] = [];
  const error: string[] = [];
  return { info, error, sink: { info: (line) => info.push(line), error: (line) => error.push(line) } };
}

test('AUTH-009 every guard answer (404, 400, 403, 415) carries an AuthError body and no-store, and with a sink writes exactly one request line; 403 adds one request_rejected origin line with the same requestId', async () => {
  const lines = capture();
  const app = createApp('production', { log: lines.sink, publicOrigin: PUBLIC });
  const id = () => randomBytes(16).toString('hex');
  const cases: [string, string, Call, number, string][] = [
    ['HEAD', '/api/auth/session', {}, 404, 'Not found'],
    ['GET', '/api/auth/session/', {}, 404, 'Not found'],
    ['PUT', '/api/auth/session', { headers: { origin: PUBLIC } }, 404, 'Not found'],
    ['GET', '/api/auth/unknown', {}, 404, 'Not found'],
    ['DELETE', '/api/auth/sessions/', { headers: { origin: PUBLIC } }, 404, 'Not found'],
    ['GET', '/api/auth/session?debug=1', {}, 400, 'Invalid request'],
    ['DELETE', '/api/auth/session', { headers: { origin: PUBLIC, 'x-csrf-token': TOKEN, 'content-length': '2' }, body: '{}' }, 400, 'Invalid request'],
    ['POST', '/api/auth/session', { headers: { origin: 'http://evil.test', 'content-type': 'application/json' }, body: VALID_BODY }, 403, 'Forbidden'],
    ['DELETE', `/api/auth/sessions/${SESSION_ID}`, { headers: { 'x-csrf-token': TOKEN } }, 403, 'Forbidden'],
    ['POST', '/api/auth/session', { headers: { origin: PUBLIC, 'content-type': 'text/plain' }, body: VALID_BODY }, 415, 'Unsupported media type'],
  ];
  for (const [method, path, call, status, error] of cases) {
    lines.info.length = 0;
    lines.error.length = 0;
    const requestId = id();
    const response = await handle(app, method, path, { ...call, headers: { ...call.headers, 'x-request-id': requestId } });
    expect(response.status, `${method} ${path}`).toBe(status);
    expect(response.headers.get('cache-control'), `${method} ${path}`).toBe('no-store');
    expect(response.headers.get('content-type'), `${method} ${path}`).toBe('application/json');
    if (method !== 'HEAD') expect(await response.json(), `${method} ${path}`).toEqual({ error });
    // onAfterResponse never runs for an answer from onRequest; the guard wrote its line already, and no second follows.
    await Bun.sleep(20);
    const parsed = lines.info.map((line) => JSON.parse(line) as Record<string, unknown>);
    const requests = parsed.filter((line) => line['event'] === 'request');
    expect(requests, `${method} ${path}`).toHaveLength(1);
    expect(Object.keys(requests[0]!).sort()).toEqual(REQUEST_KEYS);
    expect(requests[0], `${method} ${path}`).toMatchObject({ level: 'info', requestId, status, path: path.split('?')[0] });
    expect(lines.error).toEqual([]);
    const events = parsed.filter((line) => line['event'] === 'auth');
    if (status === 403) {
      expect(events, `${method} ${path}`).toHaveLength(1);
      expect(Object.keys(events[0]!)).toEqual(AUTH_KEYS);
      expect(events[0]).toEqual({
        time: events[0]!['time'], level: 'info', event: 'auth', requestId, action: 'request_rejected', outcome: 'origin', userId: null, sessionId: null, accountKey: null,
      });
      expect(new Date(events[0]!['time'] as string).toISOString()).toBe(events[0]!['time'] as string);
    } else {
      expect(events, `${method} ${path}`).toEqual([]);
    }
    for (const line of lines.info) expect(line).not.toContain(TOKEN);
  }
  // A request id that is not 32 lower case hex digits gets one new id, the same in both lines.
  lines.info.length = 0;
  await handle(app, 'POST', '/api/auth/session', { headers: { 'x-request-id': 'not-an-id', 'content-type': 'application/json' }, body: VALID_BODY });
  await Bun.sleep(20);
  const [event, request] = lines.info.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect([event!['event'], request!['event']]).toEqual(['auth', 'request']);
  expect(event!['requestId']).toMatch(/^[0-9a-f]{32}$/);
  expect(event!['requestId']).toBe(request!['requestId']);
});

test('AUTH-009 without a sink the guard writes nothing and still answers', async () => {
  const output: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => { output.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { output.push(args.join(' ')); };
  try {
    const app = createApp('production', { publicOrigin: PUBLIC });
    expect((await handle(app, 'POST', '/api/auth/session', { headers: { 'content-type': 'application/json' }, body: VALID_BODY })).status).toBe(403);
    expect((await handle(app, 'GET', '/api/auth/x')).status).toBe(404);
    await Bun.sleep(20);
  } finally {
    Object.assign(console, original);
  }
  expect(output).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// AUTH-009 and AUTH-006 (AC-9, AC-6): the path a route is dispatched on, over a real listener with raw requests

/** One raw HTTP/1.1 exchange with the listener on `port`: any Host and request target, which `fetch` cannot send. */
function rawExchange(port: number, text: string): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      const split = data.indexOf('\r\n\r\n');
      const head = split === -1 ? data : data.slice(0, split);
      resolve({ status: Number(head.split(' ')[1] ?? 0), head: head.toLowerCase(), body: split === -1 ? '' : data.slice(split + 4) });
    });
    socket.write(text);
  });
}

test('AUTH-009 over a real listener a Host of 3 or fewer characters, or one that gives a bare request.url, never lets a request reach a handler past the guard: the routed path differs from the request target, so the guard answers 404', async () => {
  // Elysia 1.4.30 routes a request Bun's own router did not match on `request.url` from index 11 on, and Bun writes
  // `request.url` as `http://<Host><target>` (or the bare target), so with `Host: abc` the target `//api/auth/session`
  // is routed as `/api/auth/session`. The edge forwards the client Host and the raw target, and keys its sign in limit on
  // the exact raw path, so a handler reached this way would skip the guard and the edge limit. Without a pool every
  // handler answers 503 first, so a 503 here means a handler ran.
  const verifier = countingVerifier();
  const app = createApp('production', { publicOrigin: PUBLIC, auth: verifier.auth }).listen({ hostname: '127.0.0.1', port: 0 });
  try {
    const port = Number(app.server!.port);
    const send = (method: string, target: string, host: string | null, headers: readonly string[] = [], body = '') => rawExchange(port, [
      `${method} ${target} HTTP/1.1`, ...(host === null ? [] : [`Host: ${host}`]), 'Connection: close', ...headers,
      ...(body === '' ? [] : [`Content-Length: ${Buffer.byteLength(body)}`]),
    ].join('\r\n') + `\r\n\r\n${body}`);
    const json = ['Content-Type: application/json'];
    const csrf = [`X-Csrf-Token: ${TOKEN}`];

    // Controls with the Host of the listener: the guard answers 403 without Origin, and the allowed origin reaches step 6.
    const listener = `127.0.0.1:${port}`;
    const control = await send('POST', '/api/auth/session', listener, json, VALID_BODY);
    expect([control.status, control.body]).toEqual([403, '{"error":"Forbidden"}']);
    expect((await send('POST', '/api/auth/session', listener, [...json, `Origin: ${PUBLIC}`], VALID_BODY)).status).toBe(503);

    const refused: [string, string, string, readonly string[], string][] = [
      ['POST', '//api/auth/session', 'abc', json, VALID_BODY],
      ['POST', '//api/auth/session', 'abc', ['Content-Type: text/plain'], VALID_BODY],
      ['POST', '///api/auth/session', 'ab', json, VALID_BODY],
      ['POST', '//api/auth/session', 'a:1', json, VALID_BODY],
      // Under the edge location `/api/`, so the edge forwards it, and its raw path is not the key of the sign in limit.
      ['POST', '/api/api/auth/session', 'ab', json, VALID_BODY],
      // A Host with a space gives the bare target as request.url, which Elysia also reads from index 11 on.
      ['POST', '/aaaaaaaaaa/api/auth/session', 'a b', json, VALID_BODY],
      // Even with the allowed origin: the guard cannot compare a path the router does not take, so it refuses.
      ['POST', '/api/auth/session', 'abc', [...json, `Origin: ${PUBLIC}`], VALID_BODY],
      ['GET', '//api/auth/session?x=1', 'abc', [], ''],
      ['GET', '//api/auth/sessions', 'abc', [], ''],
      ['DELETE', '//api/auth/session', 'abc', csrf, ''],
      ['DELETE', `//api/auth/sessions/${SESSION_ID}`, 'abc', csrf, ''],
    ];
    for (const [method, target, host, headers, body] of refused) {
      const answer = await send(method, target, host, headers, body);
      const label = `${method} ${target} Host ${host}`;
      expect(answer.status, label).toBe(404);
      expect(answer.head, label).toContain('\r\ncache-control: no-store');
      expect(answer.body, label).toBe('{"error":"Not found"}');
    }

    // Every route behind every short or unusual Host, with up to 13 characters in front of the route: no handler runs.
    const routes: [string, string, readonly string[], string][] = [
      ['POST', '/api/auth/session', json, VALID_BODY],
      ['GET', '/api/auth/session?x=1', [], ''],
      ['DELETE', '/api/auth/session', csrf, ''],
      ['GET', '/api/auth/sessions', [], ''],
      ['DELETE', `/api/auth/sessions/${SESSION_ID}`, csrf, ''],
    ];
    const hosts = [null, '', 'a', 'ab', 'abc', 'abcd', 'a:1', 'a b', 'a@b', 'a/b', 'localhost'];
    const reached: string[] = [];
    for (const host of hosts) {
      for (const [method, route, headers, body] of routes) {
        const fronts = ['/', '//', '/api', ...Array.from({ length: 13 }, (_, index) => `/${'a'.repeat(index + 1)}`)];
        for (const front of fronts) {
          const answer = await send(method, `${front}${route}`, host, headers, body);
          if (![400, 403, 404].includes(answer.status)) reached.push(`${method} ${front}${route} Host ${host}: ${answer.status}`);
        }
      }
    }
    expect(reached).toEqual([]);
  } finally {
    await app.stop(true);
  }
  expect(verifier.calls()).toBe(0);
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-006 (AC-6): the verification slots

test('AUTH-006 the default slots are the constants of Kebijakan: 4 running, 12 waiting, 2000 ms', () => {
  expect(VERIFY_SLOTS).toEqual({ running: 4, queue: 12, waitMs: 2000 });
  expect(Object.isFrozen(VERIFY_SLOTS)).toBe(true);
});

test('AUTH-006 slots: at most running at once, a full queue gives no slot at once, a release goes to the oldest waiting, and a run out wait gives no slot', async () => {
  const acquire = createVerifySlots({ running: 2, queue: 2, waitMs: 200 });
  const first = await acquire();
  const second = await acquire();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  const order: string[] = [];
  const third = acquire().then((slot) => { order.push('third'); return slot; });
  const fourth = acquire().then((slot) => { order.push('fourth'); return slot; });
  // The queue holds two, so a fifth gets no slot without waiting.
  const started = performance.now();
  expect(await acquire()).toBeNull();
  expect(performance.now() - started).toBeLessThan(50);
  // A release hands its slot to the oldest waiting request, and a second call of the same release does nothing.
  first!();
  first!();
  const thirdSlot = await third;
  expect(thirdSlot).not.toBeNull();
  expect(order).toEqual(['third']);
  // fourth still waits: two slots run (second and third). Its wait runs out after 200 ms.
  const waited = performance.now();
  expect(await fourth).toBeNull();
  expect(performance.now() - waited).toBeGreaterThanOrEqual(150);
  // Released slots free the gate again: two at once, never three.
  second!();
  thirdSlot!();
  const again = [await acquire(), await acquire()];
  expect(again.every((slot) => slot !== null)).toBe(true);
  const queued = acquire();
  for (const slot of again) (slot as ReleaseSlot)();
  const last = await queued;
  expect(last).not.toBeNull();
  last!();
});

test('AUTH-006 slots with no queue refuse at once when all run, and a slot freed while nobody waits is taken again directly', async () => {
  const acquire = createVerifySlots({ running: 1, queue: 0, waitMs: 2000 });
  const only = await acquire();
  expect(only).not.toBeNull();
  expect(await acquire()).toBeNull();
  only!();
  const next = await acquire();
  expect(next).not.toBeNull();
  next!();
});

// ---------------------------------------------------------------------------------------------------------------
// AUTH-009 (AC-9): index.ts in production without a valid PUBLIC_ORIGIN

/** A loopback port that was free a moment ago. */
function unusedPort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function startBackend(publicOrigin: string | undefined): Promise<{ code: number | 'running'; stdout: string; stderr: string }> {
  const env: Record<string, string> = { PATH: process.env['PATH']!, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(unusedPort()) };
  if (publicOrigin !== undefined) env['PUBLIC_ORIGIN'] = publicOrigin;
  const child = Bun.spawn([process.execPath, '--no-env-file', 'apps/backend/src/index.ts'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const outcome = await Promise.race([child.exited, Bun.sleep(3000).then(() => 'running' as const)]);
  if (outcome === 'running') child.kill('SIGTERM');
  await child.exited;
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: outcome, stdout, stderr };
}

test('AUTH-009 index.ts with NODE_ENV=production does not start without PUBLIC_ORIGIN or with an invalid one, and writes one startup_failed line', async () => {
  // Control: the same environment with a valid PUBLIC_ORIGIN starts and listens, so the failures below come from it.
  const started = await startBackend(PUBLIC);
  expect(started.code).toBe('running');
  expect(started.stdout).toContain('"event":"listening"');
  const marker = `secret-${randomBytes(6).toString('hex')}`;
  for (const value of [undefined, '', `http://${marker}.test`, `https://${marker}.test/`, `https://${marker}.test/path`, `https://user@${marker}.test`, marker]) {
    const result = await startBackend(value);
    expect(result.code, String(value)).toBe(1);
    expect(result.stdout, String(value)).toBe('');
    const lines = result.stderr.trim().split('\n');
    expect(lines, String(value)).toHaveLength(1);
    expect(JSON.parse(lines[0]!), String(value)).toMatchObject({ level: 'error', event: 'startup_failed' });
    expect(result.stderr).not.toContain(marker);
  }
}, 40_000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-005 and AUTH-003 (AC-5, AC-3): the credential rules of table *Kebijakan* in libs/server/auth/credentials.ts

/** A small seeded generator, so the property tests below are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('AUTH-005 the email rule trims spaces, lowers only A to Z, and then needs the pattern and length of users_email_check', () => {
  const accepted: [string, string][] = [
    [' Ana@Example.TEST ', 'ana@example.test'],
    ['ana@example.test', 'ana@example.test'],
    ['a@b', 'a@b'],
    ['admin@localhost', 'admin@localhost'],
    ["o'neil+tag@example.test", "o'neil+tag@example.test"],
    [`${'a'.repeat(64)}@example.test`, `${'a'.repeat(64)}@example.test`],
    [`a@${'b'.repeat(252)}`, `a@${'b'.repeat(252)}`],
    [`${'A'.repeat(64)}@${'B'.repeat(189)}`, `${'a'.repeat(64)}@${'b'.repeat(189)}`],
  ];
  for (const [raw, normalized] of accepted) expect(normalizeEmail(raw), raw).toBe(normalized);
  const refused = [
    '', 'ab', '@b', 'a@', 'ab@', 'a@@b', 'a@b@c', 'a b@example.test', 'ana@exa mple.test', 'ána@example.test',
    'änä@example.test', 'İna@example.test', 'ana@example.tést', `${'a'.repeat(65)}@example.test`,
    `a@${'b'.repeat(253)}`, `ab@${'b'.repeat(252)}`, 'ana\u0000@example.test', 'ana@example.test\u007f',
  ];
  for (const raw of refused) expect(normalizeEmail(raw), JSON.stringify(raw)).toBeNull();
});

test('AUTH-005 the sign in password rule needs well formed text of at most 128 raw code points and 1 to 128 after NFKC, and never cuts', () => {
  const accepted: [string, string][] = [
    ['x', 'x'],
    ['p'.repeat(128), 'p'.repeat(128)],
    ['😀'.repeat(128), '😀'.repeat(128)],
    ['ﬀ'.repeat(64), 'f'.repeat(128)],
    ['ＡＢＣ', 'ABC'],
    ['bell\u0007', 'bell\u0007'],
  ];
  for (const [raw, normalized] of accepted) expect(normalizePassword(raw, 'sign-in'), JSON.stringify(raw)).toBe(normalized);
  const refused: [string, string][] = [
    ['empty', ''],
    ['129 code points', 'p'.repeat(129)],
    ['129 code points outside the BMP', '😀'.repeat(129)],
    ['130 code points after NFKC from 65 U+FB00', 'ﬀ'.repeat(65)],
    ['130 raw code points that NFKC makes 65', 'é'.repeat(65)],
    ['a lone high surrogate', `password\uD800`],
    ['a lone low surrogate', `\uDC00password`],
  ];
  for (const [name, raw] of refused) expect(normalizePassword(raw, 'sign-in'), name).toBeNull();
});

test('AUTH-003 the password setting rule needs 15 to 128 code points after NFKC, refuses control characters, and returns the NFKC form', () => {
  expect(normalizePassword('p'.repeat(15), 'set')).toBe('p'.repeat(15));
  expect(normalizePassword('p'.repeat(128), 'set')).toBe('p'.repeat(128));
  // Sixteen full width letters are hashed as their NFKC form.
  expect(normalizePassword('Ｐａｓｓｗｏｒｄ１２３４５６７８', 'set')).toBe('Password12345678');
  const refused: [string, string][] = [
    ['14 code points', 'p'.repeat(14)],
    ['129 code points', 'p'.repeat(129)],
    ['14 code points after NFKC from 28 raw', 'é'.repeat(14)],
    ['130 code points after NFKC from 65 U+FB00', 'ﬀ'.repeat(65)],
    ['a control character U+0007', `${'p'.repeat(15)}\u0007`],
    ['a control character U+0085', `${'p'.repeat(15)}\u0085`],
    ['a tab', `${'p'.repeat(15)}\t`],
    ['a lone surrogate', `${'p'.repeat(15)}\uD800`],
  ];
  for (const [name, raw] of refused) expect(normalizePassword(raw, 'set'), name).toBeNull();
});

test('AUTH-003 every password that passes the setting rule passes the sign in rule with the same NFKC form, and its sign in body stays far below 1024 bytes', () => {
  // Spec 0014 *Kebijakan*: such a password is at most 256 UTF-16 units (the schema bound) and its body with a 254 byte
  // email is at most 792 bytes, so the 413 limit of 1024 bytes never refuses a valid sign in.
  const pool = ['a', 'Z', '7', ' ', '"', '\\', ' ', 'Ａ', '́', 'ﬀ', '😀', 'Ω', 'ß', 'é', '漢'];
  const random = seeded(140014);
  const email = `${'a'.repeat(64)}@${'b'.repeat(189)}`;
  expect(normalizeEmail(email)).toBe(email);
  let passed = 0;
  for (let round = 0; round < 600; round += 1) {
    const length = 1 + Math.floor(random() * 140);
    const raw = Array.from({ length }, () => pool[Math.floor(random() * pool.length)]!).join('');
    const set = normalizePassword(raw, 'set');
    if (set === null) continue;
    passed += 1;
    expect(normalizePassword(raw, 'sign-in'), `round ${round}`).toBe(set);
    expect(raw.length, `round ${round}`).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify({ email, password: raw })), `round ${round}`).toBeLessThanOrEqual(792);
  }
  // The property is not empty: a good share of the generated values passed the setting rule.
  expect(passed).toBeGreaterThan(200);
});

test('AUTH-003 the display name rule takes 1 to 100 code points without leading or trailing spaces or control characters, as they are', () => {
  for (const name of ['A', 'Ana Uji', 'Ana  Uji', 'A'.repeat(100), '😀'.repeat(100), 'Ａｎａ', "Ana O'Neil-Uji"]) {
    expect(validDisplayName(name), name).toBe(true);
  }
  const refused: [string, string][] = [
    ['empty', ''],
    ['101 code points', 'A'.repeat(101)],
    ['101 code points outside the BMP', '😀'.repeat(101)],
    ['a leading space', ' Ana'],
    ['a trailing space', 'Ana '],
    ['only a space', ' '],
    ['U+0007', 'Ana\u0007'],
    ['U+0085', 'Ana\u0085'],
    ['a tab', 'Ana\tUji'],
    ['a new line', 'Ana\nUji'],
    ['a lone surrogate', 'Ana\uD800'],
  ];
  for (const [label, name] of refused) expect(validDisplayName(name), label).toBe(false);
});

test('AUTH-003 a password hash uses Argon2id m=19456,t=2,p=1 written out, fits password_credentials_hash_check, and verifies only the NFKC form', async () => {
  expect(PASSWORD_HASH_OPTIONS).toEqual({ algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
  expect(Object.isFrozen(PASSWORD_HASH_OPTIONS)).toBe(true);
  expect(PASSWORD_HASH_PREFIX).toBe('$argon2id$v=19$m=19456,t=2,p=1$');
  const raw = 'Ｐａｓｓｗｏｒｄ１２３４５６７８';
  const normalized = normalizePassword(raw, 'set')!;
  const hash = await hashPassword(normalized);
  expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  expect(/^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(hash)).toBe(true);
  expect(await Bun.password.verify(normalized, hash)).toBe(true);
  expect(await Bun.password.verify(raw, hash)).toBe(false);
  // A new salt on every hash.
  expect((await hashPassword(normalized)) === hash).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// AUTH-004, AUTH-007, and AUTH-009 (AC-4, AC-7, AC-9): tokens, the session cookie, and the CSRF check of auth.tokens.ts

test('AUTH-004 a session token is 32 random bytes in base64url (43 characters), new every time', () => {
  const tokens = Array.from({ length: 200 }, () => newSessionToken());
  for (const value of tokens) {
    expect(TOKEN_PATTERN.test(value)).toBe(true);
    expect(Buffer.from(value, 'base64url')).toHaveLength(32);
  }
  expect(new Set(tokens).size).toBe(200);
});

test('AUTH-004 token_hash is SHA 256 of the token in lower case hex, the CSRF token is HMAC SHA 256 keyed by the token over foundation-csrf-v1, and the attempt key hashes sign-in: plus the email', () => {
  for (let round = 0; round < 20; round += 1) {
    const value = newSessionToken();
    const hash = tokenHash(value);
    expect(hash === createHash('sha256').update(value, 'utf8').digest('hex')).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    const csrf = csrfToken(value);
    expect(csrf === createHmac('sha256', Buffer.from(value, 'utf8')).update('foundation-csrf-v1').digest('base64url')).toBe(true);
    expect(TOKEN_PATTERN.test(csrf)).toBe(true);
    expect(csrf === value || hash.includes(value)).toBe(false);
  }
  expect(attemptKey('ana@example.test')).toBe(createHash('sha256').update('sign-in:ana@example.test').digest('hex'));
  expect(attemptKey('ana@example.test')).not.toBe(attemptKey('ana@example.tes'));
});

test('AUTH-004 the session cookie of each mode has the exact name and attributes of table Cookie sesi, without Domain, Expires, or Max-Age when set', () => {
  const value = newSessionToken();
  const production = sessionCookie('production');
  const development = sessionCookie('development');
  expect(production.name).toBe('__Host-foundation_session');
  expect(production.set(value) === `__Host-foundation_session=${value}; Path=/; Secure; HttpOnly; SameSite=Strict`).toBe(true);
  expect(production.clear).toBe('__Host-foundation_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
  expect(development.name).toBe('foundation_session');
  expect(development.set(value) === `foundation_session=${value}; Path=/; HttpOnly; SameSite=Strict`).toBe(true);
  expect(development.clear).toBe('foundation_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  for (const cookie of [production, development]) {
    expect(Object.isFrozen(cookie)).toBe(true);
    expect(cookie.set(value)).not.toMatch(/Domain|Expires|Max-Age/i);
  }
});

test('AUTH-007 the session cookie is read from the raw Cookie header: exactly one pair of that name with a 43 character base64url value, or no valid session', () => {
  const value = newSessionToken();
  const other = newSessionToken();
  const name = 'foundation_session';
  const cases: [string, string | null, { sent: boolean; token: string | null }][] = [
    ['no Cookie header', null, { sent: false, token: null }],
    ['other cookies only', 'theme=dark; lang=id', { sent: false, token: null }],
    ['the cookie alone', `${name}=${value}`, { sent: true, token: value }],
    ['the cookie between others', `theme=dark; ${name}=${value}; lang=id`, { sent: true, token: value }],
    ['spaces around the name and the value', ` ${name} = ${value} `, { sent: true, token: value }],
    ['the name twice with the same value', `${name}=${value}; ${name}=${value}`, { sent: true, token: null }],
    ['the name twice with two values', `${name}=${value}; ${name}=${other}`, { sent: true, token: null }],
    ['a value of 42 characters', `${name}=${value.slice(1)}`, { sent: true, token: null }],
    ['a value of 44 characters', `${name}=${value}a`, { sent: true, token: null }],
    ['an empty value', `${name}=`, { sent: true, token: null }],
    ['a quoted value', `${name}="${value}"`, { sent: true, token: null }],
    ['a value with a character outside base64url', `${name}=${value.slice(1)}!`, { sent: true, token: null }],
    ['the production name in development', `__Host-foundation_session=${value}`, { sent: false, token: null }],
    ['a longer name that ends with the name', `x${name}=${value}`, { sent: false, token: null }],
    ['the name without a value', name, { sent: false, token: null }],
  ];
  for (const [label, header, expected] of cases) {
    const presented = presentedToken(header, name);
    expect(presented.sent, label).toBe(expected.sent);
    expect(presented.token === expected.token, label).toBe(true);
  }
  expect(presentedToken(`__Host-foundation_session=${value}`, '__Host-foundation_session').token === value).toBe(true);
});

test('AUTH-009 the CSRF check accepts only the CSRF token of the same session token, and any other value or length is no match without throwing', () => {
  const value = newSessionToken();
  const own = csrfToken(value);
  const other = csrfToken(newSessionToken());
  expect(csrfMatches(value, own)).toBe(true);
  const refused: [string, string][] = [
    ['the CSRF token of another session', other],
    ['the session token itself', value],
    ['one character short', own.slice(1)],
    ['one character more', `${own}A`],
    ['empty', ''],
    ['a multibyte character at the same UTF-16 length', `é${own.slice(1)}`],
    ['another case', own.toUpperCase() === own ? own.toLowerCase() : own.toUpperCase()],
  ];
  for (const [label, header] of refused) expect(csrfMatches(value, header), label).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// AUTH-010 (AC-10): test accounts and token fingerprints of the real orchestrations (*Sidik token uji*)

test('AUTH-010 the test accounts of the browser runs pass the operator rules and reach Playwright only through the four FOUNDATION_E2E variables', () => {
  const first = newTestAccounts();
  const second = newTestAccounts();
  expect(first[0].email === first[1].email).toBe(false);
  expect(first[0].email === second[0].email).toBe(false);
  expect(first[0].password === first[1].password || first[0].password === second[0].password).toBe(false);
  for (const account of first) {
    expect(normalizeEmail(account.email) === account.email).toBe(true);
    expect(normalizePassword(account.password, 'set') === account.password).toBe(true);
    expect(validDisplayName(account.displayName)).toBe(true);
  }
  expect(first.map((account) => account.displayName)).toEqual(['Pengguna Uji Satu', 'Pengguna Uji Dua']);
  const env = e2eAccountEnv(first);
  expect(Object.keys(env).sort()).toEqual([
    'FOUNDATION_E2E_ACCOUNT_EMAIL', 'FOUNDATION_E2E_ACCOUNT_PASSWORD', 'FOUNDATION_E2E_OTHER_EMAIL', 'FOUNDATION_E2E_OTHER_PASSWORD',
  ]);
  expect(env['FOUNDATION_E2E_ACCOUNT_PASSWORD'] === first[0].password && env['FOUNDATION_E2E_OTHER_PASSWORD'] === first[1].password).toBe(true);
});

test('AUTH-010 test account creation passes the password only in FOUNDATION_ACCOUNT_PASSWORD, never as an argument, and fails with a fixed message', async () => {
  const accounts = newTestAccounts();
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  const created = (argv: string[], env: Record<string, string>): Promise<CommandOutput> => {
    calls.push({ argv, env });
    return Promise.resolve({ code: 0, stdout: `Account created: ${crypto.randomUUID()}\n`, stderr: '' });
  };
  const outputs = await createTestAccounts(created, 'postgres://migrator@127.0.0.1:1/foundation', accounts);
  expect(outputs).toHaveLength(2);
  expect(calls).toHaveLength(2);
  for (const [index, call] of calls.entries()) {
    const account = accounts[index]!;
    expect(call.argv.slice(1)).toEqual(['--no-env-file', 'database/accounts.ts', 'create', '--email', account.email, '--display-name', account.displayName, '--apply']);
    expect(call.argv.some((argument) => argument.includes(account.password))).toBe(false);
    expect(Object.keys(call.env).sort()).toEqual(['FOUNDATION_ACCOUNT_PASSWORD', 'FOUNDATION_MIGRATOR_DATABASE_URL', 'PATH']);
    expect(call.env['FOUNDATION_ACCOUNT_PASSWORD'] === account.password).toBe(true);
  }

  // A command that does not print `Account created: <uuid>` alone on stdout stops the run at that account.
  const failures: CommandOutput[] = [
    { code: 1, stdout: '', stderr: 'Account exists\n' },
    { code: 0, stdout: 'Account created: not-a-uuid\n', stderr: '' },
    { code: 0, stdout: `Account created: ${crypto.randomUUID()}\n`, stderr: 'warning\n' },
  ];
  for (const failure of failures) {
    let runs = 0;
    const error = await createTestAccounts(() => { runs += 1; return Promise.resolve(failure); }, 'postgres://migrator@127.0.0.1:1/foundation', accounts).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Test account creation failed');
    expect(runs).toBe(1);
  }
});

test('AUTH-010 the database suites derive at most 256 account passwords plus the backup account, and database-real.ts scans every label', () => {
  const labels = databaseAccountPasswordLabels();
  expect(DATABASE_ACCOUNT_PASSWORDS).toBe(256);
  expect(labels).toHaveLength(257);
  expect(labels[0]).toBe('backup-account');
  expect(labels.slice(1)).toEqual(Array.from({ length: 256 }, (_, index) => `account-${index + 1}`));
  expect(new Set(labels).size).toBe(257);
});

test('AUTH-010 a suite run alone records nothing, a half configured run fails with a fixed message, and a configured run writes only fingerprints', async () => {
  const value = newSessionToken();
  const csrf = csrfToken(value);
  // Neither variable: the suite runs alone outside its orchestration and nothing happens.
  expect(() => recordTokenFingerprintsWhenConfigured([value, csrf], {})).not.toThrow();
  const folder = await mkdtemp(join(tmpdir(), 'foundation-auth-unit-tokens-'));
  try {
    const file = join(folder, 'fingerprints');
    await writeFile(file, '', { mode: 0o600 });
    const key = newTokenKey();
    const message = `${TOKEN_KEY_VARIABLE} and ${TOKEN_FINGERPRINTS_VARIABLE} are missing; run this spec through its orchestration`;
    expect(() => recordTokenFingerprintsWhenConfigured([value], { [TOKEN_KEY_VARIABLE]: key })).toThrow(message);
    expect(() => recordTokenFingerprintsWhenConfigured([value], { [TOKEN_FINGERPRINTS_VARIABLE]: file })).toThrow(message);
    expect(() => recordTokenFingerprintsWhenConfigured([value], { [TOKEN_KEY_VARIABLE]: 'not hex', [TOKEN_FINGERPRINTS_VARIABLE]: file })).toThrow(message);
    expect(await readFile(file, 'utf8')).toBe('');

    // Both variables: one line per non empty token, 64 hex digits each, never the token.
    recordTokenFingerprintsWhenConfigured(['', value, csrf], { [TOKEN_KEY_VARIABLE]: key, [TOKEN_FINGERPRINTS_VARIABLE]: file });
    const written = await readFile(file, 'utf8');
    const lines = written.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => /^[0-9a-f]{64}$/.test(line))).toBe(true);
    expect(written.includes(value) || written.includes(csrf)).toBe(false);
    expect(parseFingerprints(written)).toEqual(new Set([tokenFingerprint(key, value), tokenFingerprint(key, csrf)]));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('AUTH-010 every run has its own random key, so the fingerprint of a token from another run never matches', () => {
  const value = newSessionToken();
  const keys = Array.from({ length: 10 }, () => newTokenKey());
  expect(keys.every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
  expect(new Set(keys).size).toBe(10);
  const [run, other] = keys as [string, string];
  const fingerprints = new Set([tokenFingerprint(run, value)]);
  expect(tokenMatches(`cookie=${value};`, run, fingerprints)).toBe(1);
  expect(tokenMatches(`cookie=${value};`, other, fingerprints)).toBe(0);
  expect(tokenFingerprint(run, value) === tokenFingerprint(other, value)).toBe(false);
  expect(() => tokenFingerprint('abc', value)).toThrow('Token fingerprint key must be 64 hex digits');
});
