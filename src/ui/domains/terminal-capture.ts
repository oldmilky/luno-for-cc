// ─────────────────────────────────────────────────────────────
// What each terminal last ran, kept so `@terminal:` has something to offer.
//
// This is a recorder, not a reader. `TerminalShellExecution.read()` only
// yields data written *after* the first call, and there is no API for a
// terminal's scrollback at all — so the only way to have a command's output
// when the user asks for it is to have been listening when it ran. Hence a
// subscription taken out at activation rather than a lookup at mention time.
//
// Two consequences worth saying out loud, because they look like bugs:
// commands run before Luno activated are not there, and a terminal without
// shell integration (cmd.exe, a shell whose script did not load) never fires
// these events at all.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import {
  cleanTerminalOutput,
  tailOf,
  type TerminalRun
} from "../../core/terminal-output.js";
import { log as logInfo } from "../../services/logger.js";

interface Recorded extends TerminalRun {
  /** Monotonic, so "most recent" survives two runs inside one millisecond. */
  seq: number;
}

const runs = new Map<vscode.Terminal, Recorded>();
let counter = 0;

function captureEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("luno")
    .get<boolean>("terminalCapture", true);
}

/**
 * Start recording. Returns a disposable so activation registers it like
 * everything else.
 */
export function registerTerminalCapture(): vscode.Disposable {
  const pending = new Map<vscode.TerminalShellExecution, string[]>();

  const started = vscode.window.onDidStartTerminalShellExecution((e) => {
    if (!captureEnabled()) return;
    const chunks: string[] = [];
    pending.set(e.execution, chunks);
    // Read immediately and let it run: the stream only carries what arrives
    // after this call, so anything awaited first is output already lost.
    void drain(e.execution, chunks);
  });

  const ended = vscode.window.onDidEndTerminalShellExecution((e) => {
    const chunks = pending.get(e.execution);
    pending.delete(e.execution);
    if (!chunks) return;
    runs.set(e.terminal, {
      terminalName: e.terminal.name,
      commandLine: e.execution.commandLine.value,
      exitCode: e.exitCode,
      output: tailOf(cleanTerminalOutput(chunks.join(""))),
      seq: ++counter
    });
  });

  // A closed terminal's output stops being addressable: `@terminal:bash`
  // would otherwise resolve to a window the user shut an hour ago.
  const closed = vscode.window.onDidCloseTerminal((t) => {
    runs.delete(t);
  });

  return {
    dispose: () => {
      started.dispose();
      ended.dispose();
      closed.dispose();
      pending.clear();
      runs.clear();
    }
  };
}

/** Every terminal that has a run to offer, most recent first. */
export function capturedRuns(): TerminalRun[] {
  return [...runs.values()]
    .sort((a, b) => b.seq - a.seq)
    .map(({ seq: _seq, ...run }) => run);
}

/** The named terminal's last run. Names are not unique — VS Code will happily
 *  open three called `bash` — so the most recent one wins, which is the one
 *  the user was just looking at. */
export function capturedRun(name: string): TerminalRun | undefined {
  return capturedRuns().find((r) => r.terminalName === name);
}

async function drain(
  execution: vscode.TerminalShellExecution,
  chunks: string[]
): Promise<void> {
  try {
    for await (const data of execution.read()) {
      chunks.push(data);
      // Trim as it arrives. A `tail -f` left running would otherwise grow
      // this array for as long as the window is open, and only the end of it
      // was ever going to be sent.
      if (chunks.length > 256) {
        const joined = chunks.join("");
        chunks.length = 0;
        chunks.push(tailOf(joined));
      }
    }
  } catch (err) {
    // A terminal dying mid-command ends the stream abruptly. Whatever was
    // collected stays usable; the run just stops growing.
    logInfo("[luno] terminal capture ended early:", String(err));
  }
}
