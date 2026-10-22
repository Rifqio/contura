//! The rail pipeline: ordered checks over one Ask, each passing, changing or stopping it.
//! The structure of NeMo Guardrails rebuilt in the Core, with no model calls.

pub mod execution;
pub mod functions;
pub mod input;
pub mod output;
pub mod retrieval;

pub use input::{
    InputRail, Secrets, allowed, cap_chars, lock_reason, redact_secrets, strip_invisible,
};
pub use retrieval::{
    DIAGRAM_INJECTION_NOTE, INJECTION_NOTE, RetrievalRail, SCHEMA_CLOSE, SCHEMA_OPEN, framed_block,
    framed_text, new_boundary, schema_text,
};

use crate::ai::AiAccess;
use crate::ai::log::{Level, Log};
use crate::ai::request::Item;
use crate::error::{Error, Result};
use crate::model::DialectKind;

/// The typed items of one Ask, as the rails see them.
#[derive(Clone, Debug)]
pub struct Ask {
    pub items: Vec<Item>,
    /// Read from the stored Connection; `Never` when there is none (R1.3).
    pub access: AiAccess,
    pub dialect: Option<DialectKind>,
    pub notes: Vec<String>,
    /// R1.4: an Ask with no Connection about a Schema Model not tied to one; its DBML may go.
    pub untied_model: bool,
    /// A diagram Ask: its Diagram items go, under no AI access level; nothing of a
    /// database is in it.
    pub diagram: bool,
    /// What the input rail changed, one row per (where, rule, sent as): the Cleaning
    /// evidence.
    pub cleaned: Vec<[String; 3]>,
}

#[derive(Debug)]
pub enum RailOutcome {
    Pass,
    /// What the rail changed, in a few words.
    Changed(String),
    Stop(Error),
}

pub trait Rail {
    fn name(&self) -> &'static str;
    fn run(&self, ask: &mut Ask, log: &mut Log) -> RailOutcome;
}

/// Runs the rails in order and stops at the first `Stop`, returning its error.
/// Every outcome is logged under `rail.<name>`.
pub fn run_rails(rails: &[&dyn Rail], ask: &mut Ask, log: &mut Log) -> Result<()> {
    for rail in rails {
        let source = format!("rail.{}", rail.name());
        match rail.run(ask, log) {
            RailOutcome::Pass => log.push(Level::Info, &source, &[("outcome", "pass".into())]),
            RailOutcome::Changed(what) => log.push(
                Level::Info,
                &source,
                &[("outcome", "changed".into()), ("change", what)],
            ),
            RailOutcome::Stop(e) => {
                log.push(
                    Level::Warn,
                    &source,
                    &[("outcome", "stop".into()), ("error", e.to_string())],
                );
                return Err(e);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fixed {
        name: &'static str,
        outcome: fn() -> RailOutcome,
        ran: Cell<bool>,
    }

    impl Rail for Fixed {
        fn name(&self) -> &'static str {
            self.name
        }
        fn run(&self, _ask: &mut Ask, _log: &mut Log) -> RailOutcome {
            self.ran.set(true);
            (self.outcome)()
        }
    }

    fn fixed(name: &'static str, outcome: fn() -> RailOutcome) -> Fixed {
        Fixed {
            name,
            outcome,
            ran: Cell::new(false),
        }
    }

    #[test]
    fn pipeline_stops_at_the_first_stop_and_logs_each_outcome() {
        let a = fixed("a", || RailOutcome::Pass);
        let b = fixed("b", || RailOutcome::Changed("trimmed".into()));
        let c = fixed("c", || RailOutcome::Stop(Error::InvalidInput("no".into())));
        let d = fixed("d", || RailOutcome::Pass);
        let mut ask = Ask {
            items: Vec::new(),
            access: AiAccess::Schema,
            dialect: None,
            notes: Vec::new(),
            untied_model: false,
            diagram: false,
            cleaned: Vec::new(),
        };
        let mut log = Log::new();
        let err = run_rails(&[&a, &b, &c, &d], &mut ask, &mut log).unwrap_err();
        assert!(matches!(err, Error::InvalidInput(m) if m == "no"));
        assert!(!d.ran.get());
        let lines: Vec<(&str, Vec<(String, String)>)> = log
            .lines
            .iter()
            .map(|l| (l.source.as_str(), l.fields.clone()))
            .collect();
        assert_eq!(
            lines,
            vec![
                ("rail.a", vec![("outcome".into(), "pass".into())]),
                (
                    "rail.b",
                    vec![
                        ("outcome".into(), "changed".into()),
                        ("change".into(), "trimmed".into())
                    ]
                ),
                (
                    "rail.c",
                    vec![
                        ("outcome".into(), "stop".into()),
                        ("error".into(), "invalid input: no".into())
                    ]
                ),
            ]
        );
    }
}
