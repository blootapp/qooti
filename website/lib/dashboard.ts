import { compare, hash } from "bcryptjs";
import { db } from "./db";
import { getUserByEmail, getUserByPublicId, isUsernameAvailable } from "./users";

export type PlanType = "trial" | "monthly" | "biannual" | "yearly";
export type AppStatus = "active" | "trial" | "expired";

export interface DashboardUser {
  publicId: string;
  email: string;
  name: string;
  surname: string;
  username: string;
  language: "uz" | "en";
  createdAt: number;
  usernameChangedAt: number | null;
}

export interface DashboardApp {
  appId: string;
  appName: string;
  appDescription: string;
  status: AppStatus;
  planType: PlanType;
  amountPaid: number;
  startsAt: number;
  expiresAt: number;
}

export interface DashboardPayment {
  id: number;
  appId: string;
  amount: number;
  description: string;
  paidAt: number;
}

export function getDashboardUserByEmail(email: string): DashboardUser | null {
  const user = getUserByEmail(email);
  if (!user) return null;
  ensureSeedDataForUser(user.publicId, user.createdAt);
  return {
    publicId: user.publicId,
    email: user.email,
    name: user.name,
    surname: user.surname,
    username: user.username,
    language: user.language,
    createdAt: user.createdAt,
    usernameChangedAt: user.usernameChangedAt,
  };
}

export function getDashboardUserByPublicId(publicId: string): DashboardUser | null {
  const user = getUserByPublicId(publicId);
  if (!user) return null;
  ensureSeedDataForUser(user.publicId, user.createdAt);
  return {
    publicId: user.publicId,
    email: user.email,
    name: user.name,
    surname: user.surname,
    username: user.username,
    language: user.language,
    createdAt: user.createdAt,
    usernameChangedAt: user.usernameChangedAt,
  };
}

export function getUserApps(publicId: string): DashboardApp[] {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT app_id, app_name, app_description, status, plan_type, amount_paid, starts_at, expires_at
       FROM app_subscriptions
       WHERE user_public_id = ?
       ORDER BY created_at ASC`
    )
    .all(publicId) as Array<{
    app_id: string;
    app_name: string;
    app_description: string;
    status: string;
    plan_type: string;
    amount_paid: number;
    starts_at: number;
    expires_at: number;
  }>;
  return rows.map((r) => {
    let status: AppStatus = "active";
    if (r.expires_at <= now) status = "expired";
    else if (r.plan_type === "trial") status = "trial";
    return {
      appId: r.app_id,
      appName: r.app_name,
      appDescription: r.app_description,
      status,
      planType: normalizePlanType(r.plan_type),
      amountPaid: Number(r.amount_paid || 0),
      startsAt: r.starts_at,
      expiresAt: r.expires_at,
    };
  });
}

export function getUserPayments(publicId: string): DashboardPayment[] {
  const rows = db
    .prepare(
      `SELECT id, app_id, amount, description, paid_at
       FROM payment_history
       WHERE user_public_id = ?
       ORDER BY paid_at DESC`
    )
    .all(publicId) as Array<{
    id: number;
    app_id: string;
    amount: number;
    description: string;
    paid_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    appId: r.app_id,
    amount: Number(r.amount || 0),
    description: r.description,
    paidAt: r.paid_at,
  }));
}

export function updateLanguage(publicId: string, language: "uz" | "en"): DashboardUser | null {
  const now = Date.now();
  db.prepare("UPDATE users SET language = ?, updated_at = ? WHERE public_id = ?").run(language, now, publicId);
  return getDashboardUserByPublicId(publicId);
}

export function updateUsername(
  publicId: string,
  username: string
): { ok: true; user: DashboardUser } | { ok: false; error: string; daysRemaining?: number } {
  const normalized = username.trim();
  if (!normalized || normalized.length < 3) {
    return { ok: false, error: "Username must be at least 3 characters." };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    return { ok: false, error: "Username can include only letters, numbers, dot, underscore, and dash." };
  }
  const user = getDashboardUserByPublicId(publicId);
  if (!user) return { ok: false, error: "User not found." };
  if (user.username.toLowerCase() === normalized.toLowerCase()) return { ok: true, user };

  if (!isUsernameAvailable(normalized)) {
    return { ok: false, error: "Bu username band." };
  }

  const now = Date.now();
  if (user.usernameChangedAt) {
    const diffDays = Math.floor((now - user.usernameChangedAt) / (24 * 60 * 60 * 1000));
    if (diffDays < 14) {
      const remaining = 14 - diffDays;
      return {
        ok: false,
        error: `Foydalanuvchi nomini ${remaining} kundan so'ng o'zgartirish mumkin`,
        daysRemaining: remaining,
      };
    }
  }

  db.prepare("UPDATE users SET username = ?, username_changed_at = ?, updated_at = ? WHERE public_id = ?").run(
    normalized,
    now,
    now,
    publicId
  );
  const updated = getDashboardUserByPublicId(publicId);
  if (!updated) return { ok: false, error: "Could not update username." };
  return { ok: true, user: updated };
}

export async function updateEmail(
  publicId: string,
  newEmail: string,
  currentPassword: string
): Promise<{ ok: true; user: DashboardUser } | { ok: false; error: string }> {
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (!normalizedEmail.includes("@")) return { ok: false, error: "Email noto'g'ri." };
  const user = getDashboardUserByPublicId(publicId);
  if (!user) return { ok: false, error: "User not found." };
  const withHash = getUserByEmail(user.email);
  if (!withHash) return { ok: false, error: "User not found." };
  if (!currentPassword) return { ok: false, error: "Current password required." };

  // Simplified confirmation gate for now: require password before updating email.
  // Email verification can be connected later without changing endpoint shape.
  const ok = await compare(currentPassword, withHash.passwordHash);
  if (!ok) return { ok: false, error: "Current password is incorrect." };
  const exists = db.prepare("SELECT 1 FROM users WHERE email = ? AND public_id != ?").get(normalizedEmail, publicId);
  if (exists) return { ok: false, error: "Bu email allaqachon ishlatilgan." };
  const now = Date.now();
  db.prepare("UPDATE users SET email = ?, updated_at = ? WHERE public_id = ?").run(normalizedEmail, now, publicId);
  const updated = getDashboardUserByPublicId(publicId);
  if (!updated) return { ok: false, error: "Could not update email." };
  return { ok: true, user: updated };
}

export async function updatePassword(
  publicId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (newPassword.length < 8) return { ok: false, error: "New password must be at least 8 characters." };
  const user = getDashboardUserByPublicId(publicId);
  if (!user) return { ok: false, error: "User not found." };
  const withHash = getUserByEmail(user.email);
  if (!withHash) return { ok: false, error: "User not found." };
  const ok = await compare(currentPassword, withHash.passwordHash);
  if (!ok) return { ok: false, error: "Current password is incorrect." };
  const newHash = await hash(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE public_id = ?").run(newHash, Date.now(), publicId);
  return { ok: true };
}

export function deleteAccount(publicId: string): { ok: true } | { ok: false; error: string } {
  const user = getDashboardUserByPublicId(publicId);
  if (!user) return { ok: false, error: "User not found." };
  db.prepare("DELETE FROM payment_history WHERE user_public_id = ?").run(publicId);
  db.prepare("DELETE FROM app_subscriptions WHERE user_public_id = ?").run(publicId);
  db.prepare("DELETE FROM users WHERE public_id = ?").run(publicId);
  return { ok: true };
}

function normalizePlanType(value: string): PlanType {
  if (value === "monthly" || value === "biannual" || value === "yearly") return value;
  return "trial";
}

function ensureSeedDataForUser(publicId: string, createdAt: number) {
  const existing = db
    .prepare("SELECT 1 FROM app_subscriptions WHERE user_public_id = ? AND app_id = 'qooti'")
    .get(publicId);
  if (existing) return;
  const now = Date.now();
  const expiresAt = Math.max(createdAt + 7 * 24 * 60 * 60 * 1000, now + 24 * 60 * 60 * 1000);
  db.prepare(
    `INSERT INTO app_subscriptions
      (user_public_id, app_id, app_name, app_description, status, plan_type, amount_paid, starts_at, expires_at, created_at, updated_at)
     VALUES (?, 'qooti', 'qooti', 'Visual inspiration vault', 'trial', 'trial', 0, ?, ?, ?, ?)`
  ).run(publicId, createdAt, expiresAt, now, now);
}
