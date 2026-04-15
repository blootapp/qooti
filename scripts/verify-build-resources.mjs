/**
 * Ensures bundled yt-dlp exists for the current OS (same layout as release CI).
 * src-tauri/resources/ is gitignored; download binaries like .github/workflows/release.yml
 * or run your platform's install step before `tauri dev` / `tauri build`.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const resourcesDir = path.join(root, "src-tauri", "resources");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const binaryName = isWin ? "yt-dlp.exe" : "yt-dlp";

const candidates = [
  path.join(resourcesDir, binaryName),
  path.join(resourcesDir, "resources", binaryName),
];

function main() {
  const found = candidates.find((p) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() && st.size > 64;
    } catch {
      return false;
    }
  });

  if (found) {
    console.log(`[verify-build-resources] OK: ${found} (${fs.statSync(found).size} bytes)`);
    console.log(`[verify-build-resources] platform=${process.platform} expected=${binaryName}`);
    process.exit(0);
  }

  console.error(`[verify-build-resources] Missing yt-dlp for ${process.platform}.`);
  console.error(`  Expected one of:\n  ${candidates.join("\n  ")}`);
  if (isWin) {
    console.error(
      "  Windows: curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -o src-tauri/resources/yt-dlp.exe"
    );
  } else if (isMac) {
    console.error(
      "  macOS: curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o src-tauri/resources/yt-dlp && chmod +x src-tauri/resources/yt-dlp"
    );
  } else {
    console.error("  Linux: install yt-dlp per distro or place binary under src-tauri/resources/");
  }
  process.exit(1);
}

main();
