<!-- Measured statically 2026-08-03 against the working tree at fc25b53 (main,
     level with origin/main, with the src/prompts + external/native reorg staged
     but uncommitted). Every line number and count below came from grep/wc over
     the tracked sources — nothing was run, nothing was profiled. Where a claim
     needs a running process to settle, it is not made. -->

# Refactor surfaces — where the structure has outgrown the files

Scope: `src/` (24 985 lines tracked) and `webview/src/` (37 950 lines tracked).

**The finding that frames the rest:** line-level hygiene is not the problem.
Across both halves there are **4** `: any` / `as any`, **6** `eslint-disable`,
**0** `@ts-ignore`, **1** `TODO`. Nothing here needs cleaning. What has drifted
is **module boundaries** — a handful of files absorbed concerns that have no
reason to sit together, and the seams they need are already visible in the
tests and in the import graph.

Findings are ordered by (size of the win) × (inverse of the risk).

---

## A. `src/providers/claude-cli.ts` — 4421 lines, six concerns, one file

Grown +3.4% since the map recorded 4274. It is the largest file in the repo by
a factor of 1.4 and holds six things that do not depend on each other.

| #   | Concern               | Lines                           | ≈ size | Touches a process? |
| --- | --------------------- | ------------------------------- | ------ | ------------------ |
| 1   | Permission classifier | 112–364, 2949–3504              | ~810   | no — pure          |
| 2   | Stream parsing        | 3505–3731, 3747–4162, 4269–4421 | ~700   | no — pure          |
| 3   | Control channel       | 900–1674                        | ~770   | yes                |
| 4   | argv construction     | 2496–2571, 2637–2948            | ~390   | no — pure          |
| 5   | Stall watchdog        | 4169–4252                       | ~85    | no — pure          |
| 6   | Process lifecycle     | 531–900, 1674–2495              | ~1200  | yes — the provider |

Only #3 and #6 are actually a "CLI provider". Roughly **2000 lines are pure
functions** that need no child process, no VS Code, no filesystem.

> **CORRECTION, 2026-08-04.** This section originally called
> `handleControlRequest` "the single largest function in the repository — 622
> lines". **It is 109 lines.** The 622 came from a grep whose member pattern
> was `^ {2}(private )?(async )?[a-zA-Z_]`, which cannot match `async *stream(`
> — the `*`. Both generator methods were therefore invisible, and the
> measurement ran from `handleControlRequest` straight past them to the next
> member it could see, swallowing `stream` (374 lines) and `streamInSession`
> (139) into the total.
>
> The real ranking inside the provider, measured with generators visible:
> `stream` 374 · `ensureSession` 258 · `streamInSession` 139 ·
> `handleControlRequest` 109. The rest of this file's numbers were re-checked
> against the same corrected pass and hold — including every figure in the
> `conversation-host.ts` section below.
>
> Kept rather than edited away because the wrong number drove a planned step
> (extracting the `can_use_tool` path), and because a line-count claim is
> exactly the kind that reads as measured when it was only greped. A regex over
> declarations is a sampling method, not a measurement, and it fails silently.

Functions worth naming, corrected:
[`makeProcessor`](src/providers/claude-cli.ts#L3848) 314 lines,
[`buildArgs`](src/providers/claude-cli.ts#L2670) 247 lines, and the `CliEvent`
interface at [3535](src/providers/claude-cli.ts#L3535) — 196 lines of type
describing someone else's wire format.

### The split is already proven — by the tests

[`test/unit/claude-cli.test.ts`](test/unit/claude-cli.test.ts) is 3301 lines and
imports **27 symbols**, of which 24 are pure functions — `mapEvent`,
`makeProcessor`, `buildArgs`, `decidePermission`, `isDestructiveBash`,
`isNetworkBash`, `regexToCliPatterns`, `contextSize`, `contextWindowOf`,
`isReadOnlyShellCommand`, `gitSubcommand`, `bridgeStatus`, `exitFailure`,
`turnPreamble`, `respawnFingerprint`, `mcpToolPatterns`, `denialMessage`,
`autoModeDenialReason`, `createToolStallWatchdog`… Only `ClaudeCliProvider`
needs a process.

Its sibling [`claude-cli-stream.test.ts`](test/unit/claude-cli-stream.test.ts)
(1918 lines) opens with a comment stating it is _"kept in its own file so the
module mock doesn't leak into the pure-unit tests in claude-cli.test.ts"_.

**The test layer already drew the boundary the source refuses to.** That makes
this the cheapest large win available: moving the pure half costs an import-path
edit in two test files, not a rewrite, and 5200 lines of existing tests keep
guarding it the whole way.

### It also repairs a layering inversion

`src/core/*` is specified to import zero VS Code and sit under everything. It
does not:

- [`src/core/grant-rules.ts:29`](src/core/grant-rules.ts#L29) imports
  `isConditionallyGatedBash`, `isDestructiveRequest`, `isNetworkRequest` from
  `../providers/claude-cli.js` — core reaching **up** into providers. A comment
  at line 25 acknowledges it and points at `core/orchestrator.ts` doing the same.
- [`src/services/claude-settings.ts:15`](src/services/claude-settings.ts#L15) and
  [`src/services/history.ts:5`](src/services/history.ts#L5) each pull the
  4421-line provider module **for one type** (`EffortLevel`).

`claude-cli.ts` has 6 importers. Extracting the classifier and the effort ladder
removes the module from **3** of them entirely.

---

## B. `src/ui/conversation-host.ts` — 3190 lines

Grown +8.8% since the map recorded 2931. `ui/domains/` holds **20** extracted
files and the growth still outran it — because the two biggest things in the
class were never candidates for that pattern.

1. **The handler table is still inline: ~528 lines**, from
   [1402](src/ui/conversation-host.ts#L1402) to 1918. The `HandlerTable` type is
   good design — a missing message type is a compile error — but the literal
   itself sits in the god class, and most entries are three-line adapters that
   parse `RawMessage` fields and delegate to a `ui/domains/` function. The
   pattern to move it already exists and already works.
2. **The turn loop, ~600 lines and no seam.**
   [`runPromptTurn`](src/ui/conversation-host.ts#L2455) 180 ·
   [`startSessionProvider`](src/ui/conversation-host.ts#L2290) 147 ·
   [`onTurnDelta`](src/ui/conversation-host.ts#L2710) 130 ·
   `beginRemoteTurn` · `onSubagentUpdate` · `emitSubagentEnd` ·
   `flushOutOfTurnText` · `sweepLiveTasks`. The map already names this: _"Next
   seam is the turn loop, not more handlers."_ Concur — and it is now the only
   part of the file with no test that can reach it in isolation.
3. Alongside those, the same class also owns: worktree lifecycle
   (`ensureWorkingRoot`, `releaseWorktree`), checkpoint/rewind/fork (`rewindTo`,
   `forkBeforeTruncating`, `editAt`), history (`publishHistory`,
   `loadHistorySession`, `renameConversation`), surface/visibility
   (`show`/`hide`/`attach`/`refreshSurface`), and
   [`html()`](src/ui/conversation-host.ts#L2956) — the webview bootstrap markup.

Riskier than A: no pure/impure line runs through it, and its tests
(`conversation-*.test.ts`, ~4200 lines across 6 files) drive the class, not its
parts. Worth doing, worth doing second.

---

## C. `webview/src/features/chat/ChatScreen.tsx` — 1360 lines, 42 props

- [`ChatScreenProps`](webview/src/features/chat/ChatScreen.tsx#L79) declares
  **42 fields across 75 lines**, and
  [App.tsx:517](webview/src/App.tsx#L517) passes **all 42** — verified on both
  sides. Roughly a third are `on*` callbacks, several of which carry real logic
  written inline in the JSX: pinned-file auto-mention rewriting inside `onSubmit`,
  and the stop-with-running-agents decision inside `onCancel`.
- **`webview/src/` contains zero `createContext`.** Grepped the whole tree.
  Every value reaches its component by being threaded through `App` →
  `ChatScreen` → card. That is the mechanical cause of both the 42-prop
  signature and the "five hops" trap CLAUDE.md already warns about.
- [`groupEvents`](webview/src/features/chat/ChatScreen.tsx#L827) is **272 lines
  of pure timeline-grouping logic in a `.tsx` file** — no JSX inside it — plus
  `renderGroup` (88), `renderTurnBlock` (129), and the `PLAN_TOOL_NAMES` /
  `WRITE_TOOL_NAMES` / `isPlanFileWriteEvent` block. That is ~500 lines that
  could be a tested module; `features/chat/` already has 14 such `.ts` files
  (`subagent-state.ts`, `tool-buckets.ts`, `usage-view.ts`), so the convention
  exists.

`App.tsx` itself is 624 lines with 24 `useState`/`useRef`.

---

## D. Missing webview primitives — the same code written 16 to 21 times

`design/primitives/` holds 8 primitives (Chip, DotGlobe, Dropdown, IconButton,
Kbd, Orb, RichEditor, Tooltip) and **no Modal, Sheet, or Overlay**.

- **21** components hand-write `key === "Escape"`.
- **16** `.module.scss` files hand-write a `position: fixed` overlay; **32**
  occurrences of `inset: 0` / `backdrop-filter` across `features/`.
- **Only 3** of them use `createPortal` (Tooltip, SkillDetailModal,
  InlineCommentThreads). The other 13 render inside the component tree, so an
  ancestor's `overflow`, `transform` or stacking context decides whether the
  overlay clips. **This one is a latent bug class, not just duplication** — and
  it is the kind that shows up in one theme or one panel width and nowhere else.
- `useOutsideClose` exists in primitives and has **2** users (Dropdown,
  ThemePicker). Every other dismissable surface re-solved it.
- `themes/` exposes exactly **2** mixins, both animation (`halo-breathe`,
  `spin`), and only **10** of the feature SCSS files `@use` themes at all. The
  five largest SCSS files in the repo are modal chrome:
  ConnectorsModal 786 · SkillsMarketplace 736 · FileDiffModal 716 ·
  HistoryDrawer 616 · ModelPicker 542.

Highest ratio of "lines removed" to "risk taken" of anything on this list.

---

## E. `webview/src/features/chat/` — 96 files, one flat directory

45 `.tsx` + 14 `.ts` + their SCSS modules, unsorted: modals, popovers, pickers,
cards, the composer, the markdown renderer, and pure state modules all as
siblings. `features/` itself has only 5 entries (auth, chat, mcp, plan, theme),
so `chat` absorbed everything that was not obviously one of the other four.

Costs nothing but moves and import rewrites; pays every time someone opens the
directory.

---

## F. Duplicated small utilities — no `lib/format.ts` on either side

- `formatCount` is **byte-identical** in
  [SkillDetailModal.tsx:240](webview/src/features/chat/SkillDetailModal.tsx#L240)
  and
  [SkillsMarketplace.tsx:633](webview/src/features/chat/SkillsMarketplace.tsx#L633).
- Number compaction is implemented **five** times: those two, plus
  `formatTokens` in [tool-buckets.ts:137](webview/src/features/chat/tool-buckets.ts#L137),
  `formatCompact`/`formatNum` in [usage-view.ts:147](webview/src/features/chat/usage-view.ts#L147),
  and host-side `fmtTokens` at
  [conversation-host.ts:3058](src/ui/conversation-host.ts#L3058).
- `formatRelativeTime` exists **twice**:
  [HistoryDrawer.tsx:534](webview/src/features/chat/HistoryDrawer.tsx#L534) and
  [plan/summary.ts:77](webview/src/features/plan/summary.ts#L77) — the second
  takes an injectable `now`, the first does not, so they cannot even be tested
  the same way.

---

## G. Smaller, cheap, uncontroversial

- [`src/core/types.ts`](src/core/types.ts) — 671 lines, **17 importers**, and it
  mixes four domains: chat primitives (Message/ContentBlock), the stream
  protocol (`StreamDelta`, `TokenUsage`, `CompactionInfo`), permissions
  (`PermissionRequestPayload`, `GrantScope`, dialogs), and **the entire plan
  model** at 552–671 (`PlanTask`, `PlanSections`, `PlanQuestion*`,
  `PlanComment*`, `PlanRevisionMeta`). The plan half is a self-contained domain
  and splitting it changes 17 import lines and nothing else.
- **32 `Ф<digit>` phase labels** still in code across `src/`, `webview/src/` and
  SCSS. `.claude/rules/comments.md` already classifies these as _"a known
  cleanup, not a pattern to follow"_. Mechanical.
- [`src/services/mcp/index.ts`](src/services/mcp/index.ts) — 1131 lines, several
  transports in one module. The map already names the seam (one per transport)
  and `stdio-client.ts` / `client.ts` show it was started.
- [`features/mcp/ConnectorsModal.tsx`](webview/src/features/mcp/ConnectorsModal.tsx)
  963 lines + 786 lines of SCSS — modal shell plus every connector flow in one
  component. Largely dissolves once D exists.

---

## What not to touch

- [`webview/src/lib/rpc.ts`](webview/src/lib/rpc.ts) — 1029 lines, but it is the
  protocol union. Long is correct here; splitting it weakens the exhaustiveness
  that makes the seam safe. The map's judgement stands.
- `webview/src/theme.css` — 959 lines and a declared shared resource. The map
  says parts are genuinely un-modularisable; touching it from parallel work is
  named in CLAUDE.md as the cause of the last three rounds of conflicts.
- Inherited host paths with no growth and no complaint. The map's rule holds: a
  surprise in `src/` is probably "always been like that", and a refactor is a
  bad place to find out which ones were load-bearing.

---

## Two conditions before any of this starts

1. **The tree is not clean.** 26 staged-but-uncommitted changes: `prompts/` →
   `src/prompts/`, `native/luno-audio/` → `external/native/luno-audio/`, plus
   `.gitignore`, `.vscodeignore`, `eslint.config.mjs` and both CI workflows.
   A refactor landing on top of an uncommitted move makes both undiagnosable.
   Land it or stash it first.
2. **The gate numbers are the contract.** `bun run test` at 1122 passed /
   6 skipped, `bun run lint` clean. A pure-move refactor that changes either
   number changed behaviour — which is the only thing that makes this class of
   work verifiable at all.
