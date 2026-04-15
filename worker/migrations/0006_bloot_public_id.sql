-- Add public-facing BLT ID for users and migrate trial license keys.

ALTER TABLE users ADD COLUMN public_id TEXT;

UPDATE users
SET public_id = 'BLT-' || lower(substr(hex(randomblob(6)), 1, 4))
  || '-' || lower(substr(hex(randomblob(6)), 1, 4))
  || '-' || lower(substr(hex(randomblob(6)), 1, 4))
WHERE public_id IS NULL OR trim(public_id) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id);

-- Move existing qooti trial licenses from internal id to public_id.
UPDATE licenses
SET license_key = (
  SELECT u.public_id
  FROM users u
  WHERE u.id = licenses.user_id
)
WHERE app_id = 'qooti'
  AND user_id IN (SELECT id FROM users WHERE public_id IS NOT NULL)
  AND license_key = user_id;

-- Keep device maps aligned with migrated license keys.
UPDATE license_devices
SET license_key = (
  SELECT l.license_key
  FROM licenses l
  WHERE l.user_id = (
    SELECT l2.user_id
    FROM licenses l2
    WHERE l2.license_key = license_devices.license_key
    LIMIT 1
  )
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM licenses l
  WHERE l.user_id = (
    SELECT l2.user_id
    FROM licenses l2
    WHERE l2.license_key = license_devices.license_key
    LIMIT 1
  )
  AND l.license_key != license_devices.license_key
);

-- Keep trial device claims aligned with migrated IDs.
UPDATE trial_device_claims
SET first_user_id = (
  SELECT u.public_id
  FROM users u
  WHERE u.id = trial_device_claims.first_user_id
)
WHERE first_user_id IN (SELECT id FROM users WHERE public_id IS NOT NULL);
