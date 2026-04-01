/**
 * Generates latest.json for Tauri updater after a signed build.
 * Run after: npm run tauri build (with TAURI_SIGNING_PRIVATE_KEY_PATH set)
 *
 * Usage:
 *   node scripts/generate-latest-json.js <release-base-url> [--merge path/to/latest.json] [--macos-bundle-dir path/to/folder]
 *
 * On Windows: reads NSIS .exe + .sig from target/release/bundle/nsis.
 * Optional --macos-bundle-dir: folder containing Qooti_*_universal.app.tar.gz (or versioned .app.tar.gz) and .sig from macOS CI — merges darwin-* entries so one manifest covers Windows + macOS.
 *
 * On macOS: writes darwin-{arch} from local bundle paths (or use --merge with a Windows latest.json).
 *
 * Example (GitHub Releases):
 *   node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.0
 *   node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.0 --merge ./latest.json
 *   node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.1 --macos-bundle-dir ./release-assets/mac-v0.1.1
 */

const fs = require("fs");
const path = require("path");

const rawArgs = process.argv.slice(2);
let mergePath = null;
let macosBundleDir = null;
const positionals = [];

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--merge" && rawArgs[i + 1]) {
    mergePath = rawArgs[++i];
  } else if (a === "--macos-bundle-dir" && rawArgs[i + 1]) {
    macosBundleDir = rawArgs[++i];
  } else {
    positionals.push(a);
  }
}

const releaseBaseUrl = positionals[0];

if (!releaseBaseUrl) {
  console.error(
    "Usage: node scripts/generate-latest-json.js <release-base-url> [--merge path/to/latest.json] [--macos-bundle-dir path]"
  );
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

/** @param {string} macosDirAbs absolute path */
function addDarwinPlatformsFromBundleDir(macosDirAbs, validatedBase) {
  const abs = path.resolve(macosDirAbs);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error("--macos-bundle-dir is missing or not a directory:", abs);
    process.exit(1);
  }
  const files = fs.readdirSync(abs);
  const tarGz = getVersionedBundleFile(files, version, ".app.tar.gz");
  const sigFile = `${tarGz}.sig`;
  const sigPath = path.join(abs, sigFile);
  if (!fs.existsSync(sigPath)) {
    console.error("macOS .sig not found:", sigPath);
    process.exit(1);
  }
  const sigContent = fs.readFileSync(sigPath, "utf8").trim();
  const platformUrl = new URL(tarGz, `${validatedBase}/`).toString();
  const lower = `${tarGz} ${abs}`.toLowerCase();
  const isUniversal = lower.includes("universal");

  const addDarwin = (archSuffix) => {
    const base = `darwin-${archSuffix}`;
    const entry = { signature: sigContent, url: platformUrl };
    platforms[base] = entry;
    platforms[`${base}-app`] = { ...entry };
  };

  if (isUniversal) {
    addDarwin("aarch64");
    addDarwin("x86_64");
  } else if (/aarch64|arm64/i.test(tarGz)) {
    addDarwin("aarch64");
  } else if (/x86_64|x64/i.test(tarGz)) {
    addDarwin("x86_64");
  } else {
    console.error(
      "Cannot infer macOS architecture. Use a universal .app.tar.gz (filename contains \"universal\") or aarch64/x86_64 in the name:",
      tarGz
    );
    process.exit(1);
  }

  filesToUpload.push(tarGz, sigFile);
}

if (process.platform === "win32") {
  const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
  if (!fs.existsSync(nsisDir)) {
    console.error("NSIS bundle not found. Run 'npm run tauri build' first.");
    process.exit(1);
  }
  const files = fs.readdirSync(nsisDir);
  const exeFile = getVersionedBundleFile(files, version, "-setup.exe");
  const sigFile = exeFile ? `${exeFile}.sig` : null;
  if (!exeFile || !sigFile || !fs.existsSync(path.join(nsisDir, sigFile))) {
    console.error("Installer or .sig not found in", nsisDir);
    process.exit(1);
  }
  const sigContent = fs.readFileSync(path.join(nsisDir, sigFile), "utf8").trim();
  platforms.windows-x86_64 = {
    signature: sigContent,
    url: new URL(exeFile, `${validatedBaseUrl}/`).toString(),
  };
  outDir = nsisDir;
  filesToUpload = [exeFile, sigFile];

  if (macosBundleDir) {
    addDarwinPlatformsFromBundleDir(macosBundleDir, validatedBaseUrl);
  }
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
  const sigFile = `${tarGz}.sig`;
  if (!tarGz || !fs.existsSync(path.join(macosDir, sigFile))) {
    console.error("macOS .app.tar.gz or .sig not found in", macosDir);
    process.exit(1);
  }
  const sigContent = fs.readFileSync(path.join(macosDir, sigFile), "utf8").trim();
  const bundlePath = macosDir.toLowerCase().replace(/\\/g, "/");
  const platformUrl = new URL(tarGz, `${validatedBaseUrl}/`).toString();
  const addDarwin = (archSuffix) => {
    const base = `darwin-${archSuffix}`;
    const entry = { signature: sigContent, url: platformUrl };
    platforms[base] = entry;
    platforms[`${base}-app`] = { ...entry };
  };
  if (bundlePath.includes("/universal-apple-darwin/")) {
    addDarwin("aarch64");
    addDarwin("x86_64");
  } else if (bundlePath.includes("/aarch64-apple-darwin/")) {
    addDarwin("aarch64");
  } else if (bundlePath.includes("/x86_64-apple-darwin/")) {
    addDarwin("x86_64");
  } else {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    addDarwin(arch);
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
