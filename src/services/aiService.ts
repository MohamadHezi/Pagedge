import { useStore } from '../store';
import type { AiMessage } from '../types';
import { API_BASE_URL, loadSession, refreshSession } from './authService';

export type { AiMessage };

const FREE_TIER_MAX_CONTEXT_CHARS = 5000;

function totalChars(messages: AiMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

export async function callAI(
  messages: AiMessage[],
  options?: { signal?: AbortSignal }
): Promise<string> {
  const { aiUseCustomProvider } = useStore.getState();
  return aiUseCustomProvider ? callCustomProvider(messages, options) : callProxy(messages, options);
}

// Power-user path: talk directly to whatever OpenAI-compatible provider the
// user configured in Settings (Ollama, their own OpenAI key, etc). Bypasses
// the Pagedge backend proxy and its quota entirely.
async function callCustomProvider(
  messages: AiMessage[],
  options?: { signal?: AbortSignal }
): Promise<string> {
  const { aiBaseUrl, aiModel, aiApiKey } = useStore.getState();

  // Ollama requires any non-empty string; fall back to 'ollama' if key is blank
  const auth = aiApiKey.trim() || 'ollama';

  let response: Response;
  try {
    response = await fetch(`${aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth}`,
      },
      body: JSON.stringify({ model: aiModel, messages, stream: false }),
      signal: options?.signal,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`AI provider unreachable (${aiBaseUrl}): ${detail}`);
  }

  if (!response.ok) {
    let detail = response.statusText;
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(`AI provider error ${response.status}: ${detail}`);
  }

  return extractContent(await response.json());
}

// Default path: route through the Pagedge backend, which enforces free-tier
// quota and calls Gemini server-side. The Gemini API key never reaches this
// client.
async function callProxy(
  messages: AiMessage[],
  options?: { signal?: AbortSignal }
): Promise<string> {
  const { user, showPaywall } = useStore.getState();

  if (!user) {
    // Shouldn't happen — App.tsx gates the whole app tree behind
    // isAuthenticated — but handle it gracefully by forcing the auth modal.
    useStore.getState().clearUser();
    throw new Error('Not authenticated');
  }

  const charCount = totalChars(messages);

  if (user.tier === 'free') {
    if (charCount > FREE_TIER_MAX_CONTEXT_CHARS) {
      showPaywall('context_too_large');
      throw new Error('context_too_large');
    }
    if (user.callsRemaining !== null && user.callsRemaining <= 0) {
      showPaywall('quota_exceeded');
      throw new Error('quota_exceeded');
    }
  }

  const session = await loadSession();
  if (!session) {
    useStore.getState().clearUser();
    throw new Error('Not authenticated');
  }

  const doFetch = (accessToken: string) =>
    fetch(`${API_BASE_URL}/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ messages, context_chars: charCount }),
      signal: options?.signal,
    });

  let response: Response;
  try {
    response = await doFetch(session.access_token);
    if (response.status === 401) {
      const refreshed = await refreshSession(session);
      response = await doFetch(refreshed.access_token);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`AI proxy unreachable: ${detail}`);
  }

  if (response.status === 429) {
    showPaywall('quota_exceeded');
    throw new Error('quota_exceeded');
  }

  if (response.status === 400) {
    const data = await response.json().catch(() => ({}));
    if (data?.error === 'context_too_large') showPaywall('context_too_large');
    throw new Error(data?.error || 'Request rejected by AI proxy');
  }

  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json())?.error || detail; } catch { /* ignore */ }
    throw new Error(`AI proxy error ${response.status}: ${detail}`);
  }

  const content = extractContent(await response.json());

  // Optimistically decrement the local quota display; the next /auth/me
  // refresh (app restart, sign-in) will reconcile against the server value.
  if (user.tier === 'free' && user.callsRemaining !== null) {
    useStore.setState({
      user: { ...user, callsRemaining: Math.max(0, user.callsRemaining - 1) },
    });
  }

  return content;
}

function extractContent(data: { choices?: Array<{ message?: { content?: string } }> }): string {
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI provider returned an empty response');
  return content;
}
