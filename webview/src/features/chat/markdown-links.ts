// ─────────────────────────────────────────────────────────────
// Where a link inside rendered markdown should go.
//
// A webview cannot follow an anchor: `target="_blank"` and `window.open` are
// both swallowed, and the click looks like it did nothing. So every link has to
// be classified and dispatched — outward through `openExternal`, inward through
// `openFile`.
// ─────────────────────────────────────────────────────────────

export type MarkdownHref =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; startLine?: number; endLine?: number }
  /** In-document (`#section`) or empty. Nothing to dispatch. */
  | { kind: "inert" };

/** `https:`, `mailto:`, `vscode:` … A single-letter scheme followed by a slash
 *  is a Windows drive (`C:/…`, `C:\…`), not a protocol. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** `#L42`, `#L42-L51`, `#L42-51` — the fragment GitHub uses and the official
 *  Claude Code extension asks its model to write. */
const LINE_FRAGMENT = /^L(\d+)(?:-L?(\d+))?$/i;

export function resolveMarkdownHref(raw: string | undefined): MarkdownHref {
  const href = raw?.trim();
  if (!href || href.startsWith("#")) return { kind: "inert" };

  const scheme = SCHEME.exec(href);
  if (scheme && !isWindowsDrive(scheme[1], href)) {
    return { kind: "external", url: href };
  }

  const hash = href.indexOf("#");
  const path = stripLeadingDot(hash === -1 ? href : href.slice(0, hash));
  if (!path) return { kind: "inert" };

  const lines = hash === -1 ? null : LINE_FRAGMENT.exec(href.slice(hash + 1));
  if (!lines) return { kind: "file", path };

  const startLine = Number(lines[1]);
  const endLine = lines[2] ? Number(lines[2]) : startLine;
  return { kind: "file", path, startLine, endLine };
}

function isWindowsDrive(scheme: string, href: string): boolean {
  return scheme.length === 1 && /^[a-z]:[\\/]/i.test(href);
}

function stripLeadingDot(path: string): string {
  return path.replace(/^\.\/+/, "");
}
