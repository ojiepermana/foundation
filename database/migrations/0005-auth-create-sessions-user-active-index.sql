CREATE INDEX sessions_user_active_idx ON auth.sessions (user_id, last_seen_at DESC) WHERE revoked_at IS NULL;
