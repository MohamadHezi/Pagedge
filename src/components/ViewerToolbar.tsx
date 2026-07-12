import { useState, useEffect, useRef } from "react";

const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300];

interface ViewerToolbarProps {
  currentPage: number;
  numPages: number;
  scale: number;
  drawMode: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToWidth: () => void;
  onZoomSet: (scale: number) => void;
  onPageJump: (page: number) => void;
  onNewNote: () => void;
  onSummarizePage: () => void;
  onToggleDrawMode: () => void;
  onExportPdf: () => void;
  onGenerateStudyGuide: () => void;
  onOpenComparePicker: () => void;
}

export function ViewerToolbar({
  currentPage,
  numPages,
  scale,
  drawMode,
  onZoomIn,
  onZoomOut,
  onFitToWidth,
  onZoomSet,
  onPageJump,
  onNewNote,
  onSummarizePage,
  onToggleDrawMode,
  onExportPdf,
  onGenerateStudyGuide,
  onOpenComparePicker,
}: ViewerToolbarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomInputVal, setZoomInputVal] = useState("");
  const [pageEditing, setPageEditing] = useState(false);
  const [pageInputVal, setPageInputVal] = useState(String(currentPage));
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const zoomRef = useRef<HTMLDivElement>(null);
  const aiMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pageEditing) setPageInputVal(String(currentPage));
  }, [currentPage, pageEditing]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (zoomRef.current && !zoomRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!aiMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) {
        setAiMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [aiMenuOpen]);

  const commitPage = () => {
    const n = parseInt(pageInputVal, 10);
    if (!isNaN(n) && n >= 1 && n <= numPages) {
      onPageJump(n);
    } else {
      setPageInputVal(String(currentPage));
    }
    setPageEditing(false);
  };

  const commitZoom = () => {
    const n = parseInt(zoomInputVal, 10);
    if (!isNaN(n) && n >= 10 && n <= 300) {
      onZoomSet(Math.max(0.5, Math.min(3.0, n / 100)));
    }
    setZoomEditing(false);
  };

  const currentPct = Math.round(scale * 100);

  return (
    <div className="viewer-toolbar">
      {/* ── Zoom group ── */}
      <div className="vt-group">
        <button
          className="icon-btn"
          title="Zoom out (−25%)"
          disabled={scale <= 0.5}
          onClick={onZoomOut}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        {/* Split button: typeable value + preset arrow */}
        <div className="zoom-control" ref={zoomRef}>
          {zoomEditing ? (
            <input
              className="zoom-input"
              autoFocus
              value={zoomInputVal}
              onChange={(e) => setZoomInputVal(e.target.value)}
              onBlur={commitZoom}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitZoom();
                if (e.key === "Escape") setZoomEditing(false);
              }}
            />
          ) : (
            <button
              className="zoom-value-btn"
              title="Click to enter zoom %"
              onClick={() => {
                setZoomInputVal(String(currentPct));
                setZoomEditing(true);
                setDropdownOpen(false);
              }}
            >
              {currentPct}%
            </button>
          )}

          <button
            className="zoom-arrow-btn"
            title="Zoom presets"
            onClick={() => {
              setDropdownOpen((o) => !o);
              setZoomEditing(false);
            }}
          >
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5"
              style={{ transform: dropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {dropdownOpen && (
            <div className="zoom-dropdown">
              <button
                className="zoom-dropdown-item"
                onClick={() => { onFitToWidth(); setDropdownOpen(false); }}
              >
                Fit to width
              </button>
              <div className="zoom-dropdown-sep" />
              {ZOOM_PRESETS.map((pct) => (
                <button
                  key={pct}
                  className={`zoom-dropdown-item${currentPct === pct ? " zoom-dropdown-item--active" : ""}`}
                  onClick={() => { onZoomSet(pct / 100); setDropdownOpen(false); }}
                >
                  {pct}%
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className="icon-btn"
          title="Zoom in (+25%)"
          disabled={scale >= 3.0}
          onClick={onZoomIn}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* ── AI actions ── */}
      <div className="vt-group vt-group--push">
        <button
          className={`icon-btn vt-draw-btn${drawMode ? " vt-draw-btn--active" : ""}`}
          title={drawMode ? "Exit draw mode (Esc)" : "Enter draw mode"}
          onClick={onToggleDrawMode}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
        <div className="vt-ai-menu" ref={aiMenuRef}>
          <button
            className={`icon-btn vt-ai-btn${aiMenuOpen ? " vt-ai-btn--active" : ""}`}
            title="AI tools"
            onClick={() => setAiMenuOpen((o) => !o)}
          >
            ✦
          </button>
          {aiMenuOpen && (
            <div className="zoom-dropdown vt-ai-dropdown">
              <button
                className="zoom-dropdown-item"
                onClick={() => { onSummarizePage(); setAiMenuOpen(false); }}
              >
                Summarize this page
              </button>
              <div className="zoom-dropdown-sep" />
              <button
                className="zoom-dropdown-item vt-ai-dropdown-item"
                onClick={() => { onGenerateStudyGuide(); setAiMenuOpen(false); }}
              >
                Generate study guide
                <span className="vt-ai-pro-tag">Pro</span>
              </button>
              <button
                className="zoom-dropdown-item vt-ai-dropdown-item"
                onClick={() => { onOpenComparePicker(); setAiMenuOpen(false); }}
              >
                Compare with document
                <span className="vt-ai-pro-tag">Pro</span>
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn" title="New note" onClick={onNewNote}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button className="icon-btn" title="Export annotated PDF" onClick={onExportPdf}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      {/* ── Page group ── */}
      <div className="vt-group">
        {pageEditing ? (
          <input
            className="page-jump-input"
            autoFocus
            value={pageInputVal}
            size={3}
            onChange={(e) => setPageInputVal(e.target.value)}
            onBlur={commitPage}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPage();
              if (e.key === "Escape") {
                setPageInputVal(String(currentPage));
                setPageEditing(false);
              }
            }}
          />
        ) : (
          <button
            className="page-jump-btn"
            title="Click to jump to page"
            onClick={() => {
              setPageInputVal(String(currentPage));
              setPageEditing(true);
            }}
          >
            {currentPage}
          </button>
        )}
        <span className="page-total">/ {numPages}</span>
      </div>
    </div>
  );
}
