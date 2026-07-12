export interface Pdf {
  id: string;
  filename: string;
  filepath: string;
  folder_id: string | null;
  page_count: number | null;
  pages_read: number;
  chunk_count: number | null;
  ingested_at: string | null;
  last_opened: string | null;
  content_hash: string | null;
  is_pinned: boolean;
  deleted_at: string | null;
}

export interface PageText {
  page: number;
  text: string;
}

export type IngestionStatus = 'indexing' | 'done' | 'error';

export interface HlRect {
  x: number; y: number; w: number; h: number;
}

export interface Highlight {
  id: string;
  pdf_id: string;
  page: number;
  color: "yellow" | "blue" | "green" | "pink";
  selected_text: string;
  position_x: number;
  position_y: number;
  position_w: number;
  position_h: number;
  rects: HlRect[] | null;
  note: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

export type LensKey = 'default' | 'concepts' | 'revision' | 'flashcards' | 'quotes';

export interface Note {
  id: string;
  title: string;
  content_markdown: string;
  folder_id: string | null;
  source_pdf_id: string | null;
  source_page: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  order_index: number;
  created_at: string;
  is_pinned: boolean;
}

export type DrawToolType = 'pen' | 'arrow' | 'rectangle' | 'circle' | 'textbox';

export interface DrawPoint {
  x: number;
  y: number;
}

export interface Drawing {
  id: string;
  pdf_id: string;
  page: number;
  tool_type: DrawToolType;
  color: string;
  stroke_width: number;
  points: DrawPoint[];
  created_at: string;
}

/** Canonical intermediate format for the PDF-drawing copy/paste clipboard. */
export interface SketchStroke {
  id: string;
  tool_type: 'pen' | 'arrow' | 'rectangle' | 'circle';
  color: string;
  stroke_width: number;
  points: DrawPoint[];
}

export interface TextBox {
  id: string;
  pdf_id: string;
  page: number;
  content: string;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  font_size: number;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Flashcard {
  id: string;
  /** Null for custom (user-authored) cards, which have no source highlight/PDF/page. */
  source_highlight_id: string | null;
  pdf_id: string | null;
  page: number | null;
  front: string;
  back: string;
  /** Custom deck membership; null = unfiled (shows under its PDF section / All cards). */
  deck_id: string | null;
  /** 0 = unreviewed, 1 = low, 2 = medium, 3 = high/mastered */
  confidence_level: number;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** User-created flashcard deck. Local-only — never synced. */
export interface Deck {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** Manual confidence rating a user assigns after flipping a card. */
export type ConfidenceLevel = 1 | 2 | 3;

export type ReviewFilter = 'all' | 'low';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ── Global Chat (cross-library) ─────────────────────────────────────────────

export interface ChatCitation {
  sourceId: string; // pdf id
  page: number;
}

export interface GlobalChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  citations?: ChatCitation[]; // resolved once, at insert time
}

/** Full chunk row including raw embedding bytes — used by search and global chat. */
export interface RawChunk {
  id: string;
  source_id: string;
  page: number;
  content: string;
  embedding: number[]; // raw u8 bytes from Rust Vec<u8>
}

/** get_chunks_for_pdf's response shape — text only, no embedding. */
export interface PdfChunk {
  chunk_index: number;
  page: number;
  content: string;
}

export type SettingsTab = 'account' | 'editor' | 'data';

// ── Graph View (knowledge map) ─────────────────────────────────────────────

export type GraphNodeType = 'pdf' | 'note' | 'flashcard' | 'tag';

export type GraphEdgeKind = 'citation' | 'derived' | 'tagged' | 'semantic' | 'linked';

export interface GraphNode {
  id: string;            // type-prefixed unique id, e.g. "pdf:<uuid>" / "tag:<name>"
  refId: string;         // underlying entity id (or the tag name for tag nodes)
  type: GraphNodeType;
  label: string;
  pdfId: string | null;  // owning/source PDF — drives click-to-open navigation
  page: number | null;   // source page — consumed via pendingJumpPage on open
  radius: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphEdge {
  source: string;        // GraphNode.id
  target: string;        // GraphNode.id
  kind: GraphEdgeKind;
  weight?: number;       // semantic edges only: 0–1 normalized similarity strength
}

export interface OutlineItem {
  id: string;
  pdf_id: string;
  parent_id: string | null;
  title: string;
  page: number;
  order_index: number;
  source: 'embedded' | 'ai-generated';
  created_at: string;
}
