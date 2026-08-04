/** Dictation as the composer sees it. One object because the strip renders
 *  all of it at once, and a half-updated pair would flicker. */
export interface VoiceState {
  listening: boolean;
  committed: string;
  interim: string;
  error?: string;
  /** What the host is listening for, e.g. "ru". */
  language?: string;
  /** 0…1. Zero whenever nothing is listening, so the meter rests flat. */
  level: number;
}

export const IDLE_VOICE: VoiceState = {
  listening: false,
  committed: "",
  interim: "",
  level: 0
};
