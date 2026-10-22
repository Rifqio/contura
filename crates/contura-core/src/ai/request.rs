//! What the webview sends for one Ask, and the items the Sends list shows.

use serde::{Deserialize, Serialize};

use crate::ai::ThreadId;
use crate::ai::models::ModelPicks;
use crate::model::{ConnectionId, GroupId};

/// One kind of item the Ask can send.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Question,
    /// Database and schema names.
    Names,
    /// The table cards.
    Cards,
    /// The Context Tree outline of a large database, sent only by the outline call; never
    /// an item of the main Ask.
    Outline,
    Dbml,
    /// SQL, selection or filter text.
    Sql,
    Error,
    /// The Saved Queries the AI Context picked, stored masked: "Include values" never
    /// unmasks them.
    SavedQueries,
    /// Literal values left unmasked.
    Values,
    Rows,
    /// The thread's memory: the open Topic's recent turns and matching earlier summaries.
    /// Each turn and summary passed the gate on history (R1.7) when it was picked.
    History,
    /// The summary step: a Topic summary or a compaction written by the model in its own
    /// call before the Ask. Never an `Item` of the main Ask; switched off through `off`,
    /// the call is not made and Contura writes the summary by rules.
    Summary,
    /// A diagram Ask's .flow text, or its selected shape names (one per line). Diagrams
    /// are not database data: no AI access level applies, and only a diagram Ask sends it.
    Diagram,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub schema: Option<String>,
    pub name: String,
}

/// What the place the Ask came from was showing.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Focus {
    pub sql: Option<String>,
    pub selection: Option<String>,
    pub error: Option<String>,
    pub filter: Option<String>,
    pub dbml: Option<String>,
    pub tables: Vec<TableRef>,
    /// Set by the Schema Builder for a Schema Model not tied to any Connection: with no
    /// `connection_id`, its DBML may go and nothing else (R1.4).
    pub untied_model: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Switches {
    pub rows: bool,
    pub values: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    pub request_id: String,
    pub place: String,
    pub group_id: Option<GroupId>,
    pub connection_id: Option<ConnectionId>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub action: String,
    pub question: String,
    pub thread_id: Option<ThreadId>,
    #[serde(default)]
    pub focus: Focus,
    #[serde(default)]
    pub switches: Switches,
    /// Kinds the user switched off in the Sends list; it can only remove items.
    #[serde(default)]
    pub off: Vec<ItemKind>,
    /// The model picked for this Ask; `None` asks the settings' model.
    #[serde(default)]
    pub model: Option<String>,
    /// The picker's thinking and caching picks; the Core clamps them to the model.
    #[serde(default)]
    pub picks: Option<ModelPicks>,
}

/// One row of the Sends list.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: ItemKind,
    pub label: String,
    pub text: String,
    /// Why the item cannot be switched on, when it cannot.
    pub locked: Option<String>,
    pub on: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::models::ThinkingLevel;

    #[test]
    fn ask_request_round_trips_camel_case() {
        let conn = uuid::Uuid::from_u128(7);
        let json = serde_json::json!({
            "requestId": "r1",
            "place": "ungrouped",
            "groupId": null,
            "connectionId": conn.to_string(),
            "database": "shop",
            "schema": "public",
            "action": "explain",
            "question": "why slow?",
            "threadId": null,
            "focus": {
                "sql": "select 1",
                "selection": null,
                "error": null,
                "filter": null,
                "dbml": null,
                "tables": [{ "schema": "public", "name": "orders" }],
                "untiedModel": false
            },
            "switches": { "rows": true, "values": false },
            "off": ["sql"],
            "model": "openai/gpt-oss-20b",
            "picks": { "thinking": "low", "caching": true }
        });
        let req: AskRequest = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(
            req,
            AskRequest {
                request_id: "r1".into(),
                place: "ungrouped".into(),
                group_id: None,
                connection_id: Some(conn),
                database: Some("shop".into()),
                schema: Some("public".into()),
                action: "explain".into(),
                question: "why slow?".into(),
                thread_id: None,
                focus: Focus {
                    sql: Some("select 1".into()),
                    tables: vec![TableRef {
                        schema: Some("public".into()),
                        name: "orders".into(),
                    }],
                    ..Focus::default()
                },
                switches: Switches {
                    rows: true,
                    values: false,
                },
                off: vec![ItemKind::Sql],
                model: Some("openai/gpt-oss-20b".into()),
                picks: Some(ModelPicks {
                    thinking: ThinkingLevel::Low,
                    caching: true,
                }),
            }
        );
        assert_eq!(serde_json::to_value(&req).unwrap(), json);
    }

    #[test]
    fn ask_request_without_model_or_picks() {
        let json = serde_json::json!({
            "requestId": "r1",
            "place": "ungrouped",
            "groupId": null,
            "connectionId": null,
            "database": null,
            "schema": null,
            "action": "ask",
            "question": "q",
            "threadId": null
        });
        let req: AskRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.model, None);
        assert_eq!(req.picks, None);
    }
}
