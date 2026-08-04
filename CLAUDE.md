# LUNO for CC

A Claude Code chat panel for Cursor and VS Code, running on the user's own
Claude subscription. Senior engineer on a shipped, published extension — not a
prototype.

## Language

- **Respond in Russian** unless explicitly asked otherwise.
- Code, comments, commit messages, docs — **English**.

## Commands

The toolchain is **bun**. npm is not used: the lockfiles are `bun.lock` /
`webview/bun.lock` and npm lockfiles are gitignored on purpose — if one
reappears, something ran `npm install` and the two will drift.

| Task                | Command                                                      |
| ------------------- | ------------------------------------------------------------ |
| All gates           | `bun run lint` (tsc ×2 → eslint → stylelint)                 |
| Types only          | `bun run lint:types`                                         |
| Tests               | `bun run test` — expect `1544 passed, 6 skipped`             |
| Build               | `bun run build` (esbuild → dist/, vite → webview/dist/)      |
| Package             | `bun run package` → `luno-for-cc-<ver>.vsix`, ~1.28 MB       |
| Format              | `bun run format` · check with `format:check`                 |
| Autofix everything  | `bun run fix`                                                |
| Browser harness     | `bun run harness` — the webview on localhost, see `/browser` |
| Webview dev server  | `bun run dev:webview` → http://localhost:5173                |
| Install both halves | `bun run install:all` · watch the host with `bun run watch`  |
| Vendored skills     | `bun run skills:verify` — fails if one was edited in place   |

`bun run test` is the number to beat, and it is the only place it is written
down. The gate is "this many or better"; anything less is a regression to
explain, not a floor to lower.

It runs **two projects** through `vitest.workspace.ts` and prints one summary:
the host half in `test/` under `node`, and a component half in `webview/test/`
under `jsdom`. The second is rooted in `webview/` on purpose — React lives only
in `webview/node_modules`, and a component rendered against a second copy of it
fails on the first `useState`. Rendering uses `react-dom/client` and React 19's
own `act` rather than a testing-library dependency; `webview/test/render.tsx` is
the whole of it.

## Architecture — three layers

```
Webview (webview/src/)   React 19 + SCSS modules + framer-motion
   │                     reads design tokens only
   │ postMessage — the stable contract between the two halves
Extension host (src/)    claude CLI spawn · permissions · MCP · skills
   │ spawn(binary, …) over stream-json
claude CLI               the user's own install; auth, models, tools
```

- `src/core/*` imports **zero** VS Code APIs and is unit-tested in isolation.
- The permission policy and CLI bridge live in `src/providers/`.
- The binary is _found_, never assumed: everything goes through
  `resolveClaudeBinary()` in `src/providers/factory.ts`. Reaching for
  `bundledClaudeBinary()` directly breaks a build that ships no CLI, which is
  exactly what this is.

## Tool triggers (MANDATORY)

Fire these without being asked. Each row is a trip-wire, not a suggestion.

| Situation                                                            | Action                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Changed anything the webview renders                                 | Verify in the browser harness (`/browser`) before reporting done. "Should work" is not a result                                  |
| Need a version-specific API — React 19, framer-motion, VS Code, Vite | context7 (`resolve-library-id` → `query-docs`). Never from memory: React 19 and framer's current API both moved recently         |
| Unfamiliar library or third-party integration                        | Exa first, code second                                                                                                           |
| About to make an architectural decision                              | Exa for how others solved it, then decide. Say what you found                                                                    |
| Same error survived 2 fix attempts                                   | Stop guessing — `systematic-debugging` or Exa. A third blind attempt is always waste                                             |
| Touched permissions, token storage, or process spawning              | Re-read `decidePermission` and the destructive/network gate. This extension holds a subscription credential and spawns processes |
| Measuring UI behaviour — duration, geometry, contrast, overshoot     | Sample it in the harness. Numbers, not adjectives                                                                                |
| Context filling up mid-task                                          | Say so and offer a handoff **before** quality drops, not after                                                                   |
| Second opinion on a risky change                                     | `cc-codex-triage`                                                                                                                |

## Definition of done

Never report work as complete without all four:

1. `bun run lint` at **exit 0**, with no new warnings — that is tsc over
   **both** projects, eslint, stylelint. It is not a clean screen: 35 eslint
   warnings are real, held at `warn` on purpose, and explained in
   `eslint.config.mjs`. The gate is the exit code plus the count not rising
2. `bun run test` at `1544 passed, 6 skipped` or better
3. Behaviour verified where it runs — the harness for UI, tests for host logic
4. Every claim tied to evidence actually seen: a command's output, a measured
   value, a screenshot

If something is unverified, name which part and why. Partial honesty beats a
confident false "готово".

## Critical rules

1. **NEVER** hard-code a colour, radius, shadow or duration in a component —
   read a token. See `docs/TOKENS.md`
2. **NEVER** write a raw duration in framer — spread a preset from
   `webview/src/design/motion.ts`
3. **NEVER** add an icon outside `webview/src/design/icons.tsx`
4. **NEVER** use the native `title` attribute — use `design/primitives/Tooltip`.
   The one deliberate exception is the per-line title in `FileDiffModal`, which
   carries a comment saying so
5. **NEVER** commit secrets, `.env`, or anything under `ghost.one/`
6. **NEVER** let `luno.permissionMode: auto` reach a committed settings file
7. **NEVER** add a comment that explains _what_ code does → `.claude/rules/comments.md`
8. **ALWAYS** run the gates before claiming done
9. **ALWAYS** treat `theme.css`, `design/motion.ts` and `themes/_base.scss` as
   shared resources — never edit them from parallel agents

## Traps this codebase has already paid for

Each of these was invisible to the compiler and cost a debugging round.

- **framer writes `opacity` inline**, and no class rule can outrank it.
  Converting an element to `motion.*` silently kills any
  `.someClass { opacity: … }` on it. Use `filter: opacity()` for state-based
  dimming on animated elements.
- **CSS Modules scope `@keyframes` names.** `animation: globalName` inside a
  module is a dead reference, and `:global(name)` inside an `animation`
  shorthand compiles to a silently dead one. Share via the mixins in
  `themes/_motion.scss` — in the _source_, not the output.
- **CSS cannot animate an exit.** Anything that must animate both ways needs
  framer + `AnimatePresence`; a CSS `animation` plays on mount and has nothing
  left to play when the node is simply gone.
- **Exits run on `--ease-soft`, never `--ease-out`.** The latter is an expo-out:
  ~90% of the change lands in the first third, so a dismissed panel is
  invisible halfway through its own duration.
- **A dangling `s.someName` renders unstyled and the build stays green.** A typo
  in a CSS-module class name is not a compile error.
- **`prefers-reduced-motion`**: framer honours it only on the `animate`-prop
  path. A value driven through `useSpring` bypasses it and needs an explicit
  `useReducedMotion()` check.
- **A disabled button dispatches no mouse events, and they do not reach its
  ancestors** — hit-testing stops there. That is why Tooltip has a gate span.
- **`window.open` and `<a target="_blank">` do not reach the browser** from a
  webview. Every outbound link goes `send({ type: "openExternal", url })` and the
  host calls `vscode.env.openExternal`. The failure is silent: the click lands,
  nothing happens.
- **Every field on the protocol is optional, so a half-plumbed one typechecks.**
  A value crosses five hops — card → `ChatScreen` → `App` → host → provider — and
  adding it to four of them compiles clean and drops the value on the floor. When
  adding a field, grep the name and count the hops.
- **A native radio or checkbox cannot be made to match the design system.**
  `accent-color` tints the control but the platform still draws a _square_ focus
  ring around a round radio. Hide the input (visually, never `display: none` —
  it carries the semantics and the tab order) and draw a sibling.

## Where the rest lives

| Topic                                   | File                            |
| --------------------------------------- | ------------------------------- |
| Token contract every theme must satisfy | `docs/TOKENS.md`                |
| Comment policy in full                  | `.claude/rules/comments.md`     |
| Naming and code style                   | `.claude/rules/code-style.md`   |
| What lives where, sizes, seams          | `.claude/project-map.md`        |
| Why a decision went that way            | `docs/PLAN.md` _(local only)_   |
| Design rationale                        | `docs/DESIGN.md` _(local only)_ |
| Audits — measured findings, with proof  | `.claude/audits/`               |

`docs/PLAN.md` and `docs/DESIGN.md` are gitignored — working notes, not part of
the published repo. Read them for context; do not assume a reader of the
repository has them.

## Development environment

- OS: Windows. Shell: PowerShell primary, Git Bash available.
- Paths: forward slashes work in both. Line endings: CRLF in the working tree,
  LF in git (`core.autocrlf`).
- `ghost.one/` is a full copy of an unrelated project kept in-tree as a
  reference. It is gitignored **and** `.vscodeignore`d. Never commit it, never
  let `vsce` walk it.
