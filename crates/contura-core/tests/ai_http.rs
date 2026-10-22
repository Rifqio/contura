#[path = "support/mock_http.rs"]
mod mock_http;

use std::time::{Duration, Instant};

use contura_core::Error;
use contura_core::ai::log::{Level, Log};
use contura_core::ai::models::MaxTokensField;
use contura_core::ai::provider::anthropic::Anthropic;
use contura_core::ai::provider::http::{Call, Http, Limits, map_status};
use contura_core::ai::provider::openai::OpenAi;
use contura_core::ai::provider::{
    AiProvider, ChatMessage, ChatRequest, ChatRole, ListedModel, PromptBlock, ProviderEvent,
    StopReason, Thinking, Usage,
};
use contura_core::ai::{AiError, AiProviderKind};
use mock_http::{MockReply, serve};

const KEY: &str = "gsk_test_secret_value";

fn http() -> Http {
    Http::with_limits(Limits {
        connect: Duration::from_secs(2),
        first_byte: Duration::from_secs(2),
        idle: Duration::from_millis(200),
        answer: Duration::from_secs(30),
    })
    .unwrap()
}

fn call<'a>(url: &url::Url, secrets: &'a [String]) -> Call<'a> {
    Call {
        url: url.clone(),
        headers: vec![("content-type", "application/json".into(), false)],
        body: Some(serde_json::json!({ "model": "m" })),
        provider: AiProviderKind::Groq,
        secrets,
        deadline: Instant::now() + Duration::from_secs(30),
    }
}

fn ai(err: Error) -> AiError {
    match err {
        Error::Ai(e) => e,
        other => panic!("not an AI error: {other:?}"),
    }
}

fn retries(log: &Log) -> Vec<Vec<(String, String)>> {
    log.lines
        .iter()
        .filter(|l| l.source == "retry")
        .map(|l| l.fields.clone())
        .collect()
}

fn retry_line(attempt: &str, wait_ms: &str, reason: &str) -> Vec<(String, String)> {
    vec![
        ("attempt".into(), attempt.into()),
        ("wait_ms".into(), wait_ms.into()),
        ("reason".into(), reason.into()),
    ]
}

async fn read_all(http: &Http, resp: reqwest::Response) -> (Vec<u8>, contura_core::Result<()>) {
    let mut got = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    let result = http
        .read_stream(resp, deadline, &mut |b: &[u8]| {
            got.extend_from_slice(b);
            true
        })
        .await;
    (got, result)
}

#[tokio::test]
async fn ok_streams_bytes() {
    let mut reply = MockReply::new(200, b"data: a\n\n");
    reply
        .chunks
        .push((Duration::from_millis(50), b"data: b\n\n".to_vec()));
    let (url, server) = serve(vec![reply]).await;
    let http = http();
    let mut log = Log::new();
    let resp = http.send(&call(&url, &[]), &mut log).await.unwrap();
    let (got, result) = read_all(&http, resp).await;
    result.unwrap();
    assert_eq!(got, b"data: a\n\ndata: b\n\n");
    let heads = server.await.unwrap();
    assert_eq!(heads.len(), 1);
    assert!(heads[0].starts_with("POST /v1 HTTP/1.1"), "{}", heads[0]);
    let line = log.lines.iter().find(|l| l.source == "http").unwrap();
    let host = format!("127.0.0.1:{}", url.port().unwrap());
    assert_eq!(line.fields[0], ("host".into(), host));
    assert_eq!(line.fields[1], ("status".into(), "200".into()));
    assert_eq!(line.fields[2].0, "ms");
}

#[tokio::test]
async fn read_stream_stops_when_asked() {
    let mut reply = MockReply::new(200, b"one");
    reply
        .chunks
        .push((Duration::from_millis(500), b"two".to_vec()));
    let (url, _server) = serve(vec![reply]).await;
    let http = http();
    let resp = http.send(&call(&url, &[]), &mut Log::new()).await.unwrap();
    let mut got = Vec::new();
    http.read_stream(resp, Instant::now() + Duration::from_secs(5), &mut |b| {
        got.extend_from_slice(b);
        false
    })
    .await
    .unwrap();
    assert_eq!(got, b"one");
}

#[tokio::test]
async fn retries_500_then_ok() {
    let (url, server) = serve(vec![
        MockReply::new(500, b"oops"),
        MockReply::new(503, b"oops"),
        MockReply::new(200, b"ok"),
    ])
    .await;
    let http = http();
    let mut log = Log::new();
    let resp = http.send(&call(&url, &[]), &mut log).await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(server.await.unwrap().len(), 3);
    assert_eq!(
        retries(&log),
        vec![
            retry_line("2", "1000", "500"),
            retry_line("3", "3000", "503")
        ]
    );
    assert_eq!(log.lines.iter().filter(|l| l.source == "http").count(), 3);
}

#[tokio::test]
async fn gives_up_after_two_retries() {
    let (url, server) = serve(vec![
        MockReply::new(529, b""),
        MockReply::new(529, b""),
        MockReply::new(529, b""),
    ])
    .await;
    let err = http()
        .send(&call(&url, &[]), &mut Log::new())
        .await
        .unwrap_err();
    assert_eq!(
        ai(err),
        AiError::Overloaded {
            provider: AiProviderKind::Groq
        }
    );
    assert_eq!(server.await.unwrap().len(), 3);
}

#[tokio::test]
async fn no_retry_on_400() {
    let (url, server) = serve(vec![MockReply::new(
        400,
        br#"{"error":{"message":"model not found"}}"#,
    )])
    .await;
    let mut log = Log::new();
    let err = http().send(&call(&url, &[]), &mut log).await.unwrap_err();
    assert_eq!(
        ai(err),
        AiError::Provider {
            status: 400,
            message: "model not found".into()
        }
    );
    assert_eq!(server.await.unwrap().len(), 1);
    assert!(retries(&log).is_empty());
}

#[tokio::test]
async fn retry_after_2_is_honoured() {
    let (url, server) = serve(vec![
        MockReply::new(429, b"").header("retry-after", "2"),
        MockReply::new(200, b"ok"),
    ])
    .await;
    let mut log = Log::new();
    let started = Instant::now();
    http().send(&call(&url, &[]), &mut log).await.unwrap();
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert_eq!(server.await.unwrap().len(), 2);
    assert_eq!(retries(&log), vec![retry_line("2", "2000", "429")]);
}

#[tokio::test]
async fn long_retry_after_is_not_waited() {
    let (url, server) = serve(vec![MockReply::new(429, b"").header("retry-after", "30")]).await;
    let mut log = Log::new();
    let started = Instant::now();
    let err = http().send(&call(&url, &[]), &mut log).await.unwrap_err();
    assert_eq!(
        ai(err),
        AiError::RateLimited {
            retry_after_secs: Some(30)
        }
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(server.await.unwrap().len(), 1);
    assert!(retries(&log).is_empty());
}

#[tokio::test]
async fn backoff_never_passes_the_deadline() {
    let (url, server) = serve(vec![MockReply::new(500, b"")]).await;
    let secrets: [String; 0] = [];
    let mut c = call(&url, &secrets);
    c.deadline = Instant::now() + Duration::from_millis(800);
    let err = http().send(&c, &mut Log::new()).await.unwrap_err();
    assert!(matches!(ai(err), AiError::Provider { status: 500, .. }));
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
async fn no_retry_after_first_byte() {
    let mut reply = MockReply::new(200, b"data: a\n");
    reply.close_early = true;
    let (url, server) = serve(vec![reply]).await;
    let http = http();
    let mut log = Log::new();
    let resp = http.send(&call(&url, &[]), &mut log).await.unwrap();
    let (got, result) = read_all(&http, resp).await;
    assert_eq!(got, b"data: a\n");
    let host = format!("127.0.0.1:{}", url.port().unwrap());
    assert_eq!(ai(result.unwrap_err()), AiError::Network { host });
    assert_eq!(server.await.unwrap().len(), 1);
    assert!(retries(&log).is_empty());
}

#[tokio::test]
async fn redirect_not_followed() {
    let (url, server) = serve(vec![
        MockReply::new(302, b"").header("location", "http://127.0.0.1:9/elsewhere"),
    ])
    .await;
    let err = http()
        .send(&call(&url, &[]), &mut Log::new())
        .await
        .unwrap_err();
    assert!(
        matches!(ai(err), AiError::Provider { status: 302, .. }),
        "redirect followed"
    );
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
async fn idle_timeout() {
    let mut reply = MockReply::new(200, b"a");
    reply
        .chunks
        .push((Duration::from_millis(800), b"b".to_vec()));
    let (url, _server) = serve(vec![reply]).await;
    let http = http();
    let resp = http.send(&call(&url, &[]), &mut Log::new()).await.unwrap();
    let (got, result) = read_all(&http, resp).await;
    assert_eq!(got, b"a");
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::Timeout {
            phase: "idle".into()
        }
    );
}

#[tokio::test]
async fn first_chunk_gets_the_first_byte_limit() {
    // The head comes at once; the model then works for 1 s before the first chunk.
    let mut reply = MockReply::new(200, b"");
    reply.chunks.push((Duration::from_secs(1), b"a".to_vec()));
    reply
        .chunks
        .push((Duration::from_millis(50), b"b".to_vec()));
    let (url, _server) = serve(vec![reply]).await;
    let http = Http::with_limits(Limits {
        connect: Duration::from_secs(2),
        first_byte: Duration::from_secs(2),
        idle: Duration::from_millis(300),
        answer: Duration::from_secs(30),
    })
    .unwrap();
    let resp = http.send(&call(&url, &[]), &mut Log::new()).await.unwrap();
    let (got, result) = read_all(&http, resp).await;
    result.unwrap();
    assert_eq!(got, b"ab");
}

#[tokio::test]
async fn first_chunk_past_the_first_byte_limit_times_out() {
    let mut reply = MockReply::new(200, b"");
    reply.chunks.push((Duration::from_secs(2), b"a".to_vec()));
    let (url, _server) = serve(vec![reply]).await;
    let http = Http::with_limits(Limits {
        connect: Duration::from_secs(2),
        first_byte: Duration::from_millis(500),
        idle: Duration::from_millis(300),
        answer: Duration::from_secs(30),
    })
    .unwrap();
    let resp = http.send(&call(&url, &[]), &mut Log::new()).await.unwrap();
    let (_, result) = read_all(&http, resp).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::Timeout {
            phase: "first byte".into()
        }
    );
}

#[tokio::test]
async fn answer_deadline_ends_the_stream() {
    let mut reply = MockReply::new(200, b"a");
    for _ in 0..10 {
        reply
            .chunks
            .push((Duration::from_millis(100), b"b".to_vec()));
    }
    let (url, _server) = serve(vec![reply]).await;
    let http = http();
    let resp = http.send(&call(&url, &[]), &mut Log::new()).await.unwrap();
    let result = http
        .read_stream(
            resp,
            Instant::now() + Duration::from_millis(350),
            &mut |_| true,
        )
        .await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::Timeout {
            phase: "answer".into()
        }
    );
}

#[tokio::test]
async fn error_body_echoing_key_is_redacted() {
    let (url, _server) = serve(vec![MockReply::new(
        400,
        br#"{"error":{"message":"bad key gsk_test_secret_value"}}"#,
    )])
    .await;
    let secrets = vec![KEY.to_string()];
    let mut log = Log::new();
    let err = ai(http()
        .send(&call(&url, &secrets), &mut log)
        .await
        .unwrap_err());
    let AiError::Provider { status, message } = &err else {
        panic!("{err:?}");
    };
    assert_eq!(*status, 400);
    assert_eq!(message, "bad key [redacted]");
    assert!(!format!("{err:?} {err}").contains(KEY));
    assert!(!format!("{:?}", log.lines).contains(KEY));
}

#[tokio::test]
async fn key_header_never_in_debug() {
    let (url, server) = serve(vec![MockReply::new(
        401,
        b"invalid api key gsk_test_secret_value",
    )])
    .await;
    let secrets = vec![KEY.to_string()];
    let mut c = call(&url, &secrets);
    c.headers
        .push(("authorization", format!("Bearer {KEY}"), true));
    let mut log = Log::new();
    let err = http().send(&c, &mut log).await.unwrap_err();
    let shown = format!("{err:?} {err}");
    assert_eq!(ai(err), AiError::BadKey);
    assert!(!shown.contains(KEY));
    assert!(!format!("{:?}", log.lines).contains(KEY));
    // The key did go out, on the header.
    let heads = server.await.unwrap();
    assert!(heads[0].contains(&format!("Bearer {KEY}")));
}

#[tokio::test]
async fn connection_refused_is_network() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let url = url::Url::parse(&format!("http://127.0.0.1:{port}/v1")).unwrap();
    // Windows takes about 2 s to report a refused loopback port, so the connect limit
    // here is longer than that.
    let http = Http::with_limits(Limits {
        connect: Duration::from_secs(5),
        ..Limits::STANDARD
    })
    .unwrap();
    let mut log = Log::new();
    let err = http.send(&call(&url, &[]), &mut log).await.unwrap_err();
    assert_eq!(
        ai(err),
        AiError::Network {
            host: format!("127.0.0.1:{port}")
        }
    );
    let tries: Vec<_> = log.lines.iter().filter(|l| l.source == "http").collect();
    assert_eq!(tries.len(), 3);
    assert!(
        tries[0]
            .fields
            .contains(&("error".into(), "connect".into()))
    );
    assert_eq!(
        retries(&log),
        vec![
            retry_line("2", "1000", "connect"),
            retry_line("3", "3000", "connect")
        ]
    );
}

#[test]
fn map_status_by_code() {
    let groq = AiProviderKind::Groq;
    let m =
        |status, retry: Option<u64>, body: &str| map_status(status, retry, body, groq, "m", &[]);
    assert_eq!(m(401, None, ""), AiError::BadKey);
    assert_eq!(m(403, None, ""), AiError::BadKey);
    assert_eq!(m(402, None, ""), AiError::OutOfCredit { provider: groq });
    assert_eq!(m(413, None, ""), AiError::TooLarge);
    assert_eq!(
        m(429, Some(4), ""),
        AiError::RateLimited {
            retry_after_secs: Some(4)
        }
    );
    assert_eq!(m(529, None, ""), AiError::Overloaded { provider: groq });
    // Mapped by the code, never by the text.
    assert_eq!(
        m(500, None, "rate limit exceeded"),
        AiError::Provider {
            status: 500,
            message: "rate limit exceeded".into()
        }
    );
    let long = "x".repeat(500);
    let AiError::Provider { message, .. } = m(500, None, &long) else {
        panic!()
    };
    assert_eq!(message.chars().count(), 200);
    assert_eq!(
        m(500, None, "  "),
        AiError::Provider {
            status: 500,
            message: "Internal Server Error".into()
        }
    );
}

#[test]
fn map_status_reads_structured_fields_only() {
    let m = |status, body: &str, provider| map_status(status, None, body, provider, "m", &[]);
    let anthropic = AiProviderKind::Anthropic;
    let groq = AiProviderKind::Groq;
    let retired = AiError::ModelRetired { model: "m".into() };
    assert_eq!(
        m(
            404,
            r#"{"type":"error","error":{"type":"not_found_error","message":"model: m"}}"#,
            anthropic
        ),
        retired
    );
    // A wrong base URL is a 404 not_found_error too, but it does not name the model.
    let sonnet = "claude-sonnet-4-5";
    let wrong_url = r#"{"type":"error","error":{"type":"not_found_error","message":"Not Found"}}"#;
    assert!(matches!(
        map_status(404, None, wrong_url, anthropic, sonnet, &[]),
        AiError::Provider { status: 404, .. }
    ));
    let gone = format!(
        r#"{{"type":"error","error":{{"type":"not_found_error","message":"model: {sonnet}"}}}}"#
    );
    assert_eq!(
        map_status(404, None, &gone, anthropic, sonnet, &[]),
        AiError::ModelRetired {
            model: sonnet.into()
        }
    );
    assert_eq!(
        m(
            404,
            r#"{"error":{"message":"x","code":"model_not_found"}}"#,
            groq
        ),
        retired
    );
    // The message text is never read: a 404 saying "model_not_found" stays a 404.
    assert!(matches!(
        m(404, r#"{"error":{"message":"model_not_found"}}"#, groq),
        AiError::Provider { status: 404, .. }
    ));
    assert_eq!(
        m(
            400,
            r#"{"type":"error","error":{"type":"billing_error","message":"x"}}"#,
            anthropic
        ),
        AiError::OutOfCredit {
            provider: anthropic
        }
    );
}

#[test]
fn shared_client_builds() {
    let a = Http::shared().unwrap() as *const Http;
    let b = Http::shared().unwrap() as *const Http;
    assert_eq!(a, b);
}

// The OpenAI-compatible provider against the mock server.

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ai")
        .join(name);
    std::fs::read(path).unwrap()
}

fn openai(url: &url::Url, key: Option<&str>, kind: AiProviderKind) -> OpenAi {
    OpenAi {
        base: url.clone(),
        key: key.map(str::to_string),
        kind,
        secrets: key.map(str::to_string).into_iter().collect(),
        http: Box::leak(Box::new(http())),
    }
}

fn chat() -> ChatRequest {
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
        temperature: None,
        thinking: Thinking::Off,
        max_tokens_field: MaxTokensField::MaxTokens,
    }
}

async fn run(p: &OpenAi) -> (Vec<ProviderEvent>, contura_core::Result<()>) {
    let mut got = Vec::new();
    let result = p
        .stream(&chat(), &mut Log::new(), &mut |e| got.push(e))
        .await;
    (got, result)
}

#[tokio::test]
async fn stream_logs_into_the_answer_log() {
    let (url, _server) = serve(vec![
        MockReply::new(503, b"busy"),
        MockReply::new(200, &fixture("openai_length.sse")),
    ])
    .await;
    let p = openai(&url, Some(KEY), AiProviderKind::Groq);
    let mut log = Log::new();
    p.stream(&chat(), &mut log, &mut |_| {}).await.unwrap();
    let sources: Vec<&str> = log.lines.iter().map(|l| l.source.as_str()).collect();
    assert_eq!(sources, vec!["http", "retry", "http"]);
}

#[tokio::test]
async fn stream_fixture_text_usage_done() {
    // One byte a chunk: lines and events split across reads.
    let body = fixture("openai_text_usage.sse");
    let mut reply = MockReply::new(200, &body[..1]);
    for b in &body[1..] {
        reply.chunks.push((Duration::ZERO, vec![*b]));
    }
    let (url, server) = serve(vec![reply.header("content-type", "text/event-stream")]).await;
    let (got, result) = run(&openai(&url, Some(KEY), AiProviderKind::Groq)).await;
    result.unwrap();
    assert_eq!(
        got,
        vec![
            ProviderEvent::FirstByte,
            ProviderEvent::Text("SELECT count(*)".into()),
            ProviderEvent::Text(" FROM users;".into()),
            ProviderEvent::Usage(Usage {
                input: 684,
                output: 9,
                cache_read: 128,
                cache_write: 0,
            }),
            ProviderEvent::Stop(StopReason::End),
        ]
    );
    let heads = server.await.unwrap();
    assert!(
        heads[0].starts_with("POST /v1/chat/completions HTTP/1.1"),
        "{}",
        heads[0]
    );
    assert!(heads[0].contains(&format!("authorization: Bearer {KEY}")));
}

#[tokio::test]
async fn reasoning_delta_becomes_thinking() {
    let (url, _server) = serve(vec![MockReply::new(200, &fixture("openai_reasoning.sse"))]).await;
    let (got, result) = run(&openai(&url, Some(KEY), AiProviderKind::OpenAi)).await;
    result.unwrap();
    assert_eq!(
        got,
        vec![
            ProviderEvent::FirstByte,
            ProviderEvent::Thinking("The user wants a count.".into()),
            ProviderEvent::Text("SELECT 1;".into()),
            ProviderEvent::Stop(StopReason::End),
        ]
    );
}

#[tokio::test]
async fn length_finish_maps() {
    let (url, _server) = serve(vec![MockReply::new(200, &fixture("openai_length.sse"))]).await;
    let (got, result) = run(&openai(&url, Some(KEY), AiProviderKind::Groq)).await;
    result.unwrap();
    assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::Length)));
}

#[tokio::test]
async fn stream_without_finish_is_cut_off() {
    let (url, _server) = serve(vec![MockReply::new(200, &fixture("openai_cut_off.sse"))]).await;
    let (got, result) = run(&openai(&url, Some(KEY), AiProviderKind::Groq)).await;
    result.unwrap();
    assert_eq!(
        got,
        vec![
            ProviderEvent::FirstByte,
            ProviderEvent::Text("SELECT ".into()),
            ProviderEvent::Text("name FROM".into()),
            ProviderEvent::Stop(StopReason::Dropped),
        ]
    );
}

#[tokio::test]
async fn stream_ending_without_a_blank_line_keeps_its_finish() {
    // The finish chunk is the last thing sent, with no blank line and no [DONE].
    let body = b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"SELECT 1\"},\"finish_reason\":null}]}

data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}";
    let (url, _server) = serve(vec![MockReply::new(200, body)]).await;
    let (got, result) = run(&openai(&url, Some(KEY), AiProviderKind::Groq)).await;
    result.unwrap();
    assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::Length)));
}

#[tokio::test]
async fn stream_error_object_is_redacted() {
    let (url, _server) = serve(vec![MockReply::new(200, &fixture("openai_error.sse"))]).await;
    let p = openai(
        &url,
        Some("sk-or-v1-fixture-secret"),
        AiProviderKind::OpenAi,
    );
    let (got, result) = run(&p).await;
    assert_eq!(
        got,
        vec![ProviderEvent::FirstByte, ProviderEvent::Text("SEL".into())]
    );
    let err = ai(result.unwrap_err());
    assert_eq!(
        err,
        AiError::Provider {
            status: 502,
            message: "Upstream failed for key [redacted]".into()
        }
    );
}

#[tokio::test]
async fn stream_http_error_maps_by_status() {
    let (url, server) = serve(vec![MockReply::new(
        401,
        br#"{"error":{"message":"Invalid API Key"}}"#,
    )])
    .await;
    let (got, result) = run(&openai(&url, Some(KEY), AiProviderKind::Groq)).await;
    assert!(got.is_empty());
    assert_eq!(ai(result.unwrap_err()), AiError::BadKey);
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
async fn models_list_sorted() {
    let body = br#"{"object":"list","data":[
        {"id":"llama-3.3-70b-versatile","object":"model"},
        {"id":"openai/gpt-oss-20b","object":"model"},
        {"id":"llama-3.1-8b-instant","object":"model"}]}"#;
    let (url, server) = serve(vec![MockReply::new(200, body)]).await;
    let models = openai(&url, Some(KEY), AiProviderKind::Groq)
        .models(&mut Log::new())
        .await
        .unwrap();
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "llama-3.1-8b-instant",
            "llama-3.3-70b-versatile",
            "openai/gpt-oss-20b"
        ]
    );
    let heads = server.await.unwrap();
    assert!(
        heads[0].starts_with("GET /v1/models HTTP/1.1"),
        "{}",
        heads[0]
    );
    assert!(heads[0].contains(&format!("authorization: Bearer {KEY}")));
}

#[tokio::test]
async fn groq_listing_reads_window_and_output() {
    let body = br#"{"object":"list","data":[
        {"id":"openai/gpt-oss-20b","object":"model","context_window":131072,"max_completion_tokens":65536},
        {"id":"whisper-large-v3","object":"model","context_window":448}]}"#;
    let (url, _server) = serve(vec![MockReply::new(200, body)]).await;
    let models = openai(&url, Some(KEY), AiProviderKind::Groq)
        .models(&mut Log::new())
        .await
        .unwrap();
    assert_eq!(
        models[0],
        ListedModel {
            id: "openai/gpt-oss-20b".into(),
            context_window: Some(131_072),
            max_output: Some(65_536),
            ..ListedModel::default()
        }
    );
    // The provider lists everything; the service drops what does not chat.
    assert_eq!(models[1].id, "whisper-large-v3");
}

#[tokio::test]
async fn openrouter_listing_reads_modalities_and_reasoning() {
    let body = br#"{"data":[
        {"id":"z-ai/glm-5","name":"Z.ai: GLM 5","context_length":202752,
         "architecture":{"input_modalities":["text"],"output_modalities":["text"]},
         "supported_parameters":["max_tokens","reasoning","temperature"],
         "top_provider":{"context_length":202752,"max_completion_tokens":131072}},
        {"id":"google/gemini-image","name":"Image","context_length":32768,
         "architecture":{"output_modalities":["image"]},
         "supported_parameters":["max_tokens"]}]}"#;
    let (url, _server) = serve(vec![MockReply::new(200, body)]).await;
    let models = openai(&url, Some(KEY), AiProviderKind::OpenAi)
        .models(&mut Log::new())
        .await
        .unwrap();
    let image = &models[0];
    assert_eq!(image.id, "google/gemini-image");
    assert_eq!(image.chat, Some(false));
    assert_eq!(image.reasoning, Some(false));
    assert_eq!(
        models[1],
        ListedModel {
            id: "z-ai/glm-5".into(),
            name: Some("Z.ai: GLM 5".into()),
            context_window: Some(202_752),
            max_output: Some(131_072),
            chat: Some(true),
            reasoning: Some(true),
        }
    );
}

#[tokio::test]
async fn models_bad_body_is_bad_response() {
    let (url, _server) = serve(vec![MockReply::new(200, b"<html>")]).await;
    let err = openai(&url, Some(KEY), AiProviderKind::Groq)
        .models(&mut Log::new())
        .await
        .unwrap_err();
    assert_eq!(ai(err), AiError::BadResponse);
}

#[tokio::test]
async fn empty_custom_key_sends_no_auth() {
    let (url, server) = serve(vec![
        MockReply::new(200, &fixture("openai_length.sse")),
        MockReply::new(200, br#"{"data":[]}"#),
    ])
    .await;
    // An empty key and no key at all both send no header.
    run(&openai(&url, Some(""), AiProviderKind::Custom))
        .await
        .1
        .unwrap();
    let models = openai(&url, None, AiProviderKind::Custom)
        .models(&mut Log::new())
        .await;
    assert!(models.unwrap().is_empty());
    for head in server.await.unwrap() {
        assert!(
            !head.to_ascii_lowercase().contains("authorization"),
            "{head}"
        );
    }
}

// The Anthropic Messages API against the mock server.

const ANTHROPIC_KEY: &str = "sk-ant-api03-test-secret-value";

fn anthropic(url: &url::Url) -> Anthropic {
    // The mock serves under `/v1`; the Anthropic base is the bare host.
    let mut base = url.clone();
    base.set_path("");
    Anthropic {
        base,
        key: ANTHROPIC_KEY.into(),
        secrets: Vec::new(),
        http: Box::leak(Box::new(http())),
    }
}

fn claude() -> ChatRequest {
    ChatRequest {
        model: "claude-sonnet-5-5".into(),
        ..chat()
    }
}

async fn run_anthropic(p: &Anthropic) -> (Vec<ProviderEvent>, Log, contura_core::Result<()>) {
    let mut got = Vec::new();
    let mut log = Log::new();
    let result = p.stream(&claude(), &mut log, &mut |e| got.push(e)).await;
    (got, log, result)
}

#[tokio::test]
async fn anthropic_stream_fixture_text_thinking_usage() {
    // One byte a chunk: lines and events split across reads.
    let body = fixture("anthropic_text_thinking_usage.sse");
    let mut reply = MockReply::new(200, &body[..1]);
    for b in &body[1..] {
        reply.chunks.push((Duration::ZERO, vec![*b]));
    }
    let (url, server) = serve(vec![reply.header("content-type", "text/event-stream")]).await;
    let (got, log, result) = run_anthropic(&anthropic(&url)).await;
    result.unwrap();
    let start = Usage {
        input: 812,
        output: 1,
        cache_read: 128,
        cache_write: 64,
    };
    assert_eq!(
        got,
        vec![
            ProviderEvent::FirstByte,
            ProviderEvent::Usage(start),
            ProviderEvent::Thinking("The user wants a count.".into()),
            ProviderEvent::Text("SELECT count(*)".into()),
            ProviderEvent::Text(" FROM users;".into()),
            ProviderEvent::Usage(Usage { output: 9, ..start }),
            ProviderEvent::Stop(StopReason::End),
        ]
    );
    assert_eq!(log.lines[0].source, "http");
    let heads = server.await.unwrap();
    assert!(
        heads[0].starts_with("POST /v1/messages HTTP/1.1"),
        "{}",
        heads[0]
    );
    assert!(heads[0].contains(&format!("x-api-key: {ANTHROPIC_KEY}")));
    assert!(heads[0].contains("anthropic-version: 2023-06-01"));
    assert!(!heads[0].to_ascii_lowercase().contains("authorization"));
}

#[tokio::test]
async fn anthropic_overloaded_error_event() {
    let (url, _server) = serve(vec![MockReply::new(
        200,
        &fixture("anthropic_overloaded.sse"),
    )])
    .await;
    let (got, _, result) = run_anthropic(&anthropic(&url)).await;
    assert_eq!(got.last(), Some(&ProviderEvent::Text("SEL".into())));
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::Overloaded {
            provider: AiProviderKind::Anthropic
        }
    );
}

#[tokio::test]
async fn anthropic_refusal_stop() {
    let (url, _server) = serve(vec![MockReply::new(200, &fixture("anthropic_refusal.sse"))]).await;
    let (got, _, result) = run_anthropic(&anthropic(&url)).await;
    result.unwrap();
    assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::Refusal)));
}

#[tokio::test]
async fn anthropic_body_ending_before_message_stop_is_dropped() {
    let (url, _server) = serve(vec![MockReply::new(200, &fixture("anthropic_cut_off.sse"))]).await;
    let (got, _, result) = run_anthropic(&anthropic(&url)).await;
    result.unwrap();
    assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::Dropped)));
}

#[tokio::test]
async fn anthropic_body_without_trailing_blank_line_ends() {
    let body = fixture("anthropic_text_thinking_usage.sse");
    let text = String::from_utf8(body).unwrap();
    let trimmed = text.trim_end();
    assert!(trimmed.ends_with(r#"data: {"type":"message_stop"}"#));
    let (url, _server) = serve(vec![MockReply::new(200, trimmed.as_bytes())]).await;
    let (got, _, result) = run_anthropic(&anthropic(&url)).await;
    result.unwrap();
    assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::End)));
}

#[tokio::test]
async fn anthropic_http_529_is_overloaded() {
    let busy = br#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
    let (url, _server) = serve(vec![
        MockReply::new(529, busy),
        MockReply::new(529, busy),
        MockReply::new(529, busy),
    ])
    .await;
    let (got, log, result) = run_anthropic(&anthropic(&url)).await;
    assert!(got.is_empty());
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::Overloaded {
            provider: AiProviderKind::Anthropic
        }
    );
    assert_eq!(log.lines.iter().filter(|l| l.source == "retry").count(), 2);
}

#[tokio::test]
async fn anthropic_models_list() {
    let body = br#"{"data":[
        {"type":"model","id":"claude-sonnet-5-5","display_name":"Claude Sonnet 5.5"},
        {"type":"model","id":"claude-haiku-5-5","display_name":"Claude Haiku 5.5"}],
        "has_more":false,"first_id":"claude-sonnet-5-5","last_id":"claude-haiku-5-5"}"#;
    let (url, server) = serve(vec![MockReply::new(200, body)]).await;
    let models = anthropic(&url).models(&mut Log::new()).await.unwrap();
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["claude-haiku-5-5", "claude-sonnet-5-5"]);
    assert_eq!(models[1].name.as_deref(), Some("Claude Sonnet 5.5"));
    let heads = server.await.unwrap();
    assert!(
        heads[0].starts_with("GET /v1/models?limit=1000 HTTP/1.1"),
        "{}",
        heads[0]
    );
    assert!(heads[0].contains(&format!("x-api-key: {ANTHROPIC_KEY}")));
    assert!(heads[0].contains("anthropic-version: 2023-06-01"));
}

#[tokio::test]
async fn anthropic_models_page_with_limit() {
    let first = br#"{"data":[
        {"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5",
         "max_input_tokens":1000000,"max_tokens":128000,
         "capabilities":{"thinking":{"types":{"adaptive":{"supported":true},"enabled":{"supported":false}}}}}],
        "has_more":true,"first_id":"claude-opus-5-5","last_id":"claude-opus-5-5"}"#;
    let second = br#"{"data":[
        {"type":"model","id":"claude-haiku-4-5","display_name":"Claude Haiku 4.5",
         "max_input_tokens":200000,"max_tokens":64000,
         "capabilities":{"thinking":{"types":{"adaptive":{"supported":false},"enabled":{"supported":true}}}}}],
        "has_more":false,"first_id":"claude-haiku-4-5","last_id":"claude-haiku-4-5"}"#;
    let (url, server) = serve(vec![
        MockReply::new(200, first),
        MockReply::new(200, second),
    ])
    .await;
    let models = anthropic(&url).models(&mut Log::new()).await.unwrap();
    let heads = server.await.unwrap();
    assert!(
        heads[0].starts_with("GET /v1/models?limit=1000 HTTP/1.1"),
        "{}",
        heads[0]
    );
    assert!(
        heads[1].starts_with("GET /v1/models?limit=1000&after_id=claude-opus-5-5 HTTP/1.1"),
        "{}",
        heads[1]
    );
    assert_eq!(
        models,
        vec![
            // Budget thinking only: no claim, the built-in record decides.
            ListedModel {
                id: "claude-haiku-4-5".into(),
                name: Some("Claude Haiku 4.5".into()),
                context_window: Some(200_000),
                max_output: Some(64_000),
                chat: None,
                reasoning: None,
            },
            ListedModel {
                id: "claude-opus-5-5".into(),
                name: Some("Claude Opus 5.5".into()),
                context_window: Some(1_000_000),
                max_output: Some(128_000),
                chat: None,
                reasoning: Some(true),
            },
        ]
    );
}

// ---- 11b-2: error kinds and provider carry-overs ----

/// An OpenAI-compatible provider whose redact list holds nothing but its own key.
fn openai_no_secrets(url: &url::Url) -> OpenAi {
    OpenAi {
        base: url.clone(),
        key: Some(KEY.into()),
        kind: AiProviderKind::Groq,
        secrets: vec![],
        http: Box::leak(Box::new(http())),
    }
}

#[tokio::test]
async fn anthropic_404_not_found_is_model_retired() {
    let body = br#"{"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-5-5"}}"#;
    let (url, server) = serve(vec![MockReply::new(404, body)]).await;
    let (_, _, result) = run_anthropic(&anthropic(&url)).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::ModelRetired {
            model: "claude-sonnet-5-5".into()
        }
    );
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
async fn openai_404_model_not_found_is_model_retired() {
    let body = br#"{"error":{"message":"The model does not exist","type":"invalid_request_error","code":"model_not_found"}}"#;
    let (url, _server) = serve(vec![MockReply::new(404, body)]).await;
    let (_, result) = run(&openai(&url, Some(KEY), AiProviderKind::OpenAi)).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::ModelRetired {
            model: "llama-3.3-70b-versatile".into()
        }
    );
}

#[tokio::test]
async fn plain_404_is_provider() {
    let (url, _server) = serve(vec![MockReply::new(404, b"no such path")]).await;
    let (_, result) = run(&openai(&url, Some(KEY), AiProviderKind::Groq)).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::Provider {
            status: 404,
            message: "no such path".into()
        }
    );
}

#[tokio::test]
async fn billing_error_is_out_of_credit() {
    let body = br#"{"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low"}}"#;
    let (url, _server) = serve(vec![MockReply::new(400, body)]).await;
    let (_, _, result) = run_anthropic(&anthropic(&url)).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::OutOfCredit {
            provider: AiProviderKind::Anthropic
        }
    );
    // Mid-stream too.
    let sse = b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"billing_error\",\"message\":\"low\"}}\n\n";
    let (url, _server) = serve(vec![MockReply::new(200, sse)]).await;
    let (_, _, result) = run_anthropic(&anthropic(&url)).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::OutOfCredit {
            provider: AiProviderKind::Anthropic
        }
    );
}

#[tokio::test]
async fn mid_stream_rate_limit_is_rate_limited() {
    let sse = b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}\n\n";
    let (url, _server) = serve(vec![MockReply::new(200, sse)]).await;
    let (_, _, result) = run_anthropic(&anthropic(&url)).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::RateLimited {
            retry_after_secs: None
        }
    );
    let sse = b"data: {\"error\":{\"message\":\"slow down\",\"code\":429}}\n\n";
    let (url, _server) = serve(vec![MockReply::new(200, sse)]).await;
    let (_, result) = run(&openai(&url, Some(KEY), AiProviderKind::Groq)).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::RateLimited {
            retry_after_secs: None
        }
    );
}

#[tokio::test]
async fn mid_stream_error_without_code_is_bad_response() {
    let sse = b"data: {\"choices\":[{\"delta\":{\"content\":\"SEL\"}}]}\n\ndata: {\"error\":{\"message\":\"oops\"}}\n\n";
    let (url, _server) = serve(vec![MockReply::new(200, sse)]).await;
    let (_, result) = run(&openai(&url, Some(KEY), AiProviderKind::Groq)).await;
    assert_eq!(ai(result.unwrap_err()), AiError::BadResponse);
    let sse = b"event: error\ndata: {\"type\":\"error\",\"error\":{\"message\":\"oops\"}}\n\n";
    let (url, _server) = serve(vec![MockReply::new(200, sse)]).await;
    let (_, _, result) = run_anthropic(&anthropic(&url)).await;
    assert_eq!(ai(result.unwrap_err()), AiError::BadResponse);
}

#[tokio::test]
async fn unknown_finish_reason_is_end_with_a_warning() {
    let sse = b"data: {\"choices\":[{\"delta\":{\"content\":\"SELECT 1\"},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
    let (url, _server) = serve(vec![MockReply::new(200, sse)]).await;
    let p = openai(&url, Some(KEY), AiProviderKind::Groq);
    let mut got = Vec::new();
    let mut log = Log::new();
    p.stream(&chat(), &mut log, &mut |e| got.push(e))
        .await
        .unwrap();
    assert_eq!(got.last(), Some(&ProviderEvent::Stop(StopReason::End)));
    let warning = log
        .lines
        .iter()
        .find(|l| l.source == "answer")
        .expect("a warning line");
    assert_eq!(warning.level, Level::Warn);
    assert_eq!(
        warning.fields,
        vec![("finish_reason".to_string(), "tool_calls".to_string())]
    );
    // A known reason logs nothing.
    let sse =
        b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let (url, _server) = serve(vec![MockReply::new(200, sse)]).await;
    let mut log = Log::new();
    openai(&url, Some(KEY), AiProviderKind::Groq)
        .stream(&chat(), &mut log, &mut |_| {})
        .await
        .unwrap();
    assert!(!log.lines.iter().any(|l| l.source == "answer"));
}

#[tokio::test]
async fn unknown_finish_reason_is_redacted_in_the_log() {
    let sse = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"x gsk_test_secret_value\u{200b}\"}]}\n\ndata: [DONE]\n\n";
    let (url, _server) = serve(vec![MockReply::new(200, sse.as_bytes())]).await;
    let mut log = Log::new();
    openai_no_secrets(&url)
        .stream(&chat(), &mut log, &mut |_| {})
        .await
        .unwrap();
    let line = log.lines.iter().find(|l| l.source == "answer").unwrap();
    assert_eq!(
        line.fields,
        vec![("finish_reason".to_string(), "x [redacted]".to_string())]
    );
}

#[tokio::test]
async fn long_retry_after_on_503_is_not_rate_limited() {
    let busy = || MockReply::new(503, b"busy").header("retry-after", "30");
    let (url, server) = serve(vec![busy(), busy(), busy()]).await;
    let mut log = Log::new();
    let err = http().send(&call(&url, &[]), &mut log).await.unwrap_err();
    assert_eq!(
        ai(err),
        AiError::Provider {
            status: 503,
            message: "busy".into()
        }
    );
    assert_eq!(server.await.unwrap().len(), 3);
    // The long Retry-After is not waited out: the standard back-off is used.
    assert_eq!(
        retries(&log),
        vec![
            retry_line("2", "1000", "503"),
            retry_line("3", "3000", "503")
        ]
    );
}

#[tokio::test]
async fn tls_failure_is_not_retried() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Plain TCP behind an https URL: the TLS handshake reads an HTTP reply and fails.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let count = accepted.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n")
                .await;
            let _ = sock.shutdown().await;
        }
    });
    let url = url::Url::parse(&format!("https://127.0.0.1:{port}/v1")).unwrap();
    let mut log = Log::new();
    let err = http().send(&call(&url, &[]), &mut log).await.unwrap_err();
    assert_eq!(
        ai(err),
        AiError::Tls {
            host: format!("127.0.0.1:{port}")
        }
    );
    assert_eq!(accepted.load(Ordering::SeqCst), 1);
    assert!(retries(&log).is_empty());
    server.abort();
}

#[tokio::test]
async fn redact_list_holds_the_key() {
    let (url, _server) = serve(vec![MockReply::new(
        400,
        br#"{"error":{"message":"bad key gsk_test_secret_value"}}"#,
    )])
    .await;
    let (_, result) = run(&openai_no_secrets(&url)).await;
    assert_eq!(
        ai(result.unwrap_err()),
        AiError::Provider {
            status: 400,
            message: "bad key [redacted]".into()
        }
    );
}
