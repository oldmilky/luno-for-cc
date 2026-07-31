import { describe, it, expect } from "vitest";
import {
  resolveStartupCards,
  shorten
} from "../../webview/src/features/chat/startup-suggestions.js";
import type { SlashCommand } from "../../webview/src/lib/rpc.js";

// startup-suggestions.ts is React-free, so it runs in the node environment.
// It decides the empty state's cards from `luno.startupSuggestions` and the
// live slash-command list, which is the whole of the screen's content.

const cmd = (
  name: string,
  source: SlashCommand["source"],
  description?: string
): SlashCommand => ({ name, source, description });

describe("resolveStartupCards — auto", () => {
  it("splits the live list into Project and Personal", () => {
    const groups = resolveStartupCards(
      [],
      [cmd("check", "project"), cmd("start", "user")]
    );
    expect(groups).toEqual([
      { label: "Project", items: [{ text: "/check ", title: "/check" }] },
      { label: "Personal", items: [{ text: "/start ", title: "/start" }] }
    ]);
  });

  it("drops the CLI's own list", () => {
    // With plugins installed the CLI reports well over a hundred names and
    // carries no description for any of them.
    const groups = resolveStartupCards(
      [],
      [cmd("check", "project"), cmd("marketing-skills:ads", "cli")]
    );
    expect(groups).toEqual([
      { label: "Project", items: [{ text: "/check ", title: "/check" }] }
    ]);
  });

  it("caps at six", () => {
    const many = Array.from({ length: 20 }, (_, i) => cmd(`s${i}`, "project"));
    expect(resolveStartupCards([], many)[0].items).toHaveLength(6);
  });

  it("omits an empty group rather than rendering an empty badge", () => {
    const groups = resolveStartupCards([], [cmd("check", "project")]);
    expect(groups.map((g) => g.label)).toEqual(["Project"]);
  });

  it("falls back to generic prompts with no badge when nothing is on disk", () => {
    // Every project has no skills until someone writes one; a bare hero is
    // not an acceptable first impression.
    const groups = resolveStartupCards([], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBeNull();
    expect(groups[0].items).toHaveLength(4);
    expect(groups[0].items[0].text).toBe("Explain this codebase");
  });

  it("falls back when the CLI list is all there is", () => {
    const groups = resolveStartupCards([], [cmd("ads", "cli")]);
    expect(groups[0].label).toBeNull();
  });
});

describe("resolveStartupCards — configured", () => {
  const commands = [
    cmd("check", "project", "Fast read-only review of the working tree."),
    cmd("start", "user", "Load project context at the start of a session.")
  ];

  it("keeps the configured order inside each group", () => {
    const groups = resolveStartupCards(
      ["/start", "/check", "/brainstorming"],
      [...commands, cmd("brainstorming", "user")]
    );
    expect(groups.map((g) => g.items.map((i) => i.title))).toEqual([
      ["/check"],
      ["/start", "/brainstorming"]
    ]);
  });

  it("shows a name nothing on disk answers to, without a sub-line", () => {
    const groups = resolveStartupCards(["/nosuch"], commands);
    expect(groups).toEqual([
      { label: "Personal", items: [{ text: "/nosuch ", title: "/nosuch" }] }
    ]);
  });

  it("treats an entry without a slash as a literal prompt", () => {
    const groups = resolveStartupCards(["Explain this codebase"], commands);
    expect(groups[0].items[0]).toEqual({
      text: "Explain this codebase",
      title: "Explain this codebase"
    });
  });

  it("gives a command a trailing space and a prompt none", () => {
    // The space is where the argument goes: `/ship ` with the cursor after it
    // is the difference between a usable card and one that runs empty.
    const groups = resolveStartupCards(["/check", "just do it"], commands);
    const [project, personal] = groups;
    expect(project.items[0].text).toBe("/check ");
    expect(personal.items[0].text).toBe("just do it");
  });

  it("ignores blank and whitespace-only entries", () => {
    const groups = resolveStartupCards(["", "   ", "/check"], commands);
    expect(groups).toEqual([
      {
        label: "Project",
        items: [
          {
            text: "/check ",
            title: "/check",
            sub: "Fast read-only review of the working tree"
          }
        ]
      }
    ]);
  });

  it("survives a hand-edited settings.json that is not a list of strings", () => {
    // The schema in package.json is a hint to the editor, not a guarantee:
    // `.map` on whatever arrives is how the hero blanks the whole panel.
    const junk = [42, null, { command: "/check" }, "/start"] as never;
    expect(resolveStartupCards(junk, commands)).toEqual([
      {
        label: "Personal",
        items: [
          {
            text: "/start ",
            title: "/start",
            sub: "Load project context at the start of a session"
          }
        ]
      }
    ]);
    expect(resolveStartupCards("/check" as never, commands)[0].label).toBe(
      "Project"
    );
  });

  it("falls back to auto when every entry is blank", () => {
    const groups = resolveStartupCards(["  "], commands);
    expect(groups.map((g) => g.items.map((i) => i.title))).toEqual([
      ["/check"],
      ["/start"]
    ]);
  });
});

describe("shorten", () => {
  it("keeps the summary and drops the trigger clause", () => {
    expect(
      shorten(
        "Fast read-only review of the uncommitted working tree. Use when the user says /check, or mid-feature before committing."
      )
    ).toBe("Fast read-only review of the uncommitted working tree");
  });

  it("clamps a long first sentence on a word boundary", () => {
    const sub = shorten(
      "Deep read-only review of the branch diff against a base ref, across several lenses, with every HIGH finding independently refuted."
    );
    expect(sub).toBe(
      "Deep read-only review of the branch diff against a base ref, across several lenses, with…"
    );
    expect(sub!.length).toBeLessThanOrEqual(91);
  });

  it("returns undefined for a missing or empty description", () => {
    expect(shorten(undefined)).toBeUndefined();
    expect(shorten("   ")).toBeUndefined();
  });

  it("leaves a short single sentence alone", () => {
    expect(shorten("Match existing test patterns")).toBe(
      "Match existing test patterns"
    );
  });
});
