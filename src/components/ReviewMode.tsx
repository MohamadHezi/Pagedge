import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { MathMarkdown } from "./MathMarkdown";
import { deckMastery, isLowConfidence } from "../services/flashcardService";
import { schedulePush } from "../services/syncService";
import type { Flashcard, ConfidenceLevel } from "../types";

export function ReviewMode() {
  const {
    reviewModeOpen,
    setReviewModeOpen,
    reviewDeck,
    reviewQueue,
    reviewFilter,
    setReviewFilter,
    currentReviewIndex,
    advanceReview,
    updateFlashcardLocal,
  } = useStore();

  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    setFlipped(false);
  }, [currentReviewIndex, reviewFilter]);

  useEffect(() => {
    if (!reviewModeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setReviewModeOpen(false);
      if (e.key === " ") {
        e.preventDefault();
        setFlipped((f) => !f);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewModeOpen, setReviewModeOpen]);

  const card = reviewQueue[currentReviewIndex];
  const mastery = deckMastery(reviewDeck);
  const lowCount = reviewDeck.filter(isLowConfidence).length;

  const handleGrade = useCallback(
    async (level: ConfidenceLevel) => {
      if (!card) return;
      try {
        const json = await invoke<string>("update_flashcard_review", {
          id: card.id,
          confidenceLevel: level,
        });
        // Read back the server-confirmed updated_at (same pattern as
        // RightPanel's flush()/saveTags()) rather than assuming this
        // grade's own timestamp — update_flashcard_review bumps updated_at
        // in SQLite on every call, and a stale Zustand copy would let a
        // pull landing before the debounced push completes silently
        // revert this grade via applyServerFlashcard's isNewer check.
        const updated = JSON.parse(json) as Flashcard;
        updateFlashcardLocal(card.id, {
          confidence_level: updated.confidence_level,
          last_reviewed_at: updated.last_reviewed_at,
          updated_at: updated.updated_at,
        });
        // updateFlashcardLocal only schedules a push if card.id exists in
        // state.flashcards, which is scoped to whichever PDF is currently
        // open — the global review queue (LibrarySidebar's "Flashcard
        // Documents" -> get_all_flashcards -> startReview) can grade cards
        // belonging to PDFs that aren't loaded into the store at all, so that
        // push would silently never fire. Schedule directly off the card
        // itself, which always carries the right pdf_id regardless of source.
        // Custom cards (no pdf_id) are local-only and never push.
        if (card.pdf_id) schedulePush(card.pdf_id);
      } catch (err) {
        console.error("[review] failed to persist confidence", err);
      }
      advanceReview();
    },
    [card, updateFlashcardLocal, advanceReview]
  );

  const handleSourceJump = useCallback(() => {
    // Custom cards have no source PDF/page to jump to.
    if (!card?.pdf_id || card.page == null) return;
    setReviewModeOpen(false);
    // ReviewMode is an overlay, not a MainArea-replacing view — PdfViewer(s)
    // stay mounted underneath, so a pane that already has this pdf open can
    // jump directly via its live scrollTo. Otherwise the jump targets the
    // focused pane, same rule as SearchModal/GraphView/DeckManager.
    const s = useStore.getState();
    const pdfId = card.pdf_id;
    const page = card.page;
    if (s.selectedPdfId === pdfId) {
      s.jumpToPage?.(page);
      s.focusPane('A');
    } else if (s.paneB?.pdfId === pdfId) {
      s.paneB.jumpToPage?.(page);
      s.focusPane('B');
    } else if (s.focusedPane === 'A') {
      s.setPendingJumpPage(page);
      s.selectPdf(pdfId);
    } else {
      s.setPendingJumpPageB(page);
      s.openPaneB(pdfId);
    }
  }, [card, setReviewModeOpen]);

  if (!reviewModeOpen) return null;

  const filterPills = reviewDeck.length > 0 && (
    <div className="review-filter-row">
      <button
        className={`review-filter-pill${reviewFilter === "all" ? " is-active" : ""}`}
        onClick={() => setReviewFilter("all")}
      >
        All cards ({reviewDeck.length})
      </button>
      <button
        className={`review-filter-pill${reviewFilter === "low" ? " is-active" : ""}`}
        onClick={() => setReviewFilter("low")}
      >
        Low confidence ({lowCount})
      </button>
    </div>
  );

  const masteryBar = reviewDeck.length > 0 && (
    <div className="review-mastery">
      <span className="review-mastery-label">
        {mastery.mastered}/{mastery.total} mastered · {mastery.percent}%
      </span>
      <div className="review-mastery-track">
        <div className="review-mastery-fill" style={{ width: `${mastery.percent}%` }} />
      </div>
    </div>
  );

  if (!card) {
    const sessionDone = reviewQueue.length > 0;
    return (
      <div className="review-overlay" onMouseDown={() => setReviewModeOpen(false)}>
        <div className="review-card-wrap" onMouseDown={(e) => e.stopPropagation()}>
          <p className="review-empty-title">{sessionDone ? "Session complete" : "Nothing to review"}</p>
          <p className="review-empty-detail">
            {reviewDeck.length === 0
              ? "No flashcards yet — highlight text in green and generate some"
              : reviewFilter === "low" && !sessionDone
                ? "No low-confidence cards left — nice work"
                : `${mastery.mastered} of ${mastery.total} cards mastered`}
          </p>
          {masteryBar}
          {filterPills}
          <button className="review-close-btn" onClick={() => setReviewModeOpen(false)}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="review-overlay" onMouseDown={() => setReviewModeOpen(false)}>
      <div className="review-card-wrap" onMouseDown={(e) => e.stopPropagation()}>
        <button className="review-close-x" onClick={() => setReviewModeOpen(false)} aria-label="Close review">
          ×
        </button>
        {filterPills}
        <div className="review-progress">
          Card {currentReviewIndex + 1} of {reviewQueue.length}
        </div>
        <div
          className={`review-card${flipped ? " is-flipped" : ""}`}
          onClick={() => setFlipped((f) => !f)}
        >
          <div className="review-card-inner">
            <div className="review-card-face review-card-front" data-color-mode="dark">
              <MathMarkdown source={card.front} className="review-card-md" breaks />
            </div>
            <div className="review-card-face review-card-back" data-color-mode="dark">
              <MathMarkdown source={card.back} className="review-card-md" breaks />
            </div>
          </div>
        </div>
        {card.pdf_id && card.page != null && (
          <button className="review-source-link" onClick={handleSourceJump}>
            Jump to source · page {card.page}
          </button>
        )}
        {flipped && (
          <div className="review-grading-row">
            <button className="review-grade-btn review-grade-low" onClick={() => handleGrade(1)}>
              Low Confidence
            </button>
            <button className="review-grade-btn review-grade-mid" onClick={() => handleGrade(2)}>
              Getting There
            </button>
            <button className="review-grade-btn review-grade-high" onClick={() => handleGrade(3)}>
              Mastered
            </button>
          </div>
        )}
        {masteryBar}
      </div>
    </div>
  );
}
