import { useStore } from "../store";
import type { DrawToolType } from "../types";

const DRAW_COLORS = [
  "#1a1a1a",
  "#ffffff",
  "#ff3b30",
  "#FFD60A",
  "#4DA6FF",
  "#34C759",
  "#FF6B9D",
];

function PenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
      <path d="M2 2l7.586 7.586" />
      <circle cx="11" cy="11" r="2" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="19" x2="19" y2="5" />
      <polyline points="9 5 19 5 19 15" />
    </svg>
  );
}

function RectIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="12" cy="12" rx="10" ry="6" />
    </svg>
  );
}

function TextBoxIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 8h6M12 8v8" />
    </svg>
  );
}

const TOOLS: { key: DrawToolType; icon: React.ReactNode; title: string }[] = [
  { key: "pen",       icon: <PenIcon />,     title: "Freehand pen" },
  { key: "arrow",     icon: <ArrowIcon />,   title: "Arrow" },
  { key: "rectangle", icon: <RectIcon />,    title: "Rectangle" },
  { key: "circle",    icon: <CircleIcon />,  title: "Circle / Ellipse" },
  { key: "textbox",   icon: <TextBoxIcon />, title: "Text box" },
];

interface Props {
  onUndo: () => void;
  onDone: () => void;
}

export function AnnotationDock({ onUndo, onDone }: Props) {
  const {
    activeDrawTool, setActiveDrawTool,
    drawColor,      setDrawColor,
    strokeWidth,    setStrokeWidth,
  } = useStore();

  return (
    <div className="annotation-dock">
      {/* ── Tool buttons ── */}
      {TOOLS.map(({ key, icon, title }) => (
        <button
          key={key}
          className={`dock-tool-btn${activeDrawTool === key ? " dock-tool-btn--active" : ""}`}
          title={title}
          onClick={() => setActiveDrawTool(key)}
        >
          {icon}
        </button>
      ))}

      <div className="dock-sep" />

      {/* ── Color palette ── */}
      <div className="dock-colors">
        {DRAW_COLORS.map((c) => (
          <button
            key={c}
            className={`dock-color-btn${drawColor === c ? " dock-color-btn--active" : ""}`}
            style={{ background: c }}
            title={c}
            onClick={() => setDrawColor(c)}
          />
        ))}
      </div>

      <div className="dock-sep" />

      {/* ── Stroke width ── */}
      <div className="dock-stroke-row" title={`Stroke width: ${strokeWidth}px`}>
        <button
          className="dock-stroke-adj"
          onClick={() => setStrokeWidth(Math.max(1, strokeWidth - 0.5))}
          disabled={strokeWidth <= 1}
        >−</button>
        <span className="dock-stroke-val">{strokeWidth}</span>
        <button
          className="dock-stroke-adj"
          onClick={() => setStrokeWidth(Math.min(6, strokeWidth + 0.5))}
          disabled={strokeWidth >= 6}
        >+</button>
      </div>

      <div className="dock-sep" />

      {/* ── Undo ── */}
      <button className="dock-action-btn" title="Undo last drawing" onClick={onUndo}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 14 4 9 9 4" />
          <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
        </svg>
      </button>

      {/* ── Done ── */}
      <button className="dock-done-btn" title="Exit draw mode (Esc)" onClick={onDone}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </div>
  );
}
