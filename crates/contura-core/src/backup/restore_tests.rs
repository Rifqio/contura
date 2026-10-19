//! Restore's check pass, classification and plan (Task 4). Pure tests on Backup files in
//! temp folders, plus one live SQLite target for the empty-database rule.

use std::path::{Path, PathBuf};

use super::format::{
    BackupHeader, FORMAT_VERSION, INCOMPLETE, made_by, write_header, write_trailer,
};
use super::restore::*;
use crate::error::Error;
use crate::jobs::formats::xlsx::grouped;
use crate::jobs::script::{
    DdlCounts, created_object, ddl_counts, dml_calls, ends_shapes, insert_table,
};
use crate::jobs::types::JobVerdict;
use crate::model::{ConnectionConfig, DbObject, DialectKind, ObjectKind, SslMode};

use DialectKind::{MySql, Postgres, Sqlite};

fn config(dialect: DialectKind) -> ConnectionConfig {
    ConnectionConfig {
        id: uuid::Uuid::from_u128(7),
        name: "freight-prod".into(),
        dialect,
        host: "127.0.0.1".into(),
        port: 0,
        user: "u".into(),
        database: (dialect != Sqlite).then(|| "freight".to_string()),
        ssl: SslMode::Disable,
        group_id: None,
        file: (dialect == Sqlite).then(|| PathBuf::from("freight.sqlite")),
        query_timeout_secs: None,
        ai_access: Default::default(),
        production: false,
        read_only: false,
    }
}

fn header(dialect: DialectKind, rows: &[(&str, u64)]) -> BackupHeader {
    BackupHeader {
        format: FORMAT_VERSION,
        made_by: made_by(),
        dialect,
        server_version: match dialect {
            MySql => "8.0.30",
            Postgres => "16.4",
            Sqlite => "3.45.1",
        }
        .into(),
        database: "freight".into(),
        schema: (dialect == Postgres).then(|| "public".to_string()),
        taken_at: "2026-10-16T22:00:00Z".into(),
        contents: Vec::new(),
        rows: rows.iter().map(|(t, n)| (t.to_string(), *n)).collect(),
        not_included: Vec::new(),
        definer_removed: false,
        drop_tables: false,
    }
}

fn write_backup(dir: &Path, name: &str, h: &BackupHeader, body: &str) -> PathBuf {
    let mut out = Vec::new();
    write_header(&mut out, h).unwrap();
    out.extend_from_slice(body.as_bytes());
    write_trailer(&mut out, 0, 0).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, out).unwrap();
    p
}

/// A Backup of `dialect` holding `body`, with a header naming no table.
fn backup(dir: &tempfile::TempDir, dialect: DialectKind, body: &str) -> PathBuf {
    write_backup(dir.path(), "b.sql", &header(dialect, &[]), body)
}

fn file_check(cfg: &ConnectionConfig, path: &Path, run_as_is: bool) -> FileCheck {
    inspect_file(cfg, path, run_as_is, &|| false, &mut |_, _| {}).unwrap()
}

fn facts(dialect: DialectKind, database: Option<&str>) -> TargetFacts {
    TargetFacts {
        version: header(dialect, &[]).server_version,
        database: database.map(str::to_string),
        ..TargetFacts::default()
    }
}

fn check(cfg: &ConnectionConfig, path: &Path, run_as_is: bool, t: &TargetFacts) -> RestoreCheck {
    build_check(cfg, path, file_check(cfg, path, run_as_is), t, TODAY)
}

const TODAY: &str = "2026-10-17";

/// The texts of planned statements.
fn texts(v: &[crate::safety::PlannedStatement]) -> Vec<&str> {
    v.iter().map(|s| s.text.as_str()).collect()
}

fn request(
    cfg: &ConnectionConfig,
    path: &Path,
    mode: RestoreMode,
    run_as_is: bool,
) -> RestoreRequest {
    RestoreRequest {
        target: RestoreTarget {
            connection_id: cfg.id,
            database: cfg.database.clone(),
            schema: None,
        },
        path: path.to_path_buf(),
        mode,
        run_as_is,
        local_date: None,
    }
}

fn new_db(name: &str) -> RestoreMode {
    RestoreMode::NewDatabase { name: name.into() }
}

/// The file line where `needle` first appears.
fn line_of(path: &Path, needle: &str) -> u32 {
    let text = std::fs::read_to_string(path).unwrap();
    let at = text.find(needle).unwrap();
    text[..at].matches('\n').count() as u32 + 1
}

fn table(name: &str, rows: Option<u64>) -> DbObject {
    DbObject {
        kind: ObjectKind::Table,
        name: name.into(),
        rows,
        bytes: None,
    }
}

fn object(kind: ObjectKind, name: &str) -> DbObject {
    DbObject {
        kind,
        name: name.into(),
        rows: None,
        bytes: None,
    }
}

const SKIPPED_BODY: &str = "CREATE TABLE `t` (`a` int);\n\
GRANT SELECT ON `t` TO 'u'@'%';\n\
REVOKE SELECT ON `t` FROM 'u'@'%';\n\
CREATE USER 'u'@'%';\n\
DROP ROLE `r`;\n\
SET GLOBAL max_connections = 10;\n\
SET PERSIST max_connections = 10;\n\
INSERT INTO `t` (`a`) VALUES (1);\n";

/// GRANT, REVOKE, USER and ROLE statements, SET GLOBAL and SET PERSIST are skipped and
/// listed with their lines; Run as is keeps them, shown exactly.
#[test]
fn skipped_list_and_run_as_is() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(&dir, MySql, SKIPPED_BODY);
    let cfg = config(MySql);

    let f = file_check(&cfg, &p, false);
    let kinds: Vec<&str> = f.skipped.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "GRANT",
            "REVOKE",
            "CREATE USER",
            "DROP ROLE",
            "SET GLOBAL",
            "SET PERSIST"
        ]
    );
    assert_eq!(f.skipped[0].line, u64::from(line_of(&p, "GRANT SELECT")));
    assert_eq!(f.skipped[5].line, u64::from(line_of(&p, "SET PERSIST")));
    assert!(f.refused.is_empty());
    assert_eq!(f.statements, 8);
    assert_eq!(f.structure_total, 1);
    assert_eq!(f.insert_count, 1);
    let c = build_check(&cfg, &p, f, &facts(MySql, Some("freight")), TODAY);
    assert_eq!(
        c.skipped_note.as_deref(),
        Some(
            "6 statements are skipped (GRANT, REVOKE, CREATE USER, DROP ROLE, SET GLOBAL, \
             SET PERSIST). Tick Run as is to keep them."
        )
    );

    let kept = file_check(&cfg, &p, true);
    assert!(kept.skipped.is_empty());
    assert_eq!(kept.structure_total, 7);
    assert_eq!(kept.structure.iter().filter(|s| s.run_as_is).count(), 6);
    let c = build_check(&cfg, &p, kept, &facts(MySql, Some("freight")), TODAY);
    assert_eq!(c.skipped_note, None);
}

#[test]
fn skipped_note_names_one_kind_as_the_spec() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        Postgres,
        "GRANT SELECT ON \"public\".\"t\" TO u;\nGRANT USAGE ON SCHEMA \"public\" TO u;\n",
    );
    let cfg = config(Postgres);
    let c = check(&cfg, &p, false, &facts(Postgres, Some("freight")));
    assert_eq!(
        c.skipped_note.as_deref(),
        Some("2 GRANT statements are skipped. Tick Run as is to keep them.")
    );
}

/// Every refusal the spec lists, transaction control included, with its line.
#[test]
fn refused_list_as_the_spec() {
    let cases: [(DialectKind, &str, &str); 14] = [
        (Postgres, "DROP DATABASE freight;\n", "DROP DATABASE"),
        (MySql, "DROP SCHEMA `freight`;\n", "DROP DATABASE"),
        (Postgres, "\\connect other\n", "A psql meta-command"),
        (Postgres, "COPY t FROM STDIN;\n1\n\\.\n", "COPY FROM STDIN"),
        (Postgres, "COPY t TO PROGRAM 'cat';\n", "COPY PROGRAM"),
        (
            MySql,
            "LOAD DATA INFILE 'x.csv' INTO TABLE `t`;\n",
            "LOAD DATA",
        ),
        (Sqlite, "ATTACH DATABASE 'x.db' AS x;\n", "ATTACH"),
        (
            MySql,
            "SELECT 1 INTO OUTFILE '/tmp/x';\n",
            "SELECT INTO OUTFILE",
        ),
        (MySql, "SHUTDOWN;\n", "SHUTDOWN"),
        (Postgres, "BEGIN;\n", "BEGIN"),
        (Sqlite, "COMMIT;\n", "COMMIT"),
        (Postgres, "ROLLBACK;\n", "ROLLBACK"),
        (MySql, "START TRANSACTION;\n", "START TRANSACTION"),
        (MySql, "LOCK TABLES `t` WRITE;\n", "LOCK TABLES"),
    ];
    for (dialect, body, what) in cases {
        let dir = tempfile::tempdir().unwrap();
        let p = backup(&dir, dialect, body);
        let f = file_check(&config(dialect), &p, false);
        let first = body.split_whitespace().next().unwrap();
        assert_eq!(
            f.refused,
            [RestoreRefused {
                line: u64::from(line_of(&p, first)),
                kind: what.to_string(),
            }],
            "{body}"
        );
    }
}

/// A refusal reads "Line 2,041: ...", Run as is does not lift it, and it blocks the plan.
#[test]
fn refusals_block_the_plan() {
    let dir = tempfile::tempdir().unwrap();
    let body = format!("{}DROP DATABASE x;\n", "\n".repeat(2_100));
    let p = backup(&dir, Postgres, &body);
    let cfg = config(Postgres);
    let line = line_of(&p, "DROP DATABASE");
    let expected = format!(
        "Line {}: DROP DATABASE is not run by Restore.",
        grouped(u64::from(line))
    );
    assert!(expected.starts_with("Line 2,1"));
    for run_as_is in [false, true] {
        let c = check(&cfg, &p, run_as_is, &facts(Postgres, Some("freight")));
        assert_eq!(c.statements_line, "1 statement read, 1 refused");
        assert_eq!(refusals(&c), std::slice::from_ref(&expected));
        assert!(matches!(
            refusal_error(&c),
            Some(Error::BackupRefused { reason }) if reason == expected
        ));
        let plan = build_plan(&cfg, &request(&cfg, &p, new_db("n"), run_as_is), &c).unwrap();
        assert_eq!(
            plan.verdict,
            JobVerdict::Blocked {
                reasons: vec![expected.clone()]
            }
        );
    }
}

/// A routine's body may hold COMMIT; creating the routine runs none of it.
#[test]
fn a_routine_body_with_commit_is_not_refused() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        MySql,
        "DELIMITER ;;\nCREATE PROCEDURE `p`() BEGIN START TRANSACTION; UPDATE `t` SET `a` = 1; \
         COMMIT; END;;\nDELIMITER ;\n",
    );
    let f = file_check(&config(MySql), &p, false);
    assert!(f.refused.is_empty(), "{:?}", f.refused);
    assert_eq!(f.structure_total, 1);
    assert_eq!(f.objects, [(ObjectKind::Procedure, vec!["p".to_string()])]);
}

const MARKERS_BODY: &str = r#"CREATE TABLE "public"."t" ("a" text);
-- section: rows public.t
INSERT INTO "public"."t" ("a") VALUES ('x'), (NULL), ('y'::text);
INSERT INTO "public"."t" ("a") VALUES ((SELECT "b" FROM "public"."other"));
INSERT INTO "public"."t" ("a") SELECT "b" FROM "public"."other";
INSERT INTO "public"."other" ("b") VALUES ('z');
-- section: rows public.t
DELETE FROM "public"."t";
INSERT INTO "public"."t" ("a") VALUES ('w') /* -- section: rows public.t */;
UPDATE "public"."t" SET "a" = 'v'; -- section: rows public.t
INSERT INTO public.t (a) VALUES ('q');
INSERT INTO "public"."T" ("a") VALUES ('r');
INSERT INTO "public"."h" ("a") VALUES (1);
INSERT INTO "t" ("a") VALUES ('u');
INSERT INTO "public"."t" ("a") VALUES (lower('X'));
"#;

/// Only literal-row INSERTs into a table the file creates or its header names become a
/// shape. A subquery, a function call, INSERT ... SELECT, or another table is shown in
/// full, and a section marker never hides the statement after it.
#[test]
fn markers_never_hide_and_shape_rule() {
    let dir = tempfile::tempdir().unwrap();
    let h = header(Postgres, &[("public.t", 6), ("public.h", 1)]);
    let p = write_backup(dir.path(), "b.sql", &h, MARKERS_BODY);
    let cfg = config(Postgres);
    let f = file_check(&cfg, &p, false);
    assert!(f.refused.is_empty());
    assert!(f.skipped.is_empty());
    assert_eq!(f.statements, 13);

    // The shapes: the 3-row INSERT, 'w' behind a comment, the unquoted 'q' (folded to
    // public.t), and public.h, which the header names. The call to lower() is last,
    // because a write shown in full that calls a function ends shapes (R26).
    assert_eq!((f.insert_count, f.insert_rows), (4, 6));
    let shape = f.insert_shape.clone().unwrap();
    assert_eq!(shape.head, r#"INSERT INTO "public"."t" ("a") VALUES"#);
    assert_eq!(shape.rows_per_statement, 3);
    assert_eq!((shape.statements, shape.rows), (4, 6));

    // Everything else is shown exactly, in file order.
    assert_eq!(f.structure_total, 9);
    let texts: Vec<&str> = f.structure.iter().map(|s| s.text.as_str()).collect();
    let shown = |pred: &dyn Fn(&str) -> bool| texts.iter().copied().any(pred);
    assert!(texts[0].starts_with(r#"CREATE TABLE "public"."t""#));
    assert!(shown(&|t| t.contains(r#"VALUES ((SELECT "b""#)));
    assert!(shown(&|t| t.contains("lower('X')")));
    assert!(shown(&|t| t.contains(r#") SELECT "b" FROM"#)));
    assert!(shown(&|t| t.starts_with(r#"INSERT INTO "public"."other""#)));
    assert!(shown(&|t| t == r#"DELETE FROM "public"."t""#));
    assert!(shown(&|t| t.starts_with("UPDATE")));
    assert!(shown(&|t| t.starts_with(r#"INSERT INTO "public"."T""#)));
    assert!(shown(&|t| t.starts_with(r#"INSERT INTO "t""#)));
    assert!(!shown(&|t| t.contains("('w')") || t.contains("('q')")));
    let delete = f
        .structure
        .iter()
        .find(|s| s.text.starts_with("DELETE"))
        .unwrap();
    assert_eq!(delete.line, line_of(&p, "DELETE FROM"));

    let c = build_check(&cfg, &p, f, &facts(Postgres, Some("freight")), TODAY);
    let plan = build_plan(&cfg, &request(&cfg, &p, RestoreMode::IntoEmpty, false), &c).unwrap();
    assert_eq!(plan.structure.len(), 9);
    assert_eq!(
        plan.count_line,
        "Creates 1 table, then runs 4 INSERT statements (6 rows). All of it writes."
    );
}

/// One statement over 16 MB stops the check with its line (step 7 Q38).
#[test]
fn a_16_mb_statement_stops_with_its_line() {
    let dir = tempfile::tempdir().unwrap();
    let body = format!(
        "CREATE TABLE t (a);\nINSERT INTO t VALUES ('{}');\n",
        "x".repeat(16 * 1024 * 1024 + 1)
    );
    let p = backup(&dir, Sqlite, &body);
    let line = line_of(&p, "INSERT INTO t");
    let err = inspect_file(&config(Sqlite), &p, false, &|| false, &mut |_, _| {}).unwrap_err();
    assert!(
        matches!(&err, Error::File(m) if *m == format!("Line {line}: one statement is larger than 16 MB.")),
        "{err:?}"
    );
}

#[test]
fn another_dialect_and_a_cut_file_are_refused_plain_sql_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(&dir, MySql, "CREATE TABLE `t` (`a` int);\n");
    let err = inspect_file(&config(Postgres), &p, false, &|| false, &mut |_, _| {}).unwrap_err();
    assert!(matches!(
        err,
        Error::BackupRefused { reason }
            if reason == "This Backup is from MySQL. Restore it on a MySQL Connection, or use Data Transfer."
    ));

    let plain = dir.path().join("plain.sql");
    std::fs::write(&plain, "CREATE TABLE t (a int);\n").unwrap();
    let f = file_check(&config(Postgres), &plain, false);
    assert!(f.header.is_none() && f.trailer.is_none());
    assert_eq!(f.structure_total, 1);

    let mut cut = Vec::new();
    write_header(&mut cut, &header(Postgres, &[])).unwrap();
    cut.extend_from_slice(b"CREATE TABLE t (a int);\n");
    let cut_path = dir.path().join("cut.sql");
    std::fs::write(&cut_path, cut).unwrap();
    let err = inspect_file(
        &config(Postgres),
        &cut_path,
        false,
        &|| false,
        &mut |_, _| {},
    )
    .unwrap_err();
    assert!(matches!(err, Error::BackupRefused { reason } if reason == INCOMPLETE));
}

#[test]
fn an_older_server_warns() {
    assert_eq!(
        version_note(Postgres, "17.0", "freight-prod", "16.4").as_deref(),
        Some("The backup is from PostgreSQL 17.0 and freight-prod runs 16.4. Statements may fail.")
    );
    assert_eq!(version_note(Postgres, "16.4", "freight-prod", "16.1"), None);
    assert_eq!(version_note(Postgres, "16.4", "freight-prod", "17.0"), None);
    assert_eq!(
        version_note(MySql, "8.4.0", "kestrel", "8.0.30").as_deref(),
        Some("The backup is from MySQL 8.4.0 and kestrel runs 8.0.30. Statements may fail.")
    );
    assert_eq!(version_note(MySql, "8.0.30", "kestrel", "8.0.40-log"), None);
    assert!(version_note(Sqlite, "3.45.1", "local", "3.39.0").is_some());
    assert_eq!(version_note(Postgres, "", "freight-prod", "16.4"), None);

    let dir = tempfile::tempdir().unwrap();
    let mut h = header(Postgres, &[]);
    h.server_version = "17.0".into();
    let p = write_backup(
        dir.path(),
        "b.sql",
        &h,
        "CREATE TABLE \"public\".\"t\" (a int);\n",
    );
    let cfg = config(Postgres);
    let c = check(&cfg, &p, false, &facts(Postgres, Some("freight")));
    assert_eq!(
        c.version_note.as_deref(),
        Some("The backup is from PostgreSQL 17.0 and freight-prod runs 16.4. Statements may fail.")
    );
    assert!(c.dialect_ok);
    assert_eq!(c.dialect_line, "Same Dialect as freight-prod: PostgreSQL");
}

/// The fingerprint changes with the file's bytes and path, the mode, the new name and
/// Run as is, and stays the same otherwise.
#[test]
fn fingerprint_changes_with_file_mode_name_runasis() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(Postgres);
    cfg.production = true;
    let body =
        "CREATE TABLE \"public\".\"t\" (\"a\" int);\nGRANT SELECT ON \"public\".\"t\" TO u;\n";
    let h = header(Postgres, &[("public.t", 0)]);
    let p = write_backup(dir.path(), "a.sql", &h, body);
    let target = facts(Postgres, Some("freight"));
    let plan = |path: &Path, mode: RestoreMode, run_as_is: bool| {
        let c = check(&cfg, path, run_as_is, &target);
        build_plan(&cfg, &request(&cfg, path, mode, run_as_is), &c).unwrap()
    };
    let base = plan(&p, new_db("freight_restore_1017"), false);
    match &base.verdict {
        JobVerdict::NeedsConfirmation {
            fingerprint,
            database,
            file_bytes,
            file_sha256,
            ..
        } => {
            assert_eq!(*fingerprint, base.fingerprint);
            assert_eq!(database.as_deref(), Some("freight_restore_1017"));
            assert_eq!(*file_bytes, std::fs::metadata(&p).unwrap().len());
            assert_eq!(*file_sha256, base.sha256);
        }
        v => panic!("{v:?}"),
    }
    let fp = base.fingerprint.clone();
    assert_eq!(fp.len(), 64);
    assert_eq!(
        plan(&p, new_db("freight_restore_1017"), false).fingerprint,
        fp
    );
    assert_eq!(
        plan(&p, new_db("  freight_restore_1017 "), false).fingerprint,
        fp
    );

    let changed = [
        ("name", plan(&p, new_db("freight_restore_1018"), false)),
        ("into empty", plan(&p, RestoreMode::IntoEmpty, false)),
        (
            "replace",
            plan(
                &p,
                RestoreMode::Replace {
                    backup_first: false,
                },
                false,
            ),
        ),
        (
            "replace, backup first",
            plan(&p, RestoreMode::Replace { backup_first: true }, false),
        ),
        ("run as is", plan(&p, new_db("freight_restore_1017"), true)),
    ];
    for (what, other) in changed {
        assert_ne!(other.fingerprint, fp, "{what}");
    }

    // The same bytes at another path, then other bytes at the same path.
    let copy = write_backup(dir.path(), "b.sql", &h, body);
    assert_ne!(
        plan(&copy, new_db("freight_restore_1017"), false).fingerprint,
        fp
    );
    let edited = format!("{body}CREATE TABLE \"public\".\"u\" (\"a\" int);\n");
    write_backup(dir.path(), "a.sql", &h, &edited);
    let after_edit = plan(&p, new_db("freight_restore_1017"), false);
    assert_ne!(after_edit.sha256, base.sha256);
    assert_ne!(after_edit.fingerprint, fp);

    // Another Connection.
    let c = check(&cfg, &copy, false, &target);
    let mut other_cfg = cfg.clone();
    other_cfg.id = uuid::Uuid::from_u128(8);
    let other = build_plan(
        &other_cfg,
        &request(&other_cfg, &copy, new_db("freight_restore_1017"), false),
        &c,
    )
    .unwrap();
    let same = build_plan(
        &cfg,
        &request(&cfg, &copy, new_db("freight_restore_1017"), false),
        &c,
    )
    .unwrap();
    assert_ne!(other.fingerprint, same.fingerprint);

    // A check made with the other Run as is choice is not used for the plan.
    assert!(matches!(
        build_plan(&cfg, &request(&cfg, &copy, new_db("x"), true), &c),
        Err(Error::InvalidInput(_))
    ));
}

/// Into <database> is disabled with "freight is not empty" when the target holds objects.
#[test]
fn into_empty_is_disabled_when_not_empty() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        Postgres,
        "CREATE TABLE \"public\".\"t\" (\"a\" int);\n",
    );
    let cfg = config(Postgres);

    let empty = check(&cfg, &p, false, &facts(Postgres, Some("freight")));
    assert!(empty.target_empty);
    assert_eq!(empty.empty_note, None);
    let plan = build_plan(
        &cfg,
        &request(&cfg, &p, RestoreMode::IntoEmpty, false),
        &empty,
    )
    .unwrap();
    assert_eq!(plan.verdict, JobVerdict::Ok);
    assert_eq!(plan.into_line, "Into freight");
    assert_eq!(plan.create_database, None);
    assert_eq!(texts(&plan.setup), ["BEGIN"]);
    assert_eq!(texts(&plan.after), ["COMMIT"]);
    assert!(plan.cleanup.is_empty());
    assert_eq!(plan.cleanup_line, None);

    let mut busy = facts(Postgres, Some("freight"));
    busy.objects = vec![table("orders", Some(3))];
    let c = check(&cfg, &p, false, &busy);
    assert!(!c.target_empty);
    assert_eq!(c.empty_note.as_deref(), Some("freight is not empty"));
    assert!(c.existing_objects.is_empty());
    let plan = build_plan(&cfg, &request(&cfg, &p, RestoreMode::IntoEmpty, false), &c).unwrap();
    assert_eq!(
        plan.verdict,
        JobVerdict::Blocked {
            reasons: vec!["freight is not empty".into()]
        }
    );

    // On a Connection row there is no database to restore into.
    let none = check(&cfg, &p, false, &facts(Postgres, None));
    assert!(!none.target_empty);
    assert_eq!(none.empty_note, None);
}

/// Read-only refuses before the file is read past its header, whatever it holds.
#[test]
fn read_only_refuses_past_the_header() {
    let dir = tempfile::tempdir().unwrap();
    let mut bytes = Vec::new();
    write_header(&mut bytes, &header(Postgres, &[])).unwrap();
    bytes.extend_from_slice(b"DROP DATABASE freight;\n\xff\xfe not text\n");
    let p = dir.path().join("b.sql");
    std::fs::write(&p, bytes).unwrap();
    let mut cfg = config(Postgres);
    cfg.read_only = true;
    assert!(matches!(
        inspect_file(&cfg, &p, false, &|| false, &mut |_, _| {}),
        Err(Error::ReadOnly(0))
    ));

    // The plan is refused too, even from a check made before the flag was set.
    let ok = backup(&dir, Postgres, "CREATE TABLE \"public\".\"t\" (a int);\n");
    let c = check(
        &config(Postgres),
        &ok,
        false,
        &facts(Postgres, Some("freight")),
    );
    assert!(matches!(
        build_plan(&cfg, &request(&cfg, &ok, new_db("n"), false), &c),
        Err(Error::ReadOnly(0))
    ));
}

const NEW_DB_BODY: &str = r#"CREATE TABLE "public"."t" ("id" int, "p" int);
INSERT INTO "public"."t" ("id", "p") VALUES (1, 1), (2, 1);
INSERT INTO "public"."t" ("id", "p") VALUES (3, 1);
CREATE INDEX "t_p" ON "public"."t" USING btree ("p");
ALTER TABLE ONLY "public"."t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("p") REFERENCES "public"."t"("id");
"#;

/// Into a new database on PostgreSQL: the checks' lines, then the plan's setup, cleanup
/// and lines as the spec words them.
#[test]
fn new_database_plan_on_postgres() {
    let dir = tempfile::tempdir().unwrap();
    let mut h = header(Postgres, &[("public.t", 3)]);
    h.not_included = vec!["extension pgcrypto".into(), "large objects".into()];
    let p = write_backup(dir.path(), "b.sql", &h, NEW_DB_BODY);
    let cfg = config(Postgres);
    let mut target = facts(Postgres, Some("freight"));
    target.extensions = vec!["plpgsql".into()];
    target.databases = vec!["freight".into(), "postgres".into()];
    let c = check(&cfg, &p, false, &target);

    assert_eq!(c.statements_line, "5 statements read, none refused");
    let h = c.header.as_ref().unwrap();
    assert_eq!(h.dialect, Postgres);
    assert_eq!(
        h.rows,
        [TableRows {
            table: "public.t".into(),
            rows: 3
        }]
    );
    assert_eq!(c.target_dialect, Postgres);
    assert_eq!(c.target_version, "16.4");
    assert_eq!(c.missing_extensions, ["pgcrypto"]);
    assert_eq!(
        c.extension_notes,
        ["pgcrypto is not installed on freight-prod. Functions that use it will fail."]
    );
    assert!(c.trailer_ok);
    assert_eq!(c.default_name, "freight_restore_1017");
    assert_eq!(
        c.creates,
        StructureCounts {
            tables: 1,
            indexes: 1,
            foreign_keys: 1
        }
    );
    assert_eq!(c.sha256.len(), 64);
    assert_eq!(c.bytes, std::fs::metadata(&p).unwrap().len());

    let plan = build_plan(&cfg, &request(&cfg, &p, new_db(&c.default_name), false), &c).unwrap();
    assert_eq!(plan.verdict, JobVerdict::Ok);
    assert_eq!(plan.database.as_deref(), Some("freight_restore_1017"));
    assert_eq!(
        plan.create_database.as_ref().map(|s| s.text.as_str()),
        Some("CREATE DATABASE \"freight_restore_1017\"")
    );
    assert_eq!(texts(&plan.setup), ["BEGIN"]);
    assert!(plan.drops.is_empty());
    assert_eq!(plan.cleanup, ["DROP DATABASE \"freight_restore_1017\""]);
    assert_eq!(plan.into_line, "Into freight_restore_1017");
    assert_eq!(
        plan.count_line,
        "Creates freight_restore_1017, then 1 table, 1 index and 1 Foreign Key, then runs \
         2 INSERT statements (3 rows). All of it writes."
    );
    assert_eq!(
        plan.cleanup_line.as_deref(),
        Some("If the restore fails or is cancelled: DROP DATABASE freight_restore_1017")
    );
    assert_eq!(
        plan.mode_line,
        "One transaction. Cancel rolls back and removes freight_restore_1017."
    );
    assert!(!plan.danger);
    assert!(plan.one_transaction);
    assert_eq!(plan.structure_total, 3);
    assert_eq!(plan.insert_count, 2);

    // A name the server already has is refused.
    let taken = build_plan(&cfg, &request(&cfg, &p, new_db("freight"), false), &c).unwrap();
    assert_eq!(
        taken.verdict,
        JobVerdict::Blocked {
            reasons: vec!["freight already exists. Choose another name.".into()]
        }
    );
    let blank = build_plan(&cfg, &request(&cfg, &p, new_db("  "), false), &c).unwrap();
    assert_eq!(
        blank.verdict,
        JobVerdict::Blocked {
            reasons: vec!["Name the new database.".into()]
        }
    );
}

/// Replace on MySQL: every DROP for the same-named objects, the banner, the warning and
/// the Back up first line.
#[test]
fn replace_on_mysql_lists_every_drop() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        MySql,
        "CREATE TABLE `t` (`a` int);\nCREATE TABLE `t2` (`a` int);\n\
         CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS SELECT 1;\n\
         DELIMITER ;;\nCREATE TRIGGER `tr` BEFORE INSERT ON `t` FOR EACH ROW SET NEW.a = 1;;\n\
         DELIMITER ;\n",
    );
    let cfg = config(MySql);
    let mut target = facts(MySql, Some("freight"));
    target.objects = vec![
        table("t", Some(10)),
        table("other", Some(99)),
        object(ObjectKind::Trigger, "tr"),
        table("T2", Some(5)),
        object(ObjectKind::View, "v"),
    ];
    let c = check(&cfg, &p, false, &target);
    assert_eq!(
        c.existing_note.as_deref(),
        Some("freight already has 2 tables, 1 view and 1 trigger with these names")
    );
    let plan = build_plan(
        &cfg,
        &request(&cfg, &p, RestoreMode::Replace { backup_first: true }, false),
        &c,
    )
    .unwrap();
    assert_eq!(texts(&plan.setup), ["SET FOREIGN_KEY_CHECKS = 0"]);
    assert_eq!(plan.replaced_rows, Some(15));
    assert_eq!(
        plan.backup_first_path,
        Some(
            p.parent()
                .unwrap()
                .join("freight-before-restore-2026-10-17.sql")
                .to_string_lossy()
                .into_owned()
        )
    );
    assert_eq!(
        texts(&plan.drops),
        [
            "DROP TRIGGER `tr`",
            "DROP VIEW `v`",
            "DROP TABLE `t`",
            "DROP TABLE `T2`"
        ]
    );
    assert!(plan.after.is_empty() && plan.cleanup.is_empty());
    assert_eq!(plan.into_line, "Replace the 2 tables in freight");
    assert_eq!(
        plan.replace_banner.as_deref(),
        Some(
            "Replace drops 2 tables in freight with 15 rows. Tables in freight that the file \
             does not hold are left alone."
        )
    );
    assert_eq!(
        plan.mysql_replace_note.as_deref(),
        Some("MySQL cannot undo DROP TABLE. If the restore fails, the dropped tables are gone.")
    );
    assert_eq!(
        plan.backup_first_line.as_deref(),
        Some("Back up these 2 tables first")
    );
    assert!(plan.danger);
    assert!(!plan.one_transaction);
    assert_eq!(
        plan.count_line,
        "Drops 2 tables, 1 view and 1 trigger, then creates 2 tables. All of it writes."
    );
    assert_eq!(
        plan.mode_line,
        "MySQL commits each CREATE as it runs. Cancel stops after the current statement."
    );
}

/// Replace on PostgreSQL drops views and tables each in one statement, functions with
/// their arguments, all qualified with the Backup's schema.
#[test]
fn replace_on_postgres_drops_together() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        Postgres,
        "CREATE FUNCTION \"public\".\"f\"(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;\n\
         CREATE TABLE \"public\".\"a\" (\"id\" int);\nCREATE TABLE \"public\".\"b\" (\"id\" int);\n\
         CREATE VIEW \"public\".\"v\" AS SELECT 1;\n",
    );
    let cfg = config(Postgres);
    let mut target = facts(Postgres, Some("freight"));
    target.objects = vec![
        table("a", Some(1)),
        table("b", Some(2)),
        object(ObjectKind::View, "v"),
        object(ObjectKind::Function, "f(integer)"),
        object(ObjectKind::Trigger, "tr on a"),
        table("A", None),
    ];
    let c = check(&cfg, &p, false, &target);
    let plan = build_plan(
        &cfg,
        &request(
            &cfg,
            &p,
            RestoreMode::Replace {
                backup_first: false,
            },
            false,
        ),
        &c,
    )
    .unwrap();
    assert_eq!(
        texts(&plan.drops),
        [
            "DROP VIEW \"public\".\"v\"",
            // A table's triggers and defaults depend on functions, so tables go first.
            "DROP TABLE \"public\".\"a\", \"public\".\"b\"",
            "DROP FUNCTION \"public\".\"f\"(integer)"
        ]
    );
    assert_eq!(texts(&plan.setup), ["BEGIN"]);
    assert_eq!(plan.mysql_replace_note, None);
    assert_eq!(
        plan.replace_banner.as_deref(),
        Some(
            "Replace drops 2 tables in freight with 3 rows. Tables in freight that the file \
             does not hold are left alone."
        )
    );
}

#[test]
fn names_in_statements() {
    let v = |parts: &[&str]| parts.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        insert_table(MySql, "INSERT IGNORE INTO `db`.`t` (`a`) VALUES (1)"),
        Some(v(&["db", "t"]))
    );
    assert_eq!(
        insert_table(Sqlite, "INSERT OR REPLACE INTO [t] VALUES (1)"),
        Some(v(&["t"]))
    );
    assert_eq!(
        insert_table(Postgres, "INSERT INTO Billing.\"Cu\"\"st\" VALUES (1)"),
        Some(v(&["billing", "Cu\"st"]))
    );
    assert_eq!(insert_table(MySql, "REPLACE INTO t VALUES (1)"), None);
    assert_eq!(
        insert_table(
            Postgres,
            "/* -- section: rows x */ INSERT INTO y VALUES (1)"
        ),
        Some(v(&["y"]))
    );

    assert_eq!(
        created_object(
            MySql,
            "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS SELECT 1"
        ),
        Some((ObjectKind::View, v(&["v"])))
    );
    assert_eq!(
        created_object(Postgres, "CREATE TABLE IF NOT EXISTS \"s\".\"t\" (a int)"),
        Some((ObjectKind::Table, v(&["s", "t"])))
    );
    assert_eq!(
        created_object(
            Postgres,
            "CREATE OR REPLACE FUNCTION s.f(a int) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql"
        ),
        Some((ObjectKind::Function, v(&["s", "f"])))
    );
    assert_eq!(
        created_object(Postgres, "CREATE MATERIALIZED VIEW s.m AS SELECT 1"),
        Some((ObjectKind::View, v(&["s", "m"])))
    );
    assert_eq!(
        created_object(Postgres, "CREATE UNIQUE INDEX i ON t (a)"),
        None
    );
    assert_eq!(created_object(Postgres, "CREATE SCHEMA s"), None);

    assert_eq!(
        ddl_counts(
            MySql,
            "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `c` int,\n  PRIMARY KEY (`id`),\n  \
             UNIQUE KEY `u` (`c`),\n  KEY `k` (`c`),\n  CONSTRAINT `fk` FOREIGN KEY (`c`) \
             REFERENCES `p` (`id`)\n) ENGINE=InnoDB"
        ),
        DdlCounts {
            tables: 1,
            indexes: 2,
            foreign_keys: 1
        }
    );
    assert_eq!(
        ddl_counts(
            Postgres,
            "ALTER TABLE ONLY \"s\".\"t\" ADD CONSTRAINT \"fk\" FOREIGN KEY (\"c\") REFERENCES \"s\".\"p\"(\"id\")"
        ),
        DdlCounts {
            tables: 0,
            indexes: 0,
            foreign_keys: 1
        }
    );
    assert_eq!(
        ddl_counts(Postgres, "CREATE UNIQUE INDEX i ON s.t USING btree (a)"),
        DdlCounts {
            tables: 0,
            indexes: 1,
            foreign_keys: 0
        }
    );
    assert_eq!(
        ddl_counts(
            Postgres,
            "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN CREATE TABLE x (a int REFERENCES y); END $$ LANGUAGE plpgsql"
        ),
        DdlCounts::default()
    );
}

#[test]
fn types_cross_as_camel_case() {
    let req: RestoreRequest = serde_json::from_value(serde_json::json!({
        "target": { "connectionId": uuid::Uuid::from_u128(7), "database": "freight" },
        "path": "C:/b.sql",
        "mode": { "kind": "replace", "backupFirst": true },
        "runAsIs": true
    }))
    .unwrap();
    assert_eq!(req.mode, RestoreMode::Replace { backup_first: true });
    assert!(req.run_as_is);
    let empty: RestoreRequest = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(empty, RestoreRequest::default());
    let named: RestoreMode =
        serde_json::from_value(serde_json::json!({ "kind": "newDatabase" })).unwrap();
    assert_eq!(named, new_db(""));

    let dir = tempfile::tempdir().unwrap();
    let p = backup(&dir, Postgres, "CREATE TABLE \"public\".\"t\" (a int);\n");
    let cfg = config(Postgres);
    let c = check(&cfg, &p, false, &facts(Postgres, Some("freight")));
    let json = serde_json::to_value(&c).unwrap();
    assert_eq!(json["statementsLine"], "1 statement read, none refused");
    assert_eq!(json["defaultName"], "freight_restore_1017");
    for key in [
        "path",
        "header",
        "bytes",
        "sha256",
        "targetName",
        "targetDialect",
        "targetVersion",
        "dialectOk",
        "versionNote",
        "statements",
        "refused",
        "skipped",
        "existingTables",
        "targetEmpty",
        "missingExtensions",
        "trailerOk",
    ] {
        assert!(json.get(key).is_some(), "check {key}");
    }
    assert_eq!(json["header"]["dialect"], "postgres");
    assert_eq!(json["header"]["rows"], serde_json::json!([]));
    assert_eq!(json["targetDialect"], "postgres");
    assert!(json.get("backupHeader").is_none());
    assert!(json.get("fileObjects").is_none());
    let plan = build_plan(&cfg, &request(&cfg, &p, new_db("n"), false), &c).unwrap();
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(json["mode"]["kind"], "newDatabase");
    assert_eq!(json["intoLine"], "Into n");
    for key in [
        "setup",
        "drops",
        "structure",
        "structureTotal",
        "creates",
        "insertCount",
        "insertRows",
        "insertShape",
        "after",
        "cleanup",
        "replacedRows",
        "backupFirstPath",
        "modeLine",
        "fingerprint",
        "verdict",
    ] {
        assert!(json.get(key).is_some(), "plan {key}");
    }
    assert_eq!(json["creates"]["foreignKeys"], 0);
    assert!(json["setup"][0]["class"].is_string());
    assert_eq!(json["verdict"]["kind"], "ok");
}

/// On a live SQLite target: the target's tables make Into <database> disabled, same names
/// are listed and dropped by Replace, an existing file is refused as a new one, and a
/// Read-only Connection refuses the plan.
#[tokio::test]
async fn sqlite_target_is_read_for_the_checks() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("freight.sqlite");
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute_batch("CREATE TABLE x (a); CREATE TABLE other (a);")
        .unwrap();
    let mut cfg = config(Sqlite);
    cfg.file = Some(db.clone());
    let d = crate::dialect::connect(&cfg, None).await.unwrap();
    let p = backup(
        &dir,
        Sqlite,
        "CREATE TABLE x (a);\nINSERT INTO x VALUES (1);\n",
    );
    let target = RestoreTarget {
        connection_id: cfg.id,
        database: None,
        schema: None,
    };

    let c = inspect_restore(d.clone(), cfg.clone(), target.clone(), p.clone(), false)
        .await
        .unwrap();
    assert!(!c.target_empty);
    assert_eq!(c.empty_note.as_deref(), Some("freight is not empty"));
    assert_eq!(
        c.existing_note.as_deref(),
        Some("freight already has 1 table with these names")
    );
    assert_eq!(c.target_database.as_deref(), Some("main"));
    let default = PathBuf::from(&c.default_name);
    assert_eq!(default.parent(), db.parent());
    assert!(c.default_name.ends_with(&format!(
        "freight_restore_{}.sqlite",
        mmdd_of(&crate::dbml_writer::today_utc())
    )));

    let req = |mode: RestoreMode| RestoreRequest {
        target: target.clone(),
        path: p.clone(),
        mode,
        run_as_is: false,
        local_date: None,
    };
    let into = plan_restore(d.clone(), cfg.clone(), req(RestoreMode::IntoEmpty))
        .await
        .unwrap();
    assert_eq!(
        into.verdict,
        JobVerdict::Blocked {
            reasons: vec!["freight is not empty".into()]
        }
    );
    let replace = plan_restore(
        d.clone(),
        cfg.clone(),
        req(RestoreMode::Replace {
            backup_first: false,
        }),
    )
    .await
    .unwrap();
    assert_eq!(replace.verdict, JobVerdict::Ok);
    assert_eq!(texts(&replace.drops), ["DROP TABLE \"x\""]);
    assert_eq!(
        texts(&replace.setup),
        ["PRAGMA foreign_keys = OFF", "BEGIN"]
    );
    let after = texts(&replace.after);
    assert_eq!(after[..2], ["PRAGMA foreign_key_check", "COMMIT"]);
    assert_eq!(after.len(), 3, "{after:?}");
    assert!(after[2].starts_with("PRAGMA foreign_keys = "));
    assert_eq!(replace.insert_count, 1);

    let name = db.to_string_lossy().into_owned();
    let over = plan_restore(d.clone(), cfg.clone(), req(new_db(&name)))
        .await
        .unwrap();
    assert_eq!(
        over.verdict,
        JobVerdict::Blocked {
            reasons: vec![format!("{name} already exists. Choose a new file.")]
        }
    );
    let fresh = dir
        .path()
        .join("fresh.sqlite")
        .to_string_lossy()
        .into_owned();
    let new = plan_restore(d.clone(), cfg.clone(), req(new_db(&fresh)))
        .await
        .unwrap();
    assert_eq!(new.verdict, JobVerdict::Ok);
    assert_eq!(new.delete_file, Some(PathBuf::from(&fresh)));
    assert_eq!(
        new.cleanup_line,
        Some(format!(
            "If the restore fails or is cancelled: delete {fresh}"
        ))
    );

    let mut read_only = cfg.clone();
    read_only.read_only = true;
    assert!(matches!(
        plan_restore(d, read_only, req(RestoreMode::IntoEmpty)).await,
        Err(Error::ReadOnly(0))
    ));
}

/// R14: the only calls taken as literals are PostgreSQL `decode('<hex>', 'hex')` and
/// `ST_GeomFromText('<literal>'[, <int>])`; any other call, or those with other
/// arguments, is shown in full.
#[test]
fn only_contura_value_calls_are_literals() {
    let dir = tempfile::tempdir().unwrap();
    let body = r#"CREATE TABLE "public"."t" ("b" bytea, "g" geometry);
INSERT INTO "public"."t" ("b") VALUES (decode('00ff', 'hex'));
INSERT INTO "public"."t" ("g") VALUES (ST_GeomFromText('POINT(1 1)', 4326));
INSERT INTO "public"."t" ("g") VALUES (ST_GeomFromText('POINT(1 1)'));
INSERT INTO "public"."t" ("b") VALUES (decode('AAEC', 'base64'));
INSERT INTO "public"."t" ("b") VALUES (decode(lower('00FF'), 'hex'));
INSERT INTO "public"."t" ("b") VALUES (decode('zz', 'hex'));
INSERT INTO "public"."t" ("g") VALUES (ST_GeomFromText('POINT(1 1)', 4326, 'axis-order=long-lat'));
INSERT INTO "public"."t" ("g") VALUES (ST_GeomFromText((SELECT "w" FROM "public"."src")));
INSERT INTO "public"."t" ("b") VALUES (md5('x'));
"#;
    let p = backup(&dir, Postgres, body);
    let f = file_check(&config(Postgres), &p, false);
    assert_eq!(f.insert_count, 3);
    assert_eq!(f.structure_total, 7);
    let full: Vec<&str> = f.structure.iter().map(|s| s.text.as_str()).collect();
    for needle in [
        "'base64'",
        "lower(",
        "'zz'",
        "axis-order",
        "(SELECT",
        "md5(",
    ] {
        assert!(
            full.iter().any(|t| t.contains(needle)),
            "{needle} not shown"
        );
    }

    let my = write_backup(
        dir.path(),
        "my.sql",
        &header(MySql, &[]),
        "CREATE TABLE `t` (`g` geometry, `b` blob);\n\
         INSERT INTO `t` (`g`) VALUES (ST_GeomFromText('POINT(1 1)', 4326));\n\
         INSERT INTO `t` (`b`) VALUES (X'00ff');\n\
         INSERT INTO `t` (`g`) VALUES (ST_GeomFromText(CONCAT('POINT(', 1, ' 1)')));\n\
         INSERT INTO `t` (`b`) VALUES (decode('00', 'hex'));\n",
    );
    let f = file_check(&config(MySql), &my, false);
    assert_eq!(f.insert_count, 2);
    assert_eq!(f.structure_total, 3);
}

/// R11: a PostgreSQL setval is labelled a write in the list and in the pages.
#[test]
fn setval_is_labelled_a_write() {
    use crate::safety::StatementClass;
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        Postgres,
        "CREATE SEQUENCE \"public\".\"s\";\nSELECT pg_catalog.setval('\"public\".\"s\"', 42, true);\n\
         SELECT 'setval(' AS x;\n",
    );
    let cfg = config(Postgres);
    let f = file_check(&cfg, &p, false);
    let classes: Vec<StatementClass> = f.structure.iter().map(|s| s.class).collect();
    assert_eq!(classes[1], StatementClass::Write);
    assert_eq!(classes[2], StatementClass::Read);
    let page = structure_page(&cfg, &p, false, 1).unwrap();
    assert_eq!(page[0].class, StatementClass::Write);
}

/// I-6, M-10: the shape rule matches table names exactly on MySQL and PostgreSQL, part
/// by part against the header; SQLite folds ASCII case.
#[test]
fn table_names_match_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let my = write_backup(
        dir.path(),
        "my.sql",
        &header(MySql, &[]),
        "CREATE TABLE `t` (`a` int);\nINSERT INTO `T` (`a`) VALUES (1);\nINSERT INTO `t` (`a`) VALUES (2);\n",
    );
    let f = file_check(&config(MySql), &my, false);
    assert_eq!(f.insert_count, 1);
    assert!(
        f.structure
            .iter()
            .any(|s| s.text.starts_with("INSERT INTO `T`"))
    );

    let lite = write_backup(
        dir.path(),
        "lite.sql",
        &header(Sqlite, &[]),
        "CREATE TABLE t (a);\nINSERT INTO T (a) VALUES (1);\n",
    );
    assert_eq!(file_check(&config(Sqlite), &lite, false).insert_count, 1);

    let pg = write_backup(
        dir.path(),
        "pg.sql",
        &header(Postgres, &[("public.t", 1)]),
        "INSERT INTO \"public.t\" (\"a\") VALUES (1);\nINSERT INTO \"public\".\"t\" (\"a\") VALUES (1);\n",
    );
    let f = file_check(&config(Postgres), &pg, false);
    assert_eq!(f.insert_count, 1);
    assert!(f.structure[0].text.starts_with("INSERT INTO \"public.t\""));
}

/// M-7: the pages hold the statements shown exactly, in file order, from `from`, with
/// skipped statements only under Run as is.
#[test]
fn structure_pages_follow_the_list() {
    let dir = tempfile::tempdir().unwrap();
    let h = header(Postgres, &[("public.t", 6), ("public.h", 1)]);
    let p = write_backup(dir.path(), "b.sql", &h, MARKERS_BODY);
    let cfg = config(Postgres);
    let f = file_check(&cfg, &p, false);
    let all = structure_page(&cfg, &p, false, 0).unwrap();
    assert_eq!(all, f.structure);
    let rest = structure_page(&cfg, &p, false, 5).unwrap();
    assert_eq!(rest, f.structure[5..]);
    assert!(structure_page(&cfg, &p, false, 100).unwrap().is_empty());

    let s = write_backup(dir.path(), "s.sql", &header(MySql, &[]), SKIPPED_BODY);
    let my = config(MySql);
    assert_eq!(structure_page(&my, &s, false, 0).unwrap().len(), 1);
    assert_eq!(structure_page(&my, &s, true, 0).unwrap().len(), 7);

    let mut ro = my.clone();
    ro.read_only = true;
    assert!(matches!(
        structure_page(&ro, &s, false, 0),
        Err(Error::ReadOnly(0))
    ));
}

/// Plain SQL is read (R16): no header, no trailer, and only tables the file creates make
/// a shape.
#[test]
fn plain_sql_is_checked_without_a_header() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("plain.sql");
    std::fs::write(
        &p,
        "CREATE TABLE t (a int);\nINSERT INTO t VALUES (1);\nINSERT INTO u VALUES (2);\n",
    )
    .unwrap();
    let cfg = config(Postgres);
    let c = check(&cfg, &p, false, &facts(Postgres, Some("freight")));
    assert!(c.header.is_none() && c.backup_header.is_none());
    assert!(!c.trailer_ok);
    assert!(c.dialect_ok);
    assert_eq!(c.version_note, None);
    assert_eq!(c.insert_count, 1);
    assert_eq!(c.structure_total, 2);
    assert_eq!(c.default_name, "freight_restore_1017");
    let plan = build_plan(&cfg, &request(&cfg, &p, new_db("n"), false), &c).unwrap();
    assert_eq!(plan.verdict, JobVerdict::Ok);
    assert!(!plan.danger);
}

/// R15 on MySQL: CREATE DATABASE on its own, then the writer's setup with Foreign Key
/// checks off in every mode.
#[test]
fn mysql_new_database_order() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(&dir, MySql, "CREATE TABLE `t` (`a` int);\n");
    let cfg = config(MySql);
    let c = check(&cfg, &p, false, &facts(MySql, Some("freight")));
    let plan = build_plan(
        &cfg,
        &request(&cfg, &p, new_db("freight_restore_1017"), false),
        &c,
    )
    .unwrap();
    assert_eq!(
        plan.create_database.as_ref().map(|s| s.text.as_str()),
        Some("CREATE DATABASE `freight_restore_1017`")
    );
    assert_eq!(texts(&plan.setup), ["SET FOREIGN_KEY_CHECKS = 0"]);
    assert_eq!(plan.cleanup, ["DROP DATABASE `freight_restore_1017`"]);
    let into = build_plan(&cfg, &request(&cfg, &p, RestoreMode::IntoEmpty, false), &c).unwrap();
    assert_eq!(texts(&into.setup), ["SET FOREIGN_KEY_CHECKS = 0"]);
    assert_eq!(into.create_database, None);
}

/// M-4: Replace with nothing to drop has no banner, rows or Back up first step.
#[test]
fn replace_with_nothing_to_drop() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(&dir, MySql, "CREATE TABLE `t` (`a` int);\n");
    let cfg = config(MySql);
    let c = check(&cfg, &p, false, &facts(MySql, Some("freight")));
    let plan = build_plan(
        &cfg,
        &request(&cfg, &p, RestoreMode::Replace { backup_first: true }, false),
        &c,
    )
    .unwrap();
    assert!(plan.drops.is_empty());
    assert_eq!(plan.replace_banner, None);
    assert_eq!(plan.backup_first_line, None);
    assert_eq!(plan.backup_first_path, None);
    assert_eq!(plan.replaced_rows, None);
}

/// M-3: a PostgreSQL materialized view is dropped as one.
#[test]
fn replace_drops_a_materialized_view() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        Postgres,
        "CREATE MATERIALIZED VIEW \"public\".\"mv\" AS SELECT 1 WITH DATA;\n\
         CREATE VIEW \"public\".\"v\" AS SELECT 1;\n",
    );
    let cfg = config(Postgres);
    let mut target = facts(Postgres, Some("freight"));
    target.objects = vec![
        object(ObjectKind::View, "mv"),
        object(ObjectKind::View, "v"),
    ];
    target.materialized_views = vec!["mv".into()];
    let c = check(&cfg, &p, false, &target);
    let plan = build_plan(
        &cfg,
        &request(
            &cfg,
            &p,
            RestoreMode::Replace {
                backup_first: false,
            },
            false,
        ),
        &c,
    )
    .unwrap();
    assert_eq!(
        texts(&plan.drops),
        [
            "DROP VIEW \"public\".\"v\"",
            "DROP MATERIALIZED VIEW \"public\".\"mv\""
        ]
    );
}

/// R18: PostgreSQL Replace needs a known schema. Without one (plain SQL on a database
/// row) it is disabled with a reason and drops nothing; with one, only same-named objects
/// in that schema collide and every DROP is qualified.
#[test]
fn postgres_replace_needs_a_schema() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(Postgres);
    let mut target = facts(Postgres, Some("freight"));
    target.objects = vec![table("t", Some(5))];
    let replace = RestoreMode::Replace {
        backup_first: false,
    };

    // Plain SQL creating "audit"."t"; the database holds public.t.
    let plain = dir.path().join("plain.sql");
    std::fs::write(&plain, "CREATE TABLE \"audit\".\"t\" (\"a\" int);\n").unwrap();
    let c = check(&cfg, &plain, false, &target);
    let note = "Open Restore on a schema to replace its tables.";
    assert_eq!(c.replace_note.as_deref(), Some(note));
    let plan = build_plan(&cfg, &request(&cfg, &plain, replace.clone(), false), &c).unwrap();
    assert_eq!(
        plan.verdict,
        JobVerdict::Blocked {
            reasons: vec![note.into()]
        }
    );
    assert!(plan.drops.is_empty());
    assert_eq!(plan.replace_banner, None);
    assert_eq!(plan.replaced_rows, None);
    // The other modes are not affected.
    let new = build_plan(&cfg, &request(&cfg, &plain, new_db("n"), false), &c).unwrap();
    assert_eq!(new.verdict, JobVerdict::Ok);

    // A Backup of schema public that creates "audit"."t": public.t does not collide.
    let audit = backup(
        &dir,
        Postgres,
        "CREATE TABLE \"audit\".\"t\" (\"a\" int);\n",
    );
    let c = check(&cfg, &audit, false, &target);
    assert_eq!(c.replace_note, None);
    assert!(c.existing_objects.is_empty());
    let plan = build_plan(&cfg, &request(&cfg, &audit, replace.clone(), false), &c).unwrap();
    assert!(plan.drops.is_empty());

    // The same file name in the known schema collides and is dropped qualified.
    let public = write_backup(
        dir.path(),
        "public.sql",
        &header(Postgres, &[]),
        "CREATE TABLE \"public\".\"t\" (\"a\" int);\n",
    );
    let c = check(&cfg, &public, false, &target);
    let plan = build_plan(&cfg, &request(&cfg, &public, replace, false), &c).unwrap();
    assert_eq!(texts(&plan.drops), ["DROP TABLE \"public\".\"t\""]);
    assert_eq!(plan.replaced_rows, Some(5));
}

#[test]
fn statements_that_end_shapes() {
    let yes = [
        (MySql, "USE `other`"),
        (MySql, "SET ROLE `admin`"),
        (MySql, "SELECT 1"),
        (MySql, "CALL `p`()"),
        (MySql, "DO SLEEP(0)"),
        (MySql, "PREPARE s FROM 'USE other'"),
        (MySql, "EXECUTE s"),
        (Postgres, "SET search_path TO audit"),
        (Postgres, "SET search_path = public, audit"),
        (Postgres, "SET search_path TO '', public"),
        (Postgres, "SET LOCAL search_path = audit"),
        (Postgres, "SET SESSION search_path TO DEFAULT"),
        (Postgres, "SET SCHEMA 'audit'"),
        (Postgres, "RESET search_path"),
        (Postgres, "RESET ALL"),
        // Quoted names (re-review 2, bypass 1).
        (Postgres, "SET \"search_path\" = audit"),
        (Postgres, "SET LOCAL \"search_path\" TO audit"),
        (Postgres, "RESET \"search_path\""),
        (
            Postgres,
            "SELECT \"set_config\"('search_path', 'audit', false)",
        ),
        (
            Postgres,
            "SELECT pg_catalog.\"set_config\"('search_path', 'audit', false)",
        ),
        (
            Postgres,
            "UPDATE \"t\" SET \"a\" = pg_catalog.\"set_config\"('x', 'y', false)",
        ),
        // Any set_config call (bypass 2).
        (
            Postgres,
            "SELECT set_config('search_' || 'path', 'audit', false)",
        ),
        (
            Postgres,
            "SELECT set_config(lower('SEARCH_PATH'), 'audit', false)",
        ),
        (Postgres, "SELECT set_config('TimeZone', 'UTC', false)"),
        (
            Postgres,
            "UPDATE \"t\" SET \"a\" = set_config(\"n\", 'audit', false)",
        ),
        // Statements that run code (bypass 3).
        (
            Postgres,
            "DO $$ BEGIN PERFORM set_config('search_path','audit',false); END $$",
        ),
        (Postgres, "PREPARE s AS SELECT 1"),
        (Postgres, "EXECUTE s"),
        (Postgres, "CALL \"public\".\"p\"()"),
        (Postgres, "SELECT \"public\".\"f\"()"),
        (Postgres, "WITH x AS (SELECT 1) SELECT * FROM x"),
        (Postgres, "VALUES (1)"),
        // Who `$user` is (bypass 4).
        (Postgres, "SET ROLE audit"),
        (Postgres, "SET SESSION AUTHORIZATION audit"),
        (Postgres, "RESET ROLE"),
        (Postgres, "RESET SESSION AUTHORIZATION"),
    ];
    for (d, sql) in yes {
        assert!(ends_shapes(d, sql), "{sql}");
    }
    let no = [
        (Postgres, "SET search_path = ''"),
        (Postgres, "SET search_path TO ''"),
        (Postgres, "SET client_encoding = 'UTF8'"),
        (Postgres, "SET standard_conforming_strings = on"),
        (Postgres, "SET check_function_bodies = false"),
        (Postgres, "SET TimeZone = 'UTC'"),
        (
            Postgres,
            "CREATE FUNCTION \"public\".\"f\"() RETURNS text LANGUAGE sql AS $$ SELECT set_config('search_path', 'x', false) $$",
        ),
        (
            Postgres,
            "INSERT INTO \"public\".\"t\" (\"a\") VALUES ('set_config(')",
        ),
        (MySql, "SET NAMES utf8mb4"),
        (MySql, "SET FOREIGN_KEY_CHECKS = 0"),
        (MySql, "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO'"),
        (Sqlite, "PRAGMA foreign_keys = OFF"),
    ];
    for (d, sql) in no {
        assert!(!ends_shapes(d, sql), "{sql}");
    }
}

/// R19: after a statement that redirects unqualified names, no INSERT is a shape.
#[test]
fn no_shapes_after_a_redirect() {
    let dir = tempfile::tempdir().unwrap();
    let my = write_backup(
        dir.path(),
        "my.sql",
        &header(MySql, &[]),
        "CREATE TABLE `t` (`a` int);\nINSERT INTO `t` (`a`) VALUES (1);\nUSE `other`;\n\
         INSERT INTO `t` (`a`) VALUES (2);\n",
    );
    let f = file_check(&config(MySql), &my, false);
    assert_eq!(f.insert_count, 1);
    assert!(
        f.structure
            .iter()
            .any(|s| s.text == "INSERT INTO `t` (`a`) VALUES (2)")
    );

    let pg = backup(
        &dir,
        Postgres,
        "SET search_path = '';\nCREATE TABLE \"public\".\"t\" (\"a\" int);\n\
         INSERT INTO \"public\".\"t\" (\"a\") VALUES (1);\n\
         SELECT pg_catalog.set_config('search_path', 'audit', false);\n\
         INSERT INTO \"public\".\"t\" (\"a\") VALUES (2);\n",
    );
    let f = file_check(&config(Postgres), &pg, false);
    assert_eq!(f.insert_count, 1);
    assert!(f.structure.iter().any(|s| s.text.ends_with("VALUES (2)")));
    let page = structure_page(&config(Postgres), &pg, false, 0).unwrap();
    assert_eq!(page, f.structure);
}

/// R22: a whole Contura Backup, laid out as the spec's per-Dialect rules write it
/// (settings, structure, rows, after-rows, finish), still shows every INSERT as a shape:
/// nothing that ends shapes comes before its rows.
#[test]
fn contura_backups_keep_their_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let pg_body = r#"-- section: settings
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET search_path = '';
SET TimeZone = 'UTC';
-- section: structure
CREATE SCHEMA "billing";
CREATE TYPE "billing"."state" AS ENUM ('open', 'paid');
CREATE SEQUENCE "billing"."invoice_no";
CREATE FUNCTION "billing"."touch"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.at = now(); RETURN NEW; END $$;
CREATE TABLE "billing"."customers" ("id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL, "name" text NOT NULL, "photo" bytea);
CREATE TABLE "billing"."invoices" ("id" bigint NOT NULL, "customer" integer, "state" "billing"."state", "at" timestamp with time zone);
COMMENT ON TABLE "billing"."customers" IS 'People who pay';
-- section: rows billing.customers
INSERT INTO "billing"."customers" ("id", "name", "photo") OVERRIDING SYSTEM VALUE VALUES (1, 'Ana', decode('00ff', 'hex')), (2, E'O\'Brien', NULL);
-- section: rows billing.invoices
INSERT INTO "billing"."invoices" ("id", "customer", "state", "at") VALUES (1, 1, 'open', '2026-10-16 22:00:00+00'::timestamp with time zone), (2, 2, 'paid', NULL);
INSERT INTO "billing"."invoices" ("id", "customer", "state", "at") VALUES (3, 1, 'open', 'infinity');
-- section: after-rows
ALTER TABLE ONLY "billing"."customers" ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "billing"."invoices" ADD CONSTRAINT "invoices_customer_fkey" FOREIGN KEY ("customer") REFERENCES "billing"."customers"("id");
CREATE INDEX "invoices_at" ON "billing"."invoices" USING btree ("at");
CREATE VIEW "billing"."open_invoices" AS SELECT "id" FROM "billing"."invoices" WHERE "state" = 'open';
CREATE TRIGGER "touch" BEFORE UPDATE ON "billing"."invoices" FOR EACH ROW EXECUTE FUNCTION "billing"."touch"();
SELECT pg_catalog.setval('"billing"."customers_id_seq"', 2, true);
-- section: finish
"#;
    let mut h = header(
        Postgres,
        &[("billing.customers", 2), ("billing.invoices", 3)],
    );
    h.schema = Some("billing".into());
    let p = write_backup(dir.path(), "pg.sql", &h, pg_body);
    let f = file_check(&config(Postgres), &p, false);
    assert!(f.refused.is_empty(), "{:?}", f.refused);
    assert_eq!((f.insert_count, f.insert_rows), (3, 5));
    assert!(
        !f.structure.iter().any(|s| s.text.starts_with("INSERT")),
        "an INSERT was shown in full"
    );

    let my_body = "-- section: settings\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\
SET UNIQUE_CHECKS = 0;\nSET time_zone = '+00:00';\nSET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';\n\
-- section: structure\n\
CREATE TABLE `customers` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `name` varchar(50) NOT NULL,\n  `spot` point DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4;\n\
CREATE TABLE `orders` (\n  `id` int NOT NULL,\n  `customer` int DEFAULT NULL,\n  `at` datetime DEFAULT NULL,\n  KEY `customer` (`customer`),\n  CONSTRAINT `orders_customer` FOREIGN KEY (`customer`) REFERENCES `customers` (`id`)\n) ENGINE=InnoDB;\n\
-- section: rows freight.customers\n\
INSERT INTO `customers` (`id`, `name`, `spot`) VALUES (1, 'Ana', ST_GeomFromText('POINT(1 1)', 4326)), (2, _utf8mb4 X'4f27427269656e', NULL);\n\
-- section: rows freight.orders\n\
INSERT INTO `orders` (`id`, `customer`, `at`) VALUES (1, 1, '0000-00-00 00:00:00'), (2, 2, '2026-10-16 22:00:00');\n\
-- section: after-rows\n\
DELIMITER ;;\nCREATE FUNCTION `total`(`c` int) RETURNS int DETERMINISTIC RETURN (SELECT COUNT(*) FROM `orders` WHERE `customer` = `c`);;\nDELIMITER ;\n\
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `busy` AS SELECT `customer`, `total`(`customer`) AS `n` FROM `orders`;\n\
DELIMITER ;;\nCREATE TRIGGER `stamp` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.at = NOW();;\nDELIMITER ;\n\
-- section: finish\nSET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n";
    let p = write_backup(
        dir.path(),
        "my.sql",
        &header(MySql, &[("customers", 2), ("orders", 2)]),
        my_body,
    );
    let f = file_check(&config(MySql), &p, false);
    assert!(f.refused.is_empty(), "{:?}", f.refused);
    assert_eq!((f.insert_count, f.insert_rows), (2, 4));
    assert!(!f.structure.iter().any(|s| s.text.starts_with("INSERT")));
}

/// Re-review 2: each bypass ends the shapes in the file pass too.
#[test]
fn bypasses_end_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let cases = [
        "SET \"search_path\" = audit;",
        "RESET \"search_path\";",
        "SELECT pg_catalog.\"set_config\"('search_path', 'audit', false);",
        "SELECT set_config('search_' || 'path', 'audit', false);",
        "DO $$ BEGIN PERFORM set_config('search_path', 'audit', false); END $$;",
        "SELECT \"public\".\"f\"();",
        "SET ROLE audit;",
    ];
    for (i, stmt) in cases.iter().enumerate() {
        let body = format!(
            "CREATE TABLE \"public\".\"t\" (\"a\" int);\n\
             INSERT INTO \"public\".\"t\" (\"a\") VALUES (1);\n{stmt}\n\
             INSERT INTO \"public\".\"t\" (\"a\") VALUES (2);\n"
        );
        let p = write_backup(
            dir.path(),
            &format!("b{i}.sql"),
            &header(Postgres, &[]),
            &body,
        );
        let f = file_check(&config(Postgres), &p, false);
        assert_eq!(f.insert_count, 1, "{stmt}");
        assert!(
            f.structure.iter().any(|s| s.text.ends_with("VALUES (2)")),
            "{stmt}"
        );
    }
}

/// R24 (a): PostgreSQL literal rows with OVERRIDING SYSTEM VALUE are a shape.
#[test]
fn overriding_system_value_is_a_shape() {
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        Postgres,
        "CREATE TABLE \"public\".\"t\" (\"id\" int GENERATED ALWAYS AS IDENTITY, \"a\" text);\n\
         INSERT INTO \"public\".\"t\" (\"id\", \"a\") OVERRIDING SYSTEM VALUE VALUES (1, 'x'), (2, NULL);\n\
         INSERT INTO \"public\".\"t\" (\"id\", \"a\") OVERRIDING SYSTEM VALUE VALUES (3, lower('Y'));\n",
    );
    let f = file_check(&config(Postgres), &p, false);
    assert_eq!((f.insert_count, f.insert_rows), (1, 2));
    assert!(
        f.insert_shape
            .unwrap()
            .head
            .ends_with("OVERRIDING SYSTEM VALUE VALUES")
    );
    assert!(f.structure.iter().any(|s| s.text.contains("lower('Y')")));
}

/// R24 (b): SQLite keeps CREATE TABLE text verbatim, so any quoting of the name matches
/// the Backup's `INSERT INTO "orders"`.
#[test]
fn sqlite_names_match_unquoted() {
    let dir = tempfile::tempdir().unwrap();
    for (i, name) in ["orders", "\"orders\"", "[orders]", "`orders`", "ORDERS"]
        .iter()
        .enumerate()
    {
        let p = write_backup(
            dir.path(),
            &format!("s{i}.sql"),
            &header(Sqlite, &[]),
            &format!(
                "CREATE TABLE {name} (id INTEGER PRIMARY KEY, a TEXT);\n\
                 INSERT INTO \"orders\" (\"id\", \"a\") VALUES (1, 'x'), (2, X'00ff');\n"
            ),
        );
        let f = file_check(&config(Sqlite), &p, false);
        assert_eq!((f.insert_count, f.insert_rows), (1, 2), "{name}");
    }
}

/// The file pass: one shape INSERT, `stmt`, then a second literal INSERT into the same
/// table that must be shown in full.
fn assert_ends_shapes_in_file(dialect: DialectKind, stmt: &str) {
    let dir = tempfile::tempdir().unwrap();
    let (create, insert) = if dialect == MySql {
        (
            "CREATE TABLE `t` (`a` int);",
            "INSERT INTO `t` (`a`) VALUES",
        )
    } else {
        (
            "CREATE TABLE \"public\".\"t\" (\"a\" int);",
            "INSERT INTO \"public\".\"t\" (\"a\") VALUES",
        )
    };
    let body = format!("{create}\n{insert} (1);\n{stmt}\n{insert} (2);\n");
    let p = write_backup(dir.path(), "e.sql", &header(dialect, &[]), &body);
    let f = file_check(&config(dialect), &p, false);
    assert_eq!(f.insert_count, 1, "{stmt}");
    assert!(
        f.structure
            .iter()
            .any(|s| s.text == format!("{insert} (2)")),
        "{stmt}"
    );
}

/// R26 (1): a PostgreSQL `U&"..."` name counts as any name it is compared with.
#[test]
fn unicode_names_end_shapes() {
    let yes = [
        "SET U&\"search\\005fpath\" = audit",
        "SET LOCAL U&\"search\\005fpath\" TO audit",
        "SET SESSION u&\"search\\005fpath\" TO audit",
        "RESET U&\"search\\005fpath\"",
        "UPDATE \"t\" SET \"a\" = U&\"set\\005fconfig\"('search_path', 'audit', false)",
        "UPDATE \"t\" SET \"a\" = pg_catalog.U&\"set\\005fconfig\"('search_path', 'audit', false)",
        "ALTER TABLE \"t\" ADD COLUMN \"b\" text DEFAULT U&\"set\\005fconfig\"('x', 'y', false)",
    ];
    for sql in yes {
        assert!(ends_shapes(Postgres, sql), "{sql}");
    }
    // A word ending in u is not the U& prefix; a U& string is not a name.
    assert!(!ends_shapes(Postgres, "SET menu&\"x\" = 1"));
    assert!(!ends_shapes(Postgres, "SET client_encoding = U&'UTF8'"));
    // The table an INSERT names cannot be read from a U& name, so it is never a shape.
    assert_eq!(
        insert_table(Postgres, "INSERT INTO U&\"t\" VALUES (1)"),
        None
    );
    assert_eq!(
        insert_table(Postgres, "INSERT INTO \"public\".U&\"t\" VALUES (1)"),
        None
    );
    assert_ends_shapes_in_file(Postgres, "SET U&\"search\\005fpath\" = audit;");
    assert_ends_shapes_in_file(
        Postgres,
        "UPDATE \"public\".\"t\" SET \"a\" = U&\"set\\005fconfig\"('search_path', 'audit', false)::int;",
    );
}

/// R26 (2): a write shown in full that calls a function ends shapes; syntax and sized
/// type names before `(`, and the table's column list, do not.
#[test]
fn writes_that_call_functions_end_shapes() {
    let yes = [
        (
            Postgres,
            "INSERT INTO \"public\".\"t\" (\"a\") VALUES (f())",
        ),
        (
            Postgres,
            "INSERT INTO \"public\".\"t\" (\"a\") VALUES (\"f\"(1))",
        ),
        (Postgres, "INSERT INTO t (a) SELECT public.f()"),
        (Postgres, "INSERT INTO t (a) VALUES (pg_catalog.numeric(1))"),
        (Postgres, "INSERT INTO t (a) VALUES (varying(1))"),
        (Postgres, "UPDATE t SET a = f()"),
        (Postgres, "UPDATE t SET a = 1 WHERE b = lower('X')"),
        (Postgres, "DELETE FROM t WHERE a = \"public\".\"f\"(1)"),
        (Postgres, "DELETE FROM t USING f() AS x WHERE t.a = x.a"),
        (
            Postgres,
            "MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN UPDATE SET b = f(s.b)",
        ),
        (MySql, "INSERT INTO `t` (`a`) VALUES (`db`.`f`())"),
        (MySql, "INSERT t (a) VALUES (f())"),
        (MySql, "REPLACE INTO `t` (`a`) VALUES (NOW())"),
        (MySql, "UPDATE `t` SET `a` = `f`(`a`)"),
        (Sqlite, "INSERT INTO t (a) VALUES (abs(-1))"),
    ];
    for (d, sql) in yes {
        assert!(dml_calls(d, sql), "{sql}");
    }
    let no = [
        (
            Postgres,
            "INSERT INTO \"public\".\"t\" (\"a\") VALUES (1), (2)",
        ),
        (Postgres, "INSERT INTO t AS x (a) VALUES (1::numeric(5, 2))"),
        (Postgres, "INSERT INTO t (a) VALUES (CAST(1 AS decimal(5)))"),
        (Postgres, "INSERT INTO t (a) VALUES (ARRAY[1]), (ROW(1, 2))"),
        (Postgres, "INSERT INTO t (a) VALUES ('f(1)')"),
        (
            Postgres,
            "UPDATE t SET a = 1 WHERE b IN (1, 2) AND NOT (c = 3)",
        ),
        (
            Postgres,
            "UPDATE t SET a = 1 WHERE EXISTS (SELECT 1 FROM u)",
        ),
        (Postgres, "DELETE FROM t WHERE a = ANY (ARRAY[1, 2])"),
        (
            Postgres,
            "INSERT INTO t (a) VALUES ('x'::character varying(10)::varchar(10))",
        ),
        (
            MySql,
            "INSERT INTO `t` (`a`) VALUES (1) AS new (a) ON DUPLICATE KEY UPDATE a = VALUES(a)",
        ),
        (MySql, "INSERT IGNORE INTO `t` (`a`) VALUES (1)"),
        (MySql, "INSERT LOW_PRIORITY `t` (`a`) VALUES (1)"),
        (Sqlite, "INSERT OR REPLACE INTO \"t\" (\"a\") VALUES (1)"),
        // Not a write: other rules decide these.
        (Postgres, "SELECT f()"),
        (
            Postgres,
            "CREATE TABLE \"t\" (\"id\" int DEFAULT nextval('s'))",
        ),
    ];
    for (d, sql) in no {
        assert!(!dml_calls(d, sql), "{sql}");
    }
    assert_ends_shapes_in_file(
        Postgres,
        "INSERT INTO \"public\".\"u\" (\"a\") VALUES (\"public\".\"f\"());",
    );
    assert_ends_shapes_in_file(Postgres, "UPDATE \"public\".\"t\" SET \"a\" = f(\"a\");");
    assert_ends_shapes_in_file(MySql, "DELETE FROM `t` WHERE `a` = `f`(1);");
    // A literal INSERT shown in full (a table the file did not make) does not end them.
    let dir = tempfile::tempdir().unwrap();
    let p = backup(
        &dir,
        Postgres,
        "CREATE TABLE \"public\".\"t\" (\"a\" int);\n\
         INSERT INTO \"public\".\"other\" (\"a\") VALUES (1);\n\
         INSERT INTO \"public\".\"t\" (\"a\") VALUES (2);\n",
    );
    let f = file_check(&config(Postgres), &p, false);
    assert_eq!(f.insert_count, 1);
}

/// R26 (3): triggers and rules run code on later writes, so they end shapes.
#[test]
fn triggers_and_rules_end_shapes() {
    let yes = [
        (
            Postgres,
            "CREATE TRIGGER \"x\" BEFORE INSERT ON \"public\".\"t\" FOR EACH ROW EXECUTE FUNCTION \"f\"()",
        ),
        (
            Postgres,
            "CREATE OR REPLACE TRIGGER x AFTER INSERT ON t FOR EACH STATEMENT EXECUTE FUNCTION f()",
        ),
        (
            Postgres,
            "CREATE CONSTRAINT TRIGGER x AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()",
        ),
        (Postgres, "CREATE RULE r AS ON INSERT TO t DO ALSO SELECT 1"),
        (
            Postgres,
            "CREATE OR REPLACE RULE r AS ON INSERT TO t DO INSTEAD NOTHING",
        ),
        (
            Postgres,
            "CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION f()",
        ),
        (
            MySql,
            "CREATE DEFINER=`root`@`localhost` TRIGGER `x` BEFORE INSERT ON `t` FOR EACH ROW SET NEW.a = 1",
        ),
        (
            MySql,
            "CREATE DEFINER = CURRENT_USER() TRIGGER `x` BEFORE INSERT ON `t` FOR EACH ROW SET NEW.a = 1",
        ),
        (
            Sqlite,
            "CREATE TEMP TRIGGER x AFTER INSERT ON t BEGIN DELETE FROM u; END",
        ),
    ];
    for (d, sql) in yes {
        assert!(ends_shapes(d, sql), "{sql}");
    }
    let no = [
        (
            Postgres,
            "CREATE FUNCTION \"billing\".\"touch\"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
        ),
        (Postgres, "CREATE INDEX \"trigger\" ON \"t\" (\"a\")"),
        (Postgres, "CREATE TABLE \"rule\" (\"trigger\" int)"),
    ];
    for (d, sql) in no {
        assert!(!ends_shapes(d, sql), "{sql}");
    }
    assert_ends_shapes_in_file(
        Postgres,
        "CREATE TRIGGER \"x\" BEFORE INSERT ON \"public\".\"t\" FOR EACH ROW EXECUTE FUNCTION \"public\".\"f\"();",
    );
    assert_ends_shapes_in_file(
        Postgres,
        "CREATE RULE \"r\" AS ON INSERT TO \"public\".\"t\" DO ALSO NOTHING;",
    );
}

/// R26 (4): statements that run a query start with `(`, TABLE or EXPLAIN, or fill a new
/// table from one.
#[test]
fn queries_end_shapes() {
    let yes = [
        (Postgres, "(SELECT f())"),
        (Postgres, "TABLE \"public\".\"v\""),
        (Postgres, "EXPLAIN ANALYZE SELECT f()"),
        (Postgres, "CREATE TABLE x AS SELECT f()"),
        (Postgres, "CREATE TEMP TABLE x AS TABLE y"),
        (
            Postgres,
            "CREATE TABLE IF NOT EXISTS x (a, b) AS VALUES (1, 2)",
        ),
        (MySql, "CREATE TABLE `x` (`a` int) SELECT `f`() AS `a`"),
        (MySql, "CREATE TABLE `x` (SELECT 1 AS `a`)"),
        (MySql, "EXPLAIN ANALYZE SELECT `f`()"),
        (Sqlite, "CREATE TABLE x AS SELECT 1"),
    ];
    for (d, sql) in yes {
        assert!(ends_shapes(d, sql), "{sql}");
    }
    let no = [
        (
            Postgres,
            "CREATE TABLE \"public\".\"t\" (\"id\" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL, \"b\" int GENERATED ALWAYS AS (\"id\" + 1) STORED)",
        ),
        (
            Postgres,
            "CREATE TABLE \"public\".\"p1\" PARTITION OF \"public\".\"p\" FOR VALUES FROM (1) TO (10)",
        ),
        (
            Postgres,
            "CREATE TABLE \"public\".\"t\" (\"a\" int) WITH (fillfactor = 70)",
        ),
        (
            MySql,
            "CREATE TABLE `t` (\n  `a` int NOT NULL,\n  `b` int GENERATED ALWAYS AS (`a` + 1) VIRTUAL,\n  PRIMARY KEY (`a`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        ),
        (MySql, "CREATE TABLE `t` LIKE `u`"),
    ];
    for (d, sql) in no {
        assert!(!ends_shapes(d, sql), "{sql}");
    }
    assert_ends_shapes_in_file(Postgres, "(SELECT 1);");
    assert_ends_shapes_in_file(Postgres, "CREATE TABLE \"public\".\"x\" AS SELECT 1;");
}

#[test]
fn header_labels_keep_dots_in_names() {
    assert_eq!(label_parts(MySql, None, "a.b"), ["a.b"]);
    assert_eq!(label_parts(Sqlite, None, "a.b"), ["a.b"]);
    assert_eq!(
        label_parts(Postgres, Some("billing"), "billing.a.b"),
        ["billing", "a.b"]
    );
    assert_eq!(
        label_parts(Postgres, Some("bill.ing"), "bill.ing.t"),
        ["bill.ing", "t"]
    );
    assert_eq!(label_parts(Postgres, None, "s.t"), ["s", "t"]);
}

#[test]
fn types_and_sequences_the_file_makes() {
    use crate::jobs::script::created_type_or_sequence as made;
    let name = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        made(Postgres, "CREATE TYPE billing.mood AS ENUM ('ok')"),
        Some((false, name(&["billing", "mood"])))
    );
    assert_eq!(
        made(
            Postgres,
            "CREATE SEQUENCE IF NOT EXISTS \"billing\".\"ticket_seq\" START 100"
        ),
        Some((true, name(&["billing", "ticket_seq"])))
    );
    assert_eq!(
        made(Postgres, "CREATE TEMP SEQUENCE s"),
        Some((true, name(&["s"])))
    );
    assert_eq!(made(Postgres, "CREATE TABLE t (id int)"), None);
    assert_eq!(made(MySql, "CREATE SEQUENCE s"), None);
}
