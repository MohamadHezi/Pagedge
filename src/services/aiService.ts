import { useStore } from '../store';
import type { AiMessage } from '../types';

export type { AiMessage };

export async function callAI(
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

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI provider returned an empty response');
  return content;
}
