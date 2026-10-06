import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, type Elysia } from 'elysia';
import { createApp } from '../../../apps/backend/src/app';
import { canonicalJson } from '../../../scripts/lib/canonical-json';
import { OPENAPI_MAX_BYTES, OPENAPI_RULE_IDS, OpenApiContractError, REQUIRED_OPERATIONS, validateOpenApi, type OpenApiRuleId } from '../../../scripts/validate-openapi';
import { root, run, runBun, snapshot, workspace } from './workspace';

// Spec 0008 (docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md), build plan steps 1 to 5.
const storedPath = join(root, 'openapi.json');
const storedText = await Bun.file(storedPath).text();
const storedBytes = Buffer.from(await Bun.file(storedPath).arrayBuffer());
const statusRoute = 'apps/backend/src/features/development/status.routes.ts';
const appModule = 'apps/backend/src/app.ts';
const marker = () => `foundation-sentinel-${crypto.randomUUID()}`;
const bytes = async (path: string) => Buffer.from(await Bun.file(path).arrayBuffer());
const temporaryFiles = async (dir: string) => (await readdir(dir)).filter(name => name.startsWith('openapi.json.'));

async function edit(dir: string, path: string, from: string, to: string) {
  const file = join(dir, path);
  const text = await Bun.file(file).text();
  if (!text.includes(from)) throw new Error(`Test setup text not found in ${path}`);
  await Bun.write(file, text.replace(from, to));
}

async function waitFor(condition: () => boolean, ms = 2_000) {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await Bun.sleep(10);
}

test('OPENAPI-001 canonicalJson orders keys by UTF-16 code unit, not by locale or integer keys first', () => {
  const text = canonicalJson(JSON.parse('{"_x":1,"$ref":2,"A":3,"a":4,"10":5,"9":6,"__proto__":{"b":true,"B":null}}'));
  expect([...text.matchAll(/^ {2}"([^"]+)":/gm)].map(match => match[1])).toEqual(['$ref', '10', '9', 'A', '__proto__', '_x', 'a']);
  expect(text).toBe('{\n  "$ref": 2,\n  "10": 5,\n  "9": 6,\n  "A": 3,\n  "__proto__": {\n    "B": null,\n    "b": true\n  },\n  "_x": 1,\n  "a": 4\n}\n');
});

test('OPENAPI-001 canonicalJson reproduces the stored openapi.json text', () => {
  expect(canonicalJson(JSON.parse(storedText))).toBe(storedText);
});

test('OPENAPI-001 canonicalJson keeps array order and the JSON.stringify layout for empty containers', () => {
  // Keys are already in code unit order, so plain JSON.stringify gives the expected layout.
  const value = { empty: {}, list: [3, 'b', 'a', 1], nested: [[], {}, [{ y: [], z: 1 }]], text: 'é "q"' };
  expect(canonicalJson(value)).toBe(JSON.stringify(value, null, 2) + '\n');
  expect(canonicalJson([])).toBe('[]\n');
});

test('OPENAPI-001 canonicalJson keeps UTF-16 code unit order where locale and code point order disagree', () => {
  // localeCompare puts é before z, and code point order puts U+FFFF before the emoji; code unit order does neither.
  const text = canonicalJson(JSON.parse('{"\\uffff": 1, "😀": 2, "é": 3, "z": 4, "a": 5, "Z": 6}'));
  const keys = [...text.matchAll(/^ {2}("(?:[^"\\]|\\.)*"): /gm)].map(match => JSON.parse(match[1]!));
  expect(keys).toEqual(['Z', 'a', 'z', 'é', '😀', '￿']);
});

test('OPENAPI-001 canonicalJson escapes keys and scalars exactly like JSON.stringify', () => {
  // Keys are inserted in code unit order, so JSON.stringify gives the expected text for the same value.
  const value = {
    'a"quote': 'line\nbreak', 'back\\slash': '\u0001 control', 'tab\tkey': '\ud800 lone surrogate', 'ünï': 'ok',
  };
  expect(canonicalJson(value)).toBe(JSON.stringify(value, null, 2) + '\n');
  const scalars = [-0, 1e21, 0.1, 5e-7, -12, true, false, null, ''];
  expect(canonicalJson(scalars)).toBe(JSON.stringify(scalars, null, 2) + '\n');
});

test('OPENAPI-001 canonicalJson rejects values that are not JSON instead of dropping or rewriting them', () => {
  // JSON.stringify would silently drop undefined and functions, or turn NaN into null; the export must never do that.
  for (const value of [NaN, Infinity, -Infinity, undefined, () => 1, Symbol('x'), 1n]) {
    expect(() => canonicalJson(value)).toThrow(TypeError);
    expect(() => canonicalJson({ nested: value })).toThrow(TypeError);
    expect(() => canonicalJson([1, value])).toThrow(TypeError);
  }
});

test('OPENAPI-001 guard preload intercepts every listener, database, and network entry point', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundation-guard-'));
  try {
    await Bun.write(join(dir, 'probe.ts'), `import { serve, listen, connect, udpSocket, SQL, sql, RedisClient, S3Client, redis, s3 } from 'bun';
import { connect as netConnect, createConnection, Socket } from 'node:net';
import * as netNamespace from 'node:net';
import { connect as tlsConnect } from 'node:tls';
const attempts: [string, () => unknown][] = [
  ['Bun.serve', () => Bun.serve({ port: 0, fetch: () => new Response('') })], ['serve', () => serve({ port: 0, fetch: () => new Response('') })],
  ['Bun.listen', () => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })], ['listen', () => listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } } as never)],
  ['Bun.connect', () => Bun.connect({ hostname: '127.0.0.1', port: 9, socket: { data() {} } })], ['connect', () => connect({ hostname: '127.0.0.1', port: 9, socket: { data() {} } } as never)],
  ['Bun.udpSocket', () => Bun.udpSocket({})], ['udpSocket', () => udpSocket({} as never)],
  ['Bun.SQL', () => new Bun.SQL('postgres://guard@127.0.0.1:9/guard')], ['SQL', () => new SQL('postgres://guard@127.0.0.1:9/guard')],
  ['Bun.sql', () => Bun.sql\`select 1\`], ['sql', () => sql\`select 1\`],
  ['fetch', () => fetch('http://127.0.0.1:9')], ['WebSocket', () => new WebSocket('ws://127.0.0.1:9')],
  ['net.connect', () => netConnect(9, '127.0.0.1')], ['net namespace connect', () => netNamespace.connect(9, '127.0.0.1')],
  ['net.createConnection', () => createConnection(9, '127.0.0.1')], ['tls.connect', () => tlsConnect(9, '127.0.0.1')],
  ['net.Socket connect', () => new Socket().connect(9, '127.0.0.1')],
  ['Bun.RedisClient', () => new Bun.RedisClient('redis://127.0.0.1:9')], ['RedisClient', () => new RedisClient('redis://127.0.0.1:9')],
  ['Bun.redis', () => Bun.redis.get('key')], ['redis', () => redis.get('key')],
  ['Bun.S3Client', () => new Bun.S3Client({ endpoint: 'http://127.0.0.1:9' })], ['S3Client', () => new S3Client({ endpoint: 'http://127.0.0.1:9' })],
  ['Bun.s3', () => Bun.s3.file('key')], ['s3', () => s3.file('key')],
];
for (const [name, attempt] of attempts) {
  try { attempt(); console.log('unblocked ' + name); } catch {}
}
process.exit(0);
`);
    const result = await runBun(dir, ['probe.ts'], { guard: true });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect((await Bun.file(join(dir, 'guard-calls.log')).text()).trim().split('\n')).toEqual([
      'Bun.serve', 'Bun.serve', 'Bun.listen', 'Bun.listen', 'Bun.connect', 'Bun.connect', 'Bun.udpSocket', 'Bun.udpSocket',
      'Bun.SQL', 'Bun.SQL', 'Bun.sql', 'Bun.sql', 'fetch', 'WebSocket',
      'node:net.connect', 'node:net.connect', 'node:net.createConnection', 'node:tls.connect', 'node:net.Socket.connect',
      'Bun.RedisClient', 'Bun.RedisClient', 'Bun.redis', 'Bun.redis', 'Bun.S3Client', 'Bun.S3Client', 'Bun.s3', 'Bun.s3',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test('OPENAPI-001 export runs twice under the guard without listener, database, or network and reproduces the stored file', async () => {
  const dir = await workspace();
  let connections = 0;
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { open(socket) { connections++; socket.end(); }, data() {} } });
  const password = marker();
  const sentinel = marker();
  // The database, Redis, and SMTP variables that the checkout .env lists all point at the same counting listener.
  const env = {
    DATABASE_URL: `postgres://sentinel_user:${password}@127.0.0.1:${listener.port}/sentinel_db`, FOUNDATION_EXPORT_SENTINEL: sentinel,
    REDIS_URL: `redis://sentinel_user:${password}@127.0.0.1:${listener.port}`, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(listener.port),
  };
  try {
    const outputs: Buffer[] = [];
    for (let i = 0; i < 2; i++) {
      // Start each run from a placeholder, so both runs must write the whole file themselves.
      await Bun.write(join(dir, 'openapi.json'), '{}\n');
      const placeholder = (await stat(join(dir, 'openapi.json'))).ino;
      const result = await runBun(dir, ['scripts/export-openapi.ts'], { env, guard: true });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toBe('OpenAPI exported without listener\n');
      expect(result.stderr).toBe('');
      // A rename puts a new file in place; writing into openapi.json directly would keep the placeholder inode.
      expect((await stat(join(dir, 'openapi.json'))).ino).not.toBe(placeholder);
      const output = await bytes(join(dir, 'openapi.json'));
      outputs.push(output);
      for (const text of [output.toString('utf8'), result.stdout, result.stderr]) {
        for (const forbidden of ['localhost', password, sentinel]) expect(text).not.toContain(forbidden);
      }
    }
    expect(outputs[0]!.equals(storedBytes)).toBe(true);
    expect(outputs[1]!.equals(outputs[0]!)).toBe(true);
    expect(Object.hasOwn(JSON.parse(storedText), 'servers')).toBe(false);
    expect(await Bun.file(join(dir, 'guard-calls.log')).exists()).toBe(false);
    expect(await temporaryFiles(dir)).toEqual([]);
    expect(connections).toBe(0);
    // The sentinel really counts connections, so zero above is meaningful.
    const client = await Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data() {} } });
    await waitFor(() => connections === 1);
    client.end();
    expect(connections).toBe(1);
  } finally {
    listener.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test('OPENAPI-001 negative control: a Bun.sql call in createApp trips the guard, and without the guard it reaches the sentinel', async () => {
  const dir = await workspace();
  let connections = 0;
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { open(socket) { connections++; socket.end(); }, data() {} } });
  const env = { DATABASE_URL: `postgres://sentinel_user:${marker()}@127.0.0.1:${listener.port}/sentinel_db` };
  let unguarded: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await edit(dir, appModule, "export function createApp(mode: 'development' | 'production', options: AppOptions = {}) {",
      "export function createApp(mode: 'development' | 'production', options: AppOptions = {}) {\n  void Bun.sql`select 1`.catch(() => undefined);");
    const guarded = await runBun(dir, ['scripts/export-openapi.ts'], { env, guard: true });
    expect(guarded.code).toBe(1);
    expect(guarded.stderr).toBe('OpenAPI export failed\n');
    expect(guarded.stdout).toBe('');
    expect(await Bun.file(join(dir, 'guard-calls.log')).text()).toBe('Bun.sql\n');
    expect(connections).toBe(0);
    expect((await bytes(join(dir, 'openapi.json'))).equals(storedBytes)).toBe(true);
    // The same composition without the guard connects to DATABASE_URL, so zero connections under the guard is meaningful.
    // Bun.sql keeps retrying against the sentinel, so the process is killed once the first connection arrives.
    unguarded = Bun.spawn([process.execPath, '--no-env-file', 'scripts/export-openapi.ts'], {
      cwd: dir, env: { PATH: process.env['PATH']!, HOME: process.env['HOME']!, ...env }, stdout: 'ignore', stderr: 'ignore', timeout: 10_000, killSignal: 'SIGKILL',
    });
    await waitFor(() => connections > 0, 8_000);
    expect(connections).toBeGreaterThan(0);
  } finally {
    unguarded?.kill('SIGKILL');
    await unguarded?.exited;
    listener.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test('OPENAPI-001 export reads the real composition: route summary and plugin version changes reach openapi.json', async () => {
  // Value sourcing: info.description is the @elysia/openapi 1.4.16 default, the rest comes from app.ts and the route.
  expect(JSON.parse(storedText).info).toStrictEqual({ description: 'Development documentation', title: 'Foundation development API', version: '0.1.0' });
  const dir = await workspace();
  try {
    await edit(dir, statusRoute, "summary: 'Development process status'", "summary: 'Changed status summary'");
    await edit(dir, appModule, "version: '0.1.0'", "version: '9.8.7'");
    const result = await runBun(dir, ['scripts/export-openapi.ts']);
    expect(result.code, result.stderr).toBe(0);
    const text = await Bun.file(join(dir, 'openapi.json')).text();
    const document = JSON.parse(text);
    expect(document.paths['/api/status'].get.summary).toBe('Changed status summary');
    expect(document.info).toStrictEqual({ description: 'Development documentation', title: 'Foundation development API', version: '9.8.7' });
    expect(document.openapi).toBe('3.1.0');
    expect(text).toBe(canonicalJson(document));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test('OPENAPI-001 export started from a subdirectory with extra arguments ignores them and writes only the root openapi.json', async () => {
  const dir = await workspace();
  try {
    await Bun.write(join(dir, 'openapi.json'), '{}\n');
    const result = await runBun(join(dir, 'apps'), ['../scripts/export-openapi.ts', '--out', 'elsewhere.json', 'openapi.json']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('OpenAPI exported without listener\n');
    expect((await bytes(join(dir, 'openapi.json'))).equals(storedBytes)).toBe(true);
    for (const stray of ['apps/openapi.json', 'apps/elsewhere.json', 'elsewhere.json']) expect(await Bun.file(join(dir, stray)).exists(), stray).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test('OPENAPI-001 export text is byte identical under the tr_TR, de_DE, and C locales', async () => {
  const dir = await workspace();
  try {
    for (const locale of ['tr_TR.UTF-8', 'de_DE.UTF-8', 'C']) {
      await Bun.write(join(dir, 'openapi.json'), '{}\n');
      const result = await runBun(dir, ['scripts/export-openapi.ts'], { env: { LC_ALL: locale, LANG: locale } });
      expect(result.code, `${locale}: ${result.stderr}`).toBe(0);
      expect((await bytes(join(dir, 'openapi.json'))).equals(storedBytes), locale).toBe(true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

const exportFailures: [string, (dir: string, secret: string) => Promise<void>, string][] = [
  ['(a) status route operationId get-development-status', dir => edit(dir, statusRoute, "operationId: 'getDevelopmentStatus'", "operationId: 'get-development-status'"), 'OpenAPI export failed\nrule: operation-id\n'],
  ['(b) route module that throws while it is imported', (dir, secret) => Bun.write(join(dir, statusRoute), `throw new Error('${secret}');\nexport const developmentRoutes = undefined;\n`).then(() => undefined), 'OpenAPI export failed\n'],
  ['(c) createApp that throws', (dir, secret) => edit(dir, appModule, "export function createApp(mode: 'development' | 'production', options: AppOptions = {}) {", `export function createApp(mode: 'development' | 'production', options: AppOptions = {}) {\n  if (mode) throw new Error('${secret}');`), 'OpenAPI export failed\n'],
  ['(d) canonical text above 8 MiB', dir => edit(dir, appModule, "info: { title: 'Foundation development API', version: '0.1.0' }", "info: { title: 'Foundation development API', version: '0.1.0', description: 'x'.repeat(8_400_000) }"), 'OpenAPI export failed\n'],
  // Value sourcing: the accepted version is the 3.1.0 pin of the checker, not whatever the plugin is configured with.
  ['openapiVersion 3.1.2 in the plugin configuration', dir => edit(dir, appModule, "openapiVersion: '3.1.0'", "openapiVersion: '3.1.2'"), 'OpenAPI export failed\nrule: version\n'],
  // The process handlers keep a stray rejection from printing Bun's default report with the message and stack.
  ['a route module that leaves an unhandled rejection', async (dir, secret) => {
    const file = join(dir, statusRoute);
    await Bun.write(file, `Promise.reject(new Error('${secret}'));\n${await Bun.file(file).text()}`);
  }, 'OpenAPI export failed\n'],
  ['a route module that throws from a zero delay timer it starts while it is imported', async (dir, secret) => {
    const file = join(dir, statusRoute);
    await Bun.write(file, `setTimeout(() => { throw new Error('${secret}'); }, 0);\n${await Bun.file(file).text()}`);
  }, 'OpenAPI export failed\n'],
  // The plugin moved to another path: /openapi/json answers 404 through the onError handler of app.ts.
  ['an /openapi/json response that is not 200', dir => edit(dir, appModule, "provider: null,", "provider: null, path: '/moved',"), 'OpenAPI export failed\n'],
  ['an /openapi/json response that answers 200 with text that is not JSON', async dir => {
    await edit(dir, appModule, "provider: null,", "provider: null, path: '/moved',");
    // The tail of createApp follows spec 0014 (*Teks akhir `createApp`*).
    await edit(dir, appModule, '.use(developmentRoutes).use(authRoutes).use(healthRoutes);', ".use(developmentRoutes).use(authRoutes).use(healthRoutes).get('/openapi/json', () => 'not json');");
  }, 'OpenAPI export failed\n'],
];
for (const [name, mutate, stderr] of exportFailures) {
  test(`OPENAPI-005 export fails safely for ${name} and leaves openapi.json unchanged`, async () => {
    const dir = await workspace();
    const secret = marker();
    try {
      await mutate(dir, secret);
      const before = await stat(join(dir, 'openapi.json'));
      const result = await runBun(dir, ['scripts/export-openapi.ts']);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(stderr);
      expect(result.stdout).toBe('');
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect((await bytes(join(dir, 'openapi.json'))).equals(storedBytes)).toBe(true);
      // Equal bytes are not enough: a failed export must not have replaced the file with an identical copy either.
      const after = await stat(join(dir, 'openapi.json'));
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      expect(await temporaryFiles(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
}

test('OPENAPI-005 export fails safely when the finished file cannot replace openapi.json and removes its temporary file', async () => {
  const dir = await workspace();
  try {
    // A non empty directory at the target makes the final rename fail after the temporary file was written.
    await rm(join(dir, 'openapi.json'));
    await mkdir(join(dir, 'openapi.json'));
    await Bun.write(join(dir, 'openapi.json', 'keep.txt'), 'keep');
    const result = await runBun(dir, ['scripts/export-openapi.ts']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('OpenAPI export failed\n');
    expect(result.stdout).toBe('');
    expect(await readdir(join(dir, 'openapi.json'))).toEqual(['keep.txt']);
    expect(await temporaryFiles(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test('OPENAPI-005 export limit counts UTF-8 bytes: exactly 8 MiB is written and accepted, one byte more or multibyte text above 8 MiB fails', async () => {
  // The stored info.description is the plugin default; a description configured in app.ts replaces it unescaped.
  const base = storedBytes.length - Buffer.byteLength('Development documentation');
  const ascii = OPENAPI_MAX_BYTES - base;
  const multibyte = Math.floor(ascii / 2) + 1;
  // é is one UTF-16 code unit and two UTF-8 bytes, so this text stays under 8 Mi characters but passes 8 MiB in bytes.
  expect(base + multibyte).toBeLessThan(OPENAPI_MAX_BYTES);
  expect(base + 2 * multibyte).toBeGreaterThan(OPENAPI_MAX_BYTES);
  const dir = await workspace();
  const path = join(dir, 'openapi.json');
  const describe = (expression: string) => edit(dir, appModule, "version: '0.1.0' }", `version: '0.1.0', description: ${expression} }`);
  try {
    for (const expression of [`'x'.repeat(${ascii + 1})`, `'\\u00e9'.repeat(${multibyte})`]) {
      await Bun.write(join(dir, appModule), await Bun.file(join(root, appModule)).text());
      await describe(expression);
      const before = await stat(path);
      const rejected = await runBun(dir, ['scripts/export-openapi.ts']);
      expect(rejected.code, expression).toBe(1);
      expect(rejected.stderr).toBe('OpenAPI export failed\n');
      expect(rejected.stdout).toBe('');
      expect((await bytes(path)).equals(storedBytes)).toBe(true);
      expect((await stat(path)).ino).toBe(before.ino);
      expect(await temporaryFiles(dir)).toEqual([]);
    }
    await Bun.write(join(dir, appModule), await Bun.file(join(root, appModule)).text());
    await describe(`'x'.repeat(${ascii})`);
    const accepted = await runBun(dir, ['scripts/export-openapi.ts']);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(accepted.stdout).toBe('OpenAPI exported without listener\n');
    expect((await stat(path)).size).toBe(OPENAPI_MAX_BYTES);
    const validated = await runBun(dir, ['scripts/validate-openapi.ts']);
    expect(validated.code, validated.stderr).toBe(0);
    expect(validated.stdout).toBe('OpenAPI project checks passed\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test('OPENAPI-005 (e) api:sync stops at a contract violation before sdk:generate and leaves the SDK unchanged', async () => {
  const dir = await workspace();
  try {
    await edit(dir, statusRoute, "operationId: 'getDevelopmentStatus'", "operationId: 'get-development-status'");
    const manifest = join(dir, 'package.json');
    const pkg = await Bun.file(manifest).json();
    pkg.scripts['sdk:generate'] = `bun -e 'await Bun.write("sdk-generate.marker", "ran")'`;
    await Bun.write(manifest, JSON.stringify(pkg, null, 2));
    const before = await snapshot(join(dir, 'apps/frontend/sdk'));
    const result = await run(dir, 'api:sync');
    expect(result.code).not.toBe(0);
    expect(await Bun.file(join(dir, 'sdk-generate.marker')).exists()).toBe(false);
    expect(await snapshot(join(dir, 'apps/frontend/sdk'))).toBe(before);
    expect((await bytes(join(dir, 'openapi.json'))).equals(storedBytes)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

let files = '';
beforeAll(async () => { files = await mkdtemp(join(tmpdir(), 'foundation-openapi-cli-')); });
afterAll(async () => { await rm(files, { recursive: true, force: true }); });
const validate = (...args: string[]) => runBun(root, ['scripts/validate-openapi.ts', ...args]);
const failed = 'OpenAPI validation failed\n';

test('OPENAPI-005 validator accepts a valid contract padded to exactly 8 MiB and rejects one byte more without a rule line', async () => {
  const path = join(files, 'padded.json');
  await Bun.write(path, storedText + ' '.repeat(OPENAPI_MAX_BYTES - Buffer.byteLength(storedText)));
  expect((await stat(path)).size).toBe(OPENAPI_MAX_BYTES);
  const accepted = await validate(path);
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(accepted.stdout).toBe('OpenAPI project checks passed\n');
  expect(accepted.stderr).toBe('');
  await Bun.write(path, storedText + ' '.repeat(OPENAPI_MAX_BYTES + 1 - Buffer.byteLength(storedText)));
  const rejected = await validate(path);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toBe(failed);
  expect(rejected.stdout).toBe('');
}, 15_000);

test('OPENAPI-005 validator rejects a sparse 1 GiB file before the kill limit', async () => {
  const path = join(files, 'sparse.json');
  await Bun.write(path, storedText);
  await truncate(path, 1024 ** 3);
  const started = Date.now();
  const result = await validate(path);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe(failed);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

test('OPENAPI-005 validator keeps its read bound and file check after open when the path changes after stat', async () => {
  // The preload makes every stat report a small regular file, as if the path was swapped or grew between stat and
  // open, so only the checks after open stand between the validator and the real input.
  const preload = join(files, 'stat-reports-small-file.ts');
  await Bun.write(preload, `import { createRequire } from 'node:module';
const fs = createRequire(import.meta.url)('node:fs/promises') as Record<string, unknown>;
fs['stat'] = async () => ({ isFile: () => true, size: 0 });
`);
  const checked = (path: string) => runBun(root, ['--preload', preload, 'scripts/validate-openapi.ts', path]);
  const path = join(files, 'grown.json');
  await Bun.write(path, storedText + ' '.repeat(OPENAPI_MAX_BYTES - Buffer.byteLength(storedText)));
  const exact = await checked(path);
  expect(exact.code, exact.stderr).toBe(0);
  expect(exact.stdout).toBe('OpenAPI project checks passed\n');
  await Bun.write(path, storedText + ' '.repeat(OPENAPI_MAX_BYTES + 1 - Buffer.byteLength(storedText)));
  const fifo = join(files, 'swapped.fifo');
  expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
  for (const input of [path, '/dev/zero', fifo]) {
    const result = await checked(input);
    expect(result.code, input).toBe(1);
    expect(result.stderr).toBe(failed);
    expect(result.stdout).toBe('');
  }
}, 15_000);

test('OPENAPI-005 validator treats one argument as a path whatever its prefix and defaults to root openapi.json', async () => {
  await Bun.write(join(files, '--contract.json'), storedText);
  const prefixed = await runBun(files, [join(root, 'scripts/validate-openapi.ts'), '--contract.json']);
  expect(prefixed.code, prefixed.stderr).toBe(0);
  expect(prefixed.stdout).toBe('OpenAPI project checks passed\n');
  const defaulted = await validate();
  expect(defaulted.code, defaulted.stderr).toBe(0);
  expect(defaulted.stdout).toBe('OpenAPI project checks passed\n');
}, 15_000);

const inputFailures: [string, () => Promise<string[]>][] = [
  ['two arguments', async () => [storedPath, storedPath]],
  ['a missing file', async () => [join(files, 'missing.json')]],
  ['a directory', async () => [files]],
  ['/dev/zero', async () => ['/dev/zero']],
  ['a FIFO', async () => {
    const path = join(files, 'contract.fifo');
    expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0);
    return [path];
  }],
  ['an empty path argument', async () => ['']],
  ['an empty file', async () => {
    const path = join(files, 'empty.json');
    await Bun.write(path, '');
    return [path];
  }],
  // JSON.parse in the SDK generator rejects a byte order mark, so the checker must not hide it by decoding.
  ['a valid contract that starts with a UTF-8 byte order mark', async () => {
    const path = join(files, 'bom.json');
    await Bun.write(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), storedBytes]));
    return [path];
  }],
];
for (const [name, args] of inputFailures) {
  test(`OPENAPI-005 validator rejects ${name} with exit 1 and the fixed message`, async () => {
    const result = await validate(...await args());
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(failed);
    expect(result.stdout).toBe('');
  }, 15_000);
}

test('OPENAPI-005 validator rejects contract text that is not UTF-8, while the same text with U+FFFD passes', async () => {
  // The invalid byte sits inside the title string, so only strict UTF-8 decoding rejects it; a lenient decoder would
  // turn it into U+FFFD and accept text that is not valid JSON (RFC 8259 requires UTF-8).
  const title = 'Foundation development API';
  const at = storedText.indexOf(title);
  expect(at).toBeGreaterThan(-1);
  const withTitle = (bytes: number[]) => Buffer.concat([Buffer.from(storedText.slice(0, at)), Buffer.from(bytes), Buffer.from(storedText.slice(at + title.length))]);
  const invalid = join(files, 'not-utf8.json');
  await Bun.write(invalid, withTitle([0x46, 0xff, 0x41]));
  const rejected = await validate(invalid);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toBe(failed);
  expect(rejected.stdout).toBe('');
  const replaced = join(files, 'replacement.json');
  await Bun.write(replaced, withTitle([0x46, ...Buffer.from('�'), 0x41]));
  const accepted = await validate(replaced);
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(accepted.stdout).toBe('OpenAPI project checks passed\n');
}, 15_000);

test('OPENAPI-005 validator output never shows the file name, file content, or parser message', async () => {
  const secret = marker();
  const malformed = join(files, `${secret}.json`);
  await Bun.write(malformed, `{"${secret}": `);
  const parse = await validate(malformed);
  expect(parse.code).toBe(1);
  expect(parse.stderr).toBe(failed);
  const invalid = join(files, `${secret}-contract.json`);
  await Bun.write(invalid, storedText.replace('"getDevelopmentStatus"', `"${secret}"`));
  const contract = await validate(invalid);
  expect(contract.code).toBe(1);
  expect(contract.stderr).toBe('OpenAPI validation failed\nrule: operation-id\n');
  for (const result of [parse, contract]) {
    expect(result.stdout).toBe('');
    expect(result.stdout + result.stderr).not.toContain(secret);
  }
  await Bun.write(invalid, '[]');
  const document = await validate(invalid);
  expect(document.code).toBe(1);
  expect(document.stderr).toBe('OpenAPI validation failed\nrule: document\n');
}, 15_000);

// Rule matrices of build plan steps 2 and 3: OPENAPI-002 (AC-3), OPENAPI-003 (AC-4), and OPENAPI-004 (AC-5).
// Every row starts from tests/fixtures/openapi/valid.json, breaks one clause, and names the rule ID that the
// table order makes the topmost violation. Rows also prove that the checker leaves the document unchanged.
const validText = await Bun.file(join(root, 'tests/fixtures/openapi/valid.json')).text();
const fresh = (): any => JSON.parse(validText);
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const statusItem = (d: any) => d.paths['/api/status'];
const statusOperation = (d: any) => d.paths['/api/status'].get;
const statusModel = (d: any) => d.components.schemas.DevelopmentStatus;
const statusLiteral = (d: any) => d.components.schemas.DevelopmentStatus.properties.status;
const okSchema = (d: any) => statusOperation(d).responses['200'].content['application/json'].schema;
const failureSchema = (d: any) => statusOperation(d).responses['500'].content['application/json'].schema;
const okResponse = () => ({ description: 'Ok', content: { 'application/json': { schema: ref('DevelopmentStatus') } } });
const bearer = { type: 'http', scheme: 'bearer' };
const idParameter = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const query = (name: string, schema: unknown = { type: 'string' }, extra: Record<string, unknown> = {}) => ({ name, in: 'query', schema, ...extra });
const statusParameters = (d: any, ...parameters: unknown[]) => { statusOperation(d).parameters = parameters; };
/** Adds a valid operation next to the required status operation. */
function addOperation(d: any, path: string, method: string, operationId: string, extra: Record<string, unknown> = {}) {
  d.paths[path] ??= {};
  d.paths[path][method] = { operationId, tags: ['development'], security: [], responses: { '200': okResponse() }, ...extra };
  return d.paths[path][method];
}
const itemOperation = (d: any, parameters: unknown[]) => addOperation(d, '/api/items/{id}', 'get', 'getItem', { parameters });
const postBody = (d: any, requestBody: unknown) => addOperation(d, '/api/status', 'post', 'postStatus', { requestBody });
const jsonBody = (content: Record<string, unknown> = { 'application/json': { schema: ref('DevelopmentStatus') } }, extra: Record<string, unknown> = {}) => ({ required: true, content, ...extra });
const movePath = (d: any, to: string) => { d.paths[to] = d.paths['/api/status']; delete d.paths['/api/status']; };
/** Puts a schema under `properties.detail` of the inline 500 response schema, two levels deep. */
const property = (d: any, schema: unknown) => { failureSchema(d).properties.detail = schema; };
const component = (d: any, name: string, schema: unknown) => { d.components.schemas[name] = schema; };
const scheme = (d: any, name: string, value: unknown) => { (d.components.securitySchemes ??= {})[name] = value; };
const otherOperation = (d: any, security: unknown) => addOperation(d, '/api/other', 'get', 'getOther', { security });
const nestedProperties = (levels: number) => {
  let schema: unknown = { type: 'string' };
  for (let level = 1; level < levels; level++) schema = { type: 'object', properties: { next: schema } };
  return schema;
};
const nestedItems = (levels: number) => {
  let schema: unknown = { type: 'string' };
  for (let level = 1; level < levels; level++) schema = { type: 'array', items: schema };
  return schema;
};
/** A whole replacement document, for roots that are not an object or keys that must be parsed from text. */
class Replace {
  constructor(readonly document: unknown) {}
}
const withRootKey = (key: string) => new Replace(JSON.parse(`{${JSON.stringify(key)}: {}, ${validText.trimStart().slice(1)}`));

function ruleOf(document: unknown): OpenApiRuleId | 'accepted' {
  try {
    validateOpenApi(document);
    return 'accepted';
  } catch (error) {
    if (error instanceof OpenApiContractError) return error.rule;
    throw error;
  }
}

/** Own keys in the same order and the same values, so any change by the checker is caught. */
function unchanged(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a);
  const right = Object.keys(b);
  return left.length === right.length &&
    left.every((key, index) => key === right[index] && unchanged((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

type Mutation = (d: any) => unknown;
type Scenario = 'OPENAPI-002' | 'OPENAPI-003' | 'OPENAPI-004';
const rows = (scenario: Scenario, list: [string, OpenApiRuleId, Mutation][]) =>
  list.map(([name, rule, mutate]) => [scenario, name, rule, mutate] as const);
const paths = ['/api/status?verbose=1', '/api/{id', '/api/id}', '/api/status/', '/api//status', '/', 'api/status', '/api/status#top', '/api/status now', '/api/{a}{b}', '/api/{1id}', '/api/{id}/items/{id}',
  '/api/../admin', '/api/./status', '/..', '/.'];

/** Mutation matrix; OPENAPI-007 (build plan step 5) checks that every rule ID has a row here. */
const matrix = [
  ...rows('OPENAPI-002', [
    ['a root array', 'document', () => new Replace([])],
    ['a root null', 'document', () => new Replace(null)],
    ['a root string', 'document', () => new Replace('openapi')],
    ['servers', 'document', d => { d.servers = [{ url: 'https://api.example.invalid' }]; }],
    ['webhooks', 'document', d => { d.webhooks = {}; }],
    ['externalDocs', 'document', d => { d.externalDocs = { url: 'https://docs.example.invalid' }; }],
    ['jsonSchemaDialect', 'document', d => { d.jsonSchemaDialect = 'https://spec.openapis.org/oas/3.1/dialect/base'; }],
    ['an x- extension at the root', 'document', d => { d['x-internal'] = true; }],
    ['a root __proto__ key parsed from text', 'document', () => withRootKey('__proto__')],
    ['a missing openapi key', 'document', d => { delete d.openapi; }],
    ['a missing info key', 'document', d => { delete d.info; }],
    ['a missing paths key', 'document', d => { delete d.paths; }],
    ['version 3.0.3', 'version', d => { d.openapi = '3.0.3'; }],
    ['version 3.1.1', 'version', d => { d.openapi = '3.1.1'; }],
    ['version 3.2.0', 'version', d => { d.openapi = '3.2.0'; }],
    ['a numeric version', 'version', d => { d.openapi = 3.1; }],
    ['info that is not an object', 'info', d => { d.info = 'Foundation'; }],
    ['an empty info title', 'info', d => { d.info.title = ''; }],
    ['a blank info title', 'info', d => { d.info.title = '   '; }],
    ['a missing info version', 'info', d => { delete d.info.version; }],
    ['a numeric info version', 'info', d => { d.info.version = 1; }],
    ['a numeric info description', 'info', d => { d.info.description = 1; }],
    ['an unknown info key', 'info', d => { d.info.contact = { name: 'Team' }; }],
    ['empty paths', 'path', d => { d.paths = {}; }],
    ['paths that are an array', 'path', d => { d.paths = []; }],
    ...paths.map((path): [string, OpenApiRuleId, Mutation] => [`path ${JSON.stringify(path)}`, 'path', d => movePath(d, path)]),
    ['a path item $ref', 'path', d => { statusItem(d).$ref = '#/paths/~1api~1other'; }],
    ['a path item that is not an object', 'path', d => { d.paths['/api/other'] = []; }],
    ['trace', 'method', d => { statusItem(d).trace = { ...structuredClone(statusOperation(d)), operationId: 'traceStatus' }; }],
    ['path item parameters', 'method', d => { statusItem(d).parameters = [query('verbose')]; }],
    ['path item servers', 'method', d => { statusItem(d).servers = []; }],
    ['a numeric path item summary', 'method', d => { statusItem(d).summary = 1; }],
    ['a path item without any method', 'method', d => { d.paths['/api/other'] = { summary: 'Other' }; }],
    ['an unknown method fetch', 'method', d => { statusItem(d).fetch = {}; }],
    ['an uppercase method GET', 'method', d => { statusItem(d).GET = structuredClone(statusOperation(d)); }],
    ['an x- extension on a path item', 'method', d => { statusItem(d)['x-owner'] = 'team'; }],
    ['an operation that is an array', 'operation', d => { statusItem(d).get = []; }],
    ['an operation that is null', 'operation', d => { statusItem(d).get = null; }],
    ['operation callbacks', 'operation', d => { statusOperation(d).callbacks = {}; }],
    ['operation externalDocs', 'operation', d => { statusOperation(d).externalDocs = { url: 'https://docs.example.invalid' }; }],
    ['operation servers', 'operation', d => { statusOperation(d).servers = []; }],
    ['an x- extension on an operation', 'operation', d => { statusOperation(d)['x-owner'] = 'team'; }],
    ['a numeric operation summary', 'operation', d => { statusOperation(d).summary = 1; }],
    ['a boolean operation description', 'operation', d => { statusOperation(d).description = false; }],
    ['a string deprecated flag', 'operation', d => { statusOperation(d).deprecated = 'yes'; }],
    ['a missing operationId', 'operation-id', d => { delete statusOperation(d).operationId; }],
    ['an operationId with a hyphen', 'operation-id', d => { statusOperation(d).operationId = 'get-development-status'; }],
    ['a duplicate operationId', 'operation-id', d => { addOperation(d, '/api/other', 'get', 'getDevelopmentStatus'); }],
    ['an operationId that starts uppercase', 'operation-id', d => { statusOperation(d).operationId = 'GetDevelopmentStatus'; }],
    ['an operationId with consecutive capitals', 'operation-id', d => { statusOperation(d).operationId = 'getAPIStatus'; }],
    ['an operationId with an underscore', 'operation-id', d => { statusOperation(d).operationId = 'get_status'; }],
    ['an empty operationId', 'operation-id', d => { statusOperation(d).operationId = ''; }],
    ['a numeric operationId', 'operation-id', d => { statusOperation(d).operationId = 7; }],
    ['two tags on one operation', 'tag', d => { d.tags.push({ name: 'other' }); statusOperation(d).tags = ['development', 'other']; }],
    ['an undeclared tag', 'tag', d => { statusOperation(d).tags = ['other']; }],
    ['missing operation tags', 'tag', d => { delete statusOperation(d).tags; }],
    ['empty operation tags', 'tag', d => { statusOperation(d).tags = []; }],
    ['a numeric operation tag', 'tag', d => { statusOperation(d).tags = [1]; }],
    ['missing document tags', 'tag', d => { delete d.tags; }],
    ['document tags that are an object', 'tag', d => { d.tags = { name: 'development' }; }],
    ['a document tag with externalDocs', 'tag', d => { d.tags[0].externalDocs = { url: 'https://docs.example.invalid' }; }],
    ['a document tag name that is not kebab case', 'tag', d => { d.tags.push({ name: 'Development' }); }],
    ['a document tag name with an underscore', 'tag', d => { d.tags.push({ name: 'dev_tools' }); }],
    ['a duplicate document tag', 'tag', d => { d.tags.push({ name: 'development' }); }],
    ['a numeric document tag description', 'tag', d => { d.tags[0].description = 1; }],
    ['parameters that are an object', 'parameter', d => { statusOperation(d).parameters = { verbose: query('verbose') }; }],
    ['a parameter $ref', 'parameter', d => statusParameters(d, { $ref: '#/components/parameters/Verbose' })],
    ['a cookie parameter', 'parameter', d => statusParameters(d, { name: 'session', in: 'cookie', schema: { type: 'string' } })],
    ['an array parameter', 'parameter', d => statusParameters(d, query('ids', { type: 'array', items: { type: 'string' } }))],
    ['an object parameter', 'parameter', d => statusParameters(d, query('filter', { type: 'object', properties: {} }))],
    ['a parameter schema $ref', 'parameter', d => statusParameters(d, query('verbose', ref('DevelopmentStatus')))],
    ['a parameter without schema', 'parameter', d => statusParameters(d, { name: 'verbose', in: 'query' })],
    ['a parameter schema with a type array', 'parameter', d => statusParameters(d, query('label', { type: ['string', 'null'] }))],
    ['a parameter schema without type (t.Integer anyOf)', 'parameter', d => statusParameters(d, query('count', { anyOf: [{ format: 'integer', default: 0, type: 'string' }, { type: 'integer' }] }))],
    ['a parameter with content', 'parameter', d => statusParameters(d, query('filter', { type: 'string' }, { content: { 'application/json': { schema: { type: 'string' } } } }))],
    ['a parameter with style', 'parameter', d => statusParameters(d, query('verbose', undefined, { style: 'form' }))],
    ['a parameter with explode', 'parameter', d => statusParameters(d, query('verbose', undefined, { explode: true }))],
    ['a parameter with allowEmptyValue', 'parameter', d => statusParameters(d, query('verbose', undefined, { allowEmptyValue: true }))],
    ['a deprecated parameter', 'parameter', d => statusParameters(d, query('verbose', undefined, { deprecated: true }))],
    ['an x- extension on a parameter', 'parameter', d => statusParameters(d, query('verbose', undefined, { 'x-name': 'v' }))],
    ['the same name in path and query', 'parameter', d => { itemOperation(d, [idParameter, query('id')]); }],
    ['header names that differ only in case', 'parameter', d => statusParameters(d, { name: 'X-Trace', in: 'header', schema: { type: 'string' } }, { name: 'x-trace', in: 'header', schema: { type: 'string' } })],
    ['a parameter named body', 'parameter', d => statusParameters(d, query('body'))],
    ['a header parameter named Body', 'parameter', d => statusParameters(d, { name: 'Body', in: 'header', schema: { type: 'string' } })],
    ['an empty parameter name', 'parameter', d => statusParameters(d, query(''))],
    ['a blank parameter name', 'parameter', d => statusParameters(d, query('  '))],
    ['a parameter in formData', 'parameter', d => statusParameters(d, { name: 'verbose', in: 'formData', schema: { type: 'string' } })],
    ['a parameter without in', 'parameter', d => statusParameters(d, { name: 'verbose', schema: { type: 'string' } })],
    ['a path parameter with required false', 'parameter', d => { itemOperation(d, [{ ...idParameter, required: false }]); }],
    ['a path parameter without required', 'parameter', d => { itemOperation(d, [{ name: 'id', in: 'path', schema: { type: 'string' } }]); }],
    ['a path parameter without a template', 'parameter', d => statusParameters(d, idParameter)],
    ['a template without a path parameter', 'parameter', d => { itemOperation(d, []); }],
    ['a path parameter name that differs from the template', 'parameter', d => { itemOperation(d, [{ ...idParameter, name: 'itemId' }]); }],
    ['a string required flag', 'parameter', d => statusParameters(d, query('verbose', undefined, { required: 'yes' }))],
    ['a numeric parameter description', 'parameter', d => statusParameters(d, query('verbose', undefined, { description: 1 }))],
    ['a requestBody $ref', 'request-body', d => { postBody(d, { $ref: '#/components/requestBodies/Status' }); }],
    ['an inline JSON body', 'request-body', d => { postBody(d, jsonBody({ 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } })); }],
    ['a JSON body with a scalar schema', 'request-body', d => { postBody(d, jsonBody({ 'application/json': { schema: { type: 'string' } } })); }],
    ['a body without application/json', 'request-body', d => { postBody(d, jsonBody({ 'application/x-www-form-urlencoded': { schema: ref('DevelopmentStatus') } })); }],
    ['a body without content', 'request-body', d => { postBody(d, { required: true }); }],
    ['body content that is an array', 'request-body', d => { postBody(d, { content: [] }); }],
    ['an x- extension on a body', 'request-body', d => { postBody(d, jsonBody(undefined, { 'x-name': 'status' })); }],
    ['a string body required flag', 'request-body', d => { postBody(d, jsonBody(undefined, { required: 'yes' })); }],
    ['a numeric body description', 'request-body', d => { postBody(d, jsonBody(undefined, { description: 1 })); }],
    ['an uppercase media type', 'request-body', d => { postBody(d, jsonBody({ 'application/json': { schema: ref('DevelopmentStatus') }, 'Application/JSON': { schema: ref('DevelopmentStatus') } })); }],
    ['a media type with parameters', 'request-body', d => { postBody(d, jsonBody({ 'application/json': { schema: ref('DevelopmentStatus') }, 'application/json; charset=utf-8': { schema: ref('DevelopmentStatus') } })); }],
    ['a wildcard media type', 'request-body', d => { postBody(d, jsonBody({ 'application/json': { schema: ref('DevelopmentStatus') }, '*/*': { schema: ref('DevelopmentStatus') } })); }],
    ['a media type with example', 'request-body', d => { postBody(d, jsonBody({ 'application/json': { schema: ref('DevelopmentStatus'), example: { status: 'ok' } } })); }],
    ['a media type with encoding', 'request-body', d => { postBody(d, jsonBody({ 'application/json': { schema: ref('DevelopmentStatus') }, 'multipart/form-data': { schema: ref('DevelopmentStatus'), encoding: {} } })); }],
    ['a media type without schema', 'request-body', d => { postBody(d, jsonBody({ 'application/json': {} })); }],
    ['a media type that is not an object', 'request-body', d => { postBody(d, jsonBody({ 'application/json': 'DevelopmentStatus' })); }],
    ['missing responses', 'response', d => { delete statusOperation(d).responses; }],
    ['responses that are an array', 'response', d => { statusOperation(d).responses = []; }],
    ['an inline 200 response schema', 'response', d => { const { $id, ...schema } = structuredClone(statusModel(d)); statusOperation(d).responses['200'].content['application/json'].schema = schema; }],
    ['a default response', 'response', d => { statusOperation(d).responses.default = structuredClone(statusOperation(d).responses['500']); }],
    ['two 2xx responses', 'response', d => { statusOperation(d).responses['201'] = okResponse(); }],
    ['no 2xx response', 'response', d => { delete statusOperation(d).responses['200']; }],
    ...['600', '099', '2XX', '20'].map((status): [string, OpenApiRuleId, Mutation] => [`status ${status}`, 'response', d => { statusOperation(d).responses[status] = structuredClone(statusOperation(d).responses['500']); }]),
    ['a response $ref', 'response', d => { statusOperation(d).responses['500'] = { $ref: '#/components/responses/Error' }; }],
    ['response headers', 'response', d => { statusOperation(d).responses['200'].headers = { 'Cache-Control': { schema: { type: 'string' } } }; }],
    ['response links', 'response', d => { statusOperation(d).responses['200'].links = {}; }],
    ['an x- extension on a response', 'response', d => { statusOperation(d).responses['200']['x-cache'] = 'none'; }],
    ['an empty response description', 'response', d => { statusOperation(d).responses['500'].description = ''; }],
    ['a missing response description', 'response', d => { delete statusOperation(d).responses['200'].description; }],
    ['a 204 response with content', 'response', d => { const responses = statusOperation(d).responses; responses['204'] = responses['200']; delete responses['200']; }],
    ['a 500 response without content', 'response', d => { delete statusOperation(d).responses['500'].content; }],
    ['a 500 response with empty content', 'response', d => { statusOperation(d).responses['500'].content = {}; }],
    ['a 200 response without application/json', 'response', d => { statusOperation(d).responses['200'].content = { 'text/plain': { schema: ref('DevelopmentStatus') } }; }],
    ['a response media type with parameters', 'response', d => { statusOperation(d).responses['500'].content['text/plain; charset=utf-8'] = { schema: { type: 'string' } }; }],
    ['a response media type with examples', 'response', d => { statusOperation(d).responses['500'].content['application/json'].examples = {}; }],
    ['a 200 media type without schema', 'response', d => { delete statusOperation(d).responses['200'].content['application/json'].schema; }],
  ]),
  ...rows('OPENAPI-003', [
    ['components that are an array', 'component', d => { d.components = []; }],
    ['components parameters', 'component', d => { d.components.parameters = {}; }],
    ['components responses', 'component', d => { d.components.responses = {}; }],
    ['an x- extension on components', 'component', d => { d.components['x-owner'] = 'team'; }],
    ['component schemas that are an array', 'component', d => { d.components.schemas = []; }],
    ['security schemes that are an array', 'component', d => { d.components.securitySchemes = []; }],
    ...['developmentStatus', 'Development_Status', 'APIError', 'Item-Two', 'Status_'].map((name): [string, OpenApiRuleId, Mutation] => [`component name ${name}`, 'component', d => component(d, name, { type: 'object' })]),
    ['a component named __proto__ parsed from text', 'component', d => { d.components.schemas = JSON.parse(`{"__proto__": {"type": "object"}, "DevelopmentStatus": ${JSON.stringify(statusModel(d))}}`); }],
    ['a component root $ref', 'component', d => component(d, 'Alias', ref('DevelopmentStatus'))],
    ['a boolean component root', 'component', d => component(d, 'Flag', { type: 'boolean' })],
    ['a string component root without enum', 'component', d => component(d, 'Label', { type: 'string' })],
    ['an integer component root without enum', 'component', d => component(d, 'Count', { type: 'integer', minimum: 0 })],
    ['a component root with a type array', 'component', d => component(d, 'Maybe', { type: ['object', 'null'] })],
    ['a component root without type (t.Integer anyOf)', 'component', d => component(d, 'Count', { anyOf: [{ format: 'integer', default: 0, type: 'string' }, { type: 'integer' }] })],
    ['a component root that is not an object', 'component', d => component(d, 'Label', 'string')],
    ['a component $id for another name', 'component', d => { statusModel(d).$id = '#/components/schemas/Status'; }],
    ['a relative component $id', 'component', d => { statusModel(d).$id = 'DevelopmentStatus'; }],
    ['a numeric component $id', 'component', d => { statusModel(d).$id = 1; }],
    ['a nested $id', 'schema', d => { statusLiteral(d).$id = '#/components/schemas/Status'; }],
    ['the anyOf that t.Integer exports', 'schema', d => property(d, { anyOf: [{ format: 'integer', default: 0, type: 'string' }, { type: 'integer' }] })],
    ['nullable true', 'schema', d => property(d, { type: 'string', nullable: true })],
    ['a type array with null', 'schema', d => property(d, { type: ['string', 'null'] })],
    ['the nullable shape that t.Nullable exports', 'schema', d => property(d, { nullable: true, type: ['string', 'null'] })],
    ['additionalProperties as a schema', 'schema', d => { statusModel(d).additionalProperties = { type: 'string' }; }],
    ['a default object', 'schema', d => { statusLiteral(d).default = { status: 'ok' }; }],
    ['required constructor without an own property', 'schema', d => { statusModel(d).required = ['status', 'constructor']; }],
    ['a property named __proto__ parsed from text', 'schema', d => { statusModel(d).properties = JSON.parse(`{"__proto__": {"type": "string"}, "status": ${JSON.stringify(statusLiteral(d))}}`); }],
    ['a component schema 33 levels deep through properties', 'schema', d => component(d, 'Deep', nestedProperties(33))],
    ['a component schema 33 levels deep through items', 'schema', d => component(d, 'Deep', nestedItems(33))],
    ['a response schema 33 levels deep', 'schema', d => { statusOperation(d).responses['500'].content['application/json'].schema = nestedProperties(33); }],
    ['oneOf', 'schema', d => property(d, { type: 'string', oneOf: [{ type: 'string' }] })],
    ['allOf', 'schema', d => property(d, { type: 'object', allOf: [ref('DevelopmentStatus')] })],
    ['not', 'schema', d => property(d, { type: 'string', not: { const: 'x' } })],
    ['patternProperties', 'schema', d => property(d, { type: 'object', patternProperties: { '^x': { type: 'string' } } })],
    ['$defs', 'schema', d => property(d, { type: 'object', $defs: { Item: { type: 'string' } } })],
    ['$schema', 'schema', d => property(d, { type: 'string', $schema: 'https://json-schema.org/draft/2020-12/schema' })],
    ['multipleOf', 'schema', d => property(d, { type: 'integer', multipleOf: 2 })],
    ['exclusiveMinimum', 'schema', d => property(d, { type: 'number', exclusiveMinimum: 0 })],
    ['exclusiveMaximum', 'schema', d => property(d, { type: 'number', exclusiveMaximum: 10 })],
    ['minItems', 'schema', d => property(d, { type: 'array', items: { type: 'string' }, minItems: 1 })],
    ['maxItems', 'schema', d => property(d, { type: 'array', items: { type: 'string' }, maxItems: 5 })],
    ['uniqueItems', 'schema', d => property(d, { type: 'array', items: { type: 'string' }, uniqueItems: true })],
    ['an x- extension on a schema', 'schema', d => property(d, { type: 'string', 'x-format': 'slug' })],
    ['a nested schema without type', 'schema', d => property(d, { description: 'No type' })],
    ['type null', 'schema', d => property(d, { type: 'null' })],
    ['an unknown type', 'schema', d => property(d, { type: 'date' })],
    ['a nested schema that is a string', 'schema', d => property(d, 'string')],
    ['a nested schema that is an array', 'schema', d => property(d, [{ type: 'string' }])],
    ['a numeric title', 'schema', d => property(d, { type: 'string', title: 1 })],
    ['a numeric description', 'schema', d => property(d, { type: 'string', description: 1 })],
    ['a string deprecated flag in a schema', 'schema', d => property(d, { type: 'string', deprecated: 'yes' })],
    ['a string readOnly flag', 'schema', d => property(d, { type: 'string', readOnly: 'yes' })],
    ['a numeric writeOnly flag', 'schema', d => property(d, { type: 'string', writeOnly: 1 })],
    ['an object example', 'schema', d => property(d, { type: 'string', example: { a: 1 } })],
    ['a null example', 'schema', d => property(d, { type: 'string', example: null })],
    ['a null default', 'schema', d => property(d, { type: 'string', default: null })],
    ['an infinite default parsed from text', 'schema', d => property(d, JSON.parse('{"type": "number", "default": 1e400}'))],
    ['examples that are not an array', 'schema', d => property(d, { type: 'string', examples: 'a' })],
    ['examples with an object', 'schema', d => property(d, { type: 'string', examples: ['a', {}] })],
    ['an empty format', 'schema', d => property(d, { type: 'string', format: '' })],
    ['a format on an integer', 'schema', d => property(d, { type: 'integer', format: 'int64' })],
    ['a pattern that does not compile', 'schema', d => property(d, { type: 'string', pattern: '(' })],
    ['a numeric pattern', 'schema', d => property(d, { type: 'string', pattern: 1 })],
    ['a negative minLength', 'schema', d => property(d, { type: 'string', minLength: -1 })],
    ['a fractional maxLength', 'schema', d => property(d, { type: 'string', maxLength: 1.5 })],
    ['minLength above maxLength', 'schema', d => property(d, { type: 'string', minLength: 5, maxLength: 2 })],
    ['a minLength on an integer', 'schema', d => property(d, { type: 'integer', minLength: 1 })],
    ['a string minimum', 'schema', d => property(d, { type: 'number', minimum: '1' })],
    ['minimum above maximum', 'schema', d => property(d, { type: 'integer', minimum: 5, maximum: 1 })],
    ['a minimum on a string', 'schema', d => property(d, { type: 'string', minimum: 1 })],
    ['properties that are an array', 'schema', d => property(d, { type: 'object', properties: [] })],
    ['an empty property name', 'schema', d => property(d, { type: 'object', properties: { '': { type: 'string' } } })],
    ['a blank property name', 'schema', d => property(d, { type: 'object', properties: { ' ': { type: 'string' } } })],
    ['a property schema that is a string', 'schema', d => property(d, { type: 'object', properties: { name: 'string' } })],
    ['required that is not an array', 'schema', d => property(d, { type: 'object', properties: { a: { type: 'string' } }, required: 'a' })],
    ['a duplicate required name', 'schema', d => property(d, { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] })],
    ['a required name without a property', 'schema', d => property(d, { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] })],
    ['a required name without any properties', 'schema', d => property(d, { type: 'object', required: ['a'] })],
    ['a string additionalProperties', 'schema', d => property(d, { type: 'object', additionalProperties: 'false' })],
    ['properties on a string', 'schema', d => property(d, { type: 'string', properties: {} })],
    ['an array without items', 'schema', d => property(d, { type: 'array' })],
    ['array items that are a string', 'schema', d => property(d, { type: 'array', items: 'string' })],
    ['tuple items', 'schema', d => property(d, { type: 'array', items: [{ type: 'string' }] })],
    ['items on an object', 'schema', d => property(d, { type: 'object', items: { type: 'string' } })],
    ['an enum on a boolean', 'schema', d => property(d, { type: 'boolean', enum: [true] })],
    ['a const on a boolean', 'schema', d => property(d, { type: 'boolean', const: true })],
    ['an enum on an object', 'schema', d => property(d, { type: 'object', enum: [{}] })],
    ['an empty enum', 'schema', d => property(d, { type: 'string', enum: [] })],
    ['an enum that is not an array', 'schema', d => property(d, { type: 'string', enum: 'ok' })],
    ['a duplicate enum value', 'schema', d => property(d, { type: 'string', enum: ['a', 'a'] })],
    ['a number in a string enum', 'schema', d => property(d, { type: 'string', enum: ['a', 1] })],
    ['a fractional integer enum value', 'schema', d => property(d, { type: 'integer', enum: [1, 1.5] })],
    ['a fractional integer const', 'schema', d => property(d, { type: 'integer', const: 1.5 })],
    ['a string const on a number', 'schema', d => property(d, { type: 'number', const: '1' })],
    ['an enum with more values than const', 'schema', d => { statusLiteral(d).enum = ['ok', 'ready']; }],
    ['an enum value other than const', 'schema', d => { statusLiteral(d).enum = ['ready']; }],
    ['a parameter schema keyword outside its type', 'schema', d => statusParameters(d, query('verbose', { type: 'string', minimum: 1 }))],
    ['a parameter schema with nullable', 'schema', d => statusParameters(d, query('label', { type: 'string', nullable: true }))],
    ['a form body schema with anyOf', 'schema', d => { postBody(d, jsonBody({ 'application/json': { schema: ref('DevelopmentStatus') }, 'multipart/form-data': { schema: { type: 'object', anyOf: [] } } })); }],
    ['a media schema that is not an object', 'schema', d => { statusOperation(d).responses['500'].content['text/plain'] = { schema: 'string' }; }],
    ...([
      ['an external https reference', 'https://schemas.example.invalid/status.json'],
      ['a file reference', 'file:///tmp/status.json'],
      ['a relative reference', './x.json'],
      ['a bare name as t.Ref exports it', 'DevelopmentStatus'],
      ['a reference to the securitySchemes section', '#/components/securitySchemes/Bearer'],
      ['a reference into paths', '#/paths/~1api~1status'],
      ['a reference to a missing component', '#/components/schemas/Missing'],
      ['a reference with an empty name', '#/components/schemas/'],
      ['a reference into a component', '#/components/schemas/DevelopmentStatus/properties/status'],
      ['a reference with an escaped pointer', '#/components/schemas/Development~1Status'],
      ['a reference to the inherited name constructor', '#/components/schemas/constructor'],
      ['a reference without the hash', '/components/schemas/DevelopmentStatus'],
    ] as const).map(([name, target]): [string, OpenApiRuleId, Mutation] => [name, 'reference', d => {
      scheme(d, 'Bearer', bearer);
      okSchema(d).$ref = target;
    }]),
    ['a numeric $ref', 'reference', d => { okSchema(d).$ref = 1; }],
    ['a $ref with a sibling description', 'reference', d => { okSchema(d).description = 'Status'; }],
    ['a $ref with a sibling in a property', 'reference', d => property(d, { ...ref('DevelopmentStatus'), type: 'object' })],
    ['a direct cycle through a property', 'reference', d => component(d, 'Node', { type: 'object', properties: { next: ref('Node') } })],
    ['a direct cycle through items', 'reference', d => component(d, 'List', { type: 'array', items: ref('List') })],
    ['an indirect cycle', 'reference', d => {
      component(d, 'Parent', { type: 'object', properties: { child: ref('Child') } });
      component(d, 'Child', { type: 'object', properties: { parent: ref('Parent') } });
    }],
    ['an indirect cycle over three components through items', 'reference', d => {
      component(d, 'First', { type: 'object', properties: { second: ref('Second') } });
      component(d, 'Second', { type: 'array', items: ref('Third') });
      component(d, 'Third', { type: 'object', properties: { first: { type: 'array', items: ref('First') } } });
    }],
    ['a cycle back to the status model', 'reference', d => {
      component(d, 'Wrapper', { type: 'object', properties: { status: ref('DevelopmentStatus') } });
      statusModel(d).properties.wrapper = ref('Wrapper');
    }],
    ['a missing reference in a request body', 'reference', d => { postBody(d, jsonBody({ 'application/json': { schema: ref('Missing') } })); }],
    ['a missing reference in an inline response property', 'reference', d => property(d, ref('Missing'))],
    ['a bare name in array items as t.Array(t.Ref(...)) exports it', 'reference', d => property(d, { type: 'array', items: { $ref: 'DevelopmentStatus' } })],
    ['a document root $ref, which is not a schema position', 'document', d => { d.$ref = '#/components/schemas/DevelopmentStatus'; }],
    ['an operation $ref, which is not a schema position', 'operation', d => { statusOperation(d).$ref = '#/paths/~1api~1other/get'; }],
  ]),
  ...rows('OPENAPI-004', [
    ['an operation without security and no document security', 'security', d => { delete statusOperation(d).security; delete d.security; }],
    // Document security is never inherited, so a protected route that forgot detail.security cannot pass as public.
    ['an operation that would inherit document security []', 'security', d => { delete addOperation(d, '/api/other', 'get', 'getOther').security; }],
    ['an operation that would inherit a declared document requirement', 'security', d => {
      scheme(d, 'Bearer', bearer);
      d.security = [{ Bearer: [] }];
      delete addOperation(d, '/api/other', 'get', 'getOther').security;
    }],
    ['an empty requirement object on an operation', 'security', d => { otherOperation(d, [{}]); }],
    ['an empty requirement object in the document', 'security', d => { d.security = [{}]; }],
    ['an undeclared scheme', 'security', d => { otherOperation(d, [{ Bearer: [] }]); }],
    ['the inherited name constructor parsed from text', 'security', d => { d.components.securitySchemes = {}; otherOperation(d, JSON.parse('[{"constructor": []}]')); }],
    ['the inherited name constructor without security schemes', 'security', d => { otherOperation(d, JSON.parse('[{"constructor": []}]')); }],
    ['a requirement named __proto__ parsed from text', 'security', d => { scheme(d, 'Bearer', bearer); otherOperation(d, JSON.parse('[{"__proto__": []}]')); }],
    ['an http requirement with scopes', 'security', d => { scheme(d, 'Bearer', bearer); otherOperation(d, [{ Bearer: ['read'] }]); }],
    ['an apiKey requirement with scopes', 'security', d => { scheme(d, 'ApiKey', { type: 'apiKey', name: 'X-Api-Key', in: 'header' }); otherOperation(d, [{ ApiKey: ['admin'] }]); }],
    ['a requirement value that is not an array', 'security', d => { scheme(d, 'Bearer', bearer); otherOperation(d, [{ Bearer: '' }]); }],
    ['a requirement that is not an object', 'security', d => { scheme(d, 'Bearer', bearer); otherOperation(d, ['Bearer']); }],
    ['an oauth2 scheme', 'security', d => scheme(d, 'OAuth', { type: 'oauth2', flows: {} })],
    ['an openIdConnect scheme', 'security', d => scheme(d, 'Oidc', { type: 'openIdConnect', openIdConnectUrl: 'https://id.example.invalid/.well-known/openid-configuration' })],
    ['a mutualTLS scheme', 'security', d => scheme(d, 'Mtls', { type: 'mutualTLS' })],
    ['an invalid document requirement while every operation overrides it', 'security', d => { d.security = [{ Missing: [] }]; }],
    ['document security that is not an array', 'security', d => { d.security = {}; }],
    ['operation security that is an object', 'security', d => { otherOperation(d, {}); }],
    ['a security scheme $ref', 'security', d => scheme(d, 'Bearer', { $ref: '#/components/securitySchemes/Other' })],
    ['an http scheme without scheme', 'security', d => scheme(d, 'Bearer', { type: 'http' })],
    ['an http scheme with a blank scheme', 'security', d => scheme(d, 'Bearer', { type: 'http', scheme: ' ' })],
    ['an http scheme with in', 'security', d => scheme(d, 'Bearer', { type: 'http', scheme: 'bearer', in: 'header' })],
    ['a numeric bearerFormat', 'security', d => scheme(d, 'Bearer', { type: 'http', scheme: 'bearer', bearerFormat: 1 })],
    ['an apiKey scheme without name', 'security', d => scheme(d, 'ApiKey', { type: 'apiKey', in: 'header' })],
    ['an apiKey scheme in path', 'security', d => scheme(d, 'ApiKey', { type: 'apiKey', name: 'key', in: 'path' })],
    ['an apiKey scheme with scheme', 'security', d => scheme(d, 'ApiKey', { type: 'apiKey', name: 'key', in: 'header', scheme: 'bearer' })],
    ['a security scheme that is not an object', 'security', d => scheme(d, 'Bearer', 'bearer')],
    ['a security scheme without type', 'security', d => scheme(d, 'Bearer', { scheme: 'bearer' })],
    ['GET /api/status removed while another valid operation stays', 'required-operation', d => { addOperation(d, '/api/other', 'get', 'getOther'); delete d.paths['/api/status']; }],
    ['another valid operationId on the status operation', 'required-operation', d => { statusOperation(d).operationId = 'getStatus'; }],
    ['another declared tag on the status operation', 'required-operation', d => { d.tags.push({ name: 'diagnostics' }); statusOperation(d).tags = ['diagnostics']; }],
    ['const and enum replaced together with bad', 'required-operation', d => { statusLiteral(d).const = 'bad'; statusLiteral(d).enum = ['bad']; }],
    ['an extra status property', 'required-operation', d => { statusModel(d).properties.extra = { type: 'string' }; }],
    ['a status operation that requires a declared http bearer scheme', 'required-operation', d => { scheme(d, 'Bearer', bearer); statusOperation(d).security = [{ Bearer: [] }]; }],
    ['a status operation that only inherits document security', 'security', d => { delete statusOperation(d).security; }],
    ['additionalProperties true on the status model', 'required-operation', d => { statusModel(d).additionalProperties = true; }],
    ['a status model without additionalProperties', 'required-operation', d => { delete statusModel(d).additionalProperties; }],
    ['an empty required list on the status model', 'required-operation', d => { statusModel(d).required = []; }],
    ['a status literal through a reference', 'required-operation', d => { component(d, 'StatusValue', { type: 'string', enum: ['ok'] }); statusModel(d).properties.status = ref('StatusValue'); }],
    ['a status literal that is an integer', 'required-operation', d => { statusModel(d).properties.status = { type: 'integer', enum: [1] }; }],
    ['a status literal without const or enum', 'required-operation', d => { delete statusLiteral(d).const; delete statusLiteral(d).enum; }],
    ['a 200 response that references another valid component', 'required-operation', d => {
      component(d, 'Status', { ...structuredClone(statusModel(d)), $id: '#/components/schemas/Status' });
      okSchema(d).$ref = '#/components/schemas/Status';
    }],
    ['a 201 success response instead of 200', 'required-operation', d => { const responses = statusOperation(d).responses; responses['201'] = responses['200']; delete responses['200']; }],
    ['the status operation moved to post', 'required-operation', d => { statusItem(d).post = statusOperation(d); delete statusItem(d).get; }],
  ]),
];

for (const [scenario, name, rule, mutate] of matrix) {
  test(`${scenario} checker rejects ${name} with rule ${rule}`, () => {
    let document: unknown = fresh();
    const replaced = mutate(document);
    if (replaced instanceof Replace) document = replaced.document;
    const copy = structuredClone(document);
    expect(ruleOf(document)).toBe(rule);
    expect(unchanged(document, copy)).toBe(true);
  });
}

const accepted: [Scenario, string, Mutation][] = [
  ['OPENAPI-002', 'the stored openapi.json', () => new Replace(JSON.parse(storedText))],
  ['OPENAPI-002', 'tests/fixtures/openapi/valid.json', () => undefined],
  ['OPENAPI-002', 'path, query, and header parameters, JSON and form bodies, a 204 response, and path item text', d => {
    statusItem(d).summary = 'Status';
    statusItem(d).description = 'Status endpoints';
    itemOperation(d, [idParameter, query('verbose', { type: 'boolean' }), query('mode', { type: 'string', enum: ['short', 'long'] }),
      { name: 'X-Request-Id', in: 'header', required: false, description: 'Trace id', schema: { type: 'string', format: 'uuid' } }]);
    addOperation(d, '/api/items/{id}', 'put', 'putItem', {
      parameters: [idParameter], summary: 'Replace', description: 'Replace an item', deprecated: true,
      requestBody: jsonBody({ 'application/json': { schema: ref('DevelopmentStatus') }, 'application/x-www-form-urlencoded': { schema: ref('DevelopmentStatus') }, 'multipart/form-data': { schema: ref('DevelopmentStatus') } }, { description: 'Item' }),
    });
    addOperation(d, '/api/items/{id}', 'delete', 'deleteItem', {
      parameters: [idParameter],
      responses: { '204': { description: 'Deleted' }, '404': { description: 'Missing', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } } },
    });
    addOperation(d, '/api/items', 'post', 'postItem', { requestBody: { content: { 'application/json': { schema: ref('DevelopmentStatus') } } } });
  }],
  ['OPENAPI-002', 'path segments that contain dots without being dot segments', d => { addOperation(d, '/api/.well-known/v1.2/..status', 'get', 'getWellKnown'); }],
  ['OPENAPI-003', 'a component schema 32 levels deep through properties', d => component(d, 'Deep', nestedProperties(32))],
  ['OPENAPI-003', 'a component schema 32 levels deep through items', d => component(d, 'Deep', nestedItems(32))],
  ['OPENAPI-003', 'a response schema 32 levels deep', d => { statusOperation(d).responses['500'].content['application/json'].schema = nestedProperties(32); }],
  ['OPENAPI-003', 'references that share targets without a cycle', d => {
    component(d, 'Top', { type: 'object', properties: { left: ref('Left'), right: ref('Right') } });
    component(d, 'Left', { type: 'object', properties: { leaf: ref('Leaf') } });
    component(d, 'Right', { type: 'array', items: ref('Leaf') });
    component(d, 'Leaf', { type: 'string', enum: ['a', 'b'] });
    property(d, ref('Top'));
  }],
  ['OPENAPI-003', 'every keyword and component root type the rules allow', d => {
    component(d, 'Everything', {
      $id: '#/components/schemas/Everything', type: 'object', title: 'Everything', description: 'All keywords', example: 1, examples: ['a', 1, true],
      deprecated: false, readOnly: false, writeOnly: false, additionalProperties: false, required: ['text', 'count'],
      properties: {
        text: { type: 'string', format: 'email', pattern: '^[a-z]+$', minLength: 1, maxLength: 20, enum: ['a', 'b'], default: 'a' },
        literal: { type: 'string', const: 'ok', enum: ['ok'] },
        count: { type: 'integer', minimum: 0, maximum: 10, enum: [1, 2] },
        ratio: { type: 'number', minimum: 0.5, maximum: 1.5, const: 1 },
        flag: { type: 'boolean', default: true },
        list: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { status: ref('DevelopmentStatus') } },
        constructor: { type: 'string' },
      },
    });
    component(d, 'Mode', { type: 'string', enum: ['short', 'long'] });
    component(d, 'Level', { type: 'integer', enum: [1, 2] });
    component(d, 'Ratio', { type: 'number', enum: [0.5] });
    component(d, 'Names', { type: 'array', items: { type: 'string' } });
  }],
  ['OPENAPI-004', 'http bearer and apiKey schemes in header, query, and cookie, with document security that every operation overrides', d => {
    scheme(d, 'Bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token' });
    scheme(d, 'HeaderKey', { type: 'apiKey', name: 'X-Api-Key', in: 'header' });
    scheme(d, 'QueryKey', { type: 'apiKey', name: 'key', in: 'query' });
    scheme(d, 'Session', { type: 'apiKey', name: 'session', in: 'cookie', description: 'Session cookie' });
    otherOperation(d, [{ Bearer: [] }, { HeaderKey: [], QueryKey: [] }]);
    d.security = [{ Session: [] }];
    addOperation(d, '/api/session', 'get', 'getSession', { security: [{ Session: [] }] });
  }],
  ['OPENAPI-004', 'operations without document security when each declares its own', d => { delete d.security; }],
  ['OPENAPI-004', 'a status literal with const only', d => { delete statusLiteral(d).enum; }],
  ['OPENAPI-004', 'a status literal with enum only', d => { delete statusLiteral(d).const; }],
];

for (const [scenario, name, mutate] of accepted) {
  test(`${scenario} checker accepts ${name}`, () => {
    let document: unknown = fresh();
    const replaced = mutate(document);
    if (replaced instanceof Replace) document = replaced.document;
    const copy = structuredClone(document);
    expect(ruleOf(document)).toBe('accepted');
    expect(unchanged(document, copy)).toBe(true);
  });
}

test('OPENAPI-003 a 200000 level items chain under 8 MiB is rejected with rule schema, not RangeError, by the module and the CLI', async () => {
  const levels = 200_000;
  const d = fresh();
  d.components.schemas.Deep = '__DEEP__';
  const text = JSON.stringify(d).replace('"__DEEP__"', '{"type":"array","items":'.repeat(levels - 1) + '{"type":"string"}' + '}'.repeat(levels - 1));
  expect(Buffer.byteLength(text)).toBeLessThan(OPENAPI_MAX_BYTES);
  expect(ruleOf(JSON.parse(text))).toBe('schema');
  const path = join(files, 'deep-items.json');
  await Bun.write(path, text);
  const result = await validate(path);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe('OpenAPI validation failed\nrule: schema\n');
}, 15_000);

/** Two components per level; each refers to both components of the next level, so naive expansion visits 2^levels paths. */
function lattice(levels: number, backReference: boolean) {
  const d = fresh();
  const name = (level: number, side: string) => `Level${level}${side}`;
  for (let level = 0; level < levels; level++) {
    for (const side of ['Left', 'Right']) {
      const next = level + 1 < levels ? { left: ref(name(level + 1, 'Left')), right: ref(name(level + 1, 'Right')) } : {};
      component(d, name(level, side), { type: 'object', properties: next });
    }
  }
  property(d, ref(name(0, 'Left')));
  if (backReference) d.components.schemas[name(levels - 1, 'Right')].properties.back = ref(name(0, 'Left'));
  return d;
}

/**
 * Runs the checker module on a document in a child process that is killed after 10 seconds, and returns the rule
 * and the time validateOpenApi took. A regression to exponential or recursive checking then fails the test
 * instead of blocking the test process, because bun:test cannot interrupt synchronous code.
 */
async function timedCheck(name: string, document: unknown): Promise<{ rule: string; ms: number }> {
  const input = join(files, `${name}.json`);
  const script = join(files, 'timed-check.ts');
  await Bun.write(input, JSON.stringify(document));
  await Bun.write(script, `import { OpenApiContractError, validateOpenApi } from ${JSON.stringify(join(root, 'scripts/validate-openapi.ts'))};
const document = JSON.parse(await Bun.file(process.argv[2]!).text());
const started = performance.now();
let rule = 'accepted';
try {
  validateOpenApi(document);
} catch (error) {
  rule = error instanceof OpenApiContractError ? error.rule : 'unexpected ' + (error as Error).name;
}
console.log(JSON.stringify({ rule, ms: performance.now() - started }));
`);
  const result = await runBun(root, [script, input]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

test('OPENAPI-003 a 40 level lattice with fan out 2 is accepted in under one second', async () => {
  const { rule, ms } = await timedCheck('lattice', lattice(40, false));
  expect(rule).toBe('accepted');
  expect(ms).toBeLessThan(1_000);
}, 15_000);

test('OPENAPI-003 the same lattice with one back reference is rejected with rule reference in under one second', async () => {
  const { rule, ms } = await timedCheck('lattice-back', lattice(40, true));
  expect(rule).toBe('reference');
  expect(ms).toBeLessThan(1_000);
}, 15_000);

test('OPENAPI-003 a chain of 20000 components is accepted without RangeError', async () => {
  const d = fresh();
  const count = 20_000;
  for (let i = 0; i < count; i++) component(d, `Chain${i}`, { type: 'object', properties: i + 1 < count ? { next: ref(`Chain${i + 1}`) } : {} });
  property(d, ref('Chain0'));
  expect((await timedCheck('chain', d)).rule).toBe('accepted');
}, 15_000);

// Real exports of Elysia 1.4.30 with @elysia/openapi 1.4.16: a probe route and model are added in process to
// createApp('development') and read through app.handle(), without a listener.
async function exportWithProbe(model: ReturnType<typeof t.Object>): Promise<any> {
  // createApp returns a union of the production and development compositions; the development one is used here.
  const app = (createApp('development') as unknown as Elysia)
    .model({ Item: t.Object({ name: t.String() }), Probe: model })
    .get('/api/probe', () => ({}) as never, { response: { 200: 'Probe' }, detail: { operationId: 'getProbe', tags: ['development'], security: [] } });
  return (await app.handle(new Request('http://localhost/openapi/json'))).json();
}

test('OPENAPI-003 a clean model added in process to createApp is accepted, as the control for the Elysia exports below', async () => {
  expect(ruleOf(await exportWithProbe(t.Object({ name: t.String() }, { additionalProperties: false })))).toBe('accepted');
});

const elysiaExports: [string, OpenApiRuleId, () => ReturnType<typeof t.Object>, (probe: any) => boolean][] = [
  ['t.Integer', 'schema', () => t.Object({ count: t.Integer() }), probe => Array.isArray(probe.properties.count.anyOf)],
  ['t.Nullable', 'schema', () => t.Object({ label: t.Nullable(t.String()) }), probe => probe.properties.label.nullable === true && Array.isArray(probe.properties.label.type)],
  ['t.Ref inside a model', 'reference', () => t.Object({ item: t.Ref('Item') }), probe => probe.properties.item.$ref === 'Item'],
  ['t.Array(t.Ref(...))', 'reference', () => t.Object({ items: t.Array(t.Ref('Item')) }), probe => probe.properties.items.items.$ref === 'Item'],
];
for (const [name, rule, model, exported] of elysiaExports) {
  test(`OPENAPI-003 checker rejects the real Elysia export of ${name} with rule ${rule}`, async () => {
    const document = await exportWithProbe(model());
    expect(exported(document.components.schemas.Probe)).toBe(true);
    const copy = structuredClone(document);
    expect(ruleOf(document)).toBe(rule);
    expect(unchanged(document, copy)).toBe(true);
  });
}

test('OPENAPI-004 REQUIRED_OPERATIONS holds exactly the entries of the required operation table', () => {
  // Spec 0006 adds the readiness entry, spec 0012 the two health entries, and spec 0014 the three auth entries;
  // READY-003, DEP-003, and AUTH-011 check those six.
  expect(REQUIRED_OPERATIONS.length).toBe(7);
  const { checkComponent, ...entry } = REQUIRED_OPERATIONS[0]!;
  expect(entry).toEqual({
    path: '/api/status', method: 'get', operationId: 'getDevelopmentStatus', tag: 'development',
    security: [], successStatus: '200', component: 'DevelopmentStatus',
  });
  expect(Object.isFrozen(REQUIRED_OPERATIONS) && REQUIRED_OPERATIONS.every(operation => Object.isFrozen(operation))).toBe(true);
  const model = statusModel(fresh());
  const copy = structuredClone(model);
  expect(checkComponent(model)).toBe(true);
  expect(unchanged(model, copy)).toBe(true);
  for (const drop of ['const', 'enum']) {
    const literal = structuredClone(model);
    delete literal.properties.status[drop];
    expect(checkComponent(literal)).toBe(true);
  }
  const neither = structuredClone(model);
  delete neither.properties.status.const;
  delete neither.properties.status.enum;
  expect(checkComponent(neither)).toBe(false);
});

test('OPENAPI-004 GET /api/status without credentials answers 200 with {"status":"ok"} through app.handle()', async () => {
  const response = await createApp('development').handle(new Request('http://localhost/api/status'));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"status":"ok"}');
});

test('OPENAPI-002 a document with several violations reports the topmost rule in table order, whatever its key order', () => {
  const broken = () => {
    const d = fresh();
    d.openapi = '3.0.3';
    statusOperation(d).tags = ['undeclared'];
    property(d, { type: 'string', nullable: true });
    scheme(d, 'OAuth', { type: 'oauth2', flows: {} });
    statusLiteral(d).const = 'bad';
    statusLiteral(d).enum = ['bad'];
    return d;
  };
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reversed);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reversed((value as Record<string, unknown>)[key])]));
  };
  const expected: [OpenApiRuleId, (d: any) => void][] = [
    ['version', () => undefined],
    ['tag', d => { d.openapi = '3.1.0'; }],
    ['schema', d => { statusOperation(d).tags = ['development']; }],
    ['security', d => { delete failureSchema(d).properties.detail; }],
    // Only the OAuth scheme goes: the sessionCookie scheme of the auth operations (spec 0014) stays declared.
    ['required-operation', d => { delete d.components.securitySchemes.OAuth; }],
  ];
  const d = broken();
  for (const [rule, repair] of expected) {
    repair(d);
    expect(ruleOf(d)).toBe(rule);
    expect(ruleOf(reversed(d))).toBe(rule);
  }
  statusLiteral(d).const = 'ok';
  statusLiteral(d).enum = ['ok'];
  expect(ruleOf(d)).toBe('accepted');
});

test('OPENAPI-002 the accepted methods are exactly HTTP_METHODS of the installed SDK generator', async () => {
  // Value sourcing: the method list comes from @ojiepermana/angular 22.1.14 (sdk/src/parser/ir.js). A generator
  // upgrade that changes the list fails here, before a method the SDK silently drops can pass the checker.
  const ir = await Bun.file(join(root, 'node_modules/@ojiepermana/angular/sdk/src/parser/ir.js')).text();
  const block = /const HTTP_METHODS = \[([^\]]*)\]/.exec(ir);
  expect(block).not.toBeNull();
  const generator = [...block![1]!.matchAll(/'([a-z]+)'/g)].map(match => match[1]!);
  expect(generator).toEqual(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  for (const method of generator) {
    const d = fresh();
    addOperation(d, '/api/other', method, 'otherOperation');
    expect(ruleOf(d), method).toBe('accepted');
  }
  // trace is an OpenAPI 3.1 path item method that the generator never reads.
  const d = fresh();
  addOperation(d, '/api/other', 'trace', 'traceOther');
  expect(ruleOf(d)).toBe('method');
});

// Build plan step 4: OPENAPI-006 (AC-7). tests/fixtures/openapi/subset-full.json holds every shape AC-7 lists. The claim
// that a shape the checker accepts is readable by the SDK generator only covers these shapes.
const subsetPath = join(root, 'tests/fixtures/openapi/subset-full.json');
const subsetText = await Bun.file(subsetPath).text();
/** Every keyword the `schema` rule accepts, plus `$id` at a component root. */
const schemaKeywords = ['$id', 'type', 'title', 'description', 'default', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

/** Keys used anywhere in one schema tree, down through `properties` and `items`, without following references. */
function treeKeys(schema: any, found = new Set<string>()): Set<string> {
  for (const key of Object.keys(schema)) found.add(key);
  for (const child of [...Object.values(schema.properties ?? {}), ...(schema.items ? [schema.items] : [])]) treeKeys(child, found);
  return found;
}

test('OPENAPI-006 checker accepts subset-full.json through the module and the CLI', async () => {
  const document = JSON.parse(subsetText);
  const copy = structuredClone(document);
  expect(ruleOf(document)).toBe('accepted');
  expect(unchanged(document, copy)).toBe(true);
  const result = await validate(subsetPath);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('OpenAPI project checks passed\n');
  expect(result.stderr).toBe('');
}, 15_000);

test('OPENAPI-006 subset-full.json holds the required status operation and every shape AC-7 lists', () => {
  const d = JSON.parse(subsetText);
  const stored = JSON.parse(storedText);
  expect(d.paths['/api/status']).toStrictEqual(stored.paths['/api/status']);
  expect(d.components.schemas.DevelopmentStatus).toStrictEqual(stored.components.schemas.DevelopmentStatus);
  // Spec 0012: the two required health operations and their models come from the stored contract as well.
  for (const path of ['/health/live', '/health/ready']) expect(d.paths[path]).toStrictEqual(stored.paths[path]);
  for (const name of ['HealthLive', 'HealthReady', 'HealthUnavailable']) expect(d.components.schemas[name]).toStrictEqual(stored.components.schemas[name]);
  // Spec 0014: the three required auth operations, their models, and the sessionCookie scheme come from it too.
  expect(d.paths['/api/auth/session']).toStrictEqual({ post: stored.paths['/api/auth/session'].post, get: stored.paths['/api/auth/session'].get });
  expect(d.paths['/api/auth/sessions']).toStrictEqual(stored.paths['/api/auth/sessions']);
  for (const name of ['AuthError', 'AuthSession', 'AuthSessionList', 'SignInRequest']) expect(d.components.schemas[name]).toStrictEqual(stored.components.schemas[name]);
  expect(d.components.securitySchemes.sessionCookie).toStrictEqual(stored.components.securitySchemes.sessionCookie);
  const operations: any[] = Object.values(d.paths).flatMap((item: any) => Object.values(item));
  expect(Object.values(d.paths).flatMap((item: any) => Object.keys(item)).sort()).toEqual([
    'delete', 'get', 'get', 'get', 'get', 'get', 'get', 'get', 'get', 'get', 'head', 'options', 'patch', 'post', 'post', 'put',
  ]);
  expect(operations.some(operation => operation.deprecated === true)).toBe(true);

  const parameters: any[] = operations.flatMap(operation => operation.parameters ?? []);
  for (const location of ['path', 'query', 'header']) {
    for (const type of ['string', 'integer', 'number', 'boolean']) {
      expect(parameters.some(parameter => parameter.in === location && parameter.schema.type === type), `${location} ${type}`).toBe(true);
    }
  }
  expect(parameters.some(parameter => parameter.in === 'query' && parameter.schema.type === 'string' && Array.isArray(parameter.schema.enum))).toBe(true);
  expect(parameters.some(parameter => parameter.in === 'header' && parameter.name.includes('-'))).toBe(true);

  const jsonReference = (content: any) => typeof content?.['application/json']?.schema?.$ref === 'string';
  const bodies: any[] = operations.flatMap(operation => operation.requestBody ? [operation.requestBody] : []);
  expect(bodies.some(body => body.required === true && jsonReference(body.content))).toBe(true);
  expect(bodies.some(body => !Object.hasOwn(body, 'required') && jsonReference(body.content))).toBe(true);
  expect(bodies.some(body => ['application/x-www-form-urlencoded', 'multipart/form-data'].every(type => Object.hasOwn(body.content, type)))).toBe(true);

  const responses: [string, any][] = operations.flatMap(operation => Object.entries(operation.responses));
  expect(responses.some(([status, response]) => status === '200' && jsonReference(response.content))).toBe(true);
  expect(responses.some(([status, response]) => status === '204' && Object.keys(response).join() === 'description')).toBe(true);
  expect(responses.some(([status, response]) => status.startsWith('4') && response.content?.['application/json']?.schema?.type === 'object')).toBe(true);

  const schemas: any[] = Object.values(d.components.schemas);
  expect(schemas.some(schema => schema.type === 'object' && schemaKeywords.every(keyword => treeKeys(schema).has(keyword)))).toBe(true);
  expect(schemas.some(schema => schema.type === 'array')).toBe(true);
  for (const type of ['string', 'integer', 'number']) expect(schemas.some(schema => schema.type === type && Array.isArray(schema.enum)), type).toBe(true);
  expect(schemas.some(schema => treeKeys(schema).has('const'))).toBe(true);
  const children = (schema: any): any[] => [...Object.values(schema.properties ?? {}), ...(schema.items ? [schema.items] : [])];
  expect(schemas.some(schema => Object.values(schema.properties ?? {}).some((property: any) => Object.hasOwn(property, '$ref')))).toBe(true);
  expect(schemas.some(schema => [schema, ...children(schema)].some(node => node.items && Object.hasOwn(node.items, '$ref')))).toBe(true);

  const schemes: any[] = Object.values(d.components.securitySchemes);
  expect(schemes.some(scheme => scheme.type === 'http' && scheme.scheme === 'bearer')).toBe(true);
  for (const location of ['header', 'query', 'cookie']) expect(schemes.some(scheme => scheme.type === 'apiKey' && scheme.in === location), location).toBe(true);
});

/** Consumer file for tsc: it uses body, parameter, and response types, and marks every wrong value with @ts-expect-error. */
const consumer = `
import type { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import {
  checkCatalogItem, createCatalogItem, deleteCatalogItem, getCatalogItemView, getDevelopmentStatus, listCatalogItems,
  listLegacyCatalogItems, optionsCatalogItems, replaceCatalogItem, updateCatalogItem,
  type CatalogItem, type CatalogItemInput, type CatalogItemList, type CatalogItemPatch, type CatalogItemsService,
  type CreateCatalogItem$Params, type DevelopmentService, type DevelopmentStatus, type GetCatalogItemView$Params,
  type ItemKind, type ItemPriority, type ItemWeightClass, type ListCatalogItems$Params, type ReplaceCatalogItem$Params,
  type StrictHttpResponse, type UpdateCatalogItem$Params,
} from './apps/frontend/sdk/public-api';

// Exact type equality: a loose generated type (unknown, any, or a wider union) makes the tuple below fail.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type ResponseOf<F> = F extends (...args: never[]) => Observable<StrictHttpResponse<infer R>> ? R : never;
declare const http: HttpClient;
declare const catalog: CatalogItemsService;
declare const development: DevelopmentService;

// Models: object, array, and enum components, const, and $ref nested in properties and items.
const item: CatalogItem = {
  id: '6f1c2d3e-0000-4000-8000-000000000001', name: 'Desk lamp', kind: 'tool', priority: 3, priorityLevel: 2, weight: 2.5,
  weightClass: 0.5, active: true, currency: 'IDR', ratio: 0.5, status: 'draft', labels: ['desk'], related: ['part'],
};
export const models: [
  Equal<CatalogItem['kind'], ItemKind>, Equal<ItemKind, 'tool' | 'part'>, Equal<ItemPriority, 1 | 2 | 3>,
  Equal<ItemWeightClass, 0.5 | 1 | 2.5>, Equal<CatalogItem['currency'], 'IDR'>, Equal<CatalogItem['related'], ItemKind[]>,
  Equal<CatalogItem['labels'], string[]>, Equal<CatalogItem['status'], 'draft' | 'published' | undefined>,
  Equal<CatalogItem['priorityLevel'], ItemPriority | undefined>, Equal<CatalogItemList, CatalogItem[]>,
] = [true, true, true, true, true, true, true, true, true, true];
// @ts-expect-error A string enum component rejects other values.
export const wrongKind: CatalogItem = { ...item, kind: 'other' };
// @ts-expect-error An integer enum component rejects other values.
export const wrongPriority: ItemPriority = 4;
// @ts-expect-error A number enum component rejects other values.
export const wrongWeightClass: ItemWeightClass = 3;
// @ts-expect-error A const literal rejects other values.
export const wrongCurrency: CatalogItem = { ...item, currency: 'USD' };
// @ts-expect-error Array items keep the referenced enum.
export const wrongRelated: CatalogItem = { ...item, related: ['other'] };
// @ts-expect-error Required properties stay required.
export const missingName: CatalogItem = { id: 'item-1', kind: 'tool', priority: 1, weight: 1, active: true, currency: 'IDR', labels: [], related: [] };
// @ts-expect-error The status literal rejects other values.
export const wrongStatus: DevelopmentStatus = { status: 'unexpected' };

// Bodies: a JSON $ref body with required true and one without required.
const input: CatalogItemInput = { name: 'Desk lamp', kind: 'tool', weight: 2.5, labels: ['desk'] };
const patch: CatalogItemPatch = { active: false, priorityLevel: 1 };
export const bodies: [
  Equal<CreateCatalogItem$Params['body'], CatalogItemInput>, Equal<ReplaceCatalogItem$Params['body'], CatalogItemInput>,
  Equal<UpdateCatalogItem$Params['body'], CatalogItemPatch | undefined>,
] = [true, true, true];
export const created = createCatalogItem(http, '', { 'X-Idempotency-Key': 'key-0001', body: input });
export const replaced = replaceCatalogItem(http, '', { itemId: 'item-1', body: input });
export const updated = updateCatalogItem(http, '', { itemId: 'item-1', body: patch });
export const updatedWithoutBody = updateCatalogItem(http, '', { itemId: 'item-1' });
// @ts-expect-error A required JSON body cannot be left out.
export const missingBody: CreateCatalogItem$Params = { 'X-Idempotency-Key': 'key-0001' };
// @ts-expect-error The body keeps the referenced enum.
export const wrongBody: CreateCatalogItem$Params = { 'X-Idempotency-Key': 'key-0001', body: { name: 'Lamp', kind: 'other' } };
// @ts-expect-error An optional body still has its type.
export const wrongPatch: UpdateCatalogItem$Params = { itemId: 'item-1', body: { priorityLevel: 4 } };

// Parameters: path, query, and header of type string, integer, number, and boolean, a query enum, and hyphenated headers.
const listParams: ListCatalogItems$Params = { search: 'lamp', limit: 20, minWeight: 0.5, includeArchived: false, sort: 'weight', 'X-Request-Id': 'trace-1' };
const viewParams: GetCatalogItemView$Params = {
  itemId: 'item-1', version: 2, scale: 1.5, visible: true, 'X-Trace-Label': 'trace', 'X-Retry-Count': 1, 'X-Client-Weight': 0.5, 'X-Dry-Run': false,
};
export const parameters: [
  Equal<ListCatalogItems$Params['sort'], 'name' | 'weight' | undefined>, Equal<ListCatalogItems$Params['limit'], number | undefined>,
  Equal<ListCatalogItems$Params['includeArchived'], boolean | undefined>, Equal<ListCatalogItems$Params['X-Request-Id'], string | undefined>,
  Equal<GetCatalogItemView$Params['itemId'], string>, Equal<GetCatalogItemView$Params['version'], number>,
  Equal<GetCatalogItemView$Params['scale'], number>, Equal<GetCatalogItemView$Params['visible'], boolean>,
  Equal<GetCatalogItemView$Params['X-Retry-Count'], number | undefined>, Equal<GetCatalogItemView$Params['X-Dry-Run'], boolean>,
  Equal<CreateCatalogItem$Params['X-Idempotency-Key'], string>,
] = [true, true, true, true, true, true, true, true, true, true, true];
// @ts-expect-error A query enum rejects other values.
export const wrongSort: ListCatalogItems$Params = { sort: 'price' };
// @ts-expect-error An integer query parameter rejects strings.
export const wrongLimit: ListCatalogItems$Params = { limit: '20' };
// @ts-expect-error A boolean query parameter rejects strings.
export const wrongArchived: ListCatalogItems$Params = { includeArchived: 'yes' };
// @ts-expect-error A required path parameter cannot be left out.
export const missingPath: GetCatalogItemView$Params = { version: 2, scale: 1, visible: true, 'X-Dry-Run': false };
// @ts-expect-error A boolean path parameter rejects strings.
export const wrongVisible: GetCatalogItemView$Params = { ...viewParams, visible: 'true' };
// @ts-expect-error A number header parameter rejects strings.
export const wrongHeader: GetCatalogItemView$Params = { ...viewParams, 'X-Client-Weight': 'heavy' };
// @ts-expect-error A required header parameter cannot be left out.
export const missingHeader: CreateCatalogItem$Params = { body: input };
// @ts-expect-error The delete operation requires its path parameter.
export const wrongDelete = deleteCatalogItem(http, '', {});

// Responses: 200 and 201 $ref responses, through the operation functions and the services.
export const responses: [
  Equal<ResponseOf<typeof getDevelopmentStatus>, DevelopmentStatus>, Equal<ResponseOf<typeof listCatalogItems>, CatalogItemList>,
  Equal<ResponseOf<typeof listLegacyCatalogItems>, CatalogItemList>, Equal<ResponseOf<typeof createCatalogItem>, CatalogItem>,
  Equal<ResponseOf<typeof replaceCatalogItem>, CatalogItem>, Equal<ResponseOf<typeof updateCatalogItem>, CatalogItem>,
  Equal<ResponseOf<typeof getCatalogItemView>, CatalogItem>,
] = [true, true, true, true, true, true, true];
export const listed: Observable<StrictHttpResponse<CatalogItem[]>> = listCatalogItems(http, '', listParams);
export const viewed: Observable<CatalogItem> = catalog.getCatalogItemView(viewParams);
export const status: Observable<DevelopmentStatus> = development.getDevelopmentStatus();
export const deleted = deleteCatalogItem(http, '', { itemId: 'item-1' });
export const checked = checkCatalogItem(http, '', { itemId: 'item-1' });
export const allowed = optionsCatalogItems(http, '');
// @ts-expect-error A list response is not a single item.
export const wrongListed: Observable<StrictHttpResponse<CatalogItem>> = listCatalogItems(http, '', listParams);
// @ts-expect-error An item response is not a status.
export const wrongViewed: Observable<DevelopmentStatus> = catalog.getCatalogItemView(viewParams);
// @ts-expect-error The service method requires its path parameters.
export const missingViewParams = catalog.getCatalogItemView();
`.trimStart();

/** Every generated file the consumer relies on; a missing operation or model would also break tsc on the consumer. */
const subsetSdkFiles = [
  ...['check-catalog-item', 'create-catalog-item', 'delete-catalog-item', 'get-catalog-item-view', 'list-catalog-items',
    'list-legacy-catalog-items', 'options-catalog-items', 'replace-catalog-item', 'update-catalog-item'].map(name => `fn/catalog-items/${name}.ts`),
  'fn/development/get-development-status.ts',
  ...['catalog-item', 'catalog-item-input', 'catalog-item-list', 'catalog-item-patch', 'development-status', 'item-kind', 'item-priority',
    'item-weight-class'].map(name => `models/${name}.ts`),
  'services/catalog-items.service.ts', 'services/development.service.ts', 'public-api.ts',
];

async function tsc(dir: string, files: string[]) {
  const p = Bun.spawn(['node', join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--skipLibCheck', '--moduleResolution', 'bundler',
    '--module', 'preserve', '--target', 'es2022', ...files], { cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 30_000, killSignal: 'SIGKILL' });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, output: out + err };
}

test('OPENAPI-006 sdk:generate reads subset-full.json in a workspace and tsc --strict accepts the SDK and a typed consumer file', async () => {
  const dir = await workspace();
  try {
    await Bun.write(join(dir, 'openapi.json'), subsetText);
    const validated = await runBun(dir, ['scripts/validate-openapi.ts']);
    expect(validated.code, validated.stderr).toBe(0);
    const generated = await run(dir, 'sdk:generate');
    expect(generated.code, generated.output).toBe(0);
    const manifest = await Bun.file(join(dir, 'apps/frontend/sdk/.ojiepermana-sdk-manifest.json')).json();
    expect(manifest.files).toEqual(expect.arrayContaining(subsetSdkFiles));
    await Bun.write(join(dir, 'sdk-consumer.ts'), consumer);
    const sdk = (manifest.files as string[]).filter(file => file.endsWith('.ts')).map(file => join('apps/frontend/sdk', file));
    const passed = await tsc(dir, ['sdk-consumer.ts', ...sdk]);
    expect(passed.code, passed.output).toBe(0);
    // Negative control: without its directive the wrong query enum value is a real error, so the directives are live.
    const directive = '// @ts-expect-error A query enum rejects other values.\n';
    expect(consumer).toContain(directive);
    await Bun.write(join(dir, 'sdk-consumer.ts'), consumer.replace(directive, ''));
    const failed = await tsc(dir, ['sdk-consumer.ts']);
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain(`sdk-consumer.ts(`);
    expect(failed.output).toContain(`error TS2322: Type '"price"'`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test('OPENAPI-006 negative control: without required on the createCatalogItem body the generated SDK breaks the typed consumer', async () => {
  // The exact body types in the consumer come from the fixture: an optional body makes the type equality and the
  // missing body directive fail, so the passing tsc run above is not a coincidence of loose generated types.
  const dir = await workspace();
  try {
    const d = JSON.parse(subsetText);
    const body = d.paths['/api/catalog/items'].post.requestBody;
    expect(body.required).toBe(true);
    delete body.required;
    expect(ruleOf(d)).toBe('accepted');
    await Bun.write(join(dir, 'openapi.json'), canonicalJson(d));
    const generated = await run(dir, 'sdk:generate');
    expect(generated.code, generated.output).toBe(0);
    const manifest = await Bun.file(join(dir, 'apps/frontend/sdk/.ojiepermana-sdk-manifest.json')).json();
    await Bun.write(join(dir, 'sdk-consumer.ts'), consumer);
    const sdk = (manifest.files as string[]).filter(file => file.endsWith('.ts')).map(file => join('apps/frontend/sdk', file));
    const result = await tsc(dir, ['sdk-consumer.ts', ...sdk]);
    expect(result.code).not.toBe(0);
    const lineOf = (start: string) => consumer.split('\n').findIndex(line => line.startsWith(start)) + 1;
    expect(result.output).toContain(`sdk-consumer.ts(${lineOf('// @ts-expect-error A required JSON body cannot be left out.')},`);
    expect(result.output).toContain('error TS2578');
    expect(result.output).toContain('error TS2322');
    expect(result.output).not.toContain('apps/frontend/sdk/');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

/** A 204 route added in process to createApp('development'), read through app.handle() without a listener. */
function app204(options: Record<string, unknown>) {
  // The handler only sets the status, so the body stays empty; the cast skips Elysia's return type inference.
  const handler = ({ set }: { set: { status?: number | string } }) => { set.status = 204; };
  return (createApp('development') as unknown as Elysia).delete('/api/probe/:id', handler as never, {
    params: t.Object({ id: t.String() }),
    ...options,
    detail: { operationId: 'deleteProbe', tags: ['development'], security: [], ...(options['detail'] as object) },
  } as never);
}
const openapiOf = async (app: { handle(request: Request): Promise<Response> }): Promise<any> => (await app.handle(new Request('http://localhost/openapi/json'))).json();

test('OPENAPI-006 a 204 route with the detail.responses recipe exports a response with only description and is accepted', async () => {
  const app = app204({ detail: { responses: { 204: { description: 'Deleted' } } } });
  const document = await openapiOf(app);
  expect(document.paths['/api/probe/{id}'].delete.responses).toStrictEqual({ '204': { description: 'Deleted' } });
  const copy = structuredClone(document);
  expect(ruleOf(document)).toBe('accepted');
  expect(unchanged(document, copy)).toBe(true);
  const response = await app.handle(new Request('http://localhost/api/probe/item-1', { method: 'DELETE' }));
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
});

test('OPENAPI-006 the exported 204 description comes from the detail.responses recipe of the route', async () => {
  const document = await openapiOf(app204({ detail: { responses: { 204: { description: 'Removed for good' } } } }));
  expect(document.paths['/api/probe/{id}'].delete.responses).toStrictEqual({ '204': { description: 'Removed for good' } });
  expect(ruleOf(document)).toBe('accepted');
});

// Controls for the recipe: a response[204] schema exports content, which rule response rejects.
const rejected204: [string, () => unknown][] = [['t.Void', () => t.Void()], ['t.Undefined', () => t.Undefined()], ['t.Null', () => t.Null()],
  ['t.Object({})', () => t.Object({})], ['t.Never', () => t.Never()]];
for (const [name, schema] of rejected204) {
  test(`OPENAPI-006 a 204 route with response[204] ${name} exports content and is rejected with rule response`, async () => {
    const document = await openapiOf(app204({ response: { 204: schema() } }));
    expect(Object.hasOwn(document.paths['/api/probe/{id}'].delete.responses['204'], 'content')).toBe(true);
    expect(ruleOf(document)).toBe('response');
  });
}

// OPENAPI-007 (AC-8, build plan step 5): the "Aturan checker" table in spec 0008 is the official checker boundary.
const specText = await Bun.file(join(root, 'docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md')).text();
const rulesText = await Bun.file(join(root, 'docs/rules/openapi-sdk.md')).text();
const specLink = '../specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md';

/** Lines right after the one line that starts with `marker`, skipping the Markdown blank line before the block, up to the first blank line. */
function blockAfter(text: string, marker: string): string[] {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, index) => (line.startsWith(marker) ? [index] : []));
  if (starts.length !== 1) throw new Error(`Expected exactly one line starting with ${marker}`);
  let index = starts[0]! + 1;
  while (index < lines.length && lines[index]!.trim() === '') index++;
  const block: string[] = [];
  for (; index < lines.length && lines[index]!.trim() !== ''; index++) block.push(lines[index]!);
  return block;
}

/**
 * Rule IDs read the way AC-8 states: the table rows after the `**Aturan checker**` line up to the first blank
 * line, without the header and separator rows, taking the text between backticks in the first cell.
 */
function specRuleIds(text: string): string[] {
  const [header, separator, ...rows] = blockAfter(text, '**Aturan checker**');
  if (!/^\|\s*ID\s*\|/.test(header ?? '') || !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(separator ?? '')) throw new Error('Unexpected rule table header');
  return rows.map(row => {
    const id = row.startsWith('|') ? /^\s*`([^`]+)`\s*$/.exec(row.split('|')[1]!) : null;
    if (!id) throw new Error('Rule table row without a backtick ID in its first cell');
    return id[1]!;
  });
}

test('OPENAPI-007 rule IDs read from the Aturan checker table in spec 0008 equal OPENAPI_RULE_IDS in the same order', () => {
  const ids = specRuleIds(specText);
  expect(ids).toHaveLength(16);
  expect(ids).toEqual([...OPENAPI_RULE_IDS]);
});

test('OPENAPI-007 the table reader notices a reordered, missing, or renamed rule row', () => {
  const row = (id: string) => specText.split('\n').find(line => line.startsWith(`| \`${id}\` |`))!;
  // Function replacers keep `$` in the row text literal.
  const swapped = specText.replace(row('version'), () => '\u0000').replace(row('info'), () => row('version')).replace('\u0000', () => row('info'));
  const renamed = specText.replace(row('schema'), () => row('schema').replace('`schema`', () => '`schemas`'));
  const variants = [swapped, specText.replace(`${row('tag')}\n`, () => ''), renamed];
  for (const variant of variants) {
    expect(variant).not.toBe(specText);
    expect(specRuleIds(variant)).not.toEqual([...OPENAPI_RULE_IDS]);
  }
});

test('OPENAPI-007 every rule ID has at least one rejection row in the mutation matrix', () => {
  const counts = new Map<string, number>();
  for (const [, , rule] of matrix) counts.set(rule, (counts.get(rule) ?? 0) + 1);
  expect([...counts.keys()].filter(rule => !(OPENAPI_RULE_IDS as readonly string[]).includes(rule))).toEqual([]);
  expect(OPENAPI_RULE_IDS.filter(rule => !counts.has(rule))).toEqual([]);
});

test('OPENAPI-007 the checker opening comment and the OpenAPI rules refer to spec 0008, deny full certification, and carry the clean route recipe', async () => {
  const checker = await Bun.file(join(root, 'scripts/validate-openapi.ts')).text();
  const opening = checker.split('\n');
  const comment = opening.slice(0, opening.findIndex(line => !line.startsWith('//'))).join('\n');
  expect(comment).toContain('docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md');
  expect(comment).toContain('Passing this checker is not full OpenAPI or JSON Schema certification.');
  expect(comment).toContain('covers only the shapes listed in AC-7');

  const start = rulesText.indexOf('\n## Ekspor dan validasi OpenAPI\n');
  const section = rulesText.slice(start, rulesText.indexOf('\n## ', start + 1));
  expect(start).toBeGreaterThan(-1);
  expect(section).toContain(`[spec 0008](${specLink})`);
  expect(section).toContain('Kelulusan checker bukan sertifikasi penuh OpenAPI atau JSON Schema.');
  expect(section).toContain('hanya berlaku untuk bentuk yang tercantum di AC-7 spec 0008');
  const recipe = blockAfter(specText, '**Bentuk route yang diekspor bersih**');
  expect(recipe.length).toBe(6);
  expect(recipe.every(line => line.startsWith('- '))).toBe(true);
  const recipeStart = section.indexOf('\n### Bentuk route yang diekspor bersih\n');
  expect(recipeStart).toBeGreaterThan(-1);
  const lines = section.slice(recipeStart).split('\n');
  const first = lines.findIndex(line => line.startsWith('- '));
  const end = lines.findIndex((line, index) => index > first && !line.startsWith('- '));
  expect(lines.slice(first, end)).toEqual(recipe);
});

test('OPENAPI-007 the exporter, checker, and canonicalJson add no dependency or environment variable, and check:dependencies passes', async () => {
  for (const file of ['scripts/validate-openapi.ts', 'scripts/export-openapi.ts', 'scripts/lib/canonical-json.ts']) {
    const text = await Bun.file(join(root, file)).text();
    const specifiers = [...text.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g)].map(match => match[1] ?? match[2]!);
    expect(specifiers.filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('.')), file).toEqual([]);
    expect(text, file).not.toMatch(/process\.env|Bun\.env|import\.meta\.env/);
  }
  const result = await run(root, 'check:dependencies');
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('Exact dependency pins, runtime engines and installed peers passed');
}, 30_000);

test('OPENAPI-007 api:openapi and api:validate ignore a .env file in the checkout, as the tested script processes do', async () => {
  const dir = await workspace();
  try {
    // A checkout .env holds application secrets. The workspace copies throw or exit when they see its sentinel.
    await Bun.write(join(dir, '.env'), `FOUNDATION_ENV_SENTINEL=${marker()}\n`);
    const route = join(dir, statusRoute);
    await Bun.write(route, `if (process.env['FOUNDATION_ENV_SENTINEL']) throw new Error('env file loaded');\n${await Bun.file(route).text()}`);
    const validator = join(dir, 'scripts/validate-openapi.ts');
    await Bun.write(validator, `if (process.env['FOUNDATION_ENV_SENTINEL']) process.exit(3);\n${await Bun.file(validator).text()}`);
    const manifest = join(dir, 'package.json');
    const pkg = await Bun.file(manifest).json();
    pkg.scripts['sdk:generate'] = `bun --no-env-file -e 'await Bun.write("sdk-generate.marker", "ran")'`;
    await Bun.write(manifest, JSON.stringify(pkg, null, 2));
    const synced = await run(dir, 'api:sync');
    expect(synced.code, synced.output).toBe(0);
    expect(await Bun.file(join(dir, 'sdk-generate.marker')).exists()).toBe(true);
    expect((await bytes(join(dir, 'openapi.json'))).equals(storedBytes)).toBe(true);
    // Negative control: without --no-env-file Bun loads .env, so the sentinel is really visible to the processes.
    for (const [script, command] of [['api:openapi', 'bun scripts/export-openapi.ts'], ['api:validate', 'bun scripts/validate-openapi.ts']]) {
      pkg.scripts[script!] = command;
      await Bun.write(manifest, JSON.stringify(pkg, null, 2));
      expect((await run(dir, script!)).code, script).not.toBe(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// DEP-003 (spec 0012, AC-4, table *Kontrak OpenAPI*): the two health operations of the stored contract, the live export
// of the development composition, the four required operations, and the production composition without the plugin.
test('DEP-003 the stored contract declares GET /health/live and GET /health/ready as the Kontrak OpenAPI table, and the development export equals it', async () => {
  const stored = JSON.parse(storedText);
  // Spec 0014 adds the auth tag in front of the two tags of spec 0012.
  expect(stored.tags).toEqual([{ name: 'auth' }, { name: 'development' }, { name: 'health' }]);
  const inline = (error: string) => ({ 'application/json': { schema: {
    additionalProperties: false, properties: { error: { const: error, type: 'string' } }, required: ['error'], type: 'object',
  } } });
  const reference = (name: string) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } });
  const rows: [string, string, string, Record<string, unknown>][] = [
    ['/health/live', 'getHealthLive', 'Backend process liveness', { 200: reference('HealthLive'), 400: inline('Invalid request'), 500: inline('Internal server error') }],
    ['/health/ready', 'getHealthReady', 'Backend database readiness', {
      200: reference('HealthReady'), 400: inline('Invalid request'), 500: inline('Internal server error'), 503: reference('HealthUnavailable'),
    }],
  ];
  for (const [path, operationId, summary, responses] of rows) {
    expect(Object.keys(stored.paths[path]), path).toEqual(['get']);
    const operation = stored.paths[path].get;
    expect([operation.operationId, operation.tags, operation.security, operation.summary], path).toEqual([operationId, ['health'], [], summary]);
    expect(Object.keys(operation.responses).sort(), path).toEqual(Object.keys(responses).sort());
    for (const [status, content] of Object.entries(responses)) expect(operation.responses[status].content, `${path} ${status}`).toStrictEqual(content);
  }
  for (const [name, value] of [['HealthLive', 'live'], ['HealthReady', 'ready'], ['HealthUnavailable', 'unavailable']] as const) {
    expect(stored.components.schemas[name], name).toStrictEqual({
      $id: `#/components/schemas/${name}`, additionalProperties: false, type: 'object',
      properties: { status: { const: value, enum: [value], type: 'string' } }, required: ['status'],
    });
  }
  // The export of the backend source gives the same operations and models, and the production composition has no plugin.
  const exported = await (await createApp('development').handle(new Request('http://localhost/openapi/json'))).json();
  for (const path of ['/health/live', '/health/ready']) expect(exported.paths[path], path).toStrictEqual(stored.paths[path]);
  for (const name of ['HealthLive', 'HealthReady', 'HealthUnavailable']) expect(exported.components.schemas[name], name).toStrictEqual(stored.components.schemas[name]);
  const production = createApp('production');
  for (const path of ['/openapi', '/openapi/json']) expect((await production.handle(new Request(`http://localhost${path}`))).status, path).toBe(404);
});

test('DEP-003 REQUIRED_OPERATIONS holds the four entries before spec 0014 first, and removing or changing a health operation is rejected as required-operation', () => {
  // Spec 0014 appends its three auth entries after these four (AUTH-011 below).
  expect(REQUIRED_OPERATIONS.map(operation => `${operation.method} ${operation.path} ${operation.operationId}`).slice(0, 4)).toEqual([
    'get /api/status getDevelopmentStatus',
    'get /api/readiness getDevelopmentReadiness',
    'get /health/live getHealthLive',
    'get /health/ready getHealthReady',
  ]);
  const stored = JSON.parse(storedText);
  expect(ruleOf(structuredClone(stored))).toBe('accepted');
  const cases: [string, (d: any) => void][] = [
    ['no /health/live', d => { delete d.paths['/health/live']; }],
    ['no /health/ready', d => { delete d.paths['/health/ready']; }],
    ['another operationId on /health/live', d => { d.paths['/health/live'].get.operationId = 'getLive'; }],
    ['another tag on /health/ready', d => { d.paths['/health/ready'].get.tags = ['development']; }],
    ['a 200 that references another model', d => { d.paths['/health/live'].get.responses['200'].content = { 'application/json': { schema: { $ref: '#/components/schemas/HealthReady' } } }; }],
    ['a HealthLive with another literal', d => { d.components.schemas.HealthLive.properties.status = { const: 'ok', enum: ['ok'], type: 'string' }; }],
    ['a HealthReady with additional properties', d => { d.components.schemas.HealthReady.additionalProperties = true; }],
  ];
  for (const [name, mutate] of cases) {
    const document = structuredClone(stored);
    mutate(document);
    expect(ruleOf(document), name).toBe('required-operation');
  }
});

// AUTH-011 (spec 0014, AC-11): the five auth operations of table *API surface* in the stored contract and in the live
// development export, and the three entries of *Operasi wajib baru* in REQUIRED_OPERATIONS, each proved by mutations of
// the stored contract that break only that entry.
const AUTH_OPERATIONS: [string, string, string, Record<string, unknown>[], string[]][] = [
  ['/api/auth/session', 'post', 'signIn', [], ['200', '400', '401', '403', '415', '429', '500', '503']],
  ['/api/auth/session', 'get', 'getAuthSession', [{ sessionCookie: [] }], ['200', '400', '401', '500', '503']],
  ['/api/auth/session', 'delete', 'signOut', [{ sessionCookie: [] }], ['204', '400', '403', '500', '503']],
  ['/api/auth/sessions', 'get', 'listAuthSessions', [{ sessionCookie: [] }], ['200', '400', '401', '500', '503']],
  ['/api/auth/sessions/{sessionId}', 'delete', 'revokeAuthSession', [{ sessionCookie: [] }], ['204', '400', '401', '403', '404', '500', '503']],
];
const AUTH_SUCCESS: Record<string, string> = { signIn: 'AuthSession', getAuthSession: 'AuthSession', listAuthSessions: 'AuthSessionList' };

test('AUTH-011 the stored contract declares the five auth operations with exactly the statuses of API surface, 204 without content, and AuthError on every error status', async () => {
  const stored = JSON.parse(storedText);
  expect(stored.components.securitySchemes).toStrictEqual({ sessionCookie: {
    type: 'apiKey', in: 'cookie', name: '__Host-foundation_session',
    description: 'Cookie sesi HttpOnly. Komposisi development memakai nama foundation_session tanpa Secure karena berjalan di HTTP lokal.',
  } });
  expect(Object.keys(stored.paths).filter(path => path.startsWith('/api/auth/')).sort()).toEqual(['/api/auth/session', '/api/auth/sessions', '/api/auth/sessions/{sessionId}']);
  for (const [path, method, operationId, security, statuses] of AUTH_OPERATIONS) {
    const label = `${method} ${path}`;
    const operation = stored.paths[path][method];
    expect([operation.operationId, operation.tags, operation.security], label).toEqual([operationId, ['auth'], security]);
    expect(Object.keys(operation.responses).sort(), label).toEqual(statuses);
    for (const status of statuses) {
      const response = operation.responses[status];
      if (status === '204') expect(response, `${label} 204`).toStrictEqual({ description: 'Response for status 204' });
      else if (status === '200') expect(response.content, `${label} 200`).toStrictEqual({ 'application/json': { schema: { $ref: `#/components/schemas/${AUTH_SUCCESS[operationId]}` } } });
      else expect(response.content, `${label} ${status}`).toStrictEqual({ 'application/json': { schema: { $ref: '#/components/schemas/AuthError' } } });
    }
    // No cookie parameter: the session cookie is the sessionCookie security scheme, read from the cookie header.
    for (const parameter of operation.parameters ?? []) expect(parameter.in, label).not.toBe('cookie');
  }
  // Only the two DELETE routes take the x-csrf-token header, and only revokeAuthSession takes the sessionId path.
  const parameters = (path: string, method: string) => (stored.paths[path][method].parameters ?? []).map((parameter: any) => `${parameter.in} ${parameter.name} ${parameter.required} ${parameter.schema.pattern}`);
  expect(parameters('/api/auth/session', 'delete')).toEqual(['header x-csrf-token true ^[A-Za-z0-9_-]{43}$']);
  expect(parameters('/api/auth/sessions/{sessionId}', 'delete')).toEqual([
    'path sessionId true ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'header x-csrf-token true ^[A-Za-z0-9_-]{43}$',
  ]);
  for (const [path, method] of [['/api/auth/session', 'post'], ['/api/auth/session', 'get'], ['/api/auth/sessions', 'get']] as const) expect(parameters(path, method), `${method} ${path}`).toEqual([]);
  expect(stored.paths['/api/auth/session'].post.requestBody).toStrictEqual({ required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SignInRequest' } } } });
  // No credential example anywhere in the contract (AC-10).
  expect(storedText).not.toMatch(/"examples?"\s*:/);
  // The live development export of the backend source gives the same auth operations and models.
  const exported = await (await createApp('development').handle(new Request('http://localhost/openapi/json'))).json();
  for (const path of ['/api/auth/session', '/api/auth/sessions', '/api/auth/sessions/{sessionId}']) expect(exported.paths[path], path).toStrictEqual(stored.paths[path]);
  for (const name of ['AuthError', 'AuthSession', 'AuthSessionList', 'SignInRequest']) expect(exported.components.schemas[name], name).toStrictEqual(stored.components.schemas[name]);
  expect(exported.components.securitySchemes).toStrictEqual(stored.components.securitySchemes);
});

test('AUTH-011 REQUIRED_OPERATIONS adds the three entries of Operasi wajib baru after the four older ones', () => {
  expect(REQUIRED_OPERATIONS.slice(4).map(({ checkComponent: _check, ...entry }) => entry)).toEqual([
    { path: '/api/auth/session', method: 'post', operationId: 'signIn', tag: 'auth', security: [], successStatus: '200', component: 'AuthSession' },
    { path: '/api/auth/session', method: 'get', operationId: 'getAuthSession', tag: 'auth', security: [{ sessionCookie: [] }], successStatus: '200', component: 'AuthSession' },
    { path: '/api/auth/sessions', method: 'get', operationId: 'listAuthSessions', tag: 'auth', security: [{ sessionCookie: [] }], successStatus: '200', component: 'AuthSessionList' },
  ]);
  for (const entry of REQUIRED_OPERATIONS.slice(4)) {
    expect(Object.isFrozen(entry) && Object.isFrozen(entry.security) && entry.security.every(requirement => Object.isFrozen(requirement))).toBe(true);
  }
});

test('AUTH-011 a mutation that breaks only one auth entry is rejected as required-operation, and the stored contract is accepted', () => {
  const stored = JSON.parse(storedText);
  expect(ruleOf(structuredClone(stored))).toBe('accepted');
  const session = (d: any) => d.components.schemas.AuthSession;
  const list = (d: any) => d.components.schemas.AuthSessionList;
  const cases: [string, (d: any) => void][] = [
    // signIn
    ['POST /api/auth/session removed while GET and DELETE stay', d => { delete d.paths['/api/auth/session'].post; }],
    ['another valid operationId on signIn', d => { d.paths['/api/auth/session'].post.operationId = 'createAuthSession'; }],
    ['another declared tag on signIn', d => { d.paths['/api/auth/session'].post.tags = ['development']; }],
    ['signIn that requires the session cookie', d => { d.paths['/api/auth/session'].post.security = [{ sessionCookie: [] }]; }],
    ['a signIn 200 that references AuthSessionList', d => { d.paths['/api/auth/session'].post.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/AuthSessionList' }; }],
    // getAuthSession
    ['GET /api/auth/session removed', d => { delete d.paths['/api/auth/session'].get; }],
    ['another valid operationId on getAuthSession', d => { d.paths['/api/auth/session'].get.operationId = 'readAuthSession'; }],
    ['getAuthSession without security requirement', d => { d.paths['/api/auth/session'].get.security = []; }],
    ['a getAuthSession 200 that references AuthError', d => { d.paths['/api/auth/session'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/AuthError' }; }],
    // listAuthSessions
    ['GET /api/auth/sessions removed', d => { delete d.paths['/api/auth/sessions']; }],
    ['another declared tag on listAuthSessions', d => { d.paths['/api/auth/sessions'].get.tags = ['health']; }],
    ['listAuthSessions without security requirement', d => { d.paths['/api/auth/sessions'].get.security = []; }],
    ['a listAuthSessions 200 that references AuthSession', d => { d.paths['/api/auth/sessions'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/AuthSession' }; }],
    // AuthSession model, shared by signIn and getAuthSession
    ['AuthSession with additional properties allowed', d => { session(d).additionalProperties = true; }],
    ['AuthSession without additionalProperties', d => { delete session(d).additionalProperties; }],
    ['AuthSession with csrfToken left out of required', d => { session(d).required = ['user', 'session']; }],
    ['AuthSession without csrfToken', d => { delete session(d).properties.csrfToken; session(d).required = ['user', 'session']; }],
    ['AuthSession with a token property', d => { session(d).properties.token = { type: 'string' }; }],
    ['AuthSession with a passwordHash inside user', d => { session(d).properties.user.properties.passwordHash = { type: 'string' }; }],
    ['AuthSession with a tokenHash inside session', d => { session(d).properties.session.properties.tokenHash = { type: 'string' }; session(d).properties.session.required.push('tokenHash'); }],
    ['AuthSession with a password inside user', d => { session(d).properties.user.properties.password = { type: 'string' }; }],
    ['AuthSession whose user is a reference', d => { d.components.schemas.AuthUser = { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] }; session(d).properties.user = { $ref: '#/components/schemas/AuthUser' }; }],
    // AuthSessionList model
    ['AuthSessionList with an extra property', d => { list(d).properties.total = { type: 'integer', minimum: 0 }; }],
    ['AuthSessionList items with an extra property', d => { list(d).properties.sessions.items.properties.token = { type: 'string' }; }],
    ['AuthSessionList items without current', d => { delete list(d).properties.sessions.items.properties.current; list(d).properties.sessions.items.required = ['id', 'createdAt', 'lastSeenAt']; }],
    ['AuthSessionList sessions as an object', d => { list(d).properties.sessions = { type: 'object', additionalProperties: false, properties: {}, required: [] }; }],
  ];
  for (const [name, mutate] of cases) {
    const document = structuredClone(stored);
    mutate(document);
    expect(ruleOf(document), name).toBe('required-operation');
  }
});
