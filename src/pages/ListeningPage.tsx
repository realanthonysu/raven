/**
 * @module ListeningPage
 * @description 听力练习页面（Listening Copilot）。
 *
 * 通过 TTS 播放 LLM 生成的英文句子，用户进行听写练习。
 * 四阶段状态机流程：
 * 1. idle — 用户选择难度和主题
 * 2. loading — 调用 LLM 生成 5 个英文句子
 * 3. listening — 逐句播放 TTS 音频，用户听写输入，支持查看中文提示
 * 4. review — 统一展示听写结果，计算得分并持久化到 history 表
 *
 * 主要特性：
 * - TTS 音频播放（useAudioPlayer）
 * - 中文提示辅助
 * - 模糊匹配判定（matchAnswerDetail）
 * - 30 秒超时提示（useRetryHint）
 */

import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Headphones,
  Lightbulb,
  Loader2,
  RotateCcw,
  Volume2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { ErrorBanner, WarningBanner } from "@/components/page-states";
import { ProgressBar } from "@/components/progress-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { useRetryHint } from "@/hooks/use-retry-hint";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { addHistorySafe, recordLearningActivitySafe } from "@/lib/db";
import { extractJson, matchAnswerDetail } from "@/lib/parse-utils";
import { DIFFICULTIES, isCustomTopic, TOPICS } from "@/lib/practice-options";
import { ListeningSentenceSchema } from "@/lib/schemas";
import { LISTENING_PROMPT } from "@/prompts";
import type { ListeningResult, ListeningSentence } from "@/types";

/** 听力练习的四个阶段：等待开始 → 加载生成 → 听写作答 → 结果回顾 */
type Phase = "idle" | "loading" | "listening" | "review";

/**
 * 听力练习页面（ListeningPage）。
 *
 * 三阶段流程：
 * 1. loading — 用户选择难度和主题，LLM 生成 5 个英文句子
 * 2. listening — 逐句播放 TTS，用户听写输入，可查看中文提示
 * 3. review — 统一展示所有句子的听写结果，计算得分并持久化
 *
 * 完成后将结果持久化到 history 表（type="listening"）。
 */
export default function ListeningPage() {
  // 状态机：管理 loading → listening → review 三阶段切换
  const { phase, transition, setPhase } = usePhaseMachine<Phase>("idle", {
    onEnter: {
      idle: () => {
        setError(null);
      },
      loading: () => {
        setError(null);
        setSaveError(null);
      },
    },
  });
  const [difficulty, setDifficulty] = useState<string>("初级"); // 当前选择的难度级别
  const difficultyRef = useRef<string>("初级");
  const [topic, setTopic] = useState("日常对话"); // 听力句子的主题
  const [sentences, setSentences] = useState<ListeningSentence[]>([]); // LLM 生成的句子列表
  const [currentIndex, setCurrentIndex] = useState(0); // 当前听写的句子索引
  const [userInputs, setUserInputs] = useState<string[]>([]); // 用户对每句的听写输入
  const [error, setError] = useState<string | null>(null); // 错误信息（生成失败等）
  /** 历史记录保存失败的非阻断提示（ExercisePage/SpeakingPage 同款模式） */
  const [saveError, setSaveError] = useState<string | null>(null);
  // 30 秒超时提示：加载超过 30 秒后显示"重新生成"建议
  const { showRetryHint } = useRetryHint(phase === "loading");
  const [score, setScore] = useState(0); // 听写正确句数
  const [showHint, setShowHint] = useState(false); // 是否显示当前句子的中文提示
  const { playing, play, stop } = useAudioPlayer(); // TTS 音频播放器

  const { execute, abort } = useStreamChat("listening");

  /**
   * 调用 LLM 生成听力句子。
   * 发送 LISTENING_PROMPT，解析返回的 JSON，初始化用户输入数组，
   * 然后切换到 listening 阶段。解析失败时设置错误并回退到 loading。
   */
  const generateSentences = useCallback(async () => {
    const prompt = LISTENING_PROMPT(difficultyRef.current, topic);

    await execute(prompt, "", {
      onToken: () => {},
      onDone: (fullText) => {
        try {
          const parsed = extractJson<{ sentences: ListeningSentence[] }>(
            fullText,
            (d): d is { sentences: ListeningSentence[] } =>
              z.object({ sentences: z.array(ListeningSentenceSchema).nonempty() }).safeParse(d)
                .success,
          );
          if (!parsed) throw new Error("parse failed");
          setSentences(parsed.sentences);
          setUserInputs(new Array(parsed.sentences.length).fill(""));
          setCurrentIndex(0);
          transition("listening");
        } catch {
          setError("生成失败，请重试。");
          setPhase("idle");
        }
      },
      onError: (err) => {
        setError(err.message);
        setPhase("idle");
      },
    });
  }, [topic, execute, transition, setPhase]);

  /**
   * 进入 loading 阶段时自动生成句子。
   * 30 秒超时提示由 useRetryHint hook 管理。
   * 清理时取消未完成的请求。
   */
  useEffect(() => {
    if (phase !== "loading" || error) return;

    abort();

    generateSentences();

    return () => {
      abort();
    };
  }, [phase, error, generateSentences, abort]);

  // 组件卸载时中止所有进行中的 LLM 请求（包括词汇提取）
  useEffect(() => {
    return () => {
      abort();
    };
  }, [abort]);

  /**
   * 用户点击难度按钮后触发。
   * 设置难度并切换到 loading 阶段，自动触发 generateSentences。
   */
  function handleStart(diff: string) {
    difficultyRef.current = diff;
    setDifficulty(diff);
    transition("loading");
  }

  /**
   * 重试：回到 idle 阶段，用户重新选择难度/主题后手动开始。
   */
  function handleRetry() {
    setError(null);
    transition("idle");
  }

  /**
   * 更新指定句子索引的用户听写输入。
   * 采用不可变更新方式复制数组后修改对应位置。
   */
  function setInput(index: number, value: string) {
    setUserInputs((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  /**
   * 导航到下一句并自动播放 TTS。
   * 到达最后一句时按钮变为"提交"，不再调用此函数。
   */
  function handleNext() {
    if (currentIndex < sentences.length - 1) {
      const next = currentIndex + 1;
      setCurrentIndex(next);
      setShowHint(false);
      play(sentences[next].text);
    }
  }

  /** 导航到上一句，隐藏当前提示。 */
  function handlePrev() {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setShowHint(false);
    }
  }

  /**
   * 提交所有听写结果。
   * 停止正在播放的音频，逐句用 matchAnswer 比对用户输入与正确答案，
   * 计算正确句数后切换到 review 阶段，并将结果持久化到 history 表。
   */
  async function handleSubmit() {
    stop();
    let correct = 0;
    for (let i = 0; i < sentences.length; i++) {
      const result = matchAnswerDetail(userInputs[i], sentences[i].text, "rewrite");
      if (result === "correct") correct++;
      else if (result === "close") correct += 0.5;
    }
    setScore(correct);
    transition("review");

    const result: ListeningResult = {
      difficulty,
      topic,
      sentences,
      userInputs,
      score: correct,
    };
    await addHistorySafe(
      {
        type: "listening",
        input_text: `听力练习: ${topic} (${difficulty})`,
        result: JSON.stringify(result),
      },
      (msg) => setSaveError(`保存失败：${msg}`),
    );
    // R9: 使用 recordLearningActivitySafe 非阻断版本
    recordLearningActivitySafe("listening");
  }

  // ── 阶段一：选择难度 ──
  // idle 或 loading 阶段且无错误时，显示难度选择卡片和主题输入框。
  // 若生成耗时超过 30 秒，显示"重新生成"提示。
  if ((phase === "idle" || phase === "loading") && !error) {
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">Listening Copilot</h2>

        <Card className="max-w-md mx-auto">
          <CardContent className="p-8 flex flex-col items-center text-center space-y-6">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Headphones className="h-8 w-8 text-primary" />
            </div>
            <p className="text-muted-foreground">听 TTS 播放的英文句子，尝试听写出来</p>

            <div className="w-full space-y-3">
              <label htmlFor="listening-topic" className="text-sm text-muted-foreground">
                主题
              </label>
              <div className="flex gap-2 flex-wrap">
                {TOPICS.map((t) => (
                  <Button
                    key={t}
                    variant={topic === t ? "default" : "outline"}
                    size="sm"
                    onClick={() => setTopic(t)}
                  >
                    {t}
                  </Button>
                ))}
              </div>
              <Input
                id="listening-topic"
                value={isCustomTopic(topic) ? topic : ""}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="或输入自定义主题..."
              />
            </div>

            <div className="space-y-2 w-full">
              <p className="text-sm text-muted-foreground">选择难度</p>
              <div className="flex gap-3 justify-center">
                {DIFFICULTIES.map((diff) => (
                  <Button
                    key={diff}
                    size="lg"
                    variant={difficulty === diff ? "default" : "outline"}
                    onClick={() => {
                      setDifficulty(diff);
                      difficultyRef.current = diff;
                    }}
                  >
                    {diff}
                  </Button>
                ))}
              </div>
            </div>

            <Button
              size="lg"
              className="w-full"
              onClick={() => handleStart(difficulty)}
              disabled={phase === "loading"}
            >
              {phase === "loading" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  生成中...
                </>
              ) : (
                "开始练习"
              )}
            </Button>

            {showRetryHint && (
              <div className="text-sm text-amber-600 dark:text-amber-400">
                生成时间较长，
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={handleRetry}
                >
                  重新生成
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── 错误状态 ──
  // 句子生成失败时显示错误信息和重试按钮。
  if (error) {
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">Listening Copilot</h2>
        <Card className="max-w-md mx-auto">
          <CardContent className="p-8 flex flex-col items-center text-center space-y-4">
            <ErrorBanner message={error} />
            <Button onClick={handleRetry}>
              <RotateCcw className="h-4 w-4 mr-2" />
              重试
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── 阶段二：听写 ──
  // 逐句播放 TTS 音频，用户输入听写内容，支持查看中文提示。
  // 底部导航按钮可在句子间切换，最后一句显示"提交"按钮。
  if (phase === "listening" && sentences.length > 0) {
    const current = sentences[currentIndex];
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">Listening Copilot</h2>

        <ProgressBar current={currentIndex + 1} total={sentences.length} />

        <InlineErrorBoundary sectionName="听力练习">
          <Card className="max-w-lg mx-auto">
            <CardContent className="p-8 space-y-6">
              <div className="flex justify-center">
                <Button
                  size="lg"
                  variant="outline"
                  className="h-16 w-16 rounded-full"
                  onClick={() => play(current.text)}
                  disabled={playing}
                >
                  {playing ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <Volume2 className="h-6 w-6" />
                  )}
                </Button>
              </div>
              <p className="text-center text-sm text-muted-foreground">点击播放，可重复听</p>

              <div>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mx-auto"
                  onClick={() => setShowHint(!showHint)}
                >
                  <Lightbulb className="h-3 w-3" />
                  {showHint ? "隐藏提示" : "查看中文提示"}
                </button>
                {showHint && (
                  <p className="text-sm text-center text-amber-600 dark:text-amber-400 mt-2">
                    {current.hint}
                  </p>
                )}
              </div>

              <Textarea
                value={userInputs[currentIndex]}
                onChange={(e) => setInput(currentIndex, e.target.value)}
                placeholder="输入你听到的句子..."
                rows={3}
                className="resize-none"
              />

              <div className="flex justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrev}
                  disabled={currentIndex === 0}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  上一句
                </Button>
                {currentIndex < sentences.length - 1 ? (
                  <Button size="sm" onClick={handleNext}>
                    下一句
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={handleSubmit}
                    className="bg-green-600 hover:bg-green-700 text-white"
                  >
                    提交
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </InlineErrorBoundary>
      </div>
    );
  }

  // ── 阶段三：结果回顾 ──
  // 展示总分、每句的正确/错误状态、正确答案和中文提示。
  // 用户可点击"再来一轮"重新开始。
  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">Listening Copilot</h2>

      {/* 保存失败警告（不阻塞回顾体验） */}
      {saveError && <WarningBanner message={saveError} />}

      <Card className="max-w-md mx-auto">
        <CardContent className="p-8 flex flex-col items-center text-center space-y-4">
          <div
            className={`h-16 w-16 rounded-full flex items-center justify-center ${
              score >= 4 ? "bg-green-500/10" : score >= 3 ? "bg-yellow-500/10" : "bg-red-500/10"
            }`}
          >
            <CheckCircle2
              className={`h-8 w-8 ${
                score >= 4
                  ? "text-green-600 dark:text-green-400"
                  : score >= 3
                    ? "text-yellow-600 dark:text-yellow-400"
                    : "text-red-600 dark:text-red-400"
              }`}
            />
          </div>
          <p className="text-lg font-medium">
            得分 {Number.isInteger(score) ? score : score.toFixed(1)} / {sentences.length}
          </p>
          <p className="text-sm text-muted-foreground">
            {difficulty} · {topic}
          </p>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {sentences.map((s, i) => {
          const result = matchAnswerDetail(userInputs[i], s.text, "rewrite");
          return (
            <Card
              key={s.text.slice(0, 50)}
              className={
                result === "correct"
                  ? "border-green-500/40"
                  : result === "close"
                    ? "border-yellow-500/40"
                    : "border-red-500/40"
              }
            >
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">第 {i + 1} 句</span>
                  <div className="flex items-center gap-2">
                    <Button size="icon-xs" variant="ghost" onClick={() => play(s.text)}>
                      <Volume2 className="h-3.5 w-3.5" />
                    </Button>
                    {result === "correct" ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    ) : result === "close" ? (
                      <CheckCircle2 className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                    )}
                  </div>
                </div>

                <p className="text-sm font-medium text-green-700 dark:text-green-300">{s.text}</p>

                {result !== "correct" && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">你的回答：</span>
                    <span
                      className={
                        result === "close"
                          ? "text-yellow-600 dark:text-yellow-400"
                          : "text-red-600 dark:text-red-400"
                      }
                    >
                      {userInputs[i] || "(未作答)"}
                    </span>
                  </div>
                )}

                <p className="text-xs text-muted-foreground italic">{s.hint}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex justify-center">
        <Button onClick={handleRetry}>
          <RotateCcw className="h-4 w-4 mr-2" />
          再来一轮
        </Button>
      </div>
    </div>
  );
}
