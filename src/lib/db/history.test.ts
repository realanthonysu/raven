import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addHistory,
  addHistorySafe,
  deleteHistory,
  getHistory,
  getHistoryById,
  getHistoryList,
} from "./history";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("history db functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("addHistory calls invoke and returns lastInsertId", async () => {
    vi.mocked(invoke).mockResolvedValue(42);
    const result = await addHistory({
      type: "correct",
      input_text: "test input",
      result: '{"corrected": "test"}',
    });
    expect(invoke).toHaveBeenCalledWith("db_add_history", {
      recordType: "correct",
      inputText: "test input",
      result: '{"corrected": "test"}',
      graphData: null,
    });
    expect(result).toEqual({ lastInsertId: 42 });
  });

  it("addHistorySafe returns id on success", async () => {
    vi.mocked(invoke).mockResolvedValue(10);
    const result = await addHistorySafe({
      type: "reading",
      input_text: "article",
      result: "analysis",
    });
    expect(result).toBe(10);
  });

  it("addHistorySafe returns null on error and calls onError", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("DB error"));
    const onError = vi.fn();
    const result = await addHistorySafe(
      { type: "correct", input_text: "test", result: "" },
      onError,
    );
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalled();
  });

  it("getHistory calls invoke with types", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await getHistory("correct", 10, 0);
    expect(invoke).toHaveBeenCalledWith("db_get_history", {
      recordTypes: ["correct"],
      limit: 10,
      offset: 0,
    });
  });

  it("getHistory handles array types", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await getHistory(["correct", "reading"]);
    expect(invoke).toHaveBeenCalledWith("db_get_history", {
      recordTypes: ["correct", "reading"],
      limit: null,
      offset: null,
    });
  });

  it("getHistoryList calls invoke", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await getHistoryList();
    expect(invoke).toHaveBeenCalledWith("db_get_history_list", {
      recordTypes: null,
      limit: null,
      offset: null,
    });
  });

  it("getHistoryById calls invoke with id", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const result = await getHistoryById(99);
    expect(invoke).toHaveBeenCalledWith("db_get_history_by_id", { id: 99 });
    expect(result).toBeNull();
  });

  it("deleteHistory calls invoke with id", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await deleteHistory(7);
    expect(invoke).toHaveBeenCalledWith("db_delete_history", { id: 7 });
  });
});
