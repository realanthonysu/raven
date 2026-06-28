/**
 * 语音设置 reducer —— 合并 TTS + ASR 的 11 个状态字段。
 *
 * 从 SettingsPage.tsx 提取，供 VoiceCard 独立使用。
 */

/** mimo TTS 预置音色（模块级常量，避免每次渲染重建） */
export const MIMO_VOICES = [
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
export interface VoiceState {
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
export type VoiceAction =
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
export const VOICE_INITIAL_STATE: VoiceState = {
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
export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
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
