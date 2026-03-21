#!/usr/bin/env node
/**
 * Copies FFmpeg (ffmpeg.exe, ffprobe.exe) from ffmpeg-static if available,
 * or downloads from BtbN. Places in src-tauri/resources/ for Tauri bundle.
 */
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const destDir = path.join(projectRoot, "src-tauri", "resources");
const ffmpegExe = path.join(destDir, "ffmpeg.exe");
const ffprobeExe = path.join(destDir, "ffprobe.exe");

function tryFromFfmpegStatic() {
  try {
    const ffmpegStatic = require("ffmpeg-static");
    const fp = ffmpegStatic.path || ffmpegStatic;
    if (fp && fs.existsSync(fp)) {
      fs.copyFileSync(fp, ffmpegExe);
      console.log("[prepare-ffmpeg] Copied ffmpeg.exe from ffmpeg-static");
      return true;
    }
  } catch (_) {}
  return false;
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe)) {
    console.log("[prepare-ffmpeg] ffmpeg.exe and ffprobe.exe already exist");
    process.exit(0);
  }
  if (tryFromFfmpegStatic()) {
    const ffprobePath = path.join(path.dirname(require.resolve("ffmpeg-static/package.json")), "ffprobe.exe");
    if (fs.existsSync(ffprobePath)) {
      fs.copyFileSync(ffprobePath, ffprobeExe);
    }
  }
  if (!fs.existsSync(ffmpegExe)) {
    console.warn("[prepare-ffmpeg] FFmpeg not found. Install ffmpeg-static or place ffmpeg.exe manually in src-tauri/resources/");
    process.exit(0);
  }
  console.log("[prepare-ffmpeg] Done");
}

main().catch((err) => {
  console.error("[prepare-ffmpeg]", err.message);
  process.exit(1);
});
