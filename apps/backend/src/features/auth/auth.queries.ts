import type { SQL } from 'bun';
import { lockAccount } from '../../../../../libs/server/auth/account-lock';
import {
  ATTEMPT_CLEANUP_ROWS,
  SESSION_EXTENSION_INTERVAL,
  SESSION_IDLE,
  SESSION_LIFETIME,
  SESSIONS_PER_ACCOUNT,
  SIGN_IN_ATTEMPTS,
  SIGN_IN_WINDOW,
} from './auth.policy';

// SQL of the auth plugin (spec 0014, table *Value sourcing*). Every statement runs in a short transaction with
// `SET LOCAL statement_timeout = '2s'` (invariant 8), uses schema qualified names and query parameters, and reads or
// writes only the columns the grants of migrations 0007 to 0010 allow. Every time is `now()` of the database, which is
// the same for every statement of one transaction, so a lookup and the expiry it compares with always agree
// (invariant 6). No transaction is ever open while a password is hashed or verified (invariant 10): the callers verify
// between these calls, never inside them. Every UPDATE of a session holds `revoked_at IS NULL` and no statement ever
// writes NULL to `revoked_at`, because the column grants would allow it and the database does not refuse it
// (invariant 3).

export interface AccountRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
}

export interface SessionRow {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  expiresAt: Date;
}

export interface ActiveSession {
  user: { id: string; email: string; displayName: string };
  session: SessionRow;
}

/** One row of `GET /api/auth/sessions`. */
export interface ListedSession {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  current: boolean;
}

/** One short auth transaction with the statement limit of invariant 8, like the readiness query of spec 0012. */
function shortTransaction<T>(database: SQL, work: (tx: SQL) => Promise<T>): Promise<T> {
  return database.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '2s'`;
    return work(tx);
  });
}

type Row = Record<string, unknown>;

const sessionOf = (row: Row): SessionRow => ({
  id: String(row['id']),
  createdAt: row['created_at'] as Date,
  lastSeenAt: row['last_seen_at'] as Date,
  idleExpiresAt: row['idle_expires_at'] as Date,
  expiresAt: row['expires_at'] as Date,
});

/**
 * Value sourcing *Hitungan percobaan*: one short transaction of its own with one `INSERT ... ON CONFLICT ... RETURNING
 * attempt_count`, counted before the password is verified. The row lock of the conflict makes concurrent attempts of
 * one key count one after the other, so they cannot pass the limit together. A window that started 15 minutes ago or
 * earlier opens again at 1. Inside a window the count stops at the limit plus one, which already means refused, so it
 * never grows without end. Returns the count of this attempt in its window; above SIGN_IN_ATTEMPTS the caller answers 429.
 */
export function reserveAttempt(database: SQL, key: string): Promise<number> {
  return shortTransaction(database, async (tx) => {
    const [row]: Row[] = await tx`INSERT INTO auth.sign_in_attempts AS a (key_hash, attempt_count, window_started_at)
      VALUES (${key}, 1, now())
      ON CONFLICT (key_hash) DO UPDATE SET
        attempt_count = CASE WHEN a.window_started_at <= now() - ${SIGN_IN_WINDOW}::interval THEN 1
          ELSE least(a.attempt_count + 1, ${SIGN_IN_ATTEMPTS + 1}::integer) END,
        window_started_at = CASE WHEN a.window_started_at <= now() - ${SIGN_IN_WINDOW}::interval THEN now()
          ELSE a.window_started_at END
      RETURNING attempt_count`;
    if (row === undefined) throw new Error('Attempt reservation returned no row');
    return Number(row['attempt_count']);
  });
}

/**
 * Value sourcing *Pembersihan percobaan*: after the reservation, on the path of a known and of an unknown email alike, one
 * separate statement removes at most ten rows of other keys whose window has ended, so the table follows the keys of the
 * last 15 minutes without a job. The grant `DELETE` it uses is the one a successful sign in needs anyway.
 */
export function removeExpiredAttempts(database: SQL, key: string): Promise<void> {
  return shortTransaction(database, async (tx) => {
    await tx`DELETE FROM auth.sign_in_attempts WHERE key_hash IN (
      SELECT key_hash FROM auth.sign_in_attempts
      WHERE window_started_at <= now() - ${SIGN_IN_WINDOW}::interval AND key_hash <> ${key}
      LIMIT ${ATTEMPT_CLEANUP_ROWS})`;
  });
}

/** Value sourcing *Akun dan hash password*: the account and its hash by normalized email, or `undefined`. */
export function findAccount(database: SQL, email: string): Promise<AccountRow | undefined> {
  return shortTransaction(database, async (tx) => {
    const rows: Row[] = await tx`SELECT u.id, u.email, u.display_name, c.password_hash
      FROM users.users u JOIN auth.password_credentials c ON c.user_id = u.id
      WHERE u.email = ${email}`;
    const [row] = rows;
    if (row === undefined) return undefined;
    return { id: String(row['id']), email: String(row['email']), displayName: String(row['display_name']), passwordHash: String(row['password_hash']) };
  });
}

/** What the sign in transaction needs, all known before it starts. */
export interface SignInInput {
  userId: string;
  /** The hash the password was verified against; the transaction reads it again under the account lock. */
  verifiedHash: string;
  /** `token_hash` of the new session token. */
  tokenHash: string;
  /** `token_hash` of the session cookie the request carried in a valid shape, or `null` (rotation at sign in). */
  presentedHash: string | null;
  /** Key of the attempt row of the normalized email (table *Token*). */
  attemptKey: string;
}

/** Thrown inside the sign in transaction when the hash changed after the verification, so the transaction rolls back. */
class CredentialChanged extends Error {}

/**
 * The sign in transaction (Value sourcing *Urutan sesi bersamaan per akun dan password yang berubah*), started only after
 * the password was verified:
 *
 * 1. the lock per account, so concurrent sign ins of one account and `set-password` run one after the other;
 * 2. the second read of `password_hash`, which must equal the verified hash, otherwise a rollback and `credential_changed`
 *    (401 without a session), so a password the operator replaced in between never gives a session;
 * 3. the rotation: the session of the presented cookie, when still active and whoever owns it, revoked as `replaced`;
 * 4. the new session, `idle_expires_at` and `expires_at` from `now()`, the other columns from their defaults;
 * 5. the limit: every other active session of the account outside the newest nine by `last_seen_at`, then `created_at`,
 *    revoked as `session_limit`, so the account keeps at most ten active sessions. The new session is never a candidate,
 *    since `last_seen_at` is the start time of its transaction and a sign in that waited on the lock may start before
 *    one that committed while it waited;
 * 6. the attempt row of the email removed.
 *
 * READ COMMITTED (the default) gives every statement after the lock a new snapshot, so it sees what a sign in that held
 * the lock before committed.
 */
export function signInTransaction(database: SQL, input: SignInInput): Promise<SessionRow | 'credential_changed'> {
  return shortTransaction(database, async (tx) => {
    await lockAccount(tx, input.userId);
    const [credential]: Row[] = await tx`SELECT password_hash FROM auth.password_credentials WHERE user_id = ${input.userId}`;
    if (credential === undefined || credential['password_hash'] !== input.verifiedHash) throw new CredentialChanged();
    if (input.presentedHash !== null) {
      await tx`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'replaced'
        WHERE token_hash = ${input.presentedHash} AND revoked_at IS NULL AND idle_expires_at > now()`;
    }
    const [created]: Row[] = await tx`INSERT INTO auth.sessions (user_id, token_hash, idle_expires_at, expires_at)
      VALUES (${input.userId}, ${input.tokenHash}, now() + ${SESSION_IDLE}::interval, now() + ${SESSION_LIFETIME}::interval)
      RETURNING id, created_at, last_seen_at, idle_expires_at, expires_at`;
    if (created === undefined) throw new Error('Session insert returned no row');
    const session = sessionOf(created);
    await tx`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'session_limit'
      WHERE revoked_at IS NULL AND id IN (
        SELECT id FROM auth.sessions
        WHERE user_id = ${input.userId} AND id <> ${session.id} AND revoked_at IS NULL AND idle_expires_at > now()
        ORDER BY last_seen_at DESC, created_at DESC
        OFFSET ${SESSIONS_PER_ACCOUNT - 1})`;
    await tx`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${input.attemptKey}`;
    return session;
  }).catch((error: unknown) => {
    if (error instanceof CredentialChanged) return 'credential_changed' as const;
    throw error;
  });
}

/**
 * Value sourcing *GET sesi*: the active session of a token hash joined with its user. Active means not revoked and
 * `idle_expires_at > now()`; since `idle_expires_at <= expires_at`, the absolute lifetime is covered too.
 */
async function activeSession(tx: SQL, hash: string): Promise<ActiveSession | undefined> {
  const rows: Row[] = await tx`SELECT s.id, s.created_at, s.last_seen_at, s.idle_expires_at, s.expires_at,
      u.id AS user_id, u.email, u.display_name
    FROM auth.sessions s JOIN users.users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND s.revoked_at IS NULL AND s.idle_expires_at > now()`;
  const [row] = rows;
  if (row === undefined) return undefined;
  return {
    user: { id: String(row['user_id']), email: String(row['email']), displayName: String(row['display_name']) },
    session: sessionOf(row),
  };
}

/**
 * Value sourcing *Perpanjangan sesi*: the one statement that moves `last_seen_at` and `idle_expires_at` together, at most
 * once per 60 seconds per session, never past `expires_at`, and never for a revoked or expired session (it then changes
 * zero rows, which is no error). Returns the session with the new values when a row changed, else as it was.
 */
async function extend(tx: SQL, session: SessionRow): Promise<SessionRow> {
  const [row]: Row[] = await tx`UPDATE auth.sessions
    SET last_seen_at = now(), idle_expires_at = least(now() + ${SESSION_IDLE}::interval, expires_at)
    WHERE id = ${session.id} AND revoked_at IS NULL AND idle_expires_at > now()
      AND last_seen_at <= now() - ${SESSION_EXTENSION_INTERVAL}::interval
    RETURNING last_seen_at, idle_expires_at`;
  if (row === undefined) return session;
  return { ...session, lastSeenAt: row['last_seen_at'] as Date, idleExpiresAt: row['idle_expires_at'] as Date };
}

/** `GET /api/auth/session`: the resolution of the cookie, then the extension, in one transaction. */
export function resolveSession(database: SQL, hash: string): Promise<ActiveSession | undefined> {
  return shortTransaction(database, async (tx) => {
    const active = await activeSession(tx, hash);
    if (active === undefined) return undefined;
    return { user: active.user, session: await extend(tx, active.session) };
  });
}

/**
 * `GET /api/auth/sessions`: the resolution and the extension, then only the active sessions of the caller (filtered by
 * the `user_id` of the validated session, never by anything the request sends), at most ten, newest `last_seen_at`
 * first, then `created_at`. `current` is true exactly for the session of the caller.
 */
export function listSessions(database: SQL, hash: string): Promise<ListedSession[] | undefined> {
  return shortTransaction(database, async (tx) => {
    const active = await activeSession(tx, hash);
    if (active === undefined) return undefined;
    await extend(tx, active.session);
    const rows: Row[] = await tx`SELECT id, created_at, last_seen_at FROM auth.sessions
      WHERE user_id = ${active.user.id} AND revoked_at IS NULL AND idle_expires_at > now()
      ORDER BY last_seen_at DESC, created_at DESC
      LIMIT ${SESSIONS_PER_ACCOUNT}`;
    return rows.map((row) => ({
      id: String(row['id']),
      createdAt: row['created_at'] as Date,
      lastSeenAt: row['last_seen_at'] as Date,
      current: String(row['id']) === active.session.id,
    }));
  });
}

/** What sign out did; `ended` carries the ids of the `sign_out` event (table *Log keamanan*). */
export type EndOutcome = { outcome: 'none' | 'forbidden' } | { outcome: 'ended'; userId: string; sessionId: string };

/**
 * `DELETE /api/auth/session` after the cookie gave a token of the right shape: `none` when it names no active session
 * (204 without any change), `forbidden` when it does but the CSRF token did not match (step 9, nothing changes), and
 * `ended` once the session of the caller is revoked as `sign_out`. A session that ends needs no extension.
 */
export function endSession(database: SQL, hash: string, csrfMatched: boolean): Promise<EndOutcome> {
  return shortTransaction(database, async (tx): Promise<EndOutcome> => {
    const active = await activeSession(tx, hash);
    if (active === undefined) return { outcome: 'none' };
    if (!csrfMatched) return { outcome: 'forbidden' };
    await tx`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'sign_out'
      WHERE id = ${active.session.id} AND revoked_at IS NULL`;
    return { outcome: 'ended', userId: active.user.id, sessionId: active.session.id };
  });
}

/** What the revocation did; every outcome after the CSRF check carries the caller for the `session_revoke` event. */
export type RevokeOutcome =
  | { outcome: 'unauthenticated' | 'forbidden' }
  | { outcome: 'not_found' | 'revoked' | 'revoked_current'; userId: string };

/**
 * `DELETE /api/auth/sessions/{sessionId}` after the cookie gave a token of the right shape: `unauthenticated` without an
 * active session (401), `forbidden` when the CSRF token did not match (403), then Value sourcing *Pencabutan*: the target
 * is revoked as `revoked` only when it is an active session of the caller; zero rows is `not_found` (404), the same
 * answer for a session of another user, an ended session, and an id that does not exist, so nothing about the sessions
 * of another user changes or shows. A caller who revokes another session of its own keeps its session extended;
 * revoking its own session is `revoked_current`, so the route removes the cookie. The extension and the revocation
 * lock their rows in the order of the session ids, never in the order of the request: two sessions that revoke each
 * other at the same time then take the two rows in the same order, so they never wait on each other in a cycle (which
 * PostgreSQL ends as a deadlock, a 503). Lower case UUID text sorts like the uuid bytes PostgreSQL compares.
 */
export function revokeSession(database: SQL, hash: string, csrfMatched: boolean, target: string): Promise<RevokeOutcome> {
  return shortTransaction(database, async (tx): Promise<RevokeOutcome> => {
    const active = await activeSession(tx, hash);
    if (active === undefined) return { outcome: 'unauthenticated' };
    if (!csrfMatched) return { outcome: 'forbidden' };
    const userId = active.user.id;
    const current = target === active.session.id;
    const extendFirst = !current && active.session.id < target;
    if (extendFirst) await extend(tx, active.session);
    const revoked: Row[] = await tx`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'revoked'
      WHERE id = ${target} AND user_id = ${userId} AND revoked_at IS NULL AND idle_expires_at > now()
      RETURNING id`;
    if (!current && !extendFirst) await extend(tx, active.session);
    if (revoked.length === 0) return { outcome: 'not_found', userId };
    return { outcome: current ? 'revoked_current' : 'revoked', userId };
  });
}
