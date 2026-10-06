import type { SQL } from 'bun';
import { Elysia } from 'elysia';
import { openapi } from '@elysia/openapi';
import { createAuthRoutes } from './features/auth/auth.routes';
import { developmentRoutes } from './features/development/status.routes';
import { createReadinessRoutes } from './features/development/readiness.routes';
import { createHealthRoutes } from './features/health/health.routes';
import { createRequestLog, type RequestLogSink } from './plugins/request-log';

export interface AppOptions {
  /** Backend pool from index.ts; createApp never creates one. */
  database?: SQL;
  /** JSON request log of spec 0012; index.ts gives it only for NODE_ENV=production, so development stays silent. */
  log?: RequestLogSink;
  /** Origin publik dari index.ts (PUBLIC_ORIGIN). */
  publicOrigin?: string;
  /** Hanya test: tidak pernah dibaca dari environment dan tidak pernah diberikan index.ts. */
  auth?: { verify?: (password: string, hash: string) => Promise<boolean>; slots?: { running: number; queue: number; waitMs: number } };
}

/** Security scheme of spec 0014 (table *Model kontrak*); the cookie itself is read from the `cookie` request header. */
const sessionCookie = {
  type: 'apiKey', in: 'cookie', name: '__Host-foundation_session',
  description: 'Cookie sesi HttpOnly. Komposisi development memakai nama foundation_session tanpa Secure karena berjalan di HTTP lokal.',
} as const;

/**
 * Both compositions carry the auth routes of spec 0014 and the health routes of spec 0012. Production carries nothing
 * else: no OpenAPI plugin and no development route, so every other path answers 404. The request log plugin is
 * registered only when `log` is given, and before every route, so it covers all of them; the auth plugin comes after
 * it and before health. onError stays registered before the auth plugin, so a validation answer never echoes the body.
 * The final text keeps the shape of spec 0014 (*Teks akhir `createApp`*) so the text replacements of SDK-005 apply.
 */
export function createApp(mode: 'development' | 'production', options: AppOptions = {}) {
  const app = new Elysia().onError(({ code, set }) => {
    set.status = code === 'NOT_FOUND' ? 404 : code === 'VALIDATION' || code === 'PARSE' ? 400 : 500;
    return { error: set.status === 404 ? 'Not found' : set.status === 400 ? 'Invalid request' : 'Internal server error' };
  });
  if (options.log !== undefined) app.use(createRequestLog(options.log));
  const healthRoutes = createHealthRoutes(options.database);
  const authRoutes = createAuthRoutes(mode, options);
  if (mode === 'production') return app.use(authRoutes).use(healthRoutes);
  return app.use(openapi({
    provider: null, openapiVersion: '3.1.0',
    documentation: { info: { title: 'Foundation development API', version: '0.1.0' }, tags: [{ name: 'auth' }, { name: 'development' }, { name: 'health' }], security: [], components: { securitySchemes: { sessionCookie } } },
  })).use(createReadinessRoutes(options.database)).use(developmentRoutes).use(authRoutes).use(healthRoutes);
}
