import { describe, expect, test } from 'bun:test';
import { RedisQueue } from '../../server/queue';

const options = { url: 'redis://127.0.0.1:1', prefix: 'validation' };
describe('queue input boundaries', () => {
  test('rejects unbounded or incompatible worker settings', () => {
    expect(() => new RedisQueue({ ...options, prefix: 'all:*' })).toThrow();
    expect(() => new RedisQueue({ ...options, concurrency: 0 })).toThrow();
    expect(() => new RedisQueue({ ...options, leaseMs: 100, heartbeatMs: 50 })).toThrow();
    expect(() => new RedisQueue({ ...options, backoffMs: [] })).toThrow();
    expect(() => new RedisQueue({ ...options, backoffMs: [-1] })).toThrow();
  });

  test('rejects invalid jobs without Redis writes', async () => {
    const queue = new RedisQueue(options);
    await expect(queue.dispatch('job', {}, { delayMs: -1 })).rejects.toThrow();
    await expect(queue.dispatch('job', {}, { id: 'invalid*' })).rejects.toThrow();
    await expect(queue.dispatch('job', {}, { maxAttempts: 0 })).rejects.toThrow();
    await expect(queue.dispatch('job', undefined)).rejects.toThrow();
    await expect(queue.dispatch('job', 'a'.repeat(65_536))).rejects.toThrow();
    await queue.close();
    await expect(queue.dispatch('job', {})).rejects.toThrow('ditutup');
  });
});
