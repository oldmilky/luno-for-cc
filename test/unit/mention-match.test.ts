import { describe, expect, it } from "vitest";

import {
  foldersFromPaths,
  matchTier,
  rankMentions,
  type MentionEntry
} from "../../src/core/mention-match.js";

const file = (path: string): MentionEntry => ({
  path,
  name: path.split("/").pop() ?? path,
  kind: "file"
});

const TREE = [
  "webview/src/features/chat/Composer.tsx",
  "webview/src/features/chat/MentionPopover.tsx",
  "webview/src/features/chat/ChatScreen.tsx",
  "src/ui/domains/files.ts",
  "src/ui/panel.ts",
  "src/core/types.ts",
  "company-panel-legacy.ts"
].map(file);

describe("mention ranking", () => {
  // The ordering this file exists to protect: a filename hit outranks a path
  // hit, so a project with forty files under `src/panel/` still answers
  // `@panel` with panel.ts.
  it("puts a filename prefix above everything else", () => {
    const [first] = rankMentions(TREE, "panel", 12);
    expect(first.path).toBe("src/ui/panel.ts");
  });

  it("ranks a filename substring above a path match", () => {
    expect(matchTier(file("src/ui/panel.ts"), "panel")).toBeLessThan(
      matchTier(file("src/panel/index.ts"), "panel") ?? Infinity
    );
  });

  it("finds a file by a subsequence of its name", () => {
    const hits = rankMentions(TREE, "mpop", 12).map((e) => e.path);
    expect(hits).toContain("webview/src/features/chat/MentionPopover.tsx");
  });

  it("finds a file by a fragment of its path", () => {
    const hits = rankMentions(TREE, "chat/comp", 12).map((e) => e.path);
    expect(hits).toEqual(["webview/src/features/chat/Composer.tsx"]);
  });

  // One and two characters subsequence-match nearly every path in a
  // repository, which buries the exact hits the user was reaching for.
  it("does not fuzzy-match on a single character", () => {
    expect(matchTier(file("src/core/types.ts"), "z")).toBeNull();
  });

  it("keeps a query that matches nothing empty", () => {
    expect(rankMentions(TREE, "zzqq", 12)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(rankMentions(TREE, "", 3)).toHaveLength(3);
  });
});

describe("folders derived from paths", () => {
  it("names every level once, with a trailing slash", () => {
    const folders = foldersFromPaths([
      "src/ui/domains/files.ts",
      "src/ui/panel.ts"
    ]).map((f) => f.path);
    expect(folders).toEqual(["src/", "src/ui/", "src/ui/domains/"]);
  });

  it("labels a folder by its last segment", () => {
    const [, ui] = foldersFromPaths(["src/ui/panel.ts"]);
    expect(ui).toMatchObject({ path: "src/ui/", name: "ui", kind: "folder" });
  });

  it("finds nothing to derive from a file at the root", () => {
    expect(foldersFromPaths(["README.md"])).toEqual([]);
  });

  // A folder's path is a prefix of everything inside it, so the length
  // tie-break is what lifts it above its own contents without a rule for it.
  it("surfaces a folder above the files under it", () => {
    const entries = [...TREE, ...foldersFromPaths(TREE.map((e) => e.path))];
    const [first] = rankMentions(entries, "domains", 12);
    expect(first).toMatchObject({ path: "src/ui/domains/", kind: "folder" });
  });
});
