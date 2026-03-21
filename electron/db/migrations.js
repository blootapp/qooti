const SCHEMA_VERSION = 3;

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  const current = row ? Number(row.value) : 0;

  if (current === 0) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS inspirations (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('image','gif','video','link')),
          title TEXT,
          source_url TEXT,
          original_filename TEXT,
          stored_path TEXT,
          thumbnail_path TEXT,
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
      `);

      db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run(
        String(SCHEMA_VERSION)
      );

      // Default preferences (dark theme)
      db.prepare(`INSERT OR IGNORE INTO preferences(key, value) VALUES (?, ?)`).run(
        "theme",
        "dark"
      );
    })();
  }

  // Migration: add display_row for placing reels in short-form vs main row
  if (current < 2) {
    db.exec(`ALTER TABLE inspirations ADD COLUMN display_row TEXT`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2')`).run();
  }

  // Migration: add aspect_ratio for classifying vertical vs horizontal content
  if (current < 3) {
    db.exec(`ALTER TABLE inspirations ADD COLUMN aspect_ratio REAL`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3')`).run();
  }

  // Future schema versions: incremental migrations here.
  const finalRow = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  const final = finalRow ? Number(finalRow.value) : 0;
  if (final !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version: ${final} (expected ${SCHEMA_VERSION})`);
  }
}

module.exports = {
  migrate,
  SCHEMA_VERSION
};

