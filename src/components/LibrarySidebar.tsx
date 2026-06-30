import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { ingestPdf } from "../services/ingestionService";

export function LibrarySidebar() {
  const {
    pdfs, selectedPdfId, selectPdf, leftPanelOpen,
    ingestionStatus, isModelLoading, addPdf, deletePdf, renamePdf,
  } = useStore();

  // ── Local interaction state ───────────────────────────────────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId]           = useState<string | null>(null);
  const [renameValue, setRenameValue]         = useState("");
  const skipBlurRef = useRef(false);

  // ── Resize ────────────────────────────────────────────────────────────────
  const sidebarRef  = useRef<HTMLElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = sidebarWidth;

    document.body.style.cursor     = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const w = Math.max(160, Math.min(480, startWidth + ev.clientX - startX));
      sidebarRef.current?.style.setProperty("--sidebar-width", `${w}px`);
    };

    const onUp = (ev: MouseEvent) => {
      const w = Math.max(160, Math.min(480, startWidth + ev.clientX - startX));
      setSidebarWidth(w);
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  // Dismiss confirm state on Escape
  useEffect(() => {
    if (!confirmDeleteId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmDeleteId(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [confirmDeleteId]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleNewEntry = async () => {
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
  };

  const startRename = (e: React.MouseEvent, id: string, currentName: string) => {
    e.stopPropagation();
    skipBlurRef.current = false;
    setConfirmDeleteId(null);
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const commitRename = async (id: string) => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (trimmed && trimmed !== pdfs.find((p) => p.id === id)?.filename) {
      await renamePdf(id, trimmed);
    }
  };

  const handleDelete = async (id: string) => {
    setConfirmDeleteId(null);
    await deletePdf(id);
  };

  return (
    <aside
      ref={sidebarRef}
      className={`library-sidebar${leftPanelOpen ? "" : " sidebar-collapsed"}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />

      {/* Model warm-up banner */}
      {isModelLoading && (
        <div className="nav-model-banner">
          <span className="nav-model-spinner" />
          Downloading AI model…
        </div>
      )}

      {/* ── Scrollable 3-section tree ── */}
      <div className="nav-scroll">

        {/* Section 1 — PINNED */}
        <div className="nav-section">
          <div className="nav-section-header">
            <svg className="nav-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17H19V13L17 7H7L5 13V17Z" />
              <line x1="12" y1="7" x2="12" y2="3" />
            </svg>
            <span className="nav-section-title">Pinned</span>
          </div>
          <p className="sidebar-empty">No pinned documents</p>
        </div>

        {/* Section 2 — COLLECTIONS */}
        <div className="nav-section">
          <div className="nav-section-header">
            <svg className="nav-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="nav-section-title">Collections</span>
          </div>

          {pdfs.length === 0 ? (
            <p className="sidebar-empty">Drop a PDF to begin</p>
          ) : (
            <ul className="pdf-list">
              {pdfs.map((pdf) => {
                const status        = ingestionStatus[pdf.id];
                const isConfirming  = confirmDeleteId === pdf.id;
                const isRenaming    = renamingId === pdf.id;
                const isSelected    = selectedPdfId === pdf.id;

                return (
                  <li
                    key={pdf.id}
                    className={[
                      "pdf-item",
                      isSelected && !isRenaming ? "pdf-item--selected" : "",
                      isConfirming ? "pdf-item--confirming" : "",
                    ].filter(Boolean).join(" ")}
                    onClick={() => {
                      if (isConfirming || isRenaming) return;
                      selectPdf(pdf.id);
                    }}
                    title={isRenaming || isConfirming ? undefined : pdf.filepath}
                  >
                    {/* File icon */}
                    <svg className="pdf-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>

                    {/* Name — inline input when renaming */}
                    {isRenaming ? (
                      <input
                        className="pdf-rename-input"
                        autoFocus
                        value={renameValue}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            skipBlurRef.current = false;
                            commitRename(pdf.id);
                          }
                          if (e.key === "Escape") {
                            skipBlurRef.current = true;
                            setRenamingId(null);
                          }
                        }}
                        onBlur={() => commitRename(pdf.id)}
                      />
                    ) : (
                      <span
                        className="pdf-name"
                        onDoubleClick={(e) => startRename(e, pdf.id, pdf.filename)}
                      >
                        {pdf.filename}
                      </span>
                    )}

                    {/* Right slot — confirm actions OR status+delete toggle */}
                    {!isRenaming && (
                      isConfirming ? (
                        <span className="pdf-confirm-actions">
                          <button
                            className="pdf-confirm-cancel"
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                          >
                            Cancel
                          </button>
                          <button
                            className="pdf-confirm-delete"
                            onClick={(e) => { e.stopPropagation(); handleDelete(pdf.id); }}
                          >
                            Delete
                          </button>
                        </span>
                      ) : (
                        /* Grid-stacked slot: status at rest, trash on hover */
                        <span className="pdf-item-right">
                          <span className="pdf-status">
                            {status === "indexing" && (
                              <span className="pdf-status-spinner" title="Indexing…" />
                            )}
                            {status === "done" && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="pdf-status-done" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                            {(status === "error" || (!status && pdf.chunk_count === 0)) && (
                              <button
                                className="pdf-status-error"
                                title={status === "error" ? "Indexing failed — click to retry" : "No text extracted — click to re-index"}
                                onClick={(e) => { e.stopPropagation(); ingestPdf(pdf.id, pdf.filepath).catch(console.error); }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="12" y1="8" x2="12" y2="12" />
                                  <line x1="12" y1="16" x2="12.01" y2="16" />
                                </svg>
                              </button>
                            )}
                          </span>

                          {/* Trash — fades in on row hover via CSS */}
                          <button
                            className="pdf-delete-btn"
                            title="Remove from library"
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(pdf.id); }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                            </svg>
                          </button>
                        </span>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Section 3 — QUICK VIEWS */}
        <div className="nav-section">
          <div className="nav-section-header">
            <svg className="nav-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="nav-section-title">Quick Views</span>
          </div>

          <button className="nav-tree-item" title="Recently opened documents">
            <svg className="nav-tree-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="nav-tree-item-label">Recent</span>
          </button>

          <button className="nav-tree-item" title="Documents with flashcard highlights">
            <svg className="nav-tree-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="6" width="20" height="14" rx="2" />
              <path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            </svg>
            <span className="nav-tree-item-label">Flashcard Documents</span>
          </button>

          <button className="nav-tree-item" title="Passages marked as quotes or citations">
            <svg className="nav-tree-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
              <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
            </svg>
            <span className="nav-tree-item-label">Citations &amp; Quotes</span>
          </button>
        </div>

      </div>{/* end nav-scroll */}

      {/* ── Section 4: Bottom-docked actions ── */}
      <div className="nav-bottom-dock">
        <button className="nav-new-entry-btn" title="Import a new PDF" onClick={handleNewEntry}>
          <span className="nav-new-entry-icon">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </span>
          New Entry
        </button>
        <button className="nav-archive-row" title="Archive &amp; Trash">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
          Archive &amp; Trash
        </button>
      </div>

    </aside>
  );
}
