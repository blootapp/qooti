const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
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
  ".mov": "video/quicktime"
};

const PORT = 5173;

function startDevServer(projectRoot, vaultRoot) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", `http://localhost`);
    let p = u.pathname;
    if (p === "/") p = "/src/index.html";

    if (p.startsWith("/vault/")) {
      const rel = p.slice("/vault/".length).replace(/\.\./g, "");
      const filePath = path.resolve(vaultRoot, rel);
      if (path.relative(vaultRoot, filePath).startsWith("..")) {
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
        const ext = path.extname(filePath);
        res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
        res.end(data);
      });
      return;
    }

    const filePath = path.resolve(projectRoot, p.slice(1));
    if (path.relative(projectRoot, filePath).startsWith("..")) {
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
      const ext = path.extname(filePath);
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(PORT, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${PORT}`;
      resolve({ server, baseUrl });
    });
    server.on("error", reject);
  });
}

module.exports = { startDevServer, PORT };
