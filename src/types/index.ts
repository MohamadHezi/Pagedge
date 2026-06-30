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
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
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
  source_highlight_id: string;
  pdf_id: string;
  page: number;
  front: string;
  back: string;
  interval: number;
  ease_factor: number;
  repetitions: number;
  next_review: string;
  created_at: string;
}

export type ReviewQuality = 'again' | 'hard' | 'good' | 'easy';

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
