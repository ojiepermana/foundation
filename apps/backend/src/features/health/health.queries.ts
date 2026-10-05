import type { SQL } from 'bun';

/**
 * The migration the backend needs before it answers ready (spec 0012, Value sourcing *Nama migration yang dibutuhkan*):
 * the name of the last file in `database/migrations/`. Every new migration updates this constant in the same commit;
 * DEP-001 fails when it falls behind the last migration file.
 */
export const REQUIRED_MIGRATION = '0001-common-metadata-comment.sql';

/**
 * True when `common.schema_migrations` holds a row for `name`, read in one transaction on the backend pool with the
 * `SELECT` the `foundation_backend` role already has (spec 0004). `SET LOCAL` limits the statement time of this
 * transaction only, so the pool default stays as it is (spec 0006). The name goes in as a query parameter, never as
 * SQL text, and only one boolean leaves the database.
 */
export async function migrationApplied(database: SQL, name: string): Promise<boolean> {
  const applied = await database.begin(async (transaction) => {
    await transaction`SET LOCAL statement_timeout = '2s'`;
    const [row] = await transaction`SELECT EXISTS (SELECT 1 FROM common.schema_migrations WHERE name = ${name}) AS applied`;
    return (row as { applied?: unknown } | undefined)?.applied;
  });
  // Anything other than a boolean counts as a failed check (503).
  if (typeof applied !== 'boolean') throw new Error('Unexpected readiness result');
  return applied;
}
