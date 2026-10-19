/**
 * 语音模型设置卡片 —— 合并管理 TTS 和 ASR 的公共配置及私有配置。
 *
 * 自行管理 voice reducer 状态（10 个字段）、useRecording hook、
 * TTS 试听和 ASR 录音测试逻辑。仅通过 onError 向父级报告错误。
 */

import { Eye, EyeOff, Loader2, Volume2 } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useRecording } from "@/hooks/use-recording";
import { getASRModel, getTTSConfig, setASRModel } from "@/lib/db";
import { getErrorMessage } from "@/lib/error-utils";
import { convertToWav, transcribeAudio } from "@/services/asr";
import { saveTTSSettings, speakTestText } from "@/services/tts";
import { MIMO_VOICES, VOICE_INITIAL_STATE, voiceReducer } from "./voice-reducer";

/** VoiceCard 组件属性 */
interface VoiceCardProps {
  /** 错误回调，用于将卡片内错误传递给父级 ErrorBanner 显示 */
  onError?: (msg: string) => void;
}

export function VoiceCard({ onError }: VoiceCardProps) {
  const [voiceState, dispatch] = useReducer(voiceReducer, VOICE_INITIAL_STATE);
  const {
    form: voiceForm,
    editing: editingVoice,
    saved: savedVoice,
    hasApiKey,
    apiKeyDirty,
    ttsTesting,
    ttsTestError,
    asrTesting,
    asrTestResult,
    saveMsg: voiceSaveMsg,
  } = voiceState;

  // Dispatch wrapper aliases for readability
  const setVoiceForm = (patch: Partial<typeof voiceForm>) => dispatch({ type: "SET_FORM", patch });
  const setEditingVoice = (editing: boolean) => dispatch({ type: "SET_EDITING", editing });
  const setSavedVoice = (saved: typeof savedVoice) => dispatch({ type: "SET_SAVED", saved });
  const setHasApiKey = (v: boolean) => dispatch({ type: "SET_HAS_API_KEY", hasApiKey: v });
  const setApiKeyDirty = (v: boolean) => dispatch({ type: "SET_API_KEY_DIRTY", dirty: v });
  const setTtsTesting = (v: boolean) => dispatch({ type: "SET_TTS_TESTING", testing: v });
  const setTtsTestError = (v: string | null) => dispatch({ type: "SET_TTS_TEST_ERROR", error: v });
  const setAsrTesting = (v: boolean) => dispatch({ type: "SET_ASR_TESTING", testing: v });
  const setAsrTestResult = (v: typeof asrTestResult) =>
    dispatch({ type: "SET_ASR_TEST_RESULT", result: v });
  const setVoiceSaveMsg = (v: typeof voiceSaveMsg) => dispatch({ type: "SET_SAVE_MSG", msg: v });

  const {
    recording: asrRecording,
    error: asrMicError,
    start: asrStart,
    stop: asrStop,
  } = useRecording();
  // 桌面应用：编辑时默认明文显示 API Key，方便用户确认
  const [showApiKeyDisplay, setShowApiKeyDisplay] = useState(true);

  // 显式方言字段（settings.tts_dialect）：不再用 model 前缀猜测协议形状
  const isMimoTTS = voiceForm.dialect !== "openai";

  // 试听请求的中止控制器：开始新试听前先中止上一次（重复触发/配置变更后
  // 重试），卸载时中止在途请求——否则一次挂起的试听会随旧配置继续合成并播放
  const testAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => testAbortRef.current?.abort();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch from useReducer is referentially stable; setVoiceForm wraps it so the wrapper doesn't need to be in deps
  useEffect(() => {
    if (isMimoTTS && !MIMO_VOICES.some((v) => v.value === voiceForm.voice)) {
      setVoiceForm({ voice: "冰糖" });
    } else if (!isMimoTTS && MIMO_VOICES.some((v) => v.value === voiceForm.voice)) {
      setVoiceForm({ voice: "alloy" });
    }
  }, [isMimoTTS, voiceForm.voice]);

  // Load voice config on mount
  useEffect(() => {
    Promise.all([getTTSConfig(), getASRModel()])
      .then(([cfg, asr]) => {
        dispatch({
          type: "LOAD",
          form: {
            baseUrl: cfg.base_url,
            apiKey: cfg.api_key, // 预填真实 Key，编辑时可见
            ttsModel: cfg.model,
            voice: cfg.voice,
            speed: String(cfg.speed),
            asrModel: asr,
            dialect: cfg.dialect || "mimo",
          },
          saved: {
            base_url: cfg.base_url,
            api_key: cfg.api_key,
            tts_model: cfg.model,
            voice: cfg.voice,
            speed: cfg.speed,
            asr_model: asr,
            dialect: cfg.dialect || "mimo",
          },
          hasApiKey: !!cfg.api_key,
        });
      })
      .catch((err) => console.warn("load voice config failed", err));
  }, []);

  async function handleSave() {
    const clampedSpeed = Math.min(4.0, Math.max(0.25, parseFloat(voiceForm.speed) || 1.0));
    setVoiceSaveMsg(null);
    try {
      const entries: Array<[string, string]> = [
        ["tts_base_url", voiceForm.baseUrl],
        ["tts_model", voiceForm.ttsModel],
        ["tts_voice", voiceForm.voice],
        ["tts_speed", String(clampedSpeed)],
        ["tts_dialect", voiceForm.dialect],
      ];
      // apiKeyDirty 时空串也推送：Rust 侧对空串执行"显式清除"（删除 Keychain
      // 条目），与试听路径"清空即拦截"语义一致。若沿用旧的 `&& voiceForm.apiKey`
      // 守卫，清空保存会提示成功但旧 Key 仍留在 Keychain 里继续生效
      if (apiKeyDirty) {
        entries.push(["tts_api_key", voiceForm.apiKey.trim()]);
      }
      await Promise.all([saveTTSSettings(entries), setASRModel(voiceForm.asrModel)]);
      const effectiveApiKey = apiKeyDirty ? voiceForm.apiKey : (savedVoice?.api_key ?? "");
      setVoiceSaveMsg({ type: "ok", text: "保存成功" });
      setEditingVoice(false);
      setHasApiKey(!!effectiveApiKey);
      setApiKeyDirty(false);
      setShowApiKeyDisplay(false);
      setSavedVoice({
        base_url: voiceForm.baseUrl,
        api_key: effectiveApiKey,
        tts_model: voiceForm.ttsModel,
        voice: voiceForm.voice,
        speed: clampedSpeed,
        asr_model: voiceForm.asrModel,
        dialect: voiceForm.dialect,
      });
    } catch (err) {
      const errMsg = `保存失败：${getErrorMessage(err)}`;
      setVoiceSaveMsg({ type: "err", text: errMsg });
      onError?.(errMsg);
    }
  }

  async function handleTestTTS() {
    // B-2: 试听必须用表单**未保存的** base_url（验证新配置），走 test_tts_audio
    // 命令（服务端经私网段 SSRF 校验）。api_key 按三分支处理：
    // a) dirty 且已清空 → 用户编辑态明确移除 Key，直接报错拦截：此刻旧 Key 仍在
    //    Keychain（清空要到保存时才真正删除条目），若放行会传空串、服务端回退
    //    Keychain 自读到**旧** Key，试听"成功"与用户清空 Key 的意图相反；
    // b) 非 dirty 且无已存 Key → 服务端自读也拿不到 Key，提前报错拦截；
    // c) 其余情况放行：dirty 且非空 → 传表单新输入 Key；非 dirty → 传
    //    undefined，由服务端从 OS Keychain 自读已保存 Key。
    // 注：与保存路径语义对齐——保存时推送空串 tts_api_key 即显式删除 Keychain
    // 条目（见 handleSave），此后运行时 TTS 与试听均报"未配置 Key"。
    if (apiKeyDirty && !voiceForm.apiKey.trim()) {
      setTtsTestError("请先填写 API Key");
      return;
    }
    if (!apiKeyDirty && !savedVoice?.api_key) {
      setTtsTestError("请先填写 API Key");
      return;
    }
    const config = {
      base_url: voiceForm.baseUrl,
      api_key: apiKeyDirty ? voiceForm.apiKey : undefined,
      model: voiceForm.ttsModel,
      voice: voiceForm.voice,
      speed: Math.min(4.0, Math.max(0.25, parseFloat(voiceForm.speed) || 1.0)),
    };
    // 中止上一次试听并登记本轮控制器：signal 贯穿合成与播放两个阶段
    testAbortRef.current?.abort();
    const controller = new AbortController();
    testAbortRef.current = controller;
    setTtsTesting(true);
    setTtsTestError(null);
    try {
      await speakTestText("Hello, this is a test.", config, controller.signal);
    } catch (err) {
      // AbortError 静默：被新一轮试听/卸载取代不是失败，不显示错误提示
      if ((err as { name?: string } | null)?.name === "AbortError") return;
      const msg = getErrorMessage(err, String(err));
      setTtsTestError(`TTS 测试失败：${msg}`);
      onError?.(`TTS 测试失败：${msg}`);
    } finally {
      // 只清理仍属本轮 controller 的状态：旧请求迟到收尾时不得复位新请求
      if (testAbortRef.current === controller) {
        setTtsTesting(false);
      }
    }
  }

  async function handleTestASR() {
    setAsrTestResult(null);
    if (asrRecording) {
      setAsrTesting(true);
      try {
        const blob = await asrStop();
        if (!blob || blob.size === 0) {
          setAsrTestResult({ type: "err", text: "录音为空" });
          return;
        }
        const wav = await convertToWav(blob);
        const text = await transcribeAudio(wav, "en", voiceForm.asrModel);
        setAsrTestResult({ type: "ok", text: `识别结果：${text}` });
      } catch (err) {
        const errMsg = `测试失败：${getErrorMessage(err)}`;
        setAsrTestResult({ type: "err", text: errMsg });
        onError?.(`ASR ${errMsg}`);
      } finally {
        setAsrTesting(false);
      }
    } else {
      try {
        await asrStart();
      } catch (err) {
        const errMsg = `无法录音：${getErrorMessage(err)}`;
        setAsrTestResult({ type: "err", text: errMsg });
        onError?.(`ASR ${errMsg}`);
      }
    }
  }

  function handleCancel() {
    dispatch({ type: "RESET_FORM_TO_SAVED" });
    setShowApiKeyDisplay(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>语音模型设置</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 已保存配置概览 */}
        {savedVoice && hasApiKey && !editingVoice && (
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
              <div>
                <p className="text-sm text-muted-foreground">{savedVoice.base_url}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  API Key: {savedVoice.api_key.slice(0, 3)}
                  {"*".repeat(Math.max(0, savedVoice.api_key.length - 6))}
                  {savedVoice.api_key.slice(-3)}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    TTS
                  </span>
                  <span className="font-medium">{savedVoice.tts_model}</span>
                  <span className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded">
                    {savedVoice.voice}
                  </span>
                  <span className="text-xs text-muted-foreground">x{savedVoice.speed}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    ASR
                  </span>
                  <span className="font-medium">{savedVoice.asr_model}</span>
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditingVoice(true)}>
              编辑
            </Button>
          </div>
        )}

        {/* 编辑表单 */}
        {(!savedVoice || !hasApiKey || editingVoice) && (
          <>
            <div className="space-y-1">
              <label htmlFor="tts-api-url" className="text-sm font-medium">
                API URL
              </label>
              <Input
                id="tts-api-url"
                placeholder="如 https://api.xiaomimimo.com/v1"
                value={voiceForm.baseUrl}
                onChange={(e) => setVoiceForm({ baseUrl: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                标准 TTS 填写根路径即可（自动补全 /audio/speech）。Chat Completions
                模式需填写完整路径。
              </p>
            </div>
            <div className="space-y-1">
              <label htmlFor="tts-api-key" className="text-sm font-medium">
                API Key
              </label>
              <div className="relative">
                <Input
                  id="tts-api-key"
                  placeholder="输入 API Key"
                  type={showApiKeyDisplay ? "text" : "password"}
                  value={voiceForm.apiKey}
                  onChange={(e) => {
                    setVoiceForm({ apiKey: e.target.value });
                    setApiKeyDirty(true);
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-9 w-9"
                  onClick={() => setShowApiKeyDisplay(!showApiKeyDisplay)}
                >
                  {showApiKeyDisplay ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="pt-2 border-t">
              <p className="text-sm font-medium mb-3">TTS 模型</p>
              <div className="space-y-3">
                <Input
                  placeholder="模型名称（如 mimo-v2.5-tts、tts-1）"
                  value={voiceForm.ttsModel}
                  onChange={(e) => setVoiceForm({ ttsModel: e.target.value })}
                />
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label htmlFor="tts-voice" className="text-sm text-muted-foreground">
                      音色
                    </label>
                    {isMimoTTS ? (
                      <select
                        id="tts-voice"
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                        value={voiceForm.voice}
                        onChange={(e) => setVoiceForm({ voice: e.target.value })}
                      >
                        {MIMO_VOICES.map((v) => (
                          <option key={v.value} value={v.value}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        id="tts-voice"
                        placeholder="冰糖 / 茉莉 / Mia（MiMo）"
                        value={voiceForm.voice}
                        onChange={(e) => setVoiceForm({ voice: e.target.value })}
                      />
                    )}
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="tts-speed" className="text-sm text-muted-foreground">
                      语速 (0.25-4.0)
                    </label>
                    <Input
                      id="tts-speed"
                      type="number"
                      min="0.25"
                      max="4.0"
                      step="0.25"
                      value={voiceForm.speed}
                      onChange={(e) => setVoiceForm({ speed: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t">
              <p className="text-sm font-medium mb-3">ASR 模型</p>
              <div className="space-y-1">
                <Input
                  placeholder="模型名称（如 mimo-v2.5-asr）"
                  value={voiceForm.asrModel}
                  onChange={(e) => setVoiceForm({ asrModel: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  用于口语练习和听力练习的语音识别，复用上方公共 API URL 和 API Key。
                </p>
              </div>
            </div>

            <div className="flex gap-2 items-center flex-wrap">
              <Button onClick={handleSave}>保存设置</Button>
              <Button variant="outline" onClick={handleTestTTS} disabled={ttsTesting}>
                {ttsTesting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Volume2 className="h-4 w-4 mr-2" />
                )}
                测试 TTS
              </Button>
              <Button variant="outline" disabled={asrTesting} onClick={handleTestASR}>
                {asrRecording ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    停止录音
                  </>
                ) : asrTesting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    识别中...
                  </>
                ) : (
                  "测试 ASR"
                )}
              </Button>
              {savedVoice && hasApiKey && (
                <Button variant="ghost" onClick={handleCancel}>
                  取消
                </Button>
              )}
              {voiceSaveMsg && (
                <span
                  className={`text-sm ${voiceSaveMsg.type === "ok" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                >
                  {voiceSaveMsg.text}
                </span>
              )}
              {ttsTestError && (
                <span className="text-sm text-red-600 dark:text-red-400">{ttsTestError}</span>
              )}
            </div>
            {asrMicError && (
              <p className="text-sm text-red-600 dark:text-red-400">麦克风错误：{asrMicError}</p>
            )}
            {asrTestResult && (
              <p
                className={`text-sm ${asrTestResult.type === "ok" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {asrTestResult.text}
              </p>
            )}
            {asrRecording && (
              <p className="text-sm text-blue-600 dark:text-blue-400 animate-pulse">
                正在录音，请说英文...
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
