import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService, provideApiConfiguration } from '@sdk';
import { type Observable, firstValueFrom, throwError, toArray } from 'rxjs';
import { inject } from 'vitest';
import { appConfig } from '../../app.config';
import {
  AuthApi,
  type RevokeResult,
  type SessionResult,
  type SessionsResult,
  type SignInResult,
  type SignOutResult,
} from './auth-api';

// AUTH-011 (spec 0014, AC-11): AuthApi over the generated SDK, wired through appConfig, per the adapter contract of
// spec 0009 and table *Pemetaan adapter*. The request shape and every row of the table use HttpTestingController;
// `session()` and `sessions()` also run against the real backend that vitest-backend.setup.ts starts once per run
// without DATABASE_URL (spec 0009 harness, environment unchanged): its GET routes check no origin and answer 503
// without a pool, so both become `unavailable`.
const backendUrl = inject('sdkContractBackendUrl');
const closedUrl = inject('sdkContractClosedUrl');

const CSRF = 'Abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
const SESSION_ID = '0b6f8f9c-3c1d-4c5e-9a7b-2d4e6f8a0b1c';
const OTHER_ID = '1c7a9e0d-4d2e-4f6a-8b9c-3e5f7a9b1c2d';
const created = '2026-10-06T08:00:00.000Z';
const seen = '2026-10-06T08:05:00.000Z';

const authSession = {
  user: { id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', email: 'ana@foundation.test', displayName: 'Ana Uji' },
  session: { id: SESSION_ID, createdAt: created, lastSeenAt: seen, idleExpiresAt: '2026-10-06T08:35:00.000Z', expiresAt: '2026-10-06T20:00:00.000Z' },
  csrfToken: CSRF,
};
const sessionList = {
  sessions: [
    { id: SESSION_ID, createdAt: created, lastSeenAt: seen, current: true },
    { id: OTHER_ID, createdAt: created, lastSeenAt: created, current: false },
  ],
};

function useTesting(): void {
  TestBed.configureTestingModule({ providers: [...appConfig.providers, provideHttpClientTesting()] });
}

/** Subscribes, lets the test answer the one request, and returns what was emitted, and whether it completed or errored. */
function run<T>(source: Observable<T>, answer: (request: TestRequest) => void): { emitted: T[]; completed: boolean; errored: boolean } {
  const outcome = { emitted: [] as T[], completed: false, errored: false };
  source.subscribe({ next: (value) => outcome.emitted.push(value), error: () => (outcome.errored = true), complete: () => (outcome.completed = true) });
  const requests = TestBed.inject(HttpTestingController).match(() => true);
  expect(requests).toHaveLength(1);
  answer(requests[0]!);
  return outcome;
}

const flush = (status: number, body: unknown = null, headers?: Record<string, string>) => (request: TestRequest) =>
  request.flush(body as never, { status, statusText: 'Fixture', headers });
const networkError = (request: TestRequest) => request.error(new ProgressEvent('error'));

describe('AUTH-011 request shape of every AuthApi method with the application config', () => {
  beforeEach(useTesting);
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('signIn is cold, then sends one POST /api/auth/session with the JSON body and no credentials flag or Authorization', () => {
    const httpTesting = TestBed.inject(HttpTestingController);
    const call = TestBed.inject(AuthApi).signIn('ana@foundation.test', 'Pw-correct-horse-battery');
    expect(httpTesting.match(() => true)).toHaveLength(0);
    const { emitted } = run(call, (request) => {
      expect(request.request.method).toBe('POST');
      expect(request.request.urlWithParams).toBe('/api/auth/session');
      expect(request.request.body).toStrictEqual({ email: 'ana@foundation.test', password: 'Pw-correct-horse-battery' });
      expect(request.request.headers.get('Content-Type')).toBe('application/json');
      expect(request.request.headers.get('Accept')).toBe('application/json');
      expect(request.request.headers.has('Authorization')).toBe(false);
      expect(request.request.headers.has('x-csrf-token')).toBe(false);
      expect(request.request.withCredentials).toBe(false);
      request.flush(authSession);
    });
    expect(emitted).toStrictEqual([{ status: 'signed-in', session: authSession }]);
  });

  it('session and sessions send one GET each, without query, body, or CSRF header', () => {
    const api = TestBed.inject(AuthApi);
    for (const [source, path, body] of [[api.session(), '/api/auth/session', authSession], [api.sessions(), '/api/auth/sessions', sessionList]] as const) {
      run<unknown>(source, (request) => {
        expect(request.request.method).toBe('GET');
        expect(request.request.urlWithParams).toBe(path);
        expect(request.request.params.keys()).toEqual([]);
        expect(request.request.body).toBeNull();
        expect(request.request.headers.has('x-csrf-token')).toBe(false);
        expect(request.request.withCredentials).toBe(false);
        request.flush(body);
      });
    }
  });

  it('signOut sends one DELETE /api/auth/session with x-csrf-token and no body', () => {
    const { emitted } = run(TestBed.inject(AuthApi).signOut(CSRF), (request) => {
      expect(request.request.method).toBe('DELETE');
      expect(request.request.urlWithParams).toBe('/api/auth/session');
      expect(request.request.headers.get('x-csrf-token')).toBe(CSRF);
      expect(request.request.body).toBeNull();
      expect(request.request.withCredentials).toBe(false);
      request.flush(null, { status: 204, statusText: 'No Content' });
    });
    expect(emitted).toStrictEqual([{ status: 'signed-out' }]);
  });

  it('revoke sends one DELETE /api/auth/sessions/<id> with x-csrf-token and no body', () => {
    const { emitted } = run(TestBed.inject(AuthApi).revoke(OTHER_ID, CSRF), (request) => {
      expect(request.request.method).toBe('DELETE');
      expect(request.request.urlWithParams).toBe(`/api/auth/sessions/${OTHER_ID}`);
      expect(request.request.headers.get('x-csrf-token')).toBe(CSRF);
      expect(request.request.body).toBeNull();
      request.flush(null, { status: 204, statusText: 'No Content' });
    });
    expect(emitted).toStrictEqual([{ status: 'revoked' }]);
  });
});

interface Row<T> {
  name: string;
  answer: (request: TestRequest) => void;
  expected: T;
}

const errorBody = (error: string) => ({ error });
const textBody = { 'Content-Type': 'text/plain' };

/** Rows shared by every method: the proxy's 502 and 504 and status 0 are `network`; other undeclared statuses `failed`. */
function commonRows<T>(network: T, failed: T): Row<T>[] {
  return [
    { name: 'status 0', answer: networkError, expected: network },
    { name: '502 with an empty text body', answer: flush(502, '', textBody), expected: network },
    { name: '504', answer: flush(504), expected: network },
    { name: '500', answer: flush(500, errorBody('Internal server error')), expected: failed },
    { name: '400', answer: flush(400, errorBody('Invalid request')), expected: failed },
    { name: '413 from Bun or the edge', answer: flush(413, '', textBody), expected: failed },
  ];
}

const signInRows: Row<SignInResult>[] = [
  { name: '200 with an AuthSession', answer: flush(200, authSession), expected: { status: 'signed-in', session: authSession } },
  { name: '200 without csrfToken', answer: flush(200, { user: authSession.user, session: authSession.session }), expected: { status: 'failed' } },
  { name: '200 with a malformed csrfToken', answer: flush(200, { ...authSession, csrfToken: 'short' }), expected: { status: 'failed' } },
  { name: '200 with a session time that is no date', answer: flush(200, { ...authSession, session: { ...authSession.session, expiresAt: 'later' } }), expected: { status: 'failed' } },
  { name: '200 with a null body', answer: flush(200, null), expected: { status: 'failed' } },
  { name: '401', answer: flush(401, errorBody('Invalid credentials')), expected: { status: 'invalid' } },
  { name: '429', answer: flush(429, errorBody('Too many requests')), expected: { status: 'limited' } },
  { name: '403', answer: flush(403, errorBody('Forbidden')), expected: { status: 'forbidden' } },
  { name: '503', answer: flush(503, errorBody('Service unavailable')), expected: { status: 'unavailable' } },
  { name: '415', answer: flush(415, errorBody('Unsupported media type')), expected: { status: 'failed' } },
  { name: '404', answer: flush(404, errorBody('Not found')), expected: { status: 'failed' } },
  ...commonRows<SignInResult>({ status: 'network' }, { status: 'failed' }),
];

const sessionRows: Row<SessionResult>[] = [
  { name: '200 with an AuthSession', answer: flush(200, authSession), expected: { status: 'signed-in', session: authSession } },
  { name: '200 with a user without displayName', answer: flush(200, { ...authSession, user: { id: authSession.user.id, email: authSession.user.email } }), expected: { status: 'failed' } },
  { name: '200 with an array body', answer: flush(200, [authSession]), expected: { status: 'failed' } },
  { name: '401', answer: flush(401, errorBody('Unauthorized')), expected: { status: 'unauthenticated' } },
  { name: '503', answer: flush(503, errorBody('Service unavailable')), expected: { status: 'unavailable' } },
  { name: '403', answer: flush(403, errorBody('Forbidden')), expected: { status: 'failed' } },
  { name: '429', answer: flush(429, errorBody('Too many requests')), expected: { status: 'failed' } },
  ...commonRows<SessionResult>({ status: 'network' }, { status: 'failed' }),
];

const sessionsRows: Row<SessionsResult>[] = [
  { name: '200 with a list', answer: flush(200, sessionList), expected: { status: 'listed', sessions: sessionList.sessions } },
  { name: '200 with an empty list', answer: flush(200, { sessions: [] }), expected: { status: 'listed', sessions: [] } },
  { name: '200 with an item whose current is a string', answer: flush(200, { sessions: [{ ...sessionList.sessions[0], current: 'true' }] }), expected: { status: 'failed' } },
  { name: '200 without sessions', answer: flush(200, {}), expected: { status: 'failed' } },
  { name: '401', answer: flush(401, errorBody('Unauthorized')), expected: { status: 'unauthenticated' } },
  { name: '503', answer: flush(503, errorBody('Service unavailable')), expected: { status: 'unavailable' } },
  { name: '403', answer: flush(403, errorBody('Forbidden')), expected: { status: 'failed' } },
  ...commonRows<SessionsResult>({ status: 'network' }, { status: 'failed' }),
];

const signOutRows: Row<SignOutResult>[] = [
  { name: '204', answer: flush(204), expected: { status: 'signed-out' } },
  { name: '200 instead of 204', answer: flush(200, {}), expected: { status: 'failed' } },
  { name: '403', answer: flush(403, errorBody('Forbidden')), expected: { status: 'forbidden' } },
  { name: '503', answer: flush(503, errorBody('Service unavailable')), expected: { status: 'unavailable' } },
  { name: '401', answer: flush(401, errorBody('Unauthorized')), expected: { status: 'failed' } },
  { name: '404', answer: flush(404, errorBody('Not found')), expected: { status: 'failed' } },
  ...commonRows<SignOutResult>({ status: 'network' }, { status: 'failed' }),
];

const revokeRows: Row<RevokeResult>[] = [
  { name: '204', answer: flush(204), expected: { status: 'revoked' } },
  { name: '200 instead of 204', answer: flush(200, {}), expected: { status: 'failed' } },
  { name: '401', answer: flush(401, errorBody('Unauthorized')), expected: { status: 'unauthenticated' } },
  { name: '404', answer: flush(404, errorBody('Not found')), expected: { status: 'not-found' } },
  { name: '403', answer: flush(403, errorBody('Forbidden')), expected: { status: 'forbidden' } },
  { name: '503', answer: flush(503, errorBody('Service unavailable')), expected: { status: 'unavailable' } },
  { name: '429', answer: flush(429, errorBody('Too many requests')), expected: { status: 'failed' } },
  ...commonRows<RevokeResult>({ status: 'network' }, { status: 'failed' }),
];

const tables: [string, (api: AuthApi) => Observable<unknown>, Row<unknown>[]][] = [
  ['signIn', (api) => api.signIn('ana@foundation.test', 'Pw-correct-horse-battery'), signInRows],
  ['session', (api) => api.session(), sessionRows],
  ['sessions', (api) => api.sessions(), sessionsRows],
  ['signOut', (api) => api.signOut(CSRF), signOutRows],
  ['revoke', (api) => api.revoke(OTHER_ID, CSRF), revokeRows],
];

for (const [method, call, rows] of tables) {
  describe(`AUTH-011 ${method} mapping table`, () => {
    beforeEach(useTesting);
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    for (const row of rows) {
      it(`maps ${row.name} to ${(row.expected as { status: string }).status} and completes without error`, () => {
        const outcome = run(call(TestBed.inject(AuthApi)), row.answer);
        expect(outcome.errored).toBe(false);
        expect(outcome.completed).toBe(true);
        expect(outcome.emitted).toStrictEqual([row.expected]);
      });
    }
  });
}

describe('AUTH-011 a 200 body is rebuilt, never passed through', () => {
  beforeEach(useTesting);
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('drops fields outside the model from AuthSession and from each listed session', () => {
    const api = TestBed.inject(AuthApi);
    const extra = { ...authSession, token: 'leak', user: { ...authSession.user, role: 'admin' }, session: { ...authSession.session, tokenHash: 'leak' } };
    const signedIn = run(api.signIn('ana@foundation.test', 'x'), flush(200, extra)).emitted[0] as Extract<SignInResult, { status: 'signed-in' }>;
    expect(signedIn).toStrictEqual({ status: 'signed-in', session: authSession });
    expect(signedIn.session).not.toBe(extra);
    const listed = run(api.sessions(), flush(200, { sessions: [{ ...sessionList.sessions[0], userId: 'x' }], total: 1 })).emitted[0];
    expect(listed).toStrictEqual({ status: 'listed', sessions: [sessionList.sessions[0]] });
  });

  it('each subscription sends a new request and a failure leaves no state behind', () => {
    const api = TestBed.inject(AuthApi);
    const httpTesting = TestBed.inject(HttpTestingController);
    const session = api.session();
    const results: SessionResult[] = [];
    session.subscribe((result) => results.push(result));
    session.subscribe((result) => results.push(result));
    const requests = httpTesting.match('/api/auth/session');
    expect(requests).toHaveLength(2);
    requests[0]!.flush(errorBody('Unauthorized'), { status: 401, statusText: 'Fixture' });
    requests[1]!.flush(authSession);
    expect(results).toStrictEqual([{ status: 'unauthenticated' }, { status: 'signed-in', session: authSession }]);
  });

  it('cancels the running request when the subscriber unsubscribes', () => {
    const results: SignOutResult[] = [];
    const subscription = TestBed.inject(AuthApi).signOut(CSRF).subscribe((result) => results.push(result));
    const request = TestBed.inject(HttpTestingController).expectOne('/api/auth/session');
    subscription.unsubscribe();
    expect(request.cancelled).toBe(true);
    expect(results).toEqual([]);
  });
});

describe('AUTH-011 an error that is not HttpErrorResponse maps to failed for every method', () => {
  it('maps it to failed and completes without error', async () => {
    const failing = () => throwError(() => new TypeError('not http'));
    TestBed.configureTestingModule({
      providers: [
        ...appConfig.providers,
        {
          provide: AuthService,
          useValue: { signIn: failing, getAuthSession: failing, listAuthSessions: failing, signOut$Response: failing, revokeAuthSession$Response: failing },
        },
      ],
    });
    const api = TestBed.inject(AuthApi);
    for (const source of [api.signIn('a', 'b'), api.session(), api.sessions(), api.signOut(CSRF), api.revoke(OTHER_ID, CSRF)] as Observable<unknown>[]) {
      expect(await firstValueFrom(source.pipe(toArray()))).toStrictEqual([{ status: 'failed' }]);
    }
  });
});

describe('AUTH-011 session and sessions against the real backend harness', () => {
  function useBackend(rootUrl: string): void {
    TestBed.configureTestingModule({ providers: [...appConfig.providers, provideApiConfiguration(rootUrl)] });
  }

  it('become unavailable, since the backend without a database answers 503 on the GET routes, which check no origin', async () => {
    useBackend(backendUrl);
    const api = TestBed.inject(AuthApi);
    expect(await firstValueFrom(api.session().pipe(toArray()))).toStrictEqual([{ status: 'unavailable' }]);
    expect(await firstValueFrom(api.sessions().pipe(toArray()))).toStrictEqual([{ status: 'unavailable' }]);
  });

  it('become network when nothing listens on the port', async () => {
    useBackend(closedUrl);
    const api = TestBed.inject(AuthApi);
    expect(await firstValueFrom(api.session().pipe(toArray()))).toStrictEqual([{ status: 'network' }]);
    expect(await firstValueFrom(api.sessions().pipe(toArray()))).toStrictEqual([{ status: 'network' }]);
  });
});
