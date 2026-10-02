import { SQL } from 'bun';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export type CommandKind = 'migration' | 'seed';
type FileEntry = { name: string; sql: string; checksum: string };
export type RunReport = { kind: CommandKind; applied: string[]; skipped: string[] };
type Tx = SQL;

const baseline = '0001-common-metadata-comment.sql';
const fileName = /^([0-9]{4})-[a-z0-9]+(?:-[a-z0-9]+)+\.sql$/;
const expectedColumns = [
  ['name', 'text', true, null],
  ['checksum', 'text', true, null],
  ['applied_at', 'timestamp with time zone', true, 'transaction_timestamp()'],
];

class RunnerError extends Error {
  constructor(message: string, readonly file?: string) { super(message); }
}

function fail(message: string, file?: string): never { throw new RunnerError(message, file); }

function validateStatement(source: string, name: string): void {
  let position = 0;
  let state: 'code' | 'single' | 'double' | 'line' | 'block' | 'dollar' = 'code';
  let blockDepth = 0;
  let delimiter = '';
  let escapedString = false;
  let statements = 0;
  let content = false;
  const words: string[] = [];
  while (position < source.length) {
    const char = source[position]!;
    const next = source[position + 1];
    if (state === 'line') {
      if (char === '\n') state = 'code';
      position++;
      continue;
    }
    if (state === 'block') {
      if (char === '/' && next === '*') { blockDepth++; position += 2; continue; }
      if (char === '*' && next === '/') { blockDepth--; position += 2; if (!blockDepth) state = 'code'; continue; }
      position++;
      continue;
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (state === 'single' && escapedString && char === '\\') { position += 2; continue; }
      if (char === quote && next === quote) { position += 2; continue; }
      if (char === quote) state = 'code';
      position++;
      continue;
    }
    if (state === 'dollar') {
      if (source.startsWith(delimiter, position)) { position += delimiter.length; state = 'code'; }
      else position++;
      continue;
    }
    if (char === '-' && next === '-') { state = 'line'; position += 2; continue; }
    if (char === '/' && next === '*') { state = 'block'; blockDepth = 1; position += 2; continue; }
    if (char === "'") { content = true; escapedString = /[eE]/.test(source[position - 1] ?? '') && !/[A-Za-z_0-9$]/.test(source[position - 2] ?? ''); state = 'single'; position++; continue; }
    if (char === '"') { content = true; state = 'double'; position++; continue; }
    if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(source.slice(position));
      if (match) { content = true; delimiter = match[0]; state = 'dollar'; position += delimiter.length; continue; }
    }
    if (char === ';') {
      if (content) { statements++; content = false; }
      position++;
      continue;
    }
    if (!/\s/.test(char)) content = true;
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(position))!;
      if (words.length < 6) words.push(match[0]!.toUpperCase());
      position += match[0]!.length;
      continue;
    }
    position++;
  }
  if (state === 'line') state = 'code';
  if (state !== 'code' || statements + Number(content) !== 1 || words.length === 0) fail('Invalid SQL statement', name);
  const first = words[0];
  const second = words[1];
  const controlWords = words.slice(1);
  if (['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE'].includes(first!) ||
    (first === 'START' && second === 'TRANSACTION') ||
    (first === 'PREPARE' && second === 'TRANSACTION') ||
    ((first === 'SET' || first === 'RESET') && controlWords.some((word) => ['ROLE', 'AUTHORIZATION', 'TRANSACTION'].includes(word))))
    fail('Transaction or role control is not allowed', name);
}

async function checkedDirectory(path: string, optional = false): Promise<boolean> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    fail('SQL directory unavailable');
  }
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) fail('Invalid SQL directory');
  return true;
}

async function discover(kind: CommandKind, root: string): Promise<FileEntry[]> {
  const canonicalRoot = await realpath(root);
  const database = resolve(canonicalRoot, 'database');
  const directory = resolve(database, kind === 'migration' ? 'migrations' : 'seeds');
  await checkedDirectory(database);
  if (!await checkedDirectory(directory, kind === 'seed')) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name);
  if (names.some((name) => !fileName.test(name))) fail('Invalid SQL file name');
  names.sort();
  if (kind === 'migration' && (names.length === 0 || names[0] !== baseline)) fail('Migration baseline missing');
  const files: FileEntry[] = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!;
    if (Number(fileName.exec(name)![1]) !== index + 1) fail('SQL file sequence invalid');
    const path = resolve(directory, name);
    const entry = entries.find((candidate) => candidate.name === name)!;
    if (!entry.isFile() || entry.isSymbolicLink()) fail('Invalid SQL file', name);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await handle.stat()).isFile()) fail('Invalid SQL file', name);
      const bytes = await handle.readFile();
      if (!bytes.length) fail('Empty SQL file', name);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('SQL file has BOM', name);
      const sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      validateStatement(sql, name);
      const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      files.push({ name, sql, checksum });
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      fail('Invalid SQL file', name);
    } finally { await handle?.close(); }
  }
  return files;
}

async function verifyIdentity(tx: Tx): Promise<void> {
  const [identity] = await tx`SELECT current_user AS role, session_user AS login, current_database() AS database,
    current_setting('server_version_num')::integer AS version, current_setting('search_path') AS path`;
  if (identity?.role !== 'foundation_migrator' || identity.login !== 'foundation_migrator' || identity.database !== 'foundation' ||
    identity.version < 180000 || identity.path !== 'pg_catalog')
    fail('Invalid database target or migrator');
  const roles = await tx`SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_catalog.pg_roles WHERE rolname IN ('foundation_owner','foundation_migrator','foundation_backend') ORDER BY rolname`;
  if (roles.length !== 3 || roles.some((role: Record<string, unknown>) =>
    role.rolcanlogin !== (role.rolname !== 'foundation_owner') || role.rolinherit || role.rolsuper || role.rolcreatedb ||
    role.rolcreaterole || role.rolreplication || role.rolbypassrls)) fail('Database role drift');
  const membership = await tx`SELECT member.rolname AS member, granted.rolname AS granted, m.admin_option AS admin, m.inherit_option AS inherit, m.set_option AS settable
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles member ON member.oid = m.member JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    WHERE member.rolname IN ('foundation_owner','foundation_migrator','foundation_backend') OR granted.rolname IN ('foundation_owner','foundation_migrator','foundation_backend')`;
  if (membership.length !== 1 || membership[0]?.member !== 'foundation_migrator' || membership[0]?.granted !== 'foundation_owner' ||
    membership[0]?.admin || membership[0]?.inherit || !membership[0]?.settable) fail('Migrator membership drift');
}

async function verifyMetadata(tx: Tx): Promise<void> {
  const [table] = await tx`SELECT c.oid, c.relkind, owner.rolname AS owner, c.relispartition, c.relhassubclass, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner
    WHERE n.nspname='common' AND c.relname='schema_migrations'`;
  if (!table || table.relkind !== 'r' || table.owner !== 'foundation_owner' || table.relispartition || table.relhassubclass ||
    table.relpersistence !== 'p' || table.relrowsecurity || table.relforcerowsecurity) fail('Migration metadata drift');
  const columns = await tx`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS required, pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=${table.oid} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`;
  if (JSON.stringify(columns.map((column: Record<string, unknown>) => [column.name, column.type, column.required, column.default])) !== JSON.stringify(expectedColumns)) fail('Migration metadata drift');
  const constraints = await tx`SELECT conname AS name, contype AS type, pg_catalog.pg_get_constraintdef(oid) AS definition
    FROM pg_catalog.pg_constraint WHERE conrelid=${table.oid} ORDER BY conname`;
  if (constraints.length !== 5 || !['name','checksum','applied_at'].every((name) => constraints.some((item: Record<string, unknown>) => item.name === `schema_migrations_${name}_not_null` && item.type === 'n' && item.definition === `NOT NULL ${name}`)) ||
    !constraints.some((item: Record<string, unknown>) => item.name === 'schema_migrations_pkey' && item.type === 'p' && item.definition === 'PRIMARY KEY (name)') ||
    !constraints.some((item: Record<string, unknown>) => item.name === 'schema_migrations_checksum_hex' && item.type === 'c' && String(item.definition).includes("'^[0-9a-f]{64}$'"))) fail('Migration metadata drift');
  const [extras] = await tx`SELECT
    (SELECT count(*)::int FROM pg_catalog.pg_index WHERE indrelid=${table.oid}) AS indexes,
    (SELECT count(*)::int FROM pg_catalog.pg_trigger WHERE tgrelid=${table.oid} AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::int FROM pg_catalog.pg_inherits WHERE inhrelid=${table.oid}) AS parents,
    (SELECT count(*)::int FROM pg_catalog.pg_attribute WHERE attrelid=${table.oid} AND attnum>0 AND attisdropped) AS dropped,
    (SELECT count(*)::int FROM pg_catalog.pg_rewrite WHERE ev_class=${table.oid} AND rulename <> '_RETURN') AS rules`;
  if (extras.indexes !== 1 || extras.triggers !== 0 || extras.parents !== 0 || extras.dropped !== 0 || extras.rules !== 0) fail('Migration metadata drift');
  const [privileges] = await tx`SELECT
    pg_catalog.has_table_privilege('foundation_backend','common.schema_migrations','SELECT') AS backend_read,
    pg_catalog.has_table_privilege('foundation_backend','common.schema_migrations','INSERT') AS backend_insert,
    pg_catalog.has_table_privilege('foundation_backend','common.schema_migrations','UPDATE') AS backend_update,
    pg_catalog.has_table_privilege('foundation_backend','common.schema_migrations','DELETE') AS backend_delete,
    pg_catalog.has_table_privilege('foundation_backend','common.schema_migrations','TRUNCATE') AS backend_truncate,
    pg_catalog.has_table_privilege('foundation_backend','common.schema_migrations','REFERENCES') AS backend_references,
    pg_catalog.has_table_privilege('foundation_backend','common.schema_migrations','TRIGGER') AS backend_trigger,
    pg_catalog.has_table_privilege('foundation_backend','common.schema_migrations','MAINTAIN') AS backend_maintain,
    pg_catalog.has_table_privilege('foundation_migrator','common.schema_migrations','SELECT') AS migrator_read,
    pg_catalog.has_table_privilege('foundation_migrator','common.schema_migrations','INSERT') AS migrator_insert,
    pg_catalog.has_database_privilege('foundation_backend','foundation','CREATE') AS backend_db_create,
    pg_catalog.has_database_privilege('foundation_backend','foundation','TEMPORARY') AS backend_temp,
    pg_catalog.has_database_privilege('foundation_migrator','foundation','CREATE') AS migrator_db_create,
    pg_catalog.has_database_privilege('foundation_migrator','foundation','TEMPORARY') AS migrator_temp,
    pg_catalog.has_schema_privilege('foundation_backend','common','USAGE') AS backend_common_usage,
    pg_catalog.has_schema_privilege('foundation_backend','common','CREATE') AS backend_common_create,
    pg_catalog.has_schema_privilege('foundation_backend','users','USAGE') AS backend_users_usage,
    pg_catalog.has_schema_privilege('foundation_backend','users','CREATE') AS backend_users_create,
    pg_catalog.has_schema_privilege('foundation_backend','auth','USAGE') AS backend_auth_usage,
    pg_catalog.has_schema_privilege('foundation_backend','auth','CREATE') AS backend_auth_create,
    pg_catalog.has_schema_privilege('foundation_backend','public','CREATE') AS backend_public_create`;
  if (!privileges.backend_read || privileges.backend_insert || privileges.backend_update || privileges.backend_delete ||
    privileges.backend_truncate || privileges.backend_references || privileges.backend_trigger || privileges.backend_maintain ||
    privileges.migrator_read || privileges.migrator_insert || privileges.backend_db_create || privileges.backend_temp ||
    privileges.migrator_db_create || privileges.migrator_temp || !privileges.backend_common_usage || privileges.backend_common_create ||
    !privileges.backend_users_usage || privileges.backend_users_create || !privileges.backend_auth_usage || privileges.backend_auth_create ||
    privileges.backend_public_create)
    fail('Migration metadata privilege drift');
  const [defaults] = await tx`SELECT count(*)::integer AS count FROM pg_catalog.pg_default_acl`;
  if (defaults.count !== 0) fail('Database default privilege drift');
}

function verifyHistory(files: FileEntry[], rows: Array<{ name: string; checksum: string }>): number {
  if (rows.length > files.length) fail('Migration history drift');
  for (let index = 0; index < rows.length; index++) {
    if (rows[index]?.name !== files[index]?.name || rows[index]?.checksum !== files[index]?.checksum) fail('Migration history drift');
  }
  return rows.length;
}

export async function runDatabaseCommand(kind: CommandKind, sql: SQL, root = resolve(import.meta.dir, '..')): Promise<RunReport> {
  const migrations = await discover('migration', root);
  const seeds = kind === 'seed' ? await discover('seed', root) : [];
  const report: RunReport = { kind, applied: [], skipped: [] };
  await sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await verifyIdentity(tx);
    await tx`SELECT pg_catalog.pg_advisory_xact_lock(638727, 5)`;
    await tx`SELECT pg_catalog.pg_advisory_xact_lock(638727, 6)`;
    await tx.unsafe('SET LOCAL ROLE foundation_owner');
    const [role] = await tx`SELECT current_user AS name`;
    if (role?.name !== 'foundation_owner') fail('Owner role unavailable');
    await verifyMetadata(tx);
    const rows = await tx`SELECT name, checksum, applied_at FROM common.schema_migrations ORDER BY name`;
    const applied = verifyHistory(migrations, rows);
    if (kind === 'seed' && applied !== migrations.length) fail('Migrations pending');
    if (kind === 'migration') {
      report.skipped = migrations.slice(0, applied).map((file) => file.name);
      for (const file of migrations.slice(applied)) {
        try { await tx.unsafe(file.sql); }
        catch { fail('Migration SQL failed', file.name); }
        await tx`INSERT INTO common.schema_migrations(name, checksum) VALUES (${file.name}, ${file.checksum})`;
        report.applied.push(file.name);
      }
    } else {
      for (const file of seeds) {
        try { await tx.unsafe(file.sql); }
        catch { fail('Seed SQL failed', file.name); }
        report.applied.push(file.name);
      }
    }
  });
  const [role] = await sql`SELECT current_user AS name`;
  if (role?.name !== 'foundation_migrator') fail('Migrator role was not restored');
  return report;
}

export async function commandLine(kind: CommandKind): Promise<void> {
  let sql: SQL | undefined;
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--apply') fail('Use --apply');
    const url = Bun.env.FOUNDATION_MIGRATOR_DATABASE_URL;
    if (!url) fail('Missing FOUNDATION_MIGRATOR_DATABASE_URL');
    const { createDatabasePool } = await import('../libs/server/database/client');
    sql = createDatabasePool(url, { max: 1 });
    const report = await runDatabaseCommand(kind, sql);
    for (const name of report.skipped) console.log(`Skipped: ${name}`);
    for (const name of report.applied) console.log(`${kind === 'migration' ? 'Applied' : 'Seeded'}: ${name}`);
    console.log(kind === 'migration' ? `Migrations: ${report.applied.length} applied, ${report.skipped.length} skipped` : `Seeds: ${report.applied.length} executed`);
  } catch (error) {
    if (error instanceof RunnerError) console.error(error.file ? `${error.message}: ${error.file}` : error.message);
    else console.error(kind === 'migration' ? 'Migration failed' : 'Seed failed');
    process.exitCode = 1;
  } finally { if (sql) await sql.close(); }
}
