type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid OpenAPI: ${message}`);
}

// Project contract checks only, not a complete OpenAPI standards validator.
export function validateOpenApi(input: unknown): void {
  requireValue(object(input), 'document must be an object');
  const doc = input;
  requireValue(doc.openapi === '3.0.3' || doc.openapi === '3.1.0', 'unsupported version');
  requireValue(object(doc.info) && nonempty(doc.info.title) && nonempty(doc.info.version), 'info title and version required');
  requireValue(object(doc.paths), 'paths required');
  function resolveReference(ref: unknown): RecordValue {
    requireValue(typeof ref === 'string' && ref.startsWith('#/'), 'external reference forbidden');
    let value: any = doc;
    for (const raw of ref.slice(2).split('/')) {
      requireValue(!/~(?![01])/.test(raw), 'invalid reference escape');
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      requireValue(object(value) && Object.hasOwn(value, key), 'unresolved local reference');
      value = value[key];
    }
    requireValue(object(value), 'reference target must be an object');
    return value;
  }
  function walk(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!object(value)) return;
    if ('$ref' in value) resolveReference(value.$ref);
    Object.values(value).forEach(walk);
  }
  walk(doc);
  function dereference(value: unknown, seen = new Set<string>()): RecordValue {
    requireValue(object(value), 'expected object');
    if ('$ref' in value) {
      requireValue(!seen.has(value.$ref), 'cyclic reference at contract boundary');
      seen.add(value.$ref);
      return dereference(resolveReference(value.$ref), seen);
    }
    return value;
  }
  function schema(value: unknown): void {
    const item = dereference(value);
    requireValue(nonempty(item.type) || Array.isArray(item.enum) || ['allOf', 'anyOf', 'oneOf'].some(key => Array.isArray(item[key])), 'schema required');
  }
  function security(value: unknown): void {
    requireValue(Array.isArray(value), 'explicit security required');
    for (const entry of value) {
      requireValue(object(entry) && Object.keys(entry).length > 0, 'invalid security requirement');
      for (const [name, scopes] of Object.entries(entry)) {
        requireValue(Array.isArray(scopes) && scopes.every(scope => typeof scope === 'string'), 'invalid security scopes');
        const scheme = dereference(doc.components?.securitySchemes?.[name]);
        requireValue(['apiKey', 'http', 'oauth2', 'openIdConnect'].includes(scheme.type), 'invalid security scheme');
        if (scheme.type === 'http') requireValue(nonempty(scheme.scheme), 'HTTP scheme required');
        if (scheme.type === 'apiKey') requireValue(nonempty(scheme.name) && ['query', 'header', 'cookie'].includes(scheme.in), 'API key scheme invalid');
      }
    }
  }
  const operations = new Set<string>();
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
  for (const [path, raw] of Object.entries(doc.paths)) {
    requireValue(path.startsWith('/'), 'invalid path');
    const item = dereference(raw);
    let count = 0;
    for (const [method, value] of Object.entries(item)) {
      if (!methods.has(method)) { requireValue(['parameters', 'summary', 'description', 'servers'].includes(method) || method.startsWith('x-'), 'invalid path member'); continue; }
      count++;
      const operation = dereference(value);
      requireValue(nonempty(operation.operationId) && !operations.has(operation.operationId), 'operationId missing or duplicate');
      operations.add(operation.operationId);
      requireValue(Array.isArray(operation.tags) && operation.tags.length > 0 && operation.tags.every(nonempty), 'tags required');
      security(operation.security ?? doc.security);
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
      for (const parameter of parameters) {
        const p = dereference(parameter);
        requireValue(nonempty(p.name) && ['path', 'query', 'header', 'cookie'].includes(p.in), 'invalid parameter');
        if (p.in === 'path') requireValue(p.required === true && path.includes(`{${p.name}}`), 'invalid path parameter');
        schema(p.schema);
      }
      for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) requireValue(parameters.some(p => { const d = dereference(p); return d.in === 'path' && d.name === name; }), 'path parameter schema missing');
      if (operation.requestBody !== undefined) {
        const body = dereference(operation.requestBody);
        requireValue(object(body.content) && Object.keys(body.content).length > 0, 'body content required');
        for (const media of Object.values(body.content)) schema(dereference(media).schema);
      }
      requireValue(object(operation.responses) && Object.keys(operation.responses).length > 0, 'responses required');
      for (const [status, response] of Object.entries(operation.responses)) {
        requireValue(/^[1-5]\d{2}$/.test(status) || status === 'default', 'invalid response status');
        const result = dereference(response);
        requireValue(nonempty(result.description), 'response description required');
        if (status === '204') continue;
        requireValue(object(result.content) && Object.keys(result.content).length > 0, 'response schema required');
        for (const media of Object.values(result.content)) schema(dereference(media).schema);
      }
    }
    requireValue(count > 0, 'path must contain an operation');
  }
  const status = doc.paths['/api/status']?.get;
  requireValue(object(status) && status.operationId === 'getDevelopmentStatus' && status.tags?.includes('development'), 'development endpoint required');
  requireValue(Array.isArray(status.security) && status.security.length === 0, 'development endpoint must be unauthenticated');
  const response = dereference(status.responses?.['200']);
  const model = dereference(response.content?.['application/json']?.schema);
  const literal = dereference(model.properties?.status);
  requireValue(model.type === 'object' && Array.isArray(model.required) && model.required.includes('status') && model.additionalProperties === false && Object.keys(model.properties).length === 1 && literal.type === 'string' && (literal.enum !== undefined || literal.const !== undefined) && (literal.enum === undefined || (Array.isArray(literal.enum) && literal.enum.length === 1 && literal.enum[0] === 'ok')) && (literal.const === undefined || literal.const === 'ok'), 'status response must be exactly {status: ok}');
}

if (import.meta.main) {
  try {
    validateOpenApi(await Bun.file(process.argv[2] ?? new URL('../openapi.json', import.meta.url)).json());
    console.log('OpenAPI project checks passed');
  } catch {
    console.error('OpenAPI validation failed');
    process.exitCode = 1;
  }
}
