import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "assets");
fs.mkdirSync(outDir, { recursive: true });

const BG = "#0a0a0a";
const FG = "#f5f5f5";
const MUTED = "#a3a3a3";

function svgOg() {
  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BG}"/>
  <text x="600" y="260" text-anchor="middle" font-family="system-ui,Segoe UI,sans-serif" font-size="72" font-weight="600" fill="${FG}">bloot</text>
  <text x="600" y="340" text-anchor="middle" font-family="system-ui,Segoe UI,sans-serif" font-size="28" fill="${MUTED}">Visual inspiration library for creatives</text>
</svg>`;
}

function svgMark(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="14" fill="${BG}"/>
  <text x="32" y="42" text-anchor="middle" font-family="Segoe UI,system-ui,sans-serif" font-size="34" font-weight="700" fill="${FG}">B</text>
</svg>`;
}

async function writePng(name, width, height, svg) {
  const file = path.join(outDir, name);
  await sharp(Buffer.from(svg)).resize(width, height).png().toFile(file);
  console.log("wrote", file);
}

await writePng("og-image.png", 1200, 630, svgOg());
await writePng("logo.png", 512, 512, svgMark(512));
await writePng("favicon-16.png", 16, 16, svgMark(16));
await writePng("favicon-32.png", 32, 32, svgMark(32));
await writePng("apple-touch-icon.png", 180, 180, svgMark(180));
await writePng("favicon-192.png", 192, 192, svgMark(192));
await writePng("favicon-512.png", 512, 512, svgMark(512));
