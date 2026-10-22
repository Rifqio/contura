//! Tier 2 retrieval over a stored AI Context, and the evaluation set: generated schemas of
//! 12, 300 and 2,000 tables with their own questions of five kinds each.
#[path = "support/eval_schema.rs"]
mod eval_schema;

use std::path::Path;
use std::time::Instant;

use contura_core::ai::budget::{
    IN_PICKED_AREA, LEFT_OUT, NAME_MATCH, NAMES_ONLY, ONE_KEY, OPEN_TAB, OUTLINE_PICK, SENT_FULL,
    TWO_KEYS, WHOLE_FITS, WORD_MATCH, budget, estimate_tokens,
};
use contura_core::ai::context::build::build_context;
use contura_core::ai::context::outline::{
    OUTLINE_WEAK_SCORE, OutlineRequest, PickReply, TablePicker, should_outline,
};
use contura_core::ai::context::retrieve::{PickSeed, Retrieval, Seeds, retrieve};
use contura_core::ai::context::store::{ContextKey, ContextStore, StoreContext};
use contura_core::ai::context::sync::Purpose;
use contura_core::ai::log::Log;
use contura_core::ai::memory::ThreadStore;
use contura_core::ai::memory::store::StoreThreads;
use contura_core::ai::models::info_for;
use contura_core::ai::preview::{CatalogReader, preview_with_log};
use contura_core::ai::rails::Secrets;
use contura_core::ai::request::{AskRequest, Focus, Switches, TableRef};
use contura_core::ai::sent::OutlineSent;
use contura_core::ai::{AiAccess, AiProviderKind, AiSettings};
use contura_core::error::Result;
use contura_core::model::{ConnectionConfig, ConnectionId, DialectKind, SslMode};
use contura_core::query::{SavedQuery, SavedQueryKind};
use contura_core::schema_model::{SchemaModel, SmColumn, SmTable};
use contura_core::store::AppStore;
use serde::Deserialize;
use uuid::Uuid;

const MY: DialectKind = DialectKind::MySql;

fn keep(text: &str) -> String {
    text.to_string()
}

fn key() -> ContextKey {
    ContextKey {
        connection_id: Uuid::from_u128(7),
        database: "shop".into(),
        schema: String::new(),
    }
}

fn stored_model(model: &SchemaModel, saved: &[SavedQuery]) -> StoreContext {
    let store = StoreContext::new(AppStore::open(Path::new(":memory:")).unwrap());
    let built = build_context(model, model.dialect, "shop", saved, &keep);
    store.replace_context(&key(), &built, None, 1_000).unwrap();
    store
}

fn stored(tables: usize) -> StoreContext {
    stored_model(&eval_schema::schema(tables), &[])
}

/// The schema share of a 32,000-token window with 4,096 max tokens.
fn share() -> u32 {
    budget(32_000, 4_096).schema
}

fn ask(store: &StoreContext, open: &[&str], sql: Option<&str>, question: &str) -> Retrieval {
    ask_with(store, open, sql, question, share(), false, false)
}

fn ask_with(
    store: &StoreContext,
    open: &[&str],
    sql: Option<&str>,
    question: &str,
    schema_tokens: u32,
    with_rows: bool,
    with_saved: bool,
) -> Retrieval {
    let open: Vec<TableRef> = open
        .iter()
        .map(|n| TableRef {
            schema: None,
            name: n.to_string(),
        })
        .collect();
    let seeds = Seeds {
        dialect: MY,
        open_tables: &open,
        texts: sql.into_iter().collect(),
        question,
        picked: &[],
    };
    retrieve(store, &key(), &seeds, schema_tokens, with_rows, with_saved).unwrap()
}

fn reason<'a>(r: &'a Retrieval, table: &str) -> (&'a str, &'a str) {
    r.fit
        .reasons
        .iter()
        .find(|(t, _, _)| t == table)
        .map(|(_, rule, evidence)| (rule.as_str(), evidence.as_str()))
        .unwrap_or_else(|| panic!("{table} not offered"))
}

fn full(r: &Retrieval, table: &str) -> bool {
    r.fit.full.iter().any(|t| t == table)
}

#[test]
fn whole_schema_is_tier_1() {
    let store = stored(12);
    let r = ask(&store, &[], None, "orders per customer");
    assert!(!r.ranked);
    assert_eq!(r.fit.full.len(), 12);
    assert!(r.fit.names_only.is_empty() && r.fit.left_out.is_empty());
    assert_eq!(r.cards.lines().count(), 12);
    assert!(
        r.fit
            .reasons
            .iter()
            .all(|(_, rule, evidence)| rule == WHOLE_FITS && evidence == SENT_FULL)
    );
    // Sorted by name.
    let mut names = r.fit.full.clone();
    names.sort();
    assert_eq!(names, r.fit.full);
    assert!(r.cards.starts_with("customers("));

    let r = ask(&store, &["orders"], None, "");
    assert_eq!(reason(&r, "orders"), (OPEN_TAB, "in the editor"));
    assert_eq!(reason(&r, "customers").0, WHOLE_FITS);
}

#[test]
fn named_tables_come_first() {
    let store = stored(300);
    let r = ask(
        &store,
        &[],
        Some("select * from invoices join customers on customers.id = invoices.cust_id"),
        "why is this slow",
    );
    assert!(r.ranked);
    assert!(full(&r, "invoices") && full(&r, "customers"));
    assert_eq!(reason(&r, "invoices"), (NAME_MATCH, "\"invoices\""));
    assert_eq!(reason(&r, "customers"), (NAME_MATCH, "\"customers\""));
    let first: Vec<&str> = r.fit.reasons[..2]
        .iter()
        .map(|(t, _, _)| t.as_str())
        .collect();
    assert_eq!(first, ["invoices", "customers"]);
    // A singular in the question names the plural table.
    let r = ask(&store, &[], None, "the newest eu_invoice");
    assert_eq!(reason(&r, "eu_invoices"), (NAME_MATCH, "\"eu_invoice\""));
}

#[test]
fn open_tab_is_kept_even_when_unnamed() {
    let store = stored(300);
    let r = ask(&store, &["eu_suppliers"], None, "what is in this table");
    assert!(full(&r, "eu_suppliers"));
    assert_eq!(reason(&r, "eu_suppliers"), (OPEN_TAB, "in the editor"));
    assert_eq!(r.fit.reasons[0].0, "eu_suppliers");
    // An open tab that is also named keeps its first reason.
    let r = ask(&store, &["orders"], Some("select * from orders"), "");
    assert_eq!(reason(&r, "orders").0, OPEN_TAB);
}

#[test]
fn foreign_key_neighbours_follow() {
    let store = stored(300);
    let r = ask(&store, &[], Some("select * from order_items"), "");
    assert_eq!(reason(&r, "order_items").0, NAME_MATCH);
    assert_eq!(reason(&r, "orders"), (ONE_KEY, "from order_items"));
    assert_eq!(reason(&r, "products"), (ONE_KEY, "from order_items"));
    assert_eq!(reason(&r, "customers"), (TWO_KEYS, "from orders"));
    assert_eq!(reason(&r, "invoices"), (TWO_KEYS, "from orders"));
    for t in ["order_items", "orders", "products", "customers", "invoices"] {
        assert!(full(&r, t), "{t}");
    }
    // Nothing further than two keys is ranked: payments is three away.
    assert_eq!(reason(&r, "payments").0, NAMES_ONLY);
}

#[test]
fn demote_before_drop_counts() {
    let store = stored(300);
    let r = ask_with(
        &store,
        &[],
        None,
        "orders and invoices",
        4_000,
        false,
        false,
    );
    assert!(r.ranked);
    assert!(!r.fit.full.is_empty());
    assert!(!r.fit.names_only.is_empty());
    assert!(!r.fit.left_out.is_empty());
    assert_eq!(
        r.fit.full.len() + r.fit.names_only.len() + r.fit.left_out.len(),
        300
    );
    assert_eq!(r.fit.reasons.len(), 300);
    let used: u32 = r.cards.lines().map(|l| estimate_tokens(l, false)).sum();
    assert!(used <= 4_000, "{used}");
    assert_eq!(
        r.cards.lines().count(),
        r.fit.full.len() + r.fit.names_only.len()
    );
    // Full cards first, then the names-only lines, each sorted by name.
    let lines: Vec<&str> = r.cards.lines().collect();
    let tail = &lines[r.fit.full.len()..];
    assert_eq!(tail, r.fit.names_only.as_slice());
    let mut sorted = r.fit.names_only.clone();
    sorted.sort();
    assert_eq!(sorted, r.fit.names_only);
    // An unranked table that did not fit is left out with the budget rule.
    assert!(
        r.fit
            .reasons
            .iter()
            .any(|(t, rule, _)| rule == LEFT_OUT && r.fit.left_out.contains(t))
    );
}

fn saved(name: &str, sql: &str, n: u128) -> SavedQuery {
    SavedQuery {
        id: Uuid::from_u128(n),
        name: name.into(),
        sql: sql.into(),
        updated_at_ms: 0,
        connection_id: None,
        kind: SavedQueryKind::Sql,
        visual_json: None,
    }
}

#[test]
fn saved_queries_follow_the_picked_tables() {
    let mut queries: Vec<SavedQuery> = (0..7)
        .map(|i| {
            saved(
                &format!("unpaid {i}"),
                &format!("select * from invoices where total_amt > {i}"),
                i,
            )
        })
        .collect();
    queries.push(saved("agent load", "select * from agents", 99));
    let store = stored_model(&eval_schema::schema(300), &queries);
    let r = ask_with(
        &store,
        &[],
        Some("select * from invoices"),
        "",
        share(),
        false,
        true,
    );
    assert!(full(&r, "invoices"));
    assert_eq!(r.saved.len(), 5);
    assert!(r.saved.iter().all(|q| q.tables == ["invoices"]));
    // Masked as stored.
    assert!(r.saved.iter().all(|q| q.sql.contains("> ?")));

    // A hit on the query's own name brings it even when its table is not full.
    let r = ask_with(&store, &[], None, "agent load", 0, false, true);
    assert!(r.saved.is_empty(), "no room at all");
    let r = ask_with(&store, &[], None, "load", share(), false, true);
    assert!(r.saved.iter().any(|q| q.name == "agent load"));

    let r = ask_with(
        &store,
        &[],
        Some("select * from invoices"),
        "",
        share(),
        false,
        false,
    );
    assert!(r.saved.is_empty());
}

#[test]
fn rows_card_only_with_rows() {
    let store = stored(300);
    let r = ask_with(
        &store,
        &[],
        Some("select * from orders"),
        "",
        share(),
        false,
        false,
    );
    assert!(full(&r, "orders"));
    assert!(!r.cards.contains("'paid'"));
    assert!(r.cards.contains("enum(…)"));
    let r = ask_with(
        &store,
        &[],
        Some("select * from orders"),
        "",
        share(),
        true,
        false,
    );
    assert!(r.cards.contains("'paid'"));

    let small = stored(12);
    let r = ask_with(&small, &[], None, "", share(), false, false);
    assert!(!r.ranked && !r.cards.contains("'paid'"));
    let r = ask_with(&small, &[], None, "", share(), true, false);
    assert!(!r.ranked && r.cards.contains("'paid'"));
}

#[test]
fn question_with_fts_syntax_still_ranks() {
    let store = stored(300);
    let r = ask(&store, &[], None, "invoices \"paid\" OR NEAR(x*)");
    assert!(r.ranked);
    assert!(full(&r, "invoices"));
    for q in ["\"", "(", "-id col:x", "NEAR(", "AND NOT *"] {
        ask(&store, &[], None, q);
    }
}

fn table(name: &str, columns: &[&str]) -> SmTable {
    SmTable {
        schema: Some("public".into()),
        name: name.into(),
        alias: None,
        note: None,
        columns: columns
            .iter()
            .map(|c| SmColumn {
                name: c.to_string(),
                type_name: "int".into(),
                pk: *c == "id",
                increment: false,
                not_null: false,
                unique: false,
                default: None,
                note: None,
            })
            .collect(),
        indexes: Vec::new(),
    }
}

#[test]
fn case_distinct_tables_both_rank() {
    let mut tables = vec![
        table("Orders", &["id", "legacy_total"]),
        table("orders", &["id", "total"]),
    ];
    tables.extend((0..60).map(|i| table(&format!("t{i:03}"), &["id", "label", "note"])));
    let model = SchemaModel {
        dialect: DialectKind::Postgres,
        tables,
        refs: Vec::new(),
        enums: Vec::new(),
        skipped: Vec::new(),
    };
    let store = stored_model(&model, &[]);
    let seeds_sql = "select * from \"Orders\" o join orders p using (id)";
    for (sql, question) in [(Some(seeds_sql), ""), (None, "orders")] {
        let open: Vec<TableRef> = Vec::new();
        let seeds = Seeds {
            dialect: DialectKind::Postgres,
            open_tables: &open,
            texts: sql.into_iter().collect(),
            question,
            picked: &[],
        };
        let r = retrieve(&store, &key(), &seeds, 200, false, false).unwrap();
        assert!(r.ranked);
        assert!(full(&r, "Orders") && full(&r, "orders"), "{:?}", r.fit);
        assert!(r.cards.contains("legacy_total") && r.cards.contains("total int"));
        assert_eq!(reason(&r, "Orders").0, NAME_MATCH);
        assert_eq!(reason(&r, "orders").0, NAME_MATCH);
    }
}

#[test]
fn same_pick_same_bytes() {
    let store = stored(300);
    let a = ask(&store, &[], None, "invoices with customers");
    let b = ask(&store, &[], None, "customers and their invoices");
    let mut fa = a.fit.full.clone();
    let mut fb = b.fit.full.clone();
    fa.sort();
    fb.sort();
    assert_eq!(fa, fb);
    assert_eq!(a.cards, b.cards);
}

#[derive(Deserialize)]
struct Case {
    schema: usize,
    kind: String,
    question: String,
    sql: Option<String>,
    open: Vec<String>,
    expect: Vec<String>,
}

/// The named questions run under a tight budget: the schema share of an 8,000-token window
/// with 1,024 max tokens, about 30 cards, so naming a table must rank it, not just list it.
fn tight_share() -> u32 {
    budget(8_000, 1_024).schema
}

const KINDS: [&str; 7] = [
    "named",
    "paraphrase",
    "abbrev",
    "fk",
    "prefixed",
    "synonym",
    "vague",
];

/// Recall per kind of question and size. Named questions write the table as it is named
/// (or in another number); the others are paraphrases in the user's own words, questions
/// that reach a table only through an abbreviated column, questions whose tables are only
/// one or two Foreign Keys away, and questions that say a copy's prefix as a word. The
/// floors: named 0.9 under the tight budget, the others pooled 0.75, at 300 and 2,000.
#[test]
fn recall_per_kind_of_question() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("fixtures/ai/retrieval_eval.json")).unwrap();
    let mut failures = Vec::new();
    for size in [12, 300, 2_000] {
        let model = eval_schema::schema(size);
        assert_eq!(model.tables.len(), size);
        let names: Vec<&str> = model.tables.iter().map(|t| t.name.as_str()).collect();
        let store = stored_model(&model, &[]);
        let mine: Vec<&Case> = cases.iter().filter(|c| c.schema == size).collect();
        if size > 12 {
            assert!(mine.len() >= 36, "{size}: {} questions", mine.len());
        }
        let mut found = [0usize; KINDS.len()];
        let mut wanted = [0usize; KINDS.len()];
        for c in &mine {
            let k = KINDS
                .iter()
                .position(|k| *k == c.kind)
                .expect("a known kind");
            for e in &c.expect {
                assert!(
                    names.contains(&e.as_str()),
                    "{e} is not in the {size} schema"
                );
            }
            let open: Vec<&str> = c.open.iter().map(String::as_str).collect();
            let share = if c.kind == "named" {
                tight_share()
            } else {
                share()
            };
            let r = ask_with(
                &store,
                &open,
                c.sql.as_deref(),
                &c.question,
                share,
                false,
                false,
            );
            wanted[k] += c.expect.len();
            let missed: Vec<&String> = c.expect.iter().filter(|e| !full(&r, e)).collect();
            found[k] += c.expect.len() - missed.len();
            if !missed.is_empty() {
                println!("{size} {}: missed {missed:?} for {:?}", c.kind, c.question);
            }
        }
        let recall = |k: usize| found[k] as f64 / wanted[k].max(1) as f64;
        for (k, kind) in KINDS.iter().enumerate() {
            println!(
                "{size} tables, {kind}: {}/{} = {:.2}",
                found[k],
                wanted[k],
                recall(k)
            );
        }
        let other = found[1..5].iter().sum::<usize>() as f64
            / wanted[1..5].iter().sum::<usize>().max(1) as f64;
        println!("{size} tables, all but named: {other:.2}");
        if size == 12 {
            // Tier 1: everything goes.
            assert_eq!(found, wanted, "12 tables");
            continue;
        }
        if recall(0) < 0.9 {
            failures.push(format!(
                "{size} tables: named recall {:.2} < 0.90",
                recall(0)
            ));
        }
        if other < 0.75 {
            failures.push(format!("{size} tables: other recall {other:.2} < 0.75"));
        }
        if recall(5) < 0.8 {
            failures.push(format!(
                "{size} tables: synonym recall {:.2} < 0.80",
                recall(5)
            ));
        }
    }
    assert!(failures.is_empty(), "{failures:?}");
}

fn pick(table: &str, rule: &'static str, evidence: &str) -> PickSeed {
    PickSeed {
        table: table.into(),
        rule,
        evidence: evidence.into(),
    }
}

fn ask_picked(
    store: &StoreContext,
    sql: Option<&str>,
    question: &str,
    picked: &[PickSeed],
) -> Retrieval {
    let open: Vec<TableRef> = Vec::new();
    let seeds = Seeds {
        dialect: MY,
        open_tables: &open,
        texts: sql.into_iter().collect(),
        question,
        picked,
    };
    retrieve(store, &key(), &seeds, share(), false, false).unwrap()
}

#[test]
fn picked_seeds_rank_after_names() {
    let store = stored(300);
    let picked = [
        pick("payments", OUTLINE_PICK, "named by the model"),
        pick("refunds", OUTLINE_PICK, "named by the model"),
    ];
    let r = ask_picked(
        &store,
        Some("select * from invoices"),
        "total per customer",
        &picked,
    );
    assert!(r.ranked && r.named);
    assert!(full(&r, "payments") && full(&r, "refunds"));
    assert_eq!(reason(&r, "payments"), (OUTLINE_PICK, "named by the model"));
    assert_eq!(reason(&r, "refunds"), (OUTLINE_PICK, "named by the model"));
    let at = |t: &str| r.fit.reasons.iter().position(|(n, _, _)| n == t).unwrap();
    assert_eq!(at("invoices"), 0, "the named table comes first");
    assert!(at("customers") < at("payments"), "name match before picks");
    assert_eq!(at("refunds"), at("payments") + 1);
    for (t, rule, _) in &r.fit.reasons {
        if rule == WORD_MATCH || rule == ONE_KEY || rule == TWO_KEYS {
            assert!(at(t) > at("refunds"), "{t} ranked before the picks");
        }
    }
    // A table already ranked keeps its first reason.
    let again = [pick("invoices", OUTLINE_PICK, "named by the model")];
    let r = ask_picked(&store, Some("select * from invoices"), "", &again);
    assert_eq!(reason(&r, "invoices").0, NAME_MATCH);
    // Tier 1 ignores the picks.
    let small = stored(12);
    let r = ask_picked(&small, None, "", &picked);
    assert!(!r.ranked);
    assert!(r.fit.reasons.iter().all(|(_, rule, _)| rule == WHOLE_FITS));
}

#[test]
fn picked_area_tables_follow() {
    let store = stored(300);
    let picked = [
        pick("payments", OUTLINE_PICK, "named by the model"),
        pick("refunds", IN_PICKED_AREA, "area orders"),
        pick("keys", IN_PICKED_AREA, "area orders"),
    ];
    let r = ask_picked(&store, None, "", &picked);
    assert_eq!(reason(&r, "refunds"), (IN_PICKED_AREA, "area orders"));
    assert_eq!(reason(&r, "keys"), (IN_PICKED_AREA, "area orders"));
    let at = |t: &str| r.fit.reasons.iter().position(|(n, _, _)| n == t).unwrap();
    assert!(at("payments") < at("refunds") && at("refunds") < at("keys"));
    assert!(!r.named, "picks are not name matches");
}

#[test]
fn context_for_2000_tables_is_small_and_quick() {
    let model = eval_schema::schema(2_000);
    let store = StoreContext::new(AppStore::open(Path::new(":memory:")).unwrap());
    let built = build_context(&model, MY, "shop", &[], &keep);
    drop(model);
    let meta = store.replace_context(&key(), &built, None, 1_000).unwrap();
    assert_eq!(meta.table_count, 2_000);
    assert!(meta.bytes < 8 * 1024 * 1024, "{} bytes", meta.bytes);

    let started = Instant::now();
    let r = ask(
        &store,
        &["eu_orders"],
        Some("select * from invoices join customers on customers.id = invoices.cust_id"),
        "unpaid invoices per customer with the order quantity",
    );
    let took = started.elapsed();
    let limit_ms = if cfg!(debug_assertions) { 5_000 } else { 500 };
    assert!(took.as_millis() < limit_ms, "retrieve took {took:?}");
    assert!(r.ranked);
    assert_eq!(r.fit.reasons.len(), 2_000);
    assert!(r.best_score.is_some_and(|s| s > 0.0));
    println!(
        "2,000 tables: {} bytes stored, retrieve {took:?}",
        meta.bytes
    );
}

/// Copies of one table under prefixes (`archive_timesheets`, `euTimesheets`, ...) all hit
/// the same comment word; they must not fill the hit limit before another table's hit.
/// "per day" hits every timesheets copy, "checkout" only the orders tables.
#[test]
fn prefixed_copies_cannot_flood_the_hits() {
    let store = stored(2_000);
    let r = ask(&store, &[], None, "Checkout count per day");
    assert!(full(&r, "orders"), "{:?}", r.fit.full);
    assert!(full(&r, "timesheets"), "{:?}", r.fit.full);
    assert_eq!(reason(&r, "orders").0, contura_core::ai::budget::WORD_MATCH);
}

// ---- Tier 3: when the outline triggers and what the picks lift ----

fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("fixtures/ai/retrieval_eval.json")).unwrap()
}

fn open_of(c: &Case) -> Vec<&str> {
    c.open.iter().map(String::as_str).collect()
}

/// With the outline's own window and the Privacy switch on, over the real fixture: only the
/// vague questions (no name, no word, no abbreviation, no synonym) ask the model for help.
/// Prints the lowest and highest best score of each kind: the weak score sits between the
/// highest vague score and the lowest score of the questions that must not trigger.
#[test]
fn outline_trigger_by_kind() {
    let cases = cases();
    let mut failures = Vec::new();
    for size in [300, 2_000] {
        let store = stored(size);
        // (lowest, highest) best score of the kind's questions that tier 2 did not name.
        let mut range: Vec<(f64, f64)> = vec![(f64::MAX, f64::MIN); KINDS.len()];
        for c in cases.iter().filter(|c| c.schema == size) {
            let k = KINDS.iter().position(|k| *k == c.kind).unwrap();
            let r = ask_with(
                &store,
                &open_of(c),
                c.sql.as_deref(),
                &c.question,
                share(),
                false,
                false,
            );
            let triggers = should_outline(size as u32, &r, 32_000, true);
            if !r.named {
                let s = r.best_score.unwrap_or(0.0);
                range[k] = (range[k].0.min(s), range[k].1.max(s));
            }
            match c.kind.as_str() {
                "named" | "abbrev" | "prefixed" if triggers => failures.push(format!(
                    "{size} {}: {:?} triggers (score {:?})",
                    c.kind, c.question, r.best_score
                )),
                "vague" if !triggers => failures.push(format!(
                    "{size} vague: {:?} does not trigger (named {}, score {:?})",
                    c.question, r.named, r.best_score
                )),
                _ => {}
            }
        }
        for (k, kind) in KINDS.iter().enumerate() {
            if range[k].0 <= range[k].1 {
                println!(
                    "{size} tables, {kind}: best score {:.2} to {:.2} (weak below {OUTLINE_WEAK_SCORE})",
                    range[k].0, range[k].1
                );
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// Answers each question's expected tables as the model's JSON reply.
struct Oracle<'a> {
    cases: &'a [Case],
}

#[async_trait::async_trait]
impl TablePicker for Oracle<'_> {
    async fn pick(&self, req: &OutlineRequest, _log: &mut Log) -> Result<PickReply> {
        let case = self
            .cases
            .iter()
            .find(|c| req.turn.contains(&c.question))
            .expect("a question of the fixture");
        // The outline goes out with its lines every time (a live call once looked nearly
        // empty: that was the provider reporting cached prompt tokens as not input).
        assert!(req.outline.len() > 8_000, "{} bytes", req.outline.len());
        assert!(req.system.contains("Do not answer the question."));
        Ok(PickReply {
            text: serde_json::json!({ "areas": [], "tables": case.expect }).to_string(),
            sent: OutlineSent::default(),
        })
    }
}

/// The smallest catalog the Ask needs: one Connection and the generated schema.
struct Catalog {
    schema: SchemaModel,
    context: StoreContext,
    threads: StoreThreads,
}

#[async_trait::async_trait]
impl CatalogReader for Catalog {
    async fn connection_config(&self, id: ConnectionId) -> Result<Option<ConnectionConfig>> {
        Ok(Some(ConnectionConfig {
            id,
            name: "Shop".into(),
            dialect: MY,
            host: "127.0.0.1".into(),
            port: 3306,
            user: "app".into(),
            database: Some("shop".into()),
            ssl: SslMode::Disable,
            group_id: None,
            file: None,
            query_timeout_secs: None,
            ai_access: AiAccess::Schema,
            ai_sync: Default::default(),
            production: false,
            read_only: false,
        }))
    }

    async fn schema_snapshot(
        &self,
        _id: ConnectionId,
        _database: &str,
        _schema: Option<&str>,
    ) -> Result<SchemaModel> {
        Ok(self.schema.clone())
    }

    async fn schema_fingerprint(
        &self,
        _id: ConnectionId,
        _database: &str,
        _schema: Option<&str>,
    ) -> Result<String> {
        Ok("fp:1".into())
    }

    fn context(&self) -> &dyn ContextStore {
        &self.context
    }

    fn threads(&self) -> &dyn ThreadStore {
        &self.threads
    }
}

fn ask_request(question: &str) -> AskRequest {
    AskRequest {
        request_id: "r1".into(),
        place: "ungrouped".into(),
        group_id: None,
        connection_id: Some(Uuid::from_u128(42)),
        database: Some("shop".into()),
        schema: None,
        action: "ask".into(),
        question: question.into(),
        thread_id: None,
        focus: Focus::default(),
        switches: Switches::default(),
        off: Vec::new(),
        model: None,
        picks: None,
    }
}

/// An Ask over `catalog` at a 32,000 token window, with the oracle as the picker.
async fn ask_through_the_oracle(catalog: &Catalog, oracle: &Oracle<'_>, c: &Case) -> Vec<String> {
    let settings = AiSettings {
        provider: Some(AiProviderKind::Groq),
        model: "llama-3.3-70b-versatile".into(),
        ..AiSettings::default()
    };
    let mut model = info_for(AiProviderKind::Groq, None, &settings.model, None, &settings);
    model.context_window = 32_000;
    let p = preview_with_log(
        catalog,
        &settings,
        &model,
        &Secrets::default(),
        &ask_request(&c.question),
        Purpose::Ask,
        Some(oracle),
        &mut Log::new(),
    )
    .await
    .unwrap();
    if let Some(o) = &p.outline {
        println!(
            "outline for {:?}: {} bytes, about {} tokens, {} areas, level {}",
            c.question,
            o.exact.len(),
            estimate_tokens(&o.exact, false),
            o.areas,
            o.level
        );
    }
    p.tables.full
}

/// A picker that is always right lifts the vague questions to full recall and does not
/// cost the paraphrases the recall tier 2 gave them.
#[tokio::test]
async fn oracle_pick_lifts_vague_recall() {
    let cases = cases();
    for size in [300, 2_000] {
        let model = eval_schema::schema(size);
        let store = stored_model(&model, &[]);
        let catalog = Catalog {
            schema: model,
            context: StoreContext::new(AppStore::open(Path::new(":memory:")).unwrap()),
            threads: StoreThreads::new(AppStore::open(Path::new(":memory:")).unwrap()),
        };
        let oracle = Oracle { cases: &cases };
        for kind in ["vague", "paraphrase"] {
            let (mut base, mut picked, mut wanted) = (0usize, 0usize, 0usize);
            for c in cases.iter().filter(|c| c.schema == size && c.kind == kind) {
                let r = ask_with(
                    &store,
                    &open_of(c),
                    c.sql.as_deref(),
                    &c.question,
                    share(),
                    false,
                    false,
                );
                let after = ask_through_the_oracle(&catalog, &oracle, c).await;
                wanted += c.expect.len();
                base += c.expect.iter().filter(|e| full(&r, e)).count();
                picked += c.expect.iter().filter(|e| after.contains(e)).count();
            }
            let recall = |n: usize| n as f64 / wanted.max(1) as f64;
            println!(
                "{size} tables, {kind}: tier 2 {:.2}, with the oracle's picks {:.2}",
                recall(base),
                recall(picked)
            );
            if kind == "vague" {
                assert_eq!(picked, wanted, "{size}: vague recall with the oracle");
                assert!(picked > base, "{size}: the picks lifted nothing");
            } else {
                assert!(picked >= base, "{size}: paraphrase recall dropped");
            }
        }
    }
}

#[test]
fn named_excludes_neighbours_and_word_hits() {
    let store = stored(300);
    let r = ask(
        &store,
        &[],
        Some("select * from invoices"),
        "customers with the biggest overdue amount",
    );
    assert!(r.ranked);
    let names: Vec<&str> = r.named_tables.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(names, ["invoices", "customers"]);
    // A table only one key away or hit by a word is ranked but not named.
    assert!(r.fit.reasons.iter().any(|(_, rule, _)| rule == ONE_KEY));
    assert!(r.fit.reasons.iter().any(|(_, rule, _)| rule == WORD_MATCH));
    assert!(
        r.named_tables
            .iter()
            .all(|(t, _)| full(&r, t) || r.fit.names_only.contains(t))
    );
}

#[test]
fn named_in_tier_1() {
    let store = stored(12);
    let r = ask(
        &store,
        &["orders"],
        Some("select * from customers"),
        "why is this slow",
    );
    assert!(!r.ranked);
    assert_eq!(
        r.named_tables,
        [
            ("orders".to_string(), OPEN_TAB),
            ("customers".to_string(), NAME_MATCH)
        ]
    );
}
