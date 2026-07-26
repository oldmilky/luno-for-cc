// ─────────────────────────────────────────────────────────────
// WelcomeScreen — automated Claude.ai Subscription sign-in.
//
// Click "Sign in with Claude" → host spawns the bundled
// `claude setup-token`, captures its stdout, opens the OAuth URL
// in the user's default browser via vscode.env.openExternal, and
// stores the emitted token in SecretStorage. The UI tracks each
// stage in real time via `setupProgress` events.
//
// If the auto-flow errors out (rare — typically a missing binary or
// a stale OAuth state), a manual paste fallback is one disclosure
// click away.
// ─────────────────────────────────────────────────────────────

import { KeyboardEvent, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Orb, Spinner } from "../../design/primitives";
import { Icon, BrandMark } from "../../design/icons";
import {
  ENTER,
  ENTER_CARD,
  EXPAND,
  SPRING_POP,
  TRAVEL,
  enterAt,
  stagger
} from "../../design/motion";
import { send, onMessage } from "../../lib/rpc";
import s from "./WelcomeScreen.module.scss";

type SetupStage =
  | "idle"
  | "launching"
  | "awaitingBrowser"
  | "saving"
  | "done"
  | "error";

type TokenKind = "oauth" | "api" | "unknown" | "empty";

export function WelcomeScreen() {
  const [stage, setStage] = useState<SetupStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);

  // Subscribe to host's setup + manual-paste progress events.
  useEffect(() => {
    return onMessage((m) => {
      if (m.type === "setupProgress") {
        setStage(m.stage);
        if (m.stage === "error") {
          setError(m.error ?? "Sign-in failed.");
        } else {
          setError(null);
        }
      } else if (m.type === "tokenResult") {
        setManualSubmitting(false);
        if (m.ok) {
          setError(null);
          setManualToken("");
        } else {
          setError(m.error ?? "Token rejected.");
        }
      }
    });
  }, []);

  const handleAutoSignIn = () => {
    setError(null);
    setStage("launching");
    send({ type: "startClaudeSetup" });
  };

  const handleCancel = () => {
    send({ type: "cancelClaudeSetup" });
    setStage("idle");
  };

  const handleConfirmSignedIn = () => {
    send({ type: "confirmClaudeSetup" });
  };

  const handleManualSubmit = () => {
    const t = manualToken.trim();
    if (!t || manualSubmitting) return;
    setManualSubmitting(true);
    setError(null);
    send({ type: "submitToken", token: t });
  };

  const onManualKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleManualSubmit();
    }
  };

  const manualKind = classify(manualToken);
  const manualValid = manualKind === "oauth" || manualKind === "api";

  // The screen reveals on a single stagger ladder — hero (0), card (1),
  // disclosure (2), footnote (3) — so the four arrivals read as one sweep
  // instead of four independently tuned fades.
  return (
    <motion.div
      className={s.screen}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // Opacity only: every child carries its own rise, and giving the
      // container one too would double the travel. ENTER's timing, no `y`.
      transition={ENTER.transition}
    >
      {/* Ambient copper glow */}
      <div className={s.glow} aria-hidden />

      {/* Hero */}
      <motion.div className={s.hero} {...ENTER_CARD}>
        <Orb size={68} />
        <h1 className={s.heroTitle}>Welcome to Luno</h1>
        <p className={s.heroSub}>
          Agentic coding for VS Code — powered by your Claude Code subscription.
        </p>
      </motion.div>

      {/* Main card */}
      <motion.div
        className={s.card}
        {...ENTER_CARD}
        // The card has always settled from 0.99 → 1 as it lands. That scale is
        // design, not timing, so it stays — everything else comes from the preset.
        initial={{ ...ENTER_CARD.initial, scale: 0.99 }}
        animate={{ ...ENTER_CARD.animate, scale: 1 }}
        transition={{ ...ENTER_CARD.transition, delay: stagger(1) }}
      >
        {/* Header */}
        <div className={s.cardHead}>
          <div className={s.brandTile} aria-hidden>
            <BrandMark size={15} />
          </div>
          <span className={s.cardTitle}>
            Sign in with Claude.ai Subscription
          </span>
          <span className={s.cardBadge}>Pro · Team · Enterprise</span>
        </div>

        {/* Body */}
        <div className={s.cardBody}>
          <AnimatePresence mode="wait" initial={false}>
            {stage === "idle" && (
              <motion.div key="idle" {...fade}>
                <p className={s.lede}>
                  We'll open a terminal that runs <code className={s.code}>claude setup-token</code>. Follow the prompts to sign in
                  via your browser, then come back here.
                </p>
                <button
                  type="button"
                  onClick={handleAutoSignIn}
                  className={s.primary}
                >
                  <Icon name="sparkle" size={13} />
                  Sign in with Claude
                </button>
              </motion.div>
            )}

            {(stage === "launching" ||
              stage === "awaitingBrowser" ||
              stage === "saving") && (
              <motion.div key="progress" {...fade}>
                <ProgressList stage={stage} />
                {stage === "awaitingBrowser" && (
                  <motion.div {...ENTER} className={s.terminalHint}>
                    <p className={s.terminalHintText}>
                      Complete the sign-in in the{" "}
                      <span className={s.terminalHintStrong}>Luno Sign-in</span>{" "}
                      terminal at the bottom — open the URL it prints, then
                      paste the code back into the terminal. Click below once
                      it says you're signed in.
                    </p>
                    <button
                      type="button"
                      onClick={handleConfirmSignedIn}
                      className={s.confirm}
                    >
                      I've signed in — continue
                    </button>
                  </motion.div>
                )}
                <button
                  type="button"
                  onClick={handleCancel}
                  className={s.cancel}
                >
                  Cancel
                </button>
              </motion.div>
            )}

            {stage === "done" && (
              <motion.div key="done" {...fade}>
                <div className={s.done}>
                  <div className={s.doneCheck}>
                    <Icon name="check" size={16} />
                  </div>
                  <p className={s.doneTitle}>Signed in</p>
                  <p className={s.doneSub}>Loading your workspace…</p>
                </div>
              </motion.div>
            )}

            {stage === "error" && (
              <motion.div key="error" {...fade}>
                <div className={s.errorBox}>
                  <div className={s.errorHead}>
                    <Icon name="x" size={11} />
                    Sign-in failed
                  </div>
                  {error ?? "Unknown error."}
                </div>
                <button
                  type="button"
                  onClick={handleAutoSignIn}
                  className={s.retry}
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => setManualOpen(true)}
                  className={s.manualLink}
                >
                  Paste a token manually
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {/* Manual paste fallback — collapsed by default, revealed on
          demand from the idle screen or auto-revealed from an error. */}
      <AnimatePresence initial={false}>
        {(manualOpen || stage === "error") && (
          <motion.div key="manual" {...EXPAND} className={s.manualWrap}>
            <div className={s.manualCard}>
              <div className={s.manualTitle}>
                <Icon name="code" size={12} />
                Paste a token manually
              </div>
              <p className={s.manualNote}>
                Use an OAuth token from{" "}
                <code className={s.code}>claude setup-token</code>{" "}
                or an Anthropic Console API key (
                <code className={s.code}>sk-ant-api…</code>).
              </p>
              <input
                type="password"
                spellCheck={false}
                placeholder="sk-ant-oat… or sk-ant-api…"
                value={manualToken}
                onChange={(e) => {
                  setManualToken(e.target.value.replace(/\s+/g, ""));
                  if (error) setError(null);
                }}
                onKeyDown={onManualKey}
                disabled={manualSubmitting}
                className={s.manualInput}
              />
              {manualToken && (
                <div
                  className={`${s.detect} ${
                    manualValid ? s.detectOk : s.detectWarn
                  }`}
                >
                  <Icon name={manualValid ? "check" : "shield"} size={10} />
                  {manualKind === "oauth" && "OAuth subscription token detected"}
                  {manualKind === "api" && "Anthropic Console API key detected"}
                  {manualKind === "unknown" &&
                    "Unrecognized format — should start with sk-ant-…"}
                </div>
              )}
              <button
                type="button"
                onClick={handleManualSubmit}
                disabled={!manualValid || manualSubmitting}
                className={s.manualSubmit}
              >
                {manualSubmitting ? "Signing in…" : "Sign in with token"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Disclosure button for manual paste — only on idle screen */}
      {stage === "idle" && !manualOpen && (
        <motion.button
          type="button"
          onClick={() => setManualOpen(true)}
          className={s.disclosure}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          // Rung 2. Opacity only — this line sits tight under the card and
          // must not move, so it takes ENTER's timing without ENTER's rise.
          transition={enterAt(2).transition}
        >
          Already have a token? Paste it manually →
        </motion.button>
      )}

      {/* Footnote */}
      <motion.div
        className={s.foot}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        // Rung 3, last in. Opacity only, same reason as the disclosure above.
        transition={enterAt(3).transition}
      >
        Token is stored in VS Code's SecretStorage (OS keychain).
        <br />
        Luno never writes to <code className={s.footCode}>~/.claude/</code>.
      </motion.div>
    </motion.div>
  );
}

// ─────────────────── Progress list ───────────────────

function ProgressList({ stage }: { stage: SetupStage }) {
  const items: Array<{
    key: SetupStage;
    title: string;
    sub: string;
  }> = [
    {
      key: "launching",
      title: "Opening terminal",
      sub: "Starting `claude setup-token` in a new terminal…"
    },
    {
      key: "awaitingBrowser",
      title: "Sign in via terminal",
      sub: "Follow the prompts in the terminal at the bottom."
    },
    {
      key: "saving",
      title: "Finishing up",
      sub: "Activating your Claude credentials…"
    }
  ];

  const stageIndex = items.findIndex((it) => it.key === stage);

  return (
    <div className={s.progress}>
      {items.map((it, i) => {
        const state: "pending" | "active" | "done" =
          i < stageIndex ? "done" : i === stageIndex ? "active" : "pending";
        return <ProgressRow key={it.key} state={state} title={it.title} sub={it.sub} />;
      })}
    </div>
  );
}

function ProgressRow({
  state,
  title,
  sub
}: {
  state: "pending" | "active" | "done";
  title: string;
  sub: string;
}) {
  return (
    <div className={s.row}>
      <div className={s.rowIcon}>
        {state === "done" && (
          <motion.span
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={SPRING_POP}
            className={s.rowDone}
          >
            <Icon name="check" size={11} />
          </motion.span>
        )}
        {state === "active" && <Spinner size={16} />}
        {state === "pending" && <span className={s.rowDot} aria-hidden />}
      </div>
      <div className={s.rowText}>
        <div
          className={`${s.rowTitle} ${
            state === "pending" ? s.rowTitlePending : ""
          }`}
        >
          {title}
        </div>
        <div className={s.rowSub}>{sub}</div>
      </div>
    </div>
  );
}

// ─────────────────── Helpers ───────────────────

function classify(token: string): TokenKind {
  const t = token.trim();
  if (!t) return "empty";
  if (t.startsWith("sk-ant-oat")) return "oauth";
  if (t.startsWith("sk-ant-api")) return "api";
  return "unknown";
}

/** Stage swap inside the auth card. ENTER carries the arrival; the upward
 *  exit is kept as-is because `AnimatePresence mode="wait"` needs one and
 *  ENTER has none of its own. */
const fade = {
  ...ENTER,
  exit: { opacity: 0, y: -TRAVEL.sm }
} as const;
