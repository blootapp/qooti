-- Bloot accounts (D1), trial device anti-abuse, licenses extended (app_id, email, plan trial)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  public_id TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  surname TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id);

CREATE TABLE IF NOT EXISTS trial_device_claims (
  device_fingerprint TEXT NOT NULL,
  app_id TEXT NOT NULL,
  first_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_fingerprint, app_id)
);

-- Rebuild licenses: add email + app_id + trial in plan_type CHECK; preserve rows and devices
CREATE TABLE license_devices_backup AS SELECT * FROM license_devices;
DROP TABLE license_devices;

CREATE TABLE licenses_new (
  license_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT,
  app_id TEXT NOT NULL DEFAULT 'qooti',
  plan_type TEXT NOT NULL CHECK (plan_type IN ('lifetime', 'yearly', 'trial')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device_limit INTEGER NOT NULL DEFAULT 3,
  active_devices TEXT NOT NULL DEFAULT '[]',
  revoked_at INTEGER
);

INSERT INTO licenses_new (license_key, user_id, email, app_id, plan_type, issued_at, expires_at, device_limit, active_devices, revoked_at)
SELECT license_key, user_id, NULL, 'qooti', plan_type, issued_at, expires_at, device_limit, active_devices, revoked_at
FROM licenses;

DROP TABLE licenses;
ALTER TABLE licenses_new RENAME TO licenses;

CREATE TABLE license_devices (
  license_key TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (license_key, device_fingerprint),
  FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
);

INSERT OR IGNORE INTO license_devices SELECT * FROM license_devices_backup;
DROP TABLE license_devices_backup;
