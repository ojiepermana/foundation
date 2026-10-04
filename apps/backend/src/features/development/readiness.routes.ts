import { Type } from '@sinclair/typebox';
import type { SQL } from 'bun';
import { Elysia, t } from 'elysia';
import { countAppliedMigrations } from './readiness.queries';
import { createReadinessCheck, type ReadinessOutcome } from './readiness.service';

const NO_STORE = 'no-store';
const READINESS_PATH = '/api/readiness';
/**
 * Bun 1.4.2 gives a relative `request.url` (for example `/api/readiness`) when the Host header forms no absolute URL,
 * so the URL is parsed against this fixed base. Only pathname and search are read, and both stay the same for an
 * absolute URL.
 */
const URL_BASE = 'http://localhost';
const NOT_FOUND_BODY = JSON.stringify({ error: 'Not found' });

/**
 * Elysia 1.4.30 hands `HEAD /api/readiness` and `GET /api/readiness/` to this GET handler. 404 is not in the response
 * map, so the handler answers with a fixed Response; Bun sends a HEAD answer without its body.
 */
const notFound = () => new Response(NOT_FOUND_BODY, { status: 404, headers: { 'content-type': 'application/json', 'cache-control': NO_STORE } });

/**
 * Bun 1.4.2 gives `request.body` as null for a GET that carries a body but still passes both headers, so the check
 * reads the headers (spec 0006, Value sourcing *Backend 400*).
 */
const carriesBody = (headers: Headers) => {
  const length = headers.get('content-length');
  return (length !== null && length !== '0') || headers.has('transfer-encoding');
};

/**
 * `GET /api/readiness` for the development composition only (spec 0006). The route is built per application
 * instance, so the check state never lives at module level. The handler checks a request in a fixed order, and only
 * the last step runs a query or sets the active check marker: (1) a method other than GET or a path other than exactly
 * `/api/readiness` gets 404, (2) a query string or body headers get 400, (3) no pool gets 503, (4) an active check gets
 * 429, (5) otherwise the marker is set and the count starts. Every answer from the handler carries `no-store`.
 */
export function createReadinessRoutes(database?: SQL) {
  const check = createReadinessCheck(database ? () => countAppliedMigrations(database) : undefined);
  return new Elysia()
    .model({
      ReadinessAvailable: t.Object({
        status: t.Literal('available', { enum: ['available'] }),
        checkedAt: t.String({ format: 'date-time' }),
        appliedMigrations: Type.Integer({ minimum: 0 }),
      }, { additionalProperties: false }),
      ReadinessBusy: t.Object({ status: t.Literal('busy', { enum: ['busy'] }) }, { additionalProperties: false }),
      ReadinessUnavailable: t.Object({
        status: t.Literal('unavailable', { enum: ['unavailable'] }),
        checkedAt: t.String({ format: 'date-time' }),
      }, { additionalProperties: false }),
    })
    // Synchronous up to check(): the 404 and 400 answers return at once, and nothing awaits before the marker step.
    // The pending answer sits in its own const so Elysia's handler type does not widen it with Response.
    .get(READINESS_PATH, ({ request, set, status }) => {
      set.headers['cache-control'] = NO_STORE;
      const url = new URL(request.url, URL_BASE);
      if (request.method !== 'GET' || url.pathname !== READINESS_PATH) return notFound();
      if (url.search !== '' || carriesBody(request.headers)) return status(400, { error: 'Invalid request' as const });
      const answer = (outcome: ReadinessOutcome) => {
        if (outcome.status === 'available') return outcome;
        return outcome.status === 'busy' ? status(429, outcome) : status(503, outcome);
      };
      const answered = check().then(answer);
      return answered;
    }, {
      response: {
        200: 'ReadinessAvailable',
        400: t.Object({ error: t.Literal('Invalid request') }, { additionalProperties: false }),
        429: 'ReadinessBusy',
        500: t.Object({ error: t.Literal('Internal server error') }, { additionalProperties: false }),
        503: 'ReadinessUnavailable',
      },
      detail: { operationId: 'getDevelopmentReadiness', tags: ['development'], security: [], summary: 'Development database readiness' },
    });
}
