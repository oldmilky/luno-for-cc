# Remaining features — what LUNO still does not do

Written for whoever picks this up in a fresh session. It is a work list, not a
wish list: every entry says what is missing, why it matters, where to start, and
how big it is. Entries were checked against the code on 2026-07-27 — re-check
before trusting one, since this file cannot know what landed after it.

The list came out of two audits against `anthropic.claude-code` 2.1.220 plus
first-hand probing of the CLI. The audits themselves live outside the repository
(`~/.claude/plans/eager-scribbling-storm.md` and
`enchanted-meandering-pinwheel.md` on Rodion's machine); what survived of them
is below, corrected where the code disagreed with them.

## Already done — do not re-open these

Closed over 2026-07-27, listed because both audits still name several of them as
open: the `luno.chatFocused` context key (Shift+Tab could not fire at all),
`luno.maxTokens` (read and ignored), the dead base system prompt, checkpoint
persistence across a reload, `@`-mention paths inside a worktree, a
non-destructive rewind that keeps the discarded branch, `test/` inside the type
gate, editor diagnostics and the selection reaching the model, autosave,
`.gitignore` in file search, an output channel with `LUNO: Show Logs`, declared
workspace trust, the slash-command popover, and the compaction marker with a
context-window row. Anything above that still looks broken is a regression, not
a gap.

## Read this first: what the CLI already does for us

This is the most expensive thing in this document. Three times now a feature
looked like weeks of work and turned out to be a UI job, because the CLI already
does the hard half. **Probe before designing.** All of the following was
verified against 2.1.219 by driving the real binary, not read from docs.

**Slash commands expand themselves.** Sending `{"type":"user","message":
{"role":"user","content":"/mycommand"}}` over stream-json input makes the CLI
resolve it — a custom command came back as a `Skill` tool call with the
extension doing nothing. The prompt text goes out untouched. The CLI also
reports every command it knows on each turn's `init` event, as
`slash_commands: string[]`.

**Subagents already run.** The CLI dispatches, executes and reports them. See
the stream map in item 1.

**Auto-compaction already happens.** The CLI folds the conversation when the
context approaches the window — with a reserve, not at the boundary: the
threshold is `window − round(window × precomputeBufferFraction)`. Overridable
through its own env vars: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`.

**The CLI will not answer before it is asked.** Held open with stdin attached
and nothing written, it emits no `init` for at least 35 seconds. Anything you
want from `init` — the command list, the model, the session id — arrives no
earlier than the first turn, so cache it.

**Useful numbers already in the stream.** `result.modelUsage[model]
.contextWindow` is the real window (1,000,000 for `claude-opus-5[1m]`).
Context size is `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` — the same sum the CLI uses to decide when to compact.
Cached tokens must be counted: they are most of a long conversation's prompt.

**How to probe.** Write one stream-json line to stdin, read stdout, kill when
you have what you need:

```bash
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n' \
  | claude -p --input-format stream-json --output-format stream-json \
           --verbose --max-turns 3 > out.jsonl
```

Then group the events by `type`/`subtype` before reading any of them in full.

---

## 1. Subagents — visibility — **DONE 2026-07-27**

Shipped as a card per agent: type, task, live status, step count, duration, and
the answer behind a disclosure. Nested tool calls are deliberately not routed —
`task_progress` reports `tool_uses` and `last_tool_name`, which is enough to
tell a working agent from a wedged one without a second timeline inside the
first.

Where it lives: `taskUpdate` + the parent guard in `src/providers/claude-cli.ts`,
`SubagentTask` in `src/core/types.ts`, `onSubagentUpdate` / `sweepLiveTasks` in
`src/ui/conversation-host.ts`, `subagent-state.ts` + `SubagentCard.tsx` in the
webview.

Two things this document had wrong, both found by probing 2.1.220 rather than
reading the earlier capture:

- **`system/task_progress` exists** and was not listed here. It is the useful
  one: `{usage:{total_tokens, tool_uses, duration_ms}, last_tool_name}` plus a
  `description` that holds what the agent is doing _right now_ — the same field
  name `task_started` uses for the fixed task label. Merging the two in place
  leaves a finished card reading "Searching for…", so they are kept apart as
  `description` and `activity`.
- **The `parent_tool_use_id` gap was live, not theoretical.** This file said it
  "has not bitten yet". In the probe the subagent's `assistant` event carried a
  real `tool_use` block, so the nested Grep was being emitted as a
  `tool_use_start` and rendered on the main timeline as the top-level model's
  own tool call. `classifyTool` also matched only `task`, never the `Agent` the
  CLI actually sends, so a dispatch showed up as "Ran 1 tool".

`task_updated` carries neither `tool_use_id` nor a top-level status — its status
sits in `patch` — which is why the host keeps a task-id map and closes the card
on `task_notification`, the only phase with the summary. Anything still open
when the turn ends is swept: the CLI process does not outlive the turn.

## 2. Permissions cannot be granted permanently from the UI

**Size: medium.** `webview/src/features/chat/PermissionRequest.tsx` offers
Deny / Allow this turn / Allow, and "this turn" only appears when the CLI sent a
`setMode` suggestion. There is no "always allow this tool", no list of what has
been granted, and nothing to revoke. The only durable allowlist is
`luno.allowedBashPatterns`, editable by hand in settings.json.

Note before touching this: LUNO's permission design is deliberately stricter
than upstream — `auto` maps to the CLI's `default` rather than `acceptEdits`,
and destructive/network calls are never auto-allowed even when they match the
allowlist. Read `decidePermission` and the destructive/network gate in
`src/providers/claude-cli.ts` before changing any of it. That strictness is a
decision, not an oversight.

## 3. `@` mentions: folders and fuzzy matching

**Size: small.** Files only today. Upstream supports `@src/components/` with a
trailing slash, and fuzzy matching; LUNO ranks prefix over substring and stops
there. `searchFiles` in `src/ui/domains/files.ts` already lists through
`git ls-files`, so folders are derivable from the same output.

## 4. `@terminal:` — terminal output into the prompt

**Size: small–medium.** Zero occurrences in the codebase. Terminals are used
only for LUNO's own errands (`src/ui/domains/terminal.ts`). Needs the VS Code
shell-integration API to read a terminal's output.

## 5. URI handler

**Size: small.** `registerUriHandler` appears nowhere. Upstream exposes
`vscode://anthropic.claude-code/open?prompt=…&session=…`, which is how people
wire the extension into other tools. Without it there is no integration path at
all.

**Security note:** this is a new entry point into an extension that holds a
subscription credential and spawns processes. Whatever it accepts must go
through the same gate as everything else — see `decidePermission`.

## 6. `useCtrlEnterToSend`

**Size: trivial.** A setting to require Ctrl+Enter to send. Common request from
people who type multi-line prompts.

## 7. Plan caps in the meter are still guesses

**Size: small, but needs a decision.** `PLAN_PRESETS` in
`webview/src/features/chat/TokenMeter.tsx` hard-codes per-plan quotas because
Anthropic does not expose the user's real limits to clients. The reset times are
authoritative now (from the CLI's `rate_limit_event`) and so is the context row,
but the percentages are still measured against invented numbers.

Options: label them as estimates more loudly, or drop the percentage and show
absolute usage only. Either is honest; the current mix is the problem.

## 8. Third-party providers (Bedrock / Vertex / Foundry)

**Size: unknown, possibly large.** Zero occurrences. Upstream documents a path
through `disableLoginPrompt` plus `~/.claude/settings.json`. For a corporate
user on Bedrock, LUNO simply does not start. This is the one item on the
"deliberately not chasing" list that deserves a real decision rather than a
default no.

## 9. Housekeeping

- **42 files carry phase labels** (`Ф2а`, `Ф1`, `Ф0`) in comments, pointing at a
  document that is not in the published repository. Worth a scripted pass with
  the gates behind it, not a hand edit. See `.claude/rules/comments.md`.
- **`docs/PLAN.md` is stale** — its "Open, in rough order" list has items 1 and
  2 already done. It is gitignored, so it is working notes, but it misleads.
- **Light palette variants (Ф2б)** — the oldest unchecked box. Large: `--lift`
  moves borders, tints, glass and shadows at once, so it needs a contrast pass
  across all seven palettes.
- **README screenshots** — five were deleted and never re-shot. Deliberately
  deferred until the functional layer settles; `.vscodeignore` already keeps
  images out of the VSIX.

## Deliberately not chasing

Recorded so nobody re-derives the question: the Web tab with cloud sessions,
`/plugins` with its three install scopes, `@browser` (needs the Chrome
extension), bundling the CLI inside the VSIX, Open VSX. Each is either tied to
Anthropic infrastructure or contradicts the decision that the binary is found
rather than shipped.

**Remote Control was on this list and is not any more** — decided 2026-07-27.
It stays tied to Anthropic infrastructure, and that is accepted rather than
worked around: it needs a claude.ai OAuth login, refuses to run under an API
key, and keeps the session transcript on Anthropic servers. See
`.claude/plans/remote-control.md`.

Terminal mode (`useTerminal`) and Jupyter (`mcp__ide__executeCode`) are also
absent. Both are plausible, neither has been asked for.

## Where LUNO is ahead

Keep these in view when weighing "parity" work — the product is not a clone.
Plans as a real artifact with comment threads and per-step accept/modify/skip;
a git worktree per conversation; per-conversation model, mode and effort; the
MCP connector flow with full OAuth 2.1 + PKCE; the skills marketplace;
`--effort`; `Generate CLAUDE.md`; seven themes.
