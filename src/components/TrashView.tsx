import { useEffect, useState } from 'react';
import { useStore } from '../store';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function TrashView() {
  const { trashedPdfs, loadTrashedPdfs, restorePdf, permanentlyDeletePdf, setTrashViewOpen } = useStore();

  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);

  useEffect(() => {
    loadTrashedPdfs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePurge = async (id: string) => {
    setConfirmPurgeId(null);
    await permanentlyDeletePdf(id);
  };

  return (
    <div className="trash-view">
      <header className="gcv-header">
        <div className="gcv-header-text">
          <h2 className="gcv-title">Trash</h2>
          <span className="gcv-meta">
            {trashedPdfs.length} document{trashedPdfs.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="gcv-header-actions">
          <button className="icon-btn" title="Close" onClick={() => setTrashViewOpen(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {trashedPdfs.length === 0 ? (
        <div className="dm-empty">
          <h3 className="dm-empty-title">Trash is empty</h3>
          <p className="dm-empty-hint">Documents you remove from your library appear here until you restore or permanently delete them.</p>
        </div>
      ) : (
        <ul className="pdf-list trash-list">
          {trashedPdfs.map((pdf) => {
            const isConfirming = confirmPurgeId === pdf.id;
            return (
              <li key={pdf.id} className={`pdf-item trash-item${isConfirming ? ' pdf-item--confirming' : ''}`}>
                <svg className="pdf-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="pdf-name">{pdf.filename}</span>
                <span className="trash-item-time">{pdf.deleted_at ? relativeTime(pdf.deleted_at) : ''}</span>

                {isConfirming ? (
                  <span className="pdf-confirm-actions">
                    <button className="pdf-confirm-cancel" onClick={() => setConfirmPurgeId(null)}>Cancel</button>
                    <button className="pdf-confirm-delete" onClick={() => handlePurge(pdf.id)}>Delete forever</button>
                  </span>
                ) : (
                  <span className="trash-item-actions">
                    <button className="trash-restore-btn" title="Restore" onClick={() => restorePdf(pdf.id)}>
                      Restore
                    </button>
                    <button className="pdf-delete-btn" title="Delete permanently" onClick={() => setConfirmPurgeId(pdf.id)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
