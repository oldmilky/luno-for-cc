// ─────────────────────────────────────────────────────────────
// The models an administrator allows.
//
// This is the audit's sharpest finding, and it is worth stating plainly:
// **ignoring an admin control is overriding it.** A workplace that pins
// `availableModels` in managed settings has said which models may be used, and
// a client that shows the full list anyway has not merely failed to help — it
// has quietly overruled a policy on the user's behalf.
//
// Semantics READ from `claude-code-settings.schema.json` in
// `anthropic.claude-code` 2.1.220, not inferred:
//
// > Accepts family aliases ("opus" allows any opus version), version prefixes
// > ("opus-4-5" allows only that version), and full model IDs. If undefined,
// > all models are available. **If empty array, only the default model is
// > available.**
//
// That last sentence is the one a reimplementation gets wrong. An empty list
// is not "no restriction" and it is not "nothing allowed": it is "default
// only".
// ─────────────────────────────────────────────────────────────

/** The alias every tier resolves for itself, and the one an empty allowlist
 *  leaves standing. */
const DEFAULT_MODEL = "default";

/** A model name as its dash-delimited parts: `claude-opus-4-5` → four. */
function segments(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .split(/[-_.]+/)
    .filter(Boolean);
}

/**
 * Does this allowlist entry cover this model?
 *
 * All three kinds the schema names, in one rule: **the entry's segments appear
 * as a contiguous run in the model's.**
 *
 * - family alias — `opus` is one segment, and it matches `opus`,
 *   `claude-opus-4-5` and `claude-opus-4-5-20260101` alike. "Allows any opus
 *   version" has to reach the full ids, or an allowlist naming a family would
 *   hide every concrete model in it;
 * - version prefix — `opus-4-5` matches the dated id but not `opus-4-1`;
 * - full id — every segment must line up, so it covers only itself.
 *
 * Matching on segments rather than a raw prefix is what keeps `opus-4` off
 * `opus-40`, and what lets `sonnet` reach `claude-sonnet-4-6` — LUNO's picker
 * offers both spellings, so an entry that matched only one of them would be a
 * policy the user experiences as arbitrary.
 */
function entryCovers(entry: string, model: string): boolean {
  const want = segments(entry);
  const have = segments(model);
  if (want.length === 0 || want.length > have.length) return false;
  return have.some((_, i) => want.every((part, j) => have[i + j] === part));
}

/**
 * May the user select this model?
 *
 * @param allowlist `availableModels`, or undefined when no policy names one.
 */
export function isModelAllowed(
  model: string,
  allowlist: ReadonlyArray<string> | undefined
): boolean {
  // No policy at all: everything is allowed. Absence is not a restriction.
  if (allowlist === undefined) return true;
  // An empty list means "default only" — READ from the schema, and the one
  // reading that fails dangerously if guessed the other way.
  if (allowlist.length === 0) return model === DEFAULT_MODEL;
  // `default` is not a model but a pointer to one, and it is what the picker
  // starts on. It survives unless the policy also enforces the default.
  if (model === DEFAULT_MODEL) return true;
  return allowlist.some((entry) => entryCovers(entry, model));
}

/**
 * The pickable models, after the policy.
 *
 * Never returns an empty list: a picker with nothing in it is a broken panel,
 * and the honest floor is the one selection a policy always leaves — Default.
 */
export function allowedModels<T extends { value: string }>(
  models: ReadonlyArray<T>,
  allowlist: ReadonlyArray<string> | undefined
): T[] {
  const kept = models.filter((m) => isModelAllowed(m.value, allowlist));
  if (kept.length > 0) return kept;
  const fallback = models.find((m) => m.value === DEFAULT_MODEL);
  return fallback ? [fallback] : [...models].slice(0, 1);
}

/**
 * What `Default` should resolve to under this policy.
 *
 * `enforceAvailableModels` extends the allowlist to the default selection
 * itself — READ: "if the default model for the user tier is not in
 * availableModels, Default resolves to the first allowed entry instead. Has no
 * effect when availableModels is unset or an empty array."
 *
 * @returns the model to start on, or null to leave `Default` alone.
 */
export function enforcedDefaultModel(
  allowlist: ReadonlyArray<string> | undefined,
  enforce: boolean | undefined
): string | null {
  if (enforce !== true) return null;
  if (!allowlist || allowlist.length === 0) return null;
  const first = allowlist.map((e) => e.trim()).find(Boolean);
  return first ?? null;
}

/**
 * A model the user has chosen, checked against the policy that arrived after
 * they chose it.
 *
 * A pinned model in a settings file can become disallowed between sessions.
 * Silently running it anyway is the same override this module exists to
 * prevent, so it falls back rather than persisting.
 */
export function permittedModel(
  wanted: string | undefined,
  allowlist: ReadonlyArray<string> | undefined,
  enforce: boolean | undefined
): string | undefined {
  const enforced = enforcedDefaultModel(allowlist, enforce);
  if (!wanted || wanted === DEFAULT_MODEL) return enforced ?? wanted;
  if (isModelAllowed(wanted, allowlist)) return wanted;
  return enforced ?? DEFAULT_MODEL;
}
