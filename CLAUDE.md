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

### Step 14 — Flashcard Generator ✅ (SRS replaced by Confidence Metric)
- **Confidence metric (replaced SM-2 SRS)** — cards carry a manual `confidence_level` (INTEGER: 0 = unreviewed, 1 = low, 2 = medium, 3 = mastered) plus a `last_reviewed_at` history timestamp instead of `interval`/`ease_factor`/`repetitions`/`next_review` scheduling. There is no due-date concept anywhere — review sessions load the whole deck. The local startup migration adds the two new columns, seeds `confidence_level` from old `repetitions` (`>=3 → 3`, `>=1 → 2`, else `0`), drops `idx_flashcards_review` (SQLite refuses to drop an indexed column), then drops the four SRS columns; the seed UPDATE only succeeds on the one startup where old and new columns coexist.
- **Generation trigger** — green ("Add to flashcards") highlights become persistent confidence-graded flashcards. When the lens switcher is on the `flashcards` (green) lens, a sibling "🎴 Generate Flashcards" button appears next to the existing "✦ Summarize Lens" button (`PdfViewer.tsx`) — the two are independent: Summarize Lens makes a one-off markdown digest, Generate Flashcards creates persistent cards. One AI call per highlight (sequential, not batched) using `callAI`; a defensive regex parses the `FRONT:`/`BACK:` response format. Per-highlight failures are swallowed so one bad highlight doesn't abort the batch. Already-carded highlights (matched by `source_highlight_id`) are skipped on subsequent runs.
- **`src/services/flashcardService.ts`** — `generateFlashcardsForHighlights(highlights, onProgress)` orchestrates the per-highlight AI calls + `add_flashcard` persistence. `isLowConfidence(card)` (`confidence_level <= 1` — unreviewed counts as low) and `deckMastery(cards)` (returns `{ mastered, total, percent }`, mastered = `confidence_level === 3`) drive the ReviewMode filter and progress bar.
- **`flashcards` table** — `id`, `source_highlight_id`, `pdf_id`, `page` (denormalized from the source highlight at creation time, same rationale as `notes.source_page` — lets "jump to source" work without an async highlight lookup), `front`, `back`, `confidence_level` (INTEGER, default 0), `last_reviewed_at` (TEXT rfc3339, nullable — set on every grade), `created_at`. Index on `pdf_id`. Cascade-deleted in `delete_pdf`.
- **Rust commands** — `add_flashcard`, `get_flashcards` (by `pdf_id`), `get_all_flashcards` (global, ordered `confidence_level ASC, created_at ASC` — least-confident first), `delete_flashcard`, `update_flashcard_review` (takes `id` + `confidence_level`, stamps `last_reviewed_at`/`updated_at`, re-queries and returns the persisted row as JSON). Same `Result<String,String>`/`Result<(),String>` + `row_to_*` mapper + `*_SELECT` const pattern as `TextBox`.
- **Review Mode** (`src/components/ReviewMode.tsx`) — full-screen modal, mounted unconditionally in `App.tsx`, self-gated on `reviewModeOpen`. Card flip via CSS 3D transform (`.review-card` → `.review-card-inner` with `transform-style: preserve-3d` → two `.review-card-face` children with `backface-visibility: hidden`). Front/back text uses `var(--font-serif)` (Newsreader). Grading row ("Low Confidence" / "Getting There" / "Mastered" → confidence 1/2/3) only shows after flip; grading calls `update_flashcard_review` + `advanceReview()` — cards are never re-queued into the same session regardless of grade. Filter pills ("All cards" / "Low confidence") re-derive the session queue from the full deck and restart the index; a mastery bar (`deckMastery`) shows "X/Y mastered · Z%". "Jump to source" reuses the exact cross-PDF jump mechanism from `SearchModal` (`setPendingJumpPage` + `selectPdf` if a different PDF, else `jumpToPage?.()` directly).
- **Entry points** — in-viewer: the post-generation completion toast's "Review now" button reviews all of the current PDF's flashcards sorted by page. Global: the "Flashcard Documents" Quick View button in `LibrarySidebar.tsx` (and the IconRail deck button) call `get_all_flashcards` and open Review Mode with the entire deck via `startReview(deck)` — no due filtering.
- **Store** — `flashcards/loadFlashcards/addFlashcard/removeFlashcard/updateFlashcardLocal`, `reviewDeck` (full session deck) + `reviewQueue` (filtered view) + `reviewFilter/setReviewFilter` (`'all' | 'low'`; re-derives `reviewQueue`, resets index), `currentReviewIndex/reviewModeOpen/setReviewModeOpen/startReview/advanceReview`, `isGeneratingFlashcards/setIsGeneratingFlashcards`, `generationProgress/setGenerationProgress`. `updateFlashcardLocal` also patches `reviewDeck`/`reviewQueue` so mid-session grades update the mastery counter live. `selectPdf` resets `flashcards: []` alongside its other per-PDF resets.
- **Sync contract updated in lockstep** — `syncService.ts`'s `ServerFlashcard`, backend `FLASHCARD_FIELDS` (`app/api/sync/push/route.ts`), and Supabase migration `0007_flashcard_confidence.sql` (manual apply — adds `confidence_level`/`last_reviewed_at`, seeds from `repetitions`, drops the SRS columns).

### Step 15 — Auto-Tagging ✅
- **No new DB/Rust changes** — `notes.tags` (JSON string array) and `update_note`'s `tags` param already existed; this step is purely a frontend surface on top of them.
- **`NoteEditor` tag row** (`RightPanel.tsx`) — below the title input, above the markdown editor. Applied tags render as solid pills (`--bg-container-low` background, `--text-secondary` text) each with a small "×" that removes and auto-saves immediately (no debounce — tag add/remove is a discrete click, unlike title/content typing). A trailing bare `<input>` (`+ tag` placeholder) adds a custom tag on Enter, independent of AI.
- **"✦ Suggest tags" button** — only rendered when `content_markdown` is non-empty. Calls `callAI` with a dedicated `TAG_SYSTEM` prompt (comma-separated, 3–6 short lowercase tags) against the first 2000 chars of the note body. Response is split on commas, lowercased, deduped against already-applied tags, capped at 6, and stored in the store as `suggestedTags` — never persisted directly.
- **Suggested-tags row** — appears only while `suggestedTags.length > 0`, directly below the tag row. Each suggestion renders as a dashed-border pill (`note-tag-pill--suggested`); clicking one applies it via the same `saveTags` path and removes it from the suggestion list. "+ Add all" applies every remaining suggestion at once. Suggestions are cleared whenever the open note changes (`note.id` effect) — they're ephemeral, UI-only state, never written to SQLite.
- **Tag filter (notes list)** — `RightPanel`'s notes-list view computes `allTags` client-side (`Array.from(new Set(notes.flatMap(n => n.tags)))`, no new query) and renders a `.note-tag-filter-bar` of chips above the note cards. Clicking a chip sets `activeTagFilter` and narrows the visible note list to notes containing that tag; clicking the active chip again clears the filter. Same toggle pattern as the Step 9 highlight color filter.
- **Store** — `suggestedTags / setSuggestedTags / clearSuggestedTags`, `isSuggestingTags / setIsSuggestingTags`, `activeTagFilter / setActiveTagFilter`. `selectPdf` resets both `activeTagFilter` and `suggestedTags` (notes are per-PDF, so a stale filter/suggestion from the previous PDF would otherwise leak through).

### Step 17 — Auto-Outline ✅
- **`outline_items` table** (`lib.rs` migration) — `id`, `pdf_id`, `parent_id` (self-referential, nullable, for nesting), `title`, `page`, `order_index` (sibling ordering), `source` (`'embedded' | 'ai-generated'`), `created_at`. Index `(pdf_id)`. Cascade-deleted in `delete_pdf`.
- **Rust commands** — `store_outline(pdf_id, items)` (transaction: delete-then-bulk-insert, so re-extraction is idempotent) and `get_outline(pdf_id)` (ordered by `order_index`). No `extract_pdf_outline` Rust command — extraction happens entirely in TypeScript against the PDF.js document object already loaded by `PdfViewer`, per the same reasoning as Step 5's text extraction (`lopdf` parses differently/worse than PDF.js for some files, and re-reading the file a second time is wasted work).
- **`src/services/outlineService.ts`** — `ensureOutline(pdfId, doc)`. First checks `get_outline`; if rows already exist, just loads them (no re-extraction on reopen). Otherwise: (1) tries `doc.getOutline()` — PDF.js bookmark tree — resolving each node's `dest` to a page number via `doc.getDestination()` (named destinations) + `doc.getPageIndex()`, flattening into parent-linked rows tagged `source: 'embedded'`; nodes whose destination can't be resolved are skipped but their children still attach to the same parent so the tree isn't silently truncated. (2) If no embedded outline exists, falls back to AI: pulls `getTextContent()` for the first 20 pages (3000 chars/page cap) directly from the already-open document, sends it to `callAI` with a heading-extraction prompt, parses the JSON array response into a flat (single-level) list tagged `source: 'ai-generated'`. Whichever list is non-empty gets persisted via `store_outline`.
- **Lazy accordion trigger — extraction never runs on PDF open.** `PdfViewer`'s load effect, right after the PDF.js document resolves, only registers a trigger closure via `setRequestOutlineExtraction(() => { setOutlineAttempted(true); setOutlineLoading(true); ensureOutline(pdfId, doc)... })` — it does not call `ensureOutline` itself. The closure is cleared (`setRequestOutlineExtraction(null)`) on cleanup so a stale reference can't fire against a torn-down document after a PDF switch. `OutlineSection`'s header `onClick` is the only thing that ever invokes `requestOutlineExtraction()`, and only `if (next && !outlineAttempted)` — i.e. the section is being expanded for the first time this PDF has been open. Re-collapsing and re-expanding does not re-run extraction (`outlineAttempted` stays `true` for the rest of the session); the PDF.js bookmark tree and AI fallback are each entitled to exactly one extraction attempt per PDF open.
- **`OutlineSection`** (`src/components/OutlinePanel.tsx`) — left-nav section, rendered first (above Pinned) in `LibrarySidebar.tsx`, self-gated on `selectedPdfId` so it's invisible with no PDF open. Header is a real `<button>` (`.nav-section-header--toggle`) with a chevron that rotates 90° on expand; clicking it toggles `isOutlineSectionExpanded` (default `false` — collapsed on every fresh PDF open) and conditionally fires the lazy trigger above. Body wraps in `.outline-collapse` / `.outline-collapse-inner`, a CSS Grid `grid-template-rows: 0fr → 1fr` transition — animates open/closed without measuring `scrollHeight` in JS, and Pinned/Collections below slide naturally since they're flex siblings in the same `nav-scroll` column. Tree itself is built client-side from the flat `outline` array via a `parent_id → children[]` map; recursive `OutlineNode` renders a chevron only for nodes with children (toggles `expandedOutlineIds`), clicking the row itself calls `jumpToPage?.(item.page)`. "Generating outline…" shown while `outlineLoading`; "No outline available" only once `outlineAttempted` is true and the result came back empty (never shown pre-emptively before the user has expanded the section).
- **Current-page highlight** — `findActiveId` (in `OutlinePanel.tsx`) does a best-effort match: the outline item with the highest `page <= currentPage` across the whole flat list (not just visible/expanded nodes) gets `.outline-item--active`. Purely a render-time computation, no store state.
- **Store** — `outline: OutlineItem[]`, `setOutline`, `loadOutline(pdfId)` (plain `get_outline` fetch — used both by `ensureOutline` and for a fast reload path), `outlineLoading/setOutlineLoading`, `expandedOutlineIds: Set<string>` + `toggleOutlineExpanded`, `isOutlineSectionExpanded/setOutlineSectionExpanded` (accordion open state), `outlineAttempted/setOutlineAttempted` (per-PDF one-shot extraction guard), `requestOutlineExtraction: (() => void) | null` + `setRequestOutlineExtraction` (the PdfViewer→OutlinePanel trigger handoff). `selectPdf` resets all of the above (`outline: []`, `outlineLoading: false`, `expandedOutlineIds: new Set()`, `isOutlineSectionExpanded: false`, `outlineAttempted: false`, `requestOutlineExtraction: null`) alongside its other per-PDF resets.

### Step 10c — Mac + Windows Packaging ✅
- **`tauri.conf.json` bundle config** — `targets: ["nsis", "msi", "dmg", "app"]` (explicit instead of `"all"`), `publisher: "Pagedge"`, `category: "Productivity"` (maps to `public.app-category.productivity` on macOS via Tauri's `BundleCategory` enum). `bundle.windows`: `nsis.installMode: "currentUser"` (NSIS template's desktop-shortcut checkbox is opt-in by default, no extra config needed), `certificateThumbprint: null` (unsigned for beta), `digestAlgorithm: "sha256"`, `timestampUrl: "http://timestamp.sectigo.com"`. `bundle.macOS`: `minimumSystemVersion: "11.0"`, `signingIdentity: "-"` (ad-hoc signing — produces a Gatekeeper-blocked but installable `.app`/`.dmg`, no paid Developer ID needed for beta).
- **Icons** — regenerated the full set via `pnpm tauri icon src-tauri/icons/128x128@2x.png` (the only source large enough to upscale from; no 1024×1024 master existed). Added `icon.icns` (required for macOS bundling — previously missing), plus Windows Store square logos. iOS/Android output directories were deleted (not in scope, generated as a side effect of the icon command). **If a higher-resolution master icon is ever added, re-run `tauri icon` against it** rather than the current upscaled source.
- **Tauri updater** — `tauri-plugin-updater` + `tauri-plugin-process` (Rust, for `relaunch()` after install) added to `Cargo.toml` and registered in `lib.rs`. Frontend: `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`, `@tauri-apps/plugin-dialog` added; `src/services/updateService.ts` exports `checkForUpdates()` — calls `check()`, and on a hit shows a native `ask()` dialog ("A new version of Pagedge is available... Install / Later"), then `downloadAndInstall()` + `relaunch()`. Called fire-and-forget (not awaited) from `App.tsx`'s mount effect — runs once per session, never blocks startup, and swallows errors so an unreachable/not-yet-live endpoint is silent.
- **Updater endpoint** — `plugins.updater.endpoints` in `tauri.conf.json` points at GitHub Releases' evergreen manifest alias: `https://github.com/MohamadHezi/Pagedge/releases/latest/download/latest.json`. `tauri-action` auto-generates and signs `latest.json` as a release asset on every tag (using `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, already wired in `release.yml`) — no backend route needed. **Caveat:** `release.yml` creates the GitHub Release as a **draft** on purpose (a chance to review before going live), and GitHub's `/releases/latest/...` alias only resolves to *published* releases — so a new version isn't visible to the in-app updater until the draft is manually published on GitHub.
- **Updater signing key — generated and wired.** `plugins.updater.pubkey` in `tauri.conf.json` holds the real public key (generated via `pnpm tauri signer generate`); the matching private key + password are stored as the `TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD` GitHub secrets used by the release workflow. **Never commit the private key.**
- **Updater capability permissions** — `updater:default` and `process:allow-restart` added to `src-tauri/capabilities/default.json`, plus `dialog:allow-ask` for the native update-prompt dialog.
- **Version display** — `SettingsPanel.tsx` reads `getVersion()` from `@tauri-apps/api/app` on mount and renders `"Pagedge v{version}"` (`.settings-version`, `var(--text-muted)`) below the footer.
- **Build scripts** (`package.json`) — `build:win` (`tauri build --target x86_64-pc-windows-msvc`), `build:mac` (`tauri build --target universal-apple-darwin`), `build:all` (runs both sequentially — only meaningful in CI since the two targets build on different OSes).
- **`.github/workflows/release.yml`** — triggers on `v*.*.*` tags. Matrix: `windows-latest` (NSIS + MSI) and `macos-latest` (universal `.dmg` + `.app`). Uses `tauri-apps/tauri-action@v0`. Requires repo secrets `TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD` (mapped to the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars tauri-action actually reads); `APPLE_SIGNING_IDENTITY: '-'` is hardcoded for ad-hoc beta signing. Creates a draft GitHub Release per tag with all platform installers attached.
- **Code signing is deferred** — both Windows (`certificateThumbprint`) and macOS (`signingIdentity`) are unsigned/ad-hoc for beta. Real signing needs a paid Apple Developer account ($99/yr, for a Developer ID + notarization) and a Windows EV code-signing certificate (~$200–500/yr) — both pre-public-launch tasks, not yet started.
- **What beta users will see** — Windows: SmartScreen warning ("Windows protected your PC") on first run; bypass via "More info" → "Run anyway". macOS: Gatekeeper blocks the unsigned `.app` outright; bypass via right-click → "Open" (first launch only), or `xattr -cr /Applications/Pagedge.app` if Gatekeeper still refuses. Document both in beta onboarding instructions.

### Step 26 — Account System + Auth Infrastructure ✅
- **New standalone repo `pagedge-backend/`** — sibling folder to `Pagedge/` (not a subfolder, not a workspace member), deployed to Vercel independently. Next.js 14 App Router, TypeScript, **API routes only** — no frontend pages. `app/api/auth/{signup,signin,refresh,me}/route.ts`.
- **Supabase** — Postgres + Supabase Auth (handles all password hashing; the app never sees or stores raw passwords). `supabase/migrations/0001_profiles.sql` creates the `profiles` table (`id` FK → `auth.users.id`, `email`, `tier` default `'free'`, `ai_calls_this_month`, `ai_calls_reset_at`, `stripe_customer_id`/`stripe_subscription_id` columns present but unused — Stripe billing itself is a later step), RLS (`auth.uid() = id` read-only policy; all writes go through the service-role key from API routes, so no insert/update policy exists), and the `handle_new_user()` trigger that auto-inserts a profile row on signup.
- **`lib/supabase.ts`** — `getSupabaseAdmin()` / `getSupabaseAnon()` factory functions (not module-level consts — Next.js evaluates route modules at build time, when env vars aren't available yet, so constructing the client at import time crashed the Vercel build with "supabaseUrl is required"). `getSupabaseAdmin()` (service-role key, bypasses RLS, server-only — used for `auth.admin.createUser` and reading/writing `profiles`) and `getSupabaseAnon()` (anon key — used for the actual password/refresh grants and for verifying a bearer token) are called inside each route handler body instead. **Never** the service-role key client for anything reachable from a token the client controls.
- **`lib/auth.ts`** — `requireUser(req)` extracts the `Authorization: Bearer` header and calls `supabaseAnon.auth.getUser(token)`, a real round-trip to Supabase Auth (not a local JWT decode) — an expired or forged token is rejected there. Every protected route re-derives `tier` from the `profiles` table after this; **a client-asserted tier claim is never trusted.**
- **`POST /auth/signup`** — validates `password.length >= 8`, calls `supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true })` (skips Supabase's email-confirmation flow since there's no desktop deep-link handler for it yet), then immediately signs in via `supabaseAnon.auth.signInWithPassword` to mint a session (admin-created users have no session by default) — so signup logs the user in immediately, matching the spec. Duplicate email → 409 with a clear message (detected via regex on the Supabase error string, since the admin API doesn't return a typed error code).
- **`POST /auth/signin`** — `supabaseAnon.auth.signInWithPassword`; wrong credentials → 401 `"Invalid email or password."` (deliberately not distinguishing "no such user" vs "wrong password" — avoids account enumeration).
- **`POST /auth/refresh`** — `supabaseAnon.auth.refreshSession({ refresh_token })`.
- **`GET /auth/me`** — returns `{ user_id, email, tier, ai_calls_this_month, calls_remaining }`; `calls_remaining` is `null` for `tier: 'pro'`, else `max(0, 15 - ai_calls_this_month)` (originally 30; lowered to 15, now `FREE_TIER_LIMIT` in the backend's `lib/constants.ts`). **Lazy monthly reset** — not a cron job — if `ai_calls_reset_at <= now()`, the route itself zeroes `ai_calls_this_month` and bumps `ai_calls_reset_at` to the 1st of next UTC month before computing the response. No route in this step increments `ai_calls_this_month` — that belongs to whichever future step wires AI calls through the backend for quota enforcement; this step only lays the account/quota *read* path.
- **Live and verified end-to-end** — Supabase project created, migration applied, Vercel env vars set, deployed to production, and the full signup → signin → `/me` → sign-out flow tested against real infrastructure from `pnpm tauri dev`. See **Live Infrastructure** below for URLs, required env vars, and the fixes that were needed to get here.

- **Desktop: `tauri-plugin-store`** — added to `Cargo.toml`/`lib.rs`/`capabilities/default.json` (`store:default`) for session persistence. **Note: this is plain JSON on disk in the app data dir, not OS-keychain-encrypted** — adequate for a short-lived access token + revocable refresh token pair, but revisit with `tauri-plugin-stronghold` if that becomes a requirement.
- **`src/services/authService.ts`** — wraps the four backend routes plus local session persistence (`auth.json` store file, key `session`). `resolveSession()` is the startup entry point: loads the stored session, calls `getMe`; on a 401 it tries `refreshSession()` once and retries `getMe`; if that also fails it clears the stored session and returns `null` (caller falls back to the auth modal). `API_BASE_URL` reads `VITE_PAGEDGE_API_URL` (for pointing at a local `pagedge-backend` dev server) and falls back to `https://pagedge-backend.vercel.app/api`, the live deployment.
- **Zustand auth state** (`store/index.ts`) — `user: AuthUser | null` (`{ id, email, tier, callsRemaining, resetAt }` — `resetAt` added in Step 32 for the paywall's "Resets on [date]" copy), `isAuthenticated`, `authLoading` (starts `true` — prevents the auth modal from flashing before the startup session check resolves), `setUser`, `clearUser`, `initAuth()` (calls `resolveSession()`, called once from `App.tsx`'s mount effect alongside `loadPdfs`/`loadAiSettings`), `signOut()` (clears the local store file + Zustand state), `refreshUserFromMe()` (Step 32 — re-fetches `/auth/me` and updates tier/quota in place, used after the Stripe deep-link return).
- **`AuthModal.tsx`** — centered glass modal (`.auth-overlay`/`.auth-modal`, same blur/shadow/animation language as `SearchModal`), Sign In / Create Account tab switcher, reuses `.settings-input`/`.settings-label`/`.settings-feedback--err` for form fields so auth styling stays visually consistent with the rest of the app. Client-side validates the 8-char minimum on signup only (the backend re-validates regardless). On success, calls `getMe()` once more to populate `callsRemaining` before `setUser()` — `signIn`/`signUp` in `authService.ts` return tokens + tier but not the call count.
- **`App.tsx` gating** — three render states: `authLoading` → bare `.app-shell` (no flash), `!isAuthenticated` → `.app-shell` containing only `<AuthModal />` (rest of the app tree is not mounted — `LibrarySidebar`/`MainArea`/etc. never render while signed out), else the normal app. `initAuth()` and `checkForUpdates()`/`loadPdfs()`/`loadAiSettings()` all fire from the same mount effect — PDF/AI-settings loading is local SQLite data unrelated to the account and isn't gated behind auth resolving first.
- **Settings panel** — `.settings-account` block (email + "Sign out" link-button) at the top of `settings-body`, above the AI provider fields. As of Step 32: free users see `"Free Plan — {used} / 15 AI calls this month"` (derived from `FREE_TIER_MONTHLY_CALLS` exported by `aiService.ts`, which mirrors the backend's `FREE_TIER_LIMIT`) + an "Upgrade to Pro →" link; pro users see `"Pro Plan — Unlimited AI"` + a "Manage subscription" link. The provider/model/base-URL/API-key fields are now hidden by default behind a "Use my own AI provider" toggle (see Step 32 below).
- **No "Forgot password" flow yet** — explicitly deferred per spec.

### Live Infrastructure (Step 26 deployment)
- **Supabase project** — `https://zdyanjzwoijgctqhlsrb.supabase.co`. Postgres + Supabase Auth backing the `pagedge-backend` API.
- **Backend deployment** — `https://pagedge-backend.vercel.app`, Vercel production deployment of `pagedge-backend/`. Auth routes live at `{base}/api/auth/{signup,signin,refresh,me}`.
- **Auth flow** — email/password via Supabase Auth (password hashing handled entirely by Supabase, never touched by app code). Access tokens are JWTs, but they are validated server-side via a live `supabaseAnon.auth.getUser(token)` round-trip (`lib/auth.ts`'s `requireUser`), not local JWT signature verification — so no `JWT_SECRET` or equivalent is needed anywhere in this codebase.
- **`profiles` table** — one row per Supabase Auth user (`id` FK → `auth.users.id`), tracks `tier` (`'free' | 'pro'`), `ai_calls_this_month`, `ai_calls_reset_at` (lazy monthly reset, see `GET /auth/me` above), and `stripe_customer_id`/`stripe_subscription_id` (columns exist, unused until Stripe billing is wired up in a later step).
- **Required Vercel environment variables (Production)** — `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`. All three must be scoped to the **Production** environment specifically (a var saved but scoped only to Preview/Development will silently not apply) and named exactly as above — a project variable named e.g. `SUPABASE_URL` instead of `NEXT_PUBLIC_SUPABASE_URL` will not be picked up and every route will throw `"NEXT_PUBLIC_SUPABASE_URL environment variable is not set"` at request time.
- **`middleware.ts`** (`pagedge-backend/middleware.ts`) — CORS handling for all `/api/*` routes. The Tauri desktop webview calls this API from a different origin (`tauri://localhost` / `https://tauri.localhost`), and Next.js API routes send no CORS headers by default — without this middleware, every request from the desktop app fails as a generic, bodiless "network error" (blocked at the browser/webview layer before any response reaches app code). Sets `Access-Control-Allow-Origin: *` (safe here since every route is bearer-token authenticated, not cookie-based, so there's no CSRF surface from a wildcard origin) and answers `OPTIONS` preflights directly with a 204.
- **`handle_new_user()` trigger fix** (`supabase/migrations/0001_profiles.sql`) — the trigger that auto-creates a `profiles` row on signup originally referenced the bare table name `profiles`. It runs `SECURITY DEFINER`, but fires in the transaction context of the `auth.users` insert (driven by the `supabase_auth_admin` role), whose `search_path` doesn't include `public` — so the unqualified reference failed to resolve, the whole user-creation transaction rolled back, and Supabase surfaced it to every caller (including its own dashboard "Add user" button) as a generic `"Database error creating new user"`. Fixed by qualifying the insert as `public.profiles` and adding `SET search_path = public` to the function definition. **If `profiles`/trigger SQL is ever hand-edited directly in the Supabase SQL editor, re-apply this exact function definition — a plain `INSERT INTO profiles (...)` regression here fails signup for every user, not just some.**
- **Debugging notes for future backend outages** — the fastest diagnostic path when auth routes 500 is: (1) hit `/api/auth/me` with a bogus `Authorization: Bearer` header — this forces a live Supabase call even without valid credentials, cheaply distinguishing "env vars missing" (throws before touching Supabase) from "Supabase reachable" (clean 401); (2) check Vercel → Runtime Logs for the actual thrown error, since production responses never include stack traces; (3) if a route reaches Supabase but 500s with an opaque/malformed error, reproduce directly via Supabase dashboard → Authentication → Users → "Add user" to isolate whether the fault is in this backend's request/config vs. Supabase's own DB/trigger state.

### Step 32 — Stripe Pro Subscription + Gemini AI Proxy ✅
- **Default AI path changed** — `callAI()` (`src/services/aiService.ts`) now routes through the Pagedge backend proxy (`POST {API_BASE_URL}/ai/chat`, Gemini 2.0 Flash server-side) by default. The old direct-provider path (Ollama/OpenAI/etc via `aiBaseUrl`/`aiModel`/`aiApiKey`) still exists verbatim but only runs when the new `aiUseCustomProvider` store flag (persisted via `set_setting`/`get_setting` key `ai_use_custom_provider`, default `'false'`) is `true`. `SettingsPanel.tsx` gates the entire provider/model/base-URL/API-key field group behind a "Use my own AI provider" checkbox — unchecked (the default) hides those fields entirely and callers get the built-in Gemini proxy with no configuration needed.
- **Frontend quota gate (before any network call)** — inside `callProxy()`, character count across all message content is summed client-side; for `tier === 'free'` users, `> 5000` chars or `callsRemaining <= 0` both short-circuit before `fetch()` runs and call `showPaywall(reason)` instead. This is a UX optimization only — the backend re-checks both independently and is the actual enforcement point.
- **`GET /api/ai/chat` → `POST /api/ai/chat`** (`pagedge-backend/app/api/ai/chat/route.ts`) — same `requireUser`/lazy-reset pattern as `/auth/me`. For `tier === 'free'`: `ai_calls_this_month >= 15` (`FREE_TIER_LIMIT`, `lib/constants.ts`; originally 30) → 429 `{error: 'quota_exceeded', calls_used, limit}`; total message content `> 5000` chars → 400 `{error: 'context_too_large'}`. Otherwise calls Gemini's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, model `gemini-2.0-flash`, `GEMINI_API_KEY` from env — never sent to the client), increments `ai_calls_this_month`, and returns the Gemini completion JSON **as-is** (same `choices[0].message.content` shape the direct-provider path already parses, so `extractContent()` in `aiService.ts` is shared between both paths).
- **401 retry** — `callProxy()` does one `refreshSession()` + retry on a 401 from the proxy, mirroring `resolveSession()`'s existing refresh-once pattern.
- **Optimistic quota decrement** — on a successful proxy response, `aiService.ts` decrements `user.callsRemaining` in the Zustand store directly (no extra round-trip); the next `/auth/me` fetch (restart, sign-in, or the Stripe-return refresh) reconciles against the server-authoritative count.
- **`PaywallModal.tsx`** — glass modal (new `.paywall-overlay`/`.paywall-modal` CSS, same overlay language as `AuthModal`/`SettingsPanel`), driven by `paywallOpen`/`paywallReason` (`'context_too_large' | 'quota_exceeded'`) in the store. Reason-specific copy per spec; quota-exceeded state additionally shows "Resets on {date}" formatted from `user.resetAt`. "Upgrade to Pro" calls `startProCheckout()`; "Maybe later" calls `closePaywall()`.
- **Stripe routes** (`pagedge-backend/app/api/stripe/{create-checkout,webhook,portal}/route.ts`), `lib/stripe.ts` — same lazy-client-factory pattern as `lib/supabase.ts` (`getStripe()` built inside each handler, not at module scope, so a missing `STRIPE_SECRET_KEY` doesn't crash the Vercel build). `create-checkout` reuses an existing `stripe_customer_id` from `profiles` if present (avoids duplicate Stripe customers on repeat checkout attempts) else passes `customer_email`; `success_url`/`cancel_url` are the `pagedge://stripe-success` / `pagedge://stripe-cancel` deep links; `metadata.user_id` carries the Supabase user id through to the webhook. `webhook` verifies the raw body against `STRIPE_WEBHOOK_SECRET` via `stripe.webhooks.constructEvent` (the request body must stay unparsed until after signature verification) — `checkout.session.completed` sets `tier='pro'` + persists `stripe_customer_id`/`stripe_subscription_id`; `customer.subscription.deleted` sets `tier='free'` (looked up by `stripe_subscription_id`); `invoice.payment_failed` is logged only, not acted on (Stripe's own dunning/retry handles transient failures — only an actual subscription deletion downgrades the tier). `portal` looks up the caller's `stripe_customer_id` and creates a Billing Portal session (400 if the account has never checked out).
- **`src/services/stripeService.ts`** — `startProCheckout()` / `openBillingPortal()`, both bearer-authed `POST`s to the routes above, opening the returned URL in the system browser via `@tauri-apps/plugin-shell`'s `open()` (payment/portal UI is Stripe-hosted, never rendered inside the Tauri webview).
- **Deep link handling** — `tauri-plugin-deep-link` (Rust + `@tauri-apps/plugin-deep-link` JS) registers the `pagedge://` scheme (`tauri.conf.json` → `plugins.deep-link.desktop.schemes: ["pagedge"]`, capability `deep-link:default`). On Windows/Linux, `lib.rs`'s `setup()` also calls `app.deep_link().register_all()` at runtime — production installers register the scheme via the installer, but `cargo tauri dev` builds skip that step, so this call keeps deep links working during development on those platforms (macOS registers from `Info.plist`/bundle metadata alone). `App.tsx` subscribes via `onOpenUrl()`: `pagedge://stripe-success` calls `refreshUserFromMe()` (re-fetches `/auth/me` so the UI reflects the new `tier`) then shows an `.app-toast` ("Welcome to Pro! Unlimited AI is now active.") and closes the paywall if open; `pagedge://stripe-cancel` shows a neutral toast. `.app-toast` is a new bottom-center toast, distinct from the existing per-viewer `.lens-toast`/`.flash-gen-toast` (which are scoped inside `PdfViewer`'s absolutely-positioned pages container and wouldn't be visible from `App.tsx`).
- **`tauri-plugin-shell`** — added alongside `tauri-plugin-deep-link` (`Cargo.toml`/`lib.rs`/capabilities `shell:allow-open`) purely to open the Stripe checkout/portal URL in the OS default browser; no other shell capability is granted.
- **`/auth/me` response gained `ai_calls_reset_at`** — needed by the paywall's reset-date copy; `MeResponse` (`authService.ts`) and `AuthUser` (`store/index.ts`, field `resetAt`) both updated to carry it through.
- **Required new Vercel env vars** — `GEMINI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID` (all documented in `pagedge-backend/.env.example` alongside the existing Supabase vars). **No `JWT_SECRET` is needed** — same reasoning as Step 26: auth is verified via a live Supabase round-trip, never a local JWT decode.
- **Stripe test mode** — during development, use Stripe test-mode keys and the `4242 4242 4242 4242` test card; switch to live keys only when ready to accept real payments.

### Step 33 — Email Verification ✅
- **Supabase dashboard setting** — Authentication → Providers → Email → "Confirm email" turned ON (dashboard-only change, not in code). "Secure email change" left OFF for beta. Confirmation email uses Supabase's default template. Redirect URL for signup confirmation set to `pagedge://auth/confirm`.
- **Backend: `POST /auth/signup`** (`pagedge-backend/app/api/auth/signup/route.ts`) — no longer passes `email_confirm: true` to `admin.createUser`, and no longer signs the user in afterward (there's nothing to sign in with a session for until the email is confirmed). Returns `{ user_id, email, verification_required: true }` — no tokens.
- **Backend: `POST /auth/resend-confirmation`** (new route) — calls `supabaseAdmin.auth.resend({ type: 'signup', email })`. Always returns `200 { ok: true }` regardless of outcome (never reveals whether the email exists). A module-scope `Map<email, timestamp>` enforces a 60s cooldown per email, checked before calling Supabase.
- **Backend: `POST /api/ai/chat`** — after `requireUser`, now also calls `supabaseAdmin.auth.admin.getUserById(user.id)` and checks `email_confirmed_at`; if null, returns `403 { error: 'email_not_verified', message: '...' }` before the quota/profile logic runs.
- **Desktop: `authService.ts`** — `signUp()` no longer returns a `StoredSession`; it returns `{ email }` and does not persist a session or call `/auth/me` (there are no tokens yet). New `resendConfirmation(email)` (POST `/auth/resend-confirmation`, resolves regardless of outcome) and `saveSessionTokens(accessToken, refreshToken)` (used by the `pagedge://auth/confirm` deep-link handler to persist the session Supabase mints once the email is confirmed).
- **Desktop: `AuthModal.tsx`** — gained a third `Mode`, `'verify-email'`. On successful signup, instead of calling `setUser`, the modal switches to this mode and shows "Check your inbox..." copy with the submitted email, a "Resend confirmation email" button (calls `resendConfirmation`, cooldown enforced server-side), and "Back to sign in". Sign-in flow is unchanged.
- **Desktop: email-verification toast** — new store slice (`emailVerifyToastOpen`, `showEmailVerifyToast`, `dismissEmailVerifyToast`) alongside the paywall slice. `aiService.ts`'s `callProxy()` now handles a `403 email_not_verified` response by calling `showEmailVerifyToast()` and throwing a friendly error (instead of the generic "AI proxy error 403" message). `App.tsx` renders `.app-toast--action` with a "Resend confirmation" button when this is open.
- **Desktop: `pagedge://auth/confirm` deep link** — handled in the same `onOpenUrl` listener as `stripe-success`/`stripe-cancel` (`App.tsx`). Supabase's confirmation redirect appends `access_token`/`refresh_token` as a URL fragment (implicit-grant shape, same as OAuth) — the handler parses `new URL(url).hash`, and if tokens are present calls the new store action `completeEmailVerification(accessToken, refreshToken)`, which persists the session via `saveSessionTokens` and sets `user`/`isAuthenticated` directly (no separate sign-in step needed). Falls back to `refreshUserFromMe()` if the link carries no tokens.
- **No changes to sign-in** — `signIn()`/`AuthModal`'s sign-in tab behave exactly as before. Existing users created before this change already have `email_confirmed_at` set (Supabase backfills it for pre-existing confirmed users), so they're unaffected.

### Step 18 — Flashcard Deck Manager ✅
- **Entry point** — the IconRail deck button now toggles a full **Deck Manager** main-area view (`deckManagerOpen` in the store, same pattern as `graphViewOpen`; the two setters are mutually exclusive and `selectPdf` resets both) instead of dumping straight into ReviewMode. Review is started from inside the manager.
- **`DeckManager.tsx`** — two-column layout: deck sidebar ("All cards", custom decks with hover rename/delete, "+ New deck", then auto per-PDF sections for *unfiled* highlight-sourced cards and a "Custom cards" section for unfiled custom ones) + card browser (text search over front/back, confidence filter pills, per-card Edit/Move-to/Delete actions shown on hover, "+ New card" composer, mastery bar via `deckMastery`, "Review (N)" button that calls `startReview(visibleCards)`). Source pill on PDF-sourced cards jumps via the existing `setPendingJumpPage` + `selectPdf` mechanism. All `.dm-*` CSS at the end of `App.css`.
- **`decks` table (local-only, never synced)** — `id`, `name`, `created_at`, `updated_at`. Commands: `create_deck`, `get_decks`, `rename_deck`, `delete_deck` (un-files its cards via `deck_id → NULL`, never deletes them).
- **`flashcards` schema change** — `source_highlight_id`/`pdf_id`/`page` are now **nullable** (custom cards have none) and a nullable `deck_id` column (FK → decks) was added. SQLite can't drop NOT NULL in place, so existing installs run a guarded table rebuild (create `flashcards_new` → copy → drop → rename, in a transaction with rollback-on-failure); the guard is a `pragma_table_info` notnull check, making it idempotent — fresh installs (created nullable) and already-rebuilt DBs skip it. `Flashcard` struct/TS type updated to `Option`/`| null` accordingly.
- **New commands** — `add_custom_flashcard(front, back, deck_id?)` and `assign_flashcard_deck(id, deck_id?)` (separate from `update_flashcard_fields` because COALESCE can't express "set to NULL"; deck moves deliberately do **not** bump `updated_at` — deck membership is local metadata and must never look like a content change to sync). `update_flashcard_fields` now bumps `updated_at` so front/back edits win `isNewer` conflict resolution.
- **Sync contract unchanged (deliberate)** — decks, `deck_id`, and custom cards are all local-only. `loadEntitiesForPush` filters custom cards defensively (they're already invisible to the pdf_id-scoped `get_flashcards`), `fromServerFlashcard` sets `deck_id: null` and `applyServerFlashcard` re-attaches the local deck assignment so pulls never clobber it (the DB-level `upsert_flashcard` ON CONFLICT SET list doesn't touch `deck_id` either). Custom cards never push and won't appear on other devices; full deck sync is a possible later step requiring a synced decks entity + `deck_id` in `FLASHCARD_FIELDS` + a Supabase migration.
- **Store** — `deckManagerOpen/setDeckManagerOpen`, `decks/loadDecks/createDeck/renameDeck/deleteDeck`, `allCards/loadAllCards` (whole-library card list backing the manager, replaced wholesale on open and kept patched by `addFlashcard`/`removeFlashcard`/`updateFlashcardLocal`). `updateFlashcardLocal` only schedules a push when a non-`deck_id` field changed; all flashcard push scheduling is guarded on `pdf_id` being non-null.
- **ReviewMode** — grading and "Jump to source" are null-guarded; the source link doesn't render for custom cards.

### Step 9 — Highlights Panel ✅
- Right sidebar tab (`HighlightsView` in `RightPanel.tsx`) lists all highlights in the current PDF sorted by page, click to jump to source, filter by lens color.

### Step 10 — Polish ✅
- Animations, hover effects, micro-interactions, keyboard shortcuts, onboarding empty states applied across the app. (Mac + Windows packaging moved to Step 10c, completed ahead of this.) In-app feedback button/modal (`feedbackService.ts`) also shipped as part of overall polish.

---

## Design System Reference

See `PRODUCT.md` for product strategy, user model, and design principles.
See `DESIGN.md` for color tokens, typography scale, spacing, and component specifications.

Both files are read by the `impeccable` skill (`/impeccable`) before any UI work. If either is missing, run `/impeccable init` first.
