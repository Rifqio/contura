//! The output rail (R5): SQL blocks of an answer, labelled and flagged.

use contura_core::ai::rails::output::{Flag, SqlBlock, check_answer, fences};
use contura_core::model::DialectKind;
use contura_core::safety::StatementClass;

const PG: DialectKind = DialectKind::Postgres;
const MY: DialectKind = DialectKind::MySql;
const SL: DialectKind = DialectKind::Sqlite;

fn sql(body: &str) -> String {
    format!("Here:\n\n```sql\n{body}\n```\n")
}

fn one(answer: &str, dialect: DialectKind, action: &str, read_only: bool) -> SqlBlock {
    let mut blocks = check_answer(answer, Some(dialect), action, read_only);
    assert_eq!(blocks.len(), 1, "{blocks:?}");
    blocks.remove(0)
}

fn flags(block: &SqlBlock) -> Vec<Flag> {
    block
        .statements
        .iter()
        .flat_map(|s| s.flags.clone())
        .collect()
}

#[test]
fn semicolons_in_literals_do_not_split() {
    let b = one(
        &sql("select ';' as a; -- ;\nselect $$a;b$$;"),
        PG,
        "ask",
        false,
    );
    assert_eq!(b.statements.len(), 2);
    assert_eq!(b.label, "2 statements: 2 reads");
    assert_eq!(b.statements[0].text, "select ';' as a");
    assert_eq!(b.statements[1].text, "-- ;\nselect $$a;b$$");
    let b = one(&sql("SELECT 1"), PG, "ask", false);
    assert_eq!(b.label, "1 statement: 1 read");
}

#[test]
fn labels_count_writes() {
    let b = one(
        &sql("SELECT 1;\nDELETE FROM t WHERE id = 1;\nSELECT 2;"),
        PG,
        "ask",
        false,
    );
    assert_eq!(b.label, "3 statements: 2 reads, 1 write (DELETE)");
    assert_eq!(b.statements[1].class, StatementClass::Write);
    let b = one(
        &sql("UPDATE t SET a = 1 WHERE b;\nDELETE FROM t WHERE c;\nUPDATE s SET x = 2 WHERE y"),
        PG,
        "ask",
        false,
    );
    assert_eq!(b.label, "3 statements: 3 writes (UPDATE, DELETE)");
}

#[test]
fn no_where_flags() {
    let b = one(&sql("UPDATE t SET a = 1"), PG, "ask", false);
    assert_eq!(
        flags(&b),
        [Flag::NoWhere {
            verb: "UPDATE".into()
        }]
    );
    assert_eq!(
        b.label,
        "1 statement: 1 write (UPDATE). UPDATE without WHERE."
    );
}

#[test]
fn each_risky_function_flags() {
    let pg = [
        "pg_terminate_backend",
        "pg_cancel_backend",
        "set_config",
        "dblink",
        "dblink_exec",
        "lo_import",
        "lo_export",
        "pg_read_file",
        "pg_read_binary_file",
        "pg_ls_dir",
        "pg_sleep",
    ];
    for name in pg {
        let b = one(&sql(&format!("SELECT {name}(1)")), PG, "ask", false);
        assert_eq!(
            flags(&b),
            [Flag::RiskyFunction { name: name.into() }],
            "{name}"
        );
        assert!(
            b.label.ends_with(&format!("Calls {name}().")),
            "{}",
            b.label
        );
    }
    for name in ["LOAD_FILE", "SLEEP", "BENCHMARK"] {
        let b = one(&sql(&format!("SELECT {name}(1)")), MY, "ask", false);
        assert_eq!(
            flags(&b),
            [Flag::RiskyFunction {
                name: name.to_lowercase()
            }],
            "{name}"
        );
    }
    let b = one(&sql("SELECT load_extension('x')"), SL, "ask", false);
    assert_eq!(
        flags(&b),
        [Flag::RiskyFunction {
            name: "load_extension".into()
        }]
    );
    for (text, name) in [
        ("SELECT a FROM t INTO OUTFILE '/tmp/x'", "INTO OUTFILE"),
        ("SELECT a FROM t INTO DUMPFILE '/tmp/x'", "INTO DUMPFILE"),
    ] {
        let b = one(&sql(text), MY, "ask", false);
        assert_eq!(flags(&b), [Flag::RiskyFunction { name: name.into() }]);
        assert!(
            b.label
                .ends_with(&format!("Writes a file on the server ({name}).")),
            "{}",
            b.label
        );
    }
}

#[test]
fn unknown_function_flag() {
    let b = one(
        &sql("SELECT orders_purge(1), count(*) FROM t"),
        PG,
        "ask",
        false,
    );
    assert_eq!(
        flags(&b),
        [Flag::UnknownFunction {
            name: "orders_purge".into()
        }]
    );
    assert_eq!(
        b.label,
        "1 statement: 1 read. Calls orders_purge(): functions are not checked."
    );
    // Schema-qualified outside pg_catalog is never built in.
    let b = one(
        &sql("SELECT public.lower('A'), pg_catalog.lower('B')"),
        PG,
        "ask",
        false,
    );
    assert_eq!(
        flags(&b),
        [Flag::UnknownFunction {
            name: "public.lower".into()
        }]
    );
    // Built in on one Dialect only.
    assert!(
        flags(&one(
            &sql("SELECT group_concat(a) FROM t"),
            MY,
            "ask",
            false
        ))
        .is_empty()
    );
    assert_eq!(
        flags(&one(
            &sql("SELECT group_concat(a) FROM t"),
            PG,
            "ask",
            false
        )),
        [Flag::UnknownFunction {
            name: "group_concat".into()
        }]
    );
}

#[test]
fn write_in_explain_flags() {
    for action in ["explain", "optimize", "indexes"] {
        let b = one(
            &sql("SELECT 1;\nCREATE INDEX i ON t (a)"),
            PG,
            action,
            false,
        );
        assert_eq!(flags(&b), [Flag::WriteInReadAnswer], "{action}");
        assert_eq!(
            b.label,
            "2 statements: 1 read, 1 write (CREATE). This answer contains a write."
        );
    }
    let b = one(&sql("CREATE INDEX i ON t (a)"), PG, "ask", false);
    assert!(flags(&b).is_empty());
}

#[test]
fn read_only_label() {
    let b = one(
        &sql("SELECT 1; DELETE FROM t WHERE id = 2"),
        PG,
        "ask",
        true,
    );
    assert_eq!(flags(&b), [Flag::ReadOnlyConnection]);
    assert_eq!(
        b.label,
        "2 statements: 1 read, 1 write (DELETE). Read-only Connection: this will not run."
    );
    let b = one(&sql("SELECT 1"), PG, "ask", true);
    assert!(flags(&b).is_empty());
}

#[test]
fn untagged_sql_block_is_checked() {
    let answer = "Try:\n```\n  -- a note\nselect * from t\n```\nand\n```\nnot sql at all\n```\n";
    let blocks = check_answer(answer, Some(PG), "ask", false);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].fence, 0);
    assert_eq!(blocks[0].label, "1 statement: 1 read");
}

#[test]
fn dbml_block_is_not() {
    let answer = "```dbml\nTable t {\n  id int\n}\n```\n```python\nSELECT = 1\n```\n";
    assert!(check_answer(answer, Some(PG), "ask", false).is_empty());
}

#[test]
fn fences_count_every_block() {
    let answer = "```dbml\nTable t { id int }\n```\ntext\n````sql\nSELECT 1\n```\nSELECT 2\n````\n";
    let f = fences(answer);
    assert_eq!(f.len(), 2);
    assert_eq!(f[0].lang.as_deref(), Some("dbml"));
    assert_eq!(f[1].lang.as_deref(), Some("sql"));
    assert_eq!(f[1].body, "SELECT 1\n```\nSELECT 2");
    let blocks = check_answer(answer, Some(PG), "ask", false);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].fence, 1);
}

#[test]
fn unknown_dialect_still_flags_a_risky_function() {
    let blocks = check_answer(&sql("SELECT pg_sleep(1)"), None, "ask", false);
    assert_eq!(
        flags(&blocks[0]),
        [Flag::RiskyFunction {
            name: "pg_sleep".into()
        }]
    );
}

#[test]
fn unclosed_fence_counts_and_is_checked_when_complete() {
    let answer = "```sql\nSELECT 1";
    let f = fences(answer);
    assert_eq!(f.len(), 1);
    assert!(!f[0].closed);
    assert_eq!(check_answer(answer, Some(PG), "ask", false).len(), 1);
    assert!(
        contura_core::ai::rails::output::check_answer_with(answer, Some(PG), "ask", false, false)
            .is_empty()
    );
}

#[test]
fn serialized_shape() {
    let b = one(&sql("UPDATE t SET a = 1"), PG, "ask", false);
    let v = serde_json::to_value(&b).unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "fence": 0,
            "label": "1 statement: 1 write (UPDATE). UPDATE without WHERE.",
            "statements": [{
                "text": "UPDATE t SET a = 1",
                "class": "write",
                "flags": [{ "kind": "noWhere", "verb": "UPDATE" }]
            }],
            // The hash of the body checked, which the UI matches against the block's own text.
            "bodySha256": contura_core::ai::rails::output::sha256_hex("UPDATE t SET a = 1")
        })
    );
}

#[test]
fn untagged_values_table_describe_are_checked() {
    for body in ["VALUES (pg_sleep(1))", "TABLE orders", "DESCRIBE orders"] {
        let answer = format!("```\n{body}\n```\n");
        assert_eq!(
            check_answer(&answer, Some(PG), "ask", false).len(),
            1,
            "{body}"
        );
    }
}
