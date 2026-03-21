/**
 * Example public license routes for the Qooti Worker.
 *
 * These routes are what the desktop app expects:
 * - POST /license/validate
 * - GET /license/status?license_key=...&device_fingerprint=...
 *
 * Expected response shape:
 * {
 *   valid: boolean,
 *   status: "valid" | "expired" | "revoked" | "device_limit" | "not_found" | "inactive",
 *   plan_type?: string,
 *   expires_at?: number,
 *   message?: string,
 *   device_limit?: number,
 *   device_count?: number
 * }
 */

const LIFETIME_EXPIRY = 253402300799;

export async function handlePublicLicense(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/license/validate" && request.method === "POST") {
    return validateLicense(request, env);
  }
  if (url.pathname === "/license/status" && request.method === "GET") {
    return getLicenseStatus(request, env);
  }
  return null;
}

async function validateLicense(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ valid: false, status: "invalid", message: "Invalid JSON body." }, 400);
  }
  const licenseKey = String(body.license_key || "").trim();
  const deviceFingerprint = String(body.device_fingerprint || "").trim();
  if (!licenseKey || !deviceFingerprint) {
    return json({ valid: false, status: "invalid", message: "License key and device fingerprint are required." }, 400);
  }
  const row = await loadLicenseRow(licenseKey, env);
  if (!row) {
    return json({ valid: false, status: "not_found", message: "License not found." }, 404);
  }
  const evaluated = evaluateLicenseRow(row, deviceFingerprint);
  if (!evaluated.valid) {
    const code = evaluated.status === "not_found" ? 404 : evaluated.status === "revoked" ? 403 : 409;
    return json(evaluated, code);
  }
  await saveDeviceFingerprint(row, deviceFingerprint, env);
  return json({
    valid: true,
    status: "valid",
    plan_type: row.plan_type || "lifetime",
    expires_at: Number(row.expires_at || LIFETIME_EXPIRY),
    device_limit: Number(row.device_limit || 3),
    device_count: evaluated.device_count,
    message: "License is valid.",
  });
}

async function getLicenseStatus(request, env) {
  const url = new URL(request.url);
  const licenseKey = String(url.searchParams.get("license_key") || "").trim();
  const deviceFingerprint = String(url.searchParams.get("device_fingerprint") || "").trim();
  if (!licenseKey || !deviceFingerprint) {
    return json({ valid: false, status: "invalid", message: "License key and device fingerprint are required." }, 400);
  }
  const row = await loadLicenseRow(licenseKey, env);
  if (!row) {
    return json({ valid: false, status: "not_found", message: "License not found." }, 404);
  }
  const evaluated = evaluateLicenseRow(row, deviceFingerprint);
  const httpStatus = evaluated.valid ? 200 : evaluated.status === "revoked" ? 403 : evaluated.status === "not_found" ? 404 : 409;
  return json(evaluated, httpStatus);
}

function evaluateLicenseRow(row, deviceFingerprint) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(row.expires_at || LIFETIME_EXPIRY);
  const deviceLimit = Math.max(1, Number(row.device_limit || 3));
  const activeDevices = parseActiveDevices(row.active_devices);
  const hasDevice = activeDevices.includes(deviceFingerprint);
  const revoked = Number(row.revoked || 0) === 1 || String(row.status || "").toLowerCase() === "revoked";
  const inactive = Number(row.is_active || 1) === 0;
  const expired = expiresAt < now;
  const overLimit = !hasDevice && activeDevices.length >= deviceLimit;

  if (revoked) {
    return {
      valid: false,
      status: "revoked",
      plan_type: row.plan_type || "lifetime",
      expires_at: expiresAt,
      device_limit: deviceLimit,
      device_count: activeDevices.length,
      message: "This license has been revoked.",
    };
  }
  if (inactive) {
    return {
      valid: false,
      status: "inactive",
      plan_type: row.plan_type || "lifetime",
      expires_at: expiresAt,
      device_limit: deviceLimit,
      device_count: activeDevices.length,
      message: "This license is inactive.",
    };
  }
  if (expired) {
    return {
      valid: false,
      status: "expired",
      plan_type: row.plan_type || "lifetime",
      expires_at: expiresAt,
      device_limit: deviceLimit,
      device_count: activeDevices.length,
      message: "This license has expired.",
    };
  }
  if (overLimit) {
    return {
      valid: false,
      status: "device_limit",
      plan_type: row.plan_type || "lifetime",
      expires_at: expiresAt,
      device_limit: deviceLimit,
      device_count: activeDevices.length,
      message: "This license has reached its device limit.",
    };
  }
  return {
    valid: true,
    status: "valid",
    plan_type: row.plan_type || "lifetime",
    expires_at: expiresAt,
    device_limit: deviceLimit,
    device_count: hasDevice ? activeDevices.length : activeDevices.length + 1,
    message: "License is valid.",
  };
}

async function loadLicenseRow(licenseKey, env) {
  return env.DB.prepare(
    `SELECT license_key, plan_type, expires_at, device_limit, active_devices, revoked, is_active, status
     FROM licenses
     WHERE license_key = ?`
  )
    .bind(licenseKey)
    .first();
}

async function saveDeviceFingerprint(row, deviceFingerprint, env) {
  const activeDevices = parseActiveDevices(row.active_devices);
  if (activeDevices.includes(deviceFingerprint)) return;
  activeDevices.push(deviceFingerprint);
  await env.DB.prepare(
    "UPDATE licenses SET active_devices = ? WHERE license_key = ?"
  )
    .bind(JSON.stringify(activeDevices), row.license_key)
    .run();
}

function parseActiveDevices(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map((value) => String(value)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
