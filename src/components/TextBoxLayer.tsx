import { useRef, useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PageViewport } from "pdfjs-dist";
import type { TextBox } from "../types";
import { useStore } from "../store";

const TB_COLORS = [
  "#eee0d2",
  "#ffffff",
  "#ff3b30",
  "#1a1a1a",
  "#FFD60A",
  "#4DA6FF",
  "#34C759",
  "#FF6B9D",
];

const FONT_MIN = 10;
const FONT_MAX = 32;
const DEFAULT_W = 160;
const DEFAULT_H = 40;

interface Props {
  pageNum: number;
  viewport: PageViewport;
  scale: number;
  textBoxes: TextBox[];
}

function TextBoxEl({
  tb,
  viewport,
  scale,
  isSelected,
  isAutoFocus,
  onSelect,
  onCommit,
  onDelete,
  onExitEdit,
}: {
  tb: TextBox;
  viewport: PageViewport;
  scale: number;
  isSelected: boolean;
  isAutoFocus: boolean;
  onSelect: (id: string) => void;
  onCommit: (id: string, changes: Partial<TextBox>) => void;
  onDelete: (id: string) => void;
  onExitEdit: () => void;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(tb.content);
  const [fontSize, setFontSize] = useState(tb.font_size);
  const [color, setColor] = useState(tb.color);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const isDragging = useRef(false);
  const dragStart = useRef({ mouseX: 0, mouseY: 0, pdfX: 0, pdfY: 0 });
  const isResizing = useRef(false);
  const resizeStart = useRef({ mouseX: 0, mouseY: 0, pdfW: 0, pdfH: 0 });

  // Keep local state in sync when tb prop changes from outside
  useEffect(() => { setContent(tb.content); }, [tb.content]);
  useEffect(() => { setFontSize(tb.font_size); }, [tb.font_size]);
  useEffect(() => { setColor(tb.color); }, [tb.color]);

  // --- FIX 1: Auto-enter edit mode when this box is freshly created ---
  useEffect(() => {
    if (isAutoFocus) {
      setEditing(true);
    }
  }, [isAutoFocus]);

  // Sync DOM innerHTML from state — only when NOT editing, so React never clears the
  // div's content during the editing=false→true transition (which would trigger auto-delete).
  useEffect(() => {
    if (divRef.current && !editing) {
      divRef.current.innerHTML = content.replace(/\n/g, '<br>');
    }
  }, [content, editing]);

  // Focus + place cursor at end whenever editing turns on
  useEffect(() => {
    if (editing && divRef.current) {
      divRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(divRef.current);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  }, [editing]);

  const scheduleContentSave = useCallback((newContent: string) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      invoke('update_text_box', { id: tb.id, content: newContent }).catch(console.error);
    }, 500);
  }, [tb.id]);

  // --- FIX 3: Blur auto-deletes empty boxes; calls onExitEdit to restore place mode ---
  const handleBlur = useCallback(() => {
    setEditing(false);
    clearTimeout(saveTimer.current);
    const trimmed = (divRef.current?.innerText ?? content).trim();
    if (!trimmed) {
      invoke('delete_text_box', { id: tb.id }).catch(console.error);
      onDelete(tb.id);
      onExitEdit();
      return;
    }
    invoke('update_text_box', { id: tb.id, content: trimmed }).catch(console.error);
    onCommit(tb.id, { content: trimmed });
    onExitEdit();
  }, [content, tb.id, onCommit, onDelete, onExitEdit]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isSelected) {
      onSelect(tb.id);
      return;
    }
    setEditing(true);
  }, [isSelected, tb.id, onSelect]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(tb.id);
    setEditing(true);
  }, [tb.id, onSelect]);

  const handleInput = useCallback(() => {
    const text = divRef.current?.innerText ?? '';
    setContent(text);
    scheduleContentSave(text);
  }, [scheduleContentSave]);

  // Drag to move (only when not editing)
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging.current = true;
    dragStart.current = { mouseX: e.clientX, mouseY: e.clientY, pdfX: tb.position_x, pdfY: tb.position_y };

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const newX = dragStart.current.pdfX + (ev.clientX - dragStart.current.mouseX) / scale;
      const newY = dragStart.current.pdfY - (ev.clientY - dragStart.current.mouseY) / scale;
      onCommit(tb.id, { position_x: newX, position_y: newY });
    };
    const onUp = (ev: MouseEvent) => {
      isDragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const newX = dragStart.current.pdfX + (ev.clientX - dragStart.current.mouseX) / scale;
      const newY = dragStart.current.pdfY - (ev.clientY - dragStart.current.mouseY) / scale;
      invoke('update_text_box', { id: tb.id, x: newX, y: newY }).catch(console.error);
      onCommit(tb.id, { position_x: newX, position_y: newY });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [editing, scale, tb.id, tb.position_x, tb.position_y, onCommit]);

  // Resize handle
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing.current = true;
    resizeStart.current = { mouseX: e.clientX, mouseY: e.clientY, pdfW: tb.width, pdfH: tb.height };

    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const newW = Math.max(60, resizeStart.current.pdfW + (ev.clientX - resizeStart.current.mouseX) / scale);
      const newH = Math.max(20, resizeStart.current.pdfH + (ev.clientY - resizeStart.current.mouseY) / scale);
      onCommit(tb.id, { width: newW, height: newH });
    };
    const onUp = (ev: MouseEvent) => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const newW = Math.max(60, resizeStart.current.pdfW + (ev.clientX - resizeStart.current.mouseX) / scale);
      const newH = Math.max(20, resizeStart.current.pdfH + (ev.clientY - resizeStart.current.mouseY) / scale);
      invoke('update_text_box', { id: tb.id, width: newW, height: newH }).catch(console.error);
      onCommit(tb.id, { width: newW, height: newH });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [scale, tb.id, tb.width, tb.height, onCommit]);

  const changeFontSize = useCallback((delta: number) => {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize + delta));
    setFontSize(next);
    invoke('update_text_box', { id: tb.id, fontSize: next }).catch(console.error);
    onCommit(tb.id, { font_size: next });
  }, [fontSize, tb.id, onCommit]);

  const changeColor = useCallback((c: string) => {
    setColor(c);
    invoke('update_text_box', { id: tb.id, color: c }).catch(console.error);
    onCommit(tb.id, { color: c });
  }, [tb.id, onCommit]);

  const cssLeft = tb.position_x * scale;
  const cssTop  = viewport.height - (tb.position_y + tb.height) * scale;
  const cssW    = tb.width * scale;
  const cssH    = tb.height * scale;

  return (
    <>
      {/* Mini-toolbar — shown whenever selected */}
      {isSelected && (
        <div
          className="tb-mini-toolbar"
          style={{ left: cssLeft, top: cssTop - 38 }}
          // --- FIX 2: preventDefault keeps focus on the contentEditable ---
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <button
            className="tb-mini-btn"
            onClick={() => changeFontSize(-2)}
            disabled={fontSize <= FONT_MIN}
            title="Decrease font size"
          >A−</button>
          <span className="tb-mini-size">{Math.round(fontSize)}</span>
          <button
            className="tb-mini-btn"
            onClick={() => changeFontSize(2)}
            disabled={fontSize >= FONT_MAX}
            title="Increase font size"
          >A+</button>
          <div className="tb-mini-sep" />
          {TB_COLORS.map((c) => (
            <button
              key={c}
              className={`tb-mini-color${color === c ? ' tb-mini-color--active' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => changeColor(c)}
            />
          ))}
          <div className="tb-mini-sep" />
          <button
            className="tb-mini-btn tb-mini-delete"
            onClick={() => {
              invoke('delete_text_box', { id: tb.id }).catch(console.error);
              onDelete(tb.id);
            }}
            title="Delete text box (Delete)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M9 6V4h6v2" />
            </svg>
          </button>
        </div>
      )}

      {/* The text box itself */}
      <div
        className={`text-box${isSelected ? ' text-box--selected' : ''}${editing ? ' text-box--editing' : ''}`}
        style={{
          left: cssLeft,
          top: cssTop,
          width: cssW,
          height: cssH,
          fontSize: fontSize * scale,
          color,
          cursor: editing ? 'text' : isSelected ? 'move' : 'default',
        }}
        onMouseDown={(e) => {
          // Always stop propagation so draw canvas doesn't receive this event.
          // Always preventDefault to prevent the browser from blurring the
          // contentEditable when the user clicks the box border/padding while editing.
          e.preventDefault();
          e.stopPropagation();
          if (!editing) handleDragStart(e);
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        <div
          ref={divRef}
          className="text-box-content"
          contentEditable={editing}
          suppressContentEditableWarning
          onInput={handleInput}
          onBlur={handleBlur}
          onMouseDown={(e) => editing && e.stopPropagation()}
          onClick={(e) => editing && e.stopPropagation()}
        />
        {isSelected && !editing && (
          <div className="tb-resize-handle" onMouseDown={handleResizeStart} />
        )}
      </div>
    </>
  );
}

export function TextBoxLayer({ pageNum, viewport, scale, textBoxes }: Props) {
  const {
    selectedTextBoxId,
    setSelectedTextBoxId,
    updateTextBoxLocal,
    removeTextBox,
    editingTextBoxId,
    setEditingTextBoxId,
  } = useStore();

  const pageBoxes = textBoxes.filter((tb) => tb.page === pageNum);

  const handleCommit = useCallback((id: string, changes: Partial<TextBox>) => {
    updateTextBoxLocal(id, changes);
  }, [updateTextBoxLocal]);

  const handleDelete = useCallback((id: string) => {
    removeTextBox(id);
    setSelectedTextBoxId(null);
    // Do NOT restore placingTextBox here — the user re-clicks the textbox tool to place more.
    // Restoring it immediately would make all remaining boxes lose pointer-events.
  }, [removeTextBox, setSelectedTextBoxId]);

  // Called by each TextBoxEl on blur — clears the auto-focus signal.
  // Do NOT restore placingTextBox=true here: that would add textbox-place-mode back,
  // which sets pointer-events:none on every existing box and breaks clicking/dragging them.
  const handleExitEdit = useCallback(() => {
    setEditingTextBoxId(null);
  }, [setEditingTextBoxId]);

  if (pageBoxes.length === 0) return null;

  return (
    <div className="text-box-layer" style={{ width: viewport.width, height: viewport.height }}>
      {pageBoxes.map((tb) => (
        <TextBoxEl
          key={tb.id}
          tb={tb}
          viewport={viewport}
          scale={scale}
          isSelected={selectedTextBoxId === tb.id}
          isAutoFocus={editingTextBoxId === tb.id}
          onSelect={setSelectedTextBoxId}
          onCommit={handleCommit}
          onDelete={handleDelete}
          onExitEdit={handleExitEdit}
        />
      ))}
    </div>
  );
}

export { DEFAULT_W, DEFAULT_H };
