import { notifyNativeWhenHidden } from "./notify.js";
import { t } from "./i18n.js";
import html2canvas from "./vendor/html2canvas.esm.js";

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

/** Log UI action lifecycle for debugging "actions stop after first use" bug.
 *  Frontend: open DevTools (Ctrl+B, then C) -> Console to see [UI] and [UI] invoke_* logs.
 *  Backend: run `cargo tauri dev` from terminal to see [CMD] and [DB] logs. */
function uilog(action, phase, detail = "") {
  if (typeof console?.log === "function") {
    console.log(`[UI] ${action} ${phase}${detail ? " " + detail : ""}`);
  }
}

function ocrLog(stage, payload = {}) {
  if (typeof console?.log !== "function") return;
  console.log("[OCR INDEX]", stage, payload);
}

function ocrWarn(stage, payload = {}) {
  if (typeof console?.warn !== "function") return;
  console.warn("[OCR INDEX]", stage, payload);
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
if (typeof console?.log === "function") {
  console.log("[UI] LIFECYCLE_LOGGING enabled — watch for [UI] and invoke_* in Console");
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
  sortByRecent: false, // when true, show newest first (no shuffle)
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
let collectionsPageRows = [];
let notificationsLoading = false;
let notificationReadIds = new Set();
let notificationLastFetchedId = "";
let notificationHasBeenViewed = false;
let notificationLastUnreadCount = 0;

const NOTIFICATION_ICON_BELL = "assets/icons/remix/bell.svg";
const NOTIFICATION_ICON_BELL_DOT = "assets/icons/remix/bell-dot.svg";
const NOTIFICATION_STATE_ICON_INFO = "assets/icons/remix/bell.svg";
const NOTIFICATION_STATE_ICON_SUCCESS = "assets/icons/remix/checkbox-circle-line.svg";
const NOTIFICATION_STATE_ICON_ERROR = "assets/icons/remix/close-line.svg";
const NOTIFICATION_CACHE_KEY = "qooti.notifications.cache.v1";
const NOTIFICATION_READ_KEY = "qooti.notifications.read.v1";
const NOTIFICATION_LAST_ID_KEY = "qooti.notifications.lastId.v1";
const TUTORIAL_VIDEOS_CONFIG_PATH = "assets/tutorial-videos.json";
let tutorialVideosConfigPromise = null;
const OCR_INDEX_CONCURRENCY = 1;
const OCR_INDEX_CLAIM_BATCH = 2;
const OCR_INDEX_YIELD_MS = 20;
const OCR_DETECT_TIMEOUT_MS = 45000;
let ocrWorkerPromise = null;
let ocrUseBackendOnly = false;
let ocrIndexRunning = false;
let ocrIndexRerunRequested = false;
let ocrIndexSessionPaused = false;
let ocrIndicatorDismissed = false;
let vaultImageDiagLogged = false;
let ocrIndexStats = { total: 0, done: 0, no_text: 0, processing: 0, pending: 0 };
let ocrRunInitialTotal = 0;
let _ocrAutoIndexTimer = null;
const OCR_AUTO_INDEX_DELAY_MS = 2500;
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
const downloadIndicatorState = {
  active: false,
  label: "Downloading video…",
  percent: 0,
};
let bottomCenterToastVisible = false;

function isUpdateIndicatorActive(detail = updaterUiState) {
  const phase = detail?.phase || "idle";
  return !detail?.hidden && !["idle", "up_to_date"].includes(phase);
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
    ? new URL("assets/ocr/", window.location.href).toString()
    : "assets/ocr/";
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

  // If worker already proved broken this session, go straight to backend OCR.
  if (ocrUseBackendOnly) {
    ocrLog("candidate_backend_only", { id: candidate.id });
    await runBackendOcrForCandidate(candidate);
    return;
  }

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
    ocrUseBackendOnly = true;
    ocrLog("worker_skipped_prefer_main_thread", {
      id: candidate.id,
      source: config.source || "unknown",
      workerUrl: config.workerUrl || "",
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
      ocrUseBackendOnly = true;
      ocrWarn("worker_unavailable_switching_backend_only", {
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
    toast(`OCR failed for one image, continuing queue: ${errMsg || "recognizer unavailable"}`, { variant: "warning" });
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

function syncSizeControlModeUi() {
  const useSimple = state.settings?.useSimpleSizeControl !== "false";
  $("#settingsSimpleSizeControls")?.classList.toggle("hidden", !useSimple);
  $("#settingsAdvancedSizeControls")?.classList.toggle("hidden", useSimple);
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
  const lang = state.settings?.language || "en";
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
}

function toggleSurveyProfileLanguage() {
  const next = state.settings?.language === "uz" ? "en" : "uz";
  state.settings.language = next;
  saveSetting("language", next).catch(() => {});
  applyTranslations();
  document.dispatchEvent(new CustomEvent("app:languageChanged"));
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
  set("settingShowCollectionIndicator", s.showCollectionIndicator);
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
  const settingsAccountUsernameInput = $("#settingsAccountUsernameInput");
  if (settingsAccountUsernameInput && document.activeElement !== settingsAccountUsernameInput) {
    settingsAccountUsernameInput.value = getProfileName();
  }
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
  if (result?.used_cached) return t("license.cachedOffline", lang);
  if (status === "missing") return "";
  if (status === "revoked") return t("license.revoked", lang);
  if (status === "expired") return t("license.expired", lang);
  if (status === "device_limit") return t("license.deviceLimit", lang);
  if (status === "network_error") return t("license.networkUnavailable", lang);
  return result?.error || t("license.invalid", lang);
}

function getLicenseSettingsStatusLabel(cache, lang = state.settings?.language || "en") {
  const status = String(cache?.status || "").toLowerCase();
  if (cache?.valid) {
    if (cache?.used_cached || status === "network_error" || status === "offline_cache") {
      return t("license.activeCached", lang);
    }
    return t("settings.active", lang);
  }
  if (status === "revoked") return t("license.revoked", lang);
  if (status === "expired") return t("license.expired", lang);
  if (status === "device_limit") return t("license.deviceLimit", lang);
  return t("settings.noLicense", lang);
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
const PROFILE_NAME_MAX_LEN = 30;

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

function validateProfileName(name) {
  const n = normalizeProfileName(name);
  if (!n) return "Username is required.";
  if (n.length > PROFILE_NAME_MAX_LEN) return `Username must be ${PROFILE_NAME_MAX_LEN} characters or less.`;
  return "";
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
  const settingsNameInput = $("#settingsAccountUsernameInput");
  if (settingsNameInput && document.activeElement !== settingsNameInput) {
    settingsNameInput.value = name === "User" && !getProfileName() ? "" : getProfileName();
  }
  syncSettingsAccountUsernameEditor();
}

function syncSettingsAccountUsernameEditor() {
  const input = $("#settingsAccountUsernameInput");
  const saveBtn = $("#settingsAccountUsernameSave");
  if (!input || !saveBtn) return;
  const normalized = normalizeProfileName(input.value);
  const validation = validateProfileName(normalized);
  const unchanged = normalized === getProfileName();
  input.classList.toggle("is-invalid", Boolean(input.value) && Boolean(validation));
  saveBtn.disabled = Boolean(validation) || unchanged;
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

function showProfileSetupView() {
  return new Promise((resolve) => {
    const appEl = document.getElementById("app");
    const view = $("#profileSetupView");
    const avatarBtn = $("#profileSetupAvatarBtn");
    const previewEl = $("#profileSetupAvatarPreview");
    const imageInput = $("#profileSetupImageInput");
    const nameInput = $("#profileSetupName");
    const saveBtn = $("#profileSetupSaveBtn");
    const errorEl = $("#profileSetupError");
    if (!appEl || !view || !avatarBtn || !previewEl || !imageInput || !nameInput || !saveBtn || !errorEl) {
      resolve();
      return;
    }

    let imageDataUrl = getProfileImageDataUrl();
    let touched = false;

    appEl.classList.add("app--profile-setup");
    view.classList.remove("hidden", "profile-setup-view--closing");
    nameInput.value = getProfileName();

    const sync = () => {
      const normalized = normalizeProfileName(nameInput.value);
      const validation = validateProfileName(normalized);
      saveBtn.disabled = Boolean(validation);
      nameInput.classList.toggle("is-invalid", touched && Boolean(validation));
      if (touched && validation) {
        errorEl.textContent = validation;
        errorEl.classList.remove("hidden");
      } else {
        errorEl.classList.add("hidden");
        errorEl.textContent = "";
      }
      renderAvatar(previewEl, { name: normalized || nameInput.value || "User", imageDataUrl });
    };

    const cleanup = () => {
      avatarBtn.onclick = null;
      imageInput.onchange = null;
      nameInput.oninput = null;
      nameInput.onblur = null;
      nameInput.onkeydown = null;
      saveBtn.onclick = null;
    };

    const finish = async () => {
      view.classList.add("profile-setup-view--closing");
      await new Promise((r) => setTimeout(r, 180));
      appEl.classList.remove("app--profile-setup");
      view.classList.add("hidden");
      view.classList.remove("profile-setup-view--closing");
      cleanup();
      resolve();
    };

    avatarBtn.onclick = () => imageInput.click();
    imageInput.onchange = async () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      const cropped = await showProfileImageCropModal(file);
      imageInput.value = "";
      if (!cropped) return;
      imageDataUrl = cropped;
      sync();
    };

    nameInput.oninput = () => {
      touched = true;
      sync();
    };
    nameInput.onblur = () => {
      touched = true;
      sync();
    };
    nameInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveBtn.click();
      }
    };
    saveBtn.onclick = async () => {
      touched = true;
      sync();
      const normalized = normalizeProfileName(nameInput.value);
      const validation = validateProfileName(normalized);
      if (validation) {
        nameInput.focus();
        return;
      }
      saveBtn.disabled = true;
      await saveSetting(PROFILE_NAME_KEY, normalized);
      await saveSetting(PROFILE_IMAGE_KEY, imageDataUrl || "");
      state.settings[PROFILE_NAME_KEY] = normalized;
      state.settings[PROFILE_IMAGE_KEY] = imageDataUrl || "";
      updateProfileUi();
      await finish();
    };

    sync();
    setTimeout(() => nameInput.focus(), 40);
  });
}

async function ensureProfileSetup() {
  const currentName = getProfileName();
  if (!validateProfileName(currentName)) return;
  await showProfileSetupView();
}

// ---------- Onboarding survey ----------

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

const RECOMMENDED_COLLECTIONS_BY_ROLE = {
  "Motion Design": ["After Effects references", "Kinetic Typography", "Motion UI"],
  "Video Editing": ["Cinematic frames", "Editing transitions", "Color grading"],
  "Graphic Design": ["Poster design", "Typography inspiration", "Layout design"],
  "UI / UX Design": ["UI components", "Mobile apps", "Dashboard designs"],
  Photography: ["Cinematic photography", "Lighting setups", "Composition"],
  "Other Creative Work": ["General design inspiration"],
};

const ALL_ONBOARDING_COLLECTIONS = Array.from(
  new Set(Object.values(RECOMMENDED_COLLECTIONS_BY_ROLE).flat())
);

function showSurveyView() {
  return new Promise((resolve) => {
    const appEl = document.getElementById("app");
    const view = $("#surveyView");
    const stepsEl = $("#surveySteps");
    const stepEl = view?.querySelector(".survey-view__step");
    const progressEl = $("#surveyProgress");
    const progressFillEl = $("#surveyProgressFill");
    const questionTitleEl = $("#surveyQuestionTitle");
    const questionHintEl = $("#surveyQuestionHint");
    const optionsEl = $("#surveyOptions");
    const backBtn = $("#surveyBackBtn");
    const nextBtn = $("#surveyNextBtn");
    const successScreen = $("#surveySuccessScreen");
    const recommendedList = $("#surveyRecommendedList");
    const continueBtn = $("#surveyContinueBtn");

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

    const onLangChange = () => {
      renderStep();
      if (successScreen && !successScreen.classList.contains("hidden")) {
        const newLang = state.settings?.language || "en";
        recommendedList.querySelectorAll(".survey-view__recommended-name").forEach((el) => {
          const name = el.closest("label")?.querySelector("input")?.dataset?.name;
          if (name) el.textContent = t(`survey.collection.${name}`, newLang) || name;
        });
        recommendedList.querySelectorAll(".survey-view__recommended-badge").forEach((el) => {
          el.textContent = t("survey.recommended", newLang);
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
      nextBtn.textContent = step === SURVEY_QUESTIONS.length - 1 ? t("survey.finish", lang) : t("survey.next", lang);
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
      progressEl.textContent = `${step + 1} / ${SURVEY_QUESTIONS.length}`;
      progressFillEl.style.width = `${((step + 1) / SURVEY_QUESTIONS.length) * 100}%`;
      questionTitleEl.textContent = t(`survey.${question.key}.title`, l) || question.title;
      questionHintEl.textContent = t(`survey.${question.key}.hint`, l) || question.hint || "";
      optionsEl.innerHTML = "";
      const isSingle = question.selection === "single";
      const radioBlank = "assets/icons/remix/radio-button-line.svg";
      const radioFill = "assets/icons/remix/radio-button-fill.svg";
      const checkboxBlank = "assets/icons/remix/checkbox-blank-line.svg";
      const checkboxCheck = "assets/icons/remix/checkbox-circle-line.svg";

      question.options.forEach((label) => {
        const wrap = document.createElement("div");
        wrap.className = "survey-view__option-wrap";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "survey-view__option";
        btn.setAttribute("role", isSingle ? "radio" : "checkbox");
        btn.setAttribute("aria-checked", "false");
        btn.dataset.value = label;
        const icon = document.createElement("span");
        icon.className = "survey-view__option-icon";
        icon.setAttribute("aria-hidden", "true");
        if (isSingle) {
          icon.style.setProperty("--icon-url", `url('${radioBlank}')`);
          icon.dataset.iconSelected = radioFill;
          icon.dataset.iconUnselected = radioBlank;
        } else {
          icon.style.setProperty("--icon-url", `url('${checkboxBlank}')`);
          icon.dataset.iconSelected = checkboxCheck;
          icon.dataset.iconUnselected = checkboxBlank;
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
        icon.style.setProperty("--icon-url", `url('${selected ? icon.dataset.iconSelected : icon.dataset.iconUnselected}')`);
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
      stepEl.setAttribute("aria-hidden", "true");
      stepsEl.classList.add("hidden");
      successScreen.classList.remove("hidden");
      successScreen.setAttribute("aria-hidden", "false");

      const role = answers.creative_role || "Other Creative Work";
      const names = RECOMMENDED_COLLECTIONS_BY_ROLE[role] || RECOMMENDED_COLLECTIONS_BY_ROLE["Other Creative Work"];
      const recommended = new Set(names);
      recommendedList.innerHTML = "";
      ALL_ONBOARDING_COLLECTIONS.forEach((name) => {
        const label = document.createElement("label");
        label.className = "survey-view__recommended-item";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = recommended.has(name);
        input.dataset.name = name;
        label.appendChild(input);
        const textWrap = document.createElement("span");
        textWrap.className = "survey-view__recommended-copy";
        const title = document.createElement("span");
        title.className = "survey-view__recommended-name";
        title.textContent = t(`survey.collection.${name}`, lang) || name;
        textWrap.appendChild(title);
        if (recommended.has(name)) {
          const badge = document.createElement("span");
          badge.className = "survey-view__recommended-badge";
          badge.textContent = t("survey.recommended", lang);
          textWrap.appendChild(badge);
        }
        label.appendChild(textWrap);
        recommendedList.appendChild(label);
      });

      continueBtn.onclick = async () => {
        continueBtn.disabled = true;
        try {
          const existingNames = new Set(
            (state.collections || []).map((collection) => String(collection?.name || "").trim().toLowerCase())
          );
          for (const node of recommendedList.querySelectorAll('input[type="checkbox"]:checked')) {
            const name = node.dataset.name;
            const normalized = String(name || "").trim().toLowerCase();
            if (!name || existingNames.has(normalized) || !window.qooti?.createCollection) continue;
            await window.qooti.createCollection(name);
            existingNames.add(normalized);
          }
          await refreshData();
        } catch (e) {
          console.warn("[qooti] create recommended collections failed", e);
        }
        successScreen.classList.add("hidden");
        successScreen.setAttribute("aria-hidden", "true");
        stepsEl.classList.remove("hidden");
        cleanup();
      };
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
  $("#settingsCheckForUpdates")?.addEventListener("click", () => {
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
  const settingsAccountUsernameInput = $("#settingsAccountUsernameInput");
  const settingsAccountUsernameSave = $("#settingsAccountUsernameSave");
  const saveAccountUsername = async () => {
    if (!settingsAccountUsernameInput || !settingsAccountUsernameSave) return;
    const lang = state.settings?.language || "en";
    const normalized = normalizeProfileName(settingsAccountUsernameInput.value);
    const validation = validateProfileName(normalized);
    syncSettingsAccountUsernameEditor();
    if (validation) {
      settingsAccountUsernameInput.focus();
      return;
    }
    settingsAccountUsernameSave.disabled = true;
    try {
      await saveSetting(PROFILE_NAME_KEY, normalized);
      state.settings[PROFILE_NAME_KEY] = normalized;
      updateProfileUi();
      toast(t("settings.usernameSaved", lang), { variant: "success" });
    } catch (e) {
      toast(t("settings.usernameSaveFailed", lang), { variant: "error" });
      console.warn("[qooti] settings username update failed", e?.message || e);
    } finally {
      syncSettingsAccountUsernameEditor();
    }
  };
  settingsAccountUsernameInput?.addEventListener("input", () => {
    syncSettingsAccountUsernameEditor();
  });
  settingsAccountUsernameInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    saveAccountUsername();
  });
  settingsAccountUsernameSave?.addEventListener("click", () => {
    saveAccountUsername();
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
  bind("settingEnableTagFilters", "enableTagFilters", () => applyTagFilterVisibility());
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
        if (key && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(key);
          const lang = state.settings?.language || "en";
          extCopyBtn.textContent = t("settings.copied", lang);
          setTimeout(() => { extCopyBtn.textContent = t("settings.copyKey", lang); }, 1500);
        }
      } catch (_) {}
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
    if (!code || code === "—" || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(code);
      toast("Mobile connection code copied.", { variant: "success" });
    } catch (_) {}
  });
}

// URL detection
function isUrl(str) {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  return /^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed);
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

function youtubeEmbedUrl(videoId) {
  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    modestbranding: "1",
    rel: "0"
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
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
  return `<span class="${className}" style="--icon-url:url('assets/icons/remix/${name}')" aria-hidden="true"></span>`;
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
      message: copyText("copyFailed"),
      type: "error",
      duration: 3000,
    });
    console.error("[copy] failed:", err);
  }
}

const SOURCE_LABELS = {
  local: {
    icon: remixIcon("database-2-line.svg", "ui-icon ui-icon--sm card-label__icon"),
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
  collection: remixIcon("folder-add-line.svg", "ui-icon ui-icon--sm"),
  openSource: remixIcon("external-link-line.svg", "ui-icon ui-icon--sm"),
  copy: remixIcon("file-copy-line.svg", "ui-icon ui-icon--sm"),
  link: remixIcon("link-m.svg", "ui-icon ui-icon--sm"),
  delete: remixIcon("delete-bin-6-line.svg", "ui-icon ui-icon--sm"),
  newCollection: remixIcon("add-circle-line.svg", "ui-icon ui-icon--sm"),
  arrow: remixIcon("arrow-right-s-line.svg", "ui-icon ui-icon--sm"),
  exportPack: remixIcon("upload-2-line.svg", "ui-icon ui-icon--sm"),
  profileImage: remixIcon("user-line.svg", "ui-icon ui-icon--sm"),
  home: remixIcon("layout-4-line.svg", "ui-icon ui-icon--sm")
};

// Context menu state
let contextMenuTarget = null; // The inspiration item being right-clicked

function hideContextMenu() {
  const menu = $("#contextMenu");
  menu.classList.add("hidden");
  contextMenuTarget = null;
}

function showContextMenu(e, item) {
  if (state.settings.enableContextMenu === "false") return;
  e.preventDefault();
  e.stopPropagation();

  contextMenuTarget = item;
  const menu = $("#contextMenu");
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
            await navigator.clipboard.writeText(item.source_url);
            toast(t("ctx.linkCopied", lang), { variant: "success" });
          } catch {
            toast(t("ctx.couldNotCopyLink", lang), { variant: "error" });
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
      submenu.className = "context-menu__submenu";
      mi.buildSubmenu(submenu);
      row.appendChild(submenu);
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

  const items = [
    {
      icon: CTX_ICONS.rename,
      labelKey: "ctx.rename",
      action: async () => {
        hideContextMenu();
        const newName = await showPrompt({ message: t("ctx.renameCollection", colLang), defaultValue: row.collection?.name || "", submitLabel: t("ctx.rename", colLang) });
        if (newName == null) return;
        await window.qooti.renameCollection(row.collection.id, newName);
        if (state.currentCollectionId === row.collection.id) state.currentCollectionName = newName;
        collectionsPageRows = await loadCollectionsPageRows();
        renderCollectionsPage(collectionsPageRows);
        updateCollectionViewBar();
      }
    },
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
    },
    {
      icon: CTX_ICONS.delete,
      label: "Delete",
      danger: true,
      action: async () => {
        hideContextMenu();
        const ok = await showConfirm({
          message: `Delete collection "${escapeHtml(truncateForDialog(row.collection?.name || "Collection", 50))}"? This does not delete the media inside.`,
          confirmLabel: "Delete",
          danger: true
        });
        if (!ok) return;
        await window.qooti.deleteCollection(row.collection.id);
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
    }
  ];

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
    // Existing collections
    for (const c of state.collections) {
      const row = document.createElement("div");
      row.className = "context-menu__submenu-item";
      row.innerHTML = `
        <span class="context-menu__submenu-icon">${CTX_ICONS.collection}</span>
        <span class="context-menu__submenu-label">${c.name}</span>
      `;
      row.addEventListener("click", async (e) => {
        e.stopPropagation();
        uilog("ctxAddToCollection", "clicked", c.name);
        hideContextMenu();
        try {
          await window.qooti.addToCollection(c.id, [item.id]);
          await refreshData();
          await loadInspirations(false);
          const subLang = state.settings?.language || "en";
          toast(t("ctx.addedToCollection", subLang).replace("%s", c.name), { durationMs: 2800, variant: "success" });
          uilog("ctxAddToCollection", "done", c.name);
        } catch (err) {
          uilog("ctxAddToCollection", "error", err?.message || String(err));
          toast(err?.message || t("ctx.couldNotAddToCollection", subLang), { variant: "error" });
        }
      });
      submenu.appendChild(row);
    }
    
    // Separator if there are collections
    if (state.collections.length > 0) {
      const div = document.createElement("div");
      div.className = "context-menu__divider";
      submenu.appendChild(div);
    }
    
    // New collection
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
      await refreshData();
      await loadInspirations(false);
      toast(t("ctx.addedToCollection", ctxLang).replace("%s", name), { durationMs: 2800, variant: "success" });
    });
    submenu.appendChild(newRow);
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
  uilog("findRelated", "showFindSimilarModal entered");
  if (!item?.id) return;
  const wrap = document.createElement("div");
  wrap.className = "app-modal app-modal--find-similar";
  wrap.innerHTML = `
    <div class="app-modal__backdrop"></div>
    <div class="app-modal__dialog app-modal__dialog--wide">
      <div class="app-modal__header">
        <h3 class="app-modal__title">Find related</h3>
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
        `Image path: ${data?.analysis_path || "(none)"}`,
      ];
      metaEl.textContent = lines.join(" | ");
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
      await navigator.clipboard.writeText(textEl.textContent || "");
      toast("OCR text copied", { variant: "success" });
    } catch {
      toast("Could not copy OCR text", { variant: "error" });
    }
  });
  refreshBtn.addEventListener("click", async () => {
    await load(true);
    // Give queue a moment to process, then re-read debug state.
    setTimeout(() => load(false), 1000);
    setTimeout(() => load(false), 2500);
  });

  document.body.appendChild(wrap);
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
    showDownloadIndicator("Adding…");
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
  showDownloadIndicator("Downloading thumbnail…");
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

function showDownloadIndicator(label = "Downloading video…") {
  downloadIndicatorState.active = true;
  downloadIndicatorState.label = label;
  downloadIndicatorState.percent = 0;
  syncBottomCenterIndicators();
}

function renderDownloadIndicator() {
  const el = $("#downloadIndicator");
  const labelEl = $("#downloadIndicatorLabel");
  if (!el) return;
  if (!downloadIndicatorState.active || !shouldRenderBottomCenterIndicator("download")) {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    return;
  }
  if (labelEl) labelEl.textContent = downloadIndicatorState.label;
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
  syncBottomCenterIndicators();
}

function updateDownloadIndicator(percent) {
  downloadIndicatorState.percent = percent;
  renderDownloadIndicator();
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
    const result = await window.qooti.downloadVideoFromUrl(url, title);

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

async function handleDelAllSearchCommand() {
  if (delAllInProgress) return;
  delAllInProgress = true;
  try {
    const result = await window.qooti.clearAllMedia?.();
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
    console.error("delall clearAllMedia error:", err);
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

  showDownloadIndicator();
  const unsubscribe = window.qooti.onDownloadProgress?.(updateDownloadIndicator);

  try {
    const result = await window.qooti.downloadVideoFromUrl(url, title || null);

    if (result?.ok) {
      updateDownloadIndicator(100);
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
  } finally {
    hideDownloadIndicator();
    if (typeof unsubscribe === "function") unsubscribe();
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
  try {
    state.collections = await window.qooti.listCollections();
  } catch (e) {
    console.error("[qooti] refreshData failed:", e?.message || e);
    if (window.qooti?.debug) window.qooti.debug();
    throw e;
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
  document.getElementById("app")?.classList.remove("app--collections-open");
  $("#gridView").classList.remove("hidden");
  applyTagFilterVisibility();
  $("#settingsView")?.classList.add("hidden");
  $("#historyView")?.classList.add("hidden");
  $("#collectionsView")?.classList.add("hidden");
}

function showSettings() {
  state.prevViewBeforeSettings = state.view;
  document.getElementById("app")?.classList.add("app--settings-open");
  $("#gridView").classList.add("hidden");
  $("#tagFilterBar")?.classList.add("hidden");
  $("#settingsView")?.classList.remove("hidden");
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
  if (it?.type === "video" && storedUrl) return loadableUrl(storedUrl, it.stored_path);
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

function normalizePackName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function validatePackName(name) {
  const normalized = normalizePackName(name);
  if (!normalized) return "Pack name is required.";
  if (normalized.length > 50) return "Pack name must be 50 characters or fewer.";
  if (!/^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/.test(normalized)) {
    return "Use letters, numbers, single spaces, and dashes only.";
  }
  return "";
}

async function openExportCollectionPackFlow(row) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "app-modal app-modal--prompt";
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
    let profileImageDataUrl = null;
    input.value = normalizePackName(row.collection?.name || "Collection Pack");

    function close() {
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
      try {
        const res = await window.qooti.exportCollectionAsPack(row.collection.id, packName, profileImageDataUrl);
        toast(`Exported ${res.bundled} items${res.skipped ? ` (${res.skipped} skipped)` : ""}`, { variant: "success" });
        close();
      } catch (err) {
        showError(err?.message || "Export failed.");
        btnSubmit.disabled = false;
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
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(formatCollectionDisplayName(c.name))}</option>`)
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
    ? rows.filter((row) => (row.collection?.name || "").toLowerCase().includes(query))
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
    card.querySelector(".collections-card__title").textContent = formatCollectionDisplayName(row.collection?.name) || "Untitled collection";
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
      state.currentCollectionName = row.collection?.name || "Collection";
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

/** Show or hide the collection view bar (back + breadcrumb) and set name when viewing a collection. */
function updateCollectionViewBar() {
  const bar = $("#collectionViewBar");
  const nameEl = $("#collectionViewBarName");
  if (!bar || !nameEl) return;
  if (state.view.startsWith("collection:")) {
    const raw = state.currentCollectionName || (state.collections && state.collections.find(c => c.id === state.view.split(":")[1])?.name) || "Collection";
    nameEl.textContent = formatCollectionDisplayName(raw);
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
  const ar = it.aspect_ratio;
  if (ar != null && typeof ar === "number") {
    return ar < VERTICAL_ASPECT_THRESHOLD;
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
  try {
    const topTags = await window.qooti?.getTopTags?.(25);
    const list = Array.isArray(topTags) ? topTags : [];
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
    console.warn("[qooti] getTopTags failed:", e?.message || e);
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
  let isDown = false;
  let startX = 0;
  let startLeft = 0;
  let suppressClickUntil = 0;

  const stopDragging = () => {
    if (!isDown) return;
    isDown = false;
    scrollEl.classList.remove("is-dragging");
    document.body.classList.remove("tag-filter-dragging");
  };

  scrollEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDown = true;
    startX = e.pageX;
    startLeft = scrollEl.scrollLeft;
    suppressClickUntil = 0;
    scrollEl.classList.add("is-dragging");
    document.body.classList.add("tag-filter-dragging");
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    const dx = e.pageX - startX;
    if (Math.abs(dx) > 4) suppressClickUntil = Date.now() + 150;
    scrollEl.scrollLeft = startLeft - dx;
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

async function loadInspirations(shuffle = true) {
  try {
    const params = {
      query: state.query,
      limit: GRID_INITIAL_LIMIT,
      offset: 0,
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
    if (!Array.isArray(result)) {
      console.warn("[qooti] listInspirations returned non-array:", result);
    }
    state.inspirations = items;
    state.inspirationsHasMore = items.length >= GRID_INITIAL_LIMIT;
    if (shuffle && items.length > 0) {
      shuffleArray(state.inspirations);
    }
    renderGrid();
    refreshMediaPreviewItemFromState();
  } catch (e) {
    console.error("[qooti] loadInspirations failed:", e?.message || e);
    if (window.qooti?.debug) window.qooti.debug();
    state.inspirations = [];
    state.inspirationsHasMore = false;
    renderGrid();
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
            window.qooti.downloadVideoFromUrl(url, title || undefined),
            EXTENSION_OP_MS,
            "Video download timed out"
          );
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
    const showCollectionIndicator = s.showCollectionIndicator === "true";
    const hasCustomTitle = showMediaTitle && it.title && it.title !== it.original_filename;
    const src = sourceType(it);
    const label = SOURCE_LABELS[src] || SOURCE_LABELS.web;
    const collectionName = state.view?.startsWith("collection:") ? formatCollectionDisplayName(state.currentCollectionName || "Collection") : "";
    const collectionLabel = showCollectionIndicator && collectionName ? `<span class="card-label card-label--collection"><span>${escapeHtml(collectionName)}</span></span>` : "";

    const thumbContent =
      isLocalVideo
        ? `<video class="thumb__video" muted loop playsinline preload="metadata"></video>`
        : displayThumbUrl
          ? `<img alt="" />`
          : isYoutubeLink
            ? `<div class="thumb__placeholder" aria-hidden="true">▶</div>`
            : "";
    card.innerHTML = `
      <div class="thumb">
        <div class="thumb__overlay"></div>
        <div class="thumb__select" title="Select">${isSelected ? "✓" : ""}</div>
        ${thumbContent}
      </div>
      <div class="card-body">
        <div class="title"></div>
        <span class="card-label card-label--${src}" ${showSourceLabels ? "" : ' style="display:none"'}>${label.icon}<span>${label.text}</span></span>
        ${collectionLabel}
      </div>
    `;
    card.classList.toggle("card--show-title-always", !showTitlesOnHover);

    if (isLocalVideo && mediaUrl) {
      const video = card.querySelector(".thumb__video");
      video.src = loadableUrl(mediaUrl, it.stored_path);
      const posterUrl = thumbUrl ? loadableUrl(thumbUrl, it.thumbnail_path) : "";
      if (posterUrl) video.poster = posterUrl;
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
      if (absPath) {
        e.dataTransfer.setData("text/plain", absPath);
        e.dataTransfer.setData("text/uri-list", "file:///" + absPath.replace(/\\/g, "/").replace(/^\/+/, ""));
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
  if (cards.length === 0) return { oneRowHeight: 0, threeRowsHeight: 0, totalHeight: 0, rowCount: 0 };

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

  const thirdRowTop = tops[Math.min(2, tops.length - 1)];
  let thirdBottom = thirdRowTop;
  for (const card of cards) {
    if (Math.abs(card.offsetTop - thirdRowTop) <= 1) {
      thirdBottom = Math.max(thirdBottom, card.offsetTop + card.offsetHeight);
    }
  }
  const totalHeight = gridEl.scrollHeight;
  const threeRowsHeight = tops.length >= 3
    ? Math.max(oneRowHeight * 3, thirdBottom - firstTop)
    : Math.min(totalHeight, Math.max(oneRowHeight, totalHeight));

  return { oneRowHeight, threeRowsHeight, totalHeight, rowCount: tops.length };
}

function applyShortFormSectionState(sectionEl, itemCount) {
  if (!sectionEl) return;
  const gridEl = sectionEl.querySelector(".short-form-grid");
  const toggleBtn = sectionEl.querySelector("[data-short-toggle]");
  if (!gridEl || !toggleBtn) return;

  const key = sectionEl.dataset.shortSectionKey || sectionEl.id || "short-form-default";
  const expanded = shortFormExpansion.get(key) === true;
  const { oneRowHeight, threeRowsHeight, totalHeight, rowCount } = measureShortFormHeights(gridEl);
  const canToggle = itemCount > 0 && rowCount > 1;
  const targetHeight = expanded
    ? Math.min(totalHeight, Math.max(threeRowsHeight, oneRowHeight))
    : oneRowHeight;

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

  const cols = gridView ? computeLongFormCols(gridView.offsetWidth) : 4;
  const longChunkSize = Math.max(1, 2 * cols);
  const shortChunkSize = Math.max(1, 3 * cols);
  const longChunks = chunkArray(mainItems, longChunkSize);
  const shouldInterleaveShortRows = shortFormItems.length > 20 && longChunks.length > 1;
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
let ocrDebugChordArmedUntil = 0;
let reelFeedItems = [];
let reelFeedScrollHandler = null;

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
  const tagsEl = $("#mediaPreviewTags");
  if (titleEl) titleEl.textContent = truncateForDialog(it?.title || it?.original_filename || "Untitled", 55);
  const srcType = sourceType(it);
  const platformLabel = SOURCE_LABELS[srcType]?.text ?? "Link";
  if (badgeEl) {
    badgeEl.textContent = srcType === "local" ? "Local" : platformLabel;
    badgeEl.className = "media-preview__badge media-preview__badge--" + srcType;
  }
  if (tagsEl) {
    const tagLabels = (it.tags || []).map((t) => t.label || t).filter(Boolean).slice(0, 3);
    tagsEl.innerHTML = tagLabels.map((l) => `<span class="media-preview__tag">${escapeHtml(l)}</span>`).join("");
    tagsEl.classList.toggle("hidden", tagLabels.length === 0);
  }
  syncMediaPreviewActionState(it);
}

function syncMediaPreviewActionState(it) {
  const quickActions = $("#mediaPreviewQuickActions");
  const pathToCopy = getMediaPreviewPathToCopy(it);
  if (quickActions) {
    const copyBtn = quickActions.querySelector('[data-action="copy"]');
    const downloadBtn = quickActions.querySelector('[data-action="download"]');
    const openBtn = quickActions.querySelector('[data-action="open-source"]');
    if (copyBtn) copyBtn.classList.toggle("hidden", !pathToCopy);
    if (downloadBtn) downloadBtn.classList.toggle("hidden", !it?.source_url);
    if (openBtn) openBtn.classList.toggle("hidden", !it?.source_url);
  }
  const requiresId = !it?.id;
  $("#mediaPreviewAddToCollection")?.toggleAttribute("disabled", requiresId);
  $("#mediaPreviewEditTags")?.toggleAttribute("disabled", requiresId);
  $("#mediaPreviewFindRelated")?.toggleAttribute("disabled", requiresId);
}

/** Wire video inspector: frame hold on click, timeline as frame selector, step ±1s, copy frame. No autoplay on scrub. */
function wireVideoInspector(video, _item) {
  const timelineEl = $("#mediaPreviewTimeline");
  const stepBackBtn = $("#mediaPreviewStepBack");
  const stepFwdBtn = $("#mediaPreviewStepFwd");
  const copyFrameBtn = $("#mediaPreviewCopyFrame");
  if (!video) return;

  // Click video to play/pause — play to preview motion, pause to hold frame
  video.addEventListener("click", () => {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  });

  const updateTimelineFromVideo = () => {
    if (!timelineEl || !video.duration || !isFinite(video.duration)) return;
    const pct = (video.currentTime / video.duration) * 100;
    timelineEl.value = String(pct);
  };

  const updateVideoFromTimeline = () => {
    if (!timelineEl || !video.duration || !isFinite(video.duration)) return;
    const pct = Number(timelineEl.value) || 0;
    video.currentTime = (pct / 100) * video.duration;
  };

  video.addEventListener("timeupdate", updateTimelineFromVideo);
  video.addEventListener("loadedmetadata", () => {
    if (timelineEl) timelineEl.max = "100";
    updateTimelineFromVideo();
  });
  video.addEventListener("loadeddata", updateTimelineFromVideo);

  // Timeline scrub: frame selector only, no play
  if (timelineEl) {
    let isScrubbing = false;
    const startScrub = () => { isScrubbing = true; video.pause(); };
    const endScrub = () => { isScrubbing = false; };
    timelineEl.onmousedown = startScrub;
    timelineEl.ontouchstart = startScrub;
    timelineEl.onmouseup = endScrub;
    timelineEl.ontouchend = endScrub;
    timelineEl.oninput = () => {
      updateVideoFromTimeline();
      if (!isScrubbing) video.pause();
    };
    timelineEl.onchange = () => { video.pause(); };
  }

  if (stepBackBtn) {
    stepBackBtn.onclick = () => {
      video.pause();
      video.currentTime = Math.max(0, video.currentTime - 1);
      updateTimelineFromVideo();
    };
  }
  if (stepFwdBtn) {
    stepFwdBtn.onclick = () => {
      video.pause();
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 1);
      updateTimelineFromVideo();
    };
  }
  if (copyFrameBtn) {
    copyFrameBtn.onclick = async () => {
      video.pause();
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas context unavailable");
        ctx.drawImage(video, 0, 0);
        const blob = await new Promise((res, rej) =>
          canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png")
        );
        if (!blob) throw new Error("No blob");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast("Frame copied to clipboard", { variant: "success" });
      } catch (e) {
        toast(e?.message || "Could not copy frame", { variant: "error" });
      }
    };
  }
}

async function showReelFeed(items, currentIndex) {
  reelFeedItems = items;
  mediaPreviewItem = items[currentIndex] || items[0];
  mediaPreviewCollections = [];
  const overlay = $("#mediaPreview");
  const mediaEl = $("#mediaPreviewArea");
  const reelFeedEl = $("#mediaPreviewReelFeed");
  const videoToolsEl = $("#mediaPreviewVideoTools");
  if (videoToolsEl) videoToolsEl.classList.add("hidden");

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
  const hintEl = $("#mediaPreviewHint");
  if (hintEl) hintEl.textContent = "Scroll to browse · Esc to close";

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
  const tagsEl = $("#mediaPreviewTags");
  const videoToolsEl = $("#mediaPreviewVideoTools");

  if (reelFeedEl) reelFeedEl.classList.add("hidden");
  if (videoToolsEl) videoToolsEl.classList.add("hidden");
  overlay.querySelector(".media-preview__content")?.classList.remove("media-preview__content--reel");
  if (mediaEl) mediaEl.classList.remove("hidden");
  if (mediaEl) mediaEl.classList.remove("media-preview__hero--reel");

  if (titleEl) titleEl.textContent = truncateForDialog(it.title || it.original_filename || "Untitled", 55);

  const srcType = sourceType(it);
  const platformLabel = SOURCE_LABELS[srcType]?.text ?? "Link";
  if (badgeEl) {
    badgeEl.textContent = srcType === "local" ? "Local" : platformLabel;
    badgeEl.className = "media-preview__badge media-preview__badge--" + srcType;
  }
  if (tagsEl) {
    const tagLabels = (it.tags || []).map((t) => t.label || t).filter(Boolean).slice(0, 3);
    tagsEl.innerHTML = tagLabels.map((l) => `<span class="media-preview__tag">${escapeHtml(l)}</span>`).join("");
    tagsEl.classList.toggle("hidden", tagLabels.length === 0);
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
        const h = $("#mediaPreviewHint");
        if (h) h.textContent = [...hintParts, "Click title to open collection"].join(" · ");
      }
    }).catch((err) => {
      uilog("mediaPreview", "getCollectionsForInspiration failed", err?.message || String(err));
    });
  }

  const hintEl = $("#mediaPreviewHint");
  const hintParts = ["Esc to close"];

  mediaEl.innerHTML = "";
  mediaEl.draggable = false;
  mediaEl.dataset.dragPath = "";

  if (it.type === "image" || it.type === "gif") {
    const img = document.createElement("img");
    wireVaultImageFallback(img, it, false);
    img.alt = it.title || "";
    img.draggable = false;
    mediaEl.appendChild(img);
  } else if (it.type === "video") {
    const video = document.createElement("video");
    video.src = loadableUrl(it.stored_path_url, it.stored_path);
    video.controls = false;
    video.autoplay = false;
    video.draggable = false;
    video.playsInline = true;
    if (showsInShortFormRow(it)) {
      mediaEl.classList.add("media-preview__hero--reel");
    }
    mediaEl.appendChild(video);
    if (videoToolsEl) videoToolsEl.classList.remove("hidden");
  } else if (it.type === "link") {
    const ytId = it.source_url ? youtubeVideoId(it.source_url) : null;
    if (ytId) {
      const iframe = document.createElement("iframe");
      iframe.src = youtubeEmbedUrl(ytId) + "&autoplay=1";
      iframe.title = "YouTube";
      iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture");
      if (showsInShortFormRow(it)) {
        iframe.classList.add("media-preview__iframe--reel");
      }
      mediaEl.appendChild(iframe);
    } else {
      const thumb = it.thumbnail_path_url || "";
      if (thumb) {
        const img = document.createElement("img");
        wireVaultImageFallback(img, it, true);
        img.alt = it.title || "";
        img.draggable = false;
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
    hintParts.push("Drag media to copy");
  } else {
    mediaEl.classList.remove("media-preview__media--draggable");
  }
  if (hintEl) hintEl.textContent = hintParts.join(" · ");

  overlay.classList.remove("hidden");
  syncMediaPreviewActionState(it);

  if (copyKeyHandler) {
    document.removeEventListener("keydown", copyKeyHandler);
    copyKeyHandler = null;
  }
  copyKeyHandler = async (e) => {
    const isCopy = (e.ctrlKey || e.metaKey) && String(e.key || "").toLowerCase() === "c";
    if (!isCopy) return;
    const selection = window.getSelection?.();
    if (selection && selection.toString().length > 0) return;
    if (!mediaPreviewItem) return;
    e.preventDefault();
    await handleCopyMedia(mediaPreviewItem);
  };
  document.addEventListener("keydown", copyKeyHandler);

  // Video inspector: frame hold, timeline, step, copy frame (wired after DOM ready)
  const video = mediaEl.querySelector("video");
  if (video && videoToolsEl) {
    wireVideoInspector(video, it);
  }
}

function hideMediaPreview() {
  uilog("mediaPreview", "hideMediaPreview");
  mediaPreviewItem = null;
  $("#mediaPreview")?.querySelector(".media-preview__content")?.classList.remove("media-preview__content--reel");
  const reelFeedEl = $("#mediaPreviewReelFeed");
  if (reelFeedEl && reelFeedScrollHandler) {
    reelFeedEl.removeEventListener("scroll", reelFeedScrollHandler);
    reelFeedScrollHandler = null;
  }
  $("#mediaPreview").classList.add("hidden");
  if (copyKeyHandler) {
    document.removeEventListener("keydown", copyKeyHandler);
    copyKeyHandler = null;
  }
  const mediaEl = $("#mediaPreviewArea");
  if (mediaEl) mediaEl.innerHTML = "";
  if (reelFeedEl) reelFeedEl.innerHTML = "";
}

// Alias for backward compatibility — resolve full item from state so newly added items open correctly
function openPreview(it) {
  if (!it?.id) return;
  const full = state.inspirations.find((i) => i.id === it.id);
  showMediaPreview(full ?? it);
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
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `<div class="list-item__name"></div><div class="badge">Add</div>`;
    row.querySelector(".list-item__name").textContent = c.name;
    row.addEventListener("click", async () => {
      await window.qooti.addToCollection(c.id, ids);
      hideModal();
      await refreshData();
      await loadInspirations(false);
      toast(`Added to ${c.name} collection`, 2800);
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

function historyThumbUrl(it) {
  const thumbUrl = it.thumbnail_path_url;
  const storedUrl = it.stored_path_url;
  if (thumbUrl) return loadableUrl(thumbUrl, it.thumbnail_path);
  if ((it.type === "image" || it.type === "gif") && storedUrl) return loadableUrl(storedUrl, it.stored_path);
  if (it.type === "video" && storedUrl) return loadableUrl(storedUrl, it.stored_path);
  return "";
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
      const thumbSrc = historyThumbUrl(it);
      const isVideo = it.type === "video" || it.type === "link";
      const thumbClass = "history-row__thumb history-row__thumb--" + (isVideo ? "video" : "square");
      const thumbContent = thumbSrc
        ? `<img class="history-row__img" src="${escapeHtml(thumbSrc)}" alt="" loading="lazy" />`
        : '<span class="history-row__placeholder" aria-hidden="true">' + (isVideo ? "▶" : "◇") + "</span>";
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
        <span class="ui-icon" style="--icon-url:url('assets/icons/remix/notion-fill.svg')" aria-hidden="true"></span>
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
            <span class="ui-icon notion-progress-window__icon" style="--icon-url:url('assets/icons/remix/notion-fill.svg')" aria-hidden="true"></span>
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
            <span class="ui-icon notion-progress-window__icon" style="--icon-url:url('assets/icons/remix/notion-fill.svg')" aria-hidden="true"></span>
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
            <span class="ui-icon notion-progress-window__icon" style="--icon-url:url('assets/icons/remix/checkbox-circle-line.svg')" aria-hidden="true"></span>
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
      <div class="app-modal__dialog app-modal__dialog--wide">
        <div class="app-modal__body">
          <div class="app-modal__title">${escapeHtml(t("feedback.title", lang))}</div>
          <div class="app-modal__message">${escapeHtml(t("feedback.description", lang))}</div>
          <textarea id="feedbackMessageInput" class="feedback-modal__textarea" placeholder="${escapeHtml(t("feedback.placeholder", lang))}" maxlength="3000"></textarea>
          <label class="feedback-modal__screenshot-option">
            <input type="checkbox" id="feedbackIncludeScreenshot" class="feedback-modal__screenshot-checkbox" />
            <span>${escapeHtml(t("feedback.includeScreenshot", lang))}</span>
          </label>
          <div class="feedback-modal__attach-row">
            <label for="feedbackImageInput" class="btn btn--secondary feedback-modal__attach-btn">${escapeHtml(t("feedback.attachFile", lang))}</label>
            <input id="feedbackImageInput" type="file" accept="image/png,image/jpeg,image/jpg,image/webp" class="feedback-modal__file-input" />
            <span id="feedbackImageName" class="feedback-modal__file-name">${escapeHtml(t("feedback.noFileSelected", lang))}</span>
          </div>
          <div id="feedbackModalError" class="feedback-modal__error hidden"></div>
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
  // Global paste handler
  document.addEventListener("paste", handleGlobalPaste);

  // Keyboard sequence: Ctrl+B, then C opens DevTools.
  let awaitingConsoleShortcut = false;
  let consoleShortcutTimer = null;
  document.addEventListener("keydown", (e) => {
    const key = String(e.key || "").toLowerCase();
    if (key === "f12") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && key === "b") {
      awaitingConsoleShortcut = true;
      if (consoleShortcutTimer) clearTimeout(consoleShortcutTimer);
      consoleShortcutTimer = setTimeout(() => {
        awaitingConsoleShortcut = false;
        consoleShortcutTimer = null;
      }, 2500);
      return;
    }
    if (awaitingConsoleShortcut && !e.ctrlKey && !e.shiftKey && !e.altKey && key === "c") {
      awaitingConsoleShortcut = false;
      if (consoleShortcutTimer) clearTimeout(consoleShortcutTimer);
      consoleShortcutTimer = null;
      e.preventDefault();
      window.qooti?.openDevtools?.().catch?.((err) => {
        console.warn("[qooti] openDevtools failed", err?.message || err);
      });
      return;
    }
    if (awaitingConsoleShortcut && key !== "control") {
      awaitingConsoleShortcut = false;
      if (consoleShortcutTimer) clearTimeout(consoleShortcutTimer);
      consoleShortcutTimer = null;
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
    const folderIconUrl = "url('assets/icons/remix/folder-line.svg')";
    function renderCollectionsList() {
      const list = (state.collections || []).filter((c) => c.visible_on_home !== false);
      listEl.innerHTML = "";
      if (list.length === 0) {
        emptyEl.classList.remove("hidden");
        return;
      }
      emptyEl.classList.add("hidden");
      for (const c of list) {
        const count = c.item_count != null ? c.item_count : (c.itemCount != null ? c.itemCount : 0);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dropdown__item";
        btn.setAttribute("role", "menuitem");
        btn.innerHTML = `<span class="ui-icon ui-icon--sm dropdown__item-icon" style="--icon-url:${folderIconUrl}" aria-hidden="true"></span><span class="collections-panel__item-name">${escapeHtml(c.name || "Unnamed")}</span><span class="collections-panel__item-count">${count}</span>`;
        btn.dataset.collectionId = c.id;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = e.currentTarget.dataset.collectionId;
          if (!id) return;
          hideAllDropdowns();
          openedByClick = false;
          state.view = "collection:" + id;
          state.currentCollectionId = id;
          state.currentCollectionName = (state.collections || []).find((x) => x.id === id)?.name || "";
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
  $("#profileSetupLangToggle")?.addEventListener("click", () => {
    toggleSurveyProfileLanguage();
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
    loadInspirations(true);
  });
  $("#tagFilterRecent")?.addEventListener("click", () => {
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
      state.selectedTagId = tagId;
      updateTagFilterBarActiveState();
      loadInspirations(!state.sortByRecent);
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
      addBtn.innerHTML = `<span class="ui-icon ui-icon--sm" style="--icon-url:url('assets/icons/remix/add-line.svg')" aria-hidden="true"></span>`;
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
      pushRecentColor(rgbToHex(rgb.r, rgb.g, rgb.b));
      state.colorFilter = rgb;
      closePopover();
      updateColorFilterUI();
      loadInspirations(false);
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
      });
    }
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(hexInput.value.trim());
          toast("Copied to clipboard", { variant: "success" });
        }
      } catch (err) {
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
  // Quick actions on media hover (Copy, Download, Open source)
  const quickActions = $("#mediaPreviewQuickActions");
  const canvasWrap = document.querySelector(".media-preview__canvas-wrap");
  if (quickActions && canvasWrap) {
    quickActions.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const it = mediaPreviewItem;
        if (!it) return;
        if (action === "copy") {
          await handleCopyMedia(it);
        } else if (action === "open-source" && it.source_url) {
          window.open(it.source_url, "_blank", "noopener");
        } else if (action === "download" && it.source_url && (it.type === "link" || it.type === "video")) {
          hideMediaPreview();
          showAddSurface();
          $("#addInput").value = it.source_url;
          $("#addInput").focus();
        }
      });
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
    uilog("addToCollection", "refreshData start");
    await refreshData();
    uilog("addToCollection", "refreshData done, building modal");
    const body = document.createElement("div");
    body.innerHTML = `<div class="field"><div style="color:var(--muted)">Choose a collection</div></div>`;
    const list = document.createElement("div");
    list.className = "list";
    for (const c of state.collections) {
      const row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML = `<div class="list-item__name"></div><div class="badge">Add</div>`;
      row.querySelector(".list-item__name").textContent = c.name;
      row.addEventListener("click", async () => {
        uilog("addToCollection", "clicked", c.name);
        try {
          uilog("addToCollection", "invoking");
          await window.qooti.addToCollection(c.id, [item.id]);
          uilog("addToCollection", "invoke resolved");
          hideModal();
          await refreshData();
          loadInspirations(false);
          toast(`Added to ${c.name}`, { durationMs: 2800, variant: "success" });
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
      e.dataTransfer.setData("text/plain", absPath);
      e.dataTransfer.setData("text/uri-list", "file:///" + absPath.replace(/\\/g, "/").replace(/^\/+/, ""));
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
    if (e.key === "Enter") {
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
      await navigator.clipboard.writeText(pendingLinkPreview.url);
      toast("Link copied", { variant: "success" });
    } catch {
      toast("Could not copy link", { variant: "error" });
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

  // Menu items — Shuffle: randomize visible dataset. With tag filter: shuffle filtered set. With Recent: switch to All then shuffle.
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

  // Window controls (stop propagation so drag region doesn't capture). Use __TAURI__ directly if qooti not set (production).
  const getWin = window.__TAURI__?.window?.getCurrentWindow?.();
  const doMinimize = () => { if (window.qooti?.windowMinimize) { window.qooti.windowMinimize(); return; } getWin?.()?.then((w) => w.minimize()).catch(() => {}); };
  const doMaximize = () => { if (window.qooti?.windowMaximize) { window.qooti.windowMaximize(); return; } getWin?.()?.then(async (w) => { const m = await w.isMaximized(); m ? w.unmaximize() : w.maximize(); }).catch(() => {}); };
  const doClose = () => { if (window.qooti?.windowClose) { window.qooti.windowClose(); return; } getWin?.()?.then((w) => w.close()).catch(() => {}); };
  $("#btnWindowMinimize")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    doMinimize();
  });

  $("#btnWindowMaximize")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
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
    if (value === "delall") {
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
    // Normal search — apply query and reload
    state.query = value;
    loadInspirations(false);
  });

  $("#searchInput").addEventListener("paste", handleSearchBarPaste);

  // Search bar download (when video link pasted)
  wireSearchDownloadBar();

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

  // Hidden OCR debug shortcut in media preview: Ctrl+B then T (or Ctrl+T while armed)
  document.addEventListener("keydown", (e) => {
    const mediaPreviewOpen = !$("#mediaPreview").classList.contains("hidden");
    if (!mediaPreviewOpen) return;
    const key = (e.key || "").toLowerCase();
    if (e.ctrlKey && key === "b") {
      ocrDebugChordArmedUntil = Date.now() + 1800;
      return;
    }
    if (key !== "t") return;
    const armed = Date.now() <= ocrDebugChordArmedUntil;
    if (!armed && !e.ctrlKey) return;
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
  await loadSettingsFromBackend();
  updateProfileUi();
  // License validation is complete at this point; stop showing the boot screen
  // before onboarding overlays (profile/survey) are presented.
  appEl?.classList.remove("app--booting");
  await ensureProfileSetup();
  updateProfileUi();
  await ensureSurveyComplete();
  updateProfileUi();
  applyTheme();
  applyTranslations();
  applyUiScale();
  applyCardSizing();
  applyMediaTitleSizing();
  applyTagFilterVisibility();
  await refreshData();
  await loadInspirations();
  await ensureTagCountsAndRefreshBar();
  await refreshOcrIndexStats();
  // Resume any real OCR backlog on startup, even if the queue had not started yet.
  if (getOcrBacklogCount() > 0) {
    scheduleOcrAutoIndex();
  }
  // Load notifications after first media render to avoid empty-state flash.
  initNotificationsSystem();
  updateSelectionBar();
  updateCollectionViewBar();
  startExtensionPoll();
  setupExtensionPollOnFocus();
}

function setLicenseGateState({ subtitle, error, showRetry = false } = {}) {
  const subtitleEl = $("#licenseViewSubtitle");
  const errEl = $("#licenseError");
  const retryBtn = $("#licenseRetryBtn");
  if (subtitleEl && subtitle != null) subtitleEl.textContent = subtitle;
  if (errEl) {
    errEl.textContent = error || "";
    errEl.classList.toggle("hidden", !error);
  }
  retryBtn?.classList.toggle("hidden", !showRetry);
}

function resetLicenseGateState() {
  const lang = state.settings?.language || "en";
  setLicenseGateState({
    subtitle: t("license.enterKey", lang),
    error: "",
    showRetry: false,
  });
}

let licenseStartupCheckPromise = null;

async function startLicensedSession() {
  const appEl = document.getElementById("app");
  appEl?.classList.remove("app--unlicensed");
  appEl?.classList.add("app--booting");
  await bootMainContent();
  appEl?.classList.remove("app--booting");
}

async function checkStoredLicenseAccess({ showGateError = true } = {}) {
  if (licenseStartupCheckPromise) return licenseStartupCheckPromise;
  licenseStartupCheckPromise = (async () => {
    const lang = state.settings?.language || "en";
    const appEl = document.getElementById("app");
    const bootStatusEl = $("#bootViewStatus");
    setText(bootStatusEl, t("boot.checkingLicense", lang));
    const LICENSE_STARTUP_TIMEOUT_MS = 10000;
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
    licenseLog("stored license check returned", {
      valid: result?.valid,
      status: result?.status,
      usedCached: result?.used_cached,
      hasCachedKey: result?.has_cached_key,
    });
    if (result?.valid) {
      resetLicenseGateState();
      await startLicensedSession();
      if (result?.used_cached) {
        setTimeout(() => {
          toast(t("license.cachedOffline", lang), { durationMs: 3600, variant: "warning" });
        }, 0);
      }
      return true;
    }
    appEl?.classList.remove("app--booting");
    appEl?.classList.add("app--unlicensed");
    if (showGateError) {
      setLicenseGateState({
        subtitle: t("license.enterKey", lang),
        error: getLicenseStatusMessage(result, lang),
        showRetry: !!result?.has_cached_key || String(result?.status || "") === "network_error",
      });
    }
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
  const retryBtn = $("#licenseRetryBtn");
  if (!form || !input) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    setLicenseGateState({ subtitle: t("license.enterKey", state.settings?.language || "en"), error: "", showRetry: false });
    if (!key) {
      if (errEl) {
        errEl.textContent = "Please enter a license key.";
        errEl.classList.remove("hidden");
      }
      return;
    }
    if (btn) {
      uilog("license", "btn.disabled = true");
      btn.disabled = true;
    }
    try {
      const result = await window.qooti?.validateLicense?.(key);
      if (result && result.success) {
        input.value = "";
        resetLicenseGateState();
        await startLicensedSession();
      } else {
        if (errEl) {
          errEl.textContent = getLicenseStatusMessage(result, state.settings?.language || "en");
          errEl.classList.remove("hidden");
        }
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err?.message || "Activation failed.";
        errEl.classList.remove("hidden");
      }
    } finally {
      if (btn) {
        uilog("license", "btn.disabled = false");
        btn.disabled = false;
      }
    }
  });
  retryBtn?.addEventListener("click", async () => {
    retryBtn.disabled = true;
    try {
      const appEl = document.getElementById("app");
      appEl?.classList.remove("app--unlicensed");
      appEl?.classList.add("app--booting");
      setLicenseGateState({
        subtitle: t("license.enterKey", state.settings?.language || "en"),
        error: "",
        showRetry: false,
      });
      await checkStoredLicenseAccess({ showGateError: true });
    } finally {
      retryBtn.disabled = false;
    }
  });
}

function licenseLog(step, detail) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[qooti][license] ${ts} ${step}`, detail !== undefined ? detail : "");
}

async function boot() {
  const appEl = document.getElementById("app");
  licenseLog("boot start");
  wireEvents();
  wireSettingsControls();
  setupGlobalDropZone();
  wireLicenseGate();
  try {
    licenseLog("waiting for Qooti API...");
    await waitForQootiApi();
    await syncUpdaterStateFromBridge();
    resetLicenseGateState();
    const granted = await checkStoredLicenseAccess({ showGateError: true });
    if (!granted) {
      licenseLog("stored license check denied access");
      return;
    }
    licenseLog("startup license granted");
  } catch (e) {
    console.error("[qooti][license] boot failed:", e?.message || e);
    licenseLog("boot failed", e?.message || e);
    appEl?.classList.remove("app--booting");
    appEl?.classList.add("app--unlicensed");
    setLicenseGateState({
      subtitle: t("license.enterKey", state.settings?.language || "en"),
      error: getLicenseStatusMessage({ status: "network_error", error: e?.message || String(e) }, state.settings?.language || "en"),
      showRetry: true,
    });
  }
  licenseLog("boot complete");
  if (window.qooti?.debug && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
    console.log("[qooti] Tip: Run qooti.debug() in console (Ctrl+B, then C) for diagnostics");
  }
}

boot();
