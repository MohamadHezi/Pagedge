import { invoke } from '@tauri-apps/api/core';
import { callAI } from './aiService';
import { useStore } from '../store';
import type { Flashcard, Highlight, ReviewQuality } from '../types';

const FLASHCARD_SYSTEM =
  'You are a study-flashcard generator. Given a passage a student highlighted, ' +
  'produce exactly one flashcard that tests understanding of its key idea. ' +
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

const QUALITY_SCORE: Record<ReviewQuality, number> = { again: 0, hard: 3, good: 4, easy: 5 };

export interface GradeResult {
  interval: number;
  easeFactor: number;
  repetitions: number;
  nextReview: string;
}

export function gradeFlashcard(card: Flashcard, quality: ReviewQuality): GradeResult {
  const q = QUALITY_SCORE[quality];
  let repetitions = card.repetitions;
  let ef = card.ease_factor;
  let interval = card.interval;

  if (q < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round(interval * ef);
  }

  ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  ef = Math.max(1.3, ef);

  const nextReview = new Date(Date.now() + interval * 86_400_000).toISOString();
  return { interval, easeFactor: ef, repetitions, nextReview };
}
