//! `latest.json`, as the release workflow writes it, and the rule for what is offered.
//!
//! The manifest itself is not signed. What binds a download to its release is the file's
//! minisign signature, whose signed trusted comment names the file (`file:<name>`), and
//! every release file name carries its version and platform. So the offer pins the exact
//! file name and its URL path here, and `verify` requires the signed name to match.

use std::collections::BTreeMap;

use semver::{BuildMetadata, Version};
use serde::{Deserialize, Serialize};
use url::Url;

use super::{RELEASES_URL, UpdateError};

/// Release notes are cut to this many characters before they are kept or shown.
const NOTES_CHARS: usize = 8_000;
/// The repository whose releases Contura updates from.
pub const REPO_PATH: &str = "/Rifqio/contura";

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub platforms: BTreeMap<String, PlatformAsset>,
}

/// One downloadable file: where it is, its minisign signature (the Tauri signer's `.sig`
/// file, base64) and its SHA-256 (hex).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlatformAsset {
    pub url: String,
    pub signature: String,
    pub sha256: String,
}

/// A newer release this copy can move to. `asset` is the file for this install, when the
/// release has one and this install can swap itself; otherwise the notice links to
/// `release_url`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub version: String,
    pub notes: String,
    pub pub_date: Option<String>,
    pub release_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<PlatformAsset>,
}

pub fn parse(bytes: &[u8]) -> Result<Manifest, UpdateError> {
    serde_json::from_slice(bytes).map_err(|_| UpdateError::BadManifest)
}

/// A version as a release names it, with or without a leading `v`. Build metadata
/// (`+...`) is dropped: it never makes a version newer.
pub fn parse_version(text: &str) -> Option<Version> {
    let mut v = Version::parse(text.trim().trim_start_matches('v')).ok()?;
    v.build = BuildMetadata::EMPTY;
    Some(v)
}

/// The release file of `platform` at `version`, as `.github/workflows/release.yml` names
/// it and the Tauri signer writes into the signature's `file:` field.
pub fn asset_name(platform: &str, version: &Version) -> Option<String> {
    match platform {
        "windows-x86_64-portable" => Some(format!("Contura_{version}_x64_portable.exe")),
        "linux-x86_64-appimage" => Some(format!("Contura_{version}_amd64.AppImage")),
        _ => None,
    }
}

/// The path every release file of `version` is downloaded from on github.com.
pub fn asset_path(platform: &str, version: &Version) -> Option<String> {
    Some(format!(
        "{REPO_PATH}/releases/download/v{version}/{}",
        asset_name(platform, version)?
    ))
}

/// What `manifest` offers to a copy at `current` that updates from `platform`: nothing
/// when its version is a pre-release or not newer. The file's address must be the
/// release's own (`asset_path`) on the host `allow` accepts (https on github.com, in the
/// app); anything else refuses the whole manifest.
pub fn choose(
    manifest: &Manifest,
    current: &Version,
    platform: Option<&str>,
    allow: impl Fn(&Url) -> Result<(), UpdateError>,
) -> Result<Option<Offer>, UpdateError> {
    let Some(version) = parse_version(&manifest.version) else {
        return Err(UpdateError::BadManifest);
    };
    let mut current = current.clone();
    current.build = BuildMetadata::EMPTY;
    if !version.pre.is_empty() || version <= current {
        return Ok(None);
    }
    let asset = match platform.and_then(|p| Some((p, manifest.platforms.get(p)?))) {
        Some((platform, asset)) => {
            let url = Url::parse(&asset.url).map_err(|_| UpdateError::BadManifest)?;
            allow(&url)?;
            let expected = asset_path(platform, &version).ok_or(UpdateError::BadManifest)?;
            if url.path() != expected || url.query().is_some() || url.fragment().is_some() {
                return Err(UpdateError::NotThisRelease);
            }
            if !is_sha256_hex(&asset.sha256) || asset.signature.trim().is_empty() {
                return Err(UpdateError::BadManifest);
            }
            Some(asset.clone())
        }
        None => None,
    };
    Ok(Some(Offer {
        version: version.to_string(),
        notes: manifest.notes.chars().take(NOTES_CHARS).collect(),
        pub_date: manifest.pub_date.clone(),
        release_url: format!("{RELEASES_URL}/tag/v{version}"),
        asset,
    }))
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::super::http::check_url;
    use super::*;

    fn choose(
        m: &Manifest,
        current: &Version,
        platform: Option<&str>,
    ) -> Result<Option<Offer>, UpdateError> {
        super::choose(m, current, platform, |u| {
            check_url(u, &["github.com"], true)
        })
    }

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SHA2: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    fn manifest(version: &str, url: &str) -> Manifest {
        parse(
            serde_json::json!({
                "version": version,
                "notes": "Fixes.",
                "pub_date": "2026-11-01T10:00:00Z",
                "platforms": {
                    "windows-x86_64-portable": { "url": url, "signature": "c2lnLWV4ZQ==", "sha256": SHA },
                    "linux-x86_64-appimage": {
                        "url": format!("https://github.com/Rifqio/contura/releases/download/v{0}/Contura_{0}_amd64.AppImage", version.trim_start_matches('v')),
                        "signature": "c2lnLWFwcGltYWdl",
                        "sha256": SHA2
                    }
                }
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap()
    }

    const EXE: &str =
        "https://github.com/Rifqio/contura/releases/download/v1.0.1/Contura_1.0.1_x64_portable.exe";

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn parses_the_release_workflow_shape() {
        let m = manifest("1.0.1", EXE);
        assert_eq!(m.version, "1.0.1");
        assert_eq!(m.notes, "Fixes.");
        assert_eq!(m.pub_date.as_deref(), Some("2026-11-01T10:00:00Z"));
        assert_eq!(m.platforms.len(), 2);
        assert_eq!(m.platforms["windows-x86_64-portable"].url, EXE);
    }

    #[test]
    fn junk_is_a_bad_manifest() {
        assert_eq!(parse(b"<html>").unwrap_err(), UpdateError::BadManifest);
        assert_eq!(parse(b"{}").unwrap_err(), UpdateError::BadManifest);
        let m = manifest("one", EXE);
        assert_eq!(
            choose(&m, &v("1.0.0"), None).unwrap_err(),
            UpdateError::BadManifest
        );
    }

    #[test]
    fn offers_only_a_newer_release() {
        let m = manifest("1.0.1", EXE);
        let offer = choose(&m, &v("1.0.0"), Some("windows-x86_64-portable"))
            .unwrap()
            .unwrap();
        assert_eq!(offer.version, "1.0.1");
        assert_eq!(offer.asset.unwrap().url, EXE);
        assert_eq!(
            offer.release_url,
            "https://github.com/Rifqio/contura/releases/tag/v1.0.1"
        );
        // Equal and lower versions are never offered: no downgrade.
        assert_eq!(
            choose(&m, &v("1.0.1"), Some("windows-x86_64-portable")),
            Ok(None)
        );
        assert_eq!(
            choose(&m, &v("1.2.0"), Some("windows-x86_64-portable")),
            Ok(None)
        );
    }

    #[test]
    fn a_leading_v_is_accepted() {
        let m = manifest(
            "v1.1.0",
            "https://github.com/Rifqio/contura/releases/download/v1.1.0/Contura_1.1.0_x64_portable.exe",
        );
        let offer = choose(&m, &v("1.0.0"), None).unwrap().unwrap();
        assert_eq!(offer.version, "1.1.0");
    }

    #[test]
    fn pre_releases_are_ignored() {
        let m = manifest("1.1.0-beta.1", EXE);
        assert_eq!(
            choose(&m, &v("1.0.0"), Some("windows-x86_64-portable")),
            Ok(None)
        );
        // A pre-release is lower than its release, so a beta user is offered 1.1.0.
        let m = manifest("1.1.0", EXE);
        assert!(choose(&m, &v("1.1.0-beta.1"), None).unwrap().is_some());
        let m = manifest(
            "1.1.0",
            "https://github.com/Rifqio/contura/releases/download/v1.1.0/Contura_1.1.0_x64_portable.exe",
        );
        assert!(
            choose(&m, &v("1.1.0-beta.1"), Some("windows-x86_64-portable"))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_package_install_gets_the_notice_without_a_file() {
        let m = manifest("1.0.1", EXE);
        let offer = choose(&m, &v("1.0.0"), None).unwrap().unwrap();
        assert_eq!(offer.asset, None);
        // So does a platform the release has no file for.
        let offer = choose(&m, &v("1.0.0"), Some("linux-aarch64-appimage"))
            .unwrap()
            .unwrap();
        assert_eq!(offer.asset, None);
    }

    #[test]
    fn a_file_off_github_or_over_http_is_refused() {
        let m = manifest("1.0.1", "https://example.com/Contura.exe");
        assert_eq!(
            choose(&m, &v("1.0.0"), Some("windows-x86_64-portable")).unwrap_err(),
            UpdateError::HostNotAllowed {
                host: "example.com".into()
            }
        );
        let m = manifest(
            "1.0.1",
            "http://github.com/Rifqio/contura/releases/download/v1.0.1/Contura_1.0.1_x64_portable.exe",
        );
        assert!(matches!(
            choose(&m, &v("1.0.0"), Some("windows-x86_64-portable")),
            Err(UpdateError::HostNotAllowed { .. })
        ));
    }

    #[test]
    fn a_bad_checksum_field_is_refused() {
        let mut m = manifest("1.0.1", EXE);
        m.platforms
            .get_mut("windows-x86_64-portable")
            .unwrap()
            .sha256 = "abc".into();
        assert_eq!(
            choose(&m, &v("1.0.0"), Some("windows-x86_64-portable")).unwrap_err(),
            UpdateError::BadManifest
        );
    }

    #[test]
    fn long_notes_are_cut() {
        let mut m = manifest("1.0.1", EXE);
        m.notes = "a".repeat(20_000);
        let offer = choose(&m, &v("1.0.0"), None).unwrap().unwrap();
        assert_eq!(offer.notes.chars().count(), NOTES_CHARS);
    }

    #[test]
    fn build_metadata_never_makes_a_version_newer() {
        let m = manifest("1.0.1+r2", EXE);
        assert_eq!(
            choose(&m, &v("1.0.1"), Some("windows-x86_64-portable")),
            Ok(None)
        );
        assert_eq!(
            choose(&m, &v("1.0.1+local"), Some("windows-x86_64-portable")),
            Ok(None)
        );
        let offer = choose(&m, &v("1.0.0"), Some("windows-x86_64-portable"))
            .unwrap()
            .unwrap();
        assert_eq!(offer.version, "1.0.1");
    }

    #[test]
    fn asset_names_match_the_release_workflow() {
        let v1 = v("1.0.1");
        assert_eq!(
            asset_name("windows-x86_64-portable", &v1).unwrap(),
            "Contura_1.0.1_x64_portable.exe"
        );
        assert_eq!(
            asset_name("linux-x86_64-appimage", &v1).unwrap(),
            "Contura_1.0.1_amd64.AppImage"
        );
        assert_eq!(asset_name("linux-aarch64-appimage", &v1), None);
    }

    /// C1: the address must be this release's own file for this platform.
    #[test]
    fn a_file_of_another_release_repo_or_platform_is_refused() {
        let bad = [
            // An older release's file under a newer version: a rollback.
            "https://github.com/Rifqio/contura/releases/download/v1.0.0/Contura_1.0.0_x64_portable.exe",
            // The right name under another tag.
            "https://github.com/Rifqio/contura/releases/download/v1.0.0/Contura_1.0.1_x64_portable.exe",
            // Another repository.
            "https://github.com/someone/contura/releases/download/v1.0.1/Contura_1.0.1_x64_portable.exe",
            // The AppImage in the Windows entry.
            "https://github.com/Rifqio/contura/releases/download/v1.0.1/Contura_1.0.1_amd64.AppImage",
            // Path tricks.
            "https://github.com/Rifqio/contura/releases/download/v1.0.1/../v1.0.0/Contura_1.0.1_x64_portable.exe",
            "https://github.com/Rifqio/contura/releases/download/v1.0.1/Contura_1.0.1_x64_portable.exe?x=1",
        ];
        for url in bad {
            let m = manifest("1.0.1", url);
            let got = choose(&m, &v("1.0.0"), Some("windows-x86_64-portable"));
            assert!(
                matches!(
                    got,
                    Err(UpdateError::NotThisRelease) | Err(UpdateError::BadManifest)
                ),
                "{url}: {got:?}"
            );
        }
        // A release file host other than github.com is refused for the manifest's address.
        let m = manifest(
            "1.0.1",
            "https://objects.githubusercontent.com/Rifqio/contura/releases/download/v1.0.1/Contura_1.0.1_x64_portable.exe",
        );
        assert!(matches!(
            choose(&m, &v("1.0.0"), Some("windows-x86_64-portable")),
            Err(UpdateError::HostNotAllowed { .. })
        ));
    }

    #[test]
    fn each_platform_gets_its_own_entry() {
        let m = manifest("1.0.1", EXE);
        let win = choose(&m, &v("1.0.0"), Some("windows-x86_64-portable"))
            .unwrap()
            .unwrap()
            .asset
            .unwrap();
        let app = choose(&m, &v("1.0.0"), Some("linux-x86_64-appimage"))
            .unwrap()
            .unwrap()
            .asset
            .unwrap();
        assert_ne!(win.url, app.url);
        assert_ne!(win.signature, app.signature);
        assert_ne!(win.sha256, app.sha256);
        assert!(app.url.ends_with("/v1.0.1/Contura_1.0.1_amd64.AppImage"));
    }
}
