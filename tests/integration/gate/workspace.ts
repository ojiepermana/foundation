import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Fixture workspaces for the gate suite (spec 0010, key invariant 12): every fixture file is written at runtime in a
// `mkdtemp` folder outside the repository, so no file that matches the discovery pattern is committed as a fixture.

const created: string[] = [];

/** A new empty folder under the system temporary directory, removed by `removeWorkspaces`. */
export async function emptyWorkspace(prefix = 'foundation-gate-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Writes `files` (repository path to content) under `dir`, creating folders as needed. */
export async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

/** A new workspace holding `files`. */
export async function workspace(files: Readonly<Record<string, string>>, prefix?: string): Promise<string> {
  const dir = await emptyWorkspace(prefix);
  await writeFiles(dir, files);
  return dir;
}

/** Creates a symlink at `path` (a repository path under `dir`) that points to `target`. */
export async function link(dir: string, path: string, target: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await symlink(target, join(dir, path));
}

export async function removeWorkspaces(): Promise<void> {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** Collects console lines written through the `log` and `error` callbacks of a gate command. */
export function lines(): { log: (line: string) => void; error: (line: string) => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { log: (line) => out.push(line), error: (line) => err.push(line), out, err };
}
