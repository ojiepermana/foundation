export function readConfiguration(env: Record<string, string | undefined>) {
  const mode = env['NODE_ENV'] ?? 'development';
  if (mode !== 'development' && mode !== 'production') throw new Error('Invalid NODE_ENV configuration');
  const host = env['HOST'] ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host) || (mode === 'development' && host !== '127.0.0.1')) {
    throw new Error('Invalid HOST configuration');
  }
  const rawPort = env['PORT'] ?? '8888';
  if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('Invalid PORT configuration');
  return { mode, host, port: Number(rawPort) } as const;
}
