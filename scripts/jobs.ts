import { loadConfig } from '../server/config';
import { RedisQueue } from '../server/queue';

const config = loadConfig();
const queue = new RedisQueue({ url: config.redisUrl, prefix: config.redisPrefix });
try {
  const [command, id] = process.argv.slice(2);
  if (command === 'failed') console.table(await queue.failed());
  else if (command === 'retry' && id) { await queue.retry(id); console.log(`Job ${id} dijadwalkan ulang.`); }
  else throw new Error('Gunakan jobs:failed atau jobs:retry <id>.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Operasi job gagal.');
  process.exitCode = 1;
} finally { await queue.close(); }
