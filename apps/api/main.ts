import { loadConfig } from '../../server/config';
import { createDb } from '../../server/db';
import { createApp } from './app';
import { log } from '../../server/logger';
const config = loadConfig();
const db = createDb(config.databaseUrl);
const runtime = createApp(db, config);
runtime.app.listen({ port: config.apiPort, hostname: '127.0.0.1' });
log('info', 'api.started', { port: config.apiPort });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await runtime.app.stop(); await runtime.close(); await db.close();
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
