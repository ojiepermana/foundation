import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

async function snapshot(): Promise<string> {
  const files = ['openapi.json'];
  async function visit(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
      else throw new Error('Unexpected SDK filesystem entry');
    }
  }
  await visit('apps/frontend/sdk');
  const manifest = await Bun.file('apps/frontend/sdk/.ojiepermana-sdk-manifest.json').json();
  if (manifest.version !== 1 || !Array.isArray(manifest.files) ||
      manifest.files.some((file: unknown) => typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => part === '..' || part === '.')) ||
      new Set(manifest.files).size !== manifest.files.length) throw new Error('OpenAPI or SDK drift detected: invalid generator manifest');
  const expected = ['openapi.json', 'apps/frontend/sdk/.ojiepermana-sdk-manifest.json', ...manifest.files.map((file: string) => `apps/frontend/sdk/${file}`)].sort();
  if (JSON.stringify(files.sort()) !== JSON.stringify(expected)) throw new Error('OpenAPI or SDK drift detected: SDK inventory differs from generator manifest');
  return JSON.stringify(await Promise.all(files.sort().map(async path => [path, await Bun.file(path).text()])));
}
const root = resolve(import.meta.dir, '..');
process.chdir(root);
const before = await snapshot();
for (let i = 0; i < 2; i++) {
  const child = Bun.spawn([process.execPath, 'run', 'api:sync'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error('API synchronization failed');
  if (await snapshot() !== before) throw new Error('OpenAPI or SDK drift detected');
}
console.log('OpenAPI and SDK match stored artifacts across two runs');
