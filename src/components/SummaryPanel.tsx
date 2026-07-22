import { useState } from 'react';
import { MathMarkdown } from './MathMarkdown';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import { HIGHLIGHT_COLORS } from '../constants/highlights';
import type { HighlightColorKey } from '../constants/highlights';
import type { LensKey, Note } from '../types';

const LENS_TO_COLOR: Record<Exclude<LensKey, 'default'>, HighlightColorKey> = {
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

export function SummaryPanel() {
  const store = useStore();
  const {
    summaryContent,
    summaryLens,
    summaryPdfId,
    isSummarizing,
    clearSummary,
    pdfs,
    setSelectedNoteId,
    setRightPanelOpen,
  } = store;

  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const isOpen = isSummarizing || (summaryContent !== null && summaryLens !== null);
  if (!isOpen || !summaryLens || summaryLens === 'default') return null;

  const lens      = summaryLens as Exclude<LensKey, 'default'>;
  const colorKey  = LENS_TO_COLOR[lens];
  const color     = HIGHLIGHT_COLORS[colorKey];
  const lensLabel = LENS_LABEL[lens];
  const pdf       = pdfs.find((p) => p.id === summaryPdfId);

  const handleCopy = async () => {
    if (!summaryContent) return;
    await navigator.clipboard.writeText(summaryContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveToNotes = async () => {
    if (!summaryPdfId || !summaryContent || saving) return;
    setSaving(true);
    try {
      const title = `${lensLabel} Summary`;
      const raw = await invoke<string>('create_note', {
        title,
        sourcePdfId: summaryPdfId,
        sourcePage: 1,
      });
      const created = JSON.parse(raw) as Note;
      const updated = JSON.parse(
        await invoke<string>('update_note', {
          id: created.id,
          title,
          contentMarkdown: summaryContent,
        })
      ) as Note;
      // Attribute the saved note to whichever pane (if either) currently has
      // this pdf open — summaryPdfId may belong to the pane that generated
      // it even if the user has since switched panes/documents.
      if (summaryPdfId === store.selectedPdfId) {
        store.addNote(updated);
        setSelectedNoteId(updated.id);
        setRightPanelOpen(true);
      } else if (summaryPdfId === store.paneB?.pdfId) {
        store.addNoteB(updated);
        store.setSelectedNoteIdB(updated.id);
        setRightPanelOpen(true);
      }
      clearSummary();
    } catch (err) {
      console.error('[summary] Save to notes failed:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="summary-overlay"
      onMouseDown={clearSummary}
    >
      <div
        className="summary-panel"
        style={{ '--summary-accent': color.hex } as React.CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="summary-header">
          <div className="summary-title-block">
            <span className="summary-lens-dot" />
            <div>
              <span className="summary-title">{lensLabel} Summary</span>
              {pdf && <span className="summary-subtitle">{pdf.filename}</span>}
            </div>
          </div>
          <button className="icon-btn" title="Close" onClick={clearSummary}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="summary-body">
          {isSummarizing && !summaryContent ? (
            <div className="summary-loading">
              <span className="pdf-status-spinner" />
              <span>Summarizing…</span>
            </div>
          ) : (
            <div data-color-mode="dark" className="summary-markdown">
              <MathMarkdown source={summaryContent ?? ''} />
            </div>
          )}
        </div>

        {/* Footer — only once we have content */}
        {summaryContent && (
          <div className="summary-footer">
            <button
              className="summary-btn summary-btn--ghost"
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  Copy
                </>
              )}
            </button>
            <button
              className="summary-btn summary-btn--primary"
              onClick={handleSaveToNotes}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save to notes'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
