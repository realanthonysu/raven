import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import {
  addModel,
  deleteModel,
  getDefaultModelCached,
  getModelApiKey,
  getModels,
  invalidateDefaultModelCache,
  setDefaultModel,
  updateModel,
} from "./models";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("models db functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateDefaultModelCache();
  });
  it("getModels calls invoke with correct command", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const result = await getModels();
    expect(invoke).toHaveBeenCalledWith("db_get_models");
    expect(result).toEqual([]);
  });

  it("addModel calls invoke and invalidates cache", async () => {
    vi.mocked(invoke).mockResolvedValue(42);
    const result = await addModel({
      name: "test",
      api_key: "sk-test",
      base_url: "https://api.openai.com/v1",
      model_name: "gpt-4",
      is_default: true,
    });
    expect(invoke).toHaveBeenCalledWith("db_add_model", {
      model: {
        name: "test",
        api_key: "sk-test",
        base_url: "https://api.openai.com/v1",
        model_name: "gpt-4",
        is_default: true,
      },
    });
    expect(result).toEqual({ lastInsertId: 42 });
  });

  it("deleteModel calls invoke with correct id", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await deleteModel(5);
    expect(invoke).toHaveBeenCalledWith("db_delete_model", { id: 5 });
  });

  it("setDefaultModel calls invoke with correct id", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await setDefaultModel(3);
    expect(invoke).toHaveBeenCalledWith("db_set_default_model", { id: 3 });
  });

  it("updateModel calls invoke with mapped fields", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await updateModel(1, {
      name: "updated",
      base_url: "https://new.url",
      model_name: "gpt-4-turbo",
      api_key: "sk-new",
      is_default: false,
    });
    expect(invoke).toHaveBeenCalledWith("db_update_model", {
      id: 1,
      name: "updated",
      baseUrl: "https://new.url",
      modelName: "gpt-4-turbo",
      apiKey: "sk-new",
      isDefault: false,
    });
  });

  it("getModelApiKey calls invoke with correct id", async () => {
    vi.mocked(invoke).mockResolvedValue("sk-test-key");
    const result = await getModelApiKey(7);
    expect(invoke).toHaveBeenCalledWith("db_get_model_api_key", { id: 7 });
    expect(result).toBe("sk-test-key");
  });

  it("getDefaultModelCached returns cached result", async () => {
    invalidateDefaultModelCache();
    vi.mocked(invoke).mockResolvedValue({ id: 1, name: "test" });
    const result1 = await getDefaultModelCached();
    const result2 = await getDefaultModelCached();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result1).toEqual(result2);
  });

  it("invalidateDefaultModelCache clears cache", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: 1 });
    await getDefaultModelCached();
    invalidateDefaultModelCache();
    vi.mocked(invoke).mockResolvedValue({ id: 2 });
    await getDefaultModelCached();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
