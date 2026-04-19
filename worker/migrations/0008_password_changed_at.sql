-- Session invalidation after password change (JWT pwd_ts vs password_changed_at)
ALTER TABLE users ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0;
