// ─────────────────────────────────────────────────────────────
// Which tool call means "snapshot this file before it changes".
//
// Small, and load-bearing: this decision is the difference between rewind
// restoring a file and rewind silently losing it. Get the tool name wrong and
// nothing errors — the file just is not in the checkpoint, and the user finds
// out when they try to undo.
//
// Pure on purpose. It was a private method on a class no test imports, which
// meant the tool-name list and the path extraction had never been exercised.
// ─────────────────────────────────────────────────────────────

/**
 * Tools that write to a path. Matched against a lowercased name, prefix-wise,
 * because the CLI has shipped several spellings over time and namespaced
 * variants (`mcp__x__write_file`) are not the concern here — those are matched
 * by the caller's own gate, not this one.
 *
 * `str_replace_editor` is Anthropic's older computer-use editor; `multiedit`
 * and `update` are legacy Claude Code names. Kept because a session restored
 * from an older history file still replays them.
 */
const WRITE_TOOL_PREFIX =
  /^(write|edit|multiedit|notebookedit|update|create|str_replace_editor)/;

/** The keys a write tool might use for its target path, in precedence order. */
const PATH_KEYS = ["path", "file_path", "filePath"] as const;

export interface ToolCallEvent {
  kind: string;
  /** JSON-encoded tool input. */
  body?: string;
  meta?: Record<string, unknown>;
}

/**
 * The path a write/edit tool is about to touch, or null when the event is not
 * one.
 *
 * Returns null rather than throwing on malformed input: the body is JSON from
 * a subprocess, and a parse failure must not take down the event listener that
 * the whole timeline flows through.
 */
export function fileTouchedByTool(e: ToolCallEvent): string | null {
  if (e.kind !== "tool_call") return null;

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(e.body ?? "{}");
  } catch {
    return null;
  }
  if (!input || typeof input !== "object") return null;

  const name = String(e.meta?.name ?? "").toLowerCase();
  if (!WRITE_TOOL_PREFIX.test(name)) return null;

  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

// ── Shell writes ─────────────────────────────────────────────
//
// A net, not a shell parser. The CLI's own system prompt tells the model to
// make file changes "with sed, heredocs, or short scripts, rather than using
// the dedicated Read, Edit, or Write tools" — and a file written that way is
// named by no tool, so it lands in no checkpoint and Rewind cannot put it
// back. `prompts/common.md` countermands that instruction; this is what holds
// when the model does it anyway.
//
// Deliberately narrow. Only shapes whose target is unambiguous are read —
// a redirect, `sed -i`, `tee`. `perl -i`, `node -e` and anything that computes
// its own path are not modelled and never will be here: a *wrong* path is
// worse than a missing one, because `addFileToLatest` records an unknown path
// as "did not exist before" and a later revert would delete whatever is there.

/** Where the write lands, and where it does not. `/dev/null` is a sink, and a
 *  file descriptor is not a file. */
const NOT_A_FILE = /^(\/dev\/(null|stdout|stderr|tty)|nul|con|-)$/i;
/** A redirect operator on its own — `>`, `>>`, `2>` — or with the target
 *  attached, as in `>out.txt`. Matched against a *token*, never against raw
 *  text: a `>` inside quotes belongs to the string, and scanning the line
 *  itself read one out of `grep -n 'a > b'` and called it a file. */
const REDIRECT_TOKEN = /^\d?>>?(.*)$/;

const SEGMENTS = /\|\||&&|[;|&\n]/;

/** Strip one layer of quoting from a token the shell would have removed. */
function unquote(token: string): string {
  const first = token[0];
  if ((first === '"' || first === "'") && token.endsWith(first)) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Join a target onto the directory a `cd` in the same command line moved to.
 *
 * `cd src/features && cat >> grid.tsx` writes `src/features/grid.tsx`, and
 * reporting the bare `grid.tsx` would name a file at the workspace root that
 * probably does not exist — which a revert would then try to delete. Absolute
 * targets are already complete and are left alone.
 */
function resolveAgainst(dir: string | null, target: string): string {
  const isAbsolute = target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
  if (!dir || isAbsolute) return target;
  return `${dir.replace(/[\\/]+$/, "")}/${target}`;
}

/** Every file a shell command line writes, as far as it can be read with
 *  certainty. Empty when nothing about it is certain. */
export function filesWrittenByShell(command: string): string[] {
  const out: string[] = [];
  let cwd: string | null = null;

  for (const raw of command.split(SEGMENTS)) {
    const segment = raw.trim();
    if (!segment) continue;

    const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const head = unquote(tokens[0] ?? "").replace(/^.*[\\/]/, "");

    // `cd` moves the ground every later relative target stands on.
    if (head === "cd" && tokens[1]) {
      cwd = unquote(tokens[1]);
      continue;
    }

    const push = (target: string) => {
      const file = unquote(target);
      if (!file || NOT_A_FILE.test(file)) return;
      const resolved = resolveAgainst(cwd, file);
      if (!out.includes(resolved)) out.push(resolved);
    };

    // `sed -i 's/a/b/' file` — in place, so every non-flag operand after the
    // script is a file it rewrites. GNU's `-i.bak` counts too.
    if (head === "sed" && tokens.some((t) => /^-i/.test(unquote(t)))) {
      const operands = tokens
        .slice(1)
        .map(unquote)
        .filter((t) => !t.startsWith("-"));
      // The first operand is the script; the rest are files.
      for (const file of operands.slice(1)) push(file);
    }

    // `tee file`, `tee -a file`.
    if (head === "tee") {
      for (const t of tokens.slice(1).map(unquote)) {
        if (!t.startsWith("-")) push(t);
      }
    }

    // Walked as tokens so a quoted argument cannot contribute an operator,
    // and so `> "my file.txt"` keeps its space.
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith('"') || token.startsWith("'")) continue;
      const m = REDIRECT_TOKEN.exec(token);
      if (!m) continue;
      // `2>&1` duplicates a descriptor and opens nothing.
      if (m[1].startsWith("&")) continue;
      push(m[1] || tokens[++i] || "");
    }
  }

  return out;
}

/**
 * Every file this tool call is about to write — the edit tools' own path, plus
 * whatever a shell command can be read to write.
 *
 * Plural because one command line writes as many files as it likes, where an
 * edit tool names exactly one.
 */
export function filesTouchedByTool(e: ToolCallEvent): string[] {
  const single = fileTouchedByTool(e);
  if (single) return [single];
  if (e.kind !== "tool_call") return [];
  if (!/^(bash|shell|terminal|run)/.test(String(e.meta?.name ?? "").toLowerCase())) {
    return [];
  }
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(e.body ?? "{}");
  } catch {
    return [];
  }
  const command = input?.command;
  return typeof command === "string" ? filesWrittenByShell(command) : [];
}
