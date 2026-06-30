import { invoke } from '@tauri-apps/api/core';
import * as pdfjsLib from 'pdfjs-dist';
import { useStore } from '../store';
import type { PageText } from '../types';

// ── Constants ──────────────────────────────────────────────────────────────────

const CHUNK_CHARS = 2000;   // ~500 tokens at 4 chars/token
const OVERLAP_CHARS = 200;  // ~50 tokens
const MIN_CHARS = 50;
const EMBED_BATCH = 5;

// ── PDF.js text extraction ────────────────────────────────────────────────────
// Replaces the Rust/lopdf extract_pdf_text command: lopdf silently returns empty
// strings for many PDFs that PDF.js renders correctly. We use the same engine
// the viewer already uses so extraction is always consistent with what the user sees.

async function extractTextWithPdfJs(filepath: string): Promise<PageText[]> {
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  }

  // Use the same read_file Rust command the PDF viewer uses — this reads raw
  // bytes without going through the asset.localhost custom protocol, which the
  // PDF.js worker can't access.
  const bytes = await invoke<number[]>('read_file', { path: filepath });
  const data = new Uint8Array(bytes);

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  console.log('[ingest] PDF.js loaded', pdf.numPages, 'pages from', filepath);

  const pages: PageText[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item) => 'str' in item)
      .map((item) => {
        const ti = item as { str: string; hasEOL: boolean };
        // hasEOL marks a visual line break — two consecutive EOLs = paragraph gap
        return ti.str + (ti.hasEOL ? '\n' : '');
      })
      .join('');
    pages.push({ page: i, text });
  }

  const totalChars = pages.reduce((s, p) => s + p.text.length, 0);
  console.log('[ingest] extracted', totalChars, 'chars across', pages.length, 'pages');
  return pages;
}

// ── Text chunker ───────────────────────────────────────────────────────────────

interface TextChunk {
  page: number;
  content: string;
}

function lastSentenceBoundary(text: string, maxLen: number): number {
  const slice = text.slice(0, maxLen);
  const boundary = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('! '),
  );
  return boundary > MIN_CHARS ? boundary + 2 : maxLen;
}

function chunkPageTexts(pageTexts: PageText[]): TextChunk[] {
  const result: TextChunk[] = [];

  for (const { page, text } of pageTexts) {
    if (!text.trim()) continue;

    const paragraphs = text
      .split(/\n{2,}/)
      .map(p => p.replace(/\s+/g, ' ').trim())
      .filter(p => p.length >= MIN_CHARS);

    let current = '';

    for (const para of paragraphs) {
      if (current.length + para.length + 2 <= CHUNK_CHARS) {
        current = current ? `${current}\n\n${para}` : para;
      } else {
        if (current.length >= MIN_CHARS) result.push({ page, content: current });
        const tail = current.slice(-OVERLAP_CHARS);
        current = tail ? `${tail}\n\n${para}` : para;

        while (current.length > CHUNK_CHARS) {
          const cutAt = lastSentenceBoundary(current, CHUNK_CHARS);
          result.push({ page, content: current.slice(0, cutAt).trim() });
          current = current.slice(Math.max(0, cutAt - OVERLAP_CHARS)).trim();
        }
      }
    }

    if (current.length >= MIN_CHARS) result.push({ page, content: current });
  }

  return result;
}

// ── Main-thread fallback embedding ─────────────────────────────────────────────
// Used when WebView2 blocks the worker or onnxruntime-web fails in the worker.

let mainThreadPipe: unknown = null;

async function embedMainThread(texts: string[]): Promise<number[][]> {
  if (!mainThreadPipe) {
    useStore.getState().setModelLoading(true);
    // Dynamic import keeps transformers.js out of the main bundle chunk;
    // it loads from the excluded node_module so WASM paths stay intact.
    const mod = await import('@huggingface/transformers');
    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;
    mainThreadPipe = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      progress_callback: (p: Record<string, unknown>) => {
        if (p.status === 'downloading') useStore.getState().setModelLoading(true);
        else if (p.status === 'ready') useStore.getState().setModelLoading(false);
      },
    });
    useStore.getState().setModelLoading(false);
  }

  const embeddings: number[][] = [];
  for (const text of texts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await (mainThreadPipe as any)(text, { pooling: 'mean', normalize: true });
    embeddings.push(Array.from(output.data as Float32Array));
  }
  return embeddings;
}

// ── Worker bridge ──────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerReadyPromise: Promise<void> | null = null;
let useWorkerFallback = false;
let msgId = 0;
const pending = new Map<number, {
  resolve: (embeddings: number[][]) => void;
  reject: (err: Error) => void;
}>();

function rejectAllPending(reason: string) {
  pending.forEach(({ reject }) => reject(new Error(reason)));
  pending.clear();
}

function createWorker(): Worker {
  const w = new Worker(
    new URL('../workers/embeddingWorker.ts', import.meta.url),
    { type: 'module' },
  );

  w.onmessage = (e: MessageEvent) => {
    const msg = e.data as Record<string, unknown>;
    switch (msg.type) {
      case 'model_progress': {
        const progress = msg.progress as Record<string, unknown>;
        if (progress?.status === 'downloading') useStore.getState().setModelLoading(true);
        break;
      }
      case 'model_ready':
        useStore.getState().setModelLoading(false);
        break;
      case 'model_error':
        useStore.getState().setModelLoading(false);
        break;
      case 'embed_result': {
        const { id, embeddings } = msg as { id: number; embeddings: number[][] };
        pending.get(id)?.resolve(embeddings);
        pending.delete(id);
        break;
      }
      case 'embed_error': {
        const { id, error } = msg as { id: number; error: string };
        pending.get(id)?.reject(new Error(error));
        pending.delete(id);
        break;
      }
    }
  };

  // Hard crash (e.g. registerBackend undefined, WASM load failure, WebView2
  // blocking nested workers). Switch to main-thread fallback for this session.
  w.onerror = (err) => {
    console.warn('[embed] Worker crashed, switching to main-thread fallback:', err.message);
    useWorkerFallback = true;
    workerReadyPromise = null;
    worker = null;
    rejectAllPending('Worker crashed');
  };

  return w;
}

function getWorker(): Worker {
  if (!worker) worker = createWorker();
  return worker;
}

function ensureModelLoaded(): Promise<void> {
  if (!workerReadyPromise) {
    workerReadyPromise = new Promise<void>((resolve, reject) => {
      const w = getWorker();

      const onReady = (e: MessageEvent) => {
        const { type } = e.data as { type: string };
        if (type === 'model_ready') {
          w.removeEventListener('message', onReady);
          resolve();
        } else if (type === 'model_error') {
          w.removeEventListener('message', onReady);
          reject(new Error(String((e.data as Record<string, unknown>).error)));
        }
      };

      w.addEventListener('message', onReady);
      w.postMessage({ type: 'load' });
    });
  }
  return workerReadyPromise;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  // Worker is known-bad for this session — go straight to main thread
  if (useWorkerFallback) return embedMainThread(texts);

  try {
    await ensureModelLoaded();
    const id = ++msgId;
    return await new Promise<number[][]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ type: 'embed', id, texts });
    });
  } catch (err) {
    // Worker failed mid-session (model_error or crash rejection) — activate fallback
    console.warn('[embed] Worker unavailable, switching to main-thread fallback:', err);
    useWorkerFallback = true;
    workerReadyPromise = null;
    return embedMainThread(texts);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Embed a single query string using the same singleton as ingestion. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const result = await embedBatch([text]);
  return new Float32Array(result[0]);
}

export async function ingestPdf(pdfId: string, filepath: string): Promise<void> {
  const store = useStore.getState();
  store.setIngestionStatus(pdfId, 'indexing');

  try {
    // 1. Extract text page-by-page via PDF.js (same engine as the reader)
    const pageTexts = await extractTextWithPdfJs(filepath);

    // 2. Chunk
    const chunks = chunkPageTexts(pageTexts);
    console.log('[ingest] produced', chunks.length, 'chunks for pdfId', pdfId);

    if (chunks.length === 0) {
      await invoke('update_pdf_ingestion_status', { pdfId, chunkCount: 0 });
      store.setIngestionStatus(pdfId, 'done');
      scheduleClear(pdfId);
      return;
    }

    // 3. Delete previous chunks (re-index support)
    await invoke('delete_chunks_for_pdf', { pdfId });

    // 4. Embed in batches of EMBED_BATCH, store as we go
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const embeddings = await embedBatch(batch.map(c => c.content));

      const chunkInputs = batch.map((chunk, j) => ({
        id: crypto.randomUUID(),
        source_id: pdfId,
        chunk_index: i + j,
        page: chunk.page,
        content: chunk.content,
        embedding: embeddings[j],
      }));

      await invoke('store_chunks', { chunks: chunkInputs });
    }

    // 5. Mark as ingested
    await invoke('update_pdf_ingestion_status', { pdfId, chunkCount: chunks.length });
    store.updatePdfChunkCount(pdfId, chunks.length);

    store.setIngestionStatus(pdfId, 'done');
    scheduleClear(pdfId);
  } catch (err) {
    console.error('[ingest] Failed for', pdfId, err);
    store.setIngestionStatus(pdfId, 'error');
  }
}

function scheduleClear(pdfId: string) {
  setTimeout(() => {
    const s = useStore.getState();
    if (s.ingestionStatus[pdfId] === 'done') s.setIngestionStatus(pdfId, null);
  }, 3000);
}
