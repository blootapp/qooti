/**
 * Qooti Chrome Extension — Background Service Worker
 * Phase 1: Context menu, desktop bridge. No heavy polling.
 */

const DEFAULT_DESKTOP_URL = "http://127.0.0.1:1420";
const STORAGE_KEYS = {
  DISPLAY_MODE: "displayMode",
  DESKTOP_URL: "desktopUrl",
  CONNECTION_KEY: "connectionKey",
  LAST_EXTENSION_ERROR: "lastExtensionError",
  LAST_EXTENSION_ERROR_TIME: "lastExtensionErrorTime",
};

// --- Context menu setup (run once on install / startup)
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "qooti-add",
      title: "Add to Qooti",
      contexts: ["image", "video", "link"],
    });
    chrome.contextMenus.create({
      id: "qooti-download",
      title: "Download and add to Qooti",
      contexts: ["image", "video"],
    });
    chrome.contextMenus.create({
      id: "qooti-separator",
      type: "separator",
      contexts: ["image", "video", "link"],
    });
    chrome.contextMenus.create({
      id: "qooti-save-link",
      title: "Add to Qooti as link",
      contexts: ["image", "video", "link"],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
});

// --- Desktop app communication (local HTTP)
async function getDesktopUrl() {
  const o = await chrome.storage.local.get(STORAGE_KEYS.DESKTOP_URL);
  return (o[STORAGE_KEYS.DESKTOP_URL] || DEFAULT_DESKTOP_URL).replace(/\/+$/, "");
}

async function getConnectionKey() {
  const o = await chrome.storage.local.get(STORAGE_KEYS.CONNECTION_KEY);
  return (o[STORAGE_KEYS.CONNECTION_KEY] || "").trim();
}

async function sendToDesktop(payload) {
  const key = await getConnectionKey();
  if (!key) {
    throw new Error("No connection key. Open the extension popup and enter your Qooti key.");
  }
  const base = await getDesktopUrl();
  const url = `${base}/qooti/add`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Qooti-Key": key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      await chrome.storage.local.remove(STORAGE_KEYS.CONNECTION_KEY);
      throw new Error("Invalid connection key. Get a new key from Qooti settings.");
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    return await res.json().catch(() => ({}));
  } catch (e) {
    if (e.name === "TimeoutError" || e.message?.includes("Failed to fetch")) {
      throw new Error("Qooti desktop is not running.");
    }
    throw e;
  }
}

function showDesktopNotRunningNotification() {
  chrome.notifications?.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon.png"),
    title: "Qooti",
    message: "Qooti desktop is not running.",
  }).catch(() => {});
}

function isValidPayloadUrl(url, platform) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (platform === "youtube" && u.hostname === "www.youtube.com" && (u.pathname === "/" || u.pathname === "")) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// --- Return icon as data URL so content script can show it (avoids CSP blocking extension URL)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "QOOTI_GET_ICON_DATA_URL") {
    fetch(chrome.runtime.getURL("icons/icon.png"))
      .then((r) => r.blob())
      .then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ dataUrl: reader.result });
        reader.readAsDataURL(blob);
      })
      .catch(() => sendResponse({ dataUrl: null }));
    return true;
  }
  if (msg.type === "QOOTI_PING") {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type !== "QOOTI_ADD_MEDIA") return;
  const payload = {
    action: msg.action === "link" ? "link" : msg.action === "download" ? "download" : msg.action === "thumbnail" ? "thumbnail" : "add",
    url: msg.url || "",
    pageUrl: msg.pageUrl || "",
    pageTitle: msg.pageTitle || "",
    mediaType: msg.mediaType || "image",
    platform: msg.platform || "generic",
  };
  if (!isValidPayloadUrl(payload.url, payload.platform)) {
    sendResponse({ ok: false, error: "Invalid media URL" });
    return;
  }
  console.log("[Qooti background] Sending to desktop:", payload.action, payload.url);
  // Respond only after desktop acknowledges queueing the request.
  sendToDesktop(payload)
    .then((desktopRes) => {
      chrome.storage.local.remove([STORAGE_KEYS.LAST_EXTENSION_ERROR, STORAGE_KEYS.LAST_EXTENSION_ERROR_TIME]);
      sendResponse({ ok: true, queued: true, desktop: desktopRes || null });
    })
    .catch((e) => {
      const errMsg = e?.message || "Something went wrong.";
      console.error("[Qooti background] Desktop error:", errMsg);
      chrome.storage.local.set({
        [STORAGE_KEYS.LAST_EXTENSION_ERROR]: errMsg,
        [STORAGE_KEYS.LAST_EXTENSION_ERROR_TIME]: Date.now(),
      });
      if (errMsg.includes("not running")) {
        showDesktopNotRunningNotification();
      } else {
        chrome.notifications?.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon.png"),
          title: "Qooti",
          message: errMsg.slice(0, 100),
        }).catch(() => {});
      }
      sendResponse({ ok: false, error: errMsg });
    });
  return true;
});

// --- Context menu actions
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const { menuItemId, srcUrl, linkUrl, pageUrl } = info;
  if (menuItemId === "qooti-separator") return;
  const url = srcUrl || linkUrl || pageUrl;
  if (!url) return;
  const isPinterest = (tab?.url || "").includes("pinterest.");
  if (isPinterest && menuItemId === "qooti-save-link") {
    chrome.notifications?.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon.png"),
      title: "Qooti",
      message: "Save as link is disabled on Pinterest.",
    }).catch(() => {});
    return;
  }

  const payload = {
    action: menuItemId === "qooti-save-link" ? "link" : menuItemId === "qooti-download" ? "download" : "add",
    url,
    pageUrl: tab?.url || "",
    pageTitle: tab?.title || "",
    mediaType: info.mediaType || (linkUrl ? "link" : "image"),
  };
  if (!isValidPayloadUrl(payload.url, payload.platform || "generic")) return;

  try {
    await sendToDesktop(payload);
    // Do not show "Added to Qooti" here — request is only queued. App will notify after it actually adds media.
  } catch (e) {
    const msg = e?.message || "Something went wrong.";
    if (msg.includes("not running")) {
      showDesktopNotRunningNotification();
    } else {
      chrome.notifications?.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon.png"),
        title: "Qooti",
        message: msg.slice(0, 100),
      }).catch(() => {});
    }
  }
});

