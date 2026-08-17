/**
 * LLM 服务层 —— 封装与 OpenAI 兼容 API 的 SSE 流式通信。
 *
 * 核心设计：
 * 1. **Rust 代理优先（A1）**：请求由 Rust 侧命令发起（密钥从 OS Keychain 读取，
 *    不下发 WebView），SSE token 经 Tauri Channel 推回。前端不再直连任意 HTTPS
 *    端点（capabilities http scope 与 CSP 已收窄为本地回环）。
 * 2. 降级通道：代理不可用时（如开发环境/插件异常），回退 WebView 侧
 *    smartFetch 双通道（tauri-plugin-http → 内置 fetch）。
 * 3. SSE 流式解析：手动解析 `data:` 前缀的 Server-Sent Events（兼容无空格写法）。
 * 4. 全程支持 AbortSignal：用户切换输入或重新提交时，可中止正在进行的请求。
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { createCachedFetcher } from "@/lib/cache";
import { getDefaultModelCached } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { delayWithAbort, smartFetch, withTimeout } from "@/lib/fetch-utils";
import { extractJsonSafe } from "@/lib/parse-utils";
import { type EnrichedWord, EnrichedWordSchema } from "@/lib/schemas";
import type { ModelConfig } from "@/types";

/** OpenAI Chat Completions API 的消息格式 */
export interface LLMMessage {
  /** 消息角色：system（系统指令）、user（用户输入）、assistant（模型回复） */
  role: "system" | "user" | "assistant";
  /** 消息文本内容 */
  content: string;
}

/**
 * 流式传输回调接口。
 *
 * 设计为三个分离的回调而非返回 AsyncIterator，原因是：
 * - 回调模式更容易与 React state 更新集成（直接 setState）
 * - AbortSignal 中止时需要静默退出，回调模式下不调用 onDone 即可
 * - onError 统一处理两种 fetch 通道的错误
 */
export interface StreamCallbacks {
  onToken: (token: string) => void; // 每收到一个 token 调用一次
  onDone: (fullText: string) => void; // 流结束时调用，传入完整文本
  onError: (error: Error) => void; // 请求失败时调用
}

/**
 * 解析单行 SSE 数据。
 *
 * SSE 格式：每行以 "data: " 前缀开头，数据为 JSON 或 "[DONE]" 标记。
 * 空行是 SSE 规范中的事件分隔符，直接跳过。
 *
 * @param line - 原始 SSE 行
 * @param state - 可变状态对象，累积完整文本（避免在调用链中层层传递）
 * @returns token 为单次增量文本，done 表示流结束
 */
/** 解析单个 SSE data 负载(已拼接多行的完整数据)。 */
function dispatchSSEData(
  data: string,
  state: { fullText: string },
): { token?: string; done?: boolean } {
  if (data === "[DONE]") return { done: true };
  try {
    const parsed = JSON.parse(data);
    const content = parsed.choices?.[0]?.delta?.content;
    if (content) {
      state.fullText += content;
      return { token: content };
    }
  } catch {
    // 忽略非 JSON 负载（注释行、心跳等）
  }
  return {};
}

/**
 * 解析单行 SSE 数据(单行事件场景,保持向后兼容)。
 *
 * 多行 data 字段(规范允许,代理/网关可能改写)由 readSSEStream 的事件
 * 状态机处理(E1):同一事件的多个 data: 行以 \n 拼接后一次性解析。
 */
/** Exported for unit testing. */
export function processSSELine(
  line: string,
  state: { fullText: string },
): { token?: string; done?: boolean } {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return {};
  // SSE 规范允许字段名后无空格（"data:[DONE]"、`data:{...}` 均合法），
  // 剥去字段名后至多移除一个前导空格（此前严格要求 "data: " 会导致静默丢事件）
  const rest = trimmed.slice(5);
  const data = rest.startsWith(" ") ? rest.slice(1) : rest;
  return dispatchSSEData(data, state);
}

/** 逐行驱动的 SSE 事件状态机(E1):累积同一事件的多个 data: 行,
 *  空行定界触发事件(规范:data 字段多行以 \n 拼接,事件间以空行分隔)。 */
function createSSEProcessor(state: { fullText: string }) {
  let pendingData = "";

  /** 处理一行;空行触发事件分发。返回该行产生的事件结果(token/done),无事件返回 null。 */
  const feed = (rawLine: string): { token?: string; done?: boolean } | null => {
    const line = rawLine.trim();
    if (line === "") {
      // 空行 = 事件结束
      if (pendingData === "") return null;
      const result = dispatchSSEData(pendingData, state);
      pendingData = "";
      return result;
    }
    if (line.startsWith("data:")) {
      const rest = line.slice(5);
      const data = rest.startsWith(" ") ? rest.slice(1) : rest;
      pendingData = pendingData === "" ? data : `${pendingData}\n${data}`;
    }
    return null;
  };

  /** 流结束时的收尾:处理未定界的残留事件。 */
  const flush = (): { token?: string; done?: boolean } | null => {
    if (pendingData === "") return null;
    const result = dispatchSSEData(pendingData, state);
    pendingData = "";
    return result;
  };

  return { feed, flush };
}

/**
 * 读取 SSE 流式响应。
 *
 * 两条代码路径：
 * 1. ReadableStream 可用时（现代浏览器/Tauri WebView）：逐块读取，
 *    使用 buffer 处理跨块的不完整行（TCP 分包不保证对齐 SSE 行边界）。
 * 2. 回退到 response.text()：一次性读取全部内容再按行分割。
 *
 * AbortSignal 中止时，主动 cancel() reader 释放网络连接，
 * 同时通过 finally 块清理 abort 事件监听器，防止内存泄漏。
 *
 * 注意：即使流正常结束但没有收到 [DONE] 标记（某些 API 的行为），
 * 仍然调用 onDone 回调，确保上层逻辑能正常收尾。
 */
/** Exported for unit testing. */
export async function readSSEStream(
  response: Response,
  callbacks: Pick<StreamCallbacks, "onToken" | "onDone">,
  signal?: AbortSignal,
): Promise<void> {
  const state = { fullText: "" };
  const reader = response.body?.getReader();

  if (reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    const processor = createSSEProcessor(state);

    // 当 abort 信号触发时，主动取消 reader 以释放网络连接资源
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        if (signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const result = processor.feed(line);
          if (result?.done) {
            callbacks.onDone(state.fullText);
            // [DONE] 提前返回时释放 reader 与底层流——未 cancel 的 reader
            // 会占住 HTTP 连接直到服务端关闭或 GC
            reader.cancel().catch(() => {});
            return;
          }
          if (result?.token) callbacks.onToken(result.token);
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    // 流正常结束但未收到 [DONE] 标记（某些 API 的行为）—— 处理剩余 buffer 并调用 onDone
    if (!signal?.aborted) {
      if (buffer.trim()) {
        const tail = processor.feed(buffer);
        if (tail?.token) callbacks.onToken(tail.token);
      }
      const tail = processor.flush();
      if (tail?.token) callbacks.onToken(tail.token);
      callbacks.onDone(state.fullText);
    }
  } else {
    const text = await response.text();
    const processor = createSSEProcessor(state);
    for (const line of text.split("\n")) {
      const result = processor.feed(line);
      if (result?.done) {
        callbacks.onDone(state.fullText);
        return;
      }
      if (result?.token) callbacks.onToken(result.token);
    }
    const tail = processor.flush();
    if (tail?.token) callbacks.onToken(tail.token);
    callbacks.onDone(state.fullText);
  }
}

/**
 * 构建 OpenAI 兼容 API 的请求体。
 *
 * 所有 OpenAI 兼容 API（DeepSeek、Ollama、vLLM 等）共用同一请求格式，
 * 差异仅在 base_url 和 model_name 上，由 ModelConfig 配置。
 * `stream: true` 启用 SSE 流式返回。
 */
function makeRequestBody(model: ModelConfig, messages: LLMMessage[]) {
  return {
    method: "POST" as const,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.api_key}`,
    },
    body: JSON.stringify({
      model: model.model_name,
      messages,
      stream: true,
    }),
  };
}

/**
 * Rust 代理流式请求（A1）：密钥不出主进程。
 *
 * 通过 Tauri Channel 接收 Rust 侧推送的 Token/Done/Error 事件。
 * invoke 支持 AbortSignal（Tauri 2）：abort 会取消命令执行。
 *
 * @returns "done" - 代理路径成功完成（含 onDone 回调）
 *          "api-error" - 代理侧业务错误，已调用 onError，视为终态（不应降级，
 *            否则同一请求重复发送且 onError 已被调用后仍可能触发 onToken/onDone）
 *          "unavailable" - 代理不可用（未配置 ID/命令异常/中止），调用方可降级
 */
async function proxyStreamChat(
  messages: LLMMessage[],
  model: ModelConfig,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  timeoutMs: number = 120000,
): Promise<"done" | "api-error" | "unavailable"> {
  // 代理需要模型的数据库 ID（密钥由 Rust 按 ID 从 Keychain 读取）
  if (model.id == null) return "unavailable";

  return new Promise<"done" | "api-error" | "unavailable">((resolve) => {
    // Tauri 2 invoke 的 signal 选项：abort 时命令被取消
    if (signal?.aborted) {
      resolve("unavailable");
      return;
    }

    const channel = new Channel<{
      type: "token" | "done" | "error";
      token?: string;
      fullText?: string;
      message?: string;
    }>();
    let fullText = "";
    let settled = false;

    // abort 时停止接收事件并结束代理路径。
    // 注:当前 @tauri-apps/api 的 invoke 不支持 AbortSignal 取消命令,
    // Rust 侧请求会继续跑完(有 timeout 兜底);resolve("unavailable") 后由
    // 降级路径入口的 `if (signal?.aborted) return;` 静默收尾
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve("unavailable");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    channel.onmessage = (event) => {
      if (event.type === "token" && event.token) {
        fullText += event.token;
        callbacks.onToken(event.token);
      } else if (event.type === "done") {
        if (settled) return;
        settled = true;
        callbacks.onDone(event.fullText ?? fullText);
        resolve("done");
      } else if (event.type === "error") {
        if (settled) return;
        settled = true;
        callbacks.onError(new Error(event.message ?? "LLM 请求失败"));
        // 代理侧业务错误已回调 onError,视为终态;不再降级 WebView fetch,
        // 避免同一请求重复发送与"先报错后出结果"的双回调
        resolve("api-error");
      }
    };

    invoke("db_stream_chat_completions", {
      modelId: model.id,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      timeoutMs,
      onEvent: channel,
    }).catch((err) => {
      if (settled) return;
      settled = true;
      // 命令本身失败（模型不存在/配置缺失/通道异常）→ 代理不可用,降级
      console.warn("[llm] proxy unavailable, falling back to WebView fetch:", err);
      resolve("unavailable");
    });
  });
}

/**
 * 发起 LLM 流式聊天请求。
 *
 * 双通道策略（A1 升级）：
 * 1. 优先 Rust 代理命令（密钥不出主进程,Channel 流式推送）
 * 2. 代理不可用时回退 WebView 侧 fetch 双通道（smartFetch）
 *
 * AbortSignal 贯穿整个调用链；中止时静默返回（不调用 onError），
 * 因为中止是用户主动行为，不是错误。
 *
 * @param messages - 对话消息数组，通常由 buildPrompt() 构建
 * @param model - 模型配置（API 地址、密钥、模型名）
 * @param callbacks - 流式回调（onToken/onDone/onError）
 * @param signal - 可选的中止信号，由 AbortController 提供
 */
export async function streamChat(
  messages: LLMMessage[],
  model: ModelConfig,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  timeoutMs: number = 120000,
): Promise<void> {
  if (signal?.aborted) return;

  // A1: 主路径走 Rust 代理。代理完成（含代理侧业务报错，onError 已回调）即返回;
  // 仅当代理不可用(invoke 失败/未配置 ID)时降级 WebView fetch
  try {
    const outcome = await proxyStreamChat(messages, model, callbacks, signal, timeoutMs);
    if (outcome !== "unavailable") return;
  } catch {
    // 兜底:代理异常一律降级
  }

  const url = `${model.base_url}/chat/completions`;
  const init = makeRequestBody(model, messages);

  // 降级路径入口:代理阶段可能已跨过 abort 检查
  if (signal?.aborted) return;

  // R8: 使用 withTimeout 合并外部 abort 信号与超时控制器
  const { signal: combinedSignal, isTimeout, cleanup } = withTimeout(timeoutMs, signal);

  // 超时触发时（非用户主动中止）必须显式调用 onError 后再返回，
  // 否则回调式调用方的 Promise 永远挂起（P0 回归：此前在这些检查点静默 return）。
  // 用户主动中止（外部 signal aborted）仍保持静默返回的既有语义。
  const abortOrTimeout = (): boolean => {
    if (signal?.aborted) return true;
    if (isTimeout()) {
      callbacks.onError(new Error(`请求超时（${timeoutMs / 1000}秒）`));
      return true;
    }
    return false;
  };

  try {
    // TD-4: fetch 阶段单次重试 —— 仅对网络错误和 5xx 状态码重试一次（间隔 2 秒），
    // SSE 流开始后不重试（避免已推送 token 的状态混乱）。4xx 错误（auth/参数错误）直接失败。
    let response: Response;
    try {
      response = await smartFetch(url, { ...init, signal: combinedSignal });
    } catch (firstErr) {
      if (signal?.aborted) return;
      if (isTimeout()) throw firstErr;
      // 网络错误：等待 2 秒后重试一次（可被 AbortSignal 中断）
      await delayWithAbort(2000, combinedSignal);
      if (abortOrTimeout()) return;
      response = await smartFetch(url, { ...init, signal: combinedSignal });
    }

    // 5xx 状态码：等待 2 秒后重试一次（可被 AbortSignal 中断）
    if (response.ok === false && response.status >= 500) {
      if (signal?.aborted) return;
      // 释放上一个响应的 body（未消费的响应体会占住连接池）
      await response.body?.cancel().catch(() => {});
      await delayWithAbort(2000, combinedSignal);
      if (abortOrTimeout()) return;
      response = await smartFetch(url, { ...init, signal: combinedSignal });
    }

    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
    }

    if (abortOrTimeout()) return;
    await readSSEStream(response, callbacks, combinedSignal);
    // 流式过程中触发超时:readSSEStream 内部静默返回(跳过 onDone),
    // 此处必须再查一次,否则 onError 永远不触发、调用方 Promise 永久挂起
    if (abortOrTimeout()) return;
  } catch (error) {
    if (signal?.aborted) return;
    if (isTimeout()) {
      callbacks.onError(new Error(`请求超时（${timeoutMs / 1000}秒）`));
      return;
    }
    const err = error instanceof Error ? error : new Error(getErrorMessage(error));
    callbacks.onError(err);
  } finally {
    cleanup();
  }
}

/**
 * 用 Promise 包装 streamChat，支持 async/await 顺序调用。
 *
 * 消除 useGraphData / useLanguageDetection 等调用方重复的 Promise 包装样板。
 * 返回完整的流式文本；出错时 reject。
 *
 * @param messages  - 消息数组
 * @param model     - 模型配置
 * @param signal    - 可选的中止信号
 * @param timeoutMs - 超时毫秒数（默认 120s）
 * @returns 完整的流式响应文本
 */
export function streamChatAsync(
  messages: LLMMessage[],
  model: ModelConfig,
  signal?: AbortSignal,
  timeoutMs: number = 120000,
): Promise<string> {
  // H-1 补充：对"已中止"的 signal，addEventListener 不会触发 abort 事件，
  // 且 streamChat 入口也会静默 return —— 必须在此直接 reject，否则 Promise 永不 settle。
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    // H-1: 当 signal abort 时，streamChat 可能静默 return 而不调用任何回调，
    // 导致 Promise 永远 pending。注册 abort 监听器确保 Promise 一定 settle。
    const onAbort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    streamChat(
      messages,
      model,
      {
        onToken: () => {},
        onDone: (text) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(text);
        },
        onError: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      },
      signal,
      timeoutMs,
    );
  });
}

/**
 * 构建标准的 system + user 双消息 prompt。
 *
 * 所有 LLM 功能（写作/阅读/口语/听力/练习）都使用此函数构建消息数组。
 * system prompt 在各页面组件中定义，包含功能特定的指令（如"以 JSON 格式返回纠错结果"）。
 */
export function buildPrompt(systemPrompt: string, userContent: string): LLMMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

/**
 * 调用 LLM 补全生词的详细信息（未缓存的底层实现）。
 *
 * 失败（模型未配置/请求异常/解析失败）时抛出异常，
 * 由 enrichWord 包装层转换为 null；抛异常而非返回 null 是为了
 * 让 createCachedFetcher 的 rejection 路径自动移除缓存条目，避免缓存失败结果。
 */
async function enrichWordUncached(word: string, signal?: AbortSignal): Promise<EnrichedWord> {
  const model = await getDefaultModelCached();
  if (!model?.api_key) throw new Error("no default model");

  const prompt = `请为以下英文单词提供详细信息。严格按 JSON 格式输出，不要用 markdown 代码块包裹：
{
  "phonetic": "音标（如 /wɜːrd/）",
  "definition": "中文释义（简洁准确）",
  "collocations": "常见搭配（2-3个，用逗号分隔）",
  "example": "一个地道的英文例句"
}
单词：${word}`;

  const messages = buildPrompt("你是一个英语词典助手。", prompt);

  // R1: 复用 streamChatAsync，消除重复的 Promise 包装与 abort 监听器管理
  const fullText = await streamChatAsync(messages, model, signal);

  // R1: 使用 Zod schema 校验，替代手写 isEnrichedWord 类型守卫
  const enriched = extractJsonSafe<EnrichedWord>(fullText, EnrichedWordSchema);
  if (!enriched) throw new Error("parse failed");
  return enriched;
}

/**
 * enrichWord 结果缓存：同一单词（忽略大小写）只请求一次 LLM。
 *
 * - Promise 去重：并发添加同一单词时共享同一请求
 * - FIFO 驱逐：最多缓存 200 个单词，避免长会话内存增长
 * - 失败不缓存：rejection 路径自动移除条目，后续调用重新尝试
 */
const enrichWordCache = createCachedFetcher(enrichWordUncached, {
  maxSize: 200,
  keyFn: (word) => String(word).toLowerCase(),
});

/**
 * 调用 LLM 补全生词的详细信息（音标、释义、搭配、例句）。
 * 用于从阅读页面添加生词时自动填充缺失数据。
 *
 * 结果按单词（忽略大小写）缓存，重复添加同一单词不会重复请求 LLM。
 *
 * @param word - 要补全的英文单词
 * @returns 补全后的词汇数据，失败时返回 null
 */
export async function enrichWord(word: string, signal?: AbortSignal): Promise<EnrichedWord | null> {
  try {
    return await enrichWordCache.cached(word, signal);
  } catch (err) {
    // 生词补全失败时 UI 静默降级（词条仅缺音标/例句），但保留日志：
    // "no default model"（配置问题）与解析失败在此可区分排查
    console.warn(`[enrichWord] 补全 "${word}" 失败:`, err);
    return null;
  }
}
