import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EVIDENCE_TEXT_LIMIT, JUnitError, junitCounts, parseJUnit, type JUnitRunner } from './junit.ts';
import { listeners, type Listener } from './ports.ts';
import { runProcessGroup, type ProcessGroupResult } from './process-group.ts';

// Tier runner of spec 0010 (AC-4, AC-7, AC-8): the exported tier table, the step environment allow list, the evidence
// each step declares, the fixed reason codes, the candidate identity and checksums, the check for sensitive values in
// text evidence, and the bundle with its manifest. Step output only goes to the console; the manifest holds structured
// fields only, never an environment value or step output.

export const TIER_NAMES = ['fast', 'real', 'security'] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** The root script of every tier (*Tabel tier*, column Perintah root). */
export const TIER_SCRIPTS: Readonly<Record<TierName, string>> = { fast: 'test:ci', real: 'test:ci:real', security: 'test:ci:security' };

export type EvidenceKind = 'junit' | 'screenshots' | 'image' | 'scan' | 'scanner';

export type EvidenceSpec = {
  /** Repository path; a folder ends with `/`. */
  path: string;
  kind: EvidenceKind;
  /** The runner that wrote a `junit` file, `null` for other kinds. */
  runner: JUnitRunner | null;
  required: boolean;
};

export type TierStep = { script: string; evidence: readonly EvidenceSpec[] };

export type Tier = {
  name: TierName;
  /** The root script that runs this tier, for example `test:ci`. */
  script: string;
  steps: readonly TierStep[];
  stepTimeoutMs: number;
  stopGraceMs: number;
};

const junit = (path: string, runner: JUnitRunner): EvidenceSpec => ({ path, kind: 'junit', runner, required: true });
const json = (path: string, kind: 'image' | 'scan' | 'scanner'): EvidenceSpec => ({ path, kind, runner: null, required: true });
const screenshots = (path: string): EvidenceSpec => ({ path, kind: 'screenshots', runner: null, required: false });
const plain = (script: string): TierStep => ({ script, evidence: [] });

/**
 * *Tabel tier*: steps in the order they run, with the evidence of *Bukti per langkah*. The `real` tier runs through
 * `test:ci:real` in the workflow job `real`; its first step builds the pinned PostgreSQL 18 image that the later steps
 * start. The `security` tier runs the three pinned scanners through `check:security` in the workflow job `security`;
 * its 90 second grace holds the removal of the scanner containers. The gate report expects all of `TIER_NAMES`,
 * so a tier without a bundle reads as not run.
 */
export const TIERS: Readonly<Partial<Record<TierName, Tier>>> = {
  fast: {
    name: 'fast',
    script: TIER_SCRIPTS.fast,
    stepTimeoutMs: 600_000,
    stopGraceMs: 10_000,
    steps: [
      plain('check:dependencies'),
      plain('test:scenarios'),
      plain('check:test-discovery'),
      plain('check:workflow'),
      plain('api:check'),
      plain('build:frontend'),
      plain('check:frontend:bundle'),
      plain('typecheck:backend'),
      plain('typecheck:contract'),
      plain('typecheck:e2e'),
      plain('typecheck:tooling'),
      plain('build:backend'),
      { script: 'test:frontend', evidence: [junit('.local/feature-4/frontend.xml', 'vitest')] },
      { script: 'test:integration', evidence: [junit('.local/feature-4/server.xml', 'bun:test')] },
      { script: 'test:tooling', evidence: [junit('.local/feature-4/tooling.xml', 'bun:test')] },
      { script: 'test:gate', evidence: [junit('.local/feature-11/gate.xml', 'bun:test')] },
      {
        script: 'test:e2e',
        evidence: [junit('.local/feature-4/playwright.xml', 'playwright'), screenshots('test-results/')],
      },
    ],
  },
  real: {
    name: 'real',
    script: TIER_SCRIPTS.real,
    stepTimeoutMs: 1_500_000,
    stopGraceMs: 180_000,
    steps: [
      {
        script: 'test:infrastructure',
        evidence: [junit('.local/feature-3/infrastructure.xml', 'bun:test'), json('.local/feature-3/image.json', 'image')],
      },
      {
        script: 'test:database:real',
        evidence: [junit('.local/feature-5/database.xml', 'bun:test'), json('.local/feature-5/artifact-scan.json', 'scan')],
      },
      { script: 'test:database:migration', evidence: [junit('.local/feature-6/migration.xml', 'bun:test')] },
      {
        script: 'test:tooling:real',
        evidence: [
          junit('.local/feature-2/playwright-real.xml', 'playwright'),
          json('.local/feature-2/artifact-scan.json', 'scan'),
          screenshots('.local/feature-2/test-results/'),
        ],
      },
      {
        script: 'test:readiness:real',
        evidence: [
          junit('.local/feature-10/playwright-real.xml', 'playwright'),
          json('.local/feature-10/artifact-scan.json', 'scan'),
          screenshots('.local/feature-10/test-results/'),
        ],
      },
    ],
  },
  security: {
    name: 'security',
    script: TIER_SCRIPTS.security,
    stepTimeoutMs: 600_000,
    stopGraceMs: 90_000,
    steps: [{ script: 'check:security', evidence: [json('.local/feature-11/security.json', 'scanner')] }],
  },
};

/** Every script that is a step of a tier, mapped to its tier. */
export function tierSteps(tiers: Readonly<Partial<Record<TierName, Tier>>> = TIERS): Map<string, TierName> {
  const steps = new Map<string, TierName>();
  for (const tier of Object.values(tiers)) {
    if (tier === undefined) continue;
    for (const step of tier.steps) steps.set(step.script, tier.name);
  }
  return steps;
}

export function tierByName(name: string): Tier | undefined {
  return (TIER_NAMES as readonly string[]).includes(name) ? TIERS[name as TierName] : undefined;
}

/**
 * Ports whose listeners the gate records in `leftoverPorts` after it stopped a step of the tier on timeout or signal
 * (*Tabel tier* and the *Port tersisa* row of Value sourcing): the backend 8888 and the frontend 8889 that the real
 * suites start, and that `test:e2e` of the fast tier starts through the Playwright `webServer`, whose processes lead
 * their own process groups outside the step group. The security tier starts no server.
 */
export const LEFTOVER_PORTS: Readonly<Partial<Record<TierName, readonly number[]>>> = { fast: [8888, 8889], real: [8888, 8889] };

// ---------------------------------------------------------------------------------------------------------------
// *Environment langkah* and *Nilai sensitif*.

export const STEP_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'SystemRoot',
  'CI',
  'PLAYWRIGHT_BROWSERS_PATH',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

/** The complete step environment: only allow listed variables the gate process has. */
export function stepEnvironment(source: Environment = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of STEP_ENV_KEYS) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const sensitiveParts = ['TOKEN', 'SECRET', 'PASSWORD', 'PASS', 'KEY', 'DSN', 'CREDENTIAL', 'DATABASE_URL'];

export type SensitiveValue = { name: string; value: string };

/** Gate environment values that must never reach evidence: a sensitive name and at least 8 characters. */
export function sensitiveValues(source: Environment = process.env): SensitiveValue[] {
  const found: SensitiveValue[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value.length < 8) continue;
    const upper = name.toUpperCase();
    if (upper.startsWith('FOUNDATION_') || sensitiveParts.some((part) => upper.includes(part))) found.push({ name, value });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// *Kode alasan*: a fixed vocabulary; free text only comes from runner skip reasons.

export const REASON_CODES = {
  step: [
    'exit_code',
    'timeout',
    'signal',
    'evidence_missing',
    'evidence_invalid',
    'junit_failures',
    'testcase_skipped',
    'artifact_scan_findings',
    'sensitive_value',
    'previous_step',
  ],
  check: ['tier_not_run', 'previous_step', 'no_matching_testcase', 'runner_skip'],
  binding: [
    'manifest_missing',
    'manifest_invalid',
    'no_commit',
    'commit_differs',
    'source_tree_differs',
    'source_tree_changed',
    'ci_identity_differs',
    'ci_attempt_differs',
    'ci_mixed',
    'evidence_hash_differs',
  ],
  discovery: ['unowned_file', 'two_runners', 'list_failed', 'list_differs', 'junit_foreign_file', 'junit_missing_file'],
  scanner: [
    'image_pull_failed',
    'timeout',
    'signal',
    'invalid_output',
    'shallow_checkout',
    'scanner_config_in_repo',
    'severity_unknown',
    'exception_expired',
    'exception_too_long',
    'pin_invalid',
    'bun_version_mismatch',
  ],
  /** Scope *Kandidat release*: in the fixed order of the *Kandidat release* row. */
  release: ['gate_not_passed', 'not_clean', 'not_ci', 'event_not_push', 'ref_not_main'],
} as const;

export type StepReasonCode = (typeof REASON_CODES.step)[number];
export type CheckReasonCode = (typeof REASON_CODES.check)[number];
export type BindingReasonCode = (typeof REASON_CODES.binding)[number];
export type DiscoveryReasonCode = (typeof REASON_CODES.discovery)[number];
export type ReleaseReasonCode = (typeof REASON_CODES.release)[number];

/** Every reason in a manifest: a code plus a repository path or `null`. */
export type Reason<Code extends string> = { code: Code; path: string | null };

// ---------------------------------------------------------------------------------------------------------------
// Manifest shape (*Data model sketch*, `.local/feature-11/evidence/<tier>/manifest.json`).

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'not_run';
export type TierStatus = 'passed' | 'failed';
export type HandledSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';

export type EvidenceFile = { path: string; sha256: string };

export type EvidenceRecord = {
  path: string;
  kind: EvidenceKind;
  runner?: JUnitRunner;
  required: boolean;
  present: boolean;
  /** SHA 256 of the copy in the bundle; `null` when nothing was copied. Absent for `screenshots`. */
  sha256?: string | null;
  tests?: number | null;
  failures?: number | null;
  errors?: number | null;
  skipped?: number | null;
  /** Regular files of a `screenshots` folder, sorted by path. */
  files?: EvidenceFile[];
};

export type StepRecord = {
  script: string;
  status: StepStatus;
  reasons: Reason<StepReasonCode>[];
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  signal: HandledSignal | null;
  /** PIDs still listening on the `LEFTOVER_PORTS` of the tier after the step was stopped, sorted; empty otherwise. */
  leftoverPorts: number[];
  evidence: EvidenceRecord[];
};

export type CiIdentity = {
  runId: string | null;
  runAttempt: string | null;
  job: string | null;
  sha: string | null;
  ref: string | null;
  event: string | null;
};

export type Candidate = {
  commit: string | null;
  clean: boolean;
  sourceTree: string | null;
  sourceTreeAfter: string | null;
  ci: CiIdentity | null;
};

export type TierEnvironment = { os: string; arch: string; bun: string; node: string | null };

export type TierManifest = {
  schema: 1;
  tier: TierName;
  candidate: Candidate;
  environment: TierEnvironment;
  inputs: Record<string, string | null>;
  outputs: Record<string, string>;
  steps: StepRecord[];
  status: TierStatus;
  startedAt: string;
  finishedAt: string;
};

/** Folder that holds one bundle per tier, relative to the repository root. */
export const EVIDENCE_ROOT = '.local/feature-11/evidence';

export function bundlePath(tier: TierName): string {
  return `${EVIDENCE_ROOT}/${tier}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Candidate identity and checksums (*Value sourcing*).

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** SHA 256 of a regular file, or `absent` when there is none. */
export async function fileChecksum(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return 'absent';
    return sha256(await readFile(path));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return 'absent';
    throw error;
  }
}

/** Runs one short read only command with the step environment; `null` when it cannot run or exits non zero. */
async function capture(root: string, argv: string[], timeoutMs: number, source: Environment): Promise<string | null> {
  try {
    const child = Bun.spawn(argv, {
      cwd: root,
      env: stepEnvironment(source),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: timeoutMs,
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? output : null;
  } catch {
    return null;
  }
}

const gitTimeoutMs = 60_000;

/** `git rev-parse HEAD`, or `null` without a repository. */
export async function gitCommit(root: string, source: Environment = process.env): Promise<string | null> {
  const output = await capture(root, ['git', 'rev-parse', 'HEAD'], gitTimeoutMs, source);
  const commit = output?.trim();
  return commit !== undefined && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

/** True only when `git status --porcelain` runs and prints nothing. */
export async function gitClean(root: string, source: Environment = process.env): Promise<boolean> {
  const output = await capture(root, ['git', 'status', '--porcelain'], gitTimeoutMs, source);
  return output === '';
}

/** One tree line: `<sha256 of content>  <path>`, a symlink as its target without following it, or `deleted  <path>`. */
async function treeLine(root: string, path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(join(root, path));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return `deleted  ${path}`;
    throw error;
  }
  if (info.isSymbolicLink()) return `${sha256(await readlink(join(root, path)))}  ${path}`;
  if (info.isFile()) return `${sha256(await readFile(join(root, path)))}  ${path}`;
  return undefined;
}

function treeHash(lines: string[]): string {
  return sha256(
    lines
      .sort()
      .map((line) => `${line}\n`)
      .join(''),
  );
}

/**
 * Source tree hash: `git ls-files --cached --others --exclude-standard -z` (limited to `prefix` when given), then SHA 256
 * of the sorted lines. `null` without a repository.
 */
export async function sourceTree(root: string, prefix?: string, source: Environment = process.env): Promise<string | null> {
  const args = ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  if (prefix !== undefined) args.push('--', prefix);
  const output = await capture(root, args, gitTimeoutMs, source);
  if (output === null) return null;
  const paths = [...new Set(output.split('\0').filter((path) => path !== ''))];
  const lines: string[] = [];
  for (const path of paths) {
    const line = await treeLine(root, path);
    if (line !== undefined) lines.push(line);
  }
  return treeHash(lines);
}

/** Regular files and symlinks under `dir`, as repository paths, without following symlinks. */
async function listFiles(root: string, dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string) => {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
    }
  };
  await visit(dir.replace(/\/+$/, ''));
  return found.sort();
}

/** Tree hash of a folder that git ignores (a build output), or `absent` when the folder does not exist. */
export async function directoryTree(root: string, dir: string): Promise<string> {
  try {
    if (!(await lstat(join(root, dir))).isDirectory()) return 'absent';
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return 'absent';
    throw error;
  }
  const lines: string[] = [];
  for (const path of await listFiles(root, dir)) {
    const line = await treeLine(root, path);
    if (line !== undefined) lines.push(line);
  }
  return treeHash(lines);
}

/** The CI run identity from `GITHUB_*`, or `null` outside GitHub Actions. */
export function ciIdentity(source: Environment = process.env): CiIdentity | null {
  if (source['GITHUB_RUN_ID'] === undefined) return null;
  return {
    runId: source['GITHUB_RUN_ID'] ?? null,
    runAttempt: source['GITHUB_RUN_ATTEMPT'] ?? null,
    job: source['GITHUB_JOB'] ?? null,
    sha: source['GITHUB_SHA'] ?? null,
    ref: source['GITHUB_REF'] ?? null,
    event: source['GITHUB_EVENT_NAME'] ?? null,
  };
}

async function tierEnvironment(root: string, source: Environment): Promise<TierEnvironment> {
  const node = (await capture(root, ['node', '-p', 'process.versions.node'], 5_000, source))?.trim();
  return { os: process.platform, arch: process.arch, bun: Bun.version, node: node === undefined || node === '' ? null : node };
}

export const INPUT_FILES = [
  'package.json',
  'bun.lock',
  'openapi.json',
  'infrastructure/postgres/pins.json',
  'tests/security/scanners.json',
  'tests/security/exceptions.json',
  'tests/security/gitleaks.toml',
  'tests/security/actionlint.yaml',
  '.github/workflows/application.yml',
] as const;
export const INPUT_TREES = ['apps/frontend/sdk/', 'tests/scenarios/'] as const;
export const OUTPUT_TREES = ['apps/frontend/dist/frontend/'] as const;
export const OUTPUT_FILES = ['dist/backend/index.js'] as const;

async function tierInputs(root: string, source: Environment): Promise<Record<string, string | null>> {
  const inputs: Record<string, string | null> = {};
  for (const path of INPUT_FILES) inputs[path] = await fileChecksum(join(root, path));
  for (const path of INPUT_TREES) inputs[path] = await sourceTree(root, path, source);
  return inputs;
}

async function tierOutputs(root: string): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  for (const path of OUTPUT_TREES) outputs[path] = await directoryTree(root, path);
  for (const path of OUTPUT_FILES) outputs[path] = await fileChecksum(join(root, path));
  return outputs;
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence (*Bukti per langkah*): read once, checked, hashed, and copied byte for byte into the bundle.

type Copy = { path: string; data: Uint8Array };
type Collected = { record: EvidenceRecord; reasons: Reason<StepReasonCode>[]; skipped: number; copies: Copy[] };
type Read = { state: 'absent' } | { state: 'not_regular' } | { state: 'too_large' } | { state: 'read'; data: Uint8Array };

function isText(path: string): boolean {
  return /\.(xml|json)$/i.test(path);
}

async function readEvidence(path: string, text: boolean): Promise<Read> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return { state: 'absent' };
    throw error;
  }
  if (!info.isFile()) return { state: 'not_regular' };
  if (text && info.size > EVIDENCE_TEXT_LIMIT) return { state: 'too_large' };
  return { state: 'read', data: await readFile(path) };
}

/**
 * The forms one sensitive value takes in evidence: as is, escaped for XML text and attributes (named and numeric
 * references), escaped inside a JSON string, and percent encoded. A value with `&`, `<`, `>`, a quote, a backslash, or
 * a control character never appears as is in JUnit or JSON, so the plain form alone would let it through.
 */
export function sensitiveForms(value: string): string[] {
  const control = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, (char) => `&#${char.charCodeAt(0)};`);
  const text = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    ...new Set([
      value,
      text,
      control(text.replace(/"/g, '&quot;').replace(/'/g, '&apos;')),
      control(text.replace(/"/g, '&#34;').replace(/'/g, '&#39;')),
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
    ]),
  ];
}

/** The name of the first sensitive variable whose value occurs in `data`, in any form of `sensitiveForms`. */
function sensitiveName(data: Uint8Array, sensitive: readonly SensitiveValue[]): string | undefined {
  if (sensitive.length === 0) return undefined;
  const text = Buffer.from(data).toString('utf8');
  return sensitive.find(({ value }) => sensitiveForms(value).some((form) => text.includes(form)))?.name;
}

function jsonObject(data: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function collectFile(
  root: string,
  spec: EvidenceSpec,
  sensitive: readonly SensitiveValue[],
  log: (line: string) => void,
): Promise<Collected> {
  const record: EvidenceRecord = { path: spec.path, kind: spec.kind, required: spec.required, present: false, sha256: null };
  if (spec.kind === 'junit' && spec.runner !== null) {
    record.runner = spec.runner;
    Object.assign(record, { tests: null, failures: null, errors: null, skipped: null });
  }
  const reasons: Reason<StepReasonCode>[] = [];
  const collected: Collected = { record, reasons, skipped: 0, copies: [] };
  const read = await readEvidence(join(root, spec.path), isText(spec.path));
  if (read.state === 'absent') {
    if (spec.required) reasons.push({ code: 'evidence_missing', path: spec.path });
    return collected;
  }
  record.present = true;
  if (read.state !== 'read') {
    reasons.push({ code: 'evidence_invalid', path: spec.path });
    return collected;
  }
  const name = sensitiveName(read.data, sensitive);
  if (name !== undefined) {
    // The file stays out of the bundle; only the variable name and the path are printed.
    log(`${spec.path} memuat nilai variable sensitif ${name}; file tidak disalin ke bundle`);
    reasons.push({ code: 'sensitive_value', path: spec.path });
    return collected;
  }
  record.sha256 = sha256(read.data);
  collected.copies.push({ path: spec.path, data: read.data });

  if (spec.kind === 'junit') {
    try {
      const counts = junitCounts(parseJUnit(Buffer.from(read.data).toString('utf8')));
      Object.assign(record, counts);
      if (counts.failures + counts.errors > 0) reasons.push({ code: 'junit_failures', path: spec.path });
      collected.skipped = counts.skipped;
    } catch (error) {
      if (!(error instanceof JUnitError)) throw error;
      reasons.push({ code: 'evidence_invalid', path: spec.path });
    }
  } else {
    const object = jsonObject(read.data);
    if (object === undefined) reasons.push({ code: 'evidence_invalid', path: spec.path });
    else if (spec.kind === 'scan') {
      const findings = object['findings'];
      if (!Array.isArray(findings) || findings.length !== 0) reasons.push({ code: 'artifact_scan_findings', path: spec.path });
    }
  }
  return collected;
}

async function collectFolder(
  root: string,
  spec: EvidenceSpec,
  sensitive: readonly SensitiveValue[],
  log: (line: string) => void,
): Promise<Collected> {
  const dir = spec.path.replace(/\/+$/, '');
  const record: EvidenceRecord = { path: spec.path, kind: spec.kind, required: spec.required, present: false, files: [] };
  const reasons: Reason<StepReasonCode>[] = [];
  const collected: Collected = { record, reasons, skipped: 0, copies: [] };
  try {
    if (!(await lstat(join(root, dir))).isDirectory()) {
      record.present = true;
      reasons.push({ code: 'evidence_invalid', path: spec.path });
      return collected;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
    if (spec.required) reasons.push({ code: 'evidence_missing', path: spec.path });
    return collected;
  }
  record.present = true;
  const files: EvidenceFile[] = [];
  for (const path of await listFiles(root, dir)) {
    const read = await readEvidence(join(root, path), isText(path));
    if (read.state === 'absent' || read.state === 'not_regular') continue;
    if (read.state === 'too_large') {
      reasons.push({ code: 'evidence_invalid', path });
      continue;
    }
    // Every file of the folder, not only .xml and .json: Playwright also writes error-context.md and other text there.
    const name = sensitiveName(read.data, sensitive);
    if (name !== undefined) {
      log(`${path} memuat nilai variable sensitif ${name}; file tidak disalin ke bundle`);
      reasons.push({ code: 'sensitive_value', path });
      continue;
    }
    files.push({ path, sha256: sha256(read.data) });
    collected.copies.push({ path, data: read.data });
  }
  record.files = files;
  return collected;
}

function collectEvidence(
  root: string,
  spec: EvidenceSpec,
  sensitive: readonly SensitiveValue[],
  log: (line: string) => void,
): Promise<Collected> {
  return spec.kind === 'screenshots' ? collectFolder(root, spec, sensitive, log) : collectFile(root, spec, sensitive, log);
}

// ---------------------------------------------------------------------------------------------------------------
// Tier runner.

/**
 * SIGHUP too: the step group is detached from the terminal, so a closed terminal or a dropped SSH session reaches only
 * the gate, which then stops the step group the same way as for SIGINT and SIGTERM.
 */
const signalCodes: Record<HandledSignal, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export type RunTierOptions = {
  root: string;
  tier: Tier;
  /** Console line writer; stdout by default. */
  log?: (line: string) => void;
  /** The gate process environment; `process.env` by default. */
  env?: Environment;
  /** Ports read after a step was stopped; `LEFTOVER_PORTS` of the tier by default. Tests pass a port of their own. */
  leftoverPorts?: readonly number[];
};

type Context = {
  root: string;
  tier: Tier;
  log: (line: string) => void;
  env: Record<string, string>;
  /** The gate process environment, read only for `GITHUB_*` and for the allow list of git and node calls. */
  envSource: Environment;
  sensitive: SensitiveValue[];
  abort: AbortSignal;
  received: () => HandledSignal | undefined;
  /** Ports whose listeners are recorded after a stopped step. */
  ports: readonly number[];
  bundle: string;
};

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function notRun(step: TierStep, code: 'previous_step' | 'signal'): StepRecord {
  return {
    script: step.script,
    status: 'not_run',
    reasons: [{ code, path: null }],
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    signal: null,
    leftoverPorts: [],
    evidence: [],
  };
}

/**
 * The PIDs that still listen on `ports`, read with `listeners` of `scripts/lib/ports.ts`, unique and sorted. Each one
 * is printed with its port; a port that cannot be read is printed too and adds nothing.
 */
async function leftoverListeners(ports: readonly number[], log: (line: string) => void): Promise<number[]> {
  const pids = new Set<number>();
  for (const port of ports) {
    let found: Listener[];
    try {
      found = await listeners(port);
    } catch {
      log(`listener pada port ${port} tidak dapat diperiksa`);
      continue;
    }
    for (const listener of found) {
      pids.add(listener.pid);
      log(`listener tersisa pada port ${port}: PID ${listener.pid}`);
    }
  }
  return [...pids].sort((a, b) => a - b);
}

async function runStep(context: Context, step: TierStep): Promise<StepRecord> {
  const { root, tier, log } = context;
  const prefix = `gate ${tier.name}:`;
  for (const evidence of step.evidence) await rm(join(root, evidence.path), { recursive: true, force: true });

  log(`${prefix} ${step.script} mulai`);
  const started = performance.now();
  let result: ProcessGroupResult | undefined;
  try {
    result = await runProcessGroup([process.execPath, '--no-env-file', 'run', step.script], {
      cwd: root,
      env: context.env,
      timeoutMs: tier.stepTimeoutMs,
      graceMs: tier.stopGraceMs,
      output: 'inherit',
      signal: context.abort,
    });
  } catch {
    result = undefined;
  }
  const durationMs = Math.round(performance.now() - started);

  const reasons: Reason<StepReasonCode>[] = [];
  if (result?.aborted) reasons.push({ code: 'signal', path: null });
  else if (result?.timedOut) reasons.push({ code: 'timeout', path: null });
  else if (result === undefined || result.code !== 0) reasons.push({ code: 'exit_code', path: null });
  // A step the gate stopped (timeout, signal, or a group that survived the stop) may leave servers behind.
  const stopped = result === undefined || result.timedOut || result.aborted;
  const leftoverPorts = stopped ? await leftoverListeners(context.ports, (line) => log(`${prefix}   ${line}`)) : [];

  const evidence: EvidenceRecord[] = [];
  const skippedIn: string[] = [];
  for (const spec of step.evidence) {
    const collected = await collectEvidence(root, spec, context.sensitive, (line) => log(`${prefix}   ${line}`));
    evidence.push(collected.record);
    reasons.push(...collected.reasons);
    if (collected.skipped > 0) skippedIn.push(spec.path);
    for (const copy of collected.copies) {
      const target = join(context.bundle, copy.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, copy.data);
    }
  }
  const status: StepStatus = reasons.length > 0 ? 'failed' : skippedIn.length > 0 ? 'skipped' : 'passed';
  for (const path of skippedIn) reasons.push({ code: 'testcase_skipped', path });

  log(`${prefix} ${step.script} ${status} dalam ${seconds(durationMs)} detik`);
  for (const reason of reasons) log(`${prefix}   alasan ${reason.code}${reason.path === null ? '' : ` ${reason.path}`}`);
  return {
    script: step.script,
    status,
    reasons,
    exitCode: result?.code ?? null,
    durationMs,
    timedOut: result?.timedOut ?? false,
    signal: result?.aborted ? (context.received() ?? null) : null,
    leftoverPorts,
    evidence,
  };
}

async function removeStaleBundles(evidenceRoot: string, tier: TierName): Promise<void> {
  await rm(join(evidenceRoot, tier), { recursive: true, force: true });
  for (const entry of await readdir(evidenceRoot)) {
    if (entry.startsWith(`.${tier}-`)) await rm(join(evidenceRoot, entry), { recursive: true, force: true });
  }
}

async function execute(context: Omit<Context, 'bundle'>): Promise<number> {
  const { root, tier, log } = context;
  const startedAt = new Date().toISOString();
  const evidenceRoot = join(root, EVIDENCE_ROOT);
  await mkdir(evidenceRoot, { recursive: true });
  await removeStaleBundles(evidenceRoot, tier.name);
  // The bundle is written in a temporary sibling folder and renamed at the end, so a bundle without a manifest
  // never looks complete.
  const bundle = join(evidenceRoot, `.${tier.name}-${randomBytes(6).toString('hex')}`);
  await mkdir(bundle);
  try {
    const source = context.envSource;
    const [commit, cleanBefore, treeBefore, inputs, environment] = await Promise.all([
      gitCommit(root, source),
      gitClean(root, source),
      sourceTree(root, undefined, source),
      tierInputs(root, source),
      tierEnvironment(root, source),
    ]);

    const steps: StepRecord[] = [];
    let stop: 'previous_step' | 'signal' | undefined;
    for (const step of tier.steps) {
      if (context.received() !== undefined) stop = 'signal';
      if (stop !== undefined) {
        steps.push(notRun(step, stop));
        log(`gate ${tier.name}: ${step.script} not_run (${stop})`);
        continue;
      }
      const record = await runStep({ ...context, bundle }, step);
      steps.push(record);
      if (record.status !== 'passed') stop = context.received() !== undefined ? 'signal' : 'previous_step';
    }

    const [cleanAfter, treeAfter, outputs] = await Promise.all([
      gitClean(root, source),
      sourceTree(root, undefined, source),
      tierOutputs(root),
    ]);
    const status: TierStatus = steps.every((step) => step.status === 'passed') ? 'passed' : 'failed';
    const manifest: TierManifest = {
      schema: 1,
      tier: tier.name,
      candidate: {
        commit,
        clean: cleanBefore && cleanAfter,
        sourceTree: treeBefore,
        sourceTreeAfter: treeAfter,
        ci: ciIdentity(source),
      },
      environment,
      inputs,
      outputs,
      steps,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(bundle, join(evidenceRoot, tier.name));

    const passed = steps.filter((step) => step.status === 'passed').length;
    log(`gate ${tier.name}: tier ${status} (${passed} dari ${steps.length} langkah passed)`);
    log(`gate ${tier.name}: bundle bukti di ${bundlePath(tier.name)}/`);
    return status === 'passed' ? 0 : 1;
  } catch (error) {
    await rm(bundle, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Runs every step of `tier` in order, stops at the first step that does not pass, and writes the bundle with its
 * manifest. Resolves to 0 when the tier passed, 1 when it failed, 129 after SIGHUP, 130 after SIGINT, and 143 after
 * SIGTERM. While it runs, each of those signals stops the running step group; the manifest is still written.
 */
export async function runTier(options: RunTierOptions): Promise<number> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const source = options.env ?? process.env;
  const controller = new AbortController();
  let received: HandledSignal | undefined;
  const handlers = (Object.keys(signalCodes) as HandledSignal[]).map((signal) => {
    const handler = () => {
      received ??= signal;
      controller.abort();
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  let code: number;
  try {
    code = await execute({
      root: options.root,
      tier: options.tier,
      log,
      env: stepEnvironment(source),
      envSource: source,
      sensitive: sensitiveValues(source),
      abort: controller.signal,
      received: () => received,
      ports: options.leftoverPorts ?? LEFTOVER_PORTS[options.tier.name] ?? [],
    });
  } catch {
    process.stderr.write(`gate ${options.tier.name}: bundle bukti tidak dapat ditulis\n`);
    code = 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  return received !== undefined ? signalCodes[received] : code;
}
