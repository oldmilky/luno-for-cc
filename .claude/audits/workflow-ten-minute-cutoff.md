# The ten-minute workflow cutoff — audit

**Date:** 2026-07-29 · **CLI:** 2.1.219 · **Failing session:** `d1e7ad9a` (LUNO)
/ `216e60ac` (CLI) / `wf_496ce05b-45e` (workflow)

## 1. Verdict

The workflow is not killed by LUNO. It is killed by the Claude CLI, by a
documented ceiling in its own print mode, and the CLI says so on stderr — into a
pipe LUNO discards.

In print mode (`-p` with the prompt as an argument and no `--input-format
stream-json`) the CLI waits at most `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`
(default `600000`) for background work once stdin is closed, then terminates
every registered task with `status: "stopped"`, emits `result`, and exits.
LUNO spawns exactly that configuration in **Bypass** and **Plan** modes —
`usesPermissionProtocol` is true only for `default`/`auto`
([claude-cli.ts:329](../../src/providers/claude-cli.ts#L329),
[claude-cli.ts:1768](../../src/providers/claude-cli.ts#L1768)). The failing
session ran in Bypass.

Reproduced outside LUNO, and refuted in the control: same CLI, same model, same
workflow shape, one flag apart.

| Run                                   | argv                                                                             | Workflow lifetime                  | Outcome                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| **probe6** — LUNO's Bypass argv       | `-p "<prompt>" --output-format stream-json --include-partial-messages --verbose` | started 07:53:15.169 → **607.5 s** | `status: "stopped"`, then `result`, process exit 08:03:23      |
| **probe4** — LUNO's default/auto argv | + `--input-format stream-json`, stdin held open                                  | started 07:50:47.121 → **793.7 s** | `status: "completed"` — ran 3¼ min past the ceiling, untouched |
| **probe3** — idle control             | as probe4, no background work                                                    | idle **16 min**                    | process still alive; no idle exit                              |

probe6's stderr, verbatim:

```
Warning: no stdin data received in 3s, proceeding without it. …
Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.
```

## 2. The mechanism, from the CLI's own code

In `print.ts` (identifiers are from the minified 2.1.219 binary):

```js
var Agi = 5000, gpE = 600000;
function wxm() { return Z.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? gpE }
// wind-down window opens only while input is closed and nothing is queued:
if (D /* inputClosed */ && !Hn && !Fr) ji ??= bi; else ji = null, fs = false;
let Wt = wxm(), kr = Wt > 0 && ji !== null && bi - ji >= Wt;   // ceilingExceeded
…
process.stderr.write(`Background tasks still running after ${Math.round(Wt/1000)}s; terminating. Set CLAUDE…`)
Vp(r.id, "stopped", { toolUseId: r.toolUseId, summary: r.description });
```

Two details that match the failing run exactly:

- The sweep is gated on **`inputClosed`**. Under `--input-format stream-json`
  stdin never closes, the window never opens, and the ceiling is unreachable —
  which is why probe4 survived. In Bypass the CLI reports `no stdin data
received in 3s, proceeding without it`, so the clock starts almost at spawn.
- The terminal record is written as `status: "stopped"` with
  `summary = description`. The row LUNO stored at 07:22:40.081 has precisely
  that shape: `status: "stopped"`, `summary` equal to the workflow's own
  description.

## 3. The failing run, reconstructed from disk

| Time (UTC)            | Event                                                                           | Source                                     |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| 07:12:10.966          | `task_started` for `wvm5vx1fe`                                                  | stored timeline                            |
| 07:12:36.713          | model finishes its answer ("Workflow запущен в фоне…")                          | CLI transcript `216e60ac.jsonl`            |
| 07:12:36.8 → 07:22:40 | no further main-thread traffic; agents grinding                                 | CLI transcript                             |
| **07:22:40.081**      | `task_notification` **`status: "stopped"`**, `durationMs 627999`, 252 tool uses | stored timeline                            |
| 07:22:40.480 / .641   | the two live agents record `[Request interrupted by user]`                      | `agent-af637*.jsonl`, `agent-ad39c*.jsonl` |
| 07:22:40.794          | stream ends; the answer generated at 07:12:36 is flushed now                    | stored timeline                            |

629.1 s from task start to the CLI's own verdict; the CLI's internal figure is
627999 ms. probe6's 607.5 s is the same ceiling — the stop lands at the next
sweep tick, not to the millisecond.

## 4. Why LUNO's timers were not involved — and what was measured instead

The previous session's conclusion (`BACKGROUND_TASK_GRACE_MS` firing 90 s after
the last stdout line) is refuted:

- **Neither timer could fire.** `armSilence` is re-armed by every stdout line
  ([claude-cli.ts:945](../../src/providers/claude-cli.ts#L945)) and `armGrace`
  by every line past `result`
  ([claude-cli.ts:1016](../../src/providers/claude-cli.ts#L1016)). Measured gaps
  during a live workflow: median 0.3–3.8 s, p95 47.1 s.
- **In Bypass there is no `result` to arm the grace timer with.** Print mode
  holds `result` until background work is gone — measured across probes 1, 5 and
  6 — so `sawResult` stays false for the whole run and `armGrace` is never
  called at all.
- **The agents were busy, not quiet.** Both survivors made tool calls every
  2–7 s right up to 07:22:38.9, 1.2 s before the stop.
- **No SIGKILL happened.** That path pushes a visible error
  ([claude-cli.ts:818](../../src/providers/claude-cli.ts#L818)); no such row
  exists in the stored timeline.

But the measurement did contradict the assumption the budgets rest on. The
comment at [claude-cli.ts:68](../../src/providers/claude-cli.ts#L68) says 90 s is
"generous against `task_progress`, which fires per nested tool call". It fires
_around_ a nested tool call, never during one: on a `sleep 50` inside a workflow
agent the parent's stdout was silent for the full **47.1 s** between
`task_started` and `task_notification` (probe4; 33.2 s worst case in probe6).

So `BACKGROUND_TASK_GRACE_MS` is not a silence budget — it is a cap on how long
any single nested tool call a workflow makes may take before LUNO ends the turn
and SIGTERMs the CLI. A long build, a large `rg`, or a slow WebSearch inside an
agent exceeds it on merit. And `TASK_REPORT_GRACE_MS` (15 s,
[claude-cli.ts:89](../../src/providers/claude-cli.ts#L89)) is _below_ the quiet
windows measured on healthy runs: any moment `busyWithTasks()` reads false while
work is genuinely outstanding, a normal pause ends the turn.

## 5. Defects on LUNO's side

### D1 — the CLI's verdict is overwritten by a fabricated one · HIGH

A terminal `task_notification` deletes the task from `liveTasks`
([conversation-host.ts:2396](../../src/ui/conversation-host.ts#L2396)), but any
later phase re-inserts it
([conversation-host.ts:2401](../../src/ui/conversation-host.ts#L2401)). A
`task_progress` arriving after the notification therefore resurrects a task that
has already ended, and the turn-end sweep
([conversation-host.ts:2462](../../src/ui/conversation-host.ts#L2462)) files it
as `interrupted`.

Measured in the failing run: 07:22:40.081 stores the CLI's `stopped` with
`taskType`/`workflowName`/`description`; 1.4 s later 07:22:40.794 stores a second
`end` row for the same `taskId` carrying only progress-shaped fields
(`activity`, `durationMs 629397`, `toolUses 253`, `totalTokens`, `lastToolName`).
Having lost `workflowName`, its title degrades from
`Workflow: remote-control-audit` to `Agent`. The user sees the amber
`interrupted` card; the CLI's real answer is buried under it, and the bogus row
is persisted.

### D2 — the explanation is thrown away · HIGH

`onExit` reads stderr only when the exit was unclean
([claude-cli.ts:1022](../../src/providers/claude-cli.ts#L1022)). The CLI exits
**0** here, so `exitFailure` is never called and the line naming the ceiling —
the one sentence that would have ended this in one session instead of four — is
neither shown nor logged. Three sessions of forensics are the direct cost.

### D3 — background work cannot outlive a turn, by construction

The per-turn `finally` always `await terminateChild(child)`
([claude-cli.ts:1055](../../src/providers/claude-cli.ts#L1055)), which SIGTERMs.
Whatever ends the turn — grace timer, silence timer, Stop — takes every
background agent with it. The grace timer only postpones the kill. This is the
problem `.claude/plans/one-process-per-conversation.md` exists to remove.

### D4 — Bypass and Plan have no channel to the CLI at all

Without `--input-format stream-json` there is no stdin stream and no control
protocol: `endTurn`'s `child.stdin?.end()` is a no-op, permissions cannot be
routed, and the process lifetime is entirely the CLI's decision.

## 6. Fixes, in order

All five landed on 2026-07-29. What each one turned into is noted under it.

1. **One line, closes the reported bug.** `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`
   is set to `0` in `childEnv`, with `??=` so a value from the environment still
   wins. It is belt to fix 5's braces: with stdin held open the wind-down never
   opens at all, but no configuration reaching the argv path can be terminated
   behind our back either.
2. **Never swallow a stderr explanation.** `usefulStderr` is now its own helper
   and both exit handlers log through it — the per-turn one on every exit code,
   and the session one, which passed `answered: true` to `exitFailure` and so
   returned null every single time, however loudly the CLI explained itself. A
   clean exit that took running work with it now also surfaces what the CLI
   said, except under our own SIGTERM, which is Stop.
3. **D1 fixed.** `reportedTasks` records every task the CLI itself closed and
   `onSubagentUpdate` drops anything arriving after; `taskIdentity` keeps the
   dispatch-only fields past the end of the card, so a row rebuilt late is still
   named. Regression test: "ignores anything that arrives after the CLI closed
   the task".
4. **Budgets re-derived.** `armGrace` holds the turn while the CLI reports work
   outstanding instead of ending it — the benefit of the doubt the silence
   watchdog already gave, now that quiet is known to mean nothing. The constants
   became re-check intervals and say so. The test that encoded the old deadline
   is now "holds the turn for an agent that goes quiet".
5. **Structural.** `--input-format stream-json` is passed in every permission
   mode and the prompt always goes to stdin; `stdio` is a pipe unconditionally.
   Verified live in both plan and bypass. The larger half —
   one-process-per-conversation — landed alongside this in the same session.

## 7. Reproduction

`probe6.log` / `err6.log` in the session scratchpad. To re-run:

```
claude -p "<prompt launching a Workflow whose script awaits 14 sequential agents,
           each running one 50s Bash call>" \
  --output-format stream-json --include-partial-messages --verbose \
  --model claude-sonnet-5 --permission-mode bypassPermissions
```

Adding `--input-format stream-json` and feeding the prompt on a stdin that stays
open is the control, and it does not reproduce.
