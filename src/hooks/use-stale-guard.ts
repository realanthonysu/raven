/**
 * useStaleGuard —— stale-response（乱序/迟到响应）守卫 hook。
 *
 * 解决的问题：异步请求的响应可能乱序到达（防抖搜索、连点 reload、快速切换
 * 筛选等场景下，先发起的慢请求后返回），迟到结果若直接写进 state，会瞬间
 * 覆盖新请求的正确数据，造成界面回跳或状态错乱。
 *
 * 与 AbortController 的分工（互补，不互替）：
 * - abort() 只能放弃"本地等待"——Tauri invoke 不可取消，Rust 侧请求会一路
 *   跑到超时，响应仍会到达；
 * - 本守卫负责把迟到结果挡在 state 之外：每次发起请求前 begin() 取序号成为
 *   "所有者"，任何更晚的 begin() 都会使它过期；旧操作写 state 前用
 *   isStale(seq) 自检，过期即丢弃。
 * 两者通常配合使用（如 useGraphData：abort 省掉无谓的后续工作，守卫保证
 * finally 等迟到路径不写坏新状态）。
 *
 * 用法示例：
 *   const guard = useStaleGuard();
 *   const seq = guard.begin();
 *   fetchData()
 *     .then((data) => { if (guard.isStale(seq)) return; setState(data); })
 *     .catch((err) => { if (guard.isStale(seq)) return; setError(err); });
 *
 * 全部状态存于 ref，hook 本身不触发重渲染；三个回调身份稳定，可安全列入
 * effect / useCallback 依赖。
 */
import { useCallback, useRef } from "react";

interface UseStaleGuardReturn {
  /**
   * 发起一次异步操作：自增并返回序号。本次调用成为（最新一次）操作的
   * "所有者"，之后任何更晚的 begin 都会使它过期。
   */
  begin: () => number;
  /**
   * 只读访问当前序号，不自增。供"非所有者观察者"使用——例如分页 loadMore
   * 只需检测"期间是否有新的列表加载发起"，自身不取代任何在途请求：若它
   * 误用 begin，会把更早发起、尚未返回的列表加载打成过期，列表停在旧页
   * 且无重试。
   */
  current: () => number;
  /**
   * 该次操作是否已被更新的 begin 取代（seq !== 当前序号）——是则其结果
   * 不得写回 state。
   */
  isStale: (seq: number) => boolean;
}

export function useStaleGuard(): UseStaleGuardReturn {
  const seqRef = useRef(0);

  const begin = useCallback(() => {
    seqRef.current += 1;
    return seqRef.current;
  }, []);

  const current = useCallback(() => seqRef.current, []);

  const isStale = useCallback((seq: number) => seq !== seqRef.current, []);

  return { begin, current, isStale };
}
