/**
 * LLM 服务层 —— 封装与 OpenAI 兼容 API 的 SSE 流式通信。
 *
 * 核心设计：
 * 1. 双通道 fetch 策略：优先使用 Tauri 原生 HTTP 插件（绕过 CORS），
 *    失败时回退到 WebView 内置 fetch（需要服务端允许 CORS）。
 * 2. SSE 流式解析：手动解析 `data: ` 前缀的 Server-Sent Events，
 *    不依赖浏览器的 EventSource API（因为需要 POST 请求和自定义 Header）。
 * 3. 全程支持 AbortSignal：用户切换输入或重新提交时，可中止正在进行的请求。
 */
import { smartFetch } from "@/lib/fetch-utils";
import { extractJson } from "@/lib/parse-utils";
import { getDefaultModel } from "@/lib/db";
import type { ModelConfig } from "@/types";

/** OpenAI Chat Completions API 的消息格式 */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
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
  onToken: (token: string) => void;    // 每收到一个 token 调用一次
  onDone: (fullText: string) => void;  // 流结束时调用，传入完整文本
  onError: (error: Error) => void;     // 请求失败时调用
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
function processSSELine(
  line: string,
  state: { fullText: string }
): { token?: string; done?: boolean } {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data: ")) return {};
  const data = trimmed.slice(6);
  if (data === "[DONE]") return { done: true };
  try {
    const parsed = JSON.parse(data);
    const content = parsed.choices?.[0]?.delta?.content;
    if (content) {
      state.fullText += content;
      return { token: content };
    }
  } catch {
    // Ignore non-JSON lines in SSE stream
  }
  return {};
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
async function readSSEStream(
  response: Response,
  callbacks: Pick<StreamCallbacks, "onToken" | "onDone">,
  signal?: AbortSignal
): Promise<void> {
  const state = { fullText: "" };
  const reader = response.body?.getReader();

  if (reader) {
    const decoder = new TextDecoder();
    let buffer = "";

    // Cancel reader when signal aborts
    const onAbort = () => { reader.cancel().catch(() => {}); };
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
          const result = processSSELine(line, state);
          if (result.done) {
            callbacks.onDone(state.fullText);
            return;
          }
          if (result.token) callbacks.onToken(result.token);
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    // Stream ended without [DONE] marker — still call onDone
    if (!signal?.aborted) {
      callbacks.onDone(state.fullText);
    }
  } else {
    const text = await response.text();
    for (const line of text.split("\n")) {
      const result = processSSELine(line, state);
      if (result.done) {
        callbacks.onDone(state.fullText);
        return;
      }
      if (result.token) callbacks.onToken(result.token);
    }
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
 * 发起 LLM 流式聊天请求。
 *
 * 双通道 fetch 策略：
 * 1. 优先使用 tauriFetch（Tauri HTTP 插件）—— 绕过浏览器 CORS 限制，
 *    通过 capabilities/default.json 中的 URL scope 控制允许访问的域名。
 * 2. 如果 tauriFetch 失败（如插件未加载、URL 不在白名单），
 *    回退到 WebView 内置 fetch —— 需要目标 API 服务端允许 CORS。
 *
 * AbortSignal 贯穿整个调用链：在 fetch、readSSEStream、以及各检查点都支持中止。
 * 中止时静默返回（不调用 onError），因为中止是用户主动行为，不是错误。
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
  signal?: AbortSignal
): Promise<void> {
  const url = `${model.base_url}/chat/completions`;
  const init = makeRequestBody(model, messages);

  if (signal?.aborted) return;

  try {
    const response = await smartFetch(url, { ...init, signal });

    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
    }

    if (signal?.aborted) return;
    await readSSEStream(response, callbacks, signal);
  } catch (error) {
    if (signal?.aborted) return;
    const err =
      error instanceof Error
        ? error
        : new Error(String(error));
    callbacks.onError(err);
  }
}

/**
 * 构建标准的 system + user 双消息 prompt。
 *
 * 所有 LLM 功能（Writing/Reading Copilot）都使用此函数构建消息数组。
 * system prompt 在各页面组件中定义，包含功能特定的指令（如"以 JSON 格式返回纠错结果"）。
 */
export function buildPrompt(
  systemPrompt: string,
  userContent: string
): LLMMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

/** enrichWord 的返回结构 */
export interface EnrichedWord {
  phonetic: string;
  definition: string;
  collocations: string;
  example: string;
}

/** enrichWord 的 JSON 校验器 */
function isEnrichedWord(data: unknown): data is EnrichedWord {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.phonetic === "string" &&
    typeof obj.definition === "string" &&
    typeof obj.collocations === "string" &&
    typeof obj.example === "string"
  );
}

/**
 * 调用 LLM 补全生词的详细信息（音标、释义、搭配、例句）。
 * 用于从阅读页面添加生词时自动填充缺失数据。
 *
 * @param word - 要补全的英文单词
 * @returns 补全后的词汇数据，失败时返回 null
 */
export async function enrichWord(word: string): Promise<EnrichedWord | null> {
  const model = await getDefaultModel();
  if (!model?.api_key) return null;

  const prompt = `请为以下英文单词提供详细信息。严格按 JSON 格式输出，不要用 markdown 代码块包裹：
{
  "phonetic": "音标（如 /wɜːrd/）",
  "definition": "中文释义（简洁准确）",
  "collocations": "常见搭配（2-3个，用逗号分隔）",
  "example": "一个地道的英文例句"
}
单词：${word}`;

  const messages = buildPrompt("你是一个英语词典助手。", prompt);

  let fullText = "";
  try {
    await new Promise<void>((resolve, reject) => {
      streamChat(
        messages,
        model,
        {
          onToken: () => {}, // 不需要流式显示
          onDone: (text) => {
            fullText = text;
            resolve();
          },
          onError: (err) => reject(err),
        }
      );
    });
  } catch {
    return null;
  }

  return extractJson<EnrichedWord>(fullText, isEnrichedWord);
}
