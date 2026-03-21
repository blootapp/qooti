const STORAGE_KEYS = {
  CONNECTION_KEY: "connectionKey",
  DESKTOP_URL: "desktopUrl",
  DISPLAY_MODE: "displayMode",
  DEFAULT_ACTION: "defaultAction",
  LAST_EXTENSION_ERROR: "lastExtensionError",
  LAST_EXTENSION_ERROR_TIME: "lastExtensionErrorTime",
  LANGUAGE: "language",
};
const LAST_ERROR_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_DESKTOP_URL = "http://127.0.0.1:1420";

const translations = {
  en: {
    popupTitle: "Qooti",
    popupSetupLabel: "Enter your Qooti connection key",
    placeholderConnectionKey: "Paste key from Qooti → Settings → Extension Connection",
    popupSetupHint: "Get the key from the desktop app: Settings → Extension Connection",
    popupSaveAndConnect: "Save and connect",
    popupConnectionStatus: "Connection status",
    popupChecking: "Checking…",
    popupNotConnected: "Not connected",
    popupEnterKeyAbove: "Enter your connection key above",
    popupConnected: "Connected",
    popupLastUsed: "Last used",
    popupJustNow: "just now",
    popupMinutesAgo: "m ago",
    popupHoursAgo: "h ago",
    popupConnectionFailed: "Connection failed",
    popupInvalidKey: "Invalid key. Get a new key from Qooti.",
    popupErrorStatus: "Error",
    popupDesktopNotRunning: "Qooti desktop is not running or not reachable.",
    popupLastErrorFromPage: "Last error from page",
    popupOpenQooti: "Open Qooti",
    popupDefaultAction: "Default action",
    popupOptAdd: "Add to Qooti",
    popupOptDownload: "Download and add",
    popupOptLink: "Save as link",
    popupScreenshotHint: "Screenshot: keyboard shortcut in Advanced settings",
    popupChangeKey: "Change key",
    popupAdvancedSettings: "Advanced settings",
    popupSetupErrorEnterKey: "Enter your connection key.",
    popupSetupErrorInvalidKey: "Invalid key. Get a new key from Qooti → Settings → Extension Connection.",
    popupSetupErrorCouldNotReach: "Could not reach Qooti. Is the desktop app running?",
    popupSetupErrorDesktopNotRunning: "Qooti desktop is not running or not reachable.",
  },
  uz: {
    popupTitle: "Qooti",
    popupSetupLabel: "Qooti ulanish kalitini kiriting",
    placeholderConnectionKey: "Qooti → Sozlamalar → Kengaytma ulanishidan kalitni joylashtiring",
    popupSetupHint: "Kalitni ish stoli ilovasidan oling: Sozlamalar → Kengaytma ulanishi",
    popupSaveAndConnect: "Saqlash va ulash",
    popupConnectionStatus: "Ulanish holati",
    popupChecking: "Tekshirilmoqda…",
    popupNotConnected: "Ulanmagan",
    popupEnterKeyAbove: "Ulanish kalitini yuqoriga kiriting",
    popupConnected: "Ulangan",
    popupLastUsed: "Oxirgi ishlatilgan",
    popupJustNow: "hozir",
    popupMinutesAgo: " daqiya oldin",
    popupHoursAgo: " soat oldin",
    popupConnectionFailed: "Ulash muvaffaqiyatsiz",
    popupInvalidKey: "Kalit notoʻgʻri. Qootidan yangi kalit oling.",
    popupErrorStatus: "Xato",
    popupDesktopNotRunning: "Qooti ish stoli ilovasi ishlamayapti yoki yetib boʻlmayapti.",
    popupLastErrorFromPage: "Sahifadan oxirgi xato",
    popupOpenQooti: "Qootini ochish",
    popupDefaultAction: "Standart harakat",
    popupOptAdd: "Qootiga qoʻshish",
    popupOptDownload: "Yuklab olish va qoʻshish",
    popupOptLink: "Havola sifatida saqlash",
    popupScreenshotHint: "Skrinshot: Ilgʻor sozlamalarda tugma qisqartmasi",
    popupChangeKey: "Kalitni oʻzgartirish",
    popupAdvancedSettings: "Ilgʻor sozlamalar",
    popupSetupErrorEnterKey: "Ulanish kalitini kiriting.",
    popupSetupErrorInvalidKey: "Kalit notoʻgʻri. Qooti → Sozlamalar → Kengaytma ulanishidan yangi kalit oling.",
    popupSetupErrorCouldNotReach: "Qootiga ulanish imkonsiz. Ish stoli ilovasi ishlayaptimi?",
    popupSetupErrorDesktopNotRunning: "Qooti ish stoli ilovasi ishlamayapti yoki yetib boʻlmayapti.",
  },
};

let currentLocale = "en";

function t(key) {
  return (translations[currentLocale] || translations.en)[key] || (translations.en[key]) || key;
}

function applyLanguage(locale) {
  currentLocale = locale || "en";
  const L = translations[currentLocale] || translations.en;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (L[key]) el.textContent = L[key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (L[key]) el.placeholder = L[key];
  });
  document.documentElement.lang = currentLocale === "uz" ? "uz" : "en";
}

const setupBlock = document.getElementById("setupBlock");
const mainBlock = document.getElementById("mainBlock");
const connectionKeyInput = document.getElementById("connectionKeyInput");
const setupError = document.getElementById("setupError");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const statusDot = document.getElementById("statusDot");
const statusLabel = document.getElementById("statusLabel");
const statusSublabel = document.getElementById("statusSublabel");
const lastErrorBlock = document.getElementById("lastErrorBlock");
const lastErrorText = document.getElementById("lastErrorText");
const openQootiBtn = document.getElementById("openQootiBtn");
const defaultAction = document.getElementById("defaultAction");
const changeKeyLink = document.getElementById("changeKeyLink");
const advancedLink = document.getElementById("advancedLink");

async function getStored() {
  return chrome.storage.local.get([
    STORAGE_KEYS.CONNECTION_KEY,
    STORAGE_KEYS.DESKTOP_URL,
    STORAGE_KEYS.DEFAULT_ACTION,
  ]);
}

function showSetup() {
  setupBlock.classList.remove("hidden");
  mainBlock.classList.add("hidden");
}

function showMain() {
  setupBlock.classList.add("hidden");
  mainBlock.classList.remove("hidden");
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return t("popupJustNow");
  if (diff < 3600) return `${Math.floor(diff / 60)}${t("popupMinutesAgo")}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}${t("popupHoursAgo")}`;
  return d.toLocaleDateString(currentLocale === "uz" ? "uz" : undefined);
}

async function checkConnection() {
  const base = (await chrome.storage.local.get(STORAGE_KEYS.DESKTOP_URL))[STORAGE_KEYS.DESKTOP_URL] || DEFAULT_DESKTOP_URL;
  const key = (await chrome.storage.local.get(STORAGE_KEYS.CONNECTION_KEY))[STORAGE_KEYS.CONNECTION_KEY];
  if (!key || !key.trim()) {
    statusDot.className = "status-dot disconnected";
    statusLabel.textContent = t("popupNotConnected");
    statusSublabel.textContent = t("popupEnterKeyAbove");
    return;
  }
  try {
    const url = `${base.replace(/\/+$/, "")}/qooti/handshake`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Qooti-Key": key.trim(),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      statusDot.className = "status-dot connected";
      statusLabel.textContent = t("popupConnected");
      const data = await res.json().catch(() => ({}));
      statusSublabel.textContent = data.lastConnection ? `${t("popupLastUsed")} ${formatTime(data.lastConnection)}` : "";
    } else {
      statusDot.className = "status-dot error";
      statusLabel.textContent = t("popupConnectionFailed");
      statusSublabel.textContent = res.status === 401 ? t("popupInvalidKey") : `${t("popupErrorStatus")} ${res.status}`;
    }
  } catch (e) {
    statusDot.className = "status-dot disconnected";
    statusLabel.textContent = t("popupNotConnected");
    statusSublabel.textContent = t("popupDesktopNotRunning");
  }
  await showLastExtensionError();
}

async function showLastExtensionError() {
  const o = await chrome.storage.local.get([
    STORAGE_KEYS.LAST_EXTENSION_ERROR,
    STORAGE_KEYS.LAST_EXTENSION_ERROR_TIME,
  ]);
  const err = o[STORAGE_KEYS.LAST_EXTENSION_ERROR];
  const ts = o[STORAGE_KEYS.LAST_EXTENSION_ERROR_TIME];
  if (err && ts && Date.now() - ts < LAST_ERROR_MAX_AGE_MS) {
    lastErrorText.textContent = err;
    lastErrorBlock.classList.remove("hidden");
  } else {
    lastErrorBlock.classList.add("hidden");
  }
}


saveKeyBtn.addEventListener("click", async () => {
  const key = (connectionKeyInput.value || "").trim();
  setupError.classList.add("hidden");
  if (!key) {
    setupError.textContent = t("popupSetupErrorEnterKey");
    setupError.classList.remove("hidden");
    return;
  }
  const base = (await chrome.storage.local.get(STORAGE_KEYS.DESKTOP_URL))[STORAGE_KEYS.DESKTOP_URL] || DEFAULT_DESKTOP_URL;
  try {
    const url = `${base.replace(/\/+$/, "")}/qooti/handshake`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Qooti-Key": key },
      body: "{}",
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401) {
      setupError.textContent = t("popupSetupErrorInvalidKey");
      setupError.classList.remove("hidden");
      return;
    }
    if (!res.ok) {
      setupError.textContent = t("popupSetupErrorCouldNotReach");
      setupError.classList.remove("hidden");
      return;
    }
  } catch (e) {
    setupError.textContent = t("popupSetupErrorDesktopNotRunning");
    setupError.classList.remove("hidden");
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.CONNECTION_KEY]: key });
  connectionKeyInput.value = "";
  showMain();
  await checkConnection();
});

changeKeyLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.storage.local.remove(STORAGE_KEYS.CONNECTION_KEY, () => {
    showSetup();
    connectionKeyInput.value = "";
    setupError.classList.add("hidden");
  });
});

// Open Qooti: use current active tab (no new tab) and let OS handle qooti:// protocol
openQootiBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const active = tabs && tabs[0];
    if (active && active.id != null) {
      chrome.tabs.update(active.id, { url: "qooti://open" }, () => {
        if (chrome.runtime.lastError) {
          window.location.href = "qooti://open";
        }
      });
    } else {
      window.location.href = "qooti://open";
    }
  });
});

defaultAction.addEventListener("change", async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.DEFAULT_ACTION]: defaultAction.value });
});

advancedLink.href = chrome.runtime.getURL("options.html");
advancedLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

(async () => {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.CONNECTION_KEY,
    STORAGE_KEYS.DESKTOP_URL,
    STORAGE_KEYS.DEFAULT_ACTION,
    STORAGE_KEYS.LANGUAGE,
  ]);
  currentLocale = stored[STORAGE_KEYS.LANGUAGE] || "en";
  applyLanguage(currentLocale);

  const hasKey = !!(stored[STORAGE_KEYS.CONNECTION_KEY] || "").trim();
  if (!hasKey) {
    showSetup();
    return;
  }
  showMain();
  if (stored[STORAGE_KEYS.DEFAULT_ACTION]) {
    defaultAction.value = stored[STORAGE_KEYS.DEFAULT_ACTION];
  }
  await checkConnection();
  await showLastExtensionError();
})();
