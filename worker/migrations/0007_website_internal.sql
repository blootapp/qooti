-- Website: verification challenges + user profile columns for Bloot dashboard (Edge / no SQLite)

ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'uz';
ALTER TABLE users ADD COLUMN username_changed_at INTEGER;
ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS bloot_verification (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  category TEXT NOT NULL,
  otp_code TEXT,
  profile_json TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bv_email_category ON bloot_verification(email, category);
