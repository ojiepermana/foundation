import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
const ignored = new Set(['node_modules', '.git', '.angular', 'dist', '.local', 'coverage', 'playwright-report', 'test-results']);
const issues: string[] = [];
async function walk(directory: string, root = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (!root && (entry.name === 'package.json' || entry.name === 'node_modules' || entry.name === 'bun.lock')) issues.push(path);
    if (['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(entry.name)) issues.push(path);
    if (entry.isDirectory() && !ignored.has(entry.name)) await walk(path);
  }
}
await walk(process.cwd(), true);
if (issues.length) { console.error('Struktur dependensi tidak sesuai:', issues); process.exit(1); }
const pkg = await Bun.file('package.json').json();
if (pkg.workspaces) throw new Error('Gunakan satu manifest root, tanpa workspaces.');
if (Bun.version !== '1.4.2') throw new Error(`Bun 1.4.2 diperlukan, ditemukan ${Bun.version}.`);
console.log('Struktur satu manifest dan satu instalasi root valid.');
