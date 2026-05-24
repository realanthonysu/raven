import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { PersistentRoutes } from "./components/PersistentRoutes";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import VocabularyPage from "./pages/VocabularyPage";
import HistoryPage from "./pages/HistoryPage";
import HistoryDetailPage from "./pages/HistoryDetailPage";
import ReviewPage from "./pages/ReviewPage";
import SettingsPage from "./pages/SettingsPage";
import AnalyticsPage from "./pages/AnalyticsPage";

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
  return (
    <ErrorBoundary>
      <BrowserRouter>
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
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
