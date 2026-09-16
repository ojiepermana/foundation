import { RedisClient } from 'bun';
import { AppError } from './errors';
import { digest } from './security';
const script = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n`;
export class RateLimiter {
  private redis: RedisClient;
  constructor(url: string, private prefix: string) { this.redis = new RedisClient(url, { connectionTimeout: 2000, maxRetries: 1 }); }
  async hit(scope: string, key: string, limit: number, windowMs = 900_000) {
    let value: number;
    try { value = Number(await this.redis.send('EVAL', [script, '1', `${this.prefix}:rate:${scope}:${digest(key)}`, String(windowMs)])); }
    catch { throw new AppError(503, 'AUTH_UNAVAILABLE', 'Layanan autentikasi sementara tidak tersedia. Coba kembali.'); }
    if (value > limit) throw new AppError(429, 'RATE_LIMITED', 'Terlalu banyak percobaan. Silakan coba lagi nanti.');
  }
  close() { this.redis.close(); }
}
