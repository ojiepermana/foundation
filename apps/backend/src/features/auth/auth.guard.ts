import type { AuthErrorText } from './auth.schema';

// Steps 1 to 4 of *Urutan pemeriksaan per request* (spec 0014) as pure functions of the method, the request target, the
// path Elysia routes on, and the headers, for the `onRequest` guard of the auth plugin: the only hook that answers before
// Elysia parses a body (probe 2026-10-06). Nothing here reads a body, decodes the path, or awaits, so a refused request
// never reaches a handler and never changes data.

export const AUTH_PREFIX = '/api/auth/';
export const SESSION_PATH = '/api/auth/session';
export const SESSIONS_PATH = '/api/auth/sessions';

/** Origins the development composition allows when index.ts gives no `publicOrigin` (table *Konfigurasi*). */
export const DEVELOPMENT_ORIGINS: readonly string[] = Object.freeze(['http://127.0.0.1:8889', 'http://localhost:8889']);

const NO_ORIGINS: readonly string[] = Object.freeze([]);

/**
 * Value sourcing *Origin yang diizinkan*: exactly the `publicOrigin` that index.ts read from PUBLIC_ORIGIN when it is
 * given; without it the development composition allows its two fixed origins and production allows none, so production
 * without the option refuses every request that changes data.
 */
export function allowedOrigins(mode: 'development' | 'production', publicOrigin: string | undefined): readonly string[] {
  if (publicOrigin !== undefined) return Object.freeze([publicOrigin]);
  return mode === 'development' ? DEVELOPMENT_ORIGINS : NO_ORIGINS;
}

/**
 * Step 1: exactly one of the five routes, without a trailing slash. `DELETE /api/auth/sessions/<segment>` takes one
 * non empty segment without `/`; its UUID pattern is checked by the route schema (step 5). HEAD is never a route.
 */
export function knownRoute(method: string, path: string): boolean {
  if (path === SESSION_PATH) return method === 'POST' || method === 'GET' || method === 'DELETE';
  if (path === SESSIONS_PATH) return method === 'GET';
  if (method !== 'DELETE' || !path.startsWith(`${SESSIONS_PATH}/`)) return false;
  const segment = path.slice(SESSIONS_PATH.length + 1);
  return segment !== '' && !segment.includes('/');
}

/** Step 2 (rule `strictGet`): the headers that announce a body. */
const carriesBody = (headers: Headers) => {
  const length = headers.get('content-length');
  return (length !== null && length !== '0') || headers.has('transfer-encoding');
};

/**
 * Step 3, the origin rule of AC-9: an `Origin` header exactly equal to one allowed origin, and `Sec-Fetch-Site`, when
 * the header is there, exactly `same-origin`. A missing Origin, `null`, another origin, or a repeated header (which
 * arrives joined with `, `) is refused; so is a cross site HTML form, whatever its media type.
 */
export function originAllowed(headers: Headers, origins: readonly string[]): boolean {
  const origin = headers.get('origin');
  if (origin === null || !origins.includes(origin)) return false;
  const site = headers.get('sec-fetch-site');
  return site === null || site === 'same-origin';
}

const CHARSET = /^charset=utf-8$/i;
const SPACE = 0x20;

/**
 * `value` without the spaces U+0020 at its start (`start`) or its end (`end`), in linear time. A regex such as `/ +$/`
 * tries again from every space of a long inner run, which is quadratic on a header the client chooses.
 */
function trimSpaces(value: string, start: boolean, end: boolean): string {
  let first = 0;
  let last = value.length;
  if (start) while (first < last && value.charCodeAt(first) === SPACE) first += 1;
  if (end) while (last > first && value.charCodeAt(last - 1) === SPACE) last -= 1;
  return value.slice(first, last);
}

/**
 * Step 4, rule *Content-Type*: after the spaces at both ends are dropped, the media type is `application/json` exactly in
 * lower case, optionally followed by exactly one parameter `charset=utf-8` whose name and value ignore case, with
 * optional spaces around `;`. Elysia 1.4.30 parses only the lower case media type as JSON, so the guard and the parser
 * always agree; the route also parses with `parse: 'json'`. A missing header, upper case, another parameter, or a second
 * one is 415. The case insensitive test uses the `i` flag without `u`, which never folds a non ASCII letter onto ASCII.
 */
export function jsonMediaType(value: string | null): boolean {
  if (value === null) return false;
  const text = trimSpaces(value, true, true);
  const semicolon = text.indexOf(';');
  if (semicolon === -1) return text === 'application/json';
  return trimSpaces(text.slice(0, semicolon), false, true) === 'application/json' && CHARSET.test(trimSpaces(text.slice(semicolon + 1), true, false));
}

/** A refusal of the guard: the status, the AuthError text, and whether step 3 refused it (event `request_rejected`). */
export interface GuardRefusal {
  readonly status: 400 | 403 | 404 | 415;
  readonly error: AuthErrorText;
  readonly origin: boolean;
}

/**
 * Steps 1 to 4 in order, stopping at the first that refuses; `null` lets the request go on to the route schema (step 5).
 * GET is the only method that changes nothing, so every other method that passed step 1 is a route that changes data.
 * `routed` is the path Elysia routes on (`routedPath` of plugins/request-guard.ts); step 1 needs it to equal the
 * pathname of the request target, so the route a handler serves is always the path the guard and the edge read.
 */
export function guardRefusal(method: string, url: URL, routed: string, headers: Headers, origins: readonly string[]): GuardRefusal | null {
  if (routed !== url.pathname || !knownRoute(method, url.pathname)) return { status: 404, error: 'Not found', origin: false };
  if (method !== 'POST' && (url.search !== '' || carriesBody(headers))) return { status: 400, error: 'Invalid request', origin: false };
  if (method !== 'GET' && !originAllowed(headers, origins)) return { status: 403, error: 'Forbidden', origin: true };
  if (method === 'POST' && !jsonMediaType(headers.get('content-type'))) return { status: 415, error: 'Unsupported media type', origin: false };
  return null;
}
