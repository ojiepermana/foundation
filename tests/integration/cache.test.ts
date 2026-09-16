import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { RedisCache } from '../../server/cache';

const url = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';
let prefix: string;
let raw: RedisClient;
let cache: RedisCache;
let other: RedisCache;

beforeEach(() => {
  prefix = `test_cache_${crypto.randomUUID().replaceAll('-', '')}`;
  raw = new RedisClient(url);
  cache = new RedisCache({ url, prefix });
  other = new RedisCache({ url, prefix });
});
afterEach(async () => {
  await cache.close(); await other.close();
  let cursor = '0';
  do {
    const result = await raw.send('SCAN', [cursor, 'MATCH', `${prefix}:*`, 'COUNT', '100']);
    cursor = String(result[0]);
    if (result[1].length) await raw.send('UNLINK', result[1]);
  } while (cursor !== '0');
  raw.close();
});

describe('Redis cache', () => {
  test('stores JSON with expiry, remembers null, and forgets values', async () => {
    await cache.put('value', { enabled: true }, 1);
    expect(await other.get<{ enabled: boolean }>('value')).toEqual({ enabled: true });
    let calls = 0;
    const factory = async () => { calls++; return null; };
    await cache.remember('null', 5, factory);
    await cache.remember('null', 5, factory);
    expect(calls).toBe(1);
    expect(await other.forget('null')).toBe(true);
    expect(await cache.forget('missing')).toBe(false);
    await Bun.sleep(1_050);
    expect(await cache.get('value')).toBeNull();
  });

  test('only one atomic add wins and counters retain their original TTL', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, n) => (n % 2 ? cache : other).add('once', n, 30)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await cache.increment('count', 2, 30);
    await other.increment('count', 3, 300);
    expect(await cache.get<number>('count')).toBe(5);
    expect(Number(await raw.send('TTL', [`${prefix}:cache:data:count`]))).toBeLessThanOrEqual(30);
  });

  test('counter increments remain atomic across processes', async () => {
    const program = `import {RedisCache} from './server/cache'; const cache = new RedisCache({url:process.env.TEST_REDIS_URL!,prefix:process.env.TEST_PREFIX!}); await Promise.all(Array.from({length:25},()=>cache.increment('process-count',1,30))); await cache.close();`;
    const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, '-e', program], {
      cwd: process.cwd(), env: { ...process.env, TEST_REDIS_URL: url, TEST_PREFIX: prefix }, stderr: 'pipe', stdout: 'pipe',
    }));
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual([0, 0, 0]);
    expect(await cache.get<number>('process-count')).toBe(75);
  });

  test('counter overflow is rejected before changing the value', async () => {
    await cache.put('large', Number.MAX_SAFE_INTEGER, 60);
    await expect(cache.increment('large')).rejects.toThrow('CACHE_COUNTER_OVERFLOW');
    expect(await cache.get<number>('large')).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('expired lock owner cannot release or extend its replacement', async () => {
    const first = await cache.lock('resource', 70);
    expect(first).not.toBeNull();
    expect(await other.lock('resource', 70)).toBeNull();
    await Bun.sleep(100);
    const second = await other.lock('resource', 1_000);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);
    expect(await first!.release()).toBe(false);
    expect(await first!.renew(5_000)).toBe(false);
    expect(await second!.renew(2_000)).toBe(true);
    expect(await second!.release()).toBe(true);
  });

  test('clear preserves queue, locks, and another namespace', async () => {
    const sibling = `${prefix}:neighbor`;
    await cache.put('first', 1, 60); await cache.put('second', 2, 60);
    await raw.set(`${prefix}:queue:proof`, 'queue'); await raw.set(sibling, 'neighbor');
    const lock = await cache.lock('active', 5_000);
    expect(await cache.clear()).toBe(2);
    expect(await raw.get(`${prefix}:queue:proof`)).toBe('queue');
    expect(await raw.get(sibling)).toBe('neighbor');
    expect(await other.lock('active', 5_000)).toBeNull();
    expect(await lock!.release()).toBe(true);
  });
});
