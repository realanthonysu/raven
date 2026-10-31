import { act, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTaskCompleted,
  getTaskState,
  markTaskCompleted,
  setTaskStatus,
  TASK_KEYS,
  TASK_REGISTRY,
} from "@/lib/task-status";
import {
  HIDDEN_CHECK_INTERVAL_MS,
  HIDDEN_UNMOUNT_TTL_MS,
  isPersistentPath,
  PERSISTENT_PAGE_PATHS,
  PERSISTENT_PATHS,
  PersistentRoutes,
} from "./PersistentRoutes";

// P-05 回归：记录两份常驻页面的渲染次数，断言任务状态变化/非持久化导航
// 不再穿透 memo 触发页面重渲
const pageRenderCounts = vi.hoisted(() => ({ correct: 0, reading: 0 }));

vi.mock("@/pages/CorrectPage", () => ({
  default: () => {
    pageRenderCounts.correct += 1;
    return <div data-testid="correct-page" />;
  },
}));
vi.mock("@/pages/ReadingPage", () => ({
  default: () => {
    pageRenderCounts.reading += 1;
    return <div data-testid="reading-page" />;
  },
}));

/**
 * 渲染 PersistentRoutes。附带的导航链接用于模拟在持久化路径之间切换
 * （页面组件现在 lazy 加载，且首次访问对应路径后才挂载常驻）。
 */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <nav>
        <Link to="/writing">to-writing</Link>
        <Link to="/reading">to-reading</Link>
        <Link to="/vocabulary">to-vocabulary</Link>
        <Link to="/history">to-history</Link>
      </nav>
      <PersistentRoutes />
    </MemoryRouter>,
  );
}

describe("PersistentRoutes", () => {
  it("lazy-mounts CorrectPage on first visit to /writing", async () => {
    renderAt("/writing");
    expect(await screen.findByTestId("correct-page")).toBeInTheDocument();
  });

  it("lazy-mounts ReadingPage on first visit to /reading", async () => {
    renderAt("/reading");
    expect(await screen.findByTestId("reading-page")).toBeInTheDocument();
  });

  it("does not mount persistent pages on non-persistent routes before first visit", () => {
    renderAt("/vocabulary");
    // 从未访问过 /writing 或 /reading，两棵页面树都不应挂载
    expect(screen.queryByTestId("correct-page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reading-page")).not.toBeInTheDocument();
  });

  /** 持久页外层 wrapper(display 切换发生在 parent div 上) */
  function wrapperOf(testId: string): HTMLElement {
    const el = screen.getByTestId(testId).parentElement;
    if (!el) throw new Error(`parent wrapper of ${testId} not found`);
    return el;
  }

  it("hides CorrectPage after navigating to /reading", async () => {
    renderAt("/writing");
    await screen.findByTestId("correct-page");
    fireEvent.click(screen.getByText("to-reading"));
    // ReadingPage 首次访问后懒加载挂载；CorrectPage 已常驻但被隐藏
    await screen.findByTestId("reading-page");
    expect(wrapperOf("correct-page")).toHaveStyle({ display: "none" });
    expect(wrapperOf("reading-page")).toHaveStyle({ display: "contents" });
  });

  it("hides ReadingPage after navigating to /writing", async () => {
    renderAt("/reading");
    await screen.findByTestId("reading-page");
    fireEvent.click(screen.getByText("to-writing"));
    // CorrectPage 首次访问后懒加载挂载；ReadingPage 已常驻但被隐藏
    await screen.findByTestId("correct-page");
    expect(wrapperOf("reading-page")).toHaveStyle({ display: "none" });
    expect(wrapperOf("correct-page")).toHaveStyle({ display: "contents" });
  });
});

// ─── 订阅隔离 / memo（P-05）───
// 壳不再订阅整个 task-status 快照（TTL 守卫改为回调内读 getTaskState），
// 两份常驻页面用 memo 包裹：任务状态变化与非持久化导航不再重渲隐藏页面。

describe("PersistentRoutes subscription isolation (P-05)", () => {
  beforeEach(() => {
    pageRenderCounts.correct = 0;
    pageRenderCounts.reading = 0;
    for (const key of TASK_KEYS) {
      clearTaskCompleted(key);
      setTaskStatus(key, false);
    }
  });

  it("does not re-render mounted persistent pages when task status changes", async () => {
    renderAt("/writing");
    await screen.findByTestId("correct-page");
    const rendersBefore = pageRenderCounts.correct;

    act(() => setTaskStatus("writing", true));
    act(() => markTaskCompleted("writing"));

    // 壳没有订阅任务状态：常驻页面不因任务开始/完成而重渲
    expect(pageRenderCounts.correct).toBe(rendersBefore);
    // TTL 守卫仍能在定时器回调里读到最新状态（非订阅快照）
    expect(getTaskState("writing")).toBe("completed");
  });

  it("keeps mounted pages stable when navigating between non-persistent routes", async () => {
    renderAt("/writing");
    await screen.findByTestId("correct-page");
    const rendersBefore = pageRenderCounts.correct;

    // /writing → /vocabulary：页面进入隐藏（visibility 变化由 context 下发，
    // 页面自己消费；本 mock 页面不消费，因此这里只验证父级重渲不穿透 memo）
    fireEvent.click(screen.getByText("to-vocabulary"));
    await act(async () => {});
    expect(pageRenderCounts.correct).toBe(rendersBefore);

    // /vocabulary → /history：两条非持久化路径之间导航
    fireEvent.click(screen.getByText("to-history"));
    await act(async () => {});
    expect(pageRenderCounts.correct).toBe(rendersBefore);
  });
});

// ─── 隐藏 TTL 卸载 ───
// interval 计时逻辑在回调体内完成（setMounted updater 为纯函数），
// 且卸载前检查对应任务槽状态：running 时跳过，重新访问时隐藏时钟清零。

describe("PersistentRoutes TTL unmount", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const key of TASK_KEYS) {
      clearTaskCompleted(key);
      setTaskStatus(key, false);
    }
  });

  /** 访问 /writing 后切到 /reading（CorrectPage 进入隐藏）。fake timers 下 lazy chunk 仅需微任务即可就绪 */
  async function visitBoth() {
    renderAt("/writing");
    await act(async () => {});
    expect(screen.getByTestId("correct-page")).toBeInTheDocument();
    fireEvent.click(screen.getByText("to-reading"));
    await act(async () => {});
    expect(screen.getByTestId("reading-page")).toBeInTheDocument();
  }

  it("unmounts a persistent page hidden longer than the TTL", async () => {
    vi.useFakeTimers();
    await visitBoth();
    act(() => {
      vi.advanceTimersByTime(HIDDEN_UNMOUNT_TTL_MS + HIDDEN_CHECK_INTERVAL_MS);
    });
    expect(screen.queryByTestId("correct-page")).not.toBeInTheDocument();
    expect(screen.getByTestId("reading-page")).toBeInTheDocument();
  });

  it("does not unmount while the page's task slot is running; unmounts once it finishes", async () => {
    vi.useFakeTimers();
    act(() => setTaskStatus("writing", true));
    await visitBoth();
    act(() => {
      vi.advanceTimersByTime(HIDDEN_UNMOUNT_TTL_MS + HIDDEN_CHECK_INTERVAL_MS);
    });
    // 流式生成仍在跑：即使隐藏超时也不卸载，避免结果/历史/打卡丢失
    expect(screen.getByTestId("correct-page")).toBeInTheDocument();

    act(() => setTaskStatus("writing", false));
    act(() => {
      vi.advanceTimersByTime(HIDDEN_CHECK_INTERVAL_MS);
    });
    expect(screen.queryByTestId("correct-page")).not.toBeInTheDocument();
  });

  it("resets the hidden clock when the page becomes visible again", async () => {
    vi.useFakeTimers();
    await visitBoth();
    // 先隐藏 9 分钟（未达 TTL），回到 /writing 再离开，隐藏计时应清零
    act(() => {
      vi.advanceTimersByTime(9 * 60 * 1000);
    });
    fireEvent.click(screen.getByText("to-writing"));
    await act(async () => {});
    fireEvent.click(screen.getByText("to-reading"));
    await act(async () => {});
    // 距上次登记已 18.5 分钟；若时钟未复位早已超时，复位后则尚未到期
    act(() => {
      vi.advanceTimersByTime(9 * 60 * 1000 + 30 * 1000);
    });
    expect(screen.getByTestId("correct-page")).toBeInTheDocument();
  });
});

// ─── 单源契约：PERSISTENT_PATHS / PERSISTENT_PAGE_PATHS / TASK_REGISTRY ───
// 路径字面量唯一来源是 TASK_REGISTRY 的 persistent 行（C6）：Layout 的路由匹配器、
// 页面内的隐藏检测、TTL 卸载前的 running 守卫（PERSISTENT_TASK_KEY，由注册表派生）
// 都由此出发，这里锁死导出内容与派生关系防止漂移。

describe("PersistentRoutes exported constants", () => {
  it("PERSISTENT_PATHS contains exactly the writing and reading routes", () => {
    expect(PERSISTENT_PATHS.has("/writing")).toBe(true);
    expect(PERSISTENT_PATHS.has("/reading")).toBe(true);
    expect(PERSISTENT_PATHS.size).toBe(2);
  });

  it("PERSISTENT_PATHS is derived from PERSISTENT_PAGE_PATHS", () => {
    expect([...PERSISTENT_PATHS]).toEqual(Object.values(PERSISTENT_PAGE_PATHS));
  });

  it("isPersistentPath matches persistent routes only", () => {
    expect(isPersistentPath("/writing")).toBe(true);
    expect(isPersistentPath("/reading")).toBe(true);
    // 非持久化路径（含动态参数路由与根路径）均不算
    expect(isPersistentPath("/vocabulary")).toBe(false);
    expect(isPersistentPath("/exercise/tense")).toBe(false);
    expect(isPersistentPath("/")).toBe(false);
  });

  it("PERSISTENT_PAGE_PATHS 的每个路径都在 TASK_REGISTRY 登记为 persistent 行", () => {
    // PERSISTENT_TASK_KEY（TTL 卸载前的 running 守卫）由注册表的 persistent 行派生，
    // 故该契约成立即保证每个持久化路径都有对应的任务槽守卫；
    // 否则新增持久化路径忘登记时，守卫查找会静默缺项（running 页面被误卸载）。
    const persistentRoutes = TASK_KEYS.filter((key) => TASK_REGISTRY[key].persistent).map(
      (key) => TASK_REGISTRY[key].route,
    );
    for (const path of Object.values(PERSISTENT_PAGE_PATHS)) {
      expect(persistentRoutes).toContain(path);
    }
  });
});
