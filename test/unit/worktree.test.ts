import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  createWorktree,
  ensureIgnored,
  removeWorktree,
  repoRoot,
  WORKTREE_DIR
} from "../../src/services/worktree.js";

let root: string;

function git(args: string[], cwd = root): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  // `realpath`: macOS and Windows hand out temp dirs through a link, and git
  // reports the resolved path, so an unresolved one never compares equal.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "luno-wt-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "app.ts"), "export const a = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("repoRoot", () => {
  it("finds the repository a directory belongs to", async () => {
    expect(await repoRoot(root)).toBe(root);
  });

  it("returns null outside a repository", async () => {
    const plain = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "luno-plain-"))
    );
    try {
      expect(await repoRoot(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("createWorktree", () => {
  it("checks the repository out into its own directory and branch", async () => {
    const tree = await createWorktree(root, "alpha");

    expect(tree.path).toBe(path.join(root, WORKTREE_DIR, "alpha"));
    expect(tree.branch).toBe("worktree-alpha");
    expect(fs.existsSync(path.join(tree.path, "app.ts"))).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], tree.path)).toBe(
      "worktree-alpha"
    );
  });

  it("branches from HEAD so work in progress is visible", async () => {
    fs.writeFileSync(path.join(root, "wip.ts"), "export const b = 2;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "wip"]);

    const tree = await createWorktree(root, "alpha");

    // Branching from the remote default instead would hand the agent a tree
    // without the commit the user just made.
    expect(fs.existsSync(path.join(tree.path, "wip.ts"))).toBe(true);
  });

  it("leaves the main checkout on its own branch", async () => {
    await createWorktree(root, "alpha");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("reuses an existing checkout of the same name", async () => {
    const first = await createWorktree(root, "alpha");
    fs.writeFileSync(path.join(first.path, "note.txt"), "kept");

    const again = await createWorktree(root, "alpha");

    expect(again.path).toBe(first.path);
    expect(fs.readFileSync(path.join(again.path, "note.txt"), "utf8")).toBe(
      "kept"
    );
  });

  it("keeps worktrees out of the repository's own status", async () => {
    await createWorktree(root, "alpha");

    // Without the ignore entry the main tree reports the whole isolated
    // checkout as untracked, and `git add -A` there would commit it. The
    // freshly written `.gitignore` is expected to show up; the checkout is not.
    expect(git(["status", "--porcelain"])).not.toMatch(/worktrees/);
  });

  it("carries the files named in .worktreeinclude into the checkout", async () => {
    fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=abc\n");
    fs.writeFileSync(path.join(root, ".worktreeinclude"), "# secrets\n.env\n");

    const tree = await createWorktree(root, "alpha");

    expect(fs.readFileSync(path.join(tree.path, ".env"), "utf8")).toBe(
      "TOKEN=abc\n"
    );
  });

  it("refuses to copy a path that climbs out of the repository", async () => {
    const outside = path.join(root, "..", "outside-secret.txt");
    fs.writeFileSync(outside, "nope");
    fs.writeFileSync(
      path.join(root, ".worktreeinclude"),
      "../outside-secret.txt\n"
    );
    try {
      const tree = await createWorktree(root, "alpha");
      expect(fs.existsSync(path.join(tree.path, "outside-secret.txt"))).toBe(
        false
      );
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe("ensureIgnored", () => {
  it("adds the entry once, however often it runs", async () => {
    await ensureIgnored(root);
    await ensureIgnored(root);

    const lines = fs
      .readFileSync(path.join(root, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() === ".claude/worktrees/");
    expect(lines).toHaveLength(1);
  });

  it("does not glue itself onto an existing last line", async () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules");
    await ensureIgnored(root);

    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(
      "node_modules\n.claude/worktrees/"
    );
  });
});

describe("removeWorktree", () => {
  it("removes a checkout that holds no work", async () => {
    const tree = await createWorktree(root, "alpha");

    expect(await removeWorktree(root, tree)).toEqual({ removed: true });
    expect(fs.existsSync(tree.path)).toBe(false);
    expect(git(["branch", "--list", "worktree-alpha"])).toBe("");
  });

  it("keeps a checkout with uncommitted changes", async () => {
    const tree = await createWorktree(root, "alpha");
    fs.writeFileSync(path.join(tree.path, "app.ts"), "export const a = 2;\n");

    const result = await removeWorktree(root, tree);

    // Closing a tab must not cost the user an agent's afternoon.
    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/uncommitted/);
    expect(fs.existsSync(tree.path)).toBe(true);
  });

  it("keeps a checkout whose commits exist nowhere else", async () => {
    const tree = await createWorktree(root, "alpha");
    fs.writeFileSync(
      path.join(tree.path, "feature.ts"),
      "export const c = 3;\n"
    );
    git(["add", "-A"], tree.path);
    git(["commit", "-qm", "feature"], tree.path);

    const result = await removeWorktree(root, tree);

    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/not merged/);
    expect(fs.existsSync(tree.path)).toBe(true);
  });

  it("is a no-op for a checkout that is already gone", async () => {
    const tree = await createWorktree(root, "alpha");
    await removeWorktree(root, tree);

    expect(await removeWorktree(root, tree)).toEqual({ removed: true });
  });
});
