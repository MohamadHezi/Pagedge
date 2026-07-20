import { useStore } from '../store';
import type { AiMessage } from '../types';
import { API_BASE_URL, loadSession, refreshSession } from './authService';

export type { AiMessage };

// Mirrors FREE_TIER_MAX_CONTEXT_CHARS in pagedge-backend/app/api/ai/chat/route.ts.
// Sized to fit RightPanel.tsx's CHAT_CHUNK_LIMIT_FREE (4 chunks x ~2000 chars)
// plus system prompt/question overhead — was 5000, which blocked almost every
// Chat with PDF question before the chunk limit was made tier-aware.
const FREE_TIER_MAX_CONTEXT_CHARS = 9000;

// Mirrors FREE_TIER_LIMIT in pagedge-backend/lib/constants.ts — the backend
// is the enforcement point; this is only for quota display and pre-checks.
export const FREE_TIER_MONTHLY_CALLS = 15;

function totalChars(messages: AiMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

export async function callAI(
  messages: AiMessage[],
  options?: { signal?: AbortSignal }
): Promise<string> {
  // Custom providers bypass the backend's quota enforcement entirely, so
  // this is Pro-only — enforced here regardless of the stored setting, not
  // just at the Settings UI toggle, so a free user (or someone who set it up
  // before this restriction, or downgraded from Pro) can't route around the
  // monthly call limit just by leaving an old provider config saved.
  const { aiUseCustomProvider, user } = useStore.getState();
  const useCustom = aiUseCustomProvider && user?.tier === 'pro';
  return useCustom ? callCustomProvider(messages, options) : callProxy(messages, options);
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
    const data = await response.json().catch(() => ({}));
    // rate_limited is a burst guard (too many requests too fast), distinct from
    // quota_exceeded (out of monthly calls) — only the latter is fixed by
    // upgrading, so only the latter should show the paywall.
    if (data?.error === 'rate_limited') {
      throw new Error('Too many requests — please slow down and try again in a moment.');
    }
    showPaywall('quota_exceeded');
    throw new Error('quota_exceeded');
  }

  if (response.status === 403) {
    const data = await response.json().catch(() => ({}));
    if (data?.error === 'email_not_verified') {
      useStore.getState().showEmailVerifyToast();
      throw new Error('Please verify your email to use AI features.');
    }
    throw new Error(data?.error || 'Forbidden');
  }

  if (response.status === 400) {
    const data = await response.json().catch(() => ({}));
    // The backend's context-size guard (100k chars) applies to Pro too, as an
    // abuse ceiling rather than a tier limit — only free users should see this
    // as an upsell prompt. A Pro user hitting the abuse ceiling just gets the
    // thrown error as a normal message, not an "Upgrade to Pro" paywall.
    if (data?.error === 'context_too_large' && user.tier === 'free') showPaywall('context_too_large');
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
