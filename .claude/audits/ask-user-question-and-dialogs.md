<!-- Read statically 2026-07-29 against claude CLI 2.1.219 (bin/claude.exe) and the
     official extension anthropic.claude-code-2.1.220-win32-x64 (webview/index.js).
     No live probe was run: nothing was spawned, no `claude` process, no network.
     Where a claim needs a running process to settle, it is in "Gaps", not asserted. -->

# AskUserQuestion, and every other question the CLI asks that LUNO answers for the user

## Scope

The reported symptom: the model raises a multiple-choice question, the widget
"opens", no answer ever arrives, and the model either says so or picks for
itself.

This audit traces that one symptom to the wire, then sweeps the same channel for
everything else on it. Three sources, all read statically:

| Source                                                                                      | What it settles                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `~/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (CLI 2.1.219) | what the tool actually does, and what it expects back |
| `.../sdk-tools.d.ts` from the same install                                                  | the published input/output schema                     |
| `~/.cursor/extensions/anthropic.claude-code-2.1.220-win32-x64/webview/index.js`             | how the official client answers it                    |

Nothing below is from memory. Every quoted fragment is a byte offset away from
being re-read; the extractor is in the session scratchpad as `extract-auq.mjs`.

## Verdict

**The answer channel is not broken — it was never built.**

`AskUserQuestion` does not have a result the client computes and posts. It has
exactly one delivery path: the tool asks permission, and the client answers the
permission request with the answers written **into the tool input**. Approving
without writing them is a complete, well-formed, semantically empty answer, and
the CLI's own wording for it is the sentence the user has been reading:

> `"The user did not answer the questions."`

LUNO auto-approves `AskUserQuestion` at
[claude-cli.ts:101](../../src/providers/claude-cli.ts#L101) so that its
purpose-built card can render instead, then renders that card in a surface an
ordinary chat never opens, and finally answers it as a **new user turn** rather
than as the tool result. Three independent breaks in one path; fixing any two of
them still leaves the widget dead.

The same auto-approval covers `ExitPlanMode`, whose permission request is the
plan-approval gate — so that gate is opened by LUNO before the user sees the
plan. And the generic fallthrough beside it answers **every** other control
request with `{}`, which is how `request_user_dialog` and MCP `elicitation` — two
more channels whose entire purpose is asking the user something — get replied to
without a user ever being involved.

## Part 1 — the wire truth

### 1.1 The tool is a permission request, by construction

CLI 2.1.219, the tool object (`var Fm="AskUserQuestion"`, @242664967 → the
object at @244811880):

```js
async checkPermissions(e){
  return { behavior:"ask", message:"Answer questions?",
           updatedInput:{ questions:e.questions, ...e.metadata&&{metadata:e.metadata} } }
}
requiresUserInteraction(){ return true }
isReadOnly(){ return true }
renderToolUseMessage(){ return null }
```

`behavior:"ask"` is unconditional — there is no allowlist, no mode, and no
setting that makes this tool run without a round trip to the client. And it is
belt-and-braces: the permission resolver forces `ask` a second time for any tool
that declares `requiresUserInteraction` (@249668417):

```js
if (e.requiresUserInteraction?.())
  return l?.behavior === "ask"
    ? l
    : {
        behavior: "ask",
        message: Oh(e.name),
        decisionReason: { type: "other", reason: "requiresUserInteraction" }
      };
```

### 1.2 The answers travel in `updatedInput`

```js
async call(e,t){
  let { questions:r, answers:n={}, annotations:o } = e, { response:i, afkTimeoutMs:s } = e;
  return { data:{ questions:r, answers:n, ... } }
}
```

`call` computes nothing. It echoes the input it was handed. The only way
`answers` is ever non-empty is if the client put it there, and the only place a
client can put it is the `updatedInput` of the permission response.

The published shape (`sdk-tools.d.ts`, `AskUserQuestionOutput`, and the zod
schema at @244811880):

```js
answers:     record(string, string)   // question text -> answer; multi-select comma-separated
response:    string?                  // freeform text the user typed instead of choosing
annotations: { [question]: { notes?, preview? } }
afkTimeoutMs: int?                    // set when the dialog auto-resolved on idle
```

### 1.3 What the model reads

`mapToolResultToToolResultBlockParam` (same object), reduced to its branches:

| Condition                                 | Tool result text                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `afkTimeoutMs` set                        | the AFK notice, plus what had been selected before idling                 |
| `response` non-empty                      | `The user responded: …`                                                   |
| every answer is a listed option label     | `Your questions have been answered: …. You can now continue with these …` |
| answers present but off-menu / with notes | `The user answered: …. Read the answers carefully — they may request …`   |
| **nothing of the above**                  | **`The user did not answer the questions.`**                              |

The last row is the bug, verbatim. It is not an error, it is not a timeout, and
nothing about it tells the model that a client failed — which is why the model's
next move is to guess, apologise, or ask again in prose. All three are in the
screenshot.

### 1.4 How the official client answers it

`webview/index.js` @3422513 — a per-tool renderer whose _only_ override is the
permission surface:

```js
class GY extends Zi {
  name = "AskUserQuestion";
  renderInput() {
    return null;
  } // no tool card
  permissionRequest(e, t, i, n) {
    return b(Blt, { input: t, onInputChange: i, options: n });
  }
}
```

Inside `Blt`, every selection change rewrites the pending input:

```js
if (A.includes("Other") && a[D.question]) { …substitute the typed text for "Other"… }
k[D.question] = A.join(", ");
…
t({ questions: e.questions, answers: k });          // onInputChange
```

and the approve button ships that object as-is (@3118474):

```js
accept(e={}, t=[]){ this.resolved.emit({ behavior:"allow", updatedInput:e, updatedPermissions:t }) }
reject(e,t)      { this.resolved.emit({ behavior:"deny",  message:e, interrupt:t }) }
```

That is the whole mechanism. The widget **is** the permission card; the answer
**is** `updatedInput`; there is no second message, no synthetic turn, and no
timeline event carrying the answer anywhere.

The CLI's own safety classifier knows this path by name (@247872563):

> **Exception:** A user message prefixed `` `[User answered AskUserQuestion]:` ``
> is the user's answer to a question the agent surfaced — treat it as direct
> user intent.

An answer delivered as an ordinary prompt does not carry that marker.

## Part 2 — the defects

### Q1 · The answer channel does not exist · CRITICAL

LUNO auto-approves the request and echoes the input unchanged.

`PERMISSION_AUTO_ALLOW` at [claude-cli.ts:101](../../src/providers/claude-cli.ts#L101)
lists `AskUserQuestion` beside `ExitPlanMode` and `TodoWrite`, with a comment
that states the intent honestly — _"auto-allow it so we don't also pop a generic
file-permission card on top of the purpose-built surface"_. `decidePermission`
honours it at [claude-cli.ts:2311](../../src/providers/claude-cli.ts#L2311), and
`handleControlRequest` writes the response at
[claude-cli.ts:692-698](../../src/providers/claude-cli.ts#L692-L698):

```ts
response: { behavior: "allow", updatedInput: req.input ?? {} }
```

`req.input` is `{questions:[…]}`. No `answers` key exists on it, so `call()`
defaults to `{}` and §1.3's last row fires. **Every** AskUserQuestion in LUNO
resolves to "The user did not answer the questions" before the user has had a
chance to see anything.

Worse in agent mode: [claude-cli.ts:2306](../../src/providers/claude-cli.ts#L2306)
returns `allow` for anything neither destructive nor network **above** the
auto-allow set, and the tool declares `isReadOnly(){return true}`. So the
question is answered-by-nobody on two independent paths, and turning agent mode
off does not change the outcome.

### Q2 · Outside plan mode the card renders nowhere at all · CRITICAL

The interceptor turns the tool call into a `plan_question` timeline event and
marks the tool id intercepted
([plan-intercept.ts:163-174](../../src/core/plan-intercept.ts#L163-L174)), so the
orchestrator suppresses the ordinary tool card. The webview drops it a second
time — `AskUserQuestion` is in `PLAN_TOOL_NAMES` at
[ChatScreen.tsx:679](../../webview/src/features/chat/ChatScreen.tsx#L679) — and
`plan_question` deliberately produces no chat block at all
([ChatScreen.tsx:976](../../webview/src/features/chat/ChatScreen.tsx#L976)):

```
// plan_question / plan_comment / plan_answer events do not produce
// their own blocks — they are folded into the PlanRevisionView.
```

`QuestionCard` has exactly one consumer: `PlanFullView`
([PlanFullView.tsx:401](../../webview/src/features/plan/PlanFullView.tsx#L401)),
which is mounted by `ArtifactApp`
([ArtifactApp.tsx:97](../../webview/src/ArtifactApp.tsx#L97)) — a **separate
webview panel**, opened per `revisionId` from a PlanCard.

And the fold that would place it there needs a revision to attach to
([foldPlanState.ts:155-164](../../webview/src/features/plan/foldPlanState.ts#L155-L164)):

```ts
const target =
  (meta.revisionId ? byRevisionId.get(meta.revisionId) : undefined) ??
  lastView(revisions);
target?.questions.push({ ...meta, eventId: e.id, ts: e.ts });
```

In a chat with no plan revision, `revisions` is empty, `lastView` is `undefined`,
and the optional call is a silent no-op. **The question is discarded.** That is
the screenshot exactly: an ordinary conversation, a widget the user never saw,
and nothing to click.

So the reachable surface for a question is: plan mode → a plan revision exists →
the user opens the artifact panel for that revision → scrolls to the card. Every
question outside that path is invisible.

### Q3 · Where it does render, the answer is a new turn, not the result · HIGH

[plan-handlers.ts:462-472](../../src/ui/domains/plan-handlers.ts#L462-L472):

```ts
async handlePlanAnswer(questionId: string, _toolUseId: string, answers: …) {
  this.session.emitPlanAnswer({ questionId, answers });
  const summary = answers.map((a,i) => `Q${i+1}: ${a.choice}…`).join("; ");
  await this.handlePrompt(`Answer to your question — ${summary}`);
}
```

`_toolUseId` is received and thrown away — the underscore is the code admitting
it. Four consequences, none cosmetic:

1. The tool call it answers was resolved long ago with "did not answer". The
   model now holds a contradiction: a tool result saying nothing was chosen, and
   a later user message saying something was.
2. It costs a whole extra turn, and re-enters through `handlePrompt`, so it
   queues (before steering landed) or steers (after) rather than unblocking a
   call that is already finished.
3. It loses the `[User answered AskUserQuestion]` provenance the CLI's own
   classifier treats as direct user intent (§1.4).
4. `Q1:`/`Q2:` numbering replaces the question text the schema keys on
   (`answers` is `question -> answer`), so nothing downstream can pair an answer
   with its question.

### Q4 · The card does not match the tool's schema · HIGH

`parseQuestions` reads `multiSelect` and `header`
([plan-intercept.ts:489-513](../../src/core/plan-intercept.ts#L489-L513)) and
`QuestionCard` renders neither:

| Schema feature                           | Official client                          | LUNO                                                       |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `multiSelect`                            | checkboxes                               | radio only — a multi-select question cannot be answered    |
| `header` (≤12 chars)                     | per-question tab strip, marks answered   | not rendered                                               |
| `options[].preview`                      | side-by-side preview pane, md or html    | not rendered                                               |
| "Other" free text                        | substituted into `answers[question]`     | `choice:"__other"` + a separate `note` field               |
| Skip                                     | close button → the question is skippable | no skip; Submit is disabled until every question is filled |
| `response` (freeform instead of options) | supported                                | no channel                                                 |
| `annotations` (`notes`, `preview`)       | round-tripped                            | no channel                                                 |
| 1–4 questions, 2–4 options               | tabs handle >1                           | all questions stacked in one card                          |

`__other` is a LUNO-internal sentinel that has no meaning on the wire. Even with
Q1 and Q3 fixed, an "Other" answer would arrive as the literal string
`__other`.

### Q5 · Nothing models the timeout · MEDIUM

The CLI reads a setting for this — `getAskUserQuestionTimeout` →
`getSecuritySensitiveSetting("askUserQuestionTimeout")` (@238943339) — and the
output schema carries `afkTimeoutMs`, "set when the dialog auto-resolved after
this many milliseconds of idle (user away from keyboard). Absent on every
human-resolved path."

So a question left unanswered has a defined end. LUNO models neither the setting
nor the state: with Q1 fixed and the request genuinely left pending, a question
the user walks away from would hold the turn with nothing in the UI saying for
how long.

## Part 3 — the same channel, everything else on it

`handleControlRequest` splits in two at
[claude-cli.ts:666-679](../../src/providers/claude-cli.ts#L666-L679): anything
that is not `can_use_tool` is acknowledged with an empty success —

```ts
if (!requestId || !req || req.subtype !== "can_use_tool") {
  if (requestId) {
    this.writeControl({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: {} }
    });
  }
  return;
}
```

The comment above it reads _"anything else is acknowledged so the CLI never
blocks on us"_. That is true of the transport and false of the meaning: several
of these subtypes are questions, and `{}` is not an answer to any of them.

### D7 · `ExitPlanMode` — LUNO opens the plan gate before the user sees the plan · HIGH

CLI @244874930:

```js
async checkPermissions(e,t){
  if (oy()) return { behavior:"allow", updatedInput:fpt(VM,e) };
  return { behavior:"ask", message:"Exit plan mode?", updatedInput:e };
}
```

`ask` is the plan-approval gate — the official client renders it with the plan
and the user's comments attached (@3437940), and its tool result is literally
`"User approved the plan"` or `"Stayed in plan mode"`. LUNO auto-allows it from
the same `PERMISSION_AUTO_ALLOW` set, so the CLI records approval and leaves plan
mode the instant the model asks.

Bounded, not harmless: LUNO's own `decidePermission` still gates `Write`/`Edit`/
`Bash` afterwards, so the model does not get a free run at the workspace. What is
lost is that the approval the user gives on LUNO's PlanCard is not the approval
that opened the gate — the gate was opened for them, and "Stayed in plan mode" is
an outcome LUNO can never produce.

> **Corrected 2026-07-30, reading the plan flow this audit had not.**
> `handlePlanProceed` ([plan-handlers.ts:224](../../src/ui/domains/plan-handlers.ts#L224))
> does not leave plan mode through this tool at all: it flips
> `luno.permissionMode` to `auto`, **drops `resumeId`, and respawns**, because a
> resumed session keeps its stored permission posture. So LUNO escapes the CLI's
> plan floor by replacing the process, and the paragraph above overstates the
> tie between this tool and the plan gate.
>
> The defect survives in a narrower form: auto-allowing let the _current_
> session out of plan mode the moment the model asked, before anyone read the
> plan. **Fixed** — the request is now refused while the session is planning,
> with the CLI's own wording, and "Stayed in plan mode" is an outcome LUNO can
> produce after all. Full parity — holding the request pending and making the
> PlanCard its answer, with comments as `userFeedback` — was considered and
> declined: it means unpicking a working respawn-based flow for a parity nobody
> asked for.

### D8 · `request_user_dialog` is answered with `{}` · ~~HIGH~~ → LOW, and unreachable

A first-class dialog channel, distinct from permissions. The CLI tracks it beside
`can_use_tool` everywhere the two are handled (@247200083), redelivers it as
`pending_user_dialog_requests` on reconnect, and the SDK routes it to an
`onUserDialog` callback. Known kinds and their user-facing text (@254651030,
@247127512):

| `dialog_kind`                  | What it asks                                                 |
| ------------------------------ | ------------------------------------------------------------ |
| `refusal_fallback_prompt`      | "choose: retry on fallback model or edit prompt"             |
| `fable_overage_consent_prompt` | "choose: continue Fable 5 on usage credits or switch models" |
| `mcp_url_elicitation`          | "MCP input: open link"                                       |

With no handler the SDK deliberately stays silent rather than answering:

```
[Query] No onUserDialog handler for request_user_dialog (kind=…) — staying
silent so a capable client (or the worker's park deadline) settles it
```

LUNO does not stay silent — it answers `{}`, which is neither a choice nor
`"cancelled"`. What the CLI does with that is **not settled by a static read**;
see Gaps.

Second-order: the CLI refuses to let a client declare `supportedDialogKinds`
without a handler, in as many words —

> `supportedDialogKinds requires an onUserDialog callback — declaring dialog
kinds without a handler would park dialogs nothing can answer.`

LUNO declares nothing (D12), which is the safe half of this by accident.

> **Corrected 2026-07-30 — this was rated on the wrong axis, and the probe it
> asked for was not needed.** The channel is gated on the declaration, not just
> paired with it:
>
> ```js
> function BHS(e, t, r){ return { supportsKind(n){ return r.has(n) }, … } }
> function _2c(e, t){ if (e === void 0 || !e.supportsKind(i8.kind) || !t()) return; return e; }
> ```
>
> `r` is the set built from `fqe(request.supportedDialogKinds)` at `initialize`.
> A client that declares nothing gets nothing: the CLI's own telemetry names
> the states — `no_dialog_host`, `no_consumer_capability`. **So the CLI has
> never sent LUNO a `request_user_dialog`, and the `{}` was dead code.**
>
> The reply is fixed anyway — silence, matching the SDK — so that declaring a
> kind later cannot arrive with a wrong answer already wired in. What is real
> here is the flip side, and it belongs to D12: because LUNO declares nothing,
> `refusal_fallback_prompt` never reaches the user, and a model that falls back
> does so silently. Turning that on means building the three dialogs, which is
> a feature and not a defect.

### D9 · MCP `elicitation` is answered with `{}` · MEDIUM

The MCP elicitation channel — an MCP server asking the user for input mid-call.
The SDK's documented answer when the client cannot handle it (@250478256):

```js
else if (e.request.subtype === "elicitation") {
  if (this.onElicitation) return await this.onElicitation({…});
  return { action: "decline" };
}
```

`{action:"decline"}` is a decline. `{}` is a malformed reply that says the
client succeeded at something. LUNO ships MCP connectors, so this is reachable
today by any server that elicits.

### D10 · A denial carries none of the user's words · MEDIUM

Official (@3118474): `reject(message, interrupt)`, where `message` comes from the
field rendered beside every deny button — placeholder **"Tell Claude what to do
instead"** (@4595242, `ci.rejectMessageInput`).

LUNO ([claude-cli.ts:636-652](../../src/providers/claude-cli.ts#L636-L652)) sends
a fixed string on every denial: _"The user denied permission … Do not retry it …
Stop and briefly explain, or ask the user how they would like to proceed."_

The canned text is a reasonable default and was chosen for a real reason (it
stops the retry loop). What is missing is the field: at the exact moment the user
knows what they want instead, LUNO gives them no way to say it, and the model's
only remaining move is to ask in prose or proceed on its own reading. That is the
second half of the reported symptom — _"пропускает вопросы и делает как хочет"_.

### D11 · The permission input is never editable · MEDIUM

`updatedInput` exists so the client can change the call. The official Bash card
is a `contentEditable` whose every keystroke rewrites the pending input
(@3430164):

```js
permissionRequest(e,t,i){ return b(zlt,{ input:t, onInputChange:i, commandLabel:this.commandLabel }) }
…
let r = n.current.textContent || ""; t({ ...e, command: r });
```

LUNO always echoes `pending?.input ?? {}`
([claude-cli.ts:625](../../src/providers/claude-cli.ts#L625)), and the comment
states it as policy: _"we pass the original proposal through unchanged."_ So a
nearly-right command is an all-or-nothing decision.

This is the same primitive Q1 needs. Building the AskUserQuestion answer path
builds most of this one.

### D12 · No `initialize`, so no dialog capabilities and no prompt redelivery · MEDIUM

LUNO never sends an `initialize` control request — the string does not appear in
`claude-cli.ts`. Two things follow.

The CLI's `initialize` handler (@247134915) reads `supportedDialogKinds` from the
request, and its **response** replays what is outstanding:

```js
let R = s?.() ?? [],
    k = R.filter(M => M.request.subtype === "can_use_tool"),
    D = R.filter(M => M.request.subtype === "request_user_dialog");
… ...k.length>0 && { pending_permission_requests: k },
  ...D.length>0 && { pending_user_dialog_requests: D }
```

and the SDK feeds them straight back through the normal handlers
(`processPendingPermissionRequests` / `processPendingUserDialogRequests`,
@250483775). That is the documented recovery for a permission outstanding across
a reconnect — precisely the hole D5/D6 left open on the respawn side. Those two
are written up in [carried-forward.md](../plans/carried-forward.md): a turn is
now told its process has gone, but nothing carries an outstanding request across
the gap.

### D13 · `can_use_tool` fields LUNO drops · LOW

The SDK's own destructuring of the request (@250478256) lists what a client is
offered; LUNO reads `tool_name`, `input`, `description`, `tool_use_id`,
`permission_suggestions`
([claude-cli.ts:701-711](../../src/providers/claude-cli.ts#L701-L711)) and
ignores the rest:

| Field                       | What is lost                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `requires_user_interaction` | the CLI's own generic marker for "this is a dialog, not a permission" — it identifies Q1's whole class |
| `agent_id`                  | a subagent's prompt is indistinguishable from the main turn's                                          |
| `title`, `display_name`     | the CLI's own labels for the card                                                                      |
| `decision_reason`           | _why_ it is being asked (rule / mode / safety check / `requiresUserInteraction`)                       |
| `blocked_path`              | which path tripped a deny rule                                                                         |
| `matched_ask_rule`          | which settings rule routed it here                                                                     |

`requires_user_interaction` is the one that matters: had it been read, the fix
for Q1 would generalise to every future tool of this shape without a name list.

## What is right today

Stated so the fix does not undo it.

- `control_cancel_request` **is** handled
  ([claude-cli.ts:1285-1296](../../src/providers/claude-cli.ts#L1285-L1296)): a
  prompt answered on the phone withdraws the card here. Any pending-question work
  must ride the same withdrawal or it will strand cards.
- Routing plan-tool calls away from the generic permission card was the right
  instinct — the official client does exactly that, via `renderInput(){return null}`
  plus a `permissionRequest` override. The error is not the diversion; it is that
  the diversion answers the request on the way past instead of holding it.
- `permission_suggestions` are already carried through to the card, which is more
  than the reference extension does with `still_queued`.

## The shape of the fix

Not a plan — the constraint the plan has to satisfy.

**A question is not a permission, and must never be auto-answered by a mode.**
The branch that decides this has to sit above `ctx.agentMode` in
`decidePermission`, not beside the read-only set, or agent/bypass mode answers it
again.

**One request, one response, same `request_id`.** The pending permission stays
pending while the card is on screen. Submitting writes
`{behavior:"allow", updatedInput:{questions, answers, …}}` through the existing
`respondToPermission` seam — which already takes a `requestId` and already
handles the unknown-id case. Skip is the same call with the answers omitted; the
CLI has a defined result for it.

**`answers` is keyed by question text**, values are option labels, comma-joined
for multi-select, with "Other" replaced by what was typed. Free-text instead of
any option goes in `response`, per-question notes in `annotations`.

**The card belongs in the chat stream**, where the permission card already
renders, not in the artifact panel. `plan_question` / `plan_answer` stay as a
timeline recording so rewind and reload keep showing what was chosen — a record
of the answer, not the channel that delivers it.

**`handlePlanAnswer`'s `handlePrompt` call goes away.** Nothing about answering a
question should open a turn.

## Gaps this audit could not close

No process was spawned. Four things were listed here as needing a probe each.
**Two of them turned out to be readable, and reading beat probing** — a probe
would have measured one build's behaviour where the source states the rule.

1. ~~**What the CLI does with `{}` in reply to `request_user_dialog`.**~~
   **Closed by reading, 2026-07-30.** The wrong question: the channel never
   opens for a client that declares no dialog kinds. See D8's correction.
2. ~~**Whether an unanswered `can_use_tool` for `AskUserQuestion` blocks the
   turn or times out** — and at what default.~~ **Closed by reading,
   2026-07-30.** The CLI has no timer: `checkPermissions` returns `ask` and the
   core blocks on the response. The countdown is a _client_ feature, driven by
   `askUserQuestionTimeout`, and `cQf` maps `void 0 → null` — **unset means
   never**. See Q5.
3. **Whether `plan_question` events already on stored timelines** would double
   up with a chat-stream card after the fix. Static reading says the fold is
   per-revision and the chat path is separate, and the legacy `__other`
   sentinel is now resolved at render — but **no real session file from disk
   was opened**. Still open.
4. ~~**`ExitPlanMode` under a real plan-mode session**~~ — the static read was
   right that LUNO re-gates every write itself, and wrong about the mechanism:
   Proceed respawns rather than exiting through the tool. See D7's correction.
   What is still unrun is the **behavioural** half: how the model reacts to
   "Stayed in plan mode" in LUNO's setup. Expected to stop and wait; not
   observed.

Also not compared: the Claude Code **desktop app** (not installed on this
machine). Every statement about "the official client" above is the VS Code
extension 2.1.220 or the CLI 2.1.219, never the desktop.
