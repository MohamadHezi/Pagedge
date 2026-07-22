import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import { deckMastery } from '../services/flashcardService';
import type { Flashcard } from '../types';

// Sidebar selection encoded as a string key: 'all' | 'custom' (unfiled
// user-authored cards) | 'deck:<id>' | 'pdf:<id>'. PDF sections only show
// cards NOT filed into a custom deck, so filing a card moves it visually.
type SelectionKey = string;

const CONFIDENCE_LABELS = ['Unreviewed', 'Low', 'Medium', 'Mastered'] as const;

function confidenceClass(level: number): string {
  return `dm-conf dm-conf--${Math.max(0, Math.min(3, level))}`;
}

export function DeckManager() {
  const {
    pdfs,
    decks,
    allCards,
    loadDecks,
    loadAllCards,
    createDeck,
    renameDeck,
    deleteDeck,
    addFlashcard,
    removeFlashcard,
    updateFlashcardLocal,
    startReview,
    setDeckManagerOpen,
  } = useStore();

  const [selection, setSelection] = useState<SelectionKey>('all');
  const [search, setSearch] = useState('');
  const [confidenceFilter, setConfidenceFilter] = useState<number | null>(null);

  const [creatingDeck, setCreatingDeck] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [renamingDeckId, setRenamingDeckId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [moveMenuCardId, setMoveMenuCardId] = useState<string | null>(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerFront, setComposerFront] = useState('');
  const [composerBack, setComposerBack] = useState('');
  const [composerSaving, setComposerSaving] = useState(false);

  const newDeckInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAllCards();
    loadDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the move-to-deck menu on any outside click.
  useEffect(() => {
    if (!moveMenuCardId) return;
    const close = () => setMoveMenuCardId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [moveMenuCardId]);

  const pdfNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pdfs) m.set(p.id, p.filename.replace(/\.pdf$/i, ''));
    return m;
  }, [pdfs]);

  // PDF sections cover unfiled highlight-sourced cards; a "Custom cards"
  // section appears only if unfiled custom cards exist.
  const pdfSections = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of allCards) {
      if (c.deck_id || !c.pdf_id) continue;
      counts.set(c.pdf_id, (counts.get(c.pdf_id) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, count, name: pdfNameById.get(id) ?? 'Unknown PDF' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allCards, pdfNameById]);

  const unfiledCustomCount = useMemo(
    () => allCards.filter((c) => !c.deck_id && !c.pdf_id).length,
    [allCards]
  );

  const deckCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of allCards) {
      if (c.deck_id) counts.set(c.deck_id, (counts.get(c.deck_id) ?? 0) + 1);
    }
    return counts;
  }, [allCards]);

  const selectionCards = useMemo(() => {
    if (selection === 'all') return allCards;
    if (selection === 'custom') return allCards.filter((c) => !c.deck_id && !c.pdf_id);
    if (selection.startsWith('deck:')) {
      const id = selection.slice(5);
      return allCards.filter((c) => c.deck_id === id);
    }
    if (selection.startsWith('pdf:')) {
      const id = selection.slice(4);
      return allCards.filter((c) => c.pdf_id === id && !c.deck_id);
    }
    return allCards;
  }, [allCards, selection]);

  const visibleCards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return selectionCards.filter((c) => {
      if (confidenceFilter !== null && c.confidence_level !== confidenceFilter) return false;
      if (q && !c.front.toLowerCase().includes(q) && !c.back.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [selectionCards, search, confidenceFilter]);

  const mastery = deckMastery(selectionCards);

  const selectionTitle = useMemo(() => {
    if (selection === 'all') return 'All cards';
    if (selection === 'custom') return 'Custom cards';
    if (selection.startsWith('deck:')) return decks.find((d) => d.id === selection.slice(5))?.name ?? 'Deck';
    if (selection.startsWith('pdf:')) return pdfNameById.get(selection.slice(4)) ?? 'PDF';
    return 'All cards';
  }, [selection, decks, pdfNameById]);

  // ── Deck CRUD handlers ─────────────────────────────────────────────────────

  const handleCreateDeck = async () => {
    const name = newDeckName.trim();
    if (!name) {
      setCreatingDeck(false);
      setNewDeckName('');
      return;
    }
    try {
      const deck = await createDeck(name);
      setSelection(`deck:${deck.id}`);
    } catch (err) {
      console.error('[decks] create failed', err);
    }
    setCreatingDeck(false);
    setNewDeckName('');
  };

  const handleRenameDeck = async (id: string) => {
    const name = renameValue.trim();
    setRenamingDeckId(null);
    if (!name) return;
    try {
      await renameDeck(id, name);
    } catch (err) {
      console.error('[decks] rename failed', err);
    }
  };

  const handleDeleteDeck = async (id: string) => {
    try {
      await deleteDeck(id);
      if (selection === `deck:${id}`) setSelection('all');
    } catch (err) {
      console.error('[decks] delete failed', err);
    }
  };

  // ── Card handlers ──────────────────────────────────────────────────────────

  const beginEdit = (card: Flashcard) => {
    setEditingCardId(card.id);
    setEditFront(card.front);
    setEditBack(card.back);
  };

  const saveEdit = async () => {
    if (!editingCardId) return;
    const front = editFront.trim();
    const back = editBack.trim();
    if (!front || !back) return;
    try {
      const json = await invoke<string>('update_flashcard_fields', { id: editingCardId, front, back });
      const updated = JSON.parse(json) as Flashcard;
      updateFlashcardLocal(editingCardId, { front: updated.front, back: updated.back, updated_at: updated.updated_at });
    } catch (err) {
      console.error('[decks] card edit failed', err);
    }
    setEditingCardId(null);
  };

  const handleDeleteCard = async (id: string) => {
    try {
      await invoke('delete_flashcard', { id });
      removeFlashcard(id);
    } catch (err) {
      console.error('[decks] card delete failed', err);
    }
  };

  const handleMoveCard = async (cardId: string, deckId: string | null) => {
    setMoveMenuCardId(null);
    try {
      await invoke<string>('assign_flashcard_deck', { id: cardId, deckId });
      updateFlashcardLocal(cardId, { deck_id: deckId });
    } catch (err) {
      console.error('[decks] card move failed', err);
    }
  };

  const handleAddCustomCard = async () => {
    const front = composerFront.trim();
    const back = composerBack.trim();
    if (!front || !back || composerSaving) return;
    setComposerSaving(true);
    try {
      const deckId = selection.startsWith('deck:') ? selection.slice(5) : null;
      const json = await invoke<string>('add_custom_flashcard', { front, back, deckId });
      addFlashcard(JSON.parse(json) as Flashcard);
      setComposerFront('');
      setComposerBack('');
      setComposerOpen(false);
    } catch (err) {
      console.error('[decks] custom card create failed', err);
    }
    setComposerSaving(false);
  };

  const handleSourceJump = (card: Flashcard) => {
    if (!card.pdf_id || card.page == null) return;
    // DeckManager fully replaces MainArea while open, so no PdfViewer is
    // mounted to jump within directly — always queue via pendingJumpPage(B)
    // and let whichever pane it belongs to consume it once PdfViewer
    // (re)mounts after this view closes. A jump not already open anywhere
    // targets the focused pane, same rule SearchModal/GraphView follow.
    const s = useStore.getState();
    if (card.pdf_id === s.selectedPdfId) {
      s.setPendingJumpPage(card.page);
      s.focusPane('A');
    } else if (card.pdf_id === s.paneB?.pdfId) {
      s.setPendingJumpPageB(card.page);
      s.focusPane('B');
    } else if (s.focusedPane === 'A') {
      s.setPendingJumpPage(card.page);
      s.selectPdf(card.pdf_id);
    } else {
      s.setPendingJumpPageB(card.page);
      s.openPaneB(card.pdf_id);
    }
    setDeckManagerOpen(false);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const sidebarRow = (key: SelectionKey, label: string, count: number) => (
    <button
      key={key}
      className={`dm-deck-row${selection === key ? ' dm-deck-row--active' : ''}`}
      onClick={() => setSelection(key)}
    >
      <span className="dm-deck-name">{label}</span>
      <span className="dm-deck-count">{count}</span>
    </button>
  );

  return (
    <div className="deck-manager">
      {/* ── Deck sidebar ── */}
      <aside className="dm-sidebar">
        <div className="dm-sidebar-header">Decks</div>

        {sidebarRow('all', 'All cards', allCards.length)}

        {decks.map((deck) =>
          renamingDeckId === deck.id ? (
            <div key={deck.id} className="dm-deck-row dm-deck-row--editing">
              <input
                className="dm-inline-input"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameDeck(deck.id);
                  if (e.key === 'Escape') setRenamingDeckId(null);
                }}
                onBlur={() => handleRenameDeck(deck.id)}
              />
            </div>
          ) : (
            <div
              key={deck.id}
              className={`dm-deck-row${selection === `deck:${deck.id}` ? ' dm-deck-row--active' : ''}`}
              onClick={() => setSelection(`deck:${deck.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setSelection(`deck:${deck.id}`)}
            >
              <span className="dm-deck-name">{deck.name}</span>
              <span className="dm-deck-actions">
                <button
                  className="dm-icon-btn"
                  title="Rename deck"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingDeckId(deck.id);
                    setRenameValue(deck.name);
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                </button>
                <button
                  className="dm-icon-btn"
                  title="Delete deck (cards are kept)"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteDeck(deck.id);
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  </svg>
                </button>
              </span>
              <span className="dm-deck-count">{deckCounts.get(deck.id) ?? 0}</span>
            </div>
          )
        )}

        {creatingDeck ? (
          <div className="dm-deck-row dm-deck-row--editing">
            <input
              ref={newDeckInputRef}
              className="dm-inline-input"
              placeholder="Deck name…"
              value={newDeckName}
              autoFocus
              onChange={(e) => setNewDeckName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateDeck();
                if (e.key === 'Escape') {
                  setCreatingDeck(false);
                  setNewDeckName('');
                }
              }}
              onBlur={handleCreateDeck}
            />
          </div>
        ) : (
          <button className="dm-new-deck-btn" onClick={() => setCreatingDeck(true)}>
            + New deck
          </button>
        )}

        {(pdfSections.length > 0 || unfiledCustomCount > 0) && (
          <div className="dm-sidebar-section-label">From your library</div>
        )}
        {pdfSections.map((s) => sidebarRow(`pdf:${s.id}`, s.name, s.count))}
        {unfiledCustomCount > 0 && sidebarRow('custom', 'Custom cards', unfiledCustomCount)}
      </aside>

      {/* ── Card browser ── */}
      <section className="dm-main">
        <header className="dm-header">
          <div className="dm-header-text">
            <h2 className="dm-title">{selectionTitle}</h2>
            <span className="dm-meta">
              {selectionCards.length} card{selectionCards.length === 1 ? '' : 's'}
              {mastery.total > 0 && <> · {mastery.mastered}/{mastery.total} mastered · {mastery.percent}%</>}
            </span>
            {mastery.total > 0 && (
              <div className="dm-mastery-bar">
                <div className="dm-mastery-fill" style={{ width: `${mastery.percent}%` }} />
              </div>
            )}
          </div>
          <div className="dm-header-actions">
            <button className="dm-btn" onClick={() => setComposerOpen((v) => !v)}>
              + New card
            </button>
            <button
              className="dm-btn dm-btn--primary"
              disabled={visibleCards.length === 0}
              onClick={() => startReview(visibleCards)}
            >
              Review {visibleCards.length > 0 ? `(${visibleCards.length})` : ''}
            </button>
          </div>
        </header>

        <div className="dm-toolbar">
          <input
            className="dm-search"
            placeholder="Search cards…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="dm-filter-row">
            {CONFIDENCE_LABELS.map((label, level) => (
              <button
                key={label}
                className={`dm-filter-pill${confidenceFilter === level ? ' dm-filter-pill--active' : ''}`}
                onClick={() => setConfidenceFilter(confidenceFilter === level ? null : level)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {composerOpen && (
          <div className="dm-composer">
            <textarea
              className="dm-composer-input"
              placeholder="Front — the question or prompt"
              value={composerFront}
              autoFocus
              rows={2}
              onChange={(e) => setComposerFront(e.target.value)}
            />
            <textarea
              className="dm-composer-input"
              placeholder="Back — the answer"
              value={composerBack}
              rows={2}
              onChange={(e) => setComposerBack(e.target.value)}
            />
            <div className="dm-composer-actions">
              <span className="dm-composer-hint">
                {selection.startsWith('deck:')
                  ? `Will be added to "${selectionTitle}"`
                  : 'Will be added to Custom cards'}
              </span>
              <button className="dm-btn" onClick={() => setComposerOpen(false)}>Cancel</button>
              <button
                className="dm-btn dm-btn--primary"
                disabled={!composerFront.trim() || !composerBack.trim() || composerSaving}
                onClick={handleAddCustomCard}
              >
                Add card
              </button>
            </div>
          </div>
        )}

        <div className="dm-card-list">
          {visibleCards.length === 0 && (
            <div className="dm-empty">
              {allCards.length === 0 ? (
                <>
                  <p className="dm-empty-title">No flashcards yet</p>
                  <p className="dm-empty-hint">
                    Highlight text in green while reading, then use "Generate Flashcards" — or create a custom card here.
                  </p>
                </>
              ) : (
                <p className="dm-empty-title">No cards match</p>
              )}
            </div>
          )}

          {visibleCards.map((card) =>
            editingCardId === card.id ? (
              <div key={card.id} className="dm-card dm-card--editing">
                <textarea
                  className="dm-composer-input"
                  value={editFront}
                  autoFocus
                  rows={2}
                  onChange={(e) => setEditFront(e.target.value)}
                />
                <textarea
                  className="dm-composer-input"
                  value={editBack}
                  rows={2}
                  onChange={(e) => setEditBack(e.target.value)}
                />
                <div className="dm-composer-actions">
                  <button className="dm-btn" onClick={() => setEditingCardId(null)}>Cancel</button>
                  <button
                    className="dm-btn dm-btn--primary"
                    disabled={!editFront.trim() || !editBack.trim()}
                    onClick={saveEdit}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div key={card.id} className="dm-card">
                <div className="dm-card-front">{card.front}</div>
                <div className="dm-card-back">{card.back}</div>
                <div className="dm-card-meta">
                  <span className={confidenceClass(card.confidence_level)}>
                    {CONFIDENCE_LABELS[Math.max(0, Math.min(3, card.confidence_level))]}
                  </span>
                  {card.pdf_id && card.page != null && (
                    <button className="dm-source-pill" onClick={() => handleSourceJump(card)}>
                      p. {card.page} · {pdfNameById.get(card.pdf_id) ?? 'PDF'}
                    </button>
                  )}
                  {card.deck_id && selection === 'all' && (
                    <span className="dm-deck-tag">{decks.find((d) => d.id === card.deck_id)?.name}</span>
                  )}
                  <span className="dm-card-actions">
                    <button className="dm-card-action" onClick={() => beginEdit(card)}>Edit</button>
                    <span className="dm-move-wrap">
                      <button
                        className="dm-card-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoveMenuCardId(moveMenuCardId === card.id ? null : card.id);
                        }}
                      >
                        Move to…
                      </button>
                      {moveMenuCardId === card.id && (
                        <div className="dm-move-menu" onClick={(e) => e.stopPropagation()}>
                          {card.deck_id && (
                            <button className="dm-move-item" onClick={() => handleMoveCard(card.id, null)}>
                              {card.pdf_id ? 'No deck (back to its PDF)' : 'No deck'}
                            </button>
                          )}
                          {decks
                            .filter((d) => d.id !== card.deck_id)
                            .map((d) => (
                              <button key={d.id} className="dm-move-item" onClick={() => handleMoveCard(card.id, d.id)}>
                                {d.name}
                              </button>
                            ))}
                          {decks.filter((d) => d.id !== card.deck_id).length === 0 && !card.deck_id && (
                            <div className="dm-move-empty">No decks yet</div>
                          )}
                        </div>
                      )}
                    </span>
                    <button className="dm-card-action dm-card-action--danger" onClick={() => handleDeleteCard(card.id)}>
                      Delete
                    </button>
                  </span>
                </div>
              </div>
            )
          )}
        </div>
      </section>
    </div>
  );
}
