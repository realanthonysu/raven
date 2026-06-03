import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Headphones,
  Volume2,
  Loader2,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Lightbulb,
  BookOpen,
} from "lucide-react";
import { addHistorySafe, recordLearningActivity } from "@/lib/db";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { ErrorBanner } from "@/components/page-states";
import { matchAnswer, extractJson } from "@/lib/parse-utils";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { LISTENING_PROMPT, VOCAB_EXTRACTION_PROMPT } from "@/prompts";
import type { ListeningSentence, ListeningResult } from "@/types";

/** 听力练习的三个阶段：加载生成 → 听写作答 → 结果回顾 */
type Phase = "loading" | "listening" | "review";

/** 可选难度级别，用于 UI 按钮和 prompt 参数 */
const DIFFICULTIES = ["初级", "中级", "高级"] as const;

/** 提取的词汇条目 */
interface ExtractedWord {
  word: string;
  meaning: string;
}

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
  const { phase, transition, setPhase } = usePhaseMachine<Phase>("loading", {
    onEnter: {
      loading: () => {
        setError(null);
        setShowRetryHint(false);
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
  const [showRetryHint, setShowRetryHint] = useState(false); // 生成耗时过长时显示重试提示
  const [score, setScore] = useState(0); // 听写正确句数
  const [showHint, setShowHint] = useState(false); // 是否显示当前句子的中文提示
  const [extracting, setExtracting] = useState(false); // 词汇提取加载状态
  const [extractedWords, setExtractedWords] = useState<ExtractedWord[] | null>(null); // 提取的词汇列表
  const [extractError, setExtractError] = useState<string | null>(null); // 提取失败的错误信息
  const { playing, play, stop } = useAudioPlayer(); // TTS 音频播放器
  const { addedWords, addingWord, addToVocabulary } = useAddToVocabulary();

  const hookOptions = useMemo(() => ({}), []);
  const { execute, abort } = useStreamChat("listening", hookOptions);

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
            (d): d is { sentences: ListeningSentence[] } => {
              if (typeof d !== "object" || d === null) return false;
              const obj = d as Record<string, unknown>;
              return Array.isArray(obj.sentences) && obj.sentences.length > 0;
            }
          );
          if (!parsed) throw new Error("parse failed");
          setSentences(parsed.sentences);
          setUserInputs(new Array(parsed.sentences.length).fill(""));
          setCurrentIndex(0);
          transition("listening");
        } catch {
          setError("生成失败，请重试。");
          setPhase("loading");
        }
      },
      onError: (err) => {
        setError(err.message);
        setPhase("loading");
      },
    });
  }, [topic, execute, transition, setPhase]);

  /**
   * 进入 loading 阶段时自动生成句子。
   * 同时设置 30 秒超时提示——若生成耗时过长，显示"重新生成"链接。
   * 清理时取消未完成的请求并清除超时定时器。
   */
  useEffect(() => {
    if (phase !== "loading" || error) return;

    abort();
    setShowRetryHint(false);
    const timer = setTimeout(() => setShowRetryHint(true), 30000);

    generateSentences();

    return () => {
      clearTimeout(timer);
      abort();
    };
  }, [phase, error, generateSentences, abort]);

  // 组件卸载时中止所有进行中的 LLM 请求（包括词汇提取）
  useEffect(() => {
    return () => { abort(); };
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
   * 重试：重新进入 loading 阶段，使用当前 difficulty/topic 重新生成句子。
   */
  function handleRetry() {
    setError(null);
    setShowRetryHint(false);
    transition("loading");
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
      if (matchAnswer(userInputs[i], sentences[i].text, "rewrite")) {
        correct++;
      }
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
    await addHistorySafe({
      type: "listening",
      input_text: `听力练习: ${topic} (${difficulty})`,
      result: JSON.stringify(result),
    });
    recordLearningActivity("listening").catch(() => {});
  }

  /**
   * 从听写错误的句子中提取重点词汇。
   * 收集所有答错的句子，调用 LLM 提取 3-5 个值得学习的词汇，
   * 展示后用户可逐个点击"加入生词本"，自动调用 enrichWord 补全详细信息。
   */
  async function handleExtractVocabulary() {
    const wrongSentences = sentences
      .filter((s, i) => !matchAnswer(userInputs[i], s.text, "rewrite"))
      .map((s) => s.text)
      .join("\n");

    if (!wrongSentences) return;

    setExtracting(true);
    setExtractError(null);

    const prompt = VOCAB_EXTRACTION_PROMPT(wrongSentences);

    await execute(prompt, "", {
      onToken: () => {},
      onDone: (fullText) => {
        try {
          const parsed = extractJson<{ words: ExtractedWord[] }>(
            fullText,
            (d): d is { words: ExtractedWord[] } => {
              if (typeof d !== "object" || d === null) return false;
              const obj = d as Record<string, unknown>;
              return Array.isArray(obj.words) && obj.words.length > 0;
            }
          );
          if (!parsed) throw new Error("parse failed");
          setExtractedWords(parsed.words);
        } catch {
          setExtractError("词汇提取失败，请重试。");
        }
        setExtracting(false);
      },
      onError: (err) => {
        setExtractError(err.message);
        setExtracting(false);
      },
      onAbort: () => {
        setExtracting(false);
      },
    });
  }

  /**
   * 将提取的词汇添加到生词本。
   * 使用共享的 useAddToVocabulary hook，传入 meaning 作为 fallback 定义。
   */
  function handleAddExtractedWord(word: string, meaning: string) {
    const sourceText = sentences
      .filter((s) => s.text.toLowerCase().includes(word.toLowerCase()))
      .map((s) => s.text)
      .join(" | ")
      .slice(0, 200) || undefined;
    addToVocabulary(word, sourceText, "listening", meaning);
  }

  // ── 阶段一：选择难度 ──
  // loading 阶段且无错误时，显示难度选择卡片和主题输入框。
  // 若生成耗时超过 30 秒，显示"重新生成"提示。
  if (phase === "loading" && !error) {
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">听力练习</h2>

        <Card className="max-w-md mx-auto">
          <CardContent className="p-8 flex flex-col items-center text-center space-y-6">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Headphones className="h-8 w-8 text-primary" />
            </div>
            <p className="text-muted-foreground">
              听 TTS 播放的英文句子，尝试听写出来
            </p>

            <div className="w-full space-y-3">
              <label className="text-sm text-muted-foreground">主题</label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="如：日常对话、科技、商务"
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
                    onClick={() => handleStart(diff)}
                  >
                    {diff}
                  </Button>
                ))}
              </div>
            </div>

            {showRetryHint && (
              <div className="text-sm text-amber-600 dark:text-amber-400">
                生成时间较长，
                <button
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
        <h2 className="text-2xl font-bold">听力练习</h2>
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
    const progress = ((currentIndex + 1) / sentences.length) * 100;

    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">听力练习</h2>

        <div className="space-y-1">
          <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground text-right">
            {currentIndex + 1} / {sentences.length}
          </p>
        </div>

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

            <p className="text-center text-sm text-muted-foreground">
              点击播放，可重复听
            </p>

            <div>
              <button
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
      </div>
    );
  }

  // ── 阶段三：结果回顾 ──
  // 展示总分、每句的正确/错误状态、正确答案和中文提示。
  // 用户可点击"再来一轮"重新开始。
  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">听力练习</h2>

      <Card className="max-w-md mx-auto">
        <CardContent className="p-8 flex flex-col items-center text-center space-y-4">
          <div
            className={`h-16 w-16 rounded-full flex items-center justify-center ${
              score >= 4
                ? "bg-green-500/10"
                : score >= 3
                  ? "bg-yellow-500/10"
                  : "bg-red-500/10"
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
            得分 {score} / {sentences.length}
          </p>
          <p className="text-sm text-muted-foreground">
            {difficulty} · {topic}
          </p>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {sentences.map((s, i) => {
          const correct = matchAnswer(userInputs[i], s.text, "rewrite");
          return (
            <Card
              key={i}
              className={
                correct
                  ? "border-green-500/40"
                  : "border-red-500/40"
              }
            >
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">
                    第 {i + 1} 句
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => play(s.text)}
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                    </Button>
                    {correct ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                    )}
                  </div>
                </div>

                <p className="text-sm font-medium text-green-700 dark:text-green-300">
                  {s.text}
                </p>

                {!correct && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">你的回答：</span>
                    <span className="text-red-600 dark:text-red-400">
                      {userInputs[i] || "(未作答)"}
                    </span>
                  </div>
                )}

                <p className="text-xs text-muted-foreground italic">
                  {s.hint}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* 重点词汇提取 —— 仅在有错误答案时显示 */}
      {score < sentences.length && (
        <div className="space-y-4">
          {!extractedWords && !extractError && (
            <div className="flex justify-center">
              <Button
                onClick={handleExtractVocabulary}
                disabled={extracting}
                variant="outline"
              >
                {extracting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <BookOpen className="h-4 w-4 mr-2" />
                )}
                {extracting ? "正在提取..." : "提取重点词汇"}
              </Button>
            </div>
          )}

          {extractError && (
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-red-600 dark:text-red-400">
                {extractError}
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleExtractVocabulary}
                disabled={extracting}
              >
                {extracting ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : null}
                重试
              </Button>
            </div>
          )}

          {extractedWords && extractedWords.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">重点词汇</h3>
              {extractedWords.map((w) => (
                <div
                  key={w.word}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div>
                    <span className="font-medium">{w.word}</span>
                    <span className="text-sm text-muted-foreground ml-2">
                      {w.meaning}
                    </span>
                  </div>
                  {addedWords.has(w.word) ? (
                    <span className="text-xs text-green-600 dark:text-green-400">
                      已添加
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={addingWord === w.word}
                      onClick={() =>
                        handleAddExtractedWord(w.word, w.meaning)
                      }
                    >
                      {addingWord === w.word ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : null}
                      加入生词本
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-center">
        <Button onClick={handleRetry}>
          <RotateCcw className="h-4 w-4 mr-2" />
          再来一轮
        </Button>
      </div>
    </div>
  );
}
