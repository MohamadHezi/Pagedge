import type { PageViewport } from "pdfjs-dist";

// PDF point space (y=0 at bottom) <-> canvas CSS-pixel space (y=0 at top),
// scaled by the current zoom level. Mirrors the transform used throughout
// PdfViewer's highlight/shape rendering: canvasY = vp.height - pdfY * scale.
export function pdfPointToCanvasPixel(
  p: { x: number; y: number },
  vp: PageViewport,
  scale: number
): { x: number; y: number } {
  return { x: p.x * scale, y: vp.height - p.y * scale };
}

export function canvasPixelToPdfPoint(
  p: { x: number; y: number },
  vp: PageViewport,
  scale: number
): { x: number; y: number } {
  return { x: p.x / scale, y: (vp.height - p.y) / scale };
}
