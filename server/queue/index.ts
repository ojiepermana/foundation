import { RedisClient } from 'bun';
import { log } from '../logger';
import * as lua from './lua';

export interface QueueOptions {
  url: string; prefix: string; concurrency?: number; timeoutMs?: number; leaseMs?: number;
  heartbeatMs?: number; maxAttempts?: number; backoffMs?: number[];
  completedRetentionSeconds?: number; failedRetentionSeconds?: number;
}
export interface DispatchOptions { id?: string; delayMs?: number; maxAttempts?: number }
export interface JobContext { jobId: string; attempt: number; signal: AbortSignal }
export type JobHandler = (payload: unknown, context: JobContext) => Promise<void>;
export interface JobInfo {
  id: string; name: string; state: 'ready' | 'delayed' | 'running' | 'completed' | 'failed';
  attempt: number; maxAttempts: number; createdAt: number; updatedAt: number;
  runAt: number | null; finishedAt: number | null; error: string | null;
}
type Entry = [string, string[]];

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} harus bilangan bulat positif.`);
  return value;
}
function identifier(value: string, name: string): string {
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) throw new Error(`${name} tidak valid.`);
  return value;
}
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * At least once queue using Redis Streams and server clock leases.
 * Handlers must honor AbortSignal and make external effects idempotent. A timeout fences
 * queue state, but JavaScript cannot forcibly cancel arbitrary I/O already sent by a handler.
 * This implementation targets a single Redis primary (not Redis Cluster).
 */
export class RedisQueue {
  private readonly redis: RedisClient;
  private readonly namespace: string;
  private readonly stream: string;
  private readonly delayed: string;
  private readonly failedKey: string;
  private readonly jobs: string;
  private readonly group = 'workers';
  private readonly config: Required<Omit<QueueOptions, 'url' | 'prefix'>>;
  private activeWork?: Promise<void>;
  private controller?: AbortController;
  private closed = false;

  constructor(options: QueueOptions) {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.prefix)) throw new Error('Prefix queue tidak valid.');
    this.namespace = `${options.prefix}:queue:`;
    this.stream = `${this.namespace}ready`;
    this.delayed = `${this.namespace}delayed`;
    this.failedKey = `${this.namespace}failed`;
    this.jobs = `${this.namespace}job:`;
    this.config = {
      concurrency: options.concurrency ?? 4, timeoutMs: options.timeoutMs ?? 30_000,
      leaseMs: options.leaseMs ?? 60_000, heartbeatMs: options.heartbeatMs ?? 15_000,
      maxAttempts: options.maxAttempts ?? 5, backoffMs: options.backoffMs ?? [1_000, 5_000, 15_000, 60_000],
      completedRetentionSeconds: options.completedRetentionSeconds ?? 86_400,
      failedRetentionSeconds: options.failedRetentionSeconds ?? 2_592_000,
    };
    for (const [name, value] of Object.entries(this.config)) {
      if (typeof value === 'number') positive(value, name);
    }
    if (this.config.heartbeatMs * 2 >= this.config.leaseMs) throw new Error('Heartbeat harus kurang dari setengah durasi lease.');
    if (this.config.backoffMs.length === 0 || this.config.backoffMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error('Backoff harus berisi durasi dalam milidetik.');
    }
    this.redis = new RedisClient(options.url, { connectionTimeout: 2_000, maxRetries: 2 });
  }

  private assertOpen(): void { if (this.closed) throw new Error('Queue sudah ditutup.'); }
  private job(id: string): string { return `${this.jobs}${identifier(id, 'ID job')}`; }

  async dispatch(name: string, payload: unknown, options: DispatchOptions = {}): Promise<string> {
    this.assertOpen();
    identifier(name, 'Nama job');
    const id = options.id ?? crypto.randomUUID();
    const delayMs = options.delayMs ?? 0;
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error('Delay harus berupa milidetik, minimal nol.');
    const maxAttempts = positive(options.maxAttempts ?? this.config.maxAttempts, 'maxAttempts');
    const encoded = JSON.stringify(payload);
    if (encoded === undefined) throw new Error('Payload job harus dapat disimpan sebagai JSON.');
    if (Buffer.byteLength(encoded) > 65_536) throw new Error('Payload job maksimal 64 KiB, gunakan referensi data.');
    return String(await this.redis.eval(lua.dispatch, 3, this.job(id), this.stream, this.delayed,
      id, name, encoded, delayMs, maxAttempts));
  }

  async inspect(id: string): Promise<JobInfo | null> {
    this.assertOpen();
    const fields = ['id', 'name', 'state', 'attempt', 'maxAttempts', 'createdAt', 'updatedAt', 'runAt', 'finishedAt', 'error'];
    const values = await this.redis.send('HMGET', [this.job(id), ...fields]) as (string | null)[];
    if (values[0] === null) return null;
    return {
      id: values[0]!, name: values[1]!, state: values[2] as JobInfo['state'], attempt: Number(values[3]),
      maxAttempts: Number(values[4]), createdAt: Number(values[5]), updatedAt: Number(values[6]),
      runAt: values[7] === null ? null : Number(values[7]), finishedAt: values[8] === null ? null : Number(values[8]),
      error: values[9],
    };
  }

  async failed(options: { limit?: number } = {}): Promise<JobInfo[]> {
    this.assertOpen();
    const limit = positive(options.limit ?? 50, 'limit');
    if (limit > 1_000) throw new Error('Limit maksimal 1000.');
    const ids = await this.redis.send('ZREVRANGE', [this.failedKey, '0', String(limit - 1)]) as string[];
    const result: JobInfo[] = [];
    for (const id of ids) {
      const job = await this.inspect(id);
      if (job?.state === 'failed') result.push(job);
      else await this.redis.send('ZREM', [this.failedKey, id]);
    }
    return result;
  }

  async retry(id: string): Promise<void> {
    this.assertOpen();
    const result = await this.redis.eval(lua.retry, 3, this.job(id), this.stream, this.failedKey);
    if (Number(result) !== 1) throw new Error('Job tidak ditemukan atau statusnya bukan gagal.');
  }

  async work(handlers: Record<string, JobHandler>, options: { signal?: AbortSignal; concurrency?: number } = {}): Promise<void> {
    this.assertOpen();
    if (this.activeWork) throw new Error('Worker pada instance ini sudah berjalan.');
    const concurrency = positive(options.concurrency ?? this.config.concurrency, 'concurrency');
    const controller = new AbortController();
    this.controller = controller;
    const stop = () => controller.abort();
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    this.activeWork = this.run(handlers, concurrency, controller);
    try { await this.activeWork; }
    finally {
      options.signal?.removeEventListener('abort', stop);
      this.activeWork = undefined;
      this.controller = undefined;
    }
  }

  private async run(handlers: Record<string, JobHandler>, concurrency: number, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return;
    try { await this.redis.send('XGROUP', ['CREATE', this.stream, this.group, '0', 'MKSTREAM']); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error; }
    const workers = Array.from({ length: concurrency }, () => this.loop(handlers, crypto.randomUUID(), controller.signal)
      .catch((error: unknown) => { controller.abort(); throw error; }));
    const results = await Promise.allSettled(workers);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private async loop(handlers: Record<string, JobHandler>, consumer: string, signal: AbortSignal): Promise<void> {
    let cursor = '0-0';
    while (!signal.aborted) {
      await this.redis.eval(lua.promote, 3, this.delayed, this.stream, this.failedKey,
        this.jobs, this.config.failedRetentionSeconds * 1_000);
      const reclaimed = await this.redis.send('XAUTOCLAIM', [this.stream, this.group, consumer,
        String(this.config.leaseMs), cursor, 'COUNT', '1']) as [string, Entry[], string[]];
      cursor = reclaimed[0];
      let entry = reclaimed[1][0];
      if (!entry) {
        // Nonblocking reads keep control/heartbeat commands independent of stream waiting.
        const fresh = await this.redis.send('XREADGROUP', ['GROUP', this.group, consumer, 'COUNT', '1', 'STREAMS', this.stream, '>']);
        // Bun speaks RESP3 (stream map); accept RESP2 tuples as well.
        entry = Array.isArray(fresh) ? fresh[0]?.[1]?.[0] : fresh?.[this.stream]?.[0];
      }
      if (!entry) { await pause(50, signal); continue; }
      const idIndex = entry[1].indexOf('id');
      const id = entry[1][idIndex + 1];
      if (idIndex < 0 || !id) throw new Error('Entri stream tidak valid.');
      const owner = crypto.randomUUID();
      const acquired = await this.redis.eval(lua.acquire, 3, this.job(id), this.stream, this.failedKey,
        this.group, entry[0], consumer, owner, this.config.leaseMs, this.config.failedRetentionSeconds) as [string, string, string] | null;
      if (acquired) await this.execute(id, acquired, owner, consumer, handlers, signal);
    }
  }

  private async execute(id: string, data: [string, string, string], owner: string, consumer: string,
    handlers: Record<string, JobHandler>, workSignal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const attempt = Number(data[2]);
    log('info', 'job.started', { jobId: id, attempt });
    let errorCode = '';
    let lostOwnership = false;
    let heartbeatFailure: unknown;
    let heartbeatTask: Promise<void> = Promise.resolve();
    let heartbeatInProgress = false;
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const cancel = (code: string) => {
      if (controller.signal.aborted) return;
      errorCode = code;
      controller.abort(new Error(code));
      rejectCancelled(new Error(code));
    };
    const shutdown = () => cancel('JobInterruptedError');
    workSignal.addEventListener('abort', shutdown, { once: true });
    const timeout = setTimeout(() => cancel('JobTimeoutError'), this.config.timeoutMs);
    const heartbeat = setInterval(() => {
      if (heartbeatInProgress || controller.signal.aborted) return;
      heartbeatInProgress = true;
      heartbeatTask = (async () => {
        try {
          const renewed = await this.redis.eval(lua.heartbeat, 2, this.job(id), this.stream,
            owner, this.group, consumer, this.config.leaseMs);
          if (Number(renewed) !== 1) { lostOwnership = true; cancel('JobOwnershipLostError'); }
        } catch (error) {
          heartbeatFailure = error;
          lostOwnership = true;
          cancel('JobOwnershipLostError');
        } finally { heartbeatInProgress = false; }
      })();
    }, this.config.heartbeatMs);
    try {
      if (workSignal.aborted) shutdown();
      const handler = Object.hasOwn(handlers, data[0]) ? handlers[data[0]] : undefined;
      if (!handler) { errorCode = 'MissingHandlerError'; throw new Error(errorCode); }
      const payload: unknown = JSON.parse(data[1]);
      // Race enforces queue attempt deadlines. The cancelled handler may still unwind;
      // late resolution cannot acknowledge or alter the job belonging to a newer attempt.
      await Promise.race([cancelled, Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return handler(payload, { jobId: id, attempt, signal: controller.signal });
      })]);
    } catch {
      if (!errorCode) errorCode = 'JobExecutionError';
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      workSignal.removeEventListener('abort', shutdown);
      // Attach a rejection handler even when decoding or missing-handler checks failed first.
      void cancelled.catch(() => {});
      await heartbeatTask;
    }
    if (heartbeatFailure) throw heartbeatFailure;
    if (lostOwnership) { log('warn', 'job.ownership_lost', { jobId: id, attempt }); return; }
    const backoff = this.config.backoffMs[Math.min(attempt - 1, this.config.backoffMs.length - 1)]!;
    const finished = await this.redis.eval(lua.finish, 4, this.job(id), this.stream, this.delayed, this.failedKey,
      owner, this.group, errorCode, backoff, this.config.completedRetentionSeconds, this.config.failedRetentionSeconds);
    if (Number(finished) !== 1) log('warn', 'job.ownership_lost', { jobId: id, attempt });
    else log(errorCode ? 'warn' : 'info', errorCode ? 'job.attempt_failed' : 'job.completed', { jobId: id, attempt, errorCode });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.controller?.abort();
    await this.activeWork?.catch(() => {});
    this.closed = true;
    this.redis.close();
  }
}
