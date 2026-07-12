import { useEffect } from 'react';
import { useStore } from '../store';

interface Props {
  onSelect: (pdfId: string) => void;
}

export function ComparePickerModal({ onSelect }: Props) {
  const { comparePickerOpen, setComparePickerOpen, pdfs, selectedPdfId } = useStore();

  useEffect(() => {
    if (!comparePickerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setComparePickerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [comparePickerOpen, setComparePickerOpen]);

  if (!comparePickerOpen) return null;

  const candidates = pdfs.filter((p) => p.id !== selectedPdfId);

  return (
    <div className="search-overlay" onMouseDown={() => setComparePickerOpen(false)}>
      <div className="search-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="summary-header">
          <span className="summary-title">Compare with…</span>
          <button className="icon-btn" title="Close" onClick={() => setComparePickerOpen(false)}>
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
              {candidates.map((pdf) => {
                const notReady = !pdf.chunk_count;
                return (
                  <li
                    key={pdf.id}
                    className={`pdf-item${notReady ? ' pdf-item--disabled' : ''}`}
                    title={notReady ? 'Still processing — try again in a moment' : undefined}
                    onClick={() => {
                      if (notReady) return;
                      setComparePickerOpen(false);
                      onSelect(pdf.id);
                    }}
                  >
                    <svg className="pdf-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="pdf-name">{pdf.filename}</span>
                    {notReady && <span className="pdf-status-spinner" title="Processing…" />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
