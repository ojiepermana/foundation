import { SQL } from 'bun';
import { createDatabasePool } from '../libs/server/database/client';

// Fingerprint of spec 0013 (*Fingerprint*): row counts, optional per table digests, sequences, and the migration history
// of database `foundation`, read as the backup role through `SET LOCAL ROLE pg_read_all_data` in one REPEATABLE READ
// READ ONLY transaction. A backup and the database restored from it give the same fingerprint when nothing was written
// in between. `row_security = off` is required: without it a table with row level security reads as 0 rows without an
// error, so source and target would both look empty and match falsely; with it such a table fails the fingerprint.
// `lock_timeout = '30s'`, like `--lock-wait-timeout=30s` of the backup, ends a wait on a held lock (a migration in
// progress, for example) as `Fingerprint failed` instead of waiting without a bound.

export type FingerprintTable = { schema: string; name: string; rows: string; digest?: string };
export type FingerprintSequence = { schema: string; name: string; lastValue: string; isCalled: boolean };
export type Fingerprint = {
  schema: 1;
  tables: FingerprintTable[];
  sequences: FingerprintSequence[];
  migrations: { count: number; last: string | null };
};

class FingerprintError extends Error {}

function fail(message: string): never {
  throw new FingerprintError(message);
}

type Tx = SQL;
type Relation = { schema: string; name: string; qualified: string };

/** Tables (`r` or `p` that are not partitions) or sequences outside the system schemas, ordered by schema then name. */
async function relations(tx: Tx, kind: 'tables' | 'sequences'): Promise<Relation[]> {
  const rows = kind === 'tables'
    ? await tx`SELECT n.nspname AS schema, c.relname AS name, pg_catalog.format('%I.%I', n.nspname, c.relname) AS qualified
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`
    : await tx`SELECT n.nspname AS schema, c.relname AS name, pg_catalog.format('%I.%I', n.nspname, c.relname) AS qualified
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`;
  return rows.map((row: Record<string, unknown>) => ({ schema: String(row.schema), name: String(row.name), qualified: String(row.qualified) }));
}

/**
 * Reads the fingerprint on `sql`, which must be a pool of role foundation_backup on database `foundation` of PostgreSQL
 * 18 or newer. Identifiers come only from catalog rows and are quoted by the server before `tx.unsafe` uses them.
 */
export async function fingerprint(sql: SQL, options: { digest: boolean }): Promise<Fingerprint> {
  return await sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const [login] = await tx`SELECT session_user AS login, current_database() AS database, current_setting('server_version_num')::integer AS version`;
    if (login?.login !== 'foundation_backup' || login.database !== 'foundation' || login.version < 180000) fail('Invalid fingerprint target');
    await tx.unsafe('SET LOCAL ROLE pg_read_all_data');
    await tx.unsafe('SET LOCAL row_security = off');
    await tx.unsafe("SET LOCAL lock_timeout = '30s'");
    await tx.unsafe("SET LOCAL TimeZone = 'UTC'");
    await tx.unsafe("SET LOCAL DateStyle = 'ISO, YMD'");
    await tx.unsafe("SET LOCAL IntervalStyle = 'postgres'");
    await tx.unsafe('SET LOCAL extra_float_digits = 1');
    await tx.unsafe("SET LOCAL bytea_output = 'hex'");
    const [role] = await tx`SELECT current_user AS name`;
    if (role?.name !== 'pg_read_all_data') fail('Invalid fingerprint target');
    const tables: FingerprintTable[] = [];
    for (const table of await relations(tx, 'tables')) {
      const query = options.digest
        ? `SELECT count(*)::text AS rows, coalesce(sum(hashtextextended(t::text, 0)::numeric), 0)::text AS digest FROM ${table.qualified} AS t`
        : `SELECT count(*)::text AS rows FROM ${table.qualified} AS t`;
      const [row] = await tx.unsafe(query);
      const entry: FingerprintTable = { schema: table.schema, name: table.name, rows: String(row.rows) };
      if (options.digest) entry.digest = String(row.digest);
      tables.push(entry);
    }
    const sequences: FingerprintSequence[] = [];
    for (const sequence of await relations(tx, 'sequences')) {
      const [row] = await tx.unsafe(`SELECT last_value::text AS value, is_called AS called FROM ${sequence.qualified}`);
      sequences.push({ schema: sequence.schema, name: sequence.name, lastValue: String(row.value), isCalled: row.called === true });
    }
    const [history] = await tx`SELECT count(*)::integer AS count,
      (SELECT name FROM common.schema_migrations ORDER BY name COLLATE "C" DESC LIMIT 1) AS last FROM common.schema_migrations`;
    return { schema: 1, tables, sequences, migrations: { count: Number(history.count), last: history.last ?? null } };
  });
}

if (import.meta.main) {
  let sql: SQL | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--digest')) fail('Use no argument or --digest');
    const url = process.env.FOUNDATION_BACKUP_DATABASE_URL ?? '';
    if (!url) fail('Missing FOUNDATION_BACKUP_DATABASE_URL');
    sql = createDatabasePool(url, { max: 1 });
    console.log(JSON.stringify(await fingerprint(sql, { digest: args.length === 1 })));
  } catch (error) {
    // Only the fixed messages leave this process; a driver error may echo part of the connection string.
    console.error(error instanceof FingerprintError ? error.message : 'Fingerprint failed');
    process.exitCode = 1;
  } finally {
    if (sql) await sql.close().catch(() => undefined);
  }
}
