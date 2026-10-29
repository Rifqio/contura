# CodeMirror 6 for the SQL editor, not Monaco

The user wants SQL typing to feel like VS Code: ligatures, multi-cursor, VS Code keybindings, autocomplete as you type. Monaco is VS Code's own editor and would match exactly, but it is several MB of code and costs noticeably more memory per open editor, which strains the ~150 MB budget (ADR 0003) once several query tabs are open. We use CodeMirror 6 with a VS Code keymap, its SQL language package (MySQL, Postgres and SQLite dialects) and Cascadia Code with ligatures. It feels very close to VS Code for a fraction of the memory. If a specific VS Code behaviour turns out to be missing, the fix is to add it to CodeMirror, not to swap in Monaco.

## Amendment (2026-10-16): VS Code keys, DataGrip intelligence

The user asked for typing to feel like DataGrip (smart completion, inspections with quick-fixes, live templates and refactors) while keeping the VS Code keys. CodeMirror stays. The intelligence is a language engine in a UI Web Worker (`src/lang/`):

- **SQL (step 4):** the Lezer grammars from `@codemirror/lang-sql`, with our own scope resolver for aliases, CTEs and subqueries.
- **DBML (step 3):** `@dbml/parse`.

It is fed by the Core's `schema_snapshot`. Two other approaches were rejected:

- **A Rust parser in the Core:** Rust SQL parsers stop at the first error, which is useless while a statement is half typed.
- **An external language server:** it means a separate process per Dialect, with uneven quality, and nothing for SQLite or DBML.
