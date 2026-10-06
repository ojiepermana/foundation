CREATE TABLE auth.sign_in_attempts (
  key_hash text PRIMARY KEY
    CONSTRAINT sign_in_attempts_key_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  attempt_count integer NOT NULL
    CONSTRAINT sign_in_attempts_count_check CHECK (attempt_count >= 1),
  window_started_at timestamptz NOT NULL
);
