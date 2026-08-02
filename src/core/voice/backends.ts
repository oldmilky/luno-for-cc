// ─────────────────────────────────────────────────────────────
// Which way this machine can hear, and what to say when it cannot.
//
// Three answers exist, in order: the recorder this extension ships, a
// command-line recorder the user already had, and nothing. Choosing between
// them is a decision about a platform and a few strings, so it is made here,
// where a test can make the choice without owning a microphone.
//
// The argv for the borrowed recorders are the reference's own, and they are
// not arbitrary: each describes the same stream the endpoint is opened for —
// raw, signed 16-bit, 16 kHz, mono. Our own binary needs no arguments because
// producing exactly that is the only thing it does.
// ─────────────────────────────────────────────────────────────

export type CaptureBackend = "bundled" | "rec" | "arecord";

export const CAPTURE_COMMANDS: Record<
  Exclude<CaptureBackend, "bundled">,
  readonly string[]
> = {
  rec: [
    "-q",
    "--buffer",
    "1024",
    "-t",
    "raw",
    "-r",
    "16000",
    "-e",
    "signed",
    "-b",
    "16",
    "-c",
    "1",
    "-"
  ],
  arecord: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"]
};

/** Asked in this order: `rec` ships with sox on every platform, `arecord` only
 *  where ALSA does. Our own binary is tried before either. */
export const BORROWED_CANDIDATES = ["rec", "arecord"] as const;

/**
 * The targets a VSIX carries a recorder for.
 *
 * One package holds all of them rather than one package per platform: the CLI
 * is not bundled here, so a platform-specific VSIX would exist for this binary
 * alone — six artefacts and six publishes to save five megabytes on an install
 * that happens once.
 */
export const AUDIO_SLOTS = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64"
] as const;

export type AudioSlot = (typeof AUDIO_SLOTS)[number];

/** Where in `resources/audio` this machine's recorder would be, or null when
 *  the extension carries none for it. */
export function audioSlotFor(
  platform: NodeJS.Platform,
  arch: string
): AudioSlot | null {
  const slot = `${platform}-${arch}`;
  return (AUDIO_SLOTS as readonly string[]).includes(slot)
    ? (slot as AudioSlot)
    : null;
}

export function recorderFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "luno-audio.exe" : "luno-audio";
}

export interface CaptureAvailability {
  /** Whether the shipped recorder is on disk for this platform and arch. */
  bundled: boolean;
  /** Which borrowed recorders answered `which`. */
  borrowed: readonly ("rec" | "arecord")[];
}

export function chooseCapture(
  available: CaptureAvailability
): CaptureBackend | null {
  if (available.bundled) return "bundled";
  for (const candidate of BORROWED_CANDIDATES)
    if (available.borrowed.includes(candidate)) return candidate;
  return null;
}

/**
 * Why voice is unavailable, in words a user can act on.
 *
 * A disabled button that says nothing is the failure this exists to prevent.
 * The two cases are genuinely different: an architecture we do not build for
 * is ours to fix, and a missing recorder on an architecture we do build for
 * means the file did not survive whatever installed it.
 */
export function noBackendMessage(
  platform: NodeJS.Platform,
  arch: string
): string {
  if (!audioSlotFor(platform, arch))
    return `Dictation has no recorder built for ${platform}-${arch} yet — installing SoX gives it one in the meantime.`;

  const install =
    platform === "win32"
      ? "`winget install SoX.SoX`"
      : platform === "darwin"
        ? "`brew install sox`"
        : "`apt install sox`";
  return `No microphone backend was found — the bundled recorder is missing from this install, and SoX (${install}) would stand in for it.`;
}
