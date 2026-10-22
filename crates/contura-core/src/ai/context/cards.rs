//! Table cards: the compact schema line per table that the assistant reads, built from a
//! fresh `schema_snapshot` (tier 1).

use crate::ai::rails::{Secrets, cap_chars, redact_secrets, strip_invisible};
use crate::ai::request::TableRef;
use crate::schema_model::{SchemaModel, SmDefault, SmEnum, SmRef, SmTable};

/// R2.4 card cap in bytes.
const CARD_CAP: usize = 4 * 1024;
/// R2.4 comment cap in characters.
const COMMENT_CHARS: usize = 300;

/// R2.1 and R2.2 for database text that goes into a card: invisible characters removed,
/// secret shapes and the saved secrets replaced by `[redacted]`.
pub fn cleaner(secrets: &Secrets) -> impl Fn(&str) -> String + '_ {
    move |text| redact_secrets(&strip_invisible(text).0, secrets).0
}

/// A comment as a card holds it: cleaned, on one line, at most 300 characters.
pub(crate) fn comment(text: &str, clean: &dyn Fn(&str) -> String) -> String {
    let one_line = clean(text).split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(COMMENT_CHARS).collect()
}

/// Expression, boolean and NULL defaults are shown; string and number defaults are values
/// and are masked (plan ruling 13), and so is every quoted literal inside an expression.
fn default_text(default: &SmDefault) -> String {
    match default {
        SmDefault::String { .. } => "'…'".into(),
        SmDefault::Number { .. } => "?".into(),
        SmDefault::Bool { value } => value.to_string(),
        SmDefault::Null => "null".into(),
        SmDefault::Expression { value } => {
            mask_quoted(&value.split_whitespace().collect::<Vec<_>>().join(" "))
        }
    }
}

/// Removes a string introducer written right before a quote from the end of `out`:
/// a MySQL charset (`_utf8mb4`), or `E`, `N`, `X`, `B` and `U&`.
fn drop_introducer(out: &mut String) {
    if out.ends_with("U&") || out.ends_with("u&") {
        out.truncate(out.len() - 2);
        return;
    }
    let word = out
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .count();
    let start = out.len() - word;
    let w = &out[start..];
    let charset = w.len() > 1 && w.starts_with('_');
    if charset
        || ["e", "n", "x", "b"]
            .iter()
            .any(|i| w.eq_ignore_ascii_case(i))
    {
        out.truncate(start);
    }
}

/// The end (exclusive, in chars) of the literal whose opening quote ends at `from`. A
/// literal opened with `\'` (MySQL's escaped form) closes at the next `\'`; otherwise a
/// doubled quote or a backslash escapes. An unclosed literal runs to the end.
fn literal_end(chars: &[char], mut j: usize, escaped_quotes: bool) -> usize {
    while j < chars.len() {
        let next = chars.get(j + 1) == Some(&'\'');
        match chars[j] {
            '\\' if escaped_quotes && next => return j + 2,
            '\\' => j += 2,
            '\'' if !escaped_quotes && next => j += 2,
            '\'' if !escaped_quotes => return j + 1,
            _ => j += 1,
        }
    }
    chars.len()
}

/// The `$tag$` opener at `i`, as chars, when there is one.
fn dollar_tag(chars: &[char], i: usize) -> Option<usize> {
    let word = |c: &char| c.is_alphanumeric() || *c == '_';
    if i > 0 && word(&chars[i - 1]) {
        return None;
    }
    let len = chars[i + 1..].iter().take_while(|c| word(c)).count();
    (chars.get(i + 1 + len) == Some(&'$') && !chars.get(i + 1).is_some_and(char::is_ascii_digit))
        .then_some(len + 2)
}

/// `expr` with each quoted literal (with its introducer) and dollar-quoted body replaced
/// by `'…'`. A literal cast to `regclass` names a sequence, not a value, and stays.
fn mask_quoted(expr: &str) -> String {
    let chars: Vec<char> = expr.chars().collect();
    let mut out = String::with_capacity(expr.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let escaped = c == '\\' && chars.get(i + 1) == Some(&'\'');
        if c == '\'' || escaped {
            let open = if escaped { 2 } else { 1 };
            let end = literal_end(&chars, i + open, escaped);
            let rest: String = chars[end..].iter().take(10).collect();
            if rest.eq_ignore_ascii_case("::regclass") {
                out.extend(&chars[i..end]);
            } else {
                drop_introducer(&mut out);
                out.push_str("'…'");
            }
            i = end;
        } else if let Some(tag) = (c == '$').then(|| dollar_tag(&chars, i)).flatten() {
            let opener = &chars[i..i + tag];
            let body = i + tag;
            let close = (body..chars.len()).find(|&k| chars[k..].starts_with(opener));
            out.push_str("'…'");
            i = close.map_or(chars.len(), |k| k + tag);
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

pub(crate) fn same_table(schema: &Option<String>, name: &str, table: &SmTable) -> bool {
    name == table.name && (schema.is_none() || table.schema.is_none() || *schema == table.schema)
}

/// `orders(id int pk, customer_id int not null -> customers.id, status order_status)
/// -- note: one row per checkout`: per column the name, type, `pk`, `not null`, `unique`,
/// a shown default and a foreign key; then the table note, the column comments and the
/// values of enum types the columns name, each after ` -- `. Names, types and comments go
/// through `clean`; comments are cut to 300 characters; the card is cut to 4 KB on a char
/// boundary.
pub fn card(table: &SmTable, model: &SchemaModel, clean: &dyn Fn(&str) -> String) -> String {
    card_with(table, &model.refs, &model.enums, clean)
}

fn card_with(
    table: &SmTable,
    refs: &[SmRef],
    model_enums: &[SmEnum],
    clean: &dyn Fn(&str) -> String,
) -> String {
    let in_pk = |col: &str| {
        table
            .indexes
            .iter()
            .any(|i| i.pk && i.columns.iter().any(|c| c == col))
    };
    let single_unique = |col: &str| {
        table
            .indexes
            .iter()
            .any(|i| i.unique && !i.pk && i.columns.len() == 1 && i.columns[0] == col)
    };
    let mut tail: Vec<String> = Vec::new();
    if let Some(note) = &table.note {
        let note = comment(note, clean);
        if !note.is_empty() {
            tail.push(format!("note: {note}"));
        }
    }
    let mut enums: Vec<String> = Vec::new();
    let cols: Vec<String> = table
        .columns
        .iter()
        .map(|c| {
            let mut s = format!("{} {}", clean(&c.name), clean(&c.type_name));
            let pk = c.pk || in_pk(&c.name);
            if pk {
                s.push_str(" pk");
            } else if c.not_null {
                s.push_str(" not null");
            }
            if !pk && (c.unique || single_unique(&c.name)) {
                s.push_str(" unique");
            }
            if let Some(d) = &c.default {
                s.push_str(" default ");
                s.push_str(&default_text(d));
            }
            let fk = refs.iter().find(|r| {
                same_table(&r.from.schema, &r.from.table, table) && r.from.columns.contains(&c.name)
            });
            if let Some(fk) = fk {
                let i = fk.from.columns.iter().position(|n| *n == c.name);
                let to = i
                    .and_then(|i| fk.to.columns.get(i))
                    .or(fk.to.columns.first());
                if let Some(to) = to {
                    s.push_str(&format!(" -> {}.{}", clean(&fk.to.table), clean(to)));
                }
            }
            if let Some(note) = &c.note {
                let note = comment(note, clean);
                if !note.is_empty() {
                    tail.push(format!("{}: {note}", clean(&c.name)));
                }
            }
            let named = model_enums.iter().find(|e| {
                c.type_name == e.name
                    || e.schema
                        .as_ref()
                        .is_some_and(|s| c.type_name == format!("{s}.{}", e.name))
            });
            if let Some(e) = named
                && !enums
                    .iter()
                    .any(|n| n.starts_with(&format!("{}: ", clean(&e.name))))
            {
                let values: Vec<String> = e
                    .values
                    .iter()
                    .map(|v| format!("'{}'", comment(v, clean).replace('\'', "''")))
                    .collect();
                enums.push(format!("{}: {}", clean(&e.name), values.join(", ")));
            }
            s
        })
        .collect();
    tail.extend(enums);
    let mut line = format!("{}({})", clean(&table.name), cols.join(", "));
    for t in tail {
        line.push_str(" -- ");
        line.push_str(&t);
    }
    // A quoted name or type may hold a line break; the card stays one line.
    let mut line = line.replace('\r', r"\r").replace('\n', r"\n");
    let cut = cap_chars(&line, CARD_CAP).len();
    line.truncate(cut);
    line
}

/// Enum values are values: below AI access "Plus sample rows" they leave the model, and
/// MySQL's inline `enum('a','b')` and `set(...)` types lose their lists.
pub fn hide_enum_values(model: &mut SchemaModel) {
    model.enums.clear();
    for table in &mut model.tables {
        hide_inline_enums(table);
    }
}

fn hide_inline_enums(table: &mut SmTable) {
    for col in &mut table.columns {
        let lower = col.type_name.to_ascii_lowercase();
        for kind in ["enum(", "set("] {
            if lower.starts_with(kind) {
                col.type_name = format!("{}…)", &col.type_name[..kind.len()]);
            }
        }
    }
}

/// The card without enum values (the `hide_enum_values` rule) and the card with them;
/// the second is `""` when both are equal.
pub fn card_pair(
    table: &SmTable,
    model: &SchemaModel,
    clean: &dyn Fn(&str) -> String,
) -> (String, String) {
    let mut hidden_table = table.clone();
    hide_inline_enums(&mut hidden_table);
    let hidden = card_with(&hidden_table, &model.refs, &[], clean);
    let full = card(table, model, clean);
    if full == hidden {
        (hidden, String::new())
    } else {
        (hidden, full)
    }
}

/// Whether `table` is one of the tables the Ask came with.
pub fn is_focus(table: &SmTable, focus: &[TableRef]) -> bool {
    focus.iter().any(|r| same_table(&r.schema, &r.name, table))
}

/// (table name, card) for every table: the focus tables first, sorted by name, then every
/// other table sorted by name.
pub fn cards_all(
    focus: &[TableRef],
    model: &SchemaModel,
    clean: &dyn Fn(&str) -> String,
) -> Vec<(String, String)> {
    let mut tables: Vec<&SmTable> = model.tables.iter().collect();
    tables.sort_by(|a, b| {
        (!is_focus(a, focus), &a.name, &a.schema).cmp(&(!is_focus(b, focus), &b.name, &b.schema))
    });
    tables
        .into_iter()
        .map(|t| (t.name.clone(), card(t, model, clean)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DialectKind;
    use crate::schema_model::{SmColumn, SmEndpoint, SmEnum, SmIndex, SmRef};

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

    fn table(name: &str, columns: Vec<SmColumn>) -> SmTable {
        SmTable {
            schema: Some("public".into()),
            name: name.into(),
            alias: None,
            note: None,
            columns,
            indexes: Vec::new(),
        }
    }

    fn keep(text: &str) -> String {
        text.to_string()
    }

    fn shown(expr: &str) -> String {
        default_text(&SmDefault::Expression { value: expr.into() })
    }

    #[test]
    fn expression_defaults_hide_their_literals() {
        // MySQL 8 reports `DEFAULT ('tok')` with a charset introducer, in either form.
        assert_eq!(shown("_utf8mb4'internal-token'"), "'…'");
        assert_eq!(shown(r"_utf8mb4\'internal-token\'"), "'…'");
        assert_eq!(
            shown(r"concat(_utf8mb4\'a\',_latin1\'b\')"),
            "concat('…','…')"
        );
        assert_eq!(shown("ARRAY['admin'::text]"), "ARRAY['…'::text]");
        assert_eq!(shown("COALESCE('x', name)"), "COALESCE('…', name)");
        assert_eq!(
            shown("('a'::text || 'b'::text)"),
            "('…'::text || '…'::text)"
        );
        assert_eq!(shown("lower('it''s' || code)"), "lower('…' || code)");
        assert_eq!(shown(r"E'it\'s a secret'"), "'…'");
        assert_eq!(
            shown("N'x' || X'0F' || B'01' || U&'d'"),
            "'…' || '…' || '…' || '…'"
        );
        assert_eq!(shown("md5($$hunter2$$)"), "md5('…')");
        assert_eq!(shown("f($tag$a $ b$tag$, 1)"), "f('…', 1)");
        assert_eq!(shown("'open"), "'…'");
        // A sequence name is not a value; plain expressions stay as written.
        assert_eq!(
            shown("nextval('orders_id_seq'::regclass)"),
            "nextval('orders_id_seq'::regclass)"
        );
        assert_eq!(shown("now()"), "now()");
        assert_eq!(shown("(  gen_random_uuid() )"), "( gen_random_uuid() )");
    }

    fn shop() -> SchemaModel {
        let mut orders = table(
            "orders",
            vec![
                SmColumn {
                    pk: true,
                    increment: true,
                    ..col("id", "int")
                },
                SmColumn {
                    not_null: true,
                    ..col("customer_id", "int")
                },
                SmColumn {
                    not_null: true,
                    default: Some(SmDefault::String {
                        value: "new".into(),
                    }),
                    note: Some("where the order is".into()),
                    ..col("status", "order_status")
                },
                SmColumn {
                    default: Some(SmDefault::Number { value: "0".into() }),
                    ..col("total", "numeric(12,2)")
                },
                SmColumn {
                    not_null: true,
                    default: Some(SmDefault::Expression {
                        value: "now()".into(),
                    }),
                    ..col("created_at", "timestamptz")
                },
                SmColumn {
                    default: Some(SmDefault::Bool { value: false }),
                    ..col("paid", "bool")
                },
                SmColumn {
                    default: Some(SmDefault::Null),
                    ..col("code", "text")
                },
            ],
        );
        orders.note = Some("one row per checkout".into());
        orders.indexes.push(SmIndex {
            name: Some("orders_code_key".into()),
            columns: vec!["code".into()],
            unique: true,
            pk: false,
        });
        let customers = table(
            "customers",
            vec![
                SmColumn {
                    pk: true,
                    ..col("id", "int")
                },
                col("name", "text"),
            ],
        );
        SchemaModel {
            dialect: DialectKind::Postgres,
            tables: vec![orders, customers],
            refs: vec![SmRef {
                name: None,
                from: SmEndpoint {
                    schema: Some("public".into()),
                    table: "orders".into(),
                    columns: vec!["customer_id".into()],
                },
                to: SmEndpoint {
                    schema: Some("public".into()),
                    table: "customers".into(),
                    columns: vec!["id".into()],
                },
                on_delete: None,
                on_update: None,
            }],
            enums: Vec::new(),
            skipped: Vec::new(),
        }
    }

    fn named(name: &str) -> TableRef {
        TableRef {
            schema: None,
            name: name.into(),
        }
    }

    #[test]
    fn card_from_schema_model() {
        let model = shop();
        assert_eq!(
            card(&model.tables[0], &model, &keep),
            "orders(id int pk, customer_id int not null -> customers.id, \
             status order_status not null default '…', total numeric(12,2) default ?, \
             created_at timestamptz not null default now(), paid bool default false, \
             code text unique default null) -- note: one row per checkout \
             -- status: where the order is"
        );
        assert_eq!(
            card(&model.tables[1], &model, &keep),
            "customers(id int pk, name text)"
        );
    }

    #[test]
    fn a_name_with_a_line_break_stays_one_card_line() {
        // Task 4 and 6 reviews: a quoted name may hold a line break; the card is one line.
        let model = SchemaModel {
            dialect: DialectKind::Postgres,
            tables: vec![table("odd\nname", vec![col("a\r\nb", "text")])],
            refs: Vec::new(),
            enums: Vec::new(),
            skipped: Vec::new(),
        };
        let line = card(&model.tables[0], &model, &keep);
        assert_eq!(line.lines().count(), 1, "{line}");
        assert_eq!(line, r"odd\nname(a\r\nb text)");
    }

    #[test]
    fn enum_values_only_while_the_model_holds_them() {
        let mut model = shop();
        model.enums.push(SmEnum {
            schema: Some("public".into()),
            name: "order_status".into(),
            values: vec!["new".into(), "paid".into(), "o'k".into()],
        });
        model.tables[1].columns.push(col("kind", "enum('a','b')"));
        let c = card(&model.tables[0], &model, &keep);
        assert!(
            c.ends_with(" -- status: where the order is -- order_status: 'new', 'paid', 'o''k'"),
            "{c}"
        );

        hide_enum_values(&mut model);
        let c = card(&model.tables[0], &model, &keep);
        assert!(c.ends_with(" -- status: where the order is"), "{c}");
        assert_eq!(
            card(&model.tables[1], &model, &keep),
            "customers(id int pk, name text, kind enum(…))"
        );
    }

    #[test]
    fn comment_cleaned_and_capped() {
        let mut model = shop();
        let mut long = "key sk-ant-xxxxxxxxxxxxxxxx here\u{200B} and\nmore ".to_string();
        while long.chars().count() < 500 {
            long.push_str(if 500 - long.chars().count() >= 5 {
                "word "
            } else {
                "w"
            });
        }
        assert_eq!(long.chars().count(), 500);
        model.tables[1].note = Some(long);
        let secrets = Secrets::default();
        let clean = cleaner(&secrets);
        let c = card(&model.tables[1], &model, &clean);
        let note = c.split(" -- note: ").nth(1).unwrap();
        assert!(
            note.starts_with("key [redacted] here and more word"),
            "{note}"
        );
        assert!(!c.contains('\u{200B}'));
        assert!(!c.contains("sk-ant"));
        assert_eq!(note.chars().count(), 300);
    }

    #[test]
    fn card_capped_on_char_boundary() {
        let columns = (0..200)
            .map(|i| SmColumn {
                note: Some("注文の状態を表す列です".repeat(3)),
                ..col(&format!("列{i}"), "text")
            })
            .collect();
        let model = SchemaModel {
            dialect: DialectKind::Postgres,
            tables: vec![table("注文", columns)],
            refs: Vec::new(),
            enums: Vec::new(),
            skipped: Vec::new(),
        };
        let c = card(&model.tables[0], &model, &keep);
        assert!(c.len() <= CARD_CAP);
        assert!(c.len() > CARD_CAP - 4);
        assert!(c.starts_with("注文(列0 text, "));
    }

    #[test]
    fn cards_all_puts_focus_first_then_the_rest_by_name() {
        let mut model = shop();
        model
            .tables
            .push(table("addresses", vec![col("id", "int")]));
        model.tables.push(table("zones", vec![col("id", "int")]));
        let names = |cards: Vec<(String, String)>| -> Vec<String> {
            cards.into_iter().map(|(n, _)| n).collect()
        };
        assert_eq!(
            names(cards_all(&[named("zones"), named("orders")], &model, &keep)),
            ["orders", "zones", "addresses", "customers"]
        );
        assert_eq!(
            names(cards_all(&[], &model, &keep)),
            ["addresses", "customers", "orders", "zones"]
        );
        let wrong = TableRef {
            schema: Some("other".into()),
            name: "zones".into(),
        };
        assert_eq!(
            names(cards_all(&[wrong, named("gone")], &model, &keep))[0],
            "addresses"
        );
    }

    #[test]
    fn names_are_cleaned() {
        let mut model = shop();
        model.tables[1].name = "cust\u{200B}omers".into();
        model.tables[1].columns[1].name = "na\u{200B}me".into();
        model.tables[1].columns[1].type_name = "te\u{200B}xt".into();
        let secrets = Secrets::default();
        let clean = cleaner(&secrets);
        assert_eq!(
            card(&model.tables[1], &model, &clean),
            "customers(id int pk, name text)"
        );
        // The comment's label is the cleaned name too.
        model.tables[1].columns[1].note = Some("full name".into());
        let text = card(&model.tables[1], &model, &clean);
        assert!(!text.contains('\u{200B}'), "{text:?}");
        assert!(text.contains("name: full name"), "{text}");
    }

    #[test]
    fn card_pair_splits_enum_values() {
        let mut model = shop();
        model.enums.push(SmEnum {
            schema: Some("public".into()),
            name: "order_status".into(),
            values: vec!["new".into(), "paid".into()],
        });
        model.tables[1]
            .columns
            .push(col("kind", "enum('new','paid')"));
        let (hidden, rows) = card_pair(&model.tables[0], &model, &keep);
        assert!(!hidden.contains("'new'"), "{hidden}");
        assert!(rows.contains("'new'") && rows.contains("'paid'"), "{rows}");
        assert_eq!(rows, card(&model.tables[0], &model, &keep));

        let (hidden, rows) = card_pair(&model.tables[1], &model, &keep);
        assert_eq!(hidden, "customers(id int pk, name text, kind enum(…))");
        assert_eq!(
            rows,
            "customers(id int pk, name text, kind enum('new','paid'))"
        );

        model.tables.push(table("plain", vec![col("id", "int")]));
        let (hidden, rows) = card_pair(&model.tables[2], &model, &keep);
        assert_eq!(hidden, "plain(id int)");
        assert_eq!(rows, "");
        // The model itself keeps its enums.
        assert_eq!(model.enums.len(), 1);
    }
}
