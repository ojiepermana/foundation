import { RedisClient } from 'bun';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDb } from '../server/db';
import { migrate } from '../server/migrations';

const root = resolve(import.meta.dir, '..');
const directory = resolve(root, '.local/e2e');
const contextPath = resolve(directory, 'context.json');
const mailPath = resolve(directory, 'mail.json');
const lockPath = resolve(directory, 'stack.lock');
const runId = crypto.randomUUID().replaceAll('-', '');
const databaseName = `foundation_e2e_${runId}`;
const redisPrefix = `foundation_e2e_${runId}`;
const stop = new AbortController();
const children: ReturnType<typeof Bun.spawn>[] = [];
const received: { to: string; raw: string }[] = [];
let createdDatabase = false;
let ownsLock = false;
let smtpListening = false;
let admin: ReturnType<typeof createDb> | undefined;
let redis: RedisClient | undefined;
let mailWrites = Promise.resolve();

for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => stop.abort());

async function privateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${runId}.tmp`;
  await Bun.write(temporary, JSON.stringify(value));
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Decode text MIME bodies for assertions while retaining RFC822 headers. */
function decodeTextParts(raw: string): string {
  return raw.split(/(\r?\n--[^\r\n]+\r?\n)/).map(part => {
    const separator = /\r?\n\r?\n/.exec(part);
    if (!separator || !/^Content-Type:\s*text\//im.test(part.slice(0, separator.index))) return part;
    const headers = part.slice(0, separator.index);
    const body = part.slice(separator.index + separator[0].length);
    if (/^Content-Transfer-Encoding:\s*base64/im.test(headers)) return `${headers}\r\n\r\n${Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')}`;
    if (/^Content-Transfer-Encoding:\s*quoted-printable/im.test(headers)) {
      const unwrapped = body.replace(/=\r?\n/g, '');
      const bytes: number[] = [];
      for (let index = 0; index < unwrapped.length; index++) {
        const escaped = unwrapped.slice(index, index + 3);
        if (/^=[0-9a-f]{2}$/i.test(escaped)) { bytes.push(parseInt(escaped.slice(1), 16)); index += 2; }
        else bytes.push(...Buffer.from(unwrapped[index]!));
      }
      return `${headers}\r\n\r\n${Buffer.from(bytes).toString('utf8')}`;
    }
    return part;
  }).join('');
}

const smtp = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  size: 2 * 1024 * 1024,
  onData(stream, session, callback) {
    const chunks: Buffer[] = [];
    let length = 0;
    stream.on('data', chunk => {
      length += chunk.length;
      if (length <= 2 * 1024 * 1024) chunks.push(Buffer.from(chunk));
    });
    stream.on('error', () => callback(new Error('E2E_MAIL_STREAM_FAILED')));
    stream.on('end', () => {
      if (length > 2 * 1024 * 1024) { callback(new Error('E2E_MAIL_TOO_LARGE')); return; }
      const raw = decodeTextParts(Buffer.concat(chunks).toString('utf8'));
      for (const recipient of session.envelope.rcptTo) received.push({ to: recipient.address, raw });
      mailWrites = mailWrites.then(() => privateJson(mailPath, received));
      mailWrites.then(() => callback(), () => callback(new Error('E2E_MAIL_WRITE_FAILED')));
    });
  },
});

function child(entry: string, name: string, env: Record<string, string>) {
  const fd = openSync(resolve(directory, `${name}.log`), 'w', 0o600);
  try {
    const process = Bun.spawn([Bun.which('bun') ?? 'bun', entry], {
      cwd: root, env: { ...Bun.env, ...env }, stdin: 'ignore', stdout: fd, stderr: fd,
    });
    children.push(process);
    return process;
  } finally { closeSync(fd); }
}

async function start(): Promise<void> {
  const originalUrl = process.env['TEST_DATABASE_URL'];
  const redisUrl = process.env['TEST_REDIS_URL'] || process.env['REDIS_URL'];
  if (!originalUrl || !redisUrl) throw new Error('E2E_CONFIGURATION_REQUIRED');
  const databaseUrl = new URL(originalUrl);
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new Error('E2E_DATABASE_URL_INVALID');
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  databaseUrl.pathname = `/${databaseName}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await open(lockPath, 'wx', 0o600);
  ownsLock = true;
  await lock.writeFile(JSON.stringify({ pid: process.pid, runId }));
  await lock.close();
  stop.signal.throwIfAborted();
  admin = createDb(adminUrl.toString());
  // This identifier is generated internally and never accepted from configuration.
  if (!/^foundation_e2e_[a-f0-9]{32}$/.test(databaseName)) throw new Error('E2E_DATABASE_NAME_INVALID');
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  createdDatabase = true;
  stop.signal.throwIfAborted();
  const db = createDb(databaseUrl.toString());
  try { await migrate(db); } finally { await db.close(); }
  stop.signal.throwIfAborted();
  redis = new RedisClient(redisUrl, { connectionTimeout: 2000, maxRetries: 1 });
  await redis.send('PING', []);
  await new Promise<void>((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(0, '127.0.0.1', () => { smtpListening = true; smtp.removeListener('error', reject); resolve(); });
  });
  const env: Record<string, string> = {
    NODE_ENV: 'test', DATABASE_URL: databaseUrl.toString(), REDIS_URL: redisUrl, REDIS_PREFIX: redisPrefix,
    API_PORT: '8890', APP_URL: 'http://localhost:8090', WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_RP_NAME: 'Foundation E2E',
    APP_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String((smtp.server.address() as AddressInfo).port), SMTP_SECURE: 'false',
    SMTP_FROM: 'Foundation E2E <noreply@example.test>', SMTP_USER: '', SMTP_PASSWORD: '',
    SESSION_TTL_SECONDS: '604800', ACTIVATION_TTL_SECONDS: '86400', RESET_TTL_SECONDS: '1800', PASSKEY_CHALLENGE_TTL_SECONDS: '300',
  };
  await privateJson(mailPath, received);
  await privateJson(contextPath, { env, databaseName });
  stop.signal.throwIfAborted();
  child('apps/api/main.ts', 'api', env);
  child('apps/worker/main.ts', 'worker', env);
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    stop.signal.throwIfAborted();
    if (children.some(process => process.exitCode !== null)) throw new Error('E2E_SERVICE_EXITED');
    try { ready = (await fetch('http://127.0.0.1:8890/api/health/ready', { signal: AbortSignal.timeout(1000) })).ok; }
    catch { /* The API may still be starting. */ }
    if (!ready) await Bun.sleep(100);
  }
  if (!ready) throw new Error('E2E_SERVICES_TIMEOUT');
  console.log('E2E stack ready: API 8890, isolated PostgreSQL and Redis, local SMTP.');
  await Promise.race([
    new Promise<void>(resolve => {
      stop.signal.addEventListener('abort', () => resolve(), { once: true });
      if (stop.signal.aborted) resolve();
    }),
    ...children.map(async process => { await process.exited; if (!stop.signal.aborted) throw new Error('E2E_SERVICE_EXITED'); }),
  ]);
}

async function cleanup(): Promise<void> {
  stop.abort();
  for (const process of children) if (process.exitCode === null) process.kill('SIGTERM');
  const force = setTimeout(() => { for (const process of children) if (process.exitCode === null) process.kill('SIGKILL'); }, 5000);
  await Promise.allSettled(children.map(process => process.exited));
  clearTimeout(force);
  if (smtpListening) await new Promise<void>(resolve => smtp.close(resolve));
  await mailWrites.catch(() => {});
  let failed = false;
  if (redis) {
    try {
      let cursor = '0';
      do {
        const result = await redis.send('SCAN', [cursor, 'MATCH', `${redisPrefix}:*`, 'COUNT', '100']) as [string, string[]];
        cursor = result[0];
        if (result[1].length) await redis.send('DEL', result[1]);
      } while (cursor !== '0');
    } catch { failed = true; }
    finally { redis.close(); }
  }
  if (admin) {
    try {
      if (createdDatabase) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } catch { failed = true; }
    finally { await admin.close(); }
  }
  if (ownsLock) {
    for (const path of [contextPath, mailPath, lockPath]) await rm(path, { force: true });
  }
  if (failed) { console.error('E2E cleanup failed for this disposable run. Inspect local service availability.'); process.exitCode = 1; }
}

try { await start(); }
catch (error) {
  if (!stop.signal.aborted) {
    // Do not print database/Redis URLs, encryption keys or raw SMTP messages.
    const code = error instanceof Error && /^E2E_[A-Z_]+$/.test(error.message) ? error.message : 'E2E_START_FAILED';
    console.error(`${code}. Check TEST_DATABASE_URL, Redis, port 8890, and .local/e2e logs.`);
    process.exitCode = 1;
  }
} finally { await cleanup(); }
