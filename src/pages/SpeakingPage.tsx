/**
 * @module SpeakingPage
 * @description 口语练习页面 — 跟读模仿（Shadowing）。
 *
 * 三阶段状态机流程：
 * 1. loading — 选择难度（级别）和主题，LLM 生成 5 个跟读句子
 * 2. speaking — 逐句播放 TTS → 用户录音 → ASR 转写 → LLM 评估发音
 * 3. review — 展示所有结果，计算平均分，自动提取口语错词，持久化到 history 表
 *
 * 主要特性：
 * - useReducer 集中管理全部练习状态（含基座公共槽位 score/error/saveError）
 * - 逐句媒体管线（录音→WAV→ASR→发音评估）由 use-speaking-session hook 承载，
 *   页面只保留阶段机、句子生成、TTS 自动播放、错词提取与持久化
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
import { PracticeOptionsSelector } from "@/components/PracticeOptionsSelector";
import { ErrorBanner, RetryHint, WarningBanner } from "@/components/page-states";
import { ProgressBar } from "@/components/progress-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAddToVocabulary } from "@/hooks/use-add-to-vocabulary";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { useEffectivePracticeLevel } from "@/hooks/use-effective-practice-level";
import { useLLMStreamPage } from "@/hooks/use-llm-stream-page";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { usePracticeGeneration } from "@/hooks/use-practice-generation";
import { useRetryHint } from "@/hooks/use-retry-hint";
import { getErrorMessage } from "@/lib/error-utils";
import { extractJsonSafe } from "@/lib/parse-utils";
import { formatDifficultyLabel } from "@/lib/practice-options";
import { makeListEnvelope, SpeakingSentenceSchema } from "@/lib/schemas";
import { getScoreColor } from "@/lib/utils";
import { SPEAKING_PROMPT } from "@/prompts";
import type { SpeakingResult, SpeakingScore } from "@/types";
import { useSpeakingSession } from "./speaking/use-speaking-session";
import { WordAlignmentView } from "./speaking/WordAlignmentView";
import { extractMissedWords, initialSpeakingState, speakingReducer } from "./speaking-reducer";

/** 口语练习流程的三个阶段：生成句子 → 逐句跟读 → 结果回顾 */
type Phase = "loading" | "speaking" | "review";

/** 句子生成结果的运行时校验 schema（模块级，避免每次生成时重建） */
const SentencesResponseSchema = makeListEnvelope("sentences", SpeakingSentenceSchema);

/**
 * 口语练习页面 —— 跟读模仿（Shadowing）。
 *
 * 三阶段流程：
 * 1. loading — 选择难度（级别）和主题，LLM 生成 5 个跟读句子
 * 2. speaking — 逐句播放 TTS → 用户录音 → ASR 转写 → LLM 评估
 * 3. review — 展示所有结果，计算平均分并持久化
 */
export default function SpeakingPage() {
  // O5: 关联状态集中到 reducer。reducer 必须先于 usePhaseMachine 声明：
  // onEnter.loading 回调引用 dispatch —— 原 L1 约束（error/saveError 裸 useState
  // 需声明在阶段机之前）随错误槽位基座化后转为对 dispatch 的依赖。
  const [state, dispatch] = useReducer(speakingReducer, initialSpeakingState);
  const {
    sentences,
    results,
    currentIndex,
    currentTranscription,
    currentScore,
    score: averageScore,
    error,
    saveError,
  } = state;

  const { phase, transition, setPhase } = usePhaseMachine<Phase>("loading", {
    onEnter: {
      // 进入 loading 统一清除两个错误槽（原 setError(null) + setSaveError(null) 的等价替换）
      loading: () => dispatch({ type: "CLEAR_ERRORS" }),
    },
  });

  // 英语水平级别体系：难度选项派生、有效级别与定格 ref 由
  // useEffectivePracticeLevel 统一承载（听力/口语两页共用，语义见该 hook）
  const { levelOptions, effectiveLevel, effectiveLevelRef, selectLevel } =
    useEffectivePracticeLevel();
  const [topic, setTopic] = useState<string>("日常对话");

  // TTS 播放失败（如未配置 TTS）显式提示，不再静默无声音
  const {
    playing,
    play,
    stop: stopTTS,
  } = useAudioPlayer({
    onError: (err) => dispatch({ type: "SET_ERROR", error: err.message }),
  });

  // 逐句媒体管线：录音 → WAV → ASR → 发音评估（专属 useStreamChat 通道在 hook 内部）
  const { recording, recognizing, evaluating, startRecording, stopRecording, abortSession } =
    useSpeakingSession({ sentences, currentIndex, dispatch });

  // 管线忙标志：录音/识别/评估任一在途时禁止导航与完成练习。
  // hook 内的 recordingIndexRef 已锁定评估目标句（录音期间切句也不会写错结果），
  // 此处再从入口禁用，避免用户触发"切句后麦克风晚释放、完成时平均分与逐句
  // 结果矛盾"的混乱状态；双保险缺一不可。
  const sessionBusy = recording || recognizing || evaluating;

  // 存储用户完成后的完整口语结果，供 buildHistoryRecord 在 persistResult 时读取
  const speakingResultRef = useRef<string>("");

  // useLLMStreamPage 管理页面级生命周期（句子生成 + 持久化）
  const { handleSubmit, abort, persistResult } = useLLMStreamPage({
    activityType: "speaking",
    autoPersist: false,
    buildMessages: () => [SPEAKING_PROMPT(effectiveLevel, topic), ""],
    // 难度级别落库：取本次生成发起时定格的级别（ref 在"开始练习"点击时写入）
    getDifficultyLevel: () => effectiveLevelRef.current,
    onDone: (fullText) => {
      const parsed = extractJsonSafe(fullText, SentencesResponseSchema);
      if (parsed) {
        dispatch({ type: "INIT", sentences: parsed.sentences });
        transition("speaking");
      } else {
        dispatch({ type: "SET_ERROR", error: "生成失败，请重试。" });
        setPhase("loading");
      }
    },
    onError: (err) => {
      dispatch({ type: "SET_ERROR", error: err.message });
      setPhase("loading");
    },
    buildHistoryRecord: () => ({
      type: "speaking",
      input_text: `口语练习: ${topic} (${formatDifficultyLabel(effectiveLevelRef.current)})`,
      result: speakingResultRef.current,
    }),
  });
  const { addedWords, addingWord, addToVocabulary } = useAddToVocabulary();

  // 口语错词自动提取：从低分句子的原句与转写差异中识别漏读/错读单词
  const [extractedWords, setExtractedWords] = useState<string[] | null>(null);

  /** 生成跟读句子 */
  // C1: 生成状态包装统一走 usePracticeGeneration
  const { isGenerating, generate: generateSentences } = usePracticeGeneration(handleSubmit);

  /** 发起生成：先定格本次使用的级别，再走统一生成包装 */
  // effectiveLevelRef 由 useEffectivePracticeLevel 提供，对象标识跨渲染稳定，
  // ref 访问不需要作为依赖
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 访问不需要作为依赖
  const handleGenerate = useCallback(async () => {
    effectiveLevelRef.current = effectiveLevel;
    await generateSentences();
  }, [effectiveLevel, generateSentences]);

  // 30 秒超时提示：加载超过 30 秒后显示"重新生成"建议
  const { showRetryHint } = useRetryHint(isGenerating);

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
    stopTTS();
    await startRecording();
  }, [stopTTS, startRecording]);

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
          .map((s, i) => ({ s, r: results[i] }))
          .filter(
            ({ s, r }) =>
              s.text.toLowerCase().includes(word.toLowerCase()) &&
              // 排除未评分（skipped）的句子：?? 0 的写法会把 skipped 句
              // 也当作"低分来源"拼进上下文
              r?.score != null &&
              (r.score.pronunciation ?? 0) < 80,
          )
          .map(({ s }) => s.text)
          .join(" | ")
          .slice(0, 200) || undefined;
      addToVocabulary(word, sourceText, "speaking");
    },
    [sentences, results, addToVocabulary],
  );

  /** 下一句（管线在途时禁用：评估仍归属录音起始句，切句只会制造状态矛盾） */
  const handleNext = useCallback(() => {
    if (sessionBusy) return;
    if (currentIndex < sentences.length - 1) {
      dispatch({ type: "NAVIGATE", index: currentIndex + 1 });
    }
  }, [currentIndex, sentences, sessionBusy]);

  /** 上一句（管线在途时禁用，理由同 handleNext） */
  const handlePrev = useCallback(() => {
    if (sessionBusy) return;
    if (currentIndex > 0) {
      dispatch({ type: "NAVIGATE", index: currentIndex - 1 });
    }
  }, [currentIndex, sessionBusy]);

  /**
   * 重试当前句（管线在途时禁用，理由同 handleNext/handlePrev：在途评估完成时
   * SET_SENTENCE_RESULT 会按 action.index 无条件写回 results，此刻清掉的结果
   * 会被迟到评估原样填回，用户看到的是"重试毫无效果"）
   */
  const handleRetry = useCallback(() => {
    if (sessionBusy) return;
    dispatch({ type: "CLEAR_ERROR" });
    dispatch({ type: "RETRY_CURRENT" });
    play(sentences[currentIndex].text);
  }, [currentIndex, sentences, play, sessionBusy]);

  /** 完成练习 → 进入 review 阶段 */
  // effectiveLevelRef.current 读取的是生成发起时定格的级别，
  // ref 访问不需要作为依赖（理由同 handleGenerate）
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 访问不需要作为依赖
  const handleFinish = useCallback(async () => {
    // 管线在途直接返回：不落库、不切阶段——此刻的平均分会漏掉正在评估的句子，
    // 且与逐句结果/复盘数据矛盾
    if (sessionBusy) return;
    try {
      const validResults = results.filter(
        (r): r is { transcription: string; score: SpeakingScore } => r !== null,
      );
      const avg =
        validResults.length > 0
          ? Math.round(validResults.reduce((s, r) => s + r.score.overall, 0) / validResults.length)
          : 0;
      dispatch({ type: "SET_SCORE", score: avg });

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
        difficulty: effectiveLevelRef.current,
        topic,
        sentences,
        results: speakingResults,
        averageScore: avg,
      };

      speakingResultRef.current = JSON.stringify(result);
      const historyId = await persistResult();
      if (historyId === null) dispatch({ type: "SET_SAVE_ERROR", error: "保存失败" });

      transition("review");
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: getErrorMessage(err, "保存结果失败") });
    }
  }, [results, sentences, topic, transition, persistResult, sessionBusy]);

  /** 进入 review 阶段时自动提取口语错词 */
  useEffect(() => {
    if (phase === "review") {
      setExtractedWords(extractMissedWordsCb());
    }
  }, [phase, extractMissedWordsCb]);

  /** 重新开始 */
  const handleRestart = useCallback(() => {
    abort();
    // 同时中止整条逐句媒体管线：abortSession 先中止在途 ASR 转写、再中止
    // 评估流。只中止评估流时，晚到的 ASR 结果仍会写入新一轮当前句并照常
    // 发起一次评估（多一次计费）；晚到的 SET_SENTENCE_RESULT 也会对已
    // RESET 的空 results 执行 replaceAt，产生稀疏数组污染新一轮会话。
    abortSession();
    // 基座 RESET 一并归零 score/error/saveError（原 setAverageScore(0)/setError(null)/
    // setSaveError(null) 的等价替换），transition("loading") 的 CLEAR_ERRORS 再兜底一次
    dispatch({ type: "RESET" });
    setExtractedWords(null);
    transition("loading");
  }, [transition, abort, abortSession]);

  // 颜色阈值按满分派生（与 ListeningPage 按实际句数派生同一思路：单一事实来源。
  // 原硬编码 80/60 分散在 4 处调用点，调整评分制时容易漏改个别调用点导致判定不一致）
  const FULL_MARKS = 100;
  const scoreHigh = FULL_MARKS * 0.8; // ≥80 绿色
  const scoreLow = FULL_MARKS * 0.6; // ≥60 黄色，低于则红色

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
              level={effectiveLevel}
              levelOptions={levelOptions}
              topic={topic}
              onLevelChange={selectLevel}
              onTopicChange={setTopic}
            />

            <Button onClick={handleGenerate} className="w-full" size="lg" disabled={isGenerating}>
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  生成中...
                </>
              ) : (
                "开始练习"
              )}
            </Button>

            <RetryHint show={showRetryHint} onRetry={handleGenerate} />
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
                <Button size="lg" variant="destructive" onClick={stopRecording} className="gap-2">
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
                <Button variant="outline" size="sm" onClick={handleRetry} disabled={sessionBusy}>
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
                            className={`text-lg font-bold ${getScoreColor(value, scoreHigh, scoreLow)}`}
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
                disabled={currentIndex === 0 || sessionBusy}
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
                  disabled={results.every((r) => r === null) || sessionBusy}
                >
                  完成练习
                </Button>
              ) : (
                <Button size="sm" onClick={handleNext} disabled={sessionBusy}>
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
          <p className={`text-5xl font-bold ${getScoreColor(averageScore, scoreHigh, scoreLow)}`}>
            {averageScore}
          </p>
          <p className="text-sm text-muted-foreground">
            {formatDifficultyLabel(effectiveLevelRef.current)} · {topic}
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
                          className={`h-5 w-5 ${getScoreColor(score.overall, scoreHigh, scoreLow)}`}
                        />
                      ) : (
                        <XCircle
                          className={`h-5 w-5 ${getScoreColor(score.overall, scoreHigh, scoreLow)}`}
                        />
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
