import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Bell,
  Database,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Minus,
  Palette,
  Plus,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { ErrorBanner } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useRecording } from "@/hooks/use-recording";
import { type Theme, useTheme } from "@/hooks/use-theme";
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
import { getNotificationPermission, requestNotificationPermission } from "@/services/notifications";
import { speakText } from "@/services/tts";
import type { ModelConfig, TTSConfig } from "@/types";

/**
 * 设置页面组件
 *
 * 提供五大配置区域：
 * 1. 外观 — 浅色/深色/跟随系统主题切换。
 * 2. 文本模型设置 — 管理多个 OpenAI 兼容 API 的模型连接（名称、API Key、Base URL、模型名），
 *    支持添加/删除/设为默认。默认模型会被所有 LLM 页面（写作、阅读、练习、听力）使用。
 * 3. 语音模型设置 — 合并管理 TTS 和 ASR 的公共配置（API URL、API Key）及各自私有配置。
 *    TTS：模型名、音色、语速；ASR：模型名。支持 TTS 试听和 ASR 录音测试。
 * 4. 学习目标 — 设置每日学习目标（复习、练习、阅读、写作、听力），支持预设方案和自定义调整。
 * 5. 通知与备份 — 每日复习提醒通知开关、数据库备份。
 */

/** mimo TTS 预置音色（模块级常量，避免每次渲染重建） */
const MIMO_VOICES = [
  { value: "冰糖", label: "冰糖（中文女声）" },
  { value: "茉莉", label: "茉莉（中文女声）" },
  { value: "苏打", label: "苏打（中文男声）" },
  { value: "白桦", label: "白桦（中文男声）" },
  { value: "Mia", label: "Mia（英文女声）" },
  { value: "Chloe", label: "Chloe（英文女声）" },
  { value: "Milo", label: "Milo（英文男声）" },
  { value: "Dean", label: "Dean（英文男声）" },
];

/**
 * 语音设置相关状态（合并 TTS + ASR）。
 *
 * 替代原有 11 个独立 useState，集中管理语音设置区域的全部状态，
 * 遵循"复杂组件应用 useReducer"约束。
 */
interface VoiceState {
  /** 表单当前值（编辑中的瞬时状态） */
  form: {
    baseUrl: string;
    apiKey: string;
    ttsModel: string;
    voice: string;
    speed: string;
    asrModel: string;
  };
  /** 是否处于编辑模式 */
  editing: boolean;
  /** 已保存的语音配置快照（用于卡片展示和取消恢复） */
  saved: {
    base_url: string;
    api_key: string;
    tts_model: string;
    voice: string;
    speed: number;
    asr_model: string;
  } | null;
  /** API Key 是否已保存过（用于判断编辑时是否显示掩码） */
  hasApiKey: boolean;
  /** 编辑模式下 API Key 是否显示明文 */
  showApiKey: boolean;
  /** 编辑模式下用户是否修改了 API Key（未修改时保存跳过 api_key） */
  apiKeyDirty: boolean;
  /** TTS 测试播放中的加载状态 */
  ttsTesting: boolean;
  /** TTS 测试失败时的错误信息 */
  ttsTestError: string | null;
  /** ASR 测试状态 */
  asrTesting: boolean;
  /** ASR 测试结果 */
  asrTestResult: { type: "ok" | "err"; text: string } | null;
  /** 语音设置保存结果提示 */
  saveMsg: { type: "ok" | "err"; text: string } | null;
}

/** Voice reducer 的 action 联合类型 */
type VoiceAction =
  | { type: "SET_FORM"; patch: Partial<VoiceState["form"]> }
  | { type: "SET_EDITING"; editing: boolean }
  | { type: "SET_SAVED"; saved: VoiceState["saved"] }
  | { type: "SET_HAS_API_KEY"; hasApiKey: boolean }
  | { type: "SET_SHOW_API_KEY"; showApiKey: boolean }
  | { type: "SET_API_KEY_DIRTY"; dirty: boolean }
  | { type: "SET_TTS_TESTING"; testing: boolean }
  | { type: "SET_TTS_TEST_ERROR"; error: string | null }
  | { type: "SET_ASR_TESTING"; testing: boolean }
  | { type: "SET_ASR_TEST_RESULT"; result: VoiceState["asrTestResult"] }
  | { type: "SET_SAVE_MSG"; msg: VoiceState["saveMsg"] }
  | { type: "RESET_FORM_TO_SAVED" }
  | { type: "LOAD"; form: VoiceState["form"]; saved: VoiceState["saved"]; hasApiKey: boolean };

/** Voice reducer 初始状态 */
const VOICE_INITIAL_STATE: VoiceState = {
  form: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    ttsModel: "tts-1",
    voice: "alloy",
    speed: "1.0",
    asrModel: "mimo-v2.5-asr",
  },
  editing: false,
  saved: null,
  hasApiKey: false,
  showApiKey: false,
  apiKeyDirty: false,
  ttsTesting: false,
  ttsTestError: null,
  asrTesting: false,
  asrTestResult: null,
  saveMsg: null,
};

/**
 * Voice reducer：集中处理语音设置区域的状态变更。
 *
 * 保留与原 useState 等价的语义，每个 case 对应原 setter 调用。
 */
function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case "SET_FORM":
      return { ...state, form: { ...state.form, ...action.patch } };
    case "SET_EDITING":
      return { ...state, editing: action.editing };
    case "SET_SAVED":
      return { ...state, saved: action.saved };
    case "SET_HAS_API_KEY":
      return { ...state, hasApiKey: action.hasApiKey };
    case "SET_SHOW_API_KEY":
      return { ...state, showApiKey: action.showApiKey };
    case "SET_API_KEY_DIRTY":
      return { ...state, apiKeyDirty: action.dirty };
    case "SET_TTS_TESTING":
      return { ...state, ttsTesting: action.testing };
    case "SET_TTS_TEST_ERROR":
      return { ...state, ttsTestError: action.error };
    case "SET_ASR_TESTING":
      return { ...state, asrTesting: action.testing };
    case "SET_ASR_TEST_RESULT":
      return { ...state, asrTestResult: action.result };
    case "SET_SAVE_MSG":
      return { ...state, saveMsg: action.msg };
    case "RESET_FORM_TO_SAVED":
      if (!state.saved) return state;
      return {
        ...state,
        form: {
          baseUrl: state.saved.base_url,
          apiKey: "",
          ttsModel: state.saved.tts_model,
          voice: state.saved.voice,
          speed: String(state.saved.speed),
          asrModel: state.saved.asr_model,
        },
        editing: false,
        apiKeyDirty: false,
        showApiKey: false,
      };
    case "LOAD":
      return { ...state, form: action.form, saved: action.saved, hasApiKey: action.hasApiKey };
    default:
      return state;
  }
}

export default function SettingsPage() {
  /** 已保存的模型配置列表，从 SQLite models 表加载 */
  const [models, setModels] = useState<ModelConfig[]>([]);
  const { theme, setTheme } = useTheme();

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
    isDefault: false,
  });

  /** 正在编辑的模型 ID（null 表示非编辑模式） */
  const [editingModelId, setEditingModelId] = useState<number | null>(null);
  /** 是否显示添加模型表单 */
  const [showModelForm, setShowModelForm] = useState(false);

  /**
   * 语音模型设置（合并 TTS + ASR）— 使用 useReducer 集中管理 11 个相关状态。
   * - 公共配置：baseUrl、apiKey（TTS 和 ASR 共用）
   * - TTS 私有：ttsModel、voice、speed
   * - ASR 私有：asrModel
   *
   * 通过解构将 state 字段映射为原变量名，使 JSX 大部分引用无需改动：
   * voiceForm / editingVoice / savedVoice / hasApiKey / showApiKey / apiKeyDirty /
   * ttsTesting / ttsTestError / asrTesting / asrTestResult / voiceSaveMsg
   */
  const [voiceState, dispatch] = useReducer(voiceReducer, VOICE_INITIAL_STATE);
  const {
    form: voiceForm,
    editing: editingVoice,
    saved: savedVoice,
    hasApiKey,
    showApiKey,
    apiKeyDirty,
    ttsTesting,
    ttsTestError,
    asrTesting,
    asrTestResult,
    saveMsg: voiceSaveMsg,
  } = voiceState;
  // 保留 setter 别名，使原 setXxx 调用最小改动地映射到 dispatch
  const setVoiceForm = (patch: Partial<typeof voiceForm>) => dispatch({ type: "SET_FORM", patch });
  const setEditingVoice = (editing: boolean) => dispatch({ type: "SET_EDITING", editing });
  const setSavedVoice = (saved: typeof savedVoice) => dispatch({ type: "SET_SAVED", saved });
  const setHasApiKey = (hasApiKey: boolean) => dispatch({ type: "SET_HAS_API_KEY", hasApiKey });
  const setShowApiKey = (showApiKey: boolean) => dispatch({ type: "SET_SHOW_API_KEY", showApiKey });
  const setApiKeyDirty = (dirty: boolean) => dispatch({ type: "SET_API_KEY_DIRTY", dirty });
  const setTtsTesting = (testing: boolean) => dispatch({ type: "SET_TTS_TESTING", testing });
  const setTtsTestError = (error: string | null) => dispatch({ type: "SET_TTS_TEST_ERROR", error });
  const setAsrTesting = (testing: boolean) => dispatch({ type: "SET_ASR_TESTING", testing });
  const setAsrTestResult = (result: typeof asrTestResult) =>
    dispatch({ type: "SET_ASR_TEST_RESULT", result });
  const setVoiceSaveMsg = (msg: typeof voiceSaveMsg) => dispatch({ type: "SET_SAVE_MSG", msg });

  const {
    recording: asrRecording,
    error: asrMicError,
    start: asrStart,
    stop: asrStop,
  } = useRecording();

  /** 当前模型是否为 mimo TTS */
  const isMimoTTS = voiceForm.ttsModel.startsWith("mimo");

  /** 切换 mimo/非 mimo 模型时自动重置音色 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: setVoiceForm 是 dispatch 包装器，非稳定引用，无需作为依赖
  useEffect(() => {
    if (isMimoTTS && !MIMO_VOICES.some((v) => v.value === voiceForm.voice)) {
      setVoiceForm({ voice: "冰糖" });
    } else if (!isMimoTTS && MIMO_VOICES.some((v) => v.value === voiceForm.voice)) {
      setVoiceForm({ voice: "alloy" });
    }
  }, [isMimoTTS, voiceForm.voice]);

  /** 每日复习提醒开关状态，默认启用 */
  const [notificationEnabled, setNotificationEnabled] = useState(true);

  /** 原生通知权限状态 */
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>("default");

  /** 学习目标：goal_type -> target */
  const [goals, setGoals] = useState<Record<string, number>>({});

  /** 是否处于学习目标编辑状态 */
  const [isEditingGoals, setIsEditingGoals] = useState(false);

  /** 编辑中的学习目标草稿 */
  const [draftGoals, setDraftGoals] = useState<Record<string, number>>({});

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

  /** 最近一次备份时间和路径 */
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [lastBackupPath, setLastBackupPath] = useState<string | null>(null);

  /** 全局错误提示 */
  const [pageError, setPageError] = useState<string | null>(null);

  /** 关于对话框 */
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("未知"));
  }, []);

  /** 预设目标配置 */
  const goalPresets: Record<string, Record<string, number>> = {
    轻松: { review: 5, exercise: 1, reading: 1, writing: 1, listening: 1 },
    标准: { review: 10, exercise: 2, reading: 1, writing: 1, listening: 1 },
    进阶: { review: 20, exercise: 3, reading: 2, writing: 2, listening: 2 },
  };

  /** 页面挂载时从 SQLite 加载已有的模型列表、语音配置、通知设置和学习目标 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行一次，setter 为 dispatch 包装器无需作为依赖
  useEffect(() => {
    // 每个 Promise 均添加 .catch，避免任一 reject 产生 unhandled rejection
    // 这些都是非关键副作用，使用 console.warn 记录即可
    getModels()
      .then(setModels)
      .catch((err) => console.warn("load models failed", err));
    Promise.all([getTTSConfig(), getASRModel()])
      .then(([cfg, asr]) => {
        setVoiceForm({
          baseUrl: cfg.base_url,
          apiKey: "",
          ttsModel: cfg.model,
          voice: cfg.voice,
          speed: String(cfg.speed),
          asrModel: asr,
        });
        setSavedVoice({
          base_url: cfg.base_url,
          api_key: cfg.api_key,
          tts_model: cfg.model,
          voice: cfg.voice,
          speed: cfg.speed,
          asr_model: asr,
        });
        setHasApiKey(!!cfg.api_key);
      })
      .catch((err) => console.warn("load voice config failed", err));
    getSetting("notification_enabled")
      .then((val) => setNotificationEnabled(val !== "false"))
      .catch((err) => console.warn("load notification_enabled failed", err));
    getNotificationPermission()
      .then(setNotificationPermission)
      .catch((err) => console.warn("load notification permission failed", err));
    getSetting("last_backup_time")
      .then(setLastBackupTime)
      .catch((err) => console.warn("load last_backup_time failed", err));
    getSetting("last_backup_path")
      .then(setLastBackupPath)
      .catch((err) => console.warn("load last_backup_path failed", err));
    getLearningGoals()
      .then(setGoals)
      .catch((err) => console.warn("load goals failed", err));
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
      setForm({
        name: "",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        modelName: "",
        isDefault: false,
      });
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
      isDefault: model.is_default,
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
        is_default: form.isDefault,
      });
      setEditingModelId(null);
      setForm({
        name: "",
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        modelName: "",
        isDefault: false,
      });
      getModels().then(setModels);
    } catch (err) {
      setPageError(`更新模型失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  /**
   * 保存语音模型设置（公共 + TTS + ASR）到 SQLite settings 表
   *
   * 公共配置（base_url、api_key）写入 TTS settings（ASR 复用）。
   * TTS 私有（model、voice、speed）写入 TTS settings。
   * ASR 私有（asr_model）写入 settings 表。
   */
  async function handleSaveVoice() {
    const clampedSpeed = Math.min(4.0, Math.max(0.25, parseFloat(voiceForm.speed) || 1.0));
    setVoiceSaveMsg(null);
    try {
      const entries: Array<[string, string]> = [
        ["tts_base_url", voiceForm.baseUrl],
        ["tts_model", voiceForm.ttsModel],
        ["tts_voice", voiceForm.voice],
        ["tts_speed", String(clampedSpeed)],
      ];
      if (apiKeyDirty && voiceForm.apiKey) {
        entries.push(["tts_api_key", voiceForm.apiKey]);
      }
      await Promise.all([setTTSSettingBatch(entries), setASRModel(voiceForm.asrModel)]);
      const effectiveApiKey = apiKeyDirty ? voiceForm.apiKey : (savedVoice?.api_key ?? "");
      setVoiceSaveMsg({ type: "ok", text: "保存成功" });
      setEditingVoice(false);
      setHasApiKey(!!effectiveApiKey);
      setApiKeyDirty(false);
      setShowApiKey(false);
      setSavedVoice({
        base_url: voiceForm.baseUrl,
        api_key: effectiveApiKey,
        tts_model: voiceForm.ttsModel,
        voice: voiceForm.voice,
        speed: clampedSpeed,
        asr_model: voiceForm.asrModel,
      });
    } catch (err) {
      setVoiceSaveMsg({
        type: "err",
        text: `保存失败：${err instanceof Error ? err.message : "未知错误"}`,
      });
    }
  }

  /**
   * 测试当前 TTS 配置
   *
   * 使用表单中填写的即时配置朗读一句固定英文，方便用户在修改设置后立即试听效果。
   * API Key 优先使用用户新输入的值，否则使用已保存的值。
   */
  async function handleTestTTS() {
    const effectiveApiKey = apiKeyDirty ? voiceForm.apiKey : (savedVoice?.api_key ?? "");
    const config: TTSConfig = {
      base_url: voiceForm.baseUrl,
      api_key: effectiveApiKey,
      model: voiceForm.ttsModel,
      voice: voiceForm.voice,
      speed: Math.min(4.0, Math.max(0.25, parseFloat(voiceForm.speed) || 1.0)),
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
   * 请求原生系统通知权限。
   */
  async function handleRequestNotificationPermission() {
    try {
      const permission = await requestNotificationPermission();
      setNotificationPermission(permission);
      if (permission === "denied") {
        setPageError("通知权限已被拒绝，请在系统设置中手动开启");
      }
    } catch (err) {
      setPageError(`请求通知权限失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  function handleEditGoals() {
    setDraftGoals({ ...goals });
    setIsEditingGoals(true);
  }

  /**
   * 更新单个学习目标草稿（不立即写入数据库）。
   */
  function handleUpdateDraftGoal(goalType: string, target: number) {
    const clamped = Math.max(0, target);
    setDraftGoals((prev) => ({ ...prev, [goalType]: clamped }));
  }

  /**
   * 保存学习目标草稿，批量写入数据库后切换到查看状态，并通知 Sidebar 刷新。
   *
   * 使用 Promise.allSettled 而非 Promise.all：任一 reject 后仍会 await 其余，
   * 避免已 resolved 的 setLearningGoal 实际写入 DB 但 UI 仅回滚状态的不一致。
   * 部分失败时不回滚 UI（已成功的已写入 DB），但提示用户并重新加载实际值。
   */
  async function handleSaveGoals() {
    const prev = goals;
    setGoals(draftGoals);
    try {
      const results = await Promise.allSettled(
        Object.entries(draftGoals).map(([type, target]) => setLearningGoal(type, target)),
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        // 部分失败：不回滚 UI（已成功的已写入 DB），但提示用户
        console.warn("handleSaveGoals: some goals failed to save", failed);
        setPageError(`部分学习目标保存失败（${failed.length} 项），请重试`);
        // 重新加载实际值以同步 UI 与 DB
        getLearningGoals()
          .then(setGoals)
          .catch(() => {});
      } else {
        window.dispatchEvent(new CustomEvent("learning-goals-changed"));
        setIsEditingGoals(false);
      }
    } catch (err) {
      setGoals(prev);
      setPageError(`保存学习目标失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  /**
   * 取消学习目标编辑，恢复查看状态。
   */
  function handleCancelEditGoals() {
    setIsEditingGoals(false);
    setDraftGoals({});
  }

  /**
   * 备份数据库文件。
   * 通过 Tauri dialog 选择保存位置，调用 Rust 端的 SQLite backup API。
   */
  async function handleBackup() {
    const now = new Date();
    // 使用本地时区格式化文件名，与 FSRS 本地时区约定一致
    // 避免早 7 点（UTC 23 点）备份时文件名显示前一天日期
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const destPath = await save({
      title: "备份数据库",
      defaultPath: `raven-backup-${dateStr}_${timeStr}.db`,
      filters: [{ name: "SQLite Database", extensions: ["db"] }],
    });
    if (!destPath) return;

    setBackingUp(true);
    try {
      await backupDatabase(destPath);
      const isoNow = now.toISOString();
      await setSetting("last_backup_time", isoNow);
      await setSetting("last_backup_path", destPath);
      setLastBackupTime(isoNow);
      setLastBackupPath(destPath);
      setPageError(null);
    } catch (err) {
      console.error("Backup failed:", err);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : err && typeof err === "object" && "message" in err
              ? String(err.message)
              : "未知错误";
      setPageError(`备份失败：${message}`);
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
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            外观
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            {(
              [
                { label: "浅色", value: "light" },
                { label: "深色", value: "dark" },
                { label: "跟随系统", value: "system" },
              ] as { label: string; value: Theme }[]
            ).map((opt) => (
              <Button
                key={opt.value}
                size="sm"
                variant={theme === opt.value ? "default" : "outline"}
                onClick={() => setTheme(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>文本模型设置</CardTitle>
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
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={model.is_default}
                        onClick={() => handleSetDefault(model.id)}
                      >
                        设为默认
                      </Button>
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
              {editingModelId !== null && (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch
                    checked={form.isDefault}
                    onCheckedChange={(v) => setForm({ ...form, isDefault: v })}
                  />
                  设为默认模型
                </label>
              )}
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
                          isDefault: false,
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
                            isDefault: false,
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
          <CardTitle>语音模型设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 已保存配置概览（非编辑模式时显示） */}
          {savedVoice && hasApiKey && !editingVoice && (
            <div className="space-y-3">
              {/* 公共配置 */}
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
              {/* TTS 配置 */}
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
              {/* ASR 配置 */}
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

          {/* 编辑表单（编辑模式或无已保存配置时显示） */}
          {(!savedVoice || !hasApiKey || editingVoice) && (
            <>
              {/* 公共配置 */}
              <div className="space-y-1">
                <label className="text-sm font-medium">API URL</label>
                <Input
                  placeholder="如 https://api.openai.com/v1"
                  value={voiceForm.baseUrl}
                  onChange={(e) => setVoiceForm({ ...voiceForm, baseUrl: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  标准 TTS 填写根路径即可（自动补全 /audio/speech）。Chat Completions
                  模式需填写完整路径（如 .../v1/chat/completions）。
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">API Key</label>
                <div className="relative">
                  <Input
                    placeholder={hasApiKey && !apiKeyDirty ? "••••••••" : "输入 API Key"}
                    type={showApiKey ? "text" : "password"}
                    value={showApiKey ? voiceForm.apiKey : apiKeyDirty ? voiceForm.apiKey : ""}
                    onChange={(e) => {
                      setVoiceForm({ ...voiceForm, apiKey: e.target.value });
                      setApiKeyDirty(true);
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-9 w-9"
                    onClick={() => setShowApiKey(!showApiKey)}
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              {/* TTS 私有配置 */}
              <div className="pt-2 border-t">
                <p className="text-sm font-medium mb-3">TTS 模型</p>
                <div className="space-y-3">
                  <Input
                    placeholder="模型名称（如 tts-1、mimo-v2.5-tts）"
                    value={voiceForm.ttsModel}
                    onChange={(e) => setVoiceForm({ ...voiceForm, ttsModel: e.target.value })}
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
                          value={voiceForm.voice}
                          onChange={(e) => setVoiceForm({ ...voiceForm, voice: e.target.value })}
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
                          placeholder="alloy / nova / shimmer"
                          value={voiceForm.voice}
                          onChange={(e) => setVoiceForm({ ...voiceForm, voice: e.target.value })}
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
                        onChange={(e) => setVoiceForm({ ...voiceForm, speed: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* ASR 私有配置 */}
              <div className="pt-2 border-t">
                <p className="text-sm font-medium mb-3">ASR 模型</p>
                <div className="space-y-1">
                  <Input
                    placeholder="模型名称（如 mimo-v2.5-asr）"
                    value={voiceForm.asrModel}
                    onChange={(e) => setVoiceForm({ ...voiceForm, asrModel: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    用于口语练习和听力练习的语音识别，复用上方公共 API URL 和 API Key。
                  </p>
                </div>
              </div>

              <div className="flex gap-2 items-center flex-wrap">
                <Button onClick={handleSaveVoice}>保存设置</Button>
                <Button variant="outline" onClick={handleTestTTS} disabled={ttsTesting}>
                  {ttsTesting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Volume2 className="h-4 w-4 mr-2" />
                  )}
                  测试 TTS
                </Button>
                <Button
                  variant="outline"
                  disabled={asrTesting}
                  onClick={async () => {
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
                        setAsrTestResult({
                          type: "err",
                          text: `测试失败：${err instanceof Error ? err.message : "未知错误"}`,
                        });
                      } finally {
                        setAsrTesting(false);
                      }
                    } else {
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
                    "测试 ASR"
                  )}
                </Button>
                {savedVoice && hasApiKey && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditingVoice(false);
                      setApiKeyDirty(false);
                      setShowApiKey(false);
                      setVoiceForm({
                        baseUrl: savedVoice.base_url,
                        apiKey: "",
                        ttsModel: savedVoice.tts_model,
                        voice: savedVoice.voice,
                        speed: String(savedVoice.speed),
                        asrModel: savedVoice.asr_model,
                      });
                    }}
                  >
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

      <Card>
        <CardHeader>
          <CardTitle>学习目标</CardTitle>
          <CardAction>
            {isEditingGoals ? (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={handleCancelEditGoals}>
                  取消
                </Button>
                <Button size="sm" onClick={handleSaveGoals}>
                  保存
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={handleEditGoals}>
                编辑
              </Button>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {isEditingGoals && (
            <div className="flex gap-2 flex-wrap">
              {Object.entries(goalPresets).map(([name, preset]) => (
                <Button
                  key={name}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setDraftGoals(preset)}
                >
                  {name}
                </Button>
              ))}
            </div>
          )}
          <div className="space-y-3">
            {Object.entries(goalLabels).map(([type, label]) => {
              const current = isEditingGoals ? (draftGoals[type] ?? 0) : (goals[type] ?? 0);
              return (
                <div key={type} className="flex items-center justify-between">
                  <span className="text-sm">{label}</span>
                  {isEditingGoals ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleUpdateDraftGoal(type, current - 1)}
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
                        onClick={() => handleUpdateDraftGoal(type, current + 1)}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <span className="text-sm font-medium tabular-nums">{current}</span>
                  )}
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
                  应用启动时检查待复习词汇并发送 Windows 原生通知
                </p>
              </div>
            </div>
            <Switch checked={notificationEnabled} onCheckedChange={handleToggleNotification} />
          </div>
          <div className="mt-3 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            <span>
              通知权限：
              {notificationPermission === "granted"
                ? "已授权"
                : notificationPermission === "denied"
                  ? "已拒绝（请在系统通知设置中为 Raven 开启）"
                  : "未请求"}
            </span>
            {notificationPermission === "default" && (
              <Button variant="ghost" size="sm" onClick={handleRequestNotificationPermission}>
                请求权限
              </Button>
            )}
          </div>
          {import.meta.env.DEV && (
            <p className="mt-2 text-xs text-muted-foreground">
              提示：开发模式下通知权限由 WebView2 管理，Raven
              不会出现在系统通知设置列表中。正式版需安装后才会注册。
            </p>
          )}
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
          <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground space-y-1">
            {lastBackupTime ? (
              <>
                <p>上次备份：{new Date(lastBackupTime).toLocaleString()}</p>
                {lastBackupPath && (
                  <p className="truncate" title={lastBackupPath}>
                    路径：{lastBackupPath}
                  </p>
                )}
              </>
            ) : (
              <p>暂无备份记录</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>关于</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Info className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Raven</p>
                <p className="text-sm text-muted-foreground">AI 驱动的英语学习桌面助手</p>
              </div>
            </div>
            <Button variant="outline" onClick={() => setAboutOpen(true)}>
              <Info className="h-4 w-4 mr-2" />
              版本信息
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>关于 Raven</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">应用名称</span>
              <span className="font-medium">Raven</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">版本号</span>
              <span className="font-medium">v{appVersion}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">技术栈</span>
              <span className="font-medium">Tauri v2 + React 19</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">许可证</span>
              <span className="font-medium">MIT</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
