# Subagents and workflows — parity audit against claude-code 2.1.220

## 1. Verdict

The official extension does not model subagent lifecycle at all: the host forwards every SDK message verbatim as one `io_message` envelope (`C:/Users/Rodion/.cursor/extensions/anthropic.claude-code-2.1.220-win32-x64/extension.js:335`), and the webview keeps a live-only map whose sole status value is `"running"`, cleared by `Map.delete` on `task_notification` or wholesale `new Map` on `result` (`.../webview/index.js:1497`) — it never writes a terminal outcome and never persists one. Every confirmed defect below sits in the layer LUNO adds on top of that: persisted terminal statuses, per-turn streams, and a card that renders task fields the official bundle only stores. Four distinct defects survived refutation — one high (a phone turn buries still-running agents and workflows as `interrupted`), two medium, one low; nothing was refuted, and seven further leads were capped before verification.

The three high-severity findings that came in separately (subagents / workflows / "phone-driven turn") are **one defect at one line**, reached through three lenses. They are merged as D1.

---

## 2. Confirmed defects

### D1 — HIGH · A phone-driven turn files every live agent and workflow as `interrupted`

**Change:** `c:/MAIN/WEB/luno-for-cc/src/ui/conversation-host.ts:2253`

**What breaks (measured — every line read on disk, path traced branch by branch):**

`beginRemoteTurn`'s `finally` calls `this.sweepLiveTasks()` unconditionally. Both sibling call sites are guarded and commented; this one is neither:

| site                        | guard                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-host.ts:2172` | `if (providerInstance !== this.remoteProvider) this.sweepLiveTasks();` — "on the session provider it does not [die with the turn], and a backgrounded agent is still working"                                           |
| `conversation-host.ts:1994` | `if (d.sessionEnded) this.sweepLiveTasks();` — with the measured incident at `:1985-1991` ("one agent was closed yellow at 38.6s and reopened green at 107.6s, leaving two closing rows on the timeline for one agent") |
| `conversation-host.ts:2253` | **none**                                                                                                                                                                                                                |

`sweepLiveTasks` (`:2453-2458`) drains the single host-level `liveTasks` map (`:312`, no per-turn ownership) and calls `emitSubagentEnd` (`:2409-2421`), which writes `status: isTerminalTaskStatus(task.status) ? task.status : "interrupted"` (`:2417`) and `scheduleSave()`s it (`:2420`) — so the wrong state is persisted to the stored session, not just shown.

Path to it (traced, not assumed): a phone prompt → `route({type:"remote_prompt"})` (`c:/MAIN/WEB/luno-for-cc/src/providers/claude-cli.ts:1271`) → `onOutOfTurn` → `beginRemoteTurn` (`conversation-host.ts:1957`). That turn's `result` → `route({type:"done"})` (`claude-cli.ts:1279`) with no `sessionEnded`. In `onOutOfTurn` the `!this.remoteTurn` guard at `:1992` **fails** (a remote turn is live), so the delta falls to `this.remoteTurn?.push(d)` at `:2000`, closes the queue, `observe` returns, `finally` runs, sweep fires. The `:1994` guard is bypassed entirely on this path.

Nothing delays it: the `BACKGROUND_TASK_GRACE_MS` / `openTasks` / `pendingTaskReport` machinery lives only inside the per-turn `stream()` (`claude-cli.ts:849-957`); `streamInSession` (`:1009-1131`) has no equivalent and pushes `done` at the `result` itself.

Reachability is the feature's normal case: `run_in_background` defaults to true for Agent (`C:/Users/Rodion/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts:501-504`) and `WorkflowOutput.status` is only `async_launched`/`remote_launched` (`sdk-tools.d.ts:3736`) — a workflow _always_ outlives its launching turn.

**What the user sees:** the card flips to the `interrupted` variant — amber, not red (`webview/src/features/chat/SubagentCard.module.scss:33` and `:116` use `var(--warn)`, with a comment saying it must not share the failure red) with the `x` glyph (`SubagentCard.tsx:113-117`), while the agent is still working. It stays wrong until the real `task_notification` lands, which `foldSubagents` merges later-wins back to `completed`. In the repo's own measured run that gap was ~69 s.

**What persists after it heals:** a bogus extra `subagent`/`end` row on disk, built from the notification alone because `liveTasks` was already cleared, so it lost its own `description`/`subagentType` (`conversation-host.ts:2388-2392`). The user does not see two cards — `groupEvents` keeps `placedTasks` for the whole timeline (`webview/src/features/chat/ChatScreen.tsx:754`, checked at `:967-968`) — the duplicate is in the persisted event log.

**Official:** never synthesises a terminal task status. `handleTaskNotification` is a bare `Map.delete`; the `result` branch is `this.subagentTasks.value=new Map` — both at `.../webview/index.js:1497`. The only status literal ever written for a task in the 4.8 MB bundle is `status:"running"`. A still-running task is dropped from the live map, never mislabelled or saved.

**Fix notes — do not simply delete line 2253.** It is currently the only thing that closes open cards when the session process dies _during_ a remote turn: a `done` carrying `sessionEnded` (`claude-cli.ts:1296`) arriving while `this.remoteTurn` is set also fails the `:1992` guard and is pushed into the queue at `:2000`, so `:1994` never runs for it either. The fix is to make `:2253` conditional on the terminating `done` having carried `sessionEnded` — mirroring `:1994` — which means threading that flag out of the `DeltaQueue`, since the `finally` has no access to the delta today. Also worth moving while you are there: the JSDoc that states the invariant ("Deliberately NOT called at the end of a session-mode turn… sweeping would put 'interrupted' on a card that is about to answer") is **orphaned onto `flushOutOfTurnText` at `conversation-host.ts:2423-2435`**, not onto `sweepLiveTasks` at `:2453`. That is part of why the rule was easy to miss.

**Coverage:** `sweepLiveTasks` appears in no file under `test/`. `test/unit/conversation-subagents.test.ts:578-589` drives a bare out-of-turn `{type:"done"}` — the path that _is_ guarded — and `:639-641` drives `{type:"done", sessionEnded:true}`. `test/unit/conversation-remote-turn.test.ts` drives `remote_prompt` in ten places but contains zero task/subagent events. No test anywhere covers a remote turn with a live task.

---

### D2 — MEDIUM · An uncorrelated `result` ends whichever turn currently holds the sink

**Change:** `c:/MAIN/WEB/luno-for-cc/src/providers/claude-cli.ts:1276-1280`

**What breaks (measured):**

The session reader ends a turn on _any_ `result`, with no correlation to which turn produced it:

```
if (ev.type === "result") { session.busy = false; …; route({ type: "done" }); }
```

`route` (`:1197-1200`) delivers to whatever `session.sink` currently is. The only interlock is `await waitUntilIdle(session)` before the sink is installed (`:1075-1078`), and `session.busy` is set true in exactly two places — `grep -n "\.busy"` returns `:1078` (panel turn) and `:1270` (a replayed prompt recognised as remote). **The extra turn the CLI opens on its own to answer a `<task-notification>` sets neither.**

That last claim is measured, not inferred. `c:/MAIN/WEB/luno-for-cc/test/fixtures/workflow-stream.jsonl` is captured stdout of claude 2.1.219 (`test/unit/claude-cli-stream.test.ts:578`). Lines 20-24 are the CLI's self-opened report turn: `system/init`, `assistant/thinking`, `assistant/text`, `system/notification`, `result`. There is **no `user` record** in that turn, while the panel's own prompt at line 2 _is_ replayed with `"isReplay":true`. So `replayedPrompt` cannot fire, `:1270` never runs, and `session.busy` is provably false for the whole report turn — `waitUntilIdle` (`:1635-1636`) returns immediately and a fresh panel turn installs its sink into a session that is mid-turn.

**Failure:** the user's new prompt is written, `session.sink = push` is installed, and the report turn's already-in-flight `result` is routed into the _new_ turn's sink as `done`. Because `--include-partial-messages` is on (`claude-cli.ts:1707`), the likely symptom is that the new turn absorbs the tail of the CLI's workflow report as its "answer" and then dies at that report's `result`. The real answer then streams out of turn, where only `text` is kept (`conversation-host.ts:1976`); its `tool_use_start`/`tool_result` deltas fall to `this.remoteTurn?.push(d)` with no remote turn (`:2000`) and are dropped — so the reply lands later as one bare assistant paragraph with every tool call missing.

Nothing else guards it: `conversation-host.ts:1840` gates a new prompt only on `this.activeTurn`, which is null after the launching turn ended. The per-turn path's `pendingTaskReport` / `TASK_REPORT_GRACE_MS` mitigation (`claude-cli.ts:89`, `:945-952`) has no counterpart in `streamInSession`.

**The fix key is already on the wire.** Fixture line 24's `result` carries `origin:{"kind":"task-notification"}`. `grep -n origin src/providers/claude-cli.ts` shows `origin` is only ever _written_ (at `:1097`), never read. Gate `route({type:"done"})` at `:1276` on the result's origin being the panel's own turn.

**Precondition:** Remote Control enabled — `sessionMode: true` is set only in `ensureRemoteProvider` (`conversation-host.ts:1946`), whose sole caller is the Remote Control toggle (`:1244`) — plus a background task reporting after its launching turn ended, plus the user submitting during the report turn. That window was ~6 s in `claude-cli.ts:81-82`, 16 s in a prior live run, and the fixture's report turn reports `duration_api_ms 21278`.

**Official:** has no per-turn stream for a foreign `result` to truncate. `extension.js:235` consumes `result` only to flush the transcript mirror, capture error text, and close stdin in single-turn mode, then `enqueue`s it into one continuous stream; the webview just keeps appending (`webview/index.js:1497`).

**Coverage:** none. No test in `conversation-remote-turn.test.ts` or `claude-cli-stream.test.ts` exercises the sink interlock.

---

### D3 — MEDIUM · `task_progress.summary` is rendered under the label "Answered" while the task is still running

**Change:** `c:/MAIN/WEB/luno-for-cc/src/providers/claude-cli.ts:2819` (and optionally a `running` guard at `webview/src/features/chat/SubagentCard.tsx:198-207`)

**What breaks (measured):**

`taskUpdate` copies `summary: ev.summary` on every phase. The neighbouring fields _are_ phase-gated — `description: phase === "progress" ? undefined : ev.description` and `activity: phase === "progress" ? ev.description : undefined` at `:2810-2811` — so the omission is specific, not blanket passthrough. The contract it violates is written down: "The subagent's answer, handed back to the main agent. `notification` only." at `c:/MAIN/WEB/luno-for-cc/src/core/types.ts:170-171`, field at `:172`.

`onSubagentUpdate` merges it with `stripUndefined` (`conversation-host.ts:2556-2560`), so once set it persists across later events, and posts it as `subagentProgress` at `:2406`. `App.tsx:286-290` spreads it into `taskProgress`; `ChatScreen.tsx:1136` is `{ ...stored, ...live, taskId }` — **live wins**; `SubagentCard.tsx:47` is `const body = task.summary?.trim()` and `:198-207` renders it under `{failed ? "Failed with" : "Answered"}` (`:201`) with **no running guard**.

The wire data is byte-for-byte in the repo: `test/fixtures/workflow-stream.jsonl` line 7 is `task_started` with `description:"probe run for a stream audit"`; lines 8, 10, 11, 14 are `task_progress` each carrying `summary:"probe run for a stream audit"` — the identical string. Line 8 is stamped `duration_ms: 22`. The real, different summary arrives only at line 17 (`task_notification`: `"Dynamic workflow \"probe run for a stream audit\" completed"`).

So 22 ms after launch the still-spinning card has an expandable section headed **Answered** containing the workflow's own description. It reads as a real answer rather than an obvious echo, because the card header shows `activity` instead (`SubagentCard.tsx:271-278`, with `lastToolName` deleted for workflows at `conversation-host.ts:2386`).

**Two impacts beyond the running card:**

- Between `task_notification` and `turnEnd` the _finished_ card also shows the stale progress summary. `onSubagentUpdate` deletes the task from `liveTasks` on notification (`:2388-2392`) but never posts a message clearing the webview's `taskProgress` entry; the only clear is `turnEnd` (`App.tsx:284`). Live outranks stored, so the wrong string beats the correct notification summary.
- It is what makes D1's persisted damage carry a bogus answer: `emitSubagentEnd`'s `meta: { ...task }` spread (`conversation-host.ts:2414-2415`) carries the progress-copied `summary`, and `foldSubagents` builds the card from `e.meta` alone (`webview/src/features/chat/subagent-state.ts:55-59`). Without the progress copy, `meta.summary` would be undefined and the restored card would render no "Answered" section at all. (The `body:` fallback at `:2413` is not the mechanism — the card never reads it.)

**Official:** reads the same field into its store (`summary:t.summary??i.summary`) and additionally uses its mere presence as a suppressor for the tool ring (`if(!t.summary&&o&&o!==n?.[n.length-1])`) — i.e. it knows the string is not an answer. Nothing renders it: all 18 `subagentTasks` references are inside the store class on `webview/index.js:1497`, and the Agent renderer is `renderOutput(){return null}` (`webview/index.js:2036`). Wider still: `handleTaskStarted` early-returns unless `task_type === "local_agent"`, so the official never tracks a workflow at all.

**Scope caveat:** proven for `local_workflow` from the repo fixture. Whether plain `local_agent` progress also carries `summary` is **inferred** — the official's `!t.summary` gate lives in a path that only runs for `local_agent`, which would be dead code otherwise.

**Coverage:** none. `claude-cli-stream.test.ts:602-634` asserts nothing about `summary`; across all three test files `summary` appears only on `notification` payloads; `SubagentCard` has no render test, acknowledged at `test/webview/subagent-state.test.ts:272-274`.

---

### D4 — LOW · `classifyTool` only knows the legacy `Task` name

**Change:** `c:/MAIN/WEB/luno-for-cc/webview/src/features/chat/tool-buckets.ts:75`

**What breaks (measured):** `if (n === "task") return "task";` is the only dispatch match. Reading all of `classifyTool` (`:71-103`) confirms no branch matches `agent` or `workflow` — `/bash|run|shell|exec/` matches neither — so both fall to `return "other"` at `:103`. Against the shipped CLI the `task` bucket ("Dispatched N agents", `layers` icon, `:51-55`) is **dead code**: across on-disk transcripts `"name":"Agent"` appears 219 times as a real tool_use name, `"name":"Workflow"` 71 times, `"name":"Task"` **zero**. The repo already has the right set one file away: `TASK_TOOL_NAMES = new Set(["Agent", "Task", "Workflow"])` (`webview/src/features/chat/subagent-state.ts:26`).

On the documented fall-through at `ChatScreen.tsx:889-908` (when `taskIdByToolUse` has no entry yet), the dispatch renders with verb "Ran" and the `code` icon (`tool-buckets.ts:58`), and `shortTarget` (`ToolGroupCard.tsx:113-128`) finds no `path`/`command`/`pattern`/`query`/`url` in an `AgentInput` (`sdk-tools.d.ts:484-521`), so it falls back to the bare tool name: "Ran Agent", or "Ran 2 tools" when two dispatches merge. The official aliases in the other direction — `let n = e==="Task" ? "Agent" : e` — and renders `Agent: <input.description>` straight off the tool_use block from the instant it lands (`.../webview/index.js:2036`), with no dependence on `task_started`.

**Corrections to the severity:** the mislabel is **transient**, not permanent — the chip is replaced by the SubagentCard once `task_started` arrives (`ChatScreen.tsx:889-899`), and `ChatScreen.tsx:965-973` places a card from the `subagent` event alone even when the tool_call was never matched. The window from the fixture's own timestamps is 142 ms (record 4 at 11:55:04.634Z → record 9 at 11:55:04.776Z), plus the remaining stream time of the assistant message (~1.9 s measured for the first of two dispatches in one message). And `Workflow` is **not** a parity gap: the string "Workflow" does not occur anywhere in the official 2.1.220 webview bundle, so it has no Workflow renderer either. Only the `Agent` half is a real divergence. Fix is one line; severity is low.

**Coverage:** `test/webview/tool-buckets.test.ts:18` pins only `classifyTool("Task") === "task"` and never exercises `Agent` or `Workflow` — while `test/webview/subagent-state.test.ts:130` states "2.1.220 sends `Agent`. `Task` is what older sessions on disk still say".

---

## 3. Not defects

Nothing was refuted. Every finding put to the skeptic survived; the four above are the deduplicated result. No candidate needs to be re-derived as a dead end.

---

## 4. Unverified (reported, verification capped — treat as leads, not findings)

- **lifecycle, medium** — No `task_type` gate: a backgrounded Bash may become an "Agent" card and hold the per-turn turn open on the 90 s background grace.
- **lifecycle, medium** — `replayedPrompt` has no `isSynthetic`/`isMeta`/`origin` guard, so a CLI-injected user message could become a phantom phone turn — which then runs D1's unconditional sweep.
- **lifecycle, medium** — A `task_updated` arriving after `task_notification` resurrects a closed task into `liveTasks`, producing a second closing row at the next sweep.
- **lifecycle, low** — `emitSubagentEnd` may overwrite the CLI's own terminal status `killed` with `interrupted`, and `openTasks` treats it as still running.
- **coverage, low** — `task_notification` appears to use `""` as its absent-marker for `summary`/`output_file`, and LUNO's `??` chains treat `""` as a present value.
- **workflow, medium** — F2 is recorded as closed but only the `local_workflow` arm was fixed; a `remote_agent` workflow may still render as a subagent named "Agent" with all four original symptoms.
- **workflow, low** — A completed workflow gives the user no path to its transcript, where the official extension prints one.

---

## 5. What this audit could not determine

1. **End-to-end execution of D1 and D2.** Both were traced statically through the code and confirmed against a captured stream, but never _run_. The audit was read-only, so no turn was executed. **To close it:** one live run with Remote Control on and a second device — dispatch a `run_in_background` agent from the panel, send a short prompt from the phone while it is in flight, and capture the CLI's stdout to jsonl. That single recording confirms or kills both D1 (the `interrupted` row must appear in the saved session before the agent's real notification) and D2 (submit a panel prompt during the report turn and watch whether the answer truncates).

2. **Whether a foreground agent (`run_in_background: false`) emits `task_started` at all.** 67 of 218 unique real dispatches on disk are foreground, but the on-disk transcripts do not persist the stream-json `system` records, so this could not be tested. It is the one path that could make D4's mislabel long-lived rather than transient. **To close it:** capture stream-json for a foreground `Agent` dispatch.

3. **Whether plain `local_agent` `task_progress` carries `summary`.** The only fixture in the repo is a workflow. D3 is proven for `local_workflow`; the agent case is inferred from the official bundle's `!t.summary` gate living in a `local_agent`-only path. **To close it:** capture stream-json for a background agent and grep the `task_progress` records.

4. **The rendered pixels for D1 and D3.** No harness run was performed (read-only), and `SubagentCard` has no render test (`test/webview/subagent-state.test.ts:272-274`). Both render claims are one inference step off unconditional JSX branches. **To close it:** drive the harness with a synthetic `subagentProgress` carrying `summary` on a running task, and a stored `end` event with `status:"interrupted"`.

5. **The CLI's full terminal-status vocabulary.** `completed`/`failed`/`stopped`/`killed` were read as string literals out of `claude.exe`; the set is not provably exhaustive, which matters for `isTerminalTaskStatus` (`src/core/types.ts:239-254`) and for the unverified `killed` lead. **To close it:** enumerate the `Vp(` call sites systematically rather than by grep sampling, or force a stop/timeout in a live run.
