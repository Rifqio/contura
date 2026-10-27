//! The base URL policy: `https://` or `http://`, never a user name or password in the
//! URL, and an API key over plain http only to this PC (loopback). Plain http to another
//! machine is allowed for a keyless server, such as Ollama on the LAN; the provider
//! refuses it when a key would go (L3, security audit 1.0, revised).

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
    match url.scheme() {
        "https" | "http" if url.host().is_some() => Ok(url),
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

/// Plain http to a host other than this PC: what goes there crosses a network
/// unencrypted, so no API key may go (`AiService::provider_for`).
pub fn plain_text_off_this_computer(url: &Url) -> bool {
    url.scheme() == "http" && !url.host().is_some_and(|h| is_loopback(&h))
}

/// A private, link-local or unique-local address, where plain http skips the proxy so
/// a LAN server's prompt never crosses a proxy in clear text.
pub fn is_private_network(host: &Host<&str>) -> bool {
    fn v4(ip: &Ipv4Addr) -> bool {
        ip.is_private() || ip.is_link_local()
    }
    fn v6(ip: &Ipv6Addr) -> bool {
        if let Some(mapped) = ip.to_ipv4_mapped() {
            return v4(&mapped);
        }
        let first = ip.segments()[0];
        first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
    }
    match host {
        Host::Domain(_) => false,
        Host::Ipv4(ip) => v4(ip),
        Host::Ipv6(ip) => v6(ip),
    }
}

/// This PC, where plain http is allowed: `localhost`, 127.0.0.0/8, `::1`, and an
/// IPv4-mapped loopback address.
pub fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => {
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
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
    fn http_on_loopback_is_accepted() {
        for raw in [
            "http://127.0.0.1:11434/v1",
            "http://localhost:1234/v1",
            "http://LocalHost:1234/v1",
            "http://127.0.0.5/v1",
            "http://[::1]:8080/v1",
        ] {
            assert!(check_base_url(raw).is_ok(), "{raw}");
        }
    }

    #[test]
    fn http_off_this_computer_is_plain_text_and_keyless_only() {
        // L3 (security audit 1.0, revised): plain http to another machine is allowed, but
        // it is plain text, so the caller never sends a key there.
        for raw in [
            "http://192.168.1.20/v1",
            "http://10.0.0.5:8080/v1",
            "http://[fd00::1]/v1",
            "http://ollama.lan/v1",
            "http://api.groq.com/openai/v1",
            "http://[::ffff:192.168.1.20]/v1",
        ] {
            let url = check_base_url(raw).unwrap();
            assert!(plain_text_off_this_computer(&url), "{raw}");
        }
        for raw in [
            "http://127.0.0.1:11434/v1",
            "http://localhost:1234/v1",
            "http://[::1]/v1",
            "http://[::ffff:127.0.0.1]:8080/v1",
            "https://192.168.1.20/v1",
            "https://api.groq.com/openai/v1",
        ] {
            let url = check_base_url(raw).unwrap();
            assert!(!plain_text_off_this_computer(&url), "{raw}");
        }
        assert_eq!(
            AiError::InsecureUrl { host: "h".into() }.to_string(),
            "this address is not encrypted; use https or a local address on this computer, or remove the saved key"
        );
    }

    #[test]
    fn not_a_private_network() {
        // Restored from the cases the first L3 change dropped: plain http to these goes
        // through the proxy like any public host.
        let private = |raw: &str| {
            let url = Url::parse(raw).unwrap();
            url.host().is_some_and(|h| is_private_network(&h))
        };
        assert!(!private("http://172.32.0.1/v1"));
        assert!(!private("http://[::ffff:8.8.8.8]/v1"));
        assert!(private("http://172.16.0.9/v1"));
        assert!(private("http://[::ffff:192.168.1.20]/v1"));
    }

    #[test]
    fn other_schemes_are_refused() {
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
}
