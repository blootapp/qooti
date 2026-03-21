let ocrEnginePromise = null;
let ocrConfig = null;

async function ensureEngine(config) {
  if (ocrEnginePromise) return ocrEnginePromise;
  ocrEnginePromise = (async () => {
    ocrConfig = config || ocrConfig || {};
    const ortScriptUrl = String(ocrConfig.ortScriptUrl || "");
    const engineUrl = String(ocrConfig.engineUrl || "");
    const detectionPath = String(ocrConfig.detectionPath || "");
    const recognitionPath = String(ocrConfig.recognitionPath || "");
    const dictionaryPath = String(ocrConfig.dictionaryPath || "");
    const wasmBase = String(ocrConfig.wasmBase || ocrConfig.base || "");
    const wasmPathsMap = ocrConfig.ortWasmPathsMap || null;
    self.importScripts(ortScriptUrl || `${wasmBase}ort.wasm.min.js`);
    if (self.ort?.env?.wasm) {
      if (wasmPathsMap?.mjs && wasmPathsMap?.wasm) {
        self.ort.env.wasm.wasmPaths = {
          mjs: String(wasmPathsMap.mjs),
          wasm: String(wasmPathsMap.wasm),
        };
      } else {
        self.ort.env.wasm.wasmPaths = wasmBase;
      }
    }
    const mod = await import(engineUrl || `${wasmBase}ocr-engine.js`);
    const Ocr = mod?.default || mod;
    if (!Ocr || typeof Ocr.create !== "function") {
      throw new Error("OCR engine missing Ocr.create export");
    }
    return Ocr.create({
      models: {
        detectionPath: detectionPath || `${wasmBase}models/ch_PP-OCRv4_det_infer.onnx`,
        recognitionPath: recognitionPath || `${wasmBase}models/ch_PP-OCRv4_rec_infer.onnx`,
        dictionaryPath: dictionaryPath || `${wasmBase}models/ppocr_keys_v1.txt`,
      },
    });
  })();
  return ocrEnginePromise;
}

self.onmessage = async (event) => {
  const msg = event?.data || {};
  if (msg?.type === "init") {
    try {
      ocrConfig = msg?.config || {
        base: String(msg.base || ""),
        wasmBase: String(msg.base || ""),
      };
      await ensureEngine(ocrConfig);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "ready-error", error: err?.message || String(err) });
    }
    return;
  }
  if (msg?.type === "detect") {
    const reqId = String(msg.reqId || "");
    try {
      const ocr = await ensureEngine(ocrConfig);
      const lines = await ocr.detect(String(msg.src || ""));
      const text = Array.isArray(lines)
        ? lines.map((line) => line?.text || "").filter(Boolean).join(" ")
        : "";
      self.postMessage({ type: "detect-result", reqId, text });
    } catch (err) {
      self.postMessage({ type: "detect-result", reqId, error: err?.message || String(err) });
    }
  }
};
