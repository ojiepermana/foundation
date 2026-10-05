import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  bundlePath,
  CAPACITY_TIER,
  CAPACITY_TIER_NAME,
  ciIdentity,
  REASON_CODES,
  DEPLOYMENT_CHECKS,
  DEPLOYMENT_EVIDENCE_DIR,
  deploymentResult,
  fileChecksum,
  gitCommit,
  performanceProfile,
  performanceResult,
  sourceTree,
  TIER_NAMES,
  tierByName,
  tierSteps,
  type BindingReasonCode,
  type CapacityReleaseReasonCode,
  type CheckReasonCode,
  type CiIdentity,
  type DeploymentCheckName,
  type DiscoveryReasonCode,
  type EvidenceRecord,
  type Reason,
  type ReleaseReadinessReasonCode,
  type ReleaseReasonCode,
  type RunTierName,
  type StepReasonCode,
  type StepRecord,
  type StepStatus,
  type TierEnvironment,
  type TierManifest,
  type TierName,
} from './gate.ts';
import { EVIDENCE_TEXT_LIMIT, JUnitError, junitResults, parseJUnit, type JUnitDocument, type JUnitResult } from './junit.ts';
import { readRegistries, type RegistryCheck, type RegistryScenario } from './registry-reader.ts';
import { SCANNER_NAMES, SECURITY_JSON, type Coverage, type Policy, type ScannerName, type ScannerReasonCode, type ScannerStatus } from './security-policy.ts';
import { inventory, junitDiscovery, junitSuitePath, ownedBy, RUNNER_OWNERS, runnerOwner } from './test-inventory.ts';

// `bun run test:report` of spec 0010 (AC-6, AC-7, AC-8): reads the three tier bundles, binds them to one candidate,
// computes the status of every registry check from the manifest and the JUnit in the bundle, proves discovery from the
// JUnit of every runner, summarizes the scanners and the PostgreSQL image of the real tier, flags the release
// candidate, and writes `report.json`, `report.md`, and the job summary. Nothing is stored between runs: every run
// computes the gate again from the bundles and the checkout. Spec 0011 adds `test:report:capacity`: the same reading of
// the one bundle of the capacity tier, bound to the checkout, for the scenarios whose checks all name its scripts. Spec
// 0012 adds `test:report:release`: both reports computed again with the CI identity of their own manifests, and the
// release status `ready`, `blocked`, or `incomplete`, which never grants a deployment.

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

export type BindingProblem = { code: BindingReasonCode; tier: RunTierName | null; path: string | null };

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

/**
 * What the per push gate does not prove (*Isi laporan*, `outOfScope`, as changed by specs 0011 and 0012): the capacity
 * profiles, proven by `test:report:capacity` from the capacity tier. The deployment image is now bound to the report
 * through the field `deployment` (spec 0012), so it is no longer out of scope here; the capacity report keeps it.
 */
export type OutOfScope = { area: 'capacity_profiles' | 'deployment_image'; feature: number };
export const OUT_OF_SCOPE: readonly OutOfScope[] = [{ area: 'capacity_profiles', feature: 12 }];

/** The `result.json` fields one `performance` entry copies as is (spec 0011, *Laporan per push*). */
export const PERFORMANCE_FIELDS = [
  'model',
  'actual',
  'latency',
  'readiness',
  'thresholds',
  'observation',
  'outage',
  'environment',
  'limits',
] as const;

/**
 * One entry of `performance` (spec 0011, *Laporan per push*): the tier step that has `performance` evidence bound to
 * its manifest, the profile and status of that `result.json`, the bundle path it was read from, and the fields of
 * `PERFORMANCE_FIELDS` copied as is (`null` when the file has none).
 */
export type PerformanceEntry = {
  tier: RunTierName;
  script: string;
  profile: string;
  status: 'passed' | 'failed';
  evidence: string;
} & Record<(typeof PERFORMANCE_FIELDS)[number], unknown>;

/** The step of the real tier whose `result.json` and `images.json` fill `deployment` (spec 0012). */
export const DEPLOYMENT_STEP = 'test:deployment:real';
export const DEPLOYMENT_RESULT = `${DEPLOYMENT_EVIDENCE_DIR}/result.json`;
export const DEPLOYMENT_IMAGES = `${DEPLOYMENT_EVIDENCE_DIR}/images.json`;
/** The three images of the *Image* table of spec 0012, in the order `images.json` lists them. */
export const DEPLOYMENT_IMAGE_NAMES = ['frontend', 'backend', 'migrate'] as const;

/** One image of `deployment.images`: the fields of `images.json`, with the two build labels taken out of `labels`. */
export type DeploymentImage = {
  name: (typeof DEPLOYMENT_IMAGE_NAMES)[number];
  tag: string;
  imageId: string | null;
  sizeBytes: number | null;
  user: string | null;
  bases: string[];
  revision: string | null;
  sourceTree: string | null;
};

/**
 * `deployment` of the per push report (spec 0012, *Perubahan gate yang dinamai*, Laporan per push): the status of the
 * deployment step, the bundle path of its `result.json`, the images, and every check with its status. `boundary` is the
 * fixed text of `result.json`, copied so `report.md` can print it while it stays derived from `report.json` only
 * (decision 53 of the spec rationale); `null` when the file has none.
 */
export type DeploymentReport = {
  status: 'passed' | 'failed';
  evidence: string;
  images: DeploymentImage[];
  checks: Array<{ name: DeploymentCheckName; status: 'passed' | 'failed' | 'not_run' }>;
  boundary: string | null;
};

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
  /** Spec 0011: after `outOfScope`, empty when no `performance` evidence matches its manifest. */
  performance: PerformanceEntry[];
  /** Spec 0012: after `performance`, `null` unless both deployment files are bound to the real manifest and valid. */
  deployment: DeploymentReport | null;
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
const evidenceKinds = new Set<string>(['junit', 'screenshots', 'image', 'scan', 'scanner', 'performance', 'data', 'deployment']);
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

function validManifest(value: unknown, tier: RunTierName): value is TierManifest {
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
  name: RunTierName;
  manifest: TierManifest | null;
  /** Evidence paths whose bundle copy matches the SHA 256 in the manifest. */
  verified: Set<string>;
};

/** The manifest of one bundle when it exists and is valid, else the binding code that says why there is none. */
async function readManifest(
  root: string,
  name: RunTierName,
): Promise<{ manifest: TierManifest; problem: null } | { manifest: null; problem: 'manifest_missing' | 'manifest_invalid' }> {
  let text: string;
  try {
    text = await readFile(join(root, bundlePath(name), 'manifest.json'), 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
    return { manifest: null, problem: 'manifest_missing' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  return validManifest(value, name) ? { manifest: value, problem: null } : { manifest: null, problem: 'manifest_invalid' };
}

async function loadTier(root: string, name: RunTierName, problems: BindingProblem[]): Promise<LoadedTier> {
  const loaded: LoadedTier = { name, manifest: null, verified: new Set() };
  const read = await readManifest(root, name);
  if (read.manifest === null) {
    problems.push({ code: read.problem, tier: name, path: null });
    return loaded;
  }
  const value = read.manifest;
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
  const tierScript = tiers.find((tier) => tierByName(tier.name)?.script === check.script);
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

/**
 * Spec 0011 (*Tier kapasitas dan gate*, Registry): a scenario whose checks all name a script of the capacity tier, one of
 * its steps or its root script, is counted only by `test:report:capacity`, and `test:report` leaves it out. A scenario
 * without checks, or one that also names a script of another tier, stays with the per push report; `test:scenarios`
 * rejects that mix, and the per push report then finds no capacity step and reads the check as `not_run`.
 */
export function capacityScenario(checks: readonly Pick<RegistryCheck, 'script'>[]): boolean {
  const steps = tierSteps();
  return checks.length > 0 && checks.every((check) => check.script === CAPACITY_TIER.script || steps.get(check.script) === CAPACITY_TIER_NAME);
}

/** The status of every check of every registry scenario that `include` keeps, in registry order. */
async function evaluateScenarios(
  root: string,
  tiers: LoadedTier[],
  documents: JUnitDocuments,
  include: (scenario: RegistryScenario) => boolean,
): Promise<ScenarioResult[]> {
  const scenarios: ScenarioResult[] = [];
  for (const registry of await readRegistries(root)) {
    for (const scenario of registry.scenarios) {
      if (!include(scenario)) continue;
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
  return scenarios;
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

/**
 * *Laporan per push*: one entry per `performance` evidence file of a per push tier step whose bundle copy matches the
 * SHA 256 of its manifest, in tier and step order. A file that is not a JSON object with `schema` 1, the profile of its
 * step script, and `status` `passed` or `failed` gives no entry, so the report never renders a shape it did not check;
 * the gate already failed that step with `evidence_invalid`.
 */
async function readPerformance(root: string, tiers: readonly LoadedTier[]): Promise<PerformanceEntry[]> {
  const entries: PerformanceEntry[] = [];
  for (const tier of tiers) {
    for (const step of tier.manifest?.steps ?? []) {
      for (const evidence of step.evidence) {
        if (evidence.kind !== 'performance' || !evidence.present || typeof evidence.sha256 !== 'string') continue;
        const object = jsonObject(await readVerified(root, tier, evidence.path));
        const result = object === null ? null : performanceResult(object, step.script);
        if (object === null || result === null) continue;
        const entry: PerformanceEntry = {
          tier: tier.name,
          script: step.script,
          profile: result.profile,
          status: result.status,
          evidence: `${bundlePath(tier.name)}/${evidence.path}`,
          model: null,
          actual: null,
          latency: null,
          readiness: null,
          thresholds: null,
          observation: null,
          outage: null,
          environment: null,
          limits: null,
        };
        for (const field of PERFORMANCE_FIELDS) entry[field] = object[field] ?? null;
        entries.push(entry);
      }
    }
  }
  return entries;
}

/** One image record of `images.json`, or `null` when a field has another type than the images.json paragraph names. */
function deploymentImage(value: unknown, name: DeploymentImage['name']): DeploymentImage | null {
  if (!isRecord(value) || value['name'] !== name || typeof value['tag'] !== 'string') return null;
  const { imageId, sizeBytes, user, bases, labels } = value;
  if (!stringOrNull(imageId) || !stringOrNull(user)) return null;
  if (sizeBytes !== null && !(typeof sizeBytes === 'number' && Number.isInteger(sizeBytes) && sizeBytes >= 0)) return null;
  if (!Array.isArray(bases) || !bases.every((base) => typeof base === 'string')) return null;
  if (!isRecord(labels) || !stringOrNull(labels['revision']) || !stringOrNull(labels['sourceTree'])) return null;
  return {
    name,
    tag: value['tag'],
    imageId,
    sizeBytes: sizeBytes as number | null,
    user,
    bases: [...(bases as string[])],
    revision: labels['revision'],
    sourceTree: labels['sourceTree'],
  };
}

/**
 * *Laporan per push* of spec 0012: `deployment` from `result.json` and `images.json` of `test:deployment:real` in the
 * real bundle, only when the step recorded both with their SHA 256, both bundle copies match it, `result.json` has the
 * shape of `deploymentResult`, and `images.json` has `schema` 1 and the three images of the *Image* table in order.
 * Otherwise `null` as a whole, never a partial entry. The step status does not matter, and the gate never reads it.
 */
async function readDeployment(root: string, tiers: readonly LoadedTier[]): Promise<DeploymentReport | null> {
  const real = tiers.filter((tier) => tier.name === 'real');
  const result = jsonObject(await boundEvidence(root, real, DEPLOYMENT_STEP, DEPLOYMENT_RESULT));
  const images = jsonObject(await boundEvidence(root, real, DEPLOYMENT_STEP, DEPLOYMENT_IMAGES));
  if (result === null || images === null) return null;
  const shape = deploymentResult(result);
  if (shape === null || images['schema'] !== 1 || !Array.isArray(images['images'])) return null;
  const list = images['images'];
  if (list.length !== DEPLOYMENT_IMAGE_NAMES.length) return null;
  const records: DeploymentImage[] = [];
  for (const [index, name] of DEPLOYMENT_IMAGE_NAMES.entries()) {
    const record = deploymentImage(list[index], name);
    if (record === null) return null;
    records.push(record);
  }
  const boundary = result['boundary'];
  return {
    status: shape.status,
    evidence: `${bundlePath('real')}/${DEPLOYMENT_RESULT}`,
    images: records,
    checks: shape.checks,
    boundary: typeof boundary === 'string' ? boundary : null,
  };
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
  const valid = TIER_NAMES.map((name) => ({ name, manifest: manifests.find((manifest) => manifest?.tier === name) ?? null }));
  const reasons: ReleaseReason[] = [];
  if (gate !== 'passed') reasons.push({ code: 'gate_not_passed', tier: null });
  for (const { name, manifest } of valid) if (manifest !== null && !manifest.candidate.clean) reasons.push({ code: 'not_clean', tier: name });
  for (const { name, manifest } of valid) if (manifest !== null && manifest.candidate.ci === null) reasons.push({ code: 'not_ci', tier: name });
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

/**
 * The per push report. `reportCi` is the CI identity the bundles are bound to and judged by (spec 0012, *Perhitungan
 * laporan release* (1)): by default the identity of the report process, so `test:report` keeps its behavior, and the
 * identity `bundleCi` read from the manifests when `test:report:release` builds it.
 */
export async function buildReport(
  root: string,
  env: Environment = process.env,
  reportCi: CiIdentity | null = ciIdentity(env),
): Promise<GateReport> {
  const problems: BindingProblem[] = [];
  const tiers: LoadedTier[] = [];
  for (const name of TIER_NAMES) tiers.push(await loadTier(root, name, problems));
  const manifests = tiers.map((tier) => tier.manifest);
  const candidate: ReportCandidate = {
    commit: await gitCommit(root, env),
    sourceTree: await sourceTree(root, undefined, env),
    ci: reportCi,
  };
  if (candidate.commit === null) problems.push({ code: 'no_commit', tier: null, path: null });
  problems.push(...crossBinding(candidate, manifests));

  const documents = new JUnitDocuments(root);
  // Spec 0011: the capacity scenarios belong to the capacity report only, so the per push gate never waits for them.
  const scenarios = await evaluateScenarios(root, tiers, documents, (scenario) => !capacityScenario(scenario.checks));

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
    performance: await readPerformance(root, tiers),
    deployment: await readDeployment(root, tiers),
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

/**
 * Kolom *Test dan profil* (spec 0011): the k6 profile of every check whose script is exactly
 * `test:performance:<profile>`, without duplicates, in check order, or `tidak ada`.
 */
export function profileSuffix(checks: readonly Pick<CheckResult, 'script'>[]): string {
  const profiles = [...new Set(checks.map((check) => performanceProfile(check.script)).filter((profile) => profile !== null))];
  return `profil k6 ${profiles.length === 0 ? 'tidak ada' : profiles.join(', ')}`;
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
export function releaseLine(release: { value: boolean; reasons: ReadonlyArray<{ code: string; tier: string | null }> }): string {
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

// ---------------------------------------------------------------------------------------------------------------
// *Performance k6* (spec 0011, *Laporan per push*), rendered only from the `performance` entries. Every value comes
// from a bundle file, so each one passes a type guard and is printed inside an escaped table cell, or only as a number;
// a field with another shape prints `-`. The engine that runs the containers is labelled "mesin container", from the
// key `containerEngine`, and its values are printed as they are.

/** The expressions that only make k6 record a submetric (Thresholds, Pencatatan and Beban aktual): never a target. */
const RECORDING_EXPRESSIONS = new Set(['max>=0', 'min>=0', 'count>=0']);

type ThresholdItem = { metric: string; expression: string; ok: boolean };

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A whole number as is, any other number with `digits` decimals, and `-` for anything that is not a finite number. */
function numberText(value: unknown, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

/** Text without control characters cut to 200 characters, a number, `ya` or `tidak`, `-` for null, or compact JSON. */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return runnerText(value);
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'boolean') return value ? 'ya' : 'tidak';
  return runnerText(JSON.stringify(value) ?? '-');
}

function thresholdItems(value: unknown): ThresholdItem[] {
  return records(value).flatMap((item) => {
    const { metric, expression, ok } = item;
    return typeof metric === 'string' && typeof expression === 'string' && typeof ok === 'boolean' ? [{ metric, expression, ok }] : [];
  });
}

/**
 * The target expressions of one metric, without the recording expressions, and whether they all held. A metric with
 * only recording expressions, or with no threshold at all (a phase without a target), reads `tanpa target`.
 */
function target(thresholds: readonly ThresholdItem[], metric: string): [string, string] {
  const targets = thresholds.filter((item) => item.metric === metric && !RECORDING_EXPRESSIONS.has(item.expression));
  if (targets.length === 0) return ['tanpa target', '-'];
  return [targets.map((item) => item.expression).join(', '), targets.every((item) => item.ok) ? 'lulus' : 'gagal'];
}

function modelText(model: unknown): string {
  const phases = records(isRecord(model) ? model['phases'] : undefined).map(
    (phase) => `${valueText(phase['phase'])} ${valueText(phase['shape'])} ${numberText(phase['seconds'])} detik ${valueText(phase['load'])}`,
  );
  if (phases.length === 0) return '-';
  const one = isRecord(model) && model['iterationIsOneRequest'] === true ? '; satu iterasi satu request' : '';
  return `${phases.join(', ')}${one}`;
}

function loadSection(entry: PerformanceEntry, thresholds: readonly ThresholdItem[]): string[] {
  const lines = ['#### Beban target dan aktual', ''];
  const actual = entry.actual;
  if (!isRecord(actual)) {
    lines.push('Ringkasan k6 tidak tersedia, sehingga beban aktual, latency, readiness, dan thresholds tidak tercatat.', '');
    return lines;
  }
  lines.push(
    ...header(['Scenario', 'Endpoint', 'Fase', 'Laju rencana per detik', 'Detik', 'Iterasi rencana', 'Iterasi aktual', 'Laju aktual per detik', 'Ambang iterasi', 'Status ambang']),
  );
  for (const scenario of records(actual['scenarios'])) {
    const name = scenario['name'];
    const start = scenario['startRate'];
    const end = scenario['endRate'];
    const rate = start === end ? numberText(start) : `${numberText(start)} ke ${numberText(end)}`;
    const [expression, status] = typeof name === 'string' ? target(thresholds, `iterations{scenario:${name}}`) : ['-', '-'];
    lines.push(
      row([
        valueText(name),
        valueText(scenario['endpoint']),
        valueText(scenario['phase']),
        rate,
        numberText(scenario['seconds']),
        numberText(scenario['plannedIterations']),
        numberText(scenario['iterations']),
        numberText(scenario['rate']),
        expression,
        status,
      ]),
    );
  }
  lines.push('');
  lines.push(...header(['Total', 'Nilai']));
  lines.push(row(['Iterasi', numberText(actual['iterations'])]));
  lines.push(row(['Request HTTP', numberText(actual['httpReqs'])]));
  lines.push(row(['Dropped iterations', numberText(actual['droppedIterations'])]));
  lines.push(row(['VU maksimum', numberText(actual['vusMax'])]));
  lines.push(row(['Scenario mulai sesudah T0 (ms)', numberText(actual['scenarioStartLateMs'])]));
  lines.push('');
  return lines;
}

function latencySection(entry: PerformanceEntry, thresholds: readonly ThresholdItem[]): string[] {
  if (!Array.isArray(entry.latency)) return [];
  const lines = ['#### Latency terhadap target', ''];
  lines.push(...header(['Endpoint', 'Fase', 'Hasil', 'Jumlah', 'p50', 'p95', 'p99', 'max', 'Target', 'Status target']));
  for (const item of records(entry.latency)) {
    const { endpoint, phase, outcome } = item;
    let metric: string | null = null;
    if (typeof phase === 'string' && endpoint === 'status') metric = `http_req_duration{endpoint:status,phase:${phase}}`;
    else if (typeof phase === 'string' && endpoint === 'readiness' && typeof outcome === 'string') metric = `readiness_${outcome}_duration{phase:${phase}}`;
    const [expression, status] = metric === null ? ['-', '-'] : target(thresholds, metric);
    lines.push(
      row([
        valueText(endpoint),
        valueText(phase),
        valueText(outcome),
        numberText(item['count']),
        numberText(item['p50']),
        numberText(item['p95']),
        numberText(item['p99']),
        numberText(item['max']),
        expression,
        status,
      ]),
    );
  }
  lines.push('');
  return lines;
}

function readinessSection(entry: PerformanceEntry, thresholds: readonly ThresholdItem[]): string[] {
  const readiness = entry.readiness;
  if (!isRecord(readiness)) return [];
  const lines = ['#### Rasio readiness', ''];
  lines.push(...header(['Fase', '200 tersedia', '429 sibuk', '503 tidak tersedia', 'Rasio tersedia', 'Target rasio', 'Status target']));
  for (const item of records(readiness['phases'])) {
    const phase = item['phase'];
    const [expression, status] = typeof phase === 'string' ? target(thresholds, `readiness_available{phase:${phase}}`) : ['-', '-'];
    lines.push(
      row([
        valueText(phase),
        numberText(item['available']),
        numberText(item['busy']),
        numberText(item['unavailable']),
        numberText(item['availableRatio'], 3),
        expression,
        status,
      ]),
    );
  }
  lines.push('');
  const recovery = readiness['recoveryMs'];
  if (typeof recovery === 'number') lines.push(`Waktu pemulihan readiness: ${numberText(recovery)} ms.`, '');
  return lines;
}

function thresholdSection(entry: PerformanceEntry, thresholds: readonly ThresholdItem[]): string[] {
  if (!Array.isArray(entry.thresholds)) return [];
  const failed = thresholds.filter((item) => !item.ok);
  const lines = ['#### Thresholds', '', `${thresholds.length - failed.length} dari ${thresholds.length} threshold lulus.`, ''];
  if (failed.length > 0) {
    lines.push(...header(['Metrik yang gagal', 'Ekspresi']));
    for (const item of failed) lines.push(row([item.metric, item.expression]));
    lines.push('');
  }
  return lines;
}

function observationSection(entry: PerformanceEntry): string[] {
  const lines = ['#### Resource, pool, dan check pengamatan', ''];
  const observation = entry.observation;
  if (!isRecord(observation)) {
    lines.push('Pengamatan tidak dinilai pada run ini.', '');
    return lines;
  }
  const containers = observation['containers'];
  if (isRecord(containers)) {
    lines.push(
      ...header([
        'Container',
        'CPU rata rata (persen satu CPU)',
        'CPU maksimum',
        'Memory rata rata (MiB)',
        'Memory maksimum (MiB)',
        'Pertumbuhan memory (MiB)',
        'Restart',
        'OOM',
        'Byte stderr',
      ]),
    );
    for (const [name, value] of Object.entries(containers)) {
      const item = isRecord(value) ? value : {};
      lines.push(
        row([
          name,
          numberText(item['cpuMean']),
          numberText(item['cpuMax']),
          numberText(item['memoryMeanMiB']),
          numberText(item['memoryMaxMiB']),
          numberText(item['memoryGrowthMiB']),
          valueText(item['restarts']),
          valueText(item['oomKilled']),
          valueText(item['stderrBytes']),
        ]),
      );
    }
    lines.push('');
  }
  const pool = observation['pool'];
  if (isRecord(pool)) {
    lines.push(...header(['Pool', 'Nilai']));
    lines.push(row(['Sesi foundation_backend maksimum', numberText(pool['sessions'])]));
    lines.push(row(['Sesi foundation_backend aktif maksimum', numberText(pool['nonIdle'])]));
    lines.push(row(['Sesi client maksimum', numberText(pool['total'])]));
    lines.push(row(['Sampel berhasil', numberText(pool['samples'])]));
    lines.push(row(['Sampel gagal', numberText(pool['failedSamples'])]));
    lines.push('');
  }
  const checks = records(observation['checks']);
  lines.push(...header(['Check', 'Aturan', 'Aktual', 'Lulus']));
  for (const check of checks) {
    lines.push(row([valueText(check['name']), valueText(check['rule']), valueText(check['actual']), check['ok'] === true ? 'ya' : 'tidak']));
  }
  if (checks.length === 0) lines.push(row(['-', 'tidak ada check pengamatan', '-', '-']));
  lines.push('');
  return lines;
}

function outageSection(entry: PerformanceEntry): string[] {
  if (!isRecord(entry.outage)) return [];
  const lines = ['#### Kontrol outage', '', ...header(['Waktu', 'ms sesudah T0'])];
  for (const [name, value] of Object.entries(entry.outage)) lines.push(row([name, numberText(value)]));
  lines.push('');
  return lines;
}

function environmentSection(entry: PerformanceEntry): string[] {
  const lines = ['#### Environment', ''];
  const environment = entry.environment;
  if (!isRecord(environment)) {
    lines.push('Environment tidak tercatat.', '');
    return lines;
  }
  const engine = isRecord(environment['containerEngine']) ? environment['containerEngine'] : null;
  const images = isRecord(environment['images']) ? environment['images'] : {};
  const postgres = isRecord(images['postgres']) ? images['postgres'] : null;
  const pool = isRecord(environment['pool']) ? environment['pool'] : {};
  const data = isRecord(environment['data']) ? environment['data'] : {};
  const clock = isRecord(environment['clockOffsetMs']) ? environment['clockOffsetMs'] : {};
  lines.push(...header(['Aspek', 'Nilai']));
  lines.push(row(['Host', `${valueText(environment['os'])} ${valueText(environment['arch'])}`]));
  lines.push(row(['CPU host', `${valueText(environment['cpuModel'])}, ${numberText(environment['cpuCount'])} CPU`]));
  lines.push(row(['Memory host (byte)', numberText(environment['memoryBytes'])]));
  lines.push(
    row([
      'Mesin container',
      engine === null
        ? '-'
        : `versi server ${valueText(engine['serverVersion'])}, ${valueText(engine['os'])}, ${numberText(engine['ncpu'])} CPU, memory ${numberText(engine['memTotal'])} byte`,
    ]),
  );
  lines.push(row(['Container lain yang berjalan', numberText(environment['otherContainersRunning'])]));
  lines.push(row(['CI', valueText(environment['ci'])]));
  lines.push(row(['Image k6', valueText(images['k6'])]));
  lines.push(row(['Image Bun', valueText(images['bun'])]));
  lines.push(
    row([
      'PostgreSQL',
      postgres === null
        ? '-'
        : `${valueText(postgres['image'])}, image id ${valueText(postgres['imageId'])}, base ${valueText(postgres['baseImage'])}, versi ${valueText(postgres['serverVersion'])}`,
    ]),
  );
  const limits = isRecord(environment['limits']) ? environment['limits'] : {};
  for (const [name, value] of Object.entries(limits)) {
    const parts = isRecord(value) ? Object.entries(value).map(([key, item]) => `${key} ${valueText(item)}`) : [valueText(value)];
    lines.push(row([`Batas resource ${name}`, parts.join(', ')]));
  }
  lines.push(row(['Pool', `max ${numberText(pool['max'])}, connectionTimeout ${numberText(pool['connectionTimeoutSeconds'])} detik`]));
  lines.push(row(['Data', `${numberText(data['appliedMigrations'])} migration`]));
  lines.push(row(['Selisih jam (ms)', `sebelum T0 ${numberText(clock['before'])}, sesudah k6 ${numberText(clock['after'])}`]));
  lines.push('');
  return lines;
}

function limitsSection(entry: PerformanceEntry): string[] {
  const lines = ['#### Batas bukti', ''];
  const limits = Array.isArray(entry.limits) ? entry.limits.filter((item): item is string => typeof item === 'string') : [];
  if (limits.length === 0) {
    lines.push('Batas bukti tidak tercatat.', '');
    return lines;
  }
  lines.push(...header(['No', 'Batas bukti']));
  // Written as is (only control characters go), never cut: the sentences are fixed by the spec.
  limits.forEach((item, index) => lines.push(row([String(index + 1), item.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')])));
  lines.push('');
  return lines;
}

/** `source` names the tiers the entries come from: `tier per push` for `test:report`, `tier kapasitas` for the other. */
function performanceSection(entries: readonly PerformanceEntry[], source = 'tier per push'): string[] {
  const lines = ['## Performance k6', ''];
  if (entries.length === 0) {
    lines.push(`Tidak ada bukti \`performance\` dari ${source} yang cocok dengan manifest nya.`, '');
    return lines;
  }
  lines.push(
    `Disalin dari \`result.json\` setiap profil k6 di bundle ${source} yang SHA 256 nya cocok dengan manifest. Angka ini berlaku untuk environment dan batas bukti yang tercatat, bukan perkiraan kapasitas produk. Latency dalam milidetik.`,
    '',
  );
  for (const entry of entries) {
    const thresholds = thresholdItems(entry.thresholds);
    lines.push(`### Profil ${entry.profile}`, '');
    lines.push(...header(['Aspek', 'Nilai']));
    lines.push(row(['Status', entry.status]));
    lines.push(row(['Tier dan langkah', `${entry.tier}, ${entry.script}`]));
    lines.push(row(['Bukti', entry.evidence]));
    lines.push(row(['Model beban', modelText(entry.model)]));
    lines.push('');
    lines.push(
      ...loadSection(entry, thresholds),
      ...latencySection(entry, thresholds),
      ...readinessSection(entry, thresholds),
      ...thresholdSection(entry, thresholds),
      ...observationSection(entry),
      ...outageSection(entry),
      ...environmentSection(entry),
      ...limitsSection(entry),
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// *Deployment* (spec 0012, *Laporan per push*), rendered only from the `deployment` field: the image table, the check
// table with the criteria of DEPLOYMENT_CHECKS, the boundary text, and the sentence that the images are local only.

/** The fixed sentence of the *Deployment* section: printed with and without evidence. */
export const DEPLOYMENT_LOCAL_ONLY =
  'Image dibangun lokal dari root monorepo oleh `test:deployment:real`, tidak didorong ke registry, dan bukti ini bukan izin deploy.';

/** The criteria column of the check table: the acceptance criteria DEPLOYMENT_CHECKS names for `name`. */
export function deploymentCriteria(name: string): string {
  return DEPLOYMENT_CHECKS.find((check) => check.name === name)?.criteria.join(', ') ?? '-';
}

function deploymentSection(deployment: DeploymentReport | null): string[] {
  const lines = ['## Deployment', ''];
  if (deployment === null) {
    lines.push(
      'Bukti deployment tidak tersedia karena `result.json` atau `images.json` tidak ada di bundle tier nyata, tidak cocok dengan manifest, atau bentuknya tidak sah. Penyebabnya terlihat pada alasan langkah dan pengikatan.',
      '',
      DEPLOYMENT_LOCAL_ONLY,
      '',
    );
    return lines;
  }
  const passed = deployment.checks.filter((check) => check.status === 'passed').length;
  lines.push(...header(['Aspek', 'Nilai']));
  lines.push(row(['Status', deployment.status]));
  lines.push(row(['Check passed', `${passed} dari ${deployment.checks.length}`]));
  lines.push(row(['Bukti', deployment.evidence]));
  lines.push('', DEPLOYMENT_LOCAL_ONLY, '');
  lines.push('### Image deployment', '');
  lines.push(...header(['Image', 'Tag', 'Image ID', 'Ukuran (byte)', 'User', 'Image dasar', 'Revision', 'Pohon sumber']));
  for (const image of deployment.images) {
    lines.push(
      row([
        image.name,
        image.tag,
        image.imageId ?? '-',
        image.sizeBytes === null ? '-' : String(image.sizeBytes),
        image.user ?? '-',
        image.bases.join(', ') || '-',
        image.revision ?? '-',
        image.sourceTree ?? '-',
      ]),
    );
  }
  lines.push('');
  lines.push('### Check deployment', '');
  lines.push(...header(['Check', 'Kriteria', 'Status']));
  for (const check of deployment.checks) lines.push(row([check.name, deploymentCriteria(check.name), check.status]));
  lines.push('');
  lines.push('### Batas bukti deployment', '');
  // Written as is (only control characters go), never cut: the text is fixed by the spec.
  lines.push(deployment.boundary === null ? 'Batas bukti tidak tercatat.' : deployment.boundary.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''), '');
  return lines;
}

/** One line of *Di luar cakupan*, for the per push and the capacity report alike. */
function outOfScopeLine(item: OutOfScope, capacityReport: boolean): string {
  if (item.area === 'deployment_image') {
    return `- Profil kapasitas masih mengukur komposisi development, bukan image deployment (fitur ${item.feature}).`;
  }
  return capacityReport
    ? `- Profil kapasitas load, stress, spike, outage, dan soak (fitur ${item.feature}).`
    : `- Profil kapasitas load, stress, spike, outage, dan soak, dibuktikan \`test:report:capacity\` dari tier kapasitas (fitur ${item.feature}).`;
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
        `${scenario.checks.map(describeCheck).join('; ')}; ${profileSuffix(scenario.checks)}`,
        scenario.critical ? 'ya, alur kritis' : 'ya',
        scenario.status,
        scenario.checks.map(describeOutcome).join('; '),
      ]),
    );
  }
  lines.push('');

  lines.push(...performanceSection(report.performance));
  lines.push(...deploymentSection(report.deployment));

  lines.push('## Kandidat release', '');
  lines.push(releaseLine(report.releaseCandidate), '');
  for (const reason of report.releaseCandidate.reasons) {
    lines.push(`- \`${reason.code}\`${reason.tier === null ? '' : ` tier ${reason.tier}`}: ${releaseText[reason.code]}.`);
  }
  if (report.releaseCandidate.reasons.length > 0) lines.push('');
  lines.push('Tanda ini tidak mengubah status gate maupun exit code `test:report`.', '');

  lines.push('## Di luar cakupan', '');
  for (const item of report.outOfScope) lines.push(outOfScopeLine(item, false));
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
  const performance = report.performance.map((item) => `${item.profile} ${item.status}`).join(', ');
  log(`  performance k6: ${performance || 'tidak ada bukti'}`);
  const deployment = report.deployment;
  log(
    `  deployment: ${deployment === null ? 'tidak ada bukti' : `${deployment.status} (${deployment.checks.filter((check) => check.status === 'passed').length} dari ${deployment.checks.length} check passed)`}`,
  );
  log(`  ${releaseLine(report.releaseCandidate).replace(/`/g, '')}`);
  log(`Laporan: ${REPORT_JSON} dan ${REPORT_MD}`);
  return report.gate === 'passed' ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// `bun run test:report:capacity` (spec 0011, *Laporan kapasitas*): the same reading as `test:report`, for the one
// bundle of the capacity tier. It counts only the capacity scenarios, binds the bundle to the checkout with the binding
// vocabulary of spec 0010, and flags a release candidate only for a clean `workflow_dispatch` run on `refs/heads/main`.
// The capacity tier never changes the per push gate, and the per push report never reads this bundle.

export const CAPACITY_REPORT_DIR = '.local/feature-12';
export const CAPACITY_REPORT_JSON = `${CAPACITY_REPORT_DIR}/report.json`;
export const CAPACITY_REPORT_MD = `${CAPACITY_REPORT_DIR}/report.md`;
/** The event of a capacity release candidate: the manual trigger of `.github/workflows/capacity.yml`. */
export const CAPACITY_RELEASE_EVENT = 'workflow_dispatch';
/**
 * What the capacity report does not prove (spec 0012, *Perubahan gate yang dinamai*, outOfScope): the capacity profiles
 * still measure the development composition, not the deployment image of feature 13.
 */
export const CAPACITY_OUT_OF_SCOPE: readonly OutOfScope[] = [{ area: 'deployment_image', feature: 13 }];

/** A capacity release reason has no tier: the report reads one tier only. */
export type CapacityReleaseReason = { code: CapacityReleaseReasonCode; tier: null };
export type CapacityReleaseCandidate = { value: boolean; reasons: CapacityReleaseReason[] };

/** `.local/feature-12/report.json`: exactly these keys, in this order (*Perubahan gate yang dinamai*). */
export type CapacityReport = {
  schema: 1;
  generatedAt: string;
  candidate: ReportCandidate;
  binding: { valid: boolean; problems: BindingProblem[] };
  /** The capacity tier in the shape of `tiers.<name>` of the per push report. */
  tier: TierSummary;
  scenarios: ScenarioResult[];
  status: GateStatus;
  releaseCandidate: CapacityReleaseCandidate;
  performance: PerformanceEntry[];
  outOfScope: OutOfScope[];
};

/**
 * `passed` when the capacity tier passed, every capacity scenario passed, and the binding is valid; `failed` when a step
 * or a check failed; `incomplete` otherwise (no bundle, a step not run, a scenario without evidence, an invalid binding).
 */
export function capacityStatus(input: {
  scenarios: readonly ScenarioResult[];
  manifest: TierManifest | null;
  bindingValid: boolean;
}): GateStatus {
  const failed =
    input.scenarios.some((scenario) => scenario.checks.some((check) => check.status === 'failed')) ||
    input.manifest?.steps.some((step) => step.status === 'failed') === true;
  if (failed) return 'failed';
  const passed = input.manifest?.status === 'passed' && input.scenarios.every((scenario) => scenario.status === 'passed') && input.bindingValid;
  return passed ? 'passed' : 'incomplete';
}

/**
 * The capacity release candidate: every unmet condition once, in the order of `REASON_CODES.capacityRelease`. A bundle
 * without a valid manifest gets neither `not_clean` nor a `not_ci` of its own; `event` and `ref` are judged only on the
 * CI identity of the report job.
 */
export function capacityReleaseCandidate(status: GateStatus, manifest: TierManifest | null, reportCi: CiIdentity | null): CapacityReleaseCandidate {
  const reasons: CapacityReleaseReason[] = [];
  if (status !== 'passed') reasons.push({ code: 'gate_not_passed', tier: null });
  if (manifest !== null && !manifest.candidate.clean) reasons.push({ code: 'not_clean', tier: null });
  if ((manifest !== null && manifest.candidate.ci === null) || reportCi === null) reasons.push({ code: 'not_ci', tier: null });
  if (reportCi !== null) {
    if (reportCi.event !== CAPACITY_RELEASE_EVENT) reasons.push({ code: 'event_not_dispatch', tier: null });
    if (reportCi.ref !== RELEASE_REF) reasons.push({ code: 'ref_not_main', tier: null });
  }
  return { value: reasons.length === 0, reasons };
}

/** The capacity report; `reportCi` as in `buildReport`, by default the identity of the report process. */
export async function buildCapacityReport(
  root: string,
  env: Environment = process.env,
  reportCi: CiIdentity | null = ciIdentity(env),
): Promise<CapacityReport> {
  const problems: BindingProblem[] = [];
  const tier = await loadTier(root, CAPACITY_TIER_NAME, problems);
  const candidate: ReportCandidate = {
    commit: await gitCommit(root, env),
    sourceTree: await sourceTree(root, undefined, env),
    ci: reportCi,
  };
  if (candidate.commit === null) problems.push({ code: 'no_commit', tier: null, path: null });
  problems.push(...crossBinding(candidate, [tier.manifest]));

  const scenarios = await evaluateScenarios(root, [tier], new JUnitDocuments(root), (scenario) => capacityScenario(scenario.checks));
  const binding = { valid: problems.length === 0, problems };
  const status = capacityStatus({ scenarios, manifest: tier.manifest, bindingValid: binding.valid });
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    candidate,
    binding,
    tier: summarizeTier(tier),
    scenarios,
    status,
    releaseCandidate: capacityReleaseCandidate(status, tier.manifest, candidate.ci),
    performance: await readPerformance(root, [tier]),
    outOfScope: CAPACITY_OUT_OF_SCOPE.map((item) => ({ ...item })),
  };
}

const capacityReleaseText: Record<CapacityReleaseReasonCode, string> = {
  gate_not_passed: 'laporan kapasitas tidak berstatus passed',
  not_clean: 'working tree tier kapasitas tidak bersih di awal atau di akhir tier',
  not_ci: 'tidak berasal dari run CI',
  event_not_dispatch: `event job laporan bukan ${CAPACITY_RELEASE_EVENT}`,
  ref_not_main: `ref job laporan bukan ${RELEASE_REF}`,
};

function capacityChecksums(values: Record<string, string | null> | null): string[] {
  if (values === null) return ['Manifest tier kapasitas tidak tersedia, sehingga checksum ini tidak tercatat.', ''];
  const paths = Object.keys(values).sort();
  if (paths.length === 0) return ['Manifest tier kapasitas tidak memuat checksum ini.', ''];
  const lines = header(['Path', CAPACITY_TIER_NAME]);
  for (const path of paths) lines.push(row([path, values[path] ?? 'tidak ada']));
  lines.push('');
  return lines;
}

/** `report.md` of the capacity report, in Indonesian, derived only from the fields of `CapacityReport`. */
export function renderCapacityMarkdown(report: CapacityReport): string {
  const lines: string[] = ['# Laporan kapasitas', ''];
  lines.push(
    'Laporan ini dihitung ulang oleh `bun run test:report:capacity` dari bundle bukti tier kapasitas. Hanya status `passed` dihitung lulus. Tier kapasitas dijalankan manual dan tidak mengubah status gate per push.',
    '',
  );

  lines.push('## Kandidat', '');
  lines.push(...header(['Aspek', 'Nilai']));
  lines.push(row(['Status laporan kapasitas', report.status]));
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

  const tier = report.tier;
  const passedSteps = tier.steps.filter((step) => step.status === 'passed').length;
  lines.push('## Tier kapasitas', '');
  lines.push(...header(['Tier', 'Status', 'Langkah passed', 'Run attempt', 'Environment']));
  lines.push(row([CAPACITY_TIER_NAME, tier.status, `${passedSteps} dari ${tier.steps.length}`, tier.runAttempt ?? '-', environmentText(tier.environment)]));
  lines.push('');
  if (tier.steps.length > 0) {
    lines.push(`### Langkah tier ${CAPACITY_TIER_NAME}`, '');
    lines.push(...header(['Langkah', 'Status', 'Durasi', 'Alasan']));
    for (const step of tier.steps) {
      const reasons = step.reasons.map((reason) => (reason.path === null ? reason.code : `${reason.code} ${reason.path}`));
      lines.push(row([step.script, step.status, `${(step.durationMs / 1000).toFixed(1)} detik`, reasons.join(', ') || '-']));
    }
    lines.push('');
  }
  lines.push('### Checksum input', '');
  lines.push(...capacityChecksums(tier.inputs));
  lines.push('### Checksum output', '');
  lines.push(...capacityChecksums(tier.outputs));

  lines.push('## Hasil per skenario', '');
  const counts = STATUS_ORDER.map((status) => `${report.scenarios.filter((scenario) => scenario.status === status).length} ${status}`);
  lines.push(`${report.scenarios.length} skenario tier kapasitas: ${counts.join(', ')}.`, '');
  lines.push(...header(['ID', 'Kriteria dan rujukan specs', 'Test dan profil', 'Wajib untuk release', 'Status', 'Hasil aktual dan tautan bukti']));
  for (const scenario of report.scenarios) {
    lines.push(
      row([
        scenario.id,
        `${scenario.criteria.join(', ')}; ${scenario.source}`,
        `${scenario.checks.map(describeCheck).join('; ')}; ${profileSuffix(scenario.checks)}`,
        scenario.critical ? 'ya, alur kritis' : 'ya',
        scenario.status,
        scenario.checks.map(describeOutcome).join('; '),
      ]),
    );
  }
  lines.push('');

  lines.push(...performanceSection(report.performance, 'tier kapasitas'));

  lines.push('## Kandidat release', '');
  lines.push(releaseLine(report.releaseCandidate), '');
  for (const reason of report.releaseCandidate.reasons) lines.push(`- \`${reason.code}\`: ${capacityReleaseText[reason.code]}.`);
  if (report.releaseCandidate.reasons.length > 0) lines.push('');
  lines.push('Tanda ini tidak mengubah status laporan kapasitas maupun exit code `test:report:capacity`.', '');

  lines.push('## Di luar cakupan', '');
  for (const item of report.outOfScope) lines.push(outOfScopeLine(item, true));
  lines.push('');
  return lines.join('\n');
}

/**
 * Builds the capacity report, writes `.local/feature-12/report.json` and `report.md`, appends the Markdown to the file
 * named by `GITHUB_STEP_SUMMARY` when that variable exists, and resolves to 0 only for `passed`; `failed` and
 * `incomplete` resolve to 1. The release candidate flag never changes the exit code.
 */
export async function runCapacityReport(
  root: string,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  env: Environment = process.env,
): Promise<number> {
  const log = (line: string) => write(consoleLine(line));
  const report = await buildCapacityReport(root, env);
  const markdown = renderCapacityMarkdown(report);
  await mkdir(join(root, CAPACITY_REPORT_DIR), { recursive: true });
  await writeFile(join(root, CAPACITY_REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(root, CAPACITY_REPORT_MD), markdown);
  const summary = env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') await appendFile(summary, `${markdown}\n`);

  const steps = report.tier.steps;
  log(`Laporan kapasitas ${report.status}`);
  log(`  tier ${CAPACITY_TIER_NAME}: ${report.tier.status} (${steps.filter((step) => step.status === 'passed').length} dari ${steps.length} langkah passed)`);
  const counts = STATUS_ORDER.map((status) => `${report.scenarios.filter((scenario) => scenario.status === status).length} ${status}`);
  log(`  skenario: ${report.scenarios.length} (${counts.join(', ')})`);
  if (report.binding.valid) log('  pengikatan sah');
  else {
    const problems = report.binding.problems.map((problem) => [problem.code, problem.tier, problem.path].filter(Boolean).join(' '));
    log(`  pengikatan tidak sah: ${problems.join(', ')}`);
  }
  const performance = report.performance.map((item) => `${item.profile} ${item.status}`).join(', ');
  log(`  performance k6: ${performance || 'tidak ada bukti'}`);
  log(`  ${releaseLine(report.releaseCandidate).replace(/`/g, '')}`);
  log(`Laporan: ${CAPACITY_REPORT_JSON} dan ${CAPACITY_REPORT_MD}`);
  return report.status === 'passed' ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// `bun run test:report:release` (spec 0012, AC-12, *Perhitungan laporan release* and *Status kesiapan release*): the
// release owner downloads the per push and capacity bundles of one commit into `.local/feature-11/evidence/` on a
// checkout of that commit, and this command builds the per push and the capacity report again, each bound to the CI
// identity its own manifests carry, then states `ready`, `blocked`, or `incomplete`. It writes only `release.json` and
// `release.md`, never the two reports, never reads `GITHUB_*` of its own process, and never grants a deployment.

export const RELEASE_READINESS_DIR = '.local/feature-13';
export const RELEASE_JSON = `${RELEASE_READINESS_DIR}/release.json`;
export const RELEASE_MD = `${RELEASE_READINESS_DIR}/release.md`;

export type ReleaseReadinessStatus = 'ready' | 'blocked' | 'incomplete';

/** The codes of class `blocked` (*Status kesiapan release*); every other code of the list is of class `incomplete`. */
export const RELEASE_BLOCKED_CODES: readonly ReleaseReadinessReasonCode[] = ['gate_failed', 'capacity_failed'];

/** The two fixed sentences of `release.md` (*Status kesiapan release*). */
export const RELEASE_NOT_PERMISSION =
  'Status `ready` berarti bukti wajib lengkap dan lulus untuk kandidat ini, dan tidak memberi izin deploy; keputusan deploy dicatat terpisah oleh pemilik release.';
export const RELEASE_IDENTITY_UNVERIFIED =
  'Identitas run dibaca dari manifest bundle yang ditulis run itu sendiri dan tidak diverifikasi ke GitHub, dan paket OS image tidak dipindai pemindai kerentanan.';

/** `.local/feature-13/release.json`: exactly these keys, in this order. `grantsDeployment` is always `false`. */
export type ReleaseReport = {
  schema: 1;
  generatedAt: string;
  candidate: { commit: string | null; sourceTree: string | null };
  perPush: { gate: GateStatus; releaseCandidate: ReleaseCandidate; ci: CiIdentity | null };
  capacity: { status: GateStatus; releaseCandidate: CapacityReleaseCandidate; ci: CiIdentity | null };
  deployment: DeploymentReport | null;
  status: ReleaseReadinessStatus;
  reasons: Array<{ code: ReleaseReadinessReasonCode }>;
  grantsDeployment: false;
};

/**
 * *Perhitungan laporan release* (2): `candidate.ci` of the first valid manifest that has a CI identity, in the order
 * given (`fast`, `real`, `security` for the per push report, the capacity manifest alone for the capacity report), with
 * `job` set to `null`, since each tier runs in its own job; `null` when no manifest has one.
 */
export function bundleCi(manifests: ReadonlyArray<TierManifest | null>): CiIdentity | null {
  for (const manifest of manifests) {
    const ci = manifest?.candidate.ci;
    if (ci === undefined || ci === null) continue;
    return { runId: ci.runId, runAttempt: ci.runAttempt, job: null, sha: ci.sha, ref: ci.ref, event: ci.event };
  }
  return null;
}

/**
 * *Status kesiapan release*: every code that applies, in the fixed order of `REASON_CODES.releaseReadiness`, and the
 * status they give: `blocked` with a code of class `blocked`, `incomplete` with codes of class `incomplete` only, and
 * `ready` without a code. `manifests` are the valid manifests of the four bundles (`null` for a bundle without one).
 * An image label of `null`, or a checkout without commit or source tree, never matches (decision 55 of the rationale).
 */
export function releaseReadiness(input: {
  gate: GateStatus;
  gateCandidate: boolean;
  capacity: GateStatus;
  capacityCandidate: boolean;
  checkout: { commit: string | null; sourceTree: string | null };
  manifests: ReadonlyArray<TierManifest | null>;
  deployment: DeploymentReport | null;
}): { status: ReleaseReadinessStatus; reasons: Array<{ code: ReleaseReadinessReasonCode }> } {
  const { commit, sourceTree: tree } = input.checkout;
  const applies: Record<ReleaseReadinessReasonCode, boolean> = {
    gate_failed: input.gate === 'failed',
    capacity_failed: input.capacity === 'failed',
    gate_incomplete: input.gate === 'incomplete',
    capacity_incomplete: input.capacity === 'incomplete',
    gate_not_candidate: !input.gateCandidate,
    capacity_not_candidate: !input.capacityCandidate,
    candidate_differs:
      commit === null ||
      tree === null ||
      input.manifests.some((manifest) => manifest !== null && (manifest.candidate.commit !== commit || manifest.candidate.sourceTree !== tree)),
    image_differs:
      input.deployment === null ||
      commit === null ||
      tree === null ||
      input.deployment.images.some((image) => image.revision !== commit || image.sourceTree !== tree),
  };
  const reasons = REASON_CODES.releaseReadiness.filter((code) => applies[code]).map((code) => ({ code }));
  const status: ReleaseReadinessStatus = reasons.some((reason) => RELEASE_BLOCKED_CODES.includes(reason.code))
    ? 'blocked'
    : reasons.length > 0
      ? 'incomplete'
      : 'ready';
  return { status, reasons };
}

/**
 * *Perhitungan laporan release*: reads the four manifests, takes the CI identity of each report from its own bundles
 * with `bundleCi`, builds the per push report and the capacity report with it as `reportCi`, and states the release
 * status against the commit and the source tree of the checkout. Nothing is written here.
 */
export async function buildReleaseReport(root: string, env: Environment = process.env): Promise<ReleaseReport> {
  const perPushManifests: Array<TierManifest | null> = [];
  for (const name of TIER_NAMES) perPushManifests.push((await readManifest(root, name)).manifest);
  const capacityManifest = (await readManifest(root, CAPACITY_TIER_NAME)).manifest;
  const perPushCi = bundleCi(perPushManifests);
  const capacityCi = bundleCi([capacityManifest]);

  const perPush = await buildReport(root, env, perPushCi);
  const capacity = await buildCapacityReport(root, env, capacityCi);
  const candidate = { commit: perPush.candidate.commit, sourceTree: perPush.candidate.sourceTree };
  const { status, reasons } = releaseReadiness({
    gate: perPush.gate,
    gateCandidate: perPush.releaseCandidate.value,
    capacity: capacity.status,
    capacityCandidate: capacity.releaseCandidate.value,
    checkout: candidate,
    manifests: [...perPushManifests, capacityManifest],
    deployment: perPush.deployment,
  });
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    candidate,
    perPush: { gate: perPush.gate, releaseCandidate: perPush.releaseCandidate, ci: perPushCi },
    capacity: { status: capacity.status, releaseCandidate: capacity.releaseCandidate, ci: capacityCi },
    deployment: perPush.deployment,
    status,
    reasons,
    grantsDeployment: false,
  };
}

const releaseReadinessText: Record<ReleaseReadinessReasonCode, string> = {
  gate_failed: 'gate per push berstatus failed',
  capacity_failed: 'laporan kapasitas berstatus failed',
  gate_incomplete: 'gate per push berstatus incomplete',
  capacity_incomplete: 'laporan kapasitas berstatus incomplete',
  gate_not_candidate: 'laporan per push bukan kandidat release',
  capacity_not_candidate: 'laporan kapasitas bukan kandidat release',
  candidate_differs: 'commit atau pohon sumber checkout tidak ada, atau salah satu manifest bundle berasal dari commit atau pohon sumber lain',
  image_differs: 'bukti deployment tidak tersedia, atau salah satu image tidak berlabel commit dan pohon sumber checkout',
};

function readinessClass(code: ReleaseReadinessReasonCode): 'blocked' | 'incomplete' {
  return RELEASE_BLOCKED_CODES.includes(code) ? 'blocked' : 'incomplete';
}

/** `release.md`, in Indonesian, derived only from the fields of `ReleaseReport`. */
export function renderReleaseMarkdown(report: ReleaseReport): string {
  const lines: string[] = ['# Status kesiapan release', ''];
  lines.push(
    'Status ini dihitung ulang oleh `bun run test:report:release` dari bundle `fast`, `real`, `security`, dan `capacity` di `.local/feature-11/evidence/` pada checkout commit kandidat. Laporan per push dan laporan kapasitas tidak ditulis ulang.',
    '',
  );

  lines.push('## Status', '');
  lines.push(`Status release: \`${report.status}\`.`, '');
  lines.push(RELEASE_NOT_PERMISSION, '');
  lines.push(RELEASE_IDENTITY_UNVERIFIED, '');

  lines.push('## Alasan', '');
  if (report.reasons.length === 0) lines.push('Tidak ada alasan.', '');
  else {
    for (const reason of report.reasons) lines.push(`- \`${reason.code}\` (${readinessClass(reason.code)}): ${releaseReadinessText[reason.code]}.`);
    lines.push('');
  }

  lines.push('## Kandidat', '');
  lines.push(...header(['Aspek', 'Nilai']));
  lines.push(row(['Commit checkout', report.candidate.commit ?? 'tidak ada']));
  lines.push(row(['Pohon sumber checkout', report.candidate.sourceTree ?? 'tidak ada']));
  lines.push(row(['Memberi izin deploy (grantsDeployment)', String(report.grantsDeployment)]));
  lines.push(row(['Dibuat', report.generatedAt]));
  lines.push('');

  lines.push('## Run per push', '');
  lines.push(...header(['Aspek', 'Nilai']));
  lines.push(row(['Status gate', report.perPush.gate]));
  lines.push(row(['Kandidat release', releaseLine(report.perPush.releaseCandidate).replace(/`/g, '')]));
  lines.push(row(['Identitas run dari manifest', ciText(report.perPush.ci)]));
  lines.push('');

  lines.push('## Run kapasitas', '');
  lines.push(...header(['Aspek', 'Nilai']));
  lines.push(row(['Status laporan kapasitas', report.capacity.status]));
  lines.push(row(['Kandidat release', releaseLine(report.capacity.releaseCandidate).replace(/`/g, '')]));
  lines.push(row(['Identitas run dari manifest', ciText(report.capacity.ci)]));
  lines.push('');

  lines.push('## Image', '');
  if (report.deployment === null) {
    lines.push(
      'Bukti deployment tidak tersedia di laporan per push, sehingga label image tidak dapat dibandingkan dengan checkout.',
      '',
    );
  } else {
    lines.push(...header(['Image', 'Tag', 'Image ID', 'Revision', 'Pohon sumber', 'Sama dengan checkout']));
    for (const image of report.deployment.images) {
      const same = image.revision !== null && image.revision === report.candidate.commit && image.sourceTree !== null && image.sourceTree === report.candidate.sourceTree;
      lines.push(row([image.name, image.tag, image.imageId ?? '-', image.revision ?? '-', image.sourceTree ?? '-', same ? 'ya' : 'tidak']));
    }
    lines.push('');
  }
  lines.push(DEPLOYMENT_LOCAL_ONLY, '');
  return lines.join('\n');
}

/**
 * Builds the release status, writes only `.local/feature-13/release.json` and `release.md`, and resolves to 0 only for
 * `ready`; `blocked` and `incomplete` resolve to 1. It never writes the per push or the capacity report and never
 * appends a job summary.
 */
export async function runReleaseReport(
  root: string,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  env: Environment = process.env,
): Promise<number> {
  const log = (line: string) => write(consoleLine(line));
  const report = await buildReleaseReport(root, env);
  const markdown = renderReleaseMarkdown(report);
  await mkdir(join(root, RELEASE_READINESS_DIR), { recursive: true });
  await writeFile(join(root, RELEASE_JSON), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(root, RELEASE_MD), markdown);

  log(`Status release ${report.status}`);
  log(`  gate per push: ${report.perPush.gate}, ${releaseLine(report.perPush.releaseCandidate).replace(/`/g, '')}, ${ciText(report.perPush.ci)}`);
  log(`  laporan kapasitas: ${report.capacity.status}, ${releaseLine(report.capacity.releaseCandidate).replace(/`/g, '')}, ${ciText(report.capacity.ci)}`);
  log(`  alasan: ${report.reasons.map((reason) => reason.code).join(', ') || 'tidak ada'}`);
  log('  grantsDeployment: false (status ini bukan izin deploy)');
  log(`Laporan: ${RELEASE_JSON} dan ${RELEASE_MD}`);
  return report.status === 'ready' ? 0 : 1;
}
