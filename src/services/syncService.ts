import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import type { Highlight, Note, Flashcard, HlRect } from '../types';
import { API_BASE_URL, loadSession, refreshSession } from './authService';

// ── Sync entity shape ──────────────────────────────────────────────────────
// The local SQLite schema has no dedicated sync_version column (see
// CLAUDE.md — Highlight/Note/Flashcard predate this feature). Until a real
// migration adds one, sync_version is derived from each row's own
// updated_at/created_at timestamp (ms since epoch). This is monotonic for
// any single row's edit history, which is all last-write-wins needs — it
// just isn't a dedicated counter the backend could use for anything fancier.
function versionOf(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : Date.now();
}

// ── Server row shapes (pagedge-backend/app/api/sync/*) ─────────────────────
// These mirror HIGHLIGHT_FIELDS/NOTE_FIELDS/FLASHCARD_FIELDS in
// pagedge-backend/app/api/sync/push/route.ts. The server has no concept of
// a local pdf_id — rows are scoped by synced_pdf_id — so pdf_id is threaded
// through separately wherever a server row is converted back to a local row.
interface ServerHighlight {
  id: string;
  sync_version: number;
  page: number;
  color: string;
  selected_text: string;
  position_x: number;
  position_y: number;
  position_w: number;
  position_h: number;
  rects_json: string | null;
  note: string | null;
  updated_at: string;
  deleted_at: string | null;
}

interface ServerNote {
  id: string;
  sync_version: number;
  title: string;
  content_markdown: string;
  source_page: number | null;
  tags: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ServerFlashcard {
  id: string;
  sync_version: number;
  source_highlight_id: string;
  page: number;
  front: string;
  back: string;
  confidence_level: number;
  last_reviewed_at: string | null;
  updated_at: string;
  deleted_at: string | null;
}

interface ServerEntities {
  highlights: ServerHighlight[];
  notes: ServerNote[];
  flashcards: ServerFlashcard[];
}

function toServerHighlight(h: Highlight): ServerHighlight {
  // Highlights have no in-place edit path — created_at was previously used
  // as a stable version anchor. A delete now bumps the local updated_at
  // column (see delete_highlight in commands.rs), so the tombstone push
  // carries a strictly newer sync_version than the original create push —
  // without this, the backend's `existing.sync_version >= syncVersion`
  // gate would reject every delete as "not newer" and it would never sync.
  const versionAnchor = h.updated_at ?? h.created_at;
  return {
    id: h.id,
    sync_version: versionOf(versionAnchor),
    page: h.page,
    color: h.color,
    selected_text: h.selected_text,
    position_x: h.position_x,
    position_y: h.position_y,
    position_w: h.position_w,
    position_h: h.position_h,
    rects_json: h.rects ? JSON.stringify(h.rects) : null,
    note: h.note,
    updated_at: versionAnchor,
    deleted_at: h.deleted_at,
  };
}

function toServerNote(n: Note): ServerNote {
  return {
    id: n.id,
    sync_version: versionOf(n.updated_at),
    title: n.title,
    content_markdown: n.content_markdown,
    source_page: n.source_page,
    tags: JSON.stringify(n.tags),
    updated_at: n.updated_at,
    deleted_at: n.deleted_at,
  };
}

function toServerFlashcard(f: Flashcard): ServerFlashcard {
  return {
    id: f.id,
    sync_version: versionOf(f.updated_at),
    source_highlight_id: f.source_highlight_id,
    page: f.page,
    front: f.front,
    back: f.back,
    confidence_level: f.confidence_level,
    last_reviewed_at: f.last_reviewed_at,
    updated_at: f.updated_at,
    deleted_at: f.deleted_at,
  };
}

function fromServerHighlight(row: ServerHighlight, pdfId: string): Highlight {
  let rects: HlRect[] | null = null;
  if (row.rects_json) {
    try { rects = JSON.parse(row.rects_json); } catch { rects = null; }
  }
  return {
    id: row.id,
    pdf_id: pdfId,
    page: row.page,
    color: row.color as Highlight['color'],
    selected_text: row.selected_text,
    position_x: row.position_x,
    position_y: row.position_y,
    position_w: row.position_w,
    position_h: row.position_h,
    rects,
    note: row.note,
    created_at: row.updated_at,
    updated_at: row.updated_at,
    deleted_at: null,
  };
}

function fromServerNote(row: ServerNote, pdfId: string): Note {
  let tags: string[] = [];
  if (row.tags) {
    try { tags = JSON.parse(row.tags); } catch { tags = []; }
  }
  return {
    id: row.id,
    title: row.title,
    content_markdown: row.content_markdown,
    folder_id: null,
    source_pdf_id: pdfId,
    source_page: row.source_page,
    tags,
    created_at: row.updated_at,
    updated_at: row.updated_at,
    deleted_at: null,
  };
}

function fromServerFlashcard(row: ServerFlashcard, pdfId: string): Flashcard {
  return {
    id: row.id,
    source_highlight_id: row.source_highlight_id,
    pdf_id: pdfId,
    page: row.page,
    front: row.front,
    back: row.back,
    // ?? fallbacks cover rows pushed before the SRS→confidence migration,
    // which lack both fields — they surface as unreviewed.
    confidence_level: row.confidence_level ?? 0,
    last_reviewed_at: row.last_reviewed_at ?? null,
    created_at: row.updated_at,
    updated_at: row.updated_at,
    deleted_at: null,
  };
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

interface PushResult { id: string; status: 'accepted' | 'rejected'; error?: string; server?: Record<string, unknown> }
interface PushResponse {
  synced_pdf_id: string;
  content_hash: string;
  results: { highlights: PushResult[]; notes: PushResult[]; flashcards: PushResult[] };
}

// pushPdf's content_hash guard (below) means a push scheduled just after a
// freshly-imported PDF, before its hash finishes computing, would otherwise
// be dropped forever. Track it here and retry once the hash resolves — see
// retryPushIfPending, called from store/index.ts's update_pdf_content_hash
// callbacks (addPdf and the loadPdfs backfill loop).
const pushesAwaitingContentHash = new Set<string>();

export function retryPushIfPending(pdfId: string): void {
  if (!pushesAwaitingContentHash.has(pdfId)) return;
  pushesAwaitingContentHash.delete(pdfId);
  pushPdf(pdfId).catch((err) => {
    if (err instanceof Error && err.message === 'sync_requires_pro') return;
    console.error('[sync] retry push after content_hash resolved failed', err);
  });
}

// Reads highlights/notes/flashcards for pdfId directly from SQLite instead
// of the Zustand store — the store's arrays only ever hold whichever PDF
// is currently open (selectPdf replaces them on switch), so a push
// targeting a pdfId the user has since navigated away from would otherwise
// see stale/empty data. These Tauri commands are already scoped by pdf_id
// and work regardless of what's selected in the UI.
async function loadEntitiesForPush(pdfId: string): Promise<ServerEntities> {
  const [highlightsJson, notesJson, flashcardsJson] = await Promise.all([
    invoke<string>('get_highlights', { pdfId, includeDeleted: true }),
    invoke<string>('get_notes', { pdfId, includeDeleted: true }),
    invoke<string>('get_flashcards', { pdfId, includeDeleted: true }),
  ]);
  const highlights: Highlight[] = JSON.parse(highlightsJson);
  const notes: Note[] = JSON.parse(notesJson);
  const flashcards: Flashcard[] = JSON.parse(flashcardsJson);
  return {
    highlights: highlights.map(toServerHighlight),
    notes: notes.map(toServerNote),
    flashcards: flashcards.map(toServerFlashcard),
  };
}

export async function pushPdf(pdfId: string): Promise<void> {
  requireProOrThrow();

  const pdf = useStore.getState().pdfs.find((p) => p.id === pdfId);
  if (!pdf?.content_hash) {
    // Content hash not computed yet — queue for retry instead of dropping
    // this push forever; retryPushIfPending fires it once the hash lands.
    pushesAwaitingContentHash.add(pdfId);
    return;
  }
  pushesAwaitingContentHash.delete(pdfId);

  const entities = await loadEntitiesForPush(pdfId);
  if (!entities.highlights.length && !entities.notes.length && !entities.flashcards.length) return;

  await withRetry(async () => {
    const response = await authedFetch('/sync/push', {
      method: 'POST',
      body: JSON.stringify({ content_hash: pdf.content_hash, display_name: pdf.filename, entities }),
    });
    if (!response.ok) throw new Error(`sync push failed (${response.status})`);
    const data = (await response.json().catch(() => ({}))) as PushResponse;

    for (const r of data.results?.highlights ?? []) {
      if (r.status === 'rejected' && r.server) applyServerHighlight(r.server as unknown as ServerHighlight, pdfId);
    }
    for (const r of data.results?.notes ?? []) {
      if (r.status === 'rejected' && r.server) applyServerNote(r.server as unknown as ServerNote, pdfId);
    }
    for (const r of data.results?.flashcards ?? []) {
      if (r.status === 'rejected' && r.server) applyServerFlashcard(r.server as unknown as ServerFlashcard, pdfId);
    }
  });
}

// ── Pull ──────────────────────────────────────────────────────────────────
interface SyncedPdfSummary {
  content_hash: string;
  display_name: string | null;
  counts: { highlights: number; notes: number; flashcards: number };
  updated_at: string;
}

interface PullResponse {
  pdfs: Record<string, { synced_pdf_id: string; highlights: ServerHighlight[]; notes: ServerNote[]; flashcards: ServerFlashcard[] }>;
  other_synced: SyncedPdfSummary[];
}

const lastPullAtByHash = new Map<string, string>();

// Deleting a PDF hard-deletes its highlights/notes/flashcards locally (see
// delete_pdf in commands.rs) but never tells the server — there's no
// pdfs.deleted_at tombstone pushed. If the same file is re-imported later in
// the same app session and its content_hash still has an advanced cursor
// here, the next pull would only fetch rows newer than that stale watermark
// and silently skip re-creating older parent rows (e.g. a highlight) whose
// dependents (e.g. a flashcard) do get re-fetched — a permanent FK orphan.
// Clearing the cursor on delete forces a full re-sync from scratch instead.
export function clearPullCursor(contentHash: string | null | undefined): void {
  if (contentHash) lastPullAtByHash.delete(contentHash);
}

async function pullRaw(contentHashes: string[], since: string): Promise<PullResponse> {
  const body = { content_hashes: contentHashes, since };
  const response = await authedFetch('/sync/pull', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`sync pull failed (${response.status})`);
  }
  const data = (await response.json()) as PullResponse;
  return data;
}

export async function pullPdf(contentHash: string): Promise<void> {
  requireProOrThrow();

  const pdf = useStore.getState().pdfs.find((p) => p.content_hash === contentHash);
  if (!pdf) return;

  const since = lastPullAtByHash.get(contentHash) ?? new Date(0).toISOString();

  await withRetry(async () => {
    const data = await pullRaw([contentHash], since);
    const bundle = data.pdfs[contentHash];

    // The next cursor must be derived from server-stamped row data, not the
    // client clock — client/server clock skew would otherwise permanently
    // skip any row whose updated_at falls after a fast local clock's "now".
    //
    // Rows within bundle.highlights/notes/flashcards aren't guaranteed to
    // arrive in updated_at order, so if any row in the batch fails to
    // persist we don't advance the cursor at all this cycle rather than
    // capping at the highest *successful* row — a later-arriving success
    // with a newer timestamp than an earlier failure would otherwise push
    // the cursor past the failed row and it would never be retried. Only
    // once every row in the batch has been confirmed persisted do we know
    // the true max updated_at is safe to use as the next `since`.
    let maxRowUpdatedAt: string | null = null;
    let allPersisted = true;

    const track = (updatedAt: string, persisted: boolean) => {
      if (!persisted) allPersisted = false;
      if (maxRowUpdatedAt === null || versionOf(updatedAt) > versionOf(maxRowUpdatedAt)) {
        maxRowUpdatedAt = updatedAt;
      }
    };

    if (bundle) {
      for (const row of bundle.highlights) track(row.updated_at, await applyServerHighlight(row, pdf.id));
      for (const row of bundle.notes) track(row.updated_at, await applyServerNote(row, pdf.id));
      for (const row of bundle.flashcards) track(row.updated_at, await applyServerFlashcard(row, pdf.id));
    }

    if (allPersisted && maxRowUpdatedAt !== null) {
      lastPullAtByHash.set(contentHash, maxRowUpdatedAt);
    }
    // else: leave the cursor at `since` so the next pull re-fetches this
    // entire batch, including whichever row(s) failed to persist.

    cachePendingFromSummaries(data.other_synced).catch((err) => console.error('[sync] pending cache refresh failed', err));
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

  for (const hash of hashes) {
    try {
      await pullPdf(hash);
    } catch (err) {
      console.error('[sync] foreground pull failed', hash, err);
    }
  }

  // Even with no local PDFs synced yet, still refresh the "known to the
  // account but not present locally" list so the library badge stays current.
  if (!hashes.length) {
    try {
      const data = await pullRaw([], new Date(0).toISOString());
      await cachePendingFromSummaries(data.other_synced);
    } catch (err) {
      console.error('[sync] foreground manifest refresh failed', err);
    }
  }

  await refreshRemoteOnlyPdfs();
}

// ── Manifest ─────────────────────────────────────────────────────────────
export async function getManifest(): Promise<SyncedPdfSummary[]> {
  requireProOrThrow();
  return withRetry(async () => {
    const response = await authedFetch('/sync/manifest', { method: 'GET' });
    if (!response.ok) throw new Error(`sync manifest failed (${response.status})`);
    const data = (await response.json()) as { pdfs: SyncedPdfSummary[] };
    return data.pdfs;
  });
}

// Refreshes the store's list of PDFs known to the account (via the manifest)
// that aren't present in the local library yet — drives the library-level
// "synced elsewhere" indicator.
export async function refreshRemoteOnlyPdfs(): Promise<void> {
  try {
    const manifest = await getManifest();
    const localHashes = new Set(useStore.getState().pdfs.map((p) => p.content_hash).filter(Boolean));
    useStore.getState().setRemoteOnlyPdfs(manifest.filter((m) => !localHashes.has(m.content_hash)));
  } catch (err) {
    if (err instanceof Error && (err.message === 'sync_requires_pro' || err.message === 'Not authenticated')) return;
    console.error('[sync] manifest refresh failed', err);
  }
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

// ── Pending PDF annotations (cross-device import prompt) ────────────────
// "other_synced" (from pull) / the manifest only carry counts — enough for
// the library badge, but not enough to materialize instantly on import. For
// any such PDF not present locally, opportunistically fetch its full
// payload and cache it in SQLite (pending_pdf_annotations) so the "Import"
// action in the add-PDF prompt is instant and works offline once cached.
const PENDING_REFRESH_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_PENDING_FETCHES_PER_CYCLE = 10;

async function cachePendingFromSummaries(summaries: SyncedPdfSummary[]): Promise<void> {
  if (!summaries.length) return;
  const localHashes = new Set(useStore.getState().pdfs.map((p) => p.content_hash).filter(Boolean));
  const candidates = summaries.filter((s) => !localHashes.has(s.content_hash)).slice(0, MAX_PENDING_FETCHES_PER_CYCLE);

  for (const summary of candidates) {
    try {
      await fetchAndCachePendingAnnotations(summary.content_hash, summary.display_name);
    } catch (err) {
      console.error('[sync] failed to cache pending annotations', summary.content_hash, err);
    }
  }
}

async function fetchAndCachePendingAnnotations(contentHash: string, displayName: string | null, force = false): Promise<void> {
  if (!force) {
    const existingJson = await invoke<string>('get_pending_pdf_annotation', { contentHash });
    const existing = JSON.parse(existingJson) as { fetched_at: string } | null;
    if (existing && Date.now() - Date.parse(existing.fetched_at) < PENDING_REFRESH_THROTTLE_MS) return;
  }

  const data = await pullRaw([contentHash], new Date(0).toISOString());
  const bundle = data.pdfs[contentHash];
  const highlights = (bundle?.highlights ?? []).filter((h) => !h.deleted_at);
  const notes = (bundle?.notes ?? []).filter((n) => !n.deleted_at);
  const flashcards = (bundle?.flashcards ?? []).filter((f) => !f.deleted_at);

  await invoke('upsert_pending_pdf_annotation', {
    contentHash,
    pdfDisplayName: displayName ?? 'Untitled PDF',
    highlightCount: highlights.length,
    noteCount: notes.length,
    flashcardCount: flashcards.length,
    payloadJson: JSON.stringify({ highlights, notes, flashcards }),
  });
}

export interface PendingAnnotationSummary {
  content_hash: string;
  pdf_display_name: string;
  highlight_count: number;
  note_count: number;
  flashcard_count: number;
  fetched_at: string;
  payload_json: string | null;
}

// Called when a PDF is added (or its content_hash is first computed) — a
// two-tier lookup: use the local cache if we have one, otherwise do a live
// pull scoped to this single hash so the prompt still works the very first
// time this device learns the hash matches something synced elsewhere.
export async function checkPendingAnnotationsForHash(contentHash: string): Promise<PendingAnnotationSummary | null> {
  const { user } = useStore.getState();
  if (!user || user.tier === 'free') return null;

  const cachedJson = await invoke<string>('get_pending_pdf_annotation', { contentHash });
  const cached = JSON.parse(cachedJson) as PendingAnnotationSummary | null;
  if (cached && (cached.highlight_count || cached.note_count || cached.flashcard_count)) {
    return cached;
  }

  try {
    const data = await pullRaw([contentHash], new Date(0).toISOString());
    const bundle = data.pdfs[contentHash];
    if (!bundle) {
      return null;
    }
    const highlights = bundle.highlights.filter((h) => !h.deleted_at);
    const notes = bundle.notes.filter((n) => !n.deleted_at);
    const flashcards = bundle.flashcards.filter((f) => !f.deleted_at);
    if (!highlights.length && !notes.length && !flashcards.length) {
      return null;
    }

    const displayName = useStore.getState().pdfs.find((p) => p.content_hash === contentHash)?.filename ?? 'Untitled PDF';
    await invoke('upsert_pending_pdf_annotation', {
      contentHash,
      pdfDisplayName: displayName,
      highlightCount: highlights.length,
      noteCount: notes.length,
      flashcardCount: flashcards.length,
      payloadJson: JSON.stringify({ highlights, notes, flashcards }),
    });

    return {
      content_hash: contentHash,
      pdf_display_name: displayName,
      highlight_count: highlights.length,
      note_count: notes.length,
      flashcard_count: flashcards.length,
      fetched_at: new Date().toISOString(),
      payload_json: null,
    };
  } catch (err) {
    console.error('[sync] live pending-annotation check failed', err);
    return null;
  }
}

interface MaterializeResult { highlights: Highlight[]; notes: Note[]; flashcards: Flashcard[] }

// One-click "Import" action: materializes the cached payload into local
// highlights/notes/flashcards rows scoped to pdfId, merges them into the
// store if that PDF is currently open, and clears the pending cache entry.
export async function materializePendingAnnotations(contentHash: string, pdfId: string): Promise<MaterializeResult> {
  const json = await invoke<string>('materialize_pending_pdf_annotations', { contentHash, pdfId });
  const result = JSON.parse(json) as MaterializeResult;

  if (useStore.getState().selectedPdfId === pdfId) {
    useStore.setState((s) => ({
      highlights: [...s.highlights, ...result.highlights],
      notes: [...result.notes, ...s.notes],
      flashcards: [...s.flashcards, ...result.flashcards],
    }));
  }

  useStore.getState().clearPendingImportPrompt();
  return result;
}

export async function dismissPendingAnnotations(contentHash: string): Promise<void> {
  await invoke('delete_pending_pdf_annotation', { contentHash });
  useStore.getState().clearPendingImportPrompt();
}

// ── Conflict resolution ─────────────────────────────────────────────────
// Last-write-wins by updated_at: a server row is only ever handed back
// (push rejection, or as a pull "changed" row) because its version is >=
// ours, so applying it unconditionally is correct — the only per-row
// decision left is whether the server's version is actually newer than the
// local one, to avoid clobbering an in-flight local edit with a stale echo.
function isNewer(localAnchor: string | undefined, serverUpdatedAt: string): boolean {
  if (!localAnchor) return true;
  return versionOf(serverUpdatedAt) > versionOf(localAnchor);
}

// Returns whether the local SQLite write actually succeeded — callers that
// derive a pull cursor from this (pullPdf) must not advance past a row whose
// local persist failed, or that row would be lost until restart.
async function applyServerHighlight(row: ServerHighlight, pdfId: string): Promise<boolean> {
  const state = useStore.getState();
  // The highlights/notes/flashcards arrays only ever hold whichever PDF is
  // currently open (loadHighlights/loadNotes/loadFlashcards replace them
  // wholesale on PDF switch) — a row pulled for a PDF that isn't open right
  // now must still persist to SQLite (pullAllOnForeground syncs every known
  // PDF, not just the open one), but must not be spliced into the live
  // array, or it renders as if it belongs to whatever PDF the user has open.
  const isCurrentPdf = pdfId === state.selectedPdfId;
  const local = state.highlights.find((h) => h.id === row.id);

  if (row.deleted_at) {
    if (isCurrentPdf && local) {
      useStore.setState((s) => ({ highlights: s.highlights.filter((h) => h.id !== row.id) }));
    }
    try {
      await invoke('delete_highlight', { id: row.id });
      return true;
    } catch (err) {
      console.error('[sync] failed to delete highlight', err);
      return false;
    }
  }

  // Same anchor fallback as toServerHighlight's own versionAnchor: a
  // highlight only ever gets a real updated_at from a delete or a prior
  // server pull, so most local rows fall back to created_at here.
  if (local && !isNewer(local.updated_at ?? local.created_at, row.updated_at)) return true;
  const highlight = fromServerHighlight(row, pdfId);

  if (isCurrentPdf) {
    useStore.setState((s) => ({
      highlights: local ? s.highlights.map((h) => (h.id === row.id ? highlight : h)) : [...s.highlights, highlight],
    }));
  }

  try {
    await invoke('upsert_highlight', {
      id: highlight.id,
      pdfId: highlight.pdf_id,
      page: highlight.page,
      color: highlight.color,
      selectedText: highlight.selected_text,
      x: highlight.position_x,
      y: highlight.position_y,
      w: highlight.position_w,
      h: highlight.position_h,
      note: highlight.note,
      rects: highlight.rects ? JSON.stringify(highlight.rects) : null,
      createdAt: highlight.created_at,
    });
    return true;
  } catch (err) {
    console.warn(`[sync] failed to upsert highlight ${row.id} from server pull — local row may now be out of sync`, err);
    return false;
  }
}

async function applyServerNote(row: ServerNote, pdfId: string): Promise<boolean> {
  const state = useStore.getState();
  // See the matching comment in applyServerHighlight — same reasoning.
  const isCurrentPdf = pdfId === state.selectedPdfId;
  const local = state.notes.find((n) => n.id === row.id);

  if (row.deleted_at) {
    if (isCurrentPdf && local) {
      useStore.setState((s) => ({ notes: s.notes.filter((n) => n.id !== row.id) }));
    }
    try {
      await invoke('delete_note', { id: row.id });
      return true;
    } catch (err) {
      console.error('[sync] failed to delete note', err);
      return false;
    }
  }

  if (local && !isNewer(local.updated_at, row.updated_at)) return true;
  const note = fromServerNote(row, pdfId);

  if (isCurrentPdf) {
    useStore.setState((s) => ({
      notes: local ? s.notes.map((n) => (n.id === row.id ? note : n)) : [note, ...s.notes],
    }));
  }

  try {
    await invoke('upsert_note', {
      id: note.id,
      title: note.title,
      contentMarkdown: note.content_markdown,
      sourcePdfId: note.source_pdf_id,
      sourcePage: note.source_page,
      tags: note.tags,
      updatedAt: note.updated_at,
    });
    return true;
  } catch (err) {
    console.warn(`[sync] failed to upsert note ${row.id} from server pull — local row may now be out of sync`, err);
    return false;
  }
}

async function applyServerFlashcard(row: ServerFlashcard, pdfId: string): Promise<boolean> {
  const state = useStore.getState();
  // See the matching comment in applyServerHighlight — same reasoning.
  const isCurrentPdf = pdfId === state.selectedPdfId;
  const local = state.flashcards.find((f) => f.id === row.id);

  if (row.deleted_at) {
    if (isCurrentPdf && local) {
      useStore.setState((s) => ({ flashcards: s.flashcards.filter((f) => f.id !== row.id) }));
    }
    try {
      await invoke('delete_flashcard', { id: row.id });
      return true;
    } catch (err) {
      console.error('[sync] failed to delete flashcard', err);
      return false;
    }
  }

  if (local && !isNewer(local.updated_at, row.updated_at)) return true;

  // Guard against a permanently orphaned flashcard: its source highlight was
  // hard-deleted locally (e.g. by deleting and re-importing the PDF while a
  // stale pull cursor skipped re-fetching it) or soft-deleted server-side
  // without a matching flashcard tombstone ever being pushed. Either way the
  // highlight will never arrive, so upsert_flashcard's FK would fail forever
  // and spam retries on every foreground pull. bundle.highlights is always
  // processed before bundle.flashcards within the same pull cycle (see
  // pullPdf), so a "no" here is a reliable signal, not a same-batch race.
  const highlightPresent = await invoke<boolean>('highlight_exists', { id: row.source_highlight_id }).catch(() => true);
  if (!highlightPresent) {
    console.warn(`[sync] flashcard ${row.id} references a missing highlight ${row.source_highlight_id} — dropping instead of retrying forever`);
    if (isCurrentPdf && local) {
      useStore.setState((s) => ({ flashcards: s.flashcards.filter((f) => f.id !== row.id) }));
    }
    return true;
  }

  const card = fromServerFlashcard(row, pdfId);

  if (isCurrentPdf) {
    useStore.setState((s) => ({
      flashcards: local ? s.flashcards.map((f) => (f.id === row.id ? card : f)) : [...s.flashcards, card],
    }));
  }

  try {
    await invoke('upsert_flashcard', {
      id: card.id,
      sourceHighlightId: card.source_highlight_id,
      pdfId: card.pdf_id,
      page: card.page,
      front: card.front,
      back: card.back,
      confidenceLevel: card.confidence_level,
      lastReviewedAt: card.last_reviewed_at,
      createdAt: card.created_at,
      updatedAt: card.updated_at,
    });
    return true;
  } catch (err) {
    console.warn(`[sync] failed to upsert flashcard ${row.id} from server pull — local row may now be out of sync`, err);
    return false;
  }
}
