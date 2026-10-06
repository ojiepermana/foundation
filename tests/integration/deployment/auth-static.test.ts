import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// AUTH-014 (spec 0014, AC-15): every document of the table *Dokumen yang diperbarui* holds each of its required strings
// literally, apart from docs/rules/backup.md, whose hook strings BKP-001 checks in backup-static.test.ts. The table is
// written here and compared with the table of the spec, so neither can drift without this test failing, and removing
// any one string from its document is reported with the document and the string. No container, no network.

const root = resolve(import.meta.dir, '../../..');
const SPEC = 'docs/specs/0014-akses-pengguna-lifecycle-sesi/index.md';
/** The one row of the table that BKP-001 checks instead of this test. */
const CHECKED_BY_BKP_001 = 'docs/rules/backup.md';

const read = (path: string) => readFile(join(root, path), 'utf8');

/** *Dokumen yang diperbarui* without docs/rules/backup.md: the strings each document must hold, from the table. */
const DOCUMENT_STRINGS: Readonly<Record<string, readonly string[]>> = {
  'docs/rules/security.md': ['spec 0014', '__Host-foundation_session', 'SameSite=Strict', 'X-CSRF-Token', 'm=19456,t=2,p=1', '10 percobaan per 15 menit', 'onRequest'],
  'docs/rules/database.md': [
    'users.users', 'auth.password_credentials', 'auth.sessions', 'auth.sign_in_attempts',
    'GRANT SELECT (id, email, display_name) ON users.users TO foundation_backend', 'role worker pembersihan', 'revoked_at IS NULL',
  ],
  'docs/rules/deployment.md': [
    'FOUNDATION_PUBLIC_ORIGIN', 'limit_req zone=sign_in', 'database/accounts.ts create', '-e FOUNDATION_ACCOUNT_PASSWORD',
    'revoke-sessions --all --apply', 'publik lewat edge dengan kontrol spec 0014', 'sign_in',
  ],
  'docs/rules/openapi-sdk.md': ['sessionCookie', 'x-csrf-token', 'Route 204 yang juga mendeklarasikan galat tidak memakai map response'],
  'docs/rules/development-commands.md': ['bun run db:accounts create', 'FOUNDATION_ACCOUNT_PASSWORD', 'http://127.0.0.1:8889'],
  'docs/rules/testing.md': ['tests/scenarios/auth.json', 'FOUNDATION_TEST_TOKEN_FINGERPRINTS', 'FOUNDATION_E2E_ACCOUNT_EMAIL'],
  'README.md': ['bun run db:accounts'],
  '.env.example': ['# PUBLIC_ORIGIN='],
};

/** The rows of the table *Dokumen yang diperbarui* of `spec`: each file with the code spans of its second column. */
function specDocumentStrings(spec: string): Record<string, string[]> {
  const start = spec.indexOf('**Dokumen yang diperbarui**');
  if (start < 0) return {};
  const table = spec.slice(start, spec.indexOf('\n\n', spec.indexOf('| --- |', start)));
  const rows: Record<string, string[]> = {};
  for (const line of table.split('\n')) {
    const cells = /^\| `([^`]+)` \| (.+) \|$/.exec(line);
    if (cells !== null) rows[cells[1]!] = [...cells[2]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  }
  return rows;
}

/** Every required string missing from `texts` (path to content), as `<path>: <string>`, in table order. */
function documentProblems(texts: Readonly<Record<string, string>>): string[] {
  const missing: string[] = [];
  for (const [path, strings] of Object.entries(DOCUMENT_STRINGS)) {
    const text = texts[path] ?? '';
    for (const value of strings) if (!text.includes(value)) missing.push(`${path}: ${value}`);
  }
  return missing;
}

async function documents(): Promise<Record<string, string>> {
  const texts: Record<string, string> = {};
  for (const path of Object.keys(DOCUMENT_STRINGS)) texts[path] = await read(path);
  return texts;
}

test('AUTH-014 the documents of Dokumen yang diperbarui hold every required string literally, apart from docs/rules/backup.md that BKP-001 checks', async () => {
  // covers: AC-15 (tabel Dokumen yang diperbarui)
  const rows = specDocumentStrings(await read(SPEC));
  // The spec names docs/rules/backup.md too; that row is BKP-001's, every other row equals the table here.
  expect(Object.keys(rows)).toContain(CHECKED_BY_BKP_001);
  delete rows[CHECKED_BY_BKP_001];
  expect(rows).toEqual(DOCUMENT_STRINGS as Record<string, string[]>);
  expect(documentProblems(await documents())).toEqual([]);
});

test('AUTH-014 a document without one of its required strings is reported with that document and string', async () => {
  // covers: AC-15 (mutasi yang menghapus satu string ditolak)
  const texts = await documents();
  for (const [path, strings] of Object.entries(DOCUMENT_STRINGS)) {
    for (const value of strings) {
      // Removing a string can also remove a longer one that holds it, so the removed string must be among the problems.
      const problems = documentProblems({ ...texts, [path]: texts[path]!.replaceAll(value, '') });
      expect(problems, `${path}: ${value}`).toContain(`${path}: ${value}`);
      expect(problems.every((problem) => problem.startsWith(`${path}: `)), `${path}: ${value}`).toBe(true);
    }
  }
  // A document that is missing altogether names every one of its strings.
  expect(documentProblems({ ...texts, 'README.md': '' })).toEqual(['README.md: bun run db:accounts']);
  // A table row that drifts from the spec fails the comparison above.
  const drifted = specDocumentStrings((await read(SPEC)).replace('`10 percobaan per 15 menit`', '`10 percobaan`'));
  expect(drifted['docs/rules/security.md']).not.toEqual(DOCUMENT_STRINGS['docs/rules/security.md']);
});
