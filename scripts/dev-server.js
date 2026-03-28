#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = 1421;
const PROJECT_ROOT = path.join(__dirname, "..");
const SRC_ROOT = path.join(PROJECT_ROOT, "src");

// Vault path: prefer Electron legacy (qooti/vault) when it exists, else Tauri (com.qooti.desktop/vault)
const appDataDir = process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming");
const legacyVault = path.join(appDataDir, "qooti", "vault");
const defaultVault = path.join(appDataDir, "com.qooti.desktop", "vault");
const vaultRoot = fs.existsSync(path.join(legacyVault, "qooti.db")) ? legacyVault : defaultVault;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8"
};

/** Single-range parser for Range: bytes=… (required for <video> seek in Chromium/WebView). */
function parseBytesRange(header, size) {
  if (!header || !/^bytes=/i.test(header)) return null;
  const part = header.split(",")[0].trim();
  const m = /^bytes=(\d*)-(\d*)$/i.exec(part);
  if (!m) return null;
  let start = m[1] === "" ? null : Number(m[1]);
  let end = m[2] === "" ? null : Number(m[2]);
  if (start !== null && !Number.isFinite(start)) return null;
  if (end !== null && !Number.isFinite(end)) return null;
  if (start === null && end === null) return null;

  if (start !== null && end !== null) {
    if (start > end || start >= size) return null;
    end = Math.min(end, size - 1);
    return { start, end };
  }
  if (start !== null) {
    if (start >= size) return null;
    return { start, end: size - 1 };
  }
  const suffixLen = end;
  if (suffixLen === null || suffixLen <= 0) return null;
  if (suffixLen > size) return { start: 0, end: size - 1 };
  return { start: size - suffixLen, end: size - 1 };
}

function sendVaultFileWithRange(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = stat.size;
    const contentType = MIME[path.extname(filePath)] || "application/octet-stream";
    const range = req.headers.range;

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Length": size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes"
      });
      res.end();
      return;
    }

    if (range) {
      const rng = parseBytesRange(range, size);
      if (!rng) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      const { start, end } = rng;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
      stream.on("error", () => {
        try {
          res.destroy();
        } catch (_) {}
      });
      return;
    }

    res.writeHead(200, {
      "Content-Length": size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on("error", () => {
      try {
        res.destroy();
      } catch (_) {}
    });
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://localhost");
  let p = u.pathname;
  if (p === "/") p = "/src/index.html";
  // Suppress favicon 404
  if (p === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (p.startsWith("/vault/")) {
    const rel = p.slice("/vault/".length).replace(/\.\./g, "");
    const filePath = path.resolve(vaultRoot, rel);
    if (!filePath.startsWith(vaultRoot)) {
      res.writeHead(403);
      res.end();
      return;
    }
    sendVaultFileWithRange(req, res, filePath);
    return;
  }

  const filePath = path.resolve(PROJECT_ROOT, p.slice(1));
  const rel = path.relative(PROJECT_ROOT, filePath);
  if (rel.startsWith("..")) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Dev server: http://127.0.0.1:" + PORT);
  console.log("Vault: " + vaultRoot);
});
