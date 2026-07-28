# Subagents and workflows — audit

**Written 2026-07-28.** Every claim below was measured, not read: two real
workflow runs driven through `claude.exe` 2.1.219 with the raw stream captured,
plus the shipped `anthropic.claude-code` 2.1.220 bundles read directly
(`webview/index.js`, `extension.js`) and Anthropic's own typed contract
(`@anthropic-ai/claude-code/sdk-tools.d.ts`, 3807 lines).

Companion to [one-process-per-conversation.md](./one-process-per-conversation.md),
which already names the architectural half of this. That plan is still right.
This document is the part it does not cover: **workflows are not subagents**, and
LUNO currently treats them as if they were.

## The wire truth

`Workflow` is not a tool that runs and returns. It **launches** and returns
immediately:

```jsonc
// tool_result, ~1s after the call
{
  "status": "async_launched",
  "taskId": "whzxe4yej",
  "taskType": "local_workflow",
  "workflowName": "probe",
  "runId": "wf_a63f34c1-c94",
  "transcriptDir": "…",
  "scriptPath": "…"
}
```

`WorkflowOutput.status` is `"async_launched" | "remote_launched"` — there is no
synchronous branch (`sdk-tools.d.ts:3735`). What follows arrives over `system`
events, and the full observed sequence for one workflow with one agent is:

| #   | Event                                  | Carries                                                          |
| --- | -------------------------------------- | ---------------------------------------------------------------- |
| 1   | `system/background_tasks_changed`      | `tasks: [{task_id, task_type, description}]` — the live roster   |
| 2   | `system/task_started`                  | `task_type:"local_workflow"`, `workflow_name`, `prompt` = script |
| 3   | `system/task_progress` ×4              | `usage`, `last_tool_name`, **`workflow_progress[]`**             |
| 4   | `system/background_tasks_changed`      | `tasks: []` — roster now empty                                   |
| 5   | `system/task_updated`                  | `patch: {status:"completed", end_time}`                          |
| 6   | `system/task_notification`             | `status`, `output_file`, `summary`, `usage`                      |
| 7   | `result`                               | the turn that _launched_ it ends here                            |
| 8   | `system/init` → `assistant` → `result` | **a second turn**, `origin: {kind:"task-notification"}**         |

Step 8 is the one that matters and the one LUNO throws away. The CLI queues a
synthetic `<task-notification>` prompt, starts a fresh turn against it, and the
model reports the outcome — `"Workflow completed. Result: {\"a\":\"OK\"} ✓"`.
That sentence is the entire user-visible payoff of running a workflow.

`workflow_progress` is the structure nothing in LUNO knows about:

```jsonc
[
  { "type": "workflow_phase", "index": 1, "title": "One" },
  {
    "type": "workflow_agent",
    "index": 1,
    "label": "…",
    "phaseIndex": 1,
    "phaseTitle": "One",
    "agentId": "a0a43870db569a0b1",
    "model": "claude-haiku-4-5-20251001",
    "state": "done",
    "tokens": 19210,
    "toolCalls": 0,
    "durationMs": 5580,
    "resultPreview": "OK"
  }
]
```

One entry per phase and per agent, with live `state`. It is a whole progress UI
already computed for us, dropped on the floor.

## What the official extension does

Read from the shipped bundle, not inferred.

**It renders no workflow UI at all.** `handleTaskStarted` opens with
`if (t.task_type !== "local_agent") return` — workflows, remote agents and
monitors never reach the card layer. The only string match for "workflow" in
`webview/index.js` is a PowerShell keyword inside Monaco.

**It never handles `task_updated`.** Only `task_started`, `task_progress`,
`task_notification`.

**`task_notification` deletes the card**, it does not close it into a finished
state: `i.delete(t.task_id)`.

**`result` clears the whole map** — `if (size > 0) subagentTasks = new Map()` —
with no grace, no sweep, no "interrupted". It can afford that because its
process outlives the turn.

**It keeps the last three activities, not one.** `recentTools` is built from
`description !== prev ? description : last_tool_name`, sliced `-3`, and is
suppressed once a `summary` exists.

**Its host forwards events LUNO has never seen**: `post_turn_summary`,
`task_summary`, `active_goal`, `commands_changed`, `session_state_changed`,
`transcript_mirror`; `keep_alive` is explicitly skipped.

## Findings

### F1 — the model's report on a finished workflow is discarded · HIGH

The generator returns on the first `done`
([claude-cli.ts:934](../../src/providers/claude-cli.ts#L934)), and `endTurn()`
fires at the first `result` when no tasks are open
([claude-cli.ts:902](../../src/providers/claude-cli.ts#L902)). A workflow that
finishes before that `result` — steps 5–6 land ahead of step 7 above, which is
what a short workflow always does — leaves `openTasks` empty, so the turn ends
there. Everything in step 8 is pushed into a queue with no reader.

Measured: replicating exactly that rule against the real binary (closing stdin at
the first `result` with no open tasks), the CLI still ran the follow-up turn,
emitted the assistant text and a second `result`, and exited 0. The events are
produced; LUNO stops listening.

`usesPermissionProtocol` is true for `default` and `auto`
([claude-cli.ts:311](../../src/providers/claude-cli.ts#L311)) — this is the
normal path, not an edge case.

**Fix:** the turn must not end while the CLI has more to say about a task it just
closed. Correct version is the session-mode one in
`one-process-per-conversation.md`; the interim is to keep the turn open past a
`result` that was preceded by a `task_notification` this turn.

### F2 — a workflow renders as a subagent, badly · HIGH

`taskUpdate` ([claude-cli.ts:2657](../../src/providers/claude-cli.ts#L2657)) does
not look at `task_type`, so `local_workflow` and `remote_agent` produce cards.
For a workflow that card is wrong in every field:

- `subagent_type` is absent → `subagentTitle` renders **"Agent"**
  ([conversation-host.ts:2528](../../src/ui/conversation-host.ts#L2528))
- `prompt` is **the entire workflow script** — the card's disclosure opens onto
  JavaScript
- `last_tool_name` is the agent's _label_ (`"Reply with exactly the word OK…"`),
  rendered as the name of a tool
- `description` on `task_progress` is `"One: <agent label>"`, a phase heading in
  the activity slot

**Fix:** branch on `task_type` before building anything. `local_agent` keeps the
current card. `local_workflow` needs its own, fed by `workflow_progress`.

### F3 — the Workflow tool chip and the card are both on the timeline · MEDIUM

`AGENT_TOOL_NAMES = {Agent, Task}`
([subagent-state.ts:14](../../webview/src/features/chat/subagent-state.ts#L14))
gates the chip→card replacement in
[ChatScreen.tsx:889](../../webview/src/features/chat/ChatScreen.tsx#L889). A
`Workflow` tool_use is not in that set, so the raw tool chip survives _and_ the
host emits a separate card for the same `tool_use_id`. One launch, two rows.

### F4 — `background_tasks_changed` is ignored · MEDIUM

The CLI publishes the authoritative roster of live background tasks on every
change, with `task_id`, `task_type` and `description`. LUNO instead maintains
`liveTasks` by inference and sweeps it on a guess about whether the process is
still alive ([conversation-host.ts:2444](../../src/ui/conversation-host.ts#L2444)).

An empty `tasks: []` is a positive statement that nothing is running — exactly
the signal `sweepLiveTasks` is trying to derive, delivered for free. Adopting it
removes the guesswork, and it is what should decide whether the composer is
free.

### F5 — `workflow_progress` is dropped · MEDIUM

Not declared on `CliEvent`, not read by `taskUpdate`. Per-phase and per-agent
state with model, tokens, tool calls, duration and a result preview — the only
data that can answer "what is my twenty-agent workflow doing right now", which
is the question the user actually has.

### F6 — one activity, where the official keeps three · LOW

LUNO stores a single `lastToolName`. The official builds `recentTools` (last 3,
deduped against the previous entry, suppressed once a summary lands). Three
entries is what distinguishes a working agent from one repeating the same call.

### F7 — `task_updated` is load-bearing here and absent upstream · LOW, watch

LUNO reads `patch.status` from `task_updated`; the official extension ignores the
event entirely and closes on `task_notification` alone. Both events fired in the
probe, back to back. LUNO's handling is not wrong — it is stricter than upstream
— but it is an undocumented dependency on a phase Anthropic's own client does not
consume, so it can be removed at any version. `task_notification` is sufficient.

### F8 — events the CLI sends and LUNO does not know · LOW

`commands_changed` is the notable one: LUNO caches the slash-command list from
`init` only, so a command added mid-session never appears. Also unhandled:
`post_turn_summary`, `task_summary`, `active_goal`, `session_state_changed`,
`keep_alive`, and `system/notification` (`{key, text, priority:"immediate"}` —
the CLI's own way of saying a hook failed).

A second `system/init` mid-session is normal — it arrived on the follow-up turn
with a _different_ tools list as MCP servers finished connecting. Anything that
treats `init` as "a new session started" will mis-fire on it.

## Landed 2026-07-28

F1, F2, F3, F5 and F8 are done, with tests. `bun run lint` clean, suite at
**808 passed / 6 skipped** (was 794), workflow card verified in the harness on
two palettes.

- **F1** — `pendingTaskReport` in the per-turn reader. A `result` no longer ends
  the turn while a task has finished and the model has not spoken since;
  `TASK_REPORT_GRACE_MS` (15s, re-armed by every line) bounds the wait. The test
  that encoded the old behaviour was rewritten rather than patched.
- **F2** — `taskType` and `workflowName` carried end to end; `subagentTitle`
  names a workflow by its script; `last_tool_name` is dropped for workflows.
- **F3** — `AGENT_TOOL_NAMES` → `TASK_TOOL_NAMES`, with `Workflow` in it.
- **F5** — `workflow_progress` plumbed through; `groupWorkflowProgress` folds it
  into phases; the card renders phases, agent rows and an agent count.
- **F8** — `commands_changed` republishes the slash-command list.

### F4 — deferred, and why

The naive wiring is **wrong**, and the probe is what says so. Observed order:

```
background_tasks_changed  tasks: []      ← roster empties here
task_updated              patch.status: "completed"
task_notification         summary: "…"   ← the answer arrives here
```

The roster goes empty **one event before** the terminal status and **two**
before the summary. Closing cards on an empty roster therefore files every task
as unfinished a moment before its answer lands. Every safe wiring needs either a
debounce with an invented millisecond value or a new "ended, outcome unknown"
card state, and neither is justified by a failure anyone has seen. The sweep it
would replace is correct today.

Revisit with `one-process-per-conversation.md`, where the roster is the natural
answer to "is anything still running" — the question that frees the composer.

### F6 — deferred

`recentTools` (last 3) is a change to the collapsed card's shape for a LOW
finding. Worth doing next to any other card work, not on its own.

Ordered by what buys the most per unit of risk.

1. **`task_type` gate** in `taskUpdate`, plus `local_workflow` as its own kind
   end to end. Small, unblocks F2 and F3. (F2, F3)
2. **Do not end the turn on a `result` that follows a `task_notification`.**
   Interim fix for F1 while the process model is still per-turn.
3. **Adopt `background_tasks_changed`** as the source of truth for what is live;
   let it drive the sweep. (F4)
4. **A workflow card fed by `workflow_progress`** — phases and agents, not a
   fake subagent. (F5)
5. **`recentTools`, last 3**, ported verbatim from the official reducer. (F6)
6. **`commands_changed`** into the existing slash-command store. (F8)
7. Then `one-process-per-conversation.md`, which makes the interim in step 2
   deletable.

## Evidence

Probe scripts and both captured streams:
`…/scratchpad/probe-workflow.mjs`, `probe-luno.mjs`, `wf-events.jsonl`,
`wf-events2.jsonl`. Re-run them before trusting any line above — the CLI moves,
and this file cannot know what changed after 2.1.219.
