/**
 * 麦克风录音 hook —— 封装 MediaRecorder API。
 *
 * 提供 start/stop 控制和 recording/loading/error 状态。
 * 录音完成后返回 Blob（webm 格式）。
 */

import { useCallback, useRef, useState } from "react";

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

export function useRecording(): UseRecordingReturn {
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.start();
      setRecording(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "无法访问麦克风";
      setError(msg);
    }
  }, []);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const mediaRecorder = mediaRecorderRef.current;
    if (!mediaRecorder || mediaRecorder.state === "inactive") return null;

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
