import { cp, lstat, mkdir, mkdtemp, readdir, readlink, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { copyApiInputs } from '../../../scripts/lib/api-artifacts.ts';
import { runProcessGroup } from '../../../scripts/lib/process-group.ts';

// Shared helpers for the APP-003, OPENAPI, and SDK contract suites (spec 0008 and spec 0009, *Lingkungan test*).
// Not a test file: bun test only discovers *.test.ts here.
export const root = new URL('../../../', import.meta.url).pathname;
export const guardPreload = join(root, 'tests/integration/contract/no-network-preload.ts');

/**
 * Isolated workspace with the `API_INPUTS` copied through `copyApiInputs` and `node_modules` linked from the checkout.
 * With `artifacts` (the default) the stored `openapi.json` and `apps/frontend/sdk/` are copied too.
 */
export async function workspace({ artifacts = true }: { artifacts?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'foundation-app-'));
  await copyApiInputs(root, dir);
  if (artifacts) {
    for (const path of ['openapi.json', 'apps/frontend/sdk']) {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await cp(join(root, path), join(dir, path), { recursive: true, verbatimSymlinks: true });
    }
  }
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Copies the rest of `apps/frontend` into a workspace, without `dist`, `.angular`, `node_modules`, or `.env` files. */
export async function copyFrontendApplication(dir: string): Promise<void> {
  const skipped = (name: string) =>
    name === 'dist' || name === '.angular' || name === 'node_modules' || name === '.env' || name.startsWith('.env.');
  await cp(join(root, 'apps/frontend'), join(dir, 'apps/frontend'), {
    recursive: true,
    verbatimSymlinks: true,
    force: false,
    filter: (source) => !skipped(basename(source)),
  });
}

function environment(env: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env['PATH']!, HOME: process.env['HOME']!, ...env };
}

/**
 * Runs a root package script through `bun --no-env-file run`, with only PATH, HOME, and `env` in the environment.
 * The script runs as its own process group, which is stopped as a whole after `timeout` milliseconds (30 seconds by
 * default, the floor spec 0008 sets for sdk:generate, tsc, and api:sync), so a hang fails instead of lingering.
 */
export async function run(dir: string, script: string, { timeout = 30_000, env }: { timeout?: number; env?: Record<string, string> } = {}) {
  const result = await runProcessGroup([process.execPath, '--no-env-file', 'run', script], {
    cwd: dir, env: environment(env), timeoutMs: timeout, output: 'pipe',
  });
  return { code: result.code, output: result.stdout + result.stderr, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
}

/**
 * Runs `bun --no-env-file [--preload guard] ...args` directly, so the script process output contract can be
 * asserted without the `bun run` wrapper lines. The environment holds only PATH, HOME, and `env`. The process group
 * is stopped after `timeout` milliseconds (10 seconds by default).
 */
export async function runBun(dir: string, args: string[], { env, guard, timeout = 10_000 }: { env?: Record<string, string>; guard?: boolean; timeout?: number } = {}) {
  const result = await runProcessGroup([process.execPath, '--no-env-file', ...(guard ? ['--preload', guardPreload] : []), ...args], {
    cwd: dir, env: environment(env), timeoutMs: timeout, output: 'pipe',
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** Exact content of every file under a directory, for byte identical comparisons. */
export async function snapshot(dir: string): Promise<string> {
  const names = (await readdir(dir, { recursive: true })).sort();
  const entries = await Promise.all(names.map(async name => {
    const path = join(dir, name);
    return [name, (await stat(path)).isFile() ? Buffer.from(await Bun.file(path).arrayBuffer()).toString('base64') : 'directory'];
  }));
  return JSON.stringify(entries);
}

/**
 * Every entry under `dir` except the top level `node_modules` link, read with `lstat` and never followed: files by
 * SHA-256 of their bytes, symlinks by their target text, and directories by name. Proves a checkout stayed byte
 * identical, including its file list.
 */
export async function checkoutSnapshot(dir: string): Promise<string> {
  const entries: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(join(dir, path))).sort()) {
      const child = path ? `${path}/${name}` : name;
      if (child === 'node_modules') continue;
      const stats = await lstat(join(dir, child));
      if (stats.isSymbolicLink()) entries.push(`link ${child} ${await readlink(join(dir, child))}`);
      else if (stats.isDirectory()) {
        entries.push(`directory ${child}`);
        await visit(child);
      } else if (stats.isFile()) {
        entries.push(`file ${child} ${new Bun.CryptoHasher('sha256').update(await Bun.file(join(dir, child)).arrayBuffer()).digest('hex')}`);
      } else entries.push(`other ${child}`);
    }
  }
  await visit('');
  return entries.join('\n');
}
