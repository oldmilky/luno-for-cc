# Frontend Task Playbook

The user is changing UI code (React/Vue/Svelte components, pages, hooks,
styles). Apply this playbook in addition to the mode prompt.

## Mandatory exploration

1. **Read the design tokens / theme file.** Confirm what color, spacing,
   typography primitives exist. Cite the file. Don't reinvent.
2. **Read 2–3 sibling components** for naming, prop shape, file structure,
   and styling convention (CSS modules, Tailwind, styled-components,
   plain CSS — match what's there). Cite at least one as the canonical
   example to mirror.
3. **Read the state-management entry** (store / context / signal / atom)
   if state is touched. Mirror the pattern.
4. **Identify reusable primitives.** Button, Modal, Input, Form, Toast —
   find what already exists. Do not reinvent a Button if one exists.
5. **Check accessibility helpers** (focus management, ARIA hooks, screen
   reader announcements). Cite what's available.
6. **Read the test file pattern** for components in this layer. New
   components without tests are incomplete.

## Required Risks coverage

Frontend Risks must explicitly address each:

- **Re-render performance** — uncontrolled re-renders, missing
  memoization, expensive children, unstable refs/callbacks. For lists:
  stable keys, virtualization for >100 items.
- **Bundle size** — any new dependency adds to the JS payload. Note
  size (gzipped) and whether it can be code-split / lazy-loaded.
- **Breaking shared components** — if you modify a primitive (Button,
  Modal), grep every consumer. List affected files.
- **Accessibility** — keyboard nav, focus order, ARIA labels, color
  contrast (4.5:1 minimum), screen reader experience. Each new
  interactive element must be reachable by keyboard.
- **Responsive behavior** — narrow (mobile), medium (tablet), wide
  (desktop). State which breakpoints you tested.
- **SSR / hydration** — if the project SSRs, confirm new components
  hydrate cleanly (no `useLayoutEffect` warnings, no client-only refs
  on server, stable IDs).
- **Loading / empty / error / success states** — every async surface
  needs all four. Confirm they exist.
- **Focus management** — opening a modal / drawer should trap focus;
  closing should restore it. State the strategy.
- **i18n / RTL** — if the project supports translation, all new strings
  must use the t() helper. RTL: check no hardcoded `left`/`right`.

## Required Verification coverage

- **Test command** — exact path of the new component's tests
- **Storybook / preview** — if used, link the story name
- **Dev server start** — exact command
- **URL / route** to visit
- **What to click / interact with** — step-by-step
- **Expected visual state** — for both light and dark theme if both
  are supported
- **Responsive check** — narrow-width verification
- **Keyboard-only check** — Tab-through, Enter/Space activation
- **Screen reader spot check** — if accessibility-critical

## Anti-patterns to flag

- Inline styles when the codebase uses tokens / classes
- New `className`s instead of using design-system primitives
- Bypassing the existing form library to roll a custom input
- `dangerouslySetInnerHTML` without explicit sanitization
- `useEffect` for derived state (use `useMemo` or compute inline)
- Missing keyboard handler on a `<div onClick>` (use `<button>`)
- Hardcoded English strings when i18n is in place
- New component without a test
- Importing from deep relative paths (`../../../components/X`) when
  the project uses path aliases
- Adding a new dependency for a 5-line utility
