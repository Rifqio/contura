use super::*;

#[test]
fn mysql_srids_from_show_create_table() {
    let ddl = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `g` point NOT NULL /*!80003 SRID 4326 */,\n  `we``ird` geometry /*!80003 SRID 3857 */ DEFAULT NULL,\n  `h` linestring DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB";
    let got = mysql_srids(ddl);
    assert_eq!(got.get("g"), Some(&4326));
    assert_eq!(got.get("we`ird"), Some(&3857));
    assert_eq!(got.get("h"), None);
    assert_eq!(got.len(), 2);
}

#[test]
fn value_rules() {
    let xlsx = ValueRules {
        format: Format::Xlsx,
        empty_as: EmptyAs::EmptyText,
        null_word: true,
    };
    let s = |v: &str| Some(v.to_string());
    assert_eq!(xlsx.value(None), Value::Text(String::new()));
    assert_eq!(xlsx.value(s("NULL").as_ref()), Value::Null);
    assert_eq!(xlsx.value(s("null").as_ref()), Value::Text("null".into()));
    // The CSV reader has applied the empty-cell and NULL rules: its None is NULL.
    let csv = ValueRules {
        format: Format::Csv,
        ..xlsx
    };
    assert_eq!(csv.value(None), Value::Null);
    let json = ValueRules {
        format: Format::Json,
        ..xlsx
    };
    // a missing key is NULL whatever "An empty cell means" says.
    assert_eq!(json.value(None), Value::Null);
    // The text-NULL option is for CSV and Excel only. CSV applies it in its reader, where quoting is
    // known, so the value rule keeps it for Excel alone.
    let mut req = ImportRequest {
        format: Format::Json,
        options: crate::jobs::types::ImportOptions {
            null_word: true,
            ..Default::default()
        },
        ..Default::default()
    };
    assert!(!ValueRules::of(&req).null_word);
    req.format = Format::Csv;
    assert!(!ValueRules::of(&req).null_word);
    req.format = Format::Xlsx;
    assert!(ValueRules::of(&req).null_word);
}

fn target(kind: DialectKind, columns: Vec<TargetColumn>) -> Target {
    let path = ObjectPath {
        database: "shop".into(),
        schema: (kind == DialectKind::Postgres).then(|| "public".to_string()),
        name: "t".into(),
    };
    Target {
        kind,
        table_sql: sql_table(kind, &path).unwrap(),
        path,
        columns,
    }
}

fn column(name: &str, type_sql: &str) -> TargetColumn {
    TargetColumn {
        name: name.into(),
        type_sql: type_sql.into(),
        nullable: true,
        ..TargetColumn::default()
    }
}

/// The pass binds the format and refuses a plan that cannot be written.
#[test]
fn fingerprint_binds_the_format() {
    let kind = DialectKind::Postgres;
    let header = vec!["id".to_string()];
    let req = ImportRequest {
        table: target(kind, vec![]).path,
        format: Format::Csv,
        ..Default::default()
    };
    let file = FileIdentity {
        path: PathBuf::from("C:/in/a.csv"),
        bytes: 3,
        sha256: "ab".into(),
    };
    let p = Prepared::new(target(kind, vec![column("id", "integer")]), header, &req).unwrap();
    let csv = job_fingerprint(&p.job_plan(&req, file.clone()).unwrap()).unwrap();
    let json_req = ImportRequest {
        format: Format::Json,
        ..req.clone()
    };
    let json = job_fingerprint(&p.job_plan(&json_req, file).unwrap()).unwrap();
    assert_ne!(csv, json);
}

/// Commit every N below 500 cuts statements at N; a table that does not
/// roll back, or whose engine could not be read, takes one row a statement.
#[test]
fn insert_limits_by_storage_and_commit() {
    let once = CommitMode::Once;
    let every = |rows| CommitMode::Every { rows };
    assert_eq!(insert_limits(Some(true), once, usize::MAX).rows, 500);
    assert_eq!(insert_limits(Some(true), every(100), usize::MAX).rows, 100);
    assert_eq!(
        insert_limits(Some(true), every(10_000), usize::MAX).rows,
        500
    );
    assert_eq!(insert_limits(Some(false), once, usize::MAX).rows, 1);
    assert_eq!(insert_limits(None, once, usize::MAX).rows, 1);
    // the server's limit cuts the sample as it cuts the run.
    assert_eq!(insert_limits(Some(true), once, 4_000).bytes, 4_000);
    assert_eq!(
        insert_limits(Some(true), once, usize::MAX).bytes,
        1024 * 1024
    );
}

/// "Nothing was imported." only when nothing stayed.
#[test]
fn too_many_says_what_stayed() {
    assert_eq!(
        too_many_text(0, "t"),
        "More than 1,000 rows failed. Nothing was imported."
    );
    assert_eq!(
        too_many_text(2_000, "t"),
        "More than 1,000 rows failed. 2,000 rows were written before the stop and stay in t."
    );
    assert_eq!(
        too_many_text(1, "t"),
        "More than 1,000 rows failed. 1 row was written before the stop and stays in t."
    );
}

/// A file that changed after rows were kept says what stayed; with nothing kept
/// it stays FileChanged ("Nothing was imported.").
#[test]
fn file_changed_says_what_stayed() {
    let changed = || {
        Err(Error::FileChanged {
            file: "menu.csv".into(),
            confirmed: false,
        })
    };
    match kept_end(changed(), 2_000, "menu.csv", "t") {
        Err(Error::JobFailed { at, message }) => {
            assert_eq!(
                message,
                "menu.csv changed while it was imported. 2,000 rows were written before the stop and stay in t."
            );
            assert_eq!(at.table.as_deref(), Some("t"));
        }
        other => panic!("{other:?}"),
    }
    match kept_end(changed(), 1, "menu.csv", "t") {
        Err(Error::JobFailed { message, .. }) => assert_eq!(
            message,
            "menu.csv changed while it was imported. 1 row was written before the stop and stays in t."
        ),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        kept_end(changed(), 0, "menu.csv", "t"),
        Err(Error::FileChanged { .. })
    ));
    assert!(kept_end(Ok(()), 5, "menu.csv", "t").is_ok());
}

/// `setval` never goes below the sequence's MINVALUE, and an empty table
/// leaves the next value at MINVALUE.
#[test]
fn setval_keeps_minvalue() {
    let kind = DialectKind::Postgres;
    let mut id = column("id", "integer");
    id.increment = crate::design::Increment::Identity;
    let req = ImportRequest {
        table: target(kind, vec![]).path,
        ..Default::default()
    };
    let p = Prepared::new(target(kind, vec![id]), vec!["id".into()], &req).unwrap();
    let seq = "pg_get_serial_sequence('\"public\".\"t\"', 'id')";
    assert_eq!(
        p.extra,
        [format!(
            "SELECT setval({seq}, GREATEST(max(\"id\"), (SELECT seqmin FROM pg_sequence WHERE seqrelid = {seq}::regclass)), max(\"id\") IS NOT NULL) FROM \"public\".\"t\""
        )]
    );
}

/// A binary cell that is not valid `0x` hex goes in as text, with a warning.
#[test]
fn binary_cells_that_are_not_hex() {
    assert_eq!(binary_warning(7, "bin", "0x0a"), None);
    assert_eq!(
        binary_warning(7, "bin", "0xzz").as_deref(),
        Some("Row 7 of the file: 0xzz is not 0x hex, so it goes into bin as text.")
    );
    assert_eq!(
        binary_warning(9, "bin", "abc").as_deref(),
        Some("Row 9 of the file: abc is not 0x hex, so it goes into bin as text.")
    );
}

/// A writer whose COMMIT ends as it is told.
struct Commits(Option<Error>);

#[async_trait::async_trait]
impl BulkWriter for Commits {
    async fn begin(&mut self) -> Result<()> {
        Ok(())
    }
    async fn run(&mut self, _: &str) -> Result<u64> {
        Ok(0)
    }
    async fn first_value(&mut self, _: &str) -> Result<Option<String>> {
        Ok(None)
    }
    async fn savepoint(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn rollback_to(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn release(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn commit(&mut self) -> Result<()> {
        match self.0.take() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    async fn rollback(&mut self) -> Result<()> {
        Ok(())
    }
    fn statement_limit(&self) -> usize {
        usize::MAX
    }
    fn canceller(&self) -> Arc<dyn crate::query::Canceller> {
        unimplemented!("not cancelled here")
    }
    async fn close(self: Box<Self>) {}
}

/// A batch whose COMMIT succeeded counts, even when `after` then failed;
/// a failed COMMIT counts nothing.
#[tokio::test]
async fn after_commit_counts_the_batch() {
    let mut t = Tally {
        committed: 1_000,
        open: 500,
        ..Tally::default()
    };
    let mut w = Commits(Some(Error::AfterCommit {
        sql: "SET x = 1".into(),
        message: "denied".into(),
    }));
    assert!(matches!(
        commit_batch(&mut w, &mut t).await,
        Err(Error::AfterCommit { .. })
    ));
    assert_eq!((t.committed, t.open), (1_500, 0));

    t.open = 200;
    let mut w = Commits(Some(Error::Query("deadlock".into())));
    assert!(commit_batch(&mut w, &mut t).await.is_err());
    assert_eq!(t.committed, 1_500);

    let mut w = Commits(None);
    commit_batch(&mut w, &mut t).await.unwrap();
    assert_eq!((t.committed, t.open), (1_700, 0));
}

/// PostGIS reads `SRID=n;<wkt>` (EWKT) as geometry input, as ST_GeomFromEWKT does, so
/// the value goes in as a text literal with its SRID kept.
#[test]
fn postgres_geometry_keeps_its_srid() {
    let conv = [conversion_for(
        DialectKind::Postgres,
        "geometry(Point,4326)",
    )];
    assert_eq!(
        row_text(
            DialectKind::Postgres,
            &conv,
            &[Value::Text("SRID=4326;POINT(1 2)".into())]
        )
        .unwrap(),
        "('SRID=4326;POINT(1 2)')"
    );
}

#[test]
fn counts_in_words() {
    assert_eq!(rows_text(1), "1 row");
    assert_eq!(rows_text(1204), "1,204 rows");
    assert_eq!(statements_text(3), "3 statements");
}
