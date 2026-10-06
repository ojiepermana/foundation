import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test token fingerprints of spec 0014 (*Sidik token uji*): how the artifact scans of `test:database:real`,
// `test:readiness:real`, `test:tooling:real`, and `test:deployment:real` cover session tokens and CSRF tokens without
// ever writing a token.
// The orchestration makes a random 32 byte key and an empty 0600 file in a `mkdtemp` folder of its own, outside every
// artifact root it scans, and gives the key and the path to its child test process. A test that obtains a session
// token (Playwright `context.cookies()`, or `Set-Cookie` in `bun:test`) or a CSRF token adds one line per token: the
// HMAC SHA 256 of the token with that
// key, in hex, never the token. After the child process ends, the orchestration reads the fingerprints and computes
// the HMAC of every run of exactly 43 characters `[A-Za-z0-9_-]` bounded by another character or the file edge in
// every file and output it scans; one match is a finding. The folder is removed after the scan.
//
// This module only uses node: APIs, so the Playwright specs (Node) and the Bun orchestrations import the same code.

/** Variable that carries the key, as 64 hex digits. */
export const TOKEN_KEY_VARIABLE = 'FOUNDATION_TEST_TOKEN_KEY';
/** Variable that carries the path of the fingerprint file. */
export const TOKEN_FINGERPRINTS_VARIABLE = 'FOUNDATION_TEST_TOKEN_FINGERPRINTS';
/** Length of a session token and a CSRF token: 32 bytes in base64url without padding (spec 0014, *Token*). */
export const TOKEN_LENGTH = 43;

const KEY = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** True for a byte of the base64url alphabet: `A-Z`, `a-z`, `0-9`, `_`, and `-`. */
function tokenByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f || byte === 0x2d;
}

/** HMAC SHA 256 in hex of `token` (UTF 8) with the key bytes of `keyHex`. */
export function tokenFingerprint(keyHex: string, token: string): string {
  if (!KEY.test(keyHex)) throw new Error('Token fingerprint key must be 64 hex digits');
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(token, 'utf8').digest('hex');
}

/**
 * The CSRF token of a session token (spec 0014, *Token*): base64url without padding of HMAC SHA 256 with the UTF 8 bytes
 * of the session token as key and `foundation-csrf-v1` as message. A test that holds a session token holds its CSRF
 * token too, so both are fingerprinted.
 */
export function csrfTokenOf(sessionToken: string): string {
  return createHmac('sha256', Buffer.from(sessionToken, 'utf8')).update('foundation-csrf-v1', 'utf8').digest('base64url');
}

/**
 * Every run of exactly 43 base64url characters in `data` that is bounded by another character or the edge of the data,
 * in order. A longer or shorter run is never a candidate.
 */
export function tokenCandidates(data: Uint8Array | string): string[] {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const found: string[] = [];
  let start = -1;
  for (let index = 0; index <= bytes.length; index += 1) {
    const inside = index < bytes.length && tokenByte(bytes[index]!);
    if (inside && start === -1) start = index;
    else if (!inside && start !== -1) {
      if (index - start === TOKEN_LENGTH) found.push(bytes.subarray(start, index).toString('latin1'));
      start = -1;
    }
  }
  return found;
}

/** Number of candidates in `data` whose fingerprint is in `fingerprints`. */
export function tokenMatches(data: Uint8Array | string, keyHex: string, fingerprints: ReadonlySet<string>): number {
  if (fingerprints.size === 0) return 0;
  let matches = 0;
  for (const candidate of tokenCandidates(data)) if (fingerprints.has(tokenFingerprint(keyHex, candidate))) matches += 1;
  return matches;
}

/**
 * For a test process: adds one fingerprint line per token to the file of TOKEN_FINGERPRINTS_VARIABLE, keyed by
 * TOKEN_KEY_VARIABLE. Fails with a fixed message, never a value, when either variable is missing, so a run outside
 * its orchestration cannot skip the mechanism. The token is never written.
 */
export function recordTokenFingerprints(tokens: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): void {
  const key = env[TOKEN_KEY_VARIABLE];
  const file = env[TOKEN_FINGERPRINTS_VARIABLE];
  if (key === undefined || !KEY.test(key) || file === undefined || file === '') {
    throw new Error(`${TOKEN_KEY_VARIABLE} and ${TOKEN_FINGERPRINTS_VARIABLE} are missing; run this spec through its orchestration`);
  }
  if (tokens.length === 0) return;
  appendFileSync(file, tokens.map((token) => `${tokenFingerprint(key, token)}\n`).join(''));
}

/**
 * For a `bun:test` suite that `test:database:real` runs (spec 0014, *Sidik token uji*): records like
 * recordTokenFingerprints when the orchestration set either variable, and does nothing when neither is set, so the
 * suite still runs alone outside its orchestration. The mechanism cannot be skipped there: database-real.ts sets both
 * variables and fails when the fingerprint set is empty after the suites signed in. Empty strings are left out.
 */
export function recordTokenFingerprintsWhenConfigured(tokens: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (env[TOKEN_KEY_VARIABLE] === undefined && env[TOKEN_FINGERPRINTS_VARIABLE] === undefined) return;
  recordTokenFingerprints(tokens.filter((token) => token !== ''), env);
}

/** The fingerprint lines of one file text; a line that is not 64 hex digits is ignored. */
export function parseFingerprints(text: string): Set<string> {
  return new Set(text.split('\n').map((line) => line.trim()).filter((line) => FINGERPRINT.test(line)));
}

/** The fingerprint folder of one orchestration run. */
export type TokenFingerprintStore = Readonly<{
  /** 64 hex digits from 32 random bytes. */
  key: string;
  /** The `mkdtemp` folder, mode 0700, outside every artifact root. */
  folder: string;
  /** The fingerprint file, created empty with mode 0600. */
  file: string;
  /** The two variables for the child test process. */
  env: Readonly<Record<string, string>>;
}>;

/** A new key: 32 random bytes as 64 hex digits. */
export function newTokenKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Creates the folder (in the temporary folder of the system) and the empty 0600 file, with `key` or a new one. A run
 * that fingerprints tokens itself before the folder exists passes the key it already uses.
 */
export async function createTokenFingerprintStore(prefix: string, key: string = newTokenKey()): Promise<TokenFingerprintStore> {
  if (!KEY.test(key)) throw new Error('Token fingerprint key must be 64 hex digits');
  const folder = await mkdtemp(join(tmpdir(), prefix));
  await chmod(folder, 0o700);
  const file = join(folder, 'fingerprints');
  await writeFile(file, '', { mode: 0o600 });
  return { key, folder, file, env: Object.freeze({ [TOKEN_KEY_VARIABLE]: key, [TOKEN_FINGERPRINTS_VARIABLE]: file }) };
}

/** Every fingerprint the child process added so far. */
export async function readFingerprints(store: TokenFingerprintStore): Promise<Set<string>> {
  return parseFingerprints(await readFile(store.file, 'utf8'));
}

/**
 * The positive control of AUTH-010: a random token whose fingerprint is known is written into a temporary file inside
 * the fingerprint folder (outside every artifact), read back, and scanned with the same function as the artifacts. True
 * only when the scan finds it exactly once and finds nothing in the same text without it. The file is removed again.
 */
export async function tokenScanControl(store: TokenFingerprintStore): Promise<boolean> {
  const token = randomBytes(32).toString('base64url');
  const fingerprints = new Set([tokenFingerprint(store.key, token)]);
  const path = join(store.folder, 'control.txt');
  try {
    await writeFile(path, `control "${token}"\n`, { mode: 0o600 });
    const found = tokenMatches(await readFile(path), store.key, fingerprints);
    const absent = tokenMatches('control ""\n', store.key, fingerprints);
    return found === 1 && absent === 0;
  } finally {
    await rm(path, { force: true });
  }
}

/** Removes the folder; a missing folder is fine. */
export async function removeTokenFingerprintStore(store: TokenFingerprintStore | null): Promise<void> {
  if (store !== null) await rm(store.folder, { recursive: true, force: true });
}
