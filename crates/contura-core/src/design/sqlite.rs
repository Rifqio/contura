//! SQLite plans: `ALTER TABLE` where SQLite can change the table in place,
//! otherwise its documented rebuild (create, copy, drop, rename) in one transaction.

use super::model::{Increment, SqliteExtras, TableColumn, TableDesign, TableIndex};
use super::plan::{
    Alter, ColumnDraft, DesignEdit, DesignMode, DesignPlan, Draft, checked_action, column_draft,
    diff, fk_target, invalid, rename_order,
};
use super::warning::DesignWarning;
use crate::common::{sql_ident, sql_scoped, sql_string, sql_table};
use crate::ddl::{ColumnSql, FkSql, column_sql, foreign_key_sql, idents};
use crate::error::Result;
use crate::model::DialectKind;
use crate::sqlite::tokens::{TokKind, column_collations, is_literal, names_object, tokens};

const LITE: DialectKind = DialectKind::Sqlite;

fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// The plan for edits on a loaded SQLite table: in place when SQLite's
/// `ALTER TABLE` can do every edit, otherwise the rebuild.
pub(super) fn plan(base: &TableDesign, edits: &[DesignEdit]) -> Result<DesignPlan> {
    let Some(extras) = base.sqlite.as_ref() else {
        return Err(invalid(format!(
            "Reload {}: Contura needs its saved SQL to change it.",
            base.path.name
        )));
    };
    let a = diff(LITE, base, edits)?;
    let mut draft = Draft::from_base(base);
    draft.apply(edits)?;
    for (i, _) in &a.renamed_indexes {
        if i.sql.is_none() {
            return Err(invalid(format!(
                "SQLite names the index {} itself, so it cannot be renamed.",
                i.name
            )));
        }
    }
    check_columns(base, &a, &draft)?;
    if in_place_possible(base, extras, &a) {
        return in_place(base, a);
    }
    rebuild(base, extras, a, &draft)
}

/// The loaded index an edited one came from.
fn loaded_index<'a>(base: &'a TableDesign, origin: &Option<String>) -> Option<&'a TableIndex> {
    let origin = origin.as_deref()?;
    base.indexes.iter().find(|i| i.name == origin)
}

/// Every index and key names columns the table still has.
fn check_columns(base: &TableDesign, a: &Alter, draft: &Draft) -> Result<()> {
    let has = |name: &str| draft.columns.iter().any(|c| same(&c.name, name));
    let dropped: Vec<String> = a.dropped_columns.iter().map(|c| c.name.clone()).collect();
    for (i, origin) in draft.indexes.iter().zip(&draft.index_origins) {
        let saved = loaded_index(base, origin).and_then(|l| l.sql.as_deref());
        let missing = match saved {
            // Saved text may hold expressions: look for the dropped names in it.
            Some(sql) => dropped
                .iter()
                .find(|d| names_object(index_body(sql), std::slice::from_ref(*d)))
                .cloned(),
            None => i.columns.iter().find(|c| !has(c)).cloned(),
        };
        if let Some(c) = missing {
            return Err(invalid(format!(
                "Index {} uses {c}. Drop the index too, or keep the column.",
                i.name
            )));
        }
    }
    for k in &draft.foreign_keys {
        if let Some(c) = k.columns.iter().find(|c| !has(c)) {
            return Err(invalid(format!(
                "Foreign Key {} uses {c}. Drop the key too, or keep the column.",
                k.name
            )));
        }
    }
    Ok(())
}

/// A saved `CREATE INDEX` after its table name: the key parts and the WHERE.
fn index_body(sql: &str) -> &str {
    let toks = tokens(sql);
    let Some(on) = toks.iter().position(|t| t.is_word("ON")) else {
        return sql;
    };
    let table = if toks
        .get(on + 2)
        .is_some_and(|t| t.kind == TokKind::Punct('.'))
    {
        on + 3
    } else {
        on + 1
    };
    toks.get(table).map_or(sql, |t| &sql[t.end..])
}

/// SQLite's `DROP COLUMN` takes the column: no index or key the table keeps uses
/// it, no saved trigger or view names it, and the table's text names it only
/// where it is defined (no CHECK, generated column or other clause uses it).
fn drops_in_place(c: &TableColumn, base: &TableDesign, extras: &SqliteExtras, a: &Alter) -> bool {
    let name = std::slice::from_ref(&c.name);
    let in_index = base
        .indexes
        .iter()
        .filter(|i| !a.dropped_indexes.iter().any(|d| d.name == i.name))
        .any(|i| {
            i.columns.iter().any(|x| same(x, &c.name))
                || i.sql
                    .as_deref()
                    .is_some_and(|s| names_object(index_body(s), name))
        });
    let in_key = base
        .foreign_keys
        .iter()
        .any(|k| k.columns.iter().any(|x| same(x, &c.name)));
    let in_saved = extras
        .triggers
        .iter()
        .chain(&extras.views)
        .chain(&extras.view_triggers)
        .any(|o| names_object(&o.sql, name));
    let mentions = tokens(&extras.create_sql)
        .iter()
        .filter(|t| t.is_name(&c.name))
        .count();
    !in_index && !in_key && !in_saved && mentions <= 1
}

/// Whether SQLite's `ALTER TABLE`, `CREATE INDEX` and `DROP INDEX` do every edit.
fn in_place_possible(base: &TableDesign, extras: &SqliteExtras, a: &Alter) -> bool {
    let keys = a.dropped_keys.is_empty() && a.added_keys.is_empty();
    // Autoindexes and the primary key have no saved text and no DROP INDEX.
    let indexes = a.dropped_indexes.iter().all(|i| i.sql.is_some())
        && a.added_indexes.iter().all(|i| !i.primary);
    let columns = a
        .dropped_columns
        .iter()
        .all(|c| drops_in_place(c, base, extras, a));
    let changes = a
        .changes
        .iter()
        .all(|ch| !ch.definition_changed() && ch.placement.is_none());
    let adds = a.added_columns.iter().all(|n| {
        let c = &n.column;
        let default = match &c.default_sql {
            None => c.nullable,
            Some(d) => is_literal(d) && (c.nullable || !same(d.trim(), "NULL")),
        };
        n.at_end && !c.increment && default
    });
    keys && indexes && columns && changes && adds
}

/// A new index, its name in the table's schema.
fn create_index(base: &TableDesign, name: &str, columns: &[String], unique: bool) -> String {
    format!(
        "CREATE {}INDEX {} ON {} ({})",
        if unique { "UNIQUE " } else { "" },
        sql_scoped(LITE, &base.path.database, name),
        sql_ident(LITE, &base.path.name),
        idents(LITE, columns)
    )
}

/// A saved `CREATE INDEX` with its name replaced when `rename` is given, and the
/// columns in `columns` given their new names. Everything else stays as written.
fn rewritten_index(
    sql: &str,
    database: &str,
    rename: Option<&str>,
    columns: &[(String, String)],
) -> String {
    let toks = tokens(sql);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    if let Some(to) = rename
        && let Some(k) = toks.iter().position(|t| t.is_word("INDEX"))
    {
        let mut first = k + 1;
        if toks.get(first).is_some_and(|t| t.is_word("IF")) {
            first += 3;
        }
        let last = if toks
            .get(first + 1)
            .is_some_and(|t| t.kind == TokKind::Punct('.'))
        {
            first + 2
        } else {
            first
        };
        if let (Some(f), Some(l)) = (toks.get(first), toks.get(last)) {
            edits.push((f.start, l.end, sql_scoped(LITE, database, to)));
        }
    }
    if !columns.is_empty() {
        let body = sql.len() - index_body(sql).len();
        for (k, t) in toks.iter().enumerate() {
            let named = matches!(t.kind, TokKind::Word | TokKind::Ident);
            let call = toks
                .get(k + 1)
                .is_some_and(|n| n.kind == TokKind::Punct('('));
            let collation = k > 0 && toks[k - 1].is_word("COLLATE");
            if t.start < body || !named || call || collation {
                continue;
            }
            if let Some((_, new)) = columns.iter().find(|(old, _)| t.is_name(old)) {
                edits.push((t.start, t.end, sql_ident(LITE, new)));
            }
        }
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = sql.to_string();
    for (start, end, text) in edits {
        out.replace_range(start..end, &text);
    }
    out
}

fn in_place(base: &TableDesign, a: Alter) -> Result<DesignPlan> {
    let t = |rest: String| format!("ALTER TABLE {} {rest}", a.table);
    let q = |name: &str| sql_ident(LITE, name);
    let database = &base.path.database;
    let mut out = Vec::new();
    for i in &a.dropped_indexes {
        out.push(format!(
            "DROP INDEX {}",
            sql_scoped(LITE, database, &i.name)
        ));
    }
    // Index renames go before the column renames, so the saved text still
    // names the columns as they are.
    let index_renames = a
        .renamed_indexes
        .iter()
        .map(|(i, to)| (i.name.clone(), to.clone()))
        .collect();
    for (from, to) in rename_order(index_renames, "indexes")? {
        let sql = a
            .renamed_indexes
            .iter()
            .find(|(i, _)| i.name == from)
            .and_then(|(i, _)| i.sql.as_deref())
            .expect("checked: a renamed index has saved text");
        out.push(format!("DROP INDEX {}", sql_scoped(LITE, database, &from)));
        out.push(rewritten_index(sql, database, Some(&to), &[]));
    }
    for c in &a.dropped_columns {
        out.push(t(format!("DROP COLUMN {}", q(&c.name))));
    }
    let renames = a
        .changes
        .iter()
        .filter(|ch| ch.renamed)
        .map(|ch| (ch.base.name.clone(), ch.column.name.clone()))
        .collect();
    for (from, to) in rename_order(renames, "columns")? {
        out.push(t(format!("RENAME COLUMN {} TO {}", q(&from), q(&to))));
    }
    for n in &a.added_columns {
        out.push(t(format!(
            "ADD COLUMN {}",
            column_line(&n.column, false, None)
        )));
    }
    for i in &a.added_indexes {
        out.push(create_index(base, &i.name, &i.columns, i.unique));
    }
    Ok(DesignPlan {
        statements: out,
        warnings: a.warnings,
        mode: DesignMode::Transaction,
        before: 0,
        after: 0,
        checks: vec![],
        foreign_keys: None,
        loaded: None,
    })
}

/// One column line of a `CREATE TABLE` or `ADD COLUMN`.
fn column_line(c: &ColumnDraft, autoincrement: bool, collation: Option<String>) -> String {
    column_sql(
        LITE,
        &ColumnSql {
            name: c.name.clone(),
            type_sql: c.type_sql.clone(),
            nullable: c.nullable,
            default_sql: c.default_sql.clone(),
            increment: c.increment,
            sqlite_autoincrement: autoincrement,
            primary_inline: false,
            unique_inline: false,
            comment: None,
            mysql: None,
            collation,
            explicit_null: false,
        },
    )
}

/// The table's name as saved, which may differ in case from the name the
/// designer was opened with.
fn saved_name(extras: &SqliteExtras, fallback: &str) -> String {
    let toks = tokens(&extras.create_sql);
    let Some(k) = toks.iter().position(|t| t.is_word("TABLE")) else {
        return fallback.to_string();
    };
    let mut at = k + 1;
    if toks.get(at).is_some_and(|t| t.is_word("IF")) {
        at += 3;
    }
    if toks
        .get(at + 1)
        .is_some_and(|t| t.kind == TokKind::Punct('.'))
    {
        at += 2;
    }
    toks.get(at)
        .filter(|t| matches!(t.kind, TokKind::Word | TokKind::Ident) && same(&t.text, fallback))
        .map_or_else(|| fallback.to_string(), |t| t.text.clone())
}

/// Why the rebuild may only be copied, or `None`: a dropped or renamed column
/// named in a saved trigger or view, which come back as saved, or something in
/// the table's text the read model does not carry (D8d).
fn copy_only_reason(base: &TableDesign, extras: &SqliteExtras, a: &Alter) -> Option<String> {
    let gone: Vec<&String> = a
        .dropped_columns
        .iter()
        .map(|c| &c.name)
        .chain(
            a.changes
                .iter()
                .filter(|ch| ch.renamed)
                .map(|ch| &ch.base.name),
        )
        .collect();
    let lists = [
        ("trigger", &extras.triggers),
        ("view", &extras.views),
        ("trigger", &extras.view_triggers),
    ];
    for (kind, list) in lists {
        for o in list {
            let named = gone
                .iter()
                .find(|c| names_object(&o.sql, std::slice::from_ref(**c)));
            if let Some(c) = named {
                return Some(format!("{kind} {} uses {c}", o.name));
            }
        }
    }
    let toks = tokens(&extras.create_sql);
    let pair = |x: &str, y: &str| toks.windows(2).any(|w| w[0].is_word(x) && w[1].is_word(y));
    let collates = toks.iter().filter(|t| t.is_word("COLLATE")).count();
    let noted = |n: &str| base.unsupported.iter().any(|u| u == n);
    let reason = if toks.iter().any(|t| t.is_word("CHECK")) {
        "it has a CHECK constraint"
    } else if collates > column_collations(&extras.create_sql).len() {
        // Column collations are carried over (S4); any other COLLATE is not.
        "it uses a collation inside a constraint or an expression"
    } else if base.columns.iter().any(|c| c.generated) {
        "it has a generated column"
    } else if pair("ON", "CONFLICT") {
        "it has an ON CONFLICT clause"
    } else if noted("without rowid") || pair("WITHOUT", "ROWID") {
        "it is WITHOUT ROWID"
    } else if noted("strict") {
        "it is STRICT"
    } else {
        return None;
    };
    Some(reason.to_string())
}

/// The `unsupported` note of an advanced index or key.
fn note(base: &TableDesign, kind: &str, name: &str) -> String {
    let prefix = format!("{kind} {name} (");
    base.unsupported
        .iter()
        .find(|n| n.starts_with(&prefix))
        .cloned()
        .unwrap_or_else(|| format!("{kind} {name}"))
}

/// SQLite's documented rebuild: create the new table, copy the rows, drop the old
/// one, rename the new one, then bring back the indexes, triggers and views.
fn rebuild(
    base: &TableDesign,
    extras: &SqliteExtras,
    a: Alter,
    draft: &Draft,
) -> Result<DesignPlan> {
    let name = &base.path.name;
    let database = &base.path.database;
    // S2: an index or key the model cannot carry in full is never recreated.
    // An index with saved text comes back verbatim from it, so only an
    // autoindex counts (S8).
    let mut lost = Vec::new();
    for i in base
        .indexes
        .iter()
        .filter(|i| i.advanced && i.sql.is_none())
    {
        if draft.index_origins.contains(&Some(i.name.clone())) {
            lost.push(note(base, "index", &i.name));
        }
    }
    for k in base.foreign_keys.iter().filter(|k| k.advanced) {
        if draft.key_origins.contains(&Some(k.name.clone())) {
            lost.push(note(base, "foreign key", &k.name));
        }
    }
    if !lost.is_empty() {
        return Err(invalid(format!(
            "This change rebuilds {name}, and Contura cannot recreate {}. \
             Drop {} in this change, or make the change in SQL.",
            lost.join(", "),
            if lost.len() == 1 { "it" } else { "them" }
        )));
    }
    // Other tables' keys name this table's columns as they were: an in-place
    // rename updates them, a rebuild does not.
    let incoming = base
        .referenced_by
        .iter()
        .find(|r| !same(&r.table.name, name));
    if let (Some(r), Some(ch)) = (incoming, a.changes.iter().find(|ch| ch.renamed)) {
        return Err(invalid(format!(
            "Rename {} in a change of its own: this change rebuilds {name}, \
             and a rebuild would not carry the new name into the Foreign Keys of {}.",
            ch.base.name, r.table.name
        )));
    }
    if !draft.column_origins.iter().any(Option::is_some) {
        return Err(invalid(format!(
            "Keep at least one column of {name}, or drop the table and create a new one."
        )));
    }

    // The columns as edited: changed and added ones as `diff` checked them,
    // the others exactly as loaded.
    let mut columns: Vec<(ColumnDraft, Option<&TableColumn>)> = Vec::new();
    for (c, origin) in draft.columns.iter().zip(&draft.column_origins) {
        columns.push(match origin {
            Some(o) => {
                let loaded = base
                    .columns
                    .iter()
                    .find(|l| l.name == *o)
                    .expect("a kept column is loaded");
                let column = a
                    .changes
                    .iter()
                    .find(|ch| ch.base.name == *o)
                    .map_or_else(|| column_draft(loaded), |ch| ch.column.clone());
                (column, Some(loaded))
            }
            None => {
                let added = a
                    .added_columns
                    .iter()
                    .find(|n| n.column.name == c.name)
                    .expect("an added column is in the diff");
                (added.column.clone(), None)
            }
        });
    }

    let primary = draft.indexes.iter().find(|i| i.primary);
    let increments: Vec<&ColumnDraft> = columns
        .iter()
        .map(|(c, _)| c)
        .filter(|c| c.increment)
        .collect();
    let inline_key = match increments.first() {
        None => false,
        Some(c) => {
            let alias = increments.len() == 1
                && primary.is_some_and(|p| p.columns.len() == 1 && same(&p.columns[0], &c.name))
                && c.type_sql.trim().eq_ignore_ascii_case("integer");
            if !alias {
                return Err(invalid(format!(
                    "SQLite can only auto-increment a single INTEGER primary key ({name}.{})",
                    c.name
                )));
            }
            true
        }
    };

    let real = saved_name(extras, name);
    let new_name = format!("contura_new_{real}");
    let old = sql_table(LITE, &base.path)?;
    let new = sql_scoped(LITE, database, &new_name);
    let q = |n: &str| sql_ident(LITE, n);

    let mut lines = Vec::new();
    let mut autoincrement = false;
    for (c, loaded) in &columns {
        // S1: the keyword only where the loaded table had it.
        let keyword = c.increment && loaded.is_some_and(|l| l.sqlite_autoincrement);
        autoincrement |= keyword;
        // S4: a kept column keeps its collation.
        lines.push(column_line(
            c,
            keyword,
            loaded.and_then(|l| l.collation.clone()),
        ));
    }
    if let Some(p) = primary.filter(|_| !inline_key) {
        lines.push(format!("PRIMARY KEY ({})", idents(LITE, &p.columns)));
    }
    // An autoindex comes back from its UNIQUE, never from CREATE INDEX (D8c).
    for (i, origin) in draft.indexes.iter().zip(&draft.index_origins) {
        if loaded_index(base, origin).is_some_and(|l| !l.primary && l.sql.is_none()) {
            lines.push(format!("UNIQUE ({})", idents(LITE, &i.columns)));
        }
    }
    for k in &draft.foreign_keys {
        let target = fk_target(LITE, &base.path, &k.target)?;
        let line = foreign_key_sql(
            LITE,
            &FkSql {
                name: None,
                columns: k.columns.clone(),
                target: target.clone(),
                target_columns: k.target_columns.clone(),
                on_delete: checked_action(&k.on_delete)?,
                on_update: checked_action(&k.on_update)?,
            },
        );
        // A key read without target columns names the target's primary key.
        lines.push(if k.target_columns.is_empty() {
            line.replacen(&format!("{target} ()"), &target, 1)
        } else {
            line
        });
    }

    // With keys on, DROP TABLE deletes the rows first and fires the children's
    // ON DELETE actions, so the keys are always off for the copy (S8).
    let mut statements = vec!["PRAGMA foreign_keys = OFF".to_string()];
    let mut checks = Vec::new();
    // Dependents first: a view may name an earlier one (D8b).
    for v in extras.views.iter().rev() {
        statements.push(format!("DROP VIEW {}", sql_scoped(LITE, database, &v.name)));
    }
    statements.push(format!(
        "CREATE TABLE {new} (\n  {}\n)",
        lines.join(",\n  ")
    ));
    if autoincrement {
        // The new table's sequence starts where the old one stood, so the ids
        // of deleted rows are not used again.
        let sequence = sql_scoped(LITE, database, "sqlite_sequence");
        statements.push(format!(
            "INSERT INTO {sequence} (name, seq) SELECT {}, seq FROM {sequence} \
             WHERE name = {} COLLATE NOCASE",
            sql_string(LITE, &new_name),
            sql_string(LITE, &real),
        ));
    }
    let kept: Vec<(&ColumnDraft, &TableColumn)> = columns
        .iter()
        .filter_map(|(c, l)| l.map(|l| (c, l)))
        .collect();
    let mut into: Vec<String> = kept.iter().map(|(c, _)| q(&c.name)).collect();
    let mut from: Vec<String> = kept.iter().map(|(_, l)| q(&l.name)).collect();
    // Without a rowid alias on either side, the rowid is copied too, so rows keep
    // the ids apps and external-content tables may hold. An alias is a single
    // INTEGER primary key.
    let old_alias = base
        .columns
        .iter()
        .any(|c| c.increment == Increment::AutoIncrement);
    let new_alias = primary.is_some_and(|p| {
        p.columns.len() == 1
            && kept.iter().any(|(c, _)| {
                same(&c.name, &p.columns[0]) && c.type_sql.trim().eq_ignore_ascii_case("integer")
            })
    });
    let taken = |n: &str| {
        base.columns.iter().any(|c| same(&c.name, n))
            || columns.iter().any(|(c, _)| same(&c.name, n))
    };
    let rowid = ["rowid", "_rowid_", "oid"].into_iter().find(|n| !taken(n));
    let rowless = base.unsupported.iter().any(|u| u == "without rowid");
    if let (false, false, false, Some(r)) = (old_alias, new_alias, rowless, rowid) {
        into.insert(0, r.to_string());
        from.insert(0, r.to_string());
    }
    statements.push(format!(
        "INSERT INTO {new} ({}) SELECT {} FROM {old}",
        into.join(", "),
        from.join(", ")
    ));
    // A check: returns a row only when the copy holds a different number of rows.
    checks.push(statements.len());
    statements.push(format!(
        "SELECT count(*) FROM {old} EXCEPT SELECT count(*) FROM {new}"
    ));
    statements.push(format!("DROP TABLE {old}"));
    statements.push(format!("ALTER TABLE {new} RENAME TO {}", q(&real)));

    let column_renames: Vec<(String, String)> = a
        .changes
        .iter()
        .filter(|ch| ch.renamed)
        .map(|ch| (ch.base.name.clone(), ch.column.name.clone()))
        .collect();
    for i in &base.indexes {
        let Some(sql) = &i.sql else { continue };
        let Some(at) = draft
            .index_origins
            .iter()
            .position(|o| o.as_deref() == Some(i.name.as_str()))
        else {
            continue;
        };
        let to = &draft.indexes[at].name;
        let rename = (*to != i.name).then_some(to.as_str());
        statements.push(if rename.is_none() && column_renames.is_empty() {
            sql.clone()
        } else {
            rewritten_index(sql, database, rename, &column_renames)
        });
    }
    for i in a.added_indexes.iter().filter(|i| !i.primary) {
        statements.push(create_index(base, &i.name, &i.columns, i.unique));
    }
    statements.extend(extras.triggers.iter().map(|t| t.sql.clone()));
    statements.extend(extras.views.iter().map(|v| v.sql.clone()));
    statements.extend(extras.view_triggers.iter().map(|t| t.sql.clone()));
    // Checks, whatever the pragma: this table's keys, and the keys of every
    // table that references it, which a changed or dropped parent column breaks.
    let mut children: Vec<&str> = Vec::new();
    for r in &base.referenced_by {
        let child = r.table.name.as_str();
        if !same(child, name) && !children.iter().any(|c| same(c, child)) {
            children.push(child);
        }
    }
    for t in std::iter::once(real.as_str()).chain(children) {
        checks.push(statements.len());
        statements.push(format!(
            "PRAGMA {}.foreign_key_check({})",
            q(database),
            q(t)
        ));
    }
    // The setting as loaded; the runner refuses when it has changed since.
    let fk = extras.foreign_keys_on;
    statements.push(format!(
        "PRAGMA foreign_keys = {}",
        if fk { "ON" } else { "OFF" }
    ));

    let mode = match copy_only_reason(base, extras, &a) {
        Some(reason) => DesignMode::CopyOnly { reason },
        None => DesignMode::Transaction,
    };
    let mut warnings = a.warnings;
    warnings.push(DesignWarning::RebuildCopy {
        table: name.clone(),
    });
    Ok(DesignPlan {
        statements,
        warnings,
        mode,
        before: 1,
        after: 1,
        checks,
        foreign_keys: Some(fk),
        loaded: None,
    })
}

#[cfg(test)]
mod tests {
    use super::super::model::{
        IncomingRef, Increment, SavedObject, SqliteExtras, TableColumn, TableForeignKey, TableIndex,
    };
    use super::super::plan::fixtures::{alter, at, col, new_column, refusal};
    use super::super::plan::{ColumnDraft, DesignMode, IndexDraft, Position, column_draft};
    use super::super::warning::DesignWarning;
    use super::*;
    use crate::model::DialectKind;

    const LITE: DialectKind = DialectKind::Sqlite;

    const CREATE_SQL: &str = "CREATE TABLE orders (id INTEGER PRIMARY KEY, \
        email varchar(80) UNIQUE, status varchar(16) NOT NULL DEFAULT 'new', \
        total decimal(10,2), created_at timestamp DEFAULT CURRENT_TIMESTAMP)";
    const INDEX_SQL: &str = "CREATE INDEX orders_status_ix ON orders (status)";
    const TRIGGER_SQL: &str =
        "CREATE TRIGGER audit_orders AFTER INSERT ON orders BEGIN SELECT 1; END";
    const VIEW_SQL: &str =
        "CREATE VIEW open_orders AS SELECT id, status FROM orders WHERE status <> 'shipped'";

    fn index(name: &str, columns: &[&str], unique: bool, sql: Option<&str>) -> TableIndex {
        TableIndex {
            name: name.into(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            unique,
            primary: false,
            constraint: false,
            sql: sql.map(Into::into),
            method: None,
            predicate: None,
            expression: false,
            advanced: false,
        }
    }

    fn saved(name: &str, sql: &str) -> SavedObject {
        SavedObject {
            name: name.into(),
            sql: sql.into(),
        }
    }

    /// `orders` as the SQLite read model loads it: the rowid alias `id`, an
    /// autoindex for the `UNIQUE` on `email`, a saved index, a trigger and a view.
    fn orders() -> TableDesign {
        TableDesign {
            path: at(LITE, "orders"),
            columns: vec![
                TableColumn {
                    increment: Increment::AutoIncrement,
                    ..col("id", "INTEGER")
                },
                col("email", "varchar(80)"),
                TableColumn {
                    nullable: false,
                    default_sql: Some("'new'".into()),
                    ..col("status", "varchar(16)")
                },
                col("total", "decimal(10,2)"),
                TableColumn {
                    default_sql: Some("CURRENT_TIMESTAMP".into()),
                    ..col("created_at", "timestamp")
                },
            ],
            indexes: vec![
                TableIndex {
                    primary: true,
                    ..index("primary", &["id"], true, None)
                },
                index("sqlite_autoindex_orders_1", &["email"], true, None),
                index("orders_status_ix", &["status"], false, Some(INDEX_SQL)),
            ],
            foreign_keys: vec![],
            referenced_by: vec![],
            comment: None,
            unsupported: vec!["trigger audit_orders".into()],
            sqlite: Some(SqliteExtras {
                create_sql: CREATE_SQL.into(),
                triggers: vec![saved("audit_orders", TRIGGER_SQL)],
                views: vec![saved("open_orders", VIEW_SQL)],
                foreign_keys_on: true,
                view_triggers: vec![],
                children: vec![],
            }),
        }
    }

    fn change(base: &TableDesign, name: &str, edit: impl FnOnce(&mut ColumnDraft)) -> DesignEdit {
        let mut column = column_draft(base.columns.iter().find(|c| c.name == name).unwrap());
        edit(&mut column);
        DesignEdit::ChangeColumn {
            name: name.into(),
            column,
        }
    }

    fn retype_total(base: &TableDesign) -> DesignEdit {
        change(base, "total", |c| c.type_sql = "integer".into())
    }

    fn extras(base: &mut TableDesign) -> &mut SqliteExtras {
        base.sqlite.as_mut().unwrap()
    }

    fn copy_reason(plan: &DesignPlan) -> &str {
        match &plan.mode {
            DesignMode::CopyOnly { reason } => reason,
            other => panic!("expected CopyOnly, got {other:?}"),
        }
    }

    const NEW_TABLE: &str = "CREATE TABLE \"main\".\"contura_new_orders\" (\n  \
        \"id\" INTEGER PRIMARY KEY,\n  \
        \"email\" varchar(80),\n  \
        \"status\" varchar(16) NOT NULL DEFAULT 'new',\n  \
        \"total\" integer,\n  \
        \"created_at\" timestamp DEFAULT CURRENT_TIMESTAMP,\n  \
        UNIQUE (\"email\")\n)";
    const COPY: &str = "INSERT INTO \"main\".\"contura_new_orders\" \
        (\"id\", \"email\", \"status\", \"total\", \"created_at\") \
        SELECT \"id\", \"email\", \"status\", \"total\", \"created_at\" FROM \"main\".\"orders\"";
    const COUNT: &str = "SELECT count(*) FROM \"main\".\"orders\" \
        EXCEPT SELECT count(*) FROM \"main\".\"contura_new_orders\"";

    #[test]
    fn rename_is_in_place() {
        let base = orders();
        let plan = alter(
            LITE,
            &base,
            vec![change(&base, "total", |c| c.name = "amount".into())],
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            ["ALTER TABLE \"main\".\"orders\" RENAME COLUMN \"total\" TO \"amount\""]
        );
        assert_eq!(plan.mode, DesignMode::Transaction);
        assert_eq!((plan.before, plan.after), (0, 0));
        assert_eq!(
            plan.warnings,
            [DesignWarning::RenameColumn {
                from: "total".into(),
                to: "amount".into()
            }]
        );
    }

    #[test]
    fn in_place_adds_drops_and_renames_indexes() {
        let base = orders();
        let plan = alter(
            LITE,
            &base,
            vec![
                DesignEdit::RenameIndex {
                    name: "orders_status_ix".into(),
                    to: "orders_state_ix".into(),
                },
                DesignEdit::DropColumn {
                    name: "created_at".into(),
                },
                DesignEdit::AddColumn {
                    column: ColumnDraft {
                        nullable: false,
                        default_sql: Some("'x'".into()),
                        ..new_column("note", "text")
                    },
                    position: Position::Last,
                },
                DesignEdit::AddIndex {
                    index: IndexDraft {
                        name: "orders_note_ix".into(),
                        columns: vec!["note".into()],
                        unique: true,
                        primary: false,
                    },
                },
            ],
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            [
                "DROP INDEX \"main\".\"orders_status_ix\"",
                "CREATE INDEX \"main\".\"orders_state_ix\" ON orders (status)",
                "ALTER TABLE \"main\".\"orders\" DROP COLUMN \"created_at\"",
                "ALTER TABLE \"main\".\"orders\" ADD COLUMN \"note\" text NOT NULL DEFAULT 'x'",
                "CREATE UNIQUE INDEX \"main\".\"orders_note_ix\" ON \"orders\" (\"note\")",
            ]
        );
        assert_eq!(plan.mode, DesignMode::Transaction);
        assert_eq!((plan.before, plan.after), (0, 0));
    }

    #[test]
    fn what_sqlite_cannot_alter_rebuilds() {
        let base = orders();
        let rebuilds = |edits: Vec<DesignEdit>| {
            let plan = alter(LITE, &base, edits).unwrap();
            plan.warnings.contains(&DesignWarning::RebuildCopy {
                table: "orders".into(),
            })
        };
        let add =
            |column: ColumnDraft, position: Position| DesignEdit::AddColumn { column, position };
        // A default that is not a constant, a NOT NULL without one, a column not last.
        assert!(rebuilds(vec![add(
            ColumnDraft {
                default_sql: Some("CURRENT_TIMESTAMP".into()),
                ..new_column("seen", "timestamp")
            },
            Position::Last
        )]));
        assert!(rebuilds(vec![add(
            ColumnDraft {
                nullable: false,
                ..new_column("seen", "text")
            },
            Position::Last
        )]));
        assert!(rebuilds(vec![add(
            new_column("seen", "text"),
            Position::First
        )]));
        // The autoindex, the primary key, a type.
        assert!(rebuilds(vec![DesignEdit::DropIndex {
            name: "sqlite_autoindex_orders_1".into()
        }]));
        assert!(rebuilds(vec![
            DesignEdit::DropIndex {
                name: "primary".into()
            },
            change(&base, "id", |c| c.increment = false),
        ]));
        assert!(rebuilds(vec![retype_total(&base)]));
        // A column whose index goes in the same change drops in place, index first.
        let mut base = orders();
        extras(&mut base).views.clear();
        let plan = alter(
            LITE,
            &base,
            vec![
                DesignEdit::DropColumn {
                    name: "status".into(),
                },
                DesignEdit::DropIndex {
                    name: "orders_status_ix".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            plan.statements,
            [
                "DROP INDEX \"main\".\"orders_status_ix\"",
                "ALTER TABLE \"main\".\"orders\" DROP COLUMN \"status\"",
            ]
        );
        // Constant defaults stay in place.
        for d in ["NULL", "-1.5e3", "0x1F", "X'00ff'", "'a''b'", "TRUE"] {
            assert!(
                !rebuilds(vec![add(
                    ColumnDraft {
                        default_sql: Some(d.into()),
                        ..new_column("seen", "text")
                    },
                    Position::Last
                )]),
                "{d}"
            );
        }
        assert!(rebuilds(vec![add(
            ColumnDraft {
                default_sql: Some("(1 + 1)".into()),
                ..new_column("seen", "int")
            },
            Position::Last
        )]));
    }

    #[test]
    fn type_change_rebuilds_with_exact_steps() {
        let base = orders();
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        assert_eq!(
            plan.statements,
            [
                "PRAGMA foreign_keys = OFF",
                "DROP VIEW \"main\".\"open_orders\"",
                NEW_TABLE,
                COPY,
                COUNT,
                "DROP TABLE \"main\".\"orders\"",
                "ALTER TABLE \"main\".\"contura_new_orders\" RENAME TO \"orders\"",
                INDEX_SQL,
                TRIGGER_SQL,
                VIEW_SQL,
                "PRAGMA \"main\".foreign_key_check(\"orders\")",
                "PRAGMA foreign_keys = ON",
            ]
        );
        assert_eq!(plan.mode, DesignMode::Transaction);
        assert_eq!((plan.before, plan.after), (1, 1));
        assert_eq!(plan.checks, [4, 10]);
        assert_eq!(plan.foreign_keys, Some(true));
        assert_eq!(
            plan.warnings,
            [
                DesignWarning::NarrowType {
                    column: "total".into(),
                    from: "decimal(10,2)".into(),
                    to: "integer".into(),
                    note: None,
                },
                DesignWarning::RebuildCopy {
                    table: "orders".into()
                },
            ]
        );
    }

    #[test]
    fn keys_off_for_the_copy_and_restored_as_loaded() {
        let mut base = orders();
        extras(&mut base).foreign_keys_on = false;
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        let s = &plan.statements;
        assert_eq!(s[0], "PRAGMA foreign_keys = OFF");
        assert_eq!(s[s.len() - 1], "PRAGMA foreign_keys = OFF");
        assert_eq!(
            s[s.len() - 2],
            "PRAGMA \"main\".foreign_key_check(\"orders\")"
        );
        assert_eq!((plan.before, plan.after), (1, 1));
        assert_eq!(plan.foreign_keys, Some(false));
    }

    #[test]
    fn referencing_tables_are_checked_too() {
        let mut base = orders();
        let refs = [
            ("fk_0", "items"),
            ("fk_1", "items"),
            ("fk_0", "orders"),
            ("fk_0", "notes"),
        ];
        for (name, table) in refs {
            base.referenced_by.push(IncomingRef {
                name: name.into(),
                table: at(LITE, table),
                on_delete: None,
            });
        }
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        let checks: Vec<&str> = plan
            .checks
            .iter()
            .map(|&i| plan.statements[i].as_str())
            .collect();
        assert_eq!(
            checks,
            [
                COUNT,
                "PRAGMA \"main\".foreign_key_check(\"orders\")",
                "PRAGMA \"main\".foreign_key_check(\"items\")",
                "PRAGMA \"main\".foreign_key_check(\"notes\")",
            ]
        );
    }

    #[test]
    fn rebuild_reorders_columns() {
        let base = orders();
        let plan = alter(
            LITE,
            &base,
            vec![DesignEdit::MoveColumn {
                name: "total".into(),
                position: Position::After {
                    column: "email".into(),
                },
            }],
        )
        .unwrap();
        let create = &plan.statements[2];
        let at = |text: &str| create.find(text).unwrap();
        assert!(
            at("\"total\" decimal(10,2)") < at("\"status\" varchar(16)"),
            "{create}"
        );
        assert_eq!(
            plan.statements[3],
            "INSERT INTO \"main\".\"contura_new_orders\" \
             (\"id\", \"email\", \"total\", \"status\", \"created_at\") \
             SELECT \"id\", \"email\", \"total\", \"status\", \"created_at\" FROM \"main\".\"orders\""
        );
    }

    #[test]
    fn renamed_and_dropped_columns_map_by_loaded_name() {
        let mut base = orders();
        extras(&mut base).triggers.clear();
        extras(&mut base).views.clear();
        let plan = alter(
            LITE,
            &base,
            vec![
                change(&base, "status", |c| {
                    c.name = "state".into();
                    c.type_sql = "text".into();
                }),
                DesignEdit::DropColumn {
                    name: "total".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(plan.mode, DesignMode::Transaction);
        assert_eq!(
            plan.statements[2],
            "INSERT INTO \"main\".\"contura_new_orders\" \
             (\"id\", \"email\", \"state\", \"created_at\") \
             SELECT \"id\", \"email\", \"status\", \"created_at\" FROM \"main\".\"orders\""
        );
        // The saved index follows the rename.
        assert!(
            plan.statements
                .contains(&"CREATE INDEX orders_status_ix ON orders (\"state\")".to_string()),
            "{:?}",
            plan.statements
        );
    }

    #[test]
    fn autoindex_comes_back_in_create_table() {
        let base = orders();
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        assert!(plan.statements[2].contains("  UNIQUE (\"email\")\n"));
        assert!(
            plan.statements
                .iter()
                .all(|s| !s.contains("sqlite_autoindex") && !s.contains("CREATE UNIQUE INDEX")),
            "{:?}",
            plan.statements
        );
        // Dropping the autoindex leaves the UNIQUE out.
        let plan = alter(
            LITE,
            &base,
            vec![DesignEdit::DropIndex {
                name: "sqlite_autoindex_orders_1".into(),
            }],
        )
        .unwrap();
        assert!(
            !plan.statements[2].contains("UNIQUE"),
            "{}",
            plan.statements[2]
        );
    }

    #[test]
    fn trigger_naming_dropped_column_is_copy_only() {
        let mut base = orders();
        extras(&mut base).triggers = vec![saved(
            "audit_orders",
            "CREATE TRIGGER audit_orders AFTER UPDATE OF total ON orders BEGIN SELECT 1; END",
        )];
        let plan = alter(
            LITE,
            &base,
            vec![DesignEdit::DropColumn {
                name: "total".into(),
            }],
        )
        .unwrap();
        assert_eq!(copy_reason(&plan), "trigger audit_orders uses total");
        assert!(plan.statements.len() > 5, "the statements are still listed");

        // A view naming a renamed column, in a change that rebuilds.
        let base = orders();
        let plan = alter(
            LITE,
            &base,
            vec![change(&base, "status", |c| {
                c.name = "state".into();
                c.nullable = true;
            })],
        )
        .unwrap();
        assert_eq!(copy_reason(&plan), "view open_orders uses status");

        // The same rename alone runs in place: SQLite rewrites the view itself.
        let plan = alter(
            LITE,
            &base,
            vec![change(&base, "status", |c| c.name = "state".into())],
        )
        .unwrap();
        assert_eq!(plan.mode, DesignMode::Transaction);
    }

    #[test]
    fn collate_or_check_makes_copy_only() {
        let reason = |create_sql: &str, edit: fn(&mut TableDesign)| {
            let mut base = orders();
            extras(&mut base).create_sql = create_sql.into();
            edit(&mut base);
            let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
            match plan.mode {
                DesignMode::CopyOnly { reason } => reason,
                other => panic!("{create_sql}: {other:?}"),
            }
        };
        let with = |extra: &str| {
            CREATE_SQL.replace(
                " DEFAULT CURRENT_TIMESTAMP)",
                &format!(" DEFAULT CURRENT_TIMESTAMP{extra})"),
            )
        };
        assert_eq!(
            reason(&with(", CHECK (total >= 0)"), |_| {}),
            "it has a CHECK constraint"
        );
        assert_eq!(
            reason(&with(", UNIQUE (status COLLATE NOCASE)"), |_| {}),
            "it uses a collation inside a constraint or an expression"
        );
        assert_eq!(
            reason(&with(", g int AS (total * 2)"), |b| {
                b.columns.push(TableColumn {
                    generated: true,
                    ..col("g", "int")
                })
            }),
            "it has a generated column"
        );
        assert_eq!(
            reason(&with(", UNIQUE (status) ON CONFLICT IGNORE"), |_| {}),
            "it has an ON CONFLICT clause"
        );
        assert_eq!(
            reason(&format!("{CREATE_SQL} WITHOUT ROWID"), |b| {
                b.unsupported.push("without rowid".into())
            }),
            "it is WITHOUT ROWID"
        );
        assert_eq!(
            reason(&format!("{CREATE_SQL} STRICT"), |b| b
                .unsupported
                .push("strict".into())),
            "it is STRICT"
        );

        // A column collation is carried over (S4), so it is not copy-only.
        let mut base = orders();
        extras(&mut base).create_sql = CREATE_SQL.replace(
            "email varchar(80) UNIQUE",
            "email varchar(80) COLLATE NOCASE UNIQUE",
        );
        base.columns[1].collation = Some("NOCASE".into());
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        assert_eq!(plan.mode, DesignMode::Transaction);
        assert!(
            plan.statements[2].contains("\"email\" varchar(80) COLLATE \"NOCASE\",\n"),
            "{}",
            plan.statements[2]
        );
    }

    #[test]
    fn views_dropped_before_and_recreated_after() {
        let mut base = orders();
        let v2 = "CREATE VIEW open_count AS SELECT count(*) AS n FROM open_orders";
        extras(&mut base).views.push(saved("open_count", v2));
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        let s = &plan.statements;
        let pos = |text: &str| s.iter().position(|x| x == text).unwrap();
        // Dependents first on the way down, creation order on the way up.
        assert_eq!(s[1], "DROP VIEW \"main\".\"open_count\"");
        assert_eq!(s[2], "DROP VIEW \"main\".\"open_orders\"");
        assert!(s[3].starts_with("CREATE TABLE"));
        let renamed = pos("ALTER TABLE \"main\".\"contura_new_orders\" RENAME TO \"orders\"");
        assert!(renamed < pos(VIEW_SQL));
        assert!(pos(TRIGGER_SQL) < pos(VIEW_SQL));
        assert!(pos(VIEW_SQL) < pos(v2));
        assert!(pos(v2) < pos("PRAGMA \"main\".foreign_key_check(\"orders\")"));
    }

    #[test]
    fn autoincrement_keyword_only_when_it_was_there() {
        let base = orders();
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        assert!(
            plan.statements
                .iter()
                .all(|s| !s.contains("AUTOINCREMENT") && !s.contains("sqlite_sequence"))
        );

        let mut base = orders();
        base.columns[0].sqlite_autoincrement = true;
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        assert!(plan.statements[2].contains("\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,"));
        // The sequence carries over, so ids of deleted rows are not used again.
        assert_eq!(
            plan.statements[3],
            "INSERT INTO \"main\".\"sqlite_sequence\" (name, seq) \
             SELECT 'contura_new_orders', seq FROM \"main\".\"sqlite_sequence\" \
             WHERE name = 'orders' COLLATE NOCASE"
        );
        assert!(plan.statements[4].starts_with("INSERT INTO \"main\".\"contura_new_orders\" ("));
    }

    #[test]
    fn increment_needs_the_single_integer_key() {
        let base = orders();
        let edits = vec![change(&base, "id", |c| c.type_sql = "bigint".into())];
        assert_eq!(
            refusal(alter(LITE, &base, edits)),
            "SQLite can only auto-increment a single INTEGER primary key (orders.id)"
        );
    }

    #[test]
    fn keys_are_written_without_names() {
        let mut base = orders();
        base.foreign_keys.push(TableForeignKey {
            name: "fk_0".into(),
            columns: vec!["email".into()],
            target: at(LITE, "customers"),
            target_columns: vec!["email".into()],
            on_delete: Some("CASCADE".into()),
            on_update: None,
            advanced: false,
        });
        let plan = alter(LITE, &base, vec![retype_total(&base)]).unwrap();
        assert!(
            plan.statements[2].ends_with(
                "  UNIQUE (\"email\"),\n  \
                 FOREIGN KEY (\"email\") REFERENCES \"customers\" (\"email\") ON DELETE CASCADE\n)"
            ),
            "{}",
            plan.statements[2]
        );
        // Dropping a key rebuilds without it.
        let plan = alter(
            LITE,
            &base,
            vec![DesignEdit::DropForeignKey {
                name: "fk_0".into(),
            }],
        )
        .unwrap();
        assert!(!plan.statements[2].contains("FOREIGN KEY"));
    }

    #[test]
    fn advanced_autoindex_or_key_refuses_a_rebuild() {
        let mut base = orders();
        base.indexes[1].advanced = true;
        base.unsupported
            .push("index sqlite_autoindex_orders_1 (collation)".into());
        base.indexes[2].advanced = true;
        base.unsupported
            .push("index orders_status_ix (descending order)".into());
        base.foreign_keys.push(TableForeignKey {
            name: "fk_0".into(),
            columns: vec!["email".into()],
            target: at(LITE, "customers"),
            target_columns: vec!["email".into()],
            on_delete: None,
            on_update: None,
            advanced: true,
        });
        base.unsupported
            .push("foreign key fk_0 (deferrable)".into());
        assert_eq!(
            refusal(alter(LITE, &base, vec![retype_total(&base)])),
            "This change rebuilds orders, and Contura cannot recreate \
             index sqlite_autoindex_orders_1 (collation), foreign key fk_0 (deferrable). \
             Drop them in this change, or make the change in SQL."
        );
        // In place edits that leave them alone are fine, and so is renaming the index.
        let plan = alter(
            LITE,
            &base,
            vec![
                change(&base, "total", |c| c.name = "amount".into()),
                DesignEdit::RenameIndex {
                    name: "orders_status_ix".into(),
                    to: "orders_state_ix".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(plan.mode, DesignMode::Transaction);
        // Dropped in the same change, they are not recreated.
        let plan = alter(
            LITE,
            &base,
            vec![
                retype_total(&base),
                DesignEdit::DropIndex {
                    name: "sqlite_autoindex_orders_1".into(),
                },
                DesignEdit::DropForeignKey {
                    name: "fk_0".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(plan.mode, DesignMode::Transaction);
        // An advanced index with saved text comes back verbatim from it (S8).
        assert!(plan.statements.contains(&INDEX_SQL.to_string()));
    }

    #[test]
    fn sqlite_names_its_own_indexes() {
        let base = orders();
        for name in ["primary", "sqlite_autoindex_orders_1"] {
            assert_eq!(
                refusal(alter(
                    LITE,
                    &base,
                    vec![DesignEdit::RenameIndex {
                        name: name.into(),
                        to: "x".into(),
                    }],
                )),
                format!("SQLite names the index {name} itself, so it cannot be renamed.")
            );
        }
    }

    #[test]
    fn index_on_a_dropped_column_is_refused() {
        let base = orders();
        assert_eq!(
            refusal(alter(
                LITE,
                &base,
                vec![DesignEdit::DropColumn {
                    name: "email".into()
                }],
            )),
            "Index sqlite_autoindex_orders_1 uses email. Drop the index too, or keep the column."
        );
        assert_eq!(
            refusal(alter(
                LITE,
                &base,
                vec![DesignEdit::DropColumn {
                    name: "status".into()
                }],
            )),
            "Index orders_status_ix uses status. Drop the index too, or keep the column."
        );
    }

    #[test]
    fn rename_in_a_rebuild_with_incoming_keys_is_refused() {
        let mut base = orders();
        extras(&mut base).views.clear();
        base.referenced_by.push(IncomingRef {
            name: "fk_0".into(),
            table: at(LITE, "items"),
            on_delete: None,
        });
        assert_eq!(
            refusal(alter(
                LITE,
                &base,
                vec![change(&base, "total", |c| {
                    c.name = "amount".into();
                    c.type_sql = "integer".into();
                })],
            )),
            "Rename total in a change of its own: this change rebuilds orders, \
             and a rebuild would not carry the new name into the Foreign Keys of items."
        );
        // On its own the rename runs in place, and SQLite updates those keys.
        let plan = alter(
            LITE,
            &base,
            vec![change(&base, "total", |c| c.name = "amount".into())],
        )
        .unwrap();
        assert_eq!(plan.statements.len(), 1);
    }

    #[test]
    fn same_request_same_text() {
        let base = orders();
        let edits = vec![retype_total(&base)];
        assert_eq!(
            alter(LITE, &base, edits.clone()).unwrap(),
            alter(LITE, &base, edits).unwrap()
        );
    }

    #[test]
    fn no_change_is_an_empty_plan() {
        let base = orders();
        let plan = alter(LITE, &base, vec![change(&base, "total", |_| {})]).unwrap();
        assert!(plan.statements.is_empty());
        assert!(plan.warnings.is_empty());
    }
}

/// The plans run on a real SQLite database, with the steps the runner takes.
#[cfg(test)]
mod runs {
    use rusqlite::Connection;

    use super::super::plan::fixtures::new_column;
    use super::super::plan::{
        ColumnDraft, DesignMode, DesignRequest, DesignTarget, column_draft, plan_design,
    };
    use super::*;
    use crate::model::{DialectKind, ObjectPath};

    fn design(conn: &Connection, name: &str) -> TableDesign {
        let path = ObjectPath {
            database: "main".into(),
            schema: None,
            name: name.into(),
        };
        crate::sqlite::snapshot::table_design(conn, &path).unwrap()
    }

    fn plan_for(base: &TableDesign, edits: Vec<DesignEdit>) -> DesignPlan {
        plan_design(
            DialectKind::Sqlite,
            &DesignRequest {
                target: DesignTarget::Alter { base: base.clone() },
                edits,
            },
        )
        .unwrap()
    }

    /// Runs a statement; true when it returned a row (a failed check).
    fn step(conn: &Connection, sql: &str) -> std::result::Result<bool, String> {
        let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = st.query([]).map_err(|e| e.to_string())?;
        Ok(rows.next().map_err(|e| e.to_string())?.is_some())
    }

    /// As the runner: refuse when `foreign_keys` changed since loading, then
    /// `before`, then the middle in one transaction that a failure or a returned
    /// row rolls back, then `after` whatever happened.
    fn run(conn: &Connection, plan: &DesignPlan) -> std::result::Result<(), String> {
        assert!(!matches!(plan.mode, DesignMode::CopyOnly { .. }));
        if let Some(loaded) = plan.foreign_keys
            && (count(conn, "PRAGMA foreign_keys") == 1) != loaded
        {
            return Err("reload".into());
        }
        let n = plan.statements.len();
        for s in &plan.statements[..plan.before] {
            step(conn, s).unwrap();
        }
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        let mut failure = None;
        for s in &plan.statements[plan.before..n - plan.after] {
            match step(conn, s) {
                Ok(false) => {}
                Ok(true) => {
                    let at = plan.statements.iter().position(|x| x == s).unwrap();
                    assert!(plan.checks.contains(&at), "{s} is not marked as a check");
                    failure = Some(format!("{s} returned a row"));
                    break;
                }
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        let end = if failure.is_some() {
            "ROLLBACK"
        } else {
            "COMMIT"
        };
        conn.execute_batch(end).unwrap();
        for s in &plan.statements[n - plan.after..] {
            step(conn, s).unwrap();
        }
        failure.map_or(Ok(()), Err)
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn shop() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE customers (id INTEGER PRIMARY KEY, name text);
             CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT,
                 customer_id int REFERENCES customers (id) ON DELETE CASCADE,
                 email varchar(80) UNIQUE,
                 status varchar(16) NOT NULL DEFAULT 'new',
                 note text COLLATE NOCASE,
                 total decimal(10,2),
                 created text DEFAULT (datetime('now')),
                 n int DEFAULT (1 + 1));
             CREATE INDEX orders_status_ix ON orders (status) WHERE status <> 'shipped';
             CREATE INDEX orders_total_desc ON orders (total DESC);
             CREATE TABLE notes (email text REFERENCES orders (email));
             CREATE TABLE items (id INTEGER PRIMARY KEY,
                 order_id int REFERENCES orders (id) ON DELETE CASCADE);
             CREATE TABLE audit (what text);
             CREATE TRIGGER audit_orders AFTER INSERT ON orders
                 BEGIN INSERT INTO audit VALUES ('order ' || new.id); END;
             CREATE VIEW open_orders AS SELECT id, status FROM orders WHERE status <> 'shipped';
             CREATE VIEW open_count AS SELECT count(*) AS n FROM open_orders;
             CREATE TRIGGER open_orders_add INSTEAD OF INSERT ON open_orders
                 BEGIN INSERT INTO orders (status) VALUES (new.status); END;
             INSERT INTO customers VALUES (1, 'ann'), (2, 'bo');
             INSERT INTO orders (customer_id, email, status, note, total) VALUES
                 (1, 'a@x', 'new', 'Hi', 1.5), (2, 'b@x', 'shipped', 'yo', 2),
                 (1, 'c@x', 'new', NULL, 3);
             DELETE FROM orders WHERE id = 3;
             INSERT INTO items (order_id) VALUES (1), (2);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn rebuild_keeps_rows_autoindex_trigger_view_and_both_keys() {
        let conn = shop();
        let base = design(&conn, "orders");
        let total = base.columns.iter().find(|c| c.name == "total").unwrap();
        let mut retyped = column_draft(total);
        retyped.type_sql = "integer".into();
        let plan = plan_for(
            &base,
            vec![
                DesignEdit::ChangeColumn {
                    name: "total".into(),
                    column: retyped,
                },
                DesignEdit::MoveColumn {
                    name: "total".into(),
                    position: super::super::plan::Position::After {
                        column: "customer_id".into(),
                    },
                },
            ],
        );
        assert_eq!(plan.mode, DesignMode::Transaction, "{:?}", plan.statements);
        run(&conn, &plan).unwrap();

        let after = design(&conn, "orders");
        let names: Vec<&str> = after.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "id",
                "customer_id",
                "total",
                "email",
                "status",
                "note",
                "created",
                "n"
            ]
        );
        assert!(after.columns[0].sqlite_autoincrement);
        assert_eq!(after.columns[5].collation.as_deref(), Some("NOCASE"));
        let sorted = |d: &TableDesign| {
            let mut list = d.indexes.clone();
            list.sort_by(|a, b| a.name.cmp(&b.name));
            list
        };
        assert_eq!(sorted(&after), sorted(&base));
        assert_eq!(after.foreign_keys, base.foreign_keys);
        assert_eq!(after.referenced_by, base.referenced_by);
        assert_eq!(count(&conn, "SELECT count(*) FROM orders"), 2);
        assert_eq!(count(&conn, "PRAGMA foreign_keys"), 1);
        // The sequence kept its place: the deleted id 3 is not used again.
        conn.execute("INSERT INTO orders (email) VALUES ('d@x')", [])
            .unwrap();
        assert_eq!(count(&conn, "SELECT max(id) FROM orders"), 4);
        // The trigger fires, the views select, the unique and both keys hold.
        assert_eq!(count(&conn, "SELECT count(*) FROM audit"), 4);
        assert_eq!(count(&conn, "SELECT n FROM open_count"), 2);
        assert!(
            conn.execute("INSERT INTO orders (email) VALUES ('a@x')", [])
                .is_err()
        );
        assert!(
            conn.execute("INSERT INTO items (order_id) VALUES (99)", [])
                .is_err()
        );
        assert!(
            conn.execute("INSERT INTO orders (customer_id) VALUES (99)", [])
                .is_err()
        );
        assert_eq!(
            count(&conn, "SELECT count(*) FROM orders WHERE note = 'hi'"),
            1
        );
        // Keys were off for the copy: no cascade emptied the children.
        assert_eq!(count(&conn, "SELECT count(*) FROM items"), 2);
        // Expression defaults still work (S8).
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM orders WHERE email = 'd@x' AND created IS NOT NULL AND n = 2"
            ),
            1
        );
        // The DESC index came back verbatim, advanced as before.
        let desc = after
            .indexes
            .iter()
            .find(|i| i.name == "orders_total_desc")
            .unwrap();
        assert!(desc.advanced);
        assert_eq!(
            desc.sql.as_deref(),
            Some("CREATE INDEX orders_total_desc ON orders (total DESC)")
        );
        // The view's INSTEAD OF trigger came back with the view.
        conn.execute("INSERT INTO open_orders (status) VALUES ('new')", [])
            .unwrap();
        assert_eq!(count(&conn, "SELECT count(*) FROM orders"), 4);
    }

    #[test]
    fn in_place_edits_run() {
        let conn = shop();
        let base = design(&conn, "orders");
        let total = base.columns.iter().find(|c| c.name == "total").unwrap();
        let mut renamed = column_draft(total);
        renamed.name = "amount".into();
        let plan = plan_for(
            &base,
            vec![
                DesignEdit::ChangeColumn {
                    name: "total".into(),
                    column: renamed,
                },
                DesignEdit::RenameIndex {
                    name: "orders_status_ix".into(),
                    to: "orders_open_ix".into(),
                },
                DesignEdit::AddColumn {
                    column: ColumnDraft {
                        nullable: false,
                        default_sql: Some("0".into()),
                        ..new_column("seen", "int")
                    },
                    position: super::super::plan::Position::Last,
                },
            ],
        );
        assert_eq!((plan.before, plan.after), (0, 0));
        run(&conn, &plan).unwrap();
        let after = design(&conn, "orders");
        let open = after
            .indexes
            .iter()
            .find(|i| i.name == "orders_open_ix")
            .unwrap();
        assert_eq!(open.predicate.as_deref(), Some("status <> 'shipped'"));
        assert!(after.columns.iter().any(|c| c.name == "amount"));
        assert_eq!(count(&conn, "SELECT sum(seen) FROM orders"), 0);
    }

    #[test]
    fn foreign_key_check_failure_rolls_back() {
        let conn = shop();
        // An orphan written while the keys were off.
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF; INSERT INTO orders (customer_id) VALUES (42); \
             PRAGMA foreign_keys = ON;",
        )
        .unwrap();
        let base = design(&conn, "orders");
        let plan = plan_for(
            &base,
            vec![DesignEdit::DropIndex {
                name: "sqlite_autoindex_orders_1".into(),
            }],
        );
        let err = run(&conn, &plan).unwrap_err();
        assert!(
            err.starts_with("PRAGMA \"main\".foreign_key_check"),
            "{err}"
        );
        assert_eq!(design(&conn, "orders").indexes, base.indexes);
        assert_eq!(count(&conn, "SELECT count(*) FROM orders"), 3);
        assert_eq!(count(&conn, "PRAGMA foreign_keys"), 1);
    }

    #[test]
    fn dropping_a_referenced_column_fails_the_check_and_rolls_back() {
        let conn = shop();
        let base = design(&conn, "orders");
        let plan = plan_for(
            &base,
            vec![
                DesignEdit::DropIndex {
                    name: "sqlite_autoindex_orders_1".into(),
                },
                DesignEdit::DropColumn {
                    name: "email".into(),
                },
            ],
        );
        let err = run(&conn, &plan).unwrap_err();
        assert_eq!(
            err,
            "foreign key mismatch - \"notes\" referencing \"orders\""
        );
        assert_eq!(design(&conn, "orders"), base);
        assert_eq!(count(&conn, "PRAGMA foreign_keys"), 1);
    }

    #[test]
    fn keys_loaded_off_stay_off_and_a_changed_setting_is_refused() {
        let conn = shop();
        conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        let base = design(&conn, "orders");
        let plan = plan_for(
            &base,
            vec![DesignEdit::DropIndex {
                name: "orders_status_ix".into(),
            }],
        );
        assert_eq!(plan.foreign_keys, None, "in place, no pragma");
        let mut retyped = column_draft(base.columns.iter().find(|c| c.name == "total").unwrap());
        retyped.type_sql = "integer".into();
        let plan = plan_for(
            &base,
            vec![DesignEdit::ChangeColumn {
                name: "total".into(),
                column: retyped,
            }],
        );
        // Turned on after loading: the runner refuses before any statement.
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        assert_eq!(run(&conn, &plan).unwrap_err(), "reload");
        conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        run(&conn, &plan).unwrap();
        assert_eq!(count(&conn, "PRAGMA foreign_keys"), 0);
        assert_eq!(count(&conn, "SELECT count(*) FROM items"), 2);
    }

    #[test]
    fn rowid_is_kept_without_an_alias() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE plain (a text, b int);
             INSERT INTO plain VALUES ('x', 1), ('y', 2), ('z', 3);
             DELETE FROM plain WHERE a = 'x';",
        )
        .unwrap();
        let base = design(&conn, "plain");
        let mut retyped = column_draft(&base.columns[1]);
        retyped.type_sql = "text".into();
        let plan = plan_for(
            &base,
            vec![DesignEdit::ChangeColumn {
                name: "b".into(),
                column: retyped,
            }],
        );
        assert!(plan.statements.iter().any(|s| s
            == "INSERT INTO \"main\".\"contura_new_plain\" (rowid, \"a\", \"b\") \
                SELECT rowid, \"a\", \"b\" FROM \"main\".\"plain\""));
        run(&conn, &plan).unwrap();
        assert_eq!(count(&conn, "SELECT min(rowid) FROM plain"), 2);
    }

    #[test]
    fn identifier_style_defaults_stay_strings() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE flags (id INTEGER PRIMARY KEY,              a text DEFAULT \"abc\", b text DEFAULT [abc], c text DEFAULT `abc`,              d text DEFAULT active, n int);
             INSERT INTO flags (n) VALUES (1);",
        )
        .unwrap();
        let base = design(&conn, "flags");
        let mut retyped = column_draft(&base.columns[5]);
        retyped.type_sql = "text".into();
        let plan = plan_for(
            &base,
            vec![DesignEdit::ChangeColumn {
                name: "n".into(),
                column: retyped,
            }],
        );
        let create = plan
            .statements
            .iter()
            .find(|s| s.starts_with("CREATE TABLE"))
            .unwrap();
        for line in [
            "\"a\" TEXT DEFAULT 'abc'",
            "\"b\" TEXT DEFAULT 'abc'",
            "\"c\" TEXT DEFAULT 'abc'",
            "\"d\" TEXT DEFAULT 'active'",
        ] {
            assert!(create.contains(line), "{line} in {create}");
        }
        run(&conn, &plan).unwrap();
        conn.execute("INSERT INTO flags (n) VALUES ('2')", [])
            .unwrap();
        let row: (String, String, String, String) = conn
            .query_row("SELECT a, b, c, d FROM flags WHERE n = '2'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!(
            row,
            ("abc".into(), "abc".into(), "abc".into(), "active".into())
        );
    }

    #[test]
    fn row_count_check_returns_a_row_only_when_rows_differ() {
        let conn = shop();
        let base = design(&conn, "orders");
        let plan = plan_for(
            &base,
            vec![DesignEdit::DropIndex {
                name: "sqlite_autoindex_orders_1".into(),
            }],
        );
        let check = plan
            .statements
            .iter()
            .find(|s| s.starts_with("SELECT count(*)"))
            .unwrap();
        conn.execute_batch("CREATE TABLE contura_new_orders AS SELECT * FROM orders")
            .unwrap();
        assert!(!step(&conn, check).unwrap());
        conn.execute_batch("DELETE FROM contura_new_orders WHERE id = 1")
            .unwrap();
        assert!(step(&conn, check).unwrap());
    }

    /// A trigger on another table that names this one is not in the read model:
    /// the rename step fails, and everything rolls back.
    #[test]
    fn trigger_on_another_table_fails_the_rename_and_rolls_back() {
        let conn = shop();
        conn.execute_batch(
            "CREATE TRIGGER items_touch AFTER INSERT ON items \
             BEGIN UPDATE orders SET status = status WHERE id = new.order_id; END;",
        )
        .unwrap();
        let base = design(&conn, "orders");
        let plan = plan_for(
            &base,
            vec![DesignEdit::DropIndex {
                name: "sqlite_autoindex_orders_1".into(),
            }],
        );
        let err = run(&conn, &plan).unwrap_err();
        // What the person sees as the failed statement's message.
        assert_eq!(
            err,
            "error in trigger items_touch: no such table: main.orders"
        );
        assert_eq!(design(&conn, "orders"), base);
        assert_eq!(count(&conn, "SELECT count(*) FROM orders"), 2);
        assert_eq!(count(&conn, "SELECT count(*) FROM items"), 2);
        assert_eq!(count(&conn, "PRAGMA foreign_keys"), 1);
    }
}
