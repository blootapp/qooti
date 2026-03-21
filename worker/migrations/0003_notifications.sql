-- Notifications for admin announcements (latest 5 only)
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  title TEXT,
  body TEXT NOT NULL,
  youtube_url TEXT,
  button_text TEXT,
  button_link TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at
  ON notifications(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_active_created
  ON notifications(is_active, created_at DESC);
