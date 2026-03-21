const path = require("node:path");
const fs = require("node:fs");

const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const THUMB_W = 480;
const THUMB_H = 270; // 16:9 cards

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function generateImageThumb({ srcPath, outPath }) {
  ensureParentDir(outPath);
  await sharp(srcPath, { animated: true })
    .resize(THUMB_W, THUMB_H, { fit: "cover", position: "centre" })
    .jpeg({ quality: 82 })
    .toFile(outPath);
}

async function generateVideoThumb({ srcPath, outPath }) {
  ensureParentDir(outPath);

  // Extract a single representative frame and crop to 16:9.
  await new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .inputOptions(["-hide_banner"])
      .outputOptions([
        "-frames:v 1",
        "-q:v 2",
        `-vf scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H}`
      ])
      .seekInput(1)
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });
}

async function generateThumbnail({ type, srcPath, outPath }) {
  if (type === "image" || type === "gif") {
    return generateImageThumb({ srcPath, outPath });
  }
  if (type === "video") {
    return generateVideoThumb({ srcPath, outPath });
  }
  return null;
}

module.exports = {
  THUMB_W,
  THUMB_H,
  generateThumbnail
};

