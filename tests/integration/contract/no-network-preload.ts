import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Guard preload for OPENAPI-001 (spec 0008, AC-1). Loaded with `bun --preload` before the script under test.
// Every listener, database, and network entry point that AC-1 names, plus the Redis and S3 clients of Bun and
// net.Socket.prototype.connect, is replaced by a function that appends its name to guard-calls.log in the working
// directory and then throws. Direct assignment also blocks named imports from 'bun'. node:net and node:tls are
// patched through require before any ESM import of them exists, so named and namespace imports see the guard too.
// Not guarded (spec 0008, invariant 1): Bun.fetch, which is read only in Bun 1.4.2, Worker, Bun.spawn,
// node:child_process, and DNS lookups. The sentinel listeners of the test catch a real connection from those.
const log = join(process.cwd(), 'guard-calls.log');
function guard(name: string) {
  // A plain function, so `new Bun.SQL(...)` and `new WebSocket(...)` reach the guard instead of failing first.
  return function blocked(): never {
    appendFileSync(log, `${name}\n`);
    throw new Error(`${name} is blocked by the OpenAPI export guard`);
  };
}
/** Stands in for a ready made client object: reading any of its properties is a guarded call. */
function guardedClient(name: string) {
  return new Proxy({}, { get: () => guard(name)() });
}

const bun = Bun as unknown as Record<string, unknown>;
for (const name of ['serve', 'listen', 'connect', 'udpSocket', 'SQL', 'sql', 'RedisClient', 'S3Client']) bun[name] = guard(`Bun.${name}`);
for (const name of ['redis', 's3']) bun[name] = guardedClient(`Bun.${name}`);
const global = globalThis as unknown as Record<string, unknown>;
global['fetch'] = guard('fetch');
global['WebSocket'] = guard('WebSocket');
const require = createRequire(import.meta.url);
const net = require('node:net') as Record<string, unknown> & { Socket: { prototype: Record<string, unknown> } };
const tls = require('node:tls') as Record<string, unknown>;
net['connect'] = guard('node:net.connect');
net['createConnection'] = guard('node:net.createConnection');
net.Socket.prototype['connect'] = guard('node:net.Socket.connect');
tls['connect'] = guard('node:tls.connect');
