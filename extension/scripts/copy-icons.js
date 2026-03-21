#!/usr/bin/env node
/**
 * Copy app icon from project assets into extension/icons/ for Chrome.
 * Run from repo root: node extension/scripts/copy-icons.js
 */
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "../..");
const src = path.join(projectRoot, "assets", "icon.png");
const destDir = path.join(projectRoot, "extension", "icons");

if (!fs.existsSync(src)) {
  console.warn("[copy-icons] Not found:", src);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, "icon.png");
fs.copyFileSync(src, dest);
console.log("[copy-icons] Copied to extension/icons/icon.png");
