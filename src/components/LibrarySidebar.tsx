import React, { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { ingestPdf } from "../services/ingestionService";
import { materializePendingAnnotations, dismissPendingAnnotations } from "../services/syncService";
import { OutlineSection } from "./OutlinePanel";
import type { Flashcard, Highlight, Pdf, Folder } from "../types";

type QuickView = "recent" | "quotes";
type LibraryNode = { kind: "folder"; folder: Folder } | { kind: "pdf"; pdf: Pdf };

const PDF_DRAG_MIME = "application/x-pagedge-pdf-id";
const FOLDER_DRAG_MIME = "application/x-pagedge-folder-id";

export function LibrarySidebar() {
  const {
    pdfs, selectedPdfId, selectPdf, leftPanelOpen,
    ingestionStatus, isModelLoading, addPdf, deletePdf, renamePdf,
    startReview, pendingImportPrompt, remoteOnlyPdfs,
    folders, createFolder, renameFolder, deleteFolder, moveFolderToParent, movePdfToFolder, setPdfPinned, setFolderPinned,
  } = useStore();

  const [isImporting, setIsImporting] = useState(false);

  // ── Quick Views (Recent / Citations & Quotes) ───────────────────────────────
  const [activeQuickView, setActiveQuickView] = useState<QuickView | null>(null);
  const [quotesPdfIds, setQuotesPdfIds] = useState<Set<string> | null>(null);
  const [quotesLoading, setQuotesLoading] = useState(false);

  const handleRecentClick = useCallback(() => {
    setActiveQuickView((v) => (v === "recent" ? null : "recent"));
  }, []);

  const handleQuotesClick = useCallback(async () => {
    setActiveQuickView((v) => (v === "quotes" ? null : "quotes"));
    if (quotesPdfIds !== null) return;
    setQuotesLoading(true);
    try {
      const json = await invoke<string>("get_highlights_by_color", { color: "pink" });
      const highlights: Highlight[] = JSON.parse(json);
      setQuotesPdfIds(new Set(highlights.map((h) => h.pdf_id)));
    } catch (err) {
      console.error("Failed to load citations & quotes:", err);
      setQuotesPdfIds(new Set());
    } finally {
      setQuotesLoading(false);
    }
  }, [quotesPdfIds]);

  // Quick views cut across folders, so they render as a flat filtered list
  // rather than the nested Library tree.
  const quickViewPdfs = useMemo(() => {
    if (activeQuickView === "recent") {
      return pdfs
        .filter((p) => !!p.last_opened)
        .sort((a, b) => new Date(b.last_opened!).getTime() - new Date(a.last_opened!).getTime());
    }
    if (activeQuickView === "quotes") {
      if (!quotesPdfIds) return [];
      return pdfs.filter((p) => quotesPdfIds.has(p.id));
    }
    return [];
  }, [pdfs, activeQuickView, quotesPdfIds]);

  const handleImportPending = async () => {
    if (!pendingImportPrompt || isImporting) return;
    setIsImporting(true);
    try {
      await materializePendingAnnotations(pendingImportPrompt.contentHash, pendingImportPrompt.pdfId);
    } catch (err) {
      console.error("Failed to import synced annotations:", err);
    } finally {
      setIsImporting(false);
    }
  };

  const handleDismissPending = () => {
    if (!pendingImportPrompt) return;
    dismissPendingAnnotations(pendingImportPrompt.contentHash).catch(console.error);
  };

  // ── PDF row interaction state ─────────────────────────────────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId]           = useState<string | null>(null);
  const [renameValue, setRenameValue]         = useState("");
  const skipBlurRef = useRef(false);
  const [draggingPdfId, setDraggingPdfId] = useState<string | null>(null);
  const [rootDragOver, setRootDragOver] = useState(false);

  // ── Collection (folder) interaction state ─────────────────────────────────
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState("");
  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null); // "root" or a folder id
  const [newFolderName, setNewFolderName] = useState("");
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null);

  // Folders and pdfs merged into one ordered list per parent — this is what
  // actually renders. Pinned items (whether a folder or a pdf) float to the
  // top of whichever list they're already in; among non-pinned items,
  // folders still come before pdfs.
  const nodesByParent = useMemo(() => {
    const map = new Map<string | null, LibraryNode[]>();
    for (const f of folders) {
      const key = f.parent_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ kind: "folder", folder: f });
    }
    for (const p of pdfs) {
      const key = p.folder_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ kind: "pdf", pdf: p });
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const aPinned = a.kind === "folder" ? a.folder.is_pinned : a.pdf.is_pinned;
        const bPinned = b.kind === "folder" ? b.folder.is_pinned : b.pdf.is_pinned;
        const pinDiff = Number(bPinned) - Number(aPinned);
        if (pinDiff !== 0) return pinDiff;
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        if (a.kind === "folder" && b.kind === "folder") return a.folder.order_index - b.folder.order_index;
        return 0;
      });
    }
    return map;
  }, [folders, pdfs]);

  const rootNodes = nodesByParent.get(null) ?? [];

  const isDescendantOf = useCallback((candidateId: string, ancestorId: string): boolean => {
    let current: string | null | undefined = candidateId;
    while (current) {
      if (current === ancestorId) return true;
      current = folders.find((f) => f.id === current)?.parent_id;
    }
    return false;
  }, [folders]);

  // ── Resize ────────────────────────────────────────────────────────────────
  const sidebarRef  = useRef<HTMLElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);

  const handleFlashcardDocumentsClick = useCallback(async () => {
    const json = await invoke<string>('get_all_flashcards');
    const all: Flashcard[] = JSON.parse(json);
    const now = Date.now();
    const due = all
      .filter((f) => new Date(f.next_review).getTime() <= now)
      .sort((a, b) => new Date(a.next_review).getTime() - new Date(b.next_review).getTime());
    startReview(due);
  }, [startReview]);

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
    if (!confirmDeleteId && !confirmDeleteFolderId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmDeleteId(null);
        setConfirmDeleteFolderId(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [confirmDeleteId, confirmDeleteFolderId]);

  // ── PDF handlers ─────────────────────────────────────────────────────────
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

  // ── Collection (folder) handlers ──────────────────────────────────────────
  const toggleExpand = (id: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const startRenameFolder = (e: React.MouseEvent, folder: Folder) => {
    e.stopPropagation();
    setConfirmDeleteFolderId(null);
    setRenamingFolderId(folder.id);
    setRenameFolderValue(folder.name);
  };

  const commitRenameFolder = async (id: string) => {
    const trimmed = renameFolderValue.trim();
    setRenamingFolderId(null);
    if (trimmed && trimmed !== folders.find((f) => f.id === id)?.name) {
      await renameFolder(id, trimmed);
    }
  };

  const handleDeleteFolder = async (id: string) => {
    setConfirmDeleteFolderId(null);
    await deleteFolder(id);
  };

  const startCreateRoot = () => {
    setCreatingFor("root");
    setNewFolderName("");
  };

  const startCreateSub = (e: React.MouseEvent, parentId: string) => {
    e.stopPropagation();
    setExpandedFolderIds((prev) => new Set(prev).add(parentId));
    setCreatingFor(parentId);
    setNewFolderName("");
  };

  const cancelCreateFolder = () => {
    setCreatingFor(null);
    setNewFolderName("");
  };

  const commitCreateFolder = async (parentKey: string) => {
    const trimmed = newFolderName.trim();
    const targetParentId = parentKey === "root" ? null : parentKey;
    setCreatingFor(null);
    setNewFolderName("");
    if (trimmed) await createFolder(trimmed, targetParentId);
  };

  const handleDropOnFolder = (folder: Folder, e: React.DragEvent) => {
    const pdfId = e.dataTransfer.getData(PDF_DRAG_MIME);
    if (pdfId) {
      movePdfToFolder(pdfId, folder.id);
      return;
    }
    const draggedFolderId = e.dataTransfer.getData(FOLDER_DRAG_MIME);
    if (!draggedFolderId || draggedFolderId === folder.id) return;
    const draggedFolder = folders.find((f) => f.id === draggedFolderId);
    if (!draggedFolder) return;
    // Dropping a folder onto itself or one of its own descendants would
    // create a cycle — refuse the move entirely.
    if (isDescendantOf(folder.id, draggedFolderId)) return;

    // Dropping directly onto a folder always nests it inside — including
    // when the two are already siblings — matching normal file-manager
    // behavior. (Sibling reordering isn't a separate gesture right now.)
    if (draggedFolder.parent_id !== folder.id) moveFolderToParent(draggedFolderId, folder.id);
  };

  const handleDropOnRoot = (e: React.DragEvent) => {
    const pdfId = e.dataTransfer.getData(PDF_DRAG_MIME);
    if (pdfId) { movePdfToFolder(pdfId, null); return; }
    const draggedFolderId = e.dataTransfer.getData(FOLDER_DRAG_MIME);
    if (!draggedFolderId) return;
    const draggedFolder = folders.find((f) => f.id === draggedFolderId);
    if (draggedFolder && draggedFolder.parent_id !== null) moveFolderToParent(draggedFolderId, null);
  };

  // ── Row renderers ─────────────────────────────────────────────────────────
  const renderPdfRow = (pdf: Pdf, depth: number) => {
    const status        = ingestionStatus[pdf.id];
    const isConfirming   = confirmDeleteId === pdf.id;
    const isRenaming     = renamingId === pdf.id;
    const isSelected     = selectedPdfId === pdf.id;

    return (
      <li
        key={pdf.id}
        className={[
          "pdf-item",
          isSelected && !isRenaming ? "pdf-item--selected" : "",
          isConfirming ? "pdf-item--confirming" : "",
          draggingPdfId === pdf.id ? "pdf-item--dragging" : "",
        ].filter(Boolean).join(" ")}
        style={depth > 0 ? { paddingLeft: `${28 + depth * 14}px` } : undefined}
        onClick={() => {
          if (isConfirming || isRenaming) return;
          selectPdf(pdf.id);
        }}
        title={isRenaming || isConfirming ? undefined : pdf.filepath}
        draggable={!isRenaming && !isConfirming}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData(PDF_DRAG_MIME, pdf.id);
          e.dataTransfer.effectAllowed = "move";
          setDraggingPdfId(pdf.id);
        }}
        onDragEnd={() => setDraggingPdfId(null)}
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

        {/* Pin toggle — always visible when pinned, hover-revealed otherwise */}
        {!isRenaming && !isConfirming && (
          <button
            className={`pdf-pin-btn${pdf.is_pinned ? " pdf-pin-btn--active" : ""}`}
            title={pdf.is_pinned ? "Unpin" : "Pin"}
            onClick={(e) => { e.stopPropagation(); setPdfPinned(pdf.id, !pdf.is_pinned); }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M12 2a1 1 0 0 1 1 1v6.5l3.4 4.25a1 1 0 0 1 .1 1.1.94.94 0 0 1-.9.65H13v5.5a1 1 0 1 1-2 0V15.5H7.4a.94.94 0 0 1-.9-.65 1 1 0 0 1 .1-1.1L10 9.5V3a1 1 0 0 1 1-1z" />
            </svg>
          </button>
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
  };

  const renderFolderNode = (folder: Folder, depth: number): React.ReactNode => {
    const childNodes  = nodesByParent.get(folder.id) ?? [];
    const hasContents = childNodes.length > 0;
    const expanded      = expandedFolderIds.has(folder.id);
    const isRenaming    = renamingFolderId === folder.id;
    const isConfirming  = confirmDeleteFolderId === folder.id;
    const isDragOver    = dragOverFolderId === folder.id;

    return (
      <Fragment key={folder.id}>
        <li
          className={[
            "pdf-item",
            "collection-row",
            isDragOver ? "collection-row--dragover" : "",
            draggingFolderId === folder.id ? "collection-row--dragging" : "",
          ].filter(Boolean).join(" ")}
          style={{ paddingLeft: `${28 + depth * 14}px` }}
          draggable={!isRenaming && !isConfirming}
          onClick={() => { if (!isRenaming && !isConfirming) toggleExpand(folder.id); }}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData(FOLDER_DRAG_MIME, folder.id);
            e.dataTransfer.effectAllowed = "move";
            setDraggingFolderId(folder.id);
          }}
          onDragEnd={() => setDraggingFolderId(null)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(PDF_DRAG_MIME) && !e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) return;
            e.preventDefault();
            e.stopPropagation();
            setDragOverFolderId(folder.id);
          }}
          onDragLeave={() => setDragOverFolderId(null)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverFolderId(null);
            handleDropOnFolder(folder, e);
          }}
        >
          {hasContents ? (
            <span
              className={`outline-chevron${expanded ? " outline-chevron--expanded" : ""}`}
              onClick={(e) => { e.stopPropagation(); toggleExpand(folder.id); }}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </span>
          ) : (
            <span className="outline-chevron outline-chevron--spacer" />
          )}

          <svg className="pdf-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>

          {isRenaming ? (
            <input
              className="pdf-rename-input"
              autoFocus
              value={renameFolderValue}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setRenameFolderValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRenameFolder(folder.id); }
                if (e.key === "Escape") commitRenameFolder(folder.id);
              }}
              onBlur={() => commitRenameFolder(folder.id)}
            />
          ) : (
            <span className="collection-name" onDoubleClick={(e) => startRenameFolder(e, folder)} title={folder.name}>
              {folder.name}
            </span>
          )}

          {!isRenaming && !isConfirming && (
            <button
              className={`pdf-pin-btn${folder.is_pinned ? " pdf-pin-btn--active" : ""}`}
              title={folder.is_pinned ? "Unpin" : "Pin"}
              onClick={(e) => { e.stopPropagation(); setFolderPinned(folder.id, !folder.is_pinned); }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M12 2a1 1 0 0 1 1 1v6.5l3.4 4.25a1 1 0 0 1 .1 1.1.94.94 0 0 1-.9.65H13v5.5a1 1 0 1 1-2 0V15.5H7.4a.94.94 0 0 1-.9-.65 1 1 0 0 1 .1-1.1L10 9.5V3a1 1 0 0 1 1-1z" />
              </svg>
            </button>
          )}

          {!isRenaming && (
            isConfirming ? (
              <span className="pdf-confirm-actions">
                <button className="pdf-confirm-cancel" onClick={(e) => { e.stopPropagation(); setConfirmDeleteFolderId(null); }}>Cancel</button>
                <button className="pdf-confirm-delete" onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder.id); }}>Delete</button>
              </span>
            ) : (
              <span className="collection-actions">
                <button
                  className="collection-action-btn"
                  title="New sub-collection"
                  onClick={(e) => startCreateSub(e, folder.id)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  className="collection-action-btn collection-action-btn--danger"
                  title="Delete collection"
                  onClick={(e) => { e.stopPropagation(); setConfirmDeleteFolderId(folder.id); }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              </span>
            )
          )}
        </li>

        {creatingFor === folder.id && (
          <li className="collection-new-input-wrap" style={{ paddingLeft: `${28 + (depth + 1) * 14}px` }}>
            <input
              className="collection-new-input"
              autoFocus
              value={newFolderName}
              placeholder="Collection name"
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreateFolder(folder.id);
                if (e.key === "Escape") cancelCreateFolder();
              }}
              onBlur={() => commitCreateFolder(folder.id)}
            />
          </li>
        )}

        {expanded && childNodes.map((n) => (n.kind === "folder" ? renderFolderNode(n.folder, depth + 1) : renderPdfRow(n.pdf, depth + 1)))}
      </Fragment>
    );
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

      {/* Cross-device sync: annotations available for a just-added PDF */}
      {pendingImportPrompt && (
        <div className="sync-import-banner">
          <svg className="sync-import-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 16.2A4.5 4.5 0 0 0 17.5 8h-1.8A7 7 0 1 0 4 14.9" />
            <polyline points="12 12 12 21" />
            <polyline points="9 18 12 21 15 18" />
          </svg>
          <div className="sync-import-copy">
            <span className="sync-import-title">Annotations available from another device</span>
            <span className="sync-import-detail">
              {[
                pendingImportPrompt.highlightCount ? `${pendingImportPrompt.highlightCount} highlight${pendingImportPrompt.highlightCount === 1 ? "" : "s"}` : null,
                pendingImportPrompt.noteCount ? `${pendingImportPrompt.noteCount} note${pendingImportPrompt.noteCount === 1 ? "" : "s"}` : null,
                pendingImportPrompt.flashcardCount ? `${pendingImportPrompt.flashcardCount} flashcard${pendingImportPrompt.flashcardCount === 1 ? "" : "s"}` : null,
              ].filter(Boolean).join(", ")} for {pendingImportPrompt.displayName}
            </span>
          </div>
          <div className="sync-import-actions">
            <button className="sync-import-dismiss" onClick={handleDismissPending} disabled={isImporting}>Dismiss</button>
            <button className="sync-import-btn" onClick={handleImportPending} disabled={isImporting}>
              {isImporting ? "Importing…" : "Import"}
            </button>
          </div>
        </div>
      )}

      {/* ── Scrollable section tree ── */}
      <div className="nav-scroll">

        {/* Section 0 — OUTLINE (only when a PDF is open) */}
        <OutlineSection />

        {/* Section 1 — LIBRARY (nested collections + documents, or a flat
            quick-view list when Recent/Citations & Quotes is active) */}
        <div className="nav-section">
          <div className="nav-section-header">
            <svg className="nav-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="nav-section-title">
              {activeQuickView === "recent" ? "Recent" : activeQuickView === "quotes" ? "Citations & Quotes" : "Library"}
            </span>
            {activeQuickView ? (
              <button
                className="nav-quickview-clear"
                title="Clear filter"
                onClick={() => setActiveQuickView(null)}
              >
                Clear
              </button>
            ) : (
              <button className="collection-add-root-btn" title="New collection" onClick={startCreateRoot}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
          </div>

          {activeQuickView ? (
            activeQuickView === "quotes" && quotesLoading ? (
              <p className="sidebar-empty">Loading…</p>
            ) : quickViewPdfs.length === 0 ? (
              <p className="sidebar-empty">
                {activeQuickView === "recent" ? "No documents opened yet" : "No pink (quote) highlights yet"}
              </p>
            ) : (
              <ul className="pdf-list">
                {quickViewPdfs.map((pdf) => renderPdfRow(pdf, 0))}
              </ul>
            )
          ) : rootNodes.length === 0 && creatingFor !== "root" ? (
            <p className="sidebar-empty">Drop a PDF to begin</p>
          ) : (
            <ul
              className={`pdf-list collection-root-drop${rootDragOver ? " collection-root-drop--dragover" : ""}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(PDF_DRAG_MIME) && !e.dataTransfer.types.includes(FOLDER_DRAG_MIME)) return;
                e.preventDefault();
                setRootDragOver(true);
              }}
              onDragLeave={() => setRootDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setRootDragOver(false);
                handleDropOnRoot(e);
              }}
            >
              {rootNodes.map((n) => (n.kind === "folder" ? renderFolderNode(n.folder, 0) : renderPdfRow(n.pdf, 0)))}
              {creatingFor === "root" && (
                <li className="collection-new-input-wrap" style={{ paddingLeft: "28px" }}>
                  <input
                    className="collection-new-input"
                    autoFocus
                    value={newFolderName}
                    placeholder="Collection name"
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitCreateFolder("root");
                      if (e.key === "Escape") cancelCreateFolder();
                    }}
                    onBlur={() => commitCreateFolder("root")}
                  />
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Section 2b — SYNCED ELSEWHERE — PDFs known to the account (per the
            /sync/manifest) but not present in this device's local library. */}
        {remoteOnlyPdfs.length > 0 && (
          <div className="nav-section">
            <div className="nav-section-header">
              <svg className="nav-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 16.2A4.5 4.5 0 0 0 17.5 8h-1.8A7 7 0 1 0 4 14.9" />
              </svg>
              <span className="nav-section-title">Synced Elsewhere</span>
            </div>
            <ul className="pdf-list">
              {remoteOnlyPdfs.map((rp) => {
                const total = rp.counts.highlights + rp.counts.notes + rp.counts.flashcards;
                return (
                  <li
                    key={rp.content_hash}
                    className="pdf-item pdf-item--remote"
                    title={`${rp.display_name ?? "Untitled PDF"} — synced from another device. Add this exact file locally to import it.`}
                  >
                    <svg className="pdf-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 16.2A4.5 4.5 0 0 0 17.5 8h-1.8A7 7 0 1 0 4 14.9" />
                    </svg>
                    <span className="pdf-name">{rp.display_name ?? "Untitled PDF"}</span>
                    <span className="pdf-remote-badge">{total}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Section 3 — QUICK VIEWS */}
        <div className="nav-section">
          <div className="nav-section-header">
            <svg className="nav-section-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="nav-section-title">Quick Views</span>
          </div>

          <button
            className={`nav-tree-item${activeQuickView === "recent" ? " nav-tree-item--active" : ""}`}
            title="Recently opened documents"
            onClick={handleRecentClick}
          >
            <svg className="nav-tree-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="nav-tree-item-label">Recent</span>
          </button>

          <button className="nav-tree-item" title="Documents with flashcard highlights" onClick={handleFlashcardDocumentsClick}>
            <svg className="nav-tree-item-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="6" width="20" height="14" rx="2" />
              <path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            </svg>
            <span className="nav-tree-item-label">Flashcard Documents</span>
          </button>

          <button
            className={`nav-tree-item${activeQuickView === "quotes" ? " nav-tree-item--active" : ""}`}
            title="Passages marked as quotes or citations"
            onClick={handleQuotesClick}
          >
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
