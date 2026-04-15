const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes for email verification code

export interface RegisterProfile {
  name: string;
  surname: string;
  username: string;
}

export interface VerificationEntry {
  code: string;
  email: string;
  expiresAt: number;
  profile?: RegisterProfile;
}

type VerificationPurpose = "login" | "register" | "reset";

// Use global so the same store is shared across HMR and module re-runs (fixes verify 400 when store was empty)
const globalForStore = globalThis as unknown as { __verificationStore?: Map<string, VerificationEntry> };
const store = globalForStore.__verificationStore ?? new Map<string, VerificationEntry>();
if (!globalForStore.__verificationStore) globalForStore.__verificationStore = store;

function key(email: string, purpose: string) {
  return `${purpose}:${email.toLowerCase().trim()}`;
}

export function setCode(
  email: string,
  code: string,
  purpose: VerificationPurpose = "login",
  profile?: RegisterProfile
): void {
  const k = key(email, purpose);
  store.set(k, {
    code,
    email: email.toLowerCase().trim(),
    expiresAt: Date.now() + EXPIRY_MS,
    ...(purpose === "register" && profile && { profile }),
    });
}

export function getProfile(email: string, purpose: "login" | "register" = "login"): RegisterProfile | null {
  const k = key(email, purpose);
  const entry = store.get(k);
  return entry?.profile ?? null;
}

export function getCodeEntry(
  email: string,
  purpose: VerificationPurpose = "login"
): VerificationEntry | null {
  const k = key(email, purpose);
  return store.get(k) ?? null;
}

export function checkCode(
  email: string,
  code: string,
  purpose: VerificationPurpose = "login"
): boolean {
  const k = key(email, purpose);
  const entry = store.get(k);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    store.delete(k);
    return false;
  }
  const ok = entry.code === code;
  if (ok) store.delete(k);
  return ok;
}

// One-time token issued after email verification for register; allows completing signup with password
const REGISTRATION_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface RegistrationTokenData {
  email: string;
  profile: RegisterProfile;
  expiresAt: number;
}

interface PasswordResetTokenData {
  email: string;
  expiresAt: number;
}

const globalForRegTokens = globalThis as unknown as { __registrationTokens?: Map<string, RegistrationTokenData> };
const regTokenStore = globalForRegTokens.__registrationTokens ?? new Map<string, RegistrationTokenData>();
if (!globalForRegTokens.__registrationTokens) globalForRegTokens.__registrationTokens = regTokenStore;

const globalForResetTokens = globalThis as unknown as { __passwordResetTokens?: Map<string, PasswordResetTokenData> };
const resetTokenStore = globalForResetTokens.__passwordResetTokens ?? new Map<string, PasswordResetTokenData>();
if (!globalForResetTokens.__passwordResetTokens) globalForResetTokens.__passwordResetTokens = resetTokenStore;

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createRegistrationToken(email: string, profile: RegisterProfile): string {
  const token = randomToken();
  regTokenStore.set(token, {
    email: email.trim().toLowerCase(),
    profile,
    expiresAt: Date.now() + REGISTRATION_TOKEN_TTL_MS,
  });
  return token;
}

export function getRegistrationToken(token: string): RegistrationTokenData | null {
  const data = regTokenStore.get(token);
  if (!data || Date.now() > data.expiresAt) return null;
  return data;
}

export function consumeRegistrationToken(token: string): void {
  regTokenStore.delete(token);
}

export function getAndConsumeRegistrationToken(token: string): RegistrationTokenData | null {
  const data = regTokenStore.get(token);
  regTokenStore.delete(token);
  if (!data || Date.now() > data.expiresAt) return null;
  return data;
}

export function createPasswordResetToken(email: string): string {
  const token = randomToken();
  resetTokenStore.set(token, {
    email: email.trim().toLowerCase(),
    expiresAt: Date.now() + REGISTRATION_TOKEN_TTL_MS,
  });
  return token;
}

export function getAndConsumePasswordResetToken(token: string): PasswordResetTokenData | null {
  const data = resetTokenStore.get(token);
  resetTokenStore.delete(token);
  if (!data || Date.now() > data.expiresAt) return null;
  return data;
}
