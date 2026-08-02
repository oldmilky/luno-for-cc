// ─────────────────────────────────────────────────────────────
// Where the audio comes from, as one interface with several answers.
//
// A file, a subprocess reading `rec`, and a native module all produce the same
// thing: linear16 16 kHz mono frames, pushed as they arrive. Everything above
// this line — the socket, the stop policy, the composer — is written against
// the interface and never learns which one it got.
//
// The file implementation exists first on purpose: it makes the whole feature
// provable before a microphone is involved, and it stays afterwards as the
// only way to test the parts a device would otherwise gate.
// ─────────────────────────────────────────────────────────────

export interface AudioSource {
  /**
   * Begin producing frames. Resolves when the source has stopped of its own
   * accord — a file running out, a device closing — and never for a source
   * that runs until it is told to stop.
   */
  start(onChunk: (pcm: Uint8Array) => void): Promise<void>;
  stop(): void;
}
