// ─────────────────────────────────────────────────────────────
// Number and duration formatting shared across features.
//
// One home so the next one is found rather than written again: `formatCount`
// existed twice, byte-identical, in two components that never saw each other.
//
// The three number formats in this app are NOT interchangeable, which is why
// only two of them live here and `formatCompact` / `formatNum` /
// `formatPctUsed` stay in `features/chat/usage/usage-view.ts` with the token meter
// that is their only consumer. Measured, same input through each:
//
//        input     formatTokens  formatCompact  formatCount
//         1 000     1.0k          1k             1.0k
//        19 200    19.2k         19k            19.2k
//       128 000    128k          128k           128.0k
//     1 230 000     1.2M          1.23M          1.2M
//
// Six of nine sampled values disagree. Merging any pair moves numbers on
// screen, so a future tidy-up that unifies them is a behaviour change and
// needs to be argued as one.
// ─────────────────────────────────────────────────────────────

/** Marketplace counts — installs and stars: "940" / "1.5k" / "1.2M". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/** Format a token count for a chip: "940" / "19.2k" / "128k" / "1.4M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format a turn duration: "2s" / "47s" / "1m 12s" / "4m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (r === 0) return `${m}m`;
  return `${m}m ${r}s`;
}
