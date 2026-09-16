import type { SQL } from 'bun';
import nodemailer from 'nodemailer';
import type { Config } from '../config';
import type { SqlClient } from '../db';
import { log } from '../logger';
import { decryptPayload, encryptPayload } from './crypto';
import { validateMessage, type MailMessage } from './templates';

export { actionMail, type MailMessage } from './templates';

interface OutboxQueue {
  dispatch(name: string, payload: unknown, options?: { id?: string; maxAttempts?: number }): Promise<unknown>;
  inspect(id: string): Promise<{ state: string } | null>;
}

export async function enqueueMail(tx: SqlClient, config: Config, message: MailMessage): Promise<string> {
  validateMessage(message);
  const id = crypto.randomUUID();
  const payload = await encryptPayload(message, config.encryptionKey);
  await tx`INSERT INTO mail_outbox (id, payload) VALUES (${id}, ${payload})`;
  return id;
}

export function mailErrorCode(error: unknown): string {
  const candidate = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const internalCodes = ['MAIL_PAYLOAD_INVALID', 'MAIL_MESSAGE_INVALID', 'MAIL_ABORTED', 'MAIL_RECIPIENT_REJECTED', 'OUTBOX_LEASE_LOST', 'OUTBOX_BUSY', 'OUTBOX_NOT_FOUND', 'OUTBOX_ID_INVALID'];
  return typeof candidate === 'string' && ['EAUTH', 'ECONNECTION', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EENVELOPE', 'EMESSAGE'].includes(candidate)
    ? `SMTP_${candidate}` : error instanceof Error && internalCodes.includes(error.message) ? error.message : 'MAIL_DELIVERY_FAILED';
}

/** Claims briefly in PostgreSQL; Redis calls happen after the claim has committed. */
export async function relayOutbox(db: SQL, config: Config, queue: OutboxQueue, limit = 20): Promise<number> {
  const token = crypto.randomUUID();
  const rows = await db`
    WITH candidates AS (
      SELECT id FROM mail_outbox
      WHERE payload IS NOT NULL AND status IN ('pending', 'queued', 'sending')
        AND available_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    UPDATE mail_outbox m SET lease_token = ${token}, lease_expires_at = now() + interval '60 seconds',
      status = CASE WHEN m.status = 'sending' THEN 'queued' ELSE m.status END, updated_at = now()
    FROM candidates c WHERE m.id = c.id RETURNING m.id, m.attempts
  `;
  let dispatched = 0;
  for (const row of rows) {
    const id = String(row.id);
    try {
      const job = await queue.inspect(`mail-${id}`);
      if (job?.state === 'failed' || job?.state === 'completed' || (!job && Number(row.attempts) >= 5)) {
        await db`UPDATE mail_outbox SET status = 'failed', last_error = 'OUTBOX_REVIEW_REQUIRED',
          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = ${id} AND lease_token = ${token}`;
        log('warn', 'mail.outbox.needs_review', { outboxId: id });
        continue;
      }
      if (!job) {
        await queue.dispatch('mail.send', { outboxId: id }, { id: `mail-${id}`, maxAttempts: 5 });
        dispatched += 1;
      }
      // A worker may already own or have sent this record. Never overwrite its state.
      await db`UPDATE mail_outbox SET status = 'queued', queued_at = COALESCE(queued_at, now()),
        available_at = now() + interval '30 seconds', lease_token = NULL, lease_expires_at = NULL,
        last_error = NULL, updated_at = now() WHERE id = ${id} AND lease_token = ${token} AND status IN ('pending', 'queued')`;
    } catch {
      await db`UPDATE mail_outbox SET available_at = now() + interval '5 seconds', lease_token = NULL,
        lease_expires_at = NULL, last_error = 'OUTBOX_QUEUE_UNAVAILABLE', updated_at = now()
        WHERE id = ${id} AND lease_token = ${token} AND status IN ('pending', 'queued')`;
      log('warn', 'mail.outbox.queue_unavailable', { outboxId: id });
    }
  }
  return dispatched;
}

export interface MailJobContext { jobId: string; attempt: number; signal: AbortSignal }

/** SMTP can acknowledge a message just before a crash; delivery is at least once. */
export function mailHandler(db: SQL, config: Config) {
  return async (payload: unknown, context: MailJobContext): Promise<void> => {
    const id = payload && typeof payload === 'object' ? (payload as { outboxId?: unknown }).outboxId : undefined;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('OUTBOX_ID_INVALID');
    context.signal.throwIfAborted();
    const token = crypto.randomUUID();
    const rows = await db`UPDATE mail_outbox SET status = 'sending', attempts = attempts + 1,
      lease_token = ${token}, lease_expires_at = now() + interval '60 seconds', updated_at = now()
      WHERE id = ${id} AND payload IS NOT NULL AND status <> 'sent'
        AND (status <> 'sending' OR lease_expires_at IS NULL OR lease_expires_at <= now())
      RETURNING payload`;
    if (!rows.length) {
      const existing = await db`SELECT status FROM mail_outbox WHERE id = ${id}`;
      if (existing[0]?.status === 'sent') return;
      throw new Error(existing.length ? 'OUTBOX_BUSY' : 'OUTBOX_NOT_FOUND');
    }

    const lease = new AbortController();
    const signal = AbortSignal.any([context.signal, lease.signal]);
    let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
    let heartbeatRunning = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      try {
        const owned = await db`UPDATE mail_outbox SET lease_expires_at = now() + interval '60 seconds', updated_at = now()
          WHERE id = ${id} AND lease_token = ${token} AND lease_expires_at > now() AND status = 'sending' RETURNING id`;
        if (!owned.length) lease.abort(new Error('OUTBOX_LEASE_LOST'));
      } catch { lease.abort(new Error('OUTBOX_LEASE_LOST')); }
      finally { heartbeatRunning = false; }
    }, 15_000);
    let abortListener: (() => void) | undefined;
    try {
      const message = await decryptPayload<MailMessage>(rows[0].payload, config.encryptionKey);
      validateMessage(message);
      signal.throwIfAborted();
      transport = nodemailer.createTransport({
        host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
        requireTLS: config.production && !config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
        disableFileAccess: true, disableUrlAccess: true,
      });
      const cancelled = new Promise<never>((_, reject) => {
        abortListener = () => { transport?.close(); reject(new Error('MAIL_ABORTED')); };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      });
      const result = await Promise.race([transport.sendMail({
        from: config.smtp.from, ...message,
        // Stable id helps recipients recognize retries, but SMTP does not guarantee deduplication.
        messageId: `<${id}@${new URL(config.appUrl).hostname}>`,
      }), cancelled]);
      if (result.rejected?.length || !result.accepted?.length) throw new Error('MAIL_RECIPIENT_REJECTED');
      signal.throwIfAborted();
      const updated = await db`UPDATE mail_outbox SET status = 'sent', sent_at = now(), payload = NULL,
        lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = ${id} AND lease_token = ${token} AND lease_expires_at > now() AND status = 'sending' RETURNING id`;
      if (!updated.length) throw new Error('OUTBOX_LEASE_LOST');
      log('info', 'mail.sent', { jobId: context.jobId, outboxId: id, attempt: context.attempt });
    } catch (error) {
      const code = mailErrorCode(error);
      const permanent = ['MAIL_PAYLOAD_INVALID', 'MAIL_MESSAGE_INVALID'].includes(code);
      await db`UPDATE mail_outbox SET status = ${context.attempt >= 5 || permanent ? 'failed' : 'queued'},
        last_error = ${code}, available_at = now() + interval '30 seconds', lease_token = NULL,
        lease_expires_at = NULL, updated_at = now() WHERE id = ${id} AND lease_token = ${token}
          AND lease_expires_at > now() AND status = 'sending'`;
      throw new Error(code);
    } finally {
      clearInterval(heartbeat);
      if (abortListener) signal.removeEventListener('abort', abortListener);
      transport?.close();
    }
  };
}
