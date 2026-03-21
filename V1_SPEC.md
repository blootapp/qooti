# qooti — v1 Technical Direction & Scope (Local‑First Desktop)

Date: 2026-01-27

This document is the **scope lock** for v1. If a feature is not listed here, it is intentionally **out of scope**.

## Goals (v1)

- **Windows desktop app** packaged as a `.exe` (Electron).
- **Local‑first**: no servers, no cloud dependency, no accounts.
- Single user, non‑collaborative **inspiration vault**:
  - Save inspirations (videos, images, GIFs, links)
  - Organize into collections
  - Create/manage moodboards (desktop-only editing)
- Moodboards are **canvas-based** and saved as **structured data** (not flattened images).
- Provide **manual Export** (single backup file) and **manual Import**.
- Calm, professional UI. **Dark theme by default**.
- Layout is similar to **YouTube homepage** (top bar + left sidebar + main grid feed).

## Explicit Non‑Goals (v1)

- **No licensing** / activation / paywalls / online validation.
- **No auto updates** / forced update logic.
- **No collaboration**, sharing, or social features.
- **No user accounts**.
- **No cloud sync**.
- **No analytics tracking user content**.
- No premature multi-user optimization.

## Tech Stack (required)

- Package manager: **npm**
- UI: **HTML + CSS + JavaScript**
- Desktop runtime: **Electron**
- DB: **SQLite**
- Canvas moodboards: **Konva.js** (recommended for v1)
- Thumbnails:
  - Images/GIFs: **sharp**
  - Videos: **ffmpeg** (bundled via `ffmpeg-static`) + `fluent-ffmpeg`

## Local Data Model

All data is stored locally in the user’s vault directory (under Electron `app.getPath('userData')`):

- `qooti.db` (SQLite database)
- `media/` (managed copies of imported media files)
- `thumbnails/` (cached thumbnail images generated once at ingest)

### Ingest rules (important)

- When a user adds a media file, qooti **copies it** into `media/` and stores a DB record pointing to that managed path.
- Thumbnails are generated **only at ingest** and then **reused forever** until the inspiration is deleted.
- App launch should not regenerate thumbnails.

## Moodboards (desktop-only editing)

- Canvas-based with:
  - Free positioning
  - Scaling
  - Optional notes/labels
- Saved as structured records (DB rows) with object transforms (x/y/scale/rotation/z-index).
- Export/import via backup includes moodboards + items so boards remain editable.

## Backup & Restore (manual)

### Export

- Creates **one file** (e.g. `*.qooti-backup`) containing:
  - `qooti.db`
  - `media/`
  - `thumbnails/`
  - `manifest.json` (schema_version, created_at, app_version)

### Import

- User selects a backup file, app restores vault contents locally.
- If schema migrations exist, they run locally on first open.

## UI Expectations

- **Dark by default**
- Minimal, calm, professional
- Spacing and typography > decoration
- No loud colors, heavy shadows, or “consumer social” styling

### Layout expectations (YouTube-like)

- Top bar: logo, search input, small actions (import/export/settings)
- Left sidebar: nav + collection/moodboard lists
- Main area: grid feed of inspirations (thumbnail cards)

