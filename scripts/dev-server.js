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
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
      res.end(data);
    });
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
