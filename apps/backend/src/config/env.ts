/**
 * `PUBLIC_ORIGIN` of spec 0014 (table *Konfigurasi*): required in production and optional in development. A value must
 * be exactly `new URL(value).origin`, so a path, query, userinfo, trailing slash, default port, or upper case host is
 * refused, with scheme `https:` in production and `http:` or `https:` in development. Without a value, development
 * allows the fixed origins of the auth plugin; production never has a default.
 */
function publicOrigin(mode: 'development' | 'production', value: string | undefined): string | undefined {
  if (value === undefined && mode === 'development') return undefined;
  let parsed: URL | undefined;
  try { parsed = value === undefined ? undefined : new URL(value); } catch { parsed = undefined; }
  const schemes = mode === 'production' ? ['https:'] : ['http:', 'https:'];
  if (parsed === undefined || parsed.origin !== value || !schemes.includes(parsed.protocol)) throw new Error('Invalid PUBLIC_ORIGIN configuration');
  return value;
}

export function readConfiguration(env: Record<string, string | undefined>) {
  const mode = env['NODE_ENV'] ?? 'development';
  if (mode !== 'development' && mode !== 'production') throw new Error('Invalid NODE_ENV configuration');
  const host = env['HOST'] ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host) || (mode === 'development' && host !== '127.0.0.1')) {
    throw new Error('Invalid HOST configuration');
  }
  const rawPort = env['PORT'] ?? '8888';
  if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('Invalid PORT configuration');
  return { mode, host, port: Number(rawPort), publicOrigin: publicOrigin(mode, env['PUBLIC_ORIGIN']) } as const;
}
