#!/usr/bin/env node
/**
 * Prepare local OCR assets for PaddleOCR-based recognition (no CDN dependency).
 *
 * 1. Bundles @gutenye/ocr-browser into src/assets/ocr/ocr-engine.mjs (esbuild)
 * 2. Copies onnxruntime-web JS + WASM files to src/assets/ocr/
 * 3. Downloads PaddleOCR PP-OCRv4 ONNX models to src/assets/ocr/models/
 * 4. Copies dictionary file
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const root = path.join(__dirname, "..");
const destOcr = path.join(root, "src", "assets", "ocr");
const destModels = path.join(destOcr, "models");

const MODELS_CDN = "https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets";
const MODEL_FILES = [
  { name: "ch_PP-OCRv4_det_infer.onnx", minSize: 4_000_000 },
  { name: "ch_PP-OCRv4_rec_infer.onnx", minSize: 10_000_000 },
];
const DICT_SRC = path.join(root, "node_modules", "@gutenye", "ocr-models", "assets", "ppocr_keys_v1.txt");

const ORT_DIST = path.join(root, "node_modules", "onnxruntime-web", "dist");
const ORT_JS_FILE = "ort.wasm.min.js";
const ORT_WASM_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
];
const ORT_PKG_JSON = path.join(root, "node_modules", "onnxruntime-web", "package.json");
const REQUIRED_OCR_OUTPUTS = [
  { rel: "ocr-engine.js", minSize: 200_000 },
  { rel: "ort.wasm.min.js", minSize: 40_000 },
  { rel: "ort-wasm-simd-threaded.mjs", minSize: 1_000 },
  { rel: "ort-wasm-simd-threaded.wasm", minSize: 1_000_000 },
  { rel: path.join("models", "ch_PP-OCRv4_det_infer.onnx"), minSize: 4_000_000 },
  { rel: path.join("models", "ch_PP-OCRv4_rec_infer.onnx"), minSize: 10_000_000 },
  { rel: path.join("models", "ppocr_keys_v1.txt"), minSize: 1_000 },
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`Missing: ${src}`);
  fs.copyFileSync(src, dest);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.tmp`;
    const out = fs.createWriteStream(tmp);
    const doRequest = (reqUrl) => {
      https.get(reqUrl, { headers: { "User-Agent": "qooti-prepare-ocr" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          out.close();
          try { fs.unlinkSync(tmp); } catch (_) {}
          const next = res.headers.location;
          if (!next) return reject(new Error("Redirect without location"));
          return doRequest(next);
        }
        if (res.statusCode !== 200) {
          out.close();
          try { fs.unlinkSync(tmp); } catch (_) {}
          return reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`));
        }
        res.pipe(out);
        out.on("finish", () => {
          out.close();
          fs.renameSync(tmp, dest);
          resolve();
        });
      }).on("error", (err) => {
        out.close();
        try { fs.unlinkSync(tmp); } catch (_) {}
        reject(err);
      });
    };
    doRequest(url);
  });
}

async function bundleOcrEngine() {
  const esbuild = require("esbuild");
  const shimPath = path.join(__dirname, "ort-shim.js");
  const nodeShimPath = path.join(__dirname, "node-shim.js");
  const entryPath = path.join(__dirname, "ocr-entry.mjs");
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    outfile: path.join(destOcr, "ocr-engine.js"),
    alias: {
      "onnxruntime-web": shimPath,
      "onnxruntime-common": shimPath,
      "fs": nodeShimPath,
      "path": nodeShimPath,
      "crypto": nodeShimPath,
    },
    minify: true,
    target: "es2020",
    logLevel: "warning",
  });
  console.log("[prepare-ocr] Bundled ocr-engine.mjs");
}

async function copyOnnxRuntime() {
  copyIfExists(path.join(ORT_DIST, ORT_JS_FILE), path.join(destOcr, ORT_JS_FILE));
  console.log(`[prepare-ocr] Copied ${ORT_JS_FILE}`);
  for (const f of ORT_WASM_FILES) {
    const src = path.join(ORT_DIST, f);
    const dst = path.join(destOcr, f);
    if (fs.existsSync(src)) {
      copyIfExists(src, dst);
      console.log(`[prepare-ocr] Copied ${f}`);
      continue;
    }
    if (f.endsWith(".wasm")) {
      const ortVersion = JSON.parse(fs.readFileSync(ORT_PKG_JSON, "utf8")).version;
      const fallbackUrl = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVersion}/dist/${f}`;
      console.log(`[prepare-ocr] Downloading ${f} from CDN fallback ...`);
      await download(fallbackUrl, dst);
      console.log(`[prepare-ocr] Downloaded ${f} (${Math.round(fs.statSync(dst).size / 1024 / 1024)}MB)`);
      continue;
    }
    throw new Error(`Missing ONNX runtime sidecar file: ${f}`);
  }
}

async function downloadModels() {
  for (const { name, minSize } of MODEL_FILES) {
    const dest = path.join(destModels, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size >= minSize) {
      console.log(`[prepare-ocr] ${name} already present (${Math.round(fs.statSync(dest).size / 1024 / 1024)}MB)`);
      continue;
    }
    const url = `${MODELS_CDN}/${name}`;
    console.log(`[prepare-ocr] Downloading ${name} ...`);
    await download(url, dest);
    console.log(`[prepare-ocr] Downloaded ${name} (${Math.round(fs.statSync(dest).size / 1024 / 1024)}MB)`);
  }
}

async function copyDictionary() {
  const dest = path.join(destModels, "ppocr_keys_v1.txt");
  copyIfExists(DICT_SRC, dest);
  console.log("[prepare-ocr] Copied ppocr_keys_v1.txt");
}

function verifyPreparedAssets() {
  const missing = [];
  for (const item of REQUIRED_OCR_OUTPUTS) {
    const full = path.join(destOcr, item.rel);
    if (!fs.existsSync(full)) {
      missing.push(`${item.rel} (missing)`);
      continue;
    }
    const size = fs.statSync(full).size;
    if (size < item.minSize) {
      missing.push(`${item.rel} (size=${size}, min=${item.minSize})`);
      continue;
    }
    console.log(`[prepare-ocr] Verified ${item.rel} (${Math.round(size / 1024)}KB)`);
  }
  if (missing.length) {
    throw new Error(`Required OCR assets failed verification: ${missing.join("; ")}`);
  }
}

async function run() {
  ensureDir(destOcr);
  ensureDir(destModels);
  await bundleOcrEngine();
  await copyOnnxRuntime();
  await downloadModels();
  await copyDictionary();
  verifyPreparedAssets();
  console.log("[prepare-ocr] Done.");
}

run().catch((err) => {
  console.error("[prepare-ocr] Failed:", err.message || err);
  process.exit(1);
});
