import type { SQL } from 'bun';

// Lock per account of spec 0014 (*Perintah operator* and Value sourcing *Urutan sesi bersamaan per akun*), shared by the
// sign in transaction of the backend and the `set-password` and `revoke-sessions --email` commands of
// database/accounts.ts, so both sides always take the very same lock. It uses the key space of one `bigint`, apart from
// the two `integer` locks `(638727, 5)` and `(638727, 6)` of the runner, and the operator takes it after both of those,
// so the order is fixed and no deadlock with the backend (which takes only this lock) can arise.

/** Seed of `hashtextextended` that keeps the account locks apart from any other lock of the database. */
export const ACCOUNT_LOCK_SEED = 638727;

/**
 * Takes the transaction level advisory lock of one account: `pg_advisory_xact_lock(hashtextextended(user_id::text,
 * 638727))`. The id goes through `uuid` first, so every caller hashes the same canonical text. The lock is released by
 * the commit or the rollback of `tx`; a lock wait counts against the statement or lock timeout of that transaction.
 */
export async function lockAccount(tx: SQL, userId: string): Promise<void> {
  await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${userId}::uuid::text, ${ACCOUNT_LOCK_SEED}::bigint))`;
}
