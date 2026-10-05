import { Type } from '@sinclair/typebox';
import type { SQL } from 'bun';
import { Elysia, t } from 'elysia';
import { NO_STORE, notFound, strictGet } from '../../plugins/request-guard';
import { countAppliedMigrations } from './readiness.queries';
import { createReadinessCheck, type ReadinessOutcome } from './readiness.service';

const READINESS_PATH = '/api/readiness';

/**
 * `GET /api/readiness` for the development composition only (spec 0006). The route is built per application
 * instance, so the check state never lives at module level. The handler checks a request in a fixed order, and only
 * the last step runs a query or sets the active check marker: (1) a method other than GET or a path other than exactly
 * `/api/readiness` gets 404, (2) a query string or body headers get 400 (both from the shared guard of
 * plugins/request-guard.ts), (3) no pool gets 503, (4) an active check gets 429, (5) otherwise the marker is set and
 * the count starts. Every answer from the handler carries `no-store`.
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
      const refused = strictGet(request, READINESS_PATH);
      if (refused === 'not_found') return notFound();
      if (refused === 'invalid') return status(400, { error: 'Invalid request' as const });
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
