import { lstat, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { copyApiInputs, diffArtifacts, emptyDiff, formatDiffLines, type ArtifactDiff } from './api-artifacts.ts';
import { runProcessGroup } from './process-group.ts';

// `api:check` (spec 0009, AC-6, AC-7, AC-10): regenerates `openapi.json` and the SDK twice from an empty isolated
// workspace, compares the first run with the second, then the checkout with the first run. The checkout is only read.
// Output is fixed text plus artifact paths; file contents, environment values, and stacks are never printed.

export type ApiCheckOptions = {
  /** The checkout to compare. */
  root: string;
  /** Limit for each `api:sync` run, 120000 ms on the CLI. */
  syncTimeoutMs: number;
};

const outputs = ['openapi.json', 'apps/frontend/sdk'];
const signalCodes = { SIGINT: 130, SIGTERM: 143 } as const;
type HandledSignal = keyof typeof signalCodes;

class SyncFailed extends Error {}

function stageEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Moves the outputs of the first run into `run1/`, so `run1/` holds an exact copy of them and the second run starts,
 * like the first, without `openapi.json` and without `apps/frontend/sdk/` (spec 0009, key invariant 3).
 */
async function keepFirstRun(workspace: string, firstRun: string): Promise<void> {
  for (const path of outputs) {
    if (!(await exists(join(workspace, path)))) continue;
    await mkdir(dirname(join(firstRun, path)), { recursive: true });
    await rename(join(workspace, path), join(firstRun, path));
  }
}

function report(diff: ArtifactDiff, message: string): void {
  process.stderr.write([...formatDiffLines(diff), message].map((line) => `${line}\n`).join(''));
}

type Interrupt = { signal: AbortSignal; received: () => HandledSignal | undefined };

/** Both runs and both comparisons inside `temporary`; resolves to the exit code before signal handling. */
async function check(options: ApiCheckOptions, temporary: string, interrupt: Interrupt): Promise<number> {
  const workspace = join(temporary, 'workspace');
  const firstRun = join(temporary, 'run1');
  const root = resolve(options.root);
  await mkdir(workspace);
  await copyApiInputs(root, workspace);
  await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir');

  for (let run = 1; run <= 2; run += 1) {
    if (interrupt.received()) return 1;
    const result = await runProcessGroup([process.execPath, '--no-env-file', 'run', 'api:sync'], {
      cwd: workspace,
      env: stageEnvironment(),
      timeoutMs: options.syncTimeoutMs,
      output: 'inherit',
      signal: interrupt.signal,
    });
    if (interrupt.received()) return 1;
    if (result.timedOut || result.code !== 0) throw new SyncFailed();
    if (run === 1) await keepFirstRun(workspace, firstRun);
  }

  const repeat = await diffArtifacts(firstRun, workspace);
  if (interrupt.received()) return 1;
  if (!emptyDiff(repeat)) {
    report(repeat, 'OpenAPI or SDK generation is not repeatable');
    return 1;
  }

  const drift = await diffArtifacts(root, firstRun);
  if (interrupt.received()) return 1;
  if (!emptyDiff(drift)) {
    report(drift, 'OpenAPI or SDK drift detected');
    return 1;
  }

  process.stdout.write('OpenAPI and SDK match stored artifacts across two runs\n');
  return 0;
}

/**
 * Runs the whole check and resolves to the exit code: 0 when both runs match each other and the checkout, 1 for a
 * difference or a failure, 130 for SIGINT, and 143 for SIGTERM. While it runs, SIGINT and SIGTERM stop the running
 * `api:sync` group, and no report line is printed after them. The temporary directory is removed only after that
 * group is gone.
 */
export async function runApiCheck(options: ApiCheckOptions): Promise<number> {
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

  let temporary: string | undefined;
  let code: number;
  let failure: string | undefined;
  try {
    temporary = await mkdtemp(join(tmpdir(), 'foundation-api-check-'));
    code = await check(options, temporary, { signal: controller.signal, received: () => received });
  } catch (error) {
    code = 1;
    failure = error instanceof SyncFailed ? 'API synchronization failed' : 'API check failed';
  }
  try {
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    code = 1;
    failure ??= 'API check failed';
  }
  for (const [signal, handler] of handlers) process.off(signal, handler);

  if (received !== undefined) return signalCodes[received];
  if (failure !== undefined) process.stderr.write(`${failure}\n`);
  return code;
}
