import { invoke } from '@tauri-apps/api/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useStore } from '../store';
import { callAI } from './aiService';

// ── Types ──────────────────────────────────────────────────────────────────────

interface OutlineItemInput {
  id: string;
  pdf_id: string;
  parent_id: string | null;
  title: string;
  page: number;
  order_index: number;
  source: 'embedded' | 'ai-generated';
}

type RawOutlineNode = {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutlineNode[];
};

// ── Embedded outline (PDF.js bookmarks) ───────────────────────────────────────

async function resolveDestPage(doc: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  try {
    let explicitDest = dest;
    if (typeof dest === 'string') {
      explicitDest = await doc.getDestination(dest);
    }
    if (!Array.isArray(explicitDest) || explicitDest.length === 0) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pageIndex = await doc.getPageIndex(explicitDest[0] as any);
    return pageIndex + 1;
  } catch {
    return null;
  }
}

async function flattenOutline(
  doc: PDFDocumentProxy,
  nodes: RawOutlineNode[],
  pdfId: string,
  parentId: string | null,
  out: OutlineItemInput[],
): Promise<void> {
  let orderIndex = out.filter((o) => o.parent_id === parentId).length;
  for (const node of nodes) {
    const title = (node.title || '').trim();
    const page = await resolveDestPage(doc, node.dest);

    if (title && page != null) {
      const id = crypto.randomUUID();
      out.push({ id, pdf_id: pdfId, parent_id: parentId, title, page, order_index: orderIndex++, source: 'embedded' });
      if (node.items?.length) {
        await flattenOutline(doc, node.items, pdfId, id, out);
      }
    } else if (node.items?.length) {
      // Unresolvable destination — still surface its children at this level.
      await flattenOutline(doc, node.items, pdfId, parentId, out);
    }
  }
}

async function extractEmbeddedOutline(doc: PDFDocumentProxy, pdfId: string): Promise<OutlineItemInput[]> {
  const raw = await doc.getOutline();
  if (!raw || raw.length === 0) return [];
  const out: OutlineItemInput[] = [];
  await flattenOutline(doc, raw as RawOutlineNode[], pdfId, null, out);
  return out;
}

// ── AI fallback (headings inferred from text) ─────────────────────────────────

const OUTLINE_SYSTEM =
  'You identify the main section headings in a document based on excerpted page text. ' +
  'Respond ONLY with a JSON array of objects: [{"title": string, "page": number}]. ' +
  'Only include genuine section/chapter headings, not random capitalized text or running prose. ' +
  'Order the array by page number ascending. Respond with nothing but the JSON array.';

const AI_OUTLINE_MAX_PAGES = 20;
const AI_OUTLINE_CHARS_PER_PAGE = 3000;

async function generateAiOutline(doc: PDFDocumentProxy, pdfId: string): Promise<OutlineItemInput[]> {
  const pageCount = Math.min(doc.numPages, AI_OUTLINE_MAX_PAGES);
  const parts: string[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item) => 'str' in item)
      .map((item) => (item as { str: string }).str)
      .join(' ')
      .slice(0, AI_OUTLINE_CHARS_PER_PAGE);
    if (text.trim()) parts.push(`[Page ${i}]\n${text}`);
  }
  if (parts.length === 0) return [];

  let response: string;
  try {
    response = await callAI([
      { role: 'system', content: OUTLINE_SYSTEM },
      { role: 'user', content: parts.join('\n\n---\n\n') },
    ]);
  } catch (err) {
    console.error('[outline] AI generation failed:', err);
    return [];
  }

  let parsed: unknown;
  try {
    const match = response.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(match ? match[0] : response);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: OutlineItemInput[] = [];
  let orderIndex = 0;
  for (const raw of parsed) {
    const item = raw as { title?: unknown; page?: unknown };
    const title = String(item.title ?? '').trim();
    const page = Number(item.page);
    if (!title || !Number.isFinite(page) || page < 1) continue;
    out.push({
      id: crypto.randomUUID(),
      pdf_id: pdfId,
      parent_id: null,
      title,
      page: Math.min(Math.round(page), doc.numPages),
      order_index: orderIndex++,
      source: 'ai-generated',
    });
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Loads the outline for `pdfId`, extracting and persisting it on first open.
 * Reuses the already-loaded PDF.js document — never re-parses the file.
 */
export async function ensureOutline(pdfId: string, doc: PDFDocumentProxy): Promise<void> {
  const store = useStore.getState();
  store.setOutlineLoading(true);
  try {
    const existingJson = await invoke<string>('get_outline', { pdfId });
    if (JSON.parse(existingJson).length > 0) {
      await store.loadOutline(pdfId);
      return;
    }

    let items = await extractEmbeddedOutline(doc, pdfId);
    if (items.length === 0) {
      items = await generateAiOutline(doc, pdfId);
    }
    if (items.length > 0) {
      await invoke('store_outline', { pdfId, items });
    }
    await store.loadOutline(pdfId);
  } catch (err) {
    console.error('[outline] extraction failed for', pdfId, err);
    store.setOutline([]);
  } finally {
    store.setOutlineLoading(false);
  }
}
