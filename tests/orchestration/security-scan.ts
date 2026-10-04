import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stepEnvironment } from '../../scripts/lib/gate.ts';
import { runProcessGroup, type ProcessGroupResult } from '../../scripts/lib/process-group.ts';
import {
  bunAuditBlocked,
  evaluateActionlint,
  evaluateBunAudit,
  evaluateGitleaks,
  gitleaksBlocked,
  notRunEvaluation,
  readExceptions,
  readLockPackages,
  readPins,
  scanDate,
  SCANNER_CONFIG_PATHS,
  SCANNER_OUTPUT_LIMIT,
  scannerConfigsInRepo,
  scannerResult,
  SCANNERS_PATH,
  SECURITY_JSON,
  securityReport,
  summaryLines,
  withConfigInRepo,
  WORKFLOW_DIR,
  EXCEPTIONS_PATH,
  type ContainerScanner,
  type Evaluation,
  type GitleaksCoverage,
  type Pin,
  type ScannerReasonCode,
  type ScannerName,
  type ScannerResult,
  type ScanRun,
} from '../../scripts/lib/security-policy.ts';

// `bun run check:security` (spec 0010, AC-5 and AC-8, row *Pemanggilan pemindai*): runs gitleaks and actionlint as
// isolated Docker containers from the pins in tests/security/scanners.json, and `bun audit` from the running Bun in a
// temporary folder that holds only copies of package.json and bun.lock. The policy lives in
// scripts/lib/security-policy.ts; this file only starts processes, so every Docker call stays in tests/orchestration/
// and INFRA-001 keeps holding for scripts/. The container arguments come from the pure, exported `containerArguments`.
// SIGINT and SIGTERM (and SIGHUP, exit 129) stop the running process group, the scanner is recorded `not_run` with
// reason `signal` and the rest `not_run`, `docker rm -f` runs for every container name created, security.json is
// written, and the process exits 130 or 143.

/**
 * The empty tree of Git. gitleaks reads the history through `git log -p`, and git applies the `.gitattributes` of the
 * checkout to it: `-diff` (or `binary`) turns a blob into `Binary files differ`, which gitleaks skips. With
 * `GIT_ATTR_SOURCE` set to the empty tree, git reads attributes from that tree only, so no repository file can hide a
 * path from the scan (key invariant 5).
 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const PULL_TIMEOUT_MS = 300_000;
export const REMOVE_TIMEOUT_MS = 60_000;
export const SCANNER_TIMEOUT_MS = { gitleaks: 300_000, 'bun audit': 120_000, actionlint: 120_000 } as const;
const gitTimeoutMs = 60_000;

/**
 * The limits of one scan (*Pemanggilan pemindai*). `bun run check:security` always uses `SCAN_LIMITS`; only a caller of
 * `runSecurityScan` (the GATE-007 test) can pass others, so no environment variable or argument changes them.
 */
export type ScanLimits = {
  pullMs: number;
  removeMs: number;
  scannerMs: Readonly<Record<ScannerName, number>>;
  outputBytes: number;
};
export const SCAN_LIMITS: ScanLimits = {
  pullMs: PULL_TIMEOUT_MS,
  removeMs: REMOVE_TIMEOUT_MS,
  scannerMs: SCANNER_TIMEOUT_MS,
  outputBytes: SCANNER_OUTPUT_LIMIT,
};

/** The whole environment of `bun audit`: `PATH` and `HOME` of the scan process when it has them, nothing else. */
export function auditEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME']) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** `--user` of every scanner container: the host UID and GID, or 65534:65534 when the host user is root. */
export function containerUser(uid: number, gid: number): string {
  return uid === 0 ? '65534:65534' : `${uid}:${gid}`;
}

/** `foundation-security-<scanner>-` plus 12 hexadecimal characters from `crypto.getRandomValues`. */
export function containerName(scanner: ContainerScanner, random: Uint8Array = crypto.getRandomValues(new Uint8Array(6))): string {
  return `foundation-security-${scanner}-${Buffer.from(random).toString('hex')}`;
}

export type ContainerOptions = {
  scanner: ContainerScanner;
  name: string;
  /** The pinned image `<repo>:<tag>@sha256:<digest>`. */
  image: string;
  /** Absolute path of the repository on the host. */
  repo: string;
  uid: number;
  gid: number;
  /** Repository paths of the workflow files actionlint checks; unused for gitleaks. */
  workflows?: readonly string[];
};

/** The full `docker run` argument list of one scanner, in the fixed order of *Pemanggilan pemindai*. */
export function containerArguments(options: ContainerOptions): string[] {
  const base = [
    'docker', 'run', '--rm', '--name', options.name, '--pull', 'never', '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m', '--user', containerUser(options.uid, options.gid),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '1g', '--cpus', '2',
    '-e', 'HOME=/tmp',
  ];
  if (options.scanner === 'gitleaks') {
    return [
      ...base,
      '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/repo',
      '-e', `GIT_ATTR_SOURCE=${EMPTY_TREE}`,
      '-v', `${options.repo}:/repo:ro`, '-v', `${options.repo}/${SCANNER_CONFIG_PATHS.gitleaks}:/config/gitleaks.toml:ro`,
      '-w', '/repo', options.image,
      'git', '--config', '/config/gitleaks.toml', '--gitleaks-ignore-path', '/tmp', '--ignore-gitleaks-allow',
      '--log-opts=--all', '--redact', '--no-banner', '--exit-code', '2', '--report-format', 'json', '--report-path', '-', '/repo',
    ];
  }
  return [
    ...base,
    '-v', `${options.repo}:/repo:ro`, '-v', `${options.repo}/${SCANNER_CONFIG_PATHS.actionlint}:/config/actionlint.yaml:ro`,
    '-w', '/repo', options.image,
    '-config-file', '/config/actionlint.yaml', '-format', '{{json .}}', ...(options.workflows ?? []),
  ];
}

type Environment = Readonly<Record<string, string | undefined>>;
/** A scanner process that gave output, or the reason it did not. */
type Ran = { run: ScanRun } | { reason: ScannerReasonCode };
type HandledSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';
/** SIGHUP as well, so a closed terminal still removes the scanner container and writes security.json. */
const signalCodes: Record<HandledSignal, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export type SecurityScanOptions = {
  /** Repository root that is scanned and that holds tests/security/ and the result. */
  root: string;
  /** The process environment; `process.env` by default. Child processes only get the allow list of the step. */
  env?: Environment;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Host user for `--user`; `process.getuid()` and `process.getgid()` by default. */
  uid?: number;
  gid?: number;
  /** `SCAN_LIMITS` by default; the GATE-007 test passes short ones to drive the timeout and output paths. */
  limits?: ScanLimits;
  /** The Bun that runs `bun audit`; `process.execPath` by default. The GATE-007 test passes a recording stand in. */
  bun?: string;
};

type Context = {
  root: string;
  env: Record<string, string>;
  source: Environment;
  log: (line: string) => void;
  error: (line: string) => void;
  abort: AbortSignal;
  received: () => HandledSignal | undefined;
  uid: number;
  gid: number;
  limits: ScanLimits;
  bun: string;
  /** Container names created by this run that `docker rm -f` has not removed yet. */
  containers: Set<string>;
};

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** A short read only command with the step environment; `null` when it fails, times out, or is interrupted. */
async function capture(context: Context, argv: string[]): Promise<string | null> {
  try {
    const result = await runProcessGroup(argv, { cwd: context.root, env: context.env, timeoutMs: gitTimeoutMs, output: 'pipe', signal: context.abort });
    return result.code === 0 && !result.timedOut && !result.aborted ? result.stdout : null;
  } catch {
    return null;
  }
}

async function gitCoverage(context: Context): Promise<GitleaksCoverage> {
  const head = (await capture(context, ['git', 'rev-parse', 'HEAD']))?.trim();
  const count = (await capture(context, ['git', 'rev-list', '--all', '--count']))?.trim();
  const shallow = (await capture(context, ['git', 'rev-parse', '--is-shallow-repository']))?.trim();
  return {
    head: head !== undefined && /^[0-9a-f]{40}$/.test(head) ? head : null,
    commitsReachable: count !== undefined && /^\d+$/.test(count) ? Number(count) : null,
    shallow: shallow === 'true' ? true : shallow === 'false' ? false : null,
  };
}

/** `docker rm -f <name>` within 60 seconds, never interrupted; the name stays listed when removal fails. */
async function removeContainer(context: Context, name: string): Promise<void> {
  let result: ProcessGroupResult | undefined;
  try {
    result = await runProcessGroup(['docker', 'rm', '-f', name], { cwd: context.root, env: context.env, timeoutMs: context.limits.removeMs, output: 'pipe' });
  } catch {
    result = undefined;
  }
  if (result !== undefined && result.code === 0 && !result.timedOut) context.containers.delete(name);
  else context.error(`Container ${name} tidak dapat dihapus; hapus dengan tangan`);
}

/** Pulls the pinned image, then runs the scanner container; the container is removed on every path. */
async function runContainer(
  context: Context,
  scanner: ContainerScanner,
  pin: Pin,
  workflows: readonly string[],
): Promise<Ran> {
  if (context.received() !== undefined) return { reason: 'signal' };
  let pulled: ProcessGroupResult | undefined;
  try {
    pulled = await runProcessGroup(['docker', 'pull', pin.image], {
      cwd: context.root, env: context.env, timeoutMs: context.limits.pullMs, output: 'pipe', signal: context.abort,
    });
  } catch {
    pulled = undefined;
  }
  if (pulled?.aborted || context.received() !== undefined) return { reason: 'signal' };
  if (pulled === undefined || pulled.code !== 0 || pulled.timedOut) return { reason: 'image_pull_failed' };

  const name = containerName(scanner);
  context.containers.add(name);
  let result: ProcessGroupResult | undefined;
  try {
    result = await runProcessGroup(
      containerArguments({ scanner, name, image: pin.image, repo: context.root, uid: context.uid, gid: context.gid, workflows }),
      {
        cwd: context.root,
        env: context.env,
        timeoutMs: context.limits.scannerMs[scanner],
        output: 'pipe',
        signal: context.abort,
        outputLimitBytes: context.limits.outputBytes,
      },
    );
  } catch {
    result = undefined;
  } finally {
    // `--rm` does not help when the client was stopped: the container keeps running under the daemon.
    await removeContainer(context, name);
  }
  if (result?.aborted || context.received() !== undefined) return { reason: 'signal' };
  if (result?.timedOut) return { reason: 'timeout' };
  if (result === undefined || result.outputExceeded) return { reason: 'invalid_output' };
  return { run: { code: result.code, stdout: result.stdout } };
}

async function workflowFiles(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, WORKFLOW_DIR));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names.sort()) {
    if (/\.(yml|yaml)$/.test(name) && (await regularFile(join(root, WORKFLOW_DIR, name)))) files.push(`${WORKFLOW_DIR}/${name}`);
  }
  return files;
}

/** `bun audit --json` from the running Bun in a folder holding only copies of package.json and bun.lock. */
async function runBunAudit(context: Context): Promise<Ran> {
  if (context.received() !== undefined) return { reason: 'signal' };
  const folder = await mkdtemp(join(tmpdir(), 'foundation-security-audit-'));
  try {
    await copyFile(join(context.root, 'package.json'), join(folder, 'package.json'));
    await copyFile(join(context.root, 'bun.lock'), join(folder, 'bun.lock'));
    const result = await runProcessGroup([context.bun, 'audit', '--json'], {
      cwd: folder,
      env: auditEnvironment(context.source),
      timeoutMs: context.limits.scannerMs['bun audit'],
      output: 'pipe',
      signal: context.abort,
      outputLimitBytes: context.limits.outputBytes,
    });
    if (result.aborted || context.received() !== undefined) return { reason: 'signal' };
    if (result.timedOut) return { reason: 'timeout' };
    if (result.outputExceeded) return { reason: 'invalid_output' };
    return { run: { code: result.code, stdout: result.stdout } };
  } catch {
    return context.received() !== undefined ? { reason: 'signal' } : { reason: 'invalid_output' };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function scan(context: Context): Promise<number> {
  const { root, log, error } = context;
  const scannedAt = new Date().toISOString();
  const date = scanDate(scannedAt);
  let otherProblems = 0;

  const configs = await scannerConfigsInRepo(root);
  for (const config of configs) error(`check:security: ${config.path} ada di checkout (scanner_config_in_repo)`);
  const configFound = (scanner: ContainerScanner) => configs.some((config) => config.scanner === scanner);

  const pins = readPins(await readText(join(root, SCANNERS_PATH)));
  const { exceptions, problems } = readExceptions(await readText(join(root, EXCEPTIONS_PATH)));
  for (const problem of problems) error(`check:security: ${problem}`);
  if (problems.length > 0) otherProblems += 1;
  let engines: unknown;
  try {
    const manifest = JSON.parse((await readText(join(root, 'package.json'))) ?? 'null') as unknown;
    engines = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>)['engines'] : undefined;
  } catch {
    engines = undefined;
  }

  const workingTreeClean = (await capture(context, ['git', 'status', '--porcelain'])) === '';
  const notes: string[] = [];
  const results: ScannerResult[] = [];

  /** The pin of a container scanner, or the reason it cannot run. */
  const usable = async (scanner: ContainerScanner): Promise<Pin | 'pin_invalid'> => {
    const pin = pins[scanner];
    if (pin === null) {
      error(`check:security: pin ${scanner} di ${SCANNERS_PATH} tidak valid (pin_invalid)`);
      return 'pin_invalid';
    }
    if (!(await regularFile(join(root, SCANNER_CONFIG_PATHS[scanner])))) {
      error(`check:security: ${SCANNER_CONFIG_PATHS[scanner]} tidak ada atau bukan file reguler (pin_invalid)`);
      return 'pin_invalid';
    }
    return pin;
  };
  const identity = (scanner: ContainerScanner) => ({ name: scanner, version: pins[scanner]?.tag ?? null, image: pins[scanner]?.image ?? null });
  const outcome = (ran: Ran, evaluate: (run: ScanRun) => Evaluation) => ('run' in ran ? evaluate(ran.run) : notRunEvaluation(ran.reason));

  // (1) gitleaks over the whole history reachable from every ref of the checkout.
  const coverage = await gitCoverage(context);
  let gitleaks: Evaluation;
  const pin = await usable('gitleaks');
  const blocked = gitleaksBlocked(coverage);
  if (context.received() !== undefined) gitleaks = notRunEvaluation('signal');
  else if (pin === 'pin_invalid') gitleaks = notRunEvaluation('pin_invalid');
  else if (blocked !== null) gitleaks = notRunEvaluation(blocked);
  else gitleaks = outcome(await runContainer(context, 'gitleaks', pin, []), (run) => evaluateGitleaks(run, exceptions.secrets, date));
  gitleaks = withConfigInRepo(gitleaks, configFound('gitleaks'));
  notes.push(...gitleaks.notes);
  results.push(scannerResult(identity('gitleaks'), coverage, gitleaks));

  // (2) bun audit from the pinned Bun.
  const lock = readLockPackages(await readText(join(root, 'bun.lock')));
  let audit: Evaluation;
  const versionBlocked = bunAuditBlocked(engines, Bun.version);
  if (context.received() !== undefined) audit = notRunEvaluation('signal');
  else if (versionBlocked !== null) audit = notRunEvaluation(versionBlocked);
  else if (lock === null) audit = notRunEvaluation('invalid_output');
  else audit = outcome(await runBunAudit(context), (run) => evaluateBunAudit(run, lock.packages, exceptions.dependencies, date));
  notes.push(...audit.notes);
  results.push(scannerResult({ name: 'bun audit', version: Bun.version, image: null }, { packages: lock?.count ?? null }, audit));

  // (3) actionlint on every workflow file, named explicitly.
  const workflows = await workflowFiles(root);
  let lint: Evaluation;
  const lintPin = await usable('actionlint');
  if (context.received() !== undefined) lint = notRunEvaluation('signal');
  else if (lintPin === 'pin_invalid') lint = notRunEvaluation('pin_invalid');
  else if (workflows.length === 0) lint = evaluateActionlint({ code: 0, stdout: '[]' });
  else lint = outcome(await runContainer(context, 'actionlint', lintPin, workflows), evaluateActionlint);
  lint = withConfigInRepo(lint, configFound('actionlint'));
  results.push(scannerResult(identity('actionlint'), { files: workflows }, lint));

  // Every exit path: a container name this run created and could not remove fails the run.
  for (const name of [...context.containers]) await removeContainer(context, name);
  if (context.containers.size > 0) otherProblems += 1;

  const report = securityReport({ scannedAt, workingTreeClean, scanners: results, otherProblems });
  const target = join(root, SECURITY_JSON);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, target);
  for (const note of notes) log(`check:security: ${note}`);
  for (const line of summaryLines(report)) log(line);
  return report.status === 'passed' ? 0 : 1;
}

/**
 * Runs the three scanners on `root` and writes `.local/feature-11/security.json`. Resolves to 0 when every scanner
 * passed the policy, 1 otherwise, 129 after SIGHUP, 130 after SIGINT, and 143 after SIGTERM.
 */
export async function runSecurityScan(options: SecurityScanOptions): Promise<number> {
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
  const context: Context = {
    root: options.root,
    env: stepEnvironment(source),
    source,
    log: options.log ?? ((line) => process.stdout.write(`${line}\n`)),
    error: options.error ?? ((line) => process.stderr.write(`${line}\n`)),
    abort: controller.signal,
    received: () => received,
    uid: options.uid ?? process.getuid?.() ?? 65534,
    gid: options.gid ?? process.getgid?.() ?? 65534,
    limits: options.limits ?? SCAN_LIMITS,
    bun: options.bun ?? process.execPath,
    containers: new Set(),
  };
  let code: number;
  try {
    code = await scan(context);
  } catch {
    context.error(`check:security: pemindaian tidak dapat diselesaikan dan ${SECURITY_JSON} mungkin tidak ditulis`);
    code = 1;
  } finally {
    // Also after an unexpected error: no scanner container of this run is left behind.
    for (const name of [...context.containers]) await removeContainer(context, name);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  return received !== undefined ? signalCodes[received] : code;
}

if (import.meta.main) {
  process.exitCode = await runSecurityScan({ root: resolve(import.meta.dir, '../..') });
}
