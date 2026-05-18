import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Search, Trash2 } from "lucide-react";
import { getWords, deleteWord, updateWordLevel } from "@/lib/db";
import type { Word, WordLevel } from "@/types";

const LEVELS: WordLevel[] = ["CET-4", "CET-6", "TEM-4", "TEM-8"];

const levelColors: Record<string, string> = {
  "CET-4": "bg-blue-500/20 text-blue-400",
  "CET-6": "bg-green-500/20 text-green-400",
  "TEM-4": "bg-purple-500/20 text-purple-400",
  "TEM-8": "bg-red-500/20 text-red-400",
};

export default function VocabularyPage() {
  const [words, setWords] = useState<Word[]>([]);
  const [search, setSearch] = useState("");
  const [filterLevel, setFilterLevel] = useState<string | null>(null);

  useEffect(() => {
    getWords().then(setWords);
  }, []);

  function refresh() {
    getWords().then(setWords);
  }

  async function handleDelete(id: number) {
    await deleteWord(id);
    refresh();
  }

  async function handleSetLevel(id: number, level: WordLevel) {
    await updateWordLevel(id, level);
    refresh();
  }

  const filtered = words.filter((w) => {
    const matchSearch = !search || w.word.toLowerCase().includes(search.toLowerCase());
    const matchLevel = !filterLevel || w.level === filterLevel;
    return matchSearch && matchLevel;
  });

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">生词本</h2>

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

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {words.length === 0
            ? "暂无单词，可在精读页面点击单词添加。"
            : "没有匹配的单词。"}
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
                    {word.level && (
                      <Badge variant="secondary" className={levelColors[word.level]}>
                        {word.level}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{word.definition}</p>
                  {word.notes && (
                    <p className="text-xs text-muted-foreground italic">{word.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
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
