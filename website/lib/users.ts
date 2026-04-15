import { db } from "./db";

export interface User {
  id: number;
  publicId: string;
  email: string;
  name: string;
  surname: string;
  username: string;
  language: "uz" | "en";
  usernameChangedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normUsername(username: string): string {
  return username.trim().toLowerCase();
}

function generatePublicId(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  const makeGroup = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((n) => abc[n % abc.length])
      .join("");
  return `BLT-${makeGroup()}-${makeGroup()}-${makeGroup()}`;
}

function mapUser(row: {
  id: number;
  public_id: string;
  email: string;
  name: string;
  surname: string;
  username: string;
  language?: string;
  username_changed_at?: number | null;
  created_at: number;
  updated_at?: number;
}): User {
  const resolvedPublicId = ensurePublicId(row.id, row.public_id);
  return {
    id: row.id,
    publicId: resolvedPublicId,
    email: row.email,
    name: row.name,
    surname: row.surname,
    username: row.username,
    language: row.language === "en" ? "en" : "uz",
    usernameChangedAt: row.username_changed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function ensurePublicId(id: number, currentPublicId?: string | null): string {
  const existing = String(currentPublicId || "").trim();
  if (existing) return existing;
  for (let i = 0; i < 8; i += 1) {
    const candidate = generatePublicId();
    try {
      db.prepare("UPDATE users SET public_id = ? WHERE id = ? AND (public_id IS NULL OR trim(public_id) = '')").run(
        candidate,
        id
      );
      return candidate;
    } catch (_) {}
  }
  // Last fallback keeps app usable even if DB update races.
  return generatePublicId();
}

export function createUser(data: {
  email: string;
  name: string;
  surname: string;
  username: string;
  passwordHash: string;
}): User | null {
  const email = normEmail(data.email);
  const username = data.username.trim();
  const existing = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
  if (existing) return null;

  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    try {
      const publicId = generatePublicId();
      const stmt = db.prepare(`
        INSERT INTO users (public_id, email, name, surname, username, password_hash, language, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'uz', ?, ?)
      `);
      const result = stmt.run(
        publicId,
        email,
        data.name.trim(),
        data.surname.trim(),
        username,
        data.passwordHash,
        now,
        now
      );
      return {
        id: result.lastInsertRowid as number,
        publicId,
        email,
        name: data.name.trim(),
        surname: data.surname.trim(),
        username,
        language: "uz",
        usernameChangedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    } catch (_) {}
  }
  return null;
}

export function getUserByEmail(email: string): (User & { passwordHash: string }) | null {
  const row = db
    .prepare(
      "SELECT id, public_id, email, name, surname, username, language, username_changed_at, password_hash, created_at, updated_at FROM users WHERE email = ?"
    )
    .get(normEmail(email)) as {
      id: number;
      public_id: string;
      email: string;
      name: string;
      surname: string;
      username: string;
      language?: string;
      username_changed_at?: number | null;
      password_hash: string;
      created_at: number;
      updated_at?: number;
    } | undefined;
  if (!row) return null;
  return {
    ...mapUser(row),
    passwordHash: row.password_hash,
  };
}

export function getUserByUsernameOrEmail(identifier: string): (User & { passwordHash: string }) | null {
  const raw = identifier.trim();
  if (!raw) return null;
  const byUnique = db
    .prepare(
      `SELECT id, public_id, email, name, surname, username, language, username_changed_at, password_hash, created_at, updated_at
       FROM users
       WHERE LOWER(email) = ? OR LOWER(public_id) = ?
       LIMIT 1`
    )
    .get(normEmail(raw), raw.toLowerCase()) as {
      id: number;
      public_id: string;
      email: string;
      name: string;
      surname: string;
      username: string;
      language?: string;
      username_changed_at?: number | null;
      password_hash: string;
      created_at: number;
      updated_at?: number;
    } | undefined;
  if (byUnique) {
    return {
      ...mapUser(byUnique),
      passwordHash: byUnique.password_hash,
    };
  }
  const byUsernameRows = db
    .prepare(
      `SELECT id, public_id, email, name, surname, username, language, username_changed_at, password_hash, created_at, updated_at
       FROM users
       WHERE LOWER(username) = ?
       LIMIT 2`
    )
    .all(normUsername(raw)) as Array<{
    id: number;
    public_id: string;
    email: string;
    name: string;
    surname: string;
    username: string;
    language?: string;
    username_changed_at?: number | null;
    password_hash: string;
    created_at: number;
    updated_at?: number;
  }>;
  if (byUsernameRows.length !== 1) return null;
  return {
    ...mapUser(byUsernameRows[0]),
    passwordHash: byUsernameRows[0].password_hash,
  };
}

export function getUserByPublicId(publicId: string): User | null {
  const row = db
    .prepare(
      "SELECT id, public_id, email, name, surname, username, language, username_changed_at, created_at, updated_at FROM users WHERE public_id = ?"
    )
    .get(publicId.trim()) as
    | {
        id: number;
        public_id: string;
        email: string;
        name: string;
        surname: string;
        username: string;
        language?: string;
        username_changed_at?: number | null;
        created_at: number;
        updated_at?: number;
      }
    | undefined;
  return row ? mapUser(row) : null;
}

export function isEmailAvailable(email: string): boolean {
  const row = db.prepare("SELECT 1 FROM users WHERE email = ?").get(normEmail(email));
  return !row;
}

export function isUsernameAvailable(username: string): boolean {
  return true;
}

export function upsertUserMirror(data: {
  publicId: string;
  email: string;
  name: string;
  surname: string;
  username: string;
  passwordHash?: string;
  language?: "uz" | "en";
}): User {
  const now = Date.now();
  const existingByPublic = getUserByPublicId(data.publicId);
  if (existingByPublic) {
    db.prepare(
      "UPDATE users SET email = ?, name = ?, surname = ?, username = ?, language = ?, updated_at = ? WHERE public_id = ?"
    ).run(
      normEmail(data.email),
      data.name.trim(),
      data.surname.trim(),
      data.username.trim(),
      data.language === "en" ? "en" : "uz",
      now,
      data.publicId
    );
    if (data.passwordHash) {
      db.prepare("UPDATE users SET password_hash = ? WHERE public_id = ?").run(data.passwordHash, data.publicId);
    }
    return getUserByPublicId(data.publicId)!;
  }
  const existingByEmail = getUserByEmail(data.email);
  if (existingByEmail) {
    db.prepare(
      "UPDATE users SET public_id = ?, email = ?, name = ?, surname = ?, username = ?, language = ?, updated_at = ? WHERE id = ?"
    ).run(
      data.publicId,
      normEmail(data.email),
      data.name.trim(),
      data.surname.trim(),
      data.username.trim(),
      data.language === "en" ? "en" : "uz",
      now,
      existingByEmail.id
    );
    if (data.passwordHash) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(data.passwordHash, existingByEmail.id);
    }
    return getUserByPublicId(data.publicId) ?? getUserByEmail(data.email)!;
  }
  const hashValue =
    data.passwordHash || "$2a$10$7EqJtq98hPqEX7fNZaFWoOHiI4iEW3R6qtl8fAvX8ZUBKbjDg7s8e";
  db.prepare(
    `INSERT INTO users
      (public_id, email, name, surname, username, password_hash, language, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.publicId,
    normEmail(data.email),
    data.name.trim(),
    data.surname.trim(),
    data.username.trim(),
    hashValue,
    data.language === "en" ? "en" : "uz",
    now,
    now
  );
  return getUserByPublicId(data.publicId)!;
}

export function updatePasswordHashByEmail(email: string, passwordHash: string): boolean {
  const now = Date.now();
  const result = db
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE email = ?")
    .run(passwordHash, now, normEmail(email));
  return (result.changes || 0) > 0;
}
