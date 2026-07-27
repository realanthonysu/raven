import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.useFakeTimers({ shouldAdvanceTime: true });

// ─── Module mocks ───────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  getTTSConfig: vi.fn(),
  getASRModel: vi.fn(),
  setTTSSettingBatch: vi.fn(),
  setASRModel: vi.fn(),
}));

vi.mock("@/hooks/use-recording", () => ({
  useRecording: vi.fn(() => ({
    recording: false,
    error: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(new Blob()),
  })),
}));

vi.mock("@/services/tts", () => ({
  speakText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/asr", () => ({
  convertToWav: vi.fn().mockResolvedValue(new Blob()),
  transcribeAudio: vi.fn().mockResolvedValue("Hello world"),
}));

vi.mock("@/lib/error-utils", () => ({
  getErrorMessage: vi.fn((err: unknown, fallback?: string) =>
    err instanceof Error ? err.message : (fallback ?? "Unknown error"),
  ),
}));

import { useRecording } from "@/hooks/use-recording";
import { getASRModel, getTTSConfig, setASRModel, setTTSSettingBatch } from "@/lib/db";
import { VoiceCard } from "./VoiceCard";

const mockGetTTSConfig = vi.mocked(getTTSConfig);
const mockGetASRModel = vi.mocked(getASRModel);
const mockSetTTSSettingBatch = vi.mocked(setTTSSettingBatch);
const mockSetASRModel = vi.mocked(setASRModel);
const mockUseRecording = vi.mocked(useRecording);

// ─── Helpers ────────────────────────────────────────────────────

const defaultTTSConfig = {
  base_url: "https://api.openai.com/v1",
  api_key: "sk-test123456789",
  model: "tts-1",
  voice: "alloy",
  speed: 1.0,
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
    mockSetTTSSettingBatch.mockResolvedValue(undefined as never);
    mockSetASRModel.mockResolvedValue(undefined as never);
    mockUseRecording.mockReturnValue({
      recording: false,
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
    expect(screen.getByPlaceholderText("模型名称（如 tts-1、mimo-v2.5-tts）")).toBeInTheDocument();
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
      expect(mockSetTTSSettingBatch).toHaveBeenCalled();
      expect(mockSetASRModel).toHaveBeenCalledWith("mimo-v2.5-asr");
    });

    // Should exit edit mode and return to saved config view
    expect(screen.getByText("编辑")).toBeInTheDocument();
    expect(screen.getByText("https://api.openai.com/v1")).toBeInTheDocument();
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
});
