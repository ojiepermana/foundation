import { randomBytes } from 'node:crypto';

// Test accounts of spec 0014 for the real browser runs (`test:readiness:real` and `test:tooling:real`): two accounts with
// a random email and password per run, created through `database/accounts.ts create` on the database the run owns, and
// handed to Playwright only through FOUNDATION_E2E_ACCOUNT_EMAIL, FOUNDATION_E2E_ACCOUNT_PASSWORD,
// FOUNDATION_E2E_OTHER_EMAIL, and FOUNDATION_E2E_OTHER_PASSWORD. `test:deployment:real` makes the same two accounts
// through the `migrate` job of the runner image and names the variables FOUNDATION_DEPLOY_AUTH_*. The caller adds both passwords to its scan list before
// anything runs, so no output or artifact may hold them. Nothing here writes a file.

export interface TestAccount {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

/** Output of one child process, as the orchestrations collect it. */
export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Display names of the two accounts; not secret, so the browser specs import them instead of reading a response body. */
export const TEST_ACCOUNT_NAMES = Object.freeze(['Pengguna Uji Satu', 'Pengguna Uji Dua'] as const);

/** Two accounts from one random run seed: distinct emails and 48 hex character passwords (above the 15 minimum). */
export function newTestAccounts(): readonly [TestAccount, TestAccount] {
  const seed = randomBytes(6).toString('hex');
  const account = (index: 0 | 1): TestAccount => ({
    email: `uji-${seed}-${index + 1}@example.test`,
    password: randomBytes(24).toString('hex'),
    displayName: TEST_ACCOUNT_NAMES[index],
  });
  return [account(0), account(1)];
}

/** The Playwright environment of the two accounts. */
export function e2eAccountEnv([account, other]: readonly [TestAccount, TestAccount]): Record<string, string> {
  return {
    FOUNDATION_E2E_ACCOUNT_EMAIL: account.email,
    FOUNDATION_E2E_ACCOUNT_PASSWORD: account.password,
    FOUNDATION_E2E_OTHER_EMAIL: other.email,
    FOUNDATION_E2E_OTHER_PASSWORD: other.password,
  };
}

/**
 * The Playwright environment of the two accounts of `test:deployment:real` (spec 0014: the same as the browser runs,
 * named FOUNDATION_DEPLOY_AUTH_*); `auth_capacity` passes the second pair into the backend container.
 */
export function deploymentAccountEnv([account, other]: readonly [TestAccount, TestAccount]): Record<string, string> {
  return {
    FOUNDATION_DEPLOY_AUTH_ACCOUNT_EMAIL: account.email,
    FOUNDATION_DEPLOY_AUTH_ACCOUNT_PASSWORD: account.password,
    FOUNDATION_DEPLOY_AUTH_OTHER_EMAIL: other.email,
    FOUNDATION_DEPLOY_AUTH_OTHER_PASSWORD: other.password,
  };
}

/**
 * Runs `database/accounts.ts create` once per account with the migrator DSN and the password in
 * FOUNDATION_ACCOUNT_PASSWORD only; the environment holds nothing else but PATH. Resolves to the outputs, in order, so
 * the caller can store and scan them; throws a fixed message when a command does not print `Account created: <uuid>`.
 */
export async function createTestAccounts(
  run: (argv: string[], env: Record<string, string>) => Promise<CommandOutput>,
  migratorUrl: string,
  accounts: readonly TestAccount[],
): Promise<CommandOutput[]> {
  const outputs: CommandOutput[] = [];
  for (const account of accounts) {
    const result = await run([process.execPath, '--no-env-file', 'database/accounts.ts', 'create', '--email', account.email, '--display-name', account.displayName, '--apply'], {
      PATH: process.env['PATH'] ?? '', FOUNDATION_MIGRATOR_DATABASE_URL: migratorUrl, FOUNDATION_ACCOUNT_PASSWORD: account.password,
    });
    outputs.push(result);
    if (result.code !== 0 || !/^Account created: [0-9a-f-]{36}\n$/.test(result.stdout) || result.stderr !== '') {
      throw new Error('Test account creation failed');
    }
  }
  return outputs;
}

/**
 * Labels of the account passwords that the suites of `test:database:real` derive from FOUNDATION_TEST_SECRET_SEED, in
 * the way of *Label secret* of spec 0013 (HMAC SHA 256 of the label with the seed, in hex): `backup-account` for the
 * account BKP-009 makes on the backup source, and `account-1` to `account-<DATABASE_ACCOUNT_PASSWORDS>` for the
 * passwords of tests/integration/database/auth.test.ts in the order it makes them. tests/orchestration/database-real.ts
 * adds every one of them to its scan list (spec 0014, AC-10), so no artifact may hold an account password. A suite run
 * alone, without the seed, uses random passwords instead.
 */
export const DATABASE_ACCOUNT_PASSWORDS = 256;

export function databaseAccountPasswordLabels(): string[] {
  return ['backup-account', ...Array.from({ length: DATABASE_ACCOUNT_PASSWORDS }, (_, index) => `account-${index + 1}`)];
}
