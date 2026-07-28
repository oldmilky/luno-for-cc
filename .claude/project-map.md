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
| `providers/claude-cli.ts`     | spawn, stream-json parsing, the control protocol            | 2675  |
| `ui/conversation-host.ts`     | one conversation: session, checkpoints, turn, handler table | 2592  |
| `services/mcp/`               | connectors — index 1122, oauth 551, stdio 289, client 274   | 3013  |
| `ui/domains/`                 | **17 files** — handlers split out by domain                 | 3373  |
| `core/`                       | orchestrator, session, plan-intercept, types, classifiers   | 2003  |
| `ui/conversation-registry.ts` | every live conversation, shared services, the sidebar swap  | 503   |
| `services/checkpoint.ts`      | snapshot and restore                                        | 464   |
| `providers/factory.ts`        | binary discovery — the single entry point                   | 296   |
| `ui/webview-html.ts`          | the page for both surfaces, prod and dev-server branches    | 162   |
| `ui/panel.ts`                 | the `WebviewViewProvider` contract and the bound commands   | 129   |
| `ui/plan-artifact-panel.ts`   | the plan revision opened as a real editor tab               | 116   |
| `extension.ts`                | `activate` — output channel, terminal capture, panel        | 65    |

`ui/domains/` is the newest structure and the old map predates it: `plan-handlers`
474, `files` 440, `models` 418, `skills` 303, `session-store` 270, `auth` 260,
`connectors` 254, then twelve under 160. A domain takes a `Post`, not the
provider, which is what keeps it from reaching back into panel state.

**`src/core/*` imports zero VS Code APIs** — verified by grep, not assumed. That
is the only part testable without a mock editor, and where logic belongs.

## Webview — `webview/src/`

| Path                  | Owns                                                                | Lines    |
| --------------------- | ------------------------------------------------------------------- | -------- |
| `features/chat/`      | **75 files** — chat surface, composer, diffs, meters, pickers       | ~14k     |
| `features/plan/`      | **30 files** — plan review, inline comments, revisions              | ~4k      |
| `theme.css`           | what cannot be a module — resets, aurora, markdown, hljs            | 959      |
| `lib/rpc.ts`          | the protocol, both directions                                       | 828      |
| `App.tsx`             | the chat shell — routing, boot handshake, global state              | 495      |
| `design/motion.ts`    | **22 exported presets** — every duration, curve, spring             | 363      |
| `design/icons.tsx`    | **84 registry entries** over 45 Solar Linear imports                | 238      |
| `design/primitives/`  | Chip, DotGlobe, Dropdown, IconButton, Kbd, Orb, RichEditor, Tooltip | 18 files |
| `themes/`             | **7 palettes** + `_base.scss` 212 + `_motion.scss` 61               | 491      |
| `lib/harness-host.ts` | the fake host `/browser` boots against, typed against `Inbound`     | 127      |
| `ArtifactApp.tsx`     | the second surface — same bundle, `window.LUNO_MODE`                | 112      |
| `main.tsx`            | entry — picks chat or artifact shell                                | 50       |

**One bundle, two surfaces.** `main.tsx` reads `window.LUNO_MODE` to mount either
`App` (chat sidebar) or `ArtifactApp` (a plan revision in an editor tab). The
host re-posts every event to both, so a mutation made in one appears in the
other. Anything added to the chat shell needs a thought about the artifact one.

Palettes: `blue` `copper` `green` `pink` `purple` `red` `white`. Icons are Solar
Linear imported per-icon per-style — the barrel measured ~9.6 kB/icon against
~1.1 kB, an 8.5× difference, and the comment in `icons.tsx` says so.

## The protocol

70 outbound types (webview → host), 45 inbound (host → webview).

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

Plan is the heaviest outbound area and carries no inbound of its own — plan state
reaches the webview folded into `timeline`, which is why `fold-plan-state` is
tested on both sides.

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

| File                               | Lines | Judgement                                                                                                                                              |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providers/claude-cli.ts`          | 2675  | **Doubled since the last map** and now the largest file in the repo. One process lifecycle and one parser — still coherent, no longer obviously so     |
| `ui/conversation-host.ts`          | 2592  | Grew 900 lines _despite_ `ui/domains/` extracting 17 files. The extraction worked; the growth outran it. Next seam is the turn loop, not more handlers |
| `services/mcp/index.ts`            | 1122  | Several transports in one module; a natural seam per transport                                                                                         |
| `features/chat/ChatScreen.tsx`     | 1218  | Owns too much state for one component                                                                                                                  |
| `features/chat/TokenMeter.tsx`     | 1169  | A meter, a popover, a plan picker and an editor in one file                                                                                            |
| `webview/src/theme.css`            | 959   | Up from ~600. Genuinely un-modularisable in parts, but worth re-checking which parts                                                                   |
| `features/mcp/ConnectorsModal.tsx` | 945   | Modal plus every connector flow                                                                                                                        |
| `design/primitives/RichEditor.tsx` | 919   | contenteditable serialisation — inherently dense, not accidental                                                                                       |
| `lib/rpc.ts`                       | 828   | A type file. Long is fine; it is the protocol                                                                                                          |

Four SCSS modules also sit at 700–740 (`ConnectorsModal`, `SkillsMarketplace`,
`FileDiffModal`, and `Composer.tsx` at 732). Everything else is under 700.

**Tests:** 57 files — 49 in `test/unit/`, 8 in `test/webview/`. The pass count
lives in `CLAUDE.md` and only there; this file would only drift it.
`conversation-worktree.test.ts` flakes under parallel load on Windows (`EPERM`
on temp cleanup in `afterEach`); it passes run alone.

**Lint:** 35 eslint warnings, all React Compiler rules from `react-hooks@7`
(`refs` 21, `set-state-in-effect` 7, `immutability` 3, memoisation 1). Real, held
at `warn` on purpose — see the comment in `eslint.config.mjs`.
