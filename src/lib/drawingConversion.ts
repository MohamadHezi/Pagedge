import type { PageViewport } from "pdfjs-dist";
import type { Drawing, SketchStroke } from "../types";
import { pdfPointToCanvasPixel, canvasPixelToPdfPoint } from "./coords";

// Converts a PDF-space Drawing into the canvas-pixel-space SketchStroke format
// used as the canonical shape for the drawing copy/paste clipboard.
export function drawingToSketchStroke(d: Drawing, vp: PageViewport, scale: number): SketchStroke {
  return {
    id: d.id,
    tool_type: d.tool_type === "textbox" ? "pen" : d.tool_type,
    color: d.color,
    stroke_width: d.stroke_width,
    points: d.points.map((p) => pdfPointToCanvasPixel(p, vp, scale)),
  };
}

// Converts a SketchStroke back into a PDF-space Drawing (sans id/created_at,
// which the backend assigns on insert) for pasting onto the current page.
export function sketchStrokeToDrawing(
  stroke: SketchStroke,
  pdfId: string,
  page: number,
  vp: PageViewport,
  scale: number,
): Omit<Drawing, "id" | "created_at"> {
  return {
    pdf_id: pdfId,
    page,
    tool_type: stroke.tool_type,
    color: stroke.color,
    stroke_width: stroke.stroke_width,
    points: stroke.points.map((p) => canvasPixelToPdfPoint(p, vp, scale)),
  };
}
