import { resolve } from 'node:path';
const config = await Bun.file(new URL('../config/development.json', import.meta.url)).json();
const command = process.argv[2];
if (command !== 'serve') throw new Error('Unsupported frontend command');
const child = Bun.spawn(['node', resolve('node_modules/@angular/cli/bin/ng.js'), 'serve', '--host', config.host, '--port', String(config.frontend.port), '--proxy-config', config.frontend.proxyConfig], {
  cwd: config.frontend.workspace, stdout: 'inherit', stderr: 'inherit',
  env: { PATH: process.env['PATH'], HOME: process.env['HOME'], NODE_ENV: 'development' },
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.kill(signal));
process.exitCode = await child.exited;
