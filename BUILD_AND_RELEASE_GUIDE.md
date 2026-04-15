# Qooti Build And Release Guide

This guide is the current step-by-step process for:

- making code changes
- bumping the version correctly
- building the Windows installer
- generating the correct `latest.json`
- publishing the GitHub release
- verifying that older installed versions detect the update

It is written to prevent the exact release problems we already hit, especially:

- forgetting to regenerate `latest.json`
- uploading an old `latest.json` to a new GitHub release
- version mismatch between app files
- signing problems during Tauri build

This guide assumes:

- **Source + CI:** [`blootapp/qooti`](https://github.com/blootapp/qooti) — code is pushed here (e.g. `main`); **Build macOS** runs on this repo and produces the `macos-build` artifact.
- **Distribution:** [`blootapp/qooti-releases`](https://github.com/blootapp/qooti-releases/releases) — after a successful local Windows build + mac CI artifact download, the operator **manually** creates a new release tag (`v<version>`) and uploads **all** files from `release-assets/v<version>/`. Nothing in this flow relies on `qooti-releases` CI to publish binaries.
- Windows installer is built **locally** (signed NSIS).
- macOS bundles are built in **GitHub Actions** on `blootapp/qooti`.
- Updater endpoint in app config stays:
  - `https://github.com/blootapp/qooti-releases/releases/latest/download/latest.json`

## When the user says “build the app” (do this every time)

Treat this as a **full release prep** unless the user explicitly names an exception (for example: Windows-only hotfix, skip push, or dry run).

**Do not ask clarifying questions** about the default flow. Execute it. Only stop and ask if something is **actually missing** (for example: private key file not at the expected path, `gh` not authenticated, or GitHub Actions cannot start jobs due to org billing).

### Required sequence

1. **Bump the version** everywhere it must match (see [section 2](#2-files-that-must-be-version-bumped)). After bumping Rust, run a build or `cargo update` as needed so `src-tauri/Cargo.lock` stays consistent with `src-tauri/Cargo.toml`.
2. **Commit and push** the version bump and any release changes to **`blootapp/qooti` `main`** (or the branch the macOS workflow uses). The machine’s `git HEAD` should match what CI will build before you rely on the automated folder step.
3. **Signing**
   - **Windows (local NSIS + updater `.sig`):** set `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when building. On the usual dev PC the key file is at `C:\Users\Windows 11\.tauri\qooti.key`. If that path does not exist, **ask** for the correct path. **Never commit passwords or key material to this repository**; use environment variables or another secret channel the operator uses for the agent session.
   - **macOS (CI):** the `Build macOS` workflow on `blootapp/qooti` uses repository secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Use the **same Tauri keypair** as on Windows so updater signatures match. For this project, **`APPLE_CERTIFICATE_PASSWORD` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are set to the same password value** (Apple `.p12` unlock password and Tauri key password).
   - **Windows key path (confirmed):** `C:\Users\Windows 11\.tauri\qooti.key` — use this path unless the machine layout changes.
4. **Build Windows** with signing (see [section 3](#3-build-the-installer)). Confirm both `Qooti_<version>_x64-setup.exe` and `Qooti_<version>_x64-setup.exe.sig` exist under `src-tauri/target/release/bundle/nsis/`.
5. **`latest.json` for Windows + macOS:** do **not** stop at a Windows-only manifest. After the Windows build exists, run the automated step that pulls the macOS GitHub Actions artifact and merges platforms:

   ```bash
   npm run release:github-upload-folder
   ```

   This runs `scripts/prepare-github-release-folder.js`: dispatches or follows **`Build macOS`**, waits for success, downloads the **`macos-build`** artifact, runs `generate-latest-json.js` with **`--macos-bundle-dir`**, and copies **everything to upload** into **`release-assets/v<version>/`** (Windows `.exe` + `.sig`, macOS `.app.tar.gz` + `.sig`, DMGs from the artifact, and merged **`latest.json`**).

   If Actions cannot run (billing, disabled workflows), say so clearly; you cannot fabricate mac assets locally without a Mac build.

6. **Publish (manual):** upload **every** file from `release-assets/v<version>/` to **[`blootapp/qooti-releases` releases](https://github.com/blootapp/qooti-releases/releases)** — create a **new tag** `v<version>`, attach the assets, and set **Latest** when appropriate. Pushing to `blootapp/qooti` only triggers CI; it does **not** replace this upload step.

### Quick reference: signing env (Windows local build)

```cmd
cmd /c "set TAURI_SIGNING_PRIVATE_KEY=C:\Users\Windows 11\.tauri\qooti.key&& set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%TAURI_SIGNING_PRIVATE_KEY_PASSWORD%&& npm run tauri build -- --bundles nsis"
```

Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the shell **before** running the line above, or substitute a secure value for the placeholder—**do not** paste passwords into committed docs or source files.

## What we did for v0.1.0 (working path)

This is the exact path that worked after debugging CI failures:

1. Bumped app version in all required files:
   - `package.json`
   - `package-lock.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Built Windows installer locally with updater signing key:
   - produced `.exe` and `.sig`
3. Updated release workflows to support macOS-specific config and reliable CI:
   - `--config src-tauri/tauri.macos.conf.json` for mac builds
   - valid rust targets for universal mac build:
     - `x86_64-apple-darwin,aarch64-apple-darwin`
   - release workflow permissions:
     - `permissions: contents: write`
   - `strategy.fail-fast: false` to avoid canceling Windows when macOS fails
4. Restored Apple certificate signing in CI with explicit validation:
   - required repo secrets:
     - `APPLE_CERTIFICATE`
     - `APPLE_CERTIFICATE_PASSWORD`
     - `TAURI_SIGNING_PRIVATE_KEY`
     - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
5. Triggered release by pushing tag `v0.1.0`.
6. Verified release assets include both:
   - Windows installer: `Qooti_0.1.0_x64-setup.exe`
   - macOS installer: `Qooti_0.1.0_universal.dmg`

## Release checklist

Do these in order (same as [“build the app”](#when-the-user-says-build-the-app-do-this-every-time) unless the user narrows scope):

1. Finish code changes.
2. Bump the version in all required files (and keep `src-tauri/Cargo.lock` aligned).
3. Commit and push to `blootapp/qooti` `main`.
4. Build the **signed** NSIS installer locally (Windows).
5. Run **`npm run release:github-upload-folder`** so `latest.json` includes **Windows and macOS** and all upload files land in **`release-assets/v<version>/`**.
6. Verify the contents of `latest.json` (version, URLs, signatures).
7. **Manually** upload everything in `release-assets/v<version>/` to **[`blootapp/qooti-releases`](https://github.com/blootapp/qooti-releases/releases)** — new release, new tag **`v<version>`**, all assets attached.
8. Test update detection from the previous installed version.

If one step is skipped, the updater can silently fail.

## 1. Before building

Make sure:

- the app runs correctly in dev if the change needs runtime verification
- the version you are about to release is decided in advance
- you know which previously released version should detect this new update

For example:

- installed app on user machine: `0.1.1`
- new release to publish: `0.1.2`

In that case, the updater should report that `0.1.2` is available.

## 2. Files that must be version-bumped

Every release must keep these files aligned.

Update all of them to the same version:

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Example for release `0.1.2`:

```json
// package.json
"version": "0.1.2"
```

```json
// package-lock.json
"version": "0.1.2"
```

```json
// package-lock.json -> packages[""]
"version": "0.1.2"
```

```json
// src-tauri/tauri.conf.json
"version": "0.1.2"
```

```toml
# src-tauri/Cargo.toml
version = "0.1.2"
```

## 3. Build the installer

Qooti uses Tauri + NSIS on Windows.

Build command:

```cmd
cmd /c "set TAURI_SIGNING_PRIVATE_KEY=C:\Users\Windows 11\.tauri\qooti.key&& set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%TAURI_SIGNING_PRIVATE_KEY_PASSWORD%&& npm run tauri build -- --bundles nsis"
```

Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the environment first (do not commit it).

Notes:

- Use `cmd /c` exactly like this if you want the least fragile Windows command.
- This command has already worked correctly in this project.
- Do not rely on an incorrectly formatted PowerShell one-liner.
- The build must complete with both:
  - installer output
  - updater signature output

Expected output files:

- `src-tauri/target/release/bundle/nsis/qooti_<version>_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/qooti_<version>_x64-setup.exe.sig`

Example:

- `src-tauri/target/release/bundle/nsis/qooti_0.1.2_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/qooti_0.1.2_x64-setup.exe.sig`

## 4. Generate `latest.json` after every build

This is the most important rule.

You must regenerate `latest.json` after every new version build.

If you do not regenerate it, GitHub may still serve an old manifest that points to the previous version, and the updater will say:

- `check_no_update`

even though the new installer is already uploaded.

### Preferred: Windows + macOS (merged manifest)

After the signed Windows NSIS build exists, run:

```bash
npm run release:github-upload-folder
```

That script ends by running `generate-latest-json.js` with **`--macos-bundle-dir`** so **`latest.json` lists `windows-x86_64` and all required `darwin-*` entries**. The merged file is written next to the NSIS outputs and copied into **`release-assets/v<version>/`**.

### Manual: Windows only (avoid for full releases)

```powershell
node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.2
```

Replace `v0.1.2` with the tag you are publishing. Use this only when you intentionally skip macOS for that release.

Important:

- the tag in the URL must match the version in `src-tauri/tauri.conf.json`
- if the app version is `0.1.2`, the URL must end with `/v0.1.2`

The script writes:

- `src-tauri/target/release/bundle/nsis/latest.json`

## 5. Verify `latest.json` before uploading it

Never upload `latest.json` blindly.

Open the generated file and verify:

1. `version` is the new version
2. the download `url` points to the new tag
3. the download `url` points to the new installer filename
4. the signature belongs to the new `.sig` file

Example of a correct `0.1.2` manifest:

```json
{
  "version": "0.1.2",
  "notes": "",
  "pub_date": "2026-03-20T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "FULL_SIG_CONTENT_HERE",
      "url": "https://github.com/blootapp/qooti-releases/releases/download/v0.1.2/qooti_0.1.2_x64-setup.exe"
    }
  }
}
```

### Wrong example

This is the exact kind of broken manifest that causes update detection failure:

```json
{
  "version": "0.1.1",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/blootapp/qooti-releases/releases/download/v0.1.1/qooti_0.1.1_x64-setup.exe"
    }
  }
}
```

If installed app version is already `0.1.1`, Tauri sees no newer version and logs:

```text
[qooti][updater] check_no_update
```

## 6. Copy all release files to one folder (after build)

When the build (and any manifest step) is finished, copy **every** file you need for distribution, backup, or upload into a **single staging folder** under the repo. That way nothing is scattered across `target/` paths.

**Canonical location:** `release-assets/v<version>/`  
Example: `release-assets/v0.1.0/`

**Default way to populate it:** run **`npm run release:github-upload-folder`** (see [section 4](#4-generate-latestjson-after-every-build)). Do not hand-copy unless you have a deliberate reason.

### What ends up in `release-assets/v<version>/` (full release)

| Artifact | Typical source |
|----------|----------------|
| Windows installer | `src-tauri/target/release/bundle/nsis/Qooti_<version>_x64-setup.exe` |
| Windows updater signature | Same folder: `Qooti_<version>_x64-setup.exe.sig` |
| macOS updater bundle + sig | From downloaded **`macos-build`** artifact (`*.app.tar.gz` + `.sig`) |
| macOS DMG (optional upload) | From same artifact under `.../bundle/dmg/` |
| Merged `latest.json` | From `prepare-github-release-folder.js` / `generate-latest-json.js` |

Adjust filenames if your build uses different casing; always match what `tauri build` actually produced.

### Fallback: after a local Windows build only (no macOS in manifest)

Run once a Windows-only `latest.json` exists next to the NSIS outputs:

```powershell
$v = "0.1.2"
$dest = "release-assets/v$v"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "src-tauri\target\release\bundle\nsis\Qooti_${v}_x64-setup.exe" $dest
Copy-Item "src-tauri\target\release\bundle\nsis\Qooti_${v}_x64-setup.exe.sig" $dest
Copy-Item "src-tauri\target\release\bundle\nsis\latest.json" $dest
```

### After a full GitHub Actions release (Windows + macOS)

Download the full release into one folder (no need to hunt paths on runners):

```powershell
New-Item -ItemType Directory -Force -Path "release-assets/v0.1.0" | Out-Null
gh release download v0.1.0 --repo blootapp/qooti --dir "release-assets/v0.1.0"
```

That pulls `latest.json`, `.exe`, `.dmg`, `.tar.gz`, and `.sig` files together.

**Do not** commit large binaries to git unless you intend to version them; keep `release-assets/` as a local staging area.

## 7. GitHub: two repos

### `blootapp/qooti` (code + macOS CI)

- Push version bumps and code here so **`Build macOS`** can run and produce **`macos-build`**.

**Secrets** on `blootapp/qooti` (mac signing + updater `.sig`):

- `APPLE_CERTIFICATE` (single-line base64 of `.p12`)
- `APPLE_CERTIFICATE_PASSWORD`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

For this project, **`APPLE_CERTIFICATE_PASSWORD` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` use the same password value.**

If `APPLE_CERTIFICATE` or either password secret is missing/empty, macOS signing fails before upload.

**`release.yml` on `qooti` (if present):** any workflow that builds/releases from this repo needs `permissions: contents: write` where `tauri-action` uploads artifacts; without it you may see `Resource not accessible by integration`. That is separate from **`qooti-releases`**, which is filled **by hand** below.

### `blootapp/qooti-releases` (downloads users get — manual upload)

End users and the updater pull assets from **[Releases · blootapp/qooti-releases](https://github.com/blootapp/qooti-releases/releases)**.

For each new version, **after** `release-assets/v<version>/` is complete:

1. Open **New release** on `qooti-releases`.
2. Create tag **`v<version>`** (e.g. `v0.1.2`) and title as you prefer.
3. Upload **all** files from `release-assets/v<version>/` (`.exe`, `.sig`, `.app.tar.gz`, `.sig`, `.dmg` if any, **`latest.json`**).
4. Publish; set **Latest** when this is the current production release.

### Asset upload rule

The three uploaded files must belong to the same version.

Never mix:

- installer from `0.1.2`
- signature from `0.1.2`
- `latest.json` from `0.1.1`

That mismatch is enough to break updater detection or download/install flow.

## 8. Release order that should always be followed

Always follow this exact order:

1. Bump versions (and `Cargo.lock` if needed).
2. Push to GitHub `main`.
3. Build signed Windows NSIS installer.
4. Run **`npm run release:github-upload-folder`** (merged `latest.json` + fill `release-assets/v<version>/`).
5. Inspect `latest.json` and the staging folder.
6. **Manually** upload **everything** in `release-assets/v<version>/` to [`blootapp/qooti-releases`](https://github.com/blootapp/qooti-releases/releases) (new tag `v<version>`).
7. Test update from previous installed version.

Do not upload assets before generating the new manifest.

## 9. Post-release verification

After publishing the release, test with an already installed previous version.

Example:

- machine currently has `0.1.1`
- GitHub latest release is `0.1.2`

Expected behavior:

1. open Qooti `0.1.1`
2. click `Check for updates`
3. updater should detect `0.1.2`
4. updater should download the installer in background
5. app should move into the ready/install flow

### What to inspect if update is not detected

If logs show:

```text
[qooti][updater] check_started ...
[qooti][updater] check_no_update ...
```

then first inspect `latest.json`.

Most likely causes:

- `latest.json` still says old version
- `latest.json` still points to old release tag
- `latest.json` still points to old installer filename
- uploaded `latest.json` was not replaced on GitHub

If logs show download failure:

- check that the URL inside `latest.json` exists
- check that the uploaded asset filename matches exactly
- check that the `.sig` file matches the uploaded installer

## 10. Common mistakes and how to avoid them

### Mistake 1: Building new installer but not regenerating `latest.json`

Symptom:

- old version does not detect update
- updater logs `check_no_update`

Fix:

- rerun `generate-latest-json.js` with the new tag
- reupload `latest.json`

### Mistake 2: Wrong release base URL passed to the generator

Symptom:

- wrong file URL inside `latest.json`
- update download fails

Correct pattern:

```powershell
node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.2
```

Wrong pattern examples:

- using `v0.1.1` for a `0.1.2` release
- using a URL that does not end in the matching tag

### Mistake 3: Only bumping some version files

Symptom:

- installer/build metadata mismatch
- confusion about what version was actually built

Fix:

- always update all four version files together

### Mistake 4: Signing env variables set incorrectly

Symptom:

- installer builds
- updater signature step fails
- build says private key not found

Use the working command from this guide:

```cmd
cmd /c "set TAURI_SIGNING_PRIVATE_KEY=C:\Users\Windows 11\.tauri\qooti.key&& set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%TAURI_SIGNING_PRIVATE_KEY_PASSWORD%&& npm run tauri build -- --bundles nsis"
```

### Mistake 5: Uploading old assets to the newest release

Symptom:

- release page looks correct visually
- updater behavior is wrong

Fix:

- always compare filenames in GitHub release assets with the version you just built

### Mistake 6: Using invalid Rust target in workflow setup

Symptom:

- macOS job fails during `Setup Rust`
- error mentions `rust-std for target universal-apple-darwin is unavailable`

Fix:

- do **not** pass `universal-apple-darwin` to rustup target install
- use:
  - `x86_64-apple-darwin`
  - `aarch64-apple-darwin`

### Mistake 7: Missing `contents: write` permission in release workflow

Symptom:

- build succeeds
- release creation/upload fails with:
  - `Resource not accessible by integration`

Fix:

- add workflow-level:
  - `permissions: contents: write`

### Mistake 8: Broken Apple cert secret formatting

Symptom:

- cert import fails (`security import` error)
- or validation says certificate is empty/invalid

Fix:

- store `APPLE_CERTIFICATE` as base64 of `Key.p12` content
- avoid accidental whitespace corruption
- verify password matches `.p12`

### Mistake 9: Expecting manual update check to auto-download

Current app behavior is manual-first:

- `Check for updates` only checks availability
- download starts only when user clicks `Download update`

Do not treat "update found but not downloaded" as a bug in current UX.

## What not to do

- Do not push release tags before workflow YAML is valid.
- Do not use `secrets.*` in unsupported `if` contexts that break parsing.
- Do not use `universal-apple-darwin` as rustup target.
- Do not remove `contents: write` from release workflow.
- Do not leave Apple cert secrets empty if mac signing is required.
- Do not mix assets from different versions in one release.
- Do not skip regenerating `latest.json` after Windows build.

## 11. Quick release template

Use this every time:

### A. Bump version

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

### B. Build

```cmd
cmd /c "set TAURI_SIGNING_PRIVATE_KEY=C:\Users\Windows 11\.tauri\qooti.key&& set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=%TAURI_SIGNING_PRIVATE_KEY_PASSWORD%&& npm run tauri build -- --bundles nsis"
```

### C. Generate manifest

```powershell
node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.2
```

### D. Verify generated files

Expected files in:

- `src-tauri/target/release/bundle/nsis/`

Must include:

- `qooti_0.1.2_x64-setup.exe`
- `qooti_0.1.2_x64-setup.exe.sig`
- `latest.json`

### Copy to staging folder

After the files exist under `nsis/`, copy them into `release-assets/v0.1.2/` (see section 6). For a full CI release, use `gh release download` into that folder instead.

### E. Open `latest.json` and verify

- version is `0.1.2`
- URL contains `/v0.1.2/`
- URL ends in `qooti_0.1.2_x64-setup.exe`

### F. Upload to GitHub release `v0.1.2`

Upload:

- installer
- sig
- latest.json

### G. Test updater

Test from previous installed version.

## 12. Recommended final verification checklist

Before saying a release is done, confirm all of these:

- version is bumped in all required files
- signed NSIS build succeeded
- `.exe` exists
- `.sig` exists
- `latest.json` was regenerated after this exact build
- `latest.json` version matches current release version
- `latest.json` URL points to the same tag and filename
- GitHub release tag matches app version
- GitHub release assets are the correct files for that version
- `release-assets/v<version>/` contains every file you need (or you have downloaded the release via `gh release download`)
- previous installed version detects update successfully

## 13. Current project-specific paths

Useful paths in this repo:

- app version:
  - `package.json`
  - `package-lock.json`
  - `src-tauri/tauri.conf.json`
  - `src-tauri/Cargo.toml`
- installer output:
  - `src-tauri/target/release/bundle/nsis/`
- staging folder for copied release artifacts:
  - `release-assets/v<version>/`
- manifest generator:
  - `scripts/generate-latest-json.js`
- updater endpoint config:
  - `src-tauri/tauri.conf.json`

## 14. One-line summary

For every new release:

- bump version
- build signed installer
- regenerate `latest.json`
- verify `latest.json`
- upload `.exe`, `.sig`, and `latest.json` to the matching GitHub tag
- test update detection from the previous version

If update detection says `check_no_update`, inspect `latest.json` first.
