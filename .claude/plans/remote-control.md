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

**Ф1 — session mode.** A long-lived process behind a flag, used only where
Remote Control is on; the per-turn path stays the default until the new one has
earned it. Entry point is `stream()` in `src/providers/claude-cli.ts`: instead
of spawn → one message → death, spawn once and queue turns into the open stdin.
Same place, drop `ANTHROPIC_API_KEY` when RC is on. This is most of the work.

**Ф2 — the toggle.** An outbound `control_request`. Today LUNO only _answers_
the control protocol and never initiates, so this needs a `request_id`
generator and response matching. Plus a `bridge_state` branch in
`makeProcessor`, next to `compact_boundary`, which is the closest worked
example.

**Ф3 — UI.** A status pill in `webview/src/features/chat/Header.tsx` beside
`TokenMeter` (line 110): connection state, the session URL, a QR code. `/rc`
and `/remote-control` intercepted in the composer before the prompt is sent.
A message shape in `lib/rpc.ts` plus a handler in `ui/conversation-host.ts`; the
icon goes in `design/icons.tsx`. The QR has to be generated as SVG — it is not
an icon and does not belong in the registry.

**Ф4 — sync.** Smaller than it looked: `--replay-user-messages` plus dropping
the echo of what we sent ourselves. The rest of a remote turn — assistant text,
`tool_use`, `tool_result`, `result` — already arrives on stdout unchanged, and
the session id stays the same throughout.

**Ф5 — permissions.** Two parts, and the first is not optional. **Handle
`control_cancel_request`**: a prompt answered on the phone must disappear from
the panel, and a card whose request was cancelled must stop being answerable.
Without it the two surfaces desynchronise on the first remote approval. The
second part is policy: LUNO's gate is deliberately stricter than upstream (see
`remaining-features.md` §2 and `decidePermission`), and a phone is another
surface that can press "allow". `luno.permissionMode: auto` together with Remote
Control should simply be refused. Write that decision down before the code.
