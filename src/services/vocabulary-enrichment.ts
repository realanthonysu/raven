/**
 * 词汇 enrichment 服务 —— 调用 LLM 补全生词的音标、释义、搭配与例句。
 *
 * 从 ReadingPage/CorrectPage 添加生词时自动补全缺失数据；VocabularyPage
 * 的手动补全与批量补全也复用本模块。传输层（streamChatAsync/buildPrompt）
 * 复用 services/llm.ts，prompt 字面量集中在 prompts/enrichment.ts。
 *
 * 缓存语义（enrichWordCache）：
 * - 同一「单词（忽略大小写）+ 默认模型」只请求一次 LLM，Promise 去重共享并发请求；
 *   缓存键含模型身份，用户切换默认 provider/model 后旧条目自然失配，
 *   不会在切换后继续用旧模型的补全结果（直到 FIFO 驱逐为止的旧问题）
 * - FIFO 驱逐上限 200 条，避免长会话内存增长
 * - 失败不缓存：rejection 路径自动移除条目，后续调用重新尝试
 */

import { createCachedFetcher } from "@/lib/cache";
import { getDefaultModelCached } from "@/lib/db";
import { extractJsonSafe } from "@/lib/parse-utils";
import { raceWithAbort } from "@/lib/request-utils";
import { type EnrichedWord, EnrichedWordSchema } from "@/lib/schemas";
import { ENRICHMENT_PROMPT } from "@/prompts";
import type { ModelConfig } from "@/types";
import { buildPrompt, streamChatAsync } from "./llm";

/**
 * 调用 LLM 补全生词的详细信息（未缓存的底层实现）。
 *
 * 失败（请求异常/解析失败）时抛出异常，
 * 由 enrichWord 包装层转换为 null；抛异常而非返回 null 是为了
 * 让 createCachedFetcher 的 rejection 路径自动移除缓存条目，避免缓存失败结果。
 */
async function enrichWithModel(word: string, model: ModelConfig): Promise<EnrichedWord> {
  const prompt = ENRICHMENT_PROMPT(word);
  const messages = buildPrompt("你是一个英语词典助手。", prompt);

  // R1: 复用 streamChatAsync，消除重复的 Promise 包装与 abort 监听器管理
  // （不接收调用者 signal：缓存的共享 Promise 与任何单个调用者的 abort 解耦）
  const fullText = await streamChatAsync(messages, model);

  // R1: 使用 Zod schema 校验，替代手写 isEnrichedWord 类型守卫
  const enriched = extractJsonSafe<EnrichedWord>(fullText, EnrichedWordSchema);
  if (!enriched) throw new Error("parse failed");
  return enriched;
}

/**
 * 缓存请求单元：单词 + 调用时解析出的默认模型。
 * 模型作为请求的一部分进入缓存键（而非仅单词），见 keyFn。
 */
interface EnrichRequest {
  word: string;
  model: ModelConfig;
}

/**
 * enrichWord 结果缓存：同一「单词（忽略大小写）+ 默认模型」只请求一次 LLM。
 *
 * - Promise 去重：并发添加同一单词时共享同一请求
 * - 键含模型 id：切换默认模型后同词重新请求（修复切换后读到旧 provider 缓存的问题）
 * - FIFO 驱逐：最多缓存 200 个单词，避免长会话内存增长
 * - 失败不缓存：rejection 路径自动移除条目，后续调用重新尝试
 */
const enrichWordCache = createCachedFetcher(
  ({ word, model }: EnrichRequest) => enrichWithModel(word, model),
  {
    maxSize: 200,
    keyFn: ({ word, model }) => `${word.toLowerCase()}::${model.id}`,
  },
);

/**
 * 调用 LLM 补全生词的详细信息（音标、释义、搭配、例句）。
 * 用于从阅读页面添加生词时自动填充缺失数据。
 *
 * 结果按「单词（忽略大小写）+ 默认模型」缓存，重复添加同一单词不会重复请求 LLM；
 * 切换默认模型后同词会重新补全。缓存的共享 Promise 不绑定任何调用者的 signal；
 * 本调用者侧的 abort 由 raceWithAbort 独立桥接——单个调用者中止不影响其他等待者与共享请求。
 *
 * @param word - 要补全的英文单词
 * @param signal - 可选的中止信号（仅取消当前等待者）
 * @returns 补全后的词汇数据，失败时返回 null
 */
export async function enrichWord(word: string, signal?: AbortSignal): Promise<EnrichedWord | null> {
  try {
    // 先解析默认模型再进缓存：模型身份参与缓存键；无可用模型时不触碰缓存直接返回 null
    // （与原 no-default-model → null 的静默降级一致）
    const model = await getDefaultModelCached();
    if (!model?.api_key) return null;
    return await raceWithAbort(enrichWordCache.cached({ word, model }), signal);
  } catch (err) {
    // 生词补全失败时 UI 静默降级（词条仅缺音标/例句），但保留日志：
    // 传输异常与解析失败在此可区分排查
    console.warn(`[enrichWord] 补全 "${word}" 失败:`, err);
    return null;
  }
}
