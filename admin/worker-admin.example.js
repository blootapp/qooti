/**
 * Example admin routes to add to your Cloudflare Worker (Qooti license API).
 * - Requires D1 binding named DB (e.g. env.DB) and ADMIN_SECRET in env.
 * - Assumes a table: licenses(license_key, user_id, plan_type, issued_at, expires_at, device_limit, active_devices)
 *   with active_devices as JSON array string, e.g. '[]'.
 */

const LIFETIME_EXPIRY = 253402300799; // far future Unix timestamp

export function handleAdmin(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const secret = request.headers.get("X-Admin-Secret");
  if (secret !== env.ADMIN_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  // POST /admin/licenses — add a license
  if (path === "/admin/licenses" && request.method === "POST") {
    return addLicense(request, env);
  }

  // GET /admin/licenses/:key — get license status
  if (path.startsWith("/admin/licenses/") && request.method === "GET") {
    const key = decodeURIComponent(path.slice("/admin/licenses/".length));
    return getLicenseStatus(key, env);
  }

  return json({ error: "Not found" }, 404);
}

async function addLicense(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const licenseKey = (body.licenseKey || "").trim();
  if (!licenseKey) {
    return json({ error: "licenseKey is required" }, 400);
  }
  const planType = body.planType === "yearly" ? "yearly" : "lifetime";
  const deviceLimit = Math.max(1, parseInt(body.deviceLimit, 10) || 3);
  let expiresAt = body.expiresAt;
  if (expiresAt == null || expiresAt === "") {
    expiresAt = planType === "lifetime" ? LIFETIME_EXPIRY : Math.floor(Date.now() / 1000) + 31536000;
  }
  const issuedAt = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(
      `INSERT INTO licenses (license_key, user_id, plan_type, issued_at, expires_at, device_limit, active_devices)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(licenseKey, body.userId || "admin", planType, issuedAt, expiresAt, deviceLimit, "[]")
      .run();
    return json({ ok: true });
  } catch (e) {
    if (e.message && e.message.includes("UNIQUE constraint")) {
      return json({ error: "License key already exists" }, 409);
    }
    return json({ error: e.message || "Database error" }, 500);
  }
}

async function getLicenseStatus(licenseKey, env) {
  if (!licenseKey) {
    return json({ error: "License key required" }, 400);
  }
  try {
    const row = await env.DB.prepare(
      "SELECT license_key, plan_type, issued_at, expires_at, device_limit, active_devices FROM licenses WHERE license_key = ?"
    )
      .bind(licenseKey)
      .first();
    if (!row) {
      return json({ error: "License not found" }, 404);
    }
    const now = Math.floor(Date.now() / 1000);
    const valid = row.expires_at > now;
    return json({
      license_key: row.license_key,
      plan_type: row.plan_type,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      valid,
      device_limit: row.device_limit,
      active_devices: row.active_devices,
    });
  } catch (e) {
    return json({ error: e.message || "Database error" }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret",
    },
  });
}

/**
 * In your main Worker fetch(), route admin like this:
 *
 * if (url.pathname.startsWith("/admin/")) {
 *   return handleAdmin(request, env, ctx);
 * }
 *
 * And for OPTIONS (CORS preflight):
 * if (request.method === "OPTIONS" && url.pathname.startsWith("/admin/")) {
 *   return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", ... } });
 * }
 */
