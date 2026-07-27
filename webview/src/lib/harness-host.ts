// The fake host the browser harness answers with — see
// `scripts/webview-harness.mjs` and `.claude/skills/browser/SKILL.md`.
//
// It lives inside `webview/src` for one reason: this is the only tree the
// webview's `tsc --noEmit` walks, so typing the table against `Inbound` makes
// `bun run lint` the trip-wire for protocol drift. The harness used to carry a
// hand-copied table in a `.mjs` string that nothing checked, and it answered
// `requestHistory` with `entries` long after the protocol had renamed the field
// to `sessions` — the drawer read `undefined.length`, React unmounted the tree,
// and the harness looked like it "lost the page".
//
// Never imported by the app: it is not in the bundle graph, so vite drops it.

import type { Inbound, Outbound } from "./rpc";

const HOUR = 60 * 60 * 1000;

const NO_TOKENS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreatedTokens: 0,
  messages: 0
};

/**
 * What the fake host replies with, keyed by the message it is answering.
 *
 * A key mapped to `null` is answered with silence on purpose — the real host
 * stays quiet there too. A key absent from the table is unanswered by
 * omission, which is how a new request type shows up as a gap rather than as
 * an invented reply.
 *
 * `now` is passed in rather than read from the clock here so the table stays
 * pure data: the harness stamps it once when it starts serving.
 */
export function harnessReplies(
  now: number
): Partial<Record<Outbound["type"], Inbound | null>> {
  return {
    refreshAuth: {
      type: "auth",
      authed: true,
      model: "claude-opus-5",
      permissionMode: "default",
      effort: "high",
      thinking: true
    },
    refreshEditorContext: { type: "editorContext", context: null },
    requestModels: { type: "models", models: [] },
    // Two entries, not the whole catalogue: enough to drive the panel's three
    // states — offered, still being checked, and refused by the CLI.
    requestLegacyModels: {
      type: "legacyModels",
      models: [
        {
          value: "claude-opus-4-6",
          label: "Opus 4.6",
          note: "The last Opus on the old tokenizer",
          plus: "Older tokenizer, so the same text spends less of your quota",
          minus: "No xhigh, and it writes maths as LaTeX unless told otherwise",
          supportsTools: true,
          group: "version",
          effort: ["low", "medium", "high", "max"],
          available: true
        },
        {
          value: "claude-sonnet-4-5",
          label: "Sonnet 4.5",
          note: "The most written-about Sonnet",
          plus: "Most published prompts and recipes still target this one",
          minus: "Rejects --effort outright, so the effort control goes dark",
          supportsTools: true,
          group: "version",
          effort: [],
          available: false
        }
      ]
    },
    requestSkills: { type: "skills", skills: [] },
    requestHistory: { type: "historyList", sessions: [] },
    requestConnectors: { type: "connectorsList", connectors: [] },
    refreshUsage: {
      type: "claudeCodeUsage",
      session: {
        usage: NO_TOKENS,
        startedAt: now - HOUR,
        resetsAt: now + 4 * HOUR,
        authoritative: false
      },
      today: NO_TOKENS,
      week: NO_TOKENS,
      weekSonnet: NO_TOKENS,
      total: NO_TOKENS,
      generatedAt: now,
      available: true,
      limits: []
    }
  };
}
