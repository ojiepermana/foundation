import { expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RedisQueue } from '../../server/queue';
import { acquire } from '../../server/queue/lua';

test.skipIf(!Bun.which('redis-server'))('isolated Redis AOF restart preserves ready, delayed, and pending jobs', async () => {
  // This test changes only its own temporary Redis instance. The shared service is never reconfigured.
  const reservation = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop(true);
  const directory = await mkdtemp(join(tmpdir(), 'foundation-redis-test-'));
  const url = `redis://127.0.0.1:${port}`;
  const prefix = `restart_${crypto.randomUUID().replaceAll('-', '')}`;
  const arguments_ = ['redis-server', '--bind', '127.0.0.1', '--port', String(port), '--dir', directory,
    '--appendonly', 'yes', '--appendfsync', 'always', '--save', '', '--loglevel', 'warning'];
  let process_ = Bun.spawn(arguments_, { stdout: 'ignore', stderr: 'ignore' });
  let raw: RedisClient | undefined;
  const queues: RedisQueue[] = [];
  let work: Promise<void> | undefined;

  const connect = async (): Promise<RedisClient> => {
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      const candidate = new RedisClient(url, { connectionTimeout: 100, maxRetries: 0, autoReconnect: false });
      try { await candidate.send('PING', []); return candidate; }
      catch { candidate.close(); await Bun.sleep(30); }
    }
    throw new Error('Redis pengujian tidak tersedia.');
  };

  try {
    raw = await connect();
    const q = new RedisQueue({ url, prefix }); queues.push(q);
    const pending = await q.dispatch('restart', { kind: 'pending' });
    const stream = `${prefix}:queue:ready`;
    await raw.send('XGROUP', ['CREATE', stream, 'workers', '0']);
    const read = await raw.send('XREADGROUP', ['GROUP', 'workers', 'crashed', 'COUNT', '1', 'STREAMS', stream, '>']);
    await raw.eval(acquire, 3, `${prefix}:queue:job:${pending}`, stream, `${prefix}:queue:failed`,
      'workers', read[stream][0][0], 'crashed', 'previous-owner', 200, 60);
    const ready = await q.dispatch('restart', { kind: 'ready' });
    const delayed = await q.dispatch('restart', { kind: 'delayed' }, { delayMs: 300 });
    await q.close(); raw.close(); raw = undefined;
    // SIGKILL proves recovery uses persisted AOF rather than a graceful shutdown snapshot.
    process_.kill('SIGKILL'); await process_.exited;
    process_ = Bun.spawn(arguments_, { stdout: 'ignore', stderr: 'ignore' });
    raw = await connect();
    const recovered = new RedisQueue({ url, prefix, leaseMs: 200, heartbeatMs: 40 }); queues.push(recovered);
    const seen = new Set<string>();
    work = recovered.work({ restart: async (payload) => { seen.add((payload as { kind: string }).kind); } }, { concurrency: 2 });
    void work.catch(() => {});
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      const jobs = await Promise.all([pending, ready, delayed].map((id) => recovered.inspect(id)));
      if (jobs.every((job) => job?.state === 'completed')) break;
      await Bun.sleep(20);
    }
    expect((await recovered.inspect(pending))?.state).toBe('completed');
    expect((await recovered.inspect(pending))?.attempt).toBe(2);
    expect((await recovered.inspect(ready))?.state).toBe('completed');
    expect((await recovered.inspect(delayed))?.state).toBe('completed');
    expect([...seen].sort()).toEqual(['delayed', 'pending', 'ready']);
  } finally {
    await Promise.all(queues.map((q) => q.close()));
    await work;
    raw?.close();
    process_.kill('SIGTERM'); await process_.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
