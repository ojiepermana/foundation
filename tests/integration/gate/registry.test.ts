import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  definedCriteria,
  fileState,
  formatViolation,
  hasTagLiteral,
  readRegistries,
  repositoryPath,
  runScenarioValidation,
  stringLiterals,
  validateRegistries,
} from '../../../scripts/lib/scenario-registry.ts';
import { link, lines, removeWorkspaces, workspace, writeFiles } from './workspace.ts';

// GATE-002 (spec 0010, AC-2): `test:scenarios` validates every registry in one fixed shape and reports every violation
// at once, with the registry path and the ID but never the content of a file. Fixtures are written at runtime in a
// `mkdtemp` workspace outside the repository.

afterEach(removeWorkspaces);

const repositoryRoot = join(import.meta.dir, '../../..');

/** Text that must never appear in the output: it only lives inside a test file and a source document. */
const fileSentinel = 'gate002filecontentsentinel';
const sourceSentinel = 'gate002sourcecontentsentinel';

const fixtureFiles: Record<string, string> = {
  'package.json': JSON.stringify({
    scripts: {
      'test:gate': 'bun test ./tests/integration/gate',
      'test:e2e': 'playwright test',
      'test:frontend': 'ng test',
      'test:ci': 'bun scripts/gate.ts fast',
      'check:workflow': 'bun scripts/check-workflow.ts',
      'test:scenarios': 'bun scripts/validate-scenarios.ts',
      'dev:backend': 'bun apps/backend/src/index.ts',
    },
  }),
  // AC-1 is only mentioned in text and AC-10 is a list item, so AC-1 is not defined; AC-2 is a numbered item.
  'docs/specs/0001-fixture/index.md': [
    '# Fixture',
    '',
    `Teks bebas menyebut AC-1 dan ${sourceSentinel}.`,
    '',
    '- **AC-10**: kriteria sepuluh.',
    '1. **AC-2**: kriteria dua.',
    '',
  ].join('\n'),
  'docs/rules/fixture.md': '# Aturan\n\n- **AC-1**: aturan satu.\n',
  'tests/integration/gate/fixture.test.ts': [
    "import { test } from 'bun:test';",
    `// GATE-902 appears only in this comment, next to ${fileSentinel}.`,
    "test('GATE-901 a plain literal', () => {});",
    'test(`GATE-903 a template head ${1 + 1}`, () => {});',
    "test(`GATE-907 a template without substitution`, () => {});",
    `const unused = '${fileSentinel}';`,
    '',
  ].join('\n'),
  'tests/e2e/fixture/flow.e2e.spec.ts': "import { test } from '@playwright/test';\ntest.describe('GATE-904 outer block', () => {});\n",
  'apps/frontend/src/app/fixture.spec.ts': "describe('GATE-905 component', () => {});\n",
};

type Check = Record<string, unknown>;
const gate = (file: string, testTag?: string): Check => ({ runner: 'bun:test', script: 'test:gate', file, ...(testTag === undefined ? {} : { testTag }) });
const command = (script: string, file = 'package.json', testTag?: string): Check => ({ runner: 'command', script, file, ...(testTag === undefined ? {} : { testTag }) });

const validRegistries: Record<string, unknown> = {
  'tests/scenarios/valid.json': {
    source: 'docs/specs/0001-fixture/index.md',
    scenarios: [
      { id: 'GATE-901', criteria: ['AC-2'], checks: [gate('tests/integration/gate/fixture.test.ts', 'GATE-901')] },
      { id: 'GATE-903', criteria: ['AC-10'], critical: false, checks: [gate('tests/integration/gate/fixture.test.ts', 'GATE-903')] },
      {
        id: 'GATE-904',
        criteria: ['AC-2', 'AC-10'],
        critical: true,
        checks: [{ runner: 'playwright', script: 'test:e2e', file: 'tests/e2e/fixture/flow.e2e.spec.ts', testTag: 'GATE-904' }],
      },
      {
        id: 'GATE-905',
        criteria: ['AC-2'],
        checks: [
          { runner: 'vitest', script: 'test:frontend', file: 'apps/frontend/src/app/fixture.spec.ts', testTag: 'GATE-905' },
          // A command check may carry a registered tag; its file content is not read.
          command('check:workflow', 'package.json', 'GATE-901'),
          // A command check may name the root script of a tier.
          command('test:ci'),
        ],
      },
      { id: 'GATE-907', criteria: ['AC-2'], checks: [gate('tests/integration/gate/fixture.test.ts', 'GATE-907')] },
    ],
  },
  'tests/scenarios/rules.json': {
    source: 'docs/rules/fixture.md',
    scenarios: [{ id: 'GATE-906', criteria: ['AC-1'], checks: [command('test:scenarios')] }],
  },
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function fixture(registries: Record<string, unknown> = validRegistries): Promise<string> {
  const dir = await workspace(fixtureFiles);
  await writeFiles(dir, Object.fromEntries(Object.entries(registries).map(([path, value]) => [path, json(value)])));
  return dir;
}

test('GATE-002 tags count only as string literals, template heads, or templates read by the TypeScript parser', () => {
  const literals = stringLiterals('fixture.test.ts', fixtureFiles['tests/integration/gate/fixture.test.ts']!);
  expect(hasTagLiteral(literals, 'GATE-901')).toBe(true);
  expect(hasTagLiteral(literals, 'GATE-903')).toBe(true);
  expect(hasTagLiteral(literals, 'GATE-907')).toBe(true);
  expect(hasTagLiteral(literals, 'GATE-902')).toBe(false);
  // The tag must be followed by a space, so GATE-90 does not match GATE-901.
  expect(hasTagLiteral(literals, 'GATE-90')).toBe(false);
});

test('GATE-002 criteria are list items that start with **AC-n**:, never a substring', () => {
  expect([...definedCriteria(fixtureFiles['docs/specs/0001-fixture/index.md']!)].sort()).toEqual(['AC-10', 'AC-2']);
  expect([...definedCriteria('  - **AC-3**: indented\n**AC-4**: not a list item\n- AC-5: no bold\n12. **AC-6**: numbered\n')].sort()).toEqual([
    'AC-3',
    'AC-6',
  ]);
});

test('GATE-002 a valid fixture passes, including a command check with a registered tag and a tier root script', async () => {
  const dir = await fixture();
  const output = lines();
  expect(await runScenarioValidation(dir, output.log, output.error)).toBe(0);
  expect(output.err).toEqual([]);
  expect(output.out).toEqual(['Scenario registries passed (6 unique IDs, 8 checks).']);
});

test('GATE-002 every violation is reported in one run with the registry path and ID, without file content', async () => {
  const dir = await fixture({
    ...validRegistries,
    'tests/scenarios/invalid.json': {
      source: 'docs/specs/0001-fixture/index.md',
      owner: 'not a registry field',
      scenarios: [
        { id: 'GATE-901', criteria: ['AC-2'], checks: [gate('tests/integration/gate/fixture.test.ts', 'GATE-901')] },
        { id: 'gate-1', criteria: ['AC-2'], checks: [command('test:scenarios')] },
        { id: 'GATE-910', criteria: ['AC-1'], checks: [command('test:scenarios')] },
        { id: 'GATE-911', criteria: [], checks: [command('test:scenarios')] },
        { id: 'GATE-912', criteria: ['AC-2'], checks: [] },
        { id: 'GATE-913', criteria: ['AC-2'], checks: [gate('tests/integration/gate/missing.test.ts', 'GATE-901')] },
        { id: 'GATE-914', criteria: ['AC-2'], checks: [command('test:scenarios', '/etc/hosts')] },
        { id: 'GATE-915', criteria: ['AC-2'], checks: [command('test:scenarios', 'tests/../package.json')] },
        { id: 'GATE-916', criteria: ['AC-2'], checks: [gate('tests/integration/gate/linked.test.ts', 'GATE-901')] },
        { id: 'GATE-917', criteria: ['AC-2'], checks: [command('test:nothing')] },
        { id: 'GATE-918', criteria: ['AC-2'], checks: [command('dev:backend')] },
        { id: 'GATE-919', criteria: ['AC-2'], checks: [{ ...gate('tests/integration/gate/fixture.test.ts', 'GATE-901'), runner: 'vitest' }] },
        { id: 'GATE-920', criteria: ['AC-2'], checks: [gate('tests/e2e/fixture/flow.e2e.spec.ts', 'GATE-904')] },
        { id: 'GATE-902', criteria: ['AC-2'], checks: [gate('tests/integration/gate/fixture.test.ts', 'GATE-902')] },
        { id: 'GATE-921', criteria: ['AC-2'], checks: [gate('tests/integration/gate/fixture.test.ts', 'GATE-999')] },
        { id: 'GATE-922', criteria: ['AC-2'], checks: [gate('tests/integration/gate/fixture.test.ts')] },
        { id: 'GATE-923', criteria: ['AC-2'], ...gate('tests/integration/gate/fixture.test.ts', 'GATE-901') },
        { id: 'GATE-924', criteria: ['AC-2'], note: 'x', checks: [{ ...command('test:scenarios'), timeout: 5 }] },
        { id: 'GATE-925', criteria: ['AC-2'], critical: true, checks: [gate('tests/integration/gate/fixture.test.ts', 'GATE-901')] },
        { id: 'GATE-926', criteria: ['AC-2'], checks: [{ ...command('test:scenarios'), runner: 'jest' }] },
        { id: 'GATE-927', criteria: ['AC-2'], critical: 'yes', checks: [command('test:scenarios', 'package.json', 'GATE-999')] },
      ],
    },
    'tests/scenarios/missing-source.json': { source: 'docs/specs/9999-none/index.md', scenarios: [{ id: 'GATE-930', criteria: ['AC-1'], checks: [command('test:scenarios')] }] },
    'tests/scenarios/outside-source.json': { source: 'README.md', scenarios: [{ id: 'GATE-931', criteria: ['AC-1'], checks: [command('test:scenarios')] }] },
  });
  await writeFiles(dir, { 'README.md': '- **AC-1**: not a spec\n' });
  await link(dir, 'tests/integration/gate/linked.test.ts', 'fixture.test.ts');

  const output = lines();
  expect(await runScenarioValidation(dir, output.log, output.error)).toBe(1);
  expect(output.out).toEqual([]);
  const expected = [
    'tests/scenarios/invalid.json -: field registry tidak dikenal owner',
    'tests/scenarios/valid.json GATE-901: ID ganda, sudah terdaftar di tests/scenarios/invalid.json',
    'tests/scenarios/invalid.json -: ID skenario ke-2 gate-1 tidak cocok ^[A-Z]+-\\d{3}$',
    'tests/scenarios/missing-source.json -: source docs/specs/9999-none/index.md tidak ada',
    'tests/scenarios/outside-source.json -: source wajib path relatif di docs/specs/ atau docs/rules/',
    'tests/scenarios/invalid.json GATE-910: kriteria AC-1 bukan butir **AC-1**: di docs/specs/0001-fixture/index.md',
    'tests/scenarios/invalid.json GATE-911: criteria wajib array yang tidak kosong',
    'tests/scenarios/invalid.json GATE-912: checks wajib array yang tidak kosong',
    'tests/scenarios/invalid.json GATE-913: check ke-1: file tests/integration/gate/missing.test.ts tidak ada',
    'tests/scenarios/invalid.json GATE-914: check ke-1: file wajib path relatif di dalam repository tanpa ..',
    'tests/scenarios/invalid.json GATE-915: check ke-1: file wajib path relatif di dalam repository tanpa ..',
    'tests/scenarios/invalid.json GATE-916: check ke-1: file tests/integration/gate/linked.test.ts berupa symlink',
    'tests/scenarios/invalid.json GATE-917: check ke-1: script test:nothing tidak ada di package.json',
    'tests/scenarios/invalid.json GATE-918: check ke-1: script dev:backend bukan langkah tier gate',
    'tests/scenarios/invalid.json GATE-919: check ke-1: runner vitest tidak cocok dengan pemilik test:gate (bun:test)',
    'tests/scenarios/invalid.json GATE-920: check ke-1: file tests/e2e/fixture/flow.e2e.spec.ts tidak dimiliki test:gate menurut tabel pemilik runner',
    'tests/scenarios/invalid.json GATE-902: check ke-1: file tests/integration/gate/fixture.test.ts tidak memuat literal string yang diawali "GATE-902 "',
    'tests/scenarios/invalid.json GATE-921: check ke-1: testTag GATE-999 bukan ID terdaftar',
    'tests/scenarios/invalid.json GATE-922: check ke-1: testTag wajib untuk runner bun:test',
    'tests/scenarios/invalid.json GATE-923: bentuk inline tidak diizinkan (runner); pakai checks',
    'tests/scenarios/invalid.json GATE-923: bentuk inline tidak diizinkan (script); pakai checks',
    'tests/scenarios/invalid.json GATE-923: bentuk inline tidak diizinkan (file); pakai checks',
    'tests/scenarios/invalid.json GATE-923: bentuk inline tidak diizinkan (testTag); pakai checks',
    'tests/scenarios/invalid.json GATE-923: checks wajib array yang tidak kosong',
    'tests/scenarios/invalid.json GATE-924: field skenario tidak dikenal note',
    'tests/scenarios/invalid.json GATE-924: check ke-1: field tidak dikenal timeout',
    'tests/scenarios/invalid.json GATE-925: skenario critical tanpa check playwright pada script tier',
    'tests/scenarios/invalid.json GATE-926: check ke-1: runner jest tidak dikenal',
    'tests/scenarios/invalid.json GATE-927: critical wajib boolean',
    'tests/scenarios/invalid.json GATE-927: check ke-1: testTag GATE-999 bukan ID terdaftar',
  ];
  expect(output.err[0]).toBe(`Validasi registry skenario gagal dengan ${expected.length} pelanggaran:`);
  expect(output.err.slice(1).map((line) => line.trim()).sort()).toEqual([...expected].sort());
  const printed = output.err.join('\n');
  for (const text of [fileSentinel, sourceSentinel, 'not a registry field', 'appears only in this comment']) expect(printed).not.toContain(text);
});

test('GATE-002 a registry that is not JSON or not an object is reported, and the other registries are still validated', async () => {
  const dir = await fixture();
  await writeFiles(dir, { 'tests/scenarios/broken.json': '{ "source": ', 'tests/scenarios/list.json': '[]\n' });
  const result = await validateRegistries({ root: dir });
  expect(result.violations.map(formatViolation)).toEqual([
    'tests/scenarios/broken.json -: JSON tidak valid',
    'tests/scenarios/list.json -: registry wajib berupa objek',
  ]);
  expect(result.ids).toBe(6);
});

/** Every ID that existed before spec 0010; none may be removed or renumbered (key invariant 8). */
const existingIds = [
  ...['APP-001', 'APP-002', 'APP-003', 'APP-004'],
  ...['DATA-001', 'DATA-002', 'DATA-003', 'DATA-004', 'DATA-005'],
  ...['TOOL-001', 'TOOL-002', 'TOOL-003', 'TOOL-004', 'TOOL-005', 'TOOL-006', 'TOOL-007', 'TOOL-008'],
  ...['INFRA-001', 'INFRA-002', 'INFRA-003', 'INFRA-004', 'INFRA-005', 'INFRA-006'],
  ...['MIG-001', 'MIG-002', 'MIG-003', 'MIG-004', 'MIG-005'],
  ...['OPENAPI-001', 'OPENAPI-002', 'OPENAPI-003', 'OPENAPI-004', 'OPENAPI-005', 'OPENAPI-006', 'OPENAPI-007'],
  ...['READY-001', 'READY-002', 'READY-003', 'READY-004', 'READY-005', 'READY-006', 'READY-007', 'READY-008', 'READY-009', 'READY-010'],
  ...['SDK-001', 'SDK-002', 'SDK-003', 'SDK-004', 'SDK-005', 'SDK-006', 'SDK-007', 'SDK-008', 'SDK-009', 'SDK-010'],
  ...['UI-001', 'UI-002', 'UI-003'],
];

test('GATE-002 the repository registries pass, keep every existing ID, and flag the four critical flows', async () => {
  expect(existingIds).toHaveLength(58);
  const result = await validateRegistries({ root: repositoryRoot });
  expect(result.violations.map(formatViolation)).toEqual([]);
  const scenarios = (await readRegistries(repositoryRoot)).flatMap((registry) => registry.scenarios);
  const ids = scenarios.map((scenario) => scenario.id);
  expect(result.ids).toBe(ids.length);
  for (const id of [...existingIds, 'GATE-001', 'GATE-002', 'GATE-003']) expect(ids, id).toContain(id);
  expect(scenarios.filter((scenario) => scenario.critical).map((scenario) => scenario.id).sort()).toEqual([
    'APP-002',
    'READY-006',
    'READY-009',
    'UI-001',
  ]);
  // The three scenarios that used the inline form keep their check, now inside checks.
  for (const id of ['TOOL-003', 'TOOL-006', 'TOOL-008']) {
    expect(scenarios.find((scenario) => scenario.id === id)?.checks).toEqual([
      { runner: 'bun:test', script: 'test:tooling', file: 'tests/integration/tooling/development.test.ts', testTag: id },
    ]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Added by /test (spec 0010): the path, file, and criterion rules on their own.

test('GATE-002 a check path is canonical and relative, a file is regular, and no segment on the way may be a symlink', async () => {
  // covers: AC-2 (file reguler dengan path relatif di dalam repository tanpa .. dan tanpa symlink)
  for (const path of ['tests/a.test.ts', 'a', 'apps/frontend/src/app/x.spec.ts']) expect(repositoryPath(path), path).toBe(true);
  for (const path of ['', '/abs/a.ts', './a.ts', 'a/./b.ts', 'a//b.ts', 'a/../b.ts', '..', 'a/', 'a\\b.ts', 'a\0b', 7, null]) {
    expect(repositoryPath(path), String(path)).toBe(false);
  }
  const dir = await workspace({ 'real/inner/a.test.ts': '', 'folder/x.txt': '' });
  await link(dir, 'linked', 'real');
  await link(dir, 'real/alias.test.ts', 'inner/a.test.ts');
  expect(await fileState(dir, 'real/inner/a.test.ts')).toBe('regular');
  expect(await fileState(dir, 'folder')).toBe('not_regular');
  expect(await fileState(dir, 'real/missing.test.ts')).toBe('missing');
  expect(await fileState(dir, 'folder/x.txt/deeper.ts')).toBe('missing');
  expect(await fileState(dir, 'real/alias.test.ts')).toBe('symlink');
  // A symlinked folder in the middle of the path is caught too, although the target file is regular.
  expect(await fileState(dir, 'linked/inner/a.test.ts')).toBe('symlink');
});

test('GATE-002 a criterion is defined only by a dash or numbered list item that starts with **AC-n**:', () => {
  // covers: AC-2 (setiap kriteria didefinisikan sebagai butir daftar **AC-n**:)
  const text = [
    '- **AC-1**: satu.',
    '  - **AC-2**: butir bersarang.',
    '10. **AC-11**: butir bernomor dua digit.',
    '* **AC-3**: butir bintang tidak dihitung.',
    '- **AC-4** : spasi sebelum titik dua tidak dihitung.',
    '- AC-5: tanpa huruf tebal tidak dihitung.',
    'Teks **AC-6**: di tengah kalimat tidak dihitung.',
    '-**AC-7**: tanpa spasi sesudah tanda daftar tidak dihitung.',
    '\r',
    '- **AC-8**: baris dengan akhir CRLF.\r',
  ].join('\n');
  expect([...definedCriteria(text)].sort()).toEqual(['AC-1', 'AC-11', 'AC-2', 'AC-8']);
});
