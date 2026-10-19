/**
 * 全局英语水平级别 store —— 基于 useSyncExternalStore 的轻量响应式模块
 * （模式与 lib/task-status.ts 相同）。
 *
 * 单一数据源是 settings 表的 proficiency_level 键；本模块持有内存快照供 UI
 * 即时读取，写操作先更新 store 再异步落库（write-through）。首次订阅时异步
 * 水合一次；水合完成前 UI 展示 DEFAULT_LEVEL，落库值返回后自动刷新。
 *
 * 提交 LLM 请求时若需要"此刻最新"的级别，直接在异步 buildMessages 中调用
 * getProficiencyLevel()（@/lib/db）从 DB 读取，不依赖本快照。
 */
import { useSyncExternalStore } from "react";
import { getProficiencyLevel, setProficiencyLevel } from "@/lib/db/settings";
import { DEFAULT_LEVEL, type LevelCode } from "@/lib/levels";

let current: LevelCode = DEFAULT_LEVEL;
let listeners: Array<() => void> = [];
/** 水合是否已发起（只发起一次） */
let hydrationStarted = false;
/** 用户是否在本次会话中手动设置过（手动设置后水合结果不再覆盖） */
let manuallySet = false;

function emitChange() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners = [...listeners, cb];
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

/** 首次订阅时从 DB 水合；失败静默保持默认值（prompt 仍可工作） */
function ensureHydrated() {
  if (hydrationStarted) return;
  hydrationStarted = true;
  getProficiencyLevel()
    .then((level) => {
      if (manuallySet || level === current) return;
      current = level;
      emitChange();
    })
    .catch(() => {
      /* 保持默认值 */
    });
}

function getSnapshot(): LevelCode {
  return current;
}

/**
 * 写入新级别：先更新内存快照（UI 即时响应），再异步持久化到 settings。
 * 同值也照常落库 —— 修复前同值提前 return，会跳过持久化：DB 写入曾经
 * 失败（如 settings 键尚未建）时，之后每次设置同值都不会补救，UI 显示
 * 的级别在重启后丢失。
 * 持久化失败仅 warn —— 下次启动回落到 DB 旧值，不阻塞用户操作。
 */
export function setLevelGlobal(level: LevelCode): void {
  manuallySet = true;
  if (current !== level) {
    current = level;
    emitChange();
  }
  setProficiencyLevel(level).catch((e) => {
    console.warn("[proficiency-level] 保存级别设置失败:", e);
  });
}

/**
 * React Hook —— 订阅全局级别。
 *
 * 返回 { level, setLevel }：level 为当前 CEFR 级别码，setLevel 立即生效并持久化。
 */
export function useProficiencyLevel(): {
  level: LevelCode;
  setLevel: (level: LevelCode) => void;
} {
  ensureHydrated();
  const level = useSyncExternalStore(subscribe, getSnapshot);
  return { level, setLevel: setLevelGlobal };
}
