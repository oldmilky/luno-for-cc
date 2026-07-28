// ─────────────────────────────────────────────────────────────
// The gate in front of `bypass`, the only mode that turns the approval gate
// off, and the refusal that keeps the ungated modes away from Remote Control.
// The cycle order lives in core/permission-cycle.ts, which has no VS Code
// import and is therefore testable.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import { PermissionMode } from "../../core/types.js";

/**
 * Modes that let a tool call run without anyone being asked.
 *
 * `bypass` turns the gate off outright. `auto` keeps the destructive and
 * network gates but auto-allows edits, which is still a write to the user's
 * files that nobody approved. Neither is something to hand to a surface that
 * is not in the room.
 */
const UNGATED_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "auto",
  "bypass"
]);

export function isUngatedMode(mode: PermissionMode): boolean {
  return UNGATED_MODES.has(mode);
}

/**
 * Say why the mode did not change.
 *
 * Not modal: nothing is at risk, the refusal already happened, and a dialog
 * over a rejected click is the kind of thing people learn to dismiss without
 * reading.
 */
export function warnModeBlockedByRemoteControl(mode: PermissionMode): void {
  const name = mode === "bypass" ? "Bypass" : "Agent";
  void vscode.window.showWarningMessage(
    `${name} mode is not available while Remote Control is on. ` +
      "A connected phone would be able to make the agent write files with " +
      "nobody approving it here. Turn Remote Control off first."
  );
}

/** The other half of the same rule, said from the other side. */
export function warnRemoteControlBlockedByMode(mode: PermissionMode): void {
  const name = mode === "bypass" ? "Bypass" : "Agent";
  void vscode.window.showWarningMessage(
    `Remote Control cannot start in ${name} mode: tool calls would run for a ` +
      "connected device without an approval on either surface. Switch to Ask " +
      "or Plan first."
  );
}

/**
 * Ask before disabling the approval gate.
 *
 * Deliberately modal and deliberately not remembered. A "don't ask again" here
 * would defeat the point: the cost of the mode is per-session, so the question
 * is too.
 */
export async function confirmBypassMode(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    "Turn off the approval gate?",
    {
      modal: true,
      detail:
        "In Bypass mode the agent runs every tool without asking — including " +
        "file deletes, arbitrary shell commands, network calls and force-push. " +
        "No approval card will appear for anything.\n\n" +
        "Checkpoints still snapshot edited files, so edits remain reversible. " +
        "Deletes, pushes and commands that touch anything outside the " +
        "workspace are not.\n\n" +
        "Switch to Ask, Agent or Plan to turn the gate back on."
    },
    "Enable Bypass"
  );
  return choice === "Enable Bypass";
}
