/**
 * 全局任务状态管理 —— 基于 useSyncExternalStore 的轻量级响应式 store。
 *
 * 不使用 Redux/Zustand 等外部库，因为状态极简（只有两个三态值）。
 * useSyncExternalStore 是 React 18 官方推荐的外部 store 集成方式，
 * 能正确处理并发渲染和撕裂（tearing）问题。
 *
 * 状态生命周期：
 *   idle → running（任务开始）→ completed（任务完成）→ idle（用户导航回对应页面）
 * completed 状态由 Layout 的 TaskStatusBar 在用户导航到对应页面时
 * （useEffect 路由匹配）调用 clearTaskCompleted() 清除，
 * 用于在 Layout 顶部状态栏短暂显示绿色勾号。
 */
import { useSyncExternalStore } from "react";

/** 任务状态三态：idle=空闲, running=进行中, completed=已完成待确认 */
type TaskState = "idle" | "running" | "completed";

/** 任务槽注册表单行 —— 一个任务槽的全部身份与含义 */
interface TaskSlotMeta {
  /**
   * 任务页路由。exercise 是动态参数路由（/exercise/:category）的前缀，
   * 其余四条为精确路径；匹配方式（精确/前缀）由消费方 Layout 决定。
   */
  route: string;
  /** Layout 任务状态栏中的展示名 */
  displayName: string;
  /** 是否常驻挂载（见 PersistentRoutes 的 TTL 卸载逻辑） */
  persistent: boolean;
}

/** 全部任务键 —— 任务槽身份清单；每个键的含义见下方 TASK_REGISTRY（C6） */
export const TASK_KEYS = ["writing", "reading", "exercise", "listening", "speaking"] as const;
export type TaskKey = (typeof TASK_KEYS)[number];

/**
 * 任务槽注册表 —— 任务槽的身份与含义只在此声明一次（C6）。
 *
 * Record<TaskKey, ...> 强制穷尽：TASK_KEYS 新增一行而此处未登记会直接编译报错。
 * 消费方全部从这里派生，不再各自重抄：
 * - TASK_DISPLAY_NAMES（下方派生）→ Layout 状态栏展示名
 * - route → Layout 的 completed 清除路由匹配、PersistentRoutes 的持久化路径
 * - persistent → PersistentRoutes 的 路径→任务槽 映射（TTL 卸载前的 running 守卫）
 */
export const TASK_REGISTRY: Record<TaskKey, TaskSlotMeta> = {
  writing: { route: "/writing", displayName: "Writing Copilot 纠正任务", persistent: true },
  reading: { route: "/reading", displayName: "Reading Copilot 精读任务", persistent: true },
  exercise: { route: "/exercise", displayName: "弱项训练任务", persistent: false },
  listening: { route: "/listening", displayName: "听力练习任务", persistent: false },
  speaking: { route: "/speaking", displayName: "口语练习任务", persistent: false },
};

/**
 * 派生的展示名速查表（与 TASK_KEYS 同序）—— Layout 状态栏渲染用。
 * 由注册表归约生成，避免展示名在手写副本中漂移；
 * 键集合即 TASK_KEYS，故 Object.fromEntries 的结果断言是完备的。
 */
export const TASK_DISPLAY_NAMES: Record<TaskKey, string> = Object.fromEntries(
  TASK_KEYS.map((key) => [key, TASK_REGISTRY[key].displayName]),
) as Record<TaskKey, string>;

/** 任务状态快照：每个任务槽一个三态值 —— 由 TASK_KEYS 派生，新增槽位无需手工补齐 */
type TaskStatus = Record<TaskKey, TaskState>;

/** 初始状态（全部 idle）—— 由 TASK_KEYS 归约生成；键集合即 TASK_KEYS，断言完备 */
function createIdleStatus(): TaskStatus {
  const initial = {} as TaskStatus;
  for (const key of TASK_KEYS) initial[key] = "idle";
  return initial;
}

/** 模块级状态，不放在 React state 中，因为需要在组件外（如 LLM 回调中）更新 */
let status: TaskStatus = createIdleStatus();
let listeners: Array<() => void> = [];

/** 通知所有订阅者重新读取快照 */
function emitChange() {
  for (const l of listeners) l();
}

/**
 * 设置任务为运行中或空闲。
 *
 * 页面在发起 LLM 请求时调用 setTaskStatus(task, true)，
 * 在请求完成或中止时调用 setTaskStatus(task, false)。
 * 相同状态不会触发更新，避免不必要的重渲染。
 */
export function setTaskStatus(task: TaskKey, active: boolean) {
  const next: TaskState = active ? "running" : "idle";
  if (status[task] === next) return;
  status = { ...status, [task]: next };
  emitChange();
}

/**
 * 标记任务为已完成 —— 在 LLM 流式响应结束后调用。
 *
 * "completed" 是一个短暂的展示状态，用于 Layout 状态栏显示绿色勾号。
 * 与 setTaskStatus(task, false) 的区别是：直接回到 idle 不会给用户反馈。
 */
export function markTaskCompleted(task: TaskKey) {
  if (status[task] === "completed") return;
  status = { ...status, [task]: "completed" };
  emitChange();
}

/**
 * 清除已完成状态 —— 由 Layout 的 TaskStatusBar 在路由变化时调用（useEffect）。
 *
 * 用户导航到对应页面时，已完成的反馈已被看到，此时清除回 idle。
 * 只在当前状态为 "completed" 时才操作，避免覆盖正在进行的任务。
 */
export function clearTaskCompleted(task: TaskKey) {
  if (status[task] !== "completed") return;
  status = { ...status, [task]: "idle" };
  emitChange();
}

/**
 * 订阅函数 —— useSyncExternalStore 要求的 subscribe 签名。
 * 返回取消订阅的函数，React 在组件卸载时自动调用。
 */
function subscribe(cb: () => void) {
  listeners = [...listeners, cb];
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

/**
 * 快照函数 —— useSyncExternalStore 要求的 getSnapshot 签名。
 * 必须返回同一引用（除非状态确实变化），否则会导致无限重渲染。
 * 这里直接返回模块级 status 对象，状态变化时通过展开运算符创建新对象。
 */
function getSnapshot(): TaskStatus {
  return status;
}

/**
 * React Hook —— 在组件中订阅任务状态变化。
 *
 * 用法：const { writing, reading } = useTaskStatus();
 * Layout 组件用此 hook 决定顶部状态栏的显示内容。
 */
export function useTaskStatus(): TaskStatus {
  return useSyncExternalStore(subscribe, getSnapshot);
}
