import { HttpErrorResponse } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { AuthService, type AuthSession } from '@sdk';
import { type Observable, catchError, map, of } from 'rxjs';

export type { AuthSession } from '@sdk';

/**
 * AuthSession of the SDK with the nested `user` and `session` objects, which the generator types as
 * `Record<string, unknown>`, narrowed after every field was checked (spec 0009, *Kontrak adapter fitur* item 4).
 */
export type CheckedAuthSession = Omit<AuthSession, 'user' | 'session'> & {
  user: { id: string; email: string; displayName: string };
  session: { id: string; createdAt: string; lastSeenAt: string; idleExpiresAt: string; expiresAt: string };
};

/** Results of spec 0014, table *Pemetaan adapter*. */
export type SignInResult =
  | { status: 'signed-in'; session: CheckedAuthSession }
  | { status: 'invalid' | 'limited' | 'forbidden' | 'unavailable' | 'network' | 'failed' };

export type SessionResult =
  | { status: 'signed-in'; session: CheckedAuthSession }
  | { status: 'unauthenticated' | 'unavailable' | 'network' | 'failed' };

/** One active session of the caller, every field checked (the generator types the items as `Record<string, unknown>`). */
export interface ListedSession {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly current: boolean;
}

export type SessionsResult =
  | { status: 'listed'; sessions: readonly ListedSession[] }
  | { status: 'unauthenticated' | 'unavailable' | 'network' | 'failed' };

export type SignOutResult = { status: 'signed-out' | 'forbidden' | 'unavailable' | 'network' | 'failed' };

export type RevokeResult = { status: 'revoked' | 'unauthenticated' | 'not-found' | 'forbidden' | 'unavailable' | 'network' | 'failed' };

type Body = Record<string, unknown>;

const isBody = (value: unknown): value is Body => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A 200 body is never passed through: each field is checked and a new object is built; anything else is `null`. */
function checkedSession(body: unknown): CheckedAuthSession | null {
  if (!isBody(body) || !isBody(body['user']) || !isBody(body['session'])) return null;
  const { id, email, displayName } = body['user'];
  const { id: sessionId, createdAt, lastSeenAt, idleExpiresAt, expiresAt } = body['session'];
  const csrfToken = body['csrfToken'];
  if (!isText(id) || !isText(email) || !isText(displayName) || !isText(sessionId)) return null;
  if (!isTime(createdAt) || !isTime(lastSeenAt) || !isTime(idleExpiresAt) || !isTime(expiresAt)) return null;
  if (!isText(csrfToken) || !CSRF_TOKEN.test(csrfToken)) return null;
  return {
    user: { id, email, displayName },
    session: { id: sessionId, createdAt, lastSeenAt, idleExpiresAt, expiresAt },
    csrfToken,
  };
}

/** A 200 list body: every item checked and rebuilt; one item that does not fit makes the whole body `null`. */
function checkedSessions(body: unknown): ListedSession[] | null {
  if (!isBody(body) || !Array.isArray(body['sessions'])) return null;
  const sessions: ListedSession[] = [];
  for (const item of body['sessions'] as unknown[]) {
    if (!isBody(item)) return null;
    const { id, createdAt, lastSeenAt, current } = item;
    if (!isText(id) || !isTime(createdAt) || !isTime(lastSeenAt) || typeof current !== 'boolean') return null;
    sessions.push({ id, createdAt, lastSeenAt, current });
  }
  return sessions;
}

/** Status 0 and the 502 and 504 of the development proxy (backend not reachable) are network failures. */
const isNetwork = (error: HttpErrorResponse) => error.status === 0 || error.status === 502 || error.status === 504;

function signInFailure(error: unknown): SignInResult {
  if (!(error instanceof HttpErrorResponse)) return { status: 'failed' };
  if (isNetwork(error)) return { status: 'network' };
  switch (error.status) {
    case 401: return { status: 'invalid' };
    case 429: return { status: 'limited' };
    case 403: return { status: 'forbidden' };
    case 503: return { status: 'unavailable' };
    default: return { status: 'failed' };
  }
}

/** Failures of the reads of the caller's session: 401 is `unauthenticated`. */
function readFailure(error: unknown): { status: 'unauthenticated' | 'unavailable' | 'network' | 'failed' } {
  if (!(error instanceof HttpErrorResponse)) return { status: 'failed' };
  if (isNetwork(error)) return { status: 'network' };
  if (error.status === 401) return { status: 'unauthenticated' };
  if (error.status === 503) return { status: 'unavailable' };
  return { status: 'failed' };
}

function signOutFailure(error: unknown): SignOutResult {
  if (!(error instanceof HttpErrorResponse)) return { status: 'failed' };
  if (isNetwork(error)) return { status: 'network' };
  if (error.status === 403) return { status: 'forbidden' };
  if (error.status === 503) return { status: 'unavailable' };
  return { status: 'failed' };
}

function revokeFailure(error: unknown): RevokeResult {
  if (!(error instanceof HttpErrorResponse)) return { status: 'failed' };
  if (isNetwork(error)) return { status: 'network' };
  switch (error.status) {
    case 401: return { status: 'unauthenticated' };
    case 404: return { status: 'not-found' };
    case 403: return { status: 'forbidden' };
    case 503: return { status: 'unavailable' };
    default: return { status: 'failed' };
  }
}

/** A 204 answer of the two DELETE routes; any other success status is not part of the contract. */
const isNoContent = (response: { status: number }) => response.status === 204;

/** Feature adapter over the generated SDK (spec 0009, *Kontrak adapter fitur*); it holds no state. */
@Service()
export class AuthApi {
  private readonly auth = inject(AuthService);

  /** Cold: one POST /api/auth/session per subscription. Never errors; every outcome becomes a SignInResult. */
  signIn(email: string, password: string): Observable<SignInResult> {
    return this.auth.signIn({ body: { email, password } }).pipe(
      map((body): SignInResult => {
        const session = checkedSession(body);
        return session === null ? { status: 'failed' } : { status: 'signed-in', session };
      }),
      catchError((error: unknown) => of(signInFailure(error))),
    );
  }

  /** Cold: one GET /api/auth/session per subscription. Never errors; every outcome becomes a SessionResult. */
  session(): Observable<SessionResult> {
    return this.auth.getAuthSession().pipe(
      map((body): SessionResult => {
        const session = checkedSession(body);
        return session === null ? { status: 'failed' } : { status: 'signed-in', session };
      }),
      catchError((error: unknown) => of(readFailure(error))),
    );
  }

  /** Cold: one GET /api/auth/sessions per subscription. Never errors; every outcome becomes a SessionsResult. */
  sessions(): Observable<SessionsResult> {
    return this.auth.listAuthSessions().pipe(
      map((body): SessionsResult => {
        const sessions = checkedSessions(body);
        return sessions === null ? { status: 'failed' } : { status: 'listed', sessions };
      }),
      catchError((error: unknown) => of(readFailure(error))),
    );
  }

  /** Cold: one DELETE /api/auth/session with the CSRF token per subscription. Never errors. */
  signOut(csrfToken: string): Observable<SignOutResult> {
    return this.auth.signOut$Response({ 'x-csrf-token': csrfToken }).pipe(
      map((response): SignOutResult => (isNoContent(response) ? { status: 'signed-out' } : { status: 'failed' })),
      catchError((error: unknown) => of(signOutFailure(error))),
    );
  }

  /** Cold: one DELETE /api/auth/sessions/{sessionId} with the CSRF token per subscription. Never errors. */
  revoke(sessionId: string, csrfToken: string): Observable<RevokeResult> {
    return this.auth.revokeAuthSession$Response({ sessionId, 'x-csrf-token': csrfToken }).pipe(
      map((response): RevokeResult => (isNoContent(response) ? { status: 'revoked' } : { status: 'failed' })),
      catchError((error: unknown) => of(revokeFailure(error))),
    );
  }
}
