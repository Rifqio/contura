//! Tier 2: picking the tables an Ask sends from a stored AI Context. Open tabs, then
//! names the editor text or the question holds, then FTS5 BM25 hits of the question's
//! words, then Foreign Key neighbours; each picked table goes in full while it fits the
//! schema share, else names only, else it is left out (demote before drop).

use std::collections::HashMap;
use std::ops::Range;

use crate::ai::budget::{
    LEFT_OUT, NAME_MATCH, NAMES_ONLY, ONE_KEY, OPEN_TAB, SENT_FULL, SENT_NAME, SENT_NONE, TWO_KEYS,
    TableFit, WHOLE_FITS, WORD_MATCH, estimate_tokens,
};
use crate::ai::context::build::split_words;
use crate::ai::context::store::{ContextKey, ContextStore, FtsHit, GraphRow, StoredSavedQuery};
use crate::ai::request::TableRef;
use crate::error::Result;
use crate::model::DialectKind;
use crate::safety::identifiers;

/// Column-name abbreviations and the word each stands for.
pub const ABBREVIATIONS: &[(&str, &str)] = &[
    ("qty", "quantity"),
    ("cust", "customer"),
    ("addr", "address"),
    ("amt", "amount"),
    ("desc", "description"),
    ("dept", "department"),
    ("emp", "employee"),
    ("inv", "invoice"),
    ("num", "number"),
    ("prod", "product"),
    ("txn", "transaction"),
    ("acct", "account"),
    ("org", "organization"),
    ("cat", "category"),
    ("msg", "message"),
    ("pmt", "payment"),
    ("usr", "user"),
    ("ord", "order"),
];

/// A table the outline step picked, and why: ranked after the name matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickSeed {
    pub table: String,
    pub rule: &'static str,
    pub evidence: String,
}

/// What a person says and the word a schema uses for it; one direction only.
pub const SYNONYMS: &[(&str, &str)] = &[
    ("client", "customer"),
    ("buyer", "customer"),
    ("shopper", "customer"),
    ("purchaser", "customer"),
    ("patron", "customer"),
    ("vendor", "supplier"),
    ("staff", "employee"),
    ("worker", "employee"),
    ("personnel", "employee"),
    ("bill", "invoice"),
    ("charge", "payment"),
    ("goods", "product"),
    ("merchandise", "product"),
    ("item", "product"),
    ("visit", "session"),
    ("team", "department"),
    ("wage", "payroll"),
    ("salary", "payroll"),
    // Not "return": an everyday verb ("Return the top customers") that would pull refunds
    // into unrelated questions (Ruling 14, a deviation from the plan's list).
];

/// What the Ask came with: the open tables and the text the gate let through (SQL,
/// selection, error and filter text), and the question.
pub struct Seeds<'a> {
    pub dialect: DialectKind,
    pub open_tables: &'a [TableRef],
    pub texts: Vec<&'a str>,
    pub question: &'a str,
    /// Tables the outline step picked, in order; tier 1 ignores them.
    pub picked: &'a [PickSeed],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Retrieval {
    /// The full cards sorted by name, then the names-only lines sorted by name, one per line.
    pub cards: String,
    /// The same lines as (table, line) in rank order, the order of `fit.reasons`: the
    /// 200 KB cut drops the last of these first, so the lowest-ranked tables go first.
    pub lines: Vec<(String, String)>,
    pub fit: TableFit,
    pub saved: Vec<StoredSavedQuery>,
    /// The best FTS score of the question's words, when they were searched.
    pub best_score: Option<f64>,
    /// Whether tier 2 picked the tables (the whole schema did not fit).
    pub ranked: bool,
    /// Whether any table got a name match (open tabs do not count).
    pub named: bool,
}

/// Words a question holds that say nothing about which table it means.
const STOPWORDS: &[&str] = &[
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "by", "with", "from", "per",
    "show", "list", "find", "get", "all", "each", "which", "what", "how", "many", "much", "me",
    "my", "is", "are", "was", "were", "be", "this", "that", "these", "those", "it", "do", "does",
    "did", "can", "could", "should", "would", "will", "give", "write", "make", "there", "their",
    "them", "they", "we", "us", "our", "you", "your", "not", "no", "has", "have", "had", "at",
    "as", "into", "than", "then", "why", "when", "where", "who", "please",
];

/// At most this many FTS terms per question.
const MAX_TERMS: usize = 32;
/// FTS hits used per Ask.
const HIT_LIMIT: usize = 50;
/// FTS hits read per Ask, before copies of one table are folded together.
const HIT_READ: usize = 500;
/// Saved queries sent at most.
const MAX_SAVED: usize = 5;

/// Whether `word` ends in a sibilant that takes `es` in the plural: `s`, `x`, `z`,
/// `ch`, `sh`.
fn sibilant(word: &str) -> bool {
    ["s", "x", "z", "ch", "sh"]
        .iter()
        .any(|end| word.ends_with(end))
}

fn vowel(c: char) -> bool {
    matches!(c, 'a' | 'e' | 'i' | 'o' | 'u')
}

/// The singulars `word` may stand for; empty when it does not look plural. Where the
/// ending does not say which, both go: `warehouses` gives `warehouse` and `warehous`,
/// `boxes` gives `boxe` and `box`, `movies` gives `movie` and `movy`. A word in `ss` or
/// `us` is taken as singular.
fn singulars(word: &str) -> Vec<String> {
    let mut out = Vec::new();
    if word.len() < 3 || word.ends_with("ss") || word.ends_with("us") || !word.ends_with('s') {
        return out;
    }
    let drop_s = &word[..word.len() - 1];
    out.push(drop_s.to_string());
    if let Some(stem) = word.strip_suffix("ies")
        && stem.chars().last().is_some_and(|c| !vowel(c))
    {
        out.push(format!("{stem}y"));
    } else if let Some(stem) = word.strip_suffix("es")
        && sibilant(stem)
    {
        out.push(stem.to_string());
    }
    out
}

/// `word` (taken as singular) in the plural: a consonant then `y` takes `ies` (`category`),
/// a vowel then `y` takes `s` (`key`), a sibilant takes `es` (`box`), else `s`.
fn plural(word: &str) -> String {
    let mut rev = word.chars().rev();
    match (rev.next(), rev.next()) {
        (Some('y'), Some(c)) if !vowel(c) => format!("{}ies", &word[..word.len() - 1]),
        _ if sibilant(word) => format!("{word}es"),
        _ => format!("{word}s"),
    }
}

/// A word, the singulars it may stand for, and the plural of each and of the word itself,
/// without repeats: every candidate goes rather than a guess at one.
fn forms(word: &str) -> Vec<String> {
    let mut out = vec![word.to_string()];
    let mut push = |w: String| {
        if !out.contains(&w) {
            out.push(w);
        }
    };
    let ones = singulars(word);
    for one in &ones {
        push(one.clone());
        push(plural(one));
    }
    if ones.is_empty() {
        push(plural(word));
    }
    out
}

/// The words of `text` as written: runs of letters, digits and `_`.
fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
}

/// The lower-cased words of a question of two characters or more, minus the stopwords;
/// a name with `_` also in its parts. Each comes with its `forms` and the other side of
/// an abbreviation in its forms (`qty`, and `quantity`, `quantities`), then the forms of
/// the schema word of each synonym found (`clients`, and `customer`, `customers`).
/// Deduplicated, at most 32.
pub fn question_terms(question: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |w: String| {
        if !out.contains(&w) {
            out.push(w);
        }
    };
    let lower = question.to_lowercase();
    let mut base: Vec<&str> = Vec::new();
    for w in words(&lower) {
        base.push(w);
        if w.contains('_') {
            base.extend(w.split('_'));
        }
    }
    for w in base {
        if w.chars().count() < 2 || STOPWORDS.contains(&w) {
            continue;
        }
        let all = forms(w);
        for form in &all {
            push(form.clone());
        }
        for (short, long) in ABBREVIATIONS {
            let other = if all.iter().any(|f| f == short) {
                long
            } else if all.iter().any(|f| f == long) {
                short
            } else {
                continue;
            };
            for form in forms(other) {
                push(form);
            }
        }
        for (said, schema) in SYNONYMS {
            if all.iter().any(|f| f == said) {
                for form in forms(schema) {
                    push(form);
                }
            }
        }
    }
    out.truncate(MAX_TERMS);
    out
}

/// A table offered in tier 2, with its reason.
struct Ranked {
    table: usize,
    rule: &'static str,
    evidence: String,
}

/// The graph's tables by name, and by lower-cased name.
struct Index<'g> {
    exact: HashMap<&'g str, usize>,
    folded: HashMap<String, Vec<usize>>,
}

impl<'g> Index<'g> {
    fn new(graph: &'g [GraphRow]) -> Self {
        let mut exact = HashMap::new();
        let mut folded: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, row) in graph.iter().enumerate() {
            exact.insert(row.table.as_str(), i);
            folded.entry(row.table.to_lowercase()).or_default().push(i);
        }
        Self { exact, folded }
    }
}

/// The ranked tables in order; a table keeps the first reason it gets.
struct Ranking<'g> {
    graph: &'g [GraphRow],
    picked: Vec<Ranked>,
    seen: Vec<bool>,
}

impl<'g> Ranking<'g> {
    fn new(graph: &'g [GraphRow]) -> Self {
        Self {
            graph,
            picked: Vec::new(),
            seen: vec![false; graph.len()],
        }
    }

    fn add(&mut self, table: usize, rule: &'static str, evidence: impl FnOnce() -> String) {
        if !self.seen[table] {
            self.seen[table] = true;
            self.picked.push(Ranked {
                table,
                rule,
                evidence: evidence(),
            });
        }
    }

    /// The tables one Foreign Key away from `picked[from]`, `fk_out` before `fk_in`.
    fn neighbours(&mut self, from: Range<usize>, rule: &'static str, index: &Index) {
        let graph = self.graph;
        for i in from {
            let row = &graph[self.picked[i].table];
            for other in row.fk_out.iter().chain(&row.fk_in) {
                if let Some(&j) = index.exact.get(other.as_str()) {
                    self.add(j, rule, || format!("from {}", row.table));
                }
            }
        }
    }
}

/// The hits with copies of one table folded together, at most `HIT_LIMIT`: the best hit
/// of each family first (on equal scores the shortest name), then the other members while
/// there is room. A table's family is the longest part of its name, after leading words,
/// that names another table (`archive10_timesheets` and `euTimesheets` are copies of
/// `timesheets`), else the table itself. So prefixed copies hitting one word cannot fill
/// the limit before another table's hit.
fn fold_copies(hits: Vec<FtsHit>, graph: &[GraphRow]) -> Vec<FtsHit> {
    let tables: std::collections::HashSet<String> = graph
        .iter()
        .map(|r| split_words(&r.table).join(" "))
        .collect();
    let family = |node: &str| -> String {
        let Some(name) = node.strip_prefix("t:") else {
            return node.to_string();
        };
        let words = split_words(name);
        (1..words.len())
            .map(|k| words[k..].join(" "))
            .find(|base| tables.contains(base))
            .unwrap_or_else(|| words.join(" "))
    };
    let mut hits = hits;
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.node_id.len().cmp(&b.node_id.len()))
            .then_with(|| a.node_id.cmp(&b.node_id))
    });
    let mut seen = std::collections::HashSet::new();
    let (mut best, mut rest): (Vec<FtsHit>, Vec<FtsHit>) = (Vec::new(), Vec::new());
    for hit in hits {
        if seen.insert(family(&hit.node_id)) {
            best.push(hit);
        } else {
            rest.push(hit);
        }
    }
    best.extend(rest);
    best.truncate(HIT_LIMIT);
    best
}

/// What a full table costs: its card, or with `with_rows` the card with enum values.
fn cost(row: &GraphRow, with_rows: bool) -> u32 {
    if with_rows && row.rows_tokens > 0 {
        row.rows_tokens
    } else {
        row.tokens
    }
}

fn reason(table: &str, rule: &str, evidence: &str) -> (String, String, String) {
    (table.to_string(), rule.to_string(), evidence.to_string())
}

/// Places tables in the share: in full while a card fits what is left, else a names-only
/// line while those fit, else left out. Once one is left out, the names-only lines stop,
/// so they stay a prefix of the demoted tables.
struct Filler {
    share: u32,
    used: u32,
    dropped: bool,
    fit: TableFit,
}

impl Filler {
    /// `card` 0 offers the table as names only. Returns how it was sent.
    fn place(&mut self, name: &str, card: u32) -> &'static str {
        if card > 0 && self.used.saturating_add(card) <= self.share {
            self.used += card;
            self.fit.full.push(name.to_string());
            return SENT_FULL;
        }
        let line = estimate_tokens(name, false);
        if !self.dropped && self.used.saturating_add(line) <= self.share {
            self.used += line;
            self.fit.names_only.push(name.to_string());
            SENT_NAME
        } else {
            self.dropped = true;
            self.fit.left_out.push(name.to_string());
            SENT_NONE
        }
    }
}

/// Every name the editor text and the question hold: the text's identifiers, then the
/// question's words, as written.
fn named_words(seeds: &Seeds) -> Vec<String> {
    let mut named: Vec<String> = Vec::new();
    let all = seeds
        .texts
        .iter()
        .flat_map(|t| identifiers(seeds.dialect, t))
        .chain(words(seeds.question).map(String::from));
    for w in all {
        if !named.contains(&w) {
            named.push(w);
        }
    }
    named
}

/// The tables and saved queries an Ask sends from the Context at `key`.
///
/// Tier 1: when every card fits `schema_tokens`, all go in full. Tier 2 ranks tables by
/// open tab, name match, word match (BM25), then one and two Foreign Keys away; each
/// ranked table goes in full while it fits what is left, else names only, else it is left
/// out; every other table follows by name as names only while those fit. Only the full
/// tables' cards are read. With `with_saved`, the saved queries on a full table or hit by
/// the question follow the cards while they fit, at most 5.
pub fn retrieve(
    store: &dyn ContextStore,
    key: &ContextKey,
    seeds: &Seeds,
    schema_tokens: u32,
    with_rows: bool,
    with_saved: bool,
) -> Result<Retrieval> {
    let graph = store.context_graph(key)?;
    let index = Index::new(&graph);
    let mut ranking = Ranking::new(&graph);

    for open in seeds.open_tables {
        let here = open
            .schema
            .as_deref()
            .is_none_or(|s| key.schema.is_empty() || s == key.schema);
        let hit = index.exact.get(open.name.as_str()).copied().or_else(|| {
            index
                .folded
                .get(&open.name.to_lowercase())
                .and_then(|v| v.first().copied())
        });
        if let (true, Some(i)) = (here, hit) {
            ranking.add(i, OPEN_TAB, || "in the editor".into());
        }
    }

    let whole: u64 = graph.iter().map(|r| u64::from(cost(r, with_rows))).sum();
    let ranked = whole > u64::from(schema_tokens);
    let mut hits: Vec<FtsHit> = Vec::new();
    let mut filler = Filler {
        share: schema_tokens,
        used: 0,
        dropped: false,
        fit: TableFit::default(),
    };
    if !ranked {
        let fit = &mut filler.fit;
        for r in &ranking.picked {
            fit.reasons
                .push(reason(&graph[r.table].table, r.rule, &r.evidence));
        }
        for (i, row) in graph.iter().enumerate() {
            if !ranking.seen[i] {
                fit.reasons.push(reason(&row.table, WHOLE_FITS, SENT_FULL));
            }
            fit.full.push(row.table.clone());
        }
        filler.used = u32::try_from(whole).unwrap_or(u32::MAX);
    } else {
        let named = named_words(seeds);
        for w in &named {
            for form in forms(w) {
                if let Some(&i) = index.exact.get(form.as_str()) {
                    ranking.add(i, NAME_MATCH, || format!("\"{w}\""));
                }
            }
        }
        for w in &named {
            for form in forms(&w.to_lowercase()) {
                for &i in index.folded.get(&form).into_iter().flatten() {
                    ranking.add(i, NAME_MATCH, || format!("\"{w}\""));
                }
            }
        }

        for p in seeds.picked {
            if let Some(&i) = index.exact.get(p.table.as_str()) {
                ranking.add(i, p.rule, || p.evidence.clone());
            }
        }

        let read = store.search_context(key, &question_terms(seeds.question), HIT_READ)?;
        hits = fold_copies(read, &graph);
        for hit in &hits {
            if let Some(name) = hit.node_id.strip_prefix("t:")
                && let Some(&i) = index.exact.get(name)
            {
                ranking.add(i, WORD_MATCH, || format!("bm25 {:.1}", hit.score));
            }
        }

        let first = ranking.picked.len();
        ranking.neighbours(0..first, ONE_KEY, &index);
        let second = ranking.picked.len();
        ranking.neighbours(first..second, TWO_KEYS, &index);

        for r in &ranking.picked {
            let row = &graph[r.table];
            filler.place(&row.table, cost(row, with_rows));
            filler
                .fit
                .reasons
                .push(reason(&row.table, r.rule, &r.evidence));
        }
        for (i, row) in graph.iter().enumerate() {
            if ranking.seen[i] {
                continue;
            }
            let (rule, sent) = match filler.place(&row.table, 0) {
                SENT_NAME => (NAMES_ONLY, SENT_NAME),
                _ => (LEFT_OUT, SENT_NONE),
            };
            filler.fit.reasons.push(reason(&row.table, rule, sent));
        }
        filler.fit.full.sort();
        filler.fit.names_only.sort();
    }

    let full_cards = store.context_cards(key, &filler.fit.full)?;
    let mut lines: Vec<&str> = full_cards
        .iter()
        .map(|c| {
            if with_rows && !c.card_rows.is_empty() {
                c.card_rows.as_str()
            } else {
                c.card.as_str()
            }
        })
        .collect();
    lines.extend(filler.fit.names_only.iter().map(String::as_str));
    let cards = lines.join("\n");
    let mut line_of: HashMap<&str, &str> = full_cards
        .iter()
        .zip(&lines)
        .map(|(c, line)| (c.table.as_str(), *line))
        .collect();
    for name in &filler.fit.names_only {
        line_of.insert(name.as_str(), name.as_str());
    }
    let ranked_lines = filler
        .fit
        .reasons
        .iter()
        .filter_map(|(table, _, _)| {
            line_of
                .get(table.as_str())
                .map(|line| (table.clone(), line.to_string()))
        })
        .collect();

    let saved = if with_saved {
        pick_saved(store.context_saved(key)?, &hits, &mut filler)
    } else {
        Vec::new()
    };

    Ok(Retrieval {
        cards,
        lines: ranked_lines,
        fit: filler.fit,
        saved,
        best_score: hits.first().map(|h| h.score),
        ranked,
        named: ranking.picked.iter().any(|r| r.rule == NAME_MATCH),
    })
}

/// The saved queries hit by the question (best first), then those on a full table (by
/// name), each while `<name>: <sql>` fits what the cards left; at most 5, never demoted.
fn pick_saved(
    all: Vec<StoredSavedQuery>,
    hits: &[FtsHit],
    filler: &mut Filler,
) -> Vec<StoredSavedQuery> {
    let rank = |q: &StoredSavedQuery| {
        let node = format!("q:{}", q.id);
        hits.iter().position(|h| h.node_id == node)
    };
    let mut candidates: Vec<(Option<usize>, StoredSavedQuery)> = all
        .into_iter()
        .map(|q| (rank(&q), q))
        .filter(|(hit, q)| hit.is_some() || q.tables.iter().any(|t| filler.fit.full.contains(t)))
        .collect();
    // Stable: the queries that were not hit keep their order by name.
    candidates.sort_by_key(|(hit, _)| hit.unwrap_or(usize::MAX));
    let mut out = Vec::new();
    for (_, q) in candidates {
        if out.len() == MAX_SAVED {
            break;
        }
        let tokens = estimate_tokens(&format!("{}: {}", q.name, q.sql), false);
        if filler.used.saturating_add(tokens) <= filler.share {
            filler.used += tokens;
            out.push(q);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has(terms: &[String], word: &str) -> bool {
        terms.iter().any(|t| t == word)
    }

    #[test]
    fn question_terms_cases() {
        let terms = question_terms("How many qty per customer invoices?");
        for word in [
            "quantity",
            "customer",
            "customers",
            "invoice",
            "invoices",
            "qty",
        ] {
            assert!(has(&terms, word), "{word} missing from {terms:?}");
        }
        for word in ["how", "many", "per", "?"] {
            assert!(!has(&terms, word), "{word} in {terms:?}");
        }
        // Lower-cased, two characters or more, no duplicates.
        let terms = question_terms("Show A list of Categories and Boxes and boxes x");
        assert!(has(&terms, "categories"));
        assert!(has(&terms, "category"));
        assert!(has(&terms, "box"));
        assert!(!has(&terms, "x"));
        assert!(!has(&terms, "a"));
        assert!(terms.iter().all(|t| *t == t.to_lowercase()));
        let mut seen = terms.clone();
        seen.dedup();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), terms.len());
        // A name with an underscore is kept whole and in its parts.
        let terms = question_terms("rows of eu_invoices");
        assert!(has(&terms, "eu_invoices"));
        assert!(has(&terms, "invoices"));
        // At most 32.
        let long: Vec<String> = (0..40).map(|i| format!("word{i}")).collect();
        assert_eq!(question_terms(&long.join(" ")).len(), 32);
        assert!(question_terms("").is_empty());
    }

    #[test]
    fn plural_rules_cover_common_words() {
        let has_form = |word: &str, form: &str| forms(word).iter().any(|f| f == form);
        // Plural to singular: `es` goes only after a sibilant; both are tried when unsure.
        for (word, one) in [
            ("warehouses", "warehouse"),
            ("databases", "database"),
            ("purchases", "purchase"),
            ("licenses", "license"),
            ("responses", "response"),
            ("invoices", "invoice"),
            ("keys", "key"),
            ("days", "day"),
            ("surveys", "survey"),
            ("categories", "category"),
            ("movies", "movie"),
            ("boxes", "box"),
            ("classes", "class"),
            ("matches", "match"),
            ("wishes", "wish"),
            ("quizzes", "quizz"),
            ("orders", "order"),
        ] {
            assert!(has_form(word, one), "{word} -> {one}: {:?}", forms(word));
        }
        // Singular to plural: `y` takes `ies` only after a consonant.
        for (word, more) in [
            ("key", "keys"),
            ("day", "days"),
            ("survey", "surveys"),
            ("category", "categories"),
            ("box", "boxes"),
            ("class", "classes"),
            ("match", "matches"),
            ("warehouse", "warehouses"),
            ("invoice", "invoices"),
            ("status", "statuses"),
        ] {
            assert!(has_form(word, more), "{word} -> {more}: {:?}", forms(word));
        }
        for (word, wrong) in [
            ("key", "keies"),
            ("day", "daies"),
            ("survey", "surveies"),
            ("class", "clas"),
            ("status", "statu"),
            ("address", "addres"),
        ] {
            assert!(!has_form(word, wrong), "{word} gave {wrong}");
        }
        assert_eq!(forms("ab"), ["ab", "abs"]);
    }

    #[test]
    fn abbreviations_expand_in_every_form() {
        let terms = question_terms("qty");
        for word in ["quantity", "quantities"] {
            assert!(has(&terms, word), "{word} missing from {terms:?}");
        }
        let terms = question_terms("customers per warehouse");
        for word in ["customer", "cust", "warehouses"] {
            assert!(has(&terms, word), "{word} missing from {terms:?}");
        }
        let terms = question_terms("invoices");
        assert!(has(&terms, "inv"), "{terms:?}");
    }

    #[test]
    fn synonyms_add_the_schema_word() {
        let terms = question_terms("Top clients by lifetime value");
        for word in ["customer", "customers"] {
            assert!(has(&terms, word), "{word} missing from {terms:?}");
        }
        let terms = question_terms("late vendors");
        assert!(has(&terms, "supplier"), "{terms:?}");
        assert!(has(&terms, "suppliers"), "{terms:?}");
        // One direction only: the schema word does not bring the spoken one.
        let terms = question_terms("customers");
        assert!(!has(&terms, "client"), "{terms:?}");
        assert!(
            question_terms(&SYNONYMS.iter().map(|s| s.0).collect::<Vec<_>>().join(" ")).len() <= 32
        );
    }

    #[test]
    fn return_is_an_everyday_verb_not_a_refund() {
        // Ruling 14: "return" opens many questions; it does not pull refunds in.
        let terms = question_terms("Return the top customers by spend");
        for word in ["refund", "refunds"] {
            assert!(!has(&terms, word), "{word} in {terms:?}");
        }
        assert!(has(&terms, "customers"), "{terms:?}");
        assert!(SYNONYMS.iter().all(|(said, _)| *said != "return"));
    }

    #[test]
    fn named_is_set_by_name_match_only() {
        use crate::ai::context::build::build_context;
        use crate::ai::context::store::StoreContext;
        use crate::schema_model::{SchemaModel, SmTable};
        use crate::store::AppStore;
        let table = |name: &str| SmTable {
            schema: None,
            name: name.into(),
            alias: None,
            note: None,
            columns: Vec::new(),
            indexes: Vec::new(),
        };
        let model = SchemaModel {
            dialect: DialectKind::MySql,
            tables: ["invoices", "orders", "agents"].map(table).to_vec(),
            refs: Vec::new(),
            enums: Vec::new(),
            skipped: Vec::new(),
        };
        let store = StoreContext::new(AppStore::open(std::path::Path::new(":memory:")).unwrap());
        let key = ContextKey {
            connection_id: uuid::Uuid::from_u128(7),
            database: "shop".into(),
            schema: String::new(),
        };
        let built = build_context(&model, DialectKind::MySql, "shop", &[], &|t| t.to_string());
        store.replace_context(&key, &built, None, 1_000).unwrap();
        let ask = |open: &[TableRef], sql: Option<&str>| {
            let seeds = Seeds {
                dialect: DialectKind::MySql,
                open_tables: open,
                texts: sql.into_iter().collect(),
                question: "",
                picked: &[],
            };
            // A share of one token forces tier 2.
            retrieve(&store, &key, &seeds, 1, false, false).unwrap()
        };
        let open = [TableRef {
            schema: None,
            name: "orders".into(),
        }];
        let r = ask(&open, None);
        assert!(r.ranked && !r.named);
        let r = ask(&[], Some("select * from invoices"));
        assert!(r.ranked && r.named);
    }

    #[test]
    fn abbreviations_expand() {
        assert_eq!(ABBREVIATIONS.len(), 18);
        let terms = question_terms("total amt by cust and dept");
        for word in ["amount", "customer", "department", "amt", "cust", "dept"] {
            assert!(has(&terms, word), "{word} missing from {terms:?}");
        }
        // The full word also finds the abbreviated column, singular or plural.
        let terms = question_terms("payments with the biggest quantity");
        assert!(has(&terms, "pmt"), "{terms:?}");
        assert!(has(&terms, "qty"), "{terms:?}");
    }
}
