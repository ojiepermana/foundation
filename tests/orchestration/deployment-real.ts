import { randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { connect as http2Connect } from 'node:http2';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { connect as tlsConnect } from 'node:tls';
import { dirname, join, resolve } from 'node:path';
import { checkFrontendBundle, FrontendBundleError } from '../../scripts/lib/frontend-bundle.ts';
import { DEPLOYMENT_CHECKS, gitCommit, sourceTree, stepEnvironment, type DeploymentCheckName } from '../../scripts/lib/gate.ts';
import { runProcessGroup, type ProcessGroupOptions, type ProcessGroupResult } from '../../scripts/lib/process-group.ts';

// `bun run test:deployment:real` (spec 0012, *Urutan orkestrasi*): builds the three images from a copy of the build
// inputs in a `mkdtemp` folder, then follows the documented deployment steps on project `foundation-deploy-<hex>` with
// deploy/compose.yaml plus the test override, and writes `.local/feature-13/result.json` with every check of
// DEPLOYMENT_CHECKS in order. In order: (1) the tool checks and the base image pins of the three Dockerfiles, (2) the
// copy with sentinel files, a temporary CA with an edge certificate, three random passwords, and the Compose env file,
// (3) the pulls by digest and the PostgreSQL image, (4) the context probes, the three builds with run labels, the AC-2
// scan of each image (export, history, inspect, and checkFrontendBundle), and images.json, (5) postgres, provisioning,
// backend, readiness 503, the default runner command, migration, rerun, seed, readiness 200, the edge and `GET /` 200,
// (6) the declaration without the override, the TLS, redirect, header, cache, API, CORS, edge error, and health checks
// of the edge, the upstream stub, the inspect and network checks, the reachability probes with the public control,
// the browser flow DEP-006, backend shutdown and restart, recreate, database outage, edge shutdown, the log checks,
// and `compose stop` of the whole topology, and (7) cleanup on every exit path, a signal and the total deadline
// included, then artifact-scan.json and result.json. Docker is only called through `dockerArgs`, with an argument
// array, through `runProcessGroup`. Cleanup removes only the project, containers, images, and folder this run created,
// by explicit name that passes the guards, the named containers before the project. The console prints fixed lines,
// check and reason codes, and resource names of the run; command output is printed only redacted when a step fails.
// This file lives in tests/, not scripts/, because INFRA-001 of spec 0002 keeps scripts/ free of Docker.

export const EVIDENCE_ROOT = '.local/feature-13';
/** Evidence of this step (*Bukti langkah deployment*); removed before a run so a stale file is never read as this run's. */
export const EVIDENCE_PATHS = ['result.json', 'images.json', 'playwright-deployment.xml', 'artifact-scan.json', 'test-results'] as const;
export const COMPOSE_FILE = 'deploy/compose.yaml';
export const COMPOSE_TEST_FILE = 'tests/integration/deployment/compose.test.yml';
/** The root Compose file, used here only to build the PostgreSQL image (spec 0011, *Pemeriksaan sebelum run* (6)). */
export const ROOT_COMPOSE_FILE = 'docker-compose.yml';
export const POSTGRES_IMAGE = 'foundation-postgres:18-pinned';
export const POSTGRES_PINS_PATH = 'infrastructure/postgres/pins.json';
export const BUN_PINS_PATH = 'tests/performance/images.json';
export const MIGRATIONS_DIR = 'database/migrations';
export const TEXT_LIMIT = 200;
/** *Batas waktu perintah*: total run limit from the start; cleanup still runs after it. */
export const DEPLOYMENT_DEADLINE_MS = 1_200_000;

/** *Batas waktu perintah*, in milliseconds. */
export const TIMEOUTS = Object.freeze({
  /** `version`, `info`, `buildx version`, `compose version`, `config`, `ps`, `port`, the inspects, `history`, `openssl version`. */
  query: 30_000,
  /** One `openssl req` that issues the temporary CA or the edge certificate; the table names no limit, so the `openssl version` one. */
  certificate: 30_000,
  pull: 300_000,
  /** One build of *Probe konteks*. */
  contextProbe: 120_000,
  /** `docker create`, `export`, `tar`, and `rm` of the AC-2 scan, per image. */
  imageScan: 120_000,
  build: Object.freeze({ frontend: 900_000, backend: 600_000, migrate: 300_000 }),
  postgresBuild: 900_000,
  composeUp: 180_000,
  composeRun: 120_000,
  /** `compose exec`, a probe, and one `fetch` (or one raw HTTP request to the edge). */
  exec: 15_000,
  /** One `openssl s_client` call. */
  tls: 15_000,
  /** One `docker logs` call. */
  logs: 15_000,
  /** The `fetch` to `/api/stub/hang`. */
  stubHang: 20_000,
  /** `docker run -d` of the stub and `compose run -d` of the edge stub. */
  stubStart: 60_000,
  readinessWait: 60_000,
  /** Wait for `GET /` 200 of the edge; the edge stub gets the same wait for its first stub answer. */
  edgeRootWait: 30_000,
  playwright: 300_000,
  composeStop: 60_000,
  down: 90_000,
  removeContainers: 15_000,
  removeImages: 30_000,
});

/** The windows of AC-4 and AC-9, in milliseconds, counted from the end of the command named. */
export const WINDOWS = Object.freeze({
  /** `compose stop backend` ends within this. */
  backendStop: 6_000,
  /** After `stop backend`: 502 or 504 while the edge resolves the name again, then 502 only. */
  reresolve: 15_000,
  /** Samples of `/api/status` taken after `reresolve`, to show the answer stays 502. */
  stoppedTail: 3_000,
  /** One `/api/status` request every 500 ms. */
  apiInterval: 500,
  /** `/api/status` reaches the backend again after `start backend` and after the recreate. */
  forwardAgain: 20_000,
  /** `/health/ready` answers 503 after `stop postgres`. */
  readyLost: 6_000,
  /** `/health/ready` answers 200 again after `start postgres`. */
  readyBack: 30_000,
  /** `compose stop edge` ends within this. */
  edgeStop: 15_000,
});

/** Reason codes of `result.json` (*Isi result.json*). */
export const DEPLOYMENT_REASON_CODES = [
  'pin_invalid',
  'tool_missing',
  'image_pull_failed',
  'image_build_failed',
  'postgres_image_failed',
  'compose_failed',
  'check_failed',
  'egress_control_failed',
  'browser_failed',
  'artifact_scan_findings',
  'cleanup_failed',
  'timeout',
  'signal',
] as const;
export type DeploymentReasonCode = (typeof DEPLOYMENT_REASON_CODES)[number];

export const BOUNDARY =
  'Topologi rujukan satu host Docker dengan sertifikat dari CA sementara; bukan bukti platform deployment, kapasitas, image di registry, atau ketiadaan kerentanan paket OS di image (paket OS ketiga image tidak dipindai pemindai kerentanan).';

export type ImageName = 'frontend' | 'backend' | 'migrate';

/** The three images of the *Image* table, with the base repositories each Dockerfile may name (*Image dasar*). */
export const IMAGES: readonly Readonly<{ name: ImageName; dockerfile: string; repository: string; bases: readonly string[] }>[] = Object.freeze([
  Object.freeze({ name: 'frontend', dockerfile: 'apps/frontend/Dockerfile', repository: 'foundation-frontend', bases: Object.freeze(['node', 'oven/bun', 'nginx']) }),
  Object.freeze({ name: 'backend', dockerfile: 'apps/backend/Dockerfile', repository: 'foundation-backend', bases: Object.freeze(['oven/bun']) }),
  Object.freeze({ name: 'migrate', dockerfile: 'database/Dockerfile', repository: 'foundation-migrate', bases: Object.freeze(['oven/bun']) }),
]);

/**
 * *Daftar izin konteks build*: per ignore file, the paths it brings back after `*` and its extra exclusions; every file
 * also ends with `**\/.env` and `**\/.env.*`. A path ending with `/` is a folder, and `*` matches within one segment.
 */
export const CONTEXT_ALLOWLIST: Readonly<Record<string, Readonly<{ include: readonly string[]; exclude: readonly string[] }>>> = Object.freeze({
  'apps/frontend/Dockerfile.dockerignore': Object.freeze({
    include: Object.freeze([
      'package.json',
      'bun.lock',
      'apps/frontend/angular.json',
      'apps/frontend/tsconfig.json',
      'apps/frontend/tsconfig.app.json',
      'apps/frontend/tsconfig.spec.json',
      'apps/frontend/.postcssrc.json',
      'apps/frontend/src/',
      'apps/frontend/public/',
      'apps/frontend/sdk/',
      'apps/frontend/edge/',
    ]),
    exclude: Object.freeze(['**/*.spec.ts', '**/*.test.ts']),
  }),
  'apps/backend/Dockerfile.dockerignore': Object.freeze({
    include: Object.freeze(['package.json', 'bun.lock', 'apps/backend/src/', 'libs/server/']),
    exclude: Object.freeze(['**/*.spec.ts', '**/*.test.ts']),
  }),
  'database/Dockerfile.dockerignore': Object.freeze({
    include: Object.freeze(['database/*.ts', 'database/migrations/', 'database/seeds/', 'libs/server/database/']),
    exclude: Object.freeze([]),
  }),
});

/** Inputs copied from the working tree: every allow listed path plus the three Dockerfiles and their ignore files. */
export function buildInputs(): string[] {
  const inputs = new Set<string>();
  for (const { include } of Object.values(CONTEXT_ALLOWLIST)) for (const path of include) inputs.add(path);
  for (const image of IMAGES) {
    inputs.add(image.dockerfile);
    inputs.add(`${image.dockerfile}.dockerignore`);
  }
  return [...inputs].sort();
}

/** *Sentinel konteks build*: one random value per file, planted in the copy, never in the checkout. */
export const SENTINEL_PATHS: readonly string[] = Object.freeze([
  '.env',
  '.env.deploy',
  '.env.infrastructure',
  'apps/frontend/.env',
  'apps/frontend/src/.env',
  'apps/frontend/edge/.env.local',
  'apps/backend/.env',
  'apps/backend/src/.env.production',
  'libs/server/.env',
  'database/.env',
  'database/migrations/.env',
  '.local/sentinel.txt',
]);

/** Names the copy never takes from the checkout at any level (AC-2). */
export function copySkipped(name: string): boolean {
  return name === 'node_modules' || name === 'dist' || name === '.angular' || /^\.env(\..*)?$/.test(name);
}

// ---------------------------------------------------------------------------------------------------------------
// The edge contract (AC-5, AC-6, AC-7): the values of *Header dokumen*, *Header API*, *Cache dan fallback*, and
// *Header alamat client*, in the form the checks compare. Header names are lower case, as fetch reports them.

/** `Content-Security-Policy` of *Header dokumen*; DEP-001 compares apps/frontend/edge/document-headers.conf with it. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types angular angular#bundler angular#components";
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";
export const HSTS = 'max-age=31536000';

/** *Header dokumen* without `X-Request-Id`, which must be 32 lower case hex digits (`$request_id`). */
export const DOCUMENT_HEADERS: readonly (readonly [string, string])[] = Object.freeze([
  ['content-security-policy', CONTENT_SECURITY_POLICY],
  ['strict-transport-security', HSTS],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-resource-policy', 'same-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
] as const);

/** *Header API* without `X-Request-Id`. */
export const API_HEADERS: readonly (readonly [string, string])[] = Object.freeze([
  ['content-security-policy', API_CONTENT_SECURITY_POLICY],
  ['strict-transport-security', HSTS],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['cross-origin-resource-policy', 'same-origin'],
] as const);

/** *Header alamat client*: the edge sends none of them to the backend. */
export const CLIENT_ADDRESS_HEADERS: readonly string[] = Object.freeze([
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Forwarded-Port',
  'X-Forwarded-Prefix',
  'X-Original-Forwarded-For',
  'X-Real-IP',
  'X-Client-IP',
  'True-Client-IP',
  'CF-Connecting-IP',
  'Fastly-Client-IP',
  'X-Cluster-Client-IP',
  'Forwarded',
]);

/** Bodies of the JSON answers the edge makes itself for /api/ (AC-7). */
export const EDGE_ERROR_BODIES: Readonly<Record<400 | 413 | 502 | 504, string>> = Object.freeze({
  400: '{"error":"Invalid request"}',
  413: '{"error":"Payload too large"}',
  502: '{"error":"Bad gateway"}',
  504: '{"error":"Gateway timeout"}',
});

/** The same limit as `client_max_body_size 1k` and `maxRequestBodySize: 1024` of the backend (AC-7). */
export const BODY_LIMIT_BYTES = 1024;
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** First row of *Cache dan fallback*. */
export const HASHED_ASSET = /^\/(main|chunk|styles|polyfills)-[A-Za-z0-9_-]{8}\.(js|css)$/;
/** TLS 1.2 ciphers of the *Listener HTTPS* row; a TLS 1.2 handshake must settle on one of them. */
export const TLS12_CIPHERS: readonly string[] = Object.freeze([
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
]);

/**
 * Request targets of `/api/` that the edge rejects with 400 without forwarding (AC-7): a `.` or `..` segment, `%2e`,
 * `%2f`, or `%5c` in lower and upper case, and `\`. They are sent as raw HTTP/1.1 request lines, because a WHATWG URL
 * parser (fetch) would remove the dot segments and turn `\` into `/` before the edge sees them. Each one still selects
 * `location ^~ /api/` after nginx normalizes the path.
 */
export const TRAVERSAL_TARGETS: readonly string[] = Object.freeze([
  '/api/a/../status',
  '/api/./status',
  '/api/status/..',
  '/health/live/../../api/status',
  '/api/%2e%2e/api/status',
  '/api/%2E%2E/api/status',
  '/api/%2e/status',
  '/api/%2E/status',
  '/api/a%2fb',
  '/api/a%2Fb',
  '/api/a%5cb',
  '/api/a%5Cb',
  '/api/a\\b',
]);

/**
 * Targets of check health_not_public that nginx normalizes to a path outside /api/ (AC-4, AC-7, decision 62): each
 * one gets index.html 200 with *Header dokumen* and an empty `upstreamStatus`, so no URL reaches a /health/ route of
 * the backend. They are sent as raw request lines, because fetch would resolve the dot segments itself.
 */
export const HEALTH_DOCUMENT_TARGETS: readonly string[] = Object.freeze([
  '/health/live',
  '/health/ready',
  '/health/live/',
  '//health/ready',
  '/api/../health/live',
  '/api/%2e%2e/health/ready',
  '/api/x/..%2f..%2fhealth/live',
]);

/** Targets of check health_not_public that stay under /api/: the backend answers 404 JSON with *Header API*. */
export const HEALTH_API_TARGETS: readonly string[] = Object.freeze(['/api/health/live', '/api/health/ready']);

/**
 * A raw path that climbs above the root (AC-7): nginx rejects it with its default 400 before a location is chosen, so
 * the answer carries *Header dokumen*, `Server: nginx` without a version, and no upstream (check edge_errors). Its edge
 * log line has status 400 and an empty path and upstreamStatus, because `$request_uri` is not set yet (AC-10,
 * decision 66).
 */
export const ABOVE_ROOT_TARGETS: readonly string[] = Object.freeze(['/api/../../x']);

/** One answer through the edge with the `upstreamStatus` of its edge log line (`null` when the line is missing). */
export type LoggedAnswer = Readonly<{ target: string; answer: EdgeAnswer | null; upstream: string | null }>;

const headerOf = (answer: EdgeAnswer, name: string): string | undefined => headerValues(answer.headers, name)[0];

/**
 * Check health_not_public (AC-4, AC-7): every target normalized outside /api/ is index.html 200 (the same body as
 * `/index.html`) with *Header dokumen* and an empty `upstreamStatus`; every /api/health target is the backend 404
 * `{"error":"Not found"}` as JSON with *Header API* and `upstreamStatus` 404. `indexBody` is `null` when `/index.html`
 * itself had no 200 answer, which fails every document target.
 */
export function healthNotPublicProblems(documents: readonly LoggedAnswer[], api: readonly LoggedAnswer[], indexBody: string | null): string[] {
  const problems: string[] = [];
  for (const { target, answer, upstream } of documents) {
    if (answer === null) problems.push(`${target} tanpa jawaban`);
    else if (answer.status !== 200 || indexBody === null || answer.body !== indexBody) problems.push(`${target} ${answer.status} bukan index.html 200`);
    else {
      for (const problem of documentHeaderProblems(answer.headers)) problems.push(`${target}: ${problem}`);
      if (upstream === null) problems.push(`${target} tidak ada di log edge`);
      else if (upstream !== '') problems.push(`${target} upstreamStatus ${upstream}, diharapkan kosong`);
    }
  }
  for (const { target, answer, upstream } of api) {
    if (answer === null) problems.push(`${target} tanpa jawaban`);
    else if (answer.status !== 404 || answer.body !== '{"error":"Not found"}' || !(headerOf(answer, 'content-type') ?? '').startsWith('application/json')) {
      problems.push(`${target} ${answer.status} bukan 404 JSON backend`);
    } else {
      for (const problem of apiHeaderProblems(answer.headers)) problems.push(`${target}: ${problem}`);
      if (upstream === null) problems.push(`${target} tidak ada di log edge`);
      else if (upstream !== '404') problems.push(`${target} upstreamStatus ${upstream === '' ? 'kosong' : upstream}, diharapkan 404 dari backend`);
    }
  }
  return problems;
}

/**
 * The default 400 nginx makes before a location is chosen (AC-7): a request header above `large_client_header_buffers`
 * or a path above the root. The answer carries *Header dokumen*, `Server: nginx` and a body without a version, and no
 * `Access-Control-*` header. With `line` given (not `undefined`), the edge log line with the `X-Request-Id` of the
 * answer (`null` when it is missing) must exist with status 400 and an empty `path` and `upstreamStatus` (AC-10,
 * decision 66). The method is not judged: it is empty for an HTTP/2 stream that sends `:path` before `:method`.
 */
export function nginxDefault400Problems(label: string, answer: EdgeAnswer | null, line?: EdgeLogLine | null): string[] {
  if (answer === null) return [`${label} tanpa jawaban`];
  if (answer.status !== 400) return [`${label} ${answer.status}, diharapkan 400`];
  const problems = documentHeaderProblems(answer.headers).map((problem) => `${label}: ${problem}`);
  if (headerOf(answer, 'server') !== 'nginx' || !answer.body.includes('<center>nginx</center>') || /nginx\/[0-9]/.test(answer.body)) {
    problems.push(`${label} tanpa Server: nginx atau dengan versi`);
  }
  if (line === null) problems.push(`${label} tidak ada di log edge`);
  else if (line !== undefined) {
    if (line.status !== 400) problems.push(`${label} baris log edge status ${line.status}, diharapkan 400`);
    if (line.path !== '') problems.push(`${label} baris log edge path ${line.path}, diharapkan kosong`);
    if (line.upstreamStatus !== '') problems.push(`${label} diteruskan ke upstream`);
  }
  return problems;
}

export type HeaderList = readonly (readonly [string, string])[];

/** Every value of header `name` (lower case) in `headers`; fetch joins repeated headers into one value with `, `. */
export function headerValues(headers: HeaderList, name: string): string[] {
  return headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
}

const REQUEST_ID = /^[0-9a-f]{32}$/;
const DOCUMENT_ONLY = ['x-frame-options', 'cross-origin-opener-policy', 'permissions-policy'];

function exactHeaderProblems(headers: HeaderList, expected: HeaderList): string[] {
  const problems: string[] = [];
  for (const [name, value] of expected) {
    const values = headerValues(headers, name);
    if (values.length !== 1 || values[0] !== value) problems.push(`${name} ${values.length === 0 ? 'tidak ada' : 'tidak tepat'}`);
  }
  const ids = headerValues(headers, 'x-request-id');
  if (ids.length !== 1 || !REQUEST_ID.test(ids[0]!)) problems.push('x-request-id tidak 32 heksadesimal');
  return problems;
}

/** Header names that start with `access-control-` (AC-7: no edge or backend answer has one). */
export function corsHeaders(headers: HeaderList): string[] {
  return headers.map(([name]) => name.toLowerCase()).filter((name) => name.startsWith('access-control-'));
}

/** *Header dokumen*: each value exactly once, `X-Request-Id` of 32 hex digits, and no `Access-Control-*` header. */
export function documentHeaderProblems(headers: HeaderList): string[] {
  return [...exactHeaderProblems(headers, DOCUMENT_HEADERS), ...corsHeaders(headers).map((name) => `${name} ada`)];
}

/** *Header API*: each value exactly once, no header that only documents carry, and no `Access-Control-*` header. */
export function apiHeaderProblems(headers: HeaderList): string[] {
  return [
    ...exactHeaderProblems(headers, API_HEADERS),
    ...DOCUMENT_ONLY.filter((name) => headerValues(headers, name).length > 0).map((name) => `${name} ada`),
    ...corsHeaders(headers).map((name) => `${name} ada`),
  ];
}

export type EdgeAnswer = { status: number; headers: HeaderList; body: string; elapsedMs: number };

function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('latin1').split(';')[0]!.trim(), 16);
    if (!Number.isInteger(size) || size <= 0) break;
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/** One HTTP/1.x answer read until the server closed: status, header lines in order, and the body (chunked decoded). */
export function parseHttpAnswer(raw: Uint8Array): Omit<EdgeAnswer, 'elapsedMs'> | null {
  const bytes = Buffer.from(raw);
  const end = bytes.indexOf('\r\n\r\n');
  if (end === -1) return null;
  const [statusLine, ...lines] = bytes.subarray(0, end).toString('latin1').split('\r\n');
  const match = /^HTTP\/1\.[01] ([0-9]{3})(?: .*)?$/.exec(statusLine ?? '');
  if (match === null) return null;
  const headers = lines.map((line): [string, string] => {
    const colon = line.indexOf(':');
    return colon === -1 ? [line.trim().toLowerCase(), ''] : [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  });
  let body: Buffer = bytes.subarray(end + 4);
  if (headerValues(headers, 'transfer-encoding').some((value) => value.toLowerCase().includes('chunked'))) body = dechunk(body);
  return { status: Number(match[1]), headers, body: body.toString('utf8') };
}

/** One access log line of the edge, with the key types of AC-10; `null` for any other line. */
export type EdgeLogLine = { time: string; requestId: string; method: string; path: string; status: number; bytes: number; requestTime: number; upstreamStatus: string; upstreamTime: string };

export function parseEdgeLogLine(line: string): EdgeLogLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const strings = ['time', 'requestId', 'method', 'path', 'upstreamStatus', 'upstreamTime'] as const;
  if (strings.some((key) => typeof record[key] !== 'string')) return null;
  if (!Number.isInteger(record['status']) || !Number.isInteger(record['bytes']) || typeof record['requestTime'] !== 'number') return null;
  return record as unknown as EdgeLogLine;
}

/**
 * The script of the *Upstream stub*, for `bun --no-env-file -e`: listens on port 9000 with `idleTimeout` 30 seconds,
 * writes nothing to stdout or stderr, never answers `/api/stub/hang`, answers `/api/stub/count` with the number of
 * other requests it received, and answers every other path with 200 JSON holding the method, the request target as
 * received (query included), the body size, and the value (or `null`) of `host`, `x-request-id`, and every header of
 * *Header alamat client*.
 */
export function stubScript(): string {
  const names = JSON.stringify(['host', 'x-request-id', ...CLIENT_ADDRESS_HEADERS.map((name) => name.toLowerCase())]);
  return [
    `let count=0;const names=${names};`,
    "Bun.serve({hostname:'0.0.0.0',port:9000,idleTimeout:30,async fetch(request){",
    'const url=new URL(request.url);',
    "if(url.pathname==='/api/stub/count')return Response.json({count});",
    'count+=1;',
    "if(url.pathname==='/api/stub/hang')return new Promise(()=>{});",
    'const body=await request.arrayBuffer();const headers={};for(const name of names)headers[name]=request.headers.get(name);',
    'return Response.json({method:request.method,path:url.pathname+url.search,bodyBytes:body.byteLength,headers});',
    '},error(){return new Response(null,{status:500});}});',
  ].join('');
}

/** `openssl s_client` arguments of AC-5 against the edge on loopback, verified with the run CA. */
export function tlsArgs(port: number, caFile: string, ...rest: string[]): string[] {
  return ['openssl', 's_client', '-connect', `127.0.0.1:${port}`, '-servername', 'localhost', '-CAfile', caFile, '-verify_return_error', ...rest];
}

/** True when an `index.html` text has no `<script>` element without `src` and no `<style>` element (AC-6). */
export function indexWithoutInline(html: string): boolean {
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  return scripts.every((match) => /\bsrc\s*=/.test(match[1] ?? '')) && !/<style\b/i.test(html);
}

/** Hashed asset paths that `index.html` refers to through `src` or `href`, in first use order. */
export function hashedAssets(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const path = `/${match[1]!.replace(/^\//, '')}`;
    if (HASHED_ASSET.test(path) && !found.includes(path)) found.push(path);
  }
  return found;
}

/** The only origins outside the edge that DEP-006 may request (AC-6). */
export const FONT_ORIGINS: readonly string[] = Object.freeze(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);

/**
 * AC-6 evidence in the DEP-006 JUnit: each `DEP-006` testcase keeps its requested origins in <system-out>, as one line
 * `requested-origins <JSON array>` and as a `[[ATTACHMENT|...requested-origins...]]` file, and every origin is a font
 * origin. Two DEP-006 testcases are expected.
 */
export function requestedOriginsProblems(junit: string): string[] {
  const problems: string[] = [];
  const cases = [...junit.matchAll(/<testcase name="(DEP-006[^"]*)"[\s\S]*?<\/testcase>/g)];
  if (cases.length !== 2) problems.push(`${cases.length} testcase DEP-006, diharapkan 2`);
  for (const [text, title] of cases) {
    const label = (title ?? '').slice(0, 40);
    // stdout comes first in <system-out>, so the line may start right after `<![CDATA[`.
    const lines = [...text.matchAll(/(?:^|<!\[CDATA\[)requested-origins (.*)$/gm)].map((match) => match[1]!);
    let origins: unknown;
    try {
      origins = lines.length === 1 ? JSON.parse(lines[0]!) : undefined;
    } catch {
      origins = undefined;
    }
    if (!Array.isArray(origins) || !origins.every((origin) => typeof origin === 'string')) problems.push(`${label}: baris requested-origins tidak ada atau tidak sah`);
    else if (origins.some((origin) => !FONT_ORIGINS.includes(origin))) problems.push(`${label}: origin selain font Google diminta`);
    if (!/\[\[ATTACHMENT\|[^\]\n]*requested-origins[^\]\n]*\]\]/.test(text)) problems.push(`${label}: lampiran requested-origins tidak ada`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Isolation and operation (AC-2, AC-4, AC-8, AC-9, AC-10): the values the image, declaration, inspect, reachability,
// operation, and log checks compare, and the pure functions that judge them.

/** AC-1: an `ARG` or `ENV` name that looks like a secret. */
export const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|DATABASE_URL)/i;
/** AC-2: the base name of a `.env` file. */
export const ENV_FILE_NAME = /^\.env(\..*)?$/;
/** Every ignore file ends with these two rules (*Daftar izin konteks build*). */
export const ENV_RULES: readonly string[] = Object.freeze(['**/.env', '**/.env.*']);
/** *Probe konteks*: the Dockerfile of each probe build. */
export const CONTEXT_PROBE_DOCKERFILE = 'FROM scratch\nCOPY . /context/\n';

const codeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** One `.dockerignore` pattern over a whole relative path: `**` spans folders, `*` and `?` stay within one segment. */
export function ignorePattern(pattern: string): RegExp {
  const text = pattern.replace(/\/+$/, '');
  let source = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '*' && text[index + 1] === '*') {
      if (text[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** True when `pattern` matches `path` or one of its parent folders, as a rule of an ignore file does. */
export function ignoreMatches(pattern: string, path: string): boolean {
  const regex = ignorePattern(pattern);
  const segments = path.split('/');
  for (let length = 1; length <= segments.length; length += 1) if (regex.test(segments.slice(0, length).join('/'))) return true;
  return false;
}

/**
 * *Probe konteks*: the paths of the copy that the ignore file of one *Daftar izin konteks build* row lets into the
 * build context, in code unit order. A path must be brought back by an include and not removed again by an extra
 * exclusion, `**\/.env`, or `**\/.env.*`; the later rules of the file win, so this order is the order of the file.
 */
export function expectedContext(paths: readonly string[], rule: Readonly<{ include: readonly string[]; exclude: readonly string[] }>): string[] {
  const removals = [...rule.exclude, ...ENV_RULES];
  return paths
    .filter((path) => rule.include.some((pattern) => ignoreMatches(pattern, path)))
    .filter((path) => !removals.some((pattern) => ignoreMatches(pattern, path)))
    .sort(codeUnit);
}

/** AC-2: copy paths with a `node_modules`, `dist`, `.angular`, or `.env` segment; the planted sentinels are left out by the caller. */
export function copyProblems(paths: readonly string[]): string[] {
  return paths.filter((path) => path.split('/').some((segment) => segment === 'node_modules' || segment === 'dist' || segment === '.angular' || ENV_FILE_NAME.test(segment)));
}

/** `tar -tf` lines of a `docker export`: paths without `./` and without a folder's trailing `/`, in code unit order. */
export function exportEntries(listing: string): { paths: string[]; folders: Set<string> } {
  const paths = new Set<string>();
  const folders = new Set<string>();
  for (const line of listing.split('\n')) {
    const raw = line.replace(/\r$/, '').replace(/^\.\//, '');
    const path = raw.replace(/\/+$/, '');
    if (path === '' || path === '.') continue;
    paths.add(path);
    if (raw.endsWith('/')) folders.add(path);
  }
  return { paths: [...paths].sort(codeUnit), folders };
}

/** `files.sha256` of images.json: SHA 256 of the sorted path list, one path per line. */
export function pathListDigest(paths: readonly string[]): string {
  return new Bun.CryptoHasher('sha256').update([...paths].sort(codeUnit).join('\n')).digest('hex');
}

/** Files of the final stage that the *Image* table names, per image. */
const IMAGE_REQUIRED_FILES: Readonly<Record<ImageName, readonly string[]>> = Object.freeze({
  frontend: Object.freeze(['srv/frontend/index.html', 'etc/nginx/nginx.conf', 'etc/nginx/foundation/document-headers.conf', 'etc/nginx/foundation/api-headers.conf', 'usr/local/bin/foundation-edge']),
  backend: Object.freeze(['app/backend.js']),
  migrate: Object.freeze(['app/database/migrate.ts']),
});

/**
 * *Image* and AC-2 for the exported filesystem of one image: no `.env` base name, the files of the final stage, the
 * emptied nginx folders of the edge, nothing but `backend.js` in `/app` of the backend, and in `/app` of the runner
 * exactly the files of its build context (`contextFiles`, from expectedContext).
 */
export function imageFilesystemProblems(name: ImageName, entries: { paths: readonly string[]; folders: ReadonlySet<string> }, contextFiles: readonly string[]): string[] {
  const problems: string[] = [];
  const envFiles = entries.paths.filter((path) => ENV_FILE_NAME.test(baseName(path)));
  if (envFiles.length > 0) problems.push(`${name}: ${envFiles.length} path bernama .env`);
  const present = new Set(entries.paths);
  for (const path of IMAGE_REQUIRED_FILES[name]) if (!present.has(path) || entries.folders.has(path)) problems.push(`${name}: /${path} tidak ada`);
  const under = (folder: string) => entries.paths.filter((path) => path.startsWith(`${folder}/`));
  if (name === 'frontend') {
    for (const folder of ['etc/nginx/conf.d', 'usr/share/nginx/html']) if (under(folder).length > 0) problems.push(`${name}: /${folder}/ tidak kosong`);
  } else if (name === 'backend') {
    const app = under('app');
    if (app.length !== 1 || app[0] !== 'app/backend.js') problems.push(`${name}: /app berisi ${app.length} entri, bukan hanya backend.js`);
  } else {
    const files = under('app').filter((path) => !entries.folders.has(path));
    const expected = contextFiles.map((path) => `app/${path}`).sort(codeUnit);
    if (files.length !== expected.length || files.some((path, index) => path !== expected[index])) problems.push(`${name}: isi /app berbeda dengan konteks build (${files.length} berbanding ${expected.length} file)`);
  }
  return problems;
}

type HealthcheckExpectation = null | Readonly<{ test: readonly string[]; script: readonly string[]; intervalNs: number; timeoutNs: number; retries: number; startPeriodNs: number }>;

/** *Image*: the configuration of each image as `docker image inspect` shows it. */
export const IMAGE_CONFIG: Readonly<Record<ImageName, Readonly<{
  title: string; user: string; entrypoint: readonly string[]; cmd: readonly string[] | null; stopSignal: string;
  ports: readonly string[]; inheritedPorts: readonly string[]; env: readonly string[]; workingDir: string | null; healthcheck: HealthcheckExpectation;
}>>> = Object.freeze({
  frontend: Object.freeze({
    title: 'foundation-frontend', user: '101:101', entrypoint: Object.freeze(['/usr/local/bin/foundation-edge']), cmd: null, stopSignal: 'SIGQUIT',
    // EXPOSE 80 of the nginx base cannot be taken back by a later stage, so it is the only port allowed beside the table.
    ports: Object.freeze(['8080/tcp', '8443/tcp']), inheritedPorts: Object.freeze(['80/tcp']), env: Object.freeze(['FOUNDATION_BACKEND_UPSTREAM=backend:8888']), workingDir: null, healthcheck: null,
  }),
  backend: Object.freeze({
    title: 'foundation-backend', user: '1000:1000', entrypoint: Object.freeze(['bun', '--no-env-file', '/app/backend.js']), cmd: null, stopSignal: 'SIGTERM',
    ports: Object.freeze(['8888/tcp']), inheritedPorts: Object.freeze([]), env: Object.freeze(['NODE_ENV=production', 'HOST=0.0.0.0', 'PORT=8888']), workingDir: '/app',
    healthcheck: Object.freeze({
      test: Object.freeze(['CMD', 'bun', '--no-env-file', '-e']),
      script: Object.freeze(['http://127.0.0.1:8888/health/live', 'AbortSignal.timeout(2000)', 'response.status === 200 ? 0 : 1']),
      intervalNs: 10_000_000_000, timeoutNs: 5_000_000_000, retries: 3, startPeriodNs: 10_000_000_000,
    }),
  }),
  migrate: Object.freeze({
    title: 'foundation-migrate', user: '1000:1000', entrypoint: Object.freeze(['bun', '--no-env-file']), cmd: Object.freeze(['database/migrate.ts']), stopSignal: 'SIGTERM',
    ports: Object.freeze([]), inheritedPorts: Object.freeze([]), env: Object.freeze([]), workingDir: '/app', healthcheck: null,
  }),
});

const sameList = (actual: unknown, expected: readonly unknown[]) => Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
const emptyList = (value: unknown) => value === null || value === undefined || (Array.isArray(value) && value.length === 0);
const recordOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Healthcheck problems against an expectation; `null` expects none (absent, empty, or `NONE`). */
export function healthcheckProblems(label: string, value: unknown, expected: HealthcheckExpectation): string[] {
  const check = recordOf(value);
  const test = check['Test'];
  const absent = value === null || value === undefined || emptyList(test) || (Array.isArray(test) && test[0] === 'NONE');
  if (expected === null) return absent ? [] : [`${label}: healthcheck tidak diharapkan`];
  if (absent || !Array.isArray(test)) return [`${label}: healthcheck tidak ada`];
  const problems: string[] = [];
  const script = test[expected.test.length];
  if (test.length !== expected.test.length + 1 || !sameList(test.slice(0, expected.test.length), expected.test) || typeof script !== 'string' || expected.script.some((part) => !script.includes(part))) {
    problems.push(`${label}: perintah healthcheck berbeda`);
  }
  if (check['Interval'] !== expected.intervalNs || check['Timeout'] !== expected.timeoutNs || check['Retries'] !== expected.retries || check['StartPeriod'] !== expected.startPeriodNs) {
    problems.push(`${label}: interval, timeout, retries, atau start period healthcheck berbeda`);
  }
  return problems;
}

/** `ARG` names of a `docker history --no-trunc` text that look like a secret (AC-1). */
export function secretArgs(history: string): string[] {
  return [...history.matchAll(/\bARG\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!).filter((name) => SECRET_NAME.test(name));
}

/**
 * *Image* and AC-1, AC-2 for one `docker image inspect` object: numeric user, entrypoint, command, stop signal, exposed
 * ports, working folder, the environment of the table without a secret looking key, the healthcheck, and the labels
 * given at build time.
 */
export function imageConfigProblems(name: ImageName, inspected: unknown, labels: Readonly<{ revision: string; sourceTree: string; hex: string }>): string[] {
  const expected = IMAGE_CONFIG[name];
  const config = recordOf(recordOf(inspected)['Config']);
  const problems: string[] = [];
  if (config['User'] !== expected.user) problems.push(`${name}: USER bukan ${expected.user}`);
  if (!sameList(config['Entrypoint'], expected.entrypoint)) problems.push(`${name}: ENTRYPOINT berbeda`);
  if (expected.cmd === null ? !emptyList(config['Cmd']) : !sameList(config['Cmd'], expected.cmd)) problems.push(`${name}: CMD berbeda`);
  if (config['StopSignal'] !== expected.stopSignal) problems.push(`${name}: STOPSIGNAL bukan ${expected.stopSignal}`);
  const ports = Object.keys(recordOf(config['ExposedPorts']));
  for (const port of expected.ports) if (!ports.includes(port)) problems.push(`${name}: port ${port} tidak diekspos`);
  for (const port of ports) if (!expected.ports.includes(port) && !expected.inheritedPorts.includes(port)) problems.push(`${name}: port ${port} tidak diharapkan`);
  if (expected.workingDir !== null && config['WorkingDir'] !== expected.workingDir) problems.push(`${name}: WORKDIR bukan ${expected.workingDir}`);
  const env = Array.isArray(config['Env']) ? (config['Env'] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
  for (const entry of expected.env) if (!env.includes(entry)) problems.push(`${name}: ENV ${entry.slice(0, entry.indexOf('='))} tidak sesuai`);
  const secretKeys = env.map((entry) => entry.slice(0, entry.indexOf('='))).filter((key) => SECRET_NAME.test(key));
  if (secretKeys.length > 0) problems.push(`${name}: Config.Env memuat key ${secretKeys.join(', ')}`);
  problems.push(...healthcheckProblems(name, config['Healthcheck'], expected.healthcheck));
  const imageLabels = recordOf(config['Labels']);
  const wanted: [string, string][] = [
    ['org.opencontainers.image.title', expected.title],
    ['org.opencontainers.image.revision', labels.revision],
    ['foundation.source-tree', labels.sourceTree],
    ['foundation.test', 'deployment'],
    ['foundation.run', labels.hex],
  ];
  for (const [key, value] of wanted) if (imageLabels[key] !== value) problems.push(`${name}: label ${key} tidak sesuai`);
  return problems;
}

export type ServiceName = 'edge' | 'backend' | 'postgres' | 'migrate';
export const SERVICE_NAMES: readonly ServiceName[] = Object.freeze(['edge', 'backend', 'postgres', 'migrate']);

const MIB = 1024 * 1024;
const LOGGING = Object.freeze({ driver: 'json-file', options: Object.freeze({ 'max-file': '3', 'max-size': '10m' }) });
const POSTGRES_COMMAND = Object.freeze(['-c', 'log_min_messages=log', '-c', 'log_min_error_statement=panic', '-c', 'log_error_verbosity=terse']);
const PG_ISREADY = 'pg_isready -h 127.0.0.1 -p 5432 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"';

/** Bytes of a Compose size (`128m`, `128mb`, `1g`, or a number of bytes); `null` when it is not one. */
export function composeBytes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([bkmg]?)b?$/i.exec(value.trim());
  if (match === null) return null;
  const unit = { '': 1, b: 1, k: 1024, m: MIB, g: 1024 * MIB }[match[2]!.toLowerCase() as '' | 'b' | 'k' | 'm' | 'g'];
  return Math.round(Number(match[1]) * unit);
}

/** Milliseconds of a Compose duration (`10s`, `1m30s`, `500ms`, or nanoseconds as a number); `null` when it is not one. */
export function composeDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value / 1_000_000;
  if (typeof value !== 'string' || value.trim() === '') return null;
  let total = 0;
  let rest = value.trim();
  while (rest !== '') {
    const match = /^([0-9]+(?:\.[0-9]+)?)(ms|h|m|s)/.exec(rest);
    if (match === null) return null;
    total += Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
    rest = rest.slice(match[0].length);
  }
  return total;
}

type Declared = Readonly<{
  image: string; networks: readonly string[]; ports: readonly string[]; cpus: number; memory: number; pids: number; shm: number | null;
  readOnly: boolean; tmpfs: readonly string[]; restart: string; stopGraceMs: number; environment: Readonly<Record<string, string>>;
  dependsOnPostgres: boolean; profiles: readonly string[]; command: readonly string[] | null; healthcheck: boolean; secrets: boolean; volume: boolean;
}>;

/** *Topologi* and *Environment per service* as `compose config --no-interpolate --format json` shows them, without the override. */
export const DECLARATION: Readonly<Record<ServiceName, Declared>> = Object.freeze({
  edge: Object.freeze({
    image: '${FOUNDATION_FRONTEND_IMAGE:?}', networks: Object.freeze(['app', 'public']),
    ports: Object.freeze(['${FOUNDATION_EDGE_BIND:-0.0.0.0}:${FOUNDATION_EDGE_HTTPS_PORT:-443}:8443', '${FOUNDATION_EDGE_BIND:-0.0.0.0}:${FOUNDATION_EDGE_HTTP_PORT:-80}:8080']),
    cpus: 0.5, memory: 128 * MIB, pids: 128, shm: null, readOnly: true, tmpfs: Object.freeze(['/tmp:rw,nosuid,nodev,noexec,size=16m']), restart: 'unless-stopped', stopGraceMs: 15_000,
    environment: Object.freeze({}), dependsOnPostgres: false, profiles: Object.freeze([]), command: null, healthcheck: false, secrets: true, volume: false,
  }),
  backend: Object.freeze({
    image: '${FOUNDATION_BACKEND_IMAGE:?}', networks: Object.freeze(['app', 'data']), ports: Object.freeze([]),
    cpus: 1, memory: 512 * MIB, pids: 256, shm: null, readOnly: true, tmpfs: Object.freeze(['/tmp:rw,nosuid,nodev,noexec,size=64m']), restart: 'unless-stopped', stopGraceMs: 10_000,
    environment: Object.freeze({ DATABASE_URL: '${FOUNDATION_BACKEND_DATABASE_URL:?}' }), dependsOnPostgres: true, profiles: Object.freeze([]), command: null, healthcheck: false, secrets: false, volume: false,
  }),
  postgres: Object.freeze({
    image: '${FOUNDATION_POSTGRES_IMAGE:-foundation-postgres:18-pinned}', networks: Object.freeze(['data']), ports: Object.freeze([]),
    cpus: 2, memory: 1024 * MIB, pids: 256, shm: 128 * MIB, readOnly: false, tmpfs: Object.freeze([]), restart: 'unless-stopped', stopGraceMs: 30_000,
    environment: Object.freeze({ POSTGRES_DB: 'foundation', POSTGRES_PASSWORD: '${FOUNDATION_POSTGRES_PASSWORD:?}', POSTGRES_USER: 'foundation_admin' }),
    dependsOnPostgres: false, profiles: Object.freeze([]), command: POSTGRES_COMMAND, healthcheck: true, secrets: false, volume: true,
  }),
  migrate: Object.freeze({
    image: '${FOUNDATION_MIGRATE_IMAGE:?}', networks: Object.freeze(['data']), ports: Object.freeze([]),
    cpus: 0.5, memory: 256 * MIB, pids: 128, shm: null, readOnly: true, tmpfs: Object.freeze(['/tmp:rw,nosuid,nodev,noexec,size=16m']), restart: 'no', stopGraceMs: 10_000,
    environment: Object.freeze({ FOUNDATION_MIGRATOR_DATABASE_URL: '${FOUNDATION_MIGRATOR_DATABASE_URL:?}' }), dependsOnPostgres: true, profiles: Object.freeze(['migrate']), command: null, healthcheck: false, secrets: false, volume: false,
  }),
});

const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : Object.keys(recordOf(value))).sort(codeUnit);
const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * AC-8 and AC-10 for the output of `compose -f deploy/compose.yaml config --no-interpolate --format json` without the
 * override: exactly the four services and three networks of *Topologi*, each declarative field of the table, the
 * environment keys of *Environment per service* with variables in place of values, no `build` and no `user`, the
 * PostgreSQL log flags, `json-file` 10m × 3 on every service, and a published port on the edge only.
 */
export function declarationProblems(config: unknown): string[] {
  const root = recordOf(config);
  const problems: string[] = [];
  if (root['name'] !== 'foundation-deploy') problems.push('name bukan foundation-deploy');
  const services = recordOf(root['services']);
  if (!sameList(keysOf(services), [...SERVICE_NAMES].sort(codeUnit))) problems.push(`service ${keysOf(services).join(', ')}`);
  const networks = recordOf(root['networks']);
  if (!sameList(keysOf(networks), ['app', 'data', 'public'])) problems.push(`network ${keysOf(networks).join(', ')}`);
  if (recordOf(networks['app'])['internal'] !== true || recordOf(networks['data'])['internal'] !== true) problems.push('network app atau data tanpa internal: true');
  if (recordOf(networks['public'])['internal'] === true) problems.push('network public internal');
  if (!sameList(keysOf(root['volumes']), ['pgsql_data'])) problems.push('volume bukan hanya pgsql_data');
  const secrets = recordOf(root['secrets']);
  for (const [secret, variable] of [['edge_tls_cert', 'FOUNDATION_EDGE_TLS_CERT_FILE'], ['edge_tls_key', 'FOUNDATION_EDGE_TLS_KEY_FILE']] as const) {
    const file = recordOf(secrets[secret])['file'];
    if (typeof file !== 'string' || !file.endsWith(`/deploy/\${${variable}:?}`)) problems.push(`secret ${secret} bukan file \${${variable}:?}`);
  }
  for (const name of SERVICE_NAMES) {
    const service = recordOf(services[name]);
    const expected = DECLARATION[name];
    const differs = (field: string) => problems.push(`${name}: ${field}`);
    if (service['image'] !== expected.image) differs('image');
    if ('build' in service) differs('build');
    if ('user' in service) differs('user');
    if (!sameList(keysOf(service['networks']), expected.networks)) differs('networks');
    if (!sameJson(service['ports'] ?? [], expected.ports)) differs('ports');
    if (Number(service['cpus']) !== expected.cpus) differs('cpus');
    if (composeBytes(service['mem_limit']) !== expected.memory) differs('mem_limit');
    if (Number(service['pids_limit']) !== expected.pids) differs('pids_limit');
    if ((service['shm_size'] === undefined ? null : composeBytes(service['shm_size'])) !== expected.shm) differs('shm_size');
    if ((service['read_only'] === true) !== expected.readOnly) differs('read_only');
    if (!sameJson(service['tmpfs'] ?? [], expected.tmpfs)) differs('tmpfs');
    if (!sameJson(service['cap_drop'], ['ALL'])) differs('cap_drop');
    if (!sameJson(service['security_opt'], ['no-new-privileges:true'])) differs('security_opt');
    if (service['restart'] !== expected.restart) differs('restart');
    if (composeDuration(service['stop_grace_period']) !== expected.stopGraceMs) differs('stop_grace_period');
    const logging = recordOf(service['logging']);
    if (logging['driver'] !== LOGGING.driver || !sameJson(Object.fromEntries(Object.entries(recordOf(logging['options'])).sort(([a], [b]) => codeUnit(a, b))), LOGGING.options)) differs('logging');
    const environment = Object.fromEntries(Object.entries(recordOf(service['environment'])).sort(([a], [b]) => codeUnit(a, b)));
    if (!sameJson(environment, expected.environment)) differs('environment');
    const dependsOn = recordOf(service['depends_on']);
    const onPostgres = keysOf(dependsOn).length === 1 && recordOf(dependsOn['postgres'])['condition'] === 'service_healthy';
    if (expected.dependsOnPostgres ? !onPostgres : service['depends_on'] !== undefined) differs('depends_on');
    if (!sameJson(service['profiles'] ?? [], expected.profiles)) differs('profiles');
    if (expected.command === null ? service['command'] !== undefined : !sameList(service['command'], expected.command)) differs('command');
    const healthcheck = recordOf(service['healthcheck']);
    if (expected.healthcheck) {
      if (!sameList(healthcheck['test'], ['CMD-SHELL', PG_ISREADY]) || composeDuration(healthcheck['interval']) !== 5_000 || composeDuration(healthcheck['timeout']) !== 3_000
        || Number(healthcheck['retries']) !== 10 || composeDuration(healthcheck['start_period']) !== 10_000) differs('healthcheck');
    } else if (service['healthcheck'] !== undefined) differs('healthcheck');
    const declaredSecrets = Array.isArray(service['secrets']) ? (service['secrets'] as unknown[]).map((item) => `${recordOf(item)['source']}>${recordOf(item)['target']}`) : [];
    const wantedSecrets = expected.secrets ? ['edge_tls_cert>/run/secrets/edge_tls_cert', 'edge_tls_key>/run/secrets/edge_tls_key'] : [];
    if (!sameList(declaredSecrets, wantedSecrets)) differs('secrets');
    const volumes = Array.isArray(service['volumes']) ? (service['volumes'] as unknown[]).map((item) => `${recordOf(item)['type']}:${recordOf(item)['source']}:${recordOf(item)['target']}`) : [];
    if (!sameList(volumes, expected.volume ? ['volume:pgsql_data:/var/lib/pgsql'] : [])) differs('volumes');
  }
  return problems;
}

type Runtime = Readonly<{ networks: readonly string[]; user: string; nanoCpus: number; memory: number; pids: number; shm: number | null; readOnly: boolean; tmpfs: Readonly<Record<string, string>>; stopTimeout: number; healthcheck: 'none' | 'image' | 'pg_isready' }>;

/** AC-8: what `docker inspect` shows for each container of the run (the restart policy is the `no` of the override). */
export const RUNTIME: Readonly<Record<ServiceName, Runtime>> = Object.freeze({
  edge: Object.freeze({ networks: Object.freeze(['app', 'public']), user: '101:101', nanoCpus: 500_000_000, memory: 128 * MIB, pids: 128, shm: null, readOnly: true, tmpfs: Object.freeze({ '/tmp': 'rw,nosuid,nodev,noexec,size=16m' }), stopTimeout: 15, healthcheck: 'none' }),
  backend: Object.freeze({ networks: Object.freeze(['app', 'data']), user: '1000:1000', nanoCpus: 1_000_000_000, memory: 512 * MIB, pids: 256, shm: null, readOnly: true, tmpfs: Object.freeze({ '/tmp': 'rw,nosuid,nodev,noexec,size=64m' }), stopTimeout: 10, healthcheck: 'image' }),
  postgres: Object.freeze({ networks: Object.freeze(['data']), user: 'postgres', nanoCpus: 2_000_000_000, memory: 1024 * MIB, pids: 256, shm: 128 * MIB, readOnly: false, tmpfs: Object.freeze({}), stopTimeout: 30, healthcheck: 'pg_isready' }),
  migrate: Object.freeze({ networks: Object.freeze(['data']), user: '1000:1000', nanoCpus: 500_000_000, memory: 256 * MIB, pids: 128, shm: null, readOnly: true, tmpfs: Object.freeze({ '/tmp': 'rw,nosuid,nodev,noexec,size=16m' }), stopTimeout: 10, healthcheck: 'none' }),
});

/**
 * AC-8 for one `docker inspect` object: the networks of *Topologi*, the numeric user, CPU, memory, PIDs, shm, read only
 * root, tmpfs, `CapDrop`, `SecurityOpt`, restart `no`, stop timeout, healthcheck, and `json-file` 10m × 3.
 * `imageHealthcheck` is the healthcheck of the backend image, which the backend container must carry unchanged.
 */
export function hardeningProblems(service: ServiceName, inspected: unknown, project: string, imageHealthcheck: unknown): string[] {
  const expected = RUNTIME[service];
  const object = recordOf(inspected);
  const config = recordOf(object['Config']);
  const host = recordOf(object['HostConfig']);
  const problems: string[] = [];
  const differs = (field: string) => problems.push(`${service}: ${field}`);
  const networks = keysOf(recordOf(object['NetworkSettings'])['Networks']);
  if (!sameList(networks, expected.networks.map((name) => `${project}_${name}`))) differs(`network ${networks.join(', ')}`);
  if (config['User'] !== expected.user) differs('Config.User');
  if (host['NanoCpus'] !== expected.nanoCpus) differs('NanoCpus');
  if (host['Memory'] !== expected.memory) differs('Memory');
  if (host['PidsLimit'] !== expected.pids) differs('PidsLimit');
  if (expected.shm !== null && host['ShmSize'] !== expected.shm) differs('ShmSize');
  if (host['ReadonlyRootfs'] !== expected.readOnly) differs('ReadonlyRootfs');
  if (!sameJson(Object.fromEntries(Object.entries(recordOf(host['Tmpfs'])).sort(([a], [b]) => codeUnit(a, b))), expected.tmpfs)) differs('Tmpfs');
  if (!sameJson(host['CapDrop'], ['ALL'])) differs('CapDrop');
  if (!sameJson(host['SecurityOpt'], ['no-new-privileges:true'])) differs('SecurityOpt');
  if (recordOf(host['RestartPolicy'])['Name'] !== 'no') differs('RestartPolicy');
  if (config['StopTimeout'] !== expected.stopTimeout) differs('StopTimeout');
  const log = recordOf(host['LogConfig']);
  if (log['Type'] !== 'json-file' || !sameJson(Object.fromEntries(Object.entries(recordOf(log['Config'])).sort(([a], [b]) => codeUnit(a, b))), LOGGING.options)) differs('LogConfig');
  if (expected.healthcheck === 'none') problems.push(...healthcheckProblems(service, config['Healthcheck'], null));
  else if (expected.healthcheck === 'image') {
    if (!sameJson(config['Healthcheck'], imageHealthcheck) || healthcheckProblems(service, config['Healthcheck'], IMAGE_CONFIG.backend.healthcheck).length > 0) differs('healthcheck bukan milik image');
  } else {
    const check = recordOf(config['Healthcheck']);
    if (!sameList(check['Test'], ['CMD-SHELL', PG_ISREADY.replaceAll('$$', '$')]) || check['Interval'] !== 5_000_000_000 || check['Timeout'] !== 3_000_000_000 || check['Retries'] !== 10 || check['StartPeriod'] !== 10_000_000_000) {
      differs('healthcheck pg_isready');
    }
  }
  return problems;
}

/** *Environment per service*: the keys Compose adds to each container, beyond `Config.Env` of its image. */
export const SERVICE_ENVIRONMENT: Readonly<Record<ServiceName, readonly string[]>> = Object.freeze({
  edge: Object.freeze([]),
  backend: Object.freeze(['DATABASE_URL']),
  postgres: Object.freeze(['POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER']),
  migrate: Object.freeze(['FOUNDATION_MIGRATOR_DATABASE_URL']),
});

/** The `KEY=VALUE` entries of a container that its image does not have, as a map from key to value. */
export function addedEnvironment(container: unknown, image: unknown): Map<string, string> {
  const entries = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.includes('=')) : []);
  const base = new Set(entries(image));
  const added = new Map<string, string>();
  for (const entry of entries(container)) if (!base.has(entry)) added.set(entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1));
  return added;
}

/**
 * *Keterjangkauan* row `docker compose port` for backend and PostgreSQL: no host port. Compose 5.5.1 answers a port the
 * image exposes but nobody publishes with `invalid IP:0` (exit 0) when the container is on a network, and with an
 * empty stdout plus `no port ...` on stderr (exit 1) otherwise; both mean an empty binding. Anything with a host port
 * other than 0 is a published port.
 */
export function unpublishedPort(code: number | null, stdout: string, stderr: string): boolean {
  const text = stdout.trim();
  if (text === '') return code === 0 || /^no port /.test(stderr.trim());
  return code === 0 && /^(?:invalid IP)?:0$/.test(text);
}

/** One reachability probe: a TCP connection or an HTTP request, from a container on one network of the project. */
export type ProbeSpec =
  | Readonly<{ kind: 'tcp'; host: string; port: number }>
  | Readonly<{ kind: 'http'; url: string; method?: string; headers?: Readonly<Record<string, string>>; bodyBytes?: number }>;
export type ProbeResult = Readonly<{ result: 'ok' | 'fail'; code: string | null; status: number | null; body: string | null; ms: number }>;
/** *Keterjangkauan*: every probe gives up after 3 seconds. */
export const PROBE_LIMIT_MS = 3_000;

/**
 * The fixed script of a probe for `bun --no-env-file -e`: one attempt that ends after PROBE_LIMIT_MS at most, then one
 * JSON line `{ result, code, status, body, ms }` on stdout and exit 0, so a probe that ran is told apart from one that
 * could not start. A TCP probe is `ok` once the connection opens; an HTTP probe once an answer arrives.
 */
export function probeScript(spec: ProbeSpec): string {
  return [
    `const spec=${JSON.stringify(spec)};const started=Date.now();`,
    "const done=(value)=>{console.log(JSON.stringify({result:value.result,code:value.code??null,status:value.status??null,body:value.body??null,ms:Date.now()-started}));process.exit(0);};",
    `const limit=new Promise((resolve)=>setTimeout(()=>resolve({result:'fail',code:'timeout'}),${PROBE_LIMIT_MS}));`,
    "const attempt=spec.kind==='tcp'",
    "?Bun.connect({hostname:spec.host,port:spec.port,socket:{data(){},open(socket){socket.end();},error(){},connectError(){}}}).then(()=>({result:'ok'}),(error)=>({result:'fail',code:String(error?.code??'error')}))",
    `:fetch(spec.url,{method:spec.method??'GET',headers:spec.headers??{},body:spec.bodyBytes?'a'.repeat(spec.bodyBytes):undefined,signal:AbortSignal.timeout(${PROBE_LIMIT_MS})}).then(async(response)=>({result:'ok',status:response.status,body:(await response.text()).slice(0,200)}),(error)=>({result:'fail',code:String(error?.code??error?.name??'error')}));`,
    'Promise.race([attempt,limit]).then(done,()=>done({result:\'fail\',code:\'error\'}));',
  ].join('');
}

export function parseProbe(stdout: string): ProbeResult | null {
  const line = stdout.trim().split('\n').pop();
  const value = recordOf(parseJson(line ?? null));
  const { result, code, status, body, ms } = value;
  if ((result !== 'ok' && result !== 'fail') || typeof ms !== 'number') return null;
  return { result, code: typeof code === 'string' ? code : null, status: typeof status === 'number' ? status : null, body: typeof body === 'string' ? body : null, ms };
}

/** *Log backend production*: lifecycle events and their level. */
export const BACKEND_LIFECYCLE: Readonly<Record<string, 'info' | 'error'>> = Object.freeze({
  listening: 'info', stopped: 'info', listener_shutdown_failed: 'error', database_shutdown_failed: 'error', startup_failed: 'error',
});
const BACKEND_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER']);
const REQUEST_KEYS = ['durationMs', 'event', 'level', 'method', 'path', 'requestId', 'status', 'time'];
const LIFECYCLE_KEYS = ['event', 'level', 'time'];

export type BackendLogLine =
  | Readonly<{ event: 'request'; time: string; level: 'info' | 'error'; requestId: string; method: string; path: string; status: number; durationMs: number }>
  | Readonly<{ event: string; time: string; level: 'info' | 'error' }>;

/**
 * One line of the production backend log (AC-10) with exact keys and types: a request line (`level` info below 500,
 * error from 500, `requestId` 32 hex, a fixed method, a path without query of at most 200 characters, integer status
 * and duration) or a lifecycle line of the vocabulary. `null` for any other text.
 */
export function parseBackendLogLine(line: string): BackendLogLine | null {
  const value = parseJson(line);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(codeUnit);
  const time = record['time'];
  if (typeof time !== 'string' || Number.isNaN(Date.parse(time)) || new Date(time).toISOString() !== time) return null;
  if (record['event'] === 'request') {
    const { level, requestId, method, path, status, durationMs } = record;
    if (!sameList(keys, REQUEST_KEYS) || typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || typeof method !== 'string' || !BACKEND_METHODS.has(method)) return null;
    if (typeof path !== 'string' || path.length > 200 || path.includes('?') || !Number.isInteger(status) || !Number.isInteger(durationMs) || (durationMs as number) < 0) return null;
    if (level !== ((status as number) < 500 ? 'info' : 'error')) return null;
    return record as unknown as BackendLogLine;
  }
  const event = record['event'];
  if (!sameList(keys, LIFECYCLE_KEYS) || typeof event !== 'string' || !Object.hasOwn(BACKEND_LIFECYCLE, event) || record['level'] !== BACKEND_LIFECYCLE[event]) return null;
  return record as unknown as BackendLogLine;
}

const EDGE_LOG_KEYS = ['bytes', 'method', 'path', 'requestId', 'requestTime', 'status', 'time', 'upstreamStatus', 'upstreamTime'];
const ISO_8601 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

/** AC-10 for one stdout line of the edge: the exact keys, the types, a path without query, and empty upstream fields together. */
export function edgeLogLineProblem(text: string): string | null {
  const line = parseEdgeLogLine(text);
  if (line === null) return 'bukan objek JSON dengan tipe AC-10';
  if (!sameList(Object.keys(line).sort(codeUnit), EDGE_LOG_KEYS)) return 'key berbeda';
  if (!ISO_8601.test(line.time) || !REQUEST_ID.test(line.requestId) || line.path.includes('?')) return 'time, requestId, atau path tidak sesuai';
  if ((line.upstreamStatus === '') !== (line.upstreamTime === '')) return 'upstreamStatus dan upstreamTime tidak sejalan';
  return null;
}

/** One answer of `/api/status` through the edge while the backend is stopped, with its start time after the stop. */
export type StoppedSample = Readonly<{ atMs: number; status: number | null; edgeJson: boolean }>;

/**
 * AC-9 (1): every answer is an edge JSON 502 or 504 with the *Header API*, and every answer that started
 * `windowMs` after the stop or later is 502; at least three such answers show it stays 502.
 */
export function stoppedBackendProblems(samples: readonly StoppedSample[], windowMs: number): string[] {
  const problems: string[] = [];
  const unexpected = samples.filter((sample) => !sample.edgeJson || (sample.status !== 502 && sample.status !== 504));
  if (unexpected.length > 0) problems.push(`${unexpected.length} jawaban bukan 502 atau 504 JSON edge`);
  const late = samples.filter((sample) => sample.atMs >= windowMs);
  if (late.length < 3) problems.push(`${late.length} jawaban sesudah ${windowMs} ms, diharapkan paling sedikit 3`);
  const late504 = late.filter((sample) => sample.status !== 502);
  if (late504.length > 0) problems.push(`${late504.length} jawaban sesudah ${windowMs} ms bukan 502`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Names and guards.

export const PROJECT_NAME = /^foundation-deploy-[0-9a-f]{12}$/;
const RUN_HEX = /^[0-9a-f]{12}$/;

/** Twelve hex digits from `randomBytes(6)`. */
export function runHex(random: Uint8Array = randomBytes(6)): string {
  const hex = Buffer.from(random).toString('hex');
  if (!RUN_HEX.test(hex)) throw new Error('Run id must be 12 hex digits');
  return hex;
}

export type DeploymentNames = {
  hex: string;
  project: string;
  /** The stopped container of the default runner command (AC-3). */
  migrate: string;
  stub: string;
  edgeStub: string;
  tags: Readonly<Record<ImageName, string>>;
};

export function deploymentNames(hex: string): DeploymentNames {
  if (!RUN_HEX.test(hex)) throw new Error('Run id must be 12 hex digits');
  return {
    hex,
    project: `foundation-deploy-${hex}`,
    migrate: `foundation-deploy-migrate-${hex}`,
    stub: `foundation-deploy-stub-${hex}`,
    edgeStub: `foundation-deploy-edgestub-${hex}`,
    tags: Object.freeze({ frontend: `foundation-frontend:deploy-${hex}`, backend: `foundation-backend:deploy-${hex}`, migrate: `foundation-migrate:deploy-${hex}` }),
  };
}

/** The project guard of cleanup: the fixed pattern and exactly the project of this run. */
export function projectAccepted(project: string, hex: string): boolean {
  return PROJECT_NAME.test(project) && project === `foundation-deploy-${hex}`;
}

/** The container guard of cleanup: one of the explicit container names of this run, never a pattern of another run. */
export function containerNameAccepted(name: string, hex: string): boolean {
  if (!RUN_HEX.test(hex)) return false;
  const names = deploymentNames(hex);
  return name === names.migrate || name === names.stub || name === names.edgeStub || new RegExp(`^foundation-deploy-probe-${hex}-[1-9][0-9]{0,2}$`).test(name);
}

// ---------------------------------------------------------------------------------------------------------------
// The command allow list.

const TOP_LEVEL = new Set(['version', 'info', 'pull', 'build', 'create', 'export', 'rm', 'history', 'inspect', 'logs', 'run']);
const PAIRED: Readonly<Record<string, ReadonlySet<string>>> = { buildx: new Set(['version']), image: new Set(['inspect', 'rm']), network: new Set(['inspect']) };
const COMPOSE_COMMANDS = new Set(['version', 'config', 'up', 'run', 'exec', 'stop', 'start', 'ps', 'port', 'down', 'build']);
const COMPOSE_GLOBAL_VALUE = new Set(['-p', '--project-name', '--env-file', '-f', '--file', '--profile']);

export class CommandRefused extends Error {}

/**
 * The only way this file calls Docker: `['docker', ...args]` when the subcommand is on the allow list of *Urutan
 * orkestrasi*, otherwise CommandRefused. `push`, `login`, `logout`, `tag`, `save`, `load`, and `compose logs` (which
 * merges stdout and stderr) are refused; `build` may only write a local output; and `compose build` only builds the
 * PostgreSQL service of the root docker-compose.yml.
 */
export function dockerArgs(args: readonly string[]): string[] {
  const [first, second] = args;
  if (first === undefined) throw new CommandRefused('empty');
  if (first === 'compose') {
    let index = 1;
    const files: string[] = [];
    while (index < args.length && args[index]!.startsWith('-')) {
      const flag = args[index]!;
      if (!COMPOSE_GLOBAL_VALUE.has(flag) || index + 1 >= args.length) throw new CommandRefused(flag);
      if (flag === '-f' || flag === '--file') files.push(args[index + 1]!);
      index += 2;
    }
    const command = args[index];
    if (command === undefined || !COMPOSE_COMMANDS.has(command)) throw new CommandRefused(`compose ${command ?? ''}`);
    if (command === 'build' && (files.length === 0 || files.some((file) => file !== ROOT_COMPOSE_FILE) || args.slice(index + 1).join(' ') !== 'postgres')) {
      throw new CommandRefused('compose build');
    }
    return ['docker', ...args];
  }
  const paired = PAIRED[first];
  if (paired !== undefined) {
    if (second === undefined || !paired.has(second)) throw new CommandRefused(`${first} ${second ?? ''}`);
    return ['docker', ...args];
  }
  if (!TOP_LEVEL.has(first)) throw new CommandRefused(first);
  if (first === 'build') {
    for (let index = 1; index < args.length; index++) {
      const value = args[index]!;
      if (value === '--push' || value.startsWith('--push=')) throw new CommandRefused('build --push');
      const output = value === '--output' || value === '-o' ? args[index + 1] : value.startsWith('--output=') ? value.slice('--output='.length) : undefined;
      if (output !== undefined && !output.startsWith('type=local,')) throw new CommandRefused('build --output');
    }
  }
  return ['docker', ...args];
}

// ---------------------------------------------------------------------------------------------------------------
// Base image pins (*Image dasar*).

const PIN = /^(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*):(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@sha256:(?<digest>[0-9a-f]{64})$/;
/** nginx stable line: an even minor version and an exact patch, on Alpine. */
const NGINX_STABLE_TAG = /^1\.[0-9]*[02468]\.[0-9]+-alpine$/;

/** Image references of the `FROM` and `COPY --from` lines of a Dockerfile, without the names of its own stages. */
export function dockerfileImages(text: string): string[] {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  const stages = new Set<string>();
  const images: string[] = [];
  for (const line of lines) {
    const words = line.split(/\s+/);
    const instruction = words[0]!.toUpperCase();
    if (instruction === 'FROM') {
      const rest = words.slice(1).filter((word) => !word.startsWith('--'));
      const reference = rest[0];
      if (reference !== undefined && !stages.has(reference)) images.push(reference);
      if (rest.length >= 3 && rest[1]!.toUpperCase() === 'AS') stages.add(rest[2]!);
    } else if (instruction === 'COPY' || instruction === 'ADD') {
      for (const word of words.slice(1)) {
        if (!word.startsWith('--from=')) continue;
        const reference = word.slice('--from='.length);
        if (!stages.has(reference)) images.push(reference);
      }
    }
  }
  return images;
}

export type PinCheck = { ok: true; bases: string[] } | { ok: false; detail: string };

/**
 * *Image dasar*: every `FROM` and `COPY --from=<image>` of the three Dockerfiles is `<repo>:<tag>@sha256:<64 hex>`, each
 * Dockerfile names exactly the repositories of its row, Node is `<engines.node>-trixie-slim`, Bun is
 * `<engines.bun>-slim` with the same reference as `bun.image` of tests/performance/images.json, and nginx is an exact
 * patch of the stable line on Alpine. `bases` lists the distinct references in first use order, for the pulls.
 */
export function checkPins(dockerfiles: Readonly<Record<string, string | null>>, engines: unknown, bunImages: unknown): PinCheck {
  const enginesRecord = engines !== null && typeof engines === 'object' ? (engines as Record<string, unknown>) : {};
  const node = enginesRecord['node'];
  const bun = enginesRecord['bun'];
  const bunEntry = bunImages !== null && typeof bunImages === 'object' ? (bunImages as Record<string, unknown>)['bun'] : undefined;
  const bunPinned = bunEntry !== null && typeof bunEntry === 'object' ? (bunEntry as Record<string, unknown>)['image'] : undefined;
  if (typeof node !== 'string' || typeof bun !== 'string' || typeof bunPinned !== 'string') return { ok: false, detail: 'engines' };
  const bases: string[] = [];
  for (const image of IMAGES) {
    const text = dockerfiles[image.dockerfile];
    if (typeof text !== 'string') return { ok: false, detail: image.dockerfile };
    const references = dockerfileImages(text);
    const repositories = new Set<string>();
    for (const reference of references) {
      const match = PIN.exec(reference);
      if (match?.groups === undefined) return { ok: false, detail: image.dockerfile };
      const { repository, tag } = match.groups as { repository: string; tag: string };
      const valid =
        (repository === 'node' && tag === `${node}-trixie-slim`) ||
        (repository === 'oven/bun' && tag === `${bun}-slim` && reference === bunPinned) ||
        (repository === 'nginx' && NGINX_STABLE_TAG.test(tag));
      if (!valid || !image.bases.includes(repository)) return { ok: false, detail: image.dockerfile };
      repositories.add(repository);
      if (!bases.includes(reference)) bases.push(reference);
    }
    if (repositories.size !== image.bases.length) return { ok: false, detail: image.dockerfile };
  }
  // One reference per repository across the three Dockerfiles.
  const perRepository = new Set(bases.map((reference) => reference.slice(0, reference.indexOf(':'))));
  if (perRepository.size !== bases.length) return { ok: false, detail: 'mixed pins' };
  return { ok: true, bases };
}

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers.

const ENV_VALUE = /^[A-Za-z0-9_./:@-]+$/;

/** Compose env file text; a value outside a plain character set (no quote, `$`, or space) is refused. */
export function envFileText(entries: readonly (readonly [string, string])[]): string {
  return entries
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !ENV_VALUE.test(value)) throw new Error(`Env file value of ${name} is not plain`);
      return `${name}=${value}\n`;
    })
    .join('');
}

/** A script for `compose exec backend bun --no-env-file -e`: one JSON line with status, body, and `Cache-Control`. */
export function healthScript(path: '/health/live' | '/health/ready'): string {
  return `fetch('http://127.0.0.1:8888${path}',{signal:AbortSignal.timeout(10000)}).then(async(r)=>console.log(JSON.stringify({status:r.status,body:await r.text(),cacheControl:r.headers.get('cache-control')})),()=>process.exit(1))`;
}

export type HealthAnswer = { status: number; body: string; cacheControl: string | null };

export function parseHealthAnswer(stdout: string): HealthAnswer | null {
  const line = stdout.trim().split('\n').pop();
  if (line === undefined || line === '') return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const { status, body, cacheControl } = value;
    if (typeof status !== 'number' || typeof body !== 'string' || (cacheControl !== null && typeof cacheControl !== 'string')) return null;
    return { status, body, cacheControl };
  } catch {
    return null;
  }
}

/** True when every line of an `image rm` failure says one of `tags` no longer exists: a skipped name, not a failure. */
export function onlyMissingImages(stderr: string, tags: readonly string[]): boolean {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.length > 0 && lines.every((line) => tags.some((tag) => line === `Error response from daemon: No such image: ${tag}`));
}

/** True when `text` holds one of the run secrets. */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret !== '' && text.includes(secret));
}

export function redactor(secrets: readonly string[]): (text: string) => string {
  return (text) => secrets.reduce((value, secret) => (secret === '' ? value : value.replaceAll(secret, '[redacted]')), text);
}

const clip = (text: string) => (text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text);

export type CheckStatus = 'passed' | 'failed' | 'not_run';
export type CheckRecord = { name: DeploymentCheckName; status: CheckStatus; detail: string | null };
export type Reason = { code: DeploymentReasonCode; detail: string | null };
export type Candidate = { commit: string | null; sourceTree: string | null };

export type DeploymentResult = {
  schema: 1;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  candidate: Candidate;
  checks: CheckRecord[];
  reasons: Reason[];
  boundary: string;
};

/** Every check of DEPLOYMENT_CHECKS in order, `not_run` unless recorded; `passed` only when every check passed. */
export function buildResult(input: { startedAt: string; finishedAt: string; candidate: Candidate; checks: ReadonlyMap<DeploymentCheckName, CheckRecord>; reasons: readonly Reason[] }): DeploymentResult {
  const checks = DEPLOYMENT_CHECKS.map(({ name }) => {
    const record = input.checks.get(name);
    return record === undefined ? { name, status: 'not_run' as const, detail: null } : { name, status: record.status, detail: record.detail === null ? null : clip(record.detail) };
  });
  return {
    schema: 1,
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    candidate: input.candidate,
    checks,
    reasons: input.reasons.map((reason) => ({ code: reason.code, detail: reason.detail === null ? null : clip(reason.detail) })),
    boundary: BOUNDARY,
  };
}

export type HandledSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';
export const SIGNAL_EXIT_CODES: Readonly<Record<HandledSignal, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

// ---------------------------------------------------------------------------------------------------------------
// The run.

export type CommandRunner = (argv: readonly string[], options: ProcessGroupOptions) => Promise<ProcessGroupResult>;

/** One request of the edge checks; `ca` is the run CA for HTTPS and `null` for the HTTP listener. */
export type EdgeHttpRequest = { url: string; method: string; headers: Readonly<Record<string, string>>; body: string | null; ca: string | null; timeoutMs: number };
/** One raw HTTP/1.1 request to the HTTPS port: `target` is sent as is on the request line. */
export type EdgeRawRequest = { port: number; ca: string; target: string; headers: HeaderList; timeoutMs: number };
/** One HTTP/2 GET of `path` with one header field of `headerBytes` bytes, above `large_client_header_buffers`. */
export type EdgeH2Request = { port: number; ca: string; path: string; headerBytes: number; timeoutMs: number };

export type RunDeps = {
  /** Checkout root: source of the copy, the pin files, and the evidence folder `.local/feature-13/`. */
  root: string;
  /** Command runner: `runProcessGroup` or a stand in. */
  run: CommandRunner;
  /** Aborted by the signal handlers; `reason` is the signal name. */
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Environment of this process, the source of the command allow list. */
  env?: Readonly<Record<string, string | undefined>>;
  /** DEPLOYMENT_DEADLINE_MS unless a test passes a smaller total limit. */
  deadlineMs?: number;
  /** A free loopback port; a `node:net` server on port 0 by default. */
  freePort?: () => Promise<number>;
  /** One HTTPS request to the edge, trusting only the run CA; Bun `fetch` by default. */
  edgeFetch?: (url: string, ca: string, signal: AbortSignal) => Promise<number | null>;
  /** One HTTP request to the edge with its answer; Bun `fetch` with `tls: { ca }` for HTTPS by default. */
  edgeHttp?: (request: EdgeHttpRequest, signal: AbortSignal) => Promise<EdgeAnswer | null>;
  /** One raw HTTP/1.1 request line over TLS to the edge, verified with the run CA; `node:tls` by default. */
  edgeRaw?: (request: EdgeRawRequest, signal: AbortSignal) => Promise<EdgeAnswer | null>;
  /**
   * One HTTP/2 request that nginx ends without an answer, over TLS verified with the run CA; `node:http2` by default.
   * Gives `reset`, `status <code>`, or `null` when no TLS session was set up.
   */
  edgeH2?: (request: EdgeH2Request, signal: AbortSignal) => Promise<string | null>;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

class Stop extends Error {}

type Context = {
  deps: RunDeps;
  names: DeploymentNames;
  dockerEnv: Record<string, string>;
  secrets: string[];
  redact: (text: string) => string;
  reasons: Reason[];
  checks: Map<DeploymentCheckName, CheckRecord>;
  /** Output of every command per label, for the credential scan and the failure tails; never printed whole. */
  outputs: Map<string, string>;
  /** Resources this run created, the only ones cleanup may remove. */
  created: { folder: string | null; compose: boolean; containers: Set<string>; images: Set<string> };
  envFile: string | null;
  /** Provisioning credentials stay out of the env file: only the environment of the provisioning run carries them. */
  provisioning: { adminUrl: string; migratorPassword: string; backendPassword: string } | null;
  contextDir: string | null;
  caPem: string | null;
  caFile: string | null;
  httpsPort: number | null;
  httpPort: number | null;
  /** The passwords and DSNs of the run, for the frontend bundle check and the environment check; never printed. */
  credentials: Readonly<{ adminPassword: string; adminUrl: string; migratorUrl: string; backendUrl: string; migratorPassword: string; backendPassword: string }> | null;
  /** Number of the last probe or scan container name `foundation-deploy-probe-<hex>-<n>`. */
  probes: number;
  /** Files and symlinks of the copy, relative and in code unit order, without the probe folder. */
  copyPaths: string[];
  /** `docker image inspect` of each image of the run, for images.json and the inspect checks. */
  imageInspect: Map<ImageName, unknown>;
  /** stdout and stderr of the backend container that the recreate replaced, read just before it. */
  priorBackendLogs: { stdout: string; stderr: string } | null;
  /** The sentinel values planted in the copy (*Sentinel konteks build*). */
  sentinels: string[];
  /** Problems of the requests that carried log sentinels; judged by log_no_data. */
  sentinelProblems: string[];
  /** Container output read for the log checks, per label; scanned again for artifact-scan.json. */
  containerOutputs: [string, string][];
  /** Aborted by a signal or by the total deadline. */
  stop: AbortSignal;
  deadlineAt: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  step: string;
  log: (line: string) => void;
  error: (line: string) => void;
};

const succeeded = (result: ProcessGroupResult) => result.code === 0 && !result.timedOut && !result.aborted;

function fail(context: Context, code: DeploymentReasonCode, detail: string | null = null): never {
  context.reasons.push({ code, detail });
  throw new Stop(code);
}

function pass(context: Context, name: DeploymentCheckName, detail: string | null = null): void {
  context.checks.set(name, { name, status: 'passed', detail });
  context.log(`deployment: check ${name} passed`);
}

/** A failed check stops the run: every later step of this milestone depends on the earlier ones. */
function checkFailed(context: Context, name: DeploymentCheckName, detail: string): never {
  context.checks.set(name, { name, status: 'failed', detail });
  context.error(`deployment: check ${name} failed: ${context.redact(detail)}`);
  fail(context, 'check_failed', name);
}

function stopIfAborted(context: Context): void {
  if (context.stop.aborted || context.now() >= context.deadlineAt) throw new Stop('aborted');
}

function record(context: Context, label: string, result: ProcessGroupResult): void {
  context.outputs.set(label, (context.outputs.get(label) ?? '') + result.stdout + result.stderr);
}

/** The last 20 lines of a failed command, redacted, so a failure in CI can be read without the secrets. */
function printTail(context: Context, label: string, result: ProcessGroupResult): void {
  const text = context.redact(`${result.stdout}${result.stderr}`).trimEnd();
  if (text !== '') context.error(`--- ${label} (20 baris terakhir, credential disamarkan) ---\n${text.split('\n').slice(-20).join('\n')}`);
}

/**
 * One command through `deps.run` with a collected output. Abortable commands stop on a signal or the total deadline and
 * get the smaller of their own limit and the time left; cleanup commands are not abortable and keep their own limit.
 */
async function execute(context: Context, label: string, argv: string[], timeoutMs: number, options: { abortable?: boolean; env?: Record<string, string>; cwd?: string } = {}): Promise<ProcessGroupResult> {
  const abortable = options.abortable ?? true;
  if (abortable) stopIfAborted(context);
  const limit = abortable ? Math.max(1, Math.min(timeoutMs, context.deadlineAt - context.now())) : timeoutMs;
  let result: ProcessGroupResult;
  try {
    result = await context.deps.run(argv, {
      cwd: options.cwd ?? context.deps.root,
      env: options.env ?? context.dockerEnv,
      timeoutMs: limit,
      output: 'pipe',
      ...(abortable ? { signal: context.stop } : {}),
    });
  } catch {
    result = { code: null, timedOut: false, aborted: false, stdout: '', stderr: '' };
  }
  record(context, label, result);
  if (abortable && (result.aborted || context.stop.aborted || context.now() >= context.deadlineAt)) throw new Stop('aborted');
  return result;
}

const call = (context: Context, label: string, args: readonly string[], timeoutMs: number, options: { abortable?: boolean; env?: Record<string, string> } = {}) =>
  execute(context, label, dockerArgs(args), timeoutMs, options);

/** `compose -p <project> --env-file <file> -f deploy/compose.yaml -f <test override>`, then `rest`. */
function compose(context: Context, ...rest: string[]): string[] {
  if (context.envFile === null) throw new Error('Compose env file missing');
  return ['compose', '-p', context.names.project, '--env-file', context.envFile, '-f', COMPOSE_FILE, '-f', COMPOSE_TEST_FILE, ...rest];
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function defaultFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, failed) => server.once('error', failed).listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (address === null || typeof address === 'string') throw new Error('No free loopback port');
  return address.port;
}

async function defaultEdgeFetch(url: string, ca: string, signal: AbortSignal): Promise<number | null> {
  try {
    const response = await fetch(url, { tls: { ca }, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUTS.exec)]), redirect: 'manual' });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return null;
  }
}

async function defaultEdgeHttp(request: EdgeHttpRequest, signal: AbortSignal): Promise<EdgeAnswer | null> {
  const started = performance.now();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: request.body }),
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]),
      ...(request.ca === null ? {} : { tls: { ca: request.ca } }),
    });
    const body = await response.text();
    return { status: response.status, headers: [...response.headers.entries()], body, elapsedMs: performance.now() - started };
  } catch {
    return null;
  }
}

/**
 * A raw HTTP/1.1 request over TLS to 127.0.0.1 with SNI `localhost`, verified with the run CA (never with verification
 * off), read until the edge closes the connection (`Connection: close`).
 */
async function defaultEdgeRaw(request: EdgeRawRequest, signal: AbortSignal): Promise<EdgeAnswer | null> {
  const started = performance.now();
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const socket = tlsConnect({ host: '127.0.0.1', port: request.port, servername: 'localhost', ca: request.ca, ALPNProtocols: ['http/1.1'] }, () => {
      const lines = [`GET ${request.target} HTTP/1.1`, `Host: localhost:${request.port}`, ...request.headers.map(([name, value]) => `${name}: ${value}`), 'Connection: close', '', ''];
      socket.write(lines.join('\r\n'));
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      socket.destroy();
      // An answer the edge sent before it reset the connection (a request header that is too large) still counts.
      const parsed = socket.authorized ? parseHttpAnswer(Buffer.concat(chunks)) : null;
      done(parsed === null ? null : { ...parsed, elapsedMs: performance.now() - started });
    };
    const timer = setTimeout(finish, request.timeoutMs);
    signal.addEventListener('abort', finish);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

/**
 * An HTTP/2 GET whose header field is above `large_client_header_buffers`: nginx 1.30.5 ends the stream or the session
 * without an answer and logs the request with status 000, the case of AC-10 that once wrote `"status":000`. The value
 * repeats `~`, whose HPACK Huffman code is 13 bits, so the field stays above 8 KiB on the wire; `h` would shrink below it.
 */
async function defaultEdgeH2(request: EdgeH2Request, signal: AbortSignal): Promise<string | null> {
  return new Promise((done) => {
    let settled = false;
    let connected = false;
    const session = http2Connect(`https://127.0.0.1:${request.port}`, { ca: request.ca, servername: 'localhost' });
    const finish = (outcome: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      session.destroy();
      done(outcome);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, request.timeoutMs);
    signal.addEventListener('abort', abort);
    session.on('connect', () => { connected = true; });
    session.on('error', () => finish(connected ? 'reset' : null));
    const stream = session.request({ ':method': 'GET', ':path': request.path, 'x-foundation-large': '~'.repeat(request.headerBytes) });
    stream.on('response', (headers) => finish(`status ${String(headers[':status'])}`));
    stream.on('error', () => finish(connected ? 'reset' : null));
    stream.on('close', () => finish(connected ? 'reset' : null));
    stream.end();
  });
}

// --- Step 1: tools and pins.

async function preflight(context: Context): Promise<string[]> {
  context.step = 'tools';
  const tools: [string, string[]][] = [
    ['docker', ['version']],
    ['buildx', ['buildx', 'version']],
    ['compose', ['compose', 'version']],
  ];
  for (const [tool, args] of tools) {
    if (!succeeded(await call(context, `${tool} version`, args, TIMEOUTS.query))) fail(context, 'tool_missing', tool);
  }
  const openssl = await execute(context, 'openssl version', ['openssl', 'version'], TIMEOUTS.query);
  if (!succeeded(openssl) || !openssl.stdout.startsWith('OpenSSL 3')) fail(context, 'tool_missing', 'openssl');

  context.step = 'pins';
  const { root } = context.deps;
  const dockerfiles: Record<string, string | null> = {};
  for (const image of IMAGES) dockerfiles[image.dockerfile] = await readText(join(root, image.dockerfile));
  const manifest = parseJson(await readText(join(root, 'package.json')));
  const pins = checkPins(dockerfiles, isRecord(manifest) ? manifest['engines'] : undefined, parseJson(await readText(join(root, BUN_PINS_PATH))));
  if (!pins.ok) {
    context.checks.set('image_pins', { name: 'image_pins', status: 'failed', detail: pins.detail });
    fail(context, 'pin_invalid', pins.detail);
  }
  pass(context, 'image_pins', `${pins.bases.length} image dasar dipin tag dan digest`);
  return pins.bases;
}

// --- Step 2: the copy, the sentinels, TLS, passwords, and the env file.

async function copyEntry(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target);
  } else if (info.isDirectory()) {
    // 0755 like a checkout: BuildKit keeps the mode of a copied folder, and UID 1000 must read database/migrations.
    // The run folder above stays 0700.
    await mkdir(target, { recursive: true, mode: 0o755 });
    for (const entry of (await readdir(source)).sort()) {
      if (!copySkipped(entry)) await copyEntry(join(source, entry), join(target, entry));
    }
  } else if (info.isFile()) {
    await copyFile(source, target);
  }
  // Sockets, FIFOs, and devices are never build inputs.
}

/** Copies every input of buildInputs() that exists, without following symlinks and without the copySkipped names. */
export async function copyBuildInputs(root: string, destination: string): Promise<void> {
  for (const input of buildInputs()) {
    const star = input.indexOf('*');
    if (star !== -1) {
      const folder = input.slice(0, input.lastIndexOf('/', star));
      const suffix = input.slice(star + 1);
      let entries: string[] = [];
      try {
        entries = (await readdir(join(root, folder))).sort();
      } catch {
        continue;
      }
      for (const name of entries) {
        if (copySkipped(name) || !name.endsWith(suffix)) continue;
        const info = await lstat(join(root, folder, name));
        if (!info.isFile() && !info.isSymbolicLink()) continue;
        await mkdir(join(destination, folder), { recursive: true, mode: 0o755 });
        await copyEntry(join(root, folder, name), join(destination, folder, name));
      }
      continue;
    }
    const path = input.replace(/\/$/, '');
    try {
      await lstat(join(root, path));
    } catch {
      continue;
    }
    await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o755 });
    await copyEntry(join(root, path), join(destination, path));
  }
}

function secret(context: Context, bytes: number): string {
  const value = randomBytes(bytes).toString('hex');
  context.secrets.push(value);
  return value;
}

/** A temporary CA and an edge certificate, EC P-256, two days, SAN localhost and 127.0.0.1; the CA key is then removed. */
async function issueCertificates(context: Context, folder: string): Promise<{ cert: string; key: string }> {
  const tls = join(folder, 'tls');
  await mkdir(tls, { mode: 0o700 });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2'];
  const ca = await execute(context, 'openssl ca', ['openssl', 'req', '-x509', ...ec, '-keyout', join(tls, 'ca.key'), '-out', join(tls, 'ca.pem'),
    '-subj', `/CN=Foundation deploy test CA ${context.names.hex}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], TIMEOUTS.certificate, { cwd: tls });
  if (!succeeded(ca)) fail(context, 'tool_missing', 'openssl');
  const cert = join(tls, 'edge.pem');
  const key = join(tls, 'edge.key');
  const leaf = await execute(context, 'openssl edge', ['openssl', 'req', '-x509', ...ec, '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
    '-CA', join(tls, 'ca.pem'), '-CAkey', join(tls, 'ca.key'),
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=serverAuth'], TIMEOUTS.certificate, { cwd: tls });
  if (!succeeded(leaf)) fail(context, 'tool_missing', 'openssl');
  await rm(join(tls, 'ca.key'), { force: true });
  // UID 101 in the edge reads the key through the secret mount; the 0700 folder keeps it from other host users.
  await chmod(key, 0o644);
  context.caFile = join(tls, 'ca.pem');
  context.caPem = await readFile(context.caFile, 'utf8');
  return { cert, key };
}

async function prepareWorkspace(context: Context): Promise<void> {
  context.step = 'workspace';
  const { root } = context.deps;
  const folder = await mkdtemp(join(tmpdir(), `foundation-deploy-${context.names.hex}-`));
  context.created.folder = folder;
  await chmod(folder, 0o700);
  const contextDir = join(folder, 'context');
  await mkdir(contextDir, { mode: 0o755 });
  await copyBuildInputs(root, contextDir);
  for (const path of SENTINEL_PATHS) {
    const target = join(contextDir, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const value = secret(context, 16);
    context.sentinels.push(value);
    await writeFile(target, `FOUNDATION_SENTINEL=${value}\n`, { mode: 0o600 });
  }
  context.contextDir = contextDir;
  context.copyPaths = await listTree(contextDir);

  context.step = 'tls';
  const { cert, key } = await issueCertificates(context, folder);

  context.step = 'env_file';
  const [adminPassword, migratorPassword, backendPassword] = [secret(context, 24), secret(context, 24), secret(context, 24)];
  const dsn = (role: string, password: string) => `postgres://${role}:${password}@postgres:5432/foundation`;
  const adminUrl = dsn('foundation_admin', adminPassword);
  const migratorUrl = dsn('foundation_migrator', migratorPassword);
  const backendUrl = dsn('foundation_backend', backendPassword);
  context.secrets.push(adminUrl, migratorUrl, backendUrl);
  const freePort = context.deps.freePort ?? defaultFreePort;
  const httpsPort = await freePort();
  let httpPort = await freePort();
  if (httpPort === httpsPort) httpPort = await freePort();
  context.httpsPort = httpsPort;
  context.httpPort = httpPort;
  const envFile = join(folder, 'deploy.env');
  await writeFile(envFile, envFileText([
    ['FOUNDATION_FRONTEND_IMAGE', context.names.tags.frontend],
    ['FOUNDATION_BACKEND_IMAGE', context.names.tags.backend],
    ['FOUNDATION_MIGRATE_IMAGE', context.names.tags.migrate],
    ['FOUNDATION_POSTGRES_PASSWORD', adminPassword],
    ['FOUNDATION_BACKEND_DATABASE_URL', backendUrl],
    ['FOUNDATION_MIGRATOR_DATABASE_URL', migratorUrl],
    ['FOUNDATION_EDGE_TLS_CERT_FILE', cert],
    ['FOUNDATION_EDGE_TLS_KEY_FILE', key],
    ['FOUNDATION_EDGE_BIND', '127.0.0.1'],
    ['FOUNDATION_EDGE_HTTPS_PORT', String(httpsPort)],
    ['FOUNDATION_EDGE_HTTP_PORT', String(httpPort)],
    ['FOUNDATION_DEPLOY_RUN', context.names.hex],
  ]), { mode: 0o600 });
  context.envFile = envFile;
  context.provisioning = { adminUrl, migratorPassword, backendPassword };
  context.credentials = { adminPassword, adminUrl, migratorUrl, backendUrl, migratorPassword, backendPassword };
  context.log(`deployment: salinan input, sentinel, sertifikat, dan env file siap di folder run`);
}

// --- Steps 3 and 4: pulls, the PostgreSQL image, and the builds.

async function ensurePostgresImage(context: Context): Promise<void> {
  context.step = 'postgres_image';
  const { root } = context.deps;
  const pins = parseJson(await readText(join(root, POSTGRES_PINS_PATH)));
  const baseImage = isRecord(pins) ? pins['baseImage'] : undefined;
  const packageVersion = isRecord(pins) ? pins['postgresPackageVersion'] : undefined;
  if (typeof baseImage !== 'string' || typeof packageVersion !== 'string') fail(context, 'postgres_image_failed', POSTGRES_PINS_PATH);
  const labelled = async () => {
    const inspected = await call(context, 'postgres image inspect', ['image', 'inspect', '--format', '{{json .Config.Labels}}', POSTGRES_IMAGE], TIMEOUTS.query);
    const labels = succeeded(inspected) ? parseJson(inspected.stdout) : undefined;
    return isRecord(labels) && labels['org.opencontainers.image.base.name'] === baseImage;
  };
  if (await labelled()) return;
  context.log(`deployment: membangun ${POSTGRES_IMAGE} dari ${POSTGRES_PINS_PATH}`);
  const folder = context.created.folder;
  if (folder === null) throw new Error('Run folder missing');
  const envFile = join(folder, 'postgres-build.env');
  await writeFile(envFile, envFileText([
    ['FOUNDATION_POSTGRES_PASSWORD', secret(context, 24)],
    ['FOUNDATION_POSTGRES_IMAGE', POSTGRES_IMAGE],
    ['FOUNDATION_POSTGRES_BASE_IMAGE', baseImage],
    ['FOUNDATION_POSTGRES_PACKAGE_VERSION', packageVersion],
  ]), { mode: 0o600 });
  const built = await call(context, 'postgres build', ['compose', '-p', context.names.project, '--env-file', envFile, '-f', ROOT_COMPOSE_FILE, 'build', 'postgres'], TIMEOUTS.postgresBuild);
  await rm(envFile, { force: true });
  if (!succeeded(built) || !(await labelled())) {
    printTail(context, 'postgres build', built);
    fail(context, 'postgres_image_failed', POSTGRES_IMAGE);
  }
}

async function buildImages(context: Context, bases: readonly string[], candidate: Candidate): Promise<void> {
  context.step = 'pull';
  for (const base of bases) {
    context.log(`deployment: menarik ${base.slice(0, base.indexOf('@'))}`);
    if (!succeeded(await call(context, `pull ${base}`, ['pull', base], TIMEOUTS.pull))) fail(context, 'image_pull_failed', base.slice(0, base.indexOf(':')));
  }
  await ensurePostgresImage(context);

  context.step = 'build';
  const contextDir = context.contextDir;
  if (contextDir === null) throw new Error('Build context missing');
  // All three tags belong to the run from the first build on, so cleanup removes them with one `image rm`.
  for (const image of IMAGES) context.created.images.add(context.names.tags[image.name]);
  const labels = [
    '--label', `org.opencontainers.image.revision=${candidate.commit ?? 'unknown'}`,
    '--label', `foundation.source-tree=${candidate.sourceTree ?? 'unknown'}`,
    '--label', 'foundation.test=deployment',
    '--label', `foundation.run=${context.names.hex}`,
  ];
  await contextProbe(context);
  for (const image of IMAGES) {
    context.log(`deployment: membangun image ${image.name} (${context.names.tags[image.name]})`);
    const built = await call(context, `build ${image.name}`, ['build', '-f', join(contextDir, image.dockerfile), '-t', context.names.tags[image.name], ...labels, contextDir], TIMEOUTS.build[image.name]);
    if (!succeeded(built)) {
      printTail(context, `build ${image.name}`, built);
      fail(context, 'image_build_failed', image.name);
    }
  }
  await scanImages(context, candidate);
}

/** Files and symlinks below `folder`, relative with `/`, without following a symlink, in code unit order. */
async function listTree(folder: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(prefix === '' ? folder : join(folder, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await listTree(folder, path)));
    else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
  }
  return paths.sort(codeUnit);
}

/** Gives the owner write access on every folder below `path`, so a tree with read only folders can be removed. */
async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}

/** Removes a folder of the run, also when an export or a probe output left a read only folder in it. */
async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    await makeWritable(path);
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * *Probe konteks* (check image_context_sentinels, AC-1 and AC-2): for each Dockerfile, a `FROM scratch` build with
 * `COPY . /context/` and a byte copy of its ignore file, exported with `--output type=local` into a folder of the run.
 * The files under `context/` must equal expectedContext over the copy, with no `.env` base name and no sentinel value.
 * The copy itself must hold no `.env` file, `node_modules`, `dist`, or `.angular` from the checkout.
 */
async function contextProbe(context: Context): Promise<void> {
  context.step = 'image_context_sentinels';
  const contextDir = context.contextDir;
  const folder = context.created.folder;
  if (contextDir === null || folder === null) throw new Error('Build context missing');
  const problems = copyProblems(context.copyPaths.filter((path) => !SENTINEL_PATHS.includes(path))).map((path) => `salinan memuat ${path}`);
  const probeDir = join(contextDir, '.context-probe');
  await mkdir(probeDir, { recursive: true, mode: 0o755 });
  const sentinels = context.sentinels.map((value) => Buffer.from(value));
  let files = 0;
  for (const [index, image] of IMAGES.entries()) {
    const n = index + 1;
    const ignore = `${image.dockerfile}.dockerignore`;
    const rule = CONTEXT_ALLOWLIST[ignore];
    if (rule === undefined) throw new Error('Allow list row missing');
    await writeFile(join(probeDir, `${n}.Dockerfile`), CONTEXT_PROBE_DOCKERFILE);
    await copyFile(join(contextDir, ignore), join(probeDir, `${n}.Dockerfile.dockerignore`));
    const output = await mkdtemp(join(folder, `context-${n}-`));
    try {
      const built = await call(context, `context probe ${image.name}`, ['build', '-f', join(probeDir, `${n}.Dockerfile`), '--output', `type=local,dest=${output}`, contextDir], TIMEOUTS.contextProbe);
      if (!succeeded(built)) {
        printTail(context, `context probe ${image.name}`, built);
        problems.push(`probe ${image.name} gagal dibangun`);
        continue;
      }
      let found: string[];
      try {
        found = await listTree(join(output, 'context'));
      } catch {
        problems.push(`probe ${image.name} tanpa folder context`);
        continue;
      }
      const expected = expectedContext(context.copyPaths, rule);
      if (!sameList(found, expected)) {
        const extra = found.filter((path) => !expected.includes(path));
        const missing = expected.filter((path) => !found.includes(path));
        problems.push(`${image.name}: konteks ${extra.length} berlebih${extra[0] === undefined ? '' : ` (${extra[0]})`}, ${missing.length} kurang${missing[0] === undefined ? '' : ` (${missing[0]})`}`);
      }
      const envNamed = found.filter((path) => ENV_FILE_NAME.test(baseName(path)));
      if (envNamed.length > 0) problems.push(`${image.name}: konteks memuat ${envNamed[0]}`);
      for (const path of found) {
        const full = join(output, 'context', path);
        const data = (await lstat(full)).isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full);
        if (sentinels.some((value) => data.includes(value))) problems.push(`${image.name}: ${path} memuat nilai sentinel`);
      }
      files += found.length;
    } finally {
      await removeTree(output).catch(() => undefined);
    }
  }
  judge(context, 'image_context_sentinels', problems, `${IMAGES.length} probe konteks sama dengan expectedContext (${files} file) tanpa .env dan tanpa nilai sentinel; salinan tanpa .env, node_modules, dist, dan .angular`);
}

/** A new probe or scan container name of this run, recorded for cleanup before Docker creates it. */
function nextProbe(context: Context): string {
  context.probes += 1;
  const name = `foundation-deploy-probe-${context.names.hex}-${context.probes}`;
  if (!containerNameAccepted(name, context.names.hex)) throw new Error('Probe name refused');
  context.created.containers.add(name);
  return name;
}

/** One image of images.json (*Check deployment*, paragraph after the table). */
export type ImageRecord = {
  name: ImageName; dockerfile: string; tag: string; imageId: string | null; sizeBytes: number | null; user: string | null;
  exposedPorts: string[]; stopSignal: string | null; healthcheck: boolean; bases: string[];
  labels: { revision: string | null; sourceTree: string | null }; files: { count: number; sha256: string } | null;
};

/** One image of images.json from its inspect object, the bases of its Dockerfile, and the exported path list. */
export function imageRecord(image: Readonly<{ name: ImageName; dockerfile: string }>, tag: string, inspected: unknown, bases: string[], paths: readonly string[] | null): ImageRecord {
  const object = recordOf(inspected);
  const config = recordOf(object['Config']);
  const labels = recordOf(config['Labels']);
  const check = recordOf(config['Healthcheck']);
  const test = check['Test'];
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    name: image.name,
    dockerfile: image.dockerfile,
    tag,
    imageId: text(object['Id']),
    sizeBytes: typeof object['Size'] === 'number' ? object['Size'] : null,
    user: text(config['User']),
    exposedPorts: Object.keys(recordOf(config['ExposedPorts'])).sort(codeUnit),
    stopSignal: text(config['StopSignal']),
    healthcheck: Array.isArray(test) && test.length > 0 && test[0] !== 'NONE',
    bases,
    labels: { revision: text(labels['org.opencontainers.image.revision']), sourceTree: text(labels['foundation.source-tree']) },
    files: paths === null ? null : { count: paths.length, sha256: pathListDigest(paths) },
  };
}

/** checkFrontendBundle over `/srv/frontend/` of the exported edge image, with the application source of the copy. */
async function frontendBundleProblems(context: Context, tar: string): Promise<string[]> {
  const folder = context.created.folder;
  const contextDir = context.contextDir;
  const credentials = context.credentials;
  if (folder === null || contextDir === null || credentials === null) throw new Error('Run state missing');
  const target = await mkdtemp(join(folder, 'frontend-'));
  try {
    const extracted = await execute(context, 'tar frontend', ['tar', '-xf', tar, '-C', target, 'srv/frontend'], TIMEOUTS.imageScan);
    if (!succeeded(extracted)) return ['frontend: /srv/frontend/ tidak dapat diekstrak dari export'];
    await makeWritable(target);
    try {
      await checkFrontendBundle({
        applicationSource: join(contextDir, 'apps/frontend/src'),
        outputDirectory: join(target, 'srv/frontend'),
        environment: {
          FOUNDATION_POSTGRES_PASSWORD: credentials.adminPassword,
          FOUNDATION_MIGRATOR_PASSWORD: credentials.migratorPassword,
          FOUNDATION_BACKEND_PASSWORD: credentials.backendPassword,
          FOUNDATION_ADMIN_DATABASE_URL: credentials.adminUrl,
          FOUNDATION_MIGRATOR_DATABASE_URL: credentials.migratorUrl,
          FOUNDATION_BACKEND_DATABASE_URL: credentials.backendUrl,
        },
      });
      return [];
    } catch (error) {
      return [`frontend: checkFrontendBundle gagal (${error instanceof FrontendBundleError ? error.message : 'galat tak terduga'})`];
    }
  } finally {
    await removeTree(target).catch(() => undefined);
  }
}

/**
 * The AC-2 scan of the three images (checks image_filesystem and image_config) and images.json. Per image: `docker
 * create` under a probe name, `docker export -o <tar>`, `docker rm`, `tar -tf`, a read of the tar bytes for every run
 * secret (the sentinels, passwords, and DSNs), the final stage files of the *Image* table, and for the edge image
 * checkFrontendBundle over `/srv/frontend/`. Then `docker image inspect` and `docker history --no-trunc`, which must
 * hold no sentinel value either, against the *Image* table and the build labels.
 */
async function scanImages(context: Context, candidate: Candidate): Promise<void> {
  context.step = 'image_filesystem';
  const folder = context.created.folder;
  if (folder === null) throw new Error('Run folder missing');
  const filesystem: string[] = [];
  const configuration: string[] = [];
  const records: ImageRecord[] = [];
  let scanned = 0;
  for (const image of IMAGES) {
    const tag = context.names.tags[image.name];
    const tar = join(folder, `${image.name}.tar`);
    let paths: string[] | null = null;
    try {
      const name = nextProbe(context);
      const created = await call(context, `create ${image.name}`, ['create', '--name', name, '--label', 'foundation.test=deployment', '--label', `foundation.run=${context.names.hex}`, tag], TIMEOUTS.imageScan);
      const exported = succeeded(created) ? await call(context, `export ${image.name}`, ['export', '-o', tar, name], TIMEOUTS.imageScan) : created;
      const removed = await call(context, `rm ${image.name}`, ['rm', name], TIMEOUTS.imageScan);
      if (succeeded(removed)) context.created.containers.delete(name);
      if (!succeeded(created) || !succeeded(exported)) {
        filesystem.push(`${image.name}: docker create atau export gagal`);
      } else {
        const listing = await execute(context, `tar ${image.name}`, ['tar', '-tf', tar], TIMEOUTS.imageScan);
        if (!succeeded(listing)) filesystem.push(`${image.name}: tar -tf gagal`);
        else {
          const entries = exportEntries(listing.stdout);
          paths = entries.paths;
          const bytes = await readFile(tar);
          const leaked = context.secrets.filter((value) => value !== '' && bytes.includes(Buffer.from(value))).length;
          if (leaked > 0) filesystem.push(`${image.name}: filesystem memuat ${leaked} nilai rahasia run`);
          const runner = CONTEXT_ALLOWLIST['database/Dockerfile.dockerignore'];
          filesystem.push(...imageFilesystemProblems(image.name, entries, image.name === 'migrate' && runner !== undefined ? expectedContext(context.copyPaths, runner) : []));
          if (image.name === 'frontend') filesystem.push(...(await frontendBundleProblems(context, tar)));
          scanned += 1;
        }
      }
    } finally {
      await rm(tar, { force: true });
    }

    context.step = 'image_config';
    const inspected = await call(context, `image inspect ${image.name}`, ['image', 'inspect', tag], TIMEOUTS.query);
    const history = await call(context, `history ${image.name}`, ['history', '--no-trunc', tag], TIMEOUTS.query);
    const list = succeeded(inspected) ? parseJson(inspected.stdout) : undefined;
    const object = Array.isArray(list) ? list[0] : undefined;
    if (!isRecord(object) || !succeeded(history)) configuration.push(`${image.name}: image inspect atau history gagal`);
    else {
      context.imageInspect.set(image.name, object);
      if (containsSecret(inspected.stdout, context.secrets)) configuration.push(`${image.name}: image inspect memuat nilai rahasia run`);
      if (containsSecret(history.stdout, context.secrets)) configuration.push(`${image.name}: history memuat nilai rahasia run`);
      const args = secretArgs(history.stdout);
      if (args.length > 0) configuration.push(`${image.name}: ARG ${args.join(', ')}`);
      configuration.push(...imageConfigProblems(image.name, object, { revision: candidate.commit ?? 'unknown', sourceTree: candidate.sourceTree ?? 'unknown', hex: context.names.hex }));
    }
    const dockerfile = await readText(join(context.contextDir ?? context.deps.root, image.dockerfile));
    const bases = dockerfile === null ? [] : [...new Set(dockerfileImages(dockerfile))];
    records.push(imageRecord(image, tag, object, bases, paths));
    context.step = 'image_filesystem';
  }
  judge(context, 'image_filesystem', filesystem, `${scanned} filesystem image tanpa nilai sentinel, password, DSN, atau path .env; isi stage akhir sesuai tabel Image; checkFrontendBundle lulus atas /srv/frontend/`);
  judge(context, 'image_config', configuration, 'image inspect dan history tanpa nilai sentinel; USER numerik, entrypoint, STOPSIGNAL, HEALTHCHECK, ENV, dan label sesuai tabel Image');

  const postgres = await call(context, 'postgres image id', ['image', 'inspect', '--format', '{{.Id}}', POSTGRES_IMAGE], TIMEOUTS.query);
  const document = { schema: 1, images: records, postgres: { image: POSTGRES_IMAGE, imageId: succeeded(postgres) ? postgres.stdout.trim() : null } };
  await writeFile(join(context.deps.root, EVIDENCE_ROOT, 'images.json'), context.redact(`${JSON.stringify(document, null, 2)}\n`));
}

// --- Step 5: the documented deployment steps.

async function composeStep(context: Context, label: string, args: string[], timeoutMs: number, options: { env?: Record<string, string> } = {}): Promise<ProcessGroupResult> {
  const result = await call(context, label, compose(context, ...args), timeoutMs, options);
  return result;
}

async function backendHealth(context: Context, path: '/health/live' | '/health/ready'): Promise<HealthAnswer | null> {
  const result = await composeStep(context, `exec backend ${path}`, ['exec', '-T', 'backend', 'bun', '--no-env-file', '-e', healthScript(path)], TIMEOUTS.exec);
  return succeeded(result) ? parseHealthAnswer(result.stdout) : null;
}

type BackendState = { id: string; startedAt: string; restartCount: number };

/** The backend container of the project and its start time, after `docker inspect` confirms the run label. */
async function backendState(context: Context): Promise<BackendState | null> {
  const listed = await composeStep(context, 'ps backend', ['ps', '-a', '-q', 'backend'], TIMEOUTS.query);
  const id = listed.stdout.trim();
  if (!succeeded(listed) || !/^[0-9a-f]{12,64}$/.test(id)) return null;
  const inspected = await call(context, 'inspect backend', ['inspect', '--format', '{{json .State.StartedAt}}|{{.RestartCount}}|{{json .Config.Labels}}', id], TIMEOUTS.query);
  if (!succeeded(inspected)) return null;
  const [startedAt, restarts, labels] = inspected.stdout.trim().split('|');
  const parsedLabels = parseJson(labels ?? null);
  const started = parseJson(startedAt ?? null);
  const restartCount = Number(restarts);
  if (!isRecord(parsedLabels) || parsedLabels['foundation.run'] !== context.names.hex || typeof started !== 'string' || !Number.isInteger(restartCount)) return null;
  return { id, startedAt: started, restartCount };
}

async function migrationCount(context: Context): Promise<number> {
  if (context.contextDir === null) return 0;
  try {
    return (await readdir(join(context.contextDir, MIGRATIONS_DIR), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}

const hasLine = (text: string, line: string) => text.split('\n').some((value) => value.trim() === line);

async function deploy(context: Context): Promise<void> {
  context.step = 'postgres';
  context.created.compose = true;
  const postgres = await composeStep(context, 'up postgres', ['up', '-d', '--wait', 'postgres'], TIMEOUTS.composeUp);
  if (!succeeded(postgres)) {
    printTail(context, 'up postgres', postgres);
    fail(context, 'compose_failed', 'postgres');
  }
  context.log('deployment: postgres sehat');

  context.step = 'provisioning';
  const credentials = context.provisioning;
  if (credentials === null) throw new Error('Provisioning credentials missing');
  // `-e <NAME>` without a value: Compose takes each value from the environment of this one command (AC-3).
  const provisioned = await composeStep(context, 'run provision', ['--profile', 'migrate', 'run', '--rm', '-T',
    '-e', 'FOUNDATION_ADMIN_DATABASE_URL', '-e', 'FOUNDATION_MIGRATOR_PASSWORD', '-e', 'FOUNDATION_BACKEND_PASSWORD',
    'migrate', 'database/provision.ts', '--apply'], TIMEOUTS.composeRun, {
    env: { ...context.dockerEnv, FOUNDATION_ADMIN_DATABASE_URL: credentials.adminUrl, FOUNDATION_MIGRATOR_PASSWORD: credentials.migratorPassword, FOUNDATION_BACKEND_PASSWORD: credentials.backendPassword },
  });
  if (!succeeded(provisioned)) {
    printTail(context, 'run provision', provisioned);
    checkFailed(context, 'provisioning_step', `database/provision.ts --apply keluar ${provisioned.code ?? 'tanpa kode'}`);
  }
  pass(context, 'provisioning_step', 'database/provision.ts --apply keluar 0 lewat image runner');

  context.step = 'backend';
  const backend = await composeStep(context, 'up backend', ['up', '-d', '--wait', 'backend'], TIMEOUTS.composeUp);
  if (!succeeded(backend)) {
    printTail(context, 'up backend', backend);
    fail(context, 'compose_failed', 'backend');
  }
  const before = await backendState(context);
  if (before === null) fail(context, 'compose_failed', 'backend state');

  context.step = 'readiness_before_migration';
  const unready = await backendHealth(context, '/health/ready');
  if (unready === null || unready.status !== 503 || unready.body !== '{"status":"unavailable"}' || unready.cacheControl !== 'no-store') {
    checkFailed(context, 'readiness_before_migration', `GET /health/ready menjawab ${unready === null ? 'tanpa jawaban' : `${unready.status} ${unready.body}`}`);
  }
  pass(context, 'readiness_before_migration', 'GET /health/ready 503 {"status":"unavailable"} sebelum migration');

  context.step = 'migration';
  const files = await migrationCount(context);
  context.created.containers.add(context.names.migrate);
  const fallback = await composeStep(context, 'run default command', ['--profile', 'migrate', 'run', '-T', '--name', context.names.migrate, 'migrate'], TIMEOUTS.composeRun);
  if (fallback.code !== 1 || fallback.timedOut || !hasLine(fallback.stdout + fallback.stderr, 'Use --apply')) {
    printTail(context, 'run default command', fallback);
    checkFailed(context, 'migration_step', `perintah bawaan runner keluar ${fallback.code ?? 'tanpa kode'}, bukan 1 dengan Use --apply`);
  }
  const migrate = () => composeStep(context, 'run migrate', ['--profile', 'migrate', 'run', '--rm', '-T', 'migrate', 'database/migrate.ts', '--apply'], TIMEOUTS.composeRun);
  const first = await migrate();
  if (!succeeded(first) || !hasLine(first.stdout, `Migrations: ${files} applied, 0 skipped`)) {
    printTail(context, 'run migrate', first);
    checkFailed(context, 'migration_step', `migration pertama keluar ${first.code ?? 'tanpa kode'}`);
  }
  const rerun = await migrate();
  if (!succeeded(rerun) || !hasLine(rerun.stdout, `Migrations: 0 applied, ${files} skipped`)) {
    printTail(context, 'run migrate', rerun);
    checkFailed(context, 'migration_step', `rerun migration tidak mencetak Migrations: 0 applied, ${files} skipped`);
  }
  const seeded = await composeStep(context, 'run seed', ['--profile', 'migrate', 'run', '--rm', '-T', 'migrate', 'database/seed.ts', '--apply'], TIMEOUTS.composeRun);
  if (!succeeded(seeded) || !seeded.stdout.split('\n').some((line) => /^Seeds: [0-9]+ executed$/.test(line.trim()))) {
    printTail(context, 'run seed', seeded);
    checkFailed(context, 'migration_step', `seed keluar ${seeded.code ?? 'tanpa kode'}`);
  }
  pass(context, 'migration_step', `perintah bawaan keluar 1 dengan Use --apply; migration ${files} applied; rerun 0 applied, ${files} skipped; seed keluar 0`);

  context.step = 'readiness_after_migration';
  let ready: HealthAnswer | null = null;
  for (const until = context.now() + TIMEOUTS.readinessWait; context.now() < until; await context.sleep(1_000)) {
    ready = await backendHealth(context, '/health/ready');
    if (ready?.status === 200) break;
  }
  if (ready === null || ready.status !== 200 || ready.body !== '{"status":"ready"}' || ready.cacheControl !== 'no-store') {
    checkFailed(context, 'readiness_after_migration', `GET /health/ready menjawab ${ready === null ? 'tanpa jawaban' : `${ready.status} ${ready.body}`} dalam ${TIMEOUTS.readinessWait} ms`);
  }
  const after = await backendState(context);
  if (after === null || after.id !== before.id || after.startedAt !== before.startedAt || after.restartCount !== 0) {
    checkFailed(context, 'readiness_after_migration', 'backend dimulai ulang di antara readiness 503 dan 200');
  }
  pass(context, 'readiness_after_migration', 'GET /health/ready 200 {"status":"ready"} sesudah migration tanpa restart backend');

  context.step = 'edge';
  const edge = await composeStep(context, 'up edge', ['up', '-d', '--wait', 'edge'], TIMEOUTS.composeUp);
  if (!succeeded(edge)) {
    printTail(context, 'up edge', edge);
    fail(context, 'compose_failed', 'edge');
  }
  const edgeFetch = context.deps.edgeFetch ?? defaultEdgeFetch;
  let root: number | null = null;
  for (const until = context.now() + TIMEOUTS.edgeRootWait; context.now() < until; await context.sleep(500)) {
    stopIfAborted(context);
    root = await edgeFetch(`https://localhost:${context.httpsPort}/`, context.caPem ?? '', context.stop);
    if (root === 200) break;
  }
  if (root !== 200) fail(context, 'compose_failed', `edge GET / ${root ?? 'tanpa jawaban'}`);
  context.log(`deployment: edge menjawab GET / 200 lewat https://localhost:${context.httpsPort}/`);

  // Step 6 in the order of *Urutan orkestrasi*: the declaration without the override, the HTTP and TLS checks, the
  // upstream stub (start, check, remove), the inspect and network checks, the reachability probes with the public
  // control, the browser flow, shutdown, restart, recreate, and outage, the log checks, and the whole topology stopped.
  await composeDeclaration(context);
  await edgeChecks(context);
  await stubChecks(context);
  await inspectChecks(context);
  await reachability(context);
  await browserFlow(context);
  const port = context.httpsPort;
  if (port === null) throw new Error('Edge port missing');
  await backendShutdownRestart(context, port);
  await backendRecreate(context, port);
  await databaseOutage(context, port);
  await edgeShutdown(context, port);
  await logChecks(context, port);
  await topologyShutdown(context);
}

// --- Step 6: the edge checks (AC-5, AC-6, AC-7), the upstream stub, and the browser flow (DEP-006).

/**
 * A check of step 6: passed when `problems` is empty, otherwise failed with reason check_failed. Unlike the
 * deployment steps, a failed edge check does not stop the run: the later checks do not depend on it, and one run then
 * shows every failure.
 */
function judge(context: Context, name: DeploymentCheckName, problems: readonly string[], passed: string): void {
  if (problems.length === 0) {
    pass(context, name, passed);
    return;
  }
  const detail = problems.join('; ');
  context.checks.set(name, { name, status: 'failed', detail });
  context.reasons.push({ code: 'check_failed', detail: name });
  context.error(`deployment: check ${name} failed: ${clip(context.redact(detail))}`);
}

type Ask = { method?: string; headers?: Readonly<Record<string, string>>; body?: string; timeoutMs?: number };

async function edgeRequest(context: Context, request: EdgeHttpRequest): Promise<EdgeAnswer | null> {
  stopIfAborted(context);
  const answer = await (context.deps.edgeHttp ?? defaultEdgeHttp)(request, context.stop);
  stopIfAborted(context);
  return answer;
}

/** One HTTPS request through Bun `fetch`, trusting only the run CA. */
const https = (context: Context, port: number, target: string, ask: Ask = {}) =>
  edgeRequest(context, { url: `https://localhost:${port}${target}`, method: ask.method ?? 'GET', headers: ask.headers ?? {}, body: ask.body ?? null, ca: context.caPem, timeoutMs: ask.timeoutMs ?? TIMEOUTS.exec });

/** One plain HTTP request to the redirect listener. */
const plain = (context: Context, port: number, target: string, ask: Ask = {}) =>
  edgeRequest(context, { url: `http://localhost:${port}${target}`, method: ask.method ?? 'GET', headers: ask.headers ?? {}, body: ask.body ?? null, ca: null, timeoutMs: ask.timeoutMs ?? TIMEOUTS.exec });

/** One raw HTTP/1.1 GET with `target` on the request line as is, over TLS verified with the run CA. */
async function raw(context: Context, port: number, target: string, headers: HeaderList = []): Promise<EdgeAnswer | null> {
  stopIfAborted(context);
  const answer = await (context.deps.edgeRaw ?? defaultEdgeRaw)({ port, ca: context.caPem ?? '', target, headers, timeoutMs: TIMEOUTS.exec }, context.stop);
  stopIfAborted(context);
  return answer;
}

const header = (answer: EdgeAnswer, name: string): string | undefined => headerValues(answer.headers, name)[0];
const requestIdOf = (answer: EdgeAnswer | null): string | undefined => (answer === null ? undefined : header(answer, 'x-request-id'));
const shown = (answer: EdgeAnswer | null) => (answer === null ? 'tanpa jawaban' : String(answer.status));

/** The container id of a project service, after `docker inspect` confirms the label `foundation.run=<hex>`. */
async function serviceContainer(context: Context, service: string): Promise<string | null> {
  const listed = await composeStep(context, `ps ${service}`, ['ps', '-a', '-q', service], TIMEOUTS.query);
  const id = listed.stdout.trim();
  if (!succeeded(listed) || !/^[0-9a-f]{12,64}$/.test(id)) return null;
  const inspected = await call(context, `inspect ${service}`, ['inspect', '--format', '{{json .Config.Labels}}', id], TIMEOUTS.query);
  const labels = succeeded(inspected) ? parseJson(inspected.stdout.trim()) : undefined;
  return isRecord(labels) && labels['foundation.run'] === context.names.hex ? id : null;
}

/** stdout and stderr of one service container read apart through `docker logs`, never `compose logs`. */
async function serviceLogs(context: Context, service: string): Promise<{ stdout: string; stderr: string } | null> {
  const id = await serviceContainer(context, service);
  if (id === null) return null;
  const logs = await call(context, `logs ${service}`, ['logs', id], TIMEOUTS.logs);
  return succeeded(logs) ? { stdout: logs.stdout, stderr: logs.stderr } : null;
}

async function tlsProblems(context: Context, port: number): Promise<string[]> {
  const caFile = context.caFile;
  if (caFile === null) return ['CA run tidak ada'];
  const problems: string[] = [];
  const client = (label: string, ...rest: string[]) => execute(context, `openssl ${label}`, tlsArgs(port, caFile, ...rest), TIMEOUTS.tls);
  const lines = (result: ProcessGroupResult) => `${result.stdout}\n${result.stderr}`.split('\n').map((line) => line.trim());
  const verified = (result: ProcessGroupResult) => lines(result).includes('Verify return code: 0 (ok)');

  const alpn = await client('alpn', '-alpn', 'h2');
  if (!succeeded(alpn) || !verified(alpn) || !lines(alpn).includes('ALPN protocol: h2')) problems.push('ALPN protocol: h2 tidak tercetak');

  const tls12 = await client('tls1_2', '-tls1_2');
  const cipher = lines(tls12).map((line) => /^New, TLSv1\.2, Cipher is (\S+)$/.exec(line)?.[1]).find((value) => value !== undefined);
  if (!succeeded(tls12) || !verified(tls12) || cipher === undefined || !TLS12_CIPHERS.includes(cipher)) problems.push('handshake TLS 1.2 gagal atau cipher di luar daftar');
  if (lines(tls12).some((line) => line.includes('TLS session ticket'))) problems.push('TLS 1.2 mencetak TLS session ticket');

  // The positive control is the TLS 1.1 command line with -tls1_2; without it a refusal could come from the client.
  const control = await client('tls1_2 control', '-tls1_2', '-cipher', 'DEFAULT@SECLEVEL=0');
  if (!succeeded(control) || !verified(control)) problems.push('kontrol positif TLS 1.2 gagal');
  else {
    const tls11 = await client('tls1_1', '-tls1_1', '-cipher', 'DEFAULT@SECLEVEL=0');
    const text = `${tls11.stdout}\n${tls11.stderr}`;
    if (succeeded(tls11) || !text.includes('alert protocol version') || text.includes('no protocols available')) problems.push('TLS 1.1 tidak ditolak server dengan alert protocol version');
  }
  return problems;
}

async function edgeChecks(context: Context): Promise<void> {
  const httpsPort = context.httpsPort;
  const httpPort = context.httpPort;
  if (httpsPort === null || httpPort === null) throw new Error('Edge ports missing');

  context.step = 'tls_versions';
  judge(context, 'tls_versions', await tlsProblems(context, httpsPort), 'ALPN h2; TLS 1.2 dengan cipher daftar tanpa session ticket; kontrol TLS 1.2 lulus dan TLS 1.1 ditolak alert protocol version');

  // HTTP listener: every method and path gets 308 to https://localhost<path and query>, without HSTS.
  context.step = 'http_redirect';
  const redirectProblems: string[] = [];
  const redirectRequests: [string, string][] = [
    ...['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((method): [string, string] => [method, '/api/status?returnUrl=%2Fhome']),
    ...['/', '/kesiapan', '/health/live', '/api/x.json', '/main-AAAAAAAA.js?v=1'].map((target): [string, string] => ['GET', target]),
  ];
  for (const [method, target] of redirectRequests) {
    const answer = await plain(context, httpPort, target, { method, ...(method === 'POST' || method === 'PUT' || method === 'PATCH' ? { body: 'x' } : {}) });
    if (answer === null || answer.status !== 308 || header(answer, 'location') !== `https://localhost${target}`) redirectProblems.push(`${method} ${target} ${shown(answer)}`);
    else if (headerValues(answer.headers, 'strict-transport-security').length > 0 || corsHeaders(answer.headers).length > 0) redirectProblems.push(`${method} ${target} membawa HSTS atau CORS`);
    // Decision 67: the redirect reflects the client Host, so no cache may store it.
    else if (header(answer, 'cache-control') !== 'no-store') redirectProblems.push(`${method} ${target} tanpa Cache-Control no-store`);
  }

  // Document headers, cache, and fallback (tables *Header dokumen* and *Cache dan fallback*).
  context.step = 'document_headers';
  const documents: [string, EdgeAnswer | null][] = [];
  const fetchDocument = async (target: string, ask: Ask = {}) => {
    const answer = await https(context, httpsPort, target, ask);
    documents.push([`${ask.method ?? 'GET'} ${target}`, answer]);
    return answer;
  };
  const cacheProblems: string[] = [];
  const index = await fetchDocument('/index.html');
  const indexBody = index?.status === 200 ? index.body : null;
  if (indexBody === null) cacheProblems.push(`/index.html ${shown(index)}`);
  else if (!indexWithoutInline(indexBody)) cacheProblems.push('index.html memuat script tanpa src atau style');
  if (index !== null && header(index, 'cache-control') !== 'no-cache') cacheProblems.push('/index.html tanpa no-cache');
  for (const target of ['/', '/kesiapan', '/health/live', '/api', '/a.b/c']) {
    const answer = await fetchDocument(target);
    if (answer === null || answer.status !== 200 || indexBody === null || answer.body !== indexBody) cacheProblems.push(`${target} bukan index.html 200 (${shown(answer)})`);
    else if (header(answer, 'cache-control') !== 'no-cache' || !(header(answer, 'content-type') ?? '').startsWith('text/html')) cacheProblems.push(`${target} tanpa no-cache atau text/html`);
  }
  const assets = indexBody === null ? [] : hashedAssets(indexBody);
  if (!assets.some((path) => /^\/main-/.test(path)) || !assets.some((path) => /^\/styles-.*\.css$/.test(path))) cacheProblems.push('index.html tanpa main-*.js atau styles-*.css');
  for (const path of assets) {
    const answer = await fetchDocument(path);
    const type = answer === null ? '' : (header(answer, 'content-type') ?? '');
    const typed = path.endsWith('.css') ? type.startsWith('text/css') : /^(application|text)\/javascript\b/.test(type);
    if (answer === null || answer.status !== 200 || header(answer, 'cache-control') !== IMMUTABLE_CACHE || !typed) cacheProblems.push(`${path} ${shown(answer)} ${type}`);
  }
  // Decision 68: the 304 that revalidates an existing hashed asset keeps the immutable Cache-Control, while the 404 of a
  // hashed name that does not exist is no-cache, so a 404 asked during a version change is never stored for a year.
  const revalidatedAsset = assets[0];
  if (revalidatedAsset !== undefined) {
    const fresh = await fetchDocument(revalidatedAsset);
    const etag = fresh === null ? undefined : header(fresh, 'etag');
    const revalidated = etag === undefined ? null : await fetchDocument(revalidatedAsset, { headers: { 'If-None-Match': etag } });
    if (revalidated === null || revalidated.status !== 304 || header(revalidated, 'cache-control') !== IMMUTABLE_CACHE) {
      cacheProblems.push(`${revalidatedAsset} If-None-Match ${shown(revalidated)}, diharapkan 304 ${IMMUTABLE_CACHE}`);
    }
  }
  let missingHashed = '/main-ZZZZZZZZ.js';
  if (assets.includes(missingHashed)) missingHashed = '/chunk-ZZZZZZZZ.js';
  const expectations: [string, number, string][] = [
    [missingHashed, 404, 'no-cache'],
    ['/missing-file.png', 404, 'no-cache'],
    ['/favicon.ico', 200, 'no-cache'],
  ];
  for (const [target, status, cache] of expectations) {
    const answer = await fetchDocument(target);
    if (answer === null || answer.status !== status || header(answer, 'cache-control') !== cache) cacheProblems.push(`${target} ${shown(answer)}, diharapkan ${status} ${cache}`);
  }
  const head = await fetchDocument('/', { method: 'HEAD' });
  if (head === null || head.status !== 200) cacheProblems.push(`HEAD / ${shown(head)}`);
  const post = await fetchDocument('/', { method: 'POST', body: 'x' });
  if (post === null || post.status !== 405) cacheProblems.push(`POST / ${shown(post)}, diharapkan 405`);

  // /api/: backend answers through the edge, CORS, edge errors, and the health routes.
  context.step = 'api_forwarding';
  const apiAnswers: [string, EdgeAnswer | null][] = [];
  const api = async (label: string, request: Promise<EdgeAnswer | null>) => {
    const answer = await request;
    apiAnswers.push([label, answer]);
    return answer;
  };
  const notFound = '{"error":"Not found"}';
  const forwardedTargets = ['/api/x.json', '/api/status?returnUrl=%2Fhome', '/api/status?next=..%2F..%5Cx'];
  const forwarded: [string, EdgeAnswer | null][] = [];
  for (const target of forwardedTargets) forwarded.push([target, await api(`GET ${target}`, https(context, httpsPort, target))]);

  context.step = 'cors_absent';
  const foreign = 'https://foreign.example';
  const preflight = { Origin: foreign, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' };
  const corsAnswers: [string, EdgeAnswer | null][] = [
    ['GET / dengan Origin', await fetchDocument('/', { headers: { Origin: foreign } })],
    ['OPTIONS / preflight', await fetchDocument('/', { method: 'OPTIONS', headers: preflight })],
    ['GET /api/status dengan Origin', await api('GET /api/status dengan Origin', https(context, httpsPort, '/api/status', { headers: { Origin: foreign } }))],
    ['OPTIONS /api/status preflight', await api('OPTIONS /api/status preflight', https(context, httpsPort, '/api/status', { method: 'OPTIONS', headers: preflight }))],
    ['POST /api/x.json dengan Origin', await api('POST /api/x.json dengan Origin', https(context, httpsPort, '/api/x.json', { method: 'POST', headers: { Origin: foreign, 'Content-Type': 'application/json' }, body: '{}' }))],
  ];

  context.step = 'edge_errors';
  const rejected: [string, EdgeAnswer | null][] = [];
  for (const target of TRAVERSAL_TARGETS) rejected.push([target, await api(`GET ${target}`, raw(context, httpsPort, target))]);
  const tooLarge = await api('POST 1025 byte', https(context, httpsPort, '/api/status', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'a'.repeat(BODY_LIMIT_BYTES + 1) }));
  // Errors nginx makes before a location is chosen: document headers and the default body without a version, for a
  // request header above large_client_header_buffers and for a raw path above the root.
  const largeHeader = await raw(context, httpsPort, '/api/status', [['X-Foundation-Large', 'h'.repeat(9_000)]]);
  if (largeHeader !== null) documents.push(['GET /api/status dengan header 9000 byte', largeHeader]);
  const aboveRoot: [string, EdgeAnswer | null][] = [];
  for (const target of ABOVE_ROOT_TARGETS) {
    const answer = await raw(context, httpsPort, target);
    aboveRoot.push([target, answer]);
    if (answer !== null) documents.push([`GET ${target}`, answer]);
  }

  // Raw request lines, so the dot segments and %2e reach the edge as sent. The targets normalized outside /api/ are
  // documents; the /api/health targets are /api/ answers.
  context.step = 'health_not_public';
  const healthDocuments: [string, EdgeAnswer | null][] = [];
  for (const target of HEALTH_DOCUMENT_TARGETS) {
    const answer = await raw(context, httpsPort, target);
    healthDocuments.push([target, answer]);
    if (answer !== null) documents.push([`GET ${target}`, answer]);
  }
  const healthApi: [string, EdgeAnswer | null][] = [];
  for (const target of HEALTH_API_TARGETS) healthApi.push([target, await api(`GET ${target}`, raw(context, httpsPort, target))]);

  // One read of the edge access log proves which answers the edge made without the backend.
  context.step = 'edge_log';
  const logs = await serviceLogs(context, 'edge');
  const lines = new Map<string, EdgeLogLine>();
  const redirects: EdgeLogLine[] = [];
  for (const text of (logs?.stdout ?? '').split('\n')) {
    const line = parseEdgeLogLine(text.trim());
    if (line === null) continue;
    lines.set(line.requestId, line);
    if (line.status === 308) redirects.push(line);
  }
  const lineOf = (answer: EdgeAnswer | null): EdgeLogLine | null => {
    const id = requestIdOf(answer);
    return id === undefined ? null : (lines.get(id) ?? null);
  };
  const upstreamOf = (answer: EdgeAnswer | null): string | null => lineOf(answer)?.upstreamStatus ?? null;
  const logMissing = logs === null ? ['log edge tidak terbaca'] : [];

  if (redirects.length < redirectRequests.length) redirectProblems.push(`${redirects.length} baris log 308, diharapkan paling sedikit ${redirectRequests.length}`);
  if (redirects.some((line) => line.upstreamStatus !== '')) redirectProblems.push('jawaban 308 diteruskan ke upstream');
  judge(context, 'http_redirect', [...logMissing, ...redirectProblems], `${redirectRequests.length} request ke port HTTP dijawab 308 ke https://localhost<path dan query> dengan Cache-Control no-store, tanpa HSTS dan tanpa upstream`);

  const documentProblems = documents.flatMap(([label, answer]) => (answer === null ? [`${label} tanpa jawaban`] : documentHeaderProblems(answer.headers).map((problem) => `${label}: ${problem}`)));
  if (largeHeader === null) documentProblems.push('header 9000 byte tanpa jawaban');
  judge(context, 'document_headers', documentProblems, `${documents.length} jawaban di luar /api/ memuat Header dokumen tepat, termasuk CSP final dan HSTS`);
  judge(context, 'static_cache_fallback', cacheProblems, `aset ber hash immutable termasuk 304, 404 aset ber hash dan file berekstensi lain no-cache, path tanpa ekstensi index.html 200; ${assets.length} aset dari index.html`);

  // The backend request log of the same answers (AC-7 *baris log backend*): one line with the edge ID and the path
  // without its query.
  const backendLogs = await serviceLogs(context, 'backend');
  const backendRequests = backendLines(backendLogs?.stdout ?? '').filter((line): line is Extract<BackendLogLine, { event: 'request' }> => line !== null && line.event === 'request');
  const forwardProblems = [...logMissing];
  if (backendLogs === null) forwardProblems.push('log backend tidak terbaca');
  for (const [target, answer] of forwarded) {
    if (answer === null || answer.status !== 404 || answer.body !== notFound || !(header(answer, 'content-type') ?? '').startsWith('application/json')) forwardProblems.push(`${target} ${shown(answer)} bukan 404 JSON backend`);
    else {
      if (logs !== null && upstreamOf(answer) !== '404') forwardProblems.push(`${target} tidak sampai ke backend menurut log edge`);
      const id = requestIdOf(answer);
      const path = target.split('?')[0];
      if (backendLogs !== null && !backendRequests.some((line) => line.requestId === id && line.path === path && line.status === 404)) forwardProblems.push(`${target} tanpa baris log backend dengan ID edge`);
    }
  }
  judge(context, 'api_forwarding', forwardProblems, '/api/x.json dan /api/status dengan query sampai ke backend (404 JSON backend, upstreamStatus 404 di log edge, baris log backend dengan ID edge)');

  const apiProblems: string[] = [];
  for (const [label, answer] of apiAnswers) {
    if (answer === null) continue;
    for (const problem of apiHeaderProblems(answer.headers)) apiProblems.push(`${label}: ${problem}`);
    const edgeMade = (answer.status === 400 || answer.status === 413 || answer.status === 502 || answer.status === 504) && answer.body === EDGE_ERROR_BODIES[answer.status];
    if (edgeMade && (header(answer, 'content-type') !== 'application/json' || header(answer, 'cache-control') !== 'no-store')) apiProblems.push(`${label}: jawaban edge tanpa application/json atau no-store`);
  }
  judge(context, 'api_headers', apiProblems, `${apiAnswers.filter(([, answer]) => answer !== null).length} jawaban /api/ memuat Header API tepat; jawaban edge application/json dan no-store`);

  const corsProblems = corsAnswers.flatMap(([label, answer]) => (answer === null ? [`${label} tanpa jawaban`] : corsHeaders(answer.headers).map((name) => `${label}: ${name}`)));
  judge(context, 'cors_absent', corsProblems, 'tidak ada header Access-Control-* untuk Origin asing dan preflight, di dokumen maupun /api/');

  const errorProblems = [...logMissing];
  const edgeError = (label: string, answer: EdgeAnswer | null, status: 400 | 413) => {
    if (answer === null || answer.status !== status || answer.body !== EDGE_ERROR_BODIES[status] || header(answer, 'content-type') !== 'application/json' || header(answer, 'cache-control') !== 'no-store') {
      errorProblems.push(`${label} ${shown(answer)} bukan ${status} JSON edge`);
    } else if (logs !== null) {
      const upstream = upstreamOf(answer);
      if (upstream === null) errorProblems.push(`${label} tidak ada di log edge`);
      else if (upstream !== '') errorProblems.push(`${label} diteruskan ke upstream`);
    }
  };
  for (const [target, answer] of rejected) edgeError(target, answer, 400);
  edgeError('POST 1025 byte', tooLarge, 413);
  // The large header answer may come before nginx reads a request line, so only its answer is judged; the path above
  // the root is a whole request, and its edge log line must have status 400 with an empty path and no upstream (AC-10,
  // decision 66). The detail stays within TEXT_LIMIT, so result.json keeps its last part.
  errorProblems.push(...nginxDefault400Problems('header 9000 byte', largeHeader));
  for (const [target, answer] of aboveRoot) errorProblems.push(...nginxDefault400Problems(target, answer, logs === null || answer === null ? undefined : lineOf(answer)));
  const aboveRootTargets = ABOVE_ROOT_TARGETS.join(', ');
  judge(context, 'edge_errors', errorProblems, `${rejected.length} bentuk traversal 400 dan body 1025 byte 413 JSON; header 9000 byte dan ${aboveRootTargets} 400 bawaan nginx dengan Header dokumen; baris log edge ${aboveRootTargets} 400 dengan path dan upstreamStatus kosong`);

  const logged = (pairs: readonly [string, EdgeAnswer | null][]): LoggedAnswer[] => pairs.map(([target, answer]) => ({ target, answer, upstream: upstreamOf(answer) }));
  const healthProblems = [...logMissing, ...healthNotPublicProblems(logged(healthDocuments), logged(healthApi), indexBody)];
  judge(context, 'health_not_public', healthProblems, `${healthDocuments.length} target di luar /api/ index.html 200 dengan Header dokumen tanpa upstream; ${healthApi.length} target /api/health 404 JSON backend dengan Header API`);
}

function stubCount(answer: EdgeAnswer | null): number | null {
  if (answer === null || answer.status !== 200) return null;
  const value = parseJson(answer.body);
  return isRecord(value) && Number.isInteger(value['count']) ? (value['count'] as number) : null;
}

/** *Upstream stub*: the stub on network app and a second edge from the same image whose upstream is the stub. */
async function stubProblems(context: Context): Promise<string[]> {
  const { names } = context;
  context.created.containers.add(names.stub);
  const stub = await call(context, 'run stub', ['run', '-d', '--name', names.stub, '--network', `${names.project}_app`, '--network-alias', `stub-${names.hex}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '64m', '--pids-limit', '64',
    '--label', 'foundation.test=deployment', '--label', `foundation.run=${names.hex}`,
    '--entrypoint', 'bun', names.tags.migrate, '--no-env-file', '-e', stubScript()], TIMEOUTS.stubStart);
  if (!succeeded(stub)) {
    printTail(context, 'run stub', stub);
    return ['stub tidak dapat dijalankan'];
  }
  const port = await (context.deps.freePort ?? defaultFreePort)();
  context.created.containers.add(names.edgeStub);
  const edgeStub = await composeStep(context, 'run edge stub', ['run', '-d', '--no-deps', '--name', names.edgeStub,
    '-e', `FOUNDATION_BACKEND_UPSTREAM=stub-${names.hex}:9000`, '-p', `127.0.0.1:${port}:8443`, 'edge'], TIMEOUTS.stubStart);
  if (!succeeded(edgeStub)) {
    printTail(context, 'run edge stub', edgeStub);
    return ['edge stub tidak dapat dijalankan'];
  }
  let before: number | null = null;
  for (const until = context.now() + TIMEOUTS.edgeRootWait; context.now() < until; await context.sleep(500)) {
    before = stubCount(await https(context, port, '/api/stub/count'));
    if (before !== null) break;
  }
  if (before === null) return [`stub tidak menjawab lewat edge stub dalam ${TIMEOUTS.edgeRootWait} ms`];

  const problems: string[] = [];
  // Client address headers with sentinel values and a client correlation ID that the edge must replace.
  const clientId = randomBytes(16).toString('hex');
  const sentinels = Object.fromEntries(CLIENT_ADDRESS_HEADERS.map((name) => [name, secret(context, 16)]));
  const target = '/api/stub/echo?returnUrl=%2Fhome';
  const echo = await https(context, port, target, { headers: { 'X-Request-Id': clientId, ...sentinels } });
  const echoed = echo?.status === 200 ? parseJson(echo.body) : undefined;
  const received = isRecord(echoed) && isRecord(echoed['headers']) ? echoed['headers'] : null;
  if (echo === null || received === null || !isRecord(echoed)) problems.push(`echo ${shown(echo)}`);
  else {
    const responseId = header(echo, 'x-request-id');
    if (received['host'] !== 'localhost') problems.push('stub tidak menerima host localhost');
    const leaked = CLIENT_ADDRESS_HEADERS.filter((name) => received[name.toLowerCase()] !== null);
    if (leaked.length > 0) problems.push(`stub menerima ${leaked.join(', ')}`);
    if (typeof received['x-request-id'] !== 'string' || received['x-request-id'] !== responseId || responseId === clientId || !REQUEST_ID.test(responseId)) {
      problems.push('x-request-id stub tidak sama dengan header jawaban atau sama dengan milik client');
    }
    if (echoed['method'] !== 'GET' || echoed['path'] !== target) problems.push('method atau path yang diterima stub berbeda');
    problems.push(...apiHeaderProblems(echo.headers).map((problem) => `echo: ${problem}`));
  }

  // The body limit: 1025 bytes stop at the edge, 1024 bytes reach the stub.
  const counted = async () => stubCount(await https(context, port, '/api/stub/count'));
  const start = await counted();
  const tooLarge = await https(context, port, '/api/stub/echo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'a'.repeat(BODY_LIMIT_BYTES + 1) });
  if (tooLarge === null || tooLarge.status !== 413 || tooLarge.body !== EDGE_ERROR_BODIES[413] || header(tooLarge, 'content-type') !== 'application/json' || header(tooLarge, 'cache-control') !== 'no-store') {
    problems.push(`body 1025 byte ${shown(tooLarge)} bukan 413 JSON edge`);
  } else problems.push(...apiHeaderProblems(tooLarge.headers).map((problem) => `413: ${problem}`));
  const afterTooLarge = await counted();
  if (start === null || afterTooLarge !== start) problems.push('body 1025 byte sampai ke stub');
  const atLimit = await https(context, port, '/api/stub/echo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'a'.repeat(BODY_LIMIT_BYTES) });
  const atLimitBody = atLimit?.status === 200 ? parseJson(atLimit.body) : undefined;
  if (!isRecord(atLimitBody) || atLimitBody['bodyBytes'] !== BODY_LIMIT_BYTES) problems.push(`body 1024 byte ${shown(atLimit)} tidak sampai utuh ke stub`);
  const afterAtLimit = await counted();
  if (start === null || afterAtLimit !== start + 1) problems.push('hitungan stub tidak bertambah satu untuk body 1024 byte');

  // A real 504: the stub accepts the connection and never answers.
  const hang = await https(context, port, '/api/stub/hang', { timeoutMs: TIMEOUTS.stubHang });
  if (hang === null || hang.status !== 504 || hang.body !== EDGE_ERROR_BODIES[504] || header(hang, 'content-type') !== 'application/json' || header(hang, 'cache-control') !== 'no-store') {
    problems.push(`/api/stub/hang ${shown(hang)} bukan 504 JSON edge`);
  } else {
    if (hang.elapsedMs < 9_500 || hang.elapsedMs > 13_000) problems.push(`504 sesudah ${Math.round(hang.elapsedMs)} ms, di luar 9500 sampai 13000 ms`);
    problems.push(...apiHeaderProblems(hang.headers).map((problem) => `504: ${problem}`));
  }
  return problems;
}

async function stubChecks(context: Context): Promise<void> {
  context.step = 'api_stub_forwarding';
  const problems: string[] = [];
  try {
    problems.push(...(await stubProblems(context)));
  } catch (caught) {
    // On a signal or the total deadline, cleanup removes the stub containers before `compose down`.
    if (caught instanceof Stop) throw caught;
    problems.push('langkah stub gagal tanpa diduga');
  }
  // Removed by explicit name right after the check (*Upstream stub*); a name that remains goes to cleanup.
  const stubs = [context.names.stub, context.names.edgeStub].filter((name) => context.created.containers.has(name));
  if (stubs.length > 0) {
    const removed = await call(context, 'rm stub', ['rm', '-f', ...stubs], TIMEOUTS.removeContainers, { abortable: false });
    if (succeeded(removed)) for (const name of stubs) context.created.containers.delete(name);
    else problems.push('stub tidak terhapus');
  }
  judge(context, 'api_stub_forwarding', problems, 'stub menerima host localhost tanpa header alamat client dengan x-request-id edge; 504 JSON; 1025 byte 413 tanpa sampai stub, 1024 byte sampai');
}

/** DEP-006 through playwright.deployment.config.ts against the edge of this run. */
async function browserFlow(context: Context): Promise<void> {
  context.step = 'browser_flow';
  const { root } = context.deps;
  const junit = join(root, EVIDENCE_ROOT, 'playwright-deployment.xml');
  context.log('deployment: menjalankan alur browser DEP-006 lewat edge');
  const result = await execute(context, 'playwright', ['node', join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.deployment.config.ts'], TIMEOUTS.playwright, {
    env: { ...context.dockerEnv, FOUNDATION_DEPLOY_EDGE_URL: `https://localhost:${context.httpsPort}` },
  });
  const junitExists = await Bun.file(junit).exists();
  // AC-6: the requested origins must be durable evidence in the JUnit, not only an attachment the reporter drops.
  const evidence = junitExists ? requestedOriginsProblems(await Bun.file(junit).text()) : [];
  if (succeeded(result) && junitExists && evidence.length === 0) {
    pass(context, 'browser_flow', 'DEP-006 lulus pada 1280×812 dan 375×812 tanpa pelanggaran CSP, error console, atau request /api/; origin yang diminta tercatat di JUnit');
    return;
  }
  const output = context.redact(`${result.stdout}${result.stderr}`).trimEnd();
  if (output !== '') context.error(`--- playwright (credential disamarkan) ---\n${output}`);
  const detail = result.timedOut ? `Playwright melewati ${TIMEOUTS.playwright} ms`
    : !junitExists ? 'JUnit Playwright tidak ada'
    : !succeeded(result) ? `Playwright keluar ${result.code ?? 'tanpa kode'}`
    : `bukti origin DEP-006: ${evidence[0]}`;
  context.checks.set('browser_flow', { name: 'browser_flow', status: 'failed', detail });
  context.reasons.push({ code: 'browser_failed', detail });
  context.error(`deployment: check browser_flow failed: ${detail}`);
}

// --- Step 6, continued: the declaration, inspect, reachability, operation, and log checks (AC-4, AC-8, AC-9, AC-10).

/**
 * compose_declaration (AC-8, AC-10): `compose -f deploy/compose.yaml config --no-interpolate --format json` without the
 * override and without the env file, so the output holds variables, never a credential value, and equals *Topologi*.
 */
async function composeDeclaration(context: Context): Promise<void> {
  context.step = 'compose_declaration';
  const result = await call(context, 'compose config', ['compose', '-f', COMPOSE_FILE, 'config', '--no-interpolate', '--format', 'json'], TIMEOUTS.query);
  const problems: string[] = [];
  if (!succeeded(result)) problems.push('compose config gagal');
  else {
    if (containsSecret(`${result.stdout}${result.stderr}`, context.secrets)) problems.push('keluaran compose config memuat nilai credential');
    problems.push(...declarationProblems(parseJson(result.stdout)));
  }
  judge(context, 'compose_declaration', problems, 'compose config --no-interpolate tanpa override sama dengan tabel Topologi dan Environment per service, json-file 10m × 3, flag log PostgreSQL, tanpa nilai credential');
}

/** Full `docker inspect` of one container, only when its label `foundation.run` is this run. */
async function inspectContainer(context: Context, label: string, id: string): Promise<Record<string, unknown> | null> {
  const result = await call(context, `inspect ${label}`, ['inspect', id], TIMEOUTS.query);
  const list = succeeded(result) ? parseJson(result.stdout) : undefined;
  const object = Array.isArray(list) ? list[0] : undefined;
  if (!isRecord(object)) return null;
  return recordOf(recordOf(object['Config'])['Labels'])['foundation.run'] === context.names.hex ? object : null;
}

async function serviceInspect(context: Context, service: string): Promise<Record<string, unknown> | null> {
  const id = await serviceContainer(context, service);
  return id === null ? null : inspectContainer(context, service, id);
}

/** `Config.Env` of an image by id. */
async function imageEnvironment(context: Context, image: unknown): Promise<unknown> {
  if (typeof image !== 'string') return undefined;
  const result = await call(context, 'image env', ['image', 'inspect', '--format', '{{json .Config.Env}}', image], TIMEOUTS.query);
  return succeeded(result) ? parseJson(result.stdout.trim()) : undefined;
}

/**
 * container_hardening, container_environment, and published_ports (AC-8): `docker inspect` of edge, backend, and
 * postgres of the project and of the stopped runner container `foundation-deploy-migrate-<hex>`; the environment each
 * container has beyond its image; and the published ports, the empty `compose port` of backend and PostgreSQL, and
 * the edge reached from host loopback.
 */
async function inspectChecks(context: Context): Promise<void> {
  context.step = 'container_hardening';
  const inspected = new Map<ServiceName, Record<string, unknown> | null>();
  for (const service of ['edge', 'backend', 'postgres'] as const) inspected.set(service, await serviceInspect(context, service));
  inspected.set('migrate', await inspectContainer(context, 'migrate', context.names.migrate));
  const imageHealthcheck = recordOf(recordOf(context.imageInspect.get('backend'))['Config'])['Healthcheck'];
  const hardening: string[] = [];
  for (const service of SERVICE_NAMES) {
    const object = inspected.get(service);
    if (object === null || object === undefined) hardening.push(`${service}: inspect gagal atau label run tidak cocok`);
    else hardening.push(...hardeningProblems(service, object, context.names.project, imageHealthcheck));
  }
  judge(context, 'container_hardening', hardening, 'edge, backend, postgres, dan runner: network, user numerik, CPU, memory, PIDs, read only, tmpfs, CapDrop ALL, no-new-privileges, restart no, stop timeout, healthcheck, dan json-file sesuai tabel');

  context.step = 'container_environment';
  const credentials = context.credentials;
  if (credentials === null) throw new Error('Run credentials missing');
  const values: Readonly<Record<string, string>> = {
    DATABASE_URL: credentials.backendUrl,
    POSTGRES_DB: 'foundation',
    POSTGRES_USER: 'foundation_admin',
    POSTGRES_PASSWORD: credentials.adminPassword,
    FOUNDATION_MIGRATOR_DATABASE_URL: credentials.migratorUrl,
  };
  const environment: string[] = [];
  for (const service of SERVICE_NAMES) {
    const object = inspected.get(service);
    if (object === null || object === undefined) {
      environment.push(`${service}: inspect gagal`);
      continue;
    }
    const added = addedEnvironment(recordOf(object['Config'])['Env'], await imageEnvironment(context, object['Image']));
    const keys = [...added.keys()].sort(codeUnit);
    if (!sameList(keys, SERVICE_ENVIRONMENT[service])) environment.push(`${service}: key environment tambahan ${keys.length === 0 ? 'tidak ada' : keys.join(', ')}`);
    for (const [key, value] of added) if (values[key] !== undefined && value !== values[key]) environment.push(`${service}: nilai ${key} bukan milik service ini`);
  }
  judge(context, 'container_environment', environment, 'environment tambahan tepat tabel: edge tanpa key, backend DATABASE_URL foundation_backend, postgres POSTGRES_*, runner FOUNDATION_MIGRATOR_DATABASE_URL saja');

  context.step = 'published_ports';
  const ports: string[] = [];
  const portOf = async (service: string, port: number) => {
    const result = await composeStep(context, `port ${service} ${port}`, ['port', service, String(port)], TIMEOUTS.query);
    return { code: result.code, stdout: result.stdout.trim(), stderr: result.stderr };
  };
  for (const [port, host] of [[8443, context.httpsPort], [8080, context.httpPort]] as const) {
    const published = await portOf('edge', port);
    if (published.code !== 0 || published.stdout !== `127.0.0.1:${host}`) ports.push(`edge ${port} tidak dipublikasikan di 127.0.0.1:${host}`);
  }
  for (const [service, port] of [['backend', 8888], ['postgres', 5432]] as const) {
    const published = await portOf(service, port);
    if (!unpublishedPort(published.code, published.stdout, published.stderr)) ports.push(`compose port ${service} ${port} tidak kosong`);
  }
  for (const service of SERVICE_NAMES) {
    const bindings = recordOf(recordOf(inspected.get(service))['HostConfig'])['PortBindings'];
    const published = Object.entries(recordOf(bindings)).filter(([, value]) => Array.isArray(value) && value.length > 0).map(([key]) => key).sort(codeUnit);
    const wanted = service === 'edge' ? ['8080/tcp', '8443/tcp'] : [];
    if (!sameList(published, wanted)) ports.push(`${service}: port host ${published.join(', ') || 'tidak ada'}`);
  }
  const httpsPort = context.httpsPort;
  const httpPort = context.httpPort;
  if (httpsPort === null || httpPort === null) throw new Error('Edge ports missing');
  const https443 = await https(context, httpsPort, '/');
  if (https443?.status !== 200) ports.push(`HTTPS loopback ${shown(https443)}`);
  const http80 = await plain(context, httpPort, '/');
  if (http80?.status !== 308) ports.push(`HTTP loopback ${shown(http80)}`);
  judge(context, 'published_ports', ports, 'hanya edge mempublikasikan port (HTTPS dan HTTP di 127.0.0.1, keduanya terjangkau dari host); compose port backend dan postgres kosong');
}

/**
 * One probe of *Keterjangkauan*: the runner image with its user 1000:1000, `--entrypoint bun`, the fixed script through
 * `-e`, hardening flags, the run labels, and a probe name on one network of the project. `null` when it did not run.
 */
async function probe(context: Context, network: 'app' | 'data' | 'public', spec: ProbeSpec): Promise<ProbeResult | null> {
  const { names } = context;
  const name = nextProbe(context);
  const result = await call(context, `probe ${name}`, ['run', '--rm', '--name', name, '--network', `${names.project}_${network}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--label', 'foundation.test=deployment', '--label', `foundation.run=${names.hex}`,
    '--entrypoint', 'bun', names.tags.migrate, '--no-env-file', '-e', probeScript(spec)], TIMEOUTS.exec);
  // `--rm` removed a probe that ran to its end; one that timed out stays on the cleanup list.
  if (result.code !== null && !result.timedOut) context.created.containers.delete(name);
  return succeeded(result) ? parseProbe(result.stdout) : null;
}

const probeShown = (result: ProbeResult | null) => (result === null ? 'tidak berjalan' : result.result === 'ok' ? `ok${result.status === null ? '' : ` ${result.status}`}` : `gagal ${result.code ?? ''}`.trim());

/**
 * network_isolation and egress_blocked (AC-8, *Keterjangkauan*): `Internal: true` for app and data, the backend reached
 * from app, PostgreSQL not reached from app but reached from data, and no address outside the host reached from app or
 * data. The egress claim counts only after the control probe from public reaches the same address; otherwise
 * egress_blocked is not_run with reason egress_control_failed.
 */
async function reachability(context: Context): Promise<void> {
  context.step = 'network_isolation';
  const { project } = context.names;
  const isolation: string[] = [];
  for (const [network, internal] of [['app', true], ['data', true], ['public', false]] as const) {
    const result = await call(context, `network inspect ${network}`, ['network', 'inspect', '--format', '{{json .Internal}}', `${project}_${network}`], TIMEOUTS.query);
    if (!succeeded(result) || result.stdout.trim() !== String(internal)) isolation.push(`network ${network} Internal bukan ${internal}`);
  }
  const live = await probe(context, 'app', { kind: 'http', url: 'http://backend:8888/health/live' });
  if (live?.result !== 'ok' || live.status !== 200 || live.body !== '{"status":"live"}') isolation.push(`app ke backend /health/live ${probeShown(live)}`);
  const appPostgres = await probe(context, 'app', { kind: 'tcp', host: 'postgres', port: 5432 });
  if (appPostgres?.result !== 'fail') isolation.push(`app ke postgres:5432 ${probeShown(appPostgres)}, diharapkan gagal dalam 3 detik`);
  const dataPostgres = await probe(context, 'data', { kind: 'tcp', host: 'postgres', port: 5432 });
  if (dataPostgres?.result !== 'ok') isolation.push(`data ke postgres:5432 ${probeShown(dataPostgres)}`);
  judge(context, 'network_isolation', isolation, 'app dan data Internal true; app menjangkau backend /health/live 200 tetapi tidak postgres:5432; data menjangkau postgres:5432');

  context.step = 'egress_blocked';
  const outside = { kind: 'tcp', host: '1.1.1.1', port: 443 } as const;
  const control = await probe(context, 'public', outside);
  if (control?.result !== 'ok') {
    const detail = `kontrol public ke 1.1.1.1:443 ${probeShown(control)}`;
    context.checks.set('egress_blocked', { name: 'egress_blocked', status: 'not_run', detail });
    context.reasons.push({ code: 'egress_control_failed', detail });
    context.error(`deployment: check egress_blocked not_run: ${detail}`);
    return;
  }
  const egress: string[] = [];
  for (const network of ['app', 'data'] as const) {
    const result = await probe(context, network, outside);
    if (result?.result !== 'fail') egress.push(`${network} ke 1.1.1.1:443 ${probeShown(result)}, diharapkan gagal dalam 3 detik`);
  }
  judge(context, 'egress_blocked', egress, 'kontrol public menjangkau 1.1.1.1:443; app dan data tidak menjangkaunya dalam 3 detik');
}

type ContainerState = { id: string; startedAt: string; restartCount: number; running: boolean; exitCode: number | null };

/** State of a container by id, after the run label is confirmed. */
async function containerState(context: Context, label: string, id: string): Promise<ContainerState | null> {
  const object = await inspectContainer(context, label, id);
  if (object === null) return null;
  const state = recordOf(object['State']);
  const startedAt = state['StartedAt'];
  const restartCount = object['RestartCount'];
  if (typeof startedAt !== 'string' || typeof restartCount !== 'number') return null;
  return { id, startedAt, restartCount, running: state['Running'] === true, exitCode: typeof state['ExitCode'] === 'number' ? state['ExitCode'] : null };
}

async function serviceState(context: Context, service: string): Promise<ContainerState | null> {
  const id = await serviceContainer(context, service);
  return id === null ? null : containerState(context, service, id);
}

const sameStart = (before: ContainerState | null, after: ContainerState | null) =>
  before !== null && after !== null && before.id === after.id && before.startedAt === after.startedAt && after.restartCount === 0;

/** stdout and stderr of one container by id or explicit name, read apart, after the run label is confirmed. */
async function containerLogs(context: Context, label: string, id: string): Promise<{ stdout: string; stderr: string } | null> {
  const inspected = await call(context, `inspect ${label}`, ['inspect', '--format', '{{json .Config.Labels}}', id], TIMEOUTS.query);
  const labels = succeeded(inspected) ? parseJson(inspected.stdout.trim()) : undefined;
  if (!isRecord(labels) || labels['foundation.run'] !== context.names.hex) return null;
  const logs = await call(context, `logs ${label}`, ['logs', id], TIMEOUTS.logs);
  return succeeded(logs) ? { stdout: logs.stdout, stderr: logs.stderr } : null;
}

const backendLines = (text: string) => text.split('\n').map((line) => line.trim()).filter((line) => line !== '').map(parseBackendLogLine);

/** An edge JSON 502 or 504 for /api/ with *Header API*, `application/json`, and `no-store` (AC-7, AC-9). */
function edgeGatewayAnswer(answer: EdgeAnswer | null): boolean {
  if (answer === null || (answer.status !== 502 && answer.status !== 504)) return false;
  return answer.body === EDGE_ERROR_BODIES[answer.status] && header(answer, 'content-type') === 'application/json' && header(answer, 'cache-control') === 'no-store' && apiHeaderProblems(answer.headers).length === 0;
}

/** The backend 404 of `/api/status` through the edge, with *Header API*. */
function backendNotFound(answer: EdgeAnswer | null): boolean {
  return answer !== null && answer.status === 404 && answer.body === '{"error":"Not found"}' && (header(answer, 'content-type') ?? '').startsWith('application/json') && apiHeaderProblems(answer.headers).length === 0;
}

/** Asks `/api/status` through the edge every 500 ms until the backend answers 404; the wait in ms, or `null` after `limitMs`. */
async function forwardedAgain(context: Context, port: number, limitMs: number): Promise<number | null> {
  const started = context.now();
  while (context.now() - started < limitMs) {
    const asked = context.now();
    if (backendNotFound(await https(context, port, '/api/status'))) return context.now() - started;
    const wait = WINDOWS.apiInterval - (context.now() - asked);
    if (wait > 0) await context.sleep(wait);
  }
  return null;
}

/**
 * Requests whose query string, `Authorization`, `Cookie`, free header, and body carry fresh sentinel values (AC-10):
 * a GET and a POST through the edge, and with the backend running a body above 1,024 bytes that the edge refuses.
 * The answers must show the requests went where expected; log_no_data then finds none of the values in any log.
 */
async function sendSentinels(context: Context, port: number, phase: 'stopped' | 'running'): Promise<void> {
  const value = () => secret(context, 16);
  const headers = { Authorization: `Bearer ${value()}`, Cookie: `session=${value()}`, 'X-Foundation-Note': value() };
  const path = `/api/log-${phase}-${context.names.hex}`;
  const expected = phase === 'running' ? [404] : [502, 504];
  const get = await https(context, port, `${path}?token=${value()}&returnUrl=%2Fhome`, { headers });
  const post = await https(context, port, path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: value() }) });
  for (const [label, answer] of [['GET', get], ['POST', post]] as const) {
    if (answer === null || !expected.includes(answer.status)) context.sentinelProblems.push(`${phase} ${label} sentinel ${shown(answer)}`);
  }
  if (phase === 'running') {
    const large = await https(context, port, path, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: `${value()}${'a'.repeat(BODY_LIMIT_BYTES)}` });
    if (large?.status !== 413) context.sentinelProblems.push(`running POST sentinel 1056 byte ${shown(large)}, diharapkan 413`);
  }
}

/**
 * backend_shutdown_restart (AC-9 (1), with the 502 of AC-7 through the real backend): `compose stop backend` ends within
 * 6 seconds with exit code 0 and the `stopped` line; the edge keeps answering `/` 200, and `/api/status` every 500 ms
 * answers edge JSON 502 or 504 and only 502 from 15,000 ms after the stop; after `start backend` the backend 404 comes
 * back through the edge within 20 seconds without an edge restart.
 */
async function backendShutdownRestart(context: Context, port: number): Promise<void> {
  context.step = 'backend_shutdown_restart';
  const problems: string[] = [];
  const edgeBefore = await serviceState(context, 'edge');
  const before = await serviceState(context, 'backend');
  if (edgeBefore === null || before === null) {
    judge(context, 'backend_shutdown_restart', ['state edge atau backend tidak terbaca'], '');
    return;
  }
  const started = context.now();
  const stopped = await composeStep(context, 'stop backend', ['stop', 'backend'], TIMEOUTS.composeStop);
  const stopEnd = context.now();
  const stopMs = stopEnd - started;
  if (!succeeded(stopped)) problems.push('compose stop backend gagal');
  else if (stopMs > WINDOWS.backendStop) problems.push(`stop backend ${stopMs} ms, di atas ${WINDOWS.backendStop} ms`);
  const after = await containerState(context, 'backend', before.id);
  if (after === null || after.running || after.exitCode !== 0) problems.push(`backend keluar dengan kode ${after?.exitCode ?? 'tidak terbaca'}`);
  const logs = await containerLogs(context, 'backend', before.id);
  const last = logs === null ? null : backendLines(logs.stdout).filter((line) => line !== null).at(-1);
  if (last === null || last === undefined || last.event !== 'stopped' || last.level !== 'info') problems.push('baris log stopped tidak ada di akhir stdout backend');

  const root = await https(context, port, '/');
  if (root?.status !== 200) problems.push(`GET / ${shown(root)} saat backend berhenti`);
  await sendSentinels(context, port, 'stopped');
  const samples: StoppedSample[] = [];
  while (context.now() - stopEnd < WINDOWS.reresolve + WINDOWS.stoppedTail) {
    const atMs = context.now() - stopEnd;
    const answer = await https(context, port, '/api/status');
    samples.push({ atMs, status: answer?.status ?? null, edgeJson: edgeGatewayAnswer(answer) });
    const wait = WINDOWS.apiInterval - (context.now() - stopEnd - atMs);
    if (wait > 0) await context.sleep(wait);
  }
  problems.push(...stoppedBackendProblems(samples, WINDOWS.reresolve));

  const startedAgain = await composeStep(context, 'start backend', ['start', 'backend'], TIMEOUTS.composeStop);
  if (!succeeded(startedAgain)) problems.push('compose start backend gagal');
  const back = await forwardedAgain(context, port, WINDOWS.forwardAgain);
  if (back === null) problems.push(`/api/status tidak kembali 404 backend dalam ${WINDOWS.forwardAgain} ms`);
  if (!sameStart(edgeBefore, await serviceState(context, 'edge'))) problems.push('edge dimulai ulang');
  const window = samples.filter((sample) => sample.status === 504).length;
  judge(context, 'backend_shutdown_restart', problems, `stop backend ${stopMs} ms, exit 0, baris stopped; ${samples.length} jawaban (${window} kali 504) lalu 502; 404 backend lagi ${back ?? '-'} ms sesudah start tanpa restart edge`);
}

/**
 * backend_recreate (AC-9 (2)): `up -d --force-recreate --no-deps backend` gives a new backend container that the edge
 * reaches again within 20 seconds without an edge restart, because the name is resolved again. The replaced
 * container's logs are read first, for the log checks.
 */
async function backendRecreate(context: Context, port: number): Promise<void> {
  context.step = 'backend_recreate';
  const problems: string[] = [];
  const edgeBefore = await serviceState(context, 'edge');
  const before = await serviceState(context, 'backend');
  const beforeAddress = before === null ? null : appAddress(await inspectContainer(context, 'backend', before.id), context.names.project);
  if (before !== null) {
    context.priorBackendLogs = await containerLogs(context, 'backend replaced', before.id);
    if (context.priorBackendLogs !== null) context.containerOutputs.push(['logs backend sebelum recreate', `${context.priorBackendLogs.stdout}${context.priorBackendLogs.stderr}`]);
  }
  if (context.priorBackendLogs === null) problems.push('log backend sebelum recreate tidak terbaca');
  const recreated = await composeStep(context, 'recreate backend', ['up', '-d', '--force-recreate', '--no-deps', 'backend'], TIMEOUTS.composeUp);
  if (!succeeded(recreated)) problems.push('up --force-recreate backend gagal');
  const back = await forwardedAgain(context, port, WINDOWS.forwardAgain);
  if (back === null) problems.push(`/api/status tidak kembali 404 backend dalam ${WINDOWS.forwardAgain} ms`);
  const after = await serviceState(context, 'backend');
  if (before === null || after === null || after.id === before.id) problems.push('container backend tidak dibuat ulang');
  if (!sameStart(edgeBefore, await serviceState(context, 'edge'))) problems.push('edge dimulai ulang');
  // Docker may give the new container the old address; the detail says which case this run saw.
  const address = after === null ? null : appAddress(await inspectContainer(context, 'backend', after.id), context.names.project);
  const moved = beforeAddress === null || address === null ? 'alamat app tidak terbaca' : beforeAddress === address ? 'alamat app sama' : 'alamat app berubah';
  judge(context, 'backend_recreate', problems, `backend dibuat ulang (${moved}) dan diteruskan lagi ${back ?? '-'} ms sesudah recreate tanpa restart edge`);
}

/** The IPv4 address of a container on network app of the project. */
function appAddress(inspected: Record<string, unknown> | null, project: string): string | null {
  const address = recordOf(recordOf(recordOf(inspected?.['NetworkSettings'])['Networks'])[`${project}_app`])['IPAddress'];
  return typeof address === 'string' && address !== '' ? address : null;
}

/** Asks `/health/ready` inside the backend until `status` answers or `limitMs` passes; the wait in ms, or `null`. */
async function readinessWithin(context: Context, status: 200 | 503, limitMs: number): Promise<number | null> {
  const started = context.now();
  const body = status === 200 ? '{"status":"ready"}' : '{"status":"unavailable"}';
  while (context.now() - started < limitMs) {
    const answer = await backendHealth(context, '/health/ready');
    if (answer?.status === status && answer.body === body && answer.cacheControl === 'no-store') return context.now() - started;
    await context.sleep(250);
  }
  return null;
}

/**
 * database_outage (AC-4, AC-9 (3)): `compose stop postgres` makes `/health/ready` 503 within 6 seconds while
 * `/health/live` stays 200 and the edge serves `/`; after `start postgres`, `/health/ready` is 200 again within 30
 * seconds without a backend restart.
 */
async function databaseOutage(context: Context, port: number): Promise<void> {
  context.step = 'database_outage';
  const problems: string[] = [];
  const backendBefore = await serviceState(context, 'backend');
  const stopped = await composeStep(context, 'stop postgres', ['stop', 'postgres'], TIMEOUTS.composeStop);
  if (!succeeded(stopped)) problems.push('compose stop postgres gagal');
  const lost = await readinessWithin(context, 503, WINDOWS.readyLost);
  if (lost === null) problems.push(`/health/ready tidak 503 dalam ${WINDOWS.readyLost} ms`);
  const live = await backendHealth(context, '/health/live');
  if (live?.status !== 200 || live.body !== '{"status":"live"}') problems.push(`/health/live ${live === null ? 'tanpa jawaban' : live.status} saat postgres berhenti`);
  const root = await https(context, port, '/');
  if (root?.status !== 200) problems.push(`GET / edge ${shown(root)} saat postgres berhenti`);
  const startedAgain = await composeStep(context, 'start postgres', ['start', 'postgres'], TIMEOUTS.composeStop);
  if (!succeeded(startedAgain)) problems.push('compose start postgres gagal');
  const back = await readinessWithin(context, 200, WINDOWS.readyBack);
  if (back === null) problems.push(`/health/ready tidak 200 dalam ${WINDOWS.readyBack} ms sesudah start postgres`);
  if (!sameStart(backendBefore, await serviceState(context, 'backend'))) problems.push('backend dimulai ulang');
  judge(context, 'database_outage', problems, `/health/ready 503 ${lost ?? '-'} ms sesudah stop postgres, /health/live 200 dan edge / 200; 200 lagi ${back ?? '-'} ms sesudah start tanpa restart backend`);
}

/** Waits for the edge `GET /` 200 at most `TIMEOUTS.edgeRootWait`; the wait in ms, or `null`. */
async function edgeRootWithin(context: Context, port: number): Promise<number | null> {
  const edgeFetch = context.deps.edgeFetch ?? defaultEdgeFetch;
  const started = context.now();
  while (context.now() - started < TIMEOUTS.edgeRootWait) {
    stopIfAborted(context);
    if ((await edgeFetch(`https://localhost:${port}/`, context.caPem ?? '', context.stop)) === 200) return context.now() - started;
    await context.sleep(500);
  }
  return null;
}

/**
 * edge_shutdown (AC-9 (4)): `compose stop edge` (SIGQUIT) ends within 15 seconds with exit code 0. The edge is started
 * again afterwards, so the log traffic and topology_shutdown see the whole topology running.
 */
async function edgeShutdown(context: Context, port: number): Promise<void> {
  context.step = 'edge_shutdown';
  const problems: string[] = [];
  const before = await serviceState(context, 'edge');
  const started = context.now();
  const stopped = await composeStep(context, 'stop edge', ['stop', 'edge'], TIMEOUTS.composeStop);
  const stopMs = context.now() - started;
  if (!succeeded(stopped)) problems.push('compose stop edge gagal');
  else if (stopMs > WINDOWS.edgeStop) problems.push(`stop edge ${stopMs} ms, di atas ${WINDOWS.edgeStop} ms`);
  const after = before === null ? null : await containerState(context, 'edge', before.id);
  if (after === null || after.running || after.exitCode !== 0) problems.push(`edge keluar dengan kode ${after?.exitCode ?? 'tidak terbaca'}`);
  const startedAgain = await composeStep(context, 'start edge', ['start', 'edge'], TIMEOUTS.composeStop);
  if (!succeeded(startedAgain) || (await edgeRootWithin(context, port)) === null) problems.push('edge tidak kembali menjawab GET / 200 sesudah start');
  judge(context, 'edge_shutdown', problems, `stop edge (SIGQUIT) ${stopMs} ms dengan exit 0`);
}

/** `sh -c` script for `compose exec postgres`: psql through TCP with the container's own credentials, never in argv. */
const psqlScript = (...commands: string[]) =>
  `PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAt -v ON_ERROR_STOP=1 ${commands.map((command) => `-c '${command}'`).join(' ')}`;

/**
 * The failing statement of postgres_log_policy: the sentinel cast to integer behind the letter `x`. PostgreSQL reads
 * integer input as spaces, a sign, then digits, so the letter ends it with `invalid input syntax` for every sentinel. A
 * bare hex sentinel whose leading digits pass the int32 range (about one run in 120) gets `out of range` instead.
 */
export const failingStatement = (sentinel: string) => `SELECT $s$x${sentinel}$s$::integer`;

/**
 * log_structure, log_correlation, log_no_data, and postgres_log_policy (AC-10), from `docker logs` per container with
 * stdout and stderr read apart. First the traffic: one correlation request through the edge with a client
 * `X-Request-Id`, the sentinel requests, a direct request to the backend from network app with an id that is not 32
 * hex digits, a direct body above 1,024 bytes that Bun refuses before Elysia, and a failing statement with a sentinel
 * inside PostgreSQL.
 */
async function logChecks(context: Context, port: number): Promise<void> {
  const { hex, migrate } = context.names;
  context.step = 'log_traffic';
  const clientId = randomBytes(16).toString('hex');
  const correlationPath = `/api/correlation-${hex}`;
  const correlated = await https(context, port, correlationPath, { headers: { 'X-Request-Id': clientId } });
  await sendSentinels(context, port, 'running');
  const directId = 'Z'.repeat(32);
  const directPath = `/api/direct-${hex}`;
  const direct = await probe(context, 'app', { kind: 'http', url: `http://backend:8888${directPath}`, headers: { 'X-Request-Id': directId } });
  const largePath = `/api/too-large-${hex}`;
  const large = await probe(context, 'app', { kind: 'http', url: `http://backend:8888${largePath}`, method: 'POST', headers: { 'Content-Type': 'text/plain' }, bodyBytes: 2 * BODY_LIMIT_BYTES });
  // An HTTP/2 request that nginx ends without an answer: its access log line has the status 000 of nginx (AC-10).
  const abortedPath = `/h2-aborted-${hex}`;
  stopIfAborted(context);
  const aborted = await (context.deps.edgeH2 ?? defaultEdgeH2)({ port, ca: context.caPem ?? '', path: abortedPath, headerBytes: 9_000, timeoutMs: TIMEOUTS.exec }, context.stop);
  stopIfAborted(context);

  context.step = 'postgres_log_policy';
  const policy: string[] = [];
  const postgres = await serviceInspect(context, 'postgres');
  if (!sameList(recordOf(postgres?.['Config'])['Cmd'], POSTGRES_COMMAND)) policy.push('perintah container postgres tanpa ketiga flag log');
  const settings = await composeStep(context, 'exec postgres show', ['exec', '-T', 'postgres', 'sh', '-c', psqlScript('SHOW log_min_messages', 'SHOW log_min_error_statement', 'SHOW log_error_verbosity')], TIMEOUTS.exec);
  if (!succeeded(settings) || settings.stdout.trim().split('\n').map((line) => line.trim()).join(',') !== 'log,panic,terse') policy.push('SHOW tidak memberi log, panic, terse');
  const statementSentinel = secret(context, 16);
  const failing = await composeStep(context, 'exec postgres failing', ['exec', '-T', 'postgres', 'sh', '-c', psqlScript(failingStatement(statementSentinel))], TIMEOUTS.exec);
  if (failing.code === 0 || failing.timedOut || !failing.stderr.includes('invalid input syntax')) {
    policy.push(`statement gagal bersentinel tidak berjalan sebagai galat (kode ${failing.code ?? 'tidak ada'}${failing.timedOut ? ', batas waktu' : ''})`);
    printTail(context, 'exec postgres failing', failing);
  }
  await context.sleep(1_000);

  context.step = 'log_structure';
  const edgeLogs = await serviceLogs(context, 'edge');
  const backendLogs = await serviceLogs(context, 'backend');
  const postgresLogs = await serviceLogs(context, 'postgres');
  const migrateLogs = await containerLogs(context, 'migrate', migrate);
  const outputs: [string, { stdout: string; stderr: string } | null][] = [
    ['edge', edgeLogs], ['backend', backendLogs], ['backend sebelum recreate', context.priorBackendLogs], ['postgres', postgresLogs], ['migrate', migrateLogs],
  ];
  for (const [label, logs] of outputs) if (logs !== null && label !== 'backend sebelum recreate') context.containerOutputs.push([`logs ${label}`, `${logs.stdout}${logs.stderr}`]);

  const structure: string[] = [];
  for (const [label, logs] of outputs) if (logs === null) structure.push(`log ${label} tidak terbaca`);
  const edgeLines = (edgeLogs?.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const edgeBad = edgeLines.map(edgeLogLineProblem).filter((problem): problem is string => problem !== null);
  if (edgeLines.length === 0) structure.push('stdout edge kosong');
  if (edgeBad.length > 0) structure.push(`${edgeBad.length} baris stdout edge: ${edgeBad[0]}`);
  const abortedLine = edgeLines.map(parseEdgeLogLine).find((line) => line?.path === abortedPath);
  if (aborted !== 'reset') structure.push(`request HTTP/2 dengan header 9000 byte ${aborted ?? 'tanpa sesi TLS'}, diharapkan diakhiri tanpa jawaban`);
  else if (abortedLine === undefined || abortedLine === null) structure.push('baris log edge untuk request HTTP/2 yang diakhiri tanpa jawaban tidak ada atau bukan JSON');
  else if (abortedLine.status !== 0) structure.push(`baris log edge untuk request HTTP/2 yang diakhiri tanpa jawaban berstatus ${abortedLine.status}, diharapkan 0`);
  const edgeStderr = (edgeLogs?.stderr ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (edgeStderr.some((line) => !/\[(crit|alert|emerg)\]/.test(line))) structure.push('stderr edge memuat baris di bawah level crit');
  for (const [label, logs] of [['backend', backendLogs], ['backend sebelum recreate', context.priorBackendLogs]] as const) {
    if (logs === null) continue;
    const out = backendLines(logs.stdout);
    const err = backendLines(logs.stderr);
    if (out.some((line) => line === null) || err.some((line) => line === null)) structure.push(`${label}: baris yang bukan JSON log production`);
    if (out.some((line) => line !== null && line.level !== 'info')) structure.push(`${label}: baris error di stdout`);
    if (err.some((line) => line !== null && line.level !== 'error')) structure.push(`${label}: baris info di stderr`);
    if (out[0] === undefined || out[0] === null || out[0].event !== 'listening') structure.push(`${label}: baris pertama bukan listening`);
  }
  const requests = [...backendLines(backendLogs?.stdout ?? ''), ...backendLines(backendLogs?.stderr ?? ''), ...backendLines(context.priorBackendLogs?.stdout ?? ''), ...backendLines(context.priorBackendLogs?.stderr ?? '')]
    .filter((line): line is Extract<BackendLogLine, { event: 'request' }> => line !== null && line.event === 'request');
  if (requests.some((line) => (line.path === '/health/live' || line.path === '/health/ready') && line.status < 500)) structure.push('jawaban health di bawah 500 tercatat');
  if (large?.result !== 'ok' || large.status !== 413) structure.push(`body 2048 byte langsung ke backend ${probeShown(large)}, diharapkan 413`);
  if (requests.some((line) => line.path === largePath)) structure.push('request yang ditolak Bun sebelum Elysia tercatat');
  judge(context, 'log_structure', structure, `${edgeLines.length} baris JSON edge dengan key dan tipe AC-10, termasuk status 0 untuk request HTTP/2 yang diakhiri tanpa jawaban; log backend JSON production (info hanya stdout, error hanya stderr); health di bawah 500 dan 413 Bun tidak tercatat`);

  context.step = 'log_correlation';
  const correlation: string[] = [];
  const responseId = correlated === null ? undefined : header(correlated, 'x-request-id');
  if (correlated === null || !backendNotFound(correlated) || responseId === undefined || !REQUEST_ID.test(responseId) || responseId === clientId) {
    correlation.push(`request korelasi ${shown(correlated)} tanpa X-Request-Id edge`);
  } else {
    const edgeLine = edgeLines.map((line) => parseEdgeLogLine(line)).find((line) => line?.requestId === responseId);
    if (edgeLine?.path !== correlationPath) correlation.push('baris log edge dengan ID jawaban tidak ada');
    if (!requests.some((line) => line.requestId === responseId && line.path === correlationPath && line.status === 404)) correlation.push('baris log backend dengan ID jawaban tidak ada');
  }
  if (`${edgeLogs?.stdout ?? ''}${backendLogs?.stdout ?? ''}${backendLogs?.stderr ?? ''}`.includes(clientId)) correlation.push('ID dari client tercatat');
  const directLine = requests.find((line) => line.path === directPath);
  if (direct?.result !== 'ok' || direct.status !== 404) correlation.push(`request langsung ke backend ${probeShown(direct)}`);
  if (directLine === undefined || directLine.requestId === directId.toLowerCase() || !REQUEST_ID.test(directLine.requestId)) correlation.push('backend tidak membuat requestId sendiri untuk X-Request-Id yang tidak sah');
  judge(context, 'log_correlation', correlation, 'header X-Request-Id jawaban, baris log edge, dan baris log backend memuat ID yang sama; ID client tidak dipakai; ID tidak sah diganti backend');

  context.step = 'log_no_data';
  const scanned: [string, string][] = [
    ...outputs.flatMap(([label, logs]): [string, string][] => (logs === null ? [] : [[`stdout ${label}`, logs.stdout], [`stderr ${label}`, logs.stderr]])),
    ...['run provision', 'run default command', 'run migrate', 'run seed'].map((label): [string, string] => [label, context.outputs.get(label) ?? '']),
  ];
  const leaks = scanned.filter(([, text]) => containsSecret(text, context.secrets)).map(([label]) => `${label} memuat nilai rahasia run`);
  judge(context, 'log_no_data', [...context.sentinelProblems, ...leaks], `${context.secrets.length} nilai (sentinel query, Authorization, Cookie, header, body, termasuk saat 502; password dan DSN run) tidak ada di ${scanned.length} keluaran container`);

  context.step = 'postgres_log_policy';
  const postgresText = `${postgresLogs?.stdout ?? ''}${postgresLogs?.stderr ?? ''}`;
  if (postgresLogs === null) policy.push('log postgres tidak terbaca');
  else if (postgresText.includes(statementSentinel) || postgresText.includes('invalid input syntax') || postgresText.includes('STATEMENT:')) policy.push('statement gagal bersentinel masuk log postgres');
  judge(context, 'postgres_log_policy', policy, 'postgres berjalan dengan log_min_messages=log, log_min_error_statement=panic, log_error_verbosity=terse; statement gagal bersentinel tidak masuk log');
}

/** topology_shutdown (AC-9 (5)): `docker compose stop` of every service ends with exit code 0 for each container, inside its stop grace. */
async function topologyShutdown(context: Context): Promise<void> {
  context.step = 'topology_shutdown';
  const problems: string[] = [];
  const before = new Map<string, ContainerState | null>();
  for (const service of ['edge', 'backend', 'postgres']) before.set(service, await serviceState(context, service));
  const started = context.now();
  const stopped = await composeStep(context, 'stop', ['stop'], TIMEOUTS.composeStop);
  const stopMs = context.now() - started;
  if (!succeeded(stopped)) problems.push('compose stop gagal');
  for (const [service, state] of before) {
    if (state === null || !state.running) {
      problems.push(`${service} tidak berjalan sebelum stop`);
      continue;
    }
    const after = await containerState(context, service, state.id);
    if (after === null || after.running || after.exitCode !== 0) problems.push(`${service} keluar dengan kode ${after?.exitCode ?? 'tidak terbaca'}`);
  }
  judge(context, 'topology_shutdown', problems, `compose stop ${stopMs} ms; edge, backend, dan postgres keluar 0 dalam stop grace masing masing`);
}

/**
 * artifact_scan (AC-2, AC-11): the evidence files of this step (images.json, the Playwright JUnit, and every file in
 * test-results/) and the container output read for the log checks, against every run credential and sentinel. Writes
 * artifact-scan.json in the shape of readiness-real.ts.
 */
async function artifactScan(context: Context): Promise<void> {
  const evidence = join(context.deps.root, EVIDENCE_ROOT);
  const files: string[] = [];
  for (const path of ['images.json', 'playwright-deployment.xml']) if (await Bun.file(join(evidence, path)).exists()) files.push(path);
  try {
    for (const path of await listTree(join(evidence, 'test-results'))) files.push(`test-results/${path}`);
  } catch {
    // No screenshots were written.
  }
  const findings: string[] = [];
  for (const [label, text] of context.containerOutputs) if (containsSecret(text, context.secrets)) findings.push(`${label} output`);
  const secrets = context.secrets.filter((value) => value !== '').map((value) => Buffer.from(value));
  for (const path of files) {
    const data = await readFile(join(evidence, path));
    if (secrets.some((value) => data.includes(value))) findings.push(`${EVIDENCE_ROOT}/${path}`);
  }
  const junit = join(evidence, 'playwright-deployment.xml');
  const report = {
    outputsScanned: context.containerOutputs.map(([label]) => label),
    filesScanned: files.map((path) => `${EVIDENCE_ROOT}/${path}`),
    secretsChecked: secrets.length,
    junitSha256: (await Bun.file(junit).exists()) ? new Bun.CryptoHasher('sha256').update(await readFile(junit)).digest('hex') : null,
    findings,
  };
  await writeFile(join(evidence, 'artifact-scan.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (findings.length === 0) pass(context, 'artifact_scan', `${secrets.length} nilai run tidak ada di ${files.length} file bukti dan ${context.containerOutputs.length} keluaran container`);
  else {
    context.checks.set('artifact_scan', { name: 'artifact_scan', status: 'failed', detail: findings.join(', ') });
    context.reasons.push({ code: 'artifact_scan_findings', detail: findings.join(', ') });
    context.error(`deployment: check artifact_scan failed: ${clip(findings.join(', '))}`);
  }
}

// --- Step 7: cleanup.

/**
 * Removes only what this run created, by explicit name through the guards; never aborted, each with its own limit.
 * The named containers go first, then the project: the stub of *Upstream stub* is a plain container on the project
 * network `app`, and while it is attached `compose down` leaves that network behind and still exits 0 (Compose v5.5.1,
 * observed 2026-10-05), so the opposite order would leak the network unseen after a signal during the stub check.
 */
async function cleanUp(context: Context): Promise<string[]> {
  const failures: string[] = [];
  const containers = [...context.created.containers];
  if (containers.some((name) => !containerNameAccepted(name, context.names.hex))) failures.push('container guard');
  else if (containers.length > 0) {
    // `rm -f` skips a name that no longer exists.
    const removed = await call(context, 'rm', ['rm', '-f', ...containers], TIMEOUTS.removeContainers, { abortable: false });
    if (!succeeded(removed)) failures.push(containers.join(' '));
  }
  if (context.created.compose && context.envFile !== null) {
    if (!projectAccepted(context.names.project, context.names.hex)) failures.push('project guard');
    else {
      const down = await call(context, 'down', compose(context, 'down', '--volumes', '--remove-orphans', '--timeout', '30'), TIMEOUTS.down, { abortable: false });
      if (!succeeded(down)) {
        printTail(context, 'down', down);
        failures.push(context.names.project);
      }
    }
  }
  const images = [...context.created.images];
  if (images.length > 0) {
    const removed = await call(context, 'image rm', ['image', 'rm', ...images], TIMEOUTS.removeImages, { abortable: false });
    if (!succeeded(removed) && !(removed.code === 1 && onlyMissingImages(removed.stderr, images))) failures.push(images.join(' '));
  }
  if (context.created.folder !== null) {
    try {
      await removeTree(context.created.folder);
      context.created.folder = null;
    } catch {
      failures.push('folder');
    }
  }
  return failures;
}

function signalName(signal: AbortSignal): HandledSignal | null {
  const value = signal.reason as unknown;
  return value === 'SIGHUP' || value === 'SIGINT' || value === 'SIGTERM' ? value : null;
}

/**
 * One deployment run from the checks to cleanup and `result.json`. Resolves to 0 only when every check passed and
 * cleanup is complete; 1 otherwise; 129, 130, or 143 after SIGHUP, SIGINT, or SIGTERM (`deps.signal.reason`).
 */
export async function runDeployment(deps: RunDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const names = deploymentNames(runHex());
  const deadline = new AbortController();
  const deadlineMs = deps.deadlineMs ?? DEPLOYMENT_DEADLINE_MS;
  const secrets: string[] = [];
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const error = deps.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  const redact = redactor(secrets);
  const context: Context = {
    deps,
    names,
    dockerEnv: stepEnvironment(deps.env ?? process.env),
    secrets,
    redact,
    reasons: [],
    checks: new Map(),
    outputs: new Map(),
    created: { folder: null, compose: false, containers: new Set(), images: new Set() },
    envFile: null,
    provisioning: null,
    contextDir: null,
    caPem: null,
    caFile: null,
    httpsPort: null,
    httpPort: null,
    credentials: null,
    probes: 0,
    copyPaths: [],
    imageInspect: new Map(),
    priorBackendLogs: null,
    sentinels: [],
    sentinelProblems: [],
    containerOutputs: [],
    stop: AbortSignal.any([deps.signal, deadline.signal]),
    deadlineAt: now() + deadlineMs,
    now,
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
    step: 'start',
    log: (line) => log(redact(line)),
    error: (line) => error(redact(line)),
  };

  // The evidence folder is prepared before the total deadline timer exists: when it cannot be prepared the run rejects
  // without an armed timer, so the process exits at once instead of after DEPLOYMENT_DEADLINE_MS.
  const evidence = join(deps.root, EVIDENCE_ROOT);
  await mkdir(evidence, { recursive: true });
  for (const path of EVIDENCE_PATHS) await rm(join(evidence, path), { recursive: true, force: true });
  const timer = setTimeout(() => deadline.abort('timeout'), Math.max(0, context.deadlineAt - now()));
  context.log(`deployment: run ${names.hex} dimulai (project ${names.project})`);

  const candidate: Candidate = { commit: null, sourceTree: null };
  try {
    candidate.commit = await gitCommit(deps.root, deps.env ?? process.env);
    candidate.sourceTree = await sourceTree(deps.root, undefined, deps.env ?? process.env);
  } catch {
    // Without a readable repository both stay null and the image labels say unknown.
  }
  try {
    const bases = await preflight(context);
    await prepareWorkspace(context);
    await buildImages(context, bases, candidate);
    await deploy(context);
  } catch (caught) {
    if (!(caught instanceof Stop)) {
      context.error(`deployment: langkah ${context.step} gagal tanpa diduga`);
      context.reasons.push({ code: 'check_failed', detail: context.step });
    }
  }
  clearTimeout(timer);
  const received = deps.signal.aborted ? signalName(deps.signal) : null;
  if (received !== null) context.reasons.push({ code: 'signal', detail: received });
  else if (deadline.signal.aborted || now() >= context.deadlineAt) context.reasons.push({ code: 'timeout', detail: context.step });

  context.log('deployment: membersihkan resource run');
  const failures = await cleanUp(context);
  if (failures.length === 0) context.checks.set('cleanup', { name: 'cleanup', status: 'passed', detail: 'project, container bernama, image, dan folder run dihapus' });
  else {
    context.checks.set('cleanup', { name: 'cleanup', status: 'failed', detail: failures.join(', ') });
    context.reasons.push({ code: 'cleanup_failed', detail: failures.join(', ') });
    context.error(`deployment: pembersihan belum lengkap (${failures.join(', ')}); hapus resource berlabel foundation.run=${names.hex} dengan tangan sesudah ditinjau`);
  }
  // *Urutan orkestrasi* (7): the evidence is scanned for the run credentials and sentinels, then result.json is last.
  try {
    await artifactScan(context);
  } catch {
    context.checks.set('artifact_scan', { name: 'artifact_scan', status: 'failed', detail: 'pemindaian bukti gagal' });
    context.reasons.push({ code: 'artifact_scan_findings', detail: 'pemindaian bukti gagal' });
  }
  // A signal that arrived during cleanup or the scan is recorded in result.json and ends the run with its exit code.
  const late = received === null && deps.signal.aborted ? signalName(deps.signal) : null;
  if (late !== null) context.reasons.push({ code: 'signal', detail: late });

  let result = buildResult({ startedAt, finishedAt: new Date(now()).toISOString(), candidate, checks: context.checks, reasons: context.reasons });
  const raw = `${JSON.stringify(result, null, 2)}\n`;
  if (containsSecret(raw, secrets)) {
    result = buildResult({ startedAt, finishedAt: result.finishedAt, candidate, checks: context.checks, reasons: [...context.reasons, { code: 'artifact_scan_findings', detail: `${EVIDENCE_ROOT}/result.json` }] });
  }
  await writeFile(join(evidence, 'result.json'), redact(`${JSON.stringify(result, null, 2)}\n`));

  const counts = { passed: 0, failed: 0, not_run: 0 };
  for (const check of result.checks) counts[check.status] += 1;
  context.log(`deployment: ${counts.passed} check passed, ${counts.failed} failed, ${counts.not_run} not_run; hasil di ${EVIDENCE_ROOT}/result.json`);
  const reasons = result.reasons.map((item) => (item.detail === null ? item.code : `${item.code} ${item.detail}`)).join(', ');
  if (result.status === 'passed') context.log('deployment: passed');
  else context.error(`deployment: failed${reasons === '' ? '' : ` (${reasons})`}`);
  // The handlers of `main` stay installed until this returns, so a signal after result.json was written still decides
  // the exit code (result.json no longer changes) instead of being swallowed.
  const signalled = received ?? late ?? (deps.signal.aborted ? signalName(deps.signal) : null);
  if (signalled !== null) return SIGNAL_EXIT_CODES[signalled];
  return result.status === 'passed' ? 0 : 1;
}

/** SIGINT, SIGTERM, and SIGHUP handlers that abort the running step, the real deps, then `runDeployment`. */
export async function main(options: { root: string; env?: Readonly<Record<string, string | undefined>>; log?: (line: string) => void; error?: (line: string) => void }): Promise<number> {
  const error = options.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  const controller = new AbortController();
  const handlers = (Object.keys(SIGNAL_EXIT_CODES) as HandledSignal[]).map((signal) => {
    const handler = () => controller.abort(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    return await runDeployment({
      root: options.root,
      run: runProcessGroup,
      signal: controller.signal,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.log === undefined ? {} : { log: options.log }),
      error,
    });
  } catch {
    error('deployment: run tidak dapat diselesaikan; periksa resource berlabel foundation.test=deployment');
    return 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

if (import.meta.main) {
  process.exitCode = await main({ root: resolve(import.meta.dir, '../..') });
}
