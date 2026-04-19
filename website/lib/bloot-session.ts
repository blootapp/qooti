import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "bloot_session";

const MAX_AGE_SEC = 7 * 24 * 60 * 60;

export type SessionPayload = {
  email: string;
  blootUserId?: string;
  publicId?: string;
  name?: string;
  surname?: string;
  username?: string;
  language?: "uz" | "en";
  /** Unix seconds; must match Worker `users.password_changed_at` or session is invalid */
  pwdTs?: number;
};

function secretKey(): Uint8Array {
  const s = (process.env.JWT_SECRET || "").trim();
  if (s.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters (use openssl rand -hex 32)");
  }
  return new TextEncoder().encode(s);
}

function secretKeyOptional(): Uint8Array | null {
  const s = (process.env.JWT_SECRET || "").trim();
  if (s.length < 32) return null;
  return new TextEncoder().encode(s);
}

function cookieSuffix(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${MAX_AGE_SEC}`;
}

async function signJwt(payload: SessionPayload): Promise<string> {
  const email = payload.email.trim().toLowerCase();
  return new SignJWT({
    email,
    blootUserId: payload.blootUserId,
    publicId: payload.publicId,
    name: payload.name,
    surname: payload.surname,
    username: payload.username,
    language: payload.language,
    pwd_ts: payload.pwdTs ?? 0,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(new Date(Date.now() + MAX_AGE_SEC * 1000))
    .sign(secretKey());
}

function payloadFromClaims(p: Record<string, unknown>): SessionPayload | null {
  const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
  if (!email) return null;
  const language = p.language === "en" ? "en" : p.language === "uz" ? "uz" : undefined;
  const pwdTs = typeof p.pwd_ts === "number" ? p.pwd_ts : typeof p.pwd_ts === "string" ? parseInt(p.pwd_ts, 10) : 0;
  return {
    email,
    blootUserId: typeof p.blootUserId === "string" ? p.blootUserId : undefined,
    publicId: typeof p.publicId === "string" ? p.publicId : undefined,
    name: typeof p.name === "string" ? p.name : undefined,
    surname: typeof p.surname === "string" ? p.surname : undefined,
    username: typeof p.username === "string" ? p.username : undefined,
    language,
    pwdTs: Number.isFinite(pwdTs) ? pwdTs : 0,
  };
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  const key = secretKeyOptional();
  if (!key) return null;
  try {
    const { payload } = await jwtVerify(token, key);
    return payloadFromClaims(payload as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** New JWT string if the current token is valid (sliding 7-day expiry). */
export async function rotateSessionJwtIfValid(token: string | undefined): Promise<string | null> {
  const p = await verifySessionToken(token);
  if (!p?.email) return null;
  return signJwt(p);
}

export async function createSession(
  email: string,
  opts?: {
    blootUserId?: string;
    publicId?: string;
    name?: string;
    surname?: string;
    username?: string;
    language?: "uz" | "en";
    pwdTs?: number;
  }
): Promise<{ cookie: string }> {
  const emailNorm = email.trim().toLowerCase();
  const jwt = await signJwt({
    email: emailNorm,
    blootUserId: opts?.blootUserId,
    publicId: opts?.publicId ?? opts?.blootUserId,
    name: opts?.name,
    surname: opts?.surname,
    username: opts?.username,
    language: opts?.language,
    pwdTs: opts?.pwdTs ?? 0,
  });
  const cookie = `${SESSION_COOKIE}=${jwt}; ${cookieSuffix()}`;
  return { cookie };
}

export async function updateSessionPayload(
  token: string | undefined,
  updates: Partial<SessionPayload>
): Promise<string | null> {
  const current = await verifySessionToken(token);
  if (!current?.email) return null;
  const next: SessionPayload = { ...current, ...updates };
  const jwt = await signJwt(next);
  return `${SESSION_COOKIE}=${jwt}; ${cookieSuffix()}`;
}

export function getSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; ${cookieSuffix()}; Max-Age=0`;
}

export async function getSessionPayload(token: string | undefined): Promise<SessionPayload | null> {
  return verifySessionToken(token);
}

export async function getSessionEmail(token: string | undefined): Promise<string | null> {
  const p = await verifySessionToken(token);
  return p?.email ?? null;
}

export async function getSessionBlootUserId(token: string | undefined): Promise<string | null> {
  const p = await verifySessionToken(token);
  return p?.blootUserId ?? null;
}
