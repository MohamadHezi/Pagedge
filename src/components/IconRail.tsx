import { useStore } from '../store';

export function IconRail() {
  const {
    setSettingsPanelOpen, setSearchModalOpen, selectPdf, isAuthenticated, requireAuth,
    graphViewOpen, setGraphViewOpen, deckManagerOpen, setDeckManagerOpen,
    globalChatOpen, setGlobalChatOpen,
    leftPanelOpen, setLeftPanelOpen, setExportDialogOpen, setReviewModeOpen,
    setFeedbackModalOpen, closePaywall, clearSummary,
  } = useStore();

  const goHome = () => {
    selectPdf(null);
    setSettingsPanelOpen(false);
    setSearchModalOpen(false);
    setExportDialogOpen(false);
    setReviewModeOpen(false);
    setFeedbackModalOpen(false);
    setGlobalChatOpen(false);
    closePaywall();
    clearSummary();
  };

  return (
    <nav className="icon-rail">
      {/* Brand mark — global "go home and clear clutter" escape hatch */}
      <div className="ir-brand">
        <button className="ir-logo" title="Home" onClick={goHome}>P</button>
      </div>

      {/* Primary nav */}
      <div className="ir-nav">
        {/* 1. Library — toggles the library sidebar's visibility */}
        <button
          className={`ir-btn${leftPanelOpen ? " ir-btn--active" : ""}`}
          title={leftPanelOpen ? "Collapse Library" : "Expand Library"}
          onClick={() => setLeftPanelOpen(!leftPanelOpen)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </button>

        {/* 2. Semantic Search */}
        <button className="ir-btn" title="Semantic Search (Ctrl+K)" onClick={() => setSearchModalOpen(true)}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </button>

        {/* 3. Knowledge Graph */}
        <button
          className={`ir-btn${graphViewOpen ? " ir-btn--active" : ""}`}
          title="Knowledge Graph"
          onClick={() => setGraphViewOpen(!graphViewOpen)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        </button>

        {/* 4. Flashcard Decks */}
        <button
          className={`ir-btn${deckManagerOpen ? " ir-btn--active" : ""}`}
          title="Flashcard Decks"
          onClick={() => setDeckManagerOpen(!deckManagerOpen)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="20" height="14" rx="2" />
            <path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            <line x1="12" y1="11" x2="12" y2="15" />
            <line x1="10" y1="13" x2="14" y2="13" />
          </svg>
        </button>

        {/* 5. Global Chat — cross-library AI chat */}
        <button
          className={`ir-btn${globalChatOpen ? " ir-btn--active" : ""}`}
          title="Global Chat"
          onClick={() => setGlobalChatOpen(!globalChatOpen)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
            <path d="M5 3v4" />
            <path d="M19 17v4" />
            <path d="M3 5h4" />
            <path d="M17 19h4" />
          </svg>
        </button>
      </div>

      {/* Bottom cluster — Settings + User Profile */}
      <div className="ir-bottom">
        <button className="ir-btn" title="Settings" onClick={() => setSettingsPanelOpen(true)}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </button>
        <button
          className="ir-btn"
          title={isAuthenticated ? "Account" : "Sign In"}
          onClick={() => (isAuthenticated ? setSettingsPanelOpen(true) : requireAuth())}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
