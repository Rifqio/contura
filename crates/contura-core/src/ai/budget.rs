//! Token budget: estimates, the per-model shares and fitting table cards with demote before drop.

use serde::Serialize;

use crate::ai::rails::cap_chars;

/// R1.5 payload cap in bytes.
pub const PAYLOAD_CAP: usize = 200 * 1024;

/// Bytes / 3.5 for SQL and schema text, bytes / 4 for prose, rounded up.
pub fn estimate_tokens(text: &str, prose: bool) -> u32 {
    let bytes = text.len() as u64;
    let tokens = if prose {
        bytes.div_ceil(4)
    } else {
        (bytes * 2).div_ceil(7)
    };
    u32::try_from(tokens).unwrap_or(u32::MAX)
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub total: u32,
    pub schema: u32,
    pub query: u32,
    pub rows: u32,
    pub history: u32,
}

/// `min(window x 0.6 - max_tokens, 200 KB as tokens)`. History and query get 20% each,
/// rows 10%, schema the rest; each share is a maximum.
pub fn budget(window: u32, max_tokens: u32) -> Budget {
    let cap = (PAYLOAD_CAP as u64 * 2 / 7) as u32;
    let total = ((window as u64 * 3 / 5) as u32)
        .saturating_sub(max_tokens)
        .min(cap);
    let history = total / 5;
    let query = total / 5;
    let rows = total / 10;
    Budget {
        total,
        schema: total - history - query - rows,
        query,
        rows,
        history,
    }
}

/// Why a table is full, names only or left out: the Steps evidence.
pub const NAMED: &str = "named in the question or editor";
pub const WHOLE_FITS: &str = "whole schema fits";
pub const NAMES_ONLY: &str = "names only: over the budget";
pub const LEFT_OUT: &str = "left out: over the budget";
/// A table kept in full once the 200 KB cap cut other tables: the whole schema no longer went.
pub const FULL_BEFORE_CUT: &str = "in full: before the 200 KB cut";
/// Tier 2 reasons, in the order a table can get them; the first one it gets is kept.
pub const OPEN_TAB: &str = "open tab";
pub const NAME_MATCH: &str = "name match";
pub const WORD_MATCH: &str = "word match";
pub const ONE_KEY: &str = "one key away";
pub const TWO_KEYS: &str = "two keys away";
/// Tier 3 reasons: a table the outline step picked, and one that sits in a picked Area.
pub const OUTLINE_PICK: &str = "outline pick";
pub const IN_PICKED_AREA: &str = "in a picked area";

/// The evidence of a rule that is only the fit's outcome: how the table was sent.
pub const SENT_FULL: &str = "full card";
pub const SENT_NAME: &str = "name only";
pub const SENT_NONE: &str = "not sent";

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableFit {
    pub full: Vec<String>,
    pub names_only: Vec<String>,
    pub left_out: Vec<String>,
    /// (table, rule, evidence) for every table offered, in the order offered.
    pub reasons: Vec<(String, String, String)>,
}

impl TableFit {
    /// Moves `names` to left out, with the left out rule. Once any table is cut, the rest
    /// no longer went as "whole schema fits".
    pub fn leave_out(&mut self, names: &[String]) {
        for (table, rule, evidence) in &mut self.reasons {
            if names.contains(table) {
                *rule = LEFT_OUT.to_string();
                *evidence = SENT_NONE.to_string();
            } else if !names.is_empty() && rule == WHOLE_FITS {
                *rule = FULL_BEFORE_CUT.to_string();
            }
        }
    }
}

/// Tier 1 with demote before drop. `cards` holds the `focus` tables first. When every card
/// fits the share, all go in full. Otherwise the focus cards go in full while they fit and
/// every other table is demoted: a names-only line while those fit, then left out. The
/// share is checked against the sum of the lines' estimates; the newlines between them are
/// not counted.
pub fn fit_cards(
    cards: &[(String, String)],
    focus: usize,
    schema_tokens: u32,
) -> (String, TableFit) {
    let mut fit = TableFit::default();
    let whole: u64 = cards
        .iter()
        .map(|(_, c)| u64::from(estimate_tokens(c, false)))
        .sum();
    if whole <= u64::from(schema_tokens) {
        for (i, (name, _)) in cards.iter().enumerate() {
            fit.full.push(name.clone());
            let rule = if i < focus { NAMED } else { WHOLE_FITS };
            fit.reasons
                .push((name.clone(), rule.to_string(), SENT_FULL.to_string()));
        }
        let lines: Vec<&str> = cards.iter().map(|(_, c)| c.as_str()).collect();
        return (lines.join("\n"), fit);
    }
    let mut lines: Vec<&str> = Vec::new();
    let mut used = 0u32;
    let mut rest = cards.iter();
    for (name, card) in rest.by_ref().take(focus) {
        let cost = estimate_tokens(card, false);
        if used.saturating_add(cost) > schema_tokens {
            demote(name, &mut used, schema_tokens, &mut lines, &mut fit);
            break;
        }
        used += cost;
        lines.push(card);
        fit.full.push(name.clone());
        fit.reasons
            .push((name.clone(), NAMED.to_string(), SENT_FULL.to_string()));
    }
    for (name, _) in rest {
        demote(name, &mut used, schema_tokens, &mut lines, &mut fit);
    }
    (lines.join("\n"), fit)
}

/// A names-only line when it still fits, else left out. Once one is left out, the rest
/// are too, so the names-only lines stay a prefix of the demoted tables.
fn demote<'a>(
    name: &'a str,
    used: &mut u32,
    schema_tokens: u32,
    lines: &mut Vec<&'a str>,
    fit: &mut TableFit,
) {
    let cost = estimate_tokens(name, false);
    if fit.left_out.is_empty() && used.saturating_add(cost) <= schema_tokens {
        *used += cost;
        lines.push(name);
        fit.names_only.push(name.to_string());
        fit.reasons.push((
            name.to_string(),
            NAMES_ONLY.to_string(),
            SENT_NAME.to_string(),
        ));
    } else {
        fit.left_out.push(name.to_string());
        fit.reasons.push((
            name.to_string(),
            LEFT_OUT.to_string(),
            SENT_NONE.to_string(),
        ));
    }
}

/// R1.5: the built payload, cut to 200 KB on a char boundary.
pub fn cap_payload(text: &str) -> &str {
    cap_chars(text, PAYLOAD_CAP)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A card of exactly `tokens` schema tokens.
    fn card_of(name: &str, tokens: u32) -> (String, String) {
        let bytes = (tokens as usize * 7) / 2;
        (name.to_string(), "x".repeat(bytes))
    }

    #[test]
    fn estimate_rounds_up() {
        assert_eq!(estimate_tokens("", false), 0);
        assert_eq!(estimate_tokens("abcdefg", false), 2);
        assert_eq!(estimate_tokens("abcdefgh", false), 3);
        assert_eq!(estimate_tokens("abcd", true), 1);
        assert_eq!(estimate_tokens("abcde", true), 2);
    }

    #[test]
    fn budget_formula() {
        let b = budget(200_000, 4_096);
        assert_eq!(b.total, 58_514);
        assert_eq!(b.history, 11_702);
        assert_eq!(b.query, 11_702);
        assert_eq!(b.rows, 5_851);
        assert_eq!(b.schema, 58_514 - 11_702 - 11_702 - 5_851);
    }

    #[test]
    fn small_window_budget() {
        assert_eq!(budget(8_000, 1_024).total, 3_776);
        // max_tokens over the window leaves nothing rather than wrapping.
        assert_eq!(budget(1_000, 4_096).total, 0);
    }

    #[test]
    fn fit_demotes_before_dropping() {
        let cards = vec![card_of("a", 400), card_of("b", 400), card_of("c", 400)];
        assert_eq!(estimate_tokens(&cards[0].1, false), 400);

        let (text, fit) = fit_cards(&cards, 3, 900);
        assert_eq!(fit.full, ["a", "b"]);
        assert_eq!(fit.names_only, ["c"]);
        assert!(fit.left_out.is_empty());
        assert_eq!(text, format!("{}\n{}\nc", cards[0].1, cards[1].1));

        let (text, fit) = fit_cards(&cards, 3, 800);
        assert_eq!(fit.full, ["a", "b"]);
        assert!(fit.names_only.is_empty());
        assert_eq!(fit.left_out, ["c"]);
        assert_eq!(text, format!("{}\n{}", cards[0].1, cards[1].1));
    }

    #[test]
    fn whole_schema_fits_or_only_focus_stays_full() {
        let cards = vec![card_of("a", 100), card_of("b", 100), card_of("c", 100)];
        let (text, fit) = fit_cards(&cards, 1, 300);
        assert_eq!(fit.full, ["a", "b", "c"]);
        assert_eq!(text.lines().count(), 3);
        let rules: Vec<&str> = fit.reasons.iter().map(|(_, r, _)| r.as_str()).collect();
        assert_eq!(rules, [NAMED, WHOLE_FITS, WHOLE_FITS]);

        // One token short: b would still fit in full, but tier 1 demotes every other table.
        let (text, fit) = fit_cards(&cards, 1, 299);
        assert_eq!(fit.full, ["a"]);
        assert_eq!(fit.names_only, ["b", "c"]);
        assert_eq!(text, format!("{}\nb\nc", cards[0].1));
        let rules: Vec<&str> = fit.reasons.iter().map(|(_, r, _)| r.as_str()).collect();
        assert_eq!(rules, [NAMED, NAMES_ONLY, NAMES_ONLY]);

        let (_, mut fit) = fit_cards(&cards, 0, 101);
        assert_eq!(fit.names_only, ["a", "b", "c"]);
        fit.leave_out(&["c".to_string()]);
        let reason = |t: &str, r: &str, e: &str| (t.to_string(), r.to_string(), e.to_string());
        assert_eq!(fit.reasons[2], reason("c", LEFT_OUT, SENT_NONE));
        assert_eq!(fit.reasons[1], reason("b", NAMES_ONLY, SENT_NAME));
    }

    #[test]
    fn two_thousand_cards_demote_within_budget_fast() {
        let cards: Vec<(String, String)> = (0..2_000)
            .map(|i| {
                let name = format!("table_{i:04}");
                let cols: Vec<String> = (0..12).map(|c| format!("column_{c} bigint")).collect();
                let card = format!("{name}({})", cols.join(", "));
                (name, card)
            })
            .collect();
        let share = budget(200_000, 4_096).schema;

        let started = std::time::Instant::now();
        let (text, fit) = fit_cards(&cards, 2_000, share);
        let took = started.elapsed();

        assert!(took.as_millis() < 500, "took {took:?}");
        let used: u32 = text.lines().map(|l| estimate_tokens(l, false)).sum();
        assert!(used <= share, "{used} over {share}");
        assert!(!fit.full.is_empty());
        assert!(!fit.names_only.is_empty());
        assert_eq!(
            fit.full.len() + fit.names_only.len() + fit.left_out.len(),
            2_000
        );
    }

    #[test]
    fn payload_capped_on_a_char_boundary() {
        let small = "select 1";
        assert_eq!(cap_payload(small), small);
        let big = "é".repeat(PAYLOAD_CAP);
        let capped = cap_payload(&big);
        assert_eq!(capped.len(), PAYLOAD_CAP);
        let odd = format!("a{big}");
        assert_eq!(cap_payload(&odd).len(), PAYLOAD_CAP - 1);
    }
}
