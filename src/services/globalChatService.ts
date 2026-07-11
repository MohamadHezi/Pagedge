import { invoke } from '@tauri-apps/api/core';
import { embedQuery } from './ingestionService';
import { bytesToFloat32, cosineSimilarity } from '../utils/embeddings';
import type { RawChunk, Pdf, ChatCitation } from '../types';

const TOP_N_CHUNKS = 6;
const MAX_CHARS_PER_CHUNK = 400;
const MIN_SCORE = 0.2; // matches SearchModal's existing threshold

export interface GlobalContextChunk {
  sourceId: string;
  filename: string;
  page: number;
  content: string; // truncated to MAX_CHARS_PER_CHUNK
  tag: string;      // "S1", "S2", ...
}

export interface GlobalContextResult {
  chunks: GlobalContextChunk[];
  promptBlock: string;
}

// A plain listing of every PDF filename in the library — included on every
// send regardless of retrieval, so meta-questions like "what PDFs do you
// have" don't depend on semantic similarity happening to favor one document
// (the top-N chunk retrieval below only surfaces *content*, not an index of
// what's in the library).
export function buildLibraryListing(pdfs: Pdf[]): string {
  if (pdfs.length === 0) return '';
  return `Library contains ${pdfs.length} document${pdfs.length === 1 ? '' : 's'}:\n${pdfs.map(p => `- ${p.filename}`).join('\n')}`;
}

// Loads the entire chunks table (all PDFs, all embeddings) over Tauri IPC on
// every send — same cost SearchModal already pays per debounced keystroke.
// Fine for now; a future optimization would push top-K scoring into Rust.
export async function buildGlobalContext(question: string, pdfs: Pdf[]): Promise<GlobalContextResult> {
  const [queryVec, json] = await Promise.all([
    embedQuery(question),
    invoke<string>('get_all_chunks'),
  ]);
  const allChunks: RawChunk[] = JSON.parse(json);

  const scored = allChunks
    .filter(c => c.embedding.length > 0)
    .map(c => ({ chunk: c, score: cosineSimilarity(queryVec, bytesToFloat32(c.embedding)) }))
    .filter(({ score }) => score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N_CHUNKS);

  const pdfById = new Map(pdfs.map(p => [p.id, p]));

  const chunks: GlobalContextChunk[] = scored.map(({ chunk }, i) => ({
    sourceId: chunk.source_id,
    filename: pdfById.get(chunk.source_id)?.filename ?? 'Unknown document',
    page: chunk.page,
    content: chunk.content.length > MAX_CHARS_PER_CHUNK
      ? chunk.content.slice(0, MAX_CHARS_PER_CHUNK).trimEnd() + '…'
      : chunk.content,
    tag: `S${i + 1}`,
  }));

  const promptBlock = chunks
    .map(c => `[${c.tag} p.${c.page}] ${c.filename}\n${c.content}`)
    .join('\n\n---\n\n');

  return { chunks, promptBlock };
}

export function extractCitations(text: string, chunks: GlobalContextChunk[]): ChatCitation[] {
  const byTag = new Map(chunks.map(c => [c.tag, c]));
  const seen = new Set<string>();
  const out: ChatCitation[] = [];
  const re = /\[S(\d+)\s*p\.?\s*(\d+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const chunk = byTag.get(`S${m[1]}`);
    if (!chunk) continue;
    const page = parseInt(m[2], 10);
    const key = `${chunk.sourceId}-${page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceId: chunk.sourceId, page });
  }
  return out;
}
