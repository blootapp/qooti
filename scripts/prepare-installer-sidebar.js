/**
 * Re-encode the NSIS sidebar image to a format NSIS accepts.
 * NSIS is picky about BMP bit-depth; this rewrites it via sharp.
 *
 * Input:  assets/installer-sidebar.bmp
 * Output: assets/installer-sidebar.nsis.bmp
 */
const path = require("path");
const fs = require("fs");

async function main() {
  const sharp = require("sharp");
  const root = path.resolve(__dirname, "..");
  const input = path.join(root, "assets", "installer-sidebar.bmp");
  const output = path.join(root, "assets", "installer-sidebar.nsis.bmp");

  if (!fs.existsSync(input)) {
    console.error("[installer-sidebar] Missing input:", input);
    process.exit(1);
  }

  // Re-encode; keep original dimensions.
  // This sharp build may not support BMP output, so we write PNG and then convert to BMP via PowerShell.
  const tmpPng = output.replace(/\.bmp$/i, ".png");
  await sharp(input).flatten({ background: "#000000" }).png().toFile(tmpPng);
  const { execFileSync } = require("child_process");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    `$in = '${tmpPng.replace(/'/g, "''")}'`,
    `$out = '${output.replace(/'/g, "''")}'`,
    "Add-Type -AssemblyName System.Drawing",
    "$img = [System.Drawing.Image]::FromFile($in)",
    "$bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.Clear([System.Drawing.Color]::Black)",
    "$g.DrawImage($img, 0, 0, $img.Width, $img.Height)",
    "$g.Dispose()",
    "$img.Dispose()",
    "$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)",
    "$bmp.Dispose()",
    "Remove-Item -Force $in",
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
  console.log("[installer-sidebar] Wrote:", output);
}

main().catch((e) => {
  console.error("[installer-sidebar] Failed:", e?.message || e);
  process.exit(1);
});

