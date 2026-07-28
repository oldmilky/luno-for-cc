# Steering — a message that reaches a running turn

**Status:** designed, not started. Written 2026-07-28.

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
adds to them:

1. Every turn runs on the long-lived provider. `ensureRemoteProvider`
   ([conversation-host.ts:1888](../../src/ui/conversation-host.ts#L1888)) is
   misnamed once it is not about Remote Control.
2. Cancellation becomes `interrupt`
   ([claude-cli.ts:1480](../../src/providers/claude-cli.ts#L1480)) rather than
   killing the child. Same call the official extension makes.
3. "This turn failed" stops being "the session died".
4. Delete the hold: `BACKGROUND_TASK_GRACE_MS`, `armGrace`, `openTasks`, the
   deferred `endTurn` — **and `pendingTaskReport`**, the F1 interim from
   [subagents-and-workflows.md](./subagents-and-workflows.md). It exists only
   because the process died with the turn.
5. `sweepLiveTasks` ([conversation-host.ts:2444](../../src/ui/conversation-host.ts#L2444))
   runs only when the process is actually gone.
6. Rewrite `conversation-queue.test.ts` and the affected suites rather than
   patching them.

Phase 1 alone puts `busy` where Anthropic puts it: off at `result`, with agents
still running and the composer live.

## Phase 2 — steering

One rule: **sending never queues.**

### Host

- `handlePrompt` ([conversation-host.ts:1812](../../src/ui/conversation-host.ts#L1812))
  loses its `activeTurn → enqueue` branch. Every send registers a `uuid` in
  `pendingEchoes` and writes to the live session's stdin, exactly as
  `streamInSession` already does at
  [claude-cli.ts:1075](../../src/providers/claude-cli.ts#L1075).
- `waitUntilIdle` ([claude-cli.ts:1568](../../src/providers/claude-cli.ts#L1568))
  comes off the send path. It stays for respawn, where two turns really must not
  share one stdin.
- **A steered message opens no second turn.** It belongs to the turn in flight,
  which will produce one `result`. Opening a turn for it means waiting on a
  `result` that never comes.
- If the turn ends before the CLI reaches the message, the CLI opens the next
  turn itself (run 1). That path is **already built**: `onOutOfTurn`
  ([conversation-host.ts:1947](../../src/ui/conversation-host.ts#L1947)) opens a
  turn for a phone prompt via `beginRemoteTurn`, and accumulates a self-opened
  turn's text into `outOfTurnText`, flushed on `done`. Nothing new is needed to
  make the answer arrive.

  What the design must decide is **attribution**: today that text is the
  report on a finished background task, and a steered message that missed the
  boundary produces the same shape. Distinguishing them is what `pendingEchoes`
  is for — an outstanding echo says the follow-up turn is ours. Whether ours
  then renders as a full turn or as out-of-turn text is the one open UI call in
  this phase.

- Deleted: `this.queued` ([conversation-host.ts:339](../../src/ui/conversation-host.ts#L339)),
  `enqueue`, `flushQueued`, `clearQueued`, and the `queued` protocol message on
  both sides. Note that today's queue is a **single concatenated string** —
  two sends joined by `\n\n`. One Enter becomes one user message, as upstream.

### Webview

- Enter always sends. The QUEUED state and its rendering go.
- The bubble is an ordinary user bubble, appended immediately. No pending
  styling, no per-message affordance — matching upstream exactly.
- The thinking indicator follows `result`, not the task roster.

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

## Open questions — probe, do not guess

Three unknowns that the design does not depend on but the implementation does.
Each is one probe against the real binary, in the shape of the ones already
written:

1. **A turn parked on a permission prompt** has no tool boundary until it is
   answered. Where does a written message sit, and does it survive a deny?
2. **After `interrupt`** — is an already-written message still delivered, or
   does it come back in `still_queued`?
3. **A respawn on `--effort`** leaves a written message in the old process's
   stdin. Likely rule: refuse the effort change while an echo is outstanding.
   Confirm the message is genuinely lost before building the guard.

## Tests

| Layer   | What                                                                        |
| ------- | --------------------------------------------------------------------------- |
| host    | `handlePrompt` writes to stdin while a turn is active; no session → spawn   |
| stream  | echo before `result` → one turn, two user messages, one `result`            |
| stream  | echo after `result` → the follow-up turn is attributed to us, not to a task |
| cancel  | `interrupt` ends the turn and leaves the process alive                      |
| cancel  | `still_queued` comes back to the composer                                   |
| webview | the QUEUED state is gone; the composer is live while `busy`                 |
| harness | composer usable with background agents running, on two palettes             |

`conversation-queue.test.ts` is rewritten, not deleted — it describes a process
model that no longer exists, and the replacement describes the one that does.

## Done when

- Typing while the model works reaches it at the next tool call, in the same
  turn, verified in the running extension and not only in tests.
- The model finishes, agents keep running, the composer is free and the
  indicator is off.
- Stop ends the turn, leaves the conversation usable, and nothing typed is lost.
- Remote Control still works, including across an effort change.
- `bun run lint` clean; the suite green with the queue and cancellation suites
  rewritten.

## Sequencing

Phase 1 deletes `pendingTaskReport`, which is uncommitted in the working tree
right now alongside F2, F3, F5 and F8. **Commit that work first** — it is green
and carries its own tests — so the deletion arrives as a clean diff instead of
mixing with unlanded work.

## Evidence

Probe scripts and captured streams:
`…/scratchpad/probe-steering.mjs` (run 1), `probe-steering-tools.mjs` (run 2),
`probe-steering-print.mjs` and `probe-print-2.mjs` (runs 3–4), with
`steering-events.json` and `steering-tools-events.json` beside them. Re-run them
before trusting any timing above — this file cannot know what the CLI did after
2.1.219.
