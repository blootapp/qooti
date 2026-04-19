function baseUrl(): string {
  return (process.env.BLOOT_API_URL || "").trim().replace(/\/+$/, "");
}

function internalSecret(): string {
  return process.env.BLOOT_INTERNAL_SECRET || "";
}

export function isBlootWorkerConfigured(): boolean {
  return !!(baseUrl() && internalSecret());
}

export async function blootInternalRegister(
  data: {
    email: string;
    passwordHash: string;
    name: string;
    surname: string;
    username: string;
  },
  clientIp?: string
): Promise<
  | {
      ok: true;
      blootUserId: string;
      email: string;
      name: string;
      surname: string;
      username: string;
      passwordChangedAt: number;
    }
  | { ok: false; error: string; status: number }
> {
  const url = baseUrl();
  const secret = internalSecret();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Secret": secret,
  };
  if (clientIp) headers["X-Bloot-Client-Ip"] = clientIp;
  const res = await fetch(`${url}/bloot/internal/register`, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
  });
  const j = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return { ok: false, error: String(j.error || "Registration failed"), status: res.status };
  }
  return {
    ok: true,
    blootUserId: String(j.blootUserId),
    email: String(j.email),
    name: String(j.name),
    surname: String(j.surname),
    username: String(j.username),
    passwordChangedAt: Number(j.passwordChangedAt ?? 0),
  };
}

export async function blootLogin(data: {
  identifier: string;
  password: string;
}): Promise<
  | {
      ok: true;
      user: {
        blootUserId: string;
        email: string;
        name: string;
        surname: string;
        username: string;
        passwordChangedAt: number;
      };
    }
  | { ok: false; error: string; status: number }
> {
  const url = baseUrl();
  const res = await fetch(`${url}/bloot/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const j = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return { ok: false, error: String(j.error || "Login failed"), status: res.status };
  }
  const u = j.user as Record<string, unknown>;
  return {
    ok: true,
    user: {
      blootUserId: String(u.blootUserId),
      email: String(u.email),
      name: String(u.name),
      surname: String(u.surname),
      username: String(u.username),
      passwordChangedAt: Number(u.passwordChangedAt ?? 0),
    },
  };
}

export async function blootInternalResetPassword(data: {
  email: string;
  passwordHash: string;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const url = baseUrl();
  const secret = internalSecret();
  const res = await fetch(`${url}/bloot/internal/reset-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": secret,
    },
    body: JSON.stringify(data),
  });
  const j = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return { ok: false, error: String(j.error || "Password reset failed"), status: res.status };
  }
  return { ok: true };
}
