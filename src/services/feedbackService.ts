import { API_BASE_URL, loadSession } from './authService';

export interface FeedbackContext {
  currentPdfName: string | null;
  currentPage: number | null;
  appVersion: string;
}

// Feedback requires an authenticated session — the app already gates all
// screens behind sign-in, so a missing session here means something is
// wrong with the auth store rather than a normal "not logged in" case.
export async function sendFeedback(message: string, context: FeedbackContext): Promise<void> {
  const session = await loadSession();
  if (!session) throw new Error('You must be signed in to send feedback.');

  const res = await fetch(`${API_BASE_URL}/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ message, context: JSON.stringify(context) }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
}
