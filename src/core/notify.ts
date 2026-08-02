// ─────────────────────────────────────────────────────────────
// When a conversation is allowed to interrupt.
//
// Two channels, and the difference between them is the whole design:
//
// - **The badge** on the activity-bar icon. It never interrupts, it is always
//   there, and it asks for nothing. Every trigger raises it, and that half was
//   already built — see `attentionCounts` in `ui/conversation-registry.ts`.
// - **A toast**, which is loud. Loud is a budget, and this module is the thing
//   that spends it.
//
// **VS Code has no OS-notification API.** `inputNeededNotifEnabled` and its
// neighbours in Claude's settings schema are the CLI's own, for the terminal.
// A toast is an in-window banner and nothing more; promising anything else
// would be a lie told in a settings description.
//
// Pure, so the rule is testable without a window. Raising the banner is three
// lines in `ui/`, and there is nothing there worth a test.
// ─────────────────────────────────────────────────────────────

/** What is asking for the user. */
export type NotifyTrigger = "approval" | "question" | "turnFinished";

export interface NotifySwitches {
  /** A tool call is parked on an approval card. */
  approval: boolean;
  /** The model asked the user something. Its own switch because the CLI can
   *  time these out — a missed one does not just wait, it costs the answer. */
  question: boolean;
  /** A turn ended while the user was elsewhere. Off by default: most turns are
   *  short, and a banner for each would be the definition of noise. */
  turnFinished: boolean;
}

export const DEFAULT_NOTIFY: NotifySwitches = {
  approval: true,
  question: true,
  turnFinished: false
};

/**
 * How long a turn must have run before finishing it is worth a banner.
 *
 * **Measured, not chosen.** 33 226 turns reconstructed from 282 CLI transcripts
 * on this machine: p50 8s, p75 16s, p90 32s, p95 50s, p99 1.9min. A 30s line
 * would fire on 11.2% of turns — one in nine, which is noise wearing a
 * threshold's clothes. At 60s it is 3.6%, the tail rather than the body, and it
 * is also about where a person has genuinely gone to do something else.
 *
 * The real rate is lower still: this only applies when the panel is hidden.
 */
export const TURN_FINISHED_TOAST_MS = 60_000;

export interface NotifyContext {
  trigger: NotifyTrigger;
  /** Whether the user can see this conversation right now. */
  visible: boolean;
  switches: NotifySwitches;
  /** `turnFinished` only. How long the turn ran. */
  turnMs?: number;
  /** Shown in the banner so a person with several chats open knows which. */
  title?: string;
}

/**
 * The banner to raise, or `null` for silence.
 *
 * Silence is the default and every path back to it is deliberate: the user is
 * already looking, the switch is off, or the turn was too short to have been
 * walked away from.
 */
export function toastFor(ctx: NotifyContext): string | null {
  // Looking at it is being told. A banner over a card already on screen is an
  // interruption that informs nobody.
  if (ctx.visible) return null;
  if (!ctx.switches[ctx.trigger]) return null;

  const named = ctx.title?.trim();
  const which = named ? ` in “${named}”` : "";

  switch (ctx.trigger) {
    case "approval":
      return `LUNO is waiting for your approval${which}.`;
    case "question":
      return `LUNO is asking you something${which}.`;
    case "turnFinished": {
      if (!ctx.turnMs || ctx.turnMs < TURN_FINISHED_TOAST_MS) return null;
      return `LUNO finished${which} after ${humanDuration(ctx.turnMs)}.`;
    }
  }
}

/** Rounded the way a person would say it — nobody wants "63.4 seconds". */
export function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}
