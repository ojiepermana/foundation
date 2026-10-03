import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findBrowserImportViolation, sdkImportRole } from '../../../scripts/lib/frontend-bundle.ts';

const root = new URL('../../../', import.meta.url).pathname;
const checker = join(root, 'scripts/check-frontend-bundle.ts');
const passed = 'Frontend imports and production browser assets passed the security scan.\n';

/** Fixture root with `files` written below `apps/frontend/` and a built `dist/index.html`. */
async function workspaceFixture(files: Record<string, string>, asset: string | null = '<main>safe</main>'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'foundation-frontend-bundle-'));
  await mkdir(join(directory, 'apps/frontend/src/app'), { recursive: true });
  for (const [path, source] of Object.entries(files)) {
    const file = join(directory, 'apps/frontend', path);
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, source);
  }
  if (asset !== null) {
    await mkdir(join(directory, 'apps/frontend/dist'), { recursive: true });
    await Bun.write(join(directory, 'apps/frontend/dist/index.html'), asset);
  }
  return directory;
}

async function fixture(source: string, asset = '<main>safe</main>'): Promise<string> {
  return workspaceFixture({ 'src/app/app.ts': source }, asset);
}

async function runChecker(directory: string, environment: Record<string, string> = {}) {
  const process = Bun.spawn([globalThis.process.execPath, '--no-env-file', checker], {
    cwd: directory,
    env: {
      PATH: globalThis.process.env['PATH'] ?? '',
      HOME: globalThis.process.env['HOME'] ?? '',
      ...environment,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr, output: stdout + stderr };
}

async function checkFixture(files: Record<string, string>, asset?: string | null) {
  const directory = await workspaceFixture(files, asset);
  try {
    return await runChecker(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const serverOnly = (path: string) => `Browser application imports a server only module from ${path}.\n`;
const sdkOutsideAdapter = (path: string) => `Browser application imports the SDK outside a feature adapter from ${path}.\n`;

test('UI-003 frontend bundle checker accepts clean source and production assets', async () => {
  const directory = await fixture(`
    import { Component } from '@angular/core';
    import type { Route } from '@angular/router';
    export { Component };
    export type { Route };
    const lazyRoute = import('./lazy-route');
    type LazyModel = import('./lazy-model').Model;
    void lazyRoute;
    const route: Route | undefined = undefined;
    type Used = LazyModel;
    void route;
    void (0 as unknown as Used);
  `);
  try {
    const result = await runChecker(directory);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('passed the security scan');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

for (const [label, source] of [
  ['side-effect server import', "import '../../../../../libs/server/runtime';"],
  ['bare Node builtin import', "import 'fs/promises';"],
  ['bare Bun runtime import', "import 'bun';"],
  ['dynamic Node builtin import', "void import('node:fs');"],
  ['Bun require import', "require('bun:sqlite');"],
  ['TypeScript import equals', "import runtime = require('node:fs');"],
  ['TypeScript import type expression', "type RuntimeFile = import('fs/promises').FileHandle;"],
  ['server export import', "export * from '@foundation/server/runtime';"],
] as const) {
  test(`UI-003 frontend bundle checker rejects ${label}`, async () => {
    const directory = await fixture(source);
    try {
      const result = await runChecker(directory);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('server only module');
      expect(result.stderr).toBe(serverOnly('apps/frontend/src/app/app.ts'));
      expect(result.stdout).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);
}

test('UI-003 frontend bundle checker rejects uninspectable dynamic imports', async () => {
  const directory = await fixture("const runtimeModule = 'node:fs'; void import(runtimeModule);");
  try {
    const result = await runChecker(directory);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('server only module');
    expect(result.stderr).toBe(serverOnly('apps/frontend/src/app/app.ts'));
    expect(result.stdout).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

for (const [label, asset, environment, leakedValue] of [
  ['database URL', 'postgresql://fixture:secret@localhost:5432/example', {}, 'fixture:secret'],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----', {}, '-----BEGIN RSA PRIVATE KEY-----'],
  [
    'configured credential',
    'synthetic-secret-value-112233',
    { FRONTEND_TEST_SECRET: 'synthetic-secret-value-112233' },
    'synthetic-secret-value-112233',
  ],
] as const) {
  test(`UI-003 frontend bundle checker rejects ${label} without printing its value`, async () => {
    const directory = await fixture("export const app = 'safe';", asset);
    try {
      const result = await runChecker(directory, environment);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('configured credential');
      expect(result.output).not.toContain(leakedValue);
      expect(result.stderr).toBe('A database URL or configured credential was found in apps/frontend/dist/index.html.\n');
      expect(result.stdout).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);
}

test('SDK-003 checker prints only the fixed message when the build output is missing', async () => {
  const result = await checkFixture({ 'src/app/app.ts': "export const app = 'safe';" }, null);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe('Build the frontend before checking its production assets.\n');
  expect(result.stdout).toBe('');
}, 10000);

test('SDK-003 checker prints a generic failure without a stack for unexpected errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundation-frontend-bundle-'));
  try {
    const result = await runChecker(directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Frontend bundle check failed.\n');
    expect(result.stdout).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

const adapter = 'src/app/features/readiness/readiness-api.ts';
const store = 'src/app/features/readiness/readiness-store.ts';
const config = 'src/app/app.config.ts';

test('SDK-003 checker accepts the SDK import forms of the adapter and application config', async () => {
  const result = await checkFixture({
    [adapter]: [
      "import { DevelopmentService, type DevelopmentStatus } from '@sdk';",
      "import type { ApiConfiguration } from '@sdk';",
      "export type { DevelopmentStatus } from '@sdk';",
      'export class ReadinessApi { constructor(readonly service: DevelopmentService, readonly config: ApiConfiguration) {} }',
      'export type Status = DevelopmentStatus;',
    ].join('\n'),
    'src/app/features/foundation-home/foundation-home-api.ts': "import { DevelopmentService } from '@sdk';\nvoid DevelopmentService;",
    [config]: [
      "import { provideApiConfiguration } from '@sdk';",
      "import type { ApiConfiguration } from '@sdk';",
      'export const providers = [provideApiConfiguration(\'\')];',
      'export type Config = ApiConfiguration;',
    ].join('\n'),
    'src/app/core/http/api.ts': "import { api } from '../../../sdk/public-api';\nexport { api };",
  });
  expect(result.code, result.output).toBe(0);
  expect(result.stdout).toBe(passed);
  expect(result.stderr).toBe('');
}, 10000);

const rejected: Array<[label: string, file: string, source: string]> = [
  ['the barrel in main.ts', 'src/main.ts', "import { DevelopmentService } from '@sdk';"],
  ['the barrel in a feature store', store, "import { DevelopmentService } from '@sdk';"],
  ['the barrel in a feature file not named after its folder', 'src/app/features/readiness/other-api.ts', "import { DevelopmentService } from '@sdk';"],
  ['the barrel in a nested adapter name', 'src/app/features/readiness/nested/readiness-api.ts', "import { DevelopmentService } from '@sdk';"],
  ['the barrel in an adapter with an invalid feature name', 'src/app/features/Readiness/Readiness-api.ts', "import { DevelopmentService } from '@sdk';"],
  ['the barrel in core code', 'src/app/core/http/api.ts', "import { DevelopmentService } from '@sdk';"],
  ['a type only import in a store', store, "import type { DevelopmentStatus } from '@sdk';"],
  ['a type import expression in a store', store, "type Status = import('@sdk').DevelopmentStatus;"],
  ['a dynamic import in the adapter', adapter, "void import('@sdk');"],
  ['require in the adapter', adapter, "require('@sdk');"],
  ['import equals require in the adapter', adapter, "import sdk = require('@sdk');"],
  ['a side effect import in the adapter', adapter, "import '@sdk';"],
  ['a namespace import in the adapter', adapter, "import * as sdk from '@sdk';"],
  ['a default import in the adapter', adapter, "import sdk from '@sdk';"],
  ['an empty named import in the adapter', adapter, "import {} from '@sdk';"],
  ['a type import expression in the adapter', adapter, "type Status = import('@sdk').DevelopmentStatus;"],
  ['a deep SDK path in the adapter', adapter, "import type { DevelopmentStatus } from '@sdk/models/development-status';"],
  ['a deep SDK path in the application config', config, "import { provideApiConfiguration } from '@sdk/api-configuration';"],
  ['a relative SDK path in core code', 'src/app/core/http/api.ts', "import { api } from '../../../../sdk/public-api';"],
  ['a relative SDK path in the adapter', adapter, "import { api } from '../../../../sdk/public-api';"],
  ['the relative SDK folder in the root component', 'src/app/app.ts', "import '../../sdk';"],
  ['export star in the adapter', adapter, "export * from '@sdk';"],
  ['export star as namespace in the adapter', adapter, "export * as sdk from '@sdk';"],
  ['export type star in the adapter', adapter, "export type * from '@sdk';"],
  ['export type star as namespace in the adapter', adapter, "export type * as sdk from '@sdk';"],
  ['a value re-export in the adapter', adapter, "export { DevelopmentService } from '@sdk';"],
  ['an inline type re-export in the adapter', adapter, "export { type DevelopmentStatus } from '@sdk';"],
  ['a local export of an SDK binding in the adapter', adapter, "import { DevelopmentService } from '@sdk';\nexport { DevelopmentService };"],
  ['a renamed local export of an SDK binding in the adapter', adapter, "import { DevelopmentService } from '@sdk';\nexport { DevelopmentService as Service };"],
  ['a local type export of an SDK binding in the adapter', adapter, "import type { DevelopmentStatus } from '@sdk';\nexport type { DevelopmentStatus };"],
  ['a local export written before its SDK import', adapter, "export { DevelopmentService };\nimport { DevelopmentService } from '@sdk';"],
  ['a default export of an SDK binding in the adapter', adapter, "import { DevelopmentService } from '@sdk';\nexport default DevelopmentService;"],
  ['an export assignment of an SDK binding in the adapter', adapter, "import { DevelopmentService } from '@sdk';\nexport = DevelopmentService;"],
  ['a type re-export in the application config', config, "export type { DevelopmentStatus } from '@sdk';"],
  ['a local export of an SDK binding in the application config', config, "import { provideApiConfiguration } from '@sdk';\nexport { provideApiConfiguration };"],
];

for (const [label, file, source] of rejected) {
  test(`SDK-003 checker rejects ${label}`, async () => {
    const result = await checkFixture({ [file]: source });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(sdkOutsideAdapter(`apps/frontend/${file}`));
    expect(result.stdout).toBe('');
  }, 10000);
}

test('SDK-003 checker reports the first violating file in code unit order', async () => {
  const result = await checkFixture({
    'src/main.ts': "import { DevelopmentService } from '@sdk';",
    'src/app/app.ts': "import { DevelopmentService } from '@sdk';",
    'src/app/Z.ts': "import 'node:fs';",
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toBe(serverOnly('apps/frontend/src/app/Z.ts'));
  expect(result.stdout).toBe('');

  const sdkFirst = await checkFixture({
    'src/main.ts': "import { DevelopmentService } from '@sdk';",
    'src/app/app.ts': "import { DevelopmentService } from '@sdk';",
  });
  expect(sdkFirst.stderr).toBe(sdkOutsideAdapter('apps/frontend/src/app/app.ts'));
}, 20000);

test('SDK-003 checker reports the first violating specifier in source order', async () => {
  const sdkFirst = await checkFixture({ [store]: "import '@sdk';\nimport 'node:fs';" });
  expect(sdkFirst.stderr).toBe(sdkOutsideAdapter(`apps/frontend/${store}`));
  const serverFirst = await checkFixture({ [store]: "import 'node:fs';\nimport '@sdk';" });
  expect(serverFirst.stderr).toBe(serverOnly(`apps/frontend/${store}`));
}, 20000);

test('SDK-003 checker parses tsx files as TSX and still finds an SDK import after JSX', async () => {
  const result = await checkFixture({
    'src/app/widget.tsx': "const view = <section>ready</section>;\nvoid view;\nimport { DevelopmentService } from '@sdk';",
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toBe(sdkOutsideAdapter('apps/frontend/src/app/widget.tsx'));
  expect(result.stdout).toBe('');
}, 10000);

test('SDK-003 checker skips spec and test files', async () => {
  const result = await checkFixture({
    'src/app/sdk-contract.integration.spec.ts': "import { DevelopmentService } from '@sdk';",
    'src/app/features/readiness/readiness.test.tsx': "import * as sdk from '@sdk';",
    // covers: AC-3, the other two excluded suffixes.
    'src/app/features/readiness/readiness.spec.tsx': "import * as sdk from '@sdk';",
    'src/app/features/readiness/readiness-store.test.ts': "import { DevelopmentService } from '@sdk';",
  });
  expect(result.code, result.output).toBe(0);
  expect(result.stdout).toBe(passed);
}, 10000);

// ---------------------------------------------------------------------------------------------------------------
// SDK-003 (AC-3), unit level: the file roles and the import form rules behind the CLI, without a subprocess.

const fixtureSource = '/fixture/apps/frontend/src';
const fixtureSdk = '/fixture/apps/frontend/sdk';

function violation(relativePath: string, source: string) {
  return findBrowserImportViolation(source, `${fixtureSource}/${relativePath}`, {
    role: sdkImportRole(relativePath),
    sdkDirectory: fixtureSdk,
  });
}

test('SDK-003 sdkImportRole accepts only app/app.config.ts and app/features/<fitur>/<fitur>-api.ts with a valid feature name', () => {
  const roles: Array<[path: string, role: ReturnType<typeof sdkImportRole>]> = [
    ['app/app.config.ts', 'config'],
    ['app/features/readiness/readiness-api.ts', 'adapter'],
    ['app/features/foundation-home/foundation-home-api.ts', 'adapter'],
    ['app/features/a/a-api.ts', 'adapter'],
    ['app/features/v2/v2-api.ts', 'adapter'],
    ['app/features/a1-b2-c3/a1-b2-c3-api.ts', 'adapter'],
    // Not the application config: another folder or another name.
    ['app.config.ts', 'other'],
    ['app/core/app.config.ts', 'other'],
    ['app/app.config.tsx', 'other'],
    // Names that break ^[a-z][a-z0-9]*(-[a-z0-9]+)*$.
    ['app/features/1readiness/1readiness-api.ts', 'other'],
    ['app/features/readiness-/readiness--api.ts', 'other'],
    ['app/features/read--iness/read--iness-api.ts', 'other'],
    ['app/features/read_iness/read_iness-api.ts', 'other'],
    ['app/features/-readiness/-readiness-api.ts', 'other'],
    ['app/features/Readiness/Readiness-api.ts', 'other'],
    // The adapter path shape: exact depth, folder name repeated, `.ts` only.
    ['app/features/readiness/readiness-api.tsx', 'other'],
    ['app/features/readiness/other-api.ts', 'other'],
    ['app/features/readiness/readiness-api.spec.ts', 'other'],
    ['app/features/readiness/nested/readiness-api.ts', 'other'],
    ['app/features/readiness-api.ts', 'other'],
    ['features/readiness/readiness-api.ts', 'other'],
    ['lib/features/readiness/readiness-api.ts', 'other'],
  ];
  for (const [path, role] of roles) expect(sdkImportRole(path), path).toBe(role);
});

test('SDK-003 findBrowserImportViolation accepts the inline type form in the config and non SDK local exports in the adapter', () => {
  expect(violation('app/app.config.ts', "import { provideApiConfiguration, type ApiConfiguration } from '@sdk';")).toBeUndefined();
  // Local exports of names that do not come from the SDK stay allowed in the adapter.
  expect(
    violation(
      'app/features/readiness/readiness-api.ts',
      [
        "import { Service, inject } from '@angular/core';",
        "import { DevelopmentService, type DevelopmentStatus } from '@sdk';",
        'export { inject };',
        'export type ReadinessStatus = DevelopmentStatus;',
        '@Service() export default class ReadinessApi { readonly service = inject(DevelopmentService); }',
      ].join('\n'),
    ),
  ).toBeUndefined();
  // A relative specifier that only looks like the SDK folder name stays allowed.
  expect(violation('app/core/http/api.ts', "import { api } from './sdk-like';")).toBeUndefined();
});

test('SDK-003 findBrowserImportViolation rejects SDK bindings leaving the adapter through a parenthesized default export or export import', () => {
  const adapterPath = 'app/features/readiness/readiness-api.ts';
  expect(violation(adapterPath, "import { DevelopmentService } from '@sdk';\nexport default (DevelopmentService);")).toBe('sdk');
  expect(violation(adapterPath, "import { DevelopmentService } from '@sdk';\nexport import Service = DevelopmentService;")).toBe('sdk');
  expect(violation(adapterPath, "import * as sdk from '@sdk';")).toBe('sdk');
  expect(violation('app/app.config.ts', "import { provideApiConfiguration } from '@sdk';\nexport default provideApiConfiguration;")).toBe('sdk');
  expect(violation('app/app.config.ts', "export * from '@sdk';")).toBe('sdk');
  // The relative path to the SDK folder itself, with and without a trailing slash.
  expect(violation(adapterPath, "import '../../../../sdk';")).toBe('sdk');
  expect(violation(adapterPath, "import '../../../../sdk/';")).toBe('sdk');
});

test('SDK-003 findBrowserImportViolation reports server only modules before the SDK rule in the same statement order', () => {
  expect(violation('app/app.config.ts', "import 'node:path';\nimport { provideApiConfiguration } from '@sdk';")).toBe('server');
  expect(violation('app/features/readiness/readiness-api.ts', "import { DevelopmentService } from '@sdk';\nvoid import('bun');")).toBe('server');
  expect(violation('app/app.ts', "import { DevelopmentService } from '@sdk';\nimport 'node:path';")).toBe('sdk');
});

// ---------------------------------------------------------------------------------------------------------------
// SDK-003 (AC-3), review findings: one output line for any file name, and no symlink left unchecked.

// covers: AC-3 ("tepat ... dan satu newline") and key invariant 9 for a file name that holds a newline and U+001B.
test('SDK-003 checker escapes a file name with a newline or a control character, so stderr stays one line', async () => {
  const name = 'a\n::error::injected\u001b[31m.ts';
  const escaped = '"apps/frontend/src/app/a\\u000a::error::injected\\u001b[31m.ts"';
  const source = await checkFixture({ [`src/app/${name}`]: "import 'node:fs';" });
  expect(source.code).toBe(1);
  expect(source.stderr).toBe(serverOnly(escaped));
  expect(source.stdout).toBe('');

  const sdk = await checkFixture({ [`src/app/${name}`]: "import { DevelopmentService } from '@sdk';" });
  expect(sdk.stderr).toBe(sdkOutsideAdapter(escaped));

  const directory = await workspaceFixture({ 'src/app/app.ts': "export const app = 'safe';" });
  try {
    await Bun.write(join(directory, 'apps/frontend/dist', `main\n::error::x\u001b.js`), 'postgresql://fixture:secret@localhost/x');
    const asset = await runChecker(directory);
    expect(asset.code).toBe(1);
    expect(asset.stderr).toBe(
      'A database URL or configured credential was found in "apps/frontend/dist/main\\u000a::error::x\\u001b.js".\n',
    );
    expect(asset.output).not.toContain('fixture:secret');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // One message line and its newline; plain names keep the exact text the earlier cases assert.
  for (const result of [source, sdk]) expect(result.stderr.split('\n')).toHaveLength(2);
}, 20000);

const symlinkMessage = (path: string) => `Frontend bundle check does not follow the symlink ${path}.\n`;

// covers: AC-3 ("memeriksa setiap file .ts dan .tsx di bawah apps/frontend/src"): the Angular build follows a symlink,
// so a symlinked adapter or folder would be built without being checked.
test('SDK-003 checker fails on a symlinked file or folder under apps/frontend/src instead of skipping it', async () => {
  const cases: Array<[label: string, link: string, target: string]> = [
    ['a symlinked adapter with a server only import', adapter, '../../../../../outside/readiness-api.ts'],
    ['a symlinked folder with an SDK import in a store', 'src/app/linked', '../../../../outside/folder'],
    ['a symlink to a clean file inside the source tree', 'src/app/app-link.ts', './app.ts'],
  ];
  for (const [label, link, target] of cases) {
    const directory = await workspaceFixture({ 'src/app/app.ts': "export const app = 'safe';" });
    try {
      await Bun.write(join(directory, 'outside/readiness-api.ts'), "import 'node:fs';\nexport class ReadinessApi {}");
      await Bun.write(join(directory, 'outside/folder/readiness-store.ts'), "import { DevelopmentService } from '@sdk';");
      await mkdir(dirname(join(directory, 'apps/frontend', link)), { recursive: true });
      await symlink(target, join(directory, 'apps/frontend', link));
      const result = await runChecker(directory);
      expect(result.code, label).toBe(1);
      expect(result.stderr, label).toBe(symlinkMessage(`apps/frontend/${link}`));
      expect(result.stdout, label).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30000);

test('SDK-003 checker reports the first symlink in code unit order, before any import rule, and fails on a symlink in the build output', async () => {
  const directory = await workspaceFixture({
    'src/app/app.ts': "import 'node:fs';",
    'src/app/z.ts': "export const z = 'safe';",
  });
  try {
    await symlink('./z.ts', join(directory, 'apps/frontend/src/app/z-link.ts'));
    await symlink('./z.ts', join(directory, 'apps/frontend/src/app/b-link.ts'));
    const source = await runChecker(directory);
    expect(source.code).toBe(1);
    expect(source.stderr).toBe(symlinkMessage('apps/frontend/src/app/b-link.ts'));

    await rm(join(directory, 'apps/frontend/src/app/z-link.ts'));
    await rm(join(directory, 'apps/frontend/src/app/b-link.ts'));
    await Bun.write(join(directory, 'apps/frontend/src/app/app.ts'), "export const app = 'safe';");
    await Bun.write(join(directory, 'outside.js'), 'postgresql://fixture:secret@localhost/x');
    await symlink('../../../outside.js', join(directory, 'apps/frontend/dist/main.js'));
    const output = await runChecker(directory);
    expect(output.code).toBe(1);
    expect(output.stderr).toBe(symlinkMessage('apps/frontend/dist/main.js'));
    expect(output.output).not.toContain('fixture:secret');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
