-- Qooti licenses table (D1)
CREATE TABLE IF NOT EXISTS licenses (
  license_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'admin',
  plan_type TEXT NOT NULL CHECK (plan_type IN ('lifetime', 'yearly')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device_limit INTEGER NOT NULL DEFAULT 3,
  active_devices TEXT NOT NULL DEFAULT '[]',
  revoked_at INTEGER
);
