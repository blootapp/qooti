# Qooti Chrome Extension

Lightweight extension to add images, videos, and links from the browser into the Qooti desktop app.

## Phase 1 (current)

- **Context menu**: Right-click on images, videos, or links → “Add to Qooti”, “Download and add to Qooti”, “Add to Qooti as link”.
- **Desktop bridge**: Sends payloads to the Qooti desktop app at a configurable URL (default `http://127.0.0.1:1420`). If the app is not running, shows a clear notification — no crashes or console spam.
- **Settings**: Options page for display mode (for future hover overlay) and desktop URL.

## Load in Chrome (development)

1. **Icons**  
   From repo root:
   ```bash
   node extension/scripts/copy-icons.js
   ```
   Or copy `assets/icon.png` to `extension/icons/icon.png`.

2. **Load unpacked**  
   - Open `chrome://extensions/`.
   - Enable “Developer mode”.
   - Click “Load unpacked” and select the `extension` folder.

## Desktop app integration

The extension **POST**s JSON to the desktop app. The desktop app must:

- Listen on a configurable URL (default `http://127.0.0.1:1420`).
- Expose a route, e.g. `POST /qooti/add`, that accepts:

```json
{
  "action": "add" | "download" | "link",
  "url": "https://...",
  "pageUrl": "https://...",
  "pageTitle": "...",
  "mediaType": "image" | "video" | "link"
}
```

The desktop app should then call its existing commands (`add_link_inspiration`, `download_video_from_url`, `add_thumbnail_from_url`, etc.) as appropriate. Implementing this HTTP listener in the Tauri app is separate from the extension.

## Permissions

- **contextMenus** — “Add to Qooti” and related items on right-click.
- **storage** — Save settings (display mode, desktop URL).
- **activeTab** — For future screenshot / tab context.
- **notifications** — “Added to Qooti” and “Qooti desktop is not running.”
- **host_permissions**: `http://127.0.0.1/*`, `http://localhost/*`, `<all_urls>` (to fetch media URLs and talk to desktop).

## Roadmap

- **Phase 2**: Hover overlay on media, platform-specific behavior (YouTube, Instagram, TikTok, Pinterest), screenshot tool.
- **Phase 3**: Full settings (shortcuts, per-platform defaults), detection improvements.
