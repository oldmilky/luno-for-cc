import { describe, it, expect } from "vitest";
import {
  CLOSE_FRAME,
  EMPTY_TRANSCRIPT,
  KEEPALIVE_FRAME,
  KEYTERMS_MAX_CHARS,
  MAX_DURATION_MS,
  PREROLL_MAX_BYTES,
  SILENCE_STOP_MS,
  STATIC_KEYTERMS,
  appendPreroll,
  applyTranscript,
  buildKeyterms,
  hasAudioSignal,
  isFatalSocketError,
  keytermsFrom,
  parseVoiceMessage,
  pcmLevel,
  stopReasonFor,
  transcriptText,
  voiceStreamHeaders,
  voiceStreamUrl,
  type TranscriptState
} from "../../src/core/voice/protocol.js";

const pcm = (...samples: number[]): Uint8Array => {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
};

describe("the URL the socket opens", () => {
  it("asks for the only audio shape the capture side produces", () => {
    const query = new URL(voiceStreamUrl()).searchParams;
    expect(query.get("encoding")).toBe("linear16");
    expect(query.get("sample_rate")).toBe("16000");
    expect(query.get("channels")).toBe("1");
  });

  it("defaults to English and carries a language when there is one", () => {
    expect(new URL(voiceStreamUrl()).searchParams.get("language")).toBe("en");
    expect(
      new URL(voiceStreamUrl({ language: "ru" })).searchParams.get("language")
    ).toBe("ru");
    // An empty setting is absence, not a language code.
    expect(
      new URL(voiceStreamUrl({ language: "" })).searchParams.get("language")
    ).toBe("en");
  });

  it("keeps the conversation engine and the provider the endpoint expects", () => {
    const query = new URL(voiceStreamUrl()).searchParams;
    expect(query.get("use_conversation_engine")).toBe("true");
    expect(query.get("stt_provider")).toBe("deepgram-nova3");
    expect(query.get("endpointing_ms")).toBe("300");
    expect(query.get("utterance_end_ms")).toBe("1000");
  });
});

describe("headers", () => {
  it("bears the token and identifies the client", () => {
    const headers = voiceStreamHeaders("tok-123");
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(headers["x-app"]).toBe("vscode");
    expect(headers["anthropic-client-platform"]).toBe("claude_code_vscode");
  });

  it("omits the keyterm header rather than sending an empty one", () => {
    expect(voiceStreamHeaders("t")).not.toHaveProperty("x-config-keyterms");
    expect(voiceStreamHeaders("t", "MCP,worktree")["x-config-keyterms"]).toBe(
      "MCP,worktree"
    );
  });
});

describe("keyterms", () => {
  it("separates with commas and drops a comma inside a term", () => {
    // A comma inside a term would invent one.
    expect(buildKeyterms(["hello, world", "MCP"])).toBe("hello world,MCP");
  });

  it("drops duplicates and blanks", () => {
    expect(buildKeyterms(["MCP", "MCP", "  ", "grep"])).toBe("MCP,grep");
  });

  it("strips anything outside printable ASCII, so Russian survives as nothing", () => {
    // The channel exists but cannot carry Russian — worth failing loudly here
    // rather than quietly on the wire.
    expect(buildKeyterms(["воркtree"])).toBe("tree");
    expect(buildKeyterms(["привет", "мир"])).toBe("");
  });

  it("stops at the header's limit instead of truncating a term", () => {
    const long = Array.from({ length: 200 }, (_, i) => `term${i}padding`);
    const built = buildKeyterms(long);
    expect(built.length).toBeLessThanOrEqual(KEYTERMS_MAX_CHARS);
    for (const term of built.split(","))
      expect(term).toMatch(/^term\d+padding$/);
  });

  it("carries the words this window is about", () => {
    expect(
      keytermsFrom({ folder: "luno-for-cc", branch: "feat/voice" })
    ).toEqual(["luno-for-cc", "feat", "voice"]);
  });

  it("splits a camelCase branch the way it is spoken", () => {
    expect(keytermsFrom({ branch: "addVoiceCapture" })).toEqual([
      "add",
      "Voice",
      "Capture"
    ]);
  });

  it("says nothing about a detached head or a two-letter folder", () => {
    expect(keytermsFrom({ branch: "HEAD" })).toEqual([]);
    expect(keytermsFrom({ folder: "ui" })).toEqual([]);
  });

  it("ships the words a recogniser gets wrong on its own", () => {
    expect(STATIC_KEYTERMS).toContain("worktree");
    expect(STATIC_KEYTERMS).toContain("MCP");
  });
});

describe("parsing what the server says", () => {
  it("reads the running result", () => {
    expect(
      parseVoiceMessage(JSON.stringify({ type: "TranscriptText", data: "hi" }))
    ).toEqual({ type: "transcript", text: "hi" });
  });

  it("still understands TranscriptInterim, which the live stream never sent", () => {
    // Kept because the reference handles it; never observed against the real
    // endpoint under the query we send.
    expect(
      parseVoiceMessage(
        JSON.stringify({ type: "TranscriptInterim", data: "hi" })
      )
    ).toEqual({ type: "transcript", text: "hi" });
  });

  it("reads the commit", () => {
    expect(
      parseVoiceMessage(JSON.stringify({ type: "TranscriptEndpoint" }))
    ).toEqual({ type: "endpoint" });
  });

  it("names an error from either of the two shapes it arrives in", () => {
    expect(
      parseVoiceMessage(
        JSON.stringify({ type: "TranscriptError", description: "bad audio" })
      )
    ).toEqual({ type: "error", message: "bad audio" });
    expect(
      parseVoiceMessage(JSON.stringify({ type: "error", message: "nope" }))
    ).toEqual({ type: "error", message: "nope" });
  });

  it("ignores a frame it has no use for rather than throwing", () => {
    expect(parseVoiceMessage("not json")).toBeNull();
    expect(parseVoiceMessage(JSON.stringify({ type: "Metadata" }))).toBeNull();
    expect(
      parseVoiceMessage(JSON.stringify({ type: "TranscriptText", data: "" }))
    ).toBeNull();
  });

  it("keeps the two frames we send fixed", () => {
    expect(JSON.parse(KEEPALIVE_FRAME)).toEqual({ type: "KeepAlive" });
    expect(JSON.parse(CLOSE_FRAME)).toEqual({ type: "CloseStream" });
  });
});

describe("folding a transcript", () => {
  const say = (state: TranscriptState, text: string) =>
    applyTranscript(state, { type: "transcript", text });
  const commit = (state: TranscriptState) =>
    applyTranscript(state, { type: "endpoint" });

  it("replaces the tail rather than appending it", () => {
    // Each TranscriptText carries the whole utterance so far. Appending would
    // stutter the sentence back at the person saying it.
    let state = say(EMPTY_TRANSCRIPT, "hello");
    state = say(state, "hello this");
    state = say(state, "hello this is a probe");
    expect(transcriptText(state)).toBe("hello this is a probe");
  });

  it("only an endpoint moves words into the committed half", () => {
    const state = say(EMPTY_TRANSCRIPT, "hello");
    expect(state.committed).toBe("");
    expect(commit(state).committed).toBe("hello");
    expect(commit(state).interim).toBe("");
  });

  it("joins utterances with one space", () => {
    let state = commit(say(EMPTY_TRANSCRIPT, "first sentence."));
    state = commit(say(state, "second one."));
    expect(state.committed).toBe("first sentence. second one.");
  });

  it("does not commit an empty tail", () => {
    const state = commit(EMPTY_TRANSCRIPT);
    expect(state).toEqual(EMPTY_TRANSCRIPT);
  });

  it("leaves an error to the caller and changes nothing", () => {
    const state = say(EMPTY_TRANSCRIPT, "hello");
    expect(applyTranscript(state, { type: "error", message: "x" })).toBe(state);
  });
});

describe("when a dictation stops itself", () => {
  it("says nothing while transcripts keep arriving", () => {
    expect(
      stopReasonFor({ now: 60_000, startedAt: 0, lastTranscriptAt: 59_000 })
    ).toBeNull();
  });

  it("gives up after the silence line", () => {
    expect(
      stopReasonFor({
        now: SILENCE_STOP_MS,
        startedAt: 0,
        lastTranscriptAt: 0
      })
    ).toBe("silence");
  });

  it("stops at the ceiling even mid-sentence", () => {
    // A person still talking must not hold the socket open forever.
    expect(
      stopReasonFor({
        now: MAX_DURATION_MS,
        startedAt: 0,
        lastTranscriptAt: MAX_DURATION_MS - 1
      })
    ).toBe("max_duration");
  });
});

describe("reading the audio itself", () => {
  it("calls perfect digital silence what it is", () => {
    // A device that opened but is not listening produces this, not an error.
    expect(hasAudioSignal(pcm(0, 0, 0))).toBe(false);
    expect(hasAudioSignal(pcm(0, 0, 1))).toBe(true);
  });

  it("puts the meter between nothing and full scale", () => {
    expect(pcmLevel(pcm(0, 0, 0))).toBe(0);
    expect(pcmLevel(new Uint8Array())).toBe(0);
    expect(pcmLevel(pcm(32767, -32768))).toBeCloseTo(1, 2);
    const quiet = pcmLevel(pcm(3000, -3000));
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(0.2);
  });
});

describe("the audio held back for a retry", () => {
  it("keeps frames while they fit", () => {
    const kept = appendPreroll([], new Uint8Array(10), 100);
    expect(kept).toHaveLength(1);
    expect(appendPreroll(kept, new Uint8Array(10), 100)).toHaveLength(2);
  });

  it("drops the oldest once the cap is passed", () => {
    // What matters after a failed handshake is the tail the user was in the
    // middle of saying.
    let kept: Uint8Array[] = [];
    for (let i = 0; i < 5; i++)
      kept = appendPreroll(kept, new Uint8Array(30), 100);
    expect(kept.reduce((sum, f) => sum + f.length, 0)).toBeLessThanOrEqual(100);
    expect(kept).toHaveLength(3);
  });

  it("never drops the frame it was just given", () => {
    const kept = appendPreroll([], new Uint8Array(500), 100);
    expect(kept).toHaveLength(1);
  });

  it("defaults to five seconds of audio", () => {
    expect(PREROLL_MAX_BYTES).toBe(160_000);
  });
});

describe("which socket failures are worth a second attempt", () => {
  it("gives up on the server saying no", () => {
    // A 4xx is about the token, the query or the account. Asking again changes
    // none of them.
    expect(isFatalSocketError("Unexpected server response: 401")).toBe(true);
    expect(isFatalSocketError("Unexpected server response: 403")).toBe(true);
  });

  it("retries the network", () => {
    expect(isFatalSocketError("Unexpected server response: 502")).toBe(false);
    expect(isFatalSocketError("socket hang up")).toBe(false);
    expect(isFatalSocketError("ECONNRESET")).toBe(false);
  });
});
