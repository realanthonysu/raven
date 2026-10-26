import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PracticeSessionConfig } from "@/hooks/use-practice-session";
import { sampleFillExercises } from "@/test/mocks";
import type { ExerciseQuestion } from "@/types";
import ExercisePage from "./ExercisePage";

// ─── Module mocks ─────────────────────────────────────────────────

/**
 * usePracticeSession mock：捕获页面传入的 config，生成驱动方式从"触发
 * streamChat/handleSubmit mock"改为"触发 generate mock"——generate 的实现
 * 镜像真实 hook 的 isGenerating 生命周期（发起置 true、resolve 后复位，
 * useRetryHint 的 30 秒计时依赖它），对 config 做什么由用例注入的
 * generateBehavior 决定（默认挂起 = 生成进行中）。
 */
type SessionConfig = PracticeSessionConfig<{ exercises: ExerciseQuestion[] }>;

let capturedConfig: SessionConfig | null = null;
let generateBehavior: (config: SessionConfig) => void;

const mockGenerate = vi.fn();
const mockAbort = vi.fn();
const mockPersistWithResult = vi.fn();

vi.mock("@/hooks/use-practice-session", () => ({
  usePracticeSession: (config: SessionConfig) => {
    capturedConfig = config;
    // isGenerating 用真 state 驱动，保证 useRetryHint 的计时语义与真实一致
    const [isGenerating, setIsGenerating] = useState(false);
    mockGenerate.mockImplementation(async () => {
      setIsGenerating(true);
      try {
        await generateBehavior(capturedConfig as SessionConfig);
      } finally {
        setIsGenerating(false);
      }
    });
    return {
      isGenerating,
      generate: mockGenerate,
      abort: mockAbort,
      persistWithResult: mockPersistWithResult,
    };
  },
}));

// DB 层部分 mock：读路径（getProficiencyLevel）经 barrel 走真实 settings 模块
// ——测试环境 invoke 不可用，fail-soft 回落 DEFAULT_LEVEL(B1)；写路径替换为
// vi.fn() 防御意外落库
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  addHistorySafe: vi.fn().mockResolvedValue(42),
  recordLearningActivitySafe: vi.fn(),
  buildPersonalizedContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/components/SpeakButton", () => ({
  SpeakButton: () => null,
}));

// ─── Session 行为注入 ─────────────────────────────────────────────

/** 默认行为：挂起（模拟进行中的生成，isGenerating 保持 true） */
const hangGeneration = () => new Promise<void>(() => {});

/** 生成成功：按信封形状分发解析结果（异步触发，保留可观察的 loading 帧） */
function resolveGenerationWith(exercises: ExerciseQuestion[]) {
  generateBehavior = (config) => {
    setTimeout(() => config.onParsed({ exercises }), 0);
  };
}

/** 解析失败：session 以 parseErrorMessage 上报并执行回退动作 */
function failParsing() {
  generateBehavior = (config) => {
    setTimeout(() => {
      config.reportError(config.parseErrorMessage ?? "生成失败，请重试。");
      config.onGenerationFailure?.();
    }, 0);
  };
}

/** 生成失败：session 以 formatGenerationError 包装后上报并执行回退动作 */
function failGeneration(message: string) {
  generateBehavior = (config) => {
    setTimeout(() => {
      config.reportError(config.formatGenerationError?.(message) ?? message);
      config.onGenerationFailure?.();
    }, 0);
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Renders ExercisePage inside a proper Route so useParams works.
 * The route path "exercise/:category" matches the URL structure in App.tsx.
 */
function renderExercisePage(category = "时态错误") {
  return render(
    <MemoryRouter initialEntries={[`/exercise/${encodeURIComponent(category)}`]}>
      <Routes>
        <Route path="exercise/:category" element={<ExercisePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────

describe("ExercisePage", () => {
  beforeEach(() => {
    capturedConfig = null;
    generateBehavior = hangGeneration;
    mockGenerate.mockClear();
    mockAbort.mockClear();
    mockPersistWithResult.mockReset();
    mockPersistWithResult.mockResolvedValue(42);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders loading state with category name", () => {
    renderExercisePage("时态错误");

    expect(screen.getByText(/弱项训练/)).toBeInTheDocument();
    expect(screen.getByText(/时态错误/)).toBeInTheDocument();
    expect(screen.getByText(/正在生成针对性练习题/)).toBeInTheDocument();
  });

  it("shows 'back to analytics' navigation in loading phase", () => {
    renderExercisePage();

    expect(screen.getByText(/返回/)).toBeInTheDocument();
  });

  it("shows retry hint after 30 seconds timeout", () => {
    // 默认 generate 挂起：isGenerating 保持 true，30 秒计时照常运行
    renderExercisePage();

    // Retry hint should not be visible initially
    expect(screen.queryByText(/生成时间较长/)).not.toBeInTheDocument();

    // Advance timers past 30 seconds — wrap in act so React processes the state update
    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    expect(screen.getByText(/生成时间较长/)).toBeInTheDocument();
  });

  it("transitions to answering phase when exercises are generated", async () => {
    resolveGenerationWith(sampleFillExercises);

    renderExercisePage();

    // Wait for the transition to answering phase
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // Exercise questions should be visible
    expect(screen.getByText(/She ___ \(go\) to school/)).toBeInTheDocument();
    expect(screen.getByText(/They ___ \(be\) happy/)).toBeInTheDocument();
  });

  it("shows error when LLM returns unparseable content", async () => {
    failParsing();

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/解析练习题失败/)).toBeInTheDocument();
    });
  });

  it("shows error when LLM request fails", async () => {
    failGeneration("network timeout");

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/生成失败/)).toBeInTheDocument();
      expect(screen.getByText(/network timeout/)).toBeInTheDocument();
    });
  });

  it("renders category name decoded from URL-encoded Chinese characters", () => {
    renderExercisePage("句式杂糅");

    expect(screen.getByText(/弱项训练/)).toBeInTheDocument();
    expect(screen.getByText(/句式杂糅/)).toBeInTheDocument();
  });

  it("displays score after submitting answers in review phase", async () => {
    resolveGenerationWith(sampleFillExercises);

    renderExercisePage();

    // Wait for answering phase
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // Select the correct answer for the first question (click the "goes" option)
    const goesButton = screen.getByRole("button", { name: "goes" });
    fireEvent.click(goesButton);

    // Submit
    const submitButton = screen.getByText(/提交答案/);
    fireEvent.click(submitButton);

    // Should transition to review phase with score
    await waitFor(() => {
      expect(screen.getByText(/得分/)).toBeInTheDocument();
    });

    // Should show "再来一轮" button
    expect(screen.getByText(/再来一轮/)).toBeInTheDocument();
    expect(screen.getByText(/返回学习分析/)).toBeInTheDocument();
  });

  it("builds the generation prompt with the category", async () => {
    renderExercisePage("主谓一致");

    // 生成 prompt 由页面注入 session 的 buildMessages 构建
    const messages = await capturedConfig?.buildMessages("");
    expect(messages?.[0]).toContain("主谓一致");
  });

  // ── 英语水平级别（Track 1） ──

  it("shows the current proficiency level badge in the header", () => {
    renderExercisePage("主谓一致");

    // 测试环境 settings 读取失败 → 回退默认级别 B1
    expect(screen.getByText("B1（≈高中 · 高考）")).toBeInTheDocument();
  });

  it("injects the level spec block into the generation prompt", async () => {
    renderExercisePage("主谓一致");

    const messages = await capturedConfig?.buildMessages("");

    // buildExercisePrompt(category, ctx, 5, "B1")：难度规格块 + 规格内由易到难
    expect(messages?.[0]).toContain("【难度规格 · CEFR B1，≈高中 · 高考】");
    expect(messages?.[0]).toContain("5 道题在上述难度规格内由易到难排列");
    expect(messages?.[0]).not.toContain("难度递进，从简单到中等");
  });

  it("captures the generation level for persistence via getDifficultyLevel", async () => {
    renderExercisePage("主谓一致");

    // buildMessages 异步读取并把本次使用的级别写入 lastLevelRef
    await capturedConfig?.buildMessages("");

    // 持久化时由 session 读取该快照写入 difficulty_level（合并逻辑属
    // useLLMStreamPage，见其自身测试）
    expect(capturedConfig?.getDifficultyLevel?.()).toBe("B1");
  });

  it("persists the scored result via persistWithResult on submit", async () => {
    resolveGenerationWith(sampleFillExercises);

    renderExercisePage("主谓一致");

    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // 作答并提交 → persistWithResult 收到打分后的完整结果对象
    fireEvent.click(screen.getByRole("button", { name: "goes" }));
    fireEvent.click(screen.getByText(/提交答案/));

    await waitFor(() => {
      expect(mockPersistWithResult).toHaveBeenCalledTimes(1);
    });
    expect(mockPersistWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "主谓一致",
        userAnswers: ["goes", ""],
        score: 1,
      }),
    );
  });

  it("handleRetry returns to loading and regenerates exercises", async () => {
    resolveGenerationWith(sampleFillExercises);

    renderExercisePage();

    // Wait for answering phase
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    // Answer and submit to reach review phase
    const goesButton = screen.getByRole("button", { name: "goes" });
    fireEvent.click(goesButton);
    fireEvent.click(screen.getByText(/提交答案/));

    await waitFor(() => {
      expect(screen.getByText(/再来一轮/)).toBeInTheDocument();
    });

    // Click "再来一轮"
    fireEvent.click(screen.getByText(/再来一轮/));

    // Should go back to loading phase and regenerate
    // （generateBehavior 未在点击的同步执行期内触发，loading 帧必然可见）
    expect(screen.getByText(/正在生成针对性练习题/)).toBeInTheDocument();
    expect(mockGenerate).toHaveBeenCalledTimes(2);

    // 重新生成成功后回到答题阶段
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });
  });

  it("disables submit when no answers are provided", async () => {
    resolveGenerationWith(sampleFillExercises);

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });

    // Submit button should be disabled initially (no answers filled)
    const submitButton = screen.getByText(/提交答案/).closest("button");
    expect(submitButton).toBeDisabled();
  });

  it("clears the stale error banner when retrying after a loading-phase failure", async () => {
    // B2 回归：失败态停留在 loading 时 transition("loading") 同阶段早退，
    // onEnter 的 RESET 不会触发——重试必须显式清错误槽。
    // 单一 generate 行为按调用次序分发：首次失败、其后成功。
    let generateCall = 0;
    generateBehavior = (config) => {
      generateCall += 1;
      if (generateCall === 1) {
        setTimeout(() => {
          config.reportError(
            config.formatGenerationError?.("network timeout") ?? "network timeout",
          );
          config.onGenerationFailure?.();
        }, 0);
      } else {
        setTimeout(() => config.onParsed({ exercises: sampleFillExercises }), 0);
      }
    };

    renderExercisePage();

    await waitFor(() => {
      expect(screen.getByText(/生成失败/)).toBeInTheDocument();
      expect(screen.getByText(/network timeout/)).toBeInTheDocument();
    });

    // 点击重新生成：旧错误横幅清空，显示 loading（错误清除是同步 dispatch）
    fireEvent.click(screen.getByText(/重新生成/));
    expect(screen.getByText(/正在生成针对性练习题/)).toBeInTheDocument();
    expect(screen.queryByText(/network timeout/)).not.toBeInTheDocument();

    // 成功后进入答题阶段，无旧错误残留
    await waitFor(() => {
      expect(screen.getByText(/提交答案/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/生成失败/)).not.toBeInTheDocument();
    expect(screen.queryByText(/network timeout/)).not.toBeInTheDocument();
  });
});
