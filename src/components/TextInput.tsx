import { useMemo } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

/**
 * TextInput 组件的 Props 接口
 *
 * 设计为受控组件模式：value + onChange 由父组件管理状态，
 * 这样父组件可以在提交前读取/校验文本内容。
 */
interface TextInputProps {
  /** 当前文本内容 */
  value: string;
  /** 文本变化回调，父组件通过此回调更新状态 */
  onChange: (value: string) => void;
  /** 提交回调，由按钮点击或快捷键触发 */
  onSubmit: () => void;
  /** 输入框占位文本 */
  placeholder?: string;
  /** 加载状态，为 true 时禁用提交按钮并显示旋转图标 */
  loading?: boolean;
  /** 提交按钮文字，允许不同页面自定义（如"开始纠正"、"开始精读"） */
  submitLabel?: string;
}

/**
 * 文本输入组件
 *
 * 职责：提供带字数统计和快捷键提交的文本输入区域。
 * 被 CorrectPage 和 ReadingPage 共用，是用户输入的主要入口。
 *
 * 交互设计：
 * - Ctrl+Enter / Cmd+Enter 快捷键提交（适配 macOS 和 Windows）
 * - 空白文本和加载状态下禁用提交按钮，防止无效请求
 * - 字数统计使用 useMemo 缓存，避免每次渲染都重新计算
 *
 * 注意：此组件不处理 LLM 请求逻辑，只负责收集和传递文本。
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = "输入文本...",
  loading = false,
  submitLabel = "提交",
}: TextInputProps) {
  // 字数统计：按空白字符分割，过滤空字符串
  // useMemo 确保只在 value 变化时重新计算，避免不必要的性能开销
  const wordCount = useMemo(
    () => value.trim().split(/\s+/).filter(Boolean).length,
    [value]
  );

  return (
    <div className="space-y-3">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-h-[120px] resize-y"
        onKeyDown={(e) => {
          // 同时支持 Ctrl (Windows/Linux) 和 Meta (macOS Cmd) 键
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            onSubmit();
          }
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Ctrl+Enter 提交
        </span>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-xs text-muted-foreground">{wordCount} words</span>
        {/* disabled 条件：正在加载 OR 文本为空（trim 后），两者任一满足即禁用 */}
        <Button onClick={onSubmit} disabled={loading || !value.trim()}>
          {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
