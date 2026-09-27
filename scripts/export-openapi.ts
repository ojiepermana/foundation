import { createApp } from '../apps/backend/src/app';
import { validateOpenApi } from './validate-openapi';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const app = createApp('development');
await app.modules;
const response = await app.handle(new Request('http://localhost/openapi/json'));
if (!response.ok) throw new Error('OpenAPI export failed');
const document: unknown = await response.json();
validateOpenApi(document);
await Bun.write(new URL('../openapi.json', import.meta.url), JSON.stringify(canonical(document), null, 2) + '\n');
console.log('OpenAPI exported without listener');
