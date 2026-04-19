import { compare, hash } from "bcryptjs";
import {
  internalUserDelete,
  internalUserGet,
  internalUserLicenses,
  internalUserPatch,
  internalUsernameAvailable,
  type InternalDashboardApp,
} from "./bloot-internal-api";
import { getUserByEmail } from "./users";

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

function mapDashboardUser(row: {
  publicId: string;
  email: string;
  name: string;
  surname: string;
  username: string;
  language: "uz" | "en";
  createdAt: number;
  usernameChangedAt: number | null;
}): DashboardUser {
  return {
    publicId: row.publicId,
    email: row.email,
    name: row.name,
    surname: row.surname,
    username: row.username,
    language: row.language,
    createdAt: row.createdAt,
    usernameChangedAt: row.usernameChangedAt,
  };
}

export async function getDashboardUserByEmail(email: string): Promise<DashboardUser | null> {
  const user = await getUserByEmail(email);
  if (!user) return null;
  return mapDashboardUser(user);
}

export async function getDashboardUserByPublicId(publicId: string): Promise<DashboardUser | null> {
  const row = await internalUserGet({ publicId });
  if (!row) return null;
  return mapDashboardUser({
    publicId: row.publicId,
    email: row.email,
    name: row.name,
    surname: row.surname,
    username: row.username,
    language: row.language,
    createdAt: row.createdAt,
    usernameChangedAt: row.usernameChangedAt,
  });
}

function mapApp(r: InternalDashboardApp): DashboardApp {
  let status: AppStatus = "active";
  if (r.status === "expired") status = "expired";
  else if (r.status === "trial") status = "trial";
  else if (r.status === "active") status = "active";
  return {
    appId: r.appId,
    appName: r.appName,
    appDescription: r.appDescription,
    status,
    planType: normalizePlanType(r.planType),
    amountPaid: Number(r.amountPaid || 0),
    startsAt: r.startsAt,
    expiresAt: r.expiresAt,
  };
}

export async function getUserApps(publicId: string): Promise<DashboardApp[]> {
  const { apps } = await internalUserLicenses(publicId);
  return apps.map(mapApp);
}

export async function getUserPayments(_publicId: string): Promise<DashboardPayment[]> {
  return [];
}

export async function updateLanguage(
  publicId: string,
  language: "uz" | "en"
): Promise<DashboardUser | null> {
  const r = await internalUserPatch({ publicId, language });
  if (!r.ok) return null;
  return getDashboardUserByPublicId(publicId);
}

export async function updateUsername(
  publicId: string,
  username: string
): Promise<{ ok: true; user: DashboardUser } | { ok: false; error: string; daysRemaining?: number }> {
  const normalized = username.trim();
  if (!normalized || normalized.length < 3) {
    return { ok: false, error: "Username must be at least 3 characters." };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    return { ok: false, error: "Username can include only letters, numbers, dot, underscore, and dash." };
  }
  const user = await getDashboardUserByPublicId(publicId);
  if (!user) return { ok: false, error: "User not found." };
  if (user.username.toLowerCase() === normalized.toLowerCase()) return { ok: true, user };

  const avail = await internalUsernameAvailable(normalized, publicId);
  if (!avail.available) {
    return { ok: false, error: "Bu username band." };
  }

  const r = await internalUserPatch({ publicId, username: normalized });
  if (r.ok) {
    const updated = await getDashboardUserByPublicId(publicId);
    if (!updated) return { ok: false, error: "Could not update username." };
    return { ok: true, user: updated };
  }
  if (r.error === "username_cooldown" && r.daysRemaining != null) {
    return {
      ok: false,
      error: `Foydalanuvchi nomini ${r.daysRemaining} kundan so'ng o'zgartirish mumkin`,
      daysRemaining: r.daysRemaining,
    };
  }
  if (String(r.error).includes("Username taken")) {
    return { ok: false, error: "Bu username band." };
  }
  return { ok: false, error: r.error || "Could not update username." };
}

export async function updateEmail(
  publicId: string,
  newEmail: string,
  currentPassword: string
): Promise<{ ok: true; user: DashboardUser } | { ok: false; error: string }> {
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (!normalizedEmail.includes("@")) return { ok: false, error: "Email noto'g'ri." };
  const user = await getDashboardUserByPublicId(publicId);
  if (!user) return { ok: false, error: "User not found." };
  const withHash = await getUserByEmail(user.email);
  if (!withHash) return { ok: false, error: "User not found." };
  if (!currentPassword) return { ok: false, error: "Current password required." };

  const pwOk = await compare(currentPassword, withHash.passwordHash);
  if (!pwOk) return { ok: false, error: "Current password is incorrect." };

  const r = await internalUserPatch({ publicId, email: normalizedEmail });
  if (!r.ok) {
    if (String(r.error).includes("Email taken")) {
      return { ok: false, error: "Bu email allaqachon ishlatilgan." };
    }
    return { ok: false, error: r.error || "Could not update email." };
  }
  const updated = await getDashboardUserByPublicId(publicId);
  if (!updated) return { ok: false, error: "Could not update email." };
  return { ok: true, user: updated };
}

export async function updatePassword(
  publicId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (newPassword.length < 8) return { ok: false, error: "New password must be at least 8 characters." };
  const user = await getDashboardUserByPublicId(publicId);
  if (!user) return { ok: false, error: "User not found." };
  const withHash = await getUserByEmail(user.email);
  if (!withHash) return { ok: false, error: "User not found." };
  const okPw = await compare(currentPassword, withHash.passwordHash);
  if (!okPw) return { ok: false, error: "Current password is incorrect." };
  const newHash = await hash(newPassword, 10);
  const r = await internalUserPatch({ publicId, passwordHash: newHash });
  if (!r.ok) return { ok: false, error: r.error || "Could not update password." };
  return { ok: true };
}

export async function deleteAccount(publicId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await getDashboardUserByPublicId(publicId);
  if (!user) return { ok: false, error: "User not found." };
  const r = await internalUserDelete(publicId);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

function normalizePlanType(value: string): PlanType {
  if (value === "monthly" || value === "biannual" || value === "yearly") return value;
  return "trial";
}
