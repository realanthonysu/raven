//! LLM 请求代理 —— 密钥不出主进程。
//!
//! A1: 此前 LLM 流式请求由 WebView 经 tauri-plugin-http 直连任意 HTTPS 端点，
//! 真实的 API Key 会下发到 WebView(脚本可读、可外传)。
//! 本模块把请求移到 Rust 侧:命令从 DB 读模型配置、从 OS Keychain 读密钥，
//! 用 reqwest 发起 SSE 流式请求,通过 [`tauri::ipc::Channel`] 把 token 推回前端。
//! 前端不再需要直连任意 HTTPS(见 capabilities 的 http scope 收窄)。
//!
//! ## 密钥下发 WebView 的显式豁免清单
//!
//! "密钥不下发 WebView"是 LLM 流式请求路径的设计目标，以下三处是**刻意保留**
//! 的例外（前端需要明文 Key 完成自身功能，且不在流式代理的攻击面上）：
//! 1. `db_get_model_api_key`（commands/models.rs）——编辑表单预填已存 Key，
//!    仅在用户显式编辑单个模型时按 id 读取
//! 2. `db_get_tts_config`（commands/settings.rs）——设置表单预填真实 Key
//!    （编辑时可见）。运行时 TTS/ASR 音频请求已移入本模块代理，且由代理命令
//!    自行从 OS Keychain 读 Key（前端不回传），WebView 持有的该 Key 仅用于
//!    表单预填展示
//! 3. `db_get_default_model`（commands/models.rs）——默认模型查询回填明文 Key：
//!    WebView 降级请求路径（Rust 代理不可用时经 smartFetch 直连，http scope
//!    已收窄为本地回环，故仅对本地供应商可用）需要 Key 组装 Authorization 头，
//!    前端亦以 api_key 非空作为"已配置模型"判据
//!
//! 新增返回密钥的命令时必须在此清单登记，否则视为违反威胁模型。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::credentials;
use crate::db::Db;
use crate::error::AppError;
use crate::repository::models;

/// 从 OS Keychain 读取 TTS/ASR 共用密钥（阻塞调用，需在 spawn_blocking 中执行）。
/// Keychain 失败或未设置时返回空串，由调用方按"未配置"校验。
fn tts_key_from_keychain() -> String {
    credentials::get_tts_key()
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// 单次请求消息体的最大字节数(防御被入侵前端发起的超大请求)。
const MAX_MESSAGES_BYTES: usize = 2 * 1024 * 1024;

/// 与前端 `LLMMessage` 对应的消息结构(仅 role + content,不含任何密钥)。
#[derive(Debug, Deserialize)]
pub struct ProxyMessage {
    pub role: String,
    pub content: String,
}

/// 推送给前端的流式事件(枚举,序列化为 { type, ... })。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProxyEvent {
    /// 增量 token
    #[serde(rename_all = "camelCase")]
    Token { token: String },
    /// 流结束,携带完整文本
    #[serde(rename_all = "camelCase")]
    Done { full_text: String },
    /// 错误(非中止)
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

/// 解析一行 SSE 数据。兼容 `data:` 与 `data: ` 两种写法(E1)。
/// 返回 (完整文本累积, 增量 token, 是否 [DONE])。
fn process_sse_line(line: &str, full: &mut String) -> (Option<String>, bool) {
    let trimmed = line.trim();
    if !trimmed.starts_with("data:") {
        return (None, false);
    }
    let rest = &trimmed[5..];
    let data = rest.strip_prefix(' ').unwrap_or(rest);
    if data == "[DONE]" {
        return (None, true);
    }
    // 增量文本用事件内的 choices[0].delta.content 累积;
    // 部分实现只在 completion 里给 content——统一按 delta 处理
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
        if let Some(content) = parsed
            .pointer("/choices/0/delta/content")
            .and_then(|v| v.as_str())
        {
            full.push_str(content);
            return (Some(content.to_string()), false);
        }
    }
    (None, false)
}

/// 从字节缓冲中切出所有完整行(以 `\n` 结尾),并保留最后的残行字节。
///
/// TCP 分块不保证与 SSE 行边界对齐,且分块边界可能落在多字节 UTF-8 字符中间。
/// 因此必须用 `Vec<u8>` 累积原始字节,只在拿到完整行后才做 UTF-8 解码,
/// 避免 `from_utf8_lossy` 在残行上把字符替换为 U+FFFD 导致 JSON 解析失败、token 静默丢失。
fn extract_lines(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for i in 0..buffer.len() {
        if buffer[i] == b'\n' {
            lines.push(buffer[start..i].to_vec());
            start = i + 1;
        }
    }
    buffer.drain(..start);
    lines
}

/// 代理一次 LLM 流式 chat completion 请求(密钥在 Rust 侧,不下发 WebView)。
///
/// # Arguments
///
/// * `model_id` - 模型配置 ID(密钥从 OS Keychain 按此 ID 读取)
/// * `messages` - 消息列表(role + content)
/// * `timeout_ms` - 可选超时(默认 120s)
/// * `on_event` - Tauri 2 Channel,逐个推送 [`ProxyEvent`]
///
/// 请求体与前端旧实现一致(OpenAI 兼容):`{ model, messages, stream: true }`。
/// 业务错误(超时/网络失败/API 4xx 5xx)通过 [`ProxyEvent::Error`] 传达且命令返回
/// `Ok(())` —— 前端以 Channel 事件为唯一错误通道,避免与 invoke reject 竞态双路径。
#[tauri::command]
pub async fn db_stream_chat_completions(
    db: State<'_, Db>,
    client: State<'_, reqwest::Client>,
    model_id: i64,
    messages: Vec<ProxyMessage>,
    timeout_ms: Option<u64>,
    on_event: Channel<ProxyEvent>,
) -> Result<(), AppError> {
    if messages.is_empty() {
        return Err(AppError::Validation("messages cannot be empty".into()));
    }
    let messages_bytes: usize = messages.iter().map(|m| m.content.len()).sum();
    if messages_bytes > MAX_MESSAGES_BYTES {
        return Err(AppError::Validation(format!(
            "request body too large ({messages_bytes} bytes, max {MAX_MESSAGES_BYTES})"
        )));
    }

    // 读模型配置与密钥(spawn_blocking:Keychain + SQLite 都是同步 IO)
    let pool = db.0.clone();
    let (base_url, api_key, model_name) = tokio::task::spawn_blocking(move || {
        let conn = pool
            .get()
            .map_err(|e| AppError::Database(format!("DB pool error: {e}")))?;
        let model = models::get_model_by_id(&conn, model_id)?
            .ok_or_else(|| AppError::Validation(format!("model {model_id} not found")))?;
        Ok::<_, AppError>((model.base_url, model.api_key, model.model_name))
    })
    .await
    .map_err(|e| AppError::Database(format!("model load task panicked: {e}")))??;

    if api_key.is_empty() {
        return Err(AppError::Validation(
            "model api_key is not configured".into(),
        ));
    }

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model_name,
        "messages": messages
            .into_iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": true,
    });

    // A2: 复用 setup 中创建的 Client(连接池 + TLS 会话复用),避免每次请求重建
    let client = client.inner().clone();
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(120_000));

    // tokio::time::timeout 兜底:即使服务端挂起也能结束命令
    let outcome = tokio::time::timeout(timeout, async {
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Network(format!("LLM request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(AppError::Network(format!("LLM API error: {status} {text}")));
        }

        // 逐行读取 SSE 流:字节缓冲,按完整行 UTF-8 解码
        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::with_capacity(8192);
        let mut full_text = String::new();
        use futures_util::StreamExt;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Network(format!("stream read failed: {e}")))?;
            buffer.extend_from_slice(&chunk);
            let lines = extract_lines(&mut buffer);
            for raw in lines {
                // 完整行才解码;非法 UTF-8(基本不会)整行丢弃,不影响后续
                let Ok(line) = String::from_utf8(raw) else {
                    continue;
                };
                let (token, done) = process_sse_line(&line, &mut full_text);
                if let Some(t) = token {
                    // 前端已离开/Channel 失效:立即停止读取上游,避免空跑消耗 token 计费
                    if on_event.send(ProxyEvent::Token { token: t }).is_err() {
                        return Ok::<(), AppError>(());
                    }
                }
                if done {
                    let _ = on_event.send(ProxyEvent::Done {
                        full_text: full_text.clone(),
                    });
                    return Ok::<(), AppError>(());
                }
            }
        }
        // 流结束但未收到 [DONE](部分 API 行为)——处理残留的末行(无尾换行)
        if !buffer.is_empty() {
            if let Ok(line) = String::from_utf8(std::mem::take(&mut buffer)) {
                let (token, _) = process_sse_line(&line, &mut full_text);
                if let Some(t) = token {
                    let _ = on_event.send(ProxyEvent::Token { token: t });
                }
            }
        }
        let _ = on_event.send(ProxyEvent::Done {
            full_text: full_text.clone(),
        });
        Ok(())
    })
    .await;

    match outcome {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            // 业务错误:通过 Channel 传达给前端(前端视为终态 api-error)。
            // 命令返回 Ok —— 若此处返回 Err,invoke reject 与 Error 事件会竞态,
            // 前端可能走"降级"路径造成同一请求重复发送
            let _ = on_event.send(ProxyEvent::Error {
                message: e.to_string(),
            });
            Ok(())
        }
        Err(_) => {
            let msg = format!("LLM request timed out ({}s)", timeout.as_secs());
            let _ = on_event.send(ProxyEvent::Error {
                message: msg.clone(),
            });
            Ok(())
        }
    }
}

// ============================================================================
// 非流式代理（A1 扩展）：连接测试 / TTS / ASR
// ============================================================================
// 此前这三条路径由 WebView 经 tauri-plugin-http 直连远程 API，依赖 capabilities
// 放行 `https://**`。http scope 收窄为本地回环后，WebView 直连对远程供应商全部
// 失效，故统一移入 Rust 侧：密钥经 IPC 参数传入（Key 本就经 db_get_tts_config
// 豁免存在于 WebView，不改变威胁模型），由主进程 reqwest 发起请求。
// 注意：invoke 无法中止命令执行，前端 abort 只能放弃结果（Rust 侧请求跑完后
// 被丢弃）——与 db_stream_chat_completions 的中止语义一致。

/// 单个音频响应的最大字节数（防御异常服务端返回超大 body）。
const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;

/// ASR 音频 data URL 的最大长度（60s 16bit 单声道 WAV base64 后约 8MB，留足余量）。
const MAX_AUDIO_DATA_URL_BYTES: usize = 32 * 1024 * 1024;

/// 连接测试响应体上限（远大于正常 chat completion 响应，仅防异常超大 body；
/// 前端需要完整 JSON 做 choices 结构校验，故不能截断到错误消息级别）。
const MAX_TEST_CONNECTION_BODY_BYTES: usize = 64 * 1024;

/// 归一化 base_url：去首尾空白与尾部 `/`。
fn normalize_base(base_url: &str) -> &str {
    base_url.trim().trim_end_matches('/')
}

/// 由 base_url 推导 chat/completions 端点（已以 /chat/completions 结尾则不追加）。
fn chat_completions_url(base_url: &str) -> String {
    let base = normalize_base(base_url);
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

/// 由 base_url 推导 /audio/speech 端点（已以 /audio/speech 结尾则不追加）。
fn audio_speech_url(base_url: &str) -> String {
    let base = normalize_base(base_url);
    if base.ends_with("/audio/speech") {
        base.to_string()
    } else {
        format!("{base}/audio/speech")
    }
}

/// 截断响应体片段用于错误消息（避免把超大 body 塞进错误文本）。
fn body_snippet(body: &str) -> String {
    body.chars().take(500).collect()
}

/// 连接测试探活请求体（与旧前端实现一致：最小 chat completion）。
fn test_connection_body(model_name: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model_name,
        "messages": [{ "role": "user", "content": "Hi" }],
        "max_tokens": 5,
    })
}

/// TTS Chat Completions audio modality 请求体。
/// mimo 与 OpenAI 的请求体有差异（与旧前端实现一致）：
/// - mimo：assistant 消息携带待朗读文本，无 modalities 字段
/// - OpenAI（GPT-4o-audio-preview 等）：user 消息 + modalities 字段
fn tts_chat_body(model: &str, voice: &str, speed: f64, text: &str) -> serde_json::Value {
    if model.starts_with("mimo") {
        serde_json::json!({
            "model": model,
            "messages": [{ "role": "assistant", "content": text }],
            "audio": { "voice": voice, "format": "mp3", "speed": speed },
        })
    } else {
        serde_json::json!({
            "model": model,
            "modalities": ["text", "audio"],
            "audio": { "voice": voice, "format": "mp3" },
            "messages": [{ "role": "user", "content": text }],
        })
    }
}

/// ASR Chat Completions input_audio 请求体（与旧前端实现一致）。
fn asr_body(model: &str, language: &str, audio_data_url: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [{ "type": "input_audio", "input_audio": { "data": audio_data_url } }],
        }],
        "asr_options": { "language": language },
    })
}

/// 连接测试结果：HTTP 状态码 + 响应体原文。
/// 业务结构校验（choices 数组）与错误消息构造保留在前端，保持旧版 UX 文案不变。
#[derive(Debug, Serialize)]
pub struct TestConnectionResult {
    pub status: u16,
    pub body: String,
}

/// 测试 LLM API 连通性（非流式探活）。
///
/// 供设置页模型表单与新手引导共用。只做传输不做业务校验：
/// - 非 2xx → 前端抛 `HTTP {status}: {body 前 200 字符}`
/// - 2xx 但 body 非法 → 前端抛"非预期的响应格式"
/// 本地推理服务（Ollama 等）无 Key：空 Key 不发送 Authorization 头（与旧前端一致）。
#[tauri::command]
pub async fn db_test_llm_connection(
    client: State<'_, reqwest::Client>,
    base_url: String,
    api_key: Option<String>,
    model_name: String,
    timeout_ms: Option<u64>,
) -> Result<TestConnectionResult, AppError> {
    if base_url.trim().is_empty() {
        return Err(AppError::Validation("base_url cannot be empty".into()));
    }
    if model_name.trim().is_empty() {
        return Err(AppError::Validation("model_name cannot be empty".into()));
    }
    let url = chat_completions_url(&base_url);
    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&test_connection_body(&model_name));
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        request = request.bearer_auth(key);
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let response = request
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("连接失败: {e}")))?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let body = if text.len() > MAX_TEST_CONNECTION_BODY_BYTES {
        // 按字节截断可能切在 UTF-8 序列中间，用 lossy 解码避免 panic
        String::from_utf8_lossy(&text.as_bytes()[..MAX_TEST_CONNECTION_BODY_BYTES]).into_owned()
    } else {
        text
    };
    Ok(TestConnectionResult { status, body })
}

/// 代理 TTS 音频合成，返回原始音频字节（mp3）。
///
/// 支持两种 OpenAI 兼容模式（与旧前端实现一致）：
/// 1. `{base}/audio/speech` —— 标准 TTS 端点，响应即音频二进制
/// 2. base 以 /chat/completions 结尾 —— audio modality，响应为含 base64
///    音频的 JSON（mimo / GPT-4o-audio-preview 等）
///
/// 密钥由本命令自行从 OS Keychain 读取，前端不传 Key（运行时 TTS 请求
/// 不依赖 `db_get_tts_config` 下发的明文 Key，后者仅用于设置表单预填）。
#[tauri::command]
pub async fn db_fetch_tts_audio(
    client: State<'_, reqwest::Client>,
    base_url: String,
    model: String,
    voice: String,
    speed: f64,
    text: String,
    timeout_ms: Option<u64>,
) -> Result<tauri::ipc::Response, AppError> {
    let api_key = tokio::task::spawn_blocking(tts_key_from_keychain)
        .await
        .map_err(|e| AppError::Network(format!("读取 TTS 密钥失败: {e}")))?;
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("tts api_key is not configured".into()));
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(60_000));
    let req = TtsAudioRequest {
        base_url: &base_url,
        api_key: &api_key,
        model: &model,
        voice: &voice,
        speed,
        text: &text,
    };
    let audio = if normalize_base(&base_url).ends_with("/chat/completions") {
        fetch_tts_chat_audio(&client, &req, timeout).await
    } else {
        fetch_tts_speech_audio(&client, &req, timeout).await
    }?;
    Ok(tauri::ipc::Response::new(audio))
}

/// TTS 合成请求的公共字段（供两种模式的辅助函数共享，避免超长参数列表）。
struct TtsAudioRequest<'a> {
    base_url: &'a str,
    api_key: &'a str,
    model: &'a str,
    voice: &'a str,
    speed: f64,
    text: &'a str,
}

/// 模式 1：标准 /audio/speech 端点，响应体即音频二进制。
async fn fetch_tts_speech_audio(
    client: &reqwest::Client,
    req: &TtsAudioRequest<'_>,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, AppError> {
    let url = audio_speech_url(req.base_url);
    let body = serde_json::json!({
        "model": req.model,
        "input": req.text,
        "voice": req.voice,
        "speed": req.speed,
        // 显式声明 mp3：兼容后端默认可能返回 wav/ogg 导致 MIME 失真（与旧前端一致）
        "response_format": "mp3",
    });
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .bearer_auth(req.api_key)
        .json(&body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("TTS 请求失败: {e}")))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let snippet = body_snippet(&response.text().await.unwrap_or_default());
        return Err(AppError::Network(format!(
            "TTS 请求失败: {status} {snippet}"
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Network(format!("TTS 请求失败: {e}")))?;
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(AppError::Network(format!(
            "TTS 音频过大（{} bytes）",
            bytes.len()
        )));
    }
    Ok(bytes.to_vec())
}

/// 模式 2：Chat Completions audio modality，响应为含 base64 音频的 JSON。
async fn fetch_tts_chat_audio(
    client: &reqwest::Client,
    req: &TtsAudioRequest<'_>,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, AppError> {
    let url = chat_completions_url(req.base_url);
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .bearer_auth(req.api_key)
        .json(&tts_chat_body(req.model, req.voice, req.speed, req.text))
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("TTS 请求失败: {e}")))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let snippet = body_snippet(&response.text().await.unwrap_or_default());
        return Err(AppError::Network(format!(
            "TTS 请求失败: {status} {snippet}"
        )));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::Network(format!("TTS 请求失败: 响应解析失败 {e}")))?;
    let data = json
        .pointer("/choices/0/message/audio/data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Network("TTS 响应格式无效，无法解析音频数据".into()))?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| AppError::Network(format!("TTS 音频 base64 解码失败: {e}")))?;
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(AppError::Network(format!(
            "TTS 音频过大（{} bytes）",
            bytes.len()
        )));
    }
    Ok(bytes)
}

/// 代理 ASR 语音转写（Chat Completions input_audio 模态），返回原始转写文本。
/// `<think>` 等思考块的清理仍由前端负责（与旧实现一致）。
/// 密钥由本命令自行从 OS Keychain 读取（与 TTS 共用），前端不传 Key。
#[tauri::command]
pub async fn db_transcribe_audio(
    client: State<'_, reqwest::Client>,
    base_url: String,
    model: String,
    language: String,
    audio_data_url: String,
    timeout_ms: Option<u64>,
) -> Result<String, AppError> {
    let api_key = tokio::task::spawn_blocking(tts_key_from_keychain)
        .await
        .map_err(|e| AppError::Network(format!("读取 ASR 密钥失败: {e}")))?;
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("asr api_key is not configured".into()));
    }
    if audio_data_url.len() > MAX_AUDIO_DATA_URL_BYTES {
        return Err(AppError::Validation("audio payload too large".into()));
    }
    let url = chat_completions_url(&base_url);
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(60_000));
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .bearer_auth(&api_key)
        .json(&asr_body(&model, &language, &audio_data_url))
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("语音识别请求失败: {e}")))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(AppError::Network(format!(
            "语音识别服务请求失败 ({status})"
        )));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::Network(format!("语音识别请求失败: 响应解析失败 {e}")))?;
    let content = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Network("ASR 响应格式无效，无法解析转写文本".into()))?;
    Ok(content.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_line_parses_token_with_and_without_space() {
        let mut full = String::new();
        // 带空格(标准写法)
        let (token, done) = process_sse_line(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}",
            &mut full,
        );
        assert_eq!(token.as_deref(), Some("Hello"));
        assert!(!done);
        // 无空格(E1 兼容)
        let (token2, done2) = process_sse_line(
            "data:{\"choices\":[{\"delta\":{\"content\":\" World\"}}]}",
            &mut full,
        );
        assert_eq!(token2.as_deref(), Some(" World"));
        assert!(!done2);
        assert_eq!(full, "Hello World");
    }

    #[test]
    fn sse_line_detects_done_marker() {
        let mut full = String::new();
        let (token, done) = process_sse_line("data: [DONE]", &mut full);
        assert!(token.is_none());
        assert!(done);
        let (_, done2) = process_sse_line("data:[DONE]", &mut full);
        assert!(done2);
    }

    #[test]
    fn sse_line_ignores_non_data_lines() {
        let mut full = String::new();
        let (token, done) = process_sse_line(": keep-alive comment", &mut full);
        assert!(token.is_none());
        assert!(!done);
        assert_eq!(full, "");
    }

    #[test]
    fn extract_lines_splits_complete_lines_and_keeps_tail() {
        let mut buffer = b"line1\nline2\npartial".to_vec();
        let lines = extract_lines(&mut buffer);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], b"line1");
        assert_eq!(lines[1], b"line2");
        // 残行保留在缓冲中
        assert_eq!(buffer, b"partial");
        // 残行补齐后再次提取
        buffer.extend_from_slice(b"-tail\n");
        let lines2 = extract_lines(&mut buffer);
        assert_eq!(lines2, vec![b"partial-tail".to_vec()]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn sse_line_preserves_multibyte_utf8_across_chunks() {
        // 模拟中文 token 被 TCP 分块切在字符中间:从完整行字节序列模拟两次喂入
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}";
        let bytes = line.as_bytes();
        let split = bytes.len() / 2; // 切在 UTF-8 序列中间
        let mut buffer = bytes[..split].to_vec();
        let _ = extract_lines(&mut buffer); // 第一次无完整行
        buffer.extend_from_slice(&bytes[split..]);
        buffer.push(b'\n');
        let lines = extract_lines(&mut buffer);
        assert_eq!(lines.len(), 1);
        let decoded =
            String::from_utf8(lines[0].clone()).expect("line should decode as valid UTF-8");
        let mut full = String::new();
        let (token, done) = process_sse_line(&decoded, &mut full);
        assert_eq!(token.as_deref(), Some("你好"));
        assert!(!done);
    }

    // ── 非流式代理：URL 推导与请求体构造 ──

    #[test]
    fn chat_completions_url_appends_only_when_missing() {
        assert_eq!(
            chat_completions_url("https://api.example.com/v1"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.example.com/v1/chat/completions"),
            "https://api.example.com/v1/chat/completions"
        );
        // 尾部斜杠先归一化再判断
        assert_eq!(
            chat_completions_url("  https://api.example.com/v1/  "),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn audio_speech_url_appends_only_when_missing() {
        assert_eq!(
            audio_speech_url("https://api.example.com/v1"),
            "https://api.example.com/v1/audio/speech"
        );
        assert_eq!(
            audio_speech_url("https://api.example.com/audio/speech"),
            "https://api.example.com/audio/speech"
        );
    }

    #[test]
    fn tts_chat_body_mimo_variant_omits_modalities() {
        let body = tts_chat_body("mimo-v2.5-tts", "alloy", 1.0, "hello");
        assert_eq!(body["messages"][0]["role"], "assistant");
        assert_eq!(body["messages"][0]["content"], "hello");
        assert_eq!(body["audio"]["voice"], "alloy");
        assert_eq!(body["audio"]["speed"], 1.0);
        assert!(body.get("modalities").is_none());
    }

    #[test]
    fn tts_chat_body_openai_variant_includes_modalities() {
        let body = tts_chat_body("gpt-4o-audio-preview", "alloy", 1.0, "hello");
        assert_eq!(body["modalities"], serde_json::json!(["text", "audio"]));
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body["audio"].get("speed").is_none());
    }

    #[test]
    fn asr_body_carries_input_audio_and_language() {
        let data_url = "data:audio/wav;base64,QUJD";
        let body = asr_body("mimo-v2.5-asr", "en", data_url);
        assert_eq!(body["model"], "mimo-v2.5-asr");
        assert_eq!(body["asr_options"]["language"], "en");
        let audio = &body["messages"][0]["content"][0]["input_audio"]["data"];
        assert_eq!(audio, data_url);
    }

    #[test]
    fn test_connection_body_is_minimal_probe() {
        let body = test_connection_body("gpt-4o-mini");
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["max_tokens"], 5);
        assert_eq!(body["messages"][0]["content"], "Hi");
    }

    #[test]
    fn body_snippet_truncates_by_chars_not_panic() {
        let long = "a".repeat(1000);
        assert_eq!(body_snippet(&long).chars().count(), 500);
        // 多字节字符按字符截断，不产生半字符
        let cjk = "你".repeat(600);
        assert_eq!(body_snippet(&cjk).chars().count(), 500);
    }
}
