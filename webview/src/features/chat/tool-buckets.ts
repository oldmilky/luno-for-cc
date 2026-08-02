// Semantic bucket categorization for tool calls. Drives grouping in the
// timeline so consecutive same-bucket calls collapse into one chip
// ("Read 3 files", "Searched 2 patterns") instead of N rows of noise.

import type { IconName } from "../../design/icons";

/** Lowercased, because `classifyTool` folds the name before matching. */
const IDE_TOOL_PREFIX = "mcp__luno_ide__";

export type ToolBucket =
  | "read"
  | "search"
  | "explore"
  | "edit"
  | "editor"
  | "run"
  | "web"
  | "task"
  | "skill"
  | "other";

export interface BucketMeta {
  /** Verb shown in the chip header. */
  verb: string;
  /** Singular noun for "1 X". */
  noun: string;
  /** Plural noun for "N Xs". */
  nounPlural: string;
  /** Icon shown next to the verb. */
  icon: IconName;
}

const META: Record<ToolBucket, BucketMeta> = {
  read: { verb: "Read", noun: "file", nounPlural: "files", icon: "file" },
  search: {
    verb: "Searched",
    noun: "pattern",
    nounPlural: "patterns",
    icon: "search"
  },
  explore: {
    verb: "Explored",
    noun: "folder",
    nounPlural: "folders",
    icon: "folder"
  },
  edit: { verb: "Edited", noun: "file", nounPlural: "files", icon: "edit" },
  editor: { verb: "Opened", noun: "file", nounPlural: "files", icon: "arrow" },
  run: {
    verb: "Ran",
    noun: "command",
    nounPlural: "commands",
    icon: "terminal"
  },
  web: { verb: "Fetched", noun: "page", nounPlural: "pages", icon: "cloud" },
  task: {
    verb: "Dispatched",
    noun: "agent",
    nounPlural: "agents",
    icon: "layers"
  },
  skill: { verb: "Used", noun: "skill", nounPlural: "skills", icon: "bolt" },
  other: { verb: "Ran", noun: "tool", nounPlural: "tools", icon: "code" }
};

export function bucketMeta(b: ToolBucket): BucketMeta {
  return META[b];
}

export function bucketSummary(b: ToolBucket, count: number): string {
  const m = META[b];
  return `${m.verb} ${count} ${count === 1 ? m.noun : m.nounPlural}`;
}

/** Map a tool name to its semantic bucket. Pure — no side effects. */
export function classifyTool(name: string, input?: string): ToolBucket {
  const n = name.toLowerCase();

  if (n === "skill" || n.startsWith("skill")) return "skill";
  // `Agent` is what the shipped CLI sends and `Workflow` launches one the same
  // way; `Task` is the older name that only stored sessions still carry.
  // Matching `task` alone made this bucket dead code — across the transcripts
  // on disk, `Agent` appears 219 times, `Workflow` 71, `Task` none — and both
  // live names fell through to "other", rendering as "Ran Agent".
  if (n === "task" || n === "agent" || n === "workflow") return "task";
  if (n === "webfetch" || n === "web_fetch") return "web";

  // The editor tools arrive as `mcp__luno_ide__<tool>` — the namespace is
  // `IDE_SERVER_NAME` in src/core/ide-tools.ts. `openFile` and `openDiff` move
  // the user's window, and the generic `open` rule below would file them under
  // "Read": a focus-stealing command rendered as a passive read, which is the
  // one thing 1.5 of the parity spec says must stay visible.
  if (n.startsWith(IDE_TOOL_PREFIX)) {
    const tool = n.slice(IDE_TOOL_PREFIX.length);
    return tool === "openfile" || tool === "opendiff" ? "editor" : "other";
  }

  if (/glob|ls$|^ls /.test(n)) return "explore";
  if (/grep|search/.test(n)) return "search";
  if (/read|view|open|cat$/.test(n)) return "read";
  if (/write|edit|create|multiedit/.test(n)) return "edit";

  // Bash needs sniffing the command to decide if it's exploration / search
  // / read / general.
  if (/bash|run|shell|exec/.test(n)) {
    const cmd = extractBashCommand(input).trim().toLowerCase();
    if (!cmd) return "run";
    const head = cmd.split(/\s+/)[0];
    if (head === "find" || head === "ls" || head === "tree") return "explore";
    if (head === "grep" || head === "rg" || head === "ack" || head === "ag")
      return "search";
    if (
      head === "cat" ||
      head === "head" ||
      head === "tail" ||
      head === "less" ||
      head === "more"
    )
      return "read";
    return "run";
  }

  return "other";
}

function extractBashCommand(input?: string): string {
  if (!input) return "";
  try {
    const obj = JSON.parse(input) as Record<string, unknown>;
    return String(obj.command ?? "");
  } catch {
    return "";
  }
}

/** Format a token count for a chip: "940" / "19.2k" / "128k" / "1.4M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format a turn duration: "2s" / "47s" / "1m 12s" / "4m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (r === 0) return `${m}m`;
  return `${m}m ${r}s`;
}
