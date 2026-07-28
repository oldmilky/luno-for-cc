// ─────────────────────────────────────────────────────────────
// Turning what a terminal wrote into something worth putting in a prompt.
//
// `TerminalShellExecution.read()` hands back the raw stream — colours, cursor
// moves and the shell-integration markers VS Code injects. Sent as-is that is
// mostly escape codes by weight, so it is cleaned and bounded here, away from
// the editor API that produced it.
// ─────────────────────────────────────────────────────────────

/* eslint-disable no-control-regex --
   The subject of this module is control codes; a stripper cannot avoid naming
   them. A block rather than two line directives because prettier wraps the
   first regex, which moves it off the line a `disable-next-line` covers. */

/**
 * Escape sequences in the three shapes a shell stream actually contains: OSC
 * (window titles and the shell-integration markers, closed by BEL or ST), CSI
 * (colour and cursor movement), and the bare two-character escapes.
 *
 * Written with `\x1b` rather than the literal character on purpose — an
 * unescaped ESC is invisible in an editor, and a regex nobody can read is a
 * regex nobody can fix.
 */
const ANSI =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** What a TUI leaves behind once its escapes are gone. Tab, newline and
 *  carriage return are deliberately not in the class: they carry the layout. */
const LEFTOVER_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/* eslint-enable no-control-regex */

/** Kept from the tail of a run. A failing build says why in its last lines;
 *  its first thousand are the part nobody reads. */
export const MAX_OUTPUT_CHARS = 8_000;

/** Strip the escape codes and normalise line endings. Nothing else — the
 *  content is the user's, and a "helpful" rewrite of it would be a lie about
 *  what their terminal said. */
export function cleanTerminalOutput(raw: string): string {
  return raw
    .replace(ANSI, "")
    .replace(LEFTOVER_CONTROL, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/** The last `limit` characters, cut at a line boundary and marked as cut.
 *  An unannounced truncation reads as the whole output. */
export function tailOf(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const tail = text.slice(text.length - limit);
  const firstBreak = tail.indexOf("\n");
  const whole = firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
  return `[earlier output trimmed]\n${whole}`;
}

export interface TerminalRun {
  terminalName: string;
  commandLine: string;
  /** `undefined` when the shell reported none — a cancelled command, a
   *  sub-shell, or an integration script that did not say. */
  exitCode: number | undefined;
  output: string;
}

/** A run as it goes into a prompt: what ran, how it ended, what it said. */
export function formatRun(run: TerminalRun): string {
  const status =
    run.exitCode === undefined ? "exit code unknown" : `exit ${run.exitCode}`;
  const body = run.output.trim() || "(no output)";
  return [
    `Terminal \`${run.terminalName}\` — \`${run.commandLine}\` (${status}):`,
    "```",
    body,
    "```"
  ].join("\n");
}

/**
 * Replace every `@terminal:<name>` token with that terminal's last run.
 *
 * Unknown names are left alone rather than blanked: the token is what the
 * user typed, and silently deleting it would leave a prompt that reads as if
 * they had never asked for the output at all.
 */
export function expandTerminalMentions(
  text: string,
  lookup: (name: string) => TerminalRun | undefined
): string {
  return text.replace(/@terminal:([^\s`]+)/g, (token, rawName: string) => {
    const name = rawName.replace(/[.,;:!?)]+$/, "");
    const run = lookup(name);
    return run ? formatRun(run) : token;
  });
}
