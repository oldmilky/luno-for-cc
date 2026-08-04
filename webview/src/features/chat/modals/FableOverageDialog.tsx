// ─────────────────────────────────────────────────────────────
// Fable 5 bills against usage credits rather than the plan, so
// the CLI asks once before running on it. Not a permission — no
// tool is waiting — but it blocks the turn just the same.
//
// Copy, links and outcomes are the reference client's, read out
// of extension 2.1.220: the wording is what Anthropic shows for
// its own billing, and inventing our own here would be a worse
// kind of original.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { ENTER_CARD } from "../../../design/motion";
import { send, type UserDialogView } from "../../../lib/rpc";
import s from "./FableOverageDialog.module.scss";

const BUY_CREDITS = "https://claude.ai/settings/usage";
const LEARN_MORE =
  "https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans";

/** Currencies quoted in whole units — a balance in them is not in cents. */
const WHOLE_UNIT = new Set(["JPY", "KRW", "VND"]);

function money(cents: number, currency?: string | null): string {
  const code = (currency ?? "USD").toUpperCase();
  const amount = WHOLE_UNIT.has(code) ? cents : cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code
    }).format(amount);
  } catch {
    // An unknown code must not take the card down: the number still reads.
    return `${amount} ${code}`;
  }
}

interface Payload {
  overagesEnabled: boolean;
  balanceCents: number | null;
  currency: string | null;
}

function read(payload: Record<string, unknown>): Payload | null {
  if (typeof payload.overagesEnabled !== "boolean") return null;
  const cents = payload.balanceCents;
  return {
    overagesEnabled: payload.overagesEnabled,
    balanceCents:
      typeof cents === "number" && Number.isFinite(cents) ? cents : null,
    currency: typeof payload.currency === "string" ? payload.currency : null
  };
}

/** Title, body and primary label all turn on whether there is credit to spend. */
function describe(p: Payload) {
  if (!p.overagesEnabled) {
    return {
      title: "Fable 5 requires usage credits",
      body: "Fable 5 runs on usage credits, billed separately from your plan. You don't have usage credits yet.",
      primary: "Buy usage credits on claude.ai",
      blocked: true
    };
  }
  if (p.balanceCents !== null && p.balanceCents <= 0) {
    return {
      title: "Fable 5 requires usage credits",
      body: `Fable 5 runs on usage credits · you have ${money(0, p.currency)} in credits.`,
      primary: "Buy usage credits on claude.ai",
      blocked: true
    };
  }
  const balance =
    p.balanceCents !== null
      ? ` · you have ${money(p.balanceCents, p.currency)} in credits`
      : ", billed separately from your plan";
  return {
    title: "Continue on Fable 5 with usage credits?",
    body: `Fable 5 runs on usage credits${balance}. Your other models remain included in your plan.`,
    primary: "Continue with Fable 5",
    blocked: false
  };
}

interface Props {
  dialog: UserDialogView;
  /** `undefined` cancels — which is what this kind defaults to. */
  onRespond: (result?: "consent" | "switch_default") => void;
}

export function FableOverageDialog({ dialog, onRespond }: Props) {
  const payload = useMemo(() => read(dialog.payload), [dialog.payload]);

  // A payload we cannot read is one we cannot ask about. Cancelling frees the
  // turn; drawing a card with blanks in it would hold it for nothing. In an
  // effect, not in the render body — answering while rendering is a side
  // effect React is entitled to run twice.
  useEffect(() => {
    if (!payload) onRespond();
  }, [payload, onRespond]);

  if (!payload) return null;
  const { title, body, primary, blocked } = describe(payload);

  const consent = () => {
    // Blocked still consents: the reference opens the top-up page and answers
    // the same way, so the CLI stops waiting while the user goes to pay.
    if (blocked) send({ type: "openExternal", url: BUY_CREDITS });
    onRespond("consent");
  };

  return (
    <motion.div
      role="dialog"
      aria-label="Fable 5 usage credits"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onRespond();
        }
      }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={ENTER_CARD.transition}
      className={s.card}
    >
      <div className={s.head}>
        <span className={s.title}>{title}</span>
      </div>

      <p className={s.body}>
        {body}{" "}
        {/* Through the host, like every other outbound link here: a webview
            cannot reach the user's browser on its own. */}
        <button
          type="button"
          className={s.learnMore}
          onClick={() => send({ type: "openExternal", url: LEARN_MORE })}
        >
          Learn more
        </button>
      </p>

      <div className={s.actions}>
        <button type="button" onClick={() => onRespond()} className={s.dismiss}>
          Not now
        </button>
        <button
          type="button"
          onClick={() => onRespond("switch_default")}
          className={s.secondary}
        >
          Switch to the default model and continue
        </button>
        <button type="button" onClick={consent} className={s.primary}>
          {primary}
        </button>
      </div>
    </motion.div>
  );
}
