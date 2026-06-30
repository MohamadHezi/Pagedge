import type { CSSProperties } from "react";
import { HIGHLIGHT_COLORS, type HighlightColorKey } from "../constants/highlights";
import type { LensKey } from "../types";

interface LensConfig {
  key: LensKey;
  label: string;
  colorKey: HighlightColorKey | null;
}

const LENSES: LensConfig[] = [
  { key: "default",    label: "Read",       colorKey: null },
  { key: "concepts",   label: "Concepts",   colorKey: "yellow" },
  { key: "revision",   label: "Revision",   colorKey: "blue" },
  { key: "flashcards", label: "Flashcards", colorKey: "green" },
  { key: "quotes",     label: "Quotes",     colorKey: "pink" },
];

interface Props {
  activeLens: LensKey;
  onSelect: (lens: LensKey) => void;
}

export function LensSwitcher({ activeLens, onSelect }: Props) {
  return (
    <div className="lens-switcher">
      {LENSES.map(({ key, label, colorKey }) => {
        const isActive = activeLens === key;
        const color = colorKey ? HIGHLIGHT_COLORS[colorKey] : null;
        // --lens-accent drives active text color, dot color, and focus ring.
        // Set on all color-lens tabs (active or not) so the dot is always tinted.
        // The Read tab has no color, so --lens-accent falls back to --text-primary via CSS.
        const style = color
          ? ({ "--lens-accent": color.hex } as CSSProperties)
          : undefined;
        return (
          <button
            key={key}
            className={`lens-tab${isActive ? " lens-tab--active" : ""}`}
            style={style}
            onClick={() => onSelect(key)}
          >
            {colorKey && <span className="lens-dot" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}
