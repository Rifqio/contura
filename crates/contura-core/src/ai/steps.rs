//! The Recent steps item: what the user did since their last question in this place, sent
//! as typed steps by the UI and rendered here as labels. Each step is gated by its own
//! Connection's AI access, or the Ask's when that is lower. No label holds SQL or row
//! data: verbs are fixed words, names are object names, counts are counts.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::ai::AiAccess;
use crate::ai::memory::{IDLE_MS, OtherStep};
use crate::ai::rails::input::{cap_chars, rank};
use crate::ai::request::TableRef;
use crate::ai::scene::{count, mask_quotes, more, name};
use crate::common::grouped;
use crate::model::ConnectionId;

/// The most steps one Ask sends; the oldest go first.
pub const STEPS_MAX: usize = 10;
/// The rendered item's cap in bytes; the oldest whole lines go first.
pub const STEPS_CAP: usize = 1024;
/// One label's cap in bytes, its age not counted: names go first, then the label is cut.
pub const STEP_LABEL_CAP: usize = 160;
/// The most characters of any one name, as in This tab.
const NAME_CHARS: usize = 128;
/// The most `(+<n> more)` shows; past it, `(+999+ more)`, so a hostile count cannot take
/// the label's room.
const MORE_SHOWN: usize = 999;
/// The names a step shows; the rest are counted in `(+<n> more)`.
const STEP_NAMES: usize = 6;
/// The newest steps the Core reads; the UI sends at most twice `STEPS_MAX`, and any older
/// one counts as left out, so a long request costs no Connection reads. Each read step
/// names at most two Connections (its own and a source's), so an Ask reads at most 40.
const STEPS_READ: usize = 2 * STEPS_MAX;

/// What the user did. A closed enum: an unknown verb fails the request.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StepVerb {
    OpenTab,
    ShowTab,
    RunQuery,
    RunVisual,
    VqTable,
    VqTableOff,
    VqTick,
    VqUntick,
    VqJoin,
    VqFilter,
    VqSort,
    GridSort,
    GridFilter,
    EditsSaved,
    DesignApplied,
    Compared,
    SyncApplied,
    TransferRan,
    ImportFile,
    ImportRan,
}

/// One step as the UI recorded it. What `names` holds depends on the verb:
/// - `openTab`, `showTab`: the object the tab shows, if any.
/// - `vqTable`, `vqTableOff`, `vqJoin`: tables; `vqTick`, `vqUntick`, `vqFilter`, `vqSort`:
///   `table.column` names.
/// - `gridSort`, `gridFilter`: the table, then its columns.
/// - `editsSaved`, `designApplied`, `importRan`: the table.
/// - `compared`, `transferRan`: the source database or Schema Model file base name, then
///   (transfer) the tables copied. `database` is the target's; `source_connection_id` is
///   the source's Connection when it is not the step's, and the source name goes only at
///   the lower of the two accesses.
/// - `importFile`: the file's base name, then the table.
///
/// `count` is rows (runs, transfer, import), differences (compare), changes (sync) or
/// Pending Edits. `tab` is a tab kind id (`newTable` for a New table); others are `a tab`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StepIn {
    pub at: i64,
    pub verb: StepVerb,
    pub tab: String,
    pub title: Option<String>,
    pub connection_id: Option<ConnectionId>,
    pub database: Option<String>,
    pub schema: Option<String>,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub more: u32,
    pub count: Option<u64>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub failed: bool,
    #[serde(default)]
    pub descending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_connection_id: Option<ConnectionId>,
}

/// The Recent steps item as it goes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StepsOut {
    /// One label per line, oldest first, each after its age: `(4 min ago) ran the query`.
    pub text: String,
    /// One per line of `text`: whether the step is on the Ask's Connection or on none, so
    /// a turn keeps it in `AskedIn::steps`; see `kept_for_turn`.
    pub turn: Vec<bool>,
    /// One per line of `text`: for a step on another Connection, that Connection and the
    /// level its label used, so a turn keeps it in `AskedIn::other_steps` and its replay is
    /// gated by that Connection (`others_for_turn`). `None` for the Ask's own steps, steps
    /// with no Connection, and a step that names a source on another Connection, a third
    /// one or the Ask's (its label holds that Connection's names, which neither the replay
    /// gate nor a purge of that Connection would cover).
    pub other: Vec<Option<(ConnectionId, u8)>>,
    /// The highest level any part of a step `turn` keeps needed: 0 when only steps with no
    /// Connection went. Steps on other Connections do not count: each is gated by its own
    /// Connection when replayed.
    pub used: u8,
    /// Dropped whole: on a Connection at Never, missing or deleted.
    pub held: u32,
    /// Dropped whole: on the Ask's Connection, while the Ask is at Never (lowered by another
    /// Connection the tab spans).
    pub held_by_ask: u32,
    /// Dropped by the 10-step or 1 KB cap.
    pub left_out: u32,
    /// Tables in the steps that went on the Ask's Connection and database, with the step's
    /// schema: hints for the AI Context, as open tabs are.
    pub tables: Vec<TableRef>,
}

impl StepsOut {
    /// The lines that went.
    pub fn lines(&self) -> usize {
        self.text.lines().count()
    }

    /// The labels, without their age, a turn may keep, read from `sent`: the item's text
    /// after the rails and the 200 KB cut. Those only drop the oldest whole lines, and the
    /// input rail cleans the item line by line, so the sent lines are the last lines built,
    /// one step each; they are paired with `turn` from the newest end. A text that does not
    /// have that shape (more lines than were built, or a line that is not a step) keeps
    /// nothing, so no label that did not go, or that is not the Ask's, is ever kept.
    pub fn kept_for_turn(&self, sent: &str) -> Vec<String> {
        self.sent_lines(sent)
            .into_iter()
            .filter(|(i, _)| self.turn[*i])
            .map(|(_, label)| label.to_string())
            .collect()
    }

    /// As `kept_for_turn`, for the steps on other Connections a turn keeps: each with its
    /// Connection and the level its label used.
    pub fn others_for_turn(&self, sent: &str) -> Vec<OtherStep> {
        self.sent_lines(sent)
            .into_iter()
            .filter_map(|(i, label)| {
                let (connection_id, used) = self.other.get(i).copied().flatten()?;
                Some(OtherStep {
                    connection_id,
                    text: label.to_string(),
                    level: level_of_rank(used),
                })
            })
            .collect()
    }

    /// The lines of `sent`, oldest first, without their age, each with the index of the
    /// built line it is; none when `sent` does not have the shape `kept_for_turn` reads.
    fn sent_lines<'s>(&self, sent: &'s str) -> Vec<(usize, &'s str)> {
        let lines = sent.lines().count();
        if lines > self.turn.len() || sent.lines().any(|l| !l.starts_with('(')) {
            return Vec::new();
        }
        let first = self.turn.len() - lines;
        sent.lines()
            .enumerate()
            .map(|(i, line)| (first + i, line.split_once(") ").map_or(line, |(_, l)| l)))
            .collect()
    }
}

/// The access a label's used level needs: Schema only at least, for a step on a Connection.
fn level_of_rank(used: u8) -> AiAccess {
    match used {
        0 | 1 => AiAccess::Schema,
        2 => AiAccess::SchemaQuery,
        _ => AiAccess::SchemaQueryRows,
    }
}

/// The steps' Connections the Core reads, each once: those of the newest steps that are
/// not idle.
pub fn step_connections(steps: &[StepIn], now_ms: i64) -> Vec<ConnectionId> {
    let mut out: Vec<ConnectionId> = Vec::new();
    for s in newest(steps, now_ms).0 {
        for id in [s.connection_id, s.source_connection_id]
            .into_iter()
            .flatten()
        {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

/// The newest `STEPS_READ` steps that are not idle, newest first, and how many older ones
/// were not read. A step over 30 minutes old is dropped silently, as the Topic idle rule.
fn newest(steps: &[StepIn], now_ms: i64) -> (Vec<&StepIn>, u32) {
    let mut live: Vec<&StepIn> = steps
        .iter()
        .filter(|s| elapsed(now_ms, s.at) <= IDLE_MS)
        .collect();
    // Stable: steps at the same time keep their order, the later one newer.
    live.sort_by_key(|s| s.at);
    live.reverse();
    let unread = live.len().saturating_sub(STEPS_READ);
    live.truncate(STEPS_READ);
    (live, u32::try_from(unread).unwrap_or(u32::MAX))
}

/// How long ago `at` was; a time after now (a clock that moved) counts as now.
fn elapsed(now_ms: i64, at: i64) -> i64 {
    now_ms.saturating_sub(at.min(now_ms))
}

/// `(just now)` under a minute, else `(<n> min ago)` in whole minutes.
fn age(now_ms: i64, at: i64) -> String {
    let minutes = elapsed(now_ms, at) / 60_000;
    if minutes == 0 {
        "(just now)".into()
    } else {
        format!("({} min ago)", grouped(minutes as u64))
    }
}

/// The words for a tab kind id; unknown ids are `a tab`.
fn tab_words(tab: &str) -> &'static str {
    match tab {
        "query" => "Query tab",
        "object" => "Table data",
        "visual" => "Visual Query",
        "design" => "Table Designer",
        "newTable" => "New table",
        "schema" => "Schema Builder",
        "compare" => "Schema Compare",
        "transfer" => "Data Transfer",
        "import" => "Import",
        "lineage" => "Lineage",
        "savedQueries" => "Saved Queries",
        "home" => "Home",
        "settings" => "Settings",
        _ => "a tab",
    }
}

/// Where the step happened, against the Ask.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Place {
    /// No Connection: only the verb and tab words go.
    None,
    /// The Ask's Connection; `other_database` when the step's database is not the Ask's.
    Same { other_database: bool },
    /// Another Connection: `on another Connection` stands where the database would.
    Other,
}

/// When a label says ` in <database>`.
#[derive(Clone, Copy)]
enum Loc {
    /// Always: opening a tab, creating a table.
    Always,
    /// Only when the step's database is not the Ask's.
    Elsewhere,
    /// Never: the verb names the database itself (compare, sync, transfer, import).
    Named,
}

/// One label as it is built, gated at `level`.
struct Label<'a> {
    step: &'a StepIn,
    level: u8,
    /// The level of a Compare or Transfer source: the lower of the two Connections'.
    source_level: u8,
    used: u8,
    place: Place,
    clean: &'a dyn Fn(&str) -> String,
    /// The most characters of a name in this label; fewer than 128 when it is over the cap.
    name_chars: usize,
}

impl Label<'_> {
    fn reaches(&mut self, need: u8) -> bool {
        let ok = self.place != Place::None && self.level >= need;
        if ok {
            self.used = self.used.max(need);
        }
        ok
    }

    /// A name, cleaned, its quoted values masked as This tab masks a default, then cut.
    fn name(&self, s: &str) -> String {
        let one = name(&mask_quotes(&(self.clean)(s), true, true));
        if self.name_chars >= NAME_CHARS || one.chars().count() <= self.name_chars {
            return one;
        }
        let mut out: String = one.chars().take(self.name_chars).collect();
        out.push('…');
        out
    }

    /// The names from `from`, at most `take`, then `(+<n> more)` with the rest and `more`;
    /// `None` when there are none or the level does not reach names.
    fn names(&mut self, from: usize, take: usize) -> Option<String> {
        let all = self.step.names.get(from..).unwrap_or(&[]);
        if (all.is_empty() && self.step.more == 0) || !self.reaches(1) {
            return None;
        }
        let shown = take.min(all.len());
        let mut out = all[..shown]
            .iter()
            .map(|n| self.name(n))
            .collect::<Vec<_>>()
            .join(", ");
        let rest = (all.len() - shown) + self.step.more as usize;
        if rest > 0 {
            if !out.is_empty() {
                out.push(' ');
            }
            if rest > MORE_SHOWN {
                out.push_str(&format!("(+{MORE_SHOWN}+ more)"));
            } else {
                out.push_str(&more(rest));
            }
        }
        Some(out)
    }

    /// The first name, alone.
    fn first(&mut self) -> Option<String> {
        let first = self.step.names.first()?;
        self.reaches(1).then(|| self.name(first))
    }

    /// The source of a Compare or Transfer, at the lower of the two Connections' access.
    fn source(&mut self) -> Option<String> {
        if self.source_level == 0 {
            return None;
        }
        self.first()
    }

    /// A name the user typed, quoted: Schema and query text.
    fn title(&mut self) -> Option<String> {
        let t = self.step.title.as_deref().filter(|t| !t.is_empty())?;
        self.reaches(2).then(|| format!("\"{}\"", self.name(t)))
    }

    /// The step's database: Schema only.
    fn database(&mut self) -> Option<String> {
        let d = self.step.database.as_deref().filter(|d| !d.is_empty())?;
        self.reaches(1).then(|| self.name(d))
    }

    /// `schema.table`, else `database.table`.
    fn qualified(&mut self, table: Option<String>) -> Option<String> {
        let table = table?;
        let scope = self
            .step
            .schema
            .as_deref()
            .or(self.step.database.as_deref())
            .filter(|s| !s.is_empty());
        Some(match scope {
            Some(s) => format!("{}.{table}", self.name(s)),
            None => table,
        })
    }

    /// The count in words: Schema and query text; `12+ rows` when the page was full.
    fn count(&mut self, one: &str, many: &str) -> Option<String> {
        let n = self.step.count?;
        if !self.reaches(2) {
            return None;
        }
        Some(if self.step.has_more {
            format!("{}+ {many}", grouped(n))
        } else {
            count(n, one, many)
        })
    }

    /// ` on another Connection` for a step on one; else ` in <database>` as `at` says.
    fn location(&mut self, at: Loc) -> String {
        let shown = match (self.place, at) {
            (Place::Other, _) => return " on another Connection".into(),
            (Place::None, _) | (_, Loc::Named) => false,
            (_, Loc::Always) => true,
            (Place::Same { other_database }, Loc::Elsewhere) => other_database,
        };
        if !shown {
            return String::new();
        }
        self.database()
            .map(|d| format!(" in {d}"))
            .unwrap_or_default()
    }
}

/// `head`, then ` <part>` for each part there is.
fn join(head: &str, parts: &[Option<String>]) -> String {
    let mut out = head.to_string();
    for p in parts.iter().flatten() {
        out.push(' ');
        out.push_str(p);
    }
    out
}

/// The names after the first one a label shows: at least one, but none on the last try.
fn rest_take(take: usize) -> usize {
    if take == 0 { 0 } else { (take - 1).max(1) }
}

/// How one step is rendered: its levels and where it happened.
#[derive(Clone, Copy)]
struct Gate {
    level: u8,
    source_level: u8,
    place: Place,
}

/// The label of `step` with at most `take` names of at most `name_chars` characters, and
/// the highest level it used.
fn label_with(
    step: &StepIn,
    gate: Gate,
    clean: &dyn Fn(&str) -> String,
    take: usize,
    name_chars: usize,
) -> (String, u8) {
    // The verb and tab words of a step on a Connection need Schema only.
    let mut l = Label {
        step,
        level: gate.level,
        source_level: gate.source_level,
        used: u8::from(gate.place != Place::None),
        place: gate.place,
        clean,
        name_chars,
    };
    let desc = || if step.descending { " desc" } else { "" };
    // The database a verb names itself, whatever the Ask's.
    let database = |l: &mut Label| l.database().unwrap_or_else(|| "a database".into());
    let (main, counted) = match step.verb {
        StepVerb::OpenTab | StepVerb::ShowTab => {
            let verb = if step.verb == StepVerb::OpenTab {
                "opened"
            } else {
                "went to"
            };
            let head = format!("{verb} {}", tab_words(&step.tab));
            let parts = [l.title(), l.names(0, take)];
            (join(&head, &parts) + &l.location(Loc::Always), None)
        }
        StepVerb::RunQuery => {
            let title = l.title().map(|t| format!(" in {t}")).unwrap_or_default();
            let loc = l.location(Loc::Elsewhere);
            (format!("ran the query{title}{loc}"), l.count("row", "rows"))
        }
        StepVerb::RunVisual => {
            let main = join("ran the Visual Query", &[l.title()]) + &l.location(Loc::Elsewhere);
            (main, l.count("row", "rows"))
        }
        StepVerb::VqTable => {
            let what = l.names(0, take).unwrap_or_else(|| "a table".into());
            (
                format!("added {what} to the Visual Query") + &l.location(Loc::Elsewhere),
                None,
            )
        }
        StepVerb::VqTableOff => {
            let what = l.names(0, take).unwrap_or_else(|| "a table".into());
            let loc = l.location(Loc::Elsewhere);
            (format!("removed {what} from the Visual Query{loc}"), None)
        }
        StepVerb::VqTick | StepVerb::VqUntick => {
            let verb = if step.verb == StepVerb::VqTick {
                "ticked"
            } else {
                "unticked"
            };
            let what = l.names(0, take).unwrap_or_else(|| "columns".into());
            (format!("{verb} {what}") + &l.location(Loc::Elsewhere), None)
        }
        StepVerb::VqJoin => {
            let main = match (l.first(), l.names(1, rest_take(take))) {
                (Some(a), Some(b)) => format!("joined {a} to {b}"),
                (Some(a), None) => format!("added a join on {a}"),
                _ => "added a join".into(),
            };
            (main + &l.location(Loc::Elsewhere), None)
        }
        StepVerb::VqFilter => {
            let main = join("added a filter on", &[l.names(0, take)]);
            let main = if main.ends_with(" on") {
                "added a filter".into()
            } else {
                main
            };
            (main + &l.location(Loc::Elsewhere), None)
        }
        StepVerb::VqSort => {
            let main = match l.names(0, take) {
                Some(by) => format!("sorted the Visual Query by {by}{}", desc()),
                None => "sorted the Visual Query".into(),
            };
            (main + &l.location(Loc::Elsewhere), None)
        }
        StepVerb::GridSort | StepVerb::GridFilter => {
            let table = l.first().unwrap_or_else(|| "a table".into());
            let columns = l.names(1, rest_take(take));
            let main = match (step.verb, columns) {
                (StepVerb::GridSort, Some(c)) => format!("sorted {table} by {c}{}", desc()),
                (StepVerb::GridSort, None) => format!("sorted {table}"),
                (_, Some(c)) => format!("filtered {table} on {c}"),
                (_, None) => format!("filtered {table}"),
            };
            (main + &l.location(Loc::Elsewhere), None)
        }
        StepVerb::EditsSaved => {
            let edits = l
                .count("Pending Edit", "Pending Edits")
                .unwrap_or_else(|| "Pending Edits".into());
            let table = l.first().unwrap_or_else(|| "a table".into());
            (
                format!("saved {edits} to {table}") + &l.location(Loc::Elsewhere),
                None,
            )
        }
        StepVerb::DesignApplied => {
            let create = step.tab == "newTable";
            let verb = if create { "created" } else { "changed" };
            let table = l.first().unwrap_or_else(|| "a table".into());
            (
                format!("{verb} table {table}")
                    + &l.location(if create { Loc::Always } else { Loc::Elsewhere }),
                None,
            )
        }
        StepVerb::Compared => {
            let source = l.source().unwrap_or_else(|| "a source".into());
            let target = database(&mut l);
            let loc = l.location(Loc::Named);
            (
                format!("compared {source} to {target}{loc}"),
                l.count("difference", "differences"),
            )
        }
        StepVerb::SyncApplied => {
            let changes = l
                .count("change", "changes")
                .unwrap_or_else(|| "changes".into());
            let target = database(&mut l);
            (
                format!("applied {changes} to {target}") + &l.location(Loc::Named),
                None,
            )
        }
        StepVerb::TransferRan => {
            let tables = step.names.len().saturating_sub(1) as u64 + u64::from(step.more);
            let tables = if tables > 0 && l.reaches(2) {
                count(tables, "table", "tables")
            } else {
                "tables".into()
            };
            let source = l.source().unwrap_or_else(|| "a database".into());
            let target = database(&mut l);
            let loc = l.location(Loc::Named);
            (
                format!("copied {tables} from {source} to {target}{loc}"),
                l.count("row", "rows"),
            )
        }
        StepVerb::ImportFile => {
            let file = l.first().unwrap_or_else(|| "a file".into());
            let table = step
                .names
                .get(1)
                .filter(|_| l.reaches(1))
                .map(|t| l.name(t));
            let into = l.qualified(table).unwrap_or_else(|| "a table".into());
            (
                format!("chose {file} to import into {into}") + &l.location(Loc::Named),
                None,
            )
        }
        StepVerb::ImportRan => {
            let rows = l.count("row", "rows").unwrap_or_else(|| "rows".into());
            let table = l.first();
            let into = l.qualified(table).unwrap_or_else(|| "a table".into());
            (
                format!("imported {rows} into {into}") + &l.location(Loc::Named),
                None,
            )
        }
    };
    let mut out = main;
    if step.failed && l.reaches(1) {
        out.push_str(", failed");
    } else if let Some(c) = counted {
        out.push_str(", ");
        out.push_str(&c);
    }
    (out, l.used)
}

/// The label of `step` within `STEP_LABEL_CAP`: fewer names first, then shorter names, so
/// the Core's own words (` on another Connection`, `, failed`, the count) stay whole; the
/// last try lists no names, only `(+<n> more)`. A cut at a character boundary is the last
/// guard; with 8-character names and `more` capped at 999+ no label reaches it.
fn label(step: &StepIn, gate: Gate, clean: &dyn Fn(&str) -> String) -> (String, u8) {
    let mut last = None;
    let tries = (1..=STEP_NAMES)
        .rev()
        .map(|take| (take, NAME_CHARS))
        .chain([64, 32, 16, 8].map(|chars| (1, chars)))
        .chain([(0, 8)]);
    for (take, chars) in tries {
        let (text, used) = label_with(step, gate, clean, take, chars);
        if text.len() <= STEP_LABEL_CAP {
            return (text, used);
        }
        last = Some((text, used));
    }
    let (text, used) = last.expect("at least one try");
    let mut cut = cap_chars(&text, STEP_LABEL_CAP - '…'.len_utf8()).to_string();
    cut.push('…');
    (cut, used)
}

/// The table names a step's verb gives, for the AI Context hints.
fn step_tables(step: &StepIn) -> Vec<&str> {
    let n = &step.names;
    match step.verb {
        StepVerb::OpenTab
        | StepVerb::ShowTab
        | StepVerb::GridSort
        | StepVerb::GridFilter
        | StepVerb::EditsSaved
        | StepVerb::DesignApplied
        | StepVerb::ImportRan => n.first().map(String::as_str).into_iter().collect(),
        StepVerb::VqTable | StepVerb::VqTableOff | StepVerb::VqJoin => {
            n.iter().take(STEP_NAMES).map(String::as_str).collect()
        }
        StepVerb::VqTick | StepVerb::VqUntick | StepVerb::VqFilter | StepVerb::VqSort => n
            .iter()
            .take(STEP_NAMES)
            .filter_map(|c| c.rsplit_once('.').map(|(t, _)| t))
            .collect(),
        StepVerb::ImportFile => n.get(1).map(String::as_str).into_iter().collect(),
        StepVerb::RunQuery
        | StepVerb::RunVisual
        | StepVerb::Compared
        | StepVerb::SyncApplied
        | StepVerb::TransferRan => Vec::new(),
    }
}

/// The Recent steps item: the newest 10 steps that are not idle and may go, oldest first,
/// within 1 KB. `ask` is the Ask's Connection and database; `access_of` gives a step's
/// Connection's stored access (`None` when it is gone). A step on the Ask's Connection goes
/// at the lower of its access and `ask_access`, the Ask's lowest access; a step on another
/// Connection goes at that Connection's own access, whatever the Ask's (an Ask at Never,
/// on a missing Connection or on none). `clean` cleans each name before it is masked and
/// cut.
pub fn render_steps(
    steps: &[StepIn],
    now_ms: i64,
    ask: (Option<ConnectionId>, Option<&str>),
    access_of: &dyn Fn(ConnectionId) -> Option<AiAccess>,
    ask_access: AiAccess,
    clean: &dyn Fn(&str) -> String,
) -> StepsOut {
    let (read, unread) = newest(steps, now_ms);
    let mut out = StepsOut {
        left_out: unread,
        ..StepsOut::default()
    };
    let level_of = |id: ConnectionId| access_of(id).map_or(0, rank);
    // Newest first: (step, label, used, place).
    let mut kept: Vec<(&StepIn, String, u8, Place)> = Vec::new();
    for step in read {
        let gate = match step.connection_id {
            None => Gate {
                level: 0,
                source_level: 0,
                place: Place::None,
            },
            Some(id) => {
                let own = level_of(id);
                if own == 0 {
                    out.held += 1;
                    continue;
                }
                let (level, place) = if ask.0 == Some(id) {
                    let level = own.min(rank(ask_access));
                    if level == 0 {
                        out.held_by_ask += 1;
                        continue;
                    }
                    let other_database = step.database.as_deref() != ask.1;
                    (level, Place::Same { other_database })
                } else {
                    (own, Place::Other)
                };
                // A source on a third Connection is named only in a step that is not kept
                // with the turn (one on another Connection), and at the lower access; a
                // kept step says `a source` / `a database`, so the turn holds nothing of a
                // Connection its stamp does not cover.
                let source_level = match step.source_connection_id {
                    Some(source) if source != id && place == Place::Other => {
                        level.min(level_of(source))
                    }
                    Some(source) if source != id => 0,
                    _ => level,
                };
                Gate {
                    level,
                    source_level,
                    place,
                }
            }
        };
        if kept.len() == STEPS_MAX {
            out.left_out += 1;
            continue;
        }
        let (text, used) = label(step, gate, clean);
        kept.push((step, text, used, gate.place));
    }
    kept.reverse();

    // 1 KB: the oldest whole lines go first.
    let lines: Vec<String> = kept
        .iter()
        .map(|(s, text, _, _)| format!("{} {text}", age(now_ms, s.at)))
        .collect();
    let mut bytes: usize = lines.iter().map(|l| l.len() + 1).sum::<usize>();
    let mut first = 0;
    while first < lines.len() && bytes.saturating_sub(1) > STEPS_CAP {
        bytes -= lines[first].len() + 1;
        first += 1;
    }
    out.left_out += first as u32;
    out.text = lines[first..].join("\n");

    let mut seen: HashSet<(Option<&str>, &str)> = HashSet::new();
    for (step, _, used, place) in &kept[first..] {
        let keep = *place != Place::Other;
        out.turn.push(keep);
        if keep {
            out.used = out.used.max(*used);
        }
        // A source on a Connection other than the step's own (a third one, or the Ask's):
        // the label holds that Connection's names, which a step stored for the step's
        // Connection would keep past a purge of the source, so it is sent, not stored.
        let foreign_source = step
            .source_connection_id
            .is_some_and(|s| Some(s) != step.connection_id);
        out.other.push(match step.connection_id {
            Some(id) if !keep && !foreign_source => Some((id, *used)),
            _ => None,
        });
        if *place
            == (Place::Same {
                other_database: false,
            })
        {
            for t in step_tables(step) {
                if !t.is_empty() && seen.insert((step.schema.as_deref(), t)) {
                    out.tables.push(TableRef {
                        schema: step.schema.clone(),
                        name: t.to_string(),
                    });
                }
            }
        }
    }
    out
}

/// The Sends notes for the steps that did not go: those held on this computer, and those
/// the caps left out. Idle steps are dropped silently.
pub fn steps_notes(out: &StepsOut) -> Vec<String> {
    let mut notes = Vec::new();
    match out.held {
        0 => {}
        1 => notes
            .push("1 step stays on this computer: its Connection shares nothing with AI.".into()),
        n => notes.push(format!(
            "{} steps stay on this computer: their Connection shares nothing with AI.",
            grouped(u64::from(n))
        )),
    }
    match out.held_by_ask {
        0 => {}
        1 => notes.push("1 step stays on this computer: this Ask shares nothing with AI.".into()),
        n => notes.push(format!(
            "{} steps stay on this computer: this Ask shares nothing with AI.",
            grouped(u64::from(n))
        )),
    }
    match out.left_out {
        0 => {}
        1 => notes.push("1 older step left out.".into()),
        n => notes.push(format!("{} older steps left out.", grouped(u64::from(n)))),
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const MIN: i64 = 60_000;

    fn a() -> ConnectionId {
        uuid::Uuid::from_u128(1)
    }

    fn b() -> ConnectionId {
        uuid::Uuid::from_u128(2)
    }

    /// A at L2, B at Schema only, C at Never; any other id is gone.
    fn access_of(id: ConnectionId) -> Option<AiAccess> {
        match id.as_u128() {
            1 => Some(AiAccess::SchemaQuery),
            2 => Some(AiAccess::Schema),
            3 => Some(AiAccess::Never),
            4 => Some(AiAccess::SchemaQueryRows),
            _ => None,
        }
    }

    fn plain(t: &str) -> String {
        t.to_string()
    }

    fn step(verb: StepVerb, tab: &str, names: &[&str]) -> StepIn {
        StepIn {
            at: NOW - 2 * MIN,
            verb,
            tab: tab.into(),
            title: None,
            connection_id: Some(a()),
            database: Some("shop".into()),
            schema: None,
            names: names.iter().map(|n| n.to_string()).collect(),
            more: 0,
            count: None,
            has_more: false,
            failed: false,
            descending: false,
            source_connection_id: None,
        }
    }

    fn render(steps: &[StepIn], ask_access: AiAccess) -> StepsOut {
        render_steps(
            steps,
            NOW,
            (Some(a()), Some("shop")),
            &access_of,
            ask_access,
            &plain,
        )
    }

    /// The one label `s` gives, without its age.
    fn label_of(s: StepIn, ask_access: AiAccess) -> String {
        let out = render(&[s], ask_access);
        assert_eq!(out.lines(), 1, "{out:?}");
        out.text.split_once(") ").unwrap().1.to_string()
    }

    fn titled(mut s: StepIn, title: &str) -> StepIn {
        s.title = Some(title.into());
        s
    }

    fn counted(mut s: StepIn, n: u64) -> StepIn {
        s.count = Some(n);
        s
    }

    fn in_db(mut s: StepIn, database: Option<&str>) -> StepIn {
        s.database = database.map(str::to_string);
        s
    }

    #[test]
    fn label_per_verb() {
        use StepVerb::*;
        let mut failed = counted(titled(step(RunQuery, "query", &[]), "Query 3"), 12);
        failed.failed = true;
        let mut sorted = step(GridSort, "object", &["orders", "created_at"]);
        sorted.descending = true;
        let transfer = step(
            TransferRan,
            "transfer",
            &["shop", "orders", "customers", "items", "stores"],
        );
        let cases = [
            (step(OpenTab, "newTable", &[]), "opened New table in shop"),
            (
                in_db(titled(step(ShowTab, "visual", &[]), "Orders over 1M"), None),
                "went to Visual Query \"Orders over 1M\"",
            ),
            (
                titled(step(ShowTab, "visual", &[]), "Orders over 1M"),
                "went to Visual Query \"Orders over 1M\" in shop",
            ),
            (
                step(OpenTab, "object", &["orders"]),
                "opened Table data orders in shop",
            ),
            (step(OpenTab, "spreadsheet", &[]), "opened a tab in shop"),
            (
                counted(titled(step(RunQuery, "query", &[]), "Query 3"), 12),
                "ran the query in \"Query 3\", 12 rows",
            ),
            (failed, "ran the query in \"Query 3\", failed"),
            (
                counted(titled(step(RunVisual, "visual", &[]), "Orders over 1M"), 1),
                "ran the Visual Query \"Orders over 1M\", 1 row",
            ),
            (
                step(VqTable, "visual", &["orders"]),
                "added orders to the Visual Query",
            ),
            (
                step(VqTableOff, "visual", &["orders"]),
                "removed orders from the Visual Query",
            ),
            (
                step(VqTick, "visual", &["orders.total", "orders.id"]),
                "ticked orders.total, orders.id",
            ),
            (
                step(VqUntick, "visual", &["orders.id"]),
                "unticked orders.id",
            ),
            (
                step(VqJoin, "visual", &["orders", "customers"]),
                "joined orders to customers",
            ),
            (
                step(VqFilter, "visual", &["orders.total"]),
                "added a filter on orders.total",
            ),
            (
                step(VqSort, "visual", &["orders.total"]),
                "sorted the Visual Query by orders.total",
            ),
            (sorted, "sorted orders by created_at desc"),
            (
                step(GridFilter, "object", &["orders", "status", "total"]),
                "filtered orders on status, total",
            ),
            (
                counted(step(EditsSaved, "object", &["orders"]), 3),
                "saved 3 Pending Edits to orders",
            ),
            (
                step(DesignApplied, "newTable", &["monthly_totals"]),
                "created table monthly_totals in shop",
            ),
            (
                step(DesignApplied, "design", &["orders"]),
                "changed table orders",
            ),
            (
                counted(
                    in_db(step(Compared, "compare", &["shop"]), Some("shop_staging")),
                    8,
                ),
                "compared shop to shop_staging, 8 differences",
            ),
            (
                counted(
                    in_db(step(SyncApplied, "compare", &[]), Some("shop_staging")),
                    6,
                ),
                "applied 6 changes to shop_staging",
            ),
            (
                counted(in_db(transfer, Some("analytics")), 12_000),
                "copied 4 tables from shop to analytics, 12,000 rows",
            ),
            (
                step(ImportFile, "import", &["orders.csv", "orders"]),
                "chose orders.csv to import into shop.orders",
            ),
            (
                counted(step(ImportRan, "import", &["orders"]), 12_000),
                "imported 12,000 rows into shop.orders",
            ),
            // A step in another database of the Ask's Connection names it.
            (
                in_db(step(VqTick, "visual", &["orders.total"]), Some("archive")),
                "ticked orders.total in archive",
            ),
        ];
        for (s, want) in cases {
            assert_eq!(label_of(s, AiAccess::SchemaQuery), want);
        }
    }

    #[test]
    fn levels_per_part() {
        let s = counted(
            titled(step(StepVerb::RunVisual, "visual", &[]), "Orders over 1M"),
            1,
        );
        let mut at_one = s.clone();
        at_one.connection_id = Some(b());
        let out = render(&[at_one], AiAccess::SchemaQueryRows);
        assert!(
            out.text
                .ends_with(") ran the Visual Query on another Connection")
        );
        // A step on another Connection is never kept with the turn, so it raises no level.
        assert_eq!(out.used, 0);
        let out = render(std::slice::from_ref(&s), AiAccess::SchemaQuery);
        assert!(
            out.text
                .ends_with(") ran the Visual Query \"Orders over 1M\", 1 row")
        );
        assert_eq!(out.used, 2);

        // A step with no Connection goes at any Ask access, as its words only.
        let mut settings = step(StepVerb::OpenTab, "settings", &["general"]);
        settings.connection_id = None;
        settings.title = Some("Kestrel".into());
        for access in [
            AiAccess::Never,
            AiAccess::Schema,
            AiAccess::SchemaQuery,
            AiAccess::SchemaQueryRows,
        ] {
            let out = render(std::slice::from_ref(&settings), access);
            assert_eq!(out.text, "(2 min ago) opened Settings", "{access:?}");
            assert_eq!(out.used, 0);
            assert_eq!(
                out.kept_for_turn(&out.text),
                vec!["opened Settings".to_string()]
            );
            assert_eq!(out.held, 0);
        }
    }

    #[test]
    fn l0_and_missing_connections_drop_whole() {
        let mut never = step(StepVerb::VqTable, "visual", &["orders"]);
        never.connection_id = Some(uuid::Uuid::from_u128(3));
        let mut gone = step(StepVerb::VqTable, "visual", &["customers"]);
        gone.connection_id = Some(uuid::Uuid::from_u128(99));
        let out = render(&[never, gone], AiAccess::SchemaQuery);
        assert_eq!(out.text, "");
        assert_eq!(out.held, 2);
        assert!(out.tables.is_empty() && out.kept_for_turn(&out.text).is_empty());
        assert_eq!(
            steps_notes(&out),
            vec!["2 steps stay on this computer: their Connection shares nothing with AI."]
        );
        let one = StepsOut {
            held: 1,
            left_out: 1,
            ..StepsOut::default()
        };
        assert_eq!(
            steps_notes(&one),
            vec![
                "1 step stays on this computer: its Connection shares nothing with AI.",
                "1 older step left out."
            ]
        );

        // An Ask at Never (lowered by another Connection its tab spans) holds its own
        // Connection's steps, with a note that says why; a step on another Connection
        // still goes at that Connection's own access.
        let mine = step(StepVerb::VqTable, "visual", &["orders"]);
        let mut theirs = counted(titled(step(StepVerb::RunVisual, "visual", &[]), "Q"), 1);
        theirs.connection_id = Some(b());
        let out = render(&[mine.clone(), mine, theirs], AiAccess::Never);
        assert_eq!(
            out.text,
            "(2 min ago) ran the Visual Query on another Connection"
        );
        assert_eq!((out.held, out.held_by_ask), (0, 2));
        assert_eq!(
            steps_notes(&out),
            vec!["2 steps stay on this computer: this Ask shares nothing with AI."]
        );
        let one = StepsOut {
            held_by_ask: 1,
            ..StepsOut::default()
        };
        assert_eq!(
            steps_notes(&one),
            vec!["1 step stays on this computer: this Ask shares nothing with AI."]
        );
    }

    #[test]
    fn other_connection_steps() {
        let mut s = counted(step(StepVerb::RunVisual, "visual", &[]), 1);
        s.title = Some("Orders over 1M".into());
        s.connection_id = Some(b());
        let mut opened = step(StepVerb::OpenTab, "visual", &[]);
        opened.connection_id = Some(b());
        let mine = step(StepVerb::VqTable, "visual", &["orders"]);
        let out = render(&[opened, s, mine], AiAccess::SchemaQuery);
        assert_eq!(
            out.text,
            "(2 min ago) opened Visual Query on another Connection\n\
             (2 min ago) ran the Visual Query on another Connection\n\
             (2 min ago) added orders to the Visual Query"
        );
        // Only the Ask's own steps may be kept with the turn, and hint its tables.
        assert_eq!(
            out.kept_for_turn(&out.text),
            vec!["added orders to the Visual Query".to_string()]
        );
        assert_eq!(out.turn, vec![false, false, true]);
        assert_eq!(out.used, 1);
        assert_eq!(
            out.tables,
            vec![TableRef {
                schema: None,
                name: "orders".into()
            }]
        );
    }

    #[test]
    fn ask_lower_than_step() {
        let mut s = counted(
            titled(step(StepVerb::RunVisual, "visual", &[]), "Orders over 1M"),
            1,
        );
        s.connection_id = Some(uuid::Uuid::from_u128(4));
        // On another Connection it goes at that Connection's own access, not the Ask's.
        let out = render(std::slice::from_ref(&s), AiAccess::Schema);
        assert!(
            out.text.ends_with(
                ") ran the Visual Query \"Orders over 1M\" on another Connection, 1 row"
            )
        );
        assert_eq!(out.used, 0);
        // On the Ask's own Connection, its L3 is not used: the Ask's lowest access is L1.
        let out = render_steps(
            &[s],
            NOW,
            (Some(uuid::Uuid::from_u128(4)), Some("shop")),
            &access_of,
            AiAccess::Schema,
            &plain,
        );
        assert_eq!(out.text, "(2 min ago) ran the Visual Query");
        assert_eq!(out.used, 1);
    }

    #[test]
    fn ten_steps_and_1_kb() {
        // 14 short steps keep the newest 10, oldest first.
        let steps: Vec<StepIn> = (0..14)
            .map(|i| {
                let mut s = step(StepVerb::VqTable, "visual", &[]);
                s.names = vec![format!("t{i:02}")];
                s.at = NOW - (20 - i) * MIN;
                s
            })
            .collect();
        let out = render(&steps, AiAccess::SchemaQuery);
        assert_eq!(out.lines(), STEPS_MAX);
        assert_eq!(out.left_out, 4);
        assert!(out.text.starts_with("(16 min ago) added t04 "));
        assert!(
            out.text
                .ends_with("(7 min ago) added t13 to the Visual Query")
        );
        assert_eq!(steps_notes(&out), vec!["4 older steps left out."]);

        // 10 long steps go over 1 KB: the oldest whole lines go first.
        let long = |i: i64| {
            let mut s = step(StepVerb::VqTick, "visual", &[]);
            s.names = (0..6)
                .map(|c| format!("tbl{i}.col_é_{c:02}_xxxxxxxxxxxxxxxxxxxxxxxxx"))
                .collect();
            s.at = NOW - (10 - i) * MIN;
            s
        };
        let steps: Vec<StepIn> = (0..10).map(long).collect();
        let out = render(&steps, AiAccess::SchemaQuery);
        assert!(out.text.len() <= STEPS_CAP, "{}", out.text.len());
        assert!(out.lines() < 10 && out.lines() > 0);
        assert_eq!(out.left_out as usize, 10 - out.lines());
        assert_eq!(out.kept_for_turn(&out.text).len(), out.lines());
        assert!(out.text.ends_with("min ago) ticked tbl9.col_é_00_xxxxxxxxxxxxxxxxxxxxxxxxx, tbl9.col_é_01_xxxxxxxxxxxxxxxxxxxxxxxxx, tbl9.col_é_02_xxxxxxxxxxxxxxxxxxxxxxxxx (+3 more)"));
        for line in out.text.lines() {
            let label = line.split_once(") ").unwrap().1;
            assert!(label.len() <= STEP_LABEL_CAP, "{label}");
        }
        // Both caps together: 14 long steps.
        let steps: Vec<StepIn> = (0..14).map(|i| long(i - 4)).collect();
        let out = render(&steps, AiAccess::SchemaQuery);
        assert_eq!(out.left_out as usize, 14 - out.lines());

        // A label with one name over the cap is cut at a character boundary.
        let mut s = step(StepVerb::GridFilter, "object", &[]);
        s.names = vec!["é".repeat(120), "ü".repeat(120)];
        let label = label_of(s, AiAccess::SchemaQuery);
        assert!(
            label.len() <= STEP_LABEL_CAP && label.ends_with('…'),
            "{label}"
        );
        assert!(label.starts_with("filtered éé"));
    }

    #[test]
    fn idle_steps_drop() {
        let mut old = step(StepVerb::VqTable, "visual", &["orders"]);
        old.at = NOW - 31 * MIN;
        let out = render(std::slice::from_ref(&old), AiAccess::SchemaQuery);
        assert_eq!(out, StepsOut::default());
        assert!(steps_notes(&out).is_empty());
        // An idle step on a Connection at Never is not counted as held either.
        old.connection_id = Some(uuid::Uuid::from_u128(3));
        assert_eq!(render(&[old], AiAccess::SchemaQuery).held, 0);
    }

    #[test]
    fn ages() {
        assert_eq!(age(NOW, NOW - 30_000), "(just now)");
        assert_eq!(age(NOW, NOW - (4 * MIN + 59_000)), "(4 min ago)");
        assert_eq!(age(NOW, NOW - 5 * MIN), "(5 min ago)");
        // A clock that moved back reads as now.
        assert_eq!(age(NOW, NOW + MIN), "(just now)");
        // Hostile times never overflow: the oldest is idle, the newest is now.
        assert_eq!(
            age(i64::MAX, i64::MIN),
            format!("({} min ago)", grouped((i64::MAX / MIN) as u64))
        );
        assert_eq!(age(NOW, i64::MAX), "(just now)");
        let mut far = step(StepVerb::VqTable, "visual", &["orders"]);
        far.at = i64::MIN;
        assert_eq!(
            render(std::slice::from_ref(&far), AiAccess::Schema).lines(),
            0
        );
        far.at = i64::MAX;
        let out = render(&[far], AiAccess::Schema);
        assert_eq!(out.text, "(just now) added orders to the Visual Query");
    }

    #[test]
    fn no_sql_no_values() {
        use StepVerb::*;
        let verbs = [
            OpenTab,
            ShowTab,
            RunQuery,
            RunVisual,
            VqTable,
            VqTableOff,
            VqTick,
            VqUntick,
            VqJoin,
            VqFilter,
            VqSort,
            GridSort,
            GridFilter,
            EditsSaved,
            DesignApplied,
            Compared,
            SyncApplied,
            TransferRan,
            ImportFile,
            ImportRan,
        ];
        let evil = ["x' OR 1=1 --", "1000000", "a\"; DROP TABLE t; --"];
        for verb in verbs {
            for tab in ["query", "visual", "newTable", "design", "object", "zzz"] {
                for access in [AiAccess::Schema, AiAccess::SchemaQueryRows] {
                    for failed in [false, true] {
                        let mut s = step(verb, tab, &evil);
                        s.title = Some("t' = 'v".into());
                        s.database = Some("db".into());
                        s.schema = Some("sch".into());
                        s.failed = failed;
                        s.descending = true;
                        let label = label_of(s, access);
                        // Quoted values are masked, at every level.
                        for value in ["OR 1=1", "DROP TABLE", " = "] {
                            assert!(!label.contains(value), "{verb:?} {tab}: {label}");
                        }
                        assert!(!label.replace("'…'", "").contains('\''), "{label}");
                        // Take out what came from the step: what is left is Core words.
                        let mut rest = label.clone();
                        for part in ["x'…'", "1000000", "a\"…\"", "t'…'v", "db", "sch"] {
                            rest = rest.replace(part, "");
                        }
                        for bad in ["'", "=", ";", "--", "<", ">", "select", "SELECT"] {
                            assert!(!rest.contains(bad), "{verb:?} {tab}: {label}");
                        }
                        // Counts need query text access: below it, no digit is the Core's own.
                        if access == AiAccess::Schema {
                            assert!(
                                !rest.chars().any(|c| c.is_ascii_digit()),
                                "{verb:?} {tab}: {label}"
                            );
                            assert!(!label.contains("t'…'v"), "{label}");
                        }
                    }
                }
            }
        }
        let tick = label_of(step(VqTick, "visual", &evil), AiAccess::Schema);
        assert_eq!(tick, "ticked x'…', 1000000, a\"…\"");
        // A title with a value in it goes masked; the Core's own quotes stay.
        let run = titled(step(RunQuery, "query", &[]), "status = 'paid' and \"vip\"");
        assert_eq!(
            label_of(run, AiAccess::SchemaQuery),
            "ran the query in \"status = '…' and \"…\"\""
        );
        let plain = titled(step(RunVisual, "visual", &[]), "Orders over 1M");
        assert_eq!(
            label_of(plain, AiAccess::SchemaQuery),
            "ran the Visual Query \"Orders over 1M\""
        );
    }

    #[test]
    fn names_capped() {
        let names: Vec<String> = (1..=9).map(|i| format!("o.c{i}")).collect();
        let mut s = step(StepVerb::VqTick, "visual", &[]);
        s.names = names;
        assert_eq!(
            label_of(s.clone(), AiAccess::Schema),
            "ticked o.c1, o.c2, o.c3, o.c4, o.c5, o.c6 (+3 more)"
        );
        s.names.truncate(2);
        s.more = 5;
        assert_eq!(label_of(s, AiAccess::Schema), "ticked o.c1, o.c2 (+5 more)");
        let long = "n".repeat(300);
        let label = label_of(
            step(StepVerb::VqTable, "visual", &[&long]),
            AiAccess::Schema,
        );
        assert_eq!(
            label,
            format!("added {}… to the Visual Query", "n".repeat(128))
        );
        // Each name is cleaned before it is cut.
        let out = render_steps(
            &[step(StepVerb::VqTable, "visual", &["ord\u{200B}ers"])],
            NOW,
            (Some(a()), Some("shop")),
            &access_of,
            AiAccess::Schema,
            &|t: &str| t.replace('\u{200B}', ""),
        );
        assert!(out.text.ends_with(") added orders to the Visual Query"));
    }

    #[test]
    fn hint_tables() {
        let here = [
            step(
                StepVerb::VqTick,
                "visual",
                &["orders.total", "customers.name"],
            ),
            step(StepVerb::GridSort, "object", &["orders", "created_at"]),
            step(StepVerb::ImportFile, "import", &["items.csv", "items"]),
        ];
        let out = render(&here, AiAccess::Schema);
        let names: Vec<&str> = out.tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["orders", "customers", "items"]);
        assert!(out.tables.iter().all(|t| t.schema.is_none()));
        // The step's schema goes with its tables.
        let mut archived = step(StepVerb::VqTable, "visual", &["orders"]);
        archived.schema = Some("archive".into());
        let out = render(&[archived], AiAccess::Schema);
        assert_eq!(
            out.tables,
            [TableRef {
                schema: Some("archive".into()),
                name: "orders".into()
            }]
        );
        // Another database of the Ask's Connection, or another Connection: no hints.
        let elsewhere = in_db(
            step(StepVerb::VqTable, "visual", &["orders"]),
            Some("archive"),
        );
        let mut other = step(StepVerb::VqTable, "visual", &["orders"]);
        other.connection_id = Some(b());
        let out = render(&[elsewhere, other], AiAccess::Schema);
        assert!(out.tables.is_empty());
        assert_eq!(out.lines(), 2);
        // Nor from a step the gate held.
        let mut held = step(StepVerb::VqTable, "visual", &["orders"]);
        held.connection_id = Some(uuid::Uuid::from_u128(3));
        assert!(render(&[held], AiAccess::Schema).tables.is_empty());
    }

    #[test]
    fn connections_are_read_once_for_the_newest() {
        let mut steps: Vec<StepIn> = (0..30)
            .map(|i| {
                let mut s = step(StepVerb::VqTable, "visual", &["orders"]);
                s.at = NOW - MIN + i;
                s.connection_id = Some(uuid::Uuid::from_u128(100 + i as u128));
                s
            })
            .collect();
        steps.push(step(StepVerb::VqTable, "visual", &["orders"]));
        steps[30].at = NOW;
        let ids = step_connections(&steps, NOW);
        assert_eq!(ids.len(), STEPS_READ);
        assert_eq!(ids[0], a());
        // The 11 oldest are not read: they count as left out.
        let out = render(&steps, AiAccess::Schema);
        assert_eq!(out.left_out, 11);
        assert_eq!(out.held, 19);
    }

    #[test]
    fn source_on_a_third_connection() {
        let mut compare = counted(
            in_db(
                step(StepVerb::Compared, "compare", &["shop"]),
                Some("shop_staging"),
            ),
            8,
        );
        let mut transfer = counted(
            in_db(
                step(StepVerb::TransferRan, "transfer", &["shop", "orders"]),
                Some("analytics"),
            ),
            12,
        );
        // The source on a Connection at Never, or one that is gone: its name does not go.
        for source in [3, 99] {
            compare.source_connection_id = Some(uuid::Uuid::from_u128(source));
            transfer.source_connection_id = Some(uuid::Uuid::from_u128(source));
            assert_eq!(
                label_of(compare.clone(), AiAccess::SchemaQuery),
                "compared a source to shop_staging, 8 differences"
            );
            assert_eq!(
                label_of(transfer.clone(), AiAccess::SchemaQuery),
                "copied 1 table from a database to analytics, 12 rows"
            );
        }
        // A step on another Connection (L3) names a source at Schema only (L1), and the
        // read covers it.
        compare.connection_id = Some(uuid::Uuid::from_u128(4));
        compare.source_connection_id = Some(b());
        let out = render(std::slice::from_ref(&compare), AiAccess::SchemaQuery);
        assert!(
            out.text
                .ends_with(") compared shop to shop_staging on another Connection, 8 differences"),
            "{}",
            out.text
        );
        assert_eq!(
            step_connections(&[compare], NOW),
            [uuid::Uuid::from_u128(4), b()]
        );
        // On the step's own Connection it is the step's level.
        transfer.source_connection_id = Some(a());
        assert_eq!(
            label_of(transfer, AiAccess::SchemaQuery),
            "copied 1 table from shop to analytics, 12 rows"
        );
    }

    #[test]
    fn label_cut_keeps_the_core_words() {
        let long = |c: &str| c.repeat(128);
        let (t, c) = (long("t"), long("c"));
        let mut s = step(StepVerb::GridSort, "object", &[&t, &c]);
        s.connection_id = Some(b());
        s.failed = true;
        let label = label_of(s, AiAccess::SchemaQuery);
        assert!(label.len() <= STEP_LABEL_CAP, "{label}");
        assert!(label.ends_with(" on another Connection, failed"), "{label}");
        assert!(label.starts_with("sorted tttt"), "{label}");
        // The count stays whole too.
        let mut run = counted(titled(step(StepVerb::RunQuery, "query", &[]), &t), 12_000);
        run.database = Some(long("d"));
        let label = label_of(run, AiAccess::SchemaQuery);
        assert!(label.len() <= STEP_LABEL_CAP, "{label}");
        assert!(label.ends_with("…, 12,000 rows"), "{label}");
    }

    #[test]
    fn kept_for_turn_follows_what_went() {
        let mut theirs = step(StepVerb::VqTable, "visual", &["customers"]);
        theirs.connection_id = Some(b());
        let steps = [
            step(StepVerb::VqTable, "visual", &["orders"]),
            theirs,
            step(StepVerb::VqTable, "visual", &["items"]),
        ];
        let out = render(&steps, AiAccess::Schema);
        assert_eq!(
            out.kept_for_turn(&out.text),
            [
                "added orders to the Visual Query",
                "added items to the Visual Query"
            ]
        );
        // The rails or the 200 KB cut dropped the oldest line, and cleaned another.
        let sent = "(2 min ago) added customers to the Visual Query\n(2 min ago) added [redacted] to the Visual Query";
        assert_eq!(
            out.kept_for_turn(sent),
            ["added [redacted] to the Visual Query"]
        );
        assert!(out.kept_for_turn("").is_empty());
    }

    /// Task 5b, tests 1 and 9 (unit): a step on another Connection that went is kept with
    /// its Connection, its label as it went and the level that label needed; it never holds
    /// SQL or values, and a step naming a source on a third Connection is not kept.
    #[test]
    fn others_for_turn_follow_what_went() {
        let d = uuid::Uuid::from_u128(4);
        let mut ran = counted(
            titled(
                step(StepVerb::RunVisual, "visual", &[]),
                "Late 'vip' orders",
            ),
            3,
        );
        ran.connection_id = Some(d);
        let mut opened = step(StepVerb::OpenTab, "query", &[]);
        opened.connection_id = Some(b());
        // On D (L3), with its source on B: B is a third Connection here.
        let mut compare = counted(
            in_db(
                step(StepVerb::Compared, "compare", &["shop"]),
                Some("shop_staging"),
            ),
            8,
        );
        compare.connection_id = Some(d);
        compare.source_connection_id = Some(b());
        // On D, with its source on the Ask's Connection: sent with the source's database
        // name, never stored tied to D, so a purge of the Ask's Connection stays exact.
        let mut transfer = in_db(
            step(StepVerb::TransferRan, "transfer", &["shop", "orders"]),
            Some("analytics"),
        );
        transfer.connection_id = Some(d);
        transfer.source_connection_id = Some(a());
        let mine = step(StepVerb::VqTable, "visual", &["orders"]);
        let out = render(
            &[ran, opened, compare, transfer, mine],
            AiAccess::SchemaQuery,
        );
        let others = out.others_for_turn(&out.text);
        let got: Vec<(ConnectionId, &str, AiAccess)> = others
            .iter()
            .map(|o| (o.connection_id, o.text.as_str(), o.level))
            .collect();
        assert_eq!(
            got,
            [
                (
                    d,
                    "ran the Visual Query \"Late '…' orders\" on another Connection, 3 rows",
                    AiAccess::SchemaQuery
                ),
                (
                    b(),
                    "opened Query tab on another Connection",
                    AiAccess::Schema
                ),
            ]
        );
        assert!(
            out.text
                .contains("copied 1 table from shop to analytics on another Connection")
        );
        // The own step is kept as before; no other step raises the stamped level.
        assert_eq!(
            out.kept_for_turn(&out.text),
            ["added orders to the Visual Query"]
        );
        assert_eq!(out.used, 1);
        // Only what went: the rails dropped the oldest line.
        let sent: Vec<&str> = out.text.lines().skip(1).collect();
        assert_eq!(out.others_for_turn(&sent.join("\n")).len(), 1);
        assert!(out.others_for_turn("").is_empty());
        // No SQL text and no quoted value in any of them.
        for o in &others {
            assert!(
                !o.text.contains("vip") && !o.text.contains("select"),
                "{}",
                o.text
            );
        }
    }

    #[test]
    fn kept_step_never_names_a_foreign_source() {
        // On the Ask's Connection, with its source on another Connection that shares
        // schema: the step is kept for the turn, so the source is not named.
        let mut compare = counted(
            in_db(
                step(StepVerb::Compared, "compare", &["shop"]),
                Some("shop_staging"),
            ),
            8,
        );
        compare.source_connection_id = Some(b());
        let mut transfer = in_db(
            step(StepVerb::TransferRan, "transfer", &["shop", "orders"]),
            Some("analytics"),
        );
        transfer.source_connection_id = Some(b());
        let out = render(&[compare, transfer], AiAccess::SchemaQuery);
        assert_eq!(
            out.kept_for_turn(&out.text),
            [
                "compared a source to shop_staging, 8 differences",
                "copied 1 table from a database to analytics"
            ]
        );
        assert!(!out.text.contains("shop to"), "{}", out.text);
        assert_eq!(out.turn, [true, true]);
        // The level stamped is the step's own: the source's Connection added nothing.
        assert_eq!(out.used, 2);
    }

    #[test]
    fn hostile_counts_never_cut_core_words() {
        let wide = "𝔸".repeat(40);
        let mut s = step(StepVerb::OpenTab, "savedQueries", &[]);
        s.names = vec![wide.clone(); 9];
        s.more = u32::MAX;
        s.title = Some(wide.clone());
        s.database = Some(wide.clone());
        s.failed = true;
        let label = label_of(s.clone(), AiAccess::SchemaQuery);
        assert!(label.len() <= STEP_LABEL_CAP, "{label}");
        assert!(label.ends_with(", failed"), "{label}");
        assert!(label.contains("(+999+ more)"), "{label}");
        // Every verb, on another Connection.
        s.connection_id = Some(b());
        for verb in [
            StepVerb::GridSort,
            StepVerb::VqJoin,
            StepVerb::VqTick,
            StepVerb::TransferRan,
            StepVerb::ImportFile,
        ] {
            s.verb = verb;
            let label = label_of(s.clone(), AiAccess::SchemaQueryRows);
            assert!(label.len() <= STEP_LABEL_CAP, "{verb:?}: {label}");
            assert!(
                label.ends_with(" on another Connection, failed"),
                "{verb:?}: {label}"
            );
        }
    }

    #[test]
    fn line_separators_are_spaces() {
        let s = step(
            StepVerb::VqTable,
            "visual",
            &["ord\u{2028}ers", "it\u{2029}ems"],
        );
        let out = render(&[s], AiAccess::Schema);
        assert_eq!(out.lines(), 1);
        assert!(
            out.text
                .ends_with(") added ord ers, it ems to the Visual Query"),
            "{}",
            out.text
        );
    }
}
