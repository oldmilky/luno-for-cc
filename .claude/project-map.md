# Project map

_Generated 2026-07-27. Regenerate with `/analyze` after structural changes._
_Not auto-loaded — read it before working somewhere you have not been._

## Two halves

Two separately-compiled programs joined by one seam. `src/` is the **extension
host**: Node, VS Code APIs, spawns the user's `claude` CLI. `webview/src/` is a
standalone **React app** that never imports a VS Code API and cannot see the
filesystem. They talk only through `postMessage`, typed in
`webview/src/lib/rpc.ts` — **84 message shapes, 63 handled host-side**.

Nothing enforces that seam but review. A message added on one side and unhandled
on the other compiles clean and fails silently at runtime, which is why `/audit`
carries a contract lens.

## Extension host — `src/` · 35 files, 11.5k lines

| Path                          | Owns                                                                 | Lines        |
| ----------------------------- | -------------------------------------------------------------------- | ------------ |
| `ui/conversation-host.ts`     | one conversation: session, checkpoints, turn, all 63 handlers        | **1696**     |
| `ui/conversation-registry.ts` | every live conversation, the shared services, the sidebar swap       | 349          |
| `ui/panel.ts`                 | the `WebviewViewProvider` contract and the bound commands            | 104          |
| `providers/claude-cli.ts`     | spawn, stream-json parsing, the control protocol                     | 1290         |
| `providers/factory.ts`        | binary discovery — the single entry point                            | ~260         |
| `services/mcp/`               | connectors: OAuth, stdio, catalog, storage, CLI config               | 1122 (index) |
| `core/`                       | orchestrator, session, plan-intercept, task-classifier, types        | —            |
| `services/`                   | checkpoint, history, conventions, skills, marketplace, usage, memory | —            |
| `ui/webview-html.ts`          | the page for both surfaces, prod and dev-server branches             | ~160         |

**`src/core/*` imports zero VS Code APIs** — verified, not assumed. That is the
only part testable without a mock editor, and it is where logic belongs.

## Webview — `webview/src/` · 140 files, 31.2k lines

| Path                                                 | Owns                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `features/chat/`                                     | 35 components — the chat surface, composer, diffs, meters, pickers |
| `features/plan/`                                     | 12 components — plan review, inline comments, revisions            |
| `features/mcp/`, `features/auth/`, `features/theme/` | one modal / screen each                                            |
| `design/motion.ts`                                   | every duration, curve and spring preset                            |
| `design/icons.tsx`                                   | the whole icon registry (Solar Linear) + `BrandMark`               |
| `design/primitives/`                                 | Tooltip, Dropdown, Chip, IconButton, Kbd, Orb, RichEditor          |
| `themes/`                                            | seven palettes, `_base.scss`, `_motion.scss`                       |
| `theme.css`                                          | what genuinely cannot be a module — resets, aurora, markdown, hljs |
| `lib/rpc.ts`                                         | the protocol, both directions                                      |

## Where to change what

| To add…                   | Touch                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| a message across the seam | `lib/rpc.ts` union, `ui/messages.ts` `InboundType`, **and** a handler in `ui/conversation-host.ts` |
| a colour, radius, shadow  | a token in `themes/*` — never a component                                                          |
| a palette                 | one file in `themes/` — components are not touched                                                 |
| a duration or curve       | `design/motion.ts` — then spread the preset                                                        |
| an icon                   | one Solar import in `design/icons.tsx`                                                             |
| a tooltip                 | `design/primitives/Tooltip` — never `title=`                                                       |
| a settings key            | `package.json` `contributes.configuration` + the reader                                            |

## Shared resources — edit deliberately

`webview/src/theme.css`, `webview/src/design/motion.ts`,
`webview/src/themes/_base.scss`.

Everything reads them, so an edit is global by construction and two agents
touching them at once is how earlier parallel rounds produced conflicts. When
fanning work out, the orchestrator edits these first, alone, then the batches
run.

## Provenance

The extension host is inherited and largely unreviewed by us — it came working
and has been changed only where it was wrong (binary discovery, error paths).
The webview was rewritten across six phases and is ours. Treat a surprise in
`src/` as "probably always been like that" and a surprise in `webview/src/` as
"probably introduced recently".

## Size and debt

| File                               | Lines | Judgement                                                                                                                                                                              |
| ---------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/conversation-host.ts`          | 1696  | The old god-file after Ф7 split out the registry and the provider. Still large, and still the place protocol handling and turn logic meet — the handler table is the natural next seam |
| `providers/claude-cli.ts`          | 1290  | Big but coherent — one process lifecycle, one parser                                                                                                                                   |
| `services/mcp/index.ts`            | 1122  | Several transports in one module; a natural seam per transport                                                                                                                         |
| `features/chat/ChatScreen.tsx`     | 1037  | Owns too much state for one component                                                                                                                                                  |
| `features/chat/TokenMeter.tsx`     | 998   | A meter, a popover, a plan picker and an editor in one file                                                                                                                            |
| `features/mcp/ConnectorsModal.tsx` | 945   | Modal plus every connector flow                                                                                                                                                        |
| `design/primitives/RichEditor.tsx` | 881   | contenteditable serialisation — inherently dense, not accidental                                                                                                                       |

Everything else is under 700 lines.

Also open: 35 eslint warnings, all React Compiler rules from `react-hooks@7`
(`refs` 21, `set-state-in-effect` 7, `immutability` 3, memoisation 1). Real, held
at `warn` on purpose — see the comment in `eslint.config.mjs`.
