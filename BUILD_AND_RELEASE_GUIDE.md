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

- the app is built on Windows
- releases are uploaded to `blootapp/qooti-releases`
- updater endpoint stays:
  - `https://github.com/blootapp/qooti-releases/releases/latest/download/latest.json`

## Release checklist

Do these in order:

1. Finish code changes.
2. Bump the version in all required files.
3. Build the signed NSIS installer.
4. Regenerate `latest.json` for the new version.
5. Verify the contents of `latest.json`.
6. Upload the correct assets to the matching GitHub release tag.
7. Test update detection from the previous installed version.

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
cmd /c "set TAURI_SIGNING_PRIVATE_KEY=C:\Users\Windows 11\.tauri\qooti.key&& set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=YOUR_PASSWORD&& npm run tauri build -- --bundles nsis"
```

Replace:

- `YOUR_PASSWORD` with the actual signing key password

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

Run:

```powershell
node scripts/generate-latest-json.js https://github.com/blootapp/qooti-releases/releases/download/v0.1.2
```

Replace:

- `v0.1.2` with the tag of the release you are publishing

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

## 6. GitHub release rules

Releases are published in:

- `https://github.com/blootapp/qooti-releases/releases`

For each new version:

1. Create a new release tag:
   - `v0.1.2`
2. Upload these assets:
   - `qooti_0.1.2_x64-setup.exe`
   - `qooti_0.1.2_x64-setup.exe.sig`
   - `latest.json`
3. Publish the release

### Asset upload rule

The three uploaded files must belong to the same version.

Never mix:

- installer from `0.1.2`
- signature from `0.1.2`
- `latest.json` from `0.1.1`

That mismatch is enough to break updater detection or download/install flow.

## 7. Release order that should always be followed

Always follow this exact order:

1. bump versions
2. build signed installer
3. generate new `latest.json`
4. inspect `latest.json`
5. upload `.exe`, `.sig`, and `latest.json`
6. publish release
7. test update from previous installed version

Do not upload assets before generating the new manifest.

## 8. Post-release verification

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

## 9. Common mistakes and how to avoid them

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
cmd /c "set TAURI_SIGNING_PRIVATE_KEY=C:\Users\Windows 11\.tauri\qooti.key&& set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=YOUR_PASSWORD&& npm run tauri build -- --bundles nsis"
```

### Mistake 5: Uploading old assets to the newest release

Symptom:

- release page looks correct visually
- updater behavior is wrong

Fix:

- always compare filenames in GitHub release assets with the version you just built

## 10. Quick release template

Use this every time:

### A. Bump version

- `package.json`
- `package-lock.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

### B. Build

```cmd
cmd /c "set TAURI_SIGNING_PRIVATE_KEY=C:\Users\Windows 11\.tauri\qooti.key&& set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=YOUR_PASSWORD&& npm run tauri build -- --bundles nsis"
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

## 11. Recommended final verification checklist

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
- previous installed version detects update successfully

## 12. Current project-specific paths

Useful paths in this repo:

- app version:
  - `package.json`
  - `package-lock.json`
  - `src-tauri/tauri.conf.json`
  - `src-tauri/Cargo.toml`
- installer output:
  - `src-tauri/target/release/bundle/nsis/`
- manifest generator:
  - `scripts/generate-latest-json.js`
- updater endpoint config:
  - `src-tauri/tauri.conf.json`

## 13. One-line summary

For every new release:

- bump version
- build signed installer
- regenerate `latest.json`
- verify `latest.json`
- upload `.exe`, `.sig`, and `latest.json` to the matching GitHub tag
- test update detection from the previous version

If update detection says `check_no_update`, inspect `latest.json` first.
