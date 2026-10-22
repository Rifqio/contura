# The AI assistant calls providers from the Core, with consent per Connection

The assistant talks to an AI provider through an `AiProvider` trait in the Core, never from the WebView, so the WebView's CSP stays closed. One provider serves everything, optionally overridden per Group. Anthropic and OpenAI-compatible providers sit behind the same trait.

**The key never reaches the UI.** It is stored in the OS keyring like Connection passwords, as service `DB View` at first (now `Contura`, see below), account `AI/<provider id>` (for example `AI/groq`), one key per provider and shared by every Group. Never in `data\`. The settings command returns only whether a key is saved and its last 4 characters; the form never holds a saved key in its state.

**Consent is per Connection.** Each Connection has an `aiAccess` level, one of four: nothing, schema only, schema and query text, schema, query text and sample rows. The default is schema only, for existing Connections too; Production Connections start at nothing. When rows are allowed, each question still has a switch to leave them out. Before anything could be sent, the prompt shows a "Sends" line, and "Show exactly" opens the full text. A Connection set to nothing sends only the question: no schema, SQL or error text. The payload text is capped at 200 KB.

**AI-written SQL never runs automatically.** An answer can be inserted into the editor or opened in a new query tab, always as a reviewable step; running it follows the normal rules (Production confirmation, Read-only, UPDATE or DELETE without WHERE).

**Providers.** Two clients behind the `AiProvider` trait: Anthropic, and one OpenAI-compatible client for OpenAI, OpenRouter, Groq, DeepSeek and Custom (plain `http://` only on this computer or a private network: `localhost`, loopback, private IPv4, link-local, and IPv6 unique local and link-local addresses, which covers Ollama or LM Studio on this computer or the LAN; every other host needs `https://`). A base URL with credentials in it is refused.

**The key, as built.** It lives in the OS keyring (Windows Credential Manager; the Secret Service on Linux) under service `Contura` (`DB View` is read as the legacy service and moved), account `AI/<provider>`. It is bound to the host it was saved for: a new host needs a confirmation before the key goes there. It never appears in an error, a log or a record (see ADR 0025): a provider's message is redacted for the saved key and the token shapes before it is shown, stored or logged.

**Core-built Sends.** `ai_preview` and `ai_ask_stream` run one builder in the Core, and the UI never supplies schema text. What the preview shows is what the stream sends (ADR 0024 and ADR 0025).

**Model capability records.** Each model has a record: context window, thinking kind and caching kind (`ModelInfo`, `ThinkingKind`, `CachingKind`). It comes from the provider's listing, else from the built-in table. A model with no record gets no thinking or caching controls.

**Retries.** Only before the first byte of an answer. A `Retry-After` is honoured and capped at 10 seconds. On 429 and 529 a longer one fails the Ask as rate limited instead of waiting; on a 5xx it is ignored and the standard back-off is used.

**Prompt caching.** The stable blocks (system prompt, schema) come first and the cache marks follow them. Anthropic uses explicit breakpoints. Groq stays off: the live probe on 2026-10-22 saw `cache_read` 0 for `openai/gpt-oss-20b` and `qwen/qwen3.8-27b`, so caching is not claimed for Groq until a probe sees `cache_read` above 0.

**One HTTP crate.** `reqwest` is named in `ai/provider/http.rs` only. It is one `reqwest` 0.13.5 with `rustls-no-provider`; Contura installs ring as the crypto provider, the platform verifier checks certificates, and no aws-lc is in the tree (the test `no_aws_lc_in_cargo_lock` guards it). A single build with one TLS stack keeps the binary small and the certificate rules in one place.

The placeholder phase is over: the old not-available error is retired, and `NotConfigured` stays for a missing provider. Database Asks carry no tools; diagram Asks carry one (ADR 0023).

Updated 2026-10-22 for the AI assistant's real providers.

Chat threads are kept in the app store per Group (and for Ungrouped), with a Clear action. Provider settings are kept in the app store, except the key.

## Considered and rejected

- **Calling providers from the WebView.** The key would reach the UI and the CSP would have to open to every provider host.
- **Storing the key in `data\`.** The folder is portable and may be copied or synced; Connection passwords already live in Credential Manager for the same reason.
- **One global consent switch.** A personal laptop Connection and a client's Production Connection need different answers, so consent is per Connection.
- **Running AI SQL after a confirmation.** Review and running stay separate steps, so the existing write guards are the only way SQL reaches a database.
