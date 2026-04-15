-- Enforce one-device policy for all existing Qooti licenses.
UPDATE licenses
SET device_limit = 1
WHERE app_id = 'qooti' OR app_id IS NULL;
