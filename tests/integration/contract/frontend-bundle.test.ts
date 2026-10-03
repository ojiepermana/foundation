import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../../', import.meta.url).pathname;
const checker = join(root, 'scripts/check-frontend-bundle.ts');

async function fixture(source: string, asset = '<main>safe</main>'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'foundation-frontend-bundle-'));
  const sourceDirectory = join(directory, 'apps/frontend/src/app');
  const outputDirectory = join(directory, 'apps/frontend/dist');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await Bun.write(join(sourceDirectory, 'app.ts'), source);
  await Bun.write(join(outputDirectory, 'index.html'), asset);
  return directory;
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
  return { code, output: stdout + stderr };
}

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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);
}
