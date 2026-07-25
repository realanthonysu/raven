import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fetch-utils
vi.mock("@/lib/fetch-utils", () => ({
  smartFetch: vi.fn(),
  withTimeout: vi.fn(() => ({
    signal: new AbortController().signal,
    isTimeout: () => false,
    cleanup: vi.fn(),
  })),
}));

// Mock @tauri-apps/plugin-http
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import { smartFetch } from "@/lib/fetch-utils";
import { fetchTTSAudio } from "./tts";

const mockConfig = {
  base_url: "https://api.example.com/v1",
  api_key: "test-key",
  model: "tts-1",
  voice: "alloy",
  speed: 1.0,
};

describe("fetchTTSAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls smartFetch with correct URL and headers", async () => {
    const mockArrayBuffer = new ArrayBuffer(8);
    vi.mocked(smartFetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(mockArrayBuffer),
    } as Response);

    await fetchTTSAudio("hello", mockConfig);

    expect(smartFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("returns ArrayBuffer on success", async () => {
    const mockArrayBuffer = new ArrayBuffer(8);
    vi.mocked(smartFetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(mockArrayBuffer),
    } as Response);

    const result = await fetchTTSAudio("hello", mockConfig);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(8);
  });

  it("throws on non-ok response", async () => {
    vi.mocked(smartFetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    await expect(fetchTTSAudio("hello", mockConfig)).rejects.toThrow("TTS 请求失败: 500");
  });

  it("uses chat/completions endpoint when base_url ends with /chat/completions", async () => {
    const chatConfig = {
      ...mockConfig,
      base_url: "https://api.example.com/v1/chat/completions",
    };
    // Chat/completions mode returns JSON with audio data
    vi.mocked(smartFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { audio: { data: btoa("test-audio-data") } } }],
        }),
    } as Response);

    await fetchTTSAudio("hello", chatConfig);

    expect(smartFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("includes speed in request body for standard endpoint", async () => {
    const mockArrayBuffer = new ArrayBuffer(4);
    vi.mocked(smartFetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(mockArrayBuffer),
    } as Response);

    await fetchTTSAudio("hello", mockConfig);

    const callArgs = vi.mocked(smartFetch).mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    expect(body.speed).toBe(1.0);
    expect(body.input).toBe("hello");
    expect(body.model).toBe("tts-1");
    expect(body.voice).toBe("alloy");
  });
});
