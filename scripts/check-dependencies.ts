import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = await Bun.file('package.json').json();
if (process.versions.node !== manifest.engines.node || Bun.version !== manifest.engines.bun) {
  // Bun embeds Node compatibility versions, so inspect the actual Angular CLI runtime.
  const node = Bun.spawnSync(['node', '-p', 'process.versions.node']);
  if (node.exitCode !== 0 || node.stdout.toString().trim() !== manifest.engines.node || Bun.version !== manifest.engines.bun) throw new Error('Pinned runtime mismatch');
}
for (const [name, version] of Object.entries<string>({ ...manifest.dependencies, ...manifest.devDependencies })) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Dependency must have an exact version: ${name}`);
  const installed = await Bun.file(`node_modules/${name}/package.json`).json();
  if (installed.version !== version) throw new Error(`Installed version mismatch: ${name}`);
  if (installed.engines?.node && !Bun.semver.satisfies(manifest.engines.node, installed.engines.node)) throw new Error(`Node engine mismatch: ${name}`);
  for (const [peer, range] of Object.entries<string>(installed.peerDependencies ?? {})) {
    const file = Bun.file(`node_modules/${peer}/package.json`);
    if (!await file.exists()) {
      if (installed.peerDependenciesMeta?.[peer]?.optional) continue;
      throw new Error(`Required peer absent: ${name} -> ${peer}`);
    }
    const target = await file.json();
    if (!Bun.semver.satisfies(target.version, range)) throw new Error(`Peer conflict: ${name} -> ${peer}`);
  }
}
async function inspect(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.angular', '.git'].includes(entry.name)) continue;
    if (entry.name === 'package.json' || ['bun.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(entry.name)) throw new Error('Nested package manifest or lockfile forbidden');
    if (entry.isDirectory()) await inspect(join(path, entry.name));
  }
}
await inspect('apps');
console.log('Exact dependency pins, runtime engines and installed peers passed');
