import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLevelGlobal } from "@/hooks/use-proficiency-level";
import { OnboardingDialog } from "./OnboardingDialog";

// ─── Module mocks ─────────────────────────────────────────────────

// DB 层部分 mock：仅替换 addModel/setASRModel；setLevelGlobal 经 barrel 落到
// 真实 setProficiencyLevel → setSetting → 下方 mock 的 invoke，
// 「持久化级别」断言（db_set_setting, proficiency_level）保持原语义
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  addModel: vi.fn().mockResolvedValue({ lastInsertId: 1 }),
  setASRModel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/tts", () => ({
  saveTTSSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { addModel } from "@/lib/db";

// ─── Helpers ──────────────────────────────────────────────────────

function renderOnboarding(onComplete = vi.fn()) {
  return render(<OnboardingDialog onComplete={onComplete} />);
}

/** Find the dropdown chevron button next to the API URL input. */
function getPresetsButton() {
  // The presets button is inside the relative container that wraps the API URL input.
  // It is a plain <button> (not a shadcn Button) with a ChevronDown icon.
  const input = screen.getByLabelText("API 地址");
  const container = input.closest(".relative");
  const button = container?.querySelector("button");
  if (!container || !button) throw new Error("presets button not found");
  return button;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("OnboardingDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    // 全局级别 store 是模块级共享状态：定级测试改写后复位，避免污染其他用例
    setLevelGlobal("B1");
    vi.useRealTimers();
  });

  // ── Step 0: Welcome ────────────────────────────────────────────

  it("renders welcome step (step 0) with title", () => {
    renderOnboarding();
    expect(screen.getByText("欢迎使用 Raven")).toBeInTheDocument();
  });

  it("shows subtitle", () => {
    renderOnboarding();
    expect(screen.getByText("AI 驱动的英语学习助手")).toBeInTheDocument();
  });

  it("shows feature list", () => {
    renderOnboarding();
    expect(screen.getByText("写作批改")).toBeInTheDocument();
    expect(screen.getByText("阅读精读")).toBeInTheDocument();
    expect(screen.getByText("间隔复习")).toBeInTheDocument();
    expect(screen.getByText("弱项训练")).toBeInTheDocument();
  });

  it("shows feature descriptions", () => {
    renderOnboarding();
    expect(screen.getByText("AI 智能纠错，分类解析错误")).toBeInTheDocument();
    expect(screen.getByText("六维深度分析，知识图谱")).toBeInTheDocument();
    expect(screen.getByText("科学记忆曲线，高效背词")).toBeInTheDocument();
    expect(screen.getByText("针对薄弱点，专项突破")).toBeInTheDocument();
  });

  it("shows '开始配置' button on welcome step", () => {
    renderOnboarding();
    expect(screen.getByText("开始配置")).toBeInTheDocument();
  });

  // ── Navigation to Step 1 ───────────────────────────────────────

  it("can navigate to next step (API config)", () => {
    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    // "配置 API" appears in the step indicator AND the CardTitle; verify at least one
    const matches = screen.getAllByText("配置 API");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Also verify the step-1 specific content is shown
    expect(
      screen.getByText(
        "Raven 完全基于 MiMo 模型生态，推荐使用 MiMo；也兼容 OpenAI、DeepSeek 等接口",
      ),
    ).toBeInTheDocument();
  });

  // ── Step 1: API Config ─────────────────────────────────────────

  it("API config step shows input fields for API URL, API Key, Model name", () => {
    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    expect(screen.getByLabelText("API 地址")).toBeInTheDocument();
    expect(screen.getByLabelText("API 密钥")).toBeInTheDocument();
    expect(screen.getByLabelText("模型名称")).toBeInTheDocument();
  });

  it("API config step shows test connection button", () => {
    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    expect(screen.getByText("测试连接")).toBeInTheDocument();
  });

  it("shows API presets when dropdown is clicked", () => {
    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    fireEvent.click(getPresetsButton());

    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
  });

  it("can apply a preset (click OpenAI fills the fields)", () => {
    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    // Open presets dropdown and click OpenAI
    fireEvent.click(getPresetsButton());
    fireEvent.click(screen.getByText("OpenAI"));

    // Verify fields are filled
    expect(screen.getByLabelText("API 地址")).toHaveValue("https://api.openai.com/v1");
    expect(screen.getByLabelText("模型名称")).toHaveValue("gpt-4o-mini");

    // Presets dropdown should be closed
    expect(screen.queryByText("DeepSeek")).not.toBeInTheDocument();
  });

  it("can apply DeepSeek preset", () => {
    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    fireEvent.click(getPresetsButton());
    fireEvent.click(screen.getByText("DeepSeek"));

    expect(screen.getByLabelText("API 地址")).toHaveValue("https://api.deepseek.com/v1");
    expect(screen.getByLabelText("模型名称")).toHaveValue("deepseek-chat");
  });

  // ── Navigation back ────────────────────────────────────────────

  it("can navigate back to previous step", () => {
    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    // Verify we are on step 1
    expect(
      screen.getByText(
        "Raven 完全基于 MiMo 模型生态，推荐使用 MiMo；也兼容 OpenAI、DeepSeek 等接口",
      ),
    ).toBeInTheDocument();

    // Click back button
    fireEvent.click(screen.getByText("上一步"));

    // Verify we are back on step 0
    expect(screen.getByText("欢迎使用 Raven")).toBeInTheDocument();
  });

  // ── Step 1 → Step 2 requires successful test ──────────────────

  it("next button is disabled until test connection succeeds", () => {
    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    // There are multiple "下一步" buttons (step 2 also has one), but step 1's is disabled
    const nextButtons = screen.getAllByText("下一步");
    expect(nextButtons.length).toBeGreaterThanOrEqual(1);
    // The first "下一步" belongs to step 1 and should be disabled
    expect(nextButtons[0].closest("button")).toBeDisabled();
  });

  it("enables next button after successful connection test", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    // Fill in API key
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test-key" },
    });

    // Click test connection
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("连接成功")).toBeInTheDocument();
    });

    const nextButtons = screen.getAllByText("下一步");
    expect(nextButtons[0].closest("button")).not.toBeDisabled();
  });

  // ── Step 3: Completion ─────────────────────────────────────────

  it("shows completion step with '开始使用' button", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    renderOnboarding();

    // Navigate to step 1
    fireEvent.click(screen.getByText("开始配置"));

    // Fill in API key and test connection
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("连接成功")).toBeInTheDocument();
    });

    // Navigate to step 2 (step 1's "下一步")
    const nextButtons = screen.getAllByText("下一步");
    fireEvent.click(nextButtons[0]);

    // "体验预览" appears in sr-only title, step indicator, and CardTitle
    const previewTitles = screen.getAllByText("体验预览");
    expect(previewTitles.length).toBeGreaterThanOrEqual(1);

    // Navigate: API → 选择级别 → 配置语音 → 跳过语音 → 体验预览 → 完成
    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getByText("跳过语音"));
    fireEvent.click(screen.getAllByText("下一步")[0]);

    // "完成" appears in sr-only title, step indicator, and CardTitle
    const completeTitles = screen.getAllByText("完成");
    expect(completeTitles.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("开始使用")).toBeInTheDocument();
  });

  it("calls onComplete when '开始使用' is clicked", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    const onComplete = vi.fn();
    renderOnboarding(onComplete);

    // Navigate through all steps
    fireEvent.click(screen.getByText("开始配置"));

    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("连接成功")).toBeInTheDocument();
    });

    // Step 1 → Step 2 (API → 选择级别)
    fireEvent.click(screen.getAllByText("下一步")[0]);
    // Step 2 → Step 3 (选择级别 → 配置语音)
    fireEvent.click(screen.getAllByText("下一步")[0]);

    // Skip voice (Step 3 → Step 4)
    fireEvent.click(screen.getByText("跳过语音"));
    // Step 4 → Step 5 (体验预览 → 完成)
    fireEvent.click(screen.getAllByText("下一步")[0]);

    // Click "开始使用"
    fireEvent.click(screen.getByText("开始使用"));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it("calls addModel with correct params when finishing", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    const onComplete = vi.fn();
    renderOnboarding(onComplete);

    // Navigate to step 1 and configure
    fireEvent.click(screen.getByText("开始配置"));

    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("连接成功")).toBeInTheDocument();
    });

    // Navigate to the final step and finish
    // 6 步向导：API → 选择级别 → 语音 → 跳过语音 → 预览 → 完成
    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getByText("跳过语音"));
    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getByText("开始使用"));

    await waitFor(() => {
      expect(addModel).toHaveBeenCalledWith({
        name: "默认模型",
        api_key: "sk-test-key",
        base_url: "https://api.xiaomimimo.com/v1",
        model_name: "mimo-v2.5",
        is_default: true,
      });
    });
  });

  // ── Skip button ────────────────────────────────────────────────

  it("calls onComplete when '跳过' is clicked", () => {
    const onComplete = vi.fn();
    renderOnboarding(onComplete);

    fireEvent.click(screen.getByText("开始配置"));
    fireEvent.click(screen.getByText("跳过"));

    expect(onComplete).toHaveBeenCalled();
  });

  // ── Step 4: Preview ────────────────────────────────────────────

  it("shows correction preview content", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    renderOnboarding();

    // Navigate to step 1 and test connection
    fireEvent.click(screen.getByText("开始配置"));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("连接成功")).toBeInTheDocument();
    });

    // Navigate to the preview step
    // API → 选择级别 → 配置语音 → 跳过语音 → 体验预览
    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getByText("跳过语音"));

    // "体验预览" appears in sr-only title, step indicator, and CardTitle
    const previewTitles = screen.getAllByText("体验预览");
    expect(previewTitles.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("输入原文")).toBeInTheDocument();
    expect(screen.getByText("纠错详情")).toBeInTheDocument();
    expect(screen.getByText("时态")).toBeInTheDocument();
    expect(screen.getByText("单复数")).toBeInTheDocument();
    expect(screen.getByText("拼写")).toBeInTheDocument();
    expect(screen.getByText("冠词")).toBeInTheDocument();
  });

  // ── Step 2: Select level ───────────────────────────────────────

  it("shows level selection step after API config", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("连接成功")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText("下一步")[0]);

    // 标题同时出现在步骤指示器与 CardTitle
    expect(screen.getAllByText("选择英语水平").length).toBeGreaterThanOrEqual(1);
    // 自报定级选项（考试/学段名 + CEFR 副行）
    expect(screen.getByText("大学四级")).toBeInTheDocument();
    expect(screen.getByText("专业八级 / 雅思·托福")).toBeInTheDocument();
    expect(screen.getByText("B1+（≈大学四级 CET-4）")).toBeInTheDocument();
  });

  it("persists the selected level via the global store", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("连接成功")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getByText("大学六级"));

    // setLevelGlobal → setProficiencyLevel → db_set_setting(proficiency_level, B2)
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("db_set_setting", {
        key: "proficiency_level",
        value: "B2",
      });
    });
    // 选中态同步更新（原生 radio 的 checked 属性）
    expect(screen.getByRole("radio", { name: /大学六级/ })).toBeChecked();
  });

  it("can skip the level step to voice config", async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{}] }),
    });

    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("连接成功")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText("下一步")[0]);
    fireEvent.click(screen.getByText("跳过"));

    // 跳过级别后进入语音配置（步骤 3）；标题同时出现在步骤指示器与 CardTitle
    expect(screen.getAllByText("配置语音").length).toBeGreaterThanOrEqual(1);
  });

  // ── Connection test error ──────────────────────────────────────

  it("shows error message when connection test fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("Network error"));

    renderOnboarding();
    fireEvent.click(screen.getByText("开始配置"));

    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "sk-bad-key" },
    });
    fireEvent.click(screen.getByText("测试连接"));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });
});
