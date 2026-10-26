import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.useFakeTimers({ shouldAdvanceTime: true });

// ─── Module mocks ───────────────────────────────────────────────

vi.mock("@/lib/db", async () => {
  // SETTINGS_KEYS 是真实常量（tts_* 元组键名不经 mock）——漏掉它会让
  // handleSave 在取键时抛 TypeError，保存路径静默失败
  const { SETTINGS_KEYS } = await import("@/lib/db/settings-keys");
  return {
    SETTINGS_KEYS,
    getTTSConfig: vi.fn(),
    getASRModel: vi.fn(),
    setTTSSettingBatch: vi.fn(),
    setASRModel: vi.fn(),
  };
});

vi.mock("@/hooks/use-recording", () => ({
  useRecording: vi.fn(() => ({
    recording: false,
    error: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(new Blob()),
  })),
}));

vi.mock("@/services/tts", () => ({
  speakTestText: vi.fn().mockResolvedValue(undefined),
  saveTTSSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/asr", () => ({
  transcribeRecording: vi.fn().mockResolvedValue("Hello world"),
}));

vi.mock("@/lib/error-utils", () => ({
  getErrorMessage: vi.fn((err: unknown, fallback?: string) =>
    err instanceof Error ? err.message : (fallback ?? "Unknown error"),
  ),
}));

import { useRecording } from "@/hooks/use-recording";
import { getASRModel, getTTSConfig, setASRModel } from "@/lib/db";
import { saveTTSSettings, speakTestText } from "@/services/tts";
import { VoiceCard } from "./VoiceCard";

const mockGetTTSConfig = vi.mocked(getTTSConfig);
const mockGetASRModel = vi.mocked(getASRModel);
const mockSaveTTSSettings = vi.mocked(saveTTSSettings);
const mockSpeakTestText = vi.mocked(speakTestText);
const mockSetASRModel = vi.mocked(setASRModel);
const mockUseRecording = vi.mocked(useRecording);

// ─── Helpers ────────────────────────────────────────────────────

const defaultTTSConfig = {
  base_url: "https://api.openai.com/v1",
  api_key: "sk-test123456789",
  model: "tts-1",
  voice: "alloy",
  speed: 1.0,
  dialect: "mimo",
};

function renderVoiceCard(onError = vi.fn()) {
  return render(<VoiceCard onError={onError} />);
}

// ─── Tests ──────────────────────────────────────────────────────

describe("VoiceCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTTSConfig.mockResolvedValue(defaultTTSConfig);
    mockGetASRModel.mockResolvedValue("mimo-v2.5-asr");
    mockSaveTTSSettings.mockResolvedValue(undefined);
    mockSetASRModel.mockResolvedValue(undefined as never);
    mockUseRecording.mockReturnValue({
      recording: false,
      loading: false,
      error: null,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(new Blob()),
    });
  });

  // ── Rendering ──

  it('renders "语音模型设置" title', () => {
    renderVoiceCard();
    expect(screen.getByText("语音模型设置")).toBeInTheDocument();
  });

  it("shows saved config when hasApiKey is true", async () => {
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("https://api.openai.com/v1")).toBeInTheDocument();
    });

    // API Key is masked — find the paragraph containing the masked key
    const apiKeyParagraph = screen.getByText(/API Key:/);
    expect(apiKeyParagraph).toHaveTextContent(/sk-.*789/);
    // TTS model info
    expect(screen.getByText("tts-1")).toBeInTheDocument();
    expect(screen.getByText("alloy")).toBeInTheDocument();
    expect(screen.getByText("x1")).toBeInTheDocument();
    // ASR model info
    expect(screen.getByText("mimo-v2.5-asr")).toBeInTheDocument();
  });

  // ── Edit mode ──

  it("shows edit form with fields when clicking 编辑", async () => {
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("编辑"));

    // Should show form fields
    expect(screen.getByLabelText("API URL")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("音色")).toBeInTheDocument();
    expect(screen.getByLabelText("语速 (0.25-4.0)")).toBeInTheDocument();

    // ASR model input
    expect(screen.getByPlaceholderText("模型名称（如 mimo-v2.5-asr）")).toBeInTheDocument();

    // TTS model input
    expect(screen.getByPlaceholderText("模型名称（如 mimo-v2.5-tts、tts-1）")).toBeInTheDocument();
  });

  it("shows TTS and ASR test buttons in edit mode", async () => {
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("编辑"));

    expect(screen.getByText("保存设置")).toBeInTheDocument();
    expect(screen.getByText("测试 TTS")).toBeInTheDocument();
    expect(screen.getByText("测试 ASR")).toBeInTheDocument();
  });

  // ── TTS 试听（B-2：必须用表单未保存的 base_url）──

  it("previews TTS with the unsaved form base_url via speakTestText", async () => {
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));

    // 修改 URL 为未保存的表单值（验证新配置的刚需场景）
    const apiUrlInput = screen.getByLabelText("API URL") as HTMLInputElement;
    fireEvent.change(apiUrlInput, { target: { value: "https://unsaved.example.com/v1" } });

    fireEvent.click(screen.getByText("测试 TTS"));

    // api_key 未改动（非 dirty）→ 传 undefined，由服务端从 Keychain 自读；
    // 第三个参数为本轮试听的 AbortSignal（重复点击/卸载时可中止）
    await waitFor(() => {
      expect(mockSpeakTestText).toHaveBeenCalledWith(
        "Hello, this is a test.",
        {
          base_url: "https://unsaved.example.com/v1",
          api_key: undefined,
          model: "tts-1",
          voice: "冰糖",
          speed: 1.0,
        },
        expect.any(AbortSignal),
      );
    });
  });

  it("shows 请先填写 API Key when neither form nor saved key exists", async () => {
    mockGetTTSConfig.mockResolvedValue({ ...defaultTTSConfig, api_key: "" });
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByLabelText("API URL")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("测试 TTS"));

    await waitFor(() => {
      expect(screen.getByText("请先填写 API Key")).toBeInTheDocument();
    });
    expect(mockSpeakTestText).not.toHaveBeenCalled();
  });

  it("blocks TTS test and does not fall back to the saved key when the user clears the form key", async () => {
    // 编辑态明确清空 Key（dirty 且空串）时必须拦截：若放行会传空串，
    // 服务端对空串回退 Keychain 自读旧 Key，试听"成功"与清空意图相反
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));

    const apiKeyInput = screen.getByLabelText("API Key") as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: "" } });

    fireEvent.click(screen.getByText("测试 TTS"));

    await waitFor(() => {
      expect(screen.getByText("请先填写 API Key")).toBeInTheDocument();
    });
    // 关键断言：不得用已保存的旧 Key 发起试听
    expect(mockSpeakTestText).not.toHaveBeenCalled();
  });

  it("sends the newly typed form key when the key field is dirty and non-empty", async () => {
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));

    const apiKeyInput = screen.getByLabelText("API Key");
    fireEvent.change(apiKeyInput, { target: { value: "sk-new-form-key" } });

    fireEvent.click(screen.getByText("测试 TTS"));

    await waitFor(() => {
      expect(mockSpeakTestText).toHaveBeenCalledWith(
        "Hello, this is a test.",
        {
          base_url: "https://api.openai.com/v1",
          api_key: "sk-new-form-key",
          model: "tts-1",
          voice: "冰糖",
          speed: 1.0,
        },
        expect.any(AbortSignal),
      );
    });
  });

  // ── No saved config (first time) ──

  it("shows edit form directly when no API key is saved", async () => {
    mockGetTTSConfig.mockResolvedValue({
      ...defaultTTSConfig,
      api_key: "",
    });

    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByLabelText("API URL")).toBeInTheDocument();
    });

    // Should show the form fields without needing to click edit
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
    expect(screen.getByText("保存设置")).toBeInTheDocument();
  });

  // ── Save ──

  it("saves config and exits edit mode", async () => {
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("编辑"));
    fireEvent.click(screen.getByText("保存设置"));

    await waitFor(() => {
      expect(mockSaveTTSSettings).toHaveBeenCalled();
      expect(mockSetASRModel).toHaveBeenCalledWith("mimo-v2.5-asr");
    });

    // Should exit edit mode and return to saved config view
    expect(screen.getByText("编辑")).toBeInTheDocument();
    expect(screen.getByText("https://api.openai.com/v1")).toBeInTheDocument();
  });

  it("pushes an empty tts_api_key when the user clears the key and saves", async () => {
    // 清空 Key 保存必须推送空串（Rust 侧据此删除 Keychain 条目），
    // 而不是静默跳过导致旧 Key 继续生效
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));

    const apiKeyInput = screen.getByLabelText("API Key") as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: "" } });

    fireEvent.click(screen.getByText("保存设置"));

    await waitFor(() => {
      expect(mockSaveTTSSettings).toHaveBeenCalled();
    });
    const entries = mockSaveTTSSettings.mock.calls[0][0];
    expect(entries).toContainEqual(["tts_api_key", ""]);
  });

  // ── Cancel ──

  it("reverts form changes when cancel is clicked", async () => {
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("编辑"));

    // Change a field
    const apiInput = screen.getByLabelText("API URL") as HTMLInputElement;
    fireEvent.change(apiInput, { target: { value: "https://changed.url" } });
    expect(apiInput.value).toBe("https://changed.url");

    // Cancel
    fireEvent.click(screen.getByText("取消"));

    // Should be back to saved view
    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    expect(screen.getByText("https://api.openai.com/v1")).toBeInTheDocument();
  });

  // ── B7：试听可停止（卸载/被取代时中止，AbortError 静默） ──

  it("aborts the in-flight preview when the component unmounts", async () => {
    // 挂起的试听捕获外部 AbortSignal，卸载时必须被中止
    const signals: AbortSignal[] = [];
    mockSpeakTestText.mockImplementation(
      (_text: string, _config: unknown, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signals.push(signal as AbortSignal);
          signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );

    const { unmount } = renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));
    fireEvent.click(screen.getByText("测试 TTS"));

    await waitFor(() => expect(signals.length).toBe(1));
    expect(signals[0].aborted).toBe(false);

    unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it("stays silent when the preview rejects with AbortError", async () => {
    // 被新一轮试听/卸载取代的旧请求以 AbortError 收场：不是失败，
    // 不显示"TTS 测试失败"、不上报 onError
    mockSpeakTestText.mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    const onError = vi.fn();

    renderVoiceCard(onError);

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));
    fireEvent.click(screen.getByText("测试 TTS"));

    await waitFor(() => {
      expect(mockSpeakTestText).toHaveBeenCalled();
    });
    expect(screen.queryByText(/TTS 测试失败/)).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });

  it("passes a fresh AbortSignal to each preview attempt", async () => {
    renderVoiceCard();

    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));
    fireEvent.click(screen.getByText("测试 TTS"));
    await waitFor(() => expect(mockSpeakTestText).toHaveBeenCalledTimes(1));

    const firstSignal = mockSpeakTestText.mock.calls[0][2] as AbortSignal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal.aborted).toBe(false);
  });
});
