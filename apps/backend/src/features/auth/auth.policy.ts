// Policy constants of spec 0014 (table *Kebijakan*). They change only through an update of that spec, never through the
// environment. Lengths of time are PostgreSQL interval texts, because every expiry is computed by the database clock
// (`now()`), never by the backend process clock.

/** Absolute lifetime of a session from `created_at`; never extended. */
export const SESSION_LIFETIME = '12 hours';

/** Idle lifetime of a session; the extension of the lifecycle milestone moves it at most once per 60 seconds. */
export const SESSION_IDLE = '30 minutes';

/** Shortest time between two extensions of the same session. */
export const SESSION_EXTENSION_INTERVAL = '60 seconds';

/** Active sessions per account after a sign in. */
export const SESSIONS_PER_ACCOUNT = 10;

/** Sign in attempts per key in one fixed window. */
export const SIGN_IN_ATTEMPTS = 10;
export const SIGN_IN_WINDOW = '15 minutes';

/** Value sourcing *Pembersihan percobaan*: at most this many attempt rows of other keys with an ended window per attempt. */
export const ATTEMPT_CLEANUP_ROWS = 10;

/** Password verifications per backend process: running at once, waiting in the queue, and the longest wait. */
export const VERIFY_SLOTS = Object.freeze({ running: 4, queue: 12, waitMs: 2000 });
