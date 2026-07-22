import { useEffect, useRef, useState } from 'react';
import { MathMarkdown } from './MathMarkdown';
import { useStore } from '../store';
import { callAI, windowChatHistory } from '../services/aiService';
import { buildGlobalContext, buildLibraryListing, extractCitations } from '../services/globalChatService';
import type { ChatCitation } from '../types';

const GLOBAL_CHAT_SYSTEM = `You are a research assistant with access to the user's entire PDF library. You are given a full list of every document in the library, plus a handful of content excerpts retrieved for this specific question. The excerpt list is not exhaustive — if asked what's in the library, use the library list, not just the excerpts. Each excerpt is tagged with a source id like [S1], [S2] and a page number. When you reference information from an excerpt, cite it inline in the form [S1 p.4] (source tag + page). Be concise and direct. If the excerpts don't contain the answer to a content question, say so. Write any mathematical notation as LaTeX: $...$ for inline math, $$...$$ for display equations.`;

// Same tier-aware history budget as RightPanel.tsx's Chat with PDF — Global
// Chat's calls go through the identical free-tier char-budget gate in
// aiService.ts's callProxy, so free tier stays small.
const GLOBAL_CHAT_HISTORY_LIMIT_FREE = 4;
const GLOBAL_CHAT_HISTORY_LIMIT_FULL = 12;
const GLOBAL_CHAT_HISTORY_CHARS_FREE = 800;
const GLOBAL_CHAT_HISTORY_CHARS_FULL = 4000;

function shortName(filename: string): string {
  return filename.replace(/\.pdf$/i, '');
}

export function GlobalChatView() {
  const {
    isAuthenticated, requireAuth, user,
    pdfs, jumpToPage, selectPdf, setPendingJumpPage, selectedPdfId,
    globalChatMessages, addGlobalChatMessage, clearGlobalChat,
    isGlobalChatLoading, setGlobalChatLoading,
    setGlobalChatOpen,
  } = useStore();

  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [globalChatMessages, isGlobalChatLoading]);

  // Auto-grow the composer for multi-line messages (Shift+Enter for a
  // newline, Enter to send) — re-measured on every value change, including
  // the reset back to '' after sending, so it shrinks back down too.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const handleSend = async () => {
    if (!isAuthenticated) return requireAuth('Sign in to chat across your library', () => handleSend());
    const text = input.trim();
    if (!text || isGlobalChatLoading) return;

    setInput('');
    setError(null);
    const userMsg = { id: crypto.randomUUID(), role: 'user' as const, content: text, timestamp: Date.now() };
    addGlobalChatMessage(userMsg);
    setGlobalChatLoading(true);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const { chunks, promptBlock } = await buildGlobalContext(text, pdfs);
      const libraryBlock = buildLibraryListing(pdfs);
      const contextParts = [libraryBlock, promptBlock ? `Content excerpts:\n\n${promptBlock}` : null].filter(Boolean);
      const userContent = contextParts.length > 0
        ? `${contextParts.join('\n\n')}\n\nQuestion: ${text}`
        : text;

      // `globalChatMessages` here is still the closure's pre-send snapshot
      // (from before `addGlobalChatMessage(userMsg)` above) — it correctly
      // excludes the question we're about to ask.
      const historyLimit = user?.tier === 'pro' ? GLOBAL_CHAT_HISTORY_LIMIT_FULL : GLOBAL_CHAT_HISTORY_LIMIT_FREE;
      const historyChars = user?.tier === 'pro' ? GLOBAL_CHAT_HISTORY_CHARS_FULL : GLOBAL_CHAT_HISTORY_CHARS_FREE;
      const history = windowChatHistory(globalChatMessages, historyLimit, historyChars);

      const messages = [
        { role: 'system' as const, content: GLOBAL_CHAT_SYSTEM },
        ...history,
        { role: 'user' as const, content: userContent },
      ];
      const response = await callAI(messages, { signal: abortRef.current.signal });
      const citations = extractCitations(response, chunks);
      addGlobalChatMessage({ id: crypto.randomUUID(), role: 'assistant', content: response, timestamp: Date.now(), citations });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGlobalChatLoading(false);
    }
  };

  const handleCitationClick = (c: ChatCitation) => {
    setGlobalChatOpen(false); // close self first, mirrors ReviewMode.handleSourceJump
    if (c.sourceId !== selectedPdfId) {
      setPendingJumpPage(c.page);
      selectPdf(c.sourceId);
    } else {
      jumpToPage?.(c.page);
    }
  };

  const filenameFor = (sourceId: string) => {
    const pdf = pdfs.find((p) => p.id === sourceId);
    return pdf ? shortName(pdf.filename) : 'Unknown document';
  };

  return (
    <div className="global-chat-view">
      <header className="gcv-header">
        <div className="gcv-header-text">
          <h2 className="gcv-title">Global Chat</h2>
          <span className="gcv-meta">Ask questions across your entire library</span>
        </div>
        <div className="gcv-header-actions">
          {globalChatMessages.length > 0 && (
            <button className="icon-btn" title="Clear chat" onClick={clearGlobalChat}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M9 6V4h6v2" />
              </svg>
            </button>
          )}
          <button className="icon-btn" title="Close" onClick={() => setGlobalChatOpen(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      <div className="chat-messages gcv-messages">
        {globalChatMessages.length === 0 && !isGlobalChatLoading && (
          <p className="chat-empty">Ask anything across your library.</p>
        )}
        {globalChatMessages.map((msg) => (
          <div key={msg.id} className={`chat-message chat-message--${msg.role}`}>
            <div className="chat-bubble" data-color-mode="dark">
              <MathMarkdown source={msg.content} className="chat-bubble-md" breaks />
            </div>
            {msg.citations && msg.citations.length > 0 && (
              <div className="chat-citations">
                {msg.citations.map((c) => (
                  <button
                    key={`${c.sourceId}-${c.page}`}
                    className="chat-citation"
                    onClick={() => handleCitationClick(c)}
                  >
                    {filenameFor(c.sourceId)} · p.{c.page}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {isGlobalChatLoading && (
          <div className="chat-message chat-message--assistant">
            <div className="chat-bubble chat-typing">
              <span /><span /><span />
            </div>
          </div>
        )}
        {error && <p className="chat-error">{error}</p>}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder="Ask across your library…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          disabled={isGlobalChatLoading}
          rows={1}
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!input.trim() || isGlobalChatLoading}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
