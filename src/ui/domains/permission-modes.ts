// ─────────────────────────────────────────────────────────────
// Applying a permission mode, and the gate in front of `bypass` — the only
// mode that turns the approval gate off. The cycle order lives in
// core/permission-cycle.ts, which has no VS Code import and is therefore
// testable.
//
// Remote Control puts no restriction on the mode. Whose files these are, and
// what may run against them unattended, is the user's call to make on their own
// machine — a second surface does not turn it into someone else's.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import { log as logInfo } from "../../services/logger.js";
import { disabledPermissionModes } from "../../services/claude-settings.js";
import type { PermissionMode } from "../../core/types.js";

/**
 * Ask before disabling the approval gate.
 *
 * Deliberately modal and deliberately not remembered. A "don't ask again" here
 * would defeat the point: the cost of the mode is per-session, so the question
 * is too.
 */
async function confirmBypassMode(): Promise<boolean> {
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

/** What applying a mode needs from the conversation it is applied to. */
export interface ApplyModeTarget {
  /** Persist the mode and republish the composer's view of it. */
  apply: (mode: PermissionMode) => Promise<void>;
  /** Re-publish the current posture without changing it, so a picker showing a
   *  mode that was refused snaps back to the one actually in force. */
  republish: () => Promise<void>;
  /** Push the mode into a session process already running under the old one. */
  pushLive: (mode: PermissionMode) => void;
}

/**
 * Apply a permission mode asked for by the webview, or refuse it.
 *
 * Host-side rather than in the picker so no path into the mode can skip the
 * checks — not the picker, not a command, not a future caller that has not been
 * written yet. A policy that forbids a mode has to be enforced where the mode
 * is applied, not only where it is drawn: the picker already hides a disabled
 * mode, but a stale webview, a command and a keybinding all arrive here too.
 */
export async function applyPermissionMode(
  mode: string,
  target: ApplyModeTarget
): Promise<void> {
  if (disabledPermissionModes().includes(mode)) {
    logInfo(`[luno] permission mode ${mode} is disabled by settings.json`);
    await target.republish();
    return;
  }
  if (mode === "bypass" && !(await confirmBypassMode())) {
    await target.republish();
    return;
  }
  await target.apply(mode as PermissionMode);
  // A turn started on the phone rebuilds no argv to carry the mode — it would
  // keep running under the one the process was spawned with, which for Bypass
  // means no approval card anywhere while the composer reads Default.
  target.pushLive(mode as PermissionMode);
}
