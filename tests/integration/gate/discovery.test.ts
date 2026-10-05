import { afterEach, expect, test } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAngularList, parsePlaywrightList, runTestDiscovery } from '../../../scripts/check-test-discovery.ts';
import { tierSteps, TIERS } from '../../../scripts/lib/gate.ts';
import { parseJUnit } from '../../../scripts/lib/junit.ts';
import {
  compareList,
  inventory,
  isTestFile,
  junitDiscovery,
  junitSuitePath,
  ownersOf,
  runnerOwner,
  RUNNER_OWNERS,
  type RunnerOwner,
} from '../../../scripts/lib/test-inventory.ts';
import { lines, link, removeWorkspaces, workspace } from './workspace.ts';

// GATE-001 (spec 0010, AC-1): every test file is owned by exactly one runner, the runner lists match the owned sets in
// both directions, and a JUnit file holds exactly the files its script owns. Every fixture is written at runtime in a
// `mkdtemp` workspace outside the repository.

afterEach(removeWorkspaces);

/** Files a correct workspace holds: each owned by the runner the owner table names. */
const ownedFiles: Record<string, string> = {
  'apps/frontend/src/app/home.spec.ts': '',
  'apps/frontend/src/app/home.test.ts': '',
  'tests/e2e/flow/home.e2e.spec.ts': '',
  'tests/e2e/flow/home.real.e2e.spec.ts': '',
  'tests/integration/backend/status.test.ts': '',
  'tests/integration/contract/sdk.test.ts': '',
  'tests/integration/tooling/serve.test.ts': '',
  'tests/integration/gate/report.test.ts': '',
  'tests/integration/database/migration.test.ts': '',
  'tests/integration/database/provision.test.ts': '',
  'tests/integration/infrastructure/postgres.test.ts': '',
};

/** Names that are not test files, or folders the inventory never enters. */
const ignoredFiles: Record<string, string> = {
  'apps/frontend/tsconfig.spec.json': '{}',
  'tests/integration/infrastructure/compose.test.yml': 'services: {}\n',
  'tests/integration/tooling-real/doctor-smoke.ts': '',
  'tests/orchestration/readiness-real.ts': '',
  'node_modules/pkg/index.test.ts': '',
  'apps/frontend/node_modules/pkg/index.spec.ts': '',
  'dist/backend/index.test.ts': '',
  'apps/frontend/.angular/cache/x.spec.ts': '',
  '.local/feature-4/x.test.ts': '',
  '.cache/x.test.ts': '',
  'test-results/run/x.spec.ts': '',
  'graphify-out/x.test.ts': '',
};

/** Files that match the discovery pattern but no owner row. */
const unownedFiles = [
  'apps/backend/src/features/users/service.test.ts',
  'scripts/lib/tool.test.ts',
  'tests/integration/x.spec.js',
  'tests/integration/x.spec.ts',
  'tests/orchestration/run.test.ts',
];

test('GATE-001 the discovery pattern is the union of the Bun, Vitest, and Playwright defaults', () => {
  for (const name of ['a.test.ts', 'a.spec.ts', 'a_test.js', 'a_spec.mjs', 'a.test.tsx', 'a.spec.cts', 'a.e2e.spec.ts', 'a.real.e2e.spec.ts']) {
    expect(isTestFile(`dir/${name}`), name).toBe(true);
  }
  for (const name of ['tsconfig.spec.json', 'compose.test.yml', 'test.ts', 'spec.ts', 'a.test.ts.bak', 'a-test.ts', 'doctor-smoke.ts']) {
    expect(isTestFile(`dir/${name}`), name).toBe(false);
  }
});

test('GATE-001 the inventory rejects unowned test files and ignores non test names and skipped folders', async () => {
  const dir = await workspace({ ...ownedFiles, ...ignoredFiles, ...Object.fromEntries(unownedFiles.map((path) => [path, ''])) });
  const found = await inventory(dir);

  expect(found.files.map((file) => file.path)).toEqual([...Object.keys(ownedFiles), ...unownedFiles].sort());
  expect(found.problems).toEqual(unownedFiles.map((path) => ({ code: 'unowned_file', script: null, path })));
  const owners = (path: string) => found.files.find((file) => file.path === path)?.owners.map((owner) => owner.script);
  // One runner may own a file through several scripts.
  expect(owners('tests/integration/database/migration.test.ts')).toEqual(['test:database:real', 'test:database:migration']);
  expect(owners('tests/e2e/flow/home.real.e2e.spec.ts')).toEqual(['test:readiness:real', 'test:tooling:real']);
  expect(owners('tests/e2e/flow/home.e2e.spec.ts')).toEqual(['test:e2e']);
  expect(owners('apps/frontend/src/app/home.test.ts')).toEqual(['test:frontend']);
  expect(owners('tests/integration/gate/report.test.ts')).toEqual(['test:gate']);
});

test('GATE-001 a file owned by two runners is rejected', async () => {
  const extra: RunnerOwner = {
    script: 'test:fixture',
    runner: 'bun:test',
    root: 'apps/frontend/src',
    include: ['apps/frontend/src/**/*.spec.ts'],
    exclude: [],
    config: null,
    junit: '.local/fixture.xml',
    junitPath: { from: 'file-attribute' },
  };
  const dir = await workspace({ 'apps/frontend/src/app/home.spec.ts': '', 'apps/frontend/src/app/home.test.ts': '' });
  const found = await inventory(dir, [...RUNNER_OWNERS, extra]);
  expect(found.problems).toEqual([{ code: 'two_runners', script: 'test:frontend, test:fixture', path: 'apps/frontend/src/app/home.spec.ts' }]);
  expect(ownersOf('apps/frontend/src/app/home.test.ts', [...RUNNER_OWNERS, extra]).map((owner) => owner.runner)).toEqual(['vitest']);
});

test('GATE-001 the Angular list is read from the lines after its header, relative to the frontend workspace', () => {
  const output = [
    'Warning: a line before the list',
    'Discovered test files:',
    '  src/app/app.spec.ts',
    '  src/app/features/readiness/readiness-page.spec.ts',
    '',
    'not indented, so not a path',
    '  src/app/app.spec.ts',
  ].join('\n');
  expect(parseAngularList(output, 'apps/frontend/')).toEqual([
    { path: 'apps/frontend/src/app/app.spec.ts', titles: [] },
    { path: 'apps/frontend/src/app/features/readiness/readiness-page.spec.ts', titles: [] },
  ]);
  expect(parseAngularList('Discovered test files:\r\n  src/a.spec.ts\r\n', 'apps/frontend/')).toEqual([{ path: 'apps/frontend/src/a.spec.ts', titles: [] }]);
  expect(parseAngularList('  src/app/app.spec.ts\n', 'apps/frontend/')).toBeNull();
});

test('GATE-001 the Playwright list gives files relative to the repository and full titles joined with ›', () => {
  const report = {
    config: { rootDir: '/repo/tests/e2e' },
    errors: [],
    suites: [
      {
        title: 'flow/home.e2e.spec.ts',
        file: 'flow/home.e2e.spec.ts',
        specs: [{ title: 'UI-001 top level test' }],
        suites: [{ title: 'APP-002 outer block', specs: [{ title: 'inner test' }], suites: [{ title: 'deeper', specs: [{ title: 'last' }] }] }],
      },
      { title: 'a.e2e.spec.ts', file: 'a.e2e.spec.ts', specs: [] },
    ],
  };
  expect(parsePlaywrightList(JSON.stringify(report), '/repo')).toEqual([
    { path: 'tests/e2e/a.e2e.spec.ts', titles: [] },
    {
      path: 'tests/e2e/flow/home.e2e.spec.ts',
      titles: ['UI-001 top level test', 'APP-002 outer block › inner test', 'APP-002 outer block › deeper › last'],
    },
  ]);
  expect(parsePlaywrightList('not json', '/repo')).toBeNull();
  expect(parsePlaywrightList(JSON.stringify({ ...report, errors: [{ message: 'syntax error' }] }), '/repo')).toBeNull();
  expect(parsePlaywrightList(JSON.stringify({ suites: [], errors: [] }), '/repo')).toBeNull();
  expect(parsePlaywrightList(JSON.stringify({ ...report, suites: [{ title: 'x' }] }), '/repo')).toBeNull();
});

test('GATE-001 a runner list is compared with the owned set in both directions', () => {
  const owned = new Set(['tests/e2e/a.e2e.spec.ts', 'tests/e2e/b.e2e.spec.ts']);
  expect(compareList(owned, ['tests/e2e/b.e2e.spec.ts', 'tests/e2e/c.e2e.spec.ts'])).toEqual({
    missing: ['tests/e2e/a.e2e.spec.ts'],
    extra: ['tests/e2e/c.e2e.spec.ts'],
  });
  expect(compareList(owned, [...owned])).toEqual({ missing: [], extra: [] });
});

test('GATE-001 a JUnit file that holds a foreign file or lacks an owned file is rejected', () => {
  const owner = runnerOwner('test:gate')!;
  const document = parseJUnit(
    [
      '<testsuites>',
      '<testsuite name="tests/integration/gate/a.test.ts" file="tests/integration/gate/a.test.ts"><testcase name="GATE-001 a"/></testsuite>',
      '<testsuite name="tests/integration/tooling/x.test.ts" file="tests/integration/tooling/x.test.ts"><testcase name="x"/></testsuite>',
      '</testsuites>',
    ].join(''),
  );
  const owned = new Set(['tests/integration/gate/a.test.ts', 'tests/integration/gate/b.test.ts']);
  expect(junitDiscovery(owner, document, owned)).toEqual([
    { code: 'junit_foreign_file', script: 'test:gate', path: 'tests/integration/tooling/x.test.ts' },
    { code: 'junit_missing_file', script: 'test:gate', path: 'tests/integration/gate/b.test.ts' },
  ]);
  expect(junitDiscovery(owner, document, new Set(['tests/integration/gate/a.test.ts', 'tests/integration/tooling/x.test.ts']))).toEqual([]);

  // Vitest and Playwright name the file in the testsuite name, relative to their own root.
  const vitest = parseJUnit('<testsuites><testsuite name="src/app/app.spec.ts"><testcase name="APP-002 x"/></testsuite></testsuites>');
  expect(junitDiscovery(runnerOwner('test:frontend')!, vitest, new Set(['apps/frontend/src/app/app.spec.ts']))).toEqual([]);
  const playwright = parseJUnit('<testsuites><testsuite name="flow/home.e2e.spec.ts"><testcase name="UI-001 x"/></testsuite></testsuites>');
  expect(junitDiscovery(runnerOwner('test:e2e')!, playwright, new Set(['tests/e2e/other.e2e.spec.ts']))).toEqual([
    { code: 'junit_foreign_file', script: 'test:e2e', path: 'tests/e2e/flow/home.e2e.spec.ts' },
    { code: 'junit_missing_file', script: 'test:e2e', path: 'tests/e2e/other.e2e.spec.ts' },
  ]);
});

// ---------------------------------------------------------------------------------------------------------------
// The command on a fixture workspace: the Angular CLI and Playwright are replaced by small Node scripts at the paths
// the command calls, so the real list commands, process groups, and step environment run end to end.

type PlaywrightFixture = Record<string, Array<{ file: string; titles: string[] }>>;

function fakeAngular(output: string, code = 0): string {
  return `process.stdout.write(${JSON.stringify(output)});\nprocess.exitCode = ${code};\n`;
}

function fakePlaywright(lists: PlaywrightFixture): string {
  return [
    "const path = require('node:path');",
    `const lists = ${JSON.stringify(lists)};`,
    "const config = process.argv[process.argv.indexOf('--config') + 1];",
    "const suites = (lists[config] || []).map((item) => ({ title: item.file, file: item.file, specs: item.titles.map((title) => ({ title })), suites: [] }));",
    "process.stdout.write(JSON.stringify({ config: { rootDir: path.join(process.cwd(), 'tests/e2e') }, suites, errors: [] }));",
  ].join('\n');
}

const consistentLists: PlaywrightFixture = {
  'playwright.config.ts': [{ file: 'flow/home.e2e.spec.ts', titles: ['GATE-801 home works'] }],
  'playwright.real.config.ts': [{ file: 'flow/home.real.e2e.spec.ts', titles: ['GATE-802 real home works'] }],
};

function registry(checks: Array<{ runner: string; script: string; file: string; testTag?: string }>): string {
  return JSON.stringify({ source: 'docs/specs/0001-fixture/index.md', scenarios: [{ id: 'GATE-801', criteria: ['AC-1'], checks }] });
}

const playwrightChecks = [
  { runner: 'playwright', script: 'test:e2e', file: 'tests/e2e/flow/home.e2e.spec.ts', testTag: 'GATE-801' },
  { runner: 'playwright', script: 'test:readiness:real', file: 'tests/e2e/flow/home.real.e2e.spec.ts', testTag: 'GATE-802' },
];

async function commandWorkspace(files: Record<string, string>): Promise<string> {
  return workspace({
    ...ownedFiles,
    'node_modules/@angular/cli/bin/ng.js': fakeAngular(
      'Discovered test files:\n  src/app/home.spec.ts\n  src/app/home.test.ts\n',
    ),
    'node_modules/@playwright/test/cli.js': fakePlaywright(consistentLists),
    'tests/scenarios/fixture.json': registry(playwrightChecks),
    ...files,
  });
}

test('GATE-001 check:test-discovery passes when every list matches its owners and counts files per runner', async () => {
  const dir = await commandWorkspace({});
  const output = lines();
  expect(await runTestDiscovery({ root: dir, ...output })).toBe(0);
  expect(output.err).toEqual([]);
  expect(output.out).toEqual([
    'Discovery test lulus: 11 file test, vitest apps/frontend/angular.json 2 file (test:frontend); ' +
      'playwright playwright.config.ts 1 file (test:e2e); playwright playwright.real.config.ts 1 file (test:readiness:real, test:tooling:real); ' +
      'bun:test 7 file (dibuktikan dari JUnit pada laporan).',
  ]);
}, 60_000);

test('GATE-001 check:test-discovery fails with the path of every unowned file, list difference, and missing tagged title', async () => {
  const dir = await commandWorkspace({
    'tests/orchestration/run.test.ts': '',
    // Angular does not list home.test.ts, which test:frontend owns.
    'node_modules/@angular/cli/bin/ng.js': fakeAngular('Discovered test files:\n  src/app/home.spec.ts\n'),
    // Playwright lists a file that no script owns and gives the real test a title without its tag.
    'node_modules/@playwright/test/cli.js': fakePlaywright({
      'playwright.config.ts': [
        { file: 'flow/home.e2e.spec.ts', titles: ['GATE-801 home works'] },
        { file: 'flow/extra.spec.ts', titles: ['extra'] },
      ],
      'playwright.real.config.ts': [{ file: 'flow/home.real.e2e.spec.ts', titles: ['real home works, GATE-802 in the middle'] }],
    }),
  });
  const output = lines();
  expect(await runTestDiscovery({ root: dir, ...output })).toBe(1);
  expect(output.out).toEqual([]);
  expect(output.err).toEqual([
    'Discovery test gagal dengan 4 masalah:',
    '  unowned_file - tests/orchestration/run.test.ts: tidak dimiliki runner mana pun',
    '  list_differs test:frontend apps/frontend/src/app/home.test.ts: dimiliki script tetapi tidak ditemukan runner',
    '  list_differs test:e2e tests/e2e/flow/extra.spec.ts: ditemukan runner tetapi tidak dimiliki script',
    '  list_differs test:readiness:real tests/e2e/flow/home.real.e2e.spec.ts: tidak ada test dengan judul lengkap yang diawali "GATE-802 "',
  ]);
}, 60_000);

test('GATE-001 check:test-discovery fails with list_failed when a runner list exits non zero or lacks its format', async () => {
  const dir = await commandWorkspace({
    'node_modules/@angular/cli/bin/ng.js': fakeAngular('no header here\n', 3),
    'node_modules/@playwright/test/cli.js': "process.stdout.write('{\"config\":{}');\n",
  });
  const output = lines();
  expect(await runTestDiscovery({ root: dir, ...output })).toBe(1);
  expect(output.err).toEqual([
    'Discovery test gagal dengan 4 masalah:',
    '  list_failed test:frontend apps/frontend/angular.json: daftar runner tidak dapat dibaca',
    '  list_failed test:e2e playwright.config.ts: daftar runner tidak dapat dibaca',
    '  list_failed test:readiness:real playwright.real.config.ts: daftar runner tidak dapat dibaca',
    '  list_failed test:tooling:real playwright.real.config.ts: daftar runner tidak dapat dibaca',
  ]);
}, 60_000);

test('GATE-001 the list commands receive only the step environment, not a sentinel outside the allow list', async () => {
  const sentinel = 'gate001sentinelvalue';
  const dir = await commandWorkspace({
    // The fake Angular CLI fails when the sentinel reaches it, so the command fails with list_failed.
    'node_modules/@angular/cli/bin/ng.js': [
      `if (process.env.FOUNDATION_GATE_SENTINEL !== undefined || process.env.DATABASE_URL !== undefined) process.exit(9);`,
      `process.stdout.write('Discovered test files:\\n  src/app/home.spec.ts\\n  src/app/home.test.ts\\n');`,
    ].join('\n'),
  });
  const output = lines();
  const env = { ...process.env, FOUNDATION_GATE_SENTINEL: sentinel, DATABASE_URL: `postgres://user:${sentinel}@127.0.0.1/db` };
  expect(await runTestDiscovery({ root: dir, env, ...output })).toBe(0);
  expect([...output.out, ...output.err].join('\n')).not.toContain(sentinel);
}, 60_000);

test('GATE-001 the repository inventory has no unowned file, and every owner script exists and is a tier step', async () => {
  const root = await realpath(join(import.meta.dir, '../../..'));
  const found = await inventory(root);
  expect(found.problems).toEqual([]);
  expect(found.files.length).toBeGreaterThan(0);
  for (const file of found.files) expect(file.owners.length, file.path).toBeGreaterThan(0);
  // A new test location needs an owner row and a tier step for its script in the same commit (AC-1).
  const { scripts } = (await Bun.file(join(root, 'package.json')).json()) as { scripts: Record<string, string> };
  const steps = tierSteps();
  for (const owner of RUNNER_OWNERS) {
    expect(Object.hasOwn(scripts, owner.script), owner.script).toBe(true);
    expect(steps.has(owner.script), owner.script).toBe(true);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Added by /test (spec 0010): the owner table itself, its link to the tier evidence and the root scripts, and the walk
// over symlinks.

test('GATE-001 the owner table is Tabel pemilik runner, and every owner JUnit is the evidence its tier step declares', async () => {
  // covers: AC-1 (Tabel pemilik runner), AC-4 (Bukti per langkah)
  expect(
    RUNNER_OWNERS.map((owner) => [owner.script, owner.runner, owner.config, owner.include, owner.exclude, owner.junit, owner.junitPath]),
  ).toEqual([
    ['test:frontend', 'vitest', 'apps/frontend/angular.json', ['apps/frontend/src/**/*.spec.ts', 'apps/frontend/src/**/*.test.ts'], [], '.local/feature-4/frontend.xml', { from: 'suite-name', prefix: 'apps/frontend/' }],
    ['test:e2e', 'playwright', 'playwright.config.ts', ['tests/e2e/**/*.e2e.spec.ts'], ['tests/e2e/**/*.real.e2e.spec.ts'], '.local/feature-4/playwright.xml', { from: 'suite-name', prefix: 'tests/e2e/' }],
    ['test:readiness:real', 'playwright', 'playwright.real.config.ts', ['tests/e2e/**/*.real.e2e.spec.ts'], [], '.local/feature-10/playwright-real.xml', { from: 'suite-name', prefix: 'tests/e2e/' }],
    ['test:tooling:real', 'playwright', 'playwright.real.config.ts', ['tests/e2e/**/*.real.e2e.spec.ts'], [], '.local/feature-2/playwright-real.xml', { from: 'suite-name', prefix: 'tests/e2e/' }],
    ['test:integration', 'bun:test', null, ['tests/integration/backend/**/*.test.ts', 'tests/integration/contract/**/*.test.ts'], [], '.local/feature-4/server.xml', { from: 'file-attribute' }],
    ['test:tooling', 'bun:test', null, ['tests/integration/tooling/**/*.test.ts'], [], '.local/feature-4/tooling.xml', { from: 'file-attribute' }],
    ['test:gate', 'bun:test', null, ['tests/integration/gate/**/*.test.ts'], [], '.local/feature-11/gate.xml', { from: 'file-attribute' }],
    ['test:performance:plan', 'bun:test', null, ['tests/integration/performance/**/*.test.ts'], [], '.local/feature-12/plan.xml', { from: 'file-attribute' }],
    ['test:database:real', 'bun:test', null, ['tests/integration/database/**/*.test.ts'], [], '.local/feature-5/database.xml', { from: 'file-attribute' }],
    ['test:database:migration', 'bun:test', null, ['tests/integration/database/migration.test.ts'], [], '.local/feature-6/migration.xml', { from: 'file-attribute' }],
    ['test:infrastructure', 'bun:test', null, ['tests/integration/infrastructure/**/*.test.ts'], [], '.local/feature-3/infrastructure.xml', { from: 'file-attribute' }],
  ]);

  // The report finds a check's JUnit through the tier step of its script, so both tables must name the same file.
  const root = join(import.meta.dir, '../../..');
  const { scripts } = (await Bun.file(join(root, 'package.json')).json()) as { scripts: Record<string, string> };
  const steps = [TIERS.fast, TIERS.real, TIERS.security].flatMap((tier) => tier?.steps ?? []);
  for (const owner of RUNNER_OWNERS) {
    const step = steps.find((item) => item.script === owner.script);
    const junit = step?.evidence.filter((evidence) => evidence.kind === 'junit') ?? [];
    expect(junit.map((evidence) => [evidence.path, evidence.runner, evidence.required]), owner.script).toEqual([[owner.junit, owner.runner, true]]);
    if (owner.config !== null) expect(await Bun.file(join(root, owner.config)).exists(), owner.config).toBe(true);
    // A script that runs bun test directly writes its JUnit itself, to the path the table names (test:database:real
    // runs it through its orchestration, which builds the same path).
    const command = scripts[owner.script] ?? '';
    if (owner.runner === 'bun:test' && command.includes(' test ./')) expect(command, owner.script).toContain(`--reporter-outfile=${owner.junit}`);
  }
});

test('GATE-001 a JUnit path is the file attribute for bun:test and the suite name plus a prefix for Vitest and Playwright', () => {
  // covers: AC-1 (Normalisasi path JUnit), AC-6
  expect(junitSuitePath(runnerOwner('test:gate')!, { name: 'ignored', file: 'tests/integration/gate/a.test.ts' })).toBe('tests/integration/gate/a.test.ts');
  expect(junitSuitePath(runnerOwner('test:frontend')!, { name: 'src/app/app.spec.ts', file: 'ignored' })).toBe('apps/frontend/src/app/app.spec.ts');
  expect(junitSuitePath(runnerOwner('test:readiness:real')!, { name: 'readiness/flow.real.e2e.spec.ts' })).toBe('tests/e2e/readiness/flow.real.e2e.spec.ts');
  // A suite that names no file is never a file of the script: it is neither foreign nor counted as present.
  expect(junitSuitePath(runnerOwner('test:gate')!, { name: 'tests/integration/gate/a.test.ts' })).toBeNull();
  expect(junitSuitePath(runnerOwner('test:e2e')!, { name: '' })).toBeNull();
  const document = parseJUnit('<testsuites><testsuite name="a.test.ts"><testcase name="GATE-001 x"/></testsuite></testsuites>');
  expect(junitDiscovery(runnerOwner('test:gate')!, document, new Set(['tests/integration/gate/a.test.ts']))).toEqual([
    { code: 'junit_missing_file', script: 'test:gate', path: 'tests/integration/gate/a.test.ts' },
  ]);
});

test('GATE-001 the inventory never enters a symlinked folder and lists a symlink named like a test file as a file', async () => {
  // covers: AC-1 (Inventaris tidak mengikuti symlink)
  const dir = await workspace({
    'tests/integration/gate/real.test.ts': '',
    'outside/hidden.test.ts': '',
  });
  await link(dir, 'tests/integration/gate/linked', '../../../outside');
  await link(dir, 'tests/integration/gate/alias.test.ts', 'real.test.ts');
  await link(dir, 'tests/orchestration/alias.test.ts', '../integration/gate/real.test.ts');
  const found = await inventory(dir);
  expect(found.files.map((file) => file.path)).toEqual([
    'outside/hidden.test.ts',
    'tests/integration/gate/alias.test.ts',
    'tests/integration/gate/real.test.ts',
    'tests/orchestration/alias.test.ts',
  ]);
  expect(found.problems).toEqual([
    { code: 'unowned_file', script: null, path: 'outside/hidden.test.ts' },
    { code: 'unowned_file', script: null, path: 'tests/orchestration/alias.test.ts' },
  ]);
});
