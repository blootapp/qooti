export const SESSION_COOKIE = "bloot_session";
const MAX_AGE_DAYS = 30;

export type SessionPayload = {
  email: string;
  blootUserId?: string;
  publicId?: string;
  name?: string;
  surname?: string;
  username?: string;
  language?: "uz" | "en";
};

const globalForSessions = globalThis as unknown as {
  __sessionsStore?: Map<string, SessionPayload>;
};
const store = globalForSessions.__sessionsStore ?? new Map<string, SessionPayload>();
if (!globalForSessions.__sessionsStore) globalForSessions.__sessionsStore = store;

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createSession(
  email: string,
  opts?: {
    blootUserId?: string;
    publicId?: string;
    name?: string;
    surname?: string;
    username?: string;
    language?: "uz" | "en";
  }
): { token: string; cookie: string } {
  const token = randomToken();
  const emailNorm = email.trim().toLowerCase();
  store.set(token, {
    email: emailNorm,
    blootUserId: opts?.blootUserId,
    publicId: opts?.publicId,
    name: opts?.name,
    surname: opts?.surname,
    username: opts?.username,
    language: opts?.language,
  });
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
  const cookie = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  return { token, cookie };
}

export function getSessionPayload(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  return store.get(token) ?? null;
}

export function updateSessionPayload(
  token: string | undefined,
  updates: Partial<SessionPayload>
): SessionPayload | null {
  if (!token) return null;
  const current = store.get(token);
  if (!current) return null;
  const next = { ...current, ...updates };
  store.set(token, next);
  return next;
}

export function getSessionEmail(token: string | undefined): string | null {
  return getSessionPayload(token)?.email ?? null;
}

export function getSessionBlootUserId(token: string | undefined): string | null {
  return getSessionPayload(token)?.blootUserId ?? null;
}

export function deleteSession(token: string | undefined): void {
  if (token) store.delete(token);
}

export function getSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
