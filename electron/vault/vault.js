const fs = require("node:fs");
const path = require("node:path");

const { app } = require("electron");

function getVaultRoot() {
  return path.join(app.getPath("userData"), "vault");
}

function getVaultPaths() {
  const root = getVaultRoot();
  return {
    root,
    dbPath: path.join(root, "qooti.db"),
    mediaDir: path.join(root, "media"),
    thumbsDir: path.join(root, "thumbnails")
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureVault() {
  const { root, mediaDir, thumbsDir } = getVaultPaths();
  ensureDir(root);
  ensureDir(mediaDir);
  ensureDir(thumbsDir);
}

module.exports = {
  getVaultRoot,
  getVaultPaths,
  ensureVault
};

