# The diagram assistant's one tool

The Assistant can edit a `.flow` diagram. It is the one exception to the rule that the Assistant has no tools (ADR 0010). ADR 0003, ADR 0008, ADR 0010 and ADR 0019 still hold.

## Context

- **The Assistant has no tools.** A database Ask sends text and gets text back; the model can neither run SQL nor read a table, and a tool would open a second way for model output to reach a database. That rule is kept for every database Ask.
- **A diagram is the user's own text, not database data.** A `.flow` file holds names, links and labels the user typed. A tool that only proposes edits to that text, which the user then reviews (or, by choice, lets land), reaches no connection, no row and no schema.
- **One grammar.** The only `.flow` parser is the language worker's (ADR 0019). The Core cannot parse a proposed text, so it checks each change against an outline the worker builds from the same text version.

## Decision

- **One tool, `propose_diagram_changes`, only on a diagram Ask.** Its input is the diagram's name, the hash of the text the model was shown (`base_hash`) and up to 50 ops: `add_node`, `remove_node`, `rename_node`, `add_flow`, `remove_flow`, `relabel_flow` and `move_to_group`. Shapes and groups are named by their words and resolved by the Core: exact name, then id, then case, then words (a leading "the", "a" or "an" dropped); two or more matches ask the user to pick. `add_flow` takes no arrow, so the diagram's default arrow is written. `move_to_group.group` may be null, which takes the shape out of every group.
- **The system prompt names the diagram's shape kinds.** One line, "Shapes in this diagram take these kinds: step, decision, start, end.", from the outline's `kinds`: each kind only when it is a short plain word (as the diagram kind line), at most 20, and no line when none passes. The model would otherwise guess kinds, and a wrong guess is dropped as an unknown kind. Cost: one prompt line.
- **The tool touches only the .flow text of the open diagram.** It never reads or changes a database, and its description says so. The tool's JSON schema is written by hand beside the input type (`input_schema()`), held to it by a test over every variant and a snapshot; there is no schema crate.
- **The execution rail.** Every model call and every tool call goes through the rails, the Sends list and the answer log. The rail rejects any tool name but `propose_diagram_changes`, validates the input against the type, caps it at 64 KB, strips invisible characters from the model's text before anything is checked or shown, and never sends a tool result back to the model. Only the first call is used; a second call is dropped and never answered. A tool name or input that is wrong gives a card and a Warn line, and nothing is applied. A provider stops reading a tool input once it passes 64 KB: it sends that call once, as read so far (at most the cap plus the one chunk that crossed it), and stops with `TooLong`, so the rail refuses it as `over_cap` with its Warn line and the card is the unreadable-changes one with Retry, never "No changes proposed.". A database Ask still refuses any call.
- **Diagram text goes out like any outgoing text.** Secrets are replaced, invisible characters stripped and the text is framed with source `diagram` (ADR 0025). Text that looks like instructions gets the note "Text in this diagram looks like it gives the assistant instructions. Read its changes with care.", shown above the answer as in a database Ask. The tool definition counts in the Sent bytes and hash, so the Sent record measures what went on the wire. The text is never cut to fit: over 160 KB, or 5,000 shapes or lines, is `TooLarge`, because changes are written against the whole text.
- **The Core's checks.** Each op is checked in order over a live copy of the outline, so a later change sees the earlier ones that passed: unknown shape, group or line, a reused id, an empty label, an ambiguous target, a shape outside the selection, a change that depends on one that was dropped ("it needs a change that was dropped"), a name or label with a line break or over its cap. Dropped changes keep their reason and are shown. New shapes and lines in the live outline get line numbers after the file's last line, since they have no line yet.
- **The disk re-read.** The text is read-only in the tab while the Ask runs and while changes wait, and there is no file watcher. At the end of the Ask the Core reads the file again; a different text gives "the file changed" and no change lands. The worker refuses a landing planned on an older text version. A `base_hash` or `file` that does not match what the Core sent is `BadToolInput` ("could not be read"), not "changed while I worked", since nothing changed. The file may be named `<file>` or `<file>.flow`, since the turn shows `File: <file>.flow.`; `base_hash` stays strict. A file name with a control character is `BadFileName`.
- **The worker parse for Auto-apply.** The worker applies the accepted set to the text and parses the result before it lands. With Auto-apply, a set that does not parse, or one that removes more than 3 shapes, is shown for review instead. `planLanding` builds each op from the parse the previous ops left and returns one text edit, so one Ctrl+Z restores the text byte for byte, CRLF kept.
- **Review first or Auto-apply is the client's choice** (`UiPrefs.flow_assist_mode`, default review, kept across restarts). More than 3 shapes removed always asks, even with Auto-apply. Reject in review takes the changes that depend on the rejected one with it, so the landed text never has a dangling line.
- **The switch.** AI settings has a switch on the Propose diagram changes row (`AiSettings.diagram_tool`, global, on by default). Off refuses a diagram Ask in the Core with `ToolOff`. The Question row stays on, as in a database Ask.
- **Settings, access and history.** A diagram Ask uses the global AI settings (a diagram has no Group), no AI access level (the Sends rows are locked on, with their reason), and no history: the thread is stored under `diagram:<name>` for display and Recent tool uses, and each Ask sends only the current text. A follow-up is a new Ask on the current text.
- **Recent tool uses.** Migration 7 adds `ai_tool_use`, filled from saved threads (diagram tool uses and Pick tables steps); `OutlineSent.tables` lets a Pick tables row read "2 of 6 tables"; a thread saved before the diagram tool has no count and reads "2 tables". Two assistant messages at the same time keep the later one's row (`INSERT OR REPLACE`), so they never fail the thread save. A row reads "N proposed", then "N proposed, M accepted" once the user lands or rejects. `record_tool_result` stores the outcome on the answer. A re-save of the thread keeps a stored outcome only when the saved message holds the same tool use (same `base_hash` and `input`); a message replaced at the same time by another tool use keeps no old outcome.
- **Logs hold reason codes and counts only.** Log fields never hold a name, label or body text; those live in the record's `toolUse` and on the cards. The proposal event carries `input` (the stripped, capped tool JSON) so the record keeps it. Only the first tool call is used; each later call gets one Warn line `tool outcome=dropped reason=second_call`, up to 8 calls, and past the 8th one count line `tool outcome=dropped reason=over_limit calls=<n>` records the rest.
- **A tool call the provider could not parse is `BadToolInput`.** Groq ends the stream (or answers 400) with `error.code = "tool_use_failed"` when the model writes tool arguments that are not JSON. That exact code maps to `BadToolInput` ("The assistant's changes could not be read. Nothing was changed.", with Retry), in the status mapping and in the mid-stream error chunk; every other code keeps its own mapping. Cost: a provider-side parse failure reads as unreadable tool input, which is what it is.
- **No new network path.** Only `ai/provider/http.rs` names `reqwest`; `tests/ai_egress.rs` stays green; nothing under `ai/provider/` names a connection, a session or a dialect.

## Decisions and their cost

- **The flow parser stays in the worker.** The Core checks ops against the worker's outline and the worker parses the accepted set; there is no Rust port of the grammar. Cost: the "would break the text" check runs in the webview; the threat model is the model's text, not the app's own UI.
- **The schema without a new crate.** Cost: a new field is written twice, and the test fails until both match.
- **No file watcher.** Read-only text plus the Core's re-read at the end of the Ask. Cost: a file changed outside Contura is noticed at the end of the Ask, not while it runs.
- **Extra guards on the diagram Ask.** More than 3 shapes removed always asks; the text is read-only while working and while changes wait; "Ask to fix it"; the landed summary with Undo. Cost: more states to keep in step with the design.
- **The tool's switch** in AI settings. Cost: one more setting, and a tool-off card until the Assistant tab has its own note.
- **Global settings, no access level, no history.** Cost: a diagram Ask cannot use a Group's model or follow on from an earlier Ask.
- **Wire choices.** `tool_choice` is auto on both providers (Anthropic refuses a forced tool with thinking on), so an answer with no call shows "No changes proposed.". Cost: a model may answer in prose instead of calling the tool. The first live run (Groq, gpt-oss-120b) did so in 2 of 5 Asks; the prompt now says to make the change only by calling the tool and never to write the changes, .flow text or JSON in the answer, and the next 8 of 8 runs called it with every change passing the check. The small gpt-oss-20b also writes non-JSON tool arguments about 1 Ask in 3 (`tool_use_failed` above).
- **Reason-code-only logs** (ADR 0025). Cost: a Warn line says why a change was refused but not which shape.
- **Every model call through the rail**, the tool definition included in the Sent record. Cost: a larger Sent record on a diagram Ask.

## Consequences

- Database Asks stay tool-less: the request carries no `tools` key, and a test enforces it. A tool call arriving in a database Ask is rejected and the answer is kept.
- A new tool needs a new ADR, and the execution rail and the egress test change together with it.
- The Core cannot write a diagram. It only proposes; the open tab lands the change as one undoable text edit.
- The live check `groq_proposes_diagram_changes` is `#[ignore]` and runs only with `CONTURA_GROQ_KEY` in the environment; it prints the model id and counts only.

## Deferred checks

To check in the real app before release:

- The idle, working, review and auto scenes and the error cards (stale, unclear, checker, broken, provider) as designed.
- The read-only text while working and while changes wait, and closing the tab mid-Ask.
- Undo after landing a set on a CRLF file with a selection scope.
- A real provider turn with each wire format (OpenAI-compatible and Anthropic).
- The Assistant tab's tool-off state and the Sends line for a diagram Ask are still to be checked.

## Checks

`cargo test -j 4 --workspace --features contura-core/test-util`, the clippy gate and `cargo fmt --check`; the live test with a key: `CONTURA_GROQ_KEY=<key> cargo test -j 4 -p contura-core --test ai_groq_live groq_proposes_diagram_changes -- --ignored`.
