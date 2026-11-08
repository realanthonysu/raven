/**
 * @module GoalsContext
 * @description 学习目标共享上下文。
 *
 * 职责边界：Provider 是目标数据的唯一生产者——挂载时加载一次，
 * 之后只能通过 refreshGoals() 重新加载。此前 Sidebar 会在导航轮询时把
 * getSidebarData() 返回的目标写回 context（事实上的第二个生产者），迫使
 * GoalDto[] ↔ Record 双向转换散落在两个模块中；现在统一存储
 * 聚合快照（getSidebarData）返回的 Record<string, number>，Sidebar 退化为纯读取方，
 * 转换层整体消失。
 *
 * D-07/S-05：goals 改从 `getSidebarData()` 的短 TTL 聚合快照读取（与
 * Sidebar/Dashboard/通知共用同一次 `db_get_sidebar_data` IPC），不再单独
 * `getLearningGoals()`。GoalCard 保存目标时 `setLearningGoal` 会使该快照失效，
 * 随后 `refreshGoals()` 拿到最新值。
 *
 * - GoalsProvider: 挂载时加载 goals，暴露 refreshGoals 方法
 * - useGoals(): 消费 goals 和 refreshGoals 的 hook
 *
 * 典型用法：
 * - Sidebar 通过 useGoals() 读取 goals 渲染进度条（纯读取，不写回）
 * - GoalCard 保存目标后调用 refreshGoals() 同步 Sidebar
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getSidebarData } from "@/lib/db";

interface GoalsContextValue {
  /** 当前学习目标（goal_type → target）。与 getSidebarData().goals 同形，无 DTO 中转 */
  goals: Record<string, number>;
  /** 从数据库重新加载目标（GoalCard 保存后调用以同步 Sidebar） */
  refreshGoals: () => Promise<void>;
}

const GoalsContext = createContext<GoalsContextValue | null>(null);

export function GoalsProvider({ children }: { children: ReactNode }) {
  const [goals, setGoals] = useState<Record<string, number>>({});

  const refreshGoals = useCallback(async () => {
    try {
      // 内容相等守卫：键值未变化时保持原引用，避免所有消费者无谓重渲。
      // （该优化原由 Sidebar 写回时实施，收拢到唯一写入点后在此保留）
      // goals 取自共享聚合快照（D-07/S-05）：与 Sidebar/Dashboard/通知同一次 IPC
      const { goals: record } = await getSidebarData();
      setGoals((prev) => {
        const prevKeys = Object.keys(prev);
        const nextKeys = Object.keys(record);
        if (prevKeys.length === nextKeys.length && nextKeys.every((k) => prev[k] === record[k])) {
          return prev;
        }
        return record;
      });
    } catch (e) {
      // 拉取失败 fail-soft：仅记录日志并保持当前值（与原 Sidebar 的 catch 行为一致），
      // 不破坏侧边栏已展示的内容
      console.warn("[GoalsContext] refreshGoals failed:", e);
    }
  }, []);

  // Provider 自持生命周期：挂载时加载一次。
  // 此前 provider 从不加载（冷启动阶段 context 恒为空，全靠 Sidebar 首次导航拉取后写回）；
  // 现在首帧之后即可渲染目标进度条，Sidebar 视觉保持稳定。
  useEffect(() => {
    void refreshGoals();
  }, [refreshGoals]);

  // 避免每次渲染创建新 value 对象导致所有消费者不必要地重新渲染
  const ctxValue = useMemo(() => ({ goals, refreshGoals }), [goals, refreshGoals]);

  return <GoalsContext.Provider value={ctxValue}>{children}</GoalsContext.Provider>;
}

/**
 * 消费 GoalsContext 的 hook。
 *
 * @throws 如果在 GoalsProvider 外使用则抛出错误
 */
export function useGoals(): GoalsContextValue {
  const ctx = useContext(GoalsContext);
  if (!ctx) throw new Error("useGoals must be used within <GoalsProvider>");
  return ctx;
}
