import { describe, expect, test } from 'bun:test';
import { RedisCache } from '../../server/cache';

describe('cache input boundaries', () => {
  test('rejects prefixes that could widen a clear operation', () => {
    for (const prefix of ['', '*', 'app:other', 'app?']) {
      expect(() => new RedisCache({ url: 'redis://127.0.0.1:6379', prefix })).toThrow();
    }
  });

  test('rejects invalid TTLs and values before connecting', async () => {
    const cache = new RedisCache({ url: 'redis://127.0.0.1:1', prefix: 'validation' });
    await expect(cache.put('test', 'value', 0)).rejects.toThrow();
    await expect(cache.put('test', undefined, 1)).rejects.toThrow();
    await expect(cache.add('test', 'value', 1.5)).rejects.toThrow();
    await expect(cache.increment('test', 0.5)).rejects.toThrow();
    await expect(cache.lock('test', -10)).rejects.toThrow();
    await cache.close();
  });
});
