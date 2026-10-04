import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  bundlePath,
  ciIdentity,
  fileChecksum,
  gitCommit,
  sourceTree,
  TIER_NAMES,
  TIERS,
  type BindingReasonCode,
  type CheckReasonCode,
  type CiIdentity,
  type DiscoveryReasonCode,
  type EvidenceRecord,
  type Reason,
  type ReleaseReasonCode,
  type StepReasonCode,
  type StepRecord,
  type StepStatus,
  type TierEnvironment,
  type TierManifest,
  type TierName,
} from './gate.ts';
import { EVIDENCE_TEXT_LIMIT, JUnitError, junitResults, parseJUnit, type JUnitDocument, type JUnitResult } from './junit.ts';
import { readRegistries, type RegistryCheck } from './registry-reader.ts';
import { SCANNER_NAMES, SECURITY_JSON, type Coverage, type Policy, type ScannerName, type ScannerReasonCode, type ScannerStatus } from './security-policy.ts';
import { inventory, junitDiscovery, junitSuitePath, ownedBy, RUNNER_OWNERS, runnerOwner } from './test-inventory.ts';

// `bun run test:report` of spec 0010 (AC-6, AC-7, AC-8): reads the three tier bundles, binds them to one candidate,
// computes the status of every registry check from the manifest and the JUnit in the bundle, proves discovery from the
// JUnit of every runner, summarizes the scanners and the PostgreSQL image of the real tier, flags the release
// candidate, and writes `report.json`, `report.md`, and the job summary. Nothing is stored between runs: every run
// computes the gate again from the bundles and the checkout.

export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'not_run' | 'missing_test';
export type GateStatus = 'passed' | 'failed' | 'incomplete';
type Environment = Readonly<Record<string, string | undefined>>;

/** Worst first: a scenario takes the first status in this order that one of its checks has. */
export const STATUS_ORDER: readonly CheckStatus[] = ['failed', 'missing_test', 'not_run', 'skipped', 'passed'];

export const REPORT_DIR = '.local/feature-11';
export const REPORT_JSON = `${REPORT_DIR}/report.json`;
export const REPORT_MD = `${REPORT_DIR}/report.md`;

/** The real tier evidence that holds the identity of the PostgreSQL image (*Identitas PostgreSQL*). */
export const POSTGRES_EVIDENCE = '.local/feature-3/image.json';
export const POSTGRES_STEP = 'test:infrastructure';
export const POSTGRES_FIELDS = [
  'image',
  'imageId',
  'os',
  'architecture',
  'baseImage',
  'baseIndexDigest',
  'serverVersion',
  'packageVersion',
] as const;

/** The step whose list commands prove discovery before the run (AC-1). */
export const DISCOVERY_STEP = 'check:test-discovery';
/** The ref and event a release candidate comes from (*Kandidat release*). */
export const RELEASE_REF = 'refs/heads/main';
export const RELEASE_EVENT = 'push';

const NO_SKIP_REASON = 'runner tidak memberi alasan';

/** A check reason; `runner_skip` carries the runner's own reason, cut to 200 characters without control characters. */
export type CheckReason = Reason<CheckReasonCode> & { text?: string };

export type CheckResult = {
  runner: string;
  script: string;
  file: string;
  testTag: string | null;
  status: CheckStatus;
  reasons: CheckReason[];
  counts: { passed: number; failed: number; skipped: number } | null;
  exitCode: number | null;
  /** Bundle path of the evidence the status came from, or `null`. */
  evidence: string | null;
};

export type ScenarioResult = {
  id: string;
  registry: string;
  source: string;
  criteria: string[];
  critical: boolean;
  status: CheckStatus;
  checks: CheckResult[];
};

export type BindingProblem = { code: BindingReasonCode; tier: TierName | null; path: string | null };

export type TierSummary = {
  status: 'passed' | 'failed' | 'not_run';
  runAttempt: string | null;
  environment: TierEnvironment | null;
  inputs: Record<string, string | null> | null;
  outputs: Record<string, string> | null;
  steps: Array<{ script: string; status: StepStatus; durationMs: number; reasons: Reason<StepReasonCode>[] }>;
};

export type DiscoveryProblem = { code: DiscoveryReasonCode; script: string; path: string };
export type DiscoveryResult = { status: 'passed' | 'failed' | 'not_run'; problems: DiscoveryProblem[] };

export type PostgresIdentity = Record<(typeof POSTGRES_FIELDS)[number], string> & { evidence: string };

export type ScannerSummary = {
  name: ScannerName;
  version: string | null;
  image: string | null;
  status: ScannerStatus;
  reason: ScannerReasonCode | null;
  coverage: Coverage;
  counts: Record<Policy, number>;
};

/** The summary of `security.json` (*Isi laporan*, `scanners`); findings stay in the bound evidence file. */
export type ScannersSummary = {
  scannedAt: string;
  workingTreeClean: boolean;
  status: 'passed' | 'failed';
  scanners: ScannerSummary[];
};

export type ReleaseReason = { code: ReleaseReasonCode; tier: TierName | null };
export type ReleaseCandidate = { value: boolean; reasons: ReleaseReason[] };

/** What the gate does not prove yet (*Isi laporan*, `outOfScope`): k6 performance and the deployment image. */
export type OutOfScope = { area: 'performance' | 'deployment_image'; feature: number };
export const OUT_OF_SCOPE: readonly OutOfScope[] = [
  { area: 'performance', feature: 12 },
  { area: 'deployment_image', feature: 13 },
];

export type GateReport = {
  schema: 1;
  generatedAt: string;
  candidate: { commit: string | null; sourceTree: string | null; ci: CiIdentity | null };
  binding: { valid: boolean; problems: BindingProblem[] };
  tiers: Record<TierName, TierSummary>;
  postgres: PostgresIdentity | null;
  discovery: DiscoveryResult;
  scenarios: ScenarioResult[];
  critical: Array<{ id: string; status: CheckStatus }>;
  scanners: ScannersSummary | null;
  gate: GateStatus;
  releaseCandidate: ReleaseCandidate;
  outOfScope: OutOfScope[];
};

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers.

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** A repository relative path that cannot leave the bundle. */
function safePath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false;
  return !path.split('/').includes('..');
}

// ---------------------------------------------------------------------------------------------------------------
// Manifests and evidence hashes.

const stepStatuses = new Set<string>(['passed', 'failed', 'skipped', 'not_run']);
const evidenceKinds = new Set<string>(['junit', 'screenshots', 'image', 'scan', 'scanner']);
const ciFields = ['runId', 'runAttempt', 'job', 'sha', 'ref', 'event'] as const;

function validEvidence(value: unknown): value is EvidenceRecord {
  if (!isRecord(value) || !safePath(value['path']) || !evidenceKinds.has(String(value['kind']))) return false;
  if (typeof value['present'] !== 'boolean') return false;
  const hash = value['sha256'];
  if (hash !== undefined && !stringOrNull(hash)) return false;
  const files = value['files'];
  if (files === undefined) return true;
  return Array.isArray(files) && files.every((file) => isRecord(file) && safePath(file['path']) && typeof file['sha256'] === 'string');
}

function validReason(value: unknown): boolean {
  return isRecord(value) && typeof value['code'] === 'string' && stringOrNull(value['path']);
}

function validStep(value: unknown): value is StepRecord {
  return (
    isRecord(value) &&
    typeof value['script'] === 'string' &&
    stepStatuses.has(String(value['status'])) &&
    Array.isArray(value['reasons']) &&
    value['reasons'].every(validReason) &&
    (value['exitCode'] === null || typeof value['exitCode'] === 'number') &&
    typeof value['durationMs'] === 'number' &&
    Array.isArray(value['evidence']) &&
    value['evidence'].every(validEvidence)
  );
}

function validCi(value: unknown): value is CiIdentity | null {
  return value === null || (isRecord(value) && ciFields.every((field) => stringOrNull(value[field])));
}

function validCandidate(value: unknown): boolean {
  return (
    isRecord(value) &&
    stringOrNull(value['commit']) &&
    typeof value['clean'] === 'boolean' &&
    stringOrNull(value['sourceTree']) &&
    stringOrNull(value['sourceTreeAfter']) &&
    validCi(value['ci'])
  );
}

/** `os`, `arch`, and `bun` as text and `node` as text or `null` (*Value sourcing*, Versi dan platform). */
function validEnvironment(value: unknown): value is TierEnvironment {
  return (
    isRecord(value) &&
    typeof value['os'] === 'string' &&
    typeof value['arch'] === 'string' &&
    typeof value['bun'] === 'string' &&
    stringOrNull(value['node'])
  );
}

/** A checksum map: an object whose values are text, or text and `null` for the inputs (a tree without git). */
function validChecksums(value: unknown, nullable: boolean): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string' || (nullable && item === null));
}

function validManifest(value: unknown, tier: TierName): value is TierManifest {
  return (
    isRecord(value) &&
    value['schema'] === 1 &&
    value['tier'] === tier &&
    validCandidate(value['candidate']) &&
    validEnvironment(value['environment']) &&
    validChecksums(value['inputs'], true) &&
    validChecksums(value['outputs'], false) &&
    (value['status'] === 'passed' || value['status'] === 'failed') &&
    Array.isArray(value['steps']) &&
    value['steps'].every(validStep)
  );
}

type LoadedTier = {
  name: TierName;
  manifest: TierManifest | null;
  /** Evidence paths whose bundle copy matches the SHA 256 in the manifest. */
  verified: Set<string>;
};

async function loadTier(root: string, name: TierName, problems: BindingProblem[]): Promise<LoadedTier> {
  const loaded: LoadedTier = { name, manifest: null, verified: new Set() };
  let text: string;
  try {
    text = await readFile(join(root, bundlePath(name), 'manifest.json'), 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
    problems.push({ code: 'manifest_missing', tier: name, path: null });
    return loaded;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!validManifest(value, name)) {
    problems.push({ code: 'manifest_invalid', tier: name, path: null });
    return loaded;
  }
  loaded.manifest = value;
  if (value.candidate.commit === null) problems.push({ code: 'no_commit', tier: name, path: null });

  const bundle = join(root, bundlePath(name));
  const check = async (path: string, expected: string) => {
    if ((await fileChecksum(join(bundle, path))) === expected) loaded.verified.add(path);
    else problems.push({ code: 'evidence_hash_differs', tier: name, path });
  };
  for (const step of value.steps) {
    for (const evidence of step.evidence) {
      if (typeof evidence.sha256 === 'string') await check(evidence.path, evidence.sha256);
      for (const file of evidence.files ?? []) await check(file.path, file.sha256);
    }
  }
  return loaded;
}

type ReportCandidate = GateReport['candidate'];

/**
 * Cross tier binding (AC-7): every valid manifest has the commit and the source tree of the report checkout, kept its
 * source tree during the tier, and has the CI identity of the report job on `runId`, `runAttempt`, `sha`, `ref`, and
 * `event` (`job` left out), or the manifests and the report all have none. The report job `sha` is the candidate
 * commit. Each problem carries its tier, or `null` for the report job itself.
 */
export function crossBinding(candidate: ReportCandidate, manifests: ReadonlyArray<TierManifest | null>): BindingProblem[] {
  const problems: BindingProblem[] = [];
  const report = candidate.ci;
  for (const manifest of manifests) {
    if (manifest === null) continue;
    const tier = manifest.tier;
    const own = manifest.candidate;
    if (own.commit !== null && candidate.commit !== null && own.commit !== candidate.commit) {
      problems.push({ code: 'commit_differs', tier, path: null });
    }
    if ((own.sourceTree !== null || candidate.sourceTree !== null) && own.sourceTree !== candidate.sourceTree) {
      problems.push({ code: 'source_tree_differs', tier, path: null });
    }
    if (own.sourceTree !== own.sourceTreeAfter) problems.push({ code: 'source_tree_changed', tier, path: null });
    if ((own.ci === null) !== (report === null)) problems.push({ code: 'ci_mixed', tier, path: null });
    else if (own.ci !== null && report !== null) {
      const sameRun =
        own.ci.runId === report.runId && own.ci.sha === report.sha && own.ci.ref === report.ref && own.ci.event === report.event;
      if (!sameRun) problems.push({ code: 'ci_identity_differs', tier, path: null });
      else if (own.ci.runAttempt !== report.runAttempt) problems.push({ code: 'ci_attempt_differs', tier, path: null });
    }
  }
  if (report !== null && report.sha !== candidate.commit) problems.push({ code: 'ci_identity_differs', tier: null, path: null });
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Bundle reads: only evidence whose SHA 256 matches the manifest is ever read (key invariant 2).

/** Reads one verified bundle file as text, or `null` when it is not verified, missing, not regular, or too large. */
async function readVerified(root: string, tier: LoadedTier, path: string): Promise<string | null> {
  if (!tier.verified.has(path)) return null;
  const file = join(root, bundlePath(tier.name), path);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > EVIDENCE_TEXT_LIMIT) return null;
    return await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null;
    throw error;
  }
}

/** Parsed JUnit of the bundles, read once per tier and path; `null` when the file cannot be used. */
class JUnitDocuments {
  private readonly cache = new Map<string, JUnitDocument | null>();

  constructor(private readonly root: string) {}

  async read(tier: LoadedTier, evidence: EvidenceRecord): Promise<JUnitDocument | null> {
    const key = `${tier.name}:${evidence.path}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    let document: JUnitDocument | null = null;
    const text = evidence.kind === 'junit' ? await readVerified(this.root, tier, evidence.path) : null;
    if (text !== null) {
      try {
        document = parseJUnit(text);
      } catch (error) {
        if (!(error instanceof JUnitError)) throw error;
      }
    }
    this.cache.set(key, document);
    return document;
  }
}

function findStep(tiers: readonly LoadedTier[], script: string): { tier: LoadedTier; step: StepRecord } | undefined {
  for (const tier of tiers) {
    const step = tier.manifest?.steps.find((candidate) => candidate.script === script);
    if (step !== undefined) return { tier, step };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Check status (AC-6).

/** Removes control characters and cuts runner text to 200 characters. */
export function runnerText(text: string): string {
  return Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''))
    .slice(0, 200)
    .join('');
}

function skipReason(result: JUnitResult): string {
  if (result.skipMessage !== null && result.skipMessage.trim() !== '') return runnerText(result.skipMessage);
  const suffix = /\(dilewati: (.*)\)\s*$/s.exec(result.title);
  if (suffix?.[1] !== undefined && suffix[1].trim() !== '') return runnerText(suffix[1]);
  return NO_SKIP_REASON;
}

function result(check: RegistryCheck, status: CheckStatus, fields: Partial<CheckResult> = {}): CheckResult {
  return {
    runner: check.runner,
    script: check.script,
    file: check.file,
    testTag: check.testTag ?? null,
    status,
    reasons: [],
    counts: null,
    exitCode: null,
    evidence: null,
    ...fields,
  };
}

async function evaluateCheck(check: RegistryCheck, tiers: LoadedTier[], documents: JUnitDocuments): Promise<CheckResult> {
  // A check that names the root script of a tier takes the tier status.
  const tierScript = tiers.find((tier) => TIERS[tier.name]?.script === check.script);
  if (tierScript !== undefined) {
    if (tierScript.manifest === null) return result(check, 'not_run', { reasons: [{ code: 'tier_not_run', path: null }] });
    return result(check, tierScript.manifest.status === 'passed' ? 'passed' : 'failed');
  }

  const found = findStep(tiers, check.script);
  if (found === undefined) return result(check, 'not_run', { reasons: [{ code: 'tier_not_run', path: null }] });
  const { tier, step } = found;
  if (step.status === 'not_run') return result(check, 'not_run', { reasons: [{ code: 'previous_step', path: null }] });

  if (check.runner === 'command') {
    return result(check, step.exitCode === 0 ? 'passed' : 'failed', { exitCode: step.exitCode });
  }

  const evidence = step.evidence.find((item) => item.kind === 'junit');
  const owner = runnerOwner(check.script);
  const tag = check.testTag;
  const document = evidence === undefined ? null : await documents.read(tier, evidence);
  const results = document !== null && owner !== undefined ? junitResults(document, owner.runner) : [];
  const matching =
    owner === undefined || tag === undefined || tag === ''
      ? []
      : results.filter((item) => junitSuitePath(owner, item.fileSuite) === check.file && item.title.startsWith(`${tag} `));
  const evidencePath = evidence === undefined ? null : `${bundlePath(tier.name)}/${evidence.path}`;
  if (matching.length === 0) {
    return result(check, 'missing_test', {
      reasons: [{ code: 'no_matching_testcase', path: evidence?.path ?? null }],
      evidence: evidencePath,
    });
  }
  const counts = {
    passed: matching.filter((item) => item.outcome === 'passed').length,
    failed: matching.filter((item) => item.outcome === 'failed' || item.outcome === 'error').length,
    skipped: matching.filter((item) => item.outcome === 'skipped').length,
  };
  if (counts.failed > 0) return result(check, 'failed', { counts, evidence: evidencePath });
  if (counts.skipped > 0) {
    const texts = [...new Set(matching.filter((item) => item.outcome === 'skipped').map(skipReason))];
    const reasons: CheckReason[] = texts.map((text) => ({ code: 'runner_skip', path: evidence?.path ?? null, text }));
    return result(check, 'skipped', { counts, reasons, evidence: evidencePath });
  }
  return result(check, 'passed', { counts, evidence: evidencePath });
}

export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  for (const status of STATUS_ORDER) if (statuses.includes(status)) return status;
  return 'missing_test';
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery from JUnit (AC-1): every file level testsuite of a runner JUnit names a file its script owns, and every
// owned file has one. The owned set comes from the inventory of the report checkout, which the binding ties to the
// source tree of the tiers. `check:test-discovery` proved the list commands before the run; its step joins the status.

async function discover(root: string, tiers: readonly LoadedTier[], documents: JUnitDocuments): Promise<DiscoveryResult> {
  const problems: DiscoveryProblem[] = [];
  let complete = true;
  let failed = false;
  const listStep = findStep(tiers, DISCOVERY_STEP);
  if (listStep === undefined || listStep.step.status === 'not_run') complete = false;
  else if (listStep.step.status !== 'passed') failed = true;

  const found = await inventory(root);
  for (const owner of RUNNER_OWNERS) {
    const located = findStep(tiers, owner.script);
    const evidence = located?.step.evidence.find((item) => item.kind === 'junit' && item.path === owner.junit);
    const document = located === undefined || evidence === undefined ? null : await documents.read(located.tier, evidence);
    if (document === null) {
      complete = false;
      continue;
    }
    for (const problem of junitDiscovery(owner, document, ownedBy(found, [owner.script]))) {
      problems.push({ code: problem.code, script: owner.script, path: problem.path });
    }
  }
  return { status: failed || problems.length > 0 ? 'failed' : complete ? 'passed' : 'not_run', problems };
}

// ---------------------------------------------------------------------------------------------------------------
// Scanners and the PostgreSQL identity: read only from evidence bound to its manifest.

function jsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The bundle text of one declared evidence file of `script`, when it is present and its hash matches the manifest. */
async function boundEvidence(root: string, tiers: readonly LoadedTier[], script: string, path: string): Promise<string | null> {
  const located = findStep(tiers, script);
  const evidence = located?.step.evidence.find((item) => item.path === path);
  if (located === undefined || evidence === undefined || !evidence.present || typeof evidence.sha256 !== 'string') return null;
  return readVerified(root, located.tier, path);
}

const scannerStatuses = new Set<string>(['passed', 'failed', 'not_run']);

function validCounts(value: unknown): value is Record<Policy, number> {
  return isRecord(value) && ['failed', 'excepted', 'reported'].every((policy) => typeof value[policy] === 'number');
}

function scannerSummary(value: unknown): ScannerSummary | null {
  if (!isRecord(value)) return null;
  const { name, version, image, status, reason, coverage, counts } = value;
  if (typeof name !== 'string' || !(SCANNER_NAMES as readonly string[]).includes(name)) return null;
  if (typeof status !== 'string' || !scannerStatuses.has(status) || !stringOrNull(reason)) return null;
  if (!stringOrNull(version) || !stringOrNull(image) || !isRecord(coverage) || !validCounts(counts)) return null;
  return {
    name: name as ScannerName,
    version,
    image,
    status: status as ScannerStatus,
    reason: reason as ScannerReasonCode | null,
    coverage: coverage as Coverage,
    counts: { failed: counts.failed, excepted: counts.excepted, reported: counts.reported },
  };
}

/** `scannedAt` of `security.json`: a UTC time as `Date.prototype.toISOString` writes it, nothing else. */
const SCANNED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** The summary of `security.json` in the security bundle, or `null` when it is missing, unbound, or not valid. */
async function readScanners(root: string, tiers: readonly LoadedTier[]): Promise<ScannersSummary | null> {
  const object = jsonObject(await boundEvidence(root, tiers, 'check:security', SECURITY_JSON));
  if (object === null || object['schema'] !== 1 || !Array.isArray(object['scanners'])) return null;
  const { scannedAt, workingTreeClean, status } = object;
  // `scannedAt` is the only text of the file that report.md prints outside a table cell, so it must be a time.
  if (typeof scannedAt !== 'string' || !SCANNED_AT.test(scannedAt)) return null;
  if (typeof workingTreeClean !== 'boolean' || (status !== 'passed' && status !== 'failed')) return null;
  const scanners: ScannerSummary[] = [];
  for (const item of object['scanners']) {
    const summary = scannerSummary(item);
    if (summary === null) return null;
    scanners.push(summary);
  }
  return { scannedAt, workingTreeClean, status, scanners };
}

/** True only when each of the three scanners appears and passed. */
function scannersPassed(scanners: ScannersSummary | null): boolean {
  if (scanners === null) return false;
  return SCANNER_NAMES.every((name) => scanners.scanners.some((scanner) => scanner.name === name && scanner.status === 'passed'));
}

/**
 * *Identitas PostgreSQL*: the eight identity fields of `image.json` in the real bundle, plus its bundle path, only when
 * `test:infrastructure` recorded the file with its SHA 256, the bundle copy matches it, and every field is a non empty
 * string. Otherwise `null` as a whole, never a partial identity. The step status does not matter.
 */
async function readPostgres(root: string, tiers: readonly LoadedTier[]): Promise<PostgresIdentity | null> {
  const real = tiers.filter((tier) => tier.name === 'real');
  const object = jsonObject(await boundEvidence(root, real, POSTGRES_STEP, POSTGRES_EVIDENCE));
  if (object === null) return null;
  const identity: Partial<PostgresIdentity> = {};
  for (const field of POSTGRES_FIELDS) {
    const value = object[field];
    if (typeof value !== 'string' || value === '') return null;
    identity[field] = value;
  }
  return { ...(identity as PostgresIdentity), evidence: `${bundlePath('real')}/${POSTGRES_EVIDENCE}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Gate and release candidate.

/**
 * AC-6: `passed` when every scenario passed, the three tiers passed, discovery matches, the three scanners passed, and
 * the binding is valid; `failed` when a check, a tier step, discovery, or the scanner policy failed; `incomplete`
 * otherwise.
 */
export function gateStatus(input: {
  scenarios: readonly ScenarioResult[];
  manifests: ReadonlyArray<TierManifest | null>;
  discovery: DiscoveryResult;
  scanners: ScannersSummary | null;
  bindingValid: boolean;
}): GateStatus {
  const failed =
    input.scenarios.some((scenario) => scenario.checks.some((check) => check.status === 'failed')) ||
    input.manifests.some((manifest) => manifest?.steps.some((step) => step.status === 'failed') === true) ||
    input.discovery.status === 'failed' ||
    input.scanners?.scanners.some((scanner) => scanner.status === 'failed') === true;
  if (failed) return 'failed';
  const passed =
    input.scenarios.every((scenario) => scenario.status === 'passed') &&
    input.manifests.length === TIER_NAMES.length &&
    input.manifests.every((manifest) => manifest?.status === 'passed') &&
    input.discovery.status === 'passed' &&
    scannersPassed(input.scanners) &&
    input.bindingValid;
  return passed ? 'passed' : 'incomplete';
}

/**
 * *Kandidat release*: every unmet condition, in the fixed order of the row. A tier without a valid manifest gets neither
 * `not_clean` nor `not_ci`; `event` and `ref` are judged only on the CI identity of the report job.
 */
export function releaseCandidate(gate: GateStatus, manifests: ReadonlyArray<TierManifest | null>, reportCi: CiIdentity | null): ReleaseCandidate {
  const valid = TIER_NAMES.map((name) => manifests.find((manifest) => manifest?.tier === name) ?? null);
  const reasons: ReleaseReason[] = [];
  if (gate !== 'passed') reasons.push({ code: 'gate_not_passed', tier: null });
  for (const manifest of valid) if (manifest !== null && !manifest.candidate.clean) reasons.push({ code: 'not_clean', tier: manifest.tier });
  for (const manifest of valid) if (manifest !== null && manifest.candidate.ci === null) reasons.push({ code: 'not_ci', tier: manifest.tier });
  if (reportCi === null) reasons.push({ code: 'not_ci', tier: null });
  else {
    if (reportCi.event !== RELEASE_EVENT) reasons.push({ code: 'event_not_push', tier: null });
    if (reportCi.ref !== RELEASE_REF) reasons.push({ code: 'ref_not_main', tier: null });
  }
  return { value: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------------------------------------------
// Report.

function summarizeTier(tier: LoadedTier): TierSummary {
  const manifest = tier.manifest;
  if (manifest === null) {
    return { status: 'not_run', runAttempt: null, environment: null, inputs: null, outputs: null, steps: [] };
  }
  return {
    status: manifest.status,
    runAttempt: manifest.candidate.ci?.runAttempt ?? null,
    environment: manifest.environment,
    inputs: manifest.inputs,
    outputs: manifest.outputs,
    steps: manifest.steps.map((step) => ({
      script: step.script,
      status: step.status,
      durationMs: step.durationMs,
      reasons: step.reasons,
    })),
  };
}

export async function buildReport(root: string, env: Environment = process.env): Promise<GateReport> {
  const problems: BindingProblem[] = [];
  const tiers: LoadedTier[] = [];
  for (const name of TIER_NAMES) tiers.push(await loadTier(root, name, problems));
  const manifests = tiers.map((tier) => tier.manifest);
  const candidate: ReportCandidate = {
    commit: await gitCommit(root, env),
    sourceTree: await sourceTree(root, undefined, env),
    ci: ciIdentity(env),
  };
  if (candidate.commit === null) problems.push({ code: 'no_commit', tier: null, path: null });
  problems.push(...crossBinding(candidate, manifests));

  const documents = new JUnitDocuments(root);
  const scenarios: ScenarioResult[] = [];
  for (const registry of await readRegistries(root)) {
    for (const scenario of registry.scenarios) {
      const checks: CheckResult[] = [];
      for (const check of scenario.checks) checks.push(await evaluateCheck(check, tiers, documents));
      scenarios.push({
        id: scenario.id,
        registry: registry.path,
        source: registry.source,
        criteria: scenario.criteria,
        critical: scenario.critical === true,
        status: worstStatus(checks.map((check) => check.status)),
        checks,
      });
    }
  }

  const binding = { valid: problems.length === 0, problems };
  const discovery = await discover(root, tiers, documents);
  const scanners = await readScanners(root, tiers);
  const gate = gateStatus({ scenarios, manifests, discovery, scanners, bindingValid: binding.valid });

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    candidate,
    binding,
    tiers: Object.fromEntries(tiers.map((tier) => [tier.name, summarizeTier(tier)])) as Record<TierName, TierSummary>,
    postgres: await readPostgres(root, tiers),
    discovery,
    scenarios,
    critical: scenarios.filter((scenario) => scenario.critical).map((scenario) => ({ id: scenario.id, status: scenario.status })),
    scanners,
    gate,
    releaseCandidate: releaseCandidate(gate, manifests, candidate.ci),
    outOfScope: OUT_OF_SCOPE.map((item) => ({ ...item })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown (`report.md` and the job summary), derived only from the fields of `report.json`.

/** Escapes one Markdown table cell so a cell always stays on one line (spec 0010, *Kode alasan*). */
export function escapeCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[|`<>*_[\]]/g, (char) => `\\${char}`);
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

function header(cells: readonly string[]): string[] {
  return [`| ${cells.join(' | ')} |`, `| ${cells.map(() => '---').join(' | ')} |`];
}

function describeCheck(check: CheckResult): string {
  const parts = [check.runner, check.script, check.file];
  if (check.testTag !== null) parts.push(check.testTag);
  return parts.join(' ');
}

function describeOutcome(check: CheckResult): string {
  const parts: string[] = [];
  if (check.counts !== null) {
    parts.push(`${check.counts.passed} lulus, ${check.counts.failed} gagal, ${check.counts.skipped} dilewati`);
  } else if (check.runner === 'command' && check.exitCode !== null) parts.push(`exit code ${check.exitCode}`);
  parts.push(check.status);
  for (const reason of check.reasons) parts.push(reason.text === undefined ? reason.code : `${reason.code}: ${reason.text}`);
  if (check.evidence !== null) parts.push(check.evidence);
  return parts.join(', ');
}

/** `Kandidat release: ya`, or `bukan` followed by every code with its tier when it has one, in the row order. */
export function releaseLine(release: ReleaseCandidate): string {
  if (release.value) return 'Kandidat release: ya';
  const reasons = release.reasons.map((reason) => (reason.tier === null ? `\`${reason.code}\`` : `\`${reason.code}\` ${reason.tier}`));
  return `Kandidat release: bukan (${reasons.join(', ')})`;
}

const releaseText: Record<ReleaseReasonCode, string> = {
  gate_not_passed: 'gate tidak berstatus passed',
  not_clean: 'working tree tier tidak bersih di awal atau di akhir tier',
  not_ci: 'tidak berasal dari run CI',
  event_not_push: `event job laporan bukan ${RELEASE_EVENT}`,
  ref_not_main: `ref job laporan bukan ${RELEASE_REF}`,
};

function environmentText(environment: TierEnvironment | null): string {
  if (environment === null) return 'tidak ada';
  return `${environment.os} ${environment.arch}, Bun ${environment.bun}, Node ${environment.node ?? 'tidak ada'}`;
}

function ciText(ci: CiIdentity | null): string {
  if (ci === null) return 'run lokal tanpa identitas CI';
  return `run ${ci.runId ?? '?'} attempt ${ci.runAttempt ?? '?'}, event ${ci.event ?? '?'}, ref ${ci.ref ?? '?'}, sha ${ci.sha ?? '?'}`;
}

function checksumTable(report: GateReport, field: 'inputs' | 'outputs'): string[] {
  const paths = new Set<string>();
  for (const name of TIER_NAMES) for (const path of Object.keys(report.tiers[name][field] ?? {})) paths.add(path);
  if (paths.size === 0) return ['Tidak ada manifest tier yang memuat checksum ini.', ''];
  const lines = header(['Path', ...TIER_NAMES]);
  for (const path of [...paths].sort()) {
    lines.push(row([path, ...TIER_NAMES.map((name) => {
      const values = report.tiers[name][field];
      if (values === null) return 'tier tidak berjalan';
      return values[path] ?? 'tidak dicatat';
    })]));
  }
  lines.push('');
  return lines;
}

function coverageText(scanner: ScannerSummary): string {
  const coverage = scanner.coverage as Record<string, unknown>;
  if (Array.isArray(coverage['files'])) return `file: ${coverage['files'].map(String).join(', ') || 'tidak ada'}`;
  if ('packages' in coverage) return `paket bun.lock: ${String(coverage['packages'])}`;
  return `head ${String(coverage['head'])}, commit terjangkau ${String(coverage['commitsReachable'])}, dangkal ${String(coverage['shallow'])}`;
}

export function renderMarkdown(report: GateReport): string {
  const lines: string[] = ['# Laporan gate CI', ''];
  lines.push(
    'Laporan ini dihitung ulang oleh `bun run test:report` dari bundle bukti setiap tier. Hanya status `passed` dihitung lulus.',
    '',
  );

  lines.push('## Kandidat', '');
  lines.push(...header(['Aspek', 'Nilai']));
  lines.push(row(['Status gate', report.gate]));
  lines.push(row(['Commit', report.candidate.commit ?? 'tidak ada']));
  lines.push(row(['Pohon sumber', report.candidate.sourceTree ?? 'tidak ada']));
  lines.push(row(['Run CI job laporan', ciText(report.candidate.ci)]));
  lines.push(row(['Dibuat', report.generatedAt]));
  lines.push('');
  lines.push(releaseLine(report.releaseCandidate), '');

  lines.push('## Pengikatan', '');
  lines.push(report.binding.valid ? 'Pengikatan sah.' : 'Pengikatan tidak sah.', '');
  if (report.binding.problems.length > 0) {
    lines.push(...header(['Kode', 'Tier', 'Path']));
    for (const problem of report.binding.problems) lines.push(row([problem.code, problem.tier ?? 'laporan', problem.path ?? '-']));
    lines.push('');
  }

  lines.push('## Tier', '');
  lines.push(...header(['Tier', 'Status', 'Langkah passed', 'Run attempt', 'Environment']));
  for (const name of TIER_NAMES) {
    const tier = report.tiers[name];
    const passed = tier.steps.filter((step) => step.status === 'passed').length;
    lines.push(row([name, tier.status, `${passed} dari ${tier.steps.length}`, tier.runAttempt ?? '-', environmentText(tier.environment)]));
  }
  lines.push('');
  for (const name of TIER_NAMES) {
    const tier = report.tiers[name];
    if (tier.steps.length === 0) continue;
    lines.push(`### Langkah tier ${name}`, '');
    lines.push(...header(['Langkah', 'Status', 'Durasi', 'Alasan']));
    for (const step of tier.steps) {
      const reasons = step.reasons.map((reason) => (reason.path === null ? reason.code : `${reason.code} ${reason.path}`));
      lines.push(row([step.script, step.status, `${(step.durationMs / 1000).toFixed(1)} detik`, reasons.join(', ') || '-']));
    }
    lines.push('');
  }
  lines.push('### Checksum input per tier', '');
  lines.push(...checksumTable(report, 'inputs'));
  lines.push('### Checksum output per tier', '');
  lines.push(...checksumTable(report, 'outputs'));

  lines.push('## Identitas PostgreSQL', '');
  if (report.postgres === null) {
    lines.push(
      'Identitas PostgreSQL tidak tersedia karena `image.json` tidak ada di bundle tier nyata, tidak cocok dengan manifest, atau tidak memuat field identitas. Penyebabnya terlihat pada alasan langkah dan pengikatan.',
      '',
    );
  } else {
    lines.push('Ini image yang diuji tier nyata, bukan image deployment (fitur 13).', '');
    lines.push(...header(['Field', 'Nilai']));
    for (const field of POSTGRES_FIELDS) lines.push(row([field, report.postgres[field]]));
    lines.push(row(['Bukti', report.postgres.evidence]));
    lines.push('');
  }

  lines.push('## Pemindai', '');
  if (report.scanners === null) {
    lines.push('Hasil pemindai tidak tersedia karena `security.json` tidak ada di bundle tier keamanan, tidak cocok dengan manifest, atau tidak valid.', '');
  } else {
    lines.push(`Status ${report.scanners.status}, dipindai ${report.scanners.scannedAt}.`, '');
    if (!report.scanners.workingTreeClean) {
      lines.push('Working tree tidak bersih saat pemindaian: perubahan yang belum masuk commit tidak dipindai gitleaks.', '');
    }
    lines.push(...header(['Pemindai', 'Versi', 'Image', 'Status', 'Alasan', 'Cakupan', 'Gagal', 'Dikecualikan', 'Dilaporkan']));
    for (const scanner of report.scanners.scanners) {
      lines.push(
        row([
          scanner.name,
          scanner.version ?? '-',
          scanner.image ?? '-',
          scanner.status,
          scanner.reason ?? '-',
          coverageText(scanner),
          String(scanner.counts.failed),
          String(scanner.counts.excepted),
          String(scanner.counts.reported),
        ]),
      );
    }
    lines.push('');
    lines.push('Hasil pemindai hanya membuktikan cakupan pemindai itu; tidak ditemukannya masalah bukan bukti aplikasi aman.', '');
  }

  lines.push('## Discovery', '');
  lines.push(`Status discovery: ${report.discovery.status}.`, '');
  if (report.discovery.problems.length > 0) {
    lines.push(...header(['Kode', 'Script', 'Path']));
    for (const problem of report.discovery.problems) lines.push(row([problem.code, problem.script, problem.path]));
    lines.push('');
  }

  lines.push('## Alur kritis', '');
  if (report.critical.length === 0) lines.push('Tidak ada skenario bertanda `critical`.', '');
  else {
    lines.push(...header(['ID', 'Status']));
    for (const item of report.critical) lines.push(row([item.id, item.status]));
    lines.push('');
  }

  lines.push('## Hasil per skenario', '');
  const counts = STATUS_ORDER.map((status) => `${report.scenarios.filter((scenario) => scenario.status === status).length} ${status}`);
  lines.push(`${report.scenarios.length} skenario: ${counts.join(', ')}.`, '');
  lines.push(
    ...header(['ID', 'Kriteria dan rujukan specs', 'Test dan profil', 'Wajib untuk release', 'Status', 'Hasil aktual dan tautan bukti']),
  );
  for (const scenario of report.scenarios) {
    lines.push(
      row([
        scenario.id,
        `${scenario.criteria.join(', ')}; ${scenario.source}`,
        `${scenario.checks.map(describeCheck).join('; ')}; profil k6 tidak ada`,
        scenario.critical ? 'ya, alur kritis' : 'ya',
        scenario.status,
        scenario.checks.map(describeOutcome).join('; '),
      ]),
    );
  }
  lines.push('');

  lines.push('## Kandidat release', '');
  lines.push(releaseLine(report.releaseCandidate), '');
  for (const reason of report.releaseCandidate.reasons) {
    lines.push(`- \`${reason.code}\`${reason.tier === null ? '' : ` tier ${reason.tier}`}: ${releaseText[reason.code]}.`);
  }
  if (report.releaseCandidate.reasons.length > 0) lines.push('');
  lines.push('Tanda ini tidak mengubah status gate maupun exit code `test:report`.', '');

  lines.push('## Di luar cakupan', '');
  for (const item of report.outOfScope) {
    lines.push(
      item.area === 'performance'
        ? `- Performance k6 belum masuk gate (fitur ${item.feature}).`
        : `- Identitas image deployment belum diikat pada laporan (fitur ${item.feature}).`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Builds the report, writes `report.json` and `report.md`, appends the Markdown to the file named by
 * `GITHUB_STEP_SUMMARY` when that variable exists, and resolves to 0 only for gate `passed`. The release candidate flag
 * never changes the exit code.
 */
/**
 * One console line: control characters, a line break among them, become spaces, so text from a bundle (a JUnit path)
 * can never start a line of its own, such as a `::` workflow command of GitHub Actions.
 */
export function consoleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export async function runReport(
  root: string,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  env: Environment = process.env,
): Promise<number> {
  const log = (line: string) => write(consoleLine(line));
  const report = await buildReport(root, env);
  const markdown = renderMarkdown(report);
  await mkdir(join(root, REPORT_DIR), { recursive: true });
  await writeFile(join(root, REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(root, REPORT_MD), markdown);
  const summary = env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') await appendFile(summary, `${markdown}\n`);

  log(`Gate ${report.gate}`);
  log(`  tier: ${TIER_NAMES.map((name) => `${name} ${report.tiers[name].status}`).join(', ')}`);
  const counts = STATUS_ORDER.map((status) => `${report.scenarios.filter((scenario) => scenario.status === status).length} ${status}`);
  log(`  skenario: ${report.scenarios.length} (${counts.join(', ')})`);
  log(`  alur kritis: ${report.critical.map((item) => `${item.id} ${item.status}`).join(', ') || 'tidak ada'}`);
  log(`  discovery: ${report.discovery.status}`);
  for (const problem of report.discovery.problems) log(`    ${problem.code} ${problem.script} ${problem.path}`);
  const scanners = report.scanners === null ? 'tidak tersedia' : report.scanners.scanners.map((item) => `${item.name} ${item.status}`).join(', ');
  log(`  pemindai: ${scanners}`);
  if (report.binding.valid) log('  pengikatan sah');
  else {
    const problems = report.binding.problems.map((problem) => [problem.code, problem.tier, problem.path].filter(Boolean).join(' '));
    log(`  pengikatan tidak sah: ${problems.join(', ')}`);
  }
  log(`  ${releaseLine(report.releaseCandidate).replace(/`/g, '')}`);
  log(`Laporan: ${REPORT_JSON} dan ${REPORT_MD}`);
  return report.gate === 'passed' ? 0 : 1;
}
