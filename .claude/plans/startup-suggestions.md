# The empty state offers what you actually have

**Status:** built and verified 2026-07-31, uncommitted.

## What changed

The hero on an empty chat used to hold four hardcoded English prompts under two
hardcoded group headings. It now reads the same slash-command list the composer
reads, and offers the skills that exist on this machine — this project's under
**Project**, `~/.claude`'s under **Personal**.

`luno.startupSuggestions` overrides the choice for anyone who wants a fixed set.

## Why it is data-driven rather than a better hardcoded list

LUNO ships to other people. A card reading `/ship` on a machine with no such
skill is a button that does nothing, and every hardcoded list is that button for
somebody. Reading the live list serves the author's own setup and everyone
else's with the same code, and a new skill on disk appears without a TSX edit.

The data was already crossing the seam and going unused: `slashCommands` carries
`{name, description, source}` with the project's own first, and `Composer.tsx`
had been the only consumer.

## The pieces

| Where                                              | Owns                                           |
| -------------------------------------------------- | ---------------------------------------------- |
| `webview/src/features/chat/startup-suggestions.ts` | the whole decision, React-free and unit-tested |
| `webview/src/features/chat/EmptyState.tsx`         | rendering it, one `bolt` per card              |
| `luno.startupSuggestions` in `package.json`        | the override                                   |
| `ChatScreen` `pendingPrefill` → `Composer`         | what a click does                              |

`resolveStartupCards(configured, commands)` in priority order:

1. `configured` non-empty → exactly those, in that order. `/name` resolves
   against the live list for its description; anything else is a literal prompt.
2. otherwise the live list minus `source: "cli"`, capped at 6.
3. otherwise four generic prompts, rendered **without** a badge.

Three decisions inside it that are not obvious:

- **`cli` entries are dropped.** They carry no description, and with plugins
  installed the CLI reports well over a hundred names.
- **A configured name nothing answers to is still shown**, without a sub-line.
  Silently eating what someone typed into their own settings is worse than a
  bare card.
- **The fallback carries no badge.** Those four are LUNO's, and filing them
  under "Personal" would claim the user chose them.

## A click fills the composer and stops

Nothing is sent. `/ship` or `/brainstorming` fired with no argument would burn a
turn on an empty task, and one rule for every card beats a per-card exception.

It is **not** `pendingRestore`. That path appends below what is typed
(`Composer.tsx`), and the CLI expands `/name` only at the start of a message —
appending would file a dead command. `pendingPrefill` puts the card in front, so
typing "fix the header bug" and then clicking `/check` gives
`/check fix the header bug`. Commands carry a trailing space; the prefill
re-joins with one when the composer already holds text.

The state lives in `ChatScreen`, not `App`: both the hero that raises it and the
composer that consumes it are on that screen, so no new protocol message exists.

## Measured in the harness, not assumed

At a 320px panel — the narrow sidebar, not the browser window — a skill
description ran to **four lines and a 109px card beside a 57px one**. Hence
`-webkit-line-clamp: 2` on `.suggestionSub`: `shorten()` cuts the _sentence_,
only the box knows the panel's _width_. After it, every card with a sub-line is
76px.

Also verified live: the `cli` entry absent from the render, `/nosuch` shown
without a sub, `sentOf("prompt").length === 0` after a click, the caret at the
end of `/ship `, and `/check fix the header bug` from the prepend path.

`harness-host.ts` gained a `requestSlashCommands` reply covering all three
sources — the harness had no answer for it at all, so the hero would have shown
the fallback there forever.

## Left undone

The configured branch was exercised in the harness by pushing a `settings`
message by hand; the harness answers requests and never pushes, so there is no
standing fixture for it. Its logic is covered by
`test/webview/startup-suggestions.test.ts` instead.
