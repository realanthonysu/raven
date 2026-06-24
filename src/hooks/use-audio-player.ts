import { useCallback, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { useLatestRef } from "@/hooks/use-latest-ref";
import { getTTSConfigCached } from "@/lib/db";
import { speakText } from "@/services/tts";

interface UseAudioPlayerOptions {
  /** 音频开始播放时调用 */
  onStart?: () => void;
  /** 音频播放完成时调用 */
  onEnd?: () => void;
  /** 播放出错时调用 */
  onError?: (err: Error) => void;
}

interface UseAudioPlayerReturn {
  /** 是否正在播放 */
  playing: boolean;
  /** 是否正在加载 TTS 音频（请求已发出但尚未开始播放） */
  loading: boolean;
  /** 播放指定文本，会先停止当前播放。
   * @param text - 要播放的文本
   * @param speed - 可选的播放速度覆盖（0.5-4.0），会覆盖 TTS 配置中的默认速度
   * @returns true 表示播放成功，false 表示失败或被中止 */
  play: (text: string, speed?: number) => Promise<boolean>;
  /** 停止当前播放。 */
  stop: () => void;
  /**
   * 切换播放/停止状态。
   * @param text - 要播放的文本（停止时可省略）
   * @param speed - 可选的播放速度覆盖（0.5-4.0），会覆盖 TTS 配置中的默认速度
   */
  toggle: (text: string, speed?: number) => void;
}

/**
 * TTS 音频播放 hook —— 封装 AbortController 生命周期管理。
 *
 * 封装了：TTS 配置查询、AbortController 创建/清理、
 * loading/playing 状态转换。调用者只需提供文本和可选回调。
 *
 * 用法：
 *   const { playing, loading, play, stop, toggle } = useAudioPlayer({
 *     onEnd: () => console.log("done"),
 *   });
 *   toggle("Hello world");
 */
export function useAudioPlayer(options?: UseAudioPlayerOptions): UseAudioPlayerReturn {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const { abort, getSignal } = useAbortable();

  // 将 options 存储在 ref 中，避免回调变化导致 play/stop 等函数重建
  const optionsRef = useLatestRef(options);

  const stop = useCallback(() => {
    abort();
    setPlaying(false);
    setLoading(false);
  }, [abort]);

  // optionsRef.current 回调通过 useLatestRef 同步，故意不放入依赖数组
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 访问不需要作为依赖
  const play = useCallback(
    async (text: string, speed?: number): Promise<boolean> => {
      // 中止当前正在进行的播放（如有），获取新 signal
      abort();
      const signal = getSignal();

      setLoading(true);
      try {
        const config = await getTTSConfigCached();
        if (!config.api_key) return false;

        // 应用速度覆盖（如提供）
        const effectiveConfig = speed != null ? { ...config, speed } : config;

        if (signal.aborted) return false;

        setPlaying(true);
        setLoading(false);
        optionsRef.current?.onStart?.();

        await speakText(text, effectiveConfig, signal);

        // 仅在本次调用未被中止时触发 onEnd 回调
        if (!signal.aborted) {
          optionsRef.current?.onEnd?.();
        }
        return true;
      } catch (err) {
        if (!signal.aborted) {
          optionsRef.current?.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        return false;
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          setPlaying(false);
        }
      }
    },
    [abort, getSignal],
  );

  const toggle = useCallback(
    (text: string, speed?: number) => {
      if (playing) {
        stop();
      } else if (!loading) {
        play(text, speed);
      }
    },
    [playing, loading, stop, play],
  );

  return { playing, loading, play, stop, toggle };
}
