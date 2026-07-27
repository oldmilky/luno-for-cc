// ─────────────────────────────────────────────────────────────
// The gate in front of `bypass`, the only mode that turns the approval gate
// off. The cycle order lives in core/permission-cycle.ts, which has no VS Code
// import and is therefore testable.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";

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
