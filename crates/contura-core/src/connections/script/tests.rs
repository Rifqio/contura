use super::run::{Counts, left_open_text};
use super::scan::{CONFIRM_ITEM_BYTES, CONFIRM_ITEMS, LIST_BUDGET, LIST_CAP, SHOWN_BYTES};
use super::*;

fn write(dir: &tempfile::TempDir, body: &str) -> PathBuf {
    let p = dir.path().join("s.sql");
    std::fs::write(&p, body).unwrap();
    p
}

fn plan_of(p: &Path, kind: DialectKind) -> ScriptPlan {
    scan_path(p, kind, false, ScanMode::Plan).unwrap().plan
}

#[test]
fn scan_counts_lists_and_confirm_items() {
    let dir = tempfile::tempdir().unwrap();
    let p = write(
        &dir,
        "CREATE TABLE t (a int);\nGRANT SELECT ON t TO u;\nINSERT INTO t VALUES (1), (2);\n\
         INSERT INTO t SELECT 3;\nDROP DATABASE x;\n",
    );
    let s = scan_path(&p, DialectKind::Postgres, false, ScanMode::Plan).unwrap();
    let plan = &s.plan;
    assert_eq!(plan.statements, 3);
    assert_eq!((plan.creates, plan.inserts), (1, 2));
    assert_eq!(plan.skipped.len(), 1);
    assert_eq!(plan.refused.len(), 1);
    assert!(plan.has_ddl);
    assert!(plan.one_transaction);
    assert!(!plan.own_transactions);
    assert_eq!(plan.first.len(), 5);
    assert_eq!(plan.bytes, std::fs::metadata(&p).unwrap().len());
    assert_eq!(plan.sha256, hex(&s.sha));
    // The literal-rows INSERT is a shape; the INSERT ... SELECT is shown exactly.
    assert!(matches!(
        &plan.confirm[0],
        ConfirmItem::Exact { line: 1, .. }
    ));
    assert!(matches!(&plan.confirm[1], ConfirmItem::Shape { line: 3, shape } if shape.rows == 2));
    assert!(
        matches!(&plan.confirm[2], ConfirmItem::Exact { line: 4, text } if text == "INSERT INTO t SELECT 3")
    );
    assert_eq!(
        refusals(plan),
        ["Line 5: DROP DATABASE is not run from an import."]
    );
}

/// The start and the confirm need only the refusals and the flags: no other list.
#[test]
fn refusal_scan_builds_no_lists() {
    let dir = tempfile::tempdir().unwrap();
    let p = write(
        &dir,
        "CREATE TABLE t (a int);\nGRANT SELECT ON t TO u;\nINSERT INTO t VALUES (1);\nDROP DATABASE x;\n",
    );
    let plan = scan_path(&p, DialectKind::Postgres, false, ScanMode::Refusals)
        .unwrap()
        .plan;
    assert!(plan.first.is_empty());
    assert!(plan.confirm.is_empty());
    assert!(plan.skipped.is_empty());
    assert_eq!(plan.skipped_more, 1);
    assert_eq!(plan.refused.len(), 1);
    assert_eq!(plan.statements, 2);
}

#[test]
fn mysql_ddl_clears_one_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let p = write(&dir, "CREATE TABLE t (a int);\nINSERT INTO t VALUES (1);\n");
    assert!(!plan_of(&p, DialectKind::MySql).one_transaction);
    assert!(plan_of(&p, DialectKind::Sqlite).one_transaction);
    let p = write(&dir, "BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\n");
    let plan = plan_of(&p, DialectKind::Sqlite);
    assert!(plan.own_transactions);
    assert!(!plan.one_transaction);
}

#[test]
fn lists_are_capped_and_counted() {
    let dir = tempfile::tempdir().unwrap();
    let body = "DROP DATABASE x;\n".repeat(LIST_CAP + 2);
    let p = write(&dir, &body);
    let plan = plan_of(&p, DialectKind::MySql);
    assert_eq!(plan.refused.len(), LIST_CAP);
    assert_eq!(plan.refused_more, 2);
    let reasons = refusals(&plan);
    assert_eq!(reasons.len(), LIST_CAP + 1);
    assert_eq!(reasons.last().unwrap(), "2 more statements are refused.");
}

/// Q44 I1: 1 MiB statements (Contura's own SQL export cuts there) are held cut at 4 KB
/// in every list and page, and at 64 KB in the confirmation.
#[test]
fn big_statements_are_held_cut() {
    let dir = tempfile::tempdir().unwrap();
    let big = format!("SELECT '{}'", "x".repeat(1024 * 1024));
    let mut body = String::new();
    for _ in 0..20 {
        body.push_str(&big);
        body.push_str(";\nGRANT SELECT ON t TO u;\n");
    }
    let p = write(&dir, &body);
    let plan = plan_of(&p, DialectKind::Postgres);
    let shown_max = SHOWN_BYTES + 32;
    assert_eq!(plan.first.len(), 40);
    assert!(plan.first.iter().all(|s| s.text.len() <= shown_max));
    assert!(
        plan.first[0].text.ends_with("... (1021 KB more)"),
        "{}",
        &plan.first[0].text[4000..]
    );
    let held: usize = plan.first.iter().map(|s| s.text.len()).sum();
    assert!(held < LIST_BUDGET);
    for item in &plan.confirm {
        if let ConfirmItem::Exact { text, .. } = item {
            assert!(text.len() <= CONFIRM_ITEM_BYTES + 200);
        }
    }
    let ConfirmItem::Exact { text, .. } = &plan.confirm[0] else {
        panic!("not exact")
    };
    assert!(text.ends_with(
        "... (961 KB more, 1025 KB in all). The whole statement is bound to this file's hash."
    ));
    assert_eq!(confirm_text_of("SELECT 1"), "SELECT 1");
}

fn confirm_text_of(text: &str) -> String {
    super::scan::confirm_text(text)
}

/// Session-changing statements are listed in the confirmation past the first 200.
#[test]
fn session_statements_listed_past_200() {
    let dir = tempfile::tempdir().unwrap();
    let mut body = String::new();
    for i in 0..300 {
        body.push_str(&format!("INSERT INTO t VALUES ({i});\n"));
    }
    body.push_str("USE other;\nSELECT pg_catalog.set_config('search_path', '', false);\n");
    let p = write(&dir, &body);
    let plan = plan_of(&p, DialectKind::MySql);
    assert_eq!(plan.confirm.len(), CONFIRM_ITEMS + 2);
    assert_eq!(plan.confirm_more, 100);
    assert!(
        matches!(&plan.confirm[CONFIRM_ITEMS], ConfirmItem::Exact { line: 301, text } if text == "USE other")
    );
    assert!(matches!(
        &plan.confirm[CONFIRM_ITEMS + 1],
        ConfirmItem::Exact { line: 302, .. }
    ));
}

/// Q44 I3: the run reads the held handle up to the bytes the start checked.
#[test]
fn the_run_reader_stops_at_the_checked_size() {
    let dir = tempfile::tempdir().unwrap();
    let p = write(&dir, "SELECT 1;\nSELECT 2;\n");
    let file = File::open(&p).unwrap();
    let mut r = ScriptReader::from_file(&p, file, 10, DialectKind::Sqlite, false).unwrap();
    let mut texts = Vec::new();
    while let Some(s) = r.next_statement().unwrap() {
        texts.push(s.text);
    }
    assert_eq!(texts, ["SELECT 1"]);
    assert_eq!(r.bytes_read(), 10);
    use sha2::Digest;
    let want: [u8; 32] = sha2::Sha256::digest(b"SELECT 1;\n").into();
    assert_eq!(r.sha256(), Some(want));
}

fn facts(kind: DialectKind, sql: &str) -> (ScriptStatement, Facts) {
    let dir = tempfile::tempdir().unwrap();
    let p = write(&dir, &format!("{sql};\n"));
    let mut r = ScriptReader::open(&p, kind, false).unwrap();
    r.next_checked().unwrap().unwrap()
}

/// Q44 I2: the rows a file run as written keeps, statement by statement.
#[test]
fn counts_follow_autocommit_and_transactions() {
    let my = DialectKind::MySql;
    let run = |c: &mut Counts, sql: &str, rows: u64| {
        let (s, f) = facts(my, sql);
        c.mysql_commits_before(&f);
        c.ran_as_written(&s, rows, &f);
    };
    let mut c = Counts::default();
    run(&mut c, "SET autocommit = 0", 0);
    run(&mut c, "INSERT INTO t VALUES (1), (2)", 2);
    assert_eq!((c.committed, c.open), (0, 2));
    run(&mut c, "CREATE TABLE u (a int)", 0);
    assert_eq!((c.committed, c.open), (2, 0));
    run(&mut c, "INSERT INTO t VALUES (3)", 1);
    run(&mut c, "SET autocommit = 1", 0);
    assert_eq!((c.committed, c.open), (3, 0));
    run(&mut c, "INSERT INTO t VALUES (4)", 1);
    assert_eq!((c.committed, c.open), (4, 0));
    // LOCK TABLES commits and opens nothing: mysqldump's data stays in.
    run(&mut c, "LOCK TABLES t WRITE", 0);
    run(&mut c, "INSERT INTO t VALUES (5)", 1);
    run(&mut c, "UNLOCK TABLES", 0);
    assert_eq!((c.committed, c.open), (5, 0));
    assert!(!c.dirty);
    // An unmodelled control statement counts as opening a transaction.
    run(&mut c, "XA END 'x'", 0);
    run(&mut c, "INSERT INTO t VALUES (6)", 1);
    assert_eq!((c.committed, c.open), (5, 1));
    assert!(c.dirty);
    run(&mut c, "ROLLBACK", 0);
    assert_eq!((c.committed, c.open), (5, 0));
    assert!(!c.dirty);
    // Session settings in an open transaction lose nothing.
    run(&mut c, "BEGIN", 0);
    run(&mut c, "SET @a = 1", 0);
    assert!(!c.dirty);
    assert_eq!(
        left_open_text(3),
        "The file left a transaction open. Its 3 rows were rolled back."
    );
    assert_eq!(
        left_open_text(1),
        "The file left a transaction open. Its 1 row was rolled back."
    );
}

#[test]
fn the_fingerprint_binds_run_as_is_and_the_file() {
    let id = uuid::Uuid::from_u128(1);
    let file = FileIdentity {
        path: PathBuf::from("C:/in/a.sql"),
        bytes: 10,
        sha256: "ab".repeat(32),
    };
    let fp = |db: Option<&str>, as_is: bool, f: FileIdentity| {
        job_fingerprint(&script_job_plan(id, db.map(str::to_string), as_is, f)).unwrap()
    };
    let base = fp(Some("shop"), false, file.clone());
    assert_eq!(base, fp(Some("shop"), false, file.clone()));
    assert_ne!(base, fp(Some("shop"), true, file.clone()));
    assert_ne!(base, fp(Some("shop2"), false, file.clone()));
    let other = FileIdentity {
        sha256: "cd".repeat(32),
        ..file
    };
    assert_ne!(base, fp(Some("shop"), false, other));
}
