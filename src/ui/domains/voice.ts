// ─────────────────────────────────────────────────────────────
// Dictation, from the panel's side.
//
// Three things happen here that cannot happen anywhere else: the credential is
// read, a capture backend is found, and the result is posted to a webview that
// must never see the first of those. The webview asks to start and to stop; it
// receives text, a level and — when there is one — a reason it cannot.
//
// Everything else is `services/voice/`, which needs neither a window nor this
// file to be tested.
// ─────────────────────────────────────────────────────────────

import { noBackendMessage } from "../../core/voice/backends.js";
import { resolveOAuthToken } from "../../services/oauth-usage.js";
import { readSetting } from "../../services/claude-settings.js";
import {
  startDictation,
  type Dictation,
  type DictationOutcome
} from "../../services/voice/dictation.js";
import { connectVoiceSocket } from "../../services/voice/socket.js";
import {
  SubprocessAudioSource,
  findCaptureCommand
} from "../../services/voice/subprocess-source.js";

export interface VoicePost {
  (message: VoiceMessageOut): void;
}

export type VoiceMessageOut =
  | {
      type: "voice";
      phase: "listening" | "idle";
      committed: string;
      interim: string;
      error?: string;
    }
  | { type: "voiceLevel"; level: number };

export interface VoiceContext {
  post: VoicePost;
  /** Where the extension is installed — the shipped recorder lives under it. */
  extensionPath: string;
  /** The words this window is likely to be dictated about. */
  keyterms?: readonly string[];
  workspaceRoot?: string;
}

export class VoiceSession {
  private running: Dictation | null = null;

  constructor(private readonly ctx: VoiceContext) {}

  get active(): boolean {
    return this.running !== null;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const token = await resolveOAuthToken();
    if (!token)
      return this.fail(
        "Dictation runs on your Claude subscription — sign in to Claude Code first."
      );

    const capture = await findCaptureCommand(this.ctx.extensionPath);
    if (!capture)
      return this.fail(noBackendMessage(process.platform, process.arch));

    // Read at the start of each dictation rather than cached: a user who sets
    // their language does not expect to reload the window for it.
    const language = readSetting("language", this.ctx.workspaceRoot);

    this.running = startDictation(
      {
        token,
        source: new SubprocessAudioSource(capture),
        connect: connectVoiceSocket,
        language: typeof language === "string" ? language : undefined,
        keyterms: this.ctx.keyterms
      },
      {
        onTranscript: (state) =>
          this.ctx.post({
            type: "voice",
            phase: "listening",
            committed: state.committed,
            interim: state.interim
          }),
        onLevel: (level) => this.ctx.post({ type: "voiceLevel", level }),
        onEnd: (outcome) => {
          this.running = null;
          this.ctx.post({
            type: "voice",
            phase: "idle",
            committed: outcome.text,
            interim: "",
            ...(this.reasonFor(outcome)
              ? { error: this.reasonFor(outcome) }
              : {})
          });
        }
      }
    );

    this.ctx.post({
      type: "voice",
      phase: "listening",
      committed: "",
      interim: ""
    });
  }

  stop(): void {
    this.running?.stop();
  }

  /** Only failures the user can do something about reach the panel. Running
   *  out of a file or hitting the ceiling is not one. */
  private reasonFor(outcome: DictationOutcome): string | undefined {
    if (outcome.error) return outcome.error;
    if (outcome.reason === "max_duration" && !outcome.text)
      return "Stopped at two minutes.";
    if (!outcome.hadAudioSignal && !outcome.text)
      return "No audio reached the microphone — check the input device selected in system settings.";
    return undefined;
  }

  private fail(error: string): void {
    this.ctx.post({
      type: "voice",
      phase: "idle",
      committed: "",
      interim: "",
      error
    });
  }
}
