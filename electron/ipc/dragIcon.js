const fs = require("node:fs");
const path = require("node:path");

const sharp = require("sharp");

const DRAG_SIZE = 64;
const FRAME_WIDTH = 2;
const BORDER_COLOR = "#2a2d36"; // Muted dark frame

/**
 * Creates a small, framed image suitable for the native drag preview.
 * Returns the path to the generated icon, or null if generation fails.
 */
async function createDragIcon(sourcePath, vaultRoot) {
  const imgExt = path.extname(sourcePath).toLowerCase();
  const supported = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
  if (!supported.includes(imgExt)) {
    return null;
  }

  try {
    if (!fs.existsSync(sourcePath)) return null;

    const tempDir = path.join(vaultRoot, "temp");
    fs.mkdirSync(tempDir, { recursive: true });
    const outPath = path.join(tempDir, "drag-icon.png");

    // Resize to fit within DRAG_SIZE, then add frame (extend with border)
    const innerSize = DRAG_SIZE - FRAME_WIDTH * 2;
    await sharp(sourcePath, { animated: false })
      .resize(innerSize, innerSize, { fit: "cover", position: "centre" })
      .extend({
        top: FRAME_WIDTH,
        bottom: FRAME_WIDTH,
        left: FRAME_WIDTH,
        right: FRAME_WIDTH,
        background: BORDER_COLOR
      })
      .png()
      .toFile(outPath);

    return outPath;
  } catch (err) {
    console.warn("[createDragIcon] Failed:", err.message);
    return null;
  }
}

module.exports = { createDragIcon };
