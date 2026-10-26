/**
 * useLlmTask —— 旁路 LLM 任务的单飞（single-flight）原语。
 *
 * 收编 use-graph-data / use-language-detection 这对孪生骨架的手写管线：
 * useAbortable（AbortController 生命周期）+ useStaleGuard（迟到响应守卫）+
 * getDefaultModelCached（模型解析）+ 流式步骤 + extractJsonSafe（Zod 校验），
 * 以及每次 state 写入前手动 isStale(seq) 自检——这些职责统一沉到本原语，
 * 调用方只面对一个 outcome。
 *
 * 深模块契约：
 * - run() 永不 reject：模型加载/流式抛错/解析失败/中止/被取代全部归一为
 *   LlmTaskOutcome，调用方据此一次性映射到自己的 state，无需防御性 try/catch；
 *   原语不持任何业务 state（无 error/loading）——如何展示由调用方决定；
 * - 单飞：新 run 自动取代旧 run。被取代方的 outcome 恒为 superseded（其结果
 *   即使成功也不按 parsed 交付），调用方无需再自行做 stale 自检；
 * - 中止/被取代都是"调用方应放弃"的静默通道，不携带失败信息；
 *   其余失败通道（error / parse-failed / not-configured）各自带调用方可直接
 *   展示的字段。
 *
 * 多步链（如图谱的 摘要→图谱）在 buildText 闭包内自行 await 多次 streamChatAsync；
 * 中止语义：检查 signal.aborted 或捕获 AbortError 后原样抛出即可，由原语归类。
 */
import { useCallback } from "react";
import type { ZodType } from "zod";
import { useAbortable } from "@/hooks/use-abortable";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import { MODEL_NOT_CONFIGURED_MESSAGE } from "@/hooks/use-stream-chat";
import { getDefaultModelCached } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { extractJsonSafe } from "@/lib/parse-utils";
import type { ModelConfig } from "@/types";

/** 单次任务的收尾结果（调用方据此映射到自己的 state）。 */
export type LlmTaskOutcome<T> =
  | { status: "parsed"; data: T }
  | { status: "parse-failed"; rawText: string }
  | { status: "error"; message: string }
  | { status: "not-configured"; message: string }
  | { status: "aborted" }
  | { status: "superseded" };

/** 传给 buildText 的上下文：原语解析好的模型与本次任务的中止信号。 */
export interface LlmTaskRunContext {
  model: ModelConfig;
  signal: AbortSignal;
}

export interface LlmTaskRunOptions<T> {
  /**
   * 用原语解析好的 model 与 signal 构建流式步骤，返回最终的原始文本。
   * 多步链（如图谱的 摘要→图谱）在此闭包内自行 await 多次 streamChatAsync，
   * 各步的 timeoutMs 由闭包自定。中止语义：检查 signal.aborted 或捕获
   * AbortError 后原样抛出即可（由原语归类为 aborted）。
   */
  buildText: (ctx: LlmTaskRunContext) => Promise<string>;
  /** 对最终文本做 extractJsonSafe 校验。 */
  schema: ZodType<T>;
  /**
   * 模型未配置时的错误文案，经 not-configured outcome 外传由调用方展示。
   * 默认 MODEL_NOT_CONFIGURED_MESSAGE（use-stream-chat 的全站唯一来源）；
   * 旁路任务可传自定义文案（如图谱 hook）。
   */
  notConfiguredMessage?: string;
}

export function useLlmTask<T>() {
  const { abort, getSignal } = useAbortable();
  // 请求身份守卫：并发 run 时，旧调用的迟到收尾一律归类为 superseded，
  // 调用方无需再手动 isStale(seq) 自检。与 abort 的分工见 use-stale-guard 文档。
  const { begin, isStale } = useStaleGuard();

  /**
   * 发起一次单飞任务：新 run 自动 supersede 旧 run。永不 reject。
   * 每个提前返回路径都先过 stale（superseded）再过 abort（aborted）分类，
   * outcome 是唯一的失败通道。
   */
  const run = useCallback(
    async (opts: LlmTaskRunOptions<T>): Promise<LlmTaskOutcome<T>> => {
      // 中止旧请求并成为所有者：此后任何新 run 都会使本调用过期
      abort();
      const signal = getSignal();
      const seq = begin();

      // ── 模型解析（收编自孪生骨架各自的 getDefaultModelCached 前置步骤）──
      let model: ModelConfig | null | undefined;
      try {
        model = await getDefaultModelCached();
      } catch (err) {
        // 预检 IPC 拒绝（db 命令失败/序列化异常）不逃逸成 unhandled rejection，
        // 与 use-stream-chat 的 execute 预检兜底同语义
        if (isStale(seq)) return { status: "superseded" };
        if (signal.aborted) return { status: "aborted" };
        return { status: "error", message: getErrorMessage(err, "加载模型配置失败") };
      }
      if (isStale(seq)) return { status: "superseded" };
      if (signal.aborted) return { status: "aborted" };
      if (!model?.api_key) {
        // 原语不持错误 state：文案经 outcome 外传，调用方决定怎么展示
        return {
          status: "not-configured",
          message: opts.notConfiguredMessage ?? MODEL_NOT_CONFIGURED_MESSAGE,
        };
      }

      // ── 流式步骤（多步链在闭包内自行编排） ──
      let rawText: string;
      try {
        rawText = await opts.buildText({ model, signal });
      } catch (err) {
        if (isStale(seq)) return { status: "superseded" };
        if (signal.aborted) return { status: "aborted" };
        return { status: "error", message: getErrorMessage(err, "LLM 请求失败") };
      }

      // ── 迟到结果在解析前即丢弃（过期调用连解析都不必做） ──
      if (isStale(seq)) return { status: "superseded" };
      if (signal.aborted) return { status: "aborted" };

      const parsed = extractJsonSafe(rawText, opts.schema);
      if (parsed) return { status: "parsed", data: parsed };
      return { status: "parse-failed", rawText };
    },
    [abort, getSignal, begin, isStale],
  );

  /** 中止在途任务：被取消的 run 若仍是所有者（期间无新 run），outcome 为 aborted。 */
  const cancel = useCallback(() => {
    abort();
  }, [abort]);

  return { run, cancel };
}
