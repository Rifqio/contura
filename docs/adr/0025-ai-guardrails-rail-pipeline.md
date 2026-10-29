# AI guardrails are a rail pipeline in the Core, with no model in the loop

The model cannot reach a database, and it cannot send more than the user allowed. The prompt only lowers the chance of being tricked; the rules that hold are code in the Core, in `ai/rails/`, each with a test.

**The pipeline.** The structure of NeMo Guardrails, rebuilt in Rust: a rail is a function over the Ask's typed items or the answer, and returns pass, changed (with what) or stop (with the error). Rails run in a fixed order on every Ask: input, retrieval, execution, output. Every rail result is a line in the answer log (`rail.<name>`), kept with the thread.

- **Layer 0, no agency:** database Asks carry no `tools`; the diagram Ask carries one tool (ADR 0023); `provider/` holds no database handle.
- **Layer 1, the access gate (input):** the level is read from the stored Connection in the Core, never from the request.
- **Layer 2, cleaning (input):** secrets redacted, invisible characters removed, literals masked below level 4, caps applied.
- **Layer 3, framing (retrieval):** each item is a JSON object inside a per-request random boundary, and the system prompt says database text is data.
- **Layer 4, consumption:** token and time limits, one Ask per place, an answer over 64 KB is stopped.
- **Layer 5, output:** SQL blocks are split and labelled, flagged for risky or non-built-in functions and for writes in an Explain answer.
- **Layer 6, execution:** AI SQL runs only through Insert or Open in new tab and then the normal Run path; the register below adds a Production confirmation.
- **Layer 7, audit:** the Sent record, and logs with reason codes and counts only.

**The title call goes through the same rails.** After the first answer one short call writes the chat's title. It sends one instruction and the first question (300 characters) with the first 1,000 characters of the first answer, each cleaned like a history replay. No schema, rows or tools, thinking off, 24 tokens. It goes to the same provider and model as the Ask, through the execution rail. The gate is per message: it is held when the first question or answer fails the history gate at its own Connection's current access, when the Ask's Connection or any `also` Connection is Never or deleted, when that first turn sent sample rows or literal values, or when the setting `name_chats` (global, on by default) or the Sends row is off. A Home chat with conversation kinds only is named. The call has its own place id (`title:<place>`), so it never holds the place for the next Ask, and the panel cancels it on a place change. A failed call keeps the rule title and is tried once more after the next answer, then never; a title the user typed or the AI wrote is never replaced. The reply is redacted, cut to 6 words and 60 characters, and written with no dashes. Sends shows it as its own row (`Chat title, about <n> tokens`), and the answer's Sent record and log keep it.

**A missing access level reads Schema.** A Connection saved without `aiAccess` reads Schema (`AiAccess::default`), so older Connections keep the level they were saved under; this replaces an earlier rule that a missing level sends only the question. An unknown or deleted Connection still sends only the question.

**On Production, a flagged read is a write.** The AI SQL register keeps statement hashes. On a Production Connection a read in the register that the output rail flagged is treated as a write by the run checks, so the confirmation opens. The register is app-wide, not per Connection. Flagged entries are kept apart from plain ones (1,024 flagged, 256 plain), so plain statements cannot push a flagged one out, and a flag is merged with OR: a statement once flagged stays flagged. This only adds confirmations.

**The privacy switches are global.** Keeping the exact text sent and the other AI privacy settings are one setting for the app, not per Connection or Group; consent per Connection stays the AI access level (ADR 0010).

**The injection note never blocks.** When a sent item matches the short pattern list, the answer shows a note above it and names the item; nothing is stopped, because a pattern list cannot tell a real attack from a table named "system".

**The diagram tool** passes through the execution rail like every call: see ADR 0023.

**Board Asks put the whole board through the rails (ADR 0019, "The Assistant on boards").** `board_items` adds the header, one Diagram item per frame sent, the sketch notes and the selection to the Ask's items before `run_rails`, so the input rail cleans each and the retrieval rail frames each; nothing on a board skips them. The budget is `board_budget`, so a board too big for the window fails `TooBig` as before, and frames are dropped whole, never cut. The checker for a board's ops is `check_board`, in the execution rail like every tool call.

- **The follow-up field.** `ProposeInput.follow_up { question }` (at most 300 characters) is cleaned like the other fields. A call that asks shows no proposal: its ops are dropped and logged `tool.drop reason=asked_first`. The user's reply goes back as part of the next turn's text and through the input rail; only the reply is saved.
- **The attachment item.** File on the start screen calls `ai_pick_attachment`: the Core opens the dialog itself, so no path comes from the webview or the model. `read_attachment` refuses a path outside what `check_user_path` allows, an extension off the allow list (`.md .txt .flow .mmd .sql .dbml .json .yaml .yml`), any path segment starting with `.`, and a file over `ATTACH_MAX_BYTES` (64 KB). The text waits in a one-slot hold under a token; the next Ask adds it as an `ItemKind::Attachment` item, cleaned and framed like any item, and takes at most a third of the board budget, cut at a line end with a note saying so.
- **History on diagram Asks.** The last 4 turns of the board's chat go as one `ItemKind::History` item through the same rails, only when the thread's place is `diagram:<file>`, within 2,000 tokens; no earlier board text is replayed. Preview and Ask build the same item, so Sends shows what is sent. `move_ai_place` moves a board's chats when the board is renamed, so history never crosses to another file.
- **A frame drawn from a Connection** is held by that Connection's AI access before any rail runs (`held_sources`, ADR 0023): Never, deleted, or another Group's provider refuses the Ask; it is never cut to get around the gate.

## Considered and rejected

- **NeMo Guardrails.** It is Python; Contura ships no interpreter, and the rules needed are a few exact checks.
- **Classifier models.** A model that judges text adds a download or a call, and its misses are silent; exact rules fail loudly and are testable.
- **Cloud guards.** They would send the text to a third party to protect it. A later opt-in warning may use one; it is not a gate.
