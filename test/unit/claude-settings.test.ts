// ─────────────────────────────────────────────────────────────
// The "Question auto-continue timeout" the user set for Claude Code.
//
// The values and their mapping are the CLI's own, and the default matters
// more than any of them: unset means `never`, which is why a question in
// Claude Code waits indefinitely and why LUNO must not invent a deadline.
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  askUserQuestionTimeoutMs,
  disabledPermissionModes
} from "../../src/services/claude-settings.js";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "luno-claude-cfg-"));
  previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (contents: string) =>
  fs.writeFileSync(path.join(dir, "settings.json"), contents);

describe("askUserQuestionTimeoutMs", () => {
  it("maps the CLI's four values", () => {
    const cases: Array<[string, number | null]> = [
      ["60s", 60_000],
      ["5m", 300_000],
      ["10m", 600_000],
      ["never", null]
    ];
    for (const [value, expected] of cases) {
      write(JSON.stringify({ askUserQuestionTimeout: value }));
      expect(askUserQuestionTimeoutMs(), value).toBe(expected);
    }
  });

  it("is null when the key is unset — the CLI's own default is `never`", () => {
    write(JSON.stringify({ theme: "dark" }));
    expect(askUserQuestionTimeoutMs()).toBeNull();
  });

  it("is null when there is no settings file at all", () => {
    expect(askUserQuestionTimeoutMs()).toBeNull();
  });

  it("survives a settings file that is not readable JSON", () => {
    // A broken preference must never take a permission prompt down with it:
    // the turn is blocked on that card.
    write("{ not json");
    expect(askUserQuestionTimeoutMs()).toBeNull();
    write("[]");
    expect(askUserQuestionTimeoutMs()).toBeNull();
    write("null");
    expect(askUserQuestionTimeoutMs()).toBeNull();
  });

  it("ignores a value the CLI does not define", () => {
    write(JSON.stringify({ askUserQuestionTimeout: "30s" }));
    expect(askUserQuestionTimeoutMs()).toBeNull();
    write(JSON.stringify({ askUserQuestionTimeout: 60000 }));
    expect(askUserQuestionTimeoutMs()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// A mode the user's own settings forbid.
//
// The reference client drops the entry from its picker rather than refusing the
// choice afterwards, and so does LUNO: a mode that is rejected the moment it is
// clicked is worse than one that was never on the menu.
// ─────────────────────────────────────────────────────────────

describe("disabledPermissionModes", () => {
  it("forbids bypass when the CLI's own key says so", () => {
    write(
      JSON.stringify({
        permissions: { disableBypassPermissionsMode: "disable" }
      })
    );
    expect(disabledPermissionModes()).toEqual(["bypass"]);
  });

  it("forbids nothing by default", () => {
    // Absent, empty, and a settings file that does not exist all mean "no
    // policy". Reading any of them as a prohibition would take a working mode
    // away from everyone who never configured one.
    expect(disabledPermissionModes()).toEqual([]);
    write(JSON.stringify({}));
    expect(disabledPermissionModes()).toEqual([]);
    write(JSON.stringify({ permissions: {} }));
    expect(disabledPermissionModes()).toEqual([]);
    write(JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    expect(disabledPermissionModes()).toEqual([]);
  });

  it("reads only the CLI's own spelling", () => {
    // `"disable"` is the whole vocabulary. Anything else — including a
    // plausible-looking `true` — is not the key being set.
    for (const value of [true, "yes", "disabled", 1, null]) {
      write(
        JSON.stringify({
          permissions: { disableBypassPermissionsMode: value }
        })
      );
      expect(disabledPermissionModes()).toEqual([]);
    }
  });

  it("survives a settings file that is not readable JSON", () => {
    for (const broken of ["{ not json", "[]", "null", '"a string"']) {
      write(broken);
      expect(disabledPermissionModes()).toEqual([]);
    }
  });
});
