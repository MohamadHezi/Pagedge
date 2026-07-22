import { OCRClient } from 'tesseract-wasm';

// ── OCR bridge ───────────────────────────────────────────────────────────────
// tesseract-wasm's OCRClient already manages its own Web Worker internally
// (see its constructor doc: "This will start a Worker in which the OCR
// operations will actually be performed") — unlike embeddingWorker.ts, there
// is no separate hand-rolled worker file to write here; OCRClient itself IS
// the worker bridge. workerURL/model URLs are pointed explicitly at the
// self-hosted copies in public/ (mirroring the public/pdf.worker.min.mjs
// convention) rather than relying on OCRClient's default "relative to the
// current script" resolution, which breaks once Vite bundles this module in
// with the rest of the app.

let client: OCRClient | null = null;
let modelLoadPromise: Promise<void> | null = null;

// Set once an engine-load failure is confirmed — avoids retrying (and
// re-failing) a broken WASM init on every single page of a large document.
// See ingestionService.ts's ocrPage() caller for how this degrades:
// treated identically to "no text found on this page" (today's existing
// silent-failure behavior for a page that can't be read), not a hard error.
let ocrDisabled = false;

export function isOcrDisabled(): boolean {
  return ocrDisabled;
}

function ensureClient(): OCRClient {
  if (!client) {
    client = new OCRClient({ workerURL: '/tesseract-worker.js' });
  }
  return client;
}

function ensureModelLoaded(): Promise<void> {
  const promise = modelLoadPromise ?? ensureClient().loadModel('/eng.traineddata');
  modelLoadPromise = promise;
  return promise;
}

/**
 * OCRs a single rasterized page image and returns its recognized text.
 * Resolves to '' (never rejects) if the OCR engine has failed to load in
 * this session — callers treat that identically to a page with no
 * extractable text, same as today's pre-OCR behavior.
 */
export async function ocrPage(imageData: ImageData): Promise<string> {
  if (ocrDisabled) return '';

  try {
    await ensureModelLoaded();
    const ocr = ensureClient();
    await ocr.loadImage(imageData);
    return await ocr.getText();
  } catch (err) {
    console.error('[ocr] engine failed, disabling OCR for this session:', err);
    ocrDisabled = true;
    modelLoadPromise = null;
    client?.destroy().catch(() => {});
    client = null;
    return '';
  }
}
