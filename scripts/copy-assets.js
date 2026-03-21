#!/usr/bin/env node
/**
 * Copies frontend assets (logo, icons) from project assets/ into src/assets/
 * so they are included in the Tauri bundle (frontendDist is ../src only).
 */
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const srcAssets = path.join(projectRoot, "src", "assets");
const rootAssets = path.join(projectRoot, "assets");
const vendorDir = path.join(projectRoot, "src", "vendor");

if (!fs.existsSync(rootAssets)) {
  console.log("[copy-assets] No assets folder, skipping");
  process.exit(0);
}

fs.mkdirSync(srcAssets, { recursive: true });

const logo = path.join(rootAssets, "logo.png");
if (fs.existsSync(logo)) {
  fs.copyFileSync(logo, path.join(srcAssets, "logo.png"));
  console.log("[copy-assets] Copied logo.png");
}

const iconsDir = path.join(rootAssets, "icons");
if (fs.existsSync(iconsDir)) {
  const destIcons = path.join(srcAssets, "icons");
  fs.mkdirSync(destIcons, { recursive: true });
  const flaticon = path.join(iconsDir, "flaticon");
  if (fs.existsSync(flaticon)) {
    const destFlaticon = path.join(destIcons, "flaticon");
    fs.mkdirSync(destFlaticon, { recursive: true });
    for (const name of fs.readdirSync(flaticon)) {
      const srcFile = path.join(flaticon, name);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, path.join(destFlaticon, name));
      }
    }
    console.log("[copy-assets] Copied icons/flaticon");
  }
}

fs.mkdirSync(vendorDir, { recursive: true });

const vendorFiles = [
  {
    src: path.join(projectRoot, "node_modules", "cropperjs", "dist", "cropper.css"),
    dest: path.join(vendorDir, "cropper.css"),
    label: "vendor/cropper.css",
  },
  {
    src: path.join(projectRoot, "node_modules", "cropperjs", "dist", "cropper.js"),
    dest: path.join(vendorDir, "cropper.js"),
    label: "vendor/cropper.js",
  },
  {
    src: path.join(projectRoot, "node_modules", "konva", "konva.min.js"),
    dest: path.join(vendorDir, "konva.min.js"),
    label: "vendor/konva.min.js",
  },
  {
    src: path.join(projectRoot, "node_modules", "html2canvas", "dist", "html2canvas.esm.js"),
    dest: path.join(vendorDir, "html2canvas.esm.js"),
    label: "vendor/html2canvas.esm.js",
  },
];

for (const file of vendorFiles) {
  if (!fs.existsSync(file.src)) {
    console.warn(`[copy-assets] Missing ${file.label}, skipping`);
    continue;
  }
  fs.copyFileSync(file.src, file.dest);
  console.log(`[copy-assets] Copied ${file.label}`);
}
