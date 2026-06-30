# Pagedge — Claude Code Context

## What Pagedge Is

Pagedge is a desktop PDF reader and knowledge-base tool built with Tauri 2. Users import PDFs, highlight text with one of four semantically-typed colors, attach notes, and (in later steps) query their highlights with a local AI. The primary goal is a fast, distraction-free reading environment that accumulates a structured knowledge store over time.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (WebView2 on Windows) |
| Backend | Rust — `src-tauri/src/` |
| Database | SQLite via `rusqlite 0.31` (bundled), migrations run at startup |
| Frontend framework | React 18 + TypeScript 5 + Vite 5 |
| Styling | Tailwind CSS v3 (utilities only; design tokens live in CSS custom properties in `src/index.css`) |
| State management | Zustand v5 (`src/store/index.ts`) |
| PDF rendering | `pdfjs-dist` v6 — canvas render + `TextLayer` for selectable text |
| PDF worker | `public/pdf.worker.min.mjs` (copied from pdfjs-dist at install time) |
| IPC | `@tauri-apps/api` v2 — `invoke()` for all backend calls |

`sqlite-vec` is listed in the roadmap but **not yet added** to `Cargo.toml`. The current `rusqlite` dep has the `bundled` feature only.

---

## Project Structure

```
Pagedge/
├── src/                        # React frontend
│   ├── main.tsx                # Entry — mounts App, imports index.css + pdfjs CSS
│   ├── App.tsx                 # Root layout: IconRail / LibrarySidebar / MainArea / RightPanel (no Toolbar — native decorations)
│   ├── index.css               # CSS custom properties (design tokens) + resets
│   ├── App.css                 # All component CSS (no CSS modules — single flat file)
│   ├── components/
│   │   ├── PdfViewer.tsx       # Core viewer: canvas render, text layer, highlight system, floating toolbar + lens, explain panel, summarize-by-color trigger
│   │   ├── ViewerToolbar.tsx   # Zoom split-button + page-jump controls (floats bottom-right of viewer)
│   │   ├── LibrarySidebar.tsx  # PDF list, selection; collapses via sidebar-collapsed class
│   │   ├── MainArea.tsx        # Switches between drop-zone and PdfViewer
│   │   ├── IconRail.tsx        # 64 px icon rail (brand logo, nav icons, settings, search)
│   │   ├── RightPanel.tsx      # Notes panel (NoteCard list + NoteEditor) + Chat with PDF tab
│   │   ├── SettingsPanel.tsx   # AI provider settings (Ollama / OpenAI-compatible)
│   │   ├── SummaryPanel.tsx    # Summarize-by-color results overlay with save-to-note action
│   │   └── SearchModal.tsx     # Ctrl+K semantic search modal (cosine similarity over embeddings)
│   ├── constants/
│   │   └── highlights.ts       # HIGHLIGHT_COLORS record + HighlightColorKey type
│   ├── services/
│   │   ├── ingestionService.ts # PDF text extraction, chunking (500 tok / 50 overlap), transformers.js embeddings, embedQuery export
│   │   └── aiService.ts        # callAI() — OpenAI-compatible fetch wrapper, reads provider settings from store
│   ├── store/
│   │   └── index.ts            # Zustand store: pdfs, highlights, notes, panel visibility, ingestion, AI settings, chat, search, summary
│   └── types/
│       └── index.ts            # Pdf, Highlight, HlRect, Folder, Note, LensKey, ChatMessage, IngestionStatus interfaces
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs              # Tauri builder, DB init + migrations, command registration
│   │   ├── commands.rs         # All Tauri commands + Rust structs (Pdf, Highlight, HlRect)
│   │   └── main.rs             # Calls lib::run()
│   ├── Cargo.toml
│   └── tauri.conf.json
├── public/
│   └── pdf.worker.min.mjs      # pdfjs worker (must stay in public/)
├── tailwind.config.js
├── vite.config.ts
├── PRODUCT.md                  # Product strategy (see impeccable skill)
└── DESIGN.md                   # Visual design system (see impeccable skill)
```

All Tauri commands are registered in `lib.rs` via `tauri::generate_handler![]` and implemented in `commands.rs`. Never add commands in other files.

---

## Current Build State

### Step 1 — Tauri Shell ✅
Three-panel layout: library sidebar (240 px) + scrollable PDF viewer + right panel (300 px, hidden). Top toolbar with app branding. Drag-and-drop + file dialog for PDF import. SQLite DB initialized at startup. CSS custom-property design token system.

### Step 2 — PDF Viewer ✅
HiDPI canvas rendering (`devicePixelRatio` physical vs CSS sizing). `TextLayer` from pdfjs v6 for selectable text. `--total-scale-factor` CSS property manually set (required without `PDFViewerApplication`). Fit-to-width on load. Zoom control (0.5×–3×) with presets + inline edit. Page-jump control. Cancellable render loop via `renderIdRef` (incremented on each new load; each async iteration checks for stale id before continuing). All renders run sequentially page-by-page to avoid race conditions.

### Step 3 — Highlight System ✅
- **Selection** → `handleMouseUp` captures `range.getClientRects()`, merges per-line, groups by page (supports cross-page selections), converts to PDF point space via `toPdfCoords`.
- **Color picker popup** appears at mouse-up cursor position; uses `onMouseDown` + `e.preventDefault()` to preserve selection.
- **Storage** → `add_highlight` Tauri command; positions stored in PDF point space (device-independent).
- **Drawing** → `drawHighlightsForPage` on a `<canvas class="hl-canvas">` layered above the PDF canvas. White canvas base + CSS `mix-blend-mode: multiply` for real-marker blending. `ctx.roundRect` with 3 px radius for backgrounds, 1.5 px for stripes.
- **Overlap rendering** — per-rect (not per-highlight) grouping: oldest highlight at a position draws a full background; additional highlights draw 3 px split-underline stripes stacked upward. `splitAtBoundaries` splits new rects at same-line existing-highlight edges so overlapping and clear zones of the same line are stored as separate rects.
- **Same-color deduplication** — `uncoveredPortions` does horizontal interval subtraction; selecting yellow over existing yellow only highlights the uncovered portion.
- **Highlight detail popup** — click existing highlight opens `HighlightDetailPopup` with color label, selected text, optional note, and delete button.
- **Multi-highlight picker** — click on a position with multiple overlapping highlights opens `HlPickerPopup` (color dots); tap a dot to open that highlight's detail popup.

### Step 3b — Lens Switcher ✅
- **LensSwitcher component** (`LensSwitcher.tsx`) — floating pill-shaped tab bar, `position: absolute` above the PDF pages container, centered horizontally, z-index above page canvases but below popups.
- **Five lenses**: `default` (Read), `concepts` (yellow), `revision` (blue), `flashcards` (green), `quotes` (pink).
- **Active tab** — filled with that lens's color, white label text. Inactive tabs transparent with muted label and a small colored dot.
- **State** — `activeLens: LensKey` and `setActiveLens` in Zustand store, default `'default'`.
- **Canvas filter** — `drawHighlightsForPage` reads `activeLens`; if `'default'` draws all highlights normally; otherwise draws only highlights whose color key matches the active lens.
- **No DB or schema changes** — pure render-layer filter over existing highlight data.

### Step 4 — Notes Panel + Stitch Redesign ✅
- **Notes panel** (`RightPanel.tsx`) — two views: `NoteCard` list (title, preview, relative timestamp) and `NoteEditor` (full-screen editor within the panel).
- **NoteEditor** — `@uiw/react-md-editor` in `preview="edit"` mode (toolbar hidden). Title field (`note-title-input`) is a bare `<input>` above the editor. Auto-save with 800 ms debounce via `scheduleFlush`; save state cycles idle → saving → saved. Citation pill (`note-citation-pill`) links back to source PDF + page and calls `jumpToPage` to navigate there.
- **Notes DB** — standalone `notes` table (not stored on `highlights`); fields: `id`, `title`, `content_markdown`, `folder_id`, `source_pdf_id`, `source_page`, `tags` (JSON `[]`), `created_at`, `updated_at`. Tauri commands: `create_note`, `get_notes`, `update_note`, `delete_note`.
- **Panel collapse** — negative-margin animation: `.sidebar-collapsed { margin-left: calc(-1 * var(--sidebar-width)) }` and `.panel-collapsed { margin-right: calc(-1 * var(--right-panel-width)) }`, both with `transition: 0.35s cubic-bezier(0.4,0,0.2,1)`. Toggle buttons (`panel-toggle--left/right`) float in the PDF viewer.
- **Stitch redesign** — warm dark palette (`#0e0e0e` canvas, `#161309` glass surfaces), yellow accent (`#e9c400`/`#ffd60a`), Inter + JetBrains Mono fonts. All design tokens updated in `src/index.css`.
- **Icon rail** (`IconRail.tsx`) — 64 px fixed-width nav column (brand logo, library/search/graph/history buttons, add + settings). Replaces `<Toolbar />` — native OS decorations handle the title bar (`decorations: true` in `tauri.conf.json`).
- **Glass morphism** — sidebar and right panel use `background: rgba(22,19,9,0.70); backdrop-filter: blur(20px); border: 1px solid var(--border-glass)`.
- **Floating viewer chrome** — `LensSwitcher` moved from inside scroll container to `.lens-float` (`position: absolute; top: 12px; left: 50%; transform: translateX(-50%)`) above `.pdf-pages`. `ViewerToolbar` in `.viewer-toolbar-float` (`position: absolute; bottom: 16px; right: 16px`). Both are glass bars with `backdrop-filter: blur`.
- **MDEditor font parity** — `.note-editor-workspace .w-md-editor *` wildcard cascades identical `font-family`, `font-size: 13px`, `line-height: 1.65`, `letter-spacing: 0`, `overflow-wrap: break-word`, `word-break: break-word` to every layer so textarea input and pre display layer wrap at identical points (fixes caret drift).

### Step 5 — Ingestion Pipeline ✅
- **`ingestionService.ts`** — triggered automatically on PDF import. Stages: extract text via `extract_pdf_text` Tauri command (lopdf crate, returns `Vec<{ page, text }>`), chunk in TypeScript (500-token chunks, 50-token overlap, preserves page number per chunk), embed via transformers.js Web Worker (Xenova/all-MiniLM-L6-v2, 384 dims), store raw f32 embedding blobs via `store_chunks` Tauri command.
- **chunks table** — `id`, `source_type` (default `'pdf'`), `source_id` (FK → pdfs.id), `chunk_index`, `page`, `content`, `embedding` (BLOB, raw little-endian f32 bytes), `created_at`. Index on `source_id`. Commands: `store_chunks`, `get_chunks_for_pdf`, `delete_chunks_for_pdf`.
- **`pdfs` schema addition** — `chunk_count INTEGER DEFAULT 0` column (added via startup migration). Updated by `update_pdf_ingestion_status` command. `Pdf` struct has `chunk_count: Option<i64>` field.
- **Ingestion status UI** — `ingestionStatus: Record<string, IngestionStatus>` in store (`{ stage, progress, error }`). LibrarySidebar shows progress bar + status text per PDF during ingestion. `isModelLoading` flag (true while the transformers.js model warms up for the first time).
- **`embedQuery(text)`** export in `ingestionService.ts` — calls the existing embedder singleton for a single string, returns `Float32Array`.

### Step 5b — AI Provider Abstraction ✅
- **`SettingsPanel.tsx`** — slide-in panel (gear icon in IconRail). Provider dropdown: Ollama (local, default), OpenAI, Groq, Gemini, OpenRouter, Anthropic. Each provider auto-fills a default base URL. Model name text field. Optional API key field. "Test connection" button that calls the AI provider with a minimal prompt. Save persists to SQLite `settings` table via `set_setting` / `get_setting` Tauri commands.
- **`aiService.ts`** — `callAI(messages, options?)`: reads `aiBaseUrl`, `aiModel`, `aiApiKey` from store; calls `{baseUrl}/chat/completions` (OpenAI-compatible format); streams disabled (`stream: false`); returns content string.
- **Settings DB** — `settings` table (`key TEXT PRIMARY KEY, value TEXT NOT NULL`). Default rows inserted on startup with `INSERT OR IGNORE`: `ai_provider = 'ollama'`, `ai_model = 'llama3.2'`, `ai_base_url = 'http://localhost:11434/v1'`, `ai_api_key = ''`.
- **Store** — `aiProvider`, `aiModel`, `aiBaseUrl`, `aiApiKey`, `setAiSettings`, `loadAiSettings` (called once at App mount from `settings` table).

### Step 6 — Explain This + Chat with PDF ✅
- **Explain panel** — appears after selecting text and clicking ✦ in the color-picker popup. Inline panel below selection (`.explain-panel`) shows AI explanation of selected text or a page summary. "Save to note" button creates a note with the explanation as content, citation pointing to source PDF + page.
- **Summarize page** — separate action available from color picker; sends visible page text to AI with a 3–5 bullet summary prompt.
- **Chat with PDF** (`RightPanel.tsx`) — second tab in the right panel. Full conversation UI: message list (`chat-messages`), typing indicator, error display, input row. Context: pulls top-10 most-relevant chunks for the current PDF via cosine similarity over `get_chunks_for_pdf` embeddings. Citations: assistant messages include source page numbers as clickable pills that call `jumpToPage`.
- **Store** — `chatMessages: ChatMessage[]`, `addChatMessage`, `clearChat`, `isAiLoading`, `setAiLoading`. `ChatMessage` type: `{ id, role: 'user'|'assistant', content, citations?: number[] }`.

### Step 7 — Summarize by Color ✅
- **Trigger** — LensSwitcher gains a "Summarize" button when a non-default lens is active. Clicking it collects all highlights of the active lens color for the current PDF, formats them as a prompt, and calls `callAI`.
- **`SummaryPanel.tsx`** — full-width overlay panel above the viewer. Shows a spinner while generating, then renders the AI response as Markdown via `@uiw/react-md-editor` in preview mode. "Save as note" action creates a note with the summary, "Copy" copies markdown to clipboard, "×" closes.
- **Per-lens prompts** — `LENS_SUMMARIZE_PROMPTS` in `PdfViewer.tsx`: concepts (group themes), revision (explain confusing passages), flashcards (extract core concepts), quotes (significance + themes).
- **Store** — `summaryContent: string | null`, `summaryLens: LensKey | null`, `isSummarizing: boolean`, `setSummary`, `clearSummary`, `setIsSummarizing`.

### Step 8 — Semantic Search ✅
- **`SearchModal.tsx`** — Ctrl+K / Cmd+K command-palette modal. 600 px wide, fade+scale animation. Debounced 300 ms search: embeds query via `embedQuery`, fetches all chunks via `get_all_chunks` Tauri command, computes cosine similarity, filters to ≥ 0.2 threshold, returns top-10 results.
- **`get_all_chunks`** Rust command — returns all chunks across all PDFs (id, source_id, page, content, embedding bytes) ordered by `source_id, chunk_index`.
- **Embedding bytes** — stored as `Vec<u8>` (raw f32 little-endian) in SQLite BLOB; Tauri serializes as JSON `number[]`; `bytesToFloat32` in SearchModal decodes via `DataView` with `littleEndian=true`.
- **Scope toggle** — "All PDFs" vs "This PDF". Color filter (concepts/revision/flashcards/quotes) available in "This PDF" mode — filters to chunks whose page has at least one highlight of that color.
- **Cross-PDF navigation** — clicking a result from a different PDF: `setPendingJumpPage(hit.page)` then `selectPdf(hit.sourceId)`. PdfViewer consumes `pendingJumpPage` 600 ms after `numPages > 0` fires.
- **Score threshold 0.2** — single-word queries against paragraph-length chunks produce lower absolute cosine similarity; 0.2 balances recall vs noise.
- **Store** — `searchModalOpen`, `setSearchModalOpen`, `pendingJumpPage`, `setPendingJumpPage`.

---

## Key Architectural Decisions

### Coordinate System
All highlight positions are stored in **PDF point space**, not canvas or screen pixels. `toPdfCoords(selectionRect, wrapperRect, viewport, scale)` converts from screen coords. PDF y-axis is 0 at bottom; screen y-axis is 0 at top — the conversion flips: `y = (viewport.height - relBottom) / scale`. When re-drawing, `r.x * scale` and `viewport.height - (r.y + r.h) * scale` map back to canvas coordinates. This makes highlights resolution-independent and zoom-stable.

### HlRect storage
Each `Highlight` stores:
- `position_x/y/w/h` — bounding box of the full selection (REAL columns, PDF pt)
- `rects` — JSON array of `HlRect` objects for per-line strips (TEXT column). Falls back to the bounding box if null (legacy rows). `mergeRects` collapses span-level `clientRects` into one rect per line before storage.

### Four Semantic Highlight Colors
Defined as constants in `src/constants/highlights.ts`. Never hardcode hex values elsewhere.
- `yellow` (#FFD60A) — Important / key concept
- `blue` (#4DA6FF) — Confused / need to revisit
- `green` (#34C759) — Add to flashcards
- `pink` (#FF6B9D) — Quotes worth keeping

### Tauri IPC Naming
Rust uses `snake_case` params; Tauri 2 maps them to `camelCase` on the JS side. Always pass `camelCase` from `invoke()` calls (e.g. `pdfId`, `selectedText`). The Rust structs use `snake_case` field names and `serde` handles the mapping.

### Cancellable Render Loop
`renderIdRef.current` is incremented at the start of each load. Each `await` inside the render loop checks `renderIdRef.current !== renderId` before continuing. `cancellablesRef` holds `RenderTask` and `TextLayer` instances that are cancelled on PDF switch to stop in-flight GPU work.

### Zustand Store
Single store in `src/store/index.ts`. Sections: PDFs, Highlights, Notes, Panel visibility, Ingestion, AI Settings, Chat, Search, Summary.
- `highlights` — authoritative client-side list; `loadHighlights(pdfId)` replaces on PDF switch; `addHighlight` / `removeHighlight` do optimistic updates. `highlightsRef` mirrors state so async render loops can read without a dependency.
- `notes` — same pattern; `loadNotes(pdfId)` replaces on PDF switch; `addNote` prepends, `updateNote` does a partial-patch, `removeNote` filters.
- `selectedNoteId` — which note is open in the editor (null = list view).
- `currentPage` / `jumpToPage` — current reader page (updated by PdfViewer scroll handler); `jumpToPage` is a function ref set by PdfViewer so the right panel can trigger a scroll.
- `leftPanelOpen` / `rightPanelOpen` — toggled by panel-toggle buttons in PdfViewer; drive the collapsed CSS class on sidebar and right panel.
- `ingestionStatus` — `Record<string, IngestionStatus>` keyed by PDF id; `IngestionStatus: { stage, progress, error }`. `isModelLoading` is true while transformers.js model warms up.
- `aiProvider / aiModel / aiBaseUrl / aiApiKey` — loaded from DB at startup; persisted via `set_setting`; read by `aiService.ts`.
- `chatMessages / addChatMessage / clearChat / isAiLoading` — per-session chat history for "Chat with PDF".
- `searchModalOpen / setSearchModalOpen` — controls `SearchModal` visibility. `pendingJumpPage / setPendingJumpPage` — queues a cross-PDF page jump; consumed by PdfViewer 600 ms after new PDF loads.
- `summaryContent / summaryLens / isSummarizing / setSummary / clearSummary / setIsSummarizing` — drives `SummaryPanel` display.

### CSS Architecture
No CSS modules. All component styles in `src/App.css`. Design tokens as CSS custom properties in `src/index.css`. Tailwind utility classes used sparingly alongside the custom property system. `pdfjs-dist/web/pdf_viewer.css` imported in `main.tsx` after `index.css` — provides text layer rules including `user-select: text` on `.textLayer :is(span, br)` (overrides body's `user-select: none`).

---

## SQLite Schema

Database lives at `{app_data_dir}/pagedge.db`. Opened fresh per Tauri command (no connection pool).

```sql
CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,   -- UUID v4
    name       TEXT NOT NULL,
    parent_id  TEXT,               -- self-referential FK, nullable
    created_at TEXT NOT NULL       -- ISO 8601
);

CREATE TABLE IF NOT EXISTS pdfs (
    id          TEXT PRIMARY KEY,  -- UUID v4
    filename    TEXT NOT NULL,
    filepath    TEXT NOT NULL UNIQUE,
    folder_id   TEXT,              -- FK → folders.id, nullable
    page_count  INTEGER,
    pages_read  INTEGER DEFAULT 0,
    ingested_at TEXT,              -- ISO 8601
    last_opened TEXT               -- ISO 8601, nullable
);

CREATE TABLE IF NOT EXISTS highlights (
    id            TEXT PRIMARY KEY,  -- UUID v4
    pdf_id        TEXT NOT NULL,     -- FK → pdfs.id
    page          INTEGER NOT NULL,  -- 1-indexed
    color         TEXT NOT NULL,     -- "yellow" | "blue" | "green" | "pink"
    selected_text TEXT NOT NULL,
    position_x    REAL NOT NULL,     -- PDF point space, left edge
    position_y    REAL NOT NULL,     -- PDF point space, bottom edge (y=0 at page bottom)
    position_w    REAL NOT NULL,
    position_h    REAL NOT NULL,
    note          TEXT,              -- nullable, user annotation
    created_at    TEXT NOT NULL,     -- ISO 8601
    rects         TEXT              -- JSON array of {x,y,w,h} per line strip; nullable
);

CREATE TABLE IF NOT EXISTS notes (
    id               TEXT PRIMARY KEY,  -- UUID v4
    title            TEXT NOT NULL DEFAULT 'Untitled',
    content_markdown TEXT NOT NULL DEFAULT '',
    folder_id        TEXT,              -- FK → folders.id, nullable
    source_pdf_id    TEXT,              -- FK → pdfs.id, nullable
    source_page      INTEGER,           -- 1-indexed, nullable
    tags             TEXT NOT NULL DEFAULT '[]',  -- JSON string array
    created_at       TEXT NOT NULL,     -- ISO 8601
    updated_at       TEXT NOT NULL      -- ISO 8601
);
```

```sql
CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT PRIMARY KEY,   -- UUID v4
    source_type TEXT NOT NULL DEFAULT 'pdf',
    source_id   TEXT NOT NULL,      -- FK → pdfs.id
    chunk_index INTEGER NOT NULL,   -- 0-indexed order within the PDF
    page        INTEGER NOT NULL,   -- 1-indexed page number
    content     TEXT NOT NULL,      -- raw chunk text (~500 tokens)
    embedding   BLOB,               -- raw little-endian f32 bytes (384 dims)
    created_at  TEXT NOT NULL       -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

**Migrations run at startup** (all with `let _ = conn.execute(...)` to silently no-op if already applied):
- `ALTER TABLE highlights ADD COLUMN rects TEXT`
- `ALTER TABLE pdfs ADD COLUMN chunk_count INTEGER DEFAULT 0`

---

## Active Conventions

- **UUID v4** primary keys everywhere (`uuid` crate, `Uuid::new_v4().to_string()`).
- **ISO 8601** timestamps via `chrono::Utc::now().to_rfc3339()`.
- **All Tauri commands** in `src-tauri/src/commands.rs`, registered in `lib.rs`. No exceptions.
- **All TypeScript types** in `src/types/index.ts`. No inline interface definitions in component files.
- **All highlight color constants** in `src/constants/highlights.ts`. No hardcoded hex values elsewhere.
- **No CSS modules** — all styles in `src/App.css`, tokens in `src/index.css`.
- **No light mode** — dark-only. All tokens assume dark background.
- **`onMouseDown` + `e.preventDefault()`** for popup buttons that must not clear text selection.
- Rust command return type is always `Result<String, String>` with JSON-serialized payload.
- **MDEditor font parity** — always target `.w-md-editor *` (wildcard) in addition to the named text-layer classes when setting `font-size`, `line-height`, `font-family`, `letter-spacing`, `overflow-wrap`, or `word-break` inside the notes editor. Without the wildcard, child `<span>`/`<code>` tokens wrap at different points than the textarea, causing caret drift and selection misalignment.
- **`useStore()` must be called unconditionally** at the top of every component, before any early returns. Calling it inside a conditional branch or after an early return violates Rules of Hooks and causes a runtime crash.

---

### Step 11 — Freehand Drawing + Shapes ✅
- **Drawing canvas** — fourth canvas layer (`.drawing-canvas`) per page, stacked above `.hl-canvas`. Read mode: `z-index: 1`, `pointer-events: none`. Draw mode: `z-index: 3`, `pointer-events: auto`; `.textLayer` gets `pointer-events: none` so all input routes to the drawing surface.
- **Annotation Dock** (`AnnotationDock.tsx`) — DESIGN.md spec: glassmorphism capsule (`backdrop-filter: blur(20px)`, warm-dark fill, 18px radius), anchored right edge via `.annotation-dock-wrap` (`position: absolute; right: 20px; top: 50%; transform: translateY(-50%)`). Tools: Pen, Arrow, Rectangle, Circle; disabled Text Box stub (Step 12); 7-color palette; stroke-width ±0.5 stepper (1–6 px); undo; done.
- **Draw mode toggle** — pencil icon in `ViewerToolbar`. Activates `drawMode`; Escape and Done exit.
- **Pen** — smooth quadratic Bézier through accumulated points; all points stored in PDF point space.
- **Shapes** — Arrow (line + filled arrowhead), Rectangle (`roundRect` stroke), Circle (`ellipse` stroke). `mousedown` → start; document `mousemove` → live preview; `mouseup` → finalize. Sub-4px drags discarded.
- **Coordinate system** — same PDF point space as highlights: `x = relX/scale`, `y = (vp.height − relY)/scale`. Zoom rescales purely from stored points.
- **Undo** — `sessionUndoIds` ref tracks IDs added in current session; undo removes last from DB and store.
- **Delete (read mode)** — clicking near a drawing (12px bounding-box padding) shows `.delete-drawing-popup`.
- **DB** — `drawings` table: `id`, `pdf_id`, `page`, `tool_type`, `color`, `stroke_width`, `points` (JSON), `created_at`. Index `(pdf_id, page)`.
- **Rust** — `add_drawing`, `get_drawings`, `delete_drawing`, `update_drawing_points` in `commands.rs`.
- **Store** — `drawings/loadDrawings/addDrawing/removeDrawing`, `drawMode/setDrawMode`, `activeDrawTool/setActiveDrawTool`, `drawColor/setDrawColor`, `strokeWidth/setStrokeWidth`. `selectPdf` resets both.

### Step 12 — Text Box Annotations ✅
- **DB** — `text_boxes` table: `id`, `pdf_id`, `page`, `content`, `position_x/y/width/height` (PDF pt space), `font_size`, `color`, `created_at`, `updated_at`. Index `(pdf_id, page)`.
- **Rust** — `add_text_box`, `get_text_boxes`, `update_text_box`, `delete_text_box` in `commands.rs`. `update_text_box` uses `COALESCE` for partial updates.
- **DOM rendering** — `TextBoxLayer` component per page (`src/components/TextBoxLayer.tsx`). Positioned as `absolute` divs inside `.pdf-page-wrap`, z-index 4 (above drawing canvas). Uses CSS `left/top/width/height` derived from PDF point space × scale. Not canvas-drawn — real DOM for native text editing.
- **`TextBoxEl`** — single box component: single-click selects, double-click or click-while-selected enters edit mode via `contentEditable`. Blur commits content (500 ms debounced save); empty box auto-deletes on blur. `onMouseDown` drags (position saved on mouseup). Resize handle at bottom-right.
- **Mini-toolbar** — appears above selected box: font-size stepper (10–32), 8-color palette, delete button. Glassmorphism style matching Annotation Dock.
- **Activation** — Text Box tool in Annotation Dock (was greyed-out stub in Step 11) is now enabled as `DrawToolType = 'textbox'`. Selecting it enters "textbox-place mode" (CSS class `.textbox-place-mode` on `.pdf-pages`): crosshair cursor, existing boxes get `pointer-events: none` so clicks fall through to create a new box at that position.
- **Keyboard** — Delete/Backspace deletes selected text box (when not in edit mode). Escape deselects and exits draw mode.
- **Store** — `textBoxes/loadTextBoxes/addTextBox/updateTextBoxLocal/removeTextBox`, `selectedTextBoxId/setSelectedTextBoxId`, `placingTextBox/setPlacingTextBox`. `selectPdf` resets all text box state.
- **Coordinate system** — same PDF point space as highlights/drawings. `cssTop = viewport.height − (position_y + height) × scale` mirrors the y-flip used everywhere else.

### Step 13 — Export Annotated PDF ✅
- **Export flow** — Download icon button in `ViewerToolbar` (in the AI-actions group). Clicking it opens `ExportDialog` (via `setExportDialogOpen(true)` from the store). The dialog shows three checkboxes (Highlights / Drawings / Text Boxes, all checked by default) and an "Export PDF" button. On confirm, Rust opens a native save dialog defaulting to `[name]-annotated.pdf`, then stamps annotations, then writes the new file. The original PDF is never modified.
- **`export_annotated_pdf` Rust command** — (`commands.rs`). Opens save dialog via `tauri_plugin_dialog`. Loads highlights, drawings, text boxes from SQLite for the given `pdf_id`. Opens source PDF with `lopdf::Document::load`. For each page, adds standard PDF annotation objects (`/Highlight`, `/Ink`, `/Line`, `/Square`, `/Circle`, `/FreeText`) via `doc.add_object()` and appends to page `/Annots`. Saves to user-chosen path with `doc.save()`. Returns the output path (empty string = cancelled).
- **`reveal_in_folder` Rust command** — `explorer /select,path` on Windows, `open -R` on macOS, `xdg-open dir` on Linux.
- **PDF annotation format** — Highlights use `/QuadPoints` (8 values per rect strip — upper-left, upper-right, lower-left, lower-right in PDF point space). Drawings: pen→`/Ink` with `/InkList`; arrow→`/Line` with `/LE [/None /OpenArrow]`; rectangle→`/Square`; circle→`/Circle`. Text boxes→`/FreeText` with `/DA` default-appearance string `/Helvetica N Tf r g b rg`.
- **Coordinate system** — All stored data is already in PDF point space (y=0 at bottom). No conversion needed. `lopdf::Object::Real` takes `f32` in lopdf 0.34 — use `as f32` casts.
- **`ExportDialog.tsx`** — Glassmorphism modal (same overlay/animation as `SearchModal`). Checkboxes, export button with spinner, inline success/error message. Success shows the output path + "Show in folder" button; auto-closes after 3 s.
- **Color constants** — `highlight_color_pdf()` in `commands.rs` maps the four semantic keys to PDF 0–1 float triples. **IMPORTANT: these must be kept in sync with `src/constants/highlights.ts` manually** — Rust and TypeScript cannot share a single constants file.
- **Store** — `exportDialogOpen / setExportDialogOpen` (same pattern as `searchModalOpen`).
- **`lopdf` borrow note** — inside `if-else` blocks, always bind `stmt.query_map(...).collect()` to an explicit `let v = ...; v` before the block ends so the iterator (which borrows `stmt`) is fully consumed before `stmt` drops.

### Step 14 — Flashcard Generator ✅
- **Generation trigger** — green ("Add to flashcards") highlights become persistent SM-2-graded flashcards. When the lens switcher is on the `flashcards` (green) lens, a sibling "🎴 Generate Flashcards" button appears next to the existing "✦ Summarize Lens" button (`PdfViewer.tsx`) — the two are independent: Summarize Lens makes a one-off markdown digest, Generate Flashcards creates persistent cards. One AI call per highlight (sequential, not batched) using `callAI`; a defensive regex parses the `FRONT:`/`BACK:` response format. Per-highlight failures are swallowed so one bad highlight doesn't abort the batch. Already-carded highlights (matched by `source_highlight_id`) are skipped on subsequent runs.
- **`src/services/flashcardService.ts`** — `generateFlashcardsForHighlights(highlights, onProgress)` orchestrates the per-highlight AI calls + `add_flashcard` persistence. `gradeFlashcard(card, quality)` is a pure SM-2 implementation (`again|hard|good|easy` → quality 0/3/4/5 on the canonical 0–5 scale), returning `{ interval, easeFactor, repetitions, nextReview }`; `ease_factor` floors at 1.3. SM-2 math lives entirely in TypeScript — Rust only persists already-computed values, consistent with chunking/AI orchestration also being TS-side.
- **`flashcards` table** — `id`, `source_highlight_id`, `pdf_id`, `page` (denormalized from the source highlight at creation time, same rationale as `notes.source_page` — lets "jump to source" work without an async highlight lookup), `front`, `back`, `interval` (REAL, days), `ease_factor` (REAL, default 2.5), `repetitions` (INTEGER, default 0), `next_review` (TEXT rfc3339 — a freshly generated card is immediately due), `created_at`. Indexes on `pdf_id` and `next_review`. Cascade-deleted in `delete_pdf`.
- **Rust commands** — `add_flashcard`, `get_flashcards` (by `pdf_id`), `get_all_flashcards` (no filter — global review), `delete_flashcard`, `update_flashcard_review` (takes pre-computed `interval`/`ease_factor`/`repetitions`/`next_review`, re-queries and returns the persisted row as JSON). Same `Result<String,String>`/`Result<(),String>` + `row_to_*` mapper + `*_SELECT` const pattern as `TextBox`.
- **Review Mode** (`src/components/ReviewMode.tsx`) — full-screen modal, mounted unconditionally in `App.tsx`, self-gated on `reviewModeOpen`. Card flip via CSS 3D transform (`.review-card` → `.review-card-inner` with `transform-style: preserve-3d` → two `.review-card-face` children with `backface-visibility: hidden`). Front/back text uses `var(--font-serif)` (Newsreader). Grading row (Again/Hard/Good/Easy) only shows after flip; grading calls `gradeFlashcard` + `update_flashcard_review` + `advanceReview()` — cards are never re-queued into the same session regardless of grade. "Jump to source" reuses the exact cross-PDF jump mechanism from `SearchModal` (`setPendingJumpPage` + `selectPdf` if a different PDF, else `jumpToPage?.()` directly). Empty state shows an upcoming-due count rather than a bare placeholder.
- **Entry points** — in-viewer: the post-generation completion toast's "Review now" button reviews all of the current PDF's flashcards sorted by page. Global: the previously-dead "Flashcard Documents" Quick View button in `LibrarySidebar.tsx` now calls `get_all_flashcards`, filters to `next_review <= now`, sorts soonest-first, and opens Review Mode via the store's `startReview(queue)` helper (sets `reviewQueue` + `currentReviewIndex: 0` + `reviewModeOpen: true` atomically).
- **Store** — `flashcards/loadFlashcards/addFlashcard/removeFlashcard/updateFlashcardLocal`, `reviewQueue/currentReviewIndex/reviewModeOpen/setReviewModeOpen/startReview/advanceReview`, `isGeneratingFlashcards/setIsGeneratingFlashcards`, `generationProgress/setGenerationProgress`. `selectPdf` resets `flashcards: []` alongside its other per-PDF resets.

## Roadmap — Steps 9–10

- **Step 9** — Highlights panel: right sidebar tab that lists all highlights in the current PDF sorted by page, click to jump, filter by lens color.

- **Step 10** — Polish + packaging: animations, hover effects, micro-interactions, keyboard shortcuts, onboarding empty states, Mac + Windows builds.

---

## Design System Reference

See `PRODUCT.md` for product strategy, user model, and design principles.
See `DESIGN.md` for color tokens, typography scale, spacing, and component specifications.

Both files are read by the `impeccable` skill (`/impeccable`) before any UI work. If either is missing, run `/impeccable init` first.
