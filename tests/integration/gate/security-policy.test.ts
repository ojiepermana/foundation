import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcessGroup } from '../../../scripts/lib/process-group.ts';
import { groupAlive } from '../../../scripts/lib/process-identity.ts';
import {
  bunAuditBlocked,
  dependencyExceptionVerdict,
  evaluateActionlint,
  evaluateBunAudit,
  evaluateGitleaks,
  FAIL_SEVERITY,
  gitleaksBlocked,
  readExceptions,
  readLockPackages,
  readPins,
  scannerConfigsInRepo,
  SCANNER_OUTPUT_LIMIT,
  scannerResult,
  securityReport,
  withConfigInRepo,
  type DependencyException,
  type SecretException,
} from '../../../scripts/lib/security-policy.ts';
import {
  auditEnvironment,
  containerArguments,
  containerName,
  containerUser,
  EMPTY_TREE,
  runSecurityScan,
  SCAN_LIMITS,
  type ScanLimits,
} from '../../orchestration/security-scan.ts';
import { emptyWorkspace, lines, removeWorkspaces, workspace } from './workspace.ts';

// GATE-007 (spec 0010, AC-5 and AC-8, rows *Pemanggilan pemindai* and *Kebijakan pemindai*): the scanner policy from
// fixture output of gitleaks, `bun audit`, and actionlint; the locked files in tests/security/; the container
// arguments; the named fields of security.json; and `check:security` itself on `mkdtemp` workspaces with a fake
// `docker` at the front of PATH, so no image, network, or daemon is needed. The real scan runs through
// `bun run check:security`.

afterEach(removeWorkspaces);

const root = resolve(import.meta.dir, '../../..');
const scanModule = join(root, 'tests/orchestration/security-scan.ts');
const scanDate = '2026-10-04';
const commit = 'a'.repeat(40);
const gitleaksImage = 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
const actionlintImage = 'rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667';

/** One raw gitleaks finding with every field gitleaks writes, including the ones security.json must drop. */
function leak(file: string, line: number) {
  return {
    RuleID: 'generic-api-key', Description: 'Generic API Key', StartLine: line, EndLine: line, StartColumn: 3, EndColumn: 40,
    Match: 'api_key = "sentinel-match-value"', Secret: 'sentinel-secret-value', File: file, SymlinkFile: '', Commit: commit,
    Link: 'https://example.test/commit', Entropy: 4.2, Author: 'Sentinel Author', Email: 'sentinel@example.test',
    Date: '2026-10-01T00:00:00Z', Message: 'sentinel commit message', Tags: [], Fingerprint: `${commit}:${file}:generic-api-key:${line}`,
  };
}

function advisory(id: string, severity: string, range: string) {
  return { id: 1, url: `https://github.com/advisories/${id}`, title: 'Sentinel title', severity, vulnerable_versions: range, cwe: [], cvss: { score: 0 } };
}

const lock = `{
  "lockfileVersion": 1,
  "packages": {
    "postcss": ["postcss@8.5.6", "", {}, "sha512-x"],
    "vite/postcss": ["postcss@8.5.28", "", {}, "sha512-y"],
    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-z"],
  },
}`;
const packages = readLockPackages(lock)!.packages;

function dependency(advisoryId: string, name: string, recorded: string, expires: string): DependencyException {
  return { advisory: advisoryId, package: name, reason: 'fixture', owner: 'fixture', recorded, expires };
}

test('GATE-007 a gitleaks finding fails unless its fingerprint has an exception, and an unused exception is reported', () => {
  const findings = [leak('src/a.ts', 3), leak('src/b.ts', 7)];
  const exceptions: SecretException[] = [
    { fingerprint: findings[1]!.Fingerprint, reason: 'false positive', owner: 'fixture', recorded: '2026-10-01' },
    { fingerprint: `${commit}:src/gone.ts:generic-api-key:1`, reason: 'fixed', owner: 'fixture', recorded: '2026-10-01' },
  ];
  const result = evaluateGitleaks({ code: 2, stdout: JSON.stringify(findings) }, exceptions, scanDate);
  expect(result.status).toBe('failed');
  expect(result.reason).toBeNull();
  expect(result.findings.map((finding) => finding.policy)).toEqual(['failed', 'excepted']);
  expect(result.counts).toEqual({ failed: 1, excepted: 1, reported: 0 });
  expect(result.unusedExceptions).toEqual([{ fingerprint: `${commit}:src/gone.ts:generic-api-key:1` }]);

  const allExcepted = evaluateGitleaks({ code: 2, stdout: JSON.stringify([findings[1]]) }, exceptions, scanDate);
  expect(allExcepted.status).toBe('passed');
  expect(allExcepted.counts).toEqual({ failed: 0, excepted: 1, reported: 0 });

  // An exception dated after the scan never applies.
  const future = [{ ...exceptions[0]!, recorded: '2026-10-05' }];
  expect(evaluateGitleaks({ code: 2, stdout: JSON.stringify([findings[1]]) }, future, scanDate).findings[0]!.policy).toBe('failed');
});

test('GATE-007 bun audit: high fails, moderate and low are reported, and an unknown severity fails', () => {
  const output = {
    postcss: [advisory('GHSA-6g55-p6wh-862q', 'high', '<=8.5.11'), advisory('GHSA-qx2v-qp2m-jg93', 'moderate', '<8.5.10')],
    'left-pad': [advisory('GHSA-aaaa-bbbb-cccc', 'low', '<2.0.0')],
  };
  const result = evaluateBunAudit({ code: 1, stdout: JSON.stringify(output) }, packages, [], scanDate);
  expect(FAIL_SEVERITY).toBe('high');
  expect(result.status).toBe('failed');
  expect(result.reason).toBeNull();
  expect(result.findings).toEqual([
    { advisory: 'GHSA-6g55-p6wh-862q', package: 'postcss', severity: 'high', vulnerableVersions: '<=8.5.11', installedVersions: ['8.5.6'], policy: 'failed' },
    { advisory: 'GHSA-qx2v-qp2m-jg93', package: 'postcss', severity: 'moderate', vulnerableVersions: '<8.5.10', installedVersions: ['8.5.6'], policy: 'reported' },
    { advisory: 'GHSA-aaaa-bbbb-cccc', package: 'left-pad', severity: 'low', vulnerableVersions: '<2.0.0', installedVersions: ['1.3.0'], policy: 'reported' },
  ]);
  expect(result.counts).toEqual({ failed: 1, excepted: 0, reported: 2 });

  const onlyModerate = evaluateBunAudit({ code: 1, stdout: JSON.stringify({ postcss: [output.postcss[1]] }) }, packages, [], scanDate);
  expect(onlyModerate.status).toBe('passed');

  const unknown = evaluateBunAudit({ code: 1, stdout: JSON.stringify({ postcss: [advisory('GHSA-dddd-eeee-ffff', 'info', '<9.0.0')] }) }, packages, [], scanDate);
  expect(unknown.status).toBe('failed');
  expect(unknown.reason).toBe('severity_unknown');
  expect(unknown.findings[0]!.policy).toBe('failed');
  // Every installed copy in the range is listed, in semver order.
  expect(unknown.findings[0]).toMatchObject({ installedVersions: ['8.5.6', '8.5.28'] });
});

test('GATE-007 a dependency exception applies up to and including expires, then fails; longer than 90 days is refused', () => {
  const high = { 'left-pad': [advisory('GHSA-aaaa-bbbb-cccc', 'critical', '<2.0.0')] };
  const run = { code: 1, stdout: JSON.stringify(high) };
  const evaluate = (exception: DependencyException, date = scanDate) => evaluateBunAudit(run, packages, [exception], date);

  const active = evaluate(dependency('GHSA-aaaa-bbbb-cccc', 'left-pad', '2026-09-01', '2026-10-04'));
  expect(active.status).toBe('passed');
  expect(active.findings[0]!.policy).toBe('excepted');
  expect(active.unusedExceptions).toEqual([]);

  const expired = evaluate(dependency('GHSA-aaaa-bbbb-cccc', 'left-pad', '2026-09-01', '2026-10-03'));
  expect(expired.status).toBe('failed');
  expect(expired.reason).toBe('exception_expired');

  // 90 days is the longest life; 91 days is refused even before it expires.
  expect(dependencyExceptionVerdict(dependency('GHSA-aaaa-bbbb-cccc', 'left-pad', '2026-09-01', '2026-11-30'), scanDate)).toEqual({ valid: true });
  const tooLong = evaluate(dependency('GHSA-aaaa-bbbb-cccc', 'left-pad', '2026-09-01', '2026-12-01'));
  expect(tooLong.status).toBe('failed');
  expect(tooLong.reason).toBe('exception_too_long');

  const recordedLater = evaluate(dependency('GHSA-aaaa-bbbb-cccc', 'left-pad', '2026-10-05', '2026-11-01'));
  expect(recordedLater.status).toBe('failed');

  // Another package or advisory does not match, and an exception without a finding is reported, not failed.
  const other = evaluate(dependency('GHSA-aaaa-bbbb-cccc', 'right-pad', '2026-09-01', '2026-10-30'));
  expect(other.status).toBe('failed');
  expect(other.unusedExceptions).toEqual([{ advisory: 'GHSA-aaaa-bbbb-cccc', package: 'right-pad' }]);
  const clean = evaluateBunAudit({ code: 0, stdout: '{}\n' }, packages, [dependency('GHSA-aaaa-bbbb-cccc', 'left-pad', '2026-09-01', '2026-10-30')], scanDate);
  expect(clean.status).toBe('passed');
  expect(clean.unusedExceptions).toEqual([{ advisory: 'GHSA-aaaa-bbbb-cccc', package: 'left-pad' }]);
});

test('GATE-007 exit code and JSON are mapped as in Pemanggilan pemindai; any other combination is not_run', () => {
  const leaks = JSON.stringify([leak('src/a.ts', 1)]);
  const lint = JSON.stringify([{ message: 'm', filepath: '.github/workflows/a.yml', line: 1, column: 2, kind: 'syntax-check', snippet: 's', end_column: 3 }]);
  const audit = JSON.stringify({ postcss: [advisory('GHSA-6g55-p6wh-862q', 'high', '<=8.5.11')] });
  const gitleaks = (code: number | null, stdout: string) => evaluateGitleaks({ code, stdout }, [], scanDate);
  const actionlint = (code: number | null, stdout: string) => evaluateActionlint({ code, stdout });
  const bunAudit = (code: number | null, stdout: string) => evaluateBunAudit({ code, stdout }, packages, [], scanDate);

  expect(gitleaks(0, '[]\n').status).toBe('passed');
  expect(gitleaks(2, leaks).status).toBe('failed');
  expect(actionlint(0, '[]\n').status).toBe('passed');
  expect(actionlint(1, lint).status).toBe('failed');
  expect(bunAudit(0, '{}').status).toBe('passed');
  expect(bunAudit(1, audit).status).toBe('failed');

  const invalid: Array<[string, ReturnType<typeof gitleaks>]> = [
    ['gitleaks exit 1 (config error)', gitleaks(1, '')],
    ['gitleaks exit 1 with findings', gitleaks(1, leaks)],
    ['gitleaks exit 3 with findings', gitleaks(3, leaks)],
    ['gitleaks killed with findings', gitleaks(null, leaks)],
    ['gitleaks exit 0 with findings', gitleaks(0, leaks)],
    ['gitleaks exit 2 without findings', gitleaks(2, '[]')],
    ['gitleaks text output', gitleaks(2, 'no leaks found')],
    ['gitleaks object', gitleaks(0, '{}')],
    ['gitleaks finding without a fingerprint', gitleaks(2, JSON.stringify([{ ...leak('a', 1), Fingerprint: undefined }]))],
    ['actionlint exit 1 without findings', actionlint(1, '[]')],
    ['actionlint exit 0 with findings', actionlint(0, lint)],
    ['actionlint exit 3', actionlint(3, '')],
    ['actionlint killed', actionlint(null, '')],
    ['bun audit exit 1 without advisories', bunAudit(1, '{}')],
    ['bun audit exit 0 with advisories', bunAudit(0, audit)],
    ['bun audit network error text', bunAudit(1, 'error: could not reach the registry')],
    ['bun audit array', bunAudit(1, '[]')],
    ['bun audit advisory without GHSA url', bunAudit(1, JSON.stringify({ postcss: [{ ...advisory('X', 'high', '<1'), url: 'https://example.test/x' }] }))],
  ];
  for (const [label, result] of invalid) {
    expect({ label, status: result.status, reason: result.reason }).toEqual({ label, status: 'not_run', reason: 'invalid_output' });
  }
});

test('GATE-007 a shallow checkout makes gitleaks not_run, and a Bun other than engines.bun blocks bun audit', () => {
  expect(gitleaksBlocked({ head: commit, commitsReachable: 3, shallow: true })).toBe('shallow_checkout');
  expect(gitleaksBlocked({ head: commit, commitsReachable: 3, shallow: false })).toBeNull();
  expect(gitleaksBlocked({ head: null, commitsReachable: null, shallow: null })).toBe('invalid_output');
  expect(bunAuditBlocked({ bun: Bun.version }, Bun.version)).toBeNull();
  expect(bunAuditBlocked({ bun: '0.0.1' }, Bun.version)).toBe('bun_version_mismatch');
  expect(bunAuditBlocked(undefined, Bun.version)).toBe('bun_version_mismatch');
});

test('GATE-007 .gitleaks.toml, .gitleaksignore, and .github/actionlint.y*ml in the checkout fail their scanner', async () => {
  const dir = await workspace({ '.gitleaks.toml': '', '.gitleaksignore': '', '.github/actionlint.yml': '', '.github/actionlint.yaml': '', 'README.md': '' });
  expect(await scannerConfigsInRepo(dir)).toEqual([
    { path: '.gitleaks.toml', scanner: 'gitleaks' },
    { path: '.gitleaksignore', scanner: 'gitleaks' },
    { path: '.github/actionlint.yaml', scanner: 'actionlint' },
    { path: '.github/actionlint.yml', scanner: 'actionlint' },
  ]);
  expect(await scannerConfigsInRepo(await workspace({ 'README.md': '' }))).toEqual([]);
  const passed = evaluateActionlint({ code: 0, stdout: '[]' });
  expect(withConfigInRepo(passed, true)).toMatchObject({ status: 'failed', reason: 'scanner_config_in_repo' });
  expect(withConfigInRepo(passed, false)).toEqual(passed);
});

test('GATE-007 a pin without a digest, with another image, or outside the locked shape is refused', () => {
  const pins = (gitleaks: unknown, actionlint: unknown = actionlintImage, extra: Record<string, unknown> = {}) =>
    readPins(JSON.stringify({ gitleaks: { image: gitleaks }, actionlint: { image: actionlint }, ...extra }));
  expect(pins(gitleaksImage)).toEqual({
    gitleaks: { image: gitleaksImage, repository: 'ghcr.io/gitleaks/gitleaks', tag: 'v8.30.1', digest: 'c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f' },
    actionlint: { image: actionlintImage, repository: 'rhysd/actionlint', tag: '1.7.12', digest: 'b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667' },
  });
  expect(pins('ghcr.io/gitleaks/gitleaks:v8.30.1').gitleaks).toBeNull();
  expect(pins('ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f').gitleaks).toBeNull();
  expect(pins('ghcr.io/gitleaks/gitleaks:latest@sha256:C00B').gitleaks).toBeNull();
  // The digest is exactly 64 lowercase hexadecimal characters: one fewer or one more is refused.
  expect(pins(gitleaksImage.slice(0, -1)).gitleaks).toBeNull();
  expect(pins(`${gitleaksImage}0`).gitleaks).toBeNull();
  expect(pins(gitleaksImage.replace(/[0-9a-f]{64}$/, (digest) => digest.toUpperCase())).gitleaks).toBeNull();
  expect(pins(gitleaksImage.replace('ghcr.io/gitleaks/gitleaks', 'example.test/gitleaks')).gitleaks).toBeNull();
  expect(pins(gitleaksImage, 'rhysd/actionlint:latest').actionlint).toBeNull();
  expect(pins(gitleaksImage, actionlintImage, { trivy: { image: 'x' } })).toEqual({ gitleaks: null, actionlint: null });
  expect(readPins('not json')).toEqual({ gitleaks: null, actionlint: null });
  expect(readPins(null)).toEqual({ gitleaks: null, actionlint: null });
});

test('GATE-007 exceptions.json outside the locked shape is rejected as a whole, with paths and indexes only', () => {
  const valid = {
    secrets: [{ fingerprint: `${commit}:src/a.ts:generic-api-key:3`, reason: 'r', owner: 'o', recorded: '2026-10-01' }],
    dependencies: [dependency('GHSA-aaaa-bbbb-cccc', 'left-pad', '2026-09-01', '2026-10-30')],
  };
  expect(readExceptions(JSON.stringify(valid))).toEqual({ exceptions: valid, problems: [] });
  const broken = {
    secrets: [{ ...valid.secrets[0], note: 'extra field' }],
    dependencies: [{ ...valid.dependencies[0], expires: '2026-02-30' }, { ...valid.dependencies[0], advisory: 'CVE-2026-1' }],
  };
  expect(readExceptions(JSON.stringify(broken))).toEqual({
    exceptions: { secrets: [], dependencies: [] },
    problems: [
      'tests/security/exceptions.json: secrets[0] tidak mengikuti bentuk fingerprint, reason, owner, recorded',
      'tests/security/exceptions.json: dependencies[0] tidak mengikuti bentuk advisory, package, reason, owner, recorded, expires',
      'tests/security/exceptions.json: dependencies[1] tidak mengikuti bentuk advisory, package, reason, owner, recorded, expires',
    ],
  });
  expect(readExceptions('{ "secrets": [] }').problems).toEqual(['tests/security/exceptions.json wajib tepat berisi daftar secrets dan dependencies']);
});

test('GATE-007 tests/security holds the locked gitleaks.toml, an empty actionlint.yaml, valid pins, and empty exceptions', async () => {
  const toml = Bun.TOML.parse(await readFile(join(root, 'tests/security/gitleaks.toml'), 'utf8'));
  expect(toml).toEqual({
    extend: { useDefault: true },
    allowlists: [{
      description: 'Checksum SHA 256 dan fingerprint key PGP pada bukti test yang di-commit',
      condition: 'AND',
      targetRules: ['generic-api-key'],
      paths: ['^docs/testing/evidence/[0-9]{4}/[^/]+\\.json$'],
      regexTarget: 'secret',
      regexes: ['^(?:[0-9a-f]{64}|[0-9A-F]{40})$'],
    }],
  });
  expect(await readFile(join(root, 'tests/security/actionlint.yaml'), 'utf8')).toBe('');
  const pins = readPins(await readFile(join(root, 'tests/security/scanners.json'), 'utf8'));
  expect(pins.gitleaks?.repository).toBe('ghcr.io/gitleaks/gitleaks');
  expect(pins.actionlint?.repository).toBe('rhysd/actionlint');
  expect(readExceptions(await readFile(join(root, 'tests/security/exceptions.json'), 'utf8'))).toEqual({
    exceptions: { secrets: [], dependencies: [] },
    problems: [],
  });
});

test('GATE-007 the container arguments are the fixed list of Pemanggilan pemindai, with UID 65534 for a root host', () => {
  const name = containerName('gitleaks', new Uint8Array([0, 1, 2, 171, 205, 239]));
  expect(name).toBe('foundation-security-gitleaks-000102abcdef');
  expect(containerName('actionlint')).toMatch(/^foundation-security-actionlint-[0-9a-f]{12}$/);
  const isolation = (user: string) => [
    'docker', 'run', '--rm', '--name', name, '--pull', 'never', '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m', '--user', user, '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '1g', '--cpus', '2', '-e', 'HOME=/tmp',
  ];
  expect(containerArguments({ scanner: 'gitleaks', name, image: gitleaksImage, repo: '/work/repo', uid: 501, gid: 20 })).toEqual([
    ...isolation('501:20'),
    '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/repo',
    '-e', 'GIT_ATTR_SOURCE=4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    '-v', '/work/repo:/repo:ro', '-v', '/work/repo/tests/security/gitleaks.toml:/config/gitleaks.toml:ro', '-w', '/repo', gitleaksImage,
    'git', '--config', '/config/gitleaks.toml', '--gitleaks-ignore-path', '/tmp', '--ignore-gitleaks-allow', '--log-opts=--all',
    '--redact', '--no-banner', '--exit-code', '2', '--report-format', 'json', '--report-path', '-', '/repo',
  ]);
  expect(containerArguments({
    scanner: 'actionlint', name, image: actionlintImage, repo: '/work/repo', uid: 0, gid: 0,
    workflows: ['.github/workflows/a.yml', '.github/workflows/b.yaml'],
  })).toEqual([
    ...isolation('65534:65534'),
    '-v', '/work/repo:/repo:ro', '-v', '/work/repo/tests/security/actionlint.yaml:/config/actionlint.yaml:ro', '-w', '/repo', actionlintImage,
    '-config-file', '/config/actionlint.yaml', '-format', '{{json .}}', '.github/workflows/a.yml', '.github/workflows/b.yaml',
  ]);
  expect(containerUser(0, 0)).toBe('65534:65534');
  expect(containerUser(1001, 118)).toBe('1001:118');
});

test('GATE-007 a committed .gitattributes with -diff does not hide a file from the history that gitleaks reads', async () => {
  // covers: AC-5 and key invariant 5 (no repository file can weaken a scanner). gitleaks reads the history through
  // `git log -p -U0` plus `--log-opts`, and git applies the attributes of the checkout to that diff.
  const dir = await workspace({ 'leak.txt': 'token = "sentinel-attribute-value"\n', '.gitattributes': '* -diff\n' });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  // The variables the gitleaks container gets from the argument builder (`-e NAME=VALUE`), HOME aside.
  const args = containerArguments({ scanner: 'gitleaks', name: 'fixture', image: gitleaksImage, repo: dir, uid: 501, gid: 20 });
  const containerEnv: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (args[index - 1] !== '-e' || arg.startsWith('HOME=')) return;
    containerEnv[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1);
  });
  expect(containerEnv['GIT_ATTR_SOURCE']).toBe(EMPTY_TREE);
  const history = (extra: Record<string, string>) => {
    const result = Bun.spawnSync(['git', '-C', dir, 'log', '-p', '-U0', '--all'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extra },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  // Without the container variables the file reads as binary, which is how the attribute hid it from gitleaks.
  const hidden = history({});
  expect(hidden).toContain('Binary files');
  expect(hidden).not.toContain('sentinel-attribute-value');
  // With them git takes the attributes from the empty tree, so the line is in the diff again.
  expect(history(containerEnv)).toContain('+token = "sentinel-attribute-value"');
});

test('GATE-007 security.json holds only the named fields, without a secret value, Match, author name, or email', () => {
  const secrets = evaluateGitleaks({ code: 2, stdout: JSON.stringify([leak('src/a.ts', 3)]) }, [], scanDate);
  const audit = evaluateBunAudit({ code: 1, stdout: JSON.stringify({ postcss: [advisory('GHSA-6g55-p6wh-862q', 'high', '<=8.5.11')] }) }, packages, [], scanDate);
  const lint = evaluateActionlint({
    code: 1,
    stdout: JSON.stringify([{ message: `bad\u0007${'x'.repeat(300)}`, filepath: '.github/workflows/a.yml', line: 2, column: 4, kind: 'expression', snippet: 'sentinel snippet', end_column: 9 }]),
  });
  const report = securityReport({
    scannedAt: '2026-10-04T08:00:00.000Z',
    workingTreeClean: false,
    otherProblems: 0,
    scanners: [
      scannerResult({ name: 'gitleaks', version: 'v8.30.1', image: gitleaksImage }, { head: commit, commitsReachable: 3, shallow: false }, secrets),
      scannerResult({ name: 'bun audit', version: Bun.version, image: null }, { packages: 3 }, audit),
      scannerResult({ name: 'actionlint', version: '1.7.12', image: actionlintImage }, { files: ['.github/workflows/a.yml'] }, lint),
    ],
  });
  expect(Object.keys(report)).toEqual(['schema', 'scannedAt', 'workingTreeClean', 'status', 'scanners']);
  expect(report.status).toBe('failed');
  for (const scanner of report.scanners) {
    expect(Object.keys(scanner)).toEqual(['name', 'version', 'image', 'status', 'reason', 'coverage', 'counts', 'findings', 'unusedExceptions']);
    expect(Object.keys(scanner.counts)).toEqual(['failed', 'excepted', 'reported']);
  }
  expect(Object.keys(report.scanners[0]!.findings[0]!)).toEqual(['rule', 'file', 'line', 'commit', 'fingerprint', 'policy']);
  expect(Object.keys(report.scanners[1]!.findings[0]!)).toEqual(['advisory', 'package', 'severity', 'vulnerableVersions', 'installedVersions', 'policy']);
  expect(Object.keys(report.scanners[2]!.findings[0]!)).toEqual(['file', 'line', 'column', 'kind', 'message', 'policy']);
  const message = (report.scanners[2]!.findings[0] as { message: string }).message;
  expect(message).toHaveLength(200);
  expect(message.startsWith('badx')).toBe(true);
  const text = JSON.stringify(report);
  for (const forbidden of ['sentinel-secret-value', 'sentinel-match-value', 'Sentinel Author', 'sentinel@example.test', 'sentinel commit message', 'Sentinel title', 'sentinel snippet', 'Match', 'Secret', 'Email', 'Author']) {
    expect(text).not.toContain(forbidden);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// `check:security` on fixture workspaces with a fake `docker`.

/**
 * Fake `docker`: the step environment never passes FAKE_* variables, so the script finds its log, mode, and canned
 * output next to itself. It logs every call. `run` in mode `wait` waits until a signal (its trap is set before it logs
 * `waiting`); in mode `findings` it prints `output.json` and exits 1, like actionlint with findings; in mode `clean` it
 * prints an empty array and exits 0; in mode `flood` it prints that empty array after 80 kB of blank lines, valid JSON
 * that passes only when no output limit stops it. `pull` fails while `pull-fails` exists, and `rm` while `rm-fails`
 * exists. On the first call it records the names of the variables it got.
 */
const fakeDocker = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
log="$here/../docker.log"
if [ ! -f "$here/../docker.env" ]; then env | cut -d= -f1 | sort > "$here/../docker.env"; fi
printf '%s\\n' "$*" >> "$log"
case "$1" in
  pull)
    if [ -f "$here/pull-fails" ]; then exit 1; fi
    ;;
  rm)
    if [ -f "$here/rm-fails" ]; then echo "fake daemon detail" >&2; exit 1; fi
    ;;
  run)
    case "$(cat "$here/mode")" in
      wait)
        sleep 30 &
        pid=$!
        trap 'kill "$pid" 2>/dev/null; exit 143' TERM INT HUP
        printf 'waiting\\n' >> "$log"
        wait "$pid"
        exit 0
        ;;
      clean)
        echo '[]'
        exit 0
        ;;
      flood)
        i=0
        while [ $i -lt 2000 ]; do echo '                                        '; i=$((i+1)); done
        echo '[]'
        exit 0
        ;;
    esac
    cat "$here/output.json"
    exit 1
    ;;
esac
exit 0
`;

/**
 * Stand in for the Bun that runs `bun audit`: records the names of the variables it got, then prints no advisory, after
 * 80 kB of blank lines while `bun-flood` exists.
 */
const fakeBun = `#!/bin/sh
here=$(dirname "$0")
env | cut -d= -f1 | sort > "$here/../bun.env"
if [ -f "$here/bun-flood" ]; then
  i=0
  while [ $i -lt 2000 ]; do echo '                                        '; i=$((i+1)); done
fi
echo '{}'
exit 0
`;

const gitEnv = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd, env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...gitEnv }, stdout: 'ignore', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
}

type FakeMode = 'wait' | 'findings' | 'clean' | 'flood';

/** A repository workspace with the files check:security reads; `bun` is the engines.bun of its package.json. */
async function scanWorkspace(options: { bun: string; mode: FakeMode; extra?: Record<string, string> }): Promise<string> {
  const dir = await workspace({
    'package.json': JSON.stringify({ name: 'fixture', engines: { bun: options.bun } }),
    'bun.lock': '{ "lockfileVersion": 1, "packages": {} }',
    'tests/security/scanners.json': JSON.stringify({ gitleaks: { image: gitleaksImage }, actionlint: { image: actionlintImage } }),
    'tests/security/exceptions.json': '{ "secrets": [], "dependencies": [] }',
    'tests/security/gitleaks.toml': '[extend]\nuseDefault = true\n',
    'tests/security/actionlint.yaml': '',
    '.github/workflows/application.yml': 'name: fixture\n',
    'bin/docker': fakeDocker,
    'bin/bun': fakeBun,
    'bin/mode': options.mode,
    'bin/output.json': JSON.stringify([{ message: 'fixture finding', filepath: '.github/workflows/application.yml', line: 1, column: 1, kind: 'syntax-check' }]),
    ...options.extra,
  });
  await chmod(join(dir, 'bin/docker'), 0o755);
  await chmod(join(dir, 'bin/bun'), 0o755);
  return dir;
}

async function dockerLog(dir: string): Promise<string[]> {
  try {
    return (await readFile(join(dir, 'docker.log'), 'utf8')).split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

async function waitUntil(check: () => Promise<boolean>, limitMs: number): Promise<boolean> {
  for (const deadline = Date.now() + limitMs; Date.now() < deadline; await Bun.sleep(50)) {
    if (await check()) return true;
  }
  return false;
}

for (const [signal, expected] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
test(`GATE-007 ${signal} to check:security stops the scanner, runs docker rm -f on the same name, writes security.json, and exits ${expected}`, async () => {
  const dir = await scanWorkspace({ bun: Bun.version, mode: 'wait', extra: { 'run.ts': `import { runSecurityScan } from ${JSON.stringify(scanModule)};\nprocess.exitCode = await runSecurityScan({ root: process.cwd() });\n` } });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  // HOME and TMPDIR sit outside the fixture repository: Bun writes a cache under HOME on macOS.
  const home = await emptyWorkspace();
  const child = spawn(process.execPath, ['--no-env-file', 'run.ts'], {
    cwd: dir,
    env: {
      PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
      HOME: home,
      TMPDIR: home,
      // Outside the step allow list: neither may reach the docker process.
      GITLEAKS_CONFIG: '/tmp/weaker.toml',
      FOUNDATION_SENTINEL_TOKEN: 'sentinel-token-value',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  const pgid = child.pid!;
  try {
    expect(await waitUntil(async () => (await dockerLog(dir)).includes('waiting'), 20_000)).toBe(true);
    process.kill(-pgid, signal);
    expect(await exited).toBe(expected);
    expect(await waitUntil(async () => !(await groupAlive(pgid)), 10_000)).toBe(true);
  } finally {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }

  const log = await dockerLog(dir);
  expect(log[0]).toBe(`pull ${gitleaksImage}`);
  const runs = log.filter((line) => line.startsWith('run '));
  expect(runs).toHaveLength(1);
  const name = /--name (foundation-security-gitleaks-[0-9a-f]{12}) /.exec(runs[0]!)?.[1];
  expect(name).toBeDefined();
  expect(runs[0]!.startsWith(`run --rm --name ${name} --pull never --network none --read-only`)).toBe(true);
  // The container is removed after the signal, by the name this run created, and nothing runs after it.
  expect(log.slice(log.indexOf('waiting') + 1)).toEqual([`rm -f ${name}`]);

  const received = (await readFile(join(dir, 'docker.env'), 'utf8')).split('\n');
  expect(received).toContain('PATH');
  expect(received).not.toContain('GITLEAKS_CONFIG');
  expect(received).not.toContain('FOUNDATION_SENTINEL_TOKEN');

  const report = JSON.parse(await readFile(join(dir, '.local/feature-11/security.json'), 'utf8'));
  expect(report.status).toBe('failed');
  expect(report.workingTreeClean).toBe(true);
  expect(report.scanners.map((scanner: { name: string; status: string; reason: string }) => [scanner.name, scanner.status, scanner.reason])).toEqual([
    ['gitleaks', 'not_run', 'signal'],
    ['bun audit', 'not_run', 'signal'],
    ['actionlint', 'not_run', 'signal'],
  ]);
  expect(report.scanners[0].coverage).toMatchObject({ commitsReachable: 1, shallow: false });
  expect(Buffer.concat(output).toString('utf8')).not.toContain('sentinel-token-value');
}, 60_000);
}

test('GATE-007 check:security fails a shallow checkout, another Bun, and an actionlint config in the checkout, and removes its container', async () => {
  const origin = await workspace({ 'a.txt': 'one\n' });
  git(origin, 'init', '-q');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'one');
  await Bun.write(join(origin, 'a.txt'), 'two\n');
  git(origin, 'commit', '-q', '-am', 'two');
  const dir = await scanWorkspace({ bun: '0.0.1', mode: 'findings', extra: { '.github/actionlint.yml': '' } });
  git(dir, 'init', '-q');
  git(dir, 'fetch', '-q', '--depth', '1', `file://${origin}`, 'main');
  git(dir, 'checkout', '-q', 'FETCH_HEAD');

  const output = lines();
  const home = await emptyWorkspace();
  const code = await runSecurityScan({ root: dir, env: { PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`, HOME: home, TMPDIR: home }, log: output.log, error: output.error });
  expect(code).toBe(1);
  expect(output.err).toContain('check:security: .github/actionlint.yml ada di checkout (scanner_config_in_repo)');

  const report = JSON.parse(await readFile(join(dir, '.local/feature-11/security.json'), 'utf8'));
  expect(report.status).toBe('failed');
  expect(report.workingTreeClean).toBe(false);
  const [gitleaks, audit, actionlint] = report.scanners;
  expect(gitleaks).toMatchObject({ name: 'gitleaks', version: 'v8.30.1', image: gitleaksImage, status: 'not_run', reason: 'shallow_checkout', findings: [] });
  expect(gitleaks.coverage).toMatchObject({ commitsReachable: 1, shallow: true });
  expect(audit).toMatchObject({ name: 'bun audit', version: Bun.version, image: null, status: 'not_run', reason: 'bun_version_mismatch', coverage: { packages: 0 } });
  expect(actionlint).toMatchObject({
    name: 'actionlint', status: 'failed', reason: 'scanner_config_in_repo', coverage: { files: ['.github/workflows/application.yml'] },
    counts: { failed: 1, excepted: 0, reported: 0 },
  });

  // Only actionlint started a container, and it was removed by its own name.
  const log = await dockerLog(dir);
  expect(log[0]).toBe(`pull ${actionlintImage}`);
  const name = /--name (foundation-security-actionlint-[0-9a-f]{12}) /.exec(log[1] ?? '')?.[1];
  expect(name).toBeDefined();
  expect(log[1]!.endsWith(`${actionlintImage} -config-file /config/actionlint.yaml -format {{json .}} .github/workflows/application.yml`)).toBe(true);
  expect(log.slice(2)).toEqual([`rm -f ${name}`]);
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------
// Added by /test (spec 0010): the in-memory output limit for scanner reports.

test('GATE-007 scanner output past the in-memory limit stops the group, keeps no more than the limit, and is marked outputExceeded', async () => {
  // covers: AC-5 (Pemanggilan pemindai: laporan pemindai hanya dibaca dari stdout di memori dengan batas 50 MB), AC-8
  expect(SCANNER_OUTPUT_LIMIT).toBe(50 * 1024 * 1024);
  const line = '0123456789'.repeat(6);
  const dir = await workspace({ 'flood.sh': `i=0\nwhile [ $i -lt 4000 ]; do echo ${line}; i=$((i+1)); done\nexec sleep 60\n` });
  const env = { PATH: process.env['PATH'] ?? '' };
  const started = performance.now();
  const flooded = await runProcessGroup(['sh', 'flood.sh'], { cwd: dir, env, timeoutMs: 30_000, output: 'pipe', outputLimitBytes: 4_096 });
  expect(flooded.outputExceeded).toBe(true);
  expect(flooded.timedOut).toBe(false);
  expect(Buffer.byteLength(flooded.stdout) + Buffer.byteLength(flooded.stderr)).toBeLessThanOrEqual(4_096);
  // The group was stopped for the output, not left to sleep until the timeout.
  expect(performance.now() - started).toBeLessThan(20_000);

  const small = await runProcessGroup(['sh', '-c', 'printf abc; printf err >&2'], { cwd: dir, env, timeoutMs: 30_000, output: 'pipe', outputLimitBytes: 4_096 });
  expect(small).toEqual({ code: 0, timedOut: false, aborted: false, outputExceeded: false, stdout: 'abc', stderr: 'err' });
}, 40_000);

// ---------------------------------------------------------------------------------------------------------------
// Added by the review fixes (spec 0010): the paths of check:security that end without a valid scanner result, the
// environment of `bun audit`, and the problems outside the three scanners that still fail the scan.

/** A committed fixture repository for check:security with the fake `docker` in `mode`, plus `extra` files. */
async function committedScan(mode: FakeMode, extra: Record<string, string> = {}): Promise<string> {
  const dir = await scanWorkspace({ bun: Bun.version, mode, extra });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

/** Runs check:security in process on `dir` with the fake `docker` and the stand in Bun. */
async function scanFixture(dir: string, options: { limits?: ScanLimits; env?: Record<string, string> } = {}) {
  const output = lines();
  const home = await emptyWorkspace();
  const code = await runSecurityScan({
    root: dir,
    env: { PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`, HOME: home, TMPDIR: home, ...options.env },
    log: output.log,
    error: output.error,
    bun: join(dir, 'bin/bun'),
    limits: options.limits,
  });
  const report = JSON.parse(await readFile(join(dir, '.local/feature-11/security.json'), 'utf8'));
  const statuses = report.scanners.map((scanner: { name: string; status: string; reason: string | null }) => [scanner.name, scanner.status, scanner.reason]);
  return { code, output, report, statuses, log: await dockerLog(dir) };
}

/** Variable names a shell adds on its own, which the child never got from its parent. */
const shellNames = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

test('GATE-007 bun audit runs with PATH and HOME only, and a rejected exceptions.json fails the scan although every scanner passed', async () => {
  // covers: AC-5 (bun audit dengan environment minimum tanpa .env; pengecualian di luar bentuk tetap ditolak seluruhnya)
  expect(auditEnvironment({ PATH: '/bin', HOME: '/home/x', DATABASE_URL: 'postgres://x', NPM_TOKEN: 'x', TMPDIR: '/tmp' })).toEqual({ PATH: '/bin', HOME: '/home/x' });
  expect(auditEnvironment({ PATH: '/bin' })).toEqual({ PATH: '/bin' });

  const dir = await committedScan('clean', { 'tests/security/exceptions.json': '{ "secrets": ' });
  const { code, output, report, statuses } = await scanFixture(dir, { env: { NPM_TOKEN: 'sentinel-npm-token', DATABASE_URL: 'postgres://sentinel' } });
  expect(statuses).toEqual([['gitleaks', 'passed', null], ['bun audit', 'passed', null], ['actionlint', 'passed', null]]);
  expect(output.err).toContain('check:security: tests/security/exceptions.json bukan JSON yang valid');
  expect(report.status).toBe('failed');
  expect(code).toBe(1);
  const received = (await readFile(join(dir, 'bun.env'), 'utf8')).split('\n').filter((name) => name !== '' && !shellNames.has(name));
  expect(received).toEqual(['HOME', 'PATH']);
}, 60_000);

test('GATE-007 a scanner container that docker rm -f cannot remove fails the scan and is named on stderr without Docker output', async () => {
  // covers: AC-8 (docker rm -f atas nama acak container pemindai pada setiap jalur keluar)
  const dir = await committedScan('clean', { 'bin/rm-fails': '' });
  const { code, output, report, statuses, log } = await scanFixture(dir);
  expect(statuses).toEqual([['gitleaks', 'passed', null], ['bun audit', 'passed', null], ['actionlint', 'passed', null]]);
  expect(report.status).toBe('failed');
  expect(code).toBe(1);
  const names = log.filter((line) => line.startsWith('run ')).map((line) => /--name (\S+) /.exec(line)?.[1]);
  expect(names).toHaveLength(2);
  for (const name of names) {
    expect(name).toMatch(/^foundation-security-(gitleaks|actionlint)-[0-9a-f]{12}$/);
    expect(log.filter((line) => line === `rm -f ${name}`).length).toBeGreaterThanOrEqual(2);
    expect(output.err).toContain(`Container ${name} tidak dapat dihapus; hapus dengan tangan`);
  }
  expect(output.err.join('\n')).not.toContain('fake daemon detail');
}, 60_000);

test('GATE-007 a failed pull, a scanner past its time limit, and output past the memory limit make the scanner not_run', async () => {
  // covers: AC-5 (Pemanggilan pemindai: image_pull_failed, batas waktu, laporan di memori dengan batas)
  expect(SCAN_LIMITS).toEqual({ pullMs: 300_000, removeMs: 60_000, scannerMs: { gitleaks: 300_000, 'bun audit': 120_000, actionlint: 120_000 }, outputBytes: 50 * 1024 * 1024 });

  const pull = await scanFixture(await committedScan('clean', { 'bin/pull-fails': '' }));
  expect(pull.statuses).toEqual([['gitleaks', 'not_run', 'image_pull_failed'], ['bun audit', 'passed', null], ['actionlint', 'not_run', 'image_pull_failed']]);
  expect(pull.log.filter((line) => line.startsWith('run '))).toEqual([]);
  expect(pull.code).toBe(1);

  const short: ScanLimits = { ...SCAN_LIMITS, scannerMs: { gitleaks: 1_000, 'bun audit': 120_000, actionlint: 1_000 } };
  const slow = await scanFixture(await committedScan('wait'), { limits: short });
  expect(slow.statuses).toEqual([['gitleaks', 'not_run', 'timeout'], ['bun audit', 'passed', null], ['actionlint', 'not_run', 'timeout']]);
  // Each stopped container is removed by its own name right after the stop.
  const slowNames = slow.log.filter((line) => line.startsWith('run ')).map((line) => /--name (\S+) /.exec(line)?.[1]);
  for (const name of slowNames) expect(slow.log[slow.log.indexOf(`rm -f ${name}`) - 1]).toBe('waiting');
  expect(slow.code).toBe(1);

  const flood = await scanFixture(await committedScan('flood', { 'bin/bun-flood': '' }), { limits: { ...SCAN_LIMITS, outputBytes: 4_096 } });
  expect(flood.statuses).toEqual([['gitleaks', 'not_run', 'invalid_output'], ['bun audit', 'not_run', 'invalid_output'], ['actionlint', 'not_run', 'invalid_output']]);
  expect(flood.code).toBe(1);
  // The same output passes without the small limit, so only the limit made it not_run.
  const unlimited = await scanFixture(await committedScan('flood', { 'bin/bun-flood': '' }));
  expect(unlimited.statuses).toEqual([['gitleaks', 'passed', null], ['bun audit', 'passed', null], ['actionlint', 'passed', null]]);
}, 90_000);

test('GATE-007 security.json fails when anything outside the three scanners failed, even with three passed scanners', () => {
  // covers: AC-5 (exceptions.json yang ditolak atau container yang tidak terhapus menggagalkan check:security)
  const passed = (name: 'gitleaks' | 'bun audit' | 'actionlint') =>
    scannerResult({ name, version: '1', image: null }, { files: [] }, evaluateActionlint({ code: 0, stdout: '[]' }));
  const scanners = [passed('gitleaks'), passed('bun audit'), passed('actionlint')];
  const report = (otherProblems: number) => securityReport({ scannedAt: '2026-10-04T00:00:00.000Z', workingTreeClean: true, scanners, otherProblems }).status;
  expect(report(0)).toBe('passed');
  expect(report(1)).toBe('failed');
  expect(securityReport({ scannedAt: '2026-10-04T00:00:00.000Z', workingTreeClean: true, scanners: scanners.slice(0, 2), otherProblems: 0 }).status).toBe('failed');
});
