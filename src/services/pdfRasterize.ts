import type { PDFDocumentProxy } from 'pdfjs-dist';

// Approximates 300 DPI for OCR input — PDF points are 1/72", so scale =
// 300/72. A named, tunable constant (not inlined) since this is a real
// speed/accuracy tradeoff that may need adjusting down if full-page canvases
// at this scale prove too slow/memory-heavy on large documents.
export const OCR_RASTER_SCALE = 300 / 72;

/**
 * Rasterizes one page of an already-open PDF.js document to ImageData,
 * suitable as OCR input. Reuses the caller's already-open PDFDocumentProxy
 * (same pattern as outlineService.ts's ensureOutline) rather than re-reading
 * the file. The canvas here is never attached to the DOM — page.render()
 * only needs a 2D rendering context, not a mounted element — so this is
 * independent of PdfViewer's live, DOM-coupled render loop.
 */
export async function rasterizePage(pdf: PDFDocumentProxy, pageNum: number): Promise<ImageData> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: OCR_RASTER_SCALE });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;

  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
