import { useEffect } from 'react';
import { useStore } from '../store';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Lists every library PDF except whichever is already open in pane A or
// pane B, and opens the chosen one into pane B — the "+" button in
// MainArea's tab bar (only shown when pane B is empty) is the sole trigger.
// Mirrors ComparePickerModal's structure/markup for visual consistency.
export function SplitPanePickerModal({ open, onClose }: Props) {
  const { pdfs, selectedPdfId, paneB, openPaneB } = useStore();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const candidates = pdfs.filter((p) => p.id !== selectedPdfId && p.id !== paneB?.pdfId);

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div className="search-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="summary-header">
          <span className="summary-title">Open in split view…</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="search-results">
          {candidates.length === 0 ? (
            <p className="search-empty">No other documents in your library yet.</p>
          ) : (
            <ul className="pdf-list">
              {candidates.map((pdf) => (
                <li
                  key={pdf.id}
                  className="pdf-item"
                  onClick={() => {
                    openPaneB(pdf.id);
                    onClose();
                  }}
                >
                  <svg className="pdf-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="pdf-name">{pdf.filename}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
