import { createApp } from './app';
import { readConfiguration } from './config/env';
import { createDatabasePool } from '../../../libs/server/database/client';

let pool: ReturnType<typeof createDatabasePool> | undefined;

try {
  const config = readConfiguration(Bun.env);
  if (Bun.env.DATABASE_URL) pool = createDatabasePool(Bun.env.DATABASE_URL);
  const app = createApp(config.mode).listen({ hostname: config.host, port: config.port, maxRequestBodySize: 1024, idleTimeout: 10 });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    let failed = false;
    try {
      await app.stop(true);
    } catch { failed = true; console.error('Backend listener shutdown failed'); }
    try {
      if (pool) await pool.close();
    } catch { failed = true; console.error('Backend database shutdown failed'); }
    if (failed) { process.exitCode = 1; return; }
    clearTimeout(deadline);
    console.log('Backend stopped');
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log(`Backend listening at http://${config.host}:${config.port}`);
} catch {
  console.error('Backend startup failed: invalid configuration or listener unavailable');
  process.exitCode = 1;
  if (pool) await pool.close();
}
