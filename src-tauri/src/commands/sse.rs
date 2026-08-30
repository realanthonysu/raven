//! LLM 流式代理的 SSE 引擎 —— 从 proxy.rs 拆出的解析与泵送机制。
//!
//! 职责单一化：proxy.rs 只保留 Tauri 命令入口（参数校验、配置加载、URL/请求体
//! 构造），字节流 → token 的解析细节集中在此模块，便于独立测试与复用。
//!
//! 解析要点（与前端 services/llm.ts 的 TS 版解析器行为对齐）：
//! - 以字节缓冲切行（[`extract_lines`]）：TCP 分块边界可能落在多字节 UTF-8 字符中间，
//!   必须拿到完整行后才做 UTF-8 解码；
//! - 多行 `data:` 字段以 `\n` 连接、空行（事件终止符）触发派发（SSE 规范，E5）；
//! - 兼容 `data:` 与 `data: `（E1）以及流结束时未发送 [DONE] 的供应商实现。

use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::AppError;

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

/// 解析一条 SSE `data:` 行。兼容 `data:` 与 `data: ` 两种写法(E1)，
/// 自动剥离行尾 `\r`（CRLF 行结束符，E5）。
/// 返回 (增量 token, 是否 [DONE])。
/// 仅测试直接使用；生产路径由 pump_sse_stream 的事件缓冲经 process_sse_data 派发。
#[cfg(test)]
fn process_sse_line(line: &str, full: &mut String) -> (Option<String>, bool) {
    // trim() 同时剥离行尾 `\r`（兼容 CRLF 行结束符，E5）与首尾空白
    let trimmed = line.trim();
    if !trimmed.starts_with("data:") {
        return (None, false);
    }
    let rest = &trimmed[5..];
    let data = rest.strip_prefix(' ').unwrap_or(rest);
    process_sse_data(data, full)
}

/// 解析单条 SSE 事件已拼接的 data 载荷（多行 data 字段以 `\n` 连接后传入）。
fn process_sse_data(data: &str, full: &mut String) -> (Option<String>, bool) {
    if data == "[DONE]" {
        return (None, true);
    }
    // 增量文本用事件内的 choices[0].delta.content 累积;
    // 部分实现只在 completion 里给 content——统一按 delta 处理
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data)
        && let Some(content) = parsed
            .pointer("/choices/0/delta/content")
            .and_then(|v| v.as_str())
    {
        full.push_str(content);
        return (Some(content.to_string()), false);
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

/// SSE 残行缓冲的累计上限：未含 `\n` 的残行（单行无限长）可被恶意端点
/// 在超时窗口内无界拉长，逐块累积时须检查上限。
const MAX_SSE_BUFFER_BYTES: usize = 32 * 1024 * 1024;

/// 累计 token 文本的上限（与 buffer 上限配套，双保险）。
const MAX_SSE_FULL_TEXT_BYTES: usize = 32 * 1024 * 1024;

/// 单个 SSE 事件累积 `data:` 行的上限：无空行终止符时 data_lines 会无界累积，
/// 且非 JSON 的 data 行不会进入 full_text，必须单独设限。
/// 计数器随事件派发在 `SseEventBuffer::take` 中一并复位，保证上限始终针对
/// "单个事件"而非整条流累计（否则长流会被误判超限）。
const MAX_SSE_DATA_BYTES: usize = 8 * 1024 * 1024;

/// pump_sse_stream 的中止原因：区分"前端已离开（应静默停止）"与
/// "累计数据超限（应终止并报错）"。
#[derive(Debug)]
enum PumpStop {
    ChannelClosed,
    LimitExceeded,
}

/// 单个 SSE 事件的 data 行缓冲：累积多行 `data:` 字段并跟踪已缓冲字节数，
/// 在事件终止符（空行）或流结束时经 [`SseEventBuffer::dispatch`] 派发。
/// 抽成独立单元以便对"缓冲 + 计数 + 上限"做无网络依赖的单测。
struct SseEventBuffer {
    /// 已缓冲的 data 行（E5：多行 data 字段派发时以 `\n` 连接）
    data_lines: Vec<String>,
    /// data_lines 的累计字节数（与 MAX_SSE_DATA_BYTES 比较）
    data_lines_bytes: usize,
}

impl SseEventBuffer {
    fn new() -> Self {
        Self {
            data_lines: Vec::new(),
            data_lines_bytes: 0,
        }
    }

    /// 追加一条 data 行，检查"单个事件"累计上限；超限返回 Err(AppError)
    fn push(&mut self, entry: String) -> Result<(), AppError> {
        if self.data_lines_bytes + entry.len() > MAX_SSE_DATA_BYTES {
            return Err(AppError::Network(format!(
                "SSE 响应体过大（超过 {MAX_SSE_DATA_BYTES} bytes 上限）"
            )));
        }
        self.data_lines_bytes += entry.len();
        self.data_lines.push(entry);
        Ok(())
    }

    /// 取出已缓冲的 data 行：以 `\n` 拼接为事件载荷，同时清空缓冲并复位字节计数器。
    /// 计数器与缓冲同生命周期，保证 MAX_SSE_DATA_BYTES 始终是"单个事件"的上限；
    /// 空缓冲（连续空行等）返回 None。
    fn take(&mut self) -> Option<String> {
        if self.data_lines.is_empty() {
            return None;
        }
        let data = self.data_lines.join("\n");
        self.data_lines.clear();
        self.data_lines_bytes = 0;
        Some(data)
    }

    /// 派发一个完整事件：拼接 data 行并解析；返回是否 [DONE]
    fn dispatch(
        &mut self,
        full_text: &mut String,
        on_event: &Channel<ProxyEvent>,
    ) -> Result<bool, PumpStop> {
        let Some(data) = self.take() else {
            return Ok(false); // 空事件（连续空行等），忽略
        };
        let (token, done) = process_sse_data(&data, full_text);
        if full_text.len() > MAX_SSE_FULL_TEXT_BYTES {
            return Err(PumpStop::LimitExceeded);
        }
        if let Some(t) = token {
            // 前端已离开/Channel 失效:立即停止读取上游,避免空跑消耗 token 计费
            if on_event.send(ProxyEvent::Token { token: t }).is_err() {
                return Err(PumpStop::ChannelClosed);
            }
        }
        if done {
            let _ = on_event.send(ProxyEvent::Done {
                full_text: full_text.clone(),
            });
        }
        Ok(done)
    }
}

/// 逐行读取 SSE 响应体,解析 token 并经 Channel 推送,直到 [DONE] 或流结束。
pub(crate) async fn pump_sse_stream(
    response: reqwest::Response,
    on_event: &Channel<ProxyEvent>,
) -> Result<(), AppError> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::with_capacity(8192);
    let mut full_text = String::new();
    // 多行 data 字段缓冲（E5）：SSE 规范允许一个事件包含多行 `data:`，
    // 需以 `\n` 连接，直到空行（事件终止符）才派发
    let mut event = SseEventBuffer::new();
    use futures_util::StreamExt;

    let mut early_stop = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Network(format!("stream read failed: {e}")))?;
        // 残行缓冲上限：不含 `\n` 的数据可被恶意端点无限发送
        if buffer.len() + chunk.len() > MAX_SSE_BUFFER_BYTES {
            return Err(AppError::Network(format!(
                "SSE 响应体过大（超过 {MAX_SSE_BUFFER_BYTES} bytes 上限）"
            )));
        }
        buffer.extend_from_slice(&chunk);
        let lines = extract_lines(&mut buffer);
        for raw in lines {
            // 完整行才解码;非法 UTF-8(基本不会)整行丢弃,不影响后续
            let Ok(line) = String::from_utf8(raw) else {
                continue;
            };
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                // 事件终止符：派发已缓冲的事件
                match event.dispatch(&mut full_text, on_event) {
                    Ok(true) => return Ok(()),
                    Err(PumpStop::ChannelClosed) => {
                        early_stop = true;
                        break;
                    }
                    Err(PumpStop::LimitExceeded) => {
                        return Err(AppError::Network("SSE 响应体过大（超过上限）".into()));
                    }
                    Ok(false) => continue,
                }
            }
            if let Some(rest) = line.strip_prefix("data:") {
                event.push(rest.strip_prefix(' ').unwrap_or(rest).to_string())?;
            }
            // 其余行（`: keep-alive` 注释、event:/id:/retry: 字段）忽略
        }
        if early_stop {
            return Ok(());
        }
    }
    // 流结束但未收到 [DONE](部分 API 行为)——处理残留的末行(无尾换行)
    if !buffer.is_empty()
        && let Ok(line) = String::from_utf8(std::mem::take(&mut buffer))
    {
        let line = line.trim_end_matches('\r');
        let result = if line.is_empty() {
            event.dispatch(&mut full_text, on_event)
        } else if let Some(rest) = line.strip_prefix("data:") {
            event.push(rest.strip_prefix(' ').unwrap_or(rest).to_string())?;
            event.dispatch(&mut full_text, on_event)
        } else {
            Ok(false)
        };
        match result {
            // 尾行即 [DONE]：Done 已随该次派发发出，直接结束，避免下方再补发一次
            Ok(true) => return Ok(()),
            Err(PumpStop::LimitExceeded) => {
                return Err(AppError::Network("SSE 响应体过大（超过上限）".into()));
            }
            _ => {}
        }
    }
    // 上游未发空行就关流：冲刷仍未派发的 data 缓冲
    if matches!(
        event.dispatch(&mut full_text, on_event),
        Err(PumpStop::LimitExceeded)
    ) {
        return Err(AppError::Network("SSE 响应体过大（超过上限）".into()));
    }
    let _ = on_event.send(ProxyEvent::Done { full_text });
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use tauri::ipc::{Channel, InvokeResponseBody};

    /// 构造一个可观测的测试 Channel：把 send 过来的 ProxyEvent(JSON) 收集进
    /// Vec（以 serde_json::Value 承接，避免为测试给 ProxyEvent 加 Deserialize），
    /// 供断言派发次数与内容。Channel::new 无需 App 上下文，可直接构造。
    fn test_channel() -> (Channel<ProxyEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let channel = Channel::new(move |body: InvokeResponseBody| {
            let InvokeResponseBody::Json(json) = body else {
                return Ok(());
            };
            sink.lock().unwrap().push(serde_json::from_str(&json)?);
            Ok(())
        });
        (channel, events)
    }

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

    #[test]
    fn sse_event_buffer_take_joins_lines_and_resets() {
        let mut event = SseEventBuffer::new();
        // 空缓冲（连续空行等）返回 None
        assert!(event.take().is_none());
        event.push("line-a".into()).unwrap();
        event.push("line-b".into()).unwrap();
        // 多行 data 以 \n 连接（E5）
        assert_eq!(event.take().as_deref(), Some("line-a\nline-b"));
        // 取出后缓冲与字节计数一并清零
        assert!(event.take().is_none());
    }

    #[test]
    fn sse_event_buffer_limit_is_per_event_not_per_stream() {
        // 回归（缺陷 1）：多个事件累计字节超过 MAX_SSE_DATA_BYTES，
        // 但单事件均未超 → 不报错。修复前计数器从不清零，
        // 累计即误报"SSE 响应体过大"终止正常长流。
        let mut event = SseEventBuffer::new();
        // 每个事件约 4MB+1：三个事件累计 12MB+3，远超 8MB 上限
        let half_limit = "x".repeat(MAX_SSE_DATA_BYTES / 2 + 1);
        for _ in 0..3 {
            assert!(event.push(half_limit.clone()).is_ok());
            // 派发（空行终止符的等价操作）后计数复位，下一事件重新从 0 计
            assert!(event.take().is_some());
        }
        assert!(event.take().is_none());
    }

    #[test]
    fn sse_event_buffer_rejects_single_event_over_limit() {
        // 回归（缺陷 1）防御面：单个事件累计超上限仍必须报错
        let mut event = SseEventBuffer::new();
        // 恰好等于上限 → 放行（判断条件是严格大于）
        let at_limit = "x".repeat(MAX_SSE_DATA_BYTES);
        assert!(event.push(at_limit).is_ok());
        // 同一事件内再累计 1 字节即超限 → 报错
        let err = event.push("y".into());
        assert!(err.is_err());
    }

    #[test]
    fn sse_event_buffer_dispatch_sends_token() {
        // dispatch 端到端：单条 data 行解析出 token 并经 Channel 发出
        let (channel, events) = test_channel();
        let mut full_text = String::new();
        let mut event = SseEventBuffer::new();
        event
            .push("{\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}".into())
            .unwrap();
        assert!(!event.dispatch(&mut full_text, &channel).unwrap());
        assert_eq!(full_text, "Hello");
        // 事件形如 {"type":"token","token":"Hello"}
        assert_eq!(events.lock().unwrap()[0]["type"], "token");
        assert_eq!(events.lock().unwrap()[0]["token"], "Hello");
    }

    #[test]
    fn sse_event_buffer_done_dispatched_exactly_once() {
        // 回归（缺陷 2）：流尾无换行的 `data: [DONE]` 派发返回 done=true 后，
        // 不得再次派发（修复前 pump 尾部路径会无条件补发一次 Done）
        let (channel, events) = test_channel();
        let mut full_text = String::new();
        let mut event = SseEventBuffer::new();
        event.push("[DONE]".into()).unwrap();
        // 第一次派发：done=true，且恰好发出一次 Done
        assert!(event.dispatch(&mut full_text, &channel).unwrap());
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(events.lock().unwrap()[0]["type"], "done");
        // 第二次派发（对应修复前 pump 尾部的无条件补发路径）：
        // 缓冲已空 → done=false，不产生第二个 Done
        assert!(!event.dispatch(&mut full_text, &channel).unwrap());
        assert_eq!(events.lock().unwrap().len(), 1);
    }
}
