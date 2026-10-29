//! The skip and refuse lists, transaction checks and statement kinds. One statement can
//! hold several that the server runs (a DELIMITER body, a `/*! */` block, a routine
//! body, or another backslash reading), so every `;`-separated piece is checked, under
//! both backslash readings, and the strictest answer wins. One pass per reading,
//! with no copy of the text. A dollar-quoted body (`DO $$ .. $$`) is one string here and
//! is not looked into; 5a calls DO a write, so Read-only refuses it and Production asks.

use crate::jobs::limits::MAX_CHECKED_TOKENS;
use crate::jobs::types::{ScriptAction, StatementKind};
use crate::model::DialectKind;
use crate::safety::may_read;

use super::tokens::{K, Tok, lex};

/// What the lists and checks found in one statement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Facts {
    /// What the refusal names, as in "{what} is not run from an import."
    pub refused: Option<&'static str>,
    /// The words of the skip, as in "{WORD} is skipped unless Run as is is ticked."
    pub skipped: Option<String>,
    pub kind: StatementKind,
    /// A piece controls transactions.
    pub control: bool,
    /// A piece cannot run inside an outer transaction.
    pub ends: bool,
    /// The statement is `COPY ... FROM STDIN`, so data lines follow it.
    pub copy_from_stdin: bool,
    /// It starts with CREATE, ALTER, DROP, RENAME or TRUNCATE.
    pub ddl: bool,
    /// What its last transaction-control piece does, for a file run as written.
    pub tx: TxControl,
    /// It changes the session (SET, USE, RESET, `set_config(..)`), so the Production
    /// confirmation always lists it.
    pub session: bool,
    /// A psql line that is skipped even with Run as is (pg_dump's `\restrict` and
    /// `\unrestrict`): the reason.
    pub psql_skip: Option<String>,
    /// The most tokens either reading found (every token but `;`).
    pub tokens: usize,
    /// A piece starts with a word the 5a classifier can call a read, so `classify`
    /// keeps all its tokens.
    pub may_read: bool,
    /// It may read and holds more than `MAX_CHECKED_TOKENS` tokens: refused without
    /// being classified, which would cost too much memory.
    pub too_large: bool,
}

/// What a transaction-control statement does, by its first word.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(crate) enum TxControl {
    #[default]
    None,
    /// BEGIN, START TRANSACTION.
    Opens,
    /// COMMIT, END.
    Commits,
    /// ROLLBACK, ABORT.
    RollsBack,
    /// MySQL `SET autocommit = 0` (or OFF, FALSE).
    AutocommitOff,
    /// MySQL `SET autocommit = 1`, which also commits what is open.
    AutocommitOn,
    /// MySQL LOCK or UNLOCK TABLES: commits what is open, opens nothing.
    Locks,
    /// Anything else that controls transactions (XA END, PREPARE TRANSACTION, an
    /// autocommit value Contura cannot read): counted as opening one.
    Other,
}

impl Facts {
    pub(crate) fn of(dialect: DialectKind, text: &str) -> Facts {
        let mut f = Facts {
            refused: None,
            skipped: None,
            kind: StatementKind::Other,
            control: false,
            ends: false,
            copy_from_stdin: false,
            ddl: false,
            tx: TxControl::None,
            session: false,
            psql_skip: None,
            tokens: 0,
            may_read: false,
            too_large: false,
        };
        if let Some(word) = restrict_line(text) {
            // pg_dump 17.6+ wraps its output in these; they only guard psql's own
            // meta-commands, which an import refuses anyway.
            f.psql_skip = Some(format!("{word} is a psql line, so it is skipped."));
            return f;
        }
        if text.trim_start().starts_with('\\') {
            f.refused = Some("A psql meta-command");
        }
        scan(dialect, text, false, &mut f);
        if text.contains('\\') {
            scan(dialect, text, true, &mut f);
        }
        f.too_large = f.may_read && f.tokens > MAX_CHECKED_TOKENS;
        f
    }

    /// Refused statements never run; skipped ones run only when Run as is is ticked.
    pub(crate) fn action(&self, run_as_is: bool) -> ScriptAction {
        if let Some(reason) = &self.psql_skip {
            return ScriptAction::Skip {
                reason: reason.clone(),
            };
        }
        if self.too_large {
            return ScriptAction::Refuse {
                reason: format!(
                    "This statement is too large to check safely (more than {} parts). \
                     Split it into smaller statements.",
                    thousands(MAX_CHECKED_TOKENS)
                ),
            };
        }
        if let Some(what) = self.refused {
            // pg_dump writes its data as COPY by default; the import runs INSERTs.
            let fix = if what == "COPY FROM STDIN" {
                " Make the dump with pg_dump --inserts, which writes INSERT statements."
            } else {
                ""
            };
            return ScriptAction::Refuse {
                reason: format!("{what} is not run from an import.{fix}"),
            };
        }
        match &self.skipped {
            Some(word) if !run_as_is => ScriptAction::Skip {
                reason: format!("{word} is skipped unless Run as is is ticked."),
            },
            _ => ScriptAction::Run,
        }
    }
}

/// `\restrict` or `\unrestrict` when the whole statement is that line and its key.
fn restrict_line(text: &str) -> Option<&'static str> {
    let rest = text.trim();
    let (word, key) = match rest.strip_prefix("\\restrict") {
        Some(k) => ("\\restrict", k),
        None => ("\\unrestrict", rest.strip_prefix("\\unrestrict")?),
    };
    let spaced = key.starts_with(char::is_whitespace);
    let key = key.trim();
    let plain = !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric());
    (spaced && plain).then_some(word)
}

/// `500,000` for `500000`.
fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn scan(dialect: DialectKind, text: &str, flip: bool, f: &mut Facts) {
    let mut at = Reading {
        default: !flip,
        pieces: 0,
        creates: false,
        tokens: 0,
    };
    let mut piece = Piece::new(text);
    for t in lex(dialect, text, flip) {
        if t.is_punct(b';') {
            piece.finish(dialect, f, &mut at);
            piece = Piece::new(text);
        } else {
            piece.feed(t);
        }
    }
    piece.finish(dialect, f, &mut at);
    f.tokens = f.tokens.max(at.tokens);
}

/// Where a reading's pass has got to.
struct Reading {
    /// The Dialect's default backslash reading, which gives the kind.
    default: bool,
    /// Non-empty pieces so far.
    pieces: usize,
    /// The first piece starts with CREATE, so a later piece may be part of a routine,
    /// trigger or BEGIN ATOMIC body.
    creates: bool,
    /// Tokens so far, every piece.
    tokens: usize,
}

/// One `;`-separated piece, read token by token.
struct Piece<'a> {
    text: &'a str,
    first: [Option<Tok>; 4],
    words: usize,
    tokens: usize,
    lead_backslash: bool,
    prev: Option<Tok>,
    program: bool,
    stdin: bool,
    outfile: bool,
    copy_file: bool,
    load_extension: bool,
    has_to: bool,
    has_into: bool,
    autocommit: bool,
    /// The value after an `autocommit` word comes next.
    autocommit_next: bool,
    /// The value set: Some(None) when it is not one Contura reads.
    autocommit_to: Option<Option<bool>>,
    set_config: bool,
    concurrently: bool,
    depth: u32,
    scope_next: bool,
    set_global: bool,
    set_persist: bool,
}

impl<'a> Piece<'a> {
    fn new(text: &'a str) -> Self {
        Piece {
            text,
            first: [None; 4],
            words: 0,
            tokens: 0,
            lead_backslash: false,
            prev: None,
            program: false,
            stdin: false,
            outfile: false,
            copy_file: false,
            load_extension: false,
            has_to: false,
            has_into: false,
            autocommit: false,
            autocommit_next: false,
            autocommit_to: None,
            set_config: false,
            concurrently: false,
            depth: 0,
            scope_next: false,
            set_global: false,
            set_persist: false,
        }
    }

    fn feed(&mut self, t: Tok) {
        let text = self.text;
        let is = |w: &str| t.is(text, w);
        self.tokens += 1;
        if self.tokens == 1 {
            self.lead_backslash = t.is_punct(b'\\');
        }
        if t.k == K::Word {
            if self.words < 4 {
                self.first[self.words] = Some(t);
            }
            self.words += 1;
            self.has_to |= is("TO");
            self.has_into |= is("INTO");
            self.concurrently |= is("CONCURRENTLY");
            let word = text[t.start..t.end].trim_start_matches('@');
            let is_autocommit = word.eq_ignore_ascii_case("AUTOCOMMIT")
                || word.len() > 11
                    && word.is_char_boundary(word.len() - 11)
                    && word[word.len() - 11..].eq_ignore_ascii_case(".AUTOCOMMIT");
            if self.autocommit_next && !is_autocommit {
                self.autocommit_to = Some(match word.to_ascii_uppercase().as_str() {
                    "ON" | "TRUE" => Some(true),
                    "OFF" | "FALSE" => Some(false),
                    _ => None,
                });
                self.autocommit_next = false;
            }
            self.autocommit |= is_autocommit;
            self.autocommit_next |= is_autocommit;
        } else if self.autocommit_next
            && !t.is_punct(b'=')
            && !t.is_punct(b':')
            && !t.is_punct(b'.')
        {
            self.autocommit_to = Some(match (t.k, &text[t.start..t.end]) {
                (K::Num, "0") => Some(false),
                (K::Num, "1") => Some(true),
                _ => None,
            });
            self.autocommit_next = false;
        }
        if let Some(p) = self.prev {
            let was = |w: &str| p.is(text, w);
            let from_to = was("FROM") || was("TO");
            self.program |= from_to && is("PROGRAM");
            self.stdin |= was("FROM") && is("STDIN");
            self.set_config |= was("SET_CONFIG") && t.is_punct(b'(');
            self.outfile |= was("INTO") && (is("OUTFILE") || is("DUMPFILE"));
            self.copy_file |= from_to && t.k == K::Str;
            // Quoting the name (`"load_extension"`, `[..]`, backticks) calls it too.
            let quoted = p.k == K::Ident
                && text
                    .get(p.start + 1..p.end.saturating_sub(1))
                    .is_some_and(|n| n.eq_ignore_ascii_case("load_extension"));
            self.load_extension |= (was("LOAD_EXTENSION") || quoted) && t.is_punct(b'(');
        }
        // SET scope: the word that starts each top-level assignment.
        if self.tokens > 1 {
            let mut comma = false;
            match t.k {
                K::Word => {
                    let scope = self.scope_next;
                    self.set_global |= is("@@GLOBAL") || scope && is("GLOBAL");
                    self.set_persist |= is("@@PERSIST")
                        || is("@@PERSIST_ONLY")
                        || scope && (is("PERSIST") || is("PERSIST_ONLY"));
                }
                K::Punct(b'(') => self.depth += 1,
                K::Punct(b')') => self.depth = self.depth.saturating_sub(1),
                K::Punct(b',') => comma = self.depth == 0,
                _ => {}
            }
            self.scope_next = comma;
        } else {
            self.scope_next = true;
        }
        self.prev = Some(t);
    }

    /// The `n`th word, or "".
    fn word(&self, n: usize) -> &'a str {
        self.first
            .get(n)
            .copied()
            .flatten()
            .map_or("", |t| &self.text[t.start..t.end])
    }

    fn w(&self, n: usize, s: &str) -> bool {
        self.word(n).eq_ignore_ascii_case(s)
    }

    fn refused(&self, dialect: DialectKind) -> Option<&'static str> {
        let mysql = dialect == DialectKind::MySql;
        let postgres = dialect == DialectKind::Postgres;
        let sqlite = dialect == DialectKind::Sqlite;
        if self.lead_backslash {
            return Some("A psql meta-command");
        }
        if self.w(0, "DROP") && (self.w(1, "DATABASE") || mysql && self.w(1, "SCHEMA")) {
            // MySQL's DROP SCHEMA is DROP DATABASE.
            return Some("DROP DATABASE");
        }
        if self.w(0, "COPY") {
            if self.program {
                return Some("COPY PROGRAM");
            }
            if self.stdin {
                return Some("COPY FROM STDIN");
            }
            if postgres && self.copy_file {
                return Some("COPY with a server file");
            }
        }
        // LOAD XML reads the client's files the same way.
        if self.w(0, "LOAD") && (self.w(1, "DATA") || self.w(1, "XML")) {
            return Some("LOAD DATA");
        }
        if sqlite && self.w(0, "ATTACH") {
            return Some("ATTACH");
        }
        if self.w(0, "SHUTDOWN") {
            return Some("SHUTDOWN");
        }
        if mysql && self.outfile {
            return Some("SELECT INTO OUTFILE");
        }
        if postgres && self.w(0, "ALTER") && self.w(1, "SYSTEM") {
            return Some("ALTER SYSTEM");
        }
        if sqlite && self.w(0, "VACUUM") && self.has_into {
            return Some("VACUUM INTO");
        }
        if sqlite && self.load_extension {
            return Some("load_extension");
        }
        None
    }

    fn skipped(&self, dialect: DialectKind) -> Option<String> {
        if self.w(0, "GRANT") || self.w(0, "REVOKE") {
            return Some(self.word(0).to_ascii_uppercase());
        }
        if self.w(0, "CREATE") || self.w(0, "ALTER") || self.w(0, "DROP") {
            let k = if self.w(1, "OR") && self.w(2, "REPLACE") {
                3
            } else {
                1
            };
            let role = self.w(k, "USER")
                || self.w(k, "ROLE")
                || dialect == DialectKind::Postgres && self.w(k, "GROUP");
            return role.then(|| {
                format!(
                    "{} {}",
                    self.word(0).to_ascii_uppercase(),
                    self.word(k).to_ascii_uppercase()
                )
            });
        }
        if self.w(0, "SET") {
            if self.set_global {
                return Some("SET GLOBAL".into());
            }
            if self.set_persist {
                return Some("SET PERSIST".into());
            }
        }
        None
    }

    /// What this transaction-control piece does.
    fn tx_control(&self) -> TxControl {
        match self.word(0).to_ascii_uppercase().as_str() {
            "BEGIN" | "START" => TxControl::Opens,
            "COMMIT" | "END" => TxControl::Commits,
            "ROLLBACK" | "ABORT" => TxControl::RollsBack,
            "LOCK" | "UNLOCK" => TxControl::Locks,
            "XA" if self.w(1, "START") || self.w(1, "BEGIN") => TxControl::Opens,
            "XA" if self.w(1, "COMMIT") => TxControl::Commits,
            "XA" if self.w(1, "ROLLBACK") => TxControl::RollsBack,
            "SET" if self.autocommit => match self.autocommit_to {
                Some(Some(false)) => TxControl::AutocommitOff,
                Some(Some(true)) => TxControl::AutocommitOn,
                _ => TxControl::Other,
            },
            _ => TxControl::Other,
        }
    }

    fn control(&self, dialect: DialectKind) -> bool {
        let mysql = dialect == DialectKind::MySql;
        let postgres = dialect == DialectKind::Postgres;
        let w0 = self.word(0).to_ascii_uppercase();
        match w0.as_str() {
            "BEGIN" | "COMMIT" => true,
            "START" => self.w(1, "TRANSACTION"),
            "ROLLBACK" => !self.has_to,
            "END" => !mysql,
            "ABORT" => postgres,
            "PREPARE" => postgres && self.w(1, "TRANSACTION"),
            "LOCK" | "UNLOCK" => mysql && (self.w(1, "TABLES") || self.w(1, "TABLE")),
            "XA" => mysql,
            "SET" => mysql && self.autocommit,
            _ => false,
        }
    }

    /// Cannot run inside an outer transaction: transaction control, MySQL statements that
    /// commit as they run, and PostgreSQL and SQLite statements refused inside one.
    fn ends(&self, dialect: DialectKind) -> bool {
        if self.control(dialect) {
            return true;
        }
        let w0 = self.word(0).to_ascii_uppercase();
        match dialect {
            DialectKind::MySql => match w0.as_str() {
                "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE" | "GRANT" | "REVOKE"
                | "ANALYZE" | "OPTIMIZE" | "REPAIR" | "FLUSH" | "RESET" | "INSTALL"
                | "UNINSTALL" | "CACHE" => true,
                "LOAD" => self.w(1, "INDEX"),
                "SET" => self.w(1, "PASSWORD"),
                "CHECK" | "IMPORT" => self.w(1, "TABLE"),
                "START" | "STOP" => {
                    self.w(1, "REPLICA") || self.w(1, "SLAVE") || self.w(1, "GROUP_REPLICATION")
                }
                "CHANGE" => self.w(1, "REPLICATION") || self.w(1, "MASTER"),
                _ => false,
            },
            DialectKind::Postgres => match w0.as_str() {
                "CREATE" | "DROP" | "REINDEX" if self.concurrently => true,
                "CREATE" => self.w(1, "DATABASE"),
                "VACUUM" => true,
                _ => false,
            },
            DialectKind::Sqlite => w0 == "VACUUM",
        }
    }

    fn finish(&self, dialect: DialectKind, f: &mut Facts, at: &mut Reading) {
        if self.tokens == 0 {
            return;
        }
        let first = at.pieces == 0;
        at.pieces += 1;
        at.tokens += self.tokens;
        if first {
            at.creates = self.w(0, "CREATE");
        }
        // The first word may stand after leading tokens the classifier would seal on;
        // counting it here only ever caps more, never less.
        let lead = self.word(0);
        if lead.len() <= 16 && may_read(dialect, &lead.to_ascii_uppercase()) {
            f.may_read = true;
        }
        if f.refused.is_none() {
            f.refused = self.refused(dialect);
        }
        if f.skipped.is_none() {
            f.skipped = self.skipped(dialect);
        }
        // A BEGIN or END piece after a CREATE opens or closes the body being created
        // (a trigger, a BEGIN ATOMIC routine, a MySQL BEGIN ... END block), not a
        // transaction.
        // A BEGIN that is a whole statement (`BEGIN`, `BEGIN WORK`) opens a transaction
        // even there: a block's BEGIN always has a statement after it.
        let bare_begin = self.w(0, "BEGIN")
            && self.tokens == self.words
            && (self.words == 1
                || self.words == 2 && (self.w(1, "WORK") || self.w(1, "TRANSACTION")));
        let body = !first && at.creates && (self.w(0, "BEGIN") && !bare_begin || self.w(0, "END"));
        if !body {
            let control = self.control(dialect);
            f.control |= control;
            f.ends |= self.ends(dialect);
            if control && at.default {
                f.tx = self.tx_control();
            }
        }
        if first && at.default {
            f.kind = if self.w(0, "CREATE") {
                StatementKind::Create
            } else if self.w(0, "INSERT") || self.w(0, "REPLACE") {
                StatementKind::Insert
            } else {
                StatementKind::Other
            };
            f.copy_from_stdin = self.w(0, "COPY") && self.stdin;
            f.ddl = ["CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE"]
                .iter()
                .any(|w| self.w(0, w));
        }
        if at.default {
            f.session |= ["SET", "USE", "RESET"].iter().any(|w| self.w(0, w)) || self.set_config;
        }
    }
}

/// Refused statements never run; skipped ones run only when Run as is is ticked.
pub fn statement_action(dialect: DialectKind, text: &str, run_as_is: bool) -> ScriptAction {
    Facts::of(dialect, text).action(run_as_is)
}

/// `BEGIN`, `COMMIT`, `ROLLBACK` (not `ROLLBACK TO`), `START TRANSACTION`, `END` and
/// `ABORT` (PostgreSQL), and on MySQL `LOCK TABLES`, `UNLOCK TABLES`, `XA` and setting
/// `autocommit`, in any piece of the statement.
pub fn is_transaction_control(dialect: DialectKind, text: &str) -> bool {
    Facts::of(dialect, text).control
}

/// The statement cannot run inside an outer transaction: it controls transactions, it is
/// MySQL DDL (or another MySQL statement that commits as it runs), or PostgreSQL or
/// SQLite refuse it inside one (VACUUM, CONCURRENTLY, CREATE DATABASE).
pub fn ends_transaction(dialect: DialectKind, text: &str) -> bool {
    Facts::of(dialect, text).ends
}

pub fn statement_kind(dialect: DialectKind, text: &str) -> StatementKind {
    Facts::of(dialect, text).kind
}
