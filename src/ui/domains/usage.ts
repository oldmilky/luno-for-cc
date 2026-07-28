// ─────────────────────────────────────────────────────────────
// Claude Code usage — the token/limit figures behind the header chip.
//
// The whole domain is one read and one post. It touched no panel state at all,
// which is why it moved first: if the extraction pattern is wrong, it is
// cheapest to find out here.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import { aggregateClaudeCodeUsage } from "../../services/claude-code-usage.js";
import {
  parseUtilization,
  readUsageUtilization
} from "../../services/usage-utilization.js";
import { createOAuthUsageReader } from "../../services/oauth-usage.js";
import type { RateLimitTracker } from "../../services/rate-limit.js";
import type { Post } from "../messages.js";

/** One reader for the whole extension: the quota is per account, and its cache
 *  is what keeps a per-conversation poll from becoming per-conversation
 *  traffic. */
const accountUsage = createOAuthUsageReader();

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
 *
 * `force` comes from the Refresh button and reaches only the account endpoint;
 * everything else here is a local read that was never throttled.
 */
export async function broadcastUsage(
  post: Post,
  rateLimits?: RateLimitTracker,
  options: { force?: boolean } = {}
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  try {
    // Read on every broadcast rather than caching: the CLI rewrites the file
    // when it refreshes the account's figures, and a meter holding the copy it
    // read at startup is exactly the stale-number problem this replaced.
    const [agg, cached, live] = await Promise.all([
      aggregateClaudeCodeUsage(root, new Date(), {
        sessionWindowStart: rateLimits?.sessionWindowStart()
      }),
      readUsageUtilization(),
      accountUsage.read(options.force)
    ]);

    // The live answer outranks the cached one — it is the same payload, hours
    // fresher. The tier only ever comes from the config file, so it is carried
    // across rather than lost with it.
    const utilization =
      (live && parseUtilization(live.payload, live.fetchedAt, cached?.tier)) ||
      cached;
    post({
      type: "claudeCodeUsage",
      session: agg.session,
      today: agg.today,
      week: agg.week,
      weekSonnet: agg.weekSonnet,
      total: agg.total,
      generatedAt: agg.generatedAt,
      available: agg.available,
      limits: rateLimits?.live() ?? [],
      utilization: utilization ?? undefined
    });
  } catch {
    // best-effort; the chip falls back to its estimate
  }
}
