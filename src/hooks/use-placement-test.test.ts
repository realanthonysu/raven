/**
 * usePlacementTest hook tests（Track A：AI 定级测试）。
 *
 * Mock @/lib/db（共享 fake createDbMock：getDefaultModelCached + 全局级别
 * store 的水合/持久化通道 setProficiencyLevel + 持久化落点 setPlacementResult）
 * 与 @/services/llm（buildPrompt/streamChatAsync）。
 * 覆盖：生成解析、宽松信封逐题剔除、无效题过滤、未配置模型错误、
 * 解析失败重试、计分→持久化、提交竞态（连点只落库一次 / reset 作废
 * 迟到提交）、saveError 与 retrySave、applyResult、以及在途请求的
 * reset/中止语义。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_NOT_CONFIGURED_MESSAGE } from "@/hooks/use-stream-chat";
import { getDefaultModelCached, setPlacementResult, setProficiencyLevel } from "@/lib/db";
import type { PlacementScore } from "@/lib/level-estimation";
import { LEVEL_CODES } from "@/lib/levels";
import { PLACEMENT_PROMPT } from "@/prompts";
import type { ModelConfig } from "@/types";
import { usePlacementTest } from "./use-placement-test";

const mockStreamChatAsync = vi.fn();

vi.mock("@/services/llm", () => ({
  buildPrompt: (system: string, user: string) => [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  streamChat: vi.fn(),
  streamChatAsync: (...args: unknown[]) => mockStreamChatAsync(...args),
}));

// DB 层整体 mock：共享 fake（src/test/db-mock.ts）统一覆盖 barrel 全部导出。
// 此前分两条路径（@/lib/db 的 importOriginal 部分替换 + @/lib/db/settings 整体
// mock），hook 与测试分别从 barrel 和深路径断言同一批函数；收敛后断言统一
// 落在 barrel 导出上（use-placement-test / use-proficiency-level 亦只消费 barrel）
vi.mock("@/lib/db", async () => {
  const { createDbMock } = await import("@/test/db-mock");
  return createDbMock();
});

const MODEL: ModelConfig = {
  id: 1,
  name: "test-model",
  api_key: "sk-test-key",
  base_url: "https://api.openai.com/v1",
  model_name: "gpt-4o-mini",
  is_default: true,
};

/** 单道合法题（4 选项，answer 与选项一致，band 合法） */
function question(band: string, answer = "alpha") {
  return {
    question: `Question for ${band}`,
    options: ["alpha", "beta", "gamma", "delta"],
    answer,
    band,
    focus: "考点",
  };
}

/** 12 道合法题的 JSON 信封（6 档 × 2，档序与 LEVEL_CODES 一致） */
function questionsJson(): string {
  const questions = LEVEL_CODES.flatMap((band) => [question(band), question(band)]);
  return JSON.stringify({ questions });
}

/** AbortError（与 use-graph-data.test.ts 同款构造） */
function abortError(): Error {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

describe("usePlacementTest", () => {
  beforeEach(() => {
    // resetAllMocks：mockClear 不清除 mockImplementationOnce 队列，
    // 失败用例残留的一次性实现会污染后续用例
    vi.resetAllMocks();
    vi.mocked(getDefaultModelCached).mockResolvedValue(MODEL);
    vi.mocked(setProficiencyLevel).mockResolvedValue(undefined);
    vi.mocked(setPlacementResult).mockResolvedValue(undefined);
  });

  // ── 生成路径 ──────────────────────────────────────────────────────

  it("generates and parses 12 valid questions with empty answers", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    const { result } = renderHook(() => usePlacementTest());

    let ok = false;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(true);
    expect(result.current.questions).toHaveLength(12);
    expect(result.current.answers).toEqual(Array.from({ length: 12 }, () => null));
    expect(result.current.generating).toBe(false);
    expect(result.current.error).toBeNull();

    // 请求形态：system=PLACEMENT_PROMPT、带 model/signal/超时
    const [messages, model, signal, timeout] = mockStreamChatAsync.mock.calls[0];
    expect(messages).toEqual([
      { role: "system", content: PLACEMENT_PROMPT },
      { role: "user", content: "请生成 12 道定级测试单选题。" },
    ]);
    expect(model).toBe(MODEL);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toBe(180_000);
  });

  it("filters out invalid questions (bad band / wrong option count / answer mismatch)", async () => {
    const questions = [
      question("A2"),
      question("A2"),
      // band 非法 → 剔除
      { ...question("C2"), band: "C2" },
      question("B1"),
      // 选项数 ≠ 4 → 剔除
      { ...question("B1"), options: ["alpha", "beta", "gamma"] },
      question("B1+"),
      // answer 不在选项中 → 剔除
      { ...question("B1+"), answer: "epsilon" },
      question("B2"),
      question("B2+"),
      question("C1"),
    ];
    mockStreamChatAsync.mockResolvedValueOnce(JSON.stringify({ questions }));

    const { result } = renderHook(() => usePlacementTest());

    let ok = false;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(true);
    expect(result.current.questions).toHaveLength(7);
    expect(result.current.answers).toEqual(Array.from({ length: 7 }, () => null));
    expect(result.current.error).toBeNull();
  });

  it("reports the canonical not-configured error when no model exists", async () => {
    vi.mocked(getDefaultModelCached).mockResolvedValue(null);

    const { result } = renderHook(() => usePlacementTest());

    let ok = true;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe(MODEL_NOT_CONFIGURED_MESSAGE);
    expect(result.current.generating).toBe(false);
    expect(mockStreamChatAsync).not.toHaveBeenCalled();
  });

  it("reports a retryable error and clears generating when the model preflight rejects", async () => {
    // getDefaultModelCached 底层是 invoke("db_get_default_model")，可能 reject。
    // 预检若在 try 之外：reject 跳过 finally → generating 永不复位（对话框
    // 永久卡在加载态），且成为 unhandled rejection。act 内 await 正常捕获。
    vi.mocked(getDefaultModelCached).mockRejectedValueOnce(new Error("db down"));

    const { result } = renderHook(() => usePlacementTest());

    let ok = true;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(false);
    expect(result.current.error).toContain("读取模型配置失败");
    expect(result.current.generating).toBe(false);
    expect(mockStreamChatAsync).not.toHaveBeenCalled();
  });

  it("reports a retryable error when the LLM output is not valid JSON", async () => {
    mockStreamChatAsync.mockResolvedValueOnce("这不是 JSON");

    const { result } = renderHook(() => usePlacementTest());

    let ok = true;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe("未能生成有效的测试题，请重试。");
    expect(result.current.questions).toHaveLength(0);
    expect(result.current.generating).toBe(false);
  });

  it("reports a retryable error when the questions list is empty", async () => {
    // 宽松信封接受空数组（不再靠 nonempty 拦），逐题过滤后无可用题 → 重试
    mockStreamChatAsync.mockResolvedValueOnce(JSON.stringify({ questions: [] }));

    const { result } = renderHook(() => usePlacementTest());

    let ok = true;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe("未能生成有效的测试题，请重试。");
  });

  // ── 宽松信封：单题结构非法只剔除该题（all-or-nothing 修复回归） ──

  it("keeps the remaining questions when one question's answer is not a string", async () => {
    // 宽松信封 + 逐题 safeParse：第 3 题 answer 为数字仅剔除该题；
    // 严格信封会让整批解析失败 → 0 题可用 → 误报"重试"
    const questions: unknown[] = LEVEL_CODES.flatMap((band) => [question(band), question(band)]);
    questions[2] = { ...question("B1"), answer: 42 };
    mockStreamChatAsync.mockResolvedValueOnce(JSON.stringify({ questions }));

    const { result } = renderHook(() => usePlacementTest());

    let ok = false;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(true);
    expect(result.current.questions).toHaveLength(11);
    expect(result.current.answers).toHaveLength(11);
    expect(result.current.error).toBeNull();
  });

  it("keeps the remaining questions when one question's options is not an array", async () => {
    const questions: unknown[] = LEVEL_CODES.flatMap((band) => [question(band), question(band)]);
    questions[5] = { ...question("B2"), options: "alpha" };
    mockStreamChatAsync.mockResolvedValueOnce(JSON.stringify({ questions }));

    const { result } = renderHook(() => usePlacementTest());

    let ok = false;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(true);
    expect(result.current.questions).toHaveLength(11);
    expect(result.current.error).toBeNull();
  });

  it("reports a retryable error when every question is structurally invalid", async () => {
    const questions: unknown[] = LEVEL_CODES.flatMap((band) => [
      { ...question(band), answer: 42 },
      { ...question(band), answer: 42 },
    ]);
    mockStreamChatAsync.mockResolvedValueOnce(JSON.stringify({ questions }));

    const { result } = renderHook(() => usePlacementTest());

    let ok = true;
    await act(async () => {
      ok = await result.current.generate();
    });

    expect(ok).toBe(false);
    expect(result.current.questions).toHaveLength(0);
    expect(result.current.error).toBe("未能生成有效的测试题，请重试。");
  });

  // ── 计分与持久化 ──────────────────────────────────────────────────

  it("scores answers, persists the placement result and exposes the score", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    const { result } = renderHook(() => usePlacementTest());
    await act(async () => {
      await result.current.generate();
    });

    // 题序：A2×2、B1×2、B1+×2、B2×2、B2+×2、C1×2。
    // 前 7 题答对（含 B2 第一题），其余未答（按错误处理）
    act(() => {
      for (let i = 0; i < 7; i++) result.current.setAnswer(i, "alpha");
    });

    // 用对象包一层：闭包内赋值不受 TS 控制流窄化限制（let x = null 会被
    // 窄化为 null，闭包内赋值不会解除窄化，导致 x?.field 被推断为 never）
    const captured: { score: PlacementScore | null } = { score: null };
    await act(async () => {
      captured.score = await result.current.submit();
    });

    // 累计正确率：2/2→A2，4/4→B1，6/6→B1+，7/8→B2，7/10→B2+，7/12<0.6 止步
    expect(captured.score?.estimated).toBe("B2+");
    expect(captured.score?.totalCorrect).toBe(7);
    expect(captured.score?.totalCount).toBe(12);
    expect(result.current.score?.estimated).toBe("B2+");

    expect(setPlacementResult).toHaveBeenCalledWith({
      tested_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      estimated_level: "B2+",
      per_band: { A2: 1, B1: 1, "B1+": 1, B2: 0.5, "B2+": 0, C1: 0 },
      question_count: 12,
      total_correct: 7,
    });
  });

  it("skips persistence when submitting without questions", async () => {
    const { result } = renderHook(() => usePlacementTest());

    let score: PlacementScore | null = null;
    await act(async () => {
      score = await result.current.submit();
    });

    expect(score).toBeNull();
    expect(setPlacementResult).not.toHaveBeenCalled();
  });

  it("persists only once when submit is invoked again while in flight", async () => {
    // 连点提交：第二次调用被 in-flight 守卫拦下，只落库一次
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    const { result } = renderHook(() => usePlacementTest());
    await act(async () => {
      await result.current.generate();
    });
    act(() => {
      for (let i = 0; i < 7; i++) result.current.setAnswer(i, "alpha");
    });

    // 慢速持久化：手动 resolve，保证第一次 submit 在途时发起第二次
    let resolveSave!: () => void;
    vi.mocked(setPlacementResult).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = () => resolve();
        }),
    );

    await act(async () => {
      const first = result.current.submit();
      const second = result.current.submit();
      expect(await second).toBeNull();
      resolveSave();
      await first;
    });

    expect(setPlacementResult).toHaveBeenCalledTimes(1);
    expect(result.current.score?.estimated).toBe("B2+");
    expect(result.current.submitting).toBe(false);
  });

  it("discards a submit still in flight when reset happens", async () => {
    // 关闭对话框（reset）期间 submit 迟到：不写 score、不返回结果
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    const { result } = renderHook(() => usePlacementTest());
    await act(async () => {
      await result.current.generate();
    });
    act(() => {
      for (let i = 0; i < 7; i++) result.current.setAnswer(i, "alpha");
    });

    let resolveSave!: () => void;
    vi.mocked(setPlacementResult).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = () => resolve();
        }),
    );

    let late: Promise<PlacementScore | null> | null = null;
    await act(async () => {
      late = result.current.submit();
    });
    expect(result.current.submitting).toBe(true);

    // 对话框关闭/重新开始：abort 在途请求、作废在途提交并复位 submitting
    act(() => {
      result.current.reset();
    });
    expect(result.current.submitting).toBe(false);

    await act(async () => {
      resolveSave();
      // 迟到提交不写 state，且对调用方返回 null（不得把作废的计分结果
      // 透出去让结果页渲染）
      expect(await late).toBeNull();
    });

    expect(result.current.score).toBeNull();
    expect(result.current.questions).toHaveLength(0);
    expect(result.current.saveError).toBeNull();
    expect(setPlacementResult).toHaveBeenCalledTimes(1);
  });

  it("exposes saveError when persistence fails but still returns the score", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());
    vi.mocked(setPlacementResult).mockRejectedValue(new Error("磁盘写入失败"));

    const { result } = renderHook(() => usePlacementTest());
    await act(async () => {
      await result.current.generate();
    });
    act(() => {
      for (let i = 0; i < 7; i++) result.current.setAnswer(i, "alpha");
    });

    const captured: { score: PlacementScore | null } = { score: null };
    await act(async () => {
      captured.score = await result.current.submit();
    });

    // 结果仍展示（返回 score 供结果页渲染），saveError 可见供重试
    expect(captured.score?.estimated).toBe("B2+");
    expect(result.current.score?.estimated).toBe("B2+");
    expect(result.current.saveError).toBe("保存失败：磁盘写入失败");
    expect(result.current.submitting).toBe(false);
  });

  it("retrySave keeps saveError on repeated failure and clears it on success", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    const { result } = renderHook(() => usePlacementTest());
    await act(async () => {
      await result.current.generate();
    });
    act(() => {
      for (let i = 0; i < 7; i++) result.current.setAnswer(i, "alpha");
    });

    vi.mocked(setPlacementResult).mockRejectedValueOnce(new Error("磁盘写入失败"));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.saveError).toBe("保存失败：磁盘写入失败");

    // 重试再失败：saveError 保留（重试入口仍在）
    vi.mocked(setPlacementResult).mockRejectedValueOnce(new Error("磁盘写入失败"));
    await act(async () => {
      await result.current.retrySave();
    });
    expect(result.current.saveError).toBe("保存失败：磁盘写入失败");
    expect(setPlacementResult).toHaveBeenCalledTimes(2);

    // 重试成功：saveError 清除
    vi.mocked(setPlacementResult).mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.retrySave();
    });
    expect(result.current.saveError).toBeNull();
    expect(setPlacementResult).toHaveBeenCalledTimes(3);
  });

  // ── 应用与复位 ────────────────────────────────────────────────────

  it("applies the estimated level to the global level store", async () => {
    mockStreamChatAsync.mockResolvedValueOnce(questionsJson());

    const { result } = renderHook(() => usePlacementTest());
    await act(async () => {
      await result.current.generate();
    });
    act(() => {
      for (let i = 0; i < 7; i++) result.current.setAnswer(i, "alpha");
    });
    await act(async () => {
      await result.current.submit();
    });

    act(() => {
      result.current.applyResult();
    });

    // setLevelGlobal → setProficiencyLevel（全局 store write-through）
    await waitFor(() => {
      expect(setProficiencyLevel).toHaveBeenCalledWith("B2+");
    });
  });

  it("reset aborts an in-flight generation and drops its late result", async () => {
    // 在途命题：signal abort 时 reject（与 streamChatAsync 的 AbortError 语义一致）
    mockStreamChatAsync.mockImplementation(
      (_messages: unknown, _model: unknown, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
    );

    const { result } = renderHook(() => usePlacementTest());

    act(() => {
      void result.current.generate();
    });
    await waitFor(() => expect(result.current.generating).toBe(true));

    // 对话框关闭/重新开始：abort 在途请求并清空状态
    act(() => {
      result.current.reset();
    });
    expect(result.current.generating).toBe(false);

    // 迟到结果被静默丢弃：不写 questions、不写 error
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.questions).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });
});
