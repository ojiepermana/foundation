import { createApp } from './app';
import { readConfiguration } from './config/env';
import { LIFECYCLE_EVENTS, writeLifecycle, type LifecycleEvent, type RequestLogSink } from './plugins/request-log';
import { createDatabasePool } from '../../../libs/server/database/client';

let pool: ReturnType<typeof createDatabasePool> | undefined;

// Production log of spec 0012 (*Log backend production*): JSON lines, `info` to stdout and `error` to stderr. The mode
// is read on its own first, so a production configuration that fails later still writes `startup_failed` as JSON;
// any other mode keeps the development text unchanged.
const log: RequestLogSink | undefined = Bun.env.NODE_ENV === 'production'
  ? { info: (line) => console.log(line), error: (line) => console.error(line) }
  : undefined;

/** One lifecycle line: JSON in production, the fixed development text otherwise. */
function lifecycle(event: LifecycleEvent, text: string): void {
  if (log !== undefined) writeLifecycle(log, event);
  else if (LIFECYCLE_EVENTS[event] === 'info') console.log(text);
  else console.error(text);
}

try {
  const config = readConfiguration(Bun.env);
  if (Bun.env.DATABASE_URL) pool = createDatabasePool(Bun.env.DATABASE_URL);
  const app = createApp(config.mode, { database: pool, ...(log === undefined ? {} : { log }) })
    .listen({ hostname: config.host, port: config.port, maxRequestBodySize: 1024, idleTimeout: 10 });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    let failed = false;
    try {
      await app.stop(true);
    } catch { failed = true; lifecycle('listener_shutdown_failed', 'Backend listener shutdown failed'); }
    try {
      // Waits at most 1 second for running queries, then closes them: a readiness check held by a frozen database
      // would otherwise keep close() waiting past the 5 second shutdown limit (spec 0006, rationale decision 54).
      if (pool) await pool.close({ timeout: 1 });
    } catch { failed = true; lifecycle('database_shutdown_failed', 'Backend database shutdown failed'); }
    if (failed) { process.exitCode = 1; return; }
    clearTimeout(deadline);
    lifecycle('stopped', 'Backend stopped');
    // Exit on purpose instead of waiting for the event loop to drain: with Bun 1.4.2, a Bun.SQL connection attempt that
    // ended in connectionTimeout while its TCP connect was still pending (a stopped or unreachable database host) keeps
    // the process alive after pool.close(), so SIGTERM would end only with the SIGKILL of the stop grace (spec 0012
    // AC-9). Bun flushes stdout before exiting, so the `stopped` line is never lost.
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  lifecycle('listening', `Backend listening at http://${config.host}:${config.port}`);
} catch {
  lifecycle('startup_failed', 'Backend startup failed: invalid configuration or listener unavailable');
  process.exitCode = 1;
  if (pool) await pool.close();
}
