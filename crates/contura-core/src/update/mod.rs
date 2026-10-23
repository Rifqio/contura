//! One-click updates (ADR 0026): the signed release manifest, the version rule, the
//! download checks and the file swap.
//!
//! Checks are off until the user turns them on (`UpdateSettings::checks`). What leaves
//! the computer is a GET of `latest.json` from github.com and, when the user updates, a
//! GET of the one release file; nothing else is sent. Only `update/http.rs` talks HTTP
//! here, and nothing under `update/` reaches a Connection, the AI or the keyring.

pub mod http;
pub mod install;
pub mod manifest;
pub mod service;
pub mod verify;

#[cfg(test)]
mod test_sign;

use serde::Serialize;

pub use manifest::{Manifest, Offer, PlatformAsset};
pub use service::{CheckResult, UpdateService, UpdateSettings, UpdateStatus};

/// Where the release manifest is read from. GitHub never serves a draft or a pre-release
/// as "latest".
pub const MANIFEST_URL: &str =
    "https://github.com/Rifqio/contura/releases/latest/download/latest.json";
/// A release's page, for the notice that links to it.
pub const RELEASES_URL: &str = "https://github.com/Rifqio/contura/releases";
/// A download larger than this is stopped and deleted.
pub const MAX_DOWNLOAD_BYTES: u64 = 300 * 1024 * 1024;
/// The manifest is small; anything larger than this is not one.
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// How this copy of Contura was installed, which decides how it updates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallKind {
    /// The Windows portable exe: swapped in place.
    Portable,
    /// A Linux AppImage (`$APPIMAGE`): swapped in place.
    AppImage,
    /// Anything else (the .deb under /usr, a dev build): the notice links to the release.
    Package,
}

impl InstallKind {
    /// The `platforms` key of `latest.json` this install updates from; none for a package.
    pub fn platform_key(self) -> Option<&'static str> {
        match self {
            InstallKind::Portable => Some("windows-x86_64-portable"),
            InstallKind::AppImage => Some("linux-x86_64-appimage"),
            InstallKind::Package => None,
        }
    }
}

/// Why a check, a download or a swap failed. The text is the sentence the user sees.
#[derive(thiserror::Error, Clone, Debug, PartialEq, Eq)]
pub enum UpdateError {
    #[error("Contura could not reach {host}. Check the internet connection and try again.")]
    Network { host: String },
    #[error("{host} did not answer in time. Try again later.")]
    Timeout { host: String },
    #[error("{host} answered with status {status}. Try again later.")]
    Status { host: String, status: u16 },
    #[error("Contura only downloads updates from GitHub, not from {host}.")]
    HostNotAllowed { host: String },
    #[error("The release information on GitHub could not be read.")]
    BadManifest,
    #[error(
        "The release information names a file that is not this release's own, so Contura did not download it."
    )]
    NotThisRelease,
    #[error("The download is larger than 300 MB, so Contura stopped it.")]
    TooLarge,
    #[error("The download did not match its signature, so nothing was changed.")]
    BadSignature,
    #[error(
        "Contura cannot write to {folder}, so it cannot update itself there. Download the new version from the release page instead."
    )]
    NotWritable { folder: String },
    #[error("No update is ready. Check for updates first.")]
    NothingReady,
    #[error("This copy of Contura is updated from the release page.")]
    Manual,
    #[error("An update is already downloading.")]
    Busy,
    #[error("Contura could not save the download ({message}).")]
    Write { message: String },
    #[error("Contura could not replace its program file ({message}). Nothing was changed.")]
    Replace { message: String },
    #[error(
        "Contura was updated, but the new version did not start ({message}). Close Contura and start it again."
    )]
    Relaunch { message: String },
    /// The update could not take the program's name and the program could not be put back.
    #[error(
        "Contura could not finish replacing its program file ({message}) and could not put the old one back. Your current version is kept as {old}: rename it to {name} to start Contura again."
    )]
    Stranded {
        message: String,
        old: String,
        name: String,
    },
}

impl From<UpdateError> for crate::Error {
    fn from(e: UpdateError) -> Self {
        crate::Error::Update(e)
    }
}

/// The host of `url` for a message, never the path or the query.
pub(crate) fn host_text(url: &url::Url) -> String {
    url.host_str().unwrap_or("the server").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every sentence the user can read: no em or en dash, never "cursor" or "caret".
    #[test]
    fn error_copy_follows_the_copy_rules() {
        let host = || "github.com".to_string();
        let all = [
            UpdateError::Network { host: host() },
            UpdateError::Timeout { host: host() },
            UpdateError::Status {
                host: host(),
                status: 404,
            },
            UpdateError::HostNotAllowed { host: host() },
            UpdateError::BadManifest,
            UpdateError::NotThisRelease,
            UpdateError::TooLarge,
            UpdateError::BadSignature,
            UpdateError::NotWritable {
                folder: "/opt/x".into(),
            },
            UpdateError::NothingReady,
            UpdateError::Manual,
            UpdateError::Busy,
            UpdateError::Write {
                message: "disk full".into(),
            },
            UpdateError::Replace {
                message: "denied".into(),
            },
            UpdateError::Relaunch {
                message: "denied".into(),
            },
            UpdateError::Stranded {
                message: "denied".into(),
                old: "C:\\Apps\\contura.old.exe".into(),
                name: "Contura_1.0.0_x64_portable.exe".into(),
            },
        ];
        for e in all {
            let text = e.to_string();
            assert!(
                !text.contains('\u{2013}') && !text.contains('\u{2014}'),
                "{text}"
            );
            let lower = text.to_lowercase();
            assert!(
                !lower.contains("cursor") && !lower.contains("caret"),
                "{text}"
            );
            assert!(text.ends_with('.'), "{text}");
        }
        assert_eq!(
            UpdateError::BadSignature.to_string(),
            "The download did not match its signature, so nothing was changed."
        );
    }

    #[test]
    fn an_update_error_reaches_the_ui_as_its_sentence() {
        let json = serde_json::to_value(crate::Error::from(UpdateError::TooLarge)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "update", "message": "The download is larger than 300 MB, so Contura stopped it."})
        );
    }

    #[test]
    fn platform_keys() {
        assert_eq!(
            InstallKind::Portable.platform_key(),
            Some("windows-x86_64-portable")
        );
        assert_eq!(
            InstallKind::AppImage.platform_key(),
            Some("linux-x86_64-appimage")
        );
        assert_eq!(InstallKind::Package.platform_key(), None);
    }
}
