//! The base URL policy: `https://` everywhere, plain `http://` only on this PC or a
//! private network, and never a user name or password in the URL.

use std::net::{Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

use crate::ai::AiError;

/// The parsed base URL, or why it may not be used. Errors name the host only.
pub fn check_base_url(raw: &str) -> Result<Url, AiError> {
    let url = Url::parse(raw.trim()).map_err(|_| AiError::InsecureUrl {
        host: String::new(),
    })?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AiError::UrlHasCredentials {
            host: url.host_str().unwrap_or_default().to_string(),
        });
    }
    let local = url.host().is_some_and(|h| is_local(&h));
    match url.scheme() {
        "https" if url.host().is_some() => Ok(url),
        "http" if local => Ok(url),
        _ => Err(AiError::InsecureUrl {
            host: host_of(&url),
        }),
    }
}

/// The host, plus `:port` when the port is not the scheme's default.
pub fn host_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// This PC or a private network, where plain http is allowed.
pub fn is_local(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => is_local_v4(ip),
        Host::Ipv6(ip) => is_local_v6(ip),
    }
}

fn is_local_v4(ip: &Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private() || ip.is_link_local()
}

fn is_local_v6(ip: &Ipv6Addr) -> bool {
    // `::ffff:192.168.1.20` is the IPv4 address it carries.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_local_v4(&v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_err(raw: &str) -> AiError {
        check_base_url(raw).unwrap_err()
    }

    #[test]
    fn https_is_accepted() {
        let url = check_base_url("https://api.groq.com/openai/v1").unwrap();
        assert_eq!(host_of(&url), "api.groq.com");
        let url = check_base_url("https://x.example:8443/v1").unwrap();
        assert_eq!(host_of(&url), "x.example:8443");
    }

    #[test]
    fn http_on_loopback_and_private_is_accepted() {
        for raw in [
            "http://127.0.0.1:11434/v1",
            "http://localhost:1234/v1",
            "http://192.168.1.20/v1",
            "http://10.0.0.5/v1",
            "http://[::1]:8080/v1",
            "http://172.16.0.9/v1",
            "http://169.254.1.1/v1",
            "http://[fd00::1]/v1",
            "http://[fe80::1]/v1",
        ] {
            assert!(check_base_url(raw).is_ok(), "{raw}");
        }
    }

    #[test]
    fn http_on_public_host_is_insecure() {
        assert_eq!(
            host_err("http://api.groq.com/openai/v1"),
            AiError::InsecureUrl {
                host: "api.groq.com".into()
            }
        );
        assert_eq!(
            host_err("http://172.32.0.1/v1"),
            AiError::InsecureUrl {
                host: "172.32.0.1".into()
            }
        );
        assert_eq!(
            host_err("ftp://x.example/v1"),
            AiError::InsecureUrl {
                host: "x.example".into()
            }
        );
    }

    #[test]
    fn credentials_are_refused() {
        let err = host_err("https://u:p@x.example/v1");
        assert_eq!(
            err,
            AiError::UrlHasCredentials {
                host: "x.example".into()
            }
        );
        assert!(!err.to_string().contains("p@"));
        assert!(matches!(
            host_err("https://u@x.example/v1"),
            AiError::UrlHasCredentials { .. }
        ));
    }

    #[test]
    fn garbage_is_bad_url() {
        assert_eq!(
            host_err("not a url"),
            AiError::InsecureUrl {
                host: String::new()
            }
        );
    }

    #[test]
    fn ipv4_mapped_private_is_private() {
        assert!(check_base_url("http://[::ffff:192.168.1.20]/v1").is_ok());
        assert!(check_base_url("http://[::ffff:127.0.0.1]:8080/v1").is_ok());
        assert!(matches!(
            check_base_url("http://[::ffff:8.8.8.8]/v1"),
            Err(AiError::InsecureUrl { .. })
        ));
    }
}
