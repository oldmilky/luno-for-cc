# LUNO for CC — Token contract

_The contract every theme must satisfy._

A theme is **only** a set of CSS custom properties. Components read tokens and
nothing else — no hard-coded colors, no Tailwind color literals, no inline
styles carrying a hex. Adding a palette must never require touching a component.

## Where things live

```
webview/src/themes/
  _base.scss     non-color tokens · derived tokens · default semantics · palette morph
  copper.scss    the default palette (also fills :root, so tokens exist without data-theme)
  purple.scss
  orange.scss
  index.scss     @use order: base first, palettes after
webview/src/lib/theme.ts    the store: read / apply / persist, THEMES registry
```

Cascade rule: `_base.scss` writes to `:root`, palettes to `[data-theme="…"]` —
equal specificity, so **file order decides**. Base is `@use`d first, therefore a
palette may override any derived token simply by declaring it.

`--round*` is named that, not `--radius*`, because Tailwind v4 owned the
`--radius-*` namespace while it was still in the build. Tailwind is gone now; the
name stays because every module already uses it.

## Core tokens — a theme MUST declare all 15

| Token | Role |
|---|---|
| `--s0` | page background — the deepest surface |
| `--s1` | panel / header / composer surface |
| `--s2` | raised card surface |
| `--s3` | hover / active surface, inline chips |
| `--t1` | primary text |
| `--t2` | body text |
| `--t3` | muted text, icon default |
| `--t4` | faintest text, disabled |
| `--accent` | the palette's signature color |
| `--accent-deep` | pressed / darker accent, gradient end |
| `--accent-glow` | lighter accent for halos and highlights |
| `--on-accent` | glyph/label color on an accent fill (contrast against `--accent`) |
| `--lift` | the color surfaces are lifted with — white on dark palettes; every border and tint derives from it |
| `--brand-tile-gradient` | the brand mark tile, in the palette's hues |

## Derived tokens — provided by `_base.scss`, overridable

Computed from the core with `color-mix()`, so one formula serves every palette.

| Group | Tokens | Derived from |
|---|---|---|
| Borders | `--b1` `--b2` `--b3` | `--lift` @ 5.5% / 8.5% / 13% |
| Elevation tints | `--tint-weak` `--tint` `--tint-strong` | `--lift` @ 2% / 4% / 6% |
| Scrollbar | `--scrollbar-thumb` `--scrollbar-thumb-hover` | `--lift` @ 8% / 18% |
| Accent tints | `--accent-soft` `--accent-mid` `--accent-shadow` | `--accent` @ 12% / 22% / 38% |
| Accent alias | `--ink` | `--on-accent` |
| Status ink | `--on-status` | `--s0` — ink for text on an `--ok`/`--err` fill; `--on-accent` is near-white and fails there |
| Sheen | `--sheen` `--sheen-strong` | `--lift` @ 12% / 18% — inner highlight on filled controls |
| Shadows | `--shadow-color` `--shadow-1` `--shadow-2` | cast shadows; `--shadow-color` is the raw color for one-off geometries |
| Glass | `--glass` `--glass-border` | `--s1` @ 90%, `--lift` @ 7% |
| Ambient aurora | `--aurora-1` `--aurora-2` `--aurora-top` | `--accent` @ 18%/10%, `--accent-glow` @ 12% |
| Diff | `--add-line` `--del-line` `--add-bg` `--del-bg` | `--ok` / `--err` |

## Semantics — shared defaults, overridable per theme

`--ok` `--warn` `--err` `--info` and their `-soft` tints. Green means ok in
every palette on purpose; a theme may still override them.

## Non-color tokens — shared, never per-theme

| Token | Value |
|---|---|
| `--round-sm` `--round` `--round-lg` | 8px · 10px · 14px |
| `--font-sans` `--font-mono` | Geist · Geist Mono |
| `--motion-fast` `--motion` `--motion-slow` | 120ms · 200ms · 360ms |
| `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `--theme-transition` | 420ms — the palette morph |

## Switching

`lib/theme.ts` stamps `data-theme` on `<html>` (not the app shell — html/body
paint `--s0` themselves) and persists the choice into the webview state via
`patchState`. `patchState` is the only state writer: `setState` replaces the
whole object, so the timeline and the theme would otherwise clobber each other.

During a swap the store adds `.theme-switching` to `<html>` for the length of
`--theme-transition`; `_base.scss` enables color transitions only under that
class, so the palette morphs while hovers and streaming repaints stay instant.
`prefers-reduced-motion` disables the morph.

## Adding a theme

1. `webview/src/themes/<name>.scss` — the 15 core tokens under `[data-theme="<name>"]`.
2. `@use "<name>";` in `themes/index.scss`.
3. One entry in `THEMES` in `lib/theme.ts` (id, label, note).

Nothing else. The picker builds itself from `THEMES`, and its swatch previews the
palette by carrying that palette's own `data-theme` — palette colors are never
duplicated in TypeScript.

## Writing a module

- One `<Component>.module.scss` beside the component. camelCase class names.
- **Declare your own `@keyframes`.** CSS Modules scope animation names, so
  `animation: someGlobalName` referencing a keyframe from `theme.css` is a dead
  reference that the build accepts silently. `:global(name)` inside an
  `animation` value does not work either — a local copy is the only fix.
- Shared surfaces are imported, not re-created: `Dropdown.module.scss` for
  popovers, `ToolCard.module.scss` for the ring spinner,
  `RichEditor.module.scss` for code/mention pills.
- Small radii (3–5px chips, 12/16px panels) stay literal: the scale only offers
  8/10/14px and snapping would visibly change those shapes.
- Full-screen overlays must carry `role="dialog"` — `theme.css` uses it to
  exclude them from the chrome-lifting rule. It is an accessibility attribute
  first, which is exactly why it is safe to key layout off it.

## What is left in `theme.css`

~600 lines that genuinely cannot be modules: document resets, scrollbars,
reduced-motion, the ambient aurora, markdown + highlight.js presentation
(react-markdown and hljs emit their own DOM), and two classes applied
imperatively (`.artifact-shell`, `.plan-line-commented`).

## Known gaps

- **Light variants.** The old auto-light override (keyed off `body.vscode-light`)
  was removed; every palette is dark-only for now. `--lift` is the hook:
  a light variant flips it to black and re-declares surfaces and text. Because the
  derived tokens all key off `--lift`, flipping it moves borders, tints, glass and
  shadows at once — which is the point, and also why it needs its own contrast pass.
- **Inline styles.** A handful of `style={{…}}` remain, all carrying genuinely
  dynamic values (computed widths, per-language badge colors). No colors that
  should be tokens.
