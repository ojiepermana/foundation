import { RedisClient } from 'bun';

export interface CacheOptions { url: string; prefix: string }
export interface CacheLock {
  readonly token: string;
  release(): Promise<boolean>;
  renew(ttlMs: number): Promise<boolean>;
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} harus bilangan bulat positif.`);
}

/** JSON values and counters share a data namespace; locks use a separate namespace. */
export class RedisCache {
  private readonly redis: RedisClient;
  private readonly namespace: string;

  constructor(options: CacheOptions) {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.prefix)) throw new Error('Prefix cache tidak valid.');
    this.namespace = `${options.prefix}:cache:`;
    this.redis = new RedisClient(options.url, { connectionTimeout: 2_000, maxRetries: 2 });
  }

  private key(key: string): string {
    if (!key || key.length > 512) throw new Error('Nama key cache wajib diisi, maksimal 512 karakter.');
    return `${this.namespace}data:${key}`;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.redis.get(this.key(key));
    return value === null ? null : JSON.parse(value) as T;
  }

  async put<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    positive(ttlSeconds, 'TTL');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Nilai cache harus dapat disimpan sebagai JSON.');
    await this.redis.send('SET', [this.key(key), encoded, 'EX', String(ttlSeconds)]);
  }

  async remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    positive(ttlSeconds, 'TTL');
    // Null is a valid cached JSON value. Check raw presence instead of get()'s miss sentinel.
    const cached = await this.redis.get(this.key(key));
    if (cached !== null) return JSON.parse(cached) as T;
    const value = await factory();
    await this.put(key, value, ttlSeconds);
    return value;
  }

  async forget(key: string): Promise<boolean> {
    return (await this.redis.del(this.key(key))) > 0;
  }

  async add<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    positive(ttlSeconds, 'TTL');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Nilai cache harus dapat disimpan sebagai JSON.');
    return (await this.redis.send('SET', [this.key(key), encoded, 'EX', String(ttlSeconds), 'NX'])) === 'OK';
  }

  async increment(key: string, amount = 1, ttlSeconds = 60): Promise<number> {
    positive(ttlSeconds, 'TTL');
    if (!Number.isSafeInteger(amount)) throw new Error('Kenaikan counter harus bilangan bulat.');
    // Expiry is attached on creation only, so a busy counter cannot live forever.
    return Number(await this.redis.eval(`
      local existed = redis.call('EXISTS', KEYS[1])
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      if current and math.abs(current + tonumber(ARGV[1])) > 9007199254740991 then
        return redis.error_reply('CACHE_COUNTER_OVERFLOW')
      end
      local value = redis.call('INCRBY', KEYS[1], ARGV[1])
      if existed == 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      return value
    `, 1, this.key(key), amount, ttlSeconds));
  }

  async lock(key: string, ttlMs: number): Promise<CacheLock | null> {
    positive(ttlMs, 'TTL lock');
    this.key(key);
    const redisKey = `${this.namespace}lock:${key}`;
    const token = crypto.randomUUID();
    if ((await this.redis.send('SET', [redisKey, token, 'PX', String(ttlMs), 'NX'])) !== 'OK') return null;
    return {
      token,
      release: async () => Number(await this.redis.eval(`
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
        return redis.call('DEL', KEYS[1])
      `, 1, redisKey, token)) === 1,
      renew: async (nextTtlMs: number) => {
        positive(nextTtlMs, 'TTL lock');
        return Number(await this.redis.eval(`
          if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
          return redis.call('PEXPIRE', KEYS[1], ARGV[2])
        `, 1, redisKey, token, nextTtlMs)) === 1;
      },
    };
  }

  /** Clear cached values only. Active locks, other prefixes, and queues are preserved. */
  async clear(): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const result = await this.redis.send('SCAN', [cursor, 'MATCH', `${this.namespace}data:*`, 'COUNT', '100']);
      cursor = String(result[0]);
      const keys = result[1] as string[];
      if (keys.length) removed += Number(await this.redis.send('UNLINK', keys));
    } while (cursor !== '0');
    return removed;
  }

  async close(): Promise<void> { this.redis.close(); }
}
