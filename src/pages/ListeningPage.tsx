import { useState, useEffect, useRef, useCallback } from "react";
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
} from "lucide-react";
import { streamChat, buildPrompt } from "@/services/llm";
import { getDefaultModel, addHistory, getTTSConfig } from "@/lib/db";
import { speakText } from "@/services/tts";
import { matchAnswer } from "@/lib/parse-utils";
import { setTaskStatus, markTaskCompleted } from "@/lib/task-status";
import type { ListeningSentence, ListeningResult } from "@/types";

type Phase = "loading" | "listening" | "review";

const DIFFICULTIES = ["初级", "中级", "高级"] as const;

const LISTENING_PROMPT = (difficulty: string, topic: string) =>
  `你是英语听力练习生成器。请生成 5 个${difficulty}难度的英文句子，主题为"${topic}"。
每个句子附带一个中文提示（帮助理解语境）。

严格按以下 JSON 格式输出，不要输出其他内容：
{
  "sentences": [
    { "text": "英文句子", "hint": "中文提示" }
  ]
}

要求：
- 初级：简单句，常用词汇，10 词以内
- 中级：复合句，中等词汇，15-20 词
- 高级：长难句，高级词汇，20 词以上
- 5 个句子难度递进
- hint 用中文简要说明句子场景或含义`;

export default function ListeningPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [difficulty, setDifficulty] = useState<string>("初级");
  const [topic, setTopic] = useState("日常对话");
  const [sentences, setSentences] = useState<ListeningSentence[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userInputs, setUserInputs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showRetryHint, setShowRetryHint] = useState(false);
  const [score, setScore] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [playing, setPlaying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const playAbortRef = useRef<AbortController | null>(null);

  const generateSentences = useCallback(
    async (signal?: AbortSignal) => {
      const model = await getDefaultModel();
      if (!model?.api_key) {
        setError("请先在设置页面配置 LLM 模型。");
        setPhase("loading");
        return;
      }

      setTaskStatus("listening", true);
      let raw = "";

      const prompt = LISTENING_PROMPT(difficulty, topic);
      const messages = buildPrompt(prompt, "");

      await streamChat(
        messages,
        model,
        {
          onToken: (token) => {
            raw += token;
          },
          onDone: (fullText) => {
            try {
              let jsonStr = fullText.trim();
              const codeBlockMatch = jsonStr.match(
                /```(?:json)?\s*([\s\S]*?)```/
              );
              if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
              const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
              if (braceMatch) jsonStr = braceMatch[0];

              const parsed = JSON.parse(jsonStr);
              if (
                Array.isArray(parsed.sentences) &&
                parsed.sentences.length > 0
              ) {
                setSentences(parsed.sentences);
                setUserInputs(new Array(parsed.sentences.length).fill(""));
                setCurrentIndex(0);
                setPhase("listening");
                markTaskCompleted("listening");
              } else {
                setError("生成失败，请重试。");
                setPhase("loading");
                setTaskStatus("listening", false);
              }
            } catch {
              setError("生成失败，请重试。");
              setPhase("loading");
              setTaskStatus("listening", false);
            }
          },
          onError: (err) => {
            setError(err.message);
            setPhase("loading");
            setTaskStatus("listening", false);
          },
        },
        signal
      );
    },
    [difficulty, topic]
  );

  useEffect(() => {
    if (phase !== "loading" || error) return;
    const controller = new AbortController();
    abortRef.current = controller;

    setShowRetryHint(false);
    const timer = setTimeout(() => setShowRetryHint(true), 30000);

    generateSentences(controller.signal);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [phase, error, generateSentences]);

  function handleStart(diff: string) {
    setDifficulty(diff);
    setError(null);
    setPhase("loading");
  }

  function handleRetry() {
    setError(null);
    setShowRetryHint(false);
    setPhase("loading");
  }

  function setInput(index: number, value: string) {
    setUserInputs((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  async function handlePlaySentence(text: string) {
    playAbortRef.current?.abort();
    const controller = new AbortController();
    playAbortRef.current = controller;

    setPlaying(true);
    try {
      const config = await getTTSConfig();
      if (!config.api_key) return;
      await speakText(text, config, controller.signal);
    } catch {
      // abort or error
    } finally {
      setPlaying(false);
    }
  }

  function handleNext() {
    if (currentIndex < sentences.length - 1) {
      const next = currentIndex + 1;
      setCurrentIndex(next);
      setShowHint(false);
      handlePlaySentence(sentences[next].text);
    }
  }

  function handlePrev() {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setShowHint(false);
    }
  }

  function handleSubmit() {
    playAbortRef.current?.abort();
    let correct = 0;
    for (let i = 0; i < sentences.length; i++) {
      if (matchAnswer(userInputs[i], sentences[i].text, "rewrite")) {
        correct++;
      }
    }
    setScore(correct);
    setPhase("review");

    const result: ListeningResult = {
      difficulty,
      topic,
      sentences,
      userInputs,
      score: correct,
    };
    addHistory({
      type: "listening",
      input_text: `听力练习: ${topic} (${difficulty})`,
      result: JSON.stringify(result),
    }).catch(console.warn);
  }

  // === 阶段一：选择难度 ===
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

  // === 错误状态 ===
  if (error) {
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">听力练习</h2>
        <Card className="max-w-md mx-auto">
          <CardContent className="p-8 flex flex-col items-center text-center space-y-4">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            <Button onClick={handleRetry}>
              <RotateCcw className="h-4 w-4 mr-2" />
              重试
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // === 阶段二：听写 ===
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
                onClick={() => handlePlaySentence(current.text)}
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

  // === 阶段三：结果 ===
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
                      onClick={() => handlePlaySentence(s.text)}
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

      <div className="flex justify-center">
        <Button onClick={handleRetry}>
          <RotateCcw className="h-4 w-4 mr-2" />
          再来一轮
        </Button>
      </div>
    </div>
  );
}
