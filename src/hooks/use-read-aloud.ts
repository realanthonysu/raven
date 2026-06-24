/**
 * useReadAloud —— 封装朗读功能的编排逻辑。
 *
 * 将 ReadingPage 中的朗读编排（句子分割 → 逐句播放 → 高亮当前句 → 取消）
 * 封装为独立 hook，减少 ReadingPage 的关注点。
 */
import { useCallback, useState } from "react";
import { useAbortable } from "@/hooks/use-abortable";
import { useAudioPlayer } from "@/hooks/use-audio-player";
import { splitSentences } from "@/lib/parse-utils";

export function useReadAloud(text: string) {
  const [readAloudActive, setReadAloudActive] = useState(false);
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(-1);
  const { abort, getSignal } = useAbortable();

  const { play, stop } = useAudioPlayer();

  const startReadAloud = useCallback(async () => {
    // 中止旧请求并获取新 signal（useAbortable 内部管理生命周期）
    abort();
    const signal = getSignal();

    const sentences = splitSentences(text);
    if (sentences.length === 0) return;

    setReadAloudActive(true);
    setCurrentSentenceIndex(0);

    for (let i = 0; i < sentences.length; i++) {
      if (signal.aborted) break;
      setCurrentSentenceIndex(i);
      const success = await play(sentences[i]);
      if (!success) break;
    }

    if (!signal.aborted) {
      setReadAloudActive(false);
      setCurrentSentenceIndex(-1);
    }
  }, [text, play, abort, getSignal]);

  /**
   * 停止朗读并重置状态。
   * 中止当前播放流程（abort）、停止音频播放、重置激活状态和句子索引。
   * ReadingPage 在提交新分析请求时也会调用此函数取消正在进行的朗读。
   */
  const stopReadAloud = useCallback(() => {
    abort();
    stop();
    setReadAloudActive(false);
    setCurrentSentenceIndex(-1);
  }, [abort, stop]);

  return {
    readAloudActive,
    currentSentenceIndex,
    startReadAloud,
    stopReadAloud,
  };
}
