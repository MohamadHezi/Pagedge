# Product

## Register

product

## Users

Knowledge workers who read PDFs seriously: researchers, graduate students, analysts, lawyers, medical professionals, and engineers who annotate technical literature. They read for retention, not skimming. They open the same document multiple times and expect to pick up exactly where they left off. They are fluent with tools like Notion, Zotero, Obsidian, Readwise, and Linear. They are frustrated that no existing PDF reader treats highlights as structured data.

Primary context: focused work sessions at a desk, often alongside other apps. Single-monitor or ultrawide. No ambient distractions should come from the app itself.

## Product Purpose

Pagedge turns a passive PDF viewer into an active knowledge base. Highlights are typed — not just colored — so every annotation carries semantic intent (concept, confusion, flashcard candidate, quotable). Over time, the highlight corpus becomes queryable: the AI panel surfaces connections, generates flashcard decks, and retrieves exact passages on demand.

Success looks like: a user opens Pagedge instead of Preview or Acrobat because their highlights are *there*, organized, and useful — not a visual artifact that disappears when the file closes.

## Brand Personality

**Precise. Disciplined. Trusted.**

The tool must feel like a serious instrument, not a productivity-app. No pastel gradients, no confetti, no "welcome back!" microcopy. Closer to a well-designed IDE than a consumer note-taker. The four highlight colors are the only permission to be expressive — everything else recedes.

Anti-adjectives: playful, approachable, friendly, casual, minimal-for-minimal's-sake.

## Anti-references

- **Notability / GoodNotes** — too consumer, too skeuomorphic, too iPad-first. Stylus affordances have no place here.
- **Adobe Acrobat** — bloated, legacy chrome, enterprise-grim.
- **Kindle highlights** — passive, no structure, annotations trapped in Amazon's ecosystem.
- **Notion** — block editor paradigm bleeds into everything; wrong mental model for a reading tool.
- **Obsidian** — plugin ecosystem as UX strategy; configuration burden before usefulness.

References (what to aspire to, not copy):
- **Linear** — information density done right; no wasted chrome; dark-by-default; system feels alive.
- **Raycast** — power-tool UX that disappears into the task; keyboard-first but never exclusionary.
- **Bear** — typographic care; the reading experience IS the product UI.

## Design Principles

1. **The document is the hero.** Every UI decision that pulls attention away from the PDF content is a failure. Chrome — toolbars, panels, popups — earns its space or gets removed.

2. **Annotations are first-class data, not visual decoration.** Color is semantic, not aesthetic. Yellow means something specific. The system enforces this by design (fixed 4-color vocabulary, typed labels, structured storage).

3. **Zero-surprise interaction model.** Text selection → color picker → highlight. Click highlight → detail. No hidden gestures, no multi-step flows, no settings required to get value. The first session should feel immediately familiar.

4. **Power without configuration.** The tool ships opinionated and complete. Defaults are the product. Options exist where workflows genuinely diverge (zoom level, page layout), not where they don't.

5. **Earn the right panel.** The AI / notes panel on the right is invisible until the user has a reason to open it. Never show empty state panels. Never show "coming soon" chrome.

## Accessibility & Inclusion

- WCAG AA minimum for all text and interactive elements. Dark-only theme means contrast is the primary risk — validate every text/background pair.
- Keyboard navigable for all primary actions. Mouse is the expected input but should never be required for core reading + highlighting workflow.
- `prefers-reduced-motion`: all transitions have a zero-motion fallback. No animation is load-bearing.
- No color-only information encoding. The four highlight colors are supported by text labels in all detail views.
