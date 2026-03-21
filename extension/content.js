/**
 * Qooti Chrome Extension — Content Script
 * Media detection, context menu, and hover overlay (Add to Qooti button).
 */

(function () {
  const DEFAULT_MIN_SIZE = 200;
  const PLATFORM_HOSTS = {
    youtube: ["youtube.com", "youtu.be"],
    instagram: ["instagram.com"],
    tiktok: ["tiktok.com"],
    pinterest: ["pinterest.com", "pinterest."],
  };

  function getPlatform() {
    const host = window.location.hostname.toLowerCase();
    for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
      if (hosts.some((h) => host.includes(h))) return platform;
    }
    return "generic";
  }

  function getPlatformConfig(platform) {
    if (platform === "youtube") {
      return { allowLink: true, allowThumbnail: true, minSize: 120 };
    }
    if (platform === "instagram") {
      return { allowLink: true, allowThumbnail: false, minSize: 80 };
    }
    if (platform === "pinterest") {
      return { allowLink: false, allowThumbnail: false, minSize: 80 };
    }
    if (platform === "tiktok") {
      return { allowLink: true, allowThumbnail: false, minSize: 100 };
    }
    return { allowLink: true, allowThumbnail: false, minSize: DEFAULT_MIN_SIZE };
  }

  function toAbsoluteUrl(href) {
    if (!href) return "";
    try { return new URL(href, window.location.href).toString(); } catch (_) { return ""; }
  }

  function isYouTubeWatchUrl(url) {
    try {
      const u = new URL(url);
      if (!/youtube\.com$|youtu\.be$/i.test(u.hostname)) return false;
      return (u.pathname === "/watch" && !!u.searchParams.get("v")) || u.pathname.startsWith("/shorts/") || u.hostname === "youtu.be";
    } catch (_) {
      return false;
    }
  }

  function getYouTubeUrlFromContext(el) {
    const current = window.location.href;
    if (isYouTubeWatchUrl(current)) return current;
    const anchor = el && el.closest ? el.closest('a[href*="watch"],a[href*="/shorts/"],a[href*="youtu.be"]') : null;
    const href = toAbsoluteUrl(anchor ? anchor.getAttribute("href") : "");
    if (isYouTubeWatchUrl(href)) return href;
    return "";
  }

  function getYouTubeVideoId(url) {
    try {
      const u = new URL(url || "");
      if (u.pathname === "/watch") return u.searchParams.get("v") || "";
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || "";
      if (u.hostname === "youtu.be") return u.pathname.replace(/^\/+/, "");
    } catch (_) {}
    return "";
  }

  function getStableHoverContainer(el, platform) {
    if (!el || !el.closest) return el;
    if (platform === "youtube") {
      return (
        el.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytd-rich-grid-media, ytd-thumbnail, a#thumbnail") ||
        el
      );
    }
    if (platform === "instagram") {
      return el.closest("article, [role='presentation'], a") || el;
    }
    if (platform === "pinterest") {
      return el.closest("[data-test-id], a, div") || el;
    }
    return el.closest("a, article, div") || el;
  }

  function isValidSendUrl(url, platform) {
    if (!url) return false;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (platform === "youtube") {
        if (u.hostname === "www.youtube.com" && (u.pathname === "/" || u.pathname === "")) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function isLikelyDecorative(el) {
    if (!el || !el.getBoundingClientRect) return true;
    const platform = getPlatform();
    const minSize = getPlatformConfig(platform).minSize;
    const rect = el.getBoundingClientRect();
    if (rect.width < minSize || rect.height < minSize) {
      // Instagram/Pinterest often render media smaller than desktop cards.
      if (!(platform === "instagram" || platform === "pinterest")) return true;
    }
    const style = window.getComputedStyle(el);
    const bg = (style.backgroundImage || "").toLowerCase();
    if (bg && bg !== "none" && (el.tagName === "IMG" || el.tagName === "VIDEO")) return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "img" && el.tagName !== "IMG") return false;
    const alt = (el.getAttribute("alt") || "").toLowerCase();
    if (alt && (alt.includes("emoji") || alt.includes("icon") || alt.length < 2)) return true;
    return false;
  }

  function getMediaInfo(target) {
    if (!target) return null;
    const tag = target.tagName?.toUpperCase();
    if (tag === "IMG") {
      const src = target.currentSrc || target.src || (target.getAttribute && target.getAttribute("data-src"));
      if (!src) return null;
      if (isLikelyDecorative(target)) return null;
      return { type: "image", url: src, element: target };
    }
    if (tag === "VIDEO") {
      const src = target.currentSrc || target.src || (target.querySelector("source")?.src);
      if (!src) return null;
      if (isLikelyDecorative(target)) return null;
      return { type: "video", url: src, element: target };
    }
    return null;
  }

  /** On Pinterest (and similar), resolve image/video URL from container when direct target has no usable URL.
   * Prefer the largest image to avoid picking profile avatars (which appear first in DOM but are small). */
  function getMediaUrlFromContainer(container, platform) {
    if (!container || !container.querySelector) return "";
    if (platform !== "pinterest" && platform !== "generic") return "";
    var imgs = container.querySelectorAll("img");
    var best = null;
    var bestArea = 0;
    var minSize = getPlatformConfig("pinterest").minSize || 80;
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var u = img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-orig-src");
      if (!u || typeof u !== "string" || (!u.startsWith("http://") && !u.startsWith("https://"))) continue;
      var rect = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 0, height: 0 };
      if (rect.width < minSize || rect.height < minSize) continue;
      var area = rect.width * rect.height;
      if (area > bestArea) { bestArea = area; best = u; }
    }
    if (best) return best;
    var video = container.querySelector("video");
    if (video) {
      var v = video.currentSrc || video.src;
      if (video.querySelector) {
        var s = video.querySelector("source");
        if (s && (s.src || s.getAttribute("src"))) v = v || s.src || s.getAttribute("src");
      }
      if (v && typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://"))) return v;
    }
    return "";
  }

  function getBestPinterestFallbackUrl() {
    var fromContainer = getMediaUrlFromContainer(currentAnchorEl, "pinterest");
    if (fromContainer && isValidSendUrl(fromContainer, "pinterest")) return fromContainer;
    var candidates = document.querySelectorAll('img[src*="pinimg.com"], img[data-src*="pinimg.com"]');
    var best = null;
    var bestArea = 0;
    var minSize = getPlatformConfig("pinterest").minSize || 80;
    for (var i = 0; i < candidates.length; i++) {
      var img = candidates[i];
      var u = img.currentSrc || img.src || img.getAttribute("data-src");
      if (!u || !isValidSendUrl(u, "pinterest")) continue;
      var rect = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 0, height: 0 };
      if (rect.width < minSize || rect.height < minSize) continue;
      var area = rect.width * rect.height;
      if (area > bestArea) { bestArea = area; best = u; }
    }
    return best || "";
  }

  document.addEventListener("contextmenu", (e) => {
    const mediaEl = resolveMediaTarget(e) || e.target;
    const info = getMediaInfo(mediaEl);
    if (info) {
      try {
        mediaEl.setAttribute("data-qooti-media", "1");
      } catch (_) {}
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_PLATFORM") {
      sendResponse({ platform: getPlatform() });
    } else if (msg.type === "GET_MEDIA_UNDER_CURSOR") {
      const el = document.elementFromPoint(msg.x ?? 0, msg.y ?? 0);
      const info = getMediaInfo(el);
      sendResponse(info ? { ...info, platform: getPlatform() } : null);
    } else {
      sendResponse(null);
    }
    return true;
  });

  // --- Hover overlay: show "Add to Qooti" when hovering valid media (if display mode allows)
  let overlayEl = null;
  let hideTimeout = null;
  let currentMediaEl = null;
  let currentAnchorEl = null;
  let currentVideoKey = "";
  let overlayObserver = null;
  let wakePingSent = false;

  // Qooti accent (soft blue)
  const QOOTI_ACCENT = "#3b82f6";

  // App icon (PNG), injected by scripts/inject-icon.js
  const ADD_ICON_SVG = "data:image/png;base64,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";

  var menuHideTimeout = null;

  function injectOverlayStyles() {
    if (document.getElementById("qooti-overlay-styles")) return;
    var style = document.createElement("style");
    style.id = "qooti-overlay-styles";
    style.textContent =
      "#qooti-hover-overlay{position:fixed;z-index:2147483647;pointer-events:none;opacity:0;transform:scale(0.98);transform-origin:top right;transition:opacity 0.12s ease-out,transform 0.12s ease-out;}" +
      "#qooti-hover-overlay.qooti-overlay--visible{opacity:1;transform:scale(1);}" +
      "#qooti-hover-overlay .qooti-overlay-wrap{position:relative;display:inline-flex;flex-direction:column;align-items:flex-end;}" +
      "#qooti-hover-overlay .qooti-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:12px;font-family:system-ui,-apple-system,sans-serif;color:rgba(255,255,255,0.96);background:rgba(28,28,35,0.94);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,0.14);border-radius:999px;cursor:pointer;white-space:nowrap;transition:background 0.12s ease-out,border-color 0.12s ease-out,box-shadow 0.12s ease-out,transform 0.12s ease-out;box-shadow:0 0 0 1px rgba(0,0,0,0.35),0 2px 8px rgba(0,0,0,0.2),0 6px 20px rgba(0,0,0,0.18);}" +
      "#qooti-hover-overlay .qooti-pill:hover{background:rgba(38,38,46,0.96);border-color:rgba(255,255,255,0.22);box-shadow:0 0 0 1px rgba(0,0,0,0.4),0 4px 12px rgba(0,0,0,0.25),0 8px 24px rgba(0,0,0,0.2);}" +
      "#qooti-hover-overlay .qooti-icon{display:block;width:16px;height:16px;object-fit:contain;flex-shrink:0;opacity:0.96;}" +
      "#qooti-hover-overlay .qooti-pill .qooti-icon{width:14px;height:14px;}" +
      "#qooti-hover-overlay .qooti-bridge{height:10px;width:100%;min-width:100%;pointer-events:auto;flex-shrink:0;}" +
      "#qooti-hover-overlay .qooti-popover{position:absolute;top:100%;right:0;margin-top:0;min-width:100%;padding:6px;background:rgba(30,30,35,0.85);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.08);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);opacity:0;visibility:hidden;pointer-events:none;transform:scale(0.96);transform-origin:top right;transition:opacity 0.12s ease-out,visibility 0.12s ease-out,transform 0.12s ease-out;display:flex;flex-direction:column;gap:2px;}" +
      "#qooti-hover-overlay .qooti-popover.qooti-popover--open{opacity:1;visibility:visible;transform:scale(1);pointer-events:auto !important;}" +
      "#qooti-hover-overlay .qooti-action{pointer-events:auto !important;display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;font-family:system-ui,-apple-system,sans-serif;color:rgba(255,255,255,0.9);background:transparent;border:none;border-radius:8px;cursor:pointer;text-align:left;white-space:nowrap;transition:background 0.12s ease-out;width:100%;}" +
      "#qooti-hover-overlay .qooti-action:hover{background:rgba(255,255,255,0.06);}" +
      "#qooti-hover-overlay .qooti-action--primary:hover{background:rgba(59,130,246,0.18);color:#fff;}" +
      "#qooti-hover-overlay .qooti-action .qooti-icon{width:16px;height:16px;}" +
      "#qooti-hover-overlay .qooti-icon{filter:brightness(0) invert(1);}" +
      "#qooti-hover-overlay .qooti-icon--logo{width:20px;height:20px;filter:none;}" +
      "#qooti-hover-overlay .qooti-pill--icon-only{width:36px;height:36px;padding:0;min-width:36px;min-height:36px;box-sizing:border-box;justify-content:center;}" +
      "#qooti-hover-overlay .qooti-action-divider{height:1px;background:rgba(255,255,255,0.08);margin:4px 0;pointer-events:none;}" +
      "#qooti-hover-overlay.qooti-overlay--top-left .qooti-overlay-wrap{align-items:flex-start;}" +
      "#qooti-hover-overlay.qooti-overlay--top-left .qooti-popover{left:0;right:auto;}" +
      "#qooti-hover-overlay.qooti-overlay--bottom-right .qooti-overlay-wrap{align-items:flex-end;}" +
      "#qooti-hover-overlay.qooti-overlay--bottom-right .qooti-popover{top:auto;bottom:100%;margin-top:0;margin-bottom:4px;transform-origin:bottom right;}" +
      "#qooti-hover-overlay.qooti-overlay--bottom-right .qooti-popover.qooti-popover--open{transform:scale(1);}" +
      "#qooti-hover-overlay.qooti-overlay--bottom-left .qooti-overlay-wrap{align-items:flex-start;}" +
      "#qooti-hover-overlay.qooti-overlay--bottom-left .qooti-popover{top:auto;bottom:100%;left:0;right:auto;margin-top:0;margin-bottom:4px;transform-origin:bottom left;}" +
      "#qooti-hover-overlay.qooti-overlay--bottom-left .qooti-popover.qooti-popover--open{transform:scale(1);}";
    document.head.appendChild(style);
  }

  var cachedPopupPosition = "top-right";

  function applyOverlayPosition(ov, rect, corner, pad, pillW, wrapH) {
    ov.classList.remove("qooti-overlay--top-right", "qooti-overlay--top-left", "qooti-overlay--bottom-right", "qooti-overlay--bottom-left");
    ov.classList.add("qooti-overlay--" + corner);
    var origin = corner.replace("-", " ");
    ov.style.transformOrigin = origin;
    if (corner === "top-right") {
      ov.style.left = (rect.right - pillW - pad) + "px";
      ov.style.top = (rect.top + pad) + "px";
    } else if (corner === "top-left") {
      ov.style.left = (rect.left + pad) + "px";
      ov.style.top = (rect.top + pad) + "px";
    } else if (corner === "bottom-right") {
      ov.style.left = (rect.right - pillW - pad) + "px";
      ov.style.top = (rect.bottom - (wrapH || 0) - pad) + "px";
    } else {
      ov.style.left = (rect.left + pad) + "px";
      ov.style.top = (rect.bottom - (wrapH || 0) - pad) + "px";
    }
  }

  function remixIconTag(file) {
    var url = chrome.runtime.getURL("icons/remix/" + file);
    return '<img class="qooti-icon" src="' + url + '" alt="" aria-hidden="true" />';
  }

  function extensionLogoImg() {
    var url = chrome.runtime.getURL("icons/icon.png");
    var fallback = logoFallbackSvg();
    return '<img class="qooti-icon qooti-icon--logo" src="' + url + '" data-qooti-logo-fallback="' + fallback + '" alt="Add to Qooti" aria-hidden="true" />';
  }

  var iconDownload = remixIconTag("download-2-line.svg");
  var iconImage = remixIconTag("image-line.svg");
  var iconLink = remixIconTag("link-m.svg");

  function logoFallbackSvg() {
    return "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
    );
  }

  function getOverlay() {
    if (overlayEl) return overlayEl;
    injectOverlayStyles();
    overlayEl = document.createElement("div");
    overlayEl.id = "qooti-hover-overlay";
    overlayEl.innerHTML =
      '<div class="qooti-overlay-wrap">' +
        '<button type="button" class="qooti-pill qooti-pill--icon-only" data-action="add" title="Add to Qooti">' +
          extensionLogoImg() +
        '</button>' +
        '<div class="qooti-bridge" aria-hidden="true"></div>' +
        '<div class="qooti-popover">' +
          '<button type="button" class="qooti-action qooti-action--primary" data-action="download">' + iconDownload + ' Add to Qooti</button>' +
          '<div class="qooti-action-divider"></div>' +
          '<button type="button" class="qooti-action qooti-menu-thumb" data-action="thumbnail">' + iconImage + ' Download thumbnail</button>' +
          '<button type="button" class="qooti-action" data-action="link">' + iconLink + ' Add as link</button>' +
        '</div>' +
      '</div>';
    var wrap = overlayEl.querySelector(".qooti-overlay-wrap");
    var pill = overlayEl.querySelector(".qooti-pill");
    var popover = overlayEl.querySelector(".qooti-popover");
    var logoImg = pill && pill.querySelector(".qooti-icon--logo");
    if (logoImg) {
      var fallback = logoImg.getAttribute("data-qooti-logo-fallback");
      if (fallback) {
        logoImg.addEventListener("error", function onLogoError() {
          logoImg.onerror = null;
          logoImg.src = fallback;
          logoImg.removeAttribute("data-qooti-logo-fallback");
        });
      }
    }

    wrap.addEventListener("mouseenter", function () {
      if (menuHideTimeout) { clearTimeout(menuHideTimeout); menuHideTimeout = null; }
      popover.classList.add("qooti-popover--open");
    });
    wrap.addEventListener("mouseleave", function () {
      menuHideTimeout = setTimeout(function () {
        menuHideTimeout = null;
        popover.classList.remove("qooti-popover--open");
      }, 220);
    });
    pill.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      sendAddAction("add");
      hideOverlay();
    });
    overlayEl.querySelectorAll(".qooti-action").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var action = btn.getAttribute("data-action");
        if (action) sendAddAction(action);
        hideOverlay();
      }, true);
    });

    document.body.appendChild(overlayEl);
    chrome.runtime.sendMessage({ type: "QOOTI_PING" }, function () { if (chrome.runtime.lastError) {} });
    return overlayEl;
  }

  function getEffectiveUrl(info, action, platform) {
    var pageUrl = window.location.href;
    if (!info) {
      if (platform === "pinterest" && currentAnchorEl) {
        var fallback = getMediaUrlFromContainer(currentAnchorEl, platform);
        if (fallback) return { url: fallback, mediaType: "image" };
      }
      return { url: "", mediaType: "link" };
    }
    if (platform === "youtube" && (action === "link" || action === "download" || action === "add")) {
      var ytUrl = getYouTubeUrlFromContext(currentMediaEl || info.element || null);
      return { url: ytUrl, mediaType: "video" };
    }
    if (platform === "pinterest") {
      var url = (info.url || "").trim();
      if (!url || !isValidSendUrl(url, platform)) {
        var fromContainer = getMediaUrlFromContainer(currentAnchorEl, platform);
        if (fromContainer) url = fromContainer;
      }
      return { url: url, mediaType: info.type || "image" };
    }
    if ((action === "link" || action === "download") && (platform === "instagram" || platform === "tiktok")) {
      var link = currentMediaEl && currentMediaEl.closest ? currentMediaEl.closest("a[href]") : null;
      var href = toAbsoluteUrl(link ? link.getAttribute("href") : "");
      if (href) return { url: href, mediaType: info.type };
      return { url: pageUrl, mediaType: info.type };
    }
    return { url: info.url, mediaType: info.type };
  }

  function buildPayloadForPlatform(action, platform, info) {
    var payloadAction = action === "link" ? "link" : action === "download" ? "download" : action === "thumbnail" ? "thumbnail" : "add";
    var effective = getEffectiveUrl(info, payloadAction, platform);
    if (!getPlatformConfig(platform).allowLink && payloadAction === "link") {
      return null;
    }
    if (!isValidSendUrl(effective.url, platform)) {
      return null;
    }
    return {
      type: "QOOTI_ADD_MEDIA",
      url: effective.url,
      mediaType: effective.mediaType,
      pageUrl: window.location.href,
      pageTitle: document.title,
      action: payloadAction,
      platform: platform,
    };
  }

  function sendAddAction(action) {
    var platform = getPlatform();
    var info = currentMediaEl ? getMediaInfo(currentMediaEl) : null;
    var payload = buildPayloadForPlatform(action, platform, info);
    if (!payload && platform === "pinterest" && action !== "link") {
      var fallbackUrl = getBestPinterestFallbackUrl();
      if (fallbackUrl) {
        payload = {
          type: "QOOTI_ADD_MEDIA",
          url: fallbackUrl,
          mediaType: "image",
          pageUrl: window.location.href,
          pageTitle: document.title,
          action: action === "thumbnail" ? "thumbnail" : action === "download" ? "download" : "add",
          platform: platform,
        };
      }
    }
    if (!payload) {
      console.warn("[Qooti] Invalid or unsupported URL/action; skipping send:", { platform: platform, action: action });
      return;
    }
    function sendDirectToDesktop(rawPayload) {
      chrome.storage.local.get(["desktopUrl", "connectionKey"], function (o) {
        var key = ((o && o.connectionKey) || "").trim();
        var base = (((o && o.desktopUrl) || "http://127.0.0.1:1420") + "").replace(/\/+$/, "");
        if (!key) {
          console.error("[Qooti] Direct send failed: missing connection key");
          return;
        }
        fetch(base + "/qooti/add", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Qooti-Key": key,
          },
          body: JSON.stringify({
            action: rawPayload.action,
            url: rawPayload.url,
            pageUrl: rawPayload.pageUrl,
            pageTitle: rawPayload.pageTitle,
            mediaType: rawPayload.mediaType,
            platform: rawPayload.platform,
          }),
        })
          .then(function (res) {
            if (!res.ok) return res.text().then(function (t) { throw new Error(t || ("HTTP " + res.status)); });
            console.log("[Qooti] Request queued in desktop (direct)");
          })
          .catch(function (e) {
            console.error("[Qooti] Direct desktop error:", e && e.message ? e.message : e);
          });
      });
    }
    console.log("[Qooti] Sending to desktop:", payload.action, payload.url, platform);
    function trySend(retriesLeft) {
      chrome.runtime.sendMessage(payload, function (response) {
        if (chrome.runtime.lastError) {
          var err = chrome.runtime.lastError.message || "";
          var isNoReceiver = err.indexOf("Receiving end does not exist") !== -1 || err.indexOf("Could not establish connection") !== -1;
          if (isNoReceiver && retriesLeft > 0) {
            setTimeout(function () { trySend(retriesLeft - 1); }, 600);
            return;
          }
          if (isNoReceiver) {
            console.warn("[Qooti] Background not ready. Falling back to direct desktop request.");
            sendDirectToDesktop(payload);
          } else {
            console.error("[Qooti] Extension error:", err);
          }
          return;
        }
        if (response && response.ok) {
          console.log("[Qooti] Request queued in desktop");
        } else if (response && response.error) {
          console.error("[Qooti] Desktop error:", response.error);
        }
      });
    }
    trySend(4);
  }

  function showOverlay(el) {
    const info = getMediaInfo(el);
    if (!info) return;
    const platform = getPlatform();
    currentMediaEl = el;
    currentAnchorEl = getStableHoverContainer(el, platform) || el;
    if (platform === "youtube") currentVideoKey = getYouTubeUrlFromContext(el);
    const ov = getOverlay();
    const rect = (currentAnchorEl || el).getBoundingClientRect();
    const wrap = ov.querySelector(".qooti-overlay-wrap");
    const pill = ov.querySelector(".qooti-pill");
    var thumbBtn = ov.querySelector(".qooti-menu-thumb");
    var linkBtn = ov.querySelector('.qooti-action[data-action="link"]');
    if (thumbBtn) {
      thumbBtn.style.display = platform === "youtube" ? "" : "none";
    }
    if (linkBtn) {
      linkBtn.style.display = getPlatformConfig(platform).allowLink ? "" : "none";
    }
    var pad = 10;
    var pillW = pill.classList.contains("qooti-pill--icon-only") ? 36 : Math.max(pill.offsetWidth || 0, 100);
    var wrapH = wrap.offsetHeight || 46;
    ov.style.pointerEvents = "none";
    wrap.style.pointerEvents = "auto";
    function placeOverlay(pos) {
      pos = pos || cachedPopupPosition;
      cachedPopupPosition = pos;
      applyOverlayPosition(ov, rect, pos, pad, pillW, wrapH);
    }
    placeOverlay();
    ov.classList.add("qooti-overlay--visible");
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    chrome.storage.local.get(["popupPosition"], function (o) {
      if (o.popupPosition && o.popupPosition !== cachedPopupPosition) placeOverlay(o.popupPosition);
    });
    if (!overlayObserver && (platform === "youtube" || platform === "instagram")) {
      overlayObserver = new MutationObserver(function () {
        if (!currentMediaEl || !currentAnchorEl || !overlayEl || !overlayEl.classList.contains("qooti-overlay--visible")) return;
        if (!document.contains(currentAnchorEl)) {
          var replacement = null;
          if (platform === "youtube") {
            var vid = getYouTubeVideoId(currentVideoKey);
            replacement = currentVideoKey
              ? document.querySelector(
                  vid
                    ? 'a[href*="watch?v=' + vid + '"], a[href*="/shorts/' + vid + '"], a[href*="' + vid + '"]'
                    : 'a[href*="watch"], a[href*="/shorts/"]'
                )
              : null;
          } else if (platform === "instagram") {
            replacement = document.querySelector("article img, article video");
          }
          if (replacement) currentAnchorEl = getStableHoverContainer(replacement, platform);
          else return;
        }
        var r = (currentAnchorEl || currentMediaEl).getBoundingClientRect();
        var wh = wrap.offsetHeight || 0;
        applyOverlayPosition(ov, r, cachedPopupPosition, pad, pillW, wh);
      });
      overlayObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function hideOverlay() {
    currentMediaEl = null;
    currentAnchorEl = null;
    currentVideoKey = "";
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
    if (overlayEl) {
      overlayEl.classList.remove("qooti-overlay--visible");
      overlayEl.style.pointerEvents = "none";
    }
  }

  function scheduleHide() {
    if (hideTimeout) return;
    hideTimeout = setTimeout(function () {
      hideTimeout = null;
      hideOverlay();
    }, 150);
  }

  function resolveMediaTarget(event) {
    if (!event) return null;
    var target = event.target;
    if (target && (target.tagName === "IMG" || target.tagName === "VIDEO")) return target;
    if (event.composedPath) {
      var path = event.composedPath();
      for (var i = 0; i < path.length; i++) {
        var node = path[i];
        if (node && (node.tagName === "IMG" || node.tagName === "VIDEO")) return node;
      }
    }
    if (target && target.closest) {
      var closestMedia = target.closest("img,video");
      if (closestMedia) return closestMedia;
    }
    return null;
  }

  document.addEventListener("mouseover", (e) => {
    const target = e.target;
    const mediaTarget = resolveMediaTarget(e);
    if (!mediaTarget) {
      if (overlayEl && target.closest("#qooti-hover-overlay")) {
        if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
        return;
      }
      if (currentMediaEl && !target.closest("#qooti-hover-overlay")) scheduleHide();
      return;
    }
    chrome.storage.local.get(["displayMode"], (o) => {
      const mode = (o.displayMode || "both").toLowerCase();
      if (mode === "context") return;
      const info = getMediaInfo(mediaTarget);
      if (!info) return;
      if (!wakePingSent) {
        wakePingSent = true;
        chrome.runtime.sendMessage({ type: "QOOTI_PING" }, function () {});
      }
      showOverlay(mediaTarget);
    });
  }, true);

  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("#qooti-hover-overlay")) return;
    if (currentAnchorEl && e.relatedTarget && currentAnchorEl.contains && currentAnchorEl.contains(e.relatedTarget)) return;
    if (resolveMediaTarget(e)) scheduleHide();
  }, true);

  window.addEventListener("scroll", () => { if (currentMediaEl) hideOverlay(); }, true);
  window.addEventListener("resize", () => { if (currentMediaEl) hideOverlay(); }, true);
})();
