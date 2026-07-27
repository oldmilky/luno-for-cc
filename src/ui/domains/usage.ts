// ─────────────────────────────────────────────────────────────
// Claude Code usage — the token/limit figures behind the header chip.
//
// The whole domain is one read and one post. It touched no panel state at all,
// which is why it moved first: if the extraction pattern is wrong, it is
// cheapest to find out here.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import { aggregateClaudeCodeUsage } from "../../services/claude-code-usage.js";
import type { RateLimitTracker } from "../../services/rate-limit.js";
import type { Post } from "../messages.js";

/**
 * Read the CLI's own usage records for this workspace and publish them.
 *
 * Best-effort by design: with no workspace open there is nothing to aggregate,
 * and a failed read leaves the chip on its local estimate rather than showing
 * an error for a number nobody asked for.
 *
 * `rateLimits` supplies the 5-hour window boundary the CLI reported. Without
 * it the aggregation infers one, and the inference is wrong by hours whenever
 * a window boundary sits inside the range it scans.
 */
export async function broadcastUsage(
  post: Post,
  rateLimits?: RateLimitTracker
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  try {
    const agg = await aggregateClaudeCodeUsage(root, new Date(), {
      sessionWindowStart: rateLimits?.sessionWindowStart()
    });
    post({
      type: "claudeCodeUsage",
      session: agg.session,
      today: agg.today,
      week: agg.week,
      weekSonnet: agg.weekSonnet,
      total: agg.total,
      generatedAt: agg.generatedAt,
      available: agg.available,
      limits: rateLimits?.live() ?? []
    });
  } catch {
    // best-effort; the chip falls back to its estimate
  }
}
