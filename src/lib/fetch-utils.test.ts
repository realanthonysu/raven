import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * smartFetch test suite.
 *
 * Tests the dual-channel fetch strategy: Tauri HTTP plugin first,
 * WebView fetch fallback when the plugin is unavailable.
 * Other errors (network, DNS) should be rethrown without fallback.
 */

// Mock @tauri-apps/plugin-http
const mockTauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mockTauriFetch(...args),
}));

// We need to import after mock setup
const { smartFetch } = await import("./fetch-utils");

describe("smartFetch", () => {
  const testUrl = "https://api.example.com/test";
  const mockResponse = new Response("ok", { status: 200 });
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Tauri fetch success", () => {
    it("returns Tauri fetch response when plugin is available", async () => {
      mockTauriFetch.mockResolvedValue(mockResponse);

      const result = await smartFetch(testUrl);
      expect(result).toBe(mockResponse);
      expect(mockTauriFetch).toHaveBeenCalledWith(testUrl, undefined);
    });

    it("passes RequestInit to Tauri fetch", async () => {
      mockTauriFetch.mockResolvedValue(mockResponse);
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"test":true}',
      };

      await smartFetch(testUrl, init);
      expect(mockTauriFetch).toHaveBeenCalledWith(testUrl, init);
    });
  });

  describe("Tauri fetch fallback (plugin unavailable)", () => {
    const pluginErrors = [
      "plugin not registered",
      "plugin not loaded",
      "__TAURI__ is not defined",
      "plugin not found",
    ];

    for (const errMsg of pluginErrors) {
      it(`falls back to WebView fetch when Tauri throws "${errMsg}"`, async () => {
        mockTauriFetch.mockRejectedValue(new Error(errMsg));
        const webResponse = new Response("fallback", { status: 200 });
        globalThis.fetch = vi.fn().mockResolvedValue(webResponse);

        const result = await smartFetch(testUrl);
        expect(result).toBe(webResponse);
        expect(globalThis.fetch).toHaveBeenCalledWith(testUrl, undefined);
      });
    }

    it("falls back when Tauri throws a non-Error with plugin message", async () => {
      mockTauriFetch.mockRejectedValue("plugin not registered error");
      const webResponse = new Response("fallback", { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(webResponse);

      const result = await smartFetch(testUrl);
      expect(result).toBe(webResponse);
    });

    it("passes RequestInit to WebView fetch during fallback", async () => {
      mockTauriFetch.mockRejectedValue(new Error("__TAURI__ is not defined"));
      const webResponse = new Response("fallback", { status: 200 });
      globalThis.fetch = vi.fn().mockResolvedValue(webResponse);

      const init: RequestInit = { method: "PUT", body: "data" };
      await smartFetch(testUrl, init);
      expect(globalThis.fetch).toHaveBeenCalledWith(testUrl, init);
    });
  });

  describe("non-plugin errors are rethrown", () => {
    it("rethrows network errors without falling back", async () => {
      const networkError = new Error("Network request failed");
      mockTauriFetch.mockRejectedValue(networkError);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("should not reach"));

      await expect(smartFetch(testUrl)).rejects.toThrow("Network request failed");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rethrows DNS resolution errors", async () => {
      const dnsError = new Error("DNS resolution failed");
      mockTauriFetch.mockRejectedValue(dnsError);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("should not reach"));

      await expect(smartFetch(testUrl)).rejects.toThrow("DNS resolution failed");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rethrows HTTP status errors", async () => {
      const statusError = new Error("HTTP 500 Internal Server Error");
      mockTauriFetch.mockRejectedValue(statusError);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("should not reach"));

      await expect(smartFetch(testUrl)).rejects.toThrow("HTTP 500");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rethrows non-Error values that don't match plugin patterns", async () => {
      mockTauriFetch.mockRejectedValue("some random error");
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("should not reach"));

      await expect(smartFetch(testUrl)).rejects.toBe("some random error");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});
