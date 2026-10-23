//! The one HTTP client for AI providers. With `update/http.rs` (the update check), the only
//! files that name `reqwest`.
//!
//! TLS is rustls with ring and the OS certificate store; redirects are off; the system
//! proxy is used except for this PC and plain http to a private network. Errors name the host only, never the URL, a header
//! or the body; a provider's message is redacted and capped before it is kept.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::HeaderValue;
use reqwest::redirect::Policy;
use reqwest::{Client, Response, StatusCode};
use rustls_platform_verifier::BuilderVerifierExt;
use url::{Host, Url};

use crate::ai::log::{Level, Log};
use crate::ai::provider::url::{host_of, is_local};
use crate::ai::rails::input::{Secrets, redact_secrets};
use crate::ai::{AiError, AiProviderKind};
use crate::error::{Error, Result};

/// At most this many retries after the first attempt.
const MAX_RETRIES: usize = 2;
/// The wait before each retry when the provider names none.
const BACKOFF: [Duration; MAX_RETRIES] = [Duration::from_secs(1), Duration::from_secs(3)];
/// A longer `Retry-After` is not waited out: on 429 and 529 the Ask fails as rate limited,
/// on other statuses the standard back-off is used instead.
const MAX_RETRY_AFTER_SECS: u64 = 10;
/// Shown, stored and logged provider messages are cut to this many characters.
const MESSAGE_CHARS: usize = 200;
/// An error body is read up to this many bytes.
const ERROR_BODY_BYTES: usize = 64 * 1024;
/// A JSON reply (a model list) is read up to this many bytes.
const JSON_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub connect: Duration,
    /// From sending the request to the response head.
    pub first_byte: Duration,
    /// The longest gap between two chunks of the answer.
    pub idle: Duration,
    /// The whole answer, retries included.
    pub answer: Duration,
}

impl Limits {
    pub const STANDARD: Limits = Limits {
        connect: Duration::from_secs(10),
        first_byte: Duration::from_secs(60),
        idle: Duration::from_secs(30),
        answer: Duration::from_secs(5 * 60),
    };
}

pub struct Http {
    /// Through the system proxy.
    proxied: Client,
    /// For this PC and plain http to a private network, which never go through a proxy.
    direct: Client,
    limits: Limits,
}

/// One request. `headers` are `(name, value, sensitive)`; a sensitive value is never
/// printed by the client. `secrets` (provider keys) are redacted from any provider message.
pub struct Call<'a> {
    pub url: Url,
    pub headers: Vec<(&'static str, String, bool)>,
    pub body: Option<serde_json::Value>,
    pub provider: AiProviderKind,
    pub secrets: &'a [String],
    pub deadline: Instant,
}

/// A failed attempt before any response, and whether it may be retried.
struct Failed {
    error: AiError,
    /// The `error=` value in the log line.
    what: &'static str,
    retry: bool,
}

impl Http {
    /// The client every Ask uses, built once with the standard limits. A build that failed
    /// (no usable certificate store, say) fails every later call the same way, never panics.
    pub fn shared() -> Result<&'static Http> {
        static SHARED: OnceLock<std::result::Result<Http, AiError>> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                Http::with_limits(Limits::STANDARD).map_err(|e| match e {
                    Error::Ai(ai) => ai,
                    _ => AiError::Internal,
                })
            })
            .as_ref()
            .map_err(|e| Error::Ai(e.clone()))
    }

    pub fn with_limits(limits: Limits) -> Result<Http> {
        Ok(Http {
            proxied: client(&limits, true)?,
            direct: client(&limits, false)?,
            limits,
        })
    }

    /// The deadline for an answer that starts now.
    pub fn deadline(&self) -> Instant {
        Instant::now() + self.limits.answer
    }

    /// Sends `call` (POST with a body, GET without) and returns the response once its
    /// status is 2xx. Connect failures, 429, 529 and 5xx are retried at most twice, never
    /// past the deadline; nothing is retried once a response is returned.
    pub async fn send(&self, call: &Call<'_>, log: &mut Log) -> Result<Response> {
        let host = host_of(&call.url);
        let model = call
            .body
            .as_ref()
            .and_then(|b| b.get("model")?.as_str())
            .unwrap_or_default();
        let client = if goes_direct(&call.url) {
            &self.direct
        } else {
            &self.proxied
        };
        let mut retries = 0;
        loop {
            let started = Instant::now();
            let attempt = self.attempt(client, call, &host).await;
            let ms = started.elapsed().as_millis().to_string();
            let (error, reason, retry_after) = match attempt {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    log.push(
                        Level::Info,
                        "http",
                        &[
                            ("host", host.clone()),
                            ("status", status.to_string()),
                            ("ms", ms),
                        ],
                    );
                    if resp.status().is_success() {
                        return Ok(resp);
                    }
                    let retry_after = retry_after_secs(&resp);
                    let body = self.error_body(resp, call.deadline).await;
                    let error = map_status(
                        status,
                        retry_after,
                        &body,
                        call.provider,
                        model,
                        call.secrets,
                    );
                    if !retryable(status) {
                        return Err(Error::Ai(error));
                    }
                    let long = retry_after.filter(|s| *s > MAX_RETRY_AFTER_SECS);
                    if let Some(secs) = long
                        && matches!(status, 429 | 529)
                    {
                        return Err(Error::Ai(AiError::RateLimited {
                            retry_after_secs: Some(clamp_u32(secs)),
                        }));
                    }
                    // On 5xx a long wait is not honoured: the standard back-off is used.
                    let wait = retry_after.filter(|_| long.is_none());
                    (error, status.to_string(), wait)
                }
                Err(failed) => {
                    log.push(
                        Level::Warn,
                        "http",
                        &[
                            ("host", host.clone()),
                            ("error", failed.what.to_string()),
                            ("ms", ms),
                        ],
                    );
                    if !failed.retry {
                        return Err(Error::Ai(failed.error));
                    }
                    (failed.error, failed.what.to_string(), None)
                }
            };
            if retries == MAX_RETRIES {
                return Err(Error::Ai(error));
            }
            let wait = retry_after.map_or(BACKOFF[retries], Duration::from_secs);
            if Instant::now() + wait >= call.deadline {
                return Err(Error::Ai(error));
            }
            retries += 1;
            log.push(
                Level::Info,
                "retry",
                &[
                    ("attempt", (retries + 1).to_string()),
                    ("wait_ms", wait.as_millis().to_string()),
                    ("reason", reason),
                ],
            );
            tokio::time::sleep(wait).await;
        }
    }

    /// Hands each chunk of `resp` to `on_bytes` until the body ends or `on_bytes` returns
    /// false. Fails when the first chunk does not come within the first-byte limit, a later
    /// one within the idle limit, or the deadline passes.
    pub async fn read_stream(
        &self,
        mut resp: Response,
        deadline: Instant,
        on_bytes: &mut (dyn FnMut(&[u8]) -> bool + Send),
    ) -> Result<()> {
        let host = host_of(resp.url());
        // The head can come at once while the model is still working: the first chunk gets
        // the first-byte limit, later ones the idle limit.
        let mut first = true;
        loop {
            let (wait, phase) = if first {
                self.wait_for(self.limits.first_byte, "first byte", deadline)?
            } else {
                self.wait_for(self.limits.idle, "idle", deadline)?
            };
            first = false;
            match tokio::time::timeout(wait, resp.chunk()).await {
                Err(_) => return Err(timeout(phase)),
                Ok(Err(_)) => {
                    // Headers came: the request reached the host.
                    return Err(Error::Ai(AiError::Network {
                        host,
                        connect: false,
                    }));
                }
                Ok(Ok(None)) => return Ok(()),
                Ok(Ok(Some(bytes))) => {
                    if !on_bytes(&bytes) {
                        return Ok(());
                    }
                }
            }
        }
    }

    /// The whole body of `resp` as JSON, under the same idle and deadline limits as a
    /// stream. A body over 16 MB or not JSON is `BadResponse`.
    pub async fn read_json(&self, resp: Response, deadline: Instant) -> Result<serde_json::Value> {
        let mut body = Vec::new();
        let mut over = false;
        self.read_stream(resp, deadline, &mut |bytes| {
            if body.len() + bytes.len() > JSON_BODY_BYTES {
                over = true;
                return false;
            }
            body.extend_from_slice(bytes);
            true
        })
        .await?;
        if over {
            return Err(Error::Ai(AiError::BadResponse));
        }
        serde_json::from_slice(&body).map_err(|_| Error::Ai(AiError::BadResponse))
    }

    async fn attempt(
        &self,
        client: &Client,
        call: &Call<'_>,
        host: &str,
    ) -> std::result::Result<Response, Failed> {
        let mut req = match &call.body {
            Some(body) => client.post(call.url.clone()).json(body),
            None => client.get(call.url.clone()),
        };
        for (name, value, sensitive) in &call.headers {
            // The value is never echoed: a bad key is reported as a bad key.
            let mut value = HeaderValue::from_str(value).map_err(|_| Failed {
                error: if *sensitive {
                    AiError::BadKey
                } else {
                    AiError::BadResponse
                },
                what: "header",
                retry: false,
            })?;
            value.set_sensitive(*sensitive);
            req = req.header(*name, value);
        }
        let (wait, phase) = self
            .wait_for(self.limits.first_byte, "first byte", call.deadline)
            .map_err(|_| Failed {
                error: AiError::Timeout {
                    phase: "answer".into(),
                },
                what: "timeout",
                retry: false,
            })?;
        match tokio::time::timeout(wait, req.send()).await {
            Err(_) => Err(Failed {
                error: AiError::Timeout {
                    phase: phase.into(),
                },
                what: "timeout",
                retry: false,
            }),
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(e)) => Err(transport(&e, host)),
        }
    }

    /// The wait for the next step: `limit`, or less when the deadline comes first, with the
    /// phase to name if it runs out.
    fn wait_for(
        &self,
        limit: Duration,
        phase: &'static str,
        deadline: Instant,
    ) -> Result<(Duration, &'static str)> {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(timeout("answer"));
        }
        Ok(if limit < left {
            (limit, phase)
        } else {
            (left, "answer")
        })
    }

    /// Up to 64 KB of an error response's body, or less if it is slow.
    async fn error_body(&self, mut resp: Response, deadline: Instant) -> String {
        let mut body = Vec::new();
        while body.len() < ERROR_BODY_BYTES {
            let Ok((wait, _)) = self.wait_for(self.limits.idle, "idle", deadline) else {
                break;
            };
            match tokio::time::timeout(wait, resp.chunk()).await {
                Ok(Ok(Some(bytes))) => body.extend_from_slice(&bytes),
                _ => break,
            }
        }
        body.truncate(ERROR_BODY_BYTES);
        String::from_utf8_lossy(&body).into_owned()
    }
}

/// The error code Groq sends when the model's tool call arguments are not JSON.
pub const TOOL_USE_FAILED: &str = "tool_use_failed";

/// The error for a non-2xx status, chosen by the code and the body's structured fields
/// (`error.type`, `error.code`), never its message's wording; the message is only checked
/// for the model's id. `model` is the one asked for.
/// The provider's message is its JSON `error.message`, or else the body; it is redacted,
/// then cut to 200 characters.
pub fn map_status(
    status: u16,
    retry_after: Option<u64>,
    body: &str,
    provider: AiProviderKind,
    model: &str,
    secrets: &[String],
) -> AiError {
    let json = serde_json::from_str::<serde_json::Value>(body).ok();
    let field = |path: &str| {
        json.as_ref()
            .and_then(|v| v.pointer(path)?.as_str().map(str::to_string))
    };
    let kind = field("/error/type");
    // Groq refuses a tool call whose arguments it could not parse: the model's tool input,
    // not the response, could not be read.
    if field("/error/code").as_deref() == Some(TOOL_USE_FAILED) {
        return AiError::BadToolInput;
    }
    // Anthropic names a spent balance by type, whatever the status.
    if kind.as_deref() == Some("billing_error") {
        return AiError::OutOfCredit { provider };
    }
    // Anthropic's not_found_error is also what a wrong base URL path gets, so it counts
    // only when its message names the model asked for.
    let names_model = field("/error/message").is_some_and(|m| m.contains(model));
    let retired = kind.as_deref() == Some("not_found_error") && names_model
        || field("/error/code").as_deref() == Some("model_not_found");
    match status {
        401 | 403 => AiError::BadKey,
        402 => AiError::OutOfCredit { provider },
        404 if retired && !model.is_empty() => AiError::ModelRetired {
            model: model.to_string(),
        },
        413 => AiError::TooLarge,
        429 => AiError::RateLimited {
            retry_after_secs: retry_after.map(clamp_u32),
        },
        529 => AiError::Overloaded { provider },
        _ => AiError::Provider {
            status,
            message: provider_message(status, body, secrets),
        },
    }
}

/// The provider's message from an error `body`: its JSON `error.message`, or else the body,
/// redacted and cut to 200 characters; the status's name when nothing is left.
pub fn provider_message(status: u16, body: &str, secrets: &[String]) -> String {
    let json_message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message")?.as_str().map(str::to_string));
    let raw = json_message.unwrap_or_else(|| body.to_string());
    // Redact the whole text before cutting it, so a cut never leaves part of a secret.
    let keys = Secrets {
        keys: secrets.to_vec(),
        passwords: Vec::new(),
    };
    let (clean, _) = redact_secrets(raw.trim(), &keys);
    let short: String = clean.chars().take(MESSAGE_CHARS).collect();
    if short.trim().is_empty() {
        StatusCode::from_u16(status)
            .ok()
            .and_then(|s| s.canonical_reason())
            .unwrap_or("no message")
            .to_string()
    } else {
        short
    }
}

fn retryable(status: u16) -> bool {
    status == 429 || status == 529 || (500..600).contains(&status)
}

/// `Retry-After` in seconds; an HTTP date is ignored.
fn retry_after_secs(resp: &Response) -> Option<u64> {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn clamp_u32(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn timeout(phase: &str) -> Error {
    Error::Ai(AiError::Timeout {
        phase: phase.into(),
    })
}

/// A transport failure before any response. Only connect failures are retried; a failed
/// TLS handshake (a certificate the OS does not trust, a proxy inspecting TLS) is not.
fn transport(e: &reqwest::Error, host: &str) -> Failed {
    if tls_failed(e) {
        return Failed {
            error: AiError::Tls { host: host.into() },
            what: "tls",
            retry: false,
        };
    }
    if e.is_connect() {
        let error = if e.is_timeout() {
            AiError::Timeout {
                phase: "connect".into(),
            }
        } else if offline(e) {
            AiError::Offline
        } else {
            AiError::Network {
                host: host.into(),
                connect: true,
            }
        };
        return Failed {
            error,
            what: "connect",
            retry: true,
        };
    }
    Failed {
        error: AiError::Network {
            host: host.into(),
            // Refused before the request was written, though reqwest did not call it a
            // connect error.
            connect: refused_in(e),
        },
        what: "network",
        retry: false,
    }
}

/// A refused connection anywhere in the error chain.
fn refused_in(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = source {
        source = match err.downcast_ref::<std::io::Error>() {
            Some(io) => {
                if io.kind() == std::io::ErrorKind::ConnectionRefused {
                    return true;
                }
                io.get_ref()
                    .map(|inner| inner as &(dyn std::error::Error + 'static))
            }
            None => err.source(),
        };
    }
    false
}

/// The OS says there is no network at all, rather than that the host refused.
fn offline(e: &reqwest::Error) -> bool {
    offline_in(e)
}

/// `offline` over any error chain. As in `tls_failed`, an `io::Error` is followed through
/// `get_ref()`, since its `source()` skips the error it wraps.
fn offline_in(e: &(dyn std::error::Error + 'static)) -> bool {
    // WSAENETDOWN, WSAENETUNREACH, WSAEHOSTUNREACH on Windows; ENETDOWN, ENETUNREACH elsewhere.
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = source {
        source = match err.downcast_ref::<std::io::Error>() {
            Some(io) => {
                if io.kind() == std::io::ErrorKind::NetworkUnreachable
                    || io.kind() == std::io::ErrorKind::NetworkDown
                {
                    return true;
                }
                if cfg!(windows) && matches!(io.raw_os_error(), Some(10050 | 10051 | 10065)) {
                    return true;
                }
                io.get_ref()
                    .map(|inner| inner as &(dyn std::error::Error + 'static))
            }
            None => err.source(),
        };
    }
    false
}

/// A rustls error somewhere in the chain. An `io::Error`'s `source()` skips the error it
/// wraps (the handshake's is wrapped twice), so it is followed through `get_ref()`.
fn tls_failed(e: &reqwest::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = source {
        if err.is::<rustls::Error>() {
            return true;
        }
        source = match err.downcast_ref::<std::io::Error>() {
            Some(io) => io
                .get_ref()
                .map(|inner| inner as &(dyn std::error::Error + 'static)),
            None => err.source(),
        };
    }
    false
}

/// Requests to this PC, and plain http to a private network, skip the proxy: a LAN
/// server's prompt never crosses a proxy in clear text.
fn goes_direct(url: &Url) -> bool {
    let loopback = match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    loopback || (url.scheme() == "http" && url.host().is_some_and(|h| is_local(&h)))
}

fn client(limits: &Limits, proxied: bool) -> Result<Client> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .and_then(|b| b.with_platform_verifier());
    client_with(tls, limits, proxied)
}

/// The client on `tls`. A TLS setup or client build that failed is `Internal`: nothing was
/// sent, and the reason (which can name paths) is not shown.
fn client_with(
    tls: std::result::Result<
        rustls::ConfigBuilder<rustls::ClientConfig, rustls::client::WantsClientCert>,
        rustls::Error,
    >,
    limits: &Limits,
    proxied: bool,
) -> Result<Client> {
    let tls = tls
        .map_err(|_| Error::Ai(AiError::Internal))?
        .with_no_client_auth();
    let mut builder = Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(Policy::none())
        .connect_timeout(limits.connect)
        .pool_idle_timeout(Duration::from_secs(30));
    if !proxied {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| Error::Ai(AiError::Internal))
}

/// [`Http::send`] on the shared client.
pub async fn send(call: &Call<'_>, log: &mut Log) -> Result<Response> {
    Http::shared()?.send(call, log).await
}

/// [`Http::read_json`] on the shared client.
pub async fn read_json(resp: Response, deadline: Instant) -> Result<serde_json::Value> {
    Http::shared()?.read_json(resp, deadline).await
}

/// [`Http::read_stream`] on the shared client.
pub async fn read_stream(
    resp: Response,
    deadline: Instant,
    on_bytes: &mut (dyn FnMut(&[u8]) -> bool + Send),
) -> Result<()> {
    Http::shared()?.read_stream(resp, deadline, on_bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_use_failed_is_bad_tool_input() {
        let body = r#"{"error":{"message":"Failed to call a function.","type":"invalid_request_error","code":"tool_use_failed"}}"#;
        let e = map_status(400, None, body, AiProviderKind::Groq, "m", &[]);
        assert_eq!(e, AiError::BadToolInput);
    }

    #[test]
    fn private_http_goes_direct() {
        let direct = |raw: &str| goes_direct(&Url::parse(raw).unwrap());
        assert!(direct("https://127.0.0.1:8443/v1"));
        assert!(direct("http://localhost:11434/v1"));
        assert!(direct("http://192.168.1.20:11434/v1"));
        assert!(direct("http://[fd00::1]/v1"));
        assert!(!direct("https://192.168.1.20/v1"));
        assert!(!direct("https://api.groq.com/openai/v1"));
    }

    #[test]
    fn offline_is_found_inside_a_wrapped_io_error() {
        // An io::Error's source() skips the error it wraps, as hyper wraps the OS error.
        let os = std::io::Error::from(std::io::ErrorKind::NetworkUnreachable);
        let wrapped = std::io::Error::other(os);
        assert!(offline_in(&wrapped));
        let refused =
            std::io::Error::other(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert!(!offline_in(&refused));
    }

    #[test]
    fn failed_tls_setup_is_an_error_not_a_panic() {
        let tls = Err(rustls::Error::General("no certificate store".into()));
        let got = client_with(tls, &Limits::STANDARD, true);
        assert!(matches!(got, Err(Error::Ai(AiError::Internal))));
    }
}
