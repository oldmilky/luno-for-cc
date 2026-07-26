// ─────────────────────────────────────────────────────────────
// Shared helpers used across the plan feature components.
// Kept in one place so equivalent logic doesn't drift between
// the inline-thread renderer, the sidebar list, the selection
// popover, and the editor decoration service.
// ─────────────────────────────────────────────────────────────

/** Collapse runs of whitespace to single spaces and trim. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Trim a string and append an ellipsis if it exceeds `n` characters. */
export function truncate(s: string, n: number): string {
  const flat = collapseWhitespace(s);
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** Compact a workspace path for header chips: `/a/b/c/d.md` → `/a/…/c/d.md`. */
export function compactPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return `${parts[0] || "/"}/…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
