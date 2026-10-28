//! The open Topic, Topic titles and the summary a Topic gets without a model.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::ai::{AiMessage, AiRole, AiThread};
use crate::model::ConnectionId;

/// Whole turns of the open Topic an Ask may carry.
pub const RECENT_TURNS: usize = 8;
/// Earlier Topics whose summaries an Ask may carry.
pub const EARLIER_TOPICS: usize = 2;
pub const SUMMARY_CHARS: usize = 400;
pub const TITLE_CHARS: usize = 40;

const ASKED_CHARS: usize = 120;
const ANSWER_CHARS: usize = 80;

/// Why an Ask opened a Topic: only a thread's first Ask does (one conversation per desktop,
/// ruling of 27 Oct).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BreakReason {
    First,
}

/// What an Ask says about itself, for the gate on history.
#[derive(Clone, Copy, Debug)]
pub struct AskFacts<'a> {
    pub connection_id: Option<ConnectionId>,
    pub database: Option<&'a str>,
    /// The tables the Ask sends in full, else its focus table names.
    pub tables: &'a [String],
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPick {
    pub seq: u32,
    pub opened: bool,
    pub reason: Option<BreakReason>,
    pub title: String,
}

/// The Topic an Ask belongs to: the thread's highest stamped Topic, which stays open, or
/// Topic 1 for a thread with none. No Ask ever closes a Topic.
pub fn topic_for(thread: Option<&AiThread>, question: &str) -> TopicPick {
    let open = thread.and_then(|t| t.messages.iter().filter_map(|m| m.topic).max());
    let (Some(thread), Some(open)) = (thread, open) else {
        return TopicPick {
            seq: 1,
            opened: true,
            reason: Some(BreakReason::First),
            title: topic_title(question),
        };
    };
    let title = thread
        .messages
        .iter()
        .find(|m| m.topic == Some(open) && m.role == AiRole::User)
        .map(|m| topic_title(&m.text))
        .unwrap_or_default();
    TopicPick {
        seq: open,
        opened: false,
        reason: None,
        title,
    }
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
            asked_in: None,
        }
    }

    fn thread(messages: Vec<AiMessage>) -> AiThread {
        AiThread {
            id: Uuid::new_v4(),
            place: "ungrouped".into(),
            title: "t".into(),
            messages,
            updated_at: 1,
            title_by: Default::default(),
            title_tries: 0,
            last_work: None,
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

    #[test]
    fn first_ask_opens_topic_1() {
        for thread in [None, Some(&thread(Vec::new()))] {
            let p = topic_for(thread, "How many orders?");
            assert_eq!(
                (p.seq, p.opened, p.reason),
                (1, true, Some(BreakReason::First))
            );
            assert_eq!(p.title, "How many orders?");
        }
        // Messages with no stamp are no Topic.
        let mut old = base();
        for m in &mut old.messages {
            m.topic = None;
        }
        assert_eq!(topic_for(Some(&old), "q").seq, 1);
    }

    /// Ruling 1 (27 Oct): no Place, Idle or Subject break. The open Topic goes on whatever
    /// Connection, database, tables or time the next Ask has.
    #[test]
    fn a_thread_never_breaks() {
        let mut th = base();
        let mut later = msg(
            AiRole::User,
            "and the shipments?",
            1_000 + 3 * 60 * 60_000,
            1,
            &["shipments"],
            "ask",
        );
        later.connection_id = conn(8);
        later.database = Some("crm".into());
        th.messages.push(later.clone());
        th.messages.push(AiMessage {
            role: AiRole::Assistant,
            text: "two late".into(),
            ..later
        });
        let p = topic_for(Some(&th), "something else entirely");
        assert_eq!((p.seq, p.opened, p.reason), (1, false, None));
        assert_eq!(p.title, "why so slow");
    }

    #[test]
    fn an_old_thread_continues_its_highest_topic() {
        let mut th = base();
        th.messages.push(msg(
            AiRole::User,
            "late shipments by carrier",
            5_000,
            2,
            &["shipments"],
            "ask",
        ));
        th.messages.push(msg(
            AiRole::Assistant,
            "carrier 3",
            5_001,
            2,
            &["shipments"],
            "ask",
        ));
        let p = topic_for(Some(&th), "q");
        assert_eq!((p.seq, p.opened, p.reason), (2, false, None));
        assert_eq!(p.title, "late shipments by carrier");
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
