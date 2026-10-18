//! `job_fingerprint`: SHA-256 of what a job will do, for the Production pass (Task 6).

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::FileIdentity;
use super::types::{ColumnMap, JobKind};
use crate::error::{Error, Result};
use crate::model::ConnectionId;

/// Everything a writing job will do, as the confirm showed it: the target, the options,
/// the column mapping, the INSERT template (the statement head and the per-column literal
/// rule), and for a file its path, size and SHA-256. Built again from the request at
/// confirm and at start; a pass covers only the plan whose fingerprint it was issued for.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobPlan {
    pub kind: JobKind,
    pub connection_id: ConnectionId,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub options: serde_json::Value,
    pub mapping: Vec<ColumnMap>,
    pub template: String,
    pub file: Option<FileIdentity>,
}

/// SHA-256 of the bytes of `serde_json::to_value(plan)`. serde_json maps are sorted
/// (no `preserve_order`), so the JSON is canonical: the same plan always gives the same
/// fingerprint, whatever order the options' keys came in.
///
/// A plan serde cannot write (a file path that is not valid Unicode) is refused with
/// `InvalidInput`, so no pass is ever issued for it: such plans must never share one
/// fingerprint.
pub fn job_fingerprint(plan: &JobPlan) -> Result<[u8; 32]> {
    let bytes = serde_json::to_value(plan)
        .and_then(|v| serde_json::to_vec(&v))
        .map_err(|e| Error::InvalidInput(format!("This job cannot be confirmed: {e}.")))?;
    Ok(Sha256::digest(&bytes).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn plan() -> JobPlan {
        JobPlan {
            kind: JobKind::Import,
            connection_id: uuid::Uuid::from_u128(7),
            database: Some("shop".into()),
            schema: Some("public".into()),
            table: Some("orders".into()),
            options: serde_json::json!({ "delimiter": "comma", "header": true, "commit": { "kind": "once" } }),
            mapping: vec![
                ColumnMap {
                    file_column: 0,
                    into: Some("id".into()),
                    by_hand: false,
                },
                ColumnMap {
                    file_column: 1,
                    into: Some("status".into()),
                    by_hand: false,
                },
            ],
            template: "INSERT INTO \"public\".\"orders\" (\"id\", \"status\") VALUES".into(),
            file: Some(FileIdentity {
                path: PathBuf::from("C:/data/orders.csv"),
                bytes: 1234,
                sha256: "ab".repeat(32),
            }),
        }
    }

    #[test]
    fn same_plan_same_fingerprint() {
        assert_eq!(
            job_fingerprint(&plan()).unwrap(),
            job_fingerprint(&plan()).unwrap()
        );
        let mut reordered = plan();
        reordered.options = serde_json::json!({ "commit": { "kind": "once" }, "header": true, "delimiter": "comma" });
        assert_eq!(
            job_fingerprint(&plan()).unwrap(),
            job_fingerprint(&reordered).unwrap()
        );
    }

    type Change = Box<dyn Fn(&mut JobPlan)>;

    #[test]
    fn any_change_changes_it() {
        let base = job_fingerprint(&plan()).unwrap();
        let changes: Vec<(&str, Change)> = vec![
            (
                "path",
                Box::new(|p| p.file.as_mut().unwrap().path = PathBuf::from("C:/data/other.csv")),
            ),
            ("bytes", Box::new(|p| p.file.as_mut().unwrap().bytes = 1235)),
            (
                "sha256",
                Box::new(|p| p.file.as_mut().unwrap().sha256 = "cd".repeat(32)),
            ),
            ("no file", Box::new(|p| p.file = None)),
            (
                "one mapping entry",
                Box::new(|p| p.mapping[1].into = Some("note".into())),
            ),
            ("mapping by hand", Box::new(|p| p.mapping[0].by_hand = true)),
            (
                "one option",
                Box::new(|p| p.options["header"] = serde_json::json!(false)),
            ),
            (
                "the template",
                Box::new(|p| p.template.push_str(" ON CONFLICT DO NOTHING")),
            ),
            ("the table", Box::new(|p| p.table = Some("orders2".into()))),
            ("the schema", Box::new(|p| p.schema = Some("sales".into()))),
            (
                "the database",
                Box::new(|p| p.database = Some("shop2".into())),
            ),
            (
                "the connection",
                Box::new(|p| p.connection_id = uuid::Uuid::from_u128(8)),
            ),
            ("the kind", Box::new(|p| p.kind = JobKind::ScriptImport)),
        ];
        for (what, change) in changes {
            let mut p = plan();
            change(&mut p);
            assert_ne!(
                job_fingerprint(&p).unwrap(),
                base,
                "{what} did not change it"
            );
        }
    }

    /// A path serde cannot write as text (not valid Unicode) refuses the plan, so two
    /// such plans can never share one fingerprint and one pass.
    #[test]
    fn a_plan_that_cannot_be_written_is_refused() {
        #[cfg(windows)]
        let odd: PathBuf = {
            use std::os::windows::ffi::OsStringExt;
            std::ffi::OsString::from_wide(&[0x43, 0x3a, 0x2f, 0xD800, 0x61]).into()
        };
        #[cfg(unix)]
        let odd: PathBuf = {
            use std::os::unix::ffi::OsStrExt;
            std::ffi::OsStr::from_bytes(b"/tmp/\xff.csv").into()
        };
        let mut p = plan();
        p.file.as_mut().unwrap().path = odd;
        assert!(matches!(
            job_fingerprint(&p),
            Err(crate::error::Error::InvalidInput(_))
        ));
    }
}
