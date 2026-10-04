import type { SQL } from 'bun';

/**
 * Counts the rows of `common.schema_migrations` in one transaction on the backend pool (spec 0006, AC-2).
 * `SET LOCAL` limits the statement time of this transaction only, so the pool default for other routes stays as it is.
 * The query text is fixed, takes no client input, and only the row count leaves the database.
 */
export async function countAppliedMigrations(database: SQL): Promise<number> {
  const applied = await database.begin(async transaction => {
    await transaction`SET LOCAL statement_timeout = '2s'`;
    const [row] = await transaction`SELECT count(*)::integer AS applied FROM common.schema_migrations`;
    return (row as { applied?: unknown } | undefined)?.applied;
  });
  // The integer cast makes Bun.SQL return a number; anything else counts as a failed transaction (503).
  if (typeof applied !== 'number' || !Number.isSafeInteger(applied) || applied < 0) throw new Error('Unexpected migration count');
  return applied;
}
