const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { v4: uuidv4 } = require("uuid");

const { SCHEMA_VERSION } = require("../db/migrations");
const { openDb, closeDb } = require("../db/db");
const { generateThumbnail } = require("../thumbs/thumbs");
const { getAspectRatioFromFile } = require("./mediaDimensions");
const { exportBackup, importBackup } = require("../backup/backup");
const { ensureVault } = require("../vault/vault");

function nowMs() {
  return Date.now();
}

function extLower(filePath) {
  return path.extname(filePath).toLowerCase();
}

function detectMediaType(filePath) {
  const ext = extLower(filePath);
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".heic"].includes(ext)) return "image";
  if ([".gif"].includes(ext)) return "gif";
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".m4v"].includes(ext)) return "video";
  return null;
}

function safeTitleFromFilename(filePath) {
  const base = path.basename(filePath);
  return base.replace(path.extname(base), "");
}

function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function relToVault(vaultRoot, absPath) {
  return path.relative(vaultRoot, absPath).split(path.sep).join("/");
}

function absFromVault(vaultRoot, relPath) {
  return path.join(vaultRoot, ...String(relPath).split("/"));
}

function fileUrlOrNull(absPath) {
  if (!absPath) return null;
  try {
    return pathToFileURL(absPath).toString();
  } catch {
    return null;
  }
}

function vaultUrl(vaultRoot, relPath, baseUrl) {
  if (!relPath) return null;
  if (baseUrl) return `${baseUrl.replace(/\/$/, "")}/vault/${relPath.replace(/^\/+/, "")}`;
  return fileUrlOrNull(path.join(vaultRoot, ...String(relPath).split("/")));
}

// YouTube helpers
function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    // youtube.com/watch?v=ID
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) {
      return u.searchParams.get("v");
    }
    // youtu.be/ID
    if (u.hostname === "youtu.be") {
      return u.pathname.slice(1).split("/")[0];
    }
    // youtube.com/embed/ID
    if (u.hostname.includes("youtube.com") && u.pathname.startsWith("/embed/")) {
      return u.pathname.split("/")[2];
    }
    // youtube.com/shorts/ID
    if (u.hostname.includes("youtube.com") && u.pathname.startsWith("/shorts/")) {
      return u.pathname.split("/")[2];
    }
  } catch {
    // Not a valid URL
  }
  return null;
}

async function fetchYouTubeOembed(url) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json&maxwidth=1280&maxheight=720`;
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;
    const data = await res.json();
    let aspectRatio = null;
    if (data.width && data.height) {
      aspectRatio = Number(data.width) / Number(data.height);
    }
    return {
      title: data.title || null,
      author: data.author_name || null,
      thumbnailUrl: data.thumbnail_url || null,
      aspectRatio
    };
  } catch {
    return null;
  }
}

function getYouTubeThumbnailUrl(videoId) {
  // Prefer the highest resolution thumbnail YouTube exposes.
  // maxresdefault.jpg is larger than hqdefault.jpg and gives crisper previews.
  return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
}

async function downloadThumbnail(url, destPath) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch {
    return false;
  }
}

function getDomainFromUrl(url) {
  try {
    const u = new URL(url.startsWith("www.") ? `https://${url}` : url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function registerIpc({ ipcMain, dialog, shell, getMainWindow, getDb, setDb, getVault, getBaseUrl }) {
  const baseUrl = typeof getBaseUrl === "function" ? getBaseUrl() : null;
  ipcMain.handle("qooti:getAppInfo", async () => {
    const vault = getVault();
    const db = getDb();
    const counts = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM inspirations) AS inspirations,
          (SELECT COUNT(*) FROM collections) AS collections,
          (SELECT COUNT(*) FROM moodboards) AS moodboards
        `
      )
      .get();
    return {
      schemaVersion: SCHEMA_VERSION,
      vaultRoot: vault.root,
      counts
    };
  });

  // Preferences
  ipcMain.handle("qooti:preferences:get", async (_evt, key) => {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM preferences WHERE key = ?`).get(key);
    return row ? row.value : null;
  });
  ipcMain.handle("qooti:preferences:set", async (_evt, { key, value }) => {
    const db = getDb();
    db.prepare(`INSERT OR REPLACE INTO preferences(key, value) VALUES (?, ?)`).run(key, String(value));
    return null;
  });

  // Inspirations
  ipcMain.handle("qooti:inspirations:list", async (_evt, params = {}) => {
    const db = getDb();
    const vault = getVault();
    const query = (params.query || "").trim();
    const collectionId = params.collectionId || null;

    let sql = `
      SELECT i.*
      FROM inspirations i
    `;
    const binds = {};

    if (collectionId) {
      sql += ` INNER JOIN collection_items ci ON ci.inspiration_id = i.id `;
    }

    sql += ` WHERE 1=1 `;

    if (collectionId) {
      sql += ` AND ci.collection_id = @collectionId `;
      binds.collectionId = collectionId;
    }

    if (query) {
      sql += ` AND (i.title LIKE @q OR i.source_url LIKE @q OR i.original_filename LIKE @q) `;
      binds.q = `%${query}%`;
    }

    sql += ` ORDER BY i.created_at DESC `;

    const rows = db.prepare(sql).all(binds);
    return rows.map((r) => ({
      ...r,
      stored_path_url: vaultUrl(vault.root, r.stored_path, baseUrl),
      thumbnail_path_url: vaultUrl(vault.root, r.thumbnail_path, baseUrl)
    }));
  });

  ipcMain.handle("qooti:inspirations:addFromFiles", async () => {
    const win = getMainWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Add inspiration files",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Media", extensions: ["png", "jpg", "jpeg", "webp", "gif", "mp4", "mov", "mkv", "webm", "avi", "wmv", "m4v"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });

    if (canceled || !filePaths || filePaths.length === 0) return [];

    const db = getDb();
    const vault = getVault();
    const inserts = [];

    for (const src of filePaths) {
      const type = detectMediaType(src);
      if (!type) continue;

      const id = uuidv4();
      const ext = extLower(src) || "";
      const storedAbs = path.join(vault.mediaDir, `${id}${ext}`);
      copyFileSync(src, storedAbs);

      const storedRel = relToVault(vault.root, storedAbs);
      const title = safeTitleFromFilename(src);
      const ts = nowMs();
      const aspectRatio = await getAspectRatioFromFile(storedAbs, type);

      // Insert first (thumbnail may take a moment)
      db.prepare(
        `
          INSERT INTO inspirations(
            id, type, title, source_url, original_filename, stored_path, thumbnail_path, aspect_ratio, created_at, updated_at
          ) VALUES (
            @id, @type, @title, NULL, @original_filename, @stored_path, NULL, @aspect_ratio, @created_at, @updated_at
          )
        `
      ).run({
        id,
        type,
        title,
        original_filename: path.basename(src),
        stored_path: storedRel,
        aspect_ratio: aspectRatio,
        created_at: ts,
        updated_at: ts
      });

      inserts.push({ id, type, storedAbs });

      // Generate thumbnail asynchronously but deterministically cached
      const thumbAbs = path.join(vault.thumbsDir, `${id}.jpg`);
      const thumbRel = relToVault(vault.root, thumbAbs);
      setImmediate(async () => {
        try {
          await generateThumbnail({ type, srcPath: storedAbs, outPath: thumbAbs });
          db.prepare(`UPDATE inspirations SET thumbnail_path = ?, updated_at = ? WHERE id = ?`).run(
            thumbRel,
            nowMs(),
            id
          );
          const w = getMainWindow();
          if (w && !w.isDestroyed()) {
            w.webContents.send("qooti:thumb:updated", { id, thumbnail_path: thumbRel });
          }
        } catch {
          // Leave thumbnail_path null (UI will show placeholder)
        }
      });
    }

    // Return fresh rows
    const ids = inserts.map((x) => x.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM inspirations WHERE id IN (${placeholders})`).all(ids);
    return rows.map((r) => ({
      ...r,
      stored_path_url: vaultUrl(vault.root, r.stored_path, baseUrl),
      thumbnail_path_url: vaultUrl(vault.root, r.thumbnail_path, baseUrl)
    }));
  });

  // Add files from paths (drag-and-drop)
  ipcMain.handle("qooti:inspirations:addFromPaths", async (_evt, { paths }) => {
    if (!paths || !Array.isArray(paths) || paths.length === 0) return [];

    const db = getDb();
    const vault = getVault();
    const inserts = [];

    for (const src of paths) {
      const type = detectMediaType(src);
      if (!type) continue;

      const id = uuidv4();
      const ext = extLower(src) || "";
      const storedAbs = path.join(vault.mediaDir, `${id}${ext}`);
      copyFileSync(src, storedAbs);

      const storedRel = relToVault(vault.root, storedAbs);
      const title = safeTitleFromFilename(src);
      const ts = nowMs();
      const aspectRatio = await getAspectRatioFromFile(storedAbs, type);

      db.prepare(
        `
          INSERT INTO inspirations(
            id, type, title, source_url, original_filename, stored_path, thumbnail_path, aspect_ratio, created_at, updated_at
          ) VALUES (
            @id, @type, @title, NULL, @original_filename, @stored_path, NULL, @aspect_ratio, @created_at, @updated_at
          )
        `
      ).run({
        id,
        type,
        title,
        original_filename: path.basename(src),
        stored_path: storedRel,
        aspect_ratio: aspectRatio,
        created_at: ts,
        updated_at: ts
      });

      inserts.push({ id, type, storedAbs });

      // Generate thumbnail asynchronously
      const thumbAbs = path.join(vault.thumbsDir, `${id}.jpg`);
      const thumbRel = relToVault(vault.root, thumbAbs);
      setImmediate(async () => {
        try {
          await generateThumbnail({ type, srcPath: storedAbs, outPath: thumbAbs });
          db.prepare(`UPDATE inspirations SET thumbnail_path = ?, updated_at = ? WHERE id = ?`).run(
            thumbRel,
            nowMs(),
            id
          );
          const w = getMainWindow();
          if (w && !w.isDestroyed()) {
            w.webContents.send("qooti:thumb:updated", { id, thumbnail_path: thumbRel });
          }
        } catch {
          // Leave thumbnail_path null
        }
      });
    }

    const ids = inserts.map((x) => x.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM inspirations WHERE id IN (${placeholders})`).all(ids);
    return rows.map((r) => ({
      ...r,
      stored_path_url: vaultUrl(vault.root, r.stored_path, baseUrl),
      thumbnail_path_url: vaultUrl(vault.root, r.thumbnail_path, baseUrl)
    }));
  });

  // Fetch link preview (for YouTube, Instagram, and other URLs)
  ipcMain.handle("qooti:inspirations:fetchLinkPreview", async (_evt, { url }) => {
    try {
      const trimmedUrl = String(url || "").trim();
      if (!trimmedUrl) return null;

      const videoId = extractYouTubeVideoId(trimmedUrl);
      if (videoId) {
        const oembed = await fetchYouTubeOembed(trimmedUrl);
        const thumbnailUrl = getYouTubeThumbnailUrl(videoId);
        const isShort = /\/shorts\//.test(trimmedUrl);
        return {
          type: "youtube",
          url: trimmedUrl,
          title: oembed?.title || `YouTube video`,
          author: oembed?.author || null,
          thumbnailUrl,
          isShortForm: !!isShort,
          aspectRatio: oembed?.aspectRatio ?? null
        };
      }

      // Instagram (reels, posts)
      if (trimmedUrl.includes("instagram.com")) {
        try {
          const axios = require("axios");
          const cheerio = require("cheerio");
          const res = await axios.get(trimmedUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" },
            timeout: 10000
          });
          const $ = cheerio.load(res.data);
          const thumbnailUrl = $('meta[property="og:image"]').attr("content") || null;
          const title = $('meta[property="og:title"]').attr("content") || "Instagram";
          const isReel = /\/reel\//.test(trimmedUrl);
          let aspectRatio = null;
          const w = $('meta[property="og:image:width"]').attr("content");
          const h = $('meta[property="og:image:height"]').attr("content");
          if (w && h) {
            const width = Number(w);
            const height = Number(h);
            if (width > 0 && height > 0) aspectRatio = width / height;
          }
          return {
            type: "instagram",
            url: trimmedUrl,
            title: title.replace(/\s*\|\s*Instagram$/, "").trim() || "Instagram",
            author: null,
            thumbnailUrl,
            isShortForm: !!isReel,
            aspectRatio
          };
        } catch {
          return {
            type: "instagram",
            url: trimmedUrl,
            title: "Instagram",
            author: null,
            thumbnailUrl: null,
            isShortForm: /\/reel\//.test(trimmedUrl),
            aspectRatio: null
          };
        }
      }

      return {
        type: "link",
        url: trimmedUrl,
        title: getDomainFromUrl(trimmedUrl),
        author: null,
        thumbnailUrl: null,
        isShortForm: false,
        aspectRatio: null
      };
    } catch (err) {
      console.error("[qooti:inspirations:fetchLinkPreview] Error:", err);
      return null;
    }
  });

  ipcMain.handle("qooti:inspirations:addLink", async (_evt, { url, metadata }) => {
    try {
      const db = getDb();
      const vault = getVault();
      const id = uuidv4();
      const ts = nowMs();
      const sourceUrl = String(url || "").trim();

      if (!sourceUrl) {
        console.error("[qooti:inspirations:addLink] Empty URL provided");
        return null;
      }

      // Use provided title or fallback to domain
      const title = metadata?.title || getDomainFromUrl(sourceUrl);
      let thumbnailRel = null;
      const aspectRatio = metadata?.aspectRatio != null ? Number(metadata.aspectRatio) : null;

      // Download thumbnail if provided
      if (metadata?.thumbnailUrl) {
        const thumbAbs = path.join(vault.thumbsDir, `${id}.jpg`);
        const downloaded = await downloadThumbnail(metadata.thumbnailUrl, thumbAbs);
        if (downloaded) {
          thumbnailRel = relToVault(vault.root, thumbAbs);
        }
      }

      db.prepare(
        `
          INSERT INTO inspirations(
            id, type, title, source_url, original_filename, stored_path, thumbnail_path, aspect_ratio, created_at, updated_at
          ) VALUES (
            @id, 'link', @title, @source_url, NULL, NULL, @thumbnail_path, @aspect_ratio, @created_at, @updated_at
          )
        `
      ).run({
        id,
        title,
        source_url: sourceUrl,
        thumbnail_path: thumbnailRel,
        aspect_ratio: aspectRatio,
        created_at: ts,
        updated_at: ts
      });

      return {
        id,
        type: "link",
        title,
        source_url: sourceUrl,
        original_filename: null,
        stored_path: null,
        thumbnail_path: thumbnailRel,
        created_at: ts,
        updated_at: ts,
        stored_path_url: null,
        thumbnail_path_url: vaultUrl(vault.root, thumbnailRel, baseUrl)
      };
    } catch (err) {
      console.error("[qooti:inspirations:addLink] Error:", err);
      throw err;
    }
  });

  // Add a standalone image inspiration from a remote thumbnail URL (e.g. YouTube)
  ipcMain.handle("qooti:inspirations:addThumbnailFromUrl", async (_evt, { thumbnailUrl, title }) => {
    try {
      const db = getDb();
      const vault = getVault();
      const id = uuidv4();
      const ts = nowMs();

      const url = String(thumbnailUrl || "").trim();
      if (!url) return null;

      const storedAbs = path.join(vault.mediaDir, `${id}.jpg`);
      const downloaded = await downloadThumbnail(url, storedAbs);
      if (!downloaded) return null;

      const storedRel = relToVault(vault.root, storedAbs);
      const finalTitle = title && String(title).trim().length ? String(title).trim() : "Thumbnail";
      const aspectRatio = await getAspectRatioFromFile(storedAbs, "image");

      db.prepare(
        `
          INSERT INTO inspirations(
            id, type, title, source_url, original_filename, stored_path, thumbnail_path, aspect_ratio, created_at, updated_at
          ) VALUES (
            @id, 'image', @title, @source_url, @original_filename, @stored_path, NULL, @aspect_ratio, @created_at, @updated_at
          )
        `
      ).run({
        id,
        title: finalTitle,
        source_url: url,
        original_filename: "thumbnail.jpg",
        stored_path: storedRel,
        aspect_ratio: aspectRatio,
        created_at: ts,
        updated_at: ts
      });

      // Generate a smaller thumbnail asynchronously
      const thumbAbs = path.join(vault.thumbsDir, `${id}.jpg`);
      const thumbRel = relToVault(vault.root, thumbAbs);
      setImmediate(async () => {
        try {
          await generateThumbnail({ type: "image", srcPath: storedAbs, outPath: thumbAbs });
          db.prepare(`UPDATE inspirations SET thumbnail_path = ?, updated_at = ? WHERE id = ?`).run(
            thumbRel,
            nowMs(),
            id
          );
          const w = getMainWindow();
          if (w && !w.isDestroyed()) {
            w.webContents.send("qooti:thumb:updated", { id, thumbnail_path: thumbRel });
          }
        } catch {
          // Ignore thumbnail failures
        }
      });

      return {
        id,
        type: "image",
        title: finalTitle,
        source_url: url,
        original_filename: "thumbnail.jpg",
        stored_path: storedRel,
        thumbnail_path: null,
        created_at: ts,
        updated_at: ts,
        stored_path_url: vaultUrl(vault.root, storedRel, baseUrl),
        thumbnail_path_url: null
      };
    } catch (err) {
      console.error("[qooti:inspirations:addThumbnailFromUrl] Error:", err);
      throw err;
    }
  });

  // Download video from URL (YouTube, Instagram) and save as local video
  ipcMain.handle("qooti:inspirations:downloadVideoFromUrl", async (evt, { url, title }) => {
    try {
      const { downloadVideoFromUrl } = require("./videoDownload");
      const db = getDb();
      const vault = getVault();
      const id = uuidv4();
      const storedAbs = path.join(vault.mediaDir, `${id}.mp4`);

      const result = await downloadVideoFromUrl(url, storedAbs, (percent) => {
        evt.sender.send("qooti:download:progress", percent);
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      const storedRel = relToVault(vault.root, result.path);
      const ts = nowMs();
      const finalTitle = (title && String(title).trim()) || "Downloaded video";
      const aspectRatio = await getAspectRatioFromFile(result.path, "video");

      db.prepare(
        `
        INSERT INTO inspirations(
          id, type, title, source_url, original_filename, stored_path, thumbnail_path, aspect_ratio, created_at, updated_at
        ) VALUES (
          @id, 'video', @title, @source_url, 'video.mp4', @stored_path, NULL, @aspect_ratio, @created_at, @updated_at
        )
      `
      ).run({
        id,
        title: finalTitle,
        source_url: url,
        stored_path: storedRel,
        aspect_ratio: aspectRatio,
        created_at: ts,
        updated_at: ts
      });

      const thumbAbs = path.join(vault.thumbsDir, `${id}.jpg`);
      const thumbRel = relToVault(vault.root, thumbAbs);
      setImmediate(async () => {
        try {
          await generateThumbnail({ type: "video", srcPath: result.path, outPath: thumbAbs });
          db.prepare(`UPDATE inspirations SET thumbnail_path = ?, updated_at = ? WHERE id = ?`).run(
            thumbRel,
            nowMs(),
            id
          );
          const w = getMainWindow();
          if (w && !w.isDestroyed()) {
            w.webContents.send("qooti:thumb:updated", { id, thumbnail_path: thumbRel });
          }
        } catch {
          /* ignore */
        }
      });

      const row = db.prepare(`SELECT * FROM inspirations WHERE id = ?`).get(id);
      return {
        ok: true,
        inspiration: {
          ...row,
          stored_path_url: vaultUrl(vault.root, row.stored_path, baseUrl),
          thumbnail_path_url: null
        }
      };
    } catch (err) {
      console.error("[qooti:inspirations:downloadVideoFromUrl] Error:", err);
      return { ok: false, error: err.message };
    }
  });

  // Add image from clipboard (base64 data)
  ipcMain.handle("qooti:inspirations:addFromBase64", async (_evt, { base64, mimeType }) => {
    try {
      const db = getDb();
      const vault = getVault();
      const id = uuidv4();
      const ts = nowMs();

      // Determine extension from mime type
      let ext = ".png";
      if (mimeType === "image/jpeg" || mimeType === "image/jpg") ext = ".jpg";
      else if (mimeType === "image/gif") ext = ".gif";
      else if (mimeType === "image/webp") ext = ".webp";

      const type = ext === ".gif" ? "gif" : "image";
      const title = `Pasted image ${new Date().toLocaleString()}`;
      const storedAbs = path.join(vault.mediaDir, `${id}${ext}`);
      const storedRel = relToVault(vault.root, storedAbs);

      // Write base64 to file
      const buffer = Buffer.from(base64, "base64");
      fs.mkdirSync(path.dirname(storedAbs), { recursive: true });
      fs.writeFileSync(storedAbs, buffer);

      const aspectRatio = await getAspectRatioFromFile(storedAbs, type);

      db.prepare(
        `
          INSERT INTO inspirations(
            id, type, title, source_url, original_filename, stored_path, thumbnail_path, aspect_ratio, created_at, updated_at
          ) VALUES (
            @id, @type, @title, NULL, @original_filename, @stored_path, NULL, @aspect_ratio, @created_at, @updated_at
          )
        `
      ).run({
        id,
        type,
        title,
        original_filename: `pasted${ext}`,
        stored_path: storedRel,
        aspect_ratio: aspectRatio,
        created_at: ts,
        updated_at: ts
      });

      // Generate thumbnail asynchronously
      const thumbAbs = path.join(vault.thumbsDir, `${id}.jpg`);
      const thumbRel = relToVault(vault.root, thumbAbs);
      setImmediate(async () => {
        try {
          await generateThumbnail({ type, srcPath: storedAbs, outPath: thumbAbs });
          db.prepare(`UPDATE inspirations SET thumbnail_path = ?, updated_at = ? WHERE id = ?`).run(
            thumbRel,
            nowMs(),
            id
          );
          const w = getMainWindow();
          if (w && !w.isDestroyed()) {
            w.webContents.send("qooti:thumb:updated", { id, thumbnail_path: thumbRel });
          }
        } catch {
          // Leave thumbnail_path null
        }
      });

      return {
        id,
        type,
        title,
        source_url: null,
        original_filename: `pasted${ext}`,
        stored_path: storedRel,
        thumbnail_path: null,
        created_at: ts,
        updated_at: ts,
        stored_path_url: vaultUrl(vault.root, storedRel, baseUrl),
        thumbnail_path_url: null
      };
    } catch (err) {
      console.error("[qooti:inspirations:addFromBase64] Error:", err);
      throw err;
    }
  });

  ipcMain.handle("qooti:inspirations:delete", async (_evt, { id }) => {
    const db = getDb();
    const vault = getVault();
    const row = db.prepare(`SELECT stored_path, thumbnail_path FROM inspirations WHERE id = ?`).get(id);
    if (!row) return { ok: true };

    db.prepare(`DELETE FROM inspirations WHERE id = ?`).run(id);

    // Best-effort file cleanup
    try {
      if (row.stored_path) fs.rmSync(absFromVault(vault.root, row.stored_path), { force: true });
    } catch {
      // ignore
    }
    try {
      if (row.thumbnail_path) fs.rmSync(absFromVault(vault.root, row.thumbnail_path), { force: true });
    } catch {
      // ignore
    }

    return { ok: true };
  });

  // Update inspiration (rename, etc.)
  ipcMain.handle("qooti:inspirations:update", async (_evt, { id, updates }) => {
    const db = getDb();
    const vault = getVault();
    
    const allowedFields = ["title", "display_row"];
    const sets = [];
    const binds = { id };
    
    for (const field of allowedFields) {
      if (updates && updates[field] !== undefined) {
        sets.push(`${field} = @${field}`);
        binds[field] = updates[field];
      }
    }
    
    if (sets.length === 0) return null;
    
    sets.push("updated_at = @updated_at");
    binds.updated_at = nowMs();
    
    db.prepare(`UPDATE inspirations SET ${sets.join(", ")} WHERE id = @id`).run(binds);
    
    const row = db.prepare(`SELECT * FROM inspirations WHERE id = ?`).get(id);
    if (!row) return null;
    
    return {
      ...row,
      stored_path_url: vaultUrl(vault.root, row.stored_path, baseUrl),
      thumbnail_path_url: vaultUrl(vault.root, row.thumbnail_path, baseUrl)
    };
  });

  // Copy file to system clipboard
  ipcMain.handle("qooti:inspirations:copyToClipboard", async (_evt, { storedPath }) => {
    try {
      const vault = getVault();
      const absPath = absFromVault(vault.root, storedPath);
      
      if (!fs.existsSync(absPath)) {
        return { ok: false, error: "File not found" };
      }
      
      const { clipboard, nativeImage } = require("electron");
      const ext = path.extname(absPath).toLowerCase();
      
      // For images, copy as image to clipboard
      if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) {
        const img = nativeImage.createFromPath(absPath);
        if (!img.isEmpty()) {
          clipboard.writeImage(img);
          return { ok: true };
        }
      }
      
      // For other files, write file path (some apps can paste from this)
      // On Windows, we write the file to clipboard as a file list
      if (process.platform === "win32") {
        // Write as file buffer for apps that support it
        const buffer = fs.readFileSync(absPath);
        clipboard.writeBuffer("FileNameW", Buffer.from(absPath + "\0", "ucs2"));
      }
      
      return { ok: true };
    } catch (err) {
      console.error("[qooti:inspirations:copyToClipboard] Error:", err);
      return { ok: false, error: err.message };
    }
  });

  // Start native file drag (for dragging to external apps, messengers, etc.)
  // Uses a small, framed 64x64 icon for a clean, standard-sized drag preview
  ipcMain.handle("qooti:inspirations:startDrag", async (evt, { storedPath, iconPath }) => {
    try {
      const vault = getVault();
      const absPath = absFromVault(vault.root, storedPath);
      if (!fs.existsSync(absPath)) {
        return { ok: false, error: "File not found" };
      }

      // Source for drag icon: thumbnail or main file (when it's an image)
      let iconSource = null;
      if (iconPath) {
        const iconAbs = absFromVault(vault.root, iconPath);
        if (fs.existsSync(iconAbs)) iconSource = iconAbs;
      }
      if (!iconSource) {
        const ext = extLower(absPath);
        if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) {
          iconSource = absPath;
        }
      }

      const { createDragIcon } = require("./dragIcon");
      const dragIconPath = await createDragIcon(iconSource || absPath, vault.root);
      const finalIcon = dragIconPath || iconSource || absPath;

      evt.sender.startDrag({
        file: absPath,
        icon: finalIcon
      });
      return { ok: true };
    } catch (err) {
      console.error("[qooti:inspirations:startDrag] Error:", err);
      return { ok: false, error: err.message };
    }
  });

  // Open file in external app
  ipcMain.handle("qooti:inspirations:openExternal", async (_evt, { storedPath }) => {
    try {
      const vault = getVault();
      const absPath = absFromVault(vault.root, storedPath);
      
      if (!fs.existsSync(absPath)) {
        return { ok: false, error: "File not found" };
      }
      
      await shell.openPath(absPath);
      return { ok: true };
    } catch (err) {
      console.error("[qooti:inspirations:openExternal] Error:", err);
      return { ok: false, error: err.message };
    }
  });

  // Collections
  ipcMain.handle("qooti:collections:list", async () => {
    const db = getDb();
    return db.prepare(`SELECT * FROM collections ORDER BY updated_at DESC`).all();
  });

  ipcMain.handle("qooti:collections:create", async (_evt, { name }) => {
    const db = getDb();
    const id = uuidv4();
    const ts = nowMs();
    const finalName = String(name || "").trim() || "Untitled collection";
    db.prepare(
      `INSERT INTO collections(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(id, finalName, ts, ts);
    return db.prepare(`SELECT * FROM collections WHERE id = ?`).get(id);
  });

  ipcMain.handle("qooti:collections:rename", async (_evt, { id, name }) => {
    const db = getDb();
    const finalName = String(name || "").trim() || "Untitled collection";
    db.prepare(`UPDATE collections SET name = ?, updated_at = ? WHERE id = ?`).run(
      finalName,
      nowMs(),
      id
    );
    return db.prepare(`SELECT * FROM collections WHERE id = ?`).get(id);
  });

  ipcMain.handle("qooti:collections:delete", async (_evt, { id }) => {
    const db = getDb();
    db.prepare(`DELETE FROM collections WHERE id = ?`).run(id);
    return { ok: true };
  });

  ipcMain.handle("qooti:collections:addItems", async (_evt, { collectionId, inspirationIds }) => {
    const db = getDb();
    const ts = nowMs();
    const ids = Array.isArray(inspirationIds) ? inspirationIds : [];
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO collection_items(collection_id, inspiration_id, position, created_at)
       VALUES (?, ?, NULL, ?)`
    );
    const tx = db.transaction(() => {
      for (const inspId of ids) stmt.run(collectionId, inspId, ts);
      db.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).run(ts, collectionId);
    });
    tx();
    return { ok: true };
  });

  ipcMain.handle(
    "qooti:collections:removeItems",
    async (_evt, { collectionId, inspirationIds }) => {
      const db = getDb();
      const ids = Array.isArray(inspirationIds) ? inspirationIds : [];
      const stmt = db.prepare(`DELETE FROM collection_items WHERE collection_id = ? AND inspiration_id = ?`);
      const tx = db.transaction(() => {
        for (const inspId of ids) stmt.run(collectionId, inspId);
        db.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).run(nowMs(), collectionId);
      });
      tx();
      return { ok: true };
    }
  );

  // Moodboards
  ipcMain.handle("qooti:moodboards:list", async () => {
    const db = getDb();
    return db.prepare(`SELECT * FROM moodboards ORDER BY updated_at DESC`).all();
  });

  ipcMain.handle("qooti:moodboards:create", async (_evt, { name }) => {
    const db = getDb();
    const id = uuidv4();
    const ts = nowMs();
    const finalName = String(name || "").trim() || "Untitled moodboard";
    db.prepare(
      `INSERT INTO moodboards(id, name, canvas_width, canvas_height, created_at, updated_at)
       VALUES (?, ?, 1920, 1080, ?, ?)`
    ).run(id, finalName, ts, ts);
    return db.prepare(`SELECT * FROM moodboards WHERE id = ?`).get(id);
  });

  ipcMain.handle("qooti:moodboards:rename", async (_evt, { id, name }) => {
    const db = getDb();
    const finalName = String(name || "").trim() || "Untitled moodboard";
    db.prepare(`UPDATE moodboards SET name = ?, updated_at = ? WHERE id = ?`).run(
      finalName,
      nowMs(),
      id
    );
    return db.prepare(`SELECT * FROM moodboards WHERE id = ?`).get(id);
  });

  ipcMain.handle("qooti:moodboards:delete", async (_evt, { id }) => {
    const db = getDb();
    db.prepare(`DELETE FROM moodboards WHERE id = ?`).run(id);
    return { ok: true };
  });

  ipcMain.handle("qooti:moodboards:get", async (_evt, { id }) => {
    const db = getDb();
    const vault = getVault();
    const board = db.prepare(`SELECT * FROM moodboards WHERE id = ?`).get(id);
    if (!board) return null;
    const items = db
      .prepare(
        `
          SELECT mi.*, i.thumbnail_path, i.stored_path, i.type AS inspiration_type, i.title AS inspiration_title
          FROM moodboard_items mi
          LEFT JOIN inspirations i ON i.id = mi.inspiration_id
          WHERE mi.moodboard_id = ?
          ORDER BY mi.z_index ASC
        `
      )
      .all(id)
      .map((r) => ({
        ...r,
        inspiration_thumbnail_url: vaultUrl(vault.root, r.thumbnail_path, baseUrl),
        inspiration_stored_url: vaultUrl(vault.root, r.stored_path, baseUrl)
      }));
    return { board, items };
  });

  ipcMain.handle("qooti:moodboards:saveItems", async (_evt, { moodboardId, items }) => {
    const db = getDb();
    const ts = nowMs();
    const list = Array.isArray(items) ? items : [];

    const insert = db.prepare(
      `
        INSERT INTO moodboard_items(
          id, moodboard_id, kind, inspiration_id,
          x, y, scale_x, scale_y, rotation, z_index,
          width, height, text, style_json,
          created_at, updated_at
        ) VALUES (
          @id, @moodboard_id, @kind, @inspiration_id,
          @x, @y, @scale_x, @scale_y, @rotation, @z_index,
          @width, @height, @text, @style_json,
          @created_at, @updated_at
        )
      `
    );
    const wipe = db.prepare(`DELETE FROM moodboard_items WHERE moodboard_id = ?`);

    db.transaction(() => {
      wipe.run(moodboardId);
      for (const it of list) {
        insert.run({
          id: it.id || uuidv4(),
          moodboard_id: moodboardId,
          kind: it.kind,
          inspiration_id: it.inspiration_id || null,
          x: Number(it.x || 0),
          y: Number(it.y || 0),
          scale_x: Number(it.scale_x || 1),
          scale_y: Number(it.scale_y || 1),
          rotation: Number(it.rotation || 0),
          z_index: Number(it.z_index || 0),
          width: it.width == null ? null : Number(it.width),
          height: it.height == null ? null : Number(it.height),
          text: it.text == null ? null : String(it.text),
          style_json: it.style_json == null ? null : String(it.style_json),
          created_at: ts,
          updated_at: ts
        });
      }
      db.prepare(`UPDATE moodboards SET updated_at = ? WHERE id = ?`).run(ts, moodboardId);
    })();

    return { ok: true };
  });

  ipcMain.handle("qooti:moodboards:addInspirations", async (_evt, { moodboardId, inspirationIds }) => {
    const db = getDb();
    const ids = Array.isArray(inspirationIds) ? inspirationIds : [];
    const ts = nowMs();
    const baseZ = db
      .prepare(`SELECT COALESCE(MAX(z_index), 0) AS z FROM moodboard_items WHERE moodboard_id = ?`)
      .get(moodboardId)?.z;

    const insert = db.prepare(
      `
        INSERT INTO moodboard_items(
          id, moodboard_id, kind, inspiration_id,
          x, y, scale_x, scale_y, rotation, z_index,
          width, height, text, style_json,
          created_at, updated_at
        ) VALUES (?, ?, 'inspiration', ?, ?, ?, 1, 1, 0, ?, NULL, NULL, NULL, NULL, ?, ?)
      `
    );

    db.transaction(() => {
      let z = Number(baseZ || 0);
      let offset = 0;
      for (const inspId of ids) {
        z += 1;
        insert.run(uuidv4(), moodboardId, inspId, 200 + offset, 140 + offset, z, ts, ts);
        offset += 24;
      }
      db.prepare(`UPDATE moodboards SET updated_at = ? WHERE id = ?`).run(ts, moodboardId);
    })();

    return { ok: true };
  });

  // Backup handlers are registered in a dedicated module to keep this file focused.
  ipcMain.handle("qooti:backup:export", async () => {
    const win = getMainWindow();
    const vault = getVault();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Export backup",
      defaultPath: path.join(require("node:os").homedir(), `qooti-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.qooti-backup`),
      filters: [{ name: "qooti backup", extensions: ["qooti-backup"] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    // Ensure latest changes are written to disk for backup
    try {
      const db = getDb();
      if (db && typeof db.flushSync === "function") db.flushSync();
    } catch {}

    return exportBackup({ outPath: filePath, vault });
  });

  ipcMain.handle("qooti:backup:import", async () => {
    const win = getMainWindow();
    const vault = getVault();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Import backup",
      properties: ["openFile"],
      filters: [{ name: "qooti backup", extensions: ["qooti-backup", "zip"] }]
    });
    if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
    const inPath = filePaths[0];

    // Close DB before vault replacement
    try {
      const db = getDb();
      closeDb(db);
    } catch {
      // ignore
    }

    const result = await importBackup({ inPath, vault });
    // Reopen and swap DB (always try, even on error/cancel)
    try {
      ensureVault();
      const newDb = await openDb(vault.dbPath);
      if (typeof setDb === "function") setDb(newDb);
    } catch {
      // ignore
    }

    if (result?.ok) {
      const w = getMainWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send("qooti:vault:replaced", { ok: true });
      }
    }
    return result;
  });

  // Window controls
  ipcMain.handle("qooti:window:hide", async () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.hide();
    }
  });

  ipcMain.handle("qooti:window:minimize", async () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) {
        win.restore();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle("qooti:window:close", async () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
}

module.exports = {
  registerIpc
};

