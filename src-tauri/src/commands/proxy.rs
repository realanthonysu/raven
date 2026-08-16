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
#[tauri::command]
pub async fn db_stream_chat_completions(
    db: State<'_, Db>,
    model_id: i64,
    messages: Vec<ProxyMessage>,
    timeout_ms: Option<u64>,
    on_event: Channel<ProxyEvent>,
) -> Result<(), AppError> {
    if messages.is_empty() {
        return Err(AppError::Validation("messages cannot be empty".into()));
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

    let client = reqwest::Client::new();
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
            .map_err(|e| AppError::Export(format!("LLM request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(AppError::Export(format!("LLM API error: {status} {text}")));
        }

        // 逐行读取 SSE 流
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut full_text = String::new();
        use futures_util::StreamExt;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Export(format!("stream read failed: {e}")))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            // 按行切分(owned String,避免对 buffer 的借用与后续修改冲突),保留最后不完整行
            let mut lines: Vec<String> = buffer
                .split_inclusive('\n')
                .map(|s| s.to_string())
                .collect();
            if let Some(last) = lines.pop() {
                if last.ends_with('\n') {
                    lines.push(last);
                    buffer.clear();
                } else {
                    buffer = last;
                }
            }
            for line in lines {
                let (token, done) = process_sse_line(&line, &mut full_text);
                if let Some(t) = token {
                    let _ = on_event.send(ProxyEvent::Token { token: t });
                }
                if done {
                    let _ = on_event.send(ProxyEvent::Done {
                        full_text: full_text.clone(),
                    });
                    return Ok::<(), AppError>(());
                }
            }
        }
        // 流结束但未收到 [DONE](部分 API 行为)——处理残留的不完整行
        if !buffer.trim().is_empty() {
            let (token, _) = process_sse_line(&buffer, &mut full_text);
            if let Some(t) = token {
                let _ = on_event.send(ProxyEvent::Token { token: t });
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
            let _ = on_event.send(ProxyEvent::Error {
                message: e.to_string(),
            });
            Err(e)
        }
        Err(_) => {
            let msg = format!("LLM request timed out ({}s)", timeout.as_secs());
            let _ = on_event.send(ProxyEvent::Error {
                message: msg.clone(),
            });
            Err(AppError::Export(msg))
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
}
