//! Source scans: one file talks HTTP, and the provider code never reaches a database.

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
fn only_http_rs_names_reqwest() {
    let mut files = Vec::new();
    rust_files(&src(), &mut files);
    let naming: Vec<String> = files
        .iter()
        .filter(|p| fs::read_to_string(p).unwrap().contains("reqwest"))
        .map(|p| relative(p))
        .collect();
    assert_eq!(naming, vec!["ai/provider/http.rs".to_string()]);
}

#[test]
fn provider_names_no_database_type() {
    let mut files = Vec::new();
    rust_files(&src().join("ai").join("provider"), &mut files);
    assert!(!files.is_empty());
    for path in &files {
        let text = fs::read_to_string(path).unwrap();
        for name in ["ConnectionService", "SessionHandle", "Dialect"] {
            assert!(!text.contains(name), "{} names {name}", relative(path));
        }
    }
}
