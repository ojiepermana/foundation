import { cp, mkdir, mkdtemp, readdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared helpers for the APP-003 and OPENAPI contract suites (spec 0008, critical test scenarios).
// Not a test file: bun test only discovers *.test.ts here.
export const root = new URL('../../../', import.meta.url).pathname;
export const guardPreload = join(root, 'tests/integration/contract/no-network-preload.ts');

/** Isolated copy of the files the contract pipeline reads, with node_modules linked from the checkout. */
export async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'foundation-app-'));
  for (const path of ['package.json', 'scripts', 'apps/backend', 'apps/frontend/.prettierrc', 'apps/frontend/angular.json', 'apps/frontend/sdk.config.json', 'apps/frontend/sdk', 'openapi.json']) {
    const dest = join(dir, path);
    await mkdir(join(dest, '..'), { recursive: true });
    await cp(join(root, path), dest, { recursive: true });
  }
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/**
 * Runs a root package script through `bun run`, with only PATH and HOME in the environment. The script is killed
 * after 30 seconds, the floor spec 0008 sets for sdk:generate, tsc, and api:sync, so a hang fails instead of lingering.
 */
export async function run(dir: string, script: string) {
  const p = Bun.spawn([process.execPath, '--no-env-file', 'run', script], {
    cwd: dir, env: { PATH: process.env['PATH']!, HOME: process.env['HOME']! }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000, killSignal: 'SIGKILL',
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, output: out + err };
}

/**
 * Runs `bun --no-env-file [--preload guard] ...args` directly, so the script process output contract can be
 * asserted without the `bun run` wrapper lines. The environment holds only PATH, HOME, and `env`.
 * The process is killed after 10 seconds.
 */
export async function runBun(dir: string, args: string[], options: { env?: Record<string, string>; guard?: boolean } = {}) {
  const p = Bun.spawn([process.execPath, '--no-env-file', ...(options.guard ? ['--preload', guardPreload] : []), ...args], {
    cwd: dir,
    env: { PATH: process.env['PATH']!, HOME: process.env['HOME']!, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, stdout, stderr };
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
