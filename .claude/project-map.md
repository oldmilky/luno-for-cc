# Project map

_Generated 2026-07-28. Regenerate with `/analyze` after structural changes._
_Not auto-loaded — read it before working somewhere you have not been._

## Two halves

Two separately-compiled programs joined by one seam. `src/` is the **extension
host**: Node, VS Code APIs, spawns the user's `claude` CLI — 66 files, 18 137
lines. `webview/src/` is a standalone **React app** that never imports a VS Code
API and cannot see the filesystem — 154 files, 34 832 lines. They talk only
through `postMessage`, typed in `webview/src/lib/rpc.ts`.

**The seam is enforced now — this changed.** `src/ui/messages.ts` declares
`InboundType`, and `HandlerTable = Record<InboundType, Handler>` makes a missing
handler a **compile error** rather than a message that silently does nothing.
`test/unit/protocol-contract.test.ts` reads both files as text and fails when
`Outbound` and `InboundType` drift. Adding a message to one side only no longer
ships — it goes red in `bun run lint` or `bun run test`.

What is still unenforced: the _payload_. Types do not cross the boundary, so
what arrives host-side is genuinely `unknown` and is read through the field
readers in `messages.ts` (`str`, `num`, `bool`, `obj`, `arr`, `oneOf`), each
returning `undefined` rather than coercing. A field renamed on one side passes
both gates and reads back `undefined`.

## Extension host — `src/`

| Path                          | Owns                                                        | Lines |
| ----------------------------- | ----------------------------------------------------------- | ----- |
| `providers/claude-cli.ts`     | spawn, stream-json parsing, the control protocol            | 4274  |
| `ui/conversation-host.ts`     | one conversation: session, checkpoints, turn, handler table | 2931  |
| `ui/domains/`                 | **18 files** — handlers split out by domain                 | 3296  |
| `services/mcp/`               | connectors — index 1122, oauth 551, stdio 289, client 274   | 3063  |
| `core/`                       | orchestrator, session, plan-intercept, types, classifiers   | 2370  |
| `ui/conversation-registry.ts` | every live conversation, shared services, the sidebar swap  | 537   |
| `services/checkpoint.ts`      | snapshot and restore                                        | 464   |
| `providers/factory.ts`        | binary discovery — the single entry point                   | 316   |
| `ui/webview-html.ts`          | the page for both surfaces, prod and dev-server branches    | 162   |
| `ui/panel.ts`                 | the `WebviewViewProvider` contract and the bound commands   | 129   |
| `ui/plan-artifact-panel.ts`   | the plan revision opened as a real editor tab               | 116   |
| `extension.ts`                | `activate` — output channel, terminal capture, panel        | 65    |

Inside `ui/domains/`: `plan-handlers` 512, `files` 440, `models` 418, `skills`
303, `session-store` 270, `auth` 260, `connectors` 254, then eleven under 180. A
domain takes a `Post`, not the provider, which is what keeps it from reaching
back into panel state.

`services/claude-settings.ts` is newer and reads the _user's own_ Claude config
(`~/.claude/settings.json`) rather than any `luno.*` setting — the timeout a
question waits, the permission modes a policy forbids. A preference already set
for Claude Code is honoured here rather than asked for twice.

**`src/core/*` imports zero VS Code APIs** — verified by grep, not assumed. That
is the only part testable without a mock editor, and where logic belongs.

## Webview — `webview/src/`

| Path                  | Owns                                                                | Lines    |
| --------------------- | ------------------------------------------------------------------- | -------- |
| `features/chat/`      | **90 files** — chat surface, composer, diffs, meters, pickers       | ~22.5k   |
| `features/plan/`      | **30 files** — plan review, inline comments, revisions              | ~5.6k    |
| `lib/rpc.ts`          | the protocol, both directions                                       | 961      |
| `theme.css`           | what cannot be a module — resets, aurora, markdown, hljs            | 959      |
| `App.tsx`             | the chat shell — routing, boot handshake, global state              | 592      |
| `themes/`             | **7 palettes** + `_base.scss` + `_motion.scss`                      | 503      |
| `design/motion.ts`    | **22 exported presets** — every duration, curve, spring             | 363      |
| `lib/harness-host.ts` | the fake host `/browser` boots against, typed against `Inbound`     | 300      |
| `design/icons.tsx`    | **45 registry entries**, one Solar Linear import each               | 234      |
| `design/primitives/`  | Chip, DotGlobe, Dropdown, IconButton, Kbd, Orb, RichEditor, Tooltip | 18 files |
| `ArtifactApp.tsx`     | the second surface — same bundle, `window.LUNO_MODE`                | 112      |
| `main.tsx`            | entry — picks chat or artifact shell, wraps both in the boundary    | 57       |

**One bundle, two surfaces.** `main.tsx` reads `window.LUNO_MODE` to mount either
`App` (chat sidebar) or `ArtifactApp` (a plan revision in an editor tab). The
host re-posts every event to both, so a mutation made in one appears in the
other. Anything added to the chat shell needs a thought about the artifact one.

Both mount inside `ErrorBoundary`. A webview has no crash screen of its own — a
render throw unmounts the tree and leaves the background colour, which from the
outside is indistinguishable from a dead extension host. The boundary turns that
into a message with the stack on screen.

Palettes: `blue` `copper` `green` `pink` `purple` `red` `white`. Icons are Solar
Linear imported per-icon per-style — the barrel measured ~9.6 kB/icon against
~1.1 kB, an 8.5× difference, and the comment in `icons.tsx` says so.

## The protocol

72 outbound types (webview → host), 47 inbound (host → webview). The area split
below is approximate and drifts; the two totals are counted off the unions in
`lib/rpc.ts`.

| Area                 | Out | In  |
| -------------------- | --- | --- |
| plan + artifact      | 15  | —   |
| chat + turn          | 13  | 20  |
| files / editor       | 8   | 5   |
| skills / marketplace | 8   | 7   |
| auth / setup         | 7   | 3   |
| MCP / connectors     | 7   | 2   |
| settings / models    | 6   | 4   |
| usage / remote       | 3   | 2   |
| conventions          | 3   | 2   |
| approvals + dialogs  | 2   | 4   |

Plan is the heaviest outbound area and carries no inbound of its own — plan state
reaches the webview folded into `timeline`, which is why `fold-plan-state` is
tested on both sides.

**Approvals and dialogs are two channels, not one.** `permissionRequest` /
`permissionResponse` gate a tool call; `userDialog` / `userDialogResponse` carry
a decision that is not about a tool at all, and the CLI only sends the second to
a client that declared the kind in `initialize`. Both block the turn, both are
withdrawn by `control_cancel_request`, and both must be answered when the panel
closes or the CLI waits forever.

## Where to change what

| To add…                   | Touch                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| a message across the seam | `lib/rpc.ts` union, `ui/messages.ts` `InboundType`, **and** an entry in the handler table |
| a handler for one domain  | `ui/domains/<domain>.ts` — not `conversation-host.ts`                                     |
| a colour, radius, shadow  | a token in `themes/*` — never a component                                                 |
| a palette                 | one file in `themes/` + `index.scss` + `THEMES` in `lib/theme.ts`                         |
| a duration or curve       | `design/motion.ts` — then spread the preset                                               |
| an icon                   | one Solar import + one `SOLAR` entry in `design/icons.tsx`                                |
| a tooltip                 | `design/primitives/Tooltip` — never `title=`                                              |
| a settings key            | `package.json` `contributes.configuration` + the reader                                   |
| a harness reply           | `lib/harness-host.ts` — typed against `Inbound`, so a stale one fails lint                |

## Shared resources — edit deliberately

`webview/src/theme.css`, `webview/src/design/motion.ts`,
`webview/src/themes/_base.scss`.

Everything reads them, so an edit is global by construction and two agents
touching them at once is how earlier parallel rounds produced conflicts. When
fanning work out, the orchestrator edits these first, alone, then the batches
run.

## Provenance

The extension host is inherited and largely unreviewed by us — it came working
and has been changed where it was wrong (binary discovery, error paths) and
where it grew (`ui/domains/`, the handler table, remote control). The webview
was rewritten across six phases and is ours. Treat a surprise in `src/` as
"probably always been like that" and one in `webview/src/` as "probably
introduced recently".

## Size and debt

| File                               | Lines | Judgement                                                                                                                                                                                                                   |
| ---------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/claude-cli.ts`          | 4274  | **+60% since the last map** and by far the largest file. Every control-protocol subtype now lands here beside the parser and the process lifecycle. The seam that would actually help is the control channel, not the spawn |
| `ui/conversation-host.ts`          | 2931  | Still growing despite `ui/domains/` holding 18 files. The extraction worked; the growth outran it. Next seam is the turn loop, not more handlers                                                                            |
| `features/chat/ChatScreen.tsx`     | 1313  | Owns too much state for one component. Grew again with the question and dialog surfaces                                                                                                                                     |
| `services/mcp/index.ts`            | 1122  | Several transports in one module; a natural seam per transport                                                                                                                                                              |
| `lib/rpc.ts`                       | 961   | A type file. Long is fine; it is the protocol                                                                                                                                                                               |
| `features/mcp/ConnectorsModal.tsx` | 963   | Modal plus every connector flow                                                                                                                                                                                             |
| `webview/src/theme.css`            | 959   | Genuinely un-modularisable in parts, but worth re-checking which parts                                                                                                                                                      |
| `design/primitives/RichEditor.tsx` | 919   | contenteditable serialisation — inherently dense, not accidental                                                                                                                                                            |
| `features/chat/TokenMeter.tsx`     | 777   | Was 1169; the plan picker and editor moved out. The seam held                                                                                                                                                               |

`Composer.tsx` 771, `SkillsMarketplace.tsx` 648, `FileDiffModal.tsx` 628,
`ToolCard.tsx` 612. Everything else under 600.

**Tests:** 72 files — 55 in `test/unit/`, 14 in `test/webview/`, 3 in
`webview/test/` (the jsdom half, rooted there because React lives only in
`webview/node_modules`). The pass count lives in `CLAUDE.md` and only there;
this file would only drift it.

Two known flakes, both teardown races rather than logic: `conversation-worktree`
(`EPERM` on temp cleanup under parallel load on Windows) and
`conversation-steering` (`ENOENT` writing a session file into a directory
`afterEach` already removed). Both pass run alone; both surface as vitest's
"Unhandled Errors" with every test still green.

**Lint:** 35 eslint warnings, all React Compiler rules from `react-hooks@7`
(`refs` 21, `set-state-in-effect` 7, `immutability` 3, memoisation 1). Real, held
at `warn` on purpose — see the comment in `eslint.config.mjs`.
