// ─────────────────────────────────────────────────────────────
// FileBadge — Cursor-style language tile shown next to a filename.
// Matches the "JS" yellow square in Cursor's UI: a small rounded
// rectangle with the file extension as a bold uppercase label,
// background colored by language, text color contrast-adjusted.
// ─────────────────────────────────────────────────────────────

import styles from "./FileBadge.module.scss";

interface FileBadgeProps {
  path: string;
  /** Render size in px (square). Defaults to 16. */
  size?: number;
}

interface LangSpec {
  /** Short label shown inside the tile. */
  label: string;
  /** Tile background color. */
  bg: string;
  /** Foreground (text) color. Dark for light bgs, light for dark bgs. */
  fg: string;
}

// Keyed by file extension. Pulled from the most recognizable language
// brand colors so each badge is instantly identifiable.
const LANGS: Record<string, LangSpec> = {
  ts:   { label: "TS",   bg: "#3178c6", fg: "#ffffff" },
  tsx:  { label: "TSX",  bg: "#3178c6", fg: "#ffffff" },
  js:   { label: "JS",   bg: "#f7df1e", fg: "#1a1a1a" },
  jsx:  { label: "JSX",  bg: "#f7df1e", fg: "#1a1a1a" },
  mjs:  { label: "JS",   bg: "#f7df1e", fg: "#1a1a1a" },
  cjs:  { label: "JS",   bg: "#f7df1e", fg: "#1a1a1a" },
  py:   { label: "PY",   bg: "#3776ab", fg: "#ffd43b" },
  rs:   { label: "RS",   bg: "#dea584", fg: "#1a1a1a" },
  go:   { label: "GO",   bg: "#00add8", fg: "#ffffff" },
  json: { label: "{ }",  bg: "#cbcb41", fg: "#1a1a1a" },
  md:   { label: "MD",   bg: "#519aba", fg: "#ffffff" },
  css:  { label: "CSS",  bg: "#264de4", fg: "#ffffff" },
  scss: { label: "SCSS", bg: "#cc6699", fg: "#ffffff" },
  html: { label: "HTML", bg: "#e34c26", fg: "#ffffff" },
  c:    { label: "C",    bg: "#283593", fg: "#ffffff" },
  h:    { label: "C",    bg: "#283593", fg: "#ffffff" },
  cpp:  { label: "C++",  bg: "#0288d1", fg: "#ffffff" },
  hpp:  { label: "C++",  bg: "#0288d1", fg: "#ffffff" },
  cc:   { label: "C++",  bg: "#0288d1", fg: "#ffffff" },
  java: { label: "JAV",  bg: "#b07219", fg: "#ffffff" },
  rb:   { label: "RB",   bg: "#cc342d", fg: "#ffffff" },
  php:  { label: "PHP",  bg: "#777bb4", fg: "#ffffff" },
  swift:{ label: "SWI",  bg: "#fa7343", fg: "#ffffff" },
  kt:   { label: "KT",   bg: "#7f52ff", fg: "#ffffff" },
  vue:  { label: "VUE",  bg: "#41b883", fg: "#ffffff" },
  svelte:{label: "SVE",  bg: "#ff3e00", fg: "#ffffff" },
  sh:   { label: "SH",   bg: "#4caf50", fg: "#ffffff" },
  bash: { label: "SH",   bg: "#4caf50", fg: "#ffffff" },
  yml:  { label: "YML",  bg: "#cb171e", fg: "#ffffff" },
  yaml: { label: "YML",  bg: "#cb171e", fg: "#ffffff" },
  toml: { label: "TOM",  bg: "#9c4221", fg: "#ffffff" },
  sql:  { label: "SQL",  bg: "#336791", fg: "#ffffff" },
  dockerfile: { label: "DKR", bg: "#0db7ed", fg: "#ffffff" }
};

const DEFAULT_SPEC: LangSpec = {
  label: "•••",
  bg: "var(--s3)",
  fg: "var(--t2)"
};

function specFor(path: string): LangSpec {
  // Special case: Dockerfile, Makefile, etc. (no extension)
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return LANGS.dockerfile;
  if (lower === "makefile") return { label: "MK", bg: "#888888", fg: "#ffffff" };
  const m = base.match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return DEFAULT_SPEC;
  return LANGS[m[1].toLowerCase()] ?? DEFAULT_SPEC;
}

export function FileBadge({ path, size = 16 }: FileBadgeProps) {
  const s = specFor(path);
  // Font size scales with the tile; minimum 8px so very small badges stay
  // legible. We trim 3-char labels to fit by using a slightly smaller font.
  const fs = s.label.length >= 3 ? Math.max(7, Math.round(size * 0.46)) : Math.max(8, Math.round(size * 0.55));
  return (
    <span
      className={styles.badge}
      style={{
        width: size,
        height: size,
        background: s.bg,
        color: s.fg,
        fontSize: fs
      }}
      aria-hidden
    >
      {s.label}
    </span>
  );
}
