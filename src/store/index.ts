import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Pdf, Folder, Highlight, LensKey, Note, IngestionStatus, ChatMessage, GlobalChatMessage, Drawing, DrawToolType, TextBox, Flashcard, Deck, ReviewFilter, OutlineItem, SketchStroke, SettingsTab } from "../types";
import type { HighlightColorKey } from "../constants/highlights";
import { resolveSession, signOut as signOutApi, loadSession, getMe, saveSessionTokens } from "../services/authService";
import { schedulePush, pullPdf, checkPendingAnnotationsForHash, retryPushIfPending, clearPullCursor } from "../services/syncService";

// ── Split view (pane B) ──────────────────────────────────────────────────────
// Pane A is intentionally left as-is: every existing flat "current document"
// field (highlights, notes, drawings, textBoxes, flashcards, chatMessages,
// outline, currentPage, jumpToPage, etc.) IS pane A's state, unchanged, so
// every existing consumer of those fields keeps working with zero changes
// as long as pane B is never opened. Pane B is purely additive: a second,
// parallel slice with its own copies of the same per-document fields, plus
// a "B-flavored" action for each existing pane-A action. PdfViewer/RightPanel
// pick which flavor to bind to based on which pane they represent — see
// PdfViewer's `paneId` prop. This keeps single-pane mode's behavior
// byte-for-byte identical (the whole point of doing this incrementally)
// while still giving pane B a fully independent, non-clobbering set of
// per-document state to render from.
//
// AI-overlay results (Summarize/Study Guide/Compare/tag-suggest) are
// deliberately NOT duplicated per pane — they stay single global overlays as
// today. Triggering one of those from pane B while pane A also has a result
// showing will share the same overlay, exactly like today's single-pane
// behavior. This is a scoped-down trim from the original plan: the live
// viewing/annotation experience (scrolling, highlighting, drawing, notes,
// chat, outline) is fully pane-isolated; the occasional one-shot AI-summary
// overlays are not, since duplicating them adds a lot of surface for a
// low-frequency, non-simultaneous interaction.
export interface PaneBState {
  pdfId: string;
  currentPage: number;
  pendingJumpPage: number | null;
  jumpToPage: ((page: number) => void) | null;
  highlights: Highlight[];
  activeLens: LensKey;
  notes: Note[];
  selectedNoteId: string | null;
  drawings: Drawing[];
  drawMode: boolean;
  textBoxes: TextBox[];
  selectedTextBoxId: string | null;
  placingTextBox: boolean;
  editingTextBoxId: string | null;
  flashcards: Flashcard[];
  chatMessages: ChatMessage[];
  isAiLoading: boolean;
  outline: OutlineItem[];
  outlineLoading: boolean;
  expandedOutlineIds: Set<string>;
  isOutlineSectionExpanded: boolean;
  outlineAttempted: boolean;
  requestOutlineExtraction: (() => void) | null;
}

function emptyPaneB(pdfId: string): PaneBState {
  return {
    pdfId,
    currentPage: 1,
    pendingJumpPage: null,
    jumpToPage: null,
    highlights: [],
    activeLens: "default",
    notes: [],
    selectedNoteId: null,
    drawings: [],
    drawMode: false,
    textBoxes: [],
    selectedTextBoxId: null,
    placingTextBox: false,
    editingTextBoxId: null,
    flashcards: [],
    chatMessages: [],
    isAiLoading: false,
    outline: [],
    outlineLoading: false,
    expandedOutlineIds: new Set(),
    isOutlineSectionExpanded: false,
    outlineAttempted: false,
    requestOutlineExtraction: null,
  };
}

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

export type PaywallReason = 'context_too_large' | 'quota_exceeded' | 'sync_requires_pro' | 'study_guide_requires_pro' | 'compare_requires_pro' | 'custom_provider_requires_pro';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

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

  // Token from a pagedge://auth/reset deep link (Supabase password-recovery
  // redirect). Non-null forces AuthModal into its reset-password screen,
  // mirroring how authTokenError forces the verify-email screen. Cleared
  // once the reset succeeds or the modal is dismissed.
  passwordResetToken: string | null;
  setPasswordResetToken: (token: string | null) => void;

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
  permanentlyDeletePdf: (id: string) => Promise<void>;
  renamePdf: (id: string, filename: string) => Promise<void>;
  selectPdf: (id: string | null) => void;
  loadPdfs: () => Promise<void>;
  updatePdfChunkCount: (pdfId: string, chunkCount: number) => void;
  updatePdfLastPage: (pdfId: string, page: number) => void;

  // ── Trash (soft-delete) ──────────────────────────────────────────────────────
  trashedPdfs: Pdf[];
  loadTrashedPdfs: () => Promise<void>;
  trashPdf: (id: string) => Promise<void>;
  restorePdf: (id: string) => Promise<void>;

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

  // Best-effort backup status shown in Settings — not a source of truth for
  // sync correctness (pushPdf/pullPdf own that), just a friendly indicator
  // so free users see what they're missing and Pro users see it's working.
  syncStatus: SyncStatus;
  setSyncStatus: (status: SyncStatus) => void;
  lastSyncedAt: string | null;
  setLastSyncedAt: (t: string | null) => void;
  loadLastSyncedAt: () => Promise<void>;

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
  // Per-pdf OCR page progress — mirrors generationProgress's {done,total}
  // shape. Only populated while ingestionStatus[pdfId] === 'ocr'.
  ocrProgress: Record<string, { done: number; total: number }>;
  setOcrProgress: (pdfId: string, progress: { done: number; total: number } | null) => void;

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

  // ── UI / editor preferences ───────────────────────────────────────────────────
  editorFontSize: number;
  editorLineWrap: boolean;
  setUiPrefs: (p: Partial<{ editorFontSize: number; editorLineWrap: boolean }>) => void;
  loadUiPrefs: () => Promise<void>;

  // ── Chat ──────────────────────────────────────────────────────────────────────
  chatMessages: ChatMessage[];
  loadChatMessages: (pdfId: string) => Promise<void>;
  addChatMessage: (msg: ChatMessage) => void;
  clearChat: () => void;
  isAiLoading: boolean;
  setAiLoading: (loading: boolean) => void;

  // ── Global Chat (cross-library) ─────────────────────────────────────────────
  // Separate from chatMessages above (per-PDF, RightPanel's "Chat with PDF"
  // tab). Joins the graphViewOpen/deckManagerOpen mutual-exclusion set.
  globalChatOpen: boolean;
  setGlobalChatOpen: (open: boolean) => void;
  globalChatMessages: GlobalChatMessage[];
  addGlobalChatMessage: (msg: GlobalChatMessage) => void;
  clearGlobalChat: () => void;
  isGlobalChatLoading: boolean;
  setGlobalChatLoading: (loading: boolean) => void;

  // ── Settings panel ────────────────────────────────────────────────────────────
  settingsPanelOpen: boolean;
  settingsInitialTab: SettingsTab;
  setSettingsPanelOpen: (open: boolean, tab?: SettingsTab) => void;

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
  // Which pdfId to export — ExportDialog is a single shared overlay, and with
  // split view active either pane's toolbar can open it, so the pdfId must
  // be captured explicitly at open time rather than assumed to be pane A's
  // selectedPdfId.
  exportDialogPdfId: string | null;
  setExportDialogOpen: (open: boolean, pdfId?: string) => void;
  pendingJumpPage: number | null;
  setPendingJumpPage: (page: number | null) => void;

  // ── Summary ───────────────────────────────────────────────────────────────────
  summaryContent: string | null;
  summaryLens: LensKey | null;
  // Which pdfId this summary belongs to — these AI-overlay results are
  // deliberately NOT duplicated per pane (see PaneBState's design note), but
  // "save as note" still needs to attribute the note to the pane that
  // actually generated it rather than always assuming pane A.
  summaryPdfId: string | null;
  isSummarizing: boolean;
  setSummary: (content: string | null, lens: LensKey | null, pdfId?: string) => void;
  clearSummary: () => void;
  setIsSummarizing: (loading: boolean) => void;

  // ── Study guide (Pro) ────────────────────────────────────────────────────────
  studyGuideContent: string | null;
  studyGuidePdfId: string | null;
  isGeneratingStudyGuide: boolean;
  setStudyGuide: (content: string | null, pdfId?: string) => void;
  clearStudyGuide: () => void;
  setIsGeneratingStudyGuide: (loading: boolean) => void;

  // ── Cross-document compare (Pro) ─────────────────────────────────────────────
  comparePickerOpen: boolean;
  setComparePickerOpen: (open: boolean) => void;
  compareTargetPdfId: string | null;
  // Which pdfId is "document A" of this comparison (the pane that opened
  // the picker) — same reasoning as summaryPdfId/studyGuidePdfId above.
  comparePdfId: string | null;
  compareContent: string | null;
  isComparing: boolean;
  setCompareResult: (targetPdfId: string | null, content: string | null, sourcePdfId?: string) => void;
  clearCompare: () => void;
  setIsComparing: (loading: boolean) => void;

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

  // ── Trash view ────────────────────────────────────────────────────────────
  // Replaces the center panel with the Trash dashboard when true. Joins the
  // graphViewOpen/deckManagerOpen/globalChatOpen mutual-exclusion set.
  // selectPdf always resets it.
  trashViewOpen: boolean;
  setTrashViewOpen: (open: boolean) => void;
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

  // ── Note Workspace (standalone notes) ────────────────────────────────────
  // Replaces the center panel with the full-page standalone-note workspace
  // when true. Joins the graphViewOpen/deckManagerOpen/globalChatOpen/
  // trashViewOpen mutual-exclusion set. selectPdf always resets it.
  noteWorkspaceOpen: boolean;
  setNoteWorkspaceOpen: (open: boolean) => void;
  openStandaloneNote: (noteId: string) => void;
  // Whole-library standalone-note list (source_pdf_id === null), analogous
  // to allCards for flashcards — the per-PDF `notes` array only ever holds
  // the open PDF's notes.
  standaloneNotes: Note[];
  loadStandaloneNotes: () => Promise<void>;
  createStandaloneNote: () => Promise<Note>;
  updateStandaloneNoteLocal: (id: string, changes: Partial<Note>) => void;
  removeStandaloneNoteLocal: (id: string) => void;

  // ── Cross-surface drawing clipboard ──────────────────────────────────────
  // Canonical intermediate format for copy/paste between the PDF-page
  // drawing layer (PdfViewer, PDF-point-space) and a note's sketch canvas
  // (canvas-pixel-space) is always SketchStroke — PdfViewer converts to/from
  // Drawing at its own copy/paste boundary.
  drawingClipboard: SketchStroke[];
  setDrawingClipboard: (strokes: SketchStroke[]) => void;

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

  // ── Split view (pane B) — see PaneBState comment above for the design note ──
  focusedPane: 'A' | 'B';
  focusPane: (paneId: 'A' | 'B') => void;
  paneB: PaneBState | null;
  openPaneB: (pdfId: string) => void;
  closePaneB: () => void;
  // Closing pane A while pane B is open: pane B's state moves into pane A's
  // slot rather than pane A just vanishing, so "pane A" stays the always-
  // present slot and the UI collapses cleanly to single-pane mode.
  promoteBToA: () => void;

  selectPdfB: (id: string) => void;

  loadHighlightsB: (pdfId: string) => Promise<void>;
  addHighlightB: (h: Highlight) => void;
  removeHighlightB: (id: string) => void;
  setActiveLensB: (lens: LensKey) => void;

  loadNotesB: (pdfId: string) => Promise<void>;
  addNoteB: (note: Note) => void;
  updateNoteB: (id: string, changes: Partial<Note>) => void;
  removeNoteB: (id: string) => void;
  setSelectedNoteIdB: (id: string | null) => void;
  setCurrentPageB: (page: number) => void;
  setJumpToPageB: (fn: ((page: number) => void) | null) => void;
  setPendingJumpPageB: (page: number | null) => void;

  loadDrawingsB: (pdfId: string) => Promise<void>;
  addDrawingB: (d: Drawing) => void;
  removeDrawingB: (id: string) => void;
  setDrawModeB: (on: boolean) => void;

  loadTextBoxesB: (pdfId: string) => Promise<void>;
  addTextBoxB: (tb: TextBox) => void;
  updateTextBoxLocalB: (id: string, changes: Partial<TextBox>) => void;
  removeTextBoxB: (id: string) => void;
  setSelectedTextBoxIdB: (id: string | null) => void;
  setPlacingTextBoxB: (on: boolean) => void;
  setEditingTextBoxIdB: (id: string | null) => void;

  loadFlashcardsB: (pdfId: string) => Promise<void>;
  addFlashcardB: (f: Flashcard) => void;
  removeFlashcardB: (id: string) => void;
  updateFlashcardLocalB: (id: string, changes: Partial<Flashcard>) => void;

  loadChatMessagesB: (pdfId: string) => Promise<void>;
  addChatMessageB: (msg: ChatMessage) => void;
  clearChatB: () => void;
  setAiLoadingB: (loading: boolean) => void;

  setOutlineB: (items: OutlineItem[]) => void;
  loadOutlineB: (pdfId: string) => Promise<void>;
  setOutlineLoadingB: (loading: boolean) => void;
  toggleOutlineExpandedB: (id: string) => void;
  setOutlineSectionExpandedB: (expanded: boolean) => void;
  setOutlineAttemptedB: (attempted: boolean) => void;
  setRequestOutlineExtractionB: (fn: (() => void) | null) => void;
}

export const useStore = create<AppState>((set, get) => ({
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

  passwordResetToken: null,
  setPasswordResetToken: (token) => set({ passwordResetToken: token }),

  authPromptOpen: false,
  authPromptReason: null,
  authPromptOnSuccess: null,
  requireAuth: (reason, onSuccess) => set({ authPromptOpen: true, authPromptReason: reason ?? null, authPromptOnSuccess: onSuccess ?? null }),
  dismissAuthPrompt: () => set({ authPromptOpen: false, authPromptReason: null, authPromptOnSuccess: null, passwordResetToken: null }),

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
  trashedPdfs: [],

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

  permanentlyDeletePdf: async (id: string) => {
    const pdf = useStore.getState().pdfs.find((p) => p.id === id);
    await invoke('delete_pdf', { id });
    clearPullCursor(pdf?.content_hash);
    set((state) => ({
      pdfs: state.pdfs.filter((p) => p.id !== id),
      trashedPdfs: state.trashedPdfs.filter((p) => p.id !== id),
      selectedPdfId: state.selectedPdfId === id ? null : state.selectedPdfId,
      // A deleted PDF can't stay "open" in pane B either — leaving paneB
      // pointing at a now-gone pdfId would strand the tab bar (paneBPdf
      // lookup fails, so the second tab silently disappears but paneB
      // itself never gets nulled, blocking both the "+" button and any
      // future openPaneB call).
      paneB: state.paneB?.pdfId === id ? null : state.paneB,
      focusedPane: state.paneB?.pdfId === id && state.focusedPane === 'B' ? 'A' : state.focusedPane,
    }));
  },

  loadTrashedPdfs: async () => {
    const json = await invoke<string>("get_trashed_pdfs");
    set({ trashedPdfs: JSON.parse(json) });
  },

  trashPdf: async (id: string) => {
    await invoke('trash_pdf', { id });
    set((state) => ({
      pdfs: state.pdfs.filter((p) => p.id !== id),
      selectedPdfId: state.selectedPdfId === id ? null : state.selectedPdfId,
      paneB: state.paneB?.pdfId === id ? null : state.paneB,
      focusedPane: state.paneB?.pdfId === id && state.focusedPane === 'B' ? 'A' : state.focusedPane,
    }));
  },

  restorePdf: async (id: string) => {
    await invoke('restore_pdf', { id });
    set((state) => ({ trashedPdfs: state.trashedPdfs.filter((p) => p.id !== id) }));
    await useStore.getState().loadPdfs();
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

  updatePdfLastPage: (pdfId: string, page: number) =>
    set((state) => ({
      pdfs: state.pdfs.map((p) =>
        p.id === pdfId ? { ...p, last_page: page } : p
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
    // If this document is already open in pane B, just focus that pane
    // instead of opening a second, redundant copy in pane A — the same pdf
    // open in both panes isn't useful and would create ambiguity over which
    // pane "owns" highlight/note events for it.
    if (id && useStore.getState().paneB?.pdfId === id) {
      useStore.getState().focusPane('B');
      return;
    }

    // If a caller (search, flashcard/graph "jump to source", etc.) already
    // requested a specific page via setPendingJumpPage right before calling
    // selectPdf, that request wins. Otherwise, resume wherever this PDF was
    // last scrolled to instead of always restarting at page 1.
    const prevPending = useStore.getState().pendingJumpPage;
    const pdf = id ? useStore.getState().pdfs.find((p) => p.id === id) : null;
    const resumePage = prevPending ?? (pdf && pdf.last_page > 1 ? pdf.last_page : null);
    set({ selectedPdfId: id, selectedNoteId: null, currentPage: 1, pendingJumpPage: resumePage, chatMessages: [], summaryContent: null, summaryLens: null, summaryPdfId: null, isSummarizing: false, studyGuideContent: null, studyGuidePdfId: null, isGeneratingStudyGuide: false, comparePickerOpen: false, compareTargetPdfId: null, comparePdfId: null, compareContent: null, isComparing: false, drawings: [], drawMode: false, textBoxes: [], selectedTextBoxId: null, placingTextBox: false, editingTextBoxId: null, flashcards: [], activeTagFilter: null, suggestedTags: [], outline: [], outlineLoading: false, expandedOutlineIds: new Set(), isOutlineSectionExpanded: false, outlineAttempted: false, requestOutlineExtraction: null, graphViewOpen: false, deckManagerOpen: false, globalChatOpen: false, trashViewOpen: false, noteWorkspaceOpen: false, focusedPane: 'A' });
    if (id) {
      if (pdf?.content_hash) pullPdf(pdf.content_hash).catch((err) => console.error('[sync] pull on open failed', err));
      useStore.getState().loadChatMessages(id).catch((err) => console.error('[chat] failed to load history', err));
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

  syncStatus: 'idle',
  setSyncStatus: (status) => set({ syncStatus: status }),
  lastSyncedAt: null,
  setLastSyncedAt: (t) => set({ lastSyncedAt: t }),
  loadLastSyncedAt: async () => {
    const v = await invoke<string>('get_setting', { key: 'sync_last_synced_at' }).catch(() => '');
    if (v) set({ lastSyncedAt: v });
  },

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

  ocrProgress: {},
  setOcrProgress: (pdfId, progress) =>
    set((state) => {
      const next = { ...state.ocrProgress };
      if (progress === null) {
        delete next[pdfId];
      } else {
        next[pdfId] = progress;
      }
      return { ocrProgress: next };
    }),

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

  // ── UI / editor preferences ───────────────────────────────────────────────────
  editorFontSize: 13,
  editorLineWrap: true,

  setUiPrefs: (p) => set((state) => ({ ...state, ...p })),

  loadUiPrefs: async () => {
    try {
      const [fontSize, lineWrap] = await Promise.all([
        invoke<string>('get_setting', { key: 'editor_font_size' }),
        invoke<string>('get_setting', { key: 'editor_line_wrap' }),
      ]);
      const parsedFontSize = fontSize ? Number(fontSize) : 13;
      const nextFontSize = Number.isFinite(parsedFontSize) ? parsedFontSize : 13;
      const nextWrap = lineWrap === '' || lineWrap == null ? true : lineWrap === 'true';
      set({ editorFontSize: nextFontSize, editorLineWrap: nextWrap });
      document.documentElement.style.setProperty('--note-font-size', `${nextFontSize}px`);
    } catch (err) {
      console.error('Failed to load UI preferences:', err);
    }
  },

  // ── Chat ──────────────────────────────────────────────────────────────────────
  chatMessages: [],
  loadChatMessages: async (pdfId: string) => {
    const json = await invoke<string>("get_chat_messages", { pdfId });
    const rows: { id: string; role: 'user' | 'assistant'; content: string; created_at: string }[] = JSON.parse(json);
    const chatMessages: ChatMessage[] = rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      timestamp: Date.parse(r.created_at),
    }));
    set({ chatMessages });
  },
  addChatMessage: (msg) => {
    set((state) => ({ chatMessages: [...state.chatMessages, msg] }));
    const pdfId = useStore.getState().selectedPdfId;
    if (pdfId) {
      invoke("add_chat_message", { pdfId, id: msg.id, role: msg.role, content: msg.content })
        .catch((err) => console.error('[chat] failed to persist message', err));
    }
  },
  clearChat: () => {
    const pdfId = useStore.getState().selectedPdfId;
    set({ chatMessages: [] });
    if (pdfId) {
      invoke("clear_chat_messages", { pdfId }).catch((err) => console.error('[chat] failed to clear history', err));
    }
  },
  isAiLoading: false,
  setAiLoading: (loading) => set({ isAiLoading: loading }),

  globalChatOpen: false,
  setGlobalChatOpen: (open) =>
    set(open ? { globalChatOpen: true, graphViewOpen: false, deckManagerOpen: false, trashViewOpen: false, noteWorkspaceOpen: false } : { globalChatOpen: false }),
  globalChatMessages: [],
  addGlobalChatMessage: (msg) => set((state) => ({ globalChatMessages: [...state.globalChatMessages, msg] })),
  clearGlobalChat: () => set({ globalChatMessages: [] }),
  isGlobalChatLoading: false,
  setGlobalChatLoading: (loading) => set({ isGlobalChatLoading: loading }),

  // ── Settings panel ────────────────────────────────────────────────────────────
  settingsPanelOpen: false,
  settingsInitialTab: 'account',
  setSettingsPanelOpen: (open, tab) => set((state) => ({
    settingsPanelOpen: open,
    settingsInitialTab: tab ?? state.settingsInitialTab,
  })),

  // ── Feedback ──────────────────────────────────────────────────────────────────
  feedbackModalOpen: false,
  setFeedbackModalOpen: (open) => set({ feedbackModalOpen: open }),

  // ── Search ────────────────────────────────────────────────────────────────────
  searchModalOpen: false,
  setSearchModalOpen: (open) => set({ searchModalOpen: open }),

  // ── Graph view (knowledge map) ───────────────────────────────────────────────
  graphViewOpen: false,
  setGraphViewOpen: (open) => set(open ? { graphViewOpen: true, deckManagerOpen: false, globalChatOpen: false, trashViewOpen: false, noteWorkspaceOpen: false } : { graphViewOpen: false }),

  // ── Export ────────────────────────────────────────────────────────────────────
  exportDialogOpen: false,
  exportDialogPdfId: null,
  setExportDialogOpen: (open, pdfId) =>
    set((state) => ({
      exportDialogOpen: open,
      exportDialogPdfId: open ? (pdfId ?? state.selectedPdfId) : state.exportDialogPdfId,
    })),
  pendingJumpPage: null,
  setPendingJumpPage: (page) => set({ pendingJumpPage: page }),

  // ── Summary ───────────────────────────────────────────────────────────────────
  summaryContent: null,
  summaryLens: null,
  summaryPdfId: null,
  isSummarizing: false,
  setSummary: (content, lens, pdfId) =>
    set((state) => ({ summaryContent: content, summaryLens: lens, summaryPdfId: pdfId ?? state.summaryPdfId })),
  clearSummary: () => set({ summaryContent: null, summaryLens: null, summaryPdfId: null, isSummarizing: false }),
  setIsSummarizing: (loading) => set({ isSummarizing: loading }),

  studyGuideContent: null,
  studyGuidePdfId: null,
  isGeneratingStudyGuide: false,
  setStudyGuide: (content, pdfId) =>
    set((state) => ({ studyGuideContent: content, studyGuidePdfId: pdfId ?? state.studyGuidePdfId })),
  clearStudyGuide: () => set({ studyGuideContent: null, studyGuidePdfId: null, isGeneratingStudyGuide: false }),
  setIsGeneratingStudyGuide: (loading) => set({ isGeneratingStudyGuide: loading }),

  comparePickerOpen: false,
  setComparePickerOpen: (open) => set({ comparePickerOpen: open }),
  compareTargetPdfId: null,
  comparePdfId: null,
  compareContent: null,
  isComparing: false,
  setCompareResult: (targetPdfId, content, sourcePdfId) =>
    set((state) => ({ compareTargetPdfId: targetPdfId, compareContent: content, comparePdfId: sourcePdfId ?? state.comparePdfId })),
  clearCompare: () => set({ compareTargetPdfId: null, comparePdfId: null, compareContent: null, isComparing: false }),
  setIsComparing: (loading) => set({ isComparing: loading }),

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
  drawColor: '#1a1a1a',
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
  setDeckManagerOpen: (open) => set(open ? { deckManagerOpen: true, graphViewOpen: false, globalChatOpen: false, trashViewOpen: false, noteWorkspaceOpen: false } : { deckManagerOpen: false }),

  trashViewOpen: false,
  setTrashViewOpen: (open) =>
    set(open ? { trashViewOpen: true, graphViewOpen: false, deckManagerOpen: false, globalChatOpen: false, noteWorkspaceOpen: false } : { trashViewOpen: false }),

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

  // ── Note Workspace (standalone notes) ────────────────────────────────────
  noteWorkspaceOpen: false,
  setNoteWorkspaceOpen: (open) =>
    set(open ? { noteWorkspaceOpen: true, graphViewOpen: false, deckManagerOpen: false, globalChatOpen: false, trashViewOpen: false } : { noteWorkspaceOpen: false }),

  openStandaloneNote: (noteId) =>
    set({ selectedNoteId: noteId, noteWorkspaceOpen: true, graphViewOpen: false, deckManagerOpen: false, globalChatOpen: false, trashViewOpen: false }),

  standaloneNotes: [],
  loadStandaloneNotes: async () => {
    const json = await invoke<string>('get_notes', {});
    const all: Note[] = JSON.parse(json);
    set({ standaloneNotes: all.filter((n) => n.source_pdf_id == null) });
  },

  createStandaloneNote: async () => {
    const json = await invoke<string>('create_note', { title: 'Untitled', sourcePdfId: null, sourcePage: null });
    const note: Note = JSON.parse(json);
    set((state) => ({ standaloneNotes: [note, ...state.standaloneNotes] }));
    get().openStandaloneNote(note.id);
    return note;
  },

  updateStandaloneNoteLocal: (id, changes) =>
    set((state) => ({
      standaloneNotes: state.standaloneNotes.map((n) => (n.id === id ? { ...n, ...changes } : n)),
    })),

  removeStandaloneNoteLocal: (id) =>
    set((state) => ({ standaloneNotes: state.standaloneNotes.filter((n) => n.id !== id) })),

  // ── Cross-surface drawing clipboard ──────────────────────────────────────
  drawingClipboard: [],
  setDrawingClipboard: (strokes) => set({ drawingClipboard: strokes }),

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

  // ── Split view (pane B) ──────────────────────────────────────────────────────
  focusedPane: 'A',
  focusPane: (paneId) => set({ focusedPane: paneId }),
  paneB: null,

  openPaneB: (pdfId) => {
    // Already open in pane A — just focus it rather than opening a second
    // copy in pane B (mirrors the symmetric check in selectPdf).
    if (useStore.getState().selectedPdfId === pdfId) {
      set({ focusedPane: 'A' });
      return;
    }
    const pdf = useStore.getState().pdfs.find((p) => p.id === pdfId);
    const base = emptyPaneB(pdfId);
    const resumePage = pdf && pdf.last_page > 1 ? pdf.last_page : null;
    set({ paneB: { ...base, pendingJumpPage: resumePage }, focusedPane: 'B' });
    if (pdf?.content_hash) pullPdf(pdf.content_hash).catch((err) => console.error('[sync] pull on open failed', err));
    useStore.getState().loadChatMessagesB(pdfId).catch((err) => console.error('[chat] failed to load history', err));
  },

  closePaneB: () =>
    set((state) => ({
      paneB: null,
      focusedPane: state.focusedPane === 'B' ? 'A' : state.focusedPane,
    })),

  promoteBToA: () =>
    set((state) => {
      const b = state.paneB;
      if (!b) return state;
      return {
        selectedPdfId: b.pdfId,
        currentPage: b.currentPage,
        pendingJumpPage: b.pendingJumpPage,
        jumpToPage: b.jumpToPage,
        highlights: b.highlights,
        activeLens: b.activeLens,
        notes: b.notes,
        selectedNoteId: b.selectedNoteId,
        drawings: b.drawings,
        drawMode: b.drawMode,
        textBoxes: b.textBoxes,
        selectedTextBoxId: b.selectedTextBoxId,
        placingTextBox: b.placingTextBox,
        editingTextBoxId: b.editingTextBoxId,
        flashcards: b.flashcards,
        chatMessages: b.chatMessages,
        isAiLoading: b.isAiLoading,
        outline: b.outline,
        outlineLoading: b.outlineLoading,
        expandedOutlineIds: b.expandedOutlineIds,
        isOutlineSectionExpanded: b.isOutlineSectionExpanded,
        outlineAttempted: b.outlineAttempted,
        requestOutlineExtraction: b.requestOutlineExtraction,
        paneB: null,
        focusedPane: 'A',
      };
    }),

  selectPdfB: (id) => {
    const state = useStore.getState();
    if (!state.paneB) return;
    state.openPaneB(id);
  },

  loadHighlightsB: async (pdfId) => {
    const json = await invoke<string>("get_highlights", { pdfId });
    const highlights: Highlight[] = JSON.parse(json);
    set((state) => (state.paneB ? { paneB: { ...state.paneB, highlights } } : state));
  },
  addHighlightB: (h) => {
    set((state) => (state.paneB ? { paneB: { ...state.paneB, highlights: [...state.paneB.highlights, h] } } : state));
    schedulePush(h.pdf_id);
  },
  removeHighlightB: (id) =>
    set((state) => {
      if (!state.paneB) return state;
      const removed = state.paneB.highlights.find((h) => h.id === id);
      if (removed) schedulePush(removed.pdf_id);
      return { paneB: { ...state.paneB, highlights: state.paneB.highlights.filter((h) => h.id !== id) } };
    }),
  setActiveLensB: (lens) => set((state) => (state.paneB ? { paneB: { ...state.paneB, activeLens: lens } } : state)),

  loadNotesB: async (pdfId) => {
    const json = await invoke<string>("get_notes", { pdfId });
    const notes: Note[] = JSON.parse(json);
    set((state) => (state.paneB ? { paneB: { ...state.paneB, notes } } : state));
  },
  addNoteB: (note) => {
    set((state) => (state.paneB ? { paneB: { ...state.paneB, notes: [note, ...state.paneB.notes] } } : state));
    if (note.source_pdf_id) schedulePush(note.source_pdf_id);
  },
  updateNoteB: (id, changes) =>
    set((state) => {
      if (!state.paneB) return state;
      const updated = state.paneB.notes.map((n) => (n.id === id ? { ...n, ...changes } : n));
      const note = updated.find((n) => n.id === id);
      if (note?.source_pdf_id) schedulePush(note.source_pdf_id);
      return { paneB: { ...state.paneB, notes: updated } };
    }),
  removeNoteB: (id) =>
    set((state) => {
      if (!state.paneB) return state;
      const removed = state.paneB.notes.find((n) => n.id === id);
      if (removed?.source_pdf_id) schedulePush(removed.source_pdf_id);
      return { paneB: { ...state.paneB, notes: state.paneB.notes.filter((n) => n.id !== id) } };
    }),
  setSelectedNoteIdB: (id) => set((state) => (state.paneB ? { paneB: { ...state.paneB, selectedNoteId: id } } : state)),
  setCurrentPageB: (page) => set((state) => (state.paneB ? { paneB: { ...state.paneB, currentPage: page } } : state)),
  setJumpToPageB: (fn) => set((state) => (state.paneB ? { paneB: { ...state.paneB, jumpToPage: fn } } : state)),
  setPendingJumpPageB: (page) => set((state) => (state.paneB ? { paneB: { ...state.paneB, pendingJumpPage: page } } : state)),

  loadDrawingsB: async (pdfId) => {
    const json = await invoke<string>('get_drawings', { pdfId });
    const raw: any[] = JSON.parse(json);
    const drawings: Drawing[] = raw.map((d) => ({
      ...d,
      points: typeof d.points === 'string' ? JSON.parse(d.points) : d.points,
    }));
    set((state) => (state.paneB ? { paneB: { ...state.paneB, drawings } } : state));
  },
  addDrawingB: (d) => set((state) => (state.paneB ? { paneB: { ...state.paneB, drawings: [...state.paneB.drawings, d] } } : state)),
  removeDrawingB: (id) => set((state) => (state.paneB ? { paneB: { ...state.paneB, drawings: state.paneB.drawings.filter((d) => d.id !== id) } } : state)),
  setDrawModeB: (on) => set((state) => (state.paneB ? { paneB: { ...state.paneB, drawMode: on } } : state)),

  loadTextBoxesB: async (pdfId) => {
    const json = await invoke<string>('get_text_boxes', { pdfId });
    const textBoxes: TextBox[] = JSON.parse(json);
    set((state) => (state.paneB ? { paneB: { ...state.paneB, textBoxes } } : state));
  },
  addTextBoxB: (tb) => set((state) => (state.paneB ? { paneB: { ...state.paneB, textBoxes: [...state.paneB.textBoxes, tb] } } : state)),
  updateTextBoxLocalB: (id, changes) =>
    set((state) => (state.paneB ? { paneB: { ...state.paneB, textBoxes: state.paneB.textBoxes.map((tb) => (tb.id === id ? { ...tb, ...changes } : tb)) } } : state)),
  removeTextBoxB: (id) => set((state) => (state.paneB ? { paneB: { ...state.paneB, textBoxes: state.paneB.textBoxes.filter((tb) => tb.id !== id) } } : state)),
  setSelectedTextBoxIdB: (id) => set((state) => (state.paneB ? { paneB: { ...state.paneB, selectedTextBoxId: id } } : state)),
  setPlacingTextBoxB: (on) => set((state) => (state.paneB ? { paneB: { ...state.paneB, placingTextBox: on } } : state)),
  setEditingTextBoxIdB: (id) => set((state) => (state.paneB ? { paneB: { ...state.paneB, editingTextBoxId: id } } : state)),

  loadFlashcardsB: async (pdfId) => {
    const json = await invoke<string>('get_flashcards', { pdfId });
    const flashcards: Flashcard[] = JSON.parse(json);
    set((state) => (state.paneB ? { paneB: { ...state.paneB, flashcards } } : state));
  },
  addFlashcardB: (f) => {
    set((state) => (state.paneB ? { paneB: { ...state.paneB, flashcards: [...state.paneB.flashcards, f] }, allCards: [...state.allCards, f] } : { allCards: [...state.allCards, f] }));
    if (f.pdf_id) schedulePush(f.pdf_id);
  },
  removeFlashcardB: (id) =>
    set((state) => {
      const removed = state.paneB?.flashcards.find((f) => f.id === id) ?? state.allCards.find((f) => f.id === id);
      if (removed?.pdf_id) schedulePush(removed.pdf_id);
      return {
        paneB: state.paneB ? { ...state.paneB, flashcards: state.paneB.flashcards.filter((f) => f.id !== id) } : state.paneB,
        allCards: state.allCards.filter((f) => f.id !== id),
      };
    }),
  updateFlashcardLocalB: (id, changes) =>
    set((state) => {
      const patch = (list: Flashcard[]) => list.map((f) => (f.id === id ? { ...f, ...changes } : f));
      const allCards = patch(state.allCards);
      const card = (state.paneB ? patch(state.paneB.flashcards) : []).find((f) => f.id === id) ?? allCards.find((f) => f.id === id);
      const contentChanged = Object.keys(changes).some((k) => k !== 'deck_id');
      if (card?.pdf_id && contentChanged) schedulePush(card.pdf_id);
      return {
        paneB: state.paneB ? { ...state.paneB, flashcards: patch(state.paneB.flashcards) } : state.paneB,
        allCards,
        reviewDeck: patch(state.reviewDeck),
        reviewQueue: patch(state.reviewQueue),
      };
    }),

  loadChatMessagesB: async (pdfId) => {
    const json = await invoke<string>("get_chat_messages", { pdfId });
    const rows: { id: string; role: 'user' | 'assistant'; content: string; created_at: string }[] = JSON.parse(json);
    const chatMessages: ChatMessage[] = rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      timestamp: Date.parse(r.created_at),
    }));
    set((state) => (state.paneB ? { paneB: { ...state.paneB, chatMessages } } : state));
  },
  addChatMessageB: (msg) => {
    set((state) => (state.paneB ? { paneB: { ...state.paneB, chatMessages: [...state.paneB.chatMessages, msg] } } : state));
    const pdfId = useStore.getState().paneB?.pdfId;
    if (pdfId) {
      invoke("add_chat_message", { pdfId, id: msg.id, role: msg.role, content: msg.content })
        .catch((err) => console.error('[chat] failed to persist message', err));
    }
  },
  clearChatB: () => {
    const pdfId = useStore.getState().paneB?.pdfId;
    set((state) => (state.paneB ? { paneB: { ...state.paneB, chatMessages: [] } } : state));
    if (pdfId) {
      invoke("clear_chat_messages", { pdfId }).catch((err) => console.error('[chat] failed to clear history', err));
    }
  },
  setAiLoadingB: (loading) => set((state) => (state.paneB ? { paneB: { ...state.paneB, isAiLoading: loading } } : state)),

  setOutlineB: (items) => set((state) => (state.paneB ? { paneB: { ...state.paneB, outline: items } } : state)),
  loadOutlineB: async (pdfId) => {
    const json = await invoke<string>('get_outline', { pdfId });
    const outline: OutlineItem[] = JSON.parse(json);
    set((state) => (state.paneB ? { paneB: { ...state.paneB, outline } } : state));
  },
  setOutlineLoadingB: (loading) => set((state) => (state.paneB ? { paneB: { ...state.paneB, outlineLoading: loading } } : state)),
  toggleOutlineExpandedB: (id) =>
    set((state) => {
      if (!state.paneB) return state;
      const next = new Set(state.paneB.expandedOutlineIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { paneB: { ...state.paneB, expandedOutlineIds: next } };
    }),
  setOutlineSectionExpandedB: (expanded) => set((state) => (state.paneB ? { paneB: { ...state.paneB, isOutlineSectionExpanded: expanded } } : state)),
  setOutlineAttemptedB: (attempted) => set((state) => (state.paneB ? { paneB: { ...state.paneB, outlineAttempted: attempted } } : state)),
  setRequestOutlineExtractionB: (fn) => set((state) => (state.paneB ? { paneB: { ...state.paneB, requestOutlineExtraction: fn } } : state)),
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
