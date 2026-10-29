//! One text file the user attaches to the next diagram Ask. The Core
//! opens the dialog itself, so the webview never names a path; the file is read only through
//! `check_user_path` and `read_user_text`, and only when its extension is a text kind and no
//! folder on its path is hidden (so `~/.ssh` and its like are never read). The text waits in a
//! slot of one entry until the next Ask takes it.

use std::path::{Component, Path};

use crate::ai::AiError;
use crate::error::{Error, Result};
use crate::jobs::paths::{PathUse, check_user_path, read_user_text};

/// The largest file that can be attached.
pub const ATTACH_MAX_BYTES: u64 = 64 * 1024;
/// The extensions a file may have, compared ignoring case.
pub const ATTACH_EXTENSIONS: [&str; 9] = [
    "md", "txt", "flow", "mmd", "sql", "dbml", "json", "yaml", "yml",
];

pub(crate) const EXTENSION_REFUSAL: &str =
    "Attach a text file: .md, .txt, .flow, .mmd, .sql, .dbml, .json, .yaml or .yml.";
pub(crate) const HIDDEN_REFUSAL: &str = "Files in hidden folders cannot be attached.";
pub(crate) const BINARY_REFUSAL: &str = "This file is not text.";
pub(crate) const NOT_A_FILE: &str = "Attach a text file, not a folder or a device.";

/// An attached file: its name (no folder) and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub name: String,
    pub text: String,
}

fn allowed_extension(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        ATTACH_EXTENSIONS
            .iter()
            .any(|ok| ok.eq_ignore_ascii_case(e))
    })
}

fn hidden(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(s) => s.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

/// Reads a file the user chose in the Core's dialog. Refused, in this order: anything that is
/// not a regular file (a folder, or a pipe that would block any open), a path in
/// Contura's data folder (or a link into it, `check_user_path`), an extension not in
/// `ATTACH_EXTENSIONS`, a hidden folder or file on the path (as given or as its links
/// resolve), then anything `read_user_text` refuses (over 64 KB, not UTF-8) and text holding a
/// NUL byte. The file read is the resolved target that was checked, so a link changed after
/// the checks is not followed again. Errors name the file, never its folder.
pub fn read_attachment(path: &Path, data_dir: &Path) -> Result<Attachment> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cannot = || Error::File(format!("Cannot read {name}."));
    // First, before anything opens it: `check_user_path` opens the path to compare file
    // identities, and opening a pipe blocks until something writes to it.
    if !std::fs::metadata(path).map_err(|_| cannot())?.is_file() {
        return Err(Error::InvalidInput(NOT_A_FILE.into()));
    }
    check_user_path(path, data_dir, PathUse::Open).map_err(|e| match e {
        Error::File(_) => cannot(),
        other => other,
    })?;
    // A link is judged by what it points at too: a plain name must not reach a key file.
    let real = path.canonicalize().map_err(|_| cannot())?;
    if ![path, real.as_path()].into_iter().all(allowed_extension) {
        return Err(Error::InvalidInput(EXTENSION_REFUSAL.into()));
    }
    if [path, real.as_path()].into_iter().any(hidden) {
        return Err(Error::InvalidInput(HIDDEN_REFUSAL.into()));
    }
    // The checked target again, in case the link changed meanwhile.
    if !std::fs::metadata(&real).map_err(|_| cannot())?.is_file() {
        return Err(Error::InvalidInput(NOT_A_FILE.into()));
    }
    let text = read_user_text(&real, ATTACH_MAX_BYTES).map_err(|e| match e {
        // The size refusal names no path.
        Error::InvalidInput(m) => Error::InvalidInput(m),
        Error::File(m) if m.contains("not UTF-8") => Error::InvalidInput(BINARY_REFUSAL.into()),
        _ => cannot(),
    })?;
    if text.contains('\0') {
        return Err(Error::InvalidInput(BINARY_REFUSAL.into()));
    }
    Ok(Attachment { name, text })
}

/// The attachment a diagram request's token names, cloned from the slot (the preview's look,
/// and the Ask's before it runs). `None` with no token; `AttachmentGone` when the slot no
/// longer holds that token, so a file the user still sees on the chip is never left out
/// without a word. A file kept for a follow-up's reply goes only with that reply (`reply`):
/// a new question cannot name it.
pub fn attachment_for(
    slot: &AttachmentSlot,
    token: Option<&str>,
    reply: bool,
) -> Result<Option<Attachment>> {
    let Some(token) = token else {
        return Ok(None);
    };
    match slot.entry.as_ref() {
        Some(held) if held.token == token && (reply || !held.for_reply) => {
            Ok(Some(held.attachment.clone()))
        }
        _ => Err(Error::Ai(AiError::AttachmentGone)),
    }
}

/// The one attachment the Core holds for the next Ask, by a token the webview carries.
#[derive(Debug, Default)]
pub struct AttachmentSlot {
    entry: Option<Held>,
}

#[derive(Debug)]
struct Held {
    token: String,
    attachment: Attachment,
    /// The Ask that sent it was answered with a follow-up question: it waits for the reply.
    for_reply: bool,
}

impl AttachmentSlot {
    /// Holds `a` in place of whatever was held, and returns its new token.
    pub fn put(&mut self, a: Attachment) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.entry = Some(Held {
            token: token.clone(),
            attachment: a,
            for_reply: false,
        });
        token
    }

    /// The attachment held under `token`, left in the slot.
    pub fn peek(&self, token: &str) -> Option<&Attachment> {
        self.entry
            .as_ref()
            .filter(|h| h.token == token)
            .map(|h| &h.attachment)
    }

    /// The attachment held under `token`, emptying the slot: after an Ask that ended well,
    /// or when the user removes the chip. A newer pick under another token is kept.
    pub fn take(&mut self, token: &str) -> Option<Attachment> {
        self.peek(token)?;
        self.entry.take().map(|h| h.attachment)
    }

    /// The Ask that sent `token` was answered with a follow-up question: the file stays, for
    /// that question's reply only, so the reply sends the same text from
    /// memory and nothing is read from disk again.
    pub fn keep_for_reply(&mut self, token: &str) {
        if let Some(h) = self.entry.as_mut().filter(|h| h.token == token) {
            h.for_reply = true;
        }
    }

    /// The file under `token` was sent already, by the Ask whose follow-up this reply answers.
    pub fn held_for_reply(&self, token: &str) -> bool {
        self.entry
            .as_ref()
            .is_some_and(|h| h.token == token && h.for_reply)
    }

    /// A new question was asked, not a reply: a file kept for a follow-up that was left goes.
    /// A fresh pick stays.
    pub fn end_reply_hold(&mut self) {
        if self.entry.as_ref().is_some_and(|h| h.for_reply) {
            self.entry = None;
        }
    }

    pub fn clear(&mut self) {
        self.entry = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A temp folder whose own name has no leading dot (tempfile's default `.tmp` prefix
    /// would be a hidden segment).
    fn temp() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("att").tempdir().unwrap()
    }

    fn message(e: Error) -> String {
        match e {
            Error::InvalidInput(m) | Error::File(m) => m,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn read_attachment_refuses_the_data_folder() {
        let root = temp();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        let inside = data.join("notes.md");
        fs::write(&inside, "secret").unwrap();
        let err = read_attachment(&inside, &data).unwrap_err();
        assert_eq!(message(err), "Choose a file outside Contura's data folder.");
        // A file beside it reads.
        let outside = root.path().join("notes.MD");
        fs::write(&outside, "# Plan\nShip it\n").unwrap();
        let got = read_attachment(&outside, &data).unwrap();
        assert_eq!(
            got,
            Attachment {
                name: "notes.MD".into(),
                text: "# Plan\nShip it\n".into(),
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_attachment_refuses_a_link_into_the_data_folder() {
        let root = temp();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("app.json"), "{}").unwrap();
        let link = root.path().join("app.json");
        std::os::unix::fs::symlink(data.join("app.json"), &link).unwrap();
        let err = read_attachment(&link, &data).unwrap_err();
        assert_eq!(message(err), "Choose a file outside Contura's data folder.");
    }

    #[test]
    fn read_attachment_refuses_hidden_paths_like_ssh_keys() {
        let root = temp();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        let ssh = root.path().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        let key = ssh.join("id_ed25519");
        fs::write(&key, "-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        let notes = ssh.join("notes.txt");
        fs::write(&notes, "hosts").unwrap();
        assert!(read_attachment(&key, &data).is_err());
        assert_eq!(
            message(read_attachment(&notes, &data).unwrap_err()),
            HIDDEN_REFUSAL
        );
        // A plain-named link to a file in a hidden folder is refused too.
        #[cfg(unix)]
        {
            let link = root.path().join("hosts.txt");
            std::os::unix::fs::symlink(&notes, &link).unwrap();
            assert_eq!(
                message(read_attachment(&link, &data).unwrap_err()),
                HIDDEN_REFUSAL
            );
        }
    }

    #[test]
    fn read_attachment_refuses_large_binary_and_other_extensions() {
        let root = temp();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        let big = root.path().join("big.md");
        fs::write(&big, "a".repeat(ATTACH_MAX_BYTES as usize + 1)).unwrap();
        assert_eq!(
            message(read_attachment(&big, &data).unwrap_err()),
            "This file is larger than 64 KB."
        );
        let exact = root.path().join("exact.md");
        fs::write(&exact, "a".repeat(ATTACH_MAX_BYTES as usize)).unwrap();
        assert!(read_attachment(&exact, &data).is_ok());
        let binary = root.path().join("data.txt");
        fs::write(&binary, [0xff, 0xfe, 0x00, 0x41]).unwrap();
        assert!(read_attachment(&binary, &data).is_err());
        let nul = root.path().join("nul.txt");
        fs::write(&nul, "a\0b").unwrap();
        assert_eq!(
            message(read_attachment(&nul, &data).unwrap_err()),
            BINARY_REFUSAL
        );
        for name in ["photo.png", "run.exe", "noext", "notes.md.exe"] {
            let path = root.path().join(name);
            fs::write(&path, "text").unwrap();
            assert_eq!(
                message(read_attachment(&path, &data).unwrap_err()),
                EXTENSION_REFUSAL,
                "{name}"
            );
        }
        for ext in ATTACH_EXTENSIONS {
            let path = root.path().join(format!("ok.{ext}"));
            fs::write(&path, "text").unwrap();
            assert!(read_attachment(&path, &data).is_ok(), "{ext}");
        }
        // A relative path is refused before anything is read.
        assert!(read_attachment(Path::new("notes.md"), &data).is_err());
    }

    #[test]
    fn the_slot_holds_one_and_is_taken_once() {
        let a = |n: &str| Attachment {
            name: n.into(),
            text: format!("{n} text"),
        };
        let mut slot = AttachmentSlot::default();
        let first = slot.put(a("one.md"));
        assert_eq!(slot.peek(&first).map(|x| x.name.as_str()), Some("one.md"));
        // Peeking keeps it.
        assert!(slot.peek(&first).is_some());
        assert!(slot.peek("nope").is_none());
        // A second attachment replaces the first: one entry only.
        let second = slot.put(a("two.md"));
        assert_ne!(first, second);
        assert!(slot.peek(&first).is_none());
        assert!(slot.take(&first).is_none());
        assert_eq!(slot.take(&second), Some(a("two.md")));
        assert!(slot.take(&second).is_none());
        assert!(slot.peek(&second).is_none());
        let third = slot.put(a("three.md"));
        slot.clear();
        assert!(slot.peek(&third).is_none());
    }

    #[test]
    fn read_attachment_reads_only_a_checked_regular_file() {
        let root = temp();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        // A folder named like a text file is not a file.
        let folder = root.path().join("notes.md");
        fs::create_dir(&folder).unwrap();
        assert_eq!(
            message(read_attachment(&folder, &data).unwrap_err()),
            NOT_A_FILE
        );
        #[cfg(unix)]
        {
            // A pipe would block the read forever: refused before it is opened.
            let pipe = root.path().join("pipe.md");
            let made = std::process::Command::new("mkfifo")
                .arg(&pipe)
                .status()
                .unwrap();
            assert!(made.success());
            assert_eq!(
                message(read_attachment(&pipe, &data).unwrap_err()),
                NOT_A_FILE
            );
            // A text-named link to a file of another kind is refused.
            let exe = root.path().join("tool.exe");
            fs::write(&exe, "MZ").unwrap();
            let link = root.path().join("tool.md");
            std::os::unix::fs::symlink(&exe, &link).unwrap();
            assert_eq!(
                message(read_attachment(&link, &data).unwrap_err()),
                EXTENSION_REFUSAL
            );
            // A link to a text file reads that file, under the link's name.
            let real = root.path().join("real.txt");
            fs::write(&real, "real text").unwrap();
            let named = root.path().join("named.md");
            std::os::unix::fs::symlink(&real, &named).unwrap();
            assert_eq!(
                read_attachment(&named, &data).unwrap(),
                Attachment {
                    name: "named.md".into(),
                    text: "real text".into(),
                }
            );
        }
    }

    #[test]
    fn read_errors_name_the_file_not_its_path() {
        let root = temp();
        let data = root.path().join("data");
        fs::create_dir(&data).unwrap();
        let full = root.path().display().to_string();
        let binary = root.path().join("data.txt");
        fs::write(&binary, [0xff, 0xfe, 0x41]).unwrap();
        let m = message(read_attachment(&binary, &data).unwrap_err());
        assert_eq!(m, BINARY_REFUSAL);
        let missing = root.path().join("gone.md");
        let m = message(read_attachment(&missing, &data).unwrap_err());
        assert_eq!(m, "Cannot read gone.md.");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = root.path().join("locked.md");
            fs::write(&locked, "x").unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
            // Root reads anything; the refusal is only checked where it applies.
            if fs::read(&locked).is_err() {
                let m = message(read_attachment(&locked, &data).unwrap_err());
                assert_eq!(m, "Cannot read locked.md.");
            }
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let big = root.path().join("big.md");
        fs::write(&big, "a".repeat(ATTACH_MAX_BYTES as usize + 1)).unwrap();
        for path in [&binary, &missing, &big] {
            let m = message(read_attachment(path, &data).unwrap_err());
            assert!(!m.contains(&full), "{m}");
        }
    }
}
