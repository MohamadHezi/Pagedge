import { pipeline, env } from '@huggingface/transformers';

// ── Environment setup (must run before any pipeline call) ─────────────────────
env.allowLocalModels = false;
env.useBrowserCache = true;

// ── Pipeline singleton ─────────────────────────────────────────────────────────

type Pipeline = Awaited<ReturnType<typeof pipeline>>;
let pipe: Pipeline | null = null;

async function getOrLoadPipeline(): Promise<Pipeline> {
  if (pipe) return pipe;
  pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    progress_callback: (progress: Record<string, unknown>) => {
      self.postMessage({ type: 'model_progress', progress });
    },
  });
  return pipe;
}

// ── Message handler ────────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const { type, id, texts } = event.data as {
    type: string;
    id: number;
    texts: string[];
  };

  if (type === 'load') {
    try {
      await getOrLoadPipeline();
      self.postMessage({ type: 'model_ready' });
    } catch (err) {
      self.postMessage({ type: 'model_error', error: String(err) });
    }
    return;
  }

  if (type === 'embed') {
    try {
      const model = await getOrLoadPipeline();
      const embeddings: number[][] = [];
      for (const text of texts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const output = await (model as any)(text, { pooling: 'mean', normalize: true });
        embeddings.push(Array.from(output.data as Float32Array));
      }
      self.postMessage({ type: 'embed_result', id, embeddings });
    } catch (err) {
      self.postMessage({ type: 'embed_error', id, error: String(err) });
    }
  }
};
