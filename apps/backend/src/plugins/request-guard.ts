// Strict GET guard shared by the readiness route of spec 0006 and the health routes of spec 0012. Moved out of
// readiness.routes.ts: the order and the answers stay those of spec 0006 (*Urutan penjaga route readiness*), and since
// requestTarget they hold for every Host value, also one that `new URL` refuses (it used to answer 500).

/** `Cache-Control` of every answer a guarded handler gives. */
export const NO_STORE = 'no-store';

/** Fixed origin that requestTarget puts in front of the request target. */
const URL_BASE = 'http://localhost';
/** The leading `scheme://authority` of an absolute `request.url`; the authority is the client Host value. */
const URL_AUTHORITY = /^[a-z][a-z\d+.-]*:\/\/[^/\\?#]*/i;
/** Text that already starts as a path, a query, or a fragment, so nothing after the base can extend its authority. */
const PATH_START = /^(?:[/\\?#]|$)/;
const NOT_FOUND_BODY = JSON.stringify({ error: 'Not found' });

/**
 * The request target of `request.url` as a URL whose pathname and search are the only parts to read. Bun 1.4.2 writes
 * `request.url` as `http://<Host header><target>`, or as the bare target (for example `/api/readiness`, or `a:1` for
 * CONNECT) when the Host holds a character such as a space, `/`, or `@`. A Host that is no valid host
 * (`<value>%5e.example`, `a%zz`, `[::1x`, `a:99999`) still gives the absolute form, which `new URL` refuses. So the
 * `scheme://authority` is dropped and the rest is put behind the fixed base, after a `/` when it does not start as a
 * path: the Host never takes part, the authority is always `localhost` so nothing throws, and every Host gives the
 * same pathname and search.
 */
export function requestTarget(url: string): URL {
  const target = url.replace(URL_AUTHORITY, '');
  return new URL(URL_BASE + (PATH_START.test(target) ? target : `/${target}`));
}

/**
 * The path Elysia 1.4.30 routes a request on when Bun's own router did not match it: `request.url` from the first `/`
 * at index 11 or later, up to the first `?` after it (`dynamic-handle.js` and `adapter/bun/compose.js`, with
 * `standardHostname` at its default). Index 11 assumes `http://` plus a Host of at least 4 characters, so with a Host of
 * 3 or fewer characters, or with the bare target Bun writes for a Host such as `a b`, this path differs from the
 * pathname of requestTarget (`Host: abc` with the target `//api/auth/session` is routed as `/api/auth/session`). A guard
 * that decides on a path must refuse when the two differ, never decide on only one of them.
 */
export function routedPath(url: string): string {
  const start = url.indexOf('/', 11);
  const query = url.indexOf('?', start + 1);
  return query === -1 ? url.substring(start) : url.substring(start, query);
}

/**
 * Elysia 1.4.30 hands `HEAD <path>` and `GET <path>/` to the GET handler of `<path>`. 404 is not in the response map,
 * so the handler answers with a fixed Response; Bun sends a HEAD answer without its body.
 */
export const notFound = () => new Response(NOT_FOUND_BODY, { status: 404, headers: { 'content-type': 'application/json', 'cache-control': NO_STORE } });

/**
 * Bun 1.4.2 gives `request.body` as null for a GET that carries a body but still passes both headers, so the check
 * reads the headers (spec 0006, Value sourcing *Backend 400*).
 */
const carriesBody = (headers: Headers) => {
  const length = headers.get('content-length');
  return (length !== null && length !== '0') || headers.has('transfer-encoding');
};

/**
 * The first two steps of the guard, in this order: (1) a method other than GET or a path other than exactly `path`
 * gives `not_found` (answer 404), (2) a query string or body headers give `invalid` (answer 400). `null` lets the
 * handler go on. Synchronous, so nothing awaits before the route's own step.
 */
export function strictGet(request: Request, path: string): 'not_found' | 'invalid' | null {
  const url = requestTarget(request.url);
  if (request.method !== 'GET' || url.pathname !== path) return 'not_found';
  if (url.search !== '' || carriesBody(request.headers)) return 'invalid';
  return null;
}
