import { loadConfig } from '../../server/config';
import { createDb } from '../../server/db';
import { log } from '../../server/logger';
import { mailHandler, relayOutbox } from '../../server/mail';
import { RedisQueue } from '../../server/queue';

const config = loadConfig();
const db = createDb(config.databaseUrl);
const queue = new RedisQueue({ url: config.redisUrl, prefix: config.redisPrefix });
const abort = new AbortController();
for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => abort.abort());

async function relayLoop() {
  while (!abort.signal.aborted) {
    try { await relayOutbox(db, config, queue); }
    catch { log('warn', 'mail.relay.unavailable'); }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 1000);
      abort.signal.addEventListener('abort', done, { once: true });
      if (abort.signal.aborted) done();
    });
  }
}

try {
  log('info', 'worker.started', { concurrency: 4 });
  await Promise.all([relayLoop(), queue.work({ 'mail.send': mailHandler(db, config) }, { signal: abort.signal, concurrency: 4 })]);
} catch {
  log('error', 'worker.failed');
  process.exitCode = 1;
} finally {
  abort.abort();
  await queue.close();
  await db.close();
  log('info', 'worker.stopped');
}
