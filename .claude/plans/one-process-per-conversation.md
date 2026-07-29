# One process per conversation

**Status:** commit 1 of 2 implemented 2026-07-29, gates green, **not yet
verified in the running extension**. Written 2026-07-28 after the subagent work
landed and exposed the problem it cannot fix.

What landed: items 1, 2, 3, 5 and 6 — every turn on the long-lived provider,
cancellation through `interrupt`, turn failure separated from session death, the
sweep gated on the process being gone, and the affected suites rewritten. Item 4
(deleting the hold) is deliberately held back: it is pure deletion of the
per-turn reader, and it is safe exactly to the degree that this commit has been
run for real. Until then the per-turn path is unreachable but intact, which is
the fallback if the session path misbehaves live.

One thing the plan did not anticipate, found while implementing: **the process
had to be released, and nothing was releasing it.** `dispose()` reached the
provider only through `abortTurn` → `activeProvider`, which is undefined between
turns, so a tab closed after a turn left a `claude` running with nobody reading
it. It also had to go wherever the conversation stops being the one the process
holds — a new chat, a rewind, an edit, adopting a stored session, a sign-out —
because `--resume` is applied at spawn and nowhere else, so a kept process would
answer the new conversation out of the old one's history. That is
`releaseSessionProvider`, and it is what six of the new tests are about.
**Reviewed 2026-07-29** against the working tree: references refreshed, item 5
found already landed, and two traps corrected — the spawn race the turn gate was
hiding, and what the silence watchdog actually covers.

**Size: large.** It replaces the process model every turn runs on. The pieces
all exist — nothing here needs inventing — but the behaviour it changes is load
bearing, and a naive flip fails 28 tests (see [Why the one-line version
fails](#why-the-one-line-version-fails)).

## The symptom

The model finishes its answer. Three background agents are still running. The
panel keeps showing **Thinking…**, and anything typed lands in **QUEUED**
instead of being sent.

Nothing is wrong with the model — it has said everything it had to say and is
idle. The user is queued behind agents they were never waiting for. On a
workflow of twenty-odd agents that is minutes of a chat that looks busy and is
not.

## Why it happens

A `run_in_background` subagent keeps working after the turn that launched it
ends. Measured against 2.1.220: an agent reported `completed` with its full
answer **5.6 s after** the turn's `result` arrived, and a second `result`
followed ten seconds later once the model had reported on it.

On the per-turn path the CLI process is spawned for one turn and closing stdin
is what ends it. Closing at the first `result` killed every agent mid-step —
which is what the `interrupted` cards were. The fix that shipped holds the turn
open until the agents report (`BACKGROUND_TASK_GRACE_MS`,
[claude-cli.ts:72](../../src/providers/claude-cli.ts#L72)).

That works, and it is the whole problem: the turn is what the UI reads as
"busy". Holding the turn to keep agents alive holds the thinking indicator and
the composer with it. `handlePrompt`
([conversation-host.ts:1834](../../src/ui/conversation-host.ts#L1834)) queues
whenever `this.activeTurn` is set, so the queue is a faithful report of a turn
that genuinely has not ended.

**The indicator is not the bug.** Freeing it while the host still queues would
make the panel lie: the composer would look live and the message would still
wait. The turn has to actually end.

## The shape of the fix

Stop tying the process to the turn. One CLI process per conversation, alive
across turns. Then:

- the turn ends when the model stops talking, at the first `result` — indicator
  off, composer free;
- agents keep running inside a process nobody killed;
- their late `task_notification` arrives with no turn to deliver into and is
  routed to the card it belongs to;
- the hold, its grace timer and its silence budget are deleted.

This is what the official extension does. Verified by reading
`anthropic.claude-code-2.1.220/webview/index.js`: it handles `task_started`,
`task_progress` and `task_notification`, and on `result` clears its live
subagent map (`this.subagentTasks.value = new Map`) rather than waiting on
anything. Its process outlives the turn, so a notification simply arrives later.

## What already exists

Remote Control built the whole path. It is live today whenever the bridge is on,
and it is the reason nothing here needs designing from scratch.

| Piece                                                                 | Where                                                                |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sessionMode` opt and the branch that takes it                        | [claude-cli.ts:722](../../src/providers/claude-cli.ts#L722)          |
| `streamInSession` — a turn against a live process, ends on `done`     | [claude-cli.ts:1009](../../src/providers/claude-cli.ts#L1009)        |
| Turn ends at `result` **without** closing stdin                       | [claude-cli.ts:1277](../../src/providers/claude-cli.ts#L1277)        |
| `route()` — to the turn's sink if one is attached, else `onOutOfTurn` | `claude-cli.ts`, `ensureSession`                                     |
| Out-of-turn task deltas already close their cards                     | [conversation-host.ts:1966](../../src/ui/conversation-host.ts#L1966) |
| The long-lived provider, built on demand                              | [conversation-host.ts:1916](../../src/ui/conversation-host.ts#L1916) |
| Turns already prefer it when it exists                                | [conversation-host.ts:2103](../../src/ui/conversation-host.ts#L2103) |
| `respawnFingerprint` — which argv changes force a new process         | [claude-cli.ts:1609](../../src/providers/claude-cli.ts#L1609)        |

So the change is not "build session mode". It is "make it the only mode, and
make everything that assumed a process per turn stop assuming it".

## Why the one-line version fails

Pointing `runPromptTurn` at the long-lived provider instead of
`createProvider()` typechecks, and then **28 tests fail**. They are not mock
noise — the failures are in `conversation-queue.test.ts`, across queueing,
stopping a turn, and handing an unsent queue back to the composer. Those suites
encode behaviour that a per-turn process gave for free:

- **Stop** killed the process. It no longer can — killing it would end the
  conversation and drop a Remote Control bridge. Cancellation has to become an
  interrupt over the control channel, and everything that waited on the child
  exiting needs another signal.
- **A failed turn** was a dead process. Now the process survives its own
  failure, so "the turn failed" and "the session is gone" stop being the same
  event — `turnFailed`, `returnQueued` and the queue loop all read that.
- **Per-turn argv** was rebuilt every turn. Now `model`, `permissionMode` and
  the working directory move over the control channel, and `--effort` has no
  control request at all, so changing it respawns the process. Anything that
  assumed argv is fresh is wrong.

Nothing on that list is hard. All three are invisible if you only read the diff.

## Work breakdown

1. **Make every turn use the long-lived provider.** `ensureRemoteProvider` is
   the wrong name once it is not about Remote Control — rename it, keep the
   behaviour. Per-turn options continue to go through `updateOptions`.
2. **Cancellation.** `cancel()` must interrupt the turn without taking the
   process. `streamInSession`'s `abortCurrent` already denies pending
   permissions and pushes `done`; confirm it is enough on the real binary, with
   a turn parked on an approval.
3. **Failure.** Separate "this turn failed" from "the session died". The queue
   loop stops on the first; only the second should tear anything down.
4. **Delete the hold.** `BACKGROUND_TASK_GRACE_MS`, `armGrace`, `openTasks` and
   the deferred `endTurn` in the per-turn reader exist only because the process
   died with the turn. With this landed they are dead weight, and the tests in
   `claude-cli-stream.test.ts` that cover them go with them.
5. **The sweep — landed already, 2026-07-29.** Both session-mode call sites are
   now gated on the process being gone: the `done` branch in `onOutOfTurn` on
   `d.sessionEnded`, and `beginRemoteTurn`'s `finally` on `queue.sessionEnded`
   ([conversation-host.ts:2260](../../src/ui/conversation-host.ts#L2260)), which
   is what D1 of the parity audit was. `sweepLiveTasks` itself moved to
   [:2462](../../src/ui/conversation-host.ts#L2462) and carries the invariant in
   its own JSDoc. What remains here is deleting the per-turn caller at
   [:2172](../../src/ui/conversation-host.ts#L2172) along with the per-turn path.
6. **Rewrite the affected suites** rather than patching them. They describe a
   process model that no longer exists.

Land it as **two commits**: (1–3, 6) first — one provider, interrupt-based
cancellation, the suites rewritten — verified in the running extension, and only
then (4), which is pure deletion and is safe exactly to the degree the first was
verified.

## Traps

- **Two turns must never write to one stdin.** `waitUntilIdle` exists for this;
  a prompt sent while the phone holds the session has to wait for that turn's
  `result`, not interleave with it.
- **The turn gate was also serialising the spawn.** `handlePrompt` queues on
  `this.activeTurn`, and that is what stops two quick sends from each reaching
  `ensureSession` and spawning a CLI of their own. `waitUntilIdle` does not
  cover it: `session.busy` is raised after the spawn, not before. Whatever
  replaces the gate needs a promise lock around session creation — this is the
  one place where deleting the queue can leave two processes on one
  conversation, which is the exact failure the queue was written to prevent.
- **A respawn is invisible to the user and fatal to the bridge.** Changing
  effort replaces the process; `--resume` brings the conversation back but the
  Remote Control bridge does not come with it and is re-established explicitly.
- **`--effort` has no control request.** Verified against the binary. If a way
  is found to change it live, most of trap two disappears.
- **The 10-minute silence timeout is not where you think.** `SILENCE_TIMEOUT_MS`
  ([claude-cli.ts:42](../../src/providers/claude-cli.ts#L42)) is armed only
  inside the per-turn `stream()` ([:779](../../src/providers/claude-cli.ts#L779))
  and its action is `child.kill("SIGKILL")` — which is precisely what must never
  happen to a session process. So it is already absent on the path everything is
  moving to, and deleting the per-turn reader removes the last watchdog that
  notices a CLI gone quiet without a tool call. What is left is the per-tool
  `ToolStallWatchdog` and the 10-second `TURN_DRAIN_TIMEOUT_MS`
  ([:487](../../src/providers/claude-cli.ts#L487)). Decide deliberately whether
  anything replaces it; do not discover the answer from a wedged panel.
- **Worktrees.** An isolated conversation runs in its own checkout; the process
  now holds that cwd for the conversation's whole life, which matters when the
  worktree is handed back.

## Done when

- The model finishes, agents keep running, and the composer is free — no
  `Thinking…`, nothing in `QUEUED`, verified in the running extension and not
  only in tests.
- A background agent that finishes after the turn still closes its card with
  its answer.
- Stop ends the turn and leaves the conversation usable.
- Remote Control still works, including across an effort change.
- `bun run lint` clean, the suite green with the queue and cancellation tests
  rewritten rather than deleted.

## Not part of this

Nested subagent disclosure, the shape of the cards, and the AUTO permission
work. They touch the same files and are separate decisions.
