//! LLM 流式代理的 SSE 引擎 —— 从 proxy.rs 拆出的解析与泵送机制。
//!
//! 职责单一化：proxy.rs 只保留 Tauri 命令入口（参数校验、配置加载、URL/请求体
//! 构造），字节流 → token 的解析细节集中在此模块，便于独立测试与复用。
//!
//! 解析要点（与前端 services/llm.ts 的 TS 版解析器行为对齐）：
//! - 以字节缓冲切行（[`extract_lines`]）：TCP 分块边界可能落在多字节 UTF-8 字符中间，
//!   必须拿到完整行后才做 UTF-8 解码；
//! - 断行符兼容 SSE 规范三形态：`\n`、`\r\n`（视为**单个**断行）与孤立 `\r`；
//!   缓冲末尾的 `\r` 挂起等待下一块数据，避免跨块 CRLF 被误拆成两个断行；
//! - 多行 `data:` 字段以 `\n` 连接、空行（事件终止符）触发派发（SSE 规范，E5）；
//! - 兼容 `data:` 与 `data: `（E1）以及流结束时未发送 [DONE] 的供应商实现。
//!
//! 热路径优化（P2）：
//! - S-07：一个网络 chunk 内解析出的增量合并为**一条** Channel 事件（[`TokenBatch`]），
//!   长回答的 IPC 事件数从"每 token 一条"降为"每网络 chunk 一条"；
//! - S-08：`Done` 不再回传完整文本，Rust 侧也不保留输出文本（只累计字节数）；
//! - S-09：`extract_lines` 维护跨 chunk 的扫描起点，无换行长行不再被整段重扫。

use serde::Serialize;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;

/// 推送给前端的流式事件(枚举,序列化为 { type, ... })。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProxyEvent {
    /// 增量 token（S-07：一个网络 chunk 内的多个增量合并为一条事件）
    #[serde(rename_all = "camelCase")]
    Token { token: String },
    /// 流结束（S-08：不再携带完整文本）
    ///
    /// 完整文本由前端从 Token 事件本地累积——Rust 侧再发一份会让长生成时
    /// 峰值内存翻倍（全文序列化 + IPC 传输），而前端本来就有累积结果。
    /// 该事件仅作为"流正常结束"的定界信号。
    Done,
    /// 错误(非中止)
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

/// 解析一条 SSE `data:` 行。兼容 `data:` 与 `data: ` 两种写法(E1)，
/// 自动剥离行尾 `\r`（CRLF 行结束符，E5）。
/// 返回 (增量 token, 是否 [DONE])，并把增量字节数累加进 `output_bytes`。
/// 仅测试直接使用；生产路径由 pump_sse_stream 的事件缓冲经 process_sse_data 派发。
#[cfg(test)]
fn process_sse_line(line: &str, output_bytes: &mut usize) -> (Option<String>, bool) {
    // trim() 同时剥离行尾 `\r`（兼容 CRLF 行结束符，E5）与首尾空白
    let trimmed = line.trim();
    if !trimmed.starts_with("data:") {
        return (None, false);
    }
    let rest = &trimmed[5..];
    let data = rest.strip_prefix(' ').unwrap_or(rest);
    process_sse_data(data, output_bytes)
}

/// 解析单条 SSE 事件已拼接的 data 载荷（多行 data 字段以 `\n` 连接后传入）。
///
/// S-08 起 Done 不再回传全文，Rust 侧无需保留输出文本：只累计**字节数**用于
/// 超限保护（[`MAX_SSE_OUTPUT_BYTES`]），不再为长生成额外持有整份结果字符串。
fn process_sse_data(data: &str, output_bytes: &mut usize) -> (Option<String>, bool) {
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
        *output_bytes += content.len();
        return (Some(content.to_string()), false);
    }
    (None, false)
}

/// 从字节缓冲中切出所有完整行,并保留最后的残行字节。
///
/// TCP 分块不保证与 SSE 行边界对齐,且分块边界可能落在多字节 UTF-8 字符中间。
/// 因此必须用 `Vec<u8>` 累积原始字节,只在拿到完整行后才做 UTF-8 解码,
/// 避免 `from_utf8_lossy` 在残行上把字符替换为 U+FFFD 导致 JSON 解析失败、token 静默丢失。
///
/// SSE 规范的断行符有三种:`\n`、`\r\n` 与孤立 `\r`。`\r\n` 必须视为**单个**
/// 断行——若拆成两个会插入空行,而空行是事件终止符,等于伪造事件边界。关键
/// 边界:`\r` 恰在缓冲末尾时无法判定下一个字节是否为 `\n`(它可能还在下一个
/// TCP 分块里),必须把残行与 `\r` 一并保留等待后续数据,不能立即切行。
///
/// # 增量扫描（S-09）
///
/// `scan_from` 是**跨 chunk 的扫描起点**:上次调用结束时,残行中
/// `[0, *scan_from)` 这段字节已被确认不含任何断行符。缓冲只追加新数据,
/// 因此本次从 `*scan_from` 起扫即可,不必重扫整段残行——否则一个长期不发
/// 换行的长行（例如单个超大 `data:` 事件）会在每次 chunk 到达时被整段重扫,
/// 累计 O(n²) 字节比较。
///
/// 函数返回后会把 `*scan_from` 更新为"新残行中已被扫描过的字节数"：
/// - 正常扫到缓冲末尾 → 残行全部已扫（`buffer.len()`）；
/// - 因末尾孤立 `\r` 挂起 → 指向该 `\r` 的位置（它必须在下一块数据到达后
///   重新判定是否与下一个 `\n` 组成 CRLF）。
///
/// 调用方在清空/替换缓冲时必须把 `scan_from` 复位为 0。
fn extract_lines(buffer: &mut Vec<u8>, scan_from: &mut usize) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    // 起点钳制到缓冲长度：防御调用方传入过期游标（缓冲被外部清空后未复位）
    let mut i = (*scan_from).min(buffer.len());
    while i < buffer.len() {
        match buffer[i] {
            b'\n' => {
                // \n 前不可能残留 \r(\r 会被下面的分支先行切分),行内容无需再去尾
                lines.push(buffer[start..i].to_vec());
                i += 1;
                start = i;
            }
            // \r 在缓冲末尾:下一字节是否 \n 须等下一块数据判定,挂起不切
            b'\r' if i + 1 == buffer.len() => break,
            // \r\n 是单个断行,\r 即终止符本身,行内容以 i 为界不含 \r
            b'\r' if buffer[i + 1] == b'\n' => {
                lines.push(buffer[start..i].to_vec());
                i += 2;
                start = i;
            }
            // 孤立 \r 也是断行(SSE 规范)
            b'\r' => {
                lines.push(buffer[start..i].to_vec());
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    buffer.drain(..start);
    // 残行 = 原缓冲 [start..)，其中 [start, i) 已确认无断行符；
    // 挂起在末尾 `\r` 时 i 正指向它，下一轮需重新判定（游标不前移过它）
    *scan_from = i - start;
    lines
}

/// SSE 残行缓冲的累计上限：未含 `\n` 的残行（单行无限长）可被恶意端点
/// 在超时窗口内无界拉长，逐块累积时须检查上限。
const MAX_SSE_BUFFER_BYTES: usize = 32 * 1024 * 1024;

/// 累计 token 文本的字节上限（与 buffer 上限配套，双保险）。
///
/// S-08 起 Done 不再回传全文，Rust 侧只累计增量字节数（不保留文本），
/// 因此该上限的开销只是一个 usize。
const MAX_SSE_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

/// 单个 SSE 事件累积 `data:` 行的上限：无空行终止符时 data_lines 会无界累积，
/// 且非 JSON 的 data 行不会进入输出文本，必须单独设限。
/// 计数器随事件派发在 `SseEventBuffer::take` 中一并复位，保证上限始终针对
/// "单个事件"而非整条流累计（否则长流会被误判超限）。
const MAX_SSE_DATA_BYTES: usize = 8 * 1024 * 1024;

/// 单个 Token 事件批的最大字节数（S-07）：一个网络 chunk 内累积的增量文本
/// 达到此阈值就提前发送，避免供应商在一个 chunk 里塞入超大突发时把整段
/// 长文本滞留在内存里（正常 chunk 远小于此值，等价于"每 chunk 一条事件"）。
const MAX_TOKEN_BATCH_BYTES: usize = 16 * 1024;

/// 待发送的 token 批（S-07）：把同一网络 chunk 内解析出的多个增量合并成一次
/// Channel 事件，降低跨 IPC 的事件频率（长回答的 token 事件数从"每 token 一条"
/// 降为"每网络 chunk 一条"）。发送顺序与 token 顺序严格一致，
/// 前端 `onToken` 只做字符串拼接，语义不变。
struct TokenBatch {
    pending: String,
}

impl TokenBatch {
    fn new() -> Self {
        Self {
            pending: String::new(),
        }
    }

    /// 累积一个增量；返回是否已达到提前发送的阈值。
    fn push(&mut self, token: &str) -> bool {
        self.pending.push_str(token);
        self.pending.len() >= MAX_TOKEN_BATCH_BYTES
    }

    /// 发送并清空当前批。空批不产生事件（避免空 Token 事件）。
    fn flush(&mut self, on_event: &Channel<ProxyEvent>) -> Result<(), PumpStop> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(&mut self.pending);
        // 前端已离开/Channel 失效：由调用方按"停止读取上游"处理
        on_event
            .send(ProxyEvent::Token { token: batch })
            .map_err(|_| PumpStop::ChannelClosed)
    }

    /// 流结束前的收尾：先冲刷未发送的批，再发送 Done。
    ///
    /// 顺序是硬约束——前端靠 Token 事件累积完整文本，Done 若先到会让尾部
    /// token 落在 `onDone` 之后被丢弃。Done 本身只是"正常结束"的定界信号
    /// （S-08：不再携带 full_text），发送失败（前端已离开）无需处理。
    fn finish(&mut self, on_event: &Channel<ProxyEvent>) {
        let _ = self.flush(on_event);
        let _ = on_event.send(ProxyEvent::Done);
    }
}

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

    /// 派发一个完整事件：拼接 data 行并解析；返回 `(是否 [DONE], 批是否已满)`。
    ///
    /// 解析出的增量**不直接发送**，而是累积进 `batch`——由 pump 在 chunk 处理完、
    /// 批达到阈值、或流结束时统一 `flush`（S-07）。
    /// `output_bytes` 是累计输出字节数，仅用于超限保护（S-08 起不保留文本）。
    fn dispatch(
        &mut self,
        output_bytes: &mut usize,
        batch: &mut TokenBatch,
    ) -> Result<(bool, bool), PumpStop> {
        let Some(data) = self.take() else {
            return Ok((false, false)); // 空事件（连续空行等），忽略
        };
        let (token, done) = process_sse_data(&data, output_bytes);
        if *output_bytes > MAX_SSE_OUTPUT_BYTES {
            return Err(PumpStop::LimitExceeded);
        }
        let batch_full = match token {
            Some(t) => batch.push(&t),
            None => false,
        };
        Ok((done, batch_full))
    }
}

/// 取消令牌是否已触发（None = 未启用取消）。
fn cancellation_requested(cancel: Option<&CancellationToken>) -> bool {
    cancel.is_some_and(|token| token.is_cancelled())
}

/// 逐行读取 SSE 响应体,解析 token 并经 Channel 推送,直到 [DONE] 或流结束。
/// 若 `cancel` 触发，立即返回 `Ok(())`：不再读取上游、不再发送 token/Done/Error。
pub(crate) async fn pump_sse_stream(
    response: reqwest::Response,
    on_event: &Channel<ProxyEvent>,
    cancel: Option<CancellationToken>,
) -> Result<(), AppError> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::with_capacity(8192);
    // 跨 chunk 的增量扫描起点（S-09）：残行中 [0, scan_from) 已确认无断行符
    let mut scan_from = 0usize;
    // 累计输出字节数（S-08：只计数、不保留文本，仅用于超限保护）
    let mut output_bytes = 0usize;
    // 多行 data 字段缓冲（E5）：SSE 规范允许一个事件包含多行 `data:`，
    // 需以 `\n` 连接，直到空行（事件终止符）才派发
    let mut event = SseEventBuffer::new();
    // 一个 chunk 内的 token 批（S-07）：chunk 处理完/达到阈值/流结束时发送
    let mut batch = TokenBatch::new();
    use futures_util::StreamExt;

    // 取消监听 future：None 时永不结束，保证 select! 的分支形状稳定。
    let cancel_for_wait = cancel.clone();
    let cancelled = async move {
        match cancel_for_wait {
            Some(token) => token.cancelled().await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(cancelled);

    // 注册可能在进入本函数前就已被取消（前端 abort 与 invoke 启动竞态）。
    if cancellation_requested(cancel.as_ref()) {
        return Ok(());
    }

    let mut early_stop = false;
    loop {
        let chunk = tokio::select! {
            () = &mut cancelled => return Ok(()),
            next = stream.next() => match next {
                Some(chunk) => chunk,
                None => break,
            },
        };
        let chunk = chunk.map_err(|e| AppError::Network(format!("stream read failed: {e}")))?;
        // 取消与网络 chunk 同时就绪时 select! 可能先返回 chunk：再检查一次，
        // 保证不把取消后的 chunk 继续派发成 token。
        if cancellation_requested(cancel.as_ref()) {
            return Ok(());
        }
        // 残行缓冲上限：不含 `\n` 的数据可被恶意端点无限发送
        if buffer.len() + chunk.len() > MAX_SSE_BUFFER_BYTES {
            return Err(AppError::Network(format!(
                "SSE 响应体过大（超过 {MAX_SSE_BUFFER_BYTES} bytes 上限）"
            )));
        }
        buffer.extend_from_slice(&chunk);
        let lines = extract_lines(&mut buffer, &mut scan_from);
        for raw in lines {
            // 每处理一行都检查取消：一个网络 chunk 可能含多个事件，取消后不能继续派发。
            if cancellation_requested(cancel.as_ref()) {
                return Ok(());
            }
            // 完整行才解码;非法 UTF-8(基本不会)整行丢弃,不影响后续
            let Ok(line) = String::from_utf8(raw) else {
                continue;
            };
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                // 事件终止符：派发已缓冲的事件
                let (done, batch_full) = match event.dispatch(&mut output_bytes, &mut batch) {
                    Ok(outcome) => outcome,
                    Err(PumpStop::ChannelClosed) => {
                        early_stop = true;
                        break;
                    }
                    Err(PumpStop::LimitExceeded) => {
                        return Err(AppError::Network("SSE 响应体过大（超过上限）".into()));
                    }
                };
                if done {
                    // 先冲刷尾批再发 Done，保证前端拿到全部 token 后才收尾
                    batch.finish(on_event);
                    return Ok(());
                }
                // 批达到阈值：即便 chunk 未处理完也先发出，避免单 chunk 超大突发滞留
                if batch_full && batch.flush(on_event).is_err() {
                    early_stop = true;
                    break;
                }
                continue;
            }
            if let Some(rest) = line.strip_prefix("data:") {
                event.push(rest.strip_prefix(' ').unwrap_or(rest).to_string())?;
            }
            // 其余行（`: keep-alive` 注释、event:/id:/retry: 字段）忽略
        }
        if early_stop {
            return Ok(());
        }
        // 本 chunk 处理完：把累积的 token 作为一条事件发出（S-07 的核心收益）
        if batch.flush(on_event).is_err() {
            // 前端已离开/Channel 失效：立即停止读取上游，避免空跑消耗 token 计费
            return Ok(());
        }
    }
    // 取消可能发生在流自然结束前；尾部分派前再检查一次，避免取消后补发 Done。
    if cancellation_requested(cancel.as_ref()) {
        return Ok(());
    }
    // 流结束但未收到 [DONE](部分 API 行为)——处理残留的末行(无尾换行)
    if !buffer.is_empty()
        && let Ok(line) = String::from_utf8(std::mem::take(&mut buffer))
    {
        // 缓冲已被移走且流已结束（不会再调用 extract_lines），无需复位扫描游标
        let line = line.trim_end_matches('\r');
        let result = if line.is_empty() {
            event.dispatch(&mut output_bytes, &mut batch)
        } else if let Some(rest) = line.strip_prefix("data:") {
            event.push(rest.strip_prefix(' ').unwrap_or(rest).to_string())?;
            event.dispatch(&mut output_bytes, &mut batch)
        } else {
            Ok((false, false))
        };
        match result {
            // 尾行即 [DONE]：这里完成唯一一次收尾（冲刷尾批 + Done）后返回，
            // 避免下方再补发一次 Done
            Ok((true, _)) => {
                batch.finish(on_event);
                return Ok(());
            }
            Err(PumpStop::LimitExceeded) => {
                return Err(AppError::Network("SSE 响应体过大（超过上限）".into()));
            }
            _ => {}
        }
    }
    // 上游未发空行就关流：冲刷仍未派发的 data 缓冲
    match event.dispatch(&mut output_bytes, &mut batch) {
        Ok((true, _)) => {
            batch.finish(on_event);
            return Ok(());
        }
        Err(PumpStop::LimitExceeded) => {
            return Err(AppError::Network("SSE 响应体过大（超过上限）".into()));
        }
        _ => {}
    }
    if cancellation_requested(cancel.as_ref()) {
        return Ok(());
    }
    // 正常收尾：先冲刷尾批，再发 Done（S-08：Done 不再携带 full_text）
    batch.finish(on_event);
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
        let mut output_bytes = 0usize;
        // 带空格(标准写法)
        let (token, done) = process_sse_line(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}",
            &mut output_bytes,
        );
        assert_eq!(token.as_deref(), Some("Hello"));
        assert!(!done);
        // 无空格(E1 兼容)
        let (token2, done2) = process_sse_line(
            "data:{\"choices\":[{\"delta\":{\"content\":\" World\"}}]}",
            &mut output_bytes,
        );
        assert_eq!(token2.as_deref(), Some(" World"));
        assert!(!done2);
        // S-08: 只累计字节数（"Hello" + " World" = 11 字节），不保留文本
        assert_eq!(output_bytes, "Hello World".len());
    }

    #[test]
    fn sse_line_detects_done_marker() {
        let mut output_bytes = 0usize;
        let (token, done) = process_sse_line("data: [DONE]", &mut output_bytes);
        assert!(token.is_none());
        assert!(done);
        let (_, done2) = process_sse_line("data:[DONE]", &mut output_bytes);
        assert!(done2);
        // [DONE] 不产生输出字节
        assert_eq!(output_bytes, 0);
    }

    #[test]
    fn sse_line_ignores_non_data_lines() {
        let mut output_bytes = 0usize;
        let (token, done) = process_sse_line(": keep-alive comment", &mut output_bytes);
        assert!(token.is_none());
        assert!(!done);
        assert_eq!(output_bytes, 0);
    }

    /// 与前端 services/llm.ts 共享的行切分契约（src/test/fixtures/sse-lines.json）。
    #[test]
    fn extract_lines_matches_shared_fixture() {
        let raw = include_str!("../../../src/test/fixtures/sse-lines.json");
        let v: serde_json::Value = serde_json::from_str(raw).expect("fixture json");
        for case in v["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().unwrap_or("?");
            let mut buffer: Vec<u8> = Vec::new();
            let mut scan_from = 0usize;
            let mut got: Vec<String> = Vec::new();
            for chunk in case["chunks"].as_array().expect("chunks") {
                buffer.extend_from_slice(chunk.as_str().expect("chunk").as_bytes());
                for line in extract_lines(&mut buffer, &mut scan_from) {
                    got.push(String::from_utf8_lossy(&line).into_owned());
                }
            }
            if !buffer.is_empty() {
                got.push(String::from_utf8_lossy(&buffer).into_owned());
            }
            let want: Vec<String> = case["lines"]
                .as_array()
                .expect("lines")
                .iter()
                .map(|s| s.as_str().unwrap_or("").to_string())
                .collect();
            assert_eq!(got, want, "fixture case {name} 与 TS 契约不一致");
        }
    }

    #[test]
    fn extract_lines_splits_complete_lines_and_keeps_tail() {
        let mut buffer = b"line1\nline2\npartial".to_vec();
        let mut scan_from = 0usize;
        let lines = extract_lines(&mut buffer, &mut scan_from);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], b"line1");
        assert_eq!(lines[1], b"line2");
        // 残行保留在缓冲中
        assert_eq!(buffer, b"partial");
        // 残行已全部扫描过（游标指向末尾），下次只扫新增字节
        assert_eq!(scan_from, buffer.len());
        // 残行补齐后再次提取
        buffer.extend_from_slice(b"-tail\n");
        let lines2 = extract_lines(&mut buffer, &mut scan_from);
        assert_eq!(lines2, vec![b"partial-tail".to_vec()]);
        assert!(buffer.is_empty());
        assert_eq!(scan_from, 0);
    }

    /// 按"已切出行 + 残行"累计（与 extract_lines_matches_shared_fixture 同一
    /// 口径：流尾残行在语义上就是尚待换行符确认的最后一行）。
    fn collect_lines_with_tail(buffer: &mut Vec<u8>, scan_from: &mut usize) -> Vec<String> {
        let mut got: Vec<String> = extract_lines(buffer, scan_from)
            .iter()
            .map(|line| String::from_utf8_lossy(line).into_owned())
            .collect();
        if !buffer.is_empty() {
            got.push(String::from_utf8_lossy(buffer).into_owned());
        }
        got
    }

    #[test]
    fn extract_lines_cr_forms_follow_sse_spec() {
        // SSE 规范断行符：\n、\r\n（单个断行）、孤立 \r 三者等价。
        // "a\rb" → 2 行（孤立 \r 断行）
        assert_eq!(
            collect_lines_with_tail(&mut b"a\rb".to_vec(), &mut 0),
            vec!["a", "b"]
        );
        // "a\r\nb" → 2 行，不是 3 行：\r\n 误拆成两个断行会插入空行 = 伪事件边界
        assert_eq!(
            collect_lines_with_tail(&mut b"a\r\nb".to_vec(), &mut 0),
            vec!["a", "b"]
        );
    }

    #[test]
    fn extract_lines_crlf_emits_lines_without_trailing_cr() {
        // \r\n 切行后行尾不带 \r；真实的空行（事件终止符）仍须保留
        let mut buffer = b"data: x\r\n\r\n".to_vec();
        let mut scan_from = 0usize;
        let lines = extract_lines(&mut buffer, &mut scan_from);
        assert_eq!(lines, vec![b"data: x".to_vec(), b"".to_vec()]);
        assert!(buffer.is_empty());
        assert_eq!(scan_from, 0);
    }

    #[test]
    fn extract_lines_holds_trailing_cr_until_next_chunk() {
        // 关键边界：\r 恰在缓冲末尾时无法判定下一字节是否 \n，必须整段挂起
        // （含 \r 前的残行）等下一块；若立即切行，跨块 "\r" + "\n..." 会被
        // 拆成两个断行，插入的空行即伪事件边界。
        let mut buffer = b"a\r".to_vec();
        let mut scan_from = 0usize;
        let lines = extract_lines(&mut buffer, &mut scan_from);
        assert!(lines.is_empty(), "末尾 \\r 必须挂起，无可 emit 的完整行");
        assert_eq!(buffer, b"a\r", "残行与 \\r 一并保留在缓冲中");
        // 游标指向挂起的 \r 本身：下一块到达后必须重新判定它（可能组成 CRLF）
        assert_eq!(scan_from, buffer.len() - 1);
        // 分块 "a\r" + "\nb"：\r\n 合成单个断行 → "a"、"b" 两行
        buffer.extend_from_slice(b"\nb");
        assert_eq!(
            collect_lines_with_tail(&mut buffer, &mut scan_from),
            vec!["a", "b"]
        );
        // 下一块以非 \n 开头：\r 是孤立断行，同样只 emit "a"（不插入空行）
        let mut buffer = b"a\r".to_vec();
        let mut scan_from = 0usize;
        buffer.extend_from_slice(b"b\n");
        assert_eq!(
            collect_lines_with_tail(&mut buffer, &mut scan_from),
            vec!["a", "b"]
        );
    }

    /// S-09：跨多个 chunk 的长行（始终无换行符）的正确性与增量扫描不变量。
    ///
    /// 增量实现的关键契约：每次返回后 `scan_from` 等于"残行中已被确认无断行符
    /// 的字节数"。无换行时长行因此每次只扫新增块（O(n) 总量）；若退化为整段重扫
    /// （游标恒为 0），本测试的游标断言会立即失败。
    #[test]
    fn extract_lines_scans_only_new_bytes_for_newline_free_long_line() {
        const CHUNK: usize = 1024;
        const CHUNKS: usize = 32;
        let mut buffer: Vec<u8> = Vec::new();
        let mut scan_from = 0usize;
        for _ in 0..CHUNKS {
            buffer.extend(std::iter::repeat_n(b'x', CHUNK));
            let lines = extract_lines(&mut buffer, &mut scan_from);
            assert!(lines.is_empty(), "无换行符时不应切出任何行");
            // 不变量：残行已全部扫描 → 下次只从新增字节继续
            assert_eq!(scan_from, buffer.len(), "游标必须前移到残行末尾");
            assert_eq!(buffer.len() % CHUNK, 0);
        }
        assert_eq!(buffer.len(), CHUNKS * CHUNK);
        // 最终补一个换行：只切出这一整行，内容一字不差
        buffer.push(b'\n');
        let lines = extract_lines(&mut buffer, &mut scan_from);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), CHUNKS * CHUNK);
        assert!(buffer.is_empty());
        assert_eq!(scan_from, 0);
    }

    /// S-09 的 CR 边界与增量游标协同：游标停在末尾孤立 `\r` 上，
    /// 下一块以 `\n` 开头时必须组成单个 CRLF 断行（不能插入空行）。
    #[test]
    fn extract_lines_cursor_rechecks_trailing_cr_across_chunks() {
        let mut buffer: Vec<u8> = Vec::new();
        let mut scan_from = 0usize;
        // 第一块：一行数据 + 末尾孤立 \r —— 换行符归属未定，整行挂起
        buffer.extend_from_slice(b"data: one\r");
        let lines = extract_lines(&mut buffer, &mut scan_from);
        assert!(lines.is_empty());
        assert_eq!(buffer, b"data: one\r", "\\r 前的残行一并挂起");
        assert_eq!(scan_from, 9, "游标必须指向挂起的 \\r 本身");

        // 第二块以 \n 开头：与挂起的 \r 合成单个 CRLF 断行，只切出一行
        buffer.extend_from_slice(b"\n");
        let lines = extract_lines(&mut buffer, &mut scan_from);
        assert_eq!(lines, vec![b"data: one".to_vec()]);
        assert!(buffer.is_empty());
        assert_eq!(scan_from, 0);

        // 下一块以普通字节开头：\r 是孤立断行，同样只切出一行，其余为残行
        let mut buffer = b"data: one\r".to_vec();
        let mut scan_from = 0usize;
        let _ = extract_lines(&mut buffer, &mut scan_from);
        buffer.extend_from_slice(b"tail");
        let lines = extract_lines(&mut buffer, &mut scan_from);
        assert_eq!(lines, vec![b"data: one".to_vec()]);
        assert_eq!(buffer, b"tail");
        assert_eq!(scan_from, buffer.len(), "尾块已扫完");
    }

    #[test]
    fn sse_line_preserves_multibyte_utf8_across_chunks() {
        // 模拟中文 token 被 TCP 分块切在字符中间:从完整行字节序列模拟两次喂入
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}";
        let bytes = line.as_bytes();
        let split = bytes.len() / 2; // 切在 UTF-8 序列中间
        let mut buffer = bytes[..split].to_vec();
        let mut scan_from = 0usize;
        let _ = extract_lines(&mut buffer, &mut scan_from); // 第一次无完整行
        buffer.extend_from_slice(&bytes[split..]);
        buffer.push(b'\n');
        let lines = extract_lines(&mut buffer, &mut scan_from);
        assert_eq!(lines.len(), 1);
        let decoded =
            String::from_utf8(lines[0].clone()).expect("line should decode as valid UTF-8");
        let mut output_bytes = 0usize;
        let (token, done) = process_sse_line(&decoded, &mut output_bytes);
        assert_eq!(token.as_deref(), Some("你好"));
        assert!(!done);
        // 字符重建正确：输出字节按 UTF-8 长度累计（"你好" = 6 字节）
        assert_eq!(output_bytes, 6);
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
    fn sse_event_buffer_dispatch_batches_token_until_flush() {
        // S-07: dispatch 只把增量累积进批，不逐条发送；flush 时合并为一条事件
        let (channel, events) = test_channel();
        let mut output_bytes = 0usize;
        let mut event = SseEventBuffer::new();
        let mut batch = TokenBatch::new();

        event
            .push("{\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}".into())
            .unwrap();
        assert_eq!(
            event.dispatch(&mut output_bytes, &mut batch).unwrap(),
            (false, false)
        );
        event
            .push("{\"choices\":[{\"delta\":{\"content\":\" world\"}}]}".into())
            .unwrap();
        assert_eq!(
            event.dispatch(&mut output_bytes, &mut batch).unwrap(),
            (false, false)
        );

        // 未 flush 前不应有任何 Channel 事件（长回答的 token 事件频率由此下降）
        assert!(events.lock().unwrap().is_empty());
        assert_eq!(output_bytes, "Hello world".len());

        batch.flush(&channel).unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "token");
        assert_eq!(events[0]["token"], "Hello world", "同一批内增量按序拼接");
    }

    #[test]
    fn token_batch_flushes_empty_batch_as_no_event() {
        // 空批不产生事件：避免连续空行/无增量事件时发出空 token
        let (channel, events) = test_channel();
        let mut batch = TokenBatch::new();
        batch.flush(&channel).unwrap();
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn token_batch_reports_threshold_and_flushes_early() {
        // 单 chunk 超大突发：累积到阈值即报告已满，由调用方提前 flush
        let (channel, events) = test_channel();
        let mut batch = TokenBatch::new();
        let half = "x".repeat(MAX_TOKEN_BATCH_BYTES / 2);
        assert!(!batch.push(&half), "未达阈值不提前发送");
        assert!(batch.push(&half), "达到阈值必须报告已满");
        batch.flush(&channel).unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0]["token"].as_str().unwrap().len(),
            MAX_TOKEN_BATCH_BYTES
        );
    }

    #[test]
    fn done_event_carries_no_full_text() {
        // S-08: Done 不再携带完整文本——前端以本地累积为准，避免长文本再经 IPC 传一遍
        let (channel, events) = test_channel();
        let mut batch = TokenBatch::new();
        batch.push("Hello");
        batch.finish(&channel);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "token");
        assert_eq!(events[0]["token"], "Hello");
        assert_eq!(events[1]["type"], "done");
        assert!(
            events[1].get("fullText").is_none(),
            "Done 事件不得再带 fullText，got: {}",
            events[1]
        );
    }

    #[test]
    fn sse_event_buffer_done_dispatched_exactly_once() {
        // 回归（缺陷 2）：流尾无换行的 `data: [DONE]` 派发返回 done=true 后，
        // 不得再次派发（修复前 pump 尾部路径会无条件补发一次 Done）。
        // S-07 起 Done 由 pump 经 batch.finish 发出，dispatch 只报告 done 标志。
        let (channel, events) = test_channel();
        let mut output_bytes = 0usize;
        let mut event = SseEventBuffer::new();
        let mut batch = TokenBatch::new();
        event.push("[DONE]".into()).unwrap();
        // 第一次派发：done=true；调用方收尾恰好发出一次 Done
        assert!(event.dispatch(&mut output_bytes, &mut batch).unwrap().0);
        batch.finish(&channel);
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(events.lock().unwrap()[0]["type"], "done");
        // 第二次派发（对应修复前 pump 尾部的无条件补发路径）：
        // 缓冲已空 → done=false，不产生第二个 Done
        assert!(!event.dispatch(&mut output_bytes, &mut batch).unwrap().0);
        assert_eq!(events.lock().unwrap().len(), 1);
    }
}
