// ─────────────────────────────────────────────────────────────
// What the usage panel is allowed to say, and on whose authority.
//
// One rule decides everything here: a percentage may only be shown when the
// account reported one. Anthropic does not tell a client what the cap is, so
// every percentage LUNO computed itself was a token count we defined divided
// by a limit we invented — and on a live Max 20× account that read "over"
// where the account said 22%.
//
// So the panel has two vocabularies. With the account's figures it speaks in
// percentages, severities and bars. Without them it speaks in token counts and
// nothing else. These helpers are the seam between the two, kept out of the
// component so they can be tested without a DOM.
// ─────────────────────────────────────────────────────────────

import type { UtilizationLimit } from "../../../lib/rpc";

/** Which `.tone*` class paints a chip or a bar. The colors live in the module. */
export type ToneKey = "ok" | "warn" | "err" | "accent";

/** The account's rows, sorted into the slots the panel renders. */
export interface ServerRows {
  session?: UtilizationLimit;
  weekly?: UtilizationLimit;
  scoped?: UtilizationLimit;
  /** Whichever is under the most pressure — what the collapsed chip shows. */
  worst: UtilizationLimit;
}

/**
 * The account's rows, or null when it has not spoken.
 *
 * Null is the whole switch: every caller reads it as "say it in tokens".
 */
export function serverRows(
  limits: ReadonlyArray<UtilizationLimit> | undefined
): ServerRows | null {
  if (!limits || limits.length === 0) return null;
  const pick = (kind: string) => limits.find((l) => l.kind === kind);
  const session = pick("session");
  const weekly = pick("weekly_all");
  const scoped = pick("weekly_scoped");

  const worst = [session, weekly, scoped]
    .filter((l): l is UtilizationLimit => Boolean(l))
    .reduce<UtilizationLimit | undefined>(
      (a, b) => (!a || b.percent > a.percent ? b : a),
      undefined
    );
  return worst ? { session, weekly, scoped, worst } : null;
}

/**
 * How hard to paint one of the account's rows.
 *
 * The server's own `severity` leads. The percentage thresholds are a floor
 * under it, not a second opinion: they can raise a row the server called
 * normal, never lower one it called critical.
 */
export function toneForLimit(limit: UtilizationLimit): ToneKey {
  if (limit.severity === "critical" || limit.percent >= 90) return "err";
  if (limit.severity === "warning" || limit.percent >= 75) return "warn";
  return "ok";
}

/**
 * What a limit is called on the chip, where it stands alone and has to name
 * its own window. Inside the panel the weekly rows sit under a "Weekly limits"
 * heading and take a shorter label from the caller — repeating the word there
 * reads as a stutter.
 */
export function labelForLimit(limit: UtilizationLimit): string {
  if (limit.kind === "session") return "5-hour limit";
  if (limit.kind === "weekly_scoped") {
    return limit.scopeLabel ? `${limit.scopeLabel} only` : "Model-scoped";
  }
  return "Weekly (all models)";
}

/**
 * The header chip.
 *
 * Two shapes, not one with an optional field: a percentage and a token count
 * are different claims, and the chip animates between values of the same kind
 * only. Counting from 22 to 1,240,000 because the source changed is how a
 * meter looks broken while being right.
 */
export type ChipView =
  | {
      kind: "percent";
      label: string;
      short: string;
      percent: number;
      tone: ToneKey;
    }
  | {
      kind: "tokens";
      label: string;
      short: string;
      tokens: number;
      tone: ToneKey;
    };

export function chipView(
  rows: ServerRows | null,
  sessionTokens: number
): ChipView {
  if (!rows) {
    // No tone thresholds without a cap. Accent says "here is a number", which
    // is all we know.
    return {
      kind: "tokens",
      label: "Current session",
      short: "5H",
      tokens: sessionTokens,
      tone: "accent"
    };
  }
  const { worst } = rows;
  return {
    kind: "percent",
    label: labelForLimit(worst),
    short: worst.group === "session" ? "5H" : "WK",
    percent: worst.percent,
    tone: toneForLimit(worst)
  };
}

/** Percentage of a denominator we actually know. Only the context row qualifies. */
export function pctOf(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return (used / limit) * 100;
}

/** Bar fills read the same spring as their number; only the display is clamped. */
export function barWidth(pct: number): string {
  return `${Math.min(100, Math.max(0, pct))}%`;
}

/** Thresholds on a real fraction — the context window reports both halves. */
export function toneForPct(pct: number): ToneKey {
  if (pct < 50) return "ok";
  if (pct < 80) return "warn";
  return "err";
}

export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return v >= 10
      ? Math.round(v) + "k"
      : v.toFixed(1).replace(/\.0$/, "") + "k";
  }
  const v = n / 1_000_000;
  return v >= 10
    ? Math.round(v) + "M"
    : v.toFixed(2).replace(/\.?0+$/, "") + "M";
}

export function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

// The suffixes travel with the number rather than sitting in a sibling node:
// a count writes its own textContent, so anything it must not overwrite has to
// be outside it — and anything it should keep has to be inside.
export function formatPctUsed(n: number): string {
  return `${n}% used`;
}
