//! The execution rail (Layer 0, R0.1): which tool a request may carry, and every tool call
//! the model makes, checked before anything is shown. A database Ask carries no tool; a
//! diagram Ask carries `propose_diagram_changes` and nothing else. No tool result is ever
//! sent back. This is the only place a `ToolSpec` is built.

use crate::ai::AiError;
use crate::ai::diagram_tool::{
    INPUT_CAP, ProposeInput, TOOL_DESCRIPTION, TOOL_NAME, clean_input, input_schema,
};
use crate::ai::log::{Level, Log};
use crate::ai::provider::{ChatRequest, ToolSpec};
use crate::error::{Error, Result};

use super::{Secrets, redact_secrets, strip_invisible};

/// The most of a rejected tool name kept, in characters.
pub const TOOL_NAME_CHARS: usize = 64;

/// The tools a request may carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolsAllowed {
    /// Every database Ask (R0.1): no `tools` field at all.
    None,
    /// A diagram Ask: `propose_diagram_changes` only.
    DiagramTool,
}

/// The tool definition a request with `allowed` carries.
pub fn tool_for(allowed: ToolsAllowed) -> Option<ToolSpec> {
    match allowed {
        ToolsAllowed::None => None,
        ToolsAllowed::DiagramTool => Some(ToolSpec {
            name: TOOL_NAME.into(),
            description: TOOL_DESCRIPTION.into(),
            input_schema: input_schema(),
        }),
    }
}

/// A model-written tool name as the error card may show it: no invisible characters, the
/// ends trimmed, every secret in `secrets` replaced (R2.1), at most 64 characters. Never
/// logged.
fn shown_name(name: &str, secrets: &Secrets) -> String {
    let (stripped, _) = strip_invisible(name);
    let (redacted, _) = redact_secrets(stripped.trim(), secrets);
    redacted.chars().take(TOOL_NAME_CHARS).collect()
}

const SOURCE: &str = "rail.execution";

/// The Warn line of a stopped call or request: a reason code and counts, never a name or
/// the input.
fn stop(log: &mut Log, e: AiError, reason: &str, counts: &[(&str, usize)]) -> Error {
    let mut fields = vec![
        ("outcome", "stop".to_string()),
        ("reason", reason.to_string()),
    ];
    fields.extend(counts.iter().map(|(k, n)| (*k, n.to_string())));
    log.push(Level::Warn, SOURCE, &fields);
    Error::Ai(e)
}

pub struct ExecutionRail {
    pub allowed: ToolsAllowed,
    /// The saved key and passwords, matched exactly in a rejected tool name before the
    /// card shows it. Empty where no call can come back (a request check only).
    pub secrets: Secrets,
}

impl ExecutionRail {
    /// A rail with no secrets: enough for `check_request`.
    pub fn new(allowed: ToolsAllowed) -> Self {
        Self {
            allowed,
            secrets: Secrets::default(),
        }
    }

    /// Stops a request whose tools are not exactly `tool_for(allowed)`: Contura built it
    /// wrong, so nothing is sent (`Internal`).
    pub fn check_request(&self, req: &ChatRequest, log: &mut Log) -> Result<()> {
        if req.tools != tool_for(self.allowed) {
            return Err(stop(log, AiError::Internal, "tools_differ", &[]));
        }
        let tools = req.tools.as_ref().map_or("none", |t| t.name.as_str());
        log.push(
            Level::Info,
            SOURCE,
            &[("outcome", "pass".into()), ("tools", tools.into())],
        );
        Ok(())
    }

    /// Checks one tool call: a name this Ask does not offer is `ToolRejected`; an input
    /// that is empty, over 64 KB or not a proposal is `BadToolInput`. A passing input comes
    /// back cleaned (invisible characters out, ends trimmed). Logs reason codes and counts
    /// only, never the name or the input.
    pub fn check_call(&self, name: &str, input: &str, log: &mut Log) -> Result<ProposeInput> {
        // A database Ask offers no tool, so every name is another tool's.
        if self.allowed != ToolsAllowed::DiagramTool || name != TOOL_NAME {
            let e = AiError::ToolRejected {
                name: shown_name(name, &self.secrets),
            };
            return Err(stop(
                log,
                e,
                "other_tool",
                &[("nameChars", name.chars().count())],
            ));
        }
        // Anthropic sends a call with no input deltas as "": nothing to read.
        if input.trim().is_empty() {
            return Err(stop(log, AiError::BadToolInput, "empty_input", &[]));
        }
        if input.len() > INPUT_CAP {
            return Err(stop(
                log,
                AiError::BadToolInput,
                "over_cap",
                &[("bytes", input.len())],
            ));
        }
        let Ok(parsed) = serde_json::from_str::<ProposeInput>(input) else {
            return Err(stop(
                log,
                AiError::BadToolInput,
                "not_a_proposal",
                &[("bytes", input.len())],
            ));
        };
        let clean = clean_input(parsed);
        log.push(
            Level::Info,
            SOURCE,
            &[
                ("outcome", "pass".into()),
                ("ops", clean.ops.len().to_string()),
            ],
        );
        Ok(clean)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::models::MaxTokensField;
    use crate::ai::provider::{ChatMessage, ChatRole, Thinking};

    const GOOD: &str = r#"{"file":"orders","base_hash":"00000000000000ff","ops":[{"add_node":{"name":" Check\u200b "}}]}"#;

    fn request(tools: Option<ToolSpec>) -> ChatRequest {
        ChatRequest {
            model: "m".into(),
            system: Vec::new(),
            messages: vec![ChatMessage {
                role: ChatRole::User,
                text: "q".into(),
            }],
            max_tokens: 10,
            temperature: None,
            thinking: Thinking::Off,
            max_tokens_field: MaxTokensField::MaxTokens,
            tools,
        }
    }

    fn rail(allowed: ToolsAllowed) -> ExecutionRail {
        ExecutionRail::new(allowed)
    }

    /// No field of any line holds a name.
    fn no_name_field(log: &Log) {
        for line in &log.lines {
            assert!(!line.fields.iter().any(|(k, _)| k == "name"), "{line:?}");
        }
    }

    fn field<'a>(log: &'a Log, key: &str) -> Option<&'a str> {
        log.lines
            .last()?
            .fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn no_input_in_log(log: &Log, input: &str) {
        for line in &log.lines {
            for (_, v) in &line.fields {
                assert!(input.is_empty() || !v.contains(input), "{line:?}");
                assert!(!v.contains("ops"), "{line:?}");
            }
        }
    }

    #[test]
    fn tool_for_builds_only_the_diagram_tool() {
        assert_eq!(tool_for(ToolsAllowed::None), None);
        let spec = tool_for(ToolsAllowed::DiagramTool).unwrap();
        assert_eq!(spec.name, TOOL_NAME);
        assert_eq!(spec.description, TOOL_DESCRIPTION);
        assert_eq!(spec.input_schema, input_schema());
    }

    #[test]
    fn check_request_passes_the_allowed_tools() {
        let mut log = Log::new();
        rail(ToolsAllowed::None)
            .check_request(&request(None), &mut log)
            .unwrap();
        let line = log.lines.last().unwrap();
        assert_eq!(line.source, "rail.execution");
        assert_eq!(line.level, Level::Info);
        assert_eq!(
            line.fields,
            vec![
                ("outcome".into(), "pass".into()),
                ("tools".into(), "none".into())
            ]
        );
        let mut log = Log::new();
        rail(ToolsAllowed::DiagramTool)
            .check_request(&request(tool_for(ToolsAllowed::DiagramTool)), &mut log)
            .unwrap();
        assert_eq!(field(&log, "tools"), Some(TOOL_NAME));
    }

    #[test]
    fn request_with_other_tools_is_stopped() {
        let other = ToolSpec {
            name: "run_sql".into(),
            description: "Runs SQL.".into(),
            input_schema: serde_json::json!({}),
        };
        let mut changed = tool_for(ToolsAllowed::DiagramTool).unwrap();
        changed.description.push_str(" And reads rows.");
        let cases = [
            (ToolsAllowed::None, Some(other.clone())),
            (ToolsAllowed::None, tool_for(ToolsAllowed::DiagramTool)),
            (ToolsAllowed::DiagramTool, None),
            (ToolsAllowed::DiagramTool, Some(other)),
            (ToolsAllowed::DiagramTool, Some(changed)),
        ];
        for (allowed, tools) in cases {
            let mut log = Log::new();
            let got = rail(allowed).check_request(&request(tools), &mut log);
            assert!(
                matches!(got, Err(Error::Ai(AiError::Internal))),
                "{allowed:?} {got:?}"
            );
            let line = log.lines.last().unwrap();
            assert_eq!(line.level, Level::Warn);
            assert_eq!(field(&log, "outcome"), Some("stop"));
            assert_eq!(field(&log, "reason"), Some("tools_differ"));
            assert!(!line.fields.iter().any(|(_, v)| v.contains("run_sql")));
        }
    }

    #[test]
    fn other_tool_name_is_rejected() {
        let mut log = Log::new();
        let input = r#"{"sql":"drop table orders"}"#;
        let got = rail(ToolsAllowed::DiagramTool).check_call("run_sql", input, &mut log);
        match got {
            Err(Error::Ai(AiError::ToolRejected { name })) => assert_eq!(name, "run_sql"),
            other => panic!("{other:?}"),
        }
        let line = log.lines.last().unwrap();
        assert_eq!(line.source, "rail.execution");
        assert_eq!(line.level, Level::Warn);
        assert_eq!(field(&log, "outcome"), Some("stop"));
        assert_eq!(field(&log, "reason"), Some("other_tool"));
        assert_eq!(field(&log, "nameChars"), Some("7"));
        no_name_field(&log);
        assert!(
            !line.fields.iter().any(|(_, v)| v.contains("run_sql")),
            "{line:?}"
        );
        no_input_in_log(&log, "drop table");
        // A near name is another name.
        for near in [
            "propose_diagram_changes\u{200B}",
            "Propose_diagram_changes",
            " propose_diagram_changes",
        ] {
            assert!(matches!(
                rail(ToolsAllowed::DiagramTool).check_call(near, GOOD, &mut Log::new()),
                Err(Error::Ai(AiError::ToolRejected { .. }))
            ));
        }
    }

    #[test]
    fn rejected_name_is_stripped_and_cut() {
        let long = format!("\u{202E}{}\u{200B}", "é".repeat(300));
        let mut log = Log::new();
        let got = rail(ToolsAllowed::DiagramTool).check_call(&long, GOOD, &mut log);
        let Err(Error::Ai(AiError::ToolRejected { name })) = got else {
            panic!("{got:?}");
        };
        assert_eq!(name, "é".repeat(TOOL_NAME_CHARS));
        assert_eq!(field(&log, "nameChars"), Some("302"));
        no_name_field(&log);
    }

    #[test]
    fn rejected_name_holding_a_saved_password_is_redacted() {
        let rail = ExecutionRail {
            allowed: ToolsAllowed::DiagramTool,
            secrets: Secrets {
                keys: vec!["gsk_live_key_0123456789".into()],
                passwords: vec!["hunter2pass".into()],
            },
        };
        let mut log = Log::new();
        for (name, shown) in [
            ("hunter2pass", "[redacted]"),
            ("run hunter2pass now", "run [redacted] now"),
            ("gsk_live_key_0123456789", "[redacted]"),
        ] {
            let got = rail.check_call(name, GOOD, &mut log);
            let Err(Error::Ai(AiError::ToolRejected { name: got })) = got else {
                panic!("{got:?}");
            };
            assert_eq!(got, shown);
        }
        no_name_field(&log);
        for line in &log.lines {
            for (_, v) in &line.fields {
                assert!(
                    !v.contains("hunter2pass") && !v.contains("gsk_"),
                    "{line:?}"
                );
            }
        }
    }

    #[test]
    fn none_allowed_rejects_the_diagram_tool() {
        let mut log = Log::new();
        let got = rail(ToolsAllowed::None).check_call(TOOL_NAME, GOOD, &mut log);
        match got {
            Err(Error::Ai(AiError::ToolRejected { name })) => assert_eq!(name, TOOL_NAME),
            other => panic!("{other:?}"),
        }
        assert_eq!(log.lines.last().unwrap().level, Level::Warn);
        assert_eq!(field(&log, "reason"), Some("other_tool"));
        no_name_field(&log);
        no_input_in_log(&log, "Check");
    }

    #[test]
    fn malformed_input_is_bad_tool_input() {
        let big = format!(
            r#"{{"file":"orders","base_hash":"00","ops":[{{"add_node":{{"name":"{}"}}}}]}}"#,
            "x".repeat(65 * 1024)
        );
        assert!(big.len() > INPUT_CAP);
        for input in [
            "",
            "   ",
            "{not json",
            "null",
            "[]",
            r#"{"file":"orders","base_hash":"00","ops":[{"drop_table":{"target":"A"}}]}"#,
            r#"{"file":"orders","base_hash":"00","ops":[],"sql":"select 1"}"#,
            r#"{"file":"orders","ops":[]}"#,
            big.as_str(),
        ] {
            let mut log = Log::new();
            let got = rail(ToolsAllowed::DiagramTool).check_call(TOOL_NAME, input, &mut log);
            assert!(
                matches!(got, Err(Error::Ai(AiError::BadToolInput))),
                "{:?}: {got:?}",
                &input[..input.len().min(40)]
            );
            let line = log.lines.last().unwrap();
            assert_eq!(line.level, Level::Warn);
            let reason = field(&log, "reason").unwrap();
            assert!(
                ["empty_input", "over_cap", "not_a_proposal"].contains(&reason),
                "{reason}"
            );
            if input.trim().is_empty() {
                assert_eq!(reason, "empty_input");
            }
            no_name_field(&log);
            no_input_in_log(&log, input);
        }
    }

    #[test]
    fn good_input_comes_back_cleaned() {
        let mut log = Log::new();
        let got = rail(ToolsAllowed::DiagramTool)
            .check_call(TOOL_NAME, GOOD, &mut log)
            .unwrap();
        assert_eq!(got.file, "orders");
        assert_eq!(got.base_hash, "00000000000000ff");
        assert_eq!(
            got.ops,
            vec![crate::ai::diagram_tool::DiagramOp::AddNode {
                name: "Check".into(),
                kind: None,
                id: None,
                group: None,
            }]
        );
        let line = log.lines.last().unwrap();
        assert_eq!(line.level, Level::Info);
        assert_eq!(field(&log, "outcome"), Some("pass"));
        assert_eq!(field(&log, "ops"), Some("1"));
        no_name_field(&log);
        no_input_in_log(&log, "Check");
    }
}
