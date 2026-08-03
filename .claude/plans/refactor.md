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

### Then, and only then: the control channel

[`handleControlRequest`](../../src/providers/claude-cli.ts#L1052) is 622 lines —
the largest function in the repository — and it is three unrelated paths behind
one entry point. The first two already delegate (`request_user_dialog` →
`raiseUserDialog`, `mcp_message` → `answerMcpMessage`); the remaining ~600 lines
are the `can_use_tool` path inline.

Extract that path to its own method first — a mechanical, reviewable step that
takes the file under 1500 lines on its own. Whether the channel then becomes a
`ControlChannel` class owning `pendingControls` / `sendControl` /
`resolveControl` / the id counter and timeouts is a **decision to take after
seeing the extracted method**, not before. The project map nominates this seam;
it does not yet know its shape, and neither do I.

**Size:** large. **Risk:** low _for its size_ — the seam is proven by the test
layer. **Evidence:** the three gates, plus a manual turn in the real extension
because `package` cannot exercise a spawn.

---

## Phase 3 — `conversation-host.ts` (pure move, large, harder)

3190 lines. Two things dominate and neither was a candidate for the
`ui/domains/` pattern that already holds 20 files.

### 3a. The handler table — ~528 lines, out of the class

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

### 3b. The turn loop — ~600 lines, `src/ui/turn-runner.ts`

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

### 3c. The small ones, same phase

- `html()` at [2956](../../src/ui/conversation-host.ts#L2956) → `src/ui/webview-html.ts`
- `rewindTo` / `forkBeforeTruncating` / `editAt` → `src/ui/domains/rewind.ts`
- `ensureWorkingRoot` / `releaseWorktree` → into the existing `services/worktree.ts`

**Size:** large. **Risk:** medium — no pure/impure line runs through this file.
**Evidence:** the three gates, plus a real turn, a rewind, and a fork exercised
by hand.

---

## Phase 4 — `ChatScreen.tsx`, the logic half (pure move, medium)

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

## Phase 5 — the overlay primitive (⚠ behaviour change, high value)

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
