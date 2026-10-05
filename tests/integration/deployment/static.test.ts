import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REQUIRED_MIGRATION } from '../../../apps/backend/src/features/health/health.queries.ts';
import { DEPLOYMENT_CHECKS, type DeploymentCheckName } from '../../../scripts/lib/gate.ts';
import { DEPLOYMENT_IMAGE_NAMES } from '../../../scripts/lib/gate-report.ts';
import {
  ABOVE_ROOT_TARGETS,
  addedEnvironment,
  BODY_LIMIT_BYTES,
  buildResult,
  checkPins,
  CLIENT_ADDRESS_HEADERS,
  CommandRefused,
  containerNameAccepted,
  CONTENT_SECURITY_POLICY,
  CONTEXT_ALLOWLIST,
  declarationProblems,
  deploymentNames,
  dockerArgs,
  dockerfileImages,
  edgeLogLineProblem,
  expectedContext,
  failingStatement,
  hardeningProblems,
  HEALTH_API_TARGETS,
  HEALTH_DOCUMENT_TARGETS,
  healthNotPublicProblems,
  ignoreMatches,
  ignorePattern,
  imageConfigProblems,
  IMMUTABLE_CACHE,
  IMAGES,
  nginxDefault400Problems,
  parseBackendLogLine,
  parseEdgeLogLine,
  parseProbe,
  PROBE_LIMIT_MS,
  probeScript,
  projectAccepted,
  requestedOriginsProblems,
  runHex,
  secretArgs,
  stoppedBackendProblems,
  TLS12_CIPHERS,
  TRAVERSAL_TARGETS,
  unpublishedPort,
  type CheckRecord,
  type EdgeLogLine,
  type LoggedAnswer,
} from '../../orchestration/deployment-real.ts';

// DEP-001 (spec 0012; AC-1, AC-2, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12): the static form of the deployment artifacts
// and the pure functions of the orchestration, without a container engine. The three Dockerfiles and their allow list
// ignore files, the base image pins against `engines` and tests/performance/images.json, deploy/compose.yaml through
// Bun.YAML.parse against *Topologi* and *Environment per service*, the edge configuration (CSP, TLS, the one location
// that forwards /api/, the client address headers, the body limit, the traversal map, the header includes, the log
// format), REQUIRED_MIGRATION against the last migration, the production `optimization` object of AC-6, the lines that
// would push an image, the required strings of *Dokumen yang diperbarui*, and the name guards, `dockerArgs`,
// `expectedContext`, the log line types, and DEPLOYMENT_CHECKS.
// Expected values are written here from the tables of the spec, never read back from the code under test.

const root = resolve(import.meta.dir, '../../..');
const read = (path: string) => readFile(join(root, path), 'utf8');

// ---------------------------------------------------------------------------------------------------------------
// Dockerfiles (*Image*, *Image dasar*, AC-1).

type Instruction = { name: string; args: string };

/** Instructions of a Dockerfile per stage: comments dropped, continuation lines joined, split at every FROM. */
function stages(text: string): Instruction[][] {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  const result: Instruction[][] = [];
  for (const line of lines) {
    const space = line.search(/\s/);
    const instruction = { name: line.slice(0, space).toUpperCase(), args: line.slice(space + 1).trim() };
    if (instruction.name === 'FROM') result.push([]);
    result.at(-1)!.push(instruction);
  }
  return result;
}

const SECRET = /(PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|DATABASE_URL)/i;
const named = (stage: readonly Instruction[], name: string) => stage.filter((item) => item.name === name).map((item) => item.args);

test('DEP-001 the three Dockerfiles have the numeric USER, entrypoint, STOPSIGNAL, HEALTHCHECK, and ports of the Image table, without a secret ARG or ENV', async () => {
  const expected = {
    'apps/frontend/Dockerfile': {
      stages: 2, user: '101:101', entrypoint: '["/usr/local/bin/foundation-edge"]', cmd: [], stop: 'SIGQUIT', expose: ['8080 8443'],
      env: ['FOUNDATION_BACKEND_UPSTREAM=backend:8888'], title: 'foundation-frontend', healthcheck: false,
    },
    'apps/backend/Dockerfile': {
      stages: 2, user: '1000:1000', entrypoint: '["bun", "--no-env-file", "/app/backend.js"]', cmd: [], stop: 'SIGTERM', expose: ['8888'],
      env: ['NODE_ENV=production HOST=0.0.0.0 PORT=8888'], title: 'foundation-backend', healthcheck: true,
    },
    'database/Dockerfile': {
      stages: 1, user: '1000:1000', entrypoint: '["bun", "--no-env-file"]', cmd: ['["database/migrate.ts"]'], stop: 'SIGTERM', expose: [],
      env: [], title: 'foundation-migrate', healthcheck: false,
    },
  } as const;
  expect(IMAGES.map((image) => image.dockerfile)).toEqual(Object.keys(expected));
  for (const [path, want] of Object.entries(expected)) {
    const all = stages(await read(path));
    expect(all.length, path).toBe(want.stages);
    const last = all.at(-1)!;
    expect(named(last, 'USER'), path).toEqual([want.user]);
    expect(want.user).toMatch(/^[0-9]+:[0-9]+$/);
    expect(named(last, 'ENTRYPOINT'), path).toEqual([want.entrypoint]);
    expect(named(last, 'CMD'), path).toEqual([...want.cmd]);
    expect(named(last, 'STOPSIGNAL'), path).toEqual([want.stop]);
    expect(named(last, 'EXPOSE'), path).toEqual([...want.expose]);
    expect(named(last, 'ENV'), path).toEqual([...want.env]);
    // The title is the one fixed label; revision, source tree, and run come from `docker build --label` only.
    expect(named(last, 'LABEL'), path).toEqual([`org.opencontainers.image.title="${want.title}"`]);
    const healthchecks = named(last, 'HEALTHCHECK');
    expect(healthchecks.length, path).toBe(want.healthcheck ? 1 : 0);
    for (const stage of all) {
      // No ARG at all, so no credential can pass through the build; no ENV name of the secret pattern in any stage.
      expect(named(stage, 'ARG'), path).toEqual([]);
      for (const env of named(stage, 'ENV')) for (const pair of env.split(/\s+/)) expect(SECRET.test(pair.slice(0, pair.indexOf('='))), `${path} ${pair}`).toBe(false);
      for (const run of named(stage, 'RUN')) expect(run, path).not.toContain('--mount=type=secret');
    }
  }
  // Backend HEALTHCHECK: /health/live with AbortSignal.timeout(2000), exit 0 only for 200, 10 s, 5 s, 3, 10 s.
  const backendCheck = named(stages(await read('apps/backend/Dockerfile')).at(-1)!, 'HEALTHCHECK')[0]!.replace(/\s+/g, ' ');
  expect(backendCheck).toStartWith('--interval=10s --timeout=5s --retries=3 --start-period=10s CMD ["bun", "--no-env-file", "-e", ');
  for (const part of ['http://127.0.0.1:8888/health/live', 'AbortSignal.timeout(2000)', 'response.status === 200 ? 0 : 1']) expect(backendCheck).toContain(part);
});

test('DEP-001 the runner image copies database/ and libs/server/database/ as whole folders, and the backend bundle is built with whitespace and syntax minify only', async () => {
  const [runner] = stages(await read('database/Dockerfile'));
  expect(named(runner!, 'COPY')).toEqual(['database/ /app/database/', 'libs/server/database/ /app/libs/server/database/']);
  expect(named(runner!, 'WORKDIR')).toEqual(['/app']);
  const [build, final] = stages(await read('apps/backend/Dockerfile'));
  expect(named(build!, 'RUN')).toEqual([
    'bun install --frozen-lockfile --production',
    'bun build apps/backend/src/index.ts --target bun --minify-whitespace --minify-syntax --outfile /out/backend.js',
  ]);
  expect(named(final!, 'COPY')).toEqual(['--from=build /out/backend.js /app/backend.js']);
  const [frontendBuild, edge] = stages(await read('apps/frontend/Dockerfile'));
  expect(named(frontendBuild!, 'RUN')).toEqual(['bun install --frozen-lockfile', 'bun run build:frontend']);
  expect(named(edge!, 'COPY')).toEqual([
    '--from=build /app/apps/frontend/dist/frontend/browser/ /srv/frontend/',
    '--chmod=0444 apps/frontend/edge/nginx.conf /etc/nginx/nginx.conf',
    '--chmod=0444 apps/frontend/edge/document-headers.conf apps/frontend/edge/api-headers.conf /etc/nginx/foundation/',
    '--chmod=0555 apps/frontend/edge/foundation-edge.sh /usr/local/bin/foundation-edge',
  ]);
});

// *Daftar izin konteks build*, written from the spec table.
const ALLOWLIST: Record<string, { include: string[]; exclude: string[] }> = {
  'apps/frontend/Dockerfile.dockerignore': {
    include: [
      'package.json', 'bun.lock', 'apps/frontend/angular.json', 'apps/frontend/tsconfig.json', 'apps/frontend/tsconfig.app.json',
      'apps/frontend/tsconfig.spec.json', 'apps/frontend/.postcssrc.json', 'apps/frontend/src/', 'apps/frontend/public/', 'apps/frontend/sdk/',
      'apps/frontend/edge/',
    ],
    exclude: ['**/*.spec.ts', '**/*.test.ts'],
  },
  'apps/backend/Dockerfile.dockerignore': { include: ['package.json', 'bun.lock', 'apps/backend/src/', 'libs/server/'], exclude: ['**/*.spec.ts', '**/*.test.ts'] },
  'database/Dockerfile.dockerignore': { include: ['database/*.ts', 'database/migrations/', 'database/seeds/', 'libs/server/database/'], exclude: [] },
};
const ROOT_DENY = ['.env', '.env.*', '**/.env', '**/.env.*', '.git', 'node_modules', '**/node_modules', '.local', 'dist', '**/dist', '.angular', '**/.angular', 'graphify-out', 'test-results', '.claude'];
const rules = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));

test('DEP-001 every ignore file holds exactly the rules of its row: *, the paths brought back, the extra exclusions, then the two .env rules', async () => {
  for (const [path, row] of Object.entries(ALLOWLIST)) {
    expect(rules(await read(path)), path).toEqual(['*', ...row.include.map((item) => `!${item}`), ...row.exclude, '**/.env', '**/.env.*']);
  }
  // The orchestration derives the expected context from the same table.
  expect(JSON.parse(JSON.stringify(CONTEXT_ALLOWLIST))).toEqual(ALLOWLIST);
  expect(IMAGES.map((image) => `${image.dockerfile}.dockerignore`)).toEqual(Object.keys(ALLOWLIST));
  expect(rules(await read('.dockerignore'))).toEqual(ROOT_DENY);
});

test('DEP-001 expectedContext keeps only the paths an allow list row brings back, without the extra exclusions and any .env file', () => {
  const paths = [
    '.env', '.env.deploy', '.local/sentinel.txt', 'README.md', 'bun.lock', 'package.json',
    'apps/backend/.env', 'apps/backend/Dockerfile', 'apps/backend/src/.env.production', 'apps/backend/src/app.ts', 'apps/backend/src/app.test.ts',
    'apps/frontend/.env', 'apps/frontend/.postcssrc.json', 'apps/frontend/angular.json', 'apps/frontend/edge/.env.local', 'apps/frontend/edge/nginx.conf',
    'apps/frontend/src/.env', 'apps/frontend/src/app/app.spec.ts', 'apps/frontend/src/app/app.ts', 'apps/frontend/src/main.ts', 'apps/frontend/tsconfig.spec.json',
    'database/.env', 'database/Dockerfile', 'database/migrate.ts', 'database/migrations/.env', 'database/migrations/0001.sql', 'database/seeds/0001.sql',
    'database/tools/deep.ts', 'libs/server/.env', 'libs/server/database/pool.ts', 'libs/server/logger.ts',
  ];
  expect(expectedContext(paths, ALLOWLIST['apps/frontend/Dockerfile.dockerignore']!)).toEqual([
    'apps/frontend/.postcssrc.json', 'apps/frontend/angular.json', 'apps/frontend/edge/nginx.conf', 'apps/frontend/src/app/app.ts', 'apps/frontend/src/main.ts',
    'apps/frontend/tsconfig.spec.json', 'bun.lock', 'package.json',
  ]);
  expect(expectedContext(paths, ALLOWLIST['apps/backend/Dockerfile.dockerignore']!)).toEqual([
    'apps/backend/src/app.ts', 'bun.lock', 'libs/server/database/pool.ts', 'libs/server/logger.ts', 'package.json',
  ]);
  // `database/*.ts` stays within one folder, so database/tools/deep.ts and the Dockerfile stay out.
  expect(expectedContext(paths, ALLOWLIST['database/Dockerfile.dockerignore']!)).toEqual([
    'database/migrate.ts', 'database/migrations/0001.sql', 'database/seeds/0001.sql', 'libs/server/database/pool.ts',
  ]);
  // The pattern rules of an ignore file: ** spans folders, * and ? stay in one segment, and a parent folder matches.
  expect(ignorePattern('**/.env').test('.env') && ignorePattern('**/.env').test('a/b/.env') && !ignorePattern('**/.env').test('a/.envx')).toBe(true);
  expect(ignorePattern('**/.env.*').test('apps/frontend/edge/.env.local')).toBe(true);
  expect(ignorePattern('*').test('a/b')).toBe(false);
  expect(ignorePattern('database/?.ts').test('database/a.ts') && !ignorePattern('database/?.ts').test('database/ab.ts')).toBe(true);
  expect(ignoreMatches('apps/frontend/src/', 'apps/frontend/src/app/app.ts')).toBe(true);
  expect(ignoreMatches('apps/frontend/src/', 'apps/frontend/srcx/app.ts')).toBe(false);
});

test('DEP-001 every FROM and COPY --from is pinned by tag and digest, against engines and the Bun pin of tests/performance/images.json', async () => {
  const dockerfiles: Record<string, string> = {};
  for (const image of IMAGES) dockerfiles[image.dockerfile] = await read(image.dockerfile);
  const manifest = JSON.parse(await read('package.json')) as { engines: { node: string; bun: string } };
  const bunImages = JSON.parse(await read('tests/performance/images.json')) as { bun: { image: string } };
  const pins = checkPins(dockerfiles, manifest.engines, bunImages);
  expect(pins).toEqual({
    ok: true,
    bases: [
      `node:${manifest.engines.node}-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe`,
      bunImages.bun.image,
      'nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94',
    ],
  });
  expect(bunImages.bun.image).toBe(`oven/bun:${manifest.engines.bun}-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61`);
  for (const text of Object.values(dockerfiles)) for (const reference of dockerfileImages(text)) expect(reference).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9_.-]+@sha256:[0-9a-f]{64}$/);

  const frontend = 'apps/frontend/Dockerfile';
  const broken: [string, (text: string) => string][] = [
    ['a tag without digest', (text) => text.replace(/nginx:1\.30\.5-alpine@sha256:[0-9a-f]{64}/, 'nginx:1.30.5-alpine')],
    ['an odd nginx minor', (text) => text.replace('nginx:1.30.5-alpine', 'nginx:1.29.5-alpine')],
    ['nginx without alpine', (text) => text.replace('nginx:1.30.5-alpine', 'nginx:1.30.5')],
    ['a Node tag outside engines', (text) => text.replace(`node:${manifest.engines.node}-trixie-slim`, 'node:24.20.0-trixie-slim')],
    ['another Bun digest', (text) => text.replace(/oven\/bun:1\.4\.2-slim@sha256:[0-9a-f]{64}/, `oven/bun:1.4.2-slim@sha256:${'a'.repeat(64)}`)],
    ['an unpinned stage image', (text) => text.replace('COPY --from=oven/bun:', 'COPY --from=docker.io/oven/bun:')],
  ];
  for (const [label, change] of broken) {
    expect(checkPins({ ...dockerfiles, [frontend]: change(dockerfiles[frontend]!) }, manifest.engines, bunImages).ok, label).toBe(false);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// deploy/compose.yaml (*Topologi*, *Environment per service*, AC-8, AC-10).

type Service = Record<string, unknown>;
const LOGGING = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
const HEALTHY = { postgres: { condition: 'service_healthy' } };

/** Every row of *Topologi* plus *Environment per service*, as the YAML file writes it. */
const TOPOLOGY: Record<string, Service> = {
  edge: {
    image: '${FOUNDATION_FRONTEND_IMAGE:?}', networks: ['public', 'app'],
    ports: ['${FOUNDATION_EDGE_BIND:-0.0.0.0}:${FOUNDATION_EDGE_HTTPS_PORT:-443}:8443', '${FOUNDATION_EDGE_BIND:-0.0.0.0}:${FOUNDATION_EDGE_HTTP_PORT:-80}:8080'],
    secrets: ['edge_tls_cert', 'edge_tls_key'], cpus: 0.5, mem_limit: '128m', pids_limit: 128, read_only: true, tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=16m'],
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], restart: 'unless-stopped', stop_grace_period: '15s', logging: LOGGING,
  },
  backend: {
    image: '${FOUNDATION_BACKEND_IMAGE:?}', networks: ['app', 'data'], environment: { DATABASE_URL: '${FOUNDATION_BACKEND_DATABASE_URL:?}' },
    cpus: 1, mem_limit: '512m', pids_limit: 256, read_only: true, tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m'], cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'], restart: 'unless-stopped', stop_grace_period: '10s', depends_on: HEALTHY, logging: LOGGING,
  },
  postgres: {
    image: '${FOUNDATION_POSTGRES_IMAGE:-foundation-postgres:18-pinned}',
    command: ['-c', 'log_min_messages=log', '-c', 'log_min_error_statement=panic', '-c', 'log_error_verbosity=terse'], networks: ['data'],
    environment: { POSTGRES_DB: 'foundation', POSTGRES_USER: 'foundation_admin', POSTGRES_PASSWORD: '${FOUNDATION_POSTGRES_PASSWORD:?}' },
    volumes: ['pgsql_data:/var/lib/pgsql'], cpus: 2, mem_limit: '1g', shm_size: '128mb', pids_limit: 256, cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'], restart: 'unless-stopped', stop_grace_period: '30s',
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -p 5432 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'], interval: '5s', timeout: '3s', retries: 10, start_period: '10s' },
    logging: LOGGING,
  },
  migrate: {
    image: '${FOUNDATION_MIGRATE_IMAGE:?}', profiles: ['migrate'], networks: ['data'], environment: { FOUNDATION_MIGRATOR_DATABASE_URL: '${FOUNDATION_MIGRATOR_DATABASE_URL:?}' },
    cpus: 0.5, mem_limit: '256m', pids_limit: 128, read_only: true, tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=16m'], cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'], restart: 'no', stop_grace_period: '10s', depends_on: HEALTHY, logging: LOGGING,
  },
};

test('DEP-001 deploy/compose.yaml equals the Topologi and Environment per service tables: four services, three networks, images only by variable', async () => {
  const compose = Bun.YAML.parse(await read('deploy/compose.yaml')) as Record<string, any>;
  expect(Object.keys(compose)).toEqual(['name', 'services', 'networks', 'volumes', 'secrets']);
  expect(compose['name']).toBe('foundation-deploy');
  expect(compose['services']).toEqual(TOPOLOGY);
  for (const [name, service] of Object.entries(compose['services'] as Record<string, Service>)) {
    // No build key and no user override: the image is a variable and the user comes from the image.
    expect(Object.keys(service).filter((key) => key === 'build' || key === 'user' || key === 'privileged' || key === 'cap_add'), name).toEqual([]);
    expect(String(service['image']), name).toMatch(/^\$\{FOUNDATION_[A-Z_]+_IMAGE(:\?|:-foundation-postgres:18-pinned)\}$/);
  }
  // Only the edge publishes a port.
  expect(Object.entries(compose['services'] as Record<string, Service>).filter(([, service]) => 'ports' in service).map(([name]) => name)).toEqual(['edge']);
  expect(compose['networks']).toEqual({ public: {}, app: { internal: true }, data: { internal: true } });
  expect(compose['volumes']).toEqual({ pgsql_data: {} });
  expect(compose['secrets']).toEqual({ edge_tls_cert: { file: '${FOUNDATION_EDGE_TLS_CERT_FILE:?}' }, edge_tls_key: { file: '${FOUNDATION_EDGE_TLS_KEY_FILE:?}' } });
  // The PostgreSQL healthcheck is the one of the root docker-compose.yml.
  const rootCompose = Bun.YAML.parse(await read('docker-compose.yml')) as Record<string, any>;
  expect(TOPOLOGY['postgres']!['healthcheck']).toEqual(rootCompose['services']['postgres']['healthcheck']);
  // The test override only adds restart "no", pull_policy never, and the two run labels.
  const override = Bun.YAML.parse(await read('tests/integration/deployment/compose.test.yml')) as Record<string, any>;
  expect(override).toEqual({
    services: Object.fromEntries(Object.keys(TOPOLOGY).map((name) => [name, {
      restart: 'no', pull_policy: 'never', labels: { 'foundation.test': 'deployment', 'foundation.run': '${FOUNDATION_DEPLOY_RUN:?}' },
    }])),
  });
});

/** The YAML in the shape `compose config --no-interpolate --format json` writes it: long secret, volume, and file forms. */
function configShape(compose: Record<string, any>): Record<string, any> {
  const config = structuredClone(compose);
  for (const secret of Object.values(config['secrets'] as Record<string, { file: string }>)) secret.file = `/checkout/deploy/${secret.file}`;
  for (const service of Object.values(config['services'] as Record<string, Service>)) {
    if (Array.isArray(service['secrets'])) service['secrets'] = service['secrets'].map((name) => ({ source: name, target: `/run/secrets/${name}` }));
    if (Array.isArray(service['volumes'])) {
      service['volumes'] = service['volumes'].map((item: string) => ({ type: 'volume', source: item.split(':')[0], target: item.split(':')[1] }));
    }
  }
  return config;
}

test('DEP-001 declarationProblems accepts deploy/compose.yaml in the config shape and names each field a mutation breaks', async () => {
  const compose = Bun.YAML.parse(await read('deploy/compose.yaml')) as Record<string, any>;
  expect(declarationProblems(configShape(compose))).toEqual([]);
  const cases: [string, (config: Record<string, any>) => void, string][] = [
    ['a published backend port', (config) => void (config['services'].backend.ports = ['127.0.0.1:8888:8888']), 'backend: ports'],
    ['another pids limit', (config) => void (config['services'].edge.pids_limit = 256), 'edge: pids_limit'],
    ['a build key', (config) => void (config['services'].migrate.build = { context: '.' }), 'migrate: build'],
    ['a credential on the edge', (config) => void (config['services'].edge.environment = { DATABASE_URL: '${FOUNDATION_BACKEND_DATABASE_URL:?}' }), 'edge: environment'],
    ['the migrator DSN on the backend', (config) => void (config['services'].backend.environment.FOUNDATION_MIGRATOR_DATABASE_URL = '${FOUNDATION_MIGRATOR_DATABASE_URL:?}'), 'backend: environment'],
    ['another log size', (config) => void (config['services'].postgres.logging.options['max-size'] = '100m'), 'postgres: logging'],
    ['no log flags', (config) => void delete config['services'].postgres.command, 'postgres: command'],
    ['app not internal', (config) => void (config['networks'].app = {}), 'network app atau data tanpa internal: true'],
    ['a user override', (config) => void (config['services'].backend.user = '0:0'), 'backend: user'],
    ['writable root', (config) => void (config['services'].migrate.read_only = false), 'migrate: read_only'],
  ];
  for (const [label, mutate, problem] of cases) {
    const config = configShape(compose);
    mutate(config);
    expect(declarationProblems(config), label).toContain(problem);
  }
});

test('DEP-001 .env.deploy.example names every variable of Configuration required without a value', async () => {
  const lines = rules(await read('.env.deploy.example'));
  expect(lines).toEqual([
    'FOUNDATION_FRONTEND_IMAGE=', 'FOUNDATION_BACKEND_IMAGE=', 'FOUNDATION_MIGRATE_IMAGE=', 'FOUNDATION_POSTGRES_PASSWORD=',
    'FOUNDATION_BACKEND_DATABASE_URL=', 'FOUNDATION_MIGRATOR_DATABASE_URL=', 'FOUNDATION_EDGE_TLS_CERT_FILE=', 'FOUNDATION_EDGE_TLS_KEY_FILE=',
  ]);
  const text = await read('.env.deploy.example');
  for (const name of ['FOUNDATION_POSTGRES_IMAGE', 'FOUNDATION_EDGE_BIND', 'FOUNDATION_EDGE_HTTPS_PORT', 'FOUNDATION_EDGE_HTTP_PORT']) expect(text).toContain(`# ${name}=`);
  // The provisioning credentials stay in the operator shell only.
  for (const name of ['FOUNDATION_ADMIN_DATABASE_URL', 'FOUNDATION_MIGRATOR_PASSWORD', 'FOUNDATION_BACKEND_PASSWORD']) expect(text).not.toContain(`${name}=`);
  expect(rules(await read('.gitignore'))).toContain('!.env.deploy.example');
});

// ---------------------------------------------------------------------------------------------------------------
// The edge configuration (*Konfigurasi edge*, *Header dokumen*, *Header API*, AC-5, AC-6, AC-7, AC-10).

type Directive = { name: string; args: string[]; block: Directive[] | null };

/** nginx tokens: words, quoted strings with their quotes, braces, and semicolons; a `#` outside quotes starts a comment. */
function tokens(text: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) index += 1;
    else if (char === '#') index = text.includes('\n', index) ? text.indexOf('\n', index) : text.length;
    else if (char === '{' || char === '}' || char === ';') {
      found.push(char);
      index += 1;
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      found.push(text.slice(index, end + 1));
      index = end + 1;
    } else {
      let end = index;
      while (end < text.length && !/[\s{};]/.test(text[end]!)) end += 1;
      found.push(text.slice(index, end));
      index = end;
    }
  }
  return found;
}

function parseNginx(text: string): Directive[] {
  const list = tokens(text);
  let position = 0;
  const block = (): Directive[] => {
    const directives: Directive[] = [];
    while (position < list.length && list[position] !== '}') {
      const words: string[] = [];
      while (list[position] !== ';' && list[position] !== '{') words.push(list[position++]!);
      const directive: Directive = { name: words[0]!, args: words.slice(1), block: null };
      if (list[position++] === '{') {
        directive.block = block();
        position += 1;
      }
      directives.push(directive);
    }
    return directives;
  };
  return block();
}

const unquote = (value: string) => (/^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value);
const all = (directives: readonly Directive[]): Directive[] => directives.flatMap((item) => [item, ...all(item.block ?? [])]);
const only = (directives: readonly Directive[], name: string) => directives.filter((item) => item.name === name);
const value = (directives: readonly Directive[], name: string) => only(directives, name).map((item) => item.args.map(unquote).join(' '));

async function edgeConfig() {
  const nginx = parseNginx(await read('apps/frontend/edge/nginx.conf'));
  const http = only(nginx, 'http')[0]!.block!;
  const servers = only(http, 'server').map((item) => item.block!);
  const https = servers.find((server) => value(server, 'listen').includes('8443 ssl default_server'))!;
  const redirect = servers.find((server) => value(server, 'listen').includes('8080 default_server'))!;
  const locations = only(https, 'location');
  return { nginx, http, servers, https, redirect, locations };
}

test('DEP-001 the edge processes, TLS listener, redirect listener, and limits follow Konfigurasi edge', async () => {
  const { nginx, http, servers, https, redirect } = await edgeConfig();
  expect(value(nginx, 'worker_processes')).toEqual(['1']);
  expect(value(nginx, 'pid')).toEqual(['/tmp/nginx/nginx.pid']);
  expect(value(nginx, 'error_log')).toEqual(['stderr crit']);
  expect(value(only(nginx, 'events')[0]!.block!, 'worker_connections')).toEqual(['1024']);
  expect(value(http, 'include')).toEqual(['/etc/nginx/mime.types']);
  expect(value(http, 'default_type')).toEqual(['application/octet-stream']);
  expect(value(http, 'server_tokens')).toEqual(['off']);
  for (const name of ['client_body_temp_path', 'proxy_temp_path', 'fastcgi_temp_path', 'uwsgi_temp_path', 'scgi_temp_path']) expect(value(http, name)[0], name).toStartWith('/tmp/nginx/');
  const limits: Record<string, string> = {
    client_max_body_size: '1k', client_header_timeout: '10s', client_body_timeout: '10s', send_timeout: '10s', keepalive_timeout: '15s',
    large_client_header_buffers: '4 8k', proxy_connect_timeout: '3s', proxy_send_timeout: '10s', proxy_read_timeout: '10s',
  };
  for (const [name, wanted] of Object.entries(limits)) expect(value(http, name), name).toEqual([wanted]);
  // The body limit of the edge and of the backend change together (key invariant 10).
  expect(await read('apps/backend/src/index.ts')).toContain('maxRequestBodySize: 1024');
  expect(BODY_LIMIT_BYTES).toBe(1024);
  expect(value(http, 'client_max_body_size')).toEqual([`${BODY_LIMIT_BYTES / 1024}k`]);

  expect(servers).toHaveLength(2);
  expect(value(redirect, 'return')).toEqual(['308 https://$host$request_uri']);
  // The 308 reflects the client Host until server_name exists, so it is never stored by a cache (decision 67).
  expect(value(redirect, 'add_header')).toEqual(['Cache-Control no-store always']);
  expect(redirect.map((item) => item.name).sort()).toEqual(['add_header', 'listen', 'return']);
  expect(value(https, 'http2')).toEqual(['on']);
  expect(value(https, 'ssl_certificate')).toEqual(['/run/secrets/edge_tls_cert']);
  expect(value(https, 'ssl_certificate_key')).toEqual(['/run/secrets/edge_tls_key']);
  expect(value(https, 'ssl_protocols')).toEqual(['TLSv1.2 TLSv1.3']);
  const ciphers = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305';
  expect(value(https, 'ssl_ciphers')).toEqual([ciphers]);
  expect(TLS12_CIPHERS.join(':')).toBe(ciphers);
  expect(value(https, 'ssl_prefer_server_ciphers')).toEqual(['off']);
  expect(value(https, 'ssl_session_tickets')).toEqual(['off']);
  expect(value(https, 'ssl_session_cache')).toEqual(['shared:TLS:10m']);
  expect(value(https, 'ssl_session_timeout')).toEqual(['1d']);
  expect(value(https, 'root')).toEqual(['/srv/frontend']);
  // The upstream group: one zone and the file foundation-edge writes; HTTP/1.1 without Connection to the backend.
  expect(only(http, 'upstream').map((item) => [item.args, item.block!.map((entry) => `${entry.name} ${entry.args.join(' ')}`)])).toEqual([
    [['backend'], ['zone backend 64k', 'include /tmp/nginx/upstream.conf']],
  ]);
});

test('DEP-001 only location ^~ /api/ forwards to the backend, with no regex location for /api, every client address header emptied, and the traversal map over $foundation_path only', async () => {
  const { http, https, locations } = await edgeConfig();
  const api = locations.filter((item) => item.args.at(-1)?.replace(/^"|"$/g, '').match(/^\^?\/api/) !== null);
  // `location = /api` (decision 48) serves index.html; `^~ /api/` is the only location that reaches the backend.
  expect(api.map((item) => item.args.join(' '))).toEqual(['^~ /api/', '= /api']);
  const regex = locations.filter((item) => item.args[0] === '~' || item.args[0] === '~*');
  for (const item of regex) expect(unquote(item.args[1]!), item.args.join(' ')).not.toMatch(/^\^?\\?\/api/);
  const forwarding = all(https).filter((item) => item.block?.some((entry) => entry.name === 'proxy_pass'));
  expect(forwarding.map((item) => item.args.join(' '))).toEqual(['^~ /api/']);
  const block = forwarding[0]!.block!;
  expect(value(block, 'proxy_pass')).toEqual(['http://backend']);
  expect(value(block, 'proxy_http_version')).toEqual(['1.1']);
  expect(value(block, 'proxy_hide_header')).toEqual(['X-Request-Id']);
  const headers = only(block, 'proxy_set_header').map((item) => [item.args[0], item.args[1]]);
  const clientAddress = [
    'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-Port', 'X-Forwarded-Prefix', 'X-Original-Forwarded-For', 'X-Real-IP',
    'X-Client-IP', 'True-Client-IP', 'CF-Connecting-IP', 'Fastly-Client-IP', 'X-Cluster-Client-IP', 'Forwarded',
  ];
  expect([...CLIENT_ADDRESS_HEADERS]).toEqual(clientAddress);
  expect(headers).toEqual([['Connection', '""'], ['Host', '$host'], ['X-Request-Id', '$request_id'], ...clientAddress.map((name) => [name, '""'])]);
  expect(only(block, 'if').map((item) => [item.args.join(' '), value(item.block!, 'return')])).toEqual([['($foundation_bad_path)', ['400']]]);
  expect(value(block, 'error_page')).toEqual(['400 @api_bad_request', '413 @api_payload_too_large', '502 @api_bad_gateway', '504 @api_gateway_timeout']);

  // The path part of $request_uri, and the traversal rule of AC-7 over that path only, never the query. The third map
  // (the status of the access log, decision 57) is checked with the log format.
  const maps = only(http, 'map');
  expect(maps.map((item) => item.args.join(' '))).toEqual(['$request_uri $foundation_path', '$foundation_path $foundation_bad_path', '$status $foundation_status', '$status $foundation_asset_cache']);
  expect(maps[0]!.block!.map((item) => [item.name, ...item.args])).toEqual([['"~^(?<p>[^?]*)"', '$p']]);
  expect(maps[1]!.block!.map((item) => [unquote(item.name), ...item.args])).toEqual([
    ['default', '0'], ['~(^|/)\\.\\.?(/|$)', '1'], ['~*%2e', '1'], ['~*%2f', '1'], ['~*%5c', '1'], ['~\\\\\\\\', '1'],
  ]);
  // The four named locations answer JSON with Cache-Control no-store and the API headers.
  const named = locations.filter((item) => item.args[0]?.startsWith('@'));
  expect(named.map((item) => [item.args[0], value(item.block!, 'return')[0]])).toEqual([
    ['@api_bad_request', '400 {"error":"Invalid request"}'],
    ['@api_payload_too_large', '413 {"error":"Payload too large"}'],
    ['@api_bad_gateway', '502 {"error":"Bad gateway"}'],
    ['@api_gateway_timeout', '504 {"error":"Gateway timeout"}'],
  ]);
  for (const item of named) {
    expect(value(item.block!, 'default_type'), item.args[0]).toEqual(['application/json']);
    expect(value(item.block!, 'add_header'), item.args[0]).toEqual(['Cache-Control no-store always']);
    expect(value(item.block!, 'include'), item.args[0]).toEqual(['/etc/nginx/foundation/api-headers.conf']);
  }
});

test('DEP-001 the header includes sit on the server level and on every location with its own add_header, with the CSP of the orchestration and always on every header', async () => {
  const { http, https, locations } = await edgeConfig();
  expect(value(https, 'include')).toEqual(['/etc/nginx/foundation/document-headers.conf']);
  for (const item of locations) {
    const block = item.block!;
    const includes = value(block, 'include');
    const label = item.args.join(' ');
    if (item.args.join(' ') === '^~ /api/' || item.args[0]?.startsWith('@')) expect(includes, label).toEqual(['/etc/nginx/foundation/api-headers.conf']);
    else expect(includes, label).toEqual(['/etc/nginx/foundation/document-headers.conf']);
  }
  // *Cache dan fallback*.
  const cache = locations.filter((item) => !item.args[0]?.startsWith('@') && item.args.join(' ') !== '^~ /api/').map((item) => [item.args.map(unquote).join(' '), value(item.block!, 'add_header'), value(item.block!, 'try_files')]);
  // *Cache dan fallback* row 1 (decision 68): only an existing hashed asset (200, 206, or the 304 that revalidates it) is
  // immutable for a year; the 404 of a hashed name that does not exist, and every other status, is no-cache.
  const assetCache = only(http, 'map').find((item) => item.args.join(' ') === '$status $foundation_asset_cache')!;
  expect(assetCache.block!.map((item) => [unquote(item.name), ...item.args.map(unquote)])).toEqual([
    ['default', 'no-cache'], ['200', IMMUTABLE_CACHE], ['206', IMMUTABLE_CACHE], ['304', IMMUTABLE_CACHE],
  ]);
  expect(cache).toEqual([
    ['~ ^/(main|chunk|styles|polyfills)-[A-Za-z0-9_-]{8}\\.(js|css)$', ['Cache-Control $foundation_asset_cache always'], ['$uri =404']],
    ['~ \\.[A-Za-z0-9]+$', ['Cache-Control no-cache always'], ['$uri =404']],
    ['= /api', ['Cache-Control no-cache always'], ['$uri /index.html']],
    ['/', ['Cache-Control no-cache always'], ['$uri /index.html']],
  ]);

  const documentHeaders = parseNginx(await read('apps/frontend/edge/document-headers.conf'));
  expect(documentHeaders.map((item) => [item.name, item.args[0], unquote(item.args[1]!), item.args[2]])).toEqual([
    ['add_header', 'Content-Security-Policy', CONTENT_SECURITY_POLICY, 'always'],
    ['add_header', 'Strict-Transport-Security', 'max-age=31536000', 'always'],
    ['add_header', 'X-Content-Type-Options', 'nosniff', 'always'],
    ['add_header', 'Referrer-Policy', 'no-referrer', 'always'],
    ['add_header', 'X-Frame-Options', 'DENY', 'always'],
    ['add_header', 'Cross-Origin-Opener-Policy', 'same-origin', 'always'],
    ['add_header', 'Cross-Origin-Resource-Policy', 'same-origin', 'always'],
    ['add_header', 'Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', 'always'],
    ['add_header', 'X-Request-Id', '$request_id', 'always'],
  ]);
  // The value of the *Header dokumen* table, with exactly the three Trusted Types policies.
  expect(CONTENT_SECURITY_POLICY).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types angular angular#bundler angular#components",
  );
  const apiHeaders = parseNginx(await read('apps/frontend/edge/api-headers.conf'));
  expect(apiHeaders.map((item) => [item.name, item.args[0], unquote(item.args[1]!), item.args[2]])).toEqual([
    ['add_header', 'Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'", 'always'],
    ['add_header', 'Strict-Transport-Security', 'max-age=31536000', 'always'],
    ['add_header', 'X-Content-Type-Options', 'nosniff', 'always'],
    ['add_header', 'Referrer-Policy', 'no-referrer', 'always'],
    ['add_header', 'Cross-Origin-Resource-Policy', 'same-origin', 'always'],
    ['add_header', 'X-Request-Id', '$request_id', 'always'],
  ]);
  // Every add_header of the three files carries always, and no CORS header exists anywhere.
  for (const path of ['apps/frontend/edge/nginx.conf', 'apps/frontend/edge/document-headers.conf', 'apps/frontend/edge/api-headers.conf']) {
    const text = await read(path);
    for (const item of all(parseNginx(text)).filter((entry) => entry.name === 'add_header')) expect(item.args.at(-1), `${path} ${item.args[0]}`).toBe('always');
    expect(text.toLowerCase(), path).not.toContain('access-control-');
  }
});

test('DEP-001 the access log is one JSON object with the keys and types of AC-10, without client address, user agent, query, cookie, or authorization', async () => {
  const { http } = await edgeConfig();
  expect(value(http, 'access_log')).toEqual(['/dev/stdout foundation']);
  const formats = only(http, 'log_format');
  expect(formats.map((item) => item.args.slice(0, 2))).toEqual([['foundation', 'escape=json']]);
  const format = unquote(formats[0]!.args[2]!);
  // Strings are quoted and the three numbers are not, so a parsed line has the types of AC-10. The status comes from
  // $status through the map $foundation_status (decision 57).
  expect(format).toBe(
    '{"time":"$time_iso8601","requestId":"$request_id","method":"$request_method","path":"$foundation_path","status":$foundation_status,"bytes":$body_bytes_sent,"requestTime":$request_time,"upstreamStatus":"$upstream_status","upstreamTime":"$upstream_response_time"}',
  );
  // nginx writes $status with three digits, so a request it ended without an answer (an HTTP/2 stream with a header
  // above large_client_header_buffers) has 000, and a bare 000 is not JSON. The map drops the leading zeros: the line
  // with 000 still parses, with the integer 0, and every other status keeps its value.
  const statusMap = only(http, 'map').find((item) => item.args.join(' ') === '$status $foundation_status');
  const entries = statusMap!.block!.map((item) => [unquote(item.name), ...item.args]);
  expect(entries).toEqual([['~^0*(?<foundation_status_digits>[0-9]+)$', '$foundation_status_digits'], ['default', '0']]);
  const pattern = new RegExp(entries[0]![0]!.slice(1));
  const mapped = (status: string) => pattern.exec(status)?.groups?.['foundation_status_digits'] ?? '0';
  for (const [status, expected] of [['000', 0], ['200', 200], ['404', 404], ['413', 413], ['499', 499], ['502', 502], ['099', 99]] as const) {
    const sample = format
      .replace('$time_iso8601', '2026-10-05T10:00:00+00:00').replace('$request_id', 'a'.repeat(32)).replace('$request_method', 'GET')
      .replace('$foundation_path', '/').replace('$foundation_status', mapped(status)).replace('$body_bytes_sent', '0').replace('$request_time', '0.000')
      .replace('$upstream_status', '').replace('$upstream_response_time', '');
    expect(parseEdgeLogLine(sample)?.status, status).toBe(expected);
    expect(edgeLogLineProblem(sample), status).toBeNull();
  }
  // The raw format with $status would not parse for 000: the reason for the map.
  expect(() => JSON.parse(format.replace('$foundation_status', '000').replace(/\$[a-z_0-9]+/g, '0'))).toThrow();
  const variables = [...format.matchAll(/\$([a-z_0-9]+)/g)].map((match) => match[1]);
  for (const forbidden of ['remote_addr', 'binary_remote_addr', 'http_user_agent', 'http_referer', 'args', 'query_string', 'request_uri', 'request', 'http_cookie', 'http_authorization', 'http_x_forwarded_for', 'realip_remote_addr', 'request_body']) {
    expect(variables, forbidden).not.toContain(forbidden);
  }
  for (const variable of variables) expect(variable).not.toMatch(/^(cookie_|arg_|http_)/);
  // A line written with sample values parses with the AC-10 types.
  const line = format
    .replace('$time_iso8601', '2026-10-05T10:00:00+00:00').replace('$request_id', 'a'.repeat(32)).replace('$request_method', 'GET')
    .replace('$foundation_path', '/api/status').replace('$foundation_status', '404').replace('$body_bytes_sent', '21').replace('$request_time', '0.003')
    .replace('$upstream_status', '404').replace('$upstream_response_time', '0.002');
  expect(parseEdgeLogLine(line)).toEqual({ time: '2026-10-05T10:00:00+00:00', requestId: 'a'.repeat(32), method: 'GET', path: '/api/status', status: 404, bytes: 21, requestTime: 0.003, upstreamStatus: '404', upstreamTime: '0.002' });
  expect(edgeLogLineProblem(line)).toBeNull();
});

test('DEP-001 requestedOriginsProblems accepts DEP-006 JUnit only when both testcases keep their requested font origins in system-out and as a file attachment', () => {
  // The shape of the Playwright 1.63.0 JUnit reporter: stdout first, then one line per attachment with a path.
  const testcase = (title: string, out: string) =>
    `<testcase name="${title}" classname="deployment/edge.deployment.e2e.spec.ts" time="1.2">\n<system-out>\n<![CDATA[${out}]]>\n</system-out>\n</testcase>`;
  const attachment = (dir: string) => `\n[[ATTACHMENT|test-results/${dir}/attachments/requested-origins-0a1b2c.json]]\n\n[[ATTACHMENT|test-results/${dir}/test-finished-1.png]]\n`;
  const good = (origins: string) => `requested-origins ${origins}\n${attachment('a')}`;
  const junit = (first: string, second: string) =>
    `<testsuites>\n<testsuite name="deployment/edge.deployment.e2e.spec.ts">\n${testcase('DEP-006 edge at 1280×812: one', first)}\n${testcase('DEP-006 edge at 375×812: two', second)}\n</testsuite>\n</testsuites>`;
  expect(requestedOriginsProblems(junit(good('["https://fonts.googleapis.com"]'), good('["https://fonts.googleapis.com","https://fonts.gstatic.com"]')))).toEqual([]);
  // No font request at all is still evidence: an empty list.
  expect(requestedOriginsProblems(junit(good('[]'), good('[]')))).toEqual([]);
  // The body only attachment of the first build: the reporter kept just the screenshot.
  const screenshotOnly = '\n[[ATTACHMENT|test-results/a/test-finished-1.png]]\n';
  expect(requestedOriginsProblems(junit(screenshotOnly, screenshotOnly))).toHaveLength(4);
  expect(requestedOriginsProblems(junit(good('["https://cdn.example.com"]'), good('[]')))).toEqual(['DEP-006 edge at 1280×812: one: origin selain font Google diminta']);
  expect(requestedOriginsProblems(junit(`requested-origins ["https://fonts.googleapis.com"]\n\n[[ATTACHMENT|test-results/a/test-finished-1.png]]\n`, good('[]')))).toEqual(['DEP-006 edge at 1280×812: one: lampiran requested-origins tidak ada']);
  expect(requestedOriginsProblems(junit(good('not json'), good('[]')))).toEqual(['DEP-006 edge at 1280×812: one: baris requested-origins tidak ada atau tidak sah']);
  expect(requestedOriginsProblems(`<testsuites>${testcase('DEP-006 edge at 1280×812: one', good('[]'))}</testsuites>`)).toEqual(['1 testcase DEP-006, diharapkan 2']);
});

test('DEP-001 edgeLogLineProblem and parseBackendLogLine accept only the exact keys and types of the two log tables', () => {
  const edge = { time: '2026-10-05T10:00:00+00:00', requestId: 'b'.repeat(32), method: 'GET', path: '/', status: 200, bytes: 512, requestTime: 0, upstreamStatus: '', upstreamTime: '' };
  expect(edgeLogLineProblem(JSON.stringify(edge))).toBeNull();
  const edgeCases: [string, Record<string, unknown>][] = [
    ['status as text', { ...edge, status: '200' }],
    ['requestTime as text', { ...edge, requestTime: '0.000' }],
    ['bytes as a fraction', { ...edge, bytes: 1.5 }],
    ['an extra key', { ...edge, remoteAddr: '127.0.0.1' }],
    ['a missing key', Object.fromEntries(Object.entries(edge).filter(([key]) => key !== 'upstreamTime'))],
    ['a query in the path', { ...edge, path: '/api/status?token=x' }],
    ['a request id of another form', { ...edge, requestId: 'not-hex' }],
    ['one empty upstream field', { ...edge, upstreamStatus: '502' }],
  ];
  for (const [label, line] of edgeCases) expect(edgeLogLineProblem(JSON.stringify(line)), label).not.toBeNull();
  expect(edgeLogLineProblem('GET / 200')).not.toBeNull();

  const request = { time: '2026-10-05T10:00:00.000Z', level: 'info', event: 'request', requestId: 'c'.repeat(32), method: 'GET', path: '/api/status', status: 404, durationMs: 1 };
  expect(parseBackendLogLine(JSON.stringify(request)) as unknown).toEqual(request);
  expect(parseBackendLogLine(JSON.stringify({ ...request, status: 502, level: 'error' }))).not.toBeNull();
  const backendCases: [string, Record<string, unknown>][] = [
    ['error below 500', { ...request, level: 'error' }],
    ['info from 500', { ...request, status: 500 }],
    ['a query in the path', { ...request, path: '/api/status?x=1' }],
    ['a path longer than 200', { ...request, path: `/${'a'.repeat(200)}` }],
    ['another method', { ...request, method: 'TRACE' }],
    ['an extra key', { ...request, ip: '10.0.0.1' }],
    ['a time that is not ISO', { ...request, time: 'today' }],
    ['a fractional duration', { ...request, durationMs: 1.5 }],
  ];
  for (const [label, line] of backendCases) expect(parseBackendLogLine(JSON.stringify(line)), label).toBeNull();
  expect(parseBackendLogLine(JSON.stringify({ time: request.time, level: 'info', event: 'listening' }))).not.toBeNull();
  expect(parseBackendLogLine(JSON.stringify({ time: request.time, level: 'error', event: 'startup_failed' }))).not.toBeNull();
  expect(parseBackendLogLine(JSON.stringify({ time: request.time, level: 'info', event: 'startup_failed' }))).toBeNull();
  expect(parseBackendLogLine(JSON.stringify({ time: request.time, level: 'info', event: 'listening', port: 8888 }))).toBeNull();
});

test('DEP-001 the entrypoint foundation-edge checks the upstream and the nameserver, writes upstream.conf, and execs nginx in the foreground', async () => {
  const script = await read('apps/frontend/edge/foundation-edge.sh');
  expect(script.split('\n')[0]).toBe('#!/bin/sh');
  expect(script).toContain("grep -Eqx '[a-z0-9]([a-z0-9.-]*[a-z0-9])?:[0-9]{1,5}'");
  expect(script).toContain("awk '$1 == \"nameserver\" { print $2; exit }' /etc/resolv.conf");
  expect(script).toContain("echo 'Edge configuration invalid' >&2");
  expect(script).toContain("printf 'resolver %s valid=10s ipv6=off;\\nserver %s resolve;\\n' \"$resolver\" \"$upstream\" > /tmp/nginx/upstream.conf");
  expect(script).toContain('mkdir -p -m 0700 /tmp/nginx');
  expect(script.trimEnd().split('\n').at(-1)).toBe("exec nginx -e stderr -g 'daemon off;'");
});

// foundation-edge as a real process (row `foundation-edge` of *Konfigurasi edge*, AC-8): `/bin/sh` runs the file itself
// with fake `awk`, `mkdir`, and `nginx` first on PATH, in a mkdtemp folder. The fake `awk` stands for the nameserver
// line of /etc/resolv.conf; the fake `mkdir` records its call and fails, so no run ever creates /tmp/nginx on the host,
// and a value that passes both checks shows up as that call. The real `grep` does the matching.
type EdgeRun = { code: number; stdout: string; stderr: string; calls: string[] };
const EDGE_ENTRYPOINT = join(root, 'apps/frontend/edge/foundation-edge.sh');
const EDGE_FAKES: Record<string, string> = {
  awk: 'echo "awk $*" >> "$FOUNDATION_TEST_CALLS"\nprintf \'%s\' "$FOUNDATION_TEST_NAMESERVER"\nexit "${FOUNDATION_TEST_AWK_EXIT:-0}"\n',
  mkdir: 'echo "mkdir $*" >> "$FOUNDATION_TEST_CALLS"\nexit 1\n',
  nginx: 'echo "nginx $*" >> "$FOUNDATION_TEST_CALLS"\nexit 0\n',
};

async function withEdgeFakes(use: (run: (env: Record<string, string>) => Promise<EdgeRun>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'foundation-edge-entrypoint-'));
  try {
    for (const [name, body] of Object.entries(EDGE_FAKES)) {
      await writeFile(join(dir, name), `#!/bin/sh\n${body}`);
      await chmod(join(dir, name), 0o755);
    }
    let runs = 0;
    await use(async (env) => {
      runs += 1;
      const calls = join(dir, `calls-${runs}.txt`);
      const child = Bun.spawn(['/bin/sh', EDGE_ENTRYPOINT], {
        env: { PATH: `${dir}:${process.env['PATH'] ?? ''}`, FOUNDATION_TEST_CALLS: calls, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const recorded = await readFile(calls, 'utf8').catch(() => '');
      return { code, stdout, stderr, calls: recorded.split('\n').filter((line) => line !== '') };
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const startedNginx = (run: EdgeRun) => run.calls.filter((call) => call.startsWith('nginx'));
const madeFolder = (run: EdgeRun) => run.calls.filter((call) => call.startsWith('mkdir'));

test('DEP-001 foundation-edge refuses an invalid upstream or nameserver with exactly Edge configuration invalid on stderr and exit 1, without nginx', async () => {
  await withEdgeFakes(async (run) => {
    const expectRefused = (result: EdgeRun, label: string) => {
      expect([result.code, result.stdout, result.stderr], label).toEqual([1, '', 'Edge configuration invalid\n']);
      expect(madeFolder(result), label).toEqual([]);
      expect(startedNginx(result), label).toEqual([]);
    };
    // The pattern of the row is ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?:[0-9]{1,5}$; a line break would let a second line of
    // upstream.conf through, so it is refused before grep reads the value line by line.
    const upstreams: (string | undefined)[] = [
      undefined, '', 'backend', 'backend:', ':8888', 'Backend:8888', 'backend:8888\n', 'backend:8888\nserver evil.example:1',
      'backend:8888;', 'backend:8888 resolve', '-backend:8888', 'backend-:8888', 'backend:123456', 'http://backend:8888', 'back_end:8888',
    ];
    for (const upstream of upstreams) {
      const env: Record<string, string> = { FOUNDATION_TEST_NAMESERVER: '127.0.0.11' };
      if (upstream !== undefined) env['FOUNDATION_BACKEND_UPSTREAM'] = upstream;
      expectRefused(await run(env), `upstream ${JSON.stringify(upstream)}`);
    }
    // The first nameserver must be an IPv4 address or an IPv6 address; anything else, two lines, or an awk that fails is
    // refused before the resolver line is written.
    const nameservers: [label: string, output: string, awkExit: string][] = [
      ['no nameserver line', '', '0'],
      ['a host name', 'dns.example', '0'],
      ['five parts', '1.2.3.4.5', '0'],
      ['two lines', '127.0.0.11\n8.8.8.8', '0'],
      ['an IPv6 zone index', 'fe80::1%eth0', '0'],
      ['an unreadable resolv.conf', '', '2'],
    ];
    for (const [label, output, awkExit] of nameservers) {
      const result = await run({ FOUNDATION_BACKEND_UPSTREAM: 'backend:8888', FOUNDATION_TEST_NAMESERVER: output, FOUNDATION_TEST_AWK_EXIT: awkExit });
      expectRefused(result, `nameserver ${label}`);
      expect(result.calls.filter((call) => call.startsWith('awk ')), `nameserver ${label}`).toHaveLength(1);
    }
  });
});

test('DEP-001 foundation-edge lets a valid upstream with an IPv4 or IPv6 nameserver through to the /tmp/nginx step, and a failure there still ends with the fixed message and no nginx', async () => {
  await withEdgeFakes(async (run) => {
    for (const upstream of ['backend:8888', 'b:1', 'foundation-backend.internal:65535', '10.0.0.2:8888']) {
      for (const nameserver of ['127.0.0.11', 'fd00::1']) {
        const label = `${upstream} with ${nameserver}`;
        const result = await run({ FOUNDATION_BACKEND_UPSTREAM: upstream, FOUNDATION_TEST_NAMESERVER: nameserver });
        expect(madeFolder(result), label).toEqual(['mkdir -p -m 0700 /tmp/nginx']);
        expect(startedNginx(result), label).toEqual([]);
        expect([result.code, result.stdout, result.stderr], label).toEqual([1, '', 'Edge configuration invalid\n']);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// REQUIRED_MIGRATION, the production build options, and the lines that would push an image.

test('DEP-001 REQUIRED_MIGRATION is the last file of database/migrations, so a new migration must move it in the same commit', async () => {
  const files = (await readdir(join(root, 'database/migrations'))).filter((name) => name.endsWith('.sql')).sort();
  expect(files.length).toBeGreaterThan(0);
  expect(REQUIRED_MIGRATION).toBe(files.at(-1)!);
});

test('DEP-001 the production configuration of angular.json holds the complete optimization object of AC-6', async () => {
  const angular = JSON.parse(await read('apps/frontend/angular.json')) as { projects: Record<string, any> };
  const projects = Object.values(angular.projects);
  expect(projects).toHaveLength(1);
  const production = projects[0].architect.build.configurations.production;
  expect(production.optimization).toStrictEqual({
    scripts: true,
    styles: { minify: true, inlineCritical: false, removeSpecialComments: true },
    fonts: { inline: false },
  });
});

/** Every file below a repository folder, as repository paths. */
async function filesBelow(folder: string): Promise<string[]> {
  const entries = await readdir(join(root, folder), { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => `${join(entry.parentPath, entry.name).slice(root.length + 1)}`).sort();
}

const PUSH_LINE = /\bdocker (image )?(push|login|tag)\b/;

test('DEP-001 no line of deploy/, .github/workflows/, README.md, or docs/rules/deployment.md would log in, tag, or push an image', async () => {
  const candidates = [...(await filesBelow('deploy')), ...(await filesBelow('.github/workflows')), 'README.md', 'docs/rules/deployment.md'];
  const checked: string[] = [];
  for (const path of candidates) {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) continue;
    checked.push(path);
    const lines = (await file.text()).split('\n');
    expect(lines.filter((line) => PUSH_LINE.test(line)), path).toEqual([]);
  }
  expect(checked).toContain('deploy/compose.yaml');
  expect(checked).toContain('README.md');
  // Build plan step 5 wrote the deployment rules, so the file must exist and is always checked (decision 54).
  expect(checked).toContain('docs/rules/deployment.md');
  expect(checked.filter((path) => path.startsWith('.github/workflows/')).length).toBeGreaterThan(0);
  // The pattern itself catches the forms it names.
  for (const line of ['docker push foundation-backend:1', 'docker image push x', 'docker login ghcr.io', 'docker tag a b', 'run: docker image tag a b']) expect(PUSH_LINE.test(line), line).toBe(true);
  for (const line of ['docker pull nginx', 'docker image inspect x', 'docker buildx imagetools inspect x', 'docker compose up']) expect(PUSH_LINE.test(line), line).toBe(false);
});

/** *Dokumen yang diperbarui* (spec 0012): the strings each document must hold, written here from the table. */
const DOCUMENT_STRINGS: Readonly<Record<string, readonly string[]>> = {
  'docs/rules/deployment.md': [
    'docker build -f apps/frontend/Dockerfile',
    'docker build -f apps/backend/Dockerfile',
    'docker build -f database/Dockerfile',
    '--profile migrate run --rm migrate database/migrate.ts --apply',
    'database/provision.ts --apply',
    '/health/live',
    '/health/ready',
    '30 hari',
    'max-size',
    'gh run download',
    'application-evidence',
    'real-evidence',
    'security-evidence',
    'capacity-evidence',
    'bun run test:report:release',
    'bukan izin deploy',
    'ALTER ROLE',
    '--force-recreate --no-deps edge',
    '0640',
    'port 443',
    'buildx imagetools inspect',
  ],
  'docs/rules/testing.md': ['test:deployment:plan', 'test:deployment:real', 'test:report:release', '.local/feature-13/release.json'],
  'docs/testing/release-report-template.md': ['bun run test:report:release', '.local/feature-13/release.md', 'grantsDeployment'],
  'docs/rules/security.md': ['docs/rules/deployment.md', 'Content-Security-Policy'],
  'docs/rules/infrastructure.md': ['deploy/compose.yaml'],
  'docs/rules/elysia.md': ['/health/live', '/health/ready'],
  'README.md': ['docs/rules/deployment.md', 'test:report:release'],
};

test('DEP-001 the documents of Dokumen yang diperbarui hold every required string, and the artifact downloads follow the bundle folders', async () => {
  const missing: string[] = [];
  for (const [path, strings] of Object.entries(DOCUMENT_STRINGS)) {
    const text = await read(path);
    for (const value of strings) if (!text.includes(value)) missing.push(`${path}: ${value}`);
  }
  expect(missing).toEqual([]);
  // The release status procedure downloads each per push artifact into its own bundle folder, and the capacity
  // artifact into .local because its content is rooted there (*Dokumen yang diperbarui*, paragraph below the table).
  const rules = await read('docs/rules/deployment.md');
  for (const [artifact, folder] of [
    ['application-evidence', '.local/feature-11/evidence/fast'],
    ['real-evidence', '.local/feature-11/evidence/real'],
    ['security-evidence', '.local/feature-11/evidence/security'],
  ] as const) {
    expect(rules, artifact).toMatch(new RegExp(`gh run download (<[^>\\n]+>|\\S+) -n ${artifact} -D ${folder.replaceAll('.', '\\.')}(\\s|$)`, 'm'));
  }
  expect(rules).toMatch(/gh run download (<[^>\n]+>|\S+) -n capacity-evidence -D \.local(\s|$)/m);
  expect(rules).toContain('bun install --frozen-lockfile');
});

// ---------------------------------------------------------------------------------------------------------------
// Pure functions of the orchestration (AC-11, AC-8, AC-9).

test('DEP-001 the project and container guards accept only the explicit names of this run', () => {
  const hex = runHex(Buffer.from('0123456789ab', 'hex'));
  expect(hex).toBe('0123456789ab');
  const names = deploymentNames(hex);
  expect(names).toEqual({
    hex,
    project: `foundation-deploy-${hex}`,
    migrate: `foundation-deploy-migrate-${hex}`,
    stub: `foundation-deploy-stub-${hex}`,
    edgeStub: `foundation-deploy-edgestub-${hex}`,
    tags: { frontend: `foundation-frontend:deploy-${hex}`, backend: `foundation-backend:deploy-${hex}`, migrate: `foundation-migrate:deploy-${hex}` },
  });
  expect(projectAccepted(names.project, hex)).toBe(true);
  for (const project of ['foundation', 'foundation-deploy', `foundation-deploy-${'f'.repeat(12)}`, `foundation-deploy-${hex}x`, `foundation-deploy-${hex.toUpperCase()}`, `x-foundation-deploy-${hex}`, `foundation-deploy-${hex.slice(1)}`]) {
    expect(projectAccepted(project, hex), project).toBe(false);
  }
  for (const name of [names.migrate, names.stub, names.edgeStub, `foundation-deploy-probe-${hex}-1`, `foundation-deploy-probe-${hex}-999`]) expect(containerNameAccepted(name, hex), name).toBe(true);
  for (const name of [
    names.project, `foundation-deploy-probe-${hex}-0`, `foundation-deploy-probe-${hex}-1000`, `foundation-deploy-probe-${hex}-01`,
    `foundation-deploy-migrate-${'f'.repeat(12)}`, `foundation-perf-db-${hex}`, `foundation-deploy-stub-${hex}-1`, 'foundation-postgres',
  ]) {
    expect(containerNameAccepted(name, hex), name).toBe(false);
  }
  expect(containerNameAccepted(names.migrate, 'not-a-hex')).toBe(false);
  expect(() => deploymentNames('ABC')).toThrow();
  expect(runHex()).toMatch(/^[0-9a-f]{12}$/);
});

test('DEP-001 dockerArgs refuses push, login, logout, tag, save, load, compose logs, a registry output, and any other compose build', () => {
  const refused: string[][] = [
    ['push', 'x'], ['login'], ['logout'], ['tag', 'a', 'b'], ['save', 'x'], ['load'], ['image', 'push', 'x'], ['image', 'tag', 'a', 'b'], ['image', 'save', 'x'],
    ['image', 'load'], ['compose', 'logs'], ['compose', '-p', 'foundation-deploy-0123456789ab', 'logs', 'backend'], ['compose', 'push'],
    ['build', '--push', '-t', 'x', '.'], ['build', '--output', 'type=registry', '.'], ['build', '--output=type=image,push=true', '.'], ['build', '-o', 'type=docker', '.'],
    ['buildx', 'build', '.'], ['compose', '-f', 'deploy/compose.yaml', 'build', 'backend'], ['compose', '-f', 'docker-compose.yml', 'build', 'backend'],
    ['compose', '--verbose', 'up'], ['system', 'prune'], ['volume', 'rm', 'x'], ['network', 'rm', 'x'], ['exec', 'x', 'sh'], [],
  ];
  for (const args of refused) expect(() => dockerArgs(args), args.join(' ')).toThrow(CommandRefused);
  const allowed: string[][] = [
    ['version'], ['info'], ['buildx', 'version'], ['pull', 'nginx:1.30.5-alpine@sha256:00'], ['build', '-f', 'x/Dockerfile', '-t', 'foundation-edge:deploy-x', '.'],
    ['build', '-f', 'p.Dockerfile', '--output', 'type=local,dest=/tmp/x', '.'], ['image', 'inspect', 'x'], ['image', 'rm', 'a', 'b'], ['create', '--name', 'x', 'img'],
    ['export', '-o', 'x.tar', 'x'], ['rm', '-f', 'x'], ['history', '--no-trunc', 'x'], ['inspect', 'x'], ['network', 'inspect', 'x'], ['logs', 'x'], ['run', '--rm', 'x'],
    ['compose', 'version'], ['compose', '-f', 'deploy/compose.yaml', 'config', '--no-interpolate', '--format', 'json'],
    ...['up', 'run', 'exec', 'stop', 'start', 'ps', 'port', 'down'].map((command) => ['compose', '-p', 'foundation-deploy-0123456789ab', '--env-file', 'e', '-f', 'deploy/compose.yaml', command]),
    ['compose', '-p', 'foundation-deploy-0123456789ab', '--env-file', 'e', '-f', 'docker-compose.yml', 'build', 'postgres'],
    ['compose', '--profile', 'migrate', 'run', 'migrate'],
  ];
  for (const args of allowed) expect(dockerArgs(args), args.join(' ')).toEqual(['docker', ...args]);
});

test('DEP-001 the failing statement of postgres_log_policy starts its integer input with a letter, so every hex sentinel fails with invalid input syntax and never out of range', () => {
  // PostgreSQL reads integer input as spaces, a sign, then digits, and answers out of range as soon as the leading digits
  // pass int32, before it looks at the rest. The first two sentinels gave out of range as bare literals on PostgreSQL 18.
  for (const sentinel of ['4131676112dffbc3819f9455729329ab', '21474836490abcdef0123456789abcde', '0b10101010101010101010101010101010', '0123456789abcdef0123456789abcdef']) {
    const literal = /^SELECT \$s\$(.*)\$s\$::integer$/.exec(failingStatement(sentinel))?.[1];
    expect(literal, sentinel).toBeDefined();
    expect(literal, sentinel).toContain(sentinel);
    expect(literal, sentinel).toMatch(/^[a-z]/);
    expect(literal, sentinel).not.toContain("'");
  }
});

test('DEP-001 DEPLOYMENT_CHECKS holds the checks of the Check deployment table in order, and buildResult writes every one of them', () => {
  const table: [string, string[]][] = [
    ['image_pins', ['AC-1']], ['image_context_sentinels', ['AC-1', 'AC-2']], ['image_filesystem', ['AC-2']], ['image_config', ['AC-1', 'AC-2']],
    ['provisioning_step', ['AC-3']], ['readiness_before_migration', ['AC-3', 'AC-4']], ['migration_step', ['AC-3']], ['readiness_after_migration', ['AC-3', 'AC-4']],
    ['tls_versions', ['AC-5']], ['http_redirect', ['AC-5']], ['document_headers', ['AC-5', 'AC-6']], ['static_cache_fallback', ['AC-6']],
    ['api_forwarding', ['AC-7']], ['api_headers', ['AC-7']], ['api_stub_forwarding', ['AC-7']], ['cors_absent', ['AC-7']], ['edge_errors', ['AC-7', 'AC-10']],
    ['health_not_public', ['AC-4', 'AC-7']], ['published_ports', ['AC-8']], ['network_isolation', ['AC-8']], ['egress_blocked', ['AC-8']],
    ['compose_declaration', ['AC-8', 'AC-10']], ['container_hardening', ['AC-8']], ['container_environment', ['AC-8']], ['browser_flow', ['AC-6']],
    ['backend_shutdown_restart', ['AC-9']], ['backend_recreate', ['AC-9']], ['database_outage', ['AC-4', 'AC-9']], ['edge_shutdown', ['AC-9']],
    ['log_structure', ['AC-10']], ['log_correlation', ['AC-10']], ['log_no_data', ['AC-10']], ['postgres_log_policy', ['AC-10']],
    ['topology_shutdown', ['AC-9']], ['artifact_scan', ['AC-2', 'AC-11']], ['cleanup', ['AC-11']],
  ];
  expect(DEPLOYMENT_CHECKS.map((check): [string, string[]] => [check.name, [...check.criteria]])).toEqual(table);
  expect(Object.isFrozen(DEPLOYMENT_CHECKS) && DEPLOYMENT_CHECKS.every((check) => Object.isFrozen(check) && Object.isFrozen(check.criteria))).toBe(true);
  // Recorded checks in any order come out in table order; a check never recorded is not_run, and a long detail is cut.
  const checks = new Map<DeploymentCheckName, CheckRecord>([
    ['cleanup', { name: 'cleanup', status: 'passed', detail: 'ok' }],
    ['image_pins', { name: 'image_pins', status: 'failed', detail: 'x'.repeat(300) }],
  ]);
  const result = buildResult({ startedAt: 'a', finishedAt: 'b', candidate: { commit: null, sourceTree: null }, checks, reasons: [{ code: 'signal', detail: 'SIGTERM' }] });
  expect(result.checks.map((check): string => check.name)).toEqual(table.map(([name]) => name));
  expect(result.checks[0]).toEqual({ name: 'image_pins', status: 'failed', detail: 'x'.repeat(200) });
  expect(result.checks.at(-1)).toEqual({ name: 'cleanup', status: 'passed', detail: 'ok' });
  expect(result.checks.slice(1, -1).every((check) => check.status === 'not_run' && check.detail === null)).toBe(true);
  expect([result.schema, result.status, result.reasons]).toEqual([1, 'failed', [{ code: 'signal', detail: 'SIGTERM' }]]);
  // The image names of the report field are the three images of the orchestration, in its order.
  expect(IMAGES.map((image) => image.name)).toEqual([...DEPLOYMENT_IMAGE_NAMES]);
});

test('DEP-001 the inspect and reachability judges: hardening of the edge, the image config of the runner, the environment diff, compose port, probes, and the stopped backend window', () => {
  const mib = 1024 * 1024;
  const project = 'foundation-deploy-0123456789ab';
  const edge = {
    Config: { User: '101:101', StopTimeout: 15, Healthcheck: null },
    NetworkSettings: { Networks: { [`${project}_public`]: {}, [`${project}_app`]: {} } },
    HostConfig: {
      NanoCpus: 500_000_000, Memory: 128 * mib, PidsLimit: 128, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m' }, CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-file': '3', 'max-size': '10m' } },
    },
  };
  expect(hardeningProblems('edge', edge, project, null)).toEqual([]);
  const broken: [string, (value: any) => void, string][] = [
    ['root user', (value) => void (value.Config.User = '0:0'), 'edge: Config.User'],
    ['a capability kept', (value) => void (value.HostConfig.CapDrop = []), 'edge: CapDrop'],
    ['no-new-privileges off', (value) => void (value.HostConfig.SecurityOpt = []), 'edge: SecurityOpt'],
    ['a writable root', (value) => void (value.HostConfig.ReadonlyRootfs = false), 'edge: ReadonlyRootfs'],
    ['restart always', (value) => void (value.HostConfig.RestartPolicy = { Name: 'always' }), 'edge: RestartPolicy'],
    ['another log driver', (value) => void (value.HostConfig.LogConfig = { Type: 'local', Config: {} }), 'edge: LogConfig'],
    ['the data network', (value) => void (value.NetworkSettings.Networks[`${project}_data`] = {}), `edge: network ${project}_app, ${project}_data, ${project}_public`],
  ];
  for (const [label, mutate, problem] of broken) {
    const value = structuredClone(edge);
    mutate(value);
    expect(hardeningProblems('edge', value, project, null), label).toContain(problem);
  }

  const labels = { revision: 'a'.repeat(40), sourceTree: 'b'.repeat(64), hex: '0123456789ab' };
  const runner = {
    Config: {
      User: '1000:1000', Entrypoint: ['bun', '--no-env-file'], Cmd: ['database/migrate.ts'], StopSignal: 'SIGTERM', ExposedPorts: {}, WorkingDir: '/app',
      Env: ['PATH=/usr/local/bin:/usr/bin:/bin'], Healthcheck: null,
      Labels: { 'org.opencontainers.image.title': 'foundation-migrate', 'org.opencontainers.image.revision': labels.revision, 'foundation.source-tree': labels.sourceTree, 'foundation.test': 'deployment', 'foundation.run': labels.hex },
    },
  };
  expect(imageConfigProblems('migrate', runner, labels)).toEqual([]);
  const withSecret = structuredClone(runner);
  withSecret.Config.Env.push('FOUNDATION_MIGRATOR_DATABASE_URL=postgres://x');
  expect(imageConfigProblems('migrate', withSecret, labels)).toEqual(['migrate: Config.Env memuat key FOUNDATION_MIGRATOR_DATABASE_URL']);
  const otherRevision = structuredClone(runner);
  otherRevision.Config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40);
  expect(imageConfigProblems('migrate', otherRevision, labels)).toEqual(['migrate: label org.opencontainers.image.revision tidak sesuai']);
  expect(secretArgs('ARG DB_PASSWORD\nARG NODE_VERSION\n|1 API_TOKEN=x ARG API_TOKEN')).toEqual(['DB_PASSWORD', 'API_TOKEN']);

  expect([...addedEnvironment(['PATH=/bin', 'DATABASE_URL=postgres://x', 'NODE_ENV=production'], ['PATH=/bin', 'NODE_ENV=production'])]).toEqual([['DATABASE_URL', 'postgres://x']]);

  expect(unpublishedPort(0, '', '')).toBe(true);
  expect(unpublishedPort(0, 'invalid IP:0\n', '')).toBe(true);
  expect(unpublishedPort(0, ':0', '')).toBe(true);
  expect(unpublishedPort(1, '', 'no port 5432/tcp for container postgres')).toBe(true);
  expect(unpublishedPort(0, '127.0.0.1:5432', '')).toBe(false);
  expect(unpublishedPort(0, '0.0.0.0:49153', '')).toBe(false);
  expect(unpublishedPort(1, '', 'service "backend" is not running')).toBe(false);

  const script = probeScript({ kind: 'tcp', host: 'postgres', port: 5432 });
  expect(script).toContain('const spec={"kind":"tcp","host":"postgres","port":5432}');
  expect(script).toContain(`setTimeout(()=>resolve({result:'fail',code:'timeout'}),${PROBE_LIMIT_MS})`);
  expect(PROBE_LIMIT_MS).toBe(3_000);
  expect(parseProbe('noise\n{"result":"ok","code":null,"status":200,"body":"{\\"status\\":\\"live\\"}","ms":12}\n')).toEqual({ result: 'ok', code: null, status: 200, body: '{"status":"live"}', ms: 12 });
  expect(parseProbe('{"result":"maybe","ms":1}')).toBeNull();

  const samples = (statuses: [number, number | null][]) => statuses.map(([atMs, status]) => ({ atMs, status, edgeJson: true }));
  expect(stoppedBackendProblems(samples([[0, 504], [5_000, 502], [15_000, 502], [15_500, 502], [16_000, 502]]), 15_000)).toEqual([]);
  expect(stoppedBackendProblems(samples([[0, 502], [15_000, 504], [15_500, 502], [16_000, 502]]), 15_000)).toEqual(['1 jawaban sesudah 15000 ms bukan 502']);
  expect(stoppedBackendProblems(samples([[0, 200], [15_000, 502], [15_500, 502], [16_000, 502]]), 15_000)).toEqual(['1 jawaban bukan 502 atau 504 JSON edge']);
  expect(stoppedBackendProblems(samples([[0, 502], [15_000, 502]]), 15_000)).toEqual(['1 jawaban sesudah 15000 ms, diharapkan paling sedikit 3']);
});

// ---------------------------------------------------------------------------------------------------------------
// Targets normalized outside /api/ and the path above the root (AC-4, AC-7, decision 62), and the registry trace.

/** *Header dokumen* and *Header API* as the spec tables write them, with an X-Request-Id of 32 hex digits. */
const DOCUMENT_HEADER_TABLE: [string, string][] = [
  ['content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types angular angular#bundler angular#components"],
  ['strict-transport-security', 'max-age=31536000'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-resource-policy', 'same-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
  ['x-request-id', '0123456789abcdef0123456789abcdef'],
];
const API_HEADER_TABLE: [string, string][] = [
  ['content-security-policy', "default-src 'none'; frame-ancestors 'none'"],
  ['strict-transport-security', 'max-age=31536000'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['cross-origin-resource-policy', 'same-origin'],
  ['x-request-id', 'fedcba9876543210fedcba9876543210'],
];

test('DEP-001 health_not_public demands index.html 200 with Header dokumen and no upstream outside /api/, and the backend 404 JSON with Header API for /api/health', () => {
  // The targets of the Check deployment paragraph, written here from the spec.
  expect([...HEALTH_DOCUMENT_TARGETS]).toEqual(['/health/live', '/health/ready', '/health/live/', '//health/ready', '/api/../health/live', '/api/%2e%2e/health/ready', '/api/x/..%2f..%2fhealth/live']);
  expect([...HEALTH_API_TARGETS]).toEqual(['/api/health/live', '/api/health/ready']);
  // Only forms that still choose location ^~ /api/ are demanded 400 JSON; the normalized ones are not among them.
  expect([...HEALTH_DOCUMENT_TARGETS, ...ABOVE_ROOT_TARGETS].filter((target) => TRAVERSAL_TARGETS.includes(target))).toEqual([]);

  const index = '<!doctype html><html><body><app-root></app-root><script src="main-AAAAAAAA.js"></script></body></html>';
  const page = (status: number, body: string, headers: [string, string][]) => ({ status, body, headers: [['content-type', 'text/html'], ...headers] as [string, string][], elapsedMs: 1 });
  const json = (status: number, body: string, headers: [string, string][]) => ({ status, body, headers: [['content-type', 'application/json'], ...headers] as [string, string][], elapsedMs: 1 });
  const documents: LoggedAnswer[] = HEALTH_DOCUMENT_TARGETS.map((target) => ({ target, answer: page(200, index, DOCUMENT_HEADER_TABLE), upstream: '' }));
  const api: LoggedAnswer[] = HEALTH_API_TARGETS.map((target) => ({ target, answer: json(404, '{"error":"Not found"}', API_HEADER_TABLE), upstream: '404' }));
  expect(healthNotPublicProblems(documents, api, index)).toEqual([]);

  const [first, ...rest] = documents;
  const withDocument = (changed: Partial<LoggedAnswer>) => healthNotPublicProblems([{ ...first!, ...changed }, ...rest], api, index);
  // The first three passed the old check, which only refused a health body: a 404, another page, an upstream 404.
  expect(withDocument({ answer: page(404, '<html>404</html>', DOCUMENT_HEADER_TABLE) })).toEqual(['/health/live 404 bukan index.html 200']);
  expect(withDocument({ answer: page(200, '<html>other</html>', DOCUMENT_HEADER_TABLE) })).toEqual(['/health/live 200 bukan index.html 200']);
  expect(withDocument({ upstream: '404' })).toEqual(['/health/live upstreamStatus 404, diharapkan kosong']);
  expect(withDocument({ upstream: null })).toEqual(['/health/live tidak ada di log edge']);
  expect(withDocument({ answer: null })).toEqual(['/health/live tanpa jawaban']);
  expect(withDocument({ answer: page(200, index, DOCUMENT_HEADER_TABLE.filter(([name]) => name !== 'x-frame-options')) })).toEqual(['/health/live: x-frame-options tidak ada']);
  expect(withDocument({ answer: page(200, index, [...DOCUMENT_HEADER_TABLE, ['access-control-allow-origin', '*']]) })).toEqual(['/health/live: access-control-allow-origin ada']);
  expect(withDocument({ answer: json(200, '{"status":"live"}', API_HEADER_TABLE) })).toEqual(['/health/live 200 bukan index.html 200']);
  expect(healthNotPublicProblems(documents.slice(0, 1), [], null)).toEqual(['/health/live 200 bukan index.html 200']);

  const [apiFirst, apiSecond] = api;
  const withApi = (changed: Partial<LoggedAnswer>) => healthNotPublicProblems(documents, [{ ...apiFirst!, ...changed }, apiSecond!], index);
  expect(withApi({ answer: json(200, '{"status":"live"}', API_HEADER_TABLE) })).toEqual(['/api/health/live 200 bukan 404 JSON backend']);
  expect(withApi({ answer: page(200, index, DOCUMENT_HEADER_TABLE) })).toEqual(['/api/health/live 200 bukan 404 JSON backend']);
  expect(withApi({ answer: json(400, '{"error":"Invalid request"}', API_HEADER_TABLE) })).toEqual(['/api/health/live 400 bukan 404 JSON backend']);
  // A 404 JSON the edge made itself (no upstream) is not the backend answer.
  expect(withApi({ upstream: '' })).toEqual(['/api/health/live upstreamStatus kosong, diharapkan 404 dari backend']);
  expect(withApi({ upstream: null })).toEqual(['/api/health/live tidak ada di log edge']);
  expect(withApi({ answer: json(404, '{"error":"Not found"}', [...API_HEADER_TABLE, ['x-frame-options', 'DENY']]) })).toEqual(['/api/health/live: x-frame-options ada']);
});

test('DEP-001 edge_errors demands the default nginx 400 with Header dokumen, Server: nginx without a version, and an edge log line with status 400 and an empty path and upstreamStatus for /api/../../x', () => {
  expect([...ABOVE_ROOT_TARGETS]).toEqual(['/api/../../x']);
  const body = '<html>\r\n<head><title>400 Bad Request</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';
  const answer = (status: number, text: string, headers: [string, string][]) => ({ status, body: text, headers: [['server', 'nginx'], ['content-type', 'text/html'], ...headers] as [string, string][], elapsedMs: 1 });
  const good = answer(400, body, DOCUMENT_HEADER_TABLE);
  // The line nginx 1.30.5 writes for a path above the root (AC-10, decision 66): $request_uri is not set yet when
  // nginx rejects the URI, so path is empty; method is empty too for an HTTP/2 stream that sends :path before :method.
  const line = (changed: Partial<EdgeLogLine> = {}): EdgeLogLine => ({
    time: '2026-10-05T15:13:52+00:00', requestId: '2bb7e51930704e10e3a34c9cecc02ab1', method: 'GET', path: '', status: 400, bytes: 157,
    requestTime: 0, upstreamStatus: '', upstreamTime: '', ...changed,
  });
  expect(nginxDefault400Problems('/api/../../x', good, line())).toEqual([]);
  expect(nginxDefault400Problems('/api/../../x', good, line({ method: '' }))).toEqual([]);
  // Without a log line argument (the large header case) only the answer is judged.
  expect(nginxDefault400Problems('header 9000 byte', good)).toEqual([]);

  expect(nginxDefault400Problems('/api/../../x', null, line())).toEqual(['/api/../../x tanpa jawaban']);
  expect(nginxDefault400Problems('/api/../../x', answer(200, '<html></html>', DOCUMENT_HEADER_TABLE), line())).toEqual(['/api/../../x 200, diharapkan 400']);
  // The edge JSON 400 of /api/ carries Header API, not Header dokumen, so it fails here.
  expect(nginxDefault400Problems('/api/../../x', { status: 400, body: '{"error":"Invalid request"}', headers: [['server', 'nginx'], ['content-type', 'application/json'], ...API_HEADER_TABLE], elapsedMs: 1 }, line())).toEqual([
    '/api/../../x: content-security-policy tidak tepat',
    '/api/../../x: x-frame-options tidak ada',
    '/api/../../x: cross-origin-opener-policy tidak ada',
    '/api/../../x: permissions-policy tidak ada',
    '/api/../../x tanpa Server: nginx atau dengan versi',
  ]);
  expect(nginxDefault400Problems('/api/../../x', answer(400, body.replace('<center>nginx</center>', '<center>nginx/1.30.5</center>'), DOCUMENT_HEADER_TABLE), line())).toEqual(['/api/../../x tanpa Server: nginx atau dengan versi']);
  expect(nginxDefault400Problems('/api/../../x', { ...good, headers: good.headers.map(([name, value]): [string, string] => [name, name === 'server' ? 'nginx/1.30.5' : value]) }, line())).toEqual(['/api/../../x tanpa Server: nginx atau dengan versi']);
  expect(nginxDefault400Problems('/api/../../x', answer(400, body, [...DOCUMENT_HEADER_TABLE, ['access-control-allow-origin', '*']]), line())).toEqual(['/api/../../x: access-control-allow-origin ada']);

  // The log line: missing, another status, a path (the $request fallback that decision 66 rejects), or an upstream.
  expect(nginxDefault400Problems('/api/../../x', good, null)).toEqual(['/api/../../x tidak ada di log edge']);
  expect(nginxDefault400Problems('/api/../../x', good, line({ status: 200 }))).toEqual(['/api/../../x baris log edge status 200, diharapkan 400']);
  expect(nginxDefault400Problems('/api/../../x', good, line({ path: '/api/../../x' }))).toEqual(['/api/../../x baris log edge path /api/../../x, diharapkan kosong']);
  expect(nginxDefault400Problems('/api/../../x', good, line({ upstreamStatus: '400' }))).toEqual(['/api/../../x diteruskan ke upstream']);
  expect(nginxDefault400Problems('/api/../../x', good, line({ status: 200, path: '/api/../../x', upstreamStatus: '200' }))).toEqual([
    '/api/../../x baris log edge status 200, diharapkan 400',
    '/api/../../x baris log edge path /api/../../x, diharapkan kosong',
    '/api/../../x diteruskan ke upstream',
  ]);
});

test('DEP-001 the scenario registry names, for every DEP scenario, exactly the criteria its item of Critical test scenarios proves', async () => {
  const spec = await read('docs/specs/0012-build-container-deployment-terpisah/index.md');
  const section = spec.slice(spec.indexOf('**Critical test scenarios**'), spec.indexOf('## Build plan'));
  const proven = new Map<string, string[]>();
  for (const line of section.split('\n')) {
    const id = /^\d+\. `(DEP-\d{3})`/.exec(line)?.[1];
    if (id === undefined) continue;
    // Bold criteria after the last "Membuktikan"; "**AC-a** sampai **AC-b**" is the range a to b.
    const numbers: number[] = [];
    for (const match of line.slice(line.lastIndexOf('Membuktikan')).matchAll(/(sampai )?\*\*AC-(\d+)\*\*/g)) {
      const value = Number(match[2]);
      const from = numbers.at(-1);
      if (match[1] !== undefined && from !== undefined) for (let next = from + 1; next <= value; next += 1) numbers.push(next);
      else numbers.push(value);
    }
    proven.set(id, numbers.map((value) => `AC-${value}`));
  }
  expect([...proven.keys()]).toEqual(['DEP-001', 'DEP-002', 'DEP-003', 'DEP-004', 'DEP-005', 'DEP-006', 'DEP-007', 'DEP-008', 'DEP-009']);
  // Decision 61: DEP-007 proves the AC-9 sentence outside the topology as well as AC-10.
  expect(proven.get('DEP-007')).toEqual(['AC-9', 'AC-10']);

  const registry = JSON.parse(await read('tests/scenarios/deployment.json')) as { source: string; scenarios: { id: string; criteria: string[]; critical?: boolean }[] };
  expect(registry.source).toBe('docs/specs/0012-build-container-deployment-terpisah/index.md');
  expect(new Map(registry.scenarios.map((scenario) => [scenario.id, scenario.criteria]))).toEqual(proven);
  expect(registry.scenarios.filter((scenario) => scenario.critical === true).map((scenario) => scenario.id)).toEqual(['DEP-006']);
});
