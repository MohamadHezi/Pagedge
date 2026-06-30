# Pagedge Design Specification: Academic Obsidian

## Theme & Visual Direction
Pagedge reads as a high-density, precise academic workstation. The visual language balances traditional scholarly authority with modern tool interfaces. The environment is dark-only with no light mode or system overrides. 

The color strategy relies on a rich, warm sepia/obsidian surface ramp. The white PDF canvas acts as the primary illuminated reading plane, while all surrounding chrome recedes into deep, organic dark tones. Interactivity is anchored by a glowing gold/warm-amber accent system.

---

## Color Tokens & Variables
All tokens must be defined as CSS custom properties in `src/index.css`. Tailwind utilities may be used, but components must read directly from these custom properties in `src/App.css` or inline styles to maintain theme integrity.

### Surface Ramp (Warm Obsidian)
| Token | Value | Role / Usage |
| :--- | :--- | :--- |
| `--bg-surface` | `#19120a` | Global default background, left nav background |
| `--bg-surface-dim` | `#19120a` | Main central canvas workspace background |
| `--bg-surface-bright` | `#40382e` | Highlighted or active surface layers |
| `--bg-container-lowest` | `#130d06` | Far-left icon strip, Right notes panel background |
| `--bg-container-low` | `#211a12` | De-emphasized containers, cards, item backgrounds |
| `--bg-container` | `#251e16` | Standard structural panels and toolbars |
| `--bg-container-high` | `#302920` | Tooltips, popovers, elevated context menus |
| `--bg-container-highest`| `#3c332a` | Dialogs, explicit modal backgrounds |

### Text & Interface Lines
| Token | Value | Role / Usage |
| :--- | :--- | :--- |
| `--text-primary` | `#eee0d2` | Primary readable text, active labels, body bone tone |
| `--text-secondary` | `#d7c3ae` | Secondary metadata, muted labels, secondary actions |
| `--border` | `#9f8e7a` | Default crisp layout borders, active focus state lines |
| `--border-subtle` | `#524534` | Subdued separators, tile dividers, structural lines |

### Interactive Accents
| Token | Value | Role / Usage |
| :--- | :--- | :--- |
| `--accent` | `#ffc880` | Primary interactive color, focused text rings, glyph glow |
| `--accent-container` | `#f5a623` | Active selections, prominent call-to-actions background |

### Semantic Highlight Colors
Defined in `src/constants/highlights.ts` as `HIGHLIGHT_COLORS`. Canvas engines and inline style markers must call `HIGHLIGHT_COLORS[key].hex`.
*   `yellow` (`#FFD60A`): Important / key concepts (Primary highlight color)
*   `blue` (`#4DA6FF`): Confused / need to revisit (Confusion / revision marker)
*   `green` (`#34C759`): Add to flashcards (Flashcard candidate)
*   `pink` (`#FF6B9D`): Quotes / citations worth keeping (Quotable passages)

---

## Typography
Pagedge utilizes an intentional dual-font pairing strategy to establish an academic hierarchy.

*   **Display & Headings:** **Newsreader**, serif. Used for headlines, section headings, and primary workspace titles to project academic authority.
*   **UI Text & Editor Body:** **Hanken Grotesk**, sans-serif. Used for all functional UI chrome, menus, buttons, lists, and the text editor body.

### Font Scale & Tracking
| Role | Font Family | Size | Weight | Usage |
| :--- | :--- | :--- | :--- | :--- |
| App Display | Newsreader | `48px` / `3rem` | 600 | Title layouts, high-level headers |
| Section Title | Newsreader | `14px` / `0.875rem`| 600 | Component titles, key module headers |
| Label Caps | Hanken Grotesk| `12px` / `0.75rem` | 600 | Uppercase headers, `letter-spacing: 0.08em` |
| UI Body / Base| Hanken Grotesk| `16px` / `1rem` | 400 | Default text, inputs, editor blocks |
| UI Small | Hanken Grotesk| `12px` / `0.75rem` | 400 | Captions, metadata, low-importance details |

*Numerical Display Rule:* Apply `font-variant-numeric: tabular-nums` to all changing numerical indicators (page counters, zoom percentages, timestamps).

---

## Spacing & Layout Rhythm
Layout alignments follow a strict grid definition to control information density:
*   `micro-gap`: `2px` — Vertical tile stacking channels, tight intra-component dividers.
*   `unit`: `4px` — Icon internal padding, badge spacing, minimal gaps.
*   `gutter`: `16px` — Standard padding inside panels, margins between text groups.
*   `page-well`: `24px` — Outer structural padding framing the central PDF canvas.

---

## App Shell Architecture

The application layout is built around a layered, 4-panel vertical structure. Overflow on the global body must be `hidden`; each panel manages its own internal scrolling mechanics. Sections are separated by distinct `micro-gap` (2px) channels to express structural depth.

┌──────┬────────────┬────────────────────────────┬────────────┐
│ Icon │ Navigation │ Central Canvas Workspace   │ Notes      │
│ Strip│ Panel      │                            │ Panel      │
│ 48px │ 240px      │ (ViewerToolbar: 40px)      │ 300px      │
│      │            │                            │            │
│ --bg-│ --bg-      │ PDF Display Layer          │ --bg-      │
│lowest│ surface    │ (--bg-surface-dim well)    │ lowest     │
└──────┴────────────┴────────────────────────────┴────────────┘

### 1. Far-Left Global Icon Strip (Width: 48px)
*   **Background:** `--bg-container-lowest`.
*   **Top Cluster Layout:** Holds 4 minimalist glyphs: 1. Library (Active by default), 2. Semantic Search, 3. Flashcard Decks, 4. AI Prompt Engine.
*   **Bottom Cluster Layout:** Holds Settings Gear and User Profile.
*   **Active Interaction State:** Active selections use a soft, low-opacity warm amber pill background overlayed with a glowing gold tint (`--accent`) applied to the icon glyph.

### 2. Left Navigation Panel (Width: 240px)
*   **Background:** `--bg-surface`.
*   **Structure:** Implements a 4-part hybrid tree structure using `micro-gap` (2px) vertical stacking to produce a polished "stacked tile" look.
    *   *Section 1:* 📌 PINNED documents.
    *   *Section 2:* 📁 COLLECTIONS folder directory tree.
    *   *Section 3:* 🔍 QUICK VIEWS holding automated text lens filters (Recent, Flashcard Documents, Citations & Quotes).
    *   *Section 4:* Bottom-docked "+ New Entry" button tile and low-contrast "Archive & Trash" row.

### 3. Central Canvas Workspace
*   **Background:** `--bg-surface-dim`.
*   **Viewer Toolbar:** Fixed 40px height container at top.
*   **PDF Scroll Well:** Central column with a 16px gap between documents, padded with 24px on all sides. PDF pages are mounted against this space. Each page wrapper retains a `box-shadow: 0 2px 16px rgba(0,0,0,0.5)`.

### 4. Right Notes Panel (Width: 300px)
*   **Background:** `--bg-container-lowest`.
*   **Features:** Houses the rich Markdown editor interface. Displays inline, color-coded circular citation badges that programmatically match the source document's highlight color token.

---

## Component Specifications

### Contextual Annotation Dock
Narrow, vertical capsule toolbar anchored dynamically against the right edge of the white paper PDF page layer.
*   **Styling:** Heavy glassmorphism layer (`backdrop-filter: blur(20px)`, `opacity: 0.6` against `--bg-surface`).
*   **Content:** Houses vertical quick-toggles for reader drawing tools (Freehand Pen, Highlighter, Square, Circle, Text Box).

### Canvas Annotation Rendering
Highlight graphics use `mix-blend-mode: multiply` on the white-base canvas surface. White space remains transparent, while colors tint the underlying PDF text layer like physical ink.
*   **Background shapes:** Applied using `ctx.roundRect` with a 3px border radius.
*   **Split-Underline elements:** Rendered at a height of 3px with a 1.5px corner radius.

### Sidebar List Items
*   **Class:** `.pdf-item`
*   **Layout:** Flex row, 6px gap, 6px 8px padding, 6px border-radius.
*   **States:** 
    *   Default: `--text-secondary`
    *   Hover: `--bg-container-low` background, `--text-primary`
    *   Selected: `--bg-container-bright` background, text scales to color `--accent`.

---

## Motion & Responsiveness
*   **Default State Transitions:** All structural color, state transitions, and background shifts run between 100ms and 150ms using standard ease curves.
*   **Reduced Motion:** Under `@media (prefers-reduced-motion: reduce)`, all CSS transitions drop instantly to 0ms. Canvas rendering engine operations are unaffected by this setting.

### Z-Index Scale Hierarchy
1   — .hl-canvas (Highlight overlay layer, directly above raw PDF canvas)
1   — .drawing-canvas in read mode (same z-index as hl-canvas, renders above it via DOM order; pointer-events: none)
2   — .textLayer (Interactive text selection layer, positioned above highlights and drawings in read mode)
3   — .drawing-canvas in draw mode (floats above .textLayer; pointer-events: auto so all input lands on it; textLayer gets pointer-events: none)
10  — .lens-switcher / .annotation-dock (Sticky workspace overlays)
100 — Dropdowns, zoom control selection menus
500 — Floating color-picker pill, highlight context popups