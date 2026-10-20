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
 * 数据流：挂载时全量加载 → 操作后 refresh() 重新加载。
 * 搜索走服务端 getWords 的 LIKE 查询，等级筛选在前端进行（已加载数据内过滤）。
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  getWords,
  updateWordEnrichment,
  updateWordLevel,
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

/** 列表增量渲染的每页条数：首屏只渲染 100 条 DOM，避免大词汇量卡顿 */
const RENDER_PAGE_SIZE = 100;

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
 * 数据流：组件挂载时从 SQLite 加载单词 → 搜索词变化时按关键字从服务端拉取（B2 分页搜索）→
 * 用户操作后 refresh() 按当前搜索条件重新加载。
 * 注意：搜索走服务端 getWords 的 LIKE 查询（limit/offset 分页），等级筛选在前端进行（已加载数据内过滤）。
 */
export default function VocabularyPage() {
  const [words, setWords] = useState<Word[]>([]);
  /**
   * 分级统计用的全量词表快照。
   *
   * 取舍：不额外发 IPC——挂载与清空搜索时主列表本就是全量加载
   * （getWords 不传 limit，Rust 侧返回全部、不受 500 钳制），统计直接复用
   * 同一响应，本地桌面应用的词量下这一次加载即可覆盖整个词库；若页面已有
   * 全量数据则直接复用，避免重复请求。搜索态下主列表只是结果子集，写操作
   * 后的 refresh() 会另拉一次全量更新本快照（见 refreshStats），使统计区
   * 始终反映整个词库而非搜索结果子集。
   */
  const [statsWords, setStatsWords] = useState<Word[]>([]);
  /** 搜索关键词（不区分大小写匹配单词） */
  const [search, setSearch] = useState("");
  /** search 的 ref 镜像：refresh() 在增删改后需要按当前搜索条件重新拉取 */
  const searchRef = useRef(search);
  searchRef.current = search;
  /** 当前选中的等级筛选（null 表示不筛选） */
  const [filterLevel, setFilterLevel] = useState<string | null>(null);
  /** 增量渲染：当前最多渲染的列表条数（搜索/筛选变化时重置） */
  const [visibleCount, setVisibleCount] = useState(RENDER_PAGE_SIZE);
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
   * 统一的列表加载入口：按关键字从服务端拉取并写入 state。
   * 防抖搜索、refresh()、挂载加载可能交错，慢的旧响应不允许覆盖新结果——
   * 用 useStaleGuard 序号守卫丢弃过期响应（机制文档归 hook 所有）。
   */
  const { begin, isStale } = useStaleGuard();
  const loadWords = useCallback(
    (keyword: string | undefined, errorContext: string) => {
      const seq = begin();
      getWords(undefined, undefined, keyword)
        .then((loaded) => {
          if (isStale(seq)) return;
          setWords(loaded);
          // 无关键字即全量加载：同步刷新分级统计快照（复用同一响应，零额外 IPC）
          if (!keyword) setStatsWords(loaded);
          setLoadError(null);
        })
        .catch((err) => {
          if (isStale(seq)) return;
          setLoadError(getErrorMessage(err, errorContext));
        });
    },
    [begin, isStale],
  );

  /**
   * 分级统计快照的独立刷新入口（搜索态 refresh 专用）。
   *
   * 搜索态下主列表只是全量词库的子集，统计区必须另拉一次全量数据；
   * 该请求与主列表加载可能交错，用独立的 useStaleGuard 序号守卫丢弃
   * 迟到的旧响应，避免慢的全量响应覆盖新结果。失败时保留上一次快照
   * （统计降级不阻塞主列表，控制台留痕）。
   */
  const { begin: beginStats, isStale: isStatsStale } = useStaleGuard();
  const refreshStats = useCallback(() => {
    const seq = beginStats();
    getWords()
      .then((all) => {
        if (isStatsStale(seq)) return;
        setStatsWords(all);
      })
      .catch((err) => {
        console.warn("Vocabulary stats refresh failed:", err);
      });
  }, [beginStats, isStatsStale]);

  /**
   * 重新加载单词列表（增删改后调用）。按当前搜索条件拉取——若省略 search，
   *  搜索态下删除/添加/补全后列表会被全量数据覆盖（B2 服务端搜索的回归）。
   *  搜索态下主列表只是全量词库的子集，需额外拉一次全量刷新分级统计快照
   *  （无搜索词时 loadWords 的全量响应已同步刷新 statsWords，无需重复请求）。
   */
  const refresh = useCallback(() => {
    loadWords(searchRef.current, "加载词汇失败");
    if (searchRef.current) refreshStats();
  }, [loadWords, refreshStats]);

  /** 搜索词变化 → 列表加载（与挂载首屏合并为同一 effect）。
   *  search 为空串时立即全量加载：挂载首屏和用户清空搜索框都走这条路径，
   *  避免"挂载 effect + 防抖 effect 首次执行"各发一次相同的 db_get_words
   *  全表 IPC（空串走 getWords 时服务端同样返回全量，语义一致）；
   *  非空关键词才走 300ms 防抖后按关键字从服务端拉取（B2）。 */
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (search === "") {
      loadWords(undefined, "加载词汇失败");
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadWords(search, "搜索失败");
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search, loadWords]);

  /** 删除单词并刷新列表（带二次确认，防止误点垃圾桶永久删除） */
  async function handleDelete(id: number, word: string) {
    if (!window.confirm(`确定删除 "${word}" 吗？此操作不可撤销。`)) return;
    try {
      await deleteWord(id);
      showMessage("success", "已删除");
    } catch (err) {
      showMessage("error", `删除失败: ${getErrorMessage(err)}`);
      return;
    }
    refresh();
  }

  /** 设置单词的考试等级标签（点击同级标签可取消：传空串清空等级，
   *  Rust 侧 update_word_level 对空串执行清空而非拒绝） */
  async function handleSetLevel(id: number, level: WordLevel | "") {
    try {
      await updateWordLevel(id, level);
    } catch (err) {
      showMessage("error", `设置等级失败: ${getErrorMessage(err)}`);
      return;
    }
    refresh();
  }

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
          await updateWordEnrichment(word.id, buildEnrichmentUpdate(enriched));
          refresh();
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
    [refresh, showMessage],
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
    refresh,
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
  } = useAddWord({ refresh, showMessage });

  // --- CSV/TXT 导入（use-vocabulary-import hook；去重基线为导入时的全量词库）---
  const { fileInputRef, importing, importProgress, handleImportClick, handleFileChange } =
    useVocabularyImport({ cancelledRef, refresh, showMessage });

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

  /** 过滤：等级筛选在前端做（词库已按搜索词服务端过滤）。
   *  B2: 搜索下推给 Rust（word/definition/phonetic 模糊匹配），
   *  大词库不再全量拉取后在客户端逐词过滤。 */
  const filtered = useMemo(
    () => words.filter((w) => !filterLevel || w.level === filterLevel),
    [words, filterLevel],
  );

  // 搜索/筛选条件变化时重置增量渲染窗口，避免保留旧的展开深度
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在筛选条件变化时重置
  useEffect(() => {
    setVisibleCount(RENDER_PAGE_SIZE);
  }, [search, filterLevel]);

  /** 实际渲染的列表切片：DOM 数量受 visibleCount 钳制 */
  const visibleWords = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  /**
   * 分级掌握度统计：按 11 级固定顺序汇总 statsWords 的词量与复习进度分布。
   * level 为 null（或意外非法值）的词计入"未标记"汇总行；只渲染词数 > 0 的等级。
   * 数据源是全量快照而非 filtered，搜索/筛选不影响统计口径。
   */
  const statRows = useMemo(() => {
    const emptyStat = (): LevelStatRow => ({ total: 0, new: 0, learning: 0, mastered: 0 });
    const byLevel = new Map<WordLevel, LevelStatRow>(
      LEVELS.map((level) => [level, emptyStat()] as const),
    );
    const unmarked = emptyStat();
    for (const w of statsWords) {
      const stat = (w.level && byLevel.get(w.level)) || unmarked;
      stat.total++;
      if (w.review_status === "new") stat.new++;
      else if (w.review_status === "learning") stat.learning++;
      else if (w.review_status === "mastered") stat.mastered++;
    }
    return [
      ...LEVELS.map((level) => ({ level, stat: byLevel.get(level) ?? emptyStat() })),
      { level: null, stat: unmarked },
    ].filter((row) => row.stat.total > 0);
  }, [statsWords]);

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
          {words.some(needsEnrichment) && (
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

      <p className="text-sm text-muted-foreground">共 {filtered.length} 个单词</p>

      {/* 四种状态：空生词本 / 搜索无匹配 / 筛选无匹配 / 正常列表。
          B2 服务端搜索下,搜索无结果时 words 本身为空——若搜索词存在
          应显示"没有匹配的单词"而非误导性的"生词本暂无词汇" */}
      {words.length === 0 && !search ? (
        <EmptyState
          icon={Bookmark}
          title="生词本暂无词汇"
          subtitle="手动添加、导入 CSV，或在 Reading Copilot 中点击词汇添加"
        />
      ) : words.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">没有匹配的单词。</div>
      ) : filtered.length === 0 ? (
        /* 有单词但筛选后无匹配 */
        <div className="text-center py-12 text-muted-foreground">没有匹配的单词。</div>
      ) : (
        <div className="space-y-3">
          {visibleWords.map((word) => (
            <Card key={word.id}>
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
                    {word.notes && (
                      <p className="text-xs text-muted-foreground italic">{word.notes}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* 补全按钮：仅对缺失数据的单词显示 */}
                    {needsEnrichment(word) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={() => handleEnrich(word)}
                        disabled={enrichingIds.has(word.id)}
                      >
                        {enrichingIds.has(word.id) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Wand2 className="h-3 w-3" />
                        )}
                      </Button>
                    )}
                    {/* 删除按钮 */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleDelete(word.id, word.word)}
                    >
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
                      onClick={() => handleSetLevel(word.id, word.level === level ? "" : level)}
                    >
                      {level}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
          {/* 增量渲染：超出窗口的部分通过"显示更多"按页展开 */}
          {filtered.length > visibleCount && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVisibleCount((c) => c + RENDER_PAGE_SIZE)}
              >
                <ChevronDown className="h-4 w-4 mr-2" />
                显示更多（已显示 {visibleWords.length} / {filtered.length}）
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
