import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate } from '../../server/migrations';
import { createApp } from '../../apps/api/app';
import { loadConfig } from '../../server/config';
const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('operational failure and migration integrity', () => {
  test('concurrent migration is serialized, checksum changes rejected, bad migration rolled back', async () => {
    const schema = `migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const setup = new SQL(url!); await setup.unsafe(`CREATE SCHEMA ${schema}`);
    const db = new SQL(url!, { connection: { search_path: schema } });
    const directory = await mkdtemp(join(tmpdir(), 'foundation-migration-'));
    const file = join(directory, '0001_test.sql');
    try {
      await writeFile(file, 'CREATE TABLE sample (id integer PRIMARY KEY);');
      const outcomes = await Promise.all([migrate(db, directory), migrate(db, directory)]);
      expect(outcomes.flat().filter(item => item.applied)).toHaveLength(1);
      expect((await db`SELECT * FROM schema_migrations`).length).toBe(1);
      await writeFile(file, 'CREATE TABLE sample (id text PRIMARY KEY);');
      await expect(migrate(db, directory)).rejects.toThrow('Checksum');
      await writeFile(file, 'CREATE TABLE sample (id integer PRIMARY KEY);');
      await writeFile(join(directory, '0002_bad.sql'), 'CREATE TABLE rolled_back (id integer); SELECT 1/0;');
      await expect(migrate(db, directory)).rejects.toThrow();
      expect((await db`SELECT to_regclass('rolled_back') AS name`)[0].name).toBeNull();
      expect((await db`SELECT * FROM schema_migrations`).length).toBe(1);
    } finally { await db.close(); await setup.unsafe(`DROP SCHEMA ${schema} CASCADE`); await setup.close(); await rm(directory, { recursive: true, force: true }); }
  });
  test('Redis outage fails closed for login and marks readiness unavailable while liveness remains healthy', async () => {
    const db = new SQL(url!);
    const config = loadConfig({ ...process.env, DATABASE_URL: url, REDIS_URL: 'redis://127.0.0.1:1' });
    const runtime = createApp(db, config); const app = runtime.app.compile();
    try {
      const response = await app.handle(new Request('http://localhost:8888/api/v1/auth/login', { method: 'POST', headers: { origin: config.appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong' }) }));
      expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('AUTH_UNAVAILABLE');
      expect((await app.handle(new Request('http://localhost:8888/api/health/ready'))).status).toBe(503);
      expect((await app.handle(new Request('http://localhost:8888/api/health/live'))).status).toBe(200);
    } finally { await runtime.close(); await db.close(); }
  });
  test('PostgreSQL outage produces a safe error envelope without credentials', async () => {
    const db = new SQL('postgres://postgres@127.0.0.1:1/nonexistent', { connectionTimeout: 1 });
    const config = loadConfig({ ...process.env, DATABASE_URL: url });
    const runtime = createApp(db, config); const app = runtime.app.compile();
    try {
      const response = await app.handle(new Request('http://localhost:8888/api/v1/auth/session', { headers: { cookie: `foundation_session=${'a'.repeat(43)}` } }));
      expect(response.status).toBe(503); const body = await response.json();
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE'); expect(body.requestId).toBeDefined(); expect(JSON.stringify(body)).not.toContain('postgres://');
    } finally { await runtime.close(); await db.close(); }
  });
});
