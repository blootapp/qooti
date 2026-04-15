# Cross-platform QA checklist (Windows + macOS)

Use this after meaningful changes. Record date, git SHA, OS version, and pass/fail per row.

## Automated gates

- [ ] PR / CI: `PR smoke` workflow green (Rust tests + `cargo test` on Windows + Linux).
- [ ] Release matrix: Windows + macOS builds succeed (see `.github/workflows/release.yml`).
- [ ] Local: `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] Bundled yt-dlp: `npm run verify:resources` (or match CI download step for your OS)

## Platform-split behavior (Rust)

| Check | Windows | macOS |
|--------|---------|-------|
| Open vault folder | | |
| Open external https URL | | |
| Copy file to clipboard (incl. path with spaces) | | |

## Core flows (both OS)

- [ ] Create collection, add images/links, search
- [ ] OCR indexing; text persists / searchable
- [ ] Export `.qooti` pack, import elsewhere; tags, palette, **OCR** round-trip
- [ ] Store: browse, download/install collection, thumbnails
- [ ] Optional: one video or link capture (yt-dlp / ffmpeg path)

## Notes

- Tao log `RedrawEventsCleared emitted without explicit MainEventsCleared` on Windows is often benign unless tied to a reproducible UI bug.

## Test run log

| Date | SHA | OS | Tester | Result |
|------|-----|----|--------|--------|
| | | | | |
