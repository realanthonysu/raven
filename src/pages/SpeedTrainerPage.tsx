import {
  Gauge,
  Loader2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { getTTSConfigCached } from "@/lib/db";
import { splitSentences } from "@/lib/parse-utils";
import { speakText } from "@/services/tts";
import type { TTSConfig } from "@/types";

/**
 * 可选的播放语速倍率列表（0.5x 慢速 → 1.5x 快速）。
 * 用于渲染语速选择按钮组。
 */
const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5] as const;

/**
 * 循环播放模式：
 * - "none"   — 不循环，播放完最后一句后停止
 * - "single" — 单句循环，反复播放当前句子
 * - "all"    — 全文循环，播放完最后一句后从头开始
 */
type LoopMode = "none" | "single" | "all";

/**
 * 语速训练页面（SpeedTrainerPage）
 *
 * 整体流程分为两个阶段：
 * 1. **输入阶段**：用户粘贴英文文本，系统拆分为句子列表
 * 2. **播放器阶段**：按句子逐句 TTS 播放，支持五档语速、三种循环模式、
 *    上/下句切换、单句点击播放等操作
 *
 * 并发安全：通过 `playGenerationRef`（代际计数器）防止过期的异步回调
 * 干扰当前播放状态，替代了早期 stoppedRef + setTimeout 的方案。
 */
export default function SpeedTrainerPage() {
  const [input, setInput] = useState("");
  /** 拆分后的句子列表，空数组表示处于输入阶段 */
  const [sentences, setSentences] = useState<string[]>([]);
  /** 当前正在播放的句子索引，-1 表示尚未开始播放 */
  const [currentIndex, setCurrentIndex] = useState(-1);
  /** 当前播放语速倍率 */
  const [speed, setSpeed] = useState(1.0);
  /** 是否正在播放中（TTS 朗读中或播放循环中） */
  const [playing, setPlaying] = useState(false);
  /** 是否正在加载 TTS 音频（请求已发出但尚未开始播放） */
  const [loading, setLoading] = useState(false);
  /** 循环播放模式 */
  const [loopMode, setLoopMode] = useState<LoopMode>("none");
  const loopModeRef = useRef<LoopMode>("none");

  /**
   * 当前播放流程的 AbortController。
   * 调用 `.abort()` 可取消正在进行的 TTS 请求，用于停止/切换句子/切换语速等场景。
   */
  const playAbortRef = useRef<AbortController | null>(null);

  // 组件卸载时中止正在进行的 TTS 播放，防止音频在后台继续播放
  useEffect(() => {
    return () => {
      playAbortRef.current?.abort();
    };
  }, []);

  /**
   * 播放代际计数器（generation counter）—— 核心并发安全机制。
   *
   * 每次启动新的播放流程时递增，过期的异步回调通过比较 generation 值
   * 判断自己是否已过时，过时则静默退出，避免污染当前播放状态。
   *
   * 为什么需要这个模式？
   * ─────────────────────────
   * 播放循环是异步的（每句都要 await TTS），期间用户可能随时触发停止、
   * 切换句子、切换语速等操作，这些操作会启动新的播放流程。
   * 如果旧流程的异步回调在新流程之后执行，会用过期的 state 覆盖新状态，
   * 导致播放状态错乱（例如：已停止后突然恢复播放、currentIndex 回退等）。
   *
   * 工作原理：
   * 1. playFrom() 入口处 `++playGenerationRef.current`，捕获当前 generation
   * 2. 异步操作的每个关键节点检查 `playGenerationRef.current === generation`
   * 3. 若不相等，说明已有更新的播放流程启动，当前回调静默退出
   *
   * 这比 setTimeout + stoppedRef 的旧方案更可靠，因为 generation 是严格递增的，
   * 不会出现"停止后再启动"时 stoppedRef 未重置的竞态问题。
   */
  const playGenerationRef = useRef(0);

  /**
   * 处理"开始训练"按钮点击。
   * 将输入文本拆分为句子，中止当前播放（如有），重置播放状态，进入播放器阶段。
   */
  function handleStart() {
    const trimmed = input.trim();
    if (!trimmed) return;
    const s = splitSentences(trimmed);
    if (s.length === 0) return;
    // 若之前有播放流程，先中止并递增 generation 使过期回调失效
    playAbortRef.current?.abort();
    playGenerationRef.current++;
    setSentences(s);
    setCurrentIndex(0);
    setPlaying(false);
  }

  /**
   * 播放单个句子的 TTS 朗读。
   *
   * @param index  - 要播放的句子索引
   * @param cfg    - TTS 配置（API key、voice 等）
   * @param spd    - 播放语速倍率
   * @param signal - AbortSignal，用于取消播放
   *
   * 设置 loading 状态 → 调用 speakText → 播放结束或异常后清除 loading。
   * 不管理 playing 状态（由调用方 playFrom / handlePlayOne 负责）。
   */
  const playSentence = useCallback(
    async (index: number, cfg: TTSConfig, spd: number, signal?: AbortSignal) => {
      if (index < 0 || index >= sentences.length) return;
      setCurrentIndex(index);
      setLoading(true);
      try {
        await speakText(sentences[index], { ...cfg, speed: spd }, signal);
      } catch {
        // 静默捕获：可能是 AbortError（用户主动中止）或 TTS 网络错误
      } finally {
        setLoading(false);
      }
    },
    [sentences],
  );

  /**
   * 从指定句子开始连续播放（核心播放循环）。
   *
   * 并发安全策略：
   * 1. 先中止上一次播放流程的 AbortController
   * 2. 创建新的 AbortController 并递增 generation 计数器
   * 3. 获取 TTS 配置后再次检查 generation（异步间隙可能已有新流程）
   * 4. while 循环中每轮都检查 generation + signal.aborted
   * 5. 循环结束后仅在 generation 仍为当前值时才更新 playing 状态
   *
   * 循环模式处理：
   * - "none"   → i++ 直到末尾停止
   * - "single" → i 不变，反复播放同一句
   * - "all"    → i++ 到末尾后回绕到 0
   *
   * @param startIndex - 从第几句开始播放（0-based）
   */
  const playFrom = useCallback(
    async (startIndex: number, overrideSpeed?: number) => {
      playAbortRef.current?.abort();
      const controller = new AbortController();
      playAbortRef.current = controller;

      const generation = ++playGenerationRef.current;
      const effectiveSpeed = overrideSpeed ?? speed;

      const config = await getTTSConfigCached();
      // 异步获取配置期间可能已有新流程启动，检查 generation 和 api_key
      if (!config.api_key || playGenerationRef.current !== generation) return;

      setPlaying(true);

      let i = startIndex;
      // 每轮循环都检查三个退出条件：越界、generation 过期、abort 信号
      while (
        i < sentences.length &&
        playGenerationRef.current === generation &&
        !controller.signal.aborted
      ) {
        await playSentence(i, config, effectiveSpeed, controller.signal);
        // playSentence 是异步的，执行期间可能已触发停止/切换，再次检查
        if (playGenerationRef.current !== generation || controller.signal.aborted) break;

        const currentLoopMode = loopModeRef.current;
        if (currentLoopMode === "single") {
        } else {
          i++;
          // 全文循环：到末尾后回绕到第一句；不循环模式下 i >= length 会自然退出 while
          if (i >= sentences.length && currentLoopMode === "all") {
            i = 0;
          }
        }
      }

      // 仅当 generation 仍为当前值时才清除 playing 状态；
      // 若已被更新的流程覆盖，则由新流程负责状态管理
      if (playGenerationRef.current === generation) {
        setPlaying(false);
      }
    },
    [sentences, speed, playSentence],
  );

  /**
   * 播放/暂停切换。
   * - 正在播放 → 中止当前流程并停止
   * - 未播放   → 从 currentIndex（或第 0 句）开始播放
   */
  function handlePlay() {
    if (playing) {
      // 暂停：中止当前播放流程，递增 generation 使异步回调失效
      playAbortRef.current?.abort();
      playGenerationRef.current++;
      setPlaying(false);
      return;
    }
    const startIdx = currentIndex >= 0 ? currentIndex : 0;
    playFrom(startIdx);
  }

  /**
   * 停止播放并重置到初始状态。
   * 中止当前流程，清除 playing 和 currentIndex（回到未播放状态）。
   */
  function handleStop() {
    // 中止当前播放流程，递增 generation 使所有进行中的异步回调失效
    playAbortRef.current?.abort();
    playGenerationRef.current++;
    setPlaying(false);
    setCurrentIndex(-1); // 重置为未播放状态
  }

  /**
   * 跳转到上一句。
   * 如果正在播放，会从中断点重新启动播放循环（playFrom）。
   */
  function handlePrev() {
    if (currentIndex > 0) {
      const newIdx = currentIndex - 1;
      setCurrentIndex(newIdx);
      if (playing) {
        playFrom(newIdx);
      }
    }
  }

  /**
   * 跳转到下一句。
   * 如果正在播放，会从下一句重新启动播放循环（playFrom）。
   */
  function handleNext() {
    if (currentIndex < sentences.length - 1) {
      const newIdx = currentIndex + 1;
      setCurrentIndex(newIdx);
      if (playing) {
        playFrom(newIdx);
      }
    }
  }

  /**
   * 切换播放语速。
   * 如果正在播放，会用新语速从当前句子重新启动播放循环。
   */
  function handleSpeedChange(newSpeed: number) {
    setSpeed(newSpeed);
    if (playing) {
      playFrom(currentIndex, newSpeed);
    }
  }

  /**
   * 点击句子列表中的某一句，单独播放该句。
   *
   * 与 playFrom 不同，这里不启动连续播放循环，只播一句就停止。
   * 同样使用 generation 计数器保证并发安全：
   * 先中止旧流程并递增 generation，再异步获取 TTS 配置后再次检查。
   *
   * @param index - 要播放的句子索引（0-based）
   */
  function handlePlayOne(index: number) {
    // 先中止旧流程（包括连续播放循环），递增 generation 使其失效
    playAbortRef.current?.abort();
    playGenerationRef.current++;
    setPlaying(false);

    // 创建新的 AbortController 并递增 generation 作为本次播放的标识
    const controller = new AbortController();
    playAbortRef.current = controller;
    const generation = ++playGenerationRef.current;

    getTTSConfigCached().then((config) => {
      // .then() 是异步回调，期间可能已有新流程启动，再次检查 generation
      if (!config.api_key || playGenerationRef.current !== generation) return;
      setPlaying(true);
      playSentence(index, config, speed, controller.signal).finally(() => {
        // 播放结束后同样检查 generation，避免过期回调清除新流程的 playing 状态
        if (playGenerationRef.current === generation) setPlaying(false);
      });
    });
  }

  /**
   * 切换循环模式：none → single → all → none ...
   * 仅更新 loopMode 状态，不影响当前播放（下次 playFrom 时生效）。
   */
  function cycleLoopMode() {
    const modes: LoopMode[] = ["none", "single", "all"];
    const idx = modes.indexOf(loopMode);
    const next = modes[(idx + 1) % modes.length];
    loopModeRef.current = next;
    setLoopMode(next);
  }

  /** 根据循环模式选择图标：单句循环用 Repeat1（带下标1），其余用 Repeat */
  const LoopIcon = loopMode === "single" ? Repeat1 : Repeat;

  // === 输入阶段 ===
  if (sentences.length === 0) {
    return (
      <div className="p-6 max-w-4xl space-y-6">
        <h2 className="text-2xl font-bold">语速训练</h2>

        <Card className="max-w-2xl mx-auto">
          <CardContent className="p-8 space-y-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Gauge className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="font-medium">粘贴英文文本</p>
                <p className="text-sm text-muted-foreground">系统会拆分为句子，支持五档语速播放</p>
              </div>
            </div>

            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="粘贴一段英文文章..."
              rows={8}
              className="resize-none"
            />

            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {input.trim() ? `约 ${splitSentences(input.trim()).length} 个句子` : ""}
              </span>
              <Button onClick={handleStart} disabled={!input.trim()}>
                开始训练
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // === 播放器阶段 ===
  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">语速训练</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // 退出播放器阶段前，先中止当前播放流程并递增 generation
            playAbortRef.current?.abort();
            playGenerationRef.current++;
            setPlaying(false);
            setSentences([]); // sentences 清空后回到输入阶段
            setCurrentIndex(-1);
          }}
        >
          重新选择文本
        </Button>
      </div>

      {/* 语速选择 */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">语速：</span>
        <div className="flex gap-2">
          {SPEEDS.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={speed === s ? "default" : "outline"}
              onClick={() => handleSpeedChange(s)}
            >
              {s}x
            </Button>
          ))}
        </div>
      </div>

      {/* 句子列表 */}
      <Card>
        <CardContent className="p-4 max-h-[400px] overflow-y-auto space-y-2">
          {sentences.map((s) => (
            <button
              key={s.text.slice(0, 50)}
              type="button"
              className={`flex items-start gap-3 p-3 rounded-md transition-colors cursor-pointer w-full text-left ${
                i === currentIndex ? "bg-primary/10 border border-primary/20" : "hover:bg-muted/50"
              }`}
              onClick={() => handlePlayOne(i)}
            >
              <span className="flex-shrink-0 h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground mt-0.5">
                {i + 1}
              </span>
              <p className="text-sm leading-relaxed flex-1">{s}</p>
              {i === currentIndex && (loading || playing) && (
                <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0 mt-1" />
              )}
            </button>
          ))}
        </CardContent>
      </Card>

      {/* 底部控制栏 */}
      <div className="flex items-center justify-center gap-4">
        <Button variant="outline" size="icon" onClick={handlePrev} disabled={currentIndex <= 0}>
          <SkipBack className="h-4 w-4" />
        </Button>

        <Button
          size="lg"
          className="h-12 w-12 rounded-full"
          onClick={handlePlay}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : playing ? (
            <Pause className="h-5 w-5" />
          ) : (
            <Play className="h-5 w-5 ml-0.5" />
          )}
        </Button>

        <Button
          variant="outline"
          size="icon"
          onClick={handleNext}
          disabled={currentIndex >= sentences.length - 1}
        >
          <SkipForward className="h-4 w-4" />
        </Button>

        <Button variant="outline" size="icon" onClick={handleStop}>
          <Square className="h-4 w-4" />
        </Button>

        <Button
          variant={loopMode !== "none" ? "default" : "outline"}
          size="icon"
          onClick={cycleLoopMode}
          title={loopMode === "none" ? "不循环" : loopMode === "single" ? "单句循环" : "全文循环"}
        >
          <LoopIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
