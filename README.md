# qooti (v1)

Local‑first inspiration vault desktop app for Windows.

## What’s included (v1)

- Save inspirations: **images, GIFs, videos, links**
- Organize into **collections**
- **Moodboards** (desktop-only editing) saved as structured data (not flattened images)
- One-time **thumbnail generation on ingest** (cached until deletion)
- **Manual Export / Import** (single backup file) including DB + media + thumbnails
- Dark, calm UI with a YouTube‑like layout (top bar + sidebar + main grid)

## What’s intentionally NOT included (v1)

- Licensing / activation / paywalls
- Auto-updates
- Accounts, cloud sync, collaboration, analytics of user content

## System requirements

**End users (installed app)**

- **OS:** Windows 10 (version 1803 or later) or Windows 11, 64-bit
- **WebView2:** Microsoft Edge WebView2 Runtime (preinstalled on Windows 11; on Windows 10 it may install automatically or can be downloaded from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/))
- **Disk:** Enough free space for the app and your vault (media, thumbnails, database)
- **RAM:** 4 GB or more recommended for large libraries

**Developers (build from source)**

- **Node.js** (npm), for the frontend and build scripts
- **Rust** (1.77+), for the Tauri backend
- **Windows:** Visual Studio Build Tools with “Desktop development with C++”
- **WebView2:** Evergreen Bootstrapper or runtime (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

## Run (dev)

```bash
npm install
npm run dev
```

## Build Windows installer (.exe via NSIS)

```bash
npm run dist
```

Outputs are written to `dist/`.

## Assets

Do not replace these:

- `assets/icon.png` → used for the window and packaged executable icon (converted to `assets/icon.ico` during build)
- `assets/logo.png` → used inside the app UI

