import { useState } from 'react';
import { MathMarkdown } from './MathMarkdown';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import type { Note } from '../types';

export function StudyGuidePanel() {
  const store = useStore();
  const {
    studyGuideContent,
    studyGuidePdfId,
    isGeneratingStudyGuide,
    clearStudyGuide,
    pdfs,
    setSelectedNoteId,
    setRightPanelOpen,
  } = store;

  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const isOpen = isGeneratingStudyGuide || studyGuideContent !== null;
  if (!isOpen) return null;

  const pdf = pdfs.find((p) => p.id === studyGuidePdfId);
  const title = pdf ? `Study Guide — ${pdf.filename}` : 'Study Guide';

  const handleCopy = async () => {
    if (!studyGuideContent) return;
    await navigator.clipboard.writeText(studyGuideContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveToNotes = async () => {
    if (!studyGuidePdfId || !studyGuideContent || saving) return;
    setSaving(true);
    try {
      const raw = await invoke<string>('create_note', {
        title,
        sourcePdfId: studyGuidePdfId,
        sourcePage: 1,
      });
      const created = JSON.parse(raw) as Note;
      const updated = JSON.parse(
        await invoke<string>('update_note', {
          id: created.id,
          title,
          contentMarkdown: studyGuideContent,
        })
      ) as Note;
      // See SummaryPanel's identical comment: attribute to whichever pane
      // (if either) still has this pdf open.
      if (studyGuidePdfId === store.selectedPdfId) {
        store.addNote(updated);
        setSelectedNoteId(updated.id);
        setRightPanelOpen(true);
      } else if (studyGuidePdfId === store.paneB?.pdfId) {
        store.addNoteB(updated);
        store.setSelectedNoteIdB(updated.id);
        setRightPanelOpen(true);
      }
      clearStudyGuide();
    } catch (err) {
      console.error('[study-guide] Save to notes failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDownload = async () => {
    if (!studyGuideContent) return;
    setDownloadError('');
    try {
      const stem = (pdf?.filename ?? 'study-guide').replace(/\.pdf$/i, '');
      await invoke<string>('save_text_file', {
        defaultFilename: `${stem}-study-guide.md`,
        content: studyGuideContent,
        filterLabel: 'Markdown Files',
        filterExt: 'md',
      });
      // Empty string return means the user cancelled the save dialog — not an error.
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    }
  };

  return (
    <div className="summary-overlay" onMouseDown={clearStudyGuide}>
      <div className="summary-panel" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="summary-header">
          <div className="summary-title-block">
            <span className="summary-lens-dot" />
            <div>
              <span className="summary-title">Study Guide</span>
              {pdf && <span className="summary-subtitle">{pdf.filename}</span>}
            </div>
          </div>
          <button className="icon-btn" title="Close" onClick={clearStudyGuide}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="summary-body">
          {isGeneratingStudyGuide && !studyGuideContent ? (
            <div className="summary-loading">
              <span className="pdf-status-spinner" />
              <span>Building your study guide…</span>
            </div>
          ) : (
            <div data-color-mode="dark" className="summary-markdown">
              <MathMarkdown source={studyGuideContent ?? ''} />
            </div>
          )}
        </div>

        {/* Footer — only once we have content */}
        {studyGuideContent && (
          <div className="summary-footer">
            {downloadError && <p className="settings-feedback settings-feedback--err">{downloadError}</p>}
            <button className="summary-btn summary-btn--ghost" onClick={handleDownload}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
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
