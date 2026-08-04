# Pagedge

A desktop PDF reader built around the idea that highlights should become structured, searchable knowledge instead of disposable colored marks.

Pagedge is a Tauri 2 + React + Rust application. You import PDFs, highlight with four fixed semantic colors, take notes, chat with a document (with real conversational memory), search semantically across your whole library, and see a force-directed "Knowledge Map" of how your documents, notes, and flashcards relate to each other — all backed by a local SQLite database and local embeddings, with optional Pro-tier cloud sync across devices.

This repo is the desktop client. It's one of three repos behind the live product — a Next.js API backend (auth, Stripe billing, AI proxy, cross-device sync) and a static marketing site are kept separate and aren't part of this repo.

## Why this exists

Most PDF readers treat highlighting as a throwaway action — colored spans that live and die inside one file. Pagedge treats every highlight, note, and flashcard as a first-class row in a local knowledge base: it's queryable, embeddable, linkable, and exportable, and it survives across every PDF you've ever opened.

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (Rust + WebView2/WKWebView) |
| Frontend | React 18, TypeScript, Vite |
| Local database | SQLite via `rusqlite` (bundled), migrated at startup |
| State | Zustand |
| PDF rendering | `pdfjs-dist` (canvas + text layer) |
| OCR | `tesseract-wasm`, self-hosted worker, runs only on pages with no embedded text |
| Local embeddings | `@huggingface/transformers`, running in a Web Worker (no network round trip per query) |
| Markdown / math | `@uiw/react-md-editor` + `remark-math`/`rehype-katex` (KaTeX) |
| Crash reporting | Sentry (JS + Rust) |

## Selected engineering details

A few things that were harder than they look and might be worth a closer read:

- **Resolution-independent highlighting.** Every highlight is stored in PDF point space, not screen or canvas pixels, so a highlight drawn at 100% zoom lands in exactly the same place at 300% zoom or on a different monitor's DPI. Cross-page selections and overlapping same-color highlights are both handled — overlaps split into per-line stripes instead of double-drawing, and re-highlighting an already-highlighted span only stores the uncovered portion.
- **Cancellable, race-free page rendering.** PDF.js render tasks are async and page-by-page; switching documents mid-render (or scrolling fast) used to leave stale pages on screen. A render-generation counter checked at every `await` boundary, plus explicit cancellation of in-flight `RenderTask`/`TextLayer` objects, makes document switches always land on the correct state.
- **Local-first ingestion pipeline.** On import: extract text, OCR any page that came back empty (scanned/image-only pages), chunk, embed via a local transformer model in a Web Worker, and store raw embedding blobs in SQLite — all without a network call, and without blocking the UI thread.
- **Cross-device sync with real conflict resolution.** Highlights/notes/flashcards sync in the background (Pro tier), matched across devices by a content hash of the PDF file rather than a server-assigned ID. Writes are version-gated server-side (a stale push is rejected with the current server row, not silently overwritten), and the client resolves the conflict — this is deliberately not last-writer-wins at the HTTP layer.
- **Annotated PDF export.** Highlights, freehand drawings, and text boxes get written back into a real PDF as standard annotation objects (`/Highlight` QuadPoints, `/Ink`, `/Line`, `/Square`, `/FreeText`), so the exported file opens correctly in any PDF viewer, not just Pagedge.

## Core features

- PDF library with folders/collections, trash + restore, pinning, last-page tracking
- Four fixed semantic highlight colors (important / revisit / flashcard / quote), overlap-aware rendering
- Notes with Markdown + LaTeX, source-page citations, tags, autosave
- Chat with a single PDF or globally across the whole library, both with persistent tier-aware conversational memory
- Semantic search across one or all PDFs
- Knowledge Map — force-directed graph of documents/notes/flashcards with citation, tag, and embedding-similarity edges
- Flashcard generation from highlights, custom decks, confidence-based (not spaced-repetition) review
- Freehand drawing (pen/arrow/rectangle/circle) and text-box annotations
- Annotated PDF export
- Optional Pro-tier cross-device sync and custom AI provider support (Ollama, OpenAI, Groq, Gemini, OpenRouter, and other OpenAI-compatible endpoints)

## Running it locally

```bash
pnpm install
pnpm tauri dev
```

Requires the standard [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform (Rust toolchain, WebView2 on Windows, etc.). AI features fall back to a local Ollama endpoint by default if no backend/API key is configured; most of the app (library, viewer, highlights, notes, drawing, export) works fully offline.

## How this was built

Built solo, with [Claude Code](https://claude.com/claude-code) as a pair-programming tool throughout — architecture decisions, the Rust/Tauri backend, the sync protocol, and the UI were all driven interactively rather than autogenerated wholesale. The commit history reflects the actual incremental build order.

## License

Source is provided for portfolio and reference purposes — see [LICENSE](./LICENSE). Not open for commercial reuse without permission.
