//! Which history an Ask may send: the gate, and the turns and summaries that fit.

use serde::Serialize;

use super::rules::{AskFacts, EARLIER_TOPICS, RECENT_TURNS, TopicPick, rule_summary};
use super::{Compaction, CompactionId, SummaryBy, Topic};
use crate::ai::budget::estimate_tokens;
use crate::ai::rails::input::allowed;
use crate::ai::request::{ItemKind, Switches};
use crate::ai::{AiAccess, AiMessage, AiRole, AiThread};
use crate::model::ConnectionId;

/// The gate on history (R1.7): the same Connection and database as the Ask, and every kind
/// still allowed by the Connection's current AI access. A missing stamp is not allowed.
pub fn history_allowed(
    connection_id: Option<ConnectionId>,
    database: Option<&str>,
    kinds: &[ItemKind],
    ask: &AskFacts,
    access: AiAccess,
    switches: Switches,
) -> bool {
    match (connection_id, ask.connection_id) {
        (Some(a), Some(b)) if a == b => {}
        _ => return false,
    }
    database == ask.database && kinds.iter().all(|k| allowed(access, *k, switches))
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub question: String,
    pub answer: String,
    pub at: i64,
    pub tokens: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SummarySource {
    Compaction {
        id: CompactionId,
        messages: u32,
    },
    Topic {
        seq: u32,
        title: String,
        first_at: i64,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub source: SummarySource,
    pub text: String,
    pub tokens: u32,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPick {
    /// Oldest first.
    pub turns: Vec<Turn>,
    pub summaries: Vec<HistorySummary>,
    /// Messages the gate left out on the Ask's own Connection and database (lower AI
    /// access now), as far as the recent turns and the earlier Topics would have reached.
    pub blocked: u32,
    /// Turns and summaries the share left out.
    pub dropped: u32,
    pub tokens: u32,
}

fn hidden(compactions: &[Compaction], at: i64) -> bool {
    compactions
        .iter()
        .any(|c| !c.undone && c.first_at <= at && at <= c.last_at)
}

/// The Topic an Ask closes, as the Ask sees it: stored it is still open with no summary
/// (the UI's save closes it), so it gets the rule summary of its visible messages here,
/// the one it would get once closed. A summary already stored is kept.
pub fn closing_topic(
    topics: &mut [Topic],
    thread: &AiThread,
    compactions: &[Compaction],
    seq: u32,
) {
    let Some(t) = topics
        .iter_mut()
        .find(|t| t.seq == seq && t.summary.trim().is_empty())
    else {
        return;
    };
    let shown: Vec<&AiMessage> = thread
        .messages
        .iter()
        .filter(|m| m.role != AiRole::Notice && m.topic == Some(seq) && !hidden(compactions, m.at))
        .collect();
    t.summary = rule_summary(&shown);
    t.summary_by = SummaryBy::Rules;
    t.closed = true;
}

/// The history an Ask may send: the open Topic's newest whole turns, its newest compaction
/// summary, and the summaries of up to two earlier Topics, all behind the gate and within
/// `share_tokens`. `clean` runs on every text before it is measured.
#[allow(clippy::too_many_arguments)]
pub fn select_history(
    thread: Option<&AiThread>,
    topics: &[Topic],
    compactions: &[Compaction],
    pick: &TopicPick,
    ask: &AskFacts,
    access: AiAccess,
    switches: Switches,
    matches: &[u32],
    share_tokens: u32,
    clean: &dyn Fn(&str) -> String,
) -> HistoryPick {
    let mut out = HistoryPick::default();
    let gate = |c: Option<ConnectionId>, d: Option<&str>, k: &[ItemKind]| {
        history_allowed(c, d, k, ask, access, switches)
    };
    let msg_ok = |m: &AiMessage| gate(m.connection_id, m.database.as_deref(), &m.kinds);
    // History of another place is not held back by AI access: Sends must not count it.
    let here = |c: Option<ConnectionId>, d: Option<&str>| {
        c.is_some() && c == ask.connection_id && d == ask.database
    };
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);

    // The open Topic's visible turns, newest first.
    let mut turns: Vec<(&AiMessage, &AiMessage)> = Vec::new();
    // Each visible turn, oldest first: its messages held back here, or none.
    let mut held: Vec<u32> = Vec::new();
    if let Some(thread) = thread {
        let msgs: Vec<&AiMessage> = thread
            .messages
            .iter()
            .filter(|m| m.role != AiRole::Notice)
            .collect();
        for (i, q) in msgs.iter().enumerate() {
            if q.role != AiRole::User || q.topic != Some(pick.seq) {
                continue;
            }
            let Some(a) = msgs.get(i + 1) else { continue };
            if a.role != AiRole::Assistant
                || a.topic != Some(pick.seq)
                || a.text.trim().is_empty()
                || hidden(compactions, q.at)
                || hidden(compactions, a.at)
            {
                continue;
            }
            if !(msg_ok(q) && msg_ok(a)) {
                let mine = [q, a]
                    .iter()
                    .filter(|m| here(m.connection_id, m.database.as_deref()))
                    .count();
                held.push(count(mine));
                continue;
            }
            held.push(0);
            turns.push((q, a));
        }
    }
    // Only the turns the window of recent turns would have reached.
    out.blocked += held
        .iter()
        .rev()
        .take(RECENT_TURNS)
        .fold(0u32, |n, m| n.saturating_add(*m));
    turns.reverse();
    turns.truncate(RECENT_TURNS);

    let mut left = share_tokens;
    let mut full = false;
    let mut kept: Vec<Turn> = Vec::new();
    for (q, a) in turns {
        if full {
            out.dropped += 1;
            continue;
        }
        let (question, answer) = (clean(&q.text), clean(&a.text));
        let tokens =
            estimate_tokens(&question, false).saturating_add(estimate_tokens(&answer, false));
        if tokens > left {
            full = true;
            out.dropped += 1;
            continue;
        }
        left -= tokens;
        out.tokens += tokens;
        kept.push(Turn {
            question,
            answer,
            at: q.at,
            tokens,
        });
    }
    kept.reverse();
    out.turns = kept;

    // The open Topic's newest active compaction.
    let newest = compactions
        .iter()
        .filter(|c| c.topic == pick.seq && !c.undone && !c.summary.trim().is_empty())
        .max_by_key(|c| c.at);
    if let Some(c) = newest {
        if !gate(c.connection_id, c.database.as_deref(), &c.kinds) {
            if here(c.connection_id, c.database.as_deref()) {
                out.blocked = out.blocked.saturating_add(c.messages);
            }
        } else {
            let text = clean(&c.summary);
            let tokens = estimate_tokens(&text, false);
            if tokens > left {
                out.dropped += 1;
            } else {
                left -= tokens;
                out.tokens += tokens;
                out.summaries.push(HistorySummary {
                    source: SummarySource::Compaction {
                        id: c.id,
                        messages: c.messages,
                    },
                    text,
                    tokens,
                });
            }
        }
    }

    // Earlier Topics found by tables or by search, newest first.
    let mut earlier: Vec<&Topic> = topics
        .iter()
        .filter(|t| {
            t.seq != pick.seq
                && !t.summary.trim().is_empty()
                && (matches.contains(&t.seq) || t.tables.iter().any(|x| ask.tables.contains(x)))
        })
        .collect();
    earlier.sort_by_key(|t| std::cmp::Reverse(t.seq));
    let mut sent = 0usize;
    let mut skipped = 0usize;
    let mut held = 0usize;
    let mut full = false;
    for t in earlier {
        if sent + skipped >= EARLIER_TOPICS {
            break;
        }
        if !gate(t.connection_id, t.database.as_deref(), &t.kinds) {
            // Counted while it would have taken one of the two places.
            if here(t.connection_id, t.database.as_deref())
                && sent + skipped + held < EARLIER_TOPICS
            {
                held += 1;
                out.blocked = out.blocked.saturating_add(t.messages);
            }
            continue;
        }
        if full {
            out.dropped += 1;
            skipped += 1;
            continue;
        }
        let text = clean(&t.summary);
        let tokens = estimate_tokens(&text, false);
        if tokens > left {
            full = true;
            out.dropped += 1;
            skipped += 1;
            continue;
        }
        left -= tokens;
        out.tokens += tokens;
        sent += 1;
        out.summaries.push(HistorySummary {
            source: SummarySource::Topic {
                seq: t.seq,
                title: t.title.clone(),
                first_at: t.first_at,
            },
            text,
            tokens,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::memory::SummaryBy;
    use crate::ai::sent::AnswerRecord;
    use uuid::Uuid;

    fn conn(n: u128) -> Option<ConnectionId> {
        Some(Uuid::from_u128(n))
    }

    fn msg(role: AiRole, text: &str, at: i64, seq: u32, kinds: &[ItemKind]) -> AiMessage {
        AiMessage {
            role,
            text: text.into(),
            context: Vec::new(),
            at,
            record: None,
            topic: Some(seq),
            connection_id: conn(7),
            database: Some("shop".into()),
            kinds: kinds.to_vec(),
            tables: Vec::new(),
            action: None,
        }
    }

    fn turn(seq: u32, at: i64, q: &str, a: &str) -> Vec<AiMessage> {
        vec![
            msg(AiRole::User, q, at, seq, &[ItemKind::Question]),
            msg(AiRole::Assistant, a, at + 1, seq, &[ItemKind::Question]),
        ]
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

    fn topic(seq: u32, summary: &str, tables: &[&str]) -> Topic {
        Topic {
            thread_id: Uuid::nil(),
            seq,
            title: format!("topic {seq}"),
            summary: summary.into(),
            summary_by: SummaryBy::Rules,
            tables: tables.iter().map(|t| t.to_string()).collect(),
            connection_id: conn(7),
            database: Some("shop".into()),
            kinds: vec![ItemKind::Question],
            first_at: 1,
            last_at: 2,
            messages: 2,
            closed: true,
        }
    }

    fn compaction(topic: u32, first_at: i64, last_at: i64, undone: bool) -> Compaction {
        Compaction {
            id: Uuid::new_v4(),
            thread_id: Uuid::nil(),
            topic,
            first_at,
            last_at,
            messages: 4,
            summary: "folded earlier turns".into(),
            summary_by: SummaryBy::Rules,
            connection_id: conn(7),
            database: Some("shop".into()),
            kinds: vec![ItemKind::Question],
            before: 100,
            after: 10,
            at: 500,
            undone,
            record: AnswerRecord::default(),
        }
    }

    fn pick(seq: u32) -> TopicPick {
        TopicPick {
            seq,
            opened: false,
            reason: None,
            title: String::new(),
            closing: None,
        }
    }

    fn facts(tables: &[String]) -> AskFacts<'_> {
        AskFacts {
            connection_id: conn(7),
            database: Some("shop"),
            action: "ask",
            tables,
            now_ms: 10_000,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        th: &AiThread,
        topics: &[Topic],
        comps: &[Compaction],
        p: &TopicPick,
        ask: &AskFacts,
        access: AiAccess,
        matches: &[u32],
        share: u32,
    ) -> HistoryPick {
        select_history(
            Some(th),
            topics,
            comps,
            p,
            ask,
            access,
            Switches::default(),
            matches,
            share,
            &|s| s.to_string(),
        )
    }

    #[test]
    fn recent_turns_newest_first_up_to_8() {
        let mut m = Vec::new();
        for i in 0..12 {
            m.extend(turn(1, i * 10, &format!("q{i}"), &format!("a{i}")));
        }
        let th = thread(m);
        let r = run(
            &th,
            &[],
            &[],
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            10_000,
        );
        let qs: Vec<&str> = r.turns.iter().map(|t| t.question.as_str()).collect();
        assert_eq!(qs, ["q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11"]);
        assert_eq!(r.turns[0].at, 40);
        assert_eq!(r.turns[0].tokens, 2);
        assert_eq!((r.tokens, r.blocked, r.dropped), (16, 0, 0));
    }

    #[test]
    fn share_cuts_whole_turns() {
        let mut m = Vec::new();
        for i in 0..4 {
            m.extend(turn(1, i * 10, "qqqq", "aaaaaaa")); // 2 + 2 tokens
        }
        let th = thread(m);
        let r = run(
            &th,
            &[],
            &[],
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            9,
        );
        assert_eq!(r.turns.len(), 2, "two whole turns of 4 tokens fit in 9");
        assert_eq!(r.turns[0].at, 20);
        assert_eq!((r.tokens, r.dropped), (8, 2));
    }

    #[test]
    fn history_from_another_connection_never_sent() {
        let mut m = turn(2, 10, "old q", "old a");
        for x in &mut m {
            x.connection_id = conn(8);
        }
        let th = thread(m);
        let mut other = topic(1, "summary of the other place", &["invoices"]);
        other.connection_id = conn(8);
        let tables = ["invoices".to_string()];
        let r = run(
            &th,
            &[other],
            &[],
            &pick(2),
            &facts(&tables),
            AiAccess::SchemaQueryRows,
            &[1],
            10_000,
        );
        assert!(r.turns.is_empty() && r.summaries.is_empty());
        // Another place's history is not "lower access": it is not counted.
        assert_eq!(r.blocked, 0);
        // Another database of the same Connection too.
        let mut same_conn = topic(1, "other database", &["invoices"]);
        same_conn.database = Some("crm".into());
        let r = run(
            &th,
            &[same_conn],
            &[],
            &pick(2),
            &facts(&tables),
            AiAccess::Schema,
            &[1],
            10_000,
        );
        assert!(r.summaries.is_empty());
        assert_eq!(r.blocked, 0);
        // An Ask with no Connection receives nothing.
        let none = AskFacts {
            connection_id: None,
            ..facts(&tables)
        };
        let r = run(
            &thread(turn(1, 10, "q", "a")),
            &[],
            &[],
            &pick(1),
            &none,
            AiAccess::Schema,
            &[],
            100,
        );
        assert!(r.turns.is_empty());
    }

    #[test]
    fn lowered_kinds_are_blocked() {
        let mut m = turn(1, 10, "plain", "fine");
        m.extend(vec![
            msg(
                AiRole::User,
                "with sql",
                20,
                1,
                &[ItemKind::Question, ItemKind::Sql],
            ),
            msg(
                AiRole::Assistant,
                "ans",
                21,
                1,
                &[ItemKind::Question, ItemKind::Sql],
            ),
        ]);
        let th = thread(m);
        let r = run(
            &th,
            &[],
            &[],
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            1_000,
        );
        assert_eq!(r.turns.len(), 1);
        assert_eq!(r.turns[0].question, "plain");
        assert_eq!(r.blocked, 2, "the blocked turn's two messages");
        let r = run(
            &th,
            &[],
            &[],
            &pick(1),
            &facts(&[]),
            AiAccess::SchemaQuery,
            &[],
            1_000,
        );
        assert_eq!((r.turns.len(), r.blocked), (2, 0));
        // A summary of those turns is blocked the same way.
        let mut t = topic(1, "sql talk", &["invoices"]);
        t.kinds = vec![ItemKind::Sql];
        let tables = ["invoices".to_string()];
        let r = run(
            &th,
            &[t],
            &[],
            &pick(2),
            &facts(&tables),
            AiAccess::Schema,
            &[],
            1_000,
        );
        assert!(r.summaries.is_empty());
        assert_eq!(r.blocked, 2, "the Topic's two messages");
    }

    #[test]
    fn blocked_counts_only_what_the_window_would_send() {
        let sql = [ItemKind::Question, ItemKind::Sql];
        let mut m = Vec::new();
        for i in 0..10 {
            m.push(msg(AiRole::User, "with sql", i * 10, 1, &sql));
            m.push(msg(AiRole::Assistant, "ans", i * 10 + 1, 1, &sql));
        }
        let th = thread(m);
        let mut c = compaction(1, -10, -5, false);
        c.kinds = sql.to_vec();
        let r = run(
            &th,
            &[],
            &[c],
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            1_000,
        );
        assert!(r.turns.is_empty() && r.summaries.is_empty());
        // 8 recent turns of 2 messages, and the compaction's 4 messages.
        assert_eq!(r.blocked, 8 * 2 + 4);
    }

    #[test]
    fn unstamped_turns_never_sent() {
        let mut old = turn(1, 10, "old q", "old a");
        for m in &mut old {
            m.topic = None;
            m.connection_id = None;
            m.database = None;
        }
        // Stamped by topic but not by Connection: fail closed.
        let mut half = turn(1, 30, "half q", "half a");
        for m in &mut half {
            m.connection_id = None;
        }
        let mut m = old;
        m.extend(half);
        m.extend(turn(1, 50, "kept", "kept a"));
        let th = thread(m);
        let r = run(
            &th,
            &[],
            &[],
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            1_000,
        );
        let qs: Vec<&str> = r.turns.iter().map(|t| t.question.as_str()).collect();
        assert_eq!(qs, ["kept"]);
        // A turn with no Connection stamp is not on the Ask's Connection: not counted.
        assert_eq!(r.blocked, 0);
    }

    #[test]
    fn notices_and_failed_turns_are_not_candidates() {
        let mut m = turn(1, 10, "good", "answer");
        m.push(msg(AiRole::Notice, "Topic changed", 20, 1, &[]));
        m.push(msg(AiRole::User, "failed", 30, 1, &[ItemKind::Question]));
        m.push(msg(AiRole::Assistant, "  ", 31, 1, &[ItemKind::Question]));
        m.push(msg(
            AiRole::User,
            "no answer yet",
            40,
            1,
            &[ItemKind::Question],
        ));
        let th = thread(m);
        let r = run(
            &th,
            &[],
            &[],
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            1_000,
        );
        assert_eq!(r.turns.len(), 1);
        assert_eq!(r.blocked, 0);
    }

    #[test]
    fn hidden_turns_replaced_by_compaction_summary() {
        let mut m = Vec::new();
        for i in 0..4 {
            m.extend(turn(1, i * 10, &format!("q{i}"), "a"));
        }
        let th = thread(m);
        let c = compaction(1, 0, 11, false);
        let r = run(
            &th,
            &[],
            std::slice::from_ref(&c),
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            1_000,
        );
        let qs: Vec<&str> = r.turns.iter().map(|t| t.question.as_str()).collect();
        assert_eq!(qs, ["q2", "q3"]);
        assert_eq!(r.summaries.len(), 1);
        assert_eq!(r.summaries[0].text, "folded earlier turns");
        assert_eq!(
            r.summaries[0].source,
            SummarySource::Compaction {
                id: c.id,
                messages: 4
            }
        );
        // A compaction whose kinds are no longer allowed is blocked.
        let mut sql = c;
        sql.kinds = vec![ItemKind::Sql];
        let r = run(
            &th,
            &[],
            &[sql],
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            1_000,
        );
        assert!(r.summaries.is_empty());
        assert_eq!(r.blocked, 4, "the 4 messages it folded");
    }

    #[test]
    fn undone_compaction_shows_turns_again() {
        let mut m = Vec::new();
        for i in 0..4 {
            m.extend(turn(1, i * 10, &format!("q{i}"), "a"));
        }
        let th = thread(m);
        let c = compaction(1, 0, 21, true);
        let r = run(
            &th,
            &[],
            &[c],
            &pick(1),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            1_000,
        );
        assert_eq!(r.turns.len(), 4);
        assert!(r.summaries.is_empty());
    }

    #[test]
    fn earlier_topics_by_tables_or_match_at_most_2() {
        let th = thread(turn(5, 100, "now", "ok"));
        let topics = vec![
            topic(1, "s1", &["invoices"]),
            topic(2, "s2", &["invoices"]),
            topic(3, "s3", &["shipments"]),
            topic(4, "s4", &["invoices"]),
            topic(6, "", &["invoices"]),
        ];
        let tables = ["invoices".to_string()];
        let r = run(
            &th,
            &topics,
            &[],
            &pick(5),
            &facts(&tables),
            AiAccess::Schema,
            &[],
            1_000,
        );
        let seqs: Vec<u32> = r
            .summaries
            .iter()
            .map(|s| match &s.source {
                SummarySource::Topic { seq, .. } => *seq,
                _ => 0,
            })
            .collect();
        assert_eq!(seqs, [4, 2], "newest first, at most 2, no empty summary");
        // Found by search, not by tables.
        let r = run(
            &th,
            &topics,
            &[],
            &pick(5),
            &facts(&[]),
            AiAccess::Schema,
            &[3],
            1_000,
        );
        assert_eq!(r.summaries.len(), 1);
        assert_eq!(r.summaries[0].text, "s3");
        // Nothing matches.
        let r = run(
            &th,
            &topics,
            &[],
            &pick(5),
            &facts(&[]),
            AiAccess::Schema,
            &[],
            1_000,
        );
        assert!(r.summaries.is_empty());
        // The second summary does not fit.
        let r = run(
            &th,
            &topics,
            &[],
            &pick(5),
            &facts(&tables),
            AiAccess::Schema,
            &[],
            1,
        );
        assert_eq!(r.summaries.len(), 1);
        assert_eq!(r.dropped, 2, "the open Topic's turn and one Topic");
    }

    #[test]
    fn history_text_is_cleaned() {
        let mut m = turn(1, 10, "secret q", "secret a");
        m.extend(turn(2, 20, "unused", "unused"));
        let th = thread(m);
        let topics = vec![topic(3, "secret summary", &["invoices"])];
        let c = compaction(1, 0, 5, false);
        let tables = ["invoices".to_string()];
        let r = select_history(
            Some(&th),
            &topics,
            &[c],
            &pick(1),
            &facts(&tables),
            AiAccess::Schema,
            Switches::default(),
            &[],
            1_000,
            &|s| s.replace("secret", "[x]").replace("folded", "[f]"),
        );
        assert_eq!(r.turns[0].question, "[x] q");
        assert_eq!(r.turns[0].answer, "[x] a");
        let texts: Vec<&str> = r.summaries.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["[f] earlier turns", "[x] summary"]);
    }
}
