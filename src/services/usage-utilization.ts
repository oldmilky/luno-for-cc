// ─────────────────────────────────────────────────────────────
// The account's real quota figures, as Anthropic reports them.
//
// Claude Code asks the server for the account's utilization and caches the
// answer in `~/.claude.json` under `cachedUsageUtilization`. That answer is the
// only honest source of a percentage: the CLI's `rate_limit_event` carries the
// window boundary and nothing else, and the meter's own estimate has to guess
// both halves of the fraction — which tokens count, and what the cap is. Both
// guesses were wrong at once on a live Max 20× account: it read "over" and 42%
// where the server said 11% and 29%.
//
// We only ever read this file. It is Claude Code's, the CLI refreshes it on its
// own schedule, and the age of the answer is part of the answer — hence
// `fetchedAt`, which the panel shows.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/** Plans the picker knows, keyed the way the meter's presets are. */
export type PlanTier = "pro" | "max5" | "max20" | "team" | "api";

/**
 * One quota the account is subject to.
 *
 * `kind` is the server's own name (`session`, `weekly_all`, `weekly_scoped`, …)
 * and is deliberately not narrowed: buckets appear and disappear between
 * releases, and an unknown one must render rather than break the panel.
 */
export interface UtilizationLimit {
  kind: string;
  /** `session` or `weekly` — what the row is grouped under. */
  group: string;
  /** 0-100, straight from the server. */
  percent: number;
  /** `normal`, `warning`, `critical` — the server's own judgement, which is
   *  what colours the row. Ours would be a second opinion on someone else's
   *  data. */
  severity: string;
  /** ms epoch, or 0 when the server did not say. */
  resetsAt: number;
  /** For a model-scoped weekly limit: the model it applies to. */
  scopeLabel?: string;
  /** Whether the server considers this the binding limit right now. */
  isActive: boolean;
}

export interface UsageUtilization {
  /** When the CLI last got this from the server (ms epoch). */
  fetchedAt: number;
  limits: UtilizationLimit[];
  /** The account's plan, read off its rate-limit tier. Null when the string is
   *  one we do not recognise — better an unset picker than a wrong plan. */
  plan: PlanTier | null;
  /** The raw tier, for the tooltip. Unrecognised values are worth seeing. */
  tier?: string;
}

interface RawLimit {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  severity?: unknown;
  resets_at?: unknown;
  is_active?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

/**
 * Map Anthropic's rate-limit tier onto the plan the picker offers.
 *
 * Matched on substrings rather than a table of exact ids: the observed value is
 * `default_claude_max_20x`, and the prefix has already changed once. A tier we
 * cannot place returns null — the user's own choice then stands, which is the
 * behaviour they had before this existed.
 */
export function planFromTier(tier: string | undefined): PlanTier | null {
  if (!tier) return null;
  const t = tier.toLowerCase();
  if (t.includes("max") && t.includes("20")) return "max20";
  if (t.includes("max") && t.includes("5")) return "max5";
  if (t.includes("team") || t.includes("enterprise")) return "team";
  if (t.includes("pro")) return "pro";
  return null;
}

function toMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function readLimits(raw: unknown): UtilizationLimit[] {
  if (!Array.isArray(raw)) return [];
  const out: UtilizationLimit[] = [];
  for (const entry of raw as RawLimit[]) {
    if (!entry || typeof entry.kind !== "string") continue;
    if (typeof entry.percent !== "number") continue;
    const display = entry.scope?.model?.display_name;
    out.push({
      kind: entry.kind,
      group: typeof entry.group === "string" ? entry.group : entry.kind,
      percent: entry.percent,
      severity: typeof entry.severity === "string" ? entry.severity : "normal",
      resetsAt: toMs(entry.resets_at),
      scopeLabel: typeof display === "string" ? display : undefined,
      isActive: entry.is_active === true
    });
  }
  return out;
}

/**
 * Turn a utilization payload into rows, whoever fetched it.
 *
 * Split out because the same shape arrives two ways: from the CLI's cache of
 * it, and from the account endpoint `oauth-usage.ts` calls itself. The cache
 * was only ever a copy of that response, so one parser serves both — and a
 * field that moves moves for both at once.
 *
 * `tier` is not part of the payload. It lives on the account record in
 * `~/.claude.json`, so a live fetch has to carry it in from there.
 */
export function parseUtilization(
  payload: unknown,
  fetchedAt: number,
  tier?: string
): UsageUtilization | null {
  const limits = readLimits(
    (payload as { limits?: unknown } | null | undefined)?.limits
  );
  if (limits.length === 0 && !tier) return null;
  return { fetchedAt, limits, plan: planFromTier(tier), tier };
}

/**
 * Read the cached utilization, or null when it is not there.
 *
 * Null is a normal answer, not a failure: a fresh install has never asked the
 * server, and an API-key user has no subscription to report. The caller falls
 * back to its own estimate and says so.
 *
 * Since CLI 2.1.x this file no longer carries `cachedUsageUtilization` at all
 * — only the tier survives, which is why the live endpoint exists. Keep
 * reading it anyway: the key is still the only offline source of a percentage,
 * and an install that has it should not be made to go to the network.
 */
export async function readUsageUtilization(
  configPath = path.join(os.homedir(), ".claude.json")
): Promise<UsageUtilization | null> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  const cached = parsed.cachedUsageUtilization as
    | { fetchedAtMs?: unknown; utilization?: Record<string, unknown> }
    | undefined;
  const account = parsed.oauthAccount as
    | { organizationRateLimitTier?: unknown; userRateLimitTier?: unknown }
    | undefined;

  // The user's own tier wins over the organisation's: a seat in someone else's
  // org can carry a different plan from the org default.
  const tier =
    (typeof account?.userRateLimitTier === "string"
      ? account.userRateLimitTier
      : undefined) ??
    (typeof account?.organizationRateLimitTier === "string"
      ? account.organizationRateLimitTier
      : undefined);

  return parseUtilization(
    cached?.utilization,
    typeof cached?.fetchedAtMs === "number" ? cached.fetchedAtMs : 0,
    tier
  );
}
