/**
 * @module ReviewPage
 * @description 生词复习页面。
 *
 * 基于 FSRS（Free Spaced Repetition Scheduler）间隔重复算法的翻牌式单词复习。
 * 三阶段状态机流程：
 * 1. entry — 显示复习统计（待复习/已掌握/学习中），支持恢复中断的复习会话
 * 2. reviewing — 翻牌卡片（正面单词 → 点击翻转显示释义），用户自评不认识/模糊/认识
 * 3. done — 显示本轮复习总结，可再来一轮或返回生词本
 *
 * 主要特性：
 * - FSRS 算法：通过 calculateNextReview 计算下次复习间隔
 * - 中断恢复：通过 localStorage 持久化未完成的复习会话
 * - notes 解析：从单词的 notes 字段中提取搭配和例句
 * - 进度条显示当前复习进度
 */

import { ArrowLeft, Brain, CheckCircle2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { ProgressBar } from "@/components/progress-bar";
import { SpeakButton } from "@/components/SpeakButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePhaseMachine } from "@/hooks/use-phase-machine";
import {
  calculateNextReview,
  getReviewStats,
  getReviewWords,
  type ReviewStats,
  recordLearningActivitySafe,
  updateWordReviewFsrs,
} from "@/lib/db";
import { isReviewStatus } from "@/lib/word-utils";
import type { ReviewStatus, Word } from "@/types";

/** 复习流程的三个阶段：入口页 → 翻牌复习 → 完成总结 */
type Phase = "entry" | "reviewing" | "done";

/** 用户对单词的自评等级：不认识 / 模糊 / 认识 */
type Rating = "again" | "hard" | "good";

/** 单次复习的结果记录 */
interface ReviewResult {
  wordId: number;
  rating: Rating;
}

/** localStorage 持久化的中断复习会话 */
interface SavedReviewSession {
  words: Word[];
  currentIndex: number;
  results: ReviewResult[];
  savedAt: number;
}

const REVIEW_SESSION_KEY = "raven_review_session";

const SavedReviewSessionSchema = z.object({
  words: z.array(
    z.object({
      id: z.number(),
      word: z.string(),
      phonetic: z.string().nullable(),
      definition: z.string(),
      level: z.enum(["CET-4", "CET-6", "TEM-4", "TEM-8"]).nullable(),
      source_type: z.string().nullable(),
      source_text: z.string().nullable(),
      notes: z.string().nullable(),
      review_status: z.enum(["new", "learning", "mastered"]),
      review_count: z.number().optional(),
      next_review_at: z.string().nullable().optional(),
      created_at: z.string(),
      stability: z.number().optional(),
      difficulty: z.number().optional(),
      elapsed_days: z.number().optional(),
      scheduled_days: z.number().optional(),
      reps: z.number().optional(),
      lapses: z.number().optional(),
      state: z.number().optional(),
    }),
  ),
  currentIndex: z.number().min(0),
  results: z.array(
    z.object({
      wordId: z.number(),
      rating: z.enum(["again", "hard", "good"]),
    }),
  ),
  savedAt: z.number(),
});

/** 保存复习会话到 localStorage */
function saveReviewSession(session: SavedReviewSession): void {
  try {
    localStorage.setItem(REVIEW_SESSION_KEY, JSON.stringify(session));
  } catch {
    // localStorage 满或不可用时静默失败
  }
}

/** 从 localStorage 读取并清除复习会话 */
function loadReviewSession(): SavedReviewSession | null {
  try {
    const raw = localStorage.getItem(REVIEW_SESSION_KEY);
    if (!raw) return null;
    const parsed = SavedReviewSessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.words.length === 0) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** 清除 localStorage 中的复习会话 */
function clearReviewSession(): void {
  try {
    localStorage.removeItem(REVIEW_SESSION_KEY);
  } catch {
    // ignore
  }
}

/**
 * 从单词的 notes 字段中解析出搭配和例句。
 * notes 格式由 ReadingPage 的 VocabularySection 写入，形如：
 * "搭配: take advantage of\n例句: You should take advantage of this opportunity."
 */
function parseNotes(notes: string | null): {
  collocations: string | null;
  example: string | null;
} {
  if (!notes) return { collocations: null, example: null };
  const collocationsMatch = notes.match(/搭配[:：]\s*(.+)/);
  const exampleMatch = notes.match(/例句[:：]\s*(.+)/);
  return {
    collocations: collocationsMatch ? collocationsMatch[1].trim() : null,
    example: exampleMatch ? exampleMatch[1].trim() : null,
  };
}

/**
 * 生词复习页面。
 *
 * 采用三阶段状态机设计：
 * 1. entry（入口）— 显示复习统计（待复习/已掌握/学习中），提供"开始复习"按钮
 * 2. reviewing（复习中）— 翻牌式卡片，正面显示单词，点击翻转显示释义，
 *    用户自评（不认识/模糊/认识）后计算下次复习间隔并更新数据库
 * 3. done（完成）— 显示本轮复习总结（认识/模糊/不认识的数量），可再来一轮或返回生词本
 *
 * 间隔重复算法（calculateNextReview）：
 * - again: 间隔重置为 1 天
 * - hard: 间隔不变
 * - good: 间隔翻倍（上限 30 天），连续 3 次 good 自动晋升为 mastered
 *
 * 与数据库的关系：
 * - getReviewWords(): 获取到期需复习的单词（next_review_at <= 当前时间）
 * - updateWordReview(): 更新单词的复习状态、次数、下次复习时间
 */
export default function ReviewPage() {
  const navigate = useNavigate();
  /** 复习统计数据（总数、待复习、学习中、已掌握） */
  const [stats, setStats] = useState<ReviewStats | null>(null);
  /** 本轮待复习的单词列表 */
  const [words, setWords] = useState<Word[]>([]);
  /** 当前正在复习的单词在 words 数组中的索引 */
  const [currentIndex, setCurrentIndex] = useState(0);
  /** 翻牌状态：false 显示正面（单词），true 显示背面（释义） */
  const [flipped, setFlipped] = useState(false);
  /** 本轮复习的所有评分记录，用于完成页统计 */
  const [results, setResults] = useState<ReviewResult[]>([]);
  const [loading, setLoading] = useState(false);
  /** 错误提示（加载失败 / 评分保存失败） */
  const [error, setError] = useState<string | null>(null);
  /** 中断恢复：检测到 localStorage 中的未完成会话时显示恢复入口 */
  const [savedSession, setSavedSession] = useState<SavedReviewSession | null>(null);

  /** 当前所处的阶段（由 usePhaseMachine 管理） */
  const { phase, transition, setPhase } = usePhaseMachine<Phase>("entry", {
    onEnter: {
      reviewing: () => {
        setCurrentIndex(0);
        setFlipped(false);
        setResults([]);
      },
      done: () => {
        clearReviewSession();
        getReviewStats().then(setStats);
      },
    },
  });

  /** 挂载时加载复习统计数据 + 检查中断会话 */
  useEffect(() => {
    getReviewStats().then(setStats);
    setSavedSession(loadReviewSession());
  }, []);

  /**
   * 加载待复习单词并进入复习阶段。
   * 从数据库获取 next_review_at <= 当前时间的单词。
   * 进入复习阶段后立即保存到 localStorage 以支持中断恢复。
   */
  const loadReview = useCallback(async () => {
    setLoading(true);
    const dueWords = await getReviewWords();
    setWords(dueWords);
    setLoading(false);
    transition("reviewing");
    saveReviewSession({
      words: dueWords,
      currentIndex: 0,
      results: [],
      savedAt: Date.now(),
    });
  }, [transition]);

  /**
   * 恢复中断的复习会话。
   * 从 localStorage 恢复单词列表、当前索引和已评分记录。
   */
  const resumeReview = useCallback(() => {
    if (!savedSession) return;
    setWords(savedSession.words);
    setCurrentIndex(savedSession.currentIndex);
    setResults(savedSession.results);
    setFlipped(false);
    setSavedSession(null);
    // 直接进入 reviewing 阶段，不触发 onEnter.reviewing（避免重置 results）
    setPhase("reviewing");
  }, [savedSession, setPhase]);

  /** 放弃中断的会话，清除 localStorage */
  const discardSession = useCallback(() => {
    clearReviewSession();
    setSavedSession(null);
  }, []);

  /**
   * 处理用户对当前单词的自评。
   * 流程：计算下次复习参数 → 更新数据库 → 记录结果 → 前进或结束。
   * handleRate 使用 useCallback + [words, currentIndex] 依赖，
   * 因为需要访问最新的 words[currentIndex]。
   */
  const handleRate = useCallback(
    async (rating: Rating) => {
      const word = words[currentIndex];
      if (!word) return;

      setError(null);
      try {
        // Send current FSRS card state + rating to the Rust FSRS algorithm
        const result = await calculateNextReview(word, rating);
        const status: ReviewStatus = isReviewStatus(result.status) ? result.status : "learning";
        const nextReviewAt = result.next_review_at;
        // Keep legacy review_count in sync: reset on "again", increment otherwise
        const newReviewCount = rating === "again" ? 0 : (word.review_count ?? 0) + 1;

        // Persist the updated FSRS card state along with legacy fields
        await updateWordReviewFsrs(word.id, status, newReviewCount, nextReviewAt, result.card);
        recordLearningActivitySafe("review");

        setResults((prev) => [...prev, { wordId: word.id, rating }]);

        if (currentIndex + 1 < words.length) {
          // 还有下一个单词
          const nextIndex = currentIndex + 1;
          setCurrentIndex(nextIndex);
          setFlipped(false); // 重置为正面
          // 持久化进度以支持中断恢复
          saveReviewSession({
            words,
            currentIndex: nextIndex,
            results: [...results, { wordId: word.id, rating }],
            savedAt: Date.now(),
          });
        } else {
          // 所有单词复习完毕 — transition("done") 会触发 onEnter.done 清除 localStorage
          transition("done");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "未知错误";
        setError(`评分保存失败：${msg}`);
      }
    },
    [words, currentIndex, transition, results],
  );

  // === 阶段一：入口页 ===
  if (phase === "entry") {
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">生词复习</h2>

        <Card className="max-w-md mx-auto">
          <CardContent className="p-8 flex flex-col items-center text-center space-y-6">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Brain className="h-8 w-8 text-primary" />
            </div>

            {stats ? (
              <div className="space-y-2">
                <p className="text-lg font-medium">
                  待复习 {stats.dueCount} 个 | 已掌握 {stats.masteredCount} 个
                </p>
                <p className="text-sm text-muted-foreground">
                  共 {stats.total} 个词汇，学习中 {stats.learningCount} 个
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">加载中...</p>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}

            {/* 有待复习单词时显示"开始复习"按钮，否则显示返回生词本 */}
            {stats && stats.dueCount > 0 ? (
              <Button size="lg" onClick={loadReview} disabled={loading}>
                {loading ? "加载中..." : "开始复习"}
              </Button>
            ) : stats ? (
              <div className="space-y-3 text-center">
                <p className="text-muted-foreground">暂无待复习的词汇</p>
                <Button variant="outline" onClick={() => navigate("/vocabulary")}>
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  返回生词本
                </Button>
              </div>
            ) : null}

            {/* 中断恢复入口 */}
            {savedSession && (
              <div className="w-full space-y-3 p-4 border rounded-lg bg-amber-500/5">
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  检测到未完成的复习会话（第 {savedSession.currentIndex + 1}/
                  {savedSession.words.length} 个）
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={resumeReview}>
                    继续复习
                  </Button>
                  <Button size="sm" variant="outline" onClick={discardSession}>
                    放弃
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // === 阶段二：翻牌复习 ===
  if (phase === "reviewing" && words.length > 0) {
    const word = words[currentIndex];
    const { collocations, example } = parseNotes(word.notes);
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">生词复习</h2>

        {/* 进度条：显示当前进度 */}
        <ProgressBar current={currentIndex + 1} total={words.length} />

        {/* 翻牌卡片：点击正面翻转显示释义 */}
        <Card
          className="max-w-lg mx-auto cursor-pointer select-none min-h-[280px]"
          onClick={() => {
            if (!flipped) setFlipped(true);
          }}
        >
          <CardContent className="p-8 flex flex-col items-center justify-center text-center space-y-4">
            {!flipped ? (
              /* 正面：单词 + 音标 */
              <>
                <div className="flex items-center gap-2">
                  <p className="text-3xl font-bold">{word.word}</p>
                  <SpeakButton text={word.word} size="icon-sm" />
                </div>
                {word.phonetic && <p className="text-lg text-muted-foreground">{word.phonetic}</p>}
                <p className="text-sm text-muted-foreground mt-4">点击翻转查看释义</p>
              </>
            ) : (
              /* 背面：释义 + 搭配 + 例句 */
              <>
                <div className="flex items-center gap-2">
                  <p className="text-2xl font-bold">{word.word}</p>
                  <SpeakButton text={word.word} size="icon-sm" />
                </div>
                {word.phonetic && <p className="text-sm text-muted-foreground">{word.phonetic}</p>}
                <div className="w-full border-t pt-4 space-y-3 text-left">
                  <p className="text-sm leading-relaxed">{word.definition}</p>
                  {collocations && (
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">搭配：</span>
                      {collocations}
                    </p>
                  )}
                  {example && (
                    <p className="text-sm text-muted-foreground italic">
                      <span className="font-medium text-foreground not-italic">例句：</span>
                      {example}
                    </p>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* 评分按钮 — 仅在翻转后显示（先看释义，再自评） */}
        {flipped && (
          <div className="space-y-3">
            {error && <p className="text-center text-sm text-red-500">{error}</p>}
            <div className="flex justify-center gap-4">
              <Button
                variant="outline"
                size="lg"
                className="border-red-500/50 text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                onClick={() => handleRate("again")}
              >
                不认识
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="border-yellow-500/50 text-yellow-600 hover:bg-yellow-500/10 hover:text-yellow-700 dark:text-yellow-400 dark:hover:text-yellow-300"
                onClick={() => handleRate("hard")}
              >
                模糊
              </Button>
              <Button
                variant="default"
                size="lg"
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={() => handleRate("good")}
              >
                认识
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // === 阶段三：完成总结 ===
  const goodCount = results.filter((r) => r.rating === "good").length;
  const hardCount = results.filter((r) => r.rating === "hard").length;
  const againCount = results.filter((r) => r.rating === "again").length;

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">生词复习</h2>

      <Card className="max-w-md mx-auto">
        <CardContent className="p-8 flex flex-col items-center text-center space-y-6">
          <div className="h-16 w-16 rounded-full bg-green-500/10 flex items-center justify-center">
            <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
          </div>

          <p className="text-lg font-medium">本轮复习完成</p>

          {/* 本轮复习结果统计 */}
          <div className="flex gap-6 text-sm">
            <span className="text-green-600 dark:text-green-400">认识 {goodCount} 个</span>
            <span className="text-yellow-600 dark:text-yellow-400">模糊 {hardCount} 个</span>
            <span className="text-red-600 dark:text-red-400">不认识 {againCount} 个</span>
          </div>

          <div className="flex flex-col gap-3 w-full max-w-xs">
            {/* 还有到期单词时可再来一轮 */}
            {stats && stats.dueCount > 0 && (
              <Button onClick={loadReview}>
                <RotateCcw className="h-4 w-4 mr-2" />
                再来一轮
              </Button>
            )}
            <Button variant="outline" onClick={() => navigate("/vocabulary")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              返回生词本
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
