# Electron → Tauri Migration

## Status

The Tauri scaffold is in place and builds successfully. A minimal set of commands is ported.

### ✅ Done

- **Tauri project** – `src-tauri/` with Rust backend
- **Vault** – App data path, vault directories (Rust)
- **Database** – SQLite via rusqlite, schema v3 migrations
- **Commands**:
  - `list_inspirations` – List inspirations with vault URLs
  - `list_collections` – List collections
  - `list_moodboards` – List moodboards
  - `get_app_info` – App info and counts
  - `get_preference` / `set_preference` – User preferences
- **Tauri API bridge** – `src/tauri-api.js` mirrors `window.qooti` for frontend
- **Dev server** – `scripts/dev-server.js` serves `src/` on port 1420
- **Build** – `npm run tauri build` produces MSI and NSIS installers

### ⏳ Remaining (Stubs / Not Ported)

The frontend uses `window.qooti`; unimplemented commands currently reject with "Not implemented in Tauri yet". These still need Rust implementations:

- **Inspirations**: `addInspirationsFromPaths`, `addInspirationsFromFiles`, `addLinkInspiration`, `fetchLinkPreview`, `addThumbnailFromUrl`, `downloadVideoFromUrl`, `updateInspiration`, `deleteInspiration`, `copyFileToClipboard`, `startDragFile`, `openFileExternal`
- **Collections**: `createCollection`, `renameCollection`, `deleteCollection`, `addToCollection`, `removeFromCollection`
- **Moodboards**: `createMoodboard`, `renameMoodboard`, `deleteMoodboard`, `getMoodboard`, `saveMoodboardItems`, `addInspirationsToMoodboard`
- **Backup**: `exportBackup`, `importBackup`
- **Events**: `onThumbnailUpdated`, `onVaultReplaced`, `onDownloadProgress` (Tauri events)

## Run

```bash
# Development
npm run tauri dev

# Build
npm run tauri build
```

Dev server runs on port 1420. If 1420 is in use, change `PORT` in `scripts/dev-server.js` and `devUrl` in `src-tauri/tauri.conf.json`.

## Data Paths

- **Electron**: `%APPDATA%/qooti/vault`
- **Tauri**: `%APPDATA%/com.qooti.desktop/vault`

For migration, copy `%APPDATA%/qooti/vault` to `%APPDATA%/com.qooti.desktop/vault` if you want to reuse existing data.

## Next Steps

1. Port remaining inspiration commands (add, delete, update, etc.)
2. Port collections and moodboards CRUD
3. Port backup (export/import) – likely using Rust crates for zip
4. Port thumbnails (image crate or ffmpeg)
5. Port video download (spawn yt-dlp)
6. Port media dimensions (ffprobe)
7. Remove Electron (`electron/`, preload, main.js, electron-builder config)
