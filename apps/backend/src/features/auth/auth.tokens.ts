import { timingSafeEqual } from 'node:crypto';

// Session token, token hash, CSRF token, and session cookie of spec 0014 (tables *Token* and *Cookie sesi*). The token
// lives only in Set-Cookie; the database keeps only its SHA 256; the CSRF token is derived again from the cookie on every
// request and is never stored.

/** Shape of a session token and of a CSRF token: 32 bytes in base64url without padding. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const CSRF_MESSAGE = 'foundation-csrf-v1';

/** 32 bytes from `crypto.getRandomValues`, base64url without padding (43 characters). */
export function newSessionToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** `token_hash`: SHA 256 of the UTF-8 bytes of the token, lower case hex. */
export function tokenHash(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

/** CSRF token: HMAC SHA 256 keyed with the UTF-8 bytes of the session token over `foundation-csrf-v1`, base64url. */
export function csrfToken(token: string): string {
  return new Bun.CryptoHasher('sha256', token).update(CSRF_MESSAGE).digest('base64url');
}

/**
 * Whether the `x-csrf-token` header equals the CSRF token of the session token. Never stored, so it is derived again
 * from the cookie on every request and compared with `timingSafeEqual` at the same length (table *Token*). The route
 * schema already holds the header to 43 characters; any other length is simply no match.
 */
export function csrfMatches(token: string, header: string): boolean {
  const expected = Buffer.from(csrfToken(token));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Key of the sign in attempt row of an email (table *Token*): SHA 256 of `sign-in:` and the normalized email, hex. */
export function attemptKey(email: string): string {
  return new Bun.CryptoHasher('sha256').update(`sign-in:${email}`).digest('hex');
}

/** Name and attributes of the session cookie of one composition mode. */
export interface SessionCookie {
  readonly name: string;
  /** `Set-Cookie` value that sets the token. */
  set(token: string): string;
  /** `Set-Cookie` value that removes the cookie. */
  readonly clear: string;
}

/**
 * Table *Cookie sesi*: the mode of createApp decides the name and attributes, never an environment variable, so
 * production cannot drop `Secure` silently. No `Domain`, `Expires`, or `Max-Age` when setting (a browser session
 * cookie; the server keeps the lifetime); removing adds `Max-Age=0`.
 */
export function sessionCookie(mode: 'development' | 'production'): SessionCookie {
  const name = mode === 'production' ? '__Host-foundation_session' : 'foundation_session';
  const attributes = mode === 'production' ? 'Path=/; Secure; HttpOnly; SameSite=Strict' : 'Path=/; HttpOnly; SameSite=Strict';
  return Object.freeze({
    name,
    set: (token: string) => `${name}=${token}; ${attributes}`,
    clear: `${name}=; ${attributes}; Max-Age=0`,
  });
}

/** What the `Cookie` header holds for the session cookie name. */
export interface PresentedToken {
  /** The session cookie name appears at least once, so a refusal also removes the cookie. */
  sent: boolean;
  /** The token when the name appears exactly once with a value of TOKEN_PATTERN; otherwise no valid session. */
  token: string | null;
}

/**
 * Reads the session cookie from the raw `Cookie` header (routes declare no cookie schema, spec 0014 *Model kontrak*).
 * Pairs are split on `;`; the name is the text before the first `=`, both sides trimmed. A name that appears more than
 * once, or a value outside TOKEN_PATTERN, means no valid session.
 */
export function presentedToken(header: string | null, name: string): PresentedToken {
  if (header === null) return { sent: false, token: null };
  const values: string[] = [];
  for (const pair of header.split(';')) {
    const equals = pair.indexOf('=');
    if (equals === -1) continue;
    if (pair.slice(0, equals).trim() === name) values.push(pair.slice(equals + 1).trim());
  }
  const [value] = values;
  return { sent: values.length > 0, token: values.length === 1 && TOKEN_PATTERN.test(value!) ? value! : null };
}
