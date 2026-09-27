import { readdir } from 'node:fs/promises';
const manifest = await Bun.file('package.json').json();
const ids = new Set<string>();
for (const name of await readdir('tests/scenarios')) {
  if (!name.endsWith('.json')) continue;
  const registry = await Bun.file(`tests/scenarios/${name}`).json();
  const source = await Bun.file(registry.source).text();
  for (const scenario of registry.scenarios) {
    if (!/^[A-Z]+-\d{3}$/.test(scenario.id) || ids.has(scenario.id)) throw new Error('Invalid or duplicate scenario ID');
    ids.add(scenario.id);
    for (const criterion of scenario.criteria ?? []) if (!source.includes(criterion)) throw new Error(`Missing criterion for ${scenario.id}`);
    const checks = scenario.checks ?? [scenario];
    if (checks.length === 0) throw new Error(`Missing checks for ${scenario.id}`);
    for (const check of checks) {
      const content = await Bun.file(check.file).text();
      if (!manifest.scripts[check.script]) throw new Error(`Missing script for ${scenario.id}`);
      if (check.runner !== 'command' && (!check.testTag || !content.includes(check.testTag))) throw new Error(`Missing test tag for ${scenario.id}`);
      if (!['command', 'bun:test', 'vitest', 'playwright'].includes(check.runner)) throw new Error('Unknown scenario runner');
    }
  }
}
console.log(`Scenario references passed (${ids.size} unique IDs). Execution results remain runner evidence.`);
