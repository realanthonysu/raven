import {
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
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/page-states";
import { SpeakButton } from "@/components/SpeakButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  addWord,
  deleteWord,
  exportWordsAnki,
  exportWordsCsv,
  getWords,
  updateWordEnrichment,
  updateWordLevel,
} from "@/lib/db";
import { cn } from "@/lib/utils";
import { enrichWord } from "@/services/llm";
import type { Word, WordLevel } from "@/types";

/** 支持的词汇等级标签（对应英语考试级别） */
const LEVELS: WordLevel[] = ["CET-4", "CET-6", "TEM-4", "TEM-8"];

/** 各等级标签的颜色映射，用于 Badge 组件的 className */
const levelColors: Record<string, string> = {
  "CET-4": "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  "CET-6": "bg-green-500/20 text-green-600 dark:text-green-400",
  "TEM-4": "bg-purple-500/20 text-purple-600 dark:text-purple-400",
  "TEM-8": "bg-red-500/20 text-red-600 dark:text-red-400",
};

/**
 * 生词本页面。
 *
 * 功能：
 * - 展示所有添加的生词（SQLite words 表）
 * - 支持按关键词搜索和按等级（CET-4/6、TEM-4/8）筛选
 * - 每个单词可标记等级、查看详情（音标、释义、搭配、例句）
 * - 支持删除单词
 * - 手动添加单词（可折叠表单，支持自动 LLM 补全）
 * - CSV/TXT 批量导入（逗号或 Tab 分隔，自动去重和补全）
 * - 顶部提供"开始复习"入口，跳转到 ReviewPage
 *
 * 数据流：组件挂载时从 SQLite 加载全部单词 → 用户操作后 refresh() 重新加载。
 * 注意：搜索和等级筛选在前端进行（已全量加载），不走数据库查询。
 */
export default function VocabularyPage() {
  const [words, setWords] = useState<Word[]>([]);
  /** 搜索关键词（不区分大小写匹配单词） */
  const [search, setSearch] = useState("");
  /** 当前选中的等级筛选（null 表示不筛选） */
  const [filterLevel, setFilterLevel] = useState<string | null>(null);
  /** 正在补全的单词 ID 集合 */
  const [enrichingIds, setEnrichingIds] = useState<Set<number>>(new Set());
  /** 批量补全进行中 */
  const [batchEnriching, setBatchEnriching] = useState(false);
  /** 批量补全进度 */
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

  // --- 手动添加表单状态 ---
  const [formOpen, setFormOpen] = useState(false);
  const [formWord, setFormWord] = useState("");
  const [formPhonetic, setFormPhonetic] = useState("");
  const [formDefinition, setFormDefinition] = useState("");
  const [formLevel, setFormLevel] = useState<string>("");
  const [adding, setAdding] = useState(false);

  // --- CSV 导入状态 ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });

  // --- 操作反馈消息 ---
  const [message, setMessage] = useState<{ type: "success" | "info"; text: string } | null>(null);

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
  const showMessage = useCallback((type: "success" | "info", text: string) => {
    clearTimeout(messageTimerRef.current);
    setMessage({ type, text });
    messageTimerRef.current = setTimeout(() => setMessage(null), 3000);
  }, []);

  /** 组件挂载时加载全部单词 */
  useEffect(() => {
    getWords().then(setWords);
  }, []);

  /** 重新加载单词列表（增删改后调用） */
  const refresh = useCallback(() => {
    getWords().then(setWords);
  }, []);

  /** 删除单词并刷新列表 */
  async function handleDelete(id: number) {
    await deleteWord(id);
    refresh();
  }

  /** 设置单词的考试等级标签（点击同级标签可取消） */
  async function handleSetLevel(id: number, level: WordLevel) {
    await updateWordLevel(id, level);
    refresh();
  }

  /**
   * 判断单词是否需要补全（释义为"待补充"或音标缺失）。
   */
  const needsEnrichment = useCallback((word: Word) => {
    return word.definition === "待补充" || !word.phonetic;
  }, []);

  /**
   * 补全单个单词的详细信息。
   * 调用 enrichWord 获取 LLM 数据，成功后更新数据库并刷新列表。
   */
  const handleEnrich = useCallback(
    async (word: Word) => {
      setEnrichingIds((prev) => new Set(prev).add(word.id));
      try {
        const enriched = await enrichWord(word.word);
        if (enriched) {
          const notes =
            [
              enriched.collocations && `搭配: ${enriched.collocations}`,
              enriched.example && `例句: ${enriched.example}`,
            ]
              .filter(Boolean)
              .join("\n") || null;

          await updateWordEnrichment(word.id, {
            phonetic: enriched.phonetic || "",
            definition: enriched.definition || "待补充",
            notes: notes || "",
          });
          refresh();
        }
      } catch {
        // enrichment 失败，静默忽略
      } finally {
        setEnrichingIds((prev) => {
          const next = new Set(prev);
          next.delete(word.id);
          return next;
        });
      }
    },
    [refresh],
  );

  /** 组件卸载时标记取消，中止批量补全 */
  const cancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  /**
   * 批量补全所有缺失数据的单词。
   * 逐个处理，每完成一个更新进度条。组件卸载时自动中止。
   */
  const handleBatchEnrich = useCallback(async () => {
    const toEnrich = words.filter(needsEnrichment);
    if (toEnrich.length === 0) return;

    cancelledRef.current = false;
    setBatchEnriching(true);
    setBatchProgress({ current: 0, total: toEnrich.length });

    const processedIds = new Set<number>();
    let completed = 0;

    for (const word of toEnrich) {
      if (cancelledRef.current) break;
      if (processedIds.has(word.id)) continue;
      processedIds.add(word.id);

      setBatchProgress({ current: completed, total: toEnrich.length });
      try {
        const enriched = await enrichWord(word.word);
        if (enriched && !cancelledRef.current) {
          const notes =
            [
              enriched.collocations && `搭配: ${enriched.collocations}`,
              enriched.example && `例句: ${enriched.example}`,
            ]
              .filter(Boolean)
              .join("\n") || null;

          await updateWordEnrichment(word.id, {
            phonetic: enriched.phonetic || "",
            definition: enriched.definition || "待补充",
            notes: notes || "",
          });
        }
      } catch {
        // 单个失败继续处理下一个
      }
      completed++;
    }

    if (!cancelledRef.current) {
      setBatchEnriching(false);
      setBatchProgress({ current: 0, total: 0 });
      refresh();
    }
  }, [words, needsEnrichment, refresh]);

  /**
   * 手动添加单词。
   * 如果用户未填写释义，自动调用 enrichWord 补全。
   */
  const handleAddWord = useCallback(async () => {
    const wordText = formWord.trim();
    if (!wordText) return;

    // 检查重复
    if (words.some((w) => w.word.toLowerCase() === wordText.toLowerCase())) {
      showMessage("info", `"${wordText}" 已存在于生词本中`);
      return;
    }

    setAdding(true);
    try {
      let phonetic = formPhonetic.trim() || null;
      let definition = formDefinition.trim() || "待补充";
      let notes: string | null = null;

      // 如果用户没有填写释义，调用 LLM 补全
      if (!formDefinition.trim()) {
        const enriched = await enrichWord(wordText);
        if (enriched) {
          phonetic = enriched.phonetic || phonetic;
          definition = enriched.definition || definition;
          notes =
            [
              enriched.collocations && `搭配: ${enriched.collocations}`,
              enriched.example && `例句: ${enriched.example}`,
            ]
              .filter(Boolean)
              .join("\n") || null;
        }
      }

      await addWord({
        word: wordText,
        phonetic,
        definition,
        level: (formLevel as WordLevel) || null,
        source_type: "manual",
        source_text: null,
        notes,
        review_status: "new",
      });

      // 清空表单
      setFormWord("");
      setFormPhonetic("");
      setFormDefinition("");
      setFormLevel("");
      refresh();
      showMessage("success", `已添加 "${wordText}"`);
    } catch {
      showMessage("info", "添加失败，请重试");
    } finally {
      setAdding(false);
    }
  }, [formWord, formPhonetic, formDefinition, formLevel, words, showMessage, refresh]);

  /** 触发隐藏的文件选择器 */
  function handleImportClick() {
    fileInputRef.current?.click();
  }

  /**
   * 解析并导入 CSV/TXT 文件。
   * 支持逗号和 Tab 分隔，首行如果包含 "word" 则跳过表头。
   */
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // 重置 file input 以便重复选择同一文件
    e.target.value = "";

    const text = await file.text();
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length === 0) {
      showMessage("info", "文件为空");
      return;
    }

    // 跳过表头行
    const startIndex = lines[0]?.toLowerCase().includes("word") ? 1 : 0;
    const dataLines = lines.slice(startIndex);
    if (dataLines.length === 0) {
      showMessage("info", "没有可导入的数据行");
      return;
    }

    cancelledRef.current = false;
    setImporting(true);
    setImportProgress({ current: 0, total: dataLines.length });

    let imported = 0;
    let skipped = 0;
    let enriched = 0;

    // 建立现有单词的查找集合（小写）
    const existingSet = new Set(words.map((w) => w.word.toLowerCase()));

    for (let i = 0; i < dataLines.length; i++) {
      if (cancelledRef.current) break;
      setImportProgress({ current: i, total: dataLines.length });

      const parts = dataLines[i].split(/[,\t]/).map((s) => s.trim());
      const [word, phonetic, definition, level] = parts;
      if (!word) continue;

      // 检查重复（包含本次导入中已添加的词）
      if (existingSet.has(word.toLowerCase())) {
        skipped++;
        continue;
      }

      try {
        const hasDefinition = definition && definition !== "待补充";

        const addResult = await addWord({
          word,
          phonetic: phonetic || null,
          definition: definition || "待补充",
          level: (level as WordLevel) || null,
          source_type: "import",
          source_text: null,
          notes: null,
          review_status: "new",
        });
        const insertedId = (addResult as { lastInsertId?: number })?.lastInsertId;

        existingSet.add(word.toLowerCase());
        imported++;

        // 如果没有释义，自动补全
        if (!hasDefinition) {
          try {
            const enrichedData = await enrichWord(word);
            if (enrichedData && !cancelledRef.current) {
              const notes =
                [
                  enrichedData.collocations && `搭配: ${enrichedData.collocations}`,
                  enrichedData.example && `例句: ${enrichedData.example}`,
                ]
                  .filter(Boolean)
                  .join("\n") || null;

              if (insertedId) {
                await updateWordEnrichment(insertedId, {
                  phonetic: enrichedData.phonetic || "",
                  definition: enrichedData.definition || "待补充",
                  notes: notes || "",
                });
                enriched++;
              }
            }
          } catch {
            // 单个补全失败继续
          }
        }
      } catch {
        // 单个导入失败继续
      }
    }

    if (!cancelledRef.current) {
      setImporting(false);
      setImportProgress({ current: 0, total: 0 });
      refresh();

      const parts = [`导入完成：${imported} 个新词`];
      if (skipped > 0) parts.push(`${skipped} 个重复跳过`);
      if (enriched > 0) parts.push(`${enriched} 个已自动补全`);
      showMessage("success", parts.join("，"));
    }
  }

  /** 通过浏览器 Blob 下载文件 */
  function downloadBlob(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 导出 CSV */
  async function handleExportCsv() {
    setExporting(true);
    try {
      const csv = await exportWordsCsv();
      downloadBlob(
        csv,
        `raven-words-${new Date().toISOString().slice(0, 10)}.csv`,
        "text/csv;charset=utf-8",
      );
      showMessage("success", "CSV 导出成功");
    } catch {
      showMessage("info", "CSV 导出失败");
    } finally {
      setExporting(false);
    }
  }

  /** 导出 Anki 格式 */
  async function handleExportAnki() {
    setExporting(true);
    try {
      const anki = await exportWordsAnki();
      downloadBlob(
        anki,
        `raven-words-${new Date().toISOString().slice(0, 10)}.txt`,
        "text/plain;charset=utf-8",
      );
      showMessage("success", "Anki 导出成功");
    } catch {
      showMessage("info", "Anki 导出失败");
    } finally {
      setExporting(false);
    }
  }

  /** 前端过滤：搜索 + 等级双重筛选 */
  const filtered = words.filter((w) => {
    const matchSearch = !search || w.word.toLowerCase().includes(search.toLowerCase());
    const matchLevel = !filterLevel || w.level === filterLevel;
    return matchSearch && matchLevel;
  });

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
            <Button variant="outline" size="sm" onClick={handleImportClick}>
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
            onClick={handleExportCsv}
            disabled={exporting || words.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            {exporting ? "导出中..." : "导出 CSV"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportAnki}
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
              disabled={batchEnriching}
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

      {/* 搜索栏 + 等级筛选按钮组 */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索单词..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {/* 等级筛选：toggle 模式，点击已选中的等级取消筛选 */}
        <div className="flex gap-2">
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

      {/* 操作反馈消息 */}
      {message && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
            message.type === "success"
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-blue-500/10 text-blue-600 dark:text-blue-400",
          )}
        >
          {message.type === "success" && <Check className="h-4 w-4" />}
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
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
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

      {/* 三种状态：空生词本 / 筛选无结果 / 正常列表 */}
      {words.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="生词本暂无词汇"
          subtitle="手动添加、导入 CSV，或在 Reading Copilot 中点击词汇添加"
        />
      ) : filtered.length === 0 ? (
        /* 有单词但筛选后无匹配 */
        <div className="text-center py-12 text-muted-foreground">没有匹配的单词。</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((word) => (
            <Card key={word.id}>
              <CardContent className="p-4 flex items-start justify-between">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-lg">{word.word}</span>
                    <SpeakButton text={word.word} />
                    {word.phonetic && (
                      <span className="text-sm text-muted-foreground">{word.phonetic}</span>
                    )}
                    {/* 等级标签（已标记的高亮显示） */}
                    {word.level && (
                      <Badge variant="secondary" className={levelColors[word.level]}>
                        {word.level}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{word.definition}</p>
                  {/* notes 包含搭配和例句，由 ReadingPage 的 VocabularySection 写入 */}
                  {word.notes && (
                    <p className="text-xs text-muted-foreground italic">{word.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* 等级标记按钮组：点击设置/切换等级，当前等级高亮 */}
                  <div className="flex gap-1">
                    {LEVELS.map((level) => (
                      <Button
                        key={level}
                        variant="ghost"
                        size="sm"
                        className={`h-6 text-xs ${word.level === level ? "bg-primary/20" : ""}`}
                        onClick={() => handleSetLevel(word.id, level)}
                      >
                        {level}
                      </Button>
                    ))}
                  </div>
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
                    onClick={() => handleDelete(word.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
