import { jsPDF } from "jspdf";
import { invoke } from "@tauri-apps/api/core";
import type { Note } from "../types";

const PAGE_MARGIN = 48;
const BODY_FONT_SIZE = 11;
const LINE_HEIGHT = 15;
const PARAGRAPH_GAP = 8;
const HEADING_SIZES: Record<1 | 2 | 3, { size: number; lineHeight: number }> = {
  1: { size: 20, lineHeight: 26 },
  2: { size: 16, lineHeight: 22 },
  3: { size: 13, lineHeight: 19 },
};

interface StyledToken {
  text: string;
  bold: boolean;
  italic: boolean;
}

function fontStyle(bold: boolean, italic: boolean): string {
  if (bold && italic) return "bolditalic";
  if (bold) return "bold";
  if (italic) return "italic";
  return "normal";
}

/** Splits a line into style-tagged word tokens, handling non-nested
 * **bold** and *italic* markdown spans. Whitespace runs are kept as their
 * own tokens so word-wrapping can measure and place them individually. */
function parseInlineStyles(line: string): StyledToken[] {
  const tokens: StyledToken[] = [];
  const push = (text: string, bold: boolean, italic: boolean) => {
    if (!text) return;
    for (const w of text.split(/(\s+)/)) {
      if (w) tokens.push({ text: w, bold, italic });
    }
  };
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line))) {
    push(line.slice(lastIndex, match.index), false, false);
    const m = match[0];
    if (m.startsWith("**")) push(m.slice(2, -2), true, false);
    else push(m.slice(1, -1), false, true);
    lastIndex = match.index + m.length;
  }
  push(line.slice(lastIndex), false, false);
  return tokens;
}

interface RenderCtx {
  doc: jsPDF;
  pageWidth: number;
  pageHeight: number;
  contentX: number;
  contentWidth: number;
  cursorY: number;
}

function ensureSpace(ctx: RenderCtx, needed: number) {
  if (ctx.cursorY + needed > ctx.pageHeight - PAGE_MARGIN) {
    ctx.doc.addPage();
    ctx.cursorY = PAGE_MARGIN;
  }
}

/** Word-wraps and draws a run of styled tokens starting at (x, cursorY),
 * advancing cursorY by one lineHeight per wrapped line. Breaks across pages
 * mid-paragraph via ensureSpace. */
function drawStyledParagraph(
  ctx: RenderCtx,
  tokens: StyledToken[],
  x: number,
  maxWidth: number,
  fontSize: number,
  lineHeight: number,
) {
  const { doc } = ctx;
  let lineTokens: StyledToken[] = [];
  let lineWidth = 0;

  const measure = (t: StyledToken) => {
    doc.setFont("helvetica", fontStyle(t.bold, t.italic));
    doc.setFontSize(fontSize);
    return doc.getTextWidth(t.text);
  };

  const flushLine = () => {
    if (lineTokens.length === 0) return;
    ensureSpace(ctx, lineHeight);
    let x0 = x;
    for (const t of lineTokens) {
      doc.setFont("helvetica", fontStyle(t.bold, t.italic));
      doc.setFontSize(fontSize);
      doc.text(t.text, x0, ctx.cursorY);
      x0 += doc.getTextWidth(t.text);
    }
    ctx.cursorY += lineHeight;
    lineTokens = [];
    lineWidth = 0;
  };

  for (const t of tokens) {
    // Leading whitespace on a fresh wrapped line is meaningless — drop it.
    if (lineTokens.length === 0 && /^\s+$/.test(t.text)) continue;
    const w = measure(t);
    if (lineWidth + w > maxWidth && lineTokens.length > 0) flushLine();
    lineTokens.push(t);
    lineWidth += w;
  }
  flushLine();
}

/** Renders a markdown segment using the lightweight tier: heading,
 * bullet-list, and bold/italic-span support. Tables, code blocks, and
 * nested lists render as plain de-markdowned paragraph text. */
function renderMarkdownSegment(ctx: RenderCtx, markdown: string) {
  const lines = markdown.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") {
      ctx.cursorY += PARAGRAPH_GAP;
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const { size, lineHeight } = HEADING_SIZES[level];
      const tokens = parseInlineStyles(headingMatch[2]).map((t) => ({ ...t, bold: true }));
      drawStyledParagraph(ctx, tokens, ctx.contentX, ctx.contentWidth, size, lineHeight);
      ctx.cursorY += PARAGRAPH_GAP / 2;
      continue;
    }

    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
    const numberedMatch = /^\d+\.\s+(.*)$/.exec(line);
    if (bulletMatch || numberedMatch) {
      const indent = 16;
      const prefix = bulletMatch ? "•  " : `${line.match(/^\d+\./)![0]}  `;
      const text = (bulletMatch ?? numberedMatch)![1];
      ensureSpace(ctx, LINE_HEIGHT);
      ctx.doc.setFont("helvetica", "normal");
      ctx.doc.setFontSize(BODY_FONT_SIZE);
      ctx.doc.text(prefix, ctx.contentX, ctx.cursorY);
      const prefixWidth = ctx.doc.getTextWidth(prefix);
      drawStyledParagraph(
        ctx,
        parseInlineStyles(text),
        ctx.contentX + Math.max(indent, prefixWidth),
        ctx.contentWidth - Math.max(indent, prefixWidth),
        BODY_FONT_SIZE,
        LINE_HEIGHT,
      );
      continue;
    }

    // Plain paragraph text (also the fallback for tables/code blocks/nested
    // lists — rendered de-markdowned rather than laid out structurally).
    drawStyledParagraph(ctx, parseInlineStyles(line), ctx.contentX, ctx.contentWidth, BODY_FONT_SIZE, LINE_HEIGHT);
  }
}

/** Exports a note's typed Markdown content to a PDF via a native Save-As
 * dialog. Lightweight markdown tier (headings/bold/italic/flat lists, no
 * tables/code blocks/nested lists) via jsPDF vector text. Any drawing data
 * on the note is intentionally ignored — this renders text only.
 *
 * The finished bytes are handed to the Rust `save_binary_file` command
 * rather than calling jsPDF's own `doc.save()` — a Tauri webview's
 * browser-style `<a download>` click does not reliably surface a save
 * prompt or write to disk, so this instead follows a dialog-then-fs::write
 * pattern.
 *
 * Returns the written file path, or "" if the user cancelled the dialog. */
export async function exportNoteToPdf(note: Note): Promise<string> {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentX = PAGE_MARGIN;
  const contentWidth = pageWidth - PAGE_MARGIN * 2;

  const ctx: RenderCtx = { doc, pageWidth, pageHeight, contentX, contentWidth, cursorY: PAGE_MARGIN };

  renderMarkdownSegment(ctx, note.content_markdown ?? "");

  const filename = (note.title || "note").replace(/[\\/:*?"<>|]+/g, "_") + ".pdf";
  const arrayBuffer = doc.output("arraybuffer") as ArrayBuffer;
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  return invoke<string>("save_binary_file", { defaultFilename: filename, bytes });
}
