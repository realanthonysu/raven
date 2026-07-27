import { describe, expect, it } from "vitest";
import { MIMO_VOICES, VOICE_INITIAL_STATE, type VoiceState, voiceReducer } from "./voice-reducer";

const savedFixture: VoiceState["saved"] = {
  base_url: "https://api.example.com",
  api_key: "sk-test-123",
  tts_model: "tts-1",
  voice: "alloy",
  speed: 1.0,
  asr_model: "mimo-v2.5-asr",
};

describe("voiceReducer", () => {
  describe("SET_FORM", () => {
    it("merges form patch into current form", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, {
        type: "SET_FORM",
        patch: { apiKey: "new-key", speed: "1.5" },
      });
      expect(state.form.apiKey).toBe("new-key");
      expect(state.form.speed).toBe("1.5");
      // Other fields unchanged
      expect(state.form.baseUrl).toBe(VOICE_INITIAL_STATE.form.baseUrl);
    });

    it("does not mutate the original form object", () => {
      const original = VOICE_INITIAL_STATE.form;
      voiceReducer(VOICE_INITIAL_STATE, { type: "SET_FORM", patch: { voice: "nova" } });
      expect(original.voice).toBe("alloy");
    });
  });

  describe("SET_EDITING", () => {
    it("sets editing to true", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "SET_EDITING", editing: true });
      expect(state.editing).toBe(true);
    });

    it("sets editing to false", () => {
      const base: VoiceState = { ...VOICE_INITIAL_STATE, editing: true };
      const state = voiceReducer(base, { type: "SET_EDITING", editing: false });
      expect(state.editing).toBe(false);
    });
  });

  describe("SET_SAVED", () => {
    it("sets the saved config snapshot", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "SET_SAVED", saved: savedFixture });
      expect(state.saved).toBe(savedFixture);
    });

    it("can set saved to null", () => {
      const base: VoiceState = { ...VOICE_INITIAL_STATE, saved: savedFixture };
      const state = voiceReducer(base, { type: "SET_SAVED", saved: null });
      expect(state.saved).toBeNull();
    });
  });

  describe("SET_HAS_API_KEY", () => {
    it("sets hasApiKey", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "SET_HAS_API_KEY", hasApiKey: true });
      expect(state.hasApiKey).toBe(true);
    });
  });

  describe("SET_API_KEY_DIRTY", () => {
    it("sets apiKeyDirty", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "SET_API_KEY_DIRTY", dirty: true });
      expect(state.apiKeyDirty).toBe(true);
    });
  });

  describe("SET_TTS_TESTING", () => {
    it("sets ttsTesting", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "SET_TTS_TESTING", testing: true });
      expect(state.ttsTesting).toBe(true);
    });
  });

  describe("SET_TTS_TEST_ERROR", () => {
    it("sets ttsTestError", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, {
        type: "SET_TTS_TEST_ERROR",
        error: "TTS failed",
      });
      expect(state.ttsTestError).toBe("TTS failed");
    });

    it("clears ttsTestError with null", () => {
      const base: VoiceState = { ...VOICE_INITIAL_STATE, ttsTestError: "old error" };
      const state = voiceReducer(base, { type: "SET_TTS_TEST_ERROR", error: null });
      expect(state.ttsTestError).toBeNull();
    });
  });

  describe("SET_ASR_TESTING", () => {
    it("sets asrTesting", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "SET_ASR_TESTING", testing: true });
      expect(state.asrTesting).toBe(true);
    });
  });

  describe("SET_ASR_TEST_RESULT", () => {
    it("sets asrTestResult", () => {
      const result = { type: "ok" as const, text: "Hello world" };
      const state = voiceReducer(VOICE_INITIAL_STATE, {
        type: "SET_ASR_TEST_RESULT",
        result,
      });
      expect(state.asrTestResult).toEqual(result);
    });

    it("clears asrTestResult with null", () => {
      const base: VoiceState = {
        ...VOICE_INITIAL_STATE,
        asrTestResult: { type: "err", text: "fail" },
      };
      const state = voiceReducer(base, { type: "SET_ASR_TEST_RESULT", result: null });
      expect(state.asrTestResult).toBeNull();
    });
  });

  describe("SET_SAVE_MSG", () => {
    it("sets save message", () => {
      const msg = { type: "ok" as const, text: "保存成功" };
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "SET_SAVE_MSG", msg });
      expect(state.saveMsg).toEqual(msg);
    });
  });

  describe("RESET_FORM_TO_SAVED", () => {
    it("restores form from saved config and exits editing mode", () => {
      const base: VoiceState = {
        ...VOICE_INITIAL_STATE,
        form: {
          baseUrl: "changed",
          apiKey: "changed",
          ttsModel: "changed",
          voice: "changed",
          speed: "2.0",
          asrModel: "changed",
        },
        saved: savedFixture,
        editing: true,
        apiKeyDirty: true,
      };
      const state = voiceReducer(base, { type: "RESET_FORM_TO_SAVED" });
      expect(state.form.baseUrl).toBe(savedFixture.base_url);
      expect(state.form.apiKey).toBe(""); // API Key not restored from saved
      expect(state.form.ttsModel).toBe(savedFixture.tts_model);
      expect(state.form.voice).toBe(savedFixture.voice);
      expect(state.form.speed).toBe(String(savedFixture.speed));
      expect(state.form.asrModel).toBe(savedFixture.asr_model);
      expect(state.editing).toBe(false);
      expect(state.apiKeyDirty).toBe(false);
    });

    it("returns same state when saved is null", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "RESET_FORM_TO_SAVED" });
      expect(state).toBe(VOICE_INITIAL_STATE);
    });
  });

  describe("LOAD", () => {
    it("sets form, saved, and hasApiKey from loaded config", () => {
      const form: VoiceState["form"] = {
        baseUrl: "https://loaded.com",
        apiKey: "loaded-key",
        ttsModel: "mimo-v2.5-tts",
        voice: "冰糖",
        speed: "1.25",
        asrModel: "mimo-v2.5-asr",
      };
      const state = voiceReducer(VOICE_INITIAL_STATE, {
        type: "LOAD",
        form,
        saved: savedFixture,
        hasApiKey: true,
      });
      expect(state.form).toBe(form);
      expect(state.saved).toBe(savedFixture);
      expect(state.hasApiKey).toBe(true);
    });
  });

  describe("default case", () => {
    it("returns same state reference for unknown actions", () => {
      const state = voiceReducer(VOICE_INITIAL_STATE, { type: "UNKNOWN" } as never);
      expect(state).toBe(VOICE_INITIAL_STATE);
    });
  });
});

describe("MIMO_VOICES", () => {
  it("contains8 voice options", () => {
    expect(MIMO_VOICES).toHaveLength(8);
  });

  it("each voice has value and label", () => {
    for (const voice of MIMO_VOICES) {
      expect(voice.value).toBeTruthy();
      expect(voice.label).toBeTruthy();
    }
  });
});
