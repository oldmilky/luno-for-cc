import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(exec);

// `vscode.workspace.findFiles` searches the *workspace folders* and nothing
// else. A conversation isolated in a git worktree works in a directory that is
// none of them, so every `@` mention it offered came from the main checkout —
// the agent got paths to files it was not editing. The fake below is
// deliberately faithful about that: it only ever answers with the folder.
const folder = vi.hoisted(() => ({ root: "" }));
const settings = vi.hoisted(() => ({ respectGitIgnore: true }));

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return folder.root
        ? [{ uri: { fsPath: folder.root }, name: "ws" }]
        : undefined;
    },
    findFiles: async () => [
      { path: `${folder.root}/main-only.ts`, fsPath: "" }
    ],
    asRelativePath: (u: { path: string }) =>
      u.path.replace(`${folder.root}/`, ""),
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) =>
        key === "respectGitIgnore" ? settings.respectGitIgnore : fallback
    })
  },
  RelativePattern: class {
    constructor(
      public base: unknown,
      public pattern: string
    ) {}
  },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) }
}));

const { searchFiles } = await import("../../src/ui/domains/files.js");

let main: string;
let tree: string;

beforeEach(async () => {
  main = await fs.mkdtemp(path.join(os.tmpdir(), "luno-fs-main-"));
  tree = await fs.mkdtemp(path.join(os.tmpdir(), "luno-fs-tree-"));
  folder.root = main;
});

afterEach(async () => {
  await fs.rm(main, { recursive: true, force: true });
  await fs.rm(tree, { recursive: true, force: true });
  folder.root = "";
});

/** A real git checkout, because the worktree path shells out to `git`. */
async function gitInit(dir: string, files: Record<string, string>) {
  await pexec("git init", { cwd: dir });
  await pexec('git config user.email "t@t.com"', { cwd: dir });
  await pexec('git config user.name "t"', { cwd: dir });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  await pexec("git add -A && git commit -m init", { cwd: dir });
}

function collect(): {
  post: (m: unknown) => void;
  results: () => Array<{ path: string; name: string }>;
} {
  const sent: Array<{ type?: string; results?: unknown }> = [];
  return {
    post: (m) => sent.push(m as { type?: string }),
    results: () =>
      (sent.find((m) => m.type === "fileSearchResults")?.results ??
        []) as Array<{ path: string; name: string }>
  };
}

describe("searchFiles across a worktree", () => {
  it("offers the isolated checkout's files, not the main one's", async () => {
    await gitInit(tree, { "src/isolated.ts": "export {}" });
    const { post, results } = collect();

    await searchFiles(post, "isolated", "q1", tree);

    expect(results().map((r) => r.path)).toEqual(["src/isolated.ts"]);
  });

  it("never leaks a main-checkout path into an isolated conversation", async () => {
    await gitInit(tree, { "src/isolated.ts": "export {}" });
    const { post, results } = collect();

    await searchFiles(post, "", "q2", tree);

    // `main-only.ts` is all the workspace search can return. Seeing it here
    // would mean the isolated conversation was handed the wrong tree.
    expect(results().map((r) => r.path)).not.toContain("main-only.ts");
  });

  it("still uses the workspace index when the conversation is not isolated", async () => {
    const { post, results } = collect();

    await searchFiles(post, "main", "q3", main);

    expect(results().map((r) => r.path)).toEqual(["main-only.ts"]);
  });

  it("treats a root equal to the folder as not isolated, separators aside", async () => {
    const { post, results } = collect();

    await searchFiles(
      post,
      "main",
      "q4",
      main.replace(/\//g, path.sep) + path.sep
    );

    expect(results().map((r) => r.path)).toEqual(["main-only.ts"]);
  });

  // The repository's own ignore rules, rather than the hard-coded exclude list
  // the workspace search carries.
  it("honours .gitignore in the isolated checkout", async () => {
    await gitInit(tree, {
      ".gitignore": "secret.ts\n",
      "keep.ts": "export {}"
    });
    await fs.writeFile(path.join(tree, "secret.ts"), "export {}");
    const { post, results } = collect();

    await searchFiles(post, "", "q5", tree);

    const paths = results().map((r) => r.path);
    expect(paths).toContain("keep.ts");
    expect(paths).not.toContain("secret.ts");
  });

  // The workspace search excluded a fixed list — node_modules, dist and a few
  // others — so anything a project ignored for its own reasons was offered up
  // anyway. This repo's own `ghost.one/` is the case that named the bug.
  it("honours .gitignore in the open folder too, not just a worktree", async () => {
    await gitInit(main, { ".gitignore": "vendor/\n", "app.ts": "export {}" });
    await fs.mkdir(path.join(main, "vendor"), { recursive: true });
    await fs.writeFile(path.join(main, "vendor", "app.ts"), "export {}");
    const { post, results } = collect();

    await searchFiles(post, "app", "q7", main);

    expect(results().map((r) => r.path)).toEqual(["app.ts"]);
  });

  it("falls back to the workspace index when the setting is off", async () => {
    await gitInit(main, { "app.ts": "export {}" });
    settings.respectGitIgnore = false;
    const { post, results } = collect();

    await searchFiles(post, "main", "q8", main);

    // `main-only.ts` exists only in the findFiles stub, so seeing it proves
    // the git path was skipped.
    expect(results().map((r) => r.path)).toEqual(["main-only.ts"]);
    settings.respectGitIgnore = true;
  });

  it("returns nothing rather than throwing when the tree is not a repository", async () => {
    const { post, results } = collect();

    await searchFiles(post, "anything", "q6", tree);

    expect(results()).toEqual([]);
  });
});
