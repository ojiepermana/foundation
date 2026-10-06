import { t } from 'elysia';

// Contract models of spec 0014 (table *Model kontrak*), registered with `.model()` and referenced by name. Every object
// has `additionalProperties: false` and only required properties, without nullable. Elysia's normalization drops
// unknown request properties before the handler and unknown response properties before the answer.

/** Every error text of the five auth operations; `AuthError` answers every 4xx and 5xx status. */
export const AUTH_ERRORS = [
  'Invalid request',
  'Invalid credentials',
  'Unauthorized',
  'Forbidden',
  'Not found',
  'Unsupported media type',
  'Too many requests',
  'Service unavailable',
  'Internal server error',
] as const;

export type AuthErrorText = (typeof AUTH_ERRORS)[number];

const time = () => t.String({ format: 'date-time' });

/** Shape of a CSRF token (and of the session token): 43 characters of base64url without padding. */
const TOKEN_TEXT = '^[A-Za-z0-9_-]{43}$';

export const authModels = {
  // Lengths in UTF-16 units of TypeBox; the handler checks the code point rules of *Kebijakan*.
  SignInRequest: t.Object({
    email: t.String({ minLength: 3, maxLength: 254 }),
    password: t.String({ minLength: 1, maxLength: 256 }),
  }, { additionalProperties: false }),
  AuthSession: t.Object({
    // No `format: email`: users_email_check accepts a domain without a dot, such as admin@localhost.
    user: t.Object({ id: t.String({ format: 'uuid' }), email: t.String(), displayName: t.String() }, { additionalProperties: false }),
    session: t.Object({
      id: t.String({ format: 'uuid' }),
      createdAt: time(),
      lastSeenAt: time(),
      idleExpiresAt: time(),
      expiresAt: time(),
    }, { additionalProperties: false }),
    csrfToken: t.String({ minLength: 43, maxLength: 43, pattern: TOKEN_TEXT }),
  }, { additionalProperties: false }),
  AuthSessionList: t.Object({
    sessions: t.Array(t.Object({
      id: t.String({ format: 'uuid' }),
      createdAt: time(),
      lastSeenAt: time(),
      current: t.Boolean(),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  // `default: undefined` keeps the `default` that UnionEnum adds out of the exported schema.
  AuthError: t.Object({ error: t.UnionEnum([...AUTH_ERRORS], { default: undefined }) }, { additionalProperties: false }),
};

/**
 * Header schema of both DELETE routes: `x-csrf-token` is required with the token pattern, so a missing or malformed
 * header is 400 (step 5) whether or not a session exists. Declared as a `headers` schema, which the export writes as one
 * scalar `in: header` parameter; other request headers stay allowed.
 */
export const csrfHeaders = t.Object({ 'x-csrf-token': t.String({ pattern: TOKEN_TEXT }) });

/**
 * Path schema of `DELETE /api/auth/sessions/{sessionId}`. `format: uuid` of Elysia 1.4.30 accepts the `urn:uuid:` prefix
 * and upper case letters, which PostgreSQL refuses or never stores, so the lower case pattern decides (table *API
 * surface*); anything else is 400.
 */
export const sessionIdParams = t.Object({
  sessionId: t.String({ format: 'uuid', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }),
});
