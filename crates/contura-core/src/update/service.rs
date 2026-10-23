//! The update state the app keeps: the user's choice, the last check, the release found,
//! and the verified download waiting for a restart.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use semver::Version;
use serde::{Deserialize, Serialize};
use url::Url;

use super::http::Fetcher;
use super::install::{self, SwapPaths};
use super::manifest::{self, Offer, parse_version};
use super::verify::{self, PUBLIC_KEY};
use super::{
    InstallKind, MANIFEST_URL, MAX_DOWNLOAD_BYTES, MAX_MANIFEST_BYTES, RELEASES_URL, UpdateError,
};
use crate::error::Result;
use crate::store::AppStore;

/// The `settings` row the update state lives in.
const SETTINGS_KEY: &str = "updates";
/// The automatic check runs at most this often.
pub const CHECK_EVERY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    /// None until the first-start prompt is answered: checks are off until then.
    #[serde(default)]
    pub checks: Option<bool>,
    #[serde(default)]
    pub last_check_ms: Option<i64>,
    #[serde(default)]
    pub last_result: Option<CheckResult>,
    /// The newer release the last check found, so the notice survives a restart.
    #[serde(default)]
    pub offer: Option<Offer>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckResult {
    UpToDate,
    Available { version: String },
    Failed { message: String },
}

/// What Settings > Updates and the status bar show.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub checks: Option<bool>,
    pub current_version: String,
    pub last_check_ms: Option<i64>,
    pub last_result: Option<CheckResult>,
    /// A release newer than this copy, if the last check found one.
    pub offer: Option<Offer>,
    pub install: InstallKind,
    /// The offer has a file for this install and the install can swap itself.
    pub can_install: bool,
    /// The offer's file is downloaded and verified, waiting for a restart.
    pub ready: bool,
    pub releases_url: String,
}

pub struct UpdateService {
    store: Mutex<AppStore>,
    current: Version,
    kind: InstallKind,
    paths: Option<SwapPaths>,
    manifest_url: Url,
    key_b64: String,
    fetcher: OnceLock<std::result::Result<Fetcher, UpdateError>>,
    /// The verified download waiting for its restart.
    ready: Mutex<Option<Ready>>,
    downloading: AtomicBool,
}

/// A verified download: the release it is, and where it waits.
#[derive(Clone, Debug)]
struct Ready {
    version: String,
    path: PathBuf,
    asset: manifest::PlatformAsset,
    file_name: String,
}

impl UpdateService {
    /// `target` is the program file to replace: the exe, or `$APPIMAGE`.
    pub fn new(
        store: AppStore,
        current_version: &str,
        kind: InstallKind,
        target: Option<PathBuf>,
    ) -> Self {
        let paths = target.and_then(|t| install::swap_paths(kind, &t));
        // Without a file to swap, the install updates from the release page.
        let kind = if paths.is_none() {
            InstallKind::Package
        } else {
            kind
        };
        Self {
            store: Mutex::new(store),
            current: parse_version(current_version).unwrap_or_else(|| Version::new(0, 0, 0)),
            kind,
            paths,
            manifest_url: Url::parse(MANIFEST_URL).expect("the manifest URL parses"),
            key_b64: PUBLIC_KEY.to_string(),
            fetcher: OnceLock::new(),
            ready: Mutex::new(None),
            downloading: AtomicBool::new(false),
        }
    }

    /// The test setup: a local server, another manifest URL and a test key.
    #[cfg(test)]
    pub(crate) fn with_source(
        mut self,
        fetcher: Fetcher,
        manifest_url: Url,
        key_b64: &str,
    ) -> Self {
        self.fetcher = OnceLock::from(Ok(fetcher));
        self.manifest_url = manifest_url;
        self.key_b64 = key_b64.to_string();
        self
    }

    fn fetcher(&self) -> std::result::Result<&Fetcher, UpdateError> {
        self.fetcher
            .get_or_init(Fetcher::github)
            .as_ref()
            .map_err(Clone::clone)
    }

    pub fn install_kind(&self) -> InstallKind {
        self.kind
    }

    pub fn settings(&self) -> Result<UpdateSettings> {
        let raw = self.store.lock().unwrap().get_setting(SETTINGS_KEY)?;
        // An unreadable row is treated as never answered: checks stay off.
        Ok(raw
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default())
    }

    /// Reads, changes and writes the settings row under one lock.
    fn edit(&self, change: impl FnOnce(&mut UpdateSettings)) -> Result<UpdateSettings> {
        let store = self.store.lock().unwrap();
        let mut s: UpdateSettings = store
            .get_setting(SETTINGS_KEY)?
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        change(&mut s);
        let json = serde_json::to_string(&s).expect("settings serialize");
        store.set_setting(SETTINGS_KEY, &json)?;
        Ok(s)
    }

    /// An offer is shown only while it is newer than this copy (it may have been updated
    /// by hand since the check).
    fn live_offer(&self, s: &UpdateSettings) -> Option<Offer> {
        s.offer
            .clone()
            .filter(|o| parse_version(&o.version).is_some_and(|v| v > self.current))
    }

    fn status_of(&self, s: UpdateSettings) -> UpdateStatus {
        let offer = self.live_offer(&s);
        let can_install = self.paths.is_some() && offer.as_ref().is_some_and(|o| o.asset.is_some());
        let ready = offer
            .as_ref()
            .is_some_and(|o| self.ready_for(&o.version).is_some());
        UpdateStatus {
            checks: s.checks,
            current_version: self.current.to_string(),
            last_check_ms: s.last_check_ms,
            last_result: s.last_result,
            offer,
            install: self.kind,
            can_install,
            ready,
            releases_url: RELEASES_URL.to_string(),
        }
    }

    pub fn status(&self) -> Result<UpdateStatus> {
        Ok(self.status_of(self.settings()?))
    }

    /// The first-start prompt's answer, or the Settings switch.
    pub fn set_checks(&self, on: bool) -> Result<UpdateStatus> {
        let s = self.edit(|s| s.checks = Some(on))?;
        Ok(self.status_of(s))
    }

    /// Checks GitHub for a newer release. `manual` is Check now, which runs even with
    /// checks off; the automatic check runs only with checks on and once a day. A failed
    /// check is recorded in the result, not returned as an error.
    pub async fn check(&self, manual: bool, now_ms: i64) -> Result<UpdateStatus> {
        let before = self.settings()?;
        if !manual {
            let due = before
                .last_check_ms
                .is_none_or(|t| now_ms - t >= CHECK_EVERY_MS || now_ms < t);
            if before.checks != Some(true) || !due {
                return Ok(self.status_of(before));
            }
        }
        let found = self.fetch_offer().await;
        let s = self.edit(|s| {
            s.last_check_ms = Some(now_ms);
            match &found {
                Ok(Some(offer)) => {
                    s.last_result = Some(CheckResult::Available {
                        version: offer.version.clone(),
                    });
                    s.offer = Some(offer.clone());
                }
                Ok(None) => {
                    s.last_result = Some(CheckResult::UpToDate);
                    s.offer = None;
                }
                // The release found before is kept: a failed check does not hide it.
                Err(e) => {
                    s.last_result = Some(CheckResult::Failed {
                        message: e.to_string(),
                    })
                }
            }
        })?;
        Ok(self.status_of(s))
    }

    async fn fetch_offer(&self) -> std::result::Result<Option<Offer>, UpdateError> {
        let fetcher = self.fetcher()?;
        let bytes = fetcher
            .fetch_bytes(&self.manifest_url, MAX_MANIFEST_BYTES)
            .await?;
        let manifest = manifest::parse(&bytes)?;
        manifest::choose(&manifest, &self.current, self.kind.platform_key(), |u| {
            fetcher.check_release(u)
        })
    }

    /// The verified download for `version`, if one waits.
    fn ready_for(&self, version: &str) -> Option<Ready> {
        self.ready
            .lock()
            .unwrap()
            .clone()
            .filter(|r| r.version == version)
    }

    /// Downloads the offered file beside the program and verifies it. A file that fails
    /// a check is deleted. `progress` gets the bytes so far and the total, when known.
    pub async fn download(
        &self,
        progress: &mut (dyn FnMut(u64, Option<u64>) + Send),
    ) -> Result<UpdateStatus> {
        let s = self.settings()?;
        let offer = self.live_offer(&s).ok_or(UpdateError::NothingReady)?;
        let (Some(asset), Some(paths)) = (offer.asset.clone(), self.paths.clone()) else {
            return Err(UpdateError::Manual.into());
        };
        let version = parse_version(&offer.version).ok_or(UpdateError::BadManifest)?;
        let platform = self.kind.platform_key().ok_or(UpdateError::Manual)?;
        let file_name = manifest::asset_name(platform, &version).ok_or(UpdateError::Manual)?;
        if self.downloading.swap(true, Ordering::SeqCst) {
            return Err(UpdateError::Busy.into());
        }
        if let Some(old) = self.ready.lock().unwrap().take() {
            let _ = std::fs::remove_file(old.path);
        }
        let result = self.download_to(&asset, &paths, &file_name, progress).await;
        // Marked ready before the download ends, so a clean-up in between keeps it.
        if let Ok(path) = &result {
            *self.ready.lock().unwrap() = Some(Ready {
                version: offer.version.clone(),
                path: path.clone(),
                asset,
                file_name,
            });
        }
        self.downloading.store(false, Ordering::SeqCst);
        result?;
        self.status()
    }

    /// Writes the download to a fresh file beside the program, verifies the bytes of that
    /// same open handle, syncs it and makes it runnable. Any failure deletes the file.
    async fn download_to(
        &self,
        asset: &manifest::PlatformAsset,
        paths: &SwapPaths,
        file_name: &str,
        progress: &mut (dyn FnMut(u64, Option<u64>) + Send),
    ) -> std::result::Result<PathBuf, UpdateError> {
        let url = Url::parse(&asset.url).map_err(|_| UpdateError::BadManifest)?;
        let key = verify::public_key(&self.key_b64)?;
        let folder = paths.dir().display().to_string();
        // Writable or not is known before anything is downloaded.
        let (path, file) = install::create_download(paths.dir())
            .map_err(|_| UpdateError::NotWritable { folder })?;
        let result = async {
            let mut out = std::io::BufWriter::with_capacity(256 * 1024, &file);
            self.fetcher()?
                .download(&url, &mut out, MAX_DOWNLOAD_BYTES, progress)
                .await?;
            drop(out);
            let write_err = |e: std::io::Error| UpdateError::Write {
                message: e.to_string(),
            };
            file.sync_all().map_err(write_err)?;
            let mut reader = &file;
            std::io::Seek::rewind(&mut reader).map_err(write_err)?;
            verify::verify_reader(reader, &key, &asset.signature, &asset.sha256, file_name)?;
            install::make_runnable(&file).map_err(write_err)
        }
        .await;
        drop(file);
        match result {
            Ok(()) => Ok(path),
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                Err(e)
            }
        }
    }

    /// Verifies the waiting download once more, swaps it in and returns the program file
    /// to start. The caller starts it and exits.
    pub fn apply(&self) -> Result<PathBuf> {
        let s = self.settings()?;
        let offer = self.live_offer(&s).ok_or(UpdateError::NothingReady)?;
        let paths = self.paths.clone().ok_or(UpdateError::Manual)?;
        if self.downloading.load(Ordering::SeqCst) {
            return Err(UpdateError::NothingReady.into());
        }
        let ready = self
            .ready_for(&offer.version)
            .ok_or(UpdateError::NothingReady)?;
        // The file waited beside the program: check it again just before it is run.
        let key = verify::public_key(&self.key_b64)?;
        if let Err(e) = verify::verify_file(
            &ready.path,
            &key,
            &ready.asset.signature,
            &ready.asset.sha256,
            &ready.file_name,
        ) {
            let _ = std::fs::remove_file(&ready.path);
            *self.ready.lock().unwrap() = None;
            return Err(e.into());
        }
        install::swap(&paths, &ready.path).map_err(|e| match e {
            install::SwapError::Unchanged(e) => UpdateError::Replace {
                message: e.to_string(),
            },
            install::SwapError::Stranded(e) => UpdateError::Stranded {
                message: e.to_string(),
                old: paths.old.display().to_string(),
                name: paths
                    .target
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            },
        })?;
        *self.ready.lock().unwrap() = None;
        Ok(paths.target)
    }

    /// Removes the old program and any unfinished download, once this start is up. A
    /// verified download waiting for its restart is kept. True when nothing is left (or
    /// there is nothing to clean).
    pub fn cleanup(&self) -> bool {
        match &self.paths {
            Some(paths) if !self.downloading.load(Ordering::SeqCst) => {
                let keep = self.ready.lock().unwrap().clone().map(|r| r.path);
                install::cleanup(paths, keep.as_deref())
            }
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::http::Limits;
    use super::super::test_sign::TestKey;
    use super::super::verify::sha256_hex;
    use super::*;
    use std::path::Path;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// One reply per connection, in order: status, headers, body.
    type Reply = (u16, Vec<(String, String)>, Vec<u8>);

    /// Serves the replies `make` builds from the server's base URL, one per connection.
    pub(crate) async fn serve(
        make: impl FnOnce(&str) -> Vec<Reply>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let replies = make(&base);
        let handle = tokio::spawn(async move {
            let mut seen = Vec::new();
            for (status, headers, body) in replies {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = sock.read(&mut tmp).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                seen.push(String::from_utf8_lossy(&buf).into_owned());
                let mut head = format!("HTTP/1.1 {status} X\r\nconnection: close\r\n");
                let mut declared = false;
                for (k, v) in headers {
                    declared |= k.eq_ignore_ascii_case("content-length");
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                if !declared {
                    head.push_str(&format!("content-length: {}\r\n", body.len()));
                }
                head.push_str("\r\n");
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
                let _ = sock.shutdown().await;
            }
            seen
        });
        (base, handle)
    }

    fn ok(body: &[u8]) -> Reply {
        (200, Vec::new(), body.to_vec())
    }

    const LIMITS: Limits = Limits {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_secs(5),
        idle: Duration::from_secs(5),
        manifest: Duration::from_secs(10),
        download: Duration::from_secs(10),
    };

    fn store(dir: &Path) -> AppStore {
        AppStore::open(&dir.join("app.sqlite")).unwrap()
    }

    const WIN: &str = "windows-x86_64-portable";
    const APP: &str = "linux-x86_64-appimage";

    /// One platform's entry in `latest.json`.
    struct Entry {
        url: String,
        sig: String,
        sha: String,
    }

    fn v(text: &str) -> Version {
        parse_version(text).unwrap()
    }

    /// The release's own address for the file, on the test server.
    fn file_url(base: &str, version: &str, platform: &str) -> String {
        format!(
            "{base}{}",
            manifest::asset_path(platform, &v(version)).unwrap()
        )
    }

    /// A real entry: `bytes` signed by `key` under this platform's file name at `version`.
    fn signed(base: &str, key: &TestKey, version: &str, platform: &str, bytes: &[u8]) -> Entry {
        let name = manifest::asset_name(platform, &v(version)).unwrap();
        Entry {
            url: file_url(base, version, platform),
            sig: key.sign_as(bytes, &name),
            sha: sha256_hex(bytes),
        }
    }

    /// An entry for checks that never download: its own signature text and checksum.
    fn placeholder(base: &str, version: &str, platform: &str) -> Entry {
        Entry {
            url: file_url(base, version, platform),
            sig: format!("c2ln-{platform}"),
            sha: sha256_hex(platform.as_bytes()),
        }
    }

    fn release(version: &str, win: &Entry, app: &Entry) -> Vec<u8> {
        serde_json::json!({
            "version": version,
            "notes": "Faster grids.",
            "pub_date": "2026-11-01T10:00:00Z",
            "platforms": {
                WIN: { "url": win.url, "signature": win.sig, "sha256": win.sha },
                APP: { "url": app.url, "signature": app.sig, "sha256": app.sha }
            }
        })
        .to_string()
        .into_bytes()
    }

    fn placeholders(base: &str, version: &str) -> Vec<u8> {
        release(
            version,
            &placeholder(base, version, WIN),
            &placeholder(base, version, APP),
        )
    }

    struct Setup {
        _dir: tempfile::TempDir,
        target: PathBuf,
        service: UpdateService,
    }

    impl Setup {
        fn app_dir(&self) -> &Path {
            self.target.parent().unwrap()
        }

        /// The download files waiting beside the program.
        fn downloads(&self) -> Vec<PathBuf> {
            std::fs::read_dir(self.app_dir())
                .unwrap()
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("contura.update")
                })
                .collect()
        }
    }

    fn setup(base: &str, key: &TestKey, kind: InstallKind) -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        std::fs::create_dir(&app).unwrap();
        let target = app.join(match kind {
            InstallKind::Portable => "Contura_1.0.0_x64_portable.exe",
            _ => "Contura_1.0.0_amd64.AppImage",
        });
        std::fs::write(&target, "version 1.0.0").unwrap();
        let service = UpdateService::new(store(dir.path()), "1.0.0", kind, Some(target.clone()))
            .with_source(
                Fetcher::for_tests(&["127.0.0.1"], LIMITS),
                Url::parse(&format!("{base}/latest.json")).unwrap(),
                &key.public_b64(),
            );
        Setup {
            _dir: dir,
            target,
            service,
        }
    }

    const NOW: i64 = 1_800_000_000_000;

    #[tokio::test]
    async fn checks_are_off_until_turned_on() {
        let key = TestKey::generate(*b"testkey1");
        // No server: an automatic check must not connect at all.
        let s = setup("http://127.0.0.1:9", &key, InstallKind::AppImage);
        let status = s.service.status().unwrap();
        assert_eq!(status.checks, None);
        assert_eq!(status.current_version, "1.0.0");
        let status = s.service.check(false, NOW).await.unwrap();
        assert_eq!(status.last_check_ms, None);
        // Not now is remembered, and still means no automatic check.
        let status = s.service.set_checks(false).unwrap();
        assert_eq!(status.checks, Some(false));
        let status = s.service.check(false, NOW).await.unwrap();
        assert_eq!(status.last_check_ms, None);
        assert_eq!(s.service.settings().unwrap().checks, Some(false));
    }

    #[tokio::test]
    async fn check_now_runs_with_checks_off_and_the_daily_check_once_a_day() {
        let key = TestKey::generate(*b"testkey1");
        let (base, server) =
            serve(|b| vec![ok(&placeholders(b, "1.0.0")), ok(&placeholders(b, "1.0.0"))]).await;
        let s = setup(&base, &key, InstallKind::AppImage);
        let status = s.service.check(true, NOW).await.unwrap();
        assert_eq!(status.last_result, Some(CheckResult::UpToDate));
        assert_eq!(status.last_check_ms, Some(NOW));
        assert_eq!(status.checks, None);
        s.service.set_checks(true).unwrap();
        // Within a day: no request.
        let status = s.service.check(false, NOW + 1000).await.unwrap();
        assert_eq!(status.last_check_ms, Some(NOW));
        // A day later: one request.
        let status = s.service.check(false, NOW + CHECK_EVERY_MS).await.unwrap();
        assert_eq!(status.last_check_ms, Some(NOW + CHECK_EVERY_MS));
        let seen = server.await.unwrap();
        assert_eq!(seen.len(), 2);
        // A plain GET of the manifest: no cookie, no token, no version.
        let head = seen[0].to_ascii_lowercase();
        assert!(head.starts_with("get /latest.json http/1.1\r\n"), "{head}");
        assert!(head.contains("user-agent: contura\r\n"));
        assert!(!head.contains("cookie") && !head.contains("authorization"));
        assert!(!head.contains("1.0.0"));
    }

    #[tokio::test]
    async fn a_failed_check_is_recorded_and_keeps_the_offer() {
        let key = TestKey::generate(*b"testkey1");
        let (base, _server) =
            serve(|b| vec![ok(&placeholders(b, "1.0.1")), (500, Vec::new(), Vec::new())]).await;
        let s = setup(&base, &key, InstallKind::AppImage);
        let status = s.service.check(true, NOW).await.unwrap();
        assert_eq!(
            status.last_result,
            Some(CheckResult::Available {
                version: "1.0.1".into()
            })
        );
        assert_eq!(status.offer.as_ref().unwrap().notes, "Faster grids.");
        assert!(status.can_install);
        let status = s.service.check(true, NOW + 5).await.unwrap();
        assert_eq!(
            status.last_result,
            Some(CheckResult::Failed {
                message: "127.0.0.1 answered with status 500. Try again later.".into()
            })
        );
        assert_eq!(status.offer.unwrap().version, "1.0.1");
    }

    /// The whole path on a temp dir: check, download, verify, swap; then the next start
    /// cleans up. The download comes through a redirect on an allowed host.
    #[tokio::test]
    async fn update_downloads_verifies_and_swaps() {
        let key = TestKey::generate(*b"testkey1");
        let program = b"version 1.0.1".repeat(1000);
        let (base, server) = {
            let program = program.clone();
            let key = &key;
            serve(move |b| {
                let app = signed(b, key, "1.0.1", APP, &program);
                vec![
                    ok(&release("1.0.1", &placeholder(b, "1.0.1", WIN), &app)),
                    (
                        302,
                        vec![("location".into(), format!("{b}/files/real"))],
                        Vec::new(),
                    ),
                    ok(&program),
                ]
            })
            .await
        };
        let s = setup(&base, &key, InstallKind::AppImage);
        s.service.set_checks(true).unwrap();
        let status = s.service.check(false, NOW).await.unwrap();
        assert!(status.can_install && !status.ready);
        let mut seen = Vec::new();
        let status = s
            .service
            .download(&mut |done, total| seen.push((done, total)))
            .await
            .unwrap();
        assert!(status.ready);
        assert_eq!(seen.first(), Some(&(0, Some(program.len() as u64))));
        assert_eq!(seen.last().unwrap().0, program.len() as u64);
        let new = s.service.apply().unwrap();
        assert_eq!(new, s.target);
        assert_eq!(std::fs::read(&s.target).unwrap(), program);
        let old = s.app_dir().join("contura.old.AppImage");
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "version 1.0.0");
        // A second apply has nothing to swap.
        assert!(s.service.apply().is_err());
        assert!(s.service.cleanup());
        assert!(!old.exists());
        assert!(s.downloads().is_empty());
        let requests = server.await.unwrap();
        assert!(
            requests[1].starts_with(
                "GET /Rifqio/contura/releases/download/v1.0.1/Contura_1.0.1_amd64.AppImage "
            ),
            "{}",
            requests[1]
        );
        assert!(
            requests[2].starts_with("GET /files/real "),
            "{}",
            requests[2]
        );
    }

    #[tokio::test]
    async fn the_portable_exe_updates_from_its_own_entry() {
        let key = TestKey::generate(*b"testkey1");
        let exe = b"MZ exe 1.0.1".to_vec();
        let (base, _server) = {
            let exe = exe.clone();
            let key = &key;
            serve(move |b| {
                let win = signed(b, key, "1.0.1", WIN, &exe);
                vec![
                    ok(&release("1.0.1", &win, &placeholder(b, "1.0.1", APP))),
                    ok(&exe),
                ]
            })
            .await
        };
        let s = setup(&base, &key, InstallKind::Portable);
        s.service.check(true, NOW).await.unwrap();
        s.service.download(&mut |_, _| {}).await.unwrap();
        s.service.apply().unwrap();
        assert_eq!(std::fs::read(&s.target).unwrap(), exe);
        assert_eq!(
            std::fs::read_to_string(s.app_dir().join("contura.old.exe")).unwrap(),
            "version 1.0.0"
        );
    }

    /// C1: the real, signed 1.0.0 file offered as 9.9.9 at 9.9.9's own address: its
    /// signature names Contura_1.0.0_..., so it is refused and nothing changes.
    #[tokio::test]
    async fn a_signed_older_release_under_a_newer_version_is_refused() {
        let key = TestKey::generate(*b"testkey1");
        let old_program = b"version 1.0.0, known bad".to_vec();
        let (base, _server) = {
            let old_program = old_program.clone();
            let key = &key;
            serve(move |b| {
                let real = signed(b, key, "1.0.0", APP, &old_program);
                let replay = Entry {
                    url: file_url(b, "9.9.9", APP),
                    ..real
                };
                vec![
                    ok(&release("9.9.9", &placeholder(b, "9.9.9", WIN), &replay)),
                    ok(&old_program),
                ]
            })
            .await
        };
        let s = setup(&base, &key, InstallKind::AppImage);
        let status = s.service.check(true, NOW).await.unwrap();
        assert_eq!(status.offer.unwrap().version, "9.9.9");
        let err = s.service.download(&mut |_, _| {}).await.unwrap_err();
        assert!(
            matches!(err, crate::Error::Update(UpdateError::BadSignature)),
            "{err:?}"
        );
        assert!(s.downloads().is_empty());
        assert_eq!(std::fs::read_to_string(&s.target).unwrap(), "version 1.0.0");
        assert!(s.service.apply().is_err());
    }

    /// C1: the same replay at the old release's own address is refused at the check.
    #[tokio::test]
    async fn a_manifest_pointing_at_another_release_or_repo_is_refused() {
        let key = TestKey::generate(*b"testkey1");
        for path in [
            "/Rifqio/contura/releases/download/v1.0.0/Contura_1.0.0_amd64.AppImage",
            "/someone/contura/releases/download/v9.9.9/Contura_9.9.9_amd64.AppImage",
            "/Rifqio/contura/releases/download/v9.9.9/Contura_9.9.9_x64_portable.exe",
        ] {
            let (base, _server) = serve(|b| {
                let app = Entry {
                    url: format!("{b}{path}"),
                    sig: "c2ln".into(),
                    sha: sha256_hex(b"x"),
                };
                vec![ok(&release("9.9.9", &placeholder(b, "9.9.9", WIN), &app))]
            })
            .await;
            let s = setup(&base, &key, InstallKind::AppImage);
            let status = s.service.check(true, NOW).await.unwrap();
            assert_eq!(status.offer, None, "{path}");
            assert_eq!(
                status.last_result,
                Some(CheckResult::Failed {
                    message: UpdateError::NotThisRelease.to_string()
                }),
                "{path}"
            );
        }
    }

    /// C1: the signed AppImage put in the Windows entry (at the exe's address) is refused.
    #[tokio::test]
    async fn the_appimage_in_the_windows_entry_is_refused() {
        let key = TestKey::generate(*b"testkey1");
        let image = b"\x7fELF appimage 1.0.1".to_vec();
        let (base, _server) = {
            let image = image.clone();
            let key = &key;
            serve(move |b| {
                let app = signed(b, key, "1.0.1", APP, &image);
                let swapped = Entry {
                    url: file_url(b, "1.0.1", WIN),
                    sig: app.sig.clone(),
                    sha: app.sha.clone(),
                };
                vec![ok(&release("1.0.1", &swapped, &app)), ok(&image)]
            })
            .await
        };
        let s = setup(&base, &key, InstallKind::Portable);
        s.service.check(true, NOW).await.unwrap();
        let err = s.service.download(&mut |_, _| {}).await.unwrap_err();
        assert!(
            matches!(err, crate::Error::Update(UpdateError::BadSignature)),
            "{err:?}"
        );
        assert!(s.downloads().is_empty());
        assert_eq!(std::fs::read_to_string(&s.target).unwrap(), "version 1.0.0");
    }

    #[tokio::test]
    async fn a_download_that_fails_its_signature_is_deleted_and_nothing_changes() {
        let key = TestKey::generate(*b"testkey1");
        let program = b"version 1.0.1".to_vec();
        let (base, _server) = {
            let program = program.clone();
            let key = &key;
            serve(move |b| {
                let mut win = signed(b, key, "1.0.1", WIN, b"something else");
                win.sha = sha256_hex(&program);
                vec![
                    ok(&release("1.0.1", &win, &placeholder(b, "1.0.1", APP))),
                    ok(&program),
                ]
            })
            .await
        };
        let s = setup(&base, &key, InstallKind::Portable);
        s.service.check(true, NOW).await.unwrap();
        let err = s.service.download(&mut |_, _| {}).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "The download did not match its signature, so nothing was changed."
        );
        assert!(s.downloads().is_empty());
        assert_eq!(std::fs::read_to_string(&s.target).unwrap(), "version 1.0.0");
        assert!(!s.service.status().unwrap().ready);
        assert!(s.service.apply().is_err());
        assert_eq!(std::fs::read_to_string(&s.target).unwrap(), "version 1.0.0");
    }

    /// M1: a verified file changed while it waited is checked again at the swap.
    #[tokio::test]
    async fn a_download_changed_while_it_waits_is_refused_at_the_swap() {
        let key = TestKey::generate(*b"testkey1");
        let program = b"version 1.0.1".to_vec();
        let (base, _server) = {
            let program = program.clone();
            let key = &key;
            serve(move |b| {
                let app = signed(b, key, "1.0.1", APP, &program);
                vec![
                    ok(&release("1.0.1", &placeholder(b, "1.0.1", WIN), &app)),
                    ok(&program),
                ]
            })
            .await
        };
        let s = setup(&base, &key, InstallKind::AppImage);
        s.service.check(true, NOW).await.unwrap();
        s.service.download(&mut |_, _| {}).await.unwrap();
        let waiting = s.downloads();
        assert_eq!(waiting.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&waiting[0]).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        std::fs::write(&waiting[0], "something unsigned").unwrap();
        let err = s.service.apply().unwrap_err();
        assert!(
            matches!(err, crate::Error::Update(UpdateError::BadSignature)),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&s.target).unwrap(), "version 1.0.0");
        assert!(s.downloads().is_empty());
        assert!(!s.service.status().unwrap().ready);
    }

    /// M4: the clean-up after start keeps a verified download waiting for its restart.
    #[tokio::test]
    async fn cleanup_keeps_a_download_that_waits_for_its_restart() {
        let key = TestKey::generate(*b"testkey1");
        let program = b"version 1.0.1".to_vec();
        let (base, _server) = {
            let program = program.clone();
            let key = &key;
            serve(move |b| {
                let app = signed(b, key, "1.0.1", APP, &program);
                vec![
                    ok(&release("1.0.1", &placeholder(b, "1.0.1", WIN), &app)),
                    ok(&program),
                ]
            })
            .await
        };
        let s = setup(&base, &key, InstallKind::AppImage);
        // A download left by an earlier run that stopped halfway.
        let (stale, _) = install::create_download(s.app_dir()).unwrap();
        s.service.check(true, NOW).await.unwrap();
        s.service.download(&mut |_, _| {}).await.unwrap();
        assert!(s.service.cleanup());
        assert!(!stale.exists());
        assert_eq!(s.downloads().len(), 1);
        assert!(s.service.status().unwrap().ready);
        s.service.apply().unwrap();
        assert_eq!(std::fs::read(&s.target).unwrap(), program);
    }

    #[tokio::test]
    async fn a_redirect_off_the_allowed_hosts_is_refused() {
        let key = TestKey::generate(*b"testkey1");
        let (base, server) = serve(|b| {
            vec![
                ok(&placeholders(b, "1.0.1")),
                (
                    302,
                    vec![("location".into(), "http://localhost:1/evil".into())],
                    Vec::new(),
                ),
            ]
        })
        .await;
        let s = setup(&base, &key, InstallKind::AppImage);
        s.service.check(true, NOW).await.unwrap();
        let err = s.service.download(&mut |_, _| {}).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Contura only downloads updates from GitHub, not from localhost."
        );
        assert!(s.downloads().is_empty());
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unwritable_folder_is_said_before_any_download() {
        use std::os::unix::fs::PermissionsExt;
        let key = TestKey::generate(*b"testkey1");
        let (base, server) = serve(|b| vec![ok(&placeholders(b, "1.0.1"))]).await;
        let s = setup(&base, &key, InstallKind::AppImage);
        s.service.check(true, NOW).await.unwrap();
        let ro = std::fs::Permissions::from_mode(0o555);
        std::fs::set_permissions(s.app_dir(), ro).unwrap();
        // Root writes anywhere: then there is nothing to check.
        let writable = install::create_download(s.app_dir()).map(|(p, _)| p);
        let result = if let Ok(probe) = writable {
            let _ = std::fs::remove_file(probe);
            None
        } else {
            Some(s.service.download(&mut |_, _| {}).await)
        };
        std::fs::set_permissions(s.app_dir(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let Some(result) = result else { return };
        let err = result.unwrap_err();
        assert!(
            matches!(err, crate::Error::Update(UpdateError::NotWritable { .. })),
            "{err:?}"
        );
        assert!(
            err.to_string()
                .contains("Download the new version from the release page")
        );
        // Only the manifest was fetched.
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_package_install_gets_a_notice_and_no_download() {
        let key = TestKey::generate(*b"testkey1");
        let (base, _server) = serve(|b| vec![ok(&placeholders(b, "1.0.1"))]).await;
        let dir = tempfile::tempdir().unwrap();
        let service = UpdateService::new(store(dir.path()), "1.0.0", InstallKind::Package, None)
            .with_source(
                Fetcher::for_tests(&["127.0.0.1"], LIMITS),
                Url::parse(&format!("{base}/latest.json")).unwrap(),
                &key.public_b64(),
            );
        let status = service.check(true, NOW).await.unwrap();
        assert_eq!(status.install, InstallKind::Package);
        let offer = status.offer.unwrap();
        assert_eq!(
            offer.release_url,
            "https://github.com/Rifqio/contura/releases/tag/v1.0.1"
        );
        assert!(offer.asset.is_none());
        assert!(!status.can_install);
        assert!(matches!(
            service.download(&mut |_, _| {}).await,
            Err(crate::Error::Update(UpdateError::Manual))
        ));
    }

    #[tokio::test]
    async fn an_offer_this_copy_already_has_is_not_shown() {
        let key = TestKey::generate(*b"testkey1");
        let (base, _server) = serve(|b| vec![ok(&placeholders(b, "1.0.1"))]).await;
        let s = setup(&base, &key, InstallKind::AppImage);
        s.service.check(true, NOW).await.unwrap();
        // The same data folder, opened by 1.0.1 after a manual update.
        let newer = UpdateService::new(
            store(s._dir.path()),
            "1.0.1",
            InstallKind::AppImage,
            Some(s.target.clone()),
        );
        assert_eq!(newer.status().unwrap().offer, None);
        // Build metadata on the running version changes nothing.
        let built = UpdateService::new(
            store(s._dir.path()),
            "1.0.1+local",
            InstallKind::AppImage,
            Some(s.target.clone()),
        );
        assert_eq!(built.status().unwrap().offer, None);
        assert_eq!(s.service.status().unwrap().offer.unwrap().version, "1.0.1");
    }

    #[tokio::test]
    async fn the_size_cap_stops_a_download() {
        let body = vec![1u8; 5000];
        let (base, _server) = serve(|_| {
            vec![
                ok(&body),
                (200, vec![("content-length".into(), "0".into())], Vec::new()),
            ]
        })
        .await;
        let fetcher = Fetcher::for_tests(&["127.0.0.1"], LIMITS);
        let url = Url::parse(&format!("{base}/f")).unwrap();
        let mut out = Vec::new();
        let err = fetcher.download(&url, &mut out, 4999, &mut |_, _| {}).await;
        assert_eq!(err, Err(UpdateError::TooLarge));
        assert!(out.is_empty(), "a declared size over the cap reads nothing");
    }

    /// A chunked reply (no declared size) of ten 1,000-byte chunks.
    async fn chunked_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut tmp = [0u8; 4096];
            let _ = sock.read(&mut tmp).await;
            let mut reply =
                b"HTTP/1.1 200 OK\r\nconnection: close\r\ntransfer-encoding: chunked\r\n\r\n"
                    .to_vec();
            for _ in 0..10 {
                reply.extend_from_slice(b"3e8\r\n");
                reply.extend_from_slice(&[2u8; 1000]);
                reply.extend_from_slice(b"\r\n");
            }
            reply.extend_from_slice(b"0\r\n\r\n");
            let _ = sock.write_all(&reply).await;
            let _ = sock.shutdown().await;
        });
        port
    }

    #[tokio::test]
    async fn the_size_cap_counts_bytes_without_a_declared_size() {
        let port = chunked_server().await;
        let fetcher = Fetcher::for_tests(&["127.0.0.1"], LIMITS);
        let url = Url::parse(&format!("http://127.0.0.1:{port}/f")).unwrap();
        let mut out = Vec::new();
        let err = fetcher.download(&url, &mut out, 4500, &mut |_, _| {}).await;
        assert_eq!(err, Err(UpdateError::TooLarge));
        assert!(out.len() <= 4500);
    }

    /// M10: a manifest over its cap is refused, declared or counted.
    #[tokio::test]
    async fn an_oversized_manifest_is_refused() {
        let body = vec![b' '; 5000];
        let (base, _server) = serve(|_| vec![ok(&body)]).await;
        let fetcher = Fetcher::for_tests(&["127.0.0.1"], LIMITS);
        let url = Url::parse(&format!("{base}/latest.json")).unwrap();
        assert_eq!(
            fetcher.fetch_bytes(&url, 4999).await,
            Err(UpdateError::BadManifest)
        );
        let port = chunked_server().await;
        let url = Url::parse(&format!("http://127.0.0.1:{port}/latest.json")).unwrap();
        assert_eq!(
            fetcher.fetch_bytes(&url, 4500).await,
            Err(UpdateError::BadManifest)
        );
    }

    /// A server that reads the request, writes `head` (maybe nothing), then stays silent.
    async fn stalling_server(head: &'static [u8]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut tmp = [0u8; 4096];
            let _ = sock.read(&mut tmp).await;
            let _ = sock.write_all(head).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(sock);
        });
        port
    }

    const SHORT: Limits = Limits {
        connect: Duration::from_secs(5),
        first_byte: Duration::from_millis(300),
        idle: Duration::from_millis(300),
        manifest: Duration::from_secs(10),
        download: Duration::from_secs(10),
    };

    /// M10: a server that never answers, or stops halfway, times out.
    #[tokio::test]
    async fn a_silent_server_times_out() {
        let fetcher = Fetcher::for_tests(&["127.0.0.1"], SHORT);
        let port = stalling_server(b"").await;
        let url = Url::parse(&format!("http://127.0.0.1:{port}/latest.json")).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            fetcher.fetch_bytes(&url, 1000).await,
            Err(UpdateError::Timeout {
                host: "127.0.0.1".into()
            })
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        let port = stalling_server(b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nhalf").await;
        let url = Url::parse(&format!("http://127.0.0.1:{port}/f")).unwrap();
        let mut out = Vec::new();
        assert_eq!(
            fetcher.download(&url, &mut out, 1000, &mut |_, _| {}).await,
            Err(UpdateError::Timeout {
                host: "127.0.0.1".into()
            })
        );
    }

    #[test]
    fn the_host_allowlist() {
        use super::super::http::{GITHUB_HOSTS, check_url};
        let ok = |u: &str| check_url(&Url::parse(u).unwrap(), GITHUB_HOSTS, true);
        assert!(
            ok("https://github.com/Rifqio/contura/releases/latest/download/latest.json").is_ok()
        );
        assert!(ok("https://objects.githubusercontent.com/x").is_ok());
        assert!(ok("https://release-assets.githubusercontent.com/x").is_ok());
        assert!(ok("https://GitHub.com/x").is_ok());
        for bad in [
            "http://github.com/x",
            "https://github.com.evil.example/x",
            "https://evilgithub.com/x",
            "https://api.github.com/x",
            "https://user:pw@github.com/x",
            "ftp://github.com/x",
            "https://127.0.0.1/x",
        ] {
            assert!(
                matches!(ok(bad), Err(UpdateError::HostNotAllowed { .. })),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_manifest_url_is_the_latest_release_on_github() {
        assert_eq!(
            MANIFEST_URL,
            "https://github.com/Rifqio/contura/releases/latest/download/latest.json"
        );
        let u = Url::parse(MANIFEST_URL).unwrap();
        assert!(super::super::http::check_url(&u, super::super::http::GITHUB_HOSTS, true).is_ok());
    }
}
