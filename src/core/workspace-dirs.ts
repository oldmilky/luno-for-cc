// ─────────────────────────────────────────────────────────────
// Which folders the agent may touch besides the one it runs in.
//
// The CLI works out of a single `cwd`, and until now that was the whole of
// what a conversation could see. In a multi-root window that is simply wrong:
// the user has three folders open, the agent knows about one, and says a file
// does not exist when it is right there in the second.
//
// `--add-dir` is the CLI's own answer, and this decides what goes into it.
// Pure, because the one case that is easy to get wrong — an isolated
// conversation — is a rule rather than an API call.
// ─────────────────────────────────────────────────────────────

/** Trailing separators and case differ between what VS Code reports and what a
 *  user types into a setting; neither should make one folder look like two. */
function normalise(dir: string): string {
  return dir
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

export interface AddDirInput {
  /** Where the CLI will run. Never repeated into `--add-dir`. */
  cwd: string | undefined;
  /** Every folder open in the window, in VS Code's own order. */
  workspaceFolders: ReadonlyArray<string>;
  /** `luno.additionalDirectories` — folders outside the window entirely. */
  configured: ReadonlyArray<string>;
  /**
   * True when this conversation runs in its own git worktree.
   *
   * The one case worth stating: an isolated conversation must **not** be handed
   * the folders it was isolated from. Doing so would leave it running in a
   * private checkout while writing into the shared one, which is worse than
   * never having isolated it — the user believes their tree is untouched.
   */
  isolated: boolean;
}

/**
 * The `--add-dir` list: every open folder that is not already the `cwd`, plus
 * whatever the user configured.
 *
 * Deduplicated and order-stable. Order matters more than it looks: argv decides
 * whether a session-mode process survives a turn, and a set iterated in a
 * different order would replace the CLI process over nothing.
 */
export function additionalDirectories(input: AddDirInput): string[] {
  const seen = new Set<string>();
  if (input.cwd) seen.add(normalise(input.cwd));

  const out: string[] = [];
  const take = (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed) return;
    const key = normalise(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  // An isolated conversation gets none of the window's folders — that is what
  // isolation means. What the user configured by hand still applies: they named
  // those folders knowing what this chat is.
  if (!input.isolated) for (const dir of input.workspaceFolders) take(dir);
  for (const dir of input.configured) take(dir);
  return out;
}

/**
 * The models to fall back to when the first is overloaded, as the CLI's own
 * comma-separated list.
 *
 * READ from `--help`: "Accepts a comma-separated list to try each in turn." So
 * one flag, not one per model — passing it repeatedly would keep only the last.
 *
 * @returns null when there is nothing to say, so the caller adds no flag rather
 *   than an empty one.
 */
export function fallbackModelList(
  models: ReadonlyArray<string> | undefined,
  current: string | undefined
): string | null {
  const seen = new Set<string>();
  const wanted = current?.trim();
  const out: string[] = [];
  for (const model of models ?? []) {
    const name = model.trim();
    // Falling back to the model that just failed is not a fallback.
    if (!name || name === wanted || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.length > 0 ? out.join(",") : null;
}

/**
 * A per-session spend ceiling, or null when the setting is off or nonsense.
 *
 * Zero is "off" rather than "spend nothing": a ceiling of zero would end every
 * turn before it began, and nobody types it meaning that.
 */
export function maxBudgetUsd(value: unknown): number | null {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}
