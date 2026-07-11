import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import { embedQuery } from '../services/ingestionService';
import { bytesToFloat32, cosineSimilarity } from '../utils/embeddings';
import { HIGHLIGHT_COLORS, type HighlightColorKey } from '../constants/highlights';
import type { RawChunk } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SearchHit {
  sourceId: string;
  page: number;
  snippet: string;
  filename: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const COLOR_OPTIONS: Array<{ key: 'all' | HighlightColorKey; label: string }> = [
  { key: 'all',   label: 'All' },
  { key: 'yellow', label: 'Concepts' },
  { key: 'blue',   label: 'Revision' },
  { key: 'green',  label: 'Flashcards' },
  { key: 'pink',   label: 'Quotes' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function SearchModal() {
  const {
    searchModalOpen, setSearchModalOpen,
    pdfs, selectedPdfId, selectPdf,
    jumpToPage, setPendingJumpPage,
    highlights,
  } = useStore();

  const [query,       setQuery]       = useState('');
  const [hits,        setHits]        = useState<SearchHit[]>([]);
  const [searching,   setSearching]   = useState(false);
  const [scope,       setScope]       = useState<'all' | 'this'>('all');
  const [colorFilter, setColorFilter] = useState<'all' | HighlightColorKey>('all');

  const inputRef    = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Reset state and focus input on open
  useEffect(() => {
    if (!searchModalOpen) return;
    setQuery('');
    setHits([]);
    setSearching(false);
    setScope('all');
    setColorFilter('all');
    const id = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(id);
  }, [searchModalOpen]);

  // Escape to close
  useEffect(() => {
    if (!searchModalOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSearchModalOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchModalOpen, setSearchModalOpen]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setHits([]); return; }
    setSearching(true);
    try {
      const [queryVec, json] = await Promise.all([
        embedQuery(q.trim()),
        invoke<string>('get_all_chunks'),
      ]);
      const allChunks: RawChunk[] = JSON.parse(json);
      const qLower = q.trim().toLowerCase();

      // Scope filter
      const scopedChunks = scope === 'this' && selectedPdfId
        ? allChunks.filter(c => c.source_id === selectedPdfId)
        : allChunks;

      // ── Color-filtered mode: search within highlight selected_text only ───────
      if (scope === 'this' && colorFilter !== 'all') {
        const coloredHighlights = highlights.filter(h => h.color === colorFilter);

        // Build page → best semantic score using chunk embeddings as a proxy
        // (highlights have no stored embeddings; chunk scores approximate page relevance)
        const pageTopScore = new Map<number, number>();
        scopedChunks
          .filter(c => c.embedding.length > 0)
          .forEach(c => {
            const score = cosineSimilarity(queryVec, bytesToFloat32(c.embedding));
            if (score > (pageTopScore.get(c.page) ?? 0)) pageTopScore.set(c.page, score);
          });

        const toHlHit = (hl: typeof coloredHighlights[0]): SearchHit => {
          const pdf = pdfs.find(p => p.id === hl.pdf_id);
          return {
            sourceId: hl.pdf_id,
            page:     hl.page,
            snippet:  hl.selected_text.slice(0, 160).trimEnd(),
            filename: pdf?.filename ?? 'Unknown',
          };
        };

        // Semantic hits: highlights whose page scores ≥ 0.2
        const semanticHls = coloredHighlights
          .filter(hl => (pageTopScore.get(hl.page) ?? 0) >= 0.2)
          .sort((a, b) => (pageTopScore.get(b.page) ?? 0) - (pageTopScore.get(a.page) ?? 0))
          .slice(0, 10);

        // Text hits: selected_text contains the query string; deduplicated against semantic
        const seenIds = new Set(semanticHls.map(h => h.id));
        const textHls = coloredHighlights.filter(
          hl => !seenIds.has(hl.id) && hl.selected_text.toLowerCase().includes(qLower)
        );

        setHits([...semanticHls.map(toHlHit), ...textHls.map(toHlHit)].slice(0, 15));
        return;
      }

      // ── Default mode: search across chunk content ─────────────────────────────
      const toChunkHit = (chunk: RawChunk): SearchHit => {
        const pdf = pdfs.find(p => p.id === chunk.source_id);
        return {
          sourceId: chunk.source_id,
          page:     chunk.page,
          snippet:  chunk.content.slice(0, 160).trimEnd(),
          filename: pdf?.filename ?? 'Unknown',
        };
      };

      // Semantic hits: cosine similarity ≥ 0.2, top 10 by score
      const semanticHits: SearchHit[] = scopedChunks
        .filter(c => c.embedding.length > 0)
        .map(c => ({ chunk: c, score: cosineSimilarity(queryVec, bytesToFloat32(c.embedding)) }))
        .filter(({ score }) => score >= 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(({ chunk }) => toChunkHit(chunk));

      // Text hits: case-insensitive substring match; deduplicated against semantic results
      const seenKeys = new Set(semanticHits.map(h => `${h.sourceId}-${h.page}`));
      const textHitMap = new Map<string, SearchHit>();
      scopedChunks
        .filter(c => c.content.toLowerCase().includes(qLower))
        .forEach(c => {
          const key = `${c.source_id}-${c.page}`;
          if (!seenKeys.has(key) && !textHitMap.has(key)) textHitMap.set(key, toChunkHit(c));
        });

      setHits([...semanticHits, ...textHitMap.values()].slice(0, 15));
    } catch (err) {
      console.error('[search] failed:', err);
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [pdfs, selectedPdfId, scope, colorFilter, highlights]);

  // Debounce: 300 ms after last keystroke
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) { setHits([]); setSearching(false); return; }
    setSearching(true);
    debounceRef.current = setTimeout(() => runSearch(query), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, runSearch]);

  const handleHitClick = (hit: SearchHit) => {
    setSearchModalOpen(false);
    if (hit.sourceId !== selectedPdfId) {
      // Different PDF: select it and queue a page jump for after it loads
      setPendingJumpPage(hit.page);
      selectPdf(hit.sourceId);
    } else {
      // Same PDF: jump directly using the already-registered scroll fn
      jumpToPage?.(hit.page);
    }
  };

  if (!searchModalOpen) return null;

  const hasQuery = query.trim().length > 0;

  return (
    <div className="search-overlay" onMouseDown={() => setSearchModalOpen(false)}>
      <div className="search-modal" onMouseDown={e => e.stopPropagation()}>

        {/* ── Input ── */}
        <div className="search-input-row">
          <svg className="search-input-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search your documents…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            spellCheck={false}
          />
          {searching && <span className="pdf-status-spinner search-spinner" />}
          {!searching && hasQuery && (
            <button className="search-clear-btn" onClick={() => setQuery('')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* ── Filters ── */}
        <div className="search-filters">
          <div className="search-scope">
            <button
              className={`search-scope-btn${scope === 'all' ? ' search-scope-btn--active' : ''}`}
              onClick={() => { setScope('all'); setColorFilter('all'); }}
            >All PDFs</button>
            <button
              className={`search-scope-btn${scope === 'this' ? ' search-scope-btn--active' : ''}`}
              onClick={() => setScope('this')}
              disabled={!selectedPdfId}
              title={selectedPdfId ? 'Limit to current PDF' : 'Open a PDF first'}
            >This PDF</button>
          </div>

          {scope === 'this' && (
            <div className="search-color-filter">
              {COLOR_OPTIONS.map(({ key, label }) => {
                const isAll = key === 'all';
                const color = isAll ? null : HIGHLIGHT_COLORS[key];
                return (
                  <button
                    key={key}
                    className={`search-color-btn${colorFilter === key ? ' search-color-btn--active' : ''}`}
                    onClick={() => setColorFilter(key)}
                    style={color ? ({ '--filter-color': color.hex } as React.CSSProperties) : undefined}
                    title={label}
                  >
                    {!isAll && <span className="search-color-dot" />}
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Results ── */}
        <div className="search-results">
          {!hasQuery && (
            <p className="search-empty search-empty--idle">Type to search across your documents</p>
          )}
          {hasQuery && !searching && hits.length === 0 && (
            <p className="search-empty">No results for &ldquo;{query}&rdquo;</p>
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.sourceId}-${hit.page}-${i}`}
              className="search-hit"
              onClick={() => handleHitClick(hit)}
            >
              <div className="search-hit-header">
                <span className="search-hit-filename">{hit.filename}</span>
                <span className="search-hit-page">p.{hit.page}</span>
              </div>
              <p className="search-hit-snippet">{hit.snippet}</p>
            </button>
          ))}
        </div>

        {/* ── Footer hint ── */}
        <div className="search-footer">
          <kbd>↵</kbd> open&nbsp;&nbsp;<kbd>Esc</kbd> close
        </div>
      </div>
    </div>
  );
}
