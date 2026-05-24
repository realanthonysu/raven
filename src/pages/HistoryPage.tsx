import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Trash2, ChevronRight, History } from "lucide-react";
import { getHistory, deleteHistory } from "@/lib/db";
import { typeConfig } from "@/lib/type-config";
import type { HistoryRecord } from "@/types";

/**
 * 历史记录页面。
 *
 * 展示所有写作纠错和阅读精读的历史记录，支持：
 * - 按类型筛选（全部 / Writing / Reading）
 * - 点击卡片跳转到详情页（/history/:id）
 * - 删除单条记录（删除按钮阻止事件冒泡，避免触发卡片的跳转）
 *
 * 数据流：filterType 变化时自动重新查询数据库（useEffect 依赖 [filterType]）。
 * typeConfig 来自 lib/type-config，定义了每种类型的标签、图标、颜色配置。
 */
export default function HistoryPage() {
  const navigate = useNavigate();
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  /** 类型筛选：null 表示全部，"correct" / "reading" 表示只看某类 */
  const [filterType, setFilterType] = useState<string | null>(null);

  /** filterType 变化时重新从数据库加载记录 */
  useEffect(() => {
    getHistory(filterType ?? undefined).then(setRecords);
  }, [filterType]);

  /** 删除后刷新列表（保留当前筛选条件） */
  function refresh() {
    getHistory(filterType ?? undefined).then(setRecords);
  }

  /**
   * 删除历史记录。
   * 调用 e.stopPropagation() 阻止事件冒泡到 Card 的 onClick，
   * 避免删除操作同时触发页面跳转。
   */
  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    await deleteHistory(id);
    refresh();
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">历史记录</h2>

      {/* 类型筛选按钮组：toggle 模式 */}
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
        /* 空状态引导 */
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <History className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">暂无历史记录</p>
          <p className="text-sm mt-1">使用 Writing Copilot 或 Reading Copilot 后，记录会自动保存</p>
        </div>
      ) : (
        <div className="space-y-3">
          {records.map((record) => {
            const config = typeConfig[record.type as keyof typeof typeConfig];
            if (!config) return null; // 类型配置缺失时跳过（防御性）
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
                      {/* 类型标签（Writing / Reading） */}
                      <Badge variant="secondary" className={config.color}>
                        <Icon className="h-3 w-3 mr-1" />
                        {config.label}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {new Date(record.created_at).toLocaleString("zh-CN")}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* 删除按钮：stopPropagation 防止触发卡片跳转 */}
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
                  {/* 输入文本预览（最多 2 行） */}
                  <p className="mt-2 text-sm line-clamp-2 text-muted-foreground">
                    {record.input_text}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
