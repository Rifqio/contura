use super::*;
use crate::error::Error;
use crate::jobs::types::{ScriptAction, ScriptStatement, StatementKind};
use crate::safety::cases::CASES;
use crate::safety::{StatementClass, classify, statement_count};
use sha2::{Digest, Sha256};

const PG: DialectKind = DialectKind::Postgres;
const MY: DialectKind = DialectKind::MySql;
const SL: DialectKind = DialectKind::Sqlite;

fn split(d: DialectKind, text: &str) -> Vec<RawStatement> {
    let mut s = Splitter::new(d);
    let mut out = Vec::new();
    s.push(text, &mut out).unwrap();
    s.finish(&mut out).unwrap();
    out
}

fn split_by(d: DialectKind, parts: &[&str]) -> Vec<RawStatement> {
    let mut s = Splitter::new(d);
    let mut out = Vec::new();
    for p in parts {
        s.push(p, &mut out).unwrap();
    }
    s.finish(&mut out).unwrap();
    out
}

fn split_chars(d: DialectKind, text: &str) -> Vec<RawStatement> {
    let chars: Vec<String> = text.chars().map(String::from).collect();
    let parts: Vec<&str> = chars.iter().map(String::as_str).collect();
    split_by(d, &parts)
}

fn texts(v: &[RawStatement]) -> Vec<&str> {
    v.iter().map(|s| s.text.as_str()).collect()
}

fn lines(v: &[RawStatement]) -> Vec<u32> {
    v.iter().map(|s| s.line).collect()
}

fn file(dir: &tempfile::TempDir, name: &str, body: &[u8]) -> std::path::PathBuf {
    let p = dir.path().join(name);
    std::fs::write(&p, body).unwrap();
    p
}

fn read_all(r: &mut ScriptReader) -> Vec<ScriptStatement> {
    let mut v = Vec::new();
    while let Some(s) = r.next_statement().unwrap() {
        v.push(s);
    }
    v
}

/// Texts where reading backslashes the other way gives more pieces. `statement_count`
/// takes the larger reading; the splitter follows the Dialect's default reading, which
/// is what the server and its own client do. The whole piece still classifies as a
/// write, so the 5a check sees what the other reading would run.
const FLIPPED: &[(DialectKind, &str, usize)] = &[
    (PG, "SELECT 'x\\''; DELETE FROM t; --'", 1),
    (MY, "SELECT 'a\\'; DELETE FROM t; SELECT '", 1),
    (MY, "SELECT \"a\\\"; DELETE FROM t; SELECT \"", 1),
    (MY, "SELECT 'a\\'; DELETE FROM t; -- '", 1),
    (MY, "SELECT \"a\\\"; DELETE FROM t; -- \"", 1),
];

#[test]
fn splits_like_the_safety_lexer() {
    for (d, sql, class) in CASES {
        let pieces = split(*d, sql);
        let flipped = FLIPPED.iter().find(|(fd, fs, _)| fd == d && fs == sql);
        let want = flipped.map_or(statement_count(*d, sql), |f| f.2);
        assert_eq!(pieces.len(), want, "{d:?}: {sql:?} -> {:?}", texts(&pieces));
        let mut any_write = false;
        for p in &pieces {
            any_write |= classify(*d, &p.text) == StatementClass::Write;
            if flipped.is_none() {
                assert_eq!(statement_count(*d, &p.text), 1, "{d:?}: {:?}", p.text);
            }
        }
        let got = if any_write {
            StatementClass::Write
        } else {
            StatementClass::Read
        };
        assert_eq!(got, *class, "{d:?}: {sql:?}");
    }
    for (d, sql, n) in FLIPPED {
        assert!(
            CASES.iter().any(|(cd, cs, _)| cd == d && cs == sql),
            "{sql:?}"
        );
        assert!(statement_count(*d, sql) > *n, "{sql:?}");
    }
    assert_eq!(
        texts(&split(PG, "SELECT 1; DELETE FROM t")),
        ["SELECT 1", "DELETE FROM t"]
    );
    assert_eq!(
        texts(&split(MY, "-- c\nSELECT 1;  /* x */ ;; SELECT 2 -- end")),
        ["SELECT 1", "SELECT 2 -- end"]
    );
    assert_eq!(
        texts(&split(MY, "/*!50000 DELETE FROM t */")),
        ["/*!50000 DELETE FROM t */"]
    );
}

const EXTRA: &[(DialectKind, &str)] = &[
    (
        MY,
        "DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END ;;\ndelimiter ;\nSELECT 2;",
    ),
    (
        MY,
        "DELIMITER $$\nCREATE FUNCTION f() RETURNS INT RETURN 1$$\nDELIMITER ;\n",
    ),
    (
        MY,
        "SELECT 1 --\nSELECT 2;# x;\n/*!40101 SET a=1 */;\n/*M!100 SET b=2 */;",
    ),
    (MY, "SELECT 'it\\'s; x', \"q\\\"; y\", `a``;b`; SELECT 2"),
    (
        SL,
        "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO l VALUES (1); END; SELECT 1;",
    ),
    (SL, "SELECT [a;b], `c;d`, 'e;f' ; SELECT 2"),
    (
        PG,
        "CREATE FUNCTION f() RETURNS int AS $b$ SELECT 1; $b$ LANGUAGE sql; SELECT $x$;$x$;",
    ),
    (
        PG,
        "CREATE PROCEDURE p() LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT 3",
    ),
    (
        PG,
        "SELECT E'a\\';b'; SELECT 'c\\'; SELECT 1 /* a /* b; */ c; */; x$y$;z",
    ),
    (
        PG,
        "COPY t (a) FROM stdin;\n1\tx;y\n\\.\nSELECT 1;\n\\connect other\nSELECT 2;",
    ),
    (PG, "SELECT 'é;ü', $€$ x $€$; SELECT 'ünï' -- ;\n; SELECT 3"),
];

#[test]
fn chunk_boundary_anywhere() {
    for (d, sql, _) in CASES {
        assert_eq!(split_chars(*d, sql), split(*d, sql), "{d:?}: {sql:?}");
    }
    for (d, sql) in EXTRA {
        let whole = split(*d, sql);
        assert_eq!(split_chars(*d, sql), whole, "{d:?}: {sql:?}");
        for (i, _) in sql.char_indices().skip(1) {
            assert_eq!(
                split_by(*d, &[&sql[..i], &sql[i..]]),
                whole,
                "{d:?}: {sql:?} at {i}"
            );
        }
    }
}

/// Random texts built from quoting and comment pieces (no backslashes, so both
/// readings agree) split exactly where the 5a lexer splits, whole or cut anywhere.
#[test]
fn random_texts_split_like_the_lexer() {
    const PIECES: &[&str] = &[
        "SELECT", " ", ";", "'", "\"", "`", "[", "]", "--", "-", "#", "/*", "*/", "/*!", "/*M!",
        "$$", "$a$", "$", "E", "\n", "(", ")", "x", "1", "*", "/", "M", "!",
    ];
    let mut seed: u64 = 0x5eed;
    let mut next = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as usize
    };
    for _ in 0..3000 {
        let len = 1 + next() % 14;
        let text: String = (0..len).map(|_| PIECES[next() % PIECES.len()]).collect();
        for d in [PG, MY, SL] {
            let whole = split(d, &text);
            assert_eq!(whole.len(), statement_count(d, &text), "{d:?}: {text:?}");
            let cut = next() % (text.len() + 1);
            assert_eq!(
                split_by(d, &[&text[..cut], &text[cut..]]),
                whole,
                "{d:?}: {text:?}"
            );
        }
    }
}

/// A DELIMITER script, as a Backup or mysqldump writes it, runs in the editor as the same
/// statements this reader gives Restore and SQL file import: a routine or compound statement
/// a custom delimiter ends is sent whole, its `;`s included, by both. (Any other chunk the
/// reader sends whole, as the mysql client does, and the editor splits on `;`.)
#[test]
fn mysql_delimiter_scripts_split_as_the_editor_runs_them() {
    let scripts = [
        "DELIMITER ;;\nCREATE PROCEDURE `p`() BEGIN SELECT 1; END;;\nDELIMITER ;\nSELECT 2;\n",
        "DELIMITER ;;\nCREATE FUNCTION `f`() RETURNS int\n    DETERMINISTIC\nRETURN 1;;\nDELIMITER ;\n",
        "DELIMITER ;;\n/*!50003 CREATE*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END */;;\nDELIMITER ;\nINSERT INTO t VALUES (1);",
        "DROP PROCEDURE IF EXISTS p;\nDELIMITER ;;\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 'a;;b';\nEND ;;\nDELIMITER ;\nCALL p();\ndelimiter //\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END//\nDELIMITER ;\n",
        "  delimiter $$\nSELECT '$$', `a$$b` -- $$\n$$\nDELIMITER ;\nSELECT 3;",
        "DELIMITER $$\nCREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW IF NEW.a > 0 THEN SET NEW.b = 1; DELETE FROM log WHERE id < 5; END IF$$\nDELIMITER ;\n",
        "DELIMITER //\nBEGIN NOT ATOMIC DELETE FROM t WHERE a=1; SELECT 1; END//\nDELIMITER ;\n",
        // `--` starts a comment only before an ASCII blank or control character.
        "SELECT 1 --\u{a0}x; SELECT 2;\nSELECT 3 --\u{1}x; SELECT 4\n;",
    ];
    for sql in scripts {
        let read = split(MY, sql);
        let editor: Vec<&str> = crate::safety::split_statements(MY, sql)
            .into_iter()
            .map(|r| &sql[r])
            .collect();
        assert_eq!(texts(&read), editor, "{sql:?}");
    }
}

#[test]
fn mysql_delimiter_routines() {
    let sql = "DROP PROCEDURE IF EXISTS p;\n\
               DELIMITER ;;\n\
               CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 'a;;b';\nEND ;;\n\
               DELIMITER ;\n\
               CALL p();\n\
               delimiter //\n\
               CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END//\n\
               DELIMITER ;\n";
    let got = split(MY, sql);
    assert_eq!(
        texts(&got),
        [
            "DROP PROCEDURE IF EXISTS p",
            "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 'a;;b';\nEND",
            "CALL p()",
            "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END",
        ]
    );
    assert_eq!(lines(&got), [1, 3, 9, 11]);

    // mysqldump's trigger form, with the routine inside executable comments.
    let dump = "DELIMITER ;;\n/*!50003 CREATE*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END */;;\nDELIMITER ;\nINSERT INTO t VALUES (1);";
    let got = split(MY, dump);
    assert_eq!(got.len(), 2, "{:?}", texts(&got));
    assert!(got[0].text.ends_with("END */"));
    assert_eq!(got[1].text, "INSERT INTO t VALUES (1)");

    // A statement still open when DELIMITER comes is ended there, as the client does.
    assert_eq!(
        texts(&split(MY, "SELECT 1\nDELIMITER //\nSELECT 2//")),
        ["SELECT 1", "SELECT 2"]
    );
    // The argument may be quoted; the rest of the line is ignored.
    assert_eq!(
        texts(&split(MY, "DELIMITER '$$' x\nSELECT 1$$SELECT 2$$")),
        ["SELECT 1", "SELECT 2"]
    );
    // DELIMITER is a MySQL client command only.
    assert_eq!(
        texts(&split(PG, "DELIMITER ;;\nSELECT 1;")),
        ["DELIMITER", "SELECT 1"]
    );

    let mut s = Splitter::new(MY);
    let mut out = Vec::new();
    let err = s
        .push("SELECT 1;\nDELIMITER\n", &mut out)
        .and_then(|_| s.finish(&mut out));
    assert!(
        matches!(err, Err(Error::File(m)) if m == "Line 2: DELIMITER needs a delimiter after it.")
    );
    let mut s = Splitter::new(MY);
    let err = s
        .push("DELIMITER \\\\\n", &mut out)
        .and_then(|_| s.finish(&mut out));
    assert!(
        matches!(err, Err(Error::File(m)) if m == "Line 1: a DELIMITER cannot hold a backslash.")
    );
}

#[test]
fn sqlite_trigger_body() {
    let sql = "CREATE TABLE t (a);\n\
               CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n\
                 INSERT INTO log VALUES (new.a);\n\
                 UPDATE t SET a = CASE WHEN a > 1 THEN 1 ELSE 0 END;\n\
               END;\n\
               CREATE TEMP TRIGGER IF NOT EXISTS t2 AFTER DELETE ON t BEGIN DELETE FROM log; END;\n\
               INSERT INTO t VALUES (1);";
    let got = split(SL, sql);
    assert_eq!(got.len(), 4, "{:?}", texts(&got));
    assert!(got[1].text.starts_with("CREATE TRIGGER tr"));
    assert!(got[1].text.ends_with("ELSE 0 END;\nEND"));
    assert!(got[2].text.ends_with("DELETE FROM log; END"));
    assert_eq!(lines(&got), [1, 2, 6, 7]);
    // Other Dialects do not keep BEGIN ... END together.
    assert_eq!(split(PG, "BEGIN; SELECT 1; END;").len(), 3);
}

#[test]
fn pg_dollar_quoted_function() {
    let sql = "CREATE FUNCTION f() RETURNS int AS $body$\nBEGIN\n  RETURN 1; -- ;\nEND;\n$body$ LANGUAGE plpgsql;\n\
               SELECT f();\n\
               CREATE OR REPLACE PROCEDURE p() LANGUAGE sql BEGIN ATOMIC INSERT INTO t VALUES (1); SELECT CASE WHEN true THEN 1 END; END;\n\
               DO $$ BEGIN PERFORM 1; END $$;\n\
               SELECT a$b$c, $1 FROM t;";
    let got = split(PG, sql);
    assert_eq!(got.len(), 5, "{:?}", texts(&got));
    assert!(got[0].text.ends_with("$body$ LANGUAGE plpgsql"));
    assert_eq!(got[1].text, "SELECT f()");
    assert!(got[2].text.ends_with("THEN 1 END; END"));
    assert_eq!(got[3].text, "DO $$ BEGIN PERFORM 1; END $$");
    assert_eq!(got[4].text, "SELECT a$b$c, $1 FROM t");
}

#[test]
fn mysql_executable_comment_is_a_write() {
    let dir = tempfile::tempdir().unwrap();
    let p = file(
        &dir,
        "d.sql",
        b"/*!40101 SET NAMES utf8mb4 */;\n/*!40000 ALTER TABLE `t` DISABLE KEYS */;\nSELECT 1;\n",
    );
    let all = read_all(&mut ScriptReader::open(&p, MY, false).unwrap());
    let classes: Vec<_> = all.iter().map(|s| s.class).collect();
    assert_eq!(
        classes,
        [
            StatementClass::Write,
            StatementClass::Write,
            StatementClass::Read
        ]
    );
    assert_eq!(all[0].text, "/*!40101 SET NAMES utf8mb4 */");
    // The server runs what is inside, so the lists look inside too.
    assert_eq!(
        statement_action(MY, "/*!40000 DROP DATABASE x */", true),
        ScriptAction::Refuse {
            reason: "DROP DATABASE is not run from an import.".into()
        }
    );
    assert!(matches!(
        statement_action(MY, "/*!50003 GRANT ALL ON *.* TO u */", false),
        ScriptAction::Skip { .. }
    ));
}

#[test]
fn statement_over_limit() {
    let dir = tempfile::tempdir().unwrap();
    let big = format!("SELECT 1;\n\nSELECT '{}';\nSELECT 2;", "x".repeat(2000));
    let p = file(&dir, "big.sql", big.as_bytes());
    let mut r = ScriptReader::open(&p, PG, false).unwrap().with_limit(1024);
    assert_eq!(r.next_statement().unwrap().unwrap().text, "SELECT 1");
    let err = r.next_statement().unwrap_err();
    assert!(
        matches!(&err, Error::File(m) if m == "Line 3: one statement is larger than 1 KB."),
        "{err:?}"
    );

    // A statement that never ends stops the read before the file is held.
    let open = format!("SELECT 1;\nSELECT '{}", "x".repeat(300_000));
    let p = file(&dir, "open.sql", open.as_bytes());
    let mut r = ScriptReader::open(&p, PG, false).unwrap().with_limit(1024);
    r.next_statement().unwrap();
    let err = r.next_statement().unwrap_err();
    assert!(
        matches!(&err, Error::File(m) if m == "Line 2: one statement is larger than 1 KB."),
        "{err:?}"
    );
    assert!(r.bytes_read() < 200_000, "read {}", r.bytes_read());

    assert_eq!(limit_text(MAX_STATEMENT_BYTES), "16 MB");
}

#[test]
fn line_numbers() {
    let sql = "\n\n-- c\nSELECT 1;\n  SELECT\n2; SELECT 3;\r\n/* a\nb */ SELECT 4";
    let got = split(PG, sql);
    assert_eq!(
        texts(&got),
        ["SELECT 1", "SELECT\n2", "SELECT 3", "SELECT 4"]
    );
    assert_eq!(lines(&got), [4, 5, 6, 8]);

    let dir = tempfile::tempdir().unwrap();
    // A statement wider than the read buffer, with multi-byte text across the cut.
    let wide = format!("SELECT 1;\n\nSELECT '{}';\nSELECT 3;", "é".repeat(40_000));
    let p = file(&dir, "w.sql", format!("\u{feff}{wide}").as_bytes());
    let all = read_all(&mut ScriptReader::open(&p, MY, false).unwrap());
    let idx: Vec<_> = all.iter().map(|s| (s.index, s.line)).collect();
    assert_eq!(idx, [(0, 1), (1, 3), (2, 4)]);
    assert_eq!(all[1].text.chars().filter(|c| *c == 'é').count(), 40_000);

    let p = file(&dir, "bad.sql", b"SELECT 1;\nSELECT '\xff';");
    let mut r = ScriptReader::open(&p, MY, false).unwrap();
    let err = loop {
        match r.next_statement() {
            Ok(Some(_)) => {}
            Ok(None) => panic!("not refused"),
            Err(e) => break e,
        }
    };
    assert!(
        matches!(&err, Error::File(m) if m == "Line 2 is not UTF-8. Save the file as UTF-8."),
        "{err:?}"
    );
}

fn skip(word: &str) -> ScriptAction {
    ScriptAction::Skip {
        reason: format!("{word} is skipped unless Run as is is ticked."),
    }
}

fn refuse(what: &str) -> ScriptAction {
    let fix = if what == "COPY FROM STDIN" {
        " Make the dump with pg_dump --inserts, which writes INSERT statements."
    } else {
        ""
    };
    ScriptAction::Refuse {
        reason: format!("{what} is not run from an import.{fix}"),
    }
}

const SKIPPED: &[(DialectKind, &str, &str)] = &[
    (PG, "GRANT SELECT ON t TO u", "GRANT"),
    (MY, "revoke all on *.* from u", "REVOKE"),
    (MY, "CREATE USER 'u'@'%' IDENTIFIED BY 'x'", "CREATE USER"),
    (MY, "ALTER USER u ACCOUNT LOCK", "ALTER USER"),
    (MY, "DROP USER IF EXISTS u", "DROP USER"),
    (PG, "CREATE ROLE r LOGIN", "CREATE ROLE"),
    (PG, "ALTER ROLE r SET search_path = a", "ALTER ROLE"),
    (PG, "DROP ROLE IF EXISTS r", "DROP ROLE"),
    (MY, "SET GLOBAL max_connections = 10", "SET GLOBAL"),
    (MY, "SET @@GLOBAL.max_connections = 10", "SET GLOBAL"),
    (MY, "SET SESSION a = 1, GLOBAL b = 2", "SET GLOBAL"),
    (MY, "SET PERSIST max_connections = 10", "SET PERSIST"),
    (MY, "SET PERSIST_ONLY max_connections = 10", "SET PERSIST"),
];

const REFUSED: &[(DialectKind, &str, &str)] = &[
    (PG, "DROP DATABASE shop", "DROP DATABASE"),
    (MY, "DROP SCHEMA IF EXISTS shop", "DROP DATABASE"),
    (PG, "\\connect other", "A psql meta-command"),
    (PG, "COPY public.t (a, b) FROM stdin", "COPY FROM STDIN"),
    (PG, "COPY t FROM PROGRAM 'cat /etc/passwd'", "COPY PROGRAM"),
    (PG, "COPY (SELECT 1) TO PROGRAM 'x'", "COPY PROGRAM"),
    (MY, "LOAD DATA LOCAL INFILE 'x' INTO TABLE t", "LOAD DATA"),
    (SL, "ATTACH DATABASE 'x.db' AS x", "ATTACH"),
    (
        MY,
        "SELECT * FROM t INTO OUTFILE '/tmp/x'",
        "SELECT INTO OUTFILE",
    ),
    (
        MY,
        "SELECT a INTO DUMPFILE '/tmp/x' FROM t",
        "SELECT INTO OUTFILE",
    ),
    (MY, "SHUTDOWN", "SHUTDOWN"),
];

const RUN: &[(DialectKind, &str)] = &[
    (PG, "CREATE TABLE users (a int)"),
    (MY, "INSERT INTO grants VALUES (1)"),
    (PG, "SELECT * INTO outfile FROM t"),
    (PG, "DROP SCHEMA s"),
    (MY, "SET NAMES utf8mb4"),
    (MY, "SET @a = 1"),
    (PG, "COPY t TO STDOUT"),
    (MY, "ATTACH x"),
    (SL, "SELECT 1"),
    (PG, "ANALYZE t"),
    (MY, "DROP TABLE users"),
];

#[test]
fn skip_and_refuse_lists() {
    for (d, sql, word) in SKIPPED {
        assert_eq!(statement_action(*d, sql, false), skip(word), "{sql}");
    }
    for (d, sql, what) in REFUSED {
        assert_eq!(statement_action(*d, sql, false), refuse(what), "{sql}");
    }
    for (d, sql) in RUN {
        assert_eq!(statement_action(*d, sql, false), ScriptAction::Run, "{sql}");
    }
}

#[test]
fn run_as_is_unskips_first_group_only() {
    for (d, sql, _) in SKIPPED {
        assert_eq!(statement_action(*d, sql, true), ScriptAction::Run, "{sql}");
    }
    for (d, sql, what) in REFUSED {
        assert_eq!(statement_action(*d, sql, true), refuse(what), "{sql}");
    }
    let dir = tempfile::tempdir().unwrap();
    let p = file(
        &dir,
        "g.sql",
        b"GRANT SELECT ON t TO u;\nSELECT 1;\nDROP DATABASE d;",
    );
    for run_as_is in [false, true] {
        let all = read_all(&mut ScriptReader::open(&p, PG, run_as_is).unwrap());
        let flags: Vec<_> = all.iter().map(|s| s.run_as_is).collect();
        assert_eq!(flags, [run_as_is, false, false]);
        assert_eq!(all[0].action == ScriptAction::Run, run_as_is);
        assert!(matches!(all[2].action, ScriptAction::Refuse { .. }));
    }
}

#[test]
fn own_transaction_control() {
    let yes: &[(DialectKind, &str)] = &[
        (PG, "BEGIN"),
        (PG, "begin transaction isolation level serializable"),
        (PG, "COMMIT"),
        (PG, "END"),
        (PG, "ABORT"),
        (PG, "ROLLBACK"),
        (MY, "START TRANSACTION"),
        (MY, "LOCK TABLES t WRITE"),
        (MY, "UNLOCK TABLES"),
        (MY, "SET autocommit = 1"),
        (SL, "BEGIN IMMEDIATE"),
        (SL, "END TRANSACTION"),
        (MY, "-- x\nCOMMIT"),
    ];
    let no: &[(DialectKind, &str)] = &[
        (PG, "SELECT 1"),
        (PG, "LOCK TABLE t"),
        (PG, "ROLLBACK TO SAVEPOINT s"),
        (SL, "SAVEPOINT s"),
        (MY, "CREATE TABLE begin_log (a int)"),
        (MY, "INSERT INTO t VALUES ('COMMIT')"),
    ];
    for (d, sql) in yes {
        assert!(is_transaction_control(*d, sql), "{sql}");
    }
    for (d, sql) in no {
        assert!(!is_transaction_control(*d, sql), "{sql}");
    }

    // Q28: one transaction unless the file manages its own, or MySQL DDL commits.
    let dir = tempfile::tempdir().unwrap();
    let cases: &[(DialectKind, &str, bool, bool)] = &[
        (
            PG,
            "CREATE TABLE t (a int); INSERT INTO t VALUES (1);",
            false,
            true,
        ),
        (PG, "BEGIN; INSERT INTO t VALUES (1); COMMIT;", true, false),
        (
            MY,
            "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);",
            false,
            true,
        ),
        (
            MY,
            "CREATE TABLE t (a int); INSERT INTO t VALUES (1);",
            false,
            false,
        ),
        (
            MY,
            "GRANT ALL ON *.* TO u; INSERT INTO t VALUES (1);",
            false,
            true,
        ),
        (
            MY,
            "LOCK TABLES t WRITE; INSERT INTO t VALUES (1); UNLOCK TABLES;",
            true,
            false,
        ),
        (
            SL,
            "CREATE TABLE t (a); INSERT INTO t VALUES (1);",
            false,
            true,
        ),
    ];
    for (d, sql, own, one) in cases {
        let p = file(&dir, "t.sql", sql.as_bytes());
        let mut r = ScriptReader::open(&p, *d, false).unwrap();
        read_all(&mut r);
        assert_eq!(r.own_transactions(), *own, "{sql}");
        assert_eq!(r.one_transaction(), *one, "{sql}");
    }
    assert!(ends_transaction(MY, "ALTER TABLE t ADD b int"));
    assert!(!ends_transaction(PG, "ALTER TABLE t ADD b int"));
}

#[test]
fn statement_kinds() {
    let cases: &[(DialectKind, &str, StatementKind)] = &[
        (PG, "CREATE TABLE t (a int)", StatementKind::Create),
        (PG, "-- c\ncreate index i on t (a)", StatementKind::Create),
        (MY, "INSERT INTO t VALUES (1)", StatementKind::Insert),
        (MY, "REPLACE INTO t VALUES (1)", StatementKind::Insert),
        (
            SL,
            "insert or ignore into t values (1)",
            StatementKind::Insert,
        ),
        (
            MY,
            "/*!50003 CREATE*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1 */",
            StatementKind::Create,
        ),
        (PG, "UPDATE t SET a = 1", StatementKind::Other),
        (
            PG,
            "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
            StatementKind::Other,
        ),
    ];
    for (d, sql, k) in cases {
        assert_eq!(statement_kind(*d, sql), *k, "{sql}");
    }
}

#[test]
fn insert_shape_only_for_literal_rows() {
    let s = insert_shape(
        MY,
        "INSERT INTO t (a, b) VALUES (1, 'x'),\n(NULL, -2.5e3), (3,'c'),(4,'d'),(5,'e')",
    )
    .unwrap();
    assert_eq!(s.head, "INSERT INTO t (a, b) VALUES");
    assert_eq!(
        s.first_rows,
        ["(1, 'x')", "(NULL, -2.5e3)", "(3,'c')", "(4,'d')"]
    );
    assert_eq!((s.rows, s.rows_per_statement, s.statements), (5, 5, 1));

    let some: &[(DialectKind, &str)] = &[
        (
            PG,
            "INSERT INTO public.t (a) OVERRIDING SYSTEM VALUE VALUES ('1'::int), (CAST('2' AS bigint)), (decode('00ff', 'hex')), (E'a\\'b'), ('NaN'::float8), (TRUE), ('2024-01-01'::timestamp with time zone), ('{1,2}'::int[]), ('x'::character varying(10))",
        ),
        (
            PG,
            "insert into \"Odd Name\" values ($$a;b$$, DATE '2024-01-01', -1, +2, .5)",
        ),
        (
            MY,
            "INSERT INTO `t` (`a`) VALUES (_utf8mb4 X'41'),(0x00ff),(ST_GeomFromText('POINT(1 1)', 4326)),(\"q\"), (b'01')",
        ),
        (MY, "INSERT IGNORE INTO shop.t VALUES (1)"),
        (
            SL,
            "INSERT INTO \"t\" VALUES (X'00', 1, CAST(X'4100' AS TEXT), NULL)",
        ),
        (SL, "INSERT OR REPLACE INTO [t] VALUES (1)"),
    ];
    for (d, sql) in some {
        assert!(insert_shape(*d, sql).is_some(), "{sql}");
    }
    let none: &[(DialectKind, &str)] = &[
        (PG, "INSERT INTO t SELECT * FROM s"),
        (PG, "INSERT INTO t VALUES (now())"),
        (PG, "INSERT INTO t VALUES (nextval('s'))"),
        (PG, "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING"),
        (PG, "INSERT INTO t VALUES (1) RETURNING a"),
        (PG, "INSERT INTO t VALUES (DEFAULT)"),
        (PG, "INSERT INTO t VALUES ((SELECT 1))"),
        (PG, "INSERT INTO t VALUES (1 + 2)"),
        (PG, "INSERT INTO t VALUES ('a'::text || 'b')"),
        (PG, "INSERT INTO t DEFAULT VALUES"),
        (PG, "INSERT INTO t VALUES (a)"),
        (PG, "UPDATE t SET a = 1"),
        (PG, "WITH x AS (SELECT 1) INSERT INTO t VALUES (1)"),
        (MY, "INSERT INTO t SET a = 1"),
        (MY, "INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2"),
        (MY, "INSERT INTO t VALUES (1), (SLEEP(5))"),
        (SL, "INSERT INTO t VALUES (random())"),
    ];
    for (d, sql) in none {
        assert_eq!(insert_shape(*d, sql), None, "{sql}");
    }
}

#[test]
fn contura_backup_header() {
    assert!(is_contura_backup(
        "-- Contura backup, format 1, MySQL, shop"
    ));
    assert!(is_contura_backup("\u{feff}-- Contura backup, format 2"));
    assert!(!is_contura_backup("-- Contura export of t for MySQL"));
    assert!(!is_contura_backup("--Contura backup, format 1"));
    assert!(!is_contura_backup("SELECT 1"));

    let dir = tempfile::tempdir().unwrap();
    let p = file(
        &dir,
        "b.sql",
        b"-- Contura backup, format 1\nCREATE TABLE t (a int);\n",
    );
    assert!(ScriptReader::open(&p, PG, false).unwrap().contura_backup());
    let s = crate::jobs::formats::inspect(&p, None).unwrap();
    assert_eq!(s.format, crate::jobs::types::Format::Sql);
    assert!(s.contura_backup);
    let p = file(
        &dir,
        "e.sql",
        b"-- Contura export of t\nINSERT INTO t VALUES (1);\n",
    );
    assert!(!ScriptReader::open(&p, PG, false).unwrap().contura_backup());
    assert!(
        !crate::jobs::formats::inspect(&p, None)
            .unwrap()
            .contura_backup
    );
}

#[test]
fn sha256_of_whole_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut body = String::new();
    for i in 0..20_000 {
        body.push_str(&format!("INSERT INTO t VALUES ({i}, 'row {i}');\n"));
    }
    let p = file(&dir, "h.sql", body.as_bytes());
    let want: [u8; 32] = Sha256::digest(body.as_bytes()).into();

    let mut r = ScriptReader::open(&p, SL, false).unwrap();
    assert_eq!(r.sha256(), None);
    r.next_statement().unwrap();
    assert!(r.bytes_read() < body.len() as u64);
    assert_eq!(r.finish().unwrap(), want);

    let mut r = ScriptReader::open(&p, SL, false).unwrap();
    assert_eq!(read_all(&mut r).len(), 20_000);
    assert_eq!(r.sha256(), Some(want));
    assert_eq!(r.bytes_read(), body.len() as u64);
    assert_eq!(r.finish().unwrap(), want);
}

#[test]
fn copy_data_and_meta_commands() {
    let sql = "COPY t (a) FROM stdin;\n1\tx;y\n2\t'z\n\\.\nSELECT 1;\n\\connect other\nSELECT 2;";
    let got = split(PG, sql);
    assert_eq!(
        texts(&got),
        [
            "COPY t (a) FROM stdin",
            "SELECT 1",
            "\\connect other",
            "SELECT 2"
        ]
    );
    assert_eq!(lines(&got), [1, 5, 6, 7]);
    // A backslash line is a meta line only where a statement starts (Q37); inside one it
    // stays part of it, and the server rejects it.
    assert_eq!(
        texts(&split(PG, "SELECT 1\n\\g\nSELECT 2;\n\\x\n")),
        ["SELECT 1\n\\g\nSELECT 2", "\\x"]
    );
}

fn read_file(d: DialectKind, body: &str) -> Vec<ScriptStatement> {
    let dir = tempfile::tempdir().unwrap();
    let p = file(&dir, "f.sql", body.as_bytes());
    read_all(&mut ScriptReader::open(&p, d, false).unwrap())
}

/// Q37 I1: a statement the splitter keeps together can hold several statements the
/// server runs; the lists look at every one of them, under both backslash readings.
#[test]
fn lists_see_every_piece() {
    let cases: &[(DialectKind, &str, ScriptAction)] = &[
        (
            MY,
            "DELIMITER //\nSELECT 1; DROP DATABASE prod//\n",
            refuse("DROP DATABASE"),
        ),
        (
            MY,
            "/*!40000 SELECT 1; DROP DATABASE prod */;\n",
            refuse("DROP DATABASE"),
        ),
        (
            PG,
            "CREATE FUNCTION begin() RETURNS int LANGUAGE sql RETURN 1; COPY (SELECT 1) TO PROGRAM 'calc';\n",
            refuse("COPY PROGRAM"),
        ),
        (
            MY,
            "/*!50003 SELECT 1; GRANT ALL ON *.* TO u */;\n",
            skip("GRANT"),
        ),
        // Only the other backslash reading sees the second statement.
        (
            MY,
            "SELECT 'a\\'; DROP DATABASE prod; -- ';\n",
            refuse("DROP DATABASE"),
        ),
    ];
    for (d, body, want) in cases {
        let all = read_file(*d, body);
        assert_eq!(all.len(), 1, "{body:?}: {:?}", all);
        assert_eq!(&all[0].action, want, "{body:?}");
    }
    // The strictest action wins.
    assert_eq!(
        statement_action(MY, "GRANT ALL ON *.* TO u; DROP DATABASE prod", false),
        refuse("DROP DATABASE")
    );
}

/// Q37 I2: an INSERT that another backslash reading splits is shown exactly.
#[test]
fn insert_shape_none_when_other_reading_splits() {
    let cases: &[(DialectKind, &str)] = &[
        (MY, "INSERT INTO t VALUES ('a\\'); DELETE FROM t; -- ')"),
        (PG, "INSERT INTO t VALUES ('x\\''); DELETE FROM t; --')"),
    ];
    for (d, sql) in cases {
        assert!(statement_count(*d, sql) > 1, "{sql}");
        assert_eq!(insert_shape(*d, sql), None, "{sql}");
    }
    // A backslash that both readings keep in one string is still a shape.
    assert!(insert_shape(MY, "INSERT INTO t VALUES ('a\\\\b')").is_some());
    assert!(insert_shape(PG, "INSERT INTO t VALUES ('a\\b')").is_some());
}

mod alloc_count {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! {
        static NOW: Cell<isize> = const { Cell::new(0) };
        static PEAK: Cell<isize> = const { Cell::new(0) };
    }

    /// Counts each thread's live heap bytes and their peak.
    pub struct Counting;

    fn add(n: isize) {
        let _ = NOW.try_with(|now| {
            let v = now.get() + n;
            now.set(v);
            let _ = PEAK.try_with(|peak| {
                if v > peak.get() {
                    peak.set(v);
                }
            });
        });
    }

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let p = unsafe { System.alloc(l) };
            if !p.is_null() {
                add(l.size() as isize);
            }
            p
        }

        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            let p = unsafe { System.alloc_zeroed(l) };
            if !p.is_null() {
                add(l.size() as isize);
            }
            p
        }

        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            unsafe { System.dealloc(p, l) };
            add(-(l.size() as isize));
        }

        unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
            let q = unsafe { System.realloc(p, l, new) };
            if !q.is_null() {
                add(new as isize - l.size() as isize);
            }
            q
        }
    }

    /// Starts a measurement on this thread.
    pub fn start() -> isize {
        let now = NOW.with(Cell::get);
        PEAK.with(|p| p.set(now));
        now
    }

    pub fn peak_since(base: isize) -> isize {
        PEAK.with(Cell::get) - base
    }
}

#[global_allocator]
static ALLOC: alloc_count::Counting = alloc_count::Counting;

/// Q39 N3: a token-dense statement at the limit, read end to end through ScriptReader
/// (splitter, lists and `safety::classify`), peaks under 4x its size.
#[test]
fn statement_near_limit_stays_in_budget() {
    let mut sql = String::from("INSERT INTO t (a, b) VALUES (0,0)");
    while sql.len() < MAX_STATEMENT_BYTES - 64 {
        sql.push_str(",(1,2)");
    }
    let dir = tempfile::tempdir().unwrap();
    let p = file(&dir, "dense.sql", format!("{sql};\nSELECT 1;").as_bytes());
    let len = sql.len() as isize;
    drop(sql);
    let base = alloc_count::start();
    let mut r = ScriptReader::open(&p, MY, false).unwrap();
    let s = r.next_statement().unwrap().unwrap();
    let peak = alloc_count::peak_since(base);
    assert_eq!(s.text.len() as isize, len);
    assert_eq!(s.class, StatementClass::Write);
    assert_eq!(s.kind, StatementKind::Insert);
    assert!(
        peak < 4 * len,
        "peak {peak} bytes for a {len} byte statement"
    );
}

/// Q37 I3: the checks on one statement hold a fraction of it, not a copy per character.
#[test]
fn statement_checks_stay_in_budget() {
    let hex = "0a".repeat(8 * 1024 * 1024);
    let sql = format!("INSERT INTO t (b) VALUES (decode('{hex}', 'hex')), (decode('00', 'hex'))");
    let base = alloc_count::start();
    let action = statement_action(PG, &sql, false);
    let kind = statement_kind(PG, &sql);
    let control = is_transaction_control(PG, &sql);
    let ends = ends_transaction(PG, &sql);
    let shape = insert_shape(PG, &sql);
    let peak = alloc_count::peak_since(base);
    assert_eq!(action, ScriptAction::Run);
    assert_eq!(kind, StatementKind::Insert);
    assert!(!control && !ends);
    assert_eq!(shape.map(|s| s.rows), Some(2));
    assert!(
        peak < sql.len() as isize,
        "peak {peak} bytes for a {} byte statement",
        sql.len()
    );
}

/// Q37 I4: a `$` and a long word with no statement open yet still meets the limit.
#[test]
fn dollar_word_stays_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let body = format!("SELECT 1;\n${}", "a".repeat(300_000));
    let p = file(&dir, "d.sql", body.as_bytes());
    let mut r = ScriptReader::open(&p, PG, false).unwrap().with_limit(1024);
    assert_eq!(r.next_statement().unwrap().unwrap().text, "SELECT 1");
    let err = r.next_statement().unwrap_err();
    assert!(
        matches!(&err, Error::File(m) if m == "Line 2: one statement is larger than 1 KB."),
        "{err:?}"
    );
    assert!(r.bytes_read() < 200_000, "read {}", r.bytes_read());
}

/// Q37 minors: statements that cannot run in a transaction, and the added refusals.
#[test]
fn review_minor_lists() {
    let outside: &[(DialectKind, &str)] = &[
        (PG, "CREATE INDEX CONCURRENTLY i ON t (a)"),
        (PG, "DROP INDEX CONCURRENTLY i"),
        (PG, "REINDEX TABLE CONCURRENTLY t"),
        (PG, "VACUUM t"),
        (PG, "CREATE DATABASE other"),
        (SL, "VACUUM"),
    ];
    for (d, sql) in outside {
        assert!(ends_transaction(*d, sql), "{sql}");
        assert!(!is_transaction_control(*d, sql), "{sql}");
    }
    assert!(!ends_transaction(PG, "CREATE INDEX i ON t (a)"));

    let refused: &[(DialectKind, &str, &str)] = &[
        (PG, "COPY t FROM '/etc/passwd'", "COPY with a server file"),
        (
            PG,
            "COPY t TO '/tmp/out.csv' WITH (FORMAT csv)",
            "COPY with a server file",
        ),
        (PG, "ALTER SYSTEM SET work_mem = '1GB'", "ALTER SYSTEM"),
        (SL, "VACUUM INTO '/tmp/copy.db'", "VACUUM INTO"),
        (SL, "SELECT load_extension('evil')", "load_extension"),
        // Q39: a quoted name calls the same function.
        (SL, "SELECT \"load_extension\"('evil')", "load_extension"),
        (SL, "SELECT [LOAD_EXTENSION] ('evil')", "load_extension"),
        (SL, "SELECT `load_extension`('evil')", "load_extension"),
    ];
    for (d, sql, what) in refused {
        assert_eq!(statement_action(*d, sql, true), refuse(what), "{sql}");
    }
    assert_eq!(
        statement_action(PG, "COPY t TO STDOUT", false),
        ScriptAction::Run
    );
    assert_eq!(statement_action(SL, "VACUUM", false), ScriptAction::Run);
}

/// Q39 N1: MySQL reads an inner `/*!` inside `/*! ... */` as code too.
#[test]
fn nested_executable_comment_is_read() {
    let sql = "/*!40000 SELECT 1; /*!50000 DROP DATABASE x */ */";
    assert_eq!(statement_action(MY, sql, false), refuse("DROP DATABASE"));
    let all = read_file(MY, &format!("{sql};\n"));
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].action, refuse("DROP DATABASE"));
    assert_eq!(
        insert_shape(
            MY,
            "INSERT INTO t VALUES (1) /*!40000 ; /*!50000 DELETE FROM t */"
        ),
        None
    );
    assert!(insert_shape(MY, "INSERT INTO t VALUES (1) /*!40000 */").is_some());
}

/// Q39 N2: the END of a routine, trigger or block body is not COMMIT.
#[test]
fn routine_end_is_not_transaction_control() {
    let cases: &[(DialectKind, &str, bool)] = &[
        (
            SL,
            "CREATE TABLE t (a);\nCREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  INSERT INTO t VALUES (2);\nEND;\nINSERT INTO t VALUES (1);\n",
            true,
        ),
        (
            PG,
            "CREATE PROCEDURE p() LANGUAGE sql BEGIN ATOMIC INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); END;\nINSERT INTO t VALUES (3);\n",
            true,
        ),
        // CREATE PROCEDURE commits on MySQL, so only own transactions is checked there.
        (
            MY,
            "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; BEGIN SELECT 2; END; END//\nDELIMITER ;\nINSERT INTO t VALUES (1);\n",
            false,
        ),
    ];
    for (d, body, one) in cases {
        let dir = tempfile::tempdir().unwrap();
        let p = file(&dir, "r.sql", body.as_bytes());
        let mut r = ScriptReader::open(&p, *d, false).unwrap();
        let all = read_all(&mut r);
        assert!(all.iter().all(|s| s.action == ScriptAction::Run), "{body}");
        assert!(!r.own_transactions(), "{body}");
        assert_eq!(r.one_transaction(), *one, "{body}");
    }
    // A plain END on PostgreSQL and SQLite is still COMMIT.
    assert!(is_transaction_control(PG, "END"));
    assert!(is_transaction_control(SL, "END TRANSACTION"));
}

struct FailingRead(usize);

impl std::io::Read for FailingRead {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.0 == 0 {
            return Err(std::io::Error::other("the disk went away"));
        }
        let n = buf.len().min(self.0);
        buf[..n].fill(b' ');
        self.0 -= n;
        Ok(n)
    }
}

/// Q39: a read error names the file, in next_statement and in finish.
#[test]
fn read_error_names_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let p = file(&dir, "broken.sql", b"SELECT 1;");
    let shown = p.display().to_string();
    let mut r = ScriptReader::open(&p, PG, false)
        .unwrap()
        .with_reader(Box::new(FailingRead(10)));
    let err = r.next_statement().unwrap_err();
    assert!(
        matches!(&err, Error::File(m) if m.contains(&shown) && m.contains("the disk went away")),
        "{err:?}"
    );
    let r = ScriptReader::open(&p, PG, false)
        .unwrap()
        .with_reader(Box::new(FailingRead(0)));
    let err = r.finish().unwrap_err();
    assert!(
        matches!(&err, Error::File(m) if m.contains(&shown)),
        "{err:?}"
    );
}

/// A dense `SELECT 1,1,...` with about `tokens` tokens.
fn dense_select(tokens: usize) -> String {
    let mut sql = String::from("SELECT 1");
    for _ in 0..tokens.saturating_sub(2) / 2 {
        sql.push_str(",1");
    }
    sql
}

/// Q40: a statement that may read is classified up to the token cap, in budget, and
/// refused over it without being classified; a write of any size is still checked.
#[test]
fn reads_past_the_token_cap_are_refused() {
    const BUDGET: isize = 150 * 1024 * 1024;
    let dir = tempfile::tempdir().unwrap();

    let at_cap = dense_select(crate::jobs::limits::MAX_CHECKED_TOKENS - 10);
    let p = file(&dir, "at.sql", format!("{at_cap};").as_bytes());
    drop(at_cap);
    let base = alloc_count::start();
    let s = ScriptReader::open(&p, PG, false)
        .unwrap()
        .next_statement()
        .unwrap()
        .unwrap();
    let peak = alloc_count::peak_since(base);
    assert_eq!(s.action, ScriptAction::Run);
    assert_eq!(s.class, StatementClass::Read);
    assert!(peak < BUDGET, "peak {peak} bytes at the cap");

    let over = dense_select(crate::jobs::limits::MAX_CHECKED_TOKENS + 10);
    let p = file(&dir, "over.sql", format!("{over};\nSELECT 2;").as_bytes());
    drop(over);
    let base = alloc_count::start();
    let all = read_all(&mut ScriptReader::open(&p, PG, false).unwrap());
    let peak = alloc_count::peak_since(base);
    let too_large = ScriptAction::Refuse {
        reason: "This statement is too large to check safely (more than 500,000 parts). \
                 Split it into smaller statements."
            .into(),
    };
    assert_eq!(all[0].action, too_large);
    assert_eq!(all[0].class, StatementClass::Write);
    assert_eq!(all[1].action, ScriptAction::Run);
    assert!(peak < BUDGET, "peak {peak} bytes over the cap");
    assert_eq!(
        statement_action(MY, &dense_select(600_000), true),
        too_large
    );

    // Writes are sealed in 5a and cost a few tokens, so they are not capped.
    let mut insert = String::from("INSERT INTO t VALUES (1)");
    for _ in 0..300_000 {
        insert.push_str(",(1)");
    }
    assert_eq!(statement_action(MY, &insert, false), ScriptAction::Run);
}

/// Q40: a bare BEGIN after a CREATE in one MySQL DELIMITER statement opens a transaction.
#[test]
fn bare_begin_after_create_is_transaction_control() {
    let body =
        "DELIMITER //\nCREATE TABLE t (a int); BEGIN; INSERT INTO t VALUES (1)//\nDELIMITER ;\n";
    let dir = tempfile::tempdir().unwrap();
    let p = file(&dir, "b.sql", body.as_bytes());
    let mut r = ScriptReader::open(&p, MY, false).unwrap();
    assert_eq!(read_all(&mut r).len(), 1);
    assert!(r.own_transactions());
    assert!(is_transaction_control(
        MY,
        "CREATE TABLE t (a int); BEGIN WORK"
    ));
    // A block's BEGIN inside a routine is still not one.
    assert!(!is_transaction_control(
        MY,
        "CREATE PROCEDURE p() BEGIN SELECT 1; BEGIN SELECT 2; END; END"
    ));
}

/// Task 9: the facts the import run reads, DDL and what a transaction word does.
#[test]
fn ddl_and_transaction_words() {
    for (d, sql, ddl) in [
        (PG, "-- c\ncreate table t (a int)", true),
        (MY, "ALTER TABLE t ADD b int", true),
        (SL, "DROP TABLE t", true),
        (MY, "TRUNCATE t", true),
        (PG, "INSERT INTO t VALUES (1)", false),
    ] {
        assert_eq!(Facts::of(d, sql).ddl, ddl, "{sql}");
    }
    for (d, sql, tx) in [
        (PG, "BEGIN", TxControl::Opens),
        (MY, "START TRANSACTION", TxControl::Opens),
        (PG, "END", TxControl::Commits),
        (SL, "COMMIT", TxControl::Commits),
        (PG, "ABORT", TxControl::RollsBack),
        (MY, "ROLLBACK", TxControl::RollsBack),
        (MY, "LOCK TABLES t WRITE", TxControl::Locks),
        (MY, "ROLLBACK TO SAVEPOINT s", TxControl::None),
        (PG, "SELECT 1", TxControl::None),
    ] {
        assert_eq!(Facts::of(d, sql).tx, tx, "{sql}");
    }
}

/// Q44: autocommit values, LOCK TABLES, session changes, MySQL's implicit commits and
/// pg_dump's `\restrict` lines.
#[test]
fn q44_facts() {
    for (sql, tx) in [
        ("SET autocommit=0", TxControl::AutocommitOff),
        ("SET autocommit = OFF", TxControl::AutocommitOff),
        ("SET @@session.autocommit = 0", TxControl::AutocommitOff),
        ("SET @@autocommit := FALSE", TxControl::AutocommitOff),
        ("SET AUTOCOMMIT = 1", TxControl::AutocommitOn),
        ("SET autocommit = ON", TxControl::AutocommitOn),
        (
            "SET @OLD_AUTOCOMMIT=@@AUTOCOMMIT, AUTOCOMMIT=0",
            TxControl::AutocommitOff,
        ),
        ("SET AUTOCOMMIT=@OLD_AUTOCOMMIT", TxControl::Other),
        ("LOCK TABLES t WRITE", TxControl::Locks),
        ("UNLOCK TABLES", TxControl::Locks),
        ("XA START 'x'", TxControl::Opens),
        ("XA COMMIT 'x'", TxControl::Commits),
        ("XA END 'x'", TxControl::Other),
    ] {
        assert_eq!(Facts::of(MY, sql).tx, tx, "{sql}");
    }
    for (d, sql, session) in [
        (MY, "/*!40101 SET NAMES utf8mb4 */", true),
        (MY, "USE shop", true),
        (
            PG,
            "SELECT pg_catalog.set_config('search_path', '', false)",
            true,
        ),
        (PG, "RESET ROLE", true),
        (PG, "SET ROLE admin", true),
        (PG, "INSERT INTO t VALUES (1)", false),
        (PG, "SELECT config_set(1)", false),
    ] {
        assert_eq!(Facts::of(d, sql).session, session, "{sql}");
    }
    for sql in [
        "CHECK TABLE t",
        "IMPORT TABLE FROM 't.sdi'",
        "START REPLICA",
        "STOP SLAVE",
        "CHANGE REPLICATION SOURCE TO SOURCE_HOST = 'h'",
        "CHANGE MASTER TO MASTER_HOST = 'h'",
    ] {
        assert!(ends_transaction(MY, sql), "{sql}");
    }
    let skip_restrict = ScriptAction::Skip {
        reason: "\\restrict is a psql line, so it is skipped.".into(),
    };
    assert_eq!(
        statement_action(PG, "\\restrict Ab12Cd34", false),
        skip_restrict
    );
    assert_eq!(
        statement_action(PG, "\\restrict Ab12Cd34", true),
        skip_restrict
    );
    assert_eq!(
        statement_action(PG, "\\unrestrict Ab12Cd34", true),
        ScriptAction::Skip {
            reason: "\\unrestrict is a psql line, so it is skipped.".into()
        }
    );
    // Anything more on the line is still a refused meta-command.
    assert_eq!(
        statement_action(PG, "\\restrict Ab; \\! rm -rf /", false),
        refuse("A psql meta-command")
    );
    assert_eq!(
        statement_action(PG, "\\restrictx", false),
        refuse("A psql meta-command")
    );
    // Run as is does not run a psql line from a file either.
    let all = read_file_as_is(PG, "\\restrict Ab12Cd34\nSELECT 1;\n");
    assert!(matches!(all[0].action, ScriptAction::Skip { .. }));
    assert!(!all[0].run_as_is);
}

fn read_file_as_is(d: DialectKind, body: &str) -> Vec<ScriptStatement> {
    let dir = tempfile::tempdir().unwrap();
    let p = file(&dir, "f.sql", body.as_bytes());
    read_all(&mut ScriptReader::open(&p, d, true).unwrap())
}
