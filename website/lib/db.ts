import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Use global to reuse the same DB connection across HMR (Next.js dev)
const globalForDb = globalThis as unknown as { __sqlite?: Database.Database };

function getDb(): Database.Database {
  if (globalForDb.__sqlite) return globalForDb.__sqlite;
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "bloot.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  globalForDb.__sqlite = db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      surname TEXT NOT NULL,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'uz',
      username_changed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS app_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_public_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      app_description TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_type TEXT NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0,
      starts_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_subscriptions_user ON app_subscriptions(user_public_id);

    CREATE TABLE IF NOT EXISTS payment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_public_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      paid_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_history_user ON payment_history(user_public_id);
  `);

  ensureColumn(db, "users", "public_id", "TEXT");
  ensureColumn(db, "users", "language", "TEXT NOT NULL DEFAULT 'uz'");
  ensureColumn(db, "users", "username_changed_at", "INTEGER");
  ensureColumn(db, "users", "updated_at", "INTEGER NOT NULL DEFAULT 0");
  ensureUsersAllowDuplicateUsernames(db);
  ensureUserIndexes(db);

  return db;
}

export const db = getDb();

function ensureColumn(db: Database.Database, table: string, col: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${definition}`);
  }
}

function ensureUserIndexes(db: Database.Database) {
  db.exec("DROP INDEX IF EXISTS idx_users_username");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id)");
}

function ensureUsersAllowDuplicateUsernames(db: Database.Database) {
  const tableSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql?: string } | undefined;
  const sql = String(tableSqlRow?.sql || "").toUpperCase();
  if (!sql.includes("USERNAME TEXT NOT NULL UNIQUE")) return;
  db.exec(`
    BEGIN TRANSACTION;
    DROP TABLE IF EXISTS users_no_username_unique;
    CREATE TABLE users_no_username_unique (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      surname TEXT NOT NULL,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'uz',
      username_changed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users_no_username_unique (id, public_id, email, name, surname, username, password_hash, language, username_changed_at, created_at, updated_at)
    SELECT id, public_id, email, name, surname, username, password_hash, language, username_changed_at, created_at, updated_at
    FROM users;
    DROP TABLE users;
    ALTER TABLE users_no_username_unique RENAME TO users;
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    COMMIT;
  `);
}
