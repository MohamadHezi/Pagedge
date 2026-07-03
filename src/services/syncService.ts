import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import type { Highlight, Note, Flashcard } from '../types';
import { API_BASE_URL, loadSession, refreshSession } from './authService';

// ── Sync entity shape ──────────────────────────────────────────────────────
// The local SQLite schema has no dedicated sync_version column (see
// CLAUDE.md — Highlight/Note/Flashcard predate this feature). Until a real
// migration adds one, sync_version is derived from each row's own
// updated_at/created_at timestamp (ms since epoch). This is monotonic for
// any single row's edit history, which is all last-write-wins needs — it
// just isn't a dedicated counter the backend could use for anything fancier.
interface SyncEntity {
  id: string;
  sync_version: number;
  updated_at: string;
  [key: string]: unknown;
}

type EntityKind = 'highlights' | 'notes' | 'flashcards';

interface PushEntities {
  highlights: SyncEntity[];
  notes: SyncEntity[];
  flashcards: SyncEntity[];
}

interface PushResponse {
  // Assumed shape: server's authoritative copy of any item it rejected
  // (its sync_version wasn't newer than what the server already had),
  // grouped the same way as the request payload.
  rejected?: Partial<PushEntities>;
}

interface PullResponse {
  changed?: Partial<PushEntities>;
  // Counts for synced content_hashes under the account not present in
  // the pull request — surfaced so callers can notice PDFs synced from
  // another device that don't exist locally yet.
  unrequested?: Array<{ content_hash: string; counts: Record<string, number> }>;
}

interface ManifestEntry {
  content_hash: string;
  counts: Record<string, number>;
  updated_at: string;
}

function versionOf(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : Date.now();
}

function toSyncEntity(row: { id: string }, updatedAt: string): SyncEntity {
  return { ...row, sync_version: versionOf(updatedAt), updated_at: updatedAt };
}

// ── Auth/tier gate ──────────────────────────────────────────────────────────
// Mirrors aiService.ts's callProxy pre-check: paywall-gate before any
// network call, never before a local SQLite read/write.
function requireProOrThrow(): void {
  const { user, showPaywall } = useStore.getState();
  if (!user) {
    useStore.getState().clearUser();
    throw new Error('Not authenticated');
  }
  if (user.tier === 'free') {
    showPaywall('sync_requires_pro');
    throw new Error('sync_requires_pro');
  }
}

async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  const session = await loadSession();
  if (!session) {
    useStore.getState().clearUser();
    throw new Error('Not authenticated');
  }

  const doFetch = (accessToken: string) =>
    fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...init.headers,
      },
    });

  let response = await doFetch(session.access_token);
  if (response.status === 401) {
    const refreshed = await refreshSession(session);
    response = await doFetch(refreshed.access_token);
  }
  return response;
}

// ── Retry/backoff ────────────────────────────────────────────────────────
const RETRY_DELAYS_MS = [1000, 3000, 8000];

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

// ── Push ──────────────────────────────────────────────────────────────────
// Debounced per-PDF so a burst of highlight/note/flashcard mutations
// (e.g. selecting several lines in a row) collapses into one push.
const PUSH_DEBOUNCE_MS = 4000;
const pendingPushTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function schedulePush(pdfId: string): void {
  const existing = pendingPushTimers.get(pdfId);
  if (existing) clearTimeout(existing);
  pendingPushTimers.set(
    pdfId,
    setTimeout(() => {
      pendingPushTimers.delete(pdfId);
      pushPdf(pdfId).catch((err) => {
        if (err instanceof Error && err.message === 'sync_requires_pro') return;
        console.error('[sync] push failed', err);
      });
    }, PUSH_DEBOUNCE_MS)
  );
}

export async function pushPdf(pdfId: string): Promise<void> {
  requireProOrThrow();

  const { pdfs, selectedPdfId, highlights, notes, flashcards } = useStore.getState();
  const pdf = pdfs.find((p) => p.id === pdfId);
  if (!pdf?.content_hash) return; // content hash not computed yet — nothing to key the push on

  // highlights/notes/flashcards in the store only reflect whichever PDF is
  // currently open (selectPdf replaces them on switch), so a push only has
  // real data to send when it targets that PDF.
  if (selectedPdfId !== pdfId) return;

  const entities: PushEntities = {
    highlights: highlights
      .filter((h) => h.pdf_id === pdfId)
      .map((h: Highlight) => toSyncEntity(h, h.created_at)),
    notes: notes
      .filter((n) => n.source_pdf_id === pdfId)
      .map((n: Note) => toSyncEntity(n, n.updated_at)),
    flashcards: flashcards
      .filter((f) => f.pdf_id === pdfId)
      .map((f: Flashcard) => toSyncEntity(f, f.created_at)),
  };

  if (!entities.highlights.length && !entities.notes.length && !entities.flashcards.length) return;

  await withRetry(async () => {
    const response = await authedFetch('/sync/push', {
      method: 'POST',
      body: JSON.stringify({ content_hash: pdf.content_hash, entities }),
    });
    if (!response.ok) throw new Error(`sync push failed (${response.status})`);
    const data = (await response.json().catch(() => ({}))) as PushResponse;
    if (data.rejected) applyServerCopies(data.rejected);
  });
}

// ── Pull ──────────────────────────────────────────────────────────────────
const lastPullAtByHash = new Map<string, string>();

export async function pullPdf(contentHash: string): Promise<void> {
  requireProOrThrow();

  const since = lastPullAtByHash.get(contentHash) ?? new Date(0).toISOString();

  await withRetry(async () => {
    const response = await authedFetch('/sync/pull', {
      method: 'POST',
      body: JSON.stringify({ content_hashes: [contentHash], since }),
    });
    if (!response.ok) throw new Error(`sync pull failed (${response.status})`);
    const data = (await response.json().catch(() => ({}))) as PullResponse;
    if (data.changed) applyServerCopies(data.changed);
    lastPullAtByHash.set(contentHash, new Date().toISOString());
  });
}

// Called on app foreground: pulls every PDF the user has synced locally
// (i.e. has a content_hash), not just the one currently open.
export async function pullAllOnForeground(): Promise<void> {
  const { user } = useStore.getState();
  if (!user || user.tier === 'free') return; // silent no-op — foreground isn't a user action, don't interrupt with a paywall

  const hashes = Array.from(
    new Set(useStore.getState().pdfs.map((p) => p.content_hash).filter((h): h is string => !!h))
  );
  if (!hashes.length) return;

  for (const hash of hashes) {
    try {
      await pullPdf(hash);
    } catch (err) {
      console.error('[sync] foreground pull failed', hash, err);
    }
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────
export async function getManifest(): Promise<ManifestEntry[]> {
  requireProOrThrow();
  return withRetry(async () => {
    const response = await authedFetch('/sync/manifest', { method: 'GET' });
    if (!response.ok) throw new Error(`sync manifest failed (${response.status})`);
    return (await response.json()) as ManifestEntry[];
  });
}

// ── Unlink ───────────────────────────────────────────────────────────────
export async function unlinkPdf(contentHash: string): Promise<void> {
  requireProOrThrow();
  await withRetry(async () => {
    const response = await authedFetch(`/sync/pdf/${encodeURIComponent(contentHash)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(`sync unlink failed (${response.status})`);
  });
  lastPullAtByHash.delete(contentHash);
}

// ── Conflict resolution ─────────────────────────────────────────────────
// Last-write-wins by updated_at: the server only ever hands back rows in a
// push rejection or pull response because its copy's version is >= ours, so
// applying it unconditionally is correct — the only per-row decision left is
// whether the server's version is actually newer than the local one, to
// avoid clobbering an in-flight local edit with a stale server echo.
function applyServerCopies(entities: Partial<PushEntities>): void {
  if (entities.highlights?.length) applyKind('highlights', entities.highlights);
  if (entities.notes?.length) applyKind('notes', entities.notes);
  if (entities.flashcards?.length) applyKind('flashcards', entities.flashcards);
}

function applyKind(kind: EntityKind, rows: SyncEntity[]): void {
  for (const row of rows) {
    switch (kind) {
      case 'highlights':
        applyHighlight(row as unknown as Highlight & SyncEntity);
        break;
      case 'notes':
        applyNote(row as unknown as Note & SyncEntity);
        break;
      case 'flashcards':
        applyFlashcard(row as unknown as Flashcard & SyncEntity);
        break;
    }
  }
}

function isNewer(localUpdatedAt: string | undefined, serverRow: SyncEntity): boolean {
  if (!localUpdatedAt) return true;
  return versionOf(serverRow.updated_at) > versionOf(localUpdatedAt);
}

function applyHighlight(row: Highlight & SyncEntity): void {
  const state = useStore.getState();
  const local = state.highlights.find((h) => h.id === row.id);
  if (local && !isNewer(local.created_at, row)) return;

  useStore.setState((s) => ({
    highlights: local
      ? s.highlights.map((h) => (h.id === row.id ? { ...h, ...row } : h))
      : [...s.highlights, row],
  }));

  invoke('update_highlight', {
    id: row.id,
    page: row.page,
    color: row.color,
    selectedText: row.selected_text,
    x: row.position_x,
    y: row.position_y,
    w: row.position_w,
    h: row.position_h,
    note: row.note,
    rects: row.rects ? JSON.stringify(row.rects) : null,
  }).catch((err) => console.error('[sync] failed to persist highlight conflict copy', err));
}

function applyNote(row: Note & SyncEntity): void {
  const state = useStore.getState();
  const local = state.notes.find((n) => n.id === row.id);
  if (local && !isNewer(local.updated_at, row)) return;

  useStore.setState((s) => ({
    notes: local
      ? s.notes.map((n) => (n.id === row.id ? { ...n, ...row } : n))
      : [row, ...s.notes],
  }));

  invoke('update_note', {
    id: row.id,
    title: row.title,
    contentMarkdown: row.content_markdown,
    tags: row.tags,
  }).catch((err) => console.error('[sync] failed to persist note conflict copy', err));
}

function applyFlashcard(row: Flashcard & SyncEntity): void {
  const state = useStore.getState();
  const local = state.flashcards.find((f) => f.id === row.id);
  if (local && !isNewer(local.created_at, row)) return;

  useStore.setState((s) => ({
    flashcards: local
      ? s.flashcards.map((f) => (f.id === row.id ? { ...f, ...row } : f))
      : [...s.flashcards, row],
  }));

  invoke('update_flashcard_fields', {
    id: row.id,
    front: row.front,
    back: row.back,
  }).catch((err) => console.error('[sync] failed to persist flashcard conflict copy', err));

  invoke('update_flashcard_review', {
    id: row.id,
    interval: row.interval,
    easeFactor: row.ease_factor,
    repetitions: row.repetitions,
    nextReview: row.next_review,
  }).catch((err) => console.error('[sync] failed to persist flashcard conflict copy', err));
}
