import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { REASON_CODES } from './gate.ts';

// Scanner policy of spec 0010 (AC-5 and AC-8, rows *Pemanggilan pemindai* and *Kebijakan pemindai*): pure functions
// that read the pins, the exceptions, `bun.lock`, and the captured output of gitleaks, `bun audit`, and actionlint, and
// build the content of `.local/feature-11/security.json`. No scanner runs here; tests/orchestration/security-scan.ts
// starts them and passes each exit code and stdout to these functions. Thresholds are constants: no environment
// variable, argument, flag, or scanner file in the repository can lower them (key invariant 5). This file never names
// the container engine, so INFRA-001 keeps holding for scripts/.

export const SCANNER_NAMES = ['gitleaks', 'bun audit', 'actionlint'] as const;
export type ScannerName = (typeof SCANNER_NAMES)[number];
export type ContainerScanner = 'gitleaks' | 'actionlint';
export type ScannerStatus = 'passed' | 'failed' | 'not_run';
export type ScannerReasonCode = (typeof REASON_CODES.scanner)[number];
export type Policy = 'failed' | 'excepted' | 'reported';

export const SCANNERS_PATH = 'tests/security/scanners.json';
export const EXCEPTIONS_PATH = 'tests/security/exceptions.json';
export const SCANNER_CONFIG_PATHS: Readonly<Record<ContainerScanner, string>> = {
  gitleaks: 'tests/security/gitleaks.toml',
  actionlint: 'tests/security/actionlint.yaml',
};
export const SECURITY_JSON = '.local/feature-11/security.json';
export const WORKFLOW_DIR = '.github/workflows';

/** The image repository each pin must name (AC-5). */
export const SCANNER_REPOSITORIES: Readonly<Record<ContainerScanner, string>> = {
  gitleaks: 'ghcr.io/gitleaks/gitleaks',
  actionlint: 'rhysd/actionlint',
};

/** Scanner configuration files of the repository that the gate never reads; their presence fails that scanner. */
export const SCANNER_CONFIG_FILES: Readonly<Record<string, ContainerScanner>> = {
  '.gitleaks.toml': 'gitleaks',
  '.gitleaksignore': 'gitleaks',
  '.github/actionlint.yaml': 'actionlint',
  '.github/actionlint.yml': 'actionlint',
};

/** Advisories from this severity up fail (*Ambang gagal dependency*). */
export const FAIL_SEVERITY = 'high';
/** Known severities, lowest first; any other value fails with `severity_unknown`. */
export const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
/** Longest life of a dependency exception, from `recorded` to `expires` (*Umur maksimum pengecualian dependency*). */
export const EXCEPTION_MAX_DAYS = 90;
/** Scanner output is read from memory only, up to this size (*Pemanggilan pemindai*). */
export const SCANNER_OUTPUT_LIMIT = 50 * 1024 * 1024;
/** Free text from a scanner (an actionlint message) is cut to this length. */
export const MESSAGE_LIMIT = 200;

// ---------------------------------------------------------------------------------------------------------------
// Pins (`tests/security/scanners.json`).

export type Pin = { image: string; repository: string; tag: string; digest: string };

const PIN = /^(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*):(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@sha256:(?<digest>[0-9a-f]{64})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** One pin `<repo>:<tag>@sha256:<64 hex>` for `scanner`; `null` when it does not match or names another image. */
export function parsePin(scanner: ContainerScanner, value: unknown): Pin | null {
  if (typeof value !== 'string') return null;
  const groups = PIN.exec(value)?.groups;
  if (groups === undefined || groups['repository'] !== SCANNER_REPOSITORIES[scanner]) return null;
  return { image: value, repository: groups['repository'], tag: groups['tag']!, digest: groups['digest']! };
}

/** Both pins of `scanners.json`; a file that is not the locked shape gives `null` for both. */
export function readPins(text: string | null): Record<ContainerScanner, Pin | null> {
  const none = { gitleaks: null, actionlint: null };
  if (text === null) return none;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return none;
  }
  if (!isRecord(value) || !hasExactKeys(value, ['gitleaks', 'actionlint'])) return none;
  const pin = (scanner: ContainerScanner) => {
    const entry = value[scanner];
    return isRecord(entry) && hasExactKeys(entry, ['image']) ? parsePin(scanner, entry['image']) : null;
  };
  return { gitleaks: pin('gitleaks'), actionlint: pin('actionlint') };
}

// ---------------------------------------------------------------------------------------------------------------
// Exceptions (`tests/security/exceptions.json`).

export type SecretException = { fingerprint: string; reason: string; owner: string; recorded: string };
export type DependencyException = {
  advisory: string;
  package: string;
  reason: string;
  owner: string;
  recorded: string;
  expires: string;
};
export type Exceptions = { secrets: SecretException[]; dependencies: DependencyException[] };

const FINGERPRINT = /^[0-9a-f]{40}:.+:[^:]+:\d+$/;
const ADVISORY = /^GHSA(?:-[0-9a-z]{4}){3}$/;

/** True for a real calendar date written `YYYY-MM-DD`. */
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';

/**
 * Reads `exceptions.json`. Any entry outside the locked shape rejects the whole file: no exception applies, and every
 * problem is returned with its path and index, never a value.
 */
export function readExceptions(source: string | null): { exceptions: Exceptions; problems: string[] } {
  const empty: Exceptions = { secrets: [], dependencies: [] };
  if (source === null) return { exceptions: empty, problems: [`${EXCEPTIONS_PATH} tidak ada`] };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { exceptions: empty, problems: [`${EXCEPTIONS_PATH} bukan JSON yang valid`] };
  }
  if (!isRecord(value) || !hasExactKeys(value, ['secrets', 'dependencies']) || !Array.isArray(value['secrets']) || !Array.isArray(value['dependencies'])) {
    return { exceptions: empty, problems: [`${EXCEPTIONS_PATH} wajib tepat berisi daftar secrets dan dependencies`] };
  }
  const problems: string[] = [];
  value['secrets'].forEach((entry: unknown, index: number) => {
    const valid = isRecord(entry) && hasExactKeys(entry, ['fingerprint', 'reason', 'owner', 'recorded']) &&
      typeof entry['fingerprint'] === 'string' && FINGERPRINT.test(entry['fingerprint']) &&
      text(entry['reason']) && text(entry['owner']) && validDate(entry['recorded']);
    if (!valid) problems.push(`${EXCEPTIONS_PATH}: secrets[${index}] tidak mengikuti bentuk fingerprint, reason, owner, recorded`);
  });
  value['dependencies'].forEach((entry: unknown, index: number) => {
    const valid = isRecord(entry) && hasExactKeys(entry, ['advisory', 'package', 'reason', 'owner', 'recorded', 'expires']) &&
      typeof entry['advisory'] === 'string' && ADVISORY.test(entry['advisory']) && text(entry['package']) &&
      text(entry['reason']) && text(entry['owner']) && validDate(entry['recorded']) && validDate(entry['expires']);
    if (!valid) problems.push(`${EXCEPTIONS_PATH}: dependencies[${index}] tidak mengikuti bentuk advisory, package, reason, owner, recorded, expires`);
  });
  if (problems.length > 0) return { exceptions: empty, problems };
  return { exceptions: { secrets: value['secrets'] as SecretException[], dependencies: value['dependencies'] as DependencyException[] }, problems };
}

type Verdict = { valid: true } | { valid: false; code: 'exception_expired' | 'exception_too_long' | null; note: string };

/** Whether a dependency exception that matches a finding still applies on `scanDate` (UTC, `YYYY-MM-DD`). */
export function dependencyExceptionVerdict(exception: DependencyException, scanDate: string): Verdict {
  const name = `${exception.advisory} ${exception.package}`;
  if (dayNumber(exception.expires) - dayNumber(exception.recorded) > EXCEPTION_MAX_DAYS) {
    return { valid: false, code: 'exception_too_long', note: `pengecualian ${name} lebih dari ${EXCEPTION_MAX_DAYS} hari` };
  }
  if (exception.recorded > scanDate) return { valid: false, code: null, note: `pengecualian ${name} dicatat setelah tanggal pemindaian` };
  if (scanDate > exception.expires) return { valid: false, code: 'exception_expired', note: `pengecualian ${name} kedaluwarsa` };
  return { valid: true };
}

/** Whether a secret exception that matches a finding applies on `scanDate`. */
export function secretExceptionVerdict(exception: SecretException, scanDate: string): Verdict {
  if (exception.recorded > scanDate) {
    return { valid: false, code: null, note: `pengecualian ${exception.fingerprint} dicatat setelah tanggal pemindaian` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------------------------------------------
// `bun.lock`.

export type LockPackage = { name: string; version: string };

/** The `packages` entries of `bun.lock`, read with `Bun.JSONC.parse` (it holds trailing commas); `null` when unreadable. */
export function readLockPackages(source: string | null): { count: number; packages: LockPackage[] } | null {
  if (source === null) return null;
  let value: unknown;
  try {
    value = Bun.JSONC.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value['packages'])) return null;
  const packages: LockPackage[] = [];
  for (const entry of Object.values(value['packages'])) {
    const id = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof id !== 'string') continue;
    const at = id.lastIndexOf('@');
    if (at <= 0) continue;
    packages.push({ name: id.slice(0, at), version: id.slice(at + 1) });
  }
  return { count: Object.keys(value['packages']).length, packages };
}

/** Versions of `name` in `bun.lock` that `range` covers, unique and in semver order. */
export function installedVersions(packages: readonly LockPackage[], name: string, range: string): string[] {
  const found = new Set<string>();
  for (const entry of packages) {
    if (entry.name !== name) continue;
    try {
      if (Bun.semver.satisfies(entry.version, range)) found.add(entry.version);
    } catch {
      // A version Bun cannot compare is not counted as installed in the range.
    }
  }
  return [...found].sort((a, b) => Bun.semver.order(a, b));
}

// ---------------------------------------------------------------------------------------------------------------
// Scanner output (*Pemanggilan pemindai*, column Pemetaan hasil).

/** What a scanner gave back: the exit code and the stdout captured in memory. */
export type ScanRun = { code: number | null; stdout: string };

type Parsed<T> = { valid: true; items: T[] } | { valid: false };

type GitleaksRaw = { RuleID: string; File: string; StartLine: number; Commit: string; Fingerprint: string };
type ActionlintRaw = { filepath: string; line: number; column: number; kind: string; message: string };
type AdvisoryRaw = { package: string; url: string; severity: string; vulnerable_versions: string };

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

const isLine = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

/** stdout JSON array: exit 0 with an empty array, or exit 2 (`--exit-code 2`) with findings; anything else is invalid. */
export function parseGitleaks(run: ScanRun): Parsed<GitleaksRaw> {
  const value = parseJson(run.stdout);
  if (!Array.isArray(value)) return { valid: false };
  const shaped = value.every((item) => isRecord(item) && typeof item['RuleID'] === 'string' && typeof item['File'] === 'string' &&
    isLine(item['StartLine']) && typeof item['Commit'] === 'string' && typeof item['Fingerprint'] === 'string');
  if (!shaped) return { valid: false };
  if ((run.code === 0 && value.length === 0) || (run.code === 2 && value.length > 0)) return { valid: true, items: value as GitleaksRaw[] };
  return { valid: false };
}

/** stdout JSON array: exit 0 with an empty array, or exit 1 with findings; anything else is invalid. */
export function parseActionlint(run: ScanRun): Parsed<ActionlintRaw> {
  const value = parseJson(run.stdout);
  if (!Array.isArray(value)) return { valid: false };
  const shaped = value.every((item) => isRecord(item) && typeof item['filepath'] === 'string' && isLine(item['line']) &&
    isLine(item['column']) && typeof item['kind'] === 'string' && typeof item['message'] === 'string');
  if (!shaped) return { valid: false };
  if ((run.code === 0 && value.length === 0) || (run.code === 1 && value.length > 0)) return { valid: true, items: value as ActionlintRaw[] };
  return { valid: false };
}

/** stdout JSON object of package to advisories: exit 0 without advisories, or exit 1 with them; anything else is invalid. */
export function parseBunAudit(run: ScanRun): Parsed<AdvisoryRaw> {
  const value = parseJson(run.stdout);
  if (!isRecord(value)) return { valid: false };
  const items: AdvisoryRaw[] = [];
  for (const [name, advisories] of Object.entries(value)) {
    if (!Array.isArray(advisories)) return { valid: false };
    for (const advisory of advisories) {
      if (!isRecord(advisory) || typeof advisory['url'] !== 'string' || typeof advisory['severity'] !== 'string' ||
        typeof advisory['vulnerable_versions'] !== 'string') return { valid: false };
      items.push({ package: name, url: advisory['url'], severity: advisory['severity'], vulnerable_versions: advisory['vulnerable_versions'] });
    }
  }
  if ((run.code === 0 && items.length === 0) || (run.code === 1 && items.length > 0)) return { valid: true, items };
  return { valid: false };
}

/** The GHSA id at the end of an advisory `url`, or `null`. */
export function advisoryId(url: string): string | null {
  return /\/(GHSA(?:-[0-9a-z]{4}){3})\/?$/.exec(url)?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Findings and results (*Kebijakan pemindai*): only the named fields, never `Secret`, `Match`, `Author`, `Email`,
// `Message`, `Link`, or `Date`.

export type GitleaksFinding = { rule: string; file: string; line: number; commit: string; fingerprint: string; policy: Policy };
export type BunAuditFinding = {
  advisory: string;
  package: string;
  severity: string;
  vulnerableVersions: string;
  installedVersions: string[];
  policy: Policy;
};
export type ActionlintFinding = { file: string; line: number; column: number; kind: string; message: string; policy: Policy };
export type Finding = GitleaksFinding | BunAuditFinding | ActionlintFinding;

export type GitleaksCoverage = { head: string | null; commitsReachable: number | null; shallow: boolean | null };
export type BunAuditCoverage = { packages: number | null };
export type ActionlintCoverage = { files: string[] };
export type Coverage = GitleaksCoverage | BunAuditCoverage | ActionlintCoverage;

export type UnusedException = { fingerprint: string } | { advisory: string; package: string };

export type ScannerResult = {
  name: ScannerName;
  /** Tag of the pin for gitleaks and actionlint, `Bun.version` for `bun audit`; `null` without a valid pin. */
  version: string | null;
  /** The pinned image with its digest; `null` for `bun audit` and without a valid pin. */
  image: string | null;
  status: ScannerStatus;
  reason: ScannerReasonCode | null;
  coverage: Coverage;
  counts: Record<Policy, number>;
  findings: Finding[];
  unusedExceptions: UnusedException[];
};

/** Policy outcome of one scanner: everything of a result except its identity and coverage, plus console notes. */
export type Evaluation = Pick<ScannerResult, 'status' | 'reason' | 'counts' | 'findings' | 'unusedExceptions'> & { notes: string[] };

function counts(findings: readonly Finding[]): Record<Policy, number> {
  const result: Record<Policy, number> = { failed: 0, excepted: 0, reported: 0 };
  for (const finding of findings) result[finding.policy] += 1;
  return result;
}

/** The reason of a scanner that ran: the most specific cause among its failing findings, in a fixed order. */
const causeOrder: readonly ScannerReasonCode[] = ['exception_too_long', 'exception_expired', 'severity_unknown'];

function evaluation(findings: Finding[], causes: Set<ScannerReasonCode>, unused: UnusedException[], notes: string[]): Evaluation {
  const failed = findings.some((finding) => finding.policy === 'failed');
  return {
    status: failed ? 'failed' : 'passed',
    reason: failed ? (causeOrder.find((code) => causes.has(code)) ?? null) : null,
    counts: counts(findings),
    findings,
    unusedExceptions: unused,
    notes,
  };
}

/** A scanner that could not run or give valid output: `not_run` with its reason, and nothing found. */
export function notRunEvaluation(reason: ScannerReasonCode): Evaluation {
  return { status: 'not_run', reason, counts: { failed: 0, excepted: 0, reported: 0 }, findings: [], unusedExceptions: [], notes: [] };
}

/** gitleaks: every finding fails unless its fingerprint has an exception (AC-5). */
export function evaluateGitleaks(run: ScanRun, exceptions: readonly SecretException[], scanDate: string): Evaluation {
  const parsed = parseGitleaks(run);
  if (!parsed.valid) return notRunEvaluation('invalid_output');
  const used = new Set<SecretException>();
  const causes = new Set<ScannerReasonCode>();
  const notes: string[] = [];
  const findings = parsed.items.map((item): GitleaksFinding => {
    const exception = exceptions.find((entry) => entry.fingerprint === item.Fingerprint);
    let policy: Policy = 'failed';
    if (exception !== undefined) {
      used.add(exception);
      const verdict = secretExceptionVerdict(exception, scanDate);
      if (verdict.valid) policy = 'excepted';
      else notes.push(verdict.note);
    }
    return { rule: item.RuleID, file: item.File, line: item.StartLine, commit: item.Commit, fingerprint: item.Fingerprint, policy };
  });
  const unused = exceptions.filter((entry) => !used.has(entry)).map((entry) => ({ fingerprint: entry.fingerprint }));
  return evaluation(findings, causes, unused, notes);
}

function severityRank(severity: string): number {
  return (SEVERITIES as readonly string[]).indexOf(severity);
}

/**
 * `bun audit`: `high` and `critical` fail unless an exception for the same advisory and package still applies,
 * `moderate` and `low` are reported, and any other severity fails with `severity_unknown` (AC-5).
 */
export function evaluateBunAudit(
  run: ScanRun,
  packages: readonly LockPackage[],
  exceptions: readonly DependencyException[],
  scanDate: string,
): Evaluation {
  const parsed = parseBunAudit(run);
  if (!parsed.valid) return notRunEvaluation('invalid_output');
  const used = new Set<DependencyException>();
  const causes = new Set<ScannerReasonCode>();
  const notes: string[] = [];
  const findings: BunAuditFinding[] = [];
  for (const item of parsed.items) {
    const advisory = advisoryId(item.url);
    if (advisory === null) return notRunEvaluation('invalid_output');
    const exception = exceptions.find((entry) => entry.advisory === advisory && entry.package === item.package);
    if (exception !== undefined) used.add(exception);
    const rank = severityRank(item.severity);
    let policy: Policy;
    if (rank < 0) {
      policy = 'failed';
      causes.add('severity_unknown');
    } else if (rank < severityRank(FAIL_SEVERITY)) {
      policy = 'reported';
    } else if (exception === undefined) {
      policy = 'failed';
    } else {
      const verdict = dependencyExceptionVerdict(exception, scanDate);
      if (verdict.valid) policy = 'excepted';
      else {
        policy = 'failed';
        if (verdict.code !== null) causes.add(verdict.code);
        notes.push(verdict.note);
      }
    }
    findings.push({
      advisory,
      package: item.package,
      severity: item.severity,
      vulnerableVersions: item.vulnerable_versions,
      installedVersions: installedVersions(packages, item.package, item.vulnerable_versions),
      policy,
    });
  }
  const unused = exceptions.filter((entry) => !used.has(entry)).map((entry) => ({ advisory: entry.advisory, package: entry.package }));
  return evaluation(findings, causes, unused, notes);
}

/** Removes control characters and cuts free text to `MESSAGE_LIMIT` characters. */
export function cleanText(value: string): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''))
    .slice(0, MESSAGE_LIMIT)
    .join('');
}

/** actionlint: every finding fails (AC-5). */
export function evaluateActionlint(run: ScanRun): Evaluation {
  const parsed = parseActionlint(run);
  if (!parsed.valid) return notRunEvaluation('invalid_output');
  const findings = parsed.items.map((item): ActionlintFinding => ({
    file: item.filepath,
    line: item.line,
    column: item.column,
    kind: item.kind,
    message: cleanText(item.message),
    policy: 'failed',
  }));
  return evaluation(findings, new Set(), [], []);
}

/**
 * The reason gitleaks cannot scan the history with this coverage: `shallow_checkout` for a shallow checkout (the scan
 * would miss commits), `invalid_output` when git could not give the coverage, otherwise `null`.
 */
export function gitleaksBlocked(coverage: GitleaksCoverage): ScannerReasonCode | null {
  if (coverage.shallow === true) return 'shallow_checkout';
  if (coverage.shallow === null || coverage.head === null || coverage.commitsReachable === null) return 'invalid_output';
  return null;
}

/** `bun_version_mismatch` when the running Bun is not `engines.bun`, otherwise `null`. */
export function bunAuditBlocked(engines: unknown, version: string): ScannerReasonCode | null {
  return isRecord(engines) && engines['bun'] === version ? null : 'bun_version_mismatch';
}

/** A scanner whose own configuration file sits in the checkout fails with `scanner_config_in_repo`, findings kept. */
export function withConfigInRepo(result: Evaluation, found: boolean): Evaluation {
  return found ? { ...result, status: 'failed', reason: 'scanner_config_in_repo' } : result;
}

/** The scanner configuration files of `SCANNER_CONFIG_FILES` present in the checkout at `root` (any file type). */
export async function scannerConfigsInRepo(root: string): Promise<Array<{ path: string; scanner: ContainerScanner }>> {
  const found: Array<{ path: string; scanner: ContainerScanner }> = [];
  for (const [path, scanner] of Object.entries(SCANNER_CONFIG_FILES)) {
    try {
      await lstat(join(root, path));
      found.push({ path, scanner });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// `security.json`.

export type SecurityReport = {
  schema: 1;
  scannedAt: string;
  workingTreeClean: boolean;
  status: 'passed' | 'failed';
  scanners: ScannerResult[];
};

/** The UTC date of a scan, the date that exceptions are compared with (`expires` is inclusive). */
export function scanDate(scannedAt: string): string {
  return scannedAt.slice(0, 10);
}

/** One result in the field order of *Kebijakan pemindai*. */
export function scannerResult(
  identity: { name: ScannerName; version: string | null; image: string | null },
  coverage: Coverage,
  outcome: Evaluation,
): ScannerResult {
  return {
    name: identity.name,
    version: identity.version,
    image: identity.image,
    status: outcome.status,
    reason: outcome.reason,
    coverage,
    counts: outcome.counts,
    findings: outcome.findings,
    unusedExceptions: outcome.unusedExceptions,
  };
}

/**
 * The content of `security.json`: `passed` only when all three scanners passed and nothing else failed (a rejected
 * exceptions file, or a scanner container that could not be removed).
 */
export function securityReport(options: {
  scannedAt: string;
  workingTreeClean: boolean;
  scanners: ScannerResult[];
  otherProblems: number;
}): SecurityReport {
  const passed = options.otherProblems === 0 && options.scanners.length === SCANNER_NAMES.length &&
    options.scanners.every((scanner) => scanner.status === 'passed');
  return {
    schema: 1,
    scannedAt: options.scannedAt,
    workingTreeClean: options.workingTreeClean,
    status: passed ? 'passed' : 'failed',
    scanners: options.scanners,
  };
}

function findingLine(finding: Finding): string {
  if ('fingerprint' in finding) return `${finding.policy} ${finding.rule} ${finding.file}:${finding.line} commit ${finding.commit.slice(0, 12)}`;
  if ('advisory' in finding) return `${finding.policy} ${finding.advisory} ${finding.package} ${finding.severity} (${finding.installedVersions.join(', ') || 'versi tidak ditemukan di bun.lock'})`;
  return `${finding.policy} ${finding.file}:${finding.line}:${finding.column} ${finding.kind} ${finding.message}`;
}

/** Console summary per scanner, with the named fields only. */
export function summaryLines(report: SecurityReport): string[] {
  const lines: string[] = [];
  for (const scanner of report.scanners) {
    const version = scanner.version === null ? '' : ` ${scanner.version}`;
    const reason = scanner.reason === null ? '' : `, alasan ${scanner.reason}`;
    const { failed, excepted, reported } = scanner.counts;
    lines.push(`${scanner.name}${version}: ${scanner.status}${reason} (gagal ${failed}, dikecualikan ${excepted}, dilaporkan ${reported})`);
    for (const finding of scanner.findings) lines.push(`  ${findingLine(finding)}`);
    for (const unused of scanner.unusedExceptions) {
      lines.push(`  pengecualian tidak terpakai ${'fingerprint' in unused ? unused.fingerprint : `${unused.advisory} ${unused.package}`}`);
    }
  }
  if (!report.workingTreeClean) lines.push('Working tree tidak bersih: perubahan yang belum masuk commit tidak dipindai gitleaks.');
  lines.push(`check:security ${report.status}; hasil di ${SECURITY_JSON}`);
  return lines;
}
