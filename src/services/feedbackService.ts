import { API_BASE_URL, loadSession } from './authService';

export interface FeedbackContext {
  currentPdfName: string | null;
  currentPage: number | null;
  appVersion: string;
}

export async function sendFeedback(message: string, context: FeedbackContext): Promise<void> {
  const session = await loadSession();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers.Authorization = `Bearer ${session.access_token}`;

  const res = await fetch(`${API_BASE_URL}/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, context: JSON.stringify(context) }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
}
