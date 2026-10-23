//! The update check's HTTP client: the second file that names `reqwest` (the first is
//! `ai/provider/http.rs`). https only, to GitHub's hosts only, redirects followed by hand
//! so each hop is checked, a size cap, time limits, and downloads streamed to a file.
//!
//! A request carries no cookie, no token and no version: only the URL and
//! `User-Agent: Contura`.

use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{CONTENT_LENGTH, LOCATION, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::{Client, Response};
use rustls_platform_verifier::BuilderVerifierExt;
use tokio::time::{Instant, timeout_at};
use url::Url;

use super::{UpdateError, host_text};

/// Where the manifest and the release files may come from. GitHub answers a release
/// download from github.com with a redirect to one of its file hosts.
pub const GITHUB_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// At most this many redirects per request.
const MAX_REDIRECTS: usize = 5;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub connect: Duration,
    /// From sending a request to its response head.
    pub first_byte: Duration,
    /// The longest gap between two chunks of a body.
    pub idle: Duration,
    /// The manifest, redirects included.
    pub manifest: Duration,
    /// A whole download, redirects included.
    pub download: Duration,
}

impl Limits {
    pub const STANDARD: Limits = Limits {
        connect: Duration::from_secs(15),
        first_byte: Duration::from_secs(30),
        idle: Duration::from_secs(30),
        manifest: Duration::from_secs(60),
        download: Duration::from_secs(30 * 60),
    };
}

/// Refuses a URL that is not https (when `https_only`) or not on one of `hosts`.
pub fn check_url(url: &Url, hosts: &[&str], https_only: bool) -> Result<(), UpdateError> {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let scheme_ok = url.scheme() == "https" || (!https_only && url.scheme() == "http");
    let has_credentials = !url.username().is_empty() || url.password().is_some();
    if !scheme_ok || has_credentials || !hosts.iter().any(|h| *h == host) {
        return Err(UpdateError::HostNotAllowed {
            host: if host.is_empty() {
                "an unknown host".into()
            } else {
                host
            },
        });
    }
    Ok(())
}

pub struct Fetcher {
    client: Client,
    hosts: Vec<&'static str>,
    /// The host a release file's address must name (the redirects may go to `hosts`).
    release_host: &'static str,
    https_only: bool,
    limits: Limits,
}

impl Fetcher {
    /// The client the app uses: GitHub's hosts over https, through the system proxy.
    pub fn github() -> Result<Fetcher, UpdateError> {
        Ok(Fetcher {
            client: client(&Limits::STANDARD, true)?,
            hosts: GITHUB_HOSTS.to_vec(),
            release_host: "github.com",
            https_only: true,
            limits: Limits::STANDARD,
        })
    }

    /// A client for the local test server: plain http to `hosts`, no proxy.
    #[cfg(test)]
    pub(crate) fn for_tests(hosts: &[&'static str], limits: Limits) -> Fetcher {
        Fetcher {
            client: client(&limits, false).unwrap(),
            hosts: hosts.to_vec(),
            release_host: hosts[0],
            https_only: false,
            limits,
        }
    }

    /// Refuses a release file address that is not on the release host (github.com).
    pub fn check_release(&self, url: &Url) -> Result<(), UpdateError> {
        check_url(url, &[self.release_host], self.https_only)
    }

    /// Refuses a URL this client would not fetch.
    pub fn check(&self, url: &Url) -> Result<(), UpdateError> {
        check_url(url, &self.hosts, self.https_only)
    }

    /// GETs `url`, following redirects that stay on the allowed hosts, and returns the
    /// final 2xx response.
    async fn open(&self, url: &Url, deadline: Instant) -> Result<Response, UpdateError> {
        let mut url = url.clone();
        for _ in 0..=MAX_REDIRECTS {
            self.check(&url)?;
            let host = host_text(&url);
            let first_byte = deadline.min(Instant::now() + self.limits.first_byte);
            let sent = self
                .client
                .get(url.clone())
                .header(USER_AGENT, "Contura")
                .send();
            let resp = match timeout_at(first_byte, sent).await {
                Err(_) => return Err(UpdateError::Timeout { host }),
                Ok(Err(e)) if e.is_timeout() => return Err(UpdateError::Timeout { host }),
                Ok(Err(_)) => return Err(UpdateError::Network { host }),
                Ok(Ok(resp)) => resp,
            };
            let status = resp.status();
            if status.is_redirection() {
                let next = resp
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|loc| url.join(loc).ok())
                    .ok_or(UpdateError::Status {
                        host: host.clone(),
                        status: status.as_u16(),
                    })?;
                url = next;
                continue;
            }
            if !status.is_success() {
                return Err(UpdateError::Status {
                    host,
                    status: status.as_u16(),
                });
            }
            return Ok(resp);
        }
        Err(UpdateError::Network {
            host: host_text(&url),
        })
    }

    /// Reads the next chunk of `resp`, within the idle limit and `deadline`.
    async fn chunk(
        &self,
        resp: &mut Response,
        host: &str,
        deadline: Instant,
    ) -> Result<Option<impl std::ops::Deref<Target = [u8]> + use<>>, UpdateError> {
        let until = deadline.min(Instant::now() + self.limits.idle);
        match timeout_at(until, resp.chunk()).await {
            Err(_) => Err(UpdateError::Timeout { host: host.into() }),
            Ok(Err(e)) if e.is_timeout() => Err(UpdateError::Timeout { host: host.into() }),
            Ok(Err(_)) => Err(UpdateError::Network { host: host.into() }),
            Ok(Ok(chunk)) => Ok(chunk),
        }
    }

    /// The body of `url`, at most `cap` bytes (the manifest).
    pub async fn fetch_bytes(&self, url: &Url, cap: u64) -> Result<Vec<u8>, UpdateError> {
        let deadline = Instant::now() + self.limits.manifest;
        let mut resp = self.open(url, deadline).await?;
        let host = host_text(resp.url());
        if declared_length(&resp).is_some_and(|n| n > cap) {
            return Err(UpdateError::BadManifest);
        }
        let mut body = Vec::new();
        while let Some(chunk) = self.chunk(&mut resp, &host, deadline).await? {
            if body.len() as u64 + chunk.len() as u64 > cap {
                return Err(UpdateError::BadManifest);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    /// Streams `url` into `out`, at most `cap` bytes, and returns the size. `progress` is
    /// called with the bytes so far and the declared total. A body over the cap is
    /// `TooLarge`; the caller deletes the partial file on any error.
    pub async fn download(
        &self,
        url: &Url,
        out: &mut impl Write,
        cap: u64,
        progress: &mut (dyn FnMut(u64, Option<u64>) + Send),
    ) -> Result<u64, UpdateError> {
        let deadline = Instant::now() + self.limits.download;
        let mut resp = self.open(url, deadline).await?;
        let host = host_text(resp.url());
        let total = declared_length(&resp);
        if total.is_some_and(|n| n > cap) {
            return Err(UpdateError::TooLarge);
        }
        let mut done = 0u64;
        progress(0, total);
        while let Some(chunk) = self.chunk(&mut resp, &host, deadline).await? {
            done += chunk.len() as u64;
            if done > cap {
                return Err(UpdateError::TooLarge);
            }
            out.write_all(&chunk).map_err(|e| UpdateError::Write {
                message: e.to_string(),
            })?;
            progress(done, total);
        }
        if total.is_some_and(|n| n != done) {
            return Err(UpdateError::Network { host });
        }
        out.flush().map_err(|e| UpdateError::Write {
            message: e.to_string(),
        })?;
        Ok(done)
    }
}

/// The body's declared size, when the server sent one.
fn declared_length(resp: &Response) -> Option<u64> {
    resp.headers()
        .get(CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

/// rustls with ring and the OS certificate store, as the AI client; redirects off (they
/// are followed by hand). A setup failure says the network is unavailable.
fn client(limits: &Limits, proxied: bool) -> Result<Client, UpdateError> {
    let failed = || UpdateError::Network {
        host: "github.com".into(),
    };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .and_then(|b| b.with_platform_verifier())
        .map_err(|_| failed())?
        .with_no_client_auth();
    let mut builder = Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(Policy::none())
        .connect_timeout(limits.connect)
        .pool_idle_timeout(Duration::from_secs(30));
    if !proxied {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| failed())
}
