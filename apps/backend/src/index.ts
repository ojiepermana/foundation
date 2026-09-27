import { createApp } from './app';
import { readConfiguration } from './config/env';

try {
  const config = readConfiguration(Bun.env);
  const app = createApp(config.mode).listen({ hostname: config.host, port: config.port, maxRequestBodySize: 1024, idleTimeout: 10 });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    await app.stop(true);
    clearTimeout(deadline);
    console.log('Backend stopped');
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log(`Backend listening at http://${config.host}:${config.port}`);
} catch {
  console.error('Backend startup failed: invalid configuration or listener unavailable');
  process.exitCode = 1;
}
