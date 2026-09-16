export {};
const commands = [['bun', 'run', 'dev:api'], ['bun', 'run', 'dev:worker'], ['bun', 'run', 'dev:web']];
const children = commands.map(cmd => Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }));
let stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  children.forEach(child => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const force = setTimeout(() => children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); }), 5000);
  await Promise.all(children.map(child => child.exited)); clearTimeout(force); process.exit(code);
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
await Promise.race(children.map(async child => { const code = await child.exited; if (!stopping) await stop(code || 1); }));
