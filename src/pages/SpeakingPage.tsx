/**
 * @module SpeakingPage
 * @description 口语练习页面 — 跟读模仿（Shadowing）。
 *
 * 三阶段状态机流程：
 * 1. loading — 选择难度和主题，LLM 生成 5 个跟读句子
 * 2. speaking — 逐句播放 TTS → 用户录音 → ASR 转写 → LLM 评估发音
 * 3. review — 展示所有结果，计算平均分，自动提取口语错词，持久化到 history 表
 *
 * 主要特性：
 * - useReducer 集中管理跟读练习关联状态（避免多个 setState 不一致）
 * - ASR 语音识别 + LLM 发音评估（发音/语法/流利度/总分）
 * - 词级对齐展示（WordAlignmentView）：按发音状态着色并显示 IPA 音标
 * - 口语错词自动提取：从低分句子的原句与转写差异中识别漏读/错读单词
 * - 生词本集成：错词一键添加到生词本
 */

import {
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
  MicOff,
  RotateCcw,
  Volume2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { z } from "zod";
import { PracticeOptionsSelector } from "@/components/PracticeOptionsSelector";
import { ErrorBanner, RetryHint, WarningBanner } from "@/components/page-states";
import { ProgressBar } from "@/components/progress-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { useLLMStreamPage } from "@/hooks/use-llm-stream-page";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { useRecording } from "@/hooks/use-recording";
import { useRetryHint } from "@/hooks/use-retry-hint";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { getErrorMessage } from "@/lib/error-utils";
import { extractJson } from "@/lib/parse-utils";
import { SpeakingScoreSchema, SpeakingSentenceSchema } from "@/lib/schemas";
import { getScoreColor } from "@/lib/utils";
import { EVALUATION_PROMPT, SPEAKING_PROMPT } from "@/prompts";
import { convertToWav, transcribeAudio } from "@/services/asr";
import type { SpeakingResult, SpeakingScore, SpeakingSentence, WordAlignmentItem } from "@/types";
import { extractMissedWords, initialSpeakingState, speakingReducer } from "./speaking-reducer";

/** 口语练习流程的三个阶段：生成句子 → 逐句跟读 → 结果回顾 */
type Phase = "loading" | "speaking" | "review";

/** 发音状态的文本标签和 ARIA 语义映射 */
const STATUS_LABELS: Record<WordAlignmentItem["status"], string> = {
  correct: "正确",
  mispronounced: "有误",
  missed: "漏读",
};

/**
 * 词级对齐展示 —— 将原句每个词按发音状态着色，并显示 IPA 音标。
 * - correct: 绿色
 * - mispronounced: 黄色
 * - missed: 红色 + 删除线
 */
function WordAlignmentView({ alignment }: { alignment: WordAlignmentItem[] }) {
  const statusStyles: Record<WordAlignmentItem["status"], string> = {
    correct: "text-green-600 dark:text-green-400",
    mispronounced: "text-yellow-600 dark:text-yellow-400",
    missed: "text-red-600 dark:text-red-400 line-through",
  };
  return (
    <ul
      className="flex flex-wrap gap-x-3 gap-y-2 pt-1 list-none pl-0"
      aria-label="词级发音对齐结果"
    >
      {alignment.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: alignment 项无唯一 id 且不会重新排序
        <li key={`${item.word}-${i}`} className="flex flex-col items-center">
          <span className={`text-sm font-medium ${statusStyles[item.status]}`}>{item.word}</span>
          <span className="text-xs text-muted-foreground">{item.ipa}</span>
          {/* L-7: 文本标签辅助色觉障碍用户区分状态 */}
          <span className={`text-[10px] ${statusStyles[item.status]} opacity-70`}>
            {STATUS_LABELS[item.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 口语练习页面 —— 跟读模仿（Shadowing）。
 *
 * 三阶段流程：
 * 1. loading — 选择难度和主题，LLM 生成 5 个跟读句子
 * 2. speaking — 逐句播放 TTS → 用户录音 → ASR 转写 → LLM 评估
 * 3. review — 展示所有结果，计算平均分并持久化
 */
export default function SpeakingPage() {
  // L1: error / saveError 必须在 usePhaseMachine 之前声明，
  // 因为 usePhaseMachine 的 onEnter.loading 回调会引用它们。
  const [error, setError] = useState<string | null>(null);
  /** 历史记录保存失败的非阻断提示（ExercisePage 同款模式） */
  const [saveError, setSaveError] = useState<string | null>(null);

  const { phase, transition, setPhase } = usePhaseMachine<Phase>("loading", {
    onEnter: {
      loading: () => {
        setError(null);
        setSaveError(null);
      },
    },
  });

  const [difficulty, setDifficulty] = useState<string>("初级");
  const [topic, setTopic] = useState<string>("日常对话");

  // O5: 关联状态集中到 reducer
  const [state, dispatch] = useReducer(speakingReducer, initialSpeakingState);
  const { sentences, results, currentIndex, currentTranscription, currentScore } = state;

  const [isGenerating, setIsGenerating] = useState(false);
  const { showRetryHint } = useRetryHint(isGenerating);
  const { playing, play, stop: stopTTS } = useAudioPlayer();
  const { recording, start, stop } = useRecording();

  // 当前句处理状态：识别语音 / 评估发音
  const [recognizing, setRecognizing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  // 完成后的平均分
  const [averageScore, setAverageScore] = useState(0);

  // 存储用户完成后的完整口语结果，供 buildHistoryRecord 在 persistResult 时读取
  const speakingResultRef = useRef<string>("");

  // useLLMStreamPage 管理页面级生命周期（句子生成 + 持久化）
  const { handleSubmit, abort, persistResult } = useLLMStreamPage({
    activityType: "speaking",
    autoPersist: false,
    buildMessages: () => [SPEAKING_PROMPT(difficulty, topic), ""],
    onDone: (fullText) => {
      try {
        const sentencesSchema = z.object({
          sentences: z.array(SpeakingSentenceSchema),
        });
        const parsed = extractJson<{ sentences: SpeakingSentence[] }>(
          fullText,
          (d): d is { sentences: SpeakingSentence[] } => sentencesSchema.safeParse(d).success,
        );
        if (parsed) {
          dispatch({ type: "INIT", sentences: parsed.sentences });
          transition("speaking");
        } else {
          setError("生成失败，请重试。");
          setPhase("loading");
        }
      } catch {
        setError("解析失败，请重试。");
        setPhase("loading");
      }
    },
    onError: (err) => {
      setError(err.message);
      setPhase("loading");
    },
    buildHistoryRecord: () => ({
      type: "speaking",
      input_text: `口语练习: ${topic} (${difficulty})`,
      result: speakingResultRef.current,
    }),
  });

  // useStreamChat 专用于逐句发音评估（与页面级生命周期独立）
  const { execute: executeEvaluation } = useStreamChat("speaking");
  const { addedWords, addingWord, addToVocabulary } = useAddToVocabulary();

  // 口语错词自动提取：从低分句子的原句与转写差异中识别漏读/错读单词
  const [extractedWords, setExtractedWords] = useState<string[] | null>(null);

  /** 生成跟读句子 */
  const generateSentences = useCallback(async () => {
    setIsGenerating(true);
    try {
      await handleSubmit("");
    } finally {
      setIsGenerating(false);
    }
  }, [handleSubmit]);

  /** 进入 speaking 阶段或切换句子时自动播放当前句 */
  useEffect(() => {
    if (phase === "speaking" && sentences.length > 0) {
      play(sentences[currentIndex].text);
    }
    // 问题 26: 切句/卸载时停掉上一个 TTS，避免新旧音频叠加
    return () => stopTTS();
  }, [phase, currentIndex, sentences, play, stopTTS]);

  /** 开始录音 */
  const handleRecord = useCallback(async () => {
    dispatch({ type: "CLEAR_CURRENT" });
    setError(null);
    stopTTS();
    // M4: 捕获录音启动错误，避免未处理 rejection
    try {
      await start();
    } catch (err) {
      setError(getErrorMessage(err, "无法启动录音"));
    }
  }, [start, stopTTS]);

  /** 停止录音 → ASR 转写 → LLM 评估。
   * 使用 processingRef 防止快速双击导致重复 ASR/评估请求。 */
  const processingRef = useRef(false);
  /** ASR 请求的中止控制器：页面卸载时中止未完成的转写请求 */
  const asrAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => asrAbortRef.current?.abort();
  }, []);
  const handleStop = useCallback(async () => {
    if (processingRef.current || recognizing || evaluating) return;
    processingRef.current = true;
    // 问题 3: 闭包捕获 targetIndex，避免异步评估期间 currentIndex 变化导致评估结果写入新句子
    const targetIndex = currentIndex;
    const audioBlob = await stop();
    if (!audioBlob || audioBlob.size === 0) {
      processingRef.current = false;
      return;
    }

    setRecognizing(true);
    try {
      // 1. 转为 WAV 格式（mimo ASR 仅支持 wav/mp3）
      const wavBlob = await convertToWav(audioBlob);
      // 2. ASR 转写（传入中止信号，页面卸载时取消未完成的请求）
      asrAbortRef.current = new AbortController();
      const transcription = await transcribeAudio(
        wavBlob,
        "en",
        undefined,
        undefined,
        asrAbortRef.current.signal,
      );
      setError(null);
      dispatch({ type: "SET_TRANSCRIPTION", transcription });

      // 3. LLM 评估 —— 使用 targetIndex 锁定原句，避免切句后引用错位
      const original = sentences[targetIndex].text;
      const evalPrompt = EVALUATION_PROMPT(original, transcription);

      setRecognizing(false);
      setEvaluating(true);
      await executeEvaluation(evalPrompt, "", {
        onDone: (fullText) => {
          try {
            // M5: 使用 Zod schema 进行运行时校验
            const score = extractJson<SpeakingScore>(
              fullText,
              (d): d is SpeakingScore => SpeakingScoreSchema.safeParse(d).success,
            );
            if (score) {
              dispatch({ type: "SET_SCORE", index: targetIndex, transcription, score });
            } else {
              setError("评估解析失败，请重试该句。");
            }
          } catch {
            setError("评估解析失败，请重试该句。");
          } finally {
            setEvaluating(false);
          }
        },
        onError: (err) => {
          setError(err.message);
          setEvaluating(false);
        },
      });
    } catch (err) {
      setError(getErrorMessage(err, "语音识别失败"));
      setRecognizing(false);
      setEvaluating(false);
    } finally {
      processingRef.current = false;
    }
  }, [recognizing, evaluating, stop, sentences, currentIndex, executeEvaluation]);

  /**
   * 从原句与 ASR 转写的差异中提取漏读/错读单词。
   * 仅保留原句中存在、但转写文本中未出现的词（忽略大小写与标点）。
   */
  const extractMissedWordsCb = useCallback(
    () => extractMissedWords(sentences, results),
    [sentences, results],
  );

  /**
   * 将提取的口语错词加入生词本。
   * sourceText 取自包含该词且得分较低的原句。
   */
  const handleAddExtractedWord = useCallback(
    (word: string) => {
      const sourceText =
        sentences
          .filter(
            (s, i) =>
              s.text.toLowerCase().includes(word.toLowerCase()) &&
              (results[i]?.score?.pronunciation ?? 0) < 80,
          )
          .map((s) => s.text)
          .join(" | ")
          .slice(0, 200) || undefined;
      addToVocabulary(word, sourceText, "speaking");
    },
    [sentences, results, addToVocabulary],
  );

  /** 下一句 */
  const handleNext = useCallback(() => {
    if (currentIndex < sentences.length - 1) {
      dispatch({ type: "NAVIGATE", index: currentIndex + 1 });
    }
  }, [currentIndex, sentences]);

  /** 上一句 */
  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      dispatch({ type: "NAVIGATE", index: currentIndex - 1 });
    }
  }, [currentIndex]);

  /** 重试当前句 */
  const handleRetry = useCallback(() => {
    setError(null);
    dispatch({ type: "RETRY_CURRENT" });
    play(sentences[currentIndex].text);
  }, [currentIndex, sentences, play]);

  /** 完成练习 → 进入 review 阶段 */
  const handleFinish = useCallback(async () => {
    try {
      const validResults = results.filter(
        (r): r is { transcription: string; score: SpeakingScore } => r !== null,
      );
      const avg =
        validResults.length > 0
          ? Math.round(validResults.reduce((s, r) => s + r.score.overall, 0) / validResults.length)
          : 0;
      setAverageScore(avg);

      const speakingResults = sentences.map((s, i) => {
        const r = results[i];
        return {
          sentence: s,
          transcription: r?.transcription ?? "",
          // 问题 17: 用 null 标记未完成句子（而非零分对象），避免污染 analytics 趋势数据
          score: r?.score ?? null,
          // 问题 17: 显式标记 skipped，便于消费方过滤
          skipped: r === null,
        };
      });

      const result: SpeakingResult = {
        difficulty,
        topic,
        sentences,
        results: speakingResults,
        averageScore: avg,
      };

      speakingResultRef.current = JSON.stringify(result);
      const historyId = await persistResult();
      if (historyId === null) setSaveError("保存失败");

      transition("review");
    } catch (err) {
      setError(getErrorMessage(err, "保存结果失败"));
    }
  }, [results, sentences, difficulty, topic, transition, persistResult]);

  /** 进入 review 阶段时自动提取口语错词 */
  useEffect(() => {
    if (phase === "review") {
      setExtractedWords(extractMissedWordsCb());
    }
  }, [phase, extractMissedWordsCb]);

  /** 重新开始 */
  const handleRestart = useCallback(() => {
    abort();
    dispatch({ type: "RESET" });
    setAverageScore(0);
    setExtractedWords(null);
    setError(null);
    setSaveError(null);
    transition("loading");
  }, [transition, abort]);

  // ======================================================================
  // Render: loading 阶段
  // ======================================================================
  if (phase === "loading") {
    return (
      <div className="p-6 max-w-2xl space-y-6">
        <h2 className="text-2xl font-bold">Speaking Copilot — 跟读模仿</h2>
        {error && <ErrorBanner message={error} />}

        <Card>
          <CardContent className="p-6 space-y-4">
            <p className="text-muted-foreground text-sm">
              听原句 → 跟读录音 → AI 评估发音、语法和流利度
            </p>

            <PracticeOptionsSelector
              difficulty={difficulty}
              topic={topic}
              onDifficultyChange={setDifficulty}
              onTopicChange={setTopic}
            />

            <Button
              onClick={generateSentences}
              className="w-full"
              size="lg"
              disabled={isGenerating}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  生成中...
                </>
              ) : (
                "开始练习"
              )}
            </Button>

            <RetryHint show={showRetryHint} onRetry={generateSentences} />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ======================================================================
  // Render: speaking 阶段
  // ======================================================================
  if (phase === "speaking") {
    const current = sentences[currentIndex];
    const isLast = currentIndex === sentences.length - 1;
    const hasResult = results[currentIndex] !== null;

    return (
      <div className="p-6 max-w-2xl space-y-6">
        <h2 className="text-2xl font-bold">Speaking Copilot — 跟读模仿</h2>
        {error && <ErrorBanner message={error} />}

        <ProgressBar current={currentIndex + 1} total={sentences.length} />

        <Card>
          <CardContent className="p-6 space-y-5">
            {/* 原句展示 */}
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-lg font-medium leading-relaxed">{current.text}</p>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => play(current.text)}
                  disabled={playing}
                >
                  <Volume2 className={playing ? "h-5 w-5 animate-pulse text-primary" : "h-5 w-5"} />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{current.translation}</p>
            </div>

            {/* 录音控制 */}
            <div className="flex items-center gap-3">
              {!recording && !recognizing && !evaluating ? (
                <Button size="lg" onClick={handleRecord} className="gap-2">
                  <Mic className="h-5 w-5" />
                  开始录音
                </Button>
              ) : recording ? (
                <Button size="lg" variant="destructive" onClick={handleStop} className="gap-2">
                  <MicOff className="h-5 w-5" />
                  停止录音
                </Button>
              ) : recognizing ? (
                <Button size="lg" disabled className="gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  识别中...
                </Button>
              ) : (
                <Button size="lg" disabled className="gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  评估中...
                </Button>
              )}

              {hasResult && (
                <Button variant="outline" size="sm" onClick={handleRetry}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  重试
                </Button>
              )}
            </div>

            {/* 识别与评估结果 */}
            {currentTranscription && (
              <div className="space-y-3 p-4 rounded-lg border bg-muted/30">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">你说的是：</p>
                  <p className="text-sm">{currentTranscription}</p>
                </div>

                {currentScore && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-4 gap-2 text-center">
                      {[
                        { label: "发音", value: currentScore.pronunciation },
                        { label: "语法", value: currentScore.grammar },
                        { label: "流利", value: currentScore.fluency },
                        { label: "总分", value: currentScore.overall },
                      ].map(({ label, value }) => (
                        <div key={label} className="space-y-1">
                          <p className="text-xs text-muted-foreground">{label}</p>
                          <p className={`text-lg font-bold ${getScoreColor(value, 80, 60)}`}>
                            {value}
                          </p>
                        </div>
                      ))}
                    </div>
                    <p className="text-sm text-muted-foreground">{currentScore.feedback}</p>
                    {currentScore.wordAlignment && currentScore.wordAlignment.length > 0 && (
                      <WordAlignmentView alignment={currentScore.wordAlignment} />
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 导航 */}
            <div className="flex items-center justify-between pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrev}
                disabled={currentIndex === 0}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                上一句
              </Button>
              <span className="text-sm text-muted-foreground">
                {currentIndex + 1} / {sentences.length}
              </span>
              {isLast ? (
                // L7: 允许部分完成 —— 只要至少完成一句即可结束练习
                <Button
                  size="sm"
                  onClick={handleFinish}
                  disabled={results.every((r) => r === null)}
                >
                  完成练习
                </Button>
              ) : (
                <Button size="sm" onClick={handleNext}>
                  下一句
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ======================================================================
  // Render: review 阶段
  // ======================================================================
  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold">Speaking Copilot — 结果回顾</h2>
      {saveError && <WarningBanner message={saveError} />}

      <Card>
        <CardContent className="p-6 text-center space-y-4">
          <p className="text-sm text-muted-foreground">练习完成！平均得分</p>
          <p className={`text-5xl font-bold ${getScoreColor(averageScore, 80, 60)}`}>
            {averageScore}
          </p>
          <p className="text-sm text-muted-foreground">
            {difficulty} · {topic}
          </p>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {sentences.map((s, i) => {
          const r = results[i];
          const score = r?.score;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 句子顺序稳定，文本键可能因 LLM 生成重复句子碰撞
            <Card key={i}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-sm font-medium">{s.text}</p>
                    <p className="text-xs text-muted-foreground">{s.translation}</p>
                  </div>
                  {score && (
                    <div className="flex items-center gap-1">
                      {score.overall >= 60 ? (
                        <CheckCircle2
                          className={`h-5 w-5 ${getScoreColor(score.overall, 80, 60)}`}
                        />
                      ) : (
                        <XCircle className={`h-5 w-5 ${getScoreColor(score.overall, 80, 60)}`} />
                      )}
                      <span className="text-sm font-medium">{score.overall}</span>
                    </div>
                  )}
                </div>
                {r?.transcription && (
                  <p className="text-xs text-muted-foreground">你说的：{r.transcription}</p>
                )}
                {score?.feedback && (
                  <p className="text-xs text-blue-600 dark:text-blue-400">{score.feedback}</p>
                )}
                {score?.wordAlignment && score.wordAlignment.length > 0 && (
                  <WordAlignmentView alignment={score.wordAlignment} />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* 口语错词自动提取 —— 仅在有低分句子时显示 */}
      {extractedWords && extractedWords.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            口语错词
          </h3>
          {extractedWords.map((word) => (
            <div key={word} className="flex items-center justify-between p-3 rounded-lg border">
              <span className="font-medium">{word}</span>
              {addedWords.has(word) ? (
                <span className="text-xs text-green-600 dark:text-green-400">已添加</span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={addingWord === word}
                  onClick={() => handleAddExtractedWord(word)}
                >
                  {addingWord === word ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : null}
                  加入生词本
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <Button onClick={handleRestart} className="w-full" size="lg">
        <RotateCcw className="h-4 w-4 mr-2" />
        再来一轮
      </Button>
    </div>
  );
}
