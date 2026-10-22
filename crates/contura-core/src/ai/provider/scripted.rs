//! A provider that plays a fixed script, for tests.

use std::sync::Mutex;

use async_trait::async_trait;

use super::{AiProvider, ChatRequest, ListedModel, ProviderEvent};
use crate::ai::AiError;
use crate::ai::log::Log;
use crate::error::{Error, Result};

type Script = Vec<std::result::Result<ProviderEvent, AiError>>;

pub struct ScriptedProvider {
    /// Call n plays script n in order, the last one repeating; an `Err` ends the stream
    /// with that error.
    pub scripts: Vec<Script>,
    /// Each request `stream` was called with.
    pub seen: Mutex<Vec<ChatRequest>>,
}

impl ScriptedProvider {
    /// One script for every call.
    pub fn new(script: Script) -> Self {
        Self::sequence(vec![script])
    }

    /// Call n plays `scripts[n]`; the last one plays for every call after it.
    pub fn sequence(scripts: Vec<Script>) -> Self {
        Self {
            scripts,
            seen: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl AiProvider for ScriptedProvider {
    async fn stream(
        &self,
        req: &ChatRequest,
        _log: &mut Log,
        sink: &mut (dyn FnMut(ProviderEvent) + Send),
    ) -> Result<()> {
        let call = {
            let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
            seen.push(req.clone());
            seen.len() - 1
        };
        let script = self
            .scripts
            .get(call)
            .or(self.scripts.last())
            .map_or(&[][..], Vec::as_slice);
        for step in script {
            sink(step.clone().map_err(Error::Ai)?);
        }
        Ok(())
    }

    async fn models(&self, _log: &mut Log) -> Result<Vec<ListedModel>> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::models::MaxTokensField;
    use crate::ai::provider::{ChatMessage, ChatRole, PromptBlock, StopReason, Thinking};

    fn request() -> ChatRequest {
        ChatRequest {
            model: "llama-3.3-70b-versatile".into(),
            system: vec![PromptBlock {
                text: "You write SQL.".into(),
                cache_mark: false,
            }],
            messages: vec![ChatMessage {
                role: ChatRole::User,
                text: "count users".into(),
            }],
            max_tokens: 4096,
            temperature: Some(0.2),
            thinking: Thinking::Off,
            max_tokens_field: MaxTokensField::MaxTokens,
            tools: None,
        }
    }

    #[tokio::test]
    async fn scripted_provider_records_request() {
        let p = ScriptedProvider::new(vec![
            Ok(ProviderEvent::FirstByte),
            Ok(ProviderEvent::Text("SELECT".into())),
            Ok(ProviderEvent::Stop(StopReason::End)),
        ]);
        let mut got = Vec::new();
        p.stream(&request(), &mut Log::new(), &mut |e| got.push(e))
            .await
            .unwrap();
        assert_eq!(
            got,
            vec![
                ProviderEvent::FirstByte,
                ProviderEvent::Text("SELECT".into()),
                ProviderEvent::Stop(StopReason::End),
            ]
        );
        assert_eq!(*p.seen.lock().unwrap(), vec![request()]);
    }

    #[tokio::test]
    async fn sequence_plays_one_script_per_call_then_repeats_the_last() {
        let p = ScriptedProvider::sequence(vec![
            vec![Ok(ProviderEvent::Text("one".into()))],
            vec![Ok(ProviderEvent::Text("two".into()))],
        ]);
        let mut got = Vec::new();
        for _ in 0..3 {
            p.stream(&request(), &mut Log::new(), &mut |e| got.push(e))
                .await
                .unwrap();
        }
        let text = |t: &str| ProviderEvent::Text(t.into());
        assert_eq!(got, vec![text("one"), text("two"), text("two")]);
        assert_eq!(p.seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn scripted_error_ends_the_stream() {
        let p = ScriptedProvider::new(vec![
            Ok(ProviderEvent::Text("SEL".into())),
            Err(AiError::Cancelled),
            Ok(ProviderEvent::Text("ECT".into())),
        ]);
        let mut got = Vec::new();
        let err = p
            .stream(&request(), &mut Log::new(), &mut |e| got.push(e))
            .await;
        assert!(matches!(err, Err(Error::Ai(AiError::Cancelled))));
        assert_eq!(got, vec![ProviderEvent::Text("SEL".into())]);
    }
}
