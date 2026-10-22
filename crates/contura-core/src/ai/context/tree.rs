//! Areas of the Context Tree, grouped by rules over the stored Foreign Key graph. No model
//! is called: components of the graph become Areas, big ones are split by name prefix and
//! then cut into chunks, and tables with no key are grouped by prefix.

use std::cmp::Reverse;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::ai::context::build::split_words;
use crate::ai::context::store::{ContextKey, ContextStore, GraphRow};
use crate::ai::preview::count_of;
use crate::error::Result;

pub const AREA_MAX_TABLES: usize = 40;
pub const SUMMARY_CAP: usize = 300;
pub const SAVED_AREA_ID: &str = "a:saved";

const JOINS_MAX: usize = 5;
const MIN_PREFIX_GROUP: usize = 3;
const OTHER_LABEL: &str = "Other tables";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    /// `a:<label>`.
    pub id: String,
    pub label: String,
    pub hub: String,
    /// The hub first, then by distinct neighbours descending, then by name.
    pub tables: Vec<String>,
    /// Tables outside the Area that its tables reference, sorted, at most 5.
    pub joins_out: Vec<String>,
    pub summary: String,
}

/// The Context's Areas. An older Context has none stored: they are built from the stored
/// graph (no catalog query) and stored.
pub fn areas_for(store: &dyn ContextStore, key: &ContextKey) -> Result<Vec<Area>> {
    let stored = store.context_areas(key)?;
    if !stored.is_empty() {
        return Ok(stored);
    }
    let graph = store.context_graph(key)?;
    if graph.is_empty() {
        return Ok(stored);
    }
    let areas = build_areas(&graph);
    store.put_areas(key, &areas)?;
    Ok(areas)
}

/// The first part of `split_words(name)` when it has two or more parts.
pub fn prefix_of(name: &str) -> Option<String> {
    let mut parts = split_words(name);
    if parts.len() >= 2 {
        Some(parts.swap_remove(0))
    } else {
        None
    }
}

/// Tables are indexed in name order, so index order is name order everywhere below.
struct Ctx {
    names: Vec<String>,
    adj: Vec<BTreeSet<usize>>,
    out: Vec<BTreeSet<usize>>,
    prefix: Vec<Option<String>>,
    used: HashSet<String>,
    areas: Vec<Area>,
}

impl Ctx {
    /// Most distinct neighbours, ties to the shorter name, then the name.
    fn hub(&self, members: &[usize]) -> usize {
        *members
            .iter()
            .min_by_key(|&&i| (Reverse(self.adj[i].len()), self.names[i].len(), i))
            .expect("a group is never empty")
    }

    fn push(&mut self, label: &str, members: &[usize], hub: Option<usize>) {
        let hub = hub.unwrap_or_else(|| self.hub(members));
        let label = self.unique(label);
        let mut tables: Vec<usize> = members.iter().copied().filter(|&i| i != hub).collect();
        tables.sort_by_key(|&i| (Reverse(self.adj[i].len()), i));
        tables.insert(0, hub);
        let inside: HashSet<usize> = members.iter().copied().collect();
        let joins: BTreeSet<usize> = members
            .iter()
            .flat_map(|&i| self.out[i].iter().copied())
            .filter(|j| !inside.contains(j))
            .collect();
        let joins_out: Vec<String> = joins
            .into_iter()
            .take(JOINS_MAX)
            .map(|j| self.names[j].clone())
            .collect();
        let tables: Vec<String> = tables.into_iter().map(|i| self.names[i].clone()).collect();
        let summary = summarize(&label, &tables, &joins_out);
        self.areas.push(Area {
            id: format!("a:{label}"),
            hub: self.names[hub].clone(),
            label,
            tables,
            joins_out,
            summary,
        });
    }

    /// A label already used gets " 2", " 3" in the order Areas are made.
    fn unique(&mut self, base: &str) -> String {
        let mut label = base.to_string();
        let mut n = 2;
        while self.used.contains(&label) {
            label = format!("{base} {n}");
            n += 1;
        }
        self.used.insert(label.clone());
        label
    }

    fn push_hubbed(&mut self, members: &[usize]) {
        let hub = self.hub(members);
        let label = self.names[hub].clone();
        self.push(&label, members, Some(hub));
    }

    /// Groups by prefix (sorted by prefix) and the members with no prefix.
    fn by_prefix(&self, members: &[usize]) -> (Vec<(String, Vec<usize>)>, Vec<usize>) {
        let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
        let mut pos: HashMap<&str, usize> = HashMap::new();
        let mut none = Vec::new();
        for &i in members {
            match &self.prefix[i] {
                Some(p) => {
                    let at = *pos.entry(p.as_str()).or_insert_with(|| {
                        groups.push((p.clone(), Vec::new()));
                        groups.len() - 1
                    });
                    groups[at].1.push(i);
                }
                None => none.push(i),
            }
        }
        groups.sort_by(|a, b| a.0.cmp(&b.0));
        (groups, none)
    }

    /// Chunks of 40 in breadth-first order from the hub over the group's own edges.
    fn chunks_by_distance(&mut self, members: &[usize]) {
        let inside: HashSet<usize> = members.iter().copied().collect();
        let hub = self.hub(members);
        let mut seen: HashSet<usize> = HashSet::from([hub]);
        let mut order = vec![hub];
        let mut queue = VecDeque::from([hub]);
        while let Some(at) = queue.pop_front() {
            for &n in &self.adj[at] {
                if inside.contains(&n) && seen.insert(n) {
                    order.push(n);
                    queue.push_back(n);
                }
            }
        }
        order.extend(members.iter().copied().filter(|i| !seen.contains(i)));
        for chunk in order.chunks(AREA_MAX_TABLES) {
            let label = self.names[chunk[0]].clone();
            self.push(&label, chunk, Some(chunk[0]));
        }
    }

    fn big_component(&mut self, members: &[usize]) {
        let (groups, none) = self.by_prefix(members);
        let mut rest = none;
        for (prefix, group) in groups {
            if group.len() < MIN_PREFIX_GROUP {
                rest.extend(group);
            } else if group.len() <= AREA_MAX_TABLES {
                self.push(&prefix, &group, None);
            } else {
                self.chunks_by_distance(&group);
            }
        }
        if rest.is_empty() {
            return;
        }
        rest.sort_unstable();
        if rest.len() <= AREA_MAX_TABLES {
            self.push_hubbed(&rest);
        } else {
            self.chunks_by_distance(&rest);
        }
    }

    /// Tables with no Foreign Key at all.
    fn loose(&mut self, members: &[usize]) {
        let (groups, none) = self.by_prefix(members);
        let mut rest = none;
        for (prefix, group) in groups {
            if group.len() < 2 {
                rest.extend(group);
                continue;
            }
            for chunk in group.chunks(AREA_MAX_TABLES) {
                self.push(&prefix, chunk, None);
            }
        }
        rest.sort_unstable();
        for chunk in rest.chunks(AREA_MAX_TABLES) {
            self.push(OTHER_LABEL, chunk, None);
        }
    }
}

pub fn build_areas(graph: &[GraphRow]) -> Vec<Area> {
    let names: Vec<String> = graph
        .iter()
        .map(|r| r.table.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let index: HashMap<&str, usize> = names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.as_str(), i))
        .collect();
    let mut adj = vec![BTreeSet::new(); names.len()];
    let mut out = vec![BTreeSet::new(); names.len()];
    for row in graph {
        let a = index[row.table.as_str()];
        for name in &row.fk_out {
            if let Some(&b) = index.get(name.as_str())
                && a != b
            {
                adj[a].insert(b);
                adj[b].insert(a);
                out[a].insert(b);
            }
        }
        for name in &row.fk_in {
            if let Some(&b) = index.get(name.as_str())
                && a != b
            {
                adj[a].insert(b);
                adj[b].insert(a);
            }
        }
    }
    let prefix = names.iter().map(|n| prefix_of(n)).collect();
    let mut cx = Ctx {
        names,
        adj,
        out,
        prefix,
        // `saved` stays free: `a:saved` is the saved queries node.
        used: HashSet::from([SAVED_AREA_ID.trim_start_matches("a:").to_string()]),
        areas: Vec::new(),
    };

    let n = cx.names.len();
    let mut seen = vec![false; n];
    let mut loose = Vec::new();
    for start in 0..n {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut comp = vec![start];
        let mut at = 0;
        while at < comp.len() {
            let cur = comp[at];
            at += 1;
            for &m in &cx.adj[cur] {
                if !seen[m] {
                    seen[m] = true;
                    comp.push(m);
                }
            }
        }
        comp.sort_unstable();
        match comp.len() {
            1 => loose.push(start),
            2..=AREA_MAX_TABLES => cx.push_hubbed(&comp),
            _ => cx.big_component(&comp),
        }
    }
    cx.loose(&loose);
    let mut areas = cx.areas;
    areas.sort_by(|a, b| a.label.cmp(&b.label));
    areas
}

fn summarize(label: &str, tables: &[String], joins_out: &[String]) -> String {
    let head = format!(
        "{label} area, {}: ",
        count_of(tables.len(), "table", "tables")
    );
    let joins = if joins_out.is_empty() {
        String::new()
    } else {
        format!(" Joins out to {}.", joins_out.join(", "))
    };
    let full = format!("{head}{}.{joins}", tables.join(", "));
    if full.len() <= SUMMARY_CAP {
        return full;
    }
    // Cut at a name boundary; the Joins sentence stays. The first name always stays.
    let mut list = String::new();
    for (k, name) in tables.iter().enumerate() {
        let next = if k == 0 {
            name.clone()
        } else {
            format!("{list}, {name}")
        };
        if k > 0 && head.len() + next.len() + ", ...".len() + joins.len() > SUMMARY_CAP {
            break;
        }
        list = next;
    }
    format!("{head}{list}, ...{joins}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn rows(names: &[String], pairs: &[(String, String)]) -> Vec<GraphRow> {
        let mut rows: Vec<GraphRow> = names
            .iter()
            .map(|n| GraphRow {
                table: n.clone(),
                tokens: 10,
                rows_tokens: 0,
                fk_out: Vec::new(),
                fk_in: Vec::new(),
            })
            .collect();
        let at: HashMap<&str, usize> = names
            .iter()
            .enumerate()
            .map(|(i, n)| (n.as_str(), i))
            .collect();
        for (from, to) in pairs {
            rows[at[from.as_str()]].fk_out.push(to.clone());
            rows[at[to.as_str()]].fk_in.push(from.clone());
        }
        rows
    }

    fn graph(names: &[&str], pairs: &[(&str, &str)]) -> Vec<GraphRow> {
        let names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        rows(&names, &pairs)
    }

    /// A single-word name (no digits, so no prefix): `aa`, `ab`, ...
    fn alpha(i: usize) -> String {
        format!(
            "{}{}",
            (b'a' + (i / 26) as u8) as char,
            (b'a' + (i % 26) as u8) as char
        )
    }

    fn labels(areas: &[Area]) -> Vec<&str> {
        areas.iter().map(|a| a.label.as_str()).collect()
    }

    fn find<'a>(areas: &'a [Area], label: &str) -> &'a Area {
        areas
            .iter()
            .find(|a| a.label == label)
            .unwrap_or_else(|| panic!("no area {label}: {:?}", labels(areas)))
    }

    #[test]
    fn components_become_areas() {
        let g = graph(
            &["orders", "items", "customers", "a", "b", "c", "d", "e"],
            &[
                ("orders", "customers"),
                ("items", "orders"),
                ("b", "a"),
                ("c", "a"),
                ("d", "a"),
                ("e", "d"),
            ],
        );
        let areas = build_areas(&g);
        assert_eq!(labels(&areas), ["a", "orders"]);
        let orders = find(&areas, "orders");
        assert_eq!(orders.id, "a:orders");
        assert_eq!(orders.hub, "orders");
        assert_eq!(orders.tables, ["orders", "customers", "items"]);
        assert_eq!(find(&areas, "a").tables, ["a", "d", "b", "c", "e"]);
        assert!(orders.joins_out.is_empty());
        assert_eq!(
            orders.summary,
            "orders area, 3 tables: orders, customers, items."
        );
    }

    #[test]
    fn hub_ties_go_to_the_shorter_name() {
        let g = graph(&["bbb", "aa"], &[("bbb", "aa")]);
        assert_eq!(build_areas(&g)[0].label, "aa");
        let g = graph(&["zz", "yyy"], &[("zz", "yyy")]);
        assert_eq!(build_areas(&g)[0].label, "zz");
        let g = graph(&["zz", "yy"], &[("zz", "yy")]);
        assert_eq!(build_areas(&g)[0].label, "yy");
    }

    #[test]
    fn big_component_splits_by_prefix() {
        let mut names = vec!["core".to_string()];
        names.extend((0..39).map(|i| format!("eu_t{i:02}")));
        names.extend((0..39).map(|i| format!("us_t{i:02}")));
        names.extend((0..2).map(|i| format!("ap_t{i}")));
        names.extend((0..9).map(|i| format!("plain{}", alpha(i))));
        assert_eq!(names.len(), 90);
        let pairs: Vec<(String, String)> = names
            .iter()
            .skip(1)
            .map(|n| (n.clone(), "core".to_string()))
            .collect();
        let areas = build_areas(&rows(&names, &pairs));
        assert_eq!(labels(&areas), ["core", "eu", "us"]);
        assert_eq!(find(&areas, "eu").tables.len(), 39);
        assert_eq!(find(&areas, "us").tables.len(), 39);
        let rest = find(&areas, "core");
        assert_eq!(rest.hub, "core");
        assert_eq!(rest.tables.len(), 12);
        assert!(rest.tables.contains(&"ap_t0".to_string()));
        assert_eq!(find(&areas, "eu").joins_out, ["core"]);
    }

    #[test]
    fn big_group_chunks_by_distance() {
        let names: Vec<String> = (0..95).map(|i| format!("w_t{i:02}")).collect();
        let pairs: Vec<(String, String)> = (1..95)
            .map(|i| (names[i].clone(), names[i - 1].clone()))
            .collect();
        let areas = build_areas(&rows(&names, &pairs));
        // The hub is the first of the middle tables (degree 2, equal names, lowest name).
        let mut by_size: Vec<&Area> = areas.iter().collect();
        by_size.sort_by_key(|a| Reverse(a.tables.len()));
        let sizes: Vec<usize> = by_size.iter().map(|a| a.tables.len()).collect();
        assert_eq!(sizes, [40, 40, 15]);
        for a in &areas {
            assert_eq!(a.label, a.hub);
            assert_eq!(a.tables[0], a.label);
        }
        // Breadth-first from w_t01 reaches w_t00 and w_t02 first, then one step more on
        // each side: the first chunk holds the 40 closest tables around the hub.
        let first = find(&areas, "w_t01");
        assert_eq!(first.tables.len(), 40);
        assert!(first.tables.contains(&"w_t00".to_string()));
        assert!(first.tables.contains(&"w_t39".to_string()));
        assert!(!first.tables.contains(&"w_t40".to_string()));
        // The next chunks start where the first stopped, in the same order.
        let members = |a: &Area| -> BTreeSet<String> { a.tables.iter().cloned().collect() };
        let second = find(&areas, "w_t40");
        assert_eq!(second.hub, "w_t40");
        assert_eq!(
            members(second),
            (40..80).map(|i| names[i].clone()).collect()
        );
        let third = find(&areas, "w_t80");
        assert_eq!(third.hub, "w_t80");
        assert_eq!(members(third), (80..95).map(|i| names[i].clone()).collect());
        assert_eq!(labels(&areas), ["w_t01", "w_t40", "w_t80"]);
        let all: HashSet<&String> = areas.iter().flat_map(|a| &a.tables).collect();
        assert_eq!(all.len(), 95);
    }

    #[test]
    fn edge_inputs() {
        // An empty graph has no Areas.
        assert!(build_areas(&[]).is_empty());

        // A self reference and a key to a table outside the graph join nothing: both
        // tables stay loose, in one Area of tables without keys.
        let mut g = graph(&["aa", "bb"], &[]);
        g[0].fk_out.push("aa".into());
        g[0].fk_in.push("aa".into());
        g[1].fk_out.push("ghost".into());
        g[1].fk_in.push("phantom".into());
        let areas = build_areas(&g);
        assert_eq!(labels(&areas), ["Other tables"]);
        assert_eq!(areas[0].tables, ["aa", "bb"]);
        assert!(areas[0].joins_out.is_empty());

        // Two rows for one table are one table, with the keys of both.
        let mut g = graph(&["orders", "items", "customers"], &[("items", "orders")]);
        let mut again = g[0].clone();
        again.fk_out.push("customers".into());
        g.push(again);
        let areas = build_areas(&g);
        assert_eq!(labels(&areas), ["orders"]);
        assert_eq!(areas[0].tables.len(), 3);
        assert_eq!(areas[0].tables.iter().filter(|t| *t == "orders").count(), 1);
    }

    #[test]
    fn tables_without_keys_group_by_prefix() {
        let areas = build_areas(&graph(&["log_a", "log_b", "misc"], &[]));
        assert_eq!(labels(&areas), ["Other tables", "log"]);
        assert_eq!(find(&areas, "log").tables, ["log_a", "log_b"]);
        assert_eq!(find(&areas, "Other tables").tables, ["misc"]);

        let names: Vec<String> = (0..45).map(alpha).collect();
        let areas = build_areas(&rows(&names, &[]));
        assert_eq!(labels(&areas), ["Other tables", "Other tables 2"]);
        assert_eq!(find(&areas, "Other tables").tables.len(), 40);
        assert_eq!(find(&areas, "Other tables 2").tables.len(), 5);
    }

    #[test]
    fn labels_stay_unique() {
        // A hub table called `m` and a no-key prefix group `m` meet.
        let g = graph(&["m", "m2", "z", "q_a", "q_b"], &[("m2", "m")]);
        let areas = build_areas(&g);
        let ids: HashSet<&str> = areas.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids.len(), areas.len());
        assert_eq!(labels(&areas), ["Other tables", "m", "q"]);

        // A prefix group `q` of loose tables meets the hub table `q`.
        let g = graph(
            &["q", "q_a", "q_b", "q_c", "x", "y"],
            &[("y", "x"), ("q_a", "q")],
        );
        let areas = build_areas(&g);
        assert_eq!(labels(&areas), ["q", "q 2", "x"]);
        assert_eq!(find(&areas, "q").hub, "q");
        assert_eq!(find(&areas, "q 2").tables, ["q_b", "q_c"]);
        assert_eq!(find(&areas, "q 2").id, "a:q 2");
    }

    #[test]
    fn saved_label_never_takes_the_reserved_id() {
        // A hub table called `saved`.
        let g = graph(&["saved", "saved_x"], &[("saved_x", "saved")]);
        let areas = build_areas(&g);
        assert!(areas.iter().all(|a| a.id != SAVED_AREA_ID));
        assert_eq!(labels(&areas), ["saved 2"]);
        assert_eq!(areas[0].id, "a:saved 2");
        // A no-key prefix group `saved_*`.
        let g = graph(&["saved_filters", "saved_queries", "zz"], &[]);
        let areas = build_areas(&g);
        assert!(areas.iter().all(|a| a.id != SAVED_AREA_ID));
        assert_eq!(labels(&areas), ["Other tables", "saved 2"]);
    }

    #[test]
    fn summary_capped_keeps_joins() {
        // A 43-table component: `core` hub, 30 long `very_...` names, two named tables and
        // ten unprefixed ones. The `very` prefix group is an Area of 30 long names.
        let longs: Vec<String> = (0..30)
            .map(|i| format!("very_long_table_name_number_{i:02}"))
            .collect();
        let mut names = vec!["core".to_string(), "customers".into(), "products".into()];
        names.extend(longs.iter().cloned());
        names.extend((0..10).map(alpha));
        let mut pairs: Vec<(String, String)> = names
            .iter()
            .skip(1)
            .map(|n| (n.clone(), "core".to_string()))
            .collect();
        pairs.push((longs[0].clone(), "customers".to_string()));
        pairs.push((longs[1].clone(), "products".to_string()));
        let areas = build_areas(&rows(&names, &pairs));
        let a = find(&areas, "very");
        assert_eq!(a.tables.len(), 30);
        assert_eq!(a.joins_out, ["core", "customers", "products"]);
        assert!(a.summary.len() <= SUMMARY_CAP, "{}", a.summary.len());
        assert!(
            a.summary
                .ends_with(" Joins out to core, customers, products.")
        );
        assert!(a.summary.contains(", ... Joins out to"));
        // The cut falls between names: what precedes `, ...` ends with a whole table name.
        let head = a.summary.split_once(", ... Joins").unwrap().0;
        let last = head.rsplit(", ").next().unwrap();
        assert!(a.tables.iter().any(|t| t == last), "cut inside {last}");
        assert!(last.len() == "very_long_table_name_number_00".len());
        assert!(a.summary.starts_with("very area, 30 tables: "));
    }

    #[test]
    fn summary_uses_grouping_and_singular() {
        assert_eq!(
            summarize("x", &["only".to_string()], &[]),
            "x area, 1 table: only."
        );
        let many: Vec<String> = (0..1200).map(|i| format!("t{i}")).collect();
        let s = summarize("big", &many, &["o".to_string()]);
        assert!(s.starts_with("big area, 1,200 tables: t0, t1"));
        assert!(s.len() <= SUMMARY_CAP);
        assert!(s.ends_with(", ... Joins out to o."));
    }

    /// Names and keys in the style of `eval_schema`: prefixed copies, camel case, clusters
    /// around a hub, a few cross links, some loners.
    fn generated(n: usize) -> Vec<GraphRow> {
        let units = ["eu", "us", "apac", "arc"];
        let names: Vec<String> = (0..n)
            .map(|i| match i % 7 {
                0 => format!("{}_order_{i}", units[i % 4]),
                1 => format!("Invoice{i}"),
                2 => format!("{}_line_{i}", units[(i / 3) % 4]),
                _ => format!("t{i}"),
            })
            .collect();
        let mut pairs = Vec::new();
        for i in 0..n {
            let hub = i / 10 * 10;
            if i != hub && i % 13 != 0 {
                pairs.push((names[i].clone(), names[hub].clone()));
            }
            if i % 50 == 49 {
                pairs.push((names[i].clone(), names[(i + 11) % n].clone()));
            }
        }
        for i in (10..n.min(150)).step_by(10) {
            pairs.push((names[i].clone(), names[i - 10].clone()));
        }
        rows(&names, &pairs)
    }

    #[test]
    fn every_table_in_one_area() {
        for n in [300, 2000] {
            let g = generated(n);
            let areas = build_areas(&g);
            let mut seen = HashSet::new();
            for a in &areas {
                assert!(a.tables.len() <= AREA_MAX_TABLES, "{}", a.label);
                assert!(a.joins_out.len() <= JOINS_MAX);
                for t in &a.tables {
                    assert!(seen.insert(t.clone()), "{t} twice");
                }
            }
            assert_eq!(seen.len(), g.len());
            let ids: HashSet<&str> = areas.iter().map(|a| a.id.as_str()).collect();
            assert_eq!(ids.len(), areas.len());
            assert!(areas.windows(2).all(|w| w[0].label <= w[1].label));
        }
    }

    #[test]
    fn same_graph_same_areas() {
        for n in [300, 2000] {
            let g = generated(n);
            let mut reversed = g.clone();
            reversed.reverse();
            assert_eq!(build_areas(&g), build_areas(&g));
            assert_eq!(build_areas(&g), build_areas(&reversed));
        }
    }

    #[test]
    fn two_thousand_tables_quick() {
        // Areas for 2,000 tables are built in well under a second, so the Context build
        // never waits on them. The bound is loose (1s in a debug build, 200ms optimized)
        // so a loaded machine does not fail it; a quadratic slip still would.
        let g = generated(2000);
        let t = Instant::now();
        let areas = build_areas(&g);
        let took = t.elapsed();
        assert!(!areas.is_empty());
        let bound = if cfg!(debug_assertions) { 1_000 } else { 200 };
        assert!(took.as_millis() < bound, "took {took:?}");
    }

    #[test]
    fn prefix_of_cases() {
        assert_eq!(prefix_of("eu_orders").as_deref(), Some("eu"));
        assert_eq!(prefix_of("OrderItems").as_deref(), Some("order"));
        assert_eq!(prefix_of("orders"), None);
    }
}
