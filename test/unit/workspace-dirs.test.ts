import { describe, it, expect } from "vitest";
import {
  additionalDirectories,
  fallbackModelList,
  maxBudgetUsd
} from "../../src/core/workspace-dirs.js";

const input = (over: Partial<Parameters<typeof additionalDirectories>[0]>) => ({
  cwd: "/w/app",
  workspaceFolders: ["/w/app"],
  configured: [],
  isolated: false,
  ...over
});

describe("additionalDirectories — the multi-root fix", () => {
  it("adds every open folder except the one the CLI runs in", () => {
    expect(
      additionalDirectories(
        input({ workspaceFolders: ["/w/app", "/w/lib", "/w/docs"] })
      )
    ).toEqual(["/w/lib", "/w/docs"]);
  });

  it("adds nothing when the window holds only the folder it runs in", () => {
    // The single-root case is every user's default, and it must add no argv at
    // all — an empty `--add-dir` would be a flag with nothing after it.
    expect(additionalDirectories(input({}))).toEqual([]);
  });

  it("adds what the user configured, even outside the window", () => {
    expect(
      additionalDirectories(input({ configured: ["/elsewhere/shared"] }))
    ).toEqual(["/elsewhere/shared"]);
  });

  it("does not repeat a configured folder that is already open", () => {
    expect(
      additionalDirectories(
        input({
          workspaceFolders: ["/w/app", "/w/lib"],
          configured: ["/w/lib"]
        })
      )
    ).toEqual(["/w/lib"]);
  });

  it("treats a trailing separator and a different case as the same folder", () => {
    expect(
      additionalDirectories(
        input({
          cwd: "C:/Work/App",
          workspaceFolders: ["C:\\work\\app\\", "C:/Work/Lib"],
          configured: ["c:/work/lib"]
        })
      )
    ).toEqual(["C:/Work/Lib"]);
  });

  it("keeps a stable order, because argv order replaces a live process", () => {
    const args = input({
      workspaceFolders: ["/w/app", "/w/b", "/w/a"],
      configured: ["/w/z"]
    });
    expect(additionalDirectories(args)).toEqual(["/w/b", "/w/a", "/w/z"]);
    expect(additionalDirectories(args)).toEqual(additionalDirectories(args));
  });

  it("ignores blank entries rather than passing an empty argument", () => {
    expect(
      additionalDirectories(input({ configured: ["", "   ", "/w/real"] }))
    ).toEqual(["/w/real"]);
  });
});

describe("additionalDirectories — isolation is not negotiable", () => {
  it("never hands an isolated conversation the folders it was isolated from", () => {
    // Worse than not isolating: the user believes their tree is untouched
    // while the agent writes into it from a private checkout.
    expect(
      additionalDirectories(
        input({
          cwd: "/w/.worktrees/chat-1",
          workspaceFolders: ["/w/app", "/w/lib"],
          isolated: true
        })
      )
    ).toEqual([]);
  });

  it("still honours folders the user named by hand", () => {
    // Those were chosen knowing what this chat is; the window's were not.
    expect(
      additionalDirectories(
        input({
          cwd: "/w/.worktrees/chat-1",
          workspaceFolders: ["/w/app"],
          configured: ["/elsewhere/shared"],
          isolated: true
        })
      )
    ).toEqual(["/elsewhere/shared"]);
  });
});

describe("fallbackModelList", () => {
  it("joins with commas, which is the syntax the flag documents", () => {
    // READ from `--help`: "Accepts a comma-separated list to try each in turn."
    // One flag, not one per model — repeated, only the last would survive.
    expect(fallbackModelList(["opus", "haiku"], "sonnet")).toBe("opus,haiku");
  });

  it("drops the model that is already in use", () => {
    // Falling back to the one that just failed is not a fallback.
    expect(fallbackModelList(["sonnet", "haiku"], "sonnet")).toBe("haiku");
  });

  it("says nothing when there is nothing left to say", () => {
    expect(fallbackModelList([], "sonnet")).toBeNull();
    expect(fallbackModelList(undefined, "sonnet")).toBeNull();
    expect(fallbackModelList(["sonnet"], "sonnet")).toBeNull();
  });

  it("drops blanks and duplicates", () => {
    expect(fallbackModelList(["opus", "", "opus", "  ", "haiku"], "x")).toBe(
      "opus,haiku"
    );
  });

  it("works when no model was picked at all", () => {
    expect(fallbackModelList(["opus"], undefined)).toBe("opus");
  });
});

describe("maxBudgetUsd", () => {
  it("passes a real ceiling through", () => {
    expect(maxBudgetUsd(5)).toBe(5);
    expect(maxBudgetUsd(0.5)).toBe(0.5);
  });

  it("reads zero as off, not as “spend nothing”", () => {
    // A ceiling of zero would end every turn before it began, and nobody types
    // it meaning that.
    expect(maxBudgetUsd(0)).toBeNull();
  });

  it("refuses a negative or nonsense value", () => {
    expect(maxBudgetUsd(-1)).toBeNull();
    expect(maxBudgetUsd("lots")).toBeNull();
    expect(maxBudgetUsd(undefined)).toBeNull();
    expect(maxBudgetUsd(Number.NaN)).toBeNull();
  });
});
