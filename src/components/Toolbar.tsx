export function Toolbar() {
  return (
    <header className="toolbar">
      <div className="toolbar-brand">
        <div className="toolbar-icon bg-indigo-500 w-5 h-5 rounded" />
        <span className="toolbar-title">Pagedge</span>
      </div>
      <div className="toolbar-actions">
        <button className="icon-btn" title="Search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </button>
        <button className="icon-btn" title="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
          </svg>
        </button>
      </div>
    </header>
  );
}
