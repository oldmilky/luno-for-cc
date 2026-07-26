// Semantic bucket categorization for tool calls. Drives grouping in the
// timeline so consecutive same-bucket calls collapse into one chip
// ("Read 3 files", "Searched 2 patterns") instead of N rows of noise.

import type { IconName } from "../../design/icons";

export type ToolBucket =
  | "read"
  | "search"
  | "explore"
  | "edit"
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
  read:    { verb: "Read",     noun: "file",    nounPlural: "files",     icon: "file" },
  search:  { verb: "Searched", noun: "pattern", nounPlural: "patterns",  icon: "search" },
  explore: { verb: "Explored", noun: "folder",  nounPlural: "folders",   icon: "folder" },
  edit:    { verb: "Edited",   noun: "file",    nounPlural: "files",     icon: "edit" },
  run:     { verb: "Ran",      noun: "command", nounPlural: "commands",  icon: "terminal" },
  web:     { verb: "Fetched",  noun: "page",    nounPlural: "pages",     icon: "cloud" },
  task:    { verb: "Dispatched", noun: "agent", nounPlural: "agents",    icon: "layers" },
  skill:   { verb: "Used",     noun: "skill",   nounPlural: "skills",    icon: "bolt" },
  other:   { verb: "Ran",      noun: "tool",    nounPlural: "tools",     icon: "code" }
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
  if (n === "task") return "task";
  if (n === "webfetch" || n === "web_fetch") return "web";

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
    if (head === "grep" || head === "rg" || head === "ack" || head === "ag") return "search";
    if (head === "cat" || head === "head" || head === "tail" || head === "less" || head === "more") return "read";
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
