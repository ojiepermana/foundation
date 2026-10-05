import { spawn } from 'node:child_process';
import { groupAlive } from './process-identity.ts';

// Runs one command as the leader of its own process group and never returns while a member of that group is alive
// (spec 0009, *Grup proses* and the *Penghentian tahap* row of Value sourcing). Used by `api:check`, the contract test
// helpers, and the tier runner of spec 0010, so a stage that hangs or is interrupted leaves no process behind.

/** Default wait after SIGTERM before SIGKILL, and the fixed wait after SIGKILL and for closing pipes. */
const defaultGraceMs = 5_000;
const pollMs = 100;

export type ProcessGroupOptions = {
  cwd: string;
  /** The complete child environment; nothing from the parent is added. */
  env: Record<string, string>;
  /** After this many milliseconds the whole group is stopped and `timedOut` is true. */
  timeoutMs: number;
  /** `inherit` passes stdout and stderr through as is; `pipe` collects them into the result. */
  output: 'inherit' | 'pipe';
  /** Aborting stops the whole group and sets `aborted`. */
  signal?: AbortSignal;
  /** Wait after SIGTERM before SIGKILL on timeout or abort; 5000 ms when absent (spec 0010, *Tabel tier*). */
  graceMs?: number;
  /**
   * With `output: 'pipe'`: once stdout and stderr together would pass this many bytes, nothing more is kept, the whole
   * group is stopped, and `outputExceeded` is true (spec 0010, *Pemanggilan pemindai*: scanner output stays in memory
   * with a 50 MB limit). No limit when absent.
   */
  outputLimitBytes?: number;
  /**
   * Only with `output: 'pipe'` (spec 0011, *Perubahan gate yang dinamai*): every chunk of stdout and stderr goes to this
   * callback in arrival order, with `Date.now()` when it arrived, and nothing is collected, so `stdout` and `stderr` of
   * the result stay empty. Used for long running output such as a resource sample stream. Combined with
   * `outputLimitBytes`, or without `output: 'pipe'`, the call throws before the process starts. The callback must not
   * throw. Stopping the group, `timeoutMs`, `signal`, and `graceMs` work exactly as without it.
   */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer, receivedAtMs: number) => void;
};

export type ProcessGroupResult = {
  /** Exit code of the group leader, or `null` when it ended by a signal or was never started. */
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  /**
   * Present only with `outputLimitBytes`, so the result other callers see is unchanged: true when the output passed the
   * limit; the collected output is then incomplete.
   */
  outputExceeded?: boolean;
  /** Collected output with `output: 'pipe'`; empty with `inherit`. */
  stdout: string;
  stderr: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for `promise` at most `ms`, then clears the timer, so a settled wait never holds the event loop open. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Polls every 100 ms for at most `waitMs`; true once no live member of the group is left. */
async function groupGone(pgid: number, waitMs: number): Promise<boolean> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    if (!(await groupAlive(pgid))) return true;
    if (performance.now() >= deadline) return false;
    await delay(pollMs);
  }
}

/** SIGKILL to the group, then waits; throws when a member is still alive 5 seconds later. */
async function killGroup(pgid: number): Promise<void> {
  signalGroup(pgid, 'SIGKILL');
  if (!(await groupGone(pgid, defaultGraceMs))) throw new Error('Process group did not stop');
}

/** SIGTERM to the group, then SIGKILL when it is still alive after `graceMs`. */
async function stopGroup(pgid: number, graceMs: number): Promise<void> {
  signalGroup(pgid, 'SIGTERM');
  if (await groupGone(pgid, graceMs)) return;
  await killGroup(pgid);
}

/**
 * Starts `argv` with `detached: true`, so the child leads its own process group. On timeout or abort the group gets
 * SIGTERM, then SIGKILL after `graceMs` (5 seconds by default). When the leader exits on its own, members still alive
 * get SIGKILL. The promise settles only after the whole group is gone, and rejects when the group survives SIGKILL for
 * 5 seconds.
 */
export async function runProcessGroup(argv: readonly string[], options: ProcessGroupOptions): Promise<ProcessGroupResult> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error('Empty command');
  const onOutput = options.onOutput;
  if (onOutput !== undefined && options.output !== 'pipe') throw new Error('onOutput needs output: pipe');
  if (onOutput !== undefined && options.outputLimitBytes !== undefined) throw new Error('onOutput cannot be combined with outputLimitBytes');
  if (options.signal?.aborted) return { code: null, timedOut: false, aborted: true, stdout: '', stderr: '' };

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.output === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let collected = 0;
  let outputExceeded = false;
  // Set once the group exists; output that passes the limit before that only stops collecting.
  let stopForOutput: () => void = () => undefined;
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    if (outputExceeded) return;
    if (options.outputLimitBytes !== undefined && collected + chunk.length > options.outputLimitBytes) {
      outputExceeded = true;
      stopForOutput();
      return;
    }
    collected += chunk.length;
    target.push(chunk);
  };
  // With `onOutput` every chunk is handed over as it arrives and never collected.
  const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => onOutput?.(stream, chunk, Date.now());
  child.stdout?.on('data', onOutput === undefined ? collect(stdout) : forward('stdout'));
  child.stderr?.on('data', onOutput === undefined ? collect(stderr) : forward('stderr'));
  const streamsClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pgid = child.pid;
  if (pgid === undefined) throw new Error('Process group did not start');

  let timedOut = false;
  let aborted = false;
  let stopping: Promise<void> | undefined;
  let stopFailed: (error: unknown) => void = () => undefined;
  // Rejects when the group survives SIGKILL, so a leader that never exits cannot hold the caller forever.
  const failure = new Promise<never>((_resolve, reject) => {
    stopFailed = reject;
  });
  const stop = () => (stopping ??= stopGroup(pgid, options.graceMs ?? defaultGraceMs).catch((error: unknown) => {
    stopFailed(error);
    throw error;
  }));
  const timer = setTimeout(() => {
    timedOut = true;
    stop().catch(() => undefined);
  }, options.timeoutMs);
  const onAbort = () => {
    aborted = true;
    stop().catch(() => undefined);
  };
  stopForOutput = () => {
    stop().catch(() => undefined);
  };
  if (outputExceeded) stopForOutput();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  // An abort that came while the child was spawning fired before the listener existed and never fires again.
  if (options.signal?.aborted) onAbort();

  try {
    const code = await Promise.race([exited, failure]);
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (stopping) await stopping;
    else if (await groupAlive(pgid)) await killGroup(pgid);
    // Pipes close once every writer is gone; a writer that left the group must not hold the result forever.
    if (options.output === 'pipe') await settleWithin(streamsClosed, defaultGraceMs);
    return {
      code,
      timedOut,
      aborted,
      ...(options.outputLimitBytes === undefined ? {} : { outputExceeded }),
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
