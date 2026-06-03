import { useState, useEffect, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { PersistentRoutes } from "./components/PersistentRoutes";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OnboardingDialog } from "@/components/OnboardingDialog";
import { getModels, getSetting, setSetting } from "@/lib/db";
import { checkAndNotifyReview } from "@/services/notifications";

const VocabularyPage = lazy(() => import("./pages/VocabularyPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const HistoryDetailPage = lazy(() => import("./pages/HistoryDetailPage"));
const ReviewPage = lazy(() => import("./pages/ReviewPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));
const ExercisePage = lazy(() => import("./pages/ExercisePage"));
const ListeningPage = lazy(() => import("./pages/ListeningPage"));
const SpeedTrainerPage = lazy(() => import("./pages/SpeedTrainerPage"));

/**
 * 应用根组件 —— 定义全局路由架构。
 *
 * 路由层级说明：
 * 1. ErrorBoundary —— 捕获渲染异常，防止白屏
 * 2. Layout —— 提供侧边栏 + 顶栏的全局布局壳（通过 <Outlet/> 渲染子路由）
 * 3. PersistentRoutes —— 核心设计：使用 CSS display 切换而非条件卸载，
 *    使 CorrectPage（写作纠错）和 ReadingPage（阅读精读）始终保持挂载状态，
 *    从而在页面切换时保留用户输入、加载状态、流式结果等内部 state。
 *    其他页面（vocabulary / review / history 等）通过 <Outlet/> 正常渲染。
 *
 * 路由对照：
 * - "/"             → CorrectPage（写作纠错，默认首页）
 * - "/reading"      → ReadingPage（阅读精读）
 * - "/vocabulary"   → VocabularyPage（生词本）
 * - "/review"       → ReviewPage（间隔重复复习）
 * - "/history"      → HistoryPage（历史记录列表）
 * - "/history/:id"  → HistoryDetailPage（单条历史详情）
 * - "/settings"     → SettingsPage（模型配置）
 * - "/analytics"    → AnalyticsPage（学习数据分析）
 */
function App() {
  const [showOnboarding, setShowOnboarding] = useState(false);

  /**
   * 首次启动检测：如果 models 表为空且 onboarding_done 未设置，则显示引导对话框。
   * 两个条件任一满足即跳过：已有模型配置 或 用户已完成过引导。
   */
  useEffect(() => {
    Promise.all([getModels(), getSetting("onboarding_done")]).then(
      ([models, done]) => {
        if (models.length === 0 && done !== "true") {
          setShowOnboarding(true);
        }
      }
    );
  }, []);

  /**
   * 应用启动时检查是否需要发送复习提醒通知。
   * 在后台静默执行，不影响页面渲染和用户交互。
   */
  useEffect(() => {
    checkAndNotifyReview();
  }, []);

  function handleOnboardingComplete() {
    setSetting("onboarding_done", "true").catch(() => {});
    setShowOnboarding(false);
  }

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Suspense fallback={<div className="flex h-screen items-center justify-center text-muted-foreground">加载中…</div>}>
          <Routes>
          {/* Layout 作为嵌套路由的父级，提供统一的页面框架 */}
          <Route element={<Layout />}>
            {/* path="*" 匹配所有路径，由 PersistentRoutes 内部决定显示哪个持久化页面 */}
            <Route path="*" element={<PersistentRoutes />}>
              <Route path="vocabulary" element={<VocabularyPage />} />
              <Route path="review" element={<ReviewPage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="history/:id" element={<HistoryDetailPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="exercise/:category" element={<ExercisePage />} />
              <Route path="listening" element={<ListeningPage />} />
              <Route path="speed-trainer" element={<SpeedTrainerPage />} />
            </Route>
          </Route>
        </Routes>
        </Suspense>
      </BrowserRouter>
      {showOnboarding && (
        <OnboardingDialog onComplete={handleOnboardingComplete} />
      )}
    </ErrorBoundary>
  );
}

export default App;
