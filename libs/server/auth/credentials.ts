// Credential rules shared by the operator command (database/accounts.ts) and the backend (spec 0014, table *Kebijakan*).
// One place holds the email, password, and display name rules and the Argon2id parameters, so the operator and the
// backend never disagree on what a valid value is. Nothing here opens a connection, reads the environment, or logs.

/**
 * Argon2id parameters of table *Kebijakan* (`m=19456,t=2,p=1`). Bun 1.4.2 defaults to `m=65536`, so both costs are
 * written out; parallelism 1 is the only value Bun offers.
 */
export const PASSWORD_HASH_OPTIONS = Object.freeze({ algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 } as const);

/** The hash prefix every stored hash of these parameters starts with. */
export const PASSWORD_HASH_PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';

/** Same pattern and length bounds as the constraint `users_email_check` of `users.users`. */
const EMAIL_PATTERN = /^[!-?A-~]{1,64}@[!-?A-~]{1,252}$/;
const EMAIL_MIN = 3;
const EMAIL_MAX = 254;

const CONTROL = /\p{Cc}/u;
const PASSWORD_RAW_MAX = 128;
const PASSWORD_SET_MIN = 15;
const PASSWORD_SIGN_IN_MIN = 1;
const PASSWORD_MAX = 128;
const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 100;

/** Code points, not UTF-16 units, so a character outside the BMP counts once. */
const codePoints = (value: string) => [...value].length;

/**
 * Normalized email of rule *Email*: surrounding white space removed and the letters A to Z made lower case, then the
 * pattern and length of `users_email_check`. Any other letter stays as it is and so fails the pattern. `null` means the
 * value is not a valid email; the caller answers 400 (sign in) or `Invalid email` (operator).
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (email.length < EMAIL_MIN || email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/**
 * Rule *Password* for both uses, one function so a password that passes the setting rule always passes the sign in
 * rule. The raw value must be well formed UTF-16 and at most 128 code points. Setting (operator) also refuses control
 * characters and needs 15 to 128 code points after NFKC; sign in needs 1 to 128 code points after NFKC. The NFKC form is
 * returned, since that is what is hashed and verified; `null` means the value is refused. Nothing is ever cut.
 */
export function normalizePassword(raw: string, use: 'set' | 'sign-in'): string | null {
  if (!raw.isWellFormed() || codePoints(raw) > PASSWORD_RAW_MAX) return null;
  if (use === 'set' && CONTROL.test(raw)) return null;
  const normalized = raw.normalize('NFKC');
  const length = codePoints(normalized);
  const min = use === 'set' ? PASSWORD_SET_MIN : PASSWORD_SIGN_IN_MIN;
  if (length < min || length > PASSWORD_MAX) return null;
  return normalized;
}

/**
 * Rule *Nama tampilan*: well formed, 1 to 100 code points, no leading or trailing U+0020, and no control character.
 * The value is never cut or normalized; a value that passes is stored as it is.
 */
export function validDisplayName(raw: string): boolean {
  if (!raw.isWellFormed() || CONTROL.test(raw)) return false;
  const length = codePoints(raw);
  return length >= DISPLAY_NAME_MIN && length <= DISPLAY_NAME_MAX && !raw.startsWith(' ') && !raw.endsWith(' ');
}

/** Argon2id hash of an already normalized password with the parameters of table *Kebijakan*. */
export function hashPassword(normalized: string): Promise<string> {
  return Bun.password.hash(normalized, PASSWORD_HASH_OPTIONS);
}
