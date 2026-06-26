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
import { useCallback, useEffect, useReducer, useState } from "react";
import { z } from "zod";
import { ErrorBanner, WarningBanner } from "@/components/page-states";
import { ProgressBar } from "@/components/progress-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { useRecording } from "@/hooks/use-recording";
import { useRetryHint } from "@/hooks/use-retry-hint";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { addHistorySafe, recordLearningActivitySafe } from "@/lib/db";
import { extractJson } from "@/lib/parse-utils";
import { DIFFICULTIES, isCustomTopic, TOPICS } from "@/lib/practice-options";
import { SpeakingScoreSchema, SpeakingSentenceSchema } from "@/lib/schemas";
import { EVALUATION_PROMPT, SPEAKING_PROMPT } from "@/prompts";
import { convertToWav, transcribeAudio } from "@/services/asr";
import type { SpeakingResult, SpeakingScore, SpeakingSentence, WordAlignmentItem } from "@/types";

/** 口语练习流程的三个阶段：生成句子 → 逐句跟读 → 结果回顾 */
type Phase = "loading" | "speaking" | "review";

// ======================================================================
// O5: 使用 useReducer 集中管理跟读练习的关联状态
// 将 sentences / results / currentIndex / currentTranscription / currentScore
// 合并为单一 reducer，避免多个 setState 分散调用导致的不一致风险。
// ======================================================================

interface SpeakingState {
  sentences: SpeakingSentence[];
  results: Array<{ transcription: string; score: SpeakingScore } | null>;
  currentIndex: number;
  currentTranscription: string | null;
  currentScore: SpeakingScore | null;
}

type SpeakingAction =
  | { type: "INIT"; sentences: SpeakingSentence[] }
  | { type: "NAVIGATE"; index: number }
  | { type: "SET_TRANSCRIPTION"; transcription: string }
  // 问题 3: SET_SCORE 显式携带目标 index，避免异步回调期间 currentIndex 变化导致评估结果写入错位
  | { type: "SET_SCORE"; index: number; transcription: string; score: SpeakingScore }
  | { type: "CLEAR_CURRENT" }
  | { type: "RETRY_CURRENT" }
  | { type: "RESET" };

/** Speaking reducer 初始状态 */
const initialSpeakingState: SpeakingState = {
  sentences: [],
  results: [],
  currentIndex: 0,
  currentTranscription: null,
  currentScore: null,
};

function speakingReducer(state: SpeakingState, action: SpeakingAction): SpeakingState {
  switch (action.type) {
    case "INIT":
      return {
        sentences: action.sentences,
        results: new Array(action.sentences.length).fill(null),
        currentIndex: 0,
        currentTranscription: null,
        currentScore: null,
      };
    case "NAVIGATE": {
      const existing = state.results[action.index];
      return {
        ...state,
        currentIndex: action.index,
        currentTranscription: existing?.transcription ?? null,
        currentScore: existing?.score ?? null,
      };
    }
    case "SET_TRANSCRIPTION":
      return { ...state, currentTranscription: action.transcription };
    case "SET_SCORE": {
      // 问题 3: 使用 action.index 而非 state.currentIndex，避免评估期间用户切句导致结果写入错位
      const next = [...state.results];
      next[action.index] = { transcription: action.transcription, score: action.score };
      return {
        ...state,
        currentTranscription: action.transcription,
        currentScore: action.score,
        results: next,
      };
    }
    case "CLEAR_CURRENT":
      return { ...state, currentTranscription: null, currentScore: null };
    case "RETRY_CURRENT": {
      const next = [...state.results];
      next[state.currentIndex] = null;
      return {
        ...state,
        currentTranscription: null,
        currentScore: null,
        results: next,
      };
    }
    case "RESET":
      return initialSpeakingState;
    default:
      return state;
  }
}

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
    <div className="flex flex-wrap gap-x-3 gap-y-2 pt-1">
      {alignment.map((item, i) => (
        <div key={`${item.word}-${i}`} className="flex flex-col items-center">
          <span className={`text-sm font-medium ${statusStyles[item.status]}`}>{item.word}</span>
          <span className="text-xs text-muted-foreground">{item.ipa}</span>
        </div>
      ))}
    </div>
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

  const { showRetryHint } = useRetryHint(phase === "loading");
  const { playing, play, stop: stopTTS } = useAudioPlayer();
  const { recording, start, stop } = useRecording();

  // 当前句处理状态：识别语音 / 评估发音
  const [recognizing, setRecognizing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  // 完成后的平均分
  const [averageScore, setAverageScore] = useState(0);

  const { execute, loading: generating } = useStreamChat("speaking");
  const { addedWords, addingWord, addToVocabulary } = useAddToVocabulary();

  // 口语错词自动提取：从低分句子的原句与转写差异中识别漏读/错读单词
  const [extractedWords, setExtractedWords] = useState<string[] | null>(null);

  /** 生成跟读句子 */
  const generateSentences = useCallback(async () => {
    const prompt = SPEAKING_PROMPT(difficulty, topic);
    await execute(prompt, "", {
      onDone: (fullText) => {
        try {
          // M5: 使用 Zod schema 进行运行时校验，替代手写 type guard
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
    });
  }, [execute, topic, difficulty, transition, setPhase]);

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
      setError(err instanceof Error ? err.message : "无法启动录音");
    }
  }, [start, stopTTS]);

  /** 停止录音 → ASR 转写 → LLM 评估 */
  const handleStop = useCallback(async () => {
    if (recognizing || evaluating) return;
    // 问题 3: 闭包捕获 targetIndex，避免异步评估期间 currentIndex 变化导致评估结果写入新句子
    const targetIndex = currentIndex;
    const audioBlob = await stop();
    if (!audioBlob || audioBlob.size === 0) return;

    setRecognizing(true);
    try {
      // 1. 转为 WAV 格式（mimo ASR 仅支持 wav/mp3）
      const wavBlob = await convertToWav(audioBlob);
      // 2. ASR 转写
      const transcription = await transcribeAudio(wavBlob, "en");
      setError(null);
      dispatch({ type: "SET_TRANSCRIPTION", transcription });

      // 3. LLM 评估 —— 使用 targetIndex 锁定原句，避免切句后引用错位
      const original = sentences[targetIndex].text;
      const evalPrompt = EVALUATION_PROMPT(original, transcription);

      setRecognizing(false);
      setEvaluating(true);
      await execute(evalPrompt, "", {
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
      setError(err instanceof Error ? err.message : "语音识别失败");
      setRecognizing(false);
      setEvaluating(false);
    }
  }, [recognizing, evaluating, stop, sentences, currentIndex, execute]);

  /**
   * 从原句与 ASR 转写的差异中提取漏读/错读单词。
   * 仅保留原句中存在、但转写文本中未出现的词（忽略大小写与标点）。
   */
  const extractMissedWords = useCallback((): string[] => {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[.,!?;:'"()[\]{}—–-]/g, "")
        .trim();
    const missed = new Set<string>();
    for (let i = 0; i < sentences.length; i++) {
      const r = results[i];
      if (!r?.transcription) continue;
      // 仅对发音准确度较低的句子提取错词
      if ((r.score?.pronunciation ?? 0) >= 80) continue;
      const originalWords = normalize(sentences[i].text).split(/\s+/).filter(Boolean);
      const transWords = new Set(normalize(r.transcription).split(/\s+/).filter(Boolean));
      for (const word of originalWords) {
        if (!transWords.has(word)) {
          missed.add(word);
        }
      }
    }
    return Array.from(missed);
  }, [sentences, results]);

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

      await addHistorySafe(
        {
          type: "speaking",
          input_text: `口语练习: ${topic} (${difficulty})`,
          result: JSON.stringify(result),
        },
        (msg) => setSaveError(msg),
      );
      // R9: 使用 recordLearningActivitySafe 非阻断版本
      recordLearningActivitySafe("speaking");

      transition("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存结果失败");
    }
  }, [results, sentences, difficulty, topic, transition]);

  /** 进入 review 阶段时自动提取口语错词 */
  useEffect(() => {
    if (phase === "review") {
      setExtractedWords(extractMissedWords());
    }
  }, [phase, extractMissedWords]);

  /** 重新开始 */
  const handleRestart = useCallback(() => {
    dispatch({ type: "RESET" });
    setAverageScore(0);
    setExtractedWords(null);
    setError(null);
    setSaveError(null);
    transition("loading");
  }, [transition]);

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

            <div className="space-y-2">
              <label className="text-sm font-medium">难度</label>
              <div className="flex gap-2">
                {DIFFICULTIES.map((d) => (
                  <Button
                    key={d}
                    variant={difficulty === d ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                      setDifficulty(d);
                    }}
                  >
                    {d}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">主题</label>
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
                className="mt-1"
                placeholder="或输入自定义主题..."
                value={isCustomTopic(topic) ? topic : ""}
                onChange={(e) => setTopic(e.target.value)}
              />
            </div>

            <Button onClick={generateSentences} className="w-full" size="lg" disabled={generating}>
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  生成中...
                </>
              ) : (
                "开始练习"
              )}
            </Button>

            {showRetryHint && (
              <p className="text-sm text-muted-foreground text-center">
                生成时间较长？
                <Button variant="link" size="sm" className="px-1" onClick={generateSentences}>
                  重新生成
                </Button>
              </p>
            )}
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
                          <p
                            className={`text-lg font-bold ${
                              value >= 80
                                ? "text-green-600 dark:text-green-400"
                                : value >= 60
                                  ? "text-yellow-600 dark:text-yellow-400"
                                  : "text-red-600 dark:text-red-400"
                            }`}
                          >
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
          <p
            className={`text-5xl font-bold ${
              averageScore >= 80
                ? "text-green-600 dark:text-green-400"
                : averageScore >= 60
                  ? "text-yellow-600 dark:text-yellow-400"
                  : "text-red-600 dark:text-red-400"
            }`}
          >
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
            <Card key={i}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-sm font-medium">{s.text}</p>
                    <p className="text-xs text-muted-foreground">{s.translation}</p>
                  </div>
                  {score && (
                    <div className="flex items-center gap-1">
                      {score.overall >= 80 ? (
                        <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                      ) : score.overall >= 60 ? (
                        <CheckCircle2 className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
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
