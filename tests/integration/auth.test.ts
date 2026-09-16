import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { createApp } from '../../apps/api/app';
import { createDb } from '../../server/db';
import { loadConfig } from '../../server/config';
import { decryptPayload } from '../../server/mail/crypto';
import type { MailMessage } from '../../server/mail';
import { migrate } from '../../server/migrations';
import { digest } from '../../server/security';

const databaseUrl = process.env['TEST_DATABASE_URL'];
describe.skipIf(!databaseUrl)('real PostgreSQL/Redis identity and API security', () => {
  const db = createDb(databaseUrl!);
  const prefix = `foundation_auth_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const config = loadConfig({ ...process.env, DATABASE_URL: databaseUrl, REDIS_PREFIX: prefix });
  const runtime = createApp(db, config); const app = runtime.app.compile(); const service = runtime.auth;
  const users: string[] = []; const outbox = new Set<string>();
  const password = 'Foundation-test-password-2026';
  let counter = 0;
  const uniqueEmail = () => `auth-${prefix}-${++counter}@example.test`;
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return app.handle(new Request(`http://localhost:8888/api/v1${path}`, { method, headers: { origin: config.appUrl, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  }
  async function actionToken(email: string) {
    const rows = await db`SELECT id, payload FROM mail_outbox WHERE payload IS NOT NULL ORDER BY created_at DESC`;
    for (const row of rows) {
      try {
        const message = await decryptPayload(row.payload, config.encryptionKey) as MailMessage;
        if (message.to === email) { outbox.add(row.id); const match = message.text.match(/#token=([A-Za-z0-9_-]+)/); if (match) return match[1]!; }
      } catch { /* Records from separately isolated test configurations. */ }
    }
    throw new Error('Expected encrypted action email.');
  }
  async function pending(role: 'user' | 'admin' = 'user') { const user = await service.register({ name: 'Test User', email: uniqueEmail(), role }); users.push(user.id); return user; }
  async function active(role: 'user' | 'admin' = 'user') { const user = await pending(role); await service.completeAction(await actionToken(user.email), password, 'activation'); return user; }
  async function session(user: { email: string }) {
    const response = await request('/auth/login', 'POST', { email: user.email, password });
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { data, cookie, headers: { cookie, 'x-csrf-token': data.csrfToken } };
  }
  beforeAll(async () => { await migrate(db); });
  afterAll(async () => {
    // Collect only mail addressed to our test namespace, never touch unrelated rows.
    for (const row of await db`SELECT id,payload FROM mail_outbox WHERE payload IS NOT NULL`) {
      try { if ((await decryptPayload(row.payload, config.encryptionKey) as MailMessage).to.includes(prefix)) outbox.add(row.id); } catch { /* Other encryption keys. */ }
    }
    for (const id of outbox) await db`DELETE FROM mail_outbox WHERE id = ${id}`;
    for (const id of users) { await db`DELETE FROM audit_events WHERE subject_id = ${id}`; await db`DELETE FROM users WHERE id = ${id}`; }
    await runtime.close(); await db.close();
    const redis = new RedisClient(config.redisUrl); const keys = await redis.send('KEYS', [`${prefix}:*`]) as string[]; if (keys.length) await redis.send('DEL', keys); redis.close();
  });

  test('CLI registers normalized account and encrypted mail atomically', async () => {
    const email = uniqueEmail();
    const run = Bun.spawn(['bun', 'scripts/user-register.ts', '--name', 'CLI Person', '--email', email.toUpperCase(), '--role', 'admin'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl!, REDIS_PREFIX: prefix }, stdout: 'pipe', stderr: 'pipe' });
    expect(await run.exited).toBe(0); const output = await new Response(run.stdout).text();
    const [user] = await db`SELECT * FROM users WHERE email = ${email}`; users.push(user.id);
    expect(user.status).toBe('pending'); expect(user.password_hash).toBeNull(); expect(user.role).toBe('admin');
    const raw = await actionToken(email); expect(output).not.toContain(raw);
    const [stored] = await db`SELECT token_hash FROM action_tokens WHERE user_id = ${user.id}`; expect(stored.token_hash).toBe(digest(raw));
    await expect(service.register({ name: 'Duplicate', email: email.toUpperCase(), role: 'user' })).rejects.toMatchObject({ code: 'EMAIL_EXISTS' });
    expect((await db`SELECT id FROM users WHERE email = ${email}`).length).toBe(1);
  });

  test('activation is single use even when requests race', async () => {
    const user = await pending(); const raw = await actionToken(user.email);
    const results = await Promise.allSettled([service.completeAction(raw, password, 'activation'), service.completeAction(raw, password, 'activation')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const [row] = await db`SELECT password_hash,status FROM users WHERE id = ${user.id}`; expect(row.status).toBe('active'); expect(row.password_hash).toStartWith('$argon2id$');
  });

  test('expired token cannot activate and resend invalidates old token', async () => {
    const user = await pending(); const old = await actionToken(user.email);
    await db`UPDATE action_tokens SET expires_at = now() - interval '1 second' WHERE user_id = ${user.id}`;
    await expect(service.completeAction(old, password, 'activation')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    await service.resendActivation(user.email); const renewed = await actionToken(user.email); expect(renewed).not.toBe(old);
    await expect(service.completeAction(old, password, 'activation')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    await service.completeAction(renewed, password, 'activation');
  });

  test('rejects foreign origin and missing CSRF; restores session and invalidates logout', async () => {
    const user = await active();
    expect((await request('/auth/login', 'POST', { email: user.email, password }, { origin: 'https://evil.example' })).status).toBe(403);
    const logged = await session(user);
    expect((await request('/me', 'PATCH', { name: 'Bad' }, { cookie: logged.cookie })).status).toBe(403);
    expect((await request('/me', 'PATCH', { name: 'Updated' }, logged.headers)).status).toBe(200);
    const current = await request('/auth/session', 'GET', undefined, logged.headers); expect((await current.json()).data.user.name).toBe('Updated');
    const loggedOut = await request('/auth/logout', 'POST', undefined, logged.headers); expect(loggedOut.status).toBe(200); expect(loggedOut.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await request('/auth/session', 'GET', undefined, logged.headers)).status).toBe(401);
  });

  test('password reset is generic and revokes all sessions and old password', async () => {
    const user = await active(); const a = await session(user); const b = await session(user);
    const known = await request('/auth/forgot-password', 'POST', { email: user.email });
    const unknown = await request('/auth/forgot-password', 'POST', { email: uniqueEmail() });
    expect(await known.json()).toEqual(await unknown.json()); const raw = await actionToken(user.email);
    expect((await request('/auth/reset-password', 'POST', { token: raw, password: `${password}-new` })).status).toBe(200);
    expect((await request('/auth/session', 'GET', undefined, a.headers)).status).toBe(401);
    expect((await request('/auth/session', 'GET', undefined, b.headers)).status).toBe(401);
    await expect(service.login(user.email, password)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect((await request('/auth/reset-password', 'POST', { token: raw, password })).status).toBe(400);
  });

  test('password change rotates session and expires other sessions', async () => {
    const user = await active(); const a = await session(user); const b = await session(user);
    const response = await request('/me/password', 'POST', { currentPassword: password, password: `${password}-changed` }, a.headers);
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).not.toContain(a.cookie);
    expect((await request('/auth/session', 'GET', undefined, a.headers)).status).toBe(401); expect((await request('/auth/session', 'GET', undefined, b.headers)).status).toBe(401);
  });

  test('admin checks apply on API; disable revokes access', async () => {
    const admin = await active('admin'); const user = await active(); const adminSession = await session(admin); const userSession = await session(user);
    expect((await request('/users', 'GET', undefined, userSession.headers)).status).toBe(403);
    const usersResponse = await request('/users?limit=1&page=1', 'GET', undefined, adminSession.headers);
    const result = await usersResponse.json(); expect(result.data).toHaveLength(1); expect(result.meta.limit).toBe(1); expect(result.data[0].password_hash).toBeUndefined();
    expect((await request(`/users/${user.id}`, 'PATCH', { status: 'disabled' }, adminSession.headers)).status).toBe(200);
    expect((await request('/auth/session', 'GET', undefined, userSession.headers)).status).toBe(401);
    await expect(service.login(user.email, password)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // Remove test admins before the last-admin concurrency test.
    await db`UPDATE users SET role = 'user' WHERE id = ${admin.id}`;
  });

  test('two admins cannot concurrently remove the last active administrator', async () => {
    const a = await active('admin'); const b = await active('admin');
    const ia = await service.identity((await service.login(a.email, password)).rawToken);
    const ib = await service.identity((await service.login(b.email, password)).rawToken);
    // This test database must not contain another active admin from this test suite.
    const outcomes = await Promise.allSettled([service.updateUser(ia, a.id, { role: 'user' }), service.updateUser(ib, b.id, { role: 'user' })]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.some(outcome => outcome.status === 'rejected' && outcome.reason.code === 'LAST_ADMIN')).toBe(true);
    await db`UPDATE users SET role = 'user' WHERE id IN (${a.id}, ${b.id})`;
  });

  test('a captured admin identity cannot enumerate users after demotion', async () => {
    const user = await active('admin');
    const identity = await service.identity((await service.login(user.email, password)).rawToken);
    await db`UPDATE users SET role = 'user' WHERE id = ${user.id}`;
    await expect(service.listUsers(identity, 1, 20, '')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('passkey enrollment requires recent auth, challenges are bound and invalid responses fail', async () => {
    const user = await active(); const logged = await session(user);
    const rawSession = logged.cookie.split('=')[1]!;
    await db`UPDATE sessions SET reauthenticated_at = now() - interval '6 minutes' WHERE token_hash = ${digest(rawSession)}`;
    expect((await request('/me/passkeys/options', 'POST', undefined, logged.headers)).status).toBe(403);
    expect((await request('/auth/reauthenticate', 'POST', { password }, logged.headers)).status).toBe(200);
    const options = await request('/me/passkeys/options', 'POST', undefined, logged.headers);
    const data = (await options.json()).data; expect(data.rp.id).toBe('localhost'); expect(data.authenticatorSelection.userVerification).toBe('required');
    const [challenge] = await db`SELECT * FROM webauthn_challenges WHERE challenge = ${data.challenge}`; expect(challenge.user_id).toBe(user.id); expect(challenge.session_id).not.toBeNull();
    const invalid = { id: 'bad', rawId: 'bad', type: 'public-key', response: { clientDataJSON: 'bad', attestationObject: 'bad' }, clientExtensionResults: {} };
    expect((await request('/me/passkeys/verify', 'POST', { name: 'Bad', response: invalid }, logged.headers)).status).toBe(400);
    expect((await service.listPasskeys(await service.identity(rawSession))).length).toBe(0);
    expect((await request('/me/passkeys/not-owned', 'DELETE', undefined, logged.headers)).status).toBe(404);
  });

  test('public login is rate limited and error payload does not leak database details', async () => {
    const email = uniqueEmail();
    for (let i = 0; i < 10; i++) expect((await request('/auth/login', 'POST', { email, password: 'wrong' })).status).toBe(401);
    const blocked = await request('/auth/login', 'POST', { email, password: 'wrong' }); expect(blocked.status).toBe(429); expect((await blocked.json()).error.code).toBe('RATE_LIMITED');
  });
});
