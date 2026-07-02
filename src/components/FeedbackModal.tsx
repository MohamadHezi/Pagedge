import { useEffect, useState } from "react";
import { useStore } from "../store";
import { sendFeedback } from "../services/feedbackService";

const MAX_LENGTH = 2000;
const COUNTER_THRESHOLD = 1800;
const APP_VERSION = "0.1.1";

type Status = "idle" | "submitting" | "success" | "error";

export function FeedbackModal() {
  const { feedbackModalOpen, setFeedbackModalOpen, selectedPdfId, pdfs, currentPage } = useStore();

  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    if (feedbackModalOpen) {
      setMessage("");
      setStatus("idle");
    }
  }, [feedbackModalOpen]);

  useEffect(() => {
    if (!feedbackModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFeedbackModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feedbackModalOpen, setFeedbackModalOpen]);

  if (!feedbackModalOpen) return null;

  const selectedPdf = pdfs.find((p) => p.id === selectedPdfId);
  const trimmed = message.trim();

  const handleSubmit = async () => {
    if (!trimmed || status === "submitting") return;
    setStatus("submitting");
    try {
      await sendFeedback(trimmed, {
        currentPdfName: selectedPdf?.filename || null,
        currentPage: selectedPdfId ? currentPage || null : null,
        appVersion: APP_VERSION,
      });
      setStatus("success");
      setTimeout(() => setFeedbackModalOpen(false), 2000);
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="feedback-overlay" onMouseDown={() => status !== "submitting" && setFeedbackModalOpen(false)}>
      <div className="feedback-modal" onMouseDown={(e) => e.stopPropagation()}>
        {status === "success" ? (
          <div className="feedback-success">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>Thanks — we read every message.</span>
          </div>
        ) : (
          <>
            <div className="feedback-header">
              <div className="feedback-title">Send feedback</div>
              <div className="feedback-subtitle">
                Tell us what's working, what's broken, or what you wish Pagedge could do.
              </div>
            </div>

            <textarea
              className="feedback-textarea"
              rows={4}
              maxLength={MAX_LENGTH}
              placeholder="What's on your mind?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={status === "submitting"}
              autoFocus
            />

            {message.length > COUNTER_THRESHOLD && (
              <div className="feedback-counter">{message.length} / {MAX_LENGTH}</div>
            )}

            {status === "error" && (
              <div className="feedback-error">Something went wrong. Try again.</div>
            )}

            <div className="feedback-footer">
              <button
                type="button"
                className="feedback-cancel-btn"
                onClick={() => setFeedbackModalOpen(false)}
                disabled={status === "submitting"}
              >
                Cancel
              </button>
              <button
                type="button"
                className="feedback-submit-btn"
                onClick={handleSubmit}
                disabled={!trimmed || status === "submitting"}
              >
                {status === "submitting" ? (
                  <>
                    <span className="export-spinner" />
                    Sending…
                  </>
                ) : status === "error" ? (
                  "Retry"
                ) : (
                  "Send feedback"
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
