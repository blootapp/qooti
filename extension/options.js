const STORAGE_KEYS = {
  DISPLAY_MODE: "displayMode",
  POPUP_POSITION: "popupPosition",
  DESKTOP_URL: "desktopUrl",
  CONNECTION_KEY: "connectionKey",
  LANGUAGE: "language",
};

const DEFAULT_DESKTOP_URL = "http://127.0.0.1:1420";

const translations = {
  en: {
    title: "Qooti",
    languageLabel: "Language",
    sectionDisplay: "Add button display",
    labelDisplayMode: "When to show “Add to Qooti”",
    optBoth: "Hover overlay + Context menu",
    optHover: "Hover overlay only",
    optContext: "Context menu only",
    hintDisplayMode: "Phase 1 only context menu is active; hover overlay comes in Phase 2.",
    labelPopupPosition: "Popup position",
    optTopRight: "Top right",
    optTopLeft: "Top left",
    optBottomRight: "Bottom right",
    optBottomLeft: "Bottom left",
    hintPopupPosition: "Which corner of the media the add-button popup appears in.",
    sectionDesktop: "Desktop app",
    labelDesktopUrl: "Qooti desktop URL",
    hintDesktopUrl: "The extension sends media to this address. Desktop app must be running.",
    labelConnectionKey: "Connection key",
    placeholderConnectionKey: "Paste key from Qooti → Settings → Extension Connection",
    hintConnectionKey: "Required for secure pairing. Clear and re-enter to use a new key after regenerating in Qooti.",
    save: "Save",
    saved: "Saved.",
  },
  uz: {
    title: "Qooti",
    languageLabel: "Til",
    sectionDisplay: "Qoʻshish tugmasi",
    labelDisplayMode: "“Qootiga qoʻshish” qachon koʻrinsin",
    optBoth: "Hover overlay + Kontekst menyu",
    optHover: "Faqat hover overlay",
    optContext: "Faqat kontekst menyu",
    hintDisplayMode: "1-bosqichda faqat kontekst menyu ishlaydi; hover overlay 2-bosqichda qoʻshiladi.",
    labelPopupPosition: "Popap joylashuvi",
    optTopRight: "Yuqori oʻng",
    optTopLeft: "Yuqori chap",
    optBottomRight: "Pastki oʻng",
    optBottomLeft: "Pastki chap",
    hintPopupPosition: "Media qaysi burchagida qoʻshish tugmasi popapi koʻrinsin.",
    sectionDesktop: "Ish stoli ilovasi",
    labelDesktopUrl: "Qooti desktop URL",
    hintDesktopUrl: "Kengaytma media manzilini shu adresga yuboradi. Ish stoli ilovasi ishlab turishi kerak.",
    labelConnectionKey: "Ulanish kaliti",
    placeholderConnectionKey: "Qooti → Sozlamalar → Kengaytma ulanishidan kalitni joylashtiring",
    hintConnectionKey: "Xavfsiz juftlash uchun kerak. Qootida kalitni yangilagach, tozalab qayta kiriting.",
    save: "Saqlash",
    saved: "Saqlandi.",
  },
};

function applyLanguage(locale) {
  const t = translations[locale] || translations.en;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (t[key]) el.textContent = t[key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (t[key]) el.placeholder = t[key];
  });
  document.documentElement.lang = locale === "uz" ? "uz" : "en";
}

document.getElementById("displayMode").addEventListener("change", save);
document.getElementById("popupPosition").addEventListener("change", save);
document.getElementById("desktopUrl").addEventListener("change", save);
document.getElementById("connectionKey").addEventListener("change", save);
document.getElementById("language").addEventListener("change", onLanguageChange);
document.getElementById("save").addEventListener("click", save);

async function onLanguageChange() {
  const language = document.getElementById("language").value;
  await chrome.storage.local.set({ [STORAGE_KEYS.LANGUAGE]: language });
  applyLanguage(language);
}

async function load() {
  const o = await chrome.storage.local.get([
    STORAGE_KEYS.DISPLAY_MODE,
    STORAGE_KEYS.POPUP_POSITION,
    STORAGE_KEYS.DESKTOP_URL,
    STORAGE_KEYS.CONNECTION_KEY,
    STORAGE_KEYS.LANGUAGE,
  ]);
  document.getElementById("displayMode").value = o[STORAGE_KEYS.DISPLAY_MODE] || "both";
  document.getElementById("popupPosition").value = o[STORAGE_KEYS.POPUP_POSITION] || "top-left";
  document.getElementById("desktopUrl").value = o[STORAGE_KEYS.DESKTOP_URL] || DEFAULT_DESKTOP_URL;
  document.getElementById("connectionKey").value = o[STORAGE_KEYS.CONNECTION_KEY] || "";
  document.getElementById("language").value = o[STORAGE_KEYS.LANGUAGE] || "en";
  applyLanguage(o[STORAGE_KEYS.LANGUAGE] || "en");
}

async function save() {
  const displayMode = document.getElementById("displayMode").value;
  const popupPosition = document.getElementById("popupPosition").value;
  const desktopUrl = (document.getElementById("desktopUrl").value || DEFAULT_DESKTOP_URL).trim().replace(/\/+$/, "");
  const connectionKey = (document.getElementById("connectionKey").value || "").trim();
  await chrome.storage.local.set({
    [STORAGE_KEYS.DISPLAY_MODE]: displayMode,
    [STORAGE_KEYS.POPUP_POSITION]: popupPosition,
    [STORAGE_KEYS.DESKTOP_URL]: desktopUrl || DEFAULT_DESKTOP_URL,
    [STORAGE_KEYS.CONNECTION_KEY]: connectionKey,
  });
  const status = document.getElementById("status");
  const locale = document.getElementById("language").value;
  status.textContent = translations[locale]?.saved || "Saved.";
  status.classList.add("saved");
  setTimeout(() => {
    status.textContent = "";
    status.classList.remove("saved");
  }, 2000);
}

load();
