// ─────────────────────────────────────────────────────────────
// Per-tool stall watchdog.
//
// A latency-bounded tool that never produces its result would otherwise hold
// the turn open until the 10-minute silence SIGKILL — with a spinner running
// and nothing said. This arms a timer when one starts and clears it when the
// result lands.
//
// Pure: it takes deltas and a clock, owns no process, and is driven entirely
// by what the caller feeds it.
// ─────────────────────────────────────────────────────────────

import type { StreamDelta } from "../../core/types.js";

/** Latency-bounded tools that should return a result in seconds, not minutes.
 *  If the CLI wedges inside one of these and never emits a `tool_result`
 *  (e.g. WebFetch hanging on a slow/streaming endpoint), the per-tool stall
 *  watchdog ends the turn cleanly rather than letting the UI spinner run until
 *  the SILENCE_TIMEOUT_MS SIGKILL. Bash and other potentially
 *  long-running tools are deliberately NOT watched here. */
const STALL_WATCHDOG_TOOLS: ReadonlySet<string> = new Set([
  "WebFetch",
  "WebSearch"
]);

/** Default budget for a watched tool to produce its result before it's treated
 *  as stalled. Generous enough for a slow-but-real fetch; far short of the
 *  10-minute hard kill. Override per-session via ClaudeCliOpts.toolStallMs. */
export const WEB_TOOL_STALL_MS = 60 * 1000;

export interface ToolStallWatchdog {
  /** Feed every outbound delta through this; arms a timer when a watched tool
   *  starts executing and clears it when the tool's result lands. */
  observe(delta: StreamDelta): void;
  /** Cancel all pending timers (call when the turn ends for any reason). */
  clearAll(): void;
}

/**
 * Watches latency-bounded tools (WebFetch/WebSearch) for a missing result.
 *
 * The CLI emits `tool_use_start` → `tool_use_end` when it dispatches a tool,
 * then a `tool_result` when it returns. If the tool wedges (no result), no
 * further deltas flow and the only backstop is the 10-minute process kill —
 * leaving the UI spinning the whole time. This arms a per-tool timer on
 * `tool_use_end` and fires `onStall` if the matching `tool_result` hasn't
 * arrived in `timeoutMs`. The pure logic lives here so it's unit-testable
 * without spawning the CLI.
 */
export function createToolStallWatchdog(opts: {
  timeoutMs: number;
  onStall: (toolId: string, toolName: string, timeoutMs: number) => void;
  tools?: ReadonlySet<string>;
}): ToolStallWatchdog {
  const watched = opts.tools ?? STALL_WATCHDOG_TOOLS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const names = new Map<string, string>();
  // tool_use_end carries no id, so correlate it with the most recent start —
  // the CLI streams tool-use content blocks sequentially (start → … → stop).
  let lastStartedId: string | null = null;

  const clear = (id: string) => {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  };

  return {
    observe(d) {
      if (d.type === "tool_use_start" && d.tool) {
        lastStartedId = d.tool.id;
        names.set(d.tool.id, d.tool.name);
      } else if (d.type === "tool_use_end" && lastStartedId) {
        const id = lastStartedId;
        const name = names.get(id) ?? "";
        if (watched.has(name)) {
          clear(id);
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id);
              opts.onStall(id, name, opts.timeoutMs);
            }, opts.timeoutMs)
          );
        }
      } else if (d.type === "tool_result" && d.toolUseId) {
        clear(d.toolUseId);
      }
    },
    clearAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    }
  };
}
