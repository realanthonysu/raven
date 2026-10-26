import { useCallback, useEffect, useRef, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { useLatestRef } from "@/hooks/use-latest-ref";
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
  /** 是否正在准备播放（音频请求发出前的同步准备阶段；请求与播放期间该值为
   * false、playing 为 true。TTS 配置的读取与校验在 services/tts 内部完成） */
  loading: boolean;
  /** 播放指定文本，会先停止当前播放。
   * @param text - 要播放的文本
   * @param speed - 可选的播放速度覆盖（0.25-4.0），会覆盖 TTS 配置中的默认速度
   * @returns true 表示播放成功，false 表示失败或被中止 */
  play: (text: string, speed?: number) => Promise<boolean>;
  /** 停止当前播放。 */
  stop: () => void;
  /**
   * 切换播放/停止状态。
   * @param text - 要播放的文本（停止时可省略）
   * @param speed - 可选的播放速度覆盖（0.25-4.0），会覆盖 TTS 配置中的默认速度
   */
  toggle: (text: string, speed?: number) => void;
}

/**
 * TTS 音频播放 hook —— 封装 AbortController 生命周期管理。
 *
 * 封装了：AbortController 创建/清理、loading/playing 状态转换。
 * TTS 配置的读取、校验（未配置抛 TTS_NOT_CONFIGURED_MESSAGE）与语速合成
 * 全部在 services/tts（speakText）内完成，本 hook 只是纯播放态外壳。
 * 调用者只需提供文本和可选回调。
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
//
// 设计约束（为什么必须是模块级可变变量）：
// 互斥的对象是"跨 hook 实例"的播放，而各实例的 AbortController/state
// 彼此隔离、无法通过 props/context 传递停止句柄（SpeakButton 是叶子组件，
// 引入全局 context 会把互斥成本转嫁给所有调用方）。因此用模块级单槽注册表
// （同一时刻至多一条登记）实现最小侵入的跨实例协调。
//
// 生命周期与泄漏防护（含 StrictMode 双挂载场景）：
// - 登记携带 instance 身份标记；play 的 finally 只在 `activePlayback === self`
//   时释放（后到的实例不被先前的实例误清），unmount cleanup 同样按身份释放，
//   StrictMode 卸载-重挂载产生的旧实例不会清掉新实例的登记。
// - 槽位是单变量而非 Map：旧实例若未正常收尾（如 promise 永久悬挂），
//   至多残留一条被新 play() 覆盖/身份校验跳过的登记，不会累积增长。
interface ActivePlayback {
  /** 持有播放的 hook 实例身份标记，用于区分"自身重入"与"其他实例" */
  instance: object;
  stop: () => void;
}
let activePlayback: ActivePlayback | null = null;

/**
 * 停止当前全局唯一的活跃播放/加载（若有）。
 *
 * 为什么需要模块级函数：播放互斥注册表保证全应用同一时刻至多一路音频
 * （见 activePlayback 注释），但各 hook 实例的 stop() 只能停止自己——
 * 没有自有播放器的调用方（如 CorrectPage，音频全部来自子级 SpeakButton 实例）
 * 无法拿到"正在播放的那个实例"的句柄。经由注册表间接停止是唯一入口，
 * 且因为互斥性，停掉这一个实例即等价于"停止一切声音"。
 *
 * 典型场景：PersistentRoutes 保持页面常驻挂载、离开不卸载时，
 * useHiddenEffect 在"被隐藏的瞬间"调用本函数替代 unmount 清理。
 */
export function stopActivePlayback(): void {
  if (!activePlayback) return;
  const { stop } = activePlayback;
  // 先清登记再停止：与 play() 内跨实例互斥的处理顺序一致，
  // 防止 stop 过程中同步触发的回调再次读到过期登记
  activePlayback = null;
  stop();
}

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
        // 已中止的调用不再进入播放流程（用户已取消，不是错误）
        if (signal.aborted) return false;

        setPlayingState(true);
        setLoadingState(false);
        optionsRef.current?.onStart?.();

        // 配置读取/校验（未配置时 speakText 抛 TTS_NOT_CONFIGURED_MESSAGE）与
        // speed 合成在 TTS 服务层完成；错误经下方 catch 走 onError 上报
        await speakText(text, { speed }, signal);

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
