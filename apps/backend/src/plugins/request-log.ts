import { Elysia, StatusMap } from 'elysia';
import { requestTarget } from './request-guard';

// Production log of spec 0012 (*Log backend production*, AC-10): one JSON line per request that reaches Elysia, except
// health answers below 500, and JSON lifecycle lines. Only index.ts gives a sink, and only for NODE_ENV=production, so
// the development composition and every test that builds an app without one stay silent (rationale, decision 24).
// No line ever holds a query string, header, cookie, body, client address, DSN, SQL, error message, or stack.

/**
 * Where the lines go. `info` lines only to stdout and `error` lines only to stderr (AC-10); the sink writes one line
 * per call and adds the line break itself.
 */
export interface RequestLogSink {
  info(line: string): void;
  error(line: string): void;
}

export type LogLevel = 'info' | 'error';

/** Lifecycle vocabulary of *Log backend production*, with the level of each event. */
export const LIFECYCLE_EVENTS = Object.freeze({
  listening: 'info',
  stopped: 'info',
  listener_shutdown_failed: 'error',
  database_shutdown_failed: 'error',
  startup_failed: 'error',
} as const satisfies Record<string, LogLevel>);

export type LifecycleEvent = keyof typeof LIFECYCLE_EVENTS;

/** Writes one lifecycle line with the exact keys `time`, `level`, and `event`. A sink that throws is ignored. */
export function writeLifecycle(sink: RequestLogSink, event: LifecycleEvent, now: () => Date = () => new Date()): void {
  const level = LIFECYCLE_EVENTS[event];
  writeLogLine(sink, level, JSON.stringify({ time: now().toISOString(), level, event }));
}

/**
 * Writes one finished line to the stream of its level. Shared by the request and lifecycle lines here and the `auth`
 * event lines of spec 0014 (features/auth/auth.log.ts), so every line goes through the same rule.
 */
export function writeLogLine(sink: RequestLogSink, level: LogLevel, line: string): void {
  try {
    if (level === 'info') sink.info(line);
    else sink.error(line);
  } catch {
    // A log write never changes an answer or stops the process.
  }
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HEALTH_PATHS = new Set(['/health/live', '/health/ready']);
const REQUEST_ID = /^[0-9a-f]{32}$/;
/** *Log backend production*: `path` is at most 200 characters. */
export const LOG_PATH_LIMIT = 200;

/**
 * Value sourcing *Backend `requestId`*: the `x-request-id` header when it is exactly 32 lower case hex digits (the
 * `$request_id` of the edge), otherwise a new `crypto.randomUUID()` without its hyphens. A repeated header arrives
 * joined with `, ` and so is never trusted.
 */
export function requestIdOf(headers: Headers): string {
  const value = headers.get('x-request-id');
  return value !== null && REQUEST_ID.test(value) ? value : crypto.randomUUID().replaceAll('-', '');
}

/** `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `OTHER`, so a request never writes a free method text. */
export function logMethod(method: string): string {
  return METHODS.has(method) ? method : 'OTHER';
}

/**
 * The pathname of the request target without the query, at most LOG_PATH_LIMIT characters. requestTarget drops the
 * `scheme://authority` that Bun 1.4.2 builds from the Host header, so no Host value reaches the line, even one that
 * `new URL` refuses.
 */
export function logPath(url: string): string {
  return requestTarget(url).pathname.slice(0, LOG_PATH_LIMIT);
}

/**
 * The status the client got. A handler that returns a Response (the 404 of plugins/request-guard.ts) carries its own
 * status; every other answer, the onError answers included, has it in `set.status` (Elysia 1.4.30).
 */
function statusOf(response: unknown, status: unknown): number {
  if (response instanceof Response) return response.status;
  if (typeof status === 'number') return status;
  if (typeof status === 'string' && Object.hasOwn(StatusMap, status)) return StatusMap[status as keyof typeof StatusMap];
  return 200;
}

type Started = { at: number; id: string };

/**
 * Start time and request id per request (spec 0014, *Log keamanan*). One map at module level, not one per plugin
 * instance, so the guard of the auth plugin and an `auth` event read the same id as the request line of the same request.
 * Entries go away with their Request object.
 */
const started = new WeakMap<Request, Started>();

/**
 * The request id recorded for `request` by the `onRequest` hook of the log plugin, or a new one (the header rule of
 * requestIdOf) that is recorded at once, so every later reader of the same request gets the same id.
 */
export function requestIdFor(request: Request): string {
  const entry = started.get(request);
  if (entry !== undefined) return entry.id;
  const id = requestIdOf(request.headers);
  started.set(request, { at: performance.now(), id });
  return id;
}

/** Builds and writes one request line; health answers below 500 write nothing (spec 0012). */
function writeLine(sink: RequestLogSink, request: Request, status: number, entry: Started | undefined): void {
  const path = logPath(request.url);
  if (status < 500 && HEALTH_PATHS.has(path)) return;
  const level: LogLevel = status < 500 ? 'info' : 'error';
  writeLogLine(sink, level, JSON.stringify({
    time: new Date().toISOString(),
    level,
    event: 'request',
    requestId: entry?.id ?? requestIdOf(request.headers),
    method: logMethod(request.method),
    path,
    status,
    durationMs: entry === undefined ? 0 : Math.round(performance.now() - entry.at),
  }));
}

/**
 * Writes the request line of `request` with `status` from its recorded entry, then removes the entry, so the
 * `onAfterResponse` hook never writes a second line for it. The guard of the auth plugin calls it for every answer it
 * returns from `onRequest`, since Elysia 1.4.30 runs no `onAfterResponse` for such an answer (spec 0014 probe).
 */
export function writeRequestLine(sink: RequestLogSink, request: Request, status: number): void {
  const entry = started.get(request);
  started.delete(request);
  writeLine(sink, request, status, entry);
}

/**
 * The request log plugin. `onRequest` runs before routing for every request, so it records the start and the
 * request id; `onAfterResponse` (global) writes the line once the answer was sent: `level` is `info` below 500 and
 * `error` from 500, `durationMs` is the rounded `performance.now()` difference. createApp registers it before every
 * route, so it covers all of them and the 404 of unknown paths. A request Bun refuses before Elysia (a body above
 * `maxRequestBodySize`) never reaches these hooks and writes no line. A request whose line writeRequestLine already
 * wrote has no entry any more and writes nothing here.
 */
export function createRequestLog(sink: RequestLogSink) {
  return new Elysia()
    .onRequest(({ request }) => {
      started.set(request, { at: performance.now(), id: requestIdOf(request.headers) });
    })
    .onAfterResponse({ as: 'global' }, ({ request, set, responseValue }) => {
      const entry = started.get(request);
      if (entry === undefined) return;
      started.delete(request);
      writeLine(sink, request, statusOf(responseValue, set.status), entry);
    });
}
