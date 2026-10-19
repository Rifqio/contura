use super::tests::neutral_model;
use super::{DdlOptions, DdlParts, parts};
use crate::model::DialectKind;
use crate::schema_model::{SchemaModel, SmIndex};

fn on() -> DdlOptions {
    DdlOptions {
        unique_index_names: true,
        ..Default::default()
    }
}

fn index(name: &str, column: &str) -> SmIndex {
    SmIndex {
        name: Some(name.into()),
        columns: vec![column.into()],
        unique: false,
        pk: false,
    }
}

/// `neutral_model` with a second `ix_store`, on `stores` (written before `orders`).
fn shared_name(d: DialectKind) -> SchemaModel {
    let mut m = neutral_model(d);
    m.tables[1].indexes.push(index("ix_store", "name"));
    m
}

/// The index names in statement order, read from `CREATE [UNIQUE ]INDEX <q>name<q> ON`.
fn names(p: &DdlParts) -> Vec<String> {
    p.indexes
        .iter()
        .map(|s| {
            let rest = &s[s.find("INDEX ").unwrap() + "INDEX ".len()..];
            let q = rest.chars().next().unwrap();
            let rest = &rest[q.len_utf8()..];
            rest[..rest.find(q).unwrap()].to_string()
        })
        .collect()
}

#[test]
fn postgres_index_names_are_unique_across_tables() {
    let p = parts(&shared_name(DialectKind::Postgres), &on()).unwrap();
    assert_eq!(
        p.indexes,
        vec![
            "CREATE INDEX \"ix_store\" ON \"stores\" (\"name\");",
            "CREATE INDEX \"orders_ix_store\" ON \"orders\" (\"store_id\");",
        ]
    );
}

#[test]
fn sqlite_index_names_are_unique_across_tables() {
    let p = parts(&shared_name(DialectKind::Sqlite), &on()).unwrap();
    assert_eq!(names(&p), vec!["ix_store", "orders_ix_store"]);
}

#[test]
fn sqlite_compares_index_names_without_case() {
    let mut m = neutral_model(DialectKind::Sqlite);
    m.tables[1].indexes.push(index("IX_Store", "name"));
    let p = parts(&m, &on()).unwrap();
    assert_eq!(names(&p), vec!["IX_Store", "orders_ix_store"]);
}

#[test]
fn a_taken_table_prefixed_name_gets_a_number() {
    let mut m = shared_name(DialectKind::Postgres);
    m.tables[1].indexes.push(index("orders_ix_store", "name"));
    let p = parts(&m, &on()).unwrap();
    assert_eq!(
        names(&p),
        vec!["ix_store", "orders_ix_store", "orders_ix_store_2"]
    );
}

#[test]
fn an_index_named_like_a_table_is_renamed() {
    let mut m = neutral_model(DialectKind::Postgres);
    m.tables[0].indexes[0].name = Some("stores".into());
    let p = parts(&m, &on()).unwrap();
    assert_eq!(names(&p), vec!["orders_stores"]);
}

#[test]
fn a_long_postgres_index_name_is_shortened_the_same_way_each_time() {
    let long = "a".repeat(90);
    let mut m = neutral_model(DialectKind::Postgres);
    m.tables[0].indexes[0].name = Some(long.clone());
    let first = names(&parts(&m, &on()).unwrap());
    let again = names(&parts(&m, &on()).unwrap());
    assert_eq!(first, again);
    let name = &first[0];
    assert!(name.len() <= 63, "{name} is {} bytes", name.len());
    assert_eq!(name.len(), 63);
    assert!(name.starts_with(&format!("{}_", "a".repeat(55))), "{name}");
    let hash = &name[56..];
    assert_eq!(hash.len(), 7);
    assert!(hash.chars().all(|c| c.is_ascii_hexdigit()), "{name}");

    // Another long name with the same start gets another hash.
    m.tables[0].indexes[0].name = Some(format!("{long}b"));
    let other = names(&parts(&m, &on()).unwrap());
    assert_ne!(other[0], *name);
}

#[test]
fn a_long_multibyte_name_is_cut_on_a_char_boundary() {
    let mut m = neutral_model(DialectKind::Postgres);
    m.tables[0].indexes[0].name = Some("é".repeat(50));
    let n = names(&parts(&m, &on()).unwrap());
    let name = &n[0];
    assert!(name.len() <= 63, "{name} is {} bytes", name.len());
    assert!(name.starts_with(&format!("{}_", "é".repeat(27))), "{name}");
}

#[test]
fn a_long_generated_index_name_is_shortened() {
    let mut m = neutral_model(DialectKind::Postgres);
    m.tables[0].name = "t".repeat(60);
    m.refs[0].from.table = m.tables[0].name.clone();
    m.tables[0].indexes[0].name = None;
    let n = names(&parts(&m, &on()).unwrap());
    assert!(n[0].len() <= 63, "{}", n[0]);
}

#[test]
fn mysql_keeps_the_same_index_name_on_two_tables() {
    let p = parts(&shared_name(DialectKind::MySql), &on()).unwrap();
    assert_eq!(
        p.indexes,
        vec![
            "CREATE INDEX `ix_store` ON `stores` (`name`);",
            "CREATE INDEX `ix_store` ON `orders` (`store_id`);",
        ]
    );
}

#[test]
fn a_long_mysql_index_name_keeps_64_characters() {
    let mut m = neutral_model(DialectKind::MySql);
    m.tables[0].indexes[0].name = Some("é".repeat(90));
    let n = names(&parts(&m, &on()).unwrap());
    let name = &n[0];
    assert_eq!(name.chars().count(), 64, "{name}");
    assert!(name.starts_with(&format!("{}_", "é".repeat(56))), "{name}");
    // 64 characters exactly is kept as it is.
    let exact = "b".repeat(64);
    m.tables[0].indexes[0].name = Some(exact.clone());
    assert_eq!(names(&parts(&m, &on()).unwrap()), vec![exact]);
}

#[test]
fn off_keeps_index_names_as_they_are() {
    for d in [
        DialectKind::Postgres,
        DialectKind::Sqlite,
        DialectKind::MySql,
    ] {
        let p = parts(&shared_name(d), &DdlOptions::default()).unwrap();
        assert_eq!(names(&p), vec!["ix_store", "ix_store"], "{d:?}");
        let mut m = neutral_model(d);
        let long = "a".repeat(90);
        m.tables[0].indexes[0].name = Some(long.clone());
        let p = parts(&m, &DdlOptions::default()).unwrap();
        assert_eq!(names(&p), vec![long], "{d:?}");
    }
}

#[test]
fn on_changes_nothing_when_names_already_fit() {
    for d in [
        DialectKind::Postgres,
        DialectKind::Sqlite,
        DialectKind::MySql,
    ] {
        let m = neutral_model(d);
        assert_eq!(
            parts(&m, &on()).unwrap(),
            parts(&m, &DdlOptions::default()).unwrap(),
            "{d:?}"
        );
    }
}
