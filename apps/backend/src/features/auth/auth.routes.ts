import { Elysia } from 'elysia';
import { hashPassword, normalizeEmail, normalizePassword } from '../../../../../libs/server/auth/credentials';
import type { AppOptions } from '../../app';
import { requestTarget, routedPath } from '../../plugins/request-guard';
import { writeRequestLine } from '../../plugins/request-log';
import { allowedOrigins, AUTH_PREFIX, guardRefusal, SESSION_PATH, SESSIONS_PATH } from './auth.guard';
import { accountKeyOf, writeAuthEvent } from './auth.log';
import { SIGN_IN_ATTEMPTS, VERIFY_SLOTS } from './auth.policy';
import {
  endSession,
  findAccount,
  listSessions,
  removeExpiredAttempts,
  reserveAttempt,
  resolveSession,
  revokeSession,
  signInTransaction,
  type AccountRow,
  type SessionRow,
} from './auth.queries';
import { authModels, csrfHeaders, sessionIdParams, type AuthErrorText } from './auth.schema';
import { createVerifySlots } from './auth.slots';
import { attemptKey, csrfMatches, csrfToken, newSessionToken, presentedToken, sessionCookie, tokenHash, type PresentedToken } from './auth.tokens';

// Auth plugin of spec 0014 for both compositions of createApp. Every request under `/api/auth/` first passes one
// `onRequest` guard, the only hook that can answer before Elysia parses a body (probe 2026-10-06 in the rationale). It
// reads only the method, the headers, the request target, and the path Elysia routes on, sets `Cache-Control: no-store`
// for every answer under the prefix (the onError answers of the root carry it too), and answers with a fixed AuthError
// Response for steps 1 to 4 of *Urutan pemeriksaan per request* (auth.guard.ts): an unknown route or a routed path that
// differs from the request target (404), a query or body on GET and DELETE (400), a refused origin on a route that
// changes data (403, event `request_rejected` `origin`), and a media type outside rule *Content-Type* on sign in (415).
// No handler runs for those requests and nothing changes. Steps 5 to 10 run in the normal lifecycle: the route schema
// (5), the pool (6), the sign in work (7) or the session resolution (8), the CSRF token of the DELETE routes (9, event
// `request_rejected` `csrf`), then the action (10). Any database error is 503 without a database message.

const NO_STORE = 'no-store';

/** The one shape of every AuthError body, for the guard, the handlers, and the 204 routes. */
export const authError = (error: AuthErrorText) => ({ error });

const timeText = (value: Date) => value.toISOString();

/** The AuthSession body: identity and session from the database, the CSRF token derived from the cookie token. */
function authSession(user: Pick<AccountRow, 'id' | 'email' | 'displayName'>, session: SessionRow, token: string) {
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    session: {
      id: session.id,
      createdAt: timeText(session.createdAt),
      lastSeenAt: timeText(session.lastSeenAt),
      idleExpiresAt: timeText(session.idleExpiresAt),
      expiresAt: timeText(session.expiresAt),
    },
    csrfToken: csrfToken(token),
  };
}

/** AuthError entry of `detail.responses` for the 204 routes, which have no response map (*Ekspor route 204 dengan galat*). */
const errorResponse = (status: number) => [status, {
  description: `Response for status ${status}`,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthError' } } },
}] as const;

/** `detail.responses` of a 204 route: 204 without content, then each error status with the AuthError reference. */
const noContentResponses = (...errors: number[]) => Object.fromEntries([
  [204, { description: 'Response for status 204' }],
  ...errors.map(errorResponse),
]);

/**
 * The auth routes of one createApp instance. The cookie name and attributes follow `mode`, never the environment; the
 * allowed origins follow `publicOrigin` (Value sourcing *Origin yang diizinkan*). Per instance, and so per backend
 * process, there is one gate of verification slots and one dummy hash for an unknown email: a promise started by the
 * first sign in after the format check and before the slot, awaited by both paths, so neither export nor createApp ever
 * hashes. A failed creation is forgotten, so the next sign in tries again; a created hash is never made again.
 */
export function createAuthRoutes(mode: 'development' | 'production', options: AppOptions) {
  const database = options.database;
  const sink = options.log;
  const cookie = sessionCookie(mode);
  const origins = allowedOrigins(mode, options.publicOrigin);
  const verify = options.auth?.verify ?? ((password: string, hash: string) => Bun.password.verify(password, hash));
  const slot = createVerifySlots(options.auth?.slots ?? VERIFY_SLOTS);
  let dummy: Promise<string> | undefined;
  const dummyHash = () => (dummy ??= hashPassword(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))
    .catch((error: unknown) => {
      dummy = undefined;
      throw error;
    }));
  /** A 204 without a body; the `Set-Cookie` and `Cache-Control` the handler set are merged into it. */
  const noContent = () => new Response(null, { status: 204 });
  /** A 401 removes the cookie when the request sent the session cookie name (AC-7). */
  const clearSent = (presented: PresentedToken, headers: Record<string, unknown>) => {
    if (presented.sent) headers['set-cookie'] = cookie.clear;
  };

  return new Elysia()
    .onRequest(({ request, set }) => {
      // Both paths a route can be dispatched on: the request target (Bun's own router) and the path Elysia routes on
      // when Bun's router did not match. The guard handles a request when either is under the prefix, and step 1
      // refuses it when they differ, so a short or unusual Host can never take a request past the guard to a handler.
      const url = requestTarget(request.url);
      const routed = routedPath(request.url);
      if (!url.pathname.startsWith(AUTH_PREFIX) && !routed.startsWith(AUTH_PREFIX)) return;
      set.headers['cache-control'] = NO_STORE;
      const refusal = guardRefusal(request.method, url, routed, request.headers, origins);
      if (refusal === null) return;
      // The event first: writeRequestLine removes the entry that requestIdFor reads, and both lines share its id.
      if (refusal.origin) writeAuthEvent(sink, request, { action: 'request_rejected', outcome: 'origin' });
      // onAfterResponse never runs for an answer from onRequest, so the guard writes its own request line.
      if (sink !== undefined) writeRequestLine(sink, request, refusal.status);
      return new Response(JSON.stringify(authError(refusal.error)), {
        status: refusal.status, headers: { 'content-type': 'application/json', 'cache-control': NO_STORE },
      });
    })
    .model(authModels)
    .post(SESSION_PATH, async ({ body, request, set, status }) => {
      if (database === undefined) return status(503, authError('Service unavailable'));
      // Step 7 in its order: the format rules before the slot, the attempt, and Argon2id.
      const email = normalizeEmail(body.email);
      const password = normalizePassword(body.password, 'sign-in');
      if (email === null || password === null) return status(400, authError('Invalid request'));
      const key = attemptKey(email);
      const accountKey = accountKeyOf(key);
      let fallback: string;
      try {
        fallback = await dummyHash();
      } catch {
        return status(503, authError('Service unavailable'));
      }
      const release = await slot();
      if (release === null) {
        writeAuthEvent(sink, request, { action: 'sign_in', outcome: 'busy', accountKey });
        return status(503, authError('Service unavailable'));
      }
      let account: AccountRow | undefined;
      let verified: boolean;
      try {
        // The reservation, the cleanup, and the lookup are each one short transaction that ends before the
        // verification, so no connection or transaction is open while Argon2id runs (invariant 10).
        let count: number;
        try {
          count = await reserveAttempt(database, key);
        } catch {
          return status(503, authError('Service unavailable'));
        }
        if (count > SIGN_IN_ATTEMPTS) {
          writeAuthEvent(sink, request, { action: 'sign_in', outcome: 'limited', accountKey });
          return status(429, authError('Too many requests'));
        }
        try {
          await removeExpiredAttempts(database, key);
          account = await findAccount(database, email);
        } catch {
          return status(503, authError('Service unavailable'));
        }
        // Exactly one verification on both paths: the hash of the account or the dummy hash.
        verified = await verify(password, account?.passwordHash ?? fallback);
      } finally {
        release();
      }
      if (account === undefined || !verified) {
        writeAuthEvent(sink, request, { action: 'sign_in', outcome: 'failed', accountKey });
        return status(401, authError('Invalid credentials'));
      }
      // A valid cookie of whoever is revoked as `replaced` (rotation at sign in); the new token is always new
      // (invariant 4), never one the client sent.
      const presented = presentedToken(request.headers.get('cookie'), cookie.name);
      const token = newSessionToken();
      let session: SessionRow | 'credential_changed';
      try {
        session = await signInTransaction(database, {
          userId: account.id,
          verifiedHash: account.passwordHash,
          tokenHash: tokenHash(token),
          presentedHash: presented.token === null ? null : tokenHash(presented.token),
          attemptKey: key,
        });
      } catch {
        return status(503, authError('Service unavailable'));
      }
      // The operator replaced the password between the verification and the transaction: no session.
      if (session === 'credential_changed') {
        writeAuthEvent(sink, request, { action: 'sign_in', outcome: 'failed', accountKey });
        return status(401, authError('Invalid credentials'));
      }
      writeAuthEvent(sink, request, { action: 'sign_in', outcome: 'succeeded', userId: account.id, sessionId: session.id, accountKey });
      set.headers['set-cookie'] = cookie.set(token);
      return authSession(account, session, token);
    }, {
      parse: 'json',
      body: 'SignInRequest',
      response: {
        200: 'AuthSession', 400: 'AuthError', 401: 'AuthError', 403: 'AuthError', 415: 'AuthError',
        429: 'AuthError', 500: 'AuthError', 503: 'AuthError',
      },
      detail: { operationId: 'signIn', tags: ['auth'], security: [], summary: 'Sign in with email and password' },
    })
    .get(SESSION_PATH, async ({ request, set, status }) => {
      if (database === undefined) return status(503, authError('Service unavailable'));
      const presented = presentedToken(request.headers.get('cookie'), cookie.name);
      const unauthorized = () => {
        clearSent(presented, set.headers);
        return status(401, authError('Unauthorized'));
      };
      if (presented.token === null) return unauthorized();
      let active;
      try {
        active = await resolveSession(database, tokenHash(presented.token));
      } catch {
        return status(503, authError('Service unavailable'));
      }
      if (active === undefined) return unauthorized();
      return authSession(active.user, active.session, presented.token);
    }, {
      response: { 200: 'AuthSession', 400: 'AuthError', 401: 'AuthError', 500: 'AuthError', 503: 'AuthError' },
      detail: { operationId: 'getAuthSession', tags: ['auth'], security: [{ sessionCookie: [] }], summary: 'Identity and session of the caller' },
    })
    .delete(SESSION_PATH, async ({ headers, request, set, status }) => {
      if (database === undefined) return status(503, authError('Service unavailable'));
      const presented = presentedToken(request.headers.get('cookie'), cookie.name);
      // Without a valid session the answer is still 204 with the cookie removed, and nothing changes.
      if (presented.token !== null) {
        let ended;
        try {
          ended = await endSession(database, tokenHash(presented.token), csrfMatches(presented.token, headers['x-csrf-token']));
        } catch {
          return status(503, authError('Service unavailable'));
        }
        if (ended.outcome === 'forbidden') {
          writeAuthEvent(sink, request, { action: 'request_rejected', outcome: 'csrf' });
          return status(403, authError('Forbidden'));
        }
        if (ended.outcome === 'ended') {
          writeAuthEvent(sink, request, { action: 'sign_out', outcome: 'succeeded', userId: ended.userId, sessionId: ended.sessionId });
        }
      }
      set.headers['set-cookie'] = cookie.clear;
      return noContent();
    }, {
      headers: csrfHeaders,
      detail: {
        operationId: 'signOut', tags: ['auth'], security: [{ sessionCookie: [] }], summary: 'End the session of the caller',
        responses: noContentResponses(400, 403, 500, 503),
      },
    })
    .get(SESSIONS_PATH, async ({ request, set, status }) => {
      if (database === undefined) return status(503, authError('Service unavailable'));
      const presented = presentedToken(request.headers.get('cookie'), cookie.name);
      const unauthorized = () => {
        clearSent(presented, set.headers);
        return status(401, authError('Unauthorized'));
      };
      if (presented.token === null) return unauthorized();
      let sessions;
      try {
        sessions = await listSessions(database, tokenHash(presented.token));
      } catch {
        return status(503, authError('Service unavailable'));
      }
      if (sessions === undefined) return unauthorized();
      return {
        sessions: sessions.map((session) => ({
          id: session.id, createdAt: timeText(session.createdAt), lastSeenAt: timeText(session.lastSeenAt), current: session.current,
        })),
      };
    }, {
      response: { 200: 'AuthSessionList', 400: 'AuthError', 401: 'AuthError', 500: 'AuthError', 503: 'AuthError' },
      detail: { operationId: 'listAuthSessions', tags: ['auth'], security: [{ sessionCookie: [] }], summary: 'Active sessions of the caller' },
    })
    .delete(`${SESSIONS_PATH}/:sessionId`, async ({ headers, params, request, set, status }) => {
      if (database === undefined) return status(503, authError('Service unavailable'));
      const presented = presentedToken(request.headers.get('cookie'), cookie.name);
      const unauthorized = () => {
        clearSent(presented, set.headers);
        return status(401, authError('Unauthorized'));
      };
      if (presented.token === null) return unauthorized();
      let revoked;
      try {
        revoked = await revokeSession(database, tokenHash(presented.token), csrfMatches(presented.token, headers['x-csrf-token']), params.sessionId);
      } catch {
        return status(503, authError('Service unavailable'));
      }
      switch (revoked.outcome) {
        case 'unauthenticated': return unauthorized();
        case 'forbidden':
          writeAuthEvent(sink, request, { action: 'request_rejected', outcome: 'csrf' });
          return status(403, authError('Forbidden'));
        case 'not_found':
          writeAuthEvent(sink, request, { action: 'session_revoke', outcome: 'not_found', userId: revoked.userId });
          return status(404, authError('Not found'));
        case 'revoked_current':
        case 'revoked':
          writeAuthEvent(sink, request, { action: 'session_revoke', outcome: 'succeeded', userId: revoked.userId, sessionId: params.sessionId });
          if (revoked.outcome === 'revoked_current') set.headers['set-cookie'] = cookie.clear;
          return noContent();
      }
    }, {
      params: sessionIdParams,
      headers: csrfHeaders,
      detail: {
        operationId: 'revokeAuthSession', tags: ['auth'], security: [{ sessionCookie: [] }], summary: 'End one active session of the caller',
        responses: noContentResponses(400, 401, 403, 404, 500, 503),
      },
    });
}
