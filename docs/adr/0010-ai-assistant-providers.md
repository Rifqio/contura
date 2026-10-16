# The AI assistant calls providers from the Core, with consent per Connection

The assistant talks to an AI provider through an `AiProvider` trait in the Core, never from the WebView, so the WebView's CSP stays closed. One provider serves everything, optionally overridden per Group. Real providers (OpenAI-compatible, Anthropic Claude, Groq, DeepSeek, Custom) arrive later behind the same trait.

**The key never reaches the UI.** It is stored in Windows Credential Manager like Connection passwords, as service `DB View`, account `AI/<provider id>` (for example `AI/groq`), one key per provider and shared by every Group. Never in `data\`. The settings command returns only whether a key is saved and its last 4 characters; the form never holds a saved key in its state.

**Consent is per Connection.** Each Connection has an `aiAccess` level, one of four: nothing, schema only, schema and query text, schema, query text and sample rows. The default is schema only, for existing Connections too; Production Connections will start at nothing once Pending Edits land (step 5). When rows are allowed, each question still has a switch to leave them out. Before anything could be sent, the prompt shows a "Sends" line, and "Show exactly" opens the full text. A Connection set to nothing sends only the question: no schema, SQL or error text. The payload text is capped at 200 KB.

**AI-written SQL never runs automatically.** An answer can be inserted into the editor or opened in a new query tab, always as a reviewable step; running it follows the normal rules (Production confirmation, Read-only, UPDATE or DELETE without WHERE).

**The placeholder phase.** Step 4c ships the whole assistant shell with a `Placeholder` provider and no network calls. With no provider saved, asking fails with `NotConfigured` and the UI shows a setup card. With a provider saved, it fails with `NotAvailable`, shown as "Answers from {provider} arrive in a later DB View version. Nothing was sent." The UI already renders bad key, rate limited and network errors, so real providers only need to return them.

Chat threads are kept in the app store per Group (and for Ungrouped), with a Clear action. Provider settings are kept in the app store, except the key.

## Considered and rejected

- **Calling providers from the WebView.** The key would reach the UI and the CSP would have to open to every provider host.
- **Storing the key in `data\`.** The folder is portable and may be copied or synced; Connection passwords already live in Credential Manager for the same reason.
- **One global consent switch.** A personal laptop Connection and a client's Production Connection need different answers, so consent is per Connection.
- **Running AI SQL after a confirmation.** Review and running stay separate steps, so the existing write guards are the only way SQL reaches a database.
