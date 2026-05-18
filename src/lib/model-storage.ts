import type { ModelConfig } from "@/types";

const STORAGE_KEY = "raven-models";

export function getModels(): ModelConfig[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function addModel(model: Omit<ModelConfig, "id">): ModelConfig {
  const models = getModels();
  const newModel: ModelConfig = {
    ...model,
    id: Date.now(),
    is_default: models.length === 0 ? true : model.is_default,
  };
  if (newModel.is_default) {
    models.forEach((m) => (m.is_default = false));
  }
  models.push(newModel);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
  return newModel;
}

export function deleteModel(id: number) {
  const models = getModels().filter((m) => m.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
}

export function getDefaultModel(): ModelConfig | null {
  const models = getModels();
  return models.find((m) => m.is_default) ?? models[0] ?? null;
}
