import { useState } from 'react';
import { MathMarkdown } from './MathMarkdown';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import type { Note } from '../types';

export function ComparePanel() {
  const store = useStore();
  const {
    compareContent,
    compareTargetPdfId,
    comparePdfId,
    isComparing,
    clearCompare,
    pdfs,
    setSelectedNoteId,
    setRightPanelOpen,
  } = store;

  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const isOpen = isComparing || compareContent !== null;
  if (!isOpen) return null;

  const pdfA = pdfs.find((p) => p.id === comparePdfId);
  const pdfB = pdfs.find((p) => p.id === compareTargetPdfId);
  const subtitle = pdfA && pdfB ? `${pdfA.filename} vs ${pdfB.filename}` : undefined;

  const handleCopy = async () => {
    if (!compareContent) return;
    await navigator.clipboard.writeText(compareContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveToNotes = async () => {
    if (!comparePdfId || !compareContent || saving) return;
    setSaving(true);
    try {
      const title = `Comparison — ${pdfA?.filename ?? 'Document A'} vs ${pdfB?.filename ?? 'Document B'}`;
      const raw = await invoke<string>('create_note', {
        title,
        sourcePdfId: comparePdfId,
        sourcePage: 1,
      });
      const created = JSON.parse(raw) as Note;
      const updated = JSON.parse(
        await invoke<string>('update_note', {
          id: created.id,
          title,
          contentMarkdown: compareContent,
        })
      ) as Note;
      // See SummaryPanel's identical comment: attribute to whichever pane
      // (if either) still has this pdf open.
      if (comparePdfId === store.selectedPdfId) {
        store.addNote(updated);
        setSelectedNoteId(updated.id);
        setRightPanelOpen(true);
      } else if (comparePdfId === store.paneB?.pdfId) {
        store.addNoteB(updated);
        store.setSelectedNoteIdB(updated.id);
        setRightPanelOpen(true);
      }
      clearCompare();
    } catch (err) {
      console.error('[compare] Save to notes failed:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="summary-overlay" onMouseDown={clearCompare}>
      <div className="summary-panel" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="summary-header">
          <div className="summary-title-block">
            <span className="summary-lens-dot" />
            <div>
              <span className="summary-title">Compare</span>
              {subtitle && <span className="summary-subtitle">{subtitle}</span>}
            </div>
          </div>
          <button className="icon-btn" title="Close" onClick={clearCompare}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="summary-body">
          {isComparing && !compareContent ? (
            <div className="summary-loading">
              <span className="pdf-status-spinner" />
              <span>Comparing documents…</span>
            </div>
          ) : (
            <div data-color-mode="dark" className="summary-markdown">
              <MathMarkdown source={compareContent ?? ''} />
            </div>
          )}
        </div>

        {/* Footer — only once we have content */}
        {compareContent && (
          <div className="summary-footer">
            <button className="summary-btn summary-btn--ghost" onClick={handleCopy}>
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
