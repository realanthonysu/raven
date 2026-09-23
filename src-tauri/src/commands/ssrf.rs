//! SSRF 防护：URL 校验、DNS 解析守卫。
//!
//! 从 proxy.rs 拆出，便于单独演进与审计。策略：
//! - 仅 http/https
//! - 拒绝私网 / 链路本地 / 未指定地址；放行回环（本地 Ollama 等）
//! - 域名解析后逐 IP 复检（DNS 重绑定）
//! - reqwest Client 使用 [`GuardedDns`]，连接阶段解析同样过滤

use std::net::Ipv4Addr;

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

/// 对单个解析结果 IP 套用与裸 IP 相同的私网段规则（v4-mapped v6 先还原）。
pub fn judge_resolved_ip(ip: std::net::IpAddr) -> Result<(), AppError> {
    match ip {
        std::net::IpAddr::V4(ip) => judge_ipv4_address(ip),
        std::net::IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                judge_ipv4_address(v4)
            } else if ip.is_loopback() {
                Ok(())
            } else if ip.is_unspecified() || ip.is_unique_local() || ip.is_unicast_link_local() {
                Err(AppError::Validation(format!("禁止访问私网地址 {ip}")))
            } else {
                Ok(())
            }
        }
    }
}

/// 解析 host 的全部 A/AAAA，并逐 IP 校验（DNS 重绑定防护）。
fn resolve_and_judge_host(domain: &str) -> Result<(), AppError> {
    use std::net::ToSocketAddrs;
    let addrs = (domain, 0u16)
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

/// 校验代理目标 URL：scheme/host 合法 + 裸 IP 私网段 + 域名解析复检。
pub fn validate_proxy_url(raw: &str) -> Result<(), AppError> {
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
            resolve_and_judge_host(domain)
        }
        Host::Ipv4(ip) => judge_ipv4_address(ip),
        Host::Ipv6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                judge_ipv4_address(v4)
            } else if ip.is_unspecified() {
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
