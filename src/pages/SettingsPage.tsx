/**
 * @module SettingsPage
 * @description 应用设置页面。
 *
 * 薄编排层：管理全局错误状态，组合九个独立的设置卡片子组件。
 *
 * 子组件（各卡片自行管理内部状态）：
 * 1. ThemeCard      — 浅色/深色/跟随系统主题切换
 * 2. ModelCard      — 管理 OpenAI 兼容 API 的模型连接，支持添加/删除/编辑/设为默认
 * 3. LevelCard      — 英语水平定级（CEFR 级别 + 考试锚点双标注），控制内容难度
 * 4. VoiceCard      — 合并管理 TTS 和 ASR 的公共配置及私有配置，支持试听和录音测试
 * 5. GoalCard       — 设置每日学习目标（复习/练习/阅读/写作/听力/口语），支持预设方案
 * 6. ReviewCard     — FSRS 目标留存率配置（复习频率与记忆强度权衡）
 * 7. NotificationCard — 每日复习提醒通知开关、系统通知权限管理
 * 8. BackupCard     — SQLite 数据库完整备份
 * 9. AboutCard      — 应用版本信息
 */

import { useState } from "react";
import { ErrorBanner } from "@/components/page-states";
import {
  AboutCard,
  BackupCard,
  GoalCard,
  LevelCard,
  ModelCard,
  NotificationCard,
  ReviewCard,
  ThemeCard,
  VoiceCard,
} from "./settings";

/**
 * 设置页面组件。
 *
 * @returns 设置页面的 JSX 元素
 */
export default function SettingsPage() {
  /** 全局错误提示（任一子组件可通过 onError 设置） */
  const [pageError, setPageError] = useState<string | null>(null);

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold">设置</h2>
      {pageError && <ErrorBanner message={pageError} onDismiss={() => setPageError(null)} />}

      <ThemeCard />
      <ModelCard onError={setPageError} />
      <LevelCard />
      <VoiceCard onError={setPageError} />
      <GoalCard onError={setPageError} />
      <ReviewCard onError={setPageError} />
      <NotificationCard onError={setPageError} />
      <BackupCard onError={setPageError} />
      <AboutCard />
    </div>
  );
}
