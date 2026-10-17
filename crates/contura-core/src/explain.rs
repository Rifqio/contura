//! Explain: the plan of one statement as a tree, never run with ANALYZE.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::model::DialectKind;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    pub label: String,
    pub object: Option<String>,
    pub rows: Option<f64>,
    pub cost: Option<f64>,
    pub full_scan: bool,
    pub children: Vec<PlanNode>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub nodes: Vec<PlanNode>,
    pub raw: String,
    pub total_cost: Option<f64>,
}

/// The SQL that asks the server for `statement`'s plan without running it.
pub fn explain_sql(dialect: DialectKind, statement: &str) -> String {
    match dialect {
        DialectKind::MySql => format!("EXPLAIN FORMAT=TREE {statement}"),
        DialectKind::Postgres => format!("EXPLAIN (FORMAT JSON) {statement}"),
        DialectKind::Sqlite => format!("EXPLAIN QUERY PLAN {statement}"),
    }
}

/// Builds the plan from the server's answer: every cell of every row as text.
pub fn plan_from_rows(dialect: DialectKind, rows: &[Vec<String>]) -> Result<Plan> {
    match dialect {
        DialectKind::MySql => {
            let raw = first_column(rows);
            let nodes = parse_mysql_tree(&raw);
            let total_cost = nodes.first().and_then(|n| n.cost);
            Ok(Plan {
                nodes,
                raw,
                total_cost,
            })
        }
        DialectKind::Postgres => {
            let raw = first_column(rows);
            let nodes = parse_pg_json(&raw)?;
            let total_cost = pg_total_cost(&raw);
            Ok(Plan {
                nodes,
                raw,
                total_cost,
            })
        }
        DialectKind::Sqlite => {
            // Columns: id, parent, notused, detail.
            let parsed: Vec<(i64, i64, String)> = rows
                .iter()
                .filter(|r| r.len() >= 4)
                .map(|r| {
                    (
                        r[0].parse().unwrap_or(0),
                        r[1].parse().unwrap_or(0),
                        r[3].clone(),
                    )
                })
                .collect();
            let raw = parsed
                .iter()
                .map(|(_, _, d)| d.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            Ok(Plan {
                nodes: parse_sqlite_rows(&parsed),
                raw,
                total_cost: None,
            })
        }
    }
}

fn first_column(rows: &[Vec<String>]) -> String {
    rows.iter()
        .filter_map(|r| r.first().map(String::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn number(s: &str) -> Option<f64> {
    s.parse().ok()
}

/// `(cost=C rows=R)` or `(cost=C..C2 rows=R)` at the end of a line: the label without it,
/// the last cost number and the rows.
fn split_mysql_stats(line: &str) -> (&str, Option<f64>, Option<f64>) {
    let Some(at) = line.rfind("(cost=") else {
        return (line.trim_end(), None, None);
    };
    let Some(inner) = line[at + 1..].strip_suffix(')') else {
        return (line.trim_end(), None, None);
    };
    let mut cost = None;
    let mut rows = None;
    for part in inner.split_whitespace() {
        if let Some(v) = part.strip_prefix("cost=") {
            cost = number(v.rsplit("..").next().unwrap_or(v));
        } else if let Some(v) = part.strip_prefix("rows=") {
            rows = number(v);
        }
    }
    (line[..at].trim_end(), cost, rows)
}

/// The word after " on ", up to the next space. Quoted text is not looked at, so a
/// literal that contains " on " names nothing.
fn object_after_on(label: &str) -> Option<String> {
    let mut masked = String::with_capacity(label.len());
    let mut quote: Option<char> = None;
    for c in label.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None if c == '\'' || c == '"' => quote = Some(c),
            None => masked.push(c),
        }
    }
    let (_, rest) = masked.split_once(" on ")?;
    let name = rest.split_whitespace().next()?;
    Some(name.to_string())
}

pub fn parse_mysql_tree(text: &str) -> Vec<PlanNode> {
    let mut flat: Vec<(usize, PlanNode)> = Vec::new();
    for line in text.lines() {
        let body = line.trim_start_matches(' ');
        let Some(content) = body.strip_prefix("-> ") else {
            continue;
        };
        let level = (line.len() - body.len()) / 4;
        let (label, cost, rows) = split_mysql_stats(content);
        flat.push((
            level,
            PlanNode {
                label: label.to_string(),
                object: object_after_on(label),
                rows,
                cost,
                full_scan: label.starts_with("Table scan on"),
                children: Vec::new(),
            },
        ));
    }
    nest(&mut flat.into_iter().peekable(), 0)
}

/// Turns nodes tagged with their level into a forest: a node's children are the deeper
/// nodes that follow it.
fn nest(
    items: &mut std::iter::Peekable<std::vec::IntoIter<(usize, PlanNode)>>,
    level: usize,
) -> Vec<PlanNode> {
    let mut out = Vec::new();
    while let Some((l, _)) = items.peek() {
        if *l < level {
            break;
        }
        let (l, mut node) = items.next().expect("peeked");
        node.children = nest(items, l + 1);
        out.push(node);
    }
    out
}

fn pg_node(v: &serde_json::Value) -> PlanNode {
    let text = |k: &str| v.get(k).and_then(|x| x.as_str());
    let kind = text("Node Type").unwrap_or("");
    let label = match text("Index Name") {
        Some(i) => format!("{kind} using {i}"),
        None => kind.to_string(),
    };
    PlanNode {
        label,
        object: text("Relation Name").map(str::to_string),
        rows: v.get("Plan Rows").and_then(|x| x.as_f64()),
        cost: v.get("Total Cost").and_then(|x| x.as_f64()),
        full_scan: kind == "Seq Scan",
        children: v
            .get("Plans")
            .and_then(|p| p.as_array())
            .map(|a| a.iter().map(pg_node).collect())
            .unwrap_or_default(),
    }
}

pub fn parse_pg_json(text: &str) -> Result<Vec<PlanNode>> {
    let bad = |e: &dyn std::fmt::Display| Error::Query(format!("cannot read the plan: {e}"));
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| bad(&e))?;
    let items = value
        .as_array()
        .ok_or_else(|| bad(&"the plan is not a list"))?;
    Ok(items
        .iter()
        .filter_map(|i| i.get("Plan"))
        .map(pg_node)
        .collect())
}

fn pg_total_cost(text: &str) -> Option<f64> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.get(0)?.get("Plan")?.get("Total Cost")?.as_f64()
}

fn sqlite_node(detail: &str) -> PlanNode {
    let mut words = detail.split_whitespace();
    let first = words.next().unwrap_or("");
    let object = if matches!(first, "SCAN" | "SEARCH") {
        words
            .next()
            .map(|w| {
                if w == "TABLE" {
                    words.next().unwrap_or(w)
                } else {
                    w
                }
            })
            .map(str::to_string)
    } else {
        None
    };
    PlanNode {
        label: detail.to_string(),
        object,
        rows: None,
        cost: None,
        full_scan: detail.starts_with("SCAN ") && !detail.contains(" USING "),
        children: Vec::new(),
    }
}

pub fn parse_sqlite_rows(rows: &[(i64, i64, String)]) -> Vec<PlanNode> {
    fn under(rows: &[(i64, i64, String)], parent: i64) -> Vec<PlanNode> {
        rows.iter()
            .filter(|(id, p, _)| *p == parent && *id != parent)
            .map(|(id, _, detail)| {
                let mut node = sqlite_node(detail);
                node.children = under(rows, *id);
                node
            })
            .collect()
    }
    under(rows, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_tree_parses_levels_cost_and_rows() {
        let text = "-> Filter: (orders.status = 'paid')  (cost=14182 rows=14138)\n    -> Table scan on orders  (cost=14182 rows=141377)";
        let nodes = parse_mysql_tree(text);
        assert_eq!(nodes.len(), 1);
        let root = &nodes[0];
        assert_eq!(root.label, "Filter: (orders.status = 'paid')");
        assert_eq!(root.cost, Some(14182.0));
        assert_eq!(root.rows, Some(14138.0));
        assert!(!root.full_scan);
        assert_eq!(root.children.len(), 1);
        let child = &root.children[0];
        assert_eq!(child.label, "Table scan on orders");
        assert_eq!(child.object.as_deref(), Some("orders"));
        assert_eq!(child.rows, Some(141377.0));
        assert!(child.full_scan);
    }

    #[test]
    fn mysql_tree_takes_the_last_cost_of_a_range_and_siblings() {
        let text = "-> Nested loop inner join  (cost=2.1..9.5 rows=4)\n    -> Index lookup on o using idx  (cost=1.0 rows=2)\n    -> Single-row index lookup on c using PRIMARY (id=o.cid)  (cost=0.5..0.6 rows=1)";
        let nodes = parse_mysql_tree(text);
        assert_eq!(nodes[0].cost, Some(9.5));
        assert_eq!(nodes[0].children.len(), 2);
        assert_eq!(nodes[0].children[0].object.as_deref(), Some("o"));
        assert_eq!(nodes[0].children[1].cost, Some(0.6));
    }

    #[test]
    fn mysql_object_ignores_quoted_text() {
        let text = "-> Filter: (a.note = 'x on y')  (cost=1 rows=1)
    -> Table scan on a  (cost=1 rows=1)";
        let nodes = parse_mysql_tree(text);
        assert_eq!(nodes[0].object, None);
        assert_eq!(nodes[0].children[0].object.as_deref(), Some("a"));
    }

    #[test]
    fn pg_json_parses_nodes() {
        let text = r#"[{"Plan":{"Node Type":"Seq Scan","Relation Name":"orders","Total Cost":2834.77,"Plan Rows":141377}}]"#;
        let nodes = parse_pg_json(text).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].label, "Seq Scan");
        assert_eq!(nodes[0].object.as_deref(), Some("orders"));
        assert!(nodes[0].full_scan);
        assert_eq!(nodes[0].rows, Some(141377.0));
        assert_eq!(pg_total_cost(text), Some(2834.77));
    }

    #[test]
    fn pg_json_keeps_children_and_index_names() {
        let text = r#"[{"Plan":{"Node Type":"Nested Loop","Total Cost":10.0,"Plan Rows":1,"Plans":[{"Node Type":"Index Scan","Index Name":"orders_pkey","Relation Name":"orders","Total Cost":1.0,"Plan Rows":1}]}}]"#;
        let nodes = parse_pg_json(text).unwrap();
        assert_eq!(nodes[0].children[0].label, "Index Scan using orders_pkey");
        assert!(!nodes[0].children[0].full_scan);
        assert!(parse_pg_json("not json").is_err());
    }

    #[test]
    fn sqlite_rows_build_the_tree() {
        let rows = [
            (2, 0, "SCAN orders".to_string()),
            (
                5,
                2,
                "SEARCH customers USING INTEGER PRIMARY KEY (rowid=?)".to_string(),
            ),
        ];
        let nodes = parse_sqlite_rows(&rows);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].label, "SCAN orders");
        assert_eq!(nodes[0].object.as_deref(), Some("orders"));
        assert!(nodes[0].full_scan);
        assert_eq!(nodes[0].children.len(), 1);
        assert!(!nodes[0].children[0].full_scan);
        assert_eq!(nodes[0].children[0].object.as_deref(), Some("customers"));
    }

    #[test]
    fn explain_sql_never_says_analyze() {
        let m = explain_sql(DialectKind::MySql, "SELECT 1");
        let p = explain_sql(DialectKind::Postgres, "SELECT 1");
        let s = explain_sql(DialectKind::Sqlite, "SELECT 1");
        assert_eq!(m, "EXPLAIN FORMAT=TREE SELECT 1");
        assert_eq!(p, "EXPLAIN (FORMAT JSON) SELECT 1");
        assert_eq!(s, "EXPLAIN QUERY PLAN SELECT 1");
        for sql in [m, p, s] {
            assert!(!sql.to_uppercase().contains("ANALYZE"));
        }
    }
}
