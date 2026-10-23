//! Source scans: two files talk HTTP (the AI client and the update check), and neither
//! the provider code nor the update code reaches a database.

use std::fs;
use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn relative(path: &Path) -> String {
    path.strip_prefix(src())
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/")
}

#[test]
fn only_the_two_http_files_name_reqwest() {
    let mut files = Vec::new();
    rust_files(&src(), &mut files);
    let naming: Vec<String> = files
        .iter()
        .filter(|p| fs::read_to_string(p).unwrap().contains("reqwest"))
        .map(|p| relative(p))
        .collect();
    let mut naming = naming;
    naming.sort();
    assert_eq!(
        naming,
        vec![
            "ai/provider/http.rs".to_string(),
            "update/http.rs".to_string()
        ]
    );
}

/// The update check sends a GET to GitHub and nothing else: its code reaches no
/// Connection, no AI and no secret.
#[test]
fn update_names_no_catalog_ai_or_secret() {
    let mut files = Vec::new();
    rust_files(&src().join("update"), &mut files);
    assert!(!files.is_empty());
    for path in &files {
        let text = fs::read_to_string(path).unwrap();
        for name in [
            "ConnectionService",
            "SessionHandle",
            "Dialect",
            "CatalogReader",
            "crate::ai",
            "SecretStore",
            "secrets::",
        ] {
            assert!(!text.contains(name), "{} names {name}", relative(path));
        }
    }
}

#[test]
fn provider_names_no_catalog() {
    let mut files = Vec::new();
    rust_files(&src().join("ai").join("provider"), &mut files);
    assert!(!files.is_empty());
    for path in &files {
        let text = fs::read_to_string(path).unwrap();
        for name in [
            "ConnectionService",
            "SessionHandle",
            "Dialect",
            "CatalogReader",
            "sample_rows",
        ] {
            assert!(!text.contains(name), "{} names {name}", relative(path));
        }
    }
}

#[test]
fn only_execution_builds_a_tool_spec() {
    let mut files = Vec::new();
    rust_files(&src(), &mut files);
    let building: Vec<String> = files
        .iter()
        .map(|p| relative(p))
        .filter(|r| !r.starts_with("ai/provider/"))
        .filter(|r| {
            fs::read_to_string(src().join(r))
                .unwrap()
                .contains("ToolSpec {")
        })
        .collect();
    assert_eq!(building, vec!["ai/rails/execution.rs".to_string()]);
}

#[test]
fn no_aws_lc_in_cargo_lock() {
    let lock = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock");
    let text = fs::read_to_string(lock).unwrap();
    assert!(
        !text.contains("name = \"aws-lc"),
        "aws-lc entered Cargo.lock; AI TLS is rustls with ring"
    );
}
