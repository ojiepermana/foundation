CREATE TABLE auth.password_credentials (
  user_id uuid PRIMARY KEY
    CONSTRAINT password_credentials_user_id_fkey REFERENCES users.users (id) ON DELETE CASCADE,
  password_hash text NOT NULL
    CONSTRAINT password_credentials_hash_check CHECK (password_hash ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
