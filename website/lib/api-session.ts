import { NextRequest } from "next/server";
import { internalUserGet, isBlootInternalApiConfigured } from "./bloot-internal-api";
import { verifySessionToken, SESSION_COOKIE, type SessionPayload } from "./bloot-session";

/** Validates JWT and revokes sessions issued before the last password change (when Worker is configured). */
export async function validateSessionPayload(token: string | undefined): Promise<SessionPayload | null> {
  const payload = await verifySessionToken(token);
  if (!payload?.email) return null;

  if (isBlootInternalApiConfigured()) {
    const row = await internalUserGet({ email: payload.email });
    if (!row) return null;
    const serverPwd = row.passwordChangedAt ?? 0;
    const tokenPwd = payload.pwdTs ?? 0;
    if (serverPwd > tokenPwd) return null;
  }

  return payload;
}

export async function getSessionFromRequest(request: NextRequest): Promise<SessionPayload | null> {
  return validateSessionPayload(request.cookies.get(SESSION_COOKIE)?.value);
}
