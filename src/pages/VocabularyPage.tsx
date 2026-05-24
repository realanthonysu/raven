import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { Brain, Search, Trash2, Bookmark } from "lucide-react";
import { getWords, deleteWord, updateWordLevel } from "@/lib/db";
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
 * - 展示所有从 Reading Copilot 添加的生词（SQLite words 表）
 * - 支持按关键词搜索和按等级（CET-4/6、TEM-4/8）筛选
 * - 每个单词可标记等级、查看详情（音标、释义、搭配、例句）
 * - 支持删除单词
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

  /** 组件挂载时加载全部单词 */
  useEffect(() => {
    getWords().then(setWords);
  }, []);

  /** 重新加载单词列表（增删改后调用） */
  function refresh() {
    getWords().then(setWords);
  }

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

  /** 前端过滤：搜索 + 等级双重筛选 */
  const filtered = words.filter((w) => {
    const matchSearch = !search || w.word.toLowerCase().includes(search.toLowerCase());
    const matchLevel = !filterLevel || w.level === filterLevel;
    return matchSearch && matchLevel;
  });

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">生词本</h2>
        {/* 跳转到复习页面 */}
        <Link to="/review">
          <Button variant="outline" size="sm">
            <Brain className="h-4 w-4 mr-2" />
            开始复习
          </Button>
        </Link>
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

      <p className="text-sm text-muted-foreground">
        共 {filtered.length} 个单词
      </p>

      {/* 三种状态：空生词本 / 筛选无结果 / 正常列表 */}
      {words.length === 0 ? (
        /* 生词本完全为空时的引导提示 */
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Bookmark className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">生词本暂无词汇</p>
          <p className="text-sm mt-1">在 Reading Copilot 中点击词汇即可添加</p>
        </div>
      ) : filtered.length === 0 ? (
        /* 有单词但筛选后无匹配 */
        <div className="text-center py-12 text-muted-foreground">
          没有匹配的单词。
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((word) => (
            <Card key={word.id}>
              <CardContent className="p-4 flex items-start justify-between">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-lg">{word.word}</span>
                    {word.phonetic && (
                      <span className="text-sm text-muted-foreground">
                        {word.phonetic}
                      </span>
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
