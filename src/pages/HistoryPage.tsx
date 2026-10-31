/**
 * @module HistoryPage
 * @description 历史记录列表页面。
 *
 * 展示所有学习活动的历史记录，支持：
 * - 按类型筛选（全部 / Writing / Reading / Exercise / Listening / Speaking）
 * - 分页加载（每次 PAGE_SIZE 条，点击"加载更多"追加）
 * - 点击卡片跳转到详情页（HistoryDetailPage）
 * - 删除单条记录
 *
 * 数据流：挂载时加载第一页 → 筛选变化时重置 → loadMore 追加下一页。
 */

import { ChevronRight, History, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ErrorBanner } from "@/components/page-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useStaleGuard } from "@/hooks/use-stale-guard";
import { deleteHistory, getHistoryList, parseDbTimestamp } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { isHistoryType, typeConfig } from "@/lib/type-config";
import type { HistoryRecord } from "@/types";

/** 每页加载的记录数 */
const PAGE_SIZE = 20;

/**
 * 历史记录时间显示格式化器（模块级 Intl 实例，只创建一次）。
 * `toLocaleString("zh-CN")` 每次调用都会新建 Intl.DateTimeFormat 并重新查询
 * locale 数据；模块级实例把该开销移出渲染路径（H-17）。
 */
const HISTORY_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN");

/** 大列表的 CSS 渲染隔离类：content-visibility 让视口外的卡片跳过布局/绘制，
 *  contain-intrinsic-size 提供占位高度估算，避免滚动条跳动（H-17）。 */
const LIST_ITEM_PERF_CLASS = "[content-visibility:auto] [contain-intrinsic-size:auto_7rem]";

/** 按展示标签聚合的历史类型。 Writing 同时包含 legacy 的 correct 与新的 writing。 */
interface FilterGroup {
  label: string;
  types: string[];
}

/**
 * 历史记录页面。
 *
 * 展示所有学习活动的历史记录，支持：
 * - 按类型筛选（全部 / Writing / Reading / Exercise / Listening / Speaking）
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
  const [error, setError] = useState<string | null>(null);

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

  /** 时间显示只格式化一次（随 records 列表变化），不随任意 state 更新重复执行（H-17） */
  const dateLabels = useMemo(() => {
    const labels = new Map<number, string>();
    for (const record of records) {
      labels.set(record.id, HISTORY_DATE_FORMATTER.format(parseDbTimestamp(record.created_at)));
    }
    return labels;
  }, [records]);

  /** filterLabel 变化时重置并重新加载第一页。
   *  快速切换筛选时，慢的旧响应不允许覆盖新列表——用 useStaleGuard 序号
   *  守卫丢弃过期响应（机制文档归 hook 所有）。 */
  const { begin, current, isStale } = useStaleGuard();
  useEffect(() => {
    const seq = begin();
    getHistoryList(selectedTypes, PAGE_SIZE)
      .then((rows) => {
        if (isStale(seq)) return;
        setRecords(rows);
        setHasMore(rows.length >= PAGE_SIZE);
        setError(null);
      })
      .catch((err) => {
        if (isStale(seq)) return;
        console.warn("[history] initial load failed:", err);
        setError(getErrorMessage(err, "加载失败"));
      });
  }, [selectedTypes, begin, isStale]);

  /** 加载更多：使用 offset 追加下一页。
   *  使用 recordsLengthRef 避免闭包捕获旧 records.length（删除记录后 stale offset）。
   *  迟到结果双重守卫：筛选切换后（selectedTypesRef 变化），或期间又有新的
   *  列表加载发起（current() 读数变化），进行中的 loadMore 携带旧状态
   *  返回时直接丢弃，避免旧筛选记录被 append 进新列表。
   *  注意这里用 current() 只读观察而非 begin()：loadMore 不是列表加载的
   *  所有者，不应作废更早发起、尚未返回的加载（详见 hook 文档）。 */
  const recordsLengthRef = useRef(records.length);
  recordsLengthRef.current = records.length;
  const selectedTypesRef = useRef(selectedTypes);
  selectedTypesRef.current = selectedTypes;

  const loadMore = useCallback(async () => {
    const typesAtStart = selectedTypes;
    const seqAtStart = current();
    setLoadingMore(true);
    try {
      const more = await getHistoryList(typesAtStart, PAGE_SIZE, recordsLengthRef.current);
      if (typesAtStart !== selectedTypesRef.current || isStale(seqAtStart)) return;
      setRecords((prev) => [...prev, ...more]);
      setHasMore(more.length >= PAGE_SIZE);
      setError(null);
    } catch (err) {
      console.warn("[history] loadMore failed:", err);
      setError(getErrorMessage(err, "加载失败"));
    } finally {
      setLoadingMore(false);
    }
  }, [selectedTypes, current, isStale]);

  /** 删除成功后在本地移除该条（H-16）：
   *  此前按"已加载数 + 一页"重拉整段列表，用户加载几百条后删一条要跨 IPC
   *  传回数百条记录并整列表重渲染。删除一条只影响本地数组与该条之后的下标：
   *  下一次 loadMore 的 offset 取 records.length（已减一），恰好对应删除后的
   *  服务端游标，无需补拉也不会漏条；hasMore 语义不受单条删除影响。 */
  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    try {
      await deleteHistory(id);
    } catch (err) {
      // 删除失败必须报错：静默时用户会以为已删除，列表却原样保留
      setError(`删除失败: ${getErrorMessage(err)}`);
      return;
    }
    setRecords((prev) => prev.filter((record) => record.id !== id));
    setError(null);
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <h2 className="text-2xl font-bold">历史记录</h2>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

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
            // DB 返回的 type 是裸字符串，脏数据直接跳过（编译期联合不保证运行时合法）
            if (!isHistoryType(record.type)) return null;
            const config = typeConfig[record.type];
            const Icon = config.icon;

            return (
              <Card
                key={record.id}
                className={`cursor-pointer hover:border-primary/40 transition-colors ${LIST_ITEM_PERF_CLASS}`}
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
                        {dateLabels.get(record.id)}
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
