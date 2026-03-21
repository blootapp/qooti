use log::info;
use rusqlite::{params, Connection, OptionalExtension};
use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::Mutex;

const SCHEMA_VERSION: i32 = 19;

pub struct Db {
    conn: Mutex<Connection>,
}

/// Wraps MutexGuard to log when DB lock is released (helps debug stuck commands).
pub(crate) struct LoggingDbGuard<'a>(std::sync::MutexGuard<'a, Connection>);

impl Deref for LoggingDbGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &*self.0
    }
}
impl DerefMut for LoggingDbGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut *self.0
    }
}
impl Drop for LoggingDbGuard<'_> {
    fn drop(&mut self) {
        info!("[DB] lock released");
    }
}

impl Db {
    pub fn open(db_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrate(&conn)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    pub fn conn(&self) -> LoggingDbGuard<'_> {
        info!("[DB] lock acquire attempt");
        let guard = self
            .conn
            .lock()
            .expect("db lock (if poisoned, a prior command panicked)");
        info!("[DB] lock acquired");
        LoggingDbGuard(guard)
    }
}

fn migrate(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        [],
    )?;

    let current: i32 = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if current == 0 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS inspirations (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK (type IN ('image','gif','video','link')),
                title TEXT,
                source_url TEXT,
                original_filename TEXT,
                stored_path TEXT,
                thumbnail_path TEXT,
                display_row TEXT,
                aspect_ratio REAL,
                ocr_text TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS collection_items (
                collection_id TEXT NOT NULL,
                inspiration_id TEXT NOT NULL,
                position INTEGER,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (collection_id, inspiration_id),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (inspiration_id) REFERENCES inspirations(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS moodboards (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                canvas_width INTEGER NOT NULL DEFAULT 1920,
                canvas_height INTEGER NOT NULL DEFAULT 1080,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS moodboard_items (
                id TEXT PRIMARY KEY,
                moodboard_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('inspiration','text')),
                inspiration_id TEXT,
                x REAL NOT NULL DEFAULT 0,
                y REAL NOT NULL DEFAULT 0,
                scale_x REAL NOT NULL DEFAULT 1,
                scale_y REAL NOT NULL DEFAULT 1,
                rotation REAL NOT NULL DEFAULT 0,
                z_index INTEGER NOT NULL DEFAULT 0,
                width REAL,
                height REAL,
                text TEXT,
                style_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (moodboard_id) REFERENCES moodboards(id) ON DELETE CASCADE,
                FOREIGN KEY (inspiration_id) REFERENCES inspirations(id) ON DELETE SET NULL
            );
        "#,
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params![SCHEMA_VERSION],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO preferences(key, value) VALUES (?, ?)",
            params!["theme", "dark"],
        )?;
        tx.commit()?;
    }

    if current < 2 {
        let _ = conn.execute("ALTER TABLE inspirations ADD COLUMN display_row TEXT", []);
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["2"],
        )?;
    }

    if current < 3 {
        let _ = conn.execute("ALTER TABLE inspirations ADD COLUMN aspect_ratio REAL", []);
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["3"],
        )?;
    }

    if current < 4 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                type TEXT NOT NULL,
                origin TEXT NOT NULL CHECK (origin IN ('system','computed','user')),
                created_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_label_type ON tags(label, type);
            CREATE TABLE IF NOT EXISTS inspiration_tags (
                inspiration_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (inspiration_id, tag_id),
                FOREIGN KEY (inspiration_id) REFERENCES inspirations(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );
        "#,
        )?;
        let _ = conn.execute("ALTER TABLE inspirations ADD COLUMN palette TEXT", []);
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["4"],
        )?;
    }

    if current < 5 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS license_cache (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                license_key TEXT NOT NULL,
                plan_type TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                last_validated_at INTEGER NOT NULL
            );
        "#,
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["5"],
        )?;
    }

    if current < 6 {
        let _ = conn.execute(
            "ALTER TABLE license_cache ADD COLUMN activated_at INTEGER",
            [],
        );
        conn.execute(
            "UPDATE license_cache SET activated_at = last_validated_at WHERE activated_at IS NULL",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["6"],
        )?;
    }

    if current < 7 {
        conn.execute("CREATE INDEX IF NOT EXISTS idx_inspirations_created_at ON inspirations(created_at DESC)", [])?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["7"],
        )?;
    }

    if current < 8 {
        conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                title TEXT,
                message TEXT NOT NULL,
                youtube_url TEXT,
                button_text TEXT,
                button_link TEXT,
                high_priority INTEGER NOT NULL DEFAULT 0,
                is_global INTEGER NOT NULL DEFAULT 1,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                expires_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS notification_reads (
                notification_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                read_at INTEGER NOT NULL,
                PRIMARY KEY (notification_id, user_id),
                FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_notifications_expires_at ON notifications(expires_at);
            CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(user_id, read_at DESC);
        "#)?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["8"],
        )?;
    }

    if current < 9 {
        let _ = conn.execute(
            "ALTER TABLE notifications ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
            [],
        );
        conn.execute(
            "UPDATE notifications SET is_active = 1 WHERE is_active IS NULL",
            [],
        )?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notifications_active_created ON notifications(is_active, created_at DESC)", [])?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["9"],
        )?;
    }

    if current < 10 {
        let _ = conn.execute(
            "ALTER TABLE inspirations ADD COLUMN ocr_text TEXT NOT NULL DEFAULT ''",
            [],
        );
        conn.execute(
            "UPDATE inspirations SET ocr_text = '' WHERE ocr_text IS NULL",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["10"],
        )?;
    }

    if current < 11 {
        let _ = conn.execute("ALTER TABLE inspirations ADD COLUMN ocr_status TEXT", []);
        conn.execute(
            "UPDATE inspirations SET ocr_status = NULL WHERE ocr_status IS NULL",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["11"],
        )?;
    }

    if current < 12 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tag_usage_counts (tag_id TEXT PRIMARY KEY, usage_count INTEGER NOT NULL DEFAULT 0);",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO tag_usage_counts (tag_id, usage_count) SELECT tag_id, COUNT(*) FROM inspiration_tags GROUP BY tag_id",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["12"],
        )?;
    }

    if current < 13 {
        // Mark tag counts as initialized if table already has data (e.g. from migration 12).
        // Otherwise leave unset so a background backfill runs once.
        let has_counts: i64 = conn
            .query_row("SELECT COUNT(*) FROM tag_usage_counts", [], |r| r.get(0))
            .unwrap_or(0);
        let value = if has_counts > 0 { "1" } else { "0" };
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('tag_count_initialized', ?)",
            params![value],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["13"],
        )?;
    }

    if current < 14 {
        let _ = conn.execute(
            "ALTER TABLE collections ADD COLUMN visible_on_home INTEGER DEFAULT 1",
            [],
        );
        conn.execute(
            "UPDATE collections SET visible_on_home = 1 WHERE visible_on_home IS NULL",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["14"],
        )?;
    }

    if current < 15 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS user_survey_data (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                creative_role TEXT,
                primary_use_case TEXT,
                inspiration_method TEXT,
                discovery_source TEXT,
                creative_level TEXT
            );
            "#,
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["15"],
        )?;
    }

    if current < 16 {
        let _ = conn.execute(
            "ALTER TABLE user_survey_data ADD COLUMN creative_role_detail TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE user_survey_data ADD COLUMN discovery_source_detail TEXT",
            [],
        );
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["16"],
        )?;
    }

    if current < 17 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS feedback_outbox (
                id TEXT PRIMARY KEY,
                message TEXT NOT NULL,
                image_path TEXT,
                timestamp_iso TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL,
                last_error TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feedback_outbox_next_attempt ON feedback_outbox(next_attempt_at, created_at);
            "#,
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["17"],
        )?;
    }

    if current < 18 {
        let _ = conn.execute(
            "ALTER TABLE license_cache ADD COLUMN last_validation_status TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE license_cache ADD COLUMN last_validation_error TEXT",
            [],
        );
        conn.execute(
            "UPDATE license_cache
             SET last_validation_status = CASE
                 WHEN expires_at > strftime('%s','now') THEN 'valid'
                 ELSE 'expired'
             END
             WHERE last_validation_status IS NULL",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["18"],
        )?;
    }

    if current < 19 {
        let _ = conn.execute("ALTER TABLE inspirations ADD COLUMN vault_id TEXT", []);
        let _ = conn.execute("ALTER TABLE inspirations ADD COLUMN mime_type TEXT", []);
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
            params!["19"],
        )?;
    }

    Ok(())
}
