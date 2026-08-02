// ─────────────────────────────────────────────────────────────
// A WAV file pretending to be a microphone.
//
// The endpoint is a live transcriber: it decides where an utterance ends from
// the gaps between frames, so a file dumped at it as fast as the disk allows
// is not the same input as a person talking. This paces from the audio's own
// clock, which is also the rule a real device follows for free.
//
// It exists so the socket, the stop policy and the composer can all be proved
// on a machine with no capture backend at all.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import type { AudioSource } from "../../core/voice/audio-source.js";
import { BYTES_PER_SECOND } from "../../core/voice/protocol.js";

export interface WavAudio {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** The `data` chunk, located by walking the RIFF chunks rather than assumed to
 *  start at byte 44 — writers put `LIST` and `fact` chunks before it. */
export function readWav(file: string): WavAudio {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF")
    throw new Error("not a RIFF file");

  let at = 12;
  let format: Omit<WavAudio, "pcm"> | null = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ")
      format = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14)
      };
    if (id === "data") {
      if (!format) throw new Error("data chunk before fmt chunk");
      return {
        ...format,
        pcm: new Uint8Array(buf.subarray(body, body + size))
      };
    }
    at = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

export interface WavSourceOptions {
  /** Frame size. 1024 bytes is 32 ms, which is what the reference asks `rec`
   *  for and small enough that the endpoint's own 300 ms endpointing decides
   *  utterance boundaries rather than our buffering. */
  chunkBytes?: number;
  /** Feed as fast as the loop allows. For tests, never for the endpoint. */
  realtime?: boolean;
}

export class WavAudioSource implements AudioSource {
  private stopped = false;

  constructor(
    private readonly audio: WavAudio,
    private readonly options: WavSourceOptions = {}
  ) {
    if (
      audio.sampleRate !== 16_000 ||
      audio.channels !== 1 ||
      audio.bitsPerSample !== 16
    )
      throw new Error(
        `the endpoint wants linear16 16 kHz mono, got ${audio.sampleRate} Hz · ` +
          `${audio.channels}ch · ${audio.bitsPerSample}-bit`
      );
  }

  static fromFile(file: string, options?: WavSourceOptions): WavAudioSource {
    return new WavAudioSource(readWav(file), options);
  }

  async start(onChunk: (pcm: Uint8Array) => void): Promise<void> {
    const size = this.options.chunkBytes ?? 1024;
    const realtime = this.options.realtime ?? true;
    // Pace against the wall clock rather than sleeping a fixed interval per
    // frame: a constant sleep accumulates the loop's own overhead and drifts
    // slower than realtime, which the endpoint reads as hesitation.
    const startedAt = Date.now();

    for (let at = 0; at < this.audio.pcm.length && !this.stopped; at += size) {
      onChunk(this.audio.pcm.subarray(at, at + size));
      if (!realtime) continue;
      const owed =
        ((at + size) / BYTES_PER_SECOND) * 1000 - (Date.now() - startedAt);
      if (owed > 0) await new Promise((done) => setTimeout(done, owed));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
