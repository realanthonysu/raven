/**
 * 全局任务状态管理 —— 基于 useSyncExternalStore 的轻量级响应式 store。
 *
 * 不使用 Redux/Zustand 等外部库，因为状态极简（只有两个三态值）。
 * useSyncExternalStore 是 React 18 官方推荐的外部 store 集成方式，
 * 能正确处理并发渲染和撕裂（tearing）问题。
 *
 * 状态生命周期：
 *   idle → running（任务开始）→ completed（任务完成）→ idle（用户导航回对应页面）
 * completed 状态由各页面在挂载时调用 clearTaskCompleted() 清除，
 * 用于在 Layout 顶部状态栏短暂显示绿色勾号。
 */
import { useSyncExternalStore } from "react";

/** 任务状态三态：idle=空闲, running=进行中, completed=已完成待确认 */
type TaskState = "idle" | "running" | "completed";

interface TaskStatus {
  writing: TaskState; // Writing Copilot 任务状态
  reading: TaskState; // Reading Copilot 任务状态
  exercise: TaskState; // 弱项训练任务状态
  listening: TaskState; // 听力练习任务状态
}

/** 模块级状态，不放在 React state 中，因为需要在组件外（如 LLM 回调中）更新 */
let status: TaskStatus = { writing: "idle", reading: "idle", exercise: "idle", listening: "idle" };
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
export function setTaskStatus(
  task: "writing" | "reading" | "exercise" | "listening",
  active: boolean,
) {
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
export function markTaskCompleted(task: "writing" | "reading" | "exercise" | "listening") {
  if (status[task] === "completed") return;
  status = { ...status, [task]: "completed" };
  emitChange();
}

/**
 * 清除已完成状态 —— 由页面在挂载时调用（useEffect）。
 *
 * 用户导航到对应页面时，已完成的反馈已被看到，此时清除回 idle。
 * 只在当前状态为 "completed" 时才操作，避免覆盖正在进行的任务。
 */
export function clearTaskCompleted(task: "writing" | "reading" | "exercise" | "listening") {
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
