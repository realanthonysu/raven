import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.useFakeTimers({ shouldAdvanceTime: true });

vi.mock("@/lib/db", () => ({
  getModels: vi.fn(),
  addModel: vi.fn(),
  deleteModel: vi.fn(),
  setDefaultModel: vi.fn(),
  updateModel: vi.fn(),
}));

vi.mock("@/lib/error-utils", () => ({
  getErrorMessage: vi.fn((err: unknown, fallback?: string) =>
    err instanceof Error ? err.message : (fallback ?? "Unknown error"),
  ),
}));

vi.mock("@/lib/fetch-utils", () => ({
  smartFetch: vi.fn(),
}));

import { getModels } from "@/lib/db";
import { ModelCard } from "./ModelCard";

const mockModel = {
  id: 1,
  name: "test",
  api_key: "sk-test",
  base_url: "https://api.openai.com/v1",
  model_name: "gpt-4",
  is_default: true,
};

function renderModelCard(onError = vi.fn()) {
  return render(<ModelCard onError={onError} />);
}

describe("ModelCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "文本模型设置" title', async () => {
    vi.mocked(getModels).mockResolvedValue([]);
    renderModelCard();
    expect(screen.getByText("文本模型设置")).toBeInTheDocument();
  });

  it("shows empty form when no models exist", async () => {
    vi.mocked(getModels).mockResolvedValue([]);
    renderModelCard();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("配置名称（如：Qwen、GPT-4）")).toBeInTheDocument();
    });
    // Should show the add button
    expect(screen.getByText("添加模型")).toBeInTheDocument();
  });

  it("renders model list when models are loaded", async () => {
    vi.mocked(getModels).mockResolvedValue([mockModel]);
    renderModelCard();
    await waitFor(() => {
      expect(screen.getByText("test")).toBeInTheDocument();
    });
    expect(screen.getByText("gpt-4 · https://api.openai.com/v1")).toBeInTheDocument();
    expect(screen.getByText("默认")).toBeInTheDocument();
    expect(screen.getByText("编辑")).toBeInTheDocument();
    expect(screen.getByText("设为默认")).toBeInTheDocument();
  });

  it("shows edit form when clicking edit button", async () => {
    vi.mocked(getModels).mockResolvedValue([mockModel]);
    renderModelCard();
    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));
    // Edit form should appear with pre-filled values
    expect(screen.getByDisplayValue("test")).toBeInTheDocument();
    expect(screen.getByDisplayValue("sk-test")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://api.openai.com/v1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("gpt-4")).toBeInTheDocument();
    expect(screen.getByText("保存修改")).toBeInTheDocument();
    expect(screen.getByText("取消")).toBeInTheDocument();
  });

  it("shows API key field in edit form", async () => {
    vi.mocked(getModels).mockResolvedValue([mockModel]);
    renderModelCard();
    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("编辑"));
    // The API key input should be present (type=password by default)
    const apiKeyInput = screen.getByDisplayValue("sk-test") as HTMLInputElement;
    expect(apiKeyInput).toBeInTheDocument();
    expect(apiKeyInput.type).toBe("password");
  });
});
