// ─────────────────────────────────────────────────────────────
// Reasoning effort — the levels `claude --effort` accepts, and which pinned
// models accept which.
//
// In `core/` rather than beside the spawn because six modules want the type
// and only one of them wants a CLI provider. Reading it out of a 4400-line
// provider also made `services/claude-settings.ts` import that provider while
// the provider imported it back — a genuine runtime cycle, since the settings
// module exports values, not only types.
//
// Turning a level into a flag is argv's job and lives in
// `providers/cli/args.ts`: that needs `ClaudeCliOpts`, and nothing in `core/`
// should.
// ─────────────────────────────────────────────────────────────

/** Effort levels accepted by `claude --effort`. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * What each pinned version accepts from `--effort`, in order.
 *
 * `xhigh` arrived with Opus 4.7 and `max` with the 4.6 family, so a pinned
 * model predates part of the ladder — Sonnet 4.5 predates the flag entirely.
 * Aliases are deliberately absent: they always resolve to something current,
 * and a model missing from this map is assumed to take every level.
 *
 * Read by the spawn *and* by the picker's catalogue, so the two cannot
 * disagree about what a version will accept.
 */
export const EFFORT_LADDERS: Readonly<
  Record<string, ReadonlyArray<EffortLevel>>
> = {
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "max"],
  "claude-opus-4-5": ["low", "medium", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-sonnet-4-5": []
};

export const EFFORT_LEVELS: ReadonlyArray<EffortLevel> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
