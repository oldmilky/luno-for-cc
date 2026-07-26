import { describe, it, expect } from "vitest";
import { scopeForWrite } from "../../src/ui/domains/settings-scope.js";

// Regression cover for a control that looked dead with no error anywhere: a
// `.vscode/settings.json` pinning `luno.effort` and `luno.permissionMode` made
// both pickers un-clickable. Every click wrote Global, VS Code kept returning
// the narrower workspace value, and the UI echoed the old setting back.

describe("scopeForWrite", () => {
  it("writes global when nothing narrower is set", () => {
    expect(scopeForWrite(undefined)).toBe("global");
    expect(scopeForWrite({})).toBe("global");
    expect(
      scopeForWrite({
        workspaceValue: undefined,
        workspaceFolderValue: undefined
      })
    ).toBe("global");
  });

  it("writes to the workspace when the workspace holds the value", () => {
    expect(scopeForWrite({ workspaceValue: "max" })).toBe("workspace");
  });

  it("prefers the folder over the workspace when both are set", () => {
    // Narrowest wins on read, so it has to win on write too — otherwise the
    // write lands somewhere the read will never look.
    expect(
      scopeForWrite({ workspaceValue: "max", workspaceFolderValue: "low" })
    ).toBe("workspaceFolder");
  });

  it("treats a falsy value as present, because it is", () => {
    // `luno.thinking: false` is a setting a user deliberately turned off.
    // Checking truthiness here would route its write to Global and leave the
    // toggle unable to move — the original bug, in a second place.
    expect(scopeForWrite({ workspaceValue: false })).toBe("workspace");
    expect(scopeForWrite({ workspaceValue: "" })).toBe("workspace");
    expect(scopeForWrite({ workspaceValue: 0 })).toBe("workspace");
    expect(scopeForWrite({ workspaceFolderValue: false })).toBe(
      "workspaceFolder"
    );
  });

  it("ignores a global value when deciding — it is the fallback, not a signal", () => {
    // A global value always exists once anything has been written there. If it
    // counted as "narrower is set", every setting would pin itself to global
    // forever after the first write.
    expect(
      scopeForWrite({ globalValue: "high" } as unknown as {
        workspaceValue?: unknown;
      })
    ).toBe("global");
  });
});
