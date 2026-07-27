import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getASRModel,
  getTTSConfig,
  getTTSConfigCached,
  invalidateTTSConfigCache,
  setASRModel,
  setTTSSettingBatch,
} from "./tts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

describe("tts db functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateTTSConfigCache();
  });

  it("getTTSConfig maps DTO correctly", async () => {
    vi.mocked(invoke).mockResolvedValue({
      base_url: "https://api.example.com",
      api_key: "sk-test",
      model: "tts-1",
      voice: "alloy",
      speed: 1.0,
    });
    const result = await getTTSConfig();
    expect(result).toEqual({
      base_url: "https://api.example.com",
      api_key: "sk-test",
      model: "tts-1",
      voice: "alloy",
      speed: 1.0,
    });
  });

  it("getTTSConfigCached caches result", async () => {
    vi.mocked(invoke).mockResolvedValue({
      base_url: "https://api.example.com",
      api_key: "sk-test",
      model: "tts-1",
      voice: "alloy",
      speed: 1.0,
    });
    await getTTSConfigCached();
    await getTTSConfigCached();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("invalidateTTSConfigCache clears cache", async () => {
    vi.mocked(invoke).mockResolvedValue({
      base_url: "url1",
      api_key: "key1",
      model: "m1",
      voice: "v1",
      speed: 1.0,
    });
    await getTTSConfigCached();
    invalidateTTSConfigCache();
    await getTTSConfigCached();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("setTTSSettingBatch writes all entries", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await setTTSSettingBatch([
      ["tts_model", "tts-1"],
      ["tts_voice", "alloy"],
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("getASRModel returns default when setting is null", async () => {
    const { getSetting } = await import("./settings");
    vi.mocked(getSetting).mockResolvedValue(null);
    const result = await getASRModel();
    expect(result).toBe("mimo-v2.5-asr");
  });

  it("getASRModel returns saved setting", async () => {
    const { getSetting } = await import("./settings");
    vi.mocked(getSetting).mockResolvedValue("custom-asr");
    const result = await getASRModel();
    expect(result).toBe("custom-asr");
  });

  it("setASRModel saves setting", async () => {
    const { setSetting } = await import("./settings");
    vi.mocked(setSetting).mockResolvedValue(undefined);
    await setASRModel("new-asr-model");
    expect(setSetting).toHaveBeenCalledWith("asr_model", "new-asr-model");
  });
});
