const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const archiver = require("archiver");
const extractZip = require("extract-zip");

const { SCHEMA_VERSION } = require("../db/migrations");

function nowIsoSafe() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rimraf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function addDirToArchive(archive, dirAbs, dirNameInArchive) {
  if (!exists(dirAbs)) return;
  archive.directory(dirAbs, dirNameInArchive);
}

async function writeZip({ outPath, vault }) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") return;
      reject(err);
    });
    archive.on("error", reject);

    archive.pipe(output);

    const manifest = {
      schema_version: SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      format: "qooti-backup-v1"
    };

    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

    if (exists(vault.dbPath)) {
      archive.file(vault.dbPath, { name: "qooti.db" });
    }
    addDirToArchive(archive, vault.mediaDir, "media");
    addDirToArchive(archive, vault.thumbsDir, "thumbnails");

    archive.finalize();
  });
}

async function exportBackup({ outPath, vault }) {
  await writeZip({ outPath, vault });
  return { ok: true, path: outPath };
}

async function importBackup({ inPath, vault }) {
  const tmpDir = path.join(os.tmpdir(), `qooti-import-${nowIsoSafe()}`);
  mkdirp(tmpDir);
  try {
    await extractZip(inPath, { dir: tmpDir });

    const manifestPath = path.join(tmpDir, "manifest.json");
    if (!exists(manifestPath)) {
      return { ok: false, error: "Invalid backup: missing manifest.json" };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.format !== "qooti-backup-v1") {
      return { ok: false, error: "Invalid backup: unsupported format" };
    }

    const restoredDb = path.join(tmpDir, "qooti.db");
    if (!exists(restoredDb)) {
      return { ok: false, error: "Invalid backup: missing qooti.db" };
    }

    // Preserve existing vault by renaming it
    const vaultRoot = vault.root;
    const parent = path.dirname(vaultRoot);
    const oldPath = path.join(parent, `vault-old-${nowIsoSafe()}`);

    if (exists(vaultRoot)) {
      fs.renameSync(vaultRoot, oldPath);
    }

    // Recreate vault dirs
    mkdirp(vaultRoot);
    mkdirp(vault.mediaDir);
    mkdirp(vault.thumbsDir);

    // Restore db + dirs
    fs.copyFileSync(restoredDb, vault.dbPath);

    const restoredMedia = path.join(tmpDir, "media");
    const restoredThumbs = path.join(tmpDir, "thumbnails");

    if (exists(restoredMedia)) fs.cpSync(restoredMedia, vault.mediaDir, { recursive: true });
    if (exists(restoredThumbs)) fs.cpSync(restoredThumbs, vault.thumbsDir, { recursive: true });

    return { ok: true, replaced: true, oldVault: oldPath };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    try {
      rimraf(tmpDir);
    } catch {
      // ignore
    }
  }
}

module.exports = {
  exportBackup,
  importBackup
};

