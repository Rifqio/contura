//! Sample rows for an Ask: the text of up to 5 live rows per named table, secret columns
//! redacted, and the fit of those texts into the rows share of the budget.
//!
//! Pure code: the rows are read elsewhere (`CatalogReader::sample_rows`); nothing here
//! stores or logs a value.

use crate::ai::budget::estimate_tokens;
use crate::ai::context::build::split_words;
use crate::ai::rails::input::cap_chars;
use crate::model::{Cell, Page};

/// Rows read per table.
pub const SAMPLE_ROWS: u32 = 5;
/// A cell is cut to this many characters, with `…` added.
pub const CELL_CHARS: usize = 200;
/// Tables that get rows in one Ask.
pub const MAX_SAMPLE_TABLES: usize = 10;
/// One table's text is cut at a line end to this size.
pub const ROWS_ITEM_CAP: usize = 16 * 1024;
/// Stands for a binary cell.
pub const BINARY: &str = "<binary>";
/// Stands for every cell of a secret column.
pub const REDACTED: &str = "[redacted]";

/// One table's sample rows as text: the header line, then one JSON array per row.
#[derive(Clone, PartialEq, Eq)]
pub struct SampleTable {
    pub table: String,
    /// Why the table was named (`open tab`, `name match`).
    pub reason: String,
    pub text: String,
    /// The row lines in `text`.
    pub rows: u32,
    /// The columns whose cells went as `[redacted]`.
    pub secret_columns: Vec<String>,
}

/// The table, its reason and counts only: a cell value never reaches a debug print.
impl std::fmt::Debug for SampleTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SampleTable")
            .field("table", &self.table)
            .field("reason", &self.reason)
            .field("rows", &self.rows)
            .field("secret_columns", &self.secret_columns.len())
            .finish_non_exhaustive()
    }
}

const SECRET_WORDS: &[&str] = &[
    "password", "passwd", "pwd", "secret", "token", "salt", "apikey", "otp",
];
const SECRET_PAIRS: &[(&str, &str)] = &[
    ("api", "key"),
    ("private", "key"),
    ("access", "key"),
    ("secret", "key"),
];

/// Whether a column of this name holds a secret: its words (`split_words`) include one of
/// the secret words, or two of them in a row make a secret pair (`api key`).
pub fn secret_column(name: &str) -> bool {
    let words = split_words(name);
    // A word also matches in the plural (`tokens`, `api keys`).
    let is = |w: &str, base: &str| w == base || w.strip_suffix('s') == Some(base);
    words.iter().any(|w| SECRET_WORDS.iter().any(|b| is(w, b)))
        || words
            .windows(2)
            .any(|w| SECRET_PAIRS.iter().any(|(a, b)| w[0] == *a && is(&w[1], b)))
}

/// `name` with control characters (a newline in a table or column name) written as
/// escapes, so the header stays one line.
fn one_line(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_control() {
                c.escape_default().to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}

fn cut(text: &str, truncated: bool) -> String {
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(CELL_CHARS).collect();
    if truncated || chars.next().is_some() {
        format!("{kept}…")
    } else {
        kept
    }
}

fn json(text: &str) -> String {
    serde_json::Value::String(text.to_string()).to_string()
}

fn cell_json(cell: &Cell, secret: bool) -> String {
    if secret {
        return json(REDACTED);
    }
    match cell {
        Cell::Null => "null".to_string(),
        Cell::Bytes { .. } => json(BINARY),
        Cell::Number { value } => json(&cut(value, false)),
        Cell::Text {
            value, truncated, ..
        } => json(&cut(value, *truncated)),
    }
}

/// The text for one table: `table(col, col)`, then a JSON array per row, joined by `\n`
/// and cut at a line end to `ROWS_ITEM_CAP`.
pub fn format_rows(table: &str, reason: &str, page: &Page) -> SampleTable {
    let names: Vec<&str> = page.columns.iter().map(|c| c.name.as_str()).collect();
    let secret: Vec<bool> = names.iter().map(|n| secret_column(n)).collect();
    let escaped: Vec<String> = names.iter().map(|n| one_line(n)).collect();
    let header = format!("{}({})", one_line(table), escaped.join(", "));
    let mut text = cap_chars(&header, ROWS_ITEM_CAP).to_string();
    let mut rows = 0u32;
    for row in &page.rows {
        let cells: Vec<String> = row
            .iter()
            .enumerate()
            .map(|(i, c)| cell_json(c, secret.get(i).copied().unwrap_or(false)))
            .collect();
        let line = format!("[{}]", cells.join(","));
        if text.len() + 1 + line.len() > ROWS_ITEM_CAP {
            break;
        }
        text.push('\n');
        text.push_str(&line);
        rows += 1;
    }
    SampleTable {
        table: table.to_string(),
        reason: reason.to_string(),
        text,
        rows,
        secret_columns: names
            .iter()
            .zip(&secret)
            .filter(|(_, s)| **s)
            .map(|(n, _)| n.to_string())
            .collect(),
    }
}

/// What `fit_rows` did, by table.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RowsFit {
    /// (table, rows kept) for each table that stays.
    pub sent: Vec<(String, u32)>,
    /// Tables that lost their last rows.
    pub cut: Vec<String>,
    /// Tables removed: not even one row fits.
    pub left_out: Vec<String>,
}

/// Fits the tables, in the order given (rank), into `share_tokens`: each whole while it
/// fits what is left, else its last rows go one at a time while the header and one row
/// remain; a table that does not fit with one row is removed from `tables`.
pub fn fit_rows(tables: &mut Vec<SampleTable>, share_tokens: u32) -> RowsFit {
    let mut fit = RowsFit::default();
    let mut left = share_tokens;
    let mut kept = Vec::new();
    for mut t in std::mem::take(tables) {
        let mut lines: Vec<&str> = t.text.split('\n').collect();
        let mut cost = estimate_tokens(&t.text, false);
        let mut dropped = false;
        while cost > left && lines.len() > 2 {
            lines.pop();
            cost = estimate_tokens(&lines.join("\n"), false);
            dropped = true;
        }
        // An empty table (no rows read) is not sent.
        if t.rows == 0 || cost > left {
            fit.left_out.push(t.table);
            continue;
        }
        if dropped {
            let rows = u32::try_from(lines.len() - 1).unwrap_or(u32::MAX);
            let text = lines.join("\n");
            t.text = text;
            t.rows = rows;
            fit.cut.push(t.table.clone());
        }
        left -= cost;
        fit.sent.push((t.table.clone(), t.rows));
        kept.push(t);
    }
    *tables = kept;
    fit
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ColumnInfo;

    #[test]
    fn sample_table_debug_holds_no_cell() {
        let t = SampleTable {
            table: "orders".into(),
            reason: "name match".into(),
            text: "orders(note, password)\n[\"zq-cell-7731\",\"[redacted]\"]".into(),
            rows: 1,
            secret_columns: vec!["password".into()],
        };
        let shown = format!("{t:?}");
        assert!(!shown.contains("zq-cell-7731"), "{shown}");
        assert!(
            shown.contains("orders") && shown.contains("name match"),
            "{shown}"
        );
        assert!(
            shown.contains("rows: 1") && shown.contains("secret_columns: 1"),
            "{shown}"
        );
    }

    fn col(name: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            type_name: "text".into(),
            is_primary_key: false,
        }
    }

    fn text(value: &str) -> Cell {
        Cell::Text {
            value: value.into(),
            truncated: false,
            total_bytes: value.len() as u64,
        }
    }

    fn page(cols: &[&str], rows: Vec<Vec<Cell>>) -> Page {
        Page {
            columns: cols.iter().map(|c| col(c)).collect(),
            rows,
            has_more: false,
        }
    }

    #[test]
    fn format_header_and_rows() {
        let p = page(
            &["id", "note", "gone"],
            vec![
                vec![
                    Cell::Number { value: "42".into() },
                    text("say \"hi\"\nthere"),
                    Cell::Null,
                ],
                vec![Cell::Number { value: "7".into() }, text("b"), text("c")],
            ],
        );
        let t = format_rows("orders", "open tab", &p);
        assert_eq!(
            t.text,
            "orders(id, note, gone)\n[\"42\",\"say \\\"hi\\\"\\nthere\",null]\n[\"7\",\"b\",\"c\"]"
        );
        assert_eq!(t.rows, 2);
        assert_eq!(t.table, "orders");
        assert_eq!(t.reason, "open tab");
        assert!(t.secret_columns.is_empty());
    }

    #[test]
    fn cells_cut_at_200_with_ellipsis() {
        let cell = Cell::Text {
            value: "x".repeat(1024),
            truncated: true,
            total_bytes: 1_000_000,
        };
        let t = format_rows("t", "r", &page(&["a"], vec![vec![cell]]));
        let line = t.text.lines().nth(1).unwrap();
        let v: Vec<String> = serde_json::from_str(line).unwrap();
        assert_eq!(v[0].chars().count(), 201);
        assert!(v[0].ends_with('…') && v[0].starts_with(&"x".repeat(200)));
        // A decoder-truncated short value also gets the mark; a short whole one does not.
        let short = Cell::Text {
            value: "ab".into(),
            truncated: true,
            total_bytes: 9,
        };
        let t = format_rows("t", "r", &page(&["a"], vec![vec![short]]));
        assert!(t.text.ends_with("[\"ab…\"]"));
    }

    #[test]
    fn cells_cut_by_characters_not_bytes() {
        for ch in ["界", "😀"] {
            let cell = text(&ch.repeat(300));
            let t = format_rows("t", "r", &page(&["a"], vec![vec![cell]]));
            let v: Vec<String> = serde_json::from_str(t.text.lines().nth(1).unwrap()).unwrap();
            assert_eq!(v[0].chars().count(), 201);
            assert_eq!(v[0], format!("{}…", ch.repeat(200)));
        }
        // Exactly 200 characters is not cut.
        let t = format_rows("t", "r", &page(&["a"], vec![vec![text(&"界".repeat(200))]]));
        assert!(!t.text.contains('…'));
    }

    #[test]
    fn header_stays_one_line() {
        let p = page(&["a\nb", "c\r"], vec![vec![Cell::Null, Cell::Null]]);
        let t = format_rows("we\nird", "r", &p);
        assert_eq!(t.text.lines().count(), 2);
        assert_eq!(t.rows, 1);
        assert!(t.text.starts_with("we\\nird(a\\nb, c\\r)\n"));
    }

    #[test]
    fn binary_cells() {
        let b = Cell::Bytes {
            preview_hex: "deadbeef".into(),
            truncated: true,
            total_bytes: 10_000_000,
        };
        let t = format_rows("t", "r", &page(&["blob"], vec![vec![b]]));
        assert!(t.text.ends_with("[\"<binary>\"]"));
        assert!(!t.text.contains("dead"));
    }

    #[test]
    fn secret_columns_redacted() {
        for name in [
            "password_hash",
            "apiKey",
            "api_key",
            "refreshToken",
            "private_key",
            "pwd",
            "passwords",
            "passwds",
            "pwds",
            "secrets",
            "tokens",
            "salts",
            "apikeys",
            "otps",
            "api_keys",
            "privateKeys",
            "access_keys",
            "secret_keys",
        ] {
            assert!(secret_column(name), "{name}");
        }
        for name in ["hashtag", "keyboard", "secretary_id", "key_id"] {
            assert!(!secret_column(name), "{name}");
        }
        let p = page(
            &["id", "password_hash", "note"],
            vec![vec![
                Cell::Number { value: "1".into() },
                text("$2b$12$abc"),
                Cell::Null,
            ]],
        );
        let t = format_rows("users", "name match", &p);
        assert!(!t.text.contains("$2b"));
        assert!(t.text.ends_with("[\"1\",\"[redacted]\",null]"));
        assert_eq!(t.secret_columns, ["password_hash"]);
    }

    #[test]
    fn wide_table_capped() {
        let names: Vec<String> = (0..300).map(|i| format!("c{i}")).collect();
        let cols: Vec<&str> = names.iter().map(String::as_str).collect();
        let row = || (0..300).map(|_| text(&"y".repeat(200))).collect::<Vec<_>>();
        let t = format_rows("wide", "r", &page(&cols, vec![row(), row()]));
        assert!(t.text.len() <= ROWS_ITEM_CAP);
        assert_eq!(t.text.lines().count() as u32, 1 + t.rows);
        assert!(t.text.ends_with(')') || t.text.ends_with(']'));
        // Narrower rows: as many whole lines as fit.
        let rows: Vec<Vec<Cell>> = (0..5)
            .map(|_| (0..40).map(|_| text(&"z".repeat(200))).collect())
            .collect();
        let t = format_rows("mid", "r", &page(&cols[..40], rows));
        assert!(t.text.len() <= ROWS_ITEM_CAP);
        assert!(t.rows >= 1 && t.rows < 5);
        assert_eq!(t.text.lines().count() as u32, 1 + t.rows);
        assert!(t.text.ends_with("\"]"));
    }

    fn sample(name: &str, rows: usize) -> SampleTable {
        let rows: Vec<Vec<Cell>> = (0..rows).map(|_| vec![text(&"v".repeat(60))]).collect();
        format_rows(name, "name match", &page(&["a"], rows))
    }

    #[test]
    fn fit_rows_cuts_rows_then_tables() {
        let mut tables = vec![sample("a", 5), sample("b", 5), sample("c", 5)];
        let whole = estimate_tokens(&tables[0].text, false);
        let two_rows = estimate_tokens(
            &tables[1]
                .text
                .lines()
                .take(3)
                .collect::<Vec<_>>()
                .join("\n"),
            false,
        );
        let fit = fit_rows(&mut tables, whole + two_rows);
        assert_eq!(fit.sent, [("a".to_string(), 5), ("b".to_string(), 2)]);
        assert_eq!(fit.cut, ["b"]);
        assert_eq!(fit.left_out, ["c"]);
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[1].rows, 2);
        assert_eq!(tables[1].text.lines().count(), 3);
        // Nothing fits: all out.
        let mut tables = vec![sample("a", 5)];
        let fit = fit_rows(&mut tables, 1);
        assert_eq!(fit.left_out, ["a"]);
        assert!(tables.is_empty() && fit.sent.is_empty());
    }
}
