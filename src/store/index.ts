import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Pdf, Folder, Highlight, LensKey, Note, IngestionStatus, ChatMessage, Drawing, DrawToolType, TextBox, Flashcard } from "../types";
import type { HighlightColorKey } from "../constants/highlights";

interface AppState {
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
  setAiSettings: (s: Partial<{ aiProvider: string; aiModel: string; aiBaseUrl: string; aiApiKey: string }>) => void;
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
}

export const useStore = create<AppState>((set) => ({
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

  selectPdf: (id) => set({ selectedPdfId: id, selectedNoteId: null, currentPage: 1, chatMessages: [], summaryContent: null, summaryLens: null, isSummarizing: false, drawings: [], drawMode: false, textBoxes: [], selectedTextBoxId: null, placingTextBox: false, editingTextBoxId: null, flashcards: [] }),

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

  setAiSettings: (s) => set((state) => ({ ...state, ...s })),

  loadAiSettings: async () => {
    try {
      const [provider, model, baseUrl, apiKey] = await Promise.all([
        invoke<string>('get_setting', { key: 'ai_provider' }),
        invoke<string>('get_setting', { key: 'ai_model' }),
        invoke<string>('get_setting', { key: 'ai_base_url' }),
        invoke<string>('get_setting', { key: 'ai_api_key' }),
      ]);
      set({
        aiProvider: provider || 'ollama',
        aiModel: model || 'llama3.2',
        aiBaseUrl: baseUrl || 'http://localhost:11434/v1',
        aiApiKey: apiKey || '',
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
}));
