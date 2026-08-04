// ─────────────────────────────────────────────────────────────
// TokenMeter — header chip + popover modeled on Claude's official
// "Usage" settings page.
//
// The panel says one of two things, and never mixes them. When the
// account has reported its own utilization, every row is a real
// percentage of a limit only Anthropic knows. When it has not, the
// rows are token counts aggregated from Claude Code's session JSONL
// files, with no percentage and no bar — because the denominator
// would have to be invented, and an invented one read "over" on an
// account that was at 22%.
//
// The context row is the exception that proves it: the CLI reports
// both halves of that fraction, so it keeps its bar on either path.
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
import { Icon } from "../../../design/icons";
import { Tooltip } from "../../../design/primitives";
import {
  PRESS,
  OVERLAY_PANEL,
  TRAVEL,
  SPRING_PRESS
} from "../../../design/motion";
import { onMessage, send } from "../../../lib/rpc";
import type {
  TimelineEvent,
  UsageTotals,
  SessionWindow,
  RateLimitStatus,
  UsageUtilization,
  UtilizationLimit
} from "../../../lib/rpc";
import {
  serverRows,
  chipView,
  labelForLimit,
  toneForLimit,
  toneForPct,
  pctOf,
  barWidth,
  formatCompact,
  formatNum,
  formatPctUsed,
  type ToneKey
} from "./usage-view";
import s from "./TokenMeter.module.scss";

interface TokenMeterProps {
  events: ReadonlyArray<TimelineEvent>;
  streaming: string;
}

/** Why the account's figures are missing. Mirrors `OAuthUsageOutcome`. */
type AccountStatus = "ok" | "no-token" | "unreachable" | "never";

/** What the panel says instead of a percentage, per reason. Naming the cause is
 *  the difference between "LUNO is broken" and "sign in" / "try again". */
const ACCOUNT_STATUS_NOTE: Record<AccountStatus, string> = {
  ok: "Token counts from this machine's session files. Your account reported no limits for this window.",
  "no-token":
    "No Claude Code login found on this machine, so your account's own percentages cannot be fetched. Counts below come from its session files.",
  unreachable:
    "Your account's figures could not be fetched just now — Refresh asks again. Counts below come from this machine's session files.",
  never:
    "Token counts from this machine's session files. Your account's own percentages have not been fetched yet — Refresh asks for them."
};

/** Display names for the tier the account reports. Nothing hangs off these any
 *  more — the plan used to select a cap, and there are no caps here now. */
const PLAN_NAMES: Record<string, string> = {
  pro: "Pro",
  max5: "Max 5×",
  max20: "Max 20×",
  team: "Team",
  api: "API"
};

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
  // Boundaries only — it reports no amounts and no percentages.
  const [limits, setLimits] = useState<RateLimitStatus[]>([]);
  // The account's own figures, fetched by the host. Null until they arrive,
  // and for good on an API key.
  const [util, setUtil] = useState<UsageUtilization | null>(null);
  // Why they are missing, when they are.
  const [accountStatus, setAccountStatus] = useState<AccountStatus>("never");
  // How full the model's context was on the last request. The CLI reports both
  // halves, so this is the one row here that can show a fraction we did not
  // have to guess at.
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
        setUtil(m.utilization ?? null);
        setAccountStatus(m.accountStatus ?? "never");
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

  const server = useMemo(() => serverRows(util?.limits), [util]);

  const sessionTotal = auth.available
    ? totalOf(auth.session.usage)
    : sessionEstimate.input + sessionEstimate.output;

  const chip = chipView(server, sessionTotal);
  const planName = util?.plan ? PLAN_NAMES[util.plan] : undefined;

  return (
    <div ref={rootRef} className={s.root}>
      <Tooltip
        label={
          chip.kind === "percent"
            ? `${chip.label}: ${chip.percent}% used`
            : `${chip.label}: ${formatNum(chip.tokens)} tokens counted here`
        }
      >
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
          className={`${s.chip} ${TONE_CLASS[chip.tone]}`}
        >
          <Icon name="bolt" size={9} />
          <span className={s.chipShort}>{chip.short}</span>
          {/* Two branches rather than one counter with a switchable formatter:
              the number means different things either side of the account's
              answer — a percentage it reported, a token total we counted — so
              a single spring would count between the two when the source
              changes. Separate elements mount at their own value instead. */}
          {chip.kind === "percent" ? (
            <ChipGauge pct={chip.percent} />
          ) : (
            <CountUp value={chip.tokens} format={formatCompact} />
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
                  fromAccount={Boolean(server)}
                  available={auth.available}
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

            {/* Plan row — a label, not a control. It used to pick which set of
                invented caps to divide by; the account's own figures need no
                such choice, and the fallback shows no fraction at all. */}
            {planName && (
              <div className={s.planRow}>
                <div className={s.planHead}>
                  <span className={s.planLabel}>Plan</span>
                  <Tooltip
                    label={`Reported by your account${util?.tier ? ` as ${util.tier}` : ""}`}
                  >
                    <span className={s.planValue}>{planName}</span>
                  </Tooltip>
                </div>
              </div>
            )}

            <div className={s.body}>
              {server?.session ? (
                <ServerRow
                  limit={server.session}
                  label="5-hour limit"
                  tick={tick}
                />
              ) : (
                <CountRow
                  label="Current session"
                  tokens={sessionTotal}
                  sub={
                    auth.available && auth.session.resetsAt > 0
                      ? `Resets in ${formatCountdown(auth.session.resetsAt, tick)}${
                          auth.session.authoritative ? "" : " (estimated)"
                        }`
                      : auth.available
                        ? "No activity in the last 5 hours"
                        : "Estimated · resets per Anthropic's 5-hour window"
                  }
                  tooltip="Tokens counted from this machine's session files. No percentage: Anthropic tells the account what its limit is, not this client."
                />
              )}

              {/* The model's context, as opposed to the account's quota. The
                  two are unrelated and users conflate them: a full context is
                  why the agent forgot the start of the chat, a spent quota is
                  why it stopped answering. */}
              {context && (
                <GaugeRow
                  label="Context window"
                  used={context.used}
                  window={context.window}
                  sub={
                    pctOf(context.used, context.window) >= 70
                      ? "Filling up — the CLI summarises earlier messages before this reaches 100%"
                      : "Last request, reported by the CLI"
                  }
                  // The old line said the fold happens "before it runs out",
                  // which reads as "at 100% of this bar". It does not: the CLI
                  // compacts against its own threshold, lower than the window
                  // and configurable, so this bar never reaches the end.
                  tooltip="Share of the model's full context window. Both numbers come from the CLI, so this one is exact — but auto-compaction runs at the CLI's own threshold, which is lower than 100%."
                />
              )}

              {/* Weekly limits group */}
              <div className={s.weekly}>
                <div className={s.weeklyHead}>
                  <span className={s.sectionTitle}>Weekly limits</span>
                </div>

                {server?.weekly ? (
                  <ServerRow
                    limit={server.weekly}
                    label="All models"
                    tick={tick}
                  />
                ) : (
                  <CountRow
                    label="All models"
                    tokens={totalOf(auth.week)}
                    sub={weeklyReset("seven_day", limits, tick)}
                  />
                )}

                {/* The account names the model this one is scoped to, so the
                    row does too. It used to be hard-coded to Sonnet; on this
                    account the scoped limit is Fable's. */}
                {server?.scoped ? (
                  <ServerRow
                    limit={server.scoped}
                    label={labelForLimit(server.scoped)}
                    tick={tick}
                  />
                ) : server ? null : (
                  <CountRow
                    label="Sonnet only"
                    tokens={totalOf(auth.weekSonnet)}
                    sub={weeklyReset("seven_day_sonnet", limits, tick)}
                  />
                )}
              </div>

              {/* Footer: last updated + refresh */}
              <div className={s.footer}>
                {/* Whose clock this is matters: the account's figures are only
                    as fresh as the last fetch of them, and the endpoint is
                    asked at most once every five minutes. */}
                <span className={s.footerStamp}>
                  {server && util?.fetchedAt
                    ? `From your account: ${formatAgo(util.fetchedAt, tick)}`
                    : auth.generatedAt
                      ? `Counted here: ${formatAgo(auth.generatedAt, tick)}`
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

              {!server && (
                <div className={s.disclaimer}>
                  {ACCOUNT_STATUS_NOTE[accountStatus]}
                </div>
              )}
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
  return (
    <>
      <CountText count={count} format={(n) => `${n}%`} />
      <span className={s.chipBar}>
        <motion.span className={s.chipBarFill} style={{ width }} />
      </span>
    </>
  );
}

/**
 * Where the numbers came from.
 *
 * Two states, because there are two vocabularies: the account's percentages,
 * or tokens counted here. The badge used to claim "Authoritative" for the
 * second one, which was true of the amounts and false of everything shown
 * beside them.
 */
function SourceBadge({
  fromAccount,
  available
}: {
  fromAccount: boolean;
  available: boolean;
}) {
  if (fromAccount) {
    return (
      <Tooltip label="Percentages reported by your Claude account">
        <span className={s.badgeOk}>
          <Icon name="check" size={8} />
          Your account
        </span>
      </Tooltip>
    );
  }
  if (available) {
    return (
      <Tooltip label="Tokens counted from Claude Code's session files on this machine. Percentages need the account's own figures.">
        <span className={s.badgeMuted}>Counted here</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label="Client-side estimate (no Claude Code session files for this workspace)">
      <span className={s.badgeMuted}>Estimate</span>
    </Tooltip>
  );
}

/**
 * One quota exactly as the account reports it.
 *
 * No token count and no cap: the account gives a percentage of a limit it does
 * not disclose, and inventing a denominator to print beside it would put the
 * old guesswork back on screen next to the truth.
 */
function ServerRow({
  limit,
  label,
  tick
}: {
  limit: UtilizationLimit;
  label: string;
  tick: number;
}) {
  const tone = toneForLimit(limit);
  const pctCount = useCountSpring(limit.percent);
  const fillWidth = useTransform(pctCount, barWidth);
  return (
    <div className={s.row}>
      <div className={s.rowHead}>
        <div className={s.rowLabelWrap}>
          <span className={s.rowLabel}>{label}</span>
        </div>
        <CountText
          className={s.rowPct}
          count={pctCount}
          format={formatPctUsed}
        />
      </div>
      <div className={s.bar}>
        <motion.div
          className={`${s.barFill} ${TONE_CLASS[tone]}`}
          style={{ width: fillWidth }}
        />
      </div>
      <div className={s.rowFoot}>
        {/* A scoped limit the account has never touched carries no reset time
            at all. Printing one from a zero said "resets shortly", which is a
            claim about a window nobody mentioned. */}
        <span>
          {limit.resetsAt === 0
            ? ""
            : hasReset(limit.resetsAt, tick)
              ? "Resets shortly"
              : `Resets in ${formatCountdown(limit.resetsAt, tick)}`}
        </span>
        {/* The other half of the same number. It is the question the panel is
            actually asked — how much is left — and the account's percentage is
            the only honest way to answer it, since the cap itself is never
            disclosed. */}
        <span className={s.rowLeft}>{100 - limit.percent}% left</span>
      </div>
    </div>
  );
}

/**
 * A row with an amount and no fraction — everything the fallback path is
 * entitled to say.
 */
function CountRow({
  label,
  tokens,
  sub,
  tooltip
}: {
  label: string;
  tokens: number;
  sub: string;
  tooltip?: string;
}) {
  const count = useCountSpring(tokens);
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
        <span className={s.rowAmount}>
          <CountText count={count} format={formatNum} />
          <span className={s.rowUnit}>tokens</span>
        </span>
      </div>
      <div className={s.rowFoot}>
        <span>{sub}</span>
      </div>
    </div>
  );
}

/** A fraction both halves of which are known. Only the context window is. */
function GaugeRow({
  label,
  used,
  window: windowSize,
  sub,
  tooltip
}: {
  label: string;
  used: number;
  window: number;
  sub: string;
  tooltip?: string;
}) {
  const pct = pctOf(used, windowSize);
  // The bar and the "% used" label are one number, so they hang off one
  // spring. `used` moves independently of both.
  const pctCount = useCountSpring(pct);
  const usedCount = useCountSpring(used);
  const fillWidth = useTransform(pctCount, barWidth);

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
        <CountText
          className={s.rowPct}
          count={pctCount}
          format={formatPctUsed}
        />
      </div>
      <div className={s.bar}>
        <motion.div
          // Bound to the same spring as the percentage above it instead of
          // running its own transition: two animations of one number drift
          // apart, and a bar disagreeing with its own label is the one thing a
          // meter must not do.
          className={`${s.barFill} ${TONE_CLASS[toneForPct(pct)]}`}
          style={{ width: fillWidth }}
        />
      </div>
      <div className={s.rowFoot}>
        <span>{sub}</span>
        <span className={s.rowNums}>
          <CountText
            className={s.rowUsed}
            count={usedCount}
            format={formatNum}
          />
          <span className={s.rowSlash}>/</span>
          {formatCompact(windowSize)}
        </span>
      </div>
    </div>
  );
}

// ─────────────────── Helpers ───────────────────

const TONE_CLASS: Record<ToneKey, string> = {
  ok: s.toneOk,
  warn: s.toneWarn,
  err: s.toneErr,
  accent: s.toneAccent
};

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

/** Whether the window has already rolled over. A function rather than an
 *  inline comparison because reading the clock during render is impure — the
 *  `_tick` argument is what re-runs it, exactly as for the two below. */
function hasReset(resetsAt: number, _tick: number): boolean {
  return resetsAt <= Date.now();
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
