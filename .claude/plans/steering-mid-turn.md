# Steering — a message that reaches a running turn

**Status:** designed, not started. Written 2026-07-28.
**Reviewed 2026-07-29** against the working tree — every line reference below
was re-read on disk, and five things the first draft did not cover are folded
in: who persists a steered message, the provider entry point it needs, the
attribution rule (no longer an open question), the spawn race the removed gate
was hiding, and what `still_queued` actually costs.

**Depends on** [one-process-per-conversation.md](./one-process-per-conversation.md),
which is not optional here: it is phase 1 of this document. Companion to
[subagents-and-workflows.md](./subagents-and-workflows.md), whose F1 interim
this deletes.

Every claim below was either measured against `claude` 2.1.219 with the raw
stream captured, or read out of the shipped `anthropic.claude-code` 2.1.220
bundles. Nothing here is from memory, and the probes are re-runnable — see
[Evidence](#evidence).

## The symptom

You are watching the model write code. Halfway through you realise the auth it
is building needs 2FA. You type it — and land in **QUEUED**, where you wait for
work you already know is going the wrong way.

Worse with background agents. A workflow of twenty-odd agents runs for half an
hour, the model has long since said everything it had to say, and the panel
still reads **Cooking…** with a composer that will not send.

Two different faults with one shape:

| Fault                                          | Cause                                                          |
| ---------------------------------------------- | -------------------------------------------------------------- |
| Cannot correct the model while it works        | `handlePrompt` queues whenever `activeTurn` is set             |
| Cannot type at all while background agents run | the turn is held open on purpose so the CLI does not kill them |

## The wire truth

**The CLI already does this.** A second `user` message written to the child's
stdin is picked up at the next tool boundary and continues the _same_ turn.

Four runs, all captured:

| #   | Mode    | Injected at | Echo (`isReplay`) | First `result` | What the model did                  |
| --- | ------- | ----------- | ----------------- | -------------- | ----------------------------------- |
| 1   | session | 2 522 ms    | 43 211 ms         | 40 731 ms      | nothing — no tool boundary existed  |
| 2   | session | 6 218 ms    | 7 370 ms          | 15 711 ms      | obeyed; dropped 5 pending reads     |
| 3   | `-p`    | 6 554 ms    | 7 711 ms          | 38 058 ms      | read all six anyway, never complied |
| 4   | `-p`    | 8 158 ms    | 9 221 ms          | 30 476 ms      | obeyed; zero tool calls after       |

Runs 2 and 4 ended with **one** `result` carrying `num_turns: 2` — the injected
message belonged to the turn already in flight. Run 1 had no tool call at all,
so the message waited and the CLI opened a **second turn** for it by itself: a
fresh `system/init` at 40 738 ms and its own `result` at 49 804 ms.

Three conclusions, and the third is the one that matters:

1. Delivery happens **at a tool boundary**. Pure text generation has none, so a
   message sent into it waits — that is physics, not a defect to fix.
2. The transport works in **both** process modes. `-p` is not the obstacle.
3. Whether the model abandons work in progress is **the model's judgement, not
   the channel's**. Runs 3 and 4 are the same mechanism with opposite outcomes.
   Nothing in the client can or should decide this.

## What Anthropic's own client does

Read out of `anthropic.claude-code-2.1.220`, not inferred.

**The composer has no busy gate.** Its submit handler calls
`await session.send(text, …, {kind:"human"})` directly. `send()` contains no
check on `busy` — it builds the message, appends it to the timeline, sets
`busy = true`, and writes:

```js
s = {
  type: "user",
  uuid: crypto.randomUUID(),
  session_id: "",
  parent_tool_use_id: null,
  message: { role: "user", content: r }
};
if ((a = Ak(s))) this.messages.value = x2([...this.messages.value, a]); // timeline first
this.busy.value = !0;
d.sendInput(c, s, !1); // then stdin
```

`sendInput` posts `io_message` to the host, the host calls `transportMessage`,
and the SDK's `streamInput` writes every message it is handed:

```js
async streamInput(e){ for await (let r of e){ … await this.transport.write(oi(r)+"\n") } }
```

No turn check at any layer.

**`busy` is off at `result`.** `if (e.subtype === "init") busy = true;
else if (e.type === "result") busy = false`. Background tasks do not hold it.

**There is no queued-message UI.** The word does not appear as product copy
anywhere in `webview/index.js`. The queue lives inside the CLI.

**The CLI offers the undelivered text back.** The `interrupt` control response
carries `still_queued: string[]`:

```js
async interrupt(){ let e = (await this.request({subtype:"interrupt"})).response?.still_queued;
                   return Array.isArray(e) ? {still_queued: e.filter(t => typeof t === "string")} : void 0 }
```

The VS Code extension asks for it and then drops it — its webview never sees the
value. The TUI does use it: `hasQueuedPrompts`,
`[clearCommandQueue] dropping N queued command(s)`. The feature's internal name
is visible there too — `tengu_subagent_steer_applied`.

## Phase 1 — one process per conversation

The whole of [one-process-per-conversation.md](./one-process-per-conversation.md),
unchanged. Without it stdin only exists inside a turn, and the second fault
above cannot be fixed at all. Its six items, restated only where this document
adds to them.

**Status 2026-07-29: commit 1 landed, gates green, not yet run for real.** All
of it except item 4 (deleting the hold), which waits on a live run. The part
this document depends on — a process that outlives its turn, with stdin open —
exists now, so phase 2 is unblocked as soon as that run happens.

1. Every turn runs on the long-lived provider. `ensureRemoteProvider`
   ([conversation-host.ts:1916](../../src/ui/conversation-host.ts#L1916)) is
   misnamed once it is not about Remote Control.
2. Cancellation becomes `interrupt`
   ([claude-cli.ts:1518](../../src/providers/claude-cli.ts#L1518)) rather than
   killing the child. Same call the official extension makes.
3. "This turn failed" stops being "the session died".
4. Delete the hold: `BACKGROUND_TASK_GRACE_MS`, `armGrace`, `openTasks`, the
   deferred `endTurn` — **and `pendingTaskReport`**, the F1 interim from
   [subagents-and-workflows.md](./subagents-and-workflows.md). It exists only
   because the process died with the turn.
5. **Already landed** — `sweepLiveTasks`
   ([conversation-host.ts:2462](../../src/ui/conversation-host.ts#L2462)) is
   gated on the process being gone at both session-mode call sites, which is
   what D1 of the parity audit was. What is left of this item is deleting the
   per-turn caller at
   [conversation-host.ts:2172](../../src/ui/conversation-host.ts#L2172) together
   with the per-turn path, where it is correct today.
6. Rewrite `conversation-queue.test.ts` and the affected suites rather than
   patching them.

Phase 1 alone puts `busy` where Anthropic puts it: off at `result`, with agents
still running and the composer live.

## Phase 2 — steering

One rule: **sending never queues.**

### Host

- `handlePrompt` ([conversation-host.ts:1834](../../src/ui/conversation-host.ts#L1834))
  loses its `activeTurn → enqueue` branch. A send with a turn in flight becomes
  a write to the live session's stdin.

- **The provider needs a new entry point — `streamInSession` is not it.** That
  method does four things ([claude-cli.ts:1075-1099](../../src/providers/claude-cli.ts#L1075-L1099)):
  `waitUntilIdle`, install the turn's `sink`, set `busy`, then write. Steering
  needs the fourth alone. Extract `writeUserMessage(session, text)` — the
  `uuid`, the `pendingEchoes` registration, `origin: {kind:"human"}` and the
  `turnPreamble` all belong to it — and expose `steer(text): boolean` on top,
  returning `false` when there is no live session so the host falls back to
  opening an ordinary turn.

- **The steered message must be added to the session by the host.** Nothing else
  will: `session.addUser()` is called inside `Orchestrator.turn` and
  `Orchestrator.observe` ([orchestrator.ts:50](../../src/core/orchestrator.ts#L50),
  [:77](../../src/core/orchestrator.ts#L77)), and a steered message opens
  neither. Left out, the bubble renders, the model answers it, and the message
  is absent from the stored timeline — gone on the next reload, and missing from
  the context of every later turn. So: `addUser` + `scheduleSave` at the send,
  and the echo is swallowed rather than added a second time, which
  `pendingEchoes` already does.

- `waitUntilIdle` ([claude-cli.ts:1645](../../src/providers/claude-cli.ts#L1645))
  comes off the send path. It stays for respawn, where two turns really must not
  share one stdin.

- **A steered message opens no second turn** while one is in flight. It belongs
  to that turn, which will produce one `result`. Opening a turn for it means
  waiting on a `result` that never comes.

- **Attribution — decided, not open.** The echo settles it, and the rule needs
  no UI judgement:

  | Echo (`isReplay`, our `uuid`) arrives | Meaning                                    | Action                                          |
  | ------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
  | while a turn is live                  | delivered into that turn                   | nothing — it is already being answered          |
  | with no turn live                     | the CLI opened its own turn for it (run 1) | open a full turn locally, suppressing `addUser` |
  | never, and the process is replaced    | lost in the old stdin — open question 3    | see below                                       |

  The follow-up must render as **a full turn, never as out-of-turn text**. The
  out-of-turn path keeps only `text`
  ([conversation-host.ts:1976](../../src/ui/conversation-host.ts#L1976)); a
  `tool_use_start` or `tool_result` with no `remoteTurn` falls to
  `this.remoteTurn?.push(d)` and is dropped, so the answer would arrive as one
  bare paragraph with every tool call missing. That is the same defect as D2's
  tail in the parity audit, and choosing out-of-turn text here would build it in
  on purpose. The machinery for the right choice already exists: `onOutOfTurn`
  ([conversation-host.ts:1947](../../src/ui/conversation-host.ts#L1947)) opens a
  turn for a phone prompt through `beginRemoteTurn`
  ([:2207](../../src/ui/conversation-host.ts#L2207)); ours differs only in
  already having its user message on the timeline.

- **The gate that goes was also serialising the spawn.** With `activeTurn` gone,
  two sends in quick succession against a conversation with no live process both
  reach `ensureSession` and spawn a CLI each. `waitUntilIdle` does not cover it —
  `session.busy` is set after the spawn, not before. A promise lock around
  session creation is part of this phase, not an afterthought.

- **Does a steered message carry a fresh preamble?** In session mode the
  diagnostics and the editor context travel as text ahead of the prompt
  (`turnPreamble`, [claude-cli.ts:1574](../../src/providers/claude-cli.ts#L1574))
  rather than in argv, because argv is frozen at spawn. Decision: **yes, carry
  it**. A correction sent mid-turn is exactly when what the user has open has
  just changed, and this is the only channel that can say so; stale context is
  worse than the tokens.

- Deleted: `this.queued` ([conversation-host.ts:339](../../src/ui/conversation-host.ts#L339)),
  `enqueue`, `flushQueued`, `clearQueued`, `dropQueued`
  ([:1143](../../src/ui/conversation-host.ts#L1143)), the `turnFailed` read that
  only the flush loop uses, and the `queued` protocol message on both sides. Note
  that today's queue is a **single concatenated string** — two sends joined by
  `\n\n`. One Enter becomes one user message, as upstream.

### Webview

- Enter always sends. The QUEUED state and its rendering go.
- The bubble is an ordinary user bubble, appended immediately. No pending
  styling, no per-message affordance — matching upstream exactly.
- The thinking indicator follows `result`, not the task roster.

#### What "busy" says once the model is done and agents are not

`showThinking = busy` ([ChatScreen.tsx:284](../../webview/src/features/chat/ChatScreen.tsx#L284)),
and `busy` runs from `turnStart` to `turnEnd`. Because the turn is held open for
the agents, the verbs keep cycling long after the model went idle — a workflow
three minutes in still reads **Brewing…** with nothing composing it. Deleting
the hold makes that line honest by removing it, and on its own that is the same
error with the sign flipped: half an hour of agent work in front of a panel that
looks asleep. Three surfaces, three different answers:

| Surface                             | While the model writes  | Once only agents are left                                                                                                                                                              |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the verb line (`ThinkingIndicator`) | as today                | gone. It only ever meant "the model is composing"                                                                                                                                      |
| the subagent / workflow card        | as today                | **this** is the liveness signal, and it already works: `running` comes off `task.status` ([SubagentCard.tsx:42](../../webview/src/features/chat/SubagentCard.tsx#L42)), not off `busy` |
| the header pill and the chat list   | `working` → "streaming" | undecided — below                                                                                                                                                                      |

Two things that follow, neither of them cosmetic:

- **`turnEnd` wipes live task progress today.** `setTaskProgress({})` at
  [App.tsx:284](../../webview/src/App.tsx#L284), and the comment states the
  premise this phase deletes: "the host has just closed every open one on the
  timeline". Afterwards `turnEnd` fires with agents still running, so the card
  keeps its title and spinner — those come from the stored `subagent` event
  through `foldSubagents` — and loses its live half: the activity line, the
  workflow's per-agent roster, the elapsed time, because live outranks stored at
  [ChatScreen.tsx:1136](../../webview/src/features/chat/ChatScreen.tsx#L1136).
  The clear moves from `turnEnd` to the task's own terminal event.

- **The header pill and the chat list need a state that does not exist yet.**
  `headerStatus` returns `working` off `busy` alone
  ([chat-status.ts:57](../../webview/src/features/chat/chat-status.ts#L57)), and
  the same table feeds the history list, where `working` means "this chat is
  mid-turn while you are looking at another one"
  ([chat-status.ts:22-25](../../webview/src/features/chat/chat-status.ts#L22)).
  After phase 1 a conversation with twenty agents running reports `stored` —
  **done** — in both places. In the list that is the worse of the two: a
  background conversation running a workflow is exactly the one the user is
  trying to find. Choose between holding `working` while `liveTasks` is
  non-empty (which needs its own label — "streaming" is untrue there) and a
  seventh status in the table. One decision, two surfaces, one vocabulary.

What that means file by file, so it is not hunted for twice:
[QueuedPrompt.tsx](../../webview/src/features/chat/QueuedPrompt.tsx) in whole,
`.queued*` in
[ChatBits.module.scss:293-350](../../webview/src/features/chat/ChatBits.module.scss#L293),
the `queued` state and its prop in
[App.tsx:133](../../webview/src/App.tsx#L133),
[:238](../../webview/src/App.tsx#L238), [:433](../../webview/src/App.tsx#L433)
and [ChatScreen.tsx:98](../../webview/src/features/chat/ChatScreen.tsx#L98),
[:589](../../webview/src/features/chat/ChatScreen.tsx#L589), and both directions
of the protocol — `queued` at
[rpc.ts:626](../../webview/src/lib/rpc.ts#L626) and `dropQueued` at
[rpc.ts:459](../../webview/src/lib/rpc.ts#L459).
`returnToComposer` **stays**: it is what Stop still uses (see below).

### Remote Control

Nothing to build. The phone already writes into the same session, so a message
typed there steers the same way.

## One deliberate deviation

The extension asks for `still_queued` and discards it, so text typed and never
delivered is simply lost on Stop. LUNO returns it today (`returnQueued`,
[conversation-host.ts:1889](../../src/ui/conversation-host.ts#L1889)) and should
keep doing so — sourced from `still_queued` instead of from a local queue. That
is 1:1 with the TUI, which consumes it, and not with the extension, which does
not. Named here so the divergence is a decision rather than a drift.

**Two things it costs, both missed by the first draft.**

`interrupt` ([claude-cli.ts:1518](../../src/providers/claude-cli.ts#L1518)) is
fire-and-forget `writeControl` today — the CLI's answer, `still_queued` included,
is thrown away unread. It has to move to `sendControl`
([:1471](../../src/providers/claude-cli.ts#L1471)), which already awaits through
`pendingControls`/`resolveControl` and already has its own timeout. `cancel()`
([:538](../../src/providers/claude-cli.ts#L538)) is synchronous and so is every
caller, so the returned text arrives in a `.then`, not an `await`.

And the divergence is **narrower than the section implies**. `returnQueued` has
five call sites today — `editAt`
([conversation-host.ts:1818](../../src/ui/conversation-host.ts#L1818)),
`abortTurn` ([:1111](../../src/ui/conversation-host.ts#L1111)), dispose
([:1722](../../src/ui/conversation-host.ts#L1722)), the flush loop, and the
failure branch. Once there is no local queue, four of them have nothing to hand
back: the text is in the CLI, and only an `interrupt` asks for it. The deviation
from upstream survives at exactly one site — Stop.

## Open questions — probe, do not guess

Four unknowns that the design does not depend on but the implementation does.
Each is one probe against the real binary, in the shape of the ones already
written:

1. **A turn parked on a permission prompt** has no tool boundary until it is
   answered. Where does a written message sit, and does it survive a deny?
2. **After `interrupt`** — is an already-written message still delivered, or
   does it come back in `still_queued`?
3. **A respawn on `--effort`** leaves a written message in the old process's
   stdin. Likely rule: refuse the effort change while an echo is outstanding.
   Confirm the message is genuinely lost before building the guard.
4. **Does `interrupt` stop background agents, or only the turn?** This decides
   what Stop even means in the state the whole document is for — the model
   finished, twenty agents are still running, and there is no turn left to stop.
   If it takes the agents with it, Stop needs a second meaning while
   `liveTasks` is non-empty; if it does not, the button is simply idle there.

## Tests

| Layer   | What                                                                                      |
| ------- | ----------------------------------------------------------------------------------------- |
| host    | `handlePrompt` writes to stdin while a turn is active; no session → spawn                 |
| host    | a steered message reaches the stored timeline — reload shows it, and it is in the context |
| host    | two sends before any process exists spawn **one** CLI, not two                            |
| stream  | echo before `result` → one turn, two user messages, one `result`                          |
| stream  | echo after `result` → a full turn attributed to us, tool calls intact, `addUser` not run  |
| cancel  | `interrupt` ends the turn and leaves the process alive                                    |
| cancel  | `still_queued` comes back to the composer                                                 |
| webview | the QUEUED state is gone; the composer is live while `busy`                               |
| webview | `turnEnd` with a task still running keeps that task's live progress                       |
| webview | a conversation whose turn ended with agents running is not reported `done`                |
| harness | composer usable with background agents running, on two palettes                           |
| harness | turn ends mid-workflow: verb line gone, card still ticking, header still truthful         |

`conversation-queue.test.ts` is rewritten, not deleted — it describes a process
model that no longer exists, and the replacement describes the one that does.

## Done when

- Typing while the model works reaches it at the next tool call, in the same
  turn, verified in the running extension and not only in tests.
- A steered message is still there after a reload — on the timeline, in the
  stored session, and in the context the next turn is answered from.
- A steered message that missed the boundary comes back as a full turn with its
  tool calls, not as a bare paragraph.
- The model finishes, agents keep running, the composer is free and the
  indicator is off — and the panel still shows the work: the cards keep their
  live activity, and neither the header nor the chat list calls that
  conversation `done`.
- Stop ends the turn, leaves the conversation usable, and nothing typed is lost.
- Remote Control still works, including across an effort change.
- `bun run lint` clean; the suite green with the queue and cancellation suites
  rewritten.

## Sequencing

Phase 1 deletes `pendingTaskReport`, which is uncommitted in the working tree
right now alongside F2, F3, F5 and F8. **Commit that work first** — it is green
and carries its own tests — so the deletion arrives as a clean diff instead of
mixing with unlanded work.

Then phase 1 itself lands in **two commits, not one**. What is risky in it is
not pointing the turn at the long-lived provider — it is Stop, and the suites
that encode a process dying with the turn:

1. One provider for every turn, cancellation through `interrupt`, the affected
   suites rewritten. Verified in the running extension before anything is
   deleted.
2. The hold removed — `BACKGROUND_TASK_GRACE_MS`, `armGrace`, `openTasks`,
   `pendingTaskReport`, the deferred `endTurn` and their tests. Pure deletion,
   and safe exactly to the degree that the first commit was verified live.

## Evidence

Probe scripts and captured streams:
`…/scratchpad/probe-steering.mjs` (run 1), `probe-steering-tools.mjs` (run 2),
`probe-steering-print.mjs` and `probe-print-2.mjs` (runs 3–4), with
`steering-events.json` and `steering-tools-events.json` beside them. Re-run them
before trusting any timing above — this file cannot know what the CLI did after
2.1.219.
