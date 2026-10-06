import { SQL } from 'bun';
import { createDatabasePool } from '../libs/server/database/client';

const roles = ['foundation_owner', 'foundation_migrator', 'foundation_backend'] as const;
const schemas = ['common', 'users', 'auth'] as const;
// Read only backup role of spec 0013 (tabel *Matriks role backup*): created only when FOUNDATION_BACKUP_PASSWORD is
// given, verified on every run once it exists, and never part of the output while it does not exist.
const backupRole = 'foundation_backup';
type Tx = SQL;
type Status = 'created' | 'verified' | 'repaired';
type Report = Record<string, Status>;

function fail(reason: string): never { throw new Error(reason); }

function password(name: string): string {
  const value = Bun.env[name];
  if (!value || value.length < 16 || value.includes('\0')) fail(`Missing or invalid ${name}`);
  return value;
}

/**
 * FOUNDATION_BACKUP_PASSWORD of spec 0013: an absent variable means the backup role is not used, while a variable that
 * is present but empty, shorter than 16 characters, or holding NUL always fails, whether the role exists or not.
 */
function backupPassword(): string | undefined {
  if (process.env.FOUNDATION_BACKUP_PASSWORD === undefined) return undefined;
  return password('FOUNDATION_BACKUP_PASSWORD');
}

async function identity(tx: Tx): Promise<void> {
  const [row] = await tx`SELECT current_user AS username, session_user AS login, current_database() AS database, current_setting('server_version_num')::integer AS version`;
  if (row?.username !== 'foundation_admin' || row.login !== 'foundation_admin' || row.database !== 'foundation' || row.version < 180000) fail('Invalid database target or administrator');
}

async function roleState(tx: Tx, name: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx`SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_catalog.pg_roles WHERE rolname = ${name}`;
  return row;
}

function validRole(row: Record<string, unknown>, name: string): boolean {
  return row.rolcanlogin === (name !== 'foundation_owner') && row.rolinherit === false &&
    row.rolsuper === false && row.rolcreatedb === false && row.rolcreaterole === false &&
    row.rolreplication === false && row.rolbypassrls === false;
}

async function ensureRoles(tx: Tx, report: Report, backupSecret: string | undefined): Promise<boolean> {
  for (const name of roles) {
    const existing = await roleState(tx, name);
    if (existing) {
      if (!validRole(existing, name)) fail(`Role drift: ${name}`);
      report[name] = 'verified';
      continue;
    }
    if (name === 'foundation_owner') {
      await tx.unsafe('CREATE ROLE foundation_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    } else {
      const secret = password(name === 'foundation_migrator' ? 'FOUNDATION_MIGRATOR_PASSWORD' : 'FOUNDATION_BACKEND_PASSWORD');
      const [quoted] = await tx`SELECT pg_catalog.quote_literal(${secret}) AS literal`;
      await tx.unsafe(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted.literal}`);
    }
    report[name] = 'created';
  }
  const backup = await roleState(tx, backupRole);
  if (backup) {
    if (!validRole(backup, backupRole)) fail(`Role drift: ${backupRole}`);
    // The password is never changed here; rotation follows *Prosedur insiden* of spec 0013.
    report[backupRole] = 'verified';
    return true;
  }
  if (backupSecret === undefined) return false;
  const [quoted] = await tx`SELECT pg_catalog.quote_literal(${backupSecret}) AS literal`;
  await tx.unsafe(`CREATE ROLE ${backupRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted.literal}`);
  report[backupRole] = 'created';
  return true;
}

async function ensureMembership(tx: Tx, report: Report): Promise<void> {
  const rows = await tx`SELECT member.rolname AS member, granted.rolname AS granted, m.admin_option, m.inherit_option, m.set_option
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    WHERE member.rolname IN ('foundation_owner', 'foundation_migrator', 'foundation_backend')
       OR granted.rolname IN ('foundation_owner', 'foundation_migrator', 'foundation_backend')`;
  const expected = rows.filter((row: Record<string, unknown>) => row.member === 'foundation_migrator' && row.granted === 'foundation_owner');
  if (rows.length !== expected.length || expected.length > 1 || expected.some((row: Record<string, unknown>) => row.admin_option || row.inherit_option || !row.set_option)) {
    fail('Role membership drift');
  }
  if (!expected.length) {
    await tx.unsafe('GRANT foundation_owner TO foundation_migrator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE');
    report['foundation_migrator membership'] = 'created';
  } else report['foundation_migrator membership'] = 'verified';
}

/**
 * Exactly one membership row for the backup role: member foundation_backup of pg_read_all_data with ADMIN FALSE,
 * INHERIT FALSE, and SET TRUE, and no other row where foundation_backup is member or role. A missing row is created;
 * any other row or option fails `Role membership drift`.
 */
async function ensureBackupMembership(tx: Tx, report: Report): Promise<void> {
  const rows = await tx`SELECT member.rolname AS member, granted.rolname AS granted, m.admin_option, m.inherit_option, m.set_option
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    WHERE member.rolname = ${backupRole} OR granted.rolname = ${backupRole}`;
  const expected = rows.filter((row: Record<string, unknown>) => row.member === backupRole && row.granted === 'pg_read_all_data');
  if (rows.length !== expected.length || expected.length > 1 || expected.some((row: Record<string, unknown>) => row.admin_option || row.inherit_option || !row.set_option)) {
    fail('Role membership drift');
  }
  if (!expected.length) {
    await tx.unsafe(`GRANT pg_read_all_data TO ${backupRole} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
    report[`${backupRole} membership`] = 'created';
  } else report[`${backupRole} membership`] = 'verified';
}

async function ensureSchemas(tx: Tx, report: Report): Promise<void> {
  for (const name of schemas) {
    const [row] = await tx`SELECT n.nspname, owner.rolname AS owner
      FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid = n.nspowner WHERE n.nspname = ${name}`;
    if (row) {
      if (row.owner !== 'foundation_owner') fail(`Schema drift: ${name}`);
      report[name] = 'verified';
    } else {
      await tx.unsafe(`CREATE SCHEMA ${name} AUTHORIZATION foundation_owner`);
      report[name] = 'created';
    }
  }
}

async function ensureMetadata(tx: Tx, report: Report): Promise<void> {
  const [row] = await tx`SELECT c.oid, c.relkind, owner.rolname AS owner, c.relispartition, c.relhassubclass,
    c.relpersistence, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles owner ON owner.oid = c.relowner
    WHERE n.nspname = 'common' AND c.relname = 'schema_migrations'`;
  if (!row) {
    await tx.unsafe('SET ROLE foundation_owner');
    try {
      await tx.unsafe(`CREATE TABLE common.schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL CONSTRAINT schema_migrations_checksum_hex CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      )`);
    } finally { await tx.unsafe('RESET ROLE'); }
    report['common.schema_migrations'] = 'created';
    return;
  }
  if (row.relkind !== 'r' || row.owner !== 'foundation_owner' || row.relispartition || row.relhassubclass ||
    row.relpersistence !== 'p' || row.relrowsecurity || row.relforcerowsecurity) fail('Metadata table drift');
  const columns = await tx`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
    a.attnotnull AS required, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ${row.oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
  const expected = [
    ['name', 'text', true, null],
    ['checksum', 'text', true, null],
    ['applied_at', 'timestamp with time zone', true, 'transaction_timestamp()'],
  ];
  if (JSON.stringify(columns.map((c: Record<string, unknown>) => [c.name, c.type, c.required, c.default])) !== JSON.stringify(expected)) fail('Metadata column drift');
  const constraints = await tx`SELECT conname AS name, contype AS type, convalidated AS validated, pg_catalog.pg_get_constraintdef(oid) AS definition
    FROM pg_catalog.pg_constraint WHERE conrelid = ${row.oid} ORDER BY conname`;
  const notNull = ['name', 'checksum', 'applied_at'].every((name) => constraints.some((c: Record<string, unknown>) => c.name === `schema_migrations_${name}_not_null` && c.type === 'n' && c.definition === `NOT NULL ${name}`));
  if (constraints.length !== 5 || !notNull || !constraints.some((c: Record<string, unknown>) => c.name === 'schema_migrations_pkey' && c.type === 'p' && c.definition === 'PRIMARY KEY (name)') ||
    !constraints.some((c: Record<string, unknown>) => c.name === 'schema_migrations_checksum_hex' && c.type === 'c' && c.validated === true && c.definition === "CHECK ((checksum ~ '^[0-9a-f]{64}$'::text))")) fail('Metadata constraint drift');
  const [extras] = await tx`SELECT
    (SELECT count(*)::integer FROM pg_catalog.pg_index WHERE indrelid = ${row.oid}) AS indexes,
    (SELECT count(*)::integer FROM pg_catalog.pg_trigger WHERE tgrelid = ${row.oid} AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::integer FROM pg_catalog.pg_inherits WHERE inhrelid = ${row.oid}) AS parents,
    (SELECT count(*)::integer FROM pg_catalog.pg_attribute WHERE attrelid = ${row.oid} AND attnum > 0 AND attisdropped) AS dropped,
    (SELECT count(*)::integer FROM pg_catalog.pg_rewrite WHERE ev_class = ${row.oid} AND rulename <> '_RETURN') AS rules`;
  if (extras.indexes !== 1 || extras.triggers !== 0 || extras.parents !== 0 || extras.dropped !== 0 || extras.rules !== 0) fail('Metadata relation drift');
  report['common.schema_migrations'] = 'verified';
}

/** SQL list of role names for `IN (...)`; only the fixed names of this file ever reach it. */
const names = (list: readonly string[]) => list.map((name) => `'${name}'`).join(', ');

/**
 * `x.grantee` is PUBLIC (0) or one of `known`. The known roles are read with one subquery instead of a scalar subquery
 * per role: a scalar subquery for a role that does not exist gives NULL, and `NOT IN` with NULL is never true, so the
 * drift check would silently stop working while the backup role is absent (spec 0013, tabel *Matriks role backup*).
 */
const grantee = (known: readonly string[]) => `(x.grantee = 0 OR x.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${names(known)})))`;

async function ensurePrivileges(tx: Tx, report: Report, backup: boolean): Promise<void> {
  const settingRoles = ['foundation_backend', 'foundation_migrator', backupRole];
  const snapshot = async () => {
    const database = await tx`SELECT datacl::text AS acl FROM pg_catalog.pg_database WHERE datname = 'foundation'`;
    const namespaces = await tx`SELECT nspname AS name, nspacl::text AS acl FROM pg_catalog.pg_namespace WHERE nspname IN ('public', 'common', 'users', 'auth') ORDER BY nspname`;
    const metadata = await tx`SELECT relacl::text AS acl FROM pg_catalog.pg_class WHERE oid = 'common.schema_migrations'::regclass`;
    const settings = await tx.unsafe(`SELECT r.rolname AS role, s.setconfig FROM pg_catalog.pg_db_role_setting s
      JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
      WHERE s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = 'foundation')
        AND r.rolname IN (${names(settingRoles)}) ORDER BY r.rolname`);
    return JSON.stringify({ database, namespaces, metadata, settings });
  };
  const before = await snapshot();
  const defaults = await tx`SELECT count(*)::integer AS count FROM pg_catalog.pg_default_acl`;
  if (defaults[0]?.count !== 0) fail('Default privilege drift');
  // The backup role is a known grantee only on the database ACL; any grant to it on a schema or on the metadata table is
  // unknown drift. The list holds it whether it exists or not: an absent role simply matches no grantee.
  const databaseKnown = ['foundation_admin', 'foundation_backend', 'foundation_migrator', backupRole];
  const outsiders = await tx.unsafe(`SELECT count(*)::integer AS count FROM (
    SELECT x.grantee FROM pg_catalog.pg_database d, LATERAL pg_catalog.aclexplode(d.datacl) x
      WHERE d.datname = 'foundation' AND NOT ${grantee(databaseKnown)}
    UNION ALL SELECT x.grantee FROM pg_catalog.pg_namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) x
      WHERE n.nspname = 'public' AND NOT ${grantee(['pg_database_owner', 'foundation_backend', 'foundation_migrator'])}
    UNION ALL SELECT x.grantee FROM pg_catalog.pg_namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) x
      WHERE n.nspname IN ('common', 'users', 'auth') AND NOT ${grantee(['foundation_owner', 'foundation_backend', 'foundation_migrator'])}
    UNION ALL SELECT x.grantee FROM pg_catalog.pg_class c, LATERAL pg_catalog.aclexplode(c.relacl) x
      WHERE c.oid = 'common.schema_migrations'::regclass AND NOT ${grantee(['foundation_owner', 'foundation_backend', 'foundation_migrator'])}
  ) grants`);
  if (outsiders[0]?.count !== 0) fail('Unknown privilege drift');
  const runtime = ['foundation_backend', 'foundation_migrator'];
  const options = await tx.unsafe(`SELECT count(*)::integer AS count FROM (
    SELECT x.is_grantable FROM pg_catalog.pg_database d, LATERAL pg_catalog.aclexplode(d.datacl) x WHERE d.datname = 'foundation' AND ${grantee([...runtime, backupRole])}
    UNION ALL SELECT x.is_grantable FROM pg_catalog.pg_namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) x WHERE n.nspname IN ('public', 'common', 'users', 'auth') AND ${grantee(runtime)}
    UNION ALL SELECT x.is_grantable FROM pg_catalog.pg_class c, LATERAL pg_catalog.aclexplode(c.relacl) x WHERE c.oid = 'common.schema_migrations'::regclass AND ${grantee(runtime)}
  ) grants WHERE is_grantable`);
  if (options[0]?.count !== 0) fail('Grant option drift');
  // One REVOKE and one GRANT for every runtime role, so the order of the ACL entries stays the same from run to run and
  // an unchanged ACL keeps `database privileges: verified`. The backup role joins them only when it exists.
  const connect = backup ? 'foundation_migrator, foundation_backend, foundation_backup' : 'foundation_migrator, foundation_backend';
  await tx.unsafe(`REVOKE ALL ON DATABASE foundation FROM PUBLIC, ${connect}`);
  await tx.unsafe(`GRANT CONNECT ON DATABASE foundation TO ${connect}`);
  await tx.unsafe('REVOKE ALL ON SCHEMA public FROM PUBLIC, foundation_backend, foundation_migrator');
  for (const name of schemas) {
    await tx.unsafe(`REVOKE ALL ON SCHEMA ${name} FROM PUBLIC, foundation_backend, foundation_migrator`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA ${name} TO foundation_backend`);
  }
  await tx.unsafe('REVOKE ALL ON TABLE common.schema_migrations FROM PUBLIC, foundation_backend, foundation_migrator');
  await tx.unsafe('GRANT SELECT ON TABLE common.schema_migrations TO foundation_backend');
  await tx.unsafe('ALTER ROLE foundation_backend IN DATABASE foundation SET search_path = pg_catalog');
  await tx.unsafe('ALTER ROLE foundation_migrator IN DATABASE foundation SET search_path = pg_catalog');
  if (backup) await tx.unsafe(`ALTER ROLE ${backupRole} IN DATABASE foundation SET search_path = pg_catalog`);
  const [effective] = await tx`SELECT
    pg_catalog.has_database_privilege('foundation_backend', 'foundation', 'CONNECT') AS connect,
    pg_catalog.has_database_privilege('foundation_backend', 'foundation', 'CREATE') AS db_create,
    pg_catalog.has_database_privilege('foundation_backend', 'foundation', 'TEMPORARY') AS temp,
    pg_catalog.has_schema_privilege('foundation_backend', 'common', 'USAGE') AS common_usage,
    pg_catalog.has_schema_privilege('foundation_backend', 'common', 'CREATE') AS common_create,
    pg_catalog.has_schema_privilege('foundation_backend', 'users', 'USAGE') AS users_usage,
    pg_catalog.has_schema_privilege('foundation_backend', 'users', 'CREATE') AS users_create,
    pg_catalog.has_schema_privilege('foundation_backend', 'auth', 'USAGE') AS auth_usage,
    pg_catalog.has_schema_privilege('foundation_backend', 'auth', 'CREATE') AS auth_create,
    pg_catalog.has_schema_privilege('foundation_backend', 'public', 'USAGE') AS public_usage,
    pg_catalog.has_schema_privilege('foundation_backend', 'public', 'CREATE') AS public_create,
    pg_catalog.has_table_privilege('foundation_backend', 'common.schema_migrations', 'SELECT') AS can_select,
    pg_catalog.has_table_privilege('foundation_backend', 'common.schema_migrations', 'INSERT') AS can_insert,
    pg_catalog.has_table_privilege('foundation_backend', 'common.schema_migrations', 'UPDATE') AS can_update,
    pg_catalog.has_table_privilege('foundation_backend', 'common.schema_migrations', 'DELETE') AS can_delete,
    pg_catalog.has_table_privilege('foundation_backend', 'common.schema_migrations', 'TRUNCATE') AS can_truncate,
    pg_catalog.has_table_privilege('foundation_backend', 'common.schema_migrations', 'REFERENCES') AS can_reference,
    pg_catalog.has_table_privilege('foundation_backend', 'common.schema_migrations', 'TRIGGER') AS can_trigger,
    pg_catalog.has_table_privilege('foundation_backend', 'common.schema_migrations', 'MAINTAIN') AS can_maintain,
    pg_catalog.has_schema_privilege('foundation_migrator', 'common', 'USAGE') AS migrator_usage,
    pg_catalog.has_table_privilege('foundation_migrator', 'common.schema_migrations', 'SELECT') AS migrator_select`;
  if (!effective.connect || effective.db_create || effective.temp || !effective.common_usage || effective.common_create || !effective.users_usage || effective.users_create || !effective.auth_usage || effective.auth_create || effective.public_usage || effective.public_create || !effective.can_select || effective.can_insert || effective.can_update || effective.can_delete || effective.can_truncate || effective.can_reference || effective.can_trigger || effective.can_maintain || effective.migrator_usage || effective.migrator_select) fail('Effective privilege drift');
  if (backup) await verifyBackupPrivileges(tx);
  report['database privileges'] = before === await snapshot() ? 'verified' : 'repaired';
}

/**
 * Effective privileges of the backup role (spec 0013, row *Privilege efektif*): CONNECT only on the database, neither
 * USAGE nor CREATE on the four schemas, SET on pg_read_all_data, and no membership in the owner, the runtime roles, or
 * pg_write_all_data.
 */
async function verifyBackupPrivileges(tx: Tx): Promise<void> {
  const [row] = await tx`SELECT
    pg_catalog.has_database_privilege('foundation_backup', 'foundation', 'CONNECT') AS connect,
    pg_catalog.has_database_privilege('foundation_backup', 'foundation', 'CREATE') AS db_create,
    pg_catalog.has_database_privilege('foundation_backup', 'foundation', 'TEMPORARY') AS temp,
    pg_catalog.has_schema_privilege('foundation_backup', 'public', 'USAGE') OR pg_catalog.has_schema_privilege('foundation_backup', 'public', 'CREATE') OR
    pg_catalog.has_schema_privilege('foundation_backup', 'common', 'USAGE') OR pg_catalog.has_schema_privilege('foundation_backup', 'common', 'CREATE') OR
    pg_catalog.has_schema_privilege('foundation_backup', 'users', 'USAGE') OR pg_catalog.has_schema_privilege('foundation_backup', 'users', 'CREATE') OR
    pg_catalog.has_schema_privilege('foundation_backup', 'auth', 'USAGE') OR pg_catalog.has_schema_privilege('foundation_backup', 'auth', 'CREATE') AS schema_access,
    pg_catalog.pg_has_role('foundation_backup', 'pg_read_all_data', 'SET') AS can_set,
    pg_catalog.pg_has_role('foundation_backup', 'foundation_owner', 'MEMBER') OR pg_catalog.pg_has_role('foundation_backup', 'foundation_migrator', 'MEMBER') OR
    pg_catalog.pg_has_role('foundation_backup', 'foundation_backend', 'MEMBER') OR pg_catalog.pg_has_role('foundation_backup', 'pg_write_all_data', 'MEMBER') AS other_member`;
  if (!row?.connect || row.db_create || row.temp || row.schema_access || !row.can_set || row.other_member) fail('Effective privilege drift');
}

export async function provision(sql: SQL): Promise<Report> {
  const report: Report = {};
  // Checked before the transaction, so a bad backup password fails without touching the database.
  const backupSecret = backupPassword();
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx`SELECT pg_catalog.pg_advisory_xact_lock(638727, 5)`;
    await identity(tx);
    const backup = await ensureRoles(tx, report, backupSecret);
    await ensureMembership(tx, report);
    if (backup) await ensureBackupMembership(tx, report);
    await ensureSchemas(tx, report);
    await ensureMetadata(tx, report);
    await ensurePrivileges(tx, report, backup);
  });
  return report;
}

if (import.meta.main) {
  let sql: SQL | undefined;
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--apply') fail('Use --apply');
    const url = Bun.env.FOUNDATION_ADMIN_DATABASE_URL;
    if (!url) fail('Missing FOUNDATION_ADMIN_DATABASE_URL');
    sql = createDatabasePool(url, { max: 1 });
    const report = await provision(sql);
    for (const [name, state] of Object.entries(report)) console.log(`${name}: ${state}`);
  } catch (error) {
    const category = error instanceof Error && /^(Use --apply|Missing FOUNDATION_ADMIN_DATABASE_URL|Invalid database URL|Invalid database pool size|Missing or invalid FOUNDATION_|Invalid database target or administrator|Role drift|Role membership drift|Schema drift|Metadata .* drift|Default privilege drift|Unknown privilege drift|Grant option drift|Effective privilege drift)/.test(error.message) ? error.message : 'Database provisioning failed';
    console.error(category);
    process.exitCode = 1;
  } finally { if (sql) await sql.close(); }
}
