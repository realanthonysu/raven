import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "./settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("settings db functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getSetting calls invoke with key", async () => {
    vi.mocked(invoke).mockResolvedValue("dark");
    const result = await getSetting("theme");
    expect(invoke).toHaveBeenCalledWith("db_get_setting", { key: "theme" });
    expect(result).toBe("dark");
  });

  it("getSetting returns null when not found", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const result = await getSetting("nonexistent");
    expect(result).toBeNull();
  });

  it("setSetting calls invoke with key and value", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await setSetting("theme", "light");
    expect(invoke).toHaveBeenCalledWith("db_set_setting", { key: "theme", value: "light" });
  });
});
