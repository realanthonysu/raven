/**
 * 模型配置操作（API Key 由 Rust 端自动存取到 OS Keychain）。
 */

import { invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
import type { ModelConfig } from "@/types";

/**
 * 获取所有模型配置列表。
 *
 * @returns 模型配置数组
 */
export async function getModels(): Promise<ModelConfig[]> {
  return invoke<ModelConfig[]>("db_get_models");
}

/**
 * 新增模型配置。
 *
 * 在 Rust 端执行 DB 事务插入 + Keychain 写入。
 * 若设为默认模型，Rust 端会自动清除其他模型的默认标记。
 * 成功后失效默认模型缓存。
 *
 * @param model - 模型配置（不含 id）
 * @returns 包含 lastInsertId 的对象
 */
export async function addModel(model: Omit<ModelConfig, "id">) {
  const lastInsertId = await invoke<number>("db_add_model", { model });
  invalidateDefaultModelCache();
  return { lastInsertId };
}

/**
 * 删除指定模型配置。
 *
 * Rust 端同时清理 OS Keychain 中的 API Key。
 * 成功后失效默认模型缓存。
 *
 * @param id - 要删除的模型 ID
 */
export async function deleteModel(id: number) {
  await invoke<void>("db_delete_model", { id });
  invalidateDefaultModelCache();
}

async function getDefaultModel(): Promise<ModelConfig | null> {
  return invoke<ModelConfig | null>("db_get_default_model");
}

/** 默认模型缓存实例（避免每次 LLM 请求都查询数据库） */
const defaultModelCache = createCachedFetcher(getDefaultModel);
/** 获取缓存的默认模型（首次调用查询，后续直接返回缓存） */
export const getDefaultModelCached = defaultModelCache.cached;
/** 失效默认模型缓存（模型增删改后调用） */
export const invalidateDefaultModelCache = (): void => defaultModelCache.invalidate();

/**
 * 设置指定模型为默认模型（清除其他模型的默认标记）。
 *
 * 成功后失效默认模型缓存，确保 LLM 请求使用新默认模型。
 *
 * @param id - 要设为默认的模型 ID
 */
export async function setDefaultModel(id: number) {
  await invoke<void>("db_set_default_model", { id });
  invalidateDefaultModelCache();
}

/**
 * 更新模型配置（名称、Base URL、模型名、API Key、默认状态）。
 *
 * Rust 端先执行 DB 事务更新，再写 Keychain。
 * 成功后失效默认模型缓存。
 *
 * @param id - 要更新的模型 ID
 * @param model - 更新后的模型配置
 */
export async function updateModel(
  id: number,
  model: {
    name: string;
    base_url: string;
    model_name: string;
    api_key: string;
    is_default: boolean;
  },
) {
  await invoke<void>("db_update_model", {
    id,
    name: model.name,
    baseUrl: model.base_url,
    modelName: model.model_name,
    apiKey: model.api_key,
    isDefault: model.is_default,
  });
  invalidateDefaultModelCache();
}

/**
 * 获取指定模型的 API Key（从 OS Keychain 读取）。
 *
 * 前端编辑模型时调用，用于预填 API Key 字段，
 * 使用户无需重新输入即可测试连接。
 *
 * @param id - 模型 ID
 * @returns API Key 字符串（Keychain 中不存在时返回空字符串）
 */
export async function getModelApiKey(id: number): Promise<string> {
  return invoke<string>("db_get_model_api_key", { id });
}
