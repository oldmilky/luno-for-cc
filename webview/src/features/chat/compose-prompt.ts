// ─────────────────────────────────────────────────────────────
// What the composer actually sends, once the pinned files are folded in.
//
// Pins are a promise that the agent has those files in scope, and the only
// mechanism for keeping it is the `@`-mention syntax the agent already
// resolves. So the text that leaves the composer is not the text that was
// typed, and the difference is worth a function with a test rather than a
// closure inside a JSX prop.
// ─────────────────────────────────────────────────────────────

import type { PinnedFile } from "./PinnedContext";

/**
 * Prepend an `@`-mention for every pin the text does not already name.
 *
 * Case-insensitive, because the mention the user typed and the label the pin
 * carries come from different places — the file picker capitalises what the
 * filesystem gave it, and a hand-typed mention rarely matches.
 *
 * Returns the text unchanged when there is nothing to add, rather than an
 * empty line followed by it.
 */
export function withPinnedMentions(
  text: string,
  pins: ReadonlyArray<PinnedFile>
): string {
  const lowered = text.toLowerCase();
  const auto = pins
    .filter((p) => !lowered.includes(`@${p.label.toLowerCase()}`))
    .map((p) => `@${p.label}`)
    .join(" ");
  // A blank line, not a space: the mentions are context the agent reads before
  // the request, and running them into the first sentence has read as part of
  // it — "@config.ts what does this do" is ambiguous in a way the break fixes.
  return auto ? `${auto}\n\n${text}` : text;
}
