import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { gradeFlashcard } from "../services/flashcardService";
import { schedulePush } from "../services/syncService";
import type { ReviewQuality } from "../types";

export function ReviewMode() {
  const {
    reviewModeOpen,
    setReviewModeOpen,
    reviewQueue,
    currentReviewIndex,
    advanceReview,
    updateFlashcardLocal,
    flashcards,
    selectedPdfId,
    setPendingJumpPage,
    selectPdf,
    jumpToPage,
  } = useStore();

  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    setFlipped(false);
  }, [currentReviewIndex]);

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

  const handleGrade = useCallback(
    async (quality: ReviewQuality) => {
      if (!card) return;
      const result = gradeFlashcard(card, quality);
      updateFlashcardLocal(card.id, {
        interval: result.interval,
        ease_factor: result.easeFactor,
        repetitions: result.repetitions,
        next_review: result.nextReview,
      });
      try {
        await invoke("update_flashcard_review", {
          id: card.id,
          interval: result.interval,
          easeFactor: result.easeFactor,
          repetitions: result.repetitions,
          nextReview: result.nextReview,
        });
      } catch (err) {
        console.error("[review] failed to persist grade", err);
      }
      // updateFlashcardLocal only schedules a push if card.id exists in
      // state.flashcards, which is scoped to whichever PDF is currently
      // open — the global review queue (LibrarySidebar's "Flashcard
      // Documents" -> get_all_flashcards -> startReview) can grade cards
      // belonging to PDFs that aren't loaded into the store at all, so that
      // push would silently never fire. Schedule directly off the card
      // itself, which always carries the right pdf_id regardless of source.
      schedulePush(card.pdf_id);
      advanceReview();
    },
    [card, updateFlashcardLocal, advanceReview]
  );

  const handleSourceJump = useCallback(() => {
    if (!card) return;
    setReviewModeOpen(false);
    if (card.pdf_id !== selectedPdfId) {
      setPendingJumpPage(card.page);
      selectPdf(card.pdf_id);
    } else {
      jumpToPage?.(card.page);
    }
  }, [card, selectedPdfId, setPendingJumpPage, selectPdf, jumpToPage, setReviewModeOpen]);

  if (!reviewModeOpen) return null;

  if (!card) {
    const upcoming = flashcards.filter((f) => new Date(f.next_review).getTime() > Date.now()).length;
    return (
      <div className="review-overlay" onMouseDown={() => setReviewModeOpen(false)}>
        <div className="review-card-wrap" onMouseDown={(e) => e.stopPropagation()}>
          <p className="review-empty-title">All caught up</p>
          <p className="review-empty-detail">
            {upcoming > 0
              ? `${upcoming} more card${upcoming === 1 ? "" : "s"} scheduled for later`
              : "No flashcards yet — highlight text in green and generate some"}
          </p>
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
        <div className="review-progress">
          Card {currentReviewIndex + 1} of {reviewQueue.length}
        </div>
        <div
          className={`review-card${flipped ? " is-flipped" : ""}`}
          onClick={() => setFlipped((f) => !f)}
        >
          <div className="review-card-inner">
            <div className="review-card-face review-card-front">{card.front}</div>
            <div className="review-card-face review-card-back">{card.back}</div>
          </div>
        </div>
        <button className="review-source-link" onClick={handleSourceJump}>
          Jump to source · page {card.page}
        </button>
        {flipped && (
          <div className="review-grading-row">
            <button className="review-grade-btn review-grade-again" onClick={() => handleGrade("again")}>
              Again
            </button>
            <button className="review-grade-btn review-grade-hard" onClick={() => handleGrade("hard")}>
              Hard
            </button>
            <button className="review-grade-btn review-grade-good" onClick={() => handleGrade("good")}>
              Good
            </button>
            <button className="review-grade-btn review-grade-easy" onClick={() => handleGrade("easy")}>
              Easy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
