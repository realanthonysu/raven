import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Trash2, Languages, BookCheck, BookOpen } from "lucide-react";
import { getHistory, deleteHistory } from "@/lib/history-storage";
import type { HistoryRecord } from "@/types";

const typeConfig = {
  translate: { label: "翻译", icon: Languages, color: "bg-blue-500/20 text-blue-400" },
  correct: { label: "纠正", icon: BookCheck, color: "bg-green-500/20 text-green-400" },
  reading: { label: "精读", icon: BookOpen, color: "bg-purple-500/20 text-purple-400" },
};

export default function HistoryPage() {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    setRecords(getHistory(filterType ?? undefined));
  }, [filterType]);

  function refresh() {
    setRecords(getHistory(filterType ?? undefined));
  }

  function handleDelete(id: number) {
    deleteHistory(id);
    refresh();
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">历史记录</h2>

      <div className="flex gap-2">
        <Button
          variant={filterType === null ? "default" : "outline"}
          size="sm"
          onClick={() => setFilterType(null)}
        >
          全部
        </Button>
        {Object.entries(typeConfig).map(([type, config]) => (
          <Button
            key={type}
            variant={filterType === type ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType(filterType === type ? null : type)}
          >
            {config.label}
          </Button>
        ))}
      </div>

      {records.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          暂无历史记录。
        </div>
      ) : (
        <div className="space-y-3">
          {records.map((record) => {
            const config = typeConfig[record.type as keyof typeof typeConfig];
            if (!config) return null;
            const Icon = config.icon;
            const isExpanded = expanded === record.id;

            return (
              <Card key={record.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className={config.color}>
                        <Icon className="h-3 w-3 mr-1" />
                        {config.label}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {new Date(record.created_at).toLocaleString("zh-CN")}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpanded(isExpanded ? null : record.id)}
                      >
                        {isExpanded ? "收起" : "展开"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleDelete(record.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-2 text-sm line-clamp-2">{record.input_text}</p>
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t text-sm whitespace-pre-wrap max-h-96 overflow-auto">
                      {record.result}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
