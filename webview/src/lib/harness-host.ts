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

/** Enough of a count that the fallback rows have something to show. */
const SOME_TOKENS = {
  inputTokens: 412_900,
  outputTokens: 96_400,
  cacheReadTokens: 5_100_000,
  cacheCreatedTokens: 7_201_560,
  messages: 84
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
    // A fixed set, not a search: ranking is the host's job and is pinned by
    // `test/unit/mention-match.test.ts`. What the harness is for here is that
    // the two kinds render as two kinds. `id` is overwritten with the
    // request's by the dispatcher.
    requestFileSearch: {
      type: "fileSearchResults",
      id: "",
      results: [
        { path: "src/ui/", name: "ui", kind: "folder" },
        { path: "src/ui/domains/", name: "domains", kind: "folder" },
        { path: "src/ui/panel.ts", name: "panel.ts", kind: "file" },
        {
          path: "webview/src/features/chat/Composer.tsx",
          name: "Composer.tsx",
          kind: "file"
        }
      ]
    },
    // Two shapes, because the list renders them differently: a shell grant
    // shows the command prefix it is bounded by, and a tool grant has none.
    requestToolGrants: {
      type: "toolGrants",
      grants: [{ tool: "Bash", prefix: "bun run" }, { tool: "Write" }]
    },
    requestTerminals: {
      type: "terminalList",
      id: "",
      terminals: [
        { terminalName: "bash", commandLine: "bun run lint", exitCode: 2 },
        { terminalName: "pwsh", commandLine: "git push", exitCode: 0 },
        { terminalName: "watch", commandLine: "vite dev" }
      ]
    },
    requestHistory: { type: "historyList", sessions: [] },
    requestConnectors: { type: "connectorsList", connectors: [] },
    // Carries `utilization`, because that is what a logged-in account looks
    // like: the panel speaks in the server's percentages. Drop the field to
    // see the other half — token counts and no fraction, which is what an API
    // key or an unreachable endpoint gets.
    refreshUsage: {
      type: "claudeCodeUsage",
      session: {
        usage: SOME_TOKENS,
        startedAt: now - HOUR,
        resetsAt: now + 4 * HOUR,
        authoritative: true
      },
      today: SOME_TOKENS,
      week: SOME_TOKENS,
      weekSonnet: NO_TOKENS,
      total: SOME_TOKENS,
      generatedAt: now,
      available: true,
      limits: [],
      utilization: {
        fetchedAt: now - 90_000,
        plan: "max20",
        tier: "default_claude_max_20x",
        limits: [
          {
            kind: "session",
            group: "session",
            percent: 22,
            severity: "normal",
            resetsAt: now + 1.6 * HOUR,
            isActive: true
          },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 4,
            severity: "normal",
            resetsAt: now + 129 * HOUR,
            isActive: false
          },
          // No reset time, exactly as the account reports a scoped limit it has
          // not touched. The row must not invent one.
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 0,
            severity: "normal",
            resetsAt: 0,
            scopeLabel: "Fable",
            isActive: false
          }
        ]
      }
    }
  };
}
