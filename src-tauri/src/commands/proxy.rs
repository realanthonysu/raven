//! LLM 请求代理 —— 密钥不出主进程。
//!
//! A1: 此前 LLM 流式请求由 WebView 经 tauri-plugin-http 直连任意 HTTPS 端点，
//! 真实的 API Key 会下发到 WebView(脚本可读、可外传)。
//! 本模块把请求移到 Rust 侧:命令从 DB 读模型配置、从 OS Keychain 读密钥，
//! 用 reqwest 发起 SSE 流式请求,通过 [`tauri::ipc::Channel`] 把 token 推回前端。
//! 前端不再需要直连任意 HTTPS(见 capabilities 的 http scope 收窄)。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::repository::traits::ReadRepository;

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
        let model = conn
            .get_model_by_id(model_id)?
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
}
