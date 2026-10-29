//! An opt-in frame log for the release WebView's performance gates. It is on only when `CONTURA_PERF_LOG` names
//! an absolute file when the app starts; the webview never supplies a path.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

/// The longest line kept, in bytes; a longer one is cut.
const MAX_LINE: usize = 64 * 1024;
/// The file's size limit, in bytes; a line that would pass it is dropped.
const MAX_FILE: u64 = 10 * 1024 * 1024;

pub struct PerfLog {
    path: Option<PathBuf>,
}

impl PerfLog {
    fn from_env() -> Self {
        let path = std::env::var_os("CONTURA_PERF_LOG")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute());
        Self { path }
    }

    pub fn enabled(&self) -> bool {
        self.path.is_some()
    }

    /// Appends `line` and a newline. Nothing when off, and nothing once the file is full.
    pub fn append(&self, line: &str) {
        let Some(path) = &self.path else { return };
        let mut end = line.len().min(MAX_LINE);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        let one = line[..end].replace(['\n', '\r'], " ");
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
            return;
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(MAX_FILE);
        if len + one.len() as u64 + 1 > MAX_FILE {
            return;
        }
        let _ = writeln!(file, "{one}");
    }
}

/// The environment, read once.
fn log() -> &'static PerfLog {
    static LOG: OnceLock<PerfLog> = OnceLock::new();
    LOG.get_or_init(PerfLog::from_env)
}

#[tauri::command]
pub fn perf_log_enabled() -> bool {
    log().enabled()
}

#[tauri::command]
pub fn perf_log_append(line: String) {
    log().append(&line);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("contura-perf-{}-{name}", std::process::id()))
    }

    #[test]
    fn perf_log_unset_does_nothing() {
        let off = PerfLog { path: None };
        assert!(!off.enabled());
        off.append("x"); // no file, no panic
    }

    #[test]
    fn perf_log_appends_lines_and_caps_a_long_one() {
        let p = tmp("lines");
        let _ = std::fs::remove_file(&p);
        let on = PerfLog {
            path: Some(p.clone()),
        };
        assert!(on.enabled());
        on.append("one\ntwo");
        on.append(&"é".repeat(MAX_LINE)); // 2 bytes each: cut on a char boundary
        let text = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "one two");
        assert_eq!(lines.len(), 2);
        assert!(lines[1].len() <= MAX_LINE);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn perf_log_stops_at_the_file_cap() {
        let p = tmp("cap");
        let _ = std::fs::remove_file(&p);
        std::fs::File::create(&p)
            .unwrap()
            .set_len(MAX_FILE - 10)
            .unwrap();
        let on = PerfLog {
            path: Some(p.clone()),
        };
        on.append("short"); // fits
        assert_eq!(std::fs::metadata(&p).unwrap().len(), MAX_FILE - 4);
        on.append("this line does not fit"); // dropped
        assert_eq!(std::fs::metadata(&p).unwrap().len(), MAX_FILE - 4);
        let _ = std::fs::remove_file(&p);
    }
}
