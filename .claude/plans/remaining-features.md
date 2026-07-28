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

## 2. Permissions cannot be granted permanently from the UI — **DONE 2026-07-28**

An approval card now offers **Always** beside Deny / Allow, and the header's
shield opens the list of what has been granted, with revoke and revoke-all.

**Where they live: `globalState`, in force in every folder the user opens.**
That was chosen deliberately over per-workspace, and it is the riskier of the
two — a grant made in your own repository applies inside a clone of someone
else's. Two things answer for it, and neither is decoration: the list says so
in running text above itself, and the gate below still runs first.

**A grant is checked inside the branch the destructive/network gate already
declined.** That ordering is the whole safety argument, so it is pinned by
tests rather than left to a comment: `Bash(rm …)` cannot be granted, a granted
`Bash(bun run …)` does not cover `bun run lint && rm -rf /`, and a grant naming
`curl` still prompts.

Two decisions worth keeping:

- **The grant is a tool plus the leading words of its command**, not a tool
  name. "Always allow Bash" is a permission mode wearing a disguise. A composed
  command (pipe, chain, redirect, substitution, leading assignment) is offered
  no grant at all — the user is looking at one card describing several
  commands, and no single prefix describes what they would be agreeing to.
- **The button's wording is computed host-side** (`grantLabel` on the request
  payload) rather than derived in the webview, so the button cannot promise
  something other than what gets stored. The host also re-derives the grant
  from the request it is answering rather than taking the panel's word for it.

Where it lives: `src/core/tool-grants.ts` (pure, tested), the `grants` branch
of `decidePermission`, `src/ui/domains/tool-grants.ts` (storage),
`PermissionsModal.tsx` + the shield in `Header.tsx`.

`luno.allowedBashPatterns` is untouched and still the hand-edited allowlist it
always was; the two do not know about each other, which is worth knowing before
anyone tries to unify them.

Note before touching any of this: LUNO's permission design is deliberately stricter
than upstream — `auto` maps to the CLI's `default` rather than `acceptEdits`,
and destructive/network calls are never auto-allowed even when they match the
allowlist. Read `decidePermission` and the destructive/network gate in
`src/providers/claude-cli.ts` before changing any of it. That strictness is a
decision, not an oversight.

## 3. `@` mentions: folders and fuzzy matching — **DONE 2026-07-28**

Folders come out of the same `git ls-files` output the files do
(`foldersFromPaths`), and ranking moved to `src/core/mention-match.ts` where it
can be tested: filename prefix → filename substring → filename subsequence →
path substring → path subsequence, ties broken on path length. That last
tie-break is what lifts `src/ui/` above the files inside it without a rule
saying so.

Two things this cost:

- **The query can no longer filter the listing.** `listTrackedFiles` used to
  keep only `name.includes(query)`, which decided the answer before the ranker
  was asked — a subsequence hit was thrown away before it could be scored. It
  now lists everything (bounded at 20 000 paths) and the ranker cuts to 12.
- **A folder cannot serialize as its basename.** The mention pill flattened to
  `@name`, which for a folder names every `utils` in the tree. Pills now carry
  an optional `data-token`; a folder's is its whole path with the trailing
  slash, and files are unchanged.

Subsequence matching is gated at 2 characters on a filename and 3 on a path:
below that every path in a repository matches and the exact hits are buried.

## 4. `@terminal:` — terminal output into the prompt — **DONE 2026-07-28**

`@terminal:<name>` in a prompt is replaced with that terminal's last run —
command, exit code and output — before the turn goes out. The expansion is
inline in the turn text, so the timeline holds what the model was actually
shown rather than a token that resolves to nothing tomorrow.

**The API constraint is the whole design, and it is worth reading before
changing any of this.** `TerminalShellExecution.read()` yields only what is
written _after_ the first call, and nothing exposes a terminal's scrollback. So
this is a recorder, not a reader: `registerTerminalCapture()` subscribes at
activation and keeps the last finished run per terminal. Two consequences that
look like bugs and are not — commands run before LUNO activated are absent, and
a terminal without shell integration (cmd.exe, a shell whose script did not
load) never fires the events at all. The popover's empty state says so rather
than implying nothing ran.

The raw stream is escape codes by weight; `src/core/terminal-output.ts` strips
CSI/OSC, keeps the tail at 8 000 characters and says when it truncated.
Off via `luno.terminalCapture`.

## 5. URI handler — **DONE 2026-07-28**

`vscode://<publisher>.<name>/open?prompt=…` puts the prompt in the composer and
focuses it. **It does not send.** A link on any web page must not be able to
start a turn in an extension that spawns processes and holds a subscription
credential, and the person at the keyboard pressing send is the whole gate —
`decidePermission` guards tools, not the decision to run a turn at all.

Parsing is in `src/core/open-uri.ts` so the editor half has nothing to get
wrong: unknown paths are ignored, control characters are stripped (a URI can
carry an ANSI escape, and the composer renders what it is handed), and the
prompt is capped at 4 000 characters. `session=` is **not** implemented — it was
in the upstream shape this entry named, and nothing in LUNO maps to it yet.

## 6. `useCtrlEnterToSend` — **DONE 2026-07-28**

`luno.useCtrlEnterToSend`, default off. On, Enter breaks the line and
Ctrl/Cmd+Enter sends. Both modifiers are accepted rather than switching on the
platform: the webview cannot see which key the user calls Cmd, and offering the
wrong one is a message that will not go.

It arrives over a new `settings` message and a small store
(`webview/src/lib/settings.ts`) rather than as a prop: the composer sits three
components below the message handler and the inline edit composer sits
elsewhere entirely. `KeyboardHints` reads the same store — a panel advertising
`↵ Send` while the setting moved it would be teaching a shortcut that does
nothing.

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

- **39 files carry phase labels** (`Ф2а`, `Ф1`, `Ф0`) in comments, pointing at a
  document that is not in the published repository. Worth a scripted pass with
  the gates behind it, not a hand edit. See `.claude/rules/comments.md`. All of
  them are now in `webview/src` — `src/` is clear, and `docs/PLAN.md` still
  says 53.
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
