import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord } from "@/types";
import {
  addHistory,
  addHistorySafe,
  deleteHistory,
  getHistory,
  getHistoryById,
  getHistoryList,
  getHistoryWithResults,
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

  describe("getHistoryWithResults", () => {
    /** 轻量记录构造（不含 result/graph_data 内容） */
    const rec = (id: number, createdAt: string): HistoryRecord => ({
      id,
      type: "correct",
      input_text: `text-${id}`,
      result: "",
      graph_data: null,
      created_at: createdAt,
    });

    it("pairs results by record id over the two existing commands", async () => {
      // 故意让 result 数组顺序与记录列表相反：配对必须按 id，不按下标
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === "db_get_history_list") {
          return Promise.resolve([rec(1, "2026-07-01 10:00:00"), rec(2, "2026-07-02 10:00:00")]);
        }
        if (cmd === "db_get_history_results_by_type") {
          return Promise.resolve([
            { id: 2, result: '{"corrections":2}' },
            { id: 1, result: '{"corrections":1}' },
          ]);
        }
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });

      const { records, resultById } = await getHistoryWithResults(["correct", "writing"], 20);

      // 两路查询共用同一类型集与上限（保证"最新 N 条"窗口一致）
      expect(invoke).toHaveBeenCalledWith("db_get_history_list", {
        recordTypes: ["correct", "writing"],
        limit: 20,
        offset: null,
      });
      expect(invoke).toHaveBeenCalledWith("db_get_history_results_by_type", {
        recordTypes: ["correct", "writing"],
        limit: 20,
      });
      expect(records.map((r) => r.id)).toEqual([1, 2]);
      expect(resultById.get(1)).toBe('{"corrections":1}');
      expect(resultById.get(2)).toBe('{"corrections":2}');
    });

    it("normalizes a single type to an array and forwards the default limit of 100", async () => {
      vi.mocked(invoke).mockImplementation((cmd: string) =>
        cmd === "db_get_history_list" ? Promise.resolve([]) : Promise.resolve([]),
      );
      await getHistoryWithResults("exercise");
      expect(invoke).toHaveBeenCalledWith("db_get_history_list", {
        recordTypes: ["exercise"],
        limit: 100,
        offset: null,
      });
      expect(invoke).toHaveBeenCalledWith("db_get_history_results_by_type", {
        recordTypes: ["exercise"],
        limit: 100,
      });
    });

    it("applies a separate resultTypes to the results query when provided", async () => {
      // 回归：记录元数据需要包含某类型（如 reading 统计），但其重型 result 无需
      // 拉取 —— 两路查询分别使用 recordTypes 与 resultTypes，互不混用
      vi.mocked(invoke).mockImplementation((cmd: string) =>
        cmd === "db_get_history_list" ? Promise.resolve([]) : Promise.resolve([]),
      );
      await getHistoryWithResults(
        ["correct", "writing", "exercise", "listening", "speaking", "reading"],
        500,
        ["correct", "writing", "exercise", "listening", "speaking"],
      );
      expect(invoke).toHaveBeenCalledWith("db_get_history_list", {
        recordTypes: ["correct", "writing", "exercise", "listening", "speaking", "reading"],
        limit: 500,
        offset: null,
      });
      expect(invoke).toHaveBeenCalledWith("db_get_history_results_by_type", {
        recordTypes: ["correct", "writing", "exercise", "listening", "speaking"],
        limit: 500,
      });
    });

    it("defaults resultTypes to recordTypes for backward compatibility", async () => {
      vi.mocked(invoke).mockImplementation((cmd: string) =>
        cmd === "db_get_history_list" ? Promise.resolve([]) : Promise.resolve([]),
      );
      await getHistoryWithResults(["listening", "speaking"], 5);
      expect(invoke).toHaveBeenCalledWith("db_get_history_results_by_type", {
        recordTypes: ["listening", "speaking"],
        limit: 5,
      });
    });

    it("degrades fail-soft to an empty Map when the results query fails", async () => {
      // 契约：result 拉取失败只退化为空 Map，记录列表照常返回（catch-and-continue）
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === "db_get_history_list") {
          return Promise.resolve([rec(1, "2026-07-01 10:00:00")]);
        }
        return Promise.reject(new Error("results ipc failed"));
      });

      const { records, resultById } = await getHistoryWithResults(["listening"], 5);

      expect(records).toHaveLength(1);
      expect(resultById.size).toBe(0);
    });

    it("rejects when the records query itself fails", async () => {
      vi.mocked(invoke).mockImplementation((cmd: string) =>
        cmd === "db_get_history_list" ? Promise.reject(new Error("db down")) : Promise.resolve([]),
      );
      await expect(getHistoryWithResults(["exercise"], 50)).rejects.toThrow("db down");
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
