const path = require("node:path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

/**
 * Get aspect ratio (width/height) from a media file.
 * Returns null if unable to determine.
 * Vertical content (9:16) => ~0.56, horizontal (16:9) => ~1.78
 */
async function getAspectRatioFromFile(absPath, mediaType) {
  if (!absPath) return null;
  try {
    const ext = path.extname(absPath).toLowerCase();
    const isImage = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".gif"].includes(ext);
    const isVideo = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".m4v"].includes(ext);

    if (isImage || mediaType === "image" || mediaType === "gif") {
      const meta = await sharp(absPath, { failOnError: false }).metadata();
      if (meta.width && meta.height) {
        return meta.width / meta.height;
      }
    }

    if (isVideo || mediaType === "video") {
      return new Promise((resolve) => {
        ffmpeg.ffprobe(absPath, (err, data) => {
          if (err) {
            resolve(null);
            return;
          }
          const videoStream = data?.streams?.find((s) => s.codec_type === "video");
          if (videoStream?.width && videoStream?.height) {
            resolve(videoStream.width / videoStream.height);
          } else {
            resolve(null);
          }
        });
      });
    }
  } catch {
    /* ignore */
  }
  return null;
}

module.exports = {
  getAspectRatioFromFile
};
