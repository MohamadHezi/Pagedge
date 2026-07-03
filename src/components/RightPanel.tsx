import React, { useState, useRef, useEffect, useCallback } from "react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { Note, ChatMessage, Highlight } from "../types";
import { HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_KEYS, type HighlightColorKey } from "../constants/highlights";
import { callAI } from "../services/aiService";

// ── Prompts ───────────────────────────────────────────────────────────────────
const CHAT_SYSTEM =
  'You are a reading assistant. Answer questions about the provided document. ' +
  'Cite page numbers when relevant (e.g. "page 3"). Be concise and direct.';

const TAG_SYSTEM =
  'You are a tagging assistant. Read the note and suggest 3-6 relevant tags. ' +
  "Tags should be short (1-3 words), lowercase, specific to the content's topic/domain — " +
  "not generic words like 'note' or 'important'. Respond ONLY with a comma-separated list " +
  'of tags, nothing else.';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function stripMarkdown(s: string): string {
  return (
    s
      .split("\n")
      .find((l) => l.trim())
      ?.replace(/^#{1,6}\s+/, "")
      .replace(/[*_`~[\]]/g, "")
      .trim() ?? ""
  );
}

const SHORT_LABEL: Record<HighlightColorKey, string> = {
  yellow: "Important",
  blue: "Confused",
  green: "Flashcard",
  pink: "Quote",
};

interface StoredChunk {
  chunk_index: number;
  page: number;
  content: string;
}

async function buildContext(
  pdfId: string,
  question: string,
): Promise<{ context: string; chunkCount: number }> {
  console.log('[chat] buildContext: fetching chunks for pdfId =', pdfId);
  const json = await invoke<string>('get_chunks_for_pdf', { pdfId });
  const chunks: StoredChunk[] = JSON.parse(json);
  console.log('[chat] buildContext: retrieved', chunks.length, 'chunks');

  if (chunks.length === 0) return { context: '', chunkCount: 0 };

  const qWords = new Set(
    question.toLowerCase().match(/\b\w{3,}\b/g) ?? []
  );

  const scored = chunks.map((c) => ({
    ...c,
    score: (c.content.toLowerCase().match(/\b\w{3,}\b/g) ?? [])
      .filter((w) => qWords.has(w)).length,
  }));

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 8).sort((a, b) => a.chunk_index - b.chunk_index);

  const context = top.map((c) => `[Page ${c.page}]\n${c.content}`).join('\n\n---\n\n');
  console.log('[chat] buildContext: context preview (first 200 chars):', context.slice(0, 200));
  return { context, chunkCount: chunks.length };
}

function extractPageRefs(text: string): number[] {
  const nums = new Set<number>();
  const re = /\b(?:page|p\.?)\s*(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > 0) nums.add(n);
  }
  return Array.from(nums).sort((a, b) => a - b);
}

// ── NoteCard ─────────────────────────────────────────────────────────────────

function NoteCard({ note, onClick }: { note: Note; onClick: () => void }) {
  const { jumpToPage } = useStore();
  const preview = stripMarkdown(note.content_markdown).slice(0, 80);

  return (
    <div className="note-card" role="button" tabIndex={0} onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}>
      <div className="note-card-header">
        <span className="note-card-title">{note.title.trim() || "Untitled"}</span>
        {note.source_page != null && (
          <button
            className="note-card-page-chip"
            title={`Jump to page ${note.source_page}`}
            onClick={(e) => { e.stopPropagation(); jumpToPage?.(note.source_page!); }}
          >
            → p.{note.source_page}
          </button>
        )}
      </div>
      {preview && <span className="note-card-preview">{preview}</span>}
      <span className="note-card-time">{relativeTime(note.updated_at)}</span>
    </div>
  );
}

// ── NoteEditor ────────────────────────────────────────────────────────────────

function NoteEditor({ note, onBack }: { note: Note; onBack: () => void }) {
  const {
    isAuthenticated,
    requireAuth,
    pdfs,
    jumpToPage,
    updateNote: storeUpdateNote,
    removeNote,
    setSelectedNoteId,
    suggestedTags,
    setSuggestedTags,
    clearSuggestedTags,
    isSuggestingTags,
    setIsSuggestingTags,
  } = useStore();

  const [localTitle, setLocalTitle] = useState(note.title);
  const [localContent, setLocalContent] = useState(note.content_markdown);
  const [localTags, setLocalTags] = useState<string[]>(note.tags);
  const [tagInput, setTagInput] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingRef = useRef<{ title?: string; content?: string }>({});

  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    setSaveState("idle");
    setLocalTitle(note.title);
    setLocalContent(note.content_markdown);
    setLocalTags(note.tags);
    setTagInput("");
    pendingRef.current = {};
    clearSuggestedTags();
  }, [note.id]);

  const flush = useCallback(
    async (noteId: string, pending: { title?: string; content?: string }) => {
      try {
        const json = await invoke<string>("update_note", {
          id: noteId,
          title: pending.title,
          contentMarkdown: pending.content,
        });
        const updated = JSON.parse(json) as Note;
        storeUpdateNote(noteId, {
          title: updated.title,
          content_markdown: updated.content_markdown,
          updated_at: updated.updated_at,
        });
        setSaveState("saved");
      } catch {
        setSaveState("idle");
      }
    },
    [storeUpdateNote]
  );

  const scheduleFlush = useCallback(
    (patch: { title?: string; content?: string }) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      setSaveState("saving");
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const snap = { ...pendingRef.current };
        pendingRef.current = {};
        flush(note.id, snap);
      }, 800);
    },
    [note.id, flush]
  );

  const saveTags = useCallback(
    async (newTags: string[]) => {
      setLocalTags(newTags);
      storeUpdateNote(note.id, { tags: newTags });
      try {
        await invoke<string>("update_note", { id: note.id, tags: newTags });
      } catch (err) {
        console.error("update_note (tags) failed:", err);
      }
    },
    [note.id, storeUpdateNote]
  );

  const addTag = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (!t || localTags.includes(t)) return;
    saveTags([...localTags, t]);
  };

  const removeTag = (tag: string) => {
    saveTags(localTags.filter((t) => t !== tag));
  };

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag(tagInput);
      setTagInput("");
    }
  };

  const handleSuggestTags = async () => {
    if (!isAuthenticated) return requireAuth('Sign in to suggest tags', () => handleSuggestTags());
    if (!localContent.trim() || isSuggestingTags) return;
    setIsSuggestingTags(true);
    try {
      const content = localContent.slice(0, 2000);
      const response = await callAI([
        { role: "system", content: TAG_SYSTEM },
        { role: "user", content },
      ]);
      const suggestions = Array.from(
        new Set(
          response
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t && !localTags.includes(t))
        )
      ).slice(0, 6);
      setSuggestedTags(suggestions);
    } catch (err) {
      console.error("tag suggestion failed:", err);
    } finally {
      setIsSuggestingTags(false);
    }
  };

  const applySuggestion = (tag: string) => {
    addTag(tag);
    setSuggestedTags(suggestedTags.filter((t) => t !== tag));
  };

  const addAllSuggestions = () => {
    saveTags(Array.from(new Set([...localTags, ...suggestedTags])));
    clearSuggestedTags();
  };

  const handleDelete = async () => {
    clearTimeout(saveTimerRef.current);
    try {
      await invoke("delete_note", { id: note.id });
      removeNote(note.id);
      setSelectedNoteId(null);
    } catch (err) {
      console.error("delete_note failed:", err);
    }
  };

  const sourcePdf = note.source_pdf_id
    ? (pdfs.find((p) => p.id === note.source_pdf_id) ?? null)
    : null;

  return (
    <div className="note-editor-wrap">
      <div className="note-editor-bar">
        <button className="icon-btn" title="Back to notes" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button className="icon-btn note-delete-btn" title="Delete note" onClick={handleDelete}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M9 6V4h6v2" />
          </svg>
        </button>
      </div>

      <div className="note-editor-scroll">
        <div className="note-editor-workspace">
          {sourcePdf && note.source_page != null && (
            <button
              className="note-citation-pill"
              title={`Jump to page ${note.source_page}`}
              onClick={() => jumpToPage?.(note.source_page!)}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="note-citation-pill-name">{sourcePdf.filename}</span>
              <span className="note-citation-pill-page">p.{note.source_page}</span>
            </button>
          )}

          <input
            className="note-title-input"
            value={localTitle}
            onChange={(e) => {
              setLocalTitle(e.target.value);
              scheduleFlush({ title: e.target.value });
            }}
            placeholder="Untitled"
            spellCheck
          />

          <div className="note-tags-row">
            {localTags.map((t) => (
              <span key={t} className="note-tag-pill">
                {t}
                <button
                  className="note-tag-remove"
                  title="Remove tag"
                  onClick={() => removeTag(t)}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="note-tag-input"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagInputKeyDown}
              placeholder="+ tag"
            />
            {localContent.trim() && (
              <button
                className="note-tag-suggest-btn"
                onClick={handleSuggestTags}
                disabled={isSuggestingTags}
                title="Suggest tags with AI"
              >
                {isSuggestingTags ? "Thinking…" : "✦ Suggest tags"}
              </button>
            )}
          </div>

          {suggestedTags.length > 0 && (
            <div className="note-tags-suggested-row">
              {suggestedTags.map((t) => (
                <button
                  key={t}
                  className="note-tag-pill note-tag-pill--suggested"
                  onClick={() => applySuggestion(t)}
                  title="Add this tag"
                >
                  + {t}
                </button>
              ))}
              <button className="note-tag-add-all" onClick={addAllSuggestions}>
                + Add all
              </button>
            </div>
          )}

          <div data-color-mode="dark">
            <MDEditor
              value={localContent}
              onChange={(val) => {
                setLocalContent(val ?? "");
                scheduleFlush({ content: val ?? "" });
              }}
              preview="edit"
              hideToolbar
              visibleDragbar={false}
              height={480}
            />
          </div>

          <div className="note-save-footer">
            {saveState === "saving" && "Saving…"}
            {saveState === "saved" && "Saved"}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Highlights tab ────────────────────────────────────────────────────────────

function HighlightsView() {
  const {
    highlights,
    highlightFilter,
    setHighlightFilter,
    jumpToPage,
    setFlashHighlightId,
  } = useStore();

  const sorted = [...highlights].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    // PDF y=0 is bottom; higher y = higher on page. Sort descending by y (top first).
    return b.position_y - a.position_y;
  });

  const filtered: Highlight[] = highlightFilter === 'all'
    ? sorted
    : sorted.filter((h) => h.color === highlightFilter);

  const useGrouping = filtered.length > 10;

  const handleClick = (h: Highlight) => {
    jumpToPage?.(h.page);
    setFlashHighlightId(h.id);
    // Switch to viewer context; keep right panel open
  };

  if (highlights.length === 0) {
    return (
      <>
        <div className="hl-filter-bar">
          <button
            className={`hl-filter-all${highlightFilter === 'all' ? ' hl-filter-all--active' : ''}`}
            onClick={() => setHighlightFilter('all')}
          >All</button>
          {HIGHLIGHT_COLOR_KEYS.map((key) => (
            <button
              key={key}
              className={`hl-filter-dot${highlightFilter === key ? ' hl-filter-dot--active' : ''}`}
              title={HIGHLIGHT_COLORS[key].label}
              style={{ background: HIGHLIGHT_COLORS[key].hex }}
              onClick={() => setHighlightFilter(highlightFilter === key ? 'all' : key)}
            />
          ))}
        </div>
        <p className="hl-list-empty">
          No highlights yet. Select text in the document to start highlighting.
        </p>
      </>
    );
  }

  // Group by page when more than 10 highlights
  const pageGroups: { page: number; items: Highlight[] }[] = [];
  if (useGrouping) {
    const map = new Map<number, Highlight[]>();
    for (const h of filtered) {
      if (!map.has(h.page)) map.set(h.page, []);
      map.get(h.page)!.push(h);
    }
    for (const [page, items] of map) pageGroups.push({ page, items });
    pageGroups.sort((a, b) => a.page - b.page);
  }

  return (
    <>
      <div className="hl-filter-bar">
        <button
          className={`hl-filter-all${highlightFilter === 'all' ? ' hl-filter-all--active' : ''}`}
          onClick={() => setHighlightFilter('all')}
        >All</button>
        {HIGHLIGHT_COLOR_KEYS.map((key) => (
          <button
            key={key}
            className={`hl-filter-dot${highlightFilter === key ? ' hl-filter-dot--active' : ''}`}
            title={HIGHLIGHT_COLORS[key].label}
            style={{ background: HIGHLIGHT_COLORS[key].hex }}
            onClick={() => setHighlightFilter(highlightFilter === key ? 'all' : key)}
          />
        ))}
        {filtered.length > 0 && (
          <span className="hl-filter-count">{filtered.length}</span>
        )}
      </div>

      <div className="hl-list">
        {filtered.length === 0 ? (
          <p className="hl-list-empty" style={{ padding: '16px 10px' }}>
            No highlights with that color.
          </p>
        ) : useGrouping ? (
          pageGroups.map(({ page, items }) => (
            <div key={page} className="hl-page-group">
              <div className="hl-page-header">Page {page}</div>
              {items.map((h) => (
                <HighlightItem key={h.id} highlight={h} onClick={() => handleClick(h)} />
              ))}
            </div>
          ))
        ) : (
          filtered.map((h) => (
            <HighlightItem key={h.id} highlight={h} onClick={() => handleClick(h)} />
          ))
        )}
      </div>
    </>
  );
}

function HighlightItem({ highlight: h, onClick }: { highlight: Highlight; onClick: () => void }) {
  const color = HIGHLIGHT_COLORS[h.color as HighlightColorKey];
  const text = h.selected_text.length > 100
    ? h.selected_text.slice(0, 100) + '…'
    : h.selected_text;

  return (
    <button className="hl-item" onClick={onClick}>
      <div className="hl-item-header">
        <span className="hl-swatch" style={{ background: color.hex }} />
        <span className="hl-label">{SHORT_LABEL[h.color as HighlightColorKey]}</span>
        <span className="hl-page-badge">p.{h.page}</span>
      </div>
      <span className="hl-text">"{text}"</span>
      <span className="hl-time">{relativeTime(h.created_at)}</span>
    </button>
  );
}

// ── Chat tab ──────────────────────────────────────────────────────────────────

function ChatView() {
  const {
    isAuthenticated,
    requireAuth,
    selectedPdfId,
    pdfs,
    chatMessages,
    addChatMessage,
    clearChat,
    jumpToPage,
  } = useStore();

  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noIndexWarning, setNoIndexWarning] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const currentPdf = pdfs.find((p) => p.id === selectedPdfId);
  const isIndexed = Boolean(currentPdf?.ingested_at);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, typing]);

  const handleSend = async () => {
    if (!isAuthenticated) return requireAuth('Sign in to chat with this PDF', () => handleSend());
    const text = input.trim();
    if (!text || !selectedPdfId || typing) return;

    setInput('');
    setError(null);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addChatMessage(userMsg);
    setTyping(true);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const { context, chunkCount } = await buildContext(selectedPdfId, text);

      if (chunkCount === 0) {
        console.warn('[chat] No chunks found for pdfId =', selectedPdfId,
          '— document may not have been indexed yet.');
        setNoIndexWarning(true);
      } else {
        setNoIndexWarning(false);
      }

      const userContent = context
        ? `Document context:\n\n${context}\n\nQuestion: ${text}`
        : text;

      const messages = [
        { role: 'system' as const, content: CHAT_SYSTEM },
        { role: 'user'   as const, content: userContent },
      ];
      console.log('[chat] sending to AI — chunkCount:', chunkCount,
        '| userContent preview:', userContent.slice(0, 300));

      const response = await callAI(messages, { signal: abortRef.current.signal });

      addChatMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTyping(false);
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <span className="rp-title">Chat</span>
        {chatMessages.length > 0 && (
          <button className="icon-btn" title="Clear chat" onClick={clearChat}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M9 6V4h6v2" />
            </svg>
          </button>
        )}
      </div>

      {!isIndexed && (
        <div className="chat-no-index-banner">
          This document hasn't been indexed yet — answers won't include document context.
        </div>
      )}
      {noIndexWarning && isIndexed && (
        <div className="chat-no-index-banner">
          No document chunks found in the database. Try re-importing the PDF.
        </div>
      )}

      <div className="chat-messages">
        {chatMessages.length === 0 && !typing && (
          <p className="chat-empty">Ask anything about this document.</p>
        )}
        {chatMessages.map((msg) => {
          const pages = msg.role === 'assistant' ? extractPageRefs(msg.content) : [];
          return (
            <div key={msg.id} className={`chat-message chat-message--${msg.role}`}>
              <div className="chat-bubble">{msg.content}</div>
              {pages.length > 0 && (
                <div className="chat-citations">
                  {pages.map((p) => (
                    <button
                      key={p}
                      className="chat-citation"
                      onClick={() => jumpToPage?.(p)}
                    >
                      p.{p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {typing && (
          <div className="chat-message chat-message--assistant">
            <div className="chat-bubble chat-typing">
              <span /><span /><span />
            </div>
          </div>
        )}
        {error && <p className="chat-error">{error}</p>}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          placeholder="Ask about this document…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          disabled={typing}
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || typing}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── RightPanel ────────────────────────────────────────────────────────────────

export function RightPanel() {
  const {
    selectedPdfId,
    notes,
    selectedNoteId,
    setSelectedNoteId,
    currentPage,
    addNote,
    rightPanelOpen,
    rightPanelTab,
    setRightPanelTab,
    activeTagFilter,
    setActiveTagFilter,
  } = useStore();

  // ── Resize (hooks before early return) ────────────────────────────────────
  const panelRef  = useRef<HTMLElement>(null);
  const [panelWidth, setPanelWidth] = useState(300);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = panelWidth;

    document.body.style.cursor     = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const w = Math.max(200, Math.min(520, startWidth - (ev.clientX - startX)));
      panelRef.current?.style.setProperty("--right-panel-width", `${w}px`);
    };

    const onUp = (ev: MouseEvent) => {
      const w = Math.max(200, Math.min(520, startWidth - (ev.clientX - startX)));
      setPanelWidth(w);
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [panelWidth]);

  if (!selectedPdfId) return null;

  const selectedNote = selectedNoteId
    ? (notes.find((n) => n.id === selectedNoteId) ?? null)
    : null;

  const allTags = Array.from(new Set(notes.flatMap((n) => n.tags))).sort();
  const visibleNotes = activeTagFilter
    ? notes.filter((n) => n.tags.includes(activeTagFilter))
    : notes;

  const handleNewNote = async () => {
    try {
      const json = await invoke<string>("create_note", {
        title: "Untitled",
        sourcePdfId: selectedPdfId,
        sourcePage: currentPage,
      });
      const note = JSON.parse(json) as Note;
      addNote(note);
      setSelectedNoteId(note.id);
      setRightPanelTab('notes');
    } catch (err) {
      console.error("create_note failed:", err);
    }
  };

  return (
    <aside
      ref={panelRef}
      className={`right-panel${rightPanelOpen ? "" : " panel-collapsed"}`}
      style={{ "--right-panel-width": `${panelWidth}px` } as React.CSSProperties}
    >
      <div className="panel-resize-handle" onMouseDown={handleResizeStart} />
      {selectedNote ? (
        <NoteEditor note={selectedNote} onBack={() => setSelectedNoteId(null)} />
      ) : (
        <>
          {/* Tab bar */}
          <div className="rp-tabs">
            <button
              className={`rp-tab${rightPanelTab === 'notes' ? ' rp-tab--active' : ''}`}
              onClick={() => setRightPanelTab('notes')}
            >
              Notes
            </button>
            <button
              className={`rp-tab${rightPanelTab === 'highlights' ? ' rp-tab--active' : ''}`}
              onClick={() => setRightPanelTab('highlights')}
            >
              Highlights
            </button>
            <button
              className={`rp-tab${rightPanelTab === 'chat' ? ' rp-tab--active' : ''}`}
              onClick={() => setRightPanelTab('chat')}
            >
              Chat
            </button>
            {rightPanelTab === 'notes' && (
              <button className="icon-btn rp-new-note" title="New note" onClick={handleNewNote}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
          </div>

          {rightPanelTab === 'notes' && (
            <>
              {allTags.length > 0 && (
                <div className="note-tag-filter-bar">
                  {allTags.map((t) => (
                    <button
                      key={t}
                      className={`note-tag-filter-chip${activeTagFilter === t ? ' note-tag-filter-chip--active' : ''}`}
                      onClick={() => setActiveTagFilter(activeTagFilter === t ? null : t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
              <div className="note-list">
                {notes.length === 0 ? (
                  <p className="note-empty">No notes yet. Hit + to create one linked to this page.</p>
                ) : visibleNotes.length === 0 ? (
                  <p className="note-empty">No notes with that tag.</p>
                ) : (
                  visibleNotes.map((n) => (
                    <NoteCard key={n.id} note={n} onClick={() => setSelectedNoteId(n.id)} />
                  ))
                )}
              </div>
            </>
          )}

          {rightPanelTab === 'highlights' && <HighlightsView />}

          {rightPanelTab === 'chat' && <ChatView />}
        </>
      )}
    </aside>
  );
}
