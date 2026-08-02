// ─────────────────────────────────────────────────────────────
// The speech-to-text wire, as rules rather than as a socket.
//
// Everything a dictation turn decides — what URL to open, what the server just
// said, when to give up, what to keep in case the first attempt dies — lives
// here, where none of it needs a microphone, a network or a window to be
// proved. `services/voice/` owns the socket and the device; this owns the
// protocol.
//
// The shapes were read out of a shipped bundle and then checked against the
// live endpoint. Where the two disagreed the wire won, and each disagreement is
// written down next to the rule it changed.
// ─────────────────────────────────────────────────────────────

export const VOICE_STREAM_URL =
  "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream";

/** The only audio shape the endpoint is asked for: linear16, 16 kHz, mono. */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

export const KEEPALIVE_MS = 8_000;

/** How long to wait for the server's own close after `CloseStream`. */
export const CLOSE_GRACE_MS = 3_000;

/**
 * Give up when nothing has been transcribed for this long.
 *
 * Not a silence detector: a person thinking mid-sentence keeps the stream open
 * because their last words still produced a transcript. This is the line for
 * "the microphone is open and the endpoint has nothing to say about it".
 */
export const SILENCE_STOP_MS = 15_000;

/** The hard ceiling on one dictation, whatever is being said. */
export const MAX_DURATION_MS = 120_000;

/** How often the level meter is posted to the webview. */
export const LEVEL_POST_MS = 50;

/**
 * Audio kept before the first transcript, in case the socket has to be retried.
 *
 * Five seconds at 32 kB/s. Past the first transcript the connection has proved
 * itself and the buffer is dropped — replaying a stream the server already
 * transcribed would duplicate the sentence.
 */
export const PREROLL_MAX_BYTES = 160_000;

/** How long to wait before the one retry of an early, non-fatal failure. */
export const RETRY_DELAY_MS = 250;

/** The `x-config-keyterms` header's own limit. */
export const KEYTERMS_MAX_CHARS = 1024;

/**
 * The vocabulary the reference sends, kept because it does.
 *
 * Its effect is **unproven here**: a probe carrying "worktree" in this header
 * still came back "work tree". Sending it costs one header on one socket, and
 * removing it would be a guess in the other direction — but nobody should
 * treat this list as the fix for a misheard term until a probe says it is.
 */
export const STATIC_KEYTERMS = [
  "VS Code",
  "IDE",
  "webview",
  "IntelliSense",
  "MCP",
  "symlink",
  "grep",
  "regex",
  "localhost",
  "codebase",
  "TypeScript",
  "JSON",
  "OAuth",
  "webhook",
  "gRPC",
  "dotfiles",
  "subagent",
  "worktree"
] as const;

export interface VoiceStreamOptions {
  /** A two-letter code. Anything falsy means English, as the reference does. */
  language?: string;
}

export function voiceStreamUrl(options: VoiceStreamOptions = {}): string {
  const query = new URLSearchParams({
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    endpointing_ms: "300",
    utterance_end_ms: "1000",
    language: options.language || "en",
    use_conversation_engine: "true",
    stt_provider: "deepgram-nova3"
  });
  return `${VOICE_STREAM_URL}?${query.toString()}`;
}

export function voiceStreamHeaders(
  token: string,
  keyterms = ""
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-app": "vscode",
    "anthropic-client-platform": "claude_code_vscode",
    ...(keyterms ? { "x-config-keyterms": keyterms } : {})
  };
}

/**
 * The header value, built to its own constraints.
 *
 * Commas separate the terms, so a comma inside one would invent a term; every
 * byte outside printable ASCII is dropped by the reference, which means a
 * Russian keyterm list survives this function as nothing at all. That is worth
 * knowing before anyone builds a feature on top of it: the channel exists, but
 * it cannot carry Russian.
 */
export function buildKeyterms(terms: readonly string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;

  for (const term of terms) {
    const clean = term
      .replaceAll(",", " ")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean || seen.has(clean)) continue;
    const cost = clean.length + (kept.length > 0 ? 1 : 0);
    if (length + cost > KEYTERMS_MAX_CHARS) break;
    seen.add(clean);
    kept.push(clean);
    length += cost;
  }
  return kept.join(",");
}

export interface KeytermContext {
  /** The workspace folder's own name, not its path. */
  folder?: string;
  /** The current branch, or nothing on a detached head. */
  branch?: string;
}

/**
 * What this particular window is likely to be dictated about.
 *
 * A folder name and a branch name are the two strings a person says out loud
 * while working and no general recogniser has ever heard.
 */
export function keytermsFrom(ctx: KeytermContext): string[] {
  const terms: string[] = [];
  const folder = ctx.folder?.trim();
  if (folder && folder.length > 2 && folder.length <= 50) terms.push(folder);

  const branch = ctx.branch?.trim();
  if (branch && branch !== "HEAD") {
    for (const word of branch
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[-_./\s]+/)) {
      const clean = word.trim();
      if (clean.length > 2 && clean.length <= 20) terms.push(clean);
    }
  }
  return terms;
}

export type VoiceMessage =
  /** The running result. MEASURED: cumulative within an utterance, not a delta. */
  | { type: "transcript"; text: string }
  /** The utterance is over and what stands is final. */
  | { type: "endpoint" }
  | { type: "error"; message: string };

/**
 * One server frame, or `null` for anything this client has no use for.
 *
 * `TranscriptInterim` is handled because the reference handles it, but it was
 * never observed: with `use_conversation_engine=true` and no
 * `forward_interims=typed`, the live stream carries `TranscriptText` and
 * `TranscriptEndpoint` and nothing else.
 */
export function parseVoiceMessage(raw: string): VoiceMessage | null {
  let frame: {
    type?: unknown;
    data?: unknown;
    description?: unknown;
    message?: unknown;
  };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return null;
  }
  const text = typeof frame.data === "string" ? frame.data : "";

  switch (frame.type) {
    case "TranscriptInterim":
    case "TranscriptText":
      return text ? { type: "transcript", text } : null;
    case "TranscriptEndpoint":
      return { type: "endpoint" };
    case "TranscriptError":
      return {
        type: "error",
        message:
          typeof frame.description === "string"
            ? frame.description
            : "transcription error"
      };
    case "error":
      return {
        type: "error",
        message:
          typeof frame.message === "string" ? frame.message : "server error"
      };
    default:
      return null;
  }
}

export const KEEPALIVE_FRAME = JSON.stringify({ type: "KeepAlive" });
export const CLOSE_FRAME = JSON.stringify({ type: "CloseStream" });

/** What the composer should be showing: everything final, plus the live tail. */
export interface TranscriptState {
  committed: string;
  interim: string;
}

export const EMPTY_TRANSCRIPT: TranscriptState = { committed: "", interim: "" };

/**
 * Fold one frame into what the user sees.
 *
 * The interim *replaces* rather than appends, because each `TranscriptText`
 * carries the whole utterance so far — appending would stutter the sentence
 * back at the person saying it. Only an endpoint moves words into `committed`,
 * which is why a dropped interim costs nothing.
 */
export function applyTranscript(
  state: TranscriptState,
  message: VoiceMessage
): TranscriptState {
  if (message.type === "transcript")
    return { ...state, interim: message.text.trim() };
  if (message.type !== "endpoint") return state;
  if (!state.interim) return state;
  return {
    committed: state.committed
      ? `${state.committed} ${state.interim}`
      : state.interim,
    interim: ""
  };
}

/** The one string the composer renders. */
export function transcriptText(state: TranscriptState): string {
  if (!state.interim) return state.committed;
  return state.committed
    ? `${state.committed} ${state.interim}`
    : state.interim;
}

export type StopReason = "silence" | "max_duration";

export interface StopContext {
  now: number;
  startedAt: number;
  /** When the endpoint last said anything — the start, until it does. */
  lastTranscriptAt: number;
}

export function stopReasonFor(ctx: StopContext): StopReason | null {
  if (ctx.now - ctx.startedAt >= MAX_DURATION_MS) return "max_duration";
  if (ctx.now - ctx.lastTranscriptAt >= SILENCE_STOP_MS) return "silence";
  return null;
}

/**
 * Whether any sample in this frame is non-zero.
 *
 * A device that opened but is not listening — the wrong input selected, a
 * muted array microphone — produces perfect digital silence rather than an
 * error. Without this the user is told nothing was said; with it they can be
 * told to check the device.
 */
export function hasAudioSignal(pcm: Uint8Array): boolean {
  for (let at = 0; at + 1 < pcm.length; at += 2)
    if (pcm[at] !== 0 || pcm[at + 1] !== 0) return true;
  return false;
}

/**
 * A 0…1 level for the meter, RMS over the frame.
 *
 * Ours, not the reference's: theirs is a compiled detail and a meter is not a
 * measurement anyone reads a number off. RMS rather than peak so a single
 * click does not paint a full bar.
 */
export function pcmLevel(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let at = 0; at < samples; at++) {
    const sample = view.getInt16(at * 2, true) / 32768;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / samples));
}

/**
 * The audio held back for a possible retry.
 *
 * Oldest frames go first: what matters after a failed handshake is the tail
 * the user was in the middle of saying, and the cap is what keeps a long
 * connection failure from holding the whole recording in memory.
 */
export function appendPreroll(
  preroll: readonly Uint8Array[],
  chunk: Uint8Array,
  cap = PREROLL_MAX_BYTES
): Uint8Array[] {
  const kept = [...preroll, chunk];
  let total = kept.reduce((sum, frame) => sum + frame.length, 0);
  while (total > cap && kept.length > 1) {
    total -= kept.shift()!.length;
  }
  return kept;
}

/**
 * Whether a socket failure is worth one more attempt.
 *
 * A 4xx is the server saying no — about the token, the query, or the account —
 * and asking again changes none of them. Anything else is the network, which
 * does change.
 */
export function isFatalSocketError(message: string): boolean {
  const status = /^Unexpected server response: (\d+)/.exec(message);
  if (!status) return false;
  const code = Number(status[1]);
  return code >= 400 && code < 500;
}
