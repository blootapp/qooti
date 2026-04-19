/**
 * Bloot website internal API (Next.js on Cloudflare Pages → Worker + D1).
 * All routes require X-Internal-Secret === env.INTERNAL_SECRET.
 */

import {
  assertResetEmailAllowed,
  checkGlobalApiPerMinute,
  clearOtpFail,
  getOtpFailCount,
  incrementOtpFail,
} from "./rate-limit-kv.js";

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function requireInternal(request, env) {
  const secret = request.headers.get("X-Internal-Secret");
  if (!secret || secret !== env.INTERNAL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

const OTP_PURPOSE = {
  login: "otp:login",
  register: "otp:register",
  reset: "otp:reset",
};

export async function handleBlootInternalWebsiteRoutes(request, env, pathname) {
  const unauthorized = requireInternal(request, env);
  if (unauthorized) return unauthorized;

  try {
    if (pathname === "/bloot/internal/verification/otp/set" && request.method === "POST") {
      return otpSet(request, env);
    }
    if (pathname === "/bloot/internal/verification/otp/verify" && request.method === "POST") {
      return otpVerify(request, env);
    }
    if (pathname === "/bloot/internal/verification/session/create" && request.method === "POST") {
      return sessionTokenCreate(request, env);
    }
    if (pathname === "/bloot/internal/verification/session/read" && request.method === "POST") {
      return sessionTokenRead(request, env);
    }
    if (pathname === "/bloot/internal/verification/session/consume" && request.method === "POST") {
      return sessionTokenConsume(request, env);
    }
    if (pathname === "/bloot/internal/user" && request.method === "GET") {
      return userGet(request, env);
    }
    if (pathname === "/bloot/internal/user" && request.method === "PATCH") {
      return userPatch(request, env);
    }
    if (pathname === "/bloot/internal/user" && request.method === "DELETE") {
      return userDeleteInternal(request, env);
    }
    if (pathname === "/bloot/internal/username-available" && request.method === "GET") {
      return usernameAvailable(request, env);
    }
    if (pathname === "/bloot/internal/user/licenses" && request.method === "GET") {
      return userLicenses(request, env);
    }
    if (pathname === "/bloot/internal/user/lookup" && request.method === "GET") {
      return userLookup(request, env);
    }
    if (pathname === "/bloot/internal/password-reset/prepare" && request.method === "POST") {
      return passwordResetPrepare(request, env);
    }
    if (pathname === "/bloot/internal/rate-limit/global-api" && request.method === "POST") {
      return globalApiRateLimitPost(request, env);
    }
  } catch (e) {
    console.error("[bloot-internal-website]", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
  return null;
}

async function otpSet(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const email = normEmail(body.email);
  const purpose = body.purpose === "register" ? "register" : body.purpose === "reset" ? "reset" : "login";
  const code = String(body.code || "").trim();
  if (!email || !code) return json({ error: "email and code required" }, 400);
  const category = purpose === "register" ? OTP_PURPOSE.register : purpose === "reset" ? OTP_PURPOSE.reset : OTP_PURPOSE.login;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = purpose === "reset" ? now + 30 * 60 : now + 5 * 60;
  const profileJson =
    purpose === "register" && body.profile && typeof body.profile === "object"
      ? JSON.stringify(body.profile)
      : null;

  await env.DB.prepare("DELETE FROM bloot_verification WHERE email = ? AND category = ?").bind(email, category).run();
  await clearOtpFail(env, email, category);

  const id = `otp_${email}_${category}_${now}`;
  await env.DB.prepare(
    `INSERT INTO bloot_verification (id, email, category, otp_code, profile_json, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, email, category, code, profileJson, expiresAt, now)
    .run();

  return json({ ok: true });
}

function constantTimeDigitsEqual(stored, provided) {
  const a = String(stored || "").replace(/\D/g, "").padStart(6, "0").slice(0, 6);
  const b = String(provided || "").replace(/\D/g, "").padStart(6, "0").slice(0, 6);
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i += 1) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function globalApiRateLimitPost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const ip = String(body.ip || "").trim() || "unknown";
  const g = await checkGlobalApiPerMinute(env, ip);
  if (!g.ok) {
    return json(
      { error: "Too many requests" },
      429,
      { "Retry-After": String(g.retryAfter || 60) }
    );
  }
  return json({ ok: true });
}

async function passwordResetPrepare(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const email = normEmail(body.email || "");
  if (!email || !email.includes("@")) return json({ error: "Invalid email" }, 400);

  const rl = await assertResetEmailAllowed(env, email);
  if (!rl.ok) {
    return json(
      { error: "Too many reset attempts. Try again later." },
      429,
      rl.retryAfter ? { "Retry-After": String(rl.retryAfter) } : {}
    );
  }

  const user = await env.DB.prepare("SELECT email FROM users WHERE LOWER(email) = ? LIMIT 1")
    .bind(email)
    .first();
  if (!user) {
    return json({ ok: true, shouldSendEmail: false });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 30 * 60;
  const category = OTP_PURPOSE.reset;
  await env.DB.prepare("DELETE FROM bloot_verification WHERE email = ? AND category = ?").bind(email, category).run();
  const id = `otp_${email}_${category}_${now}`;
  await env.DB.prepare(
    `INSERT INTO bloot_verification (id, email, category, otp_code, profile_json, expires_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(id, email, category, code, expiresAt, now)
    .run();

  return json({ ok: true, shouldSendEmail: true, code });
}

async function otpVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const email = normEmail(body.email);
  const purpose = body.purpose === "register" ? "register" : body.purpose === "reset" ? "reset" : "login";
  const code = String(body.code || "").trim().replace(/\D/g, "").slice(0, 6);
  const category = purpose === "register" ? OTP_PURPOSE.register : purpose === "reset" ? OTP_PURPOSE.reset : OTP_PURPOSE.login;
  if (!email || !code) return json({ ok: false }, 200);

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT id, otp_code, profile_json, expires_at FROM bloot_verification WHERE email = ? AND category = ?`
  )
    .bind(email, category)
    .first();

  if (!row || row.expires_at < now) {
    return json({ ok: false }, 200);
  }

  const priorFails = await getOtpFailCount(env, email, category);
  if (priorFails >= 5) {
    await env.DB.prepare("DELETE FROM bloot_verification WHERE id = ?").bind(row.id).run();
    return json({ ok: false }, 200);
  }

  if (!constantTimeDigitsEqual(row.otp_code, code)) {
    const n = await incrementOtpFail(env, email, category);
    if (n >= 5) {
      await env.DB.prepare("DELETE FROM bloot_verification WHERE id = ?").bind(row.id).run();
    }
    return json({ ok: false }, 200);
  }

  await clearOtpFail(env, email, category);
  await env.DB.prepare("DELETE FROM bloot_verification WHERE id = ?").bind(row.id).run();

  let profile = null;
  if (row.profile_json) {
    try {
      profile = JSON.parse(row.profile_json);
    } catch (_) {}
  }
  return json({ ok: true, profile });
}

async function sessionTokenCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const kind = body.kind === "reset" ? "reset" : "register";
  const email = normEmail(body.email);
  if (!email) return json({ error: "email required" }, 400);
  const profile = body.profile && typeof body.profile === "object" ? body.profile : null;
  const now = Math.floor(Date.now() / 1000);
  const ttlSec = kind === "reset" ? 30 * 60 : 10 * 60;
  const expiresAt = now + ttlSec;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const category = kind === "reset" ? "token:reset" : "token:register";
  const id = `tok_${token}`;
  await env.DB.prepare(
    `INSERT INTO bloot_verification (id, email, category, otp_code, profile_json, expires_at, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`
  )
    .bind(id, email, category, profile ? JSON.stringify(profile) : null, expiresAt, now)
    .run();

  return json({ token });
}

async function sessionTokenRead(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const token = String(body.token || "").trim();
  if (!token) return json({ error: "token required" }, 400);
  const id = token.startsWith("tok_") ? token : `tok_${token}`;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT email, category, profile_json, expires_at FROM bloot_verification WHERE id = ? AND category IN ('token:register', 'token:reset')`
  )
    .bind(id)
    .first();
  if (!row || row.expires_at < now) return json({ ok: false }, 404);
  let profile = null;
  if (row.profile_json) {
    try {
      profile = JSON.parse(row.profile_json);
    } catch (_) {}
  }
  return json({
    ok: true,
    email: row.email,
    kind: row.category === "token:reset" ? "reset" : "register",
    profile,
  });
}

async function sessionTokenConsume(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const token = String(body.token || "").trim();
  if (!token) return json({ error: "token required" }, 400);
  const id = token.startsWith("tok_") ? token : `tok_${token}`;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT email, category, profile_json, expires_at FROM bloot_verification WHERE id = ? AND category IN ('token:register', 'token:reset')`
  )
    .bind(id)
    .first();
  if (!row || row.expires_at < now) return json({ ok: false, error: "invalid or expired" }, 400);
  await env.DB.prepare("DELETE FROM bloot_verification WHERE id = ?").bind(id).run();
  let profile = null;
  if (row.profile_json) {
    try {
      profile = JSON.parse(row.profile_json);
    } catch (_) {}
  }
  return json({
    ok: true,
    email: row.email,
    kind: row.category === "token:reset" ? "reset" : "register",
    profile,
  });
}

async function userGet(request, env) {
  const url = new URL(request.url);
  const email = normEmail(url.searchParams.get("email") || "");
  const publicId = String(url.searchParams.get("public_id") || "").trim();
  if (!email && !publicId) return json({ error: "email or public_id required" }, 400);

  let row;
  if (email) {
    row = await env.DB.prepare(
      `SELECT id, public_id, email, name, surname, username, password_hash, language, username_changed_at, created_at, updated_at, password_changed_at
       FROM users WHERE LOWER(email) = ? LIMIT 1`
    )
      .bind(email)
      .first();
  } else {
    row = await env.DB.prepare(
      `SELECT id, public_id, email, name, surname, username, password_hash, language, username_changed_at, created_at, updated_at, password_changed_at
       FROM users WHERE public_id = ? OR id = ? LIMIT 1`
    )
      .bind(publicId, publicId)
      .first();
  }
  if (!row) return json({ error: "Not found" }, 404);
  return json({
    id: row.id,
    publicId: row.public_id,
    email: row.email,
    name: row.name,
    surname: row.surname,
    username: row.username,
    passwordHash: row.password_hash,
    language: row.language === "en" ? "en" : "uz",
    usernameChangedAt: row.username_changed_at ?? null,
    createdAt: (row.created_at || 0) * 1000,
    updatedAt: (row.updated_at || row.created_at || 0) * 1000,
    passwordChangedAt: row.password_changed_at != null ? Number(row.password_changed_at) : 0,
  });
}

async function userPatch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const publicId = String(body.publicId || "").trim();
  if (!publicId) return json({ error: "publicId required" }, 400);

  const user = await env.DB.prepare("SELECT id, public_id, username, username_changed_at FROM users WHERE public_id = ? LIMIT 1")
    .bind(publicId)
    .first();
  if (!user) return json({ error: "Not found" }, 404);

  const nowSec = Math.floor(Date.now() / 1000);
  const updates = [];
  const binds = [];

  if (body.language === "en" || body.language === "uz") {
    updates.push("language = ?");
    binds.push(body.language);
  }
  if (typeof body.username === "string" && body.username.trim()) {
    const normalized = body.username.trim();
    const unameCheck = await env.DB.prepare(
      `SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) AND public_id != ? LIMIT 1`
    )
      .bind(normalized, publicId)
      .first();
    if (unameCheck) return json({ error: "Username taken" }, 409);
    const nowMs = Date.now();
    const changedAt = user.username_changed_at != null ? Number(user.username_changed_at) : null;
    if (changedAt) {
      const diffDays = Math.floor((nowMs - changedAt) / (24 * 60 * 60 * 1000));
      if (diffDays < 14) {
        return json({ error: "username_cooldown", daysRemaining: 14 - diffDays }, 400);
      }
    }
    updates.push("username = ?");
    binds.push(normalized);
    updates.push("username_changed_at = ?");
    binds.push(nowMs);
  }
  if (typeof body.email === "string" && body.email.includes("@")) {
    const ne = normEmail(body.email);
    const emailTaken = await env.DB.prepare("SELECT 1 FROM users WHERE LOWER(email) = ? AND public_id != ? LIMIT 1")
      .bind(ne, publicId)
      .first();
    if (emailTaken) return json({ error: "Email taken" }, 409);
    updates.push("email = ?");
    binds.push(ne);
  }
  if (typeof body.passwordHash === "string" && body.passwordHash.length > 10) {
    updates.push("password_hash = ?");
    binds.push(body.passwordHash);
    updates.push("password_changed_at = ?");
    binds.push(nowSec);
  }
  if (body.name !== undefined) {
    updates.push("name = ?");
    binds.push(String(body.name).trim());
  }
  if (body.surname !== undefined) {
    updates.push("surname = ?");
    binds.push(String(body.surname).trim());
  }

  if (updates.length === 0) return json({ error: "No updates" }, 400);

  updates.push("updated_at = ?");
  binds.push(nowSec);
  binds.push(publicId);

  const sql = `UPDATE users SET ${updates.join(", ")} WHERE public_id = ?`;
  await env.DB.prepare(sql)
    .bind(...binds)
    .run();

  return json({ ok: true });
}

async function userLookup(request, env) {
  const url = new URL(request.url);
  const raw = String(url.searchParams.get("identifier") || "").trim();
  if (!raw) return json({ error: "identifier required" }, 400);
  const email = normEmail(raw);

  let row = await env.DB.prepare(
    `SELECT id, public_id, email, name, surname, username, password_hash, language, username_changed_at, created_at, updated_at, password_changed_at
     FROM users
     WHERE LOWER(email) = ? OR LOWER(public_id) = ?
     LIMIT 1`
  )
    .bind(email, raw.toLowerCase())
    .first();

  if (!row) {
    const byUser = await env.DB.prepare(
      `SELECT id, public_id, email, name, surname, username, password_hash, language, username_changed_at, created_at, updated_at, password_changed_at
       FROM users WHERE LOWER(username) = ? LIMIT 2`
    )
      .bind(raw.toLowerCase())
      .all();
    const rows = byUser?.results || [];
    if (rows.length !== 1) return json({ error: "Not found" }, 404);
    row = rows[0];
  }

  return json({
    id: row.id,
    publicId: row.public_id,
    email: row.email,
    name: row.name,
    surname: row.surname,
    username: row.username,
    passwordHash: row.password_hash,
    language: row.language === "en" ? "en" : "uz",
    usernameChangedAt: row.username_changed_at ?? null,
    createdAt: (row.created_at || 0) * 1000,
    updatedAt: (row.updated_at || row.created_at || 0) * 1000,
    passwordChangedAt: row.password_changed_at != null ? Number(row.password_changed_at) : 0,
  });
}

async function userDeleteInternal(request, env) {
  const url = new URL(request.url);
  let publicId = url.searchParams.get("public_id") || "";
  if (!publicId) {
    try {
      const body = await request.json();
      publicId = String(body.publicId || "").trim();
    } catch (_) {}
  }
  if (!publicId) return json({ error: "public_id required" }, 400);

  const user = await env.DB.prepare("SELECT id, public_id, email FROM users WHERE public_id = ? LIMIT 1")
    .bind(publicId)
    .first();
  if (!user) return json({ error: "Not found" }, 404);

  const internalId = String(user.id);
  const licenses = await env.DB.prepare("SELECT license_key FROM licenses WHERE user_id = ? OR license_key = ?")
    .bind(internalId, publicId)
    .all();
  const rows = licenses?.results || [];
  for (const l of rows) {
    const key = l.license_key;
    await env.DB.prepare("DELETE FROM license_devices WHERE license_key = ?").bind(key).run();
    await env.DB.prepare("DELETE FROM licenses WHERE license_key = ?").bind(key).run();
  }
  await env.DB.prepare("DELETE FROM trial_device_claims WHERE first_user_id = ? OR first_user_id = ?")
    .bind(internalId, publicId)
    .run();
  await env.DB.prepare("DELETE FROM bloot_verification WHERE email = ?").bind(normEmail(user.email)).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(internalId).run();

  return json({ ok: true });
}

async function usernameAvailable(request, env) {
  const url = new URL(request.url);
  const username = String(url.searchParams.get("username") || "").trim();
  const exclude = String(url.searchParams.get("exclude_public_id") || "").trim();
  if (username.length < 3) return json({ available: true, warning: "short" });
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) return json({ available: false, warning: "format" });
  let row;
  if (exclude) {
    row = await env.DB.prepare(
      `SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) AND public_id != ? LIMIT 1`
    )
      .bind(username, exclude)
      .first();
  } else {
    row = await env.DB.prepare("SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1").bind(username).first();
  }
  return json({ available: !row });
}

async function userLicenses(request, env) {
  const url = new URL(request.url);
  const publicId = String(url.searchParams.get("public_id") || "").trim();
  if (!publicId) return json({ error: "public_id required" }, 400);

  const rows = await env.DB.prepare(
    `SELECT license_key, plan_type, issued_at, expires_at, revoked_at, app_id
     FROM licenses
     WHERE license_key = ? OR user_id = (SELECT id FROM users WHERE public_id = ? LIMIT 1)
     ORDER BY issued_at ASC`
  )
    .bind(publicId, publicId)
    .all();

  const list = rows?.results || [];
  const apps = list.map((r) => {
    const now = Math.floor(Date.now() / 1000);
    const exp = Number(r.expires_at || 0);
    const iss = Number(r.issued_at || 0);
    let status = "active";
    if (r.revoked_at != null) status = "expired";
    else if (exp <= now) status = "expired";
    else if (r.plan_type === "trial") status = "trial";
    return {
      appId: r.app_id || "qooti",
      appName: "qooti",
      appDescription: "Visual inspiration vault",
      status,
      planType: r.plan_type || "trial",
      amountPaid: 0,
      startsAt: iss * 1000,
      expiresAt: exp * 1000,
    };
  });

  return json({ apps, payments: [] });
}
