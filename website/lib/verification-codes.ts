import {
  internalOtpSet,
  internalOtpVerify,
  internalSessionTokenConsume,
  internalSessionTokenCreate,
  internalSessionTokenRead,
  isBlootInternalApiConfigured,
} from "./bloot-internal-api";

export interface RegisterProfile {
  name: string;
  surname: string;
  username: string;
}

type VerificationPurpose = "login" | "register" | "reset";

function purposeToApi(purpose: VerificationPurpose): "login" | "register" | "reset" {
  if (purpose === "reset") return "reset";
  if (purpose === "register") return "register";
  return "login";
}

export async function setCode(
  email: string,
  code: string,
  purpose: VerificationPurpose = "login",
  profile?: RegisterProfile
): Promise<void> {
  if (!isBlootInternalApiConfigured()) {
    throw new Error("BLOOT_API_URL and BLOOT_INTERNAL_SECRET must be set for verification.");
  }
  const emailNorm = email.toLowerCase().trim();
  const ok = await internalOtpSet({
    email: emailNorm,
    purpose: purposeToApi(purpose),
    code,
    ...(purpose === "register" && profile ? { profile: { ...profile } as Record<string, unknown> } : {}),
  });
  if (!ok) throw new Error("Could not store verification code.");
}

export async function verifyOtp(
  email: string,
  code: string,
  purpose: VerificationPurpose
): Promise<{ ok: boolean; profile?: RegisterProfile | null }> {
  if (!isBlootInternalApiConfigured()) return { ok: false };
  const codeNorm = String(code).trim().replace(/\D/g, "").slice(0, 6);
  const r = await internalOtpVerify({
    email: email.trim().toLowerCase(),
    purpose: purposeToApi(purpose),
    code: codeNorm,
  });
  if (!r.ok) return { ok: false };
  let profile: RegisterProfile | null = null;
  if (r.profile && typeof r.profile === "object") {
    const p = r.profile as Record<string, unknown>;
    profile = {
      name: String(p.name ?? ""),
      surname: String(p.surname ?? ""),
      username: String(p.username ?? ""),
    };
  }
  return { ok: true, profile };
}

export async function checkCode(
  email: string,
  code: string,
  purpose: VerificationPurpose = "login"
): Promise<boolean> {
  const { ok } = await verifyOtp(email, code, purpose);
  return ok;
}

export async function createRegistrationToken(email: string, profile: RegisterProfile): Promise<string> {
  if (!isBlootInternalApiConfigured()) {
    throw new Error("BLOOT_API_URL and BLOOT_INTERNAL_SECRET must be set.");
  }
  const r = await internalSessionTokenCreate({
    kind: "register",
    email: email.trim().toLowerCase(),
    profile: { ...profile } as Record<string, unknown>,
  });
  if (!r.ok) throw new Error("Could not create registration token");
  return r.token;
}

export async function getRegistrationToken(token: string): Promise<{
  email: string;
  profile: RegisterProfile;
  expiresAt: number;
} | null> {
  if (!isBlootInternalApiConfigured()) return null;
  const r = await internalSessionTokenRead(token);
  if (!r.ok || r.kind !== "register" || !r.email) return null;
  const prof = r.profile as RegisterProfile | undefined;
  if (!prof?.username) return null;
  return {
    email: r.email,
    profile: prof,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
}

export async function consumeRegistrationToken(token: string): Promise<void> {
  await internalSessionTokenConsume(token);
}

export async function createPasswordResetToken(email: string): Promise<string> {
  if (!isBlootInternalApiConfigured()) {
    throw new Error("BLOOT_API_URL and BLOOT_INTERNAL_SECRET must be set.");
  }
  const r = await internalSessionTokenCreate({
    kind: "reset",
    email: email.trim().toLowerCase(),
  });
  if (!r.ok) throw new Error("Could not create reset token");
  return r.token;
}

export async function getAndConsumePasswordResetToken(
  token: string
): Promise<{ email: string; expiresAt: number } | null> {
  if (!isBlootInternalApiConfigured()) return null;
  const r = await internalSessionTokenConsume(token);
  if (!r.ok || r.kind !== "reset" || !r.email) return null;
  return { email: r.email, expiresAt: Date.now() + 60_000 };
}
