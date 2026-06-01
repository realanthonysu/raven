import { Button } from "@/components/ui/button";
import { Volume2, VolumeX, Loader2 } from "lucide-react";
import { useAudioPlayer } from "@/hooks/use-audio-player";

/**
 * SpeakButton 组件的属性接口。
 *
 * 用于在应用各处快速嵌入一个 TTS 语音播放按钮，
 * 内部通过 `useAudioPlayer` hook 管理播放状态。
 */
interface SpeakButtonProps {
  /** 要朗读的文本内容，传递给 TTS 引擎 */
  text: string;
  /** 按钮尺寸，对应 shadcn/ui Button 的 size 变体，默认 "icon-xs" */
  size?: "xs" | "sm" | "default" | "icon-xs" | "icon-sm";
  /** 按钮样式变体，默认 "ghost"（透明背景） */
  variant?: "ghost" | "outline";
  /** 额外的 CSS 类名，用于外部微调样式 */
  className?: string;
}

/**
 * 语音朗读按钮组件。
 *
 * 三态图标逻辑：
 * - **加载中**（`loading`）：显示旋转的 Loader2 图标，按钮处于禁用状态
 * - **播放中**（`playing`）：显示 VolumeX（停止图标），点击可停止播放
 * - **空闲**：显示 Volume2（播放图标），点击开始朗读
 *
 * 使用示例：
 * ```tsx
 * <SpeakButton text="Hello, world!" />
 * <SpeakButton text={sentence} size="sm" variant="outline" />
 * ```
 */
export function SpeakButton({
  text,
  size = "icon-xs",
  variant = "ghost",
  className,
}: SpeakButtonProps) {
  const { playing, loading, toggle } = useAudioPlayer();

  /**
   * 处理点击事件。
   * stopPropagation 阻止事件冒泡，避免触发父级卡片等容器的点击事件
   *（例如在 ExerciseCard 中点击朗读按钮不应触发题目选中逻辑）。
   */
  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    toggle(text);
  }

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      onClick={handleClick}
      disabled={loading}
    >
      {/* 根据三种状态渲染对应图标：加载中 → 旋转加载器，播放中 → 停止图标，空闲 → 播放图标 */}
      {loading ? (
        <Loader2 className="animate-spin" />
      ) : playing ? (
        <VolumeX />
      ) : (
        <Volume2 />
      )}
    </Button>
  );
}
