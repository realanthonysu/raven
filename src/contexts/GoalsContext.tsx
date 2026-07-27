/**
 * @module GoalsContext
 * @description 学习目标共享上下文。
 *
 * 替代 window.addEventListener("learning-goals-changed") 的自定义 DOM 事件模式，
 * 提供类型安全的跨组件目标状态同步。
 *
 * - GoalsProvider: 管理 goals 状态，暴露 refreshGoals 方法
 * - useGoals(): 消费 goals 和 refreshGoals 的 hook
 *
 * 典型用法：
 * - Sidebar 通过 useGoals() 读取 goals 渲染进度条
 * - GoalCard 保存目标后调用 refreshGoals() 同步 Sidebar
 */

import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { getLearningGoals } from "@/lib/db";

/** 学习目标 DTO（与 Rust 端 GoalDto 保持一致） */
export interface GoalDto {
  goal_type: string;
  target: number;
}

/** 将 GoalDto[] 转换为 Record<string, number>（兼容 Sidebar 等消费方） */
export function goalsToRecord(goals: GoalDto[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const g of goals) {
    result[g.goal_type] = g.target;
  }
  return result;
}

interface GoalsContextValue {
  /** 当前学习目标列表 */
  goals: GoalDto[];
  /** 直接设置目标列表（Sidebar 从聚合数据中获取时使用） */
  setGoals: (goals: GoalDto[]) => void;
  /** 从数据库重新加载目标（GoalCard 保存后调用以同步 Sidebar） */
  refreshGoals: () => Promise<void>;
}

const GoalsContext = createContext<GoalsContextValue | null>(null);

export function GoalsProvider({ children }: { children: ReactNode }) {
  const [goals, setGoals] = useState<GoalDto[]>([]);

  const refreshGoals = useCallback(async () => {
    try {
      // getLearningGoals() 返回 Record<string, number>，需转换为 GoalDto[]
      const record = await getLearningGoals();
      const goalDtos: GoalDto[] = Object.entries(record).map(([goal_type, target]) => ({
        goal_type,
        target,
      }));
      setGoals(goalDtos);
    } catch (e) {
      console.warn("[GoalsContext] refreshGoals failed:", e);
    }
  }, []);

  return (
    <GoalsContext.Provider value={{ goals, setGoals, refreshGoals }}>
      {children}
    </GoalsContext.Provider>
  );
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
