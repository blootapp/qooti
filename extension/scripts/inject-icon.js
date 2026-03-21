#!/usr/bin/env node
/**
 * Legacy icon injector.
 * The extension now uses Remix icon assets via chrome.runtime.getURL(),
 * so this script is kept as a safe no-op for backward compatibility.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const iconPath = path.join(root, "icons", "icon.png");
const contentPath = path.join(root, "content.js");

if (!fs.existsSync(iconPath)) {
  console.warn("[inject-icon] icons/icon.png not found");
  process.exit(1);
}

const base64 = fs.readFileSync(iconPath, "base64");
const dataUrl = "data:image/png;base64," + base64;

let js = fs.readFileSync(contentPath, "utf8");

// Legacy: replace the SVG/PNG inlined constant when present.
const oldBlock = `  // Inline SVG "add" icon (always works, no CSP or load issues)
  const ADD_ICON_SVG = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>');`;

const newBlock = "  // App icon (PNG), injected by scripts/inject-icon.js\n  const ADD_ICON_SVG = " + JSON.stringify(dataUrl) + ";";

if (js.includes("data:image/svg+xml,")) {
  js = js.replace(oldBlock, newBlock);
  fs.writeFileSync(contentPath, js);
  console.log("[inject-icon] Injected PNG icon into content.js");
} else if (js.includes("data:image/png;base64,")) {
  // Already PNG: replace the constant line (long base64 string)
  const match = js.match(/const ADD_ICON_SVG = "data:image\/png;base64,[^"]+";/);
  if (match) {
    js = js.replace(match[0], "const ADD_ICON_SVG = " + JSON.stringify(dataUrl) + ";");
    fs.writeFileSync(contentPath, js);
    console.log("[inject-icon] Updated PNG icon in content.js");
  } else {
    console.warn("[inject-icon] Could not find ADD_ICON_SVG PNG constant");
    process.exit(1);
  }
} else {
  console.log("[inject-icon] No inline icon constant found (Remix icons in use), skipping.");
  process.exit(0);
}
