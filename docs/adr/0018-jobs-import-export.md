# Import and Export run as Jobs in the Core, and a writing Job has its own pass

Step 7 adds Export (a table, a filter, a selected row or a query result to CSV, JSON, Excel or SQL), Import (a CSV, JSON or Excel file into a table that exists), SQL file import (a script into a database that exists) and Flow from Mermaid. Each long run is a Job: it streams, shows progress, can be cancelled and can move to the background. This ADR extends ADR 0013 (Production and Read-only) and notes ADR 0003 (memory budget).

## The Job service

- **`JobService` is a field of `ConnectionService`** (D3), so closing a Connection cancels its jobs and quitting the app cancels them all (Q22). The service code lives in `connections/export.rs`, `import.rs` and `script.rs`, so it reaches the private passes (D4). The Tauri commands are in `src-tauri/src/job_commands.rs`.
- **Limits.** At most four jobs run at once: "Four jobs are running. Wait for one to end." Only one writing job may run per Connection, refused with `Error::JobBusy` (D13). The client makes the `JobId`, so no early event is lost (Q2, Q21).
- **Events.** A job sends `Progress` at most every 100ms, plus `Warning`, `RowSkipped`, and finally either `Finished { report }` or `Failed { error }`. `attach` replays the last progress or the final event, so a dialog that reopens from the status bar picks the job up where it is.
- **Cancel.** A cancelled job always ends `Failed { error: Cancelled }`, never `ReadStopped` (D14, Q41). Dropping a `ChannelSource` cancels its server read, so a preview or a failed writer does not keep a snapshot or locks open (Q41). Esc and the close button send a running export to the background. Only Cancel cancels (Q25).
- **No store change** (D20). Jobs are not persisted, history entries use the existing table, and the store schema stays 4.

## The Job pass (extends ADR 0013)

- **`PassScope::Job(ConnectionId, [u8; 32])`** is bound to the job fingerprint: kind, target, mode and options, mapping, INSERT template, file path, size and SHA-256. `authorize_job` is its only consumer and uses it once. `authorize` never accepts it, and `authorize_job` never accepts any other scope (D5). A fingerprint that fails to serialise refuses the pass. There is never a default fingerprint (Q36).
- **Confirm what you show, apply what you confirmed** (Q29). `confirm_import` and `confirm_script` bind the pass to the plan's file identity and the request. At start, `confirmed_file` is checked before `authorize_job`, so a changed file gives `FileChanged`, not a second ask. The entry is forgotten on use.
- **The file is opened once and hashed while it streams.** The start opens the import file with a share mode that refuses other writers (Windows; advisory elsewhere), and the run reads only that handle up to the checked size. Size and SHA-256 are checked before the final COMMIT. In one transaction a changed file is never committed: "{file} changed after you confirmed. Nothing was imported." on Production, "{file} changed while Contura read it. Nothing was imported." elsewhere. When batches were already committed (Commit every N, a table that cannot roll back, DDL in a script), the job says what stayed: "{file} changed while it was imported. {n} rows were written before the stop and stay in {table}." (Q44, Q45).
- **One dialog per job.** On Production, the dialog shows the target, the file, every plan warning and the INSERT shape. It says "in one transaction" only when the Core's one-transaction flag is true (Q28). The flag is false for MyISAM, for Commit every N, and for a MySQL script with DDL or a statement that cannot run in a transaction.
- **No exact-SQL dialog for plain Connections** (spec open question 2). An import into a Connection that is neither Production nor Read-only runs after its own Run button.
- **Read-only refuses a job whole**, before any writer opens. The server backstop of ADR 0013 still applies.
- **Honest counts** (Q27, Q36). Every import end that wrote rows says so: "{n} rows were written before the stop and stay in {table}." Failed and Cancelled carry `rows_committed`. If COMMIT succeeds and a later `after` statement fails, the result is `Error::AfterCommit`, and that batch counts as committed.

## Importing a file into a table

- **Plan, check, run.**
  - `plan_import` reads the start of the file. It returns the mapped columns, a preview in table order, a sample INSERT, the statement shape, the warnings and the verdict.
  - The optional check pass reads the whole file and reports the first 20 failing cells without writing anything.
  - `start_import` writes.
  - Read-only is refused before any of the three opens a session or a writer.
- **Mapping.**
  - Columns are mapped by index. An empty mapping means Match by name, one rule shared with the UI through `match_cases.json` (D19).
  - Blank and duplicate headers read "Column 1" and "name (2)".
  - A mapping that names an unknown or generated column, maps a column twice, or points at a file column that does not exist is refused.
  - A file with no rows, or with no mapped column, is blocked.
- **Values.**
  - A JSON key missing from an object is NULL. A key first seen after object 1,000 gets a warning (D9).
  - Text starting `0x` going into a binary column is decoded as hex. Anything else goes in as text, with a warning naming the row.
  - `SRID=n;<wkt>` reads back into a geometry column.
  - "Read the text NULL as NULL" applies to unquoted CSV fields only. A quoted `"NULL"` stays text, so Contura reads back what it wrote (Q42).
- **Statements and commits.**
  - Rows go in as multi-row INSERTs, cut at the server's statement limit.
  - An import runs in one transaction by default. Commit every N commits every N rows, and below 500 the statements are cut at N rows.
  - A table that cannot roll back is written one row per statement. That covers MyISAM and any engine Contura cannot read. The count of rows kept after a failure is then exact.
  - After the run, identity and serial sequences move past the largest imported value, using `GREATEST` with the sequence's minimum.
- **Skip and Stop.**
  - Under Stop, the first bad row fails the job, naming its row and column.
  - Under Skip, bad rows are reported, up to 1,000. Past that the job stops and says what stayed.

## Importing a SQL file

- **One streamed planning pass.**
  - `plan_script` classifies every statement. It lists the first 50, the skipped and the refused (each capped at 1,000), and up to 200 confirm items.
  - Each listed statement keeps at most 4 KB of its text, and each list or page holds at most 4 MB.
  - On Production, an Exact confirm item keeps up to 64 KB, within 8 MB in total. A longer statement is shown cut, with its size and a note that the whole statement is bound to the file's hash.
  - Statements that change the session are always listed, up to 1,000.
  - Cost: a statement over 64 KB is not shown whole in the dialog.
- **One file handle.**
  - `start_script` opens the file once. On Windows its share mode refuses other writers; elsewhere the lock is advisory.
  - It scans the file for refused statements, with progress and cancel.
  - The run reads from the same handle, up to the byte count the scan checked.
  - A file another program is writing is refused.
  - The size and SHA-256 are checked again before the final COMMIT.
- **Transactions.**
  - A file with its own transaction control runs as written. Otherwise the script runs in one transaction.
  - Some statements cannot run inside a transaction: MySQL DDL and MySQL's other implicit commits, VACUUM in PostgreSQL or SQLite, and CREATE INDEX CONCURRENTLY. Before one of these, Contura commits what is open, runs the statement alone, and starts a new transaction after it. A file with such a statement is not shown as one transaction in the dialog (Q28).
  - The counts follow MySQL autocommit, and any control statement Contura cannot read counts as opening a transaction.
  - A file that ends with a transaction open is rolled back, with "The file left a transaction open. Its {n} rows were rolled back."
- **Each statement runs alone.**
  - Statements run on the writer's own connection, outside the browsing pool, so a script's `USE`, `SET ROLE` or `search_path` cannot leak into other tabs.
  - PostgreSQL runs on the extended protocol.
  - MySQL prepares each statement and falls back to the text protocol only when the server answers 1295 (the statement cannot be prepared). The server returns 1295 only after parsing exactly one statement. So routine, trigger and event bodies run, and a hidden second statement is refused (Q42).
- **Refused and skipped.**
  - PostgreSQL `COPY ... FROM STDIN` is refused, with a message naming `pg_dump --inserts`.
  - pg_dump's `\restrict` and `\unrestrict` lines are skipped, like other psql meta lines.
  - Run as is (Q12) runs statements the skip list would skip.

## Export never runs a write

The 5a classifier decides. `preview_export` describes a statement that is not a read without running it, and `start_export` refuses to re-run one (Q26). The UI treats a statement as not a read until a preview says otherwise, so it offers only "Rows shown" until then (D16).

## Files and paths

- **`check_user_path`** refuses the data folder for exports, imports, backups and opened files, with a plain message for each. It compares the file identity of every ancestor (volume serial and file index on Windows), so a UNC or `..` spelling cannot slip past. It refuses relative paths, and it fails closed when the data folder cannot be resolved (Q24, Q33).
- **`PartialFile::create(target, overwrite, PathUse, data_dir)`** runs the guard itself, so no write path can skip it. It writes `<name>.partial` and renames over the target only after a clean finish. An existing target needs Replace (`FileExists`). A failed rename keeps the old file and names the path. A stale `.partial` from a crash is removed unless a live partial in this process holds the same file (Q24, Q33).
- **A read that stops never commits.** A closed channel without the producer's end mark fails the job with "The read stopped unexpectedly. Nothing more was written." (Q32).
- **`.flow` files** live in `<data>\diagrams` (Q35). `PathUse::Flow` allows only that folder. The Core builds the path from the name, and a re-save moves the old pair aside and restores it on any failure (Q33).

## Memory: the shared pieces and their rule (notes ADR 0003)

- **Every stage holds one chunk**, and stages are joined by a channel of 2. Chunks are cut at 1,000 rows or 8 MB, whichever comes first.
- **Reads adapt.** A PostgreSQL fetch starts at 64 rows, grows under 4 MB a batch, and halves when a batch passes 8 MB. MySQL and SQLite stream rows (Q32).
- **Readers cap what they hold.** A CSV, JSON or Excel row, and any single value, is capped at 16 MB, and the import channel holds at most 2 chunks and 32 MB in flight (Q45). A SQL script statement is capped at 16 MB (`jobs/limits.rs`, Q38), and a statement that may read is capped at 500,000 tokens before it is classified (Q40). The SQL writer cuts statements at 1 MiB.
- **ADR 0003 note.** Exports and imports stream. The one exception is Excel import, capped at 500,000 rows or 100 MB. Before calamine opens a workbook, the zip directory sizes are checked: shared strings and each sheet up to 256 MB, 1 GB in all (D17, Q34).

## Values keep their meaning

- **Export never coerces a value** (Q34). A value outside its column's usual form is written as it is.
- **Non-finite numbers** (NaN, Infinity, in every Dialect spelling) are never bare numbers. They are text in CSV, JSON and Excel. In SQL they are the PostgreSQL literal, or NULL with a warning on MySQL and SQLite (Q32b).
- **MySQL geometry** is `ST_GeomFromText('<wkt>', <srid>)` in SQL, and `SRID=n;<wkt>` in CSV and JSON when the SRID is not 0.
- **Text that Excel would read as a formula or a number** stays a text cell.
- **CSV keeps NULL and empty text apart.** An empty text value is written `""`. On read, an empty unquoted field is NULL (D11). "Read the text NULL as NULL" is an import option (Q31). It is off unless the user ticks it: Contura's exports write no marker that could turn it on.

## The script reader

- **A resumable splitter** in `jobs/script/` applies the 5a lexer rules to a streamed file (D2). On top of those rules it handles `DELIMITER` lines and trigger bodies. `safety.rs` now lexes over bytes with words as slices, and its verdicts are unchanged: the 5a CASES table and a frozen-lexer differential test pin them (Q39, Q40).
- **The skip and refuse lists see every statement in a piece**, under both backslash readings. A nested `/*! */` or a routine named `begin` cannot hide a `DROP DATABASE` (Q37, Q39).
- **Always refused:**
  - PostgreSQL `COPY` with a server file or `PROGRAM`, and `ALTER SYSTEM`;
  - SQLite `VACUUM INTO` and `load_extension()`.
- **`DO` bodies stay opaque.** `DO` counts as a write, so Read-only refuses it and Production asks.
- **Each statement runs by its own single-statement call**, never PostgreSQL `simple_query` or a multi-statement MySQL `COM_QUERY`.

## Rulings from the plan (D1 to D26), with their costs

- **D1, a partial A2.** Mermaid writes `.flow` with the smallest flow model and writer. A2 must keep reading the layout file and the quoting rule in `flowModel.ts` (`RESERVED`). Cost: the flow tab comes with A2 (step 6+).
- **D2, a second splitter**, pinned to the 5a lexer by tests. Cost: two lexers to keep in step.
- **D7, Selected rows is one row**, because the grid selects one cell. Cost: multi-row selection is a step 12 item.
- **D8, no filter count.** The Core does not count rows for the dialog, so "Rows in the current filter" shows no count.
- **D10, base64 export is one way.** Hex (`0x...`) round-trips into binary columns.
- **D17, calamine was not measured.** The 200 MB peak-memory measurement is in the deferred checklist.
- The remaining rulings (D3 to D6, D9, D11 to D16, D18 to D26) are in the plan, `docs/superpowers/plans/2026-10-18-step7-import-export.md`. The build rulings (Q1 to Q45) were kept in the build ledger during development. The ones that shape behaviour are written into this ADR.

## Accepted limits

- A cancel that lands during the final rename is not caught. The rename finishes.
- The zip size check trusts the zip directory's header.
- An export of "Rows shown" carries the grid's text, including its 1 KB previews, with the warning "12 values were cut to 1 KB previews."
- An Excel file is hashed when it opens. A change made while the workbook is read is caught only by that hash, not during the read.
- A cancel that lands while COMMIT is in flight reports what the server confirmed. If the connection drops during COMMIT, the kept count says the rows may have been committed.
- On MySQL each import plan opens one extra read connection to read `max_allowed_packet`.
- Off Windows the script file lock is advisory. The size and hash checks still catch a change.
- Memory numbers for 1,000,000-row jobs are measured in the end-of-roadmap pass and recorded here.
