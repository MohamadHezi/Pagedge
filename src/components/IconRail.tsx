import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import type { Flashcard } from '../types';

export function IconRail() {
  const { setSettingsPanelOpen, setSearchModalOpen, selectPdf, selectedPdfId, isAuthenticated, requireAuth, startReview, graphViewOpen, setGraphViewOpen } = useStore();

  const handleFlashcardDecksClick = async () => {
    const json = await invoke<string>('get_all_flashcards');
    // Already ordered least-confident-first by get_all_flashcards; the whole
    // deck loads — filtering to low-confidence happens inside ReviewMode.
    const all: Flashcard[] = JSON.parse(json);
    startReview(all);
  };

  return (
    <nav className="icon-rail">
      {/* Brand mark */}
      <div className="ir-brand">
        <div className="ir-logo">P</div>
      </div>

      {/* Primary nav */}
      <div className="ir-nav">
        {/* 1. Library — click while reading to return to welcome dashboard */}
        <button
          className={`ir-btn${!selectedPdfId && !graphViewOpen ? " ir-btn--active" : ""}`}
          title={selectedPdfId ? "Back to Library" : "Library"}
          onClick={() => selectPdf(null)}
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
        <button className="ir-btn" title="Flashcard Decks" onClick={handleFlashcardDecksClick}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="20" height="14" rx="2" />
            <path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
            <line x1="12" y1="11" x2="12" y2="15" />
            <line x1="10" y1="13" x2="14" y2="13" />
          </svg>
        </button>

        {/* 5. AI Prompt Engine */}
        <button className="ir-btn" title="AI Prompt Engine">
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
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
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
