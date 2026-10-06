import type { BrowserContext } from '@playwright/test';
import { csrfTokenOf, recordTokenFingerprints } from '../../orchestration/token-fingerprints';

// *Sidik token uji* of spec 0014 for the browser specs: after a sign in, the session cookie of the context is read with
// `context.cookies()` and its token and the CSRF token derived from it are added to the fingerprint file of the
// orchestration, never written anywhere as values. Not a test file: the Playwright configurations only discover
// *.e2e.spec.ts. This file runs on Node, so it imports no Bun module.

/** Session cookie names of both composition modes (spec 0014, *Cookie sesi*). */
const SESSION_COOKIES: readonly string[] = ['foundation_session', '__Host-foundation_session'];

/**
 * Records the fingerprints of every session token the context holds and of its CSRF token, and returns how many session
 * cookies it found, so a caller can expect exactly one right after a sign in.
 */
export async function recordSessionTokens(context: BrowserContext): Promise<number> {
  const tokens = (await context.cookies()).filter((cookie) => SESSION_COOKIES.includes(cookie.name) && cookie.value !== '').map((cookie) => cookie.value);
  recordTokenFingerprints(tokens.flatMap((token) => [token, csrfTokenOf(token)]));
  return tokens.length;
}
