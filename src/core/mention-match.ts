// ─────────────────────────────────────────────────────────────
// Ranking for the @-mention popover.
//
// The half worth testing lives here: deciding which of a thousand paths a
// half-typed token meant is pure string work, while producing those paths
// needs git and the editor. `ui/domains/files.ts` supplies the candidates,
// this puts them in order.
// ─────────────────────────────────────────────────────────────

export type MentionKind = "file" | "folder";

export interface MentionEntry {
  /** Workspace-relative, forward slashes. Folders carry a trailing slash. */
  path: string;
  /** Last segment — what the popover shows in the strong position. */
  name: string;
  kind: MentionKind;
}

/**
 * Below this a subsequence match is noise: every path in a repository is a
 * subsequence hit for one or two characters, which buries the exact matches
 * the user was actually reaching for.
 */
const MIN_FUZZY_QUERY = 2;
const MIN_PATH_FUZZY_QUERY = 3;

/**
 * How well an entry answers the query — lower is better, `null` is no answer.
 *
 * The tiers are ordered by how deliberate the match is. A prefix of the
 * filename is what the user was typing; a subsequence of the whole path is
 * what they might have been. Keeping filename hits above path hits is why
 * `@panel` still surfaces `panel.ts` in a project where forty files live
 * under `src/panel/`.
 */
export function matchTier(entry: MentionEntry, query: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();

  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (q.length >= MIN_FUZZY_QUERY && isSubsequence(name, q)) return 2;
  if (path.includes(q)) return 3;
  if (q.length >= MIN_PATH_FUZZY_QUERY && isSubsequence(path, q)) return 4;
  return null;
}

/**
 * The matching entries, best first, capped at `limit`.
 *
 * Ties break on path length before alphabet, which is what puts a folder
 * above its own contents without a rule saying so: `src/ui/` is shorter than
 * everything inside it.
 */
export function rankMentions(
  entries: ReadonlyArray<MentionEntry>,
  query: string,
  limit: number
): MentionEntry[] {
  const scored: Array<{ entry: MentionEntry; tier: number }> = [];
  for (const entry of entries) {
    const tier = matchTier(entry, query);
    if (tier !== null) scored.push({ entry, tier });
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.entry.path.length !== b.entry.path.length)
      return a.entry.path.length - b.entry.path.length;
    return a.entry.path.localeCompare(b.entry.path);
  });
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Every folder on the way to each file, once. A repository lists files and
 * nothing else, so the folders the user can mention have to be read back out
 * of the paths.
 */
export function foldersFromPaths(paths: ReadonlyArray<string>): MentionEntry[] {
  const seen = new Set<string>();
  const out: MentionEntry[] = [];
  for (const file of paths) {
    let cut = file.indexOf("/");
    while (cut !== -1) {
      const dir = file.slice(0, cut + 1);
      if (!seen.has(dir)) {
        seen.add(dir);
        out.push({
          path: dir,
          name: dir.slice(0, -1).split("/").pop() ?? dir,
          kind: "folder"
        });
      }
      cut = file.indexOf("/", cut + 1);
    }
  }
  return out;
}

/** Whether `q`'s characters appear in `text` in order, gaps allowed. */
function isSubsequence(text: string, q: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}
