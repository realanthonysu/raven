/**
 * ASR 服务层 —— 封装语音识别 API 调用。
 *
 * 使用 mimo-v2.5-asr 模型，通过 Chat Completions 接口实现语音转文字。
 * 复用 TTS 配置中的 base_url 和 api_key（同一 mimo 平台）。
 *
 * 官方文档：https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition
 */

import { getASRModel, getTTSConfigCached } from "@/lib/db";
import { smartFetch } from "@/lib/fetch-utils";

/**
 * 将 AudioBuffer 转为 WAV 格式的 Blob。
 * mimo ASR 仅支持 wav 和 mp3，浏览器 MediaRecorder 通常输出 webm，
 * 因此需要通过 AudioContext 解码后重新编码为 WAV。
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const samples = buffer.getChannelData(0);
  const dataLength = samples.length * (bitDepth / 8);
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  view.setUint16(32, numChannels * (bitDepth / 8), true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // PCM samples
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * 将音频 Blob（任意格式）转为 WAV Blob。
 * 通过 AudioContext 解码后重新编码，确保输出为 16-bit PCM WAV。
 */
export async function convertToWav(audioBlob: Blob): Promise<Blob> {
  const audioContext = new AudioContext();
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBufferToWav(audioBuffer);
  } finally {
    await audioContext.close();
  }
}

/**
 * 将音频 Blob 转为 data:audio/wav;base64,... 格式。
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * 调用 ASR API 将音频转写为文本。
 *
 * 使用 mimo-v2.5-asr 模型，请求格式：
 * {
 *   "model": "mimo-v2.5-asr",
 *   "messages": [{ "role": "user", "content": [{ "type": "input_audio", "input_audio": { "data": "data:audio/wav;base64,..." } }] }]
 * }
 *
 * @param audioBlob - 录音音频数据（应为 WAV 格式）
 * @param language - 识别语言，"en" / "zh" / "auto"
 * @returns 转写后的文本
 */
export async function transcribeAudio(
  audioBlob: Blob,
  language = "en",
  modelOverride?: string,
): Promise<string> {
  const config = await getTTSConfigCached();
  const asrModel = modelOverride || (await getASRModel());
  const dataUrl = await blobToDataUrl(audioBlob);

  const base = config.base_url.replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;

  const body = JSON.stringify({
    model: asrModel,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: dataUrl },
          },
        ],
      },
    ],
    asr_options: { language },
  });

  const response = await smartFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_key}`,
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error(`ASR error: ${response.status} ${errText}`);
    throw new Error(`语音识别服务请求失败 (${response.status})`);
  }

  const json = await response.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text) {
    throw new Error("ASR 响应中未包含转写文本");
  }
  return cleanASROutput(text);
}

/**
 * 清理 ASR 模型输出中的非转写内容。
 * mimo ASR 可能返回思考过程标签（<think>、<chinese> 等），
 * 需要提取实际的转写文本。
 */
function cleanASROutput(text: string): string {
  let cleaned = text.trim();
  // 移除 <think>...</think> 块
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // 移除 <chinese>...</chinese> 块
  cleaned = cleaned.replace(/<chinese>[\s\S]*?<\/chinese>/gi, "");
  // 移除剩余的 XML 标签（如孤立的 <chinese>、</chinese>）
  cleaned = cleaned.replace(/<\/?[a-z][^>]*>/gi, "");
  return cleaned.trim();
}
