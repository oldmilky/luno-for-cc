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
    // All three sources, because the empty state treats them differently: the
    // first two become its Project and Personal groups and the `cli` entry
    // must not appear at all — with plugins installed that list runs to
    // hundreds of names and carries no description for any of them.
    requestSlashCommands: {
      type: "slashCommands",
      commands: [
        {
          name: "check",
          source: "project",
          description:
            "Fast read-only review of the uncommitted working tree. Use when the user says /check, or mid-feature before committing."
        },
        {
          name: "browser",
          source: "project",
          description:
            "Verify or measure the webview in a real browser. Use when the user says /browser, or whenever a UI claim needs evidence."
        },
        {
          name: "ship",
          source: "project",
          description:
            "Full delivery pipeline for non-trivial work — plan, implement, gates, browser evidence, independent review, report."
        },
        {
          name: "start",
          source: "user",
          description:
            "Load project context at the start of a session and report a compact brief."
        },
        { name: "brainstorming", source: "user" },
        { name: "marketing-skills:ads", source: "cli" }
      ]
    },
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
          path: "webview/src/features/chat/composer/Composer.tsx",
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
    // One rule per source and one per kind, plus both failure notes — the
    // combinations that decide how the list reads, which is the only way to
    // check them without four settings files on the machine running the
    // harness.
    requestPermissionRules: {
      type: "permissionRules",
      rules: [
        {
          source: "managed",
          kind: "deny",
          rule: "Bash(curl:*)",
          file: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
          line: 4
        },
        {
          source: "project",
          kind: "ask",
          rule: "Bash(git push:*)",
          file: "/work/app/.claude/settings.json",
          line: 7
        },
        {
          source: "local",
          kind: "allow",
          rule: "Bash(bun run lint)",
          file: "/work/app/.claude/settings.local.json",
          line: 3
        },
        {
          source: "user",
          kind: "allow",
          rule: "mcp__context7__query-docs",
          file: "/home/rodion/.claude/settings.json"
        }
      ],
      unreadable: [
        {
          source: "project",
          file: "/work/app/.claude/settings.json",
          reason: "Unexpected token } in JSON at position 118"
        }
      ],
      cannotRead: [
        "Windows Group Policy (HKLM and HKCU \\SOFTWARE\\Policies\\ClaudeCode)"
      ]
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
    // The drawer had no rows here at all, so neither the order nor the buckets
    // could be looked at. `agents` is the row that earns its place: that chat
    // is busy *now* and still sits where the user last wrote in it, which is
    // what ordering on `lastUserAt` is for.
    requestHistory: {
      type: "historyList",
      sessions: [
        {
          id: "h-composer",
          title: "The composer eats a trailing newline",
          snippet:
            "The composer eats a trailing newline when a mention is the last thing typed",
          createdAt: now - 5 * HOUR,
          lastUserAt: now - 4 * 60_000,
          eventCount: 118,
          status: "needs-you",
          open: true
        },
        {
          id: "h-refactor",
          title: "Refactoring",
          named: true,
          snippet: "Split claude-cli.ts along the control channel",
          createdAt: now - 30 * HOUR,
          lastUserAt: now - 3 * HOUR,
          eventCount: 1188,
          status: "agents",
          open: false
        },
        {
          id: "h-history-order",
          title: "Order the history list on my last message",
          snippet: "",
          createdAt: now - 9 * HOUR,
          lastUserAt: now - 8 * HOUR,
          eventCount: 91,
          status: "done",
          open: false
        },
        {
          id: "h-modal",
          title: "The overlay primitive owns Escape now",
          snippet:
            "Thirteen overlays, one key handler, and a drawer that backs out one step",
          createdAt: now - 40 * HOUR,
          lastUserAt: now - 26 * HOUR,
          eventCount: 683,
          status: "interrupted",
          open: false
        },
        {
          id: "h-tokens",
          title: "Plan caps in the meter are guesses",
          snippet: "PLAN_PRESETS hard-codes quotas Anthropic does not expose",
          createdAt: now - 100 * HOUR,
          lastUserAt: now - 96 * HOUR,
          eventCount: 1413,
          status: "failed",
          open: false
        }
      ]
    },
    // One of each state the modal groups on, because the split is the whole
    // question: connected, errored, custom-and-down, imported from Claude
    // Code, and three the user has never touched.
    requestConnectors: {
      type: "connectorsList",
      connectors: [
        {
          id: "figma",
          name: "Figma",
          vendor: "Figma",
          description: "Read designs and write code back into a file.",
          transport: "streamable-http",
          categories: ["design"],
          icon: "edit",
          builtIn: true,
          status: "connected",
          connectedAt: now - 3 * HOUR,
          toolCount: 27
        },
        {
          id: "linear",
          name: "Linear",
          vendor: "Linear",
          description: "Issues, projects and cycles.",
          transport: "streamable-http",
          categories: ["project"],
          icon: "layers",
          builtIn: true,
          status: "disconnected",
          toolCount: 0
        },
        {
          id: "sentry",
          name: "Sentry",
          vendor: "Sentry",
          description: "Errors and traces from your deployed services.",
          transport: "streamable-http",
          categories: ["observability"],
          icon: "danger",
          builtIn: true,
          status: "error",
          lastError: "401 from the token endpoint",
          toolCount: 0
        },
        {
          id: "notion",
          name: "Notion",
          vendor: "Notion",
          description: "Pages and databases from your workspace.",
          transport: "streamable-http",
          categories: ["docs"],
          icon: "book",
          builtIn: true,
          status: "disconnected",
          toolCount: 0
        },
        {
          id: "slug-a1b2c3",
          name: "my-api",
          vendor: "Custom",
          description: "An internal server added by URL.",
          url: "https://mcp.internal.example/sse",
          transport: "sse",
          categories: [],
          icon: "plug",
          builtIn: false,
          status: "disconnected",
          toolCount: 0
        },
        {
          id: "managed:user:gitlab",
          name: "gitlab",
          vendor: "Claude Code",
          description: "Imported from your Claude Code config.",
          transport: "stdio",
          command: "npx -y @gitlab/mcp",
          categories: [],
          icon: "branch",
          builtIn: true,
          status: "connected",
          managed: true,
          scope: "user",
          toolCount: 92
        }
      ]
    },
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
