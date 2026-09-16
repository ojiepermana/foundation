ALTER TABLE sessions ALTER COLUMN reauthenticated_at SET DEFAULT '1970-01-01 00:00:00+00'::timestamptz;
