# Carried forward — what outlived four finished plans

Four plans and four audits were deleted on 2026-07-31 once the work they
described had landed and been verified against the code. This file is the part
of them that a re-read of the codebase cannot recover: **measurements against
the real binary**, and **work deferred on purpose, with the reason**.

Nothing here is a proposal. Everything here is either a fact that cost a probe
or a decision already made.

| Deleted                                 | Landed as                                       |
| --------------------------------------- | ----------------------------------------------- |
| `plans/one-process-per-conversation.md` | `81e8530`, except item 4 — see below            |
| `plans/steering-mid-turn.md`            | `81e8530` (phase 1); phase 2 still uncommitted  |
| `plans/subagents-and-workflows.md`      | `83efbf3`, `90783e5` — F1–F3, F5, F8            |
| `plans/subagents-live-run-findings.md`  | folded into the above                           |
| `plans/remote-control.md`               | `d51d5e6`, `da7be5f`                            |
| `audits/remote-control-vs-official.md`  | nine fixes, 2026-07-30/31, each with a test     |
| `audits/subagent-parity.md`             | D1, D3, D4 verified in code; D2 with `81e8530`  |
| `audits/workflow-ten-minute-cutoff.md`  | D1–D4 in `81e8530`; **D5/D6 still uncommitted** |

`git log -- .claude/plans .claude/audits` reaches the full text of most of them.
Two exceptions, which is why this file is longer than it wants to be:
`remote-control-vs-official.md` was never tracked, and the D5/D6 section of
`workflow-ten-minute-cutoff.md` was written after its last commit. Everything
below that is sourced from those two exists nowhere else.

---

## Measured against the CLI — do not re-derive

All of it against `claude` 2.1.219 with the raw stream captured, or read out of
the shipped `anthropic.claude-code` 2.1.220 bundles. The CLI moves; re-measure
before betting a design on a line here.

### Steering — a second `user` message on stdin

Delivery happens **at a tool boundary**. Four runs:

| #   | Mode    | Injected | Echo (`isReplay`) | What the model did                  |
| --- | ------- | -------- | ----------------- | ----------------------------------- |
| 1   | session | 2 522 ms | 43 211 ms         | nothing — no tool boundary existed  |
| 2   | session | 6 218 ms | 7 370 ms          | obeyed; dropped 5 pending reads     |
| 3   | `-p`    | 6 554 ms | 7 711 ms          | read all six anyway, never complied |
| 4   | `-p`    | 8 158 ms | 9 221 ms          | obeyed; zero tool calls after       |

Runs 2 and 4 ended with **one** `result` carrying `num_turns: 2` — the injected
message belonged to the turn in flight. Run 1 had no tool call at all, so the
CLI opened a second turn for it by itself.

Three conclusions, the third being the one that matters: pure text generation
has no boundary, so a message sent into it waits — physics, not a defect; the
transport works in **both** process modes, `-p` is not the obstacle; and whether
the model abandons work in progress is **the model's judgement, not the
channel's** — runs 3 and 4 are the same mechanism with opposite outcomes.

`still_queued` holds only what was written and **not yet accepted**. A message
the turn had already echoed back 1.0 s before an `interrupt` was not in it, and
was never answered — the turn died at `result/error_during_execution`.

### `interrupt` stops background agents — a prohibition, not a preference

Written at 9.28 s; `task_updated` and `task_notification` with
`status: "stopped"` for the running agent at **9.29 s**, 10 ms later.

**No send path may go through `interrupt`.** Asking "how far along are the
agents?" mid-run must not cost the run. Steering is a plain stdin write and
disturbs nothing — measured in the same run, the agent kept working from the
write at 7.78 s until the interrupt 1.5 s later.

### Workflows are launched, not run

`WorkflowOutput.status` is `"async_launched" | "remote_launched"` — there is no
synchronous branch (`sdk-tools.d.ts:3735`). A workflow **always** outlives the
turn that launched it. Observed sequence for one workflow with one agent:

```
1 background_tasks_changed   tasks: [{task_id, task_type, description}]
2 task_started               task_type:"local_workflow", workflow_name, prompt = script
3 task_progress ×4           usage, last_tool_name, workflow_progress[]
4 background_tasks_changed   tasks: []          ← roster empties HERE
5 task_updated               patch: {status:"completed", end_time}
6 task_notification          status, output_file, summary, usage
7 result                     the launching turn ends
8 system/init → assistant → result   ← a SECOND turn, origin.kind = "task-notification"
```

Step 8 is the user-visible payoff: the CLI queues a synthetic
`<task-notification>` prompt and the model reports the outcome.

`workflow_progress` entries carry one record per phase and per agent, with live
`state`, `tokens`, `toolCalls`, `durationMs`, `resultPreview` — a whole progress
UI already computed.

**The roster empties one event before the terminal status and two before the
summary.** This is why F4 was deferred; see below.

### Print wind-down

The measurement that killed workflows at 10m07s now lives as a comment beside
the code it constrains — `buildArgs` in `src/providers/claude-cli.ts`, at the
unconditional `--input-format stream-json`. Read it there, not here.

### Remote Control

- The **control request is the only door.** `--remote-control` is silently
  ignored in headless mode and `/remote-control` is absent from the
  `slash_commands` list the CLI reports on `init`.
- Status arrives as `system` / `bridge_state`. The 2.1.219 string pool beside
  `[bridge:sdk] State change:` interns `failed · connected · ready`;
  **`disconnected` does not appear in the binary at all** — it is the official
  extension's own word for "off". Whether a live bridge emits `failed` _after_ a
  successful connect is still unmeasured.
- `/rc` and `/remote-control` are intercepted in the official composer and never
  sent to the model — a UI command, not a prompt.
- The binary carries `permission_bridge_relay` and `bridge_attachment_upload`:
  approvals and attachments are relayed by the CLI, not by the client.

Constraints that are not ours to negotiate: **claude.ai OAuth only** (it refuses
under an API key or `setup-token`, so the stored token must not be injected as
`ANTHROPIC_API_KEY` on a bridged session); `api.anthropic.com` only;
workspace trust already accepted; `disableRemoteControl` is a **managed**
setting and honouring it is not optional; and the transcript is **stored on
Anthropic servers** while connected — say so in the UI rather than burying it.

### Two smaller ones

- A second `system/init` mid-session is **normal** — it arrives on a follow-up
  turn with a different tools list as MCP servers finish connecting. Anything
  treating `init` as "a new session started" mis-fires on it.
- LUNO reads `patch.status` from `task_updated`; the official extension ignores
  that event entirely and closes on `task_notification` alone. Both fire, back
  to back. Ours is stricter, not wrong — but it is an undocumented dependency on
  a phase Anthropic's own client does not consume, so it can be removed at any
  version. `task_notification` is sufficient. **Watch it.**

---

## Deferred on purpose

### Delete the per-turn path — `one-process-per-conversation` item 4

`BACKGROUND_TASK_GRACE_MS`, `armGrace`, `openTasks`, the deferred `endTurn` in
the per-turn reader, the per-turn `sweepLiveTasks` caller, and the
`claude-cli-stream.test.ts` tests that cover them exist only because the process
used to die with the turn.

Verified 2026-07-31: `stream()` still branches at `src/providers/claude-cli.ts`
on `this.opts.sessionMode`, and `sessionMode: true` is set at exactly one call
site (`src/ui/conversation-host.ts`). The path is **unreachable but intact** —
deliberately, as the fallback if the session path misbehaves live. It is pure
deletion, and it is safe exactly to the degree the session path has been run for
real.

### F4 — `background_tasks_changed` as the source of truth for what is live

Blocked by the measurement above: the roster empties one event before the
terminal status. Closing cards on an empty roster files every task as unfinished
a moment before its answer lands. Every safe wiring needs either a debounce with
an invented millisecond value or a new "ended, outcome unknown" card state, and
neither is justified by a failure anyone has seen. The sweep it would replace is
correct today.

### F6 — `recentTools`, last 3

A change to the collapsed subagent card's shape, for a LOW finding. Worth doing
next to any other card work, not on its own.

### Open — a process released in silence

`rewindTo`, `editAt` and `adoptStored` release the session process without
checking for live work. Rewinding or editing rewrites the conversation those
agents belong to, so ending them is defensible; doing it **silently** is not.
`releaseSessionProvider` logs what it takes down everywhere else, naming the
open task count. These three paths do not.

---

## Rescued from two documents git never kept

### D5/D6 — fixed in the working tree, not yet committed

Both HIGH, both the same family as the ten-minute cutoff: something took the
process away and the panel was never told. Found 2026-07-29 in the extension
host, not in a probe. `liveSessionOrSpawn` is in `src/providers/claude-cli.ts`
and **not in `HEAD`** — this fix rides with the current uncommitted change.

**D5 — the Remote Control toggle rebuilt argv without a model.**
`enableRemoteControl` called `ensureSession(buildArgs("", undefined, this.opts))`.
The toggle has no turn behind it, so it has no `req.model` and no session task
type, and argv rebuilt without them does not match what the process is running —
the fingerprint diff read `--model -default` _leaving_, not `--resume` arriving.
`respawnFingerprint` strips `--resume` and `--mcp-config` precisely so this
cannot happen; nothing stripped a **missing** `--model`. Worse than one kill: the
replacement was spawned without `--model`, so the next ordinary turn would
rebuild argv _with_ one and replace it again — a respawn per turn, each handing
the phone a session URL nobody holds. The fix is `liveSessionOrSpawn()`: the
toggle takes the live session as it is and spawns only when there is none. It is
the one path that must never replace a process, being also the path whose whole
purpose is a bridge that survives.

**D6 — a turn reading a process that is taken away is never told.**
`disposeSession` set `session.sink = null` and _then_ killed the child. The exit
handler routes `{type:"done", sessionEnded:true}`, but `route` delivers through
`session.sink` — already null — so it went out-of-turn, where the host flushes
text and sweeps tasks and **ends no turn**. The generator sat on its resolver
forever: no `done`, no `turnEnd`, `busy` true until the window was reloaded.

### Remote Control vs. the official client — nine fixes, 2026-07-30/31

Produced by a 14-agent workflow (1.98M subagent tokens, 621 tool calls, 48 min;
21 raw findings → 3 confirmed defects, plus a second skeptic pass). Each fix has
a test that was verified by reverting the fix and watching it go red, not by
inspection:

| Finding                                        | Where                                                    |
| ---------------------------------------------- | -------------------------------------------------------- |
| `remote_control` delta dropped mid-turn        | `onTurnDelta` branch, `conversation-remote-turn.test.ts` |
| `bridgeStatus` rejected `failed`               | maps it to `error`, `claude-cli.test.ts`                 |
| "Allow this turn" became standing              | cleared at `result`, `claude-cli-stream.test.ts`         |
| `steer_turn` split a phone-driven turn         | `!session.sink && !session.busy`, ″                      |
| A late enable reply revived the pill           | `remoteControlInFlight` released on disable, ″           |
| A mode change never reached a phone turn       | `setLivePermissionMode`, pushed from the picker          |
| `can_use_tool` with no turn open was dropped   | routed in `onOutOfTurn`, answered via `sessionProvider`  |
| Follow-on: the model was stale on a phone turn | `setLiveModel`, pushed from the picker                   |

A ninth landed on 2026-07-31, found by eye on claude.ai rather than by any
audit: **the turn preamble rode on every message.** `turnPreamble` travels as
message text, not argv — argv is frozen at spawn — so it is part of the user
message every surface sharing the session renders. In the panel it is invisible,
because the panel draws its own timeline; on claude.ai it was a wall of "What
the user is looking at" above every single thing the user typed. Now sent only
when it moves, recorded on `CliSession.preamble` **after** the write is
accepted, so a refused write does not lose it. This refines the decision the
deleted `steering-mid-turn.md` recorded ("carry it" on every steered message) —
that was decided before Remote Control showed the transcript to a third party.

**Two deliberate divergences from what that audit proposed**, both to avoid
trading one defect for a worse one — do not "fix" them back:

- **A refused mode change is left standing, not answered with `disposeSession()`.**
  A respawn takes every background agent and the Remote Control bridge with it.
  The only transition the CLI refuses is _entering_ Bypass — a loosening, which
  arrives by itself on the user's next message from the panel. Failing towards
  more prompts is the safe direction.
- **The turn-end sweep retires only the prompts that turn raised.** Clearing all
  of them destroyed a background agent's request id; denying all of them would
  kill a prompt the phone is still showing. `streamInSession` tracks the ids that
  passed through its own sink.

### The other per-turn options cannot be pushed at all — settled, do not retry

The audit asked for `model`, `effort`, `thinking`, `ultracode`, `disabledSkills`
and `allowedBashPatterns` to be synced on a phone-driven turn. Only the model
can be: **the CLI's entire live-setter vocabulary is `set_model` and
`set_permission_mode`.** The rest reach it through argv — `--effort`, the
`--settings` JSON carrying `alwaysThinkingEnabled` and `ultracode`,
`--allowedTools`, `--append-system-prompt` — and argv cannot be rebuilt under a
running process. Delivering them means replacing it, which on a phone-driven
turn is the defect the whole audit is about. Verified by grep: none of those
options has a reader outside `buildArgs`. `getToolGrants` needed nothing — it is
a callback and reads live state per request.

`setLiveModel` holds back one case on purpose: a model whose `EFFORT_LADDERS`
entry disagrees with the running one about the current level. The level is an
argv flag, so pushing the model alone would leave the process at a level its own
ladder does not list. That change waits for the panel turn that replaces the
process and carries both.

### Confirmed defect 1 is only half closed

The working-tree `respawnFingerprint` now strips `--model`, which closes the
route the audit described: `/rc` spawns without `--model`, the first ordinary
turn adds one, and the fingerprints no longer diverge over it. Two routes
survive, both named in that finding's own scope note:

- `--effort`, when a pinned model's ladder excludes the current level;
- `--append-system-prompt` in plan mode, because the `/rc` spawn records
  `taskType: undefined` and `streamInSession`'s `session.taskType ?? opts.taskType`
  therefore falls through to the freshly classified one instead of keeping the
  session's. The comment there promises the opposite of what `??` does for a
  session spawned without one.

### `ANTHROPIC_API_KEY` — probed 2026-07-31, and the reason in the code was false

`childEnv` deletes the key when a bridge is wanted, on the stated grounds that
"Remote Control refuses to start under an API key". Two probes against 2.1.219
say otherwise:

- **Invalid key in the env:** the session came up and
  `remote_control{enabled:true}` answered `success` with a `session_url`. The
  bridge is not gated on the key's absence.
- **Valid key in the env:** a turn ran to `result` `success`, with the same cost
  shape as the same turn without it. `total_cost_usd` is reported either way, so
  it does not discriminate the billing route — but the account behind the key was
  unfunded, and an API-billed call would have failed on credit. The CLI is
  therefore using its own OAuth credentials and ignoring the env key when both
  exist. Strong, not airtight: the clean version of this test needs a machine
  with no `~/.claude` login.

Consequences:

1. The unverified HIGH ("the withholding is bypassed on any conversation with a
   live process") loses its consequence. `liveSessionOrSpawn` reusing a keyed
   process removes no defence that was doing anything, and the `keyed`-on-session
   repair the audit proposed would have bought a respawn — killing background
   agents and the bridge — for nothing. **Do not build it.**
2. The comment in `childEnv` was corrected in place — it had asserted the
   refuted claim as fact.
3. **The live bug this exposed — fixed.** The other half of the same three
   lines read
   `if (this.opts.token && !wantsBridge) env.ANTHROPIC_API_KEY = this.opts.token`.
   A user who signed in by pasting a token — the fallback path, when
   `claude setup-token` was not usable — has that token injected _as_ the key.
   Pressing `/rc` set `wantsBridge`, so the token was withheld and any inherited
   key deleted: the CLI was handed no credential at all. The `&& !wantsBridge`
   is gone; the deletion of an _inherited_ key stays, as cheap cover for the one
   half still unmeasured. Gating the _injection_ on the bridge only ever made
   sense under the refuted premise.

---

## Live runs still owed

- **Steering phase 2** — built, gated, verified in the harness on 2026-07-29,
  uncommitted, and never run against a real CLI in the extension host.
- **One process per conversation** — commit 1 of 2 has not been run for real
  either, and item 4 above is gated on that.
- **Two probes never taken**, both about steering: where a message sits when the
  turn is parked on a permission prompt and whether it survives a deny; and
  whether a message written into a process that is then respawned on `--effort`
  should be refused up front or re-written into the new process. The respawn's
  worse half — a turn never told its process had gone — is already fixed.

---

# Permission-mode parity — what outlived its plan

`plans/permission-modes-parity.md` was deleted on 2026-08-01 once Ф0–Ф5 had
landed and been verified against the code. It was never tracked, so `git log`
does not reach it. Below is the part a re-read of the codebase cannot recover.

## Measured against the CLI — do not re-derive

Five probes on 2026-08-01 against `claude` 2.1.219, spawned exactly as LUNO
spawns it: session mode, stream-json both ways, `--replay-user-messages`,
`--permission-prompt-tool stdio`, with the control channel answered.

| Mode   | `--settings`                        | Prompt                      | `can_use_tool` |
| ------ | ----------------------------------- | --------------------------- | -------------- |
| `auto` | `permissions.ask: ["Bash(echo:*)"]` | `echo hello-from-probe`     | **1**          |
| `auto` | none                                | the same `echo`             | **0**          |
| `auto` | `disableAutoMode: "disable"`        | `bun --version`             | **1**          |
| `auto` | none                                | `rm -rf <path outside cwd>` | **0**          |

Four things follow, and none of them are re-derivable by reading code:

1. **Escalations in `auto` do reach `--permission-prompt-tool stdio`.** The
   channel LUNO already speaks is the right one.
2. **A matched `permissions.ask` rule makes the CLI skip its own classifier and
   prompt instead.** The first two rows are the same command; the rule is the
   only difference. This is why the git `ask` injection is confined to
   `default`/`acceptEdits` — under `auto` it would card every git call.
3. **A refused `auto` downgrades in silence** — no error, no warning — and
   `system/init` reports the mode it actually took. That report is the whole of
   the fallback switch, and it is why `disableAutoMode` needs no code here: the
   CLI enforces it and announces it.
4. **`rm -rf` outside the working directory, asked for in plain words, ran with
   no card at all.** A SOFT BLOCK cleared by explicit user intent, working as
   documented. This is the behaviour change users notice first.

Requests also carry `decision_reason_type`: `"rule"` when an `ask` entry
matched, `"other"` for `default`'s plain "this command requires approval"
(which also carries `decision_reason` and `permission_suggestions`).

## The auto-mode deny path — read, not measured

Never observed live. An exfiltration-shaped probe never reached the classifier:
the API's own safeguards refused it first (`system/model_refusal_no_fallback`,
`api_refusal_category: "cyber"`), a different layer entirely. A direct request
is the wrong instrument anyway — asking for the risky thing is what clears the
soft tier. From the 2.1.219 binary:

- classifier **allows** → the tool runs, nothing reaches the client;
- classifier **blocks** → `{behavior:"deny", message}`, a `tool_result` error to
  the model, and **no `can_use_tool`** — no card, no override;
- **fail closed** — an unavailable classifier denies rather than asks;
- only past a **denial limit** does it fall back to prompting, and in headless
  it throws: _"Agent aborted: too many classifier denials in headless mode"_.

The only thing separating a denial from a broken tool on the wire is the
sentence the CLI opens with, kept as `AUTO_MODE_DENIAL_PREFIX`. **If Anthropic
rewords it, the amber card silently reverts to a red error.** That constant and
its test are the whole defence.

## Decisions already made — do not "fix" these back

- **`allowDangerouslySkipPermissions` is deliberately not adopted.** The
  reference treats Bypass as opt-in and hides it unless the key is set; LUNO
  honours the *prohibition* (`disableBypassPermissionsMode`) and does not newly
  demand a permission it never required. Divergence, on purpose.
- **Under native `auto`, a user's own `permissions.allow` for git is back in
  play**, because the `ask` injection is gone there. A project allowlist can let
  `git clean` past the classifier. That is what the reference client does too,
  and second-guessing the user's own allow rule is the thing we chose not to do.
- **Shell runners are parsed rather than left to a looser pass.** Anchoring the
  destructive gate to the command position introduced exactly one false negative
  — `bash -c "rm -rf x"` reads as a `bash` — which the old whole-line scan
  caught by accident. `sh`/`zsh`/`powershell`/`pwsh`/`cmd` are unwrapped at
  `-c`/`/c`. Both guards are mutation-tested; reverting either turns
  `still finds the command wherever the line puts it` red.
- **Giving a refusal its own state took it out of every `isError` test
  elsewhere.** `ToolGroupCard` decided its collapsed header on
  `items.some(i => i.isError)` and so drew a green tick over a call that never
  ran — caught only by demonstrating it. Worth remembering as a shape.

## Live runs still owed

**Nothing from Ф0–Ф5 has run inside a real extension host.** All of it was
verified by a probe against the CLI, by unit tests, and in the browser harness —
and the spawn, the permission decisions and the control protocol all live on the
far side of `postMessage`. The four that matter, in the panel:

- read-only `git log -S"…"` in **Ask** raises no card (the reported bug);
- `rm -rf`, `find … -delete`, `kill -9` and `bash -c "rm …"` in **Ask** still do;
- an explicitly requested `rm -rf` in **Agent** passes with no card;
- and whether the output channel says
  `the CLI took permission mode …, not auto` — if it does, native auto is
  unavailable on this account and every Agent expectation collapses to Ask's.
