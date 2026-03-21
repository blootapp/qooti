/**
 * Generates latest.json for Tauri updater after a signed build.
 * Run after: npm run tauri build (with TAURI_SIGNING_PRIVATE_KEY_PATH set)
 *
 * Usage:
 *   node scripts/generate-latest-json.js <release-base-url> [--merge path/to/latest.json]
 *
 * On Windows: writes latest.json with windows-x86_64. Optionally --merge to add to existing.
 * On macOS: writes darwin-x86_64 or darwin-aarch64. Use --merge with Windows latest.json to combine.
 *
 * Example (GitHub Releases):
 *   node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.0
 *   node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.0 --merge ./latest.json
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const mergeIdx = args.indexOf("--merge");
const releaseBaseUrl = mergeIdx >= 0 ? args[0] : args[0];
const mergePath = mergeIdx >= 0 ? args[mergeIdx + 1] : null;

if (!releaseBaseUrl) {
  console.error("Usage: node scripts/generate-latest-json.js <release-base-url> [--merge path/to/latest.json]");
  process.exit(1);
}

const root = path.resolve(__dirname, "..");
const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
const version = (conf.version || "0.1.0").replace(/^v/, "");
const baseUrl = releaseBaseUrl.replace(/\/$/, "");
const pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function parseAndValidateReleaseBaseUrl(input, expectedVersion) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch (err) {
    console.error("Release base URL must be a valid absolute URL.");
    process.exit(1);
  }
  const normalized = parsed.toString().replace(/\/$/, "");
  const releaseTag = normalized.split("/").pop();
  if (releaseTag !== `v${expectedVersion}`) {
    console.error(`Release base URL must end with /v${expectedVersion}.`);
    console.error("Received:", normalized);
    process.exit(1);
  }
  return normalized;
}

function getVersionedBundleFile(files, expectedVersion, extension) {
  const versionMarker = `_${expectedVersion}_`;
  const matches = files.filter((file) => file.endsWith(extension) && !file.endsWith(".sig"));
  const exactMatch = matches.find((file) => file.includes(versionMarker));
  if (exactMatch) return exactMatch;
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    console.error(`No ${extension} bundle was found for version ${expectedVersion}.`);
  } else {
    console.error(`Could not determine which ${extension} bundle matches version ${expectedVersion}.`);
    console.error("Found:", matches.join(", "));
  }
  process.exit(1);
}

const validatedBaseUrl = parseAndValidateReleaseBaseUrl(baseUrl, version);

let platforms = {};
let outDir = null;
let filesToUpload = [];

function findExistingDir(candidates) {
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

if (process.platform === "win32") {
  const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
  if (!fs.existsSync(nsisDir)) {
    console.error("NSIS bundle not found. Run 'npm run tauri build' first.");
    process.exit(1);
  }
  const files = fs.readdirSync(nsisDir);
  const exeFile = getVersionedBundleFile(files, version, "-setup.exe");
  const sigFile = exeFile ? exeFile + ".sig" : null;
  if (!exeFile || !sigFile || !fs.existsSync(path.join(nsisDir, sigFile))) {
    console.error("Installer or .sig not found in", nsisDir);
    process.exit(1);
  }
  const sigContent = fs.readFileSync(path.join(nsisDir, sigFile), "utf8").trim();
  platforms["windows-x86_64"] = { signature: sigContent, url: new URL(exeFile, `${validatedBaseUrl}/`).toString() };
  outDir = nsisDir;
  filesToUpload = [exeFile, sigFile];
} else if (process.platform === "darwin") {
  const macosDir = findExistingDir([
    path.join(root, "src-tauri", "target", "universal-apple-darwin", "release", "bundle", "macos"),
    path.join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos"),
    path.join(root, "src-tauri", "target", "x86_64-apple-darwin", "release", "bundle", "macos"),
    path.join(root, "src-tauri", "target", "release", "bundle", "macos"),
  ]);
  if (!macosDir || !fs.existsSync(macosDir)) {
    console.error("macOS bundle not found. Run 'npm run tauri build' on a Mac first.");
    process.exit(1);
  }
  const files = fs.readdirSync(macosDir);
  const tarGz = getVersionedBundleFile(files, version, ".app.tar.gz");
  const sigFile = tarGz ? tarGz + ".sig" : null;
  if (!tarGz || !sigFile || !fs.existsSync(path.join(macosDir, sigFile))) {
    console.error("macOS .app.tar.gz or .sig not found in", macosDir);
    process.exit(1);
  }
  const sigContent = fs.readFileSync(path.join(macosDir, sigFile), "utf8").trim();
  const bundlePath = macosDir.toLowerCase().replace(/\\/g, "/");
  const platformUrl = new URL(tarGz, `${validatedBaseUrl}/`).toString();
  if (bundlePath.includes("/universal-apple-darwin/")) {
    platforms["darwin-aarch64"] = { signature: sigContent, url: platformUrl };
    platforms["darwin-x86_64"] = { signature: sigContent, url: platformUrl };
  } else if (bundlePath.includes("/aarch64-apple-darwin/")) {
    platforms["darwin-aarch64"] = { signature: sigContent, url: platformUrl };
  } else if (bundlePath.includes("/x86_64-apple-darwin/")) {
    platforms["darwin-x86_64"] = { signature: sigContent, url: platformUrl };
  } else {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    platforms["darwin-" + arch] = { signature: sigContent, url: platformUrl };
  }
  outDir = macosDir;
  filesToUpload = [tarGz, sigFile];
} else {
  console.error("Unsupported platform. Run on Windows or macOS.");
  process.exit(1);
}

let latest = { version, notes: "", pub_date: pubDate, platforms };

if (mergePath && fs.existsSync(mergePath)) {
  const existing = JSON.parse(fs.readFileSync(mergePath, "utf8"));
  latest = {
    version: existing.version || version,
    notes: existing.notes || "",
    pub_date: existing.pub_date || pubDate,
    platforms: { ...existing.platforms, ...platforms },
  };
}

const outPath = path.join(outDir, "latest.json");
fs.writeFileSync(outPath, JSON.stringify(latest, null, 2), "utf8");

console.log("Wrote", outPath);
console.log("\nUpload to your release:");
filesToUpload.forEach((f) => console.log("  -", f));
console.log("  - latest.json");
console.log("\nRelease URL base:", validatedBaseUrl);
const repoMatch = validatedBaseUrl.match(/github\.com\/[^/]+\/[^/]+/);
if (repoMatch) {
  console.log("latest.json URL: https://" + repoMatch[0] + "/releases/latest/download/latest.json");
}
