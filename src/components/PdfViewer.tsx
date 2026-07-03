import { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PageViewport, RenderTask } from "pdfjs-dist";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { Highlight, HlRect, LensKey, Note, Drawing, DrawPoint, DrawToolType, TextBox } from "../types";
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_KEYS,
  type HighlightColorKey,
} from "../constants/highlights";
import { ViewerToolbar } from "./ViewerToolbar";
import { LensSwitcher } from "./LensSwitcher";
import { AnnotationDock } from "./AnnotationDock";
import { TextBoxLayer, DEFAULT_W, DEFAULT_H } from "./TextBoxLayer";
import { callAI } from "../services/aiService";
import { generateFlashcardsForHighlights } from "../services/flashcardService";
import { ensureOutline } from "../services/outlineService";

// ── AI prompts ────────────────────────────────────────────────────────────────
const EXPLAIN_SYSTEM = 'You are a helpful reading assistant. Be concise.';
const EXPLAIN_PREFIX = 'Explain this passage clearly and concisely:\n\n';
const SUMMARIZE_PREFIX = 'Summarize this page in 3–5 bullet points:\n\n';

const SUMMARIZE_BY_COLOR_SYSTEM =
  'You are a reading assistant helping a researcher review their annotations. Be concise, structured, and analytical.';

const LENS_SUMMARIZE_PROMPTS: Record<Exclude<LensKey, 'default'>, string> = {
  concepts:
    'Summarize the following key concepts and ideas I highlighted. Group related concepts together and identify the main themes:\n\n',
  revision:
    'I marked these passages as confusing or needing review. For each one, provide a clear explanation. Be direct and educational:\n\n',
  flashcards:
    'Convert these highlights into a structured study summary. For each highlight, identify the core concept that could become a flashcard:\n\n',
  quotes:
    'These are quotes I saved from the document. Briefly explain the significance of each quote and identify common themes across them:\n\n',
};

const LENS_TO_COLOR_KEY: Record<Exclude<LensKey, 'default'>, HighlightColorKey> = {
  concepts:   'yellow',
  revision:   'blue',
  flashcards: 'green',
  quotes:     'pink',
};

const LENS_LABEL: Record<Exclude<LensKey, 'default'>, string> = {
  concepts:   'Concepts',
  revision:   'Revision',
  flashcards: 'Flashcards',
  quotes:     'Quotes',
};

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface Props {
  filePath: string;
  pdfId: string;
}

type Cancellable = { cancel: () => void };

interface PickerPageInfo {
  pageNum: number;
  pdfCoords: HlRect;   // bounding box for DB
  pdfRects: HlRect[];  // per-line rects for drawing
}

interface PickerState {
  screenX: number;
  screenY: number;
  text: string;          // full selection text (shared across pages)
  pages: PickerPageInfo[];
}

interface HlPopupState {
  screenX: number;
  screenY: number;
  highlight: Highlight;
}

interface HlPickerState {
  screenX: number;
  screenY: number;
  hits: Highlight[];
}

interface ExplainState {
  x: number;
  y: number;
  selectedText: string;
  page: number;
  loading: boolean;
  response: string | null;
  error: string | null;
}

// ── Rect helpers ─────────────────────────────────────────────────────────────

// getClientRects() returns one rect per text *span*, not per line.
// Multiple spans on the same line produce overlapping rects; with multiply
// blend mode each overlap darkens the pixel again.  Merge all rects that
// share vertical space into a single per-line rect.
function mergeRects(rects: DOMRect[]): DOMRect[] {
  if (rects.length <= 1) return rects;
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: { top: number; bottom: number; left: number; right: number }[] = [];
  for (const r of sorted) {
    const prev = merged[merged.length - 1];
    // Allow 2 px vertical slack for sub-pixel anti-aliasing between spans.
    if (prev && r.top < prev.bottom - 2) {
      prev.left   = Math.min(prev.left,   r.left);
      prev.right  = Math.max(prev.right,  r.right);
      prev.bottom = Math.max(prev.bottom, r.bottom);
    } else {
      merged.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
  }
  return merged.map(({ top, left, bottom, right }) =>
    new DOMRect(left, top, right - left, bottom - top)
  );
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

function toPdfCoords(
  selectionRect: DOMRect,
  wrapperRect: DOMRect,
  viewport: PageViewport,
  scale: number
) {
  // Convert selection rect (screen coords) → wrapper-relative CSS px → PDF pt.
  // PDF y-axis is 0 at the bottom; viewport y-axis is 0 at the top.
  const relLeft = selectionRect.left - wrapperRect.left;
  const relBottom = selectionRect.bottom - wrapperRect.top;
  return {
    x: relLeft / scale,
    y: (viewport.height - relBottom) / scale,
    w: selectionRect.width / scale,
    h: selectionRect.height / scale,
  };
}

// True if two HlRects (in PDF point space) share any area.
function rectsOverlapPdf(a: HlRect, b: HlRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

// Splits pr into sub-rects at the x-boundaries of same-line rects in `others`.
// Ensures that the overlapping and non-overlapping portions of a new highlight
// that lands on the same line as an existing one are stored as distinct rects,
// so per-rect draw-time detection can treat each portion independently.
function splitAtBoundaries(pr: HlRect, others: HlRect[]): HlRect[] {
  const events = new Set([pr.x, pr.x + pr.w]);
  for (const o of others) {
    if (o.y < pr.y + pr.h && o.y + o.h > pr.y) { // same line
      if (o.x > pr.x && o.x < pr.x + pr.w) events.add(o.x);
      const ox2 = o.x + o.w;
      if (ox2 > pr.x && ox2 < pr.x + pr.w) events.add(ox2);
    }
  }
  const sorted = Array.from(events).sort((a, b) => a - b);
  return sorted
    .slice(0, -1)
    .map((x, i) => ({ x, y: pr.y, w: sorted[i + 1] - x, h: pr.h }))
    .filter((r) => r.w > 0.5);
}

// Returns the sub-rects of `pr` not covered by any rect in `covers`.
// For rects on the same line, it shaves off the covered x-ranges so a
// selection that extends past an existing highlight only creates what's new.
function uncoveredPortions(pr: HlRect, covers: HlRect[]): HlRect[] {
  // Only rects that share vertical space with pr can actually cover it.
  const sameRow = covers.filter((c) => c.y < pr.y + pr.h && c.y + c.h > pr.y);
  if (sameRow.length === 0) return [pr];

  // Horizontal interval subtraction: start with pr's full width, punch holes.
  let segs: [number, number][] = [[pr.x, pr.x + pr.w]];
  for (const c of sameRow) {
    const next: [number, number][] = [];
    for (const [l, r] of segs) {
      if (c.x + c.w <= l || c.x >= r) { next.push([l, r]); continue; }
      if (c.x > l) next.push([l, c.x]);          // left remainder
      if (c.x + c.w < r) next.push([c.x + c.w, r]); // right remainder
    }
    segs = next;
  }

  return segs
    .filter(([l, r]) => r - l > 1) // drop slivers < 1 pt
    .map(([l, r]) => ({ x: l, y: pr.y, w: r - l, h: pr.h }));
}

const STRIPE_H = 3; // CSS px per underline stripe

const LENS_COLOR: Record<string, HighlightColorKey | null> = {
  default: null,
  concepts: "yellow",
  revision: "blue",
  flashcards: "green",
  quotes: "pink",
};

function drawHighlightsForPage(
  canvas: HTMLCanvasElement,
  highlights: Highlight[],
  pageNum: number,
  viewport: PageViewport,
  scale: number,
  flashId?: string | null
) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d")!;

  // White base — neutral under CSS mix-blend-mode:multiply so non-highlighted
  // areas are invisible and only the tinted patches show on the PDF.
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pageHls = highlights.filter((h) => h.page === pageNum);
  if (pageHls.length === 0) return;

  ctx.save();
  ctx.scale(dpr, dpr);

  // ── Build per-rect draw items ─────────────────────────────────────────────
  // Overlap is evaluated per individual rect, not per highlight. This means a
  // highlight whose rects only *partially* overlap another gets a solo
  // background on its clear rects and stripe treatment only on the ones that
  // are actually shared with another highlight.
  type Item = { h: Highlight; r: HlRect; idx: number; size: number };
  const items: Item[] = [];

  for (const h of pageHls) {
    const rects: HlRect[] = h.rects ?? [{ x: h.position_x, y: h.position_y, w: h.position_w, h: h.position_h }];
    for (const r of rects) {
      const group = pageHls
        .filter((other) => {
          const or: HlRect[] = other.rects ?? [{ x: other.position_x, y: other.position_y, w: other.position_w, h: other.position_h }];
          return or.some((o) => rectsOverlapPdf(o, r));
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      items.push({ h, r, idx: group.findIndex((g) => g.id === h.id), size: group.length });
    }
  }

  // ── Phase 1: background fills ──────────────────────────────────────────────
  // source-over at 0.3 alpha blends with the white canvas base.
  // The resulting pale tint composites with the PDF via CSS mix-blend-mode:multiply
  // on .hl-canvas — white areas of the PDF receive a soft wash; text (near-black)
  // multiplies to near-black and stays fully legible.
  ctx.globalCompositeOperation = "source-over";
  for (const { h, r, idx } of items) {
    if (idx !== 0) continue;
    ctx.globalAlpha = flashId && h.id === flashId ? 0.72 : 0.3;
    const color = HIGHLIGHT_COLORS[h.color as HighlightColorKey];
    ctx.fillStyle = color.hex;
    ctx.beginPath();
    ctx.roundRect(r.x * scale, viewport.height - (r.y + r.h) * scale, r.w * scale, r.h * scale, 3);
    ctx.fill();
  }

  // ── Phase 2: split-underline stripes ──────────────────────────────────────
  // Higher alpha so multi-color region indicators remain distinct and readable.
  ctx.globalAlpha = 0.82;
  for (const { h, r, idx, size } of items) {
    if (size === 1) continue;
    const color = HIGHLIGHT_COLORS[h.color as HighlightColorKey];
    ctx.fillStyle = color.hex;
    const cx = r.x * scale;
    const cy = viewport.height - (r.y + r.h) * scale;
    const rh = r.h * scale;
    const stripeY = cy + rh - STRIPE_H * (idx + 1);
    ctx.beginPath();
    ctx.roundRect(cx, stripeY, r.w * scale, STRIPE_H, 1.5);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Color picker popup ────────────────────────────────────────────────────────

function ColorPickerPopup({
  screenX,
  screenY,
  onColorSelect,
  onExplain,
  onDismiss,
}: {
  screenX: number;
  screenY: number;
  onColorSelect: (key: HighlightColorKey) => void;
  onExplain: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="color-picker-popup"
      style={{ left: screenX, top: screenY }}
    >
      {HIGHLIGHT_COLOR_KEYS.map((key) => (
        <button
          key={key}
          className="color-picker-dot"
          title={HIGHLIGHT_COLORS[key].label}
          style={{ background: HIGHLIGHT_COLORS[key].hex }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            onColorSelect(key);
          }}
        />
      ))}
      <button
        className="color-picker-explain"
        title="Explain with AI"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onClick={onExplain}
      >
        ✦
      </button>
      <button
        className="color-picker-x"
        title="Dismiss"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onClick={onDismiss}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// ── Explain panel ─────────────────────────────────────────────────────────────

function ExplainPanel({
  state,
  onClose,
  onSaveToNotes,
}: {
  state: ExplainState;
  onClose: () => void;
  onSaveToNotes: () => void;
}) {
  const clampedX = Math.min(state.x, window.innerWidth - 340);
  const clampedY = Math.min(state.y + 8, window.innerHeight - 340);

  return (
    <div
      className="explain-panel"
      style={{ left: clampedX, top: clampedY }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="explain-panel-header">
        <span className="explain-panel-title">✦ Explanation</span>
        <button className="icon-btn" onClick={onClose}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="explain-panel-body">
        {state.loading && <span className="explain-panel-loading">Thinking…</span>}
        {state.error && <span className="explain-panel-error">{state.error}</span>}
        {state.response && <p className="explain-panel-text">{state.response}</p>}
      </div>
      {state.response && (
        <div className="explain-panel-footer">
          <button className="explain-save-btn" onClick={onSaveToNotes}>
            Save to notes
          </button>
        </div>
      )}
    </div>
  );
}

// ── Highlight detail popup ────────────────────────────────────────────────────

function HighlightDetailPopup({
  screenX,
  screenY,
  highlight,
  onDelete,
  onDismiss,
}: {
  screenX: number;
  screenY: number;
  highlight: Highlight;
  onDelete: () => void;
  onDismiss: () => void;
}) {
  const color = HIGHLIGHT_COLORS[highlight.color as HighlightColorKey];
  const preview =
    highlight.selected_text.length > 60
      ? highlight.selected_text.slice(0, 60) + "…"
      : highlight.selected_text;

  return (
    <div
      className="hl-popup"
      style={{ left: screenX, top: screenY }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="hl-popup-header">
        <span className="hl-popup-swatch" style={{ background: color.hex }} />
        <span className="hl-popup-label">{color.label}</span>
        <button className="hl-popup-close" onClick={onDismiss}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <p className="hl-popup-text">"{preview}"</p>
      {highlight.note && <p className="hl-popup-note">{highlight.note}</p>}
      <button className="hl-popup-delete" onClick={onDelete}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4h6v2" />
        </svg>
        Delete highlight
      </button>
    </div>
  );
}

// ── Overlap picker (when click hits multiple highlights) ──────────────────────

function HlPickerPopup({
  screenX,
  screenY,
  hits,
  onSelect,
  onDismiss,
}: {
  screenX: number;
  screenY: number;
  hits: Highlight[];
  onSelect: (h: Highlight) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="color-picker-popup" style={{ left: screenX, top: screenY }}>
      {hits.map((h) => (
        <button
          key={h.id}
          className="color-picker-dot"
          title={HIGHLIGHT_COLORS[h.color as HighlightColorKey].label}
          style={{ background: HIGHLIGHT_COLORS[h.color as HighlightColorKey].hex }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            onSelect(h);
          }}
        />
      ))}
      <button
        className="color-picker-x"
        title="Dismiss"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onClick={onDismiss}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// ── Drawing render helpers ────────────────────────────────────────────────────

function pdfToCanvas(p: DrawPoint, vp: PageViewport, scale: number) {
  return { x: p.x * scale, y: vp.height - p.y * scale };
}

function renderPenPath(
  ctx: CanvasRenderingContext2D,
  pts: DrawPoint[],
  color: string,
  sw: number,
  vp: PageViewport,
  scale: number,
) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = sw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  const c0 = pdfToCanvas(pts[0], vp, scale);
  ctx.moveTo(c0.x, c0.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const ci = pdfToCanvas(pts[i], vp, scale);
    const cn = pdfToCanvas(pts[i + 1], vp, scale);
    ctx.quadraticCurveTo(ci.x, ci.y, (ci.x + cn.x) / 2, (ci.y + cn.y) / 2);
  }
  const cl = pdfToCanvas(pts[pts.length - 1], vp, scale);
  ctx.lineTo(cl.x, cl.y);
  ctx.stroke();
  ctx.restore();
}

function renderArrowShape(
  ctx: CanvasRenderingContext2D,
  start: DrawPoint,
  end: DrawPoint,
  color: string,
  sw: number,
  vp: PageViewport,
  scale: number,
) {
  const s = pdfToCanvas(start, vp, scale);
  const e = pdfToCanvas(end, vp, scale);
  const angle = Math.atan2(e.y - s.y, e.x - s.x);
  const headLen = Math.max(10, sw * 4);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = sw;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(e.x, e.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(e.x, e.y);
  ctx.lineTo(
    e.x - headLen * Math.cos(angle - Math.PI / 6),
    e.y - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    e.x - headLen * Math.cos(angle + Math.PI / 6),
    e.y - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function renderRectShape(
  ctx: CanvasRenderingContext2D,
  start: DrawPoint,
  end: DrawPoint,
  color: string,
  sw: number,
  vp: PageViewport,
  scale: number,
) {
  const x1 = Math.min(start.x, end.x) * scale;
  const y1 = vp.height - Math.max(start.y, end.y) * scale;
  const w  = Math.abs(end.x - start.x) * scale;
  const h  = Math.abs(end.y - start.y) * scale;
  if (w < 1 || h < 1) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = sw;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.roundRect(x1, y1, w, h, 3);
  ctx.stroke();
  ctx.restore();
}

function renderCircleShape(
  ctx: CanvasRenderingContext2D,
  start: DrawPoint,
  end: DrawPoint,
  color: string,
  sw: number,
  vp: PageViewport,
  scale: number,
) {
  const x1 = Math.min(start.x, end.x) * scale;
  const y1 = vp.height - Math.max(start.y, end.y) * scale;
  const w  = Math.abs(end.x - start.x) * scale;
  const h  = Math.abs(end.y - start.y) * scale;
  if (w < 1 || h < 1) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = sw;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.ellipse(x1 + w / 2, y1 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawDrawingsForPage(
  canvas: HTMLCanvasElement,
  drawings: Drawing[],
  pageNum: number,
  vp: PageViewport,
  scale: number,
  activeStroke?: { points: DrawPoint[]; color: string; sw: number } | null,
  shapePreview?: { tool: DrawToolType; start: DrawPoint; end: DrawPoint; color: string; sw: number } | null,
  selectedId?: string | null,
) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const pageDrawings = drawings.filter((d) => d.page === pageNum);
  if (pageDrawings.length === 0 && !activeStroke && !shapePreview) return;

  ctx.save();
  ctx.scale(dpr, dpr);

  for (const d of pageDrawings) {
    if (d.tool_type === "pen") {
      renderPenPath(ctx, d.points, d.color, d.stroke_width, vp, scale);
    } else if (d.tool_type === "arrow" && d.points.length >= 2) {
      renderArrowShape(ctx, d.points[0], d.points[d.points.length - 1], d.color, d.stroke_width, vp, scale);
    } else if (d.tool_type === "rectangle" && d.points.length >= 2) {
      renderRectShape(ctx, d.points[0], d.points[d.points.length - 1], d.color, d.stroke_width, vp, scale);
    } else if (d.tool_type === "circle" && d.points.length >= 2) {
      renderCircleShape(ctx, d.points[0], d.points[d.points.length - 1], d.color, d.stroke_width, vp, scale);
    }
  }

  if (activeStroke && activeStroke.points.length > 1) {
    renderPenPath(ctx, activeStroke.points, activeStroke.color, activeStroke.sw, vp, scale);
  }

  if (shapePreview) {
    const { tool, start, end, color, sw } = shapePreview;
    if (tool === "arrow")     renderArrowShape(ctx, start, end, color, sw, vp, scale);
    if (tool === "rectangle") renderRectShape (ctx, start, end, color, sw, vp, scale);
    if (tool === "circle")    renderCircleShape(ctx, start, end, color, sw, vp, scale);
  }

  // ── Selection ring (dashed gold outline around selected drawing's bbox) ─────
  if (selectedId) {
    const sel = pageDrawings.find((d) => d.id === selectedId);
    if (sel && sel.points.length > 0) {
      const xs = sel.points.map((p) => p.x * scale);
      const ys = sel.points.map((p) => vp.height - p.y * scale);
      const PAD = 5;
      const rx = Math.min(...xs) - PAD;
      const ry = Math.min(...ys) - PAD;
      const rw = Math.max(...xs) - Math.min(...xs) + PAD * 2;
      const rh = Math.max(...ys) - Math.min(...ys) + PAD * 2;
      // Dark shadow pass — solid wider stroke beneath the gold so it reads on white pages
      ctx.save();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.30)";
      ctx.lineWidth = 4.5;
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.roundRect(rx, ry, rw, rh, 4);
      ctx.stroke();
      ctx.restore();

      // Gold dashed ring on top
      ctx.save();
      ctx.strokeStyle = "#ffc880"; // --accent
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.roundRect(rx, ry, rw, rh, 4);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
}

function hitTestDrawing(d: Drawing, pdfX: number, pdfY: number, scale: number): boolean {
  if (d.points.length === 0) return false;
  const PAD = 12 / scale;
  const xs = d.points.map((p) => p.x);
  const ys = d.points.map((p) => p.y);
  return (
    pdfX >= Math.min(...xs) - PAD &&
    pdfX <= Math.max(...xs) + PAD &&
    pdfY >= Math.min(...ys) - PAD &&
    pdfY <= Math.max(...ys) + PAD
  );
}

// ── PdfViewer ─────────────────────────────────────────────────────────────────

export function PdfViewer({ filePath, pdfId }: Props) {
  const {
    isAuthenticated,
    requireAuth,
    selectedPdfId,
    highlights,
    loadHighlights,
    addHighlight,
    removeHighlight,
    activeLens,
    setActiveLens,
    loadNotes,
    addNote,
    setSelectedNoteId,
    setCurrentPage: storeSetCurrentPage,
    setJumpToPage,
    leftPanelOpen,
    rightPanelOpen,
    setLeftPanelOpen,
    setRightPanelOpen,
    setSummary,
    setIsSummarizing,
    clearSummary,
    pendingJumpPage,
    setPendingJumpPage,
    flashHighlightId,
    setFlashHighlightId,
    drawings,
    loadDrawings,
    addDrawing,
    removeDrawing,
    drawMode,
    setDrawMode,
    activeDrawTool,
    drawColor,
    strokeWidth,
    textBoxes,
    loadTextBoxes,
    addTextBox,
    removeTextBox,
    selectedTextBoxId,
    setSelectedTextBoxId,
    placingTextBox,
    setPlacingTextBox,
    setEditingTextBoxId,
    setExportDialogOpen,
    flashcards,
    loadFlashcards,
    addFlashcard,
    isGeneratingFlashcards,
    setIsGeneratingFlashcards,
    generationProgress,
    setGenerationProgress,
    startReview,
    setOutline,
    setOutlineLoading,
    setOutlineAttempted,
    setRequestOutlineExtraction,
  } = useStore();

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Increments after viewportsRef is fully populated — triggers TextBoxLayer re-renders
  const [viewportVersion, setViewportVersion] = useState(0);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [trashPos, setTrashPos] = useState<{ x: number; y: number } | null>(null);
  const selectedDrawingIdRef = useRef<string | null>(null);
  useEffect(() => { selectedDrawingIdRef.current = selectedDrawingId; }, [selectedDrawingId]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [flashGenResult, setFlashGenResult] = useState<{ count: number } | null>(null);
  const [hlPopup, setHlPopup] = useState<HlPopupState | null>(null);
  const [hlPicker, setHlPicker] = useState<HlPickerState | null>(null);
  const [explainPanel, setExplainPanel] = useState<ExplainState | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hlCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const drawCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const viewportsRef = useRef<(PageViewport | null)[]>([]);
  const renderIdRef = useRef(0);
  const cancellablesRef = useRef<Cancellable[]>([]);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  // Mirror of highlights + activeLens for use inside the async render loop
  // without needing them in the dependency array.
  const highlightsRef = useRef<Highlight[]>(highlights);
  useEffect(() => { highlightsRef.current = highlights; }, [highlights]);
  const activeLensRef = useRef(activeLens);
  useEffect(() => { activeLensRef.current = activeLens; }, [activeLens]);
  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // ── Draw mode refs (avoid stale closures in document-level listeners) ────────
  const drawingsRef = useRef<Drawing[]>(drawings);
  useEffect(() => { drawingsRef.current = drawings; }, [drawings]);
  const drawColorRef = useRef(drawColor);
  useEffect(() => { drawColorRef.current = drawColor; }, [drawColor]);
  const strokeWidthRef = useRef(strokeWidth);
  useEffect(() => { strokeWidthRef.current = strokeWidth; }, [strokeWidth]);
  const activeDrawToolRef = useRef<DrawToolType>(activeDrawTool);
  useEffect(() => { activeDrawToolRef.current = activeDrawTool; }, [activeDrawTool]);
  const drawModeRef = useRef(drawMode);
  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);
  // Note: placingTextBox is read via useStore.getState() inside handleDrawStart
  // so that it always reflects the current Zustand value, not a stale ref copy.
  const pdfIdRef = useRef(pdfId);
  useEffect(() => { pdfIdRef.current = pdfId; }, [pdfId]);

  // ── Draw stroke state (mutable, no re-render needed during drawing) ──────────
  const isDrawingRef     = useRef(false);
  const currentStrokeRef = useRef<DrawPoint[]>([]);
  const shapeStartRef    = useRef<DrawPoint | null>(null);
  const activeDrawPageRef = useRef(-1);
  const sessionUndoIds   = useRef<string[]>([]);

  // ── Reset text-box transient state whenever draw mode exits ────────────────
  useEffect(() => {
    if (!drawMode) {
      setPlacingTextBox(false);
      setEditingTextBoxId(null);
    }
  }, [drawMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load document ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      renderIdRef.current += 1;
      cancellablesRef.current.forEach((c) => c.cancel());
      cancellablesRef.current = [];
      pdfDocRef.current?.cleanup();
      pdfDocRef.current = null;
      viewportsRef.current = [];
      setPicker(null);
      setHlPopup(null);
      setHlPicker(null);
      setSelectedDrawingId(null);
      setTrashPos(null);
      setFlashGenResult(null);
      // Reset draw session state on PDF switch
      isDrawingRef.current = false;
      currentStrokeRef.current = [];
      shapeStartRef.current = null;
      sessionUndoIds.current = [];

      setLoading(true);
      setError(null);
      setPdfDoc(null);
      setNumPages(0);
      setCurrentPage(1);
      setOutline([]);

      try {
        const bytes = await invoke<number[]>("read_file", { path: filePath });
        if (cancelled) return;

        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
        const doc = await loadingTask.promise;
        if (cancelled) { doc.cleanup(); return; }

        pdfDocRef.current = doc;

        const pg1 = await doc.getPage(1);
        if (cancelled) { doc.cleanup(); return; }

        const naturalWidth = pg1.getViewport({ scale: 1.0 }).width;
        const availableWidth = (containerRef.current?.clientWidth ?? 800) - 48;
        const fitScale = Math.max(0.5, Math.min(3.0, availableWidth / naturalWidth));

        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setScale(fitScale);

        invoke("update_last_opened", { id: pdfId }).catch(() => {});
        loadHighlights(pdfId).catch(() => {});
        loadNotes(pdfId).catch(() => {});
        loadDrawings(pdfId).catch(() => {});
        loadTextBoxes(pdfId).catch(() => {});
        loadFlashcards(pdfId).catch(() => {});
        // Outline extraction is deferred until the user expands the Outline
        // section in the left nav — just hand it a trigger to call lazily.
        setRequestOutlineExtraction(() => {
          setOutlineAttempted(true);
          setOutlineLoading(true);
          ensureOutline(pdfId, doc).catch((err) => console.error('[outline]', err));
        });
        setSelectedNoteId(null);
        storeSetCurrentPage(1);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
      setRequestOutlineExtraction(null);
    };
  }, [filePath, pdfId]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render pages + highlights ──────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc || numPages === 0) return;

    const renderId = ++renderIdRef.current;
    cancellablesRef.current.forEach((c) => c.cancel());
    cancellablesRef.current = [];

    const renderAll = async () => {
      for (let i = 1; i <= numPages; i++) {
        if (renderIdRef.current !== renderId) return;

        const wrapper    = pageRefs.current[i - 1];
        const canvas     = wrapper?.querySelector<HTMLCanvasElement>(".page-canvas");
        const hlCanvas   = hlCanvasRefs.current[i - 1];
        const drawCanvas = drawCanvasRefs.current[i - 1];
        const textDiv    = wrapper?.querySelector<HTMLDivElement>(".textLayer");
        if (!wrapper || !canvas || !textDiv) continue;

        try {
          const page = await pdfDoc.getPage(i);
          if (renderIdRef.current !== renderId) return;

          const vp = page.getViewport({ scale });
          viewportsRef.current[i - 1] = vp;
          setViewportVersion((v) => v + 1);

          const dpr = window.devicePixelRatio || 1;
          const cssW = `${vp.width}px`;
          const cssH = `${vp.height}px`;
          const phyW = Math.floor(vp.width * dpr);
          const phyH = Math.floor(vp.height * dpr);

          // Size page canvas
          canvas.width = phyW;
          canvas.height = phyH;
          canvas.style.width = cssW;
          canvas.style.height = cssH;

          // Size highlight canvas to match
          if (hlCanvas) {
            hlCanvas.width = phyW;
            hlCanvas.height = phyH;
            hlCanvas.style.width = cssW;
            hlCanvas.style.height = cssH;
          }

          // Size drawing canvas to match
          if (drawCanvas) {
            drawCanvas.width = phyW;
            drawCanvas.height = phyH;
            drawCanvas.style.width = cssW;
            drawCanvas.style.height = cssH;
          }

          wrapper.style.width = cssW;
          wrapper.style.height = cssH;
          textDiv.innerHTML = "";
          // pdfjs v6 computes font-size via calc(--total-scale-factor * --font-height).
          // We must set this variable since we don't use PDFViewerApplication.
          textDiv.style.setProperty("--total-scale-factor", String(scale));

          const ctx = canvas.getContext("2d")!;
          ctx.scale(dpr, dpr);

          const renderTask: RenderTask = page.render({ canvas, canvasContext: ctx, viewport: vp });
          cancellablesRef.current.push(renderTask);
          await renderTask.promise;

          if (renderIdRef.current !== renderId) return;

          const tl = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: textDiv,
            viewport: vp,
          });
          cancellablesRef.current.push(tl);
          await tl.render();

          // Draw stored highlights for this page, filtered by the active lens.
          // Uses refs so this loop doesn't pull highlights/lens into its dep array.
          if (hlCanvas) {
            const lc = LENS_COLOR[activeLensRef.current];
            const visible = lc
              ? highlightsRef.current.filter((h) => h.color === lc)
              : [];
            drawHighlightsForPage(hlCanvas, visible, i, vp, scale);
          }

          if (drawCanvas) {
            drawDrawingsForPage(drawCanvas, drawingsRef.current, i, vp, scale, null, null, selectedDrawingIdRef.current);
          }
        } catch {
          // Cancelled tasks throw a benign error; skip silently.
        }
      }
    };

    renderAll();
  }, [pdfDoc, scale, numPages]);

  // ── Redraw highlights when they change or the active lens switches ────────
  useEffect(() => {
    const lc = LENS_COLOR[activeLens];
    const visible = lc ? highlights.filter((h) => h.color === lc) : [];
    for (let i = 0; i < numPages; i++) {
      const hlCanvas = hlCanvasRefs.current[i];
      const vp = viewportsRef.current[i];
      if (hlCanvas && vp) {
        drawHighlightsForPage(hlCanvas, visible, i + 1, vp, scale);
      }
    }
  }, [highlights, numPages, scale, activeLens]);

  // ── Redraw drawings when they change, scale changes, or selection changes ───
  useEffect(() => {
    for (let i = 0; i < numPages; i++) {
      const canvas = drawCanvasRefs.current[i];
      const vp = viewportsRef.current[i];
      if (canvas && vp) {
        drawDrawingsForPage(canvas, drawings, i + 1, vp, scale, null, null, selectedDrawingId);
      }
    }
  }, [drawings, numPages, scale, selectedDrawingId]);

  // ── Flash animation when a highlight is selected from the panel ───────────
  useEffect(() => {
    if (!flashHighlightId) return;

    const hl = highlightsRef.current.find((h) => h.id === flashHighlightId);
    if (!hl) { setFlashHighlightId(null); return; }

    const lensColorKey = LENS_COLOR[activeLensRef.current];
    if (lensColorKey && hl.color !== lensColorKey) {
      setFlashHighlightId(null);
      return;
    }

    const pageIdx = hl.page - 1;
    const hlCanvas = hlCanvasRefs.current[pageIdx];
    const vp = viewportsRef.current[pageIdx];
    if (!hlCanvas || !vp) { setFlashHighlightId(null); return; }

    const lc = LENS_COLOR[activeLensRef.current];
    const normalVisible = lc
      ? highlightsRef.current.filter((h) => h.color === lc)
      : highlightsRef.current;
    const flashVisible = normalVisible.some((h) => h.id === flashHighlightId)
      ? normalVisible
      : [...normalVisible, hl];

    let cancelled = false;
    const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

    const runFlash = async () => {
      for (let i = 0; i < 3; i++) {
        if (cancelled) break;
        drawHighlightsForPage(hlCanvas, flashVisible, hl.page, vp, scaleRef.current, flashHighlightId);
        await delay(180);
        if (cancelled) break;
        drawHighlightsForPage(hlCanvas, normalVisible, hl.page, vp, scaleRef.current, null);
        await delay(120);
      }
      if (!cancelled) setFlashHighlightId(null);
    };

    runFlash();
    return () => { cancelled = true; };
  }, [flashHighlightId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Explain handler ────────────────────────────────────────────────────────
  const handleExplain = useCallback(async () => {
    if (!isAuthenticated) return requireAuth('Sign in to explain this selection', () => handleExplain());
    if (!picker) return;
    const text = picker.text;
    const page = picker.pages[0]?.pageNum ?? 1;
    const x = picker.screenX;
    const y = picker.screenY;
    setPicker(null);
    window.getSelection()?.removeAllRanges();
    setExplainPanel({ x, y, selectedText: text, page, loading: true, response: null, error: null });
    try {
      const response = await callAI([
        { role: 'system', content: EXPLAIN_SYSTEM },
        { role: 'user',   content: EXPLAIN_PREFIX + text },
      ]);
      setExplainPanel((prev) => prev ? { ...prev, loading: false, response } : null);
    } catch (err) {
      setExplainPanel((prev) =>
        prev ? { ...prev, loading: false, error: err instanceof Error ? err.message : String(err) } : null
      );
    }
  }, [picker]);

  // ── Summarize page handler ─────────────────────────────────────────────────
  const handleSummarizePage = useCallback(async () => {
    if (!isAuthenticated) return requireAuth('Sign in to summarize this page', () => handleSummarizePage());
    if (!pdfDocRef.current) return;
    setExplainPanel({ x: window.innerWidth / 2 - 160, y: 60, selectedText: '', page: currentPage, loading: true, response: null, error: null });
    try {
      const page = await pdfDocRef.current.getPage(currentPage);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item) => 'str' in item)
        .map((item) => (item as { str: string }).str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) {
        setExplainPanel((prev) => prev ? { ...prev, loading: false, error: 'No text found on this page.' } : null);
        return;
      }
      const response = await callAI([
        { role: 'system', content: EXPLAIN_SYSTEM },
        { role: 'user',   content: SUMMARIZE_PREFIX + text },
      ]);
      setExplainPanel((prev) => prev ? { ...prev, loading: false, response } : null);
    } catch (err) {
      setExplainPanel((prev) =>
        prev ? { ...prev, loading: false, error: err instanceof Error ? err.message : String(err) } : null
      );
    }
  }, [currentPage]);

  // ── Summarize by color (lens) ─────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const handleSummarizeByColor = useCallback(async () => {
    if (!isAuthenticated) return requireAuth('Sign in to summarize by lens', () => handleSummarizeByColor());
    if (activeLens === 'default') return;
    const lens = activeLens as Exclude<LensKey, 'default'>;
    const colorKey = LENS_TO_COLOR_KEY[lens];
    const lensHighlights = highlights
      .filter((h) => h.color === colorKey)
      .sort((a, b) => a.page - b.page);

    if (lensHighlights.length === 0) {
      showToast(`No ${LENS_LABEL[lens]} highlights to summarize`);
      return;
    }

    const formatted = lensHighlights
      .map((h) => `Page ${h.page}: ${h.selected_text}`)
      .join('\n');

    setSummary(null, activeLens);
    setIsSummarizing(true);

    try {
      const response = await callAI([
        { role: 'system', content: SUMMARIZE_BY_COLOR_SYSTEM },
        { role: 'user',   content: LENS_SUMMARIZE_PROMPTS[lens] + formatted },
      ]);
      setSummary(response, activeLens);
    } catch (err) {
      console.error('[summary] Failed:', err);
      showToast(err instanceof Error ? err.message : 'Summary failed');
      clearSummary();
    } finally {
      setIsSummarizing(false);
    }
  }, [activeLens, highlights, setSummary, setIsSummarizing, clearSummary, showToast]);

  const handleGenerateFlashcards = useCallback(async () => {
    if (!isAuthenticated) return requireAuth('Sign in to generate flashcards', () => handleGenerateFlashcards());
    const existingIds = new Set(flashcards.map((f) => f.source_highlight_id));
    const greenHighlights = highlights.filter((h) => h.color === 'green');
    const pending = greenHighlights.filter((h) => !existingIds.has(h.id));
    if (pending.length === 0) {
      showToast(
        greenHighlights.length === 0
          ? 'No flashcard highlights yet'
          : 'All flashcard highlights already have cards'
      );
      return;
    }
    setIsGeneratingFlashcards(true);
    setGenerationProgress({ done: 0, total: pending.length });
    setFlashGenResult(null);
    try {
      const created = await generateFlashcardsForHighlights(pending, setGenerationProgress);
      created.forEach(addFlashcard);
      if (created.length > 0) {
        setFlashGenResult({ count: created.length });
      } else {
        showToast('Flashcard generation failed for all highlights');
      }
    } catch (err) {
      console.error('[flashcards] Generation failed:', err);
      showToast(err instanceof Error ? err.message : 'Flashcard generation failed');
    } finally {
      setIsGeneratingFlashcards(false);
      setGenerationProgress(null);
    }
  }, [highlights, flashcards, addFlashcard, setIsGeneratingFlashcards, setGenerationProgress, showToast]);

  // ── Save explanation to notes ─────────────────────────────────────────────
  const handleSaveExplainToNotes = useCallback(async () => {
    if (!explainPanel?.response || !selectedPdfId) return;
    try {
      const title = explainPanel.selectedText
        ? `Explanation — ${explainPanel.selectedText.slice(0, 45)}`
        : `Page ${explainPanel.page} summary`;
      const noteJson = await invoke<string>('create_note', {
        title,
        sourcePdfId: selectedPdfId,
        sourcePage: explainPanel.page,
      });
      const note = JSON.parse(noteJson) as Note;
      // Persist the explanation as the note's content
      await invoke('update_note', {
        id: note.id,
        title: note.title,
        contentMarkdown: explainPanel.response,
      });
      addNote({ ...note, content_markdown: explainPanel.response });
      setSelectedNoteId(note.id);
      setExplainPanel(null);
    } catch (err) {
      console.error('Failed to save explanation to notes:', err);
    }
  }, [explainPanel, selectedPdfId, addNote, setSelectedNoteId]);

  // ── Close popups via Escape or outside mousedown ───────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (drawModeRef.current) {
          setDrawMode(false);
          // useEffect on drawMode clears placingTextBox + editingTextBoxId
          isDrawingRef.current = false;
          currentStrokeRef.current = [];
          shapeStartRef.current = null;
          sessionUndoIds.current = [];
        }
        setPicker(null);
        setHlPopup(null);
        setHlPicker(null);
        setExplainPanel(null);
        setSelectedDrawingId(null);
        setSelectedTextBoxId(null);
        setEditingTextBoxId(null);
        setTrashPos(null);
        window.getSelection()?.removeAllRanges();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!picker && !hlPopup && !hlPicker && !selectedDrawingId && !selectedTextBoxId) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (
        !t.closest(".color-picker-popup") &&
        !t.closest(".hl-popup") &&
        !t.closest(".explain-panel") &&
        !t.closest(".drawing-trash-btn") &&
        !t.closest(".text-box") &&
        !t.closest(".tb-mini-toolbar")
      ) {
        setPicker(null);
        setHlPopup(null);
        setHlPicker(null);
        setSelectedDrawingId(null);
        setSelectedTextBoxId(null);
        setEditingTextBoxId(null);
        setTrashPos(null);
        // Restore crosshair so user can place another box
        if (drawModeRef.current && activeDrawToolRef.current === 'textbox') {
          setPlacingTextBox(true);
        }
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [picker, hlPopup, hlPicker, selectedDrawingId, selectedTextBoxId, setSelectedTextBoxId, setEditingTextBoxId, setPlacingTextBox]);

  // ── Text selection → color picker ─────────────────────────────────────────
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(".color-picker-popup,.hl-popup"))
        return;

      // Capture cursor position now — inside setTimeout the event is recycled.
      const mouseX = e.clientX;
      const mouseY = e.clientY;

      // Defer so the browser has committed the final selection range.
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

        const range = sel.getRangeAt(0);

        // Raw span-level rects filtered to meaningful size.
        const rawRects = Array.from(range.getClientRects()).filter(
          (r) => r.width > 1 && r.height > 1
        );
        if (rawRects.length === 0) return;

        // ── Group raw rects by page ───────────────────────────────────────────
        // Each rect belongs to the page whose bounding box contains its vertical
        // centre. This handles cross-page selections transparently.
        const byPage = new Map<number, DOMRect[]>();
        for (const cr of rawRects) {
          const cy = cr.top + cr.height / 2;
          for (let i = 0; i < pageRefs.current.length; i++) {
            const el = pageRefs.current[i];
            if (!el) continue;
            const pb = el.getBoundingClientRect();
            if (cy >= pb.top && cy <= pb.bottom) {
              if (!byPage.has(i)) byPage.set(i, []);
              byPage.get(i)!.push(cr);
              break;
            }
          }
        }
        if (byPage.size === 0) return;

        // ── Build per-page picker infos ───────────────────────────────────────
        const pages: PickerPageInfo[] = [];
        for (const [pageIdx, pageRawRects] of byPage) {
          const viewport = viewportsRef.current[pageIdx];
          const wrapper  = pageRefs.current[pageIdx];
          if (!viewport || !wrapper) continue;

          // Merge within this page so each line becomes one rect.
          const merged = mergeRects(pageRawRects);
          const wrapperRect = wrapper.getBoundingClientRect();
          const pdfRects = merged.map((r) => toPdfCoords(r, wrapperRect, viewport, scale));

          const bx = Math.min(...pdfRects.map((r) => r.x));
          const by = Math.min(...pdfRects.map((r) => r.y));
          const bw = Math.max(...pdfRects.map((r) => r.x + r.w)) - bx;
          const bh = Math.max(...pdfRects.map((r) => r.y + r.h)) - by;

          pages.push({ pageNum: pageIdx + 1, pdfCoords: { x: bx, y: by, w: bw, h: bh }, pdfRects });
        }
        if (pages.length === 0) return;

        // Popup appears just above the mouse cursor — which is at the END of
        // the selection — so the user never has to scroll to find it.
        setPicker({ screenX: mouseX, screenY: mouseY, text: sel.toString().trim(), pages });
        setHlPopup(null);
        setHlPicker(null);
      }, 0);
    },
    [scale]
  );

  // ── Click on existing highlight ────────────────────────────────────────────
  const handlePagesClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(".color-picker-popup,.hl-popup"))
        return;

      // In default (Read) mode no highlights are visible — disable all highlight interaction.
      if (activeLens === "default") return;

      // If there is an active text selection the user is selecting, not clicking.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;

      let pageNum = -1;
      for (let i = 0; i < pageRefs.current.length; i++) {
        if (pageRefs.current[i]?.contains(e.target as Node)) {
          pageNum = i + 1;
          break;
        }
      }
      if (pageNum === -1) { setHlPopup(null); return; }

      const wrapper = pageRefs.current[pageNum - 1]!;
      const wrapperRect = wrapper.getBoundingClientRect();
      const viewport = viewportsRef.current[pageNum - 1];
      if (!viewport) return;

      // Click position in PDF coordinate space.
      const pdfX = (e.clientX - wrapperRect.left) / scale;
      const pdfY = (viewport.height - (e.clientY - wrapperRect.top)) / scale;

      // Only the color visible in the active lens is interactive — clicks on
      // highlights from other lenses (which are invisible) are ignored.
      const lensColor = LENS_COLOR[activeLens];

      // Per-line rect hit testing — much more accurate than bounding box.
      const hits = highlights.filter((h) => {
        if (h.page !== pageNum) return false;
        if (lensColor && h.color !== lensColor) return false;
        const rects: HlRect[] = h.rects ?? [
          { x: h.position_x, y: h.position_y, w: h.position_w, h: h.position_h },
        ];
        return rects.some(
          (r) => pdfX >= r.x && pdfX <= r.x + r.w && pdfY >= r.y && pdfY <= r.y + r.h
        );
      });

      if (hits.length === 1) {
        setHlPopup({ screenX: e.clientX, screenY: e.clientY, highlight: hits[0] });
        setHlPicker(null);
        setPicker(null);
      } else if (hits.length > 1) {
        // Multiple overlapping highlights — let user pick which one to inspect.
        setHlPicker({ screenX: e.clientX, screenY: e.clientY, hits });
        setHlPopup(null);
        setPicker(null);
      } else {
        setHlPopup(null);
        setHlPicker(null);

        // ── Hit-test drawings when no highlight was clicked ───────────────────
        if (!drawModeRef.current) {
          const pageDrawings = drawingsRef.current.filter((d) => d.page === pageNum);
          for (const d of pageDrawings) {
            if (hitTestDrawing(d, pdfX, pdfY, scale)) {
              setSelectedDrawingId(d.id);
              // Trash button anchors to the top-right corner of the drawing bbox
              const xs = d.points.map((p) => p.x);
              const ys = d.points.map((p) => p.y);
              const bboxMaxX = Math.max(...xs);
              const bboxMaxY = Math.max(...ys);
              const screenX = wrapperRect.left + bboxMaxX * scale;
              const screenY = wrapperRect.top + (viewport.height - bboxMaxY * scale);
              setTrashPos({ x: screenX, y: screenY });
              return;
            }
          }
          setSelectedDrawingId(null);
          setTrashPos(null);
        }
      }
    },
    [highlights, scale, activeLens]
  );

  // ── Clear PDF text selection on any mousedown outside a text span ───────────
  // Guard changed from .closest('.textLayer') to a tag-level check:
  // the .textLayer *container* div covers intra-line whitespace gaps —
  // clicks there still return the container as e.target, so the old guard
  // skipped the clear. Now we only preserve selection when the click lands
  // on an actual <span> or <br> inside the text layer.
  // requestAnimationFrame deferred clear handles WebView2's async visual
  // repaint, which can leave the blue highlight painted for one extra frame
  // after removeAllRanges() is called synchronously.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (drawModeRef.current) return;
      const target = e.target as HTMLElement;
      const onTextSpan =
        (target.tagName === "SPAN" || target.tagName === "BR") &&
        !!target.closest(".textLayer");
      if (onTextSpan) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      sel.removeAllRanges();
      requestAnimationFrame(() => window.getSelection()?.removeAllRanges());
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".textLayer")) active.blur();
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Delete a drawing (from trash button or keyboard) ──────────────────────
  const deleteSelectedDrawing = useCallback(async (id?: string) => {
    const target = id ?? selectedDrawingId;
    if (!target) return;
    try {
      await invoke("delete_drawing", { id: target });
      removeDrawing(target);
    } catch (err) {
      console.error("Failed to delete drawing:", err);
    }
    setSelectedDrawingId(null);
    setTrashPos(null);
  }, [selectedDrawingId, removeDrawing]);

  // ── Keyboard Delete / Backspace deletes the selected drawing or text box ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isEditable = (e.target as HTMLElement).isContentEditable;
      if (tag === "INPUT" || tag === "TEXTAREA" || isEditable) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedDrawingId) {
          deleteSelectedDrawing();
        } else if (selectedTextBoxId) {
          invoke('delete_text_box', { id: selectedTextBoxId }).catch(console.error);
          removeTextBox(selectedTextBoxId);
          setSelectedTextBoxId(null);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedDrawingId, deleteSelectedDrawing, selectedTextBoxId, removeTextBox, setSelectedTextBoxId]);

  // ── Text box placement click ───────────────────────────────────────────────
  const handlePlaceTextBox = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      // Find which page was clicked
      let pageIdx = -1;
      for (let i = 0; i < pageRefs.current.length; i++) {
        const el = pageRefs.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          pageIdx = i;
          break;
        }
      }
      if (pageIdx < 0) return;
      const vp = viewportsRef.current[pageIdx];
      if (!vp) return;

      const wrapper = pageRefs.current[pageIdx]!;
      const r = wrapper.getBoundingClientRect();
      const pdfX = (e.clientX - r.left) / scaleRef.current;
      const pdfY = (vp.height - (e.clientY - r.top)) / scaleRef.current - DEFAULT_H;

      try {
        const json = await invoke<string>('add_text_box', {
          pdfId: pdfIdRef.current,
          page: pageIdx + 1,
          x: pdfX,
          y: pdfY,
          width: DEFAULT_W,
          height: DEFAULT_H,
          fontSize: 14,
          color: '#eee0d2',
        });
        const tb: TextBox = JSON.parse(json);
        addTextBox(tb);
        setSelectedTextBoxId(tb.id);
        // Signal auto-focus and exit crosshair mode until the box is blurred
        setEditingTextBoxId(tb.id);
        setPlacingTextBox(false);
      } catch (err) {
        console.error('[textbox] Failed to place:', err);
      }
    },
    [addTextBox, setSelectedTextBoxId, setEditingTextBoxId, setPlacingTextBox],
  );

  // ── Reset canvas drawing state whenever the active tool changes ───────────
  // This cancels any in-progress pen stroke or shape if the user switches tools
  // mid-draw, and ensures text-box placement mode is cleanly activated.
  useEffect(() => {
    isDrawingRef.current = false;
    currentStrokeRef.current = [];
    shapeStartRef.current = null;
  }, [activeDrawTool]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draw mode: start a stroke / shape ─────────────────────────────────────
  const handleDrawStart = useCallback(
    (e: React.MouseEvent) => {
      if (!drawModeRef.current) return;

      // Read placingTextBox and activeDrawTool directly from Zustand state —
      // NOT from refs — because Zustand's set() is synchronous while ref updates
      // happen via useEffect (after render). Reading getState() here avoids the
      // stale-ref race where a just-updated placingTextBox is still false in the ref.
      const { activeDrawTool: currentTool, placingTextBox: isPlacing } = useStore.getState();

      // Text box tool: only place when in place mode
      if (currentTool === 'textbox') {
        if (isPlacing) handlePlaceTextBox(e);
        return;
      }
      e.preventDefault();

      // Find which page was clicked
      let pageIdx = -1;
      for (let i = 0; i < pageRefs.current.length; i++) {
        const el = pageRefs.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          pageIdx = i;
          break;
        }
      }
      if (pageIdx < 0) return;

      const vp = viewportsRef.current[pageIdx];
      if (!vp) return;

      isDrawingRef.current = true;
      activeDrawPageRef.current = pageIdx;

      const wrapper = pageRefs.current[pageIdx]!;
      const tool = activeDrawToolRef.current;

      const toPoint = (ev: { clientX: number; clientY: number }): DrawPoint => {
        const r = wrapper.getBoundingClientRect();
        return {
          x: (ev.clientX - r.left) / scaleRef.current,
          y: (vp.height - (ev.clientY - r.top)) / scaleRef.current,
        };
      };

      const startPt = toPoint(e);
      if (tool === "pen") {
        currentStrokeRef.current = [startPt];
      } else {
        shapeStartRef.current = startPt;
      }

      const drawCanvas = drawCanvasRefs.current[pageIdx];

      const onMove = (ev: MouseEvent) => {
        if (!isDrawingRef.current) return;
        const point = toPoint(ev);
        const localVp = viewportsRef.current[pageIdx]!;

        if (tool === "pen") {
          currentStrokeRef.current = [...currentStrokeRef.current, point];
          if (drawCanvas && localVp) {
            drawDrawingsForPage(drawCanvas, drawingsRef.current, pageIdx + 1, localVp, scaleRef.current,
              { points: currentStrokeRef.current, color: drawColorRef.current, sw: strokeWidthRef.current },
              null,
            );
          }
        } else {
          if (drawCanvas && localVp && shapeStartRef.current) {
            drawDrawingsForPage(drawCanvas, drawingsRef.current, pageIdx + 1, localVp, scaleRef.current,
              null,
              { tool, start: shapeStartRef.current, end: point, color: drawColorRef.current, sw: strokeWidthRef.current },
            );
          }
        }
      };

      const onUp = async (ev: MouseEvent) => {
        isDrawingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        const localVp = viewportsRef.current[pageIdx];
        const endPt = toPoint(ev);
        let points: DrawPoint[];

        if (tool === "pen") {
          points = currentStrokeRef.current;
          currentStrokeRef.current = [];
        } else {
          if (!shapeStartRef.current) return;
          const dx = Math.abs(endPt.x - shapeStartRef.current.x);
          const dy = Math.abs(endPt.y - shapeStartRef.current.y);
          // Discard clicks (no drag)
          if (dx < 4 / scaleRef.current && dy < 4 / scaleRef.current) {
            if (drawCanvas && localVp) drawDrawingsForPage(drawCanvas, drawingsRef.current, pageIdx + 1, localVp, scaleRef.current);
            shapeStartRef.current = null;
            return;
          }
          points = [shapeStartRef.current, endPt];
          shapeStartRef.current = null;
        }

        if (points.length < 2) return;

        try {
          const json = await invoke<string>("add_drawing", {
            pdfId: pdfIdRef.current,
            page: pageIdx + 1,
            toolType: tool,
            color: drawColorRef.current,
            strokeWidth: strokeWidthRef.current,
            points: JSON.stringify(points),
          });
          const raw = JSON.parse(json);
          const drawing: Drawing = {
            ...raw,
            points: typeof raw.points === "string" ? JSON.parse(raw.points) : raw.points,
          };
          addDrawing(drawing);
          sessionUndoIds.current = [...sessionUndoIds.current, drawing.id];
        } catch (err) {
          console.error("[draw] Failed to save:", err);
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [addDrawing],
  );

  // ── Draw mode: undo last drawing in session ────────────────────────────────
  const handleDrawUndo = useCallback(async () => {
    const ids = sessionUndoIds.current;
    if (ids.length === 0) return;
    const lastId = ids[ids.length - 1];
    sessionUndoIds.current = ids.slice(0, -1);
    try {
      await invoke("delete_drawing", { id: lastId });
      removeDrawing(lastId);
    } catch (err) {
      console.error("[draw] Undo failed:", err);
    }
  }, [removeDrawing]);

  // ── Save new highlight ─────────────────────────────────────────────────────
  const handleColorSelect = useCallback(
    async (colorKey: HighlightColorKey) => {
      if (!picker) return;

      // One highlight per page — handles cross-page selections.
      for (const pageInfo of picker.pages) {
        const allPageRects: HlRect[] = highlights
          .filter((h) => h.page === pageInfo.pageNum)
          .flatMap((h) => h.rects ?? [{ x: h.position_x, y: h.position_y, w: h.position_w, h: h.position_h }]);

        const splitRects = pageInfo.pdfRects.flatMap((pr) =>
          splitAtBoundaries(pr, allPageRects)
        );

        const existingRects: HlRect[] = highlights
          .filter((h) => h.color === colorKey && h.page === pageInfo.pageNum)
          .flatMap((h) => h.rects ?? [{ x: h.position_x, y: h.position_y, w: h.position_w, h: h.position_h }]);

        const uncovered = splitRects.flatMap((pr) => uncoveredPortions(pr, existingRects));
        if (uncovered.length === 0) continue; // entirely covered on this page

        const bx = Math.min(...uncovered.map((r) => r.x));
        const by = Math.min(...uncovered.map((r) => r.y));
        const bw = Math.max(...uncovered.map((r) => r.x + r.w)) - bx;
        const bh = Math.max(...uncovered.map((r) => r.y + r.h)) - by;

        try {
          const json = await invoke<string>("add_highlight", {
            pdfId,
            page: pageInfo.pageNum,
            color: colorKey,
            selectedText: picker.text,
            x: bx, y: by, w: bw, h: bh,
            rects: JSON.stringify(uncovered),
          });
          addHighlight(JSON.parse(json) as Highlight);
        } catch (err) {
          console.error("[handleColorSelect] invoke failed:", err);
        }
      }

      window.getSelection()?.removeAllRanges();
      setPicker(null);
    },
    [picker, pdfId, addHighlight, highlights]
  );

  // ── Scroll tracking ────────────────────────────────────────────────────────
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, clientHeight, scrollHeight } = container;

    // Bottom guard: scrolled all the way to the end → force last page.
    if (scrollTop + clientHeight >= scrollHeight - 10) {
      setCurrentPage(numPages);
      storeSetCurrentPage(numPages);
      setPicker(null);
      setHlPopup(null);
      setHlPicker(null);
      return;
    }

    // Find the page whose vertical center is closest to the viewport center.
    // This is correct at all zoom levels — the old top-edge test broke at low
    // zoom because many pages fit on screen and the top never reached the last pages.
    const viewportMid = scrollTop + clientHeight / 2;
    let closestPage = 1;
    let closestDist = Infinity;
    for (let i = 0; i < pageRefs.current.length; i++) {
      const el = pageRefs.current[i];
      if (!el) continue;
      const dist = Math.abs(el.offsetTop + el.offsetHeight / 2 - viewportMid);
      if (dist < closestDist) {
        closestDist = dist;
        closestPage = i + 1;
      }
    }
    setCurrentPage(closestPage);
    storeSetCurrentPage(closestPage);

    // Close popups when the user scrolls so they don't drift off-position.
    setPicker(null);
    setHlPopup(null);
    setHlPicker(null);
  }, [storeSetCurrentPage, numPages]);

  const scrollToPage = useCallback((n: number) => {
    const el = pageRefs.current[n - 1];
    if (el && containerRef.current) {
      containerRef.current.scrollTo({ top: el.offsetTop - 16, behavior: "smooth" });
    }
  }, []);

  // Register scrollToPage in the store so the notes panel citation chip can call it.
  useEffect(() => {
    setJumpToPage(scrollToPage);
    return () => setJumpToPage(null);
  }, [scrollToPage, setJumpToPage]);

  // Consume a pending cross-PDF page jump queued by SearchModal.
  // Delay gives the async render loop time to lay out page divs.
  useEffect(() => {
    if (numPages > 0 && pendingJumpPage) {
      const timer = setTimeout(() => {
        scrollToPage(pendingJumpPage);
        setPendingJumpPage(null);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [numPages, pendingJumpPage, scrollToPage, setPendingJumpPage]);

  const fitToWidth = useCallback(async () => {
    const doc = pdfDocRef.current;
    if (!doc || !containerRef.current) return;
    const pg = await doc.getPage(1);
    const naturalWidth = pg.getViewport({ scale: 1.0 }).width;
    const availableWidth = containerRef.current.clientWidth - 48;
    setScale(Math.max(0.5, Math.min(3.0, availableWidth / naturalWidth)));
  }, []);

  const handleNewNote = useCallback(async () => {
    try {
      const json = await invoke<string>("create_note", {
        title: "Untitled",
        sourcePdfId: pdfId,
        sourcePage: currentPage,
      });
      const note = JSON.parse(json) as Note;
      addNote(note);
      setSelectedNoteId(note.id);
    } catch (err) {
      console.error("create_note failed:", err);
    }
  }, [pdfId, currentPage, addNote, setSelectedNoteId]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="viewer-status">
        <div className="spinner" />
        <p>Loading PDF…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="viewer-status">
        <p className="viewer-error-title">Could not load PDF</p>
        <p className="viewer-error-detail">{error}</p>
      </div>
    );
  }

  return (
    <>
      <div className="pdf-viewer">
        {/* ── Panel toggle buttons ── */}
        <button
          className="panel-toggle panel-toggle--left"
          title={leftPanelOpen ? "Collapse library" : "Expand library"}
          onClick={() => setLeftPanelOpen(!leftPanelOpen)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {leftPanelOpen
              ? <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></>
              : <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><polyline points="15 9 9 12 15 15"/></>
            }
          </svg>
        </button>
        <button
          className="panel-toggle panel-toggle--right"
          title={rightPanelOpen ? "Collapse notes" : "Expand notes"}
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {rightPanelOpen
              ? <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></>
              : <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/><polyline points="9 9 15 12 9 15"/></>
            }
          </svg>
        </button>

        {/* ── Floating lens pill ── */}
        <div className="lens-float">
          <LensSwitcher
            activeLens={activeLens}
            onSelect={setActiveLens}
          />
        </div>

        {/* ── Floating "✦ Summarize Lens" canvas widget ── */}
        {activeLens !== 'default' && (
          <button
            className="lens-summarize-float"
            title="Summarize all highlights in this lens"
            onClick={handleSummarizeByColor}
          >
            <span className="lens-summarize-glyph">✦</span>
            Summarize Lens
          </button>
        )}

        {/* ── Floating "Generate Flashcards" widget (Flashcards lens only) ── */}
        {activeLens === 'flashcards' && (
          <button
            className="lens-generate-flashcards-float"
            title="Generate flashcards from green highlights"
            onClick={handleGenerateFlashcards}
            disabled={isGeneratingFlashcards}
          >
            {isGeneratingFlashcards
              ? `Generating ${generationProgress?.done ?? 0}/${generationProgress?.total ?? 0}…`
              : <>🎴 Generate Flashcards</>}
          </button>
        )}

        {/* ── Lens action toast ── */}
        {toast && <div className="lens-toast">{toast}</div>}

        {/* ── Flashcard generation completion toast ── */}
        {flashGenResult && (
          <div className="flash-gen-toast">
            <span>{flashGenResult.count} flashcard{flashGenResult.count === 1 ? '' : 's'} created</span>
            <button
              className="flash-gen-toast-btn"
              onClick={() => {
                startReview([...flashcards].sort((a, b) => a.page - b.page));
                setFlashGenResult(null);
              }}
            >
              Review now
            </button>
          </div>
        )}

        {/* ── PDF canvas ── */}
        <div
          className={`pdf-pages${drawMode ? " draw-mode-active" : ""}${drawMode && activeDrawTool === 'textbox' && placingTextBox ? " textbox-place-mode" : ""}`}
          ref={containerRef}
          onScroll={handleScroll}
          onMouseUp={drawMode ? undefined : handleMouseUp}
          onClick={drawMode ? undefined : handlePagesClick}
          onMouseDown={drawMode ? handleDrawStart : undefined}
        >
          {Array.from({ length: numPages }, (_, i) => (
            <div
              key={i}
              className="pdf-page-wrap"
              ref={(el) => { pageRefs.current[i] = el; }}
            >
              <canvas className="page-canvas" />
              <canvas
                className="hl-canvas"
                ref={(el) => { hlCanvasRefs.current[i] = el; }}
              />
              <canvas
                className="drawing-canvas"
                ref={(el) => { drawCanvasRefs.current[i] = el; }}
              />
              {/* viewportVersion in deps triggers re-render once async render populates viewportsRef */}
              {viewportVersion >= 0 && viewportsRef.current[i] && (
                <TextBoxLayer
                  pageNum={i + 1}
                  viewport={viewportsRef.current[i]!}
                  scale={scale}
                  textBoxes={textBoxes}
                />
              )}
              <div className="textLayer" />
            </div>
          ))}
        </div>

        {/* ── Annotation Dock (draw mode only) ── */}
        {drawMode && (
          <div className="annotation-dock-wrap">
            <AnnotationDock
              onUndo={handleDrawUndo}
              onDone={() => {
                setDrawMode(false);
                sessionUndoIds.current = [];
              }}
            />
          </div>
        )}

        {/* ── Floating zoom bar (bottom right) ── */}
        <div className="viewer-toolbar-float">
          <ViewerToolbar
            currentPage={currentPage}
            numPages={numPages}
            scale={scale}
            drawMode={drawMode}
            onZoomIn={() => setScale((s) => Math.min(3.0, parseFloat((s + 0.25).toFixed(2))))}
            onZoomOut={() => setScale((s) => Math.max(0.5, parseFloat((s - 0.25).toFixed(2))))}
            onFitToWidth={fitToWidth}
            onZoomSet={(s) => setScale(s)}
            onPageJump={scrollToPage}
            onNewNote={handleNewNote}
            onSummarizePage={handleSummarizePage}
            onToggleDrawMode={() => {
              setDrawMode(!drawMode);
              if (drawMode) sessionUndoIds.current = [];
              setSelectedDrawingId(null);
              setTrashPos(null);
            }}
            onExportPdf={() => setExportDialogOpen(true)}
          />
        </div>
      </div>

      {picker && (
        <ColorPickerPopup
          screenX={picker.screenX}
          screenY={picker.screenY}
          onColorSelect={handleColorSelect}
          onExplain={handleExplain}
          onDismiss={() => {
            window.getSelection()?.removeAllRanges();
            setPicker(null);
          }}
        />
      )}

      {explainPanel && (
        <ExplainPanel
          state={explainPanel}
          onClose={() => setExplainPanel(null)}
          onSaveToNotes={handleSaveExplainToNotes}
        />
      )}

      {hlPicker && (
        <HlPickerPopup
          screenX={hlPicker.screenX}
          screenY={hlPicker.screenY}
          hits={hlPicker.hits}
          onSelect={(h) => {
            setHlPopup({ screenX: hlPicker.screenX, screenY: hlPicker.screenY, highlight: h });
            setHlPicker(null);
          }}
          onDismiss={() => setHlPicker(null)}
        />
      )}

      {hlPopup && (
        <HighlightDetailPopup
          screenX={hlPopup.screenX}
          screenY={hlPopup.screenY}
          highlight={hlPopup.highlight}
          onDelete={async () => {
            try {
              await invoke("delete_highlight", { id: hlPopup.highlight.id });
              removeHighlight(hlPopup.highlight.id);
            } catch (err) {
              console.error("Failed to delete highlight:", err);
            }
            setHlPopup(null);
          }}
          onDismiss={() => setHlPopup(null)}
        />
      )}

      {trashPos && selectedDrawingId && (
        <button
          className="drawing-trash-btn"
          style={{ left: trashPos.x, top: trashPos.y }}
          title="Delete drawing (Delete)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => deleteSelectedDrawing()}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M9 6V4h6v2" />
          </svg>
        </button>
      )}
    </>
  );
}
