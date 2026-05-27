import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Gauge,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Square,
  Loader2,
  Repeat,
  Repeat1,
} from "lucide-react";
import { getTTSConfig } from "@/lib/db";
import { speakText } from "@/services/tts";
import { splitSentences } from "@/lib/parse-utils";
import type { TTSConfig } from "@/types";

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5] as const;
type LoopMode = "none" | "single" | "all";

export default function SpeedTrainerPage() {
  const [input, setInput] = useState("");
  const [sentences, setSentences] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [speed, setSpeed] = useState(1.0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loopMode, setLoopMode] = useState<LoopMode>("none");
  const playAbortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);

  function handleStart() {
    const trimmed = input.trim();
    if (!trimmed) return;
    const s = splitSentences(trimmed);
    if (s.length === 0) return;
    setSentences(s);
    setCurrentIndex(0);
    setPlaying(false);
    playAbortRef.current?.abort();
  }

  const playSentence = useCallback(
    async (index: number, cfg: TTSConfig, spd: number, signal?: AbortSignal) => {
      if (index < 0 || index >= sentences.length) return;
      setCurrentIndex(index);
      setLoading(true);
      try {
        await speakText(sentences[index], { ...cfg, speed: spd }, signal);
      } catch {
        // abort or error
      } finally {
        setLoading(false);
      }
    },
    [sentences]
  );

  const playFrom = useCallback(
    async (startIndex: number) => {
      playAbortRef.current?.abort();
      const controller = new AbortController();
      playAbortRef.current = controller;
      stoppedRef.current = false;

      const config = await getTTSConfig();
      if (!config.api_key) return;

      setPlaying(true);

      let i = startIndex;
      while (i < sentences.length && !stoppedRef.current && !controller.signal.aborted) {
        await playSentence(i, config, speed, controller.signal);
        if (stoppedRef.current || controller.signal.aborted) break;

        if (loopMode === "single") {
          // stay on same index, replay
          continue;
        } else {
          i++;
          if (i >= sentences.length && loopMode === "all") {
            i = 0;
          }
        }
      }

      setPlaying(false);
    },
    [sentences, speed, loopMode, playSentence]
  );

  function handlePlay() {
    if (playing) {
      playAbortRef.current?.abort();
      stoppedRef.current = true;
      setPlaying(false);
      return;
    }
    const startIdx = currentIndex >= 0 ? currentIndex : 0;
    playFrom(startIdx);
  }

  function handleStop() {
    playAbortRef.current?.abort();
    stoppedRef.current = true;
    setPlaying(false);
    setCurrentIndex(-1);
  }

  function handlePrev() {
    if (currentIndex > 0) {
      const newIdx = currentIndex - 1;
      setCurrentIndex(newIdx);
      if (playing) {
        playAbortRef.current?.abort();
        stoppedRef.current = true;
        setPlaying(false);
        setTimeout(() => playFrom(newIdx), 100);
      }
    }
  }

  function handleNext() {
    if (currentIndex < sentences.length - 1) {
      const newIdx = currentIndex + 1;
      setCurrentIndex(newIdx);
      if (playing) {
        playAbortRef.current?.abort();
        stoppedRef.current = true;
        setPlaying(false);
        setTimeout(() => playFrom(newIdx), 100);
      }
    }
  }

  function handleSpeedChange(newSpeed: number) {
    setSpeed(newSpeed);
    if (playing) {
      playAbortRef.current?.abort();
      stoppedRef.current = true;
      setPlaying(false);
      setTimeout(() => playFrom(currentIndex), 100);
    }
  }

  function handlePlayOne(index: number) {
    playAbortRef.current?.abort();
    stoppedRef.current = true;
    setPlaying(false);
    const controller = new AbortController();
    playAbortRef.current = controller;
    getTTSConfig().then((config) => {
      if (!config.api_key) return;
      setPlaying(true);
      playSentence(index, config, speed, controller.signal).finally(() =>
        setPlaying(false)
      );
    });
  }

  function cycleLoopMode() {
    const modes: LoopMode[] = ["none", "single", "all"];
    const idx = modes.indexOf(loopMode);
    setLoopMode(modes[(idx + 1) % modes.length]);
  }

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
                <p className="text-sm text-muted-foreground">
                  系统会拆分为句子，支持五档语速播放
                </p>
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
            playAbortRef.current?.abort();
            stoppedRef.current = true;
            setPlaying(false);
            setSentences([]);
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
          {sentences.map((s, i) => (
            <div
              key={i}
              className={`flex items-start gap-3 p-3 rounded-md transition-colors cursor-pointer ${
                i === currentIndex
                  ? "bg-primary/10 border border-primary/20"
                  : "hover:bg-muted/50"
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
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 底部控制栏 */}
      <div className="flex items-center justify-center gap-4">
        <Button
          variant="outline"
          size="icon"
          onClick={handlePrev}
          disabled={currentIndex <= 0}
        >
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
          title={
            loopMode === "none"
              ? "不循环"
              : loopMode === "single"
                ? "单句循环"
                : "全文循环"
          }
        >
          <LoopIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
