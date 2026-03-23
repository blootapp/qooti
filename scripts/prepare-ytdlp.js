#!/usr/bin/env node
/**
 * Ensures yt-dlp binary exists in src-tauri/resources/ for bundling.
 * Windows: yt-dlp.exe
 * macOS:   yt-dlp (official yt-dlp_macos binary, chmod +x)
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const projectRoot = path.join(__dirname, "..");
const destDir = path.join(projectRoot, "src-tauri", "resources");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
if (!isWin && !isMac) {
  console.log("[prepare-ytdlp] Skipping on unsupported platform");
  process.exit(0);
}
const dest = path.join(destDir, isWin ? "yt-dlp.exe" : "yt-dlp");
const MIN_VALID_SIZE_BYTES = 1_000_000;

// Skip if already present and reasonably sized
if (fs.existsSync(dest) && fs.statSync(dest).size > MIN_VALID_SIZE_BYTES) {
  console.log(`[prepare-ytdlp] ${isWin ? "yt-dlp.exe" : "yt-dlp"} already present`);
  process.exit(0);
}

const fromNpm = path.join(projectRoot, "node_modules", "youtube-dl-exec", "bin", isWin ? "yt-dlp.exe" : "yt-dlp");
if (fs.existsSync(fromNpm) && fs.statSync(fromNpm).size > MIN_VALID_SIZE_BYTES) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(fromNpm, dest);
  if (isMac) {
    try {
      fs.chmodSync(dest, 0o755);
    } catch {}
  }
  console.log(`[prepare-ytdlp] Copied ${isWin ? "yt-dlp.exe" : "yt-dlp"} from node_modules`);
  process.exit(0);
}
if (fs.existsSync(fromNpm)) {
  console.warn(`[prepare-ytdlp] Ignoring tiny node_modules binary (${fs.statSync(fromNpm).size} bytes), downloading fresh binary`);
}

// Download from GitHub
async function download() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const file = fs.createWriteStream(dest);
    const sourceUrl = isWin
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    const req = https.get(
      sourceUrl,
      { headers: { "User-Agent": "qooti-prepare" } },
      (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          fs.unlink(dest, () => {});
          https.get(res.headers.location, { headers: { "User-Agent": "qooti-prepare" } }, (r2) => {
            const f2 = fs.createWriteStream(dest);
            r2.pipe(f2);
            f2.on("finish", () => {
              f2.close();
              resolve();
            });
          }).on("error", reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          if (isMac) {
            try {
              fs.chmodSync(dest, 0o755);
            } catch {}
          }
          resolve();
        });
      }
    );
    req.on("error", (e) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(e);
    });
  });
}
download()
  .then(() => console.log(`[prepare-ytdlp] Downloaded ${isWin ? "yt-dlp.exe" : "yt-dlp"}`))
  .catch((e) => {
    console.error("[prepare-ytdlp] Download failed:", e.message, "- Run: npm install");
    process.exit(1);
  });
