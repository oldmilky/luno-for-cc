# Refactor — the plan

Written 2026-08-03 from [`.claude/audits/refactor-surfaces.md`](../audits/refactor-surfaces.md),
which holds the measurements. This file holds only the decisions: what moves,
where to, in what order, and how each step proves it changed nothing.

---

## The one rule that makes this verifiable

**A move is a move.** Every phase below is either a _pure move_ — code changes
address, not behaviour — or it is explicitly marked as a behaviour change and
carries its own evidence requirement.

For a pure move the proof is arithmetic:

| Gate              | Before                 | After         |
| ----------------- | ---------------------- | ------------- |
| `bun run test`    | 1508 passed, 6 skipped | **identical** |
| `bun run lint`    | exit 0                 | exit 0        |
| `bun run package` | 1.28 MB, 17 files      | within ±2 kB  |

All three measured on 2026-08-03 at the end of Phase 0, and they supersede the
figures in CLAUDE.md — which still says 1122 tests and ~605 kB, both taken
before the suite grew and before the voice recorders started shipping. The
numbers here are the ones this refactor is checked against; CLAUDE.md needs the
same correction, separately, because a reader who trusts 1122 would accept a
386-test regression as a pass.

`lint` is measured by exit code, not by a clean screen: it emits 35 warnings
today and exits 0. The gate is "no new warnings and still exit 0".

A pure move whose test count changed is not a pure move. That is the whole
safety story, and it is why the phases are ordered so that the largest moves
happen where the test coverage is already thickest.

**Commit granularity:** one phase per commit, each independently shippable. The
extension auto-updates both marketplaces — a half-landed refactor is not a
branch state, it is a release state.

---

## Phase 0 — clear the runway (precondition, not refactor)

26 staged-but-uncommitted changes sit in the tree: `prompts/` → `src/prompts/`,
`native/luno-audio/` → `external/native/luno-audio/`, plus `.gitignore`,
`.vscodeignore`, `eslint.config.mjs` and both CI workflows.

Land it or stash it. A refactor on top of an uncommitted move makes both
undiagnosable, and `.vscodeignore` + the release workflow are in it — so this
one needs `bun run package` before it goes, not just lint and test.

**Done when:** `git status --short` is empty.

---

## Phase 1 — the free wins (pure move, tiny) — DONE 2026-08-04

Landed as `a2a6ab1` (1a), `b3d0dc3` (1b), `4d85c90` (1c) — three commits rather
than one, because the parts are independent and a 30-file comment sweep would
otherwise bury the diff that matters.

> **What this section got wrong, kept because the same mistake is available in
> Phases 4 and 7.** It called the two `formatRelativeTime` implementations
> duplicates and planned to collapse them. They are not: one renders "12m ago"
> and falls back to a bare date after a week, the other renders "12 minutes
> ago" and holds out to 30 days. Merging them would have moved text on screen
> in two places. The same was true of the number formatters — measured, six of
> nine sampled values disagree across `formatTokens` / `formatCompact` /
> `formatCount`, so only the genuinely byte-identical pair was merged and the
> rest were moved or left alone. **A shared name is not evidence of a
> duplicate; only reading both bodies is.** Grep found the candidates and was
> wrong about three of them.

Three unrelated cleanups, grouped only because each is small enough that doing
it alone is more ceremony than work. They also serve a purpose: they exercise
the gate loop at zero risk before Phase 2 spends it on 2000 lines.

**1a. `webview/src/lib/format.ts`** — one home for number and time formatting.
Absorbs the byte-identical `formatCount` from
[SkillDetailModal.tsx:240](../../webview/src/features/chat/SkillDetailModal.tsx#L240)
and [SkillsMarketplace.tsx:633](../../webview/src/features/chat/SkillsMarketplace.tsx#L633),
plus `formatTokens` and `formatDuration` (tool-buckets, whose header says it is
about bucket categorization and which seven components were importing a
duration formatter from).

`formatCompact`/`formatNum`/`formatPctUsed` stayed in usage-view — single
consumer, and moving them would have advertised as shared what is not. Both
`formatRelativeTime`s stayed too; the private one was renamed
`formatRelativeShort` so the collision cannot be resolved by accident.

Host-side `fmtTokens` at
[conversation-host.ts:3058](../../src/ui/conversation-host.ts#L3058) stays where
it is. It formats for a _notification string_, not for the UI, and dragging a
webview module across the seam to save six lines is the wrong trade.

**1b. Split the plan model out of `src/core/types.ts`.** Lines 552–671 —
`PlanTask`, `PlanTaskStatus`, `PlanTaskFileRef`, `PlanSections`,
`REQUIRED_PLAN_SECTIONS`, `PlanRevisionMeta`, `PlanQuestion*`, `PlanComment*`,
`PlanAnswerMeta` — become `src/core/plan-types.ts`. Self-contained domain; the
file has 17 importers and most of them want the chat half, not this.

**1c. Delete the 35 `Ф<digit>` phase labels** across `src/`, `webview/src/` and
SCSS. `.claude/rules/comments.md` already classifies them as a known cleanup
pointing at a phase log that is not in the published repo.

**Size:** small. **Risk:** none. **Evidence:** the three gates.

---

## Phase 2 — break up `claude-cli.ts` (pure move, large)

The centrepiece. 4421 lines → ~1900, and the ~2000 pure lines land where they
can be reached without a child process.

### Target layout

| New file                        | ≈ lines | From                                 |
| ------------------------------- | ------- | ------------------------------------ |
| `src/core/permission-policy.ts` | ~810    | 112–364, 2949–3504                   |
| `src/core/effort.ts`            | ~40     | `EffortLevel`, `EFFORT_LADDERS`      |
| `src/providers/cli/events.ts`   | ~700    | 3505–3731, 3747–4162, 4269–4421      |
| `src/providers/cli/args.ts`     | ~350    | 2496–2571, 2637–2948                 |
| `src/providers/cli/options.ts`  | ~140    | `ClaudeCliOpts` (365–498)            |
| `src/providers/cli/watchdog.ts` | ~85     | 4169–4252                            |
| `src/providers/claude-cli.ts`   | ~1900   | the provider and its control channel |

### Why the classifier goes to `core/`, not `providers/cli/`

Because that is what fixes the layering inversion instead of relocating it.
`src/core/*` is specified as the layer that imports zero VS Code and is
unit-tested in isolation — which describes `decidePermission` exactly: no
process, no filesystem, an injected `ctx`, verified above.

Three imports invert today and all three come out right:

- [`core/grant-rules.ts:29`](../../src/core/grant-rules.ts#L29) reaches **up**
  into `providers/claude-cli.js` for `isDestructiveRequest` / `isNetworkRequest`
  / `isConditionallyGatedBash`. Afterwards it imports a sibling.
- [`services/claude-settings.ts:15`](../../src/services/claude-settings.ts#L15)
  and [`services/history.ts:5`](../../src/services/history.ts#L5) pull a
  4421-line provider **for one type**. Afterwards they import `core/effort.ts`.
- [`ui/domains/models.ts:27`](../../src/ui/domains/models.ts#L27) takes
  `EFFORT_LADDERS` from the same place. Same fix.

`claude-cli.ts` has 6 importers. After this it has 3, and all of them actually
want a CLI provider.

### Dependency direction — verified, no cycles

```
core/permission-policy.ts   ← core/tool-grants.ts (type only)
        ↑
providers/cli/args.ts       (regexToCliPatterns, isDestructiveBash, isNetworkBash,
        ↑                    mcpToolPatterns — one-way, checked)
providers/claude-cli.ts     → events.ts, watchdog.ts, options.ts, args.ts
```

`makeProcessor` references **nothing** from the permission half — checked by
grep over 3848–4162. `buildArgs` references the classifier and not the reverse.
`ClaudeCliOpts` gets its own module precisely so `args.ts` and the provider can
both have it without one importing the other.

### The test migration is the easy half

[`test/unit/claude-cli.test.ts`](../../test/unit/claude-cli.test.ts) (3301
lines) imports 27 symbols, 24 of them pure. It splits along the same seam its
sibling already documents in a comment:

- `test/unit/permission-policy.test.ts` — `decidePermission`, the bash
  classifiers, `regexToCliPatterns`, `denialMessage`, `autoModeDenialReason`
- `test/unit/cli-events.test.ts` — `mapEvent`, `makeProcessor`, `contextSize`,
  `contextWindowOf`, `bridgeStatus`, `exitFailure`
- `test/unit/cli-args.test.ts` — `buildArgs`, `respawnFingerprint`,
  `turnPreamble`, `mcpToolPatterns` (merges `buildargs-allowedtools.test.ts`)
- `test/unit/claude-cli.test.ts` — what is left that needs the class

Splitting test files does not change the test count. **1508 / 6 must hold
exactly**, and here it is a strong signal rather than a weak one: 5200 lines of
existing tests are watching the whole move.

### Then, and only then: the control channel — NOT DONE, and correctly so

This step was planned on a wrong number. `handleControlRequest` was called 622
lines; **it is 109**, and the audit now carries the correction and the reason
(a member regex that cannot see `async *stream(`, so two generator methods went
uncounted and their lines were attributed to the method above them).

At 109 lines with three clearly separated paths it needs nothing. The step was
dropped rather than performed, which is the whole value of having written
"a decision to take after seeing the extracted method" instead of committing to
the extraction up front.

**What the provider's remaining 2143 lines actually are**, measured with
generators visible: `stream` 374 · `ensureSession` 258 · `streamInSession` 139.
The two stream generators are the real seam — and they are the same shape of
problem as `conversation-host.ts`'s turn loop in Phase 3b: stateful, long, and
duplicated between a session path and a per-turn path. Worth doing **with** 3b
rather than before it, so one decision covers both. Not scheduled here.

**Size:** large. **Risk:** low _for its size_ — the seam is proven by the test
layer. **Evidence:** the three gates, plus a manual turn in the real extension
because `package` cannot exercise a spawn.

---

## Phase 3 — `conversation-host.ts` — PART DONE 2026-08-04, PART RE-CUT

Landed: `conversation-format.ts` (102) and `prompt-attachments.ts` (96) — the
pure module-level tail, out of the class it never belonged to. 3189 → 3025.
Gates unchanged: 1508 / 6, lint exit 0 at 35 warnings, package 1.28 MB.

> **3a was NOT done, on this file's own instruction.** The rule below —
> "if the extracted interface needs more than ~8 members, that is the signal
> the seam is in the wrong place; stop and re-cut" — was written for 3b and
> applies here first. Measured before starting: the table touches **32 distinct
> class members across 128 references**, most of them private. Moving it would
> mean either publishing 32 members or hand-writing a 32-entry bridge that is
> the class re-declared. Neither is a seam; both are ceremony with a typo
> surface.
>
> What the table actually is, measured: **75 entries in 527 lines**, of which 37
> are ≤4 lines and hold 102 lines between them — genuine routing, correct where
> it is. The bulk sits in **13 entries of 10+ lines holding 246 lines, 47% of
> the table**: `permissionResponse` 59, `toggleRemoteControl` 28,
> `setPermissionMode` 27, `requestArtifactState` 17.
>
> **So the problem is not that the table is in the class — it is that logic got
> written inside a routing manifest.** The right move is to push those 13
> bodies down into `ui/domains/`, which already holds 20 modules taking explicit
> params (`removeCustomConnector(post, ctx, id)`) rather than a host. That is
> real work with real judgement per entry, not a mechanical lift, and it is
> what 3a should have said. Re-scoped rather than performed blind.
>
> Also dropped: "`html()` → `src/ui/webview-html.ts`". That module already
> exists and `html()` is a 7-line delegation to it. The plan asked for work
> that had been done before the plan was written.

### 3a (as originally written — kept for the reasoning, not the instruction)

Lines 1402–1918. Most entries are three-line adapters that validate `RawMessage`
fields and delegate to a `ui/domains/` function; 105 `this.` references means
they cannot simply be lifted, they need the host passed in.

Split by domain into `src/ui/handlers/`, each group a function returning a
typed slice:

```ts
// src/ui/handlers/chat.ts
export function chatHandlers(h: ConversationHost): Pick<HandlerTable,
  "prompt" | "cancel" | "newSession" | "permissionResponse" | …> { … }
```

composed in the class as

```ts
private readonly handlers: HandlerTable = {
  ...chatHandlers(this), ...planHandlers(this), ...mcpHandlers(this), …
};
```

**The load-bearing property is the exhaustiveness check**, and it survives: the
object literal is still annotated `HandlerTable`, so TypeScript still errors on
a missing key. That guarantee is the entire reason the table replaced a
`switch`, and any variant of this step that loses it is wrong. (What it does
_not_ catch is the same key supplied by two groups — cheap to avoid by domain,
worth a comment.)

### 3b. The turn loop — NOT DONE, and it must not be attempted as written

> **Measured 2026-08-04, after 3a, which is when this section said to measure.
> The abort criterion below fires, with room to spare.**
>
> The eight methods are **560 lines touching 45 distinct class members**:
> 20 methods called, **11 fields written**, 14 read-only collaborators. The
> extracted interface would be around 39 members against a stated ceiling of 8.
>
> | method                 | lines | members |
> | ---------------------- | ----- | ------- |
> | `runPromptTurn`        | 167   | 23      |
> | `startSessionProvider` | 133   | 22      |
> | `onTurnDelta`          | 115   | 11      |
> | `beginRemoteTurn`      | 68    | 19      |
> | `onSubagentUpdate`     | 49    | 7       |
> | the other three        | 28    | 2–6     |
>
> The eleven written fields are the finding: `activeTurn`, `activeProvider`,
> `orchestrator`, `remoteTurn`, `sessionProvider`, `resumeId`, `turnStartedAt`,
> `awaitingApproval`, `outOfTurnText`, `pendingSettings`, `finishedWhileHidden`.
> That is the turn's state. This section assumed the methods could leave and the
> state could stay; they are one object, and `turn-runner.ts` would be the class
> re-declared through an interface plus eleven setters.
>
> **The information this section was waiting for has arrived and it says no.**
> "3a shrinks the class enough to see the loop's actual dependencies" — 3a
> removed 45 lines and not one of them was reachable from the loop. The coupling
> is structural, not accumulated clutter that a previous phase would clear.
>
> **What was done instead**, on this file's own "stop and re-cut" instruction:
> the one cluster that does separate. `liveTasks` / `taskIdentity` /
> `reportedTasks` are three collections only ever touched together, read from
> outside the loop through `.size` and `.values()` alone. They became
> `ui/domains/subagent-roster.ts` — the merge precedence, the workflow
> `lastToolName` rule, the phase routing and the late-event guard, returning
> what an update _means_ while the host keeps `session.emit`, `post` and
> `scheduleSave`. 11 new tests over rules that previously needed the whole class
> to reach, including the guard whose comment records the bug it was written for.
>
> Scope: ~35 lines, not the ~600 this section promised. That gap is the finding.
>
> **What is left of the turn loop is a genuine design question, not a move.**
> Splitting it needs the state to move with the methods — a `Turn` object that
> owns its own lifecycle and that the host holds one of — which is a rewrite of
> the conversation's core with its ~4200 lines of tests driving the class rather
> than its parts. Worth deciding deliberately, alongside `claude-cli.ts`'s two
> stream generators as Phase 2 notes. Not a refactor phase.

### 3b (as originally written — kept for the reasoning, not the instruction)

[`runPromptTurn`](../../src/ui/conversation-host.ts#L2455) 180 ·
[`startSessionProvider`](../../src/ui/conversation-host.ts#L2290) 147 ·
[`onTurnDelta`](../../src/ui/conversation-host.ts#L2710) 130 ·
`beginRemoteTurn` · `onSubagentUpdate` · `emitSubagentEnd` ·
`flushOutOfTurnText` · `sweepLiveTasks`.

This is the seam the project map already names, and it is the genuinely hard one
in this plan: the state is real, the coupling is real, and its tests
(`conversation-*.test.ts`, ~4200 lines over 6 files) drive the class rather than
its parts. Do it **after** 3a, and only after: 3a shrinks the class enough to
see the loop's actual dependencies, which is information this plan does not have
yet.

If the extracted interface needs more than ~8 members, that is the signal the
seam is in the wrong place — stop and re-cut rather than pushing through.

### 3c. NOT the small ones — measured 2026-08-04, and two of the three are 3b again

> They are called "the small ones" because they are short. Short is not the
> measurement that matters here, and the same abort criterion fires:
>
> - `rewindTo` / `forkBeforeTruncating` / `editAt` touch **17 distinct class
>   members** between them — `checkpoints`, `history`, `sessions`, `activeTurn`,
>   `resumeId`, `steerIntoRunningTurn`, `runTurnReportingFailure`, `abortTurn`,
>   `handlePrompt`, `publishHistory`, `scheduleSave`, `settings`, `applySetting`,
>   `releaseSessionProvider`, `session`, `post`, `forkBeforeTruncating`. That is
>   the turn loop's state again, reached from a different door.
> - `ensureWorkingRoot` / `releaseWorktree` touch **9**, and
>   `services/worktree.ts` is today a clean module over explicit parameters
>   (`createWorktree(root, name)`). Moving these in would hand it panel state,
>   `post`, and two isolation flags — making the module worse to save nine lines
>   in the host.
>
> `html()` was already dropped above: the module exists and the method is a
> 7-line delegation to it.
>
> **So Phase 3 is closed at 3a plus the roster.** What is left of it is not
> refactor work; it is the `Turn` object question recorded under 3b.

**Superseded.** Original text: `html()` → `src/ui/webview-html.ts`, the rewind
trio → `src/ui/domains/rewind.ts`, the worktree pair → `services/worktree.ts`.

---

## Phase 4 — `ChatScreen.tsx`, the logic half — DONE 2026-08-04

Landed as `66d83eb` (the move) and `e13ec19` (the coverage it unlocked).
1360 → **699**. `group-events.ts` 401 · `render-groups.tsx` 237 ·
`InlineMessageEditor.tsx` 61. Suite 1508 → **1515 / 6** — the rise is the seven
new `groupEvents` tests and nothing else.

> **Two departures from what this section says, both deliberate.**
>
> **The renderers moved as functions, not components.** "They are components
> written as functions" is true and was still the wrong instruction: both
> already take everything explicitly and close over nothing, so relocating them
> changes nothing, while `<GroupView />` and `<TurnBlockView />` would each get
> their own fiber and their own re-render boundary. That belongs in Phase 6
> beside the other re-render decisions, measured, not smuggled into a move.
>
> **The built CSS changed, and the change is inert — proven, not assumed.**
> Byte length identical; 1750 rule blocks, same set when sorted, so not one
> rule added, removed or altered. What moved is the order of module-scoped
> blocks, because ChatScreen no longer imports the components whose stylesheets
> it pulled in. Order decides the cascade only between rules that can match the
> same element: of 1668 top-level rules the 105 with no CSS-modules hash are the
> only candidates, and **their relative order is unchanged**. Worth writing down
> because "the CSS is byte-identical" was the Phase 1 proof, and the first time
> that check fails is the moment to find out whether it was load-bearing.

1360 lines, of which ~500 contain no JSX at all.

- [`groupEvents`](../../webview/src/features/chat/ChatScreen.tsx#L827) — 272
  lines, signature `(events: TimelineEvent[]) => GroupingResult`, verified pure
  — plus `Group`, `TurnBlock`, `GroupingResult`, `RenderCtx`, `PLAN_TOOL_NAMES`,
  `WRITE_TOOL_NAMES`, `isPlanFileWriteEvent` → **`features/chat/group-events.ts`**.
  The convention exists: 14 such `.ts` modules already sit in that folder.
  It gets its own test in `webview/test/`, which is new coverage rather than
  moved coverage — so the test count _rises_, and that is the one place in this
  plan where it may.
- `renderGroup` (88) and `renderTurnBlock` (129) → `GroupView.tsx` /
  `TurnBlockView.tsx`. They are components written as functions.
- `InlineMessageEditor` (1316→) → its own file.

ChatScreen lands near ~600 lines and becomes what its name claims: a screen.

**Size:** medium. **Risk:** low. **Evidence:** gates + `/browser` — the timeline
is the most visible surface in the product, and "should render the same" is not
a result.

---

## Phase 5 — the overlay primitive — DONE 2026-08-04

Landed as `ac0bb67` (primitive + StopAgents), `db92b90`, `4c5cb19`, `1e9b1da`,
`8067163` (two), `eb32256`, `5c84f66`, `6f11e37` (three), `f1f95ab`. Gates held
at **1544 / 6**, lint exit 0 at 35 warnings, package 1.28 MB throughout.

> **The count was 13; it was 14, then 12, and the difference is the finding.**
> Sixteen SCSS modules hand-write a fixed backdrop. Two — `Tooltip` and
> `SkillDetailModal` — already portal themselves, leaving 14 rather than 13; one
> had been added since the plan was written. Two of those 14 turned out not to
> be overlays at all, so **12 migrated**.
>
> **The mechanism is worse than "the overlay clips".** Measured in the harness:
> an identical `position: fixed; inset: 0` under an ancestor carrying
> `transform: translateZ(0)` computes to **917×0 at top 902** against a 917×902
> viewport. It does not clip at an edge — it collapses to nothing and leaves the
> screen. framer writes `transform` inline on every `motion.*`, so any overlay
> inside an animated subtree is one refactor away from this. The note in
> `ChatScreen.module.scss` is the round of debugging it already cost.
>
> **`EditConfirmModal` was the proof it was already costing something.** Its SCSS
> carried `position: fixed !important; z-index: 1000 !important`, forced past a
> `.app > *:not(…)` selector scoring 0-5-1 that would otherwise have dropped the
> backdrop into normal flow and scrolled the whole sidebar. Rendering into
> `document.body` puts the element outside `.app`; both `!important`s are gone.
>
> **The primitive grew four props, each found by a migration rather than
> designed up front** — `panelMotion`, `backdropMotion`, `labelledBy`, and
> `wrapPanel`. The last is the one that matters: it hands the panel back whole
> for a drawer, a palette or a sheet whose panel is genuinely its own. That is
> the honest division — the portal is why the primitive exists; a centred sheet
> on a shared preset is a convenience for the common case.
>
> **One default was wrong and a migration caught it.** Focus fell through to the
> first focusable control. `EditConfirmModal` binds Enter to Revert, and a
> focused button activates on Enter — so both would have run, and not in the
> order the key means. Focus lands on the panel now unless a control asks with
> `data-autofocus`.
>
> **Not migrated, and it is not laziness:** `PlanReviewDropdown` and
> `SelectionCommentLayer`. Both are `position: fixed` anchored to coordinates
> from a `DOMRect`, not full-viewport backdrops — a popover, not a dialog.
> `Overlay` would give them `aria-modal`, a focus trap and a scroll lock, none of
> which belongs on a popover pinned to a text selection.
>
> **Corrected 2026-08-04, after measuring rather than assuming.** This entry
> first said they carry the same bug and that the fix was to extract Tooltip's
> private portal. Both halves were wrong:
>
> - **There is no primitive to extract.** Tooltip's portal is `createPortal`
>   plus placement logic — measure, flip above/below, clamp to the viewport —
>   and neither popover wants any of it. `PlanReviewDropdown` takes an
>   `anchor: {right, top}` from its parent; `SelectionCommentLayer` computes
>   from a `Range`'s rect and clamps itself. What they would need is one React
>   call, and wrapping one call in a component is ceremony.
> - **The bug is latent here, not live.** Measured in the harness: framer
>   settles a `y: 0` element on `transform: none`, which creates no containing
>   block — only an element mid-animation does. What does create one
>   permanently is `filter`, `backdrop-filter` and `will-change`; the chat
>   surface has five such elements, all in the header and the orb. In the plan
>   tree the only `filter: opacity()` sits on step rows, which are not ancestors
>   of either popover.
>
> So there is nothing to fix here today, and portalling a working popover to
> close a class of bug it is not currently hit by is the speculative change this
> plan's own scope rules warn against. Left alone deliberately. The thing worth
> writing down is the rule, not the change: **an overlay is safe until something
> above it grows a `filter`, and `filter: opacity()` is what this codebase uses
> for state-based dimming on framer surfaces** — so the two are one careless
> commit apart.
>
> **What was NOT verified, throughout.** The harness window stopped compositing
> partway through the session — `requestAnimationFrame` fell to 1–2 ticks per
> 300ms — so framer had nothing to drive and no enter/exit curve could be
> sampled after the first two migrations. StopAgents was measured at 208ms over
> 50 frames and Rewind at 206ms while it still painted. Everything else here is
> rAF-independent: portal parentage, computed layout, geometry, focus, scroll
> lock, and the built CSS. Escape was proven through the scroll lock releasing,
> which only happens when the effect cleanup runs. **The animations are owed a
> pass on a window that paints.**
>
> **The debt was paid 2026-08-04, and it found a bug.** A window opened fresh in
> the foreground composites at 73 rAF ticks per 300ms; navigating an existing
> tab does not, which is what had been happening. Nine of the twelve measured at
> 50 frames each:
>
> | overlay                                           | unmount | panel opacity at ¼ |
> | ------------------------------------------------- | ------- | ------------------ |
> | history drawer · command palette · keyboard hints | 208ms   | 0.917–0.919        |
> | permissions · background agents · stop agents     | 208ms   | 0.917–0.920        |
> | connectors                                        | 211ms   | 0.923              |
> | rewind (Phase 5)                                  | 206ms   | —                  |
>
> Declared: a 200ms panel exit on `DURATION.overlay`. **The quarter-way figure is
> the one that mattered** — the note on `EASE_SOFT` records that the old
> `EASE_OUT` left a dismissed panel at 0.47 there, invisible by halfway, which is
> why they read as "closing with no animation". At 0.92 these are symmetric.
>
> **And Escape did not close the history drawer at all.** It is the only overlay
> on `wrapPanel={false}`, so its panel is its own element inside the backdrop —
> and it kept its Escape handler on that panel while turning the primitive's off.
> Focus lands on the backdrop and keydown travels up, so the handler never saw
> the key. Fixed by giving the primitive an `onEscape` that replaces what the key
> DOES while it keeps owning WHERE it listens. **No amount of static review would
> have caught this; only pressing the key does.**
>
> **Three remain unmeasured, and the reason is the harness rather than the
> work.** `SkillsMarketplace` needs a catalog response `harness-host.ts` does not
> serve; `FileDiffModal`, `EditConfirmModal` and `ImageLightbox` need timeline
> content it does not produce — seeding a `tool_call` by hand did not reconstruct
> the shape `extract-file-edits` reads. `FileDiffModal` is the one that matters,
> since it carries the only bespoke `panelMotion` in the set. **Teaching the fake
> host to serve a file edit and a catalog page is the prerequisite**, and it is a
> harness gap worth closing on its own account: those surfaces cannot be checked
> at all today.

### Original text

The first phase that is _not_ a pure move, and the one with the best ratio of
lines removed to risk taken.

Today: **21** components hand-write `key === "Escape"`, **16** SCSS modules
hand-write a `position: fixed` overlay, and **only 3** use `createPortal`. The
other 13 render inside the component tree, where an ancestor's `overflow`,
`transform` or stacking context decides whether the overlay clips. That is a
latent bug class, and the reason this phase is worth its risk.

Build `design/primitives/Overlay.tsx` owning: portal, backdrop, Escape,
focus trap and restore, scroll lock, and `AnimatePresence` for the exit. Plus
`themes/_overlay.scss` for the sheet chrome — `themes/` currently exposes
exactly 2 mixins, both animation, and only 10 feature SCSS files `@use` it at
all. `useOutsideClose` already exists with 2 users; it folds in here.

Four traps this codebase has already paid for apply directly, and the primitive
is where they get paid once instead of sixteen times:

1. CSS cannot animate an exit — this needs framer + `AnimatePresence`.
2. Exits run on `--ease-soft`, never `--ease-out`.
3. framer writes `opacity` inline; no class rule outranks it.
4. A disabled control dispatches no mouse events — the reason `Tooltip` has a
   gate span, and the same applies to a backdrop click behind a disabled button.

**Migrate one modal per commit.** Thirteen behaviour changes in one diff is not
reviewable, and the failure mode here is visual and per-theme — it shows up in
one palette at one panel width and nowhere else.

Order: start with `EditConfirmModal` / `RewindModal` / `StopAgentsModal` (small,
few states), finish with `ConnectorsModal` (963 lines + 786 SCSS) and
`SkillsMarketplace` — by then the primitive has met most of its requirements.

**Size:** large, but divisible into 13 small pieces.
**Risk:** medium, and front-loaded onto the first migration.
**Evidence:** `/browser` per modal — measured open/close duration, no horizontal
overflow, focus lands and returns, Escape closes, contrast holds. Numbers, not
adjectives. Repeat in at least two themes.

---

## Phase 6 — webview state — MEASURED 2026-08-04, and the answer is mostly "no"

> This section said "6b does not start without the measurement from 6a's
> session", and allowed that writing down "prop drilling is cheaper" would be a
> successful outcome rather than a failed one. That is what happened. It also
> turns out **6a's own premise is false**, which the section could not have
> known.
>
> **6a is built on "the ~14 `on*` callbacks are stable references".** They are
> not. All fourteen are inline arrow functions at
> [App.tsx:537–609](../../webview/src/App.tsx#L537) — `onDismissVoiceError`,
> `onSubmit`, `onCancel`, `onPermissionRespond` and the rest — recreated on
> every `App` render, and `App` re-renders per token because `streaming` is its
> own state. Lifting them into a Context as they stand would publish a new
> context value on every token to every consumer, which is the exact failure
> 6b was written to avoid. Making them stable first is a prerequisite nobody
> costed, and it is most of the work.
>
> **The measurement 6b required, taken in the harness.** 40 tokens streamed at
> 12ms apart, every DOM mutation under `document.body` recorded and grouped:
>
> |                 | with 40 tokens | control, 0 tokens, same duration |
> | --------------- | -------------- | -------------------------------- |
> | `attributes`    | 35 829         | **34 768**                       |
> | `characterData` | 41             | 0                                |
> | `childList`     | 37             | 0                                |
>
> The control is the finding. **Streaming costs 41 + 37 mutations for 40
> tokens — about two per token.** Everything else is `DotGlobe`: roughly 200
> `<circle>` elements re-writing `fill`, `cx`, `cy`, `r` and `opacity` every
> frame, ~34 700 mutations in a 680ms window, running identically when nothing
> is streaming at all. The panel's DOM cost during a turn is an animated globe,
> not the state architecture.
>
> **So 6b does not land.** There is no re-render problem to solve; splitting
> `ChatScreenProps` by change frequency would be restructuring against a cost
> that measurement cannot find.
>
> **The limit of this measurement, stated rather than glossed.** It counts DOM
> output, not React work. `__REACT_DEVTOOLS_GLOBAL_HOOK__` is absent in the
> harness, so components that re-render and produce no DOM change were not
> counted, and that cost is real and unmeasured. What can be said is that
> whatever React is doing per token, it results in two DOM mutations — so it is
> not producing visible churn.
>
> **What survives, and is worth doing on its own merits:** the half of 6a that
> was never about Context. `onSubmit` rewrites pinned files into `@`-mentions
> and `onCancel` decides whether running agents need a confirmation, both
> written inline in JSX where no test can reach them. Those belong in named
> functions in a module. That is a small, safe extraction with a real gain and
> no re-render implications, and it does not need `ActionsContext` to happen.

### Original text

## Phase 6 — webview state (⚠ behaviour change, decision required)

`ChatScreenProps` declares **42 fields** and [App.tsx:517](../../webview/src/App.tsx#L517)
passes all 42. `webview/src/` contains **zero** `createContext`.

**This is the phase where the obvious answer is probably wrong.** Wrapping
`events` and `streaming` in a Context re-renders every consumer on every token —
during a turn `streaming` changes tens of times per second. Prop drilling is
ugly; it is also, right now, doing an accidental job of keeping the re-render
boundary where it belongs. Replacing it blindly makes the product slower and
the code prettier, which is a bad trade in a panel people watch stream.

So the phase splits, and the second half is conditional on the first:

**6a — the actions half (safe).** The ~14 `on*` callbacks are stable references
that do not change per token. They become one `ActionsContext` created once in
`App`, with the business logic currently written inline in JSX — pinned-file
`@`-mention rewriting in `onSubmit`, the stop-with-running-agents decision in
`onCancel` — moved into named functions where it can be tested. Removes roughly
a third of the props and carries no re-render risk.

**6b — the state half (measure first).** Before touching it: profile a live
streaming turn in the harness and record what re-renders today. Then, if it is
worth it, split by change frequency, never by domain — a `StreamingContext`
that changes constantly and a `SessionContext` that changes rarely, so the fast
one has few consumers.

**6b does not start without the measurement from 6a's session.** If the numbers
say prop drilling is currently cheaper, the honest outcome is to write that down
in this file and stop — that is a successful phase, not a failed one.

**Size:** 6a small, 6b unknown by construction.
**Evidence:** 6a — gates + harness. 6b — before/after render counts, or it does
not land.

---

## Phase 7 — the tidy-up (pure move, mechanical)

Last on purpose: it organises the _final_ shape rather than moving files that
Phases 4–6 are about to split.

- **`features/chat/` — 96 files in one flat directory** → `timeline/`,
  `composer/`, `modals/`, `pickers/`, `usage/`, `state/`. `features/` itself has
  only 5 entries, so `chat` absorbed everything that was not obviously one of
  the other four.
- **`services/mcp/index.ts`** — 1131 lines, several transports in one module.
  The seam is one file per transport and it was already started:
  `stdio-client.ts` and `client.ts` exist.
- **`ConnectorsModal.tsx`** — 963 lines + 786 SCSS. Largely dissolves once
  Phase 5 exists; whatever is left is the connector flows, one file each.

**Size:** medium. **Risk:** none beyond import churn. **Evidence:** gates.

---

## Not in scope, deliberately

- [`webview/src/lib/rpc.ts`](../../webview/src/lib/rpc.ts) — 1029 lines, and it
  is the protocol union. Length is correct here; splitting it weakens the
  exhaustiveness that makes the whole seam safe.
- `webview/src/theme.css` — 959 lines, a declared shared resource, and named in
  CLAUDE.md as the cause of the last three rounds of parallel-agent conflicts.
- Inherited host paths with no growth and no complaint. A refactor is a bad
  place to discover which ones were load-bearing.
- **Anything that changes what the user sees.** This is a refactor. A better
  idea found along the way goes in `docs/PLAN.md`, not in the diff.

---

## Order, and where to stop

```
0  clear the runway        precondition
1  free wins               small · no risk
2  claude-cli split        large · low risk for its size   ← the main win
3  conversation-host       large · medium risk
4  ChatScreen logic        medium · low risk
5  overlay primitive       large but divisible · ⚠ behaviour
6  webview state           6a small · 6b measure first · ⚠ behaviour
7  tidy-up                 medium · mechanical
```

Phases 1–4 are pure moves and every one of them is independently shippable.
**Stopping after 4 is a complete, coherent outcome**: the two god files are gone,
the layering inversion is fixed, and nothing the user can see has moved.

Phases 5–6 are where this stops being bookkeeping and starts being design. They
are worth doing and they are not free, and they should be decided on after 1–4
has shown how the gate loop behaves on a diff this size.

---

## Rollback

One phase per commit, no phase depending on an unlanded one, and every pure move
provable by an unchanged test count. A phase that goes wrong is a `git revert`
of one commit, not an archaeology session — which is the actual reason for the
granularity, not tidiness.
