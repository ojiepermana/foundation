import { loadConfig } from '../server/config';
import { RedisCache } from '../server/cache';

const config = loadConfig();
const cache = new RedisCache({ url: config.redisUrl, prefix: config.redisPrefix });
try {
  const [command, key] = process.argv.slice(2);
  if (command === 'clear') console.log(`${await cache.clear()} nilai cache dihapus.`);
  else if (command === 'forget' && key) console.log(await cache.forget(key) ? 'Nilai cache dihapus.' : 'Nilai cache tidak ditemukan.');
  else throw new Error('Gunakan cache:clear atau cache:forget <key>.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Operasi cache gagal.');
  process.exitCode = 1;
} finally { await cache.close(); }
