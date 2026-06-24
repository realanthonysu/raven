import { save } from "@tauri-apps/plugin-dialog";
import { Bell, Database, Loader2, Minus, Plus, Trash2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useRecording } from "@/hooks/use-recording";
import {
  addModel,
  backupDatabase,
  deleteModel,
  getASRModel,
  getLearningGoals,
  getModels,
  getSetting,
  getTTSConfig,
  setASRModel,
  setDefaultModel,
  setLearningGoal,
  setSetting,
  setTTSSettingBatch,
  updateModel,
} from "@/lib/db";
import { convertToWav, transcribeAudio } from "@/services/asr";
import { speakText } from "@/services/tts";
import type { ModelConfig, TTSConfig } from "@/types";

/**
 * 设置页面组件
 *
 * 提供四大配置区域：
 * 1. LLM 模型配置 — 管理多个 OpenAI 兼容 API 的模型连接（名称、API Key、Base URL、模型名），
 *    支持添加/删除/设为默认。默认模型会被所有 LLM 页面（写作、阅读、练习、听力）使用。
 * 2. TTS 模型设置 — 配置文本转语音服务的 API 地址、密钥、音色和语速，支持试听。
 * 3. 学习目标 — 设置每日学习目标（复习、练习、阅读、写作、听力），支持预设方案和自定义调整。
 * 4. 通知设置 — 控制每日复习提醒通知的开关，启用后应用启动时会检查待复习词汇并发送系统通知。
 */
export default function SettingsPage() {
  /** 已保存的模型配置列表，从 SQLite models 表加载 */
  const [models, setModels] = useState<ModelConfig[]>([]);

  /**
   * 新增模型的表单状态
   * - name: 用户自定义的配置名称（如 "Qwen"、"GPT-4"），用于界面展示
   * - apiKey: 对应 LLM 服务的 API 密钥
   * - baseUrl: API 基础地址，默认 OpenAI；兼容其他 OpenAI 格式的服务（如 Azure、通义千问）
   * - modelName: 实际调用时使用的模型标识符（如 "qwen-plus"、"gpt-4o"）
   */
  const [form, setForm] = useState({
    name: "",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    modelName: "",
  });

  /** 正在编辑的模型 ID（null 表示非编辑模式） */
  const [editingModelId, setEditingModelId] = useState<number | null>(null);
  /** 是否显示添加模型表单 */
  const [showModelForm, setShowModelForm] = useState(false);

  /**
   * TTS 模型设置的表单状态
   * - baseUrl: TTS API 地址，默认 OpenAI TTS 端点
   * - apiKey: TTS 服务的 API 密钥（可与 LLM 使用不同的密钥/服务）
   * - voice: 音色名称（OpenAI 支持 alloy/echo/fable/onyx/nova/shimmer）
   * - speed: 语速，字符串类型以便 Input 双向绑定，保存时转为数字并做范围限制
   */
  const [ttsForm, setTtsForm] = useState({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "tts-1",
    voice: "alloy",
    speed: "1.0",
  });

  /** TTS 测试播放中的加载状态，用于禁用按钮并显示旋转图标 */
  const [ttsTesting, setTtsTesting] = useState(false);
  /** TTS 测试失败时的错误信息（BUG-04d 修复：之前静默失败） */
  const [ttsTestError, setTtsTestError] = useState<string | null>(null);
  /** TTS 保存结果提示 */
  const [ttsSaveMsg, setTtsSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  /** 当前已保存的 TTS 配置（用于展示） */
  const [savedTts, setSavedTts] = useState<TTSConfig | null>(null);
  /** TTS 编辑模式：有已保存配置时默认折叠表单，点击编辑展开 */
  const [editingTts, setEditingTts] = useState(false);
  /** ASR 模型名称 */
  const [asrModel, setAsrModelState] = useState("mimo-v2.5-asr");
  const [asrSaveMsg, setAsrSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  /** ASR 测试状态 */
  const [asrTesting, setAsrTesting] = useState(false);
  const [asrTestResult, setAsrTestResult] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );
  const {
    recording: asrRecording,
    error: asrMicError,
    start: asrStart,
    stop: asrStop,
  } = useRecording();

  /** mimo TTS 预置音色 */
  const mimoVoices = [
    { value: "冰糖", label: "冰糖（中文女声）" },
    { value: "茉莉", label: "茉莉（中文女声）" },
    { value: "苏打", label: "苏打（中文男声）" },
    { value: "白桦", label: "白桦（中文男声）" },
    { value: "Mia", label: "Mia（英文女声）" },
    { value: "Chloe", label: "Chloe（英文女声）" },
    { value: "Milo", label: "Milo（英文男声）" },
    { value: "Dean", label: "Dean（英文男声）" },
  ];

  /** 当前模型是否为 mimo TTS */
  const isMimoTTS = ttsForm.model.startsWith("mimo");

  /** 切换 mimo/非 mimo 模型时自动重置音色 */
  useEffect(() => {
    if (isMimoTTS && !mimoVoices.some((v) => v.value === ttsForm.voice)) {
      setTtsForm((prev) => ({ ...prev, voice: "冰糖" }));
    } else if (!isMimoTTS && mimoVoices.some((v) => v.value === ttsForm.voice)) {
      setTtsForm((prev) => ({ ...prev, voice: "alloy" }));
    }
  }, [isMimoTTS]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 每日复习提醒开关状态，默认启用 */
  const [notificationEnabled, setNotificationEnabled] = useState(true);

  /** 学习目标：goal_type -> target */
  const [goals, setGoals] = useState<Record<string, number>>({});

  /** 学习目标标签（长版，适配 Settings 详细说明）。Sidebar 使用短版标签。 */
  const goalLabels: Record<string, string> = {
    review: "间隔复习",
    exercise: "弱项训练",
    reading: "阅读精读",
    writing: "写作批改",
    listening: "听力练习",
  };

  /** 数据库备份加载状态 */
  const [backingUp, setBackingUp] = useState(false);

  /** 全局错误提示 */
  const [pageError, setPageError] = useState<string | null>(null);

  /** 预设目标配置 */
  const goalPresets: Record<string, Record<string, number>> = {
    轻松: { review: 5, exercise: 1, reading: 1, writing: 1, listening: 1 },
    标准: { review: 10, exercise: 2, reading: 1, writing: 1, listening: 1 },
    进阶: { review: 20, exercise: 3, reading: 2, writing: 2, listening: 2 },
  };

  /** 页面挂载时从 SQLite 加载已有的模型列表、TTS 配置、通知设置和学习目标 */
  useEffect(() => {
    getModels().then(setModels);
    getTTSConfig().then((cfg) => {
      setTtsForm({
        baseUrl: cfg.base_url,
        apiKey: cfg.api_key,
        model: cfg.model,
        voice: cfg.voice,
        speed: String(cfg.speed),
      });
      setSavedTts(cfg);
    });
    getSetting("notification_enabled").then((val) => {
      setNotificationEnabled(val !== "false");
    });
    getLearningGoals().then(setGoals);
    getASRModel().then(setAsrModelState);
  }, []);

  /**
   * 添加新模型配置
   *
   * 校验所有字段非空后写入 SQLite models 表。
   * 若当前没有任何模型，则自动将新增模型设为默认（is_default: true），
   * 保证至少存在一个默认模型供 LLM 页面调用。
   * 添加成功后清空表单并刷新列表。
   */
  async function handleAdd() {
    if (!form.name || !form.apiKey || !form.baseUrl || !form.modelName) return;
    try {
      await addModel({
        name: form.name,
        api_key: form.apiKey,
        base_url: form.baseUrl,
        model_name: form.modelName,
        is_default: models.length === 0,
      });
      setForm({ name: "", apiKey: "", baseUrl: "https://api.openai.com/v1", modelName: "" });
      setShowModelForm(false);
      getModels().then(setModels);
    } catch (err) {
      setPageError(`添加模型失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  /**
   * 删除指定模型配置
   * @param id - 要删除的模型记录 ID
   */
  async function handleDelete(id: number) {
    try {
      await deleteModel(id);
      getModels().then(setModels);
    } catch (err) {
      setPageError(`删除模型失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  /**
   * 将指定模型设为默认
   *
   * 默认模型是所有 LLM 页面（CorrectPage、ReadingPage、ExercisePage、ListeningPage）
   * 通过 getDefaultModel() 获取的活跃模型。设为新默认时，旧默认会被取消。
   * @param id - 要设为默认的模型记录 ID
   */
  async function handleSetDefault(id: number) {
    try {
      await setDefaultModel(id);
      getModels().then(setModels);
    } catch (err) {
      setPageError(`设置默认模型失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  /**
   * 点击编辑按钮：将模型配置填入表单，进入编辑模式
   */
  function handleEditModel(model: ModelConfig) {
    setEditingModelId(model.id);
    setForm({
      name: model.name,
      apiKey: "", // API Key 不回显，留空表示不修改
      baseUrl: model.base_url,
      modelName: model.model_name,
    });
  }

  /**
   * 保存编辑后的模型配置
   */
  async function handleUpdateModel() {
    if (editingModelId === null || !form.name || !form.baseUrl || !form.modelName) return;
    try {
      await updateModel(editingModelId, {
        name: form.name,
        base_url: form.baseUrl,
        model_name: form.modelName,
        api_key: form.apiKey,
      });
      setEditingModelId(null);
      setForm({ name: "", apiKey: "", baseUrl: "https://api.openai.com/v1", modelName: "" });
      getModels().then(setModels);
    } catch (err) {
      setPageError(`更新模型失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  /**
   * 保存 TTS 模型设置到 SQLite settings 表
   *
   * 语速在保存前做范围限制（clamping）：
   * - parseFloat 将字符串转为数字，若解析失败则回退到 1.0
   * - Math.max(0.25, ...) 限制最低 0.25x（OpenAI TTS API 的最低语速）
   * - Math.min(4.0, ...) 限制最高 4.0x（OpenAI TTS API 的最高语速）
   * 四个设置项通过 Promise.all 并行写入，提升保存效率。
   *
   * 注意：设置写入后，db.ts 中的 getTTSConfigCached() 缓存会通过
   * settings 变更事件自动失效，后续 TTS 调用会读取最新配置。
   */
  async function handleSaveTTS() {
    // 语速范围限制：确保在 OpenAI TTS API 允许的 [0.25, 4.0] 区间内
    const clampedSpeed = Math.min(4.0, Math.max(0.25, parseFloat(ttsForm.speed) || 1.0));
    setTtsSaveMsg(null);
    try {
      const entries: Array<[string, string]> = [
        ["tts_base_url", ttsForm.baseUrl],
        ["tts_model", ttsForm.model],
        ["tts_voice", ttsForm.voice],
        ["tts_speed", String(clampedSpeed)],
      ];
      if (ttsForm.apiKey) {
        entries.push(["tts_api_key", ttsForm.apiKey]);
      }
      await setTTSSettingBatch(entries);
      setTtsSaveMsg({ type: "ok", text: "保存成功" });
      setEditingTts(false);
      setSavedTts({
        base_url: ttsForm.baseUrl,
        api_key: ttsForm.apiKey,
        model: ttsForm.model,
        voice: ttsForm.voice,
        speed: clampedSpeed,
      });
    } catch (err) {
      setTtsSaveMsg({
        type: "err",
        text: `保存失败：${err instanceof Error ? err.message : "未知错误"}`,
      });
    }
  }

  /**
   * 测试当前 TTS 配置
   *
   * 使用表单中填写的即时配置（而非数据库中保存的配置）朗读一句固定英文，
   * 方便用户在修改设置后立即试听效果，无需先保存。
   * 若 API Key 为空则显示错误提示，不发起请求。
   * 无论成功或失败，finally 块都会重置 loading 状态。
   * BUG-04d 修复：失败时设置 ttsTestError 显示提示，而非静默忽略。
   */
  async function handleTestTTS() {
    const config: TTSConfig = {
      base_url: ttsForm.baseUrl,
      api_key: ttsForm.apiKey,
      model: ttsForm.model,
      voice: ttsForm.voice,
      speed: Math.min(4.0, Math.max(0.25, parseFloat(ttsForm.speed) || 1.0)),
    };
    if (!config.api_key) {
      setTtsTestError("请先填写 API Key");
      return;
    }
    setTtsTesting(true);
    setTtsTestError(null);
    try {
      await speakText("Hello, this is a test.", config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTtsTestError(`TTS 测试失败：${msg}`);
    } finally {
      setTtsTesting(false);
    }
  }

  /**
   * 切换每日复习提醒通知开关。
   *
   * 切换时立即写入 settings 表，同时更新本地状态。
   * 如果关闭通知，同时清除 last_notification_date，以便重新开启后
   * 下次启动应用时能立即检查并通知。
   */
  async function handleToggleNotification(checked: boolean) {
    const prev = notificationEnabled;
    setNotificationEnabled(checked);
    try {
      await setSetting("notification_enabled", String(checked));
      if (!checked) {
        // 关闭通知时清除通知日期记录，重新开启后下次启动可立即触发
        await setSetting("last_notification_date", "");
      }
    } catch (err) {
      setNotificationEnabled(prev);
      setPageError(`更新通知设置失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  /**
   * 更新单个学习目标，立即写入数据库。
   */
  async function handleUpdateGoal(goalType: string, target: number) {
    const clamped = Math.max(0, target);
    setGoals((prev) => ({ ...prev, [goalType]: clamped }));
    await setLearningGoal(goalType, clamped);
  }

  /**
   * 应用预设目标配置，批量写入数据库。
   */
  async function handleApplyPreset(preset: Record<string, number>) {
    const prev = goals;
    setGoals(preset);
    try {
      await Promise.all(
        Object.entries(preset).map(([type, target]) => setLearningGoal(type, target)),
      );
    } catch (err) {
      setGoals(prev);
      setPageError(`应用预设失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  /**
   * 备份数据库文件。
   * 通过 Tauri dialog 选择保存位置，调用 Rust 端的 SQLite backup API。
   */
  async function handleBackup() {
    const destPath = await save({
      title: "备份数据库",
      defaultPath: `raven-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: "SQLite Database", extensions: ["db"] }],
    });
    if (!destPath) return;

    setBackingUp(true);
    try {
      await backupDatabase(destPath);
      setPageError(null);
    } catch (err) {
      setPageError(`备份失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setBackingUp(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold">设置</h2>
      {pageError && <ErrorBanner message={pageError} />}

      <Card>
        <CardHeader>
          <CardTitle>模型配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 模型列表（有已保存模型且非编辑/添加模式时显示） */}
          {models.length > 0 && editingModelId === null && !showModelForm && (
            <>
              <div className="space-y-3">
                {models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between p-3 border rounded-md"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{model.name}</span>
                        {model.is_default && (
                          <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded">
                            默认
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {model.model_name} · {model.base_url}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleEditModel(model)}
                      >
                        编辑
                      </Button>
                      {!model.is_default && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleSetDefault(model.id)}
                        >
                          设为默认
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(model.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowModelForm(true)}>
                <Plus className="h-4 w-4 mr-1" />
                添加新模型
              </Button>
            </>
          )}

          {/* 编辑/添加表单（无模型、编辑中、或点击添加时显示） */}
          {(models.length === 0 || editingModelId !== null || showModelForm) && (
            <>
              <Input
                placeholder="配置名称（如：Qwen、GPT-4）"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Input
                placeholder={editingModelId !== null ? "API Key（留空则不修改）" : "API Key"}
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
              <Input
                placeholder="Base URL"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
              <Input
                placeholder="模型名称（如：qwen-plus、gpt-4）"
                value={form.modelName}
                onChange={(e) => setForm({ ...form, modelName: e.target.value })}
              />
              <div className="flex gap-2">
                {editingModelId !== null ? (
                  <>
                    <Button onClick={handleUpdateModel}>保存修改</Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditingModelId(null);
                        setForm({
                          name: "",
                          apiKey: "",
                          baseUrl: "https://api.openai.com/v1",
                          modelName: "",
                        });
                      }}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button onClick={handleAdd}>
                      <Plus className="h-4 w-4 mr-2" />
                      添加模型
                    </Button>
                    {models.length > 0 && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setShowModelForm(false);
                          setForm({
                            name: "",
                            apiKey: "",
                            baseUrl: "https://api.openai.com/v1",
                            modelName: "",
                          });
                        }}
                      >
                        取消
                      </Button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>TTS 模型设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 已保存配置概览（非编辑模式时显示） */}
          {savedTts && savedTts.api_key && !editingTts && (
            <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{savedTts.model}</span>
                  <span className="text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded">
                    {savedTts.voice}
                  </span>
                  <span className="text-xs text-muted-foreground">x{savedTts.speed}</span>
                </div>
                <p className="text-sm text-muted-foreground">{savedTts.base_url}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setEditingTts(true)}>
                编辑
              </Button>
            </div>
          )}

          {/* 编辑表单（编辑模式或无已保存配置时显示） */}
          {(!savedTts || !savedTts.api_key || editingTts) && (
            <>
              <div className="space-y-1">
                <Input
                  placeholder="API URL（如 https://api.openai.com/v1）"
                  value={ttsForm.baseUrl}
                  onChange={(e) => setTtsForm({ ...ttsForm, baseUrl: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  标准 TTS 填写根路径即可（自动补全 /audio/speech）。Chat Completions
                  模式需填写完整路径（如 .../v1/chat/completions）。
                </p>
              </div>
              <Input
                placeholder="API Key（留空则不修改）"
                type="password"
                value={ttsForm.apiKey}
                onChange={(e) => setTtsForm({ ...ttsForm, apiKey: e.target.value })}
              />
              <Input
                placeholder="模型名称（如 tts-1、mimo-v2.5-tts）"
                value={ttsForm.model}
                onChange={(e) => setTtsForm({ ...ttsForm, model: e.target.value })}
              />
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label htmlFor="tts-voice" className="text-sm text-muted-foreground">
                    音色
                  </label>
                  {isMimoTTS ? (
                    <select
                      id="tts-voice"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={ttsForm.voice}
                      onChange={(e) => setTtsForm({ ...ttsForm, voice: e.target.value })}
                    >
                      {mimoVoices.map((v) => (
                        <option key={v.value} value={v.value}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id="tts-voice"
                      placeholder="alloy / nova / shimmer"
                      value={ttsForm.voice}
                      onChange={(e) => setTtsForm({ ...ttsForm, voice: e.target.value })}
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
                    value={ttsForm.speed}
                    onChange={(e) => setTtsForm({ ...ttsForm, speed: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                <Button onClick={handleSaveTTS}>保存设置</Button>
                <Button variant="outline" onClick={handleTestTTS} disabled={ttsTesting}>
                  {ttsTesting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Volume2 className="h-4 w-4 mr-2" />
                  )}
                  测试语音
                </Button>
                {savedTts && savedTts.api_key && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditingTts(false);
                      if (savedTts) {
                        setTtsForm({
                          baseUrl: savedTts.base_url,
                          apiKey: "",
                          model: savedTts.model,
                          voice: savedTts.voice,
                          speed: String(savedTts.speed),
                        });
                      }
                    }}
                  >
                    取消
                  </Button>
                )}
                {ttsSaveMsg && (
                  <span
                    className={`text-sm ${ttsSaveMsg.type === "ok" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                  >
                    {ttsSaveMsg.text}
                  </span>
                )}
                {ttsTestError && (
                  <span className="text-sm text-red-600 dark:text-red-400">{ttsTestError}</span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>ASR 模型设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Input
              placeholder="ASR 模型名称（如 mimo-v2.5-asr）"
              value={asrModel}
              onChange={(e) => setAsrModelState(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              用于口语练习的语音识别。复用 TTS 模型设置中的 API URL 和 API Key。
            </p>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <Button
              onClick={async () => {
                setAsrSaveMsg(null);
                try {
                  await setASRModel(asrModel);
                  setAsrSaveMsg({ type: "ok", text: "保存成功" });
                } catch (err) {
                  setAsrSaveMsg({
                    type: "err",
                    text: `保存失败：${err instanceof Error ? err.message : "未知错误"}`,
                  });
                }
              }}
            >
              保存设置
            </Button>
            <Button
              variant="outline"
              disabled={asrTesting}
              onClick={async () => {
                setAsrTestResult(null);
                if (asrRecording) {
                  // 停止录音 → 转写
                  setAsrTesting(true);
                  try {
                    const blob = await asrStop();
                    if (!blob || blob.size === 0) {
                      setAsrTestResult({ type: "err", text: "录音为空" });
                      return;
                    }
                    const wav = await convertToWav(blob);
                    const text = await transcribeAudio(wav, "en", asrModel);
                    setAsrTestResult({ type: "ok", text: `识别结果：${text}` });
                  } catch (err) {
                    setAsrTestResult({
                      type: "err",
                      text: `测试失败：${err instanceof Error ? err.message : "未知错误"}`,
                    });
                  } finally {
                    setAsrTesting(false);
                  }
                } else {
                  // 开始录音
                  try {
                    await asrStart();
                  } catch (err) {
                    setAsrTestResult({
                      type: "err",
                      text: `无法录音：${err instanceof Error ? err.message : "未知错误"}`,
                    });
                  }
                }
              }}
            >
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
                "测试录音"
              )}
            </Button>
            {asrSaveMsg && (
              <span
                className={`text-sm ${asrSaveMsg.type === "ok" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {asrSaveMsg.text}
              </span>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>学习目标</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            {Object.entries(goalPresets).map(([name, preset]) => (
              <Button
                key={name}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => handleApplyPreset(preset)}
              >
                {name}
              </Button>
            ))}
          </div>
          <div className="space-y-3">
            {Object.entries(goalLabels).map(([type, label]) => {
              const current = goals[type] ?? 0;
              return (
                <div key={type} className="flex items-center justify-between">
                  <span className="text-sm">{label}</span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleUpdateGoal(type, current - 1)}
                      disabled={current <= 0}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <span className="w-8 text-center text-sm font-medium tabular-nums">
                      {current}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleUpdateGoal(type, current + 1)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>通知设置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">每日复习提醒</p>
                <p className="text-sm text-muted-foreground">
                  应用启动时检查待复习词汇并发送系统通知
                </p>
              </div>
            </div>
            <Switch checked={notificationEnabled} onCheckedChange={handleToggleNotification} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>数据备份</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Database className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">备份数据库</p>
                <p className="text-sm text-muted-foreground">
                  使用 SQLite backup API 导出完整数据库副本
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={handleBackup} disabled={backingUp}>
              {backingUp ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  备份中...
                </>
              ) : (
                <>
                  <Database className="h-4 w-4 mr-2" />
                  选择位置并备份
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
