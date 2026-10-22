use crate::model::{ConnectionConfig, DialectKind};
use ini::{Ini, ParseOption};
use serde::Serialize;
use std::path::PathBuf;

/// A Connection detected from a local Laragon install but not yet saved.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedConnection {
    pub name: String,
    pub dialect: DialectKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub version: Option<String>,
}

/// The number inside a Laragon `Version=` value: `mysql-8.0.30-winx64` gives `8.0.30`.
pub fn laragon_version(value: &str) -> Option<String> {
    value
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|p| p.trim_matches('.'))
        .find(|p| p.chars().next().is_some_and(|c| c.is_ascii_digit()) && p.contains('.'))
        .map(str::to_owned)
}

/// What a Laragon section suggests: name, Dialect, default port and user.
fn laragon_server(section: &str) -> Option<(&'static str, DialectKind, u16, &'static str)> {
    if section.eq_ignore_ascii_case("mysql") {
        Some(("Laragon MySQL", DialectKind::MySql, 3306, "root"))
    } else if section.eq_ignore_ascii_case("postgresql") {
        Some((
            "Laragon PostgreSQL",
            DialectKind::Postgres,
            5432,
            "postgres",
        ))
    } else {
        None
    }
}

/// Reads `laragon.ini` text. `[mysql]` and `[postgresql]` (any case) each
/// yield a suggestion. A `Port` that is not a valid `u16` skips the section
/// rather than suggesting a wrong port.
pub fn parse_laragon_ini(ini: &str) -> Vec<SuggestedConnection> {
    // Laragon writes Windows paths such as `DocumentRoot=E:\laragon\www\`. Escapes
    // off keeps `\` literal, but rust-ini still reads a line-final `\` as a line
    // continuation, which would swallow the next `[section]` line. Only `Port` is
    // read, so dropping line-final backslashes loses nothing.
    let text: String = ini
        .lines()
        .map(|line| format!("{}\n", line.trim_end().trim_end_matches('\\')))
        .collect();
    let options = ParseOption {
        enabled_escape: false,
        ..Default::default()
    };
    let Ok(ini) = Ini::load_from_str_opt(&text, options) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (section, props) in ini.iter() {
        let Some((name, dialect, default_port, user)) = section.and_then(laragon_server) else {
            continue;
        };
        let port = match props.iter().find(|(k, _)| k.eq_ignore_ascii_case("port")) {
            Some((_, v)) => match v.trim().parse::<u16>() {
                Ok(p) => p,
                Err(_) => continue,
            },
            None => default_port,
        };
        let version = props
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("version"))
            .and_then(|(_, v)| laragon_version(v));
        out.push(SuggestedConnection {
            name: name.into(),
            dialect,
            host: "127.0.0.1".into(),
            port,
            user: user.into(),
            version,
        });
    }
    out
}

fn is_loopback(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    h == "127.0.0.1" || h == "::1" || h.eq_ignore_ascii_case("localhost")
}

fn same_host(a: &str, b: &str) -> bool {
    (is_loopback(a) && is_loopback(b)) || a.trim().eq_ignore_ascii_case(b.trim())
}

/// Drops suggestions already covered by a saved Connection of the same
/// Dialect, port and equivalent host.
pub fn unsaved(
    suggested: Vec<SuggestedConnection>,
    saved: &[ConnectionConfig],
) -> Vec<SuggestedConnection> {
    suggested
        .into_iter()
        .filter(|s| {
            !saved
                .iter()
                .any(|c| c.dialect == s.dialect && c.port == s.port && same_host(&c.host, &s.host))
        })
        .collect()
}

#[cfg(windows)]
pub fn find_laragon_install() -> Option<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    const UNINSTALL_WOW: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    let roots = [
        (HKEY_CURRENT_USER, UNINSTALL),
        (HKEY_LOCAL_MACHINE, UNINSTALL),
        (HKEY_LOCAL_MACHINE, UNINSTALL_WOW),
    ];
    for (hive, path) in roots {
        let Ok(uninstall) = RegKey::predef(hive).open_subkey(path) else {
            continue;
        };
        for name in uninstall.enum_keys().flatten() {
            let Ok(key) = uninstall.open_subkey(&name) else {
                continue;
            };
            let Ok(display): Result<String, _> = key.get_value("DisplayName") else {
                continue;
            };
            if !display.starts_with("Laragon") {
                continue;
            }
            if let Ok(location) = key.get_value::<String, _>("InstallLocation")
                && !location.trim().is_empty()
            {
                return Some(PathBuf::from(location));
            }
        }
    }
    None
}

#[cfg(not(windows))]
pub fn find_laragon_install() -> Option<PathBuf> {
    None
}

/// Suggestions from the local Laragon install that are not yet saved.
/// Returns empty on any failure.
pub fn laragon_suggestions(saved: &[ConnectionConfig]) -> Vec<SuggestedConnection> {
    let Some(install) = find_laragon_install() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(install.join("usr").join("laragon.ini")) else {
        return Vec::new();
    };
    unsaved(parse_laragon_ini(&text), saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ConnectionConfig, DialectKind, SslMode};

    fn saved(host: &str, port: u16) -> ConnectionConfig {
        ConnectionConfig {
            id: uuid::Uuid::new_v4(),
            name: "x".into(),
            dialect: DialectKind::MySql,
            host: host.into(),
            port,
            user: "root".into(),
            database: None,
            ssl: SslMode::Disable,
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: Default::default(),
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        }
    }

    #[test]
    fn laragon_version_comes_from_the_ini() {
        assert_eq!(
            laragon_version("mysql-8.0.30-winx64"),
            Some("8.0.30".to_string())
        );
        assert_eq!(laragon_version("pgsql"), None);
        let s = parse_laragon_ini(
            "[mysql]
Version=mysql-8.0.30-winx64
[postgresql]
Version=pgsql
",
        );
        assert_eq!(s[0].version.as_deref(), Some("8.0.30"));
        assert_eq!(s[1].version, None);
    }

    #[test]
    fn mysql_port_from_ini() {
        let s = parse_laragon_ini("[mysql]\nVersion=mysql-8.0.30-winx64\nPort=3310\n");
        assert_eq!(s.len(), 1);
        assert_eq!(
            (
                s[0].name.as_str(),
                s[0].host.as_str(),
                s[0].port,
                s[0].user.as_str()
            ),
            ("Laragon MySQL", "127.0.0.1", 3310, "root")
        );
    }
    #[test]
    fn trailing_backslash_does_not_swallow_the_next_section() {
        let s = parse_laragon_ini(
            "[apache]\nDocumentRoot=E:\\Software\\laragon\\www\\\n[mysql]\nPort=3307\n",
        );
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].port, 3307);
    }
    #[test]
    fn postgresql_section_yields_suggestion() {
        let s = parse_laragon_ini("[postgresql]\nUse=-1\nVersion=pgsql\n");
        assert_eq!(
            s,
            vec![SuggestedConnection {
                name: "Laragon PostgreSQL".into(),
                dialect: DialectKind::Postgres,
                host: "127.0.0.1".into(),
                port: 5432,
                user: "postgres".into(),
                version: None,
            }]
        );
    }
    #[test]
    fn postgresql_port_is_read() {
        let s = parse_laragon_ini("[PostgreSQL]\nPort=5433\n");
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].dialect, s[0].port), (DialectKind::Postgres, 5433));
        assert!(parse_laragon_ini("[postgresql]\nPort=99999\n").is_empty());
    }
    #[test]
    fn mysql_and_postgresql_both_suggested() {
        let s = parse_laragon_ini(
            "[mysql]\nVersion=mysql-8.0.30-winx64\n[postgresql]\nUse=-1\nVersion=pgsql\n",
        );
        let found: Vec<(DialectKind, u16, &str)> = s
            .iter()
            .map(|x| (x.dialect, x.port, x.user.as_str()))
            .collect();
        assert_eq!(
            found,
            vec![
                (DialectKind::MySql, 3306, "root"),
                (DialectKind::Postgres, 5432, "postgres")
            ]
        );
    }
    #[test]
    fn unsaved_keeps_postgres_when_only_mysql_saved_on_that_host() {
        let s = parse_laragon_ini("[mysql]\nPort=5432\n[postgresql]\nPort=5432\n");
        let left = unsaved(s, &[saved("localhost", 5432)]);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].dialect, DialectKind::Postgres);
    }
    #[test]
    fn mysql_default_port_when_missing() {
        assert_eq!(parse_laragon_ini("[MySQL]\nVersion=x\n")[0].port, 3306);
    }
    #[test]
    fn invalid_port_skips_section() {
        assert!(parse_laragon_ini("[mysql]\nPort=abc\n").is_empty());
    }
    #[test]
    fn no_mysql_section_no_suggestion() {
        assert!(parse_laragon_ini("[php]\nVersion=8\n").is_empty());
    }
    #[test]
    #[ignore]
    fn laragon_detected_on_this_pc() {
        let found = find_laragon_install().expect("laragon not found");
        let norm = |p: &std::path::Path| {
            p.to_string_lossy()
                .trim_end_matches('\\')
                .to_ascii_lowercase()
        };
        assert_eq!(
            norm(&found),
            norm(std::path::Path::new(r"E:\Software\laragon\"))
        );
    }
    #[test]
    fn unsaved_treats_localhost_as_loopback() {
        let s = parse_laragon_ini("[mysql]\nPort=3310\n");
        assert!(unsaved(s.clone(), &[saved("localhost", 3310)]).is_empty());
        assert!(unsaved(s.clone(), &[saved("::1", 3310)]).is_empty());
        assert_eq!(unsaved(s.clone(), &[saved("localhost", 3306)]).len(), 1);
        assert_eq!(unsaved(s, &[saved("db.example.com", 3310)]).len(), 1);
    }
}
