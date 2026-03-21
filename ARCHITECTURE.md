# qooti — v1 Architecture

## Process Model

- Electron **main process**:
  - Owns the vault directory (paths)
  - Owns SQLite DB connection
  - Performs file IO (copy media, write thumbnails)
  - Performs thumbnail generation (sharp/ffmpeg)
  - Performs backup export/import
  - Exposes a small IPC API to the renderer

- Electron **renderer process**:
  - HTML/CSS/JS UI
  - Requests data/actions via preload-exposed IPC methods
  - Renders inspiration grid + moodboard canvas

## Directory Structure (v1)

Suggested structure:

- `electron/`
  - `main.js` (main process entry)
  - `preload.js` (IPC bridge)
  - `ipc/` (request handlers)
  - `db/` (sqlite open + schema/migrations)
  - `vault/` (paths + file ops)
  - `thumbs/` (thumbnail pipeline)
  - `backup/` (export/import)
- `src/`
  - `index.html`
  - `styles.css`
  - `renderer.js`
  - `ui/` (small JS modules, no framework)
- `assets/` (provided icon/logo; do not replace)

## IPC API (v1)

The renderer should not touch filesystem or sqlite directly.

Example capabilities:

- `vault.getInfo()` → vault path, counts
- `inspirations.list({ query, collectionId })`
- `inspirations.addFromFiles()` (opens file dialog in main)
- `inspirations.addLink(url)`
- `collections.list() / create() / rename() / delete()`
- `moodboards.list() / create() / get(id) / saveItems(id, items)`
- `backup.export()` (save dialog)
- `backup.import()` (open dialog)
- `preferences.getAll() / set(key, value)`

## Thumbnail Pipeline (v1)

### Key rule

Generate thumbnails **once** at ingest. Reuse forever until deletion.

### Image/GIF

- Use `sharp` to:
  - read first frame
  - resize/crop to a consistent card aspect (e.g. 16:9 or 4:3)
  - output `jpg` or `webp`

### Video

- Use `ffmpeg-static` path with `fluent-ffmpeg`.
- Capture a single frame (e.g. 1s) and scale to card size.

### Queueing

- Ingest adds DB row immediately.
- Thumbnail generation runs in a small queue to avoid UI freezes.
- UI shows placeholder until `thumbnail_path` becomes available.

## Database (SQLite)

SQLite tables:

- `meta` (schema_version)
- `preferences`
- `inspirations`
- `collections`
- `collection_items`
- `moodboards`
- `moodboard_items`

All schema changes must be handled via migrations with a schema version number.

