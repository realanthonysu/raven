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
 *
 * `signal`（S-17）会传给 `streamChatAsync`：批量补全取消时真正中止底层 LLM 请求，
 * 而不是仅在等待者侧放弃结果。注意它绑定的是缓存的共享 Promise——若两个调用者
 * 同时请求同一「单词+模型」，其中一个 abort 会取消共享请求，另一个也会收到
 * AbortError（这是为避免“假取消”而接受的共享语义；单条补全默认不传 signal）。
 */
async function enrichWithModel(
  word: string,
  model: ModelConfig,
  signal?: AbortSignal,
): Promise<EnrichedWord> {
  const prompt = ENRICHMENT_PROMPT(word);
  const messages = buildPrompt("你是一个英语词典助手。", prompt);

  // R1: 复用 streamChatAsync；S-17 起透传 signal 以支持批量取消。
  const fullText = await streamChatAsync(messages, model, signal);

  // R1: 使用 Zod schema 校验，替代手写 isEnrichedWord 类型守卫
  const enriched = extractJsonSafe<EnrichedWord>(fullText, EnrichedWordSchema);
  if (!enriched) throw new Error("parse failed");
  return enriched;
}

/**
 * 缓存请求单元：单词 + 调用时解析出的默认模型 + 可选中止信号。
 * 模型作为请求的一部分进入缓存键（而非仅单词），见 keyFn；signal 不入 key。
 */
interface EnrichRequest {
  word: string;
  model: ModelConfig;
  signal?: AbortSignal;
}

/**
 * enrichWord 结果缓存：同一「单词（忽略大小写）+ 默认模型」只请求一次 LLM。
 *
 * - Promise 去重：并发添加同一单词时共享同一请求
 * - 键含模型 id：切换默认模型后同词重新请求（修复切换后读到旧 provider 缓存的问题）
 * - FIFO 驱逐：最多缓存 200 个单词，避免长会话内存增长
 * - 失败不缓存：rejection 路径自动移除条目，后续调用重新尝试
 *
 * S-17 取消语义：signal 只影响共享 Promise 的底层请求，不进入缓存键；若批量补全
 * abort 了已存在的共享请求，该缓存条目随 rejection 移除，后续单条补全会重新请求。
 */
const enrichWordCache = createCachedFetcher(
  ({ word, model, signal }: EnrichRequest) => enrichWithModel(word, model, signal),
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
 * 切换默认模型后同词会重新补全。S-17 起 signal 会透传到缓存 fetcher（以及底层
 * `streamChatAsync`），批量场景可真正取消在途 LLM 请求；单条补全默认不传 signal。
 *
 * @param word - 要补全的英文单词
 * @param signal - 可选的中止信号（取消共享的底层请求；调用者自身会得到 null）
 * @returns 补全后的词汇数据，失败时返回 null
 */
export async function enrichWord(word: string, signal?: AbortSignal): Promise<EnrichedWord | null> {
  try {
    // 已中止的调用不发起模型查询/缓存请求
    if (signal?.aborted) return null;
    // 先解析默认模型再进缓存：模型身份参与缓存键；无可用模型时不触碰缓存直接返回 null
    // （与原 no-default-model → null 的静默降级一致）
    const model = await getDefaultModelCached();
    if (signal?.aborted) return null;
    if (!model?.api_key) return null;
    return await enrichWordCache.cached({ word, model, signal });
  } catch (err) {
    // 生词补全失败时 UI 静默降级（词条仅缺音标/例句），但保留日志：
    // 传输异常与解析失败在此可区分排查
    console.warn(`[enrichWord] 补全 "${word}" 失败:`, err);
    return null;
  }
}
