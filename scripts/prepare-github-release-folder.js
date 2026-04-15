/**
 * One-shot release folder for qooti-releases uploads (Windows + macOS).
 *
 * 1. Requires a signed Windows NSIS build under src-tauri/target/release/bundle/nsis.
 * 2. Triggers "Build macOS" on GitHub (blootapp/qooti), waits for success, downloads macos-build.
 * 3. Runs generate-latest-json.js with --macos-bundle-dir so latest.json includes windows-x86_64 + darwin-*.
 * 4. Writes everything into release-assets/v<version>/ (exe, sig, app.tar.gz, sig, dmgs, latest.json).
 *
 * Usage:
 *   node scripts/prepare-github-release-folder.js
 *   node scripts/prepare-github-release-folder.js --run 12345678
 *   node scripts/prepare-github-release-folder.js --macos-dir path/to/folder-with-tar.gz-and-sig
 *   node scripts/prepare-github-release-folder.js --no-trigger   # use latest successful run (risky if stale)
 *
 * Env:
 *   QOOTI_GITHUB_REPO  default blootapp/qooti
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = process.env.QOOTI_GITHUB_REPO || "blootapp/qooti";
const WORKFLOW = "Build macOS";
const ARTIFACT = "macos-build";
const RELEASES_ORG_REPO = "blootapp/qooti-releases";

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: opts.inherit === false ? "pipe" : "inherit",
    cwd: opts.cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function shOut(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function sleepSync(ms) {
  try {
    if (process.platform === "win32") {
      execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: "ignore" });
    } else {
      execSync(`sleep ${Math.ceil(ms / 1000)}`, { stdio: "ignore" });
    }
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let runId = null;
  let macosDir = null;
  let noTrigger = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run" && args[i + 1]) {
      runId = args[++i];
    } else if (args[i] === "--macos-dir" && args[i + 1]) {
      macosDir = args[++i];
    } else if (args[i] === "--no-trigger") {
      noTrigger = true;
    } else if (args[i] === "-h" || args[i] === "--help") {
      console.log(`
Usage:
  node scripts/prepare-github-release-folder.js
  node scripts/prepare-github-release-folder.js --run <runId>
  node scripts/prepare-github-release-folder.js --macos-dir <dir-with-.app.tar.gz+.sig>
  node scripts/prepare-github-release-folder.js --no-trigger
Env: QOOTI_GITHUB_REPO (default blootapp/qooti)
`);
      process.exit(0);
    }
  }
  return { runId, macosDir, noTrigger };
}

function findMacosBundleDir(downloadRoot) {
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const names = entries.filter((e) => e.isFile()).map((e) => e.name);
    const tars = names.filter((f) => f.endsWith(".app.tar.gz") && !f.endsWith(".sig"));
    for (const t of tars) {
      if (names.includes(`${t}.sig`)) return dir;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const hit = walk(path.join(dir, e.name));
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(downloadRoot);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function gatherDmgs(downloadRoot) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".dmg")) out.push(p);
    }
  }
  walk(downloadRoot);
  return out;
}

function waitForNewRun(afterIso) {
  for (let attempt = 0; attempt < 360; attempt++) {
    const raw = shOut(
      `gh run list --repo ${REPO} --workflow "${WORKFLOW}" --limit 15 --json databaseId,status,conclusion,createdAt,displayTitle`
    );
    const runs = JSON.parse(raw);
    const fresh = runs.filter((r) => r.createdAt >= afterIso);
    const active = fresh.find(
      (r) => r.status === "queued" || r.status === "in_progress" || r.status === "waiting"
    );
    if (active) return active.databaseId;
    const done = fresh.find((r) => r.status === "completed");
    if (done) return done.databaseId;
    sleepSync(5000);
  }
  throw new Error("Timed out waiting for a new GitHub Actions run for Build macOS.");
}

function latestSuccessfulRunId() {
  const raw = shOut(
    `gh run list --repo ${REPO} --workflow "${WORKFLOW}" --limit 20 --json databaseId,conclusion,status`
  );
  const runs = JSON.parse(raw);
  const ok = runs.find((r) => r.conclusion === "success");
  if (!ok) throw new Error("No successful Build macOS run found in the last 20 runs.");
  return ok.databaseId;
}

/** Avoid merging a macOS artifact from an older commit than the local tree. */
function assertCiRunMatchesLocalTree(runId) {
  let localHead;
  try {
    localHead = shOut(`git -C "${root}" rev-parse HEAD`);
  } catch {
    return;
  }
  const view = JSON.parse(shOut(`gh run view ${runId} --repo ${REPO} --json headSha`));
  const remoteSha = view.headSha;
  if (remoteSha && remoteSha !== localHead) {
    console.error(
      `Workflow run ${runId} built ${remoteSha.slice(0, 7)} but this repo's HEAD is ${localHead.slice(0, 7)}.`
    );
    console.error("Push the release commit to main, then re-run, or use --macos-dir with a matching CI extract.");
    process.exit(1);
  }
}

const { runId: runIdArg, macosDir: macosDirArg, noTrigger } = parseArgs();
const root = path.resolve(__dirname, "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = String(conf.version || "0.1.0").replace(/^v/, "");
const vtag = `v${version}`;
const releaseBase = `https://github.com/${RELEASES_ORG_REPO}/releases/download/${vtag}`;

const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
if (!fs.existsSync(nsisDir)) {
  console.error("NSIS output not found:", nsisDir);
  process.exit(1);
}
const nsisFiles = fs.readdirSync(nsisDir);
const exeFile = nsisFiles.find((f) => f.includes(`_${version}_`) && f.endsWith("-setup.exe"));
if (!exeFile || !fs.existsSync(path.join(nsisDir, `${exeFile}.sig`))) {
  console.error(`Missing signed Windows installer for ${version} in`, nsisDir);
  process.exit(1);
}

const outDir = path.join(root, "release-assets", `v${version}`);
const dlRoot = path.join(root, "release-assets", `_gh_macos_${version}`);

let macosBundleDir = macosDirArg ? path.resolve(macosDirArg) : null;

if (!macosBundleDir) {
  let runId = runIdArg;
  if (!runId && !noTrigger) {
    const afterIso = new Date(Date.now() - 2000).toISOString();
    console.log(`Dispatching "${WORKFLOW}" on ${REPO} (main)...`);
    sh(`gh workflow run "${WORKFLOW}" --repo ${REPO} --ref main`, { inherit: true });
    console.log("Waiting for the new workflow run…");
    runId = waitForNewRun(afterIso);
  } else if (!runId && noTrigger) {
    runId = latestSuccessfulRunId();
    console.log("Using latest successful run (no new dispatch):", runId);
  }

  console.log("Watching run", runId, "…");
  const watch = spawnSync("gh", ["run", "watch", String(runId), "--repo", REPO, "--exit-status"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (watch.status !== 0) {
    console.error(
      "\nBuild macOS failed or could not run. If GitHub shows a billing/spending-limit message, fix Billing & plans first.\n"
    );
    process.exit(watch.status ?? 1);
  }

  assertCiRunMatchesLocalTree(runId);

  if (fs.existsSync(dlRoot)) fs.rmSync(dlRoot, { recursive: true });
  fs.mkdirSync(dlRoot, { recursive: true });
  console.log("Downloading artifact", ARTIFACT, "…");
  sh(`gh run download ${runId} --repo ${REPO} -n ${ARTIFACT} -D "${dlRoot}"`, { inherit: true });

  macosBundleDir = findMacosBundleDir(dlRoot);
  if (!macosBundleDir) {
    console.error("Could not find macos bundle directory (.app.tar.gz + .sig) under", dlRoot);
    process.exit(1);
  }
  console.log("macOS bundle dir:", macosBundleDir);
}

const genScript = path.join(root, "scripts", "generate-latest-json.js");
const genCmd = `node "${genScript}" "${releaseBase}" --macos-bundle-dir "${macosBundleDir}"`;
console.log("Generating latest.json (Windows + macOS)…");
sh(genCmd, { inherit: true, cwd: root });

const latestPath = path.join(nsisDir, "latest.json");
if (!fs.existsSync(latestPath)) {
  console.error("generate-latest-json did not write latest.json next to NSIS output.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
copyFile(path.join(nsisDir, exeFile), path.join(outDir, exeFile));
copyFile(path.join(nsisDir, `${exeFile}.sig`), path.join(outDir, `${exeFile}.sig`));
copyFile(latestPath, path.join(outDir, "latest.json"));

const macFiles = fs.readdirSync(macosBundleDir);
const tarGz = macFiles.find((f) => f.endsWith(".app.tar.gz") && !f.endsWith(".sig"));
if (tarGz) {
  copyFile(path.join(macosBundleDir, tarGz), path.join(outDir, tarGz));
  copyFile(path.join(macosBundleDir, `${tarGz}.sig`), path.join(outDir, `${tarGz}.sig`));
}

if (!macosDirArg && fs.existsSync(dlRoot)) {
  for (const dmg of gatherDmgs(dlRoot)) {
    copyFile(dmg, path.join(outDir, path.basename(dmg)));
  }
}

console.log("\nDone. Upload everything in:\n ", outDir);
console.log("\nFiles:");
for (const f of fs.readdirSync(outDir).sort()) console.log(" ", f);
