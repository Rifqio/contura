//! Shows a folder, or a file in its folder, in the system's file manager: Explorer on
//! Windows, Finder on macOS, and the desktop's default through `xdg-open` elsewhere.

use std::path::Path;
use std::process::Command;

use contura_core::Error;

/// The command that opens `dir`.
fn open_command(dir: &Path) -> Command {
    let program = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut command = Command::new(program);
    command.arg(dir);
    command
}

/// The command that shows `path` in its folder. Windows and macOS select the file;
/// `select` is Explorer's `/select,"<path>"` argument. Linux file managers share no way to
/// select a file, so the folder that holds it opens.
fn reveal_command(path: &Path, select: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = path;
        let mut command = Command::new("explorer.exe");
        // Explorer reads `/select,"<path>"` itself; Rust's own quoting of the whole
        // argument breaks it for paths with spaces.
        command.raw_arg(select);
        command
    }
    #[cfg(target_os = "macos")]
    {
        let _ = select;
        let mut command = Command::new("open");
        command.arg("-R").arg(path);
        command
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = select;
        let mut command = Command::new("xdg-open");
        command.arg(path.parent().unwrap_or(path));
        command
    }
}

/// Shows the data folder.
pub fn open_folder(dir: &Path) -> Result<(), Error> {
    open_command(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::File(e.to_string()))
}

/// Shows `path` in its folder.
pub fn reveal(path: &Path, select: &str) -> Result<(), Error> {
    reveal_command(path, select)
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::File(format!("cannot open the folder of {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(command: &Command) -> (String, Vec<String>) {
        (
            command.get_program().to_string_lossy().into_owned(),
            command
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
        )
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn linux_opens_with_xdg_open_and_reveals_the_parent() {
        assert_eq!(
            parts(&open_command(Path::new("/opt/contura/data"))),
            ("xdg-open".into(), vec!["/opt/contura/data".into()])
        );
        assert_eq!(
            parts(&reveal_command(
                Path::new("/home/a/out/orders.csv"),
                "ignored"
            )),
            ("xdg-open".into(), vec!["/home/a/out".into()])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_selects_in_finder() {
        assert_eq!(
            parts(&reveal_command(Path::new("/Users/a/orders.csv"), "ignored")),
            (
                "open".into(),
                vec!["-R".into(), "/Users/a/orders.csv".into()]
            )
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_explorer() {
        assert_eq!(
            parts(&open_command(Path::new(r"C:\Contura\data"))).0,
            "explorer.exe"
        );
        assert_eq!(
            parts(&reveal_command(
                Path::new(r"C:\a.csv"),
                r#"/select,"C:\a.csv""#
            ))
            .0,
            "explorer.exe"
        );
    }
}
