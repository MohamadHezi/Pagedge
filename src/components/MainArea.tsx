import { useEffect, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { PdfViewer } from "./PdfViewer";
import { ingestPdf } from "../services/ingestionService";

export function MainArea() {
  const { addPdf, selectedPdfId, pdfs, selectPdf } = useStore();
  const selectedPdf = pdfs.find((p) => p.id === selectedPdfId) ?? null;
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    // HTML5 dragenter/dragleave do NOT fire for native OS file drags in
    // Tauri's WebView2 — only onDragDropEvent does. Drive isDragging from
    // the Tauri "enter" / "leave" payload types instead.
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
      if (cancelled) return;
      getCurrentWebviewWindow()
        .onDragDropEvent(async (event) => {
          if (event.payload.type === "enter") {
            setIsDragging(true);
          } else if (event.payload.type === "leave") {
            setIsDragging(false);
          } else if (event.payload.type === "drop") {
            setIsDragging(false);
            for (const path of event.payload.paths) {
              if (path.toLowerCase().endsWith(".pdf")) {
                const pdf = await addPdf(path);
                if (!pdf.chunk_count) {
                  ingestPdf(pdf.id, pdf.filepath).catch(console.error);
                }
              }
            }
          }
        })
        .then((fn) => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        });
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addPdf]);

  const handleOpenDialog = useCallback(async () => {
    try {
      const paths = await invoke<string[]>("open_file_dialog");
      for (const path of paths) {
        const pdf = await addPdf(path);
        if (!pdf.chunk_count) {
          ingestPdf(pdf.id, pdf.filepath).catch(console.error);
        }
      }
    } catch (err) {
      console.error("Error opening files:", err);
    }
  }, [addPdf]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  // Sort by last_opened desc, fall back to ingested_at, show top 3.
  const recentPdfs = [...pdfs]
    .sort((a, b) => {
      const dateA = a.last_opened || a.ingested_at || "";
      const dateB = b.last_opened || b.ingested_at || "";
      return dateB.localeCompare(dateA);
    })
    .slice(0, 3);

  return (
    <main className="main-area" onDragOver={handleDragOver}>
      {selectedPdf ? (
        <PdfViewer filePath={selectedPdf.filepath} pdfId={selectedPdf.id} />
      ) : (
        <div className="empty-state-wrap">

          {/* ── Drop card ── */}
          <div className={`drop-zone${isDragging ? " drop-zone--dragging" : ""}`}>
            <svg
              width="36" height="36" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="1.2"
              strokeLinecap="round" strokeLinejoin="round"
              className="drop-zone-icon"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="empty-state-headline">Drop a PDF to begin</p>
            <span className="empty-state-subtext">Drag a file here, or browse your computer</span>
            <button onClick={handleOpenDialog} className="open-btn">Browse Files</button>
          </div>

          {/* ── Recent Documents quick-links ── */}
          {recentPdfs.length > 0 && (
            <div className="recent-docs">
              <p className="recent-docs-label">Recent Documents</p>
              <div className="recent-docs-row">
                {recentPdfs.map((pdf) => (
                  <button
                    key={pdf.id}
                    className="recent-doc-tile"
                    title={pdf.filepath}
                    onClick={() => selectPdf(pdf.id)}
                  >
                    <svg
                      width="15" height="15" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="1.5"
                      strokeLinecap="round" strokeLinejoin="round"
                      className="recent-doc-icon"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="recent-doc-name">
                      {pdf.filename.replace(/\.pdf$/i, "")}
                    </span>
                    {pdf.page_count != null && (
                      <span className="recent-doc-meta">{pdf.page_count} pp</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

        </div>
      )}
    </main>
  );
}
