# Qooti — Full Context Document

A single reference for technical, architectural, design, and product context. Read this to understand the app end-to-end.

---

## 1. Product Overview

**Qooti** is a **local-first inspiration vault** — a Windows desktop app for collecting, organizing, and managing media (images, videos, GIFs, links) as inspiration. It supports:

- **Media grid** with search, filters, and pagination
- **Collections** for grouping media
- **Tags** (system, computed, user)
- **History** of recently added items
- **Import flows**: Telegram export folder, Notion export ZIP, .qooti packs, local files, URLs
- **Export packs** (.qooti encrypted format) for sharing/selling
- **Chrome extension** to add media from the web
- **License-based activation** via Cloudflare Worker
- **Notifications** from admin panel

---

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| **Desktop framework** | Tauri 2.x |
| **Backend** | Rust (edition 2021) |
| **Frontend** | Vanilla HTML/CSS/JS (no React/Vue) |
| **Database** | SQLite (rusqlite, bundled) |
| **Build** | Node.js scripts, NSIS (Windows installer) |
| **License/Admin API** | Cloudflare Worker + D1 |
| **Extension** | Chrome Manifest V3 |

### Key Rust Dependencies

- `tauri`, `tauri-plugin-*` (dialog, shell, fs, notification, log)
- `rusqlite` (bundled SQLite)
- `reqwest` (blocking HTTP)
- `serde`, `serde_json`
- `uuid`, `regex`, `url`, `urlencoding`
- `image`, `palette`, `color-thief` (image processing)
- `zip`, `aes-gcm`, `sha2`, `base64` (pack encryption)
- `tiny_http` (extension server)

### Key Frontend Dependencies

- `@tauri-apps/api`
- `cropperjs` (profile image crop)
- `remixicon` (icons)
- `sharp`, `png-to-ico` (icon generation)
- `youtube-dl-exec`, `ffmpeg-static`, `fluent-ffmpeg` (video)
- `archiver`, `extract-zip` (archives)

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Qooti Desktop App                         │
├─────────────────────────────────────────────────────────────────┤
│  Frontend (HTML/CSS/JS)                                          │
│  - index.html, renderer.js, styles.css, tauri-api.js             │
│  - Views: grid, collections, history, settings, license, profile  │
│  - Modals: add media, migration, export pack, notifications      │
├─────────────────────────────────────────────────────────────────┤
│  Tauri IPC (invoke)                                              │
├─────────────────────────────────────────────────────────────────┤
│  Rust Backend (commands.rs, db.rs, vault.rs, pack.rs, etc.)      │
│  - SQLite DB, vault (media/thumbs), extension server             │
├─────────────────────────────────────────────────────────────────┤
│  Local HTTP :1420 (extension connection)                         │
└─────────────────────────────────────────────────────────────────┘
         │                                    │
         │ POST /license/validate              │ GET /app/notifications
         │ GET /license/status                 │
         ▼                                    ▼
┌─────────────────────────────┐    ┌─────────────────────────────┐
│   Cloudflare Worker         │    │   Chrome Extension          │
│   - License validation      │    │   - content.js (media detect)│
│   - Admin panel API         │    │   - background.js            │
│   - Notifications (D1)      │    │   - Sends to localhost:1420  │
└─────────────────────────────┘    └─────────────────────────────┘
```

---

## 4. Project Structure

```
qooti/
├── src/                          # Frontend (served as dev/build)
│   ├── index.html                # Main app shell
│   ├── renderer.js               # UI logic, state, event handlers
│   ├── styles.css                # Global styles, design tokens
│   ├── tauri-api.js              # Tauri invoke wrapper, event bridges
│   └── assets/
│       ├── icons/remix/           # Remix Icon SVGs
│       ├── icons/flaticon/       # Flaticon SVGs
│       ├── logo.png
│       └── tutorial-videos.json  # YouTube URLs for migration modals
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                # Tauri setup, command registration
│   │   ├── main.rs               # Entry
│   │   ├── commands.rs           # All Tauri commands (large)
│   │   ├── db.rs                 # SQLite schema, migrations
│   │   ├── vault.rs              # Vault paths, ensure dirs
│   │   ├── pack.rs               # .qooti export/import (AES-256-GCM)
│   │   ├── palette.rs            # Color extraction
│   │   ├── tags.rs               # Tag helpers
│   │   └── extension_server.rs   # Local HTTP server for extension
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   └── windows-file-assoc-hooks.nsh  # NSIS .qooti file association
├── extension/                    # Chrome extension
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html, options.html
│   └── icons/
├── worker/                       # Cloudflare Worker
│   ├── src/index.js              # License + admin + notifications API
│   ├── wrangler.toml
│   └── migrations/               # D1 migrations
├── admin/                        # Web admin panel (HTML/JS)
├── assets/                       # App icons, qooti-pack-icon
├── scripts/                      # copy-assets, prepare-ytdlp, dev-server
├── qooti-modal-design-system.md  # Modal design spec
└── context.md                    # This file
```

---

## 5. Database Schema (SQLite)

**Location**: `%APPDATA%/com.qooti.desktop/vault/qooti.db` (or legacy `%APPDATA%/qooti/vault/qooti.db`)

**Schema version**: 9

### Core Tables

| Table | Purpose |
|-------|---------|
| `inspirations` | Media items (image, gif, video, link). Columns: id, type, title, source_url, original_filename, stored_path, thumbnail_path, display_row, aspect_ratio, palette, created_at, updated_at |
| `collections` | Named groups. Columns: id, name, created_at, updated_at |
| `collection_items` | Many-to-many: collection_id, inspiration_id, position, created_at |
| `tags` | Labels with type and origin (system/computed/user) |
| `inspiration_tags` | Many-to-many: inspiration_id, tag_id |
| `moodboards` | Canvas boards (width, height) |
| `moodboard_items` | Items on moodboards (inspiration or text) |
| `preferences` | Key-value (theme, extension_connection_key, profileName, profileImageDataUrl, etc.) |
| `license_cache` | Cached license validation (license_key, plan_type, expires_at, last_validated_at) |
| `notifications` | Local notification cache (id, title, message, youtube_url, button_text, button_link, is_active, created_at, expires_at) |
| `notification_reads` | Local read state (notification_id, user_id, read_at) |
| `meta` | Schema version, etc. |

### Indexes

- `idx_inspirations_created_at` (created_at DESC)
- `idx_notifications_active_created`
- `idx_tags_label_type`
- Others for collections, tags, etc.

---

## 6. Vault & Storage

**VaultPaths** (from `vault.rs`):

- `root`: `%APPDATA%/com.qooti.desktop/vault` (or legacy path)
- `db_path`: `root/qooti.db`
- `media_dir`: `root/media` — stored media files
- `thumbs_dir`: `root/thumbnails` — generated thumbnails
- `collection_profiles`: `root/collection_profiles` — collection cover images

Media files are stored as `{uuid}.{ext}`. Thumbnails as `{id}.jpg` or similar.

---

## 7. Backend Commands (Tauri IPC)

All exposed via `tauri::generate_handler!` in `lib.rs`. Frontend calls via `window.qooti.*` (tauri-api.js).

### Media & Inspirations

- `list_inspirations` — Grid view, supports collection filter, query, pagination
- `list_inspirations_history` — History view, cursor-based pagination
- `add_inspirations_from_paths`, `add_inspirations_from_files`, `import_media_from_paths`
- `add_thumbnail_from_url`, `add_media_from_url`, `add_thumbnail_from_video_url`
- `add_link_inspiration`, `download_video_from_url`
- `delete_inspiration`, `clear_all_media`
- `update_inspiration`, `extract_palette`, `find_similar`

### Collections

- `list_collections`, `create_collection`, `rename_collection`, `delete_collection`
- `set_collection_profile_image`
- `add_to_collection`, `remove_from_collection`, `get_collections_for_inspiration`

### Pack Export/Import

- `export_collection_as_pack`, `select_collection_pack_file`
- `inspect_collection_pack`, `import_collection_pack`

### Import Flows

- **Telegram**: `select_telegram_export_folder`, `inspect_telegram_export`, `import_telegram_export` — emits `telegram-import-progress`
- **Notion ZIP**: `select_notion_export_zip`, `inspect_notion_export_zip`, `import_notion_export_zip` — emits `notion-import-progress`
- **Notion URL** (legacy): `fetch_notion_gallery` — scrapes public Notion pages via API

### License & Settings

- `get_license_cache`, `validate_license`, `refresh_license_status`, `clear_license_cache`
- `get_preference`, `set_preference`, `get_settings`

### Notifications

- `list_notifications` — Fetches from Cloudflare Worker, caches locally
- `get_unread_notification_count`, `mark_notifications_read`
- `create_admin_notification` (dev)

### Window & System

- `window_close`, `window_minimize`, `window_maximize`, `window_unmaximize`, `window_is_maximized`
- `open_folder`, `open_external_url`
- `get_app_info`, `get_absolute_path_for_file`

### Extension

- `get_extension_connection_status`, `get_extension_key_for_copy`, `regenerate_extension_key`
- `get_extension_pending` — Polls queue from extension server

### Link Preview & Fetch

- `fetch_link_preview` — Fetches Open Graph / meta for URLs

---

## 8. Frontend Structure

### Views (state.view)

- `grid` — Main media grid
- `collection:{id}` — Collection view
- `collections` — Collections page
- `history` — History page
- `settings` — Settings (tabs: Interface, Downloads, Related, Tags, Data, Extension, License)

### State (renderer.js)

- `state.view`, `state.query`, `state.selected`, `state.collections`, `state.inspirations`
- `state.currentCollectionId`, `state.currentCollectionName`
- `state.settings`, `state.notifications`

### Key UI Patterns

- **Add Media**: Modal with local files, .qooti, Telegram, Notion, URL
- **Migration modals**: Adaptive — modal on large window, full-page on small (threshold ~1100×700)
- **Progress**: Event-driven (`qooti:telegram-import-progress`, `qooti:notion-import-progress`) for live `current/total` and `%`
- **Search bar**: `delall` + Enter clears all media (destructive, no confirm)
- **Profile**: Avatar + dropdown (Settings tabs, Migrate, History, etc.)

---

## 9. Design System

### Color Tokens (:root)

- **Background**: `--bg: #060709`, `--panel: #07080b`
- **Text**: `--text: #e7eaf0`, `--muted: #9aa3b2`
- **Borders**: `--border`, `--hairline`
- **Accent**: `--accent: #e7eaf0`
- **Modal**: `--modal-bg`, `--modal-border`, `--modal-divider`, `--modal-surface`, `--modal-overlay-bg`
- **Buttons**: `--btn-cancel-bg`, `--btn-primary-bg`, etc.
- **Feedback**: `--feedback-success`, `--feedback-error`, etc.

### Typography

- Font stack: `ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, ...`
- Motion: `--motion-fast: 100ms`, `--motion-modal: 180ms`, `--motion-dropdown: 150ms`

### Modal Design

See `qooti-modal-design-system.md` for full spec. Key points:

- macOS-inspired dark UI
- Mini-window (620px) when app maximized; full-cover when windowed
- Traffic lights: green (maximize), red (close) — no yellow
- Section labels, step lists, tutorial cards, footnote notes

---

## 10. Pack System (.qooti)

- **Format**: Encrypted ZIP (AES-256-GCM), magic `QOOTIPK1`
- **Contents**: manifest.json, profile image, media files
- **Manifest**: pack_id, pack_version, format_version, exported_at, signature, collection name, items (original_id, type, filename, content_hash, tags, palette, metadata)
- **File association**: Windows ProgID, custom icon `qooti-pack-icon.ico`
- **Naming**: Letters, numbers, dash, single spaces; max 50 chars

---

## 11. Import Flows

### Telegram

1. User exports chat from Telegram Desktop (with media)
2. Select folder via `select_telegram_export_folder`
3. Parse `result.json`, collect media from `photos/`, `video_files/`, `files/`
4. Optional: create collection, add to existing, or none
5. Copy files to vault, insert inspirations, apply tags (telegram, media type, orientation)
6. Progress events: `stage`, `status`, `current`, `total`, `percent`

### Notion Export ZIP

1. User exports Notion page (Markdown & CSV, include files)
2. Select ZIP via `select_notion_export_zip`
3. Extract recursively (including nested ZIPs), collect media files
4. Optional: save as collection
5. Add each file via `add_inspirations_from_paths_impl`, emit progress per item
6. Progress events: same structure as Telegram

### Notion URL (Legacy)

- `fetch_notion_gallery` — Uses Notion's internal API (`loadPageChunk`, `queryCollection`) to traverse pages and extract media URLs. Limited by Notion's restrictions on direct media download.

---

## 12. Chrome Extension

- **Manifest V3**, content script on `<all_urls>`
- **Connection**: Sends `X-Qooti-Key` header to `http://127.0.0.1:1420`
- **Endpoints**: `/qooti/handshake`, `/qooti/add` (POST JSON: url, title, type, platform, etc.)
- **Desktop**: `extension_server.rs` runs tiny_http on port 1420, validates key from `preferences`, queues payloads
- **App**: Polls `get_extension_pending`, processes queue (download, add to inspirations)

---

## 13. Cloudflare Worker

- **D1**: `qooti` database — licenses, admin_logs, notifications
- **Routes**:
  - `POST /license/validate`, `GET /license/status` — App license check
  - `GET/POST/PATCH/DELETE /admin/licenses` — Admin license CRUD
  - `GET /admin/logs`, `POST /admin/notifications`
  - `GET /app/notifications` — App fetches latest 5 active notifications
- **Secrets**: `ADMIN_SECRET` for admin routes
- **Deploy**: `wrangler deploy` (from project root, uses `worker/wrangler.toml`)

---

## 14. License System

- **Key format**: `QOOTI-XXXX-XXXX-XXXX`
- **Flow**: App calls `validate_license` / `refresh_license_status` → Worker → D1
- **Cache**: `license_cache` table (license_key, plan_type, expires_at, last_validated_at)
- **Boot**: License check before showing main app; invalid → license activation view
- **Timeouts**: connect 5s, total 8–10s

---

## 15. Build & Run

```bash
# Dev
npm run dev          # Tauri dev (starts dev server, copies assets, prepares yt-dlp)

# Build
npm run tauri:build  # or npm run pack / dist

# Extension
# Load extension/ as unpacked in Chrome

# Worker
cd worker && npx wrangler deploy
# Migrations: npx wrangler d1 migrations apply qooti --config wrangler.toml
```

### Before Dev/Build

- `node scripts/copy-assets.js` — Copies assets to src
- `node scripts/prepare-ytdlp.js` — Ensures yt-dlp.exe in place
- `node scripts/dev-server.js` — Dev server on 1421 (dev only)

---

## 16. Configuration Files

| File | Purpose |
|------|---------|
| `tauri.conf.json` | Window size, decorations, file associations, resources |
| `package.json` | Scripts, deps, Electron build config (legacy) |
| `worker/wrangler.toml` | Worker name, D1 binding, migrations dir |
| `extension/manifest.json` | Permissions, content scripts, host_permissions |

---

## 17. Hidden / Easter Egg Commands

- **Search bar**: Type `delall` and press Enter → clears all media, collections, tags, and vault files (no confirmation)

---

## 18. Tutorial Videos

Stored in `src/assets/tutorial-videos.json`:

```json
{
  "telegramMigration": "https://www.youtube.com/watch?v=..."
}
```

Used in migration modals; Notion tutorial URL is hardcoded in `buildNotionImportBodyHTML`.

---

*Last updated from codebase snapshot. For modal design details, see `qooti-modal-design-system.md`.*
