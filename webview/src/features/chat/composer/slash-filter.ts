// ─────────────────────────────────────────────────────────────
// Matching what the user typed after `/` against the command list.
//
// Its own module rather than part of SlashPopover so it can be tested without
// dragging a stylesheet through the test runner — and because the ranking is
// the part with actual behaviour in it.
//
// Filtering lives on this side of the seam on purpose: the list is static for
// the session, so a request per keystroke would buy nothing. The mention
// popover round-trips only because file search has to hit the disk.
// ─────────────────────────────────────────────────────────────

import type { SlashCommand } from "../../../lib/rpc";

/**
 * What has been typed after a leading `/`, or null when the prompt is not a
 * command being written.
 *
 * Anchored to the start of the whole prompt rather than the caret's token,
 * because the CLI expands `/name` only at the very beginning of a message —
 * offering the popover mid-sentence would suggest something that cannot run.
 *
 * A space ends it: by then the command is chosen and what follows are its
 * arguments.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const typed = text.slice(1);
  if (/\s/.test(typed)) return null;
  return typed;
}

/**
 * Commands matching a query, best first.
 *
 * Prefix beats leaf-prefix beats substring: `/st` must offer `start` ahead of
 * `marketing-skills:content-strategy`, which merely contains those letters.
 * The leaf rule is what makes a namespaced command reachable by its short
 * name — `/tdd` finds `mattpocock-skills:tdd`.
 */
export function filterCommands(
  commands: SlashCommand[],
  query: string
): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;

  const scored: Array<{ c: SlashCommand; rank: number }> = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    const leaf = name.split(":").pop() ?? name;
    if (name.startsWith(q)) scored.push({ c, rank: 0 });
    else if (leaf.startsWith(q)) scored.push({ c, rank: 1 });
    else if (name.includes(q)) scored.push({ c, rank: 2 });
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}
