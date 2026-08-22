/**
 * @module use-connection-test
 * @description 新手引导第 2 步的"测试 API 连接"逻辑 hook（自 OnboardingDialog 抽出）。
 */

import { useCallback, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { getErrorMessage } from "@/lib/error-utils";
import { isLocalBaseUrl, testLLMConnection } from "@/services/llm";

export type TestResult = "success" | "error";

interface UseConnectionTestOptions {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/**
 * 测试连接状态管理。
 * C4: 复用 useAbortable 管理测试连接的 AbortController 生命周期
 * （自动处理卸载中止与重入中止）。
 */
export function useConnectionTest({ baseUrl, apiKey, modelName }: UseConnectionTestOptions) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState("");

  const { abort: abortTest, getSignal: getTestSignal } = useAbortable();

  /** 测试 API 连接：发送一条简单的 chat completion 请求 */
  const handleTestConnection = useCallback(async () => {
    // 本地服务无需 API Key（文案推荐 Ollama，强制要求 Key 会把本地模型用户卡在引导里）
    if (!baseUrl || !modelName) return;
    if (!apiKey && !isLocalBaseUrl(baseUrl)) return;
    abortTest();
    const signal = getTestSignal();

    setTesting(true);
    setTestResult(null);
    setTestError("");

    try {
      await testLLMConnection({ baseUrl, apiKey, modelName, signal });
      setTestResult("success");
    } catch (err) {
      if (signal.aborted) return;
      setTestResult("error");
      setTestError(getErrorMessage(err, "连接失败"));
    } finally {
      if (!signal.aborted) setTesting(false);
    }
  }, [baseUrl, apiKey, modelName, abortTest, getTestSignal]);

  /** 输入变化后清除上次的测试结果 */
  const clearTestResult = useCallback(() => setTestResult(null), []);

  return { testing, testResult, testError, handleTestConnection, clearTestResult };
}
