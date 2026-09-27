import { expect, test } from 'bun:test';
import { createApp } from '../../../apps/backend/src/app';
import { readConfiguration } from '../../../apps/backend/src/config/env';

const root = new URL('../../../', import.meta.url).pathname;
const env = { PATH: process.env['PATH']!, NODE_ENV: 'development', HOST: '127.0.0.1' };
async function run(args: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, '--no-env-file', ...args], { cwd: root, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, output: stdout + stderr };
}

test('APP-003 importing composition and exporting contracts never allocates external resources', async () => {
  const result = await run(['-e', `Bun.serve = () => { throw Error('unexpected listener'); }; Bun.SQL = class { constructor() { throw Error('unexpected database'); } }; globalThis.fetch = () => { throw Error('unexpected network'); }; const {createApp} = await import('./apps/backend/src/app'); const app = createApp('development'); await app.modules; if(app.server) throw Error('listener'); await import('./scripts/export-openapi');`], { DATABASE_URL: 'invalid' });
  expect(result.code).toBe(0);
  expect(result.output).toContain('OpenAPI exported without listener');
});

test('APP-002 development route returns only the fixed status without a database', async () => {
  const app = createApp('development');
  const response = await app.handle(new Request('http://localhost/api/status'));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ status: 'ok' });
  expect(app.server).toBeNull();
});

test('APP-004 production omits diagnostic and documentation routes', async () => {
  const app = createApp('production');
  for (const path of ['/api/status', '/openapi', '/openapi/json']) {
    const response = await app.handle(new Request(`http://localhost${path}`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  }
});

for (const overrides of [{PORT:'0'}, {PORT:'65536'}, {PORT:'1e3'}, {PORT:' 8888'}, {PORT:'secret-marker'}, {HOST:'0.0.0.0'}, {HOST:'secret-marker'}, {NODE_ENV:'test'}, {NODE_ENV:'secret-marker'}]) {
  test(`APP-004 invalid configuration fails safely before listen (${JSON.stringify(overrides)})`, async () => {
    const result = await run(['apps/backend/src/index.ts'], overrides);
    expect(result.code).toBe(1);
    expect(result.output.trim()).toBe('Backend startup failed: invalid configuration or listener unavailable');
    expect(result.output).not.toContain('secret-marker');
    expect(result.output).not.toContain('listening');
  });
}

test('APP-004 configuration accepts port boundaries and production binding', () => {
  for (const port of ['1', '65535']) expect(readConfiguration({PORT:port}).port).toBe(Number(port));
  expect(readConfiguration({NODE_ENV:'production',HOST:'0.0.0.0'}).mode).toBe('production');
});

async function unusedPort() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
  const port = server.port!;
  await server.stop(true);
  return port;
}
async function ready(url: string) {
  const limit = Date.now() + 5000;
  while (Date.now() < limit) {
    try { return await fetch(url); } catch { await Bun.sleep(20); }
  }
  throw new Error('Backend never became ready');
}
for (const entry of ['apps/backend/src/index.ts','dist/backend/index.js']) {
  for (const signal of ['SIGTERM','SIGINT'] as const) {
    test(`APP-002 APP-004 ${entry} serves HTTP then releases listener on ${signal}`, async () => {
      const port = await unusedPort();
      const p = Bun.spawn([process.execPath, '--no-env-file', entry], {cwd:root,env:{...env,PORT:String(port)},stdout:'pipe',stderr:'pipe'});
      try {
        const response = await ready(`http://127.0.0.1:${port}/api/status`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({status:'ok'});
        p.kill(signal);
        expect(await Promise.race([p.exited, Bun.sleep(6000).then(() => {throw Error('shutdown timeout');})])).toBe(0);
        expect(await new Response(p.stdout).text()).toContain('Backend stopped');
        const replacement = Bun.serve({hostname:'127.0.0.1',port,fetch:()=>new Response('replacement')});
        await replacement.stop(true);
      } finally { if(p.exitCode === null) {p.kill('SIGKILL');await p.exited;} }
    }, 10000);
  }
}

test('APP-004 occupied listener causes safe nonzero startup exit', async () => {
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('fixture')});
  try {
    const result = await run(['apps/backend/src/index.ts'],{PORT:String(server.port)});
    expect(result.code).toBe(1);
    expect(result.output.trim()).toBe('Backend startup failed: invalid configuration or listener unavailable');
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe('fixture');
  } finally {await server.stop(true);}
});

test('APP-004 bundled production listener returns 404 for development surfaces', async () => {
  const port = await unusedPort();
  const p = Bun.spawn([process.execPath, '--no-env-file', 'dist/backend/index.js'], {cwd:root,env:{...env,NODE_ENV:'production',PORT:String(port)},stdout:'pipe',stderr:'pipe'});
  try {
    for (const path of ['/api/status', '/openapi/json', '/openapi']) {
      const response = await ready(`http://127.0.0.1:${port}${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({error:'Not found'});
    }
    p.kill('SIGTERM');
    expect(await p.exited).toBe(0);
  } finally {if(p.exitCode === null){p.kill('SIGKILL');await p.exited;}}
});

test('APP-004 unexpected route errors hide secret values and stack traces', async () => {
  const app = createApp('development').get('/failure-fixture', () => {throw new Error('secret-marker');});
  const result = await app.handle(new Request('http://localhost/failure-fixture'));
  expect(result.status).toBe(500);
  expect(await result.json()).toEqual({error:'Internal server error'});
});
