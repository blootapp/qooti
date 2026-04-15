const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const youtubedl = require("youtube-dl-exec");

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes("youtube.com") || u.hostname === "youtu.be";
  } catch {
    return false;
  }
}

function isInstagramUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "www.instagram.com" || u.hostname === "instagram.com";
  } catch {
    return false;
  }
}

/** Parse yt-dlp stderr for progress percentage. Returns 0–100 or null. */
function parseProgressFromStderr(chunk) {
  const str = chunk.toString();
  // yt-dlp outputs: "[download]  45.2% of 12.34MiB" or " 45.2%"
  const m = str.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Math.min(100, Math.max(0, parseFloat(m[1]))) : null;
}

/**
 * Download video using yt-dlp (supports YouTube, Instagram, and many more).
 * Returns { ok, path, error }.
 * @param {Function} [onProgress] - Callback(percent 0–100) for download progress
 */
async function downloadVideoFromUrl(url, destPath, onProgress) {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath, path.extname(destPath));
  // Use forward slashes for yt-dlp output template (works on all platforms)
  const outputTemplate = path.join(dir, base + ".%(ext)s").replace(/\\/g, "/");

  const flags = {
    output: outputTemplate,
    format: "best[ext=mp4]/best",
    noWarnings: true,
    noCallHome: true,
    noPlaylist: true,
    noUpdate: true,
    ignoreConfig: true,
    noWriteInfoJson: true,
    noWriteComments: true,
    noWriteSubs: true,
    noEmbedMetadata: true,
    noEmbedThumbnail: true,
    noMtime: true,
    newline: true,
    concurrentFragments: 8,
    addHeader: [
      "referer:youtube.com",
      "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ]
  };

  try {
    fs.mkdirSync(dir, { recursive: true });

    if (typeof onProgress === "function") onProgress(0);

    const subprocess = youtubedl.exec(url, flags);
    const handleChunk = (chunk) => {
      const pct = parseProgressFromStderr(chunk);
      if (pct != null) onProgress(pct);
    };
    if (typeof onProgress === "function") {
      if (subprocess.stderr) subprocess.stderr.on("data", handleChunk);
      if (subprocess.stdout) subprocess.stdout.on("data", handleChunk);
    }

    await subprocess;

    if (typeof onProgress === "function") onProgress(100);

    // yt-dlp uses the template; find the actual file created
    const files = fs.readdirSync(dir);
    const match = files.find((f) => f.startsWith(base + "."));
    if (!match) {
      return { ok: false, error: "Download completed but file not found" };
    }

    const actualPath = path.join(dir, match);
    return { ok: true, path: actualPath };
  } catch (err) {
    const msg = err?.message || err?.stderr || "Download failed";
    return { ok: false, error: String(msg).trim() };
  }
}

module.exports = {
  isYouTubeUrl,
  isInstagramUrl,
  downloadVideoFromUrl
};
