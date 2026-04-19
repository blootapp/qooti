function baseUrl(): string {
  return (process.env.BLOOT_API_URL || "").trim().replace(/\/+$/, "");
}

function internalSecret(): string {
  return (process.env.BLOOT_INTERNAL_SECRET || "").trim();
}

export function isBlootInternalApiConfigured(): boolean {
  return !!(baseUrl() && internalSecret());
}

function internalHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Internal-Secret": internalSecret(),
  };
}

async function internalJson<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const url = baseUrl();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { ...internalHeaders(), ...(init?.headers || {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

export type InternalUserRow = {
  id: string;
  publicId: string;
  email: string;
  name: string;
  surname: string;
  username: string;
  passwordHash: string;
  language: "uz" | "en";
  usernameChangedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Unix seconds; session invalidation after password change */
  passwordChangedAt: number;
};

export async function internalUserGet(params: { email?: string; publicId?: string }): Promise<InternalUserRow | null> {
  const q = new URLSearchParams();
  if (params.email) q.set("email", params.email.trim().toLowerCase());
  if (params.publicId) q.set("public_id", params.publicId.trim());
  const path = `/bloot/internal/user?${q.toString()}`;
  const { ok, status, data } = await internalJson<InternalUserRow & { error?: string }>(path);
  if (status === 404 || !ok) return null;
  const r = data as InternalUserRow & { passwordChangedAt?: number };
  return {
    ...r,
    passwordChangedAt: r.passwordChangedAt ?? 0,
  };
}

export async function internalPasswordResetPrepare(email: string): Promise<
  | { ok: true; shouldSendEmail: boolean; code?: string }
  | { ok: false; error: string; status: number }
> {
  const { ok, status, data } = await internalJson<{
    ok?: boolean;
    shouldSendEmail?: boolean;
    code?: string;
    error?: string;
  }>(`/bloot/internal/password-reset/prepare`, {
    method: "POST",
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
  if (status === 429) {
    return { ok: false, error: "Too many reset attempts. Try again later.", status: 429 };
  }
  if (!ok) {
    return { ok: false, error: String((data as { error?: string }).error || "Request failed"), status };
  }
  const d = data as { shouldSendEmail?: boolean; code?: string };
  return {
    ok: true,
    shouldSendEmail: !!d.shouldSendEmail,
    code: d.code,
  };
}

export async function internalUserLookup(identifier: string): Promise<InternalUserRow | null> {
  const q = new URLSearchParams({ identifier: identifier.trim() });
  const { ok, status, data } = await internalJson<InternalUserRow & { error?: string }>(
    `/bloot/internal/user/lookup?${q.toString()}`
  );
  if (status === 404 || !ok) return null;
  const r = data as InternalUserRow & { passwordChangedAt?: number };
  return {
    ...r,
    passwordChangedAt: r.passwordChangedAt ?? 0,
  };
}

export async function internalUserPatch(body: {
  publicId: string;
  language?: "uz" | "en";
  username?: string;
  email?: string;
  passwordHash?: string;
  name?: string;
  surname?: string;
}): Promise<{ ok: true } | { ok: false; error: string; status: number; daysRemaining?: number }> {
  const { ok, status, data } = await internalJson<{ error?: string; daysRemaining?: number }>(`/bloot/internal/user`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (ok) return { ok: true };
  const d = data as { error?: string; daysRemaining?: number };
  return {
    ok: false,
    error: String(d.error || "Update failed"),
    status,
    daysRemaining: d.daysRemaining,
  };
}

export async function internalUserDelete(publicId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const q = new URLSearchParams({ public_id: publicId.trim() });
  const { ok, data } = await internalJson<{ error?: string }>(`/bloot/internal/user?${q.toString()}`, {
    method: "DELETE",
  });
  if (ok) return { ok: true };
  return { ok: false, error: String((data as { error?: string }).error || "Delete failed") };
}

export async function internalUsernameAvailable(
  username: string,
  excludePublicId?: string
): Promise<{ available: boolean; warning?: string }> {
  const q = new URLSearchParams({ username: username.trim() });
  if (excludePublicId) q.set("exclude_public_id", excludePublicId.trim());
  const { ok, data } = await internalJson<{ available?: boolean; warning?: string }>(
    `/bloot/internal/username-available?${q.toString()}`
  );
  if (!ok) return { available: false, warning: "unavailable" };
  return {
    available: !!(data as { available?: boolean }).available,
    warning: (data as { warning?: string }).warning,
  };
}

export type InternalDashboardApp = {
  appId: string;
  appName: string;
  appDescription: string;
  status: string;
  planType: string;
  amountPaid: number;
  startsAt: number;
  expiresAt: number;
};

export async function internalUserLicenses(publicId: string): Promise<{
  apps: InternalDashboardApp[];
  payments: unknown[];
}> {
  const q = new URLSearchParams({ public_id: publicId.trim() });
  const { ok, data } = await internalJson<{ apps?: InternalDashboardApp[]; payments?: unknown[] }>(
    `/bloot/internal/user/licenses?${q.toString()}`
  );
  if (!ok) return { apps: [], payments: [] };
  return {
    apps: Array.isArray((data as { apps?: InternalDashboardApp[] }).apps) ? (data as { apps: InternalDashboardApp[] }).apps : [],
    payments: Array.isArray((data as { payments?: unknown[] }).payments)
      ? (data as { payments: unknown[] }).payments
      : [],
  };
}

export async function internalOtpSet(body: {
  email: string;
  purpose: "login" | "register" | "reset";
  code: string;
  profile?: Record<string, unknown>;
}): Promise<boolean> {
  const { ok } = await internalJson(`/bloot/internal/verification/otp/set`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return ok;
}

export async function internalOtpVerify(body: {
  email: string;
  purpose: "login" | "register" | "reset";
  code: string;
}): Promise<{ ok: boolean; profile?: Record<string, unknown> | null }> {
  const { data } = await internalJson<{ ok?: boolean; profile?: Record<string, unknown> | null }>(
    `/bloot/internal/verification/otp/verify`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
  const d = data as { ok?: boolean; profile?: Record<string, unknown> | null };
  return {
    ok: !!d.ok,
    profile: d.profile ?? null,
  };
}

export async function internalSessionTokenCreate(body: {
  kind: "register" | "reset";
  email: string;
  profile?: Record<string, unknown>;
}): Promise<{ ok: true; token: string } | { ok: false }> {
  const { ok, data } = await internalJson<{ token?: string }>(`/bloot/internal/verification/session/create`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!ok || !(data as { token?: string }).token) return { ok: false };
  return { ok: true, token: String((data as { token: string }).token) };
}

export async function internalSessionTokenRead(token: string): Promise<{
  ok: boolean;
  email?: string;
  kind?: "register" | "reset";
  profile?: Record<string, unknown> | null;
}> {
  const { ok, status, data } = await internalJson<{
    ok?: boolean;
    email?: string;
    kind?: string;
    profile?: Record<string, unknown> | null;
  }>(`/bloot/internal/verification/session/read`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  if (!ok || status === 404) return { ok: false };
  const d = data as { ok?: boolean; email?: string; kind?: string; profile?: unknown };
  return {
    ok: !!d.ok,
    email: d.email,
    kind: d.kind === "reset" ? "reset" : "register",
    profile: (d.profile as Record<string, unknown> | null) ?? null,
  };
}

export async function internalSessionTokenConsume(token: string): Promise<{
  ok: boolean;
  email?: string;
  kind?: "register" | "reset";
  profile?: Record<string, unknown> | null;
}> {
  const { ok, data } = await internalJson<{
    ok?: boolean;
    email?: string;
    kind?: string;
    profile?: Record<string, unknown> | null;
  }>(`/bloot/internal/verification/session/consume`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  if (!ok) return { ok: false };
  const d = data as { ok?: boolean; email?: string; kind?: string; profile?: unknown };
  return {
    ok: !!d.ok,
    email: d.email,
    kind: d.kind === "reset" ? "reset" : "register",
    profile: (d.profile as Record<string, unknown> | null) ?? null,
  };
}
