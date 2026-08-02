// ─────────────────────────────────────────────────────────────
// Raising the banner — the half that needs a window.
//
// Everything worth deciding is decided in `core/notify.ts`. What is left here
// is reading three settings and calling `showInformationMessage`, which is why
// there is no test for this file and one for that one.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import {
  DEFAULT_NOTIFY,
  toastFor,
  type NotifyContext,
  type NotifySwitches
} from "../../core/notify.js";

/** Read fresh each time: a user who turns a banner off wants it off now, not
 *  after a window reload. */
export function notifySwitches(): NotifySwitches {
  const config = vscode.workspace.getConfiguration("luno.notify");
  return {
    approval: config.get<boolean>("approval", DEFAULT_NOTIFY.approval),
    question: config.get<boolean>("question", DEFAULT_NOTIFY.question),
    turnFinished: config.get<boolean>(
      "turnFinished",
      DEFAULT_NOTIFY.turnFinished
    )
  };
}

/**
 * Show the banner this context calls for, if any, and reveal the conversation
 * when the user takes it up.
 *
 * `reveal` is passed rather than reached for: the banner belongs to whichever
 * conversation raised it, and a hidden chat in a tab is not the sidebar.
 */
export function raiseNotification(
  ctx: Omit<NotifyContext, "switches">,
  reveal: () => void
): void {
  const message = toastFor({ ...ctx, switches: notifySwitches() });
  if (!message) return;
  void vscode.window.showInformationMessage(message, "Open").then((choice) => {
    if (choice === "Open") reveal();
  });
}
