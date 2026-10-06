CREATE TABLE users.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL
    CONSTRAINT users_email_key UNIQUE
    CONSTRAINT users_email_check CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email) AND email ~ '^[!-?A-~]{1,64}@[!-?A-~]{1,252}$'),
  display_name text NOT NULL
    CONSTRAINT users_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 100 AND display_name = btrim(display_name) AND display_name !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
