const sensitive = /password|token|secret|authorization|cookie|credential|databaseUrl|redisUrl|encryptionKey|payload|html|text/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, sensitive.test(key) ? '[REDACTED]' : redact(val)]));
  return value;
}
export function log(level: 'info' | 'warn' | 'error', event: string, context: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, event, ...redact(context) as object }));
}
