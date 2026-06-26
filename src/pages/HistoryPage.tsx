import { ChevronRight, History, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { deleteHistory, getHistoryList } from "@/lib/db";
import { typeConfig } from "@/lib/type-config";
import type { HistoryRecord } from "@/types";

/** 每页加载的记录数 */
const PAGE_SIZE = 20;

/** 按展示标签聚合的历史类型。 Writing 同时包含 legacy 的 correct 与新的 writing。 */
interface FilterGroup {
  label: string;
  types: string[];
}

/**
 * 历史记录页面。
 *
 * 展示所有写作纠错和阅读精读的历史记录，支持：
 * - 按类型筛选（全部 / Writing / Reading / Exercise / Listening）
 * - 分页加载（每次加载 PAGE_SIZE 条，点击"加载更多"追加）
 * - 点击卡片跳转到详情页
 * - 删除单条记录
 */
export default function HistoryPage() {
  const navigate = useNavigate();
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [filterLabel, setFilterLabel] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  /** 按展示标签聚合过滤组，避免 correct/writing 都显示为 Writing */
  const filterGroups = useMemo<FilterGroup[]>(() => {
    const map = new Map<string, string[]>();
    for (const [type, config] of Object.entries(typeConfig)) {
      const existing = map.get(config.label);
      if (existing) {
        existing.push(type);
      } else {
        map.set(config.label, [type]);
      }
    }
    return Array.from(map.entries()).map(([label, types]) => ({ label, types }));
  }, []);

  const selectedTypes = filterLabel
    ? filterGroups.find((g) => g.label === filterLabel)?.types
    : undefined;

  /** filterLabel 变化时重置并重新加载第一页 */
  useEffect(() => {
    getHistoryList(selectedTypes, PAGE_SIZE)
      .then((rows) => {
        setRecords(rows);
        setHasMore(rows.length >= PAGE_SIZE);
      })
      .catch((err) => console.warn("[history] initial load failed:", err));
  }, [selectedTypes]);

  /** 加载更多：使用 offset 追加下一页 */
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const more = await getHistoryList(selectedTypes, PAGE_SIZE, records.length);
      setRecords((prev) => [...prev, ...more]);
      setHasMore(more.length >= PAGE_SIZE);
    } catch (err) {
      console.warn("[history] loadMore failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [selectedTypes, records.length]);

  /** 删除后刷新列表 */
  function refresh() {
    getHistoryList(selectedTypes, records.length + PAGE_SIZE)
      .then((rows) => {
        setRecords(rows);
        setHasMore(rows.length > records.length);
      })
      .catch((err) => console.warn("[history] refresh failed:", err));
  }

  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    await deleteHistory(id);
    refresh();
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">历史记录</h2>

      <div className="flex gap-2">
        <Button
          variant={filterLabel === null ? "default" : "outline"}
          size="sm"
          onClick={() => setFilterLabel(null)}
        >
          全部
        </Button>
        {filterGroups.map((group) => (
          <Button
            key={group.label}
            variant={filterLabel === group.label ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterLabel(filterLabel === group.label ? null : group.label)}
          >
            {group.label}
          </Button>
        ))}
      </div>

      {records.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <History className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">暂无历史记录</p>
          <p className="text-sm mt-1">使用 Writing Copilot 或 Reading Copilot 后，记录会自动保存</p>
        </div>
      ) : (
        <div className="space-y-3">
          {records.map((record) => {
            const config = typeConfig[record.type as keyof typeof typeConfig];
            if (!config) return null;
            const Icon = config.icon;

            return (
              <Card
                key={record.id}
                className="cursor-pointer hover:border-primary/40 transition-colors"
                onClick={() => navigate(`/history/${record.id}`)}
              >
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
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => handleDelete(e, record.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                  <p className="mt-2 text-sm line-clamp-2 text-muted-foreground">
                    {record.input_text}
                  </p>
                </CardContent>
              </Card>
            );
          })}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    加载中...
                  </>
                ) : (
                  "加载更多"
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
