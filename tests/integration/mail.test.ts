import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../../server/config';
import { createDb } from '../../server/db';
import { enqueueMail, mailHandler, relayOutbox, actionMail } from '../../server/mail';
import { RedisQueue } from '../../server/queue';

const databaseUrl = process.env['TEST_DATABASE_URL'];

describe.skipIf(!databaseUrl)('mail outbox with PostgreSQL and a local SMTP sink', () => {
  const db = createDb(databaseUrl!);
  const owned: string[] = [];
  const delivered: string[] = [];
  let config: Config;
  let rejectRecipient = false;
  let beforeAccept: (() => Promise<void>) | undefined;
  const smtp = new SMTPServer({
    disabledCommands: ['AUTH', 'STARTTLS'],
    onRcptTo(_address, _session, callback) {
      callback(rejectRecipient ? Object.assign(new Error('private SMTP response must not be stored'), { responseCode: 550 }) : undefined);
    },
    onData(stream, _session, callback) {
      let value = '';
      stream.on('data', chunk => { value += chunk.toString(); });
      stream.on('end', async () => {
        delivered.push(value);
        try { await beforeAccept?.(); callback(); }
        catch { callback(new Error('Local sink hook failed')); }
      });
    },
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve));
    const port = (smtp.server.address() as AddressInfo).port;
    config = loadConfig({
      DATABASE_URL: databaseUrl, REDIS_URL: 'redis://127.0.0.1:6379', REDIS_PREFIX: 'foundation_mail_test',
      APP_URL: 'http://localhost:8088', APP_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_FROM: 'Foundation <noreply@example.test>',
    });
    await db`SELECT id FROM mail_outbox LIMIT 1`;
  });

  afterAll(async () => {
    for (const id of owned) await db`DELETE FROM mail_outbox WHERE id = ${id}`;
    await db.close();
    await new Promise<void>(resolve => smtp.close(resolve));
  });

  const enqueue = async () => {
    const id = await db.begin(async tx => enqueueMail(tx, config, actionMail({
      name: 'Test User', email: 'sink@example.test', token: 'private-token', purpose: 'activation', appUrl: config.appUrl,
    })));
    owned.push(id);
    return id;
  };
  const ctx = (id: string, attempt = 1) => ({ jobId: `mail-${id}`, attempt, signal: new AbortController().signal });

  test('rolls back the encrypted outbox along with its transaction', async () => {
    let id = '';
    try {
      await db.begin(async tx => {
        id = await enqueueMail(tx, config, { to: 'sink@example.test', subject: 'Rollback', text: 'secret', html: '<p>secret</p>' });
        throw new Error('rollback');
      });
    } catch { /* Expected transaction rollback. */ }
    expect((await db`SELECT id FROM mail_outbox WHERE id = ${id}`).length).toBe(0);
  });

  test('keeps the same encrypted payload after Redis failure and dispatches only a reference', async () => {
    const id = await enqueue();
    const before = (await db`SELECT payload FROM mail_outbox WHERE id = ${id}`)[0].payload;
    expect(before).not.toContain('private-token');
    const queue = {
      inspect: async () => { throw new Error('redis://secret@offline'); },
      dispatch: async () => { throw new Error('unused'); },
    };
    await relayOutbox(db, config, queue);
    let row = (await db`SELECT * FROM mail_outbox WHERE id = ${id}`)[0];
    expect(row.payload).toBe(before);
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('OUTBOX_QUEUE_UNAVAILABLE');
    await db`UPDATE mail_outbox SET available_at = now() WHERE id = ${id}`;
    const jobs = new Map<string, { state: string }>();
    const dispatches: unknown[] = [];
    const restored = {
      inspect: async (jobId: string) => jobs.get(jobId) ?? null,
      dispatch: async (name: string, payload: unknown, options?: { id?: string }) => {
        if (options?.id === `mail-${id}`) dispatches.push({ name, payload });
        jobs.set(options!.id!, { state: 'ready' });
      },
    };
    await relayOutbox(db, config, restored);
    expect(dispatches).toEqual([{ name: 'mail.send', payload: { outboxId: id } }]);
    await db`UPDATE mail_outbox SET available_at = now() WHERE id = ${id}`;
    await relayOutbox(db, config, restored);
    expect(dispatches.length).toBe(1);
    jobs.delete(`mail-${id}`);
    await db`UPDATE mail_outbox SET available_at = now() WHERE id = ${id}`;
    await relayOutbox(db, config, restored);
    expect(dispatches.length).toBe(2);
    row = (await db`SELECT * FROM mail_outbox WHERE id = ${id}`)[0];
    expect(row.payload).toBe(before);
    expect(row.status).toBe('queued');
  });

  test('sends via local SMTP once, removes sensitive payload and skips sent retries', async () => {
    const id = await enqueue();
    const before = delivered.length;
    const handle = mailHandler(db, config);
    await handle({ outboxId: id }, ctx(id));
    await handle({ outboxId: id }, ctx(id, 2));
    expect(delivered.length).toBe(before + 1);
    expect(delivered.at(-1)).toContain('multipart/alternative');
    const row = (await db`SELECT * FROM mail_outbox WHERE id = ${id}`)[0];
    expect(row.status).toBe('sent');
    expect(row.payload).toBeNull();
    expect(row.sent_at).toBeTruthy();
  });

  test('concurrent delivery claims cannot send the same record simultaneously', async () => {
    const id = await enqueue();
    const before = delivered.length;
    const handle = mailHandler(db, config);
    const results = await Promise.allSettled([handle({ outboxId: id }, ctx(id)), handle({ outboxId: id }, ctx(id))]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(delivered.length).toBe(before + 1);
  });

  test('expired sending lease recovers and terminal failures need an explicit retry', async () => {
    const id = await enqueue();
    await db`UPDATE mail_outbox SET status = 'sending', lease_token = ${crypto.randomUUID()}, lease_expires_at = now() - interval '1 second' WHERE id = ${id}`;
    await mailHandler(db, config)({ outboxId: id }, ctx(id, 2));
    expect((await db`SELECT status FROM mail_outbox WHERE id = ${id}`)[0].status).toBe('sent');
    const failed = await enqueue();
    rejectRecipient = true;
    try { await mailHandler(db, config)({ outboxId: failed }, ctx(failed, 5)); }
    catch (error) { expect(String(error)).toContain('SMTP_EENVELOPE'); }
    finally { rejectRecipient = false; }
    let row = (await db`SELECT * FROM mail_outbox WHERE id = ${failed}`)[0];
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('SMTP_EENVELOPE');
    expect(row.payload).toBeTruthy();
    await mailHandler(db, config)({ outboxId: failed }, ctx(failed, 1));
    row = (await db`SELECT * FROM mail_outbox WHERE id = ${failed}`)[0];
    expect(row.status).toBe('sent');
  });

  test('a stale SMTP sender cannot overwrite a new lease after acceptance', async () => {
    const id = await enqueue();
    const replacement = crypto.randomUUID();
    beforeAccept = async () => {
      await db`UPDATE mail_outbox SET lease_token = ${replacement}, lease_expires_at = now() + interval '60 seconds' WHERE id = ${id}`;
    };
    try {
      await expect(mailHandler(db, config)({ outboxId: id }, ctx(id))).rejects.toThrow('OUTBOX_LEASE_LOST');
      const row = (await db`SELECT * FROM mail_outbox WHERE id = ${id}`)[0];
      expect(row.lease_token).toBe(replacement);
      expect(row.status).toBe('sending');
      expect(row.payload).toBeTruthy();
      expect(row.sent_at).toBeNull();
    } finally { beforeAccept = undefined; }
  });

  test.skipIf(!process.env['TEST_REDIS_URL'])('relays through real Redis Streams to SMTP and acknowledges delivery', async () => {
    const prefix = `mail_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const redisUrl = process.env['TEST_REDIS_URL']!;
    const queue = new RedisQueue({ url: redisUrl, prefix });
    const redis = new RedisClient(redisUrl);
    const abort = new AbortController();
    const id = await enqueue();
    const before = delivered.length;
    const work = queue.work({ 'mail.send': mailHandler(db, config) }, { signal: abort.signal, concurrency: 2 });
    try {
      await relayOutbox(db, config, queue);
      const deadline = Date.now() + 5000;
      while ((await queue.inspect(`mail-${id}`))?.state !== 'completed' && Date.now() < deadline) await Bun.sleep(20);
      expect((await queue.inspect(`mail-${id}`))?.state).toBe('completed');
      expect((await db`SELECT status FROM mail_outbox WHERE id = ${id}`)[0].status).toBe('sent');
      expect(delivered.length).toBe(before + 1);
      const raw = await redis.send('HGET', [`${prefix}:queue:job:mail-${id}`, 'payload']);
      expect(raw).toBe(JSON.stringify({ outboxId: id }));
      expect(String(raw)).not.toContain('private-token');
    } finally {
      abort.abort();
      await work;
      await queue.close();
      let cursor = '0';
      do {
        const result = await redis.send('SCAN', [cursor, 'MATCH', `${prefix}:*`, 'COUNT', '100']) as [string, string[]];
        cursor = result[0];
        if (result[1].length) await redis.send('DEL', result[1]);
      } while (cursor !== '0');
      redis.close();
    }
  });
});
