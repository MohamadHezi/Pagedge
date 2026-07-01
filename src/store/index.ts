import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Pdf, Folder, Highlight, LensKey, Note, IngestionStatus, ChatMessage, Drawing, DrawToolType, TextBox, Flashcard, OutlineItem } from "../types";
import type { HighlightColorKey } from "../constants/highlights";
import { resolveSession, signOut as signOutApi, loadSession, getMe, saveSessionTokens } from "../services/authService";

export interface AuthUser {
  id: string;
  email: string;
  tier: 'free' | 'pro';
  callsRemaining: number | null;
  resetAt: string | null;
}

export type PaywallReason = 'context_too_large' | 'quota_exceeded';

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

  // ── Search ────────────────────────────────────────────────────────────────────
  searchModalOpen: boolean;
  setSearchModalOpen: (open: boolean) => void;

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
  reviewQueue: Flashcard[];
  currentReviewIndex: number;
  reviewModeOpen: boolean;
  setReviewModeOpen: (open: boolean) => void;
  startReview: (queue: Flashcard[]) => void;
  advanceReview: () => void;
  isGeneratingFlashcards: boolean;
  setIsGeneratingFlashcards: (b: boolean) => void;
  generationProgress: { done: number; total: number } | null;
  setGenerationProgress: (p: { done: number; total: number } | null) => void;

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
    return pdf;
  },

  deletePdf: async (id: string) => {
    await invoke('delete_pdf', { id });
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

  selectPdf: (id) => set({ selectedPdfId: id, selectedNoteId: null, currentPage: 1, chatMessages: [], summaryContent: null, summaryLens: null, isSummarizing: false, drawings: [], drawMode: false, textBoxes: [], selectedTextBoxId: null, placingTextBox: false, editingTextBoxId: null, flashcards: [], activeTagFilter: null, suggestedTags: [], outline: [], outlineLoading: false, expandedOutlineIds: new Set(), isOutlineSectionExpanded: false, outlineAttempted: false, requestOutlineExtraction: null }),

  loadPdfs: async () => {
    const json = await invoke<string>("get_pdfs");
    const pdfs: Pdf[] = JSON.parse(json);
    set({ pdfs });
  },

  // ── Highlights ───────────────────────────────────────────────────────────────
  highlights: [],
  activeLens: "default",

  loadHighlights: async (pdfId: string) => {
    const json = await invoke<string>("get_highlights", { pdfId });
    const highlights: Highlight[] = JSON.parse(json);
    set({ highlights });
  },

  addHighlight: (h: Highlight) =>
    set((state) => ({ highlights: [...state.highlights, h] })),

  removeHighlight: (id: string) =>
    set((state) => ({ highlights: state.highlights.filter((h) => h.id !== id) })),

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

  addNote: (note: Note) =>
    set((state) => ({ notes: [note, ...state.notes] })),

  updateNote: (id: string, changes: Partial<Note>) =>
    set((state) => ({
      notes: state.notes.map((n) => (n.id === id ? { ...n, ...changes } : n)),
    })),

  removeNote: (id: string) =>
    set((state) => ({ notes: state.notes.filter((n) => n.id !== id) })),

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

  // ── Search ────────────────────────────────────────────────────────────────────
  searchModalOpen: false,
  setSearchModalOpen: (open) => set({ searchModalOpen: open }),

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

  addFlashcard: (f: Flashcard) =>
    set((state) => ({ flashcards: [...state.flashcards, f] })),

  removeFlashcard: (id: string) =>
    set((state) => ({ flashcards: state.flashcards.filter((f) => f.id !== id) })),

  updateFlashcardLocal: (id: string, changes: Partial<Flashcard>) =>
    set((state) => ({
      flashcards: state.flashcards.map((f) => (f.id === id ? { ...f, ...changes } : f)),
    })),

  reviewQueue: [],
  currentReviewIndex: 0,
  reviewModeOpen: false,
  setReviewModeOpen: (open) => set({ reviewModeOpen: open }),

  startReview: (queue) => set({ reviewQueue: queue, currentReviewIndex: 0, reviewModeOpen: true }),

  advanceReview: () => set((state) => ({ currentReviewIndex: state.currentReviewIndex + 1 })),

  isGeneratingFlashcards: false,
  setIsGeneratingFlashcards: (b) => set({ isGeneratingFlashcards: b }),
  generationProgress: null,
  setGenerationProgress: (p) => set({ generationProgress: p }),

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
