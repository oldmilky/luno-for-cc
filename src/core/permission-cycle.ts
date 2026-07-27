// ─────────────────────────────────────────────────────────────
// Which permission modes Shift+Tab walks through.
//
// Lives in core, with no VS Code import, because it is the one piece of the
// bypass design that is worth a test: the guarantee that a keystroke cannot
// reach a mode with no approval gate.
// ─────────────────────────────────────────────────────────────

import type { PermissionMode } from "./types.js";

/**
 * What Shift+Tab walks through.
 *
 * `bypass` is deliberately not in it. Cycling is for switching between working
 * postures without thinking; a mode that disables every safety check should not
 * be reachable by pressing Tab one more time than intended.
 */
export const CYCLE_ORDER: readonly PermissionMode[] = [
  "default",
  "plan",
  "auto"
];

/** The mode after `current` in the cycle, skipping anything not in it. */
export function nextCycleMode(current: PermissionMode): PermissionMode {
  const i = CYCLE_ORDER.indexOf(current);
  // An unrecognised mode — `bypass`, or a value hand-edited into settings —
  // lands on the first entry rather than nowhere. `indexOf` returning -1 would
  // otherwise make `(-1 + 1) % 3` yield 0 by accident; being explicit says it
  // is intended.
  if (i === -1) return CYCLE_ORDER[0];
  return CYCLE_ORDER[(i + 1) % CYCLE_ORDER.length];
}
