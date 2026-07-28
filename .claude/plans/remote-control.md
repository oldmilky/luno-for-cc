# Remote Control

Drive a LUNO conversation from the Claude mobile app or claude.ai/code, the way
the official CLI and VS Code extension do. Decided 2026-07-27; it used to sit in
the "deliberately not chasing" list in `remaining-features.md` and no longer
does. The dependency on Anthropic infrastructure is accepted, not worked around.

## What Remote Control actually is

One control-protocol request on the channel LUNO already holds open. The
official VS Code extension 2.1.220 does exactly this and nothing more:

```js
// extension.js, official extension
async enableRemoteControl(e, t) {
  return (await this.request({ subtype: "remote_control", enabled: e, ...name })).response
}
```

Verified against the real binary (2.1.219), not read from docs — a probe that
spawned `claude` with LUNO's own flags and wrote one `control_request` got a
live session back:

```
>> system/bridge_state  {"state":"ready"}
>> control_response     {"subtype":"success","response":{
                          "session_url":"https://claude.ai/code/session_01G4…",
                          "connect_url":"https://claude.ai/code?environment=",
                          "environment_id":""}}
>> system/bridge_state  {"state":"connected"}
```

Everything else that was checked first-hand:

- **`--remote-control` is silently ignored in headless mode**, and
  `/remote-control` is absent from the `slash_commands` list the CLI reports on
  `init`. The control request is the only door.
- **Status arrives as `system` / `bridge_state`** with `state` of `ready`,
  `connected`, `disconnected` or `error`. That is the event the banner reads.
- **`/rc` and `/remote-control` are intercepted in the composer** by the
  official extension and never sent to the model — a UI command, not a prompt.
- The CLI binary carries `permission_bridge_relay` and
  `bridge_attachment_upload`, so approvals and attachments are relayed by the
  CLI itself rather than by the client.

## The blocker: LUNO spawns a process per turn

`stream()` in `src/providers/claude-cli.ts` spawns a child, writes one user
message, and lets the process die when `result` lands; the next turn is a new
process with `--resume`. The official extension keeps **one long-lived process**
— its argv has no `--print` at all.

A Remote Control session lives exactly as long as its process. On the per-turn
model the phone drops the moment the first answer finishes. There is no way
around this: the long-lived session path is the feature.

## Constraints that are not ours to negotiate

- **claude.ai OAuth only.** Remote Control refuses to start under an API key or
  a `setup-token`. `src/providers/claude-cli.ts` injects the stored token as
  `ANTHROPIC_API_KEY` when one is present — that must not happen on a session
  with Remote Control enabled, or it fails with an unhelpful message.
- **`api.anthropic.com` only** — no Bedrock, Vertex/Agent Platform, Foundry, and
  no `ANTHROPIC_BASE_URL` pointing anywhere else.
- **Workspace trust** must already be accepted for the directory.
- **`disableRemoteControl`** is a managed setting. Honour it — overriding it
  would be walking around an IT policy.
- The session transcript is **stored on Anthropic servers** while connected.
  That is the deal; say so in the UI rather than burying it.

## Phases

**Ф0 — done, 2026-07-27.** Measured against 2.1.219 with a real remote client
driving the session. Four findings, all reproduced in a log:

- **`--replay-user-messages` brings the remote prompt back to us** as an
  ordinary `user` event, marked `"isReplay": true` with `"origin":
{"kind":"human"}`. Without it, the prompt typed on the other surface reaches
  stdout nowhere — the panel would render an answer to a question it never saw.
  The flag echoes our own stdin messages too, so a session-mode client has to
  drop the echo of what it just sent.
- **`--session-mirror` is the fuller but heavier path**: it emits
  `transcript_mirror` frames carrying the transcript path and the entries just
  written. It is what the official extension consumes. Half the entries are
  bookkeeping (`attachment`, `queue-operation`, `file-history-snapshot`), so
  prefer the replay flag and keep this in reserve.
- **A permission request goes to _both_ surfaces.** `can_use_tool` arrives on
  our control channel with `permission_suggestions` attached, and the remote UI
  shows Allow/Deny for the same call. Whoever answers first wins, and the CLI
  then sends **`control_cancel_request` with that `request_id`** — measured 6s
  after the request, when the remote side approved. LUNO handles no such event
  today (`grep control_cancel_request src/` is empty), so a remotely-answered
  prompt would sit on screen forever and be answered into the void.
- **`--resume` restores the conversation but not the bridge.** History came
  back intact; no `bridge_state` arrived in 25s of silence or after a turn.
  After a window reload LUNO must re-issue the request itself rather than
  assume a reconnect.

Probes kept in the session scratchpad: `rc-phase0.mjs`, `rc-phase0b.mjs`,
`rc-resume.mjs`.

One trap found on the way: the CLI falls back to permission mode `auto` when
`--permission-mode` is absent, and it reads `permissions.defaultMode` from the
user's own `~/.claude/settings.json`. A long-lived process that inherits that
runs Bash without asking anyone. LUNO passes the flag on every spawn today
(`claude-cli.ts:726`); in session mode that has to stay an invariant, with a
test pinning it.

**Ф1 — session mode. Done, 2026-07-28.** `ClaudeCliOpts.sessionMode` keeps one
CLI process alive across turns. The per-turn path is untouched and still the
default; nothing turns the flag on yet — Ф2 does, for conversations with Remote
Control enabled. Verified against the real CLI, not only in unit tests: two
turns in one process (same pid), context carried across them, a cancel that
interrupts the turn without ending the session, and the session still answering
afterwards.

How it is shaped:

- The reader is attached to the **session**, not the turn, so events arriving
  between turns reach `onOutOfTurn` instead of being dropped. The live check
  saw the interrupted turn's `usage,done` tail land there — which is exactly
  the seam Ф4 needs.
- `cancel()` sends an `interrupt` control request instead of killing the child.
  Killing it would end the conversation and drop the bridge when all the user
  asked was to stop the turn.
- Options split in two. `set_model` and `set_permission_mode` are pushed onto
  the live session; anything argv-only replaces the process, decided by
  `respawnFingerprint()`, which ignores `--resume` (it changes after the first
  turn and would otherwise respawn on every turn).
- Per-turn context (`diagnostics`, `editorContext`) can no longer be a system
  append, because the system prompt is fixed at spawn. It rides with the turn
  text via `turnPreamble()`. Stale diagnostics would be worse than none.

Two traps this cost, both invisible to the compiler:

- **`stdin.write()` returning `false` is backpressure, not failure.** Right
  after spawn it is routinely false while the pipe connects, and the data is
  delivered anyway. Treating it as a failed write made every turn report "the
  session is no longer accepting input" while the CLI sat there perfectly
  healthy. Check `destroyed`/`writableEnded` instead.
- **An interrupted turn still emits its `result`, later.** Send the next turn
  before it arrives and that stale `result` ends the new turn instead — the
  panel shows an empty answer. The session now tracks `busy` and the next turn
  waits for the drain (`TURN_DRAIN_TIMEOUT_MS`, then proceeds anyway so a
  wedged CLI cannot freeze the panel permanently).

**Ф2 — the toggle. Done, 2026-07-28.** `enableRemoteControl(name?)` /
`disableRemoteControl()` / `remoteControlStatus()` on the provider. LUNO now
initiates control requests as well as answering them: `sendControl()` matches
replies by `request_id` with a 30s bound, because a lost reply would otherwise
leave the caller awaiting forever.

- Enabling **refuses outside session mode**, and that is the point: the bridge
  ends with the process, so the per-turn path would hand out a link that dies
  with the current answer.
- `bridge_state` becomes a `remote_control` delta on the same seam as
  everything else. It is read in the session reader rather than in
  `makeProcessor` — it describes the session, not the turn.
- **`ANTHROPIC_API_KEY` is withheld while the bridge is wanted.** Remote
  Control refuses to run under an API key, and the CLI prefers an env-supplied
  key over its own credentials, so injecting LUNO's token is precisely what
  would break it. Decided by `remoteControlWanted`, which is set _before_ the
  spawn — reading the observed state instead would inject the key and then ask
  for a bridge that cannot start.
- A replaced process re-establishes the bridge by itself.

Verified live: URL returned, `ready → connected` when a device joined, a turn
answered with the bridge up, an effort change replaced the process and the
bridge came back on a **new** URL.

**That last part is a real edge, not a detail:** the session URL changes when
the process is replaced, so a phone sitting on the old link is left on a dead
session. Ф3's banner must always show the current URL, and changing effort
mid-conversation deserves to say what it will do.

Two bugs this cost, both found by measuring rather than reading:

- **Two remote sessions for one conversation.** `enableRemoteControl` set "the
  bridge is wanted" before spawning, and the fresh spawn fired its own enable
  request on the strength of that flag — while the caller sent a second. The
  user would have seen two entries in the claude.ai session list. Both paths
  now go through `establishRemoteControl()`, which shares one in-flight request.
- **The banner announced itself twice.** The CLI sends exactly one `ready`
  (checked against the raw stream, with LUNO out of the loop); the duplicate was
  ours — once from the `bridge_state` event, once from the reply that carries
  the URL. Bridge events are suppressed while our own enable is in flight; the
  reply is the authoritative first status.

**Ф3 — UI. Done, 2026-07-28.** A pill in the header beside `TokenMeter`,
`/rc` and `/remote-control` intercepted before the prompt is sent, and the host
wiring underneath.

**No QR code, deliberately.** The CLI draws one in a terminal; the official VS
Code extension does not, and that is the shape being matched. The pill links to
the session instead.

The host half was the real work. Everywhere else a provider is built per turn
and discarded — `runPromptTurn` did exactly that — which would have ended the
bridge on the first answer. `ConversationHost` now keeps a `remoteProvider`
alive while Remote Control is on and hands it the turn's options through
`updateOptions()` instead of rebuilding it. Without that, diagnostics and the
editor selection would stay frozen at whatever they were when the bridge was
switched on.

- `/rc` never reaches the model: `isRemoteControlCommand()` matches the whole
  message only, so asking _about_ the command is still answered.
- The pill is absent when the bridge is off — a control for something nobody
  switched on is noise in a header that already drops items at narrow widths.
- Blue for both live states, with the pulse rather than the hue separating
  `connected` from `ready`: green in this header means "finished well", and a
  standing connection is not an outcome.
- The click always opens the URL currently held, never a remembered one — the
  session changes when the process is replaced.
- The status is re-sent when the panel reattaches, so reloading does not make a
  conversation someone's phone is driving look disconnected.

Measured in the harness: absent when off; four distinct tones; contrast against
the page 7.69 / 7.69 / 11.71 / 7.07 for ready / connected / disconnected /
error, all above AA; the pill adds nothing to the header's width
(`scrollWidth` identical with and without it).

**Ф4 — sync. Done, 2026-07-28.** The flag was already being passed; what was
missing was everything downstream of it. A `user` event carrying text was read
only for the `tool_result` blocks it usually holds, so a replayed prompt
produced no delta at all — and out-of-turn traffic reached a handler that read
the bridge's state and dropped the rest, with a comment saying why. Both halves
are now real.

- **The prompt is the announcement.** Nothing else says a turn is starting
  here, so `beginRemoteTurn` is deliberately not async: the queue that catches
  the answer has to exist before the reader's callback returns. Everything that
  must wait — a local turn still in its `finally`, the checkpoint — waits
  inside it.
- **One loop for both surfaces.** `Orchestrator.observe(text, stream)` is
  `turn()` without the send: same plan interception, same message history, same
  checkpoint. A second implementation of "what a turn does to the timeline"
  would have drifted within a phase.
- **The echo is dropped by matching what we wrote**, not by the replay flag —
  measured on 2.1.219, our own stdin message comes back marked exactly like a
  phone's would be, so the flag cannot separate them. The pending list is
  consumed rather than tested, or the phone repeating a prompt the panel had
  sent earlier would vanish instead of being answered.
- **`content` is a bare string on a replayed prompt** and a block list on
  everything else. That widening is what the classifier keys on, and it forced
  an `Array.isArray` guard at the two places the processor iterates content —
  a string would have iterated per character.
- **Stop had to close the queue.** There is no generator to return from; a
  session that never reports its `result` would otherwise leave the panel busy
  for the rest of its life.
- **Text typed here during a remote turn is queued** — `activeTurn` is set, so
  the existing path does that already — but nothing drained it: `flushQueued`
  only runs behind a turn the panel started. The remote turn now flushes it.

Verified: the full gate (`lint` clean, 645 passed / 6 skipped), the echo shape
measured against the live binary today, and 21 tests across the two halves —
the classifier and the echo queue as pure functions, and the host wiring end to
end with a fake CLI (timeline, busy, an approval answered from the panel, Stop,
and the queued local prompt going out afterwards).

**Not verified, and only a second device can:** that a prompt from the phone
carries the same event shape as our own echo. Ф0 measured that it does
(`isReplay: true`, `origin: {kind:"human"}`); the classifier deliberately keys
on neither field, only on a `user` event with text content and no
`parent_tool_use_id`, so it holds either way — but the round trip itself is
untested here.

One edge left open on purpose: a prompt from the phone that arrives _during_ a
panel turn reaches the local turn's sink instead of the out-of-turn seam, where
nothing consumes it. The CLI answers one turn at a time, so in practice the
replay lands after ours finishes; if it ever does not, the symptom is a remote
prompt missing from the timeline rather than anything corrupted.

**Ф5 — permissions. Done, 2026-07-28.**

The Ф4 note above once said the first half was already in. It was not, and the
correction is the interesting part: `control_cancel_request` was handled in the
session reader and did emit a `permission_resolved` delta — and **nothing
consumed it**. The host forwarded it to the webview inside the generic `delta`
envelope, whose handler knows `text` and `error` and ignores the rest. The card
stayed on screen and stayed answerable. Reading one end of a wire is not the
same as reading both.

**The withdrawal, end to end.** The delta now carries the payload it withdraws
(`permission` on `permission_resolved`) — the CLI's cancel says only which id
is gone, and by then the panel has nothing left that names the tool. The host
takes the card off, clears the copy held for a surface it is not currently on
(matched by id: a second prompt waiting here must not go with it), and writes
the fact to the timeline. The webview drops that one card from the queue, not
the queue — parallel tool calls mean others may still be waiting on someone.

**What the timeline says: "Bash · answered on another device", not
"approved".** The cancel carries no verdict — only the id. Rendering it as an
approval would be inventing the half that matters. It is on the timeline rather
than in a toast for the same reason compaction is: reopening the chat tomorrow,
it is the only thing explaining why a tool ran with no approval here.

**The policy, decided and then reversed the same day: Remote Control puts no
restriction on the permission mode.**

It was first built the other way — `auto` and `bypass` refused while the bridge
was up, on the reasoning that a device not in the room could make the agent
write files with nobody approving it here. Rodion's call, and it stands: whose
files these are, and what may run against them unattended, is the user's
decision on their own machine, and the phone in their pocket is not somebody
else's hands. Being asked to justify a mode they deliberately chose is the
annoyance, not the tool call.

So: no guard, no warning, and no `changePermissionMode` choke point — every
caller is back on `applySetting`. `bypass` keeps its own confirmation, which
predates all of this and is about the mode itself rather than about the bridge.
The reversal is pinned by tests that assert the modes _are_ accepted with a
device connected, so nobody reinstates the refusal thinking it was an oversight.

What the user does inherit, and it is the CLI's constraint rather than a
choice: **switching to Bypass replaces the process.** Measured against 2.1.219 —
`set_permission_mode` over the control channel answers
`"Cannot set permission mode to bypassPermissions because the session was not
launched with --dangerously-skip-permissions"`, while `plan` and `set_model`
both succeed. Agent mode respawns too, for a different reason: it is `default`
plus `--allowedTools` entries, and argv changes replace the process by
definition. A replaced process re-establishes the bridge by itself, on a **new
session URL** — so a phone sitting on the old link has to reopen it from the
pill. That is the Ф2 edge, now reachable from the mode picker.

Verified: 13 host tests over the withdrawal and the modes. One of them is worth
naming because it was passing for the wrong reason first: with the Bypass modal
stubbed to "no", the test never reached the rule it was checking — it was
passing on that confirmation's own refusal. The stub now says yes. In the
harness: the card disappears on `permissionResolved` and the line renders as a
centred boundary with the divider rules, `--t3` at 11.5px, contrast 4.59:1
against the page — the same treatment the compaction boundary already has,
sharing its rule rather than restating it.

Still only a second device can prove the round trip: that answering on the phone
is what produces the cancel we now act on.

## Audit against the official implementation — 2026-07-28

Read against `anthropic.claude-code` 2.1.220 (`extension.js` and its webview
bundle) and probed against the 2.1.219 binary. Four changes came out of it.

**The echo is identified by id, not by text.** The reference mints the message
id itself — `{type:"user", uuid: crypto.randomUUID(), session_id:"",
parent_tool_use_id:null, message:{…}}` — renders it optimistically, and on the
replay drops anything whose uuid it already holds. Probed: the CLI **preserves a
client-supplied uuid** and returns it on the replay. Ours matched on the text,
which is a heuristic with one real failure: a phone sending the same words the
panel had just sent would have been swallowed as our own echo. Now we mint the
id too. This is the single most valuable thing the audit found.

**A second prompt while a remote turn was open deadlocked the panel.** Ours,
not theirs: the reference has no per-turn machinery at all — replayed user
messages are spliced into the message list at a tracked index. We model a turn,
so a second `remote_prompt` replaced `remoteTurn` with a new queue while the
first orchestrator still awaited the old one — whose `done` was now being
delivered to a queue nobody read. The new turn awaited a promise that could
never settle. Reproduced in a test (only `["user","first"]` ever reaches the
timeline, and the panel never leaves busy), then fixed by closing the previous
queue first.

**Cancel left approvals hanging on a turn we did not start.** The deny-all loop
lived in `abortCurrent`, which only exists while _this_ panel is streaming. Stop
during a remote turn interrupted the CLI and dropped the card, but never
answered the `can_use_tool` it was blocked on. Now `cancel()` denies pending
approvals on every path, and the three copies of that loop are one method.

**`bridge_state.detail` was being dropped.** The reference reads it
(`x.detail ?? "Bridge error"`); we set the state and nothing else, so an error
pill said "error" with no reason. Now parsed by `bridgeStatus()`, which also
clears a stale reason when the bridge recovers.

Deliberate divergences:

- **Neither implementation restricts the permission mode with Remote Control.**
  Ours briefly did; it was reversed the same day — see Ф5. The reference and
  LUNO now agree here.
- **They consume `--session-mirror` / `transcript_mirror`; we use
  `--replay-user-messages`.** Both flags exist and the extension passes the
  replay flag too. The mirror carries the transcript file plus bookkeeping
  entries (`attachment`, `queue-operation`, `file-history-snapshot`) we have no
  use for.
- **They accept `ready` only as a response, never from the event** — their
  `bridge_state` handler acts only when already `connected`, downgrading to
  disconnected/error. We accept the event's `ready` too, which is why the panel
  can show a bridge that came up after a respawn without being asked again.
- **They auto-enable Remote Control for all sessions behind a config flag**
  (`remote_control_auto_on_by_default`, with a disclosure). LUNO has no such
  setting and this audit does not propose one: it is a per-conversation choice
  here.

Known and not adopted: their `can_use_tool` handler also reads `blocked_path`,
`decision_reason`, `title`, `matched_ask_rule` and `agent_id`. Ours ignores
them, so an approval card cannot yet say _which rule_ asked for it or which
subagent raised it. Worth doing when the card next gets attention; nothing is
wrong without it.
