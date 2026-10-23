# One-click updates download signed release files named in a manifest on GitHub, off until the user turns them on

Contura 1.0 updates itself in one click on Windows (the portable exe) and in the Linux AppImage; the .deb gets a notice that links to the release. The README promises no telemetry, so the check is opt-in and sends nothing but two GETs.

**Off until turned on.** On the first start, step 4 of the first start guide ("Stay up to date") asks, with its switch off and a line on how this install updates (portable exe, AppImage, or the .deb notice). Ending the guide saves the answer (`settings` row `updates`); Skip or Esc leaves it unanswered, which is off. Until it is answered on, no automatic check runs. (Before 1.0 a quiet banner with Turn on and Not now asked instead; the guide replaced it.) Settings > Updates has the switch, Check now (which runs with the switch off: the user asked), the version, and the last check's time and result.

**What is sent.** A GET of `https://github.com/Rifqio/contura/releases/latest/download/latest.json` at most once a day (the Core decides; the UI only asks hourly whether it is due), and, on Update and restart, a GET of the one release file. The requests carry `User-Agent: Contura` and nothing else: no cookie, token, version or id. GitHub never serves a draft or a pre-release as latest.

**The manifest and the checks.** The release workflow signs the portable exe and the AppImage with the Tauri signer (minisign; the private key and its password are CI secrets), and writes `latest.json` with each file's URL, signature and SHA-256 (`scripts/update-manifest.mjs`). The public key is built into the app (`update/verify.rs`). `latest.json` itself is not signed, so nothing in it is trusted on its own:

- **The file is bound to its release by its signature.** The signer writes the file's base name into the signature's trusted comment (`timestamp:<t>\tfile:Contura_1.0.1_x64_portable.exe`), which the global signature covers. Every release file name carries its version and platform (`Contura_<version>_x64_portable.exe`, `Contura_<version>_amd64.AppImage`, as `release.yml` names them). The app requires `file:` to equal the exact name for this platform at the offered version. A signed 1.0.0 file offered as 9.9.9 (a rollback), or the AppImage offered in the Windows entry, fails the signature check.
- **The address is pinned.** The file URL in the manifest must be exactly `https://github.com/Rifqio/contura/releases/download/v<version>/<that name>`. Another repository, tag or name refuses the whole manifest. Redirect hops only need the host allowlist.
- **The bytes.** A file must pass the signature (verified with `minisign-verify` in a stream, prehashed signatures only, the kind the Tauri signer makes) and the SHA-256. A file that fails is deleted and never run, and the user reads "The download did not match its signature, so nothing was changed."

**Signing in CI.** Only a pushed `v*` tag is signed; a manual dry run never reaches the key. The signing job installs only the Tauri CLI (the version in `package-lock.json`, in a folder of its own, `--ignore-scripts`), so no project dependency's code runs near the key. A tag pushed without the signing secret fails the job, and no release is made: a release without `latest.json` would make every copy's check fail. Moving the two secrets into a protected GitHub Environment (limited to `v*` tags, with a reviewer) is a follow-up for the repository owner.

**Version rule.** semver with build metadata dropped (it never makes a version newer); an equal or lower version is never offered, nor a pre-release.

**HTTP.** `update/http.rs` is the second file allowed to name `reqwest` (`tests/ai_egress.rs`), with the AI client's TLS (rustls, ring, the OS certificate store). https only; hosts `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com` (GitHub now redirects release downloads to the last one); redirects are followed by hand, each hop checked; 300 MB cap, checked on the declared size and on the bytes counted; time limits for connect, first byte, each chunk and the whole; the body streams to a file beside the program, never into memory.

**The swap.** A running exe cannot be overwritten on Windows but can be renamed (Linux allows both):

1. Download to a fresh file beside the program, `contura.update-<random>.part`, created exclusively (never an existing file or a planted symlink) with mode 0600.
2. Sync it, and verify the bytes of that same open handle. Then make it executable (0755).
3. Just before the swap, verify the waiting file once more.
4. Rename the program to `contura.old.exe` (`contura.old.AppImage`). Rename the download to the program's own name, retrying a few times while a virus scanner holds the new exe. Sync the folder.
5. Start the new program with the same arguments and exit.

The `data` folder is never touched. A folder Contura cannot write to is found before the download, and the user is sent to the release page. If the download cannot take the name, the program is put back. If even that fails, the message says the current version is kept as `contura.old.exe` and to rename it back.

**Which AppImage.** `$APPIMAGE` is used only when `APPDIR` holds the running executable, and the resolved file is a regular file named `*.AppImage` that starts with the type 2 AppImage mark (ELF, `AI` 2 at byte 8). Otherwise the install gets the release-page notice.

**Single instance and one process per data folder.** The single-instance plugin is always on. Before it starts the new program, the old process releases its single-instance lock (`tauri_plugin_single_instance::destroy`), so the plugin never hands the new start back to the process that is exiting. The new process gets `CONTURA_RELAUNCH_FROM=<old pid>` and waits up to 20s for that process to exit. Separately, every start takes an exclusive lock on `contura.lock` in the data folder before it opens anything there. The old process holds that lock until it exits; a start made by an update waits up to 20s for it, and any other start waits 3s. If the lock is still held after that, the start stops with "Another Contura is using the data folder ..., or is still closing. Close it, or wait a moment, then start Contura again." So two processes never share one data folder, even when the old process is slow to exit or the relaunch fails after the release. A file system without locks (some network shares) skips that lock. The swap and its second verification run off the main thread.

**Rollback.** The old file stays until the new version's window has been up for 10s; then it and any unfinished download are removed (never a verified download waiting for its restart). If the new version fails before that, `contura.old.exe` is still there to start by hand (rename it back). No watchdog: a crash after the window is up is a normal bug, fixed by the next release.

**Unsaved work.** Before the restart the UI lists what would be lost (Pending Edits, unapplied designs, unsaved Saved Queries and Visual Queries, a Data Transfer set up but not run, diagrams still saving, running jobs) under "Save or discard your changes before Contura restarts", and Save or discard runs the same asks as closing those tabs. Query tab drafts are written before the restart.

**New crates.** `minisign-verify` (pure Rust, no dependencies, no C) for the signature; `semver` (already in the tree through Tauri) for versions; `ring` as a dev-dependency (already in the tree through rustls) to make throwaway keys in the tests.

## Considered and rejected

- **tauri-plugin-updater.** It expects an installer or a bundle it knows (NSIS, MSI, AppImage) and its own flow; Contura's Windows build is a bare portable exe, and the plugin brings its own HTTP stack. The manifest keeps the plugin's shape, so moving to it later stays possible.
- **On by default.** It would break the README's promise; the guide's switch costs one click.
- **The GitHub API (`api.github.com`).** It rate limits by IP and its answer is larger; the release asset is a static file.
- **A watchdog that rolls back a new version that crashes.** More moving parts than the risk is worth for 1.0; the old file is kept until the new one is up.
