---
name: browser
description: Verify or measure the webview in a real browser. Use when the user says /browser, after any change to webview/src, or whenever a UI claim needs evidence — layout, spacing, colour, contrast, animation timing, or "does this actually render".
---

# Browser — drive the panel outside VS Code

The panel normally lives in a `vscode-webview://` frame no tool can attach to.
The bundle only depends on the host in two places — `acquireVsCodeApi()` and
`window.LUNO_MODE` — so stubbing those boots the entire UI on localhost, where
Playwright can screenshot it and read computed styles.

**"Should work" is not a result.** If you changed something the browser renders,
run this before reporting done.

## Start it

```bash
bun run harness                  # build, serve, print the URL
bun run harness --no-build       # reuse webview/dist as-is
bun run harness --mode artifact  # the plan-artifact shell instead of chat
bun run harness --port 4599
```

Serves `http://127.0.0.1:4599/`. Leave it running; rebuild and reload rather
than restarting.

## The seam: `window.__luno`

The stub is a **fake host**, not a silent shim. It answers the same boot
handshake the extension host does, so the app reaches its chat state on its own
rather than racing a timer.

| Call                      | Does                                                   |
| ------------------------- | ------------------------------------------------------ |
| `__luno.sent`             | every message the webview posted to the host, in order |
| `__luno.sentOf("prompt")` | just those of one type — the usual assertion           |
| `__luno.send(msg)`        | push a host → webview message                          |
| `__luno.clear()`          | reset the recording                                    |
| `__luno.replies`          | the fake host's reply table, editable at runtime       |
| `__luno.state`            | what the app has persisted through `setState`          |
| `__luno.resetState()`     | drop it, then reload for a genuinely fresh chat        |

Add a reply when a flow needs one the table does not cover:

```js
window.__luno.replies.requestSkills = { type: "skills", skills: [...] };
```

The table the page starts with lives in `webview/src/lib/harness-host.ts`,
typed against `Inbound` — a reply that no longer matches the protocol fails
`bun run lint` instead of blanking the page at runtime. Make a lasting addition
there; the runtime override above is for one-off states.

**State survives a reload**, in sessionStorage, the way a real webview's does.
That is what makes "the chat comes back" verifiable in here — persist, reload,
read `__luno.state`. It dies with the tab, so a fresh tab is a fresh install.

## What to actually do

**Prove it renders.** Navigate, screenshot, look. A dangling `s.someName`
compiles clean and renders unstyled — the screenshot is the only thing that
catches it.

**Measure, do not eyeball.** Read the numbers out of the page:

```js
const cs = getComputedStyle(document.documentElement);
cs.getPropertyValue("--motion-enter"); // "180ms" — as declared, not normalised
cs.getPropertyValue("--accent"); // "#d37350" on copper, the default
```

**Drive a state you cannot reach by hand.** Inject a timeline, a permission
request, a plan revision — anything the host would normally send:

```js
window.__luno.send({
  type: "timeline",
  event: { id: "1", ts: Date.now(), kind: "assistant", title: "x", body: "y" }
});
```

**Sample an animation over time** rather than trusting the duration in the CSS.
Read the property every frame across the transition and report what you saw —
opacity at the quarter mark is what caught the exits running on the wrong curve.

**Check both themes** when the change touches colour. Palettes swap through
`data-theme` on `<html>`; there are seven.

## What this cannot tell you

No extension host runs. Anything whose behaviour lives on the other side of
`postMessage` — the CLI spawn, permission decisions, MCP, checkpoints, file IO —
is stubbed to whatever `__luno.replies` says. Those need unit tests or the real
Extension Development Host (`F5`), not this.

## Clean up

Screenshots land in the repo root and `.playwright-mcp/`. Delete them before
committing — neither belongs in git.
