/**
 * Tauri API bridge - mimics window.qooti for frontend compatibility.
 * Uses window.__TAURI__ (injected by Tauri) to avoid bundler/import issues.
 */

// Debug: wrap invoke to log full action lifecycle (set false to disable)
const DEBUG_LIFECYCLE = true;

// High-frequency invokes: don't log every call (would flood console)
const QUIET_INVOKES = new Set([
  "get_extension_pending",
  "claim_ocr_index_candidates",
  "finalize_ocr_index_result",
  "get_ocr_index_stats",
  "reset_ocr_status_for_inspiration",
]);

const DIAG_PREFIX = "[qooti][diag]";

function trimForLog(value, max = 160) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sanitizeForLog(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return trimForLog(value, 200);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: trimForLog(value.message || String(value), 240),
      stack: trimForLog(value.stack || "", 320),
    };
  }
  if (depth >= 2) {
    if (Array.isArray(value)) return `[array:${value.length}]`;
    if (typeof value === "object") return "[object]";
  }
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitizeForLog(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/licensekey|password|privatekey/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = sanitizeForLog(val, depth + 1);
      }
    }
    return out;
  }
  return trimForLog(value, 160);
}

function diagLog(stage, payload = {}) {
  if (!DEBUG_LIFECYCLE || typeof console?.log !== "function") return;
  console.log(DIAG_PREFIX, stage, sanitizeForLog(payload));
}

function diagWarn(stage, payload = {}) {
  if (!DEBUG_LIFECYCLE || typeof console?.warn !== "function") return;
  console.warn(DIAG_PREFIX, stage, sanitizeForLog(payload));
}

function isDevLocationHref(href) {
  return /^http:\/\/(127\.0\.0\.1|localhost):/i.test(String(href || ""));
}

function isCrossOriginToPage(url) {
  if (!url || typeof location === "undefined" || !location?.href) return false;
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch (_) {
    return false;
  }
}

function deriveBaseUrl(url) {
  try {
    return new URL("./", url).toString();
  } catch (_) {
    return String(url || "");
  }
}

function debugInvoke(cmd, args, fn) {
  const invokeFn = fn || (() => window.__TAURI__?.core?.invoke?.(cmd, args));
  const quiet = QUIET_INVOKES.has(cmd);
  if (!DEBUG_LIFECYCLE || quiet) return invokeFn();
  const start = Date.now();
  const id = `invoke_${cmd}_${start}`;
  console.log(`[UI] ${id} TRIGGERED`, cmd);
  if (args && Object.keys(args).length > 0) {
    const safe = { ...args };
    if (safe.licenseKey != null) safe.licenseKey = "[REDACTED]";
    console.log(`[UI] ${id} args:`, JSON.stringify(safe).slice(0, 120));
  }
  return Promise.resolve()
    .then(() => {
      console.log(`[UI] ${id} calling Tauri invoke`);
      return invokeFn();
    })
    .then((res) => {
      console.log(`[UI] ${id} RESOLVED OK (${Date.now() - start}ms)`);
      return res;
    })
    .catch((err) => {
      console.error(`[UI] ${id} REJECTED after ${Date.now() - start}ms:`, err?.message || err);
      console.error(`[UI] ${id} full error:`, err);
      throw err;
    });
}

function toLoadableUrl(absPath, relPath) {
  if (!absPath && !relPath) return "";
  if (absPath && (absPath.startsWith("http://") || absPath.startsWith("https://"))) return absPath;
  // Normalize paths: use forward slashes
  const norm = (s) => (s || "").replace(/\\/g, "/").replace(/^[/]+/, "");
  // Dev server: use /vault/ path (serves from vault root)
  try {
    const href = typeof location !== "undefined" ? location.href : "";
    if (href.startsWith("http://127.0.0.1:") || href.startsWith("http://localhost:")) {
      let rel = norm(relPath) || (absPath ? absPath.replace(/^.*[/\\]vault[/\\]/i, "").replace(/\\/g, "/").replace(/^[/]+/, "") : "");
      if (rel) return (location.origin || "http://127.0.0.1:1421") + "/vault/" + rel;
    }
  } catch (_) {}
  // Production: use Tauri asset protocol
  const convertFileSrc = window.__TAURI__?.core?.convertFileSrc;
  const out = absPath && convertFileSrc ? convertFileSrc(absPath) : (absPath || "");
  if (DEBUG_LIFECYCLE && (absPath || relPath) && !out) {
    console.warn("[qooti] toLoadableUrl returned empty", { absPath: absPath?.slice(0, 60), relPath });
  }
  return out;
}

export function setupTauriApi() {
  const core = window.__TAURI__?.core;
  const winApi = window.__TAURI__?.window;
  const eventApi = window.__TAURI__?.event;
  const pathApi = window.__TAURI__?.path;
  const updaterApi = window.__TAURI__?.updater;
  const processApi = window.__TAURI__?.process;
  if (!core) {
    console.error("[qooti] setupTauriApi: core not found, __TAURI__:", !!window.__TAURI__);
    return;
  }
  const invoke = core.invoke;
  const safeInvoke = (cmd, args) => debugInvoke(cmd, args, () => invoke(cmd, args));
  const tauriListen = eventApi?.listen?.bind(eventApi);
  const resolveResource = pathApi?.resolveResource?.bind(pathApi);
  const checkForUpdater = updaterApi?.check?.bind(updaterApi);
  const relaunchApp = processApi?.relaunch?.bind(processApi);
  const UPDATER_ENDPOINT = "https://github.com/blootapp/qooti-releases/releases/latest/download/latest.json";
  diagLog("tauri_api_ready", {
    href: typeof location !== "undefined" ? location.href : "",
    origin: typeof location !== "undefined" ? location.origin : "",
    hasCore: !!core,
    hasWindowApi: !!winApi,
    hasEventApi: !!eventApi,
    hasPathApi: !!pathApi,
    hasUpdaterApi: !!updaterApi,
    hasProcessApi: !!processApi,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
  });
  const updaterState = {
    phase: "idle",
    source: "startup",
    hidden: true,
    endpoint: UPDATER_ENDPOINT,
    currentVersion: null,
    availableVersion: null,
    progressPercent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    statusText: "",
    detailText: "",
    error: null,
    lastTransitionAt: null,
  };
  const updaterHistory = [];
  let currentUpdate = null;
  let activeUpdateCheck = null;
  let activeUpdateDownload = null;
  let activeUpdateInstall = null;
  let currentVersionPromise = null;

  function updaterLog(stage, payload = {}) {
    const entry = {
      at: new Date().toISOString(),
      stage,
      payload,
    };
    updaterHistory.push(entry);
    if (updaterHistory.length > 50) updaterHistory.shift();
    if (typeof console?.log === "function") {
      console.log("[qooti][updater]", stage, payload);
    }
  }

  function emitUpdaterState(patch = {}) {
    Object.assign(updaterState, patch, {
      lastTransitionAt: new Date().toISOString(),
    });
    const detail = { ...updaterState };
    window.dispatchEvent(new CustomEvent("qooti:update-status", { detail }));
    return detail;
  }

  async function closeCurrentUpdateHandle() {
    if (!currentUpdate?.close) {
      currentUpdate = null;
      return;
    }
    try {
      await currentUpdate.close();
    } catch (_) {
      // Ignore close failures; the updater handle is best-effort cleanup only.
    }
    currentUpdate = null;
  }

  async function getCurrentAppVersion() {
    if (!currentVersionPromise) {
      currentVersionPromise = safeInvoke("get_app_info", {})
        .then((info) => info?.version || null)
        .catch(() => null);
    }
    const version = await currentVersionPromise;
    if (version && updaterState.currentVersion !== version) {
      emitUpdaterState({ currentVersion: version });
    }
    return version;
  }

  async function downloadUpdateInBackground({ manual = false } = {}) {
    if (!currentUpdate) {
      throw new Error("No update available to download.");
    }
    if (activeUpdateDownload) {
      if (manual) emitUpdaterState({ hidden: false, source: "manual" });
      return activeUpdateDownload;
    }

    activeUpdateDownload = (async () => {
      let downloaded = 0;
      let totalBytes = 0;
      emitUpdaterState({
        phase: "downloading",
        hidden: !manual,
        source: manual ? "manual" : updaterState.source,
        statusText: `Downloading update ${currentUpdate.version}…`,
        detailText: "",
        error: null,
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
      });
      updaterLog("download_started", {
        endpoint: UPDATER_ENDPOINT,
        currentVersion: currentUpdate.currentVersion,
        availableVersion: currentUpdate.version,
        url: currentUpdate.rawJson?.url || null,
      });

      const onProgress = (event) => {
        if (event.event === "Started") {
          totalBytes = Number(event.data?.contentLength || 0);
          updaterLog("download_progress_started", { totalBytes });
          emitUpdaterState({
            phase: "downloading",
            hidden: !manual && updaterState.source !== "manual",
            detailText: totalBytes > 0 ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : "",
            progressPercent: 0,
            downloadedBytes: 0,
            totalBytes,
          });
          return;
        }
        if (event.event === "Progress") {
          downloaded += Number(event.data?.chunkLength || 0);
          const progressPercent = totalBytes > 0
            ? Math.max(0, Math.min(99, Math.round((downloaded / totalBytes) * 100)))
            : 0;
          emitUpdaterState({
            phase: "downloading",
            hidden: !manual && updaterState.source !== "manual",
            progressPercent,
            downloadedBytes: downloaded,
            totalBytes,
            detailText: totalBytes > 0
              ? `${(downloaded / (1024 * 1024)).toFixed(1)} / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
              : "Preparing package…",
          });
          return;
        }
        updaterLog("download_progress_finished", { downloadedBytes: downloaded, totalBytes });
      };

      const downloadAttemptOptions = [
        {
          timeout: 600000,
          headers: {
            "Accept-Encoding": "identity",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        },
        { timeout: 600000 },
      ];

      let downloadErr = null;
      for (let i = 0; i < downloadAttemptOptions.length; i += 1) {
        try {
          updaterLog("download_attempt", {
            attempt: i + 1,
            timeoutMs: downloadAttemptOptions[i].timeout,
          });
          await currentUpdate.download(onProgress, downloadAttemptOptions[i]);
          downloadErr = null;
          break;
        } catch (e) {
          downloadErr = e;
          const message = e?.message || String(e);
          const retryable =
            i < downloadAttemptOptions.length - 1 &&
            /(decode|decoding|body|timeout|timed out|connection reset|incomplete|eof)/i.test(message);
          updaterLog("download_attempt_failed", {
            attempt: i + 1,
            error: message,
            retrying: retryable,
          });
          if (!retryable) throw e;
          downloaded = 0;
          totalBytes = 0;
          emitUpdaterState({
            phase: "downloading",
            hidden: !manual && updaterState.source !== "manual",
            statusText: `Retrying download for ${currentUpdate.version}…`,
            detailText: "",
            progressPercent: 0,
            downloadedBytes: 0,
            totalBytes: 0,
          });
        }
      }
      if (downloadErr) throw downloadErr;

      updaterLog("download_ready", {
        currentVersion: currentUpdate.currentVersion,
        availableVersion: currentUpdate.version,
        downloadedBytes: downloaded,
        totalBytes,
      });
      return emitUpdaterState({
        phase: "downloaded_ready_to_install",
        hidden: false,
        statusText: `Update ${currentUpdate.version} is ready`,
        detailText: "Restart when you are ready to apply it.",
        progressPercent: 100,
        downloadedBytes: downloaded,
        totalBytes,
        error: null,
      });
    })().catch(async (e) => {
      const message = e?.message || String(e);
      updaterLog("download_failed", {
        currentVersion: currentUpdate?.currentVersion || updaterState.currentVersion,
        availableVersion: currentUpdate?.version || updaterState.availableVersion,
        error: message,
      });
      await closeCurrentUpdateHandle();
      return emitUpdaterState({
        phase: "failed",
        hidden: false,
        statusText: "Update download failed",
        detailText: message,
        error: message,
        availableVersion: null,
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
      });
    }).finally(() => {
      activeUpdateDownload = null;
    });

    return activeUpdateDownload;
  }

  async function installDownloadedUpdate() {
    if (!currentUpdate) {
      throw new Error("No downloaded update is ready to install.");
    }
    if (activeUpdateInstall) return activeUpdateInstall;

    activeUpdateInstall = (async () => {
      emitUpdaterState({
        phase: "installing",
        hidden: false,
        statusText: `Installing update ${currentUpdate.version}…`,
        detailText: "Qooti will restart after installation begins.",
        error: null,
      });
      updaterLog("install_started", {
        currentVersion: currentUpdate.currentVersion,
        availableVersion: currentUpdate.version,
      });
      await currentUpdate.install();
      updaterLog("install_completed", {
        currentVersion: currentUpdate.currentVersion,
        availableVersion: currentUpdate.version,
      });
      return emitUpdaterState({
        phase: "restart_required",
        hidden: false,
        statusText: `Update ${currentUpdate.version} installed`,
        detailText: "Restarting to apply the update…",
        error: null,
      });
    })().catch((e) => {
      const message = e?.message || String(e);
      updaterLog("install_failed", {
        currentVersion: currentUpdate?.currentVersion || updaterState.currentVersion,
        availableVersion: currentUpdate?.version || updaterState.availableVersion,
        error: message,
      });
      emitUpdaterState({
        phase: "failed",
        hidden: false,
        statusText: "Update install failed",
        detailText: message,
        error: message,
      });
      throw e;
    }).finally(() => {
      activeUpdateInstall = null;
    });

    return activeUpdateInstall;
  }

  async function restartToApplyUpdate() {
    if (!relaunchApp) {
      throw new Error("Process API unavailable in this build");
    }
    try {
      await installDownloadedUpdate();
      updaterLog("relaunch_requested", {
        availableVersion: currentUpdate?.version || updaterState.availableVersion,
      });
      emitUpdaterState({
        phase: "restarting",
        hidden: false,
        statusText: `Restarting to apply ${currentUpdate?.version || updaterState.availableVersion || "the update"}…`,
        detailText: "",
        error: null,
      });
      await relaunchApp();
    } catch (e) {
      const message = e?.message || String(e);
      emitUpdaterState({
        phase: "failed",
        hidden: false,
        statusText: "Could not restart to apply update",
        detailText: message,
        error: message,
      });
      throw e;
    }
  }

  async function checkForUpdateMetadata({ manual = false, autoDownload = true } = {}) {
    if (!checkForUpdater) {
      const message = "Updater API unavailable in this build";
      emitUpdaterState({
        phase: manual ? "failed" : "idle",
        hidden: !manual,
        statusText: manual ? "Update check unavailable" : "",
        detailText: manual ? message : "",
        error: message,
      });
      throw new Error(message);
    }

    if (activeUpdateCheck) {
      if (manual) emitUpdaterState({ hidden: false, source: "manual" });
      return activeUpdateCheck;
    }
    if (activeUpdateDownload || activeUpdateInstall) {
      if (manual) emitUpdaterState({ hidden: false, source: "manual" });
      return { ...updaterState };
    }
    if (currentUpdate && ["downloaded_ready_to_install", "restart_required", "restarting"].includes(updaterState.phase)) {
      return emitUpdaterState({ hidden: false, source: manual ? "manual" : updaterState.source });
    }

    activeUpdateCheck = (async () => {
      const currentVersion = await getCurrentAppVersion();
      emitUpdaterState({
        phase: "checking",
        source: manual ? "manual" : "startup",
        hidden: !manual,
        currentVersion,
        availableVersion: null,
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        statusText: manual ? "Checking for updates…" : "",
        detailText: manual && currentVersion ? `Current version ${currentVersion}` : "",
        error: null,
      });
      updaterLog("check_started", {
        endpoint: UPDATER_ENDPOINT,
        currentVersion,
        manual,
      });

      const update = await checkForUpdater({
        timeout: 60000,
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      if (!update) {
        updaterLog("check_no_update", {
          endpoint: UPDATER_ENDPOINT,
          currentVersion,
        });
        await closeCurrentUpdateHandle();
        const detail = emitUpdaterState({
          phase: manual ? "up_to_date" : "idle",
          source: manual ? "manual" : "startup",
          hidden: !manual,
          currentVersion,
          availableVersion: null,
          progressPercent: 0,
          statusText: manual ? "You're up to date." : "",
          detailText: manual && currentVersion ? `Current version ${currentVersion}` : "",
          error: null,
        });
        if (manual) {
          setTimeout(() => {
            if (updaterState.phase === "up_to_date") {
              emitUpdaterState({
                phase: "idle",
                hidden: true,
                statusText: "",
                detailText: "",
              });
            }
          }, 1800);
        }
        return detail;
      }

      currentUpdate = update;
      const detail = emitUpdaterState({
        phase: "update_available",
        source: manual ? "manual" : "startup",
        hidden: !manual,
        currentVersion: update.currentVersion || currentVersion || null,
        availableVersion: update.version || null,
        statusText: `Update ${update.version} is available`,
        detailText: autoDownload ? "Downloading in the background…" : "Ready to download.",
        progressPercent: 0,
        error: null,
      });
      updaterLog("check_update_available", {
        endpoint: UPDATER_ENDPOINT,
        currentVersion: detail.currentVersion,
        availableVersion: detail.availableVersion,
        rawJson: update.rawJson || {},
      });

      if (autoDownload) void downloadUpdateInBackground({ manual });
      return detail;
    })().catch(async (e) => {
      const message = e?.message || String(e);
      updaterLog("check_failed", {
        endpoint: UPDATER_ENDPOINT,
        currentVersion: updaterState.currentVersion,
        error: message,
      });
      await closeCurrentUpdateHandle();
      return emitUpdaterState({
        phase: manual ? "failed" : "idle",
        source: manual ? "manual" : "startup",
        hidden: !manual,
        statusText: manual ? "Update check failed" : "",
        detailText: manual ? message : "",
        error: message,
        availableVersion: null,
        progressPercent: 0,
      });
    }).finally(() => {
      activeUpdateCheck = null;
    });

    return activeUpdateCheck;
  }

  void getCurrentAppVersion();

  // Tauri native file drop — show overlay on enter, hide on leave/drop, handle paths on drop
  try {
    const w = winApi?.getCurrentWindow?.();
    if (w?.onDragDropEvent) {
      w.onDragDropEvent((ev) => {
        const type = ev?.payload?.type;
        if (type === "enter" || type === "over") {
          window.dispatchEvent(new CustomEvent("qooti:file-drag-enter"));
        } else if (type === "leave") {
          window.dispatchEvent(new CustomEvent("qooti:file-drag-leave"));
        } else if (type === "drop" && Array.isArray(ev.payload.paths) && ev.payload.paths.length > 0) {
          window.dispatchEvent(new CustomEvent("qooti:file-drag-leave"));
          window.dispatchEvent(
            new CustomEvent("qooti:file-drop", { detail: { paths: ev.payload.paths } })
          );
        }
      }).catch(() => {});
    }
  } catch (_) {}

  // Telegram import progress (Rust -> frontend custom event bridge)
  if (tauriListen) {
    tauriListen("telegram-import-progress", (ev) => {
      window.dispatchEvent(
        new CustomEvent("qooti:telegram-import-progress", {
          detail: ev?.payload || {},
        })
      );
    }).catch(() => {});
  }

  // Notion ZIP import progress (Rust -> frontend custom event bridge)
  if (tauriListen) {
    tauriListen("notion-import-progress", (ev) => {
      window.dispatchEvent(
        new CustomEvent("qooti:notion-import-progress", {
          detail: ev?.payload || {},
        })
      );
    }).catch(() => {});
  }

  // In production, logo and icons live in bundle resources (not under frontend dist).
  // Resolve resource paths and set img src so they load from the resources folder.
  async function resolveBundleResourceUrl(resourcePath, options = {}) {
    const { logLabel = null, logSuccess = false } = options;
    if (!resolveResource) {
      throw new Error("Tauri path API unavailable");
    }
    const resolved = await resolveResource(resourcePath);
    const url = core.convertFileSrc(resolved);
    if (logSuccess) {
      diagLog("bundle_resource_resolved", {
        label: logLabel || resourcePath,
        resourcePath,
        resolvedPath: resolved,
        url,
      });
    }
    return url;
  }

  (async function applyBundleAssetUrls() {
    try {
      const resourcePrefix = "../assets/";
      document.querySelectorAll("img[data-bundle-resource]").forEach((img) => {
        const rel = img.getAttribute("data-bundle-resource");
        if (!rel) return;
        const resourcePath = resourcePrefix + rel;
        resolveBundleResourceUrl(resourcePath)
          .then((path) => {
            img.src = path;
          })
          .catch((e) => {
            if (typeof console?.warn === "function") {
              console.warn("[qooti] resolveResource failed for", rel, e?.message || e);
            }
          });
      });
    } catch (e) {
      if (typeof console?.warn === "function") {
        console.warn("[qooti] applyBundleAssetUrls", e?.message || e);
      }
    }
  })();

  // Check for app updates once after startup, then download silently in the background.
  setTimeout(() => {
    checkForUpdateMetadata({ manual: false, autoDownload: true }).catch(() => {});
  }, 2500);
  let ocrAssetProbeSummaryLogged = false;

  window.qooti = {
    toLoadableUrl,

    getPathForFile: (file) => {
      if (file?.path) return file.path;
      return null;
    },

    getAppInfo: () => safeInvoke("get_app_info", {}),
    // Rust command signatures expect a top-level `params` argument.
    listInspirations: (params) => safeInvoke("list_inspirations", { params: params || {} }),
    listInspirationsHistory: (params) => safeInvoke("list_inspirations_history", { params: params || {} }),
    listCollections: () => safeInvoke("list_collections", {}),
    fetchFreeCollectionsIndex: () => safeInvoke("fetch_free_collections_index", {}),

    getPreference: (key) => safeInvoke("get_preference", { key }),
    // Rust command signature: set_preference(payload: { key, value })
    setPreference: (key, value) =>
      safeInvoke("set_preference", { payload: { key: String(key), value: String(value) } }),
    getSurveyCompleted: () => safeInvoke("get_survey_completed", {}),
    setSurveyCompleted: () => safeInvoke("set_survey_completed", {}),
    getSurveyData: () => safeInvoke("get_survey_data", {}),
    saveSurveyData: (payload) =>
      safeInvoke("save_survey_data", { payload: payload || {} }),
    clearSurveyData: () => safeInvoke("clear_survey_data", {}),
    getSettings: () => safeInvoke("get_settings", {}),
    getLicenseCache: () => safeInvoke("get_license_cache", {}),
    validateLicense: (licenseKey) => safeInvoke("validate_license", { licenseKey: String(licenseKey || "").trim() }),
    checkCurrentLicenseWithServer: () => safeInvoke("check_current_license_with_server", {}),
    refreshLicenseStatus: () => safeInvoke("refresh_license_status", {}),
    clearLicenseCache: () => safeInvoke("clear_license_cache", {}),
    openFolder: () => safeInvoke("open_folder", {}),
    openExternalUrl: (url) => safeInvoke("open_external_url", { url: String(url || "").trim() }),

    addInspirationsFromFiles: () => safeInvoke("add_inspirations_from_files", {}),
    addInspirationsFromPaths: (paths) => safeInvoke("add_inspirations_from_paths", { paths: paths || [] }),
    importMediaFromPaths: (paths) => safeInvoke("import_media_from_paths", { paths: paths || [] }),
    addImageFromBase64: () => Promise.reject(new Error("Not implemented in Tauri yet: addImageFromBase64")),
    addLinkInspiration: (url, metadata) =>
      safeInvoke("add_link_inspiration", { payload: { url, metadata } }),
    fetchLinkPreview: (url) => safeInvoke("fetch_link_preview", { url }),
    fetchNotionGallery: (url) => safeInvoke("fetch_notion_gallery", { url }),
    selectNotionExportZip: () => safeInvoke("select_notion_export_zip", {}),
    inspectNotionExportZip: (zipPath) => safeInvoke("inspect_notion_export_zip", { zipPath }),
    importNotionExportZip: (zipPath, options) =>
      safeInvoke("import_notion_export_zip", {
        payload: {
          zipPath,
          saveAsCollection: options?.saveAsCollection !== false,
          collectionName: options?.collectionName || null,
        },
      }),
    addMediaFromUrl: (url, title) =>
      safeInvoke("add_media_from_url", { payload: { url, title } }),
    addThumbnailFromUrl: (thumbnailUrl, title) =>
      safeInvoke("add_thumbnail_from_url", { payload: { thumbnailUrl, title } }),
    addThumbnailFromVideoUrl: (videoUrl, title) =>
      safeInvoke("add_thumbnail_from_video_url", { videoUrl, title }),
    downloadVideoFromUrl: (url, title) =>
      safeInvoke("download_video_from_url", { url, title }),
    setVideoDownloadPaused: (paused) => safeInvoke("set_video_download_paused", { paused: !!paused }),
    cancelVideoDownload: () => safeInvoke("cancel_video_download", {}),
    updateInspiration: (id, updates) =>
      safeInvoke("update_inspiration", { payload: { id, updates } }),
    deleteInspiration: (id) => safeInvoke("delete_inspiration", { id }),
    clearAllMedia: () => safeInvoke("clear_all_media", {}),
    listTags: () => safeInvoke("list_tags", {}),
    getTopTags: (limit) => safeInvoke("get_top_tags", { limit: limit ?? 10 }),
    getTagCountStatus: () => safeInvoke("get_tag_count_status"),
    ensureTagCountsInitialized: () => safeInvoke("ensure_tag_counts_initialized"),
    submitFeedback: (payload) => safeInvoke("submit_feedback", { payload: payload || {} }),
    createUserTag: (label, type) =>
      safeInvoke("create_user_tag", { label, tagType: type || "style" }),
    renameTag: (tagId, newLabel) => safeInvoke("rename_tag", { tagId, newLabel }),
    attachTagToInspiration: (inspirationId, tagId) =>
      safeInvoke("attach_tag_to_inspiration", { inspirationId, tagId }),
    detachTagFromInspiration: (inspirationId, tagId) =>
      safeInvoke("detach_tag_from_inspiration", { inspirationId, tagId }),
    extractPalette: (inspirationId) => safeInvoke("extract_palette", { inspirationId }),
    extractOcrText: (inspirationId) => safeInvoke("extract_ocr_text", { inspirationId }),
    claimOcrIndexCandidates: (limit = 2) => safeInvoke("claim_ocr_index_candidates", { limit }),
    readImageAsBase64: (path) => safeInvoke("read_image_as_base64", { path }),
    finalizeOcrIndexResult: (
      inspirationId,
      text,
      failed = false,
      stage = "",
      errorCode = "",
      errorMessage = ""
    ) =>
      safeInvoke("finalize_ocr_index_result", {
        inspirationId,
        text,
        failed,
        stage,
        errorCode,
        errorMessage,
      }),
    resetOcrStatusForInspiration: (inspirationId) =>
      safeInvoke("reset_ocr_status_for_inspiration", { inspirationId }),
    queueFullOcrReindex: () => safeInvoke("queue_full_ocr_reindex", {}),
    getOcrIndexStats: () => safeInvoke("get_ocr_index_stats", {}),
    getInspirationOcrDebug: (inspirationId, forceRefresh = false) =>
      safeInvoke("get_inspiration_ocr_debug", { inspirationId, forceRefresh }),
    findSimilar: (inspirationId, limit) =>
      safeInvoke("find_similar", { inspirationId, limit }),
    copyFileToClipboard: (relPath) => safeInvoke("copy_file_to_clipboard", { relPath }),
    copyTextToClipboard: (text) => safeInvoke("copy_text_to_clipboard", { text: String(text || "") }),
    async resolveOcrAssets() {
      const pageHref = typeof location !== "undefined" ? location.href : "";
      const webBase = pageHref ? new URL("assets/ocr/", pageHref).toString() : "assets/ocr/";
      const REQUIRED_OCR_KEYS = [
        "workerUrl",
        "ortScriptUrl",
        "ortThreadedMjsUrl",
        "ortThreadedWasmUrl",
        "engineUrl",
        "detectionPath",
        "recognitionPath",
        "dictionaryPath",
      ];
      const makeWebConfig = () => {
        const ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
        const isMacAppleWebKit = /Macintosh|Mac OS X/i.test(ua) && /AppleWebKit/i.test(ua);
        return {
        base: webBase,
        workerUrl: `${webBase}ocr-index-worker.js`,
        ortScriptUrl: `${webBase}ort.wasm.min.js`,
        ortThreadedMjsUrl: `${webBase}ort-wasm-simd-threaded.mjs`,
        ortThreadedWasmUrl: `${webBase}ort-wasm-simd-threaded.wasm`,
        ortWasmPathsMap: {
          mjs: `${webBase}ort-wasm-simd-threaded.mjs`,
          wasm: `${webBase}ort-wasm-simd-threaded.wasm`,
        },
        engineUrl: `${webBase}ocr-engine.js`,
        detectionPath: `${webBase}models/ch_PP-OCRv4_det_infer.onnx`,
        recognitionPath: `${webBase}models/ch_PP-OCRv4_rec_infer.onnx`,
        dictionaryPath: `${webBase}models/ppocr_keys_v1.txt`,
        wasmBase: webBase,
        source: "web",
        // macOS WebKit worker contexts may not expose `Image` reliably.
        // Prefer main-thread OCR there to avoid `Can't find variable: Image`.
        preferMainThread: isMacAppleWebKit,
      };
      };

      const probeAssetUrl = async (url) => {
        try {
          const resp = await fetch(url, { method: "GET", cache: "no-store" });
          const contentLength = Number(resp?.headers?.get?.("content-length") || 0);
          return {
            ok: !!resp?.ok,
            status: Number(resp?.status || 0),
            contentLength,
          };
        } catch (_) {
          return {
            ok: false,
            status: 0,
            contentLength: 0,
          };
        }
      };

      const probeConfig = async (config) => {
        const probe = {};
        for (const key of REQUIRED_OCR_KEYS) {
          probe[key] = await probeAssetUrl(config[key]);
        }
        return probe;
      };

      const allRequiredOk = (probe) => REQUIRED_OCR_KEYS.every((key) => !!probe?.[key]?.ok);

      const logProbeSummary = (payload) => {
        if (ocrAssetProbeSummaryLogged) return;
        ocrAssetProbeSummaryLogged = true;
        diagLog("ocr_assets_probe_summary", payload);
      };

      // Always prefer same-origin OCR assets from frontendDist.
      // This avoids cross-origin `asset.localhost` loading issues in packaged builds.
      const webConfig = makeWebConfig();
      const webProbe = await probeConfig(webConfig);
      if (allRequiredOk(webProbe)) {
        logProbeSummary({
          chosenSource: "web",
          webProbe,
          bundleProbe: null,
          pageOrigin: typeof location !== "undefined" ? location.origin : "",
        });
        diagLog("ocr_assets_resolved", {
          source: webConfig.source,
          preferMainThread: webConfig.preferMainThread,
          workerUrl: webConfig.workerUrl,
          engineUrl: webConfig.engineUrl,
          detectionPath: webConfig.detectionPath,
          probe: webProbe,
        });
        return webConfig;
      }
      diagWarn("ocr_assets_web_probe_failed", {
        source: webConfig.source,
        workerUrl: webConfig.workerUrl,
        ortScriptUrl: webConfig.ortScriptUrl,
        engineUrl: webConfig.engineUrl,
        probe: webProbe,
      });
      // Packaged OCR proved unstable with asset.localhost cross-origin module loading.
      // Force same-origin web paths even when probes fail so we avoid bundle-resource URLs.
      logProbeSummary({
        chosenSource: "web_forced_after_probe_failure",
        webProbe,
        bundleProbe: null,
        pageOrigin: typeof location !== "undefined" ? location.origin : "",
      });
      return webConfig;
    },
    getAbsolutePathForFile: (relPath) => safeInvoke("get_absolute_path_for_file", { relPath }),
    getExtensionConnectionStatus: () => safeInvoke("get_extension_connection_status", {}),
    getExtensionKeyForCopy: () => safeInvoke("get_extension_key_for_copy", {}),
    regenerateExtensionKey: () => safeInvoke("regenerate_extension_key", {}),
    getExtensionPending: () => safeInvoke("get_extension_pending", {}),
    startDragFile: (storedPath, iconPath) => safeInvoke("get_absolute_path_for_file", { relPath: storedPath }),
    openFileExternal: () => Promise.reject(new Error("Not implemented in Tauri yet")),

    createCollection: (name) => safeInvoke("create_collection", { name }),
    renameCollection: (id, newName) => safeInvoke("rename_collection", { collectionId: id, newName: newName }),
    deleteCollection: (id) => safeInvoke("delete_collection", { collectionId: id }),
    setCollectionVisibleOnHome: (collectionId, visible) =>
      safeInvoke("set_collection_visible_on_home", { collectionId, visible: !!visible }),
    setCollectionProfileImage: (collectionId, profileImageDataUrl) =>
      safeInvoke("set_collection_profile_image", { collectionId, profileImageDataUrl: profileImageDataUrl || null }),
    addToCollection: (collectionId, inspirationIds) =>
      safeInvoke("add_to_collection", { collectionId, inspirationIds }),
    removeFromCollection: (collectionId, inspirationId) =>
      safeInvoke("remove_from_collection", { collectionId, inspirationId }),
    getCollectionsForInspiration: (inspirationId) =>
      safeInvoke("get_collections_for_inspiration", { inspirationId }),
    exportCollectionAsPack: (collectionId, packName, profileImageDataUrl) =>
      safeInvoke("export_collection_as_pack", {
        collectionId,
        packName,
        profileImageDataUrl: profileImageDataUrl || null,
      }),
    selectCollectionPackFile: () => safeInvoke("select_collection_pack_file", {}),
    inspectCollectionPack: (packPath) =>
      safeInvoke("inspect_collection_pack", { packPath }),
    importCollectionPack: (packPath) =>
      safeInvoke("import_collection_pack", packPath ? { packPath } : {}),
    downloadAndImportCollection: (collectionId, downloadUrl) =>
      safeInvoke("download_and_import_collection", {
        collectionId,
        downloadUrl,
      }),
    selectTelegramExportFolder: () => safeInvoke("select_telegram_export_folder", {}),
    inspectTelegramExport: (folderPath) => safeInvoke("inspect_telegram_export", { folderPath }),
    importTelegramExport: (payload) => safeInvoke("import_telegram_export", { payload: payload || {} }),
    listNotifications: (params) => safeInvoke("list_notifications", { params: params || {} }),
    getUnreadNotificationCount: () => safeInvoke("get_unread_notification_count", {}),
    markNotificationsRead: (ids) => safeInvoke("mark_notifications_read", { ids: Array.isArray(ids) ? ids : null }),
    createAdminNotification: (payload) => safeInvoke("create_admin_notification", { payload: payload || {} }),

    exportBackup: () => Promise.reject(new Error("Not implemented in Tauri yet")),
    importBackup: () => Promise.reject(new Error("Not implemented in Tauri yet")),

    windowMinimize: () => {
      winApi?.getCurrentWindow?.()?.minimize?.()?.catch?.((e) => console.error("windowMinimize", e));
    },
    windowMaximize: async () => {
      try {
        const w = winApi?.getCurrentWindow?.();
        if (!w) return;
        const maximized = await w.isMaximized();
        if (maximized) await w.unmaximize();
        else await w.maximize();
      } catch (e) {
        console.error("windowMaximize", e);
      }
    },
    windowClose: () => {
      winApi?.getCurrentWindow?.()?.close?.()?.catch?.((e) => console.error("windowClose", e));
    },
    windowHide: () => safeInvoke("window_hide", {}),
    windowQuit: () => safeInvoke("window_quit", {}),
    openDevtools: () => safeInvoke("open_devtools", {}),

    /** Check for app updates (used by Settings -> Check for updates button). */
    checkForUpdates: (options = {}) =>
      checkForUpdateMetadata({ manual: true, autoDownload: false, ...options }),
    downloadUpdate: () => downloadUpdateInBackground({ manual: true }),
    installDownloadedUpdate: () => installDownloadedUpdate(),
    restartToApplyUpdate: () => restartToApplyUpdate(),
    dismissUpdatePrompt() {
      updaterLog("prompt_dismissed", {
        phase: updaterState.phase,
        availableVersion: updaterState.availableVersion,
      });
      return emitUpdaterState({ hidden: true });
    },
    getUpdaterState: () => ({ ...updaterState }),
    getUpdaterDebugInfo: () => ({
      state: { ...updaterState },
      history: updaterHistory.slice(),
    }),

    onThumbnailUpdated: () => () => {},
    onVaultReplaced: () => () => {},
    onDownloadProgress: (handler) => {
      if (typeof handler !== "function" || !tauriListen) return () => {};
      const promise = tauriListen("video-download-progress", (ev) => {
        const payload = ev?.payload;
        const raw = typeof payload === "number" ? payload : payload?.percent;
        const pct = Number(raw);
        if (Number.isFinite(pct)) handler(pct);
      });
      return () => {
        promise
          .then((unlisten) => {
            if (typeof unlisten === "function") unlisten();
          })
          .catch(() => {});
      };
    },

    /** Subscribe to .qooti pack export progress. Handler receives `{ percent, message }`. */
    onCollectionPackExportProgress: (handler) => {
      if (typeof handler !== "function" || !tauriListen) return () => {};
      const promise = tauriListen("collection-pack-export-progress", (ev) => {
        handler(ev?.payload || {});
      });
      return () => {
        promise
          .then((unlisten) => {
            if (typeof unlisten === "function") unlisten();
          })
          .catch(() => {});
      };
    },
    onCollectionProgress: (handler) => {
      if (typeof handler !== "function" || !tauriListen) return () => {};
      const promise = tauriListen("collection_progress", (ev) => {
        handler(ev?.payload || {});
      });
      return () => {
        promise
          .then((unlisten) => {
            if (typeof unlisten === "function") unlisten();
          })
          .catch(() => {});
      };
    },

    /** Call from console (F12): qooti.debug() to see status and run checks */
    async debug() {
      console.group("[qooti] debug diagnostics");
      console.log("__TAURI__:", !!window.__TAURI__);
      console.log("__TAURI__.core:", !!window.__TAURI__?.core);
      console.log("__TAURI__.window:", !!window.__TAURI__?.window);
      console.log("__TAURI__.updater:", !!window.__TAURI__?.updater);
      console.log("updater endpoint:", UPDATER_ENDPOINT);
      console.log("location.href:", location?.href);
      console.log("location.origin:", location?.origin);
      try {
        const info = await this.getAppInfo();
        console.log("getAppInfo:", info);
      } catch (e) {
        console.error("getAppInfo FAIL:", e?.message || e);
      }
      try {
        const list = await this.listInspirations({});
        console.log("listInspirations count:", Array.isArray(list) ? list.length : list);
        if (Array.isArray(list) && list.length > 0) {
          const first = list[0];
          console.log("first item:", {
            id: first?.id,
            type: first?.type,
            stored_path: first?.stored_path,
            stored_path_url: first?.stored_path_url?.slice?.(0, 80),
            thumbnail_path: first?.thumbnail_path,
            thumbnail_path_url: first?.thumbnail_path_url?.slice?.(0, 80),
          });
          const loadable = this.toLoadableUrl(first?.stored_path_url, first?.stored_path);
          console.log("toLoadableUrl(first):", loadable || "(empty)");
        }
      } catch (e) {
        console.error("listInspirations FAIL:", e?.message || e);
      }
      console.log("updater state:", this.getUpdaterState());
      console.log("updater history:", this.getUpdaterDebugInfo()?.history || []);
      console.log("Implemented: getAppInfo, listInspirations, addLinkInspiration, fetchLinkPreview, window*");
      console.log("Implemented: delete, update, download, addFromPaths, addFromFiles, addThumbnail. yt-dlp bundled for video download.");
      console.groupEnd();
    },
  };
}
