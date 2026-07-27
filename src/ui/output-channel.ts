// ─────────────────────────────────────────────────────────────
// The editor-facing half of logging: an output channel `LUNO: Show Logs`
// opens, wired to the sink in `services/logger.ts`.
//
// Separate from that module because it is the only half that needs vscode, and
// the logger is called from the provider and core layers, which are tested
// without an editor.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import { setLogSink } from "../services/logger.js";

let channel: vscode.OutputChannel | undefined;

/** Create the channel and start collecting into it. Returns a disposable so
 *  activation can register it the same way as everything else. */
export function registerOutputChannel(): vscode.Disposable {
  channel ??= vscode.window.createOutputChannel("LUNO for CC");
  const target = channel;
  setLogSink((line) => target.appendLine(line));
  return {
    dispose: () => {
      setLogSink(undefined);
      channel?.dispose();
      channel = undefined;
    }
  };
}

/** Reveal the log. `true` keeps focus where the user left it — they asked to
 *  read the log, not to leave the chat. */
export function showLogs(): void {
  channel?.show(true);
}
