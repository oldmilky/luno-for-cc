# Subagents — findings from a live run, 2026-07-28

Handoff for whoever picks this up. Companion to
[subagents-and-workflows.md](./subagents-and-workflows.md), which is the audit
this run was meant to validate. That document's "Landed 2026-07-28" section
claims F1, F2, F3, F5 and F8 are done. **This run says F1 is not, and turns up
three defects the audit never named.**

Everything below is separated into what was measured, what was inferred, and
what is still open. Do not promote an inference to a fact without re-measuring.

---

# Resolved 2026-07-28, later the same day

**The document below is wrong about which code path ran, and that error is load
bearing — it invalidates the reasoning in P1 and P4.** Corrections first, then
what was fixed. Everything here was measured from the persisted session
(`…/globalStorage/lunoweb.luno-for-cc/sessions/f58e1555-….json`) and the
extension's own output-channel log on disk, not re-derived.

## Correction 1 — it was not the per-turn path

The log for that window:

```
17:40:50.924 [luno] remote control on: https://claude.ai/code/session_…
17:41:23.144 [luno] session options changed — replacing the CLI process
17:41:24.942 [luno] remote control on: https://claude.ai/code/session_…
```

The run's first timeline event is **17:43:56**. Remote Control had been on for
three minutes, so the conversation was served by `streamInSession`, not by
`stream`. **F1's fix — `pendingTaskReport`, `openTasks`, `graceBudget` — exists
only in the per-turn reader and never executed.** The section below that
verifies its arithmetic is checking code that did not run.

`streamInSession` ends a turn unconditionally
([claude-cli.ts:1244](../../src/providers/claude-cli.ts#L1244)):

```ts
if (ev.type === "result") { session.busy = false; …; route({ type: "done" }); }
```

## Correction 2 — one root cause, not four defects

A session process pushes `done` at **every** `result`, including the extra turn
the CLI opens to answer its own `<task-notification>`. `onOutOfTurn` read every
one of those as "the session is gone" and swept. That single confusion produces
P1, P4, and the duplicate rows:

- the report turn's text arrived with no turn to attach to and fell through to
  `this.remoteTurn?.push(d)` — no remote turn, **dropped**. That is P1.
- its `done` swept every _other_ agent still running, stamping `interrupted`.
  That is P4, and the trigger is not a race between `task_notification` and the
  status.

Measured in the persisted timeline for agent `a7b3ce046` (`Explore`):

```
17:44:29  a70b99aba  end  completed    32921ms   ← the first agent answers
17:44:45  a7b3ce046  end  interrupted  38647ms   ← swept by the report turn's `done`
17:45:50  a7b3ce046  end  completed   107608ms   ← its real answer, 65s later
```

Two closing rows for one agent, 16s apart — the gap is the report turn's length.

## Correction 3 — P4's prediction is wrong

The correction **is** persisted: the second row above is on disk with
`completed` and the true duration. A reload folds later-wins and the card comes
back green, not yellow. What is genuinely wrong is that two `end` rows exist,
and the second lost its `description` — it was built from the notification alone
because the sweep had already cleared `liveTasks`.

By the same token P2's numbers are **live-state artifacts**: `durationMs` on
disk is 107608, the true value. Whatever the collapsed card showed mid-run, it
was not reading the persisted event.

## Fixed

- `StreamDelta.sessionEnded`, set only on the child's `exit`
  ([claude-cli.ts](../../src/providers/claude-cli.ts)). `onOutOfTurn` sweeps on
  that and nothing else, so a turn merely ending no longer buries working
  agents.
- Out-of-turn `text` is buffered and flushed onto the timeline as an ordinary
  assistant row (`flushOutOfTurnText` in
  [conversation-host.ts](../../src/ui/conversation-host.ts)). The model's report
  on a finished agent now reaches the chat and the stored session.
- Four tests, including one that pins the distinction the bug turned on: a
  plain `done` must not close a working agent.

`bun run lint` clean. Suite **830 passed / 6 skipped / 0 failed** on a serial
run (`vitest run --no-file-parallelism`). Under full parallelism one or two
timing-sensitive suites (`conversation-queue`, `conversation-worktree`) flake on
a loaded machine; each passes in isolation and neither is touched by this work.

## Still open

P2's live display, P3 (nested agent as a flat sibling titled "Agent"), P5
(`workflowProgress` never persisted), P6 (plan and code disagree). P3 and P5 are
unaffected by the above and their descriptions still stand.

---

## What was run

Two subagents dispatched from the LUNO panel in one turn, per-turn CLI path,
`permissionMode: default` (so `usesPermissionProtocol` is true —
[claude-cli.ts:311](../../src/providers/claude-cli.ts#L311)). Working tree was
the uncommitted subagents/workflows change (15 files, +860/−31).

| Agent             | Task                             | Dispatched as       |
| ----------------- | -------------------------------- | ------------------- |
| `general-purpose` | Run the test suite               | `run_in_background` |
| `Explore`         | Trace `workflow_progress` wiring | `run_in_background` |

## Measured — ground truth from the notification payloads

```
general-purpose  tool_uses: 1   duration_ms: 32921   result: "808 pass, 6 skip, 0 fail"
Explore          tool_uses: 24  duration_ms: 107608
```

Test suite is **808 pass, 6 skip, 0 fail**. `CLAUDE.md` still names the gate as
`761 passed, 6 skipped` — stale, and it is the only place that number lives.
Update it in the same commit as this work.

## Measured — what the panel actually rendered

Screenshot taken after the turn reached `done`. Group header: **"Worked for
1m 57s"**. Three cards, all with green checkmarks at rest:

| Card              | Description                    | Steps    | Duration   |
| ----------------- | ------------------------------ | -------- | ---------- |
| `general-purpose` | Run the test suite             | 1 step   | **3s**     |
| `Explore`         | Trace workflow_progress wiring | 24 steps | **1m 15s** |
| `Agent`           | Run the project test suite     | —        | **19s**    |

Below the group, exactly **one** assistant text block: the one written
immediately after the dispatch ("Оба запущены и работают в фоне…").

User-reported, not in the screenshot: the `Explore` card was **yellow first**,
then went green. The panel was **not reloaded** after the run — every
observation is from the live, in-memory state.

## P1 — the model's report after a task notification never reaches the timeline · HIGH

**This is F1, still broken, one layer further down than where it was fixed.**

Two assistant messages were produced after the run — one after each
`task_notification` (the test result, then the trace). Neither appeared in the
panel. The user's words: "почему-то ты мне ничего не отписал".

What was verified as _working_:

- The provider holds the turn correctly. `pendingTaskReport`
  ([claude-cli.ts:854](../../src/providers/claude-cli.ts#L854)) is set on
  notification, cleared by any `text` or `tool_use_start`
  ([:917](../../src/providers/claude-cli.ts#L917)), and `endTurn` is gated on it
  ([:947](../../src/providers/claude-cli.ts#L947)).
- The arithmetic confirms it: agent B ended at 107.6s, the turn header reads
  1m 57s (117s). The turn survived ~9s past the last agent — exactly long
  enough for the final text. Had F1's hold failed, the turn would have ended at
  the first `result`.
- The processor emits deltas for a second assistant message and even inserts the
  paragraph break between them
  ([claude-cli.ts:2427](../../src/providers/claude-cli.ts#L2427)).
- `orchestrator.ts` accumulates all of it into one `textBuf` and flushes at end
  of stream ([orchestrator.ts:196](../../src/core/orchestrator.ts#L196)).

So on paper the text should have been emitted as a single `assistant` timeline
event containing all three chunks concatenated. **The user saw only the first
chunk.** The loss is somewhere between that flush and the rendered timeline, and
it was not localised before this handoff.

### The next step, and it is cheap

Read the persisted session timeline for this conversation and look at the
`assistant` events.

- **All three texts present in one event** → the bug is in rendering or in the
  live-streaming path, and reloading the panel will make the missing text
  appear. Look at how the webview reconciles streamed deltas against the
  timeline event at `turnEnd`.
- **Only the first text present** → the loss is upstream of persistence.
  Instrument `flushText` and the `onDelta` path.

I was cut off while locating the session store — start by finding where
`src/ui/domains/session-store.ts` and `src/services/history.ts` write to disk.

**Asking the user to reload the panel tests P1 and P4 in one move**, and costs
them five seconds. Do that before anything else.

## P2 — card durations are wrong, and impossibly so · HIGH

Measured against the notification payloads:

| Card              | Steps shown | Steps actual | Duration shown | Duration actual |
| ----------------- | ----------- | ------------ | -------------- | --------------- |
| `general-purpose` | 1           | 1 ✓          | 3s             | **32.9s**       |
| `Explore`         | 24          | 24 ✓         | 1m 15s         | **1m 48s**      |

Step counts are exact. Durations are under-reported on both, by different
factors (11× and 1.4×) — so it is not a unit bug.

The decisive one: `general-purpose` shows **3s** while the nested agent it
spawned itself ran **19s**. A parent cannot be shorter than its own child. Start
at `SubagentCard.tsx:43` — `task.durationMs ?? fallbackMs` — and work back
through which of the two is winning and what each measures.
`FoldedSubagents.elapsed` ([subagent-state.ts:37](../../webview/src/features/chat/subagent-state.ts#L37))
is measured off LUNO's own start/end timestamps and is documented as a fallback
only.

## P3 — a nested subagent renders as a flat sibling titled "Agent" · MEDIUM

Two agents were dispatched. **Three cards appeared.** The third —
`Agent` · "Run the project test suite" · 19s — is the subagent that
`general-purpose` spawned inside itself.

Two things wrong with it:

1. It is rendered as a peer of the agent that launched it, with no indication of
   nesting. Reading the panel, the user counts three top-level agents where they
   asked for two.
2. Its title falls back to **"Agent"** — the same missing-`subagent_type` path
   the audit named in F2 for workflows
   ([SubagentCard.tsx:80](../../webview/src/features/chat/SubagentCard.tsx#L80)).
   F2 was closed for `local_workflow`; this is the same defect on a different
   input.

Note the tension with the header comment on `SubagentCard.tsx:6-12`, which says
nested subagent work is deliberately not rendered because it arrives stamped
with `parent_tool_use_id` and is dropped at
[claude-cli.ts:2372](../../src/providers/claude-cli.ts#L2372). That is true of
its _tool calls_. Its `task_*` events evidently are not stamped, so a nested
task still surfaces as its own card. Decide which behaviour is wanted — nesting
the card under its parent, or suppressing it — but the current state is neither.

## P4 — the "interrupted" flash is persisted; the correction is not · HIGH if confirmed

**Mechanism traced, consequence not yet verified.**

Why the card went yellow: yellow is `.interrupted`, `--warn`
([SubagentCard.module.scss:33](../../webview/src/features/chat/SubagentCard.module.scss#L33)).
The only place that status is invented is
[conversation-host.ts:2426](../../src/ui/conversation-host.ts#L2426):

```ts
status: isTerminalTaskStatus(task.status) ? task.status : "interrupted";
```

and the card is closed on `phase === "notification"` **unconditionally**
([:2397-2400](../../src/ui/conversation-host.ts#L2397)), without waiting for a
terminal status. So `task_notification` arrives before the status becomes
`completed`, the card is filed as interrupted, and a later update repaints it
green.

Why that is worse than a flash: `emitSubagentEnd` writes through
`session.emit` + `scheduleSave` — **the yellow state is persisted**. The
correction arrives on `subagentProgress`
([:2415](../../src/ui/conversation-host.ts#L2415)), which is never persisted and
which `App.tsx:284` clears wholesale on `turnEnd` (reported by a trace agent,
not re-verified by hand).

**Prediction, untested:** reload the panel and the `Explore` card comes back
yellow with an ✗, permanently. The user did not reload, so this is open.

Note also that the audit's F4 event ordering (`task_updated` before
`task_notification`) was measured on a **workflow**. This run suggests a
background **agent** orders them the other way. The audit's table does not cover
this case.

## P5 — `workflowProgress` rides only the non-persisted path · MEDIUM

Same class of defect as P4, found while tracing F5's wiring. `workflowProgress`
is attached only to `task_progress`
([claude-cli.ts:2752](../../src/providers/claude-cli.ts#L2752)), which crosses on
`subagentProgress` — not persisted, and cleared on `turnEnd`. A finished
workflow's card therefore loses its phases and agent rows the moment the turn
ends, and has none at all in a restored session. The whole F5 feature is
live-only.

Traced by a subagent, not re-verified by hand. Verify before acting.

## P6 — plan and code disagree about F2 · LOW

The audit says: "branch on `task_type` before building anything…
`local_workflow` needs its own [card]". What was built is one `SubagentCard`
with internal forks (icon, name, header count, `Script` vs `Asked`), and the
decision of whether a card exists at all is made on the **tool name**
(`TASK_TOOL_NAMES`, [ChatScreen.tsx:889](../../webview/src/features/chat/ChatScreen.tsx#L889)),
not on `task_type`. It works; the document describes something else. Fix one or
the other.

Related: the literal `"local_workflow"` is spelled out in three places —
[core/types.ts:229](../../src/core/types.ts#L229),
[SubagentCard.tsx:48](../../webview/src/features/chat/SubagentCard.tsx#L48),
and a doc comment on `rpc.ts:86`. The webview does its own string compare rather
than sharing `isWorkflowTask`.

## Suggested order

1. **Ask the user to reload the panel.** Settles P1 and P4 together, costs
   nothing, and changes which end of P1 to dig at.
2. P1 — it is the one the user actually felt. A background agent whose answer
   never reaches the chat makes the whole feature pointless.
3. P4 — a card that lies about its outcome forever is worse than one that
   flashes.
4. P2 — visible on every card, and one of the numbers is provably impossible.
5. P3, P5, P6.

## What is verified vs. what is not

**Measured directly:** the test count; both agents' `tool_uses` and
`duration_ms`; what the panel rendered; the provider's turn-hold arithmetic; the
`.interrupted` → `--warn` mapping and the two host lines that produce it.

**Traced but not re-verified by hand:** the `workflow_progress` chain end to end
(P5), and `App.tsx:284` clearing `taskProgress` on `turnEnd` (load-bearing for
both P4 and P5).

**Inferred, not measured:** the reconstructed event ordering behind P4; the
claim in P1 that all three text chunks should have landed in one `assistant`
event.

**Not attempted:** locating the persisted session file; any fix.
