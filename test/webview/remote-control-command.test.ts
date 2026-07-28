import { describe, it, expect } from "vitest";
import { isRemoteControlCommand } from "../../webview/src/features/chat/remote-control-command";

describe("remote control slash command", () => {
  it("catches both spellings the CLI accepts", () => {
    expect(isRemoteControlCommand("/rc")).toBe(true);
    expect(isRemoteControlCommand("/remote-control")).toBe(true);
  });

  it("tolerates surrounding whitespace and case", () => {
    expect(isRemoteControlCommand("  /rc  ")).toBe(true);
    expect(isRemoteControlCommand("/Remote-Control")).toBe(true);
  });

  it("leaves a question about the command alone", () => {
    // The command is the whole message or nothing, matching how the CLI
    // resolves slash commands. Swallowing this would answer a question the
    // user asked by silently toggling a connection instead.
    expect(isRemoteControlCommand("what does /remote-control do?")).toBe(false);
    expect(isRemoteControlCommand("/rc please")).toBe(false);
  });

  it("does not fire on an unrelated command", () => {
    expect(isRemoteControlCommand("/review")).toBe(false);
    expect(isRemoteControlCommand("/recap")).toBe(false);
    expect(isRemoteControlCommand("")).toBe(false);
  });
});
