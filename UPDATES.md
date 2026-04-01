# Releasing updates (no source code uploaded)

The app checks for updates at the URL in `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`. You only ever publish **built installers** and **latest.json** (no source).

---

## One-time setup

1. **Create a GitHub repo for releases only** (e.g. `qooti-releases`).  
   No source code—you can add a short README like “Releases only for Qooti desktop app.”

2. **Set the update URL in the app**  
   Edit `src-tauri/tauri.conf.json` and replace `YOUR_USERNAME` in the updater endpoint with your GitHub username (or org):
   ```json
   "endpoints": [
     "https://github.com/YOUR_USERNAME/qooti-releases/releases/latest/download/latest.json"
   ]
   ```
   Then **build** the installer (step 2 below). Every built app will use this URL to check for updates.

---

## Each time you release a new version

### 1. Bump version (optional)

In `src-tauri/tauri.conf.json`, set `"version"` to the new version (e.g. `"0.1.1"`).

### 2. Build the signed installer

From the project root, in PowerShell:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "C:\Users\Windows 11\.tauri\qooti.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your_password"
npm run tauri build
```

Artifacts are in `src-tauri\target\release\bundle\nsis\`:
- `qooti_<version>_x64-setup.exe`
- `qooti_<version>_x64-setup.exe.sig`

### 3. Generate latest.json

```powershell
node scripts/generate-latest-json.js "https://github.com/YOUR_USERNAME/qooti-releases/releases/download/v0.1.0"
```

Use the **tag** of the release you’re about to create (e.g. `v0.1.0`). This writes `latest.json` into the same nsis folder.

### 4. Create a GitHub Release and upload

1. On GitHub, open your **qooti-releases** repo → **Releases** → **Draft a new release**.
2. Tag version: e.g. `v0.1.0` (must match the URL you used in step 3).
3. Upload these three files from `src-tauri\target\release\bundle\nsis\`:
   - `qooti_<version>_x64-setup.exe`
   - `qooti_<version>_x64-setup.exe.sig`
   - `latest.json`
4. Publish the release.

The app’s updater uses `releases/latest/download/latest.json`, so for “latest” to point to this release, either:

- Make this the **latest** release (newest tag), or  
- When you release a newer version later, create a new release and upload a new `latest.json` there; `latest` will then point to that one.

---

## Summary

| Step | What you do |
|------|------------------|
| Once | Create `qooti-releases` repo, set `endpoints` in `tauri.conf.json`, then build once so the app has the correct update URL. |
| Per release | Bump version → build with signing → run `generate-latest-json.js` → create GitHub Release and upload `.exe`, `.sig`, and `latest.json`. |

Source code never needs to be uploaded anywhere.

---

## Building for macOS

**You cannot build the macOS app on Windows.** You need a Mac (or a macOS CI runner).

### On a Mac

1. **Install dependencies**: Node.js, Rust, and [Tauri’s macOS prerequisites](https://v2.tauri.app/start/prerequisites/#macos) (Xcode CLI tools, etc.).

2. **Copy your signing key** to the Mac (or generate a new keypair and update `tauri.conf.json` with the new public key). Same keypair can be used for both Windows and macOS.

3. **Build** (from project root):
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/qooti.key"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your_password"
   npm run tauri build
   ```

4. **Artifacts** are in `src-tauri/target/release/bundle/macos/` (names follow `productName` in `tauri.conf.json`):
   - `Qooti.app.tar.gz`
   - `Qooti.app.tar.gz.sig`

5. **Generate or merge into latest.json**:
   - First time (macOS only):  
     `node scripts/generate-latest-json.js "https://github.com/blootapp/qooti-releases/releases/download/v0.1.0"`
   - To add macOS to an existing Windows release, download the current `latest.json` from the GitHub release, then:
     ```bash
     node scripts/generate-latest-json.js "https://github.com/blootapp/qooti-releases/releases/download/v0.1.0" --merge ./latest.json
     ```
     Upload the new `latest.json` from the macos folder plus the macOS `.tar.gz` and `.sig` to the **same** release.

6. **Optional**: For distribution outside the App Store, you may need to [sign and notarize](https://v2.tauri.app/distribute/sign/macos/) the app with an Apple Developer account so Gatekeeper doesn’t block it.

### One release, both platforms

- Build on **Windows** → upload `.exe`, `.exe.sig`, and `latest.json` (Windows only) to the release.
- Build on **Mac** → run the script with `--merge` and the downloaded `latest.json` → upload the macOS `.app.tar.gz`, `.sig`, and the new merged `latest.json` to the **same** release.  
Then both Windows and Mac users get updates from the same `latest.json`.
