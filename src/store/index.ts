import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Pdf, Folder, Highlight, LensKey, Note, IngestionStatus, ChatMessage, Drawing, DrawToolType, TextBox, Flashcard, Deck, ReviewFilter, OutlineItem } from "../types";
import type { HighlightColorKey } from "../constants/highlights";
import { resolveSession, signOut as signOutApi, loadSession, getMe, saveSessionTokens } from "../services/authService";
import { schedulePush, pullPdf, checkPendingAnnotationsForHash, retryPushIfPending, clearPullCursor } from "../services/syncService";

export interface RemoteOnlyPdf {
  content_hash: string;
  display_name: string | null;
  counts: { highlights: number; notes: number; flashcards: number };
  updated_at: string;
}

export interface PendingImportPrompt {
  pdfId: string;
  contentHash: string;
  displayName: string;
  highlightCount: number;
  noteCount: number;
  flashcardCount: number;
}

export interface AuthUser {
  id: string;
  email: string;
  tier: 'free' | 'pro';
  callsRemaining: number | null;
  resetAt: string | null;
}

export type PaywallReason = 'context_too_large' | 'quota_exceeded' | 'sync_requires_pro';

interface AppState {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  user: AuthUser | null;
  isAuthenticated: boolean;
  authLoading: boolean;
  setUser: (user: AuthUser) => void;
  clearUser: () => void;
  initAuth: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshUserFromMe: () => Promise<void>;
  completeEmailVerification: (accessToken: string, refreshToken: string) => Promise<void>;

  // Error from processing a pagedge://auth/confirm deep link (e.g. a
  // stale/expired/already-used token). Kept separate from AuthModal's own
  // local form-submit error so it can never bleed into the signin/signup
  // tabs — only the verify-email screen reads this.
  authTokenError: string | null;
  clearAuthTokenError: () => void;

  // Dismissible auth overlay shown on top of the live app (not a full-tree
  // gate) — call sites that need a signed-in user call requireAuth(reason)
  // to surface it with context-specific copy; the user can dismiss it and
  // keep using whatever parts of the app don't need an account. An optional
  // onSuccess callback is stashed alongside the prompt and fired by
  // AuthModal after a successful sign-in, so the original gated action
  // resumes instead of leaving the user to re-click it.
  authPromptOpen: boolean;
  authPromptReason: string | null;
  authPromptOnSuccess: (() => void) | null;
  requireAuth: (reason?: string, onSuccess?: () => void) => void;
  dismissAuthPrompt: () => void;

  // ── Paywall ───────────────────────────────────────────────────────────────────
  paywallOpen: boolean;
  paywallReason: PaywallReason | null;
  showPaywall: (reason: PaywallReason) => void;
  closePaywall: () => void;

  // ── Email verification toast ─────────────────────────────────────────────────
  emailVerifyToastOpen: boolean;
  showEmailVerifyToast: () => void;
  dismissEmailVerifyToast: () => void;

  // ── PDFs ────────────────────────────────────────────────────────────────────
  pdfs: Pdf[];
  selectedPdfId: string | null;
  folders: Folder[];
  addPdf: (filepath: string) => Promise<Pdf>;
  deletePdf: (id: string) => Promise<void>;
  renamePdf: (id: string, filename: string) => Promise<void>;
  selectPdf: (id: string | null) => void;
  loadPdfs: () => Promise<void>;
  updatePdfChunkCount: (pdfId: string, chunkCount: number) => void;

  // ── Collections (folders) + Pinned ───────────────────────────────────────────
  loadFolders: () => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  reorderFolders: (orderedIds: string[]) => Promise<void>;
  moveFolderToParent: (folderId: string, parentId: string | null) => Promise<void>;
  movePdfToFolder: (pdfId: string, folderId: string | null) => Promise<void>;
  setPdfPinned: (pdfId: string, pinned: boolean) => Promise<void>;
  setFolderPinned: (folderId: string, pinned: boolean) => Promise<void>;

  // ── Sync: cross-device annotations ───────────────────────────────────────────
  // PDFs known to the account (via GET /sync/manifest) but not present in the
  // local library yet — drives the library-level "synced elsewhere" badge.
  remoteOnlyPdfs: RemoteOnlyPdf[];
  setRemoteOnlyPdfs: (pdfs: RemoteOnlyPdf[]) => void;
  // Set right after a newly-added PDF's content_hash resolves to a match in
  // pending_pdf_annotations — drives the "N highlights available from
  // another device" import banner for that specific PDF.
  pendingImportPrompt: PendingImportPrompt | null;
  setPendingImportPrompt: (prompt: PendingImportPrompt | null) => void;
  clearPendingImportPrompt: () => void;

  // ── Highlights ───────────────────────────────────────────────────────────────
  highlights: Highlight[];
  activeLens: LensKey;
  loadHighlights: (pdfId: string) => Promise<void>;
  addHighlight: (h: Highlight) => void;
  removeHighlight: (id: string) => void;
  setActiveLens: (lens: LensKey) => void;

  // ── Notes ────────────────────────────────────────────────────────────────────
  notes: Note[];
  selectedNoteId: string | null;
  currentPage: number;
  jumpToPage: ((page: number) => void) | null;
  loadNotes: (pdfId: string) => Promise<void>;
  addNote: (note: Note) => void;
  updateNote: (id: string, changes: Partial<Note>) => void;
  removeNote: (id: string) => void;
  setSelectedNoteId: (id: string | null) => void;
  setCurrentPage: (page: number) => void;
  setJumpToPage: (fn: ((page: number) => void) | null) => void;

  // ── Panel visibility ─────────────────────────────────────────────────────────
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;

  // ── Ingestion ─────────────────────────────────────────────────────────────────
  ingestionStatus: Record<string, IngestionStatus>;
  isModelLoading: boolean;
  setIngestionStatus: (pdfId: string, status: IngestionStatus | null) => void;
  setModelLoading: (loading: boolean) => void;

  // ── AI settings ───────────────────────────────────────────────────────────────
  aiProvider: string;
  aiModel: string;
  aiBaseUrl: string;
  aiApiKey: string;
  // When false (default), AI calls route through the Pagedge backend proxy
  // (Gemini, quota-enforced). When true, calls go directly to the
  // provider/baseUrl/apiKey configured below, bypassing the proxy entirely.
  aiUseCustomProvider: boolean;
  setAiSettings: (s: Partial<{ aiProvider: string; aiModel: string; aiBaseUrl: string; aiApiKey: string; aiUseCustomProvider: boolean }>) => void;
  loadAiSettings: () => Promise<void>;

  // ── Chat ──────────────────────────────────────────────────────────────────────
  chatMessages: ChatMessage[];
  addChatMessage: (msg: ChatMessage) => void;
  clearChat: () => void;
  isAiLoading: boolean;
  setAiLoading: (loading: boolean) => void;

  // ── Settings panel ────────────────────────────────────────────────────────────
  settingsPanelOpen: boolean;
  setSettingsPanelOpen: (open: boolean) => void;

  // ── Feedback ──────────────────────────────────────────────────────────────────
  feedbackModalOpen: boolean;
  setFeedbackModalOpen: (open: boolean) => void;

  // ── Search ────────────────────────────────────────────────────────────────────
  searchModalOpen: boolean;
  setSearchModalOpen: (open: boolean) => void;

  // ── Graph view (knowledge map) ───────────────────────────────────────────────
  // Replaces the center panel with the knowledge graph when true. selectPdf
  // always resets it, so any node-click navigation (or the Library rail
  // button) naturally transitions back to the reader / library view.
  graphViewOpen: boolean;
  setGraphViewOpen: (open: boolean) => void;

  // ── Export ────────────────────────────────────────────────────────────────────
  exportDialogOpen: boolean;
  setExportDialogOpen: (open: boolean) => void;
  pendingJumpPage: number | null;
  setPendingJumpPage: (page: number | null) => void;

  // ── Summary ───────────────────────────────────────────────────────────────────
  summaryContent: string | null;
  summaryLens: LensKey | null;
  isSummarizing: boolean;
  setSummary: (content: string | null, lens: LensKey | null) => void;
  clearSummary: () => void;
  setIsSummarizing: (loading: boolean) => void;

  // ── Right panel ───────────────────────────────────────────────────────────────
  rightPanelTab: 'notes' | 'highlights' | 'chat';
  setRightPanelTab: (tab: 'notes' | 'highlights' | 'chat') => void;
  highlightFilter: HighlightColorKey | 'all';
  setHighlightFilter: (filter: HighlightColorKey | 'all') => void;
  flashHighlightId: string | null;
  setFlashHighlightId: (id: string | null) => void;

  // ── Drawings ─────────────────────────────────────────────────────────────────
  drawings: Drawing[];
  loadDrawings: (pdfId: string) => Promise<void>;
  addDrawing: (d: Drawing) => void;
  removeDrawing: (id: string) => void;

  // ── Draw mode ─────────────────────────────────────────────────────────────────
  drawMode: boolean;
  setDrawMode: (on: boolean) => void;
  activeDrawTool: DrawToolType;
  setActiveDrawTool: (tool: DrawToolType) => void;
  drawColor: string;
  setDrawColor: (color: string) => void;
  strokeWidth: number;
  setStrokeWidth: (w: number) => void;

  // ── Text boxes ────────────────────────────────────────────────────────────────
  textBoxes: TextBox[];
  loadTextBoxes: (pdfId: string) => Promise<void>;
  addTextBox: (tb: TextBox) => void;
  updateTextBoxLocal: (id: string, changes: Partial<TextBox>) => void;
  removeTextBox: (id: string) => void;
  selectedTextBoxId: string | null;
  setSelectedTextBoxId: (id: string | null) => void;
  placingTextBox: boolean;
  setPlacingTextBox: (on: boolean) => void;
  // Which box should auto-focus on mount (set when a box is freshly created)
  editingTextBoxId: string | null;
  setEditingTextBoxId: (id: string | null) => void;

  // ── Flashcards ───────────────────────────────────────────────────────────────
  flashcards: Flashcard[];
  loadFlashcards: (pdfId: string) => Promise<void>;
  addFlashcard: (f: Flashcard) => void;
  removeFlashcard: (id: string) => void;
  updateFlashcardLocal: (id: string, changes: Partial<Flashcard>) => void;
  reviewDeck: Flashcard[];
  reviewQueue: Flashcard[];
  reviewFilter: ReviewFilter;
  setReviewFilter: (f: ReviewFilter) => void;
  currentReviewIndex: number;
  reviewModeOpen: boolean;
  setReviewModeOpen: (open: boolean) => void;
  startReview: (deck: Flashcard[]) => void;
  advanceReview: () => void;
  isGeneratingFlashcards: boolean;
  setIsGeneratingFlashcards: (b: boolean) => void;
  generationProgress: { done: number; total: number } | null;
  setGenerationProgress: (p: { done: number; total: number } | null) => void;

  // ── Deck Manager ──────────────────────────────────────────────────────────
  // Replaces the center panel with the flashcard Deck Manager when true
  // (same pattern as graphViewOpen). selectPdf always resets it.
  deckManagerOpen: boolean;
  setDeckManagerOpen: (open: boolean) => void;
  decks: Deck[];
  loadDecks: () => Promise<void>;
  createDeck: (name: string) => Promise<Deck>;
  renameDeck: (id: string, name: string) => Promise<void>;
  deleteDeck: (id: string) => Promise<void>;
  // Whole-library card list backing the Deck Manager (the per-PDF
  // `flashcards` array only ever holds the open PDF's cards). Kept patched
  // by addFlashcard/removeFlashcard/updateFlashcardLocal after loading.
  allCards: Flashcard[];
  loadAllCards: () => Promise<void>;

  // ── Tags ──────────────────────────────────────────────────────────────────────
  suggestedTags: string[];
  setSuggestedTags: (tags: string[]) => void;
  clearSuggestedTags: () => void;
  isSuggestingTags: boolean;
  setIsSuggestingTags: (b: boolean) => void;
  activeTagFilter: string | null;
  setActiveTagFilter: (tag: string | null) => void;

  // ── Outline ───────────────────────────────────────────────────────────────────
  outline: OutlineItem[];
  setOutline: (items: OutlineItem[]) => void;
  loadOutline: (pdfId: string) => Promise<void>;
  outlineLoading: boolean;
  setOutlineLoading: (loading: boolean) => void;
  expandedOutlineIds: Set<string>;
  toggleOutlineExpanded: (id: string) => void;
  // Accordion section state — collapsed by default; extraction is deferred
  // until the user expands the section for the first time (see outlineAttempted).
  isOutlineSectionExpanded: boolean;
  setOutlineSectionExpanded: (expanded: boolean) => void;
  outlineAttempted: boolean;
  setOutlineAttempted: (attempted: boolean) => void;
  // Set by PdfViewer once the PDF.js document is loaded; lets the (lazily
  // mounted) OutlinePanel kick off extraction without holding its own
  // reference to the PDF.js document.
  requestOutlineExtraction: (() => void) | null;
  setRequestOutlineExtraction: (fn: (() => void) | null) => void;
}

export const useStore = create<AppState>((set) => ({
  // ── Auth ──────────────────────────────────────────────────────────────────────
  user: null,
  isAuthenticated: false,
  authLoading: true,

  setUser: (user) => set({ user, isAuthenticated: true }),
  clearUser: () => set({ user: null, isAuthenticated: false }),

  authTokenError: null,

  initAuth: async () => {
    // Startup — there's no deep link being processed yet (that only
    // happens if/when onOpenUrl actually fires), so any authTokenError
    // left over from a previous session's failed verification attempt is
    // stale and must not carry forward into this one.
    set({ authLoading: true, authTokenError: null });
    try {
      const resolved = await resolveSession();
      if (!resolved) {
        set({ user: null, isAuthenticated: false });
        return;
      }
      const { me } = resolved;
      set({
        user: { id: me.user_id, email: me.email, tier: me.tier, callsRemaining: me.calls_remaining, resetAt: me.ai_calls_reset_at },
        isAuthenticated: true,
      });
    } catch (err) {
      console.error('Failed to resolve session:', err);
      set({ user: null, isAuthenticated: false });
    } finally {
      set({ authLoading: false });
    }
  },

  signOut: async () => {
    await signOutApi();
    set({ user: null, isAuthenticated: false });
  },

  // Re-fetches /auth/me and updates the user's tier/quota — used after a
  // Stripe checkout deep link comes back so the UI reflects the new tier
  // without a full app restart.
  refreshUserFromMe: async () => {
    const session = await loadSession();
    if (!session) return;
    try {
      const me = await getMe(session.access_token);
      set({
        user: { id: me.user_id, email: me.email, tier: me.tier, callsRemaining: me.calls_remaining, resetAt: me.ai_calls_reset_at },
      });
    } catch (err) {
      console.error('Failed to refresh user from /auth/me:', err);
    }
  },

  // Called from the pagedge://auth/confirm deep link once the user has
  // clicked the confirmation email — saves the tokens Supabase minted and
  // logs the user straight into the app. On failure (stale/expired/
  // already-used token), records it in authTokenError instead of the
  // console only — AuthModal surfaces this exclusively on the
  // verify-email screen, never on the signin/signup tabs.
  completeEmailVerification: async (accessToken, refreshToken) => {
    try {
      await saveSessionTokens(accessToken, refreshToken);
      const me = await getMe(accessToken);
      set({
        user: { id: me.user_id, email: me.email, tier: me.tier, callsRemaining: me.calls_remaining, resetAt: me.ai_calls_reset_at },
        isAuthenticated: true,
        authTokenError: null,
      });
    } catch (err) {
      console.error('Failed to complete email verification:', err);
      set({ authTokenError: err instanceof Error ? err.message : 'Invalid or expired token' });
    }
  },

  clearAuthTokenError: () => set({ authTokenError: null }),

  authPromptOpen: false,
  authPromptReason: null,
  authPromptOnSuccess: null,
  requireAuth: (reason, onSuccess) => set({ authPromptOpen: true, authPromptReason: reason ?? null, authPromptOnSuccess: onSuccess ?? null }),
  dismissAuthPrompt: () => set({ authPromptOpen: false, authPromptReason: null, authPromptOnSuccess: null }),

  // ── Paywall ───────────────────────────────────────────────────────────────────
  paywallOpen: false,
  paywallReason: null,
  showPaywall: (reason) => set({ paywallOpen: true, paywallReason: reason }),
  closePaywall: () => set({ paywallOpen: false, paywallReason: null }),

  // ── Email verification toast ─────────────────────────────────────────────────
  emailVerifyToastOpen: false,
  showEmailVerifyToast: () => set({ emailVerifyToastOpen: true }),
  dismissEmailVerifyToast: () => set({ emailVerifyToastOpen: false }),

  // ── PDFs ────────────────────────────────────────────────────────────────────
  pdfs: [],
  selectedPdfId: null,
  folders: [],

  addPdf: async (filepath: string): Promise<Pdf> => {
    const json = await invoke<string>("add_pdf", { filepath });
    const pdf: Pdf = JSON.parse(json);
    set((state) => {
      // Guard by both id AND filepath: old databases without the UNIQUE INDEX
      // may return two different UUIDs for the same file path before the startup
      // dedup migration has run, so checking only id is insufficient.
      if (state.pdfs.some((p) => p.id === pdf.id || p.filepath === pdf.filepath)) return state;
      return { pdfs: [...state.pdfs, pdf] };
    });
    // Content hashing runs in the background — never block the import UI on it.
    if (!pdf.content_hash) {
      invoke<string>("update_pdf_content_hash", { id: pdf.id, filepath: pdf.filepath })
        .then((hash) => {
          set((state) => ({ pdfs: state.pdfs.map((p) => (p.id === pdf.id ? { ...p, content_hash: hash } : p)) }));
          checkPendingImport(pdf.id, hash);
          retryPushIfPending(pdf.id);
        })
        .catch(console.error);
    } else {
      checkPendingImport(pdf.id, pdf.content_hash);
    }
    return pdf;
  },

  deletePdf: async (id: string) => {
    const pdf = useStore.getState().pdfs.find((p) => p.id === id);
    await invoke('delete_pdf', { id });
    clearPullCursor(pdf?.content_hash);
    set((state) => ({
      pdfs: state.pdfs.filter((p) => p.id !== id),
      selectedPdfId: state.selectedPdfId === id ? null : state.selectedPdfId,
    }));
  },

  renamePdf: async (id: string, filename: string) => {
    await invoke('rename_pdf', { id, filename });
    set((state) => ({
      pdfs: state.pdfs.map((p) => (p.id === id ? { ...p, filename } : p)),
    }));
  },

  updatePdfChunkCount: (pdfId: string, chunkCount: number) =>
    set((state) => ({
      pdfs: state.pdfs.map((p) =>
        p.id === pdfId ? { ...p, chunk_count: chunkCount } : p
      ),
    })),

  // ── Collections (folders) + Pinned ───────────────────────────────────────────
  loadFolders: async () => {
    const json = await invoke<string>("get_folders");
    const folders: Folder[] = JSON.parse(json);
    set({ folders });
  },

  createFolder: async (name: string, parentId: string | null) => {
    const json = await invoke<string>("create_folder", { name, parentId });
    const folder: Folder = JSON.parse(json);
    set((state) => ({ folders: [...state.folders, folder] }));
    return folder;
  },

  renameFolder: async (id: string, name: string) => {
    await invoke("rename_folder", { id, name });
    set((state) => ({
      folders: state.folders.map((f) => (f.id === id ? { ...f, name } : f)),
    }));
  },

  deleteFolder: async (id: string) => {
    await invoke("delete_folder", { id });
    set((state) => {
      // Mirror the Rust-side recursive delete: this folder and every
      // descendant are removed, and any pdf pointing at one of them is
      // un-assigned rather than deleted.
      const removedIds = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of state.folders) {
          if (f.parent_id && removedIds.has(f.parent_id) && !removedIds.has(f.id)) {
            removedIds.add(f.id);
            grew = true;
          }
        }
      }
      return {
        folders: state.folders.filter((f) => !removedIds.has(f.id)),
        pdfs: state.pdfs.map((p) =>
          p.folder_id && removedIds.has(p.folder_id) ? { ...p, folder_id: null } : p
        ),
      };
    });
  },

  reorderFolders: async (orderedIds: string[]) => {
    await invoke("reorder_folders", { orderedIds });
    set((state) => {
      const orderMap = new Map(orderedIds.map((id, index) => [id, index]));
      return {
        folders: state.folders.map((f) =>
          orderMap.has(f.id) ? { ...f, order_index: orderMap.get(f.id)! } : f
        ),
      };
    });
  },

  moveFolderToParent: async (folderId: string, parentId: string | null) => {
    await invoke("move_folder_to_parent", { folderId, parentId });
    set((state) => ({
      folders: state.folders.map((f) => (f.id === folderId ? { ...f, parent_id: parentId } : f)),
    }));
  },

  movePdfToFolder: async (pdfId: string, folderId: string | null) => {
    await invoke("move_pdf_to_folder", { pdfId, folderId });
    set((state) => ({
      pdfs: state.pdfs.map((p) => (p.id === pdfId ? { ...p, folder_id: folderId } : p)),
    }));
  },

  setPdfPinned: async (pdfId: string, pinned: boolean) => {
    await invoke("set_pdf_pinned", { pdfId, pinned });
    set((state) => ({
      pdfs: state.pdfs.map((p) => (p.id === pdfId ? { ...p, is_pinned: pinned } : p)),
    }));
  },

  setFolderPinned: async (folderId: string, pinned: boolean) => {
    await invoke("set_folder_pinned", { folderId, pinned });
    set((state) => ({
      folders: state.folders.map((f) => (f.id === folderId ? { ...f, is_pinned: pinned } : f)),
    }));
  },

  selectPdf: (id) => {
    set({ selectedPdfId: id, selectedNoteId: null, currentPage: 1, chatMessages: [], summaryContent: null, summaryLens: null, isSummarizing: false, drawings: [], drawMode: false, textBoxes: [], selectedTextBoxId: null, placingTextBox: false, editingTextBoxId: null, flashcards: [], activeTagFilter: null, suggestedTags: [], outline: [], outlineLoading: false, expandedOutlineIds: new Set(), isOutlineSectionExpanded: false, outlineAttempted: false, requestOutlineExtraction: null, graphViewOpen: false, deckManagerOpen: false });
    if (id) {
      const pdf = useStore.getState().pdfs.find((p) => p.id === id);
      if (pdf?.content_hash) pullPdf(pdf.content_hash).catch((err) => console.error('[sync] pull on open failed', err));
    }
  },

  loadPdfs: async () => {
    const json = await invoke<string>("get_pdfs");
    const pdfs: Pdf[] = JSON.parse(json);
    set({ pdfs });
    // Backfill content_hash for PDFs imported before the sync migration —
    // fire-and-forget, one background hash per unhashed row, never blocks load.
    for (const pdf of pdfs) {
      if (!pdf.content_hash) {
        invoke<string>("update_pdf_content_hash", { id: pdf.id, filepath: pdf.filepath })
          .then((hash) => {
            set((state) => ({ pdfs: state.pdfs.map((p) => (p.id === pdf.id ? { ...p, content_hash: hash } : p)) }));
            checkPendingImport(pdf.id, hash);
            retryPushIfPending(pdf.id);
          })
          .catch(console.error);
      }
    }
  },

  // ── Sync: cross-device annotations ───────────────────────────────────────────
  remoteOnlyPdfs: [],
  setRemoteOnlyPdfs: (pdfs) => set({ remoteOnlyPdfs: pdfs }),
  pendingImportPrompt: null,
  setPendingImportPrompt: (prompt) => set({ pendingImportPrompt: prompt }),
  clearPendingImportPrompt: () => set({ pendingImportPrompt: null }),

  // ── Highlights ───────────────────────────────────────────────────────────────
  highlights: [],
  activeLens: "default",

  loadHighlights: async (pdfId: string) => {
    const json = await invoke<string>("get_highlights", { pdfId });
    const highlights: Highlight[] = JSON.parse(json);
    set({ highlights });
  },

  addHighlight: (h: Highlight) => {
    set((state) => ({ highlights: [...state.highlights, h] }));
    schedulePush(h.pdf_id);
  },

  removeHighlight: (id: string) =>
    set((state) => {
      const removed = state.highlights.find((h) => h.id === id);
      if (removed) schedulePush(removed.pdf_id);
      return { highlights: state.highlights.filter((h) => h.id !== id) };
    }),

  setActiveLens: (lens: LensKey) => set({ activeLens: lens }),

  // ── Notes ────────────────────────────────────────────────────────────────────
  notes: [],
  selectedNoteId: null,
  currentPage: 1,
  jumpToPage: null,

  loadNotes: async (pdfId: string) => {
    const json = await invoke<string>("get_notes", { pdfId });
    const notes: Note[] = JSON.parse(json);
    set({ notes });
  },

  addNote: (note: Note) => {
    set((state) => ({ notes: [note, ...state.notes] }));
    if (note.source_pdf_id) schedulePush(note.source_pdf_id);
  },

  updateNote: (id: string, changes: Partial<Note>) =>
    set((state) => {
      const updated = state.notes.map((n) => (n.id === id ? { ...n, ...changes } : n));
      const note = updated.find((n) => n.id === id);
      if (note?.source_pdf_id) schedulePush(note.source_pdf_id);
      return { notes: updated };
    }),

  removeNote: (id: string) =>
    set((state) => {
      const removed = state.notes.find((n) => n.id === id);
      if (removed?.source_pdf_id) schedulePush(removed.source_pdf_id);
      return { notes: state.notes.filter((n) => n.id !== id) };
    }),

  setSelectedNoteId: (id) => set({ selectedNoteId: id }),

  setCurrentPage: (page) => set({ currentPage: page }),

  setJumpToPage: (fn) => set({ jumpToPage: fn }),

  // ── Panel visibility ─────────────────────────────────────────────────────────
  leftPanelOpen: true,
  rightPanelOpen: true,
  setLeftPanelOpen: (open) => set({ leftPanelOpen: open }),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

  // ── Ingestion ─────────────────────────────────────────────────────────────────
  ingestionStatus: {},
  isModelLoading: false,
  setIngestionStatus: (pdfId, status) =>
    set((state) => {
      const next = { ...state.ingestionStatus };
      if (status === null) {
        delete next[pdfId];
      } else {
        next[pdfId] = status;
      }
      return { ingestionStatus: next };
    }),
  setModelLoading: (loading) => set({ isModelLoading: loading }),

  // ── AI settings ───────────────────────────────────────────────────────────────
  aiProvider: 'ollama',
  aiModel: 'llama3.2',
  aiBaseUrl: 'http://localhost:11434/v1',
  aiApiKey: '',
  aiUseCustomProvider: false,

  setAiSettings: (s) => set((state) => ({ ...state, ...s })),

  loadAiSettings: async () => {
    try {
      const [provider, model, baseUrl, apiKey, useCustomProvider] = await Promise.all([
        invoke<string>('get_setting', { key: 'ai_provider' }),
        invoke<string>('get_setting', { key: 'ai_model' }),
        invoke<string>('get_setting', { key: 'ai_base_url' }),
        invoke<string>('get_setting', { key: 'ai_api_key' }),
        invoke<string>('get_setting', { key: 'ai_use_custom_provider' }),
      ]);
      set({
        aiProvider: provider || 'ollama',
        aiModel: model || 'llama3.2',
        aiBaseUrl: baseUrl || 'http://localhost:11434/v1',
        aiApiKey: apiKey || '',
        aiUseCustomProvider: useCustomProvider === 'true',
      });
    } catch (err) {
      console.error('Failed to load AI settings:', err);
    }
  },

  // ── Chat ──────────────────────────────────────────────────────────────────────
  chatMessages: [],
  addChatMessage: (msg) => set((state) => ({ chatMessages: [...state.chatMessages, msg] })),
  clearChat: () => set({ chatMessages: [] }),
  isAiLoading: false,
  setAiLoading: (loading) => set({ isAiLoading: loading }),

  // ── Settings panel ────────────────────────────────────────────────────────────
  settingsPanelOpen: false,
  setSettingsPanelOpen: (open) => set({ settingsPanelOpen: open }),

  // ── Feedback ──────────────────────────────────────────────────────────────────
  feedbackModalOpen: false,
  setFeedbackModalOpen: (open) => set({ feedbackModalOpen: open }),

  // ── Search ────────────────────────────────────────────────────────────────────
  searchModalOpen: false,
  setSearchModalOpen: (open) => set({ searchModalOpen: open }),

  // ── Graph view (knowledge map) ───────────────────────────────────────────────
  graphViewOpen: false,
  setGraphViewOpen: (open) => set(open ? { graphViewOpen: true, deckManagerOpen: false } : { graphViewOpen: false }),

  // ── Export ────────────────────────────────────────────────────────────────────
  exportDialogOpen: false,
  setExportDialogOpen: (open) => set({ exportDialogOpen: open }),
  pendingJumpPage: null,
  setPendingJumpPage: (page) => set({ pendingJumpPage: page }),

  // ── Summary ───────────────────────────────────────────────────────────────────
  summaryContent: null,
  summaryLens: null,
  isSummarizing: false,
  setSummary: (content, lens) => set({ summaryContent: content, summaryLens: lens }),
  clearSummary: () => set({ summaryContent: null, summaryLens: null, isSummarizing: false }),
  setIsSummarizing: (loading) => set({ isSummarizing: loading }),

  // ── Right panel ───────────────────────────────────────────────────────────────
  rightPanelTab: 'notes',
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  highlightFilter: 'all',
  setHighlightFilter: (filter) => set({ highlightFilter: filter }),
  flashHighlightId: null,
  setFlashHighlightId: (id) => set({ flashHighlightId: id }),

  // ── Drawings ─────────────────────────────────────────────────────────────────
  drawings: [],

  loadDrawings: async (pdfId: string) => {
    const json = await invoke<string>('get_drawings', { pdfId });
    const raw: any[] = JSON.parse(json);
    const drawings: Drawing[] = raw.map((d) => ({
      ...d,
      points: typeof d.points === 'string' ? JSON.parse(d.points) : d.points,
    }));
    set({ drawings });
  },

  addDrawing: (d: Drawing) => set((state) => ({ drawings: [...state.drawings, d] })),

  removeDrawing: (id: string) =>
    set((state) => ({ drawings: state.drawings.filter((d) => d.id !== id) })),

  // ── Draw mode ─────────────────────────────────────────────────────────────────
  drawMode: false,
  setDrawMode: (on: boolean) => set({ drawMode: on }),
  activeDrawTool: 'pen',
  setActiveDrawTool: (tool) => set({ activeDrawTool: tool, placingTextBox: tool === 'textbox' }),
  drawColor: '#ffffff',
  setDrawColor: (color) => set({ drawColor: color }),
  strokeWidth: 2,
  setStrokeWidth: (w) => set({ strokeWidth: w }),

  // ── Text boxes ────────────────────────────────────────────────────────────────
  textBoxes: [],

  loadTextBoxes: async (pdfId: string) => {
    const json = await invoke<string>('get_text_boxes', { pdfId });
    const textBoxes: TextBox[] = JSON.parse(json);
    set({ textBoxes });
  },

  addTextBox: (tb: TextBox) => set((state) => ({ textBoxes: [...state.textBoxes, tb] })),

  updateTextBoxLocal: (id: string, changes: Partial<TextBox>) =>
    set((state) => ({
      textBoxes: state.textBoxes.map((tb) => (tb.id === id ? { ...tb, ...changes } : tb)),
    })),

  removeTextBox: (id: string) =>
    set((state) => ({ textBoxes: state.textBoxes.filter((tb) => tb.id !== id) })),

  selectedTextBoxId: null,
  setSelectedTextBoxId: (id) => set({ selectedTextBoxId: id }),
  placingTextBox: false,
  setPlacingTextBox: (on) => set({ placingTextBox: on }),
  editingTextBoxId: null,
  setEditingTextBoxId: (id) => set({ editingTextBoxId: id }),

  // ── Flashcards ───────────────────────────────────────────────────────────────
  flashcards: [],

  loadFlashcards: async (pdfId: string) => {
    const json = await invoke<string>('get_flashcards', { pdfId });
    set({ flashcards: JSON.parse(json) });
  },

  addFlashcard: (f: Flashcard) => {
    // allCards is replaced wholesale by loadAllCards when the Deck Manager
    // opens, so appending here just keeps an already-loaded list live.
    set((state) => ({
      flashcards: [...state.flashcards, f],
      allCards: [...state.allCards, f],
    }));
    // Custom cards have no pdf_id and live outside the per-PDF sync contract.
    if (f.pdf_id) schedulePush(f.pdf_id);
  },

  removeFlashcard: (id: string) =>
    set((state) => {
      const removed = state.flashcards.find((f) => f.id === id) ?? state.allCards.find((f) => f.id === id);
      if (removed?.pdf_id) schedulePush(removed.pdf_id);
      return {
        flashcards: state.flashcards.filter((f) => f.id !== id),
        allCards: state.allCards.filter((f) => f.id !== id),
      };
    }),

  updateFlashcardLocal: (id: string, changes: Partial<Flashcard>) =>
    set((state) => {
      const patch = (list: Flashcard[]) => list.map((f) => (f.id === id ? { ...f, ...changes } : f));
      const updated = patch(state.flashcards);
      const allCards = patch(state.allCards);
      const card = updated.find((f) => f.id === id) ?? allCards.find((f) => f.id === id);
      // Deck moves are local-only metadata — only content/confidence changes push.
      const contentChanged = Object.keys(changes).some((k) => k !== 'deck_id');
      if (card?.pdf_id && contentChanged) schedulePush(card.pdf_id);
      // Also patch the review-session copies so the mastery counter and the
      // low-confidence filter reflect grades made mid-session.
      return { flashcards: updated, allCards, reviewDeck: patch(state.reviewDeck), reviewQueue: patch(state.reviewQueue) };
    }),

  reviewDeck: [],
  reviewQueue: [],
  reviewFilter: 'all',
  // Re-derives the session queue from the full deck; switching filters
  // restarts the session at the first matching card.
  setReviewFilter: (f) =>
    set((state) => ({
      reviewFilter: f,
      reviewQueue: f === 'low' ? state.reviewDeck.filter((c) => c.confidence_level <= 1) : state.reviewDeck,
      currentReviewIndex: 0,
    })),
  currentReviewIndex: 0,
  reviewModeOpen: false,
  setReviewModeOpen: (open) => set({ reviewModeOpen: open }),

  startReview: (deck) =>
    set({ reviewDeck: deck, reviewQueue: deck, reviewFilter: 'all', currentReviewIndex: 0, reviewModeOpen: true }),

  advanceReview: () => set((state) => ({ currentReviewIndex: state.currentReviewIndex + 1 })),

  isGeneratingFlashcards: false,
  setIsGeneratingFlashcards: (b) => set({ isGeneratingFlashcards: b }),
  generationProgress: null,
  setGenerationProgress: (p) => set({ generationProgress: p }),

  // ── Deck Manager ──────────────────────────────────────────────────────────
  deckManagerOpen: false,
  setDeckManagerOpen: (open) => set(open ? { deckManagerOpen: true, graphViewOpen: false } : { deckManagerOpen: false }),

  decks: [],
  loadDecks: async () => {
    const json = await invoke<string>('get_decks');
    set({ decks: JSON.parse(json) });
  },
  createDeck: async (name: string) => {
    const json = await invoke<string>('create_deck', { name });
    const deck: Deck = JSON.parse(json);
    set((state) => ({ decks: [...state.decks, deck] }));
    return deck;
  },
  renameDeck: async (id: string, name: string) => {
    const json = await invoke<string>('rename_deck', { id, name });
    const deck: Deck = JSON.parse(json);
    set((state) => ({ decks: state.decks.map((d) => (d.id === id ? deck : d)) }));
  },
  deleteDeck: async (id: string) => {
    await invoke('delete_deck', { id });
    // The Rust side un-files the deck's cards (deck_id → NULL); mirror that.
    set((state) => ({
      decks: state.decks.filter((d) => d.id !== id),
      allCards: state.allCards.map((f) => (f.deck_id === id ? { ...f, deck_id: null } : f)),
      flashcards: state.flashcards.map((f) => (f.deck_id === id ? { ...f, deck_id: null } : f)),
    }));
  },

  allCards: [],
  loadAllCards: async () => {
    const json = await invoke<string>('get_all_flashcards');
    set({ allCards: JSON.parse(json) });
  },

  // ── Tags ──────────────────────────────────────────────────────────────────────
  suggestedTags: [],
  setSuggestedTags: (tags) => set({ suggestedTags: tags }),
  clearSuggestedTags: () => set({ suggestedTags: [] }),
  isSuggestingTags: false,
  setIsSuggestingTags: (b) => set({ isSuggestingTags: b }),
  activeTagFilter: null,
  setActiveTagFilter: (tag) => set({ activeTagFilter: tag }),

  // ── Outline ───────────────────────────────────────────────────────────────────
  outline: [],
  setOutline: (items) => set({ outline: items }),

  loadOutline: async (pdfId: string) => {
    const json = await invoke<string>('get_outline', { pdfId });
    const outline: OutlineItem[] = JSON.parse(json);
    set({ outline });
  },

  outlineLoading: false,
  setOutlineLoading: (loading) => set({ outlineLoading: loading }),

  expandedOutlineIds: new Set(),
  toggleOutlineExpanded: (id) =>
    set((state) => {
      const next = new Set(state.expandedOutlineIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedOutlineIds: next };
    }),

  isOutlineSectionExpanded: false,
  setOutlineSectionExpanded: (expanded) => set({ isOutlineSectionExpanded: expanded }),
  outlineAttempted: false,
  setOutlineAttempted: (attempted) => set({ outlineAttempted: attempted }),
  requestOutlineExtraction: null,
  setRequestOutlineExtraction: (fn) => set({ requestOutlineExtraction: fn }),
}));

// Checks pending_pdf_annotations for a newly-hashed PDF and, if another
// device has already synced highlights/notes/flashcards for the same
// content_hash, surfaces the import prompt. Fire-and-forget — called right
// after add_pdf/loadPdfs resolve a content_hash, never blocks the caller.
function checkPendingImport(pdfId: string, contentHash: string): void {
  checkPendingAnnotationsForHash(contentHash)
    .then((pending) => {
      if (!pending) return;
      if (!pending.highlight_count && !pending.note_count && !pending.flashcard_count) return;
      useStore.getState().setPendingImportPrompt({
        pdfId,
        contentHash,
        displayName: pending.pdf_display_name,
        highlightCount: pending.highlight_count,
        noteCount: pending.note_count,
        flashcardCount: pending.flashcard_count,
      });
    })
    .catch((err) => console.error('[sync] pending import check failed', err));
}
