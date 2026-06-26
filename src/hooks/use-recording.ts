/**
 * 麦克风录音 hook —— 封装 MediaRecorder API。
 *
 * 提供 start/stop 控制和 recording/loading/error 状态。
 * 录音完成后返回 Blob（webm 格式）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface UseRecordingOptions {
  /** 最大录音时长（毫秒），超时自动停止。默认 60_000（60 秒） */
  maxDurationMs?: number;
}

interface UseRecordingReturn {
  /** 是否正在录音 */
  recording: boolean;
  /** 是否正在处理（等待录音数据） */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 开始录音 */
  start: () => Promise<void>;
  /** 停止录音，返回音频 Blob */
  stop: () => Promise<Blob | null>;
}

/**
 * 选择浏览器支持的音频录制 MIME 类型。
 * 优先 webm/opus，回退到 mp4，最终回退到浏览器默认（空字符串）。
 */
function pickSupportedMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function useRecording(options?: UseRecordingOptions): UseRecordingReturn {
  const { maxDurationMs = 60_000 } = options ?? {};
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // O2: 超时自动停止计时器
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 使用 ref 保存 maxDurationMs，避免 start 回调依赖变化导致频繁重建
  const maxDurationMsRef = useRef(maxDurationMs);
  maxDurationMsRef.current = maxDurationMs;

  // H1: 组件卸载时释放麦克风和 MediaRecorder，防止资源泄漏
  useEffect(() => {
    return () => {
      if (maxDurationTimerRef.current) {
        clearTimeout(maxDurationTimerRef.current);
        maxDurationTimerRef.current = null;
      }
      const recorder = mediaRecorderRef.current;
      const stream = streamRef.current;
      if (recorder && recorder.state === "recording") {
        recorder.stop();
      }
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
      }
      mediaRecorderRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    // 重入保护：若上一次录音仍在进行（例如用户在 getUserMedia await 期间快速双击），
    // 先清理旧 recorder / stream / timer，避免资源泄漏与孤立定时器停止错误录音器
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    const prevRecorder = mediaRecorderRef.current;
    if (prevRecorder && prevRecorder.state === "recording") {
      prevRecorder.stop();
    }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;

    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = pickSupportedMimeType();

      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.start();
      setRecording(true);

      // O2: 超时自动停止，防止用户忘记停止录音导致麦克风长期占用
      // 问题 4: auto-stop 触发时 onstop 处理器尚未赋值，会导致 chunks 永不组装、
      // recording 状态卡住为 true。这里在触发 stop 前注册一次性 onstop 处理器，
      // 复用 stop() 的清理逻辑：释放麦克风、清空 ref、重置状态。
      // 注意：若用户在 auto-stop 触发前点击 stop()，stop() 会先 clearTimeout 本计时器；
      // 若 auto-stop 先触发，之后用户调用 stop() 时 recorder.state 已为 "inactive"，
      // stop() 会直接 return null，不会覆盖此处注册的 onstop。
      maxDurationTimerRef.current = setTimeout(() => {
        const recorder = mediaRecorderRef.current;
        // biome-ignore lint/complexity/useOptionalChain: 需要 null 检查以收窄类型，使后续 recorder.onstop 可访问
        if (!recorder || recorder.state !== "recording") return;
        recorder.onstop = () => {
          // 释放麦克风轨道
          if (streamRef.current) {
            for (const t of streamRef.current.getTracks()) t.stop();
            streamRef.current = null;
          }
          mediaRecorderRef.current = null;
          setRecording(false);
          setLoading(false);
          // chunksRef 保留，下次 start 会清空（无人 await auto-stop 的 Blob）
        };
        recorder.stop();
      }, maxDurationMsRef.current);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "无法访问麦克风";
      setError(msg);
    }
  }, []);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const mediaRecorder = mediaRecorderRef.current;
    if (!mediaRecorder || mediaRecorder.state === "inactive") return null;

    // O2: 清除超时计时器
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }

    setLoading(true);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Fallback: resolve with whatever chunks exist after 5 seconds
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
        chunksRef.current = [];

        if (streamRef.current) {
          for (const track of streamRef.current.getTracks()) {
            track.stop();
          }
          streamRef.current = null;
        }

        setRecording(false);
        setLoading(false);
        mediaRecorderRef.current = null;
        resolve(blob);
      }, 5000);

      mediaRecorder.onstop = () => {
        clearTimeout(timeout);
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType });
        chunksRef.current = [];

        // 停止所有音频轨道，释放麦克风
        if (streamRef.current) {
          for (const track of streamRef.current.getTracks()) {
            track.stop();
          }
          streamRef.current = null;
        }

        setRecording(false);
        setLoading(false);
        mediaRecorderRef.current = null;
        resolve(blob);
      };

      mediaRecorder.stop();
    });
  }, []);

  return { recording, loading, error, start, stop };
}
