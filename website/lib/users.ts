import {
  internalUserGet,
  internalUserLookup,
  internalUsernameAvailable,
  isBlootInternalApiConfigured,
} from "./bloot-internal-api";

export interface User {
  id: string;
  publicId: string;
  email: string;
  name: string;
  surname: string;
  username: string;
  language: "uz" | "en";
  usernameChangedAt: number | null;
  createdAt: number;
  updatedAt: number;
  passwordChangedAt: number;
}

function mapUser(row: {
  id: string;
  publicId: string;
  email: string;
  name: string;
  surname: string;
  username: string;
  language?: "uz" | "en";
  usernameChangedAt: number | null;
  createdAt: number;
  updatedAt: number;
  passwordChangedAt?: number;
}): User {
  return {
    id: row.id,
    publicId: row.publicId,
    email: row.email,
    name: row.name,
    surname: row.surname,
    username: row.username,
    language: row.language === "en" ? "en" : "uz",
    usernameChangedAt: row.usernameChangedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    passwordChangedAt: row.passwordChangedAt ?? 0,
  };
}

export async function getUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
  if (!isBlootInternalApiConfigured()) return null;
  const row = await internalUserGet({ email: email.trim().toLowerCase() });
  if (!row) return null;
  return { ...mapUser(row), passwordHash: row.passwordHash };
}

export async function getUserByUsernameOrEmail(identifier: string): Promise<(User & { passwordHash: string }) | null> {
  if (!isBlootInternalApiConfigured()) return null;
  const row = await internalUserLookup(identifier);
  if (!row) return null;
  return { ...mapUser(row), passwordHash: row.passwordHash };
}

export async function getUserByPublicId(publicId: string): Promise<User | null> {
  if (!isBlootInternalApiConfigured()) return null;
  const row = await internalUserGet({ publicId: publicId.trim() });
  if (!row) return null;
  return mapUser(row);
}

export async function isEmailAvailable(email: string): Promise<boolean> {
  if (!isBlootInternalApiConfigured()) return false;
  const existing = await internalUserGet({ email: email.trim().toLowerCase() });
  return !existing;
}

export async function isUsernameAvailable(username: string, excludePublicId?: string): Promise<boolean> {
  if (!isBlootInternalApiConfigured()) return false;
  const r = await internalUsernameAvailable(username, excludePublicId);
  return r.available;
}
