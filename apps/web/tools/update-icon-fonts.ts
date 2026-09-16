/** Regenerate the self hosted variable icon fonts after adding icons or upgrading the UI library. */
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '../../..');
const fontDir = join(root, 'apps/web/public/fonts');
const names = new Set(['add', 'arrow_back', 'arrow_forward', 'bar_chart', 'check', 'check_circle', 'chevron_left', 'chevron_right', 'close', 'delete', 'description', 'expand_less', 'expand_more', 'fingerprint', 'group', 'history', 'key', 'left_panel_close', 'left_panel_open', 'logout', 'manage_accounts', 'menu', 'more_horiz', 'palette', 'person', 'person_search', 'settings', 'space_dashboard', 'tune']);
const patterns = ['apps/web/src/app/**/*.{html,ts}', 'node_modules/@ojiepermana/angular/fesm2022/ojiepermana-angular-theme*.mjs', 'node_modules/@ojiepermana/angular/fesm2022/ojiepermana-angular-navigation*.mjs'];
for (const pattern of patterns) {
  for await (const file of new Bun.Glob(pattern).scan(root)) {
    const source = (await Bun.file(join(root, file)).text()).replaceAll('\\"', '"');
    for (const expression of [/\bicon:\s*'([a-z][a-z0-9_]*)'/g, /\bname="([a-z][a-z0-9_]*)"/g, /\w*[Ii]con\s*=\s*input\('([a-z][a-z0-9_]*)'/g]) {
      for (const match of source.matchAll(expression)) names.add(match[1]!);
    }
  }
}
const icons = [...names].sort().join(',');
const query = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&family=Material+Symbols+Sharp:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block&icon_names=' + icons;
const response = await fetch(query, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
if (!response.ok) throw new Error('Font stylesheet download failed: ' + response.status);
const css = await response.text();
const urls = [...css.matchAll(/src:\s*url\(([^)]+)\)/g)].map(match => match[1]!);
if (urls.length !== 2 || !urls.every(url => url.startsWith('https://fonts.gstatic.com/'))) throw new Error('Unexpected font stylesheet. Review before replacing assets.');
for (const [index, family] of ['rounded', 'sharp'].entries()) {
  const font = await fetch(urls[index]!);
  if (!font.ok) throw new Error('Font download failed: ' + font.status);
  await Bun.write(join(fontDir, `material-symbols-${family}.woff2`), await font.arrayBuffer());
}
await Bun.write(join(fontDir, 'icon-names.txt'), [...names].sort().join('\n') + '\n');
console.log(`Updated ${names.size} Material Symbols glyphs, rounded and sharp variable fonts.`);
