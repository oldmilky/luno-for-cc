import { describe, it, expect } from "vitest";
import {
  DEFAULT_VOICE_LANGUAGE,
  voiceLanguage
} from "../../src/core/voice/language.js";

describe("which language the microphone listens for", () => {
  it("follows Claude's setting when the extension has no opinion", () => {
    expect(voiceLanguage({ configured: "auto", claude: "ru" })).toBe("ru");
    expect(voiceLanguage({ claude: "ru" })).toBe("ru");
  });

  it("lets the extension setting win, which is the whole reason it exists", () => {
    // Reading answers in English while speaking Russian is a real pairing and
    // Claude's single `language` key cannot express it.
    expect(voiceLanguage({ configured: "ru", claude: "en" })).toBe("ru");
  });

  it("reads Claude's value tolerantly — it is a file we do not own", () => {
    expect(voiceLanguage({ claude: "ru-RU" })).toBe("ru");
    expect(voiceLanguage({ claude: "RU" })).toBe("ru");
    expect(voiceLanguage({ claude: "ru_RU" })).toBe("ru");
    expect(voiceLanguage({ claude: " ru " })).toBe("ru");
  });

  it("falls back to English rather than putting nonsense on the wire", () => {
    // MEASURED: a value the endpoint rejects closes the socket, which the user
    // would see as dictation being broken.
    expect(voiceLanguage({ claude: "Русский" })).toBe(DEFAULT_VOICE_LANGUAGE);
    expect(voiceLanguage({ claude: "multi" })).toBe(DEFAULT_VOICE_LANGUAGE);
    expect(voiceLanguage({ claude: 42 })).toBe(DEFAULT_VOICE_LANGUAGE);
    expect(voiceLanguage({})).toBe(DEFAULT_VOICE_LANGUAGE);
  });

  it("treats an untouched setting as absence, not as a language", () => {
    expect(voiceLanguage({ configured: "auto" })).toBe(DEFAULT_VOICE_LANGUAGE);
    expect(voiceLanguage({ configured: "  ", claude: "de" })).toBe("de");
  });
});
