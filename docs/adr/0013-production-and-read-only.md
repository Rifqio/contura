# Production and Read-only Connections are enforced in the Core, backed by the server

A Connection can be marked Production (every write needs a confirmation that shows the exact SQL) or Read-only (no write is sent). The decision is made in the Rust Core, not in the UI, and for Read-only the database server enforces it a second time.

## Why the check is in the Core

Every way of running SQL (the editor, saved queries, later Pending Edits and the Table Designer) goes through `ConnectionService::execute_sql`. A check in the UI would need copying into each of them, and the first path that forgot it would be a hole. `crates/contura-core/src/safety.rs` holds one function, `classify(dialect, sql)`, that returns Read or Write per statement, and `verdict()` turns that plus the Connection's switches into Ok, ReadOnly or NeedsConfirmation for `prepare_run`. `execute_sql` does not call `verdict()`: its `authorize` step classifies the one statement it was given, reads the Connection's saved switches, and refuses a write on Read-only or a write without a matching pass on Production, all before the driver sees the text. Blocked statements never reach Query History.

The classifier has a lexer per Dialect so that text inside comments, strings and quoted identifiers is not mistaken for a keyword, and a keyword hidden there is not missed. It covers MySQL `--` comments (which need whitespace after them), Postgres dollar quotes, and backslash escapes in strings. A backslash is read both ways, so a server running in the other string mode cannot be made to see a write inside what Contura thought was a string. MySQL `/*!` and `/*M!` comments are executable, so they force Write. `SET` statements that undo read-only (`SET transaction_read_only = off`, `SET SESSION TRANSACTION READ WRITE`) are writes. A `SET` whose setting name is quoted (`SET "default_transaction_read_only" = off`, ``SET @@session.`transaction_read_only` = 0``, `U&"..."` escapes) is a Write whatever it names, because quoting can spell any setting, so `SET "search_path" = shop` asks too. On Postgres any `U&"..."` name is a Write wherever it appears, since its escapes can spell `set_config` in a SELECT; a quoted value (`SET search_path = "Shop"`) stays Read. MySQL `"..."` counts as a quoted name there, since `ANSI_QUOTES` makes it one. `set_config` is forced to Write, PRAGMA has its own rules, and anything not recognised is a Write. Comment-only pieces and transaction control (`BEGIN`, `COMMIT`) are not counted as writes.

## The pass design

Asking first and running second must not let the SQL change in between. `prepare_run` returns a `RunVerdict` listing every statement with its read or write label. For Production the UI shows one dialog (including the no-WHERE warning, with Add WHERE) and calls `confirm_run`, which returns a pass. The pass is single-use, bound to the Query Session (the session's next `prepare_run` or `confirm_run` drops any pass it has left, even a partly used one), holds one hash per writing statement's exact text, and expires after 120 seconds. `execute_sql(session, sql, pass)` accepts it only if every writing statement matches. Editing the SQL after confirming therefore asks again, and a pass cannot be replayed or carried to another session. The whole run waits for the dialog: reads that come before a write in a script run only after confirmation.

A Connection that is both Production and Read-only never shows the dialog. Read-only wins and the write is blocked with the Read-only note.

## The server backstop

The Core check could be wrong, so a Read-only Connection is also read-only at the server for the whole Connection, not per statement:

- MySQL: `SET SESSION TRANSACTION READ ONLY` as a pool `setup` command, so it runs again after `COM_RESET_CONNECTION`.
- Postgres: the `-c default_transaction_read_only=on` startup option.
- SQLite: `SQLITE_OPEN_READ_ONLY`.

A refusal from the server maps to `ReadOnlyRefused` only on Read-only Connections. Toggling Read-only saves the Connection, closes its sessions, and the tab reopens with a session in the new mode.

## Accepted limits

- A SELECT that calls a function which writes is classified Read. On a Read-only Connection the server backstop catches it. On a Production Connection it runs without the dialog. The Connection form's help text for the switch says so.
- A Schema Model saved to a `.dbml` file and reopened no longer knows its source Connection, so its DBML counts as sendable to the AI. While it is open from a Connection, the table cards' ask follows that Connection's AI access and fails closed if the Connection was deleted.
- Browse paths (object tree, table data) on a plain Connection lose the server's own text only for a read-only refusal (a hot standby, or a user's own read-only transaction): it becomes a generic error message, so that it is not reported as a Read-only one. Other browse errors keep the server's text.
- The 2 px Production outline around a grid with Pending Edits arrives with Pending Edits in 5b, and the view-only Table Designer with 5c. Both use these same switches and the same verdict and pass check.
