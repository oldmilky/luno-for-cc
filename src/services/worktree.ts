// ─────────────────────────────────────────────────────────────
// Git worktrees — one isolated checkout per conversation.
//
// Five agents editing one working tree is not a theoretical hazard. Checkpoints
// snapshot files per conversation, so a rewind in one chat restores a version
// that predates another chat's edits; and `git add -A` in either stages
// whatever the other happened to have written a second earlier. A worktree per
// conversation removes both by construction: separate files, separate branch,
// shared history.
//
// Creation is `git worktree add` rather than the CLI's own `--worktree` flag,
// because we need the resulting path ourselves — checkpoints, diffs and
// file-open all resolve against the conversation's tree, and inferring it from
// an undocumented layout would be a guess we cannot verify.
// ─────────────────────────────────────────────────────────────

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(exec);

/** Where worktrees live, relative to the repository root. Matches the layout
 *  Claude Code's own `--worktree` uses, so both agree on where to look. */
export const WORKTREE_DIR = path.join(".claude", "worktrees");

/** Lines in `.worktreeinclude` name gitignored files a fresh checkout needs —
 *  `.env` and friends. Plain relative paths, one per line, `#` for comments. */
const INCLUDE_FILE = ".worktreeinclude";

export interface Worktree {
  /** Absolute path of the isolated checkout. */
  path: string;
  branch: string;
  name: string;
}

export interface RemovalResult {
  removed: boolean;
  /** Why it was kept. Present only when `removed` is false. */
  reason?: string;
}

async function git(cwd: string, args: string): Promise<string> {
  const { stdout } = await pexec(`git ${args}`, { cwd, windowsHide: true });
  return stdout.trim();
}

/**
 * The repository root containing `dir`, or null when it is not a git repo.
 *
 * Normalised, because git answers with forward slashes on Windows while every
 * path this is compared or joined with comes from VS Code with backslashes —
 * the two never match as strings.
 */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return path.normalize(await git(dir, "rev-parse --show-toplevel"));
  } catch {
    return null;
  }
}

/**
 * Create an isolated checkout for a conversation.
 *
 * Branches from the current `HEAD`, not from the remote's default branch: a
 * chat that cannot see the work already in progress is useless in an editor,
 * where the whole point is that the agent looks at what you are looking at.
 *
 * Reuses an existing worktree of the same name rather than failing, so
 * reopening a stored conversation returns to the tree it was working in.
 */
export async function createWorktree(
  root: string,
  name: string
): Promise<Worktree> {
  const branch = `worktree-${name}`;
  const target = path.join(root, WORKTREE_DIR, name);
  const worktree: Worktree = { path: target, branch, name };

  if (await exists(target)) return worktree;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await ensureIgnored(root);
  try {
    await git(root, `worktree add -b ${quote(branch)} ${quote(target)} HEAD`);
  } catch (err) {
    // A branch left behind by a previous worktree of the same name: check it
    // out instead of failing, which is what "reuse the name" has to mean.
    if (!/already exists/i.test(String(err))) throw err;
    await git(root, `worktree add ${quote(target)} ${quote(branch)}`);
  }
  await copyIncludedFiles(root, target);
  return worktree;
}

/**
 * Remove a conversation's checkout, refusing when that would destroy work.
 *
 * Deliberately conservative: a worktree holding uncommitted edits or commits
 * that exist nowhere else is kept, and the caller is told where it is. Losing
 * an agent's afternoon because a tab was closed is not a trade worth making.
 */
export async function removeWorktree(
  root: string,
  tree: Worktree
): Promise<RemovalResult> {
  if (!(await exists(tree.path))) return { removed: true };

  const dirty = await hasUncommittedChanges(tree.path);
  if (dirty) {
    return { removed: false, reason: "it has uncommitted changes" };
  }
  const unpushed = await hasUnmergedCommits(root, tree);
  if (unpushed) {
    return { removed: false, reason: "it has commits that are not merged" };
  }

  await git(root, `worktree remove ${quote(tree.path)}`);
  await git(root, `branch -D ${quote(tree.branch)}`).catch(() => undefined);
  return { removed: true };
}

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, "status --porcelain")).length > 0;
  } catch {
    // Unreadable state is treated as "might hold work" — the safe direction.
    return true;
  }
}

async function hasUnmergedCommits(
  root: string,
  tree: Worktree
): Promise<boolean> {
  try {
    const head = await git(root, "rev-parse HEAD");
    const ahead = await git(tree.path, `rev-list --count ${quote(head)}..HEAD`);
    return Number(ahead) > 0;
  } catch {
    return true;
  }
}

/**
 * Keep worktrees out of the repository's own status.
 *
 * Without this every isolated checkout shows up as hundreds of untracked files
 * in the main tree, and an agent running `git add -A` there would commit
 * another conversation's entire working copy.
 */
export async function ensureIgnored(root: string): Promise<void> {
  const gitignore = path.join(root, ".gitignore");
  const entry = ".claude/worktrees/";
  const current = await fs.readFile(gitignore, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await fs.appendFile(gitignore, `${prefix}${entry}\n`);
}

/**
 * Carry gitignored-but-required files into the fresh checkout.
 *
 * A worktree is a clean checkout, so `.env` and anything else the project needs
 * but does not track is simply absent — and the agent's first command fails for
 * a reason that has nothing to do with the task.
 */
async function copyIncludedFiles(root: string, target: string): Promise<void> {
  const list = await fs
    .readFile(path.join(root, INCLUDE_FILE), "utf8")
    .catch(() => "");
  const wanted = list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  for (const rel of wanted) {
    // Refuse to follow a path out of the repository, which is the one way a
    // committed `.worktreeinclude` could reach a file it has no business
    // reading.
    const from = path.resolve(root, rel);
    if (!from.startsWith(path.resolve(root) + path.sep)) continue;
    const to = path.join(target, rel);
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    } catch {
      // Best-effort: a listed file that does not exist is not an error worth
      // failing a conversation over.
    }
  }
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** Quote a path for the shell `exec` runs. Worktrees live under the user's
 *  repository, so spaces in the path are ordinary rather than exotic. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
