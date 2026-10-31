import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { GoalsProvider } from "@/contexts/GoalsContext";
import { getModels, getOnboardingDone, setOnboardingDone } from "@/lib/db";
import { checkAndNotifyReview } from "@/services/notifications";
import { Layout } from "./components/Layout";
import { PersistentRoutes } from "./components/PersistentRoutes";

/**
 * S-03：OnboardingDialog 只在首次启动引导真正需要时才加载。
 *
 * 它是 6 步向导 + 表单/模型预设的较重模块，绝大多数启动（已完成引导）用不到；
 * 静态 import 会让它进入首屏 chunk。改为 lazy 后其代码被拆到独立 chunk，
 * 仅 `showOnboarding` 为 true 时（检测到 models 为空且未完成引导）才 import。
 * 组件是命名导出，故在 then 中映射为 lazy 需要的 default 形状。
 */
const OnboardingDialog = lazy(() =>
  import("@/components/OnboardingDialog").then((m) => ({ default: m.OnboardingDialog })),
);

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const VocabularyPage = lazy(() => import("./pages/VocabularyPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const HistoryDetailPage = lazy(() => import("./pages/HistoryDetailPage"));
const ReviewPage = lazy(() => import("./pages/ReviewPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));
const ExercisePage = lazy(() => import("./pages/ExercisePage"));
const ListeningPage = lazy(() => import("./pages/ListeningPage"));
const SpeakingPage = lazy(() => import("./pages/SpeakingPage"));

/**
 * 应用根组件 —— 定义全局路由架构。
 *
 * 路由层级说明：
 * 1. ErrorBoundary —— 捕获渲染异常，防止白屏
 * 2. Layout —— 提供侧边栏 + 顶栏的全局布局壳（通过 <Outlet/> 渲染子路由），
 *    并持有**页面级懒加载的 Suspense 边界**（S-04）：懒加载 chunk 未就绪时
 *    只有主内容区显示占位，Sidebar/TaskStatusBar 保持渲染（首帧即可交互）。
 * 3. PersistentRoutes —— 核心设计：使用 CSS display 切换而非条件卸载，
 *    使 CorrectPage（写作纠错）和 ReadingPage（阅读精读）在页面切换时保留
 *    用户输入、加载状态、流式结果等内部 state；页面连续隐藏超过 10 分钟
 *    （HIDDEN_UNMOUNT_TTL_MS）则卸载以释放内存，流式任务运行期间不卸载。
 *    其他页面（vocabulary / review / history 等）通过 <Outlet/> 正常渲染。
 *
 * 持久化路径的单一事实来源是 lib/task-status 的 TASK_REGISTRY（persistent 行），
 * 经 PersistentRoutes 导出的 PERSISTENT_PATHS / PERSISTENT_PAGE_PATHS 消费：
 * 新增或移除持久化页面从注册表开始（Layout 的路由匹配器与页面内的隐藏检测均由此派生，无需改本文件）。
 *
 * 路由对照：
 * - "/"             → DashboardPage（首页仪表盘）
 * - "/writing"      → CorrectPage（写作纠错，持久化挂载，PERSISTENT_PAGE_PATHS.correct）
 * - "/reading"      → ReadingPage（阅读精读，持久化挂载，PERSISTENT_PAGE_PATHS.reading）
 * - "/vocabulary"   → VocabularyPage（生词本）
 * - "/review"       → ReviewPage（间隔重复复习）
 * - "/history"      → HistoryPage（历史记录列表）
 * - "/history/:id"  → HistoryDetailPage（单条历史详情）
 * - "/settings"     → SettingsPage（模型配置）
 * - "/analytics"    → AnalyticsPage（学习数据分析）
 * - "/listening"    → ListeningPage（听力练习）
 * - "/speaking"     → SpeakingPage（口语练习）
 * - "/exercise/:category" → ExercisePage（弱项训练）
 */
function App() {
  const [showOnboarding, setShowOnboarding] = useState(false);

  /**
   * 首次启动检测：如果 models 表为空且 onboarding_done 未设置，则显示引导对话框。
   * 两个条件任一满足即跳过：已有模型配置 或 用户已完成过引导。
   */
  useEffect(() => {
    Promise.all([getModels(), getOnboardingDone()])
      .then(([models, done]) => {
        if (models.length === 0 && !done) {
          setShowOnboarding(true);
        }
      })
      .catch((e) => console.warn("[app] onboarding check failed:", e));
  }, []);

  /**
   * 应用启动时检查是否需要发送复习提醒通知。
   * 在后台静默执行，不影响页面渲染和用户交互。
   */
  useEffect(() => {
    checkAndNotifyReview();
  }, []);

  function handleOnboardingComplete() {
    setOnboardingDone().catch((e) => console.warn("[app] setSetting onboarding_done failed:", e));
    setShowOnboarding(false);
  }

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <GoalsProvider>
          {/*
            S-04：懒加载页面的 Suspense 边界下移到 Layout（包裹 <Outlet/>），
            这里不再包整棵路由树——否则任何页面 chunk 加载中都会把 Sidebar/TaskStatusBar
            一起替换成全屏"加载中…"，启动首帧看不到外壳。Layout 现在是唯一边界，
            PersistentRoutes 保留自己的局部边界（常驻页首访不闪烁）。
          */}
          <Routes>
            {/* Layout 作为嵌套路由的父级，提供统一的页面框架 */}
            <Route element={<Layout />}>
              {/* path="*" 匹配所有路径，由 PersistentRoutes 内部决定显示哪个持久化页面 */}
              <Route path="*" element={<PersistentRoutes />}>
                <Route index element={<DashboardPage />} />
                <Route path="vocabulary" element={<VocabularyPage />} />
                <Route path="review" element={<ReviewPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="history/:id" element={<HistoryDetailPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="exercise/:category" element={<ExercisePage />} />
                <Route path="listening" element={<ListeningPage />} />
                <Route path="speaking" element={<SpeakingPage />} />
              </Route>
            </Route>
          </Routes>
        </GoalsProvider>
      </BrowserRouter>
      {/*
        S-03：引导对话框的局部边界——chunk 未就绪时不渲染任何东西（fallback=null），
        避免在初次启动检测完成前闪烁加载占位。检测逻辑本身保持不变。
      */}
      {showOnboarding && (
        <Suspense fallback={null}>
          <OnboardingDialog onComplete={handleOnboardingComplete} />
        </Suspense>
      )}
    </ErrorBoundary>
  );
}

export default App;
