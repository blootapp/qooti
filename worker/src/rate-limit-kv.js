/**
 * Rate limiting with Cloudflare KV (optional binding env.RATE_LIMIT).
 * If KV is missing, limits are skipped (local dev) — deploy with KV in production.
 */

const WINDOW_15M = 15 * 60;
const WINDOW_1H = 60 * 60;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function getJson(kv, key) {
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function putJson(kv, key, val, ttlSec) {
  if (!kv) return;
  await kv.put(key, JSON.stringify(val), { expirationTtl: Math.max(60, ttlSec) });
}

/**
 * Login: max 5 failures per email per 15m, then 15m lockout (email bucket).
 */
export async function checkLoginAllowed(env, emailKey, ip) {
  const kv = env.RATE_LIMIT;
  const ek = `l:em:${emailKey}`;
  const t = nowSec();

  const emailState = (await getJson(kv, ek)) || { fails: 0, lockedUntil: 0, windowStart: t };
  if (emailState.lockedUntil > t) {
    return { ok: false, reason: "locked_email", retryAfter: emailState.lockedUntil - t };
  }
  if (t - emailState.windowStart > WINDOW_15M) {
    emailState.fails = 0;
    emailState.windowStart = t;
  }

  return { ok: true, emailState, ek, t };
}

export async function recordLoginFailure(env, emailKey, emailState, ek, t) {
  const kv = env.RATE_LIMIT;
  if (!kv) return;
  emailState.fails = (emailState.fails || 0) + 1;

  if (emailState.fails >= 5) {
    emailState.lockedUntil = t + WINDOW_15M;
  }

  await putJson(kv, ek, emailState, WINDOW_15M * 2);
}

/**
 * Every login POST counts against this IP bucket (all attempts, not only failures).
 * Max 20 per 15 minutes, then 15-minute lockout.
 */
export async function checkLoginIpAttemptBudget(env, ip) {
  const kv = env.RATE_LIMIT;
  if (!kv) return { ok: true };
  const key = `l:ip_try:${ip}`;
  const t = nowSec();
  let state = (await getJson(kv, key)) || { windowStart: t, attempts: 0, lockedUntil: 0 };
  if (state.lockedUntil > t) {
    return { ok: false, retryAfter: state.lockedUntil - t };
  }
  if (t - state.windowStart > WINDOW_15M) {
    state.attempts = 0;
    state.windowStart = t;
  }
  state.attempts = (state.attempts || 0) + 1;
  if (state.attempts > 20) {
    state.lockedUntil = t + WINDOW_15M;
  }
  await putJson(kv, key, state, WINDOW_15M * 2);
  if (state.lockedUntil > t) {
    return { ok: false, retryAfter: state.lockedUntil - t };
  }
  return { ok: true };
}

export async function recordLoginSuccess(env, emailKey, ip) {
  const kv = env.RATE_LIMIT;
  if (!kv) return;
  const ek = `l:em:${emailKey}`;
  const ipTry = `l:ip_try:${ip}`;
  await kv.delete(ek).catch(() => {});
  await kv.delete(ipTry).catch(() => {});
}

/** Registration: max 3 successful account creations per IP per rolling hour (bucketed). */
export async function checkRegistrationIp(env, ip) {
  const t = nowSec();
  const bucket = Math.floor(t / WINDOW_1H);
  const key = `reg:ip:${ip}:${bucket}`;
  const kv = env.RATE_LIMIT;
  if (!kv) return { ok: true, key };
  const cnt = parseInt((await kv.get(key)) || "0", 10) || 0;
  if (cnt >= 3) {
    const retryAfter = (bucket + 1) * WINDOW_1H - t;
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }
  return { ok: true, key };
}

export async function recordRegistrationSuccess(env, key) {
  const kv = env.RATE_LIMIT;
  if (!kv || !key) return;
  const cnt = parseInt((await kv.get(key)) || "0", 10) || 0;
  await kv.put(key, String(cnt + 1), { expirationTtl: WINDOW_1H * 2 });
}

/** Password reset prepare: max 3 requests per email per hour (bucketed). */
export async function assertResetEmailAllowed(env, emailNorm) {
  const kv = env.RATE_LIMIT;
  const bucket = Math.floor(nowSec() / WINDOW_1H);
  const key = `rst:em:${emailNorm}:${bucket}`;
  if (!kv) return { ok: true, key };
  const cnt = parseInt((await kv.get(key)) || "0", 10) || 0;
  if (cnt >= 3) {
    const retryAfter = (bucket + 1) * WINDOW_1H - nowSec();
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }
  await kv.put(key, String(cnt + 1), { expirationTtl: WINDOW_1H * 2 });
  return { ok: true, key };
}

/** OTP wrong attempts: key per email+category; invalidate after 5 */
const OTP_FAIL_PREFIX = "otpfail:";

export async function getOtpFailCount(env, email, category) {
  const kv = env.RATE_LIMIT;
  if (!kv) return 0;
  const raw = await kv.get(`${OTP_FAIL_PREFIX}${email}:${category}`);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

export async function incrementOtpFail(env, email, category) {
  const kv = env.RATE_LIMIT;
  if (!kv) return 1;
  const k = `${OTP_FAIL_PREFIX}${email}:${category}`;
  const prev = parseInt((await kv.get(k)) || "0", 10) || 0;
  const n = prev + 1;
  await kv.put(k, String(n), { expirationTtl: 15 * 60 });
  return n;
}

export async function clearOtpFail(env, email, category) {
  const kv = env.RATE_LIMIT;
  if (!kv) return;
  await kv.delete(`${OTP_FAIL_PREFIX}${email}:${category}`).catch(() => {});
}

/** Global API burst: max 100 requests per IP per minute; 60s lockout feel via Retry-After. */
export async function checkGlobalApiPerMinute(env, ip) {
  const kv = env.RATE_LIMIT;
  if (!kv) return { ok: true };
  const bucket = Math.floor(nowSec() / 60);
  const key = `gapi:${ip}:${bucket}`;
  const cnt = parseInt((await kv.get(key)) || "0", 10) || 0;
  if (cnt >= 100) {
    return { ok: false, retryAfter: 60 };
  }
  await kv.put(key, String(cnt + 1), { expirationTtl: 180 });
  return { ok: true };
}
