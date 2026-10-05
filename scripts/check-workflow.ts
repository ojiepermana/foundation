import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bundlePath, CAPACITY_TIER, CAPACITY_TIER_NAME, TIER_NAMES, TIER_SCRIPTS, type TierName } from './lib/gate.ts';
import { CAPACITY_REPORT_JSON, CAPACITY_REPORT_MD, REPORT_JSON, REPORT_MD } from './lib/gate-report.ts';

// `bun run check:workflow` (spec 0010, AC-3, AC-8, AC-9): `bun --no-env-file scripts/check-workflow.ts` reads
// `.github/workflows/application.yml` with `Bun.YAML.parse` and applies the allow list of *Aturan check:workflow*: every
// key, value, command, action, input, permission, trigger, and path outside the list is a problem. The expected jobs
// come from the *Workflow* row; the Node and Bun versions come from `engines` in `package.json`. Spec 0011 adds the
// manual workflow `.github/workflows/capacity.yml` with its own allow list (*Workflow kapasitas*), whose actions carry
// the SHA pins of `application.yml`, and rejects every other workflow file in the folder.

export const WORKFLOW_DIR = '.github/workflows';
export const WORKFLOW_PATH = '.github/workflows/application.yml';
export const CAPACITY_WORKFLOW_PATH = '.github/workflows/capacity.yml';
/** The only workflow files the folder may hold. */
export const WORKFLOW_FILES: readonly string[] = [WORKFLOW_PATH, CAPACITY_WORKFLOW_PATH];
export const RUNS_ON = 'ubuntu-24.04';
export const REPORT_IF = '${{ !cancelled() }}';
export const UPLOAD_IF = 'always()';
export const SETUP_COMMANDS: readonly string[] = [
  'bun install --frozen-lockfile',
  'sudo apt-get update && sudo apt-get install -y lsof',
  'node node_modules/@playwright/test/cli.js install --with-deps chromium',
];

const CHECKOUT = 'actions/checkout';
const SETUP_NODE = 'actions/setup-node';
const SETUP_BUN = 'oven-sh/setup-bun';
const UPLOAD = 'actions/upload-artifact';
const DOWNLOAD = 'actions/download-artifact';
export const ALLOWED_ACTIONS: readonly string[] = [CHECKOUT, SETUP_NODE, SETUP_BUN, UPLOAD, DOWNLOAD];

const WORKFLOW_KEYS = new Set(['name', 'on', 'permissions', 'jobs']);
const EVENTS = ['push', 'pull_request'];
const JOB_KEYS = new Set(['runs-on', 'timeout-minutes', 'needs', 'if', 'steps']);
const STEP_KEYS = new Set(['name', 'uses', 'with', 'run', 'if', 'continue-on-error']);
const UPLOAD_INPUTS = ['name', 'path', 'include-hidden-files', 'retention-days', 'if-no-files-found', 'overwrite'];

export type Upload = { name: string; paths: readonly string[]; ifNoFilesFound: 'warn' | 'error' };
export type Download = { name: string; path: string };

/** One job of the *Workflow* row: the one root script it runs exactly once, and what it uploads and downloads. */
export type WorkflowJob = {
  name: string;
  script: string;
  timeoutMinutes: number;
  /** `fetch-depth: 0` on checkout is required, and rejected on every other job. */
  fullHistory: boolean;
  uploads: readonly Upload[];
  downloads: readonly Download[];
  /** Required `needs` (as a set), or `null` when the job may not carry `needs`. */
  needs: readonly string[] | null;
  /** Required job level `if`, or `null` when the job may not carry one. */
  if: string | null;
};

const TIER_JOBS: Readonly<Record<TierName, { job: string; artifact: string; timeoutMinutes: number; fullHistory: boolean }>> = {
  fast: { job: 'application', artifact: 'application-evidence', timeoutMinutes: 15, fullHistory: false },
  real: { job: 'real', artifact: 'real-evidence', timeoutMinutes: 45, fullHistory: false },
  security: { job: 'security', artifact: 'security-evidence', timeoutMinutes: 15, fullHistory: true },
};

/**
 * The expected jobs for `tiers` (every tier by default, so the four jobs `application`, `real`, `security`, and
 * `report` are all required): one job per tier, then `report`, which needs them and downloads their bundles.
 */
export function workflowJobs(tiers: readonly TierName[] = TIER_NAMES): WorkflowJob[] {
  const jobs: WorkflowJob[] = tiers.map((tier) => ({
    name: TIER_JOBS[tier].job,
    script: TIER_SCRIPTS[tier],
    timeoutMinutes: TIER_JOBS[tier].timeoutMinutes,
    fullHistory: TIER_JOBS[tier].fullHistory,
    uploads: [{ name: TIER_JOBS[tier].artifact, paths: [`${bundlePath(tier)}/`], ifNoFilesFound: 'warn' }],
    downloads: [],
    needs: null,
    if: null,
  }));
  jobs.push({
    name: 'report',
    script: 'test:report',
    timeoutMinutes: 10,
    fullHistory: false,
    uploads: [{ name: 'gate-report', paths: [REPORT_JSON, REPORT_MD], ifNoFilesFound: 'error' }],
    downloads: tiers.map((tier) => ({ name: TIER_JOBS[tier].artifact, path: `${bundlePath(tier)}/` })),
    needs: tiers.map((tier) => TIER_JOBS[tier].job),
    if: REPORT_IF,
  });
  return jobs;
}

export type WorkflowContext = {
  /** `scripts` of `package.json`. */
  scripts: Readonly<Record<string, unknown>>;
  /** `engines` of `package.json`. */
  engines: Readonly<Record<string, unknown>>;
  jobs: readonly WorkflowJob[];
};

export type WorkflowResult = { problems: string[]; jobs: Array<{ name: string; steps: number }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key or value in a message: plain when it looks like a name, otherwise quoted and cut. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  if (/^[\w@./:+-]{1,80}$/.test(text)) return text;
  return JSON.stringify(Array.from(text).slice(0, 60).join(''));
}

function pathLines(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((value, index) => value === sorted[index]);
}

type StepKind = 'run' | 'checkout' | 'setup-node' | 'setup-bun' | 'upload' | 'download' | 'other';

const kinds: Record<string, StepKind> = {
  [CHECKOUT]: 'checkout',
  [SETUP_NODE]: 'setup-node',
  [SETUP_BUN]: 'setup-bun',
  [UPLOAD]: 'upload',
  [DOWNLOAD]: 'download',
};

/** Applies every rule of *Aturan check:workflow* to the workflow `text` and returns every problem at once. */
export function checkWorkflow(text: string, context: WorkflowContext): WorkflowResult {
  const problems: string[] = [];
  const summary: WorkflowResult['jobs'] = [];
  if (text.includes('secrets.')) problems.push('workflow tidak boleh memuat teks secrets.');

  let workflow: unknown;
  try {
    workflow = Bun.YAML.parse(text);
  } catch {
    problems.push('workflow bukan YAML yang valid');
    return { problems, jobs: summary };
  }
  if (!isRecord(workflow)) {
    problems.push('workflow wajib berupa mapping');
    return { problems, jobs: summary };
  }
  for (const key of Object.keys(workflow)) if (!WORKFLOW_KEYS.has(key)) problems.push(`kunci workflow ${shown(key)} tidak diizinkan`);
  if (Object.hasOwn(workflow, 'name') && typeof workflow['name'] !== 'string') problems.push('name workflow wajib teks');

  const on = workflow['on'];
  if (!isRecord(on)) problems.push('on wajib mapping berisi push dan pull_request');
  else {
    for (const key of Object.keys(on)) if (!EVENTS.includes(key)) problems.push(`trigger ${shown(key)} tidak diizinkan`);
    for (const event of EVENTS) {
      if (!Object.hasOwn(on, event)) problems.push(`trigger ${event} wajib ada`);
      else if (!(on[event] === null || (isRecord(on[event]) && Object.keys(on[event]).length === 0))) {
        problems.push(`trigger ${event} tidak boleh memakai filter`);
      }
    }
  }

  const permissions = workflow['permissions'];
  if (!isRecord(permissions) || Object.keys(permissions).length !== 1 || permissions['contents'] !== 'read') {
    problems.push('permissions wajib tepat contents: read');
  }

  const jobs = workflow['jobs'];
  if (!isRecord(jobs)) {
    problems.push('jobs wajib berupa mapping');
    return { problems, jobs: summary };
  }
  const expected = new Map(context.jobs.map((job) => [job.name, job]));
  for (const name of Object.keys(jobs)) if (!expected.has(name)) problems.push(`job ${shown(name)} tidak diizinkan`);
  for (const job of context.jobs) if (!Object.hasOwn(jobs, job.name)) problems.push(`job ${job.name} wajib ada`);

  const runs: Array<{ job: string; script: string }> = [];
  for (const job of context.jobs) {
    if (!Object.hasOwn(jobs, job.name)) continue;
    const steps = checkJob(job, jobs[job.name], context, problems, runs);
    summary.push({ name: job.name, steps });
  }

  // Each job root script (a tier script or `test:report`) runs exactly once, in its own job only.
  const jobScripts = new Set([...Object.values(TIER_SCRIPTS), ...context.jobs.map((job) => job.script)]);
  for (const script of jobScripts) {
    const owner = context.jobs.find((job) => job.script === script);
    for (const run of runs.filter((item) => item.script === script && item.job !== owner?.name)) {
      problems.push(`job ${run.job}: script ${script} hanya boleh dijalankan job ${owner?.name ?? 'miliknya, yang belum ada'}`);
    }
    if (owner === undefined || !Object.hasOwn(jobs, owner.name)) continue;
    const count = runs.filter((item) => item.script === script && item.job === owner.name).length;
    if (count !== 1) problems.push(`job ${owner.name}: bun run ${script} wajib tepat satu kali, ditemukan ${count}`);
  }
  return { problems, jobs: summary };
}

function checkJob(
  job: WorkflowJob,
  raw: unknown,
  context: WorkflowContext,
  problems: string[],
  runs: Array<{ job: string; script: string }>,
): number {
  const where = `job ${job.name}`;
  if (!isRecord(raw)) {
    problems.push(`${where}: wajib berupa mapping`);
    return 0;
  }
  for (const key of Object.keys(raw)) if (!JOB_KEYS.has(key)) problems.push(`${where}: kunci ${shown(key)} tidak diizinkan`);
  if (raw['runs-on'] !== RUNS_ON) problems.push(`${where}: runs-on wajib ${RUNS_ON}`);
  if (raw['timeout-minutes'] !== job.timeoutMinutes) problems.push(`${where}: timeout-minutes wajib ${job.timeoutMinutes}`);

  if (job.needs === null) {
    if (Object.hasOwn(raw, 'needs')) problems.push(`${where}: needs hanya diizinkan pada job report`);
  } else {
    const needs = raw['needs'];
    const valid = Array.isArray(needs) && needs.every((item) => typeof item === 'string') && new Set(needs).size === needs.length;
    if (!valid || !sameList([...(needs as string[])].sort(), job.needs)) problems.push(`${where}: needs wajib [${job.needs.join(', ')}]`);
  }
  if (job.if === null) {
    if (Object.hasOwn(raw, 'if')) problems.push(`${where}: if hanya diizinkan pada job report`);
  } else if (raw['if'] !== job.if) problems.push(`${where}: if wajib ${job.if}`);

  const steps = raw['steps'];
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push(`${where}: steps wajib daftar yang tidak kosong`);
    return 0;
  }
  const counts = { checkout: 0, uploads: new Map<string, number>(), downloads: new Map<string, number>() };
  steps.forEach((step: unknown, index: number) => checkStep(job, step, `${where}, langkah ${index + 1}`, context, problems, runs, counts));
  if (counts.checkout === 0) problems.push(`${where}: wajib memakai ${CHECKOUT}`);
  for (const upload of job.uploads) {
    const count = counts.uploads.get(upload.name) ?? 0;
    if (count !== 1) problems.push(`${where}: unggahan ${upload.name} wajib tepat satu kali, ditemukan ${count}`);
  }
  for (const download of job.downloads) {
    const count = counts.downloads.get(download.name) ?? 0;
    if (count !== 1) problems.push(`${where}: unduhan ${download.name} wajib tepat satu kali, ditemukan ${count}`);
  }
  return steps.length;
}

type Counts = { checkout: number; uploads: Map<string, number>; downloads: Map<string, number> };

function checkStep(
  job: WorkflowJob,
  step: unknown,
  at: string,
  context: WorkflowContext,
  problems: string[],
  runs: Array<{ job: string; script: string }>,
  counts: Counts,
): void {
  if (!isRecord(step)) {
    problems.push(`${at}: wajib berupa mapping`);
    return;
  }
  for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) problems.push(`${at}: kunci ${shown(key)} tidak diizinkan`);
  if (Object.hasOwn(step, 'name') && typeof step['name'] !== 'string') problems.push(`${at}: name wajib teks`);
  const hasUses = Object.hasOwn(step, 'uses');
  const hasRun = Object.hasOwn(step, 'run');
  if (hasUses === hasRun) {
    problems.push(`${at}: wajib memakai tepat satu dari uses atau run`);
    return;
  }

  let kind: StepKind = 'other';
  if (hasRun) {
    kind = 'run';
    if (Object.hasOwn(step, 'with')) problems.push(`${at}: with hanya untuk langkah uses`);
    const command = typeof step['run'] === 'string' ? step['run'].trim() : null;
    const match = command === null ? null : /^bun run ([^\s]+)$/.exec(command);
    if (command !== null && SETUP_COMMANDS.includes(command)) {
      // One of the three setup commands.
    } else if (match?.[1] !== undefined && Object.hasOwn(context.scripts, match[1])) {
      runs.push({ job: job.name, script: match[1] });
    } else if (match?.[1] !== undefined) {
      problems.push(`${at}: script ${shown(match[1])} tidak ada di package.json`);
    } else {
      problems.push(`${at}: perintah run tidak diizinkan`);
    }
  } else {
    const uses = step['uses'];
    const match = typeof uses === 'string' ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(.+)$/.exec(uses) : null;
    if (match?.[1] === undefined || match[2] === undefined) problems.push(`${at}: uses tidak valid`);
    else if (!ALLOWED_ACTIONS.includes(match[1])) problems.push(`${at}: action ${shown(match[1])} tidak diizinkan`);
    else {
      if (!/^[0-9a-f]{40}$/.test(match[2])) problems.push(`${at}: action ${match[1]} wajib dipin SHA 40 heksadesimal`);
      kind = kinds[match[1]] ?? 'other';
      checkInputs(job, step, kind, match[1], at, context, problems, counts);
    }
  }

  if (Object.hasOwn(step, 'if')) {
    if (kind !== 'upload' || step['if'] !== UPLOAD_IF) problems.push(`${at}: if hanya diizinkan sebagai ${UPLOAD_IF} pada langkah unggah`);
  } else if (kind === 'upload') problems.push(`${at}: langkah unggah wajib if: ${UPLOAD_IF}`);

  if (Object.hasOwn(step, 'continue-on-error')) {
    if (kind !== 'download' || step['continue-on-error'] !== true) {
      problems.push(`${at}: continue-on-error: true hanya diizinkan pada langkah unduh job report`);
    }
  } else if (kind === 'download') problems.push(`${at}: langkah unduh wajib continue-on-error: true`);
}

function checkInputs(
  job: WorkflowJob,
  step: Record<string, unknown>,
  kind: StepKind,
  action: string,
  at: string,
  context: WorkflowContext,
  problems: string[],
  counts: Counts,
): void {
  if (Object.hasOwn(step, 'with') && !isRecord(step['with'])) problems.push(`${at}: with wajib berupa mapping`);
  const input = isRecord(step['with']) ? step['with'] : {};
  const allow = (keys: readonly string[]) => {
    for (const key of Object.keys(input)) if (!keys.includes(key)) problems.push(`${at}: input ${shown(key)} tidak diizinkan untuk ${action}`);
  };

  switch (kind) {
    case 'checkout':
      counts.checkout += 1;
      allow(['persist-credentials', 'fetch-depth']);
      if (input['persist-credentials'] !== false) problems.push(`${at}: checkout wajib persist-credentials: false`);
      if (job.fullHistory) {
        if (input['fetch-depth'] !== 0) problems.push(`${at}: checkout job ${job.name} wajib fetch-depth: 0`);
      } else if (Object.hasOwn(input, 'fetch-depth')) problems.push(`${at}: fetch-depth hanya diizinkan pada job security`);
      return;
    case 'setup-node':
      allow(['node-version']);
      if (input['node-version'] !== context.engines['node']) problems.push(`${at}: node-version wajib sama dengan engines.node`);
      return;
    case 'setup-bun':
      allow(['bun-version']);
      if (input['bun-version'] !== context.engines['bun']) problems.push(`${at}: bun-version wajib sama dengan engines.bun`);
      return;
    case 'upload': {
      allow(UPLOAD_INPUTS);
      for (const key of UPLOAD_INPUTS) if (!Object.hasOwn(input, key)) problems.push(`${at}: input ${key} wajib pada unggahan`);
      if (Object.hasOwn(input, 'include-hidden-files') && input['include-hidden-files'] !== true) problems.push(`${at}: include-hidden-files wajib true`);
      if (Object.hasOwn(input, 'retention-days') && input['retention-days'] !== 90) problems.push(`${at}: retention-days wajib 90`);
      if (Object.hasOwn(input, 'overwrite') && input['overwrite'] !== true) problems.push(`${at}: overwrite wajib true`);
      const expected = job.uploads.find((upload) => upload.name === input['name']);
      if (expected === undefined) {
        problems.push(`${at}: artifact ${shown(input['name'])} tidak diizinkan diunggah job ${job.name}`);
        return;
      }
      counts.uploads.set(expected.name, (counts.uploads.get(expected.name) ?? 0) + 1);
      const paths = pathLines(input['path']);
      if (paths === null || !sameList(paths, expected.paths)) problems.push(`${at}: path unggahan ${expected.name} wajib ${expected.paths.join(' dan ')}`);
      if (input['if-no-files-found'] !== expected.ifNoFilesFound) {
        problems.push(`${at}: if-no-files-found unggahan ${expected.name} wajib ${expected.ifNoFilesFound}`);
      }
      return;
    }
    case 'download': {
      allow(['name', 'path']);
      const expected = job.downloads.find((download) => download.name === input['name']);
      if (expected === undefined) {
        problems.push(`${at}: artifact ${shown(input['name'])} tidak diizinkan diunduh job ${job.name}`);
        return;
      }
      counts.downloads.set(expected.name, (counts.downloads.get(expected.name) ?? 0) + 1);
      if (input['path'] !== expected.path) problems.push(`${at}: path unduhan ${expected.name} wajib ${expected.path}`);
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// *Workflow kapasitas* (spec 0011): `capacity.yml`, triggered only by hand, runs the capacity tier and its report in one
// job and uploads the bundle and both report files. The steps are fixed in order; nothing else is allowed.

export const CAPACITY_JOB = 'capacity';
export const CAPACITY_TIMEOUT_MINUTES = 150;
export const CAPACITY_EVENT = 'workflow_dispatch';
export const CAPACITY_ARTIFACT = 'capacity-evidence';
export const CAPACITY_UPLOAD_PATHS: readonly string[] = [`${bundlePath(CAPACITY_TIER_NAME)}/`, CAPACITY_REPORT_JSON, CAPACITY_REPORT_MD];
const CAPACITY_JOB_KEYS = new Set(['runs-on', 'timeout-minutes', 'steps']);
const CAPACITY_STEP_KEYS = new Set(['name', 'uses', 'with', 'run', 'if']);

export type CapacityWorkflowContext = {
  /** `scripts` of `package.json`. */
  scripts: Readonly<Record<string, unknown>>;
  /** `engines` of `package.json`. */
  engines: Readonly<Record<string, unknown>>;
  /** Every SHA each action is pinned to in `application.yml` (`actionPins`). */
  pins: ReadonlyMap<string, ReadonlySet<string>>;
};

/** One allowed input value, and how a wrong value is named in the problem. */
type ExpectedInput = { value: unknown; text: string; lines?: boolean };
type ExpectedStep =
  | { kind: 'uses'; action: string; with: Readonly<Record<string, ExpectedInput>>; if: string | null; text: string }
  | { kind: 'run'; script: string | null; run: string; if: string | null; text: string };

/** The seven steps of the capacity job, in order (*Workflow kapasitas*, third item). */
export function capacitySteps(engines: Readonly<Record<string, unknown>>): ExpectedStep[] {
  const exact = (value: unknown): ExpectedInput => ({ value, text: shown(value) });
  const run = (command: string, script: string | null, condition: string | null = null): ExpectedStep => ({
    kind: 'run',
    script,
    run: command,
    if: condition,
    text: `run: ${command}`,
  });
  return [
    { kind: 'uses', action: CHECKOUT, with: { 'persist-credentials': exact(false) }, if: null, text: `${CHECKOUT} dengan persist-credentials: false` },
    {
      kind: 'uses',
      action: SETUP_NODE,
      with: { 'node-version': { value: engines['node'], text: 'sama dengan engines.node' } },
      if: null,
      text: `${SETUP_NODE} dengan node-version engines.node`,
    },
    {
      kind: 'uses',
      action: SETUP_BUN,
      with: { 'bun-version': { value: engines['bun'], text: 'sama dengan engines.bun' } },
      if: null,
      text: `${SETUP_BUN} dengan bun-version engines.bun`,
    },
    run('bun install --frozen-lockfile', null),
    run(`bun run ${CAPACITY_TIER.script}`, CAPACITY_TIER.script),
    run('bun run test:report:capacity', 'test:report:capacity', REPORT_IF),
    {
      kind: 'uses',
      action: UPLOAD,
      with: {
        name: exact(CAPACITY_ARTIFACT),
        path: { value: [...CAPACITY_UPLOAD_PATHS].sort(), text: CAPACITY_UPLOAD_PATHS.join(' dan '), lines: true },
        'include-hidden-files': exact(true),
        'retention-days': exact(90),
        'if-no-files-found': exact('warn'),
        overwrite: exact(true),
      },
      if: UPLOAD_IF,
      text: `${UPLOAD} ${CAPACITY_ARTIFACT}`,
    },
  ];
}

/** Every SHA each allowed action is pinned to in the workflow `text` (`application.yml`); empty when it cannot be read. */
export function actionPins(text: string): Map<string, Set<string>> {
  const pins = new Map<string, Set<string>>();
  let workflow: unknown;
  try {
    workflow = Bun.YAML.parse(text);
  } catch {
    return pins;
  }
  const jobs = isRecord(workflow) && isRecord(workflow['jobs']) ? Object.values(workflow['jobs']) : [];
  for (const job of jobs) {
    const steps = isRecord(job) && Array.isArray(job['steps']) ? job['steps'] : [];
    for (const step of steps) {
      const uses = isRecord(step) ? step['uses'] : undefined;
      const match = typeof uses === 'string' ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})$/.exec(uses) : null;
      if (match?.[1] === undefined || match[2] === undefined) continue;
      const set = pins.get(match[1]) ?? new Set<string>();
      set.add(match[2]);
      pins.set(match[1], set);
    }
  }
  return pins;
}

function sameValue(actual: unknown, expected: ExpectedInput): boolean {
  if (expected.lines === true) {
    const lines = pathLines(actual);
    return lines !== null && sameList(lines, expected.value as string[]);
  }
  return actual === expected.value;
}

function checkCapacityStep(expected: ExpectedStep, step: unknown, at: string, context: CapacityWorkflowContext, problems: string[]): void {
  if (!isRecord(step)) {
    problems.push(`${at}: wajib berupa mapping`);
    return;
  }
  for (const key of Object.keys(step)) if (!CAPACITY_STEP_KEYS.has(key)) problems.push(`${at}: kunci ${shown(key)} tidak diizinkan`);
  if (Object.hasOwn(step, 'name') && typeof step['name'] !== 'string') problems.push(`${at}: name wajib teks`);
  if (expected.if === null) {
    if (Object.hasOwn(step, 'if')) problems.push(`${at}: if tidak diizinkan pada langkah ini`);
  } else if (step['if'] !== expected.if) problems.push(`${at}: if wajib ${expected.if}`);

  if (expected.kind === 'run') {
    if (Object.hasOwn(step, 'uses') || Object.hasOwn(step, 'with')) problems.push(`${at}: wajib ${expected.text} tanpa uses atau with`);
    const command = typeof step['run'] === 'string' ? step['run'].trim() : null;
    if (command !== expected.run) problems.push(`${at}: wajib ${expected.text}`);
    else if (expected.script !== null && !Object.hasOwn(context.scripts, expected.script)) {
      problems.push(`${at}: script ${expected.script} tidak ada di package.json`);
    }
    return;
  }

  if (Object.hasOwn(step, 'run')) problems.push(`${at}: wajib ${expected.text} tanpa run`);
  const uses = step['uses'];
  const match = typeof uses === 'string' ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(.+)$/.exec(uses) : null;
  if (match?.[1] !== expected.action || match[2] === undefined) {
    problems.push(`${at}: wajib uses ${expected.action}`);
  } else if (!/^[0-9a-f]{40}$/.test(match[2])) {
    problems.push(`${at}: action ${expected.action} wajib dipin SHA 40 heksadesimal`);
  } else if (context.pins.get(expected.action)?.has(match[2]) !== true) {
    problems.push(`${at}: action ${expected.action} wajib dipin SHA yang sama dengan application.yml`);
  }
  if (Object.hasOwn(step, 'with') && !isRecord(step['with'])) problems.push(`${at}: with wajib berupa mapping`);
  const input = isRecord(step['with']) ? step['with'] : {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(expected.with, key)) problems.push(`${at}: input ${shown(key)} tidak diizinkan untuk ${expected.action}`);
  }
  for (const [key, value] of Object.entries(expected.with)) {
    if (!Object.hasOwn(input, key) || !sameValue(input[key], value)) problems.push(`${at}: input ${key} wajib ${value.text}`);
  }
}

/** Applies every rule of *Workflow kapasitas* to the workflow `text` and returns every problem at once. */
export function checkCapacityWorkflow(text: string, context: CapacityWorkflowContext): WorkflowResult {
  const problems: string[] = [];
  const summary: WorkflowResult['jobs'] = [];
  if (text.includes('secrets.')) problems.push('workflow tidak boleh memuat teks secrets.');

  let workflow: unknown;
  try {
    workflow = Bun.YAML.parse(text);
  } catch {
    problems.push('workflow bukan YAML yang valid');
    return { problems, jobs: summary };
  }
  if (!isRecord(workflow)) {
    problems.push('workflow wajib berupa mapping');
    return { problems, jobs: summary };
  }
  for (const key of Object.keys(workflow)) if (!WORKFLOW_KEYS.has(key)) problems.push(`kunci workflow ${shown(key)} tidak diizinkan`);
  if (Object.hasOwn(workflow, 'name') && typeof workflow['name'] !== 'string') problems.push('name workflow wajib teks');

  const on = workflow['on'];
  if (!isRecord(on)) problems.push(`on wajib mapping berisi tepat ${CAPACITY_EVENT}`);
  else {
    for (const key of Object.keys(on)) if (key !== CAPACITY_EVENT) problems.push(`trigger ${shown(key)} tidak diizinkan`);
    if (!Object.hasOwn(on, CAPACITY_EVENT)) problems.push(`trigger ${CAPACITY_EVENT} wajib ada`);
    else if (!(on[CAPACITY_EVENT] === null || (isRecord(on[CAPACITY_EVENT]) && Object.keys(on[CAPACITY_EVENT]).length === 0))) {
      problems.push(`trigger ${CAPACITY_EVENT} wajib tanpa inputs atau kunci lain`);
    }
  }

  const permissions = workflow['permissions'];
  if (!isRecord(permissions) || Object.keys(permissions).length !== 1 || permissions['contents'] !== 'read') {
    problems.push('permissions wajib tepat contents: read');
  }

  const jobs = workflow['jobs'];
  if (!isRecord(jobs)) {
    problems.push('jobs wajib berupa mapping');
    return { problems, jobs: summary };
  }
  for (const name of Object.keys(jobs)) if (name !== CAPACITY_JOB) problems.push(`job ${shown(name)} tidak diizinkan`);
  if (!Object.hasOwn(jobs, CAPACITY_JOB)) {
    problems.push(`job ${CAPACITY_JOB} wajib ada`);
    return { problems, jobs: summary };
  }
  const where = `job ${CAPACITY_JOB}`;
  const job = jobs[CAPACITY_JOB];
  if (!isRecord(job)) {
    problems.push(`${where}: wajib berupa mapping`);
    return { problems, jobs: summary };
  }
  for (const key of Object.keys(job)) if (!CAPACITY_JOB_KEYS.has(key)) problems.push(`${where}: kunci ${shown(key)} tidak diizinkan`);
  if (job['runs-on'] !== RUNS_ON) problems.push(`${where}: runs-on wajib ${RUNS_ON}`);
  if (job['timeout-minutes'] !== CAPACITY_TIMEOUT_MINUTES) problems.push(`${where}: timeout-minutes wajib ${CAPACITY_TIMEOUT_MINUTES}`);
  const steps = job['steps'];
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push(`${where}: steps wajib daftar yang tidak kosong`);
    return { problems, jobs: summary };
  }
  const expected = capacitySteps(context.engines);
  for (let index = 0; index < Math.max(expected.length, steps.length); index += 1) {
    const at = `${where}, langkah ${index + 1}`;
    const want = expected[index];
    if (want === undefined) problems.push(`${at}: langkah tambahan tidak diizinkan`);
    else if (index >= steps.length) problems.push(`${where}: langkah ${index + 1} wajib ${want.text}`);
    else checkCapacityStep(want, steps[index], at, context, problems);
  }
  summary.push({ name: CAPACITY_JOB, steps: steps.length });
  return { problems, jobs: summary };
}

/** Workflow files in the folder other than `WORKFLOW_FILES`, as repository paths, sorted. */
export async function extraWorkflowFiles(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, WORKFLOW_DIR));
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.(yml|yaml)$/i.test(name))
    .map((name) => `${WORKFLOW_DIR}/${name}`)
    .filter((path) => !WORKFLOW_FILES.includes(path))
    .sort();
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * `check:workflow` on `root`: checks `application.yml` and `capacity.yml`, rejects every other `*.yml` or `*.yaml` file in
 * `.github/workflows/`, prints every problem on its own line with the path of its file, and resolves to the exit code.
 */
export async function runWorkflowCheck(
  root: string,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  error: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  jobs: readonly WorkflowJob[] = workflowJobs(),
): Promise<number> {
  const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const record = isRecord(manifest) ? manifest : {};
  const scripts = isRecord(record['scripts']) ? record['scripts'] : {};
  const engines = isRecord(record['engines']) ? record['engines'] : {};
  const problems: string[] = [];
  for (const path of await extraWorkflowFiles(root)) problems.push(`file workflow ${path} tidak diizinkan; hanya ${WORKFLOW_FILES.join(' dan ')}`);

  const text = await readFile(join(root, WORKFLOW_PATH), 'utf8');
  const application = checkWorkflow(text, { scripts, engines, jobs });
  problems.push(...application.problems.map((problem) => `${WORKFLOW_PATH}: ${problem}`));

  const capacityText = await readOptional(join(root, CAPACITY_WORKFLOW_PATH));
  let capacity: WorkflowResult = { problems: [], jobs: [] };
  if (capacityText === null) problems.push(`${CAPACITY_WORKFLOW_PATH} wajib ada`);
  else {
    capacity = checkCapacityWorkflow(capacityText, { scripts, engines, pins: actionPins(text) });
    problems.push(...capacity.problems.map((problem) => `${CAPACITY_WORKFLOW_PATH}: ${problem}`));
  }

  if (problems.length > 0) {
    error(`Pemeriksaan workflow gagal dengan ${problems.length} masalah:`);
    for (const problem of problems) error(`  ${problem}`);
    return 1;
  }
  const described = (result: WorkflowResult) => result.jobs.map((job) => `${job.name} ${job.steps} langkah`).join(', ');
  log(`Workflow lulus: application.yml (${described(application)}), capacity.yml (${described(capacity)}).`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runWorkflowCheck(resolve(import.meta.dir, '..'));
  } catch {
    process.stderr.write(`Workflow di ${WORKFLOW_DIR} tidak dapat diperiksa\n`);
    process.exitCode = 1;
  }
}
