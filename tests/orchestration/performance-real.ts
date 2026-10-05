import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { chown, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { arch, availableParallelism, cpus, release, tmpdir, totalmem, type as osType } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stepEnvironment } from '../../scripts/lib/gate.ts';
import { runProcessGroup, type ProcessGroupOptions, type ProcessGroupResult } from '../../scripts/lib/process-group.ts';
import { k6ExitReason } from '../performance/helpers/expectations.ts';
import {
  ENDPOINTS,
  LOADS,
  optionsFor,
  OUTAGE_START_MS,
  OUTAGE_STOP_MS,
  phaseWindows,
  plannedScenarios,
  PROFILE_NAMES,
  profilePlan,
  profileSeconds,
  readinessKey,
  statusLatencyKey,
  T0_DELAY_MS,
  type Endpoint,
  type K6Options,
  type PhaseTarget,
  type ProfileName,
} from '../performance/helpers/plan.ts';
import { COMPOSE_CONTAINER_LABELS } from './readiness-container.ts';

// `bun run test:performance:<profile>` (spec 0011, AC-1 to AC-8 and AC-10): one k6 profile run in its own Docker
// environment. In order: the argument check, the pre-run checks (pins, .env files, container engine size, other
// `foundation.test` containers, the PostgreSQL image, pulls by digest, and k6 inspect of the six profiles on smoke), a
// new network, an isolated PostgreSQL 18 provisioned and migrated with random credentials, the development composition
// backend in a Bun container, the environment read, k6 sharing the network namespace of the backend while a `docker
// stats` stream and a `pg_stat_activity` sampler observe the run (and, on outage, PostgreSQL is stopped at T0 + 90 s and
// started again at T0 + 150 s), the k6 exit, the second clock offset, the backend state and output, the
// summary and observation checks, cleanup through the container guard on every exit path, then `observation.json`,
// `result.json`, and `artifact-scan.json` in `.local/feature-12/<profile>/`. Docker is always called with an argument
// array through `runProcessGroup`. The console prints fixed lines, reason codes, resource names of the run, and measured
// values only, each through `redacted()`; raw command output is never printed. This file lives in tests/, not scripts/,
// because INFRA-001 of spec 0002 keeps scripts/ free of Docker.

export const EVIDENCE_ROOT = '.local/feature-12';
export const IMAGES_PATH = 'tests/performance/images.json';
export const POSTGRES_PINS_PATH = 'infrastructure/postgres/pins.json';
export const POSTGRES_IMAGE = 'foundation-postgres:18-pinned';
export const MIGRATIONS_DIR = 'database/migrations';
export const COMPOSE_FILES = ['docker-compose.yml', 'tests/integration/infrastructure/compose.test.yml'] as const;
export const K6_REPOSITORY = 'grafana/k6';
export const K6_TAG = '2.3.0';
export const BUN_REPOSITORY = 'oven/bun';
/** Container engine minimum: 4 CPU and 4 GiB (the memory limits of the three containers, 3.5 GiB, plus a margin). */
export const MIN_NCPU = 4;
export const MIN_MEMORY_BYTES = 4_294_967_296;
/** Folders mounted into the backend, walked for files whose name starts with `.env`. */
export const ENV_SCAN_ROOTS = ['apps/backend', 'libs', 'node_modules'] as const;
export const TEXT_LIMIT = 200;
export const USAGE = `Pemakaian: bun --no-env-file tests/orchestration/performance-real.ts <${PROFILE_NAMES.join('|')}>`;

/** *Batas waktu perintah* (ms). */
export const TIMEOUTS = {
  daemonQuery: 30_000,
  imageBuild: 900_000,
  pull: 300_000,
  create: 60_000,
  k6Inspect: 60_000,
  selectOneTotal: 30_000,
  selectOneAttempt: 2_000,
  selectOnePause: 250,
  provision: 60_000,
  migrate: 60_000,
  backendPollCall: 10_000,
  backendPollTotal: 60_000,
  backendPollPause: 250,
  clockRead: 10_000,
  /** Added to the profile seconds × 1000 for `docker start -a` of k6. */
  k6Extra: 15_000 + 120_000,
  backendControl: 30_000,
  logsLimitBytes: 1_048_576,
  guardInspect: 10_000,
  k6Stop: 15_000,
  remove: 15_000,
  cancelGrace: 5_000,
  cancelMax: 10_000,
  streamsStop: 5_000,
  /** Added to the profile seconds × 1000 for each `docker stats` stream process. */
  statsExtra: 15_000 + 180_000,
  /** A stream that ends before k6 is started again at most this often, after this pause. */
  statsRestarts: 10,
  statsRestartPause: 1_000,
  /** One `pg_stat_activity` sample every 1000 ms without overlap, each limited to 2000 ms, connection timeout 1 s. */
  poolInterval: 1_000,
  poolSample: 2_000,
  poolConnectionTimeoutSeconds: 1,
  /** `docker stop --time 10` and `docker start` of PostgreSQL on outage (process limit; the judged limits are in `outage_control`). */
  outageControl: 20_000,
} as const;

/** Pool of the backend (spec 0004), recorded in `environment.pool`. */
export const BACKEND_POOL = { max: 5, connectionTimeoutSeconds: 3 } as const;

/** The only backend stdout the `backend_output` check accepts: the listening line, then after stop the stopped line. */
export const EXPECTED_BACKEND_STDOUT = 'Backend listening at http://127.0.0.1:8888\nBackend stopped\n';

/**
 * Pass limits of *Pengamatan resource* and AC-5. `generatorCpu` is 80 percent of the 3 CPU of k6 (in percent of one
 * CPU) and `generatorMemoryMiB` 80 percent of its 2 GiB. The evaluators take the limits as a parameter, so a unit can
 * force a failure with a small limit.
 */
export const OBSERVATION_LIMITS = {
  backendMemoryPeakMiB: 128,
  backendCpuMean: 50,
  backendMemoryGrowthMiB: 16,
  poolSessions: 5,
  poolNonIdle: 1,
  generatorCpu: 240,
  generatorMemoryMiB: 1_638,
  /** At least floor(phase seconds / 5) numeric samples per container and measured phase. */
  coverageSecondsPerSample: 5,
  coverageGapMs: 15_000,
  poolGapMs: 10_000,
  clockOffsetMs: 1_000,
  phaseStartLateMs: 2_000,
  samplesPerSecond: 4,
  /** Soak memory growth: the mean of the last 600 s of `steady` minus the mean of seconds 300 to 900 of `steady`. */
  growthEarlyFromMs: 300_000,
  growthEarlyToMs: 900_000,
  growthLateMs: 600_000,
  /** Outage control: sent no earlier than planned and at most 1000 ms later; stop done within 8000 ms, start 5000 ms. */
  outageSendLateMs: 1_000,
  outageStopDoneMs: 8_000,
  outageStartDoneMs: 5_000,
} as const;
export type ObservationLimits = { [Key in keyof typeof OBSERVATION_LIMITS]: number };

/** Resource limits of every container (*Topologi environment test*). */
export const CONTAINER_LIMITS = {
  postgres: { cpus: '2', memory: '1g', shmSize: '128m', pids: '256' },
  backend: { cpus: '1', memory: '512m', pids: '256' },
  k6: { cpus: '3', memory: '2g', pids: '512' },
  inspect: { cpus: '1', memory: '512m', pids: '512' },
} as const;

const TMPFS = '/tmp:rw,nosuid,nodev,noexec,size=64m';

/** Worst case cleanup time from the limits in use (step 7 of *Urutan orkestrasi*): 165000 ms. */
export function worstCaseCleanupMs(): number {
  const guarded = (actionMs: number) => TIMEOUTS.guardInspect + actionMs;
  return TIMEOUTS.cancelMax + TIMEOUTS.streamsStop + guarded(TIMEOUTS.k6Stop) + 4 * guarded(TIMEOUTS.remove) + guarded(TIMEOUTS.remove);
}

// ---------------------------------------------------------------------------------------------------------------
// Reason codes (*Kode alasan*).

export const PERFORMANCE_REASON_CODES = [
  'pin_invalid',
  'env_file_present',
  'environment_too_small',
  'environment_busy',
  'image_build_failed',
  'image_pull_failed',
  'inspect_mismatch',
  'setup_failed',
  'backend_not_ready',
  'k6_thresholds_failed',
  'k6_failed',
  'k6_timeout',
  'summary_missing',
  'phase_start_late',
  'iteration_request_mismatch',
  'generator_saturated',
  'observation_failed',
  'outage_control_late',
  'secret_in_output',
  'cleanup_failed',
  'signal',
] as const;
export type PerformanceReasonCode = (typeof PERFORMANCE_REASON_CODES)[number];

/** The `detail` vocabulary of `setup_failed`. */
export const SETUP_STEPS = [
  'network',
  'postgres_start',
  'postgres_ready',
  'provision',
  'migrate',
  'migration_count',
  'backend_start',
  'clock_offset_read',
  'k6_create',
  'stats_start',
  'environment_read',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export type Reason = { code: PerformanceReasonCode; detail: string | null };

export function reason(code: PerformanceReasonCode, detail: string | null = null): Reason {
  return { code, detail: detail === null ? null : detail.slice(0, TEXT_LIMIT) };
}

// ---------------------------------------------------------------------------------------------------------------
// Profiles, resource names, labels, and the container user.

/** Pre-run check (1): one of the six profile names; the evidence path is only ever built from such a name. */
export function runnableProfile(value: unknown): value is ProfileName {
  return typeof value === 'string' && (PROFILE_NAMES as readonly string[]).includes(value);
}

export type ResourceNames = { network: string; db: string; backend: string; k6: string; inspect: string };

export const RESOURCE_NAME = /^foundation-perf-(db|backend|k6|inspect|net)-[0-9a-f]{12}$/;

/** `<hex>` of a run: 12 hexadecimal characters from `randomBytes(6)`. */
export function runHex(random: Uint8Array = randomBytes(6)): string {
  return Buffer.from(random).toString('hex');
}

export function resourceNames(hex: string): ResourceNames {
  return {
    network: `foundation-perf-net-${hex}`,
    db: `foundation-perf-db-${hex}`,
    backend: `foundation-perf-backend-${hex}`,
    k6: `foundation-perf-k6-${hex}`,
    inspect: `foundation-perf-inspect-${hex}`,
  };
}

/** Labels of every container and network of a run; the two empty labels override Compose labels an image passes on. */
export function runLabelArgs(hex: string): string[] {
  return [
    '--label', 'foundation.test=performance',
    '--label', `foundation.run=${hex}`,
    '--label', 'com.docker.compose.project=',
    '--label', 'com.docker.compose.service=',
  ];
}

/** Container `--user`: the host UID and GID, or 65534:65534 when the host UID is 0. */
export function containerUser(uid: number, gid: number): string {
  return uid === 0 ? '65534:65534' : `${uid}:${gid}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Image pins (`tests/performance/images.json`), pre-run check (2).

const PIN = /^(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*):(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@sha256:(?<digest>[0-9a-f]{64})$/;

export type ImagePins = { k6: string; bun: string };
export type PinCheck = { ok: true; pins: ImagePins } | { ok: false; detail: 'k6' | 'bun' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function pinImage(entry: unknown, repository: string, tag: string): string | null {
  if (!isRecord(entry) || !hasExactKeys(entry, ['image']) || typeof entry['image'] !== 'string') return null;
  const groups = PIN.exec(entry['image'])?.groups;
  return groups !== undefined && groups['repository'] === repository && groups['tag'] === tag ? entry['image'] : null;
}

/**
 * Shape `<repo>:<tag>@sha256:<64 lower case hex>`, k6 exactly `grafana/k6:2.3.0`, Bun exactly
 * `oven/bun:<engines.bun>-slim`. The first failure sets the detail; a file outside the locked shape fails `k6`.
 */
export function validateImagePins(text: string | null, enginesBun: unknown): PinCheck {
  let value: unknown;
  try {
    value = text === null ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  if (!isRecord(value) || !hasExactKeys(value, ['k6', 'bun'])) return { ok: false, detail: 'k6' };
  const k6 = pinImage(value['k6'], K6_REPOSITORY, K6_TAG);
  if (k6 === null) return { ok: false, detail: 'k6' };
  const bun = typeof enginesBun === 'string' && enginesBun !== '' ? pinImage(value['bun'], BUN_REPOSITORY, `${enginesBun}-slim`) : null;
  if (bun === null) return { ok: false, detail: 'bun' };
  return { ok: true, pins: { k6, bun } };
}

// ---------------------------------------------------------------------------------------------------------------
// `.env` files in the mounted folders (3) and the container engine size (4).

/**
 * Path (relative to `root`) of the first file whose name starts with `.env` under `apps/backend`, `libs`, and
 * `node_modules`, in name order; the walk never follows a symlink, and a missing folder is skipped.
 */
export async function findEnvFile(root: string): Promise<string | null> {
  const visit = async (relative: string): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (entry.name.startsWith('.env') && !entry.isDirectory()) return path;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const found = await visit(path);
        if (found !== null) return found;
      }
    }
    return null;
  };
  for (const folder of ENV_SCAN_ROOTS) {
    const found = await visit(folder);
    if (found !== null) return found;
  }
  return null;
}

/** The `environment_too_small` detail when the container engine sees fewer than 4 CPU or 4 GiB, otherwise `null`. */
export function environmentTooSmall(ncpu: number, memTotal: number): string | null {
  return ncpu >= MIN_NCPU && memTotal >= MIN_MEMORY_BYTES ? null : `ncpu=${ncpu} memTotal=${memTotal}`;
}

/** `docker info --format '{{json .NCPU}} {{json .MemTotal}}'`; `null` unless the output is two integers. */
export function parseEngineSize(stdout: string): { ncpu: number; memTotal: number } | null {
  const match = /^(\d+) (\d+)$/.exec(stdout.trim());
  if (match === null) return null;
  return { ncpu: Number(match[1]), memTotal: Number(match[2]) };
}

// ---------------------------------------------------------------------------------------------------------------
// Container arguments (*Topologi environment test*).

export type ContainerContext = {
  root: string;
  hex: string;
  uid: number;
  gid: number;
  pins: ImagePins;
};

export function networkCreateArgs(context: Pick<ContainerContext, 'hex'>): string[] {
  return ['docker', 'network', 'create', ...runLabelArgs(context.hex), resourceNames(context.hex).network];
}

export function postgresRunArgs(context: Pick<ContainerContext, 'hex'>, hostPort: number, envFile: string): string[] {
  const names = resourceNames(context.hex);
  const limits = CONTAINER_LIMITS.postgres;
  return [
    'docker', 'run', '-d', '--name', names.db, ...runLabelArgs(context.hex),
    '--network', names.network, '--network-alias', 'postgres', '-p', `127.0.0.1:${hostPort}:5432`,
    '--cpus', limits.cpus, '--memory', limits.memory, '--shm-size', limits.shmSize, '--pids-limit', limits.pids,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--env-file', envFile, POSTGRES_IMAGE,
  ];
}

export function backendRunArgs(context: ContainerContext, envFile: string): string[] {
  const names = resourceNames(context.hex);
  const limits = CONTAINER_LIMITS.backend;
  return [
    'docker', 'run', '-d', '--name', names.backend, ...runLabelArgs(context.hex), '--network', names.network,
    '--cpus', limits.cpus, '--memory', limits.memory, '--pids-limit', limits.pids,
    '--pull', 'never', '--read-only', '--tmpfs', TMPFS, '--user', containerUser(context.uid, context.gid),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${join(context.root, 'apps/backend')}:/repo/apps/backend:ro`,
    '-v', `${join(context.root, 'libs')}:/repo/libs:ro`,
    '-v', `${join(context.root, 'node_modules')}:/repo/node_modules:ro`,
    '-v', `${join(context.root, 'package.json')}:/repo/package.json:ro`,
    '-w', '/repo', '--env-file', envFile, context.pins.bun,
    'bun', '--no-env-file', 'apps/backend/src/index.ts',
  ];
}

export function k6CreateArgs(context: ContainerContext, profile: ProfileName, expectedMigrations: number, t0: number): string[] {
  const names = resourceNames(context.hex);
  const limits = CONTAINER_LIMITS.k6;
  return [
    'docker', 'create', '--name', names.k6, ...runLabelArgs(context.hex), '--network', `container:${names.backend}`,
    '--cpus', limits.cpus, '--memory', limits.memory, '--pids-limit', limits.pids,
    '--pull', 'never', '--read-only', '--tmpfs', TMPFS, '--user', containerUser(context.uid, context.gid),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-e', 'K6_NO_USAGE_REPORT=true',
    '-v', `${join(context.root, 'tests/performance')}:/scripts:ro`,
    '-v', `${join(context.root, EVIDENCE_ROOT, profile, 'k6')}:/out`,
    context.pins.k6,
    'run', '--no-usage-report', '--quiet',
    '--env', `FOUNDATION_PERF_EXPECTED_MIGRATIONS=${expectedMigrations}`, '--env', `FOUNDATION_PERF_T0=${t0}`,
    `/scripts/profiles/${profile}.ts`,
  ];
}

export function inspectRunArgs(context: ContainerContext, profile: ProfileName): string[] {
  const names = resourceNames(context.hex);
  const limits = CONTAINER_LIMITS.inspect;
  return [
    'docker', 'run', '--rm', '--name', names.inspect, ...runLabelArgs(context.hex), '--network', 'none',
    '--cpus', limits.cpus, '--memory', limits.memory, '--pids-limit', limits.pids,
    '--pull', 'never', '--read-only', '--tmpfs', TMPFS, '--user', containerUser(context.uid, context.gid),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${join(context.root, 'tests/performance')}:/scripts:ro`,
    context.pins.k6, 'inspect', '--execution-requirements', `/scripts/profiles/${profile}.ts`,
  ];
}

/** Backend state after k6: three fields only, never without `--format`, because `Config.Env` holds a credential. */
export function backendStateArgs(name: string): string[] {
  return ['docker', 'container', 'inspect', '--format', '{{json .State.Running}} {{json .RestartCount}} {{json .State.OOMKilled}}', name];
}

/** Fixed backend poll script, run in its namespace; prints both statuses and the readiness migration count. */
export const BACKEND_POLL_SCRIPT = [
  'const get = async (path) => {',
  '  try {',
  "    const response = await fetch('http://127.0.0.1:8888' + path, { signal: AbortSignal.timeout(2000) });",
  '    const text = await response.text();',
  '    let body = null;',
  '    try { body = JSON.parse(text); } catch {}',
  '    return { status: response.status, body };',
  '  } catch {',
  '    return { status: 0, body: null };',
  '  }',
  '};',
  "const status = await get('/api/status');",
  "const readiness = await get('/api/readiness');",
  'const applied = readiness.body !== null && typeof readiness.body === "object" ? readiness.body.appliedMigrations : null;',
  'console.log(JSON.stringify({ status: status.status, readiness: readiness.status, appliedMigrations: Number.isInteger(applied) ? applied : null }));',
].join('\n');

export const CLOCK_SCRIPT = 'console.log(Date.now())';

/** The backend is ready when `/api/status` answers 200 and `/api/readiness` 200 with the expected migration count. */
export function backendReady(stdout: string, expectedMigrations: number): boolean {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    return isRecord(value) && value['status'] === 200 && value['readiness'] === 200 && value['appliedMigrations'] === expectedMigrations;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Container guard (*Penjaga container*).

/** (1) The name matches the pattern and is exactly a name this run created. */
export function guardNameAccepted(name: string, names: ResourceNames): boolean {
  return RESOURCE_NAME.test(name) && Object.values(names).includes(name);
}

/** (3) `foundation.test` is exactly `performance`, `foundation.run` is this run's `<hex>`, and no Compose container key. */
export function guardLabelsAccepted(labels: unknown, hex: string): boolean {
  return (
    isRecord(labels) &&
    labels['foundation.test'] === 'performance' &&
    labels['foundation.run'] === hex &&
    !COMPOSE_CONTAINER_LABELS.some((key) => Object.hasOwn(labels, key))
  );
}

/**
 * An inspect that answers the resource is gone: exit 1 with the daemon answer `No such container` for a container, or
 * `No such network` or `network <name> not found` (the Docker Engine 29 form) for a network. Any other failure is no
 * proof that the resource is gone.
 */
export function resourceMissing(kind: 'container' | 'network', name: string, code: number | null, stderr: string): boolean {
  if (code !== 1) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern =
    kind === 'container'
      ? new RegExp(`(^|\\n)Error( response from daemon)?: No such container: ${escaped}`)
      : new RegExp(`(^|\\n)Error( response from daemon)?: (No such network: ${escaped}|network ${escaped} not found)`);
  return pattern.test(stderr);
}

export function guardInspectArgs(kind: 'container' | 'network', name: string): string[] {
  return kind === 'container'
    ? ['docker', 'container', 'inspect', '--format', '{{json .Config.Labels}}', name]
    : ['docker', 'network', 'inspect', '--format', '{{json .Labels}}', name];
}

// ---------------------------------------------------------------------------------------------------------------
// Inspect comparison (*Pemeriksaan inspect*).

const DURATION_UNITS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 0.001, 'µs': 0.001, ns: 0.000001 };
const DURATION = /^(?:\d+(?:\.\d+)?(?:h|ms|m|s|us|µs|ns))+$/;

/** A Go duration string (`1m0s`, `1.5s`) or a short `optionsFor` string (`10s`) as whole milliseconds; `null` otherwise. */
export function durationMs(value: unknown): number | null {
  if (typeof value !== 'string' || !DURATION.test(value)) return null;
  let total = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) total += Number(match[1]) * DURATION_UNITS[match[2]!]!;
  return Math.round(total);
}

export type NormalizedThreshold = { expression: string; abortOnFail: boolean; delayAbortEvalMs: number };
export type NormalizedOptions = {
  scenarios: Record<string, Record<string, unknown>>;
  thresholds: Record<string, NormalizedThreshold[]>;
};

const SCENARIO_FIELDS = ['executor', 'exec', 'rate', 'startRate', 'stages', 'duration', 'startTime', 'timeUnit', 'preAllocatedVUs', 'maxVUs', 'gracefulStop'];
const DURATION_FIELDS = new Set(['duration', 'startTime', 'timeUnit', 'gracefulStop']);

class Mismatch extends Error {}

function normalizeField(field: string, value: unknown): unknown {
  if (field === 'startTime' && (value === undefined || value === null)) return 0;
  if (DURATION_FIELDS.has(field)) {
    const ms = durationMs(value);
    if (ms === null) throw new Mismatch(field);
    return ms;
  }
  if (field === 'stages') {
    if (!Array.isArray(value)) throw new Mismatch(field);
    return value.map((stage: unknown) => {
      if (!isRecord(stage) || !hasExactKeys(stage, ['duration', 'target'])) throw new Mismatch(field);
      const duration = durationMs(stage['duration']);
      if (duration === null || typeof stage['target'] !== 'number') throw new Mismatch(field);
      return { duration, target: stage['target'] };
    });
  }
  return value;
}

function normalizeThreshold(item: unknown): NormalizedThreshold {
  if (typeof item === 'string') return { expression: item, abortOnFail: false, delayAbortEvalMs: 0 };
  if (!isRecord(item) || typeof item['threshold'] !== 'string') throw new Mismatch('threshold');
  for (const key of Object.keys(item)) {
    if (!['threshold', 'abortOnFail', 'delayAbortEval'].includes(key)) throw new Mismatch('threshold');
  }
  const abort = item['abortOnFail'];
  if (abort !== undefined && typeof abort !== 'boolean') throw new Mismatch('threshold');
  const delay = item['delayAbortEval'] === undefined || item['delayAbortEval'] === null || item['delayAbortEval'] === '' ? 0 : durationMs(item['delayAbortEval']);
  if (delay === null) throw new Mismatch('threshold');
  return { expression: item['threshold'], abortOnFail: abort === true, delayAbortEvalMs: delay };
}

/**
 * Comparable form of `options` from `k6 inspect --execution-requirements` output or from `optionsFor`: per scenario
 * only the fields `optionsFor` declares (`fields` per scenario; every known field when `null`), durations in ms,
 * `startTime` without a value as 0, and every threshold item as `{ expression, abortOnFail, delayAbortEvalMs }`.
 * Throws `Mismatch` for a shape it does not know.
 */
export function normalizeInspect(value: unknown, fields: Readonly<Record<string, readonly string[]>> | null = null): NormalizedOptions {
  if (!isRecord(value) || !isRecord(value['scenarios']) || !isRecord(value['thresholds'])) throw new Mismatch('shape');
  const scenarios: Record<string, Record<string, unknown>> = {};
  for (const [name, scenario] of Object.entries(value['scenarios'])) {
    if (!isRecord(scenario)) throw new Mismatch(name);
    const wanted = fields?.[name] ?? SCENARIO_FIELDS.filter((field) => field === 'startTime' || Object.hasOwn(scenario, field));
    const normalized: Record<string, unknown> = {};
    for (const field of wanted) {
      if (field !== 'startTime' && !Object.hasOwn(scenario, field)) throw new Mismatch(`${name}.${field}`);
      normalized[field] = normalizeField(field, scenario[field]);
    }
    scenarios[name] = normalized;
  }
  const thresholds: Record<string, NormalizedThreshold[]> = {};
  for (const [key, items] of Object.entries(value['thresholds'])) {
    if (!Array.isArray(items)) throw new Mismatch(key);
    thresholds[key] = items.map(normalizeThreshold);
  }
  return { scenarios, thresholds };
}

/** Fields `optionsFor` declares per scenario, plus `startTime`, which is always judged. */
function declaredFields(options: K6Options): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const [name, scenario] of Object.entries(options.scenarios)) {
    fields[name] = SCENARIO_FIELDS.filter((field) => field === 'startTime' || Object.hasOwn(scenario, field));
  }
  return fields;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * `true` when the inspect output holds exactly the scenarios of `options` with every declared field equal after
 * normalizing, and the threshold keys and their expression lists are exactly the same.
 */
export function inspectMatches(inspected: unknown, options: K6Options): boolean {
  try {
    const expected = normalizeInspect(options as unknown, null);
    const fields = declaredFields(options);
    if (!isRecord(inspected) || !isRecord(inspected['scenarios'])) return false;
    const names = Object.keys(inspected['scenarios']).sort();
    if (canonical(names) !== canonical(Object.keys(expected.scenarios).sort())) return false;
    const actual = normalizeInspect(inspected, fields);
    return canonical(actual.scenarios) === canonical(expected.scenarios) && canonical(actual.thresholds) === canonical(expected.thresholds);
  } catch (error) {
    if (error instanceof Mismatch) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Redaction and the credential scan.

/** Replaces every credential value of the run with `[redacted]`, longest value first. */
export function redactor(secrets: readonly string[]): (text: string) => string {
  return (text) =>
    [...secrets].filter((secret) => secret !== '').sort((a, b) => b.length - a.length).reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
}

/** `true` when `data` holds one of the credential values. */
export function containsSecret(data: string | Uint8Array, secrets: readonly string[]): boolean {
  const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  return secrets.some((secret) => secret !== '' && buffer.includes(Buffer.from(secret)));
}

// ---------------------------------------------------------------------------------------------------------------
// The `docker stats` stream (*Pengamatan resource*): line splitting, control characters, CPU, and memory.

export type ContainerRole = 'postgres' | 'backend' | 'k6';
export const CONTAINER_ROLES: readonly ContainerRole[] = ['postgres', 'backend', 'k6'];
/** One sample of one container: host time when its line arrived, CPU in percent of one CPU, memory in MiB. */
export type ContainerSample = { t: number; cpu: number | null; memoryMiB: number | null };

/** `docker stats` for the PostgreSQL, backend, and k6 containers of the run, one JSON line per container and refresh. */
export function statsArgs(names: ResourceNames): string[] {
  return ['docker', 'stats', '--format', '{{json .}}', names.db, names.backend, names.k6];
}

const CSI = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
const CONTROL = /[\x00-\x1f\x7f]/g;

/** A line without terminal control sequences and control characters. */
export function stripControl(line: string): string {
  return line.replace(CSI, '').replace(CONTROL, '');
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** `CPUPerc` (`12.5%`) as percent of one CPU; `null` for anything else, such as `--`. */
export function parsePercent(value: unknown): number | null {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)%$/.exec(value.trim()) : null;
  return match === null ? null : Number(match[1]);
}

const MIB_PER_UNIT: Readonly<Record<string, number>> = { B: 1 / 1_048_576, KiB: 1 / 1024, MiB: 1, GiB: 1024 };

/** The first part of `MemUsage` (`4.227MiB / 7.748GiB`) in MiB from B, KiB, MiB, or GiB; `null` for anything else. */
export function parseMemoryMiB(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)$/.exec(value.split('/')[0]!.trim());
  return match === null ? null : round3(Number(match[1]) * MIB_PER_UNIT[match[2]!]!);
}

export type StatsCollector = {
  /** Starts a new stream process: a partial line left by the previous process is dropped. */
  begin: () => void;
  /** One stdout chunk and the host time it arrived; every complete line takes the time of the chunk it ends in. */
  push: (chunk: Buffer | string, receivedAtMs: number) => void;
  samples: Record<ContainerRole, ContainerSample[]>;
};

/**
 * Collects `docker stats --format '{{json .}}'` output into samples per container, matched by the `Name` field. At most
 * `limitPerSecond` samples per container and host second are kept; more lines in the same second are dropped, so
 * `observation.json` stays bounded. `onLine` sees every complete line (for the credential scan), `onSample` every kept
 * sample.
 */
export function statsCollector(
  names: Readonly<Record<ContainerRole, string>>,
  options: { limitPerSecond?: number; onLine?: (line: string) => void; onSample?: (role: ContainerRole, sample: ContainerSample) => void } = {},
): StatsCollector {
  const limit = options.limitPerSecond ?? OBSERVATION_LIMITS.samplesPerSecond;
  const roles = new Map(CONTAINER_ROLES.map((role) => [names[role], role] as const));
  const samples: Record<ContainerRole, ContainerSample[]> = { postgres: [], backend: [], k6: [] };
  const seconds: Record<ContainerRole, { second: number; count: number }> = {
    postgres: { second: -1, count: 0 },
    backend: { second: -1, count: 0 },
    k6: { second: -1, count: 0 },
  };
  let decoder = new StringDecoder('utf8');
  let pending = '';
  const line = (text: string, t: number) => {
    options.onLine?.(text);
    let value: unknown;
    try {
      value = JSON.parse(stripControl(text).trim());
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    const role = typeof value['Name'] === 'string' ? roles.get(value['Name']) : undefined;
    if (role === undefined) return;
    const second = Math.floor(t / 1000);
    const bucket = seconds[role];
    if (bucket.second !== second) {
      bucket.second = second;
      bucket.count = 0;
    }
    if (bucket.count >= limit) return;
    bucket.count += 1;
    const sample = { t, cpu: parsePercent(value['CPUPerc']), memoryMiB: parseMemoryMiB(value['MemUsage']) };
    samples[role].push(sample);
    options.onSample?.(role, sample);
  };
  return {
    begin: () => {
      decoder = new StringDecoder('utf8');
      pending = '';
    },
    push: (chunk, receivedAtMs) => {
      const parts = (pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) line(part, receivedAtMs);
    },
    samples,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The `pg_stat_activity` sampler.

/** Fixed query of the sampler, run through the admin connection; it has no input. */
export const POOL_QUERY =
  "SELECT count(*) FILTER (WHERE usename = 'foundation_backend')::int AS sessions, " +
  "count(*) FILTER (WHERE usename = 'foundation_backend' AND state <> 'idle')::int AS non_idle, " +
  "count(*)::int AS total FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend'";

export type PoolCounts = { sessions: number; nonIdle: number; total: number };
/** A successful sample with its counts, or a failed one; `t` is the host time the sample ended. */
export type PoolSample = ({ t: number } & PoolCounts) | { t: number; unavailable: true };
/** One admin `Bun.SQL` instance with `max` 1; `sample` runs `POOL_QUERY` once. */
export type PoolClient = { sample: () => Promise<PoolCounts>; close: () => Promise<void> };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The row of `POOL_QUERY`; throws unless it holds three counts. */
export function parsePoolRow(row: unknown): PoolCounts {
  if (!isRecord(row) || !isCount(row['sessions']) || !isCount(row['non_idle']) || !isCount(row['total'])) throw new Error('Unexpected pool row');
  return { sessions: row['sessions'], nonIdle: row['non_idle'], total: row['total'] };
}

const poolSucceeded = (sample: PoolSample): sample is { t: number } & PoolCounts => !('unavailable' in sample);

// ---------------------------------------------------------------------------------------------------------------
// The k6 summary (*Isi result.json*: `actual`, `latency`, `readiness`, `thresholds`).

export type ScenarioActual = {
  name: string;
  endpoint: Endpoint;
  phase: string;
  executor: string;
  startRate: number;
  endRate: number;
  seconds: number;
  plannedIterations: number;
  iterations: number;
  rate: number;
};
export type ActualLoad = {
  scenarios: ScenarioActual[];
  iterations: number;
  httpReqs: number;
  droppedIterations: number;
  vusMax: number;
  scenarioStartLateMs: number | null;
};
export type LatencyOutcome = 'all' | 'available' | 'busy' | 'unavailable';
export type LatencyRow = {
  endpoint: Endpoint;
  phase: string;
  outcome: LatencyOutcome;
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
};
export type ReadinessPhase = { phase: string; available: number; busy: number; unavailable: number; availableRatio: number | null };
export type ThresholdOutcome = { metric: string; expression: string; ok: boolean };
export type SummaryReading = {
  actual: ActualLoad;
  latency: LatencyRow[];
  readiness: { phases: ReadinessPhase[]; recoveryMs: number | null };
  thresholds: ThresholdOutcome[];
};

type SummaryMetric = { values: Record<string, unknown>; thresholds: Record<string, unknown> };

function summaryMetrics(summary: unknown): Record<string, SummaryMetric> | null {
  if (!isRecord(summary) || !isRecord(summary['metrics'])) return null;
  const metrics: Record<string, SummaryMetric> = {};
  for (const [name, metric] of Object.entries(summary['metrics'])) {
    if (!isRecord(metric)) continue;
    metrics[name] = {
      values: isRecord(metric['values']) ? metric['values'] : {},
      thresholds: isRecord(metric['thresholds']) ? metric['thresholds'] : {},
    };
  }
  return metrics;
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A Counter `count` (or a gauge `value`) from the summary; 0 when the metric is missing. */
function counter(metrics: Record<string, SummaryMetric>, name: string, field: 'count' | 'value' = 'count'): number {
  return finite(metrics[name]?.values[field]) ?? 0;
}

/** Statistics of a trend submetric; a missing submetric or one with `count` 0 has count 0 and `null` statistics. */
function trend(metrics: Record<string, SummaryMetric>, key: string): Pick<LatencyRow, 'count' | 'p50' | 'p95' | 'p99' | 'max'> {
  const values = metrics[key]?.values;
  const count = finite(values?.['count']) ?? 0;
  if (values === undefined || count === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };
  return { count, p50: finite(values['p(50)']), p95: finite(values['p(95)']), p99: finite(values['p(99)']), max: finite(values['max']) };
}

/** Phase names of a profile, in order. */
export function profilePhaseNames(profile: ProfileName): string[] {
  return phaseWindows(profile).map((phase) => phase.name);
}

/**
 * The `actual`, `latency`, `readiness`, and `thresholds` fields from `handleSummary` data. Planned rates, seconds, and
 * iterations come from `plan.ts`; the actual rate is the actual iterations divided by the planned seconds of the
 * scenario. `null` when the summary has no `metrics` object.
 */
export function readSummary(summary: unknown, profile: ProfileName, t0: number | null): SummaryReading | null {
  const metrics = summaryMetrics(summary);
  if (metrics === null) return null;
  const scenarios = plannedScenarios(profile).map((planned) => {
    const iterations = counter(metrics, `iterations{scenario:${planned.name}}`);
    return {
      name: planned.name,
      endpoint: planned.endpoint,
      phase: planned.phase,
      executor: planned.executor,
      startRate: planned.startRate,
      endRate: planned.endRate,
      seconds: planned.seconds,
      plannedIterations: planned.plannedIterations,
      iterations,
      rate: iterations / planned.seconds,
    };
  });
  const setup = isRecord(summary) && isRecord(summary['setup_data']) ? summary['setup_data'] : null;
  const startedAt = finite(setup?.['startedAt']);
  const actual: ActualLoad = {
    scenarios,
    iterations: counter(metrics, 'iterations'),
    httpReqs: counter(metrics, 'http_reqs'),
    droppedIterations: counter(metrics, 'dropped_iterations'),
    vusMax: counter(metrics, 'vus_max', 'value'),
    scenarioStartLateMs: startedAt === null || t0 === null ? null : startedAt - t0,
  };
  const latency: LatencyRow[] = [];
  const phases: ReadinessPhase[] = [];
  for (const phase of profilePhaseNames(profile)) {
    latency.push({ endpoint: 'status', phase, outcome: 'all', ...trend(metrics, statusLatencyKey(phase)) });
    const counts = { available: 0, busy: 0, unavailable: 0 };
    for (const outcome of ['available', 'busy', 'unavailable'] as const) {
      const row = trend(metrics, readinessKey(`readiness_${outcome}_duration`, phase));
      latency.push({ endpoint: 'readiness', phase, outcome, ...row });
      counts[outcome] = row.count;
    }
    const total = counts.available + counts.busy + counts.unavailable;
    phases.push({ phase, ...counts, availableRatio: total === 0 ? null : counts.available / total });
  }
  const recovery = trend(metrics, 'readiness_recovery_ms');
  const recoveryMin = finite(metrics['readiness_recovery_ms']?.values['min']);
  const order = Object.keys(optionsFor(profile).thresholds);
  const keys = [...order.filter((key) => metrics[key] !== undefined), ...Object.keys(metrics).filter((key) => !order.includes(key)).sort()];
  const thresholds = keys.flatMap((metric) =>
    Object.entries(metrics[metric]!.thresholds).map(([expression, outcome]) => ({ metric, expression, ok: isRecord(outcome) && outcome['ok'] === true })),
  );
  return {
    actual,
    latency,
    readiness: { phases, recoveryMs: profile === 'outage' && recovery.count > 0 ? recoveryMin : null },
    thresholds,
  };
}

/** `phase_start_late` and `iteration_request_mismatch` from a summary reading, in that order. */
export function summaryReasons(reading: SummaryReading, limits: Pick<ObservationLimits, 'phaseStartLateMs'> = OBSERVATION_LIMITS): Reason[] {
  const reasons: Reason[] = [];
  const late = reading.actual.scenarioStartLateMs;
  if (late !== null && late > limits.phaseStartLateMs) reasons.push(reason('phase_start_late', String(late)));
  if (reading.actual.httpReqs !== reading.actual.iterations) {
    reasons.push(reason('iteration_request_mismatch', `${reading.actual.httpReqs}/${reading.actual.iterations}`));
  }
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// Observation checks (*Pengamatan resource*).

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ObservationCheckName =
  | 'backend_running'
  | 'backend_output'
  | 'backend_memory_peak'
  | 'backend_cpu_mean'
  | 'backend_memory_growth'
  | 'pool_sessions'
  | 'pool_non_idle'
  | 'pool_reconnect'
  | 'generator_cpu'
  | 'generator_memory'
  | 'observation_coverage'
  | 'clock_offset'
  | 'outage_control';
export type ObservationCheck = { name: ObservationCheckName; rule: string; actual: JsonValue; ok: boolean };
export type BackendState = { running: boolean; restarts: number; oomKilled: boolean };
/** Outage control times relative to T0 (ms); `null` for a command that was not sent or did not finish. */
export type OutageTiming = {
  stopPlannedMs: number;
  stopIssuedMs: number | null;
  stopCompletedMs: number | null;
  startPlannedMs: number;
  startIssuedMs: number | null;
  startCompletedMs: number | null;
};
export type ObservationInput = {
  profile: ProfileName;
  t0: number;
  /** Phase windows in host epoch ms, from `observedPhases(profile, t0)` on a run. */
  phases: readonly ObservedPhase[];
  containers: Readonly<Record<ContainerRole, readonly ContainerSample[]>>;
  pool: readonly PoolSample[];
  backendState: BackendState | null;
  backendLogs: { stdout: string; stderrBytes: number } | null;
  clockOffsetMs: { before: number | null; after: number | null };
  outage: OutageTiming | null;
};

/** `docker container inspect` of the backend state (`true 0 false`); `null` for anything else. */
export function parseBackendState(stdout: string): BackendState | null {
  const match = /^(true|false) (\d+) (true|false)$/.exec(stdout.trim());
  return match === null ? null : { running: match[1] === 'true', restarts: Number(match[2]), oomKilled: match[3] === 'true' };
}

/** A phase window in host epoch ms. */
export type ObservedPhase = { name: string; start: number; end: number; target: PhaseTarget };

/** Phase windows of the profile from T0 and the durations of the plan; a phase with a target is measured. */
export function observedPhases(profile: ProfileName, t0: number): ObservedPhase[] {
  return phaseWindows(profile).map((phase) => ({ name: phase.name, start: t0 + phase.fromMs, end: t0 + phase.toMs, target: phase.target }));
}

const OUTAGE_EDGE = ['stopping', 'outage', 'recovering'];
const numericSample = (sample: ContainerSample) => sample.cpu !== null && sample.memoryMiB !== null;
const within = (t: number, start: number, end: number) => t >= start && t <= end;
const mean = (values: readonly number[]) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const highest = (values: readonly number[]) => (values.length === 0 ? null : values.reduce((top, value) => (value > top ? value : top), -Infinity));
const round2 = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);

function sampleValues(samples: readonly ContainerSample[], field: 'cpu' | 'memoryMiB', start = -Infinity, end = Infinity): number[] {
  return samples.filter((sample) => sample[field] !== null && within(sample.t, start, end)).map((sample) => sample[field]!);
}

/** The largest gap in `start`, the sample times, then `end` (the edge gaps count). */
function largestGap(start: number, times: readonly number[], end: number): number {
  const sequence = [start, ...[...times].sort((a, b) => a - b), end];
  let gap = 0;
  for (let index = 1; index < sequence.length; index += 1) gap = Math.max(gap, sequence[index]! - sequence[index - 1]!);
  return gap;
}

/** Coverage failures: per container and measured phase, then the `pg_stat_activity` gaps; empty when complete. */
export function coverageFailures(input: ObservationInput, limits: ObservationLimits = OBSERVATION_LIMITS): string[] {
  const phases = input.phases;
  const failures: string[] = [];
  for (const phase of phases.filter((item) => item.target !== null)) {
    for (const role of CONTAINER_ROLES) {
      if (role === 'postgres' && input.profile === 'outage' && OUTAGE_EDGE.includes(phase.name)) continue;
      const times = input.containers[role].filter((sample) => numericSample(sample) && within(sample.t, phase.start, phase.end)).map((sample) => sample.t);
      const needed = Math.floor((phase.end - phase.start) / 1000 / limits.coverageSecondsPerSample);
      if (times.length < needed) failures.push(`${role} ${phase.name}: ${times.length} sampel, minimal ${needed}`);
      const gap = largestGap(phase.start, times, phase.end);
      if (gap > limits.coverageGapMs) failures.push(`${role} ${phase.name}: celah ${gap} ms`);
    }
  }
  const end = phases.at(-1)?.end ?? input.t0;
  const excluded = input.profile === 'outage' ? phases.filter((phase) => OUTAGE_EDGE.includes(phase.name)) : [];
  const [from, to] = excluded.length === 0 ? [null, null] : [excluded[0]!.start, excluded.at(-1)!.end];
  const times = input.pool.filter((sample) => poolSucceeded(sample) && within(sample.t, input.t0, end)).map((sample) => sample.t);
  const sequence = [input.t0, ...times.sort((a, b) => a - b), end];
  for (let index = 1; index < sequence.length; index += 1) {
    const [a, b] = [sequence[index - 1]!, sequence[index]!];
    if (b - a <= limits.poolGapMs) continue;
    if (from !== null && to !== null && a <= to && b >= from) continue;
    failures.push(`pg_stat_activity: celah ${b - a} ms`);
  }
  return failures;
}

/** Which outage controls missed their window: sent early, sent more than 1000 ms late, or done too slowly. */
export function outageControlFailures(timing: OutageTiming | null, limits: ObservationLimits = OBSERVATION_LIMITS): ('stop' | 'start')[] {
  if (timing === null) return ['stop', 'start'];
  const late = (planned: number, issued: number | null, completed: number | null, doneMs: number) =>
    issued === null || completed === null || issued < planned || issued > planned + limits.outageSendLateMs || completed - issued > doneMs;
  const failures: ('stop' | 'start')[] = [];
  if (late(timing.stopPlannedMs, timing.stopIssuedMs, timing.stopCompletedMs, limits.outageStopDoneMs)) failures.push('stop');
  if (late(timing.startPlannedMs, timing.startIssuedMs, timing.startCompletedMs, limits.outageStartDoneMs)) failures.push('start');
  return failures;
}

/** The soak memory growth of the backend in MiB, or `null` without samples in either window. */
export function memoryGrowthMiB(input: ObservationInput, limits: ObservationLimits = OBSERVATION_LIMITS): number | null {
  const steady = input.phases.find((phase) => phase.name === 'steady');
  if (steady === undefined) return null;
  const backend = input.containers.backend;
  const early = mean(sampleValues(backend, 'memoryMiB', steady.start + limits.growthEarlyFromMs, steady.start + limits.growthEarlyToMs));
  const late = mean(sampleValues(backend, 'memoryMiB', steady.end - limits.growthLateMs, steady.end));
  return early === null || late === null ? null : late - early;
}

/**
 * Every check of *Pengamatan resource* that applies to the profile, in table order. A check without the data it needs
 * fails, so a missing observation is never taken as a pass.
 */
export function observationChecks(input: ObservationInput, limits: ObservationLimits = OBSERVATION_LIMITS): ObservationCheck[] {
  const { profile } = input;
  const phases = input.phases;
  const measured = phases.filter((phase) => phase.target !== null);
  const checks: ObservationCheck[] = [];
  const add = (name: ObservationCheckName, rule: string, actual: JsonValue, ok: boolean) => checks.push({ name, rule, actual, ok });

  const state = input.backendState;
  add(
    'backend_running',
    'sesudah k6 keluar, backend berjalan, RestartCount 0, dan tidak OOMKilled',
    state === null ? null : { running: state.running, restarts: state.restarts, oomKilled: state.oomKilled },
    state !== null && state.running && state.restarts === 0 && !state.oomKilled,
  );
  const logs = input.backendLogs;
  add(
    'backend_output',
    'stderr 0 byte; stdout tepat baris listening lalu Backend stopped',
    logs === null ? null : { stderrBytes: logs.stderrBytes, stdoutExpected: logs.stdout === EXPECTED_BACKEND_STDOUT },
    logs !== null && logs.stderrBytes === 0 && logs.stdout === EXPECTED_BACKEND_STDOUT,
  );
  const backendPeak = highest(sampleValues(input.containers.backend, 'memoryMiB'));
  add('backend_memory_peak', `memory backend maksimum <= ${limits.backendMemoryPeakMiB} MiB`, round2(backendPeak), backendPeak !== null && backendPeak <= limits.backendMemoryPeakMiB);
  if (profile === 'load' || profile === 'soak') {
    const steady = phases.find((phase) => phase.name === 'steady');
    const cpu = steady === undefined ? null : mean(sampleValues(input.containers.backend, 'cpu', steady.start, steady.end));
    add('backend_cpu_mean', `rata rata CPU backend pada steady <= ${limits.backendCpuMean} persen satu CPU`, round2(cpu), cpu !== null && cpu <= limits.backendCpuMean);
  }
  if (profile === 'soak') {
    const growth = memoryGrowthMiB(input, limits);
    add('backend_memory_growth', `pertumbuhan memory backend pada steady <= ${limits.backendMemoryGrowthMiB} MiB`, round2(growth), growth !== null && growth <= limits.backendMemoryGrowthMiB);
  }
  const pool = input.pool.filter(poolSucceeded);
  const sessions = highest(pool.map((sample) => sample.sessions));
  const nonIdle = highest(pool.map((sample) => sample.nonIdle));
  add('pool_sessions', `setiap sampel mencatat paling banyak ${limits.poolSessions} sesi foundation_backend`, sessions, sessions !== null && sessions <= limits.poolSessions);
  add('pool_non_idle', `setiap sampel mencatat paling banyak ${limits.poolNonIdle} sesi foundation_backend yang tidak idle`, nonIdle, nonIdle !== null && nonIdle <= limits.poolNonIdle);
  if (profile === 'outage') {
    const after = phases.find((phase) => phase.name === 'after');
    const reconnected = after === undefined ? 0 : pool.filter((sample) => within(sample.t, after.start, after.end) && sample.sessions >= 1).length;
    add('pool_reconnect', 'sedikitnya satu sampel pada fase after dengan sesi foundation_backend', reconnected, reconnected > 0);
  }
  const generatorMeans = measured.map((phase) => mean(sampleValues(input.containers.k6, 'cpu', phase.start, phase.end)));
  const generatorCpu = generatorMeans.some((value) => value === null) ? null : highest(generatorMeans as number[]);
  add('generator_cpu', `rata rata CPU k6 pada setiap fase terukur <= ${limits.generatorCpu} persen satu CPU`, round2(generatorCpu), generatorCpu !== null && generatorCpu <= limits.generatorCpu);
  const generatorMemory = highest(sampleValues(input.containers.k6, 'memoryMiB'));
  add('generator_memory', `memory k6 maksimum <= ${limits.generatorMemoryMiB} MiB`, round2(generatorMemory), generatorMemory !== null && generatorMemory <= limits.generatorMemoryMiB);
  const coverage = coverageFailures(input, limits);
  add('observation_coverage', 'sampel cukup dan celah dalam batas pada setiap container dan fase terukur, serta pada pg_stat_activity', coverage, coverage.length === 0);
  const { before, after } = input.clockOffsetMs;
  const offsets = before === null || after === null ? null : Math.max(Math.abs(before), Math.abs(after));
  add('clock_offset', `selisih jam container dengan host <= ${limits.clockOffsetMs} ms sebelum T0 dan sesudah k6 keluar`, { before, after }, offsets !== null && offsets <= limits.clockOffsetMs);
  if (profile === 'outage') {
    const timing = input.outage;
    add(
      'outage_control',
      'stop dan start dikirim tidak lebih awal dari jadwal dan paling lambat 1000 ms sesudahnya; stop selesai <= 8000 ms, start <= 5000 ms',
      timing === null ? null : { ...timing },
      outageControlFailures(timing, limits).length === 0,
    );
  }
  return checks;
}

/** Reasons of the failed checks: `generator_saturated` for the generator, `outage_control_late` per control, otherwise `observation_failed`. */
export function observationReasons(checks: readonly ObservationCheck[], outage: OutageTiming | null, limits: ObservationLimits = OBSERVATION_LIMITS): Reason[] {
  return checks
    .filter((check) => !check.ok)
    .flatMap((check) => {
      if (check.name === 'generator_cpu' || check.name === 'generator_memory') return [reason('generator_saturated', check.name)];
      if (check.name === 'outage_control') return outageControlFailures(outage, limits).map((part) => reason('outage_control_late', part));
      return [reason('observation_failed', check.name)];
    });
}

export type ContainerObservation = {
  cpuMean: number | null;
  cpuMax: number | null;
  memoryMeanMiB: number | null;
  memoryMaxMiB: number | null;
  memoryGrowthMiB: number | null;
  restarts: number | null;
  oomKilled: boolean | null;
  stderrBytes: number | null;
};
export type ResultObservation = {
  containers: Record<ContainerRole, ContainerObservation>;
  pool: { sessions: number | null; nonIdle: number | null; total: number | null; samples: number; failedSamples: number };
  checks: ObservationCheck[];
};

/**
 * The `observation` field: per container the mean (from T0 to the end of the last phase) and the maximum (every sample
 * of the run) of CPU and memory, the backend state and stderr size, the pool maxima and sample counts, and the checks.
 */
export function observationSummary(input: ObservationInput, checks: ObservationCheck[], limits: ObservationLimits = OBSERVATION_LIMITS): ResultObservation {
  const end = input.phases.at(-1)?.end ?? input.t0;
  const container = (role: ContainerRole): ContainerObservation => {
    const samples = input.containers[role];
    const backend = role === 'backend';
    return {
      cpuMean: round2(mean(sampleValues(samples, 'cpu', input.t0, end))),
      cpuMax: round2(highest(sampleValues(samples, 'cpu'))),
      memoryMeanMiB: round2(mean(sampleValues(samples, 'memoryMiB', input.t0, end))),
      memoryMaxMiB: round2(highest(sampleValues(samples, 'memoryMiB'))),
      memoryGrowthMiB: backend && input.profile === 'soak' ? round2(memoryGrowthMiB(input, limits)) : null,
      restarts: backend ? (input.backendState?.restarts ?? null) : null,
      oomKilled: backend ? (input.backendState?.oomKilled ?? null) : null,
      stderrBytes: backend ? (input.backendLogs?.stderrBytes ?? null) : null,
    };
  };
  const pool = input.pool.filter(poolSucceeded);
  return {
    containers: { postgres: container('postgres'), backend: container('backend'), k6: container('k6') },
    pool: {
      sessions: highest(pool.map((sample) => sample.sessions)),
      nonIdle: highest(pool.map((sample) => sample.nonIdle)),
      total: highest(pool.map((sample) => sample.total)),
      samples: pool.length,
      failedSamples: input.pool.length - pool.length,
    },
    checks,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Outage control (AC-7): `docker stop --time 10` of PostgreSQL at T0 + 90 s and `docker start` at T0 + 150 s.

export type OutageCommand = 'stop' | 'start';

/** The two outage commands, on the PostgreSQL container of the run only. */
export function outageControlArgs(command: OutageCommand, name: string): string[] {
  return command === 'stop' ? ['docker', 'stop', '--time', '10', name] : ['docker', 'start', name];
}

/**
 * The guard of a command starts this long before its schedule, so a guard inspect that runs up to its own limit
 * (`TIMEOUTS.guardInspect`) still ends before the command is due.
 */
export const OUTAGE_GUARD_LEAD_MS = TIMEOUTS.guardInspect;

/** Outage timing before any command: the schedule relative to T0, nothing sent yet. */
export function plannedOutage(): OutageTiming {
  return { stopPlannedMs: OUTAGE_STOP_MS, stopIssuedMs: null, stopCompletedMs: null, startPlannedMs: OUTAGE_START_MS, startIssuedMs: null, startCompletedMs: null };
}

export type OutageControlDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The container guard on the PostgreSQL container of the run; `true` when it passes. */
  guard: (command: OutageCommand) => Promise<boolean>;
  /** Sends the command and resolves when it ends; `true` when it succeeded. */
  send: (command: OutageCommand) => Promise<boolean>;
  /** Aborted once k6 has exited or the run is stopped: no command is sent from then on. */
  ended: AbortSignal;
};

/**
 * Stop, then start, each only after the guard passed and never before its schedule by the host clock: the guard runs
 * `OUTAGE_GUARD_LEAD_MS` before the schedule, then the send waits until the host clock reaches it. `timing` gets the
 * send and end times relative to T0. A command that is not sent keeps `null` times and one that fails keeps a `null`
 * end time, so `outage_control` fails; after a guard refusal or a failed stop, start is not sent. Waits are at most
 * 1000 ms each, so an early end never leaves a long timer behind.
 */
export async function runOutageControl(t0: number, timing: OutageTiming, deps: OutageControlDeps): Promise<void> {
  const ended = new Promise<void>((done) => {
    if (deps.ended.aborted) done();
    else deps.ended.addEventListener('abort', () => done(), { once: true });
  });
  const waitUntil = async (at: number): Promise<boolean> => {
    for (let remaining = at - deps.now(); remaining > 0 && !deps.ended.aborted; remaining = at - deps.now()) {
      await Promise.race([deps.sleep(Math.min(remaining, 1_000)), ended]);
    }
    return !deps.ended.aborted;
  };
  for (const command of ['stop', 'start'] as const) {
    const planned = t0 + (command === 'stop' ? timing.stopPlannedMs : timing.startPlannedMs);
    if (!(await waitUntil(planned - OUTAGE_GUARD_LEAD_MS))) return;
    if (!(await deps.guard(command))) return;
    if (!(await waitUntil(planned))) return;
    const issued = deps.now() - t0;
    if (command === 'stop') timing.stopIssuedMs = issued;
    else timing.startIssuedMs = issued;
    const succeeded = await deps.send(command);
    if (!succeeded) return;
    const completed = deps.now() - t0;
    if (command === 'stop') timing.stopCompletedMs = completed;
    else timing.startCompletedMs = completed;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Environment and *Batas bukti*.

export type EnvironmentBlock = {
  os: string;
  arch: string;
  cpuModel: string | null;
  cpuCount: number;
  memoryBytes: number;
  containerEngine: { serverVersion: string | null; os: string | null; ncpu: number | null; memTotal: number | null };
  otherContainersRunning: number | null;
  ci: boolean;
  images: {
    k6: string | null;
    bun: string | null;
    postgres: { image: string; imageId: string | null; baseImage: string | null; serverVersion: string | null };
  };
  limits: typeof CONTAINER_LIMITS;
  pool: typeof BACKEND_POOL;
  data: { appliedMigrations: number | null };
  clockOffsetMs: { before: number | null; after: number | null };
};

/** The `environment` block with the host values of `node:os` and every value the run has not read yet as `null`. */
export function hostEnvironment(env: Readonly<Record<string, string | undefined>>): EnvironmentBlock {
  return {
    os: `${osType()} ${release()}`,
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? null,
    cpuCount: availableParallelism(),
    memoryBytes: totalmem(),
    containerEngine: { serverVersion: null, os: null, ncpu: null, memTotal: null },
    otherContainersRunning: null,
    ci: env['CI'] !== undefined,
    images: { k6: null, bun: null, postgres: { image: POSTGRES_IMAGE, imageId: null, baseImage: null, serverVersion: null } },
    limits: CONTAINER_LIMITS,
    pool: BACKEND_POOL,
    data: { appliedMigrations: null },
    clockOffsetMs: { before: null, after: null },
  };
}

/** *Batas bukti*, written as is in `result.json` with the migration count filled in. */
export function evidenceLimits(appliedMigrations: number): string[] {
  return [
    'Alur yang diukur adalah diagnostik komposisi development, `GET /api/status` dan `GET /api/readiness`; komposisi production tidak memasang route apa pun dan belum ada endpoint bisnis.',
    'Backend berjalan sebagai satu container dengan 1 CPU dan 512 MiB dari image Bun slim dengan source yang di mount, bukan image deployment fitur 13.',
    'k6 dan backend berbagi network namespace loopback; tidak ada reverse proxy, TLS, atau latency jaringan nyata.',
    `Data hanya riwayat migration (${appliedMigrations} baris); tidak ada tabel bisnis.`,
    'Mesin dipakai bersama (Docker Desktop di macOS bersama container lain, atau runner GitHub hosted); hasil hanya sebanding dengan run pada kelas environment yang sama.',
    'Batas kapasitas (breakpoint) tidak dicari; hasil membuktikan beban yang disepakati, bukan titik jenuh.',
  ];
}

/** `docker ps` lines `<name> <foundation.test> <foundation.run>` of containers that do not belong to the run `hex`. */
export function otherTestContainers(stdout: string, hex: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
    .map((line) => ({ shown: line.slice(0, Math.max(0, line.lastIndexOf(' '))).trim(), run: line.slice(line.lastIndexOf(' ') + 1).trim() }))
    .filter((line) => line.run !== hex)
    .map((line) => line.shown);
}

// ---------------------------------------------------------------------------------------------------------------
// `result.json` and `observation.json`.

export type PerformanceResult = {
  schema: 1;
  profile: ProfileName;
  status: 'passed' | 'failed';
  reasons: Reason[];
  startedAt: string;
  finishedAt: string;
  t0: number | null;
  model: ReturnType<typeof profileModel>;
  actual: ActualLoad | null;
  latency: LatencyRow[] | null;
  readiness: SummaryReading['readiness'] | null;
  thresholds: ThresholdOutcome[] | null;
  observation: ResultObservation | null;
  outage: OutageTiming | null;
  environment: EnvironmentBlock;
  limits: string[] | null;
};

/** `model`: the load per phase, the ordered phases with shape, duration, and rate per endpoint. */
export function profileModel(profile: ProfileName) {
  let previous: keyof typeof LOADS | null = null;
  const phases = profilePlan(profile).phases.map((phase) => {
    const rates = Object.fromEntries(
      ENDPOINTS.map((endpoint) => {
        const end = LOADS[phase.load][endpoint];
        const start = phase.shape === 'constant' ? end : previous === null ? 0 : LOADS[previous][endpoint];
        return [endpoint, { startRate: start, endRate: end }];
      }),
    );
    previous = phase.load;
    return { phase: phase.name, shape: phase.shape, seconds: phase.seconds, load: phase.load, rates };
  });
  return { iterationIsOneRequest: true as const, phases };
}

/**
 * `result.json` (*Isi result.json*). `reading` is `null` when `summary.json` is missing, so `actual`, `latency`,
 * `readiness`, and `thresholds` are `null`; `observation` is `null` when k6 never ran; `limits` is `null` only when the
 * migration count is unknown.
 */
export function buildResult(input: {
  profile: ProfileName;
  reasons: readonly Reason[];
  startedAt: string;
  finishedAt: string;
  t0: number | null;
  reading?: SummaryReading | null;
  observation?: ResultObservation | null;
  outage?: OutageTiming | null;
  environment?: EnvironmentBlock;
  appliedMigrations?: number | null;
}): PerformanceResult {
  const appliedMigrations = input.appliedMigrations ?? null;
  return {
    schema: 1,
    profile: input.profile,
    status: input.reasons.length === 0 ? 'passed' : 'failed',
    reasons: input.reasons.map((item) => reason(item.code, item.detail)),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    t0: input.t0,
    model: profileModel(input.profile),
    actual: input.reading?.actual ?? null,
    latency: input.reading?.latency ?? null,
    readiness: input.reading?.readiness ?? null,
    thresholds: input.reading?.thresholds ?? null,
    observation: input.observation ?? null,
    outage: input.outage ?? null,
    environment: input.environment ?? hostEnvironment({}),
    limits: appliedMigrations === null ? null : evidenceLimits(appliedMigrations),
  };
}

export type ObservationFile = {
  schema: 1;
  profile: ProfileName;
  t0: number | null;
  phases: (ObservedPhase & { measured: boolean })[];
  samples: { containers: Record<ContainerRole, ContainerSample[]>; postgres: PoolSample[] };
};

/** `observation.json`: the phase windows in host epoch ms and every kept sample. */
export function buildObservationFile(
  profile: ProfileName,
  t0: number | null,
  containers: Record<ContainerRole, ContainerSample[]>,
  postgres: PoolSample[],
): ObservationFile {
  const phases = t0 === null ? [] : observedPhases(profile, t0).map((phase) => ({ ...phase, measured: phase.target !== null }));
  return { schema: 1, profile, t0, phases, samples: { containers, postgres } };
}

// ---------------------------------------------------------------------------------------------------------------
// Run.

export type HandledSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';
export const SIGNAL_EXIT_CODES: Readonly<Record<HandledSignal, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export type CommandRunner = (argv: readonly string[], options: ProcessGroupOptions) => Promise<ProcessGroupResult>;

export type RunDeps = {
  /** Checkout root: source of the mounts, the pin files, and the evidence folder `.local/feature-12/<profile>/`. */
  root: string;
  /** Command runner: `runProcessGroup` or a stand in. */
  run: CommandRunner;
  /** `database/provision.ts --apply` and `database/migrate.ts --apply` with an allow list environment. */
  provision: (env: Record<string, string>, signal: AbortSignal) => Promise<ProcessGroupResult>;
  migrate: (env: Record<string, string>, signal: AbortSignal) => Promise<ProcessGroupResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Aborted by the signal handlers; `reason` is the signal name. */
  signal: AbortSignal;
  /** One admin `SELECT 1` attempt; `Bun.SQL` by default. */
  selectOne?: (url: string, timeoutMs: number) => Promise<boolean>;
  /** One admin instance for the `pg_stat_activity` sampler; `Bun.SQL` with `max` 1 and a 1 s connection timeout by default. */
  poolClient?: (url: string) => PoolClient;
  /** `SHOW server_version` through the admin connection, `null` on failure; `Bun.SQL` by default. */
  serverVersion?: (url: string, timeoutMs: number) => Promise<string | null>;
  /** A free loopback port; a `node:net` server on port 0 by default. */
  freePort?: () => Promise<number>;
  /** Environment of this process, the source of the command allow list. */
  env?: Readonly<Record<string, string | undefined>>;
  uid?: number;
  gid?: number;
  /** Hands the k6 output folder to 65534:65534 when the host UID is 0; `node:fs` `chown` by default. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

class Stop extends Error {}

async function defaultSelectOne(url: string, timeoutMs: number): Promise<boolean> {
  const probe = new SQL({ url, max: 1, connectionTimeout: Math.max(1, Math.ceil(timeoutMs / 1_000)) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe`SELECT 1`,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    await probe.close({ timeout: 0 }).catch(() => undefined);
  }
}

/** `promise` within `ms`; `null` when it rejects or the limit passes first. The timer never outlives the wait. */
async function withinLimit<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.catch(() => null), new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function defaultPoolClient(url: string): PoolClient {
  const sql = new SQL({ url, max: 1, connectionTimeout: TIMEOUTS.poolConnectionTimeoutSeconds });
  return {
    // POOL_QUERY is a constant without input.
    sample: async () => parsePoolRow(((await sql.unsafe(POOL_QUERY)) as unknown[])[0]),
    close: () => sql.close({ timeout: 0 }).catch(() => undefined),
  };
}

async function defaultServerVersion(url: string, timeoutMs: number): Promise<string | null> {
  const sql = new SQL({ url, max: 1, connectionTimeout: Math.max(1, Math.ceil(timeoutMs / 1_000)) });
  try {
    const rows = await withinLimit(Promise.resolve(sql`SHOW server_version`), timeoutMs);
    const row = Array.isArray(rows) ? (rows[0] as unknown) : undefined;
    return isRecord(row) && typeof row['server_version'] === 'string' ? row['server_version'] : null;
  } finally {
    await sql.close({ timeout: 0 }).catch(() => undefined);
  }
}

async function defaultFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('No free loopback port');
  return address.port;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The JSON string printed by a `--format '{{json .X}}'` query; `null` for anything else. */
function jsonString(stdout: string | null): string | null {
  const value = parseJson(stdout === null ? null : stdout.trim());
  return typeof value === 'string' && value !== '' ? value : null;
}

const lineCount = (stdout: string) => stdout.split('\n').filter((line) => line.trim() !== '').length;

/** Waits at most `ms` and never holds the event loop open after `promise` settles; a rejection counts as settled. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise.catch(() => undefined), new Promise<void>((done) => (timer = setTimeout(done, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function signalName(signal: AbortSignal): HandledSignal | null {
  const value = signal.reason as unknown;
  return value === 'SIGHUP' || value === 'SIGINT' || value === 'SIGTERM' ? value : null;
}

type Created = { network: boolean; db: boolean; backend: boolean; k6: boolean; inspect: boolean };

type Context = {
  deps: RunDeps;
  profile: ProfileName;
  hex: string;
  names: ResourceNames;
  dockerEnv: Record<string, string>;
  uid: number;
  gid: number;
  secrets: string[];
  redact: (text: string) => string;
  reasons: Reason[];
  /** Output of every command per label, for the credential scan; never printed. */
  outputs: Map<string, string>;
  created: Created;
  tempDir: string | null;
  /** The running step, the `setup_failed` detail when that step throws an unexpected error. */
  step: SetupStep;
  log: (line: string) => void;
  error: (line: string) => void;
  t0: number | null;
  /** The `environment` block, filled in as the run reads each value. */
  environment: EnvironmentBlock;
  /** The `docker stats` stream and the `pg_stat_activity` sampler, from just before k6 starts. */
  observation: RunObservation | null;
  /** True once `docker start -a` of k6 was sent; the observation checks are judged only then. */
  k6Started: boolean;
  backendState: BackendState | null;
  backendLogs: { stdout: string; stderrBytes: number } | null;
  reading: SummaryReading | null;
  resultObservation: ResultObservation | null;
  /** Outage control times; `null` on every profile until the outage profile starts its control next to k6. */
  outage: OutageTiming | null;
  /** The outage control of the outage profile, from just before k6 starts. */
  outageControl: { stop: (limitMs: number) => Promise<void> } | null;
};

type RunObservation = {
  collector: StatsCollector;
  pool: PoolSample[];
  /** Number of `docker stats` processes started (the first one plus restarts). */
  processes: () => number;
  /** True once the stream gave its first sample; false when it ended, the run was aborted, or T0 came first. */
  started: (t0: number) => Promise<boolean>;
  /** Stops the stream and the sampler, waiting at most 5 seconds; safe to call more than once. */
  stop: () => Promise<void>;
};

function record(context: Context, label: string, result: ProcessGroupResult | undefined): void {
  if (result === undefined) return;
  context.outputs.set(label, (context.outputs.get(label) ?? '') + result.stdout + result.stderr);
}

function fail(context: Context, code: PerformanceReasonCode, detail: string | null = null): never {
  context.reasons.push(reason(code, detail));
  throw new Stop(code);
}

function stopIfAborted(context: Context): void {
  if (context.deps.signal.aborted) throw new Stop('signal');
}

/** One command through `deps.run` with the allow list environment; a signal aborts it when `abortable`. */
async function call(
  context: Context,
  label: string,
  argv: string[],
  timeoutMs: number,
  options: { abortable?: boolean; outputLimitBytes?: number } = {},
): Promise<ProcessGroupResult> {
  const abortable = options.abortable ?? true;
  if (abortable) stopIfAborted(context);
  let result: ProcessGroupResult | undefined;
  try {
    result = await context.deps.run(argv, {
      cwd: context.deps.root,
      env: context.dockerEnv,
      timeoutMs,
      output: 'pipe',
      graceMs: TIMEOUTS.cancelGrace,
      ...(abortable ? { signal: context.deps.signal } : {}),
      ...(options.outputLimitBytes === undefined ? {} : { outputLimitBytes: options.outputLimitBytes }),
    });
  } catch {
    result = { code: null, timedOut: false, aborted: false, stdout: '', stderr: '' };
  }
  record(context, label, result);
  if (abortable && (result.aborted || context.deps.signal.aborted)) throw new Stop('signal');
  return result;
}

const succeeded = (result: ProcessGroupResult) => result.code === 0 && !result.timedOut && !result.aborted;

/**
 * The container guard on a resource of the run: (1) the name, (2) the label inspect, (3) the labels. `missing` when the
 * inspect answers the resource is gone; `failed` when the guard refuses or the inspect fails.
 */
async function guardCheck(context: Context, kind: 'container' | 'network', name: string, abortable: boolean): Promise<'passed' | 'missing' | 'failed'> {
  if (!guardNameAccepted(name, context.names)) return 'failed';
  const inspected = await call(context, 'guard inspect', guardInspectArgs(kind, name), TIMEOUTS.guardInspect, { abortable });
  if (!succeeded(inspected)) return resourceMissing(kind, name, inspected.code, inspected.stderr) ? 'missing' : 'failed';
  return guardLabelsAccepted(parseJson(inspected.stdout), context.hex) ? 'passed' : 'failed';
}

/**
 * An action on a container or network of the run through the guard: name, label inspect, then the action. `missing`
 * when the inspect answers the resource is gone; `failed` when the guard refuses or the action fails.
 */
async function guarded(
  context: Context,
  kind: 'container' | 'network',
  name: string,
  action: string[],
  timeoutMs: number,
  abortable: boolean,
): Promise<'done' | 'missing' | 'failed'> {
  const guard = await guardCheck(context, kind, name, abortable);
  if (guard !== 'passed') return guard;
  const done = await call(context, `${action[1]} ${action[2]}`, action, timeoutMs, { abortable });
  return succeeded(done) ? 'done' : 'failed';
}

async function temporaryFolder(context: Context): Promise<string> {
  context.tempDir ??= await mkdtemp(join(tmpdir(), 'foundation-perf-'));
  return context.tempDir;
}

function secret(context: Context): string {
  const value = randomBytes(24).toString('hex');
  context.secrets.push(value);
  return value;
}

/** Pre-run checks (2) to (7), then k6 inspect on smoke. */
async function prepare(context: Context): Promise<ContainerContext> {
  const { root } = context.deps;
  const manifest = parseJson(await readText(join(root, 'package.json')));
  const engines = isRecord(manifest) && isRecord(manifest['engines']) ? manifest['engines']['bun'] : undefined;
  const pins = validateImagePins(await readText(join(root, IMAGES_PATH)), engines);
  if (!pins.ok) fail(context, 'pin_invalid', pins.detail);
  const containers: ContainerContext = { root, hex: context.hex, uid: context.uid, gid: context.gid, pins: pins.pins };
  context.environment.images.k6 = pins.pins.k6;
  context.environment.images.bun = pins.pins.bun;

  const envFile = await findEnvFile(root);
  if (envFile !== null) fail(context, 'env_file_present', envFile);

  const info = await call(context, 'engine info', ['docker', 'info', '--format', '{{json .NCPU}} {{json .MemTotal}}'], TIMEOUTS.daemonQuery);
  const size = succeeded(info) ? parseEngineSize(info.stdout) : null;
  if (size === null) fail(context, 'setup_failed', 'environment_read');
  context.environment.containerEngine.ncpu = size.ncpu;
  context.environment.containerEngine.memTotal = size.memTotal;
  const small = environmentTooSmall(size.ncpu, size.memTotal);
  if (small !== null) {
    context.error(`performance ${context.profile}: mesin container melihat ${size.ncpu} CPU dan ${size.memTotal} byte; minimal ${MIN_NCPU} CPU dan ${MIN_MEMORY_BYTES} byte (4 GiB)`);
    fail(context, 'environment_too_small', small);
  }

  const busy = await call(
    context,
    'engine ps',
    ['docker', 'ps', '--filter', 'label=foundation.test', '--format', '{{.Names}} {{.Label "foundation.test"}}'],
    TIMEOUTS.daemonQuery,
  );
  if (!succeeded(busy)) fail(context, 'setup_failed', 'environment_read');
  const running = busy.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (running.length > 0) {
    context.error(`performance ${context.profile}: ${running.length} container foundation.test lain sedang berjalan:`);
    for (const line of running) context.error(`  ${line}`);
    context.error('Hentikan run itu, atau ikuti langkah pembersihan manual k6 di docs/rules/testing.md sesudah ditinjau.');
    fail(context, 'environment_busy', `before:${running.length}`);
  }

  await ensurePostgresImage(context);

  for (const [name, image] of [['k6', pins.pins.k6], ['bun', pins.pins.bun]] as const) {
    const pulled = await call(context, `pull ${name}`, ['docker', 'pull', image], TIMEOUTS.pull);
    if (!succeeded(pulled)) fail(context, 'image_pull_failed', name);
  }

  if (context.profile === 'smoke') {
    for (const profile of PROFILE_NAMES) {
      context.created.inspect = true;
      const inspected = await call(context, `inspect ${profile}`, inspectRunArgs(containers, profile), TIMEOUTS.k6Inspect);
      if (!succeeded(inspected) || !inspectMatches(parseJson(inspected.stdout), optionsFor(profile))) fail(context, 'inspect_mismatch', profile);
    }
    context.log(`performance ${context.profile}: k6 inspect cocok dengan optionsFor`);
  }
  return containers;
}

/** (6) The PostgreSQL image exists with the base label of `pins.baseImage`, otherwise Compose builds it. */
async function ensurePostgresImage(context: Context): Promise<void> {
  const { root } = context.deps;
  const pins = parseJson(await readText(join(root, POSTGRES_PINS_PATH)));
  const baseImage = isRecord(pins) ? pins['baseImage'] : undefined;
  const packageVersion = isRecord(pins) ? pins['postgresPackageVersion'] : undefined;
  if (typeof baseImage !== 'string' || typeof packageVersion !== 'string') fail(context, 'image_build_failed', 'postgres');
  const labelled = async () => {
    const inspected = await call(context, 'image inspect', ['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', POSTGRES_IMAGE], TIMEOUTS.daemonQuery);
    const labels = succeeded(inspected) ? parseJson(inspected.stdout) : undefined;
    const ok = isRecord(labels) && labels['org.opencontainers.image.base.name'] === baseImage;
    if (ok) context.environment.images.postgres.baseImage = baseImage;
    return ok;
  };
  if (await labelled()) return;
  context.log(`performance ${context.profile}: membangun ${POSTGRES_IMAGE} dari ${POSTGRES_PINS_PATH}`);
  const folder = await temporaryFolder(context);
  const envFile = join(folder, 'build.env');
  await writeFile(
    envFile,
    [
      `FOUNDATION_POSTGRES_PASSWORD=${secret(context)}`,
      `FOUNDATION_POSTGRES_IMAGE=${POSTGRES_IMAGE}`,
      `FOUNDATION_POSTGRES_BASE_IMAGE=${baseImage}`,
      `FOUNDATION_POSTGRES_PACKAGE_VERSION=${packageVersion}`,
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  const built = await call(
    context,
    'compose build',
    ['docker', 'compose', '-p', `foundation-perf-build-${context.hex}`, '--env-file', envFile, ...COMPOSE_FILES.flatMap((file) => ['-f', file]), 'build', 'postgres'],
    TIMEOUTS.imageBuild,
  );
  await rm(envFile, { force: true });
  if (!succeeded(built) || !(await labelled())) fail(context, 'image_build_failed', 'postgres');
}

async function countMigrations(root: string): Promise<number | null> {
  try {
    return (await readdir(join(root, MIGRATIONS_DIR), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).length;
  } catch {
    return null;
  }
}

type Environment = { expectedMigrations: number; clockOffsetMs: number; adminUrl: string };

/** Steps 3 and 4: network, PostgreSQL, provisioning, migration, backend, poll, and the first clock offset. */
async function startEnvironment(context: Context, containers: ContainerContext): Promise<Environment> {
  const { deps } = context;
  context.step = 'network';
  const folder = await temporaryFolder(context);
  const [adminPassword, migratorPassword, backendPassword] = [secret(context), secret(context), secret(context)];
  const hostPort = await (deps.freePort ?? defaultFreePort)();
  const adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${hostPort}/foundation`;
  const migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${hostPort}/foundation`;
  const backendUrl = `postgres://foundation_backend:${backendPassword}@postgres:5432/foundation`;
  context.secrets.push(adminUrl, migratorUrl, backendUrl);
  const adminEnv = join(folder, 'postgres.env');
  await writeFile(adminEnv, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
  const backendEnv = join(folder, 'backend.env');
  await writeFile(backendEnv, `NODE_ENV=development\nHOST=127.0.0.1\nPORT=8888\nHOME=/tmp\nDATABASE_URL=${backendUrl}\n`, { mode: 0o600 });

  // A failed create may still leave the resource, so cleanup inspects it from here on.
  context.created.network = true;
  if (!succeeded(await call(context, 'network create', networkCreateArgs(containers), TIMEOUTS.create))) fail(context, 'setup_failed', 'network');
  context.step = 'postgres_start';
  context.created.db = true;
  if (!succeeded(await call(context, 'postgres run', postgresRunArgs(containers, hostPort, adminEnv), TIMEOUTS.create))) {
    fail(context, 'setup_failed', 'postgres_start');
  }
  context.log(`performance ${context.profile}: ${context.names.network} dan ${context.names.db} dibuat`);

  context.step = 'postgres_ready';
  const selectOne = deps.selectOne ?? defaultSelectOne;
  let ready = false;
  for (const deadline = deps.now() + TIMEOUTS.selectOneTotal; deps.now() < deadline; await deps.sleep(TIMEOUTS.selectOnePause)) {
    stopIfAborted(context);
    if (await selectOne(adminUrl, TIMEOUTS.selectOneAttempt)) {
      ready = true;
      break;
    }
    stopIfAborted(context);
  }
  if (!ready) fail(context, 'setup_failed', 'postgres_ready');

  context.step = 'provision';
  const path = (deps.env ?? process.env)['PATH'] ?? '';
  const provisioned = await deps.provision(
    { PATH: path, FOUNDATION_ADMIN_DATABASE_URL: adminUrl, FOUNDATION_MIGRATOR_PASSWORD: migratorPassword, FOUNDATION_BACKEND_PASSWORD: backendPassword },
    deps.signal,
  );
  record(context, 'provision', provisioned);
  stopIfAborted(context);
  if (!succeeded(provisioned)) fail(context, 'setup_failed', 'provision');
  context.step = 'migrate';
  const migrated = await deps.migrate({ PATH: path, FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl }, deps.signal);
  record(context, 'migrate', migrated);
  stopIfAborted(context);
  if (!succeeded(migrated)) fail(context, 'setup_failed', 'migrate');
  context.step = 'migration_count';
  const expectedMigrations = await countMigrations(deps.root);
  if (expectedMigrations === null) fail(context, 'setup_failed', 'migration_count');
  context.environment.data.appliedMigrations = expectedMigrations;
  context.log(`performance ${context.profile}: database diprovision dan dimigrasi (${expectedMigrations} migration)`);

  context.step = 'backend_start';
  context.created.backend = true;
  if (!succeeded(await call(context, 'backend run', backendRunArgs(containers, backendEnv), TIMEOUTS.create))) fail(context, 'setup_failed', 'backend_start');
  let backendUp = false;
  for (const deadline = deps.now() + TIMEOUTS.backendPollTotal; deps.now() < deadline; await deps.sleep(TIMEOUTS.backendPollPause)) {
    const polled = await call(context, 'backend poll', ['docker', 'exec', context.names.backend, 'bun', '--no-env-file', '-e', BACKEND_POLL_SCRIPT], TIMEOUTS.backendPollCall);
    if (succeeded(polled) && backendReady(polled.stdout, expectedMigrations)) {
      backendUp = true;
      break;
    }
  }
  if (!backendUp) fail(context, 'backend_not_ready');

  context.step = 'clock_offset_read';
  const clockOffsetMs = await readClockOffset(context);
  if (clockOffsetMs === null) fail(context, 'setup_failed', 'clock_offset_read');
  context.environment.clockOffsetMs.before = clockOffsetMs;
  context.log(`performance ${context.profile}: backend ${context.names.backend} siap; selisih jam ${clockOffsetMs} ms`);
  return { expectedMigrations, clockOffsetMs, adminUrl };
}

/**
 * The environment read before T0 (*Isi result.json*, `environment`): the container engine version and OS, the number of
 * other running containers (`docker ps -q` minus the containers of the run), the PostgreSQL image id, and the server
 * version through the admin connection. A value that cannot be read fails `setup_failed` with `environment_read`.
 */
async function readRunEnvironment(context: Context, environment: Environment): Promise<void> {
  context.step = 'environment_read';
  const read = async (label: string, argv: string[]) => {
    const result = await call(context, label, argv, TIMEOUTS.daemonQuery);
    return succeeded(result) ? result.stdout : null;
  };
  const serverVersion = jsonString(await read('engine version', ['docker', 'version', '--format', '{{json .Server.Version}}']));
  const os = jsonString(await read('engine info', ['docker', 'info', '--format', '{{json .OperatingSystem}}']));
  const running = await read('engine ps', ['docker', 'ps', '-q']);
  const own = await read('engine ps', ['docker', 'ps', '-q', '--filter', `label=foundation.run=${context.hex}`]);
  const imageId = jsonString(await read('image inspect', ['docker', 'image', 'inspect', '--format', '{{json .Id}}', POSTGRES_IMAGE]));
  const postgresVersion = await (context.deps.serverVersion ?? defaultServerVersion)(environment.adminUrl, TIMEOUTS.selectOneAttempt);
  stopIfAborted(context);
  if (serverVersion === null || os === null || running === null || own === null || imageId === null || postgresVersion === null) {
    fail(context, 'setup_failed', 'environment_read');
  }
  const { environment: block } = context;
  block.containerEngine.serverVersion = serverVersion;
  block.containerEngine.os = os;
  block.otherContainersRunning = Math.max(0, lineCount(running) - lineCount(own));
  block.images.postgres.imageId = imageId;
  block.images.postgres.serverVersion = postgresVersion;
  context.log(
    `performance ${context.profile}: mesin container ${serverVersion} (${os}, ${block.containerEngine.ncpu} CPU), ` +
      `${block.otherContainersRunning} container lain berjalan; PostgreSQL ${postgresVersion}`,
  );
}

/**
 * The `docker stats` stream through `runProcessGroup` with `onOutput`, started again at most 10 times after a pause of
 * 1000 ms when it ends before it is stopped, and the `pg_stat_activity` sampler. Both stop when the run is aborted.
 */
function startObservation(context: Context, adminUrl: string): RunObservation {
  const { deps } = context;
  const controller = new AbortController();
  const stopped = new Promise<void>((done) => controller.signal.addEventListener('abort', () => done(), { once: true }));
  const abort = () => controller.abort();
  deps.signal.addEventListener('abort', abort, { once: true });
  if (deps.signal.aborted) controller.abort();

  let sampled = false;
  let firstSample: () => void = () => undefined;
  const first = new Promise<void>((done) => (firstSample = done));
  /** Stream stderr, plus any stdout line that holds a run credential; this joins the scanned output, never the console. */
  const scanned: string[] = [];
  const collector = statsCollector(roleNames(context.names), {
    // Every line is checked for a run credential; a line that holds one joins the scanned output.
    onLine: (line) => {
      if (containsSecret(line, context.secrets)) scanned.push(`${line}\n`);
    },
    onSample: () => {
      sampled = true;
      firstSample();
    },
  });
  let processes = 0;
  const stream = (async () => {
    for (let attempt = 0; attempt <= TIMEOUTS.statsRestarts && !controller.signal.aborted; attempt += 1) {
      if (attempt > 0) {
        await Promise.race([deps.sleep(TIMEOUTS.statsRestartPause), stopped]);
        if (controller.signal.aborted) return;
      }
      collector.begin();
      processes += 1;
      try {
        await deps.run(statsArgs(context.names), {
          cwd: deps.root,
          env: context.dockerEnv,
          timeoutMs: profileSeconds(context.profile) * 1_000 + TIMEOUTS.statsExtra,
          output: 'pipe',
          graceMs: TIMEOUTS.cancelGrace,
          signal: controller.signal,
          onOutput: (name, chunk, receivedAtMs) => {
            if (name === 'stdout') collector.push(chunk, receivedAtMs);
            else scanned.push(chunk.toString('utf8'));
          },
        });
      } catch {
        // A stream that cannot start counts as one that ended; `observation_coverage` judges the gap.
      }
    }
  })();
  const pool: PoolSample[] = [];
  const sampler = samplePool(context, adminUrl, pool, controller.signal, stopped);
  let stopping: Promise<void> | undefined;
  return {
    collector,
    pool,
    processes: () => processes,
    started: async (t0) => {
      if (!sampled) await Promise.race([first, stream, stopped, deps.sleep(Math.max(0, t0 - deps.now()))]);
      return sampled && !controller.signal.aborted;
    },
    stop: () =>
      (stopping ??= (async () => {
        controller.abort();
        await settleWithin(Promise.all([stream, sampler]), TIMEOUTS.streamsStop);
        deps.signal.removeEventListener('abort', abort);
        context.outputs.set('stats', (context.outputs.get('stats') ?? '') + scanned.join(''));
      })()),
  };
}

function roleNames(names: ResourceNames): Record<ContainerRole, string> {
  return { postgres: names.db, backend: names.backend, k6: names.k6 };
}

/**
 * One `pg_stat_activity` sample every 1000 ms without overlap, each limited to 2000 ms, through one admin instance; after
 * a failed sample that instance is closed and a new one is made, so a connection broken by a stopped PostgreSQL is
 * never carried into the next phase.
 */
async function samplePool(context: Context, url: string, samples: PoolSample[], signal: AbortSignal, stopped: Promise<void>): Promise<void> {
  const { deps } = context;
  const connect = deps.poolClient ?? defaultPoolClient;
  let client: PoolClient | null = null;
  try {
    while (!signal.aborted) {
      const startedAt = deps.now();
      let counts: PoolCounts | null = null;
      try {
        client ??= connect(url);
        counts = await withinLimit(client.sample(), TIMEOUTS.poolSample);
      } catch {
        counts = null;
      }
      if (counts === null) {
        samples.push({ t: deps.now(), unavailable: true });
        const failed = client;
        client = null;
        await failed?.close().catch(() => undefined);
      } else {
        samples.push({ t: deps.now(), ...counts });
      }
      const wait = startedAt + TIMEOUTS.poolInterval - deps.now();
      if (wait > 0 && !signal.aborted) await Promise.race([deps.sleep(wait), stopped]);
    }
  } finally {
    await client?.close().catch(() => undefined);
  }
}

/** Offset of `Date.now()` in the backend container from the midpoint of the host time before and after `docker exec`. */
async function readClockOffset(context: Context): Promise<number | null> {
  const before = context.deps.now();
  const read = await call(context, 'clock offset', ['docker', 'exec', context.names.backend, 'bun', '--no-env-file', '-e', CLOCK_SCRIPT], TIMEOUTS.clockRead);
  const after = context.deps.now();
  const value = Number(read.stdout.trim());
  if (!succeeded(read) || !/^\d+$/.test(read.stdout.trim()) || !Number.isSafeInteger(value)) return null;
  return Math.round(value - (before + after) / 2);
}

/**
 * The outage control next to k6 (step 5 on outage): `runOutageControl` with the guard and the commands of the run. A
 * signal aborts a running command like any other step; `stop` ends the control and waits at most `limitMs` for a
 * command still running.
 */
function startOutageControl(context: Context, t0: number): { stop: (limitMs: number) => Promise<void> } {
  const { deps, names } = context;
  const timing = plannedOutage();
  context.outage = timing;
  const ended = new AbortController();
  const end = () => ended.abort();
  deps.signal.addEventListener('abort', end, { once: true });
  if (deps.signal.aborted) ended.abort();
  const control = runOutageControl(t0, timing, {
    now: deps.now,
    sleep: deps.sleep,
    guard: async (command) => {
      try {
        if ((await guardCheck(context, 'container', names.db, true)) === 'passed') return true;
      } catch {
        // A signal stopped the guard inspect; the run goes to cleanup.
      }
      if (!deps.signal.aborted) context.error(`performance ${context.profile}: penjaga container menolak ${command} ${names.db}; perintah tidak dikirim`);
      return false;
    },
    send: async (command) => {
      let result: ProcessGroupResult | null = null;
      try {
        result = await call(context, `outage ${command}`, outageControlArgs(command, names.db), TIMEOUTS.outageControl);
      } catch {
        // A signal stopped the command; the run goes to cleanup.
      }
      const issued = command === 'stop' ? timing.stopIssuedMs : timing.startIssuedMs;
      const done = result !== null && succeeded(result);
      if (done) {
        const elapsed = deps.now() - t0 - (issued ?? 0);
        context.log(`performance ${context.profile}: ${command} ${names.db} dikirim pada T0 + ${issued} ms dan selesai dalam ${elapsed} ms`);
      } else if (!deps.signal.aborted) {
        context.error(`performance ${context.profile}: ${command} ${names.db} gagal`);
      }
      return done;
    },
    ended: ended.signal,
  });
  let stopping: Promise<void> | undefined;
  return {
    stop: (limitMs) =>
      (stopping ??= (async () => {
        ended.abort();
        await settleWithin(control, limitMs);
        deps.signal.removeEventListener('abort', end);
      })()),
  };
}

/**
 * Step 5: `docker create` of k6, the `docker stats` stream and the `pg_stat_activity` sampler (the stream must give its
 * first sample before T0), on outage the outage control, then `docker start -a` limited to the profile seconds × 1000 +
 * 135000 ms; after k6 exits the outage control, the stream, and the sampler stop.
 */
async function runK6(context: Context, containers: ContainerContext, environment: Environment, t0: number): Promise<void> {
  context.step = 'k6_create';
  context.created.k6 = true;
  const created = await call(context, 'k6 create', k6CreateArgs(containers, context.profile, environment.expectedMigrations, t0), TIMEOUTS.create);
  if (!succeeded(created)) fail(context, 'setup_failed', 'k6_create');
  context.step = 'stats_start';
  const observation = startObservation(context, environment.adminUrl);
  context.observation = observation;
  const streaming = await observation.started(t0);
  stopIfAborted(context);
  if (!streaming) fail(context, 'setup_failed', 'stats_start');
  context.log(`performance ${context.profile}: k6 ${context.names.k6} mulai; T0 ${new Date(t0).toISOString()}`);
  if (context.profile === 'outage') context.outageControl = startOutageControl(context, t0);
  context.k6Started = true;
  const k6 = await call(context, 'k6', ['docker', 'start', '-a', context.names.k6], profileSeconds(context.profile) * 1_000 + TIMEOUTS.k6Extra);
  const exit = k6ExitReason(k6.code, k6.timedOut);
  context.log(`performance ${context.profile}: k6 keluar ${k6.timedOut ? 'karena batas waktu' : `dengan kode ${k6.code}`}`);
  if (exit !== null) context.reasons.push(reason(exit, exit === 'k6_failed' ? String(k6.code) : null));
  // A command still running when k6 exits early may finish within its own process limit; none is sent after this.
  await context.outageControl?.stop(TIMEOUTS.outageControl);
  await observation.stop();
  const samples = CONTAINER_ROLES.reduce((total, role) => total + observation.collector.samples[role].length, 0);
  const failedPool = observation.pool.filter((sample) => !poolSucceeded(sample)).length;
  context.log(
    `performance ${context.profile}: pengamatan ${samples} sampel container dari ${observation.processes()} proses aliran dan ` +
      `${observation.pool.length} sampel pg_stat_activity (${failedPool} gagal)`,
  );
}

/**
 * Step 6 up to the judgement: the `environment_busy` check again (ignoring the containers of this run), the second clock
 * offset, the backend state (never without `--format`), `docker stop --time 5` of the backend through the guard, and
 * `docker logs` with stdout and stderr apart.
 */
async function afterK6(context: Context): Promise<void> {
  context.step = 'environment_read';
  const busy = await call(
    context,
    'engine ps',
    ['docker', 'ps', '--filter', 'label=foundation.test', '--format', '{{.Names}} {{.Label "foundation.test"}} {{.Label "foundation.run"}}'],
    TIMEOUTS.daemonQuery,
  );
  if (!succeeded(busy)) {
    context.reasons.push(reason('setup_failed', 'environment_read'));
  } else {
    const others = otherTestContainers(busy.stdout, context.hex);
    if (others.length > 0) {
      context.error(`performance ${context.profile}: ${others.length} container foundation.test lain berjalan sesudah k6:`);
      for (const line of others) context.error(`  ${line}`);
      context.error('Pengukuran terganggu; ikuti langkah pembersihan manual k6 di docs/rules/testing.md sesudah ditinjau.');
      context.reasons.push(reason('environment_busy', `after:${others.length}`));
    }
  }
  const after = await readClockOffset(context);
  context.environment.clockOffsetMs.after = after;
  context.log(`performance ${context.profile}: selisih jam sesudah k6 ${after === null ? 'tidak terbaca' : `${after} ms`}`);
  const state = await call(context, 'backend state', backendStateArgs(context.names.backend), TIMEOUTS.backendControl);
  context.backendState = succeeded(state) ? parseBackendState(state.stdout) : null;
  await guarded(context, 'container', context.names.backend, ['docker', 'stop', '--time', '5', context.names.backend], TIMEOUTS.backendControl, true);
  const logs = await call(context, 'backend logs', ['docker', 'logs', context.names.backend], TIMEOUTS.backendControl, { outputLimitBytes: TIMEOUTS.logsLimitBytes });
  context.backendLogs = succeeded(logs) && logs.outputExceeded !== true ? { stdout: logs.stdout, stderrBytes: Buffer.byteLength(logs.stderr) } : null;
}

/** The observation input of the checks; `null` when k6 never started, so there is nothing to judge. */
function observationInput(context: Context): ObservationInput | null {
  if (!context.k6Started || context.t0 === null || context.observation === null) return null;
  return {
    profile: context.profile,
    t0: context.t0,
    phases: observedPhases(context.profile, context.t0),
    containers: context.observation.collector.samples,
    pool: context.observation.pool,
    backendState: context.backendState,
    backendLogs: context.backendLogs,
    clockOffsetMs: context.environment.clockOffsetMs,
    outage: context.outage,
  };
}

/** Step 6, the judgement: the summary and its reasons (`summary_missing`, `phase_start_late`, `iteration_request_mismatch`), then the observation checks. */
async function judge(context: Context): Promise<void> {
  const summary = parseJson(await readText(join(context.deps.root, EVIDENCE_ROOT, context.profile, 'k6', 'summary.json')));
  context.reading = readSummary(summary, context.profile, context.t0);
  if (context.reading === null) {
    context.reasons.push(reason('summary_missing'));
  } else {
    const { actual } = context.reading;
    context.reasons.push(...summaryReasons(context.reading));
    context.log(
      `performance ${context.profile}: beban aktual ${actual.iterations} iterasi, ${actual.httpReqs} request, ` +
        `${actual.droppedIterations} dropped iterations; scenario mulai ${actual.scenarioStartLateMs ?? 'tidak tercatat'} ms sesudah T0`,
    );
  }
  const input = observationInput(context);
  if (input === null) return;
  const checks = observationChecks(input);
  context.resultObservation = observationSummary(input, checks);
  context.reasons.push(...observationReasons(checks, input.outage));
  const { containers } = context.resultObservation;
  context.log(
    `performance ${context.profile}: check pengamatan ${checks.filter((check) => check.ok).length} dari ${checks.length} lulus; ` +
      `CPU k6 maksimum ${containers.k6.cpuMax ?? '-'} persen, memory backend puncak ${containers.backend.memoryMaxMiB ?? '-'} MiB`,
  );
}

/** Step 7: ordered cleanup through the guard, without the abort signal, only for resources this run created. */
async function cleanUp(context: Context): Promise<void> {
  const failed = (name: string) => {
    context.reasons.push(reason('cleanup_failed', name));
    context.error(`performance ${context.profile}: ${name} tidak dapat dihapus; hapus dengan tangan sesudah ditinjau`);
  };
  const remove = async (created: boolean, name: string) => {
    if (!created) return;
    if ((await guarded(context, 'container', name, ['docker', 'rm', '-f', name], TIMEOUTS.remove, false)) === 'failed') failed(name);
  };
  // A command of the outage control was cancelled with the running step (at most 10 seconds); then the stream and the
  // sampler stop, at most 5 seconds. On the normal path all of them already stopped after k6.
  await context.outageControl?.stop(TIMEOUTS.cancelMax);
  await context.observation?.stop();
  if (context.created.k6) {
    if ((await guarded(context, 'container', context.names.k6, ['docker', 'stop', '--time', '10', context.names.k6], TIMEOUTS.k6Stop, false)) === 'failed') {
      failed(context.names.k6);
    }
  }
  await remove(context.created.k6, context.names.k6);
  await remove(context.created.backend, context.names.backend);
  await remove(context.created.db, context.names.db);
  await remove(context.created.inspect, context.names.inspect);
  if (context.created.network) {
    const removed = await guarded(context, 'network', context.names.network, ['docker', 'network', 'rm', context.names.network], TIMEOUTS.remove, false);
    if (removed === 'failed') failed(context.names.network);
  }
  if (context.tempDir !== null) {
    try {
      await rm(context.tempDir, { recursive: true, force: true });
      context.tempDir = null;
    } catch {
      failed('folder');
    }
  }
}

/**
 * One profile run from the pre-run checks to cleanup and evidence. Resolves to 0 only when `result.json` is `passed`,
 * the scan has no finding, and cleanup is complete; 1 for any other failure; 129, 130, or 143 after SIGHUP, SIGINT,
 * or SIGTERM (`deps.signal.reason`).
 */
export async function runProfile(profile: ProfileName, deps: RunDeps): Promise<number> {
  const startedAt = new Date(deps.now()).toISOString();
  const hex = runHex();
  const context: Context = {
    deps,
    profile,
    hex,
    names: resourceNames(hex),
    dockerEnv: stepEnvironment(deps.env ?? process.env),
    uid: deps.uid ?? process.getuid?.() ?? 65534,
    gid: deps.gid ?? process.getgid?.() ?? 65534,
    secrets: [],
    redact: (text) => text,
    reasons: [],
    outputs: new Map(),
    created: { network: false, db: false, backend: false, k6: false, inspect: false },
    tempDir: null,
    step: 'environment_read',
    log: () => undefined,
    error: () => undefined,
    t0: null,
    environment: hostEnvironment(deps.env ?? process.env),
    observation: null,
    k6Started: false,
    backendState: null,
    backendLogs: null,
    reading: null,
    resultObservation: null,
    outage: null,
    outageControl: null,
  };
  context.redact = redactor(context.secrets);
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const error = deps.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  context.log = (line) => log(context.redact(line));
  context.error = (line) => error(context.redact(line));

  const evidence = join(deps.root, EVIDENCE_ROOT, profile);
  const k6Folder = join(evidence, 'k6');
  await rm(evidence, { recursive: true, force: true });
  await mkdir(k6Folder, { recursive: true });
  if (context.uid === 0) await (deps.chown ?? chown)(k6Folder, 65534, 65534);
  context.log(`performance ${profile}: run ${hex} dimulai`);

  try {
    const containers = await prepare(context);
    const environment = await startEnvironment(context, containers);
    await readRunEnvironment(context, environment);
    context.t0 = deps.now() + T0_DELAY_MS;
    await runK6(context, containers, environment, context.t0);
    await afterK6(context);
    await judge(context);
  } catch (caught) {
    if (!(caught instanceof Stop) && !deps.signal.aborted) context.reasons.push(reason('setup_failed', context.step));
  }
  if (deps.signal.aborted) context.reasons.push(reason('signal', signalName(deps.signal)));
  await cleanUp(context);
  // A signal that arrived during cleanup still ends the run with the exit code of that signal.
  if (deps.signal.aborted && !context.reasons.some((item) => item.code === 'signal')) context.reasons.push(reason('signal', signalName(deps.signal)));
  const received = deps.signal.aborted ? signalName(deps.signal) : null;

  // Step 8: results in memory, the scan of every text before redaction (a credential that reached a result must be
  // found, not only hidden), then redaction and the writes.
  const summaryPath = join(k6Folder, 'summary.json');
  let summary: Buffer | null = null;
  try {
    summary = await readFile(summaryPath);
  } catch {
    summary = null;
  }
  const findings: string[] = [];
  for (const [label, text] of context.outputs) {
    if (containsSecret(text, context.secrets)) findings.push(`${label} output`);
  }
  if (summary !== null && containsSecret(summary, context.secrets)) findings.push(`${EVIDENCE_ROOT}/${profile}/k6/summary.json`);
  const t0 = context.t0;
  const empty: Record<ContainerRole, ContainerSample[]> = { postgres: [], backend: [], k6: [] };
  const observation = buildObservationFile(profile, t0, context.observation?.collector.samples ?? empty, context.observation?.pool ?? []);
  const observationRaw = `${JSON.stringify(observation)}\n`;
  if (containsSecret(observationRaw, context.secrets)) findings.push(`${EVIDENCE_ROOT}/${profile}/observation.json`);
  const observationText = context.redact(observationRaw);
  const appliedMigrations = context.environment.data.appliedMigrations ?? (await countMigrations(deps.root));
  const parts = {
    profile,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
    t0,
    reading: context.reading,
    observation: context.resultObservation,
    outage: context.outage,
    environment: context.environment,
    appliedMigrations,
  };
  let result = buildResult({ ...parts, reasons: context.reasons });
  if (containsSecret(`${JSON.stringify(result, null, 2)}\n`, context.secrets)) findings.push(`${EVIDENCE_ROOT}/${profile}/result.json`);
  if (findings.length > 0) result = buildResult({ ...parts, reasons: [...result.reasons, reason('secret_in_output', String(findings.length))] });
  const resultText = context.redact(`${JSON.stringify(result, null, 2)}\n`);
  const scan = {
    outputsScanned: [...context.outputs.keys()],
    filesScanned: [
      ...(summary === null ? [] : [`${EVIDENCE_ROOT}/${profile}/k6/summary.json`]),
      `${EVIDENCE_ROOT}/${profile}/observation.json`,
      `${EVIDENCE_ROOT}/${profile}/result.json`,
    ],
    secretsChecked: context.secrets.length,
    findings,
  };
  await writeFile(join(evidence, 'observation.json'), observationText);
  await writeFile(join(evidence, 'result.json'), resultText);
  await writeFile(join(evidence, 'artifact-scan.json'), `${JSON.stringify(scan, null, 2)}\n`);

  const reasons = result.reasons.map((item) => (item.detail === null ? item.code : `${item.code} ${item.detail}`)).join(', ');
  if (result.status === 'passed') context.log(`performance ${profile}: passed; pemindaian credential tanpa temuan atas ${scan.outputsScanned.length} output`);
  else context.error(`performance ${profile}: failed (${reasons})`);
  if (received !== null) return SIGNAL_EXIT_CODES[received];
  return result.status === 'passed' && findings.length === 0 ? 0 : 1;
}

/**
 * The argument check before any other action (exit 2 with a fixed message), SIGINT, SIGTERM, and SIGHUP handlers that
 * abort the running step, the real deps, then `runProfile`.
 */
export async function main(options: {
  root: string;
  argv: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}): Promise<number> {
  const error = options.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  const [profile, ...rest] = options.argv;
  if (rest.length > 0 || !runnableProfile(profile)) {
    error(USAGE);
    return 2;
  }
  const controller = new AbortController();
  const handlers = (Object.keys(SIGNAL_EXIT_CODES) as HandledSignal[]).map((signal) => {
    const handler = () => controller.abort(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const runBun = (script: string, timeoutMs: number) => (env: Record<string, string>, signal: AbortSignal) =>
    runProcessGroup([process.execPath, '--no-env-file', script, '--apply'], { cwd: options.root, env, timeoutMs, output: 'pipe', signal, graceMs: TIMEOUTS.cancelGrace });
  try {
    return await runProfile(profile, {
      root: options.root,
      run: runProcessGroup,
      provision: runBun('database/provision.ts', TIMEOUTS.provision),
      migrate: runBun('database/migrate.ts', TIMEOUTS.migrate),
      now: Date.now,
      sleep: (ms) => Bun.sleep(ms),
      signal: controller.signal,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.log === undefined ? {} : { log: options.log }),
      error,
    });
  } catch {
    error(`performance ${profile}: run tidak dapat diselesaikan; periksa resource berlabel foundation.test=performance`);
    return 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

if (import.meta.main) {
  process.exitCode = await main({ root: resolve(import.meta.dir, '../..'), argv: process.argv.slice(2) });
}
