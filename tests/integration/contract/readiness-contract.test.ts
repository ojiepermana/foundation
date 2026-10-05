import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { OpenApiContractError, REQUIRED_OPERATIONS, validateOpenApi } from '../../../scripts/validate-openapi';
import { root } from './workspace';

// READY-003 (spec 0006, AC-5): the stored contract, the required operation entry, and the generated SDK for
// GET /api/readiness. Tables *Kontrak OpenAPI* and *Operasi wajib baru* of docs/specs/0006-alur-pemeriksaan-kesiapan.
const stored = await Bun.file(join(root, 'openapi.json')).json();
const publicApi = await Bun.file(join(root, 'apps/frontend/sdk/public-api.ts')).text();
const developmentService = await Bun.file(join(root, 'apps/frontend/sdk/services/development.service.ts')).text();

const reference = (name: string) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } });
const literal = (value: string) => ({ const: value, enum: [value], type: 'string' });

function ruleOf(document: unknown): string {
  try {
    validateOpenApi(document);
    return 'accepted';
  } catch (error) {
    if (error instanceof OpenApiContractError) return error.rule;
    throw error;
  }
}

test('READY-003 stored openapi.json declares GET /api/readiness exactly as the contract table', () => {
  const item = stored.paths['/api/readiness'];
  expect(Object.keys(item)).toEqual(['get']);
  const operation = item.get;
  expect(Object.keys(operation).sort()).toEqual(['operationId', 'responses', 'security', 'summary', 'tags']);
  expect(operation.operationId).toBe('getDevelopmentReadiness');
  expect(operation.tags).toEqual(['development']);
  expect(operation.security).toEqual([]);
  expect(operation.summary).toBe('Development database readiness');
  expect(Object.keys(operation.responses).sort()).toEqual(['200', '400', '429', '500', '503']);
  for (const response of Object.values<Record<string, unknown>>(operation.responses)) {
    // Cache-Control stays out of the contract: a response holds only a description and its content.
    expect(Object.keys(response).sort()).toEqual(['content', 'description']);
    expect(typeof response['description'] === 'string' && response['description'].length > 0).toBe(true);
  }
  expect(operation.responses['200'].content).toStrictEqual(reference('ReadinessAvailable'));
  expect(operation.responses['429'].content).toStrictEqual(reference('ReadinessBusy'));
  expect(operation.responses['503'].content).toStrictEqual(reference('ReadinessUnavailable'));
  expect(operation.responses['400'].content).toStrictEqual({ 'application/json': { schema: {
    additionalProperties: false, properties: { error: { const: 'Invalid request', type: 'string' } }, required: ['error'], type: 'object',
  } } });
  expect(operation.responses['500'].content).toStrictEqual(stored.paths['/api/status'].get.responses['500'].content);
});

test('READY-003 stored openapi.json holds the three named readiness models', () => {
  const schemas = stored.components.schemas;
  expect(schemas.ReadinessAvailable).toStrictEqual({
    $id: '#/components/schemas/ReadinessAvailable', additionalProperties: false, type: 'object',
    properties: { appliedMigrations: { minimum: 0, type: 'integer' }, checkedAt: { format: 'date-time', type: 'string' }, status: literal('available') },
    required: ['status', 'checkedAt', 'appliedMigrations'],
  });
  expect(schemas.ReadinessBusy).toStrictEqual({
    $id: '#/components/schemas/ReadinessBusy', additionalProperties: false, type: 'object',
    properties: { status: literal('busy') }, required: ['status'],
  });
  expect(schemas.ReadinessUnavailable).toStrictEqual({
    $id: '#/components/schemas/ReadinessUnavailable', additionalProperties: false, type: 'object',
    properties: { checkedAt: { format: 'date-time', type: 'string' }, status: literal('unavailable') }, required: ['status', 'checkedAt'],
  });
  expect(ruleOf(stored)).toBe('accepted');
});

test('READY-003 REQUIRED_OPERATIONS keeps the status entry and adds the readiness entry of the table', () => {
  // Spec 0012 (*Perubahan gate yang dinamai*, Test kontrak lama): the two entries above stay as they are and the two
  // health entries follow them.
  expect(REQUIRED_OPERATIONS.map(({ checkComponent: _check, ...entry }) => entry)).toEqual([
    { path: '/api/status', method: 'get', operationId: 'getDevelopmentStatus', tag: 'development', security: [], successStatus: '200', component: 'DevelopmentStatus' },
    { path: '/api/readiness', method: 'get', operationId: 'getDevelopmentReadiness', tag: 'development', security: [], successStatus: '200', component: 'ReadinessAvailable' },
    { path: '/health/live', method: 'get', operationId: 'getHealthLive', tag: 'health', security: [], successStatus: '200', component: 'HealthLive' },
    { path: '/health/ready', method: 'get', operationId: 'getHealthReady', tag: 'health', security: [], successStatus: '200', component: 'HealthReady' },
  ]);
  expect(Object.isFrozen(REQUIRED_OPERATIONS[1]) && Object.isFrozen(REQUIRED_OPERATIONS[1]!.security)).toBe(true);
  const { checkComponent } = REQUIRED_OPERATIONS[1]!;
  const model = () => structuredClone(stored.components.schemas.ReadinessAvailable);
  expect(checkComponent(model())).toBe(true);
  // The status literal may come through const, enum, or both, but not through neither.
  for (const drop of ['const', 'enum']) {
    const only = model();
    delete only.properties.status[drop];
    expect(checkComponent(only)).toBe(true);
  }
  const neither = model();
  delete neither.properties.status.const;
  delete neither.properties.status.enum;
  expect(checkComponent(neither)).toBe(false);
  const rejected: [string, (schema: any) => void][] = [
    ['additional properties allowed', schema => { schema.additionalProperties = true; }],
    ['a field left out of required', schema => { schema.required = ['status', 'checkedAt']; }],
    ['an extra property', schema => { schema.properties.extra = { type: 'string' }; schema.required.push('extra'); }],
    ['another status literal', schema => { schema.properties.status = literal('ok'); }],
    ['checkedAt without date-time', schema => { delete schema.properties.checkedAt.format; }],
    ['appliedMigrations as number', schema => { schema.properties.appliedMigrations.type = 'number'; }],
    ['appliedMigrations without minimum', schema => { delete schema.properties.appliedMigrations.minimum; }],
    ['appliedMigrations with minimum 1', schema => { schema.properties.appliedMigrations.minimum = 1; }],
  ];
  for (const [name, mutate] of rejected) {
    const schema = model();
    mutate(schema);
    expect(checkComponent(schema), name).toBe(false);
  }
});

test('READY-003 checkComponent of the readiness entry refuses literal, type, and reference variants the table does not allow', () => {
  const { checkComponent } = REQUIRED_OPERATIONS[1]!;
  const model = () => structuredClone(stored.components.schemas.ReadinessAvailable);
  const rejected: [string, (schema: any) => void][] = [
    ['an enum with a second value beside available', schema => { schema.properties.status.enum = ['available', 'busy']; }],
    ['an empty enum', schema => { schema.properties.status.enum = []; }],
    ['const busy with enum available', schema => { schema.properties.status.const = 'busy'; }],
    ['status without a type', schema => { delete schema.properties.status.type; }],
    ['status as a reference', schema => { schema.properties.status = { $ref: '#/components/schemas/ReadinessBusy' }; }],
    ['checkedAt as a number with date-time', schema => { schema.properties.checkedAt.type = 'number'; }],
    ['checkedAt with format date', schema => { schema.properties.checkedAt.format = 'date'; }],
    ['checkedAt as a reference', schema => { schema.properties.checkedAt = { $ref: '#/components/schemas/ReadinessUnavailable' }; }],
    ['appliedMigrations as a reference', schema => { schema.properties.appliedMigrations = { $ref: '#/components/schemas/ReadinessBusy' }; }],
    ['appliedMigrations with minimum as a string', schema => { schema.properties.appliedMigrations.minimum = '0'; }],
    ['a schema of type array', schema => { schema.type = 'array'; }],
    ['additionalProperties left out', schema => { delete schema.additionalProperties; }],
    ['required with a repeated name instead of appliedMigrations', schema => { schema.required = ['status', 'status', 'checkedAt']; }],
    ['required as a string', schema => { schema.required = 'status'; }],
    ['properties left out', schema => { delete schema.properties; }],
    ['a renamed property', schema => { schema.properties.applied = schema.properties.appliedMigrations; delete schema.properties.appliedMigrations; }],
  ];
  for (const [name, mutate] of rejected) {
    const schema = model();
    mutate(schema);
    expect(checkComponent(schema), name).toBe(false);
  }
  // The order of required does not matter, only the set.
  const reordered = model();
  reordered.required = ['appliedMigrations', 'status', 'checkedAt'];
  expect(checkComponent(reordered)).toBe(true);
});

test('READY-003 checker rejects with required-operation a contract that loses or changes the readiness operation', () => {
  const cases: [string, (d: any) => void][] = [
    ['no readiness operation', d => { delete d.paths['/api/readiness']; }],
    ['another operationId', d => { d.paths['/api/readiness'].get.operationId = 'getReadiness'; }],
    ['a success component without minimum', d => { delete d.components.schemas.ReadinessAvailable.properties.appliedMigrations.minimum; }],
    ['a success component without format', d => { delete d.components.schemas.ReadinessAvailable.properties.checkedAt.format; }],
    ['a success response that references another component', d => {
      d.paths['/api/readiness'].get.responses['200'].content = reference('ReadinessUnavailable');
    }],
  ];
  for (const [name, mutate] of cases) {
    const document = structuredClone(stored);
    mutate(document);
    expect(ruleOf(document), name).toBe('required-operation');
  }
});

test('READY-003 generated SDK exports the readiness models and DevelopmentService.getDevelopmentReadiness', () => {
  for (const model of ['ReadinessAvailable', 'ReadinessBusy', 'ReadinessUnavailable']) {
    expect(publicApi).toContain(`export type { ${model} } from './models/`);
  }
  expect(publicApi).toContain('getDevelopmentReadiness,');
  expect(developmentService).toContain('getDevelopmentReadiness(');
  expect(developmentService).toContain('Observable<ReadinessAvailable>');
});

// READY-005 (spec 0006, AC-8), source part: the page imports only the public classes AC-8 lists, only from the three
// public entry points, and never a deeper library path. Every string literal naming the library counts, so a
// dynamic import or a side effect import of another entry point fails as well.
test('READY-005 readiness-page.ts imports only the AC-8 classes from the card, button, and spinner entry points', async () => {
  const source = await Bun.file(join(root, 'apps/frontend/src/app/features/readiness/readiness-page.ts')).text();
  const named: Record<string, string[]> = {};
  for (const [, names, from] of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';$/gm)) {
    if (!from!.startsWith('@ojiepermana/')) continue;
    named[from!] = names!.split(',').map((name) => name.trim()).filter(Boolean).sort();
  }
  expect(named).toEqual({
    '@ojiepermana/angular/component/button': ['ButtonComponent'],
    '@ojiepermana/angular/component/card': [
      'CardComponent',
      'CardContentComponent',
      'CardDescriptionComponent',
      'CardFooterComponent',
      'CardHeaderComponent',
      'CardTitleComponent',
    ],
    '@ojiepermana/angular/component/spinner': ['SpinnerComponent'],
  });
  const mentions = [...source.matchAll(/['"`](@ojiepermana\/[^'"`]*)['"`]/g)].map((match) => match[1]).sort();
  expect(mentions).toEqual([
    '@ojiepermana/angular/component/button',
    '@ojiepermana/angular/component/card',
    '@ojiepermana/angular/component/spinner',
  ]);
  expect(source).not.toContain('node_modules');
  expect(source).not.toMatch(/\brequire\s*\(/);
});

// DEP-003 (spec 0012, AC-4): the two health entries of REQUIRED_OPERATIONS take the shape of the getDevelopmentStatus
// entry (one required status string with a single enum value and additionalProperties false), and the generated SDK
// exports HealthService with both operations and the three health models.
const healthService = await Bun.file(join(root, 'apps/frontend/sdk/services/health.service.ts')).text();

test('DEP-003 the health entries of REQUIRED_OPERATIONS accept only one required status literal without additional properties', () => {
  const entries: [number, string, string][] = [[2, 'HealthLive', 'live'], [3, 'HealthReady', 'ready']];
  for (const [index, name, value] of entries) {
    const { checkComponent, component } = REQUIRED_OPERATIONS[index]!;
    expect(component).toBe(name);
    const model = () => structuredClone(stored.components.schemas[name]);
    expect(checkComponent(model()), name).toBe(true);
    const rejected: [string, (schema: any) => void][] = [
      ['additional properties allowed', schema => { schema.additionalProperties = true; }],
      ['additionalProperties left out', schema => { delete schema.additionalProperties; }],
      ['another literal', schema => { schema.properties.status = literal('ok'); }],
      ['an enum with a second value', schema => { schema.properties.status.enum = [value, 'unavailable']; }],
      ['neither const nor enum', schema => { delete schema.properties.status.const; delete schema.properties.status.enum; }],
      ['an extra property', schema => { schema.properties.detail = { type: 'string' }; }],
      ['status left out of required', schema => { schema.required = []; }],
      ['status as a reference', schema => { schema.properties.status = { $ref: '#/components/schemas/HealthUnavailable' }; }],
    ];
    for (const [label, mutate] of rejected) {
      const schema = model();
      mutate(schema);
      expect(checkComponent(schema), `${name} ${label}`).toBe(false);
    }
  }
});

test('DEP-003 generated SDK exports HealthService with getHealthLive and getHealthReady and the three health models', () => {
  for (const model of ['HealthLive', 'HealthReady', 'HealthUnavailable']) expect(publicApi).toContain(`export type { ${model} } from './models/`);
  expect(publicApi).toContain("export { HealthService } from './services/health.service';");
  expect(publicApi).toContain("export { getHealthLive, type GetHealthLive$Params } from './fn/health/get-health-live';");
  expect(publicApi).toContain("export { getHealthReady, type GetHealthReady$Params } from './fn/health/get-health-ready';");
  expect(healthService).toContain('export class HealthService extends BaseService');
  expect(healthService).toContain('getHealthLive(params?: GetHealthLive$Params, context?: HttpContext): Observable<HealthLive>');
  expect(healthService).toContain('getHealthReady(params?: GetHealthReady$Params, context?: HttpContext): Observable<HealthReady>');
});
