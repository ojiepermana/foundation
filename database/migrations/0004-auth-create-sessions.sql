CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    CONSTRAINT sessions_user_id_fkey REFERENCES users.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL
    CONSTRAINT sessions_token_hash_key UNIQUE
    CONSTRAINT sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text
    CONSTRAINT sessions_revoked_reason_check CHECK (revoked_reason IN ('sign_out', 'revoked', 'replaced', 'session_limit', 'credential_change', 'operator')),
  CONSTRAINT sessions_revocation_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT sessions_expiry_check CHECK (created_at < expires_at AND idle_expires_at <= expires_at)
);
