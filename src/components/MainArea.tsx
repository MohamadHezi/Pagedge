import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useStore } from "../store";
import { PdfViewer } from "./PdfViewer";
import { GraphView } from "./GraphView";
import { DeckManager } from "./DeckManager";
import { GlobalChatView } from "./GlobalChatView";
import { TrashView } from "./TrashView";
import { NoteWorkspace } from "./NoteWorkspace";
import { SplitPanePickerModal } from "./SplitPanePickerModal";
import { ingestPdf } from "../services/ingestionService";

export function MainArea() {
  const {
    addPdf, selectedPdfId, pdfs, selectPdf, graphViewOpen, deckManagerOpen, globalChatOpen, trashViewOpen,
    noteWorkspaceOpen, leftPanelOpen, setLeftPanelOpen,
    paneB, focusedPane, focusPane, closePaneB, promoteBToA,
  } = useStore();
  const selectedPdf = pdfs.find((p) => p.id === selectedPdfId) ?? null;
  const paneBPdf = paneB ? pdfs.find((p) => p.id === paneB.pdfId) ?? null : null;
  const [isDragging, setIsDragging] = useState(false);
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);

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

  // Native OS file-drop, handled via Tauri's own drag-drop event rather than
  // the browser's DragEvent/dataTransfer — dataTransfer.files never carries a
  // real filesystem path in a webview, and window.dragDropEnabled must be
  // true (tauri.conf.json) for this event to fire at all. Listens webview-
  // wide, not scoped to this element, which is a superset of the old
  // per-element handlers (they were already on the whole <main>), so drops
  // work anywhere in the window including while a PDF is already open.
  useEffect(() => {
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "over" || payload.type === "enter") {
        setIsDragging(true);
      } else if (payload.type === "leave") {
        setIsDragging(false);
      } else if (payload.type === "drop") {
        setIsDragging(false);
        (async () => {
          for (const path of payload.paths) {
            if (path.toLowerCase().endsWith(".pdf")) {
              const pdf = await addPdf(path);
              if (!pdf.chunk_count) {
                ingestPdf(pdf.id, pdf.filepath).catch(console.error);
              }
            }
          }
        })();
      }
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()); };
  }, [addPdf]);

  // Sort by last_opened desc, fall back to ingested_at, show top 3.
  const recentPdfs = [...pdfs]
    .sort((a, b) => {
      const dateA = a.last_opened || a.ingested_at || "";
      const dateB = b.last_opened || b.ingested_at || "";
      return dateB.localeCompare(dateA);
    })
    .slice(0, 3);

  return (
    <main className="main-area">
      {/* ── Library sidebar toggle — always visible regardless of which view is active ── */}
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

      {/* ── Split-view tab bar — only once at least one PDF is open, and only
          for the PDF-viewing state (view-mode screens like GraphView replace
          the whole area and hide this, same as they replace PdfViewer today) ── */}
      {selectedPdf && !globalChatOpen && !deckManagerOpen && !trashViewOpen && !noteWorkspaceOpen && !graphViewOpen && (
        <div className="pdf-tab-bar">
          <button
            className={`pdf-tab${focusedPane === 'A' ? ' pdf-tab--focused' : ''}`}
            title={selectedPdf.filepath}
            onClick={() => focusPane('A')}
          >
            <span className="pdf-tab-name">{selectedPdf.filename}</span>
            <span
              className="pdf-tab-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                if (paneB) promoteBToA();
                else selectPdf(null);
              }}
            >
              ×
            </span>
          </button>
          {paneBPdf && (
            <button
              className={`pdf-tab${focusedPane === 'B' ? ' pdf-tab--focused' : ''}`}
              title={paneBPdf.filepath}
              onClick={() => focusPane('B')}
            >
              <span className="pdf-tab-name">{paneBPdf.filename}</span>
              <span
                className="pdf-tab-close"
                title="Close"
                onClick={(e) => { e.stopPropagation(); closePaneB(); }}
              >
                ×
              </span>
            </button>
          )}
          {!paneB && (
            <button
              className="pdf-tab-add"
              title="Open a second PDF side by side"
              onClick={() => setSplitPickerOpen(true)}
            >
              +
            </button>
          )}
        </div>
      )}

      {globalChatOpen ? (
        <GlobalChatView />
      ) : deckManagerOpen ? (
        <DeckManager />
      ) : trashViewOpen ? (
        <TrashView />
      ) : noteWorkspaceOpen ? (
        <NoteWorkspace />
      ) : graphViewOpen ? (
        <GraphView />
      ) : selectedPdf ? (
        paneBPdf ? (
          <div className="split-panes">
            <div
              className={`split-pane${focusedPane === 'A' ? ' split-pane--focused' : ''}`}
              onMouseDownCapture={() => focusPane('A')}
            >
              <PdfViewer key={selectedPdf.id} filePath={selectedPdf.filepath} pdfId={selectedPdf.id} paneId="A" />
            </div>
            <div className="split-divider" />
            <div
              className={`split-pane${focusedPane === 'B' ? ' split-pane--focused' : ''}`}
              onMouseDownCapture={() => focusPane('B')}
            >
              <PdfViewer key={paneBPdf.id} filePath={paneBPdf.filepath} pdfId={paneBPdf.id} paneId="B" />
            </div>
          </div>
        ) : (
          <PdfViewer key={selectedPdf.id} filePath={selectedPdf.filepath} pdfId={selectedPdf.id} paneId="A" />
        )
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

      <SplitPanePickerModal open={splitPickerOpen} onClose={() => setSplitPickerOpen(false)} />
    </main>
  );
}
