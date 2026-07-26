// ─────────────────────────────────────────────────────────────
// claude-code-usage — aggregate authoritative token usage from
// Claude Code's per-project session JSONL files at
// `~/.claude/projects/<encoded-cwd>/*.jsonl`.
//
// Each assistant message line in those files contains a `usage` block
// with `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
// `cache_creation_input_tokens`, plus the `model` that produced it.
//
// We aggregate into the same windows Claude's Usage settings page uses:
//
//   • Current session (5-hour rolling window) — Anthropic's subscription
//     quota windows are 5 hours from the first message of the burst. We
//     find the earliest assistant message within the last 5 hours and
//     compute usage from there, plus the reset time = first_msg + 5h.
//
//   • This week — cumulative since the most recent Monday at local
//     midnight, broken down by:
//       - All models   — every assistant message
//       - Sonnet only  — messages where model starts with "claude-sonnet"
//     (Anthropic's published weekly caps split out Sonnet usage; matching
//     that lets the chip surface whichever cap will hit first.)
//
//   • Today — cumulative since local midnight (Luno's own window;
//     handy for users who want a daily rhythm independent of Anthropic's
//     billing windows).
//
// Browser/claude.ai usage isn't reachable from disk so the totals don't
// include it. The UI is honest about this.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreatedTokens: number;
  /** Number of assistant messages contributing to the total. */
  messages: number;
}

export interface SessionWindow {
  /** Tokens used inside the current 5-hour window. */
  usage: UsageTotals;
  /** Wall-clock start of the window (first message inside it). 0 if no recent activity. */
  startedAt: number;
  /** When the window will reset (startedAt + 5h). 0 if no recent activity. */
  resetsAt: number;
}

export interface AggregatedUsage {
  /** Anthropic's 5-hour rolling window — matches Claude's "Current session". */
  session: SessionWindow;
  /** Local-day bucket (midnight to midnight) — Luno's own window. */
  today: UsageTotals;
  /** Local-week bucket from Monday midnight. */
  week: UsageTotals;
  /** Same week bucket, restricted to Sonnet-class models. */
  weekSonnet: UsageTotals;
  /** Cumulative since file storage began for this workspace. */
  total: UsageTotals;
  /** When this aggregation was produced (ms epoch). */
  generatedAt: number;
  /** True if the project directory was found and at least one file was scanned. */
  available: boolean;
  /** Workspace-encoded directory under ~/.claude/projects. */
  projectDir: string | null;
}

interface AssistantLine {
  type: "assistant";
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/**
 * Convert a workspace absolute path to Claude Code's directory naming.
 * Claude Code encodes each project's cwd by replacing path separators with `-`:
 *   `/Users/me/Projects/my-app`
 *     → `-Users-me-Projects-my-app`
 *
 * Windows paths convert backslashes to `-` and drop the `:` after the drive
 * letter to match the same scheme.
 */
export function encodeWorkspaceDir(absPath: string): string {
  return absPath
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_m, d) => `/${d}`)
    .replace(/\//g, "-");
}

export interface AggregateOptions {
  /**
   * "workspace" — scan only `~/.claude/projects/<encoded current cwd>/`.
   * "all"       — scan every project directory under `~/.claude/projects/`.
   *               Matches what Claude's Usage UI shows (account-wide
   *               aggregation, not per-project). Default.
   */
  scope?: "workspace" | "all";
  /**
   * Override the root scanned for `<encoded-cwd>/*.jsonl` project dirs.
   * Defaults to `~/.claude/projects`. Exposed so the windowing/aggregation
   * logic can be exercised against a fixture directory in tests.
   */
  projectsRoot?: string;
}

/**
 * Aggregate token usage from Claude Code's session files. By default scans
 * all projects on this machine (matching what claude.ai's Usage page sums)
 * — pass `scope: "workspace"` to limit to the current project.
 *
 * Day boundaries are computed in local time. Week boundary is the most
 * recent Monday at local midnight (ISO week). Session boundary is a
 * 5-hour rolling window from the first message of the most recent burst.
 */
export async function aggregateClaudeCodeUsage(
  workspaceRoot: string,
  now: Date = new Date(),
  opts: AggregateOptions = {}
): Promise<AggregatedUsage> {
  const scope = opts.scope ?? "all";
  const projectsRoot =
    opts.projectsRoot ?? path.join(os.homedir(), ".claude", "projects");
  const empty = (): UsageTotals => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreatedTokens: 0,
    messages: 0
  });

  const out: AggregatedUsage = {
    session: { usage: empty(), startedAt: 0, resetsAt: 0 },
    today: empty(),
    week: empty(),
    weekSonnet: empty(),
    total: empty(),
    generatedAt: now.getTime(),
    available: false,
    projectDir: null
  };

  // Build the list of project dirs to scan.
  const dirsToScan: string[] = [];
  if (scope === "workspace") {
    const wsDir = path.join(projectsRoot, encodeWorkspaceDir(workspaceRoot));
    try {
      await fsp.stat(wsDir);
      dirsToScan.push(wsDir);
    } catch {
      return out;
    }
    out.projectDir = wsDir;
  } else {
    try {
      const projects = await fsp.readdir(projectsRoot, { withFileTypes: true });
      for (const p of projects) {
        if (p.isDirectory()) dirsToScan.push(path.join(projectsRoot, p.name));
      }
    } catch {
      return out;
    }
    if (dirsToScan.length === 0) return out;
    out.projectDir = projectsRoot;
  }
  out.available = true;

  const nowMs = now.getTime();
  const dayCutoff = startOfLocalDay(now).getTime();
  const weekCutoff = startOfLocalWeek(now).getTime();
  // Initial session lower bound; we refine it once we find the actual
  // earliest message of the most recent burst.
  const sessionLowerBound = nowMs - FIVE_HOURS_MS;

  // Gather every .jsonl file across the chosen scope, sorted newest-first
  // so the (rare) parser failure on an older file doesn't hide recent
  // activity. mtime is good enough — JSONL files are append-only.
  const stats: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of dirsToScan) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        stats.push({ file: full, mtimeMs: st.mtimeMs });
      } catch {
        // ignore unreadable file
      }
    }
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // First pass: aggregate today / week / total / week-sonnet and collect
  // every assistant entry inside the 5-hour window for the session
  // calculation.
  const sessionEntries: Array<{ ts: number; line: AssistantLine }> = [];

  // Performance: once a file's mtime is older than our oldest cutoff
  // (weekCutoff), we know none of its lines can affect any rolling window.
  // We still scan it for the `total` bucket but only if we care. For UI
  // purposes the rolling windows are what matters, so skip ancient files.
  for (const s of stats) {
    if (s.mtimeMs < weekCutoff - 7 * 24 * 60 * 60 * 1000) {
      // > 2 weeks old — skip; doesn't affect any displayed bucket.
      continue;
    }
    await scanFile(s.file, dayCutoff, weekCutoff, sessionLowerBound, out, sessionEntries);
  }

  // Refine the session window: find the earliest message in the last 5h.
  // The "session" Anthropic actually charges is 5 hours from the *first*
  // message; subsequent messages don't extend the deadline. We approximate
  // that by treating the oldest entry inside [now-5h, now] as the start.
  if (sessionEntries.length > 0) {
    sessionEntries.sort((a, b) => a.ts - b.ts);
    const start = sessionEntries[0].ts;
    out.session.startedAt = start;
    out.session.resetsAt = start + FIVE_HOURS_MS;
    for (const e of sessionEntries) {
      if (e.ts < start) continue;
      addUsage(out.session.usage, e.line.message?.usage);
    }
  }

  return out;
}

async function scanFile(
  filePath: string,
  dayCutoff: number,
  weekCutoff: number,
  sessionLowerBound: number,
  out: AggregatedUsage,
  sessionEntries: Array<{ ts: number; line: AssistantLine }>
): Promise<void> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: "utf8" });
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || !line.includes('"usage"')) continue;
      let parsed: AssistantLine;
      try {
        parsed = JSON.parse(line) as AssistantLine;
      } catch {
        continue;
      }
      if (parsed.type !== "assistant" || !parsed.message?.usage) continue;
      const u = parsed.message.usage;
      const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;

      addUsage(out.total, u);
      if (Number.isFinite(ts)) {
        if (ts >= dayCutoff) addUsage(out.today, u);
        if (ts >= weekCutoff) {
          addUsage(out.week, u);
          if (isSonnet(parsed.message.model)) addUsage(out.weekSonnet, u);
        }
        if (ts >= sessionLowerBound) sessionEntries.push({ ts, line: parsed });
      }
    }
  } catch {
    // ignore mid-stream errors — partial totals are still useful
  } finally {
    rl.close();
    stream.close();
  }
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function addUsage(bucket: UsageTotals, u: UsageBlock | undefined): void {
  if (!u) return;
  bucket.inputTokens += u.input_tokens ?? 0;
  bucket.outputTokens += u.output_tokens ?? 0;
  bucket.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  bucket.cacheCreatedTokens += u.cache_creation_input_tokens ?? 0;
  bucket.messages += 1;
}

function isSonnet(model?: string): boolean {
  if (!model) return false;
  // Match "claude-sonnet-4-5-…", "claude-3-5-sonnet-…", etc.
  return /sonnet/i.test(model);
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfLocalWeek(d: Date): Date {
  const x = startOfLocalDay(d);
  const dow = x.getDay(); // Sunday=0, Monday=1
  const offset = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + offset);
  return x;
}
