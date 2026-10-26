/**
 * @module PersistentRoutes
 * @description 持久化路由组件，让 CorrectPage 和 ReadingPage 在路由切换时保持挂载状态，
 * 避免用户的输入文本、LLM 流式请求等状态因卸载而丢失。
 */

import {
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Outlet, useLocation } from "react-router";
import { PageVisibilityProvider } from "@/contexts/PageVisibilityContext";
import { TASK_KEYS, TASK_REGISTRY, type TaskKey, useTaskStatus } from "@/lib/task-status";

/**
 * 两个核心页面采用 lazy 懒加载：不进入主 bundle，首次访问对应持久化路径时才按需加载。
 * 挂载后保持常驻（通过 display 切换可见性），以保留页面内部状态。
 */
const CorrectPage = lazy(() => import("@/pages/CorrectPage"));
const ReadingPage = lazy(() => import("@/pages/ReadingPage"));

/** 隐藏超过该时长后卸载持久化页面（释放 result / Cytoscape / DOM）。 */
export const HIDDEN_UNMOUNT_TTL_MS = 10 * 60 * 1000;
/** 隐藏过期检查间隔（无需精确，30s 足够）。 */
export const HIDDEN_CHECK_INTERVAL_MS = 30_000;

/**
 * 持久化任务槽 → 懒加载页面组件（渲染注册表）。
 * 新增持久化页面两步：在 lib/task-status 的 TASK_REGISTRY 登记 persistent 行 →
 * 在此接入对应组件；渲染与可见性判定（下方 JSX 循环、PageVisibilityProvider）
 * 均由注册表驱动，无需再改。
 */
const PERSISTENT_PAGE_COMPONENTS: Partial<Record<TaskKey, LazyExoticComponent<ComponentType>>> = {
  writing: CorrectPage,
  reading: ReadingPage,
};

/**
 * 持久化页面路径映射（页面名 → 路径）。
 *
 * 路径字面量的唯一来源是 lib/task-status 的 TASK_REGISTRY（C6 的 persistent 行），
 * 此处只保留页面代码引用的语义键名（correct/reading），避免 "/writing" 之类的
 * 字面量在多处重复漂移。消费方：
 * - Layout 的 ROUTE_MATCHERS（writing/reading 表项，同样取 TASK_REGISTRY 的 route）
 * - 本组件的挂载/TTL/可见性逻辑与单源契约测试
 * 页面自身的「是否被隐藏」判定已改经 PageVisibilityContext（usePageHidden），
 * 不再直接引用本映射——叶子页面无须知道壳的内部常量。
 */
export const PERSISTENT_PAGE_PATHS = {
  correct: TASK_REGISTRY.writing.route,
  reading: TASK_REGISTRY.reading.route,
} as const;

/** 需要持久化挂载的路由路径集合 */
export const PERSISTENT_PATHS: ReadonlySet<string> = new Set(Object.values(PERSISTENT_PAGE_PATHS));

/** 判断路径是否为持久化挂载的路由（非持久化路径走 <Outlet /> 正常渲染） */
export function isPersistentPath(pathname: string): boolean {
  return PERSISTENT_PATHS.has(pathname);
}

/**
 * 持久化路径 → task-status 任务槽：TTL 卸载前据此跳过仍在流式生成的页面。
 * 由 TASK_REGISTRY 的 persistent 行反查生成（route 即路径、键即槽位）——
 * 在注册表把槽位标记为 persistent 即自动进入本映射，无需在此手工登记。
 */
const PERSISTENT_TASK_KEY: Record<string, TaskKey> = Object.fromEntries(
  TASK_KEYS.filter((key) => TASK_REGISTRY[key].persistent).map((key) => [
    TASK_REGISTRY[key].route,
    key,
  ]),
);

/**
 * 持久化路由组件
 *
 * 职责：让 CorrectPage（Writing Copilot，/writing）和 ReadingPage（Reading Copilot，/reading）
 * 在首次访问后保持挂载，而非路由切换时卸载/重新挂载。
 *
 * 为什么需要持久化？
 * 这两个核心页面有复杂的内部状态：
 * - 用户正在输入的文本
 * - 正在进行的 LLM 流式请求（streaming）
 * - 已经渲染的结果数据
 * - 知识图谱的 Cytoscape 实例
 * 如果路由切换时卸载组件，这些状态会全部丢失，用户体验很差。
 *
 * 隐藏 TTL：常驻挂载会把 result 字符串、Cytoscape canvas、DOM 树无限保留在内存里。
 * 页面连续隐藏超过 HIDDEN_UNMOUNT_TTL_MS（默认 10 分钟）后卸载，释放重型资源；
 * 再次进入时 lazy chunk 已在内存，重新挂载成本低。卸载前会检查该页对应的任务槽：
 * 流式生成仍在运行（running）时不卸载，避免结果/历史/学习记录丢失，下个 tick 再判。
 *
 * 延迟挂载语义：
 * 页面组件 lazy 懒加载（不进入主 bundle），且只有首次访问对应持久化路径时才挂载
 * （mounted 集合按 pathname 累积）。应用启动停留在 Dashboard 时，不会挂载任何页面树；
 * 一旦访问过某持久化路径，该页面便常驻渲染，仅通过 CSS `display` 切换可见性，
 * 从而在后续路由切换中保留内部状态。
 *
 * 实现方式：
 * - 每个持久化页面包裹 <Suspense fallback={null}>，懒加载 chunk 到达前不闪烁。
 * - 使用 CSS `display: contents` / `none` 切换可见性，而非条件渲染
 *   `display: contents` 让包裹 div 不产生任何布局框，等同于直接渲染子元素
 *   切换 display 不会触发组件的卸载/挂载生命周期
 * - 其他页面（生词本、历史记录等）通过 <Outlet /> 正常渲染
 *
 * 与 Layout 的关系：
 * 本组件作为 Layout 的子路由运行（见 App.tsx）：Layout 提供侧边栏与任务状态栏外壳，
 * 本组件只决定主内容区——持久化页面常驻显示，其余路由交给 <Outlet />。
 */
export function PersistentRoutes() {
  const { pathname } = useLocation();

  // 记录“已访问过”的持久化路径：首次命中某路径时才将对应页面加入渲染。
  // 加入后持续保留（仅通过 display 切换可见性）以维持状态，隐藏超时后按 TTL 卸载。
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set());
  /** 各路径开始隐藏的时刻；可见路径不存在于 Map 中 */
  const hiddenSinceRef = useRef<Map<string, number>>(new Map());
  /** mounted 的镜像，供 interval 回调读取最新值（回调闭包捕获的 state 会过期） */
  const mountedRef = useRef<ReadonlySet<string>>(new Set());
  const taskStatus = useTaskStatus();

  useEffect(() => {
    if (isPersistentPath(pathname)) {
      setMounted((prev) => (prev.has(pathname) ? prev : new Set(prev).add(pathname)));
    }
  }, [pathname]);

  useEffect(() => {
    mountedRef.current = mounted;
  }, [mounted]);

  // 周期性：为隐藏中的页面登记起点，超时则卸载释放资源。
  // 计时读写全部在本回调内完成，setMounted 的 updater 保持纯函数（StrictMode 双调用安全）。
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];
      for (const path of Object.values(PERSISTENT_PAGE_PATHS)) {
        if (!mountedRef.current.has(path)) continue;
        if (path === pathname) {
          hiddenSinceRef.current.delete(path);
          continue;
        }
        const since = hiddenSinceRef.current.get(path);
        if (since === undefined) {
          hiddenSinceRef.current.set(path, now);
        } else if (now - since >= HIDDEN_UNMOUNT_TTL_MS) {
          // 对应任务槽仍在流式生成时不卸载（避免结果/历史/打卡丢失），保留计时下个 tick 再判
          if (taskStatus[PERSISTENT_TASK_KEY[path]] === "running") continue;
          expired.push(path);
          hiddenSinceRef.current.delete(path);
        }
      }
      if (expired.length === 0) return;
      setMounted((prev) => {
        const next = new Set(prev);
        for (const path of expired) next.delete(path);
        return next;
      });
    }, HIDDEN_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pathname, taskStatus]);

  // 回到可见路径时立即清掉隐藏时钟（不必等下一个 interval tick）
  useEffect(() => {
    if (isPersistentPath(pathname)) {
      hiddenSinceRef.current.delete(pathname);
    }
  }, [pathname]);

  // 渲染期同步派生的有效挂载集合：首次访问持久化路径的那一帧 effect 尚未运行，
  // mounted 还不含当前路径，导致既不渲染对应页面也不渲染 <Outlet />，内容区闪一帧空白
  // （叠加 lazy chunk 加载更明显）。这里把"当前路径"在渲染期视为已挂载，消除首访闪烁；
  // 注意该派生集合只在渲染期用于判断，不能写回 state（否则每次渲染新建 Set 造成重渲染循环）。
  const effectiveMounted = useMemo(() => {
    if (!isPersistentPath(pathname)) return mounted;
    return mounted.has(pathname) ? mounted : new Set(mounted).add(pathname);
  }, [mounted, pathname]);

  return (
    <PageVisibilityProvider>
      {/*
       * 持久化页面从注册表渲染（PERSISTENT_PAGE_COMPONENTS，顺序即 TASK_KEYS 顺序）：
       * 命中过对应路径后始终挂载，通过 display 控制可见性。
       * 注意：`display: contents` 在部分旧版浏览器中可能导致元素从无障碍树中消失，
       * 但 Tauri WebView2（Chromium 内核）不受影响。
       */}
      {TASK_KEYS.filter((key) => TASK_REGISTRY[key].persistent).map((key) => {
        const path = TASK_REGISTRY[key].route;
        const Page = PERSISTENT_PAGE_COMPONENTS[key];
        if (!Page || !effectiveMounted.has(path)) return null;
        return (
          <div key={key} style={{ display: pathname === path ? "contents" : "none" }}>
            <Suspense fallback={null}>
              <Page />
            </Suspense>
          </div>
        );
      })}
      {/* 非持久化页面走正常的路由渲染 */}
      {!isPersistentPath(pathname) && <Outlet />}
    </PageVisibilityProvider>
  );
}
