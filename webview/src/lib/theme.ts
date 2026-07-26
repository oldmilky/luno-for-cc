// ─────────────────────────────────────────────────────────────
// Theme store.
//
// A theme is nothing but a set of CSS custom properties (see
// src/themes/ and docs/TOKENS.md). Switching one is a single
// `data-theme` attribute on <html> — every component reads the
// tokens, so nothing else has to react.
//
// The attribute goes on the document element rather than the app
// shell because html/body paint `--s0` themselves; stamping the
// shell would leave the page background on the old palette.
// ─────────────────────────────────────────────────────────────

import { loadState, patchState } from "./rpc";

export type ThemeId =
  "copper" | "purple" | "red" | "blue" | "green" | "pink" | "white";

export interface ThemeDef {
  id: ThemeId;
  label: string;
  /** One-line description shown in the picker. */
  note: string;
}

// Order here is the order in the picker. Anything stored but no longer listed
// (an older build's theme) falls back to the default — see readStoredTheme.
export const THEMES: ThemeDef[] = [
  { id: "copper", label: "Copper", note: "Brand copper on charcoal" },
  { id: "purple", label: "Purple", note: "Violet on tinted midnight" },
  { id: "red", label: "Red", note: "Crimson on warm black" },
  { id: "blue", label: "Blue", note: "Azure on cold navy" },
  { id: "green", label: "Green", note: "Emerald on deep pine" },
  { id: "pink", label: "Pink", note: "Magenta on plum" },
  { id: "white", label: "White", note: "Studio silver on graphite" }
];

export const DEFAULT_THEME: ThemeId = "copper";

const THEMES_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && THEMES_BY_ID.has(v as ThemeId);
}

/** Last theme the user picked, or the default when there's nothing stored. */
export function readStoredTheme(): ThemeId {
  const stored = loadState<{ theme?: unknown }>()?.theme;
  return isThemeId(stored) ? stored : DEFAULT_THEME;
}

let current: ThemeId = DEFAULT_THEME;
const listeners = new Set<() => void>();
let morphTimer: number | undefined;

/**
 * Stamp a theme on the document.
 *
 * `animate` drives the palette morph: `.theme-switching` enables color
 * transitions for the length of the swap and is then removed, so normal
 * hovers and streaming repaints stay instant. Skipped on the initial
 * apply — there is no previous palette to morph from.
 */
export function applyTheme(id: ThemeId, { animate = true } = {}): void {
  const root = document.documentElement;
  if (animate && root.dataset.theme !== id) {
    root.classList.add("theme-switching");
    window.clearTimeout(morphTimer);
    morphTimer = window.setTimeout(() => {
      root.classList.remove("theme-switching");
    }, morphDurationMs(root));
  }
  root.dataset.theme = id;
  current = id;
  listeners.forEach((fn) => fn());
}

/** Read `--theme-transition` off the root so CSS stays the single source. */
function morphDurationMs(root: HTMLElement): number {
  const raw = getComputedStyle(root)
    .getPropertyValue("--theme-transition")
    .trim();
  const ms = raw.endsWith("ms")
    ? parseFloat(raw)
    : raw.endsWith("s")
      ? parseFloat(raw) * 1000
      : NaN;
  // +40ms so the class outlives the transition it enables.
  return Number.isFinite(ms) ? ms + 40 : 460;
}

/** Apply the stored theme before first paint — call once, from main.tsx. */
export function initTheme(): void {
  applyTheme(readStoredTheme(), { animate: false });
}

export function setTheme(id: ThemeId): void {
  applyTheme(id);
  patchState({ theme: id });
}

export function getTheme(): ThemeId {
  return current;
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
