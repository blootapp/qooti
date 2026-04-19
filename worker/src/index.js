/**
 * Qooti License Worker
 * App: POST /license/validate, GET /license/status
 * Bloot: POST /bloot/internal/register, POST /bloot/login (website)
 * Admin: GET/POST/PATCH /admin/licenses, /admin/licenses/:key, /admin/logs, /admin/notifications, DELETE /admin/notifications/:id
 * App: GET /app/notifications
 * Status derived at read time: valid = revoked_at IS NULL AND expires_at > now
 */

import bcrypt from "bcryptjs";
import { handleBlootInternalWebsiteRoutes } from "./bloot-internal-website.js";
import {
  checkLoginAllowed,
  checkLoginIpAttemptBudget,
  recordLoginFailure,
  recordLoginSuccess,
  checkRegistrationIp,
  recordRegistrationSuccess,
} from "./rate-limit-kv.js";

/** Constant bcrypt hash for timing normalization when user is unknown (compare always runs bcrypt). */
const DUMMY_PASSWORD_HASH =
  "$2a$10$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31";

const LOGIN_ERROR_GENERIC = "Incorrect email or password";

const LIFETIME_EXPIRY = 253402300799; // far future
const LAST_SEEN_UPDATE_INTERVAL = 86400; // 24 hours
const LICENSE_RATE_LIMIT_MAX = 120;
const LICENSE_RATE_LIMIT_WINDOW_MS = 60_000;
const LICENSE_RATE_BUCKETS = new Map();

const CORS = {
  "Access-Control-Allow-Origin": "https://bloot.app",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret, X-Internal-Secret",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
  });
}

function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS });
}

function deriveStatus(row) {
  const now = Math.floor(Date.now() / 1000);
  if (row.revoked_at != null) return "revoked";
  if (row.expires_at <= now) return "expired";
  return "valid";
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateLicenseKey() {
  const segment = () => randomChars("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 4);
  return `QOOTI-${segment()}-${segment()}-${segment()}`;
}

function generateBlootPublicId() {
  const segment = () => randomChars("abcdefghijklmnopqrstuvwxyz0123456789", 4);
  return `BLT-${segment()}-${segment()}-${segment()}`;
}

function randomChars(alphabet, len) {
  const chars = String(alphabet || "");
  if (!chars || len <= 0) return "";
  const out = [];
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i += 1) {
    out.push(chars[bytes[i] % chars.length]);
  }
  return out.join("");
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

function enforceRateLimit(request, keyPrefix, max, windowMs) {
  const now = Date.now();
  const key = `${keyPrefix}:${clientIp(request)}`;
  const bucket = LICENSE_RATE_BUCKETS.get(key);
  if (!bucket || now >= bucket.resetAt) {
    LICENSE_RATE_BUCKETS.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

async function signLicensePayload(env, payload, mode) {
  const secret = String(env.LICENSE_RESPONSE_SIGNING_SECRET || "").trim();
  if (!secret) {
    return payload;
  }
  const status = String(payload.status || (payload.valid ? "valid" : "invalid"));
  const line = [
    `status=${status}`,
    `valid=${payload.valid ? 1 : 0}`,
    `plan_type=${payload.plan_type || ""}`,
    `expires_at=${payload.expires_at ?? ""}`,
    `error=${payload.error || ""}`,
    `mode=${mode || "status"}`,
  ].join("|");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(line)
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { ...payload, signature: hex };
}

async function logAction(env, action, licenseKey, details) {
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      "INSERT INTO admin_logs (action, license_key, details, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(action, licenseKey || null, details || null, now)
      .run();
  } catch (_) {}
}

function normalizeOptionalText(value, maxLen = 200) {
  const s = String(value || "").trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function normalizeRequiredText(value, maxLen = 4000) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.slice(0, maxLen);
}

function normalizeOptionalHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, value: null };
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, error: "Only http/https URLs are supported" };
    }
    return { ok: true, value: raw };
  } catch (_) {
    return { ok: false, error: "Invalid URL format" };
  }
}

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
    }
    if (host === "youtu.be") {
      return u.pathname.replace(/^\/+/, "").split("/")[0] || null;
    }
  } catch (_) {}
  return null;
}

function normalizeOptionalYouTubeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, value: null };
  const videoId = extractYouTubeVideoId(raw);
  if (!videoId) return { ok: false, error: "Invalid YouTube URL" };
  return { ok: true, value: `https://www.youtube.com/watch?v=${videoId}` };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return corsPreflight();

    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/license/validate" || path === "/license/status") {
      const allowed = enforceRateLimit(
        request,
        path,
        LICENSE_RATE_LIMIT_MAX,
        LICENSE_RATE_LIMIT_WINDOW_MS
      );
      if (!allowed) {
        return json({ valid: false, error: "Too many requests" }, 429);
      }
    }

    if (path.startsWith("/admin/")) {
      const secret = request.headers.get("X-Admin-Secret");
      if (secret !== env.ADMIN_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      // Admin routes
      if (path === "/admin/licenses" && request.method === "GET") {
        return listLicenses(url.searchParams, env);
      }
      if (path === "/admin/licenses" && request.method === "POST") {
        return createLicense(request, env);
      }
      const matchDetail = path.match(/^\/admin\/licenses\/([^/]+)\/?$/);
      if (matchDetail) {
        const key = decodeURIComponent(matchDetail[1]);
        if (request.method === "GET") return getLicenseDetails(key, env);
        if (request.method === "PATCH") return editLicense(key, request, env);
        if (request.method === "DELETE") return deleteLicense(key, env);
      }
      const matchRevoke = path.match(/^\/admin\/licenses\/([^/]+)\/revoke$/);
      if (matchRevoke && request.method === "POST") {
        return revokeLicense(decodeURIComponent(matchRevoke[1]), env);
      }
      const matchReset = path.match(/^\/admin\/licenses\/([^/]+)\/devices\/reset$/);
      if (matchReset && request.method === "POST") {
        return resetDevices(decodeURIComponent(matchReset[1]), env);
      }
      const matchRevokeDevice = path.match(
        /^\/admin\/licenses\/([^/]+)\/devices\/revoke$/
      );
      if (matchRevokeDevice && request.method === "POST") {
        return revokeDevice(
          decodeURIComponent(matchRevokeDevice[1]),
          request,
          env
        );
      }
      if (path === "/admin/logs" && request.method === "GET") {
        return listLogs(url.searchParams, env);
      }
      const matchNotifDelete = path.match(/^\/admin\/notifications\/([^/]+)\/?$/);
      if (matchNotifDelete && request.method === "DELETE") {
        return deleteNotification(decodeURIComponent(matchNotifDelete[1]), env);
      }
      if (path === "/admin/notifications" && request.method === "POST") {
        return createNotification(request, env);
      }
      if (path === "/admin/notifications" && request.method === "GET") {
        return listNotifications(url.searchParams, env);
      }
      if (path === "/admin/users" && request.method === "GET") {
        return listUsers(url.searchParams, env);
      }
      const matchUser = path.match(/^\/admin\/users\/([^/]+)\/?$/);
      if (matchUser && request.method === "DELETE") {
        return deleteUserAccount(decodeURIComponent(matchUser[1]), env);
      }
      return json({ error: "Not found" }, 404);
    }

    if (path.startsWith("/bloot/internal/")) {
      const websiteInternal = await handleBlootInternalWebsiteRoutes(request, env, path);
      if (websiteInternal) return websiteInternal;
    }

    if (path === "/bloot/internal/register" && request.method === "POST") {
      return internalRegister(request, env);
    }
    if (path === "/bloot/internal/reset-password" && request.method === "POST") {
      return internalResetPassword(request, env);
    }
    if (path === "/bloot/login" && request.method === "POST") {
      return blootLogin(request, env);
    }

    if (path === "/license/validate" && request.method === "POST") {
      return validateLicense(request, env);
    }
    if (path === "/license/status" && request.method === "GET") {
      const licenseKey = url.searchParams.get("license_key");
      const deviceFingerprint = url.searchParams.get("device_fingerprint");
      return getLicenseStatusForApp(licenseKey, deviceFingerprint, env);
    }
    if (path === "/app/notifications" && request.method === "GET") {
      return listNotifications(url.searchParams, env, { allowInactive: false });
    }

    return json({ error: "Not found" }, 404);
  },
};

async function recordTrialDeviceClaim(env, licenseKey, deviceFingerprint, planType, now) {
  if (planType !== "trial") return;
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO trial_device_claims (device_fingerprint, app_id, first_user_id, created_at) VALUES (?, 'qooti', ?, ?)`
    )
      .bind(deviceFingerprint, licenseKey, now)
      .run();
  } catch (_) {}
}

/**
 * Accept only Bloot user IDs for app activation:
 * - users.public_id (BLT-xxxx-xxxx-xxxx)
 * - legacy users.id (UUID)
 * Username/email must NOT activate desktop app licenses.
 */
async function resolveLicenseLookupKey(env, inputKey) {
  const raw = String(inputKey || "").trim();
  if (!raw) return "";
  try {
    const exact = await env.DB.prepare("SELECT license_key FROM licenses WHERE license_key = ?")
      .bind(raw)
      .first();
    if (exact?.license_key) return String(exact.license_key);
  } catch (_) {}
  try {
    const matches = await env.DB.prepare(
      `SELECT id, public_id FROM users
       WHERE LOWER(public_id) = LOWER(?) OR id = ?
       LIMIT 2`
    )
      .bind(raw, raw)
      .all();
    const rows = matches?.results || [];
    if (rows.length === 1) {
      const userId = rows[0]?.id != null ? String(rows[0].id).trim() : "";
      const publicId = rows[0]?.public_id != null ? String(rows[0].public_id).trim() : "";
      if (userId) {
        try {
          const lic = await env.DB.prepare(
            `SELECT license_key
             FROM licenses
             WHERE user_id = ?
             ORDER BY (revoked_at IS NULL) DESC, expires_at DESC
             LIMIT 1`
          )
            .bind(userId)
            .first();
          if (lic?.license_key) return String(lic.license_key);
        } catch (_) {}
      }
      if (publicId) return publicId;
      if (userId) return userId;
    }
  } catch (_) {}
  return raw;
}

async function ensureLicenseForBlootIdActivation(env, inputKey) {
  const raw = String(inputKey || "").trim();
  if (!raw) return null;
  let user = null;
  try {
    user = await env.DB.prepare(
      `SELECT id, public_id, email
       FROM users
       WHERE LOWER(public_id) = LOWER(?) OR id = ?
       LIMIT 1`
    )
      .bind(raw, raw)
      .first();
  } catch (_) {}
  if (!user?.id) return null;
  try {
    const existing = await env.DB.prepare(
      "SELECT license_key FROM licenses WHERE user_id = ? LIMIT 1"
    )
      .bind(user.id)
      .first();
    if (existing?.license_key) return String(existing.license_key);
  } catch (_) {}
  const now = Math.floor(Date.now() / 1000);
  const key = String(user.public_id || user.id || "").trim();
  if (!key) return null;
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO licenses
       (license_key, user_id, email, app_id, plan_type, issued_at, expires_at, device_limit, active_devices)
       VALUES (?, ?, ?, 'qooti', 'trial', ?, ?, 1, '[]')`
    )
      .bind(key, user.id, user.email || null, now, now + 7 * 86400)
      .run();
    const ensured = await env.DB.prepare(
      "SELECT license_key FROM licenses WHERE user_id = ? ORDER BY issued_at DESC LIMIT 1"
    )
      .bind(user.id)
      .first();
    return ensured?.license_key ? String(ensured.license_key) : null;
  } catch (_) {
    return null;
  }
}

/** Resolve Bloot username for license activation/status responses. */
async function blootUsernameForLicense(env, licenseKey, inputKey = "") {
  try {
    const lic = await env.DB.prepare(
      "SELECT user_id, license_key FROM licenses WHERE license_key = ?"
    )
      .bind(licenseKey)
      .first();
    if (lic) {
      const u = await env.DB.prepare(
        "SELECT username FROM users WHERE id = ? OR public_id = ? LIMIT 1"
      )
        .bind(lic.user_id, lic.license_key)
        .first();
      const name = u?.username != null ? String(u.username).trim() : "";
      if (name) return name;
    }
    const fallbackKeys = [String(inputKey || "").trim(), String(licenseKey || "").trim()]
      .filter(Boolean);
    for (const key of fallbackKeys) {
      const u = await env.DB.prepare(
        "SELECT username FROM users WHERE LOWER(public_id) = LOWER(?) OR id = ? LIMIT 1"
      )
        .bind(key, key)
        .first();
      const name = u?.username != null ? String(u.username).trim() : "";
      if (name) return name;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function licenseValidateSuccessPayload(row, blootUsername) {
  const o = {
    valid: true,
    status: "valid",
    plan_type: row.plan_type || "lifetime",
    expires_at: row.expires_at,
  };
  if (blootUsername) o.username = blootUsername;
  return o;
}

async function validateLicense(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const licenseKeyInput = (body.license_key || "").trim();
  const deviceFingerprint = (body.device_fingerprint || "").trim();
  if (!licenseKeyInput || !deviceFingerprint) {
    return json({ error: "license_key and device_fingerprint required" }, 400);
  }
  let licenseKey = await resolveLicenseLookupKey(env, licenseKeyInput);

  let row = await env.DB.prepare(
    "SELECT license_key, plan_type, expires_at, device_limit, revoked_at FROM licenses WHERE license_key = ?"
  )
    .bind(licenseKey)
    .first();

  if (!row) {
    const repairedKey = await ensureLicenseForBlootIdActivation(env, licenseKeyInput);
    if (repairedKey) {
      licenseKey = repairedKey;
      row = await env.DB.prepare(
        "SELECT license_key, plan_type, expires_at, device_limit, revoked_at FROM licenses WHERE license_key = ?"
      )
        .bind(licenseKey)
        .first();
    }
  }

  if (!row) {
    return json({ valid: false, error: "Invalid license key" }, 200);
  }

  if (row.revoked_at != null) {
    return json({ valid: false, error: "License revoked" }, 200);
  }

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    return json({ valid: false, error: "License expired" }, 200);
  }

  const blootUsername = await blootUsernameForLicense(env, licenseKey, licenseKeyInput);

  let existingDevice = null;
  try {
    const deviceRow = await env.DB.prepare(
      "SELECT device_fingerprint, last_seen FROM license_devices WHERE license_key = ? AND device_fingerprint = ?"
    )
      .bind(licenseKey, deviceFingerprint)
      .first();
    existingDevice = deviceRow;
  } catch (_) {}

  if (existingDevice) {
    const lastSeen = existingDevice.last_seen || 0;
    if (now - lastSeen >= LAST_SEEN_UPDATE_INTERVAL) {
      try {
        await env.DB.prepare(
          "UPDATE license_devices SET last_seen = ? WHERE license_key = ? AND device_fingerprint = ?"
        )
          .bind(now, licenseKey, deviceFingerprint)
          .run();
      } catch (_) {}
    }
    const payload = await signLicensePayload(
      env,
      licenseValidateSuccessPayload(row, blootUsername),
      "activate"
    );
    return json(payload);
  }

  if (row.plan_type === "trial") {
    const claim = await env.DB.prepare(
      "SELECT first_user_id FROM trial_device_claims WHERE device_fingerprint = ? AND app_id = ?"
    )
      .bind(deviceFingerprint, "qooti")
      .first();
    if (claim && claim.first_user_id !== licenseKey) {
      return json(
        {
          valid: false,
          error:
            "Trial already used on this device. Use your Bloot account or purchase an extension.",
        },
        200
      );
    }
  }

  let countRow;
  try {
    countRow = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM license_devices WHERE license_key = ?"
    )
      .bind(licenseKey)
      .first();
  } catch (_) {
    countRow = { c: 0 };
  }
  const limit = row.device_limit || 1;
  let count = countRow?.c ?? 0;

  // `license_devices` is canonical. If it has no rows, legacy `licenses.active_devices` JSON
  // must not enforce limits — it often stays stale after admin "reset devices" (rows deleted,
  // JSON not cleared), which incorrectly returned "Device limit reached".
  if (count === 0) {
    try {
      await env.DB.prepare(
        "UPDATE licenses SET active_devices = '[]' WHERE license_key = ?"
      )
        .bind(licenseKey)
        .run();
    } catch (_) {}
  }

  // Single-seat licenses: the slot may hold a *different* fingerprint (reinstall, cleared prefs,
  // new local device_id). Replace that row instead of hard-failing "Device limit reached".
  if (limit === 1 && count >= 1) {
    try {
      await env.DB.prepare(
        "DELETE FROM license_devices WHERE license_key = ?"
      )
        .bind(licenseKey)
        .run();
      await env.DB.prepare(
        "UPDATE licenses SET active_devices = '[]' WHERE license_key = ?"
      )
        .bind(licenseKey)
        .run();
      count = 0;
    } catch (_) {}
  }

  if (count >= limit) {
    return json({ valid: false, error: "Device limit reached" }, 200);
  }

  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO license_devices (license_key, device_fingerprint, first_seen, last_seen) VALUES (?, ?, ?, ?)"
    )
      .bind(licenseKey, deviceFingerprint, now, now)
      .run();
  } catch (e) {
    return json({ valid: false, error: "Database error" }, 500);
  }

  await recordTrialDeviceClaim(env, licenseKey, deviceFingerprint, row.plan_type, now);

  const payload = await signLicensePayload(
    env,
    licenseValidateSuccessPayload(row, blootUsername),
    "activate"
  );
  return json(payload);
}

async function getLicenseStatusForApp(licenseKey, deviceFingerprint, env) {
  if (!licenseKey) return json({ valid: false }, 400);
  const device = String(deviceFingerprint || "").trim();
  if (!device) {
    return json({ valid: false, error: "device_fingerprint required" }, 400);
  }
  const resolvedLicenseKey = await resolveLicenseLookupKey(env, licenseKey);

  const row = await env.DB.prepare(
    "SELECT license_key, plan_type, expires_at, revoked_at FROM licenses WHERE license_key = ?"
  )
    .bind(resolvedLicenseKey)
    .first();

  if (!row) return json({ valid: false });

  const now = Math.floor(Date.now() / 1000);
  if (row.revoked_at != null) {
    return json({
      valid: false,
      status: "revoked",
      error: "License revoked",
      plan_type: row.plan_type || "lifetime",
      expires_at: row.expires_at,
    });
  }
  if (row.expires_at <= now) {
    return json({
      valid: false,
      status: "expired",
      error: "License expired",
      plan_type: row.plan_type || "lifetime",
      expires_at: row.expires_at,
    });
  }

  // Status must match validate: only registered devices stay valid (admin device reset revokes this device).
  let deviceRow = null;
  try {
    deviceRow = await env.DB.prepare(
      "SELECT device_fingerprint, last_seen FROM license_devices WHERE license_key = ? AND device_fingerprint = ?"
    )
      .bind(resolvedLicenseKey, device)
      .first();
  } catch (_) {}

  const blootUsername = await blootUsernameForLicense(env, resolvedLicenseKey, licenseKey);

  if (!deviceRow) {
    const payload = {
      valid: false,
      status: "invalid",
      error: "This device is not activated for this license.",
      plan_type: row.plan_type || "lifetime",
      expires_at: row.expires_at,
    };
    if (blootUsername) payload.username = blootUsername;
    return json(payload);
  }

  const lastSeen = deviceRow.last_seen || 0;
  if (now - lastSeen >= LAST_SEEN_UPDATE_INTERVAL) {
    try {
      await env.DB.prepare(
        "UPDATE license_devices SET last_seen = ? WHERE license_key = ? AND device_fingerprint = ?"
      )
        .bind(now, resolvedLicenseKey, device)
        .run();
    } catch (_) {}
  }

  const payload = {
    valid: true,
    status: "valid",
    plan_type: row.plan_type || "lifetime",
    expires_at: row.expires_at,
  };
  if (blootUsername) payload.username = blootUsername;
  const signed = await signLicensePayload(
    env,
    payload,
    "status"
  );
  return json(signed);
}

async function listLicenses(params, env) {
  const page = Math.max(1, parseInt(params.get("page"), 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(params.get("limit"), 10) || 20));
  const offset = (page - 1) * limit;
  const licenseKey = (params.get("license_key") || "").trim();
  const email = normEmail(params.get("email") || "");
  const status = params.get("status");
  const planType = params.get("plan_type");
  const expirationWindow = params.get("expiration_window"); // expiring_7 | expiring_30 | expired
  const deviceLimitState = params.get("device_limit_state"); // at_limit | over_limit

  const now = Math.floor(Date.now() / 1000);

  let where = [];
  let args = [];

  // License key: exact match (Bloot ID or legacy QOOTI- key)
  if (licenseKey) {
    where.push("l.license_key = ?");
    args.push(licenseKey);
  } else {
    if (status === "valid") {
      where.push("l.revoked_at IS NULL");
      where.push("l.expires_at > ?");
      args.push(now);
    } else if (status === "expired") {
      where.push("l.revoked_at IS NULL");
      where.push("l.expires_at <= ?");
      args.push(now);
    } else if (status === "revoked") {
      where.push("l.revoked_at IS NOT NULL");
    }
    if (planType === "lifetime" || planType === "yearly" || planType === "trial") {
      where.push("l.plan_type = ?");
      args.push(planType);
    }
    if (expirationWindow === "expiring_7") {
      where.push("l.revoked_at IS NULL");
      where.push("l.expires_at > ?");
      args.push(now);
      where.push("l.expires_at <= ?");
      args.push(now + 7 * 86400);
    } else if (expirationWindow === "expiring_30") {
      where.push("l.revoked_at IS NULL");
      where.push("l.expires_at > ?");
      args.push(now);
      where.push("l.expires_at <= ?");
      args.push(now + 30 * 86400);
    } else if (expirationWindow === "expired") {
      where.push("l.revoked_at IS NULL");
      where.push("l.expires_at <= ?");
      args.push(now);
    }
    if (deviceLimitState === "at_limit") {
      where.push(
        "(SELECT COUNT(*) FROM license_devices d WHERE d.license_key = l.license_key) >= l.device_limit"
      );
    } else if (deviceLimitState === "over_limit") {
      where.push(
        "(SELECT COUNT(*) FROM license_devices d WHERE d.license_key = l.license_key) > l.device_limit"
      );
    }
  }

  if (email) {
    where.push("LOWER(l.email) = ?");
    args.push(email);
  }

  const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

  const baseSql = `
    SELECT l.license_key, l.email, l.plan_type, l.issued_at, l.expires_at, l.device_limit, l.revoked_at,
           (SELECT COUNT(*) FROM license_devices d WHERE d.license_key = l.license_key) as device_count
    FROM licenses l
    ${whereClause}
    ORDER BY l.issued_at DESC
  `;

  const list = await env.DB.prepare(baseSql + " LIMIT ? OFFSET ?")
    .bind(...args, limit, offset)
    .all();

  const totalRow = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM licenses l " + whereClause
  )
    .bind(...args)
    .first();

  const total = totalRow?.c ?? 0;

  const rows = (list.results || []).map((r) => {
    const s = deriveStatus(r);
    return {
      license_key: r.license_key,
      license_key_masked: maskKey(r.license_key),
      email: r.email || null,
      plan_type: r.plan_type,
      issued_at: r.issued_at,
      expires_at: r.expires_at,
      device_limit: r.device_limit ?? 1,
      device_count: r.device_count ?? 0,
      status: s,
    };
  });

  return json({
    licenses: rows,
    total,
    page,
    limit,
    too_many: total > limit,
  });
}

/** Bloot website accounts (D1 `users` table). No password fields. */
async function listUsers(params, env) {
  const page = Math.max(1, parseInt(params.get("page"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(params.get("limit"), 10) || 30));
  const offset = (page - 1) * limit;
  const idQ = (params.get("id") || "").trim();
  const emailQ = (params.get("email") || "").trim().toLowerCase();

  let whereClause = "";
  const args = [];
  if (idQ) {
    whereClause = "WHERE (u.id = ? OR u.public_id = ?)";
    args.push(idQ, idQ);
  } else if (emailQ) {
    whereClause = "WHERE LOWER(u.email) LIKE ?";
    args.push(`%${emailQ}%`);
  }

  const list = await env.DB.prepare(
    `SELECT
      u.id, u.public_id, u.email, u.name, u.surname, u.username, u.created_at,
      l.license_key, l.plan_type, l.expires_at, l.revoked_at
    FROM users u
    LEFT JOIN licenses l ON l.user_id = u.id AND l.app_id = 'qooti'
    ${whereClause}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?`
  )
    .bind(...args, limit, offset)
    .all();

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM users u ${whereClause}`
  )
    .bind(...args)
    .first();

  const total = totalRow?.c ?? 0;

  return json({
    users: (list.results || []).map((r) => ({
      id: r.id,
      public_id: r.public_id || null,
      email: r.email,
      name: r.name,
      surname: r.surname,
      username: r.username,
      created_at: r.created_at,
      license_key: r.license_key || null,
      license_plan: r.plan_type || null,
      license_status: r.license_key
        ? deriveStatus({ revoked_at: r.revoked_at, expires_at: r.expires_at })
        : "none",
      license_expires_at: r.expires_at || null,
    })),
    total,
    page,
    limit,
  });
}

async function deleteUserAccount(userId, env) {
  const uid = String(userId || "").trim();
  if (!uid) return json({ error: "User id required" }, 400);
  const user = await env.DB.prepare("SELECT id, public_id, email FROM users WHERE id = ? OR public_id = ?")
    .bind(uid, uid)
    .first();
  if (!user) return json({ error: "User not found" }, 404);
  const internalId = String(user.id);
  const publicId = String(user.public_id || "");

  const licRows = await env.DB.prepare(
    "SELECT license_key, revoked_at FROM licenses WHERE user_id = ? OR license_key = ? OR license_key = ? OR LOWER(email) = LOWER(?)"
  )
    .bind(internalId, internalId, publicId, user.email || "")
    .all();
  const licenses = licRows?.results || [];
  const active = licenses.filter((l) => l.revoked_at == null);
  if (active.length > 0) {
    return json({ error: "Revoke all licenses for this account before deleting it." }, 400);
  }

  for (const l of licenses) {
    await env.DB.prepare("DELETE FROM license_devices WHERE license_key = ?")
      .bind(l.license_key)
      .run();
    await env.DB.prepare("DELETE FROM licenses WHERE license_key = ?")
      .bind(l.license_key)
      .run();
  }
  await env.DB.prepare("DELETE FROM trial_device_claims WHERE first_user_id = ? OR first_user_id = ?")
    .bind(internalId, publicId)
    .run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?")
    .bind(internalId)
    .run();

  await logAction(
    env,
    "bloot_user_deleted",
    publicId || internalId,
    JSON.stringify({ email: user.email || null, deleted_licenses: licenses.length })
  );
  return json({ ok: true, deleted_licenses: licenses.length });
}

function maskKey(key) {
  if (!key || key.length < 8) return "****";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return key.slice(0, 4) + "…" + key.slice(-4);
  }
  const parts = key.split("-");
  if (parts.length >= 4) {
    return `${parts[0]}-XXXX-XXXX-${parts[3].slice(-4)}`;
  }
  return key.slice(0, 4) + "-XXXX-XXXX-" + key.slice(-4);
}

async function createLicense(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const planType = body.planType === "yearly" ? "yearly" : "lifetime";
  // Qooti licenses are single-device only.
  const deviceLimit = 1;
  const durationYears = Math.max(1, parseInt(body.durationYears, 10) || 1);

  const issuedAt = Math.floor(Date.now() / 1000);
  let expiresAt =
    planType === "lifetime"
      ? LIFETIME_EXPIRY
      : issuedAt + durationYears * 31536000;

  let licenseKey = generateLicenseKey();
  let attempts = 0;
  while (attempts < 10) {
    try {
      await env.DB.prepare(
        `INSERT INTO licenses (license_key, user_id, email, app_id, plan_type, issued_at, expires_at, device_limit, active_devices)
         VALUES (?, ?, ?, 'qooti', ?, ?, ?, ?, ?)`
      )
        .bind(
          licenseKey,
          body.userId || "admin",
          normalizeOptionalText(body.email) || null,
          planType,
          issuedAt,
          expiresAt,
          deviceLimit,
          "[]"
        )
        .run();
      await logAction(env, "license_created", licenseKey, JSON.stringify({ planType, deviceLimit }));
      return json({ ok: true, license_key: licenseKey });
    } catch (e) {
      if (e.message && e.message.includes("UNIQUE")) {
        licenseKey = generateLicenseKey();
        attempts++;
        continue;
      }
      return json({ error: e.message || "Database error" }, 500);
    }
  }
  return json({ error: "Could not generate unique key" }, 500);
}

async function getLicenseDetails(licenseKey, env) {
  if (!licenseKey) return json({ error: "License key required" }, 400);

  const row = await env.DB.prepare(
    "SELECT license_key, user_id, email, plan_type, issued_at, expires_at, device_limit, revoked_at FROM licenses WHERE license_key = ?"
  )
    .bind(licenseKey)
    .first();

  if (!row) return json({ error: "License not found" }, 404);

  const devices = await env.DB.prepare(
    "SELECT device_fingerprint, first_seen, last_seen FROM license_devices WHERE license_key = ? ORDER BY first_seen DESC"
  )
    .bind(licenseKey)
    .all();

  const status = deriveStatus(row);
  const deviceList = (devices.results || []).map((d) => ({
    device_hash: hashForDisplay(d.device_fingerprint),
    device_fingerprint: d.device_fingerprint,
    first_seen: d.first_seen,
    last_seen: d.last_seen,
  }));

  return json({
    license_key: row.license_key,
    user_id: row.user_id,
    email: row.email || null,
    plan_type: row.plan_type,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    device_limit: row.device_limit,
    revoked_at: row.revoked_at,
    status,
    devices: deviceList,
  });
}

function hashForDisplay(fp) {
  if (!fp) return "—";
  if (fp.length <= 8) return fp;
  return fp.slice(0, 4) + "…" + fp.slice(-4);
}

async function editLicense(licenseKey, request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT license_key, plan_type, issued_at, expires_at, device_limit FROM licenses WHERE license_key = ?"
  )
    .bind(licenseKey)
    .first();

  if (!row) return json({ error: "License not found" }, 404);

  let planType = row.plan_type;
  let expiresAt = row.expires_at;
  let deviceLimit = 1;

  if (body.planType === "lifetime" || body.planType === "yearly" || body.planType === "trial") {
    planType = body.planType;
    if (planType === "lifetime") {
      expiresAt = LIFETIME_EXPIRY;
    } else if (planType === "yearly" && body.durationYears) {
      const years = Math.max(1, parseInt(body.durationYears, 10) || 1);
      expiresAt = row.issued_at + years * 31536000;
    }
  }
  // Keep single-device policy even when admin sends deviceLimit.
  deviceLimit = 1;
  if (body.expiresAt != null && typeof body.expiresAt === "number") {
    expiresAt = body.expiresAt;
  }

  await env.DB.prepare(
    "UPDATE licenses SET plan_type = ?, expires_at = ?, device_limit = ? WHERE license_key = ?"
  )
    .bind(planType, expiresAt, deviceLimit, licenseKey)
    .run();

  await logAction(
    env,
    "license_edited",
    licenseKey,
    JSON.stringify({ planType, expiresAt, deviceLimit })
  );

  return json({ ok: true });
}

async function revokeLicense(licenseKey, env) {
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare(
    "UPDATE licenses SET revoked_at = ? WHERE license_key = ?"
  )
    .bind(now, licenseKey)
    .run();

  if (r.meta.changes === 0) {
    return json({ error: "License not found" }, 404);
  }

  await logAction(env, "license_revoked", licenseKey, null);
  return json({ ok: true });
}

async function deleteLicense(licenseKey, env) {
  const row = await env.DB.prepare(
    "SELECT revoked_at FROM licenses WHERE license_key = ?"
  )
    .bind(licenseKey)
    .first();
  if (!row) return json({ error: "License not found" }, 404);
  if (row.revoked_at == null) {
    return json({ error: "Can only delete revoked licenses" }, 400);
  }
  await env.DB.prepare("DELETE FROM license_devices WHERE license_key = ?")
    .bind(licenseKey)
    .run();
  await env.DB.prepare("DELETE FROM licenses WHERE license_key = ?")
    .bind(licenseKey)
    .run();
  await logAction(env, "license_deleted", licenseKey, null);
  return json({ ok: true });
}

async function resetDevices(licenseKey, env) {
  await env.DB.prepare(
    "DELETE FROM license_devices WHERE license_key = ?"
  )
    .bind(licenseKey)
    .run();

  // Must clear legacy JSON too: validateLicense() falls back to `licenses.active_devices`
  // when license_devices is empty; stale entries here caused "Device limit reached" after reset.
  await env.DB.prepare(
    "UPDATE licenses SET active_devices = '[]' WHERE license_key = ?"
  )
    .bind(licenseKey)
    .run();

  await logAction(env, "devices_reset", licenseKey, null);
  return json({ ok: true });
}

async function revokeDevice(licenseKey, request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const fp = (body.device_fingerprint || "").trim();
  if (!fp) return json({ error: "device_fingerprint required" }, 400);

  await env.DB.prepare(
    "DELETE FROM license_devices WHERE license_key = ? AND device_fingerprint = ?"
  )
    .bind(licenseKey, fp)
    .run();

  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM license_devices WHERE license_key = ?"
  )
    .bind(licenseKey)
    .first();
  if ((remaining?.c ?? 0) === 0) {
    await env.DB.prepare(
      "UPDATE licenses SET active_devices = '[]' WHERE license_key = ?"
    )
      .bind(licenseKey)
      .run();
  }

  await logAction(env, "device_revoked", licenseKey, fp.slice(0, 8) + "…");
  return json({ ok: true });
}

async function listLogs(params, env) {
  const page = Math.max(1, parseInt(params.get("page"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(params.get("limit"), 10) || 50));
  const offset = (page - 1) * limit;

  const list = await env.DB.prepare(
    "SELECT id, action, license_key, details, created_at FROM admin_logs ORDER BY created_at DESC LIMIT ? OFFSET ?"
  )
    .bind(limit, offset)
    .all();

  const total = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM admin_logs"
  ).first();

  return json({
    logs: list.results || [],
    total: total?.c ?? 0,
    page,
    limit,
  });
}

async function createNotification(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const title = normalizeOptionalText(body.title, 120);
  const msg = normalizeRequiredText(body.body ?? body.message, 4000);
  if (!msg) return json({ error: "Body is required" }, 400);

  const yt = normalizeOptionalYouTubeUrl(body.youtube_url);
  if (!yt.ok) return json({ error: yt.error }, 400);

  const buttonText = normalizeOptionalText(body.button_text, 40);
  const buttonLink = normalizeOptionalHttpUrl(body.button_link);
  if (!buttonLink.ok) return json({ error: buttonLink.error }, 400);

  const createdAt = Math.floor(Date.now() / 1000);
  const id = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${createdAt}_${randomChars("abcdefghijklmnopqrstuvwxyz0123456789", 8)}`;
  const isActive = body.is_active === undefined ? true : !!body.is_active;

  await env.DB.prepare(
    `INSERT INTO notifications (id, title, body, youtube_url, button_text, button_link, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      title,
      msg,
      yt.value,
      buttonLink.value ? buttonText : null,
      buttonLink.value,
      isActive ? 1 : 0,
      createdAt
    )
    .run();

  // Keep only newest 5 notifications to control read/query costs.
  await env.DB.prepare(
    `DELETE FROM notifications
     WHERE id NOT IN (
       SELECT id FROM notifications ORDER BY created_at DESC LIMIT 5
     )`
  ).run();

  await logAction(env, "notification_created", null, JSON.stringify({ id, isActive }));
  return json({ ok: true, id, created_at: createdAt });
}

async function deleteNotification(id, env) {
  const sid = String(id || "").trim();
  if (!sid) return json({ error: "invalid id" }, 400);
  const existing = await env.DB.prepare("SELECT id FROM notifications WHERE id = ?")
    .bind(sid)
    .first();
  if (!existing) return json({ error: "Not found" }, 404);
  await env.DB.prepare("DELETE FROM notifications WHERE id = ?").bind(sid).run();
  await logAction(env, "notification_deleted", null, JSON.stringify({ id: sid }));
  return json({ ok: true, id: sid });
}

async function listNotifications(params, env, options = {}) {
  const allowInactive = options.allowInactive !== false;
  const includeInactive = allowInactive && params.get("include_inactive") === "1";
  const latestOnly = params.get("latest_only") === "1";
  const limit = latestOnly ? 1 : Math.min(5, Math.max(1, parseInt(params.get("limit"), 10) || 5));
  const where = includeInactive ? "" : "WHERE is_active = 1";
  const rows = await env.DB.prepare(
    `SELECT id, title, body, youtube_url, button_text, button_link, is_active, created_at
     FROM notifications
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();
  return json({ notifications: rows.results || [] });
}

async function internalRegister(request, env) {
  const secret = request.headers.get("X-Internal-Secret");
  if (!secret || secret !== env.INTERNAL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const email = normEmail(body.email);
  const passwordHash = String(body.passwordHash || "").trim();
  const name = String(body.name || "").trim();
  const surname = String(body.surname || "").trim();
  const username = String(body.username || "").trim();
  if (!email || !passwordHash || !name || !surname || !username) {
    return json({ error: "Missing fields" }, 400);
  }

  const forwarded = String(request.headers.get("X-Bloot-Client-Ip") || "").trim();
  const registrationIp = forwarded || clientIp(request);
  const regRl = await checkRegistrationIp(env, registrationIp);
  if (!regRl.ok) {
    return json(
      { error: "Too many registration attempts. Try again later." },
      429,
      regRl.retryAfter ? { "Retry-After": String(regRl.retryAfter) } : {}
    );
  }

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (exists) {
    return json({ error: "Registration could not be completed." }, 409);
  }
  const id = crypto.randomUUID();
  let publicId = "";
  for (let i = 0; i < 8; i += 1) {
    const candidate = generateBlootPublicId();
    const publicTaken = await env.DB.prepare("SELECT 1 FROM users WHERE public_id = ?")
      .bind(candidate)
      .first();
    if (!publicTaken) {
      publicId = candidate;
      break;
    }
  }
  if (!publicId) return json({ error: "Could not generate public id" }, 500);
  const now = Math.floor(Date.now() / 1000);
  const trialSec = 7 * 86400;
  const expiresAt = now + trialSec;
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, public_id, email, password_hash, name, surname, username, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
      .bind(id, publicId, email, passwordHash, name, surname, username, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO licenses (license_key, user_id, email, app_id, plan_type, issued_at, expires_at, device_limit, active_devices)
       VALUES (?, ?, ?, 'qooti', 'trial', ?, ?, 1, '[]')`
    )
      .bind(publicId, id, email, now, expiresAt)
      .run();
  } catch (e) {
    return json({ error: e.message || "Database error" }, 500);
  }
  await recordRegistrationSuccess(env, regRl.key);
  await logAction(env, "bloot_user_registered", publicId, JSON.stringify({ email, internal_id: id }));
  return json({ ok: true, blootUserId: publicId, email, name, surname, username, passwordChangedAt: 0 });
}

function loginRateKeyFromIdentifier(identifier) {
  const id = String(identifier || "").trim();
  if (!id) return "unknown";
  if (id.includes("@")) return normEmail(id);
  return `u:${id.toLowerCase()}`;
}

async function blootLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const identifier = String(body.identifier || body.email || "").trim();
  const password = String(body.password || "");
  if (!identifier || !password) return json({ error: "Email/username and password required" }, 400);

  const ip = clientIp(request);
  const ipBudget = await checkLoginIpAttemptBudget(env, ip);
  if (!ipBudget.ok) {
    return json(
      { error: "Too many login attempts. Try again later." },
      429,
      { "Retry-After": String(ipBudget.retryAfter || 900) }
    );
  }

  const uniqueRow = await env.DB.prepare(
    `SELECT id, public_id, email, name, surname, username, password_hash, password_changed_at
     FROM users
     WHERE LOWER(email) = ? OR LOWER(public_id) = ? OR id = ?
     LIMIT 1`
  )
    .bind(normEmail(identifier), identifier.toLowerCase(), identifier)
    .first();
  let row = uniqueRow;
  if (!row) {
    const byUsername = await env.DB.prepare(
      `SELECT id, public_id, email, name, surname, username, password_hash, password_changed_at
       FROM users
       WHERE LOWER(username) = ?
       LIMIT 2`
    )
      .bind(identifier.toLowerCase())
      .all();
    const rows = byUsername?.results || [];
    if (rows.length > 1) {
      const logLine = JSON.stringify({
        event: "login_failed_duplicate_username",
        ip,
        ts: Math.floor(Date.now() / 1000),
      });
      console.warn(logLine);
      return json({ error: LOGIN_ERROR_GENERIC }, 401);
    }
    row = rows.length === 1 ? rows[0] : null;
  }

  const rateKey = row ? normEmail(row.email) : loginRateKeyFromIdentifier(identifier);
  const gate = await checkLoginAllowed(env, rateKey, ip);
  if (!gate.ok) {
    const ra = gate.retryAfter || 60;
    return json(
      { error: "Too many login attempts. Try again later." },
      429,
      { "Retry-After": String(ra) }
    );
  }

  const hashToCheck = row?.password_hash || DUMMY_PASSWORD_HASH;
  const passwordOk = await bcrypt.compare(password, hashToCheck);

  if (!row || !passwordOk) {
    await recordLoginFailure(env, rateKey, gate.emailState, gate.ek, gate.t);
    const logLine = JSON.stringify({
      event: "login_failed",
      ip,
      ts: Math.floor(Date.now() / 1000),
      bucket: rateKey,
    });
    console.warn(logLine);
    return json({ error: LOGIN_ERROR_GENERIC }, 401);
  }

  await recordLoginSuccess(env, rateKey, ip);
  const pwdTs = row.password_changed_at != null ? Number(row.password_changed_at) : 0;
  return json({
    ok: true,
    user: {
      blootUserId: row.public_id || row.id,
      email: row.email,
      name: row.name,
      surname: row.surname,
      username: row.username,
      passwordChangedAt: pwdTs,
    },
  });
}

async function internalResetPassword(request, env) {
  const secret = request.headers.get("X-Internal-Secret");
  if (!secret || secret !== env.INTERNAL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const email = normEmail(body.email);
  const passwordHash = String(body.passwordHash || "").trim();
  if (!email || !passwordHash) {
    return json({ error: "Missing fields" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (!existing) {
    return json({ ok: true });
  }
  await env.DB.prepare("UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE email = ?")
    .bind(passwordHash, now, now, email)
    .run();
  await logAction(env, "bloot_password_reset", existing.id, JSON.stringify({ email }));
  return json({ ok: true });
}
