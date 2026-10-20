import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LEVEL } from "@/lib/levels";
import {
  getPlacementResult,
  getProficiencyLevel,
  getSetting,
  setPlacementResult,
  setProficiencyLevel,
  setSetting,
} from "./settings";

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

/**
 * 类型化封装（proficiency_level / placement_result）测试套件。
 *
 * 四个封装是设置键的唯一读写入口（经 db barrel 导出），各自带 fail-soft 语义：
 * - getProficiencyLevel：未设置/值非法/读取失败 → DEFAULT_LEVEL
 * - getPlacementResult：未测试/JSON 损坏/结构不符/读取失败 → null
 * 断言统一落在 invoke 的调用形态上（键名与值的序列化形态）。
 */
describe("settings typed wrappers", () => {
  beforeEach(() => {
    // 本 describe 需自行清理调用历史：invoke 是模块级共享 mock，
    // 上一个 describe 的 beforeEach 不会作用到这里
    vi.clearAllMocks();
  });

  /** 合法的定级测试结果（字段契约见 PlacementResultSchema） */
  const validResult = {
    tested_at: "2026-10-20T08:00:00.000Z",
    estimated_level: "B2+",
    per_band: { A2: 1, B1: 1, "B1+": 1, B2: 0.5, "B2+": 0, C1: 0 },
    question_count: 12,
    total_correct: 9,
  };

  describe("getProficiencyLevel", () => {
    it("返回 settings 中的合法级别码", async () => {
      vi.mocked(invoke).mockResolvedValue("B2+");
      await expect(getProficiencyLevel()).resolves.toBe("B2+");
      expect(invoke).toHaveBeenCalledWith("db_get_setting", { key: "proficiency_level" });
    });

    it("未设置（null）时返回 DEFAULT_LEVEL", async () => {
      vi.mocked(invoke).mockResolvedValue(null);
      await expect(getProficiencyLevel()).resolves.toBe(DEFAULT_LEVEL);
    });

    it("值非法时返回 DEFAULT_LEVEL（isLevelCode 兜底）", async () => {
      vi.mocked(invoke).mockResolvedValue("Z9");
      await expect(getProficiencyLevel()).resolves.toBe(DEFAULT_LEVEL);
    });

    it("invoke reject 时 fail-soft 返回 DEFAULT_LEVEL", async () => {
      // 设置读取异常不应阻塞练习页面的 prompt 构建
      vi.mocked(invoke).mockRejectedValue(new Error("db down"));
      await expect(getProficiencyLevel()).resolves.toBe(DEFAULT_LEVEL);
    });
  });

  describe("setProficiencyLevel", () => {
    it("以 proficiency_level 键调用 db_set_setting", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      await setProficiencyLevel("C1");
      expect(invoke).toHaveBeenCalledWith("db_set_setting", {
        key: "proficiency_level",
        value: "C1",
      });
    });
  });

  describe("getPlacementResult", () => {
    it("合法 JSON 返回解析后的对象", async () => {
      vi.mocked(invoke).mockResolvedValue(JSON.stringify(validResult));
      await expect(getPlacementResult()).resolves.toEqual(validResult);
    });

    it("JSON 损坏时返回 null", async () => {
      vi.mocked(invoke).mockResolvedValue("not json at all");
      await expect(getPlacementResult()).resolves.toBeNull();
    });

    it("结构不符（合法 JSON 但字段缺失/类型错误）时返回 null", async () => {
      // PlacementResultSchema 校验不通过 → extractJsonSafe 返回 null
      vi.mocked(invoke).mockResolvedValue(JSON.stringify({ tested_at: "x", extra: 1 }));
      await expect(getPlacementResult()).resolves.toBeNull();
    });

    it("未测试（null）时返回 null", async () => {
      vi.mocked(invoke).mockResolvedValue(null);
      await expect(getPlacementResult()).resolves.toBeNull();
    });

    it("invoke reject 时 fail-soft 返回 null", async () => {
      // 旧版本数据或手改 settings 不应阻塞设置页渲染
      vi.mocked(invoke).mockRejectedValue(new Error("db down"));
      await expect(getPlacementResult()).resolves.toBeNull();
    });
  });

  describe("setPlacementResult", () => {
    it("以 placement_result 键写入 JSON 字符串（整体替换，只保留最新一次）", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      await setPlacementResult(validResult);

      expect(invoke).toHaveBeenCalledWith("db_set_setting", {
        key: "placement_result",
        value: JSON.stringify(validResult),
      });
      // value 必须是可解析回原对象的 JSON 字符串（而非 "[object Object]"）
      const args = vi.mocked(invoke).mock.calls[0][1] as { value: string };
      expect(JSON.parse(args.value)).toEqual(validResult);
    });
  });
});
