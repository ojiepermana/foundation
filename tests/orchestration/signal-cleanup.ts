import { writeSync } from 'node:fs';

// Signal cleanup of the real bun:test suites (spec 0010, row *Pembersihan sinyal suite nyata*; rationale decisions 64
// to 68). `bun test` 1.4.2 runs neither afterAll nor a finally block on SIGINT or SIGTERM, while test containers run
// under the Docker daemon, outside the process group of the step. So every bun:test file that creates a container or a
// Compose project registers each resource here, right before it creates it, and releases it once its normal path
// removed it. This module only holds the registry and the handler. It never runs Docker itself, so every Docker call
// stays in the test file that owns the resource, and it lives in tests/orchestration/, never in scripts/ (INFRA-001 of
// spec 0002). Every file of one `bun test` process shares one instance of this module, so the handlers below are
// installed once, when the module is first imported, and one registry serves every file of that process.

/** Total limit of the cleanup, counted from the signal. */
export const SIGNAL_CLEANUP_LIMIT_MS = 60_000;

/** Number of passes over the registry. The second pass removes what the daemon finished creating after the first. */
export const SIGNAL_CLEANUP_PASSES = 2;

export type SignalCleanupContext = {
  /** 1 or 2; a folder callback acts only on pass 2. */
  readonly pass: 1 | 2;
  /** Limit of one call: `callLimitMs` cut by what is left of `SIGNAL_CLEANUP_LIMIT_MS`, or 0 once nothing is left. */
  timeout(callLimitMs: number): number;
};

/**
 * A synchronous callback for one resource. It returns the names of resources it failed to remove (an empty array when
 * the resource is gone), never Docker output, an environment value, a password, or the path of an env file.
 */
export type SignalCleanupCallback = (context: SignalCleanupContext) => string[];

/**
 * `min(callLimitMs, SIGNAL_CLEANUP_LIMIT_MS - (now - startedAt))` in whole milliseconds, or 0 when nothing is left of the
 * total limit. Whole, because `Bun.spawnSync` refuses a `timeout` that is not an integer, and the handler measures
 * time with `performance.now()`, which has a fraction.
 */
export function signalCallTimeout(startedAt: number, now: number, callLimitMs: number): number {
  const left = Math.floor(SIGNAL_CLEANUP_LIMIT_MS - (now - startedAt));
  return left > 0 ? Math.min(Math.floor(callLimitMs), left) : 0;
}

type Entry = { callback: SignalCleanupCallback };

/** Registered callbacks in the order they were registered. */
const registry: Entry[] = [];

/**
 * Registers `callback` for one resource and returns the function that takes it off the registry again. Register right
 * before the resource is created (a backend process right after `Bun.spawn` returns it), and release once the normal
 * path (`afterAll`, `finally`, or `removeStack`) removed the resource.
 */
export function onSignalCleanup(callback: SignalCleanupCallback): () => void {
  const entry: Entry = { callback };
  registry.push(entry);
  return () => {
    const index = registry.indexOf(entry);
    if (index !== -1) registry.splice(index, 1);
  };
}

/**
 * SIGHUP too: a terminal that closes (or an SSH session that drops) under `bun run test:infrastructure` hangs up the
 * whole foreground group, and `bun test` would otherwise die without cleanup.
 */
const exitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
type HandledSignal = keyof typeof exitCodes;
let cleaning = false;

/**
 * Runs every registered callback in reverse order of registration, in two passes, then exits 129, 130, or 143 whatever
 * the result. Synchronous on purpose: it never awaits and never returns to test code, so no test creates a new container
 * after the signal. A callback that throws counts as the name `callback` and does not stop the others. Only the names
 * the last pass still returns are printed, as one line on stderr.
 */
function cleanUp(signal: HandledSignal): never {
  const startedAt = performance.now();
  let failed: string[] = [];
  for (let pass = 1; pass <= SIGNAL_CLEANUP_PASSES; pass += 1) {
    const context: SignalCleanupContext = {
      pass: pass as 1 | 2,
      timeout: (callLimitMs) => signalCallTimeout(startedAt, performance.now(), callLimitMs),
    };
    failed = [];
    for (const { callback } of [...registry].reverse()) {
      let names: string[];
      try {
        names = callback(context);
      } catch {
        names = ['callback'];
      }
      for (const name of names) if (!failed.includes(name)) failed.push(name);
    }
  }
  // writeSync, because an asynchronous write may be lost when the process exits right after it. After a hangup the
  // terminal may be gone and the write throws; the exit code must not depend on it.
  try {
    if (failed.length > 0) writeSync(2, `Pembersihan sinyal gagal: ${failed.join(', ')}\n`);
  } catch {
    // Nothing left to write to.
  }
  process.exit(exitCodes[signal]);
}

for (const signal of Object.keys(exitCodes) as HandledSignal[]) {
  process.on(signal, () => {
    // A later signal while the cleanup runs has no effect.
    if (cleaning) return;
    cleaning = true;
    cleanUp(signal);
  });
}
