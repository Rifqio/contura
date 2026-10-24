//! What the webview sends for one Ask, and the items the Sends list shows.

use serde::{Deserialize, Serialize};

use crate::ai::ThreadId;
use crate::ai::models::ModelPicks;
use crate::ai::scene::AskTab;
use crate::ai::steps::StepIn;
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
    /// This tab: what the active tab shows, rendered by the Core from `AskRequest.tab`.
    /// Its parts are gated where it is built (`scene::tab_text`).
    Tab,
    /// Recent steps: what the user did since their last question, rendered by the Core
    /// from `AskRequest.steps`. Each step is gated where it is built (`steps::render_steps`).
    Steps,
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
    /// The other Connections the tab spans (a Compare source, a Transfer side): every item
    /// is gated at the lowest access among them and the Ask's own.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<ConnectionId>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Switches {
    pub rows: bool,
    pub values: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    /// What the active tab shows, as typed fields; the Core renders the This tab item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<AskTab>,
    /// What the user did since their last question in this place, as typed steps; the
    /// Core renders the Recent steps item.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<StepIn>,
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
                tab: None,
                steps: Vec::new(),
            }
        );
        assert_eq!(serde_json::to_value(&req).unwrap(), json);
    }

    fn shop_path(name: &str) -> serde_json::Value {
        serde_json::json!({ "database": "shop", "schema": null, "name": name })
    }

    #[test]
    fn ask_tab_round_trips() {
        let tabs = [
            serde_json::json!({ "kind": "query", "title": "Untitled 1" }),
            serde_json::json!({
                "kind": "object", "title": "orders", "path": shop_path("orders"),
                "object": "table", "sort": { "column": "created_at", "descending": true },
                "filterColumns": ["status"], "hidden": ["note"], "pendingEdits": 2
            }),
            serde_json::json!({
                "kind": "visual", "title": "Orders over 1M",
                "model": {
                    "version": 1, "database": "shop", "dialect": "mysql",
                    "tables": [{ "id": "t1", "schema": null, "name": "orders", "alias": "o", "x": 0.0, "y": 0.0 }],
                    "joins": [], "columns": [], "filters": [], "groupBy": { "kind": "auto" },
                    "orderBy": [], "limit": null, "distinct": false
                },
                "sqlWritten": true, "problems": 0,
                "lastRun": { "rows": 1, "more": false, "failed": false }
            }),
            serde_json::json!({
                "kind": "design", "create": true, "path": shop_path("monthly_totals"),
                "columns": [{ "name": "id", "typeSql": "int", "nullable": false,
                    "defaultSql": null, "increment": true, "comment": null }],
                "primary": ["id"],
                "indexes": [{ "name": "i", "columns": ["id"], "unique": true, "primary": false }],
                "foreignKeys": [{ "name": "fk", "columns": ["customer_id"],
                    "target": shop_path("customers"), "targetColumns": ["id"],
                    "onDelete": "cascade", "onUpdate": null }],
                "removed": [], "comment": null, "types": ["int"]
            }),
            serde_json::json!({ "kind": "schema", "file": "shop.dbml", "tables": 3, "errorLine": null }),
            serde_json::json!({
                "kind": "compare", "source": { "kind": "model", "file": "shop.dbml" },
                "targetDatabase": "shop_staging",
                "items": [{ "kind": "changed", "object": "column", "table": "orders",
                    "name": "total", "fromType": "int", "toType": "bigint",
                    "losesData": false, "losesRows": null }],
                "added": 0, "removed": 0, "changed": 1, "notCompared": 0, "ticked": 1,
                "compared": true
            }),
            serde_json::json!({
                "kind": "transfer", "sourceDatabase": "shop", "targetDatabase": "analytics",
                "mode": "perTable",
                "tables": [{ "source": "orders", "target": "orders", "exists": true,
                    "ifExists": "emptyFirst",
                    "columns": [{ "name": "id", "targetName": "id", "sourceType": "int",
                        "targetType": "integer" }],
                    "emptiedRows": 3000 }],
                "notes": [{ "table": "orders", "column": "total", "kind": "lossy" }]
            }),
            serde_json::json!({
                "kind": "import", "file": "orders.csv", "format": "csv", "delimiter": ",",
                "encoding": "UTF-8", "target": { "kind": "table", "path": shop_path("orders") },
                "header": ["id", "note"], "mapping": [["id", "id"], ["note", null]],
                "rowsEstimate": 12000
            }),
            serde_json::json!({ "kind": "lineage", "path": shop_path("orders"), "neighbours": ["customers"] }),
            serde_json::json!({ "kind": "savedQueries" }),
            serde_json::json!({ "kind": "home" }),
            serde_json::json!({ "kind": "settings", "section": "dataFolder" }),
        ];
        for json in tabs {
            let tab: AskTab =
                serde_json::from_value(json.clone()).unwrap_or_else(|e| panic!("{json}: {e}"));
            assert_eq!(serde_json::to_value(&tab).unwrap(), json);
        }

        // On the request, with the other Connection of the tab.
        let other = uuid::Uuid::from_u128(9);
        let json = serde_json::json!({
            "requestId": "r1", "place": "ungrouped", "groupId": null, "connectionId": null,
            "database": null, "schema": null, "action": "ask", "question": "q",
            "threadId": null, "focus": { "also": [other.to_string()] },
            "tab": { "kind": "home" }
        });
        let req: AskRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.tab, Some(AskTab::Home));
        assert_eq!(req.focus.also, vec![other]);
    }

    #[test]
    fn unknown_tab_kind_is_refused() {
        let json = serde_json::json!({
            "requestId": "r1", "place": "ungrouped", "groupId": null, "connectionId": null,
            "database": null, "schema": null, "action": "ask", "question": "q",
            "threadId": null, "tab": { "kind": "spreadsheet", "cells": [["1"]] }
        });
        assert!(serde_json::from_value::<AskRequest>(json).is_err());
        let json = serde_json::json!({ "kind": "settings", "section": "keys" });
        assert!(serde_json::from_value::<AskTab>(json).is_err());
    }

    #[test]
    fn steps_round_trip() {
        use crate::ai::steps::StepVerb;
        let conn = uuid::Uuid::from_u128(7);
        let json = serde_json::json!({
            "requestId": "r1", "place": "ungrouped", "groupId": null,
            "connectionId": conn.to_string(), "database": "shop", "schema": null,
            "action": "ask", "question": "q", "threadId": null,
            "focus": {
                "sql": null, "selection": null, "error": null, "filter": null, "dbml": null,
                "tables": [], "untiedModel": false
            },
            "switches": { "rows": false, "values": false },
            "off": ["steps"], "model": null, "picks": null,
            "steps": [
                { "at": 1000, "verb": "runVisual", "tab": "visual", "title": "Orders over 1M",
                  "connectionId": conn.to_string(), "database": "shop", "schema": null,
                  "names": [], "more": 0, "count": 1, "hasMore": false, "failed": false,
                  "descending": false },
                { "at": 2000, "verb": "openTab", "tab": "settings", "title": null,
                  "connectionId": null, "database": null, "schema": null,
                  "names": ["general"], "more": 2, "count": null, "hasMore": true,
                  "failed": true, "descending": true }
            ]
        });
        let req: AskRequest = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(req.off, vec![ItemKind::Steps]);
        assert_eq!(req.steps.len(), 2);
        assert_eq!(req.steps[0].verb, StepVerb::RunVisual);
        assert_eq!(req.steps[0].connection_id, Some(conn));
        assert_eq!(req.steps[1].verb, StepVerb::OpenTab);
        assert!(req.steps[1].has_more && req.steps[1].failed && req.steps[1].descending);
        assert_eq!(serde_json::to_value(&req).unwrap(), json);

        // The flags and lists may be left out.
        let short = serde_json::json!({
            "at": 1, "verb": "vqTick", "tab": "visual", "title": null, "connectionId": null,
            "database": null, "schema": null, "count": null
        });
        let s: crate::ai::steps::StepIn = serde_json::from_value(short).unwrap();
        assert!(s.names.is_empty() && s.more == 0 && !s.has_more && !s.failed);
    }

    #[test]
    fn unknown_verb_is_refused() {
        let json = serde_json::json!({
            "requestId": "r1", "place": "ungrouped", "groupId": null, "connectionId": null,
            "database": null, "schema": null, "action": "ask", "question": "q",
            "threadId": null,
            "steps": [{ "at": 1, "verb": "typedText", "tab": "query", "title": null,
                "connectionId": null, "database": null, "schema": null, "count": null,
                "names": ["select * from t where secret = 'x'"] }]
        });
        assert!(serde_json::from_value::<AskRequest>(json).is_err());
        assert!(serde_json::from_value::<ItemKind>(serde_json::json!("steps")).is_ok());
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
        assert_eq!(req.tab, None);
        assert!(req.focus.also.is_empty());
        assert!(req.steps.is_empty());
    }
}
