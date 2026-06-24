import {
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorBanner } from "@/components/page-states";
import { ProgressBar } from "@/components/progress-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import { useRecording } from "@/hooks/use-recording";
import { useRetryHint } from "@/hooks/use-retry-hint";
import { useStreamChat } from "@/hooks/use-stream-chat";
import { addHistorySafe, recordLearningActivity } from "@/lib/db";
import { extractJson } from "@/lib/parse-utils";
import { convertToWav, transcribeAudio } from "@/services/asr";
import type { SpeakingResult, SpeakingScore, SpeakingSentence } from "@/types";

type Phase = "loading" | "speaking" | "review";

const DIFFICULTIES = ["初级", "中级", "高级"] as const;

const TOPICS = ["日常对话", "商务英语", "旅游出行", "科技", "校园生活", "面试自我介绍"] as const;

/**
 * 跟读模仿句子生成 prompt。
 * 要求 LLM 返回 JSON 格式，包含英文原句和中文翻译。
 */
function SPEAKING_PROMPT(difficulty: string, topic: string): string {
  return `你是一个英语口语教练。请生成 5 个适合跟读模仿的英文句子。
难度：${difficulty}
主题：${topic}

要求：
- 句子长度适中（5-15 个单词），适合口语练习
- 使用地道自然的表达方式
- 提供准确的中文翻译
- 句子难度应递进

请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "sentences": [
    {"text": "英文句子", "translation": "中文翻译"}
  ]
}`;
}

/**
 * 口语评估 prompt。
 * 将原句和用户实际说出的文本（ASR 转写）发给 LLM 评估。
 */
function EVALUATION_PROMPT(original: string, transcription: string): string {
  return `你是一个英语口语评估专家。请评估以下跟读练习。

原句：${original}
用户实际说出：${transcription}

请从以下维度评估（每项 0-100 分）：
1. 发音准确度（pronunciation）：转写文本与原句的匹配程度
2. 语法正确性（grammar）：用户说出的内容语法是否正确
3. 流利度（fluency）：根据转写完整性判断

请严格按以下 JSON 格式返回，不要包含其他内容：
{
  "pronunciation": 85,
  "grammar": 90,
  "fluency": 80,
  "overall": 85,
  "feedback": "简短的改进建议（1-2 句中文）"
}`;
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
  const [sentences, setSentences] = useState<SpeakingSentence[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { showRetryHint } = useRetryHint(phase === "loading");
  const { playing, play, stop: stopTTS } = useAudioPlayer();
  const { recording, start, stop } = useRecording();

  // 每句的评估结果
  const [results, setResults] = useState<
    Array<{ transcription: string; score: SpeakingScore } | null>
  >([]);
  // 当前句处理状态
  const [processing, setProcessing] = useState(false);
  const [currentTranscription, setCurrentTranscription] = useState<string | null>(null);
  const [currentScore, setCurrentScore] = useState<SpeakingScore | null>(null);

  // 完成后的平均分
  const [averageScore, setAverageScore] = useState(0);
  /** 历史记录保存失败的非阻断提示（ExercisePage 同款模式） */
  const [saveError, setSaveError] = useState<string | null>(null);

  const hookOptions = useMemo(() => ({}), []);
  const { execute, loading: generating } = useStreamChat("speaking", hookOptions);

  /** 生成跟读句子 */
  const generateSentences = useCallback(async () => {
    const prompt = SPEAKING_PROMPT(difficulty, topic);
    await execute(prompt, "", {
      onDone: (fullText) => {
        try {
          const parsed = extractJson<{ sentences: SpeakingSentence[] }>(
            fullText,
            (d): d is { sentences: SpeakingSentence[] } => {
              if (typeof d !== "object" || d === null) return false;
              const obj = d as Record<string, unknown>;
              return Array.isArray(obj.sentences) && obj.sentences.length > 0;
            },
          );
          if (parsed) {
            setSentences(parsed.sentences);
            setResults(new Array(parsed.sentences.length).fill(null));
            setCurrentIndex(0);
            setCurrentTranscription(null);
            setCurrentScore(null);
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
  }, [phase, currentIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 开始录音 */
  const handleRecord = useCallback(async () => {
    setCurrentTranscription(null);
    setCurrentScore(null);
    stopTTS();
    await start();
  }, [start, stopTTS]);

  /** 停止录音 → ASR 转写 → LLM 评估 */
  const handleStop = useCallback(async () => {
    if (processing) return;
    const audioBlob = await stop();
    if (!audioBlob || audioBlob.size === 0) return;

    setProcessing(true);
    try {
      // 1. 转为 WAV 格式（mimo ASR 仅支持 wav/mp3）
      const wavBlob = await convertToWav(audioBlob);
      // 2. ASR 转写
      const transcription = await transcribeAudio(wavBlob, "en");
      setCurrentTranscription(transcription);

      // 2. LLM 评估
      const original = sentences[currentIndex].text;
      const evalPrompt = EVALUATION_PROMPT(original, transcription);

      await execute(evalPrompt, "", {
        onDone: (fullText) => {
          try {
            const score = extractJson<SpeakingScore>(fullText, (d): d is SpeakingScore => {
              if (typeof d !== "object" || d === null) return false;
              const obj = d as Record<string, unknown>;
              return typeof obj.pronunciation === "number" && typeof obj.overall === "number";
            });
            if (score) {
              setCurrentScore(score);
              // 保存结果
              setResults((prev) => {
                const next = [...prev];
                next[currentIndex] = { transcription, score };
                return next;
              });
            } else {
              setError("评估解析失败，请重试该句。");
            }
          } catch {
            setError("评估解析失败，请重试该句。");
          }
        },
        onError: (err) => setError(err.message),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "语音识别失败");
    } finally {
      setProcessing(false);
    }
  }, [processing, stop, sentences, currentIndex, execute]);

  /** 切换句子时恢复已有结果 */
  const restoreResult = useCallback(
    (index: number) => {
      const existing = results[index];
      setCurrentTranscription(existing?.transcription ?? null);
      setCurrentScore(existing?.score ?? null);
    },
    [results],
  );

  /** 下一句 */
  const handleNext = useCallback(() => {
    if (currentIndex < sentences.length - 1) {
      const next = currentIndex + 1;
      setCurrentIndex(next);
      restoreResult(next);
    }
  }, [currentIndex, sentences, restoreResult]);

  /** 上一句 */
  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      const prev = currentIndex - 1;
      setCurrentIndex(prev);
      restoreResult(prev);
    }
  }, [currentIndex]);

  /** 重试当前句 */
  const handleRetry = useCallback(() => {
    setCurrentTranscription(null);
    setCurrentScore(null);
    setResults((prev) => {
      const next = [...prev];
      next[currentIndex] = null;
      return next;
    });
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

      const speakingResults = sentences.map((s, i) => ({
        sentence: s,
        transcription: results[i]?.transcription ?? "",
        score: results[i]?.score ?? {
          pronunciation: 0,
          grammar: 0,
          fluency: 0,
          overall: 0,
          feedback: "",
        },
      }));

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
      recordLearningActivity("speaking").catch(() => {});

      transition("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存结果失败");
    }
  }, [results, sentences, difficulty, topic, transition]);

  /** 重新开始 */
  const handleRestart = useCallback(() => {
    setSentences([]);
    setResults([]);
    setCurrentIndex(0);
    setCurrentTranscription(null);
    setCurrentScore(null);
    setAverageScore(0);
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
        <h2 className="text-2xl font-bold">口语练习 — 跟读模仿</h2>
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
                value={TOPICS.includes(topic as (typeof TOPICS)[number]) ? "" : topic}
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
        <h2 className="text-2xl font-bold">口语练习 — 跟读模仿</h2>
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
              {!recording && !processing ? (
                <Button size="lg" onClick={handleRecord} className="gap-2">
                  <Mic className="h-5 w-5" />
                  开始录音
                </Button>
              ) : recording ? (
                <Button size="lg" variant="destructive" onClick={handleStop} className="gap-2">
                  <MicOff className="h-5 w-5" />
                  停止录音
                </Button>
              ) : (
                <Button size="lg" disabled className="gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  识别中...
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
                <Button size="sm" onClick={handleFinish} disabled={results.some((r) => r === null)}>
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
      <h2 className="text-2xl font-bold">口语练习 — 结果回顾</h2>
      {saveError && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400">
          {saveError}
        </div>
      )}

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
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Button onClick={handleRestart} className="w-full" size="lg">
        <RotateCcw className="h-4 w-4 mr-2" />
        再来一轮
      </Button>
    </div>
  );
}
