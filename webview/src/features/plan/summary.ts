// ─────────────────────────────────────────────────────────────
// Plan-body summarisers used by the compact PlanCard. Pulls a
// title from the first H1 (or falls back to "Implementation
// Plan") and a short prose preview (~2 sentences from the
// first non-heading paragraph). All stripping is conservative:
// drop fenced code blocks, HTML comments, and inline markdown
// formatters — keep the meaningful prose so the preview reads
// like the GitHub PR body.
// ─────────────────────────────────────────────────────────────

export interface PlanSummary {
  title: string;
  preview: string;
}

const FENCE_RE = /```[\s\S]*?```/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/m;
const INLINE_MD_RE = /(`[^`]+`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\([^)]+\))/g;

export function extractPlanSummary(body: string, maxChars = 220): PlanSummary {
  const cleaned = body.replace(FENCE_RE, "").replace(HTML_COMMENT_RE, "");
  const titleMatch = cleaned.match(HEADING_RE);
  const title = (titleMatch ? titleMatch[2] : "Implementation Plan").trim();
  const preview = firstParagraph(cleaned, title, maxChars);
  return { title, preview };
}

function firstParagraph(cleaned: string, title: string, maxChars: number): string {
  // Strip out the title heading and anything before the first body line.
  const lines = cleaned.split(/\r?\n/);
  const collected: string[] = [];
  let pastTitle = !title; // if title is missing, accept lines from the top

  for (const line of lines) {
    const trimmed = line.trim();
    if (!pastTitle) {
      if (HEADING_RE.test(line)) pastTitle = true;
      continue;
    }
    // Skip empty lines, list bullets, table separators, and subsequent headings.
    if (!trimmed) {
      if (collected.length) break; // paragraph break ends the preview
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) continue; // skip H2/H3
    if (/^[-*+]\s/.test(trimmed)) continue; // skip lists
    if (/^\|/.test(trimmed)) continue; // skip tables
    if (/^>/.test(trimmed)) continue; // skip blockquotes
    if (/^---+$/.test(trimmed)) continue; // skip thematic breaks
    collected.push(trimmed);
    if (collected.join(" ").length >= maxChars * 1.4) break;
  }

  let preview = collected
    .join(" ")
    .replace(INLINE_MD_RE, (_match, _all, b1, b2, b3, b4, link) => b1 || b2 || b3 || b4 || link || _match.replace(/^`|`$/g, ""))
    .replace(/\s+/g, " ")
    .trim();

  if (!preview) preview = "Plan body is empty.";
  if (preview.length > maxChars) preview = preview.slice(0, maxChars - 1).trimEnd() + "…";
  return preview;
}

/** "1 minute ago", "3h ago", "2d ago" — used in the modal header. */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec} second${sec !== 1 ? "s" : ""} ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min !== 1 ? "s" : ""} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr !== 1 ? "s" : ""} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day !== 1 ? "s" : ""} ago`;
  const date = new Date(ts);
  return date.toLocaleDateString();
}
