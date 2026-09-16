import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { RedisQueue, type QueueOptions, type JobInfo } from '../../server/queue';
import * as lua from '../../server/queue/lua';

const url = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';
let prefix: string;
let raw: RedisClient;
let queues: RedisQueue[];
let workers: Promise<void>[];
const settings = { timeoutMs: 1_000, leaseMs: 300, heartbeatMs: 60, backoffMs: [30, 60] };

function queue(options: Partial<QueueOptions> = {}): RedisQueue {
  const instance = new RedisQueue({ url, prefix, ...settings, ...options });
  queues.push(instance);
  return instance;
}
async function waitFor<T>(read: () => Promise<T>, match: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (match(value)) return value;
    await Bun.sleep(15);
  }
  throw new Error('Kondisi pengujian tidak terpenuhi dalam batas waktu.');
}
const state = (queue: RedisQueue, id: string, expected: JobInfo['state']) => waitFor(() => queue.inspect(id), (job) => job?.state === expected);
function start(queue: RedisQueue, handlers: Parameters<RedisQueue['work']>[0], concurrency = 1): void {
  const work = queue.work(handlers, { concurrency });
  workers.push(work);
  void work.catch(() => {});
}

beforeEach(() => {
  prefix = `test_queue_${crypto.randomUUID().replaceAll('-', '')}`;
  raw = new RedisClient(url);
  queues = [];
  workers = [];
});
afterEach(async () => {
  await Promise.all(queues.map((q) => q.close()));
  await Promise.all(workers);
  let cursor = '0';
  do {
    const result = await raw.send('SCAN', [cursor, 'MATCH', `${prefix}:*`, 'COUNT', '100']);
    cursor = String(result[0]);
    if (result[1].length) await raw.send('UNLINK', result[1]);
  } while (cursor !== '0');
  raw.close();
});

describe('Redis Streams jobs', () => {
  test('deterministic dispatch is idempotent and terminal jobs are retained', async () => {
    const q = queue();
    const ids = await Promise.all(Array.from({ length: 20 }, () => q.dispatch('email', { outboxId: 'one' }, { id: 'same-job' })));
    expect(new Set(ids).size).toBe(1);
    await expect(q.dispatch('email', { outboxId: 'different' }, { id: 'same-job' })).rejects.toThrow('JOB_ID_CONFLICT');
    let calls = 0;
    start(q, { email: async (payload, context) => { expect(payload).toEqual({ outboxId: 'one' }); expect(context.attempt).toBe(1); calls++; } });
    const job = await state(q, ids[0]!, 'completed');
    expect(calls).toBe(1);
    expect(job?.error).toBeNull();
    expect(Number(await raw.send('TTL', [`${prefix}:queue:job:${ids[0]}`]))).toBeGreaterThan(86_390);
    expect(Number(await raw.send('XLEN', [`${prefix}:queue:ready`]))).toBe(0);
    const pending = await raw.send('XPENDING', [`${prefix}:queue:ready`, 'workers']);
    expect(pending[0]).toBe(0);
    expect(await q.dispatch('email', { outboxId: 'one' }, { id: 'same-job' })).toBe('same-job');
    await Bun.sleep(100);
    expect(calls).toBe(1);
  });

  test('delayed jobs execute only when due; failures use backoff', async () => {
    const q = queue({ backoffMs: [100] });
    const times: number[] = [];
    const beginning = Date.now();
    const id = await q.dispatch('transient', {}, { delayMs: 180 });
    start(q, { transient: async (_payload, ctx) => { times.push(Date.now()); if (ctx.attempt === 1) throw new Error('password=do-not-store'); } });
    const job = await state(q, id, 'completed');
    expect(job?.attempt).toBe(2);
    expect(times[0]! - beginning).toBeGreaterThanOrEqual(175);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(95);
    expect(job?.error).toBeNull();
  });

  test('failed jobs expose safe diagnostics and can be retried manually', async () => {
    const q = queue({ maxAttempts: 2 });
    let succeeding = false;
    const id = await q.dispatch('failing', {});
    start(q, { failing: async () => { if (!succeeding) throw new Error('smtp://password-secret'); } });
    const job = await state(q, id, 'failed');
    expect(job?.attempt).toBe(2);
    expect(job?.error).toBe('JobExecutionError');
    expect(await q.failed()).toEqual([job!]);
    expect(JSON.stringify(job)).not.toContain('password-secret');
    succeeding = true;
    await q.retry(id);
    const recovered = await state(q, id, 'completed');
    expect(recovered?.attempt).toBe(1);
    expect(await q.failed()).toEqual([]);
    await expect(q.retry(id)).rejects.toThrow('bukan gagal');
  });

  test('two workers do not reclaim a healthy long running handler', async () => {
    const first = queue();
    const second = queue();
    const id = await first.dispatch('long', {});
    let calls = 0;
    const handler = async () => { calls++; await Bun.sleep(650); };
    start(first, { long: handler });
    await state(first, id, 'running');
    start(second, { long: handler });
    const job = await state(first, id, 'completed');
    expect(job?.attempt).toBe(1);
    expect(calls).toBe(1);
  });

  test('worker concurrency is bounded and unknown handlers fail visibly', async () => {
    const q = queue({ maxAttempts: 1 });
    let running = 0;
    let peak = 0;
    const ids = await Promise.all(Array.from({ length: 7 }, () => q.dispatch('bounded', {})));
    const unknown = await q.dispatch('unknown', {});
    start(q, { bounded: async () => { running++; peak = Math.max(peak, running); await Bun.sleep(70); running--; } }, 2);
    await Promise.all(ids.map((id) => state(q, id, 'completed')));
    expect(peak).toBe(2);
    expect((await state(q, unknown, 'failed'))?.error).toBe('MissingHandlerError');
  });

  test('timeout aborts handler and its late resolution cannot complete the next attempt', async () => {
    const q = queue({ timeoutMs: 60, maxAttempts: 1 });
    let sawAbort = false;
    let lateResolved = false;
    const id = await q.dispatch('slow', {});
    start(q, { slow: async (_payload, context) => {
      context.signal.addEventListener('abort', () => { sawAbort = true; }, { once: true });
      // Deliberately violates cooperative cancellation to prove queue transitions stay fenced.
      await Bun.sleep(180); lateResolved = true;
    } });
    expect((await state(q, id, 'failed'))?.error).toBe('JobTimeoutError');
    expect(sawAbort).toBe(true);
    await waitFor(async () => lateResolved, Boolean);
    expect((await q.inspect(id))?.state).toBe('failed');
  });

  test('expired or superseded owners cannot heartbeat, complete, or retry an attempt', async () => {
    const q = queue();
    const id = await q.dispatch('fenced', {});
    const stream = `${prefix}:queue:ready`;
    const key = `${prefix}:queue:job:${id}`;
    await raw.send('XGROUP', ['CREATE', stream, 'workers', '0']);
    const read = await raw.send('XREADGROUP', ['GROUP', 'workers', 'first', 'STREAMS', stream, '>']);
    const entry = read[stream][0][0];
    await raw.eval(lua.acquire, 3, key, stream, `${prefix}:queue:failed`, 'workers', entry, 'first', 'old-owner', 50, 60);
    await Bun.sleep(65);
    expect(await raw.eval(lua.heartbeat, 2, key, stream, 'old-owner', 'workers', 'first', 300)).toBe(0);
    await raw.send('XCLAIM', [stream, 'workers', 'second', '0', entry]);
    const current = await raw.eval(lua.acquire, 3, key, stream, `${prefix}:queue:failed`, 'workers', entry, 'second', 'new-owner', 1_000, 60);
    expect(current[2]).toBe('2');
    for (const error of ['', 'JobExecutionError']) {
      expect(await raw.eval(lua.finish, 4, key, stream, `${prefix}:queue:delayed`, `${prefix}:queue:failed`,
        'old-owner', 'workers', error, 0, 60, 60)).toBe(0);
    }
    expect(await raw.eval(lua.heartbeat, 2, key, stream, 'old-owner', 'workers', 'first', 300)).toBe(0);
    expect((await q.inspect(id))?.state).toBe('running');
    expect(await raw.eval(lua.finish, 4, key, stream, `${prefix}:queue:delayed`, `${prefix}:queue:failed`,
      'new-owner', 'workers', '', 0, 60, 60)).toBe(1);
    expect((await q.inspect(id))?.state).toBe('completed');
  });

  test('killed worker is reclaimed and effects use a durable idempotency key', async () => {
    const q = queue();
    const id = await q.dispatch('crash', {});
    const program = `
      import {RedisQueue} from './server/queue'; import {RedisClient} from 'bun';
      const prefix=process.env.TEST_PREFIX!; const r = new RedisClient(process.env.TEST_REDIS_URL!);
      const q = new RedisQueue({url:process.env.TEST_REDIS_URL!,prefix,leaseMs:300,heartbeatMs:60,timeoutMs:30000});
      await q.work({crash:async (_payload,ctx)=>{ await r.send('SET',[prefix+':effect:'+ctx.jobId,'1','NX']); await r.set(prefix+':child-ready','yes'); await new Promise(()=>{}); }},{concurrency:1});
    `;
    const child = Bun.spawn([process.execPath, '-e', program], { cwd: process.cwd(),
      env: { ...process.env, TEST_PREFIX: prefix, TEST_REDIS_URL: url }, stdout: 'pipe', stderr: 'pipe' });
    try {
      await waitFor(() => raw.get(`${prefix}:child-ready`), (value) => value === 'yes');
      child.kill('SIGKILL'); await child.exited;
      let effects = 0;
      start(q, { crash: async (_payload, ctx) => {
        if (await raw.send('SET', [`${prefix}:effect:${ctx.jobId}`, '1', 'NX'])) effects++;
      } });
      expect((await state(q, id, 'completed'))?.attempt).toBe(2);
      expect(effects).toBe(0);
      expect(await raw.get(`${prefix}:effect:${id}`)).toBe('1');
    } finally { child.kill('SIGKILL'); await child.exited; }
  });

  test('expired crashed attempt at its limit becomes failed without executing again', async () => {
    const q = queue({ maxAttempts: 1 });
    const id = await q.dispatch('exhausted', {});
    const stream = `${prefix}:queue:ready`;
    await raw.send('XGROUP', ['CREATE', stream, 'workers', '0']);
    const read = await raw.send('XREADGROUP', ['GROUP', 'workers', 'dead', 'STREAMS', stream, '>']);
    await raw.eval(lua.acquire, 3, `${prefix}:queue:job:${id}`, stream, `${prefix}:queue:failed`,
      'workers', read[stream][0][0], 'dead', 'dead-token', 50, 60);
    let calls = 0;
    start(q, { exhausted: async () => { calls++; } });
    expect((await state(q, id, 'failed'))?.error).toBe('JobLeaseExpiredError');
    expect(calls).toBe(0);
  });
});
