# Data Transfer plans once, maps types per column, and runs per target Dialect

Step 8 adds Data Transfer: copy the structure, the rows, or both, for chosen tables from one database to another, on the same Connection or another one, in the same Dialect or across Dialects. Every column's target type is shown and can be changed, and the exact structure SQL and row-copy shapes are confirmed before anything runs. This ADR builds on ADR 0018 (Jobs and the Job pass), ADR 0013 (Production and Read-only) and ADR 0003 (memory budget).

## One plan, built from the request

- **`plan_transfer(req, source_model, target_state)` is pure** (`transfer/plan.rs`). Review SQL, the Production pass and the run all build it again from the same `TransferRequest`, so the pass covers exactly the SQL the user saw (spec decision 10).
- **The plan holds:**
  - `structure`: scope creation, `CREATE TYPE`, `CREATE TABLE`, and `DELETE FROM` for Empty it first;
  - `after_rows`: indexes, Foreign Keys, `setval`, SQLite `PRAGMA foreign_key_check`;
  - `copies`: one `RowCopy` per table in load order, with the columns, the SELECT, the INSERT head and the target types;
  - the mapping notes, the plan notes, the not-copied list, the tables Empty it first deletes from, the mode and its line, `blocked` (columns that still need a choice), and on MySQL the Foreign Key groups and their orphan checks.
- **The structure SQL comes from the `ddl` writer, split into parts.** `ddl::parts(model, &DdlOptions) -> DdlParts { schema, types, tables, tables_without_fks, deferred_fks, indexes, foreign_keys, notes }`. The Schema Builder export is `schema + types + tables + deferred_fks + indexes`, byte-identical to before, proven by snapshot tests. From a transfer, `sqlite_autoincrement_as_note` turns the SQLite auto-increment error into the note "AUTOINCREMENT is left out; values are copied as they are"; the Schema Builder export keeps the error.
- **Load order.** Parents first (`table_order`, cycles kept in model order), then the user's drag order. A child dragged before its parent gets "orders loads before customers, which it needs". A ticked table whose parent is not ticked gets "Needs stores, which is not ticked", and that Foreign Key is left out rather than failing.
- **Refusals before any write.**
  - The same side: "Source and target are the same. Pick another target."
  - Stop on a table that exists: "products already exists on pinecone-analytics. Choose Append or Empty it first, or untick it."
  - Append into a table with no column for a mapped one: "pos.sales on the target has no column channel. Map it or untick it."
  - Append when a target column is not copied, is NOT NULL, has no default and is not generated: it is refused with its name.
  - Rows only into a table that is not on the target is refused.
- **Empty it first is always `DELETE FROM`, never `TRUNCATE`** (answer 2a), so a failure puts the rows back where the target can roll back.

## Type mapping is reviewed per column

- **A small type parser** (`transfer/types.rs`, `parse_type`) reads a type's base name, parameters, `unsigned`, the array suffix and `with time zone`. Step 10's normalisers reuse it.
- **`map_model(model, target, opts)` is pure and table-driven** over the spec's mapping table. It returns the mapped Schema Model and one `MappingNote` per column the user should look at. A note has a kind: Info, New, NeedsChoice (with its options), NoMatch or Lossy.
- **Nothing is mapped silently.**
  - A column with no match goes to text with an example value: "No PostgreSQL match. Copied as text, for example POINT(-1.54 53.80)."
  - A column that needs a choice blocks the plan until it is chosen: MySQL `tinyint(1)` (boolean or smallint) and `uuid` to MySQL (char(36) by default, or binary(16)).
  - A lossy mapping says what it keeps: "Precision 70 is above MySQL's 65. numeric(70,10) becomes text, so digits are kept."
  - Identifiers over 63 bytes (PostgreSQL) or 64 characters (MySQL) need a new name, because the server would cut them.
  - A MySQL inline enum becomes one PostgreSQL type per column, `<table>_<column>` (answer 3a), noted as New.
- **Defaults.** Literals are carried. `CURRENT_TIMESTAMP` and `now()` map to each other. Other expressions are dropped with a note such as "Default nextval(...) is not copied".
- **Overrides.** A type typed on Type mapping replaces the mapped type and the column's notes are worked out again. A type that is not one SQL expression is refused with the 5c rule: "The type of total is not one SQL expression." Contura does not check that the server knows the type; the server says so on Run.
- **Values.** `coerce(source, kind, target, target_type)` picks one `Conversion` per column, once, and applies it to every value (`transfer/coerce.rs`). A value the target cannot take fails its row:
  - MySQL 0 and 1 to PostgreSQL FALSE and TRUE, any other number fails; PostgreSQL booleans to 1 and 0.
  - Bytes into a column that is not binary are written as hex.
  - PostgreSQL `infinity` dates fail on MySQL and stay as text on SQLite.
  - NaN and Infinity fail on MySQL and on PostgreSQL numeric with a scale; they are kept on PostgreSQL double precision and SQLite REAL.
  - A NUL in text fails on PostgreSQL.
  - timestamptz to MySQL is converted to UTC and the offset is dropped.
  - MySQL spatial values are read as WKT text; BIT is read as a number.

## Zero dates become NULL (answer 6b)

MySQL zero dates (`0000-00-00`, `0000-00-00 00:00:00`) always become NULL. There is no per-column switch. Every MySQL date and datetime column gets the Info note "Zero dates (0000-00-00) are copied as NULL." This overrides the spec's Value coercions line that mentions a switch.

## Each target Dialect runs its own way

The plan's `mode` and `mode_line` say which; Review SQL and the target hint show the line.

### PostgreSQL: one transaction

- "PostgreSQL target: everything runs in one transaction. Cancel rolls it all back."
- Order: `CREATE SCHEMA` (when asked), `CREATE TYPE`, `CREATE TABLE` without Foreign Keys, `DELETE FROM`, rows, indexes, Foreign Keys (validated against the copied rows), `setval(pg_get_serial_sequence(..), coalesce(max(col), 1), max(col) IS NOT NULL)` for each identity column Contura created, then COMMIT.
- Identity columns Contura creates are `GENERATED BY DEFAULT`, so copied ids insert as they are. Append into an existing `ALWAYS` identity adds `OVERRIDING SYSTEM VALUE` to the INSERT head.
- Any failure or Cancel rolls everything back: "The transaction rolled back, so pinecone-analytics is as it was."

### SQLite: one transaction, pragma restored

- "SQLite target: everything runs in one transaction. Cancel rolls it all back. SQLite keeps any value in any column. Types here set affinity only."
- `PRAGMA foreign_keys = OFF;` is the first shown structure line and runs before BEGIN, because it does nothing inside a transaction. The runner reads the connection's value first and puts it back after COMMIT or rollback.
- Foreign Keys are created with the tables, because SQLite cannot add them later. After the rows and indexes, `PRAGMA foreign_key_check;` runs, and any returned row rolls the whole transfer back, naming the table.

### MySQL: per table, not atomic

- "MySQL creates tables one by one and they stay if a later step fails. Each table's rows are copied in its own transaction." DDL commits by itself, so the structure cannot be rolled back.
- The writer session adds `STRICT_ALL_TABLES` (a value that does not fit fails instead of being cut) and `NO_AUTO_VALUE_ON_ZERO` (a copied id of 0 stays 0) to `sql_mode`. Never `INSERT IGNORE`. `unique_checks` stays on.
- Order: the whole structure first (`CREATE DATABASE` when asked, `CREATE TABLE` with Foreign Keys, then the forward keys as `ALTER TABLE ... ADD`). Then each table's rows in their own InnoDB transaction, with Empty it first's `DELETE FROM` inside that transaction. Then the indexes.
- **Foreign Keys (answer 1a, R11).** Tables load parents first with `foreign_key_checks` on. When a key's child loads before its parent (a cycle, a self reference or a dragged child), the planner joins those tables into one Foreign Key group. A group loads in one transaction with `SET foreign_key_checks = 0` on the writer's held connection. Before COMMIT, one `LEFT JOIN` orphan check runs per key inside the group. An orphan rolls the group back: "orders.customer_id has 3 values with no row in customers, for example 9912. The table's rows were rolled back." `foreign_key_checks = 1` is set again right after the group, on success and on failure, before anything else runs on that connection.
- **Failure and Cancel.** The open table's (or group's) rows roll back. What already committed stays and is listed: "3 tables were created and 2 were copied before the failure. They stay on kestrel-target." A cancel sends the same list as a Job warning, ending "before you cancelled".
- AUTO_INCREMENT continues past the copied ids by itself.

## The runner

- **`run_transfer(plan, sides, batch_rows, compare_counts, observer)`** (`transfer/run.rs`) reuses step 7's `RowSource`, `BulkWriter` and `InsertBuilder`. Rows go chunk by chunk from the reader to multi-row INSERTs cut at the batch size or the server's statement limit. A table is never collected.
- **Each table is read in its own snapshot (R8)**, not one snapshot across all tables. The Foreign Key checks after loading (PostgreSQL validation, SQLite `foreign_key_check`, MySQL orphan checks) catch a source that changed between two tables' reads. The fingerprint cannot cover the rows themselves: they are the rows in the source when each table's read starts.
- **Counts (answer 4a, R9).** With Compare row counts on, the runner counts each ticked table on the source before copying, for the progress totals. Around each table it counts the target on the writer's own connection with `first_value`, so the count sees the rows its open transaction wrote. A mismatch between rows read and rows that landed stops the run: "products: 2,316 rows read, 2,315 written. The transaction rolled back." (on MySQL: "... The rows written stay.").
- **Naming the failing row (R11).** Each multi-row INSERT runs in a savepoint. When the server refuses one, the batch is rolled back to the savepoint and its rows are replayed one by one, each in its own savepoint, until the server refuses one. The error names the source row by its position in the read and, when the table has a primary key, by its key: "sales_lines, row 2,114,903, id 88123: the value NaN is not valid for numeric(10,2) in unit_price." A value that fails its conversion is named the same way before it is sent.
- **Progress** goes to the Job, which sends at most every 100ms. Cancel is checked between statements and between chunks.

## Service, pass and History

- **`ConnectionService` commands** (`connections/transfer.rs`, Tauri in `job_commands.rs`): `plan_transfer`, `transfer_sample` (reads 4 rows and returns the first INSERT exactly), `confirm_transfer` and `start_transfer`.
- **The target is checked; the source is only read.**
  - A Read-only target is refused with `ReadOnly(0)` before any connection opens.
  - Reading a Production source needs no pass.
  - A Production target needs a Job pass (ADR 0018) bound to the plan's fingerprint. Without one, `start_transfer` gives `NeedsConfirmation`.
  - One write job per target Connection, as for Import.
- **The fingerprint** is the step 7 Job fingerprint over the target, the source side, the copy kind, the batch size, Compare row counts, scope creation, each ticked table's If it exists, the structure and after-rows SQL, every row copy, the blocked list, the Foreign Key groups and the orphan checks. Any change after confirming (a type, a tick, the order, an option, or a table appearing on the target) changes it, and an older pass is refused.
- **The target changed since you reviewed (R12).** `start_transfer` takes the fingerprint Review SQL showed. It builds the plan again; when the fingerprint differs, it refuses with "The target changed since you reviewed. Check the SQL again." When building the plan now fails at all, it gives the same refusal, because the reviewed plan came from this same request, so only a side can have changed.
- **History.** One Query History entry on the target Connection, `changed: true`: a summary line, the structure SQL, each row copy's INSERT shape, the rows copied and the after-rows SQL. None on the source.

## Memory (notes ADR 0003)

A table is never held. Reading and writing follow step 7's chunk rule (the batch or 8 MB, whichever comes first), and the runner keeps counters only. Both snapshots are schemas only. The step 7 budget applies: a running job adds at most 64 MB over idle. The 1,000,000-row measurement runs at the end-of-roadmap pass.

## The UI (frame 8.1)

`src/transfer/` builds the approved design:

- A window tab with no object tree, because it spans two Connections and may span two Groups. It opens from "Transfer data..." on a database row (MySQL, SQLite), a schema row (PostgreSQL) or a table row, which ticks only that table. Five steps: Source and target, Tables, Type mapping, Review SQL, Run. Nothing runs until the SQL is confirmed on Review SQL. The title reads "pos_live to analytics" with `*` until a run finishes; closing it while a run goes on asks "Cancel the transfer and roll back?"
- Pickers show a Read-only Connection disabled with "Read-only: cannot be a target", and a Production one with "Asks you to confirm the exact SQL before it runs".
- Tables load parents first; rows can be dragged or moved with Alt+Up and Alt+Down. If it exists is set per table or for all.
- Type mapping shows every column's source and target type with its note; a column that needs a choice blocks Next. A pick from the offered options is a choice; a type typed by hand is an override, which the Core refuses when it is not one SQL expression. A name too long for the target gets a Target name field.
- Review SQL shows the structure SQL, the row-copy shapes with Show sample, the Not copied list, the mode line, and a danger banner when Empty it first deletes rows. "Run on PROD..." opens the 5a dialog with the transfer body on a Production target.
- Run shows overall and per-table progress, and the status bar reads "Transfer running, 38 percent". The job's progress counts every table in `rowsDone` and `rowsTotal`, and adds the current table's own `tableRows` and `tableTotal`. A failure keeps Back to Type mapping and Run again; success offers Open in the target tree.
- The Tables step shows each table's size from `list_objects`, which now carries the server's size estimate (`bytes`: MySQL data and index length, PostgreSQL `pg_total_relation_size`, none on SQLite).

## Accepted limits

- MySQL targets are not atomic: tables created and tables copied before a failure or a cancel stay, and the run lists them.
- Each table has its own snapshot (R8), so rows that change in the source between two tables' reads can differ from a single point in time. The Foreign Key checks catch broken keys, not other drift.
- The source count is a separate read from the copy, so a row added between the two shows only in the progress total. The count check compares rows read with rows written.
- The Not copied list is the source scope's `skipped` list from `schema_snapshot`: views, routines, triggers, check constraints and generated columns on every Dialect, plus domains and expression indexes on PostgreSQL. The list covers the whole source scope, not only the ticked tables. MySQL names a trigger without its table, so Type mapping's "Also not copied from" line cannot place it; Review SQL lists it.
- There is no command palette yet, so "Transfer data..." is only in the tree menus.
- A SQLite `foreign_key_check` failure names the table, not the key.
- Same-Dialect fast paths (`COPY`, `ATTACH`, `INSERT .. SELECT`), row filters per table and saved transfers are later (answer 5a).
- Live tests copy 20,000 rows per fixture; the spec's 100,000-row runs and the 1,000,000-row memory runs are in the end-of-roadmap pass.

## Rulings from the build

- **R8.** Each table is read in its own snapshot, not one snapshot across tables; the Foreign Key checks after loading catch inconsistency.
- **R9.** Target counts use the writer's `first_value`, inside the writer's open transaction.
- **R11.** MySQL runs per table; tables in a Foreign Key cycle load as a group with `foreign_key_checks` off, then the orphan checks run and the setting is restored. A failing batch is replayed row by row to name the source row.
- **R12.** At Start, if building the plan fails after the user reviewed it, the refusal is `TARGET_CHANGED` ("The target changed since you reviewed. Check the SQL again."), since the reviewed plan came from the same request.
- **R13.** No command palette exists, so the entry is the tree menus only.
- **R14.** The Data Transfer tab is a window tab (like a diagram), not a place tab, since its two ends may sit in two Groups.
- **R15.** Row estimates (Review SQL, the Production dialog, the rows Empty it first deletes) are added after the fingerprint is taken, so a moving server estimate never voids a confirmed pass.
- **R16.** Transfer index names are unique per schema on PostgreSQL and SQLite and fit the target's name limit, shortened with a stable hash; the Schema Builder export keeps its names (`DdlOptions::unique_index_names`).
- **R17.** On MySQL, a parent and child both set to Empty it first load as one group with checks off, emptied child first, and every key of a grouped table is checked for orphans, also one whose parent loaded earlier.
- **R18.** A MySQL target in a new database starts with `CREATE DATABASE` and `USE`, shown on Review SQL, and the writer opens without a database.
- **R19.** A PostgreSQL Append moves the counters of the target's generated columns past the copied ids, as a created table does.
- **Answer 6b** overrides the spec's zero-date switch, as above.
