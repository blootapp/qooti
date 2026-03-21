-- Admin redesign: revoked_at, license_devices, admin_logs
-- Status derived at read time: valid = revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)

-- revoked_at now exists in 0001_create_licenses.sql for idempotent setup.

-- Device tracking: separate table for first_seen, last_seen
CREATE TABLE IF NOT EXISTS license_devices (
  license_key TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (license_key, device_fingerprint),
  FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
);

-- Admin audit log (read-only for admins)
CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  license_key TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);

-- Migrate existing active_devices JSON into license_devices
INSERT OR IGNORE INTO license_devices (license_key, device_fingerprint, first_seen, last_seen)
SELECT l.license_key, je.value, l.issued_at, l.issued_at
FROM licenses l, json_each(l.active_devices) je
WHERE json_type(l.active_devices) = 'array'
  AND json_array_length(l.active_devices) > 0;
