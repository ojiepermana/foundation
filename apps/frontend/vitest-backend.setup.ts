import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

// Real backend harness for SDK contract tests (spec 0009, AC-4 and *Value sourcing*, Harness rows). One Bun backend
// serves the whole `ng test` run on a loopback port, without `.env`, `DATABASE_URL`, or any other parent variable.

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const backendCommand: readonly string[] = ['bun', '--no-env-file', 'apps/backend/src/index.ts'];
const maximumAttempts = 3;
const readinessWindowMs = 10_000;
const probeTimeoutMs = 1_000;
const probeIntervalMs = 100;
const stopGraceMs = 5_000;
const startFailure = 'SDK contract backend did not start';
const stateKey = Symbol.for('foundation.sdkContractBackend');

export type SdkContractBackendEnvironment = {
  PATH: string;
  HOME: string;
  NODE_ENV: 'development';
  HOST: '127.0.0.1';
  PORT: string;
};

/** Exactly the five variables the backend child receives; nothing else from `parent` passes through. */
export function sdkContractBackendEnvironment(
  parent: Record<string, string | undefined>,
  port: number,
): SdkContractBackendEnvironment {
  return {
    PATH: parent['PATH'] ?? '',
    HOME: parent['HOME'] ?? '',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
  };
}

export interface SdkContractBackend {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  /** Stops the child (SIGTERM, then SIGKILL after 5 seconds) and prints `SDK contract backend stopped`. */
  stop(): Promise<void>;
}

export interface StartSdkContractBackendOptions {
  /** Test only replacement for `bun --no-env-file apps/backend/src/index.ts`, run from the repository root. */
  command?: readonly string[];
  /** Test only replacement for the 10 second readiness window of each attempt. */
  readyTimeoutMs?: number;
  /** Test only observer called once per attempt with the child pid, or `undefined` when spawning failed. */
  onAttempt?: (attempt: number, pid: number | undefined) => void;
  /** Receives the `listening` and `stopped` lines; defaults to stdout. */
  log?: (line: string) => void;
}

type RunningChild = {
  child: ChildProcess | undefined;
  /** True once the child exited or failed to spawn. */
  ended: () => boolean;
  /** Resolves when the child exited or failed to spawn. */
  finished: Promise<void>;
};

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Waits for `promise` at most `ms`, then clears the timer, so a settled wait never holds the event loop open. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

/** A port the operating system picked on 127.0.0.1, released before it is returned. */
function loopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => (error || port === 0 ? reject(error ?? new Error('No loopback port')) : resolve(port)));
    });
  });
}

function launch(command: readonly string[], port: number): RunningChild {
  let ended = false;
  let child: ChildProcess | undefined;
  let markEnded: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    markEnded = () => {
      ended = true;
      resolve();
    };
  });

  const [executable, ...args] = command;
  try {
    child = spawn(executable ?? '', args, {
      cwd: repositoryRoot,
      env: sdkContractBackendEnvironment(process.env, port),
      stdio: 'ignore',
    });
  } catch {
    markEnded();
    return { child: undefined, ended: () => ended, finished };
  }

  const spawned = child;
  // Last resort when the test process ends without teardown; removed once the child is gone.
  const killOnExit = () => {
    try {
      spawned.kill('SIGKILL');
    } catch {
      // The child is already gone.
    }
  };
  process.once('exit', killOnExit);
  spawned.once('exit', () => {
    process.off('exit', killOnExit);
    markEnded();
  });
  spawned.on('error', () => {
    // A spawn failure (for example ENOENT) never emits `exit`.
    if (spawned.pid === undefined) {
      process.off('exit', killOnExit);
      markEnded();
    }
  });
  return { child, ended: () => ended, finished };
}

async function waitForEnd(running: RunningChild, ms: number): Promise<boolean> {
  if (running.ended()) return true;
  await settleWithin(running.finished, ms);
  return running.ended();
}

async function stopChild(running: RunningChild): Promise<void> {
  const { child } = running;
  if (!child || running.ended()) return;
  child.kill('SIGTERM');
  if (await waitForEnd(running, stopGraceMs)) return;
  child.kill('SIGKILL');
  if (!(await waitForEnd(running, stopGraceMs))) throw new Error('SDK contract backend did not stop');
}

/** Ready only for 200, a JSON content type, and the exact body `{"status":"ok"}`. */
async function respondsReady(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(`${url}/api/status`, { redirect: 'manual', signal: controller.signal });
    const body = await response.text();
    return (
      response.status === 200 &&
      (response.headers.get('content-type') ?? '').startsWith('application/json') &&
      body === '{"status":"ok"}'
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilReady(running: RunningChild, url: string, windowMs: number): Promise<boolean> {
  const deadline = performance.now() + windowMs;
  while (!running.ended() && performance.now() < deadline) {
    const ready = await respondsReady(url, Math.min(probeTimeoutMs, deadline - performance.now()));
    if (ready && !running.ended()) return true;
    if (running.ended()) return false;
    await settleWithin(running.finished, Math.min(probeIntervalMs, deadline - performance.now()));
  }
  return false;
}

/**
 * Starts the backend on a fresh loopback port, up to three attempts. A child that exits, fails to spawn, or is not
 * ready within the window counts as one failed attempt and is stopped before the next. After three failures it throws
 * `SDK contract backend did not start`, with no child left running.
 */
export async function startSdkContractBackend(options: StartSdkContractBackendOptions = {}): Promise<SdkContractBackend> {
  const command = options.command ?? backendCommand;
  const log = options.log ?? writeLine;
  const windowMs = options.readyTimeoutMs ?? readinessWindowMs;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const port = await loopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const running = launch(command, port);
    options.onAttempt?.(attempt, running.child?.pid);

    let ready = false;
    try {
      ready = await waitUntilReady(running, url, windowMs);
    } finally {
      if (!ready) await stopChild(running);
    }
    if (!ready) continue;

    log(`SDK contract backend listening on 127.0.0.1:${port}`);
    let stopping: Promise<void> | undefined;
    return {
      url,
      port,
      stop: () => (stopping ??= stopChild(running).then(() => log('SDK contract backend stopped'))),
    };
  }

  throw new Error(startFailure);
}

/** `http://127.0.0.1:<port>` of a second loopback port that is opened and closed at once, for status 0 tests. */
async function closedLoopbackUrl(): Promise<string> {
  return `http://127.0.0.1:${await loopbackPort()}`;
}

type SharedBackend = { backend: SdkContractBackend; closedUrl: string };
type SharedState = { promise: Promise<SharedBackend>; users: number };

async function startShared(): Promise<SharedBackend> {
  const backend = await startSdkContractBackend();
  try {
    return { backend, closedUrl: await closedLoopbackUrl() };
  } catch (error) {
    await backend.stop();
    throw error;
  }
}

/**
 * Angular 22.2 merges `test` from `runnerConfig` into the root and the project config, so Vitest calls this setup
 * twice. Both calls share one backend through a `globalThis` symbol, filled before the first `await`; the teardown
 * that brings `users` to zero stops it. A failed start removes the symbol again, because Vitest calls no teardown for
 * a setup that threw, so the next setup in the same process starts a new backend instead of reusing the failure.
 */
export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  const store = globalThis as typeof globalThis & { [stateKey]?: SharedState };
  let state = store[stateKey];
  if (!state) {
    const created: SharedState = { promise: startShared(), users: 0 };
    created.promise.catch(() => {
      if (store[stateKey] === created) delete store[stateKey];
    });
    state = created;
    store[stateKey] = created;
  }
  const shared = await state.promise;
  project.provide('sdkContractBackendUrl', shared.backend.url);
  project.provide('sdkContractClosedUrl', shared.closedUrl);
  state.users += 1;

  const owner = state;
  return async () => {
    owner.users -= 1;
    if (owner.users > 0) return;
    if (store[stateKey] === owner) delete store[stateKey];
    await shared.backend.stop();
  };
}
