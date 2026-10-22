//! The input rail: the access gate (R1) and cleaning the text that goes out (R2).

use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use crate::ai::AiAccess;
use crate::ai::log::{Level, Log};
use crate::ai::request::{ItemKind, Switches};
use crate::model::DialectKind;
use crate::safety::{literal_counts, mask_literals};

use super::{Ask, Rail, RailOutcome};

const REDACTED: &str = "[redacted]";

/// R2.4 caps in bytes, per item kind.
const QUESTION_CAP: usize = 16 * 1024;
const ERROR_CAP: usize = 4 * 1024;
const SQL_CAP: usize = 64 * 1024;
const OUTLINE_CAP: usize = 32 * 1024;

/// The level an item kind needs: 0 question, 1 schema, 2 query text, 3 rows.
fn need(kind: ItemKind) -> u8 {
    match kind {
        ItemKind::Question => 0,
        ItemKind::Names | ItemKind::Cards | ItemKind::Outline | ItemKind::Dbml => 1,
        ItemKind::Sql | ItemKind::Error | ItemKind::SavedQueries => 2,
        ItemKind::Values | ItemKind::Rows => 3,
    }
}

fn rank(access: AiAccess) -> u8 {
    match access {
        AiAccess::Never => 0,
        AiAccess::Schema => 1,
        AiAccess::SchemaQuery => 2,
        AiAccess::SchemaQueryRows => 3,
    }
}

/// Whether an item of `kind` may go out at `access` (R1.1).
pub fn allowed(access: AiAccess, kind: ItemKind, switches: Switches) -> bool {
    let level_ok = rank(access) >= need(kind);
    match kind {
        ItemKind::Values => level_ok && switches.values,
        ItemKind::Rows => level_ok && switches.rows,
        _ => level_ok,
    }
}

/// Why an item of `kind` cannot be switched on at `access`, in today's Sends wording.
/// An empty `connection_name` means no Connection is chosen.
pub fn lock_reason(access: AiAccess, kind: ItemKind, connection_name: &str) -> Option<String> {
    let need = need(kind);
    if need == 0 {
        return None;
    }
    if connection_name.is_empty() {
        return Some("No Connection is chosen".into());
    }
    let rank = rank(access);
    if rank == 0 {
        return Some(format!("{connection_name} shares nothing with AI"));
    }
    if rank >= need {
        return None;
    }
    Some(if need == 3 && rank == 2 {
        format!("Sample rows are off for {connection_name}")
    } else {
        format!("{connection_name} shares schema only")
    })
}

/// A quoted literal: the secret is group 1 (single quotes) or 2 (double quotes).
/// A doubled quote inside is part of the value.
const QUOTED: &str = r#"(?:'((?:[^']|'')*)'|"((?:[^"]|"")*)")"#;

/// Shapes whose secret is a capture group: the statement words stay, the value goes.
static SECRET_VALUES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        format!(r"(?i)\bIDENTIFIED\s+(?:WITH\s+\S+\s+)?BY\s+(?:PASSWORD\s+)?{QUOTED}"),
        format!(r"(?i)\bPASSWORD\s*(?:=\s*)?{QUOTED}"),
        format!(r"(?i)\bSET\s+PASSWORD\b[^;=]*=\s*(?:PASSWORD\s*\(\s*)?{QUOTED}"),
    ]
    .iter()
    .map(|p| Regex::new(p).expect("secret pattern"))
    .collect()
});

/// `scheme://user:pass@`: the secret is group 1. It runs to the last `@` of the authority,
/// so a password holding `@` is hidden whole.
static URI_PASSWORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\b[A-Za-z][A-Za-z0-9+.\-]*://[^\s:/@'"]+:([^\s/'"]+)@"#).expect("uri pattern")
});

/// Token shapes, replaced whole. `sk-` covers `sk-ant-`.
static TOKENS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"\bsk-[A-Za-z0-9_\-]{16,}",
        r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+",
        r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:.*?-----END [A-Z0-9 ]*PRIVATE KEY-----|.*)",
        r"\bghp_[A-Za-z0-9]{20,}",
        r"\bxox[bp]-[A-Za-z0-9\-]{10,}",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("token pattern"))
    .collect()
});

/// `Key (col)=(value)` in PostgreSQL errors; greedy to the line's last `)` so a value
/// with parentheses is hidden whole.
static ERROR_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Key \((.*?)\)=\([^\n]*\)").expect("key pattern"));

/// PostgreSQL quotes the bad value in double quotes in these messages, so its lexer would
/// read the value as a name; greedy to the line's last `"` so a value holding `"` is hidden
/// whole. Names elsewhere in errors stay.
static PG_ERROR_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)((?:invalid input (?:syntax|value) for (?:type|enum) [^:
]+|date/time field value out of range|malformed [a-z]+ literal): )"[^
]*""#,
    )
    .expect("pg value pattern")
});

/// The saved secrets matched exactly (R2.1).
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Secrets {
    /// Provider keys: long random strings, matched wherever they appear.
    pub keys: Vec<String>,
    /// Connection passwords: matched only as whole words.
    pub passwords: Vec<String>,
}

/// Counts only: a `{:?}` never prints a key or a password.
impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secrets")
            .field("keys", &self.keys.len())
            .field("passwords", &self.passwords.len())
            .finish()
    }
}

/// The Steps evidence rule of each kind of secret.
pub const PASSWORD_PATTERN: &str = "password pattern";
pub const KEY_PATTERN: &str = "key pattern";
pub const SAVED_KEY: &str = "saved key";
pub const SAVED_PASSWORD: &str = "saved password";

/// `text` with every secret shape (R2.1) and every saved secret in `exact` replaced by
/// `[redacted]`, and the number of replacements.
pub fn redact_secrets(text: &str, exact: &Secrets) -> (String, usize) {
    let (out, rules) = redact_secrets_by_rule(text, exact);
    (out, rules.len())
}

/// As `redact_secrets`, with the rule that found each replacement, in text order. Where
/// two finds overlap, the first one's rule counts.
pub fn redact_secrets_by_rule(text: &str, exact: &Secrets) -> (String, Vec<&'static str>) {
    let mut found: Vec<(Range<usize>, &'static str)> = Vec::new();
    for re in SECRET_VALUES.iter() {
        for c in re.captures_iter(text) {
            if let Some(m) = c.get(1).or_else(|| c.get(2)) {
                found.push((m.range(), PASSWORD_PATTERN));
            }
        }
    }
    for c in URI_PASSWORD.captures_iter(text) {
        found.push((c.get(1).expect("group 1").range(), PASSWORD_PATTERN));
    }
    for re in TOKENS.iter() {
        found.extend(re.find_iter(text).map(|m| (m.range(), KEY_PATTERN)));
    }
    for key in exact.keys.iter().filter(|s| !s.is_empty()) {
        found.extend(
            text.match_indices(key.as_str())
                .map(|(i, s)| (i..i + s.len(), SAVED_KEY)),
        );
    }
    // A password counts only as a whole word: `postgres` is not cut out of `my_postgres`.
    // The edge check applies only where the password's own edge is a word character, so
    // `p@ss!` is still cut out of `p@ss!abc`.
    let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    let bytes = text.as_bytes();
    for secret in exact.passwords.iter().filter(|s| !s.is_empty()) {
        let s = secret.as_bytes();
        let check_start = word(s.first());
        let check_end = word(s.last());
        found.extend(
            text.match_indices(secret.as_str())
                .map(|(i, s)| i..i + s.len())
                .filter(|r| {
                    !(check_start && word(r.start.checked_sub(1).and_then(|p| bytes.get(p))))
                        && !(check_end && word(bytes.get(r.end)))
                })
                .map(|r| (r, SAVED_PASSWORD)),
        );
    }
    found.retain(|(r, _)| !r.is_empty());
    found.sort_by_key(|(r, _)| (r.start, r.end));

    let mut merged: Vec<(Range<usize>, &'static str)> = Vec::new();
    for (r, rule) in found {
        match merged.last_mut() {
            Some((last, _)) if r.start < last.end => last.end = last.end.max(r.end),
            _ => merged.push((r, rule)),
        }
    }
    if merged.is_empty() {
        return (text.to_string(), Vec::new());
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (r, _) in &merged {
        out.push_str(&text[at..r.start]);
        out.push_str(REDACTED);
        at = r.end;
    }
    out.push_str(&text[at..]);
    (out, merged.into_iter().map(|(_, rule)| rule).collect())
}

fn invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}'
        | '\u{2060}'
        | '\u{FEFF}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2066}'..='\u{2069}'
        | '\u{E0000}'..='\u{E007F}'
    ) || (c < ' ' && c != '\t' && c != '\n')
}

/// `text` without invisible characters (R2.2), and how many were removed.
pub fn strip_invisible(text: &str) -> (String, usize) {
    let mut removed = 0;
    let out = text
        .chars()
        .filter(|c| {
            let drop = invisible(*c);
            removed += usize::from(drop);
            !drop
        })
        .collect();
    (out, removed)
}

/// The longest start of `text` that fits in `max_bytes` and ends on a char boundary.
pub fn cap_chars(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn cap_for(kind: ItemKind) -> Option<usize> {
    match kind {
        ItemKind::Question => Some(QUESTION_CAP),
        ItemKind::Sql => Some(SQL_CAP),
        ItemKind::Error => Some(ERROR_CAP),
        // The AI Context stores each saved query capped at 4 KB; this is the outer guard.
        ItemKind::SavedQueries => Some(SQL_CAP),
        ItemKind::Outline => Some(OUTLINE_CAP),
        // Cards hold many tables; each card is capped where it is built.
        _ => None,
    }
}

/// `text` with its values hidden, and how many: numbers, then strings.
fn mask(dialect: DialectKind, kind: ItemKind, text: &str) -> (String, usize, usize) {
    let (text, hidden) = match kind {
        ItemKind::Error => {
            let n = ERROR_KEY.find_iter(text).count();
            let keys = ERROR_KEY.replace_all(text, "Key ($1)=(…)");
            let n = n + PG_ERROR_VALUE.find_iter(&keys).count();
            let values = PG_ERROR_VALUE.replace_all(&keys, "$1\"…\"");
            (values.into_owned(), n)
        }
        _ => (text.to_string(), 0),
    };
    let (numbers, strings) = literal_counts(dialect, &text);
    (mask_literals(dialect, &text), numbers, strings + hidden)
}

/// One row of the Cleaning evidence: where, rule, sent as.
fn cleaned_row(cleaned: &mut Vec<[String; 3]>, place: &str, rule: &str, sent_as: &str) {
    let row = [place.to_string(), rule.to_string(), sent_as.to_string()];
    if !cleaned.contains(&row) {
        cleaned.push(row);
    }
}

pub struct InputRail {
    /// The saved provider keys and every saved Connection password, matched exactly.
    pub secrets: Secrets,
}

impl Rail for InputRail {
    fn name(&self) -> &'static str {
        "input"
    }

    fn run(&self, ask: &mut Ask, log: &mut Log) -> RailOutcome {
        // The per-Ask switches arrive as the Values and Rows items being on.
        let switched = |kind| ask.items.iter().any(|i| i.kind == kind && i.on);
        let switches = Switches {
            rows: switched(ItemKind::Rows),
            values: switched(ItemKind::Values),
        };
        let mask_values = !allowed(ask.access, ItemKind::Values, switches);
        let (access, untied_model) = (ask.access, ask.untied_model);
        // R1.4: an untied Schema Model's DBML goes with no Connection; nothing else does.
        let open =
            |kind| allowed(access, kind, switches) || (untied_model && kind == ItemKind::Dbml);
        // With no Dialect, the MySQL lexer also reads double quotes as strings, so it hides more.
        let dialect = ask.dialect.unwrap_or(DialectKind::MySql);
        let (mut locked, mut masked, mut secrets, mut invisible, mut capped) = (0, 0, 0, 0, 0);

        for item in &mut ask.items {
            if !open(item.kind) {
                if item.on || !item.text.is_empty() {
                    locked += 1;
                }
                item.on = false;
                item.text.clear();
                if item.locked.is_none() {
                    item.locked = lock_reason(ask.access, item.kind, "This Connection");
                }
                continue;
            }
            let (text, n) = strip_invisible(&item.text);
            invisible += n;
            if n > 0 {
                cleaned_row(
                    &mut ask.cleaned,
                    &item.label,
                    "hidden characters",
                    "removed",
                );
            }
            let (mut text, rules) = redact_secrets_by_rule(&text, &self.secrets);
            secrets += rules.len();
            for rule in rules {
                cleaned_row(&mut ask.cleaned, &item.label, rule, REDACTED);
            }
            if mask_values && matches!(item.kind, ItemKind::Sql | ItemKind::Error) {
                let (hidden, numbers, strings) = mask(dialect, item.kind, &text);
                if numbers > 0 {
                    cleaned_row(&mut ask.cleaned, &item.label, "number literal", "?");
                }
                if strings > 0 {
                    cleaned_row(&mut ask.cleaned, &item.label, "string literal", "'…'");
                }
                masked += numbers + strings;
                text = hidden;
            }
            if let Some(cap) = cap_for(item.kind) {
                let cut = cap_chars(&text, cap).len();
                if cut < text.len() {
                    text.truncate(cut);
                    capped += 1;
                }
            }
            item.text = text;
        }

        log.push(
            Level::Info,
            "rail.input",
            &[
                ("masked", masked.to_string()),
                ("secrets", secrets.to_string()),
                ("invisible", invisible.to_string()),
            ],
        );
        if locked + masked + secrets + invisible + capped == 0 {
            RailOutcome::Pass
        } else {
            RailOutcome::Changed(format!(
                "locked={locked} masked={masked} secrets={secrets} invisible={invisible} capped={capped}"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_debug_shows_counts_only() {
        // Final review M6: a stray {:?} must not print a key or a password.
        let s = Secrets {
            keys: vec!["gsk_abcd1234wxyz".into()],
            passwords: vec!["pa55word".into()],
        };
        let shown = format!("{s:?}");
        assert!(!shown.contains("gsk_abcd1234wxyz"), "{shown}");
        assert!(!shown.contains("pa55word"), "{shown}");
        assert!(shown.contains("keys: 1"), "{shown}");
    }
    use crate::ai::log::Log;
    use crate::ai::request::Item;
    use crate::model::DialectKind;

    const ALL_KINDS: [ItemKind; 10] = [
        ItemKind::Question,
        ItemKind::Names,
        ItemKind::Cards,
        ItemKind::Outline,
        ItemKind::Dbml,
        ItemKind::Sql,
        ItemKind::Error,
        ItemKind::SavedQueries,
        ItemKind::Values,
        ItemKind::Rows,
    ];

    fn item(kind: ItemKind, text: &str) -> Item {
        Item {
            kind,
            label: format!("{kind:?}"),
            text: text.into(),
            locked: None,
            on: true,
        }
    }

    fn ask(access: AiAccess, items: Vec<Item>) -> Ask {
        Ask {
            items,
            access,
            dialect: Some(DialectKind::Postgres),
            notes: Vec::new(),
            untied_model: false,
            cleaned: Vec::new(),
        }
    }

    fn rail() -> InputRail {
        InputRail {
            secrets: Secrets::default(),
        }
    }

    #[test]
    fn access_matrix_matches_the_spec() {
        use AiAccess::*;
        use ItemKind::*;
        // Columns: Never, Schema, SchemaQuery, SchemaQueryRows. `S` = only with the switch on.
        #[derive(Clone, Copy)]
        enum C {
            Y,
            N,
            S,
        }
        use C::*;
        let table: [(ItemKind, [C; 4]); 10] = [
            (Question, [Y, Y, Y, Y]),
            (Names, [N, Y, Y, Y]),
            (Cards, [N, Y, Y, Y]),
            (Outline, [N, Y, Y, Y]),
            (Dbml, [N, Y, Y, Y]),
            (Sql, [N, N, Y, Y]),
            (Error, [N, N, Y, Y]),
            (SavedQueries, [N, N, Y, Y]),
            (Values, [N, N, N, S]),
            (Rows, [N, N, N, S]),
        ];
        let levels = [Never, Schema, SchemaQuery, SchemaQueryRows];
        for (kind, row) in table {
            for (level, cell) in levels.iter().zip(row) {
                for on in [false, true] {
                    let switches = Switches {
                        rows: on,
                        values: on,
                    };
                    let want = match cell {
                        Y => true,
                        N => false,
                        S => on,
                    };
                    assert_eq!(
                        allowed(*level, kind, switches),
                        want,
                        "{level:?} {kind:?} switches={on}"
                    );
                }
            }
        }
        // Each switch opens only its own kind.
        let rows_only = Switches {
            rows: true,
            values: false,
        };
        assert!(allowed(SchemaQueryRows, Rows, rows_only));
        assert!(!allowed(SchemaQueryRows, Values, rows_only));
    }

    #[test]
    fn outline_needs_schema() {
        use AiAccess::*;
        let off = Switches::default();
        assert!(!allowed(Never, ItemKind::Outline, off));
        for level in [Schema, SchemaQuery, SchemaQueryRows] {
            assert!(allowed(level, ItemKind::Outline, off), "{level:?}");
        }
        assert_eq!(
            lock_reason(Never, ItemKind::Outline, "shop").as_deref(),
            Some("shop shares nothing with AI")
        );
        assert_eq!(lock_reason(Schema, ItemKind::Outline, "shop"), None);
        assert_eq!(cap_for(ItemKind::Outline), Some(32 * 1024));
    }

    #[test]
    fn lock_reasons_keep_the_sends_wording() {
        use AiAccess::*;
        use ItemKind::*;
        assert_eq!(lock_reason(Never, Question, "shop"), None);
        assert_eq!(
            lock_reason(Never, Names, "shop").as_deref(),
            Some("shop shares nothing with AI")
        );
        assert_eq!(
            lock_reason(Schema, Sql, "shop").as_deref(),
            Some("shop shares schema only")
        );
        assert_eq!(
            lock_reason(Schema, Rows, "shop").as_deref(),
            Some("shop shares schema only")
        );
        assert_eq!(
            lock_reason(SchemaQuery, Rows, "shop").as_deref(),
            Some("Sample rows are off for shop")
        );
        assert_eq!(
            lock_reason(SchemaQuery, Values, "shop").as_deref(),
            Some("Sample rows are off for shop")
        );
        assert_eq!(lock_reason(SchemaQuery, Error, "shop"), None);
        // Saved queries are query text: from Schema and query text up.
        assert_eq!(
            lock_reason(Schema, SavedQueries, "shop").as_deref(),
            Some("shop shares schema only")
        );
        assert_eq!(lock_reason(SchemaQuery, SavedQueries, "shop"), None);
        assert_eq!(lock_reason(SchemaQueryRows, SavedQueries, "shop"), None);
        assert_eq!(
            lock_reason(Never, SavedQueries, "shop").as_deref(),
            Some("shop shares nothing with AI")
        );
        assert_eq!(lock_reason(SchemaQueryRows, Rows, "shop"), None);
        assert_eq!(
            lock_reason(Never, Cards, "").as_deref(),
            Some("No Connection is chosen")
        );
        assert_eq!(lock_reason(Never, Question, ""), None);
    }

    #[test]
    fn unknown_connection_is_question_only() {
        // R1.3: with no Connection the builder uses `Never`.
        let items = ALL_KINDS.iter().map(|k| item(*k, "select 1")).collect();
        let mut a = Ask {
            items,
            access: AiAccess::Never,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            cleaned: Vec::new(),
        };
        let mut log = Log::new();
        rail().run(&mut a, &mut log);
        let sent: Vec<ItemKind> = a
            .items
            .iter()
            .filter(|i| i.on && !i.text.is_empty())
            .map(|i| i.kind)
            .collect();
        assert_eq!(sent, vec![ItemKind::Question]);
        for i in a.items.iter().filter(|i| i.kind != ItemKind::Question) {
            assert!(
                !i.on && i.text.is_empty() && i.locked.is_some(),
                "{:?}",
                i.kind
            );
        }
    }

    fn redacts(input: &str, want: &str) {
        let (out, n) = redact_secrets(input, &Secrets::default());
        assert_eq!(out, want);
        assert_eq!(n, 1, "{input}");
    }

    #[test]
    fn identified_by() {
        redacts(
            "CREATE USER app IDENTIFIED BY 'hunter2';",
            "CREATE USER app IDENTIFIED BY '[redacted]';",
        );
        redacts(
            "alter user app identified with caching_sha2_password by \"s3cr3t\"",
            "alter user app identified with caching_sha2_password by \"[redacted]\"",
        );
    }

    #[test]
    fn password_literal() {
        redacts(
            "CREATE ROLE app WITH LOGIN PASSWORD 'pw1'",
            "CREATE ROLE app WITH LOGIN PASSWORD '[redacted]'",
        );
        redacts(
            "ALTER ROLE app ENCRYPTED PASSWORD 'md5abc'",
            "ALTER ROLE app ENCRYPTED PASSWORD '[redacted]'",
        );
        redacts(
            "SET PASSWORD FOR 'app'@'%' = 'n3w'",
            "SET PASSWORD FOR 'app'@'%' = '[redacted]'",
        );
    }

    #[test]
    fn uri_with_password() {
        redacts(
            "url postgres://admin:Pa55w0rd@db.local:5432/shop here",
            "url postgres://admin:[redacted]@db.local:5432/shop here",
        );
        let (out, n) = redact_secrets(
            "see https://example.com/a:b and mysql://u@h/db",
            &Secrets::default(),
        );
        assert_eq!(n, 0);
        assert_eq!(out, "see https://example.com/a:b and mysql://u@h/db");
    }

    #[test]
    fn identified_by_doubled_quote() {
        redacts(
            "CREATE USER app IDENTIFIED BY 'it''s secret';",
            "CREATE USER app IDENTIFIED BY '[redacted]';",
        );
        redacts(
            "CREATE USER app IDENTIFIED BY \"say \"\"hi\"\" now\";",
            "CREATE USER app IDENTIFIED BY \"[redacted]\";",
        );
        redacts(
            "ALTER ROLE app PASSWORD 'a''b'",
            "ALTER ROLE app PASSWORD '[redacted]'",
        );
        redacts("password='a''b' x", "password='[redacted]' x");
    }

    #[test]
    fn uri_password_with_at_sign() {
        redacts(
            "mysql://root:p@ss@db.local:3306/app",
            "mysql://root:[redacted]@db.local:3306/app",
        );
        // The password stops at the authority: an `@` after a `/` or a space is not part of it.
        redacts(
            "'postgres://u:pw@h/db?x=@y' and me@home",
            "'postgres://u:[redacted]@h/db?x=@y' and me@home",
        );
    }

    #[test]
    fn sk_key() {
        redacts("key=sk-proj-abcDEF1234567890xyz end", "key=[redacted] end");
    }

    #[test]
    fn sk_ant_key() {
        redacts(
            "Bearer sk-ant-api03-AbC_dEf-1234567890",
            "Bearer [redacted]",
        );
    }

    #[test]
    fn aws_akia_and_asia() {
        let (out, n) = redact_secrets(
            "a AKIAABCDEFGHIJKLMNOP b ASIAQRSTUVWXYZ234567 c",
            &Secrets::default(),
        );
        assert_eq!(out, "a [redacted] b [redacted] c");
        assert_eq!(n, 2);
    }

    #[test]
    fn jwt_three_parts() {
        redacts(
            "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_Nature-123 ok",
            "token [redacted] ok",
        );
        // A qualified column name is not a token.
        let (out, n) = redact_secrets("select public.orders.id", &Secrets::default());
        assert_eq!((out.as_str(), n), ("select public.orders.id", 0));
    }

    #[test]
    fn pem_private_key_block() {
        redacts(
            "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----\nafter",
            "before\n[redacted]\nafter",
        );
    }

    #[test]
    fn ghp_token() {
        redacts(
            "git ghp_abcdefghijklmnopqrstuvwxyz0123456789 x",
            "git [redacted] x",
        );
    }

    #[test]
    fn slack_xoxb() {
        redacts(
            "slack xoxb-1234567890-abcdefghij and",
            "slack [redacted] and",
        );
    }

    #[test]
    fn exact_saved_secret() {
        let (out, n) = redact_secrets(
            "pw is correct-horse; again correct-horse.",
            &passwords(&["correct-horse", ""]),
        );
        assert_eq!(out, "pw is [redacted]; again [redacted].");
        assert_eq!(n, 2);
    }

    #[test]
    fn exact_secret_needs_word_edges() {
        let secret = passwords(&["postgres"]);
        let (out, n) = redact_secrets("pw is postgres.", &secret);
        assert_eq!(out, "pw is [redacted].");
        assert_eq!(n, 1);
        for text in ["select * from postgres_users", "drop my_postgres"] {
            assert_eq!(redact_secrets(text, &secret), (text.to_string(), 0));
        }
        let (out, n) = redact_secrets("postgres", &secret);
        assert_eq!((out.as_str(), n), ("[redacted]", 1));
    }

    #[test]
    fn exact_secret_with_punctuation_edge_still_redacted() {
        let secret = passwords(&["p@ss!"]);
        let (out, n) = redact_secrets("key p@ss!abc here", &secret);
        assert_eq!((out.as_str(), n), ("key [redacted]abc here", 1));
        let secret = passwords(&["!pw"]);
        let (out, n) = redact_secrets("x!pw", &secret);
        assert_eq!((out.as_str(), n), ("x[redacted]", 1));
        let secret = passwords(&["pw!"]);
        assert_eq!(redact_secrets("mypw!", &secret), ("mypw!".to_string(), 0));
    }

    fn passwords(list: &[&str]) -> Secrets {
        Secrets {
            passwords: list.iter().map(|s| s.to_string()).collect(),
            ..Secrets::default()
        }
    }

    #[test]
    fn key_edges_only_for_passwords() {
        // A key is cut out wherever it appears, even inside a word.
        let keys = Secrets {
            keys: vec!["zq9Kf2Lw7Rt".into()],
            ..Secrets::default()
        };
        let (out, n) = redact_secrets("id xzq9Kf2Lw7Rt_tail and zq9Kf2Lw7Rt", &keys);
        assert_eq!((out.as_str(), n), ("id x[redacted]_tail and [redacted]", 2));
        // The same text as a password keeps its word edges.
        let pw = passwords(&["zq9Kf2Lw7Rt"]);
        let (out, n) = redact_secrets("id xzq9Kf2Lw7Rt_tail and zq9Kf2Lw7Rt", &pw);
        assert_eq!(
            (out.as_str(), n),
            ("id xzq9Kf2Lw7Rt_tail and [redacted]", 1)
        );
    }

    #[test]
    fn invisible_characters_removed() {
        let input =
            "a\u{200B}b\u{FEFF}c\u{202E}d\u{2066}e\u{E0041}f\u{0007}g\th\ni\u{200F}\u{2060}";
        let (out, n) = strip_invisible(input);
        assert_eq!(out, "abcdefg\th\ni");
        assert_eq!(n, 8);
    }

    #[test]
    fn values_masked_below_rows() {
        let sql = "select * from t where name = 'Ann' and id = 42";
        let mut a = ask(AiAccess::SchemaQuery, vec![item(ItemKind::Sql, sql)]);
        let mut log = Log::new();
        rail().run(&mut a, &mut log);
        assert_eq!(
            a.items[0].text,
            "select * from t where name = '…' and id = ?"
        );
        let line = log.lines.last().unwrap();
        assert_eq!(line.source, "rail.input");
        assert_eq!(
            line.fields,
            vec![
                ("masked".into(), "2".into()),
                ("secrets".into(), "0".into()),
                ("invisible".into(), "0".into())
            ]
        );

        let mut values = item(ItemKind::Values, "");
        values.on = true;
        let mut a = ask(
            AiAccess::SchemaQueryRows,
            vec![item(ItemKind::Sql, sql), values],
        );
        rail().run(&mut a, &mut Log::new());
        assert_eq!(a.items[0].text, sql);

        // At the rows level with the switch off, values are still masked.
        let mut values = item(ItemKind::Values, "");
        values.on = false;
        let mut a = ask(
            AiAccess::SchemaQueryRows,
            vec![item(ItemKind::Sql, sql), values],
        );
        rail().run(&mut a, &mut Log::new());
        assert_eq!(
            a.items[0].text,
            "select * from t where name = '…' and id = ?"
        );
    }

    #[test]
    fn error_text_hides_key_values() {
        let err = "duplicate key value violates unique constraint \"u\" DETAIL: Key (email)=(ann@x.io) already exists.";
        let mut a = ask(AiAccess::SchemaQuery, vec![item(ItemKind::Error, err)]);
        rail().run(&mut a, &mut Log::new());
        assert_eq!(
            a.items[0].text,
            "duplicate key value violates unique constraint \"u\" DETAIL: Key (email)=(…) already exists."
        );
    }

    #[test]
    fn pg_invalid_input_value_is_masked() {
        let cases = [
            (
                "invalid input syntax for type integer: \"4711x\"",
                "invalid input syntax for type integer: \"…\"",
            ),
            (
                "ERROR: invalid input value for enum mood: \"happyy\"",
                "ERROR: invalid input value for enum mood: \"…\"",
            ),
            (
                "invalid input syntax for type uuid: \"ann\"x\"
LINE 1: select 1",
                "invalid input syntax for type uuid: \"…\"
LINE ?: select ?",
            ),
            (
                "date/time field value out of range: \"2024-13-01\"",
                "date/time field value out of range: \"…\"",
            ),
            (
                "malformed array literal: \"{1,2\"",
                "malformed array literal: \"…\"",
            ),
            // Names in errors are useful and allowed: they stay.
            (
                "relation \"orders\" does not exist",
                "relation \"orders\" does not exist",
            ),
            (
                "column \"totl\" of relation \"orders\" does not exist",
                "column \"totl\" of relation \"orders\" does not exist",
            ),
        ];
        for (err, want) in cases {
            let mut a = ask(AiAccess::SchemaQuery, vec![item(ItemKind::Error, err)]);
            rail().run(&mut a, &mut Log::new());
            assert_eq!(a.items[0].text, want, "{err}");
        }

        // With values allowed, the error goes as it is.
        let err = "invalid input syntax for type integer: \"4711x\"";
        let mut a = ask(
            AiAccess::SchemaQueryRows,
            vec![item(ItemKind::Error, err), item(ItemKind::Values, "")],
        );
        rail().run(&mut a, &mut Log::new());
        assert_eq!(a.items[0].text, err);
    }

    #[test]
    fn rail_redacts_and_strips_at_every_level() {
        let mut r = rail();
        r.secrets = passwords(&["topsecret"]);
        let mut a = ask(
            AiAccess::Schema,
            vec![item(ItemKind::Question, "why\u{200B} topsecret fails")],
        );
        let mut log = Log::new();
        let out = r.run(&mut a, &mut log);
        assert!(matches!(out, RailOutcome::Changed(_)));
        assert_eq!(a.items[0].text, "why [redacted] fails");
        assert_eq!(
            log.lines.last().unwrap().fields,
            vec![
                ("masked".into(), "0".into()),
                ("secrets".into(), "1".into()),
                ("invisible".into(), "1".into())
            ]
        );
    }

    #[test]
    fn caps_cut_on_char_boundaries() {
        let unit = "日本語のテキスト🙂🎉 ";
        let mut sql = String::from("select '");
        while sql.len() < 70 * 1024 {
            sql.push_str(unit);
        }
        sql.push('\'');
        for max in [64 * 1024, 64 * 1024 - 1, 64 * 1024 - 2, 64 * 1024 - 3] {
            let cut = cap_chars(&sql, max);
            assert!(cut.len() <= max);
            assert!(sql.is_char_boundary(cut.len()));
            assert!(max - cut.len() < 4);
        }
        assert_eq!(cap_chars("short", 64), "short");

        // Through the rail, with values allowed so the text is not masked.
        let mut a = ask(
            AiAccess::SchemaQueryRows,
            vec![item(ItemKind::Sql, &sql), item(ItemKind::Values, "")],
        );
        let out = rail().run(&mut a, &mut Log::new());
        assert!(matches!(out, RailOutcome::Changed(_)));
        let text = &a.items[0].text;
        assert!(text.len() <= 64 * 1024);
        assert!(sql.starts_with(text.as_str()));
    }
}
