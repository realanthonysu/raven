/**
 * @module practice-reducer-utils
 * @description 练习页 reducer 的共享基座。
 *
 * ExercisePage / ListeningPage / SpeakingPage 三个练习页的 reducer 存在重复模式：
 * - score / error / saveError 三个公共状态槽及其 action 处理
 * - 按索引不可变更新数组（用户答案、听写输入、评分结果）
 * - RESET 回到初始状态
 *
 * 本模块将这些公共部分抽取为可组合的工具函数：各页面 reducer 先通过
 * `isPracticeBaseAction` + `reducePracticeBase` 处理公共 action，
 * 再在自己的 switch 中处理页面特有 action。
 */

/** 练习页 reducer 的公共状态槽 */
export interface PracticeBaseState {
  /** 本次练习得分 */
  score: number;
  /** 全局错误提示（模型未配置、生成失败等） */
  error: string | null;
  /** history 表写入失败时的非阻断警告 */
  saveError: string | null;
}

/** 练习页 reducer 的公共 action */
export type PracticeBaseAction =
  /** 设置本次练习得分 */
  | { type: "SET_SCORE"; score: number }
  /** 设置全局错误提示 */
  | { type: "SET_ERROR"; error: string | null }
  /** 清除全局错误提示 */
  | { type: "CLEAR_ERROR" }
  /** 设置持久化失败的非阻断提示 */
  | { type: "SET_SAVE_ERROR"; error: string | null }
  /** 重置所有状态到初始值 */
  | { type: "RESET" };

/** 公共 action 的 type 集合，供类型守卫使用 */
const BASE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "SET_SCORE",
  "SET_ERROR",
  "CLEAR_ERROR",
  "SET_SAVE_ERROR",
  "RESET",
]);

/**
 * 类型守卫：判断 action 是否为公共 action。
 * 配合 TS 的联合类型收窄，else 分支中 action 自动收窄为页面特有 action。
 */
export function isPracticeBaseAction(action: { type: string }): action is PracticeBaseAction {
  return BASE_ACTION_TYPES.has(action.type);
}

/**
 * 处理公共 action 的状态变更。
 *
 * @param state 当前状态（须包含公共状态槽）
 * @param action 公共 action
 * @param initial RESET 时返回的初始状态
 */
export function reducePracticeBase<S extends PracticeBaseState>(
  state: S,
  action: PracticeBaseAction,
  initial: S,
): S {
  switch (action.type) {
    case "SET_SCORE":
      return { ...state, score: action.score };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "SET_SAVE_ERROR":
      return { ...state, saveError: action.error };
    case "RESET":
      return initial;
    default:
      return state;
  }
}

/**
 * 按索引不可变更新数组：返回替换了指定位置元素的新数组，原数组不变。
 * 三个练习页 reducer 中「复制数组 + 按下标赋值」模式的统一实现。
 */
export function replaceAt<T>(arr: readonly T[], index: number, value: T): T[] {
  const next = [...arr];
  next[index] = value;
  return next;
}
