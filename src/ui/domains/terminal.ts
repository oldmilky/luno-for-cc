// ─────────────────────────────────────────────────────────────
// The one integrated terminal LUNO drives, by name.
//
// Two unrelated features reach for it: `runTerminalCommand` from the chat, and
// the connector hand-off that opens Claude Code's `/mcp` menu. Both used to
// create and dispose a terminal called "Luno Setup" independently, each with
// its own copy of the name and its own copy of the reason for disposing first.
// Splitting the panel put them in different files, which made a shared mutable
// resource look like two private ones.
//
// It is one terminal. This module owns it.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";

const TERMINAL_NAME = "Luno Setup";

/**
 * Dispose the existing terminal before creating a new one.
 *
 * Re-using a terminal that still hosts an interactive process — `claude`, a
 * REPL — makes `sendText` type into *that process's stdin* instead of running a
 * shell command. Disposing first guarantees a fresh prompt.
 */
export function openSetupTerminal(): vscode.Terminal {
  vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)?.dispose();
  const term = vscode.window.createTerminal({ name: TERMINAL_NAME });
  term.show(true);
  return term;
}

/**
 * Run a command in a fresh setup terminal.
 *
 * The send is deferred so the shell has printed its prompt first. Without the
 * delay, a slow-initialising shell (zsh with a heavy rc) interleaves the
 * keystrokes with its own startup output and the command arrives mangled.
 */
export function runInSetupTerminal(command: string, delayMs = 250): void {
  const term = openSetupTerminal();
  setTimeout(() => term.sendText(command, true), delayMs);
}
