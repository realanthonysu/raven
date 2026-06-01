import { useState, useRef, useCallback, useEffect } from "react";
import { getTTSConfigCached } from "@/lib/db";
import { speakText } from "@/services/tts";

interface UseAudioPlayerOptions {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

interface UseAudioPlayerReturn {
  playing: boolean;
  loading: boolean;
  /** 播放指定文本，会先停止当前播放。
   * @param text - 要播放的文本
   * @param speed - 可选的播放速度覆盖（0.5-4.0），会覆盖 TTS 配置中的默认速度 */
  play: (text: string, speed?: number) => Promise<void>;
  /** Stop current playback. */
  stop: () => void;
  /** 切换播放/停止状态。
   * @param text - 要播放的文本（停止时可省略）
   * @param speed - 可选的播放速度覆盖（0.5-4.0），会覆盖 TTS 配置中的默认速度 */
  toggle: (text: string, speed?: number) => void;
}

/**
 * Shared hook for TTS audio playback with AbortController lifecycle management.
 *
 * Encapsulates: TTS config lookup, AbortController creation/cleanup,
 * and loading/playing state transitions. Consumers only provide text
 * and optional callbacks.
 *
 * Usage:
 *   const { playing, loading, play, stop, toggle } = useAudioPlayer({
 *     onEnd: () => console.log("done"),
 *   });
 *   toggle("Hello world");
 */
export function useAudioPlayer(
  options?: UseAudioPlayerOptions
): UseAudioPlayerReturn {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Keep a stable ref to options so the callbacks don't cause re-renders
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Clean up on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPlaying(false);
    setLoading(false);
  }, []);

  const play = useCallback(
    async (text: string, speed?: number) => {
      // Abort any existing playback
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      try {
        const config = await getTTSConfigCached();
        if (!config.api_key) return;

        // Apply speed override if provided
        const effectiveConfig =
          speed != null ? { ...config, speed } : config;

        if (controller.signal.aborted) return;

        setLoading(false);
        setPlaying(true);
        optionsRef.current?.onStart?.();

        await speakText(text, effectiveConfig, controller.signal);

        // Only fire onEnd if this call wasn't aborted
        if (!controller.signal.aborted) {
          optionsRef.current?.onEnd?.();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          optionsRef.current?.onError?.(
            err instanceof Error ? err : new Error(String(err))
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setPlaying(false);
        }
      }
    },
    []
  );

  const toggle = useCallback(
    (text: string, speed?: number) => {
      if (playing) {
        stop();
      } else if (!loading) {
        play(text, speed);
      }
    },
    [playing, loading, stop, play]
  );

  return { playing, loading, play, stop, toggle };
}
