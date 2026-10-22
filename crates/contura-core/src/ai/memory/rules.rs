//! When a Topic breaks, Topic titles and the summary a Topic gets without a model.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::ai::{AiMessage, AiRole, AiThread};
use crate::model::ConnectionId;

/// A thread idle for longer than this starts a new Topic.
pub const IDLE_MS: i64 = 30 * 60_000;
/// Whole turns of the open Topic an Ask may carry.
pub const RECENT_TURNS: usize = 8;
/// Earlier Topics whose summaries an Ask may carry.
pub const EARLIER_TOPICS: usize = 2;
pub const SUMMARY_CHARS: usize = 400;
pub const TITLE_CHARS: usize = 40;

const ASKED_CHARS: usize = 120;
const ANSWER_CHARS: usize = 80;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BreakReason {
    First,
    /// Another Connection or database.
    Place,
    Idle,
    Subject,
}

/// What an Ask says about itself, as far as Topics go.
#[derive(Clone, Copy, Debug)]
pub struct AskFacts<'a> {
    pub connection_id: Option<ConnectionId>,
    pub database: Option<&'a str>,
    pub action: &'a str,
    /// The tables the Ask sends in full, else its focus table names.
    pub tables: &'a [String],
    pub now_ms: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPick {
    pub seq: u32,
    pub opened: bool,
    pub reason: Option<BreakReason>,
    pub title: String,
    /// The Topic this Ask closes, when it opens a new one.
    pub closing: Option<u32>,
}

/// The Topic an Ask belongs to: the open one, or a new one when a break rule fires.
pub fn topic_for(thread: Option<&AiThread>, ask: &AskFacts, question: &str) -> TopicPick {
    let first = || TopicPick {
        seq: 1,
        opened: true,
        reason: Some(BreakReason::First),
        title: topic_title(question),
        closing: None,
    };
    let Some(thread) = thread else {
        return first();
    };
    let Some(open) = thread.messages.iter().filter_map(|m| m.topic).max() else {
        return first();
    };
    let msgs: Vec<&AiMessage> = thread
        .messages
        .iter()
        .filter(|m| m.topic == Some(open))
        .collect();
    let head = msgs[0];
    let title = msgs
        .iter()
        .find(|m| m.role == AiRole::User)
        .map(|m| topic_title(&m.text))
        .unwrap_or_default();

    let place = head.connection_id != ask.connection_id
        || head.database.as_deref() != ask.database
        || msgs
            .iter()
            .any(|m| m.connection_id != ask.connection_id || m.database.as_deref() != ask.database);
    let last_at = msgs.iter().map(|m| m.at).max().unwrap_or(0);
    let reason = if place {
        Some(BreakReason::Place)
    } else if ask.now_ms - last_at > IDLE_MS {
        Some(BreakReason::Idle)
    } else if subject_changed(&msgs, ask) {
        Some(BreakReason::Subject)
    } else {
        None
    };
    match reason {
        Some(reason) => TopicPick {
            seq: open + 1,
            opened: true,
            reason: Some(reason),
            title: topic_title(question),
            closing: Some(open),
        },
        None => TopicPick {
            seq: open,
            opened: false,
            reason: None,
            title,
            closing: None,
        },
    }
}

fn subject_changed(open: &[&AiMessage], ask: &AskFacts) -> bool {
    if ask.action == "continue" || ask.tables.is_empty() {
        return false;
    }
    let tables: BTreeSet<&str> = open
        .iter()
        .flat_map(|m| m.tables.iter().map(String::as_str))
        .collect();
    if tables.is_empty() || ask.tables.iter().any(|t| tables.contains(t.as_str())) {
        return false;
    }
    !open.iter().any(|m| m.action.as_deref() == Some(ask.action))
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cut_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// A Topic's title from its first question: whitespace collapsed, at most 40 characters
/// cut at the last space when there is one, `…` added when cut.
pub fn topic_title(question: &str) -> String {
    let text = collapse(question);
    if text.chars().count() <= TITLE_CHARS {
        return text;
    }
    let head = cut_chars(&text, TITLE_CHARS);
    let clean_cut = text[head.len()..].starts_with(' ');
    let head = match head.rfind(' ') {
        Some(i) if !clean_cut => head[..i].to_string(),
        _ => head,
    };
    format!("{}…", head.trim_end())
}

/// The summary a closed Topic gets without a model. The same messages give the same text.
pub fn rule_summary(messages: &[&AiMessage]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(q) = messages.iter().find(|m| m.role == AiRole::User) {
        let q = cut_chars(&collapse(&q.text), ASKED_CHARS);
        if !q.is_empty() {
            parts.push(format!("Asked: {q}"));
        }
    }
    let mut actions: Vec<&str> = Vec::new();
    for a in messages.iter().filter_map(|m| m.action.as_deref()) {
        if !a.is_empty() && !actions.contains(&a) {
            actions.push(a);
        }
    }
    if !actions.is_empty() {
        parts.push(format!("Actions: {}", actions.join(", ")));
    }
    let tables: BTreeSet<&str> = messages
        .iter()
        .flat_map(|m| m.tables.iter().map(String::as_str))
        .collect();
    if !tables.is_empty() {
        parts.push(format!(
            "Tables: {}",
            tables.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    let answers: Vec<String> = messages
        .iter()
        .filter(|m| m.role == AiRole::Assistant)
        .filter_map(|m| m.text.lines().map(str::trim).find(|l| !l.is_empty()))
        .map(|l| cut_chars(l, ANSWER_CHARS))
        .collect();
    if !answers.is_empty() {
        parts.push(format!("Answers: {}", answers.join(" / ")));
    }
    if parts.is_empty() {
        return String::new();
    }
    cut_chars(&format!("{}.", parts.join(". ")), SUMMARY_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::request::ItemKind;
    use uuid::Uuid;

    fn conn(n: u128) -> Option<ConnectionId> {
        Some(Uuid::from_u128(n))
    }

    fn msg(
        role: AiRole,
        text: &str,
        at: i64,
        seq: u32,
        tables: &[&str],
        action: &str,
    ) -> AiMessage {
        AiMessage {
            role,
            text: text.into(),
            context: Vec::new(),
            at,
            record: None,
            topic: Some(seq),
            connection_id: conn(7),
            database: Some("shop".into()),
            kinds: vec![ItemKind::Question],
            tables: tables.iter().map(|t| t.to_string()).collect(),
            action: Some(action.into()),
        }
    }

    fn thread(messages: Vec<AiMessage>) -> AiThread {
        AiThread {
            id: Uuid::new_v4(),
            place: "ungrouped".into(),
            title: "t".into(),
            messages,
            updated_at: 1,
        }
    }

    /// One turn of Topic 1 at 1,000 on `invoices` with the action `explain`.
    fn base() -> AiThread {
        thread(vec![
            msg(
                AiRole::User,
                "why so slow",
                1_000,
                1,
                &["invoices"],
                "explain",
            ),
            msg(
                AiRole::Assistant,
                "an index is missing",
                1_001,
                1,
                &["invoices"],
                "explain",
            ),
        ])
    }

    fn facts<'a>(tables: &'a [String], action: &'a str, now_ms: i64) -> AskFacts<'a> {
        AskFacts {
            connection_id: conn(7),
            database: Some("shop"),
            action,
            tables,
            now_ms,
        }
    }

    #[test]
    fn first_ask_opens_topic_1() {
        let t = [];
        let ask = facts(&t, "ask", 5);
        for thread in [None, Some(&thread(Vec::new()))] {
            let p = topic_for(thread, &ask, "How many orders?");
            assert_eq!(
                (p.seq, p.opened, p.reason, p.closing),
                (1, true, Some(BreakReason::First), None)
            );
            assert_eq!(p.title, "How many orders?");
        }
        // Messages with no stamp are no Topic.
        let mut old = base();
        for m in &mut old.messages {
            m.topic = None;
        }
        assert_eq!(topic_for(Some(&old), &ask, "q").seq, 1);
    }

    #[test]
    fn place_change_breaks() {
        let th = base();
        let t = [];
        let mut ask = facts(&t, "ask", 2_000);
        let p = topic_for(Some(&th), &ask, "q");
        assert_eq!((p.seq, p.opened, p.closing), (1, false, None));
        assert_eq!(p.title, "why so slow");
        ask.connection_id = conn(8);
        let p = topic_for(Some(&th), &ask, "q");
        assert_eq!(
            (p.seq, p.reason, p.closing),
            (2, Some(BreakReason::Place), Some(1))
        );
        let mut ask = facts(&t, "ask", 2_000);
        ask.database = Some("crm");
        let p = topic_for(Some(&th), &ask, "q");
        assert_eq!(
            (p.seq, p.reason, p.closing),
            (2, Some(BreakReason::Place), Some(1))
        );
        ask.database = None;
        assert_eq!(
            topic_for(Some(&th), &ask, "q").reason,
            Some(BreakReason::Place)
        );
    }

    #[test]
    fn idle_breaks_after_30_minutes() {
        let th = base();
        let t = [];
        let stay = facts(&t, "ask", 1_001 + IDLE_MS);
        assert!(!topic_for(Some(&th), &stay, "q").opened, "30m00s stays");
        let stay = facts(&t, "ask", 1_001 + 29 * 60_000 + 59_000);
        assert!(!topic_for(Some(&th), &stay, "q").opened);
        let brk = facts(&t, "ask", 1_001 + 30 * 60_000 + 1_000);
        let p = topic_for(Some(&th), &brk, "q");
        assert_eq!(
            (p.seq, p.reason, p.closing),
            (2, Some(BreakReason::Idle), Some(1))
        );
    }

    #[test]
    fn subject_breaks_only_without_overlap_and_new_action() {
        let th = base();
        let other = ["shipments".to_string()];
        let p = topic_for(Some(&th), &facts(&other, "ask", 2_000), "q");
        assert_eq!((p.seq, p.reason), (2, Some(BreakReason::Subject)));
        let same = ["shipments".to_string(), "invoices".to_string()];
        assert!(
            !topic_for(Some(&th), &facts(&same, "ask", 2_000), "q").opened,
            "overlap"
        );
        assert!(
            !topic_for(Some(&th), &facts(&other, "explain", 2_000), "q").opened,
            "same action"
        );
        assert!(
            !topic_for(Some(&th), &facts(&[], "ask", 2_000), "q").opened,
            "no ask tables"
        );
        let mut bare = base();
        for m in &mut bare.messages {
            m.tables.clear();
        }
        assert!(
            !topic_for(Some(&bare), &facts(&other, "ask", 2_000), "q").opened,
            "no topic tables"
        );
    }

    #[test]
    fn continue_never_breaks_by_subject() {
        let th = base();
        let other = ["shipments".to_string()];
        assert!(!topic_for(Some(&th), &facts(&other, "continue", 2_000), "q").opened);
    }

    #[test]
    fn title_cases() {
        let long = "How many invoices were paid late last quarter by region";
        assert!(long.chars().count() >= 50);
        assert_eq!(topic_title(long), "How many invoices were paid late last…");
        let thirty = "a".repeat(30);
        assert_eq!(topic_title(&thirty), thirty);
        assert_eq!(topic_title("  list\n the\t\n tables  "), "list the tables");
        // No space to cut at.
        assert_eq!(topic_title(&"x".repeat(60)), format!("{}…", "x".repeat(40)));
        // A space right at the limit keeps the whole of the first 40.
        let edge = format!("{} tail", "y".repeat(40));
        assert_eq!(topic_title(&edge), format!("{}…", "y".repeat(40)));
    }

    #[test]
    fn rule_summary_cases() {
        let a = msg(
            AiRole::User,
            "How many invoices\nwere paid late?",
            1,
            1,
            &["payments"],
            "ask",
        );
        let b = msg(
            AiRole::Assistant,
            "\n  About 12 percent.\nSecond line",
            2,
            1,
            &["payments", "invoices"],
            "ask",
        );
        let c = msg(AiRole::User, "and by month", 3, 1, &["invoices"], "explain");
        let d = msg(AiRole::Assistant, "Table by month", 4, 1, &[], "explain");
        let all = [&a, &b, &c, &d];
        let text = rule_summary(&all);
        assert_eq!(
            text,
            "Asked: How many invoices were paid late?. Actions: ask, explain. \
             Tables: invoices, payments. Answers: About 12 percent. / Table by month."
        );
        assert_eq!(text, rule_summary(&all), "deterministic");
        // Parts left out when empty.
        let bare = AiMessage {
            action: None,
            tables: Vec::new(),
            ..a.clone()
        };
        assert_eq!(
            rule_summary(&[&bare]),
            "Asked: How many invoices were paid late?."
        );
        // Capped at 400.
        let long = "z".repeat(100);
        let answers: Vec<AiMessage> = (0..10)
            .map(|i| msg(AiRole::Assistant, &long, i, 1, &[], "ask"))
            .collect();
        let refs: Vec<&AiMessage> = answers.iter().collect();
        assert_eq!(rule_summary(&refs).chars().count(), SUMMARY_CHARS);
        assert_eq!(rule_summary(&[]), "");
    }
}
