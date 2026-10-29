//! The chat title written by the AI: one short call after a chat's first
//! answer, to the Ask's own endpoint and model, that sends only the first question (cut to
//! 300 characters) and the first 1,000 characters of the first answer, both cleaned as the
//! thread's history is. No schema, no rows, no tools, thinking off, 24 tokens. A failed call
//! is tried once more on the next answer and never again; a title the user wrote is never
//! replaced, and Contura never retitles a chat on its own after its first AI title.
//!
//! The constants here are always named with their path (`title::TITLE_CHARS`): the rule's
//! title has its own `memory::TITLE_CHARS`.

use serde::{Deserialize, Serialize};

use crate::ai::budget::estimate_tokens;
use crate::ai::compact::{CallFailed, request_tokens, summary_call_with, summary_request};
use crate::ai::context::cards::cleaner;
use crate::ai::log::{Level, Log, error_kind};
use crate::ai::memory::{AskFacts, TitleBy, Turn, access_now, message_allowed};
use crate::ai::models::ModelInfo;
use crate::ai::preview::{CatalogReader, Gathered, Recall, long_secrets, others_access};
use crate::ai::provider::{AiProvider, ChatRequest};
use crate::ai::rails::{Secrets, new_boundary};
use crate::ai::request::{ItemKind, Switches};
use crate::ai::sent::CallKind;
use crate::ai::{AiAccess, AiError, AiMessage, AiRole, AiSettings, AiThread, ThreadId};
use crate::error::{Error, Result};
use crate::model::{ConnectionId, GroupId};

/// The title call's answer, in tokens.
pub const TITLE_MAX_TOKENS: u32 = 24;
/// The first question goes cut to this many characters (ruling R3).
pub const TITLE_QUESTION_CHARS: usize = 300;
/// The first answer goes cut to this many characters.
pub const TITLE_ANSWER_CHARS: usize = 1_000;
/// A title keeps at most this many words.
pub const TITLE_WORDS: usize = 6;
/// A title keeps at most this many characters, cut at a word end.
pub const TITLE_CHARS: usize = 60;
/// The title calls a chat gets: the first, and one retry on the next answer.
pub const TITLE_TRIES: u8 = 2;
/// The answers a chat may hold for the call still to go: the first, or the retry's.
const TITLE_ANSWERS: usize = 2;

/// What the webview asks for once a turn is stored: a title for `thread_id`, from the
/// Ask's own settings and model. `place` registers the call as `title:<place>`, so it
/// never makes the next question in that place `Busy`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NameChatRequest {
    pub request_id: String,
    pub place: String,
    pub group_id: Option<GroupId>,
    pub thread_id: ThreadId,
    /// `None` asks the settings' model.
    #[serde(default)]
    pub model: Option<String>,
    /// The Ask's Sends switches: `ItemKind::Title` here makes no call.
    #[serde(default)]
    pub off: Vec<ItemKind>,
}

/// The key a title call is registered under: never the place itself, so an Ask there is
/// never refused while the title is being written.
pub fn title_place(place: &str) -> String {
    format!("title:{place}")
}

/// The first question and the first answer as the title call sends them: cleaned as the
/// history replay is (invisible characters, saved keys and passwords), then cut.
pub fn title_texts(question: &str, answer: &str, secrets: &Secrets) -> (String, String) {
    let exact = long_secrets(secrets);
    let clean = cleaner(&exact);
    (
        cut(&clean(question), TITLE_QUESTION_CHARS),
        cut(&clean(answer), TITLE_ANSWER_CHARS),
    )
}

fn cut(text: &str, chars: usize) -> String {
    text.trim().chars().take(chars).collect::<String>()
}

/// The title call's request: the summary calls' shape (no tools, thinking off, framed as
/// history) with the title's system line and 24 tokens. `question` and `answer` are
/// expected cleaned; they are cut here again to 300 and 1,000 characters.
pub fn title_request(model: &ModelInfo, question: &str, answer: &str) -> ChatRequest {
    let question = cut(question, TITLE_QUESTION_CHARS);
    let answer = cut(answer, TITLE_ANSWER_CHARS);
    let tokens = estimate_tokens(&question, false).saturating_add(estimate_tokens(&answer, false));
    let turn = Turn {
        question,
        answer,
        asked_in: None,
        at: 0,
        tokens,
    };
    summary_request(model, CallKind::Title, &[turn], None, &new_boundary())
}

/// The model's reply as a title, or `None` when nothing is left: its first non-empty line,
/// without quotes, backticks, `#` or a trailing period, Unicode dashes (U+2010 to U+2015)
/// and the minus sign (U+2212) and " - " turned into a space, white space collapsed, the first character upper case, cut to 6 words and
/// 60 characters at a word end. It stays text: nothing in it is ever read as markup.
pub fn clean_title(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let unquoted: String = line
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '"' | '`' | '#' | '\u{201C}' | '\u{201D}' | '\u{00AB}' | '\u{00BB}'
            )
        })
        .map(|c| {
            // Hyphen, non-breaking hyphen, figure, en, em and horizontal bar dashes, and the
            // minus sign.
            if matches!(
                c,
                '\u{2010}'
                    | '\u{2011}'
                    | '\u{2012}'
                    | '\u{2013}'
                    | '\u{2014}'
                    | '\u{2015}'
                    | '\u{2212}'
            ) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let unquoted = unquoted.replace(" - ", " ");
    let quotes: &[char] = &['\'', '\u{2018}', '\u{2019}'];
    let words: Vec<&str> = unquoted
        .trim()
        .trim_matches(quotes)
        .split_whitespace()
        // A dash standing alone between words, or left at a word's end.
        .map(|w| w.trim_matches('-'))
        .filter(|w| !w.is_empty())
        .collect();
    let mut out = String::new();
    for w in words.iter().take(TITLE_WORDS) {
        let extra = usize::from(!out.is_empty()) + w.chars().count();
        if out.chars().count() + extra > TITLE_CHARS {
            if out.is_empty() {
                out = w.chars().take(TITLE_CHARS).collect();
            }
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    let out = out.trim_end_matches(['.', ' ']).trim_end_matches(quotes);
    let mut chars = out.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().chain(chars).collect())
}

/// The title call as Sends shows it: an estimate (`exact` false) of the
/// request with the first question and a 1,000-character answer; no call is made.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TitlePreview {
    pub bytes: u32,
    pub tokens: u32,
    /// Always false: the answer is not written yet, so the size is an estimate.
    pub exact: bool,
    /// False when the Chat title row is switched off: no call is made.
    pub on: bool,
}

/// Whether a stored thread may still get its AI title: the rule's title, a try left, and
/// at most `answers` answers.
fn may_name(thread: &AiThread, answers: usize) -> bool {
    thread.title_by == TitleBy::Rule
        && thread.title_tries < TITLE_TRIES
        && answers_in(thread) <= answers
}

fn answers_in(thread: &AiThread) -> usize {
    thread
        .messages
        .iter()
        .filter(|m| m.role == AiRole::Assistant)
        .count()
}

/// Whether a turn sent sample rows or literal values. Controller ruling (Task 5 review,
/// Minor 1): such a first turn is never named, since the gate on history needs those
/// switches and the title call carries none; privacy first. The answer may lean on the rows.
fn sent_values(kinds: &[ItemKind]) -> bool {
    kinds
        .iter()
        .any(|k| matches!(k, ItemKind::Rows | ItemKind::Values))
}

/// The Chat title row of an Ask's preview: `Some` when the Ask would be followed by a title
/// call (a new chat, or one with the rule's title, a try left and at most one answer stored;
/// the setting on; the Ask's own Connection not at Never; the first turn sending no sample
/// rows or literal values, `sent_values`). A Home Ask has no Connection and is named.
/// `kinds` are what this Ask would send (its stamp).
pub(crate) fn title_preview(
    settings: &AiSettings,
    model: &ModelInfo,
    g: &Gathered,
    recall: &Recall,
    kinds: &[ItemKind],
) -> Option<TitlePreview> {
    let req = &g.req;
    if !settings.name_chats || (req.connection_id.is_some() && g.access == AiAccess::Never) {
        return None;
    }
    // The first turn: this Ask's own when no answer is stored yet, else the stored one.
    let first = recall
        .source
        .as_ref()
        .filter(|t| answers_in(t) > 0)
        .and_then(first_turn);
    let others = recall.others.as_deref().unwrap_or_default();
    let question = match recall.source.as_ref() {
        Some(t) if !may_name(t, 1) => return None,
        _ => match first {
            Some((q, a)) if sent_values(&q.kinds) || sent_values(&a.kinds) => return None,
            // The call's own gate, on the access the recall read (final review M2).
            Some((q, a)) if !first_turn_passes(q, a, others) => return None,
            Some((q, _)) => q.text.clone(),
            None if sent_values(kinds) => return None,
            None => req.question.clone(),
        },
    };
    let (question, _) = title_texts(&question, "", g.secrets());
    let chat = title_request(model, &question, &"x".repeat(TITLE_ANSWER_CHARS));
    let bytes = chat.system.iter().map(|b| b.text.len()).sum::<usize>()
        + chat.messages.iter().map(|m| m.text.len()).sum::<usize>();
    Some(TitlePreview {
        bytes: u32::try_from(bytes).unwrap_or(u32::MAX),
        tokens: request_tokens(&chat),
        exact: false,
        on: !req.off.contains(&ItemKind::Title),
    })
}

/// The thread's first question and the first answer after it.
fn first_turn(thread: &AiThread) -> Option<(&AiMessage, &AiMessage)> {
    let at = thread
        .messages
        .iter()
        .position(|m| m.role == AiRole::User)?;
    let answer = thread.messages[at + 1..]
        .iter()
        .find(|m| m.role != AiRole::Notice)?;
    (answer.role == AiRole::Assistant).then_some((&thread.messages[at], answer))
}

/// Whether the first turn may go to the AI for its title: the question and
/// the answer each pass the gate on history at their own Connection's current access, and
/// no Connection the question was asked on or across is at Never or deleted. A Home turn
/// (no Connection) goes when it carried the conversation only.
async fn first_turn_allowed(
    catalog: &dyn CatalogReader,
    thread: &AiThread,
    q: &AiMessage,
    a: &AiMessage,
    log: &mut Log,
) -> bool {
    let others = others_access(catalog, thread, log).await;
    first_turn_passes(q, a, &others)
}

/// `first_turn_allowed` on Connection access already read: shared with the Sends row
/// (`title_preview`), so the row shows only when the call would go.
fn first_turn_passes(q: &AiMessage, a: &AiMessage, others: &[(ConnectionId, AiAccess)]) -> bool {
    // No Ask runs here: every Connection is read at its own current access. The switches
    // stay off: a turn that sent sample rows or literal values is never named (controller
    // ruling, Task 5 review Minor 1; `sent_values`), and the preview hides its row too.
    let facts = AskFacts {
        connection_id: None,
        database: None,
        tables: &[],
    };
    let named = q
        .connection_id
        .iter()
        .chain(q.asked_in.iter().flat_map(|i| i.also.iter()));
    for id in named {
        if access_now(*id, others) == AiAccess::Never {
            return false;
        }
    }
    [q, a]
        .iter()
        .all(|m| message_allowed(m, &facts, AiAccess::Never, others, Switches::default()))
}

/// Whether a title call for `req` may go, from the setting and the stored thread alone
/// (final review M1): the switch, the place, the rule's title with a try left, at most 2
/// answers, and a first answer with text. The command checks it before reading any key
/// from the keyring, so a chat that will never be named costs no keyring read.
pub fn title_wanted(name_chats: bool, thread: Option<&AiThread>, req: &NameChatRequest) -> bool {
    if !name_chats || req.off.contains(&ItemKind::Title) {
        return false;
    }
    thread.filter(|t| t.place == req.place).is_some_and(|t| {
        may_name(t, TITLE_ANSWERS) && first_turn(t).is_some_and(|(_, a)| !a.text.trim().is_empty())
    })
}

/// Names the chat `req.thread_id` once its first answer is stored. Refuses
/// quietly (`None`, no call, no try counted) when the setting is off, the Ask's `off` holds
/// `ItemKind::Title`, the title is not the rule's, no try is left, the thread holds more
/// than 2 answers, or the first turn may not go (`first_turn_allowed`). The call goes
/// through the summary calls' path with `CallKind::Title`; its reply is cleaned
/// (`clean_title`) and stored as the AI's title unless the user renamed the chat
/// meanwhile. A failure (an error, or a reply with no title) adds one to `title_tries`;
/// a cancelled call counts none. The call's log lines (source `title`) and its record
/// (`SentRecord.title`) are written into the record of the answer it followed.
/// `updated_at` never changes, so the list keeps its order.
pub async fn name_chat(
    provider: &dyn AiProvider,
    catalog: &dyn CatalogReader,
    settings: &AiSettings,
    model: &ModelInfo,
    secrets: &Secrets,
    req: &NameChatRequest,
    log: &mut Log,
) -> Result<Option<String>> {
    let store = catalog.threads();
    let thread = store.thread(req.thread_id)?;
    let Some(thread) = thread.filter(|t| title_wanted(settings.name_chats, Some(t), req)) else {
        return Ok(None);
    };
    let Some((q, a)) = first_turn(&thread) else {
        return Ok(None);
    };
    if !first_turn_allowed(catalog, &thread, q, a, log).await {
        return Ok(None);
    }
    // The call follows the newest answer: its log is where the user looks.
    let answer_at = thread
        .messages
        .iter()
        .rev()
        .find(|m| m.role == AiRole::Assistant)
        .map_or(a.at, |m| m.at);
    let exact_secrets = long_secrets(secrets);
    let (question, answer) = title_texts(&q.text, &a.text, &exact_secrets);
    let chat = title_request(model, &question, &answer);
    let from = log.lines.len();
    log.push(
        Level::Info,
        "title",
        &[
            ("model", model.id.clone()),
            ("sends", "question_and_answer_only".into()),
        ],
    );
    let out = summary_call_with(
        provider,
        model,
        chat,
        CallKind::Title,
        settings.keep_exact_text,
        &exact_secrets,
        log,
        &|_| {},
    )
    .await;
    let (title, sent) = match out {
        Ok((text, mut sent)) => {
            sent.messages = 2;
            match clean_title(&text) {
                Some(t) => (Some(t), Some(sent)),
                None => {
                    log.push(
                        Level::Warn,
                        "title",
                        &[("error", error_kind(&Error::Ai(AiError::BadResponse)))],
                    );
                    (None, Some(sent))
                }
            }
        }
        Err(f) => {
            let CallFailed { error, sent } = *f;
            if matches!(error, Error::Cancelled | Error::Ai(AiError::Cancelled)) {
                return Err(error);
            }
            log.push(Level::Warn, "title", &[("error", error_kind(&error))]);
            (
                None,
                sent.map(|mut s| {
                    s.messages = 2;
                    s
                }),
            )
        }
    };
    let named = match &title {
        Some(t) => store.set_title(thread.id, t, TitleBy::Ai)?,
        None => {
            store.title_failed(thread.id)?;
            false
        }
    };
    let lines = log.lines.get(from..).unwrap_or_default().to_vec();
    store.record_title_call(thread.id, answer_at, sent.as_ref(), &lines)?;
    // The user renamed it meanwhile: their title stays.
    Ok(title.filter(|_| named))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::AiProviderKind;
    use crate::ai::models::info_for;
    use crate::ai::provider::Thinking;

    fn model() -> ModelInfo {
        let s = AiSettings {
            provider: Some(AiProviderKind::Groq),
            model: "llama-3.3-70b-versatile".into(),
            ..AiSettings::default()
        };
        info_for(AiProviderKind::Groq, None, &s.model, None, &s)
    }

    fn all_text(chat: &ChatRequest) -> String {
        let mut out: Vec<&str> = chat.system.iter().map(|b| b.text.as_str()).collect();
        out.extend(chat.messages.iter().map(|m| m.text.as_str()));
        out.join("\n")
    }

    #[test]
    fn clean_title_cases() {
        assert_eq!(
            clean_title("\"Unpaid clients to date.\"").as_deref(),
            Some("Unpaid clients to date")
        );
        assert_eq!(
            clean_title("unpaid clients \u{2013} to date").as_deref(),
            Some("Unpaid clients to date")
        );
        assert_eq!(
            clean_title("Unpaid clients \u{2014} to date - this year").as_deref(),
            Some("Unpaid clients to date this year")
        );
        let long = (1..=40)
            .map(|i| format!("word{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let t = clean_title(&long).unwrap();
        assert_eq!(t, "Word1 word2 word3 word4 word5 word6");
        assert!(t.split_whitespace().count() <= TITLE_WORDS);
        let wide = "Supercalifragilistic expialidocious extraordinarily long words here";
        let t = clean_title(wide).unwrap();
        assert!(t.chars().count() <= TITLE_CHARS, "{t}");
        assert!(wide.starts_with(&t), "cut at a word end: {t}");
        for dash in ['\u{2010}', '\u{2011}', '\u{2012}', '\u{2015}', '\u{2212}'] {
            assert_eq!(
                clean_title(&format!("unpaid{dash}clients {dash} to date")).as_deref(),
                Some("Unpaid clients to date"),
                "{dash:?}"
            );
        }
        assert_eq!(clean_title("\n\n"), None);
        assert_eq!(clean_title("\"\" ."), None);
        assert_eq!(clean_title("<b>Hi</b>").as_deref(), Some("<b>Hi</b>"));
        assert_eq!(
            clean_title("\n## `Late invoices`\nmore").as_deref(),
            Some("Late invoices")
        );
    }

    #[test]
    fn the_request_has_no_tools_no_thinking_and_24_tokens() {
        let chat = title_request(&model(), "Who has not paid?", "The invoices table.");
        assert!(chat.tools.is_none());
        assert_eq!(chat.thinking, Thinking::Off);
        assert_eq!(chat.max_tokens, TITLE_MAX_TOKENS);
        assert_eq!(chat.max_tokens, 24);
        assert_eq!(chat.temperature, None);
        assert_eq!(chat.model, model().id);
        assert_eq!(chat.messages.len(), 1);
        assert!(chat.system.iter().all(|b| !b.cache_mark));
    }

    /// P32: the system line asks for at most 6 words, sentence case, the question's
    /// language and no dash, title only.
    #[test]
    fn the_request_asks_for_six_words_in_the_questions_language() {
        let chat = title_request(&model(), "q", "a");
        let system = chat.system[0].text.as_str();
        assert!(system.contains("at most 6 words"), "{system}");
        assert!(system.contains("sentence case"), "{system}");
        assert!(
            system.contains("language of the user's question"),
            "{system}"
        );
        assert!(system.contains("no dash"), "{system}");
        assert!(system.contains("only the title"), "{system}");
        assert!(!system.contains('\u{2013}') && !system.contains('\u{2014}'));
    }

    #[test]
    fn the_request_sends_the_first_question_and_1000_answer_characters_cleaned() {
        let key = "gsk_live_0123456789abcdefABCDEF";
        let secrets = Secrets {
            keys: vec![key.into()],
            passwords: Vec::new(),
        };
        let question = format!("{}{}", "q".repeat(4_990), "QEND12345");
        let answer = format!("Use key {key} here. {}", "a".repeat(2_000));
        let (q, a) = title_texts(&question, &answer, &secrets);
        assert_eq!(q.chars().count(), TITLE_QUESTION_CHARS);
        assert_eq!(a.chars().count(), TITLE_ANSWER_CHARS);
        let chat = title_request(&model(), &q, &a);
        let text = all_text(&chat);
        assert!(!text.contains(key), "a saved key never goes");
        assert!(
            !text.contains("QEND"),
            "the question is cut to 300 characters"
        );
        assert!(text.contains(&"q".repeat(300)));
        assert!(!text.contains(&"q".repeat(301)));
        assert!(text.contains("history"), "framed as history: {text}");
        // About 400 tokens with a full question and a short answer.
        let short = title_request(
            &model(),
            &q,
            "Join invoices to payments and keep the unpaid ones.",
        );
        assert!(request_tokens(&short) <= 400, "{}", request_tokens(&short));
        // Cut again when given longer text.
        let raw = title_request(&model(), &question, &answer);
        assert!(!all_text(&raw).contains("QEND"));
    }
}
