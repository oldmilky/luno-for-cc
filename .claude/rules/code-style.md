---
paths:
  - "**/*.{ts,tsx,scss,css}"
---

# Naming and style

Formatting is prettier's job — never argue with it by hand. What follows is what
prettier cannot decide.

| What                                         | Convention                                               |
| -------------------------------------------- | -------------------------------------------------------- |
| Component files                              | PascalCase — `TokenMeter.tsx`, `PlanStepCard.tsx`        |
| Everything else in `src/`                    | kebab-case — `claude-code-usage.ts`, `plan-intercept.ts` |
| SCSS module beside its component             | `<Component>.module.scss`                                |
| Components                                   | PascalCase                                               |
| Functions / hooks                            | camelCase, hooks start `use`                             |
| Constants                                    | UPPER_SNAKE_CASE — `HARD_TIMEOUT_MS`, `GRID_RATIO`       |
| Types / interfaces                           | PascalCase, **no `I` prefix**                            |
| CSS-module classes                           | camelCase — read as `s.someName` in TSX                  |
| Global classes in `theme.css` / `_base.scss` | kebab-case — they are applied imperatively               |
| `@keyframes`                                 | kebab-case (16 of 18 already are)                        |
| CSS custom properties                        | `--kebab-case`                                           |
| Booleans                                     | `is*`, `has*`, `can*`, `should*`                         |

Functions: single responsibility, max 3 levels of nesting. A function that needs
a section comment to be readable is a function that needs splitting.

## TypeScript

- `any` needs a stated reason next to it. eslint warns rather than errors, which
  makes the reason mandatory in review instead of in CI.
- Prefer a discriminated union over an optional-field grab bag — the
  webview↔host protocol is one, and it is why exhaustiveness works there.
- Do not widen a type to make a test pass. Fixtures may lie; production types
  may not.

## The webview

- A component reads **tokens**, never literals. No hex, no px shadow, no raw
  duration. `docs/TOKENS.md` is the contract.
- Motion comes from `design/motion.ts` as a spread preset, never a hand-written
  transition. Adding a new one means adding it there first.
- Icons come from `design/icons.tsx`. If a glyph is missing, add the Solar
  import to the registry — do not inline an `<svg>` and do not reach for an
  emoji.
- Tooltips come from `design/primitives/Tooltip`, never the `title` attribute.

## Files that are shared resources

`webview/src/theme.css`, `webview/src/design/motion.ts` and
`webview/src/themes/_base.scss` are read by everything. Edit them deliberately
and never from two places at once — a parallel agent touching them is how the
last three rounds produced conflicts.

## SCSS

- Nest for state and modifiers (`&:hover`, `&.resolved`), not for structure.
  Deep nesting fights CSS Modules rather than helping it.
- `color-mix(in srgb, …)` over a second hard-coded shade.
- Never hand-write a vendor prefix next to an unprefixed property unless a
  comment says which engine needs it.
