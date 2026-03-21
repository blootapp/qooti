/**
 * Qooti License Worker
 * App: POST /license/validate, GET /license/status
 * Admin: GET/POST/PATCH /admin/licenses, /admin/licenses/:key, /admin/logs, /admin/notifications
 * App: GET /app/notifications
 * Status derived at read time: valid = revoked_at IS NULL AND expires_at > now
 */

const LIFETIME_EXPIRY = 253402300799; // far future
const LAST_SEEN_UPDATE_INTERVAL = 86400; // 24 hours

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
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

function generateLicenseKey() {
  const segment = () =>
    Math.random().toString(36).toUpperCase().slice(2, 6).padStart(4, "0");
  return `QOOTI-${segment()}-${segment()}-${segment()}`;
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
      if (path === "/admin/notifications" && request.method === "POST") {
        return createNotification(request, env);
      }
      if (path === "/admin/notifications" && request.method === "GET") {
        return listNotifications(url.searchParams, env);
      }
      return json({ error: "Not found" }, 404);
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

async function validateLicense(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const licenseKey = (body.license_key || "").trim();
  const deviceFingerprint = (body.device_fingerprint || "").trim();
  if (!licenseKey || !deviceFingerprint) {
    return json({ error: "license_key and device_fingerprint required" }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT license_key, plan_type, expires_at, device_limit, revoked_at FROM licenses WHERE license_key = ?"
  )
    .bind(licenseKey)
    .first();

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

  // Use license_devices if table exists, else fall back to active_devices
  let deviceCount = 0;
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
    // Device already registered: update last_seen sparingly (once per day)
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
    return json({
      valid: true,
      status: "valid",
      plan_type: row.plan_type || "lifetime",
      expires_at: row.expires_at,
    });
  }

  // New device: check limit
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
  const limit = row.device_limit || 3;
  const count = countRow?.c ?? 0;

  // Fallback: if license_devices empty but licenses has active_devices
  if (count === 0) {
    try {
      const oldRow = await env.DB.prepare(
        "SELECT active_devices FROM licenses WHERE license_key = ?"
      )
        .bind(licenseKey)
        .first();
      if (oldRow?.active_devices) {
        let arr = [];
        try {
          arr = JSON.parse(oldRow.active_devices || "[]");
        } catch (_) {}
        if (arr.includes(deviceFingerprint)) {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO license_devices (license_key, device_fingerprint, first_seen, last_seen) VALUES (?, ?, ?, ?)"
          )
            .bind(licenseKey, deviceFingerprint, now, now)
            .run();
          return json({
            valid: true,
            status: "valid",
            plan_type: row.plan_type || "lifetime",
            expires_at: row.expires_at,
          });
        }
        if (arr.length >= limit) {
          return json({ valid: false, error: "Device limit reached" }, 200);
        }
        arr.push(deviceFingerprint);
        await env.DB.prepare(
          "UPDATE licenses SET active_devices = ? WHERE license_key = ?"
        )
          .bind(JSON.stringify(arr), licenseKey)
          .run();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO license_devices (license_key, device_fingerprint, first_seen, last_seen) VALUES (?, ?, ?, ?)"
        )
          .bind(licenseKey, deviceFingerprint, now, now)
          .run();
        return json({
          valid: true,
          status: "valid",
          plan_type: row.plan_type || "lifetime",
          expires_at: row.expires_at,
        });
      }
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

  return json({
    valid: true,
    status: "valid",
    plan_type: row.plan_type || "lifetime",
    expires_at: row.expires_at,
  });
}

async function getLicenseStatusForApp(licenseKey, deviceFingerprint, env) {
  if (!licenseKey) return json({ valid: false }, 400);

  const row = await env.DB.prepare(
    "SELECT license_key, plan_type, expires_at, revoked_at FROM licenses WHERE license_key = ?"
  )
    .bind(licenseKey)
    .first();

  if (!row) return json({ valid: false });

  const now = Math.floor(Date.now() / 1000);
  const valid =
    row.revoked_at == null && row.expires_at > now;

  return json({
    valid,
    status: valid ? "valid" : row.revoked_at ? "revoked" : "expired",
    plan_type: row.plan_type || "lifetime",
    expires_at: row.expires_at,
  });
}

async function listLicenses(params, env) {
  const page = Math.max(1, parseInt(params.get("page"), 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(params.get("limit"), 10) || 20));
  const offset = (page - 1) * limit;
  const licenseKey = (params.get("license_key") || "").trim();
  const status = params.get("status");
  const planType = params.get("plan_type");
  const expirationWindow = params.get("expiration_window"); // expiring_7 | expiring_30 | expired
  const deviceLimitState = params.get("device_limit_state"); // at_limit | over_limit

  const now = Math.floor(Date.now() / 1000);

  let where = [];
  let args = [];

  // License key: exact match, overrides other filters when provided
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
    if (planType === "lifetime" || planType === "yearly") {
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

  const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

  const baseSql = `
    SELECT l.license_key, l.plan_type, l.issued_at, l.expires_at, l.device_limit, l.revoked_at,
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
      plan_type: r.plan_type,
      issued_at: r.issued_at,
      expires_at: r.expires_at,
      device_limit: r.device_limit ?? 3,
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

function maskKey(key) {
  if (!key || key.length < 12) return "****";
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
  const deviceLimit = Math.max(1, parseInt(body.deviceLimit, 10) || 3);
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
        `INSERT INTO licenses (license_key, user_id, plan_type, issued_at, expires_at, device_limit, active_devices)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(licenseKey, body.userId || "admin", planType, issuedAt, expiresAt, deviceLimit, "[]")
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
    "SELECT license_key, user_id, plan_type, issued_at, expires_at, device_limit, revoked_at FROM licenses WHERE license_key = ?"
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
  let deviceLimit = row.device_limit;

  if (body.planType === "lifetime" || body.planType === "yearly") {
    planType = body.planType;
    if (planType === "lifetime") {
      expiresAt = LIFETIME_EXPIRY;
    } else if (body.durationYears) {
      const years = Math.max(1, parseInt(body.durationYears, 10) || 1);
      expiresAt = row.issued_at + years * 31536000;
    }
  }
  if (body.deviceLimit != null) {
    deviceLimit = Math.max(1, parseInt(body.deviceLimit, 10) || 3);
  }
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
  const r = await env.DB.prepare(
    "DELETE FROM license_devices WHERE license_key = ?"
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
    : `${createdAt}_${Math.random().toString(36).slice(2, 10)}`;
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
