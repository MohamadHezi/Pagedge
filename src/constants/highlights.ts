export type HighlightColorKey = "yellow" | "blue" | "green" | "pink";

export interface HighlightColor {
  hex: string;
  rgba: (opacity: number) => string;
  label: string;
}

export const HIGHLIGHT_COLORS: Record<HighlightColorKey, HighlightColor> = {
  yellow: {
    hex: "#FFD60A",
    rgba: (o) => `rgba(255, 214, 10, ${o})`,
    label: "Important / key concept",
  },
  blue: {
    hex: "#4DA6FF",
    rgba: (o) => `rgba(77, 166, 255, ${o})`,
    label: "Confused / need to revisit",
  },
  green: {
    hex: "#34C759",
    rgba: (o) => `rgba(52, 199, 89, ${o})`,
    label: "Add to flashcards",
  },
  pink: {
    hex: "#FF6B9D",
    rgba: (o) => `rgba(255, 107, 157, ${o})`,
    label: "Quotes worth keeping",
  },
};

export const HIGHLIGHT_COLOR_KEYS: HighlightColorKey[] = [
  "yellow",
  "blue",
  "green",
  "pink",
];
