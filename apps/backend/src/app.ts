import { Elysia } from 'elysia';
import { openapi } from '@elysia/openapi';
import { developmentRoutes } from './features/development/status.routes';

export function createApp(mode: 'development' | 'production') {
  const app = new Elysia().onError(({ code, set }) => {
    set.status = code === 'NOT_FOUND' ? 404 : code === 'VALIDATION' || code === 'PARSE' ? 400 : 500;
    return { error: set.status === 404 ? 'Not found' : set.status === 400 ? 'Invalid request' : 'Internal server error' };
  });
  if (mode === 'production') return app;
  return app.use(openapi({
    provider: null, openapiVersion: '3.1.0',
    documentation: { info: { title: 'Foundation development API', version: '0.1.0' }, tags: [{ name: 'development' }], security: [] },
  })).use(developmentRoutes);
}
