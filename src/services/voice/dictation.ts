// ─────────────────────────────────────────────────────────────
// One dictation, from the first frame to the last word.
//
// The decisions this file makes are all failure-shaped, which is why they are
// here rather than spread across a UI: what to keep in case the socket dies
// before it says anything, when one retry is worth it and when it is a lie,
// when to stop a stream nobody is speaking into, and how to close without
// losing the sentence still in flight.
//
// The rules themselves are pure and live in `core/voice/protocol.ts`. This is
// the part that owns timers, a socket and a device, and it takes all three by
// injection so a test needs none of them.
// ─────────────────────────────────────────────────────────────

import type { AudioSource } from "../../core/voice/audio-source.js";
import {
  CLOSE_FRAME,
  CLOSE_GRACE_MS,
  EMPTY_TRANSCRIPT,
  KEEPALIVE_FRAME,
  KEEPALIVE_MS,
  LEVEL_POST_MS,
  RETRY_DELAY_MS,
  STATIC_KEYTERMS,
  appendPreroll,
  applyTranscript,
  buildKeyterms,
  hasAudioSignal,
  isFatalSocketError,
  parseVoiceMessage,
  pcmLevel,
  stopReasonFor,
  transcriptText,
  voiceStreamHeaders,
  voiceStreamUrl,
  type StopReason,
  type TranscriptState
} from "../../core/voice/protocol.js";
import type { VoiceConnect, VoiceSocket } from "./socket.js";

/** Why a dictation ended. `user` is the button; the rest are ours. */
export type DictationEnd = StopReason | "user" | "error" | "source";

export interface DictationOutcome {
  reason: DictationEnd;
  /** Everything committed, plus whatever was still interim when it ended. */
  text: string;
  /** False after a run of any length means the device is not listening. */
  hadAudioSignal: boolean;
  error?: string;
}

export interface DictationEvents {
  onTranscript?(state: TranscriptState): void;
  onLevel?(level: number): void;
  onEnd(outcome: DictationOutcome): void;
}

export interface DictationDeps {
  token: string;
  source: AudioSource;
  connect: VoiceConnect;
  language?: string;
  /** Terms this window is likely to be dictated about, ahead of the static set. */
  keyterms?: readonly string[];
  now?: () => number;
}

export interface Dictation {
  /** The button, and the only reason a caller ever needs. */
  stop(): void;
}

export function startDictation(
  deps: DictationDeps,
  events: DictationEvents
): Dictation {
  const now = deps.now ?? Date.now;
  const url = voiceStreamUrl({ language: deps.language });
  const headers = voiceStreamHeaders(
    deps.token,
    buildKeyterms([...(deps.keyterms ?? []), ...STATIC_KEYTERMS])
  );

  const startedAt = now();
  let lastTranscriptAt = startedAt;
  let state: TranscriptState = EMPTY_TRANSCRIPT;
  let preroll: Uint8Array[] = [];
  let transcribedOnce = false;
  let retried = false;
  let signal = false;
  /** Null rather than zero: the first frame must move the meter whatever the
   *  clock's origin happens to be. */
  let lastLevelAt: number | null = null;
  let ended = false;
  /** Set once `CloseStream` is out, so the server's own close reads as the
   *  answer to it rather than as the socket dying under us. */
  let finishing: DictationEnd | null = null;

  let socket: VoiceSocket | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (keepalive) clearInterval(keepalive);
    if (watchdog) clearInterval(watchdog);
    if (closeTimer) clearTimeout(closeTimer);
    if (retryTimer) clearTimeout(retryTimer);
    keepalive = watchdog = null;
    closeTimer = retryTimer = null;
  }

  function end(reason: DictationEnd, error?: string): void {
    if (ended) return;
    ended = true;
    clearTimers();
    deps.source.stop();
    socket?.close();
    events.onEnd({
      reason,
      text: transcriptText(state),
      hadAudioSignal: signal,
      ...(error ? { error } : {})
    });
  }

  /** Stop speaking, then give the server its moment to finish the sentence. */
  function finish(reason: DictationEnd): void {
    if (ended || finishing) return;
    deps.source.stop();
    if (!socket?.open) return end(reason);
    finishing = reason;
    socket.send(CLOSE_FRAME);
    // The grace is a ceiling, not a wait: the server usually answers with its
    // own close and `onClose` ends it sooner, carrying the last transcript.
    closeTimer = setTimeout(() => end(reason), CLOSE_GRACE_MS);
  }

  function open(): VoiceSocket {
    return deps.connect(url, headers, {
      onOpen() {
        socket?.send(KEEPALIVE_FRAME);
        keepalive = setInterval(() => {
          if (socket?.open) socket.send(KEEPALIVE_FRAME);
        }, KEEPALIVE_MS);
        // A reconnect has a recording already in progress behind it.
        for (const frame of preroll) socket?.send(frame);
      },

      onMessage(raw) {
        const message = parseVoiceMessage(raw);
        if (!message) return;
        if (message.type === "error") return end("error", message.message);

        if (message.type === "transcript") {
          lastTranscriptAt = now();
          if (!transcribedOnce) {
            // The connection has proved itself; replaying this audio after a
            // later failure would say the same sentence twice.
            transcribedOnce = true;
            preroll = [];
          }
        }
        const next = applyTranscript(state, message);
        if (next === state) return;
        state = next;
        events.onTranscript?.(state);
      },

      onError(message) {
        if (ended) return;
        const fatal = isFatalSocketError(message);
        // One retry, and only for a failure that has not yet produced a word:
        // past the first transcript a reconnect would duplicate it, and a 4xx
        // is the server saying no about something a second attempt repeats.
        if (fatal || retried || transcribedOnce) return end("error", message);
        retried = true;
        socket?.close();
        retryTimer = setTimeout(() => {
          if (!ended) socket = open();
        }, RETRY_DELAY_MS);
      },

      onClose() {
        if (ended || retryTimer) return;
        if (finishing) return end(finishing);
        end("error", "the socket closed early");
      }
    });
  }

  socket = open();

  watchdog = setInterval(() => {
    const reason = stopReasonFor({
      now: now(),
      startedAt,
      lastTranscriptAt
    });
    if (reason) finish(reason);
  }, 1_000);

  void deps.source
    .start((pcm) => {
      if (ended) return;
      if (!signal && hasAudioSignal(pcm)) signal = true;
      if (!transcribedOnce) preroll = appendPreroll(preroll, pcm);
      socket?.send(pcm);

      const at = now();
      if (
        events.onLevel &&
        (lastLevelAt === null || at - lastLevelAt >= LEVEL_POST_MS)
      ) {
        lastLevelAt = at;
        events.onLevel(pcmLevel(pcm));
      }
    })
    .then(() => finish("source"))
    .catch((err: unknown) =>
      end("error", err instanceof Error ? err.message : String(err))
    );

  return {
    stop: () => finish("user")
  };
}
