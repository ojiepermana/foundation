import { cp, lstat, mkdir, readdir, readlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Inputs, outputs, and byte comparison of the OpenAPI and SDK artifacts (spec 0009, *Modul artefak*, `API_INPUTS`,
// and the *Pembandingan* and *Laporan* rows of Value sourcing). Nothing here prints; callers print fixed text.

/** Paths the regeneration reads, in a fixed order. Each one is copied when it exists. */
export const API_INPUTS: readonly string[] = [
  'package.json',
  'scripts/',
  'apps/backend/',
  'libs/',
  'apps/frontend/angular.json',
  'apps/frontend/sdk.config.json',
  'apps/frontend/.prettierrc',
  'apps/frontend/.editorconfig',
];

/** Paths `api:sync` writes and `api:check` compares. */
export const API_OUTPUTS: readonly string[] = ['openapi.json', 'apps/frontend/sdk/'];

const sdkPath = 'apps/frontend/sdk';

/** Names never copied, at any level: local environment files and build or dependency folders. */
function skippedName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || name === 'node_modules' || name === 'dist' || name === '.angular';
}

function inputPath(input: string): string {
  return input.endsWith('/') ? input.slice(0, -1) : input;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/**
 * True for a relative target whose lexical result is also where the link physically leads in the workspace copy:
 * `..` only as a leading run that stays inside `root`, then plain names, none of them `node_modules`. The leading
 * `..` climb through real directories that were checked with `lstat`, and every symlink a plain name meets is checked
 * by the same rule, so no link can climb through another link or through the `node_modules` link of the workspace.
 */
function staysInside(root: string, link: string, target: string): boolean {
  if (isAbsolute(target)) return false;
  const segments = target.split('/').filter((segment) => segment !== '' && segment !== '.');
  const climb = segments.findIndex((segment) => segment !== '..');
  const names = climb === -1 ? [] : segments.slice(climb);
  if (names.includes('..') || names.includes('node_modules')) return false;
  return inside(root, resolve(dirname(link), ...segments.slice(0, climb === -1 ? segments.length : climb)));
}

/** Rejects a symlink whose target is absolute or may lead outside `root` (see `staysInside`); it is never followed. */
async function checkSymlinks(root: string, path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    if (!staysInside(root, path, await readlink(path))) {
      throw new Error('API input symlink points outside the checkout');
    }
    return;
  }
  if (!stats.isDirectory()) return;
  for (const name of await readdir(path)) {
    if (!skippedName(name)) await checkSymlinks(root, join(path, name));
  }
}

/**
 * True when `path` exists below `root`. Every parent segment of it, such as `apps` for `apps/backend`, must be a real
 * directory read with `lstat`, so an input is never copied from wherever a symlinked parent leads.
 */
async function inputExists(root: string, path: string): Promise<boolean> {
  const segments = path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const parent = await lstatOrNull(join(root, ...segments.slice(0, index)));
    if (parent === null) return false;
    if (!parent.isDirectory()) throw new Error('API input path passes through an entry that is not a directory');
  }
  return (await lstatOrNull(join(root, path))) !== null;
}

/**
 * Copies every existing `API_INPUTS` path from `root` into `target`. Symlinks are copied as they are, with the same
 * target text, after every one of them, including a top level input, was checked with `staysInside`, and every
 * parent segment of an input was checked to be a real directory. `.env`, `.env.*`, `node_modules`, `dist`, and
 * `.angular` are skipped at every level.
 */
export async function copyApiInputs(root: string, target: string): Promise<void> {
  const checkout = resolve(root);
  const present: string[] = [];
  for (const input of API_INPUTS) {
    const path = inputPath(input);
    if (!(await inputExists(checkout, path))) continue;
    await checkSymlinks(checkout, join(checkout, path));
    present.push(path);
  }
  for (const path of present) {
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(checkout, path), destination, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => !skippedName(basename(source)),
    });
  }
}

export type ArtifactEntry = { kind: 'file'; size: number } | { kind: 'other' };

/** Every non directory entry below `directory`, keyed by its path relative to `root` with `/`; nothing is opened. */
async function readTree(root: string, directory: string, entries: Map<string, ArtifactEntry>): Promise<void> {
  for (const name of await readdir(join(root, directory))) {
    const path = `${directory}/${name}`;
    const stats = await lstat(join(root, path));
    if (stats.isDirectory()) await readTree(root, path, entries);
    else entries.set(path, stats.isFile() ? { kind: 'file', size: stats.size } : { kind: 'other' });
  }
}

/**
 * The artifacts under `root`: `openapi.json` and every entry below `apps/frontend/sdk/`, read with `lstat` and never
 * followed or opened. When `apps`, `apps/frontend`, or `apps/frontend/sdk` exists but is not a real directory, the SDK
 * folder is one `other` entry. Empty directories add nothing.
 */
export async function readArtifacts(root: string): Promise<Map<string, ArtifactEntry>> {
  const entries = new Map<string, ArtifactEntry>();
  const openapi = await lstatOrNull(join(root, 'openapi.json'));
  if (openapi) entries.set('openapi.json', openapi.isFile() ? { kind: 'file', size: openapi.size } : { kind: 'other' });

  const segments = sdkPath.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const stats = await lstatOrNull(join(root, ...segments.slice(0, index)));
    if (stats === null) return entries;
    if (!stats.isDirectory()) {
      entries.set(sdkPath, { kind: 'other' });
      return entries;
    }
  }
  await readTree(root, sdkPath, entries);
  return entries;
}

/** SHA-256 of the raw bytes, read as a stream. */
async function fileHash(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

export type ArtifactDiff = { added: string[]; changed: string[]; removed: string[] };

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function sameEntry(beforeRoot: string, afterRoot: string, path: string, before: ArtifactEntry, after: ArtifactEntry) {
  // Only a pair of regular files of equal size is ever opened. Entries that are not regular files have no bytes to
  // compare, so a pair of them counts as changed rather than equal.
  if (before.kind !== 'file' || after.kind !== 'file') return false;
  if (before.size !== after.size) return false;
  const [beforeHash, afterHash] = await Promise.all([fileHash(join(beforeRoot, path)), fileHash(join(afterRoot, path))]);
  return beforeHash === afterHash;
}

/**
 * Differences from `beforeRoot` to `afterRoot`: `added` exists only after, `removed` only before, and `changed` on both
 * sides with another entry kind or other bytes. Each list is in code unit order.
 */
export async function diffArtifacts(beforeRoot: string, afterRoot: string): Promise<ArtifactDiff> {
  const [before, after] = await Promise.all([readArtifacts(beforeRoot), readArtifacts(afterRoot)]);
  const diff: ArtifactDiff = { added: [], changed: [], removed: [] };
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(codeUnitOrder);
  for (const path of paths) {
    const beforeEntry = before.get(path);
    const afterEntry = after.get(path);
    if (beforeEntry === undefined) diff.added.push(path);
    else if (afterEntry === undefined) diff.removed.push(path);
    else if (!(await sameEntry(beforeRoot, afterRoot, path, beforeEntry, afterEntry))) diff.changed.push(path);
  }
  return diff;
}

const plainPath = /^[A-Za-z0-9._@+/-]+$/;

/** The path as is when it is plain, otherwise a double quoted literal with `\uXXXX` for every unprintable code unit. */
export function formatArtifactPath(path: string): string {
  if (plainPath.test(path)) return path;
  let literal = '"';
  for (let index = 0; index < path.length; index += 1) {
    const unit = path.charCodeAt(index);
    if (unit === 0x5c) literal += '\\\\';
    else if (unit === 0x22) literal += '\\"';
    else if (unit >= 0x20 && unit <= 0x7e) literal += path[index];
    else literal += `\\u${unit.toString(16).padStart(4, '0')}`;
  }
  return `${literal}"`;
}

const linesPerKind = 200;

/** Report lines: `added`, then `changed`, then `removed`, each in code unit order and capped at 200 lines. */
export function formatDiffLines(diff: ArtifactDiff): string[] {
  const lines: string[] = [];
  for (const kind of ['added', 'changed', 'removed'] as const) {
    const paths = [...diff[kind]].sort(codeUnitOrder);
    for (const path of paths.slice(0, linesPerKind)) lines.push(`${kind} ${formatArtifactPath(path)}`);
    if (paths.length > linesPerKind) lines.push(`... and ${paths.length - linesPerKind} more ${kind}`);
  }
  return lines;
}

/** True when the diff holds no difference. */
export function emptyDiff(diff: ArtifactDiff): boolean {
  return diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0;
}
