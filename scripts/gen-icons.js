const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const pngToIco = require("png-to-ico");

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const srcPng = path.join(projectRoot, "assets", "icon.png");
  const outIco = path.join(projectRoot, "assets", "icon.ico");

  if (!fs.existsSync(srcPng)) {
    throw new Error(`Missing icon: ${srcPng}`);
  }

  const icoBuf = await pngToIco(srcPng);
  fs.writeFileSync(outIco, icoBuf);

  const tauriIconsDir = path.join(projectRoot, "src-tauri", "icons");
  if (process.platform === "win32") {
    execFileSync(
      "cmd.exe",
      ["/c", "npx", "tauri", "icon", srcPng, "-o", tauriIconsDir],
      { cwd: projectRoot, stdio: "inherit" }
    );
  } else {
    execFileSync("npx", ["tauri", "icon", srcPng, "-o", tauriIconsDir], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `Generated ${path.relative(projectRoot, outIco)} and refreshed src-tauri/icons`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

