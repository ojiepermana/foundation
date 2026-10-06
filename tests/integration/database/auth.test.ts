import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp, type AppOptions } from '../../../apps/backend/src/app';
import { REQUIRED_MIGRATION } from '../../../apps/backend/src/features/health/health.queries';
import { createDatabasePool } from '../../../libs/server/database/client';
import { onSignalCleanup, type SignalCleanupCallback } from '../../orchestration/signal-cleanup';
import { DATABASE_ACCOUNT_PASSWORDS } from '../../orchestration/auth-accounts';
import { recordTokenFingerprintsWhenConfigured } from '../../orchestration/token-fingerprints';

// Database suite of spec 0014 (AUTH-001 to AUTH-010, parts that need PostgreSQL) on one isolated PostgreSQL 18 cluster
// of the project image: the nine auth migrations and their grants, the operator command database/accounts.ts, the
// session lifecycle of both createApp compositions with a real `foundation_backend` pool, and the defences: answers
// without account enumeration, attempt limits and their cleanup, verification slots, the origin rule against real
// tables, and the `auth` log events. Requests carry the allowed origin of each composition and `Sec-Fetch-Site:
// same-origin` unless a test replaces them. Times are moved only through admin SQL, never through the clock of this
// process (Value sourcing *Jam*). The guard checks that need no pool are in tests/integration/backend/auth.test.ts.
// Under test:database:real every account password comes from FOUNDATION_TEST_SECRET_SEED with the label `account-<n>`
// (tests/orchestration/auth-accounts.ts), so the orchestration scans every artifact for it, and every session token and
// CSRF token a sign in returns is added to the fingerprint file of *Sidik token uji*; a token is never written.

const root = resolve(import.meta.dir, '../../..');
const testSeed = Bun.env.FOUNDATION_TEST_SECRET_SEED;
const token = (role: string) => testSeed ? createHmac('sha256', testSeed).update(role).digest('hex') : randomBytes(24).toString('hex');
const name = `foundation-auth-db-${randomBytes(4).toString('hex')}`;
const containerPattern = /^foundation-auth-db-[0-9a-f]{8}$/;
const adminPassword = token('admin');
const migratorPassword = token('migrator');
const backendPassword = token('backend');
const backupPassword = token('backup');
let directory = '';
let adminUrl = '';
let migratorUrl = '';
let backendUrl = '';
let backupUrl = '';
let firstMigration = '';
// Signal cleanup of spec 0010 (row *Pembersihan sinyal suite nyata*): bun test runs no afterAll on SIGINT or SIGTERM, so
// the folder and the container are registered before they are created and released once afterAll removed them.
let releaseFolder = () => {};
let releaseContainer = () => {};
const pools: SQL[] = [];
let admin: SQL;
let backend: SQL;

/** Synchronous `docker <args>` of the signal cleanup, with the environment of the other Docker calls; output never printed. */
function dockerSync(args: string[], timeout: number): number | undefined {
  if (timeout <= 0) return undefined;
  try {
    const result = Bun.spawnSync(['docker', ...args], { cwd: root, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout });
    return result.exitedDueToTimeout ? undefined : result.exitCode;
  } catch {
    return undefined;
  }
}

/** The container: `docker rm -f` on every pass, only for the name this process made. */
const containerCleanup: SignalCleanupCallback = ({ timeout }) => {
  if (!containerPattern.test(name)) return [name];
  return dockerSync(['rm', '-f', name], timeout(30000)) === 0 ? [] : [name];
};

/** The temporary folder with the env file: removed on pass 2, after the container. */
function folderCleanup(path: string): SignalCleanupCallback {
  return ({ pass }) => {
    if (pass !== 2) return [];
    try {
      rmSync(path, { recursive: true, force: true });
      return [];
    } catch {
      return [path];
    }
  };
}

type CommandResult = { code: number; stdout: string; stderr: string };

async function command(args: string[], env?: Record<string, string>): Promise<CommandResult> {
  const child = Bun.spawn(args, { cwd: root, env: env ?? process.env, stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

const provision = (passwords: boolean) => command([process.execPath, '--no-env-file', 'database/provision.ts', '--apply'], {
  PATH: process.env.PATH ?? '', FOUNDATION_ADMIN_DATABASE_URL: adminUrl, FOUNDATION_BACKUP_PASSWORD: backupPassword,
  ...(passwords ? { FOUNDATION_MIGRATOR_PASSWORD: migratorPassword, FOUNDATION_BACKEND_PASSWORD: backendPassword } : {}),
});

const migrate = () => command([process.execPath, '--no-env-file', 'database/migrate.ts', '--apply'], {
  PATH: process.env.PATH ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl,
});

beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'foundation-auth-test-'));
  releaseFolder = onSignalCleanup(folderCleanup(directory));
  const envFile = resolve(directory, 'postgres.env');
  await writeFile(envFile, `POSTGRES_DB=foundation\nPOSTGRES_USER=foundation_admin\nPOSTGRES_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
  releaseContainer = onSignalCleanup(containerCleanup);
  const started = await command(['docker', 'run', '--rm', '-d', '--name', name, '--env-file', envFile, '-p', '127.0.0.1::5432', 'foundation-postgres:18-pinned']);
  if (started.code !== 0) throw new Error('Isolated PostgreSQL 18 did not start');
  const mapped = await command(['docker', 'port', name, '5432/tcp']);
  if (mapped.code !== 0) throw new Error('Isolated PostgreSQL port unavailable');
  const port = Number(mapped.stdout.trim().split(':').at(-1));
  adminUrl = `postgres://foundation_admin:${adminPassword}@127.0.0.1:${port}/foundation`;
  migratorUrl = `postgres://foundation_migrator:${migratorPassword}@127.0.0.1:${port}/foundation`;
  backendUrl = `postgres://foundation_backend:${backendPassword}@127.0.0.1:${port}/foundation`;
  backupUrl = `postgres://foundation_backup:${backupPassword}@127.0.0.1:${port}/foundation`;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    const probe = new SQL({ url: adminUrl, max: 1, connectionTimeout: 1 });
    try { await probe`SELECT 1`; ready = true; } catch { await Bun.sleep(200); } finally { await probe.close(); }
  }
  if (!ready) throw new Error('Isolated PostgreSQL did not become ready');
  if ((await provision(true)).code !== 0) throw new Error('Isolated provisioning failed');
  const migrated = await migrate();
  if (migrated.code !== 0) throw new Error('Isolated migration failed');
  firstMigration = migrated.stdout;
  admin = new SQL({ url: adminUrl, max: 2 });
  backend = createDatabasePool(backendUrl);
  pools.push(admin, backend);
}, 60000);

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.close().catch(() => undefined)));
  // A container the normal path could not remove stays registered, so a later signal still removes it.
  if (containerPattern.test(name) && (await command(['docker', 'rm', '-f', name])).code === 0) releaseContainer();
  if (directory) await rm(directory, { recursive: true, force: true });
  releaseFolder();
});

// ---------------------------------------------------------------------------------------------------------------
// Operator command and test accounts

type Account = { id: string; email: string; password: string; displayName: string };
let accountNumber = 0;
let passwordNumber = 0;
/**
 * The next account password: label `account-<n>` of the run seed (AC-10, scanned by database-real.ts), random when the
 * suite runs alone. More passwords than the orchestration scans fail at once, so none can go unscanned.
 */
function newPassword(): string {
  passwordNumber += 1;
  if (passwordNumber > DATABASE_ACCOUNT_PASSWORDS) throw new Error(`More than ${DATABASE_ACCOUNT_PASSWORDS} account passwords; raise DATABASE_ACCOUNT_PASSWORDS`);
  return token(`account-${passwordNumber}`);
}

/** `bun database/accounts.ts <args>` with the migrator DSN of the cluster (or `url`), and the password when given. */
function accounts(args: string[], options: { password?: string; url?: string } = {}): Promise<CommandResult> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: options.url ?? migratorUrl };
  if (options.password !== undefined) env.FOUNDATION_ACCOUNT_PASSWORD = options.password;
  return command([process.execPath, '--no-env-file', 'database/accounts.ts', ...args], env);
}

/** A new account through `create`, with a unique email, a random password, and its id from the stdout line. */
async function newAccount(label: string): Promise<Account> {
  accountNumber += 1;
  const account = { email: `auth-${label}-${accountNumber}@foundation.test`, password: newPassword(), displayName: `Uji ${label} ${accountNumber}` };
  const created = await accounts(['create', '--email', account.email, '--display-name', account.displayName, '--apply'], { password: account.password });
  const id = /^Account created: ([0-9a-f-]{36})\n$/.exec(created.stdout)?.[1];
  if (created.code !== 0 || id === undefined) throw new Error(`Account ${label} was not created`);
  return { ...account, id };
}

/** The values an operator command must never print. */
function expectNoSecret(result: CommandResult, values: string[]): void {
  const output = result.stdout + result.stderr;
  for (const value of [...values, migratorUrl, migratorPassword, adminPassword, backendPassword]) expect(output).not.toContain(value);
  expect(output).not.toContain('$argon2id$');
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP helpers for both compositions

type Mode = 'development' | 'production';
type App = { handle(request: Request): Promise<Response> };
const ORIGIN: Readonly<Record<Mode, string>> = { development: 'http://127.0.0.1:8889', production: 'https://foundation.test' };
const COOKIE: Readonly<Record<Mode, string>> = { development: 'foundation_session', production: '__Host-foundation_session' };
const ATTRIBUTES: Readonly<Record<Mode, string>> = {
  development: 'Path=/; HttpOnly; SameSite=Strict',
  production: 'Path=/; Secure; HttpOnly; SameSite=Strict',
};
const apps = new Map<Mode, App>();

/** The app of one composition on the shared backend pool, or a new one with test options. */
function appOf(mode: Mode, auth?: AppOptions['auth'], database: SQL = backend): App {
  if (auth === undefined && database === backend) {
    let app = apps.get(mode);
    if (app === undefined) {
      app = createApp(mode, { database: backend, ...(mode === 'production' ? { publicOrigin: ORIGIN.production } : {}) });
      apps.set(mode, app);
    }
    return app;
  }
  return createApp(mode, { database, auth, ...(mode === 'production' ? { publicOrigin: ORIGIN.production } : {}) });
}

/** `headers` is set last, so a test can replace the allowed origin, Sec-Fetch-Site, or add an X-Request-Id. */
type Call = { cookie?: string; csrf?: string; body?: string; mode?: Mode; app?: App; headers?: Record<string, string> };

function request(method: string, path: string, call: Call = {}): Promise<Response> {
  const mode = call.mode ?? 'development';
  const headers = new Headers({ origin: ORIGIN[mode], 'sec-fetch-site': 'same-origin' });
  if (call.cookie !== undefined) headers.set('cookie', call.cookie);
  if (call.csrf !== undefined) headers.set('x-csrf-token', call.csrf);
  if (call.body !== undefined) headers.set('content-type', 'application/json');
  for (const [name, value] of Object.entries(call.headers ?? {})) headers.set(name, value);
  return (call.app ?? appOf(mode)).handle(new Request(`http://localhost${path}`, { method, headers, body: call.body }));
}

const cookieFor = (sessionToken: string, mode: Mode = 'development') => `${COOKIE[mode]}=${sessionToken}`;
const clearedCookie = (mode: Mode) => `${COOKIE[mode]}=; ${ATTRIBUTES[mode]}; Max-Age=0`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const csrfOf = (sessionToken: string) => createHmac('sha256', sessionToken).update('foundation-csrf-v1').digest('base64url');

/** A sign in: the response, its JSON body (AuthSession on 200, AuthError otherwise), the cookie token, and the session id. */
type SignedIn = { response: Response; body: { user?: Record<string, unknown>; session?: Record<string, string>; csrfToken?: string; error?: string }; token: string; sessionId: string };

/** POST /api/auth/session; the token is read from the one Set-Cookie of a 200. */
async function signIn(account: Pick<Account, 'email' | 'password'>, call: Omit<Call, 'body'> = {}): Promise<SignedIn> {
  const mode = call.mode ?? 'development';
  const response = await request('POST', '/api/auth/session', { ...call, body: JSON.stringify({ email: account.email, password: account.password }) });
  if (response.status !== 200) return { response, body: await response.json(), token: '', sessionId: '' };
  const cookies = response.headers.getSetCookie();
  const sessionToken = new RegExp(`^${COOKIE[mode]}=([A-Za-z0-9_-]{43}); `).exec(cookies[0] ?? '')?.[1] ?? '';
  const body = await response.json();
  // *Sidik token uji*: the fingerprints of the session token and the CSRF token, never the tokens.
  recordTokenFingerprintsWhenConfigured([sessionToken, typeof body.csrfToken === 'string' ? body.csrfToken : '']);
  return { response, body, token: sessionToken, sessionId: String(body.session?.id) };
}

/** Every column of one session row, as the admin sees it. */
async function sessionRow(id: string): Promise<Record<string, unknown>> {
  const [row] = await admin`SELECT * FROM auth.sessions WHERE id = ${id}`;
  return row;
}

/** Ids of the active sessions of one account (Value sourcing: not revoked and `idle_expires_at > now()`). */
async function activeIds(userId: string): Promise<string[]> {
  const rows = await admin`SELECT id FROM auth.sessions WHERE user_id = ${userId} AND revoked_at IS NULL AND idle_expires_at > now() ORDER BY id`;
  return rows.map((row: Record<string, unknown>) => String(row.id)).sort();
}

/** A promise with its resolve function, for the hooks that hold a sign in between verification and transaction. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------------------------------------------
// AUTH-001 (AC-1): data model

const USERS_AUTH_TABLES = ['auth.password_credentials', 'auth.sessions', 'auth.sign_in_attempts', 'users.users'];

test('AUTH-001 the nine migrations give the tables, columns, constraints, FKs, and index of the Model data table, owned by foundation_owner, without RLS, triggers, or a new schema', async () => {
  expect(firstMigration).toContain('Migrations: 10 applied, 0 skipped');
  const applied = [...firstMigration.matchAll(/^Applied: (\S+)$/gm)].map((match) => match[1]);
  const files = (await readdir(resolve(root, 'database/migrations'))).sort();
  expect(applied).toEqual(files);
  expect(files.slice(1)).toEqual([
    '0002-users-create-users.sql', '0003-auth-create-password-credentials.sql', '0004-auth-create-sessions.sql',
    '0005-auth-create-sessions-user-active-index.sql', '0006-auth-create-sign-in-attempts.sql', '0007-users-grant-backend-users.sql',
    '0008-auth-grant-backend-password-credentials.sql', '0009-auth-grant-backend-sessions.sql', '0010-auth-grant-backend-sign-in-attempts.sql',
  ]);
  expect(REQUIRED_MIGRATION).toBe(files.at(-1)!);

  const columns = await admin`SELECT n.nspname || '.' || c.relname AS name, a.attname AS column, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS required, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname IN ('users', 'auth') AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, a.attnum`;
  const time = 'timestamp with time zone';
  expect(columns.map((row: Record<string, unknown>) => [row.name, row.column, row.type, row.required, row.default])).toEqual([
    ['auth.password_credentials', 'user_id', 'uuid', true, null],
    ['auth.password_credentials', 'password_hash', 'text', true, null],
    ['auth.password_credentials', 'created_at', time, true, 'transaction_timestamp()'],
    ['auth.password_credentials', 'updated_at', time, true, 'transaction_timestamp()'],
    ['auth.sessions', 'id', 'uuid', true, 'gen_random_uuid()'],
    ['auth.sessions', 'user_id', 'uuid', true, null],
    ['auth.sessions', 'token_hash', 'text', true, null],
    ['auth.sessions', 'created_at', time, true, 'transaction_timestamp()'],
    ['auth.sessions', 'last_seen_at', time, true, 'transaction_timestamp()'],
    ['auth.sessions', 'idle_expires_at', time, true, null],
    ['auth.sessions', 'expires_at', time, true, null],
    ['auth.sessions', 'revoked_at', time, false, null],
    ['auth.sessions', 'revoked_reason', 'text', false, null],
    ['auth.sign_in_attempts', 'key_hash', 'text', true, null],
    ['auth.sign_in_attempts', 'attempt_count', 'integer', true, null],
    ['auth.sign_in_attempts', 'window_started_at', time, true, null],
    ['users.users', 'id', 'uuid', true, 'gen_random_uuid()'],
    ['users.users', 'email', 'text', true, null],
    ['users.users', 'display_name', 'text', true, null],
    ['users.users', 'created_at', time, true, 'transaction_timestamp()'],
    ['users.users', 'updated_at', time, true, 'transaction_timestamp()'],
  ]);

  const constraints = await admin`SELECT n.nspname || '.' || c.relname AS name, k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid) AS definition
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('users', 'auth') AND k.contype <> 'n' ORDER BY 1, 2`;
  expect(constraints.map((row: Record<string, unknown>) => [row.name, row.conname, row.contype, row.definition])).toEqual([
    ['auth.password_credentials', 'password_credentials_hash_check', 'c', String.raw`CHECK ((password_hash ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'::text))`],
    ['auth.password_credentials', 'password_credentials_pkey', 'p', 'PRIMARY KEY (user_id)'],
    ['auth.password_credentials', 'password_credentials_user_id_fkey', 'f', 'FOREIGN KEY (user_id) REFERENCES users.users(id) ON DELETE CASCADE'],
    ['auth.sessions', 'sessions_expiry_check', 'c', 'CHECK (((created_at < expires_at) AND (idle_expires_at <= expires_at)))'],
    ['auth.sessions', 'sessions_pkey', 'p', 'PRIMARY KEY (id)'],
    ['auth.sessions', 'sessions_revocation_check', 'c', 'CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL)))'],
    ['auth.sessions', 'sessions_revoked_reason_check', 'c', "CHECK ((revoked_reason = ANY (ARRAY['sign_out'::text, 'revoked'::text, 'replaced'::text, 'session_limit'::text, 'credential_change'::text, 'operator'::text])))"],
    ['auth.sessions', 'sessions_token_hash_check', 'c', "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))"],
    ['auth.sessions', 'sessions_token_hash_key', 'u', 'UNIQUE (token_hash)'],
    ['auth.sessions', 'sessions_user_id_fkey', 'f', 'FOREIGN KEY (user_id) REFERENCES users.users(id) ON DELETE CASCADE'],
    ['auth.sign_in_attempts', 'sign_in_attempts_count_check', 'c', 'CHECK ((attempt_count >= 1))'],
    ['auth.sign_in_attempts', 'sign_in_attempts_key_hash_check', 'c', "CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text))"],
    ['auth.sign_in_attempts', 'sign_in_attempts_pkey', 'p', 'PRIMARY KEY (key_hash)'],
    ['users.users', 'users_display_name_check', 'c', "CHECK ((((char_length(display_name) >= 1) AND (char_length(display_name) <= 100)) AND (display_name = btrim(display_name)) AND (display_name !~ '[[:cntrl:]]'::text)))"],
    ['users.users', 'users_email_check', 'c', "CHECK ((((char_length(email) >= 3) AND (char_length(email) <= 254)) AND (email = lower(email)) AND (email ~ '^[!-?A-~]{1,64}@[!-?A-~]{1,252}$'::text)))"],
    ['users.users', 'users_email_key', 'u', 'UNIQUE (email)'],
    ['users.users', 'users_pkey', 'p', 'PRIMARY KEY (id)'],
  ]);

  const indexes = await admin`SELECT schemaname || '.' || tablename AS name, indexname, indexdef FROM pg_catalog.pg_indexes
    WHERE schemaname IN ('users', 'auth') ORDER BY 1, 2`;
  expect(indexes.map((row: Record<string, unknown>) => [row.name, row.indexname, row.indexdef])).toEqual([
    ['auth.password_credentials', 'password_credentials_pkey', 'CREATE UNIQUE INDEX password_credentials_pkey ON auth.password_credentials USING btree (user_id)'],
    ['auth.sessions', 'sessions_pkey', 'CREATE UNIQUE INDEX sessions_pkey ON auth.sessions USING btree (id)'],
    ['auth.sessions', 'sessions_token_hash_key', 'CREATE UNIQUE INDEX sessions_token_hash_key ON auth.sessions USING btree (token_hash)'],
    ['auth.sessions', 'sessions_user_active_idx', 'CREATE INDEX sessions_user_active_idx ON auth.sessions USING btree (user_id, last_seen_at DESC) WHERE (revoked_at IS NULL)'],
    ['auth.sign_in_attempts', 'sign_in_attempts_pkey', 'CREATE UNIQUE INDEX sign_in_attempts_pkey ON auth.sign_in_attempts USING btree (key_hash)'],
    ['users.users', 'users_email_key', 'CREATE UNIQUE INDEX users_email_key ON users.users USING btree (email)'],
    ['users.users', 'users_pkey', 'CREATE UNIQUE INDEX users_pkey ON users.users USING btree (id)'],
  ]);

  const tables = await admin`SELECT n.nspname || '.' || c.relname AS name, c.relkind, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
      c.relrowsecurity, c.relforcerowsecurity, c.relpersistence,
      (SELECT count(*)::int FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers,
      (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('users', 'auth') AND c.relkind NOT IN ('i') ORDER BY 1`;
  expect(tables.map((row: Record<string, unknown>) => row.name)).toEqual(USERS_AUTH_TABLES);
  for (const table of tables) {
    expect(table, String(table.name)).toMatchObject({ relkind: 'r', owner: 'foundation_owner', relrowsecurity: false, relforcerowsecurity: false, relpersistence: 'p', triggers: 0, policies: 0 });
  }
  const schemas = await admin`SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1`;
  expect(schemas.map((row: Record<string, unknown>) => row.nspname)).toEqual(['auth', 'common', 'public', 'users']);

  // Rerun of the runner and provisioning again after the migrations.
  const again = await migrate();
  expect(again.code).toBe(0);
  expect(again.stdout).toContain('Migrations: 0 applied, 10 skipped');
  const provisioned = await provision(false);
  expect(provisioned.code).toBe(0);
  const lines = provisioned.stdout.trim().split('\n');
  expect(lines).toContain('database privileges: verified');
  expect(lines.every((line) => line.endsWith(': verified'))).toBe(true);
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-002 (AC-2): privileges of foundation_backend, PUBLIC, and foundation_backup

/** `true` when the statement fails with `permission denied`; any other outcome fails the test with its own text. */
async function denied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return /permission denied/.test((error as Error).message);
  }
}

test('AUTH-002 foundation_backend has exactly the table and column grants of Matriks grant backend, PUBLIC has none, and foundation_backup reads only through pg_read_all_data', async () => {
  const account = await newAccount('grants');
  const db = new SQL({ url: backendUrl, max: 1 });
  pools.push(db);
  const tables = USERS_AUTH_TABLES.map((table) => `'${table}'`).join(', ');
  // Table level grants of every role but the owner, then column level grants, from the ACLs themselves.
  const tableGrants = await admin.unsafe(`SELECT c.oid::regclass::text AS name, pg_catalog.pg_get_userbyid(a.grantee) AS grantee, a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid::regclass::text IN (${tables}) AND a.grantee <> c.relowner ORDER BY 1, 2, 3`);
  expect(tableGrants.map((row: Record<string, unknown>) => [row.name, row.grantee, row.privilege_type, row.is_grantable])).toEqual([
    ['auth.sign_in_attempts', 'foundation_backend', 'DELETE', false],
    ['auth.sign_in_attempts', 'foundation_backend', 'INSERT', false],
    ['auth.sign_in_attempts', 'foundation_backend', 'SELECT', false],
  ]);
  const columnGrants = await admin.unsafe(`SELECT c.oid::regclass::text AS name, t.attname, pg_catalog.pg_get_userbyid(a.grantee) AS grantee, a.privilege_type, a.is_grantable
    FROM pg_catalog.pg_attribute t JOIN pg_catalog.pg_class c ON c.oid = t.attrelid, pg_catalog.aclexplode(t.attacl) a
    WHERE c.oid::regclass::text IN (${tables}) ORDER BY 1, 4, t.attnum`);
  const grant = (table: string, privilege: string, columns: string[]) => columns.map((column) => [table, column, 'foundation_backend', privilege, false]);
  expect(columnGrants.map((row: Record<string, unknown>) => [row.name, row.attname, row.grantee, row.privilege_type, row.is_grantable])).toEqual([
    ...grant('auth.password_credentials', 'SELECT', ['user_id', 'password_hash']),
    ...grant('auth.sessions', 'INSERT', ['user_id', 'token_hash', 'idle_expires_at', 'expires_at']),
    ...grant('auth.sessions', 'SELECT', ['id', 'user_id', 'token_hash', 'created_at', 'last_seen_at', 'idle_expires_at', 'expires_at', 'revoked_at']),
    ...grant('auth.sessions', 'UPDATE', ['last_seen_at', 'idle_expires_at', 'revoked_at', 'revoked_reason']),
    ...grant('auth.sign_in_attempts', 'UPDATE', ['attempt_count', 'window_started_at']),
    ...grant('users.users', 'SELECT', ['id', 'email', 'display_name']),
  ]);
  // PUBLIC (grantee 0) has no entry on the four tables or their columns.
  const [publicGrants] = await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a WHERE c.oid::regclass::text IN (${tables}) AND a.grantee = 0) AS tables,
      (SELECT count(*)::int FROM pg_catalog.pg_attribute t, pg_catalog.aclexplode(t.attacl) a WHERE t.attrelid::regclass::text IN (${tables}) AND a.grantee = 0) AS columns`);
  expect(publicGrants).toEqual({ tables: 0, columns: 0 });
  for (const table of USERS_AUTH_TABLES) {
    for (const privilege of ['REFERENCES', 'TRIGGER', 'TRUNCATE', 'MAINTAIN']) {
      expect((await admin`SELECT pg_catalog.has_table_privilege('foundation_backend', ${table}, ${privilege}) AS granted`)[0]?.granted, `${table} ${privilege}`).toBe(false);
    }
  }

  // Every allowed row of the matrix works as foundation_backend.
  expect(await db`SELECT id, email, display_name FROM users.users WHERE id = ${account.id}`).toHaveLength(1);
  expect(await db`SELECT user_id, password_hash FROM auth.password_credentials WHERE user_id = ${account.id}`).toHaveLength(1);
  const hash = sha256(randomBytes(32).toString('hex'));
  const [inserted] = await db`INSERT INTO auth.sessions (user_id, token_hash, idle_expires_at, expires_at)
    VALUES (${account.id}, ${hash}, now() + interval '30 minutes', now() + interval '12 hours') RETURNING id`;
  expect(await db`SELECT id, user_id, token_hash, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at FROM auth.sessions WHERE id = ${inserted.id}`).toHaveLength(1);
  expect((await db`UPDATE auth.sessions SET last_seen_at = now(), idle_expires_at = now() + interval '30 minutes' WHERE id = ${inserted.id} AND revoked_at IS NULL`).count).toBe(1);
  expect((await db`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'operator' WHERE id = ${inserted.id} AND revoked_at IS NULL`).count).toBe(1);
  const key = sha256(`sign-in:${account.email}`);
  await db`INSERT INTO auth.sign_in_attempts (key_hash, attempt_count, window_started_at) VALUES (${key}, 1, now())`;
  expect((await db`UPDATE auth.sign_in_attempts SET attempt_count = 2, window_started_at = now() WHERE key_hash = ${key}`).count).toBe(1);
  expect(await db`SELECT key_hash, attempt_count, window_started_at FROM auth.sign_in_attempts WHERE key_hash = ${key}`).toHaveLength(1);
  expect((await db`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${key}`).count).toBe(1);

  // Every denied row fails with permission denied.
  const other = sha256(randomBytes(32).toString('hex'));
  const refused: Array<[string, () => Promise<unknown>]> = [
    ['INSERT users.users', () => db`INSERT INTO users.users (email, display_name) VALUES ('x-denied@foundation.test', 'X')`],
    ['UPDATE users.users', () => db`UPDATE users.users SET display_name = 'X' WHERE id = ${account.id}`],
    ['DELETE users.users', () => db`DELETE FROM users.users WHERE id = ${account.id}`],
    ['TRUNCATE users.users', () => db`TRUNCATE users.users CASCADE`],
    ['SELECT users.users.created_at', () => db`SELECT created_at FROM users.users`],
    ['SELECT users.users.updated_at', () => db`SELECT updated_at FROM users.users`],
    ['SELECT users.users FOR UPDATE', () => db`SELECT id FROM users.users WHERE id = ${account.id} FOR UPDATE`],
    ['INSERT auth.password_credentials', () => db`INSERT INTO auth.password_credentials (user_id, password_hash) VALUES (${account.id}, 'x')`],
    ['UPDATE auth.password_credentials', () => db`UPDATE auth.password_credentials SET password_hash = password_hash WHERE user_id = ${account.id}`],
    ['DELETE auth.password_credentials', () => db`DELETE FROM auth.password_credentials WHERE user_id = ${account.id}`],
    ['TRUNCATE auth.password_credentials', () => db`TRUNCATE auth.password_credentials`],
    ['SELECT auth.password_credentials.created_at', () => db`SELECT created_at FROM auth.password_credentials`],
    ['DELETE auth.sessions', () => db`DELETE FROM auth.sessions WHERE id = ${inserted.id}`],
    ['TRUNCATE auth.sessions', () => db`TRUNCATE auth.sessions`],
    ['SELECT auth.sessions.revoked_reason', () => db`SELECT revoked_reason FROM auth.sessions`],
    ['INSERT auth.sessions with id', () => db`INSERT INTO auth.sessions (id, user_id, token_hash, idle_expires_at, expires_at)
      VALUES (gen_random_uuid(), ${account.id}, ${other}, now() + interval '30 minutes', now() + interval '12 hours')`],
    ['INSERT auth.sessions with created_at', () => db`INSERT INTO auth.sessions (user_id, token_hash, created_at, idle_expires_at, expires_at)
      VALUES (${account.id}, ${other}, now(), now() + interval '30 minutes', now() + interval '12 hours')`],
    ['UPDATE auth.sessions.user_id', () => db`UPDATE auth.sessions SET user_id = ${account.id} WHERE id = ${inserted.id}`],
    ['UPDATE auth.sessions.token_hash', () => db`UPDATE auth.sessions SET token_hash = ${other} WHERE id = ${inserted.id}`],
    ['UPDATE auth.sessions.expires_at', () => db`UPDATE auth.sessions SET expires_at = now() WHERE id = ${inserted.id}`],
    ['TRUNCATE auth.sign_in_attempts', () => db`TRUNCATE auth.sign_in_attempts`],
    ['UPDATE auth.sign_in_attempts.key_hash', () => db`UPDATE auth.sign_in_attempts SET key_hash = ${other} WHERE key_hash = ${key}`],
    ['CREATE in users', () => db`CREATE TABLE users.denied_probe (id integer)`],
    ['CREATE in auth', () => db`CREATE TABLE auth.denied_probe (id integer)`],
    ['SET ROLE foundation_owner', () => db`SET ROLE foundation_owner`],
  ];
  for (const [label, run] of refused) expect(await denied(run), label).toBe(true);

  // foundation_backup reads the four tables only after SET ROLE pg_read_all_data; no new role exists.
  const backup = new SQL({ url: backupUrl, max: 1 });
  pools.push(backup);
  for (const table of USERS_AUTH_TABLES) expect(await denied(() => backup.unsafe(`SELECT count(*) FROM ${table}`)), table).toBe(true);
  const counts = await backup.begin(async (tx) => {
    await tx`SET LOCAL ROLE pg_read_all_data`;
    const found: number[] = [];
    for (const table of USERS_AUTH_TABLES) found.push(Number((await tx.unsafe(`SELECT count(*)::int AS count FROM ${table}`))[0].count));
    return found;
  });
  expect(counts.every((count) => Number.isInteger(count) && count >= 0)).toBe(true);
  const roles = await admin`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`;
  expect(roles.map((row: Record<string, unknown>) => row.rolname)).toEqual(['foundation_admin', 'foundation_backend', 'foundation_backup', 'foundation_migrator', 'foundation_owner']);
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-003 (AC-3): operator command

const USAGE = 'Use create, set-password, or revoke-sessions with --apply\n';
const unreachable = 'postgres://foundation_migrator:unreachable-password@127.0.0.1:1/foundation';

/** One refusal: exit 1, the exact stderr line, and an empty stdout. */
function expectRefused(result: CommandResult, line: string): void {
  expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({ code: 1, stdout: '', stderr: line });
}

test('AUTH-003 every argument form outside the table gives the usage line, and the error priority holds before any connection', async () => {
  const email = 'auth-forms@foundation.test';
  const forms: string[][] = [
    [],
    ['delete', '--email', email, '--apply'],
    ['set-password', '--mail', email, '--apply'],
    ['set-password', '--email', email, '--email', email, '--apply'],
    ['create', '--display-name', 'Uji', '--email', email, '--apply'],
    ['create', '--email', email, '--display-name', 'Uji'],
    ['set-password', '--email', '', '--apply'],
    ['create', '--email', email, '--display-name', '', '--apply'],
    ['revoke-sessions', '--all'],
    ['revoke-sessions', '--apply', '--all'],
    ['revoke-sessions', '--all', '--apply', '--apply'],
    ['revoke-sessions', '--email', email, '--all', '--apply'],
    ['set-password', '--all', '--apply'],
    ['revoke-sessions', '--email', email],
    ['create', '--email', 'not-an-email', '--apply'],
  ];
  for (const form of forms) expectRefused(await accounts(form, { password: 'short', url: unreachable }), USAGE);
  // Email before display name before password, all before the connection (the DSN cannot be reached).
  expectRefused(await accounts(['create', '--email', 'not-an-email', '--display-name', ' Uji', '--apply'], { password: 'short', url: unreachable }), 'Invalid email\n');
  expectRefused(await accounts(['set-password', '--email', 'Ána@foundation.test', '--apply'], { password: 'short', url: unreachable }), 'Invalid email\n');
  expectRefused(await accounts(['revoke-sessions', '--email', 'no-at-sign', '--apply'], { url: unreachable }), 'Invalid email\n');
  expectRefused(await accounts(['create', '--email', email, '--display-name', ' Uji', '--apply'], { password: 'short', url: unreachable }), 'Invalid display name\n');
  for (const displayName of ['Uji ', 'Uji\u0007', 'a'.repeat(101), 'Uji\u0085']) {
    expectRefused(await accounts(['create', '--email', email, '--display-name', displayName, '--apply'], { password: newPassword(), url: unreachable }), 'Invalid display name\n');
  }
  const invalidPasswords = [undefined, 'a'.repeat(14), 'é'.repeat(14), `${'a'.repeat(20)}\u0007`, 'a'.repeat(129)];
  for (const password of invalidPasswords) {
    expectRefused(await accounts(['create', '--email', email, '--display-name', 'Uji', '--apply'], { password, url: unreachable }), 'Missing or invalid FOUNDATION_ACCOUNT_PASSWORD\n');
    expectRefused(await accounts(['set-password', '--email', email, '--apply'], { password, url: unreachable }), 'Missing or invalid FOUNDATION_ACCOUNT_PASSWORD\n');
  }
  // revoke-sessions ignores the password, so the next failure is the runner's: no connection.
  expectRefused(await accounts(['revoke-sessions', '--email', email, '--apply'], { password: 'short', url: unreachable }), 'Account command failed\n');
  expectRefused(await accounts(['revoke-sessions', '--all', '--apply'], { url: unreachable }), 'Account command failed\n');
  // Runner failures come before Account not found: the backend DSN is no migrator.
  expectRefused(await accounts(['set-password', '--email', 'auth-unknown@foundation.test', '--apply'], { password: newPassword(), url: backendUrl }), 'Invalid database target or migrator\n');
  expectRefused(await accounts(['revoke-sessions', '--email', 'auth-unknown@foundation.test', '--apply'], { url: backendUrl }), 'Invalid database target or migrator\n');
  expectRefused(await accounts(['set-password', '--email', 'auth-unknown@foundation.test', '--apply'], { url: undefined, password: newPassword() }), 'Account not found\n');
  expectRefused(await accounts(['revoke-sessions', '--email', 'auth-unknown@foundation.test', '--apply']), 'Account not found\n');
}, 120000);

test('AUTH-003 create stores the NFKC hash and the name as given, refuses an existing email without a change, and prints no secret', async () => {
  // A password of 15 full width code points whose NFKC form is ASCII; a name of 100 code points outside the BMP.
  const password = 'ＦｏｕｎｄａｔｉｏｎＰａｓｓ１２';
  const displayName = '😀'.repeat(100);
  const email = `auth-create-${randomBytes(4).toString('hex')}@foundation.test`;
  const created = await accounts(['create', '--email', ` ${email.toUpperCase()} `, '--display-name', displayName, '--apply'], { password });
  expect(created.code).toBe(0);
  expect(created.stderr).toBe('');
  const id = /^Account created: ([0-9a-f-]{36})\n$/.exec(created.stdout)?.[1];
  expect(id).toBeDefined();
  expectNoSecret(created, [password, email, email.toUpperCase()]);
  const [row] = await admin`SELECT u.email, u.display_name, u.created_at = u.updated_at AS same, c.password_hash, c.created_at = c.updated_at AS hash_same
    FROM users.users u JOIN auth.password_credentials c ON c.user_id = u.id WHERE u.id = ${id!}`;
  expect(row).toMatchObject({ email, display_name: displayName, same: true, hash_same: true });
  expect(String(row.password_hash)).toStartWith('$argon2id$v=19$m=19456,t=2,p=1$');
  expect(await Bun.password.verify(password.normalize('NFKC'), String(row.password_hash))).toBe(true);
  expect(await Bun.password.verify(password, String(row.password_hash))).toBe(false);
  // The backend normalizes too, so the raw full width form signs in.
  const signedIn = await signIn({ email, password });
  expect(signedIn.response.status).toBe(200);

  const exists = await accounts(['create', '--email', email, '--display-name', 'Nama Lain', '--apply'], { password: newPassword() });
  expectRefused(exists, 'Account exists\n');
  const [after] = await admin`SELECT u.display_name, c.password_hash FROM users.users u JOIN auth.password_credentials c ON c.user_id = u.id WHERE u.id = ${id!}`;
  expect(after).toEqual({ display_name: displayName, password_hash: row.password_hash });
  expect((await admin`SELECT count(*)::int AS count FROM users.users WHERE email = ${email}`)[0].count).toBe(1);
}, 60000);

test('AUTH-003 set-password writes the hash and updated_at under the account lock and revokes every active session as credential_change', async () => {
  const account = await newAccount('set-password');
  const first = await signIn(account);
  const second = await signIn(account);
  const ended = await signIn(account);
  // An ended session (idle expired) is not active and so not counted.
  await admin`UPDATE auth.sessions SET idle_expires_at = now() - interval '1 second' WHERE id = ${ended.sessionId}`;
  const [before] = await admin`SELECT password_hash, created_at, updated_at FROM auth.password_credentials WHERE user_id = ${account.id}`;
  const password = newPassword();
  const changed = await accounts(['set-password', '--email', account.email, '--apply'], { password });
  expect(changed).toEqual({ code: 0, stdout: `Password changed: ${account.id}; sessions revoked: 2\n`, stderr: '' });
  expectNoSecret(changed, [password, account.password, account.email, String(before.password_hash)]);
  const [after] = await admin`SELECT password_hash, created_at, updated_at, updated_at > ${before.updated_at} AS later FROM auth.password_credentials WHERE user_id = ${account.id}`;
  expect(after.created_at).toEqual(before.created_at);
  expect(after.later).toBe(true);
  expect(await Bun.password.verify(password, String(after.password_hash))).toBe(true);
  for (const session of [first, second]) {
    expect(await sessionRow(session.sessionId)).toMatchObject({ revoked_reason: 'credential_change' });
    expect((await request('GET', '/api/auth/session', { cookie: cookieFor(session.token) })).status).toBe(401);
  }
  expect((await sessionRow(ended.sessionId)).revoked_at).toBeNull();
  expect((await signIn(account)).response.status).toBe(401);
  const renewed = await signIn({ email: account.email, password });
  expect(renewed.response.status).toBe(200);
  // Repeating it is safe: only the session made since is revoked.
  const repeated = await accounts(['set-password', '--email', account.email, '--apply'], { password });
  expect(repeated).toEqual({ code: 0, stdout: `Password changed: ${account.id}; sessions revoked: 1\n`, stderr: '' });
}, 60000);

test('AUTH-003 a set-password that runs while a sign in waits between verification and transaction leaves no active session', async () => {
  const account = await newAccount('race');
  const verifying = deferred();
  const gate = deferred();
  // The verifier of the test: the real Argon2id verification, then the signal, then the wait for the test.
  const app = appOf('development', {
    verify: async (password, hash) => {
      const verified = await Bun.password.verify(password, hash);
      verifying.resolve();
      await gate.promise;
      return verified;
    },
  });
  const pending = signIn(account, { app });
  await verifying.promise;
  const password = newPassword();
  const changed = await accounts(['set-password', '--email', account.email, '--apply'], { password });
  expect(changed.stdout).toBe(`Password changed: ${account.id}; sessions revoked: 0\n`);
  gate.resolve();
  const raced = await pending;
  expect(raced.response.status).toBe(401);
  expect(raced.body).toEqual({ error: 'Invalid credentials' });
  expect(raced.response.headers.getSetCookie()).toEqual([]);
  expect(await activeIds(account.id)).toEqual([]);
  expect((await admin`SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${account.id}`)[0].count).toBe(0);
}, 60000);

test('AUTH-003 set-password and revoke-sessions --email wait on the lock per account of the sign in transaction and change nothing while it is held', async () => {
  // AC-3: both commands take pg_advisory_xact_lock(hashtextextended(user_id::text, 638727)), the lock of the sign in
  // transaction, so a sign in that read the old hash under that lock has committed its session before the command
  // revokes the sessions of the account. The race test above resumes the sign in only after set-password finished, so it
  // proves the second hash read, not this lock. Here an admin transaction holds the lock instead of a sign in.
  const account = await newAccount('operator-lock');
  /** Runs `args` while the lock is held: the command must wait on it, `held` runs, then the lock is freed. */
  const whileLocked = async (args: string[], password: string | undefined, held: () => Promise<void>): Promise<CommandResult> => {
    const holding = deferred();
    const release = deferred();
    let pid = 0;
    const transaction = admin.begin(async (tx) => {
      await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${account.id}::uuid::text, 638727::bigint))`;
      pid = Number((await tx`SELECT pg_catalog.pg_backend_pid() AS pid`)[0].pid);
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    let finished = false;
    const running = accounts(args, password === undefined ? {} : { password }).finally(() => { finished = true; });
    try {
      // The runner waits at most 5 seconds on a lock (lock_timeout), so the wait is seen well before that.
      let waits = false;
      const deadline = Date.now() + 4000;
      while (!waits && !finished && Date.now() < deadline) {
        waits = await countOf(admin`SELECT count(*)::int AS count FROM pg_catalog.pg_locks w JOIN pg_catalog.pg_locks h
          ON h.pid = ${pid} AND h.locktype = 'advisory' AND h.granted AND w.classid = h.classid AND w.objid = h.objid AND w.objsubid = h.objsubid
          WHERE w.locktype = 'advisory' AND NOT w.granted`) === 1;
        if (!waits) await Bun.sleep(25);
      }
      expect([args[0], waits, finished]).toEqual([args[0], true, false]);
      await held();
    } finally {
      release.resolve();
      await transaction;
    }
    return running;
  };

  const session = await signIn(account);
  const [before] = await admin`SELECT password_hash FROM auth.password_credentials WHERE user_id = ${account.id}`;
  const password = newPassword();
  const changed = await whileLocked(['set-password', '--email', account.email, '--apply'], password, async () => {
    const [now] = await admin`SELECT password_hash FROM auth.password_credentials WHERE user_id = ${account.id}`;
    expect(now.password_hash === before.password_hash).toBe(true);
    expect(await activeIds(account.id)).toEqual([session.sessionId]);
  });
  expect(changed).toEqual({ code: 0, stdout: `Password changed: ${account.id}; sessions revoked: 1\n`, stderr: '' });
  expect(await sessionRow(session.sessionId)).toMatchObject({ revoked_reason: 'credential_change' });

  const renewed = await signIn({ email: account.email, password });
  expect(renewed.response.status).toBe(200);
  const revoked = await whileLocked(['revoke-sessions', '--email', account.email, '--apply'], undefined, async () => {
    expect(await activeIds(account.id)).toEqual([renewed.sessionId]);
  });
  expect(revoked).toEqual({ code: 0, stdout: 'Sessions revoked: 1\n', stderr: '' });
  expect(await sessionRow(renewed.sessionId)).toMatchObject({ revoked_reason: 'operator' });
}, 60000);

test('AUTH-003 revoke-sessions for one account and for all accounts revokes active sessions as operator, and a second run revokes 0', async () => {
  const one = await newAccount('revoke-one');
  const two = await newAccount('revoke-two');
  const oneSessions = [await signIn(one), await signIn(one)];
  const twoSession = await signIn(two);
  // FOUNDATION_ACCOUNT_PASSWORD is ignored, also when it is invalid.
  const revoked = await accounts(['revoke-sessions', '--email', one.email, '--apply'], { password: 'short' });
  expect(revoked).toEqual({ code: 0, stdout: 'Sessions revoked: 2\n', stderr: '' });
  expectNoSecret(revoked, [one.email, one.password]);
  for (const session of oneSessions) expect(await sessionRow(session.sessionId)).toMatchObject({ revoked_reason: 'operator' });
  expect((await sessionRow(twoSession.sessionId)).revoked_at).toBeNull();
  expect(await accounts(['revoke-sessions', '--email', one.email, '--apply'])).toEqual({ code: 0, stdout: 'Sessions revoked: 0\n', stderr: '' });

  const [{ count: active }] = await admin`SELECT count(*)::int AS count FROM auth.sessions WHERE revoked_at IS NULL AND idle_expires_at > now()`;
  expect(active).toBeGreaterThan(0);
  const all = await accounts(['revoke-sessions', '--all', '--apply']);
  expect(all).toEqual({ code: 0, stdout: `Sessions revoked: ${active}\n`, stderr: '' });
  expect(await sessionRow(twoSession.sessionId)).toMatchObject({ revoked_reason: 'operator' });
  expect((await request('GET', '/api/auth/session', { cookie: cookieFor(twoSession.token) })).status).toBe(401);
  expect(await accounts(['revoke-sessions', '--all', '--apply'])).toEqual({ code: 0, stdout: 'Sessions revoked: 0\n', stderr: '' });
  const [{ count: left }] = await admin`SELECT count(*)::int AS count FROM auth.sessions WHERE revoked_at IS NULL AND idle_expires_at > now()`;
  expect(left).toBe(0);
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-004 (AC-4): sign in

test('AUTH-004 sign in in both compositions answers 200 with one cookie of the mode, stores only the token hash, and sets the lifetimes from now() of the database', async () => {
  const account = await newAccount('sign-in');
  for (const mode of ['development', 'production'] as const) {
    const signed = await signIn(account, { mode });
    expect(signed.response.status).toBe(200);
    expect(signed.response.headers.get('cache-control')).toBe('no-store');
    expect(signed.response.headers.getSetCookie()).toEqual([`${COOKIE[mode]}=${signed.token}; ${ATTRIBUTES[mode]}`]);
    expect(Object.keys(signed.body).sort()).toEqual(['csrfToken', 'session', 'user']);
    expect(signed.body.user).toEqual({ id: account.id, email: account.email, displayName: account.displayName });
    expect(signed.body.csrfToken).toBe(csrfOf(signed.token));
    expect(JSON.stringify(signed.body)).not.toContain(signed.token);
    const [row] = await admin`SELECT token_hash, user_id, revoked_at, expires_at - created_at = interval '12 hours' AS absolute,
        idle_expires_at - created_at = interval '30 minutes' AS idle, last_seen_at = created_at AS seen
      FROM auth.sessions WHERE id = ${signed.sessionId}`;
    expect(row).toEqual({ token_hash: sha256(signed.token), user_id: account.id, revoked_at: null, absolute: true, idle: true, seen: true });
    expect((await admin`SELECT count(*)::int AS count FROM auth.sessions WHERE token_hash = ${signed.token}`)[0].count).toBe(0);
  }
}, 60000);

test('AUTH-004 a valid session cookie of whoever is revoked as replaced before the new session, and an invalid one changes nothing', async () => {
  const account = await newAccount('rotate');
  const other = await newAccount('rotate-other');
  const first = await signIn(account);
  const rotated = await signIn(account, { cookie: cookieFor(first.token) });
  expect(rotated.response.status).toBe(200);
  expect(rotated.token).not.toBe(first.token);
  expect(await sessionRow(first.sessionId)).toMatchObject({ revoked_reason: 'replaced' });
  expect((await request('GET', '/api/auth/session', { cookie: cookieFor(first.token) })).status).toBe(401);
  // The cookie of another account's session is revoked too.
  const foreign = await signIn(other);
  const crossed = await signIn(account, { cookie: cookieFor(foreign.token) });
  expect(crossed.response.status).toBe(200);
  expect(await sessionRow(foreign.sessionId)).toMatchObject({ revoked_reason: 'replaced' });
  // An ended or unknown cookie revokes nothing and does not stop the sign in.
  const before = await activeIds(account.id);
  const ignored = await signIn(account, { cookie: cookieFor(first.token) });
  expect(ignored.response.status).toBe(200);
  expect(await activeIds(account.id)).toEqual([...before, ignored.sessionId].sort());
  expect((await signIn(account, { cookie: cookieFor('a'.repeat(43)) })).response.status).toBe(200);
}, 60000);

test('AUTH-004 an account keeps at most 10 active sessions: the least recently seen is revoked as session_limit, also for concurrent sign ins', async () => {
  const account = await newAccount('limit');
  const made: string[] = [];
  for (let index = 0; index < 9; index += 1) made.push((await signIn(account)).sessionId);
  // Distinct last_seen_at values, the first made the least recently seen.
  for (const [index, id] of made.entries()) {
    await admin`UPDATE auth.sessions SET last_seen_at = now() - ${`${20 - index} minutes`}::interval WHERE id = ${id}`;
  }
  const tenth = await signIn(account);
  expect((await activeIds(account.id)).length).toBe(10);
  const eleventh = await signIn(account);
  expect(await sessionRow(made[0]!)).toMatchObject({ revoked_reason: 'session_limit' });
  expect(await activeIds(account.id)).toEqual([...made.slice(1), tenth.sessionId, eleventh.sessionId].sort());
  // Two sign ins at once: both new sessions stay, the two least recently seen go, and 10 remain.
  const [left, right] = await Promise.all([signIn(account), signIn(account)]);
  expect([left.response.status, right.response.status]).toEqual([200, 200]);
  const active = await activeIds(account.id);
  expect(active.length).toBe(10);
  expect(active).toContain(left.sessionId);
  expect(active).toContain(right.sessionId);
  for (const id of made.slice(1, 3)) expect(await sessionRow(id)).toMatchObject({ revoked_reason: 'session_limit' });
  const limited = await admin`SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${account.id} AND revoked_reason = 'session_limit'`;
  expect(limited[0].count).toBe(3);
}, 60000);

test('AUTH-004 the attempt row of the email is removed, and a hash changed after verification answers 401 without a session', async () => {
  const account = await newAccount('attempts');
  const key = sha256(`sign-in:${account.email}`);
  const otherKey = sha256('sign-in:auth-someone-else@foundation.test');
  await admin`INSERT INTO auth.sign_in_attempts (key_hash, attempt_count, window_started_at) VALUES (${key}, 3, now()), (${otherKey}, 2, now())`;
  // With the hash changed by the operator between the verification and the transaction, the transaction rolls back.
  const replacement = await Bun.password.hash(newPassword(), { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
  const app = appOf('development', {
    verify: async (password, hash) => {
      const verified = await Bun.password.verify(password, hash);
      await admin`UPDATE auth.password_credentials SET password_hash = ${replacement} WHERE user_id = ${account.id}`;
      return verified;
    },
  });
  const refused = await signIn(account, { app });
  expect(refused.response.status).toBe(401);
  expect(refused.body).toEqual({ error: 'Invalid credentials' });
  expect(refused.response.headers.getSetCookie()).toEqual([]);
  expect((await admin`SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${account.id}`)[0].count).toBe(0);
  expect((await admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts WHERE key_hash = ${key}`)[0].count).toBe(1);
  // With the hash of the account's password back, the sign in succeeds and removes only the row of its own key.
  const original = await Bun.password.hash(account.password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
  await admin`UPDATE auth.password_credentials SET password_hash = ${original} WHERE user_id = ${account.id}`;
  expect((await signIn(account)).response.status).toBe(200);
  expect((await admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts WHERE key_hash = ${key}`)[0].count).toBe(0);
  expect((await admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts WHERE key_hash = ${otherKey}`)[0].count).toBe(1);
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${otherKey}`;
}, 60000);

test('AUTH-004 no pool connection or transaction is held while the password is verified', async () => {
  const account = await newAccount('pool');
  const single = createDatabasePool(backendUrl, { max: 1 });
  pools.push(single);
  const verifying = deferred();
  const gate = deferred();
  const app = appOf('development', {
    verify: async (password, hash) => {
      verifying.resolve();
      await gate.promise;
      return Bun.password.verify(password, hash);
    },
  }, single);
  const pending = signIn(account, { app });
  await verifying.promise;
  // The only connection of the pool answers at once, so the sign in holds no connection while it verifies.
  const probe = await Promise.race([single`SELECT 1 AS one`.then(() => 'free'), Bun.sleep(3000).then(() => 'held')]);
  expect(probe).toBe('free');
  const open = await admin`SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE usename = 'foundation_backend' AND state LIKE 'idle in transaction%'`;
  expect(open[0].count).toBe(0);
  gate.resolve();
  expect((await pending).response.status).toBe(200);
}, 60000);

test('AUTH-004 a sign in whose account lock stays held answers 503 after the 2 second statement limit, without a session, and keeps the attempt row', async () => {
  // Invariant 8: every auth transaction runs with SET LOCAL statement_timeout = '2s', and a database error is 503
  // without a database message. An admin transaction holds the account lock of libs/server/auth/account-lock.ts.
  const account = await newAccount('locked');
  const key = sha256(`sign-in:${account.email}`);
  const holding = deferred();
  const release = deferred();
  const held = admin.begin(async (tx) => {
    await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${account.id}::uuid::text, 638727::bigint))`;
    holding.resolve();
    await release.promise;
  });
  await holding.promise;
  try {
    const started = performance.now();
    const refused = await signIn(account);
    const elapsed = performance.now() - started;
    expect([refused.response.status, refused.body, refused.response.headers.getSetCookie()]).toEqual([503, { error: 'Service unavailable' }, []]);
    expect(refused.response.headers.get('cache-control')).toBe('no-store');
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(10000);
    expect(await countOf(admin`SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${account.id}`)).toBe(0);
    // The reservation committed on its own; the sign in transaction rolled back, so the attempt row stays.
    expect(await countOf(admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts WHERE key_hash = ${key}`)).toBe(1);
  } finally {
    release.resolve();
    await held;
  }
  const signed = await signIn(account);
  expect(signed.response.status).toBe(200);
  expect(await countOf(admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts WHERE key_hash = ${key}`)).toBe(0);
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-007 (AC-7): session validation, lifetimes, and extension

/** The Value sourcing statement *Perpanjangan sesi*, run as foundation_backend; its row count. */
async function extension(id: string): Promise<number> {
  const result = await backend`UPDATE auth.sessions SET last_seen_at = now(), idle_expires_at = least(now() + interval '30 minutes', expires_at)
    WHERE id = ${id} AND revoked_at IS NULL AND idle_expires_at > now() AND last_seen_at <= now() - interval '60 seconds'`;
  return Number(result.count);
}

test('AUTH-007 a missing, malformed, repeated, revoked, idle expired, or absolutely expired session answers 401, removing the cookie when it was sent', async () => {
  const account = await newAccount('validate');
  for (const mode of ['development', 'production'] as const) {
    const signed = await signIn(account, { mode });
    const ok = await request('GET', '/api/auth/session', { mode, cookie: `other=1; ${cookieFor(signed.token, mode)}` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect((await ok.json()).session.id).toBe(signed.sessionId);
    const missing = await request('GET', '/api/auth/session', { mode });
    expect([missing.status, await missing.json(), missing.headers.getSetCookie()]).toEqual([401, { error: 'Unauthorized' }, []]);
    for (const cookie of [
      `${COOKIE[mode]}=${signed.token.slice(1)}`,
      `${COOKIE[mode]}=${signed.token}x`,
      `${COOKIE[mode]}=${signed.token}; ${COOKIE[mode]}=${signed.token}`,
    ]) {
      const refused = await request('GET', '/api/auth/session', { mode, cookie });
      expect([refused.status, await refused.json(), refused.headers.getSetCookie()]).toEqual([401, { error: 'Unauthorized' }, [clearedCookie(mode)]]);
    }
  }
  const revoked = await signIn(account);
  await admin`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'operator' WHERE id = ${revoked.sessionId}`;
  const idle = await signIn(account);
  await admin`UPDATE auth.sessions SET idle_expires_at = now() - interval '1 second' WHERE id = ${idle.sessionId}`;
  const absolute = await signIn(account);
  await admin`UPDATE auth.sessions SET created_at = now() - interval '13 hours', last_seen_at = now() - interval '2 hours',
    idle_expires_at = now() - interval '1 hour', expires_at = now() - interval '1 hour' WHERE id = ${absolute.sessionId}`;
  for (const ended of [revoked, idle, absolute]) {
    const before = await sessionRow(ended.sessionId);
    const refused = await request('GET', '/api/auth/session', { cookie: cookieFor(ended.token) });
    expect([refused.status, await refused.json(), refused.headers.getSetCookie()]).toEqual([401, { error: 'Unauthorized' }, [clearedCookie('development')]]);
    expect((await request('GET', '/api/auth/sessions', { cookie: cookieFor(ended.token) })).status).toBe(401);
    // Never active again, and the GET writes nothing to it.
    expect(await sessionRow(ended.sessionId)).toEqual(before);
    expect(await extension(ended.sessionId)).toBe(0);
  }
}, 60000);

test('AUTH-007 an authenticated request extends last_seen_at and idle_expires_at together at most once per 60 seconds, never past expires_at', async () => {
  const account = await newAccount('extend');
  const signed = await signIn(account);
  const created = await sessionRow(signed.sessionId);
  // Within 60 seconds of the last extension nothing changes.
  const early = await request('GET', '/api/auth/session', { cookie: cookieFor(signed.token) });
  expect(early.status).toBe(200);
  expect(await sessionRow(signed.sessionId)).toEqual(created);
  // 61 seconds later (moved by admin SQL) the GET extends both columns, from now() of the database.
  await admin`UPDATE auth.sessions SET last_seen_at = now() - interval '61 seconds', idle_expires_at = now() + interval '10 minutes' WHERE id = ${signed.sessionId}`;
  const [{ now: before }] = await admin`SELECT now() AS now`;
  const extended = await request('GET', '/api/auth/session', { cookie: cookieFor(signed.token) });
  const body = await extended.json();
  const [row] = await admin`SELECT last_seen_at, idle_expires_at, idle_expires_at - last_seen_at = interval '30 minutes' AS idle,
      last_seen_at >= ${before} AS fresh, expires_at, created_at, token_hash, user_id, revoked_at FROM auth.sessions WHERE id = ${signed.sessionId}`;
  expect(row).toMatchObject({ idle: true, fresh: true, expires_at: created.expires_at, created_at: created.created_at, token_hash: created.token_hash, revoked_at: null });
  expect(body.session.lastSeenAt).toBe((row.last_seen_at as Date).toISOString());
  expect(body.session.idleExpiresAt).toBe((row.idle_expires_at as Date).toISOString());
  // Right after it, a second GET and the list change nothing.
  const once = await sessionRow(signed.sessionId);
  expect((await request('GET', '/api/auth/session', { cookie: cookieFor(signed.token) })).status).toBe(200);
  expect((await request('GET', '/api/auth/sessions', { cookie: cookieFor(signed.token) })).status).toBe(200);
  expect(await sessionRow(signed.sessionId)).toEqual(once);
  // The list extends too once 60 seconds passed.
  await admin`UPDATE auth.sessions SET last_seen_at = now() - interval '61 seconds' WHERE id = ${signed.sessionId}`;
  expect((await request('GET', '/api/auth/sessions', { cookie: cookieFor(signed.token) })).status).toBe(200);
  expect((await admin`SELECT last_seen_at >= ${before} AS fresh FROM auth.sessions WHERE id = ${signed.sessionId}`)[0].fresh).toBe(true);

  // Near the absolute end, the idle time stops at expires_at, and expires_at itself never moves.
  const late = await signIn(account);
  await admin`UPDATE auth.sessions SET created_at = now() - interval '11 hours 59 minutes', expires_at = now() + interval '1 minute',
    idle_expires_at = now() + interval '30 seconds', last_seen_at = now() - interval '2 minutes' WHERE id = ${late.sessionId}`;
  const lateBefore = await sessionRow(late.sessionId);
  expect((await request('GET', '/api/auth/session', { cookie: cookieFor(late.token) })).status).toBe(200);
  const lateAfter = await sessionRow(late.sessionId);
  expect(lateAfter.expires_at).toEqual(lateBefore.expires_at);
  expect(lateAfter.idle_expires_at).toEqual(lateBefore.expires_at);
  // The statement itself: one row for an active session past 60 seconds, zero for a revoked or expired one.
  await admin`UPDATE auth.sessions SET last_seen_at = now() - interval '61 seconds' WHERE id = ${signed.sessionId}`;
  expect(await extension(signed.sessionId)).toBe(1);
  expect(await extension(signed.sessionId)).toBe(0);
}, 60000);

test('AUTH-007 a session read whose extension waits on a held row lock answers 503 after the 2 second statement limit, and extends once the lock is gone', async () => {
  // Invariant 8 on the GET transaction: the extension UPDATE waits for a row lock an admin transaction holds, the
  // statement limit ends the wait, and nothing changes; without the lock the same read extends the session.
  const account = await newAccount('row-lock');
  const signed = await signIn(account);
  expect(signed.response.status).toBe(200);
  await admin`UPDATE auth.sessions SET last_seen_at = last_seen_at - interval '61 seconds' WHERE id = ${signed.sessionId}`;
  const before = await sessionRow(signed.sessionId);
  const holding = deferred();
  const release = deferred();
  const held = admin.begin(async (tx) => {
    await tx`SELECT id FROM auth.sessions WHERE id = ${signed.sessionId} FOR UPDATE`;
    holding.resolve();
    await release.promise;
  });
  await holding.promise;
  try {
    const started = performance.now();
    const read = await request('GET', '/api/auth/session', { cookie: cookieFor(signed.token) });
    const elapsed = performance.now() - started;
    expect([read.status, await read.text()]).toEqual([503, '{"error":"Service unavailable"}']);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(read.headers.getSetCookie()).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(10000);
  } finally {
    release.resolve();
    await held;
  }
  expect(await sessionRow(signed.sessionId)).toEqual(before);
  const extended = await request('GET', '/api/auth/session', { cookie: cookieFor(signed.token) });
  expect(extended.status).toBe(200);
  const after = await sessionRow(signed.sessionId);
  expect((after['last_seen_at'] as Date).getTime()).toBeGreaterThan((before['last_seen_at'] as Date).getTime());
  expect(after['revoked_at']).toBeNull();
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-008 (AC-8): sign out, list, and revocation

test('AUTH-008 sign out revokes the session of the caller as sign_out with 204 and the cookie removed, and its token is refused afterwards', async () => {
  const account = await newAccount('sign-out');
  for (const mode of ['development', 'production'] as const) {
    const signed = await signIn(account, { mode });
    // A CSRF token of the right shape but of another session is 403 and changes nothing.
    const forged = await request('DELETE', '/api/auth/session', { mode, cookie: cookieFor(signed.token, mode), csrf: csrfOf('b'.repeat(43)) });
    expect([forged.status, await forged.json(), forged.headers.getSetCookie()]).toEqual([403, { error: 'Forbidden' }, []]);
    expect((await sessionRow(signed.sessionId)).revoked_at).toBeNull();
    const out = await request('DELETE', '/api/auth/session', { mode, cookie: cookieFor(signed.token, mode), csrf: signed.body.csrfToken });
    expect(out.status).toBe(204);
    expect(await out.text()).toBe('');
    expect(out.headers.get('content-type')).toBeNull();
    expect(out.headers.get('cache-control')).toBe('no-store');
    expect(out.headers.getSetCookie()).toEqual([clearedCookie(mode)]);
    expect(await sessionRow(signed.sessionId)).toMatchObject({ revoked_reason: 'sign_out' });
    // The same token sent again is refused, and a second sign out is a 204 without a change.
    expect((await request('GET', '/api/auth/session', { mode, cookie: cookieFor(signed.token, mode) })).status).toBe(401);
    const revokedAt = (await sessionRow(signed.sessionId)).revoked_at;
    const again = await request('DELETE', '/api/auth/session', { mode, cookie: cookieFor(signed.token, mode), csrf: signed.body.csrfToken });
    expect([again.status, again.headers.getSetCookie()]).toEqual([204, [clearedCookie(mode)]]);
    expect((await sessionRow(signed.sessionId)).revoked_at).toEqual(revokedAt);
  }
  // Without any session, a well formed header gives 204 with the cookie removed and no change.
  const [{ count: before }] = await admin`SELECT count(*)::int AS count FROM auth.sessions WHERE revoked_at IS NOT NULL`;
  const anonymous = await request('DELETE', '/api/auth/session', { csrf: 'c'.repeat(43) });
  expect([anonymous.status, anonymous.headers.getSetCookie()]).toEqual([204, [clearedCookie('development')]]);
  const [{ count: after }] = await admin`SELECT count(*)::int AS count FROM auth.sessions WHERE revoked_at IS NOT NULL`;
  expect(after).toBe(before);
}, 60000);

test('AUTH-008 the list holds only the active sessions of the caller, newest last_seen_at first, with current true exactly on the caller', async () => {
  const account = await newAccount('list');
  const other = await newAccount('list-other');
  const oldest = await signIn(account);
  const middle = await signIn(account);
  const caller = await signIn(account);
  const ended = await signIn(account);
  const foreign = await signIn(other);
  await admin`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'operator' WHERE id = ${ended.sessionId}`;
  await admin`UPDATE auth.sessions SET last_seen_at = now() - interval '10 minutes' WHERE id = ${oldest.sessionId}`;
  await admin`UPDATE auth.sessions SET last_seen_at = now() - interval '5 minutes' WHERE id = ${middle.sessionId}`;
  const listed = await request('GET', '/api/auth/sessions', { cookie: cookieFor(caller.token) });
  expect(listed.status).toBe(200);
  expect(listed.headers.get('cache-control')).toBe('no-store');
  const body = await listed.json();
  expect(body.sessions.map((session: { id: string; current: boolean }) => [session.id, session.current])).toEqual([
    [caller.sessionId, true], [middle.sessionId, false], [oldest.sessionId, false],
  ]);
  for (const session of body.sessions) {
    expect(Object.keys(session).sort()).toEqual(['createdAt', 'current', 'id', 'lastSeenAt']);
    const row = await sessionRow(session.id);
    expect(session.createdAt).toBe((row.created_at as Date).toISOString());
    expect(session.lastSeenAt).toBe((row.last_seen_at as Date).toISOString());
  }
  expect(JSON.stringify(body)).not.toContain(foreign.sessionId);
  // At most ten, even when the account holds ten active sessions and the caller is one of them.
  for (let index = 0; index < 8; index += 1) await signIn(account);
  const full = await (await request('GET', '/api/auth/sessions', { cookie: cookieFor(caller.token) })).json();
  expect(full.sessions).toHaveLength(10);
  expect(full.sessions.filter((session: { current: boolean }) => session.current)).toHaveLength(1);
}, 60000);

test('AUTH-008 the caller revokes its own other session or its current one, while sessions of another user, ended sessions, and unknown ids are 404 without a change', async () => {
  const account = await newAccount('revoke');
  const other = await newAccount('revoke-other');
  const caller = await signIn(account);
  const second = await signIn(account);
  const foreign = await signIn(other);
  const path = (id: string) => `/api/auth/sessions/${id}`;
  const revoke = (id: string, call: Call = {}) => request('DELETE', path(id), { cookie: cookieFor(caller.token), csrf: caller.body.csrfToken, ...call });

  // Another session of the caller: 204 without a cookie change, revoked as revoked, its token refused.
  const done = await revoke(second.sessionId);
  expect([done.status, await done.text(), done.headers.getSetCookie(), done.headers.get('cache-control')]).toEqual([204, '', [], 'no-store']);
  expect(await sessionRow(second.sessionId)).toMatchObject({ revoked_reason: 'revoked' });
  expect((await request('GET', '/api/auth/session', { cookie: cookieFor(second.token) })).status).toBe(401);

  // A session of another user, an ended session, and an unknown id give the same 404 and change nothing.
  const foreignBefore = await sessionRow(foreign.sessionId);
  for (const id of [foreign.sessionId, second.sessionId, '00000000-0000-4000-8000-000000000000']) {
    const missing = await revoke(id);
    expect([missing.status, await missing.json(), missing.headers.getSetCookie()]).toEqual([404, { error: 'Not found' }, []]);
  }
  expect(await sessionRow(foreign.sessionId)).toEqual(foreignBefore);
  expect((await request('GET', '/api/auth/session', { cookie: cookieFor(foreign.token) })).status).toBe(200);

  // A CSRF token of the right shape that does not match is 403, and the target stays.
  const third = await signIn(account);
  const forged = await revoke(third.sessionId, { csrf: csrfOf('d'.repeat(43)) });
  expect([forged.status, await forged.json()]).toEqual([403, { error: 'Forbidden' }]);
  expect((await sessionRow(third.sessionId)).revoked_at).toBeNull();

  // The current session itself: 204 with the cookie removed.
  const own = await revoke(caller.sessionId);
  expect([own.status, own.headers.getSetCookie()]).toEqual([204, [clearedCookie('development')]]);
  expect(await sessionRow(caller.sessionId)).toMatchObject({ revoked_reason: 'revoked' });
  // The token sent again is refused: 401 with the cookie removed, also for the revoke route itself.
  expect((await request('GET', '/api/auth/session', { cookie: cookieFor(caller.token) })).status).toBe(401);
  const after = await revoke(third.sessionId);
  expect([after.status, await after.json(), after.headers.getSetCookie()]).toEqual([401, { error: 'Unauthorized' }, [clearedCookie('development')]]);
  expect((await sessionRow(third.sessionId)).revoked_at).toBeNull();
}, 60000);

test('AUTH-008 two sessions of one account that revoke each other at the same time both get an answer, without a deadlock that answers 503', async () => {
  // A revocation extends the caller and revokes the target. Taken in the order of the request, two sessions that end
  // each other locked the two rows in opposite orders, so PostgreSQL ended one transaction after deadlock_timeout and
  // that request answered 503. The rows are now taken in the order of their ids.
  const account = await newAccount('mutual');
  for (let round = 0; round < 5; round += 1) {
    const one = await signIn(account);
    const two = await signIn(account);
    // Both sessions in use for more than 60 seconds, so the extension of each caller changes (and locks) its row.
    await admin`UPDATE auth.sessions SET last_seen_at = now() - interval '2 minutes' WHERE id IN (${one.sessionId}, ${two.sessionId})`;
    const answers = await Promise.all([
      request('DELETE', `/api/auth/sessions/${two.sessionId}`, { cookie: cookieFor(one.token), csrf: one.body.csrfToken }),
      request('DELETE', `/api/auth/sessions/${one.sessionId}`, { cookie: cookieFor(two.token), csrf: two.body.csrfToken }),
    ]);
    const statuses = answers.map((answer) => answer.status);
    // 401 only when the other request revoked the caller before it was resolved; each 204 revoked its target.
    expect([round, statuses.every((status) => status === 204 || status === 401), statuses.includes(204)]).toEqual([round, true, true]);
    if (statuses[0] === 204) expect(await sessionRow(two.sessionId)).toMatchObject({ revoked_reason: 'revoked' });
    if (statuses[1] === 204) expect(await sessionRow(one.sessionId)).toMatchObject({ revoked_reason: 'revoked' });
  }
}, 60000);

test('AUTH-008 both DELETE routes need a well formed x-csrf-token (400 otherwise, with or without a session), and sessionId outside the lower case UUID pattern is 400', async () => {
  const account = await newAccount('delete-headers');
  const signed = await signIn(account);
  const id = signed.sessionId;
  const routes = ['/api/auth/session', `/api/auth/sessions/${id}`];
  for (const path of routes) {
    for (const call of [{}, { cookie: cookieFor(signed.token) }]) {
      for (const csrf of [undefined, '', 'short', `${signed.body.csrfToken}=`, `${'a'.repeat(42)}!`]) {
        const refused = await request('DELETE', path, { ...call, ...(csrf === undefined ? {} : { csrf }) });
        expect([path, refused.status, await refused.json(), refused.headers.get('cache-control')]).toEqual([path, 400, { error: 'Invalid request' }, 'no-store']);
      }
    }
  }
  for (const target of [`urn:uuid:${id}`, id.toUpperCase(), `{${id}}`, id.replaceAll('-', '')]) {
    const refused = await request('DELETE', `/api/auth/sessions/${target}`, { cookie: cookieFor(signed.token), csrf: signed.body.csrfToken });
    expect([target, refused.status, await refused.json()]).toEqual([target, 400, { error: 'Invalid request' }]);
  }
  expect((await sessionRow(id)).revoked_at).toBeNull();
  // Without a valid session but with a well formed header: the revoke route is 401, sign out 204.
  const revoke = await request('DELETE', `/api/auth/sessions/${id}`, { csrf: 'e'.repeat(43) });
  expect([revoke.status, await revoke.json(), revoke.headers.getSetCookie()]).toEqual([401, { error: 'Unauthorized' }, []]);
  expect((await sessionRow(id)).revoked_at).toBeNull();
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// Helpers of the defence tests

const HASH_PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';
const keyOf = (email: string) => sha256(`sign-in:${email}`);
let unknownNumber = 0;
/** An email that no account has, unique per call. */
const unknownEmail = (label: string) => `nobody-${label}-${(unknownNumber += 1)}@foundation.test`;

/** The attempt row of an email, or `undefined`. */
async function attemptRow(email: string): Promise<{ attempt_count: number; fresh: boolean } | undefined> {
  const [row] = await admin`SELECT attempt_count, window_started_at > now() - interval '15 minutes' AS fresh FROM auth.sign_in_attempts WHERE key_hash = ${keyOf(email)}`;
  return row;
}

const countOf = async (query: Promise<Record<string, unknown>[]>) => Number((await query)[0]!.count);

/** A verifier that records each hash it gets, then runs the real Argon2id verification (or a fixed answer). */
function recordingVerifier(answer?: boolean): { hashes: string[]; auth: NonNullable<AppOptions['auth']> } {
  const hashes: string[] = [];
  return {
    hashes,
    auth: { verify: async (password, hash) => { hashes.push(hash); return answer ?? Bun.password.verify(password, hash); } },
  };
}

type Lines = { info: string[]; error: string[]; sink: { info(line: string): void; error(line: string): void } };
function captureLines(): Lines {
  const info: string[] = [];
  const error: string[] = [];
  return { info, error, sink: { info: (line) => info.push(line), error: (line) => error.push(line) } };
}

/** A production composition on the shared pool with a log sink, and optionally test options. */
const productionWithLog = (lines: Lines, auth?: AppOptions['auth']) =>
  createApp('production', { database: backend, publicOrigin: ORIGIN.production, log: lines.sink, ...(auth === undefined ? {} : { auth }) });

const requestId = () => randomBytes(16).toString('hex');

/** Polls `condition` every 5 ms for at most `ms`. */
async function until(condition: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(5)) if (condition()) return true;
  return condition();
}

// ---------------------------------------------------------------------------------------------------------------
// AUTH-005 (AC-5): no account enumeration

test('AUTH-005 an unknown email and a wrong password get the same 401, the same headers, and no cookie, each after exactly one Argon2id verification and one attempt', async () => {
  const account = await newAccount('enumerate');
  const [{ password_hash: stored }] = await admin`SELECT password_hash FROM auth.password_credentials WHERE user_id = ${account.id}`;
  for (const mode of ['development', 'production'] as const) {
    const verifier = recordingVerifier();
    const app = appOf(mode, verifier.auth);
    const unknown = unknownEmail(`enumerate-${mode}`);
    await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${keyOf(account.email)}`;
    const wrong = await signIn({ email: account.email, password: newPassword() }, { mode, app });
    const missing = await signIn({ email: unknown, password: newPassword() }, { mode, app });
    for (const answer of [wrong, missing]) {
      expect(answer.response.status).toBe(401);
      expect(answer.body).toEqual({ error: 'Invalid credentials' });
      expect(answer.response.headers.getSetCookie()).toEqual([]);
    }
    const headers = (response: Response) => [...response.headers.entries()].filter(([name]) => name !== 'date' && name !== 'x-request-id').sort();
    expect(headers(missing.response)).toEqual(headers(wrong.response));
    // One verification per path with the same parameters: the account's hash, then the dummy hash of this instance.
    expect(verifier.hashes).toHaveLength(2);
    expect(verifier.hashes[0]).toBe(stored);
    for (const hash of verifier.hashes) expect(hash.startsWith(HASH_PREFIX), hash.slice(0, 31)).toBe(true);
    expect(verifier.hashes[1]).not.toBe(stored);
    // One attempt each, counted under the key of the normalized email whether or not the account exists.
    expect(await attemptRow(account.email)).toEqual({ attempt_count: 1, fresh: true });
    expect(await attemptRow(unknown)).toEqual({ attempt_count: 1, fresh: true });
  }
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${keyOf(account.email)}`;
}, 60000);

test('AUTH-005 the median duration of 20 attempts per path, wrong password and unknown email, differs by at most 1.5 times', async () => {
  const account = await newAccount('timing');
  const unknown = unknownEmail('timing');
  const wrong = newPassword();
  const app = appOf('development');
  const clear = () => admin`DELETE FROM auth.sign_in_attempts WHERE key_hash IN (${keyOf(account.email)}, ${keyOf(unknown)})`;
  const timed = async (email: string): Promise<number> => {
    await clear();
    const started = performance.now();
    const answer = await signIn({ email, password: wrong }, { app });
    const took = performance.now() - started;
    expect(answer.response.status).toBe(401);
    return took;
  };
  // Warm up both paths once: the first sign in of the instance creates the dummy hash.
  await timed(account.email);
  await timed(unknown);
  const known: number[] = [];
  const missing: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    known.push(await timed(account.email));
    missing.push(await timed(unknown));
  }
  await clear();
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[9]! + sorted[10]!) / 2;
  };
  const [a, b] = [median(known), median(missing)];
  console.log(`AUTH-005 median sign in duration: wrong password ${a.toFixed(1)} ms, unknown email ${b.toFixed(1)} ms, ratio ${(Math.max(a, b) / Math.min(a, b)).toFixed(2)}`);
  expect(Math.max(a, b) / Math.min(a, b)).toBeLessThanOrEqual(1.5);
}, 120000);

test('AUTH-005 an email outside the Email rule after normalization or a password outside the sign in Password rule is 400 before any attempt row or verification', async () => {
  const account = await newAccount('format');
  const verifier = recordingVerifier();
  const app = appOf('development', verifier.auth);
  const rowsBefore = await countOf(admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts`);
  const refused: [string, string, string][] = [
    ['an email without @', 'not-an-email', account.password],
    ['an email with two @', 'ana@@foundation.test', account.password],
    ['an email without a local part', '@foundation.test', account.password],
    ['an email with a space inside', 'ana @foundation.test', account.password],
    ['an email with a letter outside A to Z', 'änä@foundation.test', account.password],
    ['a local part of 65 characters', `${'a'.repeat(65)}@foundation.test`, account.password],
    ['a password that is not well formed', account.email, `${account.password}\uD800`],
    ['a password of 129 code points', account.email, 'x'.repeat(129)],
    ['a password of 130 code points after NFKC', account.email, 'ﬀ'.repeat(65)],
  ];
  for (const [name, email, password] of refused) {
    const answer = await signIn({ email, password }, { app });
    expect([name, answer.response.status, answer.body]).toEqual([name, 400, { error: 'Invalid request' }]);
    expect(answer.response.headers.get('cache-control')).toBe('no-store');
  }
  expect(verifier.hashes).toEqual([]);
  expect(await countOf(admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts`)).toBe(rowsBefore);
  // Normalization first: surrounding spaces and upper case letters give the same account, so this one signs in.
  const normalized = await signIn({ email: `  ${account.email.toUpperCase()} `, password: account.password }, { app });
  expect(normalized.response.status).toBe(200);
  expect(normalized.body.user?.['id']).toBe(account.id);
}, 60000);

test('AUTH-005 a property outside SignInRequest is dropped before the handler, so the sign in succeeds for the account of the email only', async () => {
  const account = await newAccount('extra');
  const other = await newAccount('extra-other');
  const response = await request('POST', '/api/auth/session', {
    body: JSON.stringify({ email: account.email, password: account.password, userId: other.id, id: other.id, role: 'admin', displayName: 'Admin' }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  const sessionToken = /^foundation_session=([A-Za-z0-9_-]{43});/.exec(response.headers.getSetCookie()[0] ?? '')?.[1] ?? '';
  recordTokenFingerprintsWhenConfigured([sessionToken, typeof body.csrfToken === 'string' ? body.csrfToken : '']);
  expect(body.user).toEqual({ id: account.id, email: account.email, displayName: account.displayName });
  expect(Object.keys(body).sort()).toEqual(['csrfToken', 'session', 'user']);
}, 60000);

test('AUTH-005 a database that cannot be reached answers 503 Service unavailable without a session and without a database message', async () => {
  const account = await newAccount('down');
  const free = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = free.port;
  free.stop(true);
  const unreachable = createDatabasePool(`postgres://foundation_backend:${backendPassword}@127.0.0.1:${port}/foundation`);
  pools.push(unreachable);
  const verifier = recordingVerifier();
  const app = appOf('development', verifier.auth, unreachable);
  const before = await countOf(admin`SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${account.id}`);
  const answer = await signIn(account, { app });
  expect([answer.response.status, answer.body, answer.response.headers.getSetCookie()]).toEqual([503, { error: 'Service unavailable' }, []]);
  expect(answer.response.headers.get('cache-control')).toBe('no-store');
  expect(verifier.hashes).toEqual([]);
  const read = await request('GET', '/api/auth/session', { app, cookie: cookieFor('f'.repeat(43)) });
  expect([read.status, await read.text()]).toEqual([503, '{"error":"Service unavailable"}']);
  expect(await countOf(admin`SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${account.id}`)).toBe(before);
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-006 (AC-6): attempt limit per key, its cleanup, and the verification slots

test('AUTH-006 the eleventh attempt of one key in its window is 429 without verification, also with the right password and for an unknown email, and an ended window allows attempts again', async () => {
  const account = await newAccount('limit-key');
  const unknown = unknownEmail('limit-key');
  const verifier = recordingVerifier();
  const app = appOf('development', verifier.auth);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    // The key is the normalized email, so another spelling of the same email counts for the same key.
    const email = attempt % 2 === 0 ? ` ${account.email.toUpperCase()}` : account.email;
    expect((await signIn({ email, password: newPassword() }, { app })).response.status).toBe(401);
    expect((await signIn({ email: unknown, password: newPassword() }, { app })).response.status).toBe(401);
  }
  expect(verifier.hashes).toHaveLength(20);
  expect(await attemptRow(account.email)).toEqual({ attempt_count: 10, fresh: true });
  const sessionsBefore = await countOf(admin`SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${account.id}`);
  for (const [email, password] of [[account.email, account.password], [unknown, newPassword()]] as const) {
    const limited = await signIn({ email, password }, { app });
    expect([limited.response.status, limited.body, limited.response.headers.getSetCookie()]).toEqual([429, { error: 'Too many requests' }, []]);
    expect(limited.response.headers.get('cache-control')).toBe('no-store');
  }
  expect(verifier.hashes).toHaveLength(20);
  expect(await countOf(admin`SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = ${account.id}`)).toBe(sessionsBefore);
  // The count stays at the limit plus one, whatever more attempts come.
  expect((await signIn(account, { app })).response.status).toBe(429);
  expect(await attemptRow(account.email)).toEqual({ attempt_count: 11, fresh: true });
  // The fixed window ends 15 minutes after it opened (moved through admin SQL): attempts count again from 1.
  await admin`UPDATE auth.sign_in_attempts SET window_started_at = now() - interval '15 minutes' WHERE key_hash IN (${keyOf(account.email)}, ${keyOf(unknown)})`;
  expect((await signIn({ email: unknown, password: newPassword() }, { app })).response.status).toBe(401);
  expect(await attemptRow(unknown)).toEqual({ attempt_count: 1, fresh: true });
  const signed = await signIn(account, { app });
  expect(signed.response.status).toBe(200);
  expect(verifier.hashes).toHaveLength(22);
  // A successful sign in removes the row of its key.
  expect(await attemptRow(account.email)).toBeUndefined();
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${keyOf(unknown)}`;
}, 60000);

test('AUTH-006 concurrent attempts of one key cannot pass the limit together', async () => {
  const unknown = unknownEmail('concurrent');
  const verifier = recordingVerifier(false);
  const app = appOf('development', { ...verifier.auth, slots: { running: 30, queue: 0, waitMs: 0 } });
  const answers = await Promise.all(Array.from({ length: 25 }, () => signIn({ email: unknown, password: newPassword() }, { app })));
  const statuses = answers.map((answer) => answer.response.status).sort();
  expect(statuses.filter((status) => status === 401)).toHaveLength(10);
  expect(statuses.filter((status) => status === 429)).toHaveLength(15);
  expect(verifier.hashes).toHaveLength(10);
  expect(await attemptRow(unknown)).toEqual({ attempt_count: 11, fresh: true });
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${keyOf(unknown)}`;
}, 60000);

test('AUTH-006 each attempt that passes the reservation removes at most ten rows of other keys whose window ended, on both paths, and a refused attempt removes none', async () => {
  const account = await newAccount('cleanup');
  const app = appOf('development', recordingVerifier(false).auth);
  await admin`DELETE FROM auth.sign_in_attempts`;
  const insert = async (count: number, minutes: number) => {
    for (let index = 0; index < count; index += 1) {
      await admin`INSERT INTO auth.sign_in_attempts (key_hash, attempt_count, window_started_at)
        VALUES (${sha256(`cleanup-${randomBytes(8).toString('hex')}`)}, 3, now() - ${`${minutes} minutes`}::interval)`;
    }
  };
  const ended = () => countOf(admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts WHERE window_started_at <= now() - interval '15 minutes'`);
  const running = () => countOf(admin`SELECT count(*)::int AS count FROM auth.sign_in_attempts WHERE window_started_at > now() - interval '15 minutes'`);
  await insert(13, 16);
  await insert(1, 15);
  await insert(2, 14);
  expect([await ended(), await running()]).toEqual([14, 2]);
  // The path of an unknown email: its own new row, ten ended rows of other keys gone.
  const unknown = unknownEmail('cleanup');
  expect((await signIn({ email: unknown, password: newPassword() }, { app })).response.status).toBe(401);
  expect([await ended(), await running()]).toEqual([4, 3]);
  // The path of a known email: the remaining four go, the rows inside their window stay.
  expect((await signIn({ email: account.email, password: newPassword() }, { app })).response.status).toBe(401);
  expect([await ended(), await running()]).toEqual([0, 4]);
  // A refused attempt (429) stops before the cleanup.
  await insert(5, 20);
  const locked = unknownEmail('cleanup-locked');
  await admin`INSERT INTO auth.sign_in_attempts (key_hash, attempt_count, window_started_at) VALUES (${keyOf(locked)}, 10, now())`;
  expect((await signIn({ email: locked, password: newPassword() }, { app })).response.status).toBe(429);
  expect(await ended()).toBe(5);
  // A key's own ended window is opened again by its reservation, never removed by its own cleanup.
  await admin`UPDATE auth.sign_in_attempts SET window_started_at = now() - interval '30 minutes' WHERE key_hash = ${keyOf(unknown)}`;
  expect((await signIn({ email: unknown, password: newPassword() }, { app })).response.status).toBe(401);
  expect(await attemptRow(unknown)).toEqual({ attempt_count: 1, fresh: true });
  expect(await ended()).toBe(0);
  await admin`DELETE FROM auth.sign_in_attempts`;
}, 60000);

test('AUTH-006 with the default slots 4 sign ins verify at once, 12 wait, and the 17th is 503 at once with a sign_in busy event', async () => {
  const lines = captureLines();
  const gate = deferred();
  let entered = 0;
  const app = productionWithLog(lines, { verify: async () => { entered += 1; await gate.promise; return false; } });
  const emails = Array.from({ length: 17 }, () => unknownEmail('slots'));
  const ids = emails.map(() => requestId());
  const settled: number[] = [];
  const pending = emails.map((email, index) => signIn({ email, password: newPassword() }, { mode: 'production', app, headers: { 'x-request-id': ids[index]! } })
    .then((answer) => { settled.push(index); return answer; }));
  expect(await until(() => entered === 4 && settled.length === 1)).toBe(true);
  await Bun.sleep(100);
  // Four verify, twelve wait, and one answered at once.
  expect([entered, settled.length]).toEqual([4, 1]);
  const busyIndex = settled[0]!;
  const busy = await pending[busyIndex]!;
  expect([busy.response.status, busy.body]).toEqual([503, { error: 'Service unavailable' }]);
  const events = lines.info.map((line) => JSON.parse(line)).filter((line) => line.event === 'auth');
  expect(events).toEqual([{
    time: events[0]?.time, level: 'info', event: 'auth', requestId: ids[busyIndex], action: 'sign_in', outcome: 'busy',
    userId: null, sessionId: null, accountKey: keyOf(emails[busyIndex]!).slice(0, 16),
  }]);
  // The gate opens well inside the 2000 ms wait: every waiting sign in gets a slot and is verified.
  gate.resolve();
  const answers = await Promise.all(pending);
  expect(answers.filter((answer) => answer.response.status === 401)).toHaveLength(16);
  expect(entered).toBe(16);
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash IN ${admin(emails.map(keyOf))}`;
}, 60000);

test('AUTH-006 a sign in whose wait for a slot runs out is 503, and a slot is given back after a verifier error', async () => {
  const gate = deferred();
  let entered = 0;
  let fail = false;
  const app = appOf('development', {
    verify: async () => {
      entered += 1;
      if (fail) throw new Error(`verifier failed ${'g'.repeat(43)}`);
      await gate.promise;
      return false;
    },
    slots: { running: 1, queue: 1, waitMs: 300 },
  });
  const sign = () => signIn({ email: unknownEmail('wait'), password: newPassword() }, { app });
  const first = sign();
  expect(await until(() => entered === 1)).toBe(true);
  const started = performance.now();
  const second = sign();
  const third = await sign();
  // The queue holds one, so the third is refused at once; the second waits 300 ms, then is refused.
  expect([third.response.status, third.body]).toEqual([503, { error: 'Service unavailable' }]);
  const waited = await second;
  expect([waited.response.status, waited.body]).toEqual([503, { error: 'Service unavailable' }]);
  expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  gate.resolve();
  expect((await first).response.status).toBe(401);
  // A verifier that throws gives 500 through the root onError, without its message, and still frees the slot.
  fail = true;
  const failed = await request('POST', '/api/auth/session', { app, body: JSON.stringify({ email: unknownEmail('wait'), password: newPassword() }) });
  expect([failed.status, await failed.text(), failed.headers.get('cache-control')]).toEqual([500, '{"error":"Internal server error"}', 'no-store']);
  fail = false;
  expect((await sign()).response.status).toBe(401);
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash IN (SELECT key_hash FROM auth.sign_in_attempts WHERE window_started_at > now() - interval '15 minutes')`;
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-009 (AC-9): the origin rule against real tables, and no-store on 401

test('AUTH-009 a forged origin or a cross site Sec-Fetch-Site with a valid body changes neither auth.sessions nor auth.sign_in_attempts and never calls the verifier, in both compositions', async () => {
  const account = await newAccount('forged');
  for (const mode of ['development', 'production'] as const) {
    const signed = await signIn(account, { mode });
    const verifier = recordingVerifier();
    const app = appOf(mode, verifier.auth);
    const snapshot = async () => [
      await admin`SELECT id, revoked_at, revoked_reason, last_seen_at, idle_expires_at FROM auth.sessions WHERE user_id = ${account.id} ORDER BY id`,
      await admin`SELECT key_hash, attempt_count, window_started_at FROM auth.sign_in_attempts ORDER BY key_hash`,
    ];
    const before = await snapshot();
    const forgeries: Record<string, string>[] = [{ origin: 'https://evil.test' }, { origin: ORIGIN[mode], 'sec-fetch-site': 'cross-site' }, { origin: 'null' }];
    for (const forged of forgeries) {
      const calls: [string, string, Call][] = [
        ['POST', '/api/auth/session', { body: JSON.stringify({ email: account.email, password: account.password }) }],
        ['DELETE', '/api/auth/session', { cookie: cookieFor(signed.token, mode), csrf: signed.body.csrfToken }],
        ['DELETE', `/api/auth/sessions/${signed.sessionId}`, { cookie: cookieFor(signed.token, mode), csrf: signed.body.csrfToken }],
      ];
      for (const [method, path, call] of calls) {
        const response = await request(method, path, { ...call, mode, app, headers: forged });
        expect([`${method} ${path}`, response.status, await response.json(), response.headers.getSetCookie()]).toEqual([`${method} ${path}`, 403, { error: 'Forbidden' }, []]);
      }
    }
    expect(await snapshot()).toEqual(before);
    expect(verifier.hashes).toEqual([]);
    expect((await request('GET', '/api/auth/session', { mode, cookie: cookieFor(signed.token, mode) })).status).toBe(200);
  }
  // A production composition without publicOrigin refuses every request that changes data, also its own origin.
  const closed = createApp('production', { database: backend });
  const refused = await request('POST', '/api/auth/session', { mode: 'production', app: closed, body: JSON.stringify({ email: account.email, password: account.password }) });
  expect([refused.status, await refused.json()]).toEqual([403, { error: 'Forbidden' }]);
}, 60000);

test('AUTH-009 a 401 under /api/auth/ also carries Cache-Control no-store', async () => {
  const account = await newAccount('no-store');
  for (const mode of ['development', 'production'] as const) {
    for (const path of ['/api/auth/session', '/api/auth/sessions']) {
      const response = await request('GET', path, { mode, cookie: cookieFor('h'.repeat(43), mode) });
      expect([path, response.status, response.headers.get('cache-control')]).toEqual([path, 401, 'no-store']);
    }
    const wrong = await signIn({ email: account.email, password: newPassword() }, { mode });
    expect([wrong.response.status, wrong.response.headers.get('cache-control')]).toEqual([401, 'no-store']);
  }
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${keyOf(account.email)}`;
}, 60000);

// ---------------------------------------------------------------------------------------------------------------
// AUTH-010 (AC-10) with AC-9: the auth log events, and no credential in a response or a log line

test('AUTH-010 each auth event of Log keamanan is one line with the requestId of its request line, and no line holds an email, a password, a cookie, a token, or a CSRF token', async () => {
  const account = await newAccount('events');
  const lines = captureLines();
  const app = productionWithLog(lines);
  const accountKey = keyOf(account.email).slice(0, 16);
  const unknownId = '00000000-0000-4000-8000-000000000000';
  const secrets: string[] = [account.email, account.password];
  /** One request with its own X-Request-Id; returns the response, the request line, and the auth lines of that id. */
  const step = async (method: string, path: string, call: Call) => {
    const id = requestId();
    const response = await request(method, path, { ...call, mode: 'production', app, headers: { ...call.headers, 'x-request-id': id } });
    await response.arrayBuffer();
    await Bun.sleep(20);
    const mine = [...lines.info, ...lines.error].map((line) => JSON.parse(line)).filter((line) => line.requestId === id);
    const requests = mine.filter((line) => line.event === 'request');
    expect(requests, `${method} ${path}`).toHaveLength(1);
    expect(requests[0].status).toBe(response.status);
    const events = mine.filter((line) => line.event === 'auth');
    for (const event of events) {
      expect(Object.keys(event)).toEqual(['time', 'level', 'event', 'requestId', 'action', 'outcome', 'userId', 'sessionId', 'accountKey']);
      expect(event.level).toBe('info');
    }
    return { response, events: events.map(({ action, outcome, userId, sessionId, accountKey: key }) => ({ action, outcome, userId, sessionId, accountKey: key })) };
  };
  const body = (password: string) => JSON.stringify({ email: account.email, password });

  const first = await step('POST', '/api/auth/session', { body: body(account.password) });
  expect(first.response.status).toBe(200);
  // Read the session of the first sign in from the database: the newest active session of the account.
  const [{ id: firstId }] = await admin`SELECT id FROM auth.sessions WHERE user_id = ${account.id} ORDER BY created_at DESC LIMIT 1`;
  expect(first.events).toEqual([{ action: 'sign_in', outcome: 'succeeded', userId: account.id, sessionId: String(firstId), accountKey }]);
  const firstToken = /^__Host-foundation_session=([A-Za-z0-9_-]{43});/.exec(first.response.headers.getSetCookie()[0] ?? '')?.[1] ?? '';
  const firstCsrf = csrfOf(firstToken);
  // *Sidik token uji*: every token a test obtains, before any assertion can print it.
  recordTokenFingerprintsWhenConfigured([firstToken, firstCsrf]);
  secrets.push(firstToken, firstCsrf, sha256(firstToken));

  const failed = await step('POST', '/api/auth/session', { body: body(newPassword()) });
  expect([failed.response.status, failed.events]).toEqual([401, [{ action: 'sign_in', outcome: 'failed', userId: null, sessionId: null, accountKey }]]);

  const second = await step('POST', '/api/auth/session', { body: body(account.password) });
  const secondToken = /^__Host-foundation_session=([A-Za-z0-9_-]{43});/.exec(second.response.headers.getSetCookie()[0] ?? '')?.[1] ?? '';
  recordTokenFingerprintsWhenConfigured([secondToken, csrfOf(secondToken)]);
  const [{ id: secondId }] = await admin`SELECT id FROM auth.sessions WHERE token_hash = ${sha256(secondToken)}`;
  secrets.push(secondToken, csrfOf(secondToken), sha256(secondToken));
  expect(second.events).toEqual([{ action: 'sign_in', outcome: 'succeeded', userId: account.id, sessionId: String(secondId), accountKey }]);

  const cookie = cookieFor(firstToken, 'production');
  const forgedRevoke = await step('DELETE', `/api/auth/sessions/${secondId}`, { cookie, csrf: csrfOf('i'.repeat(43)) });
  expect([forgedRevoke.response.status, forgedRevoke.events]).toEqual([403, [{ action: 'request_rejected', outcome: 'csrf', userId: null, sessionId: null, accountKey: null }]]);
  const revoked = await step('DELETE', `/api/auth/sessions/${secondId}`, { cookie, csrf: firstCsrf });
  expect([revoked.response.status, revoked.events]).toEqual([204, [{ action: 'session_revoke', outcome: 'succeeded', userId: account.id, sessionId: String(secondId), accountKey: null }]]);
  const missing = await step('DELETE', `/api/auth/sessions/${unknownId}`, { cookie, csrf: firstCsrf });
  expect([missing.response.status, missing.events]).toEqual([404, [{ action: 'session_revoke', outcome: 'not_found', userId: account.id, sessionId: null, accountKey: null }]]);
  const forgedOut = await step('DELETE', '/api/auth/session', { cookie, csrf: csrfOf('j'.repeat(43)) });
  expect([forgedOut.response.status, forgedOut.events]).toEqual([403, [{ action: 'request_rejected', outcome: 'csrf', userId: null, sessionId: null, accountKey: null }]]);
  const forgedOrigin = await step('DELETE', '/api/auth/session', { cookie, csrf: firstCsrf, headers: { origin: 'https://evil.test' } });
  expect([forgedOrigin.response.status, forgedOrigin.events]).toEqual([403, [{ action: 'request_rejected', outcome: 'origin', userId: null, sessionId: null, accountKey: null }]]);
  const out = await step('DELETE', '/api/auth/session', { cookie, csrf: firstCsrf });
  expect([out.response.status, out.events]).toEqual([204, [{ action: 'sign_out', outcome: 'succeeded', userId: account.id, sessionId: String(firstId), accountKey: null }]]);
  // Requests outside the table write their request line and no auth line.
  for (const [method, path, call, status] of [
    ['DELETE', '/api/auth/session', { csrf: 'k'.repeat(43) }, 204],
    ['GET', '/api/auth/session', { cookie }, 401],
    ['GET', '/api/auth/sessions', {}, 401],
    ['DELETE', `/api/auth/sessions/${unknownId}`, { cookie, csrf: firstCsrf }, 401],
    ['POST', '/api/auth/session', { body: JSON.stringify({ email: 'not-an-email', password: account.password }) }, 400],
  ] as [string, string, Call, number][]) {
    const quiet = await step(method, path, call);
    expect([`${method} ${path}`, quiet.response.status, quiet.events]).toEqual([`${method} ${path}`, status, []]);
  }
  // The limited outcome: the key at its limit.
  await admin`INSERT INTO auth.sign_in_attempts (key_hash, attempt_count, window_started_at) VALUES (${keyOf(account.email)}, 10, now()) ON CONFLICT (key_hash) DO UPDATE SET attempt_count = 10, window_started_at = now()`;
  const limited = await step('POST', '/api/auth/session', { body: body(account.password) });
  expect([limited.response.status, limited.events]).toEqual([429, [{ action: 'sign_in', outcome: 'limited', userId: null, sessionId: null, accountKey }]]);
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${keyOf(account.email)}`;

  // No line holds a credential, the cookie name, a hash, or a body value.
  const all = [...lines.info, ...lines.error].join('\n');
  for (const secret of secrets) expect(all.includes(secret)).toBe(false);
  for (const marker of ['foundation_session', '$argon2id', 'password', 'email', 'cookie']) expect(all.includes(marker), marker).toBe(false);
  expect(lines.error).toEqual([]);
}, 60000);

test('AUTH-010 no response holds a password, a password hash, a session token, or a token hash; the token is only in Set-Cookie and the CSRF token only in an AuthSession body', async () => {
  const account = await newAccount('responses');
  const seen: { name: string; headers: [string, string][]; body: string; setCookie: string[] }[] = [];
  const record = async (name: string, response: Response) => {
    const setCookie = response.headers.getSetCookie();
    const headers = [...response.headers.entries()].filter(([header]) => header !== 'set-cookie');
    seen.push({ name, headers, body: await response.text(), setCookie });
  };
  const signInBody = JSON.stringify({ email: account.email, password: account.password });
  const signed = await request('POST', '/api/auth/session', { body: signInBody });
  const token = /^foundation_session=([A-Za-z0-9_-]{43});/.exec(signed.headers.getSetCookie()[0] ?? '')?.[1] ?? '';
  recordTokenFingerprintsWhenConfigured([token, csrfOf(token)]);
  expect(token).toHaveLength(43);
  await record('sign in', signed);
  const csrf = csrfOf(token);
  const cookie = cookieFor(token);
  const other = await signIn(account);
  await record('session', await request('GET', '/api/auth/session', { cookie }));
  await record('sessions', await request('GET', '/api/auth/sessions', { cookie }));
  await record('wrong password', await request('POST', '/api/auth/session', { body: JSON.stringify({ email: account.email, password: newPassword() }) }));
  await record('bad body', await request('POST', '/api/auth/session', { body: JSON.stringify({ email: account.email, password: 42 }) }));
  await record('forged csrf', await request('DELETE', '/api/auth/session', { cookie, csrf: csrfOf('l'.repeat(43)) }));
  await record('revoke', await request('DELETE', `/api/auth/sessions/${other.sessionId}`, { cookie, csrf }));
  await record('sign out', await request('DELETE', '/api/auth/session', { cookie, csrf }));
  await record('after sign out', await request('GET', '/api/auth/session', { cookie }));
  const [{ password_hash: hash }] = await admin`SELECT password_hash FROM auth.password_credentials WHERE user_id = ${account.id}`;
  for (const response of seen) {
    const text = `${JSON.stringify(response.headers)}\n${response.body}`;
    for (const [label, value] of [['password', account.password], ['hash', hash], ['token', token], ['token hash', sha256(token)], ['other token', other.token]]) {
      expect(text.includes(value), `${response.name}: ${label}`).toBe(false);
    }
    expect(text.includes('$argon2id$'), response.name).toBe(false);
    // The CSRF token only in the AuthSession bodies of sign in and GET session.
    expect(text.includes(csrf), response.name).toBe(['sign in', 'session'].includes(response.name));
    // The token only in the Set-Cookie of the sign in; the other Set-Cookie values only remove the cookie.
    for (const value of response.setCookie) expect(value.includes(token), response.name).toBe(response.name === 'sign in');
  }
  await admin`DELETE FROM auth.sign_in_attempts WHERE key_hash = ${keyOf(account.email)}`;
}, 60000);
