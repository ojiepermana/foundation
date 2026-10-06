import type { SQL } from 'bun';
import { lockAccount } from '../libs/server/auth/account-lock';
import { hashPassword, normalizeEmail, normalizePassword, validDisplayName } from '../libs/server/auth/credentials';
import { RunnerError, runnerErrorLine, withOwnerTransaction } from './runner';

// Operator account command of spec 0014 (table *Perintah operator*). It runs once, through the owner transaction of
// database/runner.ts (the same identity, locks, owner role, and "every migration applied" condition as the seed), and
// prints exactly one line. It never prints the password, a hash, the email, or the DSN. The password is read only from
// FOUNDATION_ACCOUNT_PASSWORD, and only by `create` and `set-password`; `revoke-sessions` ignores it.

const USAGE = 'Use create, set-password, or revoke-sessions with --apply';

/** A refusal with its one fixed line on stderr and exit 1. */
class CommandError extends Error {}

type Command =
  | { kind: 'create'; email: string; displayName: string }
  | { kind: 'set-password'; email: string }
  | { kind: 'revoke-email'; email: string }
  | { kind: 'revoke-all' };

/**
 * Exact argument forms, in the order of the first column of the table:
 * `create --email <email> --display-name <name> --apply`, `set-password --email <email> --apply`,
 * `revoke-sessions --email <email> --apply`, and `revoke-sessions --all --apply`. A missing or other command, another or
 * repeated flag, another order, an empty flag value, or `--apply` that is missing or not last all give the usage line.
 */
function parse(args: readonly string[]): Command {
  const [command, flag, value] = args;
  if (args.length === 6 && command === 'create' && flag === '--email' && args[3] === '--display-name' && args[5] === '--apply') {
    const displayName = args[4]!;
    if (value !== '' && displayName !== '') return { kind: 'create', email: value!, displayName };
  }
  if (args.length === 4 && flag === '--email' && args[3] === '--apply' && value !== '') {
    if (command === 'set-password') return { kind: 'set-password', email: value! };
    if (command === 'revoke-sessions') return { kind: 'revoke-email', email: value! };
  }
  if (args.length === 3 && command === 'revoke-sessions' && flag === '--all' && args[2] === '--apply') return { kind: 'revoke-all' };
  throw new CommandError(USAGE);
}

type Prepared =
  | { kind: 'create'; email: string; displayName: string; passwordHash: string }
  | { kind: 'set-password'; email: string; passwordHash: string }
  | { kind: 'revoke-email'; email: string }
  | { kind: 'revoke-all' };

/** Rule *Password* for setting, from FOUNDATION_ACCOUNT_PASSWORD only; hashed as its NFKC form. */
async function passwordHashFrom(env: Record<string, string | undefined>): Promise<string> {
  const raw = env['FOUNDATION_ACCOUNT_PASSWORD'];
  const password = raw === undefined ? null : normalizePassword(raw, 'set');
  if (password === null) throw new CommandError('Missing or invalid FOUNDATION_ACCOUNT_PASSWORD');
  return hashPassword(password);
}

/**
 * Checks every input in the order of *Prioritas galat* before any connection: the argument form, the email, the display
 * name, then the password. The password is hashed here too, so no transaction ever waits on Argon2id.
 */
async function prepare(args: readonly string[], env: Record<string, string | undefined>): Promise<Prepared> {
  const command = parse(args);
  if (command.kind === 'revoke-all') return command;
  const email = normalizeEmail(command.email);
  if (email === null) throw new CommandError('Invalid email');
  switch (command.kind) {
    case 'create':
      if (!validDisplayName(command.displayName)) throw new CommandError('Invalid display name');
      return { kind: 'create', email, displayName: command.displayName, passwordHash: await passwordHashFrom(env) };
    case 'set-password':
      return { kind: 'set-password', email, passwordHash: await passwordHashFrom(env) };
    case 'revoke-email':
      return { kind: 'revoke-email', email };
  }
}

/** Creates the user and its password credential in one owner transaction; an existing email changes nothing. */
async function create(tx: SQL, account: { email: string; displayName: string; passwordHash: string }): Promise<string> {
  const [user] = await tx`INSERT INTO users.users (email, display_name) VALUES (${account.email}, ${account.displayName})
    ON CONFLICT (email) DO NOTHING RETURNING id`;
  // Thrown inside the transaction, so it rolls back and nothing is written.
  if (user === undefined) throw new CommandError('Account exists');
  await tx`INSERT INTO auth.password_credentials (user_id, password_hash) VALUES (${user.id}, ${account.passwordHash})`;
  return `Account created: ${String(user.id)}`;
}

/**
 * The id of an account by normalized email, then the lock per account that the sign in transaction takes too, after
 * the two runner locks of the owner transaction. `Account not found` rolls back without a change.
 */
async function lockedAccount(tx: SQL, email: string): Promise<string> {
  const [user] = await tx`SELECT id FROM users.users WHERE email = ${email}`;
  if (user === undefined) throw new CommandError('Account not found');
  const id = String(user.id);
  await lockAccount(tx, id);
  return id;
}

/**
 * Revokes every active session (`revoked_at IS NULL AND idle_expires_at > now()`) of one account, or of every account
 * when `userId` is `null`, with `reason`, and returns how many rows changed. A session that already ended stays as it
 * is, so a second run revokes 0.
 */
async function revokeActive(tx: SQL, userId: string | null, reason: 'credential_change' | 'operator'): Promise<number> {
  const result = userId === null
    ? await tx`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = ${reason}
        WHERE revoked_at IS NULL AND idle_expires_at > now()`
    : await tx`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = ${reason}
        WHERE user_id = ${userId} AND revoked_at IS NULL AND idle_expires_at > now()`;
  return Number(result.count);
}

/**
 * `set-password`: under the lock per account, the new hash and `updated_at = transaction_timestamp()` (no trigger writes
 * it), then every active session of the account revoked as `credential_change`, all in one transaction. A sign in
 * that verified the old password waits on the same lock and then reads the new hash, so it gives no session.
 */
async function setPassword(tx: SQL, email: string, passwordHash: string): Promise<string> {
  const id = await lockedAccount(tx, email);
  await tx`INSERT INTO auth.password_credentials (user_id, password_hash) VALUES (${id}, ${passwordHash})
    ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = transaction_timestamp()`;
  return `Password changed: ${id}; sessions revoked: ${await revokeActive(tx, id, 'credential_change')}`;
}

/**
 * Runs the prepared command in one owner transaction and returns its one stdout line. `root` is the folder whose
 * `database/migrations/` the "every migration applied" condition reads; the repository root when absent.
 */
function apply(sql: SQL, command: Prepared, root: string | undefined): Promise<string> {
  return withOwnerTransaction(sql, async (tx) => {
    switch (command.kind) {
      case 'create': return create(tx, command);
      case 'set-password': return setPassword(tx, command.email, command.passwordHash);
      case 'revoke-email': return `Sessions revoked: ${await revokeActive(tx, await lockedAccount(tx, command.email), 'operator')}`;
      // Without the lock per account: a sign in that ends after this is a new, valid sign in with the password in
      // force, and the restore runbook runs this while the backend is stopped.
      case 'revoke-all': return `Sessions revoked: ${await revokeActive(tx, null, 'operator')}`;
    }
  }, root);
}

/**
 * Runs one command line and returns the exit code; every outcome is exactly one line on stdout or stderr. `root` is
 * for tests only, like the root of `runDatabaseCommand`: BKP-009 runs the command on a restored target whose history
 * holds the restore fixture migration of spec 0013, which the repository does not have. The command line itself never
 * passes it, so the operator command always checks the repository migrations.
 */
export async function accountCommand(args: readonly string[], env: Record<string, string | undefined>, root?: string): Promise<number> {
  let sql: SQL | undefined;
  try {
    const command = await prepare(args, env);
    const url = env['FOUNDATION_MIGRATOR_DATABASE_URL'];
    if (!url) throw new RunnerError('Missing FOUNDATION_MIGRATOR_DATABASE_URL');
    const { createDatabasePool } = await import('../libs/server/database/client');
    sql = createDatabasePool(url, { max: 1 });
    console.log(await apply(sql, command, root));
    return 0;
  } catch (error) {
    if (error instanceof CommandError) console.error(error.message);
    else if (error instanceof RunnerError) console.error(runnerErrorLine(error));
    else console.error('Account command failed');
    return 1;
  } finally {
    // A failed close never adds a second line or changes the exit code.
    if (sql) await sql.close().catch(() => undefined);
  }
}

if (import.meta.main) process.exitCode = await accountCommand(process.argv.slice(2), Bun.env);
