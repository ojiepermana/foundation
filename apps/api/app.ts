import { Elysia, t } from 'elysia';
import { RedisClient, type SQL } from 'bun';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Config } from '../../server/config';
import { AuthService, type IssuedSession } from '../../server/auth';
import { AppError, assert } from '../../server/errors';
import { csrfFor, equal, readCookie } from '../../server/security';
import { RateLimiter } from '../../server/rate-limit';
import { log } from '../../server/logger';

export function createApp(db: SQL, config: Config) {
  const auth = new AuthService(db, config);
  const limiter = new RateLimiter(config.redisUrl, config.redisPrefix);
  const redis = new RedisClient(config.redisUrl, { connectionTimeout: 2000, maxRetries: 1 });
  const sessionCookie = 'foundation_session';
  const setCookie = (set: any, raw: string, seconds = config.sessionSeconds) => {
    set.headers['set-cookie'] = `${sessionCookie}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.appUrl.startsWith('https:') ? '; Secure' : ''}`;
  };
  const issued = (set: any, result: IssuedSession) => { setCookie(set, result.rawToken); return { data: { user: result.user, csrfToken: result.csrfToken } }; };
  const identity = async (request: Request) => {
    const result = await auth.identity(readCookie(request, sessionCookie));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      assert(equal(request.headers.get('x-csrf-token') ?? '', csrfFor(result.rawToken)), 403, 'CSRF_INVALID', 'Permintaan tidak valid. Muat ulang halaman.');
    }
    return result;
  };
  const password = t.String({ minLength: 1, maxLength: 128 });
  const newPassword = t.String({ minLength: 12, maxLength: 128 });
  const email = t.String({ minLength: 3, maxLength: 254 });
  const name = t.String({ minLength: 1, maxLength: 100 });
  const credential = t.Object({ id: t.String({ maxLength: 2048 }), rawId: t.String({ maxLength: 2048 }), response: t.Any(), type: t.Literal('public-key'), clientExtensionResults: t.Record(t.String(), t.Any()), authenticatorAttachment: t.Optional(t.String()) });
  const app = new Elysia({ serve: { maxRequestBodySize: 65_536 } })
    .onRequest(({ set }) => {
      set.headers['x-request-id'] = crypto.randomUUID();
      set.headers['cache-control'] = 'no-store';
      set.headers['x-content-type-options'] = 'nosniff';
      set.headers['referrer-policy'] = 'no-referrer';
    })
    .onBeforeHandle(async ({ request, body, server }) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
      assert(request.headers.get('origin') === config.appUrl, 403, 'ORIGIN_INVALID', 'Origin permintaan tidak diizinkan.');
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/v1/auth/') || path === '/api/v1/me/password' || path.startsWith('/api/v1/me/passkeys')) {
        const peer = server?.requestIP(request)?.address ?? 'local';
        await limiter.hit(`ip:${path}`, peer, 60);
        const payload = body as Record<string, unknown> | null;
        if (typeof payload?.['email'] === 'string') await limiter.hit(`identity:${path}`, payload['email'].trim().toLowerCase(), 10);
      }
    })
    .onError(({ code, error, set }) => {
      const requestId = String(set.headers['x-request-id'] ?? crypto.randomUUID());
      if (error instanceof AppError) {
        set.status = error.status;
        return { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) }, requestId };
      }
      if (code === 'VALIDATION' || code === 'PARSE') {
        set.status = 422;
        return { error: { code: 'VALIDATION', message: 'Data yang dikirim tidak valid. Periksa kembali isian Anda.' }, requestId };
      }
      if (code === 'NOT_FOUND') { set.status = 404; return { error: { code: 'NOT_FOUND', message: 'Halaman API tidak ditemukan.' }, requestId }; }
      if ('errno' in error && error.errno === '23505') { set.status = 409; return { error: { code: 'CONFLICT', message: 'Data sudah terdaftar.' }, requestId }; }
      log('error', 'api.request.failed', { requestId, errorType: error instanceof Error ? error.name : 'UnknownError' });
      set.status = 503;
      return { error: { code: 'SERVICE_UNAVAILABLE', message: 'Layanan sementara tidak tersedia. Coba kembali.' }, requestId };
    })
    .get('/api/health/live', () => ({ data: { status: 'ok' } }))
    .get('/api/health/ready', async ({ set }) => {
      const result = await Promise.allSettled([db`SELECT 1`, redis.send('PING', [])]);
      const ready = result.every(item => item.status === 'fulfilled');
      set.status = ready ? 200 : 503;
      return { data: { status: ready ? 'ready' : 'unavailable' } };
    })
    .post('/api/v1/auth/login', async ({ body, set }) => issued(set, await auth.login(body.email, body.password)), { body: t.Object({ email, password }) })
    .get('/api/v1/auth/session', async ({ request }) => { const result = await identity(request); return { data: { user: result.user, csrfToken: csrfFor(result.rawToken) } }; })
    .post('/api/v1/auth/logout', async ({ request, set }) => { await auth.logout(await identity(request)); setCookie(set, '', 0); return { data: { ok: true } }; })
    .post('/api/v1/auth/activate', async ({ body }) => { await auth.completeAction(body.token, body.password, 'activation'); return { data: { ok: true } }; }, { body: t.Object({ token: t.String({ minLength: 1, maxLength: 128 }), password: newPassword }) })
    .post('/api/v1/auth/forgot-password', async ({ body }) => { await auth.forgotPassword(body.email); return { data: { message: 'Jika akun tersedia, petunjuk pemulihan akan dikirim melalui email.' } }; }, { body: t.Object({ email }) })
    .post('/api/v1/auth/reset-password', async ({ body }) => { await auth.completeAction(body.token, body.password, 'reset'); return { data: { ok: true } }; }, { body: t.Object({ token: t.String({ minLength: 1, maxLength: 128 }), password: newPassword }) })
    .post('/api/v1/auth/reauthenticate', async ({ request, body }) => { await auth.reauthenticate(await identity(request), body.password); return { data: { ok: true } }; }, { body: t.Object({ password }) })
    .patch('/api/v1/me', async ({ request, body }) => ({ data: await auth.updateProfile(await identity(request), body.name) }), { body: t.Object({ name }) })
    .post('/api/v1/me/password', async ({ request, body, set }) => issued(set, await auth.changePassword(await identity(request), body.currentPassword, body.password)), { body: t.Object({ currentPassword: password, password: newPassword }) })
    .get('/api/v1/me/passkeys', async ({ request }) => ({ data: await auth.listPasskeys(await identity(request)) }))
    .post('/api/v1/me/passkeys/options', async ({ request }) => ({ data: await auth.registrationOptions(await identity(request)) }))
    .post('/api/v1/me/passkeys/verify', async ({ request, body }) => { await auth.verifyRegistration(await identity(request), body.response as RegistrationResponseJSON, body.name); return { data: { ok: true } }; }, { body: t.Object({ response: credential, name }) })
    .delete('/api/v1/me/passkeys/:id', async ({ request, params }) => { await auth.removePasskey(await identity(request), params.id); return { data: { ok: true } }; })
    .post('/api/v1/auth/passkey/options', async () => ({ data: await auth.authenticationOptions() }))
    .post('/api/v1/auth/passkey/verify', async ({ body, set }) => issued(set, await auth.verifyAuthentication(body.challengeId, body.response as AuthenticationResponseJSON)), { body: t.Object({ challengeId: t.String({ format: 'uuid' }), response: credential }) })
    .get('/api/v1/users', async ({ request, query }) => auth.listUsers(await identity(request), query.page ?? 1, query.limit ?? 20, query.search ?? ''), { query: t.Object({ page: t.Optional(t.Numeric({ minimum: 1, maximum: 100000, multipleOf: 1 })), limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })), search: t.Optional(t.String({ maxLength: 100 })) }) })
    .patch('/api/v1/users/:id', async ({ request, params, body }) => ({ data: await auth.updateUser(await identity(request), params.id, body) }), { params: t.Object({ id: t.String({ format: 'uuid' }) }), body: t.Object({ name: t.Optional(name), role: t.Optional(t.Union([t.Literal('admin'), t.Literal('user')])), status: t.Optional(t.Union([t.Literal('active'), t.Literal('disabled')])) }) });
  return { app, auth, close: async () => { limiter.close(); redis.close(); } };
}
