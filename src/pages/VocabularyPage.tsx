/**
 * @module VocabularyPage
 * @description 生词本页面。
 *
 * 管理用户收藏的所有英语生词，功能包括：
 * - 展示所有添加的生词（SQLite words 表），支持搜索和等级筛选
 * - 手动添加单词（支持自动 LLM 补全音标、释义、搭配、例句与词汇等级）
 * - CSV/TXT 批量导入（RFC 4180 引号字段支持，自动去重和补全）
 * - CSV 和 Anki 格式导出
 * - 批量补全缺失数据的单词
 * - 单词等级标记（11 级，见 WordLevelSchema）与"分级掌握度"统计
 * - 删除单词
 *
 * 数据流：服务端分页加载（getWordsPage）→ 搜索/等级筛选均下推服务端；
 * 删除/改等级/单条补全后局部更新已加载列表并刷新 getWordStats 聚合；
 * 新增/导入后重载第一页。
 * 注意：不再持有全量词表快照——分级统计由 getWordStats 单独聚合。
 *
 * 结构说明：批量补全 / CSV 导入 / 手动添加三大逻辑分别封装在
 * src/pages/vocabulary/ 下的 use-batch-enrich、use-vocabulary-import、
 * use-add-word 自定义 hook 中，本组件只保留列表加载与渲染。
 */

import {
  AlertCircle,
  Bookmark,
  Brain,
  Check,
  ChevronDown,
  Download,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { EmptyState, ErrorBanner } from "@/components/page-states";
import { SpeakButton } from "@/components/SpeakButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import type { FeedbackType } from "@/lib/constants";
import {
  deleteWord,
  exportWordsAnki,
  exportWordsCsv,
  getLocalDate,
  getWordStats,
  getWordsPage,
  updateWordEnrichment,
  updateWordLevel,
  type WordLevelStat,
  writeTextFileDialog,
} from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { WordLevelSchema } from "@/lib/schemas";
import { LEVEL_COLORS } from "@/lib/type-config";
import { cn } from "@/lib/utils";
import { buildEnrichmentUpdate, hasUsableEnrichment, needsEnrichment } from "@/lib/word-utils";
import { enrichWord } from "@/services/vocabulary-enrichment";
import type { Word, WordLevel } from "@/types";
import { useAddWord } from "./vocabulary/use-add-word";
import { useBatchEnrich } from "./vocabulary/use-batch-enrich";
import { useVocabularyImport } from "./vocabulary/use-vocabulary-import";

/**
 * 词汇等级选项 —— 从 WordLevelSchema 枚举派生（单一事实来源，
 * 与 schemas.ts / Rust ALLOWED_LEVELS 对齐）。筛选栏、手动添加表单
 * 与词卡标记按钮组三处 UI 共用同一份列表。
 */
const LEVELS: WordLevel[] = [...WordLevelSchema.options];

/** 分级掌握度统计行：某等级（或"未标记"）下的词量与复习进度分布 */
interface LevelStatRow {
  total: number;
  new: number;
  learning: number;
  mastered: number;
}

/** 服务端分页每页条数：首屏只拉取/渲染 100 条，避免大词汇量卡顿 */
const VOCAB_PAGE_SIZE = 100;

/** 词卡回调集合：页面侧全部用 useCallback 固定身份，memo 词卡才能挡住无关重渲 */
interface WordCardProps {
  word: Word;
  /** 该词是否正在单条补全（Set 查询结果压成布尔值，只有命中词才会变） */
  enriching: boolean;
  onEnrich: (word: Word) => void;
  onDelete: (word: Word) => void;
  onSetLevel: (id: number, level: WordLevel | "") => void;
}

/**
 * 单个词卡（P-09）—— memo 隔离的渲染单元。
 *
 * 页面级状态（搜索输入、批量进度）每次变化都会重渲 VocabularyPage；
 * 词卡是纯展示组件，props 引用稳定时 memo 会直接跳过子树
 * （每张卡约 11 个等级按钮 + SpeakButton + 删除/补全按钮）。
 */
const WordCard = memo(function WordCard({
  word,
  enriching,
  onEnrich,
  onDelete,
  onSetLevel,
}: WordCardProps) {
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-lg">{word.word}</span>
              <SpeakButton text={word.word} />
              {word.phonetic && (
                <span className="text-sm text-muted-foreground">{word.phonetic}</span>
              )}
              {/* 等级标签（已标记的高亮显示） */}
              {word.level && (
                <Badge variant="secondary" className={LEVEL_COLORS[word.level]}>
                  {word.level}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{word.definition}</p>
            {/* notes 包含搭配和例句，来源包括：ReadingPage VocabularySection、enrichWord LLM 补全、CSV 导入补全 */}
            {word.notes && <p className="text-xs text-muted-foreground italic">{word.notes}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* 补全按钮：仅对缺失数据的单词显示 */}
            {needsEnrichment(word) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => onEnrich(word)}
                disabled={enriching}
              >
                {enriching ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Wand2 className="h-3 w-3" />
                )}
              </Button>
            )}
            {/* 删除按钮 */}
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDelete(word)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {/* 等级标记按钮组：11 级（schema 枚举派生）；点击设置/切换等级，
            当前等级以 LEVEL_COLORS 徽章色高亮；再次点击当前等级则取消
            （清空），与顶部等级筛选的 toggle 语义一致 */}
        <div className="flex flex-wrap gap-1">
          {LEVELS.map((level) => (
            <Button
              key={level}
              variant="ghost"
              size="sm"
              className={cn("h-6 text-xs", word.level === level && LEVEL_COLORS[level])}
              onClick={() => onSetLevel(word.id, word.level === level ? "" : level)}
            >
              {level}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
});

interface VocabularyListProps {
  words: Word[];
  total: number;
  loadingMore: boolean;
  enrichingIds: Set<number>;
  onEnrich: (word: Word) => void;
  onDelete: (word: Word) => void;
  onSetLevel: (id: number, level: WordLevel | "") => void;
  onLoadMore: () => void;
}

/**
 * 词表渲染块（P-09）—— 把「100 张词卡 + 显示更多」整体 memo 化。
 *
 * 批量补全/导入的进度 state 每完成一项就更新一次（H-12）：进度更新只重渲
 * 页面壳（按钮/统计区），本组件 props 全部引用稳定时整块跳过，
 * 100 张卡上的上千个按钮不再参与每次进度 tick 的 reconcile。
 */
const VocabularyList = memo(function VocabularyList({
  words,
  total,
  loadingMore,
  enrichingIds,
  onEnrich,
  onDelete,
  onSetLevel,
  onLoadMore,
}: VocabularyListProps) {
  return (
    <div className="space-y-3">
      {words.map((word) => (
        <WordCard
          key={word.id}
          word={word}
          enriching={enrichingIds.has(word.id)}
          onEnrich={onEnrich}
          onDelete={onDelete}
          onSetLevel={onSetLevel}
        />
      ))}
      {/* 服务端分页：按已加载条数作 offset 拉下一页并 append */}
      {words.length < total && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <ChevronDown className="h-4 w-4 mr-2" />
            )}
            {loadingMore ? "加载中..." : `显示更多（已显示 ${words.length} / ${total}）`}
          </Button>
        </div>
      )}
    </div>
  );
});

/**
 * 生词本页面。
 *
 * 功能：
 * - 展示所有添加的生词（SQLite words 表）
 * - 支持按关键词搜索和按等级（11 级）筛选
 * - 顶部"分级掌握度"卡片按等级汇总词量与复习进度（新词/学习中/已掌握）
 * - 每个单词可标记等级、查看详情（音标、释义、搭配、例句）
 * - 支持删除单词
 * - 手动添加单词（可折叠表单，支持自动 LLM 补全）
 * - CSV/TXT 批量导入（逗号或 Tab 分隔，自动去重和补全）
 * - 顶部提供"开始复习"入口，跳转到 ReviewPage
 *
 * 数据流：组件挂载时从 SQLite 加载第一页 → 搜索词（300ms 防抖）与等级筛选都下推
 * 到服务端 `getWordsPage`；写操作后局部更新已加载列表并刷新统计，不再全量拉取。
 * 注意：等级筛选由服务端 `level` 参数过滤，前端不再持有全量词库快照。
 */
export default function VocabularyPage() {
  const [words, setWords] = useState<Word[]>([]);
  /** 当前筛选条件下的服务端总词数（用于"已显示 x / total"与显示更多） */
  const [total, setTotal] = useState(0);
  /** 搜索关键词（不区分大小写匹配单词） */
  const [search, setSearch] = useState("");
  /** search 的 ref 镜像：写操作后的首页重载需要按当前搜索条件拉取 */
  const searchRef = useRef(search);
  searchRef.current = search;
  /** 当前选中的等级筛选（null 表示不筛选） */
  const [filterLevel, setFilterLevel] = useState<string | null>(null);
  /** filterLevel 的 ref 镜像：写操作后的首页重载需要按当前筛选条件拉取 */
  const filterLevelRef = useRef(filterLevel);
  filterLevelRef.current = filterLevel;
  /** 正在加载下一页（显示更多） */
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * 分级掌握度聚合（由 getWordStats 按 level × review_status 分组返回）。
   * 不再依赖全量词表快照：统计区始终反映整个词库，与当前分页/搜索窗口无关。
   */
  const [wordStats, setWordStats] = useState<WordLevelStat[]>([]);
  /** 正在补全的单词 ID 集合 */
  const [enrichingIds, setEnrichingIds] = useState<Set<number>>(new Set());
  /** 初始加载错误状态 */
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- 操作反馈消息 ---
  const [message, setMessage] = useState<{
    type: FeedbackType;
    text: string;
  } | null>(null);

  // --- 导出状态 ---
  const [exporting, setExporting] = useState(false);

  /** 消息定时器 ref，用于卸载时清理 */
  const messageTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    return () => {
      clearTimeout(messageTimerRef.current);
    };
  }, []);

  /** 显示临时消息，3 秒后自动消失 */
  const showMessage = useCallback((type: FeedbackType, text: string) => {
    clearTimeout(messageTimerRef.current);
    setMessage({ type, text });
    messageTimerRef.current = setTimeout(() => setMessage(null), 3000);
  }, []);

  /**
   * 第一页加载入口：按搜索词 + 等级筛选从服务端拉取分页数据。
   * 防抖搜索、筛选切换、写后重载可能交错，慢的旧响应不允许覆盖新结果——
   * 用 useStaleGuard 序号守卫丢弃过期响应（机制文档归 hook 所有）。
   */
  const { begin, current, isStale } = useStaleGuard();
  const loadFirstPage = useCallback(
    (keyword: string, level: string | null, errorContext: string) => {
      const seq = begin();
      getWordsPage({
        limit: VOCAB_PAGE_SIZE,
        search: keyword.trim() || undefined,
        level,
      })
        .then((page) => {
          if (isStale(seq)) return;
          setWords(page.items);
          setTotal(page.total);
          setLoadError(null);
        })
        .catch((err) => {
          if (isStale(seq)) return;
          setLoadError(getErrorMessage(err, errorContext));
        });
    },
    [begin, isStale],
  );

  /** 分级统计聚合刷新：失败保留上一次快照（统计降级不阻塞主列表，控制台留痕）。 */
  const refreshStats = useCallback(() => {
    getWordStats()
      .then(setWordStats)
      .catch((err) => {
        console.warn("Vocabulary stats refresh failed:", err);
      });
  }, []);

  // 挂载时加载一次统计聚合（与首页列表加载并行）
  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  /**
   * 写操作后的首页重载（新增/导入）：按当前搜索 + 等级筛选拉第一页并刷新统计。
   * 删除/改等级/单条补全走局部更新，不走这里。
   */
  const reloadFirstPageAfterWrite = useCallback(() => {
    loadFirstPage(searchRef.current, filterLevelRef.current, "加载词汇失败");
    refreshStats();
  }, [loadFirstPage, refreshStats]);

  /** 搜索词 / 等级筛选变化 → 重新加载第一页（搜索非空时 300ms 防抖）。 */
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (search === "") {
      loadFirstPage("", filterLevel, "加载词汇失败");
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadFirstPage(search, filterLevel, "搜索失败");
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search, filterLevel, loadFirstPage]);

  /** 显示更多：按已加载条数作 offset 拉下一页并 append（与首屏加载共用 stale 守卫序号）。 */
  const loadMore = useCallback(async () => {
    if (loadingMore || words.length >= total) return;
    setLoadingMore(true);
    const seqAtStart = current();
    const keywordAtStart = searchRef.current;
    const levelAtStart = filterLevelRef.current;
    try {
      const page = await getWordsPage({
        limit: VOCAB_PAGE_SIZE,
        offset: words.length,
        search: keywordAtStart.trim() || undefined,
        level: levelAtStart,
      });
      // 期间若搜索/筛选变化或发起了新的首屏加载，丢弃本轮结果
      if (
        isStale(seqAtStart) ||
        keywordAtStart !== searchRef.current ||
        levelAtStart !== filterLevelRef.current
      ) {
        return;
      }
      setWords((prev) => {
        const seen = new Set(prev.map((w) => w.id));
        return [...prev, ...page.items.filter((w) => !seen.has(w.id))];
      });
      setTotal(page.total);
      setLoadError(null);
    } catch (err) {
      setLoadError(getErrorMessage(err, "加载更多失败"));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, words.length, total, current, isStale]);

  /** 删除单词：成功后本地移除该词并刷新统计，不重新拉取列表（带二次确认防误删）。
   *  useCallback 固定身份：词卡已 memo，回调引用抖动会击穿 memo（P-09）。 */
  const handleDelete = useCallback(
    async (word: Word) => {
      if (!window.confirm(`确定删除 "${word.word}" 吗？此操作不可撤销。`)) return;
      try {
        await deleteWord(word.id);
        setWords((prev) => prev.filter((w) => w.id !== word.id));
        setTotal((prev) => Math.max(0, prev - 1));
        refreshStats();
        showMessage("success", "已删除");
      } catch (err) {
        showMessage("error", `删除失败: ${getErrorMessage(err)}`);
      }
    },
    [refreshStats, showMessage],
  );

  /** 设置单词的考试等级标签（点击同级标签可取消：传空串清空等级，
   *  Rust 侧 update_word_level 对空串执行清空而非拒绝）。
   *  成功后局部更新词条；当前有等级筛选且新等级不再匹配时从列表移除。
   *  useCallback 固定身份：与 handleDelete 同理，保住 memo 词卡。 */
  const handleSetLevel = useCallback(
    async (id: number, level: WordLevel | "") => {
      const nextLevel: WordLevel | null = level === "" ? null : level;
      const activeLevel = filterLevelRef.current;
      try {
        await updateWordLevel(id, level);
      } catch (err) {
        showMessage("error", `设置等级失败: ${getErrorMessage(err)}`);
        return;
      }
      const leavesFilter = activeLevel !== null && nextLevel !== activeLevel;
      setWords((prev) => {
        if (leavesFilter) return prev.filter((w) => w.id !== id);
        return prev.map((w) => (w.id === id ? { ...w, level: nextLevel } : w));
      });
      if (leavesFilter) setTotal((prev) => Math.max(0, prev - 1));
      refreshStats();
    },
    [refreshStats, showMessage],
  );

  /**
   * 补全单个单词的详细信息。
   * 调用 enrichWord 获取 LLM 数据，成功后更新数据库并刷新列表。
   * 失败时通过 showMessage 提示用户（BUG-06 修复：之前静默失败）。
   * 补全结果任一核心字段为空同样视为失败：写库会清空原音标/释义
   * 并误报成功（E5，判定与批量补全共用 hasUsableEnrichment）。
   */
  const handleEnrich = useCallback(
    async (word: Word) => {
      setEnrichingIds((prev) => new Set(prev).add(word.id));
      try {
        const enriched = await enrichWord(word.word);
        if (enriched && hasUsableEnrichment(enriched)) {
          const update = buildEnrichmentUpdate(enriched);
          await updateWordEnrichment(word.id, update);
          // 局部合并写库结果，避免为一次补全重新拉取整个列表/统计
          setWords((prev) =>
            prev.map((w) =>
              w.id === word.id
                ? {
                    ...w,
                    phonetic: update.phonetic,
                    definition: update.definition,
                    notes: update.notes,
                    // Rust 侧仅在原 level 为空时回填（buildEnrichmentUpdate 语义）
                    level: w.level ?? update.level ?? null,
                  }
                : w,
            ),
          );
          refreshStats();
        } else {
          showMessage("error", `"${word.word}" 补全失败，请稍后重试`);
        }
      } catch {
        showMessage("error", `"${word.word}" 补全失败，请检查网络连接`);
      } finally {
        setEnrichingIds((prev) => {
          const next = new Set(prev);
          next.delete(word.id);
          return next;
        });
      }
    },
    [refreshStats, showMessage],
  );

  /** 组件卸载时标记取消，中止批量补全 / CSV 导入（两个批处理共享同一 ref） */
  const cancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // --- 批量补全（use-batch-enrich hook） ---
  const { batchEnriching, batchProgress, handleBatchEnrich } = useBatchEnrich({
    words,
    cancelledRef,
    refresh: reloadFirstPageAfterWrite,
    showMessage,
  });

  // --- 手动添加单词（use-add-word hook；去重走后端存在性预检，不需要 words 快照）---
  const {
    formOpen,
    setFormOpen,
    formWord,
    setFormWord,
    formPhonetic,
    setFormPhonetic,
    formDefinition,
    setFormDefinition,
    formLevel,
    setFormLevel,
    adding,
    handleAddWord,
  } = useAddWord({ refresh: reloadFirstPageAfterWrite, showMessage });

  // --- CSV/TXT 导入（use-vocabulary-import hook；批量命令插入，无全量去重基线）---
  const { fileInputRef, importing, importProgress, handleImportClick, handleFileChange } =
    useVocabularyImport({ cancelledRef, refresh: reloadFirstPageAfterWrite, showMessage });

  /** 导出 CSV / Anki：仅文件名后缀与数据源不同，流程完全一致 */
  async function handleExport(kind: "csv" | "anki") {
    const config = {
      csv: {
        ext: "csv",
        content: exportWordsCsv,
        label: "CSV",
      },
      anki: {
        ext: "txt",
        content: exportWordsAnki,
        label: "Anki",
      },
    }[kind];

    setExporting(true);
    try {
      const content = await config.content();
      // 保存对话框与写入均在 Rust 侧完成：用户可任选位置（U 盘/网络共享等
      // 白名单外路径同样可用），取消时返回 null，静默返回即可
      const savedPath = await writeTextFileDialog(
        // 文件名日期取本地时区（与 BackupCard 的备份命名一致）——
        // toISOString() 是 UTC 日期，UTC+8 用户凌晨 0-8 点导出会得到昨天
        `raven-words-${getLocalDate()}.${config.ext}`,
        config.ext,
        content,
      );
      if (!savedPath) return;
      showMessage("success", `${config.label} 导出成功`);
    } catch {
      showMessage("error", `${config.label} 导出失败`);
    } finally {
      setExporting(false);
    }
  }

  /**
   * 分级掌握度统计：getWordStats 已按 level × review_status 聚合，这里按 11 级
   * 固定顺序展开为行；level 为 null（或意外非法值）计入"未标记"汇总行，
   * 只渲染词数 > 0 的等级。统计口径覆盖整个词库，与当前分页/搜索无关。
   */
  const statRows = useMemo(() => {
    const emptyStat = (): LevelStatRow => ({ total: 0, new: 0, learning: 0, mastered: 0 });
    const byLevel = new Map<WordLevel, LevelStatRow>(
      LEVELS.map((level) => [level, emptyStat()] as const),
    );
    const unmarked = emptyStat();
    for (const entry of wordStats) {
      const stat =
        entry.level && byLevel.has(entry.level as WordLevel)
          ? (byLevel.get(entry.level as WordLevel) as LevelStatRow)
          : unmarked;
      stat.total += entry.count;
      if (entry.review_status === "new") stat.new += entry.count;
      else if (entry.review_status === "learning") stat.learning += entry.count;
      else if (entry.review_status === "mastered") stat.mastered += entry.count;
    }
    return [
      ...LEVELS.map((level) => ({ level, stat: byLevel.get(level) ?? emptyStat() })),
      { level: null, stat: unmarked },
    ].filter((row) => row.stat.total > 0);
  }, [wordStats]);

  /** 是否存在缺释义/音标的单词（决定"批量补全"入口是否出现）。
   *  useMemo：只在词表变化时做一次 O(n) 扫描，批量进度/搜索输入的重渲不再重复扫描。 */
  const hasPendingEnrichment = useMemo(() => words.some(needsEnrichment), [words]);

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-2xl font-bold">生词本</h2>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* CSV 导入 */}
          {importing ? (
            <Button variant="outline" size="sm" disabled>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              导入中 {importProgress.current}/{importProgress.total}
            </Button>
          ) : (
            /* 与批量补全互斥：任一批次运行中都禁用导入入口，避免两个批次
               并发跑同一取消令牌（卸载时会被同时误判为取消） */
            <Button
              variant="outline"
              size="sm"
              onClick={handleImportClick}
              disabled={batchEnriching}
            >
              <Upload className="h-4 w-4 mr-2" />
              导入
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={handleFileChange}
          />
          {/* 导出下拉：CSV / Anki */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleExport("csv")}
            disabled={exporting || words.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            {exporting ? "导出中..." : "导出 CSV"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleExport("anki")}
            disabled={exporting || words.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            {exporting ? "导出中..." : "导出 Anki"}
          </Button>
          {/* 批量补全缺失数据的单词 */}
          {hasPendingEnrichment && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleBatchEnrich}
              disabled={batchEnriching || importing}
            >
              {batchEnriching ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  补全中 {batchProgress.current}/{batchProgress.total}
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4 mr-2" />
                  批量补全
                </>
              )}
            </Button>
          )}
          {/* 跳转到复习页面 */}
          <Link to="/review">
            <Button variant="outline" size="sm">
              <Brain className="h-4 w-4 mr-2" />
              开始复习
            </Button>
          </Link>
        </div>
      </div>

      {loadError && <ErrorBanner message={loadError} onDismiss={() => setLoadError(null)} />}

      {/* 搜索栏 + 等级筛选按钮组 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索单词..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {/* 等级筛选：toggle 模式，点击已选中的等级取消筛选；11 级按钮组允许换行 */}
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((level) => (
            <Button
              key={level}
              variant={filterLevel === level ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterLevel(filterLevel === level ? null : level)}
            >
              {level}
            </Button>
          ))}
        </div>
      </div>

      {/* 分级掌握度：按等级汇总词量与复习进度（数据源为全量快照，不受搜索/筛选影响） */}
      {statRows.length > 0 && (
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm">分级掌握度</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-2">
            {statRows.map(({ level, stat }) => (
              <div key={level ?? "unmarked"} className="flex items-center gap-3">
                {level ? (
                  <Badge
                    variant="secondary"
                    className={cn(LEVEL_COLORS[level], "w-16 shrink-0 justify-center")}
                  >
                    {level}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="w-16 shrink-0 justify-center">
                    未标记
                  </Badge>
                )}
                {/* 掌握度构成：已掌握 / 学习中 / 新词 三段堆叠条 */}
                <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  {stat.mastered > 0 && (
                    <div
                      className="h-full bg-green-500/70"
                      style={{ width: `${(stat.mastered / stat.total) * 100}%` }}
                    />
                  )}
                  {stat.learning > 0 && (
                    <div
                      className="h-full bg-amber-500/70"
                      style={{ width: `${(stat.learning / stat.total) * 100}%` }}
                    />
                  )}
                  {stat.new > 0 && (
                    <div
                      className="h-full bg-muted-foreground/30"
                      style={{ width: `${(stat.new / stat.total) * 100}%` }}
                    />
                  )}
                </div>
                <span className="w-36 shrink-0 text-right text-xs text-muted-foreground">
                  {stat.total} 词 · 新{stat.new} 学{stat.learning} 掌{stat.mastered}
                </span>
              </div>
            ))}
            {/* 图例：与堆叠条三段配色一一对应 */}
            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                新词
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-amber-500/70" />
                学习中
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-green-500/70" />
                已掌握
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 操作反馈消息 */}
      {message && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
            message.type === "success"
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : message.type === "error"
                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                : "bg-blue-500/10 text-blue-600 dark:text-blue-400",
          )}
        >
          {message.type === "success" && <Check className="h-4 w-4" />}
          {message.type === "error" && <AlertCircle className="h-4 w-4" />}
          {message.text}
        </div>
      )}

      {/* 手动添加单词（可折叠） */}
      <Card>
        <CardHeader
          className="py-3 px-4 cursor-pointer select-none"
          onClick={() => setFormOpen((v) => !v)}
        >
          <CardTitle className="text-sm flex items-center gap-2">
            <Plus className="h-4 w-4" />
            手动添加
            <ChevronDown
              className={cn(
                "ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200",
                formOpen && "rotate-180",
              )}
            />
          </CardTitle>
        </CardHeader>
        {formOpen && (
          <CardContent className="px-4 pb-4 pt-0">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="vocab-word" className="text-xs text-muted-foreground">
                  单词 <span className="text-red-500">*</span>
                </label>
                <Input
                  id="vocab-word"
                  placeholder="输入英文单词"
                  value={formWord}
                  onChange={(e) => setFormWord(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddWord()}
                  disabled={adding}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="vocab-phonetic" className="text-xs text-muted-foreground">
                  音标
                </label>
                <Input
                  id="vocab-phonetic"
                  placeholder="/fəˈnetɪk/"
                  value={formPhonetic}
                  onChange={(e) => setFormPhonetic(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddWord()}
                  disabled={adding}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="vocab-definition" className="text-xs text-muted-foreground">
                  释义
                </label>
                <Input
                  id="vocab-definition"
                  placeholder="中文释义（留空自动补全）"
                  value={formDefinition}
                  onChange={(e) => setFormDefinition(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddWord()}
                  disabled={adding}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="vocab-level" className="text-xs text-muted-foreground">
                  等级
                </label>
                <select
                  id="vocab-level"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  value={formLevel}
                  onChange={(e) => setFormLevel(e.target.value)}
                  disabled={adding}
                >
                  <option value="">不标记</option>
                  {LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <Button size="sm" onClick={handleAddWord} disabled={adding || !formWord.trim()}>
                {adding ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    添加中...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 mr-2" />
                    添加
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      <p className="text-sm text-muted-foreground">共 {total} 个单词</p>

      {/* 四种状态：空生词本 / 搜索无匹配 / 筛选无匹配 / 正常列表。
          分页与等级筛选均已服务端化：words 为空且无任何筛选条件时才是真空词库。
          非空列表交给 memo 化的 VocabularyList：批量进度/搜索输入触发的页面重渲
          不会穿透到词卡（P-09/H-12）。 */}
      {words.length === 0 && !search && !filterLevel ? (
        <EmptyState
          icon={Bookmark}
          title="生词本暂无词汇"
          subtitle="手动添加、导入 CSV，或在 Reading Copilot 中点击词汇添加"
        />
      ) : words.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">没有匹配的单词。</div>
      ) : (
        <VocabularyList
          words={words}
          total={total}
          loadingMore={loadingMore}
          enrichingIds={enrichingIds}
          onEnrich={handleEnrich}
          onDelete={handleDelete}
          onSetLevel={handleSetLevel}
          onLoadMore={loadMore}
        />
      )}
    </div>
  );
}
