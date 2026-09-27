import { Elysia, t } from 'elysia';

export const developmentRoutes = new Elysia({ name: 'development' })
  .model('DevelopmentStatus', t.Object({ status: t.Literal('ok', { enum: ['ok'] }) }, { additionalProperties: false }))
  .get('/api/status', () => ({ status: 'ok' as const }), {
    response: {
      200: 'DevelopmentStatus',
      500: t.Object({ error: t.Literal('Internal server error') }, { additionalProperties: false }),
    },
    detail: { operationId: 'getDevelopmentStatus', tags: ['development'], security: [], summary: 'Development process status' },
  });
