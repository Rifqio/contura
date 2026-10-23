//! The two checks a downloaded file must pass before it is run: its minisign signature
//! against the public key built into Contura, and its SHA-256 against the manifest.
//! The file is read in chunks, never into memory whole.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use minisign_verify::{PublicKey, Signature};
use sha2::{Digest, Sha256};

use super::UpdateError;

/// The release signing key's public half, as `npx tauri signer generate` prints it
/// (base64 of the minisign public key file). The private half is a CI secret.
pub const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZCMDM2Q0VDOUYyQjY2RkIKUldUN1ppdWY3R3dEYS84bjJBNkcveUNpYnZ3dVF3cDdzTXV6ZVNGL1ZGYTU3L2o4UmZXcThGbFEK";

const CHUNK: usize = 64 * 1024;

/// A key or signature as the Tauri signer writes them: base64 of the minisign text.
fn decode_text(b64: &str) -> Option<String> {
    let bytes = STANDARD.decode(b64.trim()).ok()?;
    String::from_utf8(bytes).ok()
}

/// The built-in key, or `key_b64` in tests.
pub fn public_key(key_b64: &str) -> Result<PublicKey, UpdateError> {
    decode_text(key_b64)
        .and_then(|text| PublicKey::decode(&text).ok())
        .ok_or(UpdateError::BadSignature)
}

/// Checks `path` against `signature_b64` (the `.sig` file's text) made by `key`, against
/// `sha256_hex`, and that the signature's signed trusted comment names `expected_file`.
/// Any failure, an unreadable signature included, is `BadSignature`; the caller deletes
/// the file.
pub fn verify_file(
    path: &Path,
    key: &PublicKey,
    signature_b64: &str,
    sha256_hex: &str,
    expected_file: &str,
) -> Result<(), UpdateError> {
    let file = File::open(path).map_err(|_| UpdateError::BadSignature)?;
    verify_reader(file, key, signature_b64, sha256_hex, expected_file)
}

/// [`verify_file`] over bytes read from `reader` (the download's own open handle).
pub fn verify_reader(
    mut reader: impl Read,
    key: &PublicKey,
    signature_b64: &str,
    sha256_hex: &str,
    expected_file: &str,
) -> Result<(), UpdateError> {
    let signature = decode_text(signature_b64)
        .and_then(|text| Signature::decode(&text).ok())
        .ok_or(UpdateError::BadSignature)?;
    // Legacy (not prehashed) signatures cannot be checked in a stream, and the Tauri
    // signer never makes them: they are refused here.
    let mut stream = key
        .verify_stream(&signature)
        .map_err(|_| UpdateError::BadSignature)?;
    let mut sha = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|_| UpdateError::BadSignature)?;
        if n == 0 {
            break;
        }
        stream.update(&buf[..n]);
        sha.update(&buf[..n]);
    }
    let digest = sha.finalize();
    let expected = sha256_hex.trim().to_ascii_lowercase();
    if hex(&digest) != expected {
        return Err(UpdateError::BadSignature);
    }
    // The global signature covers the trusted comment: once this passes, its fields are
    // the signer's.
    stream.finalize().map_err(|_| UpdateError::BadSignature)?;
    if signed_file_name(signature.trusted_comment()) != Some(expected_file) {
        return Err(UpdateError::BadSignature);
    }
    Ok(())
}

/// The `file:` field of a trusted comment such as `timestamp:1792721938\tfile:x.exe`.
pub fn signed_file_name(trusted_comment: &str) -> Option<&str> {
    trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("file:"))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The SHA-256 of `bytes` in hex, for tests and the manifest.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::super::test_sign::TestKey;
    use super::*;

    const NAME: &str = "Contura_1.0.1_x64_portable.exe";

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn the_built_in_key_decodes_to_the_release_key() {
        let text = decode_text(PUBLIC_KEY).unwrap();
        assert!(text.starts_with("untrusted comment: minisign public key: 6B036CEC9F2B66FB\n"));
        public_key(PUBLIC_KEY).unwrap();
    }

    #[test]
    fn a_good_signature_and_checksum_pass() {
        let dir = tempfile::tempdir().unwrap();
        let data = vec![7u8; 200_000];
        let path = write(dir.path(), "contura.update.exe", &data);
        let key = TestKey::generate(*b"\x01\x02\x03\x04\x05\x06\x07\x08");
        let sig = key.sign_as(&data, NAME);
        verify_file(&path, &key.public(), &sig, &sha256_hex(&data), NAME).unwrap();
        // The checksum may come in capitals.
        verify_file(
            &path,
            &key.public(),
            &sig,
            &sha256_hex(&data).to_uppercase(),
            NAME,
        )
        .unwrap();
        // The same handle's bytes.
        verify_reader(
            std::fs::File::open(&path).unwrap(),
            &key.public(),
            &sig,
            &sha256_hex(&data),
            NAME,
        )
        .unwrap();
    }

    #[test]
    fn a_tampered_file_fails() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"the real program".to_vec();
        let key = TestKey::generate(*b"abcdefgh");
        let sig = key.sign_as(&data, NAME);
        let mut bad = data.clone();
        bad[0] ^= 1;
        let path = write(dir.path(), "f", &bad);
        // Even with a checksum that matches the tampered bytes, the signature does not.
        assert_eq!(
            verify_file(&path, &key.public(), &sig, &sha256_hex(&bad), NAME),
            Err(UpdateError::BadSignature)
        );
    }

    #[test]
    fn a_bad_signature_fails() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"program".to_vec();
        let path = write(dir.path(), "f", &data);
        let key = TestKey::generate(*b"abcdefgh");
        let sig = key.sign_as(b"another program", NAME);
        assert_eq!(
            verify_file(&path, &key.public(), &sig, &sha256_hex(&data), NAME),
            Err(UpdateError::BadSignature)
        );
        for junk in ["", "not base64!", "aGVsbG8="] {
            assert_eq!(
                verify_file(&path, &key.public(), junk, &sha256_hex(&data), NAME),
                Err(UpdateError::BadSignature)
            );
        }
    }

    #[test]
    fn a_signature_by_another_key_fails() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"program".to_vec();
        let path = write(dir.path(), "f", &data);
        let ours = TestKey::generate(*b"abcdefgh");
        // Another key id.
        let theirs = TestKey::generate(*b"zzzzzzzz");
        let sig = theirs.sign_as(&data, NAME);
        assert_eq!(
            verify_file(&path, &ours.public(), &sig, &sha256_hex(&data), NAME),
            Err(UpdateError::BadSignature)
        );
        // The same key id on another key.
        let twin = TestKey::generate(*b"abcdefgh");
        let sig = twin.sign_as(&data, NAME);
        assert_eq!(
            verify_file(&path, &ours.public(), &sig, &sha256_hex(&data), NAME),
            Err(UpdateError::BadSignature)
        );
        // And the release key never accepts a test signature.
        assert_eq!(
            verify_file(
                &path,
                &public_key(PUBLIC_KEY).unwrap(),
                &ours.sign_as(&data, NAME),
                &sha256_hex(&data),
                NAME
            ),
            Err(UpdateError::BadSignature)
        );
    }

    #[test]
    fn a_checksum_mismatch_fails() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"program".to_vec();
        let path = write(dir.path(), "f", &data);
        let key = TestKey::generate(*b"abcdefgh");
        let sig = key.sign_as(&data, NAME);
        assert_eq!(
            verify_file(&path, &key.public(), &sig, &sha256_hex(b"other"), NAME),
            Err(UpdateError::BadSignature)
        );
    }

    #[test]
    fn a_legacy_signature_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"program".to_vec();
        let path = write(dir.path(), "f", &data);
        let key = TestKey::generate(*b"abcdefgh");
        assert_eq!(
            verify_file(
                &path,
                &key.public(),
                &key.sign_legacy(&data),
                &sha256_hex(&data),
                NAME
            ),
            Err(UpdateError::BadSignature)
        );
    }

    /// Made once with `npx tauri signer generate` (a throwaway key, since deleted) and
    /// `npx tauri signer sign` over the 6 bytes "hello\n": the format CI produces.
    #[test]
    fn a_tauri_signer_signature_verifies() {
        const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDBGMUY0RjM2OUIxRjQ4QkIKUldTN1NCK2JOazhmRDRlTDFKNW5nL3B6Z3RaeHZNdVIzOU15cWhZcEV5SlVNcS9pUVhTM2ZZZ0kK";
        const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTN1NCK2JOazhmRDI0bWxTNmE2MGRmcVl1cFR0RENWcVoxcmJmaEVnbWxVRGllekdESDlKbTUyaTNUOUVTZTkwdnFLWVpaZzQxc0QraEUvT2pidDBUOGtHR0ZQc2RZWVFzPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzIxOTM4CWZpbGU6ZGF0YS5iaW4KNGxnSS9KVTA0eWNqWU5QYU9aZFo4Z1RFaFcrdDdQVit0VHJTY0FOcDAwNkJpRGJBckVZTmNGVGtnYXZKRG0rYmVESXVtbUpKOW93Vmg2VzFBZEl2Q1E9PQo=";
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "data.bin", b"hello\n");
        let key = public_key(KEY).unwrap();
        verify_file(&path, &key, SIG, &sha256_hex(b"hello\n"), "data.bin").unwrap();
        // The signer wrote the base name of the path it signed, not the path.
        assert_eq!(
            verify_file(&path, &key, SIG, &sha256_hex(b"hello\n"), "other.bin"),
            Err(UpdateError::BadSignature)
        );
        let path = write(dir.path(), "data.bin", b"hello!\n");
        assert_eq!(
            verify_file(&path, &key, SIG, &sha256_hex(b"hello!\n"), "data.bin"),
            Err(UpdateError::BadSignature)
        );
    }

    /// C1: a real signed file of another release or platform is refused by its signed name.
    #[test]
    fn a_signature_for_another_file_name_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"the 1.0.0 program".to_vec();
        let path = write(dir.path(), "f", &data);
        let key = TestKey::generate(*b"abcdefgh");
        let sha = sha256_hex(&data);
        let old = key.sign_as(&data, "Contura_1.0.0_x64_portable.exe");
        verify_file(
            &path,
            &key.public(),
            &old,
            &sha,
            "Contura_1.0.0_x64_portable.exe",
        )
        .unwrap();
        for wanted in [
            "Contura_9.9.9_x64_portable.exe",
            "Contura_1.0.0_amd64.AppImage",
            "contura_1.0.0_x64_portable.exe",
            "",
        ] {
            assert_eq!(
                verify_file(&path, &key.public(), &old, &sha, wanted),
                Err(UpdateError::BadSignature),
                "{wanted}"
            );
        }
    }

    #[test]
    fn the_file_field_is_read_from_the_trusted_comment() {
        assert_eq!(
            signed_file_name("timestamp:1792721938\tfile:Contura_1.0.1_amd64.AppImage"),
            Some("Contura_1.0.1_amd64.AppImage")
        );
        assert_eq!(signed_file_name("file:a.exe\ttimestamp:1"), Some("a.exe"));
        assert_eq!(signed_file_name("timestamp:1"), None);
        assert_eq!(signed_file_name("timestamp:1 file:a.exe"), None);
    }
}
