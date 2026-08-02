// ─────────────────────────────────────────────────────────────
// Which language the microphone is listening for.
//
// Two sources answer this and they mean different things. Claude's own
// `language` key is one setting for two jobs — the language it replies in and
// the language it is dictated to in — so following it is right by default.
// `luno.voiceLanguage` exists for the case that setting cannot express: a
// person who reads answers in English and speaks Russian.
//
// MEASURED against the endpoint: `multi` is refused and closes the socket, so
// there is no "just work it out" value to offer. A code is chosen or English
// is assumed.
// ─────────────────────────────────────────────────────────────

/** What the extension setting means when it has not been touched. */
export const FOLLOW_CLAUDE = "auto";

export const DEFAULT_VOICE_LANGUAGE = "en";

export interface LanguageSources {
  /** `luno.voiceLanguage` — `auto` unless the user changed it. */
  configured?: string;
  /** `language`, from whichever Claude settings tier answered first. */
  claude?: unknown;
}

/**
 * The code that goes on the query string.
 *
 * A tolerant read of Claude's value on purpose: it is a free-text key in a
 * file we do not own, so `ru-RU`, `RU` and `ru` all have to mean the same
 * thing, and anything that is not a language code at all has to mean nothing
 * rather than reaching the wire and closing the socket.
 */
export function voiceLanguage(sources: LanguageSources): string {
  const configured = sources.configured?.trim().toLowerCase();
  if (configured && configured !== FOLLOW_CLAUDE) return configured;

  if (typeof sources.claude !== "string") return DEFAULT_VOICE_LANGUAGE;
  const claude = sources.claude.trim().toLowerCase().replace("_", "-");
  const base = claude.split("-")[0];
  return /^[a-z]{2}$/.test(base) ? base : DEFAULT_VOICE_LANGUAGE;
}
