//! Recent tool uses: one row per assistant message that proposed diagram changes or
//! picked tables, kept in step with the saved threads.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::ai::diagram_tool::ChangeStatus;
use crate::ai::sent::ToolUse;
use crate::ai::{AiRole, AiThread, ThreadId};
use crate::common::grouped;
use crate::error::{Error, Result};
use crate::model::ConnectionId;

fn store_err(e: impl std::fmt::Display) -> Error {
    Error::Store(e.to_string())
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    ProposeDiagramChanges,
    PickTables,
}

impl ToolKind {
    fn column(self) -> &'static str {
        match self {
            ToolKind::ProposeDiagramChanges => "proposeDiagramChanges",
            ToolKind::PickTables => "pickTables",
        }
    }

    fn from_column(text: &str) -> Option<ToolKind> {
        match text {
            "proposeDiagramChanges" => Some(ToolKind::ProposeDiagramChanges),
            "pickTables" => Some(ToolKind::PickTables),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseRow {
    pub thread_id: ThreadId,
    /// The assistant message the tool use belongs to.
    pub message_at: i64,
    pub at: i64,
    pub tool: ToolKind,
    /// A diagram's `<file>.flow`; empty for Pick tables, whose line the UI writes from
    /// `connection_id`.
    pub target: String,
    pub connection_id: Option<ConnectionId>,
    pub result: String,
}

/// "N proposed, M accepted" once the user has landed or rejected the changes; else what
/// the checker dropped; else what was proposed.
fn diagram_result(tool_use: &ToolUse) -> String {
    let changes = &tool_use.proposal.changes;
    let proposed = changes.len() as u64;
    let dropped = changes
        .iter()
        .filter(|c| matches!(c.status, ChangeStatus::Dropped { .. }))
        .count() as u64;
    if let Some(outcome) = &tool_use.outcome {
        format!(
            "{} proposed, {} accepted",
            grouped(proposed),
            grouped(u64::from(outcome.accepted))
        )
    } else if dropped > 0 {
        format!(
            "Checker dropped {} of {}",
            grouped(dropped),
            grouped(proposed)
        )
    } else {
        format!("{} proposed", grouped(proposed))
    }
}

/// The rows `thread` holds: a diagram tool use, else an outline call.
fn rows_of(thread: &AiThread) -> Vec<ToolUseRow> {
    let mut rows = Vec::new();
    for m in thread
        .messages
        .iter()
        .filter(|m| m.role == AiRole::Assistant)
    {
        let Some(record) = &m.record else { continue };
        let row = |tool, target, result| ToolUseRow {
            thread_id: thread.id,
            message_at: m.at,
            at: m.at,
            tool,
            target,
            connection_id: m.connection_id,
            result,
        };
        if let Some(tool_use) = &record.tool_use {
            // The board's name is its place's: a renamed board's old records keep the old
            // `file` as history, but their rows follow the board.
            let file = thread
                .place
                .strip_prefix("diagram:")
                .unwrap_or(&tool_use.file);
            rows.push(row(
                ToolKind::ProposeDiagramChanges,
                format!("{file}.flow"),
                diagram_result(tool_use),
            ));
        } else if let Some(outline) = record.sent.as_ref().and_then(|s| s.outline.as_ref()) {
            let picked = grouped(u64::from(outline.picked_tables));
            // A thread saved before 11h kept no table count.
            let result = if outline.tables == 0 {
                format!("{picked} tables")
            } else {
                format!("{picked} of {} tables", grouped(u64::from(outline.tables)))
            };
            rows.push(row(ToolKind::PickTables, String::new(), result));
        }
    }
    rows
}

/// Makes the thread's rows match its messages: one per assistant message whose record has
/// a `tool_use` or a `sent.outline`; rows of messages no longer present are removed.
pub fn sync_tool_uses(conn: &Connection, thread: &AiThread) -> Result<()> {
    let id = thread.id.to_string();
    conn.execute("DELETE FROM ai_tool_use WHERE thread_id = ?1", params![id])
        .map_err(store_err)?;
    let mut insert = conn
        .prepare(
            // Two assistant messages at the same `at` keep the later one's row, rather than
            // failing the whole thread save.
            "INSERT OR REPLACE INTO ai_tool_use
               (thread_id, message_at, at, tool, target, connection_id, result)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(store_err)?;
    for row in rows_of(thread) {
        insert
            .execute(params![
                id,
                row.message_at,
                row.at,
                row.tool.column(),
                row.target,
                row.connection_id.map(|c| c.to_string()),
                row.result
            ])
            .map_err(store_err)?;
    }
    Ok(())
}

/// Removes the rows of the threads `ids`.
pub(crate) fn delete_for_threads(conn: &Connection, ids: &[String]) -> Result<()> {
    for id in ids {
        conn.execute("DELETE FROM ai_tool_use WHERE thread_id = ?1", params![id])
            .map_err(store_err)?;
    }
    Ok(())
}

/// The newest `limit` rows, newest first.
pub fn recent(conn: &Connection, limit: usize) -> Result<Vec<ToolUseRow>> {
    let mut stmt = conn
        .prepare(
            "SELECT thread_id, message_at, at, tool, target, connection_id, result
             FROM ai_tool_use ORDER BY at DESC, thread_id, message_at DESC LIMIT ?1",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map(params![i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(store_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (thread, message_at, at, tool, target, connection, result) = row.map_err(store_err)?;
        let (Ok(thread_id), Some(tool)) = (thread.parse(), ToolKind::from_column(&tool)) else {
            continue;
        };
        out.push(ToolUseRow {
            thread_id,
            message_at,
            at,
            tool,
            target,
            connection_id: connection.and_then(|c| c.parse().ok()),
            result,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::AiMessage;
    use crate::ai::diagram::DiagramProposal;
    use crate::ai::diagram_tool::{DiagramOp, DropReason, ProposedChange};
    use crate::ai::sent::{AnswerRecord, OutlineSent, SentRecord, ToolOutcome};
    use crate::store::AppStore;
    use uuid::Uuid;

    fn change(index: u32, dropped: bool) -> ProposedChange {
        ProposedChange {
            index,
            op: DiagramOp::RemoveNode {
                target: "A".into(),
                frame: None,
            },
            status: if dropped {
                ChangeStatus::Dropped {
                    reason: DropReason::UnknownShape,
                    message: "m".into(),
                }
            } else {
                ChangeStatus::Ok
            },
            depends_on: Vec::new(),
            frame: None,
        }
    }

    fn tool_use(proposed: u32, dropped: u32, outcome: Option<u32>) -> ToolUse {
        ToolUse {
            tool: "propose_diagram_changes".into(),
            file: "orders".into(),
            input: "{}".into(),
            proposal: DiagramProposal {
                file: "orders".into(),
                base_hash: "h".into(),
                changes: (0..proposed).map(|i| change(i, i < dropped)).collect(),
            },
            outcome: outcome.map(|accepted| ToolOutcome {
                accepted,
                rejected: 0,
                auto: false,
                at: 9,
            }),
        }
    }

    fn assistant(at: i64, record: AnswerRecord) -> AiMessage {
        AiMessage {
            role: AiRole::Assistant,
            text: "a".into(),
            context: Vec::new(),
            at,
            record: Some(record),
            topic: None,
            connection_id: None,
            database: None,
            kinds: Vec::new(),
            tables: Vec::new(),
            action: None,
            asked_in: None,
        }
    }

    fn thread_of(messages: Vec<AiMessage>) -> AiThread {
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

    fn diagram_record(use_: ToolUse) -> AnswerRecord {
        AnswerRecord {
            tool_use: Some(use_),
            ..AnswerRecord::default()
        }
    }

    fn pick_record(picked: u32, tables: u32) -> AnswerRecord {
        AnswerRecord {
            sent: Some(SentRecord {
                outline: Some(OutlineSent {
                    picked_tables: picked,
                    tables,
                    ..OutlineSent::default()
                }),
                ..SentRecord::default()
            }),
            ..AnswerRecord::default()
        }
    }

    fn result_of(m: AiMessage) -> (String, String) {
        let rows = rows_of(&thread_of(vec![m]));
        assert_eq!(rows.len(), 1);
        (rows[0].target.clone(), rows[0].result.clone())
    }

    #[test]
    fn result_texts() {
        let (target, result) = result_of(assistant(1, diagram_record(tool_use(4, 0, None))));
        assert_eq!(
            (target.as_str(), result.as_str()),
            ("orders.flow", "4 proposed")
        );
        let (_, result) = result_of(assistant(1, diagram_record(tool_use(4, 1, None))));
        assert_eq!(result, "Checker dropped 1 of 4");
        let (_, result) = result_of(assistant(1, diagram_record(tool_use(1204, 1, None))));
        assert_eq!(result, "Checker dropped 1 of 1,204");
        // An outcome wins over the drops.
        let (_, result) = result_of(assistant(1, diagram_record(tool_use(4, 1, Some(3)))));
        assert_eq!(result, "4 proposed, 3 accepted");
        let (target, result) = result_of(assistant(1, pick_record(1204, 2000)));
        assert_eq!(target, "");
        assert_eq!(result, "1,204 of 2,000 tables");
        // A thread saved before 11h has no table count: the row names the picked ones only.
        let (_, result) = result_of(assistant(1, pick_record(3, 0)));
        assert_eq!(result, "3 tables");
    }

    #[test]
    fn two_messages_at_the_same_time_still_save() {
        let dir = tempfile::tempdir().unwrap();
        let s = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let t = thread_of(vec![
            assistant(7, diagram_record(tool_use(2, 0, None))),
            assistant(7, diagram_record(tool_use(3, 0, None))),
        ]);
        s.save_ai_thread(&t).unwrap();
        let rows = recent(s.conn(), 20).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].result, "3 proposed");
    }

    #[test]
    fn recent_is_newest_first_and_capped() {
        let dir = tempfile::tempdir().unwrap();
        let s = AppStore::open(&dir.path().join("app.sqlite")).unwrap();
        let t = thread_of(
            (1..=5)
                .map(|i| assistant(i * 10, diagram_record(tool_use(i as u32, 0, None))))
                .collect(),
        );
        s.save_ai_thread(&t).unwrap();
        let rows = recent(s.conn(), 3).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.at).collect::<Vec<_>>(),
            vec![50, 40, 30]
        );
        assert_eq!(rows[0].result, "5 proposed");
        assert_eq!(rows[0].tool, ToolKind::ProposeDiagramChanges);
        assert_eq!(recent(s.conn(), 20).unwrap().len(), 5);
    }

    #[test]
    fn a_message_without_either_has_no_row() {
        let t = thread_of(vec![assistant(1, AnswerRecord::default())]);
        assert!(rows_of(&t).is_empty());
    }

    #[test]
    fn kinds_use_camel_case() {
        assert_eq!(
            serde_json::to_value(ToolKind::PickTables).unwrap(),
            serde_json::json!("pickTables")
        );
        assert_eq!(
            serde_json::to_value(ToolKind::ProposeDiagramChanges).unwrap(),
            serde_json::json!("proposeDiagramChanges")
        );
    }
}
