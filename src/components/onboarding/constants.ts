/**
 * @module onboarding/constants
 * @description 新手引导对话框的静态配置（功能清单、API 预设、示例数据）。
 */

import { BookCheck, BookOpen, Brain, Target } from "lucide-react";

/** 第 2 步展示的功能预览卡片 */
export const FEATURES = [
  { icon: BookCheck, label: "写作批改", desc: "AI 智能纠错，分类解析错误" },
  { icon: BookOpen, label: "阅读精读", desc: "六维深度分析，知识图谱" },
  { icon: Brain, label: "间隔复习", desc: "科学记忆曲线，高效背词" },
  { icon: Target, label: "弱项训练", desc: "针对薄弱点，专项突破" },
] as const;

/** API 地址预设（OpenAI / DeepSeek） */
export const API_PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
] as const;

/** 第 3 步体验预览的静态示例输出 */
export const SAMPLE_RESULT = {
  corrected_text:
    "Yesterday I went to the library and borrowed two books. The librarian was very helpful; she recommended an interesting novel to me.",
  corrections: [
    {
      original: "go",
      corrected: "went",
      category: "时态",
      explanation: '"Yesterday" 表示过去时间，动词需用过去式 went。',
    },
    {
      original: "two book",
      corrected: "two books",
      category: "单复数",
      explanation: '"two" 后接可数名词复数形式 books。',
    },
    {
      original: "recommanded",
      corrected: "recommended",
      category: "拼写",
      explanation: "recommended 拼写为两个 m。",
    },
    {
      original: "a interesting",
      corrected: "an interesting",
      category: "冠词",
      explanation: '"interesting" 以元音音素开头，冠词用 an。',
    },
  ],
  summary: "文章涉及 4 类常见错误：时态、单复数、拼写和冠词。整体表达基本通顺，注意细节即可。",
} as const;

/** 步骤标题 */
export const STEP_TITLES = ["欢迎", "配置 API", "体验预览", "完成"] as const;

/** 第 4 步快速入口清单 */
export const QUICK_START_ENTRIES = [
  { icon: BookCheck, label: "Writing Copilot", desc: "左侧导航进入，粘贴英文即可获得批改" },
  { icon: BookOpen, label: "Reading Copilot", desc: "输入英文文章，获取六维深度分析" },
  { icon: Brain, label: "间隔复习", desc: "阅读时添加生词，自动进入复习计划" },
  { icon: Target, label: "弱项训练", desc: "系统分析你的薄弱点，生成专项练习" },
] as const;
