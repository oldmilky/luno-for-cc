// ─────────────────────────────────────────────────────────────
// Parsing `vscode://luno.luno-for-cc/open?prompt=…`.
//
// A URI handler is an entry point anyone can reach: a link on a web page, a
// README, a chat message. Everything that decides what to do with one is here,
// where it can be tested without an editor, and the editor half is left with
// nothing to get wrong.
// ─────────────────────────────────────────────────────────────

/**
 * A prompt long enough to be a payload rather than a request. Well past any
 * sentence someone would put in a link, and short enough that a crafted URI
 * cannot push the composer's contents off screen.
 */
const MAX_PROMPT_CHARS = 4_000;

/**
 * The prompt a URI is asking for, or `null` if it is not asking for one.
 *
 * Only `/open` is answered. An unknown path is not an error worth showing —
 * a future version of some other tool may well send one — but it is not a
 * reason to open the panel either.
 */
export function promptFromUri(path: string, query: string): string | null {
  if (path !== "/open" && path !== "open") return null;
  const raw = new URLSearchParams(query).get("prompt");
  if (!raw) return null;
  const cleaned = stripControl(raw).trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_PROMPT_CHARS);
}

/** Control characters, minus the two that mean something in a prompt. A URI
 *  can carry an ANSI escape or a NUL, and the composer renders what it is
 *  handed. */
function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const printable =
      (code >= 0x20 && code < 0x7f) ||
      code > 0x9f ||
      ch === "\n" ||
      ch === "\t";
    if (printable) out += ch;
  }
  return out;
}
