/**
 * Media-add notifications: in-app toast when window is visible,
 * native Windows toast when window is minimized or hidden.
 * Groups rapid additions into a single notification.
 */

async function getNotificationApi() {
  if (!window.__TAURI__) return null;
  try {
    return await import("@tauri-apps/plugin-notification");
  } catch {
    return null;
  }
}

const GROUP_DEBOUNCE_MS = 1800;
let pending = [];
let flushTimer = null;

function getWindow() {
  return window.__TAURI__?.window?.getCurrentWindow?.();
}

async function isWindowVisible() {
  const w = getWindow();
  if (!w) return true; // Assume visible if not Tauri (Electron/fallback)
  try {
    const [visible, minimized] = await Promise.all([w.isVisible(), w.isMinimized()]);
    return !!(visible && !minimized);
  } catch {
    return true;
  }
}

async function ensurePermission(api) {
  if (!api) return false;
  let granted = await api.isPermissionGranted();
  if (!granted) {
    const status = await api.requestPermission();
    granted = status === "granted";
  }
  return granted;
}

function consolidate(messages) {
  const errors = messages.filter((m) => m.isError);
  if (errors.length > 0) {
    const last = errors[errors.length - 1].msg;
    if (last.toLowerCase().includes("download")) return "Download failed";
    if (last.toLowerCase().includes("import")) return "Import failed";
    return last.length > 60 ? last.slice(0, 57) + "…" : last;
  }
  let total = 0;
  for (const m of messages) {
    const multi = m.msg.match(/^(\d+)\s*items?\s*added/i);
    const single =
      /^Added$/i.test(m.msg) ||
      /^image\s+added$/i.test(m.msg) ||
      /^video\s+downloaded$/i.test(m.msg) ||
      /^media\s+added\s+to\s+qooti$/i.test(m.msg) ||
      /^video\s+added\s+to\s+qooti$/i.test(m.msg) ||
      /^downloading\s+video/i.test(m.msg);
    if (multi) total += parseInt(multi[1], 10);
    else if (single) total += 1;
    else total += 1;
  }
  if (total <= 0) total = Math.max(1, messages.length);
  const last = messages[messages.length - 1];
  if (last && /^downloading\s+video/i.test(last.msg)) return last.msg;
  return total === 1 ? "Media added to Qooti" : `${total} items added to Qooti`;
}

function flush(showFn) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;
  const msgs = [...pending];
  pending = [];
  const text = consolidate(msgs);
  showFn(text, msgs.some((m) => m.isError));
}

/**
 * When window is minimized/hidden, shows a native system notification.
 * Call this in addition to in-app toast — when visible, this does nothing.
 * Groups rapid calls within ~1.8s into one notification.
 * @param {string} msg - e.g. "Media added to Qooti", "Downloading video…", "Download failed"
 * @param {object} opts - { variant: "success"|"error", item, durationMs }
 */
export async function notifyNativeWhenHidden(msg, opts = {}) {
  let visible = true;
  try {
    visible = await isWindowVisible();
  } catch {
    visible = true;
  }
  if (visible) return;
  const isError = (opts.variant || "").toLowerCase() === "error";
  pending.push({ msg: String(msg || "").trim() || "Item added", isError });
  if (flushTimer) return;
  const toastFn = typeof window !== "undefined" && window.__notifyToast;
  flushTimer = setTimeout(async () => {
    const api = await getNotificationApi();
    flush(async (text, isErr) => {
      const fallbackOpts = { variant: isErr ? "error" : "success" };
      if (!api) {
        if (toastFn) toastFn(text, fallbackOpts);
        return;
      }
      const granted = await ensurePermission(api);
      if (!granted && toastFn) toastFn(text, fallbackOpts);
      if (granted) api.sendNotification({ title: "Qooti", body: text }).catch(() => {});
    });
  }, GROUP_DEBOUNCE_MS);
}

/**
 * Notify that media was added (or an error occurred).
 * When window is visible: uses in-app toast.
 * When minimized/hidden: uses native Windows toast.
 * Groups rapid calls within ~1.8s into one notification.
 * @param {string} msg - e.g. "Added", "3 items added", "Download failed"
 * @param {object} opts - { variant: "success"|"error", item, durationMs }
 */
export async function notifyMediaAdded(msg, opts = {}) {
  const isError = (opts.variant || "").toLowerCase() === "error";
  const toastFn = typeof window !== "undefined" && window.__notifyToast;
  if (!toastFn) return;

  let visible = true;
  try {
    visible = await isWindowVisible();
  } catch {
    visible = true; // Assume visible on error so we always show in-app toast as fallback
  }
  if (visible) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    pending = [];
    toastFn(msg, opts);
    return;
  }

  // Window hidden/minimized: queue for grouping, then send system notification
  pending.push({ msg: String(msg || "").trim() || "Item added", isError });
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    const api = await getNotificationApi();
    flush(async (text, isErr) => {
      const fallbackOpts = { variant: isErr ? "error" : "success" };
      if (!api) {
        if (toastFn) toastFn(text, fallbackOpts);
        return;
      }
      const granted = await ensurePermission(api);
      if (!granted && toastFn) toastFn(text, fallbackOpts);
      if (granted) api.sendNotification({ title: "Qooti", body: text }).catch(() => {});
    });
  }, GROUP_DEBOUNCE_MS);
}
