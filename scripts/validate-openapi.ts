// Project OpenAPI contract checker, governed by spec 0008:
// docs/specs/0008-ekspor-pemeriksaan-kontrak-openapi/index.md
// The "Aturan checker" table in that spec is the official boundary of this checker. It is an allow list of the
// shapes that Elysia exports cleanly and that the SDK generator reads; anything the table does not list is
// rejected. Rules run one at a time in table order (OPENAPI_RULE_IDS) and the first violation is reported.
// Passing this checker is not full OpenAPI or JSON Schema certification. It proves only the project subset, so
// sdk:generate, the Angular build, and real request and response tests are still required. The claim that the
// generator reads an accepted shape correctly covers only the shapes listed in AC-7 (subset-full.json).
// A new shape needs the rule table, the fixtures, and SDK evidence updated by the spec of the feature that needs it.
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Rule IDs in the row order of the "Aturan checker" table, which is also the evaluation order.
export const OPENAPI_RULE_IDS = [
  'document', 'version', 'info', 'path', 'method', 'operation', 'operation-id', 'tag',
  'parameter', 'request-body', 'response', 'component', 'schema', 'reference', 'security', 'required-operation',
] as const;
export type OpenApiRuleId = (typeof OPENAPI_RULE_IDS)[number];

export class OpenApiContractError extends Error {
  readonly rule: OpenApiRuleId;
  constructor(rule: OpenApiRuleId) {
    super(`OpenAPI contract rule ${rule}`);
    this.name = 'OpenApiContractError';
    this.rule = rule;
  }
}

/** Largest contract text in bytes: the validator reads at most this plus one byte, and the exporter never writes more. */
export const OPENAPI_MAX_BYTES = 8_388_608;

type Json = Record<string, unknown>;
type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
// Every key is read as an own property, so names such as `__proto__` and `constructor` stay ordinary keys.
const own = (value: Json, key: string): unknown => (Object.hasOwn(value, key) ? value[key] : undefined);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const onlyKeys = (value: Json, allowed: ReadonlySet<string>) => Object.keys(value).every(key => allowed.has(key));
const optional = (value: Json, key: string, test: (field: unknown) => boolean) => !Object.hasOwn(value, key) || test(value[key]);
const isString = (value: unknown) => typeof value === 'string';
const isBoolean = (value: unknown) => typeof value === 'boolean';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isScalar = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value);
const isReference = (value: unknown): value is Json => isRecord(value) && Object.hasOwn(value, '$ref');

function check(condition: unknown, rule: OpenApiRuleId): asserts condition {
  if (!condition) throw new OpenApiContractError(rule);
}

/**
 * Component check of an object with exactly one required `status` property: a string with the single literal `value`
 * through `const`, `enum`, or both, and `additionalProperties: false`. The shape of `getDevelopmentStatus`, which the
 * health entries of spec 0012 reuse.
 */
const statusOnly = (value: string) => (schema: Json): boolean => {
  const properties = own(schema, 'properties');
  const required = own(schema, 'required');
  if (own(schema, 'type') !== 'object' || own(schema, 'additionalProperties') !== false) return false;
  if (!Array.isArray(required) || required.length !== 1 || required[0] !== 'status') return false;
  if (!isRecord(properties) || Object.keys(properties).length !== 1) return false;
  const status = own(properties, 'status');
  if (!isRecord(status) || isReference(status) || own(status, 'type') !== 'string') return false;
  const values = own(status, 'enum');
  const hasConst = Object.hasOwn(status, 'const');
  const hasEnum = Object.hasOwn(status, 'enum');
  return (hasConst || hasEnum) && (!hasConst || own(status, 'const') === value) &&
    (!hasEnum || (Array.isArray(values) && values.length === 1 && values[0] === value));
};

/** Property names that an auth response model never holds, at any depth (spec 0014, *Operasi wajib baru*). */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set(['token', 'password', 'passwordHash', 'tokenHash']);

/**
 * Whether no property at any depth of `schema`, through `properties` and `items`, has a credential name. A reference
 * anywhere in the tree fails, since this pure check cannot follow it to see what the target holds. An explicit stack
 * keeps a deep tree from recursion.
 */
function withoutCredentialNames(schema: unknown): boolean {
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node)) continue;
    if (isReference(node)) return false;
    const properties = own(node, 'properties');
    if (isRecord(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        if (CREDENTIAL_NAMES.has(name)) return false;
        stack.push(child);
      }
    }
    if (Object.hasOwn(node, 'items')) stack.push(node['items']);
  }
  return true;
}

/** An inline object schema whose properties are exactly `names`, in any order. */
function exactObject(schema: unknown, names: readonly string[]): schema is Json {
  if (!isRecord(schema) || isReference(schema) || own(schema, 'type') !== 'object') return false;
  const properties = own(schema, 'properties');
  return isRecord(properties) && Object.keys(properties).length === names.length && names.every(name => Object.hasOwn(properties, name));
}

const AUTH_SESSION_NAMES = ['user', 'session', 'csrfToken'];

/**
 * Component check of `AuthSession` (spec 0014, *Operasi wajib baru*): an object with `additionalProperties: false`,
 * properties exactly `user`, `session`, and `csrfToken`, all of them required, and no property named `token`,
 * `password`, `passwordHash`, or `tokenHash` at any level.
 */
const authSessionModel = (schema: Json): boolean => {
  if (!exactObject(schema, AUTH_SESSION_NAMES) || own(schema, 'additionalProperties') !== false) return false;
  const required = own(schema, 'required');
  return Array.isArray(required) && required.length === AUTH_SESSION_NAMES.length &&
    AUTH_SESSION_NAMES.every(name => required.includes(name)) && withoutCredentialNames(schema);
};

/**
 * Component check of `AuthSessionList` (spec 0014, *Operasi wajib baru*): properties exactly `sessions`, an array of
 * objects whose properties are exactly `id`, `createdAt`, `lastSeenAt`, and `current`.
 */
const authSessionListModel = (schema: Json): boolean => {
  if (!exactObject(schema, ['sessions'])) return false;
  const sessions = (schema['properties'] as Json)['sessions'];
  if (!isRecord(sessions) || isReference(sessions) || own(sessions, 'type') !== 'array') return false;
  return exactObject(own(sessions, 'items'), ['id', 'createdAt', 'lastSeenAt', 'current']);
};

const SESSION_COOKIE_SECURITY = Object.freeze([Object.freeze({ sessionCookie: Object.freeze([]) as readonly string[] })]);

/**
 * Operations that every exported contract must contain. New entries come only from the spec of the feature
 * that owns the route, together with a test that proves the entry (spec 0008, "Tabel operasi wajib").
 */
export const REQUIRED_OPERATIONS: readonly Readonly<{
  path: string;
  method: HttpMethod;
  operationId: string;
  tag: string;
  /** Compared structurally with the `security` declared directly on the operation. */
  security: readonly Readonly<Record<string, readonly string[]>>[];
  successStatus: string;
  /** Name of the component that the success response references from `application/json`. */
  component: string;
  /** Pure check of that component schema. */
  checkComponent: (schema: Json) => boolean;
}>[] = Object.freeze([
  Object.freeze({
    path: '/api/status',
    method: 'get',
    operationId: 'getDevelopmentStatus',
    tag: 'development',
    security: Object.freeze([]),
    successStatus: '200',
    component: 'DevelopmentStatus',
    checkComponent: statusOnly('ok'),
  }),
  // Spec 0006, "Operasi wajib baru": the development readiness check.
  Object.freeze({
    path: '/api/readiness',
    method: 'get',
    operationId: 'getDevelopmentReadiness',
    tag: 'development',
    security: Object.freeze([]),
    successStatus: '200',
    component: 'ReadinessAvailable',
    checkComponent: (schema: Json) => {
      const names = ['status', 'checkedAt', 'appliedMigrations'];
      const properties = own(schema, 'properties');
      const required = own(schema, 'required');
      if (own(schema, 'type') !== 'object' || own(schema, 'additionalProperties') !== false) return false;
      if (!Array.isArray(required) || required.length !== names.length || !names.every(name => required.includes(name))) return false;
      if (!isRecord(properties) || Object.keys(properties).length !== names.length || !names.every(name => Object.hasOwn(properties, name))) return false;
      const status = own(properties, 'status');
      if (!isRecord(status) || isReference(status) || own(status, 'type') !== 'string') return false;
      const values = own(status, 'enum');
      const hasConst = Object.hasOwn(status, 'const');
      const hasEnum = Object.hasOwn(status, 'enum');
      if (!(hasConst || hasEnum) || (hasConst && own(status, 'const') !== 'available')) return false;
      if (hasEnum && !(Array.isArray(values) && values.length === 1 && values[0] === 'available')) return false;
      const checkedAt = own(properties, 'checkedAt');
      if (!isRecord(checkedAt) || isReference(checkedAt) || own(checkedAt, 'type') !== 'string' || own(checkedAt, 'format') !== 'date-time') return false;
      const applied = own(properties, 'appliedMigrations');
      return isRecord(applied) && !isReference(applied) && own(applied, 'type') === 'integer' && own(applied, 'minimum') === 0;
    },
  }),
  // Spec 0012, *Kontrak OpenAPI*: the backend health routes of both compositions.
  Object.freeze({
    path: '/health/live',
    method: 'get',
    operationId: 'getHealthLive',
    tag: 'health',
    security: Object.freeze([]),
    successStatus: '200',
    component: 'HealthLive',
    checkComponent: statusOnly('live'),
  }),
  Object.freeze({
    path: '/health/ready',
    method: 'get',
    operationId: 'getHealthReady',
    tag: 'health',
    security: Object.freeze([]),
    successStatus: '200',
    component: 'HealthReady',
    checkComponent: statusOnly('ready'),
  }),
  // Spec 0014, *Operasi wajib baru*: sign in and the two reads of the caller's session; the two 204 routes stay out.
  Object.freeze({
    path: '/api/auth/session',
    method: 'post',
    operationId: 'signIn',
    tag: 'auth',
    security: Object.freeze([]),
    successStatus: '200',
    component: 'AuthSession',
    checkComponent: authSessionModel,
  }),
  Object.freeze({
    path: '/api/auth/session',
    method: 'get',
    operationId: 'getAuthSession',
    tag: 'auth',
    security: SESSION_COOKIE_SECURITY,
    successStatus: '200',
    component: 'AuthSession',
    checkComponent: authSessionModel,
  }),
  Object.freeze({
    path: '/api/auth/sessions',
    method: 'get',
    operationId: 'listAuthSessions',
    tag: 'auth',
    security: SESSION_COOKIE_SECURITY,
    successStatus: '200',
    component: 'AuthSessionList',
    checkComponent: authSessionListModel,
  }),
]);

const DOCUMENT_KEYS = new Set(['openapi', 'info', 'paths', 'components', 'security', 'tags']);
const INFO_KEYS = new Set(['title', 'version', 'description']);
// Same list and order as HTTP_METHODS in @ojiepermana/angular 22.1.14 (sdk/src/parser/ir.js).
const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const OPERATION_KEYS = new Set(['operationId', 'tags', 'summary', 'description', 'deprecated', 'parameters', 'requestBody', 'responses', 'security']);
const TAG_KEYS = new Set(['name', 'description']);
const PARAMETER_KEYS = new Set(['name', 'in', 'schema', 'required', 'description']);
const PARAMETER_LOCATIONS = new Set(['path', 'query', 'header']);
const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean']);
const REQUEST_BODY_KEYS = new Set(['content', 'required', 'description']);
const RESPONSE_KEYS = new Set(['description', 'content']);
const COMPONENT_KEYS = new Set(['schemas', 'securitySchemes']);
const HTTP_SCHEME_KEYS = new Set(['type', 'scheme', 'bearerFormat', 'description']);
const API_KEY_SCHEME_KEYS = new Set(['type', 'name', 'in', 'description']);
const API_KEY_LOCATIONS = new Set(['header', 'query', 'cookie']);

// Name patterns follow kebabCase, camelCase, and pascalCase in the SDK generator, so two different names never
// become the same SDK file or symbol.
const OPERATION_ID = /^[a-z][a-z0-9]*([A-Z][a-z0-9]+)*$/;
const TAG_NAME = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;
const COMPONENT_NAME = /^[A-Z][a-z0-9]+([A-Z][a-z0-9]+)*$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PATH_TEMPLATE = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/;
const STATUS_CODE = /^[1-5][0-9]{2}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const SCHEMA_PREFIX = '#/components/schemas/';
const MAX_SCHEMA_DEPTH = 32;

const COMMON_SCHEMA_KEYS = ['type', 'title', 'description', 'default', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly'];
const SCHEMA_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['string', new Set([...COMMON_SCHEMA_KEYS, 'format', 'pattern', 'minLength', 'maxLength', 'enum', 'const'])],
  ['integer', new Set([...COMMON_SCHEMA_KEYS, 'minimum', 'maximum', 'enum', 'const'])],
  ['number', new Set([...COMMON_SCHEMA_KEYS, 'minimum', 'maximum', 'enum', 'const'])],
  ['boolean', new Set(COMMON_SCHEMA_KEYS)],
  ['object', new Set([...COMMON_SCHEMA_KEYS, 'properties', 'required', 'additionalProperties'])],
  ['array', new Set([...COMMON_SCHEMA_KEYS, 'items'])],
]);

/** Template names of a path that the `path` rule already accepted, in order. */
const templateNames = (path: string) => path.slice(1).split('/').flatMap(segment => PATH_TEMPLATE.exec(segment)?.[1] ?? []);

function validPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  const names = new Set<string>();
  for (const segment of path.slice(1).split('/')) {
    // Browsers and HttpClient resolve dot segments, so `/api/../admin` would reach `/admin` instead of the checked path.
    if (segment === '.' || segment === '..') return false;
    const template = PATH_TEMPLATE.exec(segment);
    if (template) {
      if (names.has(template[1]!)) return false;
      names.add(template[1]!);
    } else if (!PATH_SEGMENT.test(segment)) {
      return false;
    }
  }
  return true;
}

/** Media type map shared by `request-body` and `response`: each key is a media type, each value holds only `schema`. */
function checkContent(content: unknown, rule: OpenApiRuleId): asserts content is Json {
  check(isRecord(content), rule);
  for (const [media, value] of Object.entries(content)) {
    check(MEDIA_TYPE.test(media) && isRecord(value) && Object.hasOwn(value, 'schema') && onlyKeys(value, new Set(['schema'])), rule);
  }
}

const jsonSchema = (content: Json): unknown => {
  const media = own(content, 'application/json');
  return isRecord(media) ? own(media, 'schema') : undefined;
};

function fitsType(type: string, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  return isFiniteNumber(value);
}

/** One concrete schema node of the `schema` rule; its `properties` values and `items` are handed to `child`. */
function checkSchemaNode(node: unknown, componentRoot: boolean, child: (value: unknown) => void): void {
  if (isReference(node)) return; // Reference objects belong to the `reference` rule.
  check(isRecord(node), 'schema');
  const type = own(node, 'type');
  const allowed = typeof type === 'string' ? SCHEMA_KEYS.get(type) : undefined;
  check(allowed && Object.keys(node).every(key => allowed.has(key) || (key === '$id' && componentRoot)), 'schema');
  check(optional(node, 'title', isString) && optional(node, 'description', isString), 'schema');
  check(['deprecated', 'readOnly', 'writeOnly'].every(key => optional(node, key, isBoolean)), 'schema');
  check(optional(node, 'default', isScalar) && optional(node, 'example', isScalar), 'schema');
  check(optional(node, 'examples', value => Array.isArray(value) && value.every(isScalar)), 'schema');
  const ordered = (low: string, high: string, test: (value: unknown) => boolean) => {
    check(optional(node, low, test) && optional(node, high, test), 'schema');
    const min = own(node, low) as number | undefined;
    const max = own(node, high) as number | undefined;
    check(min === undefined || max === undefined || min <= max, 'schema');
  };
  if (type === 'string') {
    check(optional(node, 'format', nonempty), 'schema');
    check(optional(node, 'pattern', value => {
      if (typeof value !== 'string') return false;
      try {
        new RegExp(value); // Compiled only, never run.
        return true;
      } catch {
        return false;
      }
    }), 'schema');
    ordered('minLength', 'maxLength', value => Number.isInteger(value) && (value as number) >= 0);
  }
  if (type === 'integer' || type === 'number') ordered('minimum', 'maximum', isFiniteNumber);
  if (type === 'string' || type === 'integer' || type === 'number') {
    const values = own(node, 'enum');
    check(optional(node, 'enum', () => Array.isArray(values) && values.length > 0 && values.every(value => fitsType(type, value)) &&
      new Set(values).size === values.length), 'schema');
    check(optional(node, 'const', value => fitsType(type, value)), 'schema');
    if (Object.hasOwn(node, 'enum') && Object.hasOwn(node, 'const')) {
      check((values as unknown[]).length === 1 && (values as unknown[])[0] === own(node, 'const'), 'schema');
    }
  }
  if (type === 'object') {
    const properties = own(node, 'properties');
    check(optional(node, 'properties', isRecord), 'schema');
    if (isRecord(properties)) {
      for (const [name, value] of Object.entries(properties)) {
        check(nonempty(name) && name !== '__proto__', 'schema');
        child(value);
      }
    }
    const required = own(node, 'required');
    check(optional(node, 'required', () => Array.isArray(required) && new Set(required).size === required.length &&
      required.every(name => typeof name === 'string' && isRecord(properties) && Object.hasOwn(properties, name))), 'schema');
    check(optional(node, 'additionalProperties', isBoolean), 'schema');
  }
  if (type === 'array') {
    check(Object.hasOwn(node, 'items'), 'schema');
    child(node['items']);
  }
}

/**
 * Walks one schema tree with an explicit stack. The root is level 1, each step into a `properties` value or
 * `items` adds one, and the depth is checked while descending, so level 33 fails before it is read.
 */
function walkSchemaTree(root: unknown, componentRoot: boolean, visit: (node: unknown, componentRoot: boolean, child: (value: unknown) => void) => void) {
  const stack: [unknown, number, boolean][] = [[root, 1, componentRoot]];
  while (stack.length > 0) {
    const [node, depth, isComponentRoot] = stack.pop()!;
    visit(node, isComponentRoot, value => {
      check(depth < MAX_SCHEMA_DEPTH, 'schema');
      stack.push([value, depth + 1, false]);
    });
  }
}

/**
 * Runs every rule over the whole document in OPENAPI_RULE_IDS order and stops at the first violation,
 * so the reported rule is always the topmost rule the document breaks. Rules lower in the table rely on
 * structure that the rules above them already guarantee. The document is never changed.
 */
export function validateOpenApi(document: unknown): void {
  const doc = document as Json;
  const paths = () => doc['paths'] as Record<string, Json>;
  const operations = () => Object.entries(paths()).flatMap(([path, item]) =>
    Object.keys(item).filter(key => METHODS.has(key)).map(method => ({ path, method, operation: item[method] as Json })));
  const components = () => (isRecord(own(doc, 'components')) ? (doc['components'] as Json) : {});
  const schemas = (): Json => (isRecord(own(components(), 'schemas')) ? (components()['schemas'] as Json) : {});
  const securitySchemes = (): Json => (isRecord(own(components(), 'securitySchemes')) ? (components()['securitySchemes'] as Json) : {});
  /** Roots of every schema tree: parameter schemas, request and response media schemas, and component roots. */
  const schemaRoots = () => {
    const roots: { schema: unknown; component?: string }[] = [];
    for (const { operation } of operations()) {
      for (const parameter of (own(operation, 'parameters') ?? []) as Json[]) roots.push({ schema: parameter['schema'] });
      const body = own(operation, 'requestBody');
      if (isRecord(body)) for (const media of Object.values(body['content'] as Json)) roots.push({ schema: (media as Json)['schema'] });
      for (const response of Object.values(operation['responses'] as Record<string, Json>)) {
        if (Object.hasOwn(response, 'content')) for (const media of Object.values(response['content'] as Json)) roots.push({ schema: (media as Json)['schema'] });
      }
    }
    for (const [name, schema] of Object.entries(schemas())) roots.push({ schema, component: name });
    return roots;
  };

  const rules: Record<OpenApiRuleId, () => void> = {
    document: () => {
      check(isRecord(document) && onlyKeys(document, DOCUMENT_KEYS), 'document');
      check(['openapi', 'info', 'paths'].every(key => Object.hasOwn(document, key)), 'document');
    },
    version: () => check(own(doc, 'openapi') === '3.1.0', 'version'),
    info: () => {
      const info = own(doc, 'info');
      check(isRecord(info) && onlyKeys(info, INFO_KEYS), 'info');
      check(nonempty(own(info, 'title')) && nonempty(own(info, 'version')) && optional(info, 'description', isString), 'info');
    },
    path: () => {
      const value = own(doc, 'paths');
      check(isRecord(value) && Object.keys(value).length > 0, 'path');
      for (const [path, item] of Object.entries(value)) check(validPath(path) && isRecord(item) && !Object.hasOwn(item, '$ref'), 'path');
    },
    method: () => {
      for (const item of Object.values(paths())) {
        let methods = 0;
        for (const [key, value] of Object.entries(item)) {
          if (METHODS.has(key)) methods++;
          else check((key === 'summary' || key === 'description') && typeof value === 'string', 'method');
        }
        check(methods > 0, 'method');
      }
    },
    operation: () => {
      for (const { operation } of operations()) {
        check(isRecord(operation) && onlyKeys(operation, OPERATION_KEYS), 'operation');
        check(optional(operation, 'summary', isString) && optional(operation, 'description', isString) && optional(operation, 'deprecated', isBoolean), 'operation');
      }
    },
    'operation-id': () => {
      const seen = new Set<string>();
      for (const { operation } of operations()) {
        const id = own(operation, 'operationId');
        check(typeof id === 'string' && OPERATION_ID.test(id) && !seen.has(id), 'operation-id');
        seen.add(id);
      }
    },
    tag: () => {
      const declared = new Set<string>();
      const tags = own(doc, 'tags');
      check(optional(doc, 'tags', Array.isArray), 'tag');
      for (const tag of (tags ?? []) as unknown[]) {
        check(isRecord(tag) && onlyKeys(tag, TAG_KEYS) && optional(tag, 'description', isString), 'tag');
        const name = own(tag, 'name');
        check(typeof name === 'string' && TAG_NAME.test(name) && !declared.has(name), 'tag');
        declared.add(name);
      }
      for (const { operation } of operations()) {
        const names = own(operation, 'tags');
        check(Array.isArray(names) && names.length === 1 && typeof names[0] === 'string' && declared.has(names[0]), 'tag');
      }
    },
    parameter: () => {
      for (const { path, operation } of operations()) {
        const parameters = own(operation, 'parameters');
        check(optional(operation, 'parameters', Array.isArray), 'parameter');
        // The SDK merges every parameter and the body into one `<Operation>$Params` object, so names are unique
        // without regard to case and `body` is already taken.
        const names = new Set(['body']);
        const pathNames = new Set<string>();
        for (const parameter of (parameters ?? []) as unknown[]) {
          check(isRecord(parameter) && onlyKeys(parameter, PARAMETER_KEYS) && Object.hasOwn(parameter, 'schema'), 'parameter');
          const name = own(parameter, 'name');
          const location = own(parameter, 'in');
          const schema = own(parameter, 'schema');
          check(nonempty(name) && typeof location === 'string' && PARAMETER_LOCATIONS.has(location), 'parameter');
          check(optional(parameter, 'required', isBoolean) && optional(parameter, 'description', isString), 'parameter');
          check(!names.has(name.toLowerCase()), 'parameter');
          names.add(name.toLowerCase());
          check(isRecord(schema) && !isReference(schema) && SCALAR_TYPES.has(own(schema, 'type') as string), 'parameter');
          if (location === 'path') {
            check(own(parameter, 'required') === true, 'parameter');
            pathNames.add(name);
          }
        }
        const templates = templateNames(path);
        check(templates.length === pathNames.size && templates.every(name => pathNames.has(name)), 'parameter');
      }
    },
    'request-body': () => {
      for (const { operation } of operations()) {
        if (!Object.hasOwn(operation, 'requestBody')) continue;
        const body = operation['requestBody'];
        check(isRecord(body) && onlyKeys(body, REQUEST_BODY_KEYS) && Object.hasOwn(body, 'content'), 'request-body');
        check(optional(body, 'required', isBoolean) && optional(body, 'description', isString), 'request-body');
        checkContent(body['content'], 'request-body');
        check(isReference(jsonSchema(body['content'])), 'request-body');
      }
    },
    response: () => {
      for (const { operation } of operations()) {
        const responses = own(operation, 'responses');
        check(isRecord(responses), 'response');
        let success = 0;
        for (const [status, response] of Object.entries(responses)) {
          check(STATUS_CODE.test(status), 'response');
          if (status.startsWith('2')) success++;
          check(isRecord(response) && onlyKeys(response, RESPONSE_KEYS) && nonempty(own(response, 'description')), 'response');
          if (status === '204') {
            check(!Object.hasOwn(response, 'content'), 'response');
            continue;
          }
          check(Object.hasOwn(response, 'content'), 'response');
          const content = response['content'];
          checkContent(content, 'response');
          check(Object.keys(content).length > 0, 'response');
          if (status.startsWith('2')) check(isReference(jsonSchema(content)), 'response');
        }
        check(success === 1, 'response');
      }
    },
    component: () => {
      if (!Object.hasOwn(doc, 'components')) return;
      const value = doc['components'];
      check(isRecord(value) && onlyKeys(value, COMPONENT_KEYS), 'component');
      check(optional(value, 'schemas', isRecord) && optional(value, 'securitySchemes', isRecord), 'component');
      for (const [name, schema] of Object.entries(schemas())) {
        check(COMPONENT_NAME.test(name) && isRecord(schema) && !isReference(schema), 'component');
        const type = own(schema, 'type');
        check(type === 'object' || type === 'array' || ((type === 'string' || type === 'integer' || type === 'number') && Object.hasOwn(schema, 'enum')), 'component');
        check(optional(schema, '$id', id => id === `${SCHEMA_PREFIX}${name}`), 'component');
      }
    },
    schema: () => {
      for (const { schema, component } of schemaRoots()) walkSchemaTree(schema, component !== undefined, checkSchemaNode);
    },
    reference: () => {
      const targets = schemas();
      const target = (reference: Json): string => {
        const ref = own(reference, '$ref');
        check(Object.keys(reference).length === 1 && typeof ref === 'string' && ref.startsWith(SCHEMA_PREFIX), 'reference');
        const name = ref.slice(SCHEMA_PREFIX.length);
        check(Object.hasOwn(targets, name), 'reference');
        return name;
      };
      // Every reference is checked once where it appears; targets are never expanded in place.
      const edges = new Map<string, string[]>();
      for (const { schema, component } of schemaRoots()) {
        const found: string[] = [];
        walkSchemaTree(schema, false, (node, _root, child) => {
          if (isReference(node)) {
            found.push(target(node));
            return;
          }
          const properties = own(node as Json, 'properties');
          if (isRecord(properties)) Object.values(properties).forEach(child);
          if (Object.hasOwn(node as Json, 'items')) child((node as Json)['items']);
        });
        if (component !== undefined) edges.set(component, found);
      }
      // Three colour cycle detection with an explicit stack: each component is entered once, and a long chain
      // of components never uses recursion. Reaching a component that is still open means a cycle.
      const OPEN = 1;
      const DONE = 2;
      const state = new Map<string, number>();
      for (const start of edges.keys()) {
        if (state.has(start)) continue;
        state.set(start, OPEN);
        const stack: [string, number][] = [[start, 0]];
        while (stack.length > 0) {
          const top = stack[stack.length - 1]!;
          const next = edges.get(top[0])![top[1]++];
          if (next === undefined) {
            state.set(top[0], DONE);
            stack.pop();
            continue;
          }
          check(state.get(next) !== OPEN, 'reference');
          if (!state.has(next)) {
            state.set(next, OPEN);
            stack.push([next, 0]);
          }
        }
      }
    },
    security: () => {
      const schemes = securitySchemes();
      for (const scheme of Object.values(schemes)) {
        check(isRecord(scheme) && !isReference(scheme), 'security');
        const type = own(scheme, 'type');
        if (type === 'http') {
          check(onlyKeys(scheme, HTTP_SCHEME_KEYS) && nonempty(own(scheme, 'scheme')), 'security');
          check(optional(scheme, 'bearerFormat', isString) && optional(scheme, 'description', isString), 'security');
        } else {
          const location = own(scheme, 'in');
          check(type === 'apiKey' && onlyKeys(scheme, API_KEY_SCHEME_KEYS) && nonempty(own(scheme, 'name')), 'security');
          check(typeof location === 'string' && API_KEY_LOCATIONS.has(location) && optional(scheme, 'description', isString), 'security');
        }
      }
      const requirements = (value: unknown) => {
        check(Array.isArray(value), 'security');
        for (const requirement of value) {
          check(isRecord(requirement) && Object.keys(requirement).length > 0, 'security');
          for (const [name, scopes] of Object.entries(requirement)) {
            check(Object.hasOwn(schemes, name) && Array.isArray(scopes) && scopes.length === 0, 'security');
          }
        }
      };
      // The document requirement is always checked, even when every operation declares its own.
      if (Object.hasOwn(doc, 'security')) requirements(doc['security']);
      // Every operation declares its own security. Inheriting the document value would let a protected route that
      // forgot `detail.security` pass as public, because app.ts sets the document value to `[]`.
      for (const { operation } of operations()) {
        check(Object.hasOwn(operation, 'security'), 'security');
        requirements(operation['security']);
      }
    },
    'required-operation': () => {
      for (const entry of REQUIRED_OPERATIONS) {
        const item = own(paths(), entry.path);
        const operation = isRecord(item) ? own(item, entry.method) : undefined;
        check(isRecord(operation) && own(operation, 'operationId') === entry.operationId, 'required-operation');
        check((operation['tags'] as string[])[0] === entry.tag, 'required-operation');
        check(Object.hasOwn(operation, 'security') && sameRequirements(operation['security'] as Json[], entry.security), 'required-operation');
        const response = own(operation['responses'] as Json, entry.successStatus);
        const schema = isRecord(response) && isRecord(own(response, 'content')) ? jsonSchema(response['content'] as Json) : undefined;
        check(isReference(schema) && schema['$ref'] === `${SCHEMA_PREFIX}${entry.component}`, 'required-operation');
        const component = own(schemas(), entry.component);
        check(isRecord(component) && entry.checkComponent(component), 'required-operation');
      }
    },
  };
  for (const rule of OPENAPI_RULE_IDS) rules[rule]();
}

/** Structural comparison of security requirement arrays that the `security` rule already accepted. */
function sameRequirements(actual: readonly Json[], expected: readonly Readonly<Record<string, readonly string[]>>[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((requirement, index) => {
    const wanted = expected[index]!;
    const names = Object.keys(requirement);
    return names.length === Object.keys(wanted).length && names.every(name => {
      const scopes = requirement[name] as unknown[];
      const wantedScopes = Object.hasOwn(wanted, name) ? wanted[name]! : undefined;
      return wantedScopes !== undefined && scopes.length === wantedScopes.length && scopes.every((scope, i) => scope === wantedScopes[i]);
    });
  });
}

// Reads one contract file without trusting it: the path must be a regular file (checked before and after
// opening, without blocking on a FIFO), and at most OPENAPI_MAX_BYTES plus one byte is ever read.
async function readContract(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > OPENAPI_MAX_BYTES) throw new Error('Unsupported contract input');
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Unsupported contract input');
    const buffer = new Uint8Array(OPENAPI_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > OPENAPI_MAX_BYTES) throw new Error('Contract input too large');
    // ignoreBOM keeps a leading byte order mark in the text, so JSON.parse rejects it as the SDK generator does.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)));
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) throw new Error('Too many arguments');
    validateOpenApi(await readContract(args[0] ?? fileURLToPath(new URL('../openapi.json', import.meta.url))));
    console.log('OpenAPI project checks passed');
  } catch (error) {
    // Fixed text only: never the document, a field value, the path, a parser message, or a stack.
    console.error(error instanceof OpenApiContractError ? `OpenAPI validation failed\nrule: ${error.rule}` : 'OpenAPI validation failed');
    process.exitCode = 1;
  }
}
