import { ArrowLeft, Brain, CheckCircle2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  recordLearningActivity,
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

  /** 当前所处的阶段（由 usePhaseMachine 管理） */
  const { phase, transition } = usePhaseMachine<Phase>("entry", {
    onEnter: {
      reviewing: () => {
        setCurrentIndex(0);
        setFlipped(false);
        setResults([]);
      },
      done: () => {
        getReviewStats().then(setStats);
      },
    },
  });

  /** 挂载时加载复习统计数据（usePhaseMachine 不会对初始阶段触发 onEnter） */
  useEffect(() => {
    getReviewStats().then(setStats);
  }, []);

  /**
   * 加载待复习单词并进入复习阶段。
   * 从数据库获取 next_review_at <= 当前时间的单词。
   */
  const loadReview = useCallback(async () => {
    setLoading(true);
    const dueWords = await getReviewWords();
    setWords(dueWords);
    setLoading(false);
    transition("reviewing");
  }, [transition]);

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

      // Send current FSRS card state + rating to the Rust FSRS algorithm
      const result = await calculateNextReview(word, rating);
      const status: ReviewStatus = isReviewStatus(result.status) ? result.status : "learning";
      const nextReviewAt = result.next_review_at;
      // Keep legacy review_count in sync: reset on "again", increment otherwise
      const newReviewCount = rating === "again" ? 0 : (word.review_count ?? 0) + 1;

      // Persist the updated FSRS card state along with legacy fields
      await updateWordReviewFsrs(word.id, status, newReviewCount, nextReviewAt, result.card);
      recordLearningActivity("review").catch(() => {});

      setResults((prev) => [...prev, { wordId: word.id, rating }]);

      if (currentIndex + 1 < words.length) {
        // 还有下一个单词
        setCurrentIndex((i) => i + 1);
        setFlipped(false); // 重置为正面
      } else {
        // 所有单词复习完毕 — transition("done") 会触发 onEnter.done 刷新统计
        transition("done");
      }
    },
    [words, currentIndex, transition],
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
