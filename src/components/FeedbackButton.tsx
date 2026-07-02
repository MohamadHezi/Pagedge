import { useStore } from "../store";

export function FeedbackButton() {
  const { setFeedbackModalOpen } = useStore();

  return (
    <button
      type="button"
      className="feedback-fab"
      title="Send feedback"
      onClick={() => setFeedbackModalOpen(true)}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}
