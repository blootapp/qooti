import { notifyNativeWhenHidden } from "./notify.js";
import { t } from "./i18n.js";
import html2canvas from "./vendor/html2canvas.esm.js";
import {
  recordItemEngagement,
  applyPersonalizedHomeOrder,
  shouldPersonalizeHomeGrid,
} from "./behavior-recommendations.js";

// In production exe, __TAURI__ can be injected after the page loads; wait for it before init so titlebar + license work
async function waitForTauriContext(timeoutMs = 15000) {
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
    if (window.__TAURI__ || window.__TAURI_INTERNALS__) return;
  }
}

// Tauri API bridge (when running in Tauri)
async function initTauriApi() {
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
    const { setupTauriApi } = await import("./tauri-api.js");
    setupTauriApi();
  }
}

await waitForTauriContext();
await initTauriApi();
// Retry in case injection happened right after our wait
if (!window.qooti) {
  const tauriRetryMs = 250;
  const tauriRetryMax = 8000;
  let elapsed = 0;
  const retry = () => {
    if (window.qooti) return;
    elapsed += tauriRetryMs;
    if (elapsed > tauriRetryMax) return;
    initTauriApi().then(() => {
      if (!window.qooti) setTimeout(retry, tauriRetryMs);
    });
  };
  setTimeout(retry, 100);
}

const $ = (sel) => document.querySelector(sel);
const DEFAULT_UNSORTED_COLLECTION_ID = "qooti-unsorted-default";

/** Strengthen home-feed recommendations after items are added to a collection (uses tags + type on the item). */
function recordEngagementAfterCollectionAdd(itemOrIds) {
  if (Array.isArray(itemOrIds)) {
    for (const id of itemOrIds) {
      const item = typeof id === "string" ? state.inspirations.find((i) => i.id === id) : id;
      if (item?.id) recordItemEngagement(item, "collection");
    }
    return;
  }
  if (itemOrIds?.id) recordItemEngagement(itemOrIds, "collection");
}

/** Structured UI diagnostics (console.debug — hidden when DevTools default level is Info+). */
function uilog(action, phase, detail = "") {
  if (typeof console?.debug !== "function") return;
  const extra = detail ? ` | ${detail}` : "";
  console.debug(`[ui] action=${action} | phase=${phase}${extra}`);
}

function ocrLog(stage, payload = {}) {
  if (typeof console?.debug !== "function") return;
  const parts = Object.entries(payload)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" | ");
  console.debug(`[ocr] ${stage}${parts ? ` | ${parts}` : ""}`);
}

function ocrWarn(stage, payload = {}) {
  if (typeof console?.warn !== "function") return;
  const parts = Object.entries(payload)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" | ");
  console.warn(`[ocr] ${stage}${parts ? ` | ${parts}` : ""}`);
}

function summarizeOcrError(stage, err) {
  return {
    stage,
    code: `OCR_${String(stage || "unknown").toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`,
    message: String(err?.message || err || "unknown error"),
  };
}

async function finalizeOcrCandidateResult(candidateId, text, failed, stage, errorMeta = null) {
  const rawText = String(text || "");
  const meta = errorMeta && typeof errorMeta === "object" ? errorMeta : {};
  ocrLog("finalize_request", {
    id: candidateId || "",
    failed: !!failed,
    stage: stage || "unknown",
    rawTextLength: rawText.length,
    errorCode: meta.code || "",
  });
  const startedAt = Date.now();
  try {
    const result = await window.qooti?.finalizeOcrIndexResult?.(
      candidateId,
      rawText,
      !!failed,
      stage || "",
      meta.code || "",
      meta.message || ""
    );
    ocrLog("finalize_result", {
      id: candidateId || "",
      failed: !!failed,
      stage: stage || "unknown",
      rawTextLength: rawText.length,
      elapsedMs: Date.now() - startedAt,
      result: !!result,
    });
    return result;
  } catch (err) {
    const summary = summarizeOcrError(`finalize_${stage || "unknown"}`, err);
    ocrWarn("finalize_failed", {
      id: candidateId || "",
      failed: !!failed,
      stage: stage || "unknown",
      rawTextLength: rawText.length,
      elapsedMs: Date.now() - startedAt,
      ...summary,
    });
    throw err;
  }
}

function summarizeOcrAssetConfig(config) {
  if (!config) return null;
  return {
    source: config.source || "unknown",
    preferMainThread: !!config.preferMainThread,
    workerUrl: config.workerUrl || "",
    engineUrl: config.engineUrl || "",
    ortScriptUrl: config.ortScriptUrl || "",
    detectionPath: config.detectionPath || "",
    recognitionPath: config.recognitionPath || "",
    dictionaryPath: config.dictionaryPath || "",
    ortThreadedMjsUrl: config.ortThreadedMjsUrl || "",
    ortThreadedWasmUrl: config.ortThreadedWasmUrl || "",
    workerCrossOrigin: isCrossOriginWorkerUrl(config.workerUrl),
  };
}
if (typeof console?.debug === "function") {
  console.debug("[ui] lifecycle_logging | hint=enable_verbose_in_devtools_for_uilog");
}

function loadableUrl(absPath, relPath) {
  if (!absPath && !relPath) return "";
  return window.qooti?.toLoadableUrl ? window.qooti.toLoadableUrl(absPath, relPath) : (absPath || relPath || "");
}

const __vaultImageDataUrlCache = new Map();

function looksExtensionlessVaultPath(pathLike) {
  const text = String(pathLike || "");
  if (!text) return false;
  const clean = text.split("#")[0].split("?")[0];
  const base = clean.split(/[\\/]/).pop() || "";
  if (!base) return false;
  return !base.includes(".");
}

function chooseVaultImagePath(item, preferThumb = false) {
  const absPath = preferThumb
    ? (item?.thumbnail_path_abs || item?.stored_path_abs || "")
    : (item?.stored_path_abs || item?.thumbnail_path_abs || "");
  const relPath = preferThumb
    ? (item?.thumbnail_path || item?.stored_path || "")
    : (item?.stored_path || item?.thumbnail_path || "");
  const urlPath = preferThumb
    ? (item?.thumbnail_path_url || item?.stored_path_url || "")
    : (item?.stored_path_url || item?.thumbnail_path_url || "");
  return { absPath, relPath, urlPath };
}

async function readVaultImageDataUrlCached(absPath) {
  if (!absPath || typeof window.qooti?.readImageAsBase64 !== "function") return "";
  if (__vaultImageDataUrlCache.has(absPath)) {
    return __vaultImageDataUrlCache.get(absPath);
  }
  const p = Promise.resolve(window.qooti.readImageAsBase64(absPath))
    .catch(() => "")
    .then((v) => (typeof v === "string" && v.startsWith("data:image/") ? v : ""));
  __vaultImageDataUrlCache.set(absPath, p);
  return p;
}

function wireVaultImageFallback(imgEl, item, preferThumb = false) {
  if (!imgEl || !item) return;
  const { absPath, relPath, urlPath } = chooseVaultImagePath(item, preferThumb);
  if (!absPath && !relPath && !urlPath) return;
  const initialUrl = loadableUrl(urlPath, relPath);
  console.log("[IMG DEBUG] about to set src:", {
    value: initialUrl || "",
    type: typeof initialUrl,
    item_id: item?.id,
    stored_path: item?.stored_path,
    stored_path_url: item?.stored_path_url,
    stored_path_abs: item?.stored_path_abs,
    thumbnail_path: item?.thumbnail_path,
    thumbnail_path_url: item?.thumbnail_path_url,
    thumbnail_path_abs: item?.thumbnail_path_abs,
    vault_id: item?.vault_id,
    mime_type: item?.mime_type,
    original_filename: item?.original_filename,
  });
  if (initialUrl) {
    imgEl.src = initialUrl;
  }

  const shouldPreferDataUrl = looksExtensionlessVaultPath(absPath || relPath);
  if (shouldPreferDataUrl) {
    readVaultImageDataUrlCached(absPath).then((dataUrl) => {
      if (!dataUrl) return;
      imgEl.src = dataUrl;
    });
  }

  if (!absPath || typeof window.qooti?.readImageAsBase64 !== "function") return;
  let attempted = false;
  imgEl.addEventListener("error", async () => {
    if (attempted) return;
    attempted = true;
    try {
      const dataUrl = await readVaultImageDataUrlCached(absPath);
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
        imgEl.src = dataUrl;
      }
    } catch (_) {}
  });
}

const state = {
  view: "all", // all | collection:<id>
  query: "",
  colorFilter: null, // null | { r, g, b } 0-255
  selectedTagId: "", // "" = All, or tag id for filter bar
  sortByRecent: false, // UI: "Recent" pill active; same feed order as API (newest first). Shuffle is menu-only.
  inspirations: [],
  collections: [],
  notifications: [],
  selected: new Set(),
  settings: {},
  prevViewBeforeSettings: null, // Restore when closing settings
  inspirationsHasMore: false,
  inspirationsLoadingMore: false,
};

const GRID_INITIAL_LIMIT = 56;
const GRID_LOAD_MORE_LIMIT = 56;
/** Matches SQLite clamp in list_inspirations — used to load an entire collection in pages. */
const LIST_INSPIRATIONS_MAX_LIMIT = 500;
const SHORT_FORM_AUTOFILL_MAX_EXTRA_PAGES = 16;
const GLOBAL_LOADING_MIN_VISIBLE_MS = 2000;
const GLOBAL_LOADING_FINISH_MS = 220;

const globalLoadingUi = {
  activeCount: 0,
  visibleSince: 0,
  hideTimer: null,
  progressTimer: null,
  progress: 0,
};

function getGlobalLoadingBarElements() {
  return {
    bar: document.getElementById("globalLoadingBar"),
    fill: document.getElementById("globalLoadingBarFill"),
  };
}

function setGlobalLoadingProgress(progress) {
  const { fill } = getGlobalLoadingBarElements();
  if (!fill) return;
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  fill.style.setProperty("--global-loading-progress", String(clamped));
}

function startGlobalLoadingProgressLoop() {
  if (globalLoadingUi.progressTimer) return;
  globalLoadingUi.progressTimer = setInterval(() => {
    // Keep moving, but never hit 100% until work is done.
    globalLoadingUi.progress = Math.min(0.92, globalLoadingUi.progress + Math.max(0.01, (0.92 - globalLoadingUi.progress) * 0.14));
    setGlobalLoadingProgress(globalLoadingUi.progress);
  }, 120);
}

function stopGlobalLoadingProgressLoop() {
  if (globalLoadingUi.progressTimer) {
    clearInterval(globalLoadingUi.progressTimer);
    globalLoadingUi.progressTimer = null;
  }
}

function showGlobalLoadingBar() {
  const { bar } = getGlobalLoadingBarElements();
  if (!bar) return;
  if (globalLoadingUi.hideTimer) {
    clearTimeout(globalLoadingUi.hideTimer);
    globalLoadingUi.hideTimer = null;
  }
  globalLoadingUi.visibleSince = Date.now();
  globalLoadingUi.progress = 0.08;
  setGlobalLoadingProgress(globalLoadingUi.progress);
  bar.classList.remove("hidden");
  startGlobalLoadingProgressLoop();
}

function hideGlobalLoadingBarWithMinDuration() {
  if (globalLoadingUi.activeCount > 0) return;
  const elapsed = Date.now() - globalLoadingUi.visibleSince;
  const waitMs = Math.max(0, GLOBAL_LOADING_MIN_VISIBLE_MS - elapsed);
  if (globalLoadingUi.hideTimer) clearTimeout(globalLoadingUi.hideTimer);
  globalLoadingUi.hideTimer = setTimeout(() => {
    const { bar } = getGlobalLoadingBarElements();
    stopGlobalLoadingProgressLoop();
    globalLoadingUi.progress = 1;
    setGlobalLoadingProgress(1);
    globalLoadingUi.hideTimer = setTimeout(() => {
      if (globalLoadingUi.activeCount > 0) return;
      bar?.classList.add("hidden");
      globalLoadingUi.progress = 0;
      setGlobalLoadingProgress(0);
      globalLoadingUi.hideTimer = null;
    }, GLOBAL_LOADING_FINISH_MS);
  }, waitMs);
}

function startGlobalLoadingTask() {
  globalLoadingUi.activeCount += 1;
  if (globalLoadingUi.activeCount === 1) {
    showGlobalLoadingBar();
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    globalLoadingUi.activeCount = Math.max(0, globalLoadingUi.activeCount - 1);
    if (globalLoadingUi.activeCount === 0) {
      hideGlobalLoadingBarWithMinDuration();
    }
  };
}
/** Server clamps list_inspirations limit to 500; use max pages for palette backfill. */
const PALETTE_BACKFILL_PAGE_SIZE = 500;
let collectionsPageRows = [];
let storeCollectionsIndex = [];
let storeApplyBannerConfig = null;
let storeCommercialBannerConfig = null;
const storeDownloadStateById = new Map();
let storeProgressUnsub = null;
let storeHeroActiveIndex = 0;
let storeHeroCycleTimer = null;
let storeHeroCycleCount = 0;
let storeHeroRenderState = null;
let storeHideBannersForOnboarding = false;
let openStoreAfterSurvey = false;
let onboardingRecommendedStoreIds = new Set();
let onboardingSessionInstalledStoreIds = new Set();
const STORE_INSTALLED_IDS_KEY = "storeInstalledCollectionIds";
const STORE_INSTALLED_LINKS_KEY = "storeInstalledCollectionLinks";
const ONBOARDING_COMPLETED_KEY = "onboarding_completed";
const CONFETTI_SHOWN_KEY = "confetti_shown";
const STORE_ONBOARDING_CONNECTIVITY_URL = "https://raw.githubusercontent.com/blootapp/qooti-collections/main/index.json";
let notificationsLoading = false;
let notificationReadIds = new Set();
let notificationLastFetchedId = "";
let notificationHasBeenViewed = false;
let notificationLastUnreadCount = 0;

const NOTIFICATION_ICON_BELL = "./assets/icons/remix/bell.svg";
const NOTIFICATION_ICON_BELL_DOT = "./assets/icons/remix/bell-dot.svg";
const NOTIFICATION_STATE_ICON_INFO = "./assets/icons/remix/bell.svg";
const NOTIFICATION_STATE_ICON_SUCCESS = "./assets/icons/remix/checkbox-circle-line.svg";
const NOTIFICATION_STATE_ICON_ERROR = "./assets/icons/remix/close-line.svg";
const NOTIFICATION_CACHE_KEY = "qooti.notifications.cache.v1";
const NOTIFICATION_READ_KEY = "qooti.notifications.read.v1";
const NOTIFICATION_LAST_ID_KEY = "qooti.notifications.lastId.v1";
const TUTORIAL_VIDEOS_CONFIG_PATH = "./assets/tutorial-videos.json";
let tutorialVideosConfigPromise = null;
const OCR_INDEX_CONCURRENCY = 1;
const OCR_INDEX_CLAIM_BATCH = 2;
const OCR_INDEX_YIELD_MS = 20;
const OCR_DETECT_TIMEOUT_MS = 45000;
let ocrWorkerPromise = null;
let ocrIndexRunning = false;
let ocrIndexRerunRequested = false;
const STARTUP_DIAGNOSTICS_ENABLED = true;
let startupDeferredTasksScheduled = false;
let ocrIndexSessionPaused = false;
let ocrIndicatorDismissed = false;
let vaultImageDiagLogged = false;
let ocrIndexStats = { total: 0, done: 0, no_text: 0, processing: 0, pending: 0 };
let ocrRunInitialTotal = 0;
let _ocrAutoIndexTimer = null;
const OCR_AUTO_INDEX_DELAY_MS = 2500;
const collectionLabelCache = new Map();
const collectionLabelPending = new Set();
let updaterUiState = {
  phase: "idle",
  source: "startup",
  hidden: true,
  currentVersion: null,
  availableVersion: null,
  progressPercent: 0,
  statusText: "",
  detailText: "",
  error: null,
  lastTransitionAt: null,
};
let updaterToastKey = "";
let simulateUpdateOnNextManualCheck = false;
const downloadIndicatorState = {
  active: false,
  label: "Downloading video…",
  percent: 0,
  /** "video" = yt-dlp download with progress + pause/cancel; "generic" = adding files / thumbnail (no controls). */
  mode: "generic",
  paused: false,
};
let bottomCenterToastVisible = false;

function startupDiag(stage, details = {}) {
  if (!STARTUP_DIAGNOSTICS_ENABLED) return;
  const elapsed = Number(performance.now()).toFixed(1);
  try {
    console.info("[qooti][startup-diag]", stage, { elapsed_ms: elapsed, ...details });
  } catch (_) {}
}

function isUpdateIndicatorActive(detail = updaterUiState) {
  const phase = detail?.phase || "idle";
  const phasesThatUseBottomIndicator = new Set([
    "downloading",
    "installing",
    "downloaded_ready_to_install",
    "restart_required",
    "restarting",
  ]);
  return !detail?.hidden && phasesThatUseBottomIndicator.has(phase);
}

function isOcrIndicatorActive() {
  const remaining = getOcrBacklogCount();
  const total = Math.max(0, ocrRunInitialTotal, remaining);
  return !ocrIndicatorDismissed
    && total > 0
    && (ocrIndexRunning || remaining > 0 || Number(ocrIndexStats.processing || 0) > 0);
}

function getPreferredBottomCenterIndicator() {
  if (isUpdateIndicatorActive()) return "update";
  if (downloadIndicatorState.active) return "download";
  if (isOcrIndicatorActive()) return "ocr";
  return null;
}

function shouldRenderBottomCenterIndicator(kind) {
  return !bottomCenterToastVisible && getPreferredBottomCenterIndicator() === kind;
}

function syncBottomCenterIndicators() {
  renderDownloadIndicator();
  renderUpdateIndicator(updaterUiState);
  updateOcrIndexIndicator();
}

function scheduleOcrAutoIndex() {
  if (_ocrAutoIndexTimer) clearTimeout(_ocrAutoIndexTimer);
  // Hiding the OCR pill should only dismiss the current view, not suppress future batches.
  ocrIndicatorDismissed = false;
  _ocrAutoIndexTimer = setTimeout(() => {
    _ocrAutoIndexTimer = null;
    ocrIndexSessionPaused = false;
    runOcrIndexLoop();
  }, OCR_AUTO_INDEX_DELAY_MS);
}

function getOcrBacklogCount(stats = ocrIndexStats) {
  return Math.max(0, Number(stats.pending || 0) + Number(stats.processing || 0));
}

function maybeScheduleOcrForItemType(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "image" || normalized === "link") {
    scheduleOcrAutoIndex();
  }
}

function setText(el, text) {
  if (el) el.textContent = text == null ? "" : String(text);
}

function updateOcrIndexIndicator() {
  const el = $("#ocrTaskIndicator");
  const labelEl = $("#ocrTaskLabel");
  const percentEl = $("#ocrTaskPercent");
  const ringFill = el?.querySelector(".download-indicator__ring-fill");
  if (!el) return;
  const remaining = getOcrBacklogCount();
  if (ocrIndexRunning && remaining > ocrRunInitialTotal) {
    ocrRunInitialTotal = remaining;
  }
  const total = Math.max(0, ocrRunInitialTotal, remaining);
  const processed = total > 0 ? Math.min(total, Math.max(0, total - remaining)) : 0;
  if (!isOcrIndicatorActive() || !shouldRenderBottomCenterIndicator("ocr")) {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    return;
  }
  const pct = Math.max(0, Math.min(100, total > 0 ? Math.round((processed / total) * 100) : 0));
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  el.classList.remove("download-indicator--indeterminate");
  if (ringFill) {
    const circumference = 100;
    const offset = circumference - (pct / 100) * circumference;
    ringFill.style.strokeDasharray = String(circumference);
    ringFill.style.strokeDashoffset = String(offset);
  }
  if (labelEl) {
    const lang = state.settings?.language || "en";
    labelEl.textContent = `${t("ocr.indexingImages", lang)} ${processed}/${total}`;
  }
  if (percentEl) percentEl.textContent = `${pct}%`;
}

async function refreshOcrIndexStats() {
  try {
    if (!window.qooti?.getOcrIndexStats) return;
    const stats = await window.qooti.getOcrIndexStats();
    if (stats && typeof stats === "object") {
      ocrIndexStats = {
        total: Number(stats.total || 0),
        done: Number(stats.done || 0),
        no_text: Number(stats.no_text || 0),
        processing: Number(stats.processing || 0),
        pending: Number(stats.pending || 0),
      };
      updateOcrIndexIndicator();
    }
  } catch (err) {
    console.warn("[OCR INDEX] stats failed:", err?.message || err);
  }
}

let ocrAssetConfigPromise = null;

function getOcrAssetBase() {
  return typeof window !== "undefined" && window.location?.href
    ? new URL("./assets/ocr/", window.location.href).toString()
    : "./assets/ocr/";
}

async function getOcrAssetConfig() {
  if (ocrAssetConfigPromise) return ocrAssetConfigPromise;
  ocrAssetConfigPromise = (async () => {
    let config;
    if (typeof window.qooti?.resolveOcrAssets === "function") {
      config = await window.qooti.resolveOcrAssets();
    } else {
      const base = getOcrAssetBase();
      config = {
        base,
        workerUrl: `${base}ocr-index-worker.js`,
        ortScriptUrl: `${base}ort.wasm.min.js`,
        ortThreadedMjsUrl: `${base}ort-wasm-simd-threaded.mjs`,
        ortThreadedWasmUrl: `${base}ort-wasm-simd-threaded.wasm`,
        ortWasmPathsMap: {
          mjs: `${base}ort-wasm-simd-threaded.mjs`,
          wasm: `${base}ort-wasm-simd-threaded.wasm`,
        },
        engineUrl: `${base}ocr-engine.js`,
        detectionPath: `${base}models/ch_PP-OCRv4_det_infer.onnx`,
        recognitionPath: `${base}models/ch_PP-OCRv4_rec_infer.onnx`,
        dictionaryPath: `${base}models/ppocr_keys_v1.txt`,
        wasmBase: base,
        source: "web-fallback",
        preferMainThread: false,
      };
    }
    ocrLog("asset_config_resolved", summarizeOcrAssetConfig(config));
    return config;
  })();
  return ocrAssetConfigPromise;
}

async function ensureOrtRuntimeLoaded(config) {
  if (self.ort?.env?.wasm) return;
  ocrLog("ort_runtime_loading", {
    source: config?.source || "unknown",
    ortScriptUrl: config?.ortScriptUrl || "",
    ortThreadedMjsUrl: config?.ortThreadedMjsUrl || "",
    ortThreadedWasmUrl: config?.ortThreadedWasmUrl || "",
  });
  const startedAt = Date.now();
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-qooti-ocr-ort="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load ONNX runtime")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = config.ortScriptUrl;
    script.async = true;
    script.dataset.qootiOcrOrt = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load ONNX runtime"));
    document.head.appendChild(script);
  });
  ocrLog("ort_runtime_loaded", {
    source: config?.source || "unknown",
    elapsedMs: Date.now() - startedAt,
  });
  if (self.ort?.env?.wasm && config?.ortWasmPathsMap?.mjs && config?.ortWasmPathsMap?.wasm) {
    self.ort.env.wasm.wasmPaths = {
      mjs: config.ortWasmPathsMap.mjs,
      wasm: config.ortWasmPathsMap.wasm,
    };
    ocrLog("ort_runtime_paths_configured", {
      mjs: config.ortWasmPathsMap.mjs,
      wasm: config.ortWasmPathsMap.wasm,
    });
  }
}

function isCrossOriginWorkerUrl(url) {
  if (!url || typeof location === "undefined" || !location?.href) return false;
  try {
    const resolved = new URL(url, location.href);
    return resolved.origin !== location.origin;
  } catch (_) {
    return false;
  }
}

function isTauriLocalhostOrigin() {
  if (typeof location === "undefined" || !location?.origin) return false;
  return /^https?:\/\/tauri\.localhost(?::\d+)?$/i.test(String(location.origin));
}

function isPackagedOcrRuntime() {
  if (typeof window === "undefined" || !window.__TAURI__) return false;
  const host = String(location?.hostname || "").toLowerCase();
  // tauri dev uses 127.0.0.1/localhost, packaged runtime uses tauri.localhost.
  return host === "tauri.localhost" || host.endsWith(".tauri.localhost");
}

async function resolveOcrCandidateSrc(candidate) {
  if (isPackagedOcrRuntime()) {
    const absPath = String(candidate?.image_path || "").trim();
    if (!absPath) {
      throw new Error("Missing OCR candidate absolute path");
    }
    if (typeof window.qooti?.readImageAsBase64 !== "function") {
      throw new Error("readImageAsBase64 command is unavailable");
    }
    const dataUrl = await window.qooti.readImageAsBase64(absPath);
    ocrLog("ocr_source_resolved", {
      stage: "ocr_source_resolved",
      source_type: String(dataUrl || "").startsWith("data:") ? "data_url" : "file_url",
      origin: "none",
      taint_risk: false,
      candidate_id: candidate?.id || "",
    });
    return dataUrl;
  }

  const relPath = String(candidate?.image_rel_path || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (relPath && isTauriLocalhostOrigin()) {
    try {
      const src = new URL(`vault/${relPath}`, location.origin).toString();
      ocrLog("candidate_src_selected", {
        id: candidate?.id || "",
        sourceType: "vault-relative",
        relPath,
        srcOrigin: new URL(src, location.href).origin,
        pageOrigin: location.origin,
      });
      return src;
    } catch (_) {
      // Fall through to asset-url fallback.
    }
  }
  const src = window.qooti?.toLoadableUrl
    ? window.qooti.toLoadableUrl(candidate?.image_path, candidate?.image_rel_path || null)
    : (candidate?.image_path || candidate?.image_rel_path || "");
  let srcOrigin = "";
  try {
    srcOrigin = src ? new URL(src, location.href).origin : "";
  } catch (_) {}
  ocrLog("candidate_src_selected", {
    id: candidate?.id || "",
    sourceType: "asset-url",
    relPath,
    srcOrigin,
    pageOrigin: typeof location !== "undefined" ? location.origin : "",
  });
  return src;
}

function shouldFallbackFromWorkerError(message) {
  const text = String(message || "");
  return /image is not defined/i.test(text)
    || /can't find variable:\s*image/i.test(text)
    || /referenceerror:\s*image/i.test(text)
    || /failed to construct 'worker'/i.test(text)
    || /cannot be accessed from origin/i.test(text)
    || /cross-origin/i.test(text)
    || /ocr worker failed to initialize/i.test(text)
    || /ocr worker crashed/i.test(text);
}

async function ensureOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = new Promise((resolve, reject) => {
    getOcrAssetConfig()
      .then((config) => {
        if (isCrossOriginWorkerUrl(config.workerUrl)) {
          throw new Error(`OCR worker bootstrap blocked by cross-origin URL: ${config.workerUrl}`);
        }
        ocrLog("worker_init", {
          source: config?.source || "unknown",
          workerUrl: config?.workerUrl || "",
        });
        const worker = new Worker(config.workerUrl);
        const onReady = (e) => {
          const msg = e?.data || {};
          if (msg?.type === "ready") {
            worker.removeEventListener("message", onReady);
            ocrLog("worker_ready", {
              source: config?.source || "unknown",
              workerUrl: config?.workerUrl || "",
            });
            resolve(worker);
          } else if (msg?.type === "ready-error") {
            worker.removeEventListener("message", onReady);
            reject(new Error(msg?.error || "OCR worker failed to initialize"));
          }
        };
        worker.addEventListener("message", onReady);
        worker.addEventListener("error", (err) => {
          reject(err instanceof Error ? err : new Error("OCR worker crashed"));
        }, { once: true });
        worker.postMessage({ type: "init", config });
      })
      .catch(reject);
  });
  ocrWorkerPromise = ocrWorkerPromise.catch((err) => {
    ocrWorkerPromise = null;
    throw err;
  });
  return ocrWorkerPromise;
}

async function runOcrForCandidate(candidate) {
  if (!candidate?.id || !candidate?.image_path) return;

  let src = "";
  try {
    src = await resolveOcrCandidateSrc(candidate);
  } catch (err) {
    const summary = summarizeOcrError("source_resolve", err);
    await finalizeOcrCandidateResult(candidate.id, "", true, "source_resolve_error", summary);
    ocrWarn("candidate_source_resolve_failed", {
      id: candidate.id,
      ...summary,
    });
    return;
  }
  ocrLog("candidate_start", {
    id: candidate.id,
    hasSrc: !!src,
    src,
  });
  const config = await getOcrAssetConfig();
  if (config?.preferMainThread) {
    ocrLog("ocr_using_main_thread", {
      id: candidate.id,
      source: config.source || "unknown",
    });
    await runBackendOcrForCandidate(candidate);
    return;
  }
  try {
    const worker = await ensureOcrWorker();
    const detectStartedAt = Date.now();
    const text = await new Promise((resolve, reject) => {
      const reqId = `${candidate.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const timeoutId = setTimeout(() => {
        worker.removeEventListener("message", onMsg);
        reject(new Error("OCR worker timed out"));
      }, OCR_DETECT_TIMEOUT_MS);
      const onMsg = (e) => {
        const msg = e?.data || {};
        if (msg?.type !== "detect-result" || msg?.reqId !== reqId) return;
        clearTimeout(timeoutId);
        worker.removeEventListener("message", onMsg);
        if (msg?.error) {
          reject(new Error(msg.error));
          return;
        }
        resolve(String(msg?.text || ""));
      };
      worker.addEventListener("message", onMsg);
      worker.postMessage({ type: "detect", reqId, src });
    });
    ocrLog("candidate_worker_detect_done", {
      id: candidate.id,
      elapsedMs: Date.now() - detectStartedAt,
      textLength: String(text || "").length,
    });
    await finalizeOcrCandidateResult(candidate.id, text, false, "worker_success");
    ocrLog("candidate_worker_done", {
      id: candidate.id,
      textLength: String(text || "").length,
    });
  } catch (err) {
    const errMsg = String(err?.message || err || "");
    if (shouldFallbackFromWorkerError(errMsg)) {
      ocrWarn("worker_failed_fallback_main_thread", {
        id: candidate.id,
        error: errMsg,
      });
      await runBackendOcrForCandidate(candidate);
      return;
    }
    const summary = summarizeOcrError("worker", err);
    await finalizeOcrCandidateResult(candidate.id, "", true, "worker_error", summary);
    console.error("[OCR INDEX] candidate_failed", {
      id: candidate.id,
      error: err,
      ...summary,
    });
    const code = summary?.code ? ` (${summary.code})` : "";
    toast(`OCR failed for one image${code}: ${errMsg || "recognizer unavailable"}`, { variant: "warning" });
  }
}

let mainThreadOcrPromise = null;

function ensureMainThreadOcr() {
  if (mainThreadOcrPromise) return mainThreadOcrPromise;
  mainThreadOcrPromise = (async () => {
    const startedAt = Date.now();
    const config = await getOcrAssetConfig();
    ocrLog("main_thread_init", summarizeOcrAssetConfig(config));
    await ensureOrtRuntimeLoaded(config);
    if (self.ort?.env?.wasm) {
      if (config?.ortWasmPathsMap?.mjs && config?.ortWasmPathsMap?.wasm) {
        self.ort.env.wasm.wasmPaths = {
          mjs: config.ortWasmPathsMap.mjs,
          wasm: config.ortWasmPathsMap.wasm,
        };
      } else {
        self.ort.env.wasm.wasmPaths = config.wasmBase;
      }
    }
    const importStartedAt = Date.now();
    const mod = await import(config.engineUrl);
    ocrLog("engine_imported", {
      source: config?.source || "unknown",
      engineUrl: config?.engineUrl || "",
      elapsedMs: Date.now() - importStartedAt,
    });
    const Ocr = mod?.default || mod;
    if (!Ocr || typeof Ocr.create !== "function") {
      throw new Error("OCR engine missing Ocr.create export");
    }
    const createStartedAt = Date.now();
    const ocr = await Ocr.create({
      models: {
        detectionPath: config.detectionPath,
        recognitionPath: config.recognitionPath,
        dictionaryPath: config.dictionaryPath,
      },
    });
    ocrLog("engine_created", {
      source: config?.source || "unknown",
      elapsedMs: Date.now() - createStartedAt,
      totalInitMs: Date.now() - startedAt,
    });
    return ocr;
  })();
  return mainThreadOcrPromise;
}

async function runBackendOcrForCandidate(candidate) {
  let src = "";
  try {
    src = await resolveOcrCandidateSrc(candidate);
  } catch (err) {
    const summary = summarizeOcrError("source_resolve", err);
    await finalizeOcrCandidateResult(candidate?.id || "", "", true, "source_resolve_error", summary);
    ocrWarn("candidate_source_resolve_failed", {
      id: candidate?.id || "",
      ...summary,
    });
    return;
  }
  ocrLog("candidate_main_thread_attempt", {
    id: candidate?.id || "",
    hasSrc: !!src,
    src,
  });

  // Primary: run PaddleOCR on the main thread (Image API is available here).
  try {
    const ocr = await ensureMainThreadOcr();
    const detectStartedAt = Date.now();
    const lines = await ocr.detect(src);
    const text = Array.isArray(lines)
      ? lines.map((line) => line?.text || "").filter(Boolean).join(" ")
      : "";
    ocrLog("candidate_main_thread_detect_done", {
      id: candidate.id,
      elapsedMs: Date.now() - detectStartedAt,
      textLength: text.length,
      lineCount: Array.isArray(lines) ? lines.length : 0,
    });
    await finalizeOcrCandidateResult(candidate.id, text, false, "main_thread_success");
    ocrLog("candidate_main_thread_done", {
      id: candidate.id,
      textLength: text.length,
      lineCount: Array.isArray(lines) ? lines.length : 0,
    });
    return;
  } catch (e) {
    const summary = summarizeOcrError("main_thread_detect", e);
    ocrWarn("main_thread_failed", {
      id: candidate?.id || "",
      error: e?.message || e,
      ...summary,
    });
    await finalizeOcrCandidateResult(candidate.id, "", true, "main_thread_error", summary);
    ocrWarn("candidate_marked_no_text_main_thread_only", {
      id: candidate?.id || "",
      errorCode: summary.code,
    });
    return;
  }

  await finalizeOcrCandidateResult(candidate.id, "", true, "main_thread_error");
  ocrWarn("candidate_marked_no_text_main_thread_only", { id: candidate?.id || "" });
}

async function runOcrIndexLoop() {
  if (ocrIndexRunning) {
    ocrIndexRerunRequested = true;
    return;
  }
  if (!window.qooti?.claimOcrIndexCandidates || !window.qooti?.finalizeOcrIndexResult) return;
  ocrIndexRunning = true;
  ocrIndicatorDismissed = false;
  updateOcrIndexIndicator();
  try {
    await refreshOcrIndexStats();
    ocrRunInitialTotal = Math.max(0, Number(ocrIndexStats.pending || 0) + Number(ocrIndexStats.processing || 0));
    ocrLog("loop_started", {
      initialPending: Number(ocrIndexStats.pending || 0),
      initialProcessing: Number(ocrIndexStats.processing || 0),
      initialDone: Number(ocrIndexStats.done || 0),
      initialNoText: Number(ocrIndexStats.no_text || 0),
    });
    updateOcrIndexIndicator();
    while (!ocrIndexSessionPaused) {
      const batch = await window.qooti.claimOcrIndexCandidates(Math.max(OCR_INDEX_CLAIM_BATCH, OCR_INDEX_CONCURRENCY));
      const candidates = Array.isArray(batch) ? batch : [];
      ocrLog("loop_batch_claimed", {
        size: candidates.length,
        ids: candidates.map((candidate) => candidate?.id).filter(Boolean),
      });
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        if (ocrIndexSessionPaused) break;
        await runOcrForCandidate(candidate);
        // Keep the UI responsive while indexing continuously.
        await new Promise((resolve) => setTimeout(resolve, OCR_INDEX_YIELD_MS));
      }
      await refreshOcrIndexStats();
    }
  } catch (err) {
    ocrWarn("loop_failed", { error: err?.message || err });
  } finally {
    ocrIndexRunning = false;
    await refreshOcrIndexStats();
    ocrLog("loop_finished", {
      pending: Number(ocrIndexStats.pending || 0),
      processing: Number(ocrIndexStats.processing || 0),
      done: Number(ocrIndexStats.done || 0),
      noText: Number(ocrIndexStats.no_text || 0),
      rerunRequested: ocrIndexRerunRequested,
      paused: ocrIndexSessionPaused,
    });
    if (getOcrBacklogCount() <= 0) {
      if (ocrRunInitialTotal > 0 && ocrIndicatorDismissed) {
        const count = ocrRunInitialTotal;
        toast(`OCR complete for ${count} image${count === 1 ? "" : "s"}.`, { variant: "success" });
      }
      ocrRunInitialTotal = 0;
    }
    if (ocrIndexRerunRequested && !ocrIndexSessionPaused) {
      ocrIndexRerunRequested = false;
      runOcrIndexLoop();
    }
  }
}

// Toast notification — supports Edit + Quick tags for added media
let toastTimer = null;
let toastEditItem = null;
const toastQueue = [];
let toastActive = false;

/** Default quick tags (can be disabled in settings). */
const QUICK_TAGS_DEFAULT = ["ui", "thumbnail", "poster"];

/** Cloudflare D1 database ID for Qooti (text/metadata sync). */
const D1_DATABASE_ID = "45d1a962-341a-4852-954b-5a5dae9a85cc";

function getQuickTags() {
  const s = state.settings;
  const defEnabled = s.quickTagsDefaultEnabled !== "false";
  const custom = (s.quickTagsCustom || "[]");
  let customTags = [];
  try {
    customTags = JSON.parse(custom);
  } catch (_) {}
  const def = defEnabled ? [...QUICK_TAGS_DEFAULT] : [];
  return [...def, ...customTags];
}

async function addQuickTag(item, tagLabel) {
  if (!item?.id || !tagLabel) return;
  if (!window.qooti?.listTags || !window.qooti?.attachTagToInspiration) {
    throw new Error("Tag features not available");
  }
  const full = state.inspirations.find((i) => i.id === item.id) || item;
  const label = String(tagLabel).trim().toLowerCase();
  if (!label) return;
  const existing = (full.tags || []).some((t) => (t.label || "").toLowerCase() === label);
  if (existing) return;

  const all = await window.qooti.listTags();
  let tag = all.find((t) => (t.label || "").toLowerCase() === label);
  if (!tag) {
    tag = await window.qooti.createUserTag(label, "style");
  }
  await window.qooti.attachTagToInspiration(full.id, tag.id);
  full.tags = full.tags || [];
  full.tags.push(tag);
  if (toastEditItem?.id === full.id) toastEditItem.tags = full.tags;
  await refreshData();
  await loadInspirations(false);
}

function toast(text, durationMsOrOpts = 2000) {
  toastQueue.push({ text, durationMsOrOpts });
  if (toastActive) return;
  runToastQueue();
}

function runToastQueue() {
  const next = toastQueue.shift();
  if (!next) {
    toastActive = false;
    return;
  }
  toastActive = true;
  showToastNow(next.text, next.durationMsOrOpts, () => {
    runToastQueue();
  });
}

function showToastNow(text, durationMsOrOpts = 2000, onDone) {
  const el = $("#toast");
  const textEl = el?.querySelector(".toast__text");
  const editBtn = $("#toastEditBtn");
  const expandEl = $("#toastExpand");
  const quickTagsEl = expandEl?.querySelector(".toast__quick-tags");
  if (!el || !textEl) return;

  const opts = typeof durationMsOrOpts === "object" ? durationMsOrOpts : { durationMs: durationMsOrOpts };
  const durationMs = opts.durationMs ?? 2000;
  const persistent = !!opts.persistent;
  const item = opts.item ?? null;
  const variant = opts.variant ?? null; // success | error | warning
  let closed = false;

  textEl.textContent = text == null ? "" : String(text);

  el.classList.remove("toast--success", "toast--error", "toast--warning");
  if (variant) el.classList.add("toast--" + variant);

  const hideToast = () => {
    if (closed) return;
    closed = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    el.classList.remove("visible", "expanded");
    if (expandEl) expandEl.classList.add("hidden");
    if (editBtn) {
      editBtn.classList.add("hidden");
      editBtn.onclick = null;
    }
    toastEditItem = null;
    if (typeof onDone === "function") onDone();
    if (!toastActive && toastQueue.length === 0) {
      bottomCenterToastVisible = false;
      syncBottomCenterIndicators();
    }
  };

  const updateQuickTagStates = () => {
    const it = toastEditItem;
    const existingLabels = new Set((it?.tags || []).map((t) => (t.label || "").toLowerCase()));
    for (const btn of (quickTagsEl?.querySelectorAll(".toast__quick-tag") || [])) {
      const tag = btn.dataset.tag;
      btn.disabled = tag ? existingLabels.has(tag.toLowerCase()) : false;
    }
  };

  if (item && item.id) {
    toastEditItem = item;
    if (editBtn) {
      editBtn.classList.remove("hidden");
      editBtn.onclick = null; // Handled by el.onclick below to avoid bubbling/priority issues
    }
    const showQuickTags = state.settings.showQuickTagsInToast !== "false";
    if (showQuickTags && expandEl && quickTagsEl) {
      expandEl.classList.remove("hidden");
      const tags = getQuickTags();
      quickTagsEl.innerHTML = tags
        .map((t) => `<button type="button" class="toast__quick-tag" data-tag="${t}">${t}</button>`)
        .join("");
      updateQuickTagStates();
      for (const btn of quickTagsEl.querySelectorAll(".toast__quick-tag")) {
        btn.onclick = async (e) => {
          e.stopPropagation();
          if (btn.disabled) return;
          const tag = btn.dataset.tag;
          if (tag && toastEditItem) {
            try {
              await addQuickTag(toastEditItem, tag);
              btn.classList.add("toast__quick-tag--done");
              setTimeout(() => btn.classList.remove("toast__quick-tag--done"), 300);
              updateQuickTagStates();
              toast(`Tagged: ${tag}`, { variant: "success" });
            } catch (err) {
              toast(err?.message || "Could not add tag", { variant: "error" });
            }
          }
        };
      }
    }
  } else {
    toastEditItem = null;
    if (editBtn) {
      editBtn.classList.add("hidden");
      editBtn.onclick = null;
    }
    if (expandEl) expandEl.classList.add("hidden");
  }

  const scheduleHide = () => {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, durationMs);
  };

  let expandHideTimer = null;
  bottomCenterToastVisible = true;
  syncBottomCenterIndicators();
  el.classList.add("visible");
  if (!persistent) scheduleHide();

  // Pause dismiss when hovering; expand on hover/click when item exists
  el.onmouseenter = () => {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    if (expandHideTimer) clearTimeout(expandHideTimer);
    expandHideTimer = null;
    const showQuickTags = state.settings.showQuickTagsInToast !== "false";
    if (item?.id && expandEl && showQuickTags) {
      el.classList.add("expanded");
      expandEl.classList.remove("hidden");
    }
  };
  el.onmouseleave = () => {
    if (!persistent) scheduleHide();
    const showQuickTags = state.settings.showQuickTagsInToast !== "false";
    if (item?.id && expandEl && showQuickTags) {
      expandHideTimer = setTimeout(() => {
        el.classList.remove("expanded");
        expandHideTimer = null;
      }, 150);
    }
  };
  el.onclick = (e) => {
    // Edit button: open edit modal
    if (e.target.closest(".toast__edit")) {
      e.stopPropagation();
      e.preventDefault();
      const it = toastEditItem; // Capture before hideToast clears it
      hideToast();
      if (it) showEditTagsModal(it);
      return;
    }
    // Quick tag: let its own handler run (don't expand)
    if (e.target.closest(".toast__quick-tag")) return;
    const showQuickTags = state.settings.showQuickTagsInToast !== "false";
    if (!item?.id || !expandEl || !showQuickTags) return;
    e.stopPropagation();
    el.classList.add("expanded");
    expandEl.classList.remove("hidden");
    if (expandHideTimer) clearTimeout(expandHideTimer);
    expandHideTimer = null;
  };
  return hideToast;
}
window.__notifyToast = toast;

/** Notify media add: always in-app toast; additionally native system notification when window minimized/hidden. */
async function notifyMediaAdd(msg, opts = {}) {
  toast(msg, opts);
  notifyNativeWhenHidden(msg, opts);
}

// ---- Settings ----

const themeMediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
let themeMediaListenerAttached = false;

function getThemeMode() {
  const m = String(state.settings?.theme || "system").toLowerCase();
  // Light mode is locked for now; treat as system
  if (m === "light") return "system";
  if (m === "dark" || m === "system") return m;
  return "system";
}

function getEffectiveTheme(mode = getThemeMode()) {
  if (mode === "dark" || mode === "light") return mode;
  return themeMediaQuery?.matches ? "dark" : "light";
}

function applyTheme(mode = getThemeMode()) {
  const effective = getEffectiveTheme(mode);
  document.documentElement.dataset.theme = effective;

  if (!themeMediaQuery || themeMediaListenerAttached) return;
  themeMediaListenerAttached = true;

  const onChange = () => {
    if (getThemeMode() === "system") applyTheme("system");
  };

  // WebView2 / older browsers sometimes only support addListener/removeListener
  try {
    themeMediaQuery.addEventListener?.("change", onChange);
  } catch (_) {
    themeMediaQuery.addListener?.(onChange);
  }
}

function applyCardSizing() {
  const useSimple = state.settings?.useSimpleSizeControl !== "false";
  const scale = Number(state.settings?.uiScalePercent || 100);
  const simpleSize = scale <= 95 ? "small" : scale >= 115 ? "large" : "medium";
  const size = String(useSimple ? simpleSize : state.settings?.cardSize || "medium").toLowerCase();
  const normalized = size === "small" || size === "large" ? size : "medium";
  if (normalized === "medium") {
    delete document.documentElement.dataset.cardSize;
  } else {
    document.documentElement.dataset.cardSize = normalized;
  }
}

function applyMediaTitleSizing() {
  const useSimple = state.settings?.useSimpleSizeControl !== "false";
  const scale = Number(state.settings?.uiScalePercent || 100);
  const simpleSize = scale <= 95 ? "small" : scale >= 115 ? "large" : "medium";
  const size = String(useSimple ? simpleSize : state.settings?.mediaTitleSize || "medium").toLowerCase();
  if (size === "small" || size === "large") {
    document.documentElement.dataset.mediaTitleSize = size;
  } else {
    delete document.documentElement.dataset.mediaTitleSize;
  }
}

function applyUiScale() {
  const raw = Number(state.settings?.uiScalePercent || 100);
  const clamped = Number.isFinite(raw) ? Math.max(80, Math.min(130, Math.round(raw / 5) * 5)) : 100;
  document.documentElement.style.setProperty("--ui-scale-factor", String(clamped / 100));
  state.settings.uiScalePercent = String(clamped);
  const valueEl = $("#settingUiScalePercentValue");
  if (valueEl) valueEl.textContent = `${clamped}%`;
  const slider = $("#settingUiScalePercent");
  if (slider) slider.value = String(clamped);
}

function shouldShowTagFilterBar() {
  return state.settings?.enableTagFilters !== "false";
}

function applyTagFilterVisibility() {
  const bar = $("#tagFilterBar");
  if (!bar) return;
  const inCollection = state.view && String(state.view).startsWith("collection:");
  const show = shouldShowTagFilterBar() && !inCollection;
  bar.classList.toggle("hidden", !show);
}

const TAG_FILTER_BAR_PREFS_KEY = "tagFilterBarPrefs";

function parseTagFilterBarPrefs() {
  try {
    const raw = state.settings?.tagFilterBarPrefs || "{}";
    const o = JSON.parse(raw);
    let order =
      o.order === null || o.order === undefined
        ? null
        : Array.isArray(o.order)
          ? o.order.filter((x) => x && String(x).trim())
          : null;
    if (Array.isArray(order) && order.length === 0) order = null;
    return {
      hidden: Array.isArray(o.hidden) ? o.hidden.filter((x) => x && String(x).trim()) : [],
      order,
    };
  } catch {
    return { hidden: [], order: null };
  }
}

async function saveTagFilterBarPrefs(prefs) {
  const payload = {
    hidden: prefs.hidden || [],
    order: prefs.order === undefined ? null : prefs.order,
  };
  const json = JSON.stringify(payload);
  await saveSetting(TAG_FILTER_BAR_PREFS_KEY, json);
}

async function getAutoVisibleTagFilterItems() {
  const prefs = parseTagFilterBarPrefs();
  const hiddenSet = new Set(prefs.hidden);
  let topTags = [];
  try {
    topTags = (await window.qooti?.getTopTags?.(25)) || [];
  } catch {
    topTags = [];
  }
  if (!Array.isArray(topTags)) topTags = [];
  return topTags.filter((t) => t?.id && !hiddenSet.has(t.id));
}

async function hideTagFilterPillFromBar(tagId) {
  if (!tagId) return;
  const prefs = parseTagFilterBarPrefs();
  if (prefs.order !== null && prefs.order.length > 0) {
    prefs.order = prefs.order.filter((id) => id !== tagId);
    if (prefs.order.length === 0) {
      prefs.order = null;
      prefs.hidden = [];
    }
  } else if (!prefs.hidden.includes(tagId)) {
    prefs.hidden.push(tagId);
  }
  if (state.selectedTagId === tagId) {
    state.selectedTagId = "";
    await loadInspirations(false);
  }
  await saveTagFilterBarPrefs(prefs);
  await refreshTagFilterBar();
  void renderTagFilterBarSettings();
}

function showTagFilterPillContextMenu(e, tagId) {
  if (state.settings?.enableContextMenu === "false") return;
  e.preventDefault();
  e.stopPropagation();
  const menu = $("#contextMenu");
  const content = menu?.querySelector(".context-menu__content");
  if (!content || !menu) return;
  content.innerHTML = "";
  menu.classList.add("context-menu--compact");
  const lang = state.settings?.language || "en";
  const row = document.createElement("div");
  row.className = "context-menu__item context-menu__item--single";
  row.innerHTML = `<span class="context-menu__icon" aria-hidden="true">${CTX_ICONS.eyeOff}</span><span class="context-menu__label">${escapeHtml(t("tagFilter.hideFromBar", lang))}</span>`;
  row.addEventListener("click", () => {
    hideContextMenu();
    hideTagFilterPillFromBar(tagId);
  });
  content.appendChild(row);
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

async function renderTagFilterBarSettings() {
  const wrap = $("#settingsTagFilterBarManage");
  const hiddenList = $("#settingsTagFilterBarHiddenList");
  const hiddenSection = $("#settingsTagFilterBarHiddenSection");
  if (!wrap || !hiddenList || !hiddenSection) return;
  wrap.classList.toggle("hidden", state.settings?.enableTagFilters === "false");
  if (state.settings?.enableTagFilters === "false") return;

  const lang = state.settings?.language || "en";
  const prefs = parseTagFilterBarPrefs();
  let allTags = [];
  try {
    allTags = (await window.qooti?.listTags?.()) || [];
  } catch {
    allTags = [];
  }
  if (!Array.isArray(allTags)) allTags = [];
  const byId = new Map(allTags.map((t) => [t.id, t]));

  const hidden = prefs.hidden || [];
  hiddenSection.classList.toggle("hidden", hidden.length === 0);
  hiddenList.innerHTML = hidden
    .map((id) => {
      const tag = byId.get(id);
      const label = tag ? tag.label || tag.id : id;
      return `<div class="settings-tag-filter-hidden-row"><span>${escapeHtml(label)}</span><button type="button" class="btn btn--sm btn--secondary settings-tag-filter-unhide" data-tag-id="${escapeHtml(id)}" data-i18n="settings.tagFilterBarUnhide">${escapeHtml(t("settings.tagFilterBarUnhide", lang))}</button></div>`;
    })
    .join("");

  applyTranslations();
}

async function settingsTagFilterBarAfterPrefsChange() {
  await refreshTagFilterBar();
  await renderTagFilterBarSettings();
}

async function settingsTagFilterBarUnhide(tagId) {
  if (!tagId) return;
  const prefs = parseTagFilterBarPrefs();
  prefs.hidden = prefs.hidden.filter((id) => id !== tagId);
  await saveTagFilterBarPrefs(prefs);
  await settingsTagFilterBarAfterPrefsChange();
}

function syncSizeControlModeUi() {
  const useSimple = state.settings?.useSimpleSizeControl !== "false";
  $("#settingsSimpleSizeControls")?.classList.toggle("hidden", !useSimple);
  $("#settingsAdvancedSizeControls")?.classList.toggle("hidden", useSimple);
}

function syncAutostartStartupOptionsVisibility() {
  const g = $("#autostartModeGroup");
  const launch = $("#settingLaunchAtLogin");
  if (g && launch) g.classList.toggle("hidden", !launch.checked);
}

async function loadSettingsFromBackend() {
  // If the bridge isn't ready yet, don't wipe settings to defaults.
  if (!window.qooti?.getSettings) return false;
  try {
    const s = await window.qooti?.getSettings?.();
    state.settings = s && typeof s === "object" ? s : {};
    return true;
  } catch (e) {
    console.warn("[qooti] loadSettings failed:", e);
    return false;
  }
}

async function waitForQootiApi(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (window.qooti?.getSettings && window.qooti?.setPreference) {
      console.log("[qooti][license] waitForQootiApi: ready after", Date.now() - start, "ms");
      return true;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  console.warn("[qooti][license] waitForQootiApi: timed out after", timeoutMs, "ms");
  return false;
}

function applyTranslations() {
  const lang = getCurrentUiLang();
  document.documentElement.lang = lang === "uz" ? "uz" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (k) el.textContent = t(k, lang);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const k = el.getAttribute("data-i18n-placeholder");
    if (k) el.placeholder = t(k, lang);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const k = el.getAttribute("data-i18n-title");
    if (k) el.title = t(k, lang);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const k = el.getAttribute("data-i18n-aria-label");
    if (k) el.setAttribute("aria-label", t(k, lang));
  });
  // Update language toggle buttons (survey & profile setup) title/aria-label
  document.querySelectorAll(".language-toggle").forEach((el) => {
    el.title = t("language.toggle", lang);
    el.setAttribute("aria-label", t("language.toggle", lang));
  });
  syncLicenseOfflineGateCopy();
  syncStoreOnboardingLanguageUi();
  updateStoreMenuAvailability();
}

function toggleSurveyProfileLanguage() {
  const next = state.settings?.language === "uz" ? "en" : "uz";
  setSurveyProfileLanguage(next);
}

function setSurveyProfileLanguage(next) {
  const normalized = String(next || "").toLowerCase() === "uz" ? "uz" : "en";
  if (state.settings?.language === normalized) {
    closeStoreOnboardingLanguageMenu();
    return;
  }
  state.settings.language = normalized;
  saveSetting("language", normalized).catch(() => {});
  applyTranslations();
  syncStoreOnboardingLanguageUi();
  closeStoreOnboardingLanguageMenu();
  document.dispatchEvent(new CustomEvent("app:languageChanged"));
}

function syncStoreOnboardingLanguageUi() {
  const lang = String(state.settings?.language || "en").toLowerCase() === "uz" ? "uz" : "en";
  const codeEl = $("#storeOnboardingLangCode");
  if (codeEl) codeEl.textContent = lang.toUpperCase();
  document.querySelectorAll("#storeOnboardingLangMenu .store-onboarding-lang-option").forEach((el) => {
    const active = String(el.getAttribute("data-lang") || "").toLowerCase() === lang;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function closeStoreOnboardingLanguageMenu() {
  const menu = $("#storeOnboardingLangMenu");
  const toggle = $("#storeOnboardingLangToggle");
  if (menu) menu.classList.add("hidden");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function toggleStoreOnboardingLanguageMenu() {
  const menu = $("#storeOnboardingLangMenu");
  const toggle = $("#storeOnboardingLangToggle");
  if (!menu || !toggle) return;
  const isOpen = !menu.classList.contains("hidden");
  if (isOpen) {
    closeStoreOnboardingLanguageMenu();
    return;
  }
  syncStoreOnboardingLanguageUi();
  menu.classList.remove("hidden");
  toggle.setAttribute("aria-expanded", "true");
}

function handleStoreOnboardingLanguageSelection(event) {
  const option = event.target.closest(".store-onboarding-lang-option");
  if (!option) return;
  const lang = option.getAttribute("data-lang");
  if (!lang) return;
  setSurveyProfileLanguage(lang);
}

function loadSettingsUI() {
  const s = state.settings;
  const set = (id, val) => {
    const el = $(`#${id}`);
    if (!el) return;
    if (el.type === "checkbox") el.checked = val === "true";
    else if (el.tagName === "SELECT") el.value = val || el.options[0]?.value;
    else if (el.tagName === "INPUT" && el.type === "number") el.value = val || el.getAttribute("value") || "";
    else el.value = val || "";
  };
  set("settingTheme", s.theme === "light" ? "system" : (s.theme || "system"));
  set("settingCardSize", s.cardSize);
  set("settingMediaTitleSize", s.mediaTitleSize);
  set("settingGridDensity", s.gridDensity);
  set("settingShowTitlesOnHover", s.showTitlesOnHover ?? "true");
  set("settingShowSourceLabels", s.showSourceLabels);
  set("settingShowCollectionIndicator", s.showCollectionIndicator ?? "true");
  set("settingEnableTagFilters", s.enableTagFilters ?? "true");
  set("settingUseSimpleSizeControl", s.useSimpleSizeControl ?? "true");
  set("settingUiScalePercent", s.uiScalePercent || "100");
  set("settingShowQuickTagsInToast", s.showQuickTagsInToast);
  set("settingDefaultClickBehavior", s.defaultClickBehavior);
  set("settingEnableContextMenu", s.enableContextMenu);
  set("settingConfirmBeforeDelete", s.confirmBeforeDelete);
  set("settingEnableDragDropImport", s.enableDragDropImport);
  set("settingAutoExtractPalette", s.autoExtractPalette);
  set("settingDownloadQualityMode", s.downloadQualityMode);
  set("settingRelatedStrictness", s.relatedStrictness);
  set("settingRelatedPreferSameOrientation", s.relatedPreferSameOrientation);
  set("settingRelatedPreferSameMediaType", s.relatedPreferSameMediaType);
  set("settingQuickTagsDefaultEnabled", s.quickTagsDefaultEnabled);
  set("settingLanguage", s.language || "en");
  set("settingShowExtensionCollectionPicker", s.extensionShowCollectionPicker ?? "true");
  set("settingLaunchAtLogin", s.launchAtLogin ?? "true");
  const autostartBgOn = (s.autostartBackgroundMode ?? "true") !== "false";
  const rb = $("#settingAutostartModeBackground");
  const rw = $("#settingAutostartModeWindow");
  if (rb && rw) {
    rb.checked = autostartBgOn;
    rw.checked = !autostartBgOn;
  }
  syncAutostartStartupOptionsVisibility();
  updateProfileUi();
  syncSizeControlModeUi();
  applyUiScale();
  applyTranslations();

  const customList = $("#settingQuickTagsCustomList");
  if (customList) {
    let customTags = [];
    try {
      customTags = JSON.parse(s.quickTagsCustom || "[]");
    } catch (_) {}
    customList.innerHTML = customTags
      .map(
        (tag) =>
          `<span class="settings-tag-chip" data-tag="${tag}">${tag}<button type="button" class="settings-tag-chip__remove" data-tag="${tag}" aria-label="Remove">×</button></span>`
      )
      .join("");
  }

  // Data section
  (async () => {
    try {
      const info = await window.qooti?.getAppInfo?.();
      const counts = info?.counts || {};
      const ver = info?.version ?? info?.schemaVersion ?? "—";
      setText($("#settingsAppVersion"), ver);
      setText($("#settingsInspirationsCount"), String(counts.inspirations ?? 0));
      setText($("#settingsCollectionsCount"), String(counts.collections ?? 0));
      const vaultRoot = info?.vaultRoot || "";
      const lang = state.settings?.language || "en";
      setText($("#settingsStorageUsage"), vaultRoot ? t("common.local", lang) : "—");
      renderSettingsUpdateSection({ ...updaterUiState, currentVersion: ver });
    } catch (_) {
      setText($("#settingsAppVersion"), "—");
      setText($("#settingsInspirationsCount"), "—");
      setText($("#settingsCollectionsCount"), "—");
      setText($("#settingsStorageUsage"), "—");
      renderSettingsUpdateSection(updaterUiState);
    }
  })();

  // License section
  (async () => {
    try {
      const lang = state.settings?.language || "en";
      const cache = await window.qooti?.getLicenseCache?.();
      const planEl = $("#settingsLicensePlan");
      const activatedEl = $("#settingsLicenseActivated");
      const expiresEl = $("#settingsLicenseExpires");
      const statusEl = $("#settingsLicenseStatus");
      const statusRow = $("#settingsLicenseStatusRow");
      if (!planEl || !activatedEl || !expiresEl || !statusEl) return;
      if (!cache || (!cache.plan_type && !cache.activated_at && !cache.expires_at)) {
        setText(planEl, "—");
        setText(activatedEl, "—");
        setText(expiresEl, "—");
        setText(statusEl, t("settings.noLicense", lang));
        statusEl.className = "settings-info__value";
        if (statusRow) statusRow.style.display = "";
        return;
      }
      setText(planEl, cache.plan_type ? String(cache.plan_type).charAt(0).toUpperCase() + cache.plan_type.slice(1) : "—");
      const activatedText = cache.activated_at ? formatLicenseDate(cache.activated_at) : "—";
      setText(activatedEl, activatedText);
      const LIFETIME_TS = 253402300799;
      const expiresText = cache.expires_at ? (cache.expires_at >= LIFETIME_TS - 86400 ? t("settings.never", lang) : formatLicenseDate(cache.expires_at)) : "—";
      setText(expiresEl, expiresText);
      setText(statusEl, getLicenseSettingsStatusLabel(cache, lang));
      if (statusEl) statusEl.className = "settings-info__value " + (cache.valid ? "settings-info__value--ok" : "settings-info__value--warn");
      if (statusRow) statusRow.style.display = "";
    } catch (_) {
      setText($("#settingsLicensePlan"), "—");
      setText($("#settingsLicenseActivated"), "—");
      setText($("#settingsLicenseExpires"), "—");
      setText($("#settingsLicenseStatus"), "—");
    }
  })();

  // Connection section
  (async () => {
    try {
      const lang = state.settings?.language || "en";
      const status = await window.qooti?.getExtensionConnectionStatus?.();
      setText($("#extensionStatus"), status?.connected ? t("settings.connected", lang) : t("settings.notConnected", lang));
      setText($("#extensionKeyDisplay"), status?.key_masked || "—");
      const lastEl = $("#extensionLastConnection");
      if (lastEl) {
        if (status?.last_connection_ts) {
          const d = new Date(status.last_connection_ts);
          lastEl.textContent = d.toLocaleString();
        } else {
          lastEl.textContent = "—";
        }
      }
      const keyForCopy = await window.qooti?.getExtensionKeyForCopy?.();
      const mobileCode = String(keyForCopy || "").trim();
      setText($("#settingsMobileCode"), mobileCode || "—");
      const qrEl = $("#settingsMobileQr");
      if (qrEl && mobileCode) {
        qrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(mobileCode)}`;
        qrEl.classList.remove("hidden");
      } else {
        qrEl?.classList.add("hidden");
      }
    } catch (_) {
      setText($("#extensionStatus"), "—");
      setText($("#extensionKeyDisplay"), "—");
      setText($("#extensionLastConnection"), "—");
      setText($("#settingsMobileCode"), "—");
      $("#settingsMobileQr")?.classList.add("hidden");
    }
  })();

  void renderTagFilterBarSettings();
}

function formatLicenseDate(ts) {
  if (!ts || typeof ts !== "number") return "—";
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch (_) {
    return "—";
  }
}

function getLicenseStatusMessage(result, lang = state.settings?.language || "en") {
  const status = String(result?.status || "").toLowerCase();
  if (status === "missing") return "";
  if (status === "revoked") return t("license.revoked", lang);
  if (status === "expired") return t("license.expired", lang);
  if (status === "device_limit") return t("license.deviceLimit", lang);
  if (status === "network_error") return t("license.networkUnavailable", lang);
  // Signature mismatch, bad JSON, or misconfigured client secret — not a generic offline message
  if (status === "activation_error" && result?.error) return result.error;
  return result?.error || t("license.invalid", lang);
}

function getLicenseSettingsStatusLabel(cache, lang = state.settings?.language || "en") {
  const status = String(cache?.status || "").toLowerCase();
  if (cache?.valid) {
    return t("settings.active", lang);
  }
  if (status === "revoked") return t("license.revoked", lang);
  if (status === "expired") return t("license.expired", lang);
  if (status === "device_limit") return t("license.deviceLimit", lang);
  return t("settings.noLicense", lang);
}

function hasInternetConnection() {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

function isTruthySetting(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isOnboardingCompleted() {
  return isTruthySetting(state.settings?.[ONBOARDING_COMPLETED_KEY], true);
}

function hasShownOnboardingConfetti() {
  return isTruthySetting(state.settings?.[CONFETTI_SHOWN_KEY], false);
}

function updateStoreMenuAvailability() {
  const btn = document.getElementById("menuStore");
  if (!btn) return;
  const lang = state.settings?.language || "en";
  btn.disabled = false;
  btn.classList.remove("dropdown__item--disabled");
  btn.setAttribute("aria-disabled", "false");
  btn.title = t("store.title", lang);
}

function handleNetworkAvailabilityChanged() {
  updateStoreMenuAvailability();
  const storeView = document.getElementById("storeView");
  const isStoreVisible = !!storeView && !storeView.classList.contains("hidden");
  if (storeHideBannersForOnboarding && isStoreVisible && !hasInternetConnection()) {
    setStoreOnboardingOfflineGateVisible(true);
  }
}

async function saveSetting(key, value) {
  state.settings[key] = value;
  try {
    if (!window.qooti?.setPreference) {
      await waitForQootiApi(8000);
    }
    await window.qooti?.setPreference?.(key, String(value));
  } catch (e) {
    console.warn("[qooti] saveSetting failed:", e);
  }
}

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeLocalJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function normalizeNotificationItem(raw) {
  const id = String(raw?.id || "").trim();
  if (!id) return null;
  const title = typeof raw?.title === "string" ? raw.title.trim() : "";
  const body = String(raw?.body || raw?.message || "").trim();
  const youtubeUrl = typeof raw?.youtube_url === "string" ? raw.youtube_url.trim() : "";
  const buttonText = typeof raw?.button_text === "string" ? raw.button_text.trim() : "";
  const buttonLink = typeof raw?.button_link === "string" ? raw.button_link.trim() : "";
  const createdAt = Number(raw?.created_at || 0) || 0;
  return {
    id,
    title: title || "",
    body: body || "",
    youtube_url: youtubeUrl || "",
    button_text: buttonText || "",
    button_link: buttonLink || "",
    high_priority: !!raw?.high_priority,
    is_active: raw?.is_active !== false,
    created_at: createdAt,
  };
}

function normalizeNotificationList(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeNotificationItem)
    .filter((n) => n && n.body && n.is_active)
    .slice(0, 5);
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeExternalUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (isHttpUrl(raw)) return raw;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return isHttpUrl(withScheme) ? withScheme : "";
}

async function openExternalLink(url, context = "external-link") {
  const target = normalizeExternalUrl(url);
  if (!target) {
    console.warn(`[qooti] ${context} blocked invalid url`, url);
    return false;
  }
  try {
    if (window.qooti?.openExternalUrl) {
      await window.qooti.openExternalUrl(target);
      console.info(`[qooti] ${context} opened externally via Tauri`, target);
      return true;
    }
  } catch (e) {
    console.warn(`[qooti] ${context} openExternalUrl failed`, e?.message || e);
  }
  try {
    window.open(target, "_blank", "noopener,noreferrer");
    console.info(`[qooti] ${context} opened via window.open`, target);
    return true;
  } catch (e) {
    console.error(`[qooti] ${context} window.open failed`, e?.message || e);
    return false;
  }
}

async function loadTutorialVideosConfig() {
  if (!tutorialVideosConfigPromise) {
    tutorialVideosConfigPromise = fetch(TUTORIAL_VIDEOS_CONFIG_PATH, { cache: "no-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => (json && typeof json === "object" ? json : {}))
      .catch((err) => {
        console.warn("[qooti] tutorial-videos config load failed", err?.message || err);
        return {};
      });
  }
  return tutorialVideosConfigPromise;
}

async function getTutorialVideoUrl(key) {
  const config = await loadTutorialVideosConfig();
  const raw = typeof config?.[key] === "string" ? config[key] : "";
  return normalizeExternalUrl(raw);
}

function persistNotificationState() {
  writeLocalJson(NOTIFICATION_CACHE_KEY, state.notifications.slice(0, 5));
  writeLocalJson(NOTIFICATION_READ_KEY, Array.from(notificationReadIds));
  localStorage.setItem(NOTIFICATION_LAST_ID_KEY, notificationLastFetchedId || "");
}

function hydrateNotificationState() {
  state.notifications = normalizeNotificationList(readLocalJson(NOTIFICATION_CACHE_KEY, []));
  const read = readLocalJson(NOTIFICATION_READ_KEY, []);
  notificationReadIds = new Set((Array.isArray(read) ? read : []).map((v) => String(v || "")));
  notificationLastFetchedId = localStorage.getItem(NOTIFICATION_LAST_ID_KEY) || "";
  const liveIds = new Set(state.notifications.map((n) => n.id));
  notificationReadIds = new Set(Array.from(notificationReadIds).filter((id) => liveIds.has(id)));
}

function unreadNotificationCount() {
  return state.notifications.reduce((acc, n) => acc + (notificationReadIds.has(n.id) ? 0 : 1), 0);
}

function updateNotificationBell() {
  const unread = unreadNotificationCount();
  const icon = $("#btnNotificationsIcon");
  if (icon) {
    // Keep bell icon stable; unread state is represented by the red dot badge.
    icon.style.setProperty("--icon-url", `url('${NOTIFICATION_ICON_BELL}')`);
  }
  const trigger = $("#btnNotifications");
  const badge = $("#btnNotificationsBadge");
  if (trigger) trigger.classList.toggle("notification-trigger--has-unread", unread > 0);
  if (badge) {
    badge.textContent = "";
    badge.classList.toggle("hidden", unread === 0);
    if (unread > notificationLastUnreadCount) {
      badge.classList.remove("notification-trigger__badge--pulse");
      // Reflow to restart animation when a new notification arrives.
      void badge.offsetWidth;
      badge.classList.add("notification-trigger__badge--pulse");
    }
  }
  notificationLastUnreadCount = unread;
}

function markVisibleNotificationsRead() {
  for (const n of state.notifications) notificationReadIds.add(n.id);
  notificationHasBeenViewed = true;
  persistNotificationState();
  updateNotificationBell();
  renderNotificationList();
}

function renderNotificationList() {
  const listEl = $("#notificationList");
  const emptyEl = $("#notificationEmpty");
  const unreadEl = $("#notificationUnreadLabel");
  if (!listEl || !emptyEl) return;

  const lang = state.settings?.language || "en";
  const items = state.notifications.slice(0, 5);
  if (items.length === 0) {
    listEl.innerHTML = "";
    emptyEl.textContent = t("notifications.noNew", lang);
    emptyEl.classList.remove("hidden");
    unreadEl?.classList.add("hidden");
    updateNotificationBell();
    return;
  }

  emptyEl.classList.add("hidden");
  const unread = unreadNotificationCount();
  if (unreadEl) {
    unreadEl.textContent = unread > 0 ? `${unread} ${t("notifications.newWord", lang)}` : "";
    unreadEl.classList.toggle("hidden", unread === 0);
  }

  listEl.innerHTML = "";
  for (const n of items) {
    const unread = !notificationReadIds.has(n.id);
    const tone = n.high_priority ? "error" : unread ? "success" : "info";
    const toneIcon =
      tone === "error"
        ? NOTIFICATION_STATE_ICON_ERROR
        : tone === "success"
          ? NOTIFICATION_STATE_ICON_SUCCESS
          : NOTIFICATION_STATE_ICON_INFO;
    const card = document.createElement("article");
    card.className = `notification-card notification-card--${tone}${unread ? " notification-card--unread" : ""}${n.high_priority ? " notification-card--priority" : ""}`;

    const titleHtml = n.title ? escapeHtml(n.title) : "Qooti update";
    const timeHtml = `<div class="notification-card__time">${n.created_at ? new Date(n.created_at).toLocaleString() : ""}</div>`;
    const bodyHtml = `<div class="notification-card__text-wrap"><div class="notification-card__text">${escapeHtml(n.body)}</div></div>`;
    card.innerHTML = `
      <div class="notification-card__row">
        <div class="notification-card__state">
          <span class="ui-icon notification-card__state-icon" style="--icon-url:url('${toneIcon}')"></span>
        </div>
        <div class="notification-card__content">
          <div class="notification-card__top">
            <div class="notification-card__title">${titleHtml}</div>
            ${timeHtml}
          </div>
          ${bodyHtml}
        </div>
      </div>
    `;

    if (n.youtube_url) {
      const vid = youtubeVideoId(n.youtube_url);
      if (vid) {
        const box = document.createElement("button");
        box.type = "button";
        box.className = "notification-card__video";
        box.innerHTML = `
          <img src="https://i.ytimg.com/vi/${vid}/hqdefault.jpg" alt="Open YouTube video" loading="lazy" />
          <span class="notification-card__video-play" aria-hidden="true"></span>
        `;
        box.addEventListener("click", async (e) => {
          e.stopPropagation();
          const opened = await openExternalLink(`https://www.youtube.com/watch?v=${vid}`, "notification-video");
          if (!opened) console.warn("[qooti] notification-video open failed");
        });
        card.appendChild(box);
      }
    }

    const normalizedButtonLink = normalizeExternalUrl(n.button_link);
    if (n.button_text && normalizedButtonLink) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn--secondary btn--sm notification-card__cta";
      btn.textContent = n.button_text;
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const opened = await openExternalLink(normalizedButtonLink, "notification-button");
        if (!opened) console.warn("[qooti] notification-button open failed", normalizedButtonLink);
      });
      card.appendChild(btn);
    }

    card.addEventListener("click", () => {
      notificationReadIds.add(n.id);
      persistNotificationState();
      updateNotificationBell();
      renderNotificationList();
    });
    listEl.appendChild(card);
  }
}

async function refreshNotificationsOptimized(force = false) {
  if (notificationsLoading || !window.qooti?.listNotifications) return;
  notificationsLoading = true;
  try {
    const latest = await window.qooti.listNotifications({ latestOnly: true });
    const latestId = latest?.[0]?.id ? String(latest[0].id) : "";
    const hasCache = state.notifications.length > 0;
    const unchanged = !!latestId && latestId === notificationLastFetchedId;
    if (!force && unchanged && hasCache) {
      updateNotificationBell();
      renderNotificationList();
      return;
    }
    const rows = await window.qooti.listNotifications({ limit: 5 });
    state.notifications = normalizeNotificationList(rows);
    notificationLastFetchedId = state.notifications[0]?.id || latestId || "";
    const validIds = new Set(state.notifications.map((n) => n.id));
    notificationReadIds = new Set(Array.from(notificationReadIds).filter((id) => validIds.has(id)));
    persistNotificationState();
    renderNotificationList();
    updateNotificationBell();
  } catch (e) {
    console.warn("[qooti] notifications refresh failed:", e?.message || e);
  } finally {
    notificationsLoading = false;
  }
}

function initNotificationsSystem() {
  hydrateNotificationState();
  renderNotificationList();
  updateNotificationBell();
  refreshNotificationsOptimized(false);
}

const PROFILE_NAME_KEY = "profileName";
const PROFILE_IMAGE_KEY = "profileImageDataUrl";

function normalizeProfileName(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function getProfileName() {
  return normalizeProfileName(state.settings?.[PROFILE_NAME_KEY] || "");
}

function getProfileImageDataUrl() {
  const raw = state.settings?.[PROFILE_IMAGE_KEY];
  return typeof raw === "string" ? raw.trim() : "";
}

function profileInitial(name) {
  const n = normalizeProfileName(name);
  return (n[0] || "U").toUpperCase();
}

function profileColorFromName(name) {
  const n = normalizeProfileName(name) || "user";
  let hash = 0;
  for (let i = 0; i < n.length; i++) {
    hash = ((hash << 5) - hash + n.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 54% 46%)`;
}

function renderAvatar(el, { name, imageDataUrl }) {
  if (!el) return;
  el.innerHTML = "";
  const image = typeof imageDataUrl === "string" ? imageDataUrl.trim() : "";
  if (image) {
    const img = document.createElement("img");
    img.src = image;
    img.alt = "";
    el.appendChild(img);
    return;
  }
  const fallback = document.createElement("span");
  fallback.className = "profile-avatar__fallback";
  fallback.style.background = profileColorFromName(name);
  fallback.textContent = profileInitial(name);
  el.appendChild(fallback);
}

function updateProfileUi() {
  const name = getProfileName() || "User";
  const imageDataUrl = getProfileImageDataUrl();
  renderAvatar($("#profileAvatar"), { name, imageDataUrl });
  renderAvatar($("#profileMenuAvatar"), { name, imageDataUrl });
  renderAvatar($("#settingsAccountAvatar"), { name, imageDataUrl });
  setText($("#profileMenuName"), name);
  const displayNameEl = $("#settingsAccountDisplayName");
  if (displayNameEl) {
    displayNameEl.textContent = getProfileName() ? name : "—";
  }
}

function canvasToDataUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not generate cropped image"));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(new Error("Could not read cropped image"));
        reader.readAsDataURL(blob);
      },
      "image/png",
      0.95
    );
  });
}

function showProfileImageCropModal(file) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--crop";
    const objectUrl = URL.createObjectURL(file);
    wrap.innerHTML = `
      <div class="app-modal__backdrop"></div>
      <div class="app-modal__dialog">
        <div class="app-modal__body">
          <div class="app-modal__message">Adjust your profile image</div>
          <div class="profile-cropper">
            <div class="profile-cropper__canvas">
              <img id="profileCropImage" alt="Profile crop source" />
            </div>
            <p class="profile-cropper__hint">Drag corners to resize crop. Drag image to reposition. Use mouse wheel or trackpad to zoom.</p>
          </div>
        </div>
        <div class="app-modal__footer">
          <button type="button" id="profileCropCancel" class="btn app-modal__cancel">Cancel</button>
          <button type="button" id="profileCropApply" class="btn btn--primary">Apply crop</button>
        </div>
      </div>
    `;

    const imageEl = wrap.querySelector("#profileCropImage");
    const applyBtn = wrap.querySelector("#profileCropApply");
    let cropper = null;

    const finish = (result) => {
      try {
        cropper?.destroy();
      } catch (_) {}
      URL.revokeObjectURL(objectUrl);
      wrap.remove();
      resolve(result);
    };

    imageEl.src = objectUrl;
    imageEl.onload = () => {
      const CropperCtor = window.Cropper;
      if (!CropperCtor) {
        console.error("CropperJS is not loaded");
        finish(null);
        return;
      }
      cropper = new CropperCtor(imageEl, {
        aspectRatio: 1,
        viewMode: 0,
        dragMode: "move",
        cropBoxMovable: true,
        cropBoxResizable: true,
        background: false,
        responsive: true,
        autoCropArea: 0.82,
        minCropBoxWidth: 120,
        minCropBoxHeight: 120,
        guides: false,
        center: true,
        highlight: false,
        movable: true,
        zoomable: true,
        zoomOnTouch: true,
        zoomOnWheel: true,
        scalable: false,
        rotatable: false,
      });
    };

    wrap.querySelector("#profileCropCancel").addEventListener("click", () => finish(null));
    wrap.querySelector(".app-modal__backdrop").addEventListener("click", () => finish(null));
    applyBtn.addEventListener("click", async () => {
      if (!cropper) return;
      applyBtn.disabled = true;
      try {
        const canvas = cropper.getCroppedCanvas({
          width: 512,
          height: 512,
          imageSmoothingEnabled: true,
          imageSmoothingQuality: "high",
          fillColor: "#00000000",
        });
        const dataUrl = await canvasToDataUrl(canvas);
        finish(dataUrl);
      } catch (err) {
        console.error("Profile crop error:", err);
        applyBtn.disabled = false;
      }
    });

    document.body.appendChild(wrap);
  });
}

// ---------- Onboarding survey ----------

function surveyLibraryPackageHue(name) {
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

const SURVEY_QUESTIONS = [
  {
    key: "creative_role",
    title: "What kind of creative work do you do most?",
    hint: "Pick the one that feels closest to the work you do most often.",
    selection: "single",
    options: ["Motion Design", "Video Editing", "Graphic Design", "UI / UX Design", "Photography", "Other Creative Work"],
    otherOption: "Other Creative Work",
    detailKey: "creative_role_detail",
    detailPlaceholder: "Tell us what kind of creative work you do",
  },
  {
    key: "primary_use_case",
    title: "What will you mostly use Qooti for?",
    hint: "Choose all the ways you expect to use it.",
    selection: "multiple",
    options: [
      "Collecting visual inspiration",
      "Saving references for projects",
      "Building mood boards",
      "Organizing ideas",
    ],
  },
  {
    key: "inspiration_method",
    title: "Where do your inspirations usually live right now?",
    hint: "Choose every place that sounds familiar.",
    selection: "multiple",
    options: [
      "Pinterest boards",
      "Screenshots",
      "Browser bookmarks",
      "Random download folders",
      "Telegram",
      "Instagram saves",
      "Mostly in my head",
    ],
  },
  {
    key: "discovery_source",
    title: "How did you discover Qooti?",
    hint: "A quick one so we know where people are finding us.",
    selection: "single",
    options: ["Telegram", "Instagram", "YouTube", "Friend / colleague", "Other"],
    otherOption: "Other",
    detailKey: "discovery_source_detail",
    detailPlaceholder: "Tell us where you discovered Qooti",
  },
  {
    key: "creative_level",
    title: "How big of a role does creative work play in your life?",
    hint: "There’s no wrong answer here. Pick the one that feels most true right now.",
    selection: "single",
    options: [
      "It's my full-time profession",
      "I freelance or work with clients sometimes",
      "It's a serious hobby",
      "I'm learning and exploring",
      "Just curious for now",
    ],
  },
];

const SURVEY_ROLE_TO_TAGS = {
  "Motion Design": ["motion_designer", "motion_design"],
  "Video Editing": ["video_editor", "video_editing", "editor"],
  "Graphic Design": ["graphic_designer", "graphic_design", "designer"],
  "UI / UX Design": ["ui_ux_designer", "ui_ux", "uiux", "ui_designer"],
  Photography: ["photographer", "photography"],
  "Other Creative Work": [],
};

/** Option label → SVG for “How did you discover Qooti?” (single-select only). */
const SURVEY_DISCOVERY_BRAND_ICONS = {
  Telegram: "./assets/socialmedia/telegram.svg",
  Instagram: "./assets/socialmedia/instagram.svg",
  YouTube: "./assets/socialmedia/youtube.svg",
  "Friend / colleague": "./assets/socialmedia/users-alt.svg",
  Other: "./assets/socialmedia/circle-ellipsis.svg",
};

function showSurveyView() {
  return new Promise((resolve) => {
    const appEl = document.getElementById("app");
    const view = $("#surveyView");
    const stepsEl = $("#surveySteps");
    const stepEl = view?.querySelector(".survey-view__step");
    const progressEl = $("#surveyProgress");
    const progressFillEl = $("#surveyProgressFill");
    const progressTrackEl = $("#surveyProgressTrack");
    const questionTitleEl = $("#surveyQuestionTitle");
    const questionHintEl = $("#surveyQuestionHint");
    const optionsEl = $("#surveyOptions");
    const backBtn = $("#surveyBackBtn");
    const nextBtn = $("#surveyNextBtn");
    const successScreen = $("#surveySuccessScreen");
    const recommendedList = $("#surveyRecommendedList");
    const continueBtn = $("#surveyContinueBtn");
    const surveyInner = view.querySelector(".survey-view__inner");

    if (
      !appEl ||
      !view ||
      !stepEl ||
      !progressEl ||
      !progressFillEl ||
      !questionTitleEl ||
      !questionHintEl ||
      !optionsEl ||
      !backBtn ||
      !nextBtn ||
      !successScreen ||
      !recommendedList ||
      !continueBtn
    ) {
      resolve();
      return;
    }

    const answers = {
      creative_role: "",
      creative_role_detail: "",
      primary_use_case: [],
      inspiration_method: [],
      discovery_source: "",
      discovery_source_detail: "",
      creative_level: "",
    };
    let step = 0;
    let allCollections = [];

    const roleTagsFor = (role) => SURVEY_ROLE_TO_TAGS[role] || [];
    const isRecommendedForRole = (collection, role) => {
      const tags = roleTagsFor(role);
      if (!tags.length) return false;
      const colTags = Array.isArray(collection?.role_tags)
        ? collection.role_tags.map((x) => String(x || "").trim().toLowerCase())
        : [];
      return tags.some((tag) => colTags.includes(String(tag).toLowerCase()));
    };
    const localizedCollectionName = (collection, langNow) =>
      langNow === "uz" && collection?.name_uz ? collection.name_uz : collection?.name || "";

    const showCollectionsLoading = () => {
      recommendedList.innerHTML = Array(6)
        .fill(
          `<article class="survey-library-card survey-library-card--skeleton" role="listitem">
            <div class="survey-library-card__label">
              <div class="survey-library-card__top">
                <div class="skeleton-preview"></div>
                <div class="survey-library-card__main">
                  <div class="skeleton-line skeleton-line--long"></div>
                  <div class="skeleton-line skeleton-line--short"></div>
                </div>
              </div>
            </div>
          </article>`
        )
        .join("");
    };
    const showCollectionsOffline = () => {
      recommendedList.innerHTML = `
        <div class="collections-state-msg">
          <p>Kolleksiyalarni yuklash uchun internet kerak</p>
          <button type="button" class="btn btn--secondary" id="surveyCollectionsRetryBtn">Qayta urinish</button>
        </div>
      `;
      const retry = $("#surveyCollectionsRetryBtn");
      if (retry) retry.onclick = () => initCollectionsScreen();
    };
    const showCollectionsEmpty = () => {
      recommendedList.innerHTML = `
        <div class="collections-state-msg">
          <p>Hozircha kolleksiyalar mavjud emas</p>
        </div>
      `;
    };

    const formatCollectionSize = (sizeMb) => {
      const n = Number(sizeMb || 0);
      if (!Number.isFinite(n) || n <= 0) return "Yuklanmoqda...";
      if (n < 1) return `${Math.max(1, Math.round(n * 1000))} KB`;
      return `${n.toFixed(1)} MB`;
    };

    const renderCollectionCards = (collections, role) => {
      const langNow = state.settings?.language || "en";
      const preferred = [...collections].sort((a, b) => {
        const aRec = isRecommendedForRole(a, role);
        const bRec = isRecommendedForRole(b, role);
        if (aRec && !bRec) return -1;
        if (!aRec && bRec) return 1;
        return 0;
      });
      recommendedList.innerHTML = "";
      preferred.forEach((collection) => {
        const article = document.createElement("article");
        article.className = "survey-library-card";
        article.setAttribute("role", "listitem");

        const labelEl = document.createElement("label");
        labelEl.className = "survey-library-card__label";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "survey-library-card__input";
        input.dataset.id = String(collection.id || "");
        input.checked = isRecommendedForRole(collection, role);

        const top = document.createElement("div");
        top.className = "survey-library-card__top";

        const thumbWrap = document.createElement("div");
        thumbWrap.className = "survey-library-card__thumb-wrap";
        const thumb = document.createElement("div");
        thumb.className = "survey-library-card__thumb";
        const firstPreview = Array.isArray(collection.preview_urls) ? collection.preview_urls[0] : "";
        if (firstPreview) {
          const img = document.createElement("img");
          img.src = firstPreview;
          img.alt = "";
          img.loading = "lazy";
          thumb.appendChild(img);
        } else {
          const hue = surveyLibraryPackageHue(collection.name || collection.id || "");
          const hue2 = (hue + 52) % 360;
          thumb.style.background = `linear-gradient(135deg, hsl(${hue} 42% 46%) 0%, hsl(${hue2} 48% 32%) 100%)`;
          const shine = document.createElement("div");
          shine.className = "survey-library-card__thumb-shine";
          thumb.appendChild(shine);
        }
        thumbWrap.appendChild(thumb);
        top.appendChild(thumbWrap);

        const main = document.createElement("div");
        main.className = "survey-library-card__main";
        const titleRow = document.createElement("div");
        titleRow.className = "survey-library-card__title-row";
        const title = document.createElement("h3");
        title.className = "survey-library-card__title";
        title.dataset.collectionName = collection.name || "";
        title.textContent = localizedCollectionName(collection, langNow);

        const recChip = document.createElement("span");
        recChip.className = "survey-library-card__rec-chip";
        if (isRecommendedForRole(collection, role)) {
          recChip.textContent = t("survey.recommended", langNow);
        } else {
          recChip.classList.add("hidden");
        }
        const qty = document.createElement("span");
        qty.className = "survey-library-card__qty";
        qty.textContent = `x${Number(collection.item_count || 0)}`;
        titleRow.appendChild(title);
        titleRow.appendChild(recChip);
        titleRow.appendChild(qty);

        const desc = document.createElement("p");
        desc.className = "survey-library-card__desc";
        desc.textContent = t("survey.packageBlurb", langNow);
        const price = document.createElement("p");
        price.className = "survey-library-card__price";
        price.textContent = t("survey.packageFree", langNow);

        main.appendChild(titleRow);
        main.appendChild(desc);
        main.appendChild(price);
        top.appendChild(main);

        const divider = document.createElement("div");
        divider.className = "survey-library-card__divider";
        const bottom = document.createElement("div");
        bottom.className = "survey-library-card__bottom";
        const totalBlock = document.createElement("div");
        totalBlock.className = "survey-library-card__total";
        const totalLabel = document.createElement("span");
        totalLabel.className = "survey-library-card__total-label";
        totalLabel.textContent = t("survey.libraryCardTotalLabel", langNow);
        const totalValue = document.createElement("span");
        totalValue.className = "survey-library-card__total-value";
        totalValue.textContent = formatCollectionSize(collection.file_size_mb);
        totalBlock.appendChild(totalLabel);
        totalBlock.appendChild(totalValue);

        const actions = document.createElement("div");
        actions.className = "survey-library-card__actions";
        const pill = document.createElement("span");
        pill.className = "survey-library-card__pill";
        const round = document.createElement("span");
        round.className = "survey-library-card__round";
        round.setAttribute("aria-hidden", "true");
        actions.appendChild(pill);
        actions.appendChild(round);
        const syncPackUi = () => {
          const l = state.settings?.language || "en";
          pill.textContent = input.checked ? t("survey.packageAddedPill", l) : t("survey.packageAddPill", l);
          continueBtn.disabled =
            recommendedList.querySelectorAll(".survey-library-card__input:checked").length === 0;
        };
        input.addEventListener("change", syncPackUi);
        syncPackUi();

        bottom.appendChild(totalBlock);
        bottom.appendChild(actions);
        labelEl.appendChild(input);
        labelEl.appendChild(top);
        labelEl.appendChild(divider);
        labelEl.appendChild(bottom);
        article.appendChild(labelEl);
        recommendedList.appendChild(article);
      });
    };

    const initCollectionsScreen = async () => {
      showCollectionsLoading();
      try {
        const index = await window.qooti?.fetchFreeCollectionsIndex?.();
        const free = Array.isArray(index?.free) ? index.free : [];
        allCollections = free;
        if (!allCollections.length) {
          showCollectionsEmpty();
          continueBtn.disabled = true;
          return;
        }
        renderCollectionCards(allCollections, answers.creative_role || "Other Creative Work");
      } catch (err) {
        console.error("[collections] init failed", err);
        showCollectionsOffline();
        continueBtn.disabled = true;
      }
    };

    const onLangChange = () => {
      renderStep();
      if (successScreen && !successScreen.classList.contains("hidden")) {
        const newLang = state.settings?.language || "en";
        successScreen.querySelectorAll("[data-i18n]").forEach((el) => {
          const k = el.getAttribute("data-i18n");
          if (k) el.textContent = t(k, newLang);
        });
        recommendedList.querySelectorAll(".survey-library-card__title").forEach((el) => {
          const id = el.closest(".survey-library-card")?.querySelector(".survey-library-card__input")?.dataset?.id;
          const col = allCollections.find((c) => String(c.id) === String(id));
          if (col) el.textContent = localizedCollectionName(col, newLang);
        });
        recommendedList.querySelectorAll(".survey-library-card__rec-chip:not(.hidden)").forEach((el) => {
          el.textContent = t("survey.recommended", newLang);
        });
        recommendedList.querySelectorAll(".survey-library-card__desc").forEach((el) => {
          el.textContent = t("survey.packageBlurb", newLang);
        });
        recommendedList.querySelectorAll(".survey-library-card__total-label").forEach((el) => {
          el.textContent = t("survey.libraryCardTotalLabel", newLang);
        });
        recommendedList.querySelectorAll(".survey-library-card__price").forEach((el) => {
          el.textContent = t("survey.packageFree", newLang);
        });
        recommendedList.querySelectorAll(".survey-library-card__total-value").forEach((el) => {
          const id = el.closest(".survey-library-card")?.querySelector(".survey-library-card__input")?.dataset?.id;
          const col = allCollections.find((c) => String(c.id) === String(id));
          if (col) el.textContent = formatCollectionSize(col.file_size_mb);
        });
        recommendedList.querySelectorAll(".survey-library-card__pill").forEach((el) => {
          const input = el.closest(".survey-library-card__label")?.querySelector(".survey-library-card__input");
          if (!input) return;
          el.textContent = input.checked ? t("survey.packageAddedPill", newLang) : t("survey.packageAddPill", newLang);
        });
      }
    };
    document.addEventListener("app:languageChanged", onLangChange);
    const cleanup = () => {
      document.removeEventListener("app:languageChanged", onLangChange);
      appEl.classList.remove("app--survey");
      view.classList.add("hidden");
      view.classList.remove("survey-view--closing");
      backBtn.onclick = null;
      nextBtn.onclick = null;
      continueBtn.onclick = null;
      resolve();
    };

    const getValue = (question) => answers[question.key];

    const isQuestionValid = (question) => {
      const value = getValue(question);
      if (question.selection === "multiple") {
        return Array.isArray(value) && value.length > 0;
      }
      if (!value) return false;
      if (question.otherOption && value === question.otherOption) {
        return String(answers[question.detailKey] || "").trim().length > 0;
      }
      return true;
    };

    const lang = state.settings?.language || "en";
    const updateActionState = () => {
      const question = SURVEY_QUESTIONS[step];
      nextBtn.disabled = !isQuestionValid(question);
      const nextLabel = nextBtn.querySelector(".survey-view__next-label");
      const nextText = step === SURVEY_QUESTIONS.length - 1 ? t("survey.finish", lang) : t("survey.next", lang);
      if (nextLabel) nextLabel.textContent = nextText;
      else nextBtn.textContent = nextText;
      backBtn.classList.toggle("hidden", step === 0);
    };

    const setSingleValue = (question, label) => {
      answers[question.key] = label;
      if (question.otherOption && label !== question.otherOption && question.detailKey) {
        answers[question.detailKey] = "";
      }
    };

    const toggleMultipleValue = (question, label) => {
      const current = new Set(Array.isArray(answers[question.key]) ? answers[question.key] : []);
      if (current.has(label)) current.delete(label);
      else current.add(label);
      answers[question.key] = question.options.filter((option) => current.has(option));
    };

    const renderOtherInput = (question, wrapEl) => {
      if (!question.detailKey) return;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "survey-view__other-input";
      input.placeholder = t(question.detailKey ? `survey.${question.key}.detailPlaceholder` : "survey.tellUsMore", lang) || question.detailPlaceholder || "Tell us more";
      input.value = answers[question.detailKey] || "";
      input.maxLength = 80;
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("input", () => {
        answers[question.detailKey] = input.value;
        updateActionState();
      });
      wrapEl.appendChild(input);
      setTimeout(() => input.focus(), 10);
    };

    const renderStep = () => {
      const question = SURVEY_QUESTIONS[step];
      const l = state.settings?.language || "en";
      const total = SURVEY_QUESTIONS.length;
      const pct = ((step + 1) / total) * 100;
      progressEl.textContent = `${step + 1} / ${total}`;
      if (progressFillEl) {
        progressFillEl.style.width = `${pct}%`;
        progressFillEl.style.height = "100%";
      }
      if (progressTrackEl) {
        progressTrackEl.setAttribute("aria-valuemax", String(total));
        progressTrackEl.setAttribute("aria-valuenow", String(step + 1));
        progressTrackEl.setAttribute("aria-label", `${step + 1} / ${total}`);
      }
      const shellEl = stepEl?.querySelector(".survey-view__shell");
      if (shellEl) {
        shellEl.classList.toggle("survey-view__shell--single", question.selection === "single");
        shellEl.classList.toggle("survey-view__shell--multi", question.selection === "multiple");
      }
      questionTitleEl.textContent = t(`survey.${question.key}.title`, l) || question.title;
      questionHintEl.textContent = t(`survey.${question.key}.hint`, l) || question.hint || "";
      optionsEl.innerHTML = "";
      const isSingle = question.selection === "single";
      optionsEl.classList.toggle("survey-view__options--stack", isSingle);
      optionsEl.classList.toggle("survey-view__options--chips", !isSingle);
      const sectionLabelEl = $("#surveyOptionsSectionLabel");
      const multiCountEl = $("#surveyMultiCount");
      if (sectionLabelEl) {
        sectionLabelEl.classList.toggle("hidden", isSingle);
        if (!isSingle) sectionLabelEl.textContent = t("survey.choicesSection", l) || "Options";
      }
      if (multiCountEl) {
        if (isSingle) {
          multiCountEl.classList.add("hidden");
        } else {
          multiCountEl.classList.remove("hidden");
          const n = Array.isArray(answers[question.key]) ? answers[question.key].length : 0;
          const tmpl = t("survey.selectedCount", l) || "{{n}} / {{total}} selected";
          multiCountEl.textContent = tmpl.replace(/\{\{n\}\}/g, String(n)).replace(/\{\{total\}\}/g, String(question.options.length));
        }
      }
      question.options.forEach((label) => {
        const wrap = document.createElement("div");
        wrap.className = isSingle ? "survey-view__option-wrap" : "survey-view__option-wrap survey-view__option-wrap--chip";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "survey-view__option";
        btn.setAttribute("role", isSingle ? "radio" : "checkbox");
        btn.setAttribute("aria-checked", "false");
        btn.dataset.value = label;
        const icon = document.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        const brandSrc = question.key === "discovery_source" && isSingle ? SURVEY_DISCOVERY_BRAND_ICONS[label] : null;
        if (brandSrc) {
          icon.className = "survey-view__option-icon survey-view__option-icon--brand";
          const img = document.createElement("img");
          img.src = brandSrc;
          img.alt = "";
          img.decoding = "async";
          icon.appendChild(img);
        } else {
          icon.className = isSingle
            ? "survey-view__option-control survey-view__option-control--radio"
            : "survey-view__option-control survey-view__option-control--checkbox";
        }
        const labelSpan = document.createElement("span");
        labelSpan.className = "survey-view__option-label";
        labelSpan.textContent = t(`survey.option.${label}`, l) || label;
        btn.appendChild(icon);
        btn.appendChild(labelSpan);
        btn.addEventListener("click", () => {
          if (question.selection === "multiple") {
            toggleMultipleValue(question, label);
          } else {
            setSingleValue(question, label);
          }
          renderStep();
        });
        const selected =
          question.selection === "multiple"
            ? Array.isArray(answers[question.key]) && answers[question.key].includes(label)
            : answers[question.key] === label;
        btn.classList.toggle("is-selected", selected);
        btn.setAttribute("aria-checked", selected ? "true" : "false");
        wrap.appendChild(btn);
        if (selected && question.otherOption === label) {
          renderOtherInput(question, wrap);
        }
        optionsEl.appendChild(wrap);
      });
      stepEl.setAttribute("aria-hidden", "false");
      updateActionState();
    };

    const finishQuestions = async () => {
      try {
        await window.qooti?.saveSurveyData?.({
          creative_role: answers.creative_role || null,
          creative_role_detail:
            answers.creative_role === "Other Creative Work" ? String(answers.creative_role_detail || "").trim() || null : null,
          primary_use_case: JSON.stringify(answers.primary_use_case || []),
          inspiration_method: JSON.stringify(answers.inspiration_method || []),
          discovery_source: answers.discovery_source || null,
          discovery_source_detail:
            answers.discovery_source === "Other" ? String(answers.discovery_source_detail || "").trim() || null : null,
          creative_level: answers.creative_level || null,
        });
        await window.qooti?.setSurveyCompleted?.();
      } catch (e) {
        console.warn("[qooti] survey save failed", e);
      }

      try {
        const index = await window.qooti?.fetchFreeCollectionsIndex?.();
        const free = Array.isArray(index?.free) ? index.free : [];
        const role = answers.creative_role || "Other Creative Work";
        onboardingRecommendedStoreIds = new Set(
          free
            .filter((collection) => isRecommendedForRole(collection, role))
            .map((collection) => String(collection?.id || ""))
            .filter(Boolean)
        );
      } catch (err) {
        console.warn("[survey] failed to prepare onboarding recommendations", err);
        onboardingRecommendedStoreIds = new Set();
      }

      openStoreAfterSurvey = true;
      cleanup();
    };

    backBtn.onclick = () => {
      if (step === 0) return;
      step -= 1;
      renderStep();
    };

    nextBtn.onclick = () => {
      const question = SURVEY_QUESTIONS[step];
      if (!isQuestionValid(question)) return;
      step += 1;
      if (step < SURVEY_QUESTIONS.length) {
        renderStep();
      } else {
        finishQuestions();
      }
    };

    appEl.classList.add("app--survey");
    view.classList.remove("hidden");
    stepsEl.classList.remove("hidden");
    successScreen.classList.add("hidden");
    successScreen.setAttribute("aria-hidden", "true");
    renderStep();
  });
}

async function ensureSurveyComplete() {
  try {
    const completed = await window.qooti?.getSurveyCompleted?.();
    if (completed) return;
  } catch (_) {}
  await showSurveyView();
}

function wireSettingsControls() {
  const bind = (id, key, fn) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.addEventListener("change", (e) => {
      const val = el.type === "checkbox" ? (el.checked ? "true" : "false") : el.value;
      saveSetting(key, val);
      fn?.(val);
    });
  };
  bind("settingTheme", "theme", (val) => {
    if (val === "light") {
      saveSetting("theme", "system");
      const themeEl = $("#settingTheme");
      if (themeEl) themeEl.value = "system";
      applyTheme("system");
      return;
    }
    applyTheme();
  });
  $("#settingsCheckForUpdates")?.addEventListener("click", async () => {
    if (simulateUpdateOnNextManualCheck) {
      simulateUpdateOnNextManualCheck = false;
      simulateUpdateFoundState();
      return;
    }
    const phase = updaterUiState?.phase || "idle";
    if (phase === "update_available") {
      window.qooti?.downloadUpdate?.().catch((e) => console.warn("[qooti] downloadUpdate failed", e?.message || e));
      return;
    }
    window.qooti?.checkForUpdates?.().catch((e) => console.warn("[qooti] checkForUpdates failed", e?.message || e));
  });
  const settingsAccountAvatarBtn = $("#settingsAccountAvatarBtn");
  const settingsAccountAvatarInput = $("#settingsAccountAvatarInput");
  settingsAccountAvatarBtn?.addEventListener("click", () => settingsAccountAvatarInput?.click());
  settingsAccountAvatarInput?.addEventListener("change", async () => {
    const file = settingsAccountAvatarInput.files?.[0];
    if (!file) return;
    const lang = state.settings?.language || "en";
    try {
      const cropped = await showProfileImageCropModal(file);
      settingsAccountAvatarInput.value = "";
      if (!cropped) return;
      await saveSetting(PROFILE_IMAGE_KEY, cropped);
      state.settings[PROFILE_IMAGE_KEY] = cropped;
      updateProfileUi();
      toast(t("ctx.profileImageSet", lang), { variant: "success" });
    } catch (e) {
      settingsAccountAvatarInput.value = "";
      toast(t("settings.profilePictureSaveFailed", lang), { variant: "error" });
      console.warn("[qooti] settings avatar update failed", e?.message || e);
    }
  });
  $("#settingRunFullOcr")?.addEventListener("click", async () => {
    const btn = $("#settingRunFullOcr");
    const lang = state.settings?.language || "en";
    if (!window.qooti?.queueFullOcrReindex) {
      toast(t("settings.fullOcrFailed", lang), { variant: "error" });
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const summary = await window.qooti.queueFullOcrReindex();
      const queued = Number(summary?.queued || 0);
      const running = Number(summary?.already_processing || 0);
      await refreshOcrIndexStats();
      if (queued > 0 || running > 0) {
        scheduleOcrAutoIndex();
      }
      if (queued > 0) {
        toast(
          t("settings.fullOcrQueued", lang).replace("%d", String(queued)),
          { variant: "success" }
        );
      } else if (running > 0) {
        toast(t("settings.fullOcrAlreadyRunning", lang), { variant: "info" });
      } else {
        toast(t("settings.fullOcrNoWork", lang), { variant: "warning" });
      }
    } catch (e) {
      console.warn("[qooti] full OCR queue failed", e?.message || e);
      const detail = e?.message ? `: ${e.message}` : "";
      toast(`${t("settings.fullOcrFailed", lang)}${detail}`, { variant: "error" });
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  bind("settingEnableTagFilters", "enableTagFilters", () => {
    applyTagFilterVisibility();
    void refreshTagFilterBar();
    void renderTagFilterBarSettings();
  });
  bind("settingUseSimpleSizeControl", "useSimpleSizeControl", () => {
    syncSizeControlModeUi();
    applyCardSizing();
    applyMediaTitleSizing();
    renderGrid();
  });
  bind("settingUiScalePercent", "uiScalePercent", () => {
    applyUiScale();
    applyCardSizing();
    applyMediaTitleSizing();
    renderGrid();
  });
  bind("settingCardSize", "cardSize", () => {
    applyCardSizing();
    renderGrid();
  });
  bind("settingMediaTitleSize", "mediaTitleSize", () => {
    applyMediaTitleSizing();
    renderGrid();
  });
  bind("settingGridDensity", "gridDensity", () => renderGrid());
  bind("settingShowTitlesOnHover", "showTitlesOnHover", () => renderGrid());
  bind("settingShowSourceLabels", "showSourceLabels", () => renderGrid());
  bind("settingShowCollectionIndicator", "showCollectionIndicator", () => renderGrid());
  bind("settingShowQuickTagsInToast", "showQuickTagsInToast");
  bind("settingLanguage", "language", () => applyTranslations());
  bind("settingShowExtensionCollectionPicker", "extensionShowCollectionPicker");
  $("#settingLaunchAtLogin")?.addEventListener("change", async () => {
    const toggle = $("#settingLaunchAtLogin");
    if (!toggle) return;
    const enabled = !!toggle.checked;
    const value = enabled ? "true" : "false";
    state.settings.launchAtLogin = value;
    try {
      if (window.qooti?.setLaunchAtLoginEnabled) {
        await window.qooti.setLaunchAtLoginEnabled(enabled);
      } else {
        await saveSetting("launchAtLogin", value);
      }
      syncAutostartStartupOptionsVisibility();
    } catch (e) {
      console.warn("[qooti] set launchAtLogin failed:", e?.message || e);
      toggle.checked = !enabled;
      state.settings.launchAtLogin = toggle.checked ? "true" : "false";
      syncAutostartStartupOptionsVisibility();
    }
  });
  const saveAutostartBgMode = async (background) => {
    const v = background ? "true" : "false";
    state.settings.autostartBackgroundMode = v;
    try {
      await saveSetting("autostartBackgroundMode", v);
    } catch (e) {
      console.warn("[qooti] set autostartBackgroundMode failed:", e?.message || e);
    }
  };
  $("#settingAutostartModeBackground")?.addEventListener("change", async () => {
    if (!$("#settingAutostartModeBackground")?.checked) return;
    await saveAutostartBgMode(true);
  });
  $("#settingAutostartModeWindow")?.addEventListener("change", async () => {
    if (!$("#settingAutostartModeWindow")?.checked) return;
    await saveAutostartBgMode(false);
  });
  bind("settingDefaultClickBehavior", "defaultClickBehavior");
  bind("settingEnableContextMenu", "enableContextMenu");
  bind("settingConfirmBeforeDelete", "confirmBeforeDelete");
  bind("settingEnableDragDropImport", "enableDragDropImport");
  bind("settingAutoExtractPalette", "autoExtractPalette");
  bind("settingDownloadQualityMode", "downloadQualityMode");
  bind("settingRelatedStrictness", "relatedStrictness");
  bind("settingRelatedPreferSameOrientation", "relatedPreferSameOrientation");
  bind("settingRelatedPreferSameMediaType", "relatedPreferSameMediaType");
  bind("settingQuickTagsDefaultEnabled", "quickTagsDefaultEnabled", () => renderGrid());

  $("#settingsTagFilterBarManage")?.addEventListener("click", (e) => {
    const unhide = e.target.closest(".settings-tag-filter-unhide");
    const unhideId = unhide?.dataset?.tagId;
    if (unhideId) void settingsTagFilterBarUnhide(unhideId);
  });

  const uiScaleMinus = $("#settingUiScaleMinus");
  const uiScalePlus = $("#settingUiScalePlus");
  const uiScaleInput = $("#settingUiScalePercent");
  const bumpUiScale = async (delta) => {
    const curr = Number(uiScaleInput?.value || state.settings?.uiScalePercent || 100);
    const next = Math.max(80, Math.min(130, curr + delta));
    if (uiScaleInput) uiScaleInput.value = String(next);
    await saveSetting("uiScalePercent", String(next));
    applyUiScale();
    applyCardSizing();
    applyMediaTitleSizing();
    renderGrid();
  };
  uiScaleMinus?.addEventListener("click", () => bumpUiScale(-5));
  uiScalePlus?.addEventListener("click", () => bumpUiScale(5));

  const customInput = $("#settingQuickTagsCustomInput");
  const customList = $("#settingQuickTagsCustomList");
  if (customInput && customList) {
    customInput.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const tag = customInput.value.trim().toLowerCase();
      if (!tag) return;
      let customTags = [];
      try {
        customTags = JSON.parse(state.settings.quickTagsCustom || "[]");
      } catch (_) {}
      if (customTags.includes(tag)) return;
      customTags.push(tag);
      customTags.sort();
      await saveSetting("quickTagsCustom", JSON.stringify(customTags));
      state.settings.quickTagsCustom = JSON.stringify(customTags);
      customInput.value = "";
      loadSettingsUI();
    });
    customList.addEventListener("click", async (e) => {
      const btn = e.target.closest(".settings-tag-chip__remove");
      if (!btn) return;
      const tag = btn.dataset.tag;
      if (!tag) return;
      let customTags = [];
      try {
        customTags = JSON.parse(state.settings.quickTagsCustom || "[]");
      } catch (_) {}
      customTags = customTags.filter((t) => t !== tag);
      await saveSetting("quickTagsCustom", JSON.stringify(customTags));
      state.settings.quickTagsCustom = JSON.stringify(customTags);
      loadSettingsUI();
    });
  }

  function wireSettingsTabs() {
    const nav = document.querySelector(".settings-nav");
    const panels = document.querySelectorAll(".settings-panel");
    if (!nav || !panels.length) return;
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest(".settings-nav__item");
      if (!btn || !btn.dataset.tab) return;
      const tabId = btn.dataset.tab;
      nav.querySelectorAll(".settings-nav__item").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      panels.forEach((p) => {
        const id = p.id;
        if (!id) return;
        const match = id.replace("settingsPanel", "").toLowerCase();
        if (match === tabId) {
          p.classList.add("is-active");
          p.setAttribute("aria-hidden", "false");
        } else {
          p.classList.remove("is-active");
          p.setAttribute("aria-hidden", "true");
        }
      });
      if (tabId === "tags") void renderTagFilterBarSettings();
    });
  }
  wireSettingsTabs();

  // Extension Connection: Copy key, Regenerate key
  const extCopyBtn = $("#extensionCopyKey");
  const extRegenBtn = $("#extensionRegenerateKey");
  async function refreshExtensionUI() {
    try {
      const status = await window.qooti?.getExtensionConnectionStatus?.();
      const lang = state.settings?.language || "en";
      if (status) {
        setText($("#extensionStatus"), status.connected ? t("settings.connected", lang) : t("settings.notConnected", lang));
        setText($("#extensionKeyDisplay"), status.key_masked || "—");
        const lastEl = $("#extensionLastConnection");
        if (lastEl)
          lastEl.textContent = status.last_connection_ts ? new Date(status.last_connection_ts).toLocaleString() : "—";
      }
      const mobileCode = String((await window.qooti?.getExtensionKeyForCopy?.()) || "").trim();
      setText($("#settingsMobileCode"), mobileCode || "—");
      const qrEl = $("#settingsMobileQr");
      if (qrEl && mobileCode) {
        qrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(mobileCode)}`;
        qrEl.classList.remove("hidden");
      } else {
        qrEl?.classList.add("hidden");
      }
    } catch (_) {}
  }
  if (extCopyBtn) {
    extCopyBtn.addEventListener("click", async () => {
      try {
        const key = await window.qooti?.getExtensionKeyForCopy?.();
        if (key) {
          await writeTextToClipboard(key);
          const lang = state.settings?.language || "en";
          extCopyBtn.textContent = t("settings.copied", lang);
          setTimeout(() => { extCopyBtn.textContent = t("settings.copyKey", lang); }, 1500);
        }
      } catch (err) {
        toast(err?.message || "Could not copy connection key.", { variant: "error" });
      }
    });
  }
  if (extRegenBtn) {
    extRegenBtn.addEventListener("click", async () => {
      if (!confirm("Regenerate connection key? Extensions using the old key will need to enter the new one.")) return;
      try {
        await window.qooti?.regenerateExtensionKey?.();
        await refreshExtensionUI();
        const lang = state.settings?.language || "en";
        extRegenBtn.textContent = t("settings.regenerated", lang);
        setTimeout(() => { extRegenBtn.textContent = t("settings.regenerateKey", lang); }, 1500);
      } catch (e) {
        console.warn("[qooti] regenerateExtensionKey failed", e);
      }
    });
  }
  $("#settingsMobileCopyCode")?.addEventListener("click", async () => {
    const code = ($("#settingsMobileCode")?.textContent || "").trim();
    if (!code || code === "—") return;
    try {
      await writeTextToClipboard(code);
      toast("Mobile connection code copied.", { variant: "success" });
    } catch (err) {
      toast(err?.message || "Could not copy mobile connection code.", { variant: "error" });
    }
  });
}

// URL detection
function isUrl(str) {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  return /^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed);
}

async function writeTextToClipboard(text) {
  const value = String(text || "").trim();
  if (!value) throw new Error("Nothing to copy");
  // Desktop bridges use the OS clipboard directly; navigator.clipboard often fails on macOS Electron.
  if (typeof window.qooti?.copyTextToClipboard === "function") {
    await window.qooti.copyTextToClipboard(value);
    return;
  }
  const browserWrite = navigator?.clipboard?.writeText?.bind(navigator.clipboard);
  if (browserWrite) {
    try {
      await browserWrite(value);
      return;
    } catch (_) {}
  }
  throw new Error("Clipboard API is unavailable");
}

function isSubmitShortcut(e) {
  return e?.key === "Enter" && (e?.metaKey || e?.ctrlKey);
}

// Extract domain as fallback title
function domainFromUrl(url) {
  try {
    const u = new URL(url.startsWith("www.") ? `https://${url}` : url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Extract YouTube video ID for embed
function youtubeVideoId(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url.startsWith("www.") ? `https://${url}` : url);
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v"))
      return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
    if (u.hostname.includes("youtube.com") && u.pathname.startsWith("/embed/"))
      return u.pathname.split("/")[2];
    if (u.hostname.includes("youtube.com") && u.pathname.startsWith("/shorts/"))
      return u.pathname.split("/")[2];
  } catch {}
  return null;
}

/** HTTP(S) URL that may work as HTML video src; excludes YouTube (handled separately). */
function isHttpVideoSourceCandidate(url) {
  const u = String(url || "").trim();
  if (!u) return false;
  if (youtubeVideoId(u)) return false;
  try {
    const normalized = /^www\./i.test(u) ? `https://${u}` : u;
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function inferMimeFromPath(filePath) {
  const p = String(filePath || "").toLowerCase();
  if (p.endsWith(".mp4")) return "video/mp4";
  if (p.endsWith(".webm")) return "video/webm";
  if (p.endsWith(".mov")) return "video/quicktime";
  if (p.endsWith(".m4v")) return "video/x-m4v";
  if (p.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".gif")) return "image/gif";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".bmp")) return "image/bmp";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function toFileUri(absPath) {
  const normalized = String(absPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return "";
  return encodeURI(`file:///${normalized}`);
}

function dragDownloadUrl(absPath, relPath) {
  const name = String(relPath || absPath || "").split(/[\\/]/).pop() || "media";
  const mime = inferMimeFromPath(name);
  const src = toFileUri(absPath) || loadableUrl(absPath, relPath) || "";
  if (!src) return "";
  return `${mime}:${name}:${src}`;
}

function youtubeEmbedUrl(videoId) {
  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    modestbranding: "1",
    rel: "0"
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

function youtubeViewerEmbedUrl(videoId) {
  const params = new URLSearchParams({
    autoplay: "1",
    controls: "0",
    disablekb: "1",
    modestbranding: "1",
    rel: "0",
    showinfo: "0",
    iv_load_policy: "3",
    fs: "0",
    playsinline: "1",
    enablejsapi: "1",
    origin: "https://tauri.localhost"
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

let _youtubeApiPromise = null;
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve();
  if (_youtubeApiPromise) return _youtubeApiPromise;
  _youtubeApiPromise = new Promise((resolve) => {
    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existing) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") {
        try { prev(); } catch (_) {}
      }
      resolve();
    };
  });
  return _youtubeApiPromise;
}

// App served over http://localhost in dev → YouTube embed works. Hover-to-play for links.
const USE_YOUTUBE_EMBED = true;

// Source type: local | youtube | instagram | web (icon only, no text)
function sourceType(it) {
  if (it.type === "link" && it.source_url) {
    const u = (it.source_url || "").toLowerCase();
    if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
    if (u.includes("instagram.com")) return "instagram";
    return "web";
  }
  return "local";
}

function remixIcon(name, className = "ui-icon ui-icon--sm") {
  return `<span class="${className}" style="--icon-url:url('./assets/icons/remix/${name}')" aria-hidden="true"></span>`;
}

function getMediaPreviewPathToCopy(it) {
  if (!it) return "";
  return it.stored_path || (it.type === "link" && it.thumbnail_path ? it.thumbnail_path : "") || "";
}

async function copyMediaFile(relPath) {
  if (!relPath) throw new Error("No file available to copy");
  await window.qooti?.copyFileToClipboard?.(relPath);
}

const copyStrings = {
  copying: { uz: "Nusxalanmoqda...", en: "Copying..." },
  copied: { uz: "Nusxa olindi", en: "Copied" },
  copyFailed: { uz: "Nusxalashda xatolik yuz berdi", en: "Copy failed" },
};

function copyText(key) {
  const lang = (state.settings?.language || "en").toLowerCase();
  return copyStrings?.[key]?.[lang] || copyStrings?.[key]?.en || "";
}

const activeNotifications = {};

function showNotification({ message, type = "info", duration = 2000, persistent = false }) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const variant =
    type === "success" ? "success"
      : type === "error" ? "error"
        : type === "warning" ? "warning"
          : null;
  const dismiss = showToastNow(String(message || ""), {
    variant,
    durationMs: Number(duration) || 2000,
    persistent: !!persistent,
  });
  activeNotifications[id] = { dismiss };
  return id;
}

function dismissNotification(id) {
  const notif = activeNotifications[id];
  if (!notif) return;
  try {
    notif.dismiss?.();
  } catch (_) {}
  delete activeNotifications[id];
}

async function handleCopyMedia(item) {
  const relPath = getMediaPreviewPathToCopy(item);
  if (!relPath) {
    showNotification({ message: copyText("copyFailed"), type: "error", duration: 3000 });
    return;
  }
  const copyingNotif = showNotification({
    message: copyText("copying"),
    type: "loading",
    persistent: true,
  });
  try {
    await copyMediaFile(relPath);
    dismissNotification(copyingNotif);
    showNotification({
      message: copyText("copied"),
      type: "success",
      duration: 2000,
    });
  } catch (err) {
    dismissNotification(copyingNotif);
    showNotification({
      message: `${copyText("copyFailed")}: ${err?.message || "unknown error"}`,
      type: "error",
      duration: 3000,
    });
    console.error("[copy] failed:", err);
  }
}

const SOURCE_LABELS = {
  local: {
    icon: remixIcon("box-alt.svg", "ui-icon ui-icon--sm card-label__icon"),
    text: "Local"
  },
  youtube: {
    icon: remixIcon("download-2-line.svg", "ui-icon ui-icon--sm card-label__icon"),
    text: "YouTube"
  },
  instagram: {
    icon: remixIcon("image-line.svg", "ui-icon ui-icon--sm card-label__icon"),
    text: "Instagram"
  },
  web: {
    icon: remixIcon("link-m.svg", "ui-icon ui-icon--sm card-label__icon"),
    text: "Web"
  }
};

// Context menu icons from Remix Icon set.
const CTX_ICONS = {
  select: remixIcon("checkbox-circle-line.svg", "ui-icon ui-icon--sm"),
  rename: remixIcon("edit-line.svg", "ui-icon ui-icon--sm"),
  tags: remixIcon("price-tag-3-line.svg", "ui-icon ui-icon--sm"),
  collection: remixIcon("add.svg", "ui-icon ui-icon--sm"),
  collectionAdded: remixIcon("added.svg", "ui-icon ui-icon--sm"),
  collectionAdd: remixIcon("add.svg", "ui-icon ui-icon--sm"),
  openSource: remixIcon("external-link-line.svg", "ui-icon ui-icon--sm"),
  copy: remixIcon("file-copy-line.svg", "ui-icon ui-icon--sm"),
  link: remixIcon("link-m.svg", "ui-icon ui-icon--sm"),
  delete: remixIcon("delete-bin-6-line.svg", "ui-icon ui-icon--sm"),
  newCollection: remixIcon("add-circle-line.svg", "ui-icon ui-icon--sm"),
  arrow: remixIcon("arrow-right-s-line.svg", "ui-icon ui-icon--sm"),
  exportPack: remixIcon("upload-2-line.svg", "ui-icon ui-icon--sm"),
  profileImage: remixIcon("user-line.svg", "ui-icon ui-icon--sm"),
  home: remixIcon("layout-4-line.svg", "ui-icon ui-icon--sm"),
  eyeOff: remixIcon("eye-off-line.svg", "ui-icon ui-icon--sm")
};

// Context menu state
let contextMenuTarget = null; // The inspiration item being right-clicked

function hideContextMenu() {
  const menu = $("#contextMenu");
  if (menu) {
    menu.classList.add("hidden");
    menu.classList.remove("context-menu--compact");
  }
  document.querySelectorAll(".context-menu__submenu--floating").forEach((el) => el.remove());
  contextMenuTarget = null;
}

function showContextMenu(e, item) {
  if (state.settings.enableContextMenu === "false") return;
  e.preventDefault();
  e.stopPropagation();

  contextMenuTarget = item;
  const menu = $("#contextMenu");
  menu?.classList.remove("context-menu--compact");
  const content = menu.querySelector(".context-menu__content");
  content.innerHTML = "";
  const lang = state.settings?.language || "en";

  const isLocal = item.type !== "link";
  const isExternal = item.type === "link" && item.source_url;
  
  // Build menu items
  const items = [];
  
  // Select
  items.push({
    icon: CTX_ICONS.select,
    labelKey: "ctx.select",
    action: () => {
      if (!state.selected.has(item.id)) {
        state.selected.add(item.id);
        updateSelectionBar();
        renderGrid();
      }
      hideContextMenu();
    }
  });
  
  // Rename
  items.push({
    icon: CTX_ICONS.rename,
    labelKey: "ctx.rename",
    action: () => {
      hideContextMenu();
      promptRename(item);
    }
  });
  
  // Edit tags
  items.push({
    icon: CTX_ICONS.tags,
    labelKey: "ctx.editTags",
    action: () => {
      hideContextMenu();
      showEditTagsModal(item);
    }
  });

  // Add to collection (with submenu)
  items.push({
    icon: CTX_ICONS.collection,
    labelKey: "ctx.addToCollection",
    submenu: true,
    buildSubmenu: buildCollectionSubmenu(item)
  });
  
  // Open original source (only for external)
  if (isExternal) {
    items.push({
      icon: CTX_ICONS.openSource,
      labelKey: "ctx.openOriginalSource",
      action: () => {
        hideContextMenu();
        if (item.source_url) {
          window.open(item.source_url, "_blank");
        }
      }
    });
  }
  
  // Copy (local) or Copy link (external)
  if (isLocal) {
    items.push({
      icon: CTX_ICONS.copy,
      labelKey: "ctx.copy",
      action: async () => {
        hideContextMenu();
        await handleCopyMedia(item);
      }
    });
  } else if (isExternal) {
    items.push({
      icon: CTX_ICONS.link,
      labelKey: "ctx.copyLink",
      action: async () => {
        hideContextMenu();
        if (item.source_url) {
          try {
            await writeTextToClipboard(item.source_url);
            toast(t("ctx.linkCopied", lang), { variant: "success" });
          } catch (err) {
            toast(err?.message || t("ctx.couldNotCopyLink", lang), { variant: "error" });
          }
        }
      }
    });
  }

  // Move to row (short-form vs main)
  const inShortForm = showsInShortFormRow(item);
  if (inShortForm) {
    items.push({
      icon: CTX_ICONS.collection,
      labelKey: "ctx.moveToMainGrid",
      action: async () => {
        hideContextMenu();
        await window.qooti.updateInspiration(item.id, { display_row: "main" });
        await loadInspirations();
        toast(t("ctx.movedToMainGrid", lang), { variant: "success" });
      }
    });
  } else {
    items.push({
      icon: CTX_ICONS.collection,
      labelKey: "ctx.moveToShortFormRow",
      action: async () => {
        hideContextMenu();
        await window.qooti.updateInspiration(item.id, { display_row: "short-form" });
        await loadInspirations();
        toast(t("ctx.movedToShortFormRow", lang), { variant: "success" });
      }
    });
  }
  
  // Separator
  items.push({ divider: true });
  
  // Delete
  items.push({
    icon: CTX_ICONS.delete,
    labelKey: "ctx.delete",
    danger: true,
    action: async () => {
      uilog("delete", "clicked");
      hideContextMenu();
      const confirm = state.settings.confirmBeforeDelete !== "false";
      const label = item.title ? truncateForDialog(item.title, 60) : "this item";
      if (confirm) {
        const ok = await showConfirm({ message: t("ctx.deleteConfirm", lang).replace("%s", label), confirmLabel: t("ctx.delete", lang), danger: true });
        if (!ok) return uilog("delete", "cancelled");
      }
      try {
        uilog("delete", "invoking");
        await window.qooti.deleteInspiration(item.id);
        uilog("delete", "invoke resolved");
        state.selected.delete(item.id);
        updateSelectionBar();
        await refreshData();
        await loadInspirations();
        toast(t("ctx.deleted", lang), { variant: "success" });
        uilog("delete", "done");
      } catch (err) {
        uilog("delete", "error", err?.message || String(err));
        toast(err?.message || t("ctx.deleteFailed", lang), { variant: "error" });
      }
    }
  });
  
  // Render menu items
  for (const mi of items) {
    if (mi.divider) {
      const div = document.createElement("div");
      div.className = "context-menu__divider";
      content.appendChild(div);
      continue;
    }
    const labelText = mi.labelKey ? t(mi.labelKey, lang) : mi.label;
    const row = document.createElement("div");
    row.className = "context-menu__item" + (mi.danger ? " context-menu__item--danger" : "");
    
    row.innerHTML = `
      <span class="context-menu__icon">${mi.icon}</span>
      <span class="context-menu__label">${escapeHtml(labelText)}</span>
      ${mi.submenu ? `<span class="context-menu__arrow">${CTX_ICONS.arrow}</span>` : ""}
    `;
    
    if (mi.submenu && mi.buildSubmenu) {
      const submenu = document.createElement("div");
      submenu.className = "context-menu__submenu context-menu__submenu--floating";
      mi.buildSubmenu(submenu);
      document.body.appendChild(submenu);
      let hideTimer = null;
      const showSubmenu = () => {
        if (!document.body.contains(submenu)) return;
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        const rowRect = row.getBoundingClientRect();
        submenu.style.left = `${Math.round(rowRect.right - 6)}px`;
        submenu.style.top = `${Math.round(rowRect.top - 6)}px`;
        submenu.classList.add("is-open");
      };
      const hideSubmenuSoon = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          submenu.classList.remove("is-open");
        }, 90);
      };
      row.addEventListener("mouseenter", showSubmenu);
      row.addEventListener("mouseleave", hideSubmenuSoon);
      submenu.addEventListener("mouseenter", showSubmenu);
      submenu.addEventListener("mouseleave", hideSubmenuSoon);
      // Do not auto-open on menu mount; open only when user hovers this row.
    } else if (mi.action) {
      row.addEventListener("click", mi.action);
    }
    
    content.appendChild(row);
  }
  
  // Position the menu
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  
  // Keep menu within viewport
  if (x + rect.width > window.innerWidth) {
    x = window.innerWidth - rect.width - 8;
  }
  if (y + rect.height > window.innerHeight) {
    y = window.innerHeight - rect.height - 8;
  }
  
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

/** Right-click context menu for a collection card (Rename, Export Pack, Set profile image, Delete). */
function showCollectionContextMenu(e, row) {
  e.preventDefault();
  e.stopPropagation();
  const menu = $("#contextMenu");
  const content = menu.querySelector(".context-menu__content");
  content.innerHTML = "";
  const colLang = state.settings?.language || "en";
  const isDefaultUnsorted = row?.collection?.id === DEFAULT_UNSORTED_COLLECTION_ID;
  const collectionDisplayName = getCollectionDisplayName(row.collection);

  const items = [];

  if (!isDefaultUnsorted) {
    items.push({
      icon: CTX_ICONS.rename,
      labelKey: "ctx.rename",
      action: async () => {
        hideContextMenu();
        const newName = await showPrompt({
          message: t("ctx.renameCollection", colLang),
          defaultValue: row.collection?.name || "",
          submitLabel: t("ctx.rename", colLang)
        });
        if (newName == null) return;
        await window.qooti.renameCollection(row.collection.id, newName);
        if (state.currentCollectionId === row.collection.id) state.currentCollectionName = newName;
        collectionsPageRows = await loadCollectionsPageRows();
        renderCollectionsPage(collectionsPageRows);
        updateCollectionViewBar();
      }
    });
  }

  items.push(
    {
      icon: CTX_ICONS.exportPack,
      labelKey: "ctx.exportPack",
      action: async () => {
        hideContextMenu();
        await openExportCollectionPackFlow(row);
        collectionsPageRows = await loadCollectionsPageRows();
        renderCollectionsPage(collectionsPageRows);
      }
    },
    {
      icon: CTX_ICONS.profileImage,
      labelKey: "ctx.setProfileImage",
      action: async () => {
        hideContextMenu();
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
            r.onerror = () => reject(new Error("Could not read file"));
            r.readAsDataURL(file);
          });
          if (dataUrl) {
            await window.qooti.setCollectionProfileImage(row.collection.id, dataUrl);
            toast(t("ctx.profileImageSet", colLang), { variant: "success" });
            collectionsPageRows = await loadCollectionsPageRows();
            renderCollectionsPage(collectionsPageRows);
          }
        };
        input.click();
      }
    }
  );

  if (!isDefaultUnsorted) {
    items.push({
      icon: CTX_ICONS.delete,
      label: "Delete",
      danger: true,
      action: async () => {
        hideContextMenu();
        const label = truncateForDialog(collectionDisplayName || "Collection", 50);
        const choice = await showCollectionDeleteChoice({ collectionName: label });
        if (choice === "cancel") return;
        if (choice === "collection_and_media") {
          const itemsInCollection = (await window.qooti.listInspirations({ collectionId: row.collection.id })) || [];
          const mediaIds = itemsInCollection.map((it) => it?.id).filter(Boolean);
          for (const mediaId of mediaIds) {
            // Sequential deletion avoids overwhelming IPC and keeps file cleanup deterministic.
            await window.qooti.deleteInspiration(mediaId);
          }
          await window.qooti.deleteCollection(row.collection.id);
          await unmarkStoreCollectionInstalledByLocalCollectionId(row.collection.id);
          toast(`Deleted collection and ${mediaIds.length} media item${mediaIds.length === 1 ? "" : "s"}`, {
            durationMs: 3200,
            variant: "success"
          });
        } else {
          await window.qooti.deleteCollection(row.collection.id);
          await unmarkStoreCollectionInstalledByLocalCollectionId(row.collection.id);
          const unsortedLabel = t("collections.unsorted", colLang);
          toast(`Collection deleted. Media moved to ${unsortedLabel}.`, {
            durationMs: 3200,
            variant: "success"
          });
        }
        if (state.view === `collection:${row.collection.id}`) {
          state.view = "all";
          state.currentCollectionId = null;
          state.currentCollectionName = null;
          updateCollectionViewBar();
          showCollectionsView();
        }
        collectionsPageRows = await loadCollectionsPageRows();
        renderCollectionsPage(collectionsPageRows);
      }
    });
  }

  const visibleOnHome = row.collection?.visible_on_home !== false;
  items.push({
    icon: CTX_ICONS.home,
    labelKey: visibleOnHome ? "ctx.hideFromHomePage" : "ctx.showOnHomePage",
    action: async () => {
      hideContextMenu();
      await window.qooti.setCollectionVisibleOnHome(row.collection.id, !visibleOnHome);
      await refreshData();
      collectionsPageRows = await loadCollectionsPageRows();
      renderCollectionsPage(collectionsPageRows);
    }
  });

  for (const mi of items) {
    const rowEl = document.createElement("div");
    rowEl.className = "context-menu__item" + (mi.danger ? " context-menu__item--danger" : "");
    const labelText = mi.labelKey ? t(mi.labelKey, colLang) : mi.label;
    rowEl.innerHTML = `<span class="context-menu__icon">${mi.icon}</span><span class="context-menu__label">${escapeHtml(labelText)}</span>`;
    rowEl.addEventListener("click", mi.action);
    content.appendChild(rowEl);
  }

  menu.classList.remove("hidden");
  let x = e.clientX;
  let y = e.clientY;
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function buildCollectionSubmenu(item) {
  return (submenu) => {
    let membershipIds = new Set();

    const renderRows = () => {
      submenu.innerHTML = "";
      const truncateSubmenuName = (value) => {
        const chars = Array.from(String(value || ""));
        if (chars.length <= 12) return String(value || "");
        return `${chars.slice(0, 12).join("")}...`;
      };

      for (const c of state.collections) {
        const displayName = getCollectionDisplayName(c);
        const submenuLabel = truncateSubmenuName(displayName);
        const isMember = membershipIds.has(c.id);
        const row = document.createElement("div");
        row.className = "context-menu__submenu-item";
        row.innerHTML = `
          <span class="context-menu__submenu-icon">${isMember ? CTX_ICONS.collectionAdded : CTX_ICONS.collectionAdd}</span>
          <span class="context-menu__submenu-label">${escapeHtml(submenuLabel)}</span>
        `;
        row.addEventListener("click", async (e) => {
          e.stopPropagation();
          const subLang = state.settings?.language || "en";
          uilog("ctxAddToCollection", "clicked", displayName);
          hideContextMenu();
          try {
            if (isMember) {
              await window.qooti.removeFromCollection(c.id, item.id);
            } else {
              await window.qooti.addToCollection(c.id, [item.id]);
              recordEngagementAfterCollectionAdd(item);
            }
            await refreshData();
            await loadInspirations(false);
            toast(
              isMember
                ? `Removed from ${displayName}`
                : t("ctx.addedToCollection", subLang).replace("%s", displayName),
              { durationMs: 2800, variant: "success" }
            );
            uilog("ctxAddToCollection", "done", displayName);
          } catch (err) {
            uilog("ctxAddToCollection", "error", err?.message || String(err));
            toast(err?.message || t("ctx.couldNotAddToCollection", subLang), { variant: "error" });
          }
        });
        submenu.appendChild(row);
      }

      if (state.collections.length > 0) {
        const div = document.createElement("div");
        div.className = "context-menu__divider";
        submenu.appendChild(div);
      }

      const ctxLang = state.settings?.language || "en";
      const newRow = document.createElement("div");
      newRow.className = "context-menu__submenu-item";
      newRow.innerHTML = `
        <span class="context-menu__submenu-icon">${CTX_ICONS.newCollection}</span>
        <span class="context-menu__submenu-label">${escapeHtml(t("ctx.newCollection", ctxLang))}</span>
      `;
      newRow.addEventListener("click", async (e) => {
        e.stopPropagation();
        hideContextMenu();
        const name = await showPrompt({ message: t("ctx.collectionName", ctxLang), defaultValue: t("ctx.newCollection", ctxLang), submitLabel: t("ctx.create", ctxLang) });
        if (!name) return;
        const col = await window.qooti.createCollection(name);
        await window.qooti.addToCollection(col.id, [item.id]);
        recordEngagementAfterCollectionAdd(item);
        await refreshData();
        await loadInspirations(false);
        toast(t("ctx.addedToCollection", ctxLang).replace("%s", name), { durationMs: 2800, variant: "success" });
      });
      submenu.appendChild(newRow);
    };

    renderRows();
    if (item?.id && window.qooti?.getCollectionsForInspiration) {
      window.qooti
        .getCollectionsForInspiration(item.id)
        .then((cols) => {
          membershipIds = new Set((Array.isArray(cols) ? cols : []).map((c) => c?.id).filter(Boolean));
          renderRows();
        })
        .catch(() => {});
    }
  };
}

async function promptRename(item) {
  const lang = state.settings?.language || "en";
  const newTitle = await showPrompt({ message: t("ctx.renamePrompt", lang), defaultValue: item.title || "", submitLabel: t("ctx.rename", lang) });
  if (newTitle == null) return;
  await window.qooti.updateInspiration(item.id, { title: newTitle.trim() });
  await loadInspirations();
  toast(t("ctx.renamed", lang), { variant: "success" });
}

async function showEditTagsModal(item, options = {}) {
  uilog("editTags", "showEditTagsModal entered");
  const { returnToPreview = false } = options;
  // Use fresh item from state so tags added via quick tags are visible
  const fresh = item?.id && state.inspirations?.find((i) => i.id === item.id);
  const it = fresh && Array.isArray(fresh.tags) ? fresh : item;
  const wrap = document.createElement("div");
  wrap.className = "app-modal app-modal--tags";
  wrap.innerHTML = `
    <div class="app-modal__backdrop"></div>
    <div class="app-modal__dialog app-modal__dialog--wide">
      <div class="app-modal__header">
        <h3 class="app-modal__title">Edit</h3>
      </div>
      <div class="app-modal__body">
        <div class="tags-title-row">
          <label class="tags-label">Title</label>
          <input type="text" class="field__input tags-title-input" placeholder="Media title" value="" />
        </div>
        <div class="tags-current">
          <label class="tags-label">Tags</label>
          <div class="tags-chips"></div>
        </div>
        <div class="tags-add">
          <label class="tags-label">Add tag</label>
          <div class="tags-add-row">
            <input type="text" class="field__input tags-input" placeholder="Type new tag or select below" autocomplete="off" />
            <button type="button" class="btn btn--primary tags-add-btn">Add</button>
          </div>
          <div class="tags-available"></div>
        </div>
      </div>
      <div class="app-modal__footer">
        <button type="button" class="btn btn--secondary app-modal__btn-cancel">Cancel changes</button>
        <button type="button" class="btn btn--primary app-modal__btn-save">Save changes</button>
      </div>
    </div>
  `;

  const titleEl = wrap.querySelector(".tags-title-input");
  const chipsEl = wrap.querySelector(".tags-chips");
  const inputEl = wrap.querySelector(".tags-input");
  const addBtn = wrap.querySelector(".tags-add-btn");
  const availableEl = wrap.querySelector(".tags-available");

  if (titleEl) {
    titleEl.value = (it.title ?? "") || "";
  }

  async function saveTitleAndClose() {
    if (titleEl) {
      const v = (titleEl.value ?? "").trim();
      const prev = (it.title ?? "").trim();
      if (v !== prev) {
        try {
          await window.qooti.updateInspiration(it.id, { title: v });
          it.title = v || null;
        } catch (e) {
          toast(e?.message || "Could not update title", { variant: "error" });
          return;
        }
      }
    }
    closeModal(true);
  }

  const currentIds = new Set((it.tags || []).map((t) => t.id));

  function renderChips() {
    chipsEl.innerHTML = "";
    for (const t of it.tags || []) {
      const chip = document.createElement("span");
      chip.className = "tags-chip" + (t.origin === "system" ? " tags-chip--system" : "");
      chip.textContent = t.label;
      if (t.origin === "user") {
        const x = document.createElement("button");
        x.type = "button";
        x.className = "tags-chip-remove";
        x.textContent = "×";
        x.addEventListener("click", async () => {
          await window.qooti.detachTagFromInspiration(it.id, t.id);
          it.tags = (it.tags || []).filter((x) => x.id !== t.id);
          renderChips();
          renderAvailable();
        });
        chip.appendChild(x);
      }
      chipsEl.appendChild(chip);
    }
  }

  async function renderAvailable() {
    const all = await window.qooti.listTags();
    const userTags = all.filter((t) => t.origin === "user" && !currentIds.has(t.id));
    availableEl.innerHTML = "";
    for (const t of userTags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn--sm tags-available-btn";
      btn.textContent = t.label;
      btn.addEventListener("click", async () => {
        await window.qooti.attachTagToInspiration(it.id, t.id);
        it.tags = it.tags || [];
        it.tags.push(t);
        currentIds.add(t.id);
        renderChips();
        renderAvailable();
      });
      availableEl.appendChild(btn);
    }
  }

  async function addNewTag(label) {
    const trimmed = (label || "").trim();
    if (!trimmed) return;
    try {
      const tag = await window.qooti.createUserTag(trimmed, "style");
      await window.qooti.attachTagToInspiration(it.id, tag.id);
      it.tags = it.tags || [];
      it.tags.push(tag);
      currentIds.add(tag.id);
      inputEl.value = "";
      renderChips();
      renderAvailable();
    } catch (e) {
      toast(e?.message || "Could not add tag", { variant: "error" });
    }
  }

  addBtn.addEventListener("click", () => addNewTag(inputEl.value));
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addNewTag(inputEl.value);
  });

  renderChips();
  await renderAvailable();

  function closeModal(restorePreview) {
    uilog("editTags", "modal closed");
    wrap.remove();
    if (restorePreview && returnToPreview && it) showMediaPreview(it);
  }
  wrap.querySelector(".app-modal__backdrop").addEventListener("click", () => closeModal(false));
  wrap.querySelector(".app-modal__btn-cancel").addEventListener("click", () => closeModal(true));
  wrap.querySelector(".app-modal__btn-save").addEventListener("click", () => saveTitleAndClose());
  document.body.appendChild(wrap);
  (titleEl || inputEl).focus();
}

async function showFindSimilarModal(item) {
  if (item?.id) recordItemEngagement(item, "similar_source");
  uilog("findRelated", "showFindSimilarModal entered");
  if (!item?.id) return;
  const wrap = document.createElement("div");
  wrap.className = "app-modal app-modal--find-similar";
  wrap.innerHTML = `
    <div class="app-modal__backdrop"></div>
    <div class="app-modal__dialog app-modal__dialog--wide">
      <div class="app-modal__header">
        <h3 class="app-modal__title"><span class="ui-icon ui-icon--sm" style="--icon-url:url('./assets/icons/remix/bard-fill.svg');vertical-align:middle;margin-right:6px" aria-hidden="true"></span>Find related</h3>
        <button type="button" class="app-modal__close" aria-label="Close">&times;</button>
      </div>
      <div class="app-modal__body">
        <div class="find-similar-loading">Finding related…</div>
        <div class="find-similar-grid hidden"></div>
        <div class="find-similar-empty hidden">No similar items found. Add more media and try again.</div>
      </div>
    </div>
  `;

  const loadingEl = wrap.querySelector(".find-similar-loading");
  const gridEl = wrap.querySelector(".find-similar-grid");
  const emptyEl = wrap.querySelector(".find-similar-empty");

  const closeModal = () => {
    uilog("findRelated", "modal closed");
    if (wrap.parentNode) wrap.remove();
  };

  wrap.querySelector(".app-modal__backdrop").addEventListener("click", closeModal);
  wrap.querySelector(".app-modal__close").addEventListener("click", closeModal);
  document.body.appendChild(wrap);

  try {
    uilog("findRelated", "invoking findSimilar");
    const similar = await window.qooti.findSimilar(item.id, 24);
    uilog("findRelated", "findSimilar resolved", `(${similar?.length ?? 0} items)`);
    if (!wrap.parentNode) return;
    loadingEl.classList.add("hidden");
    if (similar.length === 0) {
      gridEl.classList.add("hidden");
      emptyEl.textContent = "No related items found. Add tags or add more images (palette is extracted automatically for images).";
      emptyEl.classList.remove("hidden");
    } else {
      emptyEl.classList.add("hidden");
      gridEl.classList.remove("hidden");
      similar.forEach((s, i) => {
        const card = buildCard(s);
        card.classList.add("find-similar-card", "find-similar-card--stagger");
        card.style.setProperty("--stagger-index", String(i));
        card.addEventListener("click", () => {
          closeModal();
          showMediaPreview(s);
        });
        gridEl.appendChild(card);
      });
    }
  } catch (e) {
    if (!wrap.parentNode) return;
    loadingEl.classList.add("hidden");
    gridEl.classList.add("hidden");
    emptyEl.textContent = e?.message || "Could not find related items.";
    emptyEl.classList.remove("hidden");
  }
}

// Modal system — single backdrop listener to avoid accumulation
let _modalRootBackdropHandler = null;
function showModal(contentEl) {
  uilog("modal", "showModal");
  const root = $("#modalRoot");
  if (!root) return;
  root.innerHTML = "";
  root.classList.remove("hidden");
  root.setAttribute("aria-hidden", "false");
  root.appendChild(contentEl);
  if (!_modalRootBackdropHandler) {
    _modalRootBackdropHandler = (e) => {
      if (e.target === root) hideModal();
    };
    root.addEventListener("click", _modalRootBackdropHandler);
  }
}

const MODAL_CLOSE_MS = 180;

function hideModal() {
  uilog("modal", "hideModal");
  const root = $("#modalRoot");
  if (!root) return;
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) {
    root.classList.add("hidden");
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = "";
    return;
  }
  root.classList.add("modal-root--closing");
  const doHide = () => {
    root.classList.remove("modal-root--closing");
    root.classList.add("hidden");
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = "";
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setTimeout(doHide, MODAL_CLOSE_MS);
    });
  });
}

/** Truncate text for display in dialogs (avoid long captions overflowing) */
function truncateForDialog(str, maxLen = 60) {
  if (!str || typeof str !== "string") return str;
  const s = str.trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\u2026";
}

/** Custom confirm dialog - returns Promise<boolean> */
function showConfirm({ message, confirmLabel = "OK", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--confirm";
    wrap.innerHTML = `
      <div class="app-modal__backdrop"></div>
      <div class="app-modal__dialog">
        <div class="app-modal__body"></div>
        <div class="app-modal__footer">
          <button type="button" class="btn app-modal__cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn ${danger ? "btn--danger-min" : "btn--primary"} app-modal__confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    const bodyEl = wrap.querySelector(".app-modal__body");
    const msgEl = document.createElement("div");
    msgEl.className = "app-modal__message";
    msgEl.textContent = message;
    bodyEl.appendChild(msgEl);

    const finish = (result) => {
      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReduced) {
        wrap.remove();
        resolve(result);
        return;
      }
      wrap.classList.add("app-modal--closing");
      const doFinish = () => {
        wrap.remove();
        resolve(result);
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(doFinish, MODAL_CLOSE_MS);
        });
      });
    };

    const handleEscape = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        document.removeEventListener("keydown", handleEscape);
        finish(false);
      }
    };
    document.addEventListener("keydown", handleEscape);

    wrap.querySelector(".app-modal__backdrop").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish(false);
    });
    wrap.querySelector(".app-modal__cancel").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish(false);
    });
    wrap.querySelector(".app-modal__confirm").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish(true);
    });

    document.body.appendChild(wrap);
  });
}

/**
 * Collection delete chooser.
 * Returns:
 *  - "collection_only": keep media and let backend place unassigned items into Unsorted
 *  - "collection_and_media": delete collection and all media inside it
 *  - "cancel"
 */
function showCollectionDeleteChoice({ collectionName }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--confirm app-modal--collection-delete";
    wrap.innerHTML = `
      <div class="app-modal__backdrop"></div>
      <div class="app-modal__dialog">
        <div class="app-modal__body"></div>
        <div class="app-modal__footer">
          <button type="button" class="btn app-modal__cancel">Cancel</button>
        </div>
      </div>
    `;
    const bodyEl = wrap.querySelector(".app-modal__body");
    const titleEl = document.createElement("div");
    titleEl.className = "app-modal__collection-delete-title";
    titleEl.textContent = `Delete "${collectionName}"`;
    bodyEl.appendChild(titleEl);
    const msgEl = document.createElement("div");
    msgEl.className = "app-modal__message";
    msgEl.textContent = "Choose what to do with media in this collection.";
    bodyEl.appendChild(msgEl);
    const actionsEl = document.createElement("div");
    actionsEl.className = "app-modal__collection-delete-actions";
    actionsEl.innerHTML = `
      <button type="button" class="btn btn--secondary app-modal__collection-only">
        <span class="app-modal__collection-delete-btn-title">Delete collection only</span>
        <span class="app-modal__collection-delete-btn-note">Move media to ${escapeHtml(
          t("collections.unsorted", state.settings?.language || "en")
        )}</span>
      </button>
      <button type="button" class="btn btn--danger-min app-modal__collection-and-media">
        <span class="app-modal__collection-delete-btn-title">Delete collection + media</span>
        <span class="app-modal__collection-delete-btn-note">Remove this collection and its media files</span>
      </button>
    `;
    bodyEl.appendChild(actionsEl);

    const finish = (result) => {
      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReduced) {
        wrap.remove();
        resolve(result);
        return;
      }
      wrap.classList.add("app-modal--closing");
      const doFinish = () => {
        wrap.remove();
        resolve(result);
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(doFinish, MODAL_CLOSE_MS);
        });
      });
    };

    const handleEscape = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        document.removeEventListener("keydown", handleEscape);
        finish("cancel");
      }
    };
    document.addEventListener("keydown", handleEscape);

    wrap.querySelector(".app-modal__backdrop").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish("cancel");
    });
    wrap.querySelector(".app-modal__cancel").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish("cancel");
    });
    wrap.querySelector(".app-modal__collection-only").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish("collection_only");
    });
    wrap.querySelector(".app-modal__collection-and-media").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish("collection_and_media");
    });

    document.body.appendChild(wrap);
  });
}

/** Custom prompt dialog - returns Promise<string|null> */
function showPrompt({ message, defaultValue = "", placeholder = "", submitLabel = "OK", cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--prompt";
    wrap.innerHTML = `
      <div class="app-modal__backdrop"></div>
      <div class="app-modal__dialog">
        <div class="app-modal__body">
          <div class="app-modal__message"></div>
          <input type="text" class="field__input app-modal__input" autocomplete="off" />
        </div>
        <div class="app-modal__footer">
          <button type="button" class="btn app-modal__cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn btn--primary app-modal__submit">${escapeHtml(submitLabel)}</button>
        </div>
      </div>
    `;
    wrap.querySelector(".app-modal__message").textContent = message;
    const input = wrap.querySelector(".app-modal__input");
    input.value = defaultValue;
    input.placeholder = placeholder;

    const finish = (result) => {
      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReduced) {
        wrap.remove();
        resolve(result);
        return;
      }
      wrap.classList.add("app-modal--closing");
      const doFinish = () => {
        wrap.remove();
        resolve(result);
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(doFinish, MODAL_CLOSE_MS);
        });
      });
    };

    const handleEscape = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        document.removeEventListener("keydown", handleEscape);
        finish(null);
      }
    };
    document.addEventListener("keydown", handleEscape);

    wrap.querySelector(".app-modal__backdrop").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish(null);
    });
    wrap.querySelector(".app-modal__cancel").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish(null);
    });
    wrap.querySelector(".app-modal__submit").addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish(input.value.trim() || null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        document.removeEventListener("keydown", handleEscape);
        finish(input.value.trim() || null);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        document.removeEventListener("keydown", handleEscape);
        finish(null);
      }
    });

    document.body.appendChild(wrap);
    setTimeout(() => input.focus(), 50);
  });
}

function inspirationPaletteIsEmpty(it) {
  if (!it) return true;
  const p = it.palette;
  if (p == null) return true;
  if (Array.isArray(p)) return p.length === 0;
  return false;
}

function mediaItemSupportsPaletteExtract(it) {
  if (!it?.id) return false;
  const ty = String(it.type || "").toLowerCase();
  return ty === "image" || ty === "link";
}

/** Runs backend palette extraction, refreshes grid + preview, optional callback after success. */
async function extractPaletteForInspiration(item, onAfter, options = {}) {
  const { silent = false, skipReload = false } = options || {};
  const lang = state.settings?.language || "en";
  if (!item?.id || typeof window.qooti?.extractPalette !== "function") {
    if (!silent) toast(t("preview.paletteExtractFailed", lang), { variant: "error" });
    return false;
  }
  try {
    const ok = await window.qooti.extractPalette(item.id);
    if (ok) {
      if (!silent) toast(t("preview.paletteExtracted", lang), { variant: "success" });
      if (!skipReload) await loadInspirations(false);
      refreshMediaPreviewItemFromState();
      if (mediaPreviewItem?.id === item.id) syncMediaPreviewActionState(mediaPreviewItem);
      if (typeof onAfter === "function") await onAfter();
      return true;
    }
    if (!silent) toast(t("preview.paletteExtractFailed", lang), { variant: "warning" });
    return false;
  } catch (err) {
    if (!silent) toast(err?.message || t("preview.paletteExtractFailed", lang), { variant: "error" });
    return false;
  }
}

function showOcrDebugModal(item, forceRefresh = false) {
  if (!item?.id) return;
  const wrap = document.createElement("div");
  wrap.className = "app-modal app-modal--ocr-debug";
  wrap.innerHTML = `
    <div class="app-modal__backdrop"></div>
    <div class="app-modal__dialog app-modal__dialog--wide ocr-debug-modal">
      <div class="app-modal__body ocr-debug-modal__body">
        <div class="ocr-debug-modal__title">OCR Debug</div>
        <div class="ocr-debug-modal__meta">Loading OCR details for this media item…</div>
        <div class="ocr-debug-modal__palette hidden">
          <div class="ocr-debug-modal__palette-head">
            <div class="ocr-debug-modal__palette-label">Extracted colors</div>
            <button type="button" class="btn btn--sm btn--secondary ocr-debug-extract-palette hidden" data-i18n="preview.extractColors">Extract colors</button>
          </div>
          <p class="ocr-debug-modal__palette-empty-msg hidden" data-i18n="ocrDebug.noPaletteYet">No palette stored yet.</p>
          <div class="ocr-debug-modal__swatches" role="list"></div>
        </div>
        <pre class="ocr-debug-modal__text">Loading…</pre>
      </div>
      <div class="app-modal__footer">
        <button type="button" class="btn app-modal__cancel ocr-debug-close">Close</button>
        <button type="button" class="btn btn--secondary ocr-debug-copy">Copy text</button>
        <button type="button" class="btn btn--primary ocr-debug-refresh">Re-run OCR</button>
      </div>
    </div>
  `;

  const metaEl = wrap.querySelector(".ocr-debug-modal__meta");
  const textEl = wrap.querySelector(".ocr-debug-modal__text");
  const paletteSectionEl = wrap.querySelector(".ocr-debug-modal__palette");
  const swatchesEl = wrap.querySelector(".ocr-debug-modal__swatches");
  const extractPaletteBtn = wrap.querySelector(".ocr-debug-extract-palette");
  const paletteEmptyMsgEl = wrap.querySelector(".ocr-debug-modal__palette-empty-msg");
  const refreshBtn = wrap.querySelector(".ocr-debug-refresh");
  const copyBtn = wrap.querySelector(".ocr-debug-copy");

  const close = () => wrap.remove();
  wrap.querySelector(".app-modal__backdrop").addEventListener("click", close);
  wrap.querySelector(".ocr-debug-close").addEventListener("click", close);

  const load = async (refresh = false) => {
    const shouldRefresh = false; // keep debug read-only; OCR refresh is handled by queue
    if (refresh) {
      try {
        await window.qooti?.resetOcrStatusForInspiration?.(item.id);
        ocrIndexSessionPaused = false;
        runOcrIndexLoop();
      } catch (e) {
        console.warn("[OCR DEBUG] reset status failed:", e?.message || e);
      }
    }
    forceRefresh = false;
    metaEl.textContent = "Reading OCR metadata…";
    textEl.textContent = "Loading…";
    refreshBtn.disabled = true;
    copyBtn.disabled = true;
    try {
      const data = await window.qooti?.getInspirationOcrDebug?.(item.id, shouldRefresh);
      const lines = [
        `ID: ${data?.id || item.id}`,
        `Type: ${data?.media_type || item.type || "unknown"}`,
        `OCR status: ${data?.ocr_status || "null"}`,
        `Can OCR: ${data?.can_attempt_ocr ? "yes" : "no"}`,
        `Token count: ${data?.token_count || 0}`,
        `Palette swatches: ${Array.isArray(data?.palette) ? data.palette.length : 0}`,
        `Image path: ${data?.analysis_path || "(none)"}`,
      ];
      metaEl.textContent = lines.join(" | ");
      const swatches = Array.isArray(data?.palette) ? data.palette : [];
      const canPalettePath = !!data?.can_attempt_ocr;
      const extractAvailable = typeof window.qooti?.extractPalette === "function";
      if (paletteSectionEl && swatchesEl) {
        if (swatches.length > 0) {
          paletteSectionEl.classList.remove("hidden");
          paletteEmptyMsgEl?.classList.add("hidden");
          extractPaletteBtn?.classList.add("hidden");
          swatchesEl.replaceChildren();
          swatches.forEach((s) => {
            const hex = String(s?.hex || "").trim() || "#000000";
            const row = document.createElement("div");
            row.className = "ocr-debug-modal__swatch-row";
            row.setAttribute("role", "listitem");
            const chip = document.createElement("div");
            chip.className = "ocr-debug-modal__swatch";
            chip.style.background = hex;
            chip.title = hex;
            const cap = document.createElement("div");
            cap.className = "ocr-debug-modal__swatch-cap";
            const l = Number(s?.lab_l);
            const a = Number(s?.lab_a);
            const b = Number(s?.lab_b);
            const labTxt = [l, a, b].every((n) => Number.isFinite(n))
              ? `L* ${l.toFixed(1)} · a* ${a.toFixed(1)} · b* ${b.toFixed(1)}`
              : "";
            cap.innerHTML = `<span class="ocr-debug-modal__swatch-hex">${escapeHtml(hex)}</span>${
              labTxt ? `<span class="ocr-debug-modal__swatch-lab">${escapeHtml(labTxt)}</span>` : ""
            }`;
            chip.title = labTxt ? `${hex} — ${labTxt}` : hex;
            row.appendChild(chip);
            row.appendChild(cap);
            swatchesEl.appendChild(row);
          });
        } else if (canPalettePath && extractAvailable) {
          paletteSectionEl.classList.remove("hidden");
          paletteEmptyMsgEl?.classList.remove("hidden");
          extractPaletteBtn?.classList.remove("hidden");
          swatchesEl.replaceChildren();
        } else {
          paletteSectionEl.classList.add("hidden");
          paletteEmptyMsgEl?.classList.add("hidden");
          extractPaletteBtn?.classList.add("hidden");
          swatchesEl.replaceChildren();
        }
      }
      const text = String(data?.ocr_text || "").trim();
      textEl.textContent = text || "(No OCR text saved for this image yet)";
      copyBtn.disabled = !text;
      console.info("[OCR DEBUG]", data);
    } catch (err) {
      const msg = err?.message || String(err);
      metaEl.textContent = "Failed to load OCR debug info.";
      textEl.textContent = msg;
      console.error("[OCR DEBUG] failed", msg);
    } finally {
      refreshBtn.disabled = false;
    }
  };

  copyBtn.addEventListener("click", async () => {
    try {
      await writeTextToClipboard(textEl.textContent || "");
      toast("OCR text copied", { variant: "success" });
    } catch (err) {
      toast(err?.message || "Could not copy OCR text", { variant: "error" });
    }
  });
  refreshBtn.addEventListener("click", async () => {
    await load(true);
    // Give queue a moment to process, then re-read debug state.
    setTimeout(() => load(false), 1000);
    setTimeout(() => load(false), 2500);
  });

  extractPaletteBtn?.addEventListener("click", async () => {
    extractPaletteBtn.disabled = true;
    try {
      await extractPaletteForInspiration(item, async () => {
        await load(false);
      });
    } finally {
      extractPaletteBtn.disabled = false;
    }
  });

  document.body.appendChild(wrap);
  applyTranslations();
  load(forceRefresh);
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// Expose for modals and other modules
window.qootiShowConfirm = showConfirm;
window.qootiShowPrompt = showPrompt;

function modal({ title, bodyEl, actions = [] }) {
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.innerHTML = `
    <div class="modal__header">
      <div class="modal__title"></div>
      <button class="modal__close" data-close aria-label="Close">
        ${remixIcon("close-line.svg", "ui-icon ui-icon--sm")}
      </button>
    </div>
    <div class="modal__body"></div>
    <div class="modal__footer"></div>
  `;
  wrap.querySelector(".modal__title").textContent = title;
  wrap.querySelector(".modal__body").appendChild(bodyEl);
  const footer = wrap.querySelector(".modal__footer");
  for (const a of actions) footer.appendChild(a);
  wrap.querySelector("[data-close]").addEventListener("click", hideModal);
  return wrap;
}

// Add Surface state
let pendingLinkPreview = null; // { url, title, thumbnailUrl }

function showAddSurface() {
  const surface = $("#addSurface");
  surface.classList.remove("hidden");
  showAddZone();
  const input = $("#addInput");
  input.value = "";
  setTimeout(() => input.focus(), 50);
}

function hideAddSurface() {
  const surface = $("#addSurface");
  surface.classList.add("hidden");
  $("#addInput").value = "";
  pendingLinkPreview = null;
  showAddZone();
}

function showAddZone() {
  $("#addZone").classList.remove("hidden");
  $("#addPreview").classList.add("hidden");
}

function platformLabel(type) {
  const t = (type || "").toLowerCase();
  if (t === "youtube") return "YouTube";
  if (t === "instagram") return "Instagram";
  return t || "Link";
}

function showAddPreview(preview) {
  pendingLinkPreview = preview;
  $("#addZone").classList.add("hidden");
  $("#addPreview").classList.remove("hidden");
  setPreviewDownloading(false);

  const thumbEl = $("#previewThumb");
  const titleEl = $("#previewTitle");
  const sourceEl = $("#previewSource");
  const platformBadge = $("#previewPlatformBadge");
  const durationBadge = $("#previewDurationBadge");
  const downloadBtn = $("#previewDownloadVideo");
  const confirmBtn = $("#previewConfirm");
  const thumbBtn = $("#previewAddThumb");
  const addAsLinkBtn = $("#previewAddAsLink");
  const secondaryRow = $("#previewSecondaryActions");
  const recommendedLabel = $("#previewRecommended");

  if (preview.thumbnailUrl) {
    thumbEl.src = preview.thumbnailUrl;
    thumbEl.style.display = "block";
  } else {
    thumbEl.style.display = "none";
  }

  titleEl.textContent = preview.title || "";
  sourceEl.textContent = preview.url ? domainFromUrl(preview.url) : "";

  if (platformBadge) {
    platformBadge.textContent = platformLabel(preview.type);
    platformBadge.classList.remove("hidden");
  }
  if (durationBadge) {
    const dur = preview.duration;
    if (dur) {
      durationBadge.textContent = formatDuration(dur);
      durationBadge.classList.remove("hidden");
    } else {
      durationBadge.classList.add("hidden");
    }
  }

  const canAddThumb = preview.type === "youtube" || preview.type === "instagram";
  const canDownloadVideo = preview.type === "youtube" || preview.type === "instagram";

  if (canDownloadVideo) {
    downloadBtn?.classList.remove("hidden");
    confirmBtn?.classList.add("hidden");
    recommendedLabel?.classList.remove("hidden");
    if (secondaryRow) secondaryRow.classList.remove("hidden");
    if (thumbBtn) thumbBtn.classList.toggle("hidden", !canAddThumb);
    if (addAsLinkBtn) addAsLinkBtn.classList.remove("hidden");
    setTimeout(() => downloadBtn?.focus(), 0);
  } else {
    downloadBtn?.classList.add("hidden");
    confirmBtn?.classList.remove("hidden");
    recommendedLabel?.classList.add("hidden");
    if (secondaryRow) secondaryRow.classList.add("hidden");
    setTimeout(() => confirmBtn?.focus(), 0);
  }
}

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `0:${s.toString().padStart(2, "0")}`;
}

function setPreviewDownloading(active) {
  const downloadingEl = $("#previewDownloading");
  const cancelBtn = $("#previewCancel");
  if (!downloadingEl) return;
  if (active) {
    $("#previewDownloadVideo")?.classList.add("hidden");
    $("#previewConfirm")?.classList.add("hidden");
    $("#previewAddAsLink")?.classList.add("hidden");
    $("#previewAddThumb")?.classList.add("hidden");
    downloadingEl.classList.remove("hidden");
    cancelBtn?.setAttribute("disabled", "");
  } else {
    downloadingEl.classList.add("hidden");
    cancelBtn?.removeAttribute("disabled");
    if (pendingLinkPreview) {
      const p = pendingLinkPreview;
      const canDownload = p.type === "youtube" || p.type === "instagram";
      const canAddThumb = canDownload;
      $("#previewDownloadVideo")?.classList.toggle("hidden", !canDownload);
      $("#previewConfirm")?.classList.toggle("hidden", canDownload);
      $("#previewRecommended")?.classList.toggle("hidden", !canDownload);
      $("#previewSecondaryActions")?.classList.toggle("hidden", !canDownload);
      $("#previewAddThumb")?.classList.toggle("hidden", !canAddThumb);
      $("#previewAddAsLink")?.classList.toggle("hidden", !canDownload);
    }
  }
}

function isAddSurfaceVisible() {
  return !$("#addSurface").classList.contains("hidden");
}

const MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "tiff", "tif", "heic", "gif", "mp4", "mov", "mkv", "webm", "avi", "wmv", "m4v"]);

function isQootiPath(path) {
  return /\.qooti$/i.test(String(path || "").trim());
}

function getFileExtension(path) {
  const m = /(?:\.([^.\\/]+))$/.exec(String(path || "").trim());
  return m ? m[1].toLowerCase() : "";
}

async function importMediaPaths(paths) {
  if (!paths || paths.length === 0) return { addedCount: 0, skipped: 0 };
  const importFn = window.qooti?.importMediaFromPaths ?? window.qooti?.addInspirationsFromPaths;
  if (!importFn) return { addedCount: 0, skipped: 0 };
  const result = await importFn(paths);
  const list = Array.isArray(result) ? result : (result?.added ?? []);
  const skipped = Number(result?.skipped ?? 0);
  if (list.length > 0) {
    const first = list[0];
    const item = first ? { id: first.id, type: first.type, title: first.title, tags: first.tags || [] } : null;
    const msg = list.length === 1 ? "Added" : `${list.length} items added`;
    const suffix = skipped > 0 ? " (some skipped)" : "";
    notifyMediaAdd(msg + suffix, {
      durationMs: 3200,
      item: list.length === 1 ? item : null,
      variant: skipped > 0 ? "warning" : "success"
    });
  } else if (skipped > 0) {
    notifyMediaAdd("Some files were skipped", { variant: "warning" });
  }
  return { addedCount: list.length, skipped };
}

async function classifyImportPaths(paths) {
  const clean = (Array.isArray(paths) ? paths : []).map((p) => String(p || "").trim()).filter(Boolean);
  const qootiPaths = [];
  const mediaPaths = [];
  const telegramFolders = [];
  const ignored = [];

  for (const path of clean) {
    if (isQootiPath(path)) {
      qootiPaths.push(path);
      continue;
    }
    const ext = getFileExtension(path);
    if (ext && MEDIA_EXTENSIONS.has(ext)) {
      mediaPaths.push(path);
      continue;
    }
    // Likely folder path (e.g., Telegram export drop); validate via backend.
    try {
      const preview = await window.qooti.inspectTelegramExport(path);
      if (preview?.isValid) {
        telegramFolders.push({ path, preview });
        continue;
      }
    } catch (_) {}
    ignored.push(path);
  }

  return { qootiPaths, mediaPaths, telegramFolders, ignored };
}

// Unified import entry for drop/browse: media, .qooti, and Telegram folders.
async function addFromPaths(paths) {
  if (!paths || paths.length === 0) return;

  const { qootiPaths, mediaPaths, telegramFolders, ignored } = await classifyImportPaths(paths);
  let hadAnySuccess = false;

  // .qooti packages
  for (const packPath of qootiPaths) {
    try {
      await openImportCollectionPackFlow(packPath);
      hadAnySuccess = true;
    } catch (err) {
      notifyMediaAdd(err?.message || "Could not import .qooti package", { variant: "error" });
    }
  }

  // Telegram export folders
  for (const folder of telegramFolders) {
    try {
      await openTelegramImportFlow(folder.path, folder.preview);
      hadAnySuccess = true;
    } catch (err) {
      notifyMediaAdd(err?.message || "Could not import Telegram export", { variant: "error" });
    }
  }

  // Normal media files
  if (mediaPaths.length > 0) {
    showDownloadIndicator("Adding…", { mode: "generic" });
    try {
      const res = await importMediaPaths(mediaPaths);
      hadAnySuccess = hadAnySuccess || res.addedCount > 0;
      // Yield so UI can paint, then refresh grid (avoids blocking main thread)
      await new Promise((r) => requestAnimationFrame(r));
      await refreshData();
      await loadInspirations();
      if (res.addedCount > 0) scheduleOcrAutoIndex();
      scheduleDelayedRefreshForNewItems();
    } catch (err) {
      console.error("Add from paths error:", err);
      notifyMediaAdd("Could not add files", { variant: "error" });
      try {
        await refreshData();
        await loadInspirations();
      } catch (_) {}
    } finally {
      hideDownloadIndicator();
    }
  }

  if (!hadAnySuccess && ignored.length > 0) {
    notifyMediaAdd("No supported import targets found", { variant: "warning" });
  }
}

async function fetchAndShowLinkPreview(url) {
  if (!url) return;
  const trimmed = url.trim();
  if (!trimmed) return;

  // Normalize www. URLs
  const finalUrl = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;

  try {
    const preview = await window.qooti.fetchLinkPreview(finalUrl);
    if (preview) {
      showAddPreview(preview);
    }
  } catch (err) {
    console.error("Fetch preview error:", err);
  }
}

async function confirmAddLink() {
  if (!pendingLinkPreview) return;
  
  try {
    const result = await window.qooti.addLinkInspiration(pendingLinkPreview.url, {
      title: pendingLinkPreview.title,
      thumbnailUrl: pendingLinkPreview.thumbnailUrl,
      aspectRatio: pendingLinkPreview.aspectRatio ?? null
    });
    if (result) {
      const item = result?.inspiration ?? (result?.id ? { id: result.id, type: "link", title: pendingLinkPreview?.title ?? null, tags: [] } : null);
      notifyMediaAdd("Added", { durationMs: 3200, item, variant: "success" });
      await refreshData();
      await loadInspirations();
      maybeScheduleOcrForItemType(item?.type || "link");
      scheduleDelayedRefreshForNewItems();
    } else {
      notifyMediaAdd("Add link failed", { variant: "error" });
    }
  } catch (err) {
    console.error("Add link error:", err);
    notifyMediaAdd("Add link failed", { variant: "error" });
  }
  
  pendingLinkPreview = null;
  hideAddSurface();
}

async function addThumbnailFromPreview() {
  if (!pendingLinkPreview) return;
  if (pendingLinkPreview.type !== "youtube" && pendingLinkPreview.type !== "instagram") return;
  const title = pendingLinkPreview.title || pendingLinkPreview.url;
  const videoUrl = pendingLinkPreview.url;

  hideAddSurface();
  showDownloadIndicator("Downloading thumbnail…", { mode: "generic" });
  try {
    const result = await window.qooti.addThumbnailFromVideoUrl(videoUrl, title);
    if (result) {
      updateDownloadIndicator(100);
      const item = result?.id ? { id: result.id, type: result.type || "image", title: result.title, tags: result.tags || [] } : null;
      notifyMediaAdd("Added", { durationMs: 3200, item, variant: "success" });
      pendingLinkPreview = null;
      await refreshData();
      await loadInspirations();
      maybeScheduleOcrForItemType(item?.type);
      scheduleDelayedRefreshForNewItems();
    } else {
      notifyMediaAdd("Failed to add thumbnail", { variant: "error" });
    }
  } catch (err) {
    console.error("Add thumbnail error:", err);
    notifyMediaAdd("Failed to add thumbnail", { variant: "error" });
  } finally {
    hideDownloadIndicator();
  }
}

function showDownloadIndicator(label, options = {}) {
  const lang = state.settings?.language || "en";
  downloadIndicatorState.active = true;
  downloadIndicatorState.label =
    label != null && String(label).trim() !== "" ? String(label) : t("download.downloadingVideo", lang);
  downloadIndicatorState.percent = 0;
  downloadIndicatorState.mode = options.mode === "video" ? "video" : "generic";
  downloadIndicatorState.paused = false;
  syncBottomCenterIndicators();
}

function renderDownloadIndicator() {
  const el = $("#downloadIndicator");
  const labelEl = $("#downloadIndicatorLabel");
  const actions = $("#downloadIndicatorActions");
  const pauseBtn = $("#downloadIndicatorPauseBtn");
  const pauseImg = $("#downloadIndicatorPauseImg");
  const playImg = $("#downloadIndicatorPlayImg");
  if (!el) return;
  if (!downloadIndicatorState.active || !shouldRenderBottomCenterIndicator("download")) {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    return;
  }
  const lang = state.settings?.language || "en";
  const isVideo = downloadIndicatorState.mode === "video";
  const baseLabel = downloadIndicatorState.label;
  if (labelEl) {
    labelEl.textContent =
      isVideo && downloadIndicatorState.paused ? t("download.paused", lang) : baseLabel;
  }
  if (pauseBtn) {
    pauseBtn.setAttribute(
      "aria-label",
      downloadIndicatorState.paused ? t("download.resume", lang) : t("download.pause", lang)
    );
  }
  if (pauseImg && playImg) {
    pauseImg.classList.toggle("hidden", !!downloadIndicatorState.paused);
    playImg.classList.toggle("hidden", !downloadIndicatorState.paused);
  }
  if (actions) {
    actions.classList.toggle("hidden", !isVideo);
    actions.setAttribute("aria-hidden", isVideo ? "false" : "true");
  }
  $("#downloadIndicatorCancelBtn")?.setAttribute("aria-label", t("download.cancel", lang));
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  const ringFill = el.querySelector(".download-indicator__ring-fill");
  const percentEl = $("#downloadIndicatorPercent");
  const pct = Math.round(Math.min(100, Math.max(0, downloadIndicatorState.percent)));
  const indeterminate = pct === 0;
  el.classList.toggle("download-indicator--indeterminate", indeterminate);
  if (ringFill) {
    if (indeterminate) {
      ringFill.style.strokeDasharray = "";
      ringFill.style.strokeDashoffset = "";
    } else {
      const circumference = 100;
      const offset = circumference - (pct / 100) * circumference;
      ringFill.style.strokeDasharray = String(circumference);
      ringFill.style.strokeDashoffset = String(offset);
    }
  }
  if (percentEl) percentEl.textContent = pct > 0 ? `${pct}%` : "";
}

function hideDownloadIndicator() {
  downloadIndicatorState.active = false;
  downloadIndicatorState.paused = false;
  downloadIndicatorState.mode = "generic";
  syncBottomCenterIndicators();
}

function updateDownloadIndicator(percent) {
  downloadIndicatorState.percent = percent;
  renderDownloadIndicator();
}

/** Wraps `downloadVideoFromUrl` with bottom progress UI and event unlisten. */
async function downloadVideoWithProgressUI(url, title) {
  showDownloadIndicator(null, { mode: "video" });
  const unsub = window.qooti.onDownloadProgress?.((pct) => updateDownloadIndicator(pct));
  try {
    return await window.qooti.downloadVideoFromUrl(url, title ?? null);
  } finally {
    if (typeof unsub === "function") unsub();
    hideDownloadIndicator();
  }
}

function wireVideoDownloadIndicator() {
  $("#downloadIndicatorPauseBtn")?.addEventListener("click", async () => {
    if (downloadIndicatorState.mode !== "video" || !downloadIndicatorState.active) return;
    const next = !downloadIndicatorState.paused;
    downloadIndicatorState.paused = next;
    try {
      await window.qooti.setVideoDownloadPaused?.(next);
    } catch (_) {}
    renderDownloadIndicator();
  });
  $("#downloadIndicatorCancelBtn")?.addEventListener("click", async () => {
    if (downloadIndicatorState.mode !== "video" || !downloadIndicatorState.active) return;
    const lang = state.settings?.language || "en";
    const ok = await showConfirm({
      message: t("download.cancelConfirm", lang),
      confirmLabel: t("download.cancelConfirmYes", lang),
      cancelLabel: t("download.cancelConfirmNo", lang),
      danger: true,
    });
    if (!ok) return;
    try {
      await window.qooti.cancelVideoDownload?.();
    } catch (_) {}
  });
}

function hideUpdateIndicator() {
  const el = $("#updateIndicator");
  if (!el) return;
  el.classList.add("hidden");
  el.setAttribute("aria-hidden", "true");
}

function renderSettingsUpdateSection(detail = updaterUiState) {
  const labelEl = $("#settingsUpdateStatusLabel");
  const metaEl = $("#settingsUpdateStatusMeta");
  const actionBtn = $("#settingsCheckForUpdates");
  const cardEl = actionBtn?.closest(".settings-update-card") || $("#settingsPanelLicense .settings-update-card");
  if (!labelEl || !metaEl) return;

  const lang = state.settings?.language || "en";
  const currentVersion = detail.currentVersion || $("#settingsAppVersion")?.textContent?.trim() || "—";
  const phase = detail.phase || "idle";
  const availableVersion = detail.availableVersion ? String(detail.availableVersion) : "";
  const detailText = detail.detailText ? String(detail.detailText) : "";
  const errorText = detail.error ? String(detail.error) : "";
  const currentVersionLabel =
    currentVersion && currentVersion !== "—"
      ? t("settings.updateStatusCurrent", lang).replace("%s", currentVersion)
      : "—";

  let label = t("settings.upToDate", lang);
  let meta = currentVersionLabel;

  if (phase === "checking") {
    label = detail.statusText || t("settings.updateChecking", lang);
    meta = detailText || currentVersionLabel;
  } else if (phase === "update_available") {
    label = availableVersion
      ? t("settings.updateAvailable", lang).replace("%s", availableVersion)
      : detail.statusText || t("settings.updateAvailableGeneric", lang);
    meta = currentVersionLabel;
  } else if (phase === "downloading" || phase === "installing") {
    label = detail.statusText || t("settings.updateInProgress", lang);
    meta = detailText || currentVersionLabel;
  } else if (phase === "downloaded_ready_to_install" || phase === "restart_required") {
    label = detail.statusText || t("settings.updateReady", lang);
    meta = detailText || currentVersionLabel;
  } else if (phase === "failed") {
    label = detail.statusText || t("settings.updateFailed", lang);
    meta = errorText || detailText || currentVersionLabel;
  } else if (phase === "up_to_date") {
    label = detail.statusText || t("settings.upToDate", lang);
    meta = detailText || currentVersionLabel;
  }

  setText(labelEl, label);
  setText(metaEl, meta);

  if (actionBtn) {
    const busy = phase === "checking" || phase === "downloading" || phase === "installing" || phase === "restarting";
    actionBtn.disabled = busy;
    if (phase === "update_available") {
      setText(actionBtn, t("settings.downloadUpdate", lang));
    } else {
      setText(actionBtn, t("settings.checkForUpdates", lang));
    }
  }

  const hasUpdateFound = [
    "update_available",
    "downloading",
    "installing",
    "downloaded_ready_to_install",
    "restart_required",
    "restarting",
  ].includes(phase);
  cardEl?.classList.toggle("settings-update-card--available", hasUpdateFound);
  labelEl.classList.toggle("settings-update-card__title--available", hasUpdateFound);
  metaEl.classList.toggle("settings-update-card__meta--available", hasUpdateFound);
  actionBtn?.classList.toggle("settings-update-card__action--available", hasUpdateFound);
}

function renderUpdateIndicator(detail = updaterUiState) {
  const el = $("#updateIndicator");
  const labelEl = $("#updateIndicatorLabel");
  const metaEl = $("#updateIndicatorMeta");
  const percentEl = $("#updateIndicatorPercent");
  const ringFill = el?.querySelector(".download-indicator__ring-fill");
  const actionsEl = $("#updateIndicatorActions");
  const hideBtn = $("#updateIndicatorHideBtn");
  if (!el || !labelEl || !metaEl || !percentEl || !ringFill || !actionsEl || !hideBtn) return;

  const phase = detail.phase || "idle";
  const shouldShow = isUpdateIndicatorActive(detail) && shouldRenderBottomCenterIndicator("update");
  if (!shouldShow) {
    hideUpdateIndicator();
    return;
  }

  el.classList.remove("hidden", "download-indicator--indeterminate", "download-indicator--ready", "download-indicator--error");
  el.setAttribute("aria-hidden", "false");
  if (phase === "downloaded_ready_to_install") {
    el.classList.add("download-indicator--ready");
  } else if (phase === "failed") {
    el.classList.add("download-indicator--error");
  }

  labelEl.textContent = detail.statusText || "Checking for updates…";
  const meta = detail.detailText || "";
  metaEl.textContent = meta;
  metaEl.classList.toggle("hidden", !meta);

  const pct = Math.round(Math.min(100, Math.max(0, Number(detail.progressPercent || 0))));
  const indeterminate = phase === "checking" || phase === "installing" || phase === "restarting" || (phase === "downloading" && pct <= 0);
  el.classList.toggle("download-indicator--indeterminate", indeterminate);
  if (indeterminate) {
    ringFill.style.strokeDasharray = "";
    ringFill.style.strokeDashoffset = "";
    percentEl.textContent = phase === "checking" ? "" : pct > 0 ? `${pct}%` : "";
  } else {
    const circumference = 100;
    const offset = circumference - (pct / 100) * circumference;
    ringFill.style.strokeDasharray = String(circumference);
    ringFill.style.strokeDashoffset = String(offset);
    percentEl.textContent = phase === "downloaded_ready_to_install" ? "" : pct > 0 ? `${pct}%` : "";
  }

  const showActions = phase === "downloaded_ready_to_install";
  actionsEl.classList.toggle("hidden", !showActions);
  hideBtn.classList.toggle("hidden", showActions || phase === "installing" || phase === "restarting");
  hideBtn.textContent = phase === "failed" ? "Dismiss" : "Hide";
}

function maybeToastUpdaterState(detail) {
  let key = "";
  let text = "";
  let variant = "info";
  if (detail.phase === "up_to_date" && detail.source === "manual") {
    key = `up_to_date:${detail.currentVersion || ""}`;
    text = "You're up to date.";
    variant = "success";
  } else if (detail.phase === "downloaded_ready_to_install" && detail.availableVersion) {
    key = `ready:${detail.availableVersion}`;
    text = `Update ${detail.availableVersion} downloaded. Restart when ready.`;
    variant = "success";
  } else if (detail.phase === "failed" && detail.error) {
    key = `failed:${detail.error}`;
    text = detail.detailText || detail.error || "Update failed.";
    variant = "error";
  }
  if (!key || updaterToastKey === key) return;
  updaterToastKey = key;
  toast(text, { durationMs: 3200, variant });
}

function applyUpdaterState(detail = {}) {
  updaterUiState = { ...updaterUiState, ...detail };
  syncBottomCenterIndicators();
  maybeToastUpdaterState(updaterUiState);
  renderSettingsUpdateSection(updaterUiState);
}

function guessNextPatchVersion(versionText) {
  const raw = String(versionText || "").trim();
  const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return "0.0.1";
  const major = Number(match[1]) || 0;
  const minor = Number(match[2]) || 0;
  const patch = Number(match[3]) || 0;
  return `${major}.${minor}.${patch + 1}`;
}

function simulateUpdateFoundState() {
  const currentVersion = updaterUiState.currentVersion
    || $("#settingsAppVersion")?.textContent?.trim()
    || "0.0.0";
  const availableVersion = guessNextPatchVersion(currentVersion);
  applyUpdaterState({
    phase: "update_available",
    source: "manual",
    hidden: false,
    currentVersion,
    availableVersion,
    statusText: `Update ${availableVersion} is available`,
    detailText: "Ready to download.",
    progressPercent: 0,
    error: null,
  });
}

async function syncUpdaterStateFromBridge() {
  try {
    const detail = await window.qooti?.getUpdaterState?.();
    if (detail) applyUpdaterState(detail);
  } catch (_) {}
}

async function downloadVideoFromPreview() {
  if (!pendingLinkPreview) return;
  if (pendingLinkPreview.type !== "youtube" && pendingLinkPreview.type !== "instagram") return;

  const url = pendingLinkPreview.url;
  const title = pendingLinkPreview.title || null;

  setPreviewDownloading(true);

  try {
    const result = await downloadVideoWithProgressUI(url, title);

    if (result?.cancelled) {
      setPreviewDownloading(false);
      return;
    }

    if (result?.ok) {
      const insp = result?.inspiration;
      const item = insp ? { id: insp.id, type: insp.type || "video", title: insp.title, tags: insp.tags || [] } : null;
      notifyMediaAdd("Added", { durationMs: 3200, item, variant: "success" });
      pendingLinkPreview = null;
      hideAddSurface();
      await refreshData();
      await loadInspirations();
      scheduleDelayedRefreshForNewItems();
    } else {
      setPreviewDownloading(false);
      notifyMediaAdd(result?.error || "Download failed", { variant: "error" });
    }
  } catch (err) {
    console.error("Download video error:", err);
    setPreviewDownloading(false);
    const detail = err?.message || String(err || "");
    notifyMediaAdd(`Download failed: ${detail || "unknown error"}`, { variant: "error" });
  }
}

async function addFromClipboardImage(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const result = await window.qooti.addImageFromBase64(base64, blob.type);
    if (result) {
      const item = result?.id ? { id: result.id, type: result.type || "image", title: result.title, tags: result.tags || [] } : null;
      notifyMediaAdd("Added", { durationMs: 3200, item, variant: "success" });
      await refreshData();
      await loadInspirations();
      maybeScheduleOcrForItemType(item?.type);
      scheduleDelayedRefreshForNewItems();
    }
  } catch (err) {
    console.error("Add clipboard image error:", err);
    notifyMediaAdd("Could not add image", { variant: "error" });
  }
}

// Search bar paste: show download button for video links
let searchPastedVideoUrl = null;
let delAllInProgress = false;
let deleteSurveyCmdInProgress = false;
let bltRangPaletteInProgress = false;
let bltLogoutInProgress = false;

/** Search-bar command: list all image/link rows with no palette, then extract sequentially. */
async function handleBltRangPaletteBackfillCommand() {
  const lang = state.settings?.language || "en";
  if (bltRangPaletteInProgress) return;
  if (typeof window.qooti?.extractPalette !== "function" || typeof window.qooti?.listInspirations !== "function") {
    toast(t("preview.paletteExtractFailed", lang), { variant: "error" });
    return;
  }
  bltRangPaletteInProgress = true;
  try {
    const collected = [];
    let offset = 0;
    for (;;) {
      const params = {
        query: "",
        limit: PALETTE_BACKFILL_PAGE_SIZE,
        offset,
        missingPaletteOnly: true,
      };
      if (state.view.startsWith("collection:")) {
        params.collectionId = state.view.split(":")[1];
      }
      if (state.selectedTagId) {
        params.tagId = state.selectedTagId;
      }
      const batch = (await window.qooti.listInspirations(params)) || [];
      collected.push(...batch);
      if (batch.length < PALETTE_BACKFILL_PAGE_SIZE) break;
      offset += PALETTE_BACKFILL_PAGE_SIZE;
    }
    const items = collected.filter((it) => mediaItemSupportsPaletteExtract(it) && inspirationPaletteIsEmpty(it));
    if (items.length === 0) {
      toast(t("preview.bltRangNoItems", lang), { variant: "info" });
      await loadInspirations(false);
      return;
    }
    toast(t("preview.bltRangQueued", lang).replace("{n}", String(items.length)), {
      variant: "info",
      durationMs: 5000,
    });
    let ok = 0;
    let fail = 0;
    for (const item of items) {
      const success = await extractPaletteForInspiration(item, null, { silent: true, skipReload: true });
      if (success) ok += 1;
      else fail += 1;
    }
    await loadInspirations(false);
    refreshMediaPreviewItemFromState();
    if (mediaPreviewItem) syncMediaPreviewActionState(mediaPreviewItem);
    toast(
      t("preview.bltRangDone", lang).replace("{ok}", String(ok)).replace("{fail}", String(fail)),
      {
        variant: fail > 0 ? "warning" : "success",
        durationMs: 8000,
      }
    );
  } catch (err) {
    console.error("[blt_rang] failed:", err);
    toast(err?.message || t("preview.paletteExtractFailed", lang), { variant: "error" });
  } finally {
    bltRangPaletteInProgress = false;
  }
}

async function handleDeleteSurveySearchCommand() {
  if (deleteSurveyCmdInProgress) return;
  if (typeof window.qooti?.clearSurveyData !== "function") {
    notifyMediaAdd("Survey reset is not available in this build.", { variant: "error" });
    return;
  }
  deleteSurveyCmdInProgress = true;
  try {
    const ok = await showConfirm({
      message:
        "Delete saved onboarding survey data from this device? The survey may appear again after you restart the app.",
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    await window.qooti.clearSurveyData();
    notifyMediaAdd("Survey data removed.", { variant: "success" });
  } catch (err) {
    console.error("clearSurveyData error:", err);
    notifyMediaAdd(err?.message || "Could not remove survey data.", { variant: "error" });
  } finally {
    deleteSurveyCmdInProgress = false;
  }
}

async function handleBltLogoutSearchCommand() {
  if (bltLogoutInProgress) return;
  if (typeof window.qooti?.clearLicenseCache !== "function") {
    notifyMediaAdd("License logout is not available in this build.", { variant: "error" });
    return;
  }
  bltLogoutInProgress = true;
  try {
    const ok = await showConfirm({
      message: "Logout from this device license and return to activation screen?",
      confirmLabel: "Logout",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    await window.qooti.clearLicenseCache();
    notifyMediaAdd("Logged out from license.", { variant: "success" });
    window.location.reload();
  } catch (err) {
    console.error("blt_logout clearLicenseCache error:", err);
    notifyMediaAdd(err?.message || "Failed to logout from license.", { variant: "error" });
  } finally {
    bltLogoutInProgress = false;
  }
}

async function handleDelAllSearchCommand() {
  if (delAllInProgress) return;
  if (typeof window.qooti?.clearAllMedia !== "function") {
    notifyMediaAdd("Clear all media is not available in this build.", { variant: "error" });
    return;
  }
  const lang = state.settings?.language || "en";
  const ok = await showConfirm({
    message: t("search.bltDelallConfirm", lang),
    confirmLabel: t("ctx.delete", lang),
    cancelLabel: t("feedback.cancel", lang),
    danger: true,
  });
  if (!ok) return;
  delAllInProgress = true;
  try {
    const result = await window.qooti.clearAllMedia();
    state.selected.clear();
    state.query = "";
    state.currentCollectionId = null;
    state.currentCollectionName = "";
    state.view = "grid";
    hideCollectionsView();
    hideHistoryView();
    hideSettings();
    showGrid();
    await refreshData();
    await loadInspirations(false);
    const deletedCount = Number(result?.deletedMediaRows || 0);
    notifyMediaAdd(
      deletedCount > 0 ? `Deleted ${deletedCount} media items` : "Media library cleared",
      { variant: "success" }
    );
  } catch (err) {
    console.error("blt_delall clearAllMedia error:", err);
    notifyMediaAdd(err?.message || "Failed to clear media", { variant: "error" });
  } finally {
    delAllInProgress = false;
  }
}

function updateSearchInputLinkState() {
  const input = $("#searchInput");
  const btn = $("#searchDownloadBtn");
  if (!input || !btn) return;
  const val = (input.value || "").trim();
  const isLink = isUrl(val);
  input.classList.toggle("search__input--link", isLink);
  if (isLink) {
    state.query = "";
    if (searchPastedVideoUrl && searchPastedVideoUrl.url !== val) {
      searchPastedVideoUrl = null;
      btn.classList.add("hidden");
    } else if (searchPastedVideoUrl) {
      btn.classList.remove("hidden");
    }
  } else {
    state.query = val;
    if (searchPastedVideoUrl) {
      searchPastedVideoUrl = null;
      btn.classList.add("hidden");
    }
  }
}

async function handleSearchBarPaste(e) {
  const text = e.clipboardData?.getData("text/plain")?.trim();
  if (!text || !isUrl(text)) return;

  const preview = await window.qooti.fetchLinkPreview(text);
  const canDownload = preview && (preview.type === "youtube" || preview.type === "instagram");

  if (canDownload) {
    e.preventDefault();
    searchPastedVideoUrl = { url: text, title: preview.title };
    const input = $("#searchInput");
    if (input) input.value = text;
    $("#searchDownloadBtn")?.classList.remove("hidden");
    updateSearchInputLinkState();
  }
}

function wireSearchDownloadBar() {
  $("#searchDownloadBtn")?.addEventListener("click", () => {
    downloadVideoFromSearchBar();
  });
}

function hideSearchDownloadBar() {
  searchPastedVideoUrl = null;
  $("#searchDownloadBtn")?.classList.add("hidden");
}

async function downloadVideoFromSearchBar() {
  if (!searchPastedVideoUrl) return;

  const { url, title } = searchPastedVideoUrl;
  const input = $("#searchInput");
  if (input) {
    input.value = "";
    input.classList.remove("search__input--link");
  }
  state.query = "";
  hideSearchDownloadBar();

  try {
    const result = await downloadVideoWithProgressUI(url, title || null);

    if (result?.cancelled) return;

    if (result?.ok) {
      const insp = result?.inspiration;
      const item = insp ? { id: insp.id, type: insp.type || "video", title: insp.title, tags: insp.tags || [] } : null;
      notifyMediaAdd("Added", { durationMs: 3200, item, variant: "success" });
      await refreshData();
      await loadInspirations(false);
      scheduleDelayedRefreshForNewItems();
    } else {
      notifyMediaAdd(result?.error || "Download failed", { variant: "error" });
    }
  } catch (err) {
    console.error("Download video error:", err);
    const detail = err?.message || String(err || "");
    notifyMediaAdd(`Download failed: ${detail || "unknown error"}`, { variant: "error" });
  }
}

// Handle paste anywhere
async function handleGlobalPaste(e) {
  // If modal or media preview is open, ignore
  if (!$("#modalRoot").classList.contains("hidden")) return;
  if (!$("#mediaPreview").classList.contains("hidden")) return;

  // If pasting in search bar, let handleSearchBarPaste handle it (no add surface popup)
  if (document.activeElement === $("#searchInput")) return;

  const clipboardData = e.clipboardData;
  if (!clipboardData) return;

  // Check for files (images pasted from clipboard)
  if (clipboardData.files && clipboardData.files.length > 0) {
    e.preventDefault();
    for (const file of clipboardData.files) {
      if (file.type.startsWith("image/")) {
        await addFromClipboardImage(file);
        hideAddSurface();
        return;
      }
    }
  }

  // Check for image items
  for (const item of clipboardData.items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (blob) {
        await addFromClipboardImage(blob);
        hideAddSurface();
        return;
      }
    }
  }

  // Check for text (URL) - show preview instead of immediate add
  const text = clipboardData.getData("text/plain");
  if (text && isUrl(text)) {
    e.preventDefault();
    // Show add surface with preview
    if (!isAddSurfaceVisible()) {
      showAddSurface();
    }
    await fetchAndShowLinkPreview(text);
    return;
  }

  // If add surface is open and text pasted, put it in the input
  if (isAddSurfaceVisible() && text) {
    // Let it go to the input naturally
  }
}

// Handle input submit (Enter key)
async function handleAddInputSubmit() {
  const input = $("#addInput");
  const value = input.value.trim();
  if (!value) return;

  if (isUrl(value)) {
    await fetchAndShowLinkPreview(value);
  }
  // If not a URL, do nothing (per spec: ignore non-URL text)
  input.value = "";
}

// Global drop overlay: show when dragging files over the app
function showDropOverlay(fileCount) {
  const el = $("#dropOverlay");
  const textEl = $("#dropOverlayText");
  if (el) el.classList.remove("hidden");
  if (textEl) {
    textEl.textContent = fileCount > 1
      ? `Drop to add ${fileCount} items`
      : "Drop to add to qooti";
  }
}

function hideDropOverlay() {
  const el = $("#dropOverlay");
  if (el) el.classList.add("hidden");
}

function isDraggingFiles(e) {
  return e?.dataTransfer?.types?.includes?.("Files") ?? false;
}

// Extract file paths from drop event
// 1. file.path (Tauri exposes real paths where available)
// 2. text/uri-list fallback (some WebViews)
function getPathsFromDrop(e) {
  const paths = [];
  const dt = e.dataTransfer;
  if (!dt) return paths;

  // 1. Try file.path (Electron / some WebViews)
  const files = dt.files;
  if (files?.length) {
    for (const file of files) {
      try {
        const p = window.qooti.getPathForFile?.(file);
        if (p && !paths.includes(p)) paths.push(p);
      } catch {}
    }
  }

  // 2. Fallback: text/uri-list (Windows Explorer etc. often provides file:// URLs)
  if (paths.length === 0) {
    const uriList = dt.getData?.("text/uri-list") || dt.getData?.("text/plain") || "";
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        if (trimmed.startsWith("file:")) {
          const url = new URL(trimmed);
          const decoded = decodeURIComponent(url.pathname);
          const path = decoded.replace(/^\/([A-Za-z]:)/, "$1");
          if (path && !paths.includes(path)) paths.push(path);
        }
      } catch {}
    }
  }

  return paths;
}

// Global drop zone: window-level drag & drop for adding media
function setupGlobalDropZone() {
  const overlay = $("#dropOverlay");
  if (!overlay) return;

  const onDragOver = (e) => {
    if (!isDraggingFiles(e) || e.dataTransfer?.types?.includes(ROW_MOVE_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const count = e.dataTransfer?.files?.length ?? 0;
    showDropOverlay(count);
  };

  const onDragLeave = (e) => {
    if (!e.relatedTarget || !document.documentElement.contains(e.relatedTarget)) {
      hideDropOverlay();
    }
  };

  const onDrop = async (e) => {
    if (!isDraggingFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    hideDropOverlay();

    const paths = getPathsFromDrop(e);
    if (paths.length > 0) {
      hideAddSurface();
      await addFromPaths(paths);
    }
  };

  document.documentElement.addEventListener("dragover", onDragOver, false);
  document.documentElement.addEventListener("dragleave", onDragLeave, false);
  document.documentElement.addEventListener("drop", onDrop, false);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && !overlay.classList.contains("hidden")) {
      hideDropOverlay();
    }
  });
}

// Drop handling for add surface
async function handleAddSurfaceDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  $("#addZone").classList.remove("drag-over");

  const paths = getPathsFromDrop(e);
  if (paths.length > 0) {
    await addFromPaths(paths);
    hideAddSurface();
  }
}

const ROW_MOVE_TYPE = "application/x-qooti-move-row";

async function handleRowMoveDrop(e, targetRow) {
  const raw = e.dataTransfer.getData(ROW_MOVE_TYPE);
  if (!raw) return;
  try {
    const { id, fromRow } = JSON.parse(raw);
    if (fromRow === targetRow) return;
    await window.qooti.updateInspiration(id, { display_row: targetRow });
    await loadInspirations();
    toast(`Moved to ${targetRow === "short-form" ? "Short-form" : "Main"} row`, { variant: "success" });
  } catch (err) {
    console.error("Move row error:", err);
  }
}

function setupRowDropZone(el, targetRow) {
  el.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes(ROW_MOVE_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("row-drop-over");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("row-drop-over");
  });
  el.addEventListener("drop", async (e) => {
    if (!e.dataTransfer.types.includes(ROW_MOVE_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("row-drop-over");
    await handleRowMoveDrop(e, targetRow);
  });
}

// Drop handling for grid (passive drop zone)
async function handleGridDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  $("#gridView").classList.remove("drag-over");

  if (e.dataTransfer?.types?.includes(ROW_MOVE_TYPE)) return;

  if (state.settings.enableDragDropImport === "false") return;

  const paths = getPathsFromDrop(e);
  if (paths.length > 0) {
    await addFromPaths(paths);
  }
}

// Menu dropdown
function hideAllDropdowns() {
  document.querySelectorAll(".dropdown").forEach((d) => d.classList.add("hidden"));
  $("#btnProfile")?.setAttribute("aria-expanded", "false");
  $("#btnNotifications")?.setAttribute("aria-expanded", "false");
  $("#btnNavCollections")?.setAttribute("aria-expanded", "false");
}

function toggleDropdown(id, position) {
  const el = document.getElementById(id);
  if (!el) return;
  const wasHidden = el.classList.contains("hidden");
  hideAllDropdowns();
  if (wasHidden) {
    el.classList.remove("hidden");
    el.classList.remove("dropdown--left", "dropdown--right");
    el.classList.add(position);
  }
}

async function refreshData() {
  const finishLoading = startGlobalLoadingTask();
  try {
    state.collections = await window.qooti.listCollections();
    collectionLabelCache.clear();
    collectionLabelPending.clear();
  } catch (e) {
    console.error("[qooti] refreshData failed:", e?.message || e);
    if (window.qooti?.debug) window.qooti.debug();
    throw e;
  } finally {
    finishLoading();
  }
}

function updateSelectionBar() {
  const count = state.selected.size;
  const bar = $("#selectionBar");
  if (count === 0) {
    bar.classList.add("hidden");
  } else {
    bar.classList.remove("hidden");
    setText($("#selectionCount"), `${count} selected`);
  }
}

function showGrid() {
  const storeView = $("#storeView");
  if (storeView && !storeView.classList.contains("hidden") && !canExitOnboardingStore()) {
    return;
  }
  document.getElementById("app")?.classList.remove("app--collections-open");
  $("#gridView").classList.remove("hidden");
  applyTagFilterVisibility();
  $("#settingsView")?.classList.add("hidden");
  $("#historyView")?.classList.add("hidden");
  $("#collectionsView")?.classList.add("hidden");
  $("#storeView")?.classList.add("hidden");
}

function showSettings() {
  const storeView = $("#storeView");
  if (storeView && !storeView.classList.contains("hidden") && !canExitOnboardingStore()) {
    return;
  }
  state.prevViewBeforeSettings = state.view;
  document.getElementById("app")?.classList.add("app--settings-open");
  $("#gridView").classList.add("hidden");
  $("#tagFilterBar")?.classList.add("hidden");
  $("#settingsView")?.classList.remove("hidden");
  $("#storeView")?.classList.add("hidden");
  loadSettingsUI();
}

function hideSettings() {
  document.getElementById("app")?.classList.remove("app--settings-open");
  $("#settingsView")?.classList.add("hidden");
  showGrid();
  state.prevViewBeforeSettings = null;
  renderGrid();
}

function formatRelativeTime(msTs) {
  if (!Number.isFinite(msTs)) return "";
  const diff = Date.now() - msTs;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Updated just now";
  if (diff < hour) return `Updated ${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `Updated ${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `Updated ${Math.floor(diff / day)}d ago`;
  return `Updated ${new Date(msTs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function collectionPreviewItemImage(it) {
  const thumbUrl = it?.thumbnail_path_url;
  const storedUrl = it?.stored_path_url;
  if (thumbUrl) return loadableUrl(thumbUrl, it.thumbnail_path);
  if ((it?.type === "image" || it?.type === "gif") && storedUrl) return loadableUrl(storedUrl, it.stored_path);
  // Local video file cannot be used as <img src>; caller uses <video> when thumbnail is missing.
  if (it?.type === "link" && storedUrl) return loadableUrl(storedUrl, it.stored_path);
  return "";
}

async function loadCollectionsPageRows() {
  await refreshData();
  const rows = await Promise.all(
    (state.collections || []).map(async (collection) => {
      let items = [];
      try {
        const fetched = await window.qooti.listInspirations({ collectionId: collection.id });
        items = Array.isArray(fetched) ? fetched : [];
      } catch (_) {
        items = [];
      }
      const sorted = items
        .slice()
        .sort((a, b) => {
          const at = Number(a?.created_at || 0);
          const bt = Number(b?.created_at || 0);
          return bt - at;
        });
      return {
        collection,
        count: Number(collection?.item_count ?? items.length),
        preview: sorted.slice(0, 4),
      };
    })
  );
  return rows.sort((a, b) => Number(b.collection?.updated_at || 0) - Number(a.collection?.updated_at || 0));
}

async function refreshAppAfterCollectionImport() {
  await refreshData();

  const currentView = String(state.view || "all");
  if (currentView === "all" || currentView.startsWith("collection:")) {
    await loadInspirations(false);
  }

  const collectionsView = $("#collectionsView");
  if (collectionsView && !collectionsView.classList.contains("hidden")) {
    collectionsPageRows = await loadCollectionsPageRows();
    renderCollectionsPage(collectionsPageRows);
  }
}

function getInstalledStoreCollectionIds() {
  try {
    const raw = String(state.settings?.[STORE_INSTALLED_IDS_KEY] || "[]");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
  } catch (_) {
    return new Set();
  }
}

function getInstalledStoreCollectionLinks() {
  try {
    const raw = String(state.settings?.[STORE_INSTALLED_LINKS_KEY] || "{}");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [storeId, localId] of Object.entries(parsed)) {
      const sid = String(storeId || "").trim();
      const lid = String(localId || "").trim();
      if (!sid || !lid) continue;
      out[sid] = lid;
    }
    return out;
  } catch (_) {
    return {};
  }
}

function hasOnboardingSessionStarterPackInstalled() {
  return onboardingSessionInstalledStoreIds.size > 0;
}

function canExitOnboardingStore() {
  if (!storeHideBannersForOnboarding) return true;
  if (hasOnboardingSessionStarterPackInstalled()) return true;
  notifyMediaAdd(t("store.onboardingNeedPack", state.settings?.language || "en"), { variant: "warning" });
  return false;
}

async function checkOnboardingStoreInternetConnection() {
  try {
    const response = await fetch(STORE_ONBOARDING_CONNECTIVITY_URL, {
      method: "HEAD",
      cache: "no-cache",
    });
    return !!response?.ok;
  } catch (_) {
    return false;
  }
}

function setStoreOnboardingOfflineGateVisible(visible) {
  const isVisible = !!visible;
  const offlineGate = $("#storeOnboardingOfflineGate");
  const storeContent = $("#storeContent");
  const onboardingCta = $("#storeOnboardingCta");
  const storeCount = $("#storeCount");
  const storeSearch = $("#storeSearch");
  if (offlineGate) offlineGate.classList.toggle("hidden", !isVisible);
  if (storeContent) storeContent.classList.toggle("hidden", isVisible);
  if (onboardingCta) onboardingCta.classList.toggle("hidden", isVisible || !storeHideBannersForOnboarding);
  if (storeCount) storeCount.classList.toggle("hidden", isVisible && storeHideBannersForOnboarding);
  if (storeSearch) storeSearch.disabled = isVisible && storeHideBannersForOnboarding;
}

function fireOnboardingConfetti() {
  const canvas = document.createElement("canvas");
  canvas.className = "onboarding-confetti-canvas";
  canvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ["#4eabfb", "#32d74b", "#ff9f0a", "#bf5af2", "#ff6b6b", "#f0f0ee"];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * 300,
    w: 7 + Math.random() * 9,
    h: 3 + Math.random() * 5,
    color: colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.12,
    vx: (Math.random() - 0.5) * 2.5,
    vy: 2.5 + Math.random() * 3,
    opacity: 1,
  }));

  const onResize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  window.addEventListener("resize", onResize);

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;

    pieces.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.045;
      p.rotation += p.rotSpeed;
      if (p.y > canvas.height * 0.65) p.opacity -= 0.02;
      if (p.opacity > 0) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    });

    if (alive) {
      requestAnimationFrame(tick);
    } else {
      window.removeEventListener("resize", onResize);
      canvas.remove();
    }
  }

  requestAnimationFrame(tick);
}

function storeCollectionNameKey(name) {
  return formatCollectionDisplayName(name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function reconcileInstalledStoreCollectionState(currentStoreCollections = []) {
  const installed = getInstalledStoreCollectionIds();
  if (installed.size === 0) return installed;
  const links = getInstalledStoreCollectionLinks();
  const localCollections = Array.isArray(state.collections) ? state.collections : [];
  const localIds = new Set(localCollections.map((c) => String(c?.id || "").trim()).filter(Boolean));
  const localNameKeys = new Set(localCollections.map((c) => storeCollectionNameKey(c?.name || "")).filter(Boolean));
  const keep = new Set();
  let changed = false;
  for (const sid of installed) {
    const linkedLocalId = String(links[sid] || "").trim();
    if (linkedLocalId) {
      if (localIds.has(linkedLocalId)) {
        keep.add(sid);
      } else {
        delete links[sid];
        changed = true;
        storeDownloadStateById.delete(sid);
      }
      continue;
    }
    const storeRow = (currentStoreCollections || []).find((c) => String(c?.id || "") === sid);
    if (storeRow && localNameKeys.has(storeCollectionNameKey(storeRow?.name || ""))) {
      keep.add(sid);
    } else {
      changed = true;
      storeDownloadStateById.delete(sid);
    }
  }
  if (changed) {
    void saveSetting(STORE_INSTALLED_IDS_KEY, JSON.stringify(Array.from(keep)));
    void saveSetting(STORE_INSTALLED_LINKS_KEY, JSON.stringify(links));
  }
  return keep;
}

async function markStoreCollectionInstalledById(collectionId, localCollectionId = "") {
  const id = String(collectionId || "").trim();
  if (!id) return;
  const installed = getInstalledStoreCollectionIds();
  if (!installed.has(id)) {
    installed.add(id);
    await saveSetting(STORE_INSTALLED_IDS_KEY, JSON.stringify(Array.from(installed)));
  }
  const localId = String(localCollectionId || "").trim();
  if (localId) {
    const links = getInstalledStoreCollectionLinks();
    if (links[id] !== localId) {
      links[id] = localId;
      await saveSetting(STORE_INSTALLED_LINKS_KEY, JSON.stringify(links));
    }
  }
}

async function unmarkStoreCollectionInstalledById(collectionId) {
  const id = String(collectionId || "").trim();
  if (!id) return;
  const installed = getInstalledStoreCollectionIds();
  const hadInstalled = installed.delete(id);
  storeDownloadStateById.delete(id);
  const links = getInstalledStoreCollectionLinks();
  const hadLink = Object.prototype.hasOwnProperty.call(links, id);
  if (hadLink) delete links[id];
  if (hadInstalled) {
    await saveSetting(STORE_INSTALLED_IDS_KEY, JSON.stringify(Array.from(installed)));
  }
  if (hadLink) {
    await saveSetting(STORE_INSTALLED_LINKS_KEY, JSON.stringify(links));
  }
  const storeView = $("#storeView");
  if (storeView && !storeView.classList.contains("hidden")) {
    renderStorePage();
  }
}

async function unmarkStoreCollectionInstalledByLocalCollectionId(localCollectionId) {
  const localId = String(localCollectionId || "").trim();
  if (!localId) return;
  const links = getInstalledStoreCollectionLinks();
  const matchedStoreIds = Object.entries(links)
    .filter(([, lid]) => String(lid || "").trim() === localId)
    .map(([sid]) => sid);
  if (matchedStoreIds.length > 0) {
    for (const sid of matchedStoreIds) {
      await unmarkStoreCollectionInstalledById(sid);
    }
    return;
  }
  // Legacy fallback where store/local IDs may have been identical.
  await unmarkStoreCollectionInstalledById(localId);
}

function parseYouTubeVideoId(urlLike) {
  const raw = String(urlLike || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = (u.hostname || "").toLowerCase();
    if (host.includes("youtu.be")) return (u.pathname || "").replace(/^\/+/, "").split("/")[0] || "";
    if (host.includes("youtube.com")) {
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || "";
      const v = u.searchParams.get("v");
      return v || "";
    }
  } catch (_) {}
  return "";
}

/**
 * @param {string} urlLike
 * @param {boolean} [autoplay]
 * @param {{ preferHighQuality?: boolean }} [options] Prefer HD when YouTube allows (embed URL hints only; player still adapts to device).
 */
function buildYouTubeEmbedUrl(urlLike, autoplay = false, options = {}) {
  const vid = parseYouTubeVideoId(urlLike);
  if (!vid) return "";
  const preferHighQuality = options.preferHighQuality !== false;
  const params = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    mute: "1",
    controls: "0",
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
    loop: "1",
    playlist: vid,
    enablejsapi: "1",
    iv_load_policy: "3",
  });
  if (preferHighQuality) {
    params.set("hd", "1");
    // Legacy hints; YouTube may ignore, but when honored they bias toward HD.
    params.set("vq", "hd1080");
  }
  try {
    if (typeof window !== "undefined" && window.location?.origin) {
      params.set("origin", window.location.origin);
    }
  } catch (_) {}
  return `https://www.youtube.com/embed/${encodeURIComponent(vid)}?${params.toString()}`;
}

/** Ask the embedded YouTube player for the highest available quality (best-effort; requires enablejsapi=1). */
function requestYouTubeIframeHighestQuality(iframe) {
  if (!iframe || iframe.tagName !== "IFRAME") return;
  const src = String(iframe.getAttribute("src") || "");
  if (!src.includes("youtube.com/embed")) return;
  const send = () => {
    try {
      const win = iframe.contentWindow;
      if (!win) return;
      const payload = JSON.stringify({
        event: "command",
        func: "setPlaybackQuality",
        args: ["highres"],
      });
      win.postMessage(payload, "https://www.youtube.com");
    } catch (_) {}
  };
  const schedule = () => {
    send();
    setTimeout(send, 400);
    setTimeout(send, 1400);
  };
  iframe.addEventListener("load", schedule, { once: true });
  if (iframe.contentWindow) schedule();
}

/**
 * @param {string} urlLike
 * @param {{ preferMaxRes?: boolean }} [options] maxresdefault is sharper when available (not all videos have it).
 */
function buildYouTubeThumbnailUrl(urlLike, options = {}) {
  const vid = parseYouTubeVideoId(urlLike);
  if (!vid) return "";
  const size = options.preferMaxRes ? "maxresdefault" : "hqdefault";
  return `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/${size}.jpg`;
}

function formatStoreCollectionSize(sizeMb) {
  const n = Number(sizeMb || 0);
  if (!Number.isFinite(n) || n <= 0) return "Size unknown";
  if (n < 1) return `${Math.max(1, Math.round(n * 1000))} KB`;
  return `${n.toFixed(1)} MB`;
}

function stopStoreHeroCycle() {
  if (storeHeroCycleTimer) {
    clearInterval(storeHeroCycleTimer);
    storeHeroCycleTimer = null;
  }
  storeHeroCycleCount = 0;
}

function startStoreHeroCycle(heroCount) {
  stopStoreHeroCycle();
  if (!Number.isFinite(heroCount) || heroCount <= 1) return;
  storeHeroCycleCount = heroCount;
  storeHeroCycleTimer = setInterval(() => {
    const next = (storeHeroActiveIndex + 1) % heroCount;
    setStoreHeroIndex(next);
  }, 6000);
}

function setStoreHeroIndex(nextIndex) {
  const count = Math.max(0, Number(storeHeroCycleCount || 0));
  if (count <= 0) return;
  const normalized = ((Number(nextIndex) || 0) % count + count) % count;
  storeHeroActiveIndex = normalized;
  if (storeHeroRenderState) renderStoreHeroSection(storeHeroRenderState);
}

function normalizeStoreAdConfig(config) {
  const src = config && typeof config === "object" ? config : {};
  const mode = String(src?.ad_mode || "none").trim().toLowerCase();
  const adTitle = String(src?.ad_title || "").trim();
  const adDescription = String(src?.ad_description || "").trim();
  const adButtonTitle = String(src?.ad_button_title || "").trim();
  const adButtonUrl = String(src?.ad_button_url || "").trim();
  const adImageUrl = String(src?.ad_image_url || "").trim();
  const adVideoUrl = String(src?.ad_video_url || "").trim();
  const adVideoThumb = buildYouTubeThumbnailUrl(adVideoUrl);
  const adVideoEmbed = buildYouTubeEmbedUrl(adVideoUrl, true);
  const adPreview = mode === "youtube" ? (adVideoThumb || adImageUrl) : adImageUrl;
  const hasAdCta = adButtonUrl.length > 0;
  const hasAdContent =
    mode === "image"
    || mode === "youtube"
    || adTitle.length > 0
    || adDescription.length > 0
    || adPreview.length > 0
    || adVideoEmbed.length > 0;

  return {
    adTitle,
    adDescription,
    adButtonTitle,
    adButtonUrl,
    adVideoEmbed,
    adPreview,
    hasAdCta,
    hasAdContent,
  };
}

function renderStoreHeroSection(renderState) {
  const {
    heroEl,
    heroDotsEl,
    heroCandidates,
    installedById,
    lang,
    commercialAd,
    applyBanner,
  } = renderState || {};
  if (!heroEl || !heroDotsEl || !Array.isArray(heroCandidates) || heroCandidates.length === 0) return;

  if (storeHeroActiveIndex >= heroCandidates.length) storeHeroActiveIndex = 0;

  const showDots = heroCandidates.length > 1 && heroCandidates.length <= 12;
  heroDotsEl.innerHTML = "";
  heroDotsEl.classList.toggle("hidden", !showDots);
  if (showDots) {
    for (let i = 0; i < heroCandidates.length; i++) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = `store-hero-dots__dot${i === storeHeroActiveIndex ? " is-active" : ""}`;
      dot.setAttribute("aria-label", `${t("store.title", lang)} ${i + 1}`);
      dot.addEventListener("click", () => setStoreHeroIndex(i));
      heroDotsEl.appendChild(dot);
    }
  }

  const activeCollection = heroCandidates[storeHeroActiveIndex] || heroCandidates[0];
  const heroId = String(activeCollection?.id || "");
  const heroVideoUrl = String(activeCollection?.preview_video_url || "");
  const heroVideoThumb = buildYouTubeThumbnailUrl(heroVideoUrl, { preferMaxRes: true });
  const heroPreview = heroVideoThumb
    || String(activeCollection?.banner_poster_url || "")
    || (Array.isArray(activeCollection?.preview_urls) ? String(activeCollection.preview_urls[0] || "") : "");
  const heroVideoEmbed = buildYouTubeEmbedUrl(heroVideoUrl, true, { preferHighQuality: true });
  const heroState = storeDownloadStateById.get(heroId) || {};
  const heroOwned = installedById.has(heroId) || heroState.status === "complete";
  const heroDownloading = heroState.status === "downloading" || heroState.status === "importing";
  const heroError = heroState.status === "error";
  const heroActionLabel = heroOwned
    ? t("store.inLibrary", lang)
    : heroDownloading
      ? `${t("store.downloading", lang)}${Number(heroState.pct || 0) > 0 ? ` ${Math.round(Number(heroState.pct || 0))}%` : ""}`
      : heroError
        ? t("store.retry", lang)
        : t("store.download", lang);

  const applyPosterUrlRaw = String(applyBanner?.poster_url || "").trim();
  const applyPosterUpdatedAt = String(applyBanner?.updated_at || "").trim();
  let applyPosterUrl = applyPosterUrlRaw;
  if (applyPosterUrlRaw && applyPosterUpdatedAt) {
    try {
      const u = new URL(applyPosterUrlRaw);
      u.searchParams.set("v", applyPosterUpdatedAt);
      applyPosterUrl = u.toString();
    } catch (_) {
      const sep = applyPosterUrlRaw.includes("?") ? "&" : "?";
      applyPosterUrl = `${applyPosterUrlRaw}${sep}v=${encodeURIComponent(applyPosterUpdatedAt)}`;
    }
  }
  const applyVideoUrl = String(applyBanner?.preview_video_url || "").trim();
  const applyVideoThumb = buildYouTubeThumbnailUrl(applyVideoUrl);
  const applyVideoEmbed = buildYouTubeEmbedUrl(applyVideoUrl, true);
  const applyPreview = applyVideoThumb || applyPosterUrl;
  const applyHasMedia = applyPreview.length > 0 || applyVideoEmbed.length > 0;
  const applyTitle = String(applyBanner?.title || "").trim() || t("store.applyTitle", lang);
  const applyDescription = String(applyBanner?.description || "").trim() || t("store.applyDescription", lang);
  const applyButtonTitle = String(applyBanner?.button_title || "").trim() || t("store.applyButton", lang);
  const applyButtonUrl = String(applyBanner?.button_url || "").trim();

  const staticKey = JSON.stringify({
    adMode: commercialAd.hasAdContent,
    adPreview: commercialAd.adPreview,
    adVideoEmbed: commercialAd.adVideoEmbed,
    adTitle: commercialAd.adTitle,
    adDescription: commercialAd.adDescription,
    adButtonTitle: commercialAd.adButtonTitle,
    adButtonUrl: commercialAd.adButtonUrl,
    applyPreview,
    applyVideoEmbed,
    applyTitle,
    applyDescription,
    applyButtonTitle,
    applyButtonUrl,
  });

  const shouldRenderStatic = heroEl.dataset.heroStaticKey !== staticKey
    || !heroEl.querySelector('[data-store-hero-slot="main"]');
  if (shouldRenderStatic) {
    heroEl.dataset.heroStaticKey = staticKey;
    heroEl.innerHTML = `
      <article class="store-hero-card store-hero-card--swap">
        <div class="store-hero-shell">
          <section class="store-hero-shell__main" data-store-hero-slot="main"></section>
          <aside class="store-ad-card ${commercialAd.hasAdContent ? "" : "store-ad-card--empty"}">
            <div class="store-ad-card__media ${commercialAd.adPreview ? "" : "store-ad-card__media--empty"} ${commercialAd.adVideoEmbed ? "store-ad-card__media--video" : ""}">
              ${commercialAd.adPreview ? `<img src="${escapeHtml(commercialAd.adPreview)}" alt="" loading="lazy" />` : `<span>${escapeHtml(t("store.adSpace", lang))}</span>`}
              ${commercialAd.adVideoEmbed ? `<iframe class="store-ad-card__video" src="${escapeHtml(commercialAd.adVideoEmbed)}" title="" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>` : ""}
            </div>
            <div class="store-ad-card__overlay">
              ${commercialAd.adTitle ? `<h4 class="store-ad-card__title">${escapeHtml(commercialAd.adTitle)}</h4>` : ""}
              ${commercialAd.adDescription ? `<p class="store-ad-card__desc">${escapeHtml(commercialAd.adDescription)}</p>` : ""}
              ${commercialAd.hasAdCta ? `<button type="button" class="store-ad-card__action" data-store-ad-link="${escapeHtml(commercialAd.adButtonUrl)}">${escapeHtml(commercialAd.adButtonTitle || t("store.adCta", lang))}</button>` : ""}
            </div>
          </aside>
          <aside class="store-apply-card ${applyHasMedia ? "" : "store-apply-card--empty"}">
            <div class="store-apply-card__media ${applyPreview ? "" : "store-apply-card__media--empty"} ${applyVideoEmbed ? "store-ad-card__media--video" : ""}">
              ${applyPreview ? `<img src="${escapeHtml(applyPreview)}" alt="" loading="lazy" />` : `<span>${escapeHtml(t("store.noPreview", lang))}</span>`}
              ${applyVideoEmbed ? `<iframe class="store-ad-card__video" src="${escapeHtml(applyVideoEmbed)}" title="" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>` : ""}
            </div>
            <div class="store-apply-card__overlay">
              <h4 class="store-apply-card__title">${escapeHtml(applyTitle)}</h4>
              <p class="store-apply-card__desc">${escapeHtml(applyDescription)}</p>
              ${applyButtonUrl ? `<button type="button" class="store-apply-card__action" data-store-apply-link="${escapeHtml(applyButtonUrl)}">${escapeHtml(applyButtonTitle)}</button>` : ""}
            </div>
          </aside>
        </div>
      </article>
    `;
    heroEl.querySelectorAll("[data-store-ad-link]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const url = String(btn.getAttribute("data-store-ad-link") || "").trim();
        if (!url) return;
        await openExternalLink(url, "store-ad-cta");
      });
    });
    heroEl.querySelectorAll("[data-store-apply-link]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const url = String(btn.getAttribute("data-store-apply-link") || "").trim();
        if (!url) return;
        await openExternalLink(url, "store-apply-cta");
      });
    });
    heroEl.querySelectorAll(".store-ad-card__video").forEach((el) => requestYouTubeIframeHighestQuality(el));
  }

  const mainSlot = heroEl.querySelector('[data-store-hero-slot="main"]');
  if (!mainSlot) return;
  mainSlot.innerHTML = `
    <div class="store-hero-card__image ${heroPreview ? "" : "store-hero-card__image--empty"} ${heroVideoEmbed ? "store-hero-card__image--video" : ""}">
      ${heroPreview ? `<img src="${escapeHtml(heroPreview)}" alt="" loading="lazy" />` : `<span>${escapeHtml(t("store.noPreview", lang))}</span>`}
      ${heroVideoEmbed ? `<iframe class="store-hero-card__video" src="${escapeHtml(heroVideoEmbed)}" title="" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>` : ""}
    </div>
    <div class="store-hero-card__overlay">
      <h3 class="store-hero-card__title">${escapeHtml(formatCollectionDisplayName(activeCollection?.name || "Untitled pack"))}</h3>
      <p class="store-hero-card__meta">${Number(activeCollection?.item_count || 0)} ${escapeHtml(t("store.items", lang))} · ${escapeHtml(formatStoreCollectionSize(activeCollection?.file_size_mb))}</p>
      <button type="button" class="store-hero-card__action ${heroOwned ? "store-card__action--owned" : ""}" data-store-hero-download-id="${escapeHtml(heroId)}" ${heroOwned || heroDownloading ? "disabled" : ""}>${escapeHtml(heroActionLabel)}</button>
    </div>
  `;
  mainSlot.querySelectorAll(".store-hero-card__video").forEach((el) => requestYouTubeIframeHighestQuality(el));
  mainSlot.querySelectorAll("[data-store-hero-download-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = String(btn.getAttribute("data-store-hero-download-id") || "");
      const collection = heroCandidates.find((c) => String(c?.id || "") === id);
      if (!collection) return;
      const localState = storeDownloadStateById.get(id) || {};
      const alreadyOwned = installedById.has(id) || localState.status === "complete";
      const isDownloading = localState.status === "downloading" || localState.status === "importing";
      downloadStoreCollection(collection, { alreadyOwned, isDownloading });
    });
  });
}

async function downloadStoreCollection(collection, { alreadyOwned, isDownloading } = {}) {
  const id = String(collection?.id || "");
  if (!id || alreadyOwned || isDownloading) return;
  await refreshData();
  const storeIndexAll = Array.isArray(storeCollectionsIndex) ? storeCollectionsIndex : [];
  const installedById = reconcileInstalledStoreCollectionState(storeIndexAll);
  const alreadyOwnedNow = installedById.has(id);
  if (alreadyOwnedNow) {
    storeDownloadStateById.set(id, { status: "complete", pct: 100 });
    renderStorePage();
    return;
  }
  const downloadUrl = String(collection?.download_url || "").trim();
  if (!downloadUrl) {
    toast("This collection is missing a download URL.", { variant: "error" });
    return;
  }
  storeDownloadStateById.set(id, { status: "downloading", pct: 0 });
  renderStorePage();
  try {
    const importResult = await window.qooti?.downloadAndImportCollection?.(id, downloadUrl);
    await markStoreCollectionInstalledById(id, String(importResult?.collectionId || ""));
    if (storeHideBannersForOnboarding) {
      onboardingSessionInstalledStoreIds.add(id);
    }
    storeDownloadStateById.set(id, { status: "complete", pct: 100 });
    await refreshAppAfterCollectionImport();
    scheduleOcrAutoIndex();
    renderStorePage();
    notifyMediaAdd(`Added "${formatCollectionDisplayName(collection?.name || "Collection")}" to your library`, {
      variant: "success",
    });
  } catch (err) {
    storeDownloadStateById.set(id, { status: "error", pct: 0 });
    renderStorePage();
    notifyMediaAdd(err?.message || "Could not download this collection", { variant: "error" });
  }
}

function renderStorePage() {
  const heroEl = $("#storeHero");
  const heroDotsEl = $("#storeHeroDots");
  const featuredEl = $("#storeFeatured");
  const gridEl = $("#storeGrid");
  const emptyEl = $("#storeEmpty");
  const countEl = $("#storeCount");
  const query = ($("#storeSearch")?.value || "").trim().toLowerCase();
  if (!gridEl || !heroEl || !heroDotsEl || !featuredEl) return;

  const all = Array.isArray(storeCollectionsIndex) ? storeCollectionsIndex : [];
  const filtered = query
    ? all.filter((c) => formatCollectionDisplayName(c?.name || "").toLowerCase().includes(query))
    : all;
  const lang = state.settings?.language || "en";
  const applyBanner = storeApplyBannerConfig && typeof storeApplyBannerConfig === "object"
    ? storeApplyBannerConfig
    : {};
  const commercialBanner = storeCommercialBannerConfig && typeof storeCommercialBannerConfig === "object"
    ? storeCommercialBannerConfig
    : {};
  const commercialAd = normalizeStoreAdConfig(commercialBanner);
  const installedById = getInstalledStoreCollectionIds();
  const hasStarterPackInstalled = hasOnboardingSessionStarterPackInstalled();
  const showOnboardingRecommendations = storeHideBannersForOnboarding && onboardingRecommendedStoreIds.size > 0;
  const onboardingCtaEl = $("#storeOnboardingCta");
  const onboardingHintEl = $("#storeOnboardingHint");
  const onboardingStartBtn = $("#storeOnboardingStartBtn");
  const onboardingStartWrap = $("#storeOnboardingStartWrap");
  if (onboardingCtaEl && onboardingStartBtn) {
    if (storeHideBannersForOnboarding) {
      onboardingCtaEl.classList.remove("hidden");
      setStoreOnboardingOfflineGateVisible(false);
      if (onboardingHintEl) {
        onboardingHintEl.textContent = hasStarterPackInstalled
          ? t("store.onboardingReady", lang)
          : t("store.onboardingHint", lang);
      }
      onboardingStartBtn.disabled = !hasStarterPackInstalled;
      onboardingStartBtn.classList.toggle("is-ready", hasStarterPackInstalled);
      onboardingStartBtn.classList.toggle("is-disabled", !hasStarterPackInstalled);
      onboardingStartWrap?.classList.toggle("enabled", hasStarterPackInstalled);
      onboardingStartWrap?.classList.toggle("disabled", !hasStarterPackInstalled);
      syncStoreOnboardingLanguageUi();
    } else {
      onboardingCtaEl.classList.add("hidden");
      closeStoreOnboardingLanguageMenu();
      onboardingStartBtn.disabled = true;
      onboardingStartBtn.classList.remove("is-ready");
      onboardingStartBtn.classList.add("is-disabled");
      onboardingStartWrap?.classList.remove("enabled");
      onboardingStartWrap?.classList.add("disabled");
    }
  }

  if (countEl) {
    const totalLabel = `${all.length} pack${all.length === 1 ? "" : "s"}`;
    countEl.textContent = query ? `${totalLabel} · ${filtered.length} shown` : totalLabel;
  }

  gridEl.innerHTML = "";
  heroEl.innerHTML = "";
  const hideStoreBanners = storeHideBannersForOnboarding;
  if (hideStoreBanners) {
    featuredEl.classList.add("hidden");
    heroEl.classList.add("hidden");
    heroDotsEl.classList.add("hidden");
    heroDotsEl.innerHTML = "";
    stopStoreHeroCycle();
    storeHeroRenderState = null;
  }
  if (filtered.length === 0) {
    heroDotsEl.innerHTML = "";
    featuredEl.classList.add("hidden");
    heroEl.classList.add("hidden");
    heroDotsEl.classList.add("hidden");
    storeHeroRenderState = null;
    stopStoreHeroCycle();
    emptyEl?.classList.remove("hidden");
    return;
  }
  if (!hideStoreBanners) {
    featuredEl.classList.remove("hidden");
    heroEl.classList.remove("hidden");
  }
  emptyEl?.classList.add("hidden");

  if (!hideStoreBanners) {
    const heroCandidates = filtered;
    storeHeroRenderState = {
      heroEl,
      heroDotsEl,
      heroCandidates,
      installedById,
      lang,
      commercialAd,
      applyBanner,
    };
    renderStoreHeroSection(storeHeroRenderState);
    startStoreHeroCycle(heroCandidates.length);
  }

  // Featured and banner are independent; always show all collections here.
  const featuredItems = filtered;
  for (const collection of featuredItems) {
    const id = String(collection?.id || "");
    const previewVideoUrl = String(collection?.preview_video_url || "");
    const previewVideoThumb = buildYouTubeThumbnailUrl(previewVideoUrl);
    const firstPreview = previewVideoThumb
      || String(collection?.card_poster_url || "")
      || String(collection?.banner_poster_url || "")
      || (Array.isArray(collection?.preview_urls) ? String(collection.preview_urls[0] || "") : "");
    const previewVideoIdle = buildYouTubeEmbedUrl(previewVideoUrl, false);
    const previewVideoHover = buildYouTubeEmbedUrl(previewVideoUrl, true);
    const localState = storeDownloadStateById.get(id) || {};
    const alreadyOwned = installedById.has(id) || localState.status === "complete";
    const isDownloading = localState.status === "downloading" || localState.status === "importing";
    const hasError = localState.status === "error";
    const isRecommended = showOnboardingRecommendations && onboardingRecommendedStoreIds.has(id);

    const card = document.createElement("article");
    card.className = "store-card store-card--featured";
    card.innerHTML = `
      <div class="store-card__cover ${firstPreview ? "" : "store-card__cover--empty"}">
        ${firstPreview ? `<img src="${escapeHtml(firstPreview)}" alt="" loading="lazy" />` : `<span>${escapeHtml(t("store.noPreview", lang))}</span>`}
        ${previewVideoIdle ? `<iframe class="store-card__video" src="${escapeHtml(previewVideoIdle)}" title="" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe>` : ""}
      </div>
      <div class="store-card__body">
        <div class="store-card__title-row">
          <h3 class="store-card__title">${escapeHtml(formatCollectionDisplayName(collection?.name || "Untitled pack"))}</h3>
          ${isRecommended ? `<span class="store-card__rec-chip">${escapeHtml(t("survey.recommended", lang))}</span>` : ""}
        </div>
        <p class="store-card__meta">${Number(collection?.item_count || 0)} ${escapeHtml(t("store.items", lang))} · ${escapeHtml(formatStoreCollectionSize(collection?.file_size_mb))}</p>
        <button type="button" class="store-card__action ${alreadyOwned ? "store-card__action--owned" : ""}" ${alreadyOwned || isDownloading ? "disabled" : ""}></button>
      </div>
    `;
    const actionBtn = card.querySelector(".store-card__action");
    const cardVideoEl = card.querySelector(".store-card__video");
    if (cardVideoEl && previewVideoHover) {
      card.addEventListener("mouseenter", () => {
        cardVideoEl.classList.add("is-active");
        if (cardVideoEl.getAttribute("src") !== previewVideoHover) {
          cardVideoEl.setAttribute("src", previewVideoHover);
        }
      });
      card.addEventListener("mouseleave", () => {
        cardVideoEl.classList.remove("is-active");
        if (cardVideoEl.getAttribute("src") !== previewVideoIdle) {
          cardVideoEl.setAttribute("src", previewVideoIdle);
        }
      });
    }
    if (actionBtn) {
      if (alreadyOwned) {
        actionBtn.textContent = t("store.inLibrary", lang);
      } else if (isDownloading) {
        const pct = Number(localState.pct || 0);
        actionBtn.textContent = pct > 0 ? `${t("store.downloading", lang)} ${pct}%` : t("store.downloading", lang);
      } else if (hasError) {
        actionBtn.textContent = t("store.retry", lang);
      } else {
        actionBtn.textContent = t("store.download", lang);
      }
      actionBtn.addEventListener("click", async () => {
        await downloadStoreCollection(collection, { alreadyOwned, isDownloading });
      });
    }
    gridEl.appendChild(card);
  }
}

async function showStoreView(options = {}) {
  const fromOnboarding = options.fromOnboarding === true;
  const skipConnectivityCheck = options.skipConnectivityCheck === true;
  document.getElementById("app")?.classList.add("app--collections-open");
  document.getElementById("app")?.classList.toggle("app--store-onboarding", fromOnboarding);
  $("#gridView").classList.add("hidden");
  $("#tagFilterBar")?.classList.add("hidden");
  $("#settingsView")?.classList.add("hidden");
  $("#historyView")?.classList.add("hidden");
  $("#collectionsView")?.classList.add("hidden");
  $("#storeView")?.classList.remove("hidden");
  $("#btnBackFromStore")?.classList.toggle("hidden", fromOnboarding);
  storeHideBannersForOnboarding = fromOnboarding;
  if (fromOnboarding) {
    onboardingSessionInstalledStoreIds = new Set();
  } else {
    closeStoreOnboardingLanguageMenu();
    onboardingRecommendedStoreIds = new Set();
  }
  setStoreOnboardingOfflineGateVisible(false);

  if (fromOnboarding && !skipConnectivityCheck) {
    const canReachStore = await checkOnboardingStoreInternetConnection();
    if (!canReachStore) {
      setStoreOnboardingOfflineGateVisible(true);
      return;
    }
  }

  if (typeof storeProgressUnsub === "function") {
    storeProgressUnsub();
    storeProgressUnsub = null;
  }
  if (typeof window.qooti?.onCollectionProgress === "function") {
    storeProgressUnsub = window.qooti.onCollectionProgress((payload) => {
      const id = String(payload?.id || "");
      if (!id) return;
      const status = String(payload?.status || "downloading");
      const pct = Math.max(0, Math.min(100, Number(payload?.pct || 0)));
      const prev = storeDownloadStateById.get(id) || {};
      storeDownloadStateById.set(id, { ...prev, status, pct });
      renderStorePage();
    });
  }

  const storeCountEl = $("#storeCount");
  if (storeCountEl) storeCountEl.textContent = t("store.loading", state.settings?.language || "en");
  try {
    await refreshData();
    const index = await window.qooti?.fetchFreeCollectionsIndex?.();
    storeCollectionsIndex = Array.isArray(index?.free) ? index.free : [];
    storeApplyBannerConfig = index?.store_apply_banner || null;
    storeCommercialBannerConfig = index?.store_commercial_banner || null;
  } catch (err) {
    console.error("[store] load failed:", err?.message || err);
    storeCollectionsIndex = [];
    storeApplyBannerConfig = null;
    storeCommercialBannerConfig = null;
    notifyMediaAdd(t("store.loadFailed", state.settings?.language || "en"), { variant: "warning" });
  }
  renderStorePage();
}

function hideStoreView() {
  if (!canExitOnboardingStore()) return false;
  closeStoreOnboardingLanguageMenu();
  $("#storeView")?.classList.add("hidden");
  setStoreOnboardingOfflineGateVisible(false);
  $("#storeOnboardingCta")?.classList.add("hidden");
  $("#storeOnboardingStartBtn")?.setAttribute("disabled", "disabled");
  $("#storeOnboardingStartBtn")?.classList.remove("is-ready");
  $("#storeOnboardingStartBtn")?.classList.add("is-disabled");
  $("#storeOnboardingStartWrap")?.classList.remove("enabled");
  $("#storeOnboardingStartWrap")?.classList.add("disabled");
  stopStoreHeroCycle();
  storeHeroRenderState = null;
  storeHideBannersForOnboarding = false;
  document.getElementById("app")?.classList.remove("app--store-onboarding");
  onboardingRecommendedStoreIds = new Set();
  onboardingSessionInstalledStoreIds = new Set();
  if (typeof storeProgressUnsub === "function") {
    storeProgressUnsub();
    storeProgressUnsub = null;
  }
  return true;
}

function normalizePackName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function validatePackName(name) {
  const normalized = normalizePackName(name);
  if (!normalized) return "Pack name is required.";
  if (normalized.length > 256) return "Pack name must be 256 characters or fewer.";
  return "";
}

async function openExportCollectionPackFlow(row) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--prompt app-modal--pack-export";
    wrap.innerHTML = `
      <div class="app-modal__backdrop"></div>
      <div class="app-modal__dialog app-modal__dialog--wide">
        <div class="app-modal__body">
          <div class="app-modal__message">Export "${escapeHtml(row.collection?.name || "Collection")}" as a secure .qooti pack.</div>
          <div class="field app-modal__field">
            <label class="field__label" for="packNameInput">Pack name</label>
            <input id="packNameInput" type="text" class="field__input app-modal__input" autocomplete="off" />
          </div>
          <div class="field app-modal__field">
            <label class="field__label">Pack profile image (optional)</label>
            <div class="file-input-group">
              <input id="packProfileInput" type="file" accept="image/*" class="file-input-group__input" />
              <label for="packProfileInput" class="btn btn--secondary file-input-group__btn">Choose file</label>
              <span id="packProfileFileName" class="file-input-group__name" aria-live="polite"></span>
            </div>
          </div>
          <img id="packProfilePreview" alt="" class="app-modal__profile-preview hidden" />
          <div id="packExportProgressWrap" class="pack-export-progress hidden" aria-live="polite">
            <div
              class="pack-export-progress__track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="0"
            >
              <div id="packExportProgressBar" class="pack-export-progress__fill"></div>
            </div>
            <div id="packExportProgressLabel" class="pack-export-progress__label"></div>
          </div>
          <div id="packExportError" class="app-modal__error hidden"></div>
        </div>
        <div class="app-modal__footer">
          <button type="button" class="btn btn--secondary app-modal__cancel">Cancel</button>
          <button type="button" class="btn btn--primary app-modal__submit">Export .qooti</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    const input = wrap.querySelector("#packNameInput");
    const fileInput = wrap.querySelector("#packProfileInput");
    const preview = wrap.querySelector("#packProfilePreview");
    const errEl = wrap.querySelector("#packExportError");
    const btnCancel = wrap.querySelector(".app-modal__cancel");
    const btnSubmit = wrap.querySelector(".app-modal__submit");
    const progressWrap = wrap.querySelector("#packExportProgressWrap");
    const progressBar = wrap.querySelector("#packExportProgressBar");
    const progressTrack = wrap.querySelector(".pack-export-progress__track");
    const progressLabel = wrap.querySelector("#packExportProgressLabel");
    let profileImageDataUrl = null;
    let packExportInFlight = false;
    input.value = normalizePackName(row.collection?.name || "Collection Pack");

    function close() {
      if (packExportInFlight) return;
      if (!document.body.contains(wrap)) return;
      wrap.classList.add("app-modal--closing");
      setTimeout(() => {
        if (document.body.contains(wrap)) document.body.removeChild(wrap);
        resolve();
      }, 160);
    }
    function showError(msg) {
      if (!msg) {
        errEl.classList.add("hidden");
        errEl.textContent = "";
      } else {
        errEl.classList.remove("hidden");
        errEl.textContent = msg;
      }
    }

    const fileNameEl = wrap.querySelector("#packProfileFileName");
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (fileNameEl) fileNameEl.textContent = file ? file.name : "";
      if (!file) {
        profileImageDataUrl = null;
        preview.classList.add("hidden");
        preview.removeAttribute("src");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        profileImageDataUrl = typeof reader.result === "string" ? reader.result : null;
        if (profileImageDataUrl) {
          preview.src = profileImageDataUrl;
          preview.classList.remove("hidden");
        }
      };
      reader.onerror = () => showError("Could not read selected image.");
      reader.readAsDataURL(file);
    });

    btnSubmit.addEventListener("click", async () => {
      const packName = normalizePackName(input.value);
      const invalid = validatePackName(packName);
      if (invalid) {
        showError(invalid);
        return;
      }
      showError("");
      btnSubmit.disabled = true;
      btnCancel.disabled = true;
      packExportInFlight = true;
      progressWrap?.classList.remove("hidden");
      if (progressBar) progressBar.style.width = "0%";
      if (progressLabel) progressLabel.textContent = "";
      progressTrack?.setAttribute("aria-valuenow", "0");
      const stopProgress =
        typeof window.qooti?.onCollectionPackExportProgress === "function"
          ? window.qooti.onCollectionPackExportProgress((payload) => {
              const raw = Number(payload?.percent);
              const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
              if (progressBar) progressBar.style.width = `${pct}%`;
              progressTrack?.setAttribute("aria-valuenow", String(Math.round(pct)));
              const msg = payload?.message;
              if (progressLabel && msg != null && String(msg).trim() !== "") {
                progressLabel.textContent = String(msg);
              }
            })
          : () => {};
      try {
        const res = await window.qooti.exportCollectionAsPack(row.collection.id, packName, profileImageDataUrl);
        toast(`Exported ${res.bundled} items${res.skipped ? ` (${res.skipped} skipped)` : ""}`, { variant: "success" });
        packExportInFlight = false;
        close();
      } catch (err) {
        showError(err?.message || "Export failed.");
        btnSubmit.disabled = false;
        btnCancel.disabled = false;
        packExportInFlight = false;
      } finally {
        stopProgress();
        progressWrap?.classList.add("hidden");
      }
    });

    btnCancel.addEventListener("click", close);
    wrap.querySelector(".app-modal__backdrop").addEventListener("click", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter") btnSubmit.click();
    });
    input.focus();
    input.select();
  });
}

async function openImportCollectionPackFlow(packPathInput = null) {
  const packPath = packPathInput || await window.qooti.selectCollectionPackFile();
  if (!packPath) return;
  const preview = await window.qooti.inspectCollectionPack(packPath);
  await new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--confirm";
    wrap.innerHTML = `
      <div class="app-modal__backdrop"></div>
      <div class="app-modal__dialog">
        <div class="app-modal__body">
          <div style="display:flex;align-items:center;gap:12px;">
            <img src="${escapeHtml(preview.profile_image_data_url || "")}" alt="Pack profile" style="width:72px;height:72px;border-radius:12px;object-fit:cover;border:1px solid var(--border2);" />
            <div>
              <div class="app-modal__message" style="font-weight:600;margin-bottom:4px;">${escapeHtml(preview.name || "Untitled Pack")}</div>
              <div class="app-modal__message" style="color:var(--muted);font-size:12px;">${Number(preview.item_count || 0)} item(s) · v${escapeHtml(String(preview.pack_version || 1))}</div>
            </div>
          </div>
          <div class="app-modal__message" style="margin-top:12px;">Import this .qooti pack into a new collection?</div>
          <div id="packImportError" class="app-modal__message hidden" style="margin-top:8px;color:var(--feedback-error);"></div>
        </div>
        <div class="app-modal__footer">
          <button type="button" class="btn app-modal__cancel">Cancel</button>
          <button type="button" class="btn btn--primary app-modal__confirm">Import Pack</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    const errEl = wrap.querySelector("#packImportError");
    const btnCancel = wrap.querySelector(".app-modal__cancel");
    const btnConfirm = wrap.querySelector(".app-modal__confirm");
    function close() {
      if (!document.body.contains(wrap)) return;
      wrap.classList.add("app-modal--closing");
      setTimeout(() => {
        if (document.body.contains(wrap)) document.body.removeChild(wrap);
        resolve();
      }, 160);
    }
    btnConfirm.addEventListener("click", async () => {
      btnConfirm.disabled = true;
      errEl.classList.add("hidden");
      try {
        const res = await window.qooti.importCollectionPack(packPath);
        if (preview?.pack_id) {
          await markStoreCollectionInstalledById(String(preview.pack_id), String(res?.collectionId || ""));
        }
        const displayName = formatCollectionDisplayName(res.collectionName);
        notifyMediaAdd(`Imported ${res.imported} items into "${displayName}"`, { variant: "success" });
        if (res.errors?.length) toast(`${res.errors.length} item(s) skipped`, { variant: "warning" });
        await refreshData();
        collectionsPageRows = await loadCollectionsPageRows();
        renderCollectionsPage(collectionsPageRows);
        close();
        // Open the new collection so user sees its content immediately (first-class behavior).
        state.view = `collection:${res.collectionId}`;
        state.currentCollectionId = res.collectionId;
        state.currentCollectionName = displayName; // always use clean display name (no "Imported ..." in UI)
        hideCollectionsView();
        showGrid();
        updateCollectionViewBar();
        updateSelectionBar();
        await loadInspirations(false);
        scheduleOcrAutoIndex();
        refreshTagFilterBar();
      } catch (e) {
        errEl.classList.remove("hidden");
        errEl.textContent = e?.message || "Import failed.";
        btnConfirm.disabled = false;
      }
    });
    btnCancel.addEventListener("click", close);
    wrap.querySelector(".app-modal__backdrop").addEventListener("click", close);
  });
}

async function chooseTelegramCollectionMode(defaultName) {
  await refreshData();
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--prompt";
    const collectionOptions = (state.collections || [])
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(getCollectionDisplayName(c))}</option>`)
      .join("");
    wrap.innerHTML = `
      <div class="app-modal__backdrop"></div>
      <div class="app-modal__dialog app-modal__dialog--wide">
        <div class="app-modal__body">
          <div class="app-modal__message">Do you want to import this Telegram export as a collection?</div>
          <div class="field app-modal__field">
            <label class="field__label" for="telegramCollectionMode">Import mode</label>
            <select id="telegramCollectionMode" class="field__input app-modal__input">
              <option value="new">Create new collection</option>
              <option value="existing">Add to existing collection</option>
              <option value="none">Import without collection</option>
            </select>
          </div>
          <div id="telegramCollectionNameWrap" class="field app-modal__field">
            <label class="field__label" for="telegramCollectionName">Collection name</label>
            <input id="telegramCollectionName" type="text" class="field__input app-modal__input" autocomplete="off" />
          </div>
          <div id="telegramCollectionExistingWrap" class="field app-modal__field hidden">
            <label class="field__label" for="telegramExistingCollection">Select collection</label>
            <select id="telegramExistingCollection" class="field__input app-modal__input">
              ${collectionOptions || '<option value="">No collections available</option>'}
            </select>
          </div>
          <div id="telegramImportModeError" class="app-modal__error hidden"></div>
        </div>
        <div class="app-modal__footer">
          <button type="button" class="btn btn--secondary app-modal__cancel">Cancel</button>
          <button type="button" class="btn btn--primary app-modal__confirm">Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    const modeEl = wrap.querySelector("#telegramCollectionMode");
    const nameWrap = wrap.querySelector("#telegramCollectionNameWrap");
    const nameEl = wrap.querySelector("#telegramCollectionName");
    const existingWrap = wrap.querySelector("#telegramCollectionExistingWrap");
    const existingEl = wrap.querySelector("#telegramExistingCollection");
    const errEl = wrap.querySelector("#telegramImportModeError");
    const btnConfirm = wrap.querySelector(".app-modal__confirm");
    const btnCancel = wrap.querySelector(".app-modal__cancel");
    nameEl.value = defaultName;

    function close(result = null) {
      if (!document.body.contains(wrap)) return;
      wrap.classList.add("app-modal--closing");
      setTimeout(() => {
        if (document.body.contains(wrap)) document.body.removeChild(wrap);
        resolve(result);
      }, 160);
    }

    function updateModeUi() {
      const mode = modeEl.value;
      nameWrap.classList.toggle("hidden", mode !== "new");
      existingWrap.classList.toggle("hidden", mode !== "existing");
      errEl.classList.add("hidden");
    }
    updateModeUi();
    modeEl.addEventListener("change", updateModeUi);

    btnConfirm.addEventListener("click", () => {
      const mode = modeEl.value;
      if (mode === "new") {
        const collectionName = String(nameEl.value || "").trim();
        if (!collectionName) {
          errEl.textContent = "Collection name is required.";
          errEl.classList.remove("hidden");
          return;
        }
        close({ mode, collectionName });
        return;
      }
      if (mode === "existing") {
        const collectionId = String(existingEl.value || "").trim();
        if (!collectionId) {
          errEl.textContent = "Please select a collection.";
          errEl.classList.remove("hidden");
          return;
        }
        close({ mode, collectionId });
        return;
      }
      close({ mode: "none" });
    });

    btnCancel.addEventListener("click", () => close(null));
    wrap.querySelector(".app-modal__backdrop").addEventListener("click", () => close(null));
    nameEl.focus();
    nameEl.select();
  });
}

async function openTelegramImportFlow(folderPathInput = null, inspectPreview = null) {
  const folderPath = folderPathInput || await window.qooti.selectTelegramExportFolder();
  if (!folderPath) return;

  let preview = inspectPreview;
  if (!preview) {
    preview = await window.qooti.inspectTelegramExport(folderPath);
  }
  if (!preview?.isValid) {
    throw new Error("Invalid Telegram export folder.");
  }

  const defaultCollectionName = `Telegram - ${String(preview.channelName || "Imported")}`.trim();
  const choice = await chooseTelegramCollectionMode(defaultCollectionName);
  if (!choice) return;

  const progressRoot = document.createElement("div");
  progressRoot.className = "modal migration-modal-ref telegram-progress-modal";
  progressRoot.setAttribute("role", "dialog");
  progressRoot.setAttribute("aria-label", "Importing Telegram media");
  const progressBody = document.createElement("div");
  progressBody.className = "modal-body";
  progressRoot.appendChild(progressBody);
  const renderTelegramProgress = (statusText, current, total, percent) => {
    progressBody.innerHTML = buildTelegramProgressHTML(statusText, current, total, percent);
    progressBody.querySelector("[data-telegram-progress-cancel]")?.addEventListener("click", hideModal);
    progressBody.querySelector("[data-telegram-progress-minimize]")?.addEventListener("click", () => {
      hideModal();
      toast("Telegram import is running in the background", { variant: "info" });
    });
  };
  renderTelegramProgress("Preparing files…", 0, Number(preview.validCount || 0), 0);
  showModal(progressRoot);

  let progressUnsub = null;
  const onProgress = (e) => {
    const d = e?.detail || {};
    if (!d.total) return;
    const total = Number(d.total || preview.validCount || 0);
    const current = Number(d.current || 0);
    const pct = Math.round((current / Math.max(1, total)) * 100);
    renderTelegramProgress(d.status || "Processing files", current, total, pct);
  };
  progressUnsub = () => window.removeEventListener("qooti:telegram-import-progress", onProgress);
  window.addEventListener("qooti:telegram-import-progress", onProgress);
  try {
    const payload = {
      folderPath,
      collectionMode: choice.mode,
      collectionName: choice.collectionName || null,
      collectionId: choice.collectionId || null,
    };
    const res = await window.qooti.importTelegramExport(payload);

    const imported = Number(res?.imported || 0);
    const duplicates = Number(res?.duplicates || 0);
    const failed = Number(res?.failed || 0);
    const skippedUnsupported = Number(res?.skippedUnsupported || 0);
    notifyMediaAdd(
      `Telegram import complete: ${imported} imported`,
      { variant: imported > 0 ? "success" : "warning" }
    );
    if (duplicates || failed || skippedUnsupported) {
      toast(
        `Skipped ${duplicates} duplicates, ${skippedUnsupported} unsupported, ${failed} failed`,
        { variant: "warning" }
      );
    }

    await refreshData();
    collectionsPageRows = await loadCollectionsPageRows();
    renderCollectionsPage(collectionsPageRows);
    if (res?.collectionId) {
      state.view = `collection:${res.collectionId}`;
      state.currentCollectionId = res.collectionId;
      state.currentCollectionName = formatCollectionDisplayName(res.collectionName || "");
      hideCollectionsView();
      showGrid();
      updateCollectionViewBar();
      updateSelectionBar();
      await loadInspirations(false);
    } else {
      await loadInspirations(false);
    }
    scheduleOcrAutoIndex();
    refreshTagFilterBar();
  } finally {
    hideModal();
    if (typeof progressUnsub === "function") progressUnsub();
  }
}

function renderCollectionsPage(rows) {
  const gridEl = $("#collectionsGrid");
  const emptyEl = $("#collectionsEmpty");
  const countEl = $("#collectionsCount");
  const query = ($("#collectionsSearch")?.value || "").trim().toLowerCase();
  if (!gridEl) return;

  const filtered = query
    ? rows.filter((row) => getCollectionDisplayName(row.collection).toLowerCase().includes(query))
    : rows;
  if (countEl) {
    const totalLabel = `${rows.length} collection${rows.length === 1 ? "" : "s"}`;
    countEl.textContent = query ? `${totalLabel} · ${filtered.length} shown` : totalLabel;
  }
  gridEl.innerHTML = "";

  if (filtered.length === 0) {
    emptyEl?.classList.remove("hidden");
    return;
  }
  emptyEl?.classList.add("hidden");

  for (const row of filtered) {
    const card = document.createElement("div");
    card.className = "collections-card";
    card.role = "button";
    card.tabIndex = 0;
    card._collectionRow = row;
    card.innerHTML = `
      <div class="collections-card__cover"></div>
      <div class="collections-card__body">
        <div class="collections-card__heading">
          <h3 class="collections-card__title"></h3>
          <button type="button" class="collections-card__export" title="Export as pack" aria-label="Export collection">&uarr;</button>
        </div>
        <p class="collections-card__count"></p>
        <p class="collections-card__meta"></p>
      </div>
    `;
    card.querySelector(".collections-card__title").textContent = getCollectionDisplayName(row.collection) || "Untitled collection";
    card.querySelector(".collections-card__count").textContent = `${row.count} item${row.count === 1 ? "" : "s"}`;
    card.querySelector(".collections-card__meta").textContent = formatRelativeTime(Number(row.collection?.updated_at || 0));

    const cover = card.querySelector(".collections-card__cover");
    if (row.preview.length === 0) {
      cover.innerHTML = '<span class="collections-card__placeholder" aria-hidden="true">+</span>';
    } else {
      const collage = document.createElement("div");
      collage.className = `collections-card__collage collections-card__collage--${Math.min(row.preview.length, 4)}`;
      for (const item of row.preview) {
        const cell = document.createElement("div");
        cell.className = "collections-card__cell";
        const src = collectionPreviewItemImage(item);
        if (src) {
          const img = document.createElement("img");
          wireVaultImageFallback(img, item, !!item?.thumbnail_path_url);
          if (!img.getAttribute("src")) img.src = src;
          img.alt = "";
          img.loading = "lazy";
          cell.appendChild(img);
        } else if (item?.type === "video" && item?.stored_path_url) {
          const vsrc = loadableUrl(item.stored_path_url, item.stored_path);
          if (vsrc) {
            const vid = document.createElement("video");
            vid.src = vsrc;
            vid.muted = true;
            vid.playsInline = true;
            vid.setAttribute("playsinline", "");
            vid.preload = "metadata";
            vid.setAttribute("aria-hidden", "true");
            cell.appendChild(vid);
          } else {
            const glyph = document.createElement("span");
            glyph.className = "collections-card__glyph";
            glyph.textContent = "▶";
            cell.appendChild(glyph);
          }
        } else {
          const glyph = document.createElement("span");
          glyph.className = "collections-card__glyph";
          glyph.textContent = item?.type === "video" ? "▶" : "◇";
          cell.appendChild(glyph);
        }
        collage.appendChild(cell);
      }
      cover.appendChild(collage);
    }

    card.addEventListener("click", (e) => {
      if (e.target.closest(".collections-card__export")) return;
      if (e.button !== 0) return; // only navigate on left-click; right-click opens context menu
      state.view = `collection:${row.collection.id}`;
      state.currentCollectionId = row.collection.id;
      state.currentCollectionName = getCollectionDisplayName(row.collection) || "Collection";
      state.selected.clear();
      hideCollectionsView();
      showGrid();
      updateCollectionViewBar();
      updateSelectionBar();
      loadInspirations();
    });
    card.addEventListener("keydown", (e) => {
      if (e.target.closest(".collections-card__export")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const synthetic = new MouseEvent("click", { bubbles: true, button: 0 });
        card.dispatchEvent(synthetic);
      }
    });

    const exportBtn = card.querySelector(".collections-card__export");
    exportBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await openExportCollectionPackFlow(row);
    });

    gridEl.appendChild(card);
  }
}

async function showCollectionsView() {
  document.getElementById("app")?.classList.add("app--collections-open");
  $("#gridView").classList.add("hidden");
  $("#tagFilterBar")?.classList.add("hidden");
  $("#settingsView")?.classList.add("hidden");
  $("#historyView")?.classList.add("hidden");
  if (!hideStoreView()) return;
  const collectionsView = $("#collectionsView");
  if (!collectionsView) return;
  collectionsView.classList.remove("hidden");
  collectionsPageRows = await loadCollectionsPageRows();
  renderCollectionsPage(collectionsPageRows);
}

function hideCollectionsView() {
  document.getElementById("app")?.classList.remove("app--collections-open");
  $("#collectionsView")?.classList.add("hidden");
}

/** Display name for collections: strip internal "(Imported 123...)" suffix so it never appears in UI. */
function formatCollectionDisplayName(name) {
  if (name == null || typeof name !== "string") return "Collection";
  const s = name.trim();
  if (!s) return "Collection";
  // Remove "(Imported <digits>)" or " (Imported <digits>)" suffix (internal/timestamp, not user-facing).
  return s.replace(/\s*\(Imported\s+\d+\)\s*$/i, "").trim() || "Collection";
}

function getCollectionDisplayName(collection) {
  const lang = state.settings?.language || "en";
  if (collection?.id === DEFAULT_UNSORTED_COLLECTION_ID) {
    return t("collections.unsorted", lang);
  }
  return formatCollectionDisplayName(collection?.name);
}

function formatCollectionIndicatorText(collections) {
  const shorten = (name) => {
    const chars = Array.from(String(name || ""));
    if (chars.length <= 7) return String(name || "");
    return `${chars.slice(0, 7).join("")}...`;
  };
  const list = Array.isArray(collections) ? collections : [];
  if (list.length === 0) return "";
  const names = list.map((c) => getCollectionDisplayName(c)).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return shorten(names[0]);
  return `${shorten(names[0])} +${names.length - 1}`;
}

function getCachedCollectionLabelText(inspirationId) {
  return collectionLabelCache.get(inspirationId) || "";
}

function setCardCollectionLabel(cardEl, labelText) {
  if (!cardEl) return;
  const labelEl = cardEl.querySelector(".js-collection-label");
  if (!labelEl) return;
  const textEl = labelEl.querySelector(".js-collection-label-text");
  if (textEl) textEl.textContent = labelText || "";
  labelEl.style.display = labelText ? "" : "none";
}

function requestCollectionLabelForItem(item, cardEl) {
  if (!item?.id || !window.qooti?.getCollectionsForInspiration) return;
  if (collectionLabelPending.has(item.id)) return;
  collectionLabelPending.add(item.id);
  window.qooti
    .getCollectionsForInspiration(item.id)
    .then((cols) => {
      const normalized = Array.isArray(cols) ? cols : [];
      const text = formatCollectionIndicatorText(normalized);
      collectionLabelCache.set(item.id, text);
      setCardCollectionLabel(cardEl, text);
    })
    .catch(() => {})
    .finally(() => {
      collectionLabelPending.delete(item.id);
    });
}

/** Show or hide the collection view bar (back + breadcrumb) and set name when viewing a collection. */
function updateCollectionViewBar() {
  const bar = $("#collectionViewBar");
  const nameEl = $("#collectionViewBarName");
  if (!bar || !nameEl) return;
  if (state.view.startsWith("collection:")) {
    const currentId = state.view.split(":")[1];
    const resolved =
      state.currentCollectionName ||
      getCollectionDisplayName(state.collections && state.collections.find((c) => c.id === currentId)) ||
      "Collection";
    nameEl.textContent = formatCollectionDisplayName(resolved);
    bar.classList.remove("hidden");
  } else {
    bar.classList.add("hidden");
  }
}

// Shuffle array in place (Fisher-Yates)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/** Vertical content has aspect_ratio < 1 (e.g. 9:16 ≈ 0.56). Threshold 0.95 to include near-square. */
const VERTICAL_ASPECT_THRESHOLD = 0.95;

function isShortFormContent(it) {
  const raw = it.aspect_ratio;
  if (raw !== null && raw !== undefined && raw !== "") {
    const ar = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(ar) && ar > 0) {
      return ar < VERTICAL_ASPECT_THRESHOLD;
    }
  }
  const url = it.source_url || "";
  return (
    /youtube\.com\/shorts\//i.test(url) ||
    /instagram\.com\/reel\//i.test(url) ||
    /instagram\.com\/p\//i.test(url)
  );
}

/** Resolve whether item belongs in short-form row (user override or auto-detect). */
function showsInShortFormRow(it) {
  const row = it.display_row;
  if (row === "short-form") return true;
  if (row === "main") return false;
  return isShortFormContent(it);
}

/** Fetch top tags and render the tag filter bar (YouTube-style pills). */
async function refreshTagFilterBar() {
  const allBtn = $("#tagFilterAll");
  const container = $("#tagFilterPills");
  if (!allBtn || !container) return;
  const prefs = parseTagFilterBarPrefs();
  try {
    let allTags = [];
    try {
      allTags = (await window.qooti?.listTags?.()) || [];
    } catch {
      allTags = [];
    }
    if (!Array.isArray(allTags)) allTags = [];
    const byId = new Map(allTags.map((t) => [t.id, t]));

    let list;
    if (prefs.order !== null && prefs.order.length > 0) {
      list = prefs.order
        .map((id) => {
          const t = byId.get(id);
          return t ? { id: t.id, label: t.label || t.id } : null;
        })
        .filter(Boolean);
    } else {
      list = await getAutoVisibleTagFilterItems();
    }

    container.textContent = "";
    list.forEach((tag) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-filter-pill";
      btn.dataset.tagId = tag.id;
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = tag.label || tag.id || "";
      container.appendChild(btn);
    });
    updateTagFilterBarActiveState();
  } catch (e) {
    console.warn("[qooti] refreshTagFilterBar failed:", e?.message || e);
    container.textContent = "";
    updateTagFilterBarActiveState();
  }
}

function updateTagFilterBarActiveState() {
  const allBtn = $("#tagFilterAll");
  const recentBtn = $("#tagFilterRecent");
  const container = $("#tagFilterPills");
  if (!allBtn || !container) return;
  const activeTagId = state.selectedTagId || "";
  const recentActive = state.sortByRecent === true;
  allBtn.classList.toggle("is-active", !activeTagId && !recentActive);
  allBtn.setAttribute("aria-pressed", !activeTagId && !recentActive ? "true" : "false");
  if (recentBtn) {
    recentBtn.classList.toggle("is-active", recentActive);
    recentBtn.setAttribute("aria-pressed", recentActive ? "true" : "false");
  }
  container.querySelectorAll(".tag-filter-pill").forEach((btn) => {
    const id = btn.dataset.tagId || "";
    const isActive = id === activeTagId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function setupTagFilterDragScroll() {
  const scrollEl = document.querySelector(".tag-filter-bar__scroll");
  if (!scrollEl || scrollEl.dataset.dragScrollBound === "1") return;
  scrollEl.dataset.dragScrollBound = "1";
  /** Portion of distance to target per frame while dragging (low = smooth lag vs pointer). */
  const DRAG_SCROLL_LERP = 0.07;
  /** After mouseup, ease the rest of the way (slightly higher = quicker settle, still smooth). */
  const RELEASE_SCROLL_LERP = Math.min(0.22, Math.max(DRAG_SCROLL_LERP, DRAG_SCROLL_LERP * 2.25));
  let isDown = false;
  let startX = 0;
  let startLeft = 0;
  let suppressClickUntil = 0;
  let pendingPageX = 0;
  let scrollRaf = 0;
  /** When set, animating to this scroll position after release (no instant snap). */
  let coastTarget = null;
  /** mousedown began on a tag pill — wait for horizontal slop before drag-scroll (so click still works). */
  let startedOnPill = false;
  /** True once we are actually dragging the strip (immediate if mousedown was not on a pill). */
  let dragActive = false;
  /** px horizontal movement on a pill before treating gesture as scroll */
  const PILL_DRAG_THRESHOLD = 8;

  const clampScrollLeft = (left) => {
    const max = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    return Math.max(0, Math.min(max, left));
  };

  const tickDragScroll = () => {
    scrollRaf = 0;
    let target;
    if (isDown) {
      if (startedOnPill && !dragActive) {
        return;
      }
      const dx = pendingPageX - startX;
      if (Math.abs(dx) > 4) suppressClickUntil = Date.now() + 150;
      target = clampScrollLeft(startLeft - dx);
    } else if (coastTarget != null) {
      target = coastTarget;
    } else {
      return;
    }

    const cur = scrollEl.scrollLeft;
    const diff = target - cur;
    const lerp = isDown ? DRAG_SCROLL_LERP : RELEASE_SCROLL_LERP;

    if (Math.abs(diff) < 0.55) {
      scrollEl.scrollLeft = target;
      if (!isDown && coastTarget != null) {
        coastTarget = null;
      }
    } else {
      scrollEl.scrollLeft = cur + diff * lerp;
    }

    const err = Math.abs(target - scrollEl.scrollLeft);
    if (err > 0.5) {
      scrollRaf = requestAnimationFrame(tickDragScroll);
    } else if (!isDown && coastTarget != null) {
      coastTarget = null;
    }
  };

  const stopDragging = () => {
    if (!isDown) return;
    isDown = false;
    scrollEl.classList.remove("is-dragging");
    document.body.classList.remove("tag-filter-dragging");
    try {
      if (!dragActive) {
        coastTarget = null;
        return;
      }
      const dx = pendingPageX - startX;
      coastTarget = clampScrollLeft(startLeft - dx);
      if (Math.abs(coastTarget - scrollEl.scrollLeft) <= 0.5) {
        scrollEl.scrollLeft = coastTarget;
        coastTarget = null;
        return;
      }
      if (!scrollRaf) scrollRaf = requestAnimationFrame(tickDragScroll);
    } finally {
      startedOnPill = false;
      dragActive = false;
    }
  };

  scrollEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (scrollRaf) {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = 0;
    }
    coastTarget = null;
    startedOnPill = !!e.target.closest(".tag-filter-pill");
    dragActive = !startedOnPill;
    isDown = true;
    startX = e.pageX;
    pendingPageX = e.pageX;
    startLeft = scrollEl.scrollLeft;
    suppressClickUntil = 0;
    if (dragActive) {
      scrollEl.classList.add("is-dragging");
      document.body.classList.add("tag-filter-dragging");
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    pendingPageX = e.pageX;
    if (startedOnPill && !dragActive) {
      const dx = pendingPageX - startX;
      if (Math.abs(dx) >= PILL_DRAG_THRESHOLD) {
        dragActive = true;
        scrollEl.classList.add("is-dragging");
        document.body.classList.add("tag-filter-dragging");
        suppressClickUntil = Date.now() + 150;
      } else {
        return;
      }
    }
    if (!scrollRaf) scrollRaf = requestAnimationFrame(tickDragScroll);
    e.preventDefault();
  });

  window.addEventListener("mouseup", stopDragging);
  window.addEventListener("mouseleave", stopDragging);

  scrollEl.addEventListener("click", (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

/** Refresh media preview item from state.inspirations when loadInspirations completes (e.g. after palette auto-extraction). */
function refreshMediaPreviewItemFromState() {
  if (!mediaPreviewItem?.id) return;
  const overlay = $("#mediaPreview");
  if (!overlay || overlay.classList.contains("hidden")) return;
  const fresh = state.inspirations.find((i) => i.id === mediaPreviewItem.id);
  if (!fresh) return;
  mediaPreviewItem = fresh;
}

/** @param shuffle If true, randomize the current result set (Shuffle order menu only). Default false: keep API order (newest first). */
async function loadInspirations(shuffle = false) {
  const finishLoading = startGlobalLoadingTask();
  try {
    if (state.view.startsWith("collection:")) {
      const collectionId = state.view.split(":")[1];
      let items = [];
      let offset = 0;
      for (;;) {
        const params = {
          query: state.query,
          limit: LIST_INSPIRATIONS_MAX_LIMIT,
          offset,
          collectionId,
        };
        if (state.colorFilter) {
          params.colorFilter = { r: state.colorFilter.r, g: state.colorFilter.g, b: state.colorFilter.b };
        }
        if (state.selectedTagId) {
          params.tagId = state.selectedTagId;
        }
        const result = await window.qooti.listInspirations(params);
        const batch = Array.isArray(result) ? result : [];
        if (!Array.isArray(result)) {
          console.warn("[qooti] listInspirations returned non-array:", result);
        }
        items = items.concat(batch);
        if (batch.length < LIST_INSPIRATIONS_MAX_LIMIT) break;
        offset += LIST_INSPIRATIONS_MAX_LIMIT;
      }
      state.inspirations = items;
      state.inspirationsHasMore = false;
      if (shuffle && items.length > 0) {
        shuffleArray(state.inspirations);
      }
      renderGrid();
      refreshMediaPreviewItemFromState();
      return;
    }

    const params = {
      query: state.query,
      limit: GRID_INITIAL_LIMIT,
      offset: 0,
    };
    if (state.colorFilter) {
      params.colorFilter = { r: state.colorFilter.r, g: state.colorFilter.g, b: state.colorFilter.b };
    }
    if (state.selectedTagId) {
      params.tagId = state.selectedTagId;
    }
    const result = await window.qooti.listInspirations(params);
    let items = Array.isArray(result) ? result : [];
    if (!Array.isArray(result)) {
      console.warn("[qooti] listInspirations returned non-array:", result);
    }
    if (shouldPersonalizeHomeGrid(state) && !shuffle && items.length > 1) {
      items = applyPersonalizedHomeOrder(items, undefined, getHomePersonalizedHeadCount());
    }
    state.inspirations = items;
    state.inspirationsHasMore = items.length >= GRID_INITIAL_LIMIT;
    if (shuffle && items.length > 0) {
      shuffleArray(state.inspirations);
    }
    renderGrid();
    void autofillShortFormRowIfNeeded();
    refreshMediaPreviewItemFromState();
  } catch (e) {
    console.error("[qooti] loadInspirations failed:", e?.message || e);
    if (window.qooti?.debug) window.qooti.debug();
    state.inspirations = [];
    state.inspirationsHasMore = false;
    renderGrid();
  } finally {
    finishLoading();
  }
}

async function loadMoreInspirations() {
  if (state.inspirationsLoadingMore || !state.inspirationsHasMore) return;
  const offsetAtStart = state.inspirations.length;
  state.inspirationsLoadingMore = true;
  updateGridLazySpinner(true);
  try {
    const params = {
      query: state.query,
      limit: GRID_LOAD_MORE_LIMIT,
      offset: offsetAtStart,
    };
    if (state.view.startsWith("collection:")) {
      params.collectionId = state.view.split(":")[1];
    }
    if (state.colorFilter) {
      params.colorFilter = { r: state.colorFilter.r, g: state.colorFilter.g, b: state.colorFilter.b };
    }
    if (state.selectedTagId) {
      params.tagId = state.selectedTagId;
    }
    const result = await window.qooti.listInspirations(params);
    const items = Array.isArray(result) ? result : [];
    if (state.inspirations.length !== offsetAtStart) {
      return;
    }
    state.inspirations = state.inspirations.concat(items);
    if (shouldPersonalizeHomeGrid(state) && state.inspirations.length > 1) {
      state.inspirations = applyPersonalizedHomeOrder(
        state.inspirations,
        undefined,
        getHomePersonalizedHeadCount()
      );
    }
    state.inspirationsHasMore = items.length >= GRID_LOAD_MORE_LIMIT;
    renderGrid();
  } catch (e) {
    console.warn("[qooti] loadMoreInspirations failed:", e?.message || e);
    state.inspirationsHasMore = false;
  } finally {
    state.inspirationsLoadingMore = false;
    updateGridLazySpinner(false);
  }
}

async function autofillShortFormRowIfNeeded() {
  if (state.view !== "all") return;
  if (state.query || state.selectedTagId || state.colorFilter) return;
  if (state.inspirationsLoadingMore || !state.inspirationsHasMore) return;
  const gridView = $("#gridView");
  if (!gridView) return;

  // Keep home feed responsive, but ensure short-form row is populated without requiring scroll.
  const targetVisibleShort = Math.max(1, computeShortFormCols(gridView.offsetWidth || 0));
  let shortCount = state.inspirations.filter(showsInShortFormRow).length;
  if (shortCount >= targetVisibleShort) return;

  let pagesLoaded = 0;
  while (
    state.inspirationsHasMore
    && !state.inspirationsLoadingMore
    && shortCount < targetVisibleShort
    && pagesLoaded < SHORT_FORM_AUTOFILL_MAX_EXTRA_PAGES
  ) {
    pagesLoaded += 1;
    await loadMoreInspirations();
    shortCount = state.inspirations.filter(showsInShortFormRow).length;
  }
}

let gridLazyObserver = null;

function setupGridLazyLoad() {
  const gridView = $("#gridView");
  const sentinel = $("#gridLazySentinel");
  if (!gridView || !sentinel) return;

  if (gridLazyObserver) {
    gridLazyObserver.disconnect();
    gridLazyObserver = null;
  }

  const isGridVisible = !gridView.classList.contains("hidden");
  if (!isGridVisible || !state.inspirationsHasMore) {
    sentinel.classList.add("hidden");
    return;
  }

  sentinel.classList.remove("hidden");
  gridLazyObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && state.inspirationsHasMore && !state.inspirationsLoadingMore) {
          loadMoreInspirations();
          break;
        }
      }
    },
    { root: gridView, rootMargin: "400px 0px", threshold: 0 }
  );
  gridLazyObserver.observe(sentinel);
}

function updateGridLazySpinner(show) {
  const spinner = $("#gridLazySpinner");
  if (spinner) spinner.classList.toggle("hidden", !show);
}

/** Timeout a promise so extension add never hangs indefinitely. */
function withExtensionTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(label || "Operation timed out")), ms)
  );
  return Promise.race([promise, timeout]);
}

/** Process items sent from the Chrome extension (drain extension queue). Notifications only after operation completes. */
async function processExtensionPending() {
  if (!window.qooti?.getExtensionPending) {
    if (!window.__qootiMissingExtensionPendingWarned) {
      window.__qootiMissingExtensionPendingWarned = true;
      console.warn("[qooti] getExtensionPending API is missing; extension queue polling is disabled.");
    }
    return;
  }
  let items;
  try {
    items = await window.qooti.getExtensionPending();
  } catch (e) {
    console.warn("[qooti] get_extension_pending failed:", e?.message || e);
    return;
  }
  if (!Array.isArray(items) || items.length === 0) return;
  console.log("[qooti] processing extension queue items:", items.length);
  const EXTENSION_OP_MS = 45000;
  for (const p of items) {
    const url = (p.url || "").trim();
    const title = (p.pageTitle || p.pageUrl || url || "").trim();
    const action = p.action || "add";
    const mediaType = (p.mediaType || "image").toLowerCase();
    if (!url) continue;
    try {
      if (action === "link" || mediaType === "link") {
        let linkMeta = { title: title || undefined };
        try {
          if (window.qooti?.fetchLinkPreview && /youtube|youtu\.be/i.test(url)) {
            const preview = await withExtensionTimeout(
              window.qooti.fetchLinkPreview(url),
              15000,
              "Fetch link preview timed out"
            );
            if (preview && typeof preview === "object") {
              linkMeta = {
                title: (preview.title || title || "").trim() || undefined,
                thumbnailUrl: preview.thumbnailUrl || undefined,
                aspectRatio: typeof preview.aspectRatio === "number" ? preview.aspectRatio : undefined,
              };
            }
          }
        } catch (_) {}
        const result = await withExtensionTimeout(
          window.qooti.addLinkInspiration(url, linkMeta),
          EXTENSION_OP_MS,
          "Add link timed out"
        );
        const item = result?.inspiration ?? (result?.id ? { id: result.id, type: "link", title: linkMeta.title || title, tags: [] } : null);
        await refreshData();
        await loadInspirations(false);
        maybeScheduleOcrForItemType(item?.type || "link");
        scheduleDelayedRefreshForNewItems();
        notifyMediaAdd("Media added to Qooti", { durationMs: 3200, item, variant: "success" });
        console.log("[qooti] extension item processed:", action, url.slice(0, 120));
      } else if (action === "thumbnail") {
        const isVideo = mediaType === "video" || /youtube|youtu\.be|instagram|tiktok/i.test(url);
        if (isVideo) {
          const result = await withExtensionTimeout(
            window.qooti.addThumbnailFromVideoUrl(url, title || undefined ),
            EXTENSION_OP_MS,
            "Add thumbnail (video) timed out"
          );
          const item = result?.id ? { id: result.id, type: result.type || "image", title: result.title, tags: result.tags || [] } : null;
          await refreshData();
          await loadInspirations(false);
          maybeScheduleOcrForItemType(item?.type);
          scheduleDelayedRefreshForNewItems();
          notifyMediaAdd("Media added to Qooti", { durationMs: 3200, item, variant: "success" });
          console.log("[qooti] extension item processed:", action, url.slice(0, 120));
        } else {
          const result = await withExtensionTimeout(
            window.qooti.addThumbnailFromUrl(url, title || undefined),
            EXTENSION_OP_MS,
            "Add thumbnail timed out"
          );
          const item = result?.id ? { id: result.id, type: result.type || "image", title: result.title, tags: result.tags || [] } : null;
          await refreshData();
          await loadInspirations(false);
          maybeScheduleOcrForItemType(item?.type);
          scheduleDelayedRefreshForNewItems();
          notifyMediaAdd("Media added to Qooti", { durationMs: 3200, item, variant: "success" });
          console.log("[qooti] extension item processed:", action, url.slice(0, 120));
        }
      } else if (action === "download" || action === "add") {
        const isVideo = mediaType === "video" || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) || /youtube|youtu\.be|instagram|tiktok/i.test(url);
        if (isVideo) {
          notifyMediaAdd("Downloading video…", { durationMs: 2000, variant: "info" });
          const result = await withExtensionTimeout(
            downloadVideoWithProgressUI(url, title || undefined),
            EXTENSION_OP_MS,
            "Video download timed out"
          );
          if (result?.cancelled) {
            console.log("[qooti] extension video download cancelled:", url.slice(0, 120));
            return;
          }
          const insp = result?.inspiration;
          const item = insp ? { id: insp.id, type: insp.type || "video", title: insp.title, tags: insp.tags || [] } : null;
          await refreshData();
          await loadInspirations(false);
          scheduleDelayedRefreshForNewItems();
          notifyMediaAdd("Video added to Qooti", { durationMs: 3200, item, variant: "success" });
          console.log("[qooti] extension item processed:", action, url.slice(0, 120));
        } else {
          const result = await withExtensionTimeout(
            window.qooti.addThumbnailFromUrl(url, title || undefined),
            EXTENSION_OP_MS,
            "Add thumbnail timed out"
          );
          const item = result?.id ? { id: result.id, type: result.type || "image", title: result.title, tags: result.tags || [] } : null;
          await refreshData();
          await loadInspirations(false);
          maybeScheduleOcrForItemType(item?.type);
          scheduleDelayedRefreshForNewItems();
          notifyMediaAdd("Media added to Qooti", { durationMs: 3200, item, variant: "success" });
          console.log("[qooti] extension item processed:", action, url.slice(0, 120));
        }
      }
    } catch (err) {
      console.warn("[qooti] extension item failed:", url?.slice(0, 60), err?.message || err);
      notifyMediaAdd("Extension add failed: " + (err?.message || "Unknown error").slice(0, 50), { variant: "error" });
    }
  }
}

let _delayedRefreshTimer = null;
/** After adding media, palette (and tags) are updated in the background. Schedule a refresh so the grid and preview show the final state. */
function scheduleDelayedRefreshForNewItems() {
  if (_delayedRefreshTimer) clearTimeout(_delayedRefreshTimer);
  _delayedRefreshTimer = setTimeout(async () => {
    _delayedRefreshTimer = null;
    try {
      await loadInspirations(false);
    } catch (_) {}
    scheduleOcrAutoIndex();
  }, 3000);
}

function buildCard(it) {
    const s = state.settings;
    const card = document.createElement("div");
    card.className = "card";
    const cardSize = s.cardSize || "medium";
    if (cardSize !== "medium") card.classList.add(`card--${cardSize}`);
    card.dataset.id = it.id;

    const thumbUrl = it.thumbnail_path_url;
    const storedUrl = it.stored_path_url;
    const isLocalVideo = it.type === "video" && storedUrl;
    const ytId = it.type === "link" && it.source_url ? youtubeVideoId(it.source_url) : null;
    // Use only local URLs — remote i.ytimg.com is blocked by Tracking Prevention in many environments
    const hasLocalThumb = !!(thumbUrl || (storedUrl && (it.type === "image" || it.type === "gif")));
    const displayThumbUrl = hasLocalThumb ? (thumbUrl || storedUrl) : null;
    const isYoutubeLink = !!ytId;
    const mediaUrl = storedUrl || thumbUrl;
    const isSelected = state.selected.has(it.id);
    if (isSelected) card.classList.add("is-selected");

    const showMediaTitle = s.showMediaTitle !== "false";
    const showTitlesOnHover = s.showTitlesOnHover !== "false";
    const showSourceLabels = s.showSourceLabels !== "false";
    const showCollectionIndicator = s.showCollectionIndicator !== "false";
    const hasCustomTitle = showMediaTitle && it.title && it.title !== it.original_filename;
    const src = sourceType(it);
    const label = SOURCE_LABELS[src] || SOURCE_LABELS.web;
    const inCollectionView = state.view?.startsWith("collection:");
    const currentCollectionId = inCollectionView ? state.view.split(":")[1] : "";
    const collectionName = inCollectionView
      ? formatCollectionIndicatorText([
        { id: currentCollectionId, name: state.currentCollectionName || "Collection" }
      ])
      : getCachedCollectionLabelText(it.id);
    const showCollectionLabel = showCollectionIndicator && !!collectionName;
    const collectionIcon = remixIcon("collection.svg", "ui-icon ui-icon--sm card-label__icon");
    const collectionLabel = `<span class="card-label card-label--collection js-collection-label" ${
      showCollectionLabel ? "" : 'style="display:none"'
    }>${collectionIcon}<span class="js-collection-label-text">${escapeHtml(collectionName)}</span></span>`;

    const thumbContent =
      isLocalVideo
        ? `<video class="thumb__video" muted loop playsinline preload="metadata"></video>`
        : displayThumbUrl
          ? `<img alt="" />`
          : isYoutubeLink
            ? `<div class="thumb__placeholder" aria-hidden="true">▶</div>`
            : "";
    const durationBadge = isLocalVideo ? `<span class="thumb__duration hidden"></span>` : "";
    card.innerHTML = `
      <div class="thumb">
        <div class="thumb__overlay"></div>
        <div class="thumb__select" title="Select">${isSelected ? "✓" : ""}</div>
        ${durationBadge}
        ${thumbContent}
      </div>
      <div class="card-body">
        <div class="title"></div>
        <span class="card-label card-label--${src}" ${showSourceLabels ? "" : ' style="display:none"'}>${label.icon}<span>${label.text}</span></span>
        ${collectionLabel}
      </div>
    `;
    card.classList.toggle("card--show-title-always", !showTitlesOnHover);
    if (showCollectionIndicator && !inCollectionView && !collectionName) {
      requestCollectionLabelForItem(it, card);
    }

    if (isLocalVideo && mediaUrl) {
      const video = card.querySelector(".thumb__video");
      const durationEl = card.querySelector(".thumb__duration");
      video.src = loadableUrl(mediaUrl, it.stored_path);
      const posterUrl = thumbUrl ? loadableUrl(thumbUrl, it.thumbnail_path) : "";
      if (posterUrl) video.poster = posterUrl;
      video.addEventListener("loadedmetadata", () => {
        if (!durationEl || !isFinite(video.duration) || video.duration <= 0) return;
        durationEl.textContent = formatDuration(video.duration);
        durationEl.classList.remove("hidden");
      }, { once: true });
      card.addEventListener("mouseenter", () => {
        video.play().catch(() => {});
      });
      card.addEventListener("mouseleave", () => {
        video.pause();
        video.currentTime = 0;
      });
    } else if (isYoutubeLink && displayThumbUrl && thumbUrl) {
      const imgEl = card.querySelector("img");
      wireVaultImageFallback(imgEl, it, true);
      if (USE_YOUTUBE_EMBED) {
        let embedEl = null;
        const thumb = card.querySelector(".thumb");
        card.addEventListener("mouseenter", () => {
          if (embedEl) return;
          embedEl = document.createElement("iframe");
          embedEl.className = "thumb__embed";
          embedEl.src = youtubeEmbedUrl(ytId);
          embedEl.title = "YouTube";
          embedEl.setAttribute(
            "allow",
            "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          );
          embedEl.allowFullscreen = true;
          thumb.appendChild(embedEl);
        });
        card.addEventListener("mouseleave", () => {
          if (embedEl && embedEl.parentNode) {
            embedEl.remove();
            embedEl = null;
          }
        });
      }
    } else if (displayThumbUrl) {
      const imgEl = card.querySelector("img");
      wireVaultImageFallback(imgEl, it, !!thumbUrl);
    }

    if (hasCustomTitle) {
      card.querySelector(".title").textContent = it.title;
    }

    const sel = card.querySelector(".thumb__select");
    sel.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.selected.has(it.id)) state.selected.delete(it.id);
      else state.selected.add(it.id);
      updateSelectionBar();
      card.classList.toggle("is-selected", state.selected.has(it.id));
      sel.textContent = state.selected.has(it.id) ? "✓" : "";
    });

    card.addEventListener("click", () => openPreview(it));
    if (state.settings.enableContextMenu !== "false") {
      card.addEventListener("contextmenu", (e) => showContextMenu(e, it));
    }

    // Drag to move between rows
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      const fromRow = showsInShortFormRow(it) ? "short-form" : "main";
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData(ROW_MOVE_TYPE, JSON.stringify({ id: it.id, fromRow }));
      const absPath = it.stored_path_abs || it.thumbnail_path_abs;
      const relPath = it.stored_path || it.thumbnail_path || "";
      if (absPath) {
        const fileUri = toFileUri(absPath);
        e.dataTransfer.setData("text/plain", absPath);
        if (fileUri) e.dataTransfer.setData("text/uri-list", fileUri);
        const downloadUrl = dragDownloadUrl(absPath, relPath);
        if (downloadUrl) e.dataTransfer.setData("DownloadURL", downloadUrl);
      }
      card.classList.add("card--dragging");
      if (fromRow === "main") {
        const section = $("#shortFormSection");
        if (section?.classList.contains("hidden")) section.classList.add("row-drop-reveal");
      }
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("card--dragging");
      $("#shortFormSection")?.classList.remove("row-drop-reveal");
    });

    return card;
}

const GUTTER_PX = 18;
const shortFormExpansion = new Map();

/** True when a named tag pill is active (e.g. "apple"). All / Recent only keep collapsible short rows. */
function isSpecificTagPillFilterActive() {
  return !!(state.selectedTagId && String(state.selectedTagId).trim());
}

function computeLongFormCols(containerWidth) {
  const s = state.settings;
  const density = s.gridDensity || "comfortable";
  const baseMin = density === "compact" ? 200 : 260;
  const cardSize = document.documentElement.dataset.cardSize || "medium";
  const mult = cardSize === "small" ? 0.85 : cardSize === "large" ? 1.15 : 1;
  const cardMin = Math.round(baseMin * mult);
  const padding = 2 * GUTTER_PX;
  const available = Math.max(0, containerWidth - padding);
  return Math.max(1, Math.floor(available / (cardMin + GUTTER_PX)));
}

/** Item count for “relatable” top of home feed ≈ three long-form rows (no extra UI). */
function getHomePersonalizedHeadCount() {
  const gridView = $("#gridView");
  const w = gridView?.offsetWidth || Math.min(1280, Math.max(400, (typeof window !== "undefined" ? window.innerWidth : 1100) - 40));
  const cols = computeLongFormCols(w);
  return Math.max(6, cols * 3);
}

/** Min track width for short-form grid — must match CSS --short-card-width (incl. data-card-size). */
function getShortCardMinPx() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--short-card-width").trim();
  const m = /^(\d+(?:\.\d+)?)px$/i.exec(raw);
  if (m) return Math.max(80, Math.round(parseFloat(m[1])));
  const cardSize = document.documentElement.dataset.cardSize || "medium";
  if (cardSize === "small") return 120;
  if (cardSize === "large") return 170;
  return 140;
}

/** Columns that fit in the short-form row (narrow cards); used to size interleaved short chunks (2 rows per section). */
function computeShortFormCols(containerWidth) {
  const shortMin = getShortCardMinPx();
  const padding = 2 * GUTTER_PX;
  const available = Math.max(0, containerWidth - padding);
  return Math.max(1, Math.floor(available / (shortMin + GUTTER_PX)));
}

function chunkArray(items, size) {
  const out = [];
  if (!Array.isArray(items) || items.length === 0 || size <= 0) return out;
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function renderItemsIntoGrid(gridEl, items) {
  if (!gridEl) return;
  gridEl.innerHTML = "";
  for (const it of items) gridEl.appendChild(buildCard(it));
}

function measureShortFormHeights(gridEl) {
  const cards = Array.from(gridEl?.children || []);
  if (cards.length === 0) {
    return { oneRowHeight: 0, twoRowsHeight: 0, totalHeight: 0, rowCount: 0, rowTops: [] };
  }

  const tops = [];
  for (const card of cards) {
    const top = card.offsetTop;
    if (!tops.some((t) => Math.abs(t - top) <= 1)) tops.push(top);
  }
  tops.sort((a, b) => a - b);
  const firstTop = tops[0];

  let firstBottom = firstTop;
  for (const card of cards) {
    if (Math.abs(card.offsetTop - firstTop) <= 1) {
      firstBottom = Math.max(firstBottom, card.offsetTop + card.offsetHeight);
    }
  }
  const oneRowHeight = Math.max(1, firstBottom - firstTop);

  const secondRowTop = tops[Math.min(1, tops.length - 1)];
  let secondRowBottom = secondRowTop;
  for (const card of cards) {
    if (Math.abs(card.offsetTop - secondRowTop) <= 1) {
      secondRowBottom = Math.max(secondRowBottom, card.offsetTop + card.offsetHeight);
    }
  }
  const totalHeight = gridEl.scrollHeight;
  const twoRowsHeight =
    tops.length >= 2
      ? Math.max(oneRowHeight * 2, secondRowBottom - firstTop)
      : Math.min(totalHeight, Math.max(oneRowHeight, totalHeight));

  return { oneRowHeight, twoRowsHeight, totalHeight, rowCount: tops.length, rowTops: tops };
}

function applyShortFormSectionState(sectionEl, itemCount) {
  if (!sectionEl) return;
  const gridEl = sectionEl.querySelector(".short-form-grid");
  const toggleBtn = sectionEl.querySelector("[data-short-toggle]");
  if (!gridEl || !toggleBtn) return;

  const inCollectionView = state.view && String(state.view).startsWith("collection:");
  if (isSpecificTagPillFilterActive() || inCollectionView) {
    gridEl.style.maxHeight = "none";
    gridEl.style.overflow = "visible";
    toggleBtn.classList.add("hidden");
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.onclick = null;
    return;
  }

  gridEl.style.overflow = "";

  const key = sectionEl.dataset.shortSectionKey || sectionEl.id || "short-form-default";
  const expanded = shortFormExpansion.get(key) === true;
  const { oneRowHeight, twoRowsHeight, totalHeight, rowCount, rowTops } = measureShortFormHeights(gridEl);
  const canToggle = itemCount > 0 && rowCount > 1;
  const collapsedHeight =
    rowCount >= 2
      ? Math.max(1, Math.floor((rowTops[1] - rowTops[0]) - 0.5))
      : Math.max(1, oneRowHeight);
  const expandedTwoRowsHeight =
    rowCount >= 3
      ? Math.max(collapsedHeight, Math.floor((rowTops[2] - rowTops[0]) - 0.5))
      : Math.max(collapsedHeight, twoRowsHeight);
  const targetHeight = expanded
    ? Math.min(totalHeight, Math.max(expandedTwoRowsHeight, collapsedHeight))
    : Math.min(totalHeight, collapsedHeight);

  gridEl.style.maxHeight = `${Math.max(0, targetHeight)}px`;
  toggleBtn.classList.toggle("hidden", !canToggle);
  toggleBtn.textContent = expanded ? "Show less" : "Show more";
  toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggleBtn.onclick = () => {
    const beforeTop = sectionEl.getBoundingClientRect().top;
    shortFormExpansion.set(key, !expanded);
    applyShortFormSectionState(sectionEl, itemCount);
    const afterTop = sectionEl.getBoundingClientRect().top;
    window.scrollBy(0, afterTop - beforeTop);
  };

  // Cards can settle a frame later (image decode/font metrics). Re-apply once for exact clipping.
  const settleToken = `${itemCount}:${gridEl.childElementCount}`;
  if (sectionEl.dataset.shortMeasureToken !== settleToken) {
    sectionEl.dataset.shortMeasureToken = settleToken;
    setTimeout(() => {
      if (!sectionEl.isConnected) return;
      if (sectionEl.dataset.shortMeasureToken !== settleToken) return;
      applyShortFormSectionState(sectionEl, itemCount);
    }, 90);
  }
}

function createInjectedLongSection(items, index) {
  const section = document.createElement("section");
  section.className = "gallery-section gallery-section--long";
  section.dataset.feedInjected = "1";
  section.dataset.feedType = "long";
  section.dataset.feedIndex = String(index);
  const grid = document.createElement("div");
  grid.className = "grid grid--long-form";
  section.appendChild(grid);
  renderItemsIntoGrid(grid, items);
  setupRowDropZone(grid, "main");
  return section;
}

function createInjectedShortSection(items, index) {
  const section = document.createElement("section");
  section.className = "gallery-section gallery-section--short";
  section.dataset.feedInjected = "1";
  section.dataset.feedType = "short";
  section.dataset.shortSectionKey = `short-dynamic-${index}`;
  const grid = document.createElement("div");
  grid.className = "short-form-grid";
  const controls = document.createElement("div");
  controls.className = "short-form-controls";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "short-form-toggle hidden";
  toggle.dataset.shortToggle = "";
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Show more";
  controls.appendChild(toggle);
  section.appendChild(grid);
  section.appendChild(controls);

  renderItemsIntoGrid(grid, items);
  setupRowDropZone(grid, "short-form");
  applyShortFormSectionState(section, items.length);
  section.classList.toggle("hidden", items.length === 0);
  return section;
}

function renderGrid() {
  const shortFormSection = $("#shortFormSection");
  const shortFormGrid = $("#shortFormGrid");
  const shortFormToggleBtn = $("#shortFormToggleBtn");
  const longFormSection1 = $("#longFormSection1");
  const longFormGrid1 = $("#longFormGrid1");
  const longFormSection2 = $("#longFormSection2");
  const longFormGrid2 = $("#longFormGrid2");
  const gridView = $("#gridView");

  if (!gridView || !shortFormGrid || !longFormGrid1 || !longFormGrid2) return;

  for (const injected of gridView.querySelectorAll("[data-feed-injected='1']")) {
    injected.remove();
  }

  const shortFormItems = state.inspirations.filter(showsInShortFormRow);
  const mainItems = state.inspirations.filter((it) => !showsInShortFormRow(it));

  if (!vaultImageDiagLogged && state.inspirations.length > 0) {
    vaultImageDiagLogged = true;
    const firstItem = state.inspirations[0];
    console.log("[DIAG] item payload:", JSON.stringify({
      id: firstItem?.id,
      stored_path: firstItem?.stored_path,
      stored_path_url: firstItem?.stored_path_url,
      stored_path_abs: firstItem?.stored_path_abs,
      thumbnail_path: firstItem?.thumbnail_path,
      thumbnail_path_url: firstItem?.thumbnail_path_url,
      thumbnail_path_abs: firstItem?.thumbnail_path_abs,
      mime_type: firstItem?.mime_type,
      vault_id: firstItem?.vault_id,
      original_filename: firstItem?.original_filename,
    }));
    const testSrc = firstItem?.stored_path_url || firstItem?.thumbnail_path_url || "";
    if (testSrc) {
      const testImg = new Image();
      testImg.onload = () => console.log("[DIAG] img loaded OK:", testSrc);
      testImg.onerror = (e) => console.log("[DIAG] img onerror fired:", e);
      testImg.src = testSrc;
    }
  }

  const longCols = gridView ? computeLongFormCols(gridView.offsetWidth) : 4;
  const shortCols = gridView ? computeShortFormCols(gridView.offsetWidth) : Math.max(1, longCols);
  const longChunkSize = Math.max(1, 2 * longCols);
  const shortChunkSize = Math.max(1, 2 * shortCols);
  const longChunks = chunkArray(mainItems, longChunkSize);
  const shouldInterleaveShortRows =
    shortFormItems.length > shortChunkSize && longChunks.length > 1;
  const shortChunks = shouldInterleaveShortRows
    ? chunkArray(shortFormItems, shortChunkSize)
    : [shortFormItems];

  // Static base slots: grid1 = first chunk, grid2 = second chunk
  renderItemsIntoGrid(longFormGrid1, longChunks[0] || []);
  renderItemsIntoGrid(shortFormGrid, shortChunks[0] || []);
  renderItemsIntoGrid(longFormGrid2, longChunks[1] || []);

  longFormSection1?.classList.toggle("hidden", (longChunks[0] || []).length === 0);
  longFormSection2?.classList.toggle("hidden", (longChunks[1] || []).length === 0);
  shortFormSection?.classList.toggle("hidden", (shortChunks[0] || []).length === 0);

  if (shortFormSection) {
    shortFormSection.dataset.shortSectionKey = "short-static-0";
  }
  if (shortFormToggleBtn) {
    shortFormToggleBtn.dataset.shortToggle = "";
  }
  applyShortFormSectionState(shortFormSection, (shortChunks[0] || []).length);

  // Inject remaining long-form chunks (2+) and short-form chunks (1+)
  if (shouldInterleaveShortRows) {
    let nextShort = 1;
    let nextLong = 2;
    while (nextShort < shortChunks.length || nextLong < longChunks.length) {
      if (nextShort < shortChunks.length) {
        const shortSection = createInjectedShortSection(shortChunks[nextShort], nextShort);
        gridView.appendChild(shortSection);
        nextShort += 1;
      }
      if (nextLong < longChunks.length) {
        const longSection = createInjectedLongSection(longChunks[nextLong], nextLong);
        gridView.appendChild(longSection);
        nextLong += 1;
      }
    }
  } else if (longChunks.length > 2) {
    for (let i = 2; i < longChunks.length; i++) {
      gridView.appendChild(createInjectedLongSection(longChunks[i], i));
    }
  }

  const emptyState = $("#emptyState");
  const hasContent = state.inspirations.length > 0;
  if (emptyState) emptyState.classList.toggle("hidden", hasContent);

  const sentinel = $("#gridLazySentinel");
  const spinner = $("#gridLazySpinner");
  if (sentinel) gridView.appendChild(sentinel);
  if (spinner) gridView.appendChild(spinner);

  setupGridLazyLoad();
}

let gridResizeObserver = null;
let gridResizeTimer = null;

function setupGridResizeObserver() {
  const gridView = $("#gridView");
  if (!gridView || gridResizeObserver) return;
  gridResizeObserver = new ResizeObserver(() => {
    if (gridResizeTimer) clearTimeout(gridResizeTimer);
    gridResizeTimer = setTimeout(renderGrid, 100);
  });
  gridResizeObserver.observe(gridView);
}

let mediaPreviewItem = null;
let mediaPreviewCollections = [];
let copyKeyHandler = null;
let mediaPreviewKeyHandler = null;
let mediaPreviewVideoCleanup = null;
let mediaPreviewLocalVideo = null;
let mediaPreviewYoutubePlayer = null;
let mediaPreviewYoutubeTicker = null;
let ocrDebugChordArmedUntil = 0;
let reelFeedItems = [];
let reelFeedScrollHandler = null;

function setMediaPreviewBackgroundBlur(active) {
  // Blur main content only — keep `header.title-bar` (window chrome) sharp.
  const blurRoot = document.querySelector("#app .app__main");
  if (!blurRoot) return;
  blurRoot.style.transition = "filter 0.25s ease";
  blurRoot.style.filter = active ? "blur(12px)" : "none";
}

function getSavedPlayerVolume() {
  const raw = state?.settings?.player_volume;
  const parsed = Number.parseFloat(String(raw ?? ""));
  if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  return 0.8;
}

function persistPlayerVolume(level) {
  const next = Math.max(0, Math.min(1, Number(level) || 0));
  state.settings.player_volume = String(next);
  saveSetting("player_volume", next).catch(() => {});
}

function clearMediaPreviewExternalPlayer() {
  if (mediaPreviewYoutubeTicker) {
    clearInterval(mediaPreviewYoutubeTicker);
    mediaPreviewYoutubeTicker = null;
  }
  if (mediaPreviewYoutubePlayer?.destroy) {
    try {
      mediaPreviewYoutubePlayer.destroy();
    } catch (_) {}
  }
  mediaPreviewYoutubePlayer = null;
  mediaPreviewLocalVideo = null;
}

function formatPreviewFileSize(bytesLike) {
  const n = Number(bytesLike);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function mediaPreviewTypeLabel(it) {
  const lang = (state.settings?.language || "en").toLowerCase() === "uz" ? "uz" : "en";
  const key =
    it?.type === "video"
      ? "preview.typeVideo"
      : it?.type === "link"
        ? "preview.typeLink"
        : it?.type === "gif"
          ? "preview.typeGif"
          : "preview.typeImage";
  return t(key, lang);
}

function mediaPreviewSequence() {
  const reelFeedEl = $("#mediaPreviewReelFeed");
  if (reelFeedEl && !reelFeedEl.classList.contains("hidden") && reelFeedItems.length > 0) return reelFeedItems;
  return Array.isArray(state.inspirations) ? state.inspirations : [];
}

function mediaPreviewCurrentIndex(items = mediaPreviewSequence()) {
  if (!mediaPreviewItem?.id || !Array.isArray(items) || items.length === 0) return -1;
  return items.findIndex((x) => x.id === mediaPreviewItem.id);
}

function updateMediaPreviewCounter() {
  const counterEl = $("#mediaPreviewCounter");
  if (!counterEl) return;
  const items = mediaPreviewSequence();
  const idx = mediaPreviewCurrentIndex(items);
  const current = idx >= 0 ? idx + 1 : 0;
  counterEl.textContent = `${current} / ${items.length || 0}`;
  const disabled = items.length <= 1;
  ["mediaPreviewPrevSide", "mediaPreviewNextSide"].forEach((id) => {
    const btn = $("#" + id);
    if (!btn) return;
    btn.toggleAttribute("disabled", disabled);
  });
}

function setMediaPreviewDimensions(width, height) {
  const el = $("#mediaPreviewDimensions");
  if (!el) return;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    el.textContent = "—";
    return;
  }
  el.textContent = `${Math.round(width)}×${Math.round(height)}`;
}

async function navigateMediaPreview(delta) {
  const items = mediaPreviewSequence();
  if (!items.length || !mediaPreviewItem?.id) return;
  const idx = mediaPreviewCurrentIndex(items);
  if (idx < 0) return;
  const next = (idx + delta + items.length) % items.length;
  const target = items[next];
  const reelFeedEl = $("#mediaPreviewReelFeed");
  if (reelFeedEl && !reelFeedEl.classList.contains("hidden")) {
    const h = reelFeedEl.clientHeight || 0;
    if (h > 0) reelFeedEl.scrollTo({ top: next * h, behavior: "smooth" });
    mediaPreviewItem = target;
    updateReelHeader(target);
    pauseAllReelMediaExcept(reelFeedEl, next);
    updateMediaPreviewCounter();
    return;
  }
  await showMediaPreview(target);
}

function buildReelSlideMedia(it) {
  const frame = document.createElement("div");
  frame.className = "media-preview__reel-frame";
  const wrap = document.createElement("div");
  wrap.className = "media-preview__reel-slide-media";
  if (it.type === "video") {
    const video = document.createElement("video");
    video.src = loadableUrl(it.stored_path_url, it.stored_path);
    video.controls = false;
    video.autoplay = false;
    video.muted = false;
    video.playsInline = true;
    video.loop = true;
    video.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    wrap.appendChild(video);
  } else if (it.type === "link") {
    const ytId = it.source_url ? youtubeVideoId(it.source_url) : null;
    if (ytId) {
      const iframe = document.createElement("iframe");
      const embedUrl = youtubeEmbedUrl(ytId) + "&autoplay=1";
      iframe.src = embedUrl;
      iframe.dataset.embedSrc = embedUrl;
      iframe.title = "YouTube";
      iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture");
      wrap.appendChild(iframe);
    } else {
      const thumb = it.thumbnail_path_url || "";
      if (thumb) {
        const img = document.createElement("img");
        wireVaultImageFallback(img, it, true);
        img.alt = it.title || "";
        wrap.appendChild(img);
      } else {
        const link = document.createElement("a");
        link.href = it.source_url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = it.source_url;
        wrap.appendChild(link);
      }
    }
  }
  frame.appendChild(wrap);
  return frame;
}

function updateReelHeader(it) {
  const titleEl = $("#mediaPreviewTitle");
  const badgeEl = $("#mediaPreviewBadge");
  const typeEl = $("#mediaPreviewType");
  const sizeEl = $("#mediaPreviewSize");
  if (titleEl) titleEl.textContent = truncateForDialog(it?.title || it?.original_filename || "Untitled", 55);
  if (badgeEl) {
    badgeEl.textContent = t("preview.localBadge", (state.settings?.language || "en"));
    badgeEl.className = "media-preview__badge media-preview__badge--local";
  }
  if (typeEl) typeEl.textContent = mediaPreviewTypeLabel(it);
  if (sizeEl) {
    const sizeBytes = it?.size_bytes ?? it?.file_size ?? it?.bytes ?? null;
    sizeEl.textContent = formatPreviewFileSize(sizeBytes);
  }
  setMediaPreviewDimensions(NaN, NaN);
  updateMediaPreviewCounter();
  syncMediaPreviewActionState(it);
}

function syncMediaPreviewActionState(it) {
  const pathToCopy = getMediaPreviewPathToCopy(it);
  $("#mediaPreviewCopy")?.toggleAttribute("disabled", !pathToCopy);
  const requiresId = !it?.id;
  $("#mediaPreviewAddToCollection")?.toggleAttribute("disabled", requiresId);
  $("#mediaPreviewEditTags")?.toggleAttribute("disabled", requiresId);
  $("#mediaPreviewFindRelated")?.toggleAttribute("disabled", requiresId);
  updateMediaPreviewCounter();
}

function formatMediaTime(sec) {
  const n = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  const mm = Math.floor(n / 60);
  const ss = Math.floor(n % 60);
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function setMediaPreviewButtonIcon(btn, iconUrl) {
  const icon = btn?.querySelector(".ui-icon");
  if (icon) icon.style.setProperty("--icon-url", iconUrl);
}

function updateMediaPreviewVolumeIcon(btn, level, isMuted) {
  const safeLevel = Math.max(0, Math.min(1, Number(level) || 0));
  const iconUrl =
    isMuted || safeLevel <= 0.0001
      ? "url('./assets/icons/player/volume-mute-fill.svg')"
      : safeLevel <= 0.5
        ? "url('./assets/icons/player/volume-down-fill.svg')"
        : "url('./assets/icons/player/volume-up-line.svg')";
  setMediaPreviewButtonIcon(btn, iconUrl);
}

function htmlVideoSeekableRange(video) {
  try {
    const sb = video.seekable;
    if (sb && sb.length > 0) {
      const start = sb.start(0);
      const end = sb.end(sb.length - 1);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return { start, end };
      }
    }
  } catch (_) {}
  return null;
}

function htmlVideoEffectiveDuration(video) {
  const d = Number(video.duration);
  if (Number.isFinite(d) && d > 0 && d !== Number.POSITIVE_INFINITY) return d;
  const r = htmlVideoSeekableRange(video);
  return r && Number.isFinite(r.end) && r.end > 0 ? r.end : 0;
}

function clampHtmlVideoSeekTime(video, t) {
  const raw = Number(t);
  if (!Number.isFinite(raw)) return 0;
  const dur = Number(video.duration);
  const r = htmlVideoSeekableRange(video);
  const finiteDur =
    Number.isFinite(dur) && dur > 0 && dur !== Number.POSITIVE_INFINITY;

  if (finiteDur) {
    let lo = 0;
    let hi = dur;
    if (r && r.end > 0) {
      const slack = Math.min(0.25, dur * 0.05);
      if (r.end >= dur - slack) {
        lo = Math.max(0, r.start);
        hi = Math.min(dur, r.end);
      }
    }
    return Math.max(lo, Math.min(hi, raw));
  }

  if (r) return Math.max(r.start, Math.min(r.end, raw));
  return Math.max(0, raw);
}

function wireVideoInspector(video, _item) {
  const overlay = $("#mediaPreviewVideoOverlay");
  const timelineWrap = $("#mediaPreviewTimelineWrap");
  const timelineTrack = $("#mediaPreviewTimelineTrack");
  const timelineBuffered = $("#mediaPreviewTimelineBuffered");
  const timelineProgress = $("#mediaPreviewTimelineProgress");
  const timelineThumb = $("#mediaPreviewTimelineThumb");
  const playPauseBtn = $("#mediaPreviewPlayPause");
  const timeEl = $("#mediaPreviewTime");
  const muteBtn = $("#mediaPreviewMute");
  const volWrap = $("#mediaPreviewVolumeWrap");
  const volProgress = $("#mediaPreviewVolumeProgress");
  const volThumb = $("#mediaPreviewVolumeThumb");
  if (!video || !overlay) return;

  if (typeof mediaPreviewVideoCleanup === "function") {
    mediaPreviewVideoCleanup();
    mediaPreviewVideoCleanup = null;
  }
  clearMediaPreviewExternalPlayer();
  mediaPreviewLocalVideo = video;
  overlay.classList.remove("hidden");
  setMediaPreviewDimensions(video.videoWidth, video.videoHeight);

  const playIcon = "url('./assets/icons/player/play-icon.svg')";
  const pauseIcon = "url('./assets/icons/player/pause-icon.svg')";
  const setTimelineReady = (ready) => {
    if (!timelineWrap) return;
    timelineWrap.style.pointerEvents = ready ? "auto" : "none";
    timelineWrap.style.opacity = ready ? "1" : "0.4";
  };

  const syncTimeline = () => {
    const duration = htmlVideoEffectiveDuration(video);
    const current = Number(video.currentTime) || 0;
    const pct = duration > 0 ? Math.max(0, Math.min(1, current / duration)) : 0;
    const bufferedEnd =
      duration > 0 && video.buffered && video.buffered.length > 0
        ? Math.max(0, Math.min(1, video.buffered.end(video.buffered.length - 1) / duration))
        : 0;
    if (timelineProgress) timelineProgress.style.width = `${pct * 100}%`;
    if (timelineThumb) timelineThumb.style.left = `${pct * 100}%`;
    if (timelineBuffered) timelineBuffered.style.width = `${bufferedEnd * 100}%`;
    if (timeEl) timeEl.textContent = `${formatMediaTime(current)} / ${formatMediaTime(duration)}`;
    setMediaPreviewButtonIcon(playPauseBtn, video.paused ? playIcon : pauseIcon);
    if (duration > 0) setTimelineReady(true);
  };

  const syncVolume = () => {
    const level = video.muted ? 0 : Number(video.volume) || 0;
    if (volProgress) volProgress.style.width = `${level * 100}%`;
    if (volThumb) volThumb.style.left = `${level * 100}%`;
    updateMediaPreviewVolumeIcon(muteBtn, level, video.muted);
  };

  const applySeekPct = (pct) => {
    const duration = htmlVideoEffectiveDuration(video);
    if (!duration || Number.isNaN(duration) || duration === 0) {
      return;
    }
    const nextTime = clampHtmlVideoSeekTime(video, pct * duration);
    video.currentTime = nextTime;
  };
  const seekFromClientX = (clientX) => {
    const seekRoot = timelineTrack || timelineWrap;
    if (!seekRoot) return;
    const rect = seekRoot.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const duration = htmlVideoEffectiveDuration(video);
    if (!duration || Number.isNaN(duration) || duration === 0) {
      console.warn(`[seek] blocked | reason=duration_not_ready | duration=${duration}`);
      return;
    }
    const target = clampHtmlVideoSeekTime(video, pct * duration);
    console.log(
      `[seek] | pct=${pct.toFixed(3)} | target=${target.toFixed(2)}s | duration=${duration.toFixed(2)}s | seekable=${JSON.stringify(htmlVideoSeekableRange(video))}`
    );
    applySeekPct(pct);
    syncTimeline();
  };

  const volumeFromClientX = (clientX) => {
    if (!volWrap) return;
    const rect = volWrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.volume = pct;
    if (video.muted && pct > 0) video.muted = false;
    persistPlayerVolume(video.muted ? 0 : pct);
    syncVolume();
  };

  let isScrubbing = false;
  let scrubPointerId = null;
  let isVolumeDragging = false;

  const onTimelinePointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isScrubbing = true;
    scrubPointerId = e.pointerId;
    timelineWrap?.setPointerCapture?.(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const onTimelinePointerMove = (e) => {
    if (!isScrubbing) return;
    if (scrubPointerId != null && e.pointerId !== scrubPointerId) return;
    seekFromClientX(e.clientX);
  };
  const onTimelinePointerUpOrCancel = (e) => {
    if (scrubPointerId != null && e.pointerId !== scrubPointerId) return;
    isScrubbing = false;
    if (scrubPointerId != null) {
      timelineWrap?.releasePointerCapture?.(scrubPointerId);
    }
    scrubPointerId = null;
  };
  const onVolumeMouseDown = (e) => {
    isVolumeDragging = true;
    volumeFromClientX(e.clientX);
  };
  timelineWrap?.addEventListener("pointerdown", onTimelinePointerDown);
  timelineWrap?.addEventListener("pointermove", onTimelinePointerMove);
  timelineWrap?.addEventListener("pointerup", onTimelinePointerUpOrCancel);
  timelineWrap?.addEventListener("pointercancel", onTimelinePointerUpOrCancel);
  volWrap?.addEventListener("mousedown", onVolumeMouseDown);

  const onMouseMove = (e) => {
    if (isVolumeDragging) volumeFromClientX(e.clientX);
  };
  const onMouseUp = () => {
    isScrubbing = false;
    scrubPointerId = null;
    isVolumeDragging = false;
  };
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  const onVideoClick = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    syncTimeline();
  };
  const onLoadedMetadata = () => {
    setMediaPreviewDimensions(video.videoWidth, video.videoHeight);
    const eff = htmlVideoEffectiveDuration(video);
    setTimelineReady(eff > 0);
    console.log(
      `[player] metadata loaded | duration=${(Number(video.duration) || 0).toFixed(2)}s | effective=${eff.toFixed(2)}s`
    );
    syncTimeline();
    syncVolume();
  };
  const onLoadStart = () => {
    setTimelineReady(false);
  };
  video.addEventListener("click", onVideoClick);
  video.addEventListener("loadstart", onLoadStart);
  video.addEventListener("timeupdate", syncTimeline);
  video.addEventListener("progress", syncTimeline);
  video.addEventListener("loadedmetadata", onLoadedMetadata);
  video.addEventListener("durationchange", syncTimeline);
  video.addEventListener("play", syncTimeline);
  video.addEventListener("pause", syncTimeline);
  video.addEventListener("volumechange", syncVolume);

  const onPlayPauseClick = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    syncTimeline();
  };
  const onMuteClick = () => {
    video.muted = !video.muted;
    persistPlayerVolume(video.muted ? 0 : Number(video.volume) || 0);
    syncVolume();
  };
  const onVolumeClick = (e) => volumeFromClientX(e.clientX);
  playPauseBtn?.addEventListener("click", onPlayPauseClick);
  muteBtn?.addEventListener("click", onMuteClick);
  volWrap?.addEventListener("click", onVolumeClick);

  const savedVolume = getSavedPlayerVolume();
  video.volume = savedVolume;
  video.muted = savedVolume <= 0.0001;
  setTimelineReady(htmlVideoEffectiveDuration(video) > 0);
  syncTimeline();
  syncVolume();
  video.play().catch((err) => {
    console.warn("[player] autoplay blocked:", err);
    syncTimeline();
  });

  mediaPreviewVideoCleanup = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    timelineWrap?.removeEventListener("pointerdown", onTimelinePointerDown);
    timelineWrap?.removeEventListener("pointermove", onTimelinePointerMove);
    timelineWrap?.removeEventListener("pointerup", onTimelinePointerUpOrCancel);
    timelineWrap?.removeEventListener("pointercancel", onTimelinePointerUpOrCancel);
    volWrap?.removeEventListener("mousedown", onVolumeMouseDown);
    video.removeEventListener("click", onVideoClick);
    video.removeEventListener("loadstart", onLoadStart);
    video.removeEventListener("timeupdate", syncTimeline);
    video.removeEventListener("progress", syncTimeline);
    video.removeEventListener("loadedmetadata", onLoadedMetadata);
    video.removeEventListener("durationchange", syncTimeline);
    video.removeEventListener("play", syncTimeline);
    video.removeEventListener("pause", syncTimeline);
    video.removeEventListener("volumechange", syncVolume);
    playPauseBtn?.removeEventListener("click", onPlayPauseClick);
    muteBtn?.removeEventListener("click", onMuteClick);
    volWrap?.removeEventListener("click", onVolumeClick);
    mediaPreviewLocalVideo = null;
  };
}

async function initMediaPreviewYouTubePlayer(hostEl, videoId) {
  await loadYouTubeAPI();
  return new Promise((resolve, reject) => {
    const savedVolume = getSavedPlayerVolume();
    new window.YT.Player(hostEl, {
      videoId,
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        fs: 0,
        playsinline: 1
      },
      events: {
        onReady: (e) => {
          try {
            e.target.setVolume(Math.round(savedVolume * 100));
            if (savedVolume <= 0.0001) e.target.mute();
            else e.target.unMute();
            e.target.playVideo();
          } catch (_) {}
          resolve(e.target);
        },
        onError: (e) => reject(new Error(`YouTube player error: ${e?.data ?? "unknown"}`))
      }
    });
  });
}

function wireYouTubeInspector(player) {
  const overlay = $("#mediaPreviewVideoOverlay");
  const timelineWrap = $("#mediaPreviewTimelineWrap");
  const timelineTrack = $("#mediaPreviewTimelineTrack");
  const timelineBuffered = $("#mediaPreviewTimelineBuffered");
  const timelineProgress = $("#mediaPreviewTimelineProgress");
  const timelineThumb = $("#mediaPreviewTimelineThumb");
  const playPauseBtn = $("#mediaPreviewPlayPause");
  const timeEl = $("#mediaPreviewTime");
  const muteBtn = $("#mediaPreviewMute");
  const volWrap = $("#mediaPreviewVolumeWrap");
  const volProgress = $("#mediaPreviewVolumeProgress");
  const volThumb = $("#mediaPreviewVolumeThumb");
  if (!player || !overlay) return;

  if (typeof mediaPreviewVideoCleanup === "function") {
    mediaPreviewVideoCleanup();
    mediaPreviewVideoCleanup = null;
  }
  mediaPreviewYoutubePlayer = player;
  overlay.classList.remove("hidden");
  setMediaPreviewDimensions(16, 9);

  const playIcon = "url('./assets/icons/player/play-icon.svg')";
  const pauseIcon = "url('./assets/icons/player/pause-icon.svg')";
  const setTimelineReady = (ready) => {
    if (!timelineWrap) return;
    timelineWrap.style.pointerEvents = ready ? "auto" : "none";
    timelineWrap.style.opacity = ready ? "1" : "0.4";
  };
  const ytPlaying = () => {
    try {
      return player.getPlayerState() === window.YT?.PlayerState?.PLAYING;
    } catch (_) {
      return false;
    }
  };
  const ytDuration = () => Number(player.getDuration?.() || 0);
  const ytCurrent = () => Number(player.getCurrentTime?.() || 0);

  const syncTimeline = () => {
    const duration = ytDuration();
    const current = ytCurrent();
    const pct = duration > 0 ? Math.max(0, Math.min(1, current / duration)) : 0;
    if (timelineProgress) timelineProgress.style.width = `${pct * 100}%`;
    if (timelineThumb) timelineThumb.style.left = `${pct * 100}%`;
    if (timelineBuffered) timelineBuffered.style.width = "0%";
    if (timeEl) timeEl.textContent = `${formatMediaTime(current)} / ${formatMediaTime(duration)}`;
    setMediaPreviewButtonIcon(playPauseBtn, ytPlaying() ? pauseIcon : playIcon);
  };
  const syncVolume = () => {
    let level = 0;
    let muted = false;
    try {
      muted = !!player.isMuted?.();
      level = muted ? 0 : Math.max(0, Math.min(1, Number(player.getVolume?.() || 0) / 100));
    } catch (_) {}
    if (volProgress) volProgress.style.width = `${level * 100}%`;
    if (volThumb) volThumb.style.left = `${level * 100}%`;
    updateMediaPreviewVolumeIcon(muteBtn, level, muted);
  };
  let pendingSeekPct = null;
  const applySeekPct = (pct) => {
    const duration = ytDuration();
    if (!duration || duration === 0 || Number.isNaN(duration)) {
      console.warn(`[seek] yt blocked | reason=duration_not_ready | duration=${duration}`);
      pendingSeekPct = pct;
      return;
    }
    pendingSeekPct = null;
    try {
      const targetTime = pct * duration;
      console.log(`[seek] yt | pct=${pct.toFixed(3)} | target=${targetTime.toFixed(2)}s`);
      player.seekTo(targetTime, true);
    } catch (_) {}
  };
  const seekFromClientX = (clientX) => {
    const seekRoot = timelineTrack || timelineWrap;
    if (!seekRoot) return;
    const rect = seekRoot.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    applySeekPct(pct);
    syncTimeline();
  };
  const volumeFromClientX = (clientX) => {
    if (!volWrap) return;
    const rect = volWrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    try {
      player.setVolume(Math.round(pct * 100));
      if (pct <= 0.0001) player.mute?.();
      else player.unMute?.();
    } catch (_) {}
    persistPlayerVolume(pct);
    syncVolume();
  };

  let isScrubbing = false;
  let scrubPointerId = null;
  let isVolumeDragging = false;
  const onTimelinePointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    isScrubbing = true;
    scrubPointerId = e.pointerId;
    timelineWrap?.setPointerCapture?.(e.pointerId);
    seekFromClientX(e.clientX);
  };
  const onTimelinePointerMove = (e) => {
    if (!isScrubbing) return;
    if (scrubPointerId != null && e.pointerId !== scrubPointerId) return;
    seekFromClientX(e.clientX);
  };
  const onTimelinePointerUpOrCancel = (e) => {
    if (scrubPointerId != null && e.pointerId !== scrubPointerId) return;
    isScrubbing = false;
    if (scrubPointerId != null) {
      timelineWrap?.releasePointerCapture?.(scrubPointerId);
    }
    scrubPointerId = null;
  };
  const onVolumeMouseDown = (e) => {
    isVolumeDragging = true;
    volumeFromClientX(e.clientX);
  };
  timelineWrap?.addEventListener("pointerdown", onTimelinePointerDown);
  timelineWrap?.addEventListener("pointermove", onTimelinePointerMove);
  timelineWrap?.addEventListener("pointerup", onTimelinePointerUpOrCancel);
  timelineWrap?.addEventListener("pointercancel", onTimelinePointerUpOrCancel);
  volWrap?.addEventListener("mousedown", onVolumeMouseDown);
  const onMouseMove = (e) => {
    if (isVolumeDragging) volumeFromClientX(e.clientX);
  };
  const onMouseUp = () => {
    isScrubbing = false;
    scrubPointerId = null;
    isVolumeDragging = false;
  };
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  const onPlayPauseClick = () => {
    try {
      if (ytPlaying()) player.pauseVideo?.();
      else player.playVideo?.();
    } catch (_) {}
    syncTimeline();
  };
  const onMuteClick = () => {
    try {
      if (player.isMuted?.()) player.unMute?.();
      else player.mute?.();
      const level = player.isMuted?.() ? 0 : Math.max(0, Math.min(1, Number(player.getVolume?.() || 0) / 100));
      persistPlayerVolume(level);
    } catch (_) {}
    syncVolume();
  };
  const onVolumeClick = (e) => volumeFromClientX(e.clientX);

  playPauseBtn?.addEventListener("click", onPlayPauseClick);
  muteBtn?.addEventListener("click", onMuteClick);
  volWrap?.addEventListener("click", onVolumeClick);

  if (mediaPreviewYoutubeTicker) clearInterval(mediaPreviewYoutubeTicker);
  setTimelineReady(false);
  mediaPreviewYoutubeTicker = setInterval(() => {
    if (ytDuration() > 0) {
      setTimelineReady(true);
      if (pendingSeekPct != null) {
        applySeekPct(pendingSeekPct);
      }
    } else {
      setTimelineReady(false);
    }
    syncTimeline();
    syncVolume();
  }, 250);
  syncTimeline();
  syncVolume();

  mediaPreviewVideoCleanup = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    timelineWrap?.removeEventListener("pointerdown", onTimelinePointerDown);
    timelineWrap?.removeEventListener("pointermove", onTimelinePointerMove);
    timelineWrap?.removeEventListener("pointerup", onTimelinePointerUpOrCancel);
    timelineWrap?.removeEventListener("pointercancel", onTimelinePointerUpOrCancel);
    volWrap?.removeEventListener("mousedown", onVolumeMouseDown);
    playPauseBtn?.removeEventListener("click", onPlayPauseClick);
    muteBtn?.removeEventListener("click", onMuteClick);
    volWrap?.removeEventListener("click", onVolumeClick);
    if (mediaPreviewYoutubeTicker) {
      clearInterval(mediaPreviewYoutubeTicker);
      mediaPreviewYoutubeTicker = null;
    }
    if (mediaPreviewYoutubePlayer?.destroy) {
      try {
        mediaPreviewYoutubePlayer.destroy();
      } catch (_) {}
    }
    mediaPreviewYoutubePlayer = null;
  };
}

async function showReelFeed(items, currentIndex) {
  reelFeedItems = items;
  mediaPreviewItem = items[currentIndex] || items[0];
  mediaPreviewCollections = [];
  const overlay = $("#mediaPreview");
  const mediaEl = $("#mediaPreviewArea");
  const reelFeedEl = $("#mediaPreviewReelFeed");
  const videoOverlayEl = $("#mediaPreviewVideoOverlay");
  if (videoOverlayEl) videoOverlayEl.classList.add("hidden");
  clearMediaPreviewExternalPlayer();
  setMediaPreviewBackgroundBlur(true);

  mediaEl.classList.add("hidden");
  reelFeedEl.classList.remove("hidden");
  overlay.querySelector(".media-preview__content")?.classList.add("media-preview__content--reel");
  reelFeedEl.innerHTML = "";
  reelFeedEl.scrollTop = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const slide = document.createElement("div");
    slide.className = "media-preview__reel-slide";
    slide.dataset.index = String(i);
    slide.dataset.id = it.id;
    slide.appendChild(buildReelSlideMedia(it));
    reelFeedEl.appendChild(slide);
  }

  updateReelHeader(mediaPreviewItem);

  overlay.classList.remove("media-preview--closing");
  overlay.classList.remove("hidden");

  requestAnimationFrame(() => {
    const slideHeightPx = reelFeedEl.clientHeight;
    reelFeedEl.scrollTop = currentIndex * slideHeightPx;

    if (reelFeedScrollHandler) {
      reelFeedEl.removeEventListener("scroll", reelFeedScrollHandler);
    }
    reelFeedScrollHandler = () => {
      const h = reelFeedEl.clientHeight;
      const n = items.length;
      let idx = Math.round(reelFeedEl.scrollTop / h);
      let top = reelFeedEl.scrollTop;
      if (n <= 0) return;
      idx = Math.max(0, Math.min(idx, n - 1));
      if (top <= 0 && idx === 0) {
        reelFeedEl.scrollTop = (n - 1) * h;
        idx = n - 1;
      } else if (top >= (n - 1) * h - 2 && idx === n - 1) {
        reelFeedEl.scrollTop = 0;
        idx = 0;
      }
      const item = items[idx];
      if (item && item.id !== mediaPreviewItem?.id) {
        mediaPreviewItem = item;
        updateReelHeader(item);
        pauseAllReelMediaExcept(reelFeedEl, idx);
        updateMediaPreviewCounter();
      }
    };
    reelFeedEl.addEventListener("scroll", reelFeedScrollHandler, { passive: true });

    pauseAllReelMediaExcept(reelFeedEl, currentIndex);
  });
}

function pauseAllReelMediaExcept(reelFeedEl, visibleIndex) {
  const slides = reelFeedEl.querySelectorAll(".media-preview__reel-slide");
  slides.forEach((slide, i) => {
    const media = slide.querySelector(".media-preview__reel-slide-media");
    if (!media) return;
    const video = media.querySelector("video");
    const iframe = media.querySelector("iframe");
    if (i === visibleIndex) {
      if (video) {
        video.play().catch(() => {});
      }
      if (iframe && iframe.dataset.embedSrc) {
        iframe.src = iframe.dataset.embedSrc;
      }
    } else {
      if (video) {
        video.pause();
      }
      if (iframe && iframe.src && !iframe.src.startsWith("about:blank")) {
        iframe.dataset.embedSrc = iframe.src;
        iframe.src = "about:blank";
      }
    }
  });
}

async function showMediaPreview(it) {
  mediaPreviewItem = it;
  mediaPreviewCollections = [];
  const overlay = $("#mediaPreview");
  const mediaEl = $("#mediaPreviewArea");
  const reelFeedEl = $("#mediaPreviewReelFeed");
  const titleEl = $("#mediaPreviewTitle");
  const badgeEl = $("#mediaPreviewBadge");
  const typeEl = $("#mediaPreviewType");
  const sizeEl = $("#mediaPreviewSize");
  const videoOverlayEl = $("#mediaPreviewVideoOverlay");
  clearMediaPreviewExternalPlayer();
  setMediaPreviewBackgroundBlur(true);

  if (reelFeedEl) reelFeedEl.classList.add("hidden");
  if (videoOverlayEl) videoOverlayEl.classList.add("hidden");
  overlay.querySelector(".media-preview__content")?.classList.remove("media-preview__content--reel");
  if (mediaEl) mediaEl.classList.remove("hidden");
  if (mediaEl) mediaEl.classList.remove("media-preview__hero--reel");

  if (titleEl) titleEl.textContent = truncateForDialog(it.title || it.original_filename || "Untitled", 55);

  if (badgeEl) {
    badgeEl.textContent = t("preview.localBadge", (state.settings?.language || "en"));
    badgeEl.className = "media-preview__badge media-preview__badge--local";
  }
  if (typeEl) typeEl.textContent = mediaPreviewTypeLabel(it);
  if (sizeEl) {
    const sizeBytes = it?.size_bytes ?? it?.file_size ?? it?.bytes ?? null;
    sizeEl.textContent = formatPreviewFileSize(sizeBytes);
  }
  if (titleEl) {
    titleEl.classList.toggle("media-preview__title--clickable", false);
    titleEl.dataset.hasCollections = "";
  }

  // Load collections in background so preview opens immediately (don't block on getCollectionsForInspiration)
  if (it?.id && window.qooti?.getCollectionsForInspiration) {
    window.qooti.getCollectionsForInspiration(it.id).then((cols) => {
      if (mediaPreviewItem?.id !== it.id) return;
      if (cols && cols.length > 0) {
        mediaPreviewCollections = cols;
        if (titleEl) {
          titleEl.classList.add("media-preview__title--clickable");
          titleEl.dataset.hasCollections = "1";
        }
      }
    }).catch((err) => {
      uilog("mediaPreview", "getCollectionsForInspiration failed", err?.message || String(err));
    });
  }

  setMediaPreviewDimensions(NaN, NaN);

  mediaEl.innerHTML = "";
  mediaEl.draggable = false;
  mediaEl.dataset.dragPath = "";

  const mountYouTubePreview = (ytId) => {
    const ytHost = document.createElement("div");
    ytHost.className = "media-preview__yt-host";
    ytHost.title = "YouTube";
    const currentId = mediaPreviewItem?.id || null;
    mediaEl.appendChild(ytHost);
    if (videoOverlayEl) videoOverlayEl.classList.remove("hidden");
    initMediaPreviewYouTubePlayer(ytHost, ytId)
      .then((player) => {
        if ((mediaPreviewItem?.id || null) !== currentId) {
          try { player.destroy?.(); } catch (_) {}
          return;
        }
        wireYouTubeInspector(player);
      })
      .catch((err) => {
        if ((mediaPreviewItem?.id || null) !== currentId) return;
        console.warn("[player] youtube init failed:", err);
        ytHost.innerHTML = "";
        const iframe = document.createElement("iframe");
        iframe.src = youtubeViewerEmbedUrl(ytId);
        iframe.title = "YouTube";
        iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture");
        ytHost.appendChild(iframe);
      });
  };

  if (it.type === "image" || it.type === "gif") {
    const img = document.createElement("img");
    wireVaultImageFallback(img, it, false);
    img.alt = it.title || "";
    img.draggable = false;
    img.addEventListener("load", () => {
      setMediaPreviewDimensions(img.naturalWidth, img.naturalHeight);
    });
    mediaEl.appendChild(img);
  } else if (it.type === "video") {
    const localSrc = loadableUrl(it.stored_path_url, it.stored_path);
    const sourceUrl = String(it.source_url || "").trim();
    const ytId = sourceUrl ? youtubeVideoId(sourceUrl) : null;
    if (localSrc) {
      const video = document.createElement("video");
      video.src = localSrc;
      video.controls = false;
      video.autoplay = true;
      video.draggable = false;
      video.playsInline = true;
      video.preload = "metadata";
      if (showsInShortFormRow(it)) {
        mediaEl.classList.add("media-preview__hero--reel");
      }
      mediaEl.appendChild(video);
      if (videoOverlayEl) videoOverlayEl.classList.remove("hidden");
    } else if (ytId) {
      mountYouTubePreview(ytId);
    } else if (sourceUrl && isHttpVideoSourceCandidate(sourceUrl)) {
      console.log("[player] source=url | url=" + sourceUrl);
      const video = document.createElement("video");
      video.src = sourceUrl;
      video.controls = false;
      video.autoplay = true;
      video.draggable = false;
      video.playsInline = true;
      video.preload = "metadata";
      video.addEventListener("error", () => {
        console.error("[player] url video failed | url=" + sourceUrl + " | code=" + (video.error?.code ?? ""));
      }, { once: true });
      mediaEl.appendChild(video);
      if (videoOverlayEl) videoOverlayEl.classList.remove("hidden");
    } else {
      const link = document.createElement("a");
      link.href = sourceUrl || "#";
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = sourceUrl || "Video source unavailable";
      link.style.color = "var(--text)";
      mediaEl.appendChild(link);
    }
  } else if (it.type === "link") {
    const ytId = it.source_url ? youtubeVideoId(it.source_url) : null;
    if (ytId) {
      mountYouTubePreview(ytId);
    } else if (isHttpVideoSourceCandidate(it.source_url)) {
      const video = document.createElement("video");
      video.src = String(it.source_url || "");
      video.controls = false;
      video.autoplay = true;
      video.draggable = false;
      video.playsInline = true;
      video.preload = "metadata";
      video.addEventListener("error", () => {
        console.error("[player] url video failed | url=" + String(it.source_url || "") + " | code=" + (video.error?.code ?? ""));
      }, { once: true });
      mediaEl.appendChild(video);
      if (videoOverlayEl) videoOverlayEl.classList.remove("hidden");
    } else {
      const thumb = it.thumbnail_path_url || "";
      if (thumb) {
        const img = document.createElement("img");
        wireVaultImageFallback(img, it, true);
        img.alt = it.title || "";
        img.draggable = false;
        img.addEventListener("load", () => {
          setMediaPreviewDimensions(img.naturalWidth, img.naturalHeight);
        });
        mediaEl.appendChild(img);
      } else {
        const link = document.createElement("a");
        link.href = it.source_url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = it.source_url;
        link.style.color = "var(--text)";
        mediaEl.appendChild(link);
      }
    }
  }

  const pathToDrag = it.stored_path || (it.type === "link" && it.thumbnail_path ? it.thumbnail_path : null);
  const pathAbs = it.stored_path_abs || it.thumbnail_path_abs || null;
  if (pathToDrag) {
    mediaEl.draggable = true;
    mediaEl.dataset.dragPath = pathToDrag;
    mediaEl.dataset.dragAbsPath = pathAbs || "";
    mediaEl.dataset.dragIcon = (it.thumbnail_path || it.stored_path) || "";
    mediaEl.classList.add("media-preview__media--draggable");
  } else {
    mediaEl.classList.remove("media-preview__media--draggable");
  }

  overlay.classList.remove("hidden");
  updateMediaPreviewCounter();
  syncMediaPreviewActionState(it);

  if (copyKeyHandler) {
    document.removeEventListener("keydown", copyKeyHandler, true);
    copyKeyHandler = null;
  }
  copyKeyHandler = async (e) => {
    const key = String(e.key || "").toLowerCase();
    const isCopy = (e.ctrlKey || e.metaKey) && key === "c";
    const isPlain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const activeEl = document.activeElement;
    const typing =
      activeEl &&
      (activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        activeEl.isContentEditable);
    if (typing) return;
    if (!isCopy && !(isPlain && (key === "arrowleft" || key === "arrowright" || key === "c"))) return;
    const selection = window.getSelection?.();
    if (selection && selection.toString().length > 0) return;
    if (!mediaPreviewItem) return;
    if (isCopy || (isPlain && key === "c")) {
      e.preventDefault();
      e.stopPropagation();
      await handleCopyMedia(mediaPreviewItem);
      return;
    }
    if (isPlain && key === "arrowleft") {
      e.preventDefault();
      await navigateMediaPreview(-1);
      return;
    }
    if (isPlain && key === "arrowright") {
      e.preventDefault();
      await navigateMediaPreview(1);
    }
  };
  document.addEventListener("keydown", copyKeyHandler, true);
  mediaPreviewKeyHandler = copyKeyHandler;

  // Video inspector: frame hold, timeline, step, copy frame (wired after DOM ready)
  const video = mediaEl.querySelector("video");
  if (video && videoOverlayEl) {
    wireVideoInspector(video, it);
  }
}

function hideMediaPreview() {
  uilog("mediaPreview", "hideMediaPreview");
  const overlayEl = $("#mediaPreview");
  if (!overlayEl || overlayEl.classList.contains("hidden")) return;
  mediaPreviewItem = null;
  overlayEl.querySelector(".media-preview__content")?.classList.remove("media-preview__content--reel");
  const reelFeedEl = $("#mediaPreviewReelFeed");
  if (reelFeedEl && reelFeedScrollHandler) {
    reelFeedEl.removeEventListener("scroll", reelFeedScrollHandler);
    reelFeedScrollHandler = null;
  }
  overlayEl.classList.add("media-preview--closing");
  if (copyKeyHandler) {
    document.removeEventListener("keydown", copyKeyHandler, true);
    copyKeyHandler = null;
  }
  mediaPreviewKeyHandler = null;
  if (typeof mediaPreviewVideoCleanup === "function") {
    mediaPreviewVideoCleanup();
    mediaPreviewVideoCleanup = null;
  }
  clearMediaPreviewExternalPlayer();
  setMediaPreviewBackgroundBlur(false);
  const mediaEl = $("#mediaPreviewArea");
  if (mediaEl) mediaEl.innerHTML = "";
  if (reelFeedEl) reelFeedEl.innerHTML = "";
  setTimeout(() => {
    overlayEl.classList.add("hidden");
    overlayEl.classList.remove("media-preview--closing");
  }, 180);
}

// Alias for backward compatibility — resolve full item from state so newly added items open correctly
function openPreview(it) {
  if (!it?.id) return;
  const full = state.inspirations.find((i) => i.id === it.id);
  const resolved = full ?? it;
  recordItemEngagement(resolved, "preview");
  showMediaPreview(resolved);
}

async function addSelectedToCollectionFlow() {
  const ids = [...state.selected];
  if (ids.length === 0) return;

  await refreshData();
  const body = document.createElement("div");
  body.innerHTML = `<div class="field"><div style="color:var(--muted)">Choose a collection</div></div>`;

  const list = document.createElement("div");
  list.className = "list";
  for (const c of state.collections) {
    const displayName = getCollectionDisplayName(c);
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `<div class="list-item__name"></div><div class="badge">Add</div>`;
    row.querySelector(".list-item__name").textContent = displayName;
    row.addEventListener("click", async () => {
      await window.qooti.addToCollection(c.id, ids);
      recordEngagementAfterCollectionAdd(ids);
      hideModal();
      await refreshData();
      await loadInspirations(false);
      toast(`Added to ${displayName} collection`, 2800);
    });
    list.appendChild(row);
  }
  body.appendChild(list);

  const btnNew = document.createElement("button");
  btnNew.className = "btn btn--primary";
  btnNew.textContent = "New collection";
  btnNew.addEventListener("click", async () => {
    const name = await showPrompt({ message: "Collection name", defaultValue: "Collection", submitLabel: "Create" });
    if (name == null) return;
    await window.qooti.createCollection(name);
    await refreshData();
    hideModal();
    addSelectedToCollectionFlow();
  });

  const btnCancel = document.createElement("button");
  btnCancel.className = "btn";
  btnCancel.textContent = "Cancel";
  btnCancel.addEventListener("click", hideModal);

  showModal(modal({ title: "Add to collection", bodyEl: body, actions: [btnCancel, btnNew] }));
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (ids.length === 0) return;
  const confirm = state.settings.confirmBeforeDelete !== "false";
  if (confirm) {
    const ok = await showConfirm({ message: `Delete ${ids.length} selected item(s)?`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
  }
  for (const id of ids) {
    await window.qooti.deleteInspiration(id);
  }
  state.selected.clear();
  updateSelectionBar();
  await refreshData();
  await loadInspirations();
}

function formatHistoryDate(ts) {
  if (ts == null || ts === undefined) return "—";
  const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function sourceLabel(it) {
  const url = it.source_url || "";
  if (!url.trim()) return "Local";
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") || url.slice(0, 40);
  } catch (_) {
    return url.length > 40 ? url.slice(0, 40) + "…" : url;
  }
}

/** Platform slug for history filter (youtube, instagram, tiktok, pinterest, notion, local, other) */
function getHistoryPlatform(it) {
  const url = (it.source_url || "").toLowerCase();
  if (!url.trim()) return "local";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("youtube") || host.includes("youtu.be")) return "youtube";
    if (host.includes("instagram")) return "instagram";
    if (host.includes("tiktok")) return "tiktok";
    if (host.includes("pinterest")) return "pinterest";
    if (host.includes("notion") || url.includes("notion-static")) return "notion";
  } catch (_) {}
  return "other";
}

/** Group items by time: today, yesterday, earlier */
function groupHistoryByTime(items) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const groups = { today: [], yesterday: [], earlier: [] };
  for (const it of items) {
    const ts = it.created_at;
    const ms = typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts;
    if (ms >= startOfToday.getTime()) groups.today.push(it);
    else if (ms >= startOfYesterday.getTime()) groups.yesterday.push(it);
    else groups.earlier.push(it);
  }
  return groups;
}

/** History row thumb markup: still images use <img>; local video files use <video> (browsers cannot decode MP4 as img). */
function historyRowThumbInnerHtml(it, isVideoLayout) {
  const thumbUrl = it.thumbnail_path_url;
  const storedUrl = it.stored_path_url;
  const phVideo = '<span class="history-row__placeholder" aria-hidden="true">▶</span>';
  const phStill = '<span class="history-row__placeholder" aria-hidden="true">◇</span>';
  const placeholder = isVideoLayout ? phVideo : phStill;

  if (thumbUrl) {
    const src = loadableUrl(thumbUrl, it.thumbnail_path);
    if (src) {
      return `<img class="history-row__img" src="${escapeHtml(src)}" alt="" loading="lazy" />`;
    }
  }
  if (it.type === "video" && storedUrl) {
    const src = loadableUrl(storedUrl, it.stored_path);
    if (src) {
      return `<video class="history-row__img" src="${escapeHtml(src)}" muted playsinline preload="metadata" aria-hidden="true"></video>`;
    }
  }
  if ((it.type === "image" || it.type === "gif") && storedUrl) {
    const src = loadableUrl(storedUrl, it.stored_path);
    if (src) {
      return `<img class="history-row__img" src="${escapeHtml(src)}" alt="" loading="lazy" />`;
    }
  }
  return placeholder;
}

function historyTypeLabel(it) {
  if (it.type === "video") return "Video";
  if (it.type === "link") return "Link";
  if (it.type === "gif") return "GIF";
  return "Image";
}

function renderHistoryContent() {
  const listEl = $("#historyList");
  const filterEl = $("#historyFilter");
  const searchEl = $("#historySearch");
  const countEl = $("#historyCount");
  if (!listEl) return;

  const filterValue = (filterEl && filterEl.value) || "all";
  const query = (searchEl && searchEl.value || "").trim().toLowerCase();

  let items = (state.inspirations || []).slice(0, 500);
  if (filterValue && filterValue !== "all") {
    const hostToPlatform = {
      "youtube.com": "youtube",
      "instagram.com": "instagram",
      "tiktok.com": "tiktok",
      "pinterest.com": "pinterest",
      "notion": "notion",
    };
    const platform = hostToPlatform[filterValue] || (filterValue === "local" ? "local" : null);
    if (platform) {
      items = items.filter((it) => getHistoryPlatform(it) === platform);
    } else {
      items = items.filter((it) => (it.source_url || "").toLowerCase().includes(filterValue));
    }
  }
  if (query) {
    items = items.filter((it) => {
      const title = (it.title || "").toLowerCase();
      const source = (it.source_url || "").toLowerCase();
      return title.includes(query) || source.includes(query);
    });
  }

  if (countEl) countEl.textContent = items.length === 0 ? "" : `${items.length} entr${items.length === 1 ? "y" : "ies"}`;

  listEl.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty-state";
    empty.textContent = filterValue !== "all" || query ? "No matching items." : "No media added yet.";
    listEl.appendChild(empty);
    return;
  }

  const groupLabels = { today: "Today", yesterday: "Yesterday", earlier: "Earlier" };
  const groups = groupHistoryByTime(items);
  for (const key of ["today", "yesterday", "earlier"]) {
    const list = groups[key];
    if (list.length === 0) continue;
    const section = document.createElement("div");
    section.className = "history-group";
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", groupLabels[key]);
    section.innerHTML = `<h2 class="history-group__title">${escapeHtml(groupLabels[key])}</h2>`;
    for (const it of list) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "history-row";
      const dateStr = formatHistoryDate(it.created_at);
      const source = sourceLabel(it);
      const typeLabel = historyTypeLabel(it);
      const title = (it.title || "").trim() || "—";
      const isVideo = it.type === "video" || it.type === "link";
      const thumbClass = "history-row__thumb history-row__thumb--" + (isVideo ? "video" : "square");
      const thumbContent = historyRowThumbInnerHtml(it, isVideo);
      row.innerHTML = `
        <span class="${escapeHtml(thumbClass)}">${thumbContent}</span>
        <div class="history-row__center">
          <p class="history-row__title" title="${escapeHtml(title)}">${escapeHtml(title)}</p>
          <p class="history-row__meta">${escapeHtml(source)} · ${escapeHtml(dateStr)} · ${escapeHtml(typeLabel)}</p>
        </div>
        <span class="history-row__menu" aria-hidden="true">${remixIcon("more-2-line.svg", "ui-icon ui-icon--sm")}</span>
      `;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".history-row__menu")) return;
        hideHistoryView();
        openPreview(it);
      });
      section.appendChild(row);
    }
    listEl.appendChild(section);
  }
}

const HISTORY_FILTER_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "local", label: "Local" },
  { value: "youtube.com", label: "YouTube" },
  { value: "instagram.com", label: "Instagram" },
  { value: "tiktok.com", label: "TikTok" },
  { value: "pinterest.com", label: "Pinterest" },
  { value: "notion", label: "Notion" },
];

function syncHistoryFilterTriggerLabel() {
  const input = $("#historyFilter");
  const trigger = $("#historyFilterTrigger");
  const dropdown = $("#historyFilterDropdown");
  const labelEl = trigger?.querySelector(".history-header__filter-label");
  if (!input || !labelEl) return;
  const opt = HISTORY_FILTER_OPTIONS.find((o) => o.value === input.value) || HISTORY_FILTER_OPTIONS[0];
  labelEl.textContent = opt.label;
  dropdown?.querySelectorAll("[role=option]").forEach((btn) => {
    const isSelected = btn.getAttribute("data-value") === input.value;
    btn.setAttribute("aria-selected", isSelected ? "true" : "false");
    btn.classList.toggle("is-selected", isSelected);
  });
}

function initHistoryFilterDropdown() {
  const wrap = document.querySelector(".history-filter-wrap");
  const trigger = $("#historyFilterTrigger");
  const dropdown = $("#historyFilterDropdown");
  const input = $("#historyFilter");
  if (!wrap || !trigger || !dropdown || !input) return;

  function closeDropdown() {
    dropdown.classList.remove("is-open");
    dropdown.setAttribute("aria-hidden", "true");
    trigger?.setAttribute("aria-expanded", "false");
  }

  function openDropdown() {
    dropdown.classList.add("is-open");
    dropdown.setAttribute("aria-hidden", "false");
    trigger?.setAttribute("aria-expanded", "true");
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdown.classList.contains("is-open")) closeDropdown();
    else openDropdown();
  });

  dropdown.querySelectorAll("[role=option]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = btn.getAttribute("data-value");
      if (value != null) {
        input.value = value;
        syncHistoryFilterTriggerLabel();
        closeDropdown();
        if (!$("#historyView").classList.contains("hidden")) renderHistoryContent();
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (dropdown.classList.contains("is-open") && !wrap.contains(e.target)) closeDropdown();
  });

  syncHistoryFilterTriggerLabel();
}

function showHistoryView() {
  document.getElementById("app")?.classList.add("app--history-open");
  $("#gridView").classList.add("hidden");
  $("#tagFilterBar")?.classList.add("hidden");
  $("#settingsView")?.classList.add("hidden");
  $("#collectionsView")?.classList.add("hidden");
  if (!hideStoreView()) return;
  const historyView = $("#historyView");
  if (historyView) {
    historyView.classList.remove("hidden");
    const searchEl = $("#historySearch");
    const filterEl = $("#historyFilter");
    if (searchEl) searchEl.value = "";
    if (filterEl) filterEl.value = "all";
    syncHistoryFilterTriggerLabel();
    renderHistoryContent();
  }
}

function hideHistoryView() {
  document.getElementById("app")?.classList.remove("app--history-open");
  const historyView = $("#historyView");
  if (historyView) historyView.classList.add("hidden");
  $("#gridView").classList.remove("hidden");
  renderGrid();
  applyTagFilterVisibility();
}

async function runExportBackupFlow() {
  const res = await window.qooti.exportBackup();
  if (res?.ok) toast("Exported backup", { variant: "success" });
  else if (res?.error) toast(res.error, { variant: "error" });
}

async function runImportBackupFlow() {
  const ok = await showConfirm({
    message: "Import will replace the current vault (your current vault will be preserved as a dated folder). Continue?",
    confirmLabel: "Import",
    danger: false
  });
  if (!ok) return;
  const res = await window.qooti.importBackup();
  if (res?.ok) notifyMediaAdd("Imported backup", { variant: "success" });
}

/** Adaptive migration UI: full-screen/maximized window → modal; smaller window → full-page (design system §5.1) */
const MIGRATION_MODAL_THRESHOLD_WIDTH = 1100;
const MIGRATION_MODAL_THRESHOLD_HEIGHT = 700;

function isMigrationModalSize() {
  return window.innerWidth >= MIGRATION_MODAL_THRESHOLD_WIDTH && window.innerHeight >= MIGRATION_MODAL_THRESHOLD_HEIGHT;
}

/** Build the shared migration body HTML (header, steps, note) for both modal and full-page. */
function buildMigrationBodyHTML() {
  const telegramIconSvg = '<svg viewBox="0 0 24 24" width="24" height="24" fill="white"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.03 13.617l-2.95-.924c-.64-.203-.654-.64.136-.954l11.57-4.461c.537-.194 1.006.131.832.943z"/></svg>';
  const noteCheckSvg = '<svg viewBox="0 0 24 24" width="12" height="12" stroke="rgba(255,255,255,0.22)" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="9,12 11,14 15,10"/></svg>';

  return `
    <div class="header-row">
      <div class="tg-icon">${telegramIconSvg}</div>
      <div>
        <div class="header-title">Import your Telegram chat history into Qooti</div>
        <div class="header-sub">Follow the three steps below to export your data from Telegram Desktop, then select the folder to begin importing your media into Qooti.</div>
      </div>
    </div>
    <div class="divider"></div>
    <div>
      <div class="section-label">How it works</div>
      <div class="steps">
        <div class="step">
          <div class="step-left">
            <div class="step-num">1</div>
            <div class="step-line"></div>
          </div>
          <div class="step-body">
            <div class="step-title">Export your chat history from Telegram Desktop</div>
            <div class="step-desc">Open Telegram Desktop, go to the chat or channel, click the <strong>⋯ menu</strong> and choose <strong>Export Chat History</strong>. Enable <strong>media files</strong> (photos, videos, GIFs) before exporting.</div>
          </div>
        </div>
        <div class="step">
          <div class="step-left">
            <div class="step-num">2</div>
            <div class="step-line"></div>
          </div>
          <div class="step-body">
            <div class="step-title">Leave the exported folder exactly as it is</div>
            <div class="step-desc">Do not rename, move, or modify any files inside the folder. Qooti requires a <code>result.json</code> file alongside your media to process the import correctly.</div>
          </div>
        </div>
        <div class="step">
          <div class="step-left">
            <div class="step-num">3</div>
            <div class="step-line"></div>
          </div>
          <div class="step-body">
            <div class="step-title">Select the folder to start importing</div>
            <div class="step-desc">Click <strong>Select folder</strong> below, choose the exported folder, and Qooti will automatically read and import your messages and media.</div>
          </div>
        </div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="note">${noteCheckSvg} Supported media: images, videos, and GIF files from Telegram exports.</div>
  `;
}

function showTelegramMigrationAsModal() {
  const bodyHtml = buildMigrationBodyHTML();
  const root = document.createElement("div");
  root.className = "modal migration-modal-ref";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Migrate from Telegram");
  root.innerHTML = `
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-footer">
      <button type="button" class="btn btn-cancel">Cancel</button>
      <button type="button" class="btn btn-primary">Select folder</button>
    </div>
  `;

  root.querySelector(".btn-cancel").addEventListener("click", hideModal);
  root.querySelector(".btn-primary").addEventListener("click", () => {
    hideModal();
    (async () => {
      try {
        await openTelegramImportFlow();
      } catch (err) {
        notifyMediaAdd(err?.message || "Could not import Telegram export", { variant: "error" });
      }
    })();
  });

  showModal(root);
}

function hideTelegramMigrationView() {
  const view = $("#telegramMigrationView");
  if (!view) return;
  view.classList.add("hidden");
  $("#gridView").classList.remove("hidden");
  document.getElementById("app")?.classList.remove("app--telegram-migration-open");
  renderGrid();
}

function showTelegramMigrationAsFullPage() {
  $("#gridView").classList.add("hidden");
  $("#settingsView")?.classList.add("hidden");
  $("#historyView")?.classList.add("hidden");
  $("#collectionsView")?.classList.add("hidden");
  if (!hideStoreView()) return;
  document.getElementById("app")?.classList.add("app--telegram-migration-open");

  const content = $("#telegramMigrationContent");
  if (!content) return;
  const bodyHtml = buildMigrationBodyHTML();
  content.innerHTML = `
    <div class="migration-ui">
      ${bodyHtml}
      <div class="migration-footer-inner">
        <button type="button" class="btn btn-cancel">Cancel</button>
        <button type="button" class="btn btn-primary">Select folder</button>
      </div>
    </div>
  `;

  content.querySelector(".btn-cancel").addEventListener("click", hideTelegramMigrationView);
  content.querySelector(".btn-primary").addEventListener("click", () => {
    (async () => {
      try {
        await openTelegramImportFlow();
      } catch (err) {
        notifyMediaAdd(err?.message || "Could not import Telegram export", { variant: "error" });
      }
    })();
  });

  wireMigrationTutorialTrigger(content, tutorialUrl);

  $("#telegramMigrationView").classList.remove("hidden");
}

async function showTelegramMigrationGuide() {
  if (isMigrationModalSize()) {
    showTelegramMigrationAsModal();
  } else {
    showTelegramMigrationAsFullPage();
  }
}

/** Notion import: URL validation (public notion.site or notion.so). */
function validateNotionUrl(url) {
  const u = String(url || "").trim();
  return (
    u.startsWith("https://") &&
    (u.includes("notion.site") || u.startsWith("https://www.notion.so/") || u.startsWith("https://notion.so/"))
  );
}

/** Build instructions body for Notion import (steps, input, checkbox). */
function buildNotionImportBodyHTML() {
  return `
    <div class="header-row">
      <div class="notion-icon migration-modal-ref__icon">
        <span class="ui-icon" style="--icon-url:url('./assets/icons/remix/notion-fill.svg')" aria-hidden="true"></span>
      </div>
      <div>
        <div class="header-title">Import from Notion Export</div>
        <div class="header-sub">Import media from a Notion export ZIP file.</div>
      </div>
    </div>
    <div class="divider"></div>
    <div>
      <div class="section-label">Steps</div>
      <div class="steps">
        <div class="step">
          <div class="step-left">
            <div class="step-num">1</div>
            <div class="step-line"></div>
          </div>
          <div class="step-body">
            <div class="step-title">Open your Notion database/page</div>
            <div class="step-desc">Open the page that contains the media you want to migrate.</div>
          </div>
        </div>
        <div class="step">
          <div class="step-left">
            <div class="step-num">2</div>
            <div class="step-line"></div>
          </div>
          <div class="step-body">
            <div class="step-title">Export with the correct settings</div>
            <div class="step-desc">Use <strong>Export</strong> and set: <strong>Export format</strong> → Markdown &amp; CSV; <strong>Include databases</strong> → Default View; <strong>Include content</strong> → Everything; <strong>Include subpages</strong> → On; <strong>Create folders for subpages</strong> → Off. Enable <strong>Include files</strong> so media is included in the ZIP.</div>
          </div>
        </div>
        <div class="step">
          <div class="step-left">
            <div class="step-num">3</div>
            <div class="step-line"></div>
          </div>
          <div class="step-body">
            <div class="step-title">Keep the export ZIP unchanged</div>
            <div class="step-desc">Do not rename or modify files inside the export ZIP.</div>
          </div>
        </div>
        <div class="step">
          <div class="step-left">
            <div class="step-num">4</div>
            <div class="step-line"></div>
          </div>
          <div class="step-body">
            <div class="step-title">Select your export ZIP</div>
            <div class="step-desc">Click Select ZIP below and start import. Keep the ZIP file unchanged.</div>
          </div>
        </div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="notion-import-form">
      <label class="notion-import-label">Notion export ZIP</label>
      <div class="notion-zip-picker">
        <button type="button" id="notionSelectZipBtn" class="btn btn--secondary notion-zip-picker__btn">Select ZIP</button>
        <div id="notionZipPathText" class="notion-zip-picker__path">No file selected</div>
      </div>
      <input type="hidden" id="notionZipPath" value="" />
      <p id="notionZipError" class="notion-import-error hidden" role="alert"></p>
      <label class="notion-import-checkbox-wrap">
        <input type="checkbox" id="notionSaveAsCollection" class="notion-import-checkbox" checked />
        <span>Save imported items as a collection</span>
      </label>
    </div>
  `;
}

/** Progress UI HTML for Notion import — indeterminate while scanning, determinate while importing. */
function buildNotionProgressHTML(statusText, current, total, percent, isModal = true) {
  const safeTotal = Math.max(0, Number(total || 0));
  const safeCurrent = Math.max(0, Math.min(safeTotal || Number(current || 0), Number(current || 0)));
  const pct = typeof percent === "number"
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : (safeTotal ? Math.round((safeCurrent / Math.max(1, safeTotal)) * 100) : 0);
  const isDeterminate = safeTotal > 0;
  const heading = isDeterminate ? `Importing ${safeTotal} files...` : "Preparing import...";
  const subtitle = "Importing the files. This may take some time depending on the size and number of media files.";
  const hint = isDeterminate
    ? (pct >= 95 ? "Finalizing..." : pct >= 75 ? "Almost done..." : pct >= 35 ? "Processing..." : "Starting...")
    : "Starting...";
  return `
    <div class="notion-progress-window">
      <div class="notion-progress-window__title">Import</div>
      <div class="notion-progress-window__hero-card">
        <div class="notion-progress-window__hero">
          <div class="notion-progress-window__icon-wrap">
            <span class="ui-icon notion-progress-window__icon" style="--icon-url:url('./assets/icons/remix/notion-fill.svg')" aria-hidden="true"></span>
          </div>
          <div>
            <div class="notion-progress-window__hero-title">${escapeHtml(heading)}</div>
            <div class="notion-progress-window__hero-sub">${escapeHtml(subtitle)}</div>
          </div>
        </div>
      </div>
      <div class="section-label">Progress</div>
      <div class="notion-progress-window__row">
        <div class="notion-progress-window__label">${escapeHtml(statusText || "Processing…")}</div>
        ${isDeterminate ? `<div class="notion-progress-window__count">${safeCurrent} of ${safeTotal} items</div>` : ""}
      </div>
      <div class="notion-progress-window__bar-wrap ${isDeterminate ? "" : "notion-progress-window__bar-wrap--indeterminate"}">
        <div class="notion-progress-window__bar ${isDeterminate ? "" : "notion-progress-window__bar--indeterminate"}" ${isDeterminate ? `style="width:${pct}%"` : ""}></div>
      </div>
      <div class="notion-progress-window__row notion-progress-window__row--muted">
        <div>${escapeHtml(hint)}</div>
        ${isDeterminate ? `<div>${pct}%</div>` : ""}
      </div>
      <div class="notion-progress-window__note">Supported media: images, videos, PDFs, and GIF files from Notion exports.</div>
      <div class="notion-progress-window__actions">
        <button type="button" class="btn btn-cancel" data-notion-progress-cancel>${isModal ? "Cancel" : "Back"}</button>
        <button type="button" class="btn btn-primary" data-notion-progress-minimize>Minimize</button>
      </div>
    </div>
  `;
}

/** Progress UI HTML for Telegram import — indeterminate while scanning, determinate while importing. */
function buildTelegramProgressHTML(statusText, current, total, percent) {
  const safeTotal = Math.max(0, Number(total || 0));
  const safeCurrent = Math.max(0, Math.min(safeTotal || Number(current || 0), Number(current || 0)));
  const pct = typeof percent === "number"
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : (safeTotal ? Math.round((safeCurrent / Math.max(1, safeTotal)) * 100) : 0);
  const isDeterminate = safeTotal > 0;
  const subtitle = "Importing the files. This may take some time depending on the size and number of the media files.";
  const hint = isDeterminate
    ? (pct >= 95 ? "Finalizing..." : pct >= 75 ? "Almost done..." : pct >= 35 ? "Processing..." : "Starting...")
    : "Starting...";
  return `
    <div class="notion-progress-window telegram-progress-window">
      <div class="notion-progress-window__title">Import</div>
      <div class="divider"></div>
      <div class="notion-progress-window__hero">
        <div class="notion-progress-window__icon-wrap">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M21.97 3.25L2.75 10.69c-1.31.53-1.29 1.27-.24 1.58l4.93 1.54 11.41-7.2c.54-.33 1.03-.15.62.21l-9.24 8.34-.34 4.95c.5 0 .72-.23 1-.5l2.4-2.33 4.98 3.68c.92.51 1.58.25 1.81-.85l3.27-15.39c.34-1.36-.52-1.97-1.38-1.58Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
          </svg>
        </div>
        <div>
          <div class="notion-progress-window__hero-title">${isDeterminate ? `Importing ${safeTotal} files...` : "Preparing import..."}</div>
          <div class="notion-progress-window__hero-sub">${escapeHtml(subtitle)}</div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="section-label">Progress</div>
      <div class="notion-progress-window__row">
        <div class="notion-progress-window__label">${escapeHtml(statusText || "Processing…")}</div>
        ${isDeterminate ? `<div class="notion-progress-window__count">${safeCurrent} of ${safeTotal} items</div>` : ""}
      </div>
      <div class="notion-progress-window__bar-wrap ${isDeterminate ? "" : "notion-progress-window__bar-wrap--indeterminate"}">
        <div class="notion-progress-window__bar ${isDeterminate ? "" : "notion-progress-window__bar--indeterminate"}" ${isDeterminate ? `style="width:${pct}%"` : ""}></div>
      </div>
      <div class="notion-progress-window__row notion-progress-window__row--muted">
        <div>${escapeHtml(hint)}</div>
        ${isDeterminate ? `<div>${pct}%</div>` : ""}
      </div>
      <div class="divider"></div>
      <div class="notion-progress-window__note">Supported media: images, videos, and GIF files from Telegram exports.</div>
      <div class="notion-progress-window__actions">
        <button type="button" class="btn btn-cancel" data-telegram-progress-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" data-telegram-progress-minimize>Minimize</button>
      </div>
    </div>
  `;
}

function buildNotionCountConfirmHTML(total, pageTitle) {
  const sourceName = escapeHtml(pageTitle || "Notion Gallery");
  const itemLabel = Number(total) === 1 ? "1 media item" : `${total} media items`;
  return `
    <div class="notion-progress-window notion-summary-view">
      <div class="notion-progress-window__title">Import</div>
      <div class="notion-progress-window__hero-card">
        <div class="notion-progress-window__hero">
          <div class="notion-progress-window__icon-wrap">
            <span class="ui-icon notion-progress-window__icon" style="--icon-url:url('./assets/icons/remix/notion-fill.svg')" aria-hidden="true"></span>
          </div>
          <div>
            <div class="notion-progress-window__hero-title">Ready to import</div>
            <div class="notion-progress-window__hero-sub">Confirm to start downloading and saving media to Qooti.</div>
          </div>
        </div>
      </div>
      <div class="section-label">Summary</div>
      <div class="notion-summary-view__card">
        <div class="notion-summary-view__row">
          <span class="notion-summary-view__label">Source</span>
          <span class="notion-summary-view__value">${sourceName}</span>
        </div>
        <div class="notion-summary-view__row">
          <span class="notion-summary-view__label">Media</span>
          <span class="notion-summary-view__value">${itemLabel}</span>
        </div>
      </div>
      <div class="notion-progress-window__actions">
        <button type="button" class="btn btn-cancel btn-notion-back">Back</button>
        <button type="button" class="btn btn-primary btn-notion-confirm">Start import</button>
      </div>
    </div>
  `;
}

function wireNotionProgressActions(container, isModal) {
  container.querySelector("[data-notion-progress-cancel]")?.addEventListener("click", () => {
    if (isModal) hideModal();
    else hideNotionImportView();
  });
  container.querySelector("[data-notion-progress-minimize]")?.addEventListener("click", () => {
    if (isModal) hideModal();
    else hideNotionImportView();
    toast("Notion import is running in the background", { variant: "info" });
  });
}

function mountNotionProgressView(bodyEl, isModal, statusText, current, total, percent) {
  const safeTotal = Math.max(0, Number(total || 0));
  const targetCurrent = Math.max(0, Math.min(safeTotal || Number(current || 0), Number(current || 0)));
  const targetPercent = typeof percent === "number"
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : (safeTotal ? Math.round((targetCurrent / Math.max(1, safeTotal)) * 100) : 0);

  const anim = bodyEl.__notionProgressAnim || {
    displayCurrent: 0,
    displayPercent: 0,
    targetCurrent: 0,
    targetPercent: 0,
    total: safeTotal,
    statusText: statusText || "Processing files",
    rafId: 0,
    wired: false,
  };
  anim.total = safeTotal;
  anim.statusText = statusText || "Processing files";
  anim.targetCurrent = targetCurrent;
  anim.targetPercent = targetPercent;
  if (!bodyEl.__notionProgressAnim) {
    anim.displayCurrent = Math.min(targetCurrent, 1);
    anim.displayPercent = Math.min(targetPercent, 1);
  }
  bodyEl.__notionProgressAnim = anim;

  const render = () => {
    bodyEl.innerHTML = buildNotionProgressHTML(
      anim.statusText,
      anim.displayCurrent,
      anim.total,
      anim.displayPercent,
      isModal
    );
    wireNotionProgressActions(bodyEl, isModal);
  };

  const tick = () => {
    const dc = anim.displayCurrent;
    const dp = anim.displayPercent;
    const tc = anim.targetCurrent;
    const tp = anim.targetPercent;

    if (dc < tc) {
      anim.displayCurrent = Math.min(tc, dc + Math.max(1, Math.ceil((tc - dc) * 0.22)));
    } else {
      anim.displayCurrent = dc;
    }
    if (dp < tp) {
      anim.displayPercent = Math.min(tp, dp + Math.max(1, Math.ceil((tp - dp) * 0.18)));
    } else {
      anim.displayPercent = dp;
    }

    render();

    if (anim.displayCurrent < anim.targetCurrent || anim.displayPercent < anim.targetPercent) {
      anim.rafId = requestAnimationFrame(tick);
    } else {
      anim.rafId = 0;
    }
  };

  if (!anim.rafId) {
    anim.rafId = requestAnimationFrame(tick);
  }
}

/** Summary UI after Notion import — hero card + summary rows, aligned with modal design system. */
function buildNotionSummaryHTML(imported, failed, skippedDuplicates, collectionName) {
  const safeName = collectionName ? escapeHtml(collectionName) : "";
  const itemLabel = Number(imported) === 1 ? "1 item" : `${imported} items`;
  const rows = [];
  rows.push(`<div class="notion-summary-view__row"><span class="notion-summary-view__label">Imported</span><span class="notion-summary-view__value">${itemLabel}</span></div>`);
  if (safeName) rows.push(`<div class="notion-summary-view__row"><span class="notion-summary-view__label">Collection</span><span class="notion-summary-view__value">${safeName}</span></div>`);
  if (failed > 0) rows.push(`<div class="notion-summary-view__row"><span class="notion-summary-view__label">Failed</span><span class="notion-summary-view__value">${failed}</span></div>`);
  if (skippedDuplicates > 0) rows.push(`<div class="notion-summary-view__row"><span class="notion-summary-view__label">Duplicates skipped</span><span class="notion-summary-view__value">${skippedDuplicates}</span></div>`);
  return `
    <div class="notion-progress-window notion-summary-view">
      <div class="notion-progress-window__hero-card">
        <div class="notion-progress-window__hero">
          <div class="notion-progress-window__icon-wrap">
            <span class="ui-icon notion-progress-window__icon" style="--icon-url:url('./assets/icons/remix/checkbox-circle-line.svg')" aria-hidden="true"></span>
          </div>
          <div>
            <div class="notion-progress-window__hero-title">Done</div>
            <div class="notion-progress-window__hero-sub">Import completed. Media has been saved to Qooti.</div>
          </div>
        </div>
      </div>
      <div class="section-label">Summary</div>
      <div class="notion-summary-view__card">
        ${rows.join("")}
      </div>
      <div class="modal-footer modal-footer--summary">
        <button type="button" class="btn btn-primary btn-notion-close">Close</button>
      </div>
    </div>
  `;
}

/** Run the actual Notion import (fetch gallery → download each → optional collection). */
async function runNotionImport(url, saveAsCollection, container, isModal, options = {}) {
  const { onProgress, prefetchedData } = options;
  const setProgress = (statusText, current, total, percent) => {
    if (onProgress) onProgress({ status: statusText, current, total, percent });
  };

  let data = prefetchedData || null;
  if (!data) {
    setProgress("Scanning gallery…", 0, 0);
    try {
      data = await window.qooti.fetchNotionGallery(url);
    } catch (e) {
      const msg = e?.message || "Could not load Notion page.";
      if (container) {
        const errEl = container.querySelector("#notionUrlError");
        if (errEl) {
          errEl.textContent = msg;
          errEl.classList.remove("hidden");
        }
      }
      throw e;
    }
  }

  const items = data?.items || [];
  const total = items.length;
  const pageTitle = data?.page_title || "Notion Gallery";

  if (total === 0) {
    if (container) {
      const errEl = container.querySelector("#notionUrlError");
      if (errEl) {
        errEl.textContent = "No gallery items found.";
        errEl.classList.remove("hidden");
      }
    }
    throw new Error("No gallery items found.");
  }

  let collectionId = null;
  let collectionName = null;
  if (saveAsCollection && window.qooti.createCollection) {
    try {
      const coll = await window.qooti.createCollection(pageTitle);
      if (coll?.id) {
        collectionId = coll.id;
        collectionName = coll.name || pageTitle;
      }
    } catch (_) {}
  }

  const addedIds = [];
  let failed = 0;
  let skippedDuplicates = 0;
  const NOTION_ITEM_TIMEOUT_MS = 15000;
  for (let i = 0; i < items.length; i++) {
    setProgress("Downloading " + (i + 1) + " / " + total + " items…", i + 1, total);
    const item = items[i];
    try {
      const res = await Promise.race([
        (window.qooti.addMediaFromUrl
          ? window.qooti.addMediaFromUrl(item.media_url, item.title || "Notion " + (i + 1))
          : window.qooti.addThumbnailFromUrl(item.media_url, item.title || "Notion " + (i + 1))),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Download timed out")), NOTION_ITEM_TIMEOUT_MS)
        ),
      ]);
      const id = res?.id;
      if (id) {
        addedIds.push(id);
        if (res.duplicate) skippedDuplicates += 1;
      }
    } catch (_) {
      failed += 1;
    }
  }

  setProgress("Saving to database…", total, total);
  if (collectionId && addedIds.length > 0 && window.qooti.addToCollection) {
    try {
      await window.qooti.addToCollection(collectionId, addedIds);
    } catch (_) {}
  }

  return {
    imported: addedIds.length - skippedDuplicates,
    failed,
    skippedDuplicates,
    total,
    collectionId,
    collectionName,
  };
}

function showNotionImportAsModal() {
  const bodyHtml = buildNotionImportBodyHTML();
  const root = document.createElement("div");
  root.className = "modal migration-modal-ref notion-import-modal";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Import from Notion");
  root.innerHTML = `
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-footer">
      <button type="button" class="btn btn-cancel">Cancel</button>
      <button type="button" class="btn btn-primary btn-notion-import">Import</button>
    </div>
  `;

  const bodyEl = root.querySelector(".modal-body");
  const footerEl = root.querySelector(".modal-footer");
  let selectedZipPath = "";

  root.querySelector(".btn-cancel").addEventListener("click", () => hideModal());
  const zipBtn = root.querySelector("#notionSelectZipBtn");
  const zipPathText = root.querySelector("#notionZipPathText");
  const zipErr = root.querySelector("#notionZipError");
  zipBtn?.addEventListener("click", async () => {
    try {
      const picked = await window.qooti.selectNotionExportZip();
      if (picked) {
        selectedZipPath = picked;
        if (zipPathText) zipPathText.textContent = picked;
      }
      zipErr?.classList.add("hidden");
    } catch (err) {
      if (zipErr) {
        zipErr.textContent = err?.message || "Could not open ZIP picker.";
        zipErr.classList.remove("hidden");
      }
    }
  });

  root.querySelector(".btn-notion-import").addEventListener("click", async () => {
    if (zipErr) {
      zipErr.textContent = "";
      zipErr.classList.add("hidden");
    }
    if (!selectedZipPath) {
      if (zipErr) {
        zipErr.textContent = "Please select a Notion export ZIP file.";
        zipErr.classList.remove("hidden");
      }
      return;
    }

    const saveAsCollection = root.querySelector("#notionSaveAsCollection")?.checked !== false;
    footerEl.classList.add("hidden");
    bodyEl.innerHTML = buildNotionProgressHTML("Scanning export ZIP…", 0, 0);
    try {
      const scan = await window.qooti.inspectNotionExportZip(selectedZipPath);
      const total = Number(scan?.total || 0);
      if (total <= 0) throw new Error("No media files found in Notion export ZIP.");

      bodyEl.innerHTML = buildNotionCountConfirmHTML(total, scan?.suggestedName || "Notion Export");
      bodyEl.querySelector(".btn-notion-back")?.addEventListener("click", () => {
        bodyEl.innerHTML = buildNotionImportBodyHTML();
        footerEl.classList.remove("hidden");
        const zipBtnBack = bodyEl.querySelector("#notionSelectZipBtn");
        const zipPathTextBack = bodyEl.querySelector("#notionZipPathText");
        const zipErrBack = bodyEl.querySelector("#notionZipError");
        if (zipPathTextBack) zipPathTextBack.textContent = selectedZipPath || "No file selected";
        zipBtnBack?.addEventListener("click", async () => {
          try {
            const picked = await window.qooti.selectNotionExportZip();
            if (picked) {
              selectedZipPath = picked;
              if (zipPathTextBack) zipPathTextBack.textContent = picked;
            }
            zipErrBack?.classList.add("hidden");
          } catch (err) {
            if (zipErrBack) {
              zipErrBack.textContent = err?.message || "Could not open ZIP picker.";
              zipErrBack.classList.remove("hidden");
            }
          }
        });
        const check = bodyEl.querySelector("#notionSaveAsCollection");
        if (check) check.checked = saveAsCollection;
      });
      bodyEl.querySelector(".btn-notion-confirm")?.addEventListener("click", async () => {
        mountNotionProgressView(bodyEl, true, "Processing files", 0, total, 0);
        let heartbeatCurrent = 0;
        const heartbeat = window.setInterval(() => {
          heartbeatCurrent = Math.min(
            Math.max(0, total - 1),
            heartbeatCurrent + Math.max(1, Math.ceil(total * 0.01))
          );
          mountNotionProgressView(bodyEl, true, "Processing files", heartbeatCurrent, total);
        }, 180);
        const onProgress = (e) => {
          const d = e?.detail || {};
          heartbeatCurrent = Math.max(heartbeatCurrent, Number(d.current || 0));
          mountNotionProgressView(
            bodyEl,
            true,
            d.status || "Processing files",
            Number(d.current || 0),
            Number(d.total || total),
            typeof d.percent === "number" ? Number(d.percent) : undefined
          );
        };
        window.addEventListener("qooti:notion-import-progress", onProgress);
        try {
          const result = await window.qooti.importNotionExportZip(selectedZipPath, {
            saveAsCollection,
            collectionName: scan?.suggestedName || null,
          });
          window.clearInterval(heartbeat);
          window.removeEventListener("qooti:notion-import-progress", onProgress);
          bodyEl.innerHTML = buildNotionSummaryHTML(
            result?.imported || 0,
            result?.failed || 0,
            result?.duplicates || 0,
            result?.collectionName || null
          );
          bodyEl.querySelector(".btn-notion-close")?.addEventListener("click", () => hideModal());
          if ((result?.imported || 0) > 0) {
            await refreshData();
            if (result?.collectionId) {
              collectionsPageRows = await loadCollectionsPageRows();
              renderCollectionsPage(collectionsPageRows);
              state.view = `collection:${result.collectionId}`;
              state.currentCollectionId = result.collectionId;
              state.currentCollectionName = result.collectionName || "";
              hideCollectionsView();
              showGrid();
              updateCollectionViewBar();
              updateSelectionBar();
              await loadInspirations(false);
            } else {
              await loadInspirations(false);
            }
            notifyMediaAdd(`Notion import: ${result.imported} items imported`, { variant: "success" });
            scheduleOcrAutoIndex();
            refreshTagFilterBar();
          }
        } catch (err) {
          window.clearInterval(heartbeat);
          window.removeEventListener("qooti:notion-import-progress", onProgress);
          bodyEl.innerHTML = `
            <div class="notion-progress-view notion-summary-view">
              <div class="notion-progress-status notion-summary-title">Import failed</div>
              <div class="notion-summary-text">${escapeHtml(err?.message || "Something went wrong.")}</div>
              <div class="modal-footer modal-footer--summary">
                <button type="button" class="btn btn-primary btn-notion-close">Close</button>
              </div>
            </div>
          `;
          bodyEl.querySelector(".btn-notion-close")?.addEventListener("click", () => hideModal());
        }
      });
    } catch (err) {
      bodyEl.innerHTML = `
        <div class="notion-progress-view notion-summary-view">
          <div class="notion-progress-status notion-summary-title">Import failed</div>
          <div class="notion-summary-text">${escapeHtml(err?.message || "Something went wrong.")}</div>
          <div class="modal-footer modal-footer--summary">
            <button type="button" class="btn btn-primary btn-notion-close">Close</button>
          </div>
        </div>
      `;
      bodyEl.querySelector(".btn-notion-close")?.addEventListener("click", () => hideModal());
    }
  });

  showModal(root);
}

function hideNotionImportView() {
  const view = $("#notionImportView");
  if (!view) return;
  view.classList.add("hidden");
  $("#gridView").classList.remove("hidden");
  document.getElementById("app")?.classList.remove("app--notion-import-open");
  renderGrid();
}

function showNotionImportAsFullPage() {
  $("#gridView").classList.add("hidden");
  $("#settingsView")?.classList.add("hidden");
  $("#historyView")?.classList.add("hidden");
  $("#collectionsView")?.classList.add("hidden");
  if (!hideStoreView()) return;
  document.getElementById("app")?.classList.add("app--notion-import-open");

  const content = $("#notionImportContent");
  if (!content) return;
  const bodyHtml = buildNotionImportBodyHTML();
  content.innerHTML = `
    <div class="migration-ui notion-import-fullpage">
      ${bodyHtml}
      <div class="migration-footer-inner">
        <button type="button" class="btn btn-cancel">Cancel</button>
        <button type="button" class="btn btn-primary btn-notion-import">Import</button>
      </div>
    </div>
  `;

  const bodyEl = content.querySelector(".migration-ui");
  content.querySelector(".btn-cancel").addEventListener("click", hideNotionImportView);
  let selectedZipPath = "";
  const zipBtn = content.querySelector("#notionSelectZipBtn");
  const zipPathText = content.querySelector("#notionZipPathText");
  const zipErr = content.querySelector("#notionZipError");
  zipBtn?.addEventListener("click", async () => {
    try {
      const picked = await window.qooti.selectNotionExportZip();
      if (picked) {
        selectedZipPath = picked;
        if (zipPathText) zipPathText.textContent = picked;
      }
      zipErr?.classList.add("hidden");
    } catch (err) {
      if (zipErr) {
        zipErr.textContent = err?.message || "Could not open ZIP picker.";
        zipErr.classList.remove("hidden");
      }
    }
  });

  content.querySelector(".btn-notion-import").addEventListener("click", async () => {
    if (zipErr) {
      zipErr.textContent = "";
      zipErr.classList.add("hidden");
    }
    if (!selectedZipPath) {
      if (zipErr) {
        zipErr.textContent = "Please select a Notion export ZIP file.";
        zipErr.classList.remove("hidden");
      }
      return;
    }

    const saveAsCollection = content.querySelector("#notionSaveAsCollection")?.checked !== false;
    const footerInner = content.querySelector(".migration-footer-inner");
    if (footerInner) footerInner.classList.add("hidden");
    bodyEl.innerHTML = buildNotionProgressHTML("Scanning export ZIP…", 0, 0);
    try {
      const scan = await window.qooti.inspectNotionExportZip(selectedZipPath);
      const total = Number(scan?.total || 0);
      if (total <= 0) throw new Error("No media files found in Notion export ZIP.");

      bodyEl.innerHTML = buildNotionCountConfirmHTML(total, scan?.suggestedName || "Notion Export");
      bodyEl.querySelector(".btn-notion-back")?.addEventListener("click", () => {
        showNotionImportAsFullPage();
      });
      bodyEl.querySelector(".btn-notion-confirm")?.addEventListener("click", async () => {
        mountNotionProgressView(bodyEl, false, "Processing files", 0, total, 0);
        let heartbeatCurrent = 0;
        const heartbeat = window.setInterval(() => {
          heartbeatCurrent = Math.min(
            Math.max(0, total - 1),
            heartbeatCurrent + Math.max(1, Math.ceil(total * 0.01))
          );
          mountNotionProgressView(bodyEl, false, "Processing files", heartbeatCurrent, total);
        }, 180);
        const onProgress = (e) => {
          const d = e?.detail || {};
          heartbeatCurrent = Math.max(heartbeatCurrent, Number(d.current || 0));
          mountNotionProgressView(
            bodyEl,
            false,
            d.status || "Processing files",
            Number(d.current || 0),
            Number(d.total || total),
            typeof d.percent === "number" ? Number(d.percent) : undefined
          );
        };
        window.addEventListener("qooti:notion-import-progress", onProgress);
        try {
          const result = await window.qooti.importNotionExportZip(selectedZipPath, {
            saveAsCollection,
            collectionName: scan?.suggestedName || null,
          });
          window.clearInterval(heartbeat);
          window.removeEventListener("qooti:notion-import-progress", onProgress);
          bodyEl.innerHTML = buildNotionSummaryHTML(
            result?.imported || 0,
            result?.failed || 0,
            result?.duplicates || 0,
            result?.collectionName || null
          );
          const closeBtn = bodyEl.querySelector(".btn-notion-close");
          if (closeBtn) {
            closeBtn.addEventListener("click", hideNotionImportView);
          }
          if ((result?.imported || 0) > 0) {
            await refreshData();
            if (result?.collectionId) {
              collectionsPageRows = await loadCollectionsPageRows();
              renderCollectionsPage(collectionsPageRows);
              state.view = `collection:${result.collectionId}`;
              state.currentCollectionId = result.collectionId;
              state.currentCollectionName = result.collectionName || "";
              hideCollectionsView();
              showGrid();
              updateCollectionViewBar();
              updateSelectionBar();
              await loadInspirations(false);
            } else {
              await loadInspirations(false);
            }
            notifyMediaAdd(`Notion import: ${result.imported} items imported`, { variant: "success" });
            scheduleOcrAutoIndex();
            refreshTagFilterBar();
            hideNotionImportView();
          }
        } catch (err) {
          window.clearInterval(heartbeat);
          window.removeEventListener("qooti:notion-import-progress", onProgress);
          bodyEl.innerHTML = `
            <div class="notion-progress-view notion-summary-view">
              <div class="notion-progress-status notion-summary-title">Import failed</div>
              <div class="notion-summary-text">${escapeHtml(err?.message || "Something went wrong.")}</div>
              <div class="migration-footer-inner">
                <button type="button" class="btn btn-primary btn-notion-close">Close</button>
              </div>
            </div>
          `;
          bodyEl.querySelector(".btn-notion-close")?.addEventListener("click", hideNotionImportView);
        }
      });
    } catch (err) {
      bodyEl.innerHTML = `
        <div class="notion-progress-view notion-summary-view">
          <div class="notion-progress-status notion-summary-title">Import failed</div>
          <div class="notion-summary-text">${escapeHtml(err?.message || "Something went wrong.")}</div>
          <div class="migration-footer-inner">
            <button type="button" class="btn btn-primary btn-notion-close">Close</button>
          </div>
        </div>
      `;
      bodyEl.querySelector(".btn-notion-close")?.addEventListener("click", hideNotionImportView);
    }
  });

  $("#notionImportView").classList.remove("hidden");
}

async function showNotionImportGuide() {
  if (isMigrationModalSize()) {
    showNotionImportAsModal();
  } else {
    showNotionImportAsFullPage();
  }
}

function showNotionMigrationComingSoon() {
  showNotionImportGuide();
}

function showProfileHelp() {
  const body = document.createElement("div");
  body.innerHTML = `
    <div class="app-modal__message">
      Qooti keeps your profile local. Use the profile menu to access Settings, Collections, History, and import/export tools.
    </div>
  `;
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn--primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", hideModal);
  showModal(modal({ title: "Help", bodyEl: body, actions: [closeBtn] }));
}

function showFeedbackModal() {
  const existing = document.querySelector(".app-modal--feedback");
  if (existing) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const lang = state.settings?.language || "en";
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--feedback";
    wrap.innerHTML = `
      <div class="app-modal__backdrop"></div>
      <div class="app-modal__dialog app-modal__dialog--wide app-modal__dialog--feedback" role="dialog" aria-modal="true" aria-labelledby="feedbackModalHeading">
        <div class="app-modal__body feedback-modal">
          <h2 class="feedback-modal__title" id="feedbackModalHeading">${escapeHtml(t("feedback.title", lang))}</h2>
          <textarea id="feedbackMessageInput" class="feedback-modal__textarea" placeholder="${escapeHtml(t("feedback.placeholder", lang))}" maxlength="3000" rows="5"></textarea>
          <div class="feedback-modal__options">
            <label class="feedback-modal__screenshot-option">
              <input type="checkbox" id="feedbackIncludeScreenshot" class="feedback-modal__screenshot-checkbox" />
              <span class="feedback-modal__option-text">${escapeHtml(t("feedback.includeScreenshot", lang))}</span>
            </label>
            <div class="feedback-modal__attach-row">
              <label for="feedbackImageInput" class="feedback-modal__attach-link">${escapeHtml(t("feedback.attachFile", lang))}</label>
              <input id="feedbackImageInput" type="file" accept="image/png,image/jpeg,image/jpg,image/webp" class="feedback-modal__file-input" />
              <span id="feedbackImageName" class="feedback-modal__file-name">${escapeHtml(t("feedback.noFileSelected", lang))}</span>
            </div>
          </div>
          <div id="feedbackModalError" class="feedback-modal__error hidden" role="alert"></div>
        </div>
        <div class="app-modal__footer">
          <button type="button" class="btn app-modal__cancel">${escapeHtml(t("feedback.cancel", lang))}</button>
          <button type="button" class="btn btn--primary app-modal__submit">${escapeHtml(t("feedback.send", lang))}</button>
        </div>
      </div>
    `;

    const inputEl = wrap.querySelector("#feedbackMessageInput");
    const includeScreenshotEl = wrap.querySelector("#feedbackIncludeScreenshot");
    const fileInputEl = wrap.querySelector("#feedbackImageInput");
    const fileNameEl = wrap.querySelector("#feedbackImageName");
    const errorEl = wrap.querySelector("#feedbackModalError");
    const submitBtn = wrap.querySelector(".app-modal__submit");
    const cancelBtn = wrap.querySelector(".app-modal__cancel");
    const backdropEl = wrap.querySelector(".app-modal__backdrop");

    const finish = (ok) => {
      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReduced) {
        wrap.remove();
        resolve(ok);
        return;
      }
      wrap.classList.add("app-modal--closing");
      const done = () => {
        wrap.remove();
        resolve(ok);
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(done, MODAL_CLOSE_MS);
        });
      });
    };

    const setError = (msg) => {
      if (!errorEl) return;
      if (!msg) {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
        return;
      }
      errorEl.textContent = String(msg);
      errorEl.classList.remove("hidden");
    };

    const readFileAsDataUrl = (file) =>
      new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => rej(new Error("Failed to read attached image"));
        reader.readAsDataURL(file);
      });

    const fbLang = () => state.settings?.language || "en";
    fileInputEl?.addEventListener("change", () => {
      const file = fileInputEl.files?.[0] || null;
      if (fileNameEl) fileNameEl.textContent = file ? file.name : t("feedback.noFileSelected", fbLang());
      setError("");
    });

    const handleEscape = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      document.removeEventListener("keydown", handleEscape);
      finish(false);
    };
    document.addEventListener("keydown", handleEscape);

    backdropEl?.addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish(false);
    });
    cancelBtn?.addEventListener("click", () => {
      document.removeEventListener("keydown", handleEscape);
      finish(false);
    });
    inputEl?.addEventListener("keydown", (e) => {
      if (!isSubmitShortcut(e)) return;
      e.preventDefault();
      submitBtn?.click();
    });

    submitBtn?.addEventListener("click", async () => {
      const message = (inputEl?.value || "").trim();
      if (message.length < 3) {
        setError(t("feedback.errorMinLength", fbLang()));
        inputEl?.focus();
        return;
      }
      let imageDataUrl = null;
      const includeScreenshot = includeScreenshotEl?.checked === true;
      if (includeScreenshot) {
        const appEl = document.getElementById("app");
        if (appEl) {
          try {
            const activeTheme = document.documentElement?.dataset?.theme || "dark";
            const rootBg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || null;
            const canvas = await html2canvas(appEl, {
              useCORS: true,
              allowTaint: true,
              logging: false,
              scale: Math.min(2, window.devicePixelRatio || 1),
              backgroundColor: rootBg,
              onclone: (clonedDoc) => {
                clonedDoc.documentElement.dataset.theme = activeTheme;
                clonedDoc.documentElement.style.colorScheme = activeTheme === "light" ? "light" : "dark";
                const srcApp = document.getElementById("app");
                const clonedApp = clonedDoc.getElementById("app");
                if (srcApp && clonedApp) {
                  clonedApp.className = srcApp.className;
                }
              },
            });
            imageDataUrl = canvas.toDataURL("image/png");
          } catch (err) {
            setError(t("feedback.errorScreenshot", fbLang()));
            return;
          }
        }
      }
      if (!imageDataUrl) {
        const file = fileInputEl?.files?.[0] || null;
        if (file) {
          if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
            setError(t("feedback.errorFileType", fbLang()));
            return;
          }
          if (file.size > 8 * 1024 * 1024) {
            setError(t("feedback.errorFileSize", fbLang()));
            return;
          }
          try {
            imageDataUrl = await readFileAsDataUrl(file);
          } catch (err) {
            setError(err?.message || t("feedback.errorRead", fbLang()));
            return;
          }
        }
      }

      setError("");
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = t("feedback.sending", fbLang());
      try {
        await window.qooti?.submitFeedback?.({
          message,
          imageDataUrl: imageDataUrl || null,
          timestampIso: new Date().toISOString(),
        });
        document.removeEventListener("keydown", handleEscape);
        toast(t("feedback.thanks", fbLang()), { variant: "success" });
        finish(true);
      } catch (err) {
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = t("feedback.send", fbLang());
        setError(err?.message || t("feedback.errorSend", fbLang()));
        toast(t("feedback.errorSend", fbLang()), { variant: "error" });
      }
    });

    document.body.appendChild(wrap);
    requestAnimationFrame(() => inputEl?.focus());
  });
}

function openSettingsTab(tab) {
  showSettings();
  const nav = document.querySelector(".settings-nav");
  const target = nav?.querySelector(`.settings-nav__item[data-tab="${tab}"]`);
  if (target) {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
}

function wireEvents() {
  const isMac = /Mac|Darwin|Macintosh/i.test(navigator.userAgent || "");
  /** Primary chord modifier: Command on macOS, Ctrl on Windows/Linux (for hidden shortcuts). */
  const chordMod = (ev) => (isMac ? ev.metaKey : ev.ctrlKey);

  // Global paste handler
  document.addEventListener("paste", handleGlobalPaste);

  // Keyboard sequence: Ctrl+B (Cmd+B on macOS), then C opens DevTools.
  let awaitingConsoleShortcut = false;
  let consoleShortcutTimer = null;
  let awaitingUpdateShortcut = false;
  let updateShortcutTimer = null;
  document.addEventListener("keydown", (e) => {
    const key = String(e.key || "").toLowerCase();
    if (key === "f12") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (chordMod(e) && !e.shiftKey && !e.altKey && key === "b") {
      awaitingConsoleShortcut = true;
      if (consoleShortcutTimer) clearTimeout(consoleShortcutTimer);
      consoleShortcutTimer = setTimeout(() => {
        awaitingConsoleShortcut = false;
        consoleShortcutTimer = null;
      }, 2500);
      return;
    }
    // Hidden updater UI simulation shortcut: Alt+B, then U.
    if (e.altKey && !chordMod(e) && !e.shiftKey && key === "b") {
      awaitingUpdateShortcut = true;
      if (updateShortcutTimer) clearTimeout(updateShortcutTimer);
      updateShortcutTimer = setTimeout(() => {
        awaitingUpdateShortcut = false;
        updateShortcutTimer = null;
      }, 2500);
      return;
    }
    if (awaitingConsoleShortcut && !chordMod(e) && !e.shiftKey && !e.altKey && key === "c") {
      awaitingConsoleShortcut = false;
      if (consoleShortcutTimer) clearTimeout(consoleShortcutTimer);
      consoleShortcutTimer = null;
      e.preventDefault();
      window.qooti?.openDevtools?.().catch?.((err) => {
        console.warn("[qooti] openDevtools failed", err?.message || err);
      });
      return;
    }
    if (awaitingUpdateShortcut && !e.shiftKey && !chordMod(e) && key === "u") {
      awaitingUpdateShortcut = false;
      if (updateShortcutTimer) clearTimeout(updateShortcutTimer);
      updateShortcutTimer = null;
      e.preventDefault();
      simulateUpdateOnNextManualCheck = true;
      toast("Update simulation armed. Click 'Check for updates'.", { durationMs: 2600, variant: "info" });
      return;
    }
    if (awaitingConsoleShortcut && key !== "control") {
      awaitingConsoleShortcut = false;
      if (consoleShortcutTimer) clearTimeout(consoleShortcutTimer);
      consoleShortcutTimer = null;
    }
    if (awaitingUpdateShortcut && key !== "alt") {
      awaitingUpdateShortcut = false;
      if (updateShortcutTimer) clearTimeout(updateShortcutTimer);
      updateShortcutTimer = null;
    }
  });

  // Menu dropdown
  $("#btnMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdown("menuDropdown", "dropdown--left");
  });

  // Profile button + dropdown
  $("#btnProfile")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const dropdown = $("#profileDropdown");
    const shouldOpen = !!dropdown?.classList.contains("hidden");
    hideAllDropdowns();
    if (shouldOpen) {
      dropdown?.classList.remove("hidden");
      $("#btnProfile")?.setAttribute("aria-expanded", "true");
    }
  });

  // Collections button + hover and click dropdown (navbar) – list style matches profile menu
  (function setupCollectionsDropdown() {
    const wrap = $("#collectionsTriggerWrap");
    const trigger = $("#btnNavCollections");
    const dropdown = $("#collectionsDropdown");
    const listEl = $("#collectionsDropdownList");
    const emptyEl = $("#collectionsDropdownEmpty");
    if (!wrap || !dropdown || !listEl || !emptyEl) return;
    let openedByClick = false;
    const folderIconUrl = "url('./assets/icons/remix/folder-line.svg')";
    function renderCollectionsList() {
      const list = (state.collections || []).filter((c) => c.visible_on_home !== false);
      listEl.innerHTML = "";
      if (list.length === 0) {
        emptyEl.classList.remove("hidden");
        return;
      }
      emptyEl.classList.add("hidden");
      for (const c of list) {
        const displayName = getCollectionDisplayName(c);
        const count = c.item_count != null ? c.item_count : (c.itemCount != null ? c.itemCount : 0);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dropdown__item";
        btn.setAttribute("role", "menuitem");
        btn.innerHTML = `<span class="ui-icon ui-icon--sm dropdown__item-icon" style="--icon-url:${folderIconUrl}" aria-hidden="true"></span><span class="collections-panel__item-name">${escapeHtml(displayName || "Unnamed")}</span><span class="collections-panel__item-count">${count}</span>`;
        btn.dataset.collectionId = c.id;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = e.currentTarget.dataset.collectionId;
          if (!id) return;
          hideAllDropdowns();
          openedByClick = false;
          state.view = "collection:" + id;
          state.currentCollectionId = id;
          state.currentCollectionName = getCollectionDisplayName((state.collections || []).find((x) => x.id === id)) || "";
          hideCollectionsView();
          showGrid();
          updateCollectionViewBar();
          updateSelectionBar();
          loadInspirations(false);
        });
        listEl.appendChild(btn);
      }
    }
    function positionCollectionsDropdown() {
      if (!trigger || !dropdown) return;
      const rect = trigger.getBoundingClientRect();
      dropdown.style.top = `${rect.bottom + 6}px`;
      dropdown.style.right = `${window.innerWidth - rect.right}px`;
      dropdown.style.left = "auto";
    }
    function openCollectionsDropdown(byClick) {
      if (byClick) openedByClick = true;
      renderCollectionsList();
      positionCollectionsDropdown();
      dropdown.classList.remove("hidden");
      if (trigger) trigger.setAttribute("aria-expanded", "true");
    }
    function closeCollectionsDropdown() {
      openedByClick = false;
      dropdown.classList.add("hidden");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    }
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = dropdown.classList.contains("hidden");
      if (isHidden) {
        hideAllDropdowns();
        openedByClick = true;
        openCollectionsDropdown(true);
      } else {
        closeCollectionsDropdown();
      }
    });
    document.addEventListener("mousedown", (e) => {
      if (dropdown.classList.contains("hidden")) return;
      if (dropdown.contains(e.target) || (trigger && trigger.contains(e.target))) return;
      closeCollectionsDropdown();
    });
  })();

  // Notifications button + dropdown
  $("#btnNotifications")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const dropdown = $("#notificationDropdown");
    const shouldOpen = !!dropdown?.classList.contains("hidden");
    hideAllDropdowns();
    if (shouldOpen) {
      dropdown?.classList.remove("hidden");
      $("#btnNotifications")?.setAttribute("aria-expanded", "true");
      if (!notificationHasBeenViewed) {
        setTimeout(() => markVisibleNotificationsRead(), 120);
      } else {
        markVisibleNotificationsRead();
      }
    }
  });

  const bindProfileSettingsTab = (id, tab) => {
    $(id)?.addEventListener("click", () => {
      hideAllDropdowns();
      openSettingsTab(tab);
    });
  };
  bindProfileSettingsTab("#profileTabAccount", "account");
  bindProfileSettingsTab("#profileTabAppearance", "appearance");
  bindProfileSettingsTab("#profileTabConnections", "connections");
  bindProfileSettingsTab("#profileTabDownloads", "downloads");
  bindProfileSettingsTab("#profileTabDiscovery", "discovery");
  bindProfileSettingsTab("#profileTabTags", "tags");
  bindProfileSettingsTab("#profileTabLanguage", "language");
  bindProfileSettingsTab("#profileTabLicense", "license");
  bindProfileSettingsTab("#profileTabHelp", "help");
  $("#profileSendFeedback")?.addEventListener("click", async () => {
    hideAllDropdowns();
    await showFeedbackModal();
  });
  $("#surveyLangToggle")?.addEventListener("click", toggleSurveyProfileLanguage);
  $("#storeOnboardingLangToggle")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleStoreOnboardingLanguageMenu();
  });
  $("#storeOnboardingLangMenu")?.addEventListener("click", handleStoreOnboardingLanguageSelection);
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("#storeOnboardingLangWrap")) return;
    closeStoreOnboardingLanguageMenu();
  });
  $("#feedbackFab")?.addEventListener("click", () => {
    const existing = document.querySelector(".app-modal--feedback");
    if (existing) {
      existing.querySelector(".app-modal__cancel")?.click();
      return;
    }
    showFeedbackModal();
  });

  // Back from Settings
  $("#btnBackFromSettings")?.addEventListener("click", () => hideSettings());
  $("#btnBackFromHistory")?.addEventListener("click", () => hideHistoryView());
  $("#btnBackFromTelegramMigration")?.addEventListener("click", () => hideTelegramMigrationView());
  $("#btnBackFromNotionImport")?.addEventListener("click", () => hideNotionImportView());
  $("#btnBackFromCollections")?.addEventListener("click", () => {
    state.view = "all";
    state.currentCollectionId = null;
    state.currentCollectionName = null;
    updateCollectionViewBar();
    hideCollectionsView();
    showGrid();
    loadInspirations();
  });
  $("#btnBackFromStore")?.addEventListener("click", () => {
    state.view = "all";
    if (!hideStoreView()) return;
    showGrid();
    renderGrid();
  });
  // Back from single-collection view (grid filtered by collection) -> return to Collections list
  const backToCollections = () => {
    state.view = "all";
    state.currentCollectionId = null;
    state.currentCollectionName = null;
    updateCollectionViewBar();
    showCollectionsView();
  };
  $("#btnBackFromCollection")?.addEventListener("click", backToCollections);
  $("#collectionViewBarCollectionsLink")?.addEventListener("click", (e) => {
    if (e.button === 0) backToCollections();
  });
  $("#collectionViewBarCollectionsLink")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      backToCollections();
    }
  });
  // Delegated right-click context menu for collection cards (reliable on all platforms)
  const collectionsGrid = $("#collectionsGrid");
  if (collectionsGrid) {
    collectionsGrid.addEventListener("contextmenu", (e) => {
      const card = e.target.closest(".collections-card");
      if (!card?._collectionRow) return;
      e.preventDefault();
      e.stopPropagation();
      showCollectionContextMenu(e, card._collectionRow);
    });
  }
  initHistoryFilterDropdown();
  $("#historySearch")?.addEventListener("input", () => { if (!$("#historyView").classList.contains("hidden")) renderHistoryContent(); });
  $("#collectionsSearch")?.addEventListener("input", async () => {
    const view = $("#collectionsView");
    if (!view || view.classList.contains("hidden")) return;
    renderCollectionsPage(collectionsPageRows);
  });
  $("#storeSearch")?.addEventListener("input", () => {
    const view = $("#storeView");
    if (!view || view.classList.contains("hidden")) return;
    renderStorePage();
  });
  $("#storeOnboardingStartBtn")?.addEventListener("click", async () => {
    if (!hasOnboardingSessionStarterPackInstalled()) {
      notifyMediaAdd(t("store.onboardingNeedPack", state.settings?.language || "en"), { variant: "warning" });
      return;
    }
    await saveSetting(ONBOARDING_COMPLETED_KEY, "true");
    if (!hideStoreView()) return;
    showGrid();
    renderGrid();
    if (!hasShownOnboardingConfetti()) {
      await saveSetting(CONFETTI_SHOWN_KEY, "true");
      fireOnboardingConfetti();
    }
  });
  $("#storeOnboardingRetryBtn")?.addEventListener("click", async () => {
    await showStoreView({ fromOnboarding: true, skipConnectivityCheck: false });
  });
  $("#collectionsCreateBtn")?.addEventListener("click", async () => {
    const name = await showPrompt({ message: "Collection name", defaultValue: "Collection", submitLabel: "Create" });
    if (name == null) return;
    await window.qooti.createCollection(name);
    collectionsPageRows = await loadCollectionsPageRows();
    renderCollectionsPage(collectionsPageRows);
  });
  $("#collectionsImportBtn")?.addEventListener("click", async () => {
    try {
      await openImportCollectionPackFlow();
    } catch (e) {
      if (e?.message !== "Import cancelled") notifyMediaAdd(e?.message || "Import failed", { variant: "error" });
    }
  });

  // Tag filter bar (All, Recent, top tags)
  $("#tagFilterAll")?.addEventListener("click", () => {
    state.selectedTagId = "";
    state.sortByRecent = false;
    updateTagFilterBarActiveState();
    loadInspirations(false);
  });
  $("#tagFilterRecent")?.addEventListener("click", () => {
    state.selectedTagId = "";
    state.sortByRecent = true;
    updateTagFilterBarActiveState();
    loadInspirations(false);
  });
  const tagFilterBar = $("#tagFilterBar");
  if (tagFilterBar) {
    setupTagFilterDragScroll();
    tagFilterBar.addEventListener("click", (e) => {
      const pill = e.target.closest(".tag-filter-pill[data-tag-id]");
      if (!pill || pill.id === "tagFilterAll" || pill.id === "tagFilterRecent") return;
      const tagId = pill.dataset.tagId ?? "";
      state.sortByRecent = false;
      state.selectedTagId = tagId;
      updateTagFilterBarActiveState();
      loadInspirations(false);
    });
    tagFilterBar.addEventListener("contextmenu", (e) => {
      const pill = e.target.closest("#tagFilterPills .tag-filter-pill[data-tag-id]");
      if (!pill) return;
      const tagId = pill.dataset.tagId?.trim();
      if (!tagId) return;
      showTagFilterPillContextMenu(e, tagId);
    });
  }

  // Color filter: helpers and UI (trigger inside search bar; results only on Search click)
  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
  }
  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((x) => ("0" + Math.max(0, Math.min(255, x)).toString(16)).slice(-2)).join("");
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (max === min) {
      h = 0;
    } else {
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        default: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), v: Math.round(v * 100) };
  }
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    v = Math.max(0, Math.min(100, v)) / 100;
    const c = v * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0, g1 = 0, b1 = 0;
    if (hp >= 0 && hp < 1) {
      r1 = c; g1 = x; b1 = 0;
    } else if (hp < 2) {
      r1 = x; g1 = c; b1 = 0;
    } else if (hp < 3) {
      r1 = 0; g1 = c; b1 = x;
    } else if (hp < 4) {
      r1 = 0; g1 = x; b1 = c;
    } else if (hp < 5) {
      r1 = x; g1 = 0; b1 = c;
    } else {
      r1 = c; g1 = 0; b1 = x;
    }
    const m = v - c;
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255),
    };
  }

  function updateColorFilterUI() {
    const trigger = $("#btnColorFilter");
    const icon = $("#colorFilterIcon");
    const swatch = $("#colorFilterSwatch");
    if (!trigger) return;
    if (state.colorFilter) {
      if (icon) icon.classList.add("hidden");
      if (swatch) {
        swatch.style.background = rgbToHex(state.colorFilter.r, state.colorFilter.g, state.colorFilter.b);
        swatch.classList.remove("hidden");
      }
      trigger.classList.add("search__color-trigger--active");
      trigger.setAttribute("aria-expanded", "false");
    } else {
      if (icon) icon.classList.remove("hidden");
      if (swatch) swatch.classList.add("hidden");
      trigger.classList.remove("search__color-trigger--active");
      trigger.setAttribute("aria-expanded", "false");
    }
  }

  (function setupColorPickerPopover() {
    const COLOR_PICKER_RECENTS_KEY = "qooti.colorPicker.recents.v1";
    const trigger = $("#btnColorFilter");
    const popover = $("#colorPickerPopover");
    const saturationEl = $("#colorPickerSaturation");
    const thumb = $("#colorPickerThumb");
    const previewEl = $("#colorPickerPreview");
    const hexInput = $("#colorPickerHex");
    const copyBtn = $("#colorPickerCopyBtn");
    const hueInput = $("#colorPickerHue");
    const recentEl = $("#colorPickerRecent");
    const searchBtn = $("#colorPickerSearchBtn");
    const clearBtn = $("#colorPickerClearBtn");
    if (!trigger || !popover || !saturationEl || !thumb || !previewEl || !hexInput || !copyBtn || !hueInput || !recentEl || !searchBtn) return;

    let pickerH = 0, pickerS = 100, pickerV = 100;
    let isDragging = false;
    let recentHexes = Array.isArray(readLocalJson(COLOR_PICKER_RECENTS_KEY, []))
      ? readLocalJson(COLOR_PICKER_RECENTS_KEY, []).map((hex) => {
          const rgb = typeof hex === "string" ? hexToRgb(hex.trim()) : null;
          return rgb ? rgbToHex(rgb.r, rgb.g, rgb.b) : null;
        }).filter(Boolean).slice(0, 6)
      : [];

    function currentRgb() {
      return hsvToRgb(pickerH, pickerS, pickerV);
    }

    function currentHex() {
      const rgb = currentRgb();
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    function persistRecentColors() {
      writeLocalJson(COLOR_PICKER_RECENTS_KEY, recentHexes.slice(0, 6));
    }

    function pushRecentColor(hex) {
      const rgb = typeof hex === "string" ? hexToRgb(hex.trim()) : null;
      if (!rgb) return;
      const normalized = rgbToHex(rgb.r, rgb.g, rgb.b);
      recentHexes = [normalized].concat(recentHexes.filter((item) => item !== normalized)).slice(0, 6);
      persistRecentColors();
      renderRecentColors();
    }

    function renderRecentColors() {
      recentEl.innerHTML = "";
      const activeHex = currentHex();
      const maxSlots = 6;
      for (let i = 0; i < maxSlots; i++) {
        const hex = recentHexes[i];
        if (hex) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "color-picker-recent__swatch";
          if (hex === activeHex) btn.classList.add("is-active");
          btn.style.setProperty("--swatch-color", hex);
          btn.setAttribute("aria-label", `Use recent color ${hex}`);
          btn.title = hex;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const rgb = hexToRgb(hex);
            if (rgb) setPickerFromRgb(rgb.r, rgb.g, rgb.b);
          });
          recentEl.appendChild(btn);
        } else {
          const placeholder = document.createElement("span");
          placeholder.className = "color-picker-recent__placeholder";
          placeholder.setAttribute("aria-hidden", "true");
          recentEl.appendChild(placeholder);
        }
      }
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "color-picker-recent__add";
      addBtn.setAttribute("aria-label", "Save current color to recent");
      addBtn.title = "Save current color";
      addBtn.innerHTML = `<span class="ui-icon ui-icon--sm" style="--icon-url:url('./assets/icons/remix/add-line.svg')" aria-hidden="true"></span>`;
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pushRecentColor(currentHex());
      });
      recentEl.appendChild(addBtn);
    }

    function setPickerFromRgb(r, g, b) {
      const hsv = rgbToHsv(r, g, b);
      pickerH = hsv.h;
      pickerS = hsv.s;
      pickerV = hsv.v;
      syncPickerUI();
    }
    function syncPickerUI() {
      saturationEl.style.setProperty("--picker-h", String(pickerH));
      thumb.style.left = `${pickerS}%`;
      thumb.style.top = `${100 - pickerV}%`;
      hueInput.value = String(pickerH);
      const rgb = currentRgb();
      previewEl.style.background = rgbToHex(rgb.r, rgb.g, rgb.b);
      hexInput.value = rgbToHex(rgb.r, rgb.g, rgb.b);
      renderRecentColors();
    }
    function positionColorPickerPopover() {
      if (!trigger || !popover) return;
      const rect = trigger.getBoundingClientRect();
      popover.style.top = `${rect.bottom + 8}px`;
      popover.style.left = `${rect.left}px`;
      popover.style.right = "auto";
    }
    function openPopover() {
      if (state.colorFilter) {
        setPickerFromRgb(state.colorFilter.r, state.colorFilter.g, state.colorFilter.b);
      } else {
        pickerH = 0; pickerS = 100; pickerV = 100;
        syncPickerUI();
      }
      positionColorPickerPopover();
      popover.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => popover.classList.add("is-visible"));
      });
    }
    function closePopover() {
      if (!popover.classList.contains("is-visible")) return;
      popover.classList.remove("is-visible");
      const onEnd = () => {
        popover.removeEventListener("transitionend", onEnd);
        popover.classList.add("hidden");
        trigger.setAttribute("aria-expanded", "false");
      };
      popover.addEventListener("transitionend", onEnd);
      setTimeout(() => {
        if (popover.classList.contains("hidden")) return;
        popover.removeEventListener("transitionend", onEnd);
        popover.classList.add("hidden");
        trigger.setAttribute("aria-expanded", "false");
      }, 250);
    }
    function applySearch() {
      const rgb = currentRgb();
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      pushRecentColor(hex);
      state.colorFilter = rgb;
      closePopover();
      updateColorFilterUI();
      loadInspirations(false);
      toast(`Color filter applied: ${hex}`, { variant: "success", durationMs: 1800 });
      console.info("[color-filter] applied", rgb);
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popover.classList.contains("hidden")) openPopover();
      else if (popover.classList.contains("is-visible")) closePopover();
    });
    searchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      applySearch();
    });
    if (clearBtn) {
      clearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.colorFilter = null;
        closePopover();
        updateColorFilterUI();
        loadInspirations(false);
        toast("Color filter cleared", { variant: "success", durationMs: 1600 });
        console.info("[color-filter] cleared");
      });
    }
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await writeTextToClipboard(hexInput.value.trim());
        toast("Copied to clipboard", { variant: "success" });
      } catch (err) {
        toast(err?.message || "Could not copy", { variant: "error" });
        console.warn("[qooti] copy color failed:", err?.message || err);
      }
    });
    document.addEventListener("mousedown", (e) => {
      if (!popover.classList.contains("hidden") && popover.classList.contains("is-visible") && !popover.contains(e.target) && !trigger.contains(e.target)) {
        closePopover();
      }
    });
    popover.addEventListener("click", (e) => e.stopPropagation());

    hueInput.addEventListener("input", () => {
      pickerH = Number(hueInput.value) || 0;
      syncPickerUI();
    });
    hexInput.addEventListener("input", () => {
      const rgb = hexToRgb(hexInput.value.trim());
      if (rgb) setPickerFromRgb(rgb.r, rgb.g, rgb.b);
    });
    hexInput.addEventListener("change", () => {
      const rgb = hexToRgb(hexInput.value.trim());
      if (rgb) setPickerFromRgb(rgb.r, rgb.g, rgb.b);
    });
    hexInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const rgb = hexToRgb(hexInput.value.trim());
        if (rgb) setPickerFromRgb(rgb.r, rgb.g, rgb.b);
        applySearch();
      }
    });

    const saturationWrap = saturationEl.closest(".color-picker-saturation-wrap") || saturationEl.parentElement;
    function onSaturationMove(clientX, clientY) {
      const rect = (saturationWrap || saturationEl).getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      pickerS = Math.round(x * 100);
      pickerV = Math.round((1 - y) * 100);
      syncPickerUI();
    }
    saturationEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      isDragging = true;
      onSaturationMove(e.clientX, e.clientY);
    });
    window.addEventListener("mousemove", (e) => {
      if (isDragging) onSaturationMove(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", () => { isDragging = false; });
  })();

  updateColorFilterUI();

  // Add button -> show add surface
  $("#btnAdd").addEventListener("click", (e) => {
    e.stopPropagation();
    showAddSurface();
  });

  // Add surface backdrop click -> close
  $(".add-surface__backdrop").addEventListener("click", hideAddSurface);

  // Add surface macOS-style close button -> close
  $("#addSurfaceClose").addEventListener("click", (e) => {
    e.stopPropagation();
    hideAddSurface();
  });

  // Media preview: backdrop and close button
  $(".media-preview__backdrop").addEventListener("click", hideMediaPreview);
  $("#mediaPreviewClose").addEventListener("click", (e) => {
    e.stopPropagation();
    hideMediaPreview();
  });
  $("#mediaPreviewPrevSide")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    await navigateMediaPreview(-1);
  });
  $("#mediaPreviewNextSide")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    await navigateMediaPreview(1);
  });
  $("#mediaPreviewCopy")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!mediaPreviewItem) return;
    await handleCopyMedia(mediaPreviewItem);
  });
  // Media preview: click title or context to open collection
  function openFirstCollectionFromPreview() {
    if (mediaPreviewCollections.length === 0) return;
    const col = mediaPreviewCollections[0];
    hideMediaPreview();
    state.view = "collection:" + col.id;
    showGrid();
    loadInspirations(false);
    updateSelectionBar();
  }
  $("#mediaPreviewTitle").addEventListener("click", (e) => {
    if (mediaPreviewCollections.length > 0) {
      e.stopPropagation();
      openFirstCollectionFromPreview();
    }
  });

  // Media preview: action buttons (delegation so clicks are reliable)
  const mediaPreviewEl = $("#mediaPreview");
  if (mediaPreviewEl) {
    mediaPreviewEl.addEventListener("click", (e) => {
      const btn = e.target.closest("#mediaPreviewEditTags");
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        uilog("editTags", "clicked");
        const item = mediaPreviewItem;
        if (item?.id) {
          hideMediaPreview();
          uilog("editTags", "opening modal");
          showEditTagsModal(item, { returnToPreview: true });
        } else {
          uilog("editTags", "skipped", "no item.id");
        }
      }
    });
  }
  $("#mediaPreviewFindRelated").addEventListener("click", (e) => {
    e.stopPropagation();
    uilog("findRelated", "clicked");
    const item = mediaPreviewItem;
    if (item?.id) {
      uilog("findRelated", "opening modal");
      showFindSimilarModal(item);
    }
  });
  $("#mediaPreviewAddToCollection").addEventListener("click", async (e) => {
    e.stopPropagation();
    uilog("addToCollection", "button clicked (opening modal)");
    const item = mediaPreviewItem;
    if (!item?.id) {
      uilog("addToCollection", "aborted", "no item.id");
      return;
    }
    if (state.view?.startsWith("collection:") && state.currentCollectionId) {
      try {
        await window.qooti.addToCollection(state.currentCollectionId, [item.id]);
        recordEngagementAfterCollectionAdd(item);
        await refreshData();
        await loadInspirations(false);
        toast(`Added to ${state.currentCollectionName || "collection"}`, { durationMs: 2800, variant: "success" });
      } catch (err) {
        toast(err?.message || "Could not add to collection", { variant: "error" });
      }
      return;
    }
    uilog("addToCollection", "refreshData start");
    await refreshData();
    uilog("addToCollection", "refreshData done, building modal");
    const body = document.createElement("div");
    body.innerHTML = `<div class="field"><div style="color:var(--muted)">Choose a collection</div></div>`;
    const list = document.createElement("div");
    list.className = "list";
    for (const c of state.collections) {
      const displayName = getCollectionDisplayName(c);
      const row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML = `<div class="list-item__name"></div><div class="badge">Add</div>`;
      row.querySelector(".list-item__name").textContent = displayName;
      row.addEventListener("click", async () => {
        uilog("addToCollection", "clicked", displayName);
        try {
          uilog("addToCollection", "invoking");
          await window.qooti.addToCollection(c.id, [item.id]);
          recordEngagementAfterCollectionAdd(item);
          uilog("addToCollection", "invoke resolved");
          hideModal();
          await refreshData();
          loadInspirations(false);
          toast(`Added to ${displayName}`, { durationMs: 2800, variant: "success" });
          uilog("addToCollection", "done");
        } catch (err) {
          uilog("addToCollection", "error", err?.message || String(err));
          hideModal();
          toast(err?.message || "Could not add to collection", { variant: "error" });
        }
      });
      list.appendChild(row);
    }
    body.appendChild(list);
    const btnNew = document.createElement("button");
    btnNew.className = "btn btn--primary";
    btnNew.textContent = "New collection";
    btnNew.addEventListener("click", async () => {
      uilog("newCollection", "clicked");
      const name = await showPrompt({ message: "Collection name", defaultValue: "Collection", submitLabel: "Create" });
      if (name == null) {
        uilog("newCollection", "cancelled");
        return;
      }
      try {
        uilog("newCollection", "invoking createCollection");
        await window.qooti.createCollection(name);
        uilog("newCollection", "invoke resolved");
        await refreshData();
        hideModal();
        $("#mediaPreviewAddToCollection")?.dispatchEvent(new Event("click"));
        uilog("newCollection", "done");
      } catch (err) {
        uilog("newCollection", "error", err?.message || String(err));
        hideModal();
        toast(err?.message || "Could not create collection", { variant: "error" });
      }
    });
    const btnCancel = document.createElement("button");
    btnCancel.className = "btn";
    btnCancel.textContent = "Cancel";
    btnCancel.addEventListener("click", hideModal);
    showModal(modal({ title: "Add to collection", bodyEl: body, actions: [btnCancel, btnNew] }));
  });

  function setFileDragData(e, absPath, relPath) {
    if (absPath) {
      const fileUri = toFileUri(absPath);
      e.dataTransfer.setData("text/plain", absPath);
      if (fileUri) e.dataTransfer.setData("text/uri-list", fileUri);
      const downloadUrl = dragDownloadUrl(absPath, relPath);
      if (downloadUrl) e.dataTransfer.setData("DownloadURL", downloadUrl);
    }
  }

  $("#mediaPreviewArea").addEventListener("dragstart", (e) => {
    const path = e.currentTarget.dataset.dragPath;
    const absPath = e.currentTarget.dataset.dragAbsPath;
    if (!path) return;
    if (absPath) setFileDragData(e, absPath, path);
  });

  // Add surface input: Enter to submit
  $("#addInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || isSubmitShortcut(e)) {
      e.preventDefault();
      handleAddInputSubmit();
    } else if (e.key === "Escape") {
      hideAddSurface();
    }
  });

  // Add surface browse button
  $("#addBrowse").addEventListener("click", async () => {
    $("#addImportMediaBtn")?.focus();
  });

  $("#addImportMediaBtn")?.addEventListener("click", async () => {
    hideAddSurface();
    try {
      const added = await window.qooti.addInspirationsFromFiles();
      const list = Array.isArray(added) ? added : [];
      if (list.length > 0) {
        const first = list[0];
        const item = first && list.length === 1 ? { id: first.id, type: first.type, title: first.title, tags: first.tags || [] } : null;
        const msg = list.length === 1 ? "Added" : `${list.length} items added`;
        toast(msg, { durationMs: 3200, item, variant: "success" });
        await refreshData();
        await loadInspirations(false);
        scheduleOcrAutoIndex();
        scheduleDelayedRefreshForNewItems();
      }
    } catch (err) {
      console.error("Browse add error:", err);
      notifyMediaAdd("Could not import media files", { variant: "error" });
    }
  });

  $("#addImportQootiBtn")?.addEventListener("click", async () => {
    try {
      await openImportCollectionPackFlow();
      hideAddSurface();
    } catch (err) {
      notifyMediaAdd(err?.message || "Could not import .qooti package", { variant: "error" });
    }
  });

  $("#addImportTelegramBtn")?.addEventListener("click", async () => {
    try {
      await openTelegramImportFlow();
      hideAddSurface();
    } catch (err) {
      notifyMediaAdd(err?.message || "Could not import Telegram export", { variant: "error" });
    }
  });

  $("#addImportNotionBtn")?.addEventListener("click", async () => {
    try {
      await showNotionImportGuide();
      hideAddSurface();
    } catch (err) {
      notifyMediaAdd(err?.message || "Could not open Notion import", { variant: "error" });
    }
  });

  // Link preview actions
  $("#previewConfirm").addEventListener("click", confirmAddLink);
  $("#previewAddAsLink")?.addEventListener("click", confirmAddLink);
  $("#previewCancel").addEventListener("click", () => {
    pendingLinkPreview = null;
    showAddZone();
    $("#addInput").focus();
  });
  $("#previewAddThumb").addEventListener("click", addThumbnailFromPreview);
  $("#previewDownloadVideo").addEventListener("click", downloadVideoFromPreview);

  $("#previewCopyLink")?.addEventListener("click", async () => {
    if (!pendingLinkPreview?.url) return;
    try {
      await writeTextToClipboard(pendingLinkPreview.url);
      toast("Link copied", { variant: "success" });
    } catch (err) {
      toast(err?.message || "Could not copy link", { variant: "error" });
    }
  });

  // Add surface drop zone
  const addZone = $("#addZone");
  addZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    addZone.classList.add("drag-over");
  });
  addZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    addZone.classList.remove("drag-over");
  });
  addZone.addEventListener("drop", handleAddSurfaceDrop);

  // Menu "Shuffle order": randomize the visible list. Does not run on add/delete/refresh.
  $("#menuNavAll").addEventListener("click", () => {
    hideAllDropdowns();
    state.selected.clear();
    updateSelectionBar();
    const onGrid = state.view === "all" || state.view.startsWith("collection:");
    if (!onGrid) {
      state.view = "all";
      loadInspirations(true);
      return;
    }
    if (state.sortByRecent) {
      state.sortByRecent = false;
      state.selectedTagId = "";
      updateTagFilterBarActiveState();
      loadInspirations(true);
    } else {
      loadInspirations(true);
    }
  });

  $("#menuCollections").addEventListener("click", () => {
    hideAllDropdowns();
    showCollectionsView();
  });

  $("#menuStore")?.addEventListener("click", () => {
    hideAllDropdowns();
    if (!hasInternetConnection()) {
      updateStoreMenuAvailability();
      notifyMediaAdd(t("store.offlineUnavailable", state.settings?.language || "en"), { variant: "warning" });
      return;
    }
    showStoreView({ fromOnboarding: false });
  });

  updateStoreMenuAvailability();
  window.addEventListener("online", handleNetworkAvailabilityChanged);
  window.addEventListener("offline", handleNetworkAvailabilityChanged);

  $("#menuHistory").addEventListener("click", () => {
    hideAllDropdowns();
    showHistoryView();
  });

  $("#menuMigrateTelegram")?.addEventListener("click", async () => {
    hideAllDropdowns();
    await showTelegramMigrationGuide();
  });

  $("#menuMigrateNotion")?.addEventListener("click", () => {
    hideAllDropdowns();
    showNotionMigrationComingSoon();
  });

  // Window controls (stop propagation so drag region doesn't capture).
  document.body.classList.toggle("platform-macos", isMac);

  const controlsEl = document.querySelector(".window-controls");
  const titleBarEl = document.querySelector(".title-bar");
  const titleBrandEl = document.querySelector(".title-bar__brand");
  const btnMin = $("#btnWindowMinimize");
  const btnMax = $("#btnWindowMaximize");
  const btnClose = $("#btnWindowClose");
  if (isMac && controlsEl && btnMin && btnMax && btnClose) {
    if (titleBarEl && titleBrandEl) {
      titleBarEl.insertBefore(controlsEl, titleBrandEl);
    }
    // macOS order: close (red), hide (yellow), minimize (green)
    controlsEl.innerHTML = "";
    controlsEl.appendChild(btnClose);
    controlsEl.appendChild(btnMax);
    controlsEl.appendChild(btnMin);
    btnClose.title = "Quit";
    btnClose.setAttribute("aria-label", "Quit");
    btnMax.title = "Hide";
    btnMax.setAttribute("aria-label", "Hide");
    btnMin.title = "Minimize";
    btnMin.setAttribute("aria-label", "Minimize");
  }

  const getWin = window.__TAURI__?.window?.getCurrentWindow?.();
  const doMinimize = () => {
    if (window.qooti?.windowMinimize) {
      window.qooti.windowMinimize();
      return;
    }
    getWin?.()?.then((w) => w.minimize()).catch(() => {});
  };
  const doHide = () => {
    if (window.qooti?.windowHide) {
      window.qooti.windowHide();
      return;
    }
    getWin?.()?.then((w) => w.hide()).catch(() => {});
  };
  const doMaximize = () => {
    if (window.qooti?.windowMaximize) {
      window.qooti.windowMaximize();
      return;
    }
    getWin?.()?.then(async (w) => {
      const m = await w.isMaximized();
      m ? w.unmaximize() : w.maximize();
    }).catch(() => {});
  };
  const doClose = () => {
    if (isMac && window.qooti?.windowQuit) {
      window.qooti.windowQuit();
      return;
    }
    if (window.qooti?.windowClose) {
      window.qooti.windowClose();
      return;
    }
    getWin?.()?.then((w) => w.close()).catch(() => {});
  };
  $("#btnWindowMinimize")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    doMinimize();
  });

  $("#btnWindowMaximize")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isMac) {
      doHide();
      return;
    }
    doMaximize();
  });

  $("#btnWindowClose")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    doClose();
  });

  // Logo click -> shuffle and reload inspirations
  const logo = document.querySelector(".title-bar__logo");
  if (logo) {
    logo.style.pointerEvents = "auto";
    logo.style.cursor = "pointer";
    logo.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.location.reload();
    });
  } else {
    console.warn("Logo element not found");
  }

  // Search — only trigger on Enter, not on every keystroke
  $("#searchInput").addEventListener("input", () => {
    updateSearchInputLinkState();
  });
  $("#searchInput").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const value = ($("#searchInput")?.value || "").trim().toLowerCase();
    if (value === "blt_delsurvey") {
      e.preventDefault();
      e.stopPropagation();
      $("#searchInput").value = "";
      hideSearchDownloadBar();
      updateSearchInputLinkState();
      await handleDeleteSurveySearchCommand();
      return;
    }
    if (value === "blt_delall") {
      e.preventDefault();
      e.stopPropagation();
      $("#searchInput").value = "";
      hideSearchDownloadBar();
      updateSearchInputLinkState();
      await handleDelAllSearchCommand();
      return;
    }
    if (value === "qtepaga" || value === "qtop") {
      e.preventDefault();
      e.stopPropagation();
      $("#searchInput").value = "";
      updateSearchInputLinkState();
      const gridView = $("#gridView");
      if (gridView) gridView.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (value === "blt_rang") {
      e.preventDefault();
      e.stopPropagation();
      $("#searchInput").value = "";
      hideSearchDownloadBar();
      updateSearchInputLinkState();
      state.query = "";
      await handleBltRangPaletteBackfillCommand();
      return;
    }
    if (value === "blt_logout") {
      e.preventDefault();
      e.stopPropagation();
      $("#searchInput").value = "";
      hideSearchDownloadBar();
      updateSearchInputLinkState();
      await handleBltLogoutSearchCommand();
      return;
    }
    if (value === "blt_ended") {
      e.preventDefault();
      e.stopPropagation();
      $("#searchInput").value = "";
      hideSearchDownloadBar();
      updateSearchInputLinkState();
      await handleBltEndedSearchCommand();
      return;
    }
    // Normal search — apply query and reload
    state.query = value;
    loadInspirations(false);
  });

  $("#searchInput").addEventListener("paste", handleSearchBarPaste);

  // Search bar download (when video link pasted)
  wireSearchDownloadBar();
  wireVideoDownloadIndicator();

  // Selection bar actions
  $("#btnAddToCollection").addEventListener("click", addSelectedToCollectionFlow);
  $("#btnDeleteSelected").addEventListener("click", deleteSelected);
  $("#btnClearSelection").addEventListener("click", () => {
    state.selected.clear();
    updateSelectionBar();
    renderGrid();
  });

  // Grid drag-and-drop (passive add zone)
  const gridView = $("#gridView");
  gridView.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer.types.includes(ROW_MOVE_TYPE)) {
      gridView.classList.add("drag-over");
    }
  });
  gridView.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.relatedTarget || !gridView.contains(e.relatedTarget)) {
      gridView.classList.remove("drag-over");
    }
  });
  gridView.addEventListener("drop", handleGridDrop);

  // Row drop zones (drag cards between short-form and main)
  setupRowDropZone($("#shortFormGrid"), "short-form");
  setupRowDropZone($("#longFormGrid1"), "main");
  setupRowDropZone($("#longFormGrid2"), "main");

  setupGridResizeObserver();

  // Block the browser's native context menu so "Inspect" is not exposed.
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (e.target.closest(".context-menu")) return;
      e.preventDefault();
    },
    true
  );

  // Click outside to close dropdowns and context menu
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dropdown") && !e.target.closest("#btnMenu") && !e.target.closest("#btnProfile") && !e.target.closest("#btnNotifications")) {
      hideAllDropdowns();
    }
    // Close context menu on left-click outside it (ignore right-click release so menu stays open)
    if (e.button === 0 && !e.target.closest(".context-menu")) {
      hideContextMenu();
    }
  });
  // Close context menu when any scrollable container scrolls.
  document.addEventListener("scroll", hideContextMenu, { passive: true, capture: true });
  window.addEventListener("wheel", hideContextMenu, { passive: true });

  // Enter key — trigger primary action when add preview is visible
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && isAddSurfaceVisible()) {
      const preview = $("#addPreview");
      if (preview && !preview.classList.contains("hidden")) {
        const downloadingEl = $("#previewDownloading");
        if (downloadingEl && !downloadingEl.classList.contains("hidden")) return;
        const downloadBtn = $("#previewDownloadVideo");
        if (downloadBtn && !downloadBtn.classList.contains("hidden")) {
          e.preventDefault();
          downloadBtn.click();
          return;
        }
        const confirmBtn = $("#previewConfirm");
        if (confirmBtn && !confirmBtn.classList.contains("hidden")) {
          e.preventDefault();
          confirmBtn.click();
        }
      }
    }
  });

  $("#ocrTaskHideBtn")?.addEventListener("click", () => {
    ocrIndicatorDismissed = true;
    updateOcrIndexIndicator();
  });
  $("#updateIndicatorHideBtn")?.addEventListener("click", () => {
    window.qooti?.dismissUpdatePrompt?.();
  });
  $("#updateIndicatorLaterBtn")?.addEventListener("click", () => {
    window.qooti?.dismissUpdatePrompt?.();
  });
  $("#updateIndicatorRestartBtn")?.addEventListener("click", async () => {
    try {
      await window.qooti?.restartToApplyUpdate?.();
    } catch (e) {
      console.warn("[qooti] restartToApplyUpdate failed", e?.message || e);
    }
  });

  // Hidden OCR debug shortcut in media preview: Ctrl+B then T on Windows; Cmd+B then T on macOS (or Ctrl/Cmd+T while armed)
  document.addEventListener("keydown", (e) => {
    const mediaPreviewOpen = !$("#mediaPreview").classList.contains("hidden");
    if (!mediaPreviewOpen) return;
    const key = (e.key || "").toLowerCase();
    if (chordMod(e) && key === "b") {
      ocrDebugChordArmedUntil = Date.now() + 1800;
      return;
    }
    if (key !== "t") return;
    const armed = Date.now() <= ocrDebugChordArmedUntil;
    const tChord = isMac ? e.metaKey : e.ctrlKey;
    if (!armed && !tChord) return;
    e.preventDefault();
    e.stopPropagation();
    ocrDebugChordArmedUntil = 0;
    if (!mediaPreviewItem?.id) return;
    showOcrDebugModal(mediaPreviewItem, false);
  });

  // Escape key — close topmost overlay first (app-modals > modalRoot > media preview > add surface)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    hideContextMenu();
    const appModal = document.querySelector(".app-modal");
    if (appModal && appModal.parentNode) {
      e.preventDefault();
      appModal.querySelector(".app-modal__backdrop")?.click();
      return;
    }
    const modalRoot = $("#modalRoot");
    if (modalRoot && !modalRoot.classList.contains("hidden")) {
      e.preventDefault();
      hideModal();
      return;
    }
    const historyView = $("#historyView");
    if (historyView && !historyView.classList.contains("hidden")) {
      e.preventDefault();
      hideHistoryView();
      return;
    }
    const collectionsView = $("#collectionsView");
    if (collectionsView && !collectionsView.classList.contains("hidden")) {
      e.preventDefault();
      hideCollectionsView();
      showGrid();
      renderGrid();
      return;
    }
    const storeView = $("#storeView");
    if (storeView && !storeView.classList.contains("hidden")) {
      e.preventDefault();
      if (!hideStoreView()) return;
      showGrid();
      renderGrid();
      return;
    }
    const telegramMigrationView = $("#telegramMigrationView");
    if (telegramMigrationView && !telegramMigrationView.classList.contains("hidden")) {
      e.preventDefault();
      hideTelegramMigrationView();
      return;
    }
    const settingsView = $("#settingsView");
    if (settingsView && !settingsView.classList.contains("hidden")) {
      hideSettings();
    } else if (!$("#mediaPreview").classList.contains("hidden")) {
      hideMediaPreview();
    } else if (isAddSurfaceVisible()) {
      hideAddSurface();
    }
  });

  // Live update when thumbnail generation finishes
  window.qooti.onThumbnailUpdated(async ({ id }) => {
    const idx = state.inspirations.findIndex((x) => x.id === id);
    if (idx === -1) return;
    await loadInspirations();
  });

  window.qooti.onVaultReplaced(async () => {
    state.selected.clear();
    await refreshData();
    state.view = "all";
    showGrid();
    await loadInspirations();
    updateSelectionBar();
    toast("Vault replaced", { variant: "success" });
  });

  // Tauri native file drag — show lighter bg when dragging files over the window (only if import enabled)
  window.addEventListener("qooti:file-drag-enter", () => {
    if (state.settings.enableDragDropImport !== "false") showDropOverlay();
  });
  window.addEventListener("qooti:file-drag-leave", hideDropOverlay);

  // Tauri native file drop (WebView2 dataTransfer is unreliable)
  window.addEventListener("qooti:file-drop", async (e) => {
    if (state.settings.enableDragDropImport === "false") return;
    const paths = e?.detail?.paths;
    if (Array.isArray(paths) && paths.length > 0) {
      hideDropOverlay();
      hideAddSurface();
      await addFromPaths(paths);
    }
  });
  window.addEventListener("qooti:update-status", (e) => {
    applyUpdaterState(e?.detail || {});
  });
}

/** Load settings, theme, data and grid. Called after license is valid. */
let _extensionPollInterval = null;
function startExtensionPoll() {
  if (_extensionPollInterval) return;
  processExtensionPending(); // run immediately so queued items from extension show right away
  _extensionPollInterval = setInterval(processExtensionPending, 2500);
}

function setupExtensionPollOnFocus() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") processExtensionPending();
  });
  window.addEventListener("focus", () => processExtensionPending());
}

let _tagCountBackfillPollInterval = null;

/** Start one-time tag count backfill if needed; show subtle indicator and refresh bar when done. */
async function ensureTagCountsAndRefreshBar() {
  try {
    const result = await window.qooti?.ensureTagCountsInitialized?.();
    const indicator = $("#tagFilterBackfillIndicator");
    if (result?.started && indicator) {
      indicator.classList.remove("hidden");
      if (_tagCountBackfillPollInterval) clearInterval(_tagCountBackfillPollInterval);
      _tagCountBackfillPollInterval = setInterval(async () => {
        try {
          const status = await window.qooti?.getTagCountStatus?.();
          if (status && !status.backfill_running) {
            if (_tagCountBackfillPollInterval) {
              clearInterval(_tagCountBackfillPollInterval);
              _tagCountBackfillPollInterval = null;
            }
            if (indicator) indicator.classList.add("hidden");
            await refreshTagFilterBar();
          }
        } catch (_) {}
      }, 1000);
    }
  } catch (_) {}
  await refreshTagFilterBar();
}

async function bootMainContent() {
  const appEl = document.getElementById("app");
  const bootStatusEl = $("#bootViewStatus");
  const startedAt = performance.now();
  await loadSettingsFromBackend();
  const lang = state.settings?.language || "en";
  startupDiag("bootMainContent.settings_loaded");
  setText(bootStatusEl, t("boot.preparingWorkspace", lang));
  updateProfileUi();
  await ensureSurveyComplete();
  startupDiag("bootMainContent.survey_checked");
  let surveyCompleted = false;
  try {
    surveyCompleted = !!(await window.qooti?.getSurveyCompleted?.());
  } catch (_) {
    surveyCompleted = false;
  }
  const shouldOpenOnboardingStore = openStoreAfterSurvey || (surveyCompleted && !isOnboardingCompleted());
  openStoreAfterSurvey = false;

  applyTheme();
  applyTranslations();
  applyUiScale();
  applyCardSizing();
  applyMediaTitleSizing();
  applyTagFilterVisibility();

  if (shouldOpenOnboardingStore) {
    setText(bootStatusEl, t("boot.preparingOnboarding", lang));
    await showStoreView({ fromOnboarding: true });
    appEl?.classList.remove("app--booting");
    startupDiag("bootMainContent.first_view_onboarding_store", {
      duration_ms: Number(performance.now() - startedAt).toFixed(1),
    });
  } else {
    setText(bootStatusEl, t("boot.loadingLibrary", lang));
    await refreshData();
    await loadInspirations();
    appEl?.classList.remove("app--booting");
    startupDiag("bootMainContent.first_view_grid", {
      duration_ms: Number(performance.now() - startedAt).toFixed(1),
    });
  }

  updateProfileUi();
  updateSelectionBar();
  updateCollectionViewBar();
  startExtensionPoll();
  setupExtensionPollOnFocus();
  if (!startupDeferredTasksScheduled) {
    startupDeferredTasksScheduled = true;
    setTimeout(() => {
      void runDeferredStartupTasks();
    }, 0);
  }
}

async function runDeferredStartupTasks() {
  const startedAt = performance.now();
  try {
    await ensureTagCountsAndRefreshBar();
    startupDiag("deferredStartup.tag_counts_ready");
  } catch (err) {
    console.warn("[qooti] deferred tag counts failed:", err?.message || err);
  }
  try {
    await refreshOcrIndexStats();
    startupDiag("deferredStartup.ocr_stats_ready");
  } catch (err) {
    console.warn("[qooti] deferred OCR stats failed:", err?.message || err);
  }
  try {
    // Resume any real OCR backlog on startup after first usable view.
    if (getOcrBacklogCount() > 0) {
      scheduleOcrAutoIndex();
      startupDiag("deferredStartup.ocr_backlog_resumed");
    }
  } catch (err) {
    console.warn("[qooti] deferred OCR resume failed:", err?.message || err);
  }
  try {
    // Load notifications after first usable view.
    initNotificationsSystem();
    startupDiag("deferredStartup.notifications_init");
  } catch (err) {
    console.warn("[qooti] deferred notifications init failed:", err?.message || err);
  }
  startupDiag("deferredStartup.complete", {
    duration_ms: Number(performance.now() - startedAt).toFixed(1),
  });
}

function setLicenseGateState({ subtitle, error, showReactivate = false, mode = "activate" } = {}) {
  const subtitleEl = $("#licenseViewSubtitle");
  const errEl = $("#licenseError");
  const reactivateBtn = $("#licenseReactivateBtn");
  const getAccessBtn = $("#licenseGetAccessBtn");
  const input = $("#licenseKeyInput");
  const activateBtn = $("#licenseActivateBtn");
  const isReactivateMode = mode === "reactivate";
  if (subtitleEl && subtitle != null) subtitleEl.textContent = subtitle;
  if (errEl) {
    errEl.textContent = error || "";
    errEl.classList.toggle("hidden", !error);
  }
  reactivateBtn?.classList.toggle("hidden", !showReactivate);
  getAccessBtn?.classList.toggle("hidden", isReactivateMode);
  input?.classList.toggle("hidden", isReactivateMode);
  activateBtn?.classList.toggle("hidden", isReactivateMode);
}

const ACTIVATION_CONNECTIVITY_URL =
  "https://raw.githubusercontent.com/blootapp/qooti-collections/main/index.json";

function getCurrentUiLang() {
  return String(state.settings?.language || "en").toLowerCase() === "uz" ? "uz" : "en";
}

function setLicenseActivationContentVisibility(visible) {
  $("#licenseForm")?.classList.toggle("hidden", !visible);
  $("#licenseView .license-view__footer")?.classList.toggle("hidden", !visible);
  $("#licenseView .license-view__brand")?.classList.toggle("hidden", !visible);
}

function setLicenseConnectivityLoadingVisible(visible) {
  $("#licenseConnectivityLoading")?.classList.toggle("hidden", !visible);
}

function setLicenseOfflineGateVisible(visible) {
  $("#licenseOfflineGate")?.classList.toggle("hidden", !visible);
}

function syncLicenseOfflineGateCopy() {
  const lang = getCurrentUiLang();
  const secondaryLang = lang === "uz" ? "en" : "uz";
  setText($("#licenseOfflineTitlePrimary"), t("offline.title", lang));
  setText($("#licenseOfflineTitleSecondary"), t("offline.title", secondaryLang));
  setText($("#licenseOfflineDescriptionPrimary"), t("offline.description", lang));
  setText($("#licenseOfflineDescriptionSecondary"), t("offline.description", secondaryLang));
  const retryBtn = $("#licenseOfflineRetryBtn");
  if (retryBtn && !retryBtn.disabled) retryBtn.textContent = t("offline.retry", lang);
}

function showLicenseActivationConnectivityLoading() {
  setLicenseActivationContentVisibility(false);
  setLicenseOfflineGateVisible(false);
  setLicenseConnectivityLoadingVisible(true);
}

function showLicenseActivationOfflineGate() {
  setLicenseConnectivityLoadingVisible(false);
  setLicenseActivationContentVisibility(false);
  setLicenseOfflineGateVisible(true);
  syncLicenseOfflineGateCopy();
}

function showLicenseActivationForm() {
  setLicenseConnectivityLoadingVisible(false);
  setLicenseOfflineGateVisible(false);
  setLicenseActivationContentVisibility(true);
  updateLicenseActivateButtonLockoutUi();
}

async function isActivationInternetConnected() {
  const supportsSignalTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
  let controller = null;
  let timeoutId = null;
  const signal = supportsSignalTimeout
    ? AbortSignal.timeout(5000)
    : (() => {
        controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 5000);
        return controller.signal;
      })();
  try {
    const response = await fetch(ACTIVATION_CONNECTIVITY_URL, {
      method: "HEAD",
      cache: "no-cache",
      signal,
    });
    return !!response?.ok;
  } catch (_) {
    return false;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

async function initActivationConnectivityGate() {
  showLicenseActivationConnectivityLoading();
  const connected = await isActivationInternetConnected();
  if (!connected) {
    showLicenseActivationOfflineGate();
    return false;
  }
  showLicenseActivationForm();
  return true;
}

async function handleActivationOfflineRetry() {
  const retryBtn = $("#licenseOfflineRetryBtn");
  const lang = getCurrentUiLang();
  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.textContent = t("offline.checking", lang);
    retryBtn.classList.remove("shake");
  }
  const connected = await isActivationInternetConnected();
  if (connected) {
    showLicenseActivationForm();
    return;
  }
  if (retryBtn) {
    retryBtn.disabled = false;
    retryBtn.textContent = t("offline.retry", lang);
    retryBtn.classList.add("shake");
    setTimeout(() => retryBtn.classList.remove("shake"), 400);
  }
}

async function ensureActivationConnectivityBeforeSubmit() {
  const btn = $("#licenseActivateBtn");
  const textEl = btn?.querySelector(".license-form__submit-text");
  const lang = getCurrentUiLang();
  licenseLog("activation: checking internet before submit", {});
  if (btn && !isLicenseLockedNow()) {
    btn.disabled = true;
    if (textEl) textEl.textContent = t("activation.connecting", lang);
  }
  const t0 = performance.now();
  const connected = await isActivationInternetConnected();
  licenseLog("activation: connectivity probe done", {
    connected,
    durationMs: Math.round(performance.now() - t0),
  });
  if (!connected) {
    showLicenseActivationOfflineGate();
  } else {
    showLicenseActivationForm();
  }
  if (!connected || isLicenseLockedNow()) {
    updateLicenseActivateButtonLockoutUi();
  }
  return connected;
}

function resetLicenseGateState() {
  const lang = getCurrentUiLang();
  setLicenseGateState({
    subtitle: t("license.enterKey", lang),
    error: "",
    showReactivate: false,
    mode: "activate",
  });
}

let licenseStartupCheckPromise = null;

/** Escalating lockout for failed activation attempts (persisted locally). */
const LICENSE_LOCKOUT_STORAGE_KEY = "qooti_license_lockout_v1";
const LICENSE_LOCKOUT_STEPS_MS = [30_000, 60_000, 5 * 60_000, 24 * 60 * 60_000];
let licenseFailedAttempts = 0;
let licenseLockedUntil = 0;
let licenseLockoutTimer = null;

function loadLicenseLockoutState() {
  try {
    const raw = localStorage.getItem(LICENSE_LOCKOUT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    licenseFailedAttempts = Math.max(0, Number(parsed?.failedAttempts) || 0);
    licenseLockedUntil = Math.max(0, Number(parsed?.lockedUntil) || 0);
  } catch (_) {
    licenseFailedAttempts = 0;
    licenseLockedUntil = 0;
  }
}

function saveLicenseLockoutState() {
  try {
    localStorage.setItem(
      LICENSE_LOCKOUT_STORAGE_KEY,
      JSON.stringify({
        failedAttempts: licenseFailedAttempts,
        lockedUntil: licenseLockedUntil,
      })
    );
  } catch (_) {}
}

function isLicenseLockedNow() {
  return Date.now() < licenseLockedUntil;
}

function getLicenseLockRemainingMs() {
  return Math.max(0, licenseLockedUntil - Date.now());
}

function formatLockoutDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function stopLicenseLockoutTicker() {
  if (licenseLockoutTimer != null) {
    clearInterval(licenseLockoutTimer);
    licenseLockoutTimer = null;
  }
}

function updateLicenseActivateButtonLockoutUi() {
  const btn = $("#licenseActivateBtn");
  const textEl = btn?.querySelector(".license-form__submit-text");
  const lang = getCurrentUiLang();
  if (!btn || !textEl) return;
  if (isLicenseLockedNow()) {
    const remaining = formatLockoutDuration(getLicenseLockRemainingMs());
    btn.disabled = true;
    textEl.textContent = `${t("license.lockedPrefix", lang)} ${remaining}`;
    return;
  }
  btn.disabled = false;
  textEl.textContent = t("activation.submit", lang);
}

function startLicenseLockoutTicker() {
  stopLicenseLockoutTicker();
  updateLicenseActivateButtonLockoutUi();
  if (!isLicenseLockedNow()) return;
  licenseLockoutTimer = setInterval(() => {
    if (!isLicenseLockedNow()) {
      stopLicenseLockoutTicker();
      licenseLockedUntil = 0;
      saveLicenseLockoutState();
      updateLicenseActivateButtonLockoutUi();
      return;
    }
    updateLicenseActivateButtonLockoutUi();
  }, 1000);
}

function registerLicenseFailedAttempt() {
  licenseFailedAttempts = Math.min(
    licenseFailedAttempts + 1,
    LICENSE_LOCKOUT_STEPS_MS.length
  );
  const idx = Math.max(0, licenseFailedAttempts - 1);
  licenseLockedUntil = Date.now() + LICENSE_LOCKOUT_STEPS_MS[idx];
  saveLicenseLockoutState();
  startLicenseLockoutTicker();
}

function clearLicenseLockoutState() {
  licenseFailedAttempts = 0;
  licenseLockedUntil = 0;
  saveLicenseLockoutState();
  stopLicenseLockoutTicker();
  updateLicenseActivateButtonLockoutUi();
}

/** Only escalate lockout for user-input mistakes — not device limit, network, or account state the user cannot fix by waiting. */
function shouldApplyLicenseActivationPenalty(result) {
  const status = String(result?.status || "").toLowerCase();
  const noPenalty = new Set([
    "device_limit",
    "device_blocked",
    "network_error",
    "activation_error",
    "offline_cache",
    "revoked",
    "expired",
    "inactive",
    "not_found",
  ]);
  if (noPenalty.has(status)) return false;
  return true;
}

async function startLicensedSession() {
  const appEl = document.getElementById("app");
  appEl?.classList.remove("app--unlicensed");
  appEl?.classList.add("app--booting");
  await bootMainContent();
  appEl?.classList.remove("app--booting");
}

/**
 * Dev/preview shortcut: same license gate as expired trial/subscription (reactivate flow).
 * Closes in-app surfaces and shows #licenseView in reactivate mode.
 */
async function handleBltEndedSearchCommand() {
  const appEl = document.getElementById("app");
  if (!appEl) return;
  appEl.classList.remove(
    "app--settings-open",
    "app--collections-open",
    "app--history-open",
    "app--telegram-migration-open",
    "app--notion-import-open"
  );
  $("#settingsView")?.classList.add("hidden");
  $("#historyView")?.classList.add("hidden");
  $("#collectionsView")?.classList.add("hidden");
  $("#storeView")?.classList.add("hidden");
  $("#gridView")?.classList.add("hidden");
  $("#tagFilterBar")?.classList.add("hidden");
  appEl.classList.remove("app--store-onboarding");
  storeHideBannersForOnboarding = false;
  if (typeof storeProgressUnsub === "function") {
    storeProgressUnsub();
    storeProgressUnsub = null;
  }
  appEl.classList.remove("app--survey");
  $("#surveyView")?.classList.add("hidden");
  appEl.classList.remove("app--booting");
  appEl.classList.add("app--unlicensed");
  const lang = state.settings?.language || "en";
  await initActivationConnectivityGate();
  setLicenseGateState({
    subtitle: t("license.reactivatePrompt", lang),
    error: "",
    showReactivate: true,
    mode: "reactivate",
  });
}

async function checkStoredLicenseAccess({ showGateError = true } = {}) {
  if (licenseStartupCheckPromise) return licenseStartupCheckPromise;
  licenseStartupCheckPromise = (async () => {
    const lang = state.settings?.language || "en";
    const appEl = document.getElementById("app");
    const bootStatusEl = $("#bootViewStatus");
    setText(bootStatusEl, t("boot.checkingLicense", lang));
    // Backend license check now returns quickly on network issues; keep a modest UI guard.
    const LICENSE_STARTUP_TIMEOUT_MS = 9000;
    licenseLog("startup: calling checkCurrentLicenseWithServer", {
      timeoutMs: LICENSE_STARTUP_TIMEOUT_MS,
    });
    const startupCheckStarted = performance.now();
    const result = await Promise.race([
      window.qooti?.checkCurrentLicenseWithServer?.() ?? Promise.resolve(null),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("License check timed out")), LICENSE_STARTUP_TIMEOUT_MS)
      ),
    ]).catch((e) => ({
      valid: false,
      has_cached_key: true,
      status: "network_error",
      error: e?.message || String(e),
      used_cached: false,
    }));
    licenseLog("startup: checkCurrentLicenseWithServer finished", {
      valid: result?.valid,
      status: result?.status,
      usedCached: result?.used_cached,
      hasCachedKey: result?.has_cached_key,
      durationMs: Math.round(performance.now() - startupCheckStarted),
      errorSnippet:
        result?.error && String(result.error).trim()
          ? String(result.error).slice(0, 120)
          : undefined,
    });
    startupDiag("licenseCheck.result", {
      valid: !!result?.valid,
      status: result?.status || "",
      used_cached: !!result?.used_cached,
      has_cached_key: !!result?.has_cached_key,
    });
    if (result?.valid) {
      resetLicenseGateState();
      await startLicensedSession();
      return true;
    }
    appEl?.classList.remove("app--booting");
    appEl?.classList.add("app--unlicensed");
    const status = String(result?.status || "").toLowerCase();
    const isExpired = status === "expired";
    if (showGateError) {
      setLicenseGateState({
        subtitle: isExpired ? t("license.reactivatePrompt", lang) : t("license.enterKey", lang),
        error: isExpired ? "" : getLicenseStatusMessage(result, lang),
        showReactivate: isExpired,
        mode: isExpired ? "reactivate" : "activate",
      });
    }
    initActivationConnectivityGate().catch(() => {});
    return false;
  })().finally(() => {
    licenseStartupCheckPromise = null;
  });
  return licenseStartupCheckPromise;
}

function wireLicenseGate() {
  const form = $("#licenseForm");
  const input = $("#licenseKeyInput");
  const errEl = $("#licenseError");
  const btn = $("#licenseActivateBtn");
  const reactivateBtn = $("#licenseReactivateBtn");
  const offlineRetryBtn = $("#licenseOfflineRetryBtn");
  if (!form || !input) return;
  const handleAzeezbekBypass = () => {
    clearLicenseLockoutState();
    if (errEl) {
      errEl.textContent = "";
      errEl.classList.add("hidden");
    }
    input.value = "";
    startLicenseLockoutTicker();
  };
  loadLicenseLockoutState();
  startLicenseLockoutTicker();
  input.addEventListener("input", () => {
    clearLicenseLockoutState();
    if (errEl) {
      errEl.textContent = "";
      errEl.classList.add("hidden");
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const key = (input.value || "").trim().toLowerCase();
    if (key !== "blt_azeezbek") return;
    e.preventDefault();
    e.stopPropagation();
    handleAzeezbekBypass();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const lang = getCurrentUiLang();
    const key = input.value.trim();
    licenseLog("activation: form submit", {
      keyHint: licenseKeyHintForLog(key),
      lockoutActive: isLicenseLockedNow(),
    });
    if (key.toLowerCase() === "blt_azeezbek") {
      licenseLog("activation: dev bypass key — skipping server", {});
      handleAzeezbekBypass();
      return;
    }
    const connected = await ensureActivationConnectivityBeforeSubmit();
    if (!connected) {
      licenseLog("activation: aborted — offline (no server call)", {});
      return;
    }
    setLicenseGateState({
      subtitle: t("license.enterKey", lang),
      error: "",
      showReactivate: false,
      mode: "activate",
    });
    if (!key) {
      licenseLog("activation: aborted — empty ID", {});
      if (errEl) {
        errEl.textContent = "Please enter a license key.";
        errEl.classList.remove("hidden");
      }
      return;
    }
    if (isLicenseLockedNow()) {
      licenseLog("activation: aborted — lockout timer active", {
        remainingMs: getLicenseLockRemainingMs(),
      });
      if (errEl) {
        errEl.textContent = `${t("license.lockedMessage", lang)} ${formatLockoutDuration(getLicenseLockRemainingMs())}`;
        errEl.classList.remove("hidden");
      }
      startLicenseLockoutTicker();
      return;
    }
    if (btn) {
      uilog("license", "btn.disabled = true");
      btn.disabled = true;
      const textEl = btn.querySelector(".license-form__submit-text");
      if (textEl) textEl.textContent = t("activation.submit", lang);
    }
    const uiPhaseStart = performance.now();
    try {
      licenseLog("activation: calling validateLicense (see [qooti][license][activation] in console)", {
        keyHint: licenseKeyHintForLog(key),
      });
      const result = await window.qooti?.validateLicense?.(key);
      licenseLog("activation: validateLicense returned to UI", {
        success: !!(result && result.success),
        status: result?.status,
        durationMs: Math.round(performance.now() - uiPhaseStart),
        penaltyWillApply: !!(result && !result.success && shouldApplyLicenseActivationPenalty(result)),
      });
      if (result && result.success) {
        clearLicenseLockoutState();
        input.value = "";
        resetLicenseGateState();
        if (btn) btn.disabled = false;
        licenseLog("activation: starting main session (licensed)", {});
        await startLicensedSession();
      } else {
        if (shouldApplyLicenseActivationPenalty(result)) {
          registerLicenseFailedAttempt();
        }
        if (errEl) {
          errEl.textContent = getLicenseStatusMessage(result, lang);
          errEl.classList.remove("hidden");
        }
      }
    } catch (err) {
      licenseLog("activation: validateLicense threw", {
        message: err?.message || String(err),
        durationMs: Math.round(performance.now() - uiPhaseStart),
      });
      if (errEl) {
        errEl.textContent = err?.message || "Activation failed.";
        errEl.classList.remove("hidden");
      }
    } finally {
      if (btn && isLicenseLockedNow()) {
        btn.disabled = true;
      } else if (btn) {
        btn.disabled = false;
      }
      startLicenseLockoutTicker();
    }
  });
  reactivateBtn?.addEventListener("click", async () => {
    await openExternalLink("https://bloot.app/", "license-reactivate");
  });
  offlineRetryBtn?.addEventListener("click", () => {
    handleActivationOfflineRetry().catch(() => {});
  });
  const getAccessBtn = $("#licenseGetAccessBtn");
  getAccessBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    await openExternalLink("https://bloot.app/register", "license-get-access");
  });
}

function licenseLog(step, detail) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[qooti][license] ${ts} ${step}`, detail !== undefined ? detail : "");
}

/** For console only — never log full Bloot ID. */
function licenseKeyHintForLog(key) {
  const s = String(key || "").trim();
  if (!s) return "(empty)";
  const head = s.slice(0, Math.min(10, s.length));
  return s.length > 10 ? `${head}… (len=${s.length})` : `${head} (len=${s.length})`;
}

async function boot() {
  const appEl = document.getElementById("app");
  const startedAt = performance.now();
  licenseLog("boot start");
  startupDiag("boot.start");
  wireEvents();
  wireSettingsControls();
  setupGlobalDropZone();
  wireLicenseGate();
  try {
    licenseLog("waiting for Qooti API...");
    await waitForQootiApi();
    startupDiag("boot.qooti_api_ready");
    await syncUpdaterStateFromBridge();
    resetLicenseGateState();
    const granted = await checkStoredLicenseAccess({ showGateError: true });
    if (!granted) {
      licenseLog("stored license check denied access");
      return;
    }
    licenseLog("startup license granted");
    startupDiag("boot.license_granted", {
      duration_ms: Number(performance.now() - startedAt).toFixed(1),
    });
  } catch (e) {
    console.error("[qooti][license] boot failed:", e?.message || e);
    licenseLog("boot failed", e?.message || e);
    appEl?.classList.remove("app--booting");
    appEl?.classList.add("app--unlicensed");
    setLicenseGateState({
      subtitle: t("license.enterKey", state.settings?.language || "en"),
      error: getLicenseStatusMessage({ status: "network_error", error: e?.message || String(e) }, state.settings?.language || "en"),
      showReactivate: false,
      mode: "activate",
    });
    initActivationConnectivityGate().catch(() => {});
  }
  licenseLog("boot complete");
  startupDiag("boot.complete", {
    duration_ms: Number(performance.now() - startedAt).toFixed(1),
  });
  if (window.qooti?.debug && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
    const mac = /Mac|Darwin|Macintosh/i.test(navigator.userAgent || "");
    console.log(
      `[qooti] Tip: Run qooti.debug() in console (${mac ? "Cmd+B, then C" : "Ctrl+B, then C"}) for diagnostics`
    );
  }
}

boot();
