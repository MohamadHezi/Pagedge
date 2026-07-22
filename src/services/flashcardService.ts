import { invoke } from '@tauri-apps/api/core';
import { callAI } from './aiService';
import { useStore } from '../store';
import type { Flashcard, Highlight } from '../types';

const FLASHCARD_SYSTEM =
  'You are a study-flashcard generator. Given a passage a student highlighted, ' +
  'produce exactly one flashcard that tests understanding of its key idea. ' +
  'Write any mathematical notation as LaTeX ($...$ inline, $$...$$ display). ' +
  'Respond in exactly this format and nothing else:\nFRONT: <question>\nBACK: <answer>';

function parseFrontBack(raw: string): { front: string; back: string } | null {
  const frontMatch = raw.match(/FRONT:\s*([\s\S]*?)(?:\n\s*BACK:|$)/i);
  const backMatch = raw.match(/BACK:\s*([\s\S]*)$/i);
  const front = frontMatch?.[1]?.replace(/\*\*/g, '').trim();
  const back = backMatch?.[1]?.replace(/\*\*/g, '').trim();
  if (!front || !back) return null;
  return { front, back };
}

export interface GenerationProgress {
  done: number;
  total: number;
}

export async function generateFlashcardsForHighlights(
  highlights: Highlight[],
  onProgress?: (p: GenerationProgress) => void
): Promise<Flashcard[]> {
  const { isAuthenticated, requireAuth } = useStore.getState();
  if (!isAuthenticated) {
    requireAuth('Sign in to generate flashcards', () => {
      generateFlashcardsForHighlights(highlights, onProgress);
    });
    return [];
  }

  const created: Flashcard[] = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    try {
      const raw = await callAI([
        { role: 'system', content: FLASHCARD_SYSTEM },
        { role: 'user', content: `Passage:\n${h.selected_text}` },
      ]);
      const parsed = parseFrontBack(raw);
      if (parsed) {
        const json = await invoke<string>('add_flashcard', {
          sourceHighlightId: h.id,
          pdfId: h.pdf_id,
          page: h.page,
          front: parsed.front,
          back: parsed.back,
        });
        created.push(JSON.parse(json));
      }
    } catch (err) {
      console.error('[flashcards] generation failed for highlight', h.id, err);
    }
    onProgress?.({ done: i + 1, total: highlights.length });
  }

  return created;
}

// ── Confidence metric ───────────────────────────────────────────────────────
// Cards carry a manual confidence_level (0 = unreviewed, 1 = low,
// 2 = medium, 3 = mastered) instead of SRS scheduling. "Low confidence"
// deliberately includes unreviewed cards — both need attention.

export function isLowConfidence(card: Flashcard): boolean {
  return card.confidence_level <= 1;
}

export interface DeckMastery {
  mastered: number;
  total: number;
  percent: number;
}

export function deckMastery(cards: Flashcard[]): DeckMastery {
  const total = cards.length;
  const mastered = cards.filter((c) => c.confidence_level === 3).length;
  return { mastered, total, percent: total === 0 ? 0 : Math.round((mastered / total) * 100) };
}
