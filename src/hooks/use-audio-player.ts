import { useCallback, useEffect, useRef, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { useLatestRef } from "@/hooks/use-latest-ref";
import { getTTSConfigCached } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
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

// ── 全局互斥播放注册表 ──
// 每个组件实例的 useAudioPlayer 持有独立 AbortController、互不知晓：
// 同屏多个 SpeakButton（全文 + 每条纠错）会出现两路 TTS 重叠播放。
// 任一实例开始播放前先停止其他实例，全局同一时刻只有一路音频。
interface ActivePlayback {
  /** 持有播放的 hook 实例身份标记，用于区分"自身重入"与"其他实例" */
  instance: object;
  stop: () => void;
}
let activePlayback: ActivePlayback | null = null;

export function useAudioPlayer(options?: UseAudioPlayerOptions): UseAudioPlayerReturn {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const { abort, getSignal } = useAbortable();

  // 将 options 存储在 ref 中，避免回调变化导致 play/stop 等函数重建
  const optionsRef = useLatestRef(options);

  // 跟踪 loading/playing 状态，卸载时用于判断是否需要清理
  const loadingRef = useRef(false);
  const playingRef = useRef(false);
  // 本 hook 实例的稳定身份标记（供全局互斥注册表区分实例）
  const instanceRef = useRef<object>({});
  const setLoadingState = (v: boolean) => {
    loadingRef.current = v;
    setLoading(v);
  };
  const setPlayingState = (v: boolean) => {
    playingRef.current = v;
    setPlaying(v);
  };

  // 组件卸载时清理：中止进行中的 TTS 请求并释放全局互斥登记。
  // 卸载后的 setState 是 no-op（state 随组件销毁），实际生效的只有 abort()。
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup only on unmount
  useEffect(() => {
    return () => {
      if (activePlayback?.instance === instanceRef.current) {
        activePlayback = null;
      }
      if (loadingRef.current || playingRef.current) {
        abort();
      }
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setter wrappers are stable (defined in component body, not hooks)
  const stop = useCallback(() => {
    abort();
    setPlayingState(false);
    setLoadingState(false);
  }, [abort]);

  // optionsRef.current 回调通过 useLatestRef 同步，故意不放入依赖数组
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref 访问不需要作为依赖
  const play = useCallback(
    async (text: string, speed?: number): Promise<boolean> => {
      // 中止当前正在进行的播放（如有），获取新 signal
      abort();
      const signal = getSignal();

      // 全局互斥：停止**其他实例**正在进行的播放/加载。
      // 自身重入不在此处理（上面的 abort 已统一中止旧请求）
      if (activePlayback && activePlayback.instance !== instanceRef.current) {
        const { stop } = activePlayback;
        activePlayback = null;
        stop();
      }
      const self: ActivePlayback = {
        instance: instanceRef.current,
        stop: () => {
          abort();
          setPlayingState(false);
          setLoadingState(false);
        },
      };
      activePlayback = self;

      setLoadingState(true);
      try {
        const config = await getTTSConfigCached();
        // 已中止的调用不应再走配置校验并触发 onError（用户已取消，不是错误）
        if (signal.aborted) return false;
        // M-8: 校验 TTS 配置完整性，避免发起注定失败的网络请求
        if (!config.api_key || !config.base_url) {
          setLoadingState(false);
          optionsRef.current?.onError?.(new Error("请先在设置中配置 TTS API Key 和 Base URL"));
          return false;
        }

        // 应用速度覆盖（如提供）
        const effectiveConfig = speed != null ? { ...config, speed } : config;

        if (signal.aborted) return false;

        setPlayingState(true);
        setLoadingState(false);
        optionsRef.current?.onStart?.();

        await speakText(text, effectiveConfig, signal);

        // 仅在本次调用未被中止时触发 onEnd 回调
        if (!signal.aborted) {
          optionsRef.current?.onEnd?.();
        }
        return true;
      } catch (err) {
        if (!signal.aborted) {
          optionsRef.current?.onError?.(
            err instanceof Error ? err : new Error(getErrorMessage(err)),
          );
        }
        return false;
      } finally {
        // 播放结束（完成/失败/中止）后释放全局注册表中的登记
        if (activePlayback === self) {
          activePlayback = null;
        }
        if (!signal.aborted) {
          setLoadingState(false);
          setPlayingState(false);
        }
      }
    },
    [abort, getSignal],
  );

  // 使用 ref 而非 state 判断当前状态，避免快速连续调用时读到旧闭包值
  // 导致并发播放（state 更新在下次渲染才生效，ref 同步更新）。
  // loading 中也允许停止：中止进行中的 TTS 请求，避免用户被卡到 60s 超时
  const toggle = useCallback(
    (text: string, speed?: number) => {
      if (playingRef.current || loadingRef.current) {
        stop();
      } else {
        play(text, speed);
      }
    },
    [stop, play],
  );

  return { playing, loading, play, stop, toggle };
}
