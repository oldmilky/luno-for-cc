import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startDictation,
  type DictationOutcome
} from "../../src/services/voice/dictation.js";
import type {
  VoiceConnect,
  VoiceSocketHandlers
} from "../../src/services/voice/socket.js";
import type { AudioSource } from "../../src/core/voice/audio-source.js";
import {
  CLOSE_GRACE_MS,
  KEEPALIVE_MS,
  MAX_DURATION_MS,
  RETRY_DELAY_MS,
  SILENCE_STOP_MS
} from "../../src/core/voice/protocol.js";

/** A socket that records what was sent and lets a test play the server. */
class FakeSocket {
  sent: (string | Uint8Array)[] = [];
  open = true;
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
    readonly handlers: VoiceSocketHandlers
  ) {}
  send(data: string | Uint8Array) {
    if (this.open) this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.open = false;
  }
  get frames() {
    return this.sent.filter((d): d is string => typeof d === "string");
  }
  get audio() {
    return this.sent.filter((d): d is Uint8Array => typeof d !== "string");
  }
  says(type: string, data?: string) {
    this.handlers.onMessage(
      JSON.stringify({ type, ...(data ? { data } : {}) })
    );
  }
}

/** A source the test pushes frames into by hand. */
class ManualSource implements AudioSource {
  push: ((pcm: Uint8Array) => void) | null = null;
  stopped = false;
  private finish: (() => void) | null = null;
  start(onChunk: (pcm: Uint8Array) => void): Promise<void> {
    this.push = onChunk;
    return new Promise((done) => {
      this.finish = done;
    });
  }
  stop() {
    this.stopped = true;
    this.finish?.();
  }
  /** The file running out, rather than the user stopping it. */
  exhaust() {
    this.finish?.();
  }
}

const loud = (): Uint8Array => new Uint8Array([0, 1, 0, 1]);
const silent = (): Uint8Array => new Uint8Array([0, 0, 0, 0]);

let sockets: FakeSocket[] = [];
let source: ManualSource;
let ended: DictationOutcome[] = [];
let clock = 0;

const connect: VoiceConnect = (url, headers, handlers) => {
  const socket = new FakeSocket(url, headers, handlers);
  sockets.push(socket);
  return socket;
};

const start = (over: Partial<Parameters<typeof startDictation>[0]> = {}) =>
  startDictation(
    {
      token: "tok",
      source,
      connect,
      now: () => clock,
      ...over
    },
    { onEnd: (outcome) => ended.push(outcome) }
  );

/** Let the source's own promise settle before asserting on the outcome. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  ended = [];
  clock = 0;
  source = new ManualSource();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("opening", () => {
  it("carries the token and the audio shape the source will produce", () => {
    start();
    const [socket] = sockets;
    expect(socket.headers.Authorization).toBe("Bearer tok");
    expect(new URL(socket.url).searchParams.get("encoding")).toBe("linear16");
  });

  it("keeps the socket alive on the server's own interval", () => {
    start();
    sockets[0].handlers.onOpen();
    expect(sockets[0].frames).toHaveLength(1);
    vi.advanceTimersByTime(KEEPALIVE_MS * 2);
    expect(sockets[0].frames).toHaveLength(3);
  });

  it("stops the keepalive once it is over", async () => {
    const run = start();
    sockets[0].handlers.onOpen();
    run.stop();
    sockets[0].handlers.onClose();
    await settle();
    const before = sockets[0].frames.length;
    vi.advanceTimersByTime(KEEPALIVE_MS * 3);
    expect(sockets[0].frames).toHaveLength(before);
  });
});

describe("the audio held back for a retry", () => {
  it("replays what was said before a failed handshake", () => {
    start();
    source.push!(loud());
    source.push!(loud());
    sockets[0].handlers.onError("socket hang up");
    vi.advanceTimersByTime(RETRY_DELAY_MS);

    expect(sockets).toHaveLength(2);
    sockets[1].handlers.onOpen();
    expect(sockets[1].audio).toHaveLength(2);
  });

  it("does not replay once a word has come back", () => {
    // Past the first transcript a reconnect would say the same sentence twice.
    start();
    source.push!(loud());
    sockets[0].says("TranscriptText", "hello");
    source.push!(loud());
    sockets[0].handlers.onError("socket hang up");
    vi.advanceTimersByTime(RETRY_DELAY_MS);
    expect(sockets).toHaveLength(1);
    expect(ended[0].reason).toBe("error");
  });

  it("gives up at once on a 4xx, which a second attempt only repeats", async () => {
    start();
    sockets[0].handlers.onError("Unexpected server response: 401");
    await settle();
    expect(sockets).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      reason: "error",
      error: "Unexpected server response: 401"
    });
  });

  it("retries once and not twice", async () => {
    start();
    sockets[0].handlers.onError("socket hang up");
    vi.advanceTimersByTime(RETRY_DELAY_MS);
    sockets[1].handlers.onError("socket hang up again");
    await settle();
    expect(sockets).toHaveLength(2);
    expect(ended[0].reason).toBe("error");
  });
});

describe("what the user ends up with", () => {
  it("commits on an endpoint and reports it", async () => {
    const run = start();
    sockets[0].handlers.onOpen();
    sockets[0].says("TranscriptText", "hello there");
    sockets[0].says("TranscriptEndpoint");
    run.stop();
    sockets[0].handlers.onClose();
    await settle();
    expect(ended[0].text).toBe("hello there");
    expect(ended[0].reason).toBe("user");
  });

  it("keeps a tail the server never committed", async () => {
    // Hanging up mid-sentence must not throw the sentence away.
    const run = start();
    sockets[0].handlers.onOpen();
    sockets[0].says("TranscriptText", "half a sen");
    run.stop();
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    await settle();
    expect(ended[0].text).toBe("half a sen");
  });

  it("says the microphone produced nothing when every sample was zero", async () => {
    // A device that opened but is not listening looks exactly like this.
    const run = start();
    source.push!(silent());
    source.push!(silent());
    run.stop();
    sockets[0].handlers.onClose();
    await settle();
    expect(ended[0].hadAudioSignal).toBe(false);
  });

  it("knows a live microphone from a dead one", async () => {
    const run = start();
    source.push!(silent());
    source.push!(loud());
    run.stop();
    sockets[0].handlers.onClose();
    await settle();
    expect(ended[0].hadAudioSignal).toBe(true);
  });
});

describe("closing", () => {
  it("asks the server to finish before ending", () => {
    const run = start();
    sockets[0].handlers.onOpen();
    run.stop();
    expect(JSON.parse(sockets[0].frames.at(-1)!)).toEqual({
      type: "CloseStream"
    });
    expect(ended).toHaveLength(0);
  });

  it("ends as soon as the server answers rather than waiting out the grace", async () => {
    const run = start();
    sockets[0].handlers.onOpen();
    run.stop();
    sockets[0].handlers.onClose();
    await settle();
    expect(ended[0].reason).toBe("user");
  });

  it("ends anyway when the server never answers", async () => {
    const run = start();
    sockets[0].handlers.onOpen();
    run.stop();
    expect(ended).toHaveLength(0);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    await settle();
    expect(ended[0].reason).toBe("user");
  });

  it("reads a close nobody asked for as a failure", async () => {
    start();
    sockets[0].handlers.onOpen();
    sockets[0].handlers.onClose();
    await settle();
    expect(ended[0]).toMatchObject({
      reason: "error",
      error: "the socket closed early"
    });
  });

  it("stops the device whatever ended it", async () => {
    start();
    sockets[0].handlers.onOpen();
    sockets[0].handlers.onError("Unexpected server response: 403");
    await settle();
    expect(source.stopped).toBe(true);
  });

  it("ends when the source runs out on its own", async () => {
    start();
    sockets[0].handlers.onOpen();
    source.exhaust();
    await settle();
    sockets[0].handlers.onClose();
    await settle();
    expect(ended[0].reason).toBe("source");
  });

  it("ends once, however many things end it", async () => {
    const run = start();
    sockets[0].handlers.onOpen();
    run.stop();
    run.stop();
    sockets[0].handlers.onClose();
    vi.advanceTimersByTime(CLOSE_GRACE_MS * 2);
    await settle();
    expect(ended).toHaveLength(1);
  });
});

describe("stopping itself", () => {
  it("gives up when the endpoint has said nothing for the silence line", async () => {
    start();
    sockets[0].handlers.onOpen();
    clock = SILENCE_STOP_MS;
    vi.advanceTimersByTime(1_000);
    sockets[0].handlers.onClose();
    await settle();
    expect(ended[0].reason).toBe("silence");
  });

  it("keeps listening while transcripts keep arriving", () => {
    start();
    sockets[0].handlers.onOpen();
    for (let at = 0; at < MAX_DURATION_MS - 1_000; at += 5_000) {
      clock = at;
      sockets[0].says("TranscriptText", `word ${at}`);
      vi.advanceTimersByTime(5_000);
    }
    expect(ended).toHaveLength(0);
  });

  it("stops at the ceiling even mid-sentence", async () => {
    start();
    sockets[0].handlers.onOpen();
    clock = MAX_DURATION_MS;
    sockets[0].says("TranscriptText", "still talking");
    vi.advanceTimersByTime(1_000);
    sockets[0].handlers.onClose();
    await settle();
    expect(ended[0].reason).toBe("max_duration");
  });
});

describe("the level meter", () => {
  it("posts no faster than the interval, whatever the frame rate", () => {
    const levels: number[] = [];
    startDictation(
      { token: "t", source, connect, now: () => clock },
      { onLevel: (l) => levels.push(l), onEnd: () => undefined }
    );
    for (let i = 0; i < 10; i++) source.push!(loud());
    expect(levels).toHaveLength(1);
    clock = 100;
    source.push!(loud());
    expect(levels).toHaveLength(2);
  });
});
