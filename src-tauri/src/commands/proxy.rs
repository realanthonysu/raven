//! LLM 请求代理 —— 密钥不出主进程。
//!
//! A1: 此前 LLM 流式请求由 WebView 经 tauri-plugin-http 直连任意 HTTPS 端点，
//! 真实的 API Key 会下发到 WebView(脚本可读、可外传)。
//! 本模块把请求移到 Rust 侧:命令从 DB 读模型配置、从 OS Keychain 读密钥，
//! 用 reqwest 发起 SSE 流式请求,通过 [`tauri::ipc::Channel`] 把 token 推回前端。
//! 前端不再需要直连任意 HTTPS(见 capabilities 的 http scope 收窄)。
//!
//! 共享 reqwest Client（lib.rs）配置了 `Policy::none()` 重定向策略：跟随重定向
//! 可能把携带 API Key 的 Authorization 头转发到非预期主机，故一律禁用（详见
//! lib.rs 处的注释）。依赖重定向的供应商端点会收到非 2xx 响应并在此处报错。
//!
//! ## 密钥下发 WebView 的显式豁免清单
//!
//! "密钥不下发 WebView"是 LLM 流式请求路径的设计目标，以下三处是**刻意保留**
//! 的例外（前端需要明文 Key 完成自身功能，且不在流式代理的攻击面上）：
//! 1. `get_model_api_key`（commands/models.rs）——编辑表单预填已存 Key，
//!    仅在用户显式编辑单个模型时按 id 读取
//! 2. `db_get_tts_config`（commands/settings.rs）——设置表单预填真实 Key
//!    （编辑时可见）。其 Key 用途仅为设置表单预填与 TTS 试听路径（试听可传
//!    表单新输入 Key，或服务端从 OS Keychain 自读）；运行时正式 TTS/ASR 请求
//!    已移入本模块代理、配置与密钥均由代理命令服务端自读（前端不传 base_url），
//!    不再依赖该下发的 Key
//! 3. `db_get_default_model`（commands/models.rs）——默认模型查询回填明文 Key：
//!    WebView 降级请求路径（Rust 代理不可用时经 smartFetch 直连，http scope
//!    已收窄为本地回环，故仅对本地供应商可用）需要 Key 组装 Authorization 头，
//!    前端亦以 api_key 非空作为"已配置模型"判据
//!
//! 此外，`test_tts_audio`（TTS 试听命令，见下）接受前端传入的**表单新输入**明文
//! Key 以测试未保存的配置（亦可传 None 由服务端从 Keychain 自读），与
//! `test_llm_connection` 同属"测试未保存配置"刚需；该命令已登记进豁免/受控列表，
//! 不视为违反本清单。
//!
//! 新增返回密钥的命令时必须在此清单登记，否则视为违反威胁模型。
//!
//! 另注：代理命令经 `credentials` 模块读取的密钥在进程内持有 5min TTL 读缓存
//! （写/删路径立即回写，见 credentials.rs），仅用于削减 Keychain 高频读延迟，
//! 不涉及密钥下发 WebView。

use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;
use url::Host;

use crate::commands::sse::{ProxyEvent, pump_sse_stream};
use crate::credentials;
use crate::db::Db;
use crate::dto::TtsConfigDto;
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

/// 判断 base_url 是否指向本地回环地址（localhost / 127.0.0.0-127.255.255.255 / [::1]）。
///
/// 与连接测试路径（`test_llm_connection`）的空 Key 语义对齐：本地推理服务
/// （Ollama 等）无需 Key，流式代理同样放行；远程地址仍要求 Key。
/// 解析失败的 URL 一律按远程处理（要求 Key），避免放宽校验。
fn is_loopback_base_url(base_url: &str) -> bool {
    let Some(authority) = extract_host(base_url) else {
        return false;
    };
    // 去掉 userinfo（如 user:pass@host）与端口（IPv6 方括号形式除外）
    let after_userinfo = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if after_userinfo.starts_with('[') {
        // [::1]:11434 → 取到 ']' 为止
        let end = after_userinfo.find(']').unwrap_or(after_userinfo.len());
        &after_userinfo[..=end]
    } else {
        after_userinfo.split(':').next().unwrap_or(after_userinfo)
    };
    match host.to_ascii_lowercase().as_str() {
        "localhost" => true,
        "[::1]" => true,
        _ => {
            let octets: Option<Vec<u8>> = host.split('.').map(|p| p.parse::<u8>().ok()).collect();
            matches!(octets.as_deref(), Some([127, _, _, _]))
        }
    }
}

/// 从 URL 中粗略提取主机名（含端口/IPv6 方括号形式）。
///
/// 本模块仅需判断"是否回环"，故不引入完整 URL 解析器：
/// 截取 scheme 之后、首个 `/ ? #` 之前的部分即为主机段。
fn extract_host(url: &str) -> Option<&str> {
    let after_scheme = match url.split_once("://") {
        Some((_, rest)) => rest,
        None => url,
    };
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    if authority.is_empty() {
        return None;
    }
    Some(authority)
}

/// 校验代理命令允许访问的 URL（SSRF 防护）：仅 http/https scheme，且目标不允许
/// 是私网段/链路本地地址（被入侵的前端可借此把请求打到内网、云元数据端点等）。
///
/// - 放行回环（127.0.0.0/8、[::1]、localhost）以兼容本地 Ollama 等推理服务
/// - 拒绝 RFC1918 私网（10/8、172.16/12、192.168/16）、链路本地 169.254/16 与
///   未指定地址 0.0.0.0（Windows 上连接它等价回环，且语义上不指向任何目标）
/// - 拒绝 IPv6 唯一本地地址（fc00::/7）、链路本地（fe80::/10）与未指定地址
///   `::`，放行 [::1]
/// - IPv4-mapped IPv6（`::ffff:0:0/96`，如 `[::ffff:10.0.0.1]`）不属于
///   loopback/unique-local/link-local 中的任何一类，若只按 IPv6 规则判定会被
///   放行；而双栈系统上连接这类地址实际直达内嵌的 IPv4 目标（可打到内网/
///   云元数据端点），故先还原出内嵌 IPv4、按 IPv4 同一规则复检（见
///   [`judge_ipv4_address`]）
/// - DNS 名称的解析发生在 reqwest 侧，Rust 侧无法可靠判断解析目标，按现状放行
///   （域名类保持原行为，仅对裸 IP 的私网段做保守拒绝）
///
/// 用 url crate 做 WHATWG 规范解析：正确归一化 IPv6 方括号、端口、userinfo，
/// 以及 IPv4 的十六进制/八进制/单整数写法（如 0x7f000001 归一化为 127.0.0.1、
/// 2130706433 归一化为 127.0.0.1），避免手写字符串解析被绕过。
/// IPv4 地址判定（Ipv4 分支与 v4-mapped IPv6 复检共用，保证两边规则完全一致）：
/// 回环放行（本地推理服务兼容），未指定/私网/链路本地拒绝，其余放行。
fn judge_ipv4_address(ip: Ipv4Addr) -> Result<(), AppError> {
    if ip.is_loopback() {
        Ok(())
    } else if ip.is_unspecified() {
        // 0.0.0.0：Windows 上连接等价回环，拒绝以免借通配地址直连本机服务
        Err(AppError::Validation(format!("禁止访问未指定地址 {ip}")))
    } else if ip.is_private() || ip.is_link_local() {
        Err(AppError::Validation(format!("禁止访问私网地址 {ip}")))
    } else {
        Ok(())
    }
}

fn validate_proxy_url(raw: &str) -> Result<(), AppError> {
    let parsed =
        url::Url::parse(raw).map_err(|_| AppError::Validation("base_url 不是合法 URL".into()))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => {
            return Err(AppError::Validation(format!(
                "base_url 仅支持 http/https，当前为 {s}"
            )));
        }
    }
    let Some(host) = parsed.host() else {
        return Err(AppError::Validation("base_url 缺少 host".into()));
    };
    match host {
        Host::Domain(domain) => {
            // localhost 由系统解析到回环，放行以兼容本地推理服务；其余域名放行
            if domain.eq_ignore_ascii_case("localhost") {
                return Ok(());
            }
            Ok(())
        }
        Host::Ipv4(ip) => judge_ipv4_address(ip),
        Host::Ipv6(ip) => {
            // IPv4-mapped IPv6（::ffff:a.b.c.d）先还原内嵌 IPv4、按 IPv4 同一
            // 规则复检——它不属于 IPv6 的 loopback/unique-local/link-local，
            // 只查这三项会被 [::ffff:169.254.169.254] 之类绕过（双栈系统上
            // 连接即直达对应 IPv4 内网地址）。
            if let Some(v4) = ip.to_ipv4_mapped() {
                judge_ipv4_address(v4)
            } else if ip.is_unspecified() {
                // `::` 未指定地址，语义上不指向任何目标，拒绝
                Err(AppError::Validation("禁止访问未指定地址 ::".into()))
            } else if ip.is_loopback() {
                Ok(())
            } else if ip.is_unique_local() || ip.is_unicast_link_local() {
                Err(AppError::Validation(format!("禁止访问私网地址 {ip}")))
            } else {
                Ok(())
            }
        }
    }
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
pub async fn stream_chat_completions(
    db: State<'_, Db>,
    client: State<'_, reqwest::Client>,
    model_id: i64,
    messages: Vec<ProxyMessage>,
    timeout_ms: Option<u64>,
    on_event: Channel<ProxyEvent>,
) -> Result<(), AppError> {
    validate_stream_messages(&messages)?;

    let (base_url, api_key, model_name) = load_model_config(&db, model_id).await?;

    // B-2 两步 SSRF 修复：models.base_url 同样可被 WebView 写入后再触发本命令，
    // 故 DB 自读配置仍强制 validate_proxy_url（拒绝私网段、放行回环）。
    validate_proxy_url(&base_url)?;

    // 空 Key 仅对本地回环供应商放行（与连接测试路径语义一致）；远程仍拒绝
    if api_key.is_empty() && !is_loopback_base_url(&base_url) {
        return Err(AppError::Validation(
            "model api_key is not configured".into(),
        ));
    }

    // 与旧实现一致:始终追加 /chat/completions(不使用 chat_completions_url 的去重逻辑)
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model_name,
        "messages": messages
            .into_iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": true,
    });
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(120_000));

    run_stream(
        client.inner().clone(),
        url,
        api_key,
        body,
        timeout,
        &on_event,
    )
    .await
}

/// 校验流式请求参数：消息非空且总体积不超限。
fn validate_stream_messages(messages: &[ProxyMessage]) -> Result<(), AppError> {
    if messages.is_empty() {
        return Err(AppError::Validation("messages cannot be empty".into()));
    }
    let messages_bytes: usize = messages.iter().map(|m| m.content.len()).sum();
    if messages_bytes > MAX_MESSAGES_BYTES {
        return Err(AppError::Validation(format!(
            "request body too large ({messages_bytes} bytes, max {MAX_MESSAGES_BYTES})"
        )));
    }
    Ok(())
}

/// 从 DB 读取模型配置(spawn_blocking:Keychain + SQLite 都是同步 IO)。
async fn load_model_config(
    db: &State<'_, Db>,
    model_id: i64,
) -> Result<(String, String, String), AppError> {
    let pool = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool
            .get()
            .map_err(|e| AppError::Database(format!("DB pool error: {e}")))?;
        let model = models::get_model_by_id(&conn, model_id)?
            .ok_or_else(|| AppError::Validation(format!("model {model_id} not found")))?;
        Ok::<_, AppError>((model.base_url, model.api_key, model.model_name))
    })
    .await
    .map_err(|e| AppError::Database(format!("model load task panicked: {e}")))?
}

/// 从 DB settings 表 + OS Keychain 读取完整 TTS 配置
/// （spawn_blocking：Keychain + SQLite 都是同步 IO）。
/// B-2：正式 TTS/ASR 代理命令（fetch_tts_audio / transcribe_audio）的配置与密钥
/// 均服务端自读，前端不再传 base_url/model/voice。
async fn load_tts_config(db: &State<'_, Db>) -> Result<TtsConfigDto, AppError> {
    let pool = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool
            .get()
            .map_err(|e| AppError::Database(format!("DB pool error: {e}")))?;
        crate::commands::settings::build_tts_config(&conn, crate::credentials::get_tts_key)
    })
    .await
    .map_err(|e| AppError::Database(format!("tts config load task panicked: {e}")))?
}

/// 执行 SSE 流式请求并把事件推回前端。
///
/// 业务错误通过 [`ProxyEvent::Error`] 传达且命令返回 `Ok` —— 若返回 Err，
/// invoke reject 与 Error 事件会竞态，前端可能走"降级"路径重复发送请求。
async fn run_stream(
    client: reqwest::Client,
    url: String,
    api_key: String,
    body: serde_json::Value,
    timeout: std::time::Duration,
    on_event: &Channel<ProxyEvent>,
) -> Result<(), AppError> {
    // tokio::time::timeout 兜底:即使服务端挂起也能结束命令
    // （不复用 post_json 的三点刻意差异：① 空 Key 判断不含 trim 且回环放行；
    //   ② 不设 per-request .timeout()，整体超时由外层 tokio 兜底并输出专用文案；
    //   ③ 非 2xx 错误附完整响应体且状态码用 Display 格式，与 TTS/ASR 的
    //   u16+snippet 文案不同；错误最终经 Channel 事件上报而非返回 Err）
    let outcome = tokio::time::timeout(timeout, async {
        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body);
        // 本地供应商（Ollama 等）无 Key:空 Key 不发送 Authorization 头（与连接测试一致）
        if !api_key.is_empty() {
            request = request.bearer_auth(&api_key);
        }
        let response = request
            .send()
            .await
            .map_err(|e| AppError::Network(format!("LLM request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            // 有限读取 + body_snippet 截断：完整响应体既会无界占用内存，也会被
            // 整个嵌进错误消息经 Channel 发往 WebView（与 post_json 的 snippet 策略一致）
            let snippet =
                match read_body_limited(response, MAX_ERROR_BODY_BYTES, "LLM 请求失败").await {
                    Ok(body) => body_snippet(&body),
                    Err(_) => String::new(),
                };
            return Err(AppError::Network(format!(
                "LLM API error: {status} {snippet}"
            )));
        }

        pump_sse_stream(response, on_event).await
    })
    .await;

    match outcome {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            send_proxy_error(on_event, e.to_string());
            Ok(())
        }
        Err(_) => {
            send_proxy_error(
                on_event,
                format!("LLM request timed out ({}s)", timeout.as_secs()),
            );
            Ok(())
        }
    }
}

/// 通过 Channel 向前端上报业务错误(发送失败静默忽略:Channel 已失效即无接收方)。
fn send_proxy_error(on_event: &Channel<ProxyEvent>, message: String) {
    let _ = on_event.send(ProxyEvent::Error { message });
}

// ============================================================================
// 非流式代理（A1 扩展）：连接测试 / TTS / ASR
// ============================================================================
// 此前这三条路径由 WebView 经 tauri-plugin-http 直连远程 API，依赖 capabilities
// 放行 `https://**`。http scope 收窄为本地回环后，WebView 直连对远程供应商全部
// 失效，故统一移入 Rust 侧，由主进程 reqwest 发起请求。
// B-2（SSRF 修复）：正式 TTS/ASR 请求（fetch_tts_audio / transcribe_audio）的
// 配置（base_url/model/voice）与密钥均**服务端自读**（DB settings 表 + OS
// Keychain），前端仅传文本/音频/语速覆盖等参数——被入侵的前端不再能向任意
// 内网地址发起代理请求。唯一例外是 TTS 试听命令 `test_tts_audio`：它接受前端
// 传入**未保存的** base_url 与表单新输入的 api_key（与 test_llm_connection
// 同属"测试未保存配置"刚需），该路径经 validate_proxy_url 做私网段校验。
// 注意：invoke 无法中止命令执行，前端 abort 只能放弃结果（Rust 侧请求跑完后
// 被丢弃）——与 stream_chat_completions 的中止语义一致。

/// 单个音频响应的最大字节数（防御异常服务端返回超大 body）。
const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;

/// ASR 音频 data URL 的最大长度（60s 16bit 单声道 WAV base64 后约 8MB，留足余量）。
const MAX_AUDIO_DATA_URL_BYTES: usize = 32 * 1024 * 1024;

/// 连接测试响应体上限（远大于正常 chat completion 响应，仅防异常超大 body；
/// 前端需要完整 JSON 做 choices 结构校验，故不能截断到错误消息级别）。
const MAX_TEST_CONNECTION_BODY_BYTES: usize = 64 * 1024;

/// Chat Completions audio modality 响应 JSON 的上限：base64 编码体积约为解码后
/// 音频的 4/3（每 6 bit 一个字节），故在 MAX_AUDIO_BYTES 基础上按此系数放大，
/// 并留出 choices/message 等 JSON 结构包装的余量。
const MAX_TTS_JSON_BYTES: usize = MAX_AUDIO_BYTES + MAX_AUDIO_BYTES / 3 + 64 * 1024;

/// ASR 转写响应 JSON 的上限：转写文本远小于输入音频，4MB 已是极大余量
/// （仅防御恶意端点返回异常超大 body）。
const MAX_ASR_JSON_BYTES: usize = 4 * 1024 * 1024;

/// 非 2xx 错误响应体的读取上限：与 body_snippet 的 500 字符策略配套——先按
/// 字节上限读取，再由 body_snippet 截断到 500 字符，避免把超大 body 整个读进
/// 内存/塞进错误消息（500 个 CJK 字符约 1500 字节，4096 字节足余）。
const MAX_ERROR_BODY_BYTES: usize = 4096;

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

/// 有限读取响应体为 UTF-8 文本（边读边计数，超限立即断开并报错）。
///
/// 与 fetch_tts_speech_audio 的 bytes_stream 防御模式一致：response.text() /
/// response.json() 会把整个 body 读进内存后才做上限校验，恶意端点可在超时
/// 窗口内无界发送数据耗尽内存。此处逐块累积并检查累计字节数，一旦超限
/// 立即终止读取。
async fn read_body_limited(
    response: reqwest::Response,
    max_bytes: usize,
    err_label: &str,
) -> Result<String, AppError> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Network(format!("{err_label}: {e}")))?;
        if body.len() + chunk.len() > max_bytes {
            return Err(AppError::Network(format!(
                "{err_label}: 响应体过大（超过 {max_bytes} bytes 上限）"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// 非流式 JSON POST 的公共路径：构建请求（Content-Type + 可选 bearer + 按请求超时）
/// → 发送 → 非 2xx 时报错并附响应体片段，成功则原样返回 Response，由调用方按各自
/// 方式消费（音频二进制 bytes_stream / base64 JSON / 转写文本 JSON 各不相同）。
///
/// 折叠 fetch_tts_speech_audio、fetch_tts_chat_audio、transcribe_audio 三处几乎
/// 逐字重复的 build→send→status→snippet 块（commit 197f059 曾为同步三处文案漂移
/// 付过一次手工成本，此后新增代理路径应复用本函数而非再复制一份）。
///
/// # Arguments
///
/// * `api_key` - `None` 或空白串时不发送 Authorization 头（本地推理服务 Ollama 等
///   无 Key，与连接测试路径语义一致）；TTS/ASR 调用方已预校验 Key 非空，恒发 bearer。
/// * `send_err_label` / `status_err_label` - 两阶段错误文案分开传：ASR 路径两处措辞
///   本就不同（"语音识别请求失败" / "语音识别服务请求失败"），为保持下发给前端的
///   既有文案字节级不变，不在帮助函数内强行统一。
async fn post_json(
    client: &reqwest::Client,
    url: &str,
    api_key: Option<&str>,
    body: &serde_json::Value,
    timeout: std::time::Duration,
    send_err_label: &str,
    status_err_label: &str,
) -> Result<reqwest::Response, AppError> {
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(body)
        .timeout(timeout);
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|e| AppError::Network(format!("{send_err_label}: {e}")))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        // 有限读取错误响应体片段（再经 body_snippet 截断到 500 字符）：
        // response.text() 会把整个错误 body 读进内存后才截断，恶意端点可用
        // 超大错误响应耗尽内存，故复用 read_body_limited 的边读边计数。
        let snippet =
            match read_body_limited(response, MAX_ERROR_BODY_BYTES, status_err_label).await {
                Ok(body) => body_snippet(&body),
                Err(_) => String::new(),
            };
        return Err(AppError::Network(format!(
            "{status_err_label}: {status} {snippet}"
        )));
    }
    Ok(response)
}

/// 连接测试探活请求体（与旧前端实现一致：最小 chat completion）。
fn test_connection_body(model_name: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model_name,
        "messages": [{ "role": "user", "content": "Hi" }],
        "max_tokens": 5,
    })
}

/// TTS 协议方言：决定 Chat Completions audio 请求体的形状。
///
/// 不再用 `model.starts_with("mimo")` 字符串前缀猜测——换代模型（如 mimo-v3）
/// 或自定义部署别名会静默走错分支。由 settings 表的 `tts_dialect` 显式声明。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TtsDialect {
    /// MiMo：assistant 消息携带待朗读文本，无 modalities 字段
    #[default]
    Mimo,
    /// OpenAI（GPT-4o-audio-preview 等）：user 消息 + modalities 字段
    OpenAi,
}

impl TtsDialect {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "openai" | "open_ai" | "gpt" => Self::OpenAi,
            // 默认 MiMo（本应用完全基于 MiMo 模型生态）；"mimo" 与空/未知均归此
            _ => Self::Mimo,
        }
    }

    /// 与 `parse` 对称的序列化出口；目前仅测试与调试引用（保留公开 API）。
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Mimo => "mimo",
            Self::OpenAi => "openai",
        }
    }
}

/// TTS Chat Completions audio modality 请求体。
/// 方言差异（与旧前端实现一致）：
/// - MiMo：assistant 消息携带待朗读文本，无 modalities 字段
/// - OpenAI（GPT-4o-audio-preview 等）：user 消息 + modalities 字段
fn tts_chat_body(
    dialect: TtsDialect,
    model: &str,
    voice: &str,
    speed: f64,
    text: &str,
) -> serde_json::Value {
    match dialect {
        TtsDialect::Mimo => serde_json::json!({
            "model": model,
            "messages": [{ "role": "assistant", "content": text }],
            "audio": { "voice": voice, "format": "mp3", "speed": speed },
        }),
        TtsDialect::OpenAi => serde_json::json!({
            "model": model,
            "modalities": ["text", "audio"],
            "audio": { "voice": voice, "format": "mp3" },
            "messages": [{ "role": "user", "content": text }],
        }),
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
pub async fn test_llm_connection(
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
    // B-1: SSRF 防护——测试未保存的配置是刚需，URL 必须由前端传入，但仅允许
    // http/https 且拒绝私网段（放行回环以兼容本地 Ollama 等）。
    validate_proxy_url(&base_url)?;
    let url = chat_completions_url(&base_url);
    // 不复用 post_json：本命令只做传输探活，非 2xx 不是错误——状态码与完整响应体
    // 原样交由前端做业务校验（保持旧版 UX 文案），不能走"非 2xx 即报错"的公共路径。
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
    // 有限读取响应体并限制到 MAX_TEST_CONNECTION_BODY_BYTES：response.text()
    // 会先把整个 body 读进内存后才截断，恶意端点可用超大响应耗尽内存
    let body = read_body_limited(response, MAX_TEST_CONNECTION_BODY_BYTES, "连接失败").await?;
    Ok(TestConnectionResult { status, body })
}

/// 代理 TTS 音频合成，返回原始音频字节（mp3）。
///
/// 支持两种 OpenAI 兼容模式（与旧前端实现一致）：
/// 1. `{base}/audio/speech` —— 标准 TTS 端点，响应即音频二进制
/// 2. base 以 /chat/completions 结尾 —— audio modality，响应为含 base64
///    音频的 JSON（mimo / GPT-4o-audio-preview 等）
///
/// B-2（SSRF 修复）：配置与密钥均**服务端自读**（[`load_tts_config`] 从 DB
/// settings 表 + OS Keychain 读取），前端仅传文本与语速覆盖参数（useAudioPlayer
/// 的速度覆盖或 DB 默认值），不再传 base_url/model/voice。
#[tauri::command]
pub async fn fetch_tts_audio(
    db: State<'_, Db>,
    client: State<'_, reqwest::Client>,
    text: String,
    speed: f64,
    timeout_ms: Option<u64>,
) -> Result<tauri::ipc::Response, AppError> {
    let config = load_tts_config(&db).await?;
    if config.api_key.trim().is_empty() {
        return Err(AppError::Validation("tts api_key is not configured".into()));
    }
    // B-2 两步 SSRF 修复：配置虽来自 DB settings 表，但被入侵 WebView 可先经
    // db_set_tts_settings_batch 写入内网 base_url，再触发本命令形成两步 SSRF。
    // 故服务端自读配置后仍强制 validate_proxy_url（拒绝私网段、放行回环）。
    validate_proxy_url(&config.base_url)?;
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(60_000));
    let req = TtsAudioRequest {
        base_url: &config.base_url,
        api_key: &config.api_key,
        model: &config.model,
        voice: &config.voice,
        speed,
        text: &text,
        dialect: TtsDialect::parse(&config.dialect),
    };
    let audio = if normalize_base(&config.base_url).ends_with("/chat/completions") {
        fetch_tts_chat_audio(&client, &req, timeout).await
    } else {
        fetch_tts_speech_audio(&client, &req, timeout).await
    }?;
    Ok(tauri::ipc::Response::new(audio))
}

/// `test_tts_audio` 的入参结构：前端把"测试未保存的 TTS 配置"整体传入，由
/// Tauri 反序列化（参考 NewWordInput 模式，commands/shared.rs）——6 个独立参数
/// 加上 client/timeout_ms 会超过 clippy::too_many_arguments 阈值 7，故打包为结构体。
#[derive(Debug, Deserialize)]
pub struct TestTtsInput {
    pub base_url: String,
    /// 表单新输入 Key 时前端传入；`None`/空白则服务端从 OS Keychain 自读
    pub api_key: Option<String>,
    pub model: String,
    pub voice: String,
    pub speed: f64,
    pub text: String,
    /// TTS 协议方言（"mimo" | "openai"）；缺省按 MiMo 处理
    pub dialect: Option<String>,
}

/// TTS 试听命令：合成设置页表单中**未保存的** TTS 配置，返回原始音频字节（mp3）。
///
/// B-2：试听"测试未保存配置"是刚需，base_url 必须由前端传入（与
/// [`test_llm_connection`] 同策略），故经 [`validate_proxy_url`] 做 SSRF 校验——
/// 仅允许 http/https 且拒绝私网段（放行回环以兼容本地推理服务）。
/// api_key 语义：表单新输入 Key 时前端传明文；未修改 Key 字段时传 `None`，
/// 由服务端从 OS Keychain 自读（对应沿用已保存 Key 的场景）。
#[tauri::command]
pub async fn test_tts_audio(
    client: State<'_, reqwest::Client>,
    input: TestTtsInput,
    timeout_ms: Option<u64>,
) -> Result<tauri::ipc::Response, AppError> {
    if input.base_url.trim().is_empty() {
        return Err(AppError::Validation("base_url cannot be empty".into()));
    }
    // B-2: 试听接受前端传未保存的 base_url，与 test_llm_connection 同属"测试未
    // 保存配置"刚需，需经私网段校验（正式 TTS 命令 fetch_tts_audio 已服务端自读
    // 配置，不在本攻击面上）。
    validate_proxy_url(&input.base_url)?;
    let api_key = match input.api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            // 前端未传（表单 Key 未改动）→ 服务端从 OS Keychain 自读
            tokio::task::spawn_blocking(tts_key_from_keychain)
                .await
                .map_err(|e| AppError::Network(format!("读取 TTS 密钥失败: {e}")))?
        }
    };
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("tts api_key is not configured".into()));
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(60_000));
    let req = TtsAudioRequest {
        base_url: &input.base_url,
        api_key: &api_key,
        model: &input.model,
        voice: &input.voice,
        speed: input.speed,
        text: &input.text,
        dialect: TtsDialect::parse(input.dialect.as_deref().unwrap_or("")),
    };
    let audio = if normalize_base(&input.base_url).ends_with("/chat/completions") {
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
    dialect: TtsDialect,
}

/// 模式 1：标准 /audio/speech 端点，响应体即音频二进制。
async fn fetch_tts_speech_audio(
    client: &reqwest::Client,
    req: &TtsAudioRequest<'_>,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, AppError> {
    let response = post_json(
        client,
        &audio_speech_url(req.base_url),
        Some(req.api_key),
        &serde_json::json!({
            "model": req.model,
            "input": req.text,
            "voice": req.voice,
            "speed": req.speed,
            // 显式声明 mp3：兼容后端默认可能返回 wav/ogg 导致 MIME 失真（与旧前端一致）
            "response_format": "mp3",
        }),
        timeout,
        "TTS 请求失败",
        "TTS 请求失败",
    )
    .await?;
    // 流式累积并逐块检查字节上限：response.bytes() 会把整个 body 读进内存后才
    // 校验上限，恶意服务端可借超大响应耗尽内存。bytes_stream 边收边计数，
    // 一旦超限立即中断读取。
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut audio: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Network(format!("TTS 请求失败: {e}")))?;
        if audio.len() + chunk.len() > MAX_AUDIO_BYTES {
            return Err(AppError::Network(format!(
                "TTS 音频过大（超过 {MAX_AUDIO_BYTES} bytes 上限）"
            )));
        }
        audio.extend_from_slice(&chunk);
    }
    Ok(audio)
}

/// 模式 2：Chat Completions audio modality，响应为含 base64 音频的 JSON。
async fn fetch_tts_chat_audio(
    client: &reqwest::Client,
    req: &TtsAudioRequest<'_>,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, AppError> {
    let response = post_json(
        client,
        &chat_completions_url(req.base_url),
        Some(req.api_key),
        &tts_chat_body(req.dialect, req.model, req.voice, req.speed, req.text),
        timeout,
        "TTS 请求失败",
        "TTS 请求失败",
    )
    .await?;
    // 有限读取响应体再解析 JSON：response.json() 会把整个 body 读进内存后才解析，
    // 恶意端点可用超大 JSON 耗尽内存。base64 体积约为音频的 4/3，上限按此系数
    // 放大（见 MAX_TTS_JSON_BYTES）。
    let body = read_body_limited(response, MAX_TTS_JSON_BYTES, "TTS 请求失败").await?;
    let json: serde_json::Value = serde_json::from_str(&body)
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
/// B-2（SSRF 修复）：配置与密钥均**服务端自读**（[`load_tts_config`]），前端仅传
/// 模型覆盖（VoiceCard 试听未保存的 asrModel）、语言与音频数据，不再传 base_url。
#[tauri::command]
pub async fn transcribe_audio(
    db: State<'_, Db>,
    client: State<'_, reqwest::Client>,
    model: String,
    language: String,
    audio_data_url: String,
    timeout_ms: Option<u64>,
) -> Result<String, AppError> {
    let config = load_tts_config(&db).await?;
    if config.api_key.trim().is_empty() {
        return Err(AppError::Validation("asr api_key is not configured".into()));
    }
    if audio_data_url.len() > MAX_AUDIO_DATA_URL_BYTES {
        return Err(AppError::Validation("audio payload too large".into()));
    }
    // B-2 两步 SSRF 修复：与 fetch_tts_audio 相同——DB 自读 base_url 仍须过
    // validate_proxy_url，阻断「写 settings → 触发代理」的两步 SSRF 路径。
    validate_proxy_url(&config.base_url)?;
    let url = chat_completions_url(&config.base_url);
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(60_000));
    // 两段错误文案沿用历史措辞（发送失败无"服务"二字、状态码失败有），保持字节级不变
    let response = post_json(
        &client,
        &url,
        Some(config.api_key.as_str()),
        &asr_body(&model, &language, &audio_data_url),
        timeout,
        "语音识别请求失败",
        "语音识别服务请求失败",
    )
    .await?;
    // 有限读取响应体再解析 JSON（与 TTS 路径同一防御：防恶意端点超大 body）
    let body = read_body_limited(response, MAX_ASR_JSON_BYTES, "语音识别请求失败").await?;
    let json: serde_json::Value = serde_json::from_str(&body)
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
        let body = tts_chat_body(TtsDialect::Mimo, "mimo-v2.5-tts", "alloy", 1.0, "hello");
        assert_eq!(body["messages"][0]["role"], "assistant");
        assert_eq!(body["messages"][0]["content"], "hello");
        assert_eq!(body["audio"]["voice"], "alloy");
        assert_eq!(body["audio"]["speed"], 1.0);
        assert!(body.get("modalities").is_none());
    }

    #[test]
    fn tts_chat_body_openai_variant_includes_modalities() {
        let body = tts_chat_body(
            TtsDialect::OpenAi,
            "gpt-4o-audio-preview",
            "alloy",
            1.0,
            "hello",
        );
        assert_eq!(body["modalities"], serde_json::json!(["text", "audio"]));
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body["audio"].get("speed").is_none());
    }

    #[test]
    fn tts_dialect_parse_defaults_to_mimo() {
        assert_eq!(TtsDialect::parse("mimo"), TtsDialect::Mimo);
        assert_eq!(TtsDialect::parse(""), TtsDialect::Mimo);
        assert_eq!(TtsDialect::parse("unknown-vendor"), TtsDialect::Mimo);
        // 自定义部署别名不再走 OpenAI 分支——由 tts_dialect 显式声明
        assert_eq!(TtsDialect::parse("my-tts-alias"), TtsDialect::Mimo);
    }

    #[test]
    fn tts_dialect_parse_openai_aliases() {
        assert_eq!(TtsDialect::parse("openai"), TtsDialect::OpenAi);
        assert_eq!(TtsDialect::parse("OpenAI"), TtsDialect::OpenAi);
        assert_eq!(TtsDialect::parse("gpt"), TtsDialect::OpenAi);
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

    // ── 空 Key 语义：本地回环供应商放行，远程仍要求 Key ──

    #[test]
    fn loopback_base_urls_are_detected() {
        assert!(is_loopback_base_url("http://localhost:11434/v1"));
        assert!(is_loopback_base_url("http://localhost/v1"));
        assert!(is_loopback_base_url("http://127.0.0.1:8080"));
        assert!(is_loopback_base_url("http://127.0.0.1"));
        assert!(is_loopback_base_url("https://127.9.9.9/v1")); // 127/8 整段回环
        assert!(is_loopback_base_url("http://[::1]:11434"));
        assert!(is_loopback_base_url("localhost:11434")); // 无 scheme 写法
    }

    #[test]
    fn remote_base_urls_require_key() {
        assert!(!is_loopback_base_url("https://api.openai.com/v1"));
        assert!(!is_loopback_base_url("https://api.deepseek.com"));
        // 127 前缀伪装的公网地址（127.0.0.1.evil.com）不是纯 IPv4，按远程处理
        assert!(!is_loopback_base_url("http://127.0.0.1.evil.com"));
        assert!(!is_loopback_base_url("http://10.0.0.1"));
        assert!(!is_loopback_base_url("http://192.168.1.1:11434"));
        // 解析失败一律按远程（要求 Key），避免放宽校验
        assert!(!is_loopback_base_url(""));
        assert!(!is_loopback_base_url("not a url"));
        assert!(!is_loopback_base_url("http://"));
    }

    // ── B: validate_proxy_url（SSRF 防护：http/https + 拒绝私网段 + 放行回环）──

    #[test]
    fn proxy_url_allows_public_domains_and_loopback() {
        assert!(validate_proxy_url("https://api.openai.com/v1").is_ok());
        assert!(validate_proxy_url("https://api.deepseek.com/chat/completions").is_ok());
        assert!(validate_proxy_url("https://api.openai.com:8443/v1").is_ok());
        // 本地推理服务（Ollama 等）回环放行
        assert!(validate_proxy_url("http://localhost:11434/v1").is_ok());
        assert!(validate_proxy_url("http://127.0.0.1:8080").is_ok());
        assert!(validate_proxy_url("http://[::1]:11434").is_ok());
        // WHATWG 归一化：0x7f000001 与 2130706433 都归一化为 127.0.0.1（回环放行）
        assert!(validate_proxy_url("http://0x7f000001/v1").is_ok());
        assert!(validate_proxy_url("http://2130706433/v1").is_ok());
    }

    #[test]
    fn proxy_url_rejects_private_and_bad_schemes() {
        // RFC1918 私网段
        assert!(validate_proxy_url("http://10.0.0.1/v1").is_err());
        assert!(validate_proxy_url("http://172.16.0.1/v1").is_err());
        assert!(validate_proxy_url("http://172.31.255.254/v1").is_err());
        assert!(validate_proxy_url("http://192.168.1.1:11434/v1").is_err());
        // 链路本地（云元数据端点 169.254.169.254 是典型 SSRF 目标）
        assert!(validate_proxy_url("http://169.254.169.254/latest/meta-data").is_err());
        // WHATWG 归一化后落入私网也应被拒绝（3232235777 = 192.168.1.1）
        assert!(validate_proxy_url("http://3232235777/v1").is_err());
        // IPv6 唯一本地/链路本地
        assert!(validate_proxy_url("http://[fd00::1]/v1").is_err());
        assert!(validate_proxy_url("http://[fe80::1]/v1").is_err());
        // 非 http/https scheme 与非法 URL
        assert!(validate_proxy_url("ftp://example.com/v1").is_err());
        assert!(validate_proxy_url("file:///etc/passwd").is_err());
        assert!(validate_proxy_url("not a url").is_err());
        assert!(validate_proxy_url("http://").is_err());
    }

    #[test]
    fn proxy_url_rejects_ipv4_mapped_ipv6() {
        // ::ffff:0:0/96 内嵌 IPv4，双栈系统上连接即直达对应 IPv4 地址：
        // 私网/链路本地（云元数据端点）必须按 IPv4 规则复检后拒绝
        assert!(validate_proxy_url("http://[::ffff:169.254.169.254]/").is_err());
        assert!(validate_proxy_url("http://[::ffff:10.0.0.1]/").is_err());
        assert!(validate_proxy_url("http://[::ffff:192.168.1.1]/").is_err());
        // v4-mapped 的未指定地址同样拒绝
        assert!(validate_proxy_url("http://[::ffff:0.0.0.0]/").is_err());
    }

    #[test]
    fn proxy_url_allows_mapped_and_native_ipv6_loopback() {
        // v4-mapped 回环按 IPv4 规则放行（本地推理服务兼容语义不变）
        assert!(validate_proxy_url("http://[::ffff:127.0.0.1]/").is_ok());
        // 原生 IPv6 回环仍放行
        assert!(validate_proxy_url("http://[::1]/").is_ok());
    }

    #[test]
    fn proxy_url_rejects_unspecified_and_allows_public() {
        // 未指定地址：0.0.0.0（Windows 上连接等价回环）与 :: 一并拒绝
        assert!(validate_proxy_url("http://0.0.0.0/").is_err());
        assert!(validate_proxy_url("http://[::]/").is_err());
        // 公网 IPv4 与 localhost 域名放行
        assert!(validate_proxy_url("http://8.8.8.8/").is_ok());
        assert!(validate_proxy_url("http://localhost/").is_ok());
    }
}
