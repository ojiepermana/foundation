import type { SQL } from 'bun';
import { Elysia, t } from 'elysia';
import { NO_STORE, notFound, strictGet } from '../../plugins/request-guard';
import { migrationApplied, REQUIRED_MIGRATION } from './health.queries';
import { createHealthReadiness } from './health.service';

const LIVE_PATH = '/health/live';
const READY_PATH = '/health/ready';
const invalidRequest = t.Object({ error: t.Literal('Invalid request') }, { additionalProperties: false });
const internalError = t.Object({ error: t.Literal('Internal server error') }, { additionalProperties: false });

/**
 * `GET /health/live` and `GET /health/ready` for both compositions (spec 0012, AC-4). They sit outside `/api/`, so the
 * edge never forwards them and only the internal network reaches them. Both use the guard order of spec 0006 through
 * plugins/request-guard.ts (404 for another method, HEAD included, or an inexact path; 400 for a query string or body
 * headers), and every answer from the handler carries `no-store` and no time, version, count, name, or error text.
 * `live` never touches the pool. `ready` answers 200 only when the required migration is applied, and 503 for every
 * other outcome. The routes are built per application instance, so the readiness state never lives at module level.
 */
export function createHealthRoutes(database?: SQL) {
  const readiness = createHealthReadiness(database ? () => migrationApplied(database, REQUIRED_MIGRATION) : undefined);
  return new Elysia()
    .model({
      HealthLive: t.Object({ status: t.Literal('live', { enum: ['live'] }) }, { additionalProperties: false }),
      HealthReady: t.Object({ status: t.Literal('ready', { enum: ['ready'] }) }, { additionalProperties: false }),
      HealthUnavailable: t.Object({ status: t.Literal('unavailable', { enum: ['unavailable'] }) }, { additionalProperties: false }),
    })
    .get(LIVE_PATH, ({ request, set, status }) => {
      set.headers['cache-control'] = NO_STORE;
      const refused = strictGet(request, LIVE_PATH);
      if (refused === 'not_found') return notFound();
      if (refused === 'invalid') return status(400, { error: 'Invalid request' as const });
      return { status: 'live' as const };
    }, {
      response: { 200: 'HealthLive', 400: invalidRequest, 500: internalError },
      detail: { operationId: 'getHealthLive', tags: ['health'], security: [], summary: 'Backend process liveness' },
    })
    // Synchronous up to readiness(): the 404 and 400 answers return at once, and nothing awaits before the marker step.
    .get(READY_PATH, ({ request, set, status }) => {
      set.headers['cache-control'] = NO_STORE;
      const refused = strictGet(request, READY_PATH);
      if (refused === 'not_found') return notFound();
      if (refused === 'invalid') return status(400, { error: 'Invalid request' as const });
      const answered = readiness().then((outcome) =>
        outcome === 'ready' ? { status: 'ready' as const } : status(503, { status: 'unavailable' as const }));
      return answered;
    }, {
      response: { 200: 'HealthReady', 400: invalidRequest, 500: internalError, 503: 'HealthUnavailable' },
      detail: { operationId: 'getHealthReady', tags: ['health'], security: [], summary: 'Backend database readiness' },
    });
}
