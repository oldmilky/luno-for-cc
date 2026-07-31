// ─────────────────────────────────────────────────────────────
// What the empty state offers before the first message.
//
// Three sources, in priority order: the user's `luno.startupSuggestions`, the
// skills actually on disk, and a generic fallback. The fallback is not
// decoration — a project with no `.claude/skills` would otherwise open on a
// bare screen, which is every project until someone writes a skill.
//
// Descriptions arrive whole: `parseFrontmatter` in src/services/claude-skills.ts
// documents "first sentence" and in fact slices at 240 characters, so a card
// that wants one sentence has to cut it here.
// ─────────────────────────────────────────────────────────────

import type { SlashCommand } from "../../lib/rpc";

export interface StartupCard {
  /** What lands in the composer. A command carries a trailing space so the
   *  cursor sits where its argument goes. */
  text: string;
  title: string;
  sub?: string;
}

export interface StartupGroup {
  /** `null` renders without a badge — the fallback cards are LUNO's, and
   *  filing them under "personal" would claim the user chose them. */
  label: string | null;
  items: StartupCard[];
}

/** Six fills the hero without pushing the composer off a short panel. */
const AUTO_LIMIT = 6;

/** Past this a sub-line wraps to three rows and the card stops scanning. */
const SUB_MAX = 90;

const FALLBACK: ReadonlyArray<StartupCard> = [
  {
    text: "Explain this codebase",
    title: "Explain this codebase",
    sub: "Walk through architecture and key symbols"
  },
  {
    text: "Find and fix a bug",
    title: "Find and fix a bug",
    sub: "Search for the issue, then patch it"
  },
  {
    text: "Refactor for clarity",
    title: "Refactor for clarity",
    sub: "Extract helpers, preserve behavior"
  },
  {
    text: "Write tests for the selected file",
    title: "Write tests for the selected file",
    sub: "Match existing test patterns"
  }
];

/**
 * Decide the empty state's cards.
 *
 * `configured` is `luno.startupSuggestions` verbatim: an entry starting with
 * `/` names a command, anything else is a literal prompt. A configured name
 * nothing on disk answers to is still shown, without a sub-line — silently
 * dropping what someone typed into their own settings is worse than showing it
 * bare.
 */
export function resolveStartupCards(
  configured: ReadonlyArray<string>,
  commands: ReadonlyArray<SlashCommand>
): StartupGroup[] {
  // The host filters this too, and both are load-bearing: a hand-edited
  // settings.json is the input, and the hero blanking the panel is the cost of
  // trusting it.
  const chosen = (Array.isArray(configured) ? configured : [])
    .filter((raw) => typeof raw === "string")
    .map((raw) => raw.trim())
    .filter(Boolean);
  if (chosen.length > 0) return groupConfigured(chosen, commands);

  const own = commands.filter((c) => c.source !== "cli").slice(0, AUTO_LIMIT);
  if (own.length === 0) return [{ label: null, items: [...FALLBACK] }];

  return toGroups(
    own.map((c) => ({ card: cardFor(c), personal: c.source === "user" }))
  );
}

function groupConfigured(
  chosen: ReadonlyArray<string>,
  commands: ReadonlyArray<SlashCommand>
): StartupGroup[] {
  const byName = new Map(commands.map((c) => [c.name, c]));
  return toGroups(
    chosen.map((entry) => {
      if (!entry.startsWith("/")) {
        return { card: { text: entry, title: entry }, personal: true };
      }
      const name = entry.slice(1);
      const known = byName.get(name);
      return {
        card: known ? cardFor(known) : { text: `${entry} `, title: entry },
        // A command the disk scan never saw came out of the user's own
        // settings, so it belongs beside the rest of what they chose.
        personal: known?.source !== "project"
      };
    })
  );
}

function toGroups(
  entries: ReadonlyArray<{ card: StartupCard; personal: boolean }>
): StartupGroup[] {
  const project = entries.filter((e) => !e.personal).map((e) => e.card);
  const personal = entries.filter((e) => e.personal).map((e) => e.card);
  return [
    { label: "Project", items: project },
    { label: "Personal", items: personal }
  ].filter((g) => g.items.length > 0);
}

function cardFor(command: SlashCommand): StartupCard {
  return {
    text: `/${command.name} `,
    title: `/${command.name}`,
    sub: shorten(command.description)
  };
}

/** First sentence, clamped on a word boundary. Skill descriptions are written
 *  for the model — a trigger clause follows the summary in most of them. */
export function shorten(description: string | undefined): string | undefined {
  const text = description?.trim();
  if (!text) return undefined;

  const end = /[.!?](\s|$)/.exec(text);
  const sentence = (end ? text.slice(0, end.index) : text).trim();
  if (sentence.length <= SUB_MAX) return sentence || undefined;

  const cut = sentence.slice(0, SUB_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
