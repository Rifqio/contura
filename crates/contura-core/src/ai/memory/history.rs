//! Which history an Ask may send: the gate, and the turns and summaries that fit.

use serde::Serialize;

use super::rules::{AskFacts, EARLIER_TOPICS, RECENT_TURNS, TopicPick};
use super::{Compaction, CompactionId, Cover, Topic};
use crate::ai::budget::estimate_tokens;
use crate::ai::rails::input::{allowed, rank};
use crate::ai::rails::retrieval::{ASKED_IN_SOURCE, framed_lines};
use crate::ai::request::{ItemKind, Switches};
use crate::ai::{AiAccess, AiMessage, AiRole, AiThread};
use crate::model::ConnectionId;

/// The access a stored message, compaction or Topic summary is gated at by its own
/// Connection (Decision 2, ruling 1 of 27 Oct): the Ask's own Connection reads `access`,
/// another Connection its current access in `others` (`access_now`: one not there, deleted
/// or unreadable, is Never), and no Connection (Home) is Never. The database plays no part:
/// the history follows the conversation across databases.
pub fn access_of(
    connection_id: Option<ConnectionId>,
    ask: &AskFacts,
    access: AiAccess,
    others: &[(ConnectionId, AiAccess)],
) -> AiAccess {
    match connection_id {
        None => AiAccess::Never,
        Some(id) if Some(id) == ask.connection_id => access,
        Some(id) => access_now(id, others),
    }
}

/// The gate on history (R1.7): every kind a turn or summary was stamped with is still
/// allowed at `level`, its own Connection's (`message_access`, `access_of`). A turn that sent
/// only the conversation (the question, earlier history, the tab's kind words, Recent steps:
/// kinds that need no access) passes at Never too: it went to the provider once already and
/// carries nothing about the database.
pub fn history_allowed(kinds: &[ItemKind], level: AiAccess, switches: Switches) -> bool {
    kinds.iter().all(|k| allowed(level, *k, switches))
}

/// Every Connection the messages of `thread` name, each once: each message's own, then the
/// others its question was asked across (`AskedIn::also`), then those of its stored steps on
/// other Connections (`AskedIn::other_steps`). The memory stage reads their current access
/// before the gate runs (`others_access`).
pub fn also_of(thread: &AiThread) -> Vec<ConnectionId> {
    let mut out: Vec<ConnectionId> = Vec::new();
    for m in &thread.messages {
        let asked = m.asked_in.as_ref();
        let named = m
            .connection_id
            .iter()
            .chain(asked.into_iter().flat_map(|a| a.also.iter()))
            .chain(
                asked
                    .into_iter()
                    .flat_map(|a| a.other_steps.iter().map(|s| &s.connection_id)),
            );
        for id in named {
            if !out.contains(id) {
                out.push(*id);
            }
        }
    }
    out
}

/// The access a stored message is gated at: its own Connection's (`access_of`), lowered to
/// the current access of every other Connection its question was asked across. One not in
/// `others` (deleted) is Never.
pub fn message_access(
    m: &AiMessage,
    ask: &AskFacts,
    access: AiAccess,
    others: &[(ConnectionId, AiAccess)],
) -> AiAccess {
    let own = access_of(m.connection_id, ask, access, others);
    match m.asked_in.as_ref() {
        Some(asked) => lowered(own, &asked.also, others),
        None => own,
    }
}

/// `own` lowered to the current access of each Connection in `also`.
fn lowered(own: AiAccess, also: &[ConnectionId], others: &[(ConnectionId, AiAccess)]) -> AiAccess {
    also.iter().fold(own, |low, id| {
        let level = access_now(*id, others);
        if rank(level) < rank(low) { level } else { low }
    })
}

/// The gate on a stamp: a message's, or a `Cover` of a summary (`message_allowed`).
fn stamp_parts_allowed(
    connection_id: Option<ConnectionId>,
    also: &[ConnectionId],
    kinds: &[ItemKind],
    ask: &AskFacts,
    access: AiAccess,
    others: &[(ConnectionId, AiAccess)],
    switches: Switches,
) -> bool {
    let level = lowered(access_of(connection_id, ask, access, others), also, others);
    !(level == AiAccess::Never && (!also.is_empty() || elsewhere(connection_id, ask)))
        && history_allowed(kinds, level, switches)
}

/// Whether every step on another Connection is still allowed by that Connection's current
/// access, at the level the step needed.
fn steps_ok(
    mut steps: impl Iterator<Item = (ConnectionId, AiAccess)>,
    others: &[(ConnectionId, AiAccess)],
) -> bool {
    steps.all(|(id, level)| {
        let now = access_now(id, others);
        now != AiAccess::Never && rank(now) >= rank(level)
    })
}

/// The gate on what a summary's text covers, read from its stored `Cover` and never from
/// the thread (which may have dropped those messages): the same rule as
/// `summary_covers_ok` on a message with that stamp.
pub fn cover_ok(
    c: &Cover,
    ask: &AskFacts,
    access: AiAccess,
    others: &[(ConnectionId, AiAccess)],
    switches: Switches,
) -> bool {
    stamp_parts_allowed(
        c.connection_id,
        &c.also,
        &c.kinds,
        ask,
        access,
        others,
        switches,
    ) && steps_ok(c.steps.iter().copied(), others)
}

/// What a compaction written before `Compaction::covers` was kept covers, when that can be
/// known: its chain (it and every earlier compaction of its Topic) still holds every
/// message of its span, and the thread still holds a message older than the chain's start,
/// so no trim reached its range. It is then taken to cover every Connection the thread's
/// messages use. `None` (unknown) holds it: it is not replayed and not folded again.
pub fn legacy_covers(
    c: &Compaction,
    thread: &AiThread,
    compactions: &[Compaction],
) -> Option<Vec<Cover>> {
    let stored: Vec<&AiMessage> = thread
        .messages
        .iter()
        .filter(|m| m.role != AiRole::Notice)
        .collect();
    let oldest = stored.iter().map(|m| m.at).min()?;
    let chain: Vec<&Compaction> = compactions
        .iter()
        .filter(|e| e.topic == c.topic && e.at <= c.at)
        .chain(std::iter::once(c))
        .collect();
    let start = chain.iter().map(|e| e.first_at).min()?;
    let intact = chain.iter().all(|e| {
        let held = stored
            .iter()
            .filter(|m| m.topic == Some(e.topic) && e.first_at <= m.at && m.at <= e.last_at)
            .count();
        held >= e.messages as usize
    });
    (intact && oldest < start).then(|| Cover::merged(stored.iter().map(|m| Cover::of(m))))
}

/// What a compaction's text covers: its kept `covers`, else `legacy_covers`.
pub fn covers_of(
    c: &Compaction,
    thread: Option<&AiThread>,
    compactions: &[Compaction],
) -> Option<Vec<Cover>> {
    c.covers
        .clone()
        .or_else(|| thread.and_then(|t| legacy_covers(c, t, compactions)))
}

/// The current access of another Connection, as the memory stage read it into `others`
/// (`also_of`); one not there (deleted, or unreadable) is Never.
pub fn access_now(id: ConnectionId, others: &[(ConnectionId, AiAccess)]) -> AiAccess {
    others
        .iter()
        .find(|(c, _)| *c == id)
        .map_or(AiAccess::Never, |(_, a)| *a)
}

/// The gate on one stored message: `history_allowed` at `message_access`. A message that
/// names a Connection other than the Ask's (its own, or one it was asked across) and is at
/// Never by it, or deleted, is held whatever it carried (ADR 0027): a turn asked on a
/// Connection that shares nothing never reaches another Connection's prompt. Any other
/// message at Never (the Ask's own Connection, or Home) goes only when it sent nothing but
/// the conversation. Steps on other Connections (`AskedIn::other_steps`) never hold the
/// turn: each is re-gated by its own Connection when it replays (ADR 0027 rule 1).
pub fn message_allowed(
    m: &AiMessage,
    ask: &AskFacts,
    access: AiAccess,
    others: &[(ConnectionId, AiAccess)],
    switches: Switches,
) -> bool {
    let also = m.asked_in.as_ref().map_or(&[][..], |a| a.also.as_slice());
    stamp_parts_allowed(
        m.connection_id,
        also,
        &m.kinds,
        ask,
        access,
        others,
        switches,
    )
}

/// Whether `connection_id` names a Connection other than the Ask's (Home names none).
fn elsewhere(connection_id: Option<ConnectionId>, ask: &AskFacts) -> bool {
    connection_id.is_some() && connection_id != ask.connection_id
}

/// The gate on a summary's own stamp (a compaction's or a Topic's): its kinds at its own
/// Connection's access, held whatever it carried when that is another Connection now at
/// Never or deleted, as a message is (`message_allowed`).
pub fn stamp_allowed(
    connection_id: Option<ConnectionId>,
    kinds: &[ItemKind],
    ask: &AskFacts,
    access: AiAccess,
    others: &[(ConnectionId, AiAccess)],
    switches: Switches,
) -> bool {
    let level = access_of(connection_id, ask, access, others);
    !(level == AiAccess::Never && elsewhere(connection_id, ask))
        && history_allowed(kinds, level, switches)
}

/// The gate a summary applies to each message it covers: `message_allowed`, and every step
/// on another Connection still allowed by that Connection's current access. A turn replay
/// leaves such a step out; a summary cannot, since its text may have folded the step in.
pub fn summary_covers_ok(
    m: &AiMessage,
    ask: &AskFacts,
    access: AiAccess,
    others: &[(ConnectionId, AiAccess)],
    switches: Switches,
) -> bool {
    message_allowed(m, ask, access, others, switches)
        && m.asked_in.as_ref().is_none_or(|a| {
            steps_ok(
                a.other_steps.iter().map(|s| (s.connection_id, s.level)),
                others,
            )
        })
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub question: String,
    pub answer: String,
    /// The question's Asked in as replayed, one framed line each (`AskedIn::replay_lines`),
    /// cleaned; `None` for a question stored without one.
    pub asked_in: Option<String>,
    pub at: i64,
    /// The question, its Asked in lines as framed, and the answer.
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
    /// The kinds the picked turns and summaries were stamped with, each once: an Ask that
    /// sends them relies on them, so its own stamp takes them (I1 of 25 Oct).
    #[serde(skip)]
    pub kinds: Vec<ItemKind>,
}

/// A boundary as long as a request's, to measure framed Asked in lines before the request
/// has one.
const MEASURE_BOUNDARY: &str = "0000000000000000";

fn hidden(compactions: &[Compaction], at: i64) -> bool {
    compactions
        .iter()
        .any(|c| !c.undone && c.first_at <= at && at <= c.last_at)
}

/// The history an Ask may send: the open Topic's newest whole turns, its newest compaction
/// summary, and the summaries of up to two earlier Topics, all behind the gate and within
/// `share_tokens`. `others` is the current access of each Connection in `also_of(thread)`:
/// each message is gated at its own Connection's access, lowered to any it was asked across
/// (`message_allowed`), and a summary goes only when every message it covers passes: those
/// the thread still holds, and for a compaction its kept `covers` too. `clean` runs on every
/// text before it is measured.
#[allow(clippy::too_many_arguments)]
pub fn select_history(
    thread: Option<&AiThread>,
    topics: &[Topic],
    compactions: &[Compaction],
    pick: &TopicPick,
    ask: &AskFacts,
    access: AiAccess,
    others: &[(ConnectionId, AiAccess)],
    switches: Switches,
    matches: &[u32],
    share_tokens: u32,
    clean: &dyn Fn(&str) -> String,
) -> HistoryPick {
    let mut out = HistoryPick::default();
    // A summary's own stamp, at its own Connection's access.
    let gate = |c: Option<ConnectionId>, k: &[ItemKind]| {
        stamp_allowed(c, k, ask, access, others, switches)
    };
    let msg_ok = |m: &AiMessage| message_allowed(m, ask, access, others, switches);
    // A summary goes only when every message it covers that the thread still holds passes
    // (Decision 2). A compaction is also gated on its kept `covers` (fix round 1), since the
    // thread may have dropped what it covers. Each returns whether it passes, and whether a
    // refusal lies on the Ask's own Connection and database (what Sends counts).
    let here_of =
        |c: Option<ConnectionId>, d: Option<&str>| c == ask.connection_id && d == ask.database;
    let covered_ok = |covers: &dyn Fn(&AiMessage) -> bool| {
        let mut ok = true;
        let mut mine = false;
        for m in thread.iter().flat_map(|t| t.messages.iter()) {
            if m.role != AiRole::Notice
                && covers(m)
                && !summary_covers_ok(m, ask, access, others, switches)
            {
                ok = false;
                mine |= here_of(m.connection_id, m.database.as_deref());
            }
        }
        (ok, mine)
    };
    let kept_ok = |kept: Option<&Vec<Cover>>| match kept {
        None => (false, false),
        Some(cs) => {
            let mut ok = true;
            let mut mine = false;
            for c in cs {
                if !cover_ok(c, ask, access, others, switches) {
                    ok = false;
                    mine |= here_of(c.connection_id, c.database.as_deref());
                }
            }
            (ok, mine)
        }
    };
    let mut kinds: Vec<ItemKind> = Vec::new();
    let mut add_kinds = |ks: &[ItemKind]| {
        for k in ks {
            if !kinds.contains(k) {
                kinds.push(*k);
            }
        }
    };
    // Sends counts as held only what is on the Ask's own Connection and database.
    let here =
        |c: Option<ConnectionId>, d: Option<&str>| c == ask.connection_id && d == ask.database;
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
        // Each line cleaned alone, so a match never joins two lines.
        let asked_in = q
            .asked_in
            .as_ref()
            .map(|a| a.replay_lines(others))
            .filter(|l| !l.is_empty())
            .map(|l| l.iter().map(|x| clean(x)).collect::<Vec<_>>().join("\n"));
        let framed = asked_in.as_deref().map_or(0, |a| {
            estimate_tokens(&framed_lines(MEASURE_BOUNDARY, ASKED_IN_SOURCE, a), false)
        });
        let tokens = estimate_tokens(&question, false)
            .saturating_add(framed)
            .saturating_add(estimate_tokens(&answer, false));
        if tokens > left {
            full = true;
            out.dropped += 1;
            continue;
        }
        left -= tokens;
        out.tokens += tokens;
        add_kinds(&q.kinds);
        add_kinds(&a.kinds);
        kept.push(Turn {
            question,
            answer,
            asked_in,
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
        // Compactions chain within a Topic (each folds the summary before it), so it
        // covers every message of its Topic up to its end, not only its own span.
        let span = |m: &AiMessage| m.topic == Some(c.topic) && m.at <= c.last_at;
        let stamp = gate(c.connection_id, &c.kinds);
        let (stored, stored_mine) = covered_ok(&span);
        let (kept, kept_mine) = kept_ok(covers_of(c, thread, compactions).as_ref());
        if !(stamp && stored && kept) {
            // Counted only when what holds it is on the Ask's own place.
            let mine = (!stamp && here(c.connection_id, c.database.as_deref()))
                || stored_mine
                || kept_mine;
            if mine {
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
                add_kinds(&c.kinds);
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
    // Fix round 2: a Topic's row is rebuilt from the messages the thread still holds, but
    // its summary text was written from all of them. A trim cuts only the oldest end, so the
    // Topic holding the thread's oldest message may have lost turns its text still quotes
    // (their Connections, steps and kinds no longer gate it): its summary is held. With no
    // thread, none can be proven whole. The trim cuts by position, and a clock set back can
    // make `at` disagree with it, so the Topic of the first message by position is held too.
    let oldest_topic = |seq: u32| {
        thread.is_none_or(|t| {
            let stored = t.messages.iter().filter(|m| m.role != AiRole::Notice);
            let first = stored.clone().next();
            first.is_none_or(|m| m.topic == Some(seq))
                || stored
                    .min_by_key(|m| m.at)
                    .is_some_and(|m| m.topic == Some(seq))
        })
    };
    let mut sent = 0usize;
    let mut skipped = 0usize;
    let mut held = 0usize;
    let mut full = false;
    for t in earlier {
        if sent + skipped >= EARLIER_TOPICS {
            break;
        }
        // Held, and not counted: what holds it may not be on any place now.
        if oldest_topic(t.seq) {
            continue;
        }
        let of_topic = |m: &AiMessage| m.topic == Some(t.seq);
        let stamp = gate(t.connection_id, &t.kinds);
        let (stored, stored_mine) = covered_ok(&of_topic);
        if !(stamp && stored) {
            // Counted while it would have taken one of the two places, and only when what
            // holds it is on the Ask's own place.
            let mine = (!stamp && here(t.connection_id, t.database.as_deref())) || stored_mine;
            if mine && sent + skipped + held < EARLIER_TOPICS {
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
        add_kinds(&t.kinds);
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
    out.kinds = kinds;
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
            asked_in: None,
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
            title_by: Default::default(),
            title_tries: 0,
            last_work: None,
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
            // What it folded: questions on Connection 7's `shop`.
            covers: Some(vec![Cover::of(&msg(
                AiRole::User,
                "",
                first_at,
                topic,
                &[ItemKind::Question],
            ))]),
        }
    }

    fn pick(seq: u32) -> TopicPick {
        TopicPick {
            seq,
            opened: false,
            reason: None,
            title: String::new(),
        }
    }

    fn facts(tables: &[String]) -> AskFacts<'_> {
        AskFacts {
            connection_id: conn(7),
            database: Some("shop"),
            tables,
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
            &[],
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

    fn asked(m: &mut AiMessage, summary: &str, also: Option<ConnectionId>) {
        m.asked_in = Some(crate::ai::memory::AskedIn {
            tab: "visual".into(),
            label: "Visual Query in shop".into(),
            summary: summary.into(),
            steps: vec!["ticked orders.id".into()],
            also: also.into_iter().collect(),
            other_steps: Vec::new(),
            tab_key: None,
        });
    }

    #[test]
    fn asked_in_counts_in_history_tokens() {
        let mut m = Vec::new();
        for i in 0..3 {
            m.extend(turn(1, i * 10, "qqqq", "aaaaaaa")); // 2 + 2 tokens
        }
        let plain = thread(m.clone());
        let all = |th: &AiThread, share| {
            run(
                th,
                &[],
                &[],
                &pick(1),
                &facts(&[]),
                AiAccess::Schema,
                &[],
                share,
            )
        };
        assert_eq!(all(&plain, 1_000).tokens, 12);
        // The newest question was asked with a long summary.
        asked(&mut m[4], &"tables orders, customers; ".repeat(8), None);
        let th = thread(m);
        let wide = all(&th, 1_000);
        let newest = wide.turns.last().unwrap();
        let lines = newest.asked_in.as_deref().unwrap();
        assert!(
            lines.starts_with("Visual Query in shop: tables orders"),
            "{lines}"
        );
        assert!(
            lines.ends_with("\nsteps before it: ticked orders.id"),
            "{lines}"
        );
        // Its framed lines count, frame and all.
        let framed = estimate_tokens(
            &framed_lines(MEASURE_BOUNDARY, ASKED_IN_SOURCE, lines),
            false,
        );
        assert_eq!(newest.tokens, 4 + framed);
        // A share that holds the three plain turns and the newest with its Asked in plus
        // one more: the oldest turn is dropped first.
        let r = all(&th, newest.tokens + 4 + 3);
        assert_eq!(r.turns.len(), 2);
        assert_eq!((r.turns[0].at, r.turns[1].at), (10, 20));
        assert!(r.turns[0].asked_in.is_none());
        assert_eq!(r.dropped, 1);
        assert_eq!(all(&plain, newest.tokens + 4 + 3).turns.len(), 3);
    }

    #[test]
    fn asked_across_another_connection_takes_its_lower_access() {
        let other = Uuid::from_u128(9);
        let mut m = turn(2, 100, "compare them", "3 changed.");
        asked(&mut m[0], "3 added, 1 removed, 4 changed", Some(other));
        m[0].kinds = vec![ItemKind::Question, ItemKind::Names, ItemKind::Tab];
        m[1].kinds = m[0].kinds.clone();
        let th = thread(m);
        let go = |access, others: &[(ConnectionId, AiAccess)]| {
            select_history(
                Some(&th),
                &[],
                &[],
                &pick(2),
                &facts(&[]),
                access,
                others,
                Switches::default(),
                &[],
                10_000,
                &|s| s.to_string(),
            )
        };
        assert_eq!(also_of(&th), vec![conn(7).unwrap(), other]);
        let r = go(AiAccess::Schema, &[(other, AiAccess::SchemaQuery)]);
        assert_eq!((r.turns.len(), r.blocked), (1, 0));
        // The other Connection lowered to Never, or deleted: held, counted as lower access.
        let r = go(AiAccess::SchemaQuery, &[(other, AiAccess::Never)]);
        assert_eq!((r.turns.len(), r.blocked), (0, 2));
        let r = go(AiAccess::SchemaQuery, &[]);
        assert_eq!((r.turns.len(), r.blocked), (0, 2));

        // Stamped at query text: the lower of the two must still allow it.
        let mut m = th.messages.clone();
        for x in &mut m {
            x.kinds.push(ItemKind::Sql);
        }
        let th = thread(m);
        let go = |access, others: &[(ConnectionId, AiAccess)]| {
            select_history(
                Some(&th),
                &[topic(1, "earlier compare", &[])],
                &[],
                &pick(2),
                &facts(&[]),
                access,
                others,
                Switches::default(),
                &[1],
                10_000,
                &|s| s.to_string(),
            )
        };
        assert_eq!(
            go(AiAccess::SchemaQuery, &[(other, AiAccess::SchemaQuery)])
                .turns
                .len(),
            1
        );
        let r = go(AiAccess::SchemaQuery, &[(other, AiAccess::Schema)]);
        assert_eq!((r.turns.len(), r.blocked), (0, 2));
        let r = go(AiAccess::Schema, &[(other, AiAccess::SchemaQuery)]);
        assert_eq!((r.turns.len(), r.blocked), (0, 2));

        // A summary over such a question is held with it: an earlier Topic's and a
        // compaction's.
        let mut m = th.messages.clone();
        for x in &mut m {
            x.topic = Some(1);
        }
        m.extend(turn(2, 300, "next", "ok"));
        // An older Topic holds the thread's oldest message, first by time and by position,
        // so Topic 1 is whole (fix round 2; Task 3 carry b).
        m.splice(0..0, turn(9, 1, "older", "older a"));
        let th = thread(m);
        let mut c = compaction(1, 100, 101, false);
        c.kinds = vec![ItemKind::Question];
        let summaries =
            |others: &[(ConnectionId, AiAccess)], p: &TopicPick, comps: &[Compaction]| {
                select_history(
                    Some(&th),
                    &[topic(1, "earlier compare", &[])],
                    comps,
                    p,
                    &facts(&[]),
                    AiAccess::SchemaQuery,
                    others,
                    Switches::default(),
                    &[1],
                    10_000,
                    &|s| s.to_string(),
                )
                .summaries
                .len()
            };
        assert_eq!(
            summaries(&[(other, AiAccess::SchemaQuery)], &pick(2), &[]),
            1
        );
        assert_eq!(summaries(&[(other, AiAccess::Schema)], &pick(2), &[]), 0);
        let c = [c];
        assert_eq!(
            summaries(&[(other, AiAccess::SchemaQuery)], &pick(1), &c),
            1
        );
        assert_eq!(summaries(&[(other, AiAccess::Schema)], &pick(1), &c), 0);
    }

    /// I2 of 25 Oct: a step on another Connection never holds its turn (it is left out of
    /// the replay), but a summary over the turn is held while that Connection no longer
    /// reaches the step's level, as for `also`. The pick names the kinds it sent.
    #[test]
    fn other_steps_hold_summaries_not_turns() {
        let other = Uuid::from_u128(9);
        let mut m = turn(1, 100, "what did I run?", "Late orders.");
        asked(&mut m[0], "", None);
        m[0].asked_in.as_mut().unwrap().other_steps = vec![crate::ai::memory::OtherStep {
            connection_id: other,
            text: "ran the Visual Query \"Late orders\" on another Connection".into(),
            level: AiAccess::SchemaQuery,
        }];
        m.extend(turn(2, 300, "next", "ok"));
        // An older Topic holds the thread's oldest message, first by time and by position,
        // so Topic 1 is whole (fix round 2; Task 3 carry b).
        m.splice(0..0, turn(9, 1, "older", "older a"));
        let th = thread(m);
        let go = |others: &[(ConnectionId, AiAccess)], p: &TopicPick| {
            select_history(
                Some(&th),
                &[topic(1, "Asked: what did I run?", &[])],
                &[],
                p,
                &facts(&[]),
                AiAccess::Never,
                others,
                Switches::default(),
                &[1],
                10_000,
                &|s| s.to_string(),
            )
        };
        // The turn replays at Never whatever B allows now.
        for b in [AiAccess::SchemaQuery, AiAccess::Never] {
            let r = go(&[(other, b)], &pick(1));
            assert_eq!((r.turns.len(), r.blocked), (1, 0), "{b:?}");
            assert_eq!(r.kinds, vec![ItemKind::Question]);
        }
        // Topic 1's summary goes while B still allows the step, and is held once it does not.
        assert_eq!(
            go(&[(other, AiAccess::SchemaQuery)], &pick(2))
                .summaries
                .len(),
            1
        );
        assert_eq!(
            go(&[(other, AiAccess::Schema)], &pick(2)).summaries.len(),
            0
        );
        assert_eq!(go(&[], &pick(2)).summaries.len(), 0);
    }

    /// I2: compactions chain within a Topic, so the newest one covers every question of
    /// the Topic up to its end, also those of the compaction it folded.
    #[test]
    fn chained_compactions_hold_a_folded_question_across() {
        let other = Uuid::from_u128(9);
        let mut m = turn(1, 100, "compare them", "3 changed.");
        asked(&mut m[0], "3 added", Some(other));
        for i in 0..3 {
            m.extend(turn(1, 200 + i * 10, &format!("q{i}"), &format!("a{i}")));
        }
        let th = thread(m);
        // C1 folded the compare turn; C2 folded later turns and C1's summary.
        let c1 = compaction(1, 100, 101, false);
        let mut c2 = compaction(1, 200, 211, false);
        c2.at = 600;
        let comps = [c1, c2];
        let go = |others: &[(ConnectionId, AiAccess)]| {
            select_history(
                Some(&th),
                &[],
                &comps,
                &pick(1),
                &facts(&[]),
                AiAccess::Schema,
                others,
                Switches::default(),
                &[],
                10_000,
                &|s| s.to_string(),
            )
        };
        let open = go(&[(other, AiAccess::Schema)]);
        assert_eq!(open.summaries.len(), 1);
        assert!(matches!(
            open.summaries[0].source,
            SummarySource::Compaction { .. }
        ));
        let held = go(&[(other, AiAccess::Never)]);
        assert!(held.summaries.is_empty());
        assert_eq!(held.blocked, 4);
        // The turn after C2 still goes: it is not asked across.
        assert_eq!(held.turns.len(), 1);
    }

    /// Decision 2: the memory stage reads every Connection a stored message names, its own
    /// first, each once; a Home message names none.
    #[test]
    fn also_of_names_each_messages_own_connection() {
        let (b, c, d) = (Uuid::from_u128(8), Uuid::from_u128(9), Uuid::from_u128(10));
        let mut m = turn(1, 10, "on shop", "ok");
        asked(&mut m[0], "", Some(c));
        m[0].asked_in.as_mut().unwrap().other_steps = vec![crate::ai::memory::OtherStep {
            connection_id: d,
            text: "opened a table on another Connection".into(),
            level: AiAccess::Schema,
        }];
        let mut on_b = turn(1, 20, "on b", "ok");
        for x in &mut on_b {
            x.connection_id = Some(b);
        }
        let mut home = turn(1, 30, "hello", "hi");
        for x in &mut home {
            x.connection_id = None;
        }
        m.extend(on_b);
        m.extend(home);
        assert_eq!(
            also_of(&thread(m)),
            vec![conn(7).unwrap(), c, d, b],
            "own, also, other steps, each once"
        );
    }

    /// Fix round 1: a compaction written before its cover was kept goes only when its whole
    /// chain is still in the thread and something older is too; it then counts as covering
    /// every Connection the thread uses. Anything else holds it.
    #[test]
    fn an_old_compaction_goes_only_when_what_it_covers_is_known() {
        let mut m = Vec::new();
        for i in 1..=4 {
            m.extend(turn(1, i * 10, &format!("q{i}"), &format!("a{i}")));
        }
        let th = thread(m.clone());
        let old = |first_at, last_at, messages| Compaction {
            covers: None,
            messages,
            ..compaction(1, first_at, last_at, false)
        };
        let goes = |th: &AiThread, c: &Compaction| {
            run(
                th,
                &[],
                std::slice::from_ref(c),
                &pick(1),
                &facts(&[]),
                AiAccess::Schema,
                &[],
                1_000,
            )
            .summaries
            .len()
                == 1
        };
        // Turns 2 and 3 folded, turn 1 still held before them: known, and it goes.
        assert!(goes(&th, &old(20, 31, 4)));
        // Its range starts at the thread's oldest message: a trim may have reached it.
        assert!(!goes(&th, &old(10, 21, 4)));
        // A message of its span is gone (a Retry, or a trim): unknown.
        assert!(!goes(&th, &old(20, 31, 6)));
        // An earlier compaction of the chain starts at the oldest message: unknown.
        let first = old(10, 11, 2);
        let second = Compaction {
            at: 600,
            ..old(20, 31, 4)
        };
        assert!(legacy_covers(&second, &th, &[first, second.clone()]).is_none());
        // Known, it covers every Connection the thread uses: one deleted holds it.
        let mut on_gone = m;
        for x in &mut on_gone[6..] {
            x.connection_id = conn(8);
        }
        let th = thread(on_gone);
        let c = old(20, 31, 4);
        let kept = legacy_covers(&c, &th, std::slice::from_ref(&c)).unwrap();
        assert!(kept.iter().any(|k| k.connection_id == conn(8)));
        assert!(!goes(&th, &c));
    }

    /// Fix round 1: a compaction's kept cover is gated even when the thread no longer holds
    /// the message it names.
    #[test]
    fn a_kept_cover_holds_a_compaction_whatever_the_thread_dropped() {
        let th = thread(turn(1, 50, "kept", "kept a"));
        let mut c = compaction(1, 10, 21, false);
        c.covers = Some(vec![Cover {
            connection_id: conn(8),
            database: Some("ledger".into()),
            kinds: vec![ItemKind::Question, ItemKind::Names],
            also: Vec::new(),
            steps: Vec::new(),
        }]);
        let go = |others: &[(ConnectionId, AiAccess)]| {
            select_history(
                Some(&th),
                &[],
                std::slice::from_ref(&c),
                &pick(1),
                &facts(&[]),
                AiAccess::Schema,
                others,
                Switches::default(),
                &[],
                1_000,
                &|s| s.to_string(),
            )
        };
        assert_eq!(
            go(&[(conn(8).unwrap(), AiAccess::Schema)]).summaries.len(),
            1
        );
        for others in [&[(conn(8).unwrap(), AiAccess::Never)][..], &[]] {
            let r = go(others);
            assert!(r.summaries.is_empty());
            // Held by Connection 8, not the Ask's own: not counted.
            assert_eq!(r.blocked, 0);
        }
    }

    /// Fix round 2: a trim cuts only the oldest end, so a closed Topic that holds the
    /// thread's oldest message may have lost turns its summary still quotes: held, and not
    /// counted. Any later Topic is whole.
    #[test]
    fn a_topic_holding_the_oldest_message_is_held() {
        let mut m = turn(1, 10, "q1", "a1");
        m.extend(turn(2, 20, "q2", "a2"));
        m.extend(turn(3, 30, "now", "ok"));
        let th = thread(m);
        let topics = [topic(1, "s1", &[]), topic(2, "s2", &[])];
        let r = run(
            &th,
            &topics,
            &[],
            &pick(3),
            &facts(&[]),
            AiAccess::Schema,
            &[1, 2],
            1_000,
        );
        let texts: Vec<&str> = r.summaries.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["s2"]);
        assert_eq!(r.blocked, 0);
    }

    /// Task 3 carry (b): the trim cuts by position, and a clock set back can make `at`
    /// disagree with it. The Topic of the first stored message by position is held as well
    /// as the one holding the smallest `at`; a Topic that is neither still goes.
    #[test]
    fn the_topic_first_by_position_is_held_when_at_disagrees() {
        // Topic 1 is first by position; Topic 2's turn was stamped with an earlier clock.
        let mut m = turn(1, 50, "q1", "a1");
        m.extend(turn(2, 10, "q2", "a2"));
        m.extend(turn(3, 60, "q3", "a3"));
        m.extend(turn(4, 70, "now", "ok"));
        let th = thread(m);
        let topics = [
            topic(1, "s1", &[]),
            topic(2, "s2", &[]),
            topic(3, "s3", &[]),
        ];
        let r = run(
            &th,
            &topics,
            &[],
            &pick(4),
            &facts(&[]),
            AiAccess::Schema,
            &[1, 2, 3],
            1_000,
        );
        let texts: Vec<&str> = r.summaries.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["s3"]);
        assert_eq!(r.blocked, 0);
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

    /// Decision 2 (ruling 1 of 27 Oct): history on another Connection or database goes at
    /// that Connection's own current access; a deleted one is Never and holds it. Neither is
    /// the Ask's place, so Sends never counts it.
    #[test]
    fn history_from_another_connection_goes_at_its_own_access() {
        let eight = Uuid::from_u128(8);
        let mut m = turn(2, 10, "old q", "old a");
        for x in &mut m {
            x.connection_id = Some(eight);
            x.kinds = vec![ItemKind::Question, ItemKind::Names];
        }
        let th = thread(m);
        let mut other = topic(1, "summary of the other place", &["invoices"]);
        other.connection_id = Some(eight);
        let tables = ["invoices".to_string()];
        let go = |others: &[(ConnectionId, AiAccess)], ask: &AskFacts, access| {
            select_history(
                Some(&th),
                std::slice::from_ref(&other),
                &[],
                &pick(2),
                ask,
                access,
                others,
                Switches::default(),
                &[1],
                10_000,
                &|s| s.to_string(),
            )
        };
        // Connection 8 allows schema names: both go, whatever the Ask's own access.
        let r = go(
            &[(eight, AiAccess::Schema)],
            &facts(&tables),
            AiAccess::Never,
        );
        assert_eq!((r.turns.len(), r.summaries.len(), r.blocked), (1, 1, 0));
        // Lowered to Never, or deleted: held, not counted.
        for others in [&[(eight, AiAccess::Never)][..], &[]] {
            let r = go(others, &facts(&tables), AiAccess::SchemaQueryRows);
            assert!(r.turns.is_empty() && r.summaries.is_empty());
            assert_eq!(r.blocked, 0);
        }
        // Another database of the Ask's own Connection: its access.
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
        assert_eq!((r.summaries.len(), r.blocked), (1, 0));
        // An Ask with no Connection reads each turn at its own Connection's access too.
        let home = AskFacts {
            connection_id: None,
            database: None,
            ..facts(&tables)
        };
        let r = go(&[(eight, AiAccess::Schema)], &home, AiAccess::Never);
        assert_eq!((r.turns.len(), r.blocked), (1, 0));
    }

    /// Live check, 25 Oct: on Home (no Connection) "call me andrew" then "remember my name"
    /// sent no earlier turn, and the model did not know the name. A place with no Connection
    /// is the same place for its own turns, and a turn that sent only the conversation replays
    /// at any access, Never included.
    #[test]
    fn plain_chat_is_remembered_with_no_connection_and_at_never() {
        let home = |mut m: Vec<AiMessage>| {
            for x in &mut m {
                x.connection_id = None;
                x.database = None;
            }
            m
        };
        let tables: [String; 0] = [];
        let on_home = AskFacts {
            connection_id: None,
            database: None,
            ..facts(&tables)
        };
        let th = thread(home(turn(1, 10, "call me andrew", "Hi Andrew")));
        let r = run(
            &th,
            &[],
            &[],
            &pick(1),
            &on_home,
            AiAccess::Never,
            &[],
            1_000,
        );
        assert_eq!(r.turns.len(), 1, "the earlier turn goes on Home");
        assert_eq!(r.turns[0].question, "call me andrew");
        assert_eq!(r.blocked, 0);

        // A Connection at Never: the plain turn goes, one that sent schema names is held and counted.
        let mut m = turn(1, 10, "call me andrew", "Hi Andrew");
        m.extend(vec![
            msg(
                AiRole::User,
                "which tables?",
                20,
                1,
                &[ItemKind::Question, ItemKind::Names],
            ),
            msg(
                AiRole::Assistant,
                "orders, customers",
                21,
                1,
                &[ItemKind::Question, ItemKind::Names],
            ),
        ]);
        let r = run(
            &thread(m),
            &[],
            &[],
            &pick(1),
            &facts(&tables),
            AiAccess::Never,
            &[],
            1_000,
        );
        assert_eq!(r.turns.len(), 1);
        assert_eq!(r.turns[0].question, "call me andrew");
        assert_eq!(
            r.blocked, 2,
            "the turn with names is held at Never, and Sends counts it"
        );
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
        // An older Topic holds the thread's oldest message, first by time and by position,
        // so Topic 1 is whole (fix round 2; Task 3 carry b).
        m.splice(0..0, turn(9, 1, "older", "older a"));
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

    /// A turn with no Topic stamp is never sent. One stamped with a Topic but no Connection
    /// is a Home turn: Never, so it goes only when it sent nothing but the conversation
    /// (Decision 2), and it is not the Ask's place, so it is never counted.
    #[test]
    fn unstamped_turns_never_sent_and_unplaced_ones_are_home_turns() {
        let mut old = turn(1, 10, "old q", "old a");
        for m in &mut old {
            m.topic = None;
            m.connection_id = None;
            m.database = None;
        }
        let mut home = turn(1, 30, "home q", "home a");
        for m in &mut home {
            m.connection_id = None;
        }
        let mut names = turn(1, 40, "names q", "names a");
        for m in &mut names {
            m.connection_id = None;
            m.kinds = vec![ItemKind::Question, ItemKind::Names];
        }
        let mut m = old;
        m.extend(home);
        m.extend(names);
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
        assert_eq!(qs, ["home q", "kept"]);
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
            &[],
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
