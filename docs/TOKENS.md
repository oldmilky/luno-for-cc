# LUNO for CC — Token contract

_The contract every theme must satisfy. Source of truth is
`webview/src/themes/_base.scss`; this file explains it._

A theme is **only** a set of CSS custom properties. Components read tokens and
nothing else — no hard-coded colors, no color literals, no inline styles
carrying a hex. Adding a palette must never require touching a component.

## Where things live

```
webview/src/themes/
  _base.scss     non-color tokens · derived tokens · default semantics · palette morph
  _motion.scss   shared @keyframes, as mixins — CSS Modules scope animation names
  copper.scss    the default palette (also fills :root, so tokens exist without data-theme)
  blue.scss  green.scss  pink.scss  purple.scss  red.scss  white.scss
  index.scss     @use order: base first, palettes after
webview/src/lib/theme.ts    the store: read / apply / persist, THEMES registry
```

Seven palettes. `copper` doubles as the fallback: its `:root` selector keeps
every token defined even when nothing has stamped `data-theme` yet — the
artifact editor tab before the store mounts is the real case.

Cascade rule: `_base.scss` writes to `:root`, palettes to `[data-theme="…"]` —
equal specificity, so **file order decides**. Base is `@use`d first, therefore a
palette may override any derived token simply by declaring it.

`--round*` is named that, not `--radius*`, because Tailwind v4 owned the
`--radius-*` namespace while it was still in the build. Tailwind is gone now
(no trace in either `package.json`); the name stays because every module already
uses it.

## Core tokens — a theme MUST declare all 14

Verified against `copper.scss`, which declares exactly these and nothing else.

| Token                   | Role                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `--s0`                  | page background — the deepest surface                                                              |
| `--s1`                  | panel / header / composer surface                                                                  |
| `--s2`                  | raised card surface                                                                                |
| `--s3`                  | hover / active surface, inline chips                                                               |
| `--t1`                  | primary text                                                                                       |
| `--t2`                  | body text                                                                                          |
| `--t3`                  | muted text, icon default                                                                           |
| `--t4`                  | faintest text, disabled                                                                            |
| `--accent`              | the palette's signature color                                                                      |
| `--accent-deep`         | pressed / darker accent, gradient end                                                              |
| `--accent-glow`         | lighter accent for halos and highlights                                                            |
| `--on-accent`           | glyph/label color on an accent fill (contrast against `--accent`)                                  |
| `--lift`                | the color surfaces are lifted with — white on dark palettes; every border and tint derives from it |
| `--brand-tile-gradient` | the brand mark tile, in the palette's hues                                                         |

## Derived tokens — provided by `_base.scss`, overridable

Computed from the core with `color-mix()`, so one formula serves every palette.
A custom property resolves against the element it lands on, so `var(--accent)`
inside a `:root` declaration picks up whatever the active `[data-theme]` set.

| Group           | Tokens                                           | Derived from                                                                                                                                               |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Borders         | `--b1` `--b2` `--b3`                             | `--lift` @ 5.5% / 8.5% / 13%                                                                                                                               |
| Elevation tints | `--tint-weak` `--tint` `--tint-strong`           | `--lift` @ 2% / 4% / 6%                                                                                                                                    |
| Scrollbar       | `--scrollbar-thumb` `--scrollbar-thumb-hover`    | `--lift` @ 12% / 24% — the thumb is 4px wide; thinner than that needs the contrast to be findable, and it stays under `--b3` so it never reads as a border |
| Accent tints    | `--accent-soft` `--accent-mid` `--accent-shadow` | `--accent` @ 12% / 22% / 38%                                                                                                                               |
| Accent alias    | `--ink`                                          | `--on-accent` — legacy name, same role                                                                                                                     |
| Status ink      | `--on-status`                                    | `--s0` — ink for text on an `--ok`/`--err` fill; `--on-accent` is near-white and fails there                                                               |
| Sheen           | `--sheen` `--sheen-strong`                       | `--lift` @ 12% / 18% — inner highlight on filled controls                                                                                                  |
| Shadows         | `--shadow-color` `--shadow-1` `--shadow-2`       | `#000`; the two are whole `box-shadow` values, not just colors, so elevation is not re-invented per component                                              |
| Glass           | `--glass` `--glass-border`                       | `--s1` @ 90%, `--lift` @ 7%                                                                                                                                |
| Ambient aurora  | `--aurora-1` `--aurora-2` `--aurora-top`         | `--accent` @ 18%, `--accent-glow` @ 12%, `--accent` @ 10%                                                                                                  |
| Syntax          | `--syn-*` — 11 tokens                            | see below                                                                                                                                                  |
| Diff            | `--add-line` `--del-line` `--add-bg` `--del-bg`  | `--ok` / `--err`, the backgrounds at 8%                                                                                                                    |

### Syntax highlighting — `--syn-*`

highlight.js emits its own class names, so these are consumed by the global
layer in `theme.css`, not by a module. Roles map onto tokens that are already
semantically distinct, which keeps code readable in every palette while still
following it.

| Token                          | Derived from                               |
| ------------------------------ | ------------------------------------------ |
| `--syn-keyword`                | `--accent-glow` — keywords ride the accent |
| `--syn-string`                 | `--ok`                                     |
| `--syn-number`                 | `--warn`                                   |
| `--syn-title`                  | `--info` — function names                  |
| `--syn-variable`               | `--t1`                                     |
| `--syn-comment` · `--syn-meta` | `--t3`                                     |
| `--syn-deletion`               | `--err`                                    |
| `--syn-type`                   | `--warn` 65% + `--t1`                      |
| `--syn-regexp`                 | `--info` 55% + `--ok`                      |
| `--syn-doctag`                 | `--info` 55% + `--accent-glow`             |

## Semantics — shared defaults, overridable per theme

`--ok` `#4ade80` · `--warn` `#fbbf24` · `--err` `#f87171` · `--info` `#60a5fa`,
plus `--ok-soft` `--err-soft` `--info-soft` at 12% and `--warn-soft` at 13%.
Green means ok in every palette on purpose; a theme may still override them.

### The plan surface — `--plan-accent*`

`--plan-accent` `--plan-accent-soft` `--plan-accent-hover` `--plan-accent-active`,
declared in `theme.css` and derived from `--ok` at 8% / 16% / 28%.

Its own family rather than `--ok` used directly, because the plan surface leans
on one hue across a whole panel — stripe, row tint, hover, pressed — and four
call sites reaching for `color-mix(--ok …)` by hand is how those four drift
apart. A theme that wants a different plan hue overrides the four here and
nothing else moves.

## Non-color tokens — shared, never per-theme

### Shape and type

| Token                               | Value             |
| ----------------------------------- | ----------------- |
| `--round-sm` `--round` `--round-lg` | 8px · 10px · 14px |
| `--font-sans`                       | Geist             |
| `--font-mono`                       | Geist Mono        |

### Motion — durations are named by ROLE, not by speed

"How fast should this be?" has no good answer; "what is this element doing?"
has exactly one. **Nothing here exceeds 220ms**: past that, movement in a coding
tool stops reading as polish and starts reading as latency.

| Token              | Value | For                                         |
| ------------------ | ----- | ------------------------------------------- |
| `--motion-tap`     | 90ms  | press feedback — must feel immediate        |
| `--motion-hover`   | 120ms | hover, color shifts, focus rings            |
| `--motion-enter`   | 180ms | an element appears                          |
| `--motion-overlay` | 200ms | modal, popover, drawer                      |
| `--motion-expand`  | 220ms | open / collapse                             |
| `--theme-morph`    | 280ms | palette swap — the one deliberate exception |

### Curves — two, not three

| Token         | Value                            | For                                                                         |
| ------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `--ease-out`  | `cubic-bezier(0.16, 1, 0.3, 1)`  | **Arrivals only.** An expo-out: ~90% of the change lands in the first third |
| `--ease-soft` | `cubic-bezier(0.65, 0, 0.35, 1)` | **Every exit**, and anything that plays in reverse (expand/collapse)        |

Using `--ease-out` on an exit is the trap `CLAUDE.md` names: a dismissed panel
sits at 47% opacity a quarter of the way out and is invisible by halfway, so the
rest of the duration animates something nobody can see. On `--ease-soft` it is
still at 88% at the quarter mark.

### Travel — amplitude carries as much of the feel as duration

| Token         | Value | For                                                            |
| ------------- | ----- | -------------------------------------------------------------- |
| `--travel-sm` | 4px   | inline bits, pills, chips                                      |
| `--travel-md` | 8px   | cards, rows, banners                                           |
| `--travel-lg` | 12px  | overlays                                                       |
| `--travel-xl` | 28px  | edge-anchored panels — a drawer needs a direction, not a nudge |

### Ambient loops

The role names above all describe something that starts and ends. These run for
as long as a condition holds, and share one period so the streaming avatar, the
halo, the caret and the live dot breathe on a single beat.

| Token              | Value | For                                                                                                                                                            |
| ------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--motion-ambient` | 1.8s  | the model is talking, a tool is working                                                                                                                        |
| `--motion-halo`    | 3.6s  | decorative glow — half the ambient rate, or it reads as a progress bar                                                                                         |
| `--motion-flash`   | 1.4s  | one-shot attention flash. **Coupled to `FLASH_MS` in `PlanFullView.tsx`**, which strips the class — disagree and the flash is cut off before its last keyframe |
| `--motion-spin`    | 0.8s  | one revolution of a loading ring; always paired with `linear`                                                                                                  |

### The framer half

`webview/src/design/motion.ts` carries the same numbers for framer-motion —
`DURATION` mirrors the `--motion-*` tokens, `TRAVEL` the `--travel-*` ones,
`EASE_OUT` / `EASE_SOFT` the two curves. **Same numbers, two consumers, and
nothing enforces the match.** Changing a duration means changing both files; a
change to one alone compiles clean and desynchronises CSS transitions from
framer animations.

## Switching

`lib/theme.ts` stamps `data-theme` on `<html>` (not the app shell — html/body
paint `--s0` themselves) and persists the choice into the webview state via
`patchState`. `patchState` is the only state writer: `setState` replaces the
whole object, so the timeline and the theme would otherwise clobber each other.

During a swap the store adds `.theme-switching` to `<html>` for the length of
`--theme-morph`; `_base.scss` enables color transitions only under that class,
so the palette morphs while hovers and streaming repaints stay instant.

The morph transitions **three properties** — `background-color`, `border-color`,
`color` — on `*` and both pseudo-elements. It used to be seven properties, which
meant thousands of transitions per click, most on elements whose color never
changes. `text-shadow` / `fill` / `stroke` are deliberately out: glyphs inherit
`currentColor` and come along with `color` for free. `will-change` is absent on
purpose — it would promote every element to its own layer for the duration.
`prefers-reduced-motion` disables the morph.

## Adding a theme

1. `webview/src/themes/<name>.scss` — the 14 core tokens under `[data-theme="<name>"]`.
2. `@use "<name>";` in `themes/index.scss`.
3. One entry in `THEMES` in `lib/theme.ts` (id, label, note).

Nothing else. The picker builds itself from `THEMES`, and its swatch previews the
palette by carrying that palette's own `data-theme` — palette colors are never
duplicated in TypeScript.

## Writing a module

- One `<Component>.module.scss` beside the component. camelCase class names.
- **Declare your own `@keyframes`, or use a mixin from `_motion.scss`.** CSS
  Modules scope animation names, so `animation: someGlobalName` referencing a
  keyframe from `theme.css` is a dead reference the build accepts silently.
  `:global(name)` inside an `animation` value does not work either.
- Shared surfaces are imported, not re-created: `Dropdown.module.scss` for
  popovers, `ToolCard.module.scss` for the ring spinner,
  `RichEditor.module.scss` for code/mention pills.
- Small radii (3–5px chips, 12/16px panels) stay literal: the scale only offers
  8/10/14px and snapping would visibly change those shapes.
- Full-screen overlays must carry `role="dialog"` — `theme.css` uses it to
  exclude them from the chrome-lifting rule. It is an accessibility attribute
  first, which is exactly why it is safe to key layout off it.

## What is left in `theme.css`

959 lines that genuinely cannot be modules: document resets, scrollbars,
reduced-motion, the ambient aurora, markdown + highlight.js presentation
(react-markdown and hljs emit their own DOM), and two classes applied
imperatively (`.artifact-shell`, `.plan-line-commented`).

It has grown by roughly half since it was last measured at ~600 lines. Worth a
pass to check which of that is still genuinely un-modularisable.

## Known gaps

- **Light variants.** The old auto-light override (keyed off `body.vscode-light`)
  was removed; every palette is dark-only for now — `white` is a light-_accent_
  palette on dark surfaces, not a light theme. `--lift` is the hook: a light
  variant flips it to black and re-declares surfaces and text. Because the
  derived tokens all key off `--lift`, flipping it moves borders, tints, glass
  and shadows at once — which is the point, and also why it needs its own
  contrast pass.
- **Inline styles.** A handful of `style={{…}}` remain, all carrying genuinely
  dynamic values (computed widths, per-language badge colors). No colors that
  should be tokens.
- **`motion.ts` duplicates the motion tokens by hand.** See "The framer half".
