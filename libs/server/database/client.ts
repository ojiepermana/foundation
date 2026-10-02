import { SQL } from 'bun';

export interface DatabasePoolOptions { max?: number }

export function createDatabasePool(url: string, options: DatabasePoolOptions = {}): SQL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid database URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw new Error('Invalid database URL');
  }
  const max = options.max ?? 5;
  if (!Number.isInteger(max) || max < 1 || max > 5) throw new Error('Invalid database pool size');
  return new SQL({ url, max, connectionTimeout: 3 });
}
