//! SSRF 防护：URL 校验、DNS 解析守卫。
//!
//! 从 proxy.rs 拆出，便于单独演进与审计。策略：
//! - 仅 http/https
//! - 拒绝私网 / 链路本地 / 未指定地址；放行回环（本地 Ollama 等）
//! - 拒绝可内嵌私网 IPv4 的特殊用途 IPv6 前缀（IPv4-compatible、6to4、Teredo）
//! - 域名解析后逐 IP 复检（DNS 重绑定）
//! - reqwest Client 使用 [`GuardedDns`]，连接阶段解析同样过滤
//! - 域名解析（getaddrinfo）是阻塞调用，经 `spawn_blocking` 移出 Tokio worker

use std::net::{Ipv4Addr, Ipv6Addr};

use url::Host;

use crate::error::AppError;

/// IPv4 地址判定（Ipv4 分支与 v4-mapped IPv6 复检共用）。
/// 回环放行（本地推理服务兼容），未指定/私网/链路本地拒绝，其余放行。
pub fn judge_ipv4_address(ip: Ipv4Addr) -> Result<(), AppError> {
    if ip.is_loopback() {
        Ok(())
    } else if ip.is_unspecified() {
        Err(AppError::Validation(format!("禁止访问未指定地址 {ip}")))
    } else if ip.is_private() || ip.is_link_local() {
        Err(AppError::Validation(format!("禁止访问私网地址 {ip}")))
    } else {
        Ok(())
    }
}

/// 特殊用途 IPv6 前缀：这些地址在双栈系统上可内嵌/中继到私网 IPv4
/// （`::10.0.0.1`、6to4 内嵌 v4、Teredo 内嵌 client/server v4），
/// 按 IPv6 规则单独判定会放行，必须显式拒绝。
/// - IPv4-compatible `::/96`（`::` 与 `::1` 已由 unspecified/loopback 分支先行处理）
/// - 6to4 `2002::/16`
/// - Teredo `2001::/32`
fn is_special_purpose_ipv6(ip: Ipv6Addr) -> bool {
    if ip.to_ipv4().is_some() {
        return true;
    }
    let segments = ip.segments();
    segments[0] == 0x2002 || (segments[0] == 0x2001 && segments[1] == 0)
}

/// IPv6 地址判定（v4-mapped `::ffff:0:0/96` 已由调用方提前还原为 IPv4 再判定，
/// 保证两个入口规则完全一致，避免规则漂移）。
/// 回环放行；未指定/唯一本地/链路本地/特殊用途前缀拒绝；其余全局单播放行。
pub fn judge_ipv6_address(ip: Ipv6Addr) -> Result<(), AppError> {
    if ip.is_unspecified() {
        Err(AppError::Validation("禁止访问未指定地址 ::".into()))
    } else if ip.is_loopback() {
        Ok(())
    } else if ip.is_unique_local() || ip.is_unicast_link_local() {
        Err(AppError::Validation(format!("禁止访问私网地址 {ip}")))
    } else if is_special_purpose_ipv6(ip) {
        Err(AppError::Validation(format!(
            "禁止访问特殊用途 IPv6 地址 {ip}"
        )))
    } else {
        Ok(())
    }
}

/// 对单个解析结果 IP 套用与裸 IP 相同的私网段规则（v4-mapped v6 先还原）。
pub fn judge_resolved_ip(ip: std::net::IpAddr) -> Result<(), AppError> {
    match ip {
        std::net::IpAddr::V4(ip) => judge_ipv4_address(ip),
        std::net::IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                judge_ipv4_address(v4)
            } else {
                judge_ipv6_address(ip)
            }
        }
    }
}

/// 解析 host 的全部 A/AAAA，并逐 IP 校验（DNS 重绑定防护）。
///
/// getaddrinfo 是阻塞系统调用，本函数**只允许**在 `spawn_blocking` 的阻塞
/// 线程池中执行（见 [`resolve_and_judge_host`]）；在 Tokio worker 上直接跑
/// 会在 DNS 慢时占满 runtime worker，拖垮其余并发代理请求。
fn resolve_and_judge_host_blocking(domain: String) -> Result<(), AppError> {
    use std::net::ToSocketAddrs;
    let addrs = (domain.as_str(), 0u16)
        .to_socket_addrs()
        .map_err(|e| AppError::Validation(format!("域名解析失败 {domain}: {e}")))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        judge_resolved_ip(addr.ip())
            .map_err(|e| AppError::Validation(format!("{e}（域名 {domain} 解析结果）")))?;
    }
    if !any {
        return Err(AppError::Validation(format!("域名 {domain} 无解析结果")));
    }
    Ok(())
}

/// 域名解析复检的 async 入口：把阻塞的 getaddrinfo 移出 Tokio worker 线程
/// （与 proxy.rs 的 load_model_config / load_tts_config 同一策略），阻塞任务
///  panic 时映射为 Network 错误（解析失败的对外文案保持不变）。
async fn resolve_and_judge_host(domain: &str) -> Result<(), AppError> {
    let domain = domain.to_string();
    tokio::task::spawn_blocking(move || resolve_and_judge_host_blocking(domain))
        .await
        .map_err(|e| AppError::Network(format!("域名解析任务执行失败: {e}")))?
}

/// 校验代理目标 URL：scheme/host 合法 + 裸 IP 私网段 + 域名解析复检。
///
/// async：域名分支的 getaddrinfo 经 `spawn_blocking` 执行，不能在 Tokio
/// worker 上同步阻塞（DNS 慢时占满 worker 拖垮整个 runtime）。
pub async fn validate_proxy_url(raw: &str) -> Result<(), AppError> {
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
            if domain.eq_ignore_ascii_case("localhost") {
                return Ok(());
            }
            resolve_and_judge_host(domain).await
        }
        Host::Ipv4(ip) => judge_ipv4_address(ip),
        Host::Ipv6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                judge_ipv4_address(v4)
            } else {
                judge_ipv6_address(ip)
            }
        }
    }
}

/// reqwest DNS 解析守卫：解析后拒绝/过滤私网地址，关闭 DNS 重绑定窗口。
#[derive(Debug, Clone, Copy, Default)]
pub struct GuardedDns;

impl reqwest::dns::Resolve for GuardedDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let host = name.as_str().to_ascii_lowercase();
            if host == "localhost" {
                let addrs: Vec<std::net::SocketAddr> =
                    vec!["127.0.0.1:0".parse().expect("static loopback")];
                return Ok(Box::new(addrs.into_iter())
                    as Box<dyn Iterator<Item = std::net::SocketAddr> + Send>);
            }
            let lookup_host = host.clone();
            let addrs = tokio::task::spawn_blocking(move || {
                use std::net::ToSocketAddrs;
                (lookup_host.as_str(), 0u16)
                    .to_socket_addrs()
                    .map(|it| it.collect::<Vec<_>>())
            })
            .await
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                format!("dns task panicked: {e}").into()
            })?
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                format!("dns lookup failed for {host}: {e}").into()
            })?;

            let mut safe = Vec::with_capacity(addrs.len());
            for addr in addrs {
                if let Err(e) = judge_resolved_ip(addr.ip()) {
                    let msg: Box<dyn std::error::Error + Send + Sync> =
                        format!("{e}（域名 {host} 连接时解析）").into();
                    return Err(msg);
                }
                safe.push(addr);
            }
            if safe.is_empty() {
                return Err(format!("域名 {host} 无可用解析结果").into());
            }
            Ok(Box::new(safe.into_iter()) as Box<dyn Iterator<Item = std::net::SocketAddr> + Send>)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn v6(s: &str) -> Ipv6Addr {
        s.parse()
            .expect("test literal must be a valid IPv6 address")
    }

    // ── A3: 特殊用途 IPv6 前缀（可内嵌私网 IPv4）一律拒绝 ──

    #[test]
    fn ipv4_compatible_addresses_are_rejected() {
        // ::/96 内嵌 IPv4：双栈系统上连接即直达对应 IPv4 目标
        for addr in ["::10.0.0.1", "::192.168.1.1", "::169.254.169.254", "::2"] {
            let err = judge_ipv6_address(v6(addr)).unwrap_err();
            assert!(
                matches!(err, AppError::Validation(ref m) if m.contains("特殊用途 IPv6")),
                "{addr} 应按特殊用途地址拒绝，got: {err:?}"
            );
        }
        // :: 与 ::1 是 ::/96 成员但语义先行分支：未指定拒绝、回环放行
        assert!(judge_ipv6_address(v6("::")).is_err());
        assert!(judge_ipv6_address(v6("::1")).is_ok());
    }

    #[test]
    fn six_to_four_prefix_is_rejected() {
        // 2002::/16：6to4 内嵌 IPv4（2002:c0a8:100:: = 192.168.1.0 网段示例）
        let err = judge_ipv6_address(v6("2002:c0a8:100::1")).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("特殊用途 IPv6")),
            "6to4 地址应被拒绝，got: {err:?}"
        );
    }

    #[test]
    fn teredo_prefix_is_rejected() {
        // 2001::/32：Teredo，报文内嵌 client/server IPv4
        let err = judge_ipv6_address(v6("2001:0:1234::1")).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("特殊用途 IPv6")),
            "Teredo 地址应被拒绝，got: {err:?}"
        );
        // 2001:db8::/32（文档前缀）不属于 Teredo，不因前缀拒绝
        assert!(judge_ipv6_address(v6("2001:db8::1")).is_ok());
    }

    #[test]
    fn ipv6_behavior_matches_status_quo_for_existing_rules() {
        // loopback 放行；唯一本地/链路本地/未指定拒绝（与 A3 前一致）
        assert!(judge_ipv6_address(v6("::1")).is_ok());
        assert!(judge_ipv6_address(v6("fd00::1")).is_err());
        assert!(judge_ipv6_address(v6("fe80::1")).is_err());
        assert!(judge_ipv6_address(v6("::")).is_err());
        // 全局单播不受影响
        assert!(judge_ipv6_address(v6("2606:4700::1111")).is_ok());
    }

    #[test]
    fn v4_mapped_ipv6_still_routes_through_ipv4_rules() {
        // ::ffff:0:0/96 由调用方提前还原，不走 judge_ipv6_address 的特殊用途分支
        assert!(judge_resolved_ip(IpAddr::V6(v6("::ffff:127.0.0.1"))).is_ok());
        assert!(judge_resolved_ip(IpAddr::V6(v6("::ffff:10.0.0.1"))).is_err());
        assert!(judge_resolved_ip(IpAddr::V6(v6("::ffff:0.0.0.0"))).is_err());
        // 未 mapped 的 IPv6 解析结果走共享判定：特殊用途前缀同样拒绝
        assert!(judge_resolved_ip(IpAddr::V6(v6("::10.0.0.1"))).is_err());
    }
}
