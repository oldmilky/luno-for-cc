// ─────────────────────────────────────────────────────────────
// TokenMeter — header chip + popover modeled on Claude's official
// "Usage" settings page (Current session + Weekly limits + Last
// updated). Data is aggregated from Claude Code's per-workspace
// session JSONL files when available (subscription mode); falls
// back to a client-side chars/4 estimate otherwise.
//
// Limits are plan-specific (Pro / Max 5× / Max 20× / Team) because
// Anthropic doesn't expose the user's real quota to clients. The
// user picks their plan once; we keep sensible defaults for each.
// When usage exceeds the configured plan limit (most often because
// the limit is set too low for the user's tier), the row switches
// to a soft "above plan default — adjust?" pill instead of locking
// the bar at a misleading 100% red.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform
} from "framer-motion";
import type { MotionValue } from "framer-motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import {
  PRESS,
  OVERLAY_PANEL,
  TRAVEL,
  SPRING_PRESS
} from "../../design/motion";
import { onMessage, send } from "../../lib/rpc";
import type {
  TimelineEvent,
  UsageTotals,
  SessionWindow,
  RateLimitStatus
} from "../../lib/rpc";
import s from "./TokenMeter.module.scss";

interface TokenMeterProps {
  events: ReadonlyArray<TimelineEvent>;
  streaming: string;
}

// Plan presets — rough estimates of Anthropic's published per-plan caps.
// Anthropic doesn't broadcast these to clients, so we ship the best
// publicly-documented numbers and let the user override anything that
// doesn't match their actual experience.
type PlanKey = "pro" | "max5" | "max20" | "team" | "api" | "custom";

interface PlanPreset {
  name: string;
  /** Tokens per 5-hour rolling window. 0 = no cap (API). */
  session: number;
  /** Cumulative tokens per week, across every model. 0 = no cap. */
  weekAll: number;
  /** Cumulative tokens per week, Sonnet only. 0 = no cap. */
  weekSonnet: number;
  /** Short note shown under the plan name in the picker. */
  note: string;
}

const PLAN_PRESETS: Record<PlanKey, PlanPreset> = {
  pro: {
    name: "Pro",
    session: 200_000,
    weekAll: 10_000_000,
    weekSonnet: 3_000_000,
    note: "Personal tier"
  },
  max5: {
    name: "Max 5×",
    session: 1_500_000,
    weekAll: 50_000_000,
    weekSonnet: 20_000_000,
    note: "5× the Pro quota"
  },
  max20: {
    name: "Max 20×",
    session: 6_000_000,
    weekAll: 200_000_000,
    weekSonnet: 80_000_000,
    note: "20× the Pro quota"
  },
  team: {
    name: "Team",
    session: 10_000_000,
    weekAll: 500_000_000,
    weekSonnet: 200_000_000,
    note: "Per-seat business plan"
  },
  api: {
    name: "API",
    session: 0,
    weekAll: 0,
    weekSonnet: 0,
    note: "No subscription cap — billed per token"
  },
  custom: {
    name: "Custom",
    session: 200_000,
    weekAll: 5_000_000,
    weekSonnet: 2_000_000,
    note: "Set your own limits"
  }
};

const PLAN_ORDER: PlanKey[] = ["pro", "max5", "max20", "team", "api", "custom"];

const SETTINGS_KEY = "luno.tokenMeter.v3";

interface MeterSettings {
  plan: PlanKey;
  /** Custom overrides keyed by plan (so editing Pro limits doesn't bleed into Max). */
  overrides: Partial<
    Record<PlanKey, { session?: number; weekAll?: number; weekSonnet?: number }>
  >;
}

function defaultSettings(): MeterSettings {
  return { plan: "pro", overrides: {} };
}

function readSettings(): MeterSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<MeterSettings>;
    return {
      plan: PLAN_ORDER.includes(parsed.plan as PlanKey)
        ? (parsed.plan as PlanKey)
        : "pro",
      overrides:
        parsed.overrides && typeof parsed.overrides === "object"
          ? (parsed.overrides as MeterSettings["overrides"])
          : {}
    };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(next: MeterSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function resolveLimits(cfg: MeterSettings): {
  session: number;
  weekAll: number;
  weekSonnet: number;
} {
  const preset = PLAN_PRESETS[cfg.plan];
  const ov = cfg.overrides[cfg.plan] ?? {};
  return {
    session: ov.session ?? preset.session,
    weekAll: ov.weekAll ?? preset.weekAll,
    weekSonnet: ov.weekSonnet ?? preset.weekSonnet
  };
}

const EMPTY_TOTAL: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreatedTokens: 0,
  messages: 0
};

const EMPTY_SESSION: SessionWindow = {
  usage: EMPTY_TOTAL,
  startedAt: 0,
  resetsAt: 0
};

interface AuthoritativeUsage {
  session: SessionWindow;
  today: UsageTotals;
  week: UsageTotals;
  weekSonnet: UsageTotals;
  total: UsageTotals;
  generatedAt: number;
  available: boolean;
}

export function TokenMeter({ events, streaming }: TokenMeterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * How far the chip sits from the panel's left edge, published to the
   * stylesheet as `--pop-anchor` so the popover can shift itself back on
   * screen when there is not 380px to its right. CSS cannot ask where its own
   * anchor is, and in a sidebar that answer is the difference between a panel
   * and a panel with its first column cut off.
   */
  const [anchorLeft, setAnchorLeft] = useState(0);
  const [settings, setSettings] = useState<MeterSettings>(() => readSettings());
  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [auth, setAuth] = useState<AuthoritativeUsage>({
    session: EMPTY_SESSION,
    today: EMPTY_TOTAL,
    week: EMPTY_TOTAL,
    weekSonnet: EMPTY_TOTAL,
    total: EMPTY_TOTAL,
    generatedAt: 0,
    available: false
  });
  // The CLI's own quota verdicts: which window is binding and when it resets.
  // Server truth for the *boundaries* — it reports no amounts, so the bars
  // still come from the aggregated session files.
  const [limits, setLimits] = useState<RateLimitStatus[]>([]);
  // How full the model's context was on the last request. The CLI reports both
  // halves, so this is the one row in this panel that is not an estimate.
  const [context, setContext] = useState<{
    used: number;
    window: number;
  } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const h = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(h);
  }, [open]);

  useEffect(() => {
    return onMessage((m) => {
      if (m.type === "claudeCodeUsage") {
        setAuth({
          session: m.session,
          today: m.today,
          week: m.week,
          weekSonnet: m.weekSonnet,
          total: m.total,
          generatedAt: m.generatedAt,
          available: m.available
        });
        setLimits(m.limits ?? []);
      } else if (
        m.type === "tokenUsage" &&
        m.contextTokens !== undefined &&
        m.contextWindow
      ) {
        setContext({ used: m.contextTokens, window: m.contextWindow });
      }
    });
  }, []);

  const sessionEstimate = useMemo(
    () => estimateSession(events, streaming),
    [events, streaming]
  );

  const caps = resolveLimits(settings);
  const preset = PLAN_PRESETS[settings.plan];

  const sessionTotal = auth.available
    ? totalOf(auth.session.usage)
    : sessionEstimate.input + sessionEstimate.output;
  const weekAllTotal = totalOf(auth.week);
  const weekSonnetTotal = totalOf(auth.weekSonnet);

  const sessionPct = pctOf(sessionTotal, caps.session);
  const weekAllPct = pctOf(weekAllTotal, caps.weekAll);
  const weekSonnetPct = pctOf(weekSonnetTotal, caps.weekSonnet);

  // For the chip: show whichever bucket has the highest pressure. If the
  // currently-active plan has no caps (API) just show session total.
  const noCaps = settings.plan === "api";
  const {
    primaryLabel,
    primaryShort,
    primaryValue,
    primaryDisplay,
    primaryTone
  } = pickChipPrimary(
    noCaps,
    sessionTotal,
    sessionPct,
    weekAllTotal,
    weekAllPct,
    weekSonnetTotal,
    weekSonnetPct
  );

  const setLimitOverride = (
    key: "session" | "weekAll" | "weekSonnet",
    v: number
  ) => {
    setSettings((prev) => {
      const ov = { ...(prev.overrides[prev.plan] ?? {}), [key]: v };
      const next = {
        ...prev,
        overrides: { ...prev.overrides, [prev.plan]: ov }
      };
      writeSettings(next);
      return next;
    });
  };

  const setPlan = (p: PlanKey) => {
    setSettings((prev) => {
      const next = { ...prev, plan: p };
      writeSettings(next);
      return next;
    });
    setShowPlanPicker(false);
  };

  return (
    <div ref={rootRef} className={s.root}>
      <Tooltip label={`${primaryLabel}: ${primaryDisplay}`}>
        <motion.button
          type="button"
          onClick={() => {
            // Measured on the click, not on mount: the chip's offset moves
            // with the panel's width and with what sits left of it.
            setAnchorLeft(rootRef.current?.getBoundingClientRect().left ?? 0);
            setOpen((o) => !o);
          }}
          {...PRESS}
          whileHover={{ y: -1 }}
          className={`${s.chip} ${TONE_CLASS[primaryTone]}`}
        >
          <Icon name="bolt" size={9} />
          <span className={s.chipShort}>{primaryShort}</span>
          {/* Two branches rather than one counter with a switchable formatter:
              the number means different things either side of `noCaps` — a
              percentage against a cap, a raw token total without one — so a
              single spring would count between the two when the plan changes.
              Separate elements mount at their own value instead. */}
          {noCaps ? (
            <CountUp value={primaryValue} format={formatCompact} />
          ) : (
            <ChipGauge pct={primaryValue} />
          )}
        </motion.button>
      </Tooltip>
      <AnimatePresence>
        {open && (
          <motion.div
            {...OVERLAY_PANEL}
            // Travel is inverted: this panel hangs *below* its trigger, so it
            // has to drop into place. The preset rises, which would read as
            // arriving from the wrong side of the chip.
            initial={{ ...OVERLAY_PANEL.initial, y: -TRAVEL.lg }}
            exit={{ ...OVERLAY_PANEL.exit, y: -TRAVEL.sm }}
            className={s.popover}
            style={{ "--pop-anchor": `${anchorLeft}px` } as CSSProperties}
          >
            {/* Header */}
            <div className={s.head}>
              <div className={s.headLeft}>
                <span className={s.headTitle}>Your usage limits</span>
                <SourceBadge
                  available={auth.available}
                  anchored={auth.session.authoritative === true}
                />
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className={s.close}
                aria-label="Close"
              >
                <Icon name="x" size={11} />
              </button>
            </div>

            {/* Plan row */}
            <div className={s.planRow}>
              <div className={s.planHead}>
                <span className={s.planLabel}>Plan</span>
                <button
                  type="button"
                  onClick={() => setShowPlanPicker((p) => !p)}
                  className={s.planButton}
                >
                  <span>{preset.name}</span>
                  <Icon name="chevronD" size={9} />
                </button>
              </div>
              <div className={s.planNote}>{preset.note}</div>
              <AnimatePresence>
                {showPlanPicker && (
                  <motion.div
                    {...OVERLAY_PANEL}
                    // Same inversion as the popover — it opens under the plan
                    // button.
                    initial={{ ...OVERLAY_PANEL.initial, y: -TRAVEL.lg }}
                    exit={{ ...OVERLAY_PANEL.exit, y: -TRAVEL.sm }}
                    className={s.planMenu}
                  >
                    {PLAN_ORDER.map((k) => {
                      const p = PLAN_PRESETS[k];
                      const active = k === settings.plan;
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setPlan(k)}
                          className={[
                            s.planItem,
                            active ? s.planItemActive : ""
                          ].join(" ")}
                        >
                          <span className={s.planItemHead}>
                            <span className={s.planItemName}>{p.name}</span>
                            {active && <Icon name="check" size={10} />}
                          </span>
                          <span className={s.planItemNote}>{p.note}</span>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className={s.body}>
              {/* Current session. The countdown says where its boundary came
                  from: the CLI's own verdict, or a guess from message
                  timestamps that can be hours out. */}
              <UsageRow
                label="Current session"
                pct={sessionPct}
                used={sessionTotal}
                limit={caps.session}
                sub={
                  auth.available && auth.session.resetsAt > 0
                    ? `Resets in ${formatCountdown(auth.session.resetsAt, tick)}${
                        auth.session.authoritative ? "" : " (estimated)"
                      }`
                    : auth.available
                      ? "No activity in the last 5 hours"
                      : "Estimated · resets per Anthropic's 5-hour window"
                }
                tooltip={
                  auth.session.authoritative
                    ? "Window boundary reported by the Claude CLI itself. Tokens are summed from the session files inside that window."
                    : "No quota verdict seen yet — the CLI reports one during a turn. Until then the window is inferred from message timestamps and can be hours out."
                }
                noCap={caps.session === 0}
                onLimitChange={(v) => setLimitOverride("session", v)}
              />

              {/* The model's context, as opposed to the account's quota. The
                  two are unrelated and users conflate them: a full context is
                  why the agent forgot the start of the chat, a spent quota is
                  why it stopped answering. */}
              {context && (
                <UsageRow
                  label="Context window"
                  pct={pctOf(context.used, context.window)}
                  used={context.used}
                  limit={context.window}
                  sub={
                    pctOf(context.used, context.window) >= 70
                      ? "Filling up — the CLI will fold earlier messages into a summary before it runs out"
                      : "Last request, reported by the CLI"
                  }
                  tooltip="Exact, unlike the plan caps below: both numbers come from the CLI rather than being inferred."
                  noCap={false}
                  onLimitChange={() => undefined}
                />
              )}

              {/* Weekly limits group */}
              <div className={s.weekly}>
                <div className={s.weeklyHead}>
                  <span className={s.sectionTitle}>Weekly limits</span>
                </div>

                <UsageRow
                  label="All models"
                  pct={weekAllPct}
                  used={weekAllTotal}
                  limit={caps.weekAll}
                  sub={weeklyReset("seven_day", limits, tick)}
                  noCap={caps.weekAll === 0}
                  onLimitChange={(v) => setLimitOverride("weekAll", v)}
                />

                <UsageRow
                  label="Sonnet only"
                  pct={weekSonnetPct}
                  used={weekSonnetTotal}
                  limit={caps.weekSonnet}
                  sub={weeklyReset("seven_day_sonnet", limits, tick)}
                  tooltip="Counts every assistant message produced by any Claude Sonnet model this week."
                  noCap={caps.weekSonnet === 0}
                  onLimitChange={(v) => setLimitOverride("weekSonnet", v)}
                />
              </div>

              {/* Footer: last updated + refresh */}
              <div className={s.footer}>
                <span className={s.footerStamp}>
                  {auth.generatedAt
                    ? `Last updated: ${formatAgo(auth.generatedAt, tick)}`
                    : "No data yet"}
                </span>
                <button
                  type="button"
                  onClick={() => send({ type: "refreshUsage" })}
                  className={s.refresh}
                  aria-label="Refresh usage now"
                >
                  <Icon name="refresh" size={10} />
                  Refresh
                </button>
              </div>

              {/* Disclaimer */}
              <div className={s.disclaimer}>
                Limits are best-guesses of Anthropic's published per-plan caps —
                they may not match your account exactly. Click any limit number
                to set a custom value, or change plan above.
                {auth.available
                  ? " Totals come from Claude Code's session files on this machine; claude.ai browser activity isn't visible to the extension."
                  : " Token counts are client-side estimates until Claude Code session files are present."}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────── Counting numbers ───────────────────
// Every readout in this panel changes while you are looking at it, and every
// one of them used to swap digits inside a single frame.

/**
 * Follows `value` with a spring, seeded at whatever it was first handed.
 *
 * Two things it has to get right.
 *
 * It must not run on mount. The popover is remounted every time it opens, and
 * a count-up from zero on each open is noise rather than delight; seeding the
 * motion value means the first render is already at the answer, and framer
 * skips an animation whose start and end match.
 *
 * And it must be a spring, not a tween. `used` is republished on every
 * streamed token: a tween is torn down and restarted from a standing start on
 * each new target, so the number crawls and never actually lands. A spring
 * re-targets instead, carrying the velocity it already had, and framer
 * coalesces re-targets to one per frame — so it chases a moving total rather
 * than its own tail.
 *
 * The reduced-motion check has to be explicit here. `<MotionConfig
 * reducedMotion="user">` in main.tsx covers the whole app, but framer only
 * applies it on the `animate`-prop path — a value driven through useSpring
 * never passes through that code, so these counters would have kept springing
 * for a user who asked the OS for no motion. Handing back the raw target
 * instead of the spring makes the readout jump straight to its value.
 */
function useCountSpring(value: number): MotionValue<number> {
  const reduce = useReducedMotion();
  const target = useMotionValue(value);
  const count = useSpring(target, SPRING_PRESS);
  useEffect(() => {
    target.set(value);
  }, [target, value]);
  return reduce ? target : count;
}

/**
 * Renders a count through the same formatter the static render uses, so
 * separators, units and precision are untouched.
 *
 * The rounding is not cosmetic. Without it the in-flight frames carry the
 * spring's full float precision and the readout flickers through digits the
 * settled value never shows.
 */
function CountText({
  count,
  format,
  className
}: {
  count: MotionValue<number>;
  format: (n: number) => string;
  className?: string;
}) {
  const text = useTransform(count, (v) => format(Math.round(v)));
  return (
    <motion.span className={className ? `${s.count} ${className}` : s.count}>
      {text}
    </motion.span>
  );
}

/** A readout with no bar to stay in step with, so it owns its spring. */
function CountUp({
  value,
  format,
  className
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}) {
  const count = useCountSpring(value);
  return <CountText count={count} format={format} className={className} />;
}

// ─────────────────── Sub-components ───────────────────

/**
 * The chip's percentage and its mini bar off one spring — they are the same
 * number and must not be allowed to disagree. The bar used to ease its width
 * in CSS while the number beside it snapped, which is the worst of both.
 */
function ChipGauge({ pct }: { pct: number }) {
  const count = useCountSpring(pct);
  const width = useTransform(count, barWidth);
  // Past the cap the chip says "over" instead of a number. Read off the real
  // value rather than the in-flight one, so it flips exactly where it used to.
  const over = pct >= 100;
  return (
    <>
      <CountText count={count} format={(n) => (over ? "over" : `${n}%`)} />
      <span className={s.chipBar}>
        <motion.span className={s.chipBarFill} style={{ width }} />
      </span>
    </>
  );
}

/**
 * Where the numbers came from. Two independent things have to be true to call
 * the panel authoritative — the amounts and the window they are counted over —
 * and claiming it on the amounts alone put the badge next to rows that said
 * "(estimated)" on every line.
 */
function SourceBadge({
  available,
  anchored
}: {
  available: boolean;
  anchored: boolean;
}) {
  if (available && anchored) {
    return (
      <Tooltip label="Amounts from Claude Code's session files, window boundaries reported by the CLI itself">
        <span className={s.badgeOk}>
          <Icon name="check" size={8} />
          Authoritative
        </span>
      </Tooltip>
    );
  }
  if (available) {
    return (
      <Tooltip label="Amounts from Claude Code's session files, but no quota verdict seen yet — the windows they are counted over are inferred until a turn runs">
        <span className={s.badgeMuted}>Partial</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label="Client-side estimate (no Claude Code session files for this workspace)">
      <span className={s.badgeMuted}>Estimate</span>
    </Tooltip>
  );
}

function UsageRow({
  label,
  pct,
  used,
  limit,
  sub,
  tooltip,
  noCap,
  onLimitChange
}: {
  label: string;
  pct: number;
  used: number;
  limit: number;
  sub: string;
  tooltip?: string;
  noCap: boolean;
  onLimitChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(limit));
  useEffect(() => {
    if (!editing) setDraft(String(limit));
  }, [limit, editing]);

  const tone = toneFor(pct);
  const overLimit = !noCap && pct >= 100;
  // The bar and the "% used" label are one number, so they hang off one
  // spring. `used` and the limit move independently of both.
  const pctCount = useCountSpring(pct);
  const usedCount = useCountSpring(used);
  const limitCount = useCountSpring(limit);
  const fillWidth = useTransform(pctCount, barWidth);
  const commit = () => {
    setEditing(false);
    const parsed = parseLimit(draft);
    if (parsed && parsed !== limit) onLimitChange(parsed);
  };

  return (
    <div className={s.row}>
      <div className={s.rowHead}>
        <div className={s.rowLabelWrap}>
          <span className={s.rowLabel}>{label}</span>
          {tooltip && (
            <Tooltip label={tooltip}>
              <span className={s.rowInfo}>
                <Icon name="info" size={12} />
              </span>
            </Tooltip>
          )}
        </div>
        {noCap ? (
          <span className={s.rowNoCap}>no cap</span>
        ) : overLimit ? (
          <Tooltip label="Your usage is above the limit for this plan — pick the right plan above, or click the limit to set a custom value">
            <span className={s.rowOver}>
              <Icon name="zap" size={8} />
              Above plan default
            </span>
          </Tooltip>
        ) : (
          <CountText
            className={s.rowPct}
            count={pctCount}
            format={formatPctUsed}
          />
        )}
      </div>
      {!noCap && (
        <div className={s.bar}>
          <motion.div
            className={`${s.barFill} ${TONE_CLASS[tone]}`}
            // Bound to the same spring as the percentage above it instead of
            // running its own transition: two animations of one number drift
            // apart, and a bar disagreeing with its own label is the one thing
            // a meter must not do. This costs the sweep-from-zero the bar used
            // to play when the popover opened — sharing the value means that
            // sweep would drag the number up from zero with it.
            style={{ width: fillWidth }}
          />
          {overLimit && <div className={s.barOver} aria-hidden />}
        </div>
      )}
      <div className={s.rowFoot}>
        <span>{sub}</span>
        <span className={s.rowNums}>
          <CountText
            className={s.rowUsed}
            count={usedCount}
            format={formatNum}
          />
          {!noCap && (
            <>
              <span className={s.rowSlash}>/</span>
              {editing ? (
                <input
                  type="text"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    else if (e.key === "Escape") {
                      setDraft(String(limit));
                      setEditing(false);
                    }
                  }}
                  className={s.limitInput}
                />
              ) : (
                <Tooltip label="Click to set a custom limit for this plan">
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className={s.limitButton}
                  >
                    <CountText count={limitCount} format={formatCompact} />
                  </button>
                </Tooltip>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

// ─────────────────── Helpers ───────────────────

function pctOf(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return (used / limit) * 100;
}

function totalOf(t: UsageTotals): number {
  // Includes cache-created tokens (they cost) but NOT cache-read (cheap).
  return t.inputTokens + t.outputTokens + t.cacheCreatedTokens;
}

function estimateSession(
  events: ReadonlyArray<TimelineEvent>,
  streaming: string
) {
  let input = 0;
  let output = 0;
  for (const e of events) {
    const body = e.body ?? "";
    const tokens = Math.ceil(body.length / 4);
    if (e.kind === "user" || e.kind === "tool_result") input += tokens;
    else if (e.kind === "assistant" || e.kind === "tool_call") output += tokens;
  }
  output += Math.ceil(streaming.length / 4);
  return { input, output };
}

/** Which `.tone*` class paints the chip / bar. The colors live in the module. */
type ToneKey = "ok" | "warn" | "err" | "accent";

const TONE_CLASS: Record<ToneKey, string> = {
  ok: s.toneOk,
  warn: s.toneWarn,
  err: s.toneErr,
  accent: s.toneAccent
};

function toneFor(pct: number): ToneKey {
  if (pct < 50) return "ok";
  if (pct < 80) return "warn";
  if (pct < 100) return "err";
  // Over-limit: warm amber, not alarming red, since we may just have the plan wrong.
  return "warn";
}

/** Bar fills read the same spring as their number; only the display is clamped. */
function barWidth(pct: number): string {
  return `${Math.min(100, Math.max(0, pct))}%`;
}

function pickChipPrimary(
  noCaps: boolean,
  sessionUsed: number,
  sessionPct: number,
  weekAllUsed: number,
  weekAllPct: number,
  weekSonnetUsed: number,
  weekSonnetPct: number
): {
  primaryLabel: string;
  primaryShort: string;
  /** What the chip counts to: a percentage, or a token total on an uncapped plan. */
  primaryValue: number;
  /** Settled form of the same number — the tooltip has no reason to animate. */
  primaryDisplay: string;
  primaryTone: ToneKey;
} {
  if (noCaps) {
    return {
      primaryLabel: "Current session",
      primaryShort: "5H",
      primaryValue: sessionUsed,
      primaryDisplay: formatCompact(sessionUsed),
      primaryTone: "accent"
    };
  }
  const candidates = [
    {
      label: "Current session",
      short: "5H",
      used: sessionUsed,
      pct: sessionPct
    },
    {
      label: "Weekly (all models)",
      short: "WK",
      used: weekAllUsed,
      pct: weekAllPct
    },
    {
      label: "Weekly (Sonnet)",
      short: "SON",
      used: weekSonnetUsed,
      pct: weekSonnetPct
    }
  ];
  candidates.sort((a, b) => b.pct - a.pct);
  const top = candidates[0];
  return {
    primaryLabel: top.label,
    primaryShort: top.short,
    primaryValue: top.pct,
    primaryDisplay: top.pct >= 100 ? "over" : `${Math.round(top.pct)}%`,
    primaryTone: toneFor(top.pct)
  };
}

function formatCountdown(resetsAt: number, _tick: number): string {
  const diff = resetsAt - Date.now();
  if (diff <= 0) return "now";
  const totalMin = Math.floor(diff / 60_000);
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hr === 0) return `${min} min`;
  if (min === 0) return `${hr} hr`;
  return `${hr} hr ${min} min`;
}

function formatAgo(ts: number, _tick: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  return `${Math.floor(diff / 3_600_000)} hr ago`;
}

/**
 * When a weekly window resets.
 *
 * Prefers the CLI's verdict for that exact bucket. The fallback assumes the
 * week turns over at local Monday midnight, which is only ever a guess:
 * Anthropic anchors each account's week to when it first hit the cap, not to
 * a calendar boundary. Labelled as an estimate so nobody plans around it.
 */
function weeklyReset(
  bucket: string,
  limits: RateLimitStatus[],
  tick: number
): string {
  const known = limits.find((l) => l.bucket === bucket);
  if (known) return `Resets in ${formatCountdown(known.resetsAt, tick)}`;

  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const days = dow === 1 ? 7 : (8 - dow) % 7 || 7;
  d.setDate(d.getDate() + days);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `Resets ${day} 12:00 AM (estimated)`;
}

function formatCompact(n: number): string {
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

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

// The suffixes travel with the number rather than sitting in a sibling node:
// a count writes its own textContent, so anything it must not overwrite has to
// be outside it — and anything it should keep has to be inside.
function formatPctUsed(n: number): string {
  return `${n}% used`;
}

function parseLimit(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase().replace(/[, _]/g, "");
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+(?:\.\d+)?)([km]?)$/i);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const mult = m[2] === "k" ? 1000 : m[2] === "m" ? 1_000_000 : 1;
  return Math.round(base * mult);
}
