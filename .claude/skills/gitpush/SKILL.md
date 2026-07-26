---
name: gitpush
description: Run the gates, write the commit message, commit and push. Use when the user says /gitpush or asks to commit and push. Requires explicit approval before the commit and never pushes past a failing gate.
user-invocable: true
argument-hint: "[branch] [commit only] [extra context]"
---

You are running the commit/push flow. Optional input: `$ARGUMENTS`.

Parse it (all optional, any combination):

- **A branch name** → the push target. If it differs from the current branch,
  ask before switching or pushing there. Never auto-switch.
- **"commit only" / "no push" / "без пуша"** → run Phases 0–3 and stop after the
  commit.
- **Anything else** → extra context woven into the commit message. It does not
  replace the generated one.

Default: commit + push to the current branch.

## Phase 0 — The gates. Not optional, not after the fact

Run all three and read the output:

```bash
bun run lint          # tsc over BOTH projects, then eslint, then stylelint
bun run test          # expect 357 passed, 6 skipped or better
bun run format:check
```

**A failing gate stops this skill.** Do not commit, do not offer to commit
anyway, do not describe the failure as pre-existing without checking `git
stash` first. Report which gate failed and what it said, then fix it or hand
back.

This phase exists because the alternative has already happened: a commit whose
message claimed verification while `lint` and `format:check` were both red. The
gates run _before_ the message is written, not after.

If the change touches `webview/src/**`, the definition of done also wants
browser evidence — run `/browser` and fold what you measured into the message.

## Phase 1 — Pre-flight

In parallel:

1. `git status --short`
2. `git branch --show-current`
3. `git log --oneline @{u}..HEAD` — local commits not yet pushed
4. `git fetch origin` then `git log --oneline HEAD..@{u}` — is the remote ahead

Then stop and ask if any of these are true:

- **Nothing to commit and nothing unpushed** → say so and exit. Never make an
  empty commit.
- **Remote is ahead** → propose `git pull --rebase`. On conflict, stop; do not
  force.
- **A `.env`, a credential-shaped file, or anything under `ghost.one/` appears
  in status** → stop immediately and warn. `ghost.one/` is an unrelated project
  living in-tree; it is gitignored, and its appearance means something broke.
- **A `.vsix`, `dist/`, `node_modules/` or a large binary is staged** → surface
  it. These are always accidents here.

## Phase 2 — Write the message

The repo's style, matched to what is already in the log:

```
<type>(<scope>): <title, lowercase, under 70 chars, no period>

<Prose. Why this exists and what it changes — not a restatement of the
diff, which the reader can see. Wrap at 80. Several short paragraphs beat
one long one.>

<Where a non-obvious decision was made, say what the alternative was and
why it lost. Where something was measured, give the number.>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

`<type>`: `feat` · `fix` · `refactor` · `chore` · `docs` · `style` · `perf` ·
`test` · `build`. `<scope>` is optional and short — `ui`, `cli`, `agents`,
`motion`, `brand`.

What makes a message good here, from the log:

- It records **what was invisible**. "A dangling `s.someName` renders unstyled
  and the build stays green" is worth more than a list of renamed files.
- It records **what was measured**. "opacity at the quarter mark went 0.47 →
  0.94 at the same 200ms" beats "improved the easing".
- It records **the road not taken**. "The obvious fix was to trace it
  parametrically, and measuring says don't: the rays curve."
- It never claims verification that did not happen.

## Phase 3 — Commit

After the user approves the message:

1. `git add -A` — or a precise list if pre-flight surfaced anything unexpected
2. Commit with a heredoc so the formatting survives:
   ```bash
   git commit -F - <<'MSG'
   <message>
   MSG
   ```
3. **Never `--no-verify`.** If a hook fails, that is the hook working.
4. **Never `--amend` a pushed commit.**

## Phase 4 — Push

Skip entirely on "commit only".

1. `git push origin HEAD`
2. **Never `--force` or `--force-with-lease`** unless the user says so
   explicitly, and never onto `main` under any phrasing.

On a non-fast-forward rejection: stop, show the error, propose a rebase.

## Phase 5 — Report

- Branch, short hash, title
- Push status and the commit URL
  (`https://github.com/oldmilky/luno-for-cc/commit/<sha>`)
- The gate results as numbers, not adjectives

## Hard rules

- **Gates first.** A red gate ends the skill.
- **Show the message before committing.** No silent commits.
- **Never commit `.env`, credentials, build output, or `ghost.one/`.**
- **Never force-push. Never push to a branch the user did not name.**
- **Never make an empty commit.**
