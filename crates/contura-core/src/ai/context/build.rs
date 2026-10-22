//! Building an AI Context from a schema: the cards, the saved queries that belong to it
//! and the FTS rows, all from the catalog with no rows read and no provider called.

use crate::ai::budget::estimate_tokens;
use crate::ai::context::cards::{card_pair, cleaner, comment, same_table};
use crate::ai::context::store::{
    BuiltContext, FtsRow, GraphRow, StoredCard, StoredSavedQuery, saved_fts,
};
use crate::ai::context::tree::build_areas;
use crate::ai::rails::{Secrets, cap_chars};
use crate::model::DialectKind;
use crate::query::SavedQuery;
use crate::safety::{mask_literals, qualified_table_refs};
use crate::schema_model::{SchemaModel, SmTable};

/// R2.4: a saved query's masked SQL is capped like a card, at 4 KB.
const SQL_CAP: usize = 4 * 1024;

/// Lower-cased parts of a name, split at `_`, `$`, spaces and other punctuation, at digit
/// runs and at camel-case humps: `HTTPRequestLog` gives `http`, `request`, `log`.
pub fn split_words(name: &str) -> Vec<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur).to_lowercase());
            }
            continue;
        }
        if !cur.is_empty() {
            let prev = chars[i - 1];
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
            let boundary = prev.is_numeric() != c.is_numeric()
                || prev.is_lowercase() && c.is_uppercase()
                || prev.is_uppercase() && c.is_uppercase() && next_lower;
            if boundary {
                out.push(std::mem::take(&mut cur).to_lowercase());
            }
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push(cur.to_lowercase());
    }
    out
}

/// `split_words` of every name, deduplicated, space separated.
pub(crate) fn words_of<'a>(names: impl IntoIterator<Item = &'a str>) -> String {
    let mut out: Vec<String> = Vec::new();
    for w in names.into_iter().flat_map(split_words) {
        if !out.contains(&w) {
            out.push(w);
        }
    }
    out.join(" ")
}

/// The schema of a foreign key's other end matches `table`'s; an unknown one matches.
fn same_schema(other: &Option<String>, table: &SmTable) -> bool {
    other.is_none() || table.schema.is_none() || *other == table.schema
}

fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names.dedup();
    names
}

fn stored_card(table: &SmTable, model: &SchemaModel, clean: &dyn Fn(&str) -> String) -> StoredCard {
    let (card, card_rows) = card_pair(table, model, clean);
    let fk_out = model
        .refs
        .iter()
        .filter(|r| {
            same_table(&r.from.schema, &r.from.table, table) && same_schema(&r.to.schema, table)
        })
        .map(|r| clean(&r.to.table))
        .collect();
    let fk_in = model
        .refs
        .iter()
        .filter(|r| {
            same_table(&r.to.schema, &r.to.table, table) && same_schema(&r.from.schema, table)
        })
        .map(|r| clean(&r.from.table))
        .collect();
    StoredCard {
        table: clean(&table.name),
        tokens: estimate_tokens(&card, false),
        rows_tokens: estimate_tokens(&card_rows, false),
        card,
        card_rows,
        fk_out: sorted(fk_out),
        fk_in: sorted(fk_in),
    }
}

fn table_fts(table: &SmTable, clean: &dyn Fn(&str) -> String) -> FtsRow {
    let names: Vec<String> = std::iter::once(table.name.as_str())
        .chain(table.columns.iter().map(|c| c.name.as_str()))
        .map(clean)
        .collect();
    let note: Vec<String> = table
        .note
        .iter()
        .chain(table.columns.iter().filter_map(|c| c.note.as_ref()))
        .map(|n| comment(n, clean))
        .filter(|n| !n.is_empty())
        .collect();
    FtsRow {
        node_id: format!("t:{}", names[0]),
        names: names.join(" "),
        words: words_of(names.iter().map(String::as_str)),
        note: note.join(" "),
    }
}

/// The tables of `tables` a Saved Query reads or writes, or `None` when it names none,
/// names one that is not there, names one in another schema or database than `here`,
/// or has a shape `table_refs` does not read. A name matches exactly, or ignoring case
/// when no table has its exact spelling.
pub(crate) fn query_tables(
    tables: &[&str],
    dialect: DialectKind,
    here: &str,
    sql: &str,
) -> Option<Vec<String>> {
    let refs = qualified_table_refs(dialect, sql)?;
    if refs.is_empty() {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    for parts in refs {
        let (r, before) = parts.split_last()?;
        if before.last().is_some_and(|q| !q.eq_ignore_ascii_case(here)) {
            return None;
        }
        let hit = tables
            .iter()
            .find(|t| **t == r)
            .or_else(|| tables.iter().find(|t| t.to_lowercase() == r.to_lowercase()))?;
        if !out.iter().any(|o| o == hit) {
            out.push(hit.to_string());
        }
    }
    Some(out)
}

/// A saved query's name and SQL as the AI Context holds them (R2.1, R2.2, R2.4): the
/// name cleaned; the SQL with its literals masked, then cleaned (a secret or an
/// invisible character in a comment goes too) and capped at 4 KB. The secret shapes are
/// removed even when `clean` is not the Secrets cleaner.
pub(crate) fn saved_text(
    dialect: DialectKind,
    name: &str,
    sql: &str,
    clean: &dyn Fn(&str) -> String,
) -> (String, String) {
    let none = Secrets::default();
    let shapes = cleaner(&none);
    let name = shapes(&clean(name));
    let sql = shapes(&clean(&mask_literals(dialect, sql)));
    (name, cap_chars(&sql, SQL_CAP).to_string())
}

/// The AI Context of `model`, the schema (or database, where the Dialect has no schema)
/// `here`, with every name stored cleaned: one card per table sorted by name, the Saved Queries whose tables are all
/// tables of `model` (as `saved_text` holds them), and one FTS row per table and per
/// query.
pub fn build_context(
    model: &SchemaModel,
    dialect: DialectKind,
    here: &str,
    saved: &[SavedQuery],
    clean: &dyn Fn(&str) -> String,
) -> BuiltContext {
    let mut tables: Vec<&SmTable> = model.tables.iter().collect();
    tables.sort_by(|a, b| (&a.name, &a.schema).cmp(&(&b.name, &b.schema)));
    let cards: Vec<StoredCard> = tables
        .iter()
        .map(|t| stored_card(t, model, clean))
        .collect();
    let mut fts: Vec<FtsRow> = tables.iter().map(|t| table_fts(t, clean)).collect();

    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    let mut kept: Vec<StoredSavedQuery> = saved
        .iter()
        .filter_map(|q| {
            let tables = query_tables(&names, dialect, here, &q.sql)?
                .iter()
                .map(|t| clean(t))
                .collect();
            let (name, sql) = saved_text(dialect, &q.name, &q.sql, clean);
            Some(StoredSavedQuery {
                id: q.id,
                name,
                sql,
                tables,
            })
        })
        .collect();
    kept.sort_by(|a, b| (&a.name, a.id).cmp(&(&b.name, b.id)));
    fts.extend(kept.iter().map(saved_fts));
    let graph: Vec<GraphRow> = cards
        .iter()
        .map(|c| GraphRow {
            table: c.table.clone(),
            tokens: c.tokens,
            rows_tokens: c.rows_tokens,
            fk_out: c.fk_out.clone(),
            fk_in: c.fk_in.clone(),
        })
        .collect();
    BuiltContext {
        areas: build_areas(&graph),
        cards,
        saved: kept,
        fts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::context::store::{FtsRow, StoredCard};
    use crate::schema_model::{SmColumn, SmEndpoint, SmEnum, SmRef, SmTable};

    const PG: DialectKind = DialectKind::Postgres;

    fn keep(text: &str) -> String {
        text.to_string()
    }

    fn col(name: &str, type_name: &str) -> SmColumn {
        SmColumn {
            name: name.into(),
            type_name: type_name.into(),
            pk: false,
            increment: false,
            not_null: false,
            unique: false,
            default: None,
            note: None,
        }
    }

    fn table(name: &str, columns: &[&str]) -> SmTable {
        SmTable {
            schema: Some("public".into()),
            name: name.into(),
            alias: None,
            note: None,
            columns: columns.iter().map(|c| col(c, "int")).collect(),
            indexes: Vec::new(),
        }
    }

    fn fk(from: &str, column: &str, to: &str) -> SmRef {
        SmRef {
            name: None,
            from: SmEndpoint {
                schema: Some("public".into()),
                table: from.into(),
                columns: vec![column.into()],
            },
            to: SmEndpoint {
                schema: Some("public".into()),
                table: to.into(),
                columns: vec!["id".into()],
            },
            on_delete: None,
            on_update: None,
        }
    }

    fn shop() -> SchemaModel {
        SchemaModel {
            dialect: PG,
            tables: vec![
                table("orders", &["id", "customer_id"]),
                table("invoiceLine", &["id", "order_id", "HTTPRequestLog"]),
                table("customers", &["id"]),
            ],
            refs: vec![
                fk("orders", "customer_id", "customers"),
                fk("invoiceLine", "order_id", "orders"),
                fk("invoiceLine", "order_id", "orders"),
            ],
            enums: Vec::new(),
            skipped: Vec::new(),
        }
    }

    fn query(name: &str, sql: &str) -> SavedQuery {
        SavedQuery {
            id: uuid::Uuid::new_v4(),
            name: name.into(),
            sql: sql.into(),
            updated_at_ms: 0,
            connection_id: None,
            kind: Default::default(),
            visual_json: None,
        }
    }

    fn card<'a>(built: &'a BuiltContext, name: &str) -> &'a StoredCard {
        built.cards.iter().find(|c| c.table == name).unwrap()
    }

    fn fts<'a>(built: &'a BuiltContext, id: &str) -> &'a FtsRow {
        built.fts.iter().find(|r| r.node_id == id).unwrap()
    }

    #[test]
    fn split_words_cases() {
        assert_eq!(split_words("customer_id"), ["customer", "id"]);
        assert_eq!(split_words("invoiceLine"), ["invoice", "line"]);
        assert_eq!(split_words("HTTPRequestLog"), ["http", "request", "log"]);
        assert_eq!(split_words("order2items"), ["order", "2", "items"]);
        assert_eq!(
            split_words("Monthly sales$v2"),
            ["monthly", "sales", "v", "2"]
        );
        assert!(split_words("__").is_empty());
    }

    #[test]
    fn build_fills_areas() {
        let built = build_context(&shop(), PG, "public", &[], &keep);
        assert_eq!(built.areas.len(), 1);
        let mut tables = built.areas[0].tables.clone();
        tables.sort();
        assert_eq!(tables, ["customers", "invoiceLine", "orders"]);
        assert_eq!(built.areas[0].hub, built.areas[0].tables[0]);
    }

    #[test]
    fn build_is_deterministic() {
        let model = shop();
        let saved = [query("Open orders", "select * from orders")];
        let a = build_context(&model, PG, "public", &saved, &keep);
        let b = build_context(&model, PG, "public", &saved, &keep);
        assert_eq!(a, b);
        let names: Vec<&str> = a.cards.iter().map(|c| c.table.as_str()).collect();
        assert_eq!(names, ["customers", "invoiceLine", "orders"]);
        let ids: Vec<&str> = a.fts.iter().map(|r| r.node_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "t:customers".to_string(),
                "t:invoiceLine".to_string(),
                "t:orders".to_string(),
                format!("q:{}", saved[0].id),
            ]
        );
        let line = card(&a, "invoiceLine");
        assert_eq!(
            line.card,
            "invoiceLine(id int, order_id int -> orders.id, HTTPRequestLog int)"
        );
        assert_eq!(line.card_rows, "");
        assert_eq!(
            line.tokens,
            crate::ai::budget::estimate_tokens(&line.card, false)
        );
        assert_eq!(line.rows_tokens, 0);
        let row = fts(&a, "t:invoiceLine");
        assert_eq!(row.names, "invoiceLine id order_id HTTPRequestLog");
        assert_eq!(row.words, "invoice line id order http request log");
        assert_eq!(row.note, "");
    }

    #[test]
    fn fk_in_and_out() {
        let mut model = shop();
        // Another schema's table of the same name is not a link.
        model.refs.push(SmRef {
            from: SmEndpoint {
                schema: Some("audit".into()),
                table: "log".into(),
                columns: vec!["order_id".into()],
            },
            ..fk("x", "y", "orders")
        });
        let built = build_context(&model, PG, "public", &[], &keep);
        assert_eq!(card(&built, "orders").fk_out, ["customers"]);
        assert_eq!(card(&built, "orders").fk_in, ["invoiceLine"]);
        assert_eq!(card(&built, "customers").fk_in, ["orders"]);
        assert!(card(&built, "customers").fk_out.is_empty());
        assert_eq!(card(&built, "invoiceLine").fk_out, ["orders"]);
    }

    #[test]
    fn saved_query_membership() {
        let model = shop();
        let saved = [
            query(
                "Orders by customer",
                "select * from orders o join customers c on c.id = o.customer_id",
            ),
            query("Missing", "select * from missing_table"),
            query("Mixed", "select * from orders join missing_table on true"),
            query("Only a CTE", "with x as (select 1) select * from x"),
            query("No table", "select 1"),
            query("Upper", "select * from ORDERS"),
            // Another schema's orders is not this one's.
            query("Audit", "select * from audit.orders"),
            query("Here", "select * from public.orders join customers on true"),
        ];
        let built = build_context(&model, PG, "public", &saved, &keep);
        let names: Vec<&str> = built.saved.iter().map(|q| q.name.as_str()).collect();
        assert_eq!(names, ["Here", "Orders by customer", "Upper"]);
        assert_eq!(built.saved[0].tables, ["orders", "customers"]);
        assert_eq!(built.saved[1].tables, ["orders", "customers"]);
        assert_eq!(built.saved[2].tables, ["orders"]);
        let row = fts(&built, &format!("q:{}", saved[0].id));
        assert_eq!(row.names, "Orders by customer orders customers");
        assert_eq!(row.words, "orders by customer");
        assert_eq!(row.note, "");
    }

    #[test]
    fn saved_query_is_cleaned() {
        let model = shop();
        let token = "sk-abcdefghijklmnopqrstu";
        let saved = [query(
            &format!("Sa\u{200B}les {token}"),
            &format!("select * from orders -- key {token}\n/* note\u{200B} */ where id = 7"),
        )];
        let built = build_context(&model, PG, "public", &saved, &keep);
        let q = &built.saved[0];
        for text in [&q.name, &q.sql] {
            assert!(!text.contains(token), "{text}");
            assert!(!text.contains('\u{200B}'), "{text:?}");
        }
        assert_eq!(q.name, "Sales [redacted]");
        assert!(q.sql.ends_with("where id = ?"), "{}", q.sql);
        let row = fts(&built, &format!("q:{}", q.id));
        assert!(!row.names.contains(token) && !row.words.contains("abcdefghij"));
    }

    #[test]
    fn saved_query_is_masked() {
        let model = shop();
        let saved = [
            query("Bob", "select * from orders where id = 42 and name = 'bob'"),
            query(
                "Long",
                &format!(
                    "select * from orders where note = 'x' {}",
                    "-- é\n".repeat(2_000)
                ),
            ),
        ];
        let built = build_context(&model, PG, "public", &saved, &keep);
        assert_eq!(
            built.saved[0].sql,
            "select * from orders where id = ? and name = '…'"
        );
        let long = &built.saved[1].sql;
        assert!(
            long.len() <= 4 * 1024 && long.len() > 4 * 1024 - 4,
            "{}",
            long.len()
        );
        assert!(long.starts_with("select * from orders where note = '…' "));
    }

    #[test]
    fn case_distinct_tables_are_two_cards() {
        let mut model = shop();
        model.tables.push(table("Orders", &["ID"]));
        let saved = [
            query("Lower", "select * from orders"),
            query("Upper", "select * from Orders"),
            query("Shout", "select * from ORDERS"),
        ];
        let built = build_context(&model, PG, "public", &saved, &keep);
        assert_eq!(card(&built, "Orders").card, "Orders(ID int)");
        assert_eq!(
            card(&built, "orders").card.split('(').next(),
            Some("orders")
        );
        assert_eq!(built.cards.len(), 4);
        assert_eq!(fts(&built, "t:Orders").names, "Orders ID");
        let tables: Vec<&[String]> = built.saved.iter().map(|q| q.tables.as_slice()).collect();
        assert_eq!(tables.len(), 3);
        assert!(tables.contains(&&["orders".to_string()][..]));
        assert!(tables.contains(&&["Orders".to_string()][..]));
    }

    #[test]
    fn table_names_are_stored_cleaned() {
        let mut model = shop();
        let token = "sk-abcdefghijklmnopqrstu";
        let name = format!("audit\u{200B}log {token}");
        model.tables.push(table(&name, &["order_id"]));
        model.refs.push(fk(&name, "order_id", "orders"));
        let saved = [query("Audit", &format!("select * from \"{name}\""))];
        let secrets = crate::ai::rails::Secrets::default();
        let clean = crate::ai::context::cards::cleaner(&secrets);
        let built = build_context(&model, PG, "public", &saved, &clean);
        let all = serde_json::to_string(&built).unwrap();
        assert!(!all.contains('\u{200B}'), "{all}");
        assert!(!all.contains("abcdefghij"), "{all}");
        assert!(built.cards.iter().any(|c| c.table.starts_with("auditlog ")));
        assert_eq!(card(&built, "orders").fk_in.len(), 2);
    }

    #[test]
    fn comment_capped_in_note() {
        let mut model = shop();
        model.tables[0].note = Some(format!("one\u{200B} row {}", "x".repeat(400)));
        model.tables[0].columns[1].note = Some("who\nbought it".into());
        model.enums.push(SmEnum {
            schema: Some("public".into()),
            name: "s".into(),
            values: vec!["a".into()],
        });
        let secrets = crate::ai::rails::Secrets::default();
        let clean = crate::ai::context::cards::cleaner(&secrets);
        let built = build_context(&model, PG, "public", &[], &clean);
        let note = &fts(&built, "t:orders").note;
        let (table_note, column_note) = note.split_at(note.len() - "who bought it".len());
        assert!(table_note.starts_with("one row xxx"), "{note}");
        assert_eq!(table_note.trim_end().chars().count(), 300);
        assert_eq!(column_note, "who bought it");
        assert!(!note.contains('\u{200B}'));
    }
}
